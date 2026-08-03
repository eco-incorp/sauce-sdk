/**
 * OpenBook V2 — a permissionless CLOB (Serum/OpenBook lineage), manifest-shaped:
 * a k-level best-first walk over shipped resting orders, ship-and-verify
 * exactly like `manifest` (see `@eco-incorp/sauce-sdk/svm`'s manifest ladder),
 * but over a genuinely DIFFERENT on-chain layout — OpenBook keeps the two
 * order-book sides in their OWN accounts (BookSide), not embedded in the
 * market, and settles via a real Anchor CPI (`placeTakeOrder`) rather than a
 * self-contained custom instruction.
 *
 * Program id opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb. Layout — FREE from
 * the on-chain IDL (github.com/openbook-dex/openbook-v2, `idl/openbook_v2.json`)
 * and independently BYTE-VERIFIED against the real Market/BookSide struct
 * definitions (every offset below re-derived field-by-field from the IDL and
 * cross-checked against `const_assert_eq!(size_of::<BookSide>(), 90944)` in
 * `programs/openbook-v2/src/state/orderbook/bookside.rs` and the 848-byte
 * on-chain `dataSize` filter — both match exactly):
 *
 * Market account (848 bytes total, INCLUDING the 8-byte Anchor discriminator
 * at @0): bump@8, baseDecimals@9, quoteDecimals@10, bids@200, asks@232,
 * eventHeap@264, oracleA@296 (NonZeroPubkeyOption — 32 bytes, zero = None),
 * oracleB@328, quoteLotSize@448 (i64), baseLotSize@456 (i64), makerFee@480
 * (i64, ppm; >=0 means NO taker-fee rebate to the maker, i.e. no discount to
 * model — see the fee section below), takerFee@488 (i64, ppm, always >= 0),
 * baseMint@576, quoteMint@608, marketBaseVault@640, marketQuoteVault@680;
 * openOrdersAdmin@88 and timeExpiry@48 gate participation (see fetchPoolConfig).
 *
 * BookSide account (one PER SIDE — bids and asks are SEPARATE accounts, unlike
 * manifest's single self-contained market): roots[2]@8 (OrderTreeRoot =
 * {maybeNode: u32, leafCount: u32}, 8 bytes each — index 0 is the `Fixed`
 * order tree, index 1 `OraclePegged`), nodes (OrderTreeNodes) starting @312;
 * within OrderTreeNodes the `nodes: [AnyNode; 1024]` array itself starts at a
 * FURTHER +528 offset (orderTreeType(1)+padding(3)+bumpIndex(4)+freeListLen(4)+
 * freeListHead(4)+reserved(512)), so a tree-node absolute offset is
 * `840 + nodeIndex*88` (AnyNode = tag(1)+data(87), 88 bytes; a LeafNode's
 * `key` (u128 LE) sits at nodeOffset+8, `quantity` (i64) at nodeOffset+56,
 * `timeInForce` (u16) at nodeOffset+2). Total 90952 bytes (312 + 90640),
 * matching size_of::<BookSide>()=90944 plus the 8-byte discriminator exactly.
 *
 * THE LADDER IS THE FIXED-TREE ONLY, best-first over the FULL 128-BIT KEY (not
 * price alone): `key = (price_lots << 64) | tie_break`, and per
 * bookside.rs's own doc comment ("smallest to highest for asks; highest to
 * smallest for bids") ties at one price level still have a real time-priority
 * order the venue enforces — VALIDATED empirically (see below): sorting by
 * price_lots alone picks the WRONG subset of same-priced orders whenever a
 * price level is shared by more than the shipped window's order count,
 * silently under-filling a "saturate the whole window" cook (measured on a
 * REAL mainnet book with 14 same-priced bid levels behind a 4-order window).
 * OraclePegged-tree liquidity is NEVER modelled (the effective price of a
 * pegged order depends on a live oracle read this ladder does not perform) —
 * this is a strict UNDERESTIMATE (the real walk can only deliver >= what this
 * ladder predicts on a book that also carries pegged makers), never a
 * favourable-error risk. Orders with `timeInForce != 0` (can expire) are
 * dropped from the shipped window entirely at prepare time — the real venue
 * actively prunes expired orders out of the match (`DROP_EXPIRED_ORDER_LIMIT`
 * in book.rs), so counting one at prepare time and having it vanish by cook
 * time would silently overstate liquidity; TIF=0 (GTC) orders can only be
 * removed by a fill or a cancel, both already covered by the live key-match
 * self-drop below.
 *
 * PER-ORDER LIVE DRIFT CHECK: the fragment ships (nodeOffset, key, priceLots)
 * per level and re-reads the LIVE 128-bit key at nodeOffset+8 (one 16-byte
 * accountUint, same width class as manifest's own price read) — an exact
 * match proves the slot still holds THE SAME resting order (key encodes
 * price AND placement order; free-list slot reuse after a fill/cancel gets a
 * fresh key), then re-reads LIVE quantity (order sizes only ever shrink while
 * resting, never grow). A mismatch STOPS the walk at that level (the same
 * class as manifest's sequence-number check / whirlpool's missing-tick gate).
 *
 * MATCH MATH — restricted to exactly what `placeTakeOrder` (Market order
 * type, no OpenOrdersAccount) actually executes, independently re-derived
 * from `programs/openbook-v2/src/{state/orderbook/book.rs,
 * instructions/place_take_order.rs}` and EMPIRICALLY VALIDATED bit-exact
 * against the REAL openbook-v2 binary (dumped from mainnet-beta) executing
 * on REAL mainnet Market/BookSide state via LiteSVM, at 3+ sizes per
 * direction (small / medium / saturating-the-whole-shipped-window) AND with
 * a realistic nonzero taker/maker fee (a market's `takerFee`/`makerFee` are
 * per-market constants — the fee arithmetic below was validated by patching
 * a real market's fee fields to nonzero and re-running the same real CPI):
 *
 * - baseIn (sell base, taker side = Ask, opposes the BIDS tree, best = HIGHEST
 *   key first): `max_base_lots` is the real constraint (uncapped quote side);
 *   walk full-or-partial matches best-first; `quoteTakenNative = Σ(matchBase
 *   * priceLots) * quoteLotSize`; a market's maker rebate
 *   (`market.maker_fee < 0` only — makerRebatePpm is 0 whenever makerFee is
 *   non-negative, the common case, PRE-COMPUTED at prepare time so the
 *   fragment never branches on the sign) nets OFF the taker's proceeds:
 *   `output = quoteTakenNative - floor(quoteTakenNative * makerRebatePpm / 1e6)`.
 *   Surprisingly (confirmed via the REAL CPI, not just the source read): the
 *   ASK-side settlement in `place_take_order` does NOT separately deduct
 *   `takerFee` from the taker's quote proceeds — only `makerRebatePpm` (a
 *   distinct, usually-zero, per-market negative-maker-fee rebate) nets off
 *   the literal token transfer; `takerFee` only feeds `market.fees_accrued`
 *   bookkeeping in this instruction path, not this instruction's OWN token
 *   movement. Do not "fix" this to also subtract takerFee — that would
 *   silently move the quote OFF the value the real CPI settles.
 * - quoteIn (buy base, taker side = Bid, opposes the ASKS tree, best = LOWEST
 *   key first): the real constraint is quote, applied via OpenBook's own
 *   `subtract_taker_fees` UPFRONT budget shrink — `remainingQuoteLots =
 *   floor(floor(x / quoteLotSize) * 1e6 / (1e6 + takerFeePpm))` — this is
 *   the ONLY place takerFee enters a quoteIn quote (the taker's effective
 *   buying power is reduced up front; there is no separate fee line-item
 *   subtracted from the delivered base). `output = ΣmatchBase * baseLotSize`
 *   (no further adjustment); the actual quote DEBITED (`consumedInput`, what
 *   the merge's capacityInputVar reports) is `Σ(matchBase*priceLots)*
 *   quoteLotSize + floor(that * makerRebatePpm / 1e6)` — i.e. even a fully
 *   absorbed (non-capacity-bound) quoteIn fill structurally consumes LESS
 *   than the caller's nominal `x` by the taker-fee fraction: this is NOT a
 *   capacity artefact, it is the real per-trade fee tax, and reporting it
 *   honestly (rather than pretending consumedInput===x whenever the book has
 *   depth) is what capacityInputVar's contract calls for.
 * Both walks self-cap (SATURATE at the shipped window's real depth) rather
 * than collapse to 0 past capacity — the same contract meteora-damm-v2 /
 * orca-legacy-token-swap / manifest all fixed for the identical −788.8bps
 * class of hazard: `capacityInputVar` always reports the PRODUCTIVE input
 * actually absorbed, never the raw (possibly-unreachable) grid span.
 *
 * CPI: `placeTakeOrder` (Anchor disc `sha256("global:place_take_order")[..8]`),
 * PlaceOrderType::Market (index 3 — ignores `price_lots`/the `priceLots` arg
 * entirely and matches at ANY price up to the size caps, exactly like
 * manifest's own `out_atoms=1`/no-independent-price-floor philosophy — the
 * recipe's own minOut/priceLimit are the real floor, not a per-CPI price
 * bound) with `limit` (max maker orders touched) baked to the shipped order
 * count — CRITICAL: a looser `limit` lets the real walk continue matching
 * PAST the shipped window (measured directly: a `limit` bigger than the
 * window size delivered MORE than this ladder ever quoted, a real but
 * unaccounted-for surplus that would desync the merge's own bookkeeping of
 * what this slot consumed). `side`/`orderType`/the uncapped opposite-side cap
 * are baked into the prefix/suffix (never runtime-patched — none of them
 * depend on the traded amount); the ONE runtime-patched u64 is
 * `max_base_lots` (baseIn) or `max_quote_lots_including_fees` (quoteIn).
 *
 * THE ATOMS-VS-LOTS PATCH GAP (why `fill[slot]` gets reassigned in
 * emitFinalQuote): `LadderSwapTemplate.patch: 'in'` always writes the merge's
 * raw ATOM-denominated fill share verbatim (`le8(fill[slot])`, see
 * codegen.ts) — every existing venue's CPI amount field IS atom-denominated,
 * so this has never needed a conversion hook. OpenBook's `max_base_lots`/
 * `max_quote_lots_including_fees` are LOT-denominated (a market-specific
 * power-of-ten divisor), so the raw atom count is the WRONG value to write
 * there. There is no venue-supplied transform in the patch path, so
 * `emitFinalQuote`'s LAST emitted statement reassigns the shared `fill[slot]`
 * local itself (`fill[slot] = fill[slot] / lotSizeConst`) — AFTER computing
 * this slot's predicted-output quote (which reads the ORIGINAL atom value
 * first) and BEFORE codegen's own `if (fill[slot] > 0 && p[slot] > 0)` CPI
 * guard / `le8(fill[slot])` patch line run (both execute in a later,
 * strictly-after codegen pass over all slots — see codegen.ts's two
 * sequential `slots.forEach` loops). This is SOUND for every consumer that
 * matters (the minOut/predicted-output checks and the terminal realized-delta
 * floor never read `fill[]`, only `p[i]`/the outAta delta) with ONE disclosed
 * side effect: the raw returndata's `fill[slot]` word reports LOTS, not
 * atoms, for an engaged openbook-v2 slot (every other slot's `fill[]` stays
 * atom-denominated) — a caller reconciling `Σfill[i] <= amountIn` numerically
 * must special-case this venue's slot the same way it would need to for any
 * lot-quantised venue's *executed* size not equalling its *offered* size.
 *
 * Both directions and the atoms/lots patch were EMPIRICALLY VALIDATED end to
 * end (LiteSVM + the real dumped openbook-v2.so, real mainnet Market/
 * BookSide/vault state, a real user ATA pair) at 3+ sizes per direction,
 * including full-window saturation and a realistic nonzero fee — see
 * test/svm/venues/openbook-v2.test.ts and the real-CPI suite.
 *
 * Gates (self-drop, named errors caught by the orchestrator's TOCTOU):
 * - wrong account size (not 848 for the market, not 90952 for a BookSide) —
 *   fetch-time, an unrelated/stale/upgraded account layout;
 * - `openOrdersAdmin` configured (nonzero) — this recipe carries no
 *   third-party admin signer, so such a market can never be taken via
 *   `placeTakeOrder` from here; fetch-time gate;
 * - `timeExpiry != 0 && now >= timeExpiry` — an expired market; the FAMILIES
 *   gate (mirrors meteora-damm-v2's activation-point pattern, which also
 *   needs `now` and so cannot live in fetchPoolConfig's own signature);
 * - a direction with NO shippable Fixed-tree TIF=0 orders — `SvmWindowDriftError`,
 *   wired via the FAMILIES gate exactly like manifest's empty-window case.
 */
