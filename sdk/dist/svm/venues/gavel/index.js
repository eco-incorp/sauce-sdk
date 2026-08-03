/**
 * Gavel / "Plasma" (Ellipsis Labs sr-AMM, program `srAMMzfVHVAtgSJc8iH6CfKzuWuUTzLHVCE81QU1rgi`) —
 * a sandwich-resistant constant-product AMM. This is NOT a CLOB: the whole
 * pool state (a fixed-size `PoolAccount`, no dynamic order book) fits one
 * account, so the quote is fully closed-form and needs no off-chain-shipped
 * window/levels at all.
 *
 * SOURCE: the program is OPEN-SOURCE, BUSL-1.1-licensed
 * (github.com/Ellipsis-Labs/plasma, verified build deployed at the program id
 * above per Ellipsis Labs' own "Introducing Gavel"/"Introducing Plasma" posts
 * and the Helius "Solana's Proprietary AMM Revolution" writeup) — every
 * offset and formula below is TRANSCRIBED from `crates/plasma_state/src/
 * {accounts,amm}.rs`, not reverse-engineered, and cross-verified against a
 * REAL mainnet pool (`CcWf5D6BhUTv2tD4ebFFcmCdTUgBWMc8CqqoJvFHGGXi`, the
 * IBRL/wSOL launch pool referenced in Ellipsis Labs' own "IBRL" test-coin
 * writeup): the discriminator decoded to the pinned constant below,
 * base/quote decimals (6/9) and mints matched the real IBRL/wSOL pair, and
 * quotes at 4 sizes each way matched the REAL `plasma-amm-state` crate's own
 * `Amm::simulate_{buy,sell}_exact_in` bit-for-bit (built from the cloned repo
 * via `cargo build`, fed the live dumped account bytes — see the "sr-AMM
 * healing" section below for why this crate-level check, not a
 * `simulateTransaction`, is the strongest available verification: the crate
 * needs no trader/vault accounts to exercise, and it IS the real program's
 * logic, not a re-implementation of it).
 *
 * ── Account layout (`PoolHeader` + `Amm`, `#[repr(C)]` + `bytemuck::Pod`,
 *    cast directly from account bytes at offset 0 — `initialize.rs`'s
 *    `try_from_bytes_mut::<PoolAccount>(&mut pool_bytes)`, no prefix) ──
 *
 * `PoolHeader`: discriminator([u8;8])@0, sequence_number(u64)@8,
 * base_params(TokenParams)@16, quote_params(TokenParams)@88,
 * fee_recipients(ProtocolFeeRecipients, 264 bytes)@160,
 * swap_sequence_number(u64)@424, padding@432 — 528 bytes total.
 * `TokenParams` (72 bytes): decimals(u32)@0, vault_bump(u32)@4,
 * mint_key(Pubkey)@8, vault_key(Pubkey)@40.
 * `Amm` starts at 528 (528 % 16 == 0, so this holds regardless of the
 * platform alignment of the `I80F48`/`i128` `reward_factor` field):
 * fee_in_bps(u32)@528, protocol_allocation_in_pct(u32)@532,
 * lp_vesting_window(u64)@536, reward_factor(i128)@544, total_lp_shares(u64)@560,
 * slot_snapshot(u64)@568, base_reserves_snapshot(u64)@576,
 * quote_reserves_snapshot(u64)@584, base_reserves(u64)@592,
 * quote_reserves(u64)@600, cumulative_quote_lp_fees(u64)@608,
 * cumulative_quote_protocol_fees(u64)@616 — 624 bytes total (GAVEL_POOL_SIZE).
 * All offsets confirmed by decoding 112 real mainnet pools via
 * getProgramAccounts (memcmp on the discriminant + dataSize 624) and finding
 * sane fee_in_bps (25/30 bps)/reserves/decimals at every one.
 *
 * fee_in_bps is IMMUTABLE post-init (no admin instruction in
 * `PlasmaInstruction` mutates it — only `WithdrawProtocolFees`, a payout, and
 * `WithdrawLpFees`), so it is baked as a compile-time PARAM (like fluxbeam's
 * trade-fee numerators) rather than re-read live each trade.
 *
 * ── sr-AMM "healing" — a virtual, ONE-LEVEL limit order at the window's
 *    anchor price (amm.rs `get_limit_order_size_in_base_and_quote` +
 *    `buy_exact_in`/`sell_exact_in`) ──
 *
 * Every `Swap` instruction first calls (processor/swap.rs)
 * `let slot = Clock::get()?.slot; let snapshot_slot = (slot / LEADER_SLOT_WINDOW) * LEADER_SLOT_WINDOW;`
 * (`LEADER_SLOT_WINDOW = 4`, lib.rs) then `Amm::maybe_update_snapshot(snapshot_slot)`:
 * if `snapshot_slot > self.slot_snapshot` (a NEW 4-slot leader window since
 * this pool was last touched), the snapshot RESETS to the pool's own CURRENT
 * reserves (so the virtual level's size — see below — collapses to exactly
 * 0, a pure constant-product swap); otherwise (this pool already traded
 * within the SAME window) the STORED snapshot stays in force.
 *
 * When the stored snapshot differs from current reserves, one side carries a
 * virtual limit order priced EXACTLY at the snapshot's price ratio, sized so
 * consuming it exactly restores that ratio (the closed-form in
 * `get_limit_order_size_in_base_and_quote`'s doc comment). CRITICALLY — and
 * this inverts the naive intuition — the side that gets a virtual level is
 * whichever one trades AGAINST the direction the price has ALREADY moved
 * this window (a buyer gets an ask only when price has already DROPPED
 * — `quote_snapshot*base_reserves > base_snapshot*quote_reserves`, i.e.
 * snapshot price > current price — and it fills at that HIGHER, WORSE-for-
 * the-buyer snapshot price; symmetrically a seller's bid only appears when
 * price has RISEN and fills at the LOWER, WORSE-for-the-seller snapshot
 * price). This is NOT a "the taker always benefits" mechanism: it is a
 * "trade back toward the window's anchor price regardless of who benefits"
 * mechanism, and its actual anti-sandwich effect is neutralizing a would-be
 * attacker's BACK-RUN leg (which sells back into a price the attacker's own
 * front-run inflated) — see the module-level measured example below.
 * PROVEN, not assumed: an EARLIER analysis in this exact investigation
 * assumed the opposite sign (that ignoring the level is a strictly
 * CONSERVATIVE approximation) and was REFUTED by a controlled scenario
 * before it shipped — a same-window SELL then BUY (or BUY then SELL)
 * measured the real crate returning STRICTLY LESS than a plain
 * current-reserves constant-product quote for the same input (e.g. a
 * same-window sell of 30_000_000_000 lowering price, then a 2_000_000_000
 * buy: real crate 174,752,288,804 base out vs 175,499,103,175 if the level
 * were ignored) — so a "just use current reserves" shortcut would be a
 * FAVORABLE ERROR (over-promising), exactly the class of bug this repo's
 * integration policy calls a liveness hazard. This module therefore
 * implements the FULL two-piece close (virtual level + constant-product
 * tail), not an approximation, and both branches are validated bit-for-bit
 * against the real `plasma-amm-state` crate (see the module doc above and
 * `test/svm/venues/gavel.test.ts`).
 *
 * WHY THIS IS COMPUTABLE ON-CHAIN WITHOUT A SHIPPED WINDOW (unlike
 * manifest/phoenix's order books): `slot_snapshot` / `*_reserves_snapshot` /
 * `base_reserves` / `quote_reserves` are all FIXED-OFFSET fields on the ONE
 * pool account already being read — no tree walk. The one missing datum
 * (`Clock::get()?.slot`, the LIVE current slot) is read via SauceScript's
 * `block.number`, which the SVM engine profile documents as having a
 * fork-parity analog for every EVM chain op (compiler/dist/saucer/
 * svm-profile.js) — EMPIRICALLY CONFIRMED here (not merely trusted from that
 * comment) by compiling `function main(){ return abi.encode(block.number,
 * block.timestamp) }` for target 'svm' and executing it on the real engine.so
 * inside a LiteSVM harness pinned via `svm.warpToSlot(1000)` +
 * `svm.setClock(new Clock(1000, 0n, 0n, 0n, 12345n))`: it returned
 * `(1000, 12345)` — `block.number` is exactly the Solana slot, `block.timestamp`
 * exactly the Clock's unix_timestamp, independently steerable (the SAME
 * mechanism `solfi-v2` already established for its own live-slot read — see
 * `the consuming app cu e2e test`'s `SOLFI_SLOT` comment). So `referenceQuote`'s
 * `now` parameter, for THIS family, is the CURRENT SLOT (not a unix
 * timestamp) — the same convention solfi-v2 set; `now` absent defaults to 0n
 * (same as solfi-v2), which — since a real `slot_snapshot` is always > 0
 * once a pool has ever swapped — takes the "trust the stored snapshot"
 * branch, never the reset.
 *
 * ── Swap CPI (`PlasmaInstruction::Swap` = 0, instruction.rs) ──
 *
 * Accounts (shank-declared): [0] `plasma_program` (this program's own id,
 * readonly — self-CPI for event logging, the same idiom manifest/phoenix
 * use), [1] `log_authority` (readonly PDA seeds=[b"log"], hardcoded in
 * lib.rs as `37zgQb6PjFuxah6R8CTk67gEvLrpqPQ61E7vh9ARPGFD` and asserted there
 * by a `check_pda` test), [2] `pool` (writable), [3] `trader` (signer, NOT
 * writable), [4] `base_account` (trader's, writable), [5] `quote_account`
 * (trader's, writable), [6] `base_vault` (writable), [7] `quote_vault`
 * (writable), [8] `token_program`. `token_program` is HARDCODED to
 * `spl_token::id()` in every account loader in this program
 * (validation/loaders.rs) — classic-Tokenkeg only, no Token-2022 path exists,
 * so (unlike fluxbeam) mints are gated to exactly 82 bytes with no
 * SOUND-vs-heuristic ambiguity.
 *
 * Data: ONE leading instruction-selector byte (`PlasmaInstruction::Swap as
 * u8` = 0 — easy to miss since `Swap`'s own variant tag is ALSO 0, but it is
 * a separate byte the entrypoint's dispatch consumes before `SwapParams` is
 * even parsed; a real-CPI run without it dispatched into `AddLiquidity`,
 * `PlasmaInstruction::to_vec`'s `vec![*self as u8]` confirms the shape) then
 * Borsh `SwapParams { side: Side, swap_type: SwapType }` — `Side` is a unit
 * enum (`Buy=0, Sell=1` by declaration order in amm.rs), `SwapType` an enum
 * whose `ExactIn{amount_in: u64, min_amount_out: u64}` variant is tag 0
 * (declaration order in processor/swap.rs). Full wire: `[ix tag=0 (Swap)]
 * [side u8][swap_type tag=0 u8][amount_in u64 LE (patched)][min_amount_out
 * u64 LE = 1]` — venue-level min_out is 1, the recipe's own terminal outAta
 * delta check is the real floor (the solswap/manifest/phoenix discipline).
 * PROVEN against the real dumped mainnet binary, not just this transcription
 * — see `the consuming app realcpi e2e test`'s `gavel` quadrilateral.
 */
