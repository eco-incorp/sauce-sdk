/**
 * VaultLiquidUnstake venue adapter + EcoSwapSVM v2 ladder — LST -> SOL only.
 *
 * Program `2rU1oCHtQ7WJUvy15tKtFvxdYNNSc3id7AzUcjeFSddo` (Jupiter label
 * "VaultLiquidUnstake") ships NO on-chain IDL and is not open source. Its
 * shape was reverse-engineered from three independent, cross-checked
 * sources — none of them guesswork:
 *
 *  1. The deployed program's ELF (dumped via `getAccountInfo` on its
 *     BPFLoaderUpgradeable ProgramData account — see
 *     `scripts/dump-venue-programs.sh` for the vendored-binary convention
 *     this venue now follows). It is a stripped Anchor program whose
 *     `strings` output still carries every instruction/account-struct name
 *     (Anchor logs + IDL-instruction stubs are baked in even with symbols
 *     stripped): `InitializePool`, `LiquidUnstakeLst`, `DepositSol`,
 *     `WithdrawSol`, `SyncInventory`, `SellLst`, `BuyLst`, `FlashBorrow`/
 *     `FlashRepay`, and the account kinds `Pool`, `LstInfo`,
 *     `StakeAccountInfo`, `InventorySummary`. Anchor account/instruction
 *     discriminators are `sha256("account:<Name>")[0..8]` /
 *     `sha256("global:<snake_case_name>")[0..8]` — every discriminator
 *     below was independently re-derived from candidate names and matched
 *     byte-for-byte against live `getProgramAccounts`/`getTransaction`
 *     output, so the byte layout is NAMED, not inferred from position.
 *  2. Real mainnet transactions: `getSignaturesForAddress` +
 *     `getTransaction` on this program (and on live `LstInfo` PDAs) surface
 *     the EXACT `sell_lst` account list Jupiter itself sends when it routes
 *     through this venue (confirmed across >20 independent fills spanning
 *     3 different LSTs — JitoSOL, a Sanctum single-validator LST, bSOL —
 *     all 13 accounts in the same order). Two of those accounts
 *     (`poolLstAta`, index 1) were confirmed to be the STANDARD Associated
 *     Token Account of (POOL, lstMint) by direct computation
 *     (`@solana-program/token`'s `findAssociatedTokenPda`) matching the
 *     on-chain value bit-for-bit for both sampled mints — no custom PDA
 *     seeds needed anywhere in this adapter.
 *  3. Live account state read via `getAccountInfo`/`getMultipleAccounts`
 *     (mainnet, `SOLANA_RPC_URL`): the `Pool` singleton's byte layout was
 *     segmented into 32-byte pubkey windows (matched against on-chain
 *     entities: the shared native-SOL vault, the fee-recipient token
 *     account also seen in every `sell_lst` account list) plus a numeric
 *     tail. Two numeric fields were confirmed, not guessed: a `u64` at
 *     byte 168 reads an exact, round `500_000_000_000` (500 SOL) — a
 *     designed constant, not sampled state — and a `u64` at byte 179
 *     tracks the vault's real lamports balance to within ~0.001 SOL (a
 *     `getAccountInfo` cross-check against the vault account itself),
 *     i.e. the Pool's own cached SOL-reserve counter. Reading this counter
 *     (rather than the vault's native lamports) is also the only way to
 *     get this value INSIDE a compiled SauceScript fragment: the SVM
 *     account-loader/ladder framework this repo's adapters share
 *     (`AccountLoader`/`BatchAccountLoader`/`accountUint`) is DATA-only —
 *     it has no lamports accessor anywhere in the pinned sauce-sdk surface
 *     — so every venue in this family reads reserves from account *data*,
 *     never from an account's native lamports; this venue's Pool struct
 *     conveniently keeps its own SOL-reserve accounting inside `.data` for
 *     exactly that reason.
 *
 * FEE CURVE — empirically calibrated, not reverse-engineered bit-for-bit:
 * live Jupiter quotes (`GET /swap/v1/quote?dexes=VaultLiquidUnstake`) at 16
 * sizes spanning the Pool's post-trade SOL reserve from 500 SOL down to
 * 0.5 SOL (holding the mint fixed at JitoSOL, cross-multiplying against
 * the LIVE underlying SPL Stake Pool exchange rate — itself a
 * publicly-documented struct, `total_lamports / pool_token_supply`) show a
 * fee that is a FLAT ~12.19 bps until the post-trade reserve drops below
 * the Pool's own 500 SOL target, then rises smoothly toward ~27.1-27.8 bps
 * as the reserve approaches 0 — a single quadratic-in-drawdown curve fits
 * all 16 points to within ~0.03 bps RMS. The shipped constants
 * (`FEE_MIN_BPS`/`FEE_MAX_BPS` below) are set with a deliberate safety
 * margin ABOVE that fitted curve at every one of the 16 sampled points (see
 * `test/svm/vault-liquid-unstake.quote.test.ts`), so this model NEVER
 * predicts a better price than the real program did in any observed
 * sample — a crude-but-conservative model is safe; a favourable one is a
 * liveness hazard (a venue whose modeled price beats its real price wins
 * merge elections it cannot actually fill).
 *
 * SCOPE (self-drop, not a permission gate): `LstInfo` accounts ship in two
 * observed byte lengths — 144 (the default fee/config layout) and 225 (an
 * `UpsertLstInfo`-customized layout carrying extra epoch/rate-override
 * fields AND, in every sampled `sell_lst` transaction for a 225-byte LST,
 * one extra fixed trailing account this adapter has not independently
 * confirmed the semantics of). `fetchPoolConfig` accepts ONLY the 144-byte
 * layout and throws (self-drops, like every other family's shape gate —
 * see orca-whirlpool's `windowFor.readable === 0` or obric-v2's P-B/P-C
 * oracle rejection) on anything else; extending to 225-byte LSTs is a
 * disclosed follow-up, not a silent omission.
 *
 * ONE DIRECTION ONLY (LST -> SOL, wrapped): `applyDirection` rejects every
 * value but the default. Nothing here derives or emits the SOL -> LST
 * leg (`buy_lst`, a structurally different 17-account instruction observed
 * in the same signature sample) — see the module doc above for why.
 */
