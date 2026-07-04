# EcoSwap

EcoSwap is GigaSwap's successor for AMMs that **don't support `sqrtPriceLimitX96`**.

GigaSwap relies on the pool to cap its own fill via a price limit — which only Uniswap-V3-style
pools honour. EcoSwap instead walks **each pool's liquidity curve LIVE on-chain** (one frontier per
pool, from its live spot, reusing prepare's drift-invariant per-pool net cache) in ONE price-ordered
merge that **equalises the post-fee marginal execution price across every pool** and does **exactly one
swap per pool** (one per funded leg member per hop for routes). No step function, no per-pool price limit — so V2/constant-
product pools get just as precise a split as concentrated-liquidity pools.

## The unification insight

A constant-product (V2) pool `x·y=k` is mathematically identical to a single Uniswap-V3 liquidity
bracket with `L = √(reserveIn·reserveOut) = √k` spanning the whole price range. So **every** direct
pool — V3 ticks and V2 alike — is represented as brackets in one **out/in** sqrt-price space, and the
on-chain solver runs a single formula:

```
inputForBracket(L, sqrtNear, sqrtFar) = L · 2⁹⁶ · (1/sqrtFar − 1/sqrtNear)      (then ÷ (1−fee))
```

Marginal execution price `(1−fee)·(√P/2⁹⁶)²` is in the same out-wei/in-wei units for all pools, so
they sort into one global ladder regardless of AMM type or fee tier.

## How it works

**Off-chain (`prepare.ts`)**
1. Discover pools (`shared/pool-discovery`) + multi-hop routes through base tokens. Route legs are
   populated per DIRECTED edge (memoized): `discoverQlVenuesForPair` — the same per-pair function the
   direct path uses — attaches direction-stamped quote-ladder venue descriptors to each leg, under
   global pool+venue CLAIMS (a multi-coin venue holding several route tokens is admitted on exactly
   ONE leg, and never both direct and leg). Discovery queries
   **every configured fork** — Uniswap V3, **PancakeSwap V3**, etc. — each across **its own** fee tiers
   (`FactoryConfig.feeTiers`), because forks don't share tiers: Pancake's medium tier is **2500**
   (0.25%) where Uniswap's is 3000 — a single global list would silently miss Pancake's pool.
2. **Filter to deep pools** — done ON-CHAIN by the lens (the single source of truth; prepare never
   re-filters). The relative-depth gate drops any pool below **1% of the Σ IN-RANGE capacity** across the
   crossed ticks (`ECO_MIN_REL_BPS`, default 100 bps; 0 disables) plus a `>0` aliveness gate; the absolute
   `MIN_LIQUIDITY` floor was dropped. In-range capacity (the gross tokenIn a pool absorbs from spot to the
   common cut) is comparable across V2 (`≡` a V3 range with `L=√k`), V3 and V4 — a pool holding a sliver
   would only ever get a dust slice, not worth a swap's gas. The lens reports what it dropped (no silent
   caps); prepare then keeps the deepest `ECO_MAX_POOLS` (a calldata/loop bound, not a liquidity gate).
3. For each V3/V4 survivor: stamp the per-pool NET cache from the lens reads (the stepRatio, the
   scanned-window bounds, the deepest initialized tick, and one `[shiftedTick, rawNet]` row per
   initialized tick). The on-chain solver walks the pool's frontier LIVE and reuses this drift-invariant
   net — it ships NO prepare-time sqrt edges. V2 needs no tick cache (the solver streams constant-L from
   live reserves). Routes ship NO sampled data either: each leg carries its member pools (with their own
   net caches) plus quote-ladder venue DESCRIPTORS — the leg-venue price ladders are built ON-CHAIN in
   setup from live cook-time state. Prepare is an optional cache throughout — EVERY non-CL family
   (Fluid included) ships descriptor-only QL venues; no prepare-sampled segments remain.

