/**
 * Perena Star — the junior-tranche staking market of Perena's on-chain lending
 * program ("bankineco", `save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H`). The
 * bank mint for the (currently sole) live tranche is a vanity address
 * literally prefixed `star9ag...` — the "Star" product this venue's label
 * names. Atomic pair: `stake_junior` (bank mint in -> junior share token
 * out) / `instant_unstake_junior` (junior share token in -> bank mint out,
 * fee-charged, immediate). `request_unstake_junior` (+ `fulfill_unstake_junior`)
 * is the QUEUED exit path — genuinely asynchronous (a lockup + a second,
 * separately-signed instruction), out of scope for a single atomic CPI, and
 * not implemented here. `deposit_in_lp`/`withdraw_from_lp` (the bank's OWN
 * `yield_manager`-signed rebalancing into/out of its configured lending
 * platform) are NOT a user-facing swap at all — `yield_manager` must sign,
 * which this recipe cannot do — so they are correctly out of scope, not a gap.
 *
 * LAYOUT — ground-truthed against the REAL on-chain accounts, not just the
 * IDL: the program's on-chain Anchor IDL account (17,482 bytes, fetched via
 * the standard `createWithSeed(findProgramAddress([], programId), "anchor:idl",
 * programId)` PDA) gives the exact struct field order for `TrancheState`
 * (bump, _pad, bank: Pubkey, config: TrancheConfig, accounting:
 * TrancheAccounting, _pad) and `BankState` (bump, bank_index, _pad, config:
 * BankConfig, status: BankStatus, accounting: BankAccounting, mint: BankMint,
 * vaults, _pad); this file hand-decodes both as fixed absolute byte offsets
 * (verified against the ONE live tranche/bank pair on mainnet,
 * `hXfEYpB5FB3ZWjGNc5C5JqLixmGdmZFyjXKJB2xFPgc` / `sM6P4mh53CnG4faN4Fo3seY7wMSAiHdy8o6gKjwQF7A`,
 * TrancheState 448 bytes / BankState 1560 bytes, no `Option<T>`/variable-length
 * fields anywhere in either struct's declared prefix — a true fixed-offset
 * decode, unlike e.g. sanctum-stake-pool's cursor).
 *
 * QUOTE MATH — derived from a REAL `stake_junior` transaction's own log line
 * plus THREE ground-truth `simulateTransaction` runs per direction against
 * the live mainnet tranche (mainnet: `2FgdSkPkoxNrfRuVrpdxbfAYvPbdaBkFM1sosTdLbV6e`
 * for stake — a real bank-mint holder — and `A7iAVavBmUHrYRrXUSkhT72B7riqmvcFDSJGu12xXVhP`
 * for unstake — a real junior-share holder — at 1 / 1,000 / 50,000 tokens
 * each, `sigVerify:false`, nothing submitted for real), with the unstake
 * side additionally cross-checked against the REAL pre/post SPL balance
 * delta (not just the log line) via `simulateTransaction`'s `accounts:`
 * read-back:
 *
 *   STAKE:   value  = floor(amountIn * bankPrice / 1e6)
 *            shares = floor(value * 1e6 / sharePrice)
 *   (log-confirmed bit-for-bit at 1e6 / 1e9 / 5e10 raw bank-mint-in: "Staked
 *   1000000 tokens (value 1083471) -> 1020554 junior shares minted" etc.)
 *
 *   UNSTAKE: gross = floor(sharesIn * sharePrice / 1e6)
 *            fee   = floor(gross * feeBps / 1e4)
 *            net   = gross - fee
 *            out   = floor(net * 1e6 / bankPrice)
 *   (balance-delta-confirmed exactly at 1e6 and 1e9 raw shares-in, and 2
 *   lamports conservative — i.e. UNDER, never over — at 5e10: the live
 *   program's own `fee` is consistently ~1-2 units below this `floor`
 *   formula predicts, per the "Unstake early" log's `fee_value` vs this
 *   formula's own `fee`, at every sampled size; this file deliberately does
 *   NOT chase that last-lamport remainder — same "a model more favourable
 *   than reality is a liveness hazard, plain floor already errs SAFE" call
 *   sanctum-stake-pool's own header makes for its `ceil`-via-`floor+1`.
 *   `feeBps` is `earlyUnstakeFeeBps` normally, or `lowStakeFeeBps` when
 *   `lowStakeFeeEnabled` AND `virtualValue*1e4 < yieldingTvl*lowStakeThresholdBps`
 *   — ground-truthed against `@perena/bankineco-sdk`'s own
 *   `fetchUnstakeFee` (the maintainers' published npm client), which computes
 *   the identical threshold off the identical two fields; that SDK's own
 *   single-ratio `shares*sharePrice/bankPrice` shortcut for the GROSS amount
 *   was checked against the real balance delta and found imprecise by
 *   design (an acceptable off-chain estimate, not lamport-exact) — this file
 *   uses the THREE-step form above instead, which matched the real transfer
 *   exactly at two of three sampled sizes and was safely conservative at the
 *   third.
 *
 * Both `bankPrice` (`BankState.mint.price`) and `sharePrice`
 * (`TrancheState.accounting.share_price`) are ADMIN/YIELD-DRIVEN and read
 * LIVE via `accountUint` (never baked as a compile-time param), exactly like
 * every other family's admin-mutable rate. The formula is EXACTLY affine in
 * the trade amount for a fixed live state (no curvature at all) up to the
 * capacity clamp below, so `defaultRungs` is pinned at the framework floor
 * (2) — a straight line loses nothing to a coarser grid, same call as
 * sanctum-stake-pool's header.
 *
 * CAPACITY — STAKE is genuinely uncapped pool-side (mints proportional
 * shares against whatever the trader can transfer; the live bank's own
 * `max_yielding_tvl` is 0/disabled on the only live bank). UNSTAKE is
 * capped: `instant_unstake_junior` transfers `net` bank-mint tokens OUT of
 * `junior_escrow_ata`, and the escrow can hold LESS than an uncapped
 * `net(sharesIn)` would demand — asking for more than that would abort the
 * whole cook (SVM execution-time catch is a platform impossibility, see
 * README). This adapter computes a CONSERVATIVE capacity in SHARES,
 * `capShares = floor(escrowBalance * bankPrice / sharePrice)`, which is
 * provably safe REGARDLESS of the fee (dropping the fee term only ever
 * INCREASES the true payout bound, so capping on the fee-free upper bound
 * can only under-quote, never over-quote): for any `S <= capShares`,
 * `out(S) <= gross(S) <= S*sharePrice/bankPrice <= escrowBalance` (each `<=`
 * from a `floor` never increasing its input, or from `S <= capShares`'s own
 * definition) — so a fully-filled slot at `capShares` never asks the escrow
 * for more than it holds. This is wired as the ladder framework's
 * `capacityInputVar`/`referenceCapacities` mechanism (see obric-v2 for the
 * same pattern): the codegen books each rung's `dIn` from this cap's own
 * DELTA, so the merge's own patched CPI amount (`fill[i]`) can never exceed
 * `capShares` either, even when this slot is the last one standing with
 * budget still remaining (the "phantom capacity past the real cap" failure
 * mode a plain `emitQuoteCall`-only clamp would NOT prevent, since the
 * merge's `din[]` booking would still use the raw, uncapped grid span for
 * `fill[i]` unless `capacityInputVar` tells it otherwise).
 *
 * SELF-DROP — `BankStatus.is_halted` (protocol-wide) plus the
 * direction-specific `is_halted_deposit` / `is_halted_withdrawal` (both set
 * by `trigger_bank_circuit_breaker`) are read LIVE in the fragment (not just
 * at fetch time — SVM has no execution-time catch, so a flag that flips
 * between prepare and cook must still zero the quote rather than let a
 * doomed CPI launch) and force `capShares` to 0, which floors every rung's
 * quote to 0 and keeps the merge from ever electing this slot — the same
 * "deactivate rather than throw at cook time" shape obric-v2's oracle-status
 * check uses. `fetchPoolConfig` ALSO throws immediately on an
 * ALREADY-halted pool (protocol-wide `is_halted`) so a permanently-dead
 * tranche never enters the universe at all; the direction-specific flags are
 * snapshotted onto the config and re-checked in the family's `gate` hook
 * (ecoswap/svm/index.ts) as the same belt-and-suspenders prepare-time
 * shortcut every other family's activation gate uses.
 *
 * ACCOUNTS — both instructions take a SINGLE `u64` arg (`amount`/`shares`)
 * with NO trailing on-chain min-out param, so `suffix` is empty on both
 * (the recipe's own terminal outAta delta check is the real bound, as
 * always). `instant_unstake_junior` additionally declares 8 TRAILING
 * `optional` accounts (a yielding-mint conversion detour this adapter never
 * uses — `target_mint` is always `bank_mint`, the "plain" redemption case).
 * Ground-truthed live: omitting them entirely fails
 * (`AccountNotEnoughKeys`/0xbbd) — Anchor's own generated TS client
 * (`@perena/bankineco-sdk`) instead passes the PROGRAM's OWN id as the
 * "None" sentinel for each of the 8 slots (`accountsPartial({..., vaultState:
 * yr?.vaultState ?? null, ...})`, which that SDK's Anchor version resolves to
 * `programId` on the wire) — confirmed by re-simulating with exactly that
 * (8 trailing `programId` accounts) and observing a clean success at all
 * three sampled sizes, both via `unitsConsumed` and the real balance delta.
 * `junior_mint`/`bank_mint` are assumed classic SPL Token (not Token-2022) —
 * confirmed against the one live tranche's real transactions; the
 * `AccountLoader` this framework's `fetchPoolConfig` receives carries no
 * owner field to detect Token-2022 generically (unlike raydium-cp-swap,
 * whose pool state stores each mint's owning program directly).
 *
 * CU — see ../budget.ts's `perena-star` entry for the measurement citation
 * (real `simulateTransaction` runs against the live mainnet tranche, both
 * instructions, three sizes each).
 */
