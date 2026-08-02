/**
 * Phoenix CLOB adapter (EcoSwapSVM ladder fragment v2) — an order-book venue,
 * the SAME integration shape as the `manifest` family the SDK barrel already
 * ships (see `manifest`'s ladder for the sibling this file mirrors): the
 * quote is the venue's own taker IOC match, a best-first walk over resting
 * orders SHIPPED by `fetchPhoenixConfig` off-chain and verified LIVE in the
 * fragment. The SDK ships no `phoenix` ladder — this module is new, added
 * directly in this recipe (the established pattern for a venue the SDK
 * doesn't carry, see `ecoswap/svm/venues/humidifi.ts`/`tesserav.ts` on their
 * own branches).
 *
 * Phoenix has NO on-chain IDL registry entry, but its market layout is the
 * OPEN-SOURCE Ellipsis Labs `phoenix-v1` crate (github.com/Ellipsis-Labs/
 * phoenix-v1) plus its `sokoban` red-black-tree/node-allocator dependency
 * (github.com/Ellipsis-Labs/sokoban, published as `lib-sokoban`, pinned
 * `=0.3.0` by phoenix-v1's Cargo.toml) — transcribed below, not
 * reverse-engineered. Every offset, discriminant and formula is cited
 * against that source and cross-verified against a REAL mainnet SOL/USDC
 * market dump (`4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg`, 1,723,488
 * bytes — a "large" market-size tier): the discriminant decoded to
 * 8167313896524341111 (matches `phoenix-v1/src/program/accounts.rs`'s own
 * `check_discriminants` test), `base_mint`/`quote_mint` decoded to the real
 * WSOL/USDC mints, and three sample quotes (sell 1/10/50 SOL against the
 * live bid side) landed within a few bps of the live top-of-book price,
 * monotonically worsening with size — see `docs/phoenix-evidence.md`.
 *
 * ── Market account layout ──
 *
 * `MarketHeader` (accounts.rs), `#[repr(C)]`, 576 bytes (matches phoenix-sdk's
 * own MARKET_HEADER_SIZE convention): discriminant(u64)@0, status(u64)@8,
 * MarketSizeParams{bids_size,asks_size,num_seats: u64 each}@16 (24 bytes),
 * TokenParams (decimals:u32, vault_bump:u32, mint:Pubkey, vault:Pubkey — 72
 * bytes) `base_params`@40, `base_lot_size`(u64)@112, `quote_params`
 * (TokenParams)@120, `quote_lot_size`(u64)@192,
 * `tick_size_in_quote_atoms_per_base_unit`(u64)@200, authority(Pubkey)@208,
 * fee_recipient(Pubkey)@240, market_sequence_number(u64)@272,
 * successor(Pubkey)@280, raw_base_units_per_base_unit(u32)@312, padding to
 * 576. Immediately after the header, `FIFOMarket<TraderId,BIDS_SIZE,
 * ASKS_SIZE,NUM_SEATS>` (markets/fifo.rs): a 256-byte `_padding`, then
 * base_lots_per_base_unit(u64)@+256, tick_size_in_quote_lots_per_base_unit
 * (u64)@+264, order_sequence_number(u64)@+272, taker_fee_bps(u64)@+280,
 * collected_quote_lot_fees(u64)@+288, unclaimed_quote_lot_fees(u64)@+296,
 * then `bids`/`asks`/`traders` RedBlackTrees back to back — so EVERY field
 * up to and including the start of `bids` sits at a MARKET-INVARIANT
 * absolute offset (576+256+48 = 880), regardless of BIDS_SIZE/ASKS_SIZE
 * (those only affect how big the bids/asks regions ARE, never where they
 * START). Only the `asks` tree's start depends on `bids_size` (it varies
 * per market-size tier), so that one offset is computed per-pool and baked
 * into `PhoenixPoolConfig`.
 *
 * `RedBlackTree<K,V,MAX_SIZE>` (sokoban/src/red_black_tree.rs): root(u32)@0,
 * padding[u32;3]@4, then `NodeAllocator<RBNode<K,V>,MAX_SIZE,4>`
 * (node_allocator.rs) @16: size(u64)@0, bump_index(u32)@8,
 * free_list_head(u32)@12, then `nodes[MAX_SIZE]` @16 (asserted by the
 * crate's own `assert_proper_alignemnt`) — so a tree's node array starts at
 * `treeOffset + 32`. Each `Node<RBNode<FIFOOrderId,FIFORestingOrder>,4>` is
 * 64 bytes: `registers:[u32;4]` (Left@0/Right@4/Parent@8/Color@12 — `pub
 * const COLOR: u32 = Field::Value as u32` in red_black_tree.rs) then the
 * 48-byte `RBNode` value at +16: `FIFOOrderId{price_in_ticks:u64@0,
 * order_sequence_number:u64@8}` (16 bytes) + `FIFORestingOrder{trader_index:
 * u64@0,num_base_lots:u64@8,last_valid_slot:u64@16,
 * last_valid_unix_timestamp_in_seconds:u64@24}` (32 bytes) = 48. A node's
 * 1-based index `i` (as stored in the Left/Right/Parent registers, and
 * `NodeAllocator::get(i)` reads `nodes[i-1]`) maps to an absolute byte
 * offset of `nodesBase + (i-1)*64`.
 *
 * `FIFOOrderId`'s `Ord` (fifo.rs) is SIDE-DEPENDENT: for a Bid entry,
 * `self < other` iff `self.price_in_ticks > other.price_in_ticks` (higher
 * price sorts first), so `get_min()` on the `bids` tree returns the
 * HIGHEST-price resting bid; for an Ask entry the comparison is the
 * ordinary ascending one, so `get_min()` on `asks` returns the LOWEST-price
 * resting ask. Both are exactly "best resting order" for a taker on that
 * side. The in-order SUCCESSOR of the tree's min (climb via the Parent
 * register exactly like `manifest`'s off-chain `nextLower` walk — standard
 * BST successor, mathematically identical to sokoban's own stack-based
 * forward iterator) visits every further resting order best-first, which is
 * exactly the taker's match order (`match_order`, fifo.rs, always reads
 * `book.get_min()` first and would continue via the same successor chain
 * were the walk not IOC-bounded).
 *
 * ── Taker match / fee math (fifo.rs `match_order` + `place_order_inner`,
 *    quantities.rs is all plain u64/u128, no fixed-point) — TRANSCRIBED,
 *    not approximated ──
 *
 * The taker order is an `OrderPacket::ImmediateOrCancel` "market" order
 * (`price_in_ticks: None` ⇒ `limit_price_in_ticks` = Ticks::MAX for a Bid /
 * Ticks::MIN for an Ask, so it always crosses while the book is non-empty —
 * no on-chain price-floor check to replicate here; the merge's own
 * priceLimit/avgPriceLimit cut rungs upstream of this ladder, exactly like
 * every other family). Exactly one of `num_base_lots`/`num_quote_lots` is
 * set (the other 0):
 * - Bid (buy base, quote in): `base_lot_budget = BaseLots::MAX` (unbounded);
 *   `adjusted_quote_lot_budget` = the FEE-ADJUSTED input —
 *   `adjusted_quote_lot_budget_post_fee_adjustment_for_buys(quote_lots_in *
 *   base_lots_per_base_unit)`, itself
 *   `floor(rawAdjustedQL * u64::MAX / (compute_fee(u64::MAX) + u64::MAX))`
 *   — PROVABLY `<= rawAdjustedQL <= u64::MAX` (the fee-adjustment factor is
 *   always `>= u64::MAX`), so this can never overflow/downcast-fail for any
 *   real `quote_lots_in` — the venue's own `.unwrap_or(u64::MAX)` fallback
 *   for a failed downcast is provably unreachable here, so this module
 *   applies it unconditionally with no sentinel/clamp needed (UNLIKE
 *   `manifest`, whose per-ORDER price*size product can genuinely overflow
 *   u64 for an adversarial resting order — Phoenix's PER-LEVEL product
 *   `price_in_ticks * tick_size_in_quote_lots_per_base_unit *
 *   num_base_lots` is likewise bounded: any order actually resting in the
 *   book already had this SAME product checked at placement time
 *   (`quote_lots_to_lock`), so a live resting order's product can never
 *   overflow either — no SENT-sentinel class needed at all for this
 *   family).
 * - Ask (sell base, base in): `base_lot_budget = base_lots_in` (the exact
 *   input); `adjusted_quote_lot_budget = AdjustedQuoteLots::MAX`
 *   (unbounded).
 *
 * Per opposite-book level (price P ticks, size S lots — `quotedAdjQL = P *
 * tick_size_in_quote_lots_per_base_unit * S`): if `S <= base_budget &&
 * quotedAdjQL <= aq_budget`, the WHOLE level matches (full remove); else the
 * order's own budget binds — `base_to_remove = min(base_budget, aq_budget /
 * (P * tick_size_in_quote_lots_per_base_unit))` (floor div; NEVER a
 * cliff-collapse-to-0 case: `aq_budget`/`base_budget` are both PROVABLY
 * non-negative decreasing accumulators, so `base_to_remove` saturates
 * gracefully at whichever budget binds first) — and the walk terminates.
 *
 * After the walk, `compute_fee(x) = ceil(x * taker_fee_bps / 10000)`
 * (`(x*bps+9999)/10000`, `taker_fee_bps` read LIVE — see below) and
 * `feeLots = ceil(compute_fee(matchedAdjQL) / base_lots_per_base_unit)`
 * (a "round to nearest whole base unit's worth of fee, in lots" —
 * `round_adjusted_quote_lots_up(x)/BLPBU == (x+BLPBU-1)/BLPBU`, since the
 * cancelling `*BLPBU` in `round_..._up`'s own definition and the outer
 * `/BLPBU` collapse to one integer division). Then:
 * - Ask (sell): `quote_lots_out = floor(matchedAdjQL/BLPBU) - feeLots`
 *   (`round_adjusted_quote_lots_down(x)/BLPBU == x/BLPBU`, the same
 *   cancellation); a degenerate (dust) trade where `feeLots` would exceed
 *   the floored lots is clamped to 0 rather than replicating the real
 *   program's u64 underflow abort — see `emitWalk`'s note.
 * - Bid (buy): `quote_lots_in_consumed = ceil(matchedAdjQL/BLPBU) + feeLots`
 *   — always `<= quote_lots_in` (the productive input, for the
 *   `capacityInputVar` booking).
 *
 * `taker_fee_bps` is read LIVE (once per slot, in `emitSetup`) rather than
 * baked at prepare time: nothing in the deployed instruction set mutates it
 * post-initialization (no `ChangeFee`-style admin instruction exists in
 * `PhoenixInstruction`, only `ChangeFeeRecipient`, which moves the payout
 * destination, not the rate) — so baking it would already be safe — but the
 * extra `accountUint` read is one word for a fee-correctness guarantee with
 * no drift-gate downside, unlike the lot-size/tick-size/base_lots_per_base_unit
 * constants below, which never change post-init and stay compile-time
 * literals to save the read.
 *
 * ── Expiry / drift (mirrors `manifest`'s documented window semantics) ──
 *
 * FIFORestingOrder carries `last_valid_slot`/`last_valid_unix_timestamp_in_
 * seconds` (0 = no expiration). Phoenix has NO "global order" concept (that
 * complexity is `manifest`-specific), so the only off-chain window boundary
 * is: stop shipping at the first order with a nonzero expiry field (the
 * in-VM model carries no clock, exactly the class of stop `manifest`'s own
 * window already establishes for its own TIF orders) — the venue may still
 * match a live, unexpired TIF order beyond the shipped prefix (favorable,
 * `minOut` enforced). A shipped order's `order_sequence_number` is the
 * drift-invariant identity anchor (stable across partial fills, unique
 * across the free-list reuse a fill/cancel/eviction causes): the fragment
 * re-reads it live per shipped order and STOPS the walk at the first
 * mismatch, exactly like `manifest`.
 *
 * ── Swap CPI (`PhoenixInstruction::Swap` = 0, instruction.rs) ──
 *
 * Accounts (shank-declared, no seat needed — `Swap` is a pure taker,
 * distinct from `SwapWithFreeFunds`): [0] `phoenix_program` (this program's
 * own id, readonly — Phoenix self-CPIs instruction 15 for event logging),
 * [1] `log_authority` (readonly; the PDA seeds=[b"log"], hardcoded in
 * `phoenix-v1/src/lib.rs` as `7aDTsspkQNGKmrexAN7FLx9oxU3iPczSSvHNggyuqYkR`
 * and asserted there by `phoenix_log_authority::check_pda`), [2] `market`
 * (writable), [3] `trader` (signer, NOT writable — `Swap` never touches the
 * trader's lamports beyond the tx fee itself), [4] `base_account` (writable),
 * [5] `quote_account` (writable), [6] `base_vault` (writable), [7]
 * `quote_vault` (writable), [8] `token_program`. Data: Borsh
 * `[disc=0][OrderPacket::ImmediateOrCancel{...}]` — `ImmediateOrCancel` is
 * variant tag 2 (declaration order in order_schema/order_packet.rs:
 * PostOnly=0, Limit=1, ImmediateOrCancel=2); `side` is `Side::Bid=0`/
 * `Side::Ask=1` (enums.rs); `self_trade_behavior` is `CancelProvide=1`
 * (enums.rs: Abort=0, CancelProvide=1, DecrementTake=2) — chosen over the
 * default-looking `Abort` specifically BECAUSE `Abort` makes `match_order`
 * return `None`, which the processor treats as instruction failure
 * (aborting the whole cook): `CancelProvide` can never abort on a
 * (astronomically unlikely, since the recipe's own `trader` signer never
 * places resting orders here) self-trade, matching this repo's
 * venue-robustness philosophy of never letting one venue's edge case kill
 * the cook. `price_in_ticks: None`, `min_base_lots_to_fill`/
 * `min_quote_lots_to_fill: 0` (Phoenix's OWN partial-fill floor is
 * deliberately disarmed — the recipe's SINGLE terminal outAta-delta check
 * is the sole floor authority across every slot, the solswap/manifest
 * discipline), `match_limit: None`, `client_order_id: 0`,
 * `use_only_deposited_funds: false`, `last_valid_slot`/
 * `last_valid_unix_timestamp_in_seconds: None`.
 *
 * The patched runtime amount is in ATOMS (like every other family's
 * `fill[i]`), but `num_base_lots`/`num_quote_lots` are in LOTS
 * (`base_lot_size`/`quote_lot_size` atoms per lot — NOT 1:1, e.g. the real
 * SOL/USDC market has `base_lot_size = 1_000_000` — unlike every existing
 * family, none of which has a coarser native accounting unit than atoms).
 * `codegen.ts`'s new `EcoSwapSvmSlot.patchDivisorIn` hook (additive, unset
 * for every other family) floor-divides the patched value by the pool's
 * `direction`-appropriate lot size before it is written into the
 * instruction bytes — `ecoswap/svm/index.ts` sets it only for `phoenix`
 * slots.
 */
