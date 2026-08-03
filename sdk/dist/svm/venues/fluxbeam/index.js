/**
 * FluxBeam (program `FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X`) — a
 * permissionless constant-product AMM factory, Token-2022-capable on both
 * legs. Byte layout is IDENTICAL to spl-token-swap's `SwapV1` (the same
 * 324-byte, no-discriminator `SwapVersion::pack` shape `orca-legacy-token-swap`
 * already decodes — `version(1)+is_initialized(1)+bump_seed(1)+token_program(32)
 * +token_a(32)+token_b(32)+pool_mint(32)+token_a_mint(32)+token_b_mint(32)
 * +pool_fee_account(32)+Fees(8×u64=64)+SwapCurve(curve_type u8 + 32-byte
 * calculator)`), CONFIRMED byte-for-byte against two real mainnet pools:
 *   - `CZEZDGDkzsn4zTfdw6XRm4U1o6GatotMhhRmVEzdwGS3` (SOL/USDC, curve_type 0,
 *     trade_fee 20/1000, owner_trade_fee 5/1000, classic Tokenkeg legs) —
 *     this repo's off-chain quote matched Jupiter's own `dexes=FluxBeam`
 *     single-venue quote BIT-EXACT at 0.1/1/5 SOL.
 *   - `M6N5wxWzSjwpPzH1F7YMNfGxHDfuM88Ey7KAruAxn5N` (a Token-2022
 *     TransferFeeConfig mint `BHHyGwamPG2sihrP4qTs6c5T88DB65oqoBpTQc8kdPS7` /
 *     SOL, bps=200 i.e. 2%, maximumFee effectively unreachable) — the wire
 *     transfer-fee model below (see `qFluxBeam`) is what makes this repo's
 *     quote match the real program's realized output on that pool; without
 *     it the quote overshoots by exactly the 2% wire fee the vault never
 *     actually receives. Jupiter itself refuses to quote this specific mint
 *     (`TOKEN_NOT_TRADABLE`, a risk-list policy, not a math question), so the
 *     cross-check for THIS pool is the real-CPI LiteSVM lane
 *     (test/svm/venues/fluxbeam.test.ts + the realcpi e2e cell), not Jupiter.
 *
 * REAL-CPI PROOF (test/svm/ecoswap-svm.realcpi.e2e.test.ts's `fluxbeam` cells, SAUCE_VENUE_PROGRAMS-
 * gated): the actual mainnet `fluxbeam.so` binary, executed via LiteSVM on the two real pools above
 * through the full production `svmRoute` compile path, realizes OUTPUT bit-exact to this ladder's
 * predicted quote on BOTH pools (71_656_795 at 1 SOL classic; 197 at ~1.95e9 raw wire-fee-mint
 * input) — the load-bearing invariant `minOut` enforces. DISCLOSED, MEASURED, and NOT a quoting
 * error: the real binary's own internal transfer sizing pulls a few raw units LESS than the
 * instructed `amount_in` from the user's account on BOTH pools (6 units on the classic pool with no
 * fee involved at all; ~0.49% on the wire-fee pool) — the un-pulled remainder simply stays in the
 * user's own account (never lost, never double-counted), and OUTPUT is unaffected either way; see
 * that test file's `expectedDebit` param and its cell-level comments for the exact pinned numbers.
 *
 * The Clock sysvar (`SysvarC1ock11111111111111111111111111111111`, epoch @ offset 16) is read
 * OFF-CHAIN, lazily, only when a leg mint carries a TransferFeeConfig extension — never checked in
 * as a fixture file: a real dump of this widely-shared sysvar address, loaded into a harness that
 * pins its OWN clock (every jest engine harness in this repo does, via `startEngine`), silently
 * overwrote that pin and broke an UNRELATED family's time-dependent measurement (meteora-dlmm's
 * dynamic fee) the one time this was tried — see the git history of
 * test/svm/ecoswap-svm.cu.e2e.test.ts and test/svm/venues/fluxbeam.test.ts for the concrete lesson:
 * synthesize sysvar/canonical-mint bytes in-memory in tests instead of dumping them to disk.
 *
 * The stored `token_program` field (offset 3) is NOT a per-leg signal — on
 * BOTH sampled pools it reads the Token-2022 program even though the SOL/USDC
 * pool's actual leg mints are classic Tokenkeg. FluxBeam always mints its LP
 * token (`pool_mint`) under Token-2022 regardless of what the trade legs use,
 * and that field is for the pool_mint/pool_fee_account CPIs only (accounts 7/8
 * below) — the real per-leg token programs (accounts 11/12) were recovered by
 * decoding a live inner CPI instruction (see the swap-account-order note on
 * `buildSwapV2`), not from any pool-stored field.
 *
 * DIRECTION: AtoB ONLY (mintA in, mintB out) — the SAME scope limitation this
 * repo already accepts for `orca-legacy-token-swap`. Every real swap sampled
 * on `CZEZDGDkzsn4zTfdw6XRm4U1o6GatotMhhRmVEzdwGS3` traded SOL(A)->USDC(B); no
 * live B->A instance was found to confirm whether the trailing mint/
 * token-program accounts (9-13) reorder for the reverse direction (unlike
 * accounts 4/5, whose swap does flip which vault is `swap_source` per
 * spl-token-swap convention) — FluxBeam's own program is closed-source, so
 * guessing that order for a real swap CPI risks a wrong-program transfer
 * rather than a clean revert. Both mint orderings are still discovered
 * (`SVM_FAMILY_FILTERS` queries both), so a pool is simply dropped when the
 * requested pair is the reverse of its stored A/B order — exactly like
 * orca-legacy-token-swap today.
 *
 * TOKEN-2022 MINT DETECTION: `AccountLoader` returns only account BYTES (no
 * owner), and unlike raydium-cp-swap's `PoolState` (which stores each leg's
 * owning program explicitly, added specifically for Token-2022 support),
 * FluxBeam's pool account carries no per-leg program field at all. The
 * classic Tokenkeg program's `Mint::unpack` requires EXACTLY 82 bytes — it
 * cannot create or read an account of any other length — so any mint account
 * longer than 82 bytes MUST be owned by Token-2022 (that program is the only
 * one supporting the longer, extension-carrying layout); `scanMint` uses this
 * as a SOUND (not merely heuristic) direction. The one residual gap runs the
 * other way: a Token-2022 mint deployed with ZERO extensions is also exactly
 * 82 bytes and is indistinguishable from a classic mint by data alone, so it
 * would be mis-tagged Tokenkeg here. This is a disclosed, narrow residual —
 * no extension means no different transfer behavior either way except the
 * CPI's target program id, and a bare-extensionless Token-2022 mint actively
 * trading on a permissionless AMM is vanishingly unlikely (the entire reason
 * to mint under Token-2022 over classic is to use an extension) — a
 * misclassification there fails the swap CPI loudly (wrong owning program),
 * never silently mis-quotes.
 *
 * TRANSFER-FEE TIER SELECTION: a Token-2022 `TransferFeeConfig` extension
 * carries an `older`/`newer` double-buffered fee (the newer only takes effect
 * once the cluster's epoch reaches `newer.epoch`, so an authority's fee change
 * cannot apply retroactively mid-epoch). `fetchPoolConfig` resolves the
 * ACTIVE tier at fetch time by reading the live Clock sysvar
 * (`SysvarC1ock11111111111111111111111111111111`, epoch @ offset 16) — fetched
 * lazily, only when a leg mint actually carries the extension — and bakes the
 * resolved bps/maximumFee as compile-time params, the SAME treatment this
 * repo already gives `orca-legacy-token-swap`'s (also nominally admin-settable
 * but never re-read live) trade/owner fee numerators. A fee bumped between
 * fetch and cook is the same class of drift every venue's quote already has
 * relative to live execution, backstopped by `minOut` — not a new gap.
 *
 * A TransferHook (ExtensionType 14) or NonTransferable (ExtensionType 9)
 * extension on either leg self-drops the WHOLE pool (`fetchPoolConfig`
 * throws): a hook can run arbitrary logic requiring extra accounts this
 * adapter does not attach, and a non-transferable mint cannot be swapped at
 * all — both are the venue-robustness "one bad pool never kills a cook"
 * self-drop class already used throughout this recipe.
 */
