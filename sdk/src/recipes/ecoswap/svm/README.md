# EcoSwapSVM

The Solana sibling of EcoSwap: split ONE swap across multiple venues so the **post-fee marginal
execution prices equalize**, with the whole solve computed **LIVE in one atomic engine
instruction**. Same thesis as the EVM recipe (`../README.md`) — pouring input into the best
marginal price first and stopping at a common level IS the convex optimum — restated for a chain
with no view functions: pool state accounts are attached read-only, the engine's `accountUint`
reads pull the reserves inside the VM, and the quote, the split and the swaps all happen against
the same account state in the same instruction. No off-chain quote can be stale, because there is
no off-chain quote.

What landed: **12 venue adapters across five liquidity models** — CP (constant-product),
stable (in-VM Newton), CLMM (tick-walk window), BIN (Meteora Liquidity Book), CLOB (Manifest
order book) — plus the **oracle-anchored prop-AMM class** (Obric V2, tier P-A). On top of the
single-hop merge: **2-hop routes** (the compute-exec-read-realized-compute-exec composite venue),
an **address-lookup-table** path for account lists that outgrow the 1,232-byte packet, a **CU
budgeter** (measured per-family coefficients fix ladder depth and slot count deterministically at
codegen time), a **batched account loader**, the **lamport-exact gate** against a bit-for-bit TS
mirror (which is also the user-facing quote), the **prop-AMM P-A/P-B/P-C ledger** (the
Instructions-sysvar CPI-acceptance discriminant), and the env-gated **real-binary CPI lane** (the
full quadrilateral against five venue programs dumped from mainnet). Everything is
single-instruction, atomic and lamport-exact.

## Navigation

Families + measured CU · CLMM/CLOB/BIN windows · quantized water-fill · stable-slot Newton
economics · CU budgeter · shape-blob model · exactness gate + oracles · batched loading · usage ·
ALT · real-binary lane · prop-AMM (Obric) + the P-A/B/C ledger · 2-hop routes · honest limits.

## Families (adapter contract v2, `sdk/src/svm/venues/*/ladder.ts`)

The venue byte layouts, quote formulas, gates and pinned worked examples live in
`docs/svm-venues.md` — one section per family. **Model / rungs / measured CU / real-binary
verified** at a glance (the per-family CU is a single-slot trade on the real engine; see
**Measured** below for the split figures):

| family | model | default rungs | @2 rungs | @4 rungs | real-binary |
| --- | --- | --- | --- | --- | --- |
| raydium-cp-swap | CP | 4 | 270,098 | 400,206 | **yes** |
| raydium-amm-v4 | CP | 4 | 244,475 | 368,773 | no (SDK == program) |
| pumpswap | CP | 4 | 273,510 | 414,269 | **yes** (+ `pump-fee.so`) |
| orca-legacy-token-swap | CP | 4 | 327,829 | 503,191 | no (SDK == program) |
| meteora-damm-v2 | CP (sqrt-price) | 4 | 306,903 | 471,714 | no (SDK == program) |
| saber-stableswap | STABLE | 2 | 778,562 | 1,097,079 | **yes** |
| meteora-damm-v1-stable | STABLE | 2 | 940,490 | 1,353,318 | no (SDK == program) |
| orca-whirlpool | CLMM | 2 | 771,309 | 1,142,759 | **yes** (real tick cross) |
| raydium-clmm | CLMM | 2 | 818,705 | 1,227,431 | no (env-gated quad) |
| meteora-dlmm | BIN | 2 | 816,315 | 1,183,105 | no (mirror-gated) |
| manifest | CLOB | 2 | 791,441 | 961,890 | **yes** (real CLOB match) |
| obric-v2 | CP (oracle-anchored, P-A) | 4 | 379,674 | 506,621 | no (SDK == program) |

