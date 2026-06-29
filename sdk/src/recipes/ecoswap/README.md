# EcoSwap

EcoSwap is GigaSwap's successor for AMMs that **don't support `sqrtPriceLimitX96`**.

GigaSwap relies on the pool to cap its own fill via a price limit — which only Uniswap-V3-style
pools honour. EcoSwap instead reconstructs each pool's liquidity curve off-chain as **per-tick
brackets**, then on-chain solves the optimal split that **equalises the post-fee marginal execution
price across every pool** (classic water-filling) and does **exactly one swap per pool** (one per hop
for routes). No step function, no per-pool price limit — so V2/constant-product pools get just as
precise a split as concentrated-liquidity pools.

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
1. Discover pools (`shared/pool-discovery`) + multi-hop routes through base tokens. Discovery queries
   **every configured fork** — Uniswap V3, **PancakeSwap V3**, etc. — each across **its own** fee tiers
   (`FactoryConfig.feeTiers`), because forks don't share tiers: Pancake's medium tier is **2500**
   (0.25%) where Uniswap's is 3000 — a single global list would silently miss Pancake's pool.
2. **Filter to deep pools.** Apply an absolute floor (`MIN_LIQUIDITY`) **and** a relative-depth gate:
   drop any pool below **1% of the total discovered liquidity** (`ECO_MIN_REL_BPS`, default 100 bps; 0
   disables). For one token pair, raw active-`L` at spot is comparable across V2 (`≡` a V3 range with
   `L=√k`), V3 and V4, so this is a sound marginal-depth gate — a pool holding a sliver of the combined
   depth would only ever get a dust slice, not worth a swap's gas. Dropped pools are logged (no silent
   caps). Then keep the deepest `ECO_MAX_POOLS`.
3. For each V3 pool: scan a window of ticks in **one Multicall3 round-trip**, reconstruct per-bracket
   `L` from `liquidity()` + `liquidityNet`. **V4** is identical geometry read through the StateView
   lens by `poolId` (`getSlot0`/`getTickLiquidity`). For each V2 pool: one wide bracket discretised
   into geometric steps. For each route: sample input sizes, quote both hops, derive route segments.
4. Fee-adjust each bracket's sqrt boundaries, compute its gross input capacity, and **sort the whole
   ladder descending** by fee-adjusted marginal price.

**On-chain (`ecoswap.sauce.ts`)** — a **K-way-lazy price-ordered merge**: it reads each pool's live state
once in SETUP, then runs ONE merge over two candidate streams — the off-chain-sorted prepared `brackets[]`
(a flat cursor, the **cache**) and each pool's live `dn` frontier (its deeper region, walked
run-until-filled). Each step picks the highest fee-adjusted out/in head among `{brackets[bc], all active
dn[]}`, consumes its segment into `inp[pool]`, and advances ONLY that stream. The cut is **implicit** (where
the merge stops once `cum == amountIn`), and the swaps are computed then pulled (**compute-then-pull**).
This is the optimal equalized split: exact (global price order), lazy (only reconstructs as `cum` needs),
and bit-for-bit with the neutral optimal oracle (`test/ecoswap.optimal.ts`).

**One walk model (drift re-anchoring, both directions symmetric).** At **no drift** the merge consumes the
prepared cache from the window top plus the prepare-time-anchored `dn` seed below it. At **any drift** (UP
against the swap, or DOWN with it) the spot-anchored prepared brackets are stale, so the merge **skips the
whole cache** for that pool and **re-anchors** its `dn` frontier to the LIVE read (live tick / sqrt / active
L), walking ONE continuous tick-lattice grid from the true live spot — byte-identical to the oracle's
continuous-from-live-spot walk. There is no separate `up` frontier: re-anchoring makes drift-UP symmetric to
the proven-exact drift-DOWN path.