import { address } from '@solana/kit';
const SLUG = 'phoenix';
export const PHOENIX_PROGRAM_ID = address('PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY');
/** phoenix_log_authority::ID — static PDA seeds=[b"log"] (phoenix-v1/src/lib.rs). */
const PHOENIX_LOG_AUTHORITY = address('7aDTsspkQNGKmrexAN7FLx9oxU3iPczSSvHNggyuqYkR');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** MarketHeader — accounts.rs. Fixed 576-byte header preceding the FIFOMarket body. */
const HEADER_SIZE = 576;
/** u64 LE @0 — accounts.rs `check_discriminants` asserts this exact value for MarketHeader. */
export const MARKET_DISCRIMINANT = 8167313896524341111n;
const OFF_BIDS_SIZE = 16;
const OFF_ASKS_SIZE = 24;
const OFF_BASE_DECIMALS = 40;
const OFF_BASE_MINT = 48;
const OFF_BASE_VAULT = 80;
const OFF_BASE_LOT_SIZE = 112;
const OFF_QUOTE_DECIMALS = 120;
const OFF_QUOTE_MINT = 128;
const OFF_QUOTE_VAULT = 160;
const OFF_QUOTE_LOT_SIZE = 192;
// FIFOMarket body (markets/fifo.rs), absolute offsets = HEADER_SIZE + 256 (the
// struct's own leading `_padding: [u64;32]`) + the field's position.
const BODY_FIELDS = HEADER_SIZE + 256; // 832
const OFF_BASE_LOTS_PER_BASE_UNIT = BODY_FIELDS; // 832
const OFF_TICK_SIZE_QUOTE_LOTS = BODY_FIELDS + 8; // 840
export const OFF_TAKER_FEE_BPS = BODY_FIELDS + 24; // 856 — market-invariant, read LIVE
const BIDS_TREE_ROOT = BODY_FIELDS + 48; // 880 — market-invariant (bids ALWAYS starts here)
/** Node array start of the `bids` tree — market-invariant (the allocator header is fixed size). */
export const BIDS_NODES_BASE = BIDS_TREE_ROOT + 32; // 912
/** Node stride: registers[4] (16 bytes) + RBNode{FIFOOrderId(16) + FIFORestingOrder(32)} (48 bytes). */
const NODE_SIZE = 64;
const NODE_OFF_PRICE = 16; // price_in_ticks u64
const NODE_OFF_SEQ = 24; // order_sequence_number u64
const NODE_OFF_SIZE = 40; // num_base_lots u64
const NODE_OFF_LAST_VALID_SLOT = 48; // u64
const NODE_OFF_LAST_VALID_TS = 56; // u64
/** u64::MAX — BaseLots::MAX / AdjustedQuoteLots::MAX (the venue's own "unbounded" budget value). */
const U64_MAX = (1n << 64n) - 1n;
/**
 * Shipped top-of-book levels per direction. Half of manifest's 16 (a
 * heavier per-level walk: two budget checks plus the fee-adjusted-budget
 * setup) — MEASURED (not guessed): 588,522 CU @2 rungs / 831,135 CU @4
 * rungs on the real engine against the checked-in real SOL/USDC fixture
 * (`ecoswap-svm.cu.e2e.test.ts`, `CU_FAMILIES.phoenix` in budget.ts), both
 * comfortably under the ~1.19M admission budget with room for a companion
 * slot. At this depth the shipped bid window alone absorbs ~713 SOL before
 * exhausting (see `docs/phoenix-evidence.md`) — far beyond a typical trade
 * — so 8 is not a binding liquidity constraint at this snapshot; raise it
 * only if a future measurement shows CU headroom AND a real market where 8
 * levels genuinely caps absorption.
 */