import { address, getAddressDecoder } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
export const PERENA_STAR_PROGRAM_ID = address('save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const STAKE_JUNIOR_DISCRIMINATOR = Uint8Array.from([6, 116, 147, 101, 38, 154, 179, 246]);
const INSTANT_UNSTAKE_JUNIOR_DISCRIMINATOR = Uint8Array.from([187, 52, 186, 3, 166, 82, 14, 121]);
const TRANCHE_STATE_DISCRIMINATOR = Uint8Array.from([212, 231, 254, 24, 238, 63, 92, 105]);
const BANK_STATE_DISCRIMINATOR = Uint8Array.from([16, 169, 126, 99, 35, 169, 73, 200]);
const TRANCHE_STATE_SIZE = 448;
const BANK_STATE_SIZE = 1560;
// TrancheState absolute byte offsets (8-byte Anchor discriminator included).
const OFF_TRANCHE_BANK = 16; // pubkey
const OFF_MINT = 48; // pubkey — TrancheConfig.mint (the bank mint, "senior" token)
const OFF_SHARE_MINT = 80; // pubkey — TrancheConfig.share_mint (the junior share token)
const OFF_EARLY_UNSTAKE_FEE_BPS = 120; // u16
const OFF_LOW_STAKE_THRESHOLD_BPS = 124; // u16
const OFF_LOW_STAKE_FEE_BPS = 126; // u16
const OFF_LOW_STAKE_FEE_ENABLED = 142; // u8 (PodBool)
const OFF_VIRTUAL_VALUE = 264; // u64 — TrancheAccounting.virtual_value
const OFF_SHARE_PRICE = 288; // u64 — TrancheAccounting.share_price
// BankState absolute byte offsets (8-byte Anchor discriminator included).
const OFF_IS_HALTED = 152; // u8 (PodBool)
const OFF_IS_HALTED_DEPOSIT = 153; // u8 (PodBool)
const OFF_IS_HALTED_WITHDRAWAL = 154; // u8 (PodBool)
const OFF_YIELDING_TVL = 192; // u64 — BankAccounting.yielding_tvl
const OFF_BANK_MINT_PRICE = 352; // u64 — BankMint.price
// SPL token account (Tokenkeg and Token-2022): amount u64 LE @64.
const SPL_AMOUNT_OFFSET = 64;
const U64_MAX = (1n << 64n) - 1n;
const WAD = 1000000n; // both bankPrice and sharePrice are 6-decimal-normalized
function readUintLE(data, offset, width) {
    if (offset + width > data.length)
        throw new Error('perena-star: truncated account data');
    let v = 0n;
    for (let i = width - 1; i >= 0; i--)
        v = (v << 8n) | BigInt(data[offset + i]);
    return v;
}
function perenaStarConfig(base) {
    if (base.venue !== 'perena-star')
        throw new Error(`perena-star adapter got a '${base.venue}' pool config`);
    return base;
}
async function fetchPerenaStarPoolConfig(load, pool) {
    const decoder = getAddressDecoder();
    const pubkey = (data, offset) => decoder.decode(data.subarray(offset, offset + 32));
    const trancheData = await load(pool);
    if (trancheData === null)
        throw new Error(`perena-star tranche ${pool} not found`);
    if (trancheData.length !== TRANCHE_STATE_SIZE) {
        throw new Error(`perena-star tranche ${pool} data is ${trancheData.length} bytes, expected ${TRANCHE_STATE_SIZE}`);
    }
    for (let i = 0; i < 8; i++) {
        if (trancheData[i] !== TRANCHE_STATE_DISCRIMINATOR[i]) {
            throw new Error(`perena-star tranche ${pool} has a wrong discriminator (not a TrancheState account)`);
        }
    }
    const bank = pubkey(trancheData, OFF_TRANCHE_BANK);
    const bankMint = pubkey(trancheData, OFF_MINT);
    const juniorMint = pubkey(trancheData, OFF_SHARE_MINT);
    const bankData = await load(bank);
    if (bankData === null)
        throw new Error(`perena-star bank ${bank} not found`);
    if (bankData.length !== BANK_STATE_SIZE) {
        throw new Error(`perena-star bank ${bank} data is ${bankData.length} bytes, expected ${BANK_STATE_SIZE}`);
    }
    for (let i = 0; i < 8; i++) {
        if (bankData[i] !== BANK_STATE_DISCRIMINATOR[i]) {
            throw new Error(`perena-star bank ${bank} has a wrong discriminator (not a BankState account)`);
        }
    }
    const bankMintFromBank = pubkey(bankData, 320);
    if (bankMintFromBank !== bankMint) {
        throw new Error(`perena-star bank ${bank} mint ${bankMintFromBank} does not match tranche config mint ${bankMint}`);
    }
    const isHalted = readUintLE(bankData, OFF_IS_HALTED, 1) !== 0n;
    if (isHalted) {
        throw new Error(`perena-star tranche ${pool} is halted (BankStatus.is_halted, snapshot at fetch time)`);
    }
    const isHaltedDeposit = readUintLE(bankData, OFF_IS_HALTED_DEPOSIT, 1) !== 0n;
    const isHaltedWithdrawal = readUintLE(bankData, OFF_IS_HALTED_WITHDRAWAL, 1) !== 0n;
    const [escrowAta] = await findAssociatedTokenPda({ owner: pool, mint: bankMint, tokenProgram: TOKEN_PROGRAM });
    const [lockedSharesAta] = await findAssociatedTokenPda({ owner: pool, mint: juniorMint, tokenProgram: TOKEN_PROGRAM });
    return {
        venue: 'perena-star',
        pool,
        bank,
        bankMint,
        juniorMint,
        escrowAta,
        lockedSharesAta,
        isHaltedDeposit,
        isHaltedWithdrawal,
        direction: 'stake',
    };
}
export const perenaStar = {
    slug: 'perena-star',
    programId: PERENA_STAR_PROGRAM_ID,
    fetchPoolConfig: fetchPerenaStarPoolConfig,
};
// ---------------------------------------------------------------------------
// Ladder (fragment emission + reference mirror)
// ---------------------------------------------------------------------------
const ref = (slot, role) => `s${slot}:${role}`;
function bytesOf(state, addr) {
    const data = state[addr];
    if (data === undefined)
        throw new Error(`perena-star ladder reference is missing account ${addr}`);
    return data;
}
function liveState(cfg, state) {
    const tranche = bytesOf(state, cfg.pool);
    const bank = bytesOf(state, cfg.bank);
    const sharePrice = readUintLE(tranche, OFF_SHARE_PRICE, 8);
    const bankPrice = readUintLE(bank, OFF_BANK_MINT_PRICE, 8);
    const isHalted = readUintLE(bank, OFF_IS_HALTED, 1) !== 0n;
    if (cfg.direction === 'stake') {
        const isHaltedDeposit = readUintLE(bank, OFF_IS_HALTED_DEPOSIT, 1) !== 0n;
        const cap = isHalted || isHaltedDeposit || sharePrice === 0n || bankPrice === 0n ? 0n : U64_MAX;
        return { sharePrice, bankPrice, feeBps: 0n, cap };
    }
    const isHaltedWithdrawal = readUintLE(bank, OFF_IS_HALTED_WITHDRAWAL, 1) !== 0n;
    const virtualValue = readUintLE(tranche, OFF_VIRTUAL_VALUE, 8);
    const yieldingTvl = readUintLE(bank, OFF_YIELDING_TVL, 8);
    const earlyFeeBps = readUintLE(tranche, OFF_EARLY_UNSTAKE_FEE_BPS, 2);
    const lowStakeFeeBps = readUintLE(tranche, OFF_LOW_STAKE_FEE_BPS, 2);
    const lowStakeThresholdBps = readUintLE(tranche, OFF_LOW_STAKE_THRESHOLD_BPS, 2);
    const lowStakeFeeEnabled = readUintLE(tranche, OFF_LOW_STAKE_FEE_ENABLED, 1) !== 0n;
    let feeBps = earlyFeeBps;
    if (lowStakeFeeEnabled && lowStakeThresholdBps > 0n && virtualValue * 10000n < yieldingTvl * lowStakeThresholdBps) {
        feeBps = lowStakeFeeBps;
    }
    if (isHalted || isHaltedWithdrawal || sharePrice === 0n || bankPrice === 0n) {
        return { sharePrice, bankPrice, feeBps, cap: 0n };
    }
    const escrow = bytesOf(state, cfg.escrowAta);
    const escrowBalance = readUintLE(escrow, SPL_AMOUNT_OFFSET, 8);
    // Conservative capacity (see module header): fee-free upper bound on the
    // shares the escrow can ever cover, so a fully-filled slot never asks for
    // more than the escrow really holds.
    const cap = (escrowBalance * bankPrice) / sharePrice;
    return { sharePrice, bankPrice, feeBps, cap };
}
function quoteAt(cfg, s, x) {
    const cx = x > s.cap ? s.cap : x;
    if (cx <= 0n)
        return 0n;
    if (cfg.direction === 'stake') {
        const value = (cx * s.bankPrice) / WAD;
        return (value * WAD) / s.sharePrice;
    }
    const gross = (cx * s.sharePrice) / WAD;
    const fee = (gross * s.feeBps) / 10000n;
    const net = gross - fee;
    return (net * WAD) / s.bankPrice;
}
export const perenaStarLadder = {
    slug: 'perena-star',
    // Exactly affine in x for a fixed live state (no curvature) up to the
    // capacity clamp — a straight line loses nothing to the framework floor.
    defaultRungs: 2,
    shapeKey(base) {
        return `perena-star:${perenaStarConfig(base).direction}`;
    },
    helpers() {
        return [];
    },
    paramCount: 0,
    paramsFor() {
        return [];
    },
    quoteRefs(base, slot) {
        const cfg = perenaStarConfig(base);
        const refs = [
            { ref: ref(slot, 'tranche'), address: cfg.pool },
            { ref: ref(slot, 'bank'), address: cfg.bank },
        ];
        if (cfg.direction === 'unstake')
            refs.push({ ref: ref(slot, 'escrow'), address: cfg.escrowAta });
        return refs;
    },
    emitSetup(base, slot) {
        const cfg = perenaStarConfig(base);
        const p = `s${slot}`;
        const tranche = JSON.stringify(ref(slot, 'tranche'));
        const bank = JSON.stringify(ref(slot, 'bank'));
        const lines = [
            `  const ${p}sp = accountUint(${tranche}, ${OFF_SHARE_PRICE}, 8);`,
            `  const ${p}bp = accountUint(${bank}, ${OFF_BANK_MINT_PRICE}, 8);`,
            `  const ${p}ih = accountUint(${bank}, ${OFF_IS_HALTED}, 1);`,
        ];
        if (cfg.direction === 'stake') {
            lines.push(`  const ${p}ihd = accountUint(${bank}, ${OFF_IS_HALTED_DEPOSIT}, 1);`, `  let ${p}cap = ${U64_MAX};`, `  if (${p}sp === 0 || ${p}bp === 0) { ${p}cap = 0 }`, `  if (${p}ih !== 0) { ${p}cap = 0 }`, `  if (${p}ihd !== 0) { ${p}cap = 0 }`);
        }
        else {
            const escrow = JSON.stringify(ref(slot, 'escrow'));
            lines.push(`  const ${p}ihw = accountUint(${bank}, ${OFF_IS_HALTED_WITHDRAWAL}, 1);`, `  const ${p}vv = accountUint(${tranche}, ${OFF_VIRTUAL_VALUE}, 8);`, `  const ${p}tvl = accountUint(${bank}, ${OFF_YIELDING_TVL}, 8);`, `  const ${p}efb = accountUint(${tranche}, ${OFF_EARLY_UNSTAKE_FEE_BPS}, 2);`, `  const ${p}lsb = accountUint(${tranche}, ${OFF_LOW_STAKE_FEE_BPS}, 2);`, `  const ${p}ltb = accountUint(${tranche}, ${OFF_LOW_STAKE_THRESHOLD_BPS}, 2);`, `  const ${p}lse = accountUint(${tranche}, ${OFF_LOW_STAKE_FEE_ENABLED}, 1);`, `  let ${p}fee = ${p}efb;`, `  if (${p}lse !== 0 && ${p}ltb > 0) {`, `    if (${p}vv * 10000 < ${p}tvl * ${p}ltb) { ${p}fee = ${p}lsb }`, `  }`, `  let ${p}cap = 0;`, `  if (${p}sp !== 0 && ${p}bp !== 0 && ${p}ih === 0 && ${p}ihw === 0) {`, `    const ${p}esc = accountUint(${escrow}, ${SPL_AMOUNT_OFFSET}, 8);`, `    ${p}cap = Math.mulDiv(${p}esc, ${p}bp, ${p}sp);`, `  }`);
        }
        lines.push(`  let ${p}cx = 0;`);
        return lines.join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}cx`;
    },
    emitLadderQuote(base, slot, _rung, x, outVar) {
        const cfg = perenaStarConfig(base);
        const p = `s${slot}`;
        const lines = [`    ${p}cx = ${x};`, `    if (${p}cx > ${p}cap) { ${p}cx = ${p}cap }`, `    let ${outVar} = 0;`];
        if (cfg.direction === 'stake') {
            lines.push(`    if (${p}cx > 0) {`, `      const ${p}v = Math.mulDiv(${p}cx, ${p}bp, ${WAD});`, `      ${outVar} = Math.mulDiv(${p}v, ${WAD}, ${p}sp);`, `    }`);
        }
        else {
            lines.push(`    if (${p}cx > 0) {`, `      const ${p}g = Math.mulDiv(${p}cx, ${p}sp, ${WAD});`, `      const ${p}f = Math.mulDiv(${p}g, ${p}fee, 10000);`, `      ${outVar} = Math.mulDiv(${p}g - ${p}f, ${WAD}, ${p}bp);`, `    }`);
        }
        return lines.join('\n');
    },
    emitFinalQuote(base, slot, x, outVar) {
        const cfg = perenaStarConfig(base);
        const p = `s${slot}`;
        const lines = [`  let ${p}ffx = ${x};`, `  if (${p}ffx > ${p}cap) { ${p}ffx = ${p}cap }`, `  let ${outVar} = 0;`];
        if (cfg.direction === 'stake') {
            lines.push(`  if (${p}ffx > 0) {`, `    const ${p}fv = Math.mulDiv(${p}ffx, ${p}bp, ${WAD});`, `    ${outVar} = Math.mulDiv(${p}fv, ${WAD}, ${p}sp);`, `  }`);
        }
        else {
            lines.push(`  if (${p}ffx > 0) {`, `    const ${p}fg = Math.mulDiv(${p}ffx, ${p}sp, ${WAD});`, `    const ${p}ff = Math.mulDiv(${p}fg, ${p}fee, 10000);`, `    ${outVar} = Math.mulDiv(${p}fg - ${p}ff, ${WAD}, ${p}bp);`, `  }`);
        }
        return lines.join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = perenaStarConfig(base);
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        if (cfg.direction === 'stake') {
            const accounts = [
                { ref: user.owner, signer: true, writable: true },
                roled('tranche', cfg.pool, true),
                roled('bank', cfg.bank),
                roled('bankMint', cfg.bankMint),
                roled('juniorMint', cfg.juniorMint, true),
                { ref: user.inAta, writable: true }, // user_bank_mint_ata
                { ref: user.outAta, writable: true }, // user_junior_mint_ata
                roled('escrow', cfg.escrowAta, true),
                roled('systemProgram', SYSTEM_PROGRAM),
                roled('tokenProgram', TOKEN_PROGRAM),
                roled('associatedTokenProgram', ASSOCIATED_TOKEN_PROGRAM),
            ];
            return {
                programId: PERENA_STAR_PROGRAM_ID,
                prefix: STAKE_JUNIOR_DISCRIMINATOR,
                suffix: Uint8Array.from([]),
                patch: 'in',
                accounts,
            };
        }
        const accounts = [
            { ref: user.owner, signer: true },
            roled('tranche', cfg.pool, true),
            roled('bank', cfg.bank, true),
            roled('bankMint', cfg.bankMint, true),
            roled('targetMint', cfg.bankMint), // target_mint = bank_mint (the "plain" redemption case, no yielding-mint detour)
            roled('juniorMint', cfg.juniorMint, true),
            { ref: user.inAta, writable: true }, // user_junior_mint_ata
            { ref: user.outAta, writable: true }, // owner_bank_mint_ata
            roled('escrow', cfg.escrowAta, true),
            roled('lockedShares', cfg.lockedSharesAta, true),
            roled('tokenProgram', TOKEN_PROGRAM),
            // 8 trailing optional accounts (yielding-mint conversion detour, unused
            // here): the program's OWN id is Anchor's "None" sentinel for each —
            // see module header's ACCOUNTS section for the live-simulated proof.
            roled('optVaultState', PERENA_STAR_PROGRAM_ID),
            roled('optVaultOracleState', PERENA_STAR_PROGRAM_ID),
            roled('optVaultTeamState', PERENA_STAR_PROGRAM_ID),
            roled('optYieldingMint', PERENA_STAR_PROGRAM_ID),
            roled('optYieldingVaultAta', PERENA_STAR_PROGRAM_ID),
            roled('optOwnerYieldingTa', PERENA_STAR_PROGRAM_ID),
            roled('optVaultFeeTeamAta', PERENA_STAR_PROGRAM_ID),
            roled('optYieldingMintProgram', PERENA_STAR_PROGRAM_ID),
        ];
        return {
            programId: PERENA_STAR_PROGRAM_ID,
            prefix: INSTANT_UNSTAKE_JUNIOR_DISCRIMINATOR,
            suffix: Uint8Array.from([]),
            patch: 'in',
            accounts,
        };
    },
    referenceQuote(base, state) {
        const cfg = perenaStarConfig(base);
        const s = liveState(cfg, state);
        return (x) => quoteAt(cfg, s, x);
    },
    referenceCapacities(base, state) {
        const cfg = perenaStarConfig(base);
        const s = liveState(cfg, state);
        return (grid) => grid.map((g) => (g > s.cap ? s.cap : g));
    },
    depthReserves(base, state) {
        const cfg = perenaStarConfig(base);
        const s = liveState(cfg, state);
        if (cfg.direction === 'unstake') {
            // Real, exact: the escrow's own live balance is the true payout capacity.
            const escrow = bytesOf(state, cfg.escrowAta);
            return { reserveIn: s.cap, reserveOut: readUintLE(escrow, SPL_AMOUNT_OFFSET, 8) };
        }
        // STAKE is genuinely uncapped pool-side — yieldingTvl (the bank's own
        // scale) is a SIZE PROXY for relative-depth ranking, not a hard cap,
        // same convention as sanctum-stake-pool's deposit-side depth.
        const bank = bytesOf(state, cfg.bank);
        const yieldingTvl = readUintLE(bank, OFF_YIELDING_TVL, 8);
        const potentialShares = s.sharePrice > 0n ? (yieldingTvl * s.bankPrice) / s.sharePrice : 0n;
        return { reserveIn: yieldingTvl, reserveOut: potentialShares };
    },
    continuousFees(base, state) {
        const cfg = perenaStarConfig(base);
        const s = liveState(cfg, state);
        if (cfg.direction === 'stake')
            return { gammaPpm: 1000000n, muPpm: 1000000n };
        let mu = 1000000n - s.feeBps * 100n;
        if (mu < 0n)
            mu = 0n;
        return { gammaPpm: 1000000n, muPpm: mu };
    },
};
//# sourceMappingURL=index.js.map