**On-chain (`ecoswap.sauce.ts`)** — a **unified per-pool live walk + price-ordered merge**. It reads each
pool's live state once in SETUP, then runs ONE merge over the candidate streams — **each direct pool's single
frontier** (walked from its LIVE spot, one tickSpacing per step, run-until-filled), the merged QL-slice
cursor (every non-CL venue's ladder, built ON-CHAIN in setup from its live quote view / state replay /
bin-walk), plus **each route as a LIVE composite venue**: a route's head is the product fold of its legs' best
member heads, where a leg's members span universe pools (walked with the same frontier code) AND its
on-chain-laddered quote-ladder venues. Each step picks the highest fee-adjusted out/in head among `{all
active pool frontiers, the segment cursor, every route head}`, consumes its segment into `inp[pool]` (route
awards land per-leg via binding-leg events — the binding leg's winning MEMBER crosses one bracket/slice,
every other leg partially fills with conservation at each intermediate), and advances ONLY that stream. The head scan is
**lazy-far**: it computes the near fee-adjusted price for every active pool and the far (the near-tie break)
only for a pool that could win or tie — split-identical, the bulk of the per-pool scan arithmetic saved. The
cut is **implicit** (where the merge stops once `cum == amountIn`), and the swaps are computed then pulled
(**compute-then-pull**). This is the optimal equalized split: exact (global price order), lazy (only
reconstructs as `cum` needs), and bit-for-bit with the neutral optimal oracle (`test/ecoswap.optimal.ts`).