export const PHOENIX_MAX_ORDERS = 8;
const WALK_BOUND = PHOENIX_MAX_ORDERS + 1;
/** cfg words per slot: nb + (nodeIndex, orderSequenceNumber) per shipped order. */
const PARAM_COUNT = 1 + 2 * PHOENIX_MAX_ORDERS;
/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export function phoenixWindowFor(cfg) {
    return cfg.direction === 'baseIn' ? cfg.windows.baseIn : cfg.windows.quoteIn;
}
/** nodesBase for the direction's book side ('baseIn' matches bids, 'quoteIn' matches asks). */
function nodesBaseFor(cfg) {
    return cfg.direction === 'baseIn' ? BIDS_NODES_BASE : cfg.asksNodesBase;
}
function readU64(data, offset) {
    let v = 0n;
    for (let i = 7; i >= 0; i--)
        v = (v << 8n) | BigInt(data[offset + i]);
    return v;
}
function readU32(data, offset) {
    return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
}
function hasDiscriminant(data) {
    return readU64(data, 0) === MARKET_DISCRIMINANT;
}
// ---------------------------------------------------------------------------
// Off-chain red-black-tree walk (standard BST successor via Left/Right/Parent
// registers — mathematically identical to sokoban's own stack-based forward
// iterator; see the header). Bounded off-chain; unaffordable in-VM.
// ---------------------------------------------------------------------------
function nodeAbs(nodesBase, nodeIndex) {
    return nodesBase + (nodeIndex - 1) * NODE_SIZE;
}
const regLeft = (data, nodesBase, i) => readU32(data, nodeAbs(nodesBase, i) + 0);
const regRight = (data, nodesBase, i) => readU32(data, nodeAbs(nodesBase, i) + 4);
const regParent = (data, nodesBase, i) => readU32(data, nodeAbs(nodesBase, i) + 8);
function findMin(data, nodesBase, idx) {
    let cur = idx;
    for (let guard = 0; guard < 1_000_000 && regLeft(data, nodesBase, cur) !== 0; guard++)
        cur = regLeft(data, nodesBase, cur);
    return cur;
}
function successor(data, nodesBase, idx) {
    const right = regRight(data, nodesBase, idx);
    if (right !== 0)
        return findMin(data, nodesBase, right);
    let cur = idx;
    for (let guard = 0; guard < 1_000_000; guard++) {
        const parent = regParent(data, nodesBase, cur);
        if (parent === 0)
            return 0;
        if (regLeft(data, nodesBase, parent) === cur)
            return parent;
        cur = parent;
    }
    return 0;
}
/**
 * Walk a book side best-first from its tree root, collecting the shippable
 * prefix: up to PHOENIX_MAX_ORDERS non-expiring (last_valid_slot === 0 AND
 * last_valid_unix_timestamp_in_seconds === 0), positive-size orders. Stops at
 * the first EXPIRING order (the in-VM model carries no clock — mirrors
 * manifest's identical stop) or the first zero-size tombstone (v1 never
 * actually leaves one mid-tree per fifo.rs's own comments, but skip-and-
 * continue costs nothing and matches manifest's defensive posture).
 */