import { createHash } from 'node:crypto';
import { address, getAddressCodec } from '@solana/kit';
import { ceilDiv, readUintLE } from '../math.js';
const SLUG = 'fluxbeam';
export const FLUXBEAM_PROGRAM_ID = address('FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X');
const TOKENKEG_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const CLOCK_SYSVAR = address('SysvarC1ock11111111111111111111111111111111');
/** `SwapVersion::pack` = 1-byte version tag + the 323-byte `SwapV1` body. */
export const FLUXBEAM_POOL_SIZE = 324;
// SwapV1 offsets (identical to orca-legacy-token-swap's — same upstream spl-token-swap layout).
const OFF_VERSION = 0;
const OFF_IS_INITIALIZED = 1;
const OFF_BUMP_SEED = 2;
const OFF_TOKEN_PROGRAM_POOL = 3;
const OFF_VAULT_A = 35;
const OFF_VAULT_B = 67;
const OFF_POOL_MINT = 99;
const OFF_MINT_A = 131;
const OFF_MINT_B = 163;
const OFF_POOL_FEE_ACCOUNT = 195;
const OFF_TRADE_FEE_NUMERATOR = 227;
const OFF_TRADE_FEE_DENOMINATOR = 235;
const OFF_OWNER_TRADE_FEE_NUMERATOR = 243;
const OFF_OWNER_TRADE_FEE_DENOMINATOR = 251;
const OFF_CURVE_TYPE = 291;
const VAULT_AMOUNT_OFFSET = 64; // SPL token account amount (u64 LE), Tokenkeg and Token-2022 alike.
/** ExtensionType ordinals this adapter cares about (spl-token-2022's `extension::ExtensionType`). */
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_NON_TRANSFERABLE = 9;
const EXT_TRANSFER_HOOK = 14;
/** Base SPL account size Token-2022 pads to before the account-type + TLV tail. */
const TOKEN_2022_BASE_LEN = 165;
function getAddressEncoded(value) {
    return new Uint8Array(getAddressCodec().encode(value));
}
/**
 * `create_program_address([pool, bump_seed], program_id)` — the same
 * off-curve PDA scheme spl-token-swap forks use for the swap authority,
 * verified against the REAL authority of both sampled mainnet pools
 * (`Fv9Yjbk4BXV4nwdP3xKaRT3xiSUKTojsKgqSgwvjujLK` for
 * `CZEZDGDkzsn4zTfdw6XRm4U1o6GatotMhhRmVEzdwGS3`, bump 255).
 */
