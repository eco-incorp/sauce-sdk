# EcoSwapSVM (Phase 1)

The Solana sibling of EcoSwap: split ONE swap across multiple venues so the **post-fee marginal
execution prices equalize**, with the whole solve computed **LIVE in one atomic engine
instruction**. Same thesis as the EVM recipe (`../README.md`) — pouring input into the best
marginal price first and stopping at a common level IS the convex optimum — restated for a chain
with no view functions: pool state accounts are attached read-only, the engine's `accountUint`
reads pull the reserves inside the VM, and the quote, the split and the swaps all happen against
the same account state in the same instruction. No off-chain quote can be stale, because there is
no off-chain quote.

Phase 1 extends the Phase 0 skeleton with the **stable-curve class** (Newton iterations in-VM,
warm-started), two more families, the **CU budgeter** (measured per-family coefficients decide
ladder depth and slot count deterministically), the **batched account loader**, and the
**real-binary CPI lane** (the full quadrilateral against venue programs dumped from mainnet).

## Families (adapter contract v2, `sdk/src/svm/venues/*/ladder.ts`)

| family | class | default rungs | live reads |
| --- | --- | --- | --- |
| raydium-cp-swap | CP | 4 | vaults − fee accumulators, AmmConfig fee rates; creator-fee side as a per-trade param |
| raydium-amm-v4 | CP | 4 | vaults − need_take_pnl, swap fee fraction (status 6/7 gate at prepare; Tokenkeg-only) |
| pumpswap | CP | 4 | raw vault balances; fee bps ride as per-trade params; buy and sell directions |
| orca-legacy-token-swap | CP | 4 | raw vault balances; SwapV1 fee fractions as params; floor-min-1 fees, ceiling curve |
| meteora-damm-v2 | sqrt-price | 4 | liquidity, sqrt_price, base+dynamic fee, version cap, band bounds, collect_fee_mode — zero params |
| saber-stableswap | STABLE | 2 | pause byte, vault balances, the four amp-ramp fields, trade fee — zero params |
| meteora-damm-v1-stable | STABLE | 2 | vault share math with locked-profit decay, fees (min-1), amp, multipliers, idle float — zero params |
| orca-whirlpool | CLMM | 2 | sqrt_price, tick, liquidity, fee_rate, per-boundary initialized flags + liquidity_net i128 — the WINDOW (up to 4 initialized-tick boundaries + the sequence edge, with their pure-function sqrt prices) rides the params |
| manifest | CLOB | 2 | the whole order book in one market account; per shipped level a live sequence_number (identity) + price (u128) + num_base_atoms; the top-of-book WINDOW (up to 16 best-first levels as DataIndex+seq) rides the params; zero fee |

A v2 fragment reads the trade amount and the live state at RUNTIME — nothing about the trade is
baked. Direction stays part of the shape (and rung count joined it in Phase 1: `~r<n>` in the
shape key when off the 4-rung default).

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
```

`prepare` reuses the v1 adapters' `fetchPoolConfig` gates (status bits, transfer-fee mints, curve
types — plus prepare-only gates the fragments do not re-check: raydium-v4 status 6/7, damm-v2 and
damm-v1 timestamp activation, damm-v1 fee denominators), filters on **relative depth**
(`L = isqrt(rIn·rOut)`; drop below `minRelBps`/1e4 of ΣL, default 1%, 0 disables), keeps the
deepest `ECO_SVM_MAX_SLOTS` (= 4, the structural template width), and lets the CU budgeter fix
rungs and the effective slot count. `quote.dropped` carries the reason (`depth` | `slots` |
`budget`); `quote.warnings` the degradations.

## Measured (LiteSVM `FeatureSet.allEnabled`, real engine.so, 2026-07-06)

Per-family single-slot trades (stand-in CPI), the calibration suite's raw numbers:

| family | @2 rungs | @4 rungs |
| --- | --- | --- |
| raydium-cp-swap | 270,098 CU | 400,206 CU |
| raydium-amm-v4 | 244,475 CU | 368,773 CU |
| pumpswap | 273,510 CU | 414,269 CU |
| orca-legacy-token-swap | 327,829 CU | 503,191 CU |
| meteora-damm-v2 | 306,903 CU | 471,714 CU |
| saber-stableswap | 778,562 CU | 1,097,079 CU |
| meteora-damm-v1-stable | 940,490 CU | 1,353,318 CU |
| orca-whirlpool | 771,309 CU | 1,142,759 CU |
| manifest | 791,441 CU | 961,890 CU |

| metric | value |
| --- | --- |
| cp+stable split (pumpswap@3 + saber@2, both engaged) | **1,112,787 CU** (floor 1,165,648; cap 1,400,000) |
| 3-slot CP trade after budgeter degradation [4,3,3] | 1,080,963 CU (was 1,306,797 at [4,4,4] — same split) |
| real-binary quadrilaterals (full trade incl. the venue CPI) | raydium-cp 423,358 CU; pumpswap 506,963 CU; saber 800,198 CU; orca-whirlpool 814,040 CU (real tick cross); manifest 827,465 CU (real CLOB taker match, reverse maker crossed) |
| cp+whirlpool split (whirl@2 + pump@3, both engaged, cut inside the tick window) | 1,127,977 CU |
| cp+manifest split (manifest@2 + pump@3, both engaged, cut mid-level) | 1,146,799 CU |
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

## Honest limits (Phase 1 + the Phase 2 whirlpool & manifest families)

- **No multihop routes yet**; Raydium CLMM / Meteora DLMM are future families on the whirlpool
  pattern, Phoenix / OpenBook on the manifest CLOB pattern (Whirlpools + Manifest landed in Phase 2
  — see the CLMM/CLOB window notes above).
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

## Phase 2 notes

Whirlpools + Manifest LANDED (prepare-declared windows + live-value walks; see the CLMM/CLOB window
notes above — the whirlpool ships tick boundaries, the CLOB ships top-of-book order levels, both
read all value-bearing state live). Remaining: Raydium CLMM / Meteora DLMM on the whirlpool pattern
and Phoenix / OpenBook on the CLOB pattern, multihop route legs (each hop its own slot set, the EVM
QL-legs shape), an ALT path for shapes whose account lists outgrow the 1,232-byte packet (a
two-whirlpool shape already needs it: 16 cfg words per CLMM slot plus ~6 accounts; a manifest slot's
cfg is ~33 words but only one account), per-level (rather than geometric-grid) rungs for the CLOB
side to remove the residual split quantization (needs per-family grid support in codegen +
solver-reference), and per-slot `swapOverride`-style external quotes once a router-integration
consumer shows up.