**Real-binary** = the full quadrilateral (docs == `referenceQuote` == in-VM predicted == the real
mainnet binary's realized output) runs in `test/svm/ecoswap-svm.realcpi.e2e.test.ts` under
`SAUCE_VENUE_PROGRAMS`; the other seven rest on **SDK == program** (an independent direct port of
the venue's own math, cross-checked in-VM by the unconditional lamport-exact gate) plus the
conservative under-quote and the terminal `minOut` — see **Honest limits**.

The live-read fields per family:

| family | live reads |
| --- | --- |
| raydium-cp-swap | vaults − fee accumulators, AmmConfig fee rates; creator-fee side as a per-trade param |
| raydium-amm-v4 | vaults − need_take_pnl, swap fee fraction (status 6/7 gate at prepare; Tokenkeg-only) |
| pumpswap | raw vault balances; fee bps ride as per-trade params; buy and sell directions |
| orca-legacy-token-swap | raw vault balances; SwapV1 fee fractions as params; floor-min-1 fees, ceiling curve |
| meteora-damm-v2 | liquidity, sqrt_price, base+dynamic fee, version cap, band bounds, collect_fee_mode — zero params |
| saber-stableswap | pause byte, vault balances, the four amp-ramp fields, trade fee — zero params |
| meteora-damm-v1-stable | vault share math with locked-profit decay, fees (min-1), amp, multipliers, idle float — zero params |
| orca-whirlpool | sqrt_price, tick, liquidity, fee_rate, per-boundary initialized flags + liquidity_net i128 — the WINDOW (up to 4 initialized-tick boundaries + the sequence edge, with their pure-function sqrt prices) rides the params |
| raydium-clmm | sqrt_price_x64, tick_current, liquidity from the pool + trade_fee_rate from the AmmConfig; per-boundary liquidity_gross (initialized) + liquidity_net i128 — the WINDOW (up to 4 initialized-tick boundaries + the sequence edge, standard Uniswap-V3 tick math) rides the params; classic fee-on-input path only (dynamic-fee/`fee_on` pools gated) |
| meteora-dlmm | active_id + the volatility v_parameters from the LbPair; per shipped bin amount_x/amount_y from its bin array; the WINDOW (up to 8 liquid bins as biased id + array cell + Q64.64 price) rides the params; VARIABLE FEE computed live per bin (base + volatility, update_references over the live clock); fee-on-input (collect_fee_mode 0) + no-limit-order pools only |
| manifest | the whole order book in one market account; per shipped level a live sequence_number (identity) + price (u128) + num_base_atoms; the top-of-book WINDOW (up to 16 best-first levels as DataIndex+seq) rides the params; zero fee |
| obric-v2 | reserveX/reserveY vault balances + the LIVE oracle MID from a separate Pyth-v2-relay feed account (re-anchors targetXK every execution); bigK hi/lo, targetX, fee, the oracle scaling + feed offsets ride the params; sanity-band self-deactivation vs the stored mult |

A v2 fragment reads the trade amount and the live state at RUNTIME — nothing about the trade is
baked. Direction stays part of the shape, as does the rung count (`~r<n>` in the shape key when
off the family default).

**The CLMM window (orca-whirlpool, the first Phase 2 family).** A tick walk needs boundary
STRUCTURE that is unaffordable to discover in-VM (measured: ~8k CU per scanned tick slot, ~54k
per in-VM `sqrt_price_from_tick_index`), so prepare walks the tick arrays off-chain and ships
up to 4 initialized-tick boundaries + the swap-sequence edge as per-trade cfg words — each as
(biased tick, array cell, sqrt price), all THREE drift-invariant by construction (a TickArray
PDA pins its start index; the sqrt price is a pure function of the tick). Everything
value-bearing stays live: the fragment re-reads the pool's sqrt_price/tick/liquidity/fee and
every boundary's initialized flag + liquidity_net i128 at cook time, skips boundaries behind
the live tick (drift re-anchoring, the venue's own search semantics), skips removed ticks, and
SELF-DEACTIVATES when the live tick leaves the shipped window — the SVM shape of the EVM
net-cache thesis. Ladder rungs are COLD walks from the live spot (each rung = the venue's own
compute_swap loop; crossed boundaries memoize their full-step results across walks —
value-transparent, so the mirror stays plain); a rung whose walk exhausts the window reports
the previous cumulative output (dOut 0 — merge-safe self-deactivation), and the final
predicted quote clamps to 0 past capacity, skipping the CPI. One documented one-sided drift:
a tick NEWLY initialized inside a shipped gap adds a venue step the model misses — added
liquidity only improves the realized output, and the terminal delta check still enforces
minOut.

**The CLOB window (manifest, the second Phase 2 family).** An order book is a red-black tree of
resting orders inside ONE market account; the taker match walks best-first via
`get_next_lower_index` (successor pointer-chasing with a data-dependent inner loop — unbounded and
unaffordable in-VM, the whirlpool tick-discovery class). So prepare walks the tree OFF-CHAIN from
the side's best index and ships up to `MANIFEST_MAX_ORDERS = 16` price levels as `(DataIndex,
sequence_number)` cfg params; the fragment reads each shipped order's price + size LIVE. **Price
levels ARE the ladder** — each order a discrete step, capacity = its size, marginal price = its
listed price, ZERO fee — so the book side is exact at every point (a CLOB quote is piecewise-linear
in the levels), and only the shared geometric split-grid quantizes. The `sequence_number` (a
monotonic per-order id, stable across partial fills, unique across free-list reuse) is the
drift-invariant identity anchor: the fragment validates it live per order and STOPS the walk on the
first mismatch (an order filled/cancelled + its block reused) — the CLOB shape of self-deactivation.
The off-chain walk STOPS at the first GLOBAL order (a taker IOC halts there without the extra global
accounts, so globals are gated out) and the first EXPIRING order (the in-VM model carries no clock).
The `swap` is walletless direct settlement (a temporary seat, virtual credit, match, settle,
release); one-sided drifts (a new better order missed, an expiring order matched past the window)
are favorable or minOut-caught. The two directions are the venue's two taker paths exactly
(`place_order` for base-in sells, `impact_base_atoms` for quote-in buys), transcribed with the same
UP/DOWN rounding.

## The quantized water-fill

Solana's compute budget cannot afford a continuous marginal-equalization solve per trade, so the
split is **quantized**:

- every active slot builds a **geometric quote ladder** from its LIVE state: `R_i` rungs on the
  cumulative grid `G_j = amountIn >> (R_i − j)` (so the top rung is always the whole trade; fine
  rungs near zero, coarse near the top), each rung carrying its exact venue output delta;
- one **k-way cheapest-rung-first merge** fills `amountIn`: each step elects the best next rung by
  average execution price (integer-exact cross-multiplication, ties keep the earliest slot — slot
  order encodes preference) and advances only that slot; the marginal rung fills **partially**, so
  the binding venue's cut is exact to the lamport;
- the **entire split is computed before the first CPI** (platform law: once `invoke()` launches, a
  failing callee aborts the whole transaction), then each engaged slot's venue swap executes with
  its instruction-data amount **patched at runtime** from the merge result, and **one terminal
  realized-delta check** on the user's outAta enforces `minOut` across all slots at once
  (venue-level `min_out` is 1 everywhere, the solswap discipline).

## Stable slots: Newton economics

A stable quote is a Newton iteration (`stableD`/`stableYW`, shared helpers deduped across
families), two orders of magnitude costlier than a CP quote. Three measures make the class fit:

- **D once per trade**: the invariant depends only on the reserves, so it is computed in setup —
  gated on the slot's enable flag, so a disabled slot pays nothing;
- **warm-started ladder rungs**: rung j's `compute_y` starts from rung j−1's result (`stableYW`;
  rung 0 starts from D — exactly the venue's cold start). Larger cumulative input ⇒ smaller y, so
  the fixed point is still approached from above and converges in ~1-2 iterations instead of the
  cold ~15+. The warm-vs-cold oracle unit asserts the chain reproduces the cold values on the
  fixture universe; even where an exotic pool might wobble a rung, both sides of the exactness
  gate compute the SAME chain, so only rung-election quality could shift — never correctness;
- **cold final quotes**: the per-slot predicted output (what minOut checks and the real-binary
  quadrilateral pins) is always the venue's own from-scratch iteration, byte-identical to the
  program.

## The CU budgeter (`budget.ts`) — and the determinism rule

`estimate(shape) = BASE + Σ (slot_f + rung_f · rungs_i)` over per-family coefficients **measured
on the real engine** (LiteSVM, `test/svm/ecoswap-svm.cu.e2e.test.ts` — the suite re-measures and
alarms past ±25%, and `ECO_SVM_CU_PRINT=1` prints a fresh table for re-pinning). Admission is
greedy under `CU_ADMISSION_BUDGET` (the 1.4M cap minus 15% model headroom, `cuBudget` overrides):
stable slots shed rungs first, then CP slots — round-robin, most rungs first, last index on ties,
so identical pools keep identical ladders — then tail slots drop with a warning, packet-budgeter
style.

**The one place the EVM analog does not transfer**: the EVM recipe adapts its walk to gas at
runtime because its oracle replays the same gas schedule; the SVM solver-reference CANNOT read
GasLeft, so any CU-dependent branching in the solver would break the lamport-exact gate. Rung
counts are therefore fixed at CODEGEN time — a pure function of (shape, budget), mirrored by the
reference from the prepared slots — and GasLeft (0x62) appears exactly once, as a **hard safety
throw** (`"cu"`) before any work when the transaction's compute budget cannot cover the shape's
modeled cost. An all-or-nothing abort can never change a landed split.

## The shape-blob model (stage once, trade many)

`codegen.ts` assembles the solver from **positional family slots** and compiles it
`{ target: 'svm', staged: true }`. ONE compiled blob per **shape** — the ordered list of
`(family, direction, rungs, optional-account layout)` (`shapeKey`) — serves ANY matching pool set:

- pool ACCOUNTS ride the transaction account list at fixed per-slot positions (slot-role refs
  `s<i>:*`), rebound per trade through the resolution map;
- per-trade VALUES ride the payload args as ONE packed bytes `cfg` (u64 LE words:
  `[amountIn][minOut]` then per slot `[enable][…params]`); `encodeEcoSwapSvmTrade` /
  `output.encodeTrade` re-encode for new trades without re-staging;
- the blob is staged once through the buffer protocol (hash-pinned; `stageEcoSwapSvm`) and every
  trade is ONE `execute_from_account` instruction (`executeEcoSwapSvm`).

## The exactness gate + the two oracles

- `solver-reference.ts` — the TS mirror of the quantized solver, transcribed **bit-for-bit**
  (same grids, same merge scan order, same integer ops; stable slots mirror the warm-start chain
  through the adapters' `referenceLadderQuotes`). It is the **lamport-exact gate**: the e2e suites
  assert the engine's returndata equals the mirror evaluated on the same account bytes — including
  after doctored-state drift (a PAUSED saber pool reroutes the whole trade live). It is also the
  **user-facing quote**: `quoteEcoSwapSvm` runs it over fetched account bytes — zero simulation.
- `optimal.ts` — the **continuous** closed-form CP marginal equalization, used ONLY to measure the
  quantization efficiency loss. Never a gate, and CP-class only (the CP form badly understates a
  stable curve's depth).

## Batched loading

Pass `loadMany` (e.g. `kitBatchAccountLoader(rpc)` from `/svm`) instead of `load` and the whole
prepare coalesces into `getMultipleAccounts` sweeps: every single-account read issued in the same
microtask turn joins one deduped batch (chunked at the RPC's 100-account cap), so a k-pool prepare
costs O(dependency-depth) round-trips — pool accounts first, then their vault/config satellites.
Owner checks are preserved through batching: each POOL account's owner is verified against its
family's program id before decoding (`coalescingAccountLoader`'s `expectOwner` hook).

## Usage

```ts
import { ecoSwapSvm, quoteEcoSwapSvm, stageEcoSwapSvm, executeEcoSwapSvm } from '@eco-incorp/sauce-sdk/recipes';
import { kitBatchAccountLoader } from '@eco-incorp/sauce-sdk/svm';

const output = await ecoSwapSvm({
  amountIn, minOut,
  pools: [
    { venue: 'raydium-cp-swap', pool: rayPool },                       // 0to1 (default)
    { venue: 'pumpswap', pool: pumpPool, direction: 'baseToQuote' },   // sell: base in
    { venue: 'saber-stableswap', pool: saberPool },                    // stable: AtoB
  ],
  user: { outAta: 'user:out', inAta: 'user:in', owner: 'payer' },
  loadMany: kitBatchAccountLoader(rpc),                                // or load: <AccountLoader>
});

const staged = await stageEcoSwapSvm(client, 0, output);                // once
await executeEcoSwapSvm(client, staged, output, resolution);            // one instruction per trade
await executeEcoSwapSvm(client, staged, output, resolution, { amountIn: other, minOut });

// When the account list would overflow the 1,232-byte v0 packet, build an ALT
// once per universe and thread it through — the staged blob, hash pin and
// payload args are unchanged; only the transaction assembly gains the table.
if (ecoSwapSvmPacketBudget(output, { resolution, payerAddress: client.payerAddress }).raw.overflowBytes > 0) {
  const alt = await prepareAltForUniverse(client, staged, output, resolution);  // idempotent, reusable
  await executeEcoSwapSvm(client, staged, output, resolution, undefined, { alt });
  await executeEcoSwapSvm(client, staged, output, resolution, { amountIn: other, minOut }, { alt });
}
```

`prepare` reuses the v1 adapters' `fetchPoolConfig` gates (status bits, transfer-fee mints, curve
types — plus prepare-only gates the fragments do not re-check: raydium-v4 status 6/7, damm-v2 and
damm-v1 timestamp activation, damm-v1 fee denominators), filters on **relative depth**
(`L = isqrt(rIn·rOut)`; drop below `minRelBps`/1e4 of ΣL, default 1%, 0 disables), keeps the
deepest `ECO_SVM_MAX_SLOTS` (= 4, the structural template width), and lets the CU budgeter fix
rungs and the effective slot count. `quote.dropped` carries the reason (`depth` | `slots` |
`budget`); `quote.warnings` the degradations.

## Address lookup tables (large account lists)

A staged trade is one `execute_from_account` v0 transaction: `[buffer, …user accounts]` in the
message + the 8-byte discriminator, the flags byte, the 32-byte hash pin, and the packed cfg args
in the instruction data. Each non-fee-payer account costs **33 wire bytes** (a 32-byte static key +
a 1-byte instruction-account index), so the 1,232-byte packet is spent on account keys and cfg
args. `ecoSwapSvmPacketBudget(output, { resolution, payerAddress })` models it (conservative — it
counts plan metas, and the real message dedups repeated keys like shared token/venue programs and
mints, so a shape it flags near the limit may still fit raw).

When the raw packet overflows, **`prepareAltForUniverse(client, staged, output, resolution)`** builds
(or, with `{ existingTable }`, extends) an address lookup table over the buffer + every **non-signer**
account (venue pools/vaults/programs + the user's token accounts; the owner/fee-payer signer stays a
static key — signers cannot be looked up), waits for it to activate, and returns
`{ lookupTableAddress, lookupTables }`. Those keys are as stable as the staged blob, so the table is
**reusable per universe** (shape + pool set + user) across every trade — create once, pass it to
`executeEcoSwapSvm(…, { alt })`, reuse. The call is idempotent: an existing table already covering the
set sends nothing. `RequestHeapFrame` stays add-once and signerless simulate is unaffected — the ALT
only reshapes the account-KEYS section, never the signer set.

The ALT shrinks **bytes, not locks**: `accountLocks = static keys + ALT-resolved keys` is invariant,
so the **64 account-lock cap still binds** (the planner keeps enforcing it — an ALT over 65+ keys
still warns). CALL itself caps at 64 CPI accounts engine-side, and today's shapes sit far below it.

**Overflow threshold (real signed v0 sizes, args-and-account-heaviest family = Orca Whirlpool CLMM,
real swap template):** a 1-slot shape is ~646 B and a **2-slot shape fits raw at ~1,147 B**; a
**3-slot shape overflows at ~1,516 B** → ALT ~744 B (locks ~33). Constant-product families carry
tiny cfg args (raydium-cp is 1 param/slot vs whirlpool's 16) and fewer accounts, so even a 4-slot CP
shape stays ~1,071 B — under the packet. **So the packet is not what caps CLMM stacking: the CU cap
is.** One CLMM/CLOB slot is ~590–790k CU, so two already exceed the 1.4M transaction cap regardless
of the packet; the ALT is the remedy for the account-list growth that arrives with **more CP slots,
real-CPI venue account sets, and the future multihop legs**, once the CU model admits them. See
`test/svm/ecoswap-svm.alt.test.ts` (packet-accounting, no engine) and
`test/svm/ecoswap-svm.alt.e2e.test.ts` (overflow→ALT sizing on a 3× whirlpool shape; a 3× raydium-cp
shape executing lamport-exact + byte-identical through an ALT, reused across trades).

## Measured (LiteSVM `FeatureSet.allEnabled`, real engine.so, 2026-07-06)

The per-family single-slot figures (stand-in CPI, the calibration suite's raw numbers) are in the
**Families** table above; `test/svm/ecoswap-svm.cu.e2e.test.ts` re-measures and alarms past ±25%,
and `ECO_SVM_CU_PRINT=1` prints a fresh table. The split + real-binary figures:

| metric | value |
| --- | --- |
| cp+stable split (pumpswap@3 + saber@2, both engaged) | **1,112,787 CU** (floor 1,165,648; cap 1,400,000) |
| 3-slot CP trade after budgeter degradation [4,3,3] | 1,080,963 CU (was 1,306,797 at [4,4,4] — same split) |
| real-binary quadrilaterals (full trade incl. the venue CPI) | raydium-cp 423,358 CU; pumpswap 506,963 CU; saber 800,198 CU; orca-whirlpool 814,040 CU (real tick cross); manifest 827,465 CU (real CLOB taker match, reverse maker crossed) |
| cp+whirlpool split (whirl@2 + pump@3, both engaged, cut inside the tick window) | 1,127,977 CU |
| cp+raydium-clmm split (clmm@2 + raycp@4, both engaged, CLMM window saturates) | 1,244,705 CU |
| cp+dlmm split (dlmm@2 + raycp@4, both engaged, cut mid-bins) | 1,369,744 CU |
| cp+manifest split (manifest@2 + pump@3, both engaged, cut mid-level) | 1,146,799 CU |
| 2-CLMM packet (whirlpool + raydium-clmm, real swap templates) | raw 1,409 B overflows → ALT 637 B, locks 30 (packet-provable, CU-gated) |
| quantization loss vs continuous | 0.63% on the deliberately shallow Phase-0 universe; second-order on deep pools |

## Real-binary CPI lane (`SAUCE_VENUE_PROGRAMS`)

`test/svm/ecoswap-svm.realcpi.e2e.test.ts` runs the FULL quadrilateral — docs pin ==
`referenceQuote` == in-VM predicted == the realized output of the REAL venue binary — for
raydium-cp-swap (1e6 → 81,443), pumpswap sell (50e9 → 78,539,874; needs `pump-fee.so` too — the
program CPIs GetFees) and saber-stableswap (1e6 → 1,000,603), through the production `patch:'in'`
templates. Point the env var at a directory of `solana program dump`ed binaries named
`<venue slug>.so` (see the suite header); it skips cleanly when absent. Accounts the swaps touch
beyond the quote fixtures (saber's admin-fee destination, pumpswap's fee ATAs) are fabricated at
the adapter-derived addresses; the PUMP mint is Token-2022, so the user's base account rides that
program.

## The second CLMM (raydium-clmm) and the first BIN family (meteora-dlmm)

**Raydium CLMM** reuses the whirlpool WINDOW pattern verbatim — up to 4 initialized-tick boundaries
+ the sequence edge shipped as drift-invariant params, all value-bearing state (sqrt_price/tick/
liquidity live from the pool, trade_fee_rate live from the AmmConfig, per-boundary liquidity_gross +
liquidity_net live from the tick arrays) read in-VM. The compute_swap loop is structurally identical
to whirlpool's (fee-on-input, jump-to-next-initialized-tick), differing only in the primitives:
`delta_1` and `next_sqrt_from_0` are bit-identical to whirlpool's; `delta_0` uses Raydium's NESTED
rounding (Uniswap-V3 getAmount0Delta) and the tick math is the STANDARD Uniswap-V3 magic-constant
ladder (Raydium's MAX_SQRT_PRICE differs from Orca's, so the two need separate tick math). The gate
rejects `fee_on != 0` and any nonzero `dynamic_fee_info` (the newer Raydium program walks
tick-spacing-bounded steps with a per-step volatility fee when dynamic fees are on — classic pools,
all-zero dynamic_fee_info, walk the jump-to-next-tick path this fragment models).

**Meteora DLMM** is the first BIN family — the WINDOW thesis on DISCRETE price bins instead of tick
segments. Bins are buckets `price = (1 + bin_step/1e4)^bin_id` (Q64.64, drift-invariant, shipped as
params); the fragment reads active_id + the volatility v_parameters from the LbPair and each shipped
bin's amount_x/amount_y from its bin array live. Direction (the doc's "inverted" warning, VERIFIED
against `get_bin_array_pubkeys_for_swap`): swap_for_y (X in, Y out) walks DOWN in bin id consuming
amount_y; the reverse walks UP consuming amount_x. The VARIABLE FEE is venue-exact per bin, not a
prepare snapshot: the fragment replicates `update_references(clock)` (the volatility index/reference
decay) + per-bin `update_volatility_accumulator` (vacc grows with |index_reference − bin_id|) +
`compute_variable_fee` over the LIVE volatility state and clock — so the merge sees the real dynamic
fee. Only fee-on-input (collect_fee_mode 0) + no-limit-order pools are walked (the limit-order fill
layers and the OnlyY fee mode are gated).

## The prop-AMM oracle-anchored family (obric-v2) — bake the shape, read the level

Obric V2 is the first PROP-AMM family and the first venue whose price LEVEL is NOT in the pool/vault
state: it lives in a **separate oracle account** the swap already passes (a Pyth-v2-format relay).
The fragment **bakes the drift-invariant SHAPE** (the bigK virtual-reserve curve, targetX, fee, the
oracle scaling — cfg params) and **reads the fast-moving MID live** from the feed every execution,
re-anchoring `targetXK = isqrt(bigK · multY/multX)` in-VM — the SVM analog of the EVM net-cache
(cache the spread, read the mid live). It is a closed-form shifted-constant-product quote (CP-class,
4 rungs), statement-form so the ladder reports the last-good value past capacity (monotone, merge-
safe) while the cold final quote clamps to 0 past capacity (the venue's "Insufficient active" — skip
the CPI). A **sanity band** vs the pool's stored mult self-deactivates a grossly out-of-band / halted
oracle (clamp to 0, the merge redistributes in-instruction). See `docs/svm-venues.md#obric-v2` for
the layout, the oracle scaling, and the honest venue-exactness caveat (the closed-source oracle→mult
derivation is transcribed from the official SDK + cross-checked vs the stored mult; the lamport-exact
gate is unconditional, venue-exactness rests on that + the conservative-fee under-quote + minOut).

**Tiers + the CPI-acceptance probe (`sdk/src/svm/cpi-probe.ts`).** Prop-AMMs are not uniformly
integrable — the barrier is layout / CPI-acceptance, not reading. A prepare-time probe sorts a venue
**P-A** (public readable oracle, permissionless swap — build now: Obric), **P-B** (proprietary
internal-oracle mid, locatable but undocumented/mutable — document + build if stable), **P-C**
(introspecting swap — carries the Instructions sysvar — external-quote-lane or drop). The static
screen flags the Instructions sysvar / non-user signers; the definitive test simulates an
unrecognized-caller swap (`sigVerify:false`) and classifies ACCEPT / REJECT / DEGRADE by the out-ATA
delta. Obric's `fetchPoolConfig` applies the static discriminant directly: a pool whose feed is the
Instructions sysvar (the newer introspecting pools) is gated P-C; a non-Pyth-relay feed
(Doves/Minimox — unpinned layout) is gated P-B. The ranked, on-chain-verified ledger (Obric,
Aquifer, HumidiFi, BisonFi, SolFi, Tessera, ZeroFi, GoonFi, AlphaQ, …) with per-venue evidence lives
in `docs/svm-venues.md`.

## 2-hop routes (A → X → B) — the SVM composite venue

A route splits ONE swap across two sequential single-hop-style splits, chained through the user's
intermediate-token ATA and computed + executed in ONE atomic `execute_from_account` instruction. It is
a *recomposition* of the single-hop machinery — **no new SauceScript intrinsic, no new adapter contract,
no engine change**. Every leg pool is a slot of an existing family reusing its `ladder.ts` fragment
BYTE-FOR-BYTE (`route.ts`'s `emitLegBlock` calls `emitSetup`/`emitQuoteCall`/`emitLadderQuote`/
`emitFinalQuote`/`buildSwapV2`/`referenceQuote` exactly as `codegen.ts` does); the only new codegen is a
second inlined merge phase and an intermediate-delta read between the two.

**The SVM atomicity advantage — why a route is lamport-EXACT, not fold-error bounded.** The EVM QL-legs
shape must PREDICT every leg's output before any swap lands (one `cook()`, no mid-tx re-read), so it
*folds* predicted heads through the legs. Solana lets an instruction **compute → exec → read realized
state → compute → exec**, because after `invoke()` returns, `accountUint` reads the callee's committed
writes (the mechanism the single-hop terminal delta check already uses). So a route runs, in one atomic
instruction:

1. read leg-0 pools live + solve the leg-0 split for `amountIn`;
2. execute ALL leg-0 CPIs (they credit X into the user's intermediate ATA);
3. read the **realized** intermediate delta on that ATA — `realizedX`;
4. solve the leg-1 split on `realizedX` and the (leg-0-independent) live leg-1 pool state;
5. execute ALL leg-1 CPIs (credit B into the user's out ATA);
6. terminal: `realizedB ≥ minOut`.

leg-1 solves on **genuine realized X**, not a predicted fold — so there is no fold-error to bound. The
platform law is obeyed exactly as single-hop: each leg's *entire* split is computed before that leg's
first CPI, and a failing CPI or a `throw` aborts the whole transaction — atomic, no partial fills.

**The exactness keystone.** The single-hop lamport-exact gate already holds per family (`referenceQuote
== in-VM predicted == the real venue binary's realized output`). So per leg-0 venue predicted ==
realized, hence `Σ leg-0 predicted == realizedX`; the off-chain oracle (`routeReference`, composing
`solveReference` twice) builds leg-1's grid on `Σ leg-0 predicted` and gets the IDENTICAL grid the chain
builds on `realizedX`. The composed on-chain returndata equals the oracle **by construction** (absent
genuine drift; drift is caught by `minOut`). This is why **intermediate mints are restricted to classic
SPL (wSOL/USDC/USDT — no transfer fee)** and leg-0 to the exact-quadrilateral families: anything with
`predicted != realized` desyncs the two leg-1 grids.

**cfg / account / CU shape.** The route reuses the packed-`cfg` bytes arg unchanged: `[amountIn][minOut]`
then per FLAT slot `[enable][…params]`, leg-0 slots first, then leg-1 slots — the leg boundary `k0` is
STRUCTURAL (baked into the shape, recoverable from the `route:…>>…` shapeKey), never a cfg word, and
there is **no `realizedX` word** (it is measured on-chain). A 1-CP-per-leg route is `2 + 2·2 = 6 words =
48 B`. The plan is the union of both legs' account sets plus one shared intermediate ATA (`user:inter`,
writable non-signer, leg-0's out ATA and leg-1's in ATA deduped); per-leg `SwapUser` threading is the
only structural change (`buildSwapV2(cfg, i, legUser)` with leg-0 = {A → inter}, leg-1 = {inter → B}).
The returndata is `[fills…][predicted…][realizedX][realizedB]` (`(2k+2)` 32-B words). CU: a route just
runs two single-hop legs back to back, so the family coefficients (which already fold a CPI per slot)
count both legs; `estimateRouteCu = estimateShapeCu(leg0 ++ leg1) + CU_TWO_HOP` adds the second merge
base + the intermediate reads. **Measured (LiteSVM, stand-in CPIs):** a 1+1 raydium-cp route ≈ **776k
CU**, a 2+1 ≈ **975k**, a 2+2 ≈ **946k** (all under the 1.4M cap). The leg-aware budgeter
(`planRouteLadders`) degrades rungs across both legs, then drops only TAIL slots, **never a leg's last
surviving slot** (a route needs ≥ 1 enabled slot per leg or it is not a route); a 1-per-leg route still
over budget at `MIN_RUNGS` throws infeasible. Two heavy legs (CLMM/CLOB) exceed the cap, exactly as two
heavy single-hop slots do.

**Standalone-route-first (Phase 3b).** A swap is EITHER the direct-venue merge OR one 2-hop route — not
both in one instruction (CU + merge-integration grounds; a route can't be a plain ladder slot without
nested merges, which the no-helper-to-helper rule forbids inline). To get the best of both, prepare can
quote BOTH `quoteEcoSwapSvm` and `quoteRouteEcoSwapSvm`, compare `totalOut`/`totalPredicted`, and stage
the winner — a pure off-chain selection. Direct+route mixing (route as a composite venue in the
top-level merge, the EVM shape) is the documented **Phase 3c** follow-up.

**API:** `routeEcoSwapSvm({ amountIn, minOut, leg0Pools, leg1Pools, user, interRef?, … })` →
`{ bytecode, argsLayout, accountPlan, quote, encodeTrade, sha256, leg0Count, leg1Count, … }` (mirrors
`ecoSwapSvm`); `quoteRouteEcoSwapSvm` is the zero-chain composed quote; `stageRouteEcoSwapSvm` /
`executeRouteEcoSwapSvm` are the stage-once/trade-many wrappers (the latter forwards `opts.alt` and
`opts.prepends` — the idempotent intermediate-ATA create, `buildRouteInterAtaPrepend`, belongs in
`prepends`). Routes ~double the account list, so an ALT is effectively mandatory; the single-hop
`prepareAltForUniverse` / `selectEcoSwapSvmAltAddresses` / `ecoSwapSvmPacketBudget` work on the route
output unchanged.

## Honest limits

- **2-hop routes landed** (see above); N>2 hops, and direct+route mixing in one instruction (Phase 3c),
  are follow-ups. Phoenix / OpenBook remain future families on the manifest CLOB pattern.
  (Whirlpools + Raydium CLMM + Meteora DLMM + Manifest landed — see the window notes above.)
- **Route intermediate mints are classic-SPL only** (wSOL/USDC/USDT) and leg-0 venues must be
  exact-quadrilateral families: a transfer-fee mint or a non-bit-exact leg-0 model breaks
  `predicted == realized`, desyncing the composed oracle from the chain (the terminal `minOut` still
  guards realized B under genuine drift, but the quote would no longer be bit-exact).
- **Route CU wall:** only CP-family legs stack comfortably (a 1+1 or 2+1 CP route ≈ 0.8–1.0M CU); one
  CLMM/stable leg + one CP leg is near the cap; two heavy legs are infeasible. A discovery result whose
  BEST route needs a heavy leg is CU-infeasible — the leg-aware budgeter throws, and the off-chain
  direct-vs-route selection falls back.
- **The CLMM windows are 4 boundaries deep, the DLMM window 8 liquid bins deep, per direction**: a
  trade beyond the shipped depth self-caps and the merge reroutes the tail; a live tick/active_id
  drifting past the whole window deactivates the slot until re-prepare.
- **Two CLMM/BIN/CLOB slots exceed the 1.4M CU cap** (each is ~600–830k CU): the packet ALT makes a
  2-CLMM account list fit under 1,232 bytes (proven for whirlpool + raydium-clmm), but the CU wall
  still binds — a CLMM/BIN slot pairs only with the cheap CP families under budget (raydium-clmm+cp
  and dlmm+cp splits execute; whirlpool+raydium-clmm is packet-provable, not CU-executable).
- **Raydium dynamic-fee / `fee_on` pools are gated** (the spacing-bounded volatility-fee walk is a
  follow-up); **DLMM OnlyY-fee / limit-order pools are gated** (the OnlyY split + limit-order fill
  layers are a follow-up); both families are classic-SPL-mint only (transfer-fee mints break the
  realized-delta bound).
- **The whirlpool window is 4 boundaries deep per direction** (WHIRLPOOL_MAX_BOUNDARIES): a
  trade needing more crossings self-caps and the merge reroutes the tail; a live tick that
  drifts past the whole shipped window deactivates the slot until re-prepare. CU is
  state-dependent (~45k per crossed boundary per walk; calibrated at one crossing).
- **The manifest window is 16 top-of-book levels deep per direction** (MANIFEST_MAX_ORDERS): a
  trade beyond that depth saturates and the merge reroutes the tail; a shipped order filled/reused
  since prepare (live sequence_number mismatch) stops the walk from that level (self-deactivation).
  The 16 unrolled live reads over the whole book account are a heavy fixed cost — a manifest slot
  is a degrade-first 'stable'-class family (2-rung default), and the slot CU term scales with the
  shipped-order count.
- **Manifest global orders are gated** (they draw from a separate global account the swap would
  need extra accounts for): the off-chain walk STOPS at the first global maker, exactly as the
  venue's taker IOC halts there without those accounts. Expiring orders (last_valid_slot != 0) are
  likewise a walk-stop (the in-VM model carries no clock). A new better global appearing between
  prepare and execute is the one adverse manifest drift — caught by the terminal minOut, atomic.
- **Whirlpool + manifest Token-2022 markets are gated** (the v1 `swap` instructions are Tokenkeg-only;
  swap_v2 / the optional mint accounts are a follow-up).
- **Ladder quantization**: only the binding venue's marginal rung splits exactly; non-binding
  slots quantize to rung boundaries. Stable slots run 2 rungs by default — their curves are flat,
  so quantization loss there is even lower than CP's.
- **The heaviest pairing is budget-gated**: meteora-damm-v1-stable alone is admissible (940k CU
  modeled), but pairing it with ANYTHING models past the default admission budget — the budgeter
  drops it with a warning rather than forcing it (raise `cuBudget` to override; the GasLeft floor
  still guards the transaction). Two stable slots of any family are near or past the 1.4M cap.
- **Prepare-time gates are not re-checked in-VM** (raydium-v4 status, damm-v2/damm-v1 activation,
  pumpswap fee snapshots): a pool disabled between prepare and execute makes the venue CPI abort
  the transaction — loud and atomic — or, where the fragment reads the byte live (saber's pause),
  the slot quotes 0 and the split reroutes.
- **Disabled slots still read their accounts** (setup reads are unconditional; the enable flag
  skips ladders, merge participation, expensive Newton work and the CPI).
- **Time-dependent quotes** (saber amp ramps, damm-v1 locked-profit decay) evaluate the off-chain
  mirror at `config.now` (default wall clock) while the fragment reads the REAL Clock sysvar — the
  e2e gate pins both to the same instant; production staleness is one-sided decay drift covered by
  minOut. One documented saber divergence: a ramp scheduled to START in the future quotes at the
  target amp (the venue would extrapolate a negative delta); the mirror transcribes the fragment,
  so exactness is unaffected.
- **`sol_remaining_compute_units` under test runtimes**: litesvm's default constructor does not
  register the syscall behind GasLeft — the harness boots with `FeatureSet.allEnabled()` (mainnet
  parity, where the feature is long active).
- **Venue binaries are optional in the default suites** (the stand-in convention): the split,
  ladders and merge run the production path against live account bytes on the real engine, and
  the real venue templates are exercised by the env-gated quadrilateral lane above.

## What landed vs deferred

**Landed.** All four window/curve families beyond the CP+stable base — Orca Whirlpool + Raydium
CLMM (tick-walk CLMM), Meteora DLMM (bin walk), Manifest (CLOB order-window) — plus Obric V2
(oracle-anchored prop-AMM), the **ALT path** (`prepareAltForUniverse` — the two-whirlpool packet
is proven under 1,232 bytes with it), and **2-hop routes** (`route.ts` +
`routeEcoSwapSvm`/`quoteRouteEcoSwapSvm` — the compute-exec-read-realized-compute-exec composite
venue; see "2-hop routes" above). All read every value-bearing field live in-VM; prepare ships
only drift-invariant window structure.

**Deferred (documented).** N>2 hops and **direct+route mixing** in one instruction (route as a
composite venue in the top-level merge — the EVM QL-legs shape); Phoenix / OpenBook on the Manifest
CLOB pattern; per-level (rather than geometric-grid) rungs for the CLOB side to remove the residual
split quantization (needs per-family grid support in codegen + solver-reference); **P-B prop-AMM
builds** (Aquifer, HumidiFi, BisonFi — CPI-open, the work is locating the internal/relay mid
field); Raydium dynamic-fee/`fee_on` and DLMM OnlyY-fee/limit-order pool classes; per-slot
`swapOverride`-style external quotes once a router-integration consumer shows up; and engine
`sauce#204` (a U256 fast path that lifts the slot counts under a heavy shape). See **Honest
limits** for the CU ceilings and exactness caveats that bound today's shapes.