function deriveSwapAuthority(pool, bumpSeed) {
    const codec = getAddressCodec();
    return codec.decode(createHash('sha256')
        .update(getAddressEncoded(pool))
        .update(Uint8Array.of(bumpSeed))
        .update(getAddressEncoded(FLUXBEAM_PROGRAM_ID))
        .update('ProgramDerivedAddress')
        .digest());
}
/**
 * Decodes one leg's mint: the owning token program (SOUND for >82 bytes — see
 * the file header) plus its TransferFeeConfig tiers, if any. Throws on a
 * TransferHook/NonTransferable extension (unsupported — self-drops the pool).
 */
function scanMint(mint, data) {
    if (data.length < 82) {
        throw new Error(`fluxbeam: mint ${mint} is ${data.length} bytes, too short to be an SPL mint`);
    }
    if (data.length === 82)
        return { tokenProgram: TOKENKEG_PROGRAM, tiers: null };
    // > 82 bytes is possible ONLY under Token-2022 (Tokenkeg's Mint::unpack requires exactly 82).
    if (data.length <= TOKEN_2022_BASE_LEN || data[TOKEN_2022_BASE_LEN] !== 1) {
        // Extended allocation with no parseable extension tail (or an account-type byte other than
        // Mint=1, which should not happen for a real mint) — no fee we can see either way.
        return { tokenProgram: TOKEN_2022_PROGRAM, tiers: null };
    }
    let offset = TOKEN_2022_BASE_LEN + 1;
    let tiers = null;
    while (offset + 4 <= data.length) {
        const type = Number(readUintLE(data, offset, 2));
        if (type === 0)
            break; // Uninitialized — trailing padding
        const length = Number(readUintLE(data, offset + 2, 2));
        const value = offset + 4;
        if (type === EXT_TRANSFER_HOOK) {
            throw new Error(`fluxbeam: mint ${mint} carries a TransferHook extension (unsupported — cannot safely CPI without the hook's extra accounts)`);
        }
        if (type === EXT_NON_TRANSFERABLE) {
            throw new Error(`fluxbeam: mint ${mint} is NonTransferable (cannot be swapped)`);
        }
        if (type === EXT_TRANSFER_FEE_CONFIG) {
            // TransferFeeConfig (108 bytes): authority(32)+withdrawAuthority(32)+withheldAmount(8)+
            // older{epoch(8),maximumFee(8),bps(2)}+newer{epoch(8),maximumFee(8),bps(2)}.
            tiers = {
                older: { epoch: readUintLE(data, value + 72, 8), max: readUintLE(data, value + 80, 8), bps: readUintLE(data, value + 88, 2) },
                newer: { epoch: readUintLE(data, value + 90, 8), max: readUintLE(data, value + 98, 8), bps: readUintLE(data, value + 106, 2) },
            };
        }
        offset += 4 + length;
    }
    return { tokenProgram: TOKEN_2022_PROGRAM, tiers };
}
const activeTier = (tiers, epoch) => (epoch >= tiers.newer.epoch ? tiers.newer : tiers.older);
export async function fetchFluxBeamPoolConfig(load, pool) {
    const data = await load(pool);
    if (data === null)
        throw new Error(`${SLUG}: pool ${pool} account not found`);
    if (data.length !== FLUXBEAM_POOL_SIZE) {
        throw new Error(`${SLUG}: pool ${pool} data must be ${FLUXBEAM_POOL_SIZE} bytes (SwapVersion::SwapV1), got ${data.length}`);
    }
    if (data[OFF_VERSION] !== 1)
        throw new Error(`${SLUG}: pool ${pool} version must be 1 (SwapV1), got ${data[OFF_VERSION]}`);
    if (data[OFF_IS_INITIALIZED] !== 1)
        throw new Error(`${SLUG}: pool ${pool} is not initialized`);
    if (data[OFF_CURVE_TYPE] !== 0) {
        throw new Error(`${SLUG}: pool ${pool} curve_type must be 0 (constant product), got ${data[OFF_CURVE_TYPE]}`);
    }
    const codec = getAddressCodec();
    const pubkey = (offset) => codec.decode(data.subarray(offset, offset + 32));
    const u64 = (offset) => readUintLE(data, offset, 8);
    const bumpSeed = data[OFF_BUMP_SEED];
    const mintA = pubkey(OFF_MINT_A);
    const mintB = pubkey(OFF_MINT_B);
    const tradeFeeNumerator = u64(OFF_TRADE_FEE_NUMERATOR);
    const tradeFeeDenominator = u64(OFF_TRADE_FEE_DENOMINATOR);
    const ownerTradeFeeNumerator = u64(OFF_OWNER_TRADE_FEE_NUMERATOR);
    const ownerTradeFeeDenominator = u64(OFF_OWNER_TRADE_FEE_DENOMINATOR);
    for (const [name, numerator, denominator] of [
        ['trade', tradeFeeNumerator, tradeFeeDenominator],
        ['owner trade', ownerTradeFeeNumerator, ownerTradeFeeDenominator],
    ]) {
        if (numerator !== 0n && denominator === 0n) {
            throw new Error(`${SLUG}: pool ${pool} ${name} fee denominator is 0 with nonzero numerator ${numerator}`);
        }
    }
    const [mintAData, mintBData] = await Promise.all([load(mintA), load(mintB)]);
    if (mintAData === null)
        throw new Error(`${SLUG}: mint ${mintA} of pool ${pool} not found`);
    if (mintBData === null)
        throw new Error(`${SLUG}: mint ${mintB} of pool ${pool} not found`);
    const infoA = scanMint(mintA, mintAData);
    const infoB = scanMint(mintB, mintBData);
    let epoch = 0n;
    if (infoA.tiers !== null || infoB.tiers !== null) {
        const clockData = await load(CLOCK_SYSVAR);
        if (clockData === null)
            throw new Error(`${SLUG}: could not read the Clock sysvar to resolve pool ${pool}'s active transfer-fee tier`);
        epoch = readUintLE(clockData, 16, 8);
    }
    const feeA = infoA.tiers === null ? { bps: 0n, max: 0n } : activeTier(infoA.tiers, epoch);
    const feeB = infoB.tiers === null ? { bps: 0n, max: 0n } : activeTier(infoB.tiers, epoch);
    return {
        venue: SLUG,
        pool,
        swapAuthority: deriveSwapAuthority(pool, bumpSeed),
        tokenProgramPool: pubkey(OFF_TOKEN_PROGRAM_POOL),
        vaultA: pubkey(OFF_VAULT_A),
        vaultB: pubkey(OFF_VAULT_B),
        poolMint: pubkey(OFF_POOL_MINT),
        mintA,
        mintB,
        poolFeeAccount: pubkey(OFF_POOL_FEE_ACCOUNT),
        tokenProgramA: infoA.tokenProgram,
        tokenProgramB: infoB.tokenProgram,
        tradeFeeNumerator,
        tradeFeeDenominator,
        ownerTradeFeeNumerator,
        ownerTradeFeeDenominator,
        feeA: { bps: feeA.bps, max: feeA.max },
        feeB: { bps: feeB.bps, max: feeB.max },
    };
}
/** Family facade for the recipe orchestrator (ladder-only, like orca-legacy-token-swap). */
export const fluxbeam = {
    slug: SLUG,
    programId: FLUXBEAM_PROGRAM_ID,
    fetchPoolConfig: fetchFluxBeamPoolConfig,
};
// ---------------------------------------------------------------------------
// Ladder (single-quote CP fragment, no window — like orca-legacy-token-swap's).
// ---------------------------------------------------------------------------
function fluxbeamConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
export const fluxbeamLadder = {
    slug: SLUG,
    shapeKey() {
        return `${SLUG}:AtoB`;
    },
    // Generalizes orca-legacy-token-swap's qOrca with a Token-2022 wire-fee wrap
    // on BOTH legs (see the file header): (1) the input-side wire fee reduces
    // what the vault actually receives BEFORE the AMM's own trade/owner fee and
    // curve run on it; (2) the output-side wire fee reduces what the user's
    // destination account actually receives AFTER the curve computes the gross
    // payout. Both wire fees are `ceil(amount*bps/10000)` capped at the
    // extension's `maximumFee`, per spl-token-2022's own `calculate_fee`; with
    // ib=ob=0 (no extension on either leg) this is byte-identical to qOrca.
    helpers() {
        return [
            {
                name: 'qFluxBeam',
                source: [
                    'function qFluxBeam(x, rin, rout, tn, td, on, od, ib, im, ob, om) {',
                    '  if (x === 0) { return 0 }',
                    '  let wi = 0;',
                    '  if (ib > 0) {',
                    '    wi = (x * ib + 9999) / 10000;',
                    '    if (wi > im) { wi = im }',
                    '  }',
                    '  if (wi >= x) { return 0 }',
                    '  const netIn = x - wi;',
                    '  if (rin === 0 || rout === 0) { return 0 }',
                    '  let tf = 0;',
                    '  if (tn > 0) { tf = netIn * tn / td; if (tf === 0) { tf = 1 } }',
                    '  let of = 0;',
                    '  if (on > 0) { of = netIn * on / od; if (of === 0) { of = 1 } }',
                    '  if (tf + of >= netIn) { return 0 }',
                    '  const ammNet = netIn - tf - of;',
                    '  const dn = rin + ammNet;',
                    '  const no = (rin * rout + dn - 1) / dn;',
                    '  if (no >= rout) { return 0 }',
                    '  const gross = rout - no;',
                    '  let wo = 0;',
                    '  if (ob > 0) {',
                    '    wo = (gross * ob + 9999) / 10000;',
                    '    if (wo > om) { wo = om }',
                    '  }',
                    '  if (wo >= gross) { return 0 }',
                    '  return gross - wo;',
                    '}',
                ].join('\n'),
            },
        ];
    },
    /** trade fee num/den, owner fee num/den, input-wire-fee bps/max, output-wire-fee bps/max. */
    paramCount: 8,
    paramsFor(base) {
        const cfg = fluxbeamConfig(base);
        return [
            cfg.tradeFeeNumerator,
            cfg.tradeFeeDenominator,
            cfg.ownerTradeFeeNumerator,
            cfg.ownerTradeFeeDenominator,
            cfg.feeA.bps,
            cfg.feeA.max,
            cfg.feeB.bps,
            cfg.feeB.max,
        ];
    },
    quoteRefs(base, slot) {
        const cfg = fluxbeamConfig(base);
        return [
            { ref: ref(slot, 'vin'), address: cfg.vaultA },
            { ref: ref(slot, 'vout'), address: cfg.vaultB },
        ];
    },
    emitSetup(_base, slot, params) {
        return [
            `  const s${slot}rin = accountUint(${JSON.stringify(ref(slot, 'vin'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
            `  const s${slot}rout = accountUint(${JSON.stringify(ref(slot, 'vout'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
            `  const s${slot}tn = ${params[0]};`,
            `  const s${slot}td = ${params[1]};`,
            `  const s${slot}on = ${params[2]};`,
            `  const s${slot}od = ${params[3]};`,
            `  const s${slot}ib = ${params[4]};`,
            `  const s${slot}im = ${params[5]};`,
            `  const s${slot}ob = ${params[6]};`,
            `  const s${slot}om = ${params[7]};`,
        ].join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        return `qFluxBeam(${x}, s${slot}rin, s${slot}rout, s${slot}tn, s${slot}td, s${slot}on, s${slot}od, s${slot}ib, s${slot}im, s${slot}ob, s${slot}om)`;
    },
    buildSwapV2(base, slot, user) {
        const cfg = fluxbeamConfig(base);
        // SwapInstruction::Swap: [tag=1] ++ amount_in u64 LE (patched) ++
        // minimum_amount_out u64 LE = 1. Account order recovered from a live inner
        // CPI on CZEZDGDkzsn4zTfdw6XRm4U1o6GatotMhhRmVEzdwGS3 (see the file
        // header): the classic spl-token-swap 10-account Swap list with its
        // single trailing `token_program` REPLACED by 5 accounts —
        // mint_a, mint_b, token_program_a, token_program_b, token_program_pool —
        // the Token-2022 `transfer_checked` shape needs the mint account plus the
        // CORRECT per-leg program, and FluxBeam's pool_mint/fee_account ops still
        // need the pool's own stored token_program (accounts 7/8 above).
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: FLUXBEAM_PROGRAM_ID,
            prefix: Uint8Array.from([1]),
            suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
            patch: 'in',
            accounts: [
                roled('pool', cfg.pool),
                roled('auth', cfg.swapAuthority),
                { ref: user.owner, signer: true },
                { ref: user.inAta, writable: true },
                roled('va', cfg.vaultA, true),
                roled('vb', cfg.vaultB, true),
                { ref: user.outAta, writable: true },
                roled('pmint', cfg.poolMint, true),
                roled('pfee', cfg.poolFeeAccount, true),
                roled('ma', cfg.mintA),
                roled('mb', cfg.mintB),
                roled('tpa', cfg.tokenProgramA),
                roled('tpb', cfg.tokenProgramB),
                roled('tpp', cfg.tokenProgramPool),
            ],
        };
    },
    referenceQuote(base, state, params) {
        const cfg = fluxbeamConfig(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
            return data;
        };
        const rin = readUintLE(bytes(cfg.vaultA), VAULT_AMOUNT_OFFSET, 8);
        const rout = readUintLE(bytes(cfg.vaultB), VAULT_AMOUNT_OFFSET, 8);
        const [tn, td, on, od, ib, im, ob, om] = params;
        return (x) => {
            if (x === 0n)
                return 0n;
            let wi = 0n;
            if (ib > 0n) {
                wi = ceilDiv(x * ib, 10000n);
                if (wi > im)
                    wi = im;
            }
            if (wi >= x)
                return 0n;
            const netIn = x - wi;
            if (rin === 0n || rout === 0n)
                return 0n;
            let tf = 0n;
            if (tn > 0n) {
                tf = (netIn * tn) / td;
                if (tf === 0n)
                    tf = 1n;
            }
            let of = 0n;
            if (on > 0n) {
                of = (netIn * on) / od;
                if (of === 0n)
                    of = 1n;
            }
            if (tf + of >= netIn)
                return 0n;
            const ammNet = netIn - tf - of;
            const dn = rin + ammNet;
            const no = ceilDiv(rin * rout, dn);
            if (no >= rout)
                return 0n;
            const gross = rout - no;
            let wo = 0n;
            if (ob > 0n) {
                wo = ceilDiv(gross * ob, 10000n);
                if (wo > om)
                    wo = om;
            }
            if (wo >= gross)
                return 0n;
            return gross - wo;
        };
    },
    depthReserves(base, state) {
        const cfg = fluxbeamConfig(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
            return data;
        };
        return {
            reserveIn: readUintLE(bytes(cfg.vaultA), VAULT_AMOUNT_OFFSET, 8),
            reserveOut: readUintLE(bytes(cfg.vaultB), VAULT_AMOUNT_OFFSET, 8),
        };
    },
    // AMM-only gamma (mirrors orca-legacy-token-swap) — the depth/efficiency
    // oracle is a measurement, never a gate, and does not additionally fold the
    // wire transfer fee's effect on the continuous curve (a documented
    // simplification, not a correctness gap: the ladder's own emitQuoteCall/
    // referenceQuote pair is what the merge and the fund-safety floor read).
    continuousFees(_base, _state, params) {
        const [tn, td, on, od] = params;
        let gamma = 1000000n;
        if (tn > 0n)
            gamma -= (tn * 1000000n) / td;
        if (on > 0n)
            gamma -= (on * 1000000n) / od;
        return { gammaPpm: gamma, muPpm: 1000000n };
    },
};
//# sourceMappingURL=index.js.map