import { address, getAddressCodec } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
const SLUG = 'vault-liquid-unstake';
const PROGRAM_ID = '2rU1oCHtQ7WJUvy15tKtFvxdYNNSc3id7AzUcjeFSddo';
// Fixed, program-wide singletons (there is exactly one production Pool and
// one shared native-SOL vault — every LstInfo references the same two).
const POOL_ADDRESS = '9nyw5jxhzuSs88HxKJyDCsWBZMhxj2uNXsFcyHF5KBAb';
const SOL_VAULT_ADDRESS = '6RLKARrt6oPCyuMCdYdUHmJxd4wUa6ZeyiC8VSMcYxRv';
const FEE_ACCOUNT_ADDRESS = 'F3yy3FVpwq9MV321AzALFcDWZp9XBBHbMas3t4AtEtCW';
const INVENTORY_SUMMARY_ADDRESS = '8baArWS1aoaBMK8sAPrWcsoXHxnNTAVTcrUWxnRPg2Jk';
const WSOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';
// sha256("account:Pool")[0..8] / sha256("account:LstInfo")[0..8] — both
// independently re-derived from the candidate name and matched against the
// live getProgramAccounts dump (see module doc, source 1).
const POOL_DISCRIMINATOR = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];
const LST_INFO_DISCRIMINATOR = [0x4f, 0x71, 0xe2, 0x3c, 0xab, 0x08, 0x8e, 0x21];
// sha256("global:sell_lst")[0..8].
const SELL_LST_DISCRIMINATOR = [0x64, 0x03, 0x4f, 0xd1, 0xbf, 0x9d, 0xb4, 0x0b];
/** Pool account: fixed 316 bytes for the production singleton. */
const POOL_LEN = 316;
/** Byte 168: `target_liquidity` u64 LE — confirmed exact 500 SOL, a designed constant. */
const POOL_OFF_TARGET = 168;
/** Byte 179: the Pool's own cached SOL-reserve counter, u64 LE (tracks the vault's real
 *  lamports to within ~0.001 SOL — see module doc source 3). */
const POOL_OFF_RESERVE = 179;
/** LstInfo: only the 144-byte default-config layout is supported (see module doc SCOPE). */
const LST_INFO_LEN = 144;
const LST_INFO_OFF_MINT = 40;
const LST_INFO_OFF_STAKE_POOL = 72;
/** SPL Stake Pool (canonical, documented struct — not reverse-engineered): account_type
 *  byte @0 must be 1 (StakePool); total_lamports/pool_token_supply u64 LE @258/@266. The
 *  fixed 611-byte size is what every sampled stake-pool instance (3 distinct managing
 *  programs) actually has; a differently-sized stake pool self-drops rather than risk a
 *  misaligned read. */