import { address, getAddressCodec } from '@solana/kit';
import { readUintLE } from '../math.js';
const SLUG = 'gavel';
export const GAVEL_PROGRAM_ID = address('srAMMzfVHVAtgSJc8iH6CfKzuWuUTzLHVCE81QU1rgi');
/** plasma_log_authority::ID — static PDA seeds=[b"log"] (plasma/src/lib.rs). */
const GAVEL_LOG_AUTHORITY = address('37zgQb6PjFuxah6R8CTk67gEvLrpqPQ61E7vh9ARPGFD');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** u64 LE @0 — accounts.rs POOL_ACCOUNT_DISCRIMINATOR ([116,210,187,119,196,196,52,137]). */
export const GAVEL_POOL_DISCRIMINANT = 9886743430086513268n;
/** PoolHeader (528) + Amm (96) — bytemuck::Pod, cast at offset 0, no prefix. */
export const GAVEL_POOL_SIZE = 624;
/** processor/swap.rs / lib.rs — the sr-AMM snapshot rotates every 4 slots (~1.6-2s). */
export const GAVEL_LEADER_SLOT_WINDOW = 4n;
const OFF_BASE_DECIMALS = 16;
const OFF_BASE_MINT = 24;
const OFF_BASE_VAULT = 56;
const OFF_QUOTE_DECIMALS = 88;
const OFF_QUOTE_MINT = 96;
const OFF_QUOTE_VAULT = 128;
const OFF_FEE_IN_BPS = 528;
const OFF_TOTAL_LP_SHARES = 560;
const OFF_SLOT_SNAPSHOT = 568;
const OFF_BASE_RESERVES_SNAPSHOT = 576;
const OFF_QUOTE_RESERVES_SNAPSHOT = 584;
const OFF_BASE_RESERVES = 592;
const OFF_QUOTE_RESERVES = 600;
function decodeAddress(data, offset) {
    return getAddressCodec().decode(data.subarray(offset, offset + 32));
}
/**
 * Fetch + gate one Gavel/Plasma pool: discriminant + size, a live LP-share /
 * reserve liveness gate (mirrors every other family's "one bad pool never
 * kills a cook" self-drop), and classic-SPL-only mints (the program's own
 * token_program is hardcoded to Tokenkeg — see the module header).
 */