import { address } from '@solana/kit';
import { readUintLE } from '../math.js';
const SLUG = 'openbook-v2';
export const OPENBOOK_V2_PROGRAM_ID = address('opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** The System Program id (32 zero bytes, base58-encoded). */
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const MARKET_ACCOUNT_SIZE = 848;
export const BOOKSIDE_ACCOUNT_SIZE = 90952;
/** Absolute byte offset of `nodes[0]` within a BookSide account (312 + 528). */
const NODES_BASE = 840;
/** Size in bytes of one AnyNode / tree-array slot. */
const NODE_SIZE = 88;
const TAG_INNER = 1;
const TAG_LEAF = 2;
/** Offsets within a LeafNode-tagged AnyNode (relative to the node's own base). */
const OFF_LEAF_TIF = 2;
const OFF_LEAF_KEY = 8;
const OFF_LEAF_QTY = 8 + 16 + 32;
/** Anchor `sha256("global:place_take_order")[0..8]`. */
const PLACE_TAKE_ORDER_DISC = Uint8Array.from([0x03, 0x2c, 0x47, 0x03, 0x1a, 0xc7, 0xcb, 0x55]);
/** `PlaceOrderType::Market` — ignores the price arg, matches at any price up to the size caps. */
const ORDER_TYPE_MARKET = 3;
/** Shipped resting-order window depth per direction — a heavy fixed setup cost (unrolled live
 * reads over a 90KB BookSide account), same 'stable'/degrade-first class as manifest/whirlpool. */
export const OPENBOOK_V2_MAX_ORDERS = 4;
/** The direction's shipped window (the ladder fragment and the orchestrator gate read through this). */
export function openbookV2WindowFor(cfg) {
    return cfg.windows[cfg.direction];
}
/** Two's-complement i64 read (readUintLE is unsigned-only) — needed for `makerFee`, which the
 * venue documents as signable (`maker_fee < 0` means part of the taker fee rebates to the maker). */
function readInt64LE(data, offset) {
    const raw = readUintLE(data, offset, 8);
    const SIGN_BIT = 1n << 63n;
    return raw >= SIGN_BIT ? raw - (1n << 64n) : raw;
}
function readPubkeyIsZero(data, offset) {
    for (let i = 0; i < 32; i++)
        if (data[offset + i] !== 0)
            return false;
    return true;
}
/** Best-first order over the FULL 128-bit key: descending for bids (highest key first), ascending
 * for asks (lowest key first) — see the header's bookside.rs citation for why price alone is unsafe. */
function sortBestFirst(orders, descending) {
    const sorted = [...orders].sort((a, b) => {
        if (a.key === b.key)
            return 0;
        if (descending)
            return a.key > b.key ? -1 : 1;
        return a.key < b.key ? -1 : 1;
    });
    return sorted;
}
/** Walks the Fixed order tree (root index 0) of a BookSide account, collecting every LeafNode with
 * timeInForce === 0 (see the header: TIF>0 orders are dropped rather than modelled). */
function walkFixedTree(data) {
    const maybeNode = readUintLE(data, 8, 4);
    const leafCount = readUintLE(data, 12, 4);
    const out = [];
    if (leafCount === 0n)
        return out;
    const stack = [Number(maybeNode)];
    let visited = 0;
    const BOUND = 4096; // 1024 slots, generous bound against a malformed/cyclic tree
    while (stack.length > 0) {
        if (++visited > BOUND)
            throw new Error(`${SLUG}: BookSide tree walk exceeded ${BOUND} visits — refusing to loop`);
        const idx = stack.pop();
        const nodeOffset = NODES_BASE + idx * NODE_SIZE;
        const tag = Number(readUintLE(data, nodeOffset, 1));
        if (tag === TAG_LEAF) {
            const tif = Number(readUintLE(data, nodeOffset + OFF_LEAF_TIF, 2));
            if (tif !== 0)
                continue;
            const key = readUintLE(data, nodeOffset + OFF_LEAF_KEY, 16);
            const priceLots = key >> 64n;
            out.push({ nodeOffset, key, priceLots });
        }
        else if (tag === TAG_INNER) {
            const childrenOff = nodeOffset + 1 + 3 + 4 + 16;
            stack.push(Number(readUintLE(data, childrenOff, 4)));
            stack.push(Number(readUintLE(data, childrenOff + 4, 4)));
        }
        // Uninitialized / FreeNode / LastFreeNode: dead end, nothing to do.
    }
    return out;
}
export async function fetchOpenBookV2Config(load, pool) {
    const market = await load(pool);
    if (market === null)
        throw new Error(`${SLUG} market ${pool} does not exist`);
    if (market.length !== MARKET_ACCOUNT_SIZE) {
        throw new Error(`${SLUG} market ${pool} has unexpected size ${market.length} (want ${MARKET_ACCOUNT_SIZE})`);
    }
    if (!readPubkeyIsZero(market, 88)) {
        throw new Error(`${SLUG} market ${pool} has a configured openOrdersAdmin — no third-party signer available`);
    }
    const timeExpiry = readInt64LE(market, 48);
    const baseDecimals = Number(readUintLE(market, 9, 1));
    const quoteDecimals = Number(readUintLE(market, 10, 1));
    const bidsAccount = decodeAddressFrom(market, 200);
    const asksAccount = decodeAddressFrom(market, 232);
    const eventHeap = decodeAddressFrom(market, 264);
    const oracleAZero = readPubkeyIsZero(market, 296);
    const oracleBZero = readPubkeyIsZero(market, 328);
    const oracleA = oracleAZero ? undefined : decodeAddressFrom(market, 296);
    const oracleB = oracleBZero ? undefined : decodeAddressFrom(market, 328);
    const quoteLotSize = readUintLE(market, 448, 8);
    const baseLotSize = readUintLE(market, 456, 8);
    const makerFeeRaw = readInt64LE(market, 480);
    const takerFeePpm = readUintLE(market, 488, 8); // always >= 0 by the venue's own invariant
    const makerRebatePpm = makerFeeRaw >= 0n ? 0n : -makerFeeRaw;
    const baseMint = decodeAddressFrom(market, 576);
    const quoteMint = decodeAddressFrom(market, 608);
    const marketBaseVault = decodeAddressFrom(market, 640);
    const marketQuoteVault = decodeAddressFrom(market, 680);
    const marketAuthority = decodeAddressFrom(market, 16);
    const bidsData = await load(bidsAccount);
    const asksData = await load(asksAccount);
    if (bidsData === null || bidsData.length !== BOOKSIDE_ACCOUNT_SIZE) {
        throw new Error(`${SLUG} market ${pool} bids account is missing or the wrong size`);
    }
    if (asksData === null || asksData.length !== BOOKSIDE_ACCOUNT_SIZE) {
        throw new Error(`${SLUG} market ${pool} asks account is missing or the wrong size`);
    }
    const bidsWindow = sortBestFirst(walkFixedTree(bidsData), true).slice(0, OPENBOOK_V2_MAX_ORDERS);
    const asksWindow = sortBestFirst(walkFixedTree(asksData), false).slice(0, OPENBOOK_V2_MAX_ORDERS);
    return {
        venue: SLUG,
        pool,
        direction: 'baseIn',
        baseMint,
        quoteMint,
        bidsAccount,
        asksAccount,
        eventHeap,
        marketBaseVault,
        marketQuoteVault,
        marketAuthority,
        baseDecimals,
        quoteDecimals,
        baseLotSize,
        quoteLotSize,
        takerFeePpm,
        makerRebatePpm,
        timeExpiry,
        oracleA,
        oracleB,
        windows: { baseIn: { orders: bidsWindow }, quoteIn: { orders: asksWindow } },
    };
}
// --- account address decode (32 raw bytes -> base58 Address) --------------
// The SDK barrel does not re-export @solana/kit's address codec, and pulling
// in @solana/kit's getAddressCodec here would be an extra direct dependency
// this recipe does not otherwise need for a pure-decode path — bs58-encode
// the 32 raw bytes ourselves (the SAME alphabet/algorithm @solana/kit uses)
// and validate through `address()`, which is already imported.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
    const digits = [0];
    for (let i = 0; i < bytes.length; i++) {
        let carry = bytes[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let leadingZeros = 0;
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++)
        leadingZeros++;
    let out = '1'.repeat(leadingZeros);
    for (let i = digits.length - 1; i >= 0; i--)
        out += BASE58_ALPHABET[digits[i]];
    return out === '' ? '1' : out;
}
function decodeAddressFrom(data, offset) {
    return address(base58Encode(data.subarray(offset, offset + 32)));
}
function openbookV2Config(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
// ---------------------------------------------------------------------------
// Fragment emission — a manifest-shaped unrolled window read + a shared
// integer walk (baseIn: constrained by base lots, quoteIn: constrained by
// fee-shrunk quote lots), NO overflow sentinel handling (unlike manifest's
// mfQfb/mfBfq/SENT machinery): OpenBook's lot-domain products are bounded by
// two i64 operands (well under 2^126), never close to the interpreter's
// 256-bit word width, so plain multiplication never needs a clamp here.
// ---------------------------------------------------------------------------
const ref = (slot, role) => `s${slot}:${role}`;
/** 2^64 — every per-trade payload arg is encoded as ONE u64 word
 * (`encodeSvmRouteTrade`/codegen.ts's `abi.encode(le8(...))` path), so the order's full 128-bit
 * tree key can NOT ride as a single param (it can exceed u64::MAX — measured directly: a real
 * fixture key failed encodeSvmRouteTrade's own u64-range check). Ship it as two u64 halves
 * instead — `keyLow` (params) + `priceLots` (already shipped, and IS the key's top 64 bits by
 * construction, see `walkFixedTree`) — and RECONSTRUCT the full key on both sides (the fragment via
 * plain `*`+`+`, proven supported at this magnitude by manifest's own u128 arithmetic; the TS
 * mirror the same way) before comparing against the live 16-byte account read. */
const TWO_POW_64 = 1n << 64n;
const MASK_64 = TWO_POW_64 - 1n;
/** [nb, baseLotSize, quoteLotSize, takerFeePpm, makerRebatePpm, (nodeOffset,keyLow,priceLots) x MAX]. */
const PARAM_COUNT = 5 + 3 * OPENBOOK_V2_MAX_ORDERS;
function emitLevelRead(p, slot, k, params) {
    const bookRef = JSON.stringify(ref(slot, 'book'));
    const base = 5 + 3 * k;
    const nodeOffsetParam = params[base];
    const keyLowParam = params[base + 1];
    const priceParam = params[base + 2];
    return [
        `    if (${p}st === 0 && ${params[0]} > ${k}) {`,
        `      ${p}no = ${nodeOffsetParam};`,
        `      if (accountUint(${bookRef}, ${p}no + 8, 16) === ${priceParam} * ${TWO_POW_64} + ${keyLowParam}) {`,
        `        ${p}pr[${p}nb] = ${priceParam};`,
        `        ${p}sz[${p}nb] = accountUint(${bookRef}, ${p}no + ${OFF_LEAF_QTY}, 8);`,
        `        ${p}nb = ${p}nb + 1;`,
        `      } else { ${p}st = 1; }`,
        `    }`,
    ];
}
/** The shared cold walk, over grid point `xExpr`, for one direction — used identically for every
 * ladder rung and the final quote (no warm-start state: each walk is exact from scratch, same as
 * manifest's pointwise CLOB walk). Also books `capacityInputVar` (`${p}lx`) and the last output
 * (`${p}lo`), and — for the FINAL quote only (`isFinal`) — reassigns the shared `fill[slot]` local
 * from atoms to lots (see the header's "atoms-vs-lots patch gap"). */
function emitWalk(cfg, p, slot, xExpr, outVar, decl, tag, indent, isFinal) {
    const baseIn = cfg.direction === 'baseIn';
    const lines = [
        `${indent}${decl} ${outVar} = 0;`,
        `${indent}if (${p}vld !== 0 && ${xExpr} > 0) {`,
    ];
    if (baseIn) {
        lines.push(`${indent}  let ${p}rm${tag} = ${xExpr} / ${p}bls;`, `${indent}  let ${p}out${tag} = 0; let ${p}k${tag} = 0;`, `${indent}  for (let ${p}w${tag} = 0; ${p}w${tag} < ${OPENBOOK_V2_MAX_ORDERS} && ${p}rm${tag} > 0 && ${p}k${tag} < ${p}nb; ${p}w${tag}++) {`, `${indent}    const ${p}mb${tag} = ${p}rm${tag} < ${p}sz[${p}k${tag}] ? ${p}rm${tag} : ${p}sz[${p}k${tag}];`, `${indent}    ${p}out${tag} = ${p}out${tag} + ${p}mb${tag} * ${p}pr[${p}k${tag}];`, `${indent}    ${p}rm${tag} = ${p}rm${tag} - ${p}mb${tag};`, `${indent}    ${p}k${tag} = ${p}k${tag} + 1;`, `${indent}  }`, `${indent}  const ${p}qtn${tag} = ${p}out${tag} * ${p}qls;`, `${indent}  const ${p}reb${tag} = (${p}qtn${tag} * ${p}mrp) / 1000000;`, `${indent}  ${outVar} = ${p}qtn${tag} - ${p}reb${tag};`, `${indent}  ${p}lo = ${outVar};`, `${indent}  ${p}lx = ${xExpr} - ${p}rm${tag} * ${p}bls;`);
    }
    else {
        lines.push(`${indent}  const ${p}nql${tag} = ${xExpr} / ${p}qls;`, `${indent}  let ${p}rm${tag} = (${p}nql${tag} * 1000000) / (1000000 + ${p}tfp);`, `${indent}  let ${p}ob${tag} = 0; let ${p}oq${tag} = 0; let ${p}k${tag} = 0; let ${p}dn${tag} = 0;`, `${indent}  for (let ${p}w${tag} = 0; ${p}w${tag} < ${OPENBOOK_V2_MAX_ORDERS} && ${p}rm${tag} > 0 && ${p}k${tag} < ${p}nb && ${p}dn${tag} === 0; ${p}w${tag}++) {`, `${indent}    const ${p}mm${tag} = ${p}rm${tag} / ${p}pr[${p}k${tag}];`, `${indent}    if (${p}mm${tag} === 0) { ${p}dn${tag} = 1 }`, `${indent}    else {`, `${indent}      const ${p}mb${tag} = ${p}mm${tag} < ${p}sz[${p}k${tag}] ? ${p}mm${tag} : ${p}sz[${p}k${tag}];`, `${indent}      const ${p}mq${tag} = ${p}mb${tag} * ${p}pr[${p}k${tag}];`, `${indent}      ${p}rm${tag} = ${p}rm${tag} - ${p}mq${tag};`, `${indent}      ${p}ob${tag} = ${p}ob${tag} + ${p}mb${tag};`, `${indent}      ${p}oq${tag} = ${p}oq${tag} + ${p}mq${tag};`, `${indent}      ${p}k${tag} = ${p}k${tag} + 1;`, `${indent}    }`, `${indent}  }`, `${indent}  const ${p}qtn${tag} = ${p}oq${tag} * ${p}qls;`, `${indent}  const ${p}reb${tag} = (${p}qtn${tag} * ${p}mrp) / 1000000;`, `${indent}  ${outVar} = ${p}ob${tag} * ${p}bls;`, `${indent}  ${p}lo = ${outVar};`, `${indent}  ${p}lx = ${p}qtn${tag} + ${p}reb${tag};`);
    }
    lines.push(`${indent}}`);
    if (isFinal) {
        // See the header's "atoms-vs-lots patch gap": the ONE runtime-patched CPI amount must be in
        // LOTS, but codegen always writes the shared `fill[slot]` local (atoms) verbatim. This is the
        // LAST statement touching this slot's quote — every earlier line above already consumed the
        // ORIGINAL atom-denominated xExpr (which IS `fill[slot]` for the final quote call).
        const lotConst = baseIn ? `${p}bls` : `${p}qls`;
        lines.push(`${indent}fill[${slot}] = ${xExpr} / ${lotConst};`);
    }
    return lines;
}
export const openbookV2Ladder = {
    slug: SLUG,
    /** Heavy fixed setup (MAX_ORDERS unrolled live reads + key verification over a 90KB BookSide
     * account) — 'stable'/degrade-first class, same as manifest/whirlpool (recipes/ecoswap/svm/budget.ts). */
    defaultRungs: 2,
    shapeKey(base) {
        return `${SLUG}:${openbookV2Config(base).direction}`;
    },
    helpers() {
        return [];
    },
    paramCount: PARAM_COUNT,
    paramsFor(base) {
        const cfg = openbookV2Config(base);
        const window = openbookV2WindowFor(cfg);
        const words = [
            BigInt(window.orders.length),
            cfg.baseLotSize,
            cfg.quoteLotSize,
            cfg.takerFeePpm,
            cfg.makerRebatePpm,
        ];
        for (let k = 0; k < OPENBOOK_V2_MAX_ORDERS; k++) {
            const order = window.orders[k];
            if (order === undefined) {
                words.push(0n, 0n, 0n);
                continue;
            }
            words.push(BigInt(order.nodeOffset), order.key & MASK_64, order.priceLots);
        }
        return words;
    },
    quoteRefs(base, slot) {
        const cfg = openbookV2Config(base);
        const bookAddress = cfg.direction === 'baseIn' ? cfg.bidsAccount : cfg.asksAccount;
        return [{ ref: ref(slot, 'book'), address: bookAddress }];
    },
    emitSetup(base, slot, params, enableVar) {
        const cfg = openbookV2Config(base);
        const p = `s${slot}`;
        const enabled = enableVar ?? `${p}en`;
        const lines = [
            `  const ${p}pr = new Array(${OPENBOOK_V2_MAX_ORDERS});`,
            `  const ${p}sz = new Array(${OPENBOOK_V2_MAX_ORDERS});`,
            `  let ${p}nb = 0;`,
            `  let ${p}st = 0;`,
            `  let ${p}no = 0;`,
            `  const ${p}bls = ${params[1]};`,
            `  const ${p}qls = ${params[2]};`,
            `  const ${p}tfp = ${params[3]};`,
            `  const ${p}mrp = ${params[4]};`,
            `  let ${p}lo = 0; let ${p}lx = 0;`,
            `  if (${enabled} !== 0) {`,
            ...Array.from({ length: OPENBOOK_V2_MAX_ORDERS }, (_, k) => emitLevelRead(p, slot, k, params)).flat(),
            `  }`,
            `  let ${p}vld = 0;`,
            `  if (${p}nb > 0) { ${p}vld = 1 }`,
        ];
        return lines.join('\n');
    },
    emitLadderQuote(base, slot, rung, x, outVar) {
        const cfg = openbookV2Config(base);
        return emitWalk(cfg, `s${slot}`, slot, x, outVar, 'const', `${rung}`, '    ', false).join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}lx`;
    },
    emitFinalQuote(base, slot, x, outVar) {
        const cfg = openbookV2Config(base);
        const p = `s${slot}`;
        // Reuse the last ladder rung's result when the elected fill lands exactly on it (identical to
        // manifest's own reuse), otherwise a fresh walk — either way the atoms->lots fill[] reassignment
        // must run exactly once for the FINAL quote, so both branches funnel through emitWalk(isFinal=true).
        return [
            `  let ${outVar} = 0;`,
            `  if (${p}vld !== 0 && ${x} > 0) {`,
            `    if (${p}lx === ${x}) { ${outVar} = ${p}lo; fill[${slot}] = ${x} / ${cfg.direction === 'baseIn' ? `${p}bls` : `${p}qls`}; }`,
            `    else {`,
            ...emitWalk(cfg, p, slot, x, `${p}fq`, 'let', 'f', '      ', true).map((line) => '  ' + line),
            `      ${outVar} = ${p}fq;`,
            `    }`,
            `  }`,
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = openbookV2Config(base);
        const baseIn = cfg.direction === 'baseIn';
        const side = baseIn ? 1 : 0; // Side::Ask = 1 (sell base), Side::Bid = 0 (buy base)
        const orderCount = openbookV2WindowFor(cfg).orders.length;
        const oracleARef = cfg.oracleA ?? OPENBOOK_V2_PROGRAM_ID;
        const oracleBRef = cfg.oracleB ?? OPENBOOK_V2_PROGRAM_ID;
        const le8 = (v) => {
            const bytes = [];
            let x = v;
            for (let i = 0; i < 8; i++) {
                bytes.push(Number(x & 0xffn));
                x >>= 8n;
            }
            return bytes;
        };
        const MAX_I64 = (1n << 63n) - 1n;
        const uncappedBaseLots = MAX_I64 / cfg.baseLotSize;
        const uncappedQuoteLots = MAX_I64 / cfg.quoteLotSize;
        // prefix carries every arg that does NOT depend on the traded amount; the ONE runtime-patched
        // u64 is max_base_lots (baseIn) or max_quote_lots_including_fees (quoteIn) — see the header.
        const prefix = baseIn
            ? Uint8Array.from([...PLACE_TAKE_ORDER_DISC, side, ...le8(1n)])
            : Uint8Array.from([...PLACE_TAKE_ORDER_DISC, side, ...le8(1n), ...le8(uncappedBaseLots)]);
        const suffix = baseIn
            ? Uint8Array.from([...le8(uncappedQuoteLots), ORDER_TYPE_MARKET, orderCount])
            : Uint8Array.from([ORDER_TYPE_MARKET, orderCount]);
        const roled = (r, addr, writable) => writable ? { ref: ref(slot, r), address: addr, writable: true } : { ref: ref(slot, r), address: addr };
        return {
            programId: OPENBOOK_V2_PROGRAM_ID,
            prefix,
            suffix,
            patch: 'in',
            accounts: [
                { ref: user.owner, signer: true, writable: true }, // signer
                { ref: user.owner, signer: true, writable: true }, // penaltyPayer (same signer; PENALTY_EVENT_HEAP is 500 lamports)
                roled('mkt', cfg.pool, true),
                roled('auth', cfg.marketAuthority),
                roled('bids', cfg.bidsAccount, true),
                roled('asks', cfg.asksAccount, true),
                roled('bv', cfg.marketBaseVault, true),
                roled('qv', cfg.marketQuoteVault, true),
                roled('eh', cfg.eventHeap, true),
                { ref: baseIn ? user.inAta : user.outAta, writable: true },
                { ref: baseIn ? user.outAta : user.inAta, writable: true },
                roled('oa', oracleARef),
                roled('ob', oracleBRef),
                roled('tp', TOKEN_PROGRAM),
                roled('sp', SYSTEM_PROGRAM),
                roled('ooa', OPENBOOK_V2_PROGRAM_ID), // openOrdersAdmin sentinel — fetchPoolConfig rejects any market with one configured
            ],
        };
    },
    referenceQuote(base, state, params) {
        const cfg = openbookV2Config(base);
        const baseIn = cfg.direction === 'baseIn';
        const bookAddress = baseIn ? cfg.bidsAccount : cfg.asksAccount;
        const bookData = state[bookAddress];
        if (bookData === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${bookAddress}`);
        const nb = Number(params[0]);
        const baseLotSize = params[1];
        const quoteLotSize = params[2];
        const takerFeePpm = params[3];
        const makerRebatePpm = params[4];
        const levels = [];
        for (let k = 0; k < nb && k < OPENBOOK_V2_MAX_ORDERS; k++) {
            const nodeOffset = Number(params[5 + 3 * k]);
            const keyLow = params[6 + 3 * k];
            const priceLots = params[7 + 3 * k];
            const liveKey = readUintLE(bookData, nodeOffset + 8, 16);
            if (liveKey !== priceLots * TWO_POW_64 + keyLow)
                break;
            const quantity = readUintLE(bookData, nodeOffset + OFF_LEAF_QTY, 8);
            levels.push({ priceLots, quantity });
        }
        return (x) => {
            if (x <= 0n || levels.length === 0)
                return 0n;
            if (baseIn) {
                let remainingBaseLots = x / baseLotSize;
                let quoteLotsTaken = 0n;
                for (const level of levels) {
                    if (remainingBaseLots <= 0n)
                        break;
                    const matchBase = remainingBaseLots < level.quantity ? remainingBaseLots : level.quantity;
                    quoteLotsTaken += matchBase * level.priceLots;
                    remainingBaseLots -= matchBase;
                }
                const quoteTakenNative = quoteLotsTaken * quoteLotSize;
                const rebate = (quoteTakenNative * makerRebatePpm) / 1000000n;
                return quoteTakenNative - rebate;
            }
            const nominalQuoteLots = x / quoteLotSize;
            let remainingQuoteLots = (nominalQuoteLots * 1000000n) / (1000000n + takerFeePpm);
            let baseLotsTaken = 0n;
            for (const level of levels) {
                if (remainingQuoteLots <= 0n)
                    break;
                const maxMatch = remainingQuoteLots / level.priceLots;
                if (maxMatch === 0n)
                    break;
                const matchBase = maxMatch < level.quantity ? maxMatch : level.quantity;
                remainingQuoteLots -= matchBase * level.priceLots;
                baseLotsTaken += matchBase;
            }
            return baseLotsTaken * baseLotSize;
        };
    },
    referenceCapacities(base, state, params) {
        const cfg = openbookV2Config(base);
        const baseIn = cfg.direction === 'baseIn';
        const bookAddress = baseIn ? cfg.bidsAccount : cfg.asksAccount;
        const bookData = state[bookAddress];
        if (bookData === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${bookAddress}`);
        const nb = Number(params[0]);
        const baseLotSize = params[1];
        const quoteLotSize = params[2];
        const takerFeePpm = params[3];
        const makerRebatePpm = params[4];
        const levels = [];
        for (let k = 0; k < nb && k < OPENBOOK_V2_MAX_ORDERS; k++) {
            const nodeOffset = Number(params[5 + 3 * k]);
            const keyLow = params[6 + 3 * k];
            const priceLots = params[7 + 3 * k];
            const liveKey = readUintLE(bookData, nodeOffset + 8, 16);
            if (liveKey !== priceLots * TWO_POW_64 + keyLow)
                break;
            const quantity = readUintLE(bookData, nodeOffset + OFF_LEAF_QTY, 8);
            levels.push({ priceLots, quantity });
        }
        return (grid) => grid.map((x) => {
            if (x <= 0n || levels.length === 0)
                return 0n;
            if (baseIn) {
                let remainingBaseLots = x / baseLotSize;
                for (const level of levels) {
                    if (remainingBaseLots <= 0n)
                        break;
                    const matchBase = remainingBaseLots < level.quantity ? remainingBaseLots : level.quantity;
                    remainingBaseLots -= matchBase;
                }
                return x - remainingBaseLots * baseLotSize;
            }
            const nominalQuoteLots = x / quoteLotSize;
            let remainingQuoteLots = (nominalQuoteLots * 1000000n) / (1000000n + takerFeePpm);
            let quoteLotsTaken = 0n;
            for (const level of levels) {
                if (remainingQuoteLots <= 0n)
                    break;
                const maxMatch = remainingQuoteLots / level.priceLots;
                if (maxMatch === 0n)
                    break;
                const matchBase = maxMatch < level.quantity ? maxMatch : level.quantity;
                const matchQuote = matchBase * level.priceLots;
                remainingQuoteLots -= matchQuote;
                quoteLotsTaken += matchQuote;
            }
            const quoteTakenNative = quoteLotsTaken * quoteLotSize;
            const rebate = (quoteTakenNative * makerRebatePpm) / 1000000n;
            return quoteTakenNative + rebate;
        });
    },
    depthReserves(base, state) {
        const cfg = openbookV2Config(base);
        const window = openbookV2WindowFor(cfg);
        if (window.orders.length === 0)
            return { reserveIn: 0n, reserveOut: 0n };
        const bookAddress = cfg.direction === 'baseIn' ? cfg.bidsAccount : cfg.asksAccount;
        const bookData = state[bookAddress];
        let reserveIn = 0n;
        let reserveOut = 0n;
        for (const order of window.orders) {
            const quantity = bookData === undefined ? 0n : readUintLE(bookData, order.nodeOffset + OFF_LEAF_QTY, 8);
            if (cfg.direction === 'baseIn') {
                reserveIn += quantity * cfg.baseLotSize;
                reserveOut += quantity * order.priceLots * cfg.quoteLotSize;
            }
            else {
                reserveOut += quantity * cfg.baseLotSize;
                reserveIn += quantity * order.priceLots * cfg.quoteLotSize;
            }
        }
        return { reserveIn, reserveOut };
    },
    continuousFees() {
        // A CLOB is not a constant-product curve — the continuous CP oracle is measurement-only and
        // CP-class-only (identical rationale to manifest's own continuousFees). takerFee/makerRebate
        // are already exact in referenceQuote/emitFinalQuote; no fee multiplier belongs here.
        return { gammaPpm: 0n, muPpm: 1000000n };
    },
};
//# sourceMappingURL=index.js.map