const STAKE_POOL_LEN = 611;
const STAKE_POOL_OFF_ACCOUNT_TYPE = 0;
const STAKE_POOL_OFF_TOTAL_LAMPORTS = 258;
const STAKE_POOL_OFF_POOL_TOKEN_SUPPLY = 266;
/**
 * Conservative fee-curve constants (bps). Flat FEE_MIN_BPS while the Pool's
 * cached SOL reserve stays at/above its own 500 SOL target; rises
 * quadratically in the reserve's shortfall below target, saturating at
 * FEE_MAX_BPS as the reserve approaches 0. Both bounds carry a deliberate
 * margin ABOVE the empirically fitted curve (see module doc + the quote
 * test) — this UNDER-predicts output at every sampled size, never over.
 */
const FEE_MIN_BPS = 13n;
const FEE_MAX_BPS = 29n;
function discMatches(data, disc) {
    for (let i = 0; i < disc.length; i++) {
        if (data[i] !== disc[i])
            return false;
    }
    return true;
}
/** Little-endian unsigned field read (mirrors the compiler's accountUint(ref, offset, width)). */
function readUintLE(data, offset, width) {
    if (offset + width > data.length) {
        throw new Error(`${SLUG}: readUintLE reads [${offset}, ${offset + width}) beyond ${data.length}-byte data`);
    }
    let value = 0n;
    for (let i = width - 1; i >= 0; i--) {
        value = (value << 8n) | BigInt(data[offset + i]);
    }
    return value;
}
const addressCodec = getAddressCodec();
function decodeAddress(data, offset) {
    return addressCodec.decode(data.subarray(offset, offset + 32));
}
function vluConfig(base) {
    if (base.venue !== SLUG)
        throw new Error(`${SLUG} adapter got a '${base.venue}' pool config`);
    return base;
}
/**
 * The pure quote math, LOCKSTEP with the emitted SauceScript helper below
 * (`qVaultLiquidUnstake`) — same integer ops, same rounding (ceil the fee,
 * so the on-chain and off-chain outputs match to the wei and both stay on
 * the conservative side of the real program).
 */