export async function fetchGavelConfig(load, pool) {
    const data = await load(pool);
    if (data === null)
        throw new Error(`${SLUG}: pool ${pool} account not found`);
    if (data.length !== GAVEL_POOL_SIZE) {
        throw new Error(`${SLUG}: pool ${pool} must be ${GAVEL_POOL_SIZE} bytes (PoolHeader+Amm), got ${data.length}`);
    }
    if (readUintLE(data, 0, 8) !== GAVEL_POOL_DISCRIMINANT) {
        throw new Error(`${SLUG}: pool ${pool} has a foreign discriminator (not a Gavel PoolAccount)`);
    }
    const totalLpShares = readUintLE(data, OFF_TOTAL_LP_SHARES, 8);
    const baseReserves = readUintLE(data, OFF_BASE_RESERVES, 8);
    const quoteReserves = readUintLE(data, OFF_QUOTE_RESERVES, 8);
    if (totalLpShares <= 0n || baseReserves <= 0n || quoteReserves <= 0n) {
        throw new Error(`${SLUG}: pool ${pool} is uninitialized or drained (lpShares=${totalLpShares}, base=${baseReserves}, quote=${quoteReserves})`);
    }
    const baseMint = decodeAddress(data, OFF_BASE_MINT);
    const quoteMint = decodeAddress(data, OFF_QUOTE_MINT);
    // The Swap ix's token_program is hardcoded to spl_token::id() in every
    // loader (validation/loaders.rs) — Tokenkeg-only, so any mint longer than
    // the classic 82 bytes cannot actually be swapped here.
    for (const mint of [baseMint, quoteMint]) {
        const mintData = await load(mint);
        if (mintData === null)
            throw new Error(`${SLUG}: mint ${mint} of pool ${pool} not found`);
        if (mintData.length !== 82) {
            throw new Error(`${SLUG}: pool ${pool} mint ${mint} is not a classic SPL mint (Gavel's Swap is Tokenkeg-only)`);
        }
    }
    return {
        venue: SLUG,
        pool,
        direction: 'baseIn',
        baseMint,
        quoteMint,
        baseVault: decodeAddress(data, OFF_BASE_VAULT),
        quoteVault: decodeAddress(data, OFF_QUOTE_VAULT),
        baseDecimals: Number(readUintLE(data, OFF_BASE_DECIMALS, 4)),
        quoteDecimals: Number(readUintLE(data, OFF_QUOTE_DECIMALS, 4)),
        feeInBps: readUintLE(data, OFF_FEE_IN_BPS, 4),
    };
}
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter, not in the v1 registry). */
export const gavel = {
    slug: SLUG,
    programId: GAVEL_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM,
    fetchPoolConfig: fetchGavelConfig,
};
function gavelConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
// ---------------------------------------------------------------------------
// TS mirror of the emitted two-piece quote (virtual level + CP tail) — see
// the module header for the derivation and its bit-exact validation against
// the real plasma-amm-state crate.
// ---------------------------------------------------------------------------
function gavelBuy(x, vld, br, qr, bs, qs, fee) {
    if (vld === 0n || x === 0n)
        return 0n;
    const f = (x * fee) / 10000n;
    const pf = x - f;
    if (pf === 0n)
        return 0n;
    let sq = 0n;
    let sb = 0n;
    if (qs * br > bs * qr) {
        sq = (qs * br - bs * qr) / (2n * bs);
        sb = (sq * bs) / qs;
    }
    if (sq >= pf)
        return (pf * bs) / qs;
    const nb = br - sb;
    const nq = qr + sq;
    const qp = pf - sq;
    const k = nb * nq - 1n;
    const bp = nb - (k / (nq + qp) + 1n);
    return sb + bp;
}
function gavelSell(x, vld, br, qr, bs, qs, fee) {
    if (vld === 0n || x === 0n)
        return 0n;
    let sb = 0n;
    let sq = 0n;
    if (bs * qr > qs * br) {
        sb = (bs * qr - qs * br) / (2n * qs);
        sq = (sb * qs) / bs;
    }
    if (sb >= x) {
        const pf = (x * qs) / bs;
        const fe = (pf * fee) / 10000n;
        return pf - fe;
    }
    const feBid = (sq * fee) / 10000n;
    const qBid = sq - feBid;
    const nb = br + sb;
    const nq = qr - sq;
    const bp = x - sb;
    const k = nb * nq - 1n;
    const qpPre = nq - (k / (nb + bp) + 1n);
    const fePool = (qpPre * fee) / 10000n;
    const qPool = qpPre - fePool;
    return qBid + qPool;
}
/** (baseReservesSnapshotEff, quoteReservesSnapshotEff) per the module header's window rule. */
function effectiveSnapshot(br, qr, storedSlot, storedBs, storedQs, nowSlot) {
    const snapSlot = (nowSlot / GAVEL_LEADER_SLOT_WINDOW) * GAVEL_LEADER_SLOT_WINDOW;
    return snapSlot > storedSlot ? { bs: br, qs: qr } : { bs: storedBs, qs: storedQs };
}
export const gavelLadder = {
    slug: SLUG,
    shapeKey(base) {
        return `${SLUG}:${gavelConfig(base).direction}`;
    },
    helpers() {
        return [
            {
                name: 'qGavelBuy',
                source: [
                    'function qGavelBuy(x, vld, br, qr, bs, qs, fee) {',
                    '  if (vld === 0) { return 0 }',
                    '  if (x === 0) { return 0 }',
                    '  const f = (x * fee) / 10000;',
                    '  const pf = x - f;',
                    '  if (pf === 0) { return 0 }',
                    '  let sq = 0;',
                    '  let sb = 0;',
                    '  if (qs * br > bs * qr) {',
                    '    sq = (qs * br - bs * qr) / (2 * bs);',
                    '    sb = (sq * bs) / qs;',
                    '  }',
                    '  if (sq >= pf) { return (pf * bs) / qs }',
                    '  const nb = br - sb;',
                    '  const nq = qr + sq;',
                    '  const qp = pf - sq;',
                    '  const k = nb * nq - 1;',
                    '  const bp = nb - (k / (nq + qp) + 1);',
                    '  return sb + bp;',
                    '}',
                ].join('\n'),
            },
            {
                name: 'qGavelSell',
                source: [
                    'function qGavelSell(x, vld, br, qr, bs, qs, fee) {',
                    '  if (vld === 0) { return 0 }',
                    '  if (x === 0) { return 0 }',
                    '  let sb = 0;',
                    '  let sq = 0;',
                    '  if (bs * qr > qs * br) {',
                    '    sb = (bs * qr - qs * br) / (2 * qs);',
                    '    sq = (sb * qs) / bs;',
                    '  }',
                    '  if (sb >= x) {',
                    '    const pf = (x * qs) / bs;',
                    '    const fe = (pf * fee) / 10000;',
                    '    return pf - fe;',
                    '  }',
                    '  const feBid = (sq * fee) / 10000;',
                    '  const qBid = sq - feBid;',
                    '  const nb = br + sb;',
                    '  const nq = qr - sq;',
                    '  const bp = x - sb;',
                    '  const k = nb * nq - 1;',
                    '  const qpPre = nq - (k / (nb + bp) + 1);',
                    '  const fePool = (qpPre * fee) / 10000;',
                    '  const qPool = qpPre - fePool;',
                    '  return qBid + qPool;',
                    '}',
                ].join('\n'),
            },
        ];
    },
    /** [feeInBps] — immutable post-init, baked at compile time. */
    paramCount: 1,
    paramsFor(base) {
        return [gavelConfig(base).feeInBps];
    },
    quoteRefs(base, slot) {
        return [{ ref: ref(slot, 'pool'), address: gavelConfig(base).pool }];
    },
    emitSetup(_base, slot, params, enableVar) {
        const p = `s${slot}`;
        const enabled = enableVar ?? `${p}en`;
        const poolRef = JSON.stringify(ref(slot, 'pool'));
        return [
            `  let ${p}lp = 0;`,
            `  let ${p}br = 0;`,
            `  let ${p}qr = 0;`,
            `  let ${p}bs = 0;`,
            `  let ${p}qs = 0;`,
            `  if (${enabled} !== 0) {`,
            `    ${p}lp = accountUint(${poolRef}, ${OFF_TOTAL_LP_SHARES}, 8);`,
            `    ${p}br = accountUint(${poolRef}, ${OFF_BASE_RESERVES}, 8);`,
            `    ${p}qr = accountUint(${poolRef}, ${OFF_QUOTE_RESERVES}, 8);`,
            `    const ${p}stSlot = accountUint(${poolRef}, ${OFF_SLOT_SNAPSHOT}, 8);`,
            `    const ${p}stBs = accountUint(${poolRef}, ${OFF_BASE_RESERVES_SNAPSHOT}, 8);`,
            `    const ${p}stQs = accountUint(${poolRef}, ${OFF_QUOTE_RESERVES_SNAPSHOT}, 8);`,
            // Clock::get()?.slot's fork-parity analog on the SVM engine — see the
            // module header for the empirical proof this is the live Solana slot.
            `    const ${p}snap = (block.number / ${GAVEL_LEADER_SLOT_WINDOW}) * ${GAVEL_LEADER_SLOT_WINDOW};`,
            `    if (${p}snap > ${p}stSlot) { ${p}bs = ${p}br; ${p}qs = ${p}qr; }`,
            `    else { ${p}bs = ${p}stBs; ${p}qs = ${p}stQs; }`,
            `  }`,
            `  const ${p}fee = ${params[0]};`,
            `  let ${p}vld = 0;`,
            `  if (${p}lp > 0) { ${p}vld = 1; }`,
        ].join('\n');
    },
    emitQuoteCall(base, slot, x) {
        const cfg = gavelConfig(base);
        const p = `s${slot}`;
        const fn = cfg.direction === 'quoteIn' ? 'qGavelBuy' : 'qGavelSell';
        return `${fn}(${x}, ${p}vld, ${p}br, ${p}qr, ${p}bs, ${p}qs, ${p}fee)`;
    },
    buildSwapV2(base, slot, user) {
        const cfg = gavelConfig(base);
        const baseIn = cfg.direction === 'baseIn';
        // Data: [PlasmaInstruction tag=0 (Swap)][side u8: Buy=0/Sell=1][swap_type tag=0 (ExactIn)]
        //   <patched amount_in u64 LE> [min_amount_out u64 LE = 1]
        const prefix = Uint8Array.from([0, baseIn ? 1 : 0, 0]);
        const suffix = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: GAVEL_PROGRAM_ID,
            prefix,
            suffix,
            patch: 'in',
            accounts: [
                roled('prog', GAVEL_PROGRAM_ID),
                roled('log', GAVEL_LOG_AUTHORITY),
                roled('pool', cfg.pool, true),
                { ref: user.owner, signer: true },
                { ref: baseIn ? user.inAta : user.outAta, writable: true },
                { ref: baseIn ? user.outAta : user.inAta, writable: true },
                roled('bv', cfg.baseVault, true),
                roled('qv', cfg.quoteVault, true),
                roled('tp', TOKEN_PROGRAM),
            ],
        };
    },
    referenceQuote(base, state, params, now) {
        const cfg = gavelConfig(base);
        const data = state[cfg.pool];
        if (data === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
        const lp = readUintLE(data, OFF_TOTAL_LP_SHARES, 8);
        const br = readUintLE(data, OFF_BASE_RESERVES, 8);
        const qr = readUintLE(data, OFF_QUOTE_RESERVES, 8);
        const storedSlot = readUintLE(data, OFF_SLOT_SNAPSHOT, 8);
        const storedBs = readUintLE(data, OFF_BASE_RESERVES_SNAPSHOT, 8);
        const storedQs = readUintLE(data, OFF_QUOTE_RESERVES_SNAPSHOT, 8);
        const { bs, qs } = effectiveSnapshot(br, qr, storedSlot, storedBs, storedQs, now ?? 0n);
        const fee = params[0];
        const vld = lp > 0n ? 1n : 0n;
        return cfg.direction === 'quoteIn'
            ? (x) => gavelBuy(x, vld, br, qr, bs, qs, fee)
            : (x) => gavelSell(x, vld, br, qr, bs, qs, fee);
    },
    depthReserves(base, state) {
        const cfg = gavelConfig(base);
        const data = state[cfg.pool];
        if (data === undefined)
            throw new Error(`${SLUG} ladder depth is missing account ${cfg.pool}`);
        const br = readUintLE(data, OFF_BASE_RESERVES, 8);
        const qr = readUintLE(data, OFF_QUOTE_RESERVES, 8);
        return cfg.direction === 'baseIn' ? { reserveIn: br, reserveOut: qr } : { reserveIn: qr, reserveOut: br };
    },
    continuousFees(_base, _state, params) {
        const feeInBps = params[0];
        return { gammaPpm: 1000000n - feeInBps * 100n, muPpm: 1000000n };
    },
};
//# sourceMappingURL=index.js.map