For each direct pool the merge does one swap (V3 → flat `swapV3`; V2/V4 → unified `swap(SwapParams)`); routes
allocate whole segments and swap hop1 → hop2. **`prepare.ts` is a gas-optimization cache, not a correctness
dependency** — the solver is exact from live data alone (run-until-filled past any prepared window, even fully
out of range); a quote runs with an empty cache. Compute-then-pull pulls exactly what the swaps consume; one
guarded terminal refund covers the limit-price edge.

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
 │ 1 LENS eth_call — discover + read pools   │        │ Phase A  water-fill → cut    │
 │ 2 filter (abs / rel-depth / top-N)        │  args  │ Phase B  re-anchor to live   │
 │ 3 build brackets (V3/V4 · V2 · route)     │ ─────▶ │          1 swap per pool     │
 │ 4 fee-adjust + capacity                   │bytecode│ refund leftover, send out    │
 │ 5 sort DESC by sqrtAdjNear + trim         │        │                              │
 └──────────────────────────────────────────┘        └──────────────────────────────┘
```

### 1 · Bracket formation

The atomic unit is the `EcoBracket` (`shared/types.ts`), flattened on-chain to `brackets[b][i]`:

```
 EcoBracket                          on-chain tuple index  →  brackets[b][i]
 ┌───────────────┬──────────────────────────────────────────────┬─────┐
 │ kind          │ 0=V3 direct · 1=V2 direct · 2=Route           │ [0] │
 │ refIdx        │ index into pools[] (V3/V2) or routes[] (Route) │ [1] │
 │ sqrtNear      │ spot out/in √P at near (entry) edge — HIGHER   │ [2] │
 │ sqrtFar       │ spot out/in √P at far  (exit)  edge — LOWER    │ [3] │
 │ liquidity  L  │ bracket L (V3); recomputed live for V2         │ [4] │
 │ capacity      │ gross tokenIn to traverse the whole bracket    │ [5] │ ◀─ Phase A
 │ sqrtAdjNear   │ fee-adjusted near = √near·√(1−fee)  ── SORT KEY │ [6] │ ◀─ ladder sort
 │ sqrtAdjFar    │ fee-adjusted far  = √far ·√(1−fee)             │ [7] │ ◀─ threshold
 └───────────────┴──────────────────────────────────────────────┴─────┘