function resolveWindow(data, root, nodesBase) {
    const orders = [];
    if (root === 0)
        return { orders };
    let cur = findMin(data, nodesBase, root);
    for (let guard = 0; guard < 1_000_000 && cur !== 0 && orders.length < PHOENIX_MAX_ORDERS; guard++) {
        const base = nodeAbs(nodesBase, cur);
        const lastValidSlot = readU64(data, base + NODE_OFF_LAST_VALID_SLOT);
        const lastValidTs = readU64(data, base + NODE_OFF_LAST_VALID_TS);
        if (lastValidSlot !== 0n || lastValidTs !== 0n)
            break; // TIF order — the model carries no clock
        const size = readU64(data, base + NODE_OFF_SIZE);
        if (size > 0n) {
            orders.push({ nodeIndex: cur, orderSequenceNumber: readU64(data, base + NODE_OFF_SEQ) });
        }
        cur = successor(data, nodesBase, cur);
    }
    return { orders };
}
/**
 * Fetch + gate one Phoenix market (account size/discriminant, classic-SPL
 * mints — the Swap ix has no separate mint accounts, so it is Tokenkeg-only,
 * mirroring manifest's identical gate) and freeze both directions' top-of-book
 * order windows. Read-only against the loader.
 */
export async function fetchPhoenixConfig(load, pool) {
    const data = await load(pool);
    if (data === null)
        throw new Error(`${SLUG}: market ${pool} not found`);
    if (data.length < HEADER_SIZE + 256 + 48) {
        throw new Error(`${SLUG}: market ${pool} has ${data.length} bytes, too small for a MarketHeader + FIFOMarket body`);
    }
    if (!hasDiscriminant(data)) {
        throw new Error(`${SLUG}: market ${pool} has a foreign discriminant (not a Phoenix MarketHeader account)`);
    }
    const bidsSize = readU64(data, OFF_BIDS_SIZE);
    const asksSize = readU64(data, OFF_ASKS_SIZE);
    if (bidsSize <= 0n || asksSize <= 0n) {
        throw new Error(`${SLUG}: market ${pool} has non-positive book capacity (bids ${bidsSize}, asks ${asksSize})`);
    }
    const bidsTreeSize = 32 + Number(bidsSize) * NODE_SIZE;
    const asksTreeRoot = BIDS_TREE_ROOT + bidsTreeSize;
    const asksNodesBase = asksTreeRoot + 32;
    const baseMint = decodeAddress(data, OFF_BASE_MINT);
    const quoteMint = decodeAddress(data, OFF_QUOTE_MINT);
    // The Swap ix carries no mint account (no transfer_checked plumbing) — it
    // is Tokenkeg-only. Mirrors manifest's classic-SPL-mint-size gate.
    for (const mint of [baseMint, quoteMint]) {
        const mintData = await load(mint);
        if (mintData === null)
            throw new Error(`${SLUG}: mint ${mint} of market ${pool} not found`);
        if (mintData.length !== 82) {
            throw new Error(`${SLUG}: market ${pool} mint ${mint} is not a classic SPL mint (Swap is Tokenkeg-only)`);
        }
    }
    const bidsRoot = readU32(data, BIDS_TREE_ROOT);
    const asksRoot = readU32(data, asksTreeRoot);
    return {
        venue: SLUG,
        pool,
        direction: 'baseIn',
        baseMint,
        quoteMint,
        baseVault: decodeAddress(data, OFF_BASE_VAULT),
        quoteVault: decodeAddress(data, OFF_QUOTE_VAULT),
        baseDecimals: data[OFF_BASE_DECIMALS],
        quoteDecimals: data[OFF_QUOTE_DECIMALS],
        baseLotSize: readU64(data, OFF_BASE_LOT_SIZE),
        quoteLotSize: readU64(data, OFF_QUOTE_LOT_SIZE),
        baseLotsPerBaseUnit: readU64(data, OFF_BASE_LOTS_PER_BASE_UNIT),
        tickSizeInQuoteLotsPerBaseUnit: readU64(data, OFF_TICK_SIZE_QUOTE_LOTS),
        asksNodesBase,
        windows: {
            // base-in sells base -> matches BIDS; quote-in buys base -> matches ASKS.
            baseIn: resolveWindow(data, bidsRoot, BIDS_NODES_BASE),
            quoteIn: resolveWindow(data, asksRoot, asksNodesBase),
        },
    };
}
function decodeAddress(data, offset) {
    // Base58-free decode via a tiny local codec would be overkill — reuse the
    // same approach every other adapter uses via @solana/kit's AddressCodec at
    // the call site would need an import; inline the standard base58 encode
    // instead to avoid a second dependency edge for 32 bytes.
    return b58EncodeAddress(data.subarray(offset, offset + 32));
}
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58EncodeAddress(bytes) {
    let num = 0n;
    for (const b of bytes)
        num = (num << 8n) | BigInt(b);
    let out = '';
    while (num > 0n) {
        const rem = num % 58n;
        num /= 58n;
        out = B58_ALPHABET[Number(rem)] + out;
    }
    let leadingZeros = 0;
    for (const b of bytes) {
        if (b !== 0)
            break;
        leadingZeros++;
    }
    return address('1'.repeat(leadingZeros) + out);
}
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter). */
export const phoenix = {
    slug: SLUG,
    programId: PHOENIX_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM,
    fetchPoolConfig: fetchPhoenixConfig,
};
function phoenixConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
function readLevels(market, orders, nodesBase) {
    const levels = [];
    for (const order of orders) {
        const base = nodeAbs(nodesBase, order.nodeIndex);
        const seqLive = readU64(market, base + NODE_OFF_SEQ);
        if (seqLive !== order.orderSequenceNumber)
            break; // identity mismatch — stop the walk
        levels.push({ price: readU64(market, base + NODE_OFF_PRICE), size: readU64(market, base + NODE_OFF_SIZE) });
    }
    return levels;
}
function effectiveLevels(cfg, state, params) {
    const market = state[cfg.pool];
    if (market === undefined)
        throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
    const nb = Number(params[0] ?? 0n);
    const orders = [];
    for (let k = 0; k < nb && k < PHOENIX_MAX_ORDERS; k++) {
        orders.push({ nodeIndex: Number(params[1 + 2 * k]), orderSequenceNumber: params[2 + 2 * k] });
    }
    return readLevels(market, orders, nodesBaseFor(cfg));
}
function computeFee(x, feeBps) {
    return (x * feeBps + 9999n) / 10000n;
}
function buyBudget(quoteLotsIn, blpbu, feeBps) {
    const rawAdj = quoteLotsIn * blpbu;
    const feeAdjMax = computeFee(U64_MAX, feeBps);
    const feeAdjustment = feeAdjMax + U64_MAX;
    return (rawAdj * U64_MAX) / feeAdjustment;
}
/**
 * Exact mirror of the emitted fragment given the SAME cfg + params + live fee
 * the blob was prepared with. `readFee` supplies `taker_fee_bps` from the SAME
 * live account bytes (the fragment reads it live too — see the module header).
 */