export function vaultLiquidUnstakeQuote(x, rateNum, rateDen, before, target) {
    if (x <= 0n || rateDen <= 0n || before <= 0n)
        return 0n;
    let gross = (x * rateNum) / rateDen;
    if (gross > before)
        gross = before;
    const after = before - gross;
    let feeBps = FEE_MIN_BPS;
    if (after < target) {
        const diff = target - after;
        const span = FEE_MAX_BPS - FEE_MIN_BPS;
        const denom = target * target;
        const bump = (diff * diff * span + denom - 1n) / denom; // ceil
        feeBps = FEE_MIN_BPS + bump;
    }
    const fee = (gross * feeBps + 9999n) / 10000n; // ceil
    return gross - fee;
}
const ref = (slot, role) => `s${slot}:${role}`;
export const vaultLiquidUnstake = {
    slug: SLUG,
    kind: 'constant-product',
    programId: address(PROGRAM_ID),
    /**
     * Off-chain, once per pool. `pool` is the LstInfo account address (this
     * family's "pool", matching every other family's convention — see
     * EcoSwapSvmPoolSpec). Rejects: a missing/undecodable LstInfo, the wrong
     * discriminator, the unsupported 225-byte extended layout (SCOPE, module
     * doc), a missing/malformed global Pool singleton, or a stake-pool
     * account whose shape doesn't match the canonical SPL Stake Pool struct.
     */
    async fetchPoolConfig(load, pool) {
        const lstData = await load(pool);
        if (lstData === null)
            throw new Error(`${SLUG} lstInfo ${pool} not found`);
        if (!discMatches(lstData, LST_INFO_DISCRIMINATOR)) {
            throw new Error(`${SLUG} lstInfo ${pool} has an unexpected discriminator (not an LstInfo account)`);
        }
        if (lstData.length !== LST_INFO_LEN) {
            throw new Error(`${SLUG} lstInfo ${pool} is ${lstData.length} bytes — only the ${LST_INFO_LEN}-byte default-config layout is supported (see module doc SCOPE)`);
        }
        const mint = decodeAddress(lstData, LST_INFO_OFF_MINT);
        const stakePool = decodeAddress(lstData, LST_INFO_OFF_STAKE_POOL);
        const poolData = await load(address(POOL_ADDRESS));
        if (poolData === null || !discMatches(poolData, POOL_DISCRIMINATOR) || poolData.length !== POOL_LEN) {
            throw new Error(`${SLUG} global Pool account is missing or has an unexpected shape`);
        }
        const spData = await load(stakePool);
        if (spData === null ||
            spData.length !== STAKE_POOL_LEN ||
            spData[STAKE_POOL_OFF_ACCOUNT_TYPE] !== 1) {
            throw new Error(`${SLUG} stake pool ${stakePool} (lstInfo ${pool}) is missing or has an unexpected shape`);
        }
        const [poolLstAta] = await findAssociatedTokenPda({
            owner: address(POOL_ADDRESS),
            tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
            mint,
        });
        return { venue: SLUG, pool, mint, stakePool, poolLstAta };
    },
    quoteAccounts(cfg) {
        const c = vluConfig(cfg);
        return [
            { ref: `${SLUG}:globalPool`, address: address(POOL_ADDRESS) },
            { ref: `${SLUG}:stakePool:${c.stakePool}`, address: c.stakePool },
        ];
    },
};
export const vaultLiquidUnstakeLadder = {
    slug: SLUG,
    defaultRungs: 4,
    shapeKey() {
        // Single direction, no per-pool structural variance — one shape serves every LST.
        return SLUG;
    },
    helpers() {
        return [
            {
                name: 'qVaultLiquidUnstake',
                source: [
                    'function qVaultLiquidUnstake(x, rateNum, rateDen, before, target) {',
                    '  if (x <= 0 || rateDen <= 0 || before <= 0) { return 0 }',
                    '  let gross = (x * rateNum) / rateDen;',
                    '  if (gross > before) { gross = before }',
                    '  const after = before - gross;',
                    `  let feeBps = ${FEE_MIN_BPS};`,
                    '  if (after < target) {',
                    '    const diff = target - after;',
                    `    const denom = target * target;`,
                    `    const bump = (diff * diff * ${FEE_MAX_BPS - FEE_MIN_BPS} + denom - 1) / denom;`,
                    `    feeBps = ${FEE_MIN_BPS} + bump;`,
                    '  }',
                    '  const fee = (gross * feeBps + 9999) / 10000;',
                    '  return gross - fee;',
                    '}',
                ].join('\n'),
            },
        ];
    },
    paramCount: 0,
    paramsFor() {
        return [];
    },
    quoteRefs(base, slot) {
        const c = vluConfig(base);
        return [
            { ref: ref(slot, 'globalPool'), address: address(POOL_ADDRESS) },
            { ref: ref(slot, 'stakePool'), address: c.stakePool },
        ];
    },
    emitSetup(base, slot) {
        vluConfig(base);
        const p = `s${slot}`;
        const pool = JSON.stringify(ref(slot, 'globalPool'));
        const stakePool = JSON.stringify(ref(slot, 'stakePool'));
        return [
            `  const ${p}before = accountUint(${pool}, ${POOL_OFF_RESERVE}, 8);`,
            `  const ${p}target = accountUint(${pool}, ${POOL_OFF_TARGET}, 8);`,
            `  const ${p}rnum = accountUint(${stakePool}, ${STAKE_POOL_OFF_TOTAL_LAMPORTS}, 8);`,
            `  const ${p}rden = accountUint(${stakePool}, ${STAKE_POOL_OFF_POOL_TOKEN_SUPPLY}, 8);`,
        ].join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        const p = `s${slot}`;
        return `qVaultLiquidUnstake(${x}, ${p}rnum, ${p}rden, ${p}before, ${p}target)`;
    },
    /**
     * `sell_lst` (Anchor `sha256("global:sell_lst")[0..8]`, confirmed against
     * >20 real mainnet fills across 3 LSTs): disc(8) ++ amount u64 LE
     * (runtime-patched) ++ a single trailing 0x00 byte (observed constant
     * across every sampled fill). Accounts, in the EXACT order every sampled
     * transaction sent them (module doc source 2): pool, poolLstAta
     * (ATA(pool, mint) — writable, receives the sold LST), the CPI signer
     * (owner), the user's LST source ATA, the user's wSOL destination ATA,
     * the LST mint, the underlying stake pool, the LstInfo account itself,
     * the shared SOL vault, the fee account, the inventory-summary
     * singleton, the token program, the system program.
     */
    buildSwapV2(base, slot, user) {
        const c = vluConfig(base);
        return {
            programId: address(PROGRAM_ID),
            prefix: Uint8Array.from(SELL_LST_DISCRIMINATOR),
            suffix: Uint8Array.from([0]),
            patch: 'in',
            accounts: [
                { ref: ref(slot, 'globalPool'), address: address(POOL_ADDRESS), writable: true },
                { ref: ref(slot, 'poolLstAta'), address: c.poolLstAta, writable: true },
                { ref: user.owner, signer: true },
                { ref: user.inAta, writable: true },
                { ref: user.outAta, writable: true },
                { ref: ref(slot, 'mint'), address: c.mint },
                { ref: ref(slot, 'stakePool'), address: c.stakePool },
                { ref: ref(slot, 'lstInfo'), address: c.pool },
                { ref: ref(slot, 'solVault'), address: address(SOL_VAULT_ADDRESS), writable: true },
                { ref: ref(slot, 'feeAccount'), address: address(FEE_ACCOUNT_ADDRESS), writable: true },
                { ref: ref(slot, 'invSummary'), address: address(INVENTORY_SUMMARY_ADDRESS), writable: true },
                { ref: ref(slot, 'tokenProgram'), address: address(TOKEN_PROGRAM_ADDRESS) },
                { ref: ref(slot, 'systemProgram'), address: address(SYSTEM_PROGRAM_ADDRESS) },
            ],
        };
    },
    referenceQuote(base, state) {
        const c = vluConfig(base);
        const poolData = state[POOL_ADDRESS];
        const spData = state[c.stakePool];
        if (poolData === undefined)
            throw new Error(`${SLUG} reference is missing the global Pool account`);
        if (spData === undefined)
            throw new Error(`${SLUG} reference is missing stake pool ${c.stakePool}`);
        const before = readUintLE(poolData, POOL_OFF_RESERVE, 8);
        const target = readUintLE(poolData, POOL_OFF_TARGET, 8);
        const rateNum = readUintLE(spData, STAKE_POOL_OFF_TOTAL_LAMPORTS, 8);
        const rateDen = readUintLE(spData, STAKE_POOL_OFF_POOL_TOKEN_SUPPLY, 8);
        return (x) => vaultLiquidUnstakeQuote(x, rateNum, rateDen, before, target);
    },
    /**
     * There is no natural "reserveIn" (the pool absorbs any amount of the LST —
     * only the SOL side is capacity-bound): reserveIn is modeled as the LST
     * amount the live SOL reserve could absorb (xCap = before·rateDen/rateNum),
     * reserveOut as the SOL reserve itself — both derived from the SAME real
     * constraint, so isqrt(reserveIn·reserveOut) stays a scale-comparable depth
     * proxy for the relative-depth filter.
     */
    depthReserves(base, state) {
        const c = vluConfig(base);
        const poolData = state[POOL_ADDRESS];
        const spData = state[c.stakePool];
        if (poolData === undefined)
            throw new Error(`${SLUG} depth is missing the global Pool account`);
        if (spData === undefined)
            throw new Error(`${SLUG} depth is missing stake pool ${c.stakePool}`);
        const before = readUintLE(poolData, POOL_OFF_RESERVE, 8);
        const rateNum = readUintLE(spData, STAKE_POOL_OFF_TOTAL_LAMPORTS, 8);
        const rateDen = readUintLE(spData, STAKE_POOL_OFF_POOL_TOKEN_SUPPLY, 8);
        const reserveIn = rateNum > 0n ? (before * rateDen) / rateNum : 0n;
        return { reserveIn, reserveOut: before };
    },
    continuousFees() {
        // Measurement-only oracle input (never a gate) — the flat FEE_MIN_BPS floor,
        // ppm-scaled (1 bps = 100 ppm). The drawdown-dependent bump is not modeled
        // here; it only ever makes the real venue LESS favorable than this estimate.
        return { gammaPpm: 1000000n, muPpm: 1000000n - FEE_MIN_BPS * 100n };
    },
};
//# sourceMappingURL=index.js.map