```

**Why fee-adjust (`·√(1−fee)`)?** It converts a pool's *spot* price into its post-fee *marginal
execution* price — what makes a 0.05% pool and a 0.30% pool directly comparable on one axis. That's the
universal sort/threshold coordinate.

**V3/V4 → brackets (`buildV3Brackets`).** Walk the lens's tick window outward from the live tick; at
each initialised boundary active `L` steps by `±liquidityNet`; each constant-`L` span is one bracket.

```
 out/in √price                       (zeroForOne example: swap pushes price DOWN)
   ▲
   │   ┌── REVERSE side (ABOVE spot) ─────────────────────────────────┐
   │   │  capacity FORCED to 0 — invisible to the water-fill cut,      │
   │   │  consumed ONLY by Phase B if live price drifted UP vs prepare │
   │   │   ╎          ╎          ╎      L accrues as MIRROR of forward │
   │   │  [rev2]    [rev1]    [rev0]    zeroForOne rev: L += net       │
   ●───┼───────────── SPOT (live tick at prepare) ──────────────────── ●  base = ⌊tick/ts⌋·ts
   │   │  [fwd0]    [fwd1]    [fwd2] ...                                │
   │   │   ╎          ╎          ╎      forward: L −= net (0→1)         │
   │   │  near=spot  bndry      bndry                                  │
   │   └── FORWARD side (swap direction) ──────────────────────────────┘
   ▼      walk EXACTLY scannedForward / scannedReverse boundaries — never past lens data
          (else you'd fabricate phantom brackets where L is unknown)
```

- **Forward** brackets are the swap path: `L = zeroForOne ? L−net : L+net` per crossing.
- **Reverse** brackets sit above spot with `capacity = 0n`. They exist only so Phase B can re-anchor a
  pool whose live price moved *against* the swap between `prepare()` and execution. `L` accrues by the
  *mirror* rule (`zeroForOne` reverse = price up = `L += net`). The walk is bounded by `scannedReverse`.
- Both loops stop at the lens's `scannedForward`/`scannedReverse` counts so brackets never assume
  liquidity the lens didn't read.

**V2 → brackets (`buildV2Brackets`).** One wide constant-product range, discretised into
`V2_BRACKETS` (16) geometric steps (~0.5% price each) so it slots into the same ladder. `L = √k` is
carried but **recomputed live on-chain** from `getReserves`.

```
 √near ──┐ step −0.25% of √ per bracket
         ├─[v2_0]─┐
         │        ├─[v2_1]─┐
         │        │        ├─[v2_2]─ ... ×16     all share refIdx → same pool
```

**Route (2-hop) → segments (`buildRouteBracketsLocal`).** No on-chain `quote()`: each hop's bracket
curve is walked off-chain by `localQuote` at `ROUTE_SAMPLES` (6) cumulative input samples; each
`(Δin, Δout)` increment becomes a flat segment with `capacity = Δin` and `sqrtAdj = √(Δout·Q192/Δin)`.
Each hop's **real fee** is threaded in (no `feePpm` heuristic).

```
 input samples:  s/6 · amountIn  for s=1..6
   hop1Brackets ──localQuote(in, hop1Fee)──▶ mid ──localQuote(mid, hop2Fee)──▶ out
                         │
   segment_s = { capacity: Δin,  sqrtAdjNear = sqrtAdjFar = √(Δout·2^192/Δin) }
```

### 2 · Filtering

Three gates (`prepareEcoSwap`), then a trim:

```
 all discovered pools (from lens)
        │
        ▼  ① ABSOLUTE floor       p.liquidity ≥ MIN_LIQUIDITY (1e13)
        │
        ▼  ② RELATIVE-depth floor p.liquidity ≥ minRelBps/1e4 · Σliquidity
        │                         (default 100 bps = 1% of combined depth;
        │                          drops dust pools not worth a swap's gas)
        ▼  ③ TOP-N cap            keep deepest MAX_DIRECT_POOLS (12) by L
        │
        ▼  build brackets, fee-adjust, SORT ladder DESC by sqrtAdjNear
        │
        ▼  ④ OFF-CHAIN WATER-FILL PRE-RUN → trim
```

The trim (④) bounds on-chain calldata/gas to the trade *size*, not the fetch window:

```
 sorted ladder (DESC sqrtAdjNear):  [b0][b1][b2][b3][b4][b5][b6][b7][b8]...
                                      └──── Σcapacity ────┘
 walk summing capacity until ≥ amountIn ───────────────▶ cutIdx ─┐
                                                                 │
 KEEP:  every bracket ≤ cutIdx                    ◀── the crossed region
      + SAFETY_TICKS (2) extra per crossed pool   ◀── drift headroom
      ✗ drop brackets of pools the trade never reaches
      (floor at MIN_BRACKETS=8 so tiny trades still split)
```

`capacity=0` reverse brackets sort to the *top* and are kept (above the cut), but add `0` to the
running sum — so the cut index is byte-identical to a world without them.

### 3 · Passing into runtime

`EcoSwapPrepared` is flattened into **bigint-scalar tuples** and handed to the compiler as `args` (the
`.sauce.ts` is static — data rides in as args, not string interpolation):

```
 prepare.ts ─▶ index.ts buildPoolTuple / buildRouteTuple / buildBracketTuple ─▶ compile(args)

 args = [ tokenIn, tokenOut, amountIn, caller, zeroForOne, priceLimit,
          pools[]    each: [poolType,addr,fee,tickSpacing,hooks,feePpm,isV2,inIsToken0,stateView,poolId]
          routes[]   each: [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
          brackets[] each: [kind,refIdx,sqrtNear,sqrtFar,liquidity,capacity,sqrtAdjNear,sqrtAdjFar] ]
                                                          │
                                              compile() ──▼──  Hex[] bytecodes  ──▶  cook()
```

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

A single live-cut sweep, explained below as the equivalent two-phase water-fill (Phase A finds the cut,
Phase B executes at live prices). The solver needed **zero change** for reverse-drift — the `capacity=0`
invariant carries it.

**Phase A — water-fill to the common cut.**

```
 √adj price                  pour amountIn left-to-right along the sorted ladder
   ▲
   │ ███                                                  ladder is sorted so the BEST
   │ ███ ██                                               marginal price is first
   │ ███ ██ ███                                           (greedy = optimal here)
   │ ███ ██ ███ ██ ▒▒  ← partial bracket: solve exact cut
 ──┼─███─██─███─██─▒▒──────────────  cutSqrtAdj  ◀═══ common post-fee marginal price
   │ ███ ██ ███ ██ ▒▒ ░░ ░░ ░░          (every pool equalizes its marginal here)
   │ └── cum += capacity until cum ≥ amountIn ──┘
   ▼   (cap=0 reverse brackets add 0 → invisible to this sum)
```

**Phase B — re-anchor to LIVE price, one swap per pool.** Read the live price
(`slot0`/`StateView`/`getReserves`), convert the cut into that pool's spot target
(`targetSpot = cut / √(1−fee)`), integrate input from live price *down* to the target:

```
   pool's live curve                 hi = min(curSqrt, near)     lo = max(targetSpot, far)
   ▲
   │  curSqrt ●        ← live price (may differ from prepare-time spot)
   │          ┃▓▓▓▓▓   integrate each bracket:
   │          ┃▓▓▓▓▓     effIn += L·2^96·(1/lo − 1/hi)
   │          ┃▓▓▓▓▓   poolInput = Σ effIn / (1−fee)
 ──┼──────────┸──────  targetSpot  (== cutSqrtAdj un-adjusted for this pool's fee)
   │            ░░░░░   below the cut → not filled
   ▼
   ONE swap:  V3 → flat swapV3 (positive amountSpecified)
              V2 → unified swap(SwapParams) poolType=0, L from live reserves, neg amount
              V4 → unified swap(SwapParams) poolType=2, PoolKey + poolId, neg amount
   routes: sum static segment capacities above the cut → swapV3 hop1 → swapV3 hop2
```

Drift handled by clamping `hi`:

```
   price drifted WITH the swap   →  curSqrt < spot  →  hi clamps to curSqrt
                                     (pool already partway; fill only the gap to the cut)

   price drifted AGAINST swap    →  curSqrt > spot  →  hi = a REVERSE bracket's near
                                     (cap=0 brackets supply L above spot; pool still
                                      re-anchors to the cut — no under-fill)
```

Finally: refund any unspent `tokenIn`, forward all `tokenOut` to the caller.

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
| **V2+V3+V4** | `ecoswap.v2v3v4.prodmirror.evm.test.ts` | all three above reproduced onto ONE anvil sharing ONE token pair; one EcoSwap whose water-fill splits across every version at once | (reuses the three snapshots) |
| **All pools** | `ecoswap.allpools.prodmirror.evm.test.ts` | Uniswap V3 ×4 tiers + **PancakeSwap V3 ×4 tiers** (genuine pancake bytecode → `pancakeV3SwapCallback`) + V2 + V4 on ONE anvil; asserts discovery breadth + the relative-depth filter + a cross-fork split | Uni: `prod-snapshot.ts <pool>`; Pancake: `prod-snapshot.ts <pool> pancake` |

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
case re-anchors a Pancake survivor at runtime. The four survivors are fully reconstructed (real tick
profiles); the dropped pools are light-minted at their real price + active liquidity (so discovery sees
them and the filter drops them).

### Runtime re-anchoring (drift) cases

Each prod-mirror test (V2, V3, V4 and the combined one) also has a **drift** case that exercises Phase B's
live-price re-anchoring — the part that a prepare-then-immediately-cook test never touches (there the live
state equals the prepared state). The pattern: snapshot the pristine reconstructed pools, `prepare()` +
compile, then move a pool's price with a **real swap** (`harness/drift.ts` routes one swap through the
engine — `harness/drift.sauce.ts`), and only *then* `cook()` the pre-drift bytecodes. The drift pushes a
pool ~⅓ of its baseline fill toward the cut; the test asserts the recipe filled only the **remaining gap**
(`drift + recipe ≈ baseline`, because gross input from prepared-price → cut is path-additive) and the pool
still re-anchors to the same cut — proving Phase B read the *live* price, not the stale prepared one (had it
used the stale price it would re-spend the full baseline and overshoot the cut). In the combined test the
drifted pool's share shrinks while the untouched pools keep their baseline shares, so the **split adapts at
runtime**.

## Fork test

```sh
BASE_RPC_URL=<url> npx tsx src/recipes/test/ecoswap.test.ts
```

Boots a Base fork pinned to a fixed block, deploys the router, funds/approves, prepares + compiles +
cooks, and asserts on balance deltas, events, and ladder invariants. (Not wired into `npm test`,
which only runs the fork-free compile suite.)

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
  queried across its own `FactoryConfig.feeTiers`. Other AMM families (Curve, Balancer, DODO, TraderJoe
  LB, Maverick, WOOFi) and Algebra/Solidly-stable exotics are excluded in prepare for now (bespoke curve
  math) — they come later.
- **Relative-depth filter:** beyond the absolute `MIN_LIQUIDITY` floor, pools below `ECO_MIN_REL_BPS`
  (default 1%) of the **total** discovered liquidity are dropped so gas isn't wasted on dust pools.
  Sound because, for one pair, raw active-`L` at spot is comparable across V2/V3/V4. Per-call
  `{ minRelBps }` overrides it (0 disables — used by the cross-version split test).
- **Per-source execution path.** V3/V4 concentrated pools are swapped via the router's flat legacy
  `swapV3(pool, tokenIn, tokenOut, amountSpecified, limit, payer, recipient)` (**positive**
  `amountSpecified` = exact input). Constant-product V2 pools go through the unified
  `swap(SwapParams)` entry (`poolType=UniV2`) with a nested `PoolKey` struct and a **negative**
  `amountSpecified` (exact input on that path). Both are self-calls (`payer = recipient = self`).
  Note the engine's `_swapV2` hardcodes the **0.3%** constant-product fee, so every V2 bracket is
  pinned to `feePpm=3000` off-chain to keep the ladder consistent with execution.
- **Multi-hop routes assume V3 hop pools** and execute one `swapV3` per hop (payer = self, so no
  intermediate approval is needed). Route allocations use off-chain-precomputed segment capacities
  (re-anchoring a composed two-curve path live is prohibitively expensive).
- **Phase A uses off-chain bracket capacities** to find the cut; Phase B re-anchors each direct pool
  to its **live** `slot0` price for the actual fill. Under drift the cut is slightly stale but each
  pool's fill tracks its live price, and the budget cap + dust refund keep totals correct. Exact when
  prices haven't moved since prepare.
- **Tick window** is bounded (`V3_TICK_STEPS`, fetched in one multicall) then trimmed to crossed
  ticks + `SAFETY_TICKS`; trades larger than the window clamp and refund unspent input.
- **Env knobs:** `ECO_MAX_POOLS` (default 12), `ECO_MAX_ROUTES` (default 2) bound the on-chain loop;
  `ECO_MIN_REL_BPS` (default 100 = 1% of total liquidity) sets the relative-depth filter (0 disables).
  `prepareEcoSwap` / `ecoSwap` also take a `{ minRelBps }` opt that overrides the env per call.

### SauceScript / compiler notes (hard-won)

- Contract calls **auto-decode**: `IERC20.at(x).balanceOf(y)` returns the value directly (no
  `abi.decode`). Multi-return calls (`slot0()`, `getReserves()`) return an indexable tuple but **must
  be indexed inline** — `slot0()[0]` works, `const s = slot0(); s[0]` reverts.
- Added `Math.mulDiv` and `Math.neg` to the compiler (`compiler/src/globals.ts`, mapping to engine
  opcodes `MUL_DIV=0x28` / `NEG=0x29`). `SUB` is checked, so use `Math.neg` for two's-complement.
- `compile()` takes `baseDirs: string[]` and returns `{ bytecode }`; pass addresses as `BigInt`
  scalars; strict `===` only; no mutable arrays / `.push()`; big constants via `2 ** 96`.