**The unified model (one walk, no two modes).** A tick's `liquidityNet` is **drift-invariant** — the active-L
of a tick range does not change when the spot price moves. The prepare-time sqrt edges are NOT drift-invariant
(a multiplicative grid anchored at the prepare-time spot). So the solver ALWAYS computes sqrt/price on the
LIVE grid (`stepReal` from the live spot — identical to the oracle's continuous-from-live-spot walk) and
reuses only the cached NET: a per-pool cache lookup for an in-window boundary, a `ticks()`/
`getTickLiquidity()` staticcall for an out-of-window one. Same grid, same nets ⇒ wei-exact with the oracle by
construction, for ANY drift in either direction — no drift gate, no stale-skip, no re-anchor branch. A pool is
**never** deactivated while liquidity is known ahead: it walks THROUGH interior `dL==0` gaps and deactivates
only on the price limit, the per-pool budget cap, or (`dL==0` AND the boundary past the pool's deepest
initialized tick).

For each direct pool the merge does one swap (V3 → flat `swapV3`; V2/V4 → unified `swap(SwapParams)`); a
route executes chain-order — each leg reads its REALIZED input balance and splits it proportionally across
its funded members through ONE unified dispatch (leg pools + all 16 quote-ladder families), with a per-route
intermediate sweep returning residual mid-route dust. **`prepare.ts` is a gas-optimization cache, not a correctness
dependency** — the solver is exact from live data alone (`windowTop=0` ⇒ every boundary staticcalls, the
1-RPC quote path with no prepared ticks). Compute-then-pull pulls exactly what the swaps consume; one guarded
terminal refund covers the limit-price edge.

Equal post-fee marginal price at the cut ⇒ synchronized minimal slippage across all venues.

## Data format & algorithms (deep dive)

This section walks the full path — bracket **formation → filtering → handoff into runtime →
execution** — with the exact data structures at each boundary.

### The one idea everything rests on

Every pool (Uniswap V3 ticks, a V4 singleton, **and** a constant-product V2 pool) is represented as
**brackets in a common "out/in" √-price space**:

```
  A constant-product (V2) pool  ≡  ONE Uniswap-V3 liquidity range
                                    with  L = √(reserveIn · reserveOut) = √k

  So the whole solver runs ONE formula for every pool, every version:
     effIn   = L · 2^96 · (1/√far − 1/√near)        (token-in to walk a bracket)
     grossIn = effIn / (1 − fee)
     dOut    = L · (√near − √far) / 2^96            (token-out produced)
```

All √ values are `Q96`, oriented **out-per-in** so price *falls* as the swap proceeds → `√near > √far`.
(`zeroForOne`: real √ is already out/in. `oneForZero`: invert via `Q192/√real`.)

### Pipeline at a glance

```
 off-chain (prepare.ts)                              on-chain (ecoswap.sauce.ts, via cook())
 ┌──────────────────────────────────────────┐        ┌──────────────────────────────┐
 │ 1 LENS eth_call — discover/read/filter    │        │ SETUP  read each pool's LIVE │
 │ 2 top-N cap (calldata bound)              │  args  │        spot, seed 1 frontier  │
 │ 3 stamp per-pool NET cache (V3/V4)        │ ─────▶ │ MERGE  live walk → equalized │
 │   + V2 (no cache) + route segments        │bytecode│        split, 1 swap per pool │
 │ 4 sort route segments DESC sqrtAdjNear    │        │ refund leftover, send out    │
 └──────────────────────────────────────────┘        └──────────────────────────────┘
```

### 1 · Per-pool net cache (DIRECT + leg pools) + live route legs

NO pool ships `EcoBracket`s on-chain — direct pools AND route-leg pools carry the per-pool net cache
(§ above) and are walked LIVE (a leg pool is byte-identical to a direct pool: its swap direction rides
the per-pool `inIsToken0` field, so it reuses the same frontier code). Route legs additionally carry
quote-ladder venue DESCRIPTORS (no sampled values); the solver builds each leg venue's price ladder
ON-CHAIN in setup, quoted on the leg's EDGE pair and sized by the chain-order live fold of `amountIn`
through the upstream legs' live heads. `EcoBracket` survives only OFF-CHAIN, inside the neutral oracle's
route composition (`test/ecoswap.optimal.ts` / `test/ecoswap.math.ts`), which the on-chain solver is
held wei-exact against.

**Why fee-adjust (`·√(1−fee)`)?** It converts a pool's *spot* price into its post-fee *marginal
execution* price — what makes a 0.05% pool and a 0.30% pool directly comparable on one axis. That's the
universal sort/threshold coordinate.

**Direct V3/V4 → per-pool NET cache (`stampPoolCache`).** Direct pools ship NO prepare-time brackets. The
on-chain solver walks each pool's frontier LIVE (`stepReal` from the live spot, one tickSpacing per step)
and at each initialised boundary steps active `L` by `±liquidityNet`. prepare ships only the
**drift-invariant net** so that walk skips a staticcall for the scanned window:

```
 out/in √price                       (zeroForOne example: swap pushes price DOWN)
   ▲
   ●───────────── SPOT (read LIVE on-chain in SETUP) ───────────────── ●  base = ⌊tick/ts⌋·ts
   │   │  [step0]   [step1]   [step2] ...                              │
   │   │   ╎          ╎          ╎      forward: L −= net (zeroForOne) │
   │   │  near=live  bndry      bndry                                  │
   │   └── swap direction — one frontier walked run-until-filled ──────┘
   ▼      net comes from the per-pool cache IN-WINDOW (a staticcall avoided), else from a
          live ticks()/getTickLiquidity staticcall — the same drift-invariant value either way
```

- The cache rows are `[shiftedTick, rawNet]` for every INITIALIZED tick (sorted swap-direction); an
  in-window uninitialized tick is net 0 with no row and no staticcall.
- The walk computes ALL sqrt on the LIVE grid, so a runtime price drift just starts the same walk from a
  different live spot — no separate reverse/up frontier, no re-anchor branch (`liquidityNet` is invariant).

**Routes need NO off-chain sampling.** A route is advanced on-chain by binding-leg EVENTS: each leg
elects its binding MEMBER (strict-near win, near-tie broken by strictly-higher far, pools before
venues) among its pool frontiers and its venue-ladder cursors; the route head is the product fold of
the per-leg best heads and competes in the same merge as a direct pool. A pool member advances by
crossing one tickSpacing bracket (the ordinary frontier step); a venue member advances by consuming one
ladder SLICE (binding full-cross / upstream floor inversion / downstream clamp), with conservation at
every intermediate (leg i out == leg i+1 in). The off-chain mirrors (`ecoswap.math.ts` shared math,
`ecoswap.optimal.ts` oracle, `ecoswap.solver-reference.ts`) transcribe the same event/election ops
bit-for-bit.

### 2 · Filtering

Survivorship is decided ON-CHAIN by the lens (the single source of truth — prepare never re-filters), then
prepare applies only a top-N calldata bound:

```
 all discovered alive pools (in the lens)
        │
        ▼  ① ALIVENESS gate       in-range capacity > 0
        │
        ▼  ② RELATIVE-depth floor capacity ≥ minRelBps/1e4 · Σ in-range capacity
        │                         (default 100 bps = 1% of combined IN-RANGE depth;
        │                          drops dust pools not worth a swap's gas — the
        │                          absolute MIN_LIQUIDITY floor was dropped)
        │  ── lens returns survivors-only ──▶ prepare
        │
        ▼  ③ TOP-N cap            keep deepest MAX_DIRECT_POOLS (12) by L (a calldata bound)
```

In-range capacity is the gross tokenIn a pool absorbs from spot to the common cut (NOT spot active-L), so it
is comparable across V2/V3/V4 and does not over-reward a thin band of huge liquidity right at spot. There is
NO off-chain ladder/water-fill/trim for direct pools — the on-chain solver walks each survivor's frontier
LIVE and reuses the per-pool net cache, so on-chain gas scales with the trade size, not the fetch window.

### 3 · Passing into runtime

`EcoSwapPrepared` is flattened into **bigint-scalar tuples** and handed to the compiler as `args` (the
`.sauce.ts` is static — data rides in as args, not string interpolation):

```
 prepare.ts ─▶ index.ts buildSolverArgs (buildUniverseRoutingAndQlv) ─▶ compile(args)

 args = [ cfg        = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount,
                        fluidResolver?, mentoBroker?, balV3Router?, minOut?, balV3Vault?,
                        balV2Vault?, directQlvCount?]        (ONE scalar tuple — 6-arg shape)
          pools[]    each: [poolType,addr,fee,tickSpacing,hooks,feePpm,isV2,inIsToken0,stateView,poolId,
                            stepRatio,windowTopShifted,windowBotShifted,extremeShifted,netStart,netCount,
                            isKyber]   — the FLAT UNIVERSE: direct pools then leg pools (deduped)
          netCache[] each: [shiftedTick, rawNet]   (per-pool grouped, sorted swap-direction)
          routing[]  each: [legCount, {poolBase,poolCount,qlvBase,qlvCount,inter} × legCount] (stride 5)
          segs[]     each: [refIdx, capacity, sqrtAdjNear, sqrtAdjFar, segKind, venue, venueAux]
                           (VESTIGIAL — always [] in production: every family is QL now; kept so
                           the 6-arg shape the hand-built test universes pin stays stable)
          qlv[]      each: [poolAddr, i, j, feePpm, segKind, refIdx, c6..c9, routeIdx, legIdx]
                           (12 cols; direct rows first, then per-(route,leg) rows — cfg[12] splits) ]
                                                          │
                                              compile() ──▼──  Hex[] bytecodes  ──▶  cook()
```
(`zeroForOne` is derived on-chain from the token sort order, not passed. The 6-arg cfg-bundle shape
keeps `main()` small enough for the v12 arg-prologue.)

The data *into* `prepare` comes from the **lens** — one read-only `cook()` eth_call returning two raw
byte blobs (the VM can't build runtime arrays, so it `concat`-accumulates fixed-stride words,
sign-recovered off-chain via `BigInt.asIntN`):

```
 abi.encode(poolBlob: bytes, tickBlob: bytes)

 poolBlob — 13 words / pool:
 ┌────┬──────┬─────┬───────────┬───────┬──────┬─────┬────────┬──────────┬──────────┬──────┬───────────┬───────────┐
 │type│ addr │ fee │tickSpacing│ hooks │sqrtP │ liq │tickRaw │inIsToken0│stateView │poolId│scanForward│scanReverse│
 │ [0]│ [1]  │ [2] │   [3]     │  [4]  │ [5]  │ [6] │  [7]   │   [8]    │   [9]    │ [10] │   [11]    │   [12]    │
 └────┴──────┴─────┴───────────┴───────┴──────┴─────┴────────┴──────────┴──────────┴──────┴───────────┴───────────┘
                                                signed int24 ◀┘                          lazy-walk counts ◀┘

 tickBlob — 3 words / row:  [ poolIdx | tickIndexRaw (int24) | liquidityNetRaw (int128) ]
```

### 4 · Executing on-chain (`ecoswap.sauce.ts`)

**SETUP — seed one frontier per pool from the LIVE spot.** Read each pool's live state
(`slot0`/`StateView`/`getReserves`) and seed its single frontier (real sqrt + boundary + active L). Cache
the per-pool fee factor `√(1−fee)` once (an integer sqrt) for the hot head-price comparison.

**MERGE — one price-ordered walk to the equalized split.** Each step, among all active pool frontiers and
the route cursor, pick the highest fee-adjusted out/in head and advance ONLY it:

```
 √adj price                  the live walk reconstructs segments lazily as cum needs
   ▲
   │ ███   each step integrates ONE pool's next tickSpacing segment on the LIVE grid:
   │ ███ ██   effIn = L·2^96·(1/farOI − 1/nearOI),  grossIn = effIn/(1−fee)
   │ ███ ██ ███   the net at the crossed boundary comes from the per-pool cache
   │ ███ ██ ███ ██ ▒▒  ← crossing clamp when cum+gross ≥ amountIn
 ──┼─███─██─███─██─▒▒──────────────  cut  ◀═══ common post-fee marginal price
   │ ███ ██ ███ ██ ▒▒ ░░ ░░ ░░         (every engaged pool equalizes its marginal here)
   ▼   lazy-far head scan: a pool's far (the near-tie break) is computed only if its
       near could win or tie — the bulk of the per-step scan arithmetic is skipped
```

Head-price selection is on the LIVE grid, so a runtime price drift just starts the same walk from a
different live spot — `liquidityNet` is drift-invariant, so the net at each tick (cache or staticcall) is
the same value either way. There is no reverse/up frontier and no re-anchor branch.

**One swap per pool.** After the merge, each pool's accumulated `inp[pool]` is swapped once:

```
   ONE swap:  V3 → flat swapV3 (positive amountSpecified)
              V2 → unified swap(SwapParams) poolType=0, L from live reserves, neg amount
              V4 → unified swap(SwapParams) poolType=2, PoolKey + poolId, neg amount
   routes: chain-order per leg — read the REALIZED leg input balance, split it
           proportionally across the leg's funded members (pools + quote-ladder
           venues, ONE unified 13-family dispatch; last funded member absorbs
           division dust), then a per-route intermediate sweep
```

Compute-then-pull: the merge is read-only, so the solver `transferFrom`s exactly the merged `cum`, then
executes. Finally a guarded terminal refund returns any limit-price-edge leftover, and all `tokenOut` is
forwarded to the caller.

**Why greedy = optimal, and why one swap per pool.** Because the ladder is sorted by fee-adjusted
*marginal* price, pouring input into the best marginal first and stopping at a common level *is* the
convex optimum (marginal-price equalisation = no beneficial reallocation remains). And since each
pool's contribution is one contiguous integral from its live price down to the shared target, it
collapses to a **single swap per pool** — no per-pool price limit needed, which is exactly what lets it
serve V2/Solidly pools that don't support `sqrtPriceLimitX96`.

## Usage

```sh
pnpm sync-artifacts                                           # populate sdk/src/artifacts/ (once)
npm run start:fork https://base-mainnet.example/v2/KEY        # boot fork + deploy router
npm run recipe ecoswap WETH USDC 1
npm run stop
```

Programmatic:

```ts
import { ecoSwap } from "./recipes/ecoswap";
const { bytecodes, prepared } = await ecoSwap(
  { tokenIn, tokenOut, amountIn }, rpcUrl, sauceRouterAddress, caller,
);
// cook(bytecodes)
```

## Prod-mirror tests (real Base pool state, run offline)

For each AMM version, a **prod-mirror** test replays a REAL Base pool's state — captured into a
checked-in snapshot — on a fresh local anvil, then runs EcoSwap through it. No live RPC at test time.

| Version | Test | Reproduction | Recapture |
| --- | --- | --- | --- |
| V3 | `ecoswap.prodmirror.evm.test.ts` | real `@uniswap/v3-core` + minted tick profile (391 boundaries) | `BASE_RPC_URL=<url> npx tsx src/recipes/test/harness/prod-snapshot.ts` |
| V2 | `ecoswap.v2.prodmirror.evm.test.ts` | etched canonical pair funded to captured reserves; asserts output == exact constant-product | `… src/recipes/test/harness/v2-snapshot.ts` |
| V4 | `ecoswap.v4.prodmirror.evm.test.ts` | etched real PoolManager+StateView; pool re-minted to captured tick profile | `… src/recipes/test/harness/v4-snapshot.ts` |
| **V2+V3+V4** | `ecoswap.v2v3v4.prodmirror.evm.test.ts` | all three above reproduced onto ONE anvil sharing ONE token pair; one EcoSwap whose live walk splits across every version at once | (reuses the three snapshots) |
| **All pools** | `ecoswap.allpools.prodmirror.evm.test.ts` | Uniswap V3 ×4 tiers + **PancakeSwap V3 ×4 tiers** (genuine pancake bytecode → `pancakeV3SwapCallback`) + V2 + V4 on ONE anvil; asserts discovery breadth + the relative-depth filter + a cross-fork split | Uni: `prod-snapshot.ts <pool>`; Pancake: `prod-snapshot.ts <pool> pancake` |
| **Per family** | `ecoswap.<family>.prodmirror.evm.test.ts` | every venue family (curve/crypto/dodo/lb/solidly/euler/fermi/fluid/mento/balancer/balancerv3/maverick/slipstream/algebra/algebraintegral/topaz/projectx/…) replays a REAL captured pool — wei-exact both engines + a drift case | `… src/recipes/test/harness/<family>-snapshot.ts` |

The V3 reproduction mints one position per initialised boundary, so it is a **heavy** test (~10 min) —
the V2/V4 ones are fast (seconds). The combined V2+V3+V4 test inherits the V3 cost (also ~10 min): it
replays all three real Base WETH/USDC pools (V2 constant-product, V3 0.05%, V4 0.30%) on a single
anvil, sized so the deepest/cheapest V3 pool's marginal price is pushed below the V2/V4 0.30% tiers,
forcing the solver to allocate a slice to **every** pool — and asserts a tokenIn delta in all three
plus an exact constant-product output on the V2 leg. It also asserts the **marginal-price equalization**
invariant: after the swap the pools sit at *different* spot prices (offset by their fee tiers) whose
fee-adjusted marginals all converge on the solver's cut (to ~5 ppm). All are part of
`pnpm --filter './sdk' test:recipes:evm`.

### All-pools test (discover → filter → split across forks)

`ecoswap.allpools.prodmirror.evm.test.ts` is the "give it everything, then filter" test. It reproduces
the FULL real Base WETH/USDC universe on ONE anvil sharing ONE token pair: Uniswap V3 at all four tiers,
**PancakeSwap V3 at all four tiers** (deployed from the npm package's prebuilt pool creation bytecode via
the `PancakeV3Deployer` fixture — genuine pancake pools that call `pancakeV3SwapCallback`, since pancake
ships no factory/deployer source), the V2 pair and the V4 singleton. It asserts the improved prepare
phase end to end: (1) `discoverPools` surfaces **all ten** pools across both forks and every tier
(per-factory fee tiers catch Pancake's 2500, which a single global list misses); (2) the relative-depth
filter (1% of total liquidity) keeps only the genuinely-deep pools — on the real snapshots that is
Uniswap 0.05% + 0.30% and **both** deep Pancake pools (0.01% + 0.05%), dropping the thin V2/V4 pools and
shallow tiers; (3) ONE EcoSwap splits across **both forks** in a single `cook()` (exercising
`uniswapV3SwapCallback` AND `pancakeV3SwapCallback`) with post-fee marginals equalized; and (4) a drift
case adapts a Pancake survivor's fill to its live price at runtime. The four survivors are fully reconstructed (real tick
profiles); the dropped pools are light-minted at their real price + active liquidity (so discovery sees
them and the filter drops them).

### Runtime drift (live-walk adaptation) cases

Each prod-mirror test (V2, V3, V4 and the combined one) also has a **drift** case that exercises the live
walk's runtime adaptation — the part that a prepare-then-immediately-cook test never touches (there the live
state equals the prepared state). The pattern: snapshot the pristine reconstructed pools, `prepare()` +
compile, then move a pool's price with a **real swap** (`harness/drift.ts` routes one swap through the
engine — `harness/drift.sauce.ts`), and only *then* `cook()` the pre-drift bytecodes. The drift pushes a
pool ~⅓ of its baseline fill toward the cut; the test asserts the recipe filled only the **remaining gap**
(`drift + recipe ≈ baseline`, because gross input from prepared-price → cut is path-additive) and the pool
still reaches the same cut — proving the solver walked from the *live* price, not the stale prepared one (had
it used the stale price it would re-spend the full baseline and overshoot the cut). In the combined test the
drifted pool's share shrinks while the untouched pools keep their baseline shares, so the **split adapts at
runtime**.