export function referenceQuote(base, state, params) {
    const cfg = phoenixConfig(base);
    const market = state[cfg.pool];
    if (market === undefined)
        throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
    const feeBps = readU64(market, OFF_TAKER_FEE_BPS);
    const levels = effectiveLevels(cfg, state, params);
    const baseIn = cfg.direction === 'baseIn';
    const blpbu = cfg.baseLotsPerBaseUnit;
    const T = cfg.tickSizeInQuoteLotsPerBaseUnit;
    return (x) => {
        if (x <= 0n)
            return 0n;
        const lotsIn = baseIn ? x / cfg.baseLotSize : x / cfg.quoteLotSize;
        if (lotsIn <= 0n)
            return 0n;
        let rb = baseIn ? lotsIn : U64_MAX;
        let ra = baseIn ? U64_MAX : buyBudget(lotsIn, blpbu, feeBps);
        let mb = 0n;
        let mq = 0n;
        for (let k = 0; k < levels.length && rb > 0n && ra > 0n; k++) {
            const level = levels[k];
            const den = level.price * T;
            const q = den * level.size;
            if (level.size <= rb && q <= ra) {
                mb += level.size;
                mq += q;
                rb -= level.size;
                ra -= q;
            }
            else {
                const btr = rb < ra / den ? rb : ra / den;
                mb += btr;
                mq += den * btr;
                break;
            }
        }
        const feeLots = (computeFee(mq, feeBps) + blpbu - 1n) / blpbu;
        if (baseIn) {
            let quoteLotsOut = mq / blpbu - feeLots;
            if (quoteLotsOut < 0n)
                quoteLotsOut = 0n;
            return quoteLotsOut * cfg.quoteLotSize;
        }
        return mb * cfg.baseLotSize;
    };
}
/** Pointwise mirror of the emitted `lx` capacity booking — the productive gross input consumed. */
export function referenceCapacities(base, state, params) {
    const cfg = phoenixConfig(base);
    const market = state[cfg.pool];
    if (market === undefined)
        throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
    const feeBps = readU64(market, OFF_TAKER_FEE_BPS);
    const levels = effectiveLevels(cfg, state, params);
    const baseIn = cfg.direction === 'baseIn';
    const blpbu = cfg.baseLotsPerBaseUnit;
    const T = cfg.tickSizeInQuoteLotsPerBaseUnit;
    return (grid) => grid.map((g) => {
        if (g <= 0n)
            return 0n;
        const lotsIn = baseIn ? g / cfg.baseLotSize : g / cfg.quoteLotSize;
        if (lotsIn <= 0n)
            return 0n;
        let rb = baseIn ? lotsIn : U64_MAX;
        let ra = baseIn ? U64_MAX : buyBudget(lotsIn, blpbu, feeBps);
        let mb = 0n;
        let mq = 0n;
        for (let k = 0; k < levels.length && rb > 0n && ra > 0n; k++) {
            const level = levels[k];
            const den = level.price * T;
            const q = den * level.size;
            if (level.size <= rb && q <= ra) {
                mb += level.size;
                mq += q;
                rb -= level.size;
                ra -= q;
            }
            else {
                const btr = rb < ra / den ? rb : ra / den;
                mb += btr;
                mq += den * btr;
                break;
            }
        }
        if (baseIn)
            return mb * cfg.baseLotSize;
        const feeLots = (computeFee(mq, feeBps) + blpbu - 1n) / blpbu;
        return ((mq + blpbu - 1n) / blpbu + feeLots) * cfg.quoteLotSize;
    });
}
/** Depth for the relative filter: the shipped top-of-book aggregate (atoms). */
export function depthReserves(base, state) {
    const cfg = phoenixConfig(base);
    const market = state[cfg.pool];
    if (market === undefined)
        throw new Error(`${SLUG} ladder depth is missing account ${cfg.pool}`);
    const baseIn = cfg.direction === 'baseIn';
    const levels = readLevels(market, phoenixWindowFor(cfg).orders, nodesBaseFor(cfg));
    const T = cfg.tickSizeInQuoteLotsPerBaseUnit;
    let reserveInLots = 0n;
    let reserveOutLots = 0n;
    for (const level of levels) {
        const quoteLots = level.price * T * level.size;
        if (baseIn) {
            reserveInLots += level.size;
            reserveOutLots += quoteLots / cfg.baseLotsPerBaseUnit;
        }
        else {
            reserveInLots += quoteLots / cfg.baseLotsPerBaseUnit;
            reserveOutLots += level.size;
        }
    }
    return baseIn
        ? { reserveIn: reserveInLots * cfg.baseLotSize, reserveOut: reserveOutLots * cfg.quoteLotSize }
        : { reserveIn: reserveInLots * cfg.quoteLotSize, reserveOut: reserveOutLots * cfg.baseLotSize };
}
// ---------------------------------------------------------------------------
// Fragment emission.
// ---------------------------------------------------------------------------
const ref = (slot, role) => `s${slot}:${role}`;
function emitOrderRead(p, k, params, nodesBaseExpr, mktRef) {
    const idxParam = params[1 + 2 * k];
    const seqParam = params[2 + 2 * k];
    return [
        `    if (${p}st === 0 && ${params[0]} > ${k}) {`,
        `      ${p}ix = ${nodesBaseExpr} + (${idxParam} - 1) * ${NODE_SIZE};`,
        `      if (accountUint(${mktRef}, ${p}ix + ${NODE_OFF_SEQ}, 8) === ${seqParam}) {`,
        `        ${p}pr[${p}nb] = accountUint(${mktRef}, ${p}ix + ${NODE_OFF_PRICE}, 8);`,
        `        ${p}sz[${p}nb] = accountUint(${mktRef}, ${p}ix + ${NODE_OFF_SIZE}, 8);`,
        `        ${p}nb = ${p}nb + 1;`,
        `      } else { ${p}st = 1; }`,
        `    }`,
    ];
}
/** One emitted cold walk (the fragment twin of the TS mirror above), over grid point `xExpr`. */
function emitWalk(p, cfg, xExpr, outVar, tag, indent, decl) {
    const baseIn = cfg.direction === 'baseIn';
    const T = cfg.tickSizeInQuoteLotsPerBaseUnit.toString();
    const BLPBU = cfg.baseLotsPerBaseUnit.toString();
    const lotDiv = (baseIn ? cfg.baseLotSize : cfg.quoteLotSize).toString();
    const lotsExpr = `((${xExpr}) / ${lotDiv})`;
    const initRb = baseIn ? lotsExpr : U64_MAX.toString();
    const initRa = baseIn ? U64_MAX.toString() : `phxBuyBudget(${lotsExpr}, ${BLPBU}, ${p}fee)`;
    const step = [
        `${indent}    ${p}den = ${p}pr[${p}k] * ${T};`,
        `${indent}    ${p}q = ${p}den * ${p}sz[${p}k];`,
        `${indent}    if (${p}sz[${p}k] <= ${p}rb && ${p}q <= ${p}ra) {`,
        `${indent}      ${p}mb = ${p}mb + ${p}sz[${p}k]; ${p}mq = ${p}mq + ${p}q;`,
        `${indent}      ${p}rb = ${p}rb - ${p}sz[${p}k]; ${p}ra = ${p}ra - ${p}q; ${p}k = ${p}k + 1;`,
        `${indent}    } else {`,
        `${indent}      ${p}btr = ${p}rb; if ((${p}ra / ${p}den) < ${p}btr) { ${p}btr = ${p}ra / ${p}den; }`,
        `${indent}      ${p}mb = ${p}mb + ${p}btr; ${p}mq = ${p}mq + ${p}den * ${p}btr;`,
        `${indent}      ${p}dn = 1;`,
        `${indent}    }`,
    ];
    // Post-walk: fee is ALWAYS ceil(compute_fee(mq)/BLPBU) either direction.
    // baseIn (sell): out = floor(mq/BLPBU) - feeLots, clamped >= 0 (a dust trade
    // whose fee would exceed the floored lots is quoted 0 rather than
    // replicating the real program's u64 underflow abort — never a favorable
    // error). quoteIn (buy): out = matched base lots (no fee subtraction — the
    // fee already narrowed the AQ budget going IN).
    const outLines = baseIn
        ? [
            `${indent}  ${p}qo = ${p}mq / ${BLPBU} - ${p}fl;`,
            `${indent}  if (${p}qo < 0) { ${p}qo = 0; }`,
            `${indent}  ${outVar} = ${p}qo * ${cfg.quoteLotSize};`,
        ]
        : [`${indent}  ${outVar} = ${p}mb * ${cfg.baseLotSize};`];
    // Productive input consumed (atoms), for the capacityInputVar clamp:
    // baseIn -> matched base lots -> atoms; quoteIn -> ceil(mq/BLPBU)+feeLots -> atoms.
    const lxExpr = baseIn
        ? `${p}mb * ${cfg.baseLotSize}`
        : `((${p}mq + ${BLPBU} - 1) / ${BLPBU} + ${p}fl) * ${cfg.quoteLotSize}`;
    return [
        `${indent}${decl} ${outVar} = 0;`,
        `${indent}if (${p}vld !== 0 && (${xExpr}) > 0) {`,
        `${indent}  ${p}rb = ${initRb}; ${p}ra = ${initRa}; ${p}mb = 0; ${p}mq = 0; ${p}k = 0; ${p}dn = 0;`,
        `${indent}  for (let ${p}w${tag} = 0; ${p}w${tag} < ${WALK_BOUND} && ${p}rb > 0 && ${p}ra > 0 && ${p}k < ${p}nb && ${p}dn === 0; ${p}w${tag}++) {`,
        ...step,
        `${indent}  }`,
        `${indent}  ${p}fl = phxFeeLots(${p}mq, ${p}fee, ${BLPBU});`,
        ...outLines,
        `${indent}  ${p}lo = ${outVar}; ${p}lx = ${lxExpr};`,
        `${indent}}`,
    ];
}
export const phoenixLadder = {
    slug: SLUG,
    /**
     * 2 rungs by default: the setup (PHOENIX_MAX_ORDERS unrolled live reads) is
     * a heavy fixed cost — a 'stable'-class family like manifest/whirlpool (see
     * budget.ts). The cold walk is exact at any point, so a coarser rung grid
     * only affects split quantization, not correctness.
     */
    defaultRungs: 2,
    shapeKey(base) {
        return `${SLUG}:${phoenixConfig(base).direction}`;
    },
    helpers() {
        return [
            {
                // ceil(compute_fee(x)/blpbu) — self-contained (no calls to another helper).
                name: 'phxFeeLots',
                source: [
                    'function phxFeeLots(x, feeBps, blpbu) {',
                    '  let f = (x * feeBps + 9999) / 10000;',
                    '  return (f + blpbu - 1) / blpbu;',
                    '}',
                ].join('\n'),
            },
            {
                // The Bid-side fee-adjusted AQ budget — see the module header for the derivation.
                name: 'phxBuyBudget',
                source: [
                    'function phxBuyBudget(qLotsIn, blpbu, feeBps) {',
                    '  let raw = qLotsIn * blpbu;',
                    `  let feeMax = (${U64_MAX} * feeBps + 9999) / 10000;`,
                    `  let adj = feeMax + ${U64_MAX};`,
                    `  return (raw * ${U64_MAX}) / adj;`,
                    '}',
                ].join('\n'),
            },
        ];
    },
    /** [nb, (nodeIndex, orderSequenceNumber) x PHOENIX_MAX_ORDERS]. */
    paramCount: PARAM_COUNT,
    paramsFor(base) {
        const cfg = phoenixConfig(base);
        const window = phoenixWindowFor(cfg);
        const words = [BigInt(window.orders.length)];
        for (let k = 0; k < PHOENIX_MAX_ORDERS; k++) {
            const order = window.orders[k];
            if (order === undefined) {
                words.push(0n, 0n);
                continue;
            }
            words.push(BigInt(order.nodeIndex), order.orderSequenceNumber);
        }
        return words;
    },
    quoteRefs(base, slot) {
        return [{ ref: ref(slot, 'mkt'), address: phoenixConfig(base).pool }];
    },
    emitSetup(base, slot, params, enableVar) {
        const cfg = phoenixConfig(base);
        const p = `s${slot}`;
        const enabled = enableVar ?? `${p}en`;
        const mktRef = JSON.stringify(ref(slot, 'mkt'));
        const nodesBaseLiteral = (cfg.direction === 'baseIn' ? BIDS_NODES_BASE : cfg.asksNodesBase).toString();
        const lines = [
            `  const ${p}pr = new Array(${PHOENIX_MAX_ORDERS});`,
            `  const ${p}sz = new Array(${PHOENIX_MAX_ORDERS});`,
            `  let ${p}nb = 0;`,
            `  let ${p}st = 0;`,
            `  let ${p}ix = 0;`,
            `  let ${p}fee = 0;`,
            // Walk cursor (shared by rungs + the cold final quote — main scope).
            `  let ${p}rb = 0; let ${p}ra = 0; let ${p}mb = 0; let ${p}mq = 0; let ${p}k = 0; let ${p}dn = 0;`,
            `  let ${p}den = 0; let ${p}q = 0; let ${p}btr = 0; let ${p}fl = 0; let ${p}qo = 0;`,
            `  let ${p}lo = 0; let ${p}lx = 0;`,
            `  if (${enabled} !== 0) {`,
            `    ${p}fee = accountUint(${mktRef}, ${OFF_TAKER_FEE_BPS}, 8);`,
            ...Array.from({ length: PHOENIX_MAX_ORDERS }, (_, k) => emitOrderRead(p, k, params, nodesBaseLiteral, mktRef)).flat(),
            `  }`,
            `  let ${p}vld = 0;`,
            `  if (${p}nb > 0) { ${p}vld = 1; }`,
        ];
        return lines.join('\n');
    },
    emitLadderQuote(base, slot, rung, x, outVar) {
        return emitWalk(`s${slot}`, phoenixConfig(base), x, outVar, `${rung}`, '    ', 'const').join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}lx`;
    },
    emitFinalQuote(base, slot, x, outVar) {
        const p = `s${slot}`;
        return [
            `  let ${outVar} = 0;`,
            `  if (${p}vld !== 0 && (${x}) > 0) {`,
            `    if (${p}lx === (${x})) { ${outVar} = ${p}lo }`,
            `    else {`,
            ...emitWalk(p, phoenixConfig(base), x, `${p}fq`, 'f', '      ', 'let').map((line) => '  ' + line),
            `      ${outVar} = ${p}fq;`,
            `    }`,
            `  }`,
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = phoenixConfig(base);
        const baseIn = cfg.direction === 'baseIn';
        // Data: [disc=0 (Swap)][variant=2 (ImmediateOrCancel)][side][price_in_ticks tag=0(None)]
        //   <patched u64: num_base_lots (baseIn) | num_quote_lots (quoteIn)>
        //   [the OTHER of num_base_lots/num_quote_lots = 0][min_base_lots_to_fill=0]
        //   [min_quote_lots_to_fill=0][self_trade_behavior=1(CancelProvide)][match_limit tag=0(None)]
        //   [client_order_id=0 (u128)][use_only_deposited_funds=0][last_valid_slot tag=0(None)]
        //   [last_valid_unix_timestamp_in_seconds tag=0(None)]
        const prefix = Uint8Array.from([0, 2, baseIn ? 1 : 0, 0]);
        const suffix = new Uint8Array(8 + 8 + 8 + 1 + 1 + 16 + 1 + 1 + 1);
        suffix[24] = 1; // self_trade_behavior = CancelProvide
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: PHOENIX_PROGRAM_ID,
            prefix,
            suffix,
            patch: 'in',
            accounts: [
                roled('prog', PHOENIX_PROGRAM_ID),
                roled('log', PHOENIX_LOG_AUTHORITY),
                roled('mkt', cfg.pool, true),
                { ref: user.owner, signer: true },
                { ref: baseIn ? user.inAta : user.outAta, writable: true },
                { ref: baseIn ? user.outAta : user.inAta, writable: true },
                roled('bv', cfg.baseVault, true),
                roled('qv', cfg.quoteVault, true),
                roled('tp', TOKEN_PROGRAM),
            ],
        };
    },
    depthReserves,
    referenceQuote,
    referenceCapacities,
    /** Zero-fee unit multiplier — the venue's own taker_fee_bps is baked into the quote directly. */
    continuousFees() {
        return { gammaPpm: 1000000n, muPpm: 1000000n };
    },
};
/** The lot-size divisor `codegen.ts`'s `patchDivisorIn` hook needs for this pool's direction. */
export function phoenixPatchDivisor(base) {
    const cfg = phoenixConfig(base);
    return cfg.direction === 'baseIn' ? cfg.baseLotSize : cfg.quoteLotSize;
}
//# sourceMappingURL=index.js.map