## Fork test

```sh
BASE_RPC_URL=<url> npx tsx src/recipes/test/ecoswap.test.ts
```

Boots a Base fork pinned to a fixed block, deploys the router, funds/approves, prepares + compiles +
cooks, and asserts on balance deltas, events, and ladder invariants. (Not wired into `npm test`,
which only runs the fork-free compile suite.)

`ecoswap.chains.fork.test.ts` is the manual **network** tier: one parametrized runner over the covered
chains (per-chain env-gated `<CHAIN>_RPC_URL`, skip-when-absent; block-pinned anvil forks so re-runs hit
anvil's disk cache). It runs real discovery + prepare via each chain's `CHAIN_POOL_CONFIGS` entry, a
read-only `quoteEcoSwap`, and on BSC a landed `cook()` asserted against the quote. The Celo
known-failure note lives in-file.

## Status

**Verified across Uniswap V2, V3 and V4** on a local EVM simulation (anvil, no fork) running against
**real protocol bytecode** — see `src/recipes/test/ecoswap.evm.test.ts` (`pnpm --filter './sdk' test:recipes:evm`):

- **V3** — real `@uniswap/v3-core` factory + minted concentrated liquidity; multi-pool split with
  marginal-price equalization.
- **V2** — the canonical constant-product pair runtime **etched** into anvil; swapped via the unified
  `swap(SwapParams)` path. Mixed V2+V3 split verified.
- **V4** — the **real Base PoolManager + StateView runtime etched** at their canonical addresses (so
  StateView's baked-in `poolManager` immutable resolves), a pool initialised + funded through the real
  singleton, then swapped via `swap(SwapParams)` (`poolType=UniV4`). Solo V4 and a V3+V4 split verified.
- **PancakeSwap V3** — a **genuine pancake pool** (the npm package's prebuilt `PancakeV3Pool` bytecode,
  deployed locally via the `PancakeV3Deployer` fixture) swaps through the engine's `pancakeV3SwapCallback`
  path. The all-pools test discovers all four Pancake tiers (incl. 2500) and splits across Uniswap +
  Pancake in one EcoSwap, with the relative-depth filter dropping the shallow pools.

Also **verified end-to-end on a Base mainnet fork** for direct V3 swaps + multi-hop routes
(`BASE_RPC_URL=<url> npx tsx src/recipes/test/ecoswap.test.ts`).

## Supported sources & compromises

- **Sources:** Uniswap **V2** (constant-product), **V3** (concentrated), and **V4** (singleton), plus any
  V3-style **fork** (e.g. **PancakeSwap V3**) registered as a `V3Standard`/`V2Standard` factory — each
  queried across its own `FactoryConfig.feeTiers` — AND the quote-ladder venue families
  (Curve StableSwap/CryptoSwap, Solidly-stable, WOOFi, Trader Joe LB, Mento, DODO V2, Wombat, Fermi,
  EulerSwap, Balancer V2/V3, Maverick V2, Fluid DEX, Tessera V, ElfomoFi, Metric). All 17 leg-capable families compete
  both as DIRECT venues and as ROUTE-LEG members. **Algebra** (Camelot/QuickSwap V3, Ramses V2) is
  SUPPORTED (discover + price + execute): its curve
  is V3-identical (so it prices wei-exact via the V3 oracle), and the engine now EXECUTES it — an Algebra
  pool re-enters via `algebraSwapCallback`, a selector the Router services (a mirror of
  `uniswapV3SwapCallback`/`pancakeV3SwapCallback` → `_handleV3Callback`, sauce#186). It routes as
  UniV3 / `swapV3`; discovery includes it and the lens defaults `includeAlgebra=true`. The wei-exact
  local-EVM round-trip (discover → price → cook through `algebraSwapCallback` on v1 + v12) is
  `test/ecoswap.algebra.evm.test.ts` (a local `AlgebraPool.sol` adapter over a genuine V3 pool); the
  off-chain decode/oracle vectors are `test/ecoswap.algebra.test.ts`. See
  `../../../LIQUIDITY_SOURCES_FEASIBILITY.md` §3.
- **Relative-depth filter:** pools below `ECO_MIN_REL_BPS` (default 1%) of the **total IN-RANGE
  capacity** across the crossed ticks are dropped so gas isn't wasted on dust pools (the absolute
  `MIN_LIQUIDITY` floor was dropped; a `>0` aliveness gate remains). The filter lives in the LENS
  (the single source of truth — prepare never re-filters). Sound because, for one pair, in-range
  capacity is comparable across V2/V3/V4. Per-call `{ minRelBps }` overrides it (0 disables — used by
  the cross-version split test).
- **Per-source execution path.** V3/V4 concentrated pools are swapped via the router's flat legacy
  `swapV3(pool, tokenIn, tokenOut, amountSpecified, limit, payer, recipient)` (**positive**
  `amountSpecified` = exact input). Constant-product V2 pools go through the unified
  `swap(SwapParams)` entry (`poolType=UniV2`) with a nested `PoolKey` struct and a **negative**
  `amountSpecified` (exact input on that path). Both are self-calls (`payer = recipient = self`).
  Note the engine's `_swapV2` hardcodes the **0.3%** constant-product fee, so every V2 pool is pinned
  to `feePpm=3000` off-chain to keep its marginal consistent with execution.
- **Multi-hop routes are full EcoSwaps per leg.** An N-hop route is a LIVE composite venue: each leg
  splits across ALL its members — universe pools (V2/V3/V4/Algebra families, walked live like direct
  pools) and the 16 quote-ladder families (leg-venue ladders built on-chain in setup, sized by the
  chain-order live fold). Route allocations are inside the per-wei live-walk gate (wei-exact vs the
  oracle/reference mirrors); execution is chain-order per leg with a per-route intermediate sweep.
- **Direct pools are exact under drift.** The solver walks each pool's frontier from its LIVE spot on
  the live grid and reuses only the drift-invariant per-pool net cache — so a runtime price drift just
  starts the same walk from a different spot, wei-exact with the neutral oracle either way (no stale
  cut). The per-pool budget cap + a guarded terminal refund keep totals correct on the limit-price edge.
- **Tick window** is bounded (`V3_TICK_STEPS`, fetched in one lens eth_call); the on-chain walk runs
  past it via staticcalls when a trade reaches beyond the cached window (run-until-filled).
- **Env knobs:** `ECO_MAX_POOLS` (default 12), `ECO_MAX_ROUTES` (default 8) bound the on-chain loop;
  `ECO_MAX_ROUTES=0` disables routes OUTRIGHT — prepare then skips the route DFS entirely, including
  its per-edge lens eth_calls (it never pays edge-read cost for routes it cannot admit, and once the
  cap is reached mid-DFS the remaining subtree is pruned before any further edge read).
  `ECO_MIN_REL_BPS` (default 100 = 1% of total in-range capacity) sets the relative-depth filter (0 disables).
  `prepareEcoSwap` / `ecoSwap` also take a `{ minRelBps }` opt that overrides the env per call.

### SauceScript / compiler notes (hard-won)

- Contract calls **auto-decode**: `IERC20.at(x).balanceOf(y)` returns the value directly (no
  `abi.decode`). Multi-return calls (`slot0()`, `getReserves()`) return an indexable tuple but **must
  be indexed inline** — `slot0()[0]` works, `const s = slot0(); s[0]` reverts.
- Added `Math.mulDiv` and `Math.neg` to the compiler (`compiler/src/globals.ts`, mapping to engine
  opcodes `MUL_DIV=0x28` / `NEG=0x29`). `SUB` is checked, so use `Math.neg` for two's-complement.
- `compile()` takes `baseDirs: string[]` and returns `{ bytecode }`; pass addresses as `BigInt`
  scalars; strict `===` only; no mutable arrays / `.push()`; big constants via `2 ** 96`.
