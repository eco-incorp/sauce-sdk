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
1. Discover pools (`shared/pool-discovery`) + multi-hop routes through base tokens.
2. For each V3 pool: scan a window of ticks in **one Multicall3 round-trip**, reconstruct per-bracket
   `L` from `liquidity()` + `liquidityNet`. **V4** is identical geometry read through the StateView
   lens by `poolId` (`getSlot0`/`getTickLiquidity`). For each V2 pool: one wide bracket discretised
   into geometric steps. For each route: sample input sizes, quote both hops, derive route segments.
3. Fee-adjust each bracket's sqrt boundaries, compute its gross input capacity, and **sort the whole
   ladder descending** by fee-adjusted marginal price.

**On-chain (`ecoswap.sauce.ts`)**
- **Phase A** — walk the pre-sorted ladder once, summing capacity until `amountIn` is reached, to find
  the common marginal-price cut `cutSqrtAdj` (the water-fill level).
- **Phase B** — for each direct pool, re-read its **live** price (V3 `slot0` / V4 `StateView.getSlot0`
  by poolId / V2 `getReserves`), integrate the exact input to move from the live price down to the cut,
  and do one swap (V3 → flat `swapV3`; V2/V4 → unified `swap(SwapParams)`). Routes allocate whole
  segments above the cut and swap hop1 → hop2. Unspent dust is refunded.

Equal marginal price at the cut ⇒ synchronized minimal slippage across all venues.

## Usage

```sh
pnpm sync-artifacts                                           # populate dev-tools/artifacts/ (once)
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
| V3 | `ecoswap.prodmirror.evm.test.ts` | real `@uniswap/v3-core` + minted tick profile (391 boundaries) | `BASE_RPC_URL=<url> npx tsx recipes/test/harness/prod-snapshot.ts` |
| V2 | `ecoswap.v2.prodmirror.evm.test.ts` | etched canonical pair funded to captured reserves; asserts output == exact constant-product | `… recipes/test/harness/v2-snapshot.ts` |
| V4 | `ecoswap.v4.prodmirror.evm.test.ts` | etched real PoolManager+StateView; pool re-minted to captured tick profile | `… recipes/test/harness/v4-snapshot.ts` |
| **V2+V3+V4** | `ecoswap.v2v3v4.prodmirror.evm.test.ts` | all three above reproduced onto ONE anvil sharing ONE token pair; one EcoSwap whose water-fill splits across every version at once | (reuses the three snapshots) |

The V3 reproduction mints one position per initialised boundary, so it is a **heavy** test (~10 min) —
the V2/V4 ones are fast (seconds). The combined V2+V3+V4 test inherits the V3 cost (also ~10 min): it
replays all three real Base WETH/USDC pools (V2 constant-product, V3 0.05%, V4 0.30%) on a single
anvil, sized so the deepest/cheapest V3 pool's marginal price is pushed below the V2/V4 0.30% tiers,
forcing the solver to allocate a slice to **every** pool — and asserts a tokenIn delta in all three
plus an exact constant-product output on the V2 leg. It also asserts the **marginal-price equalization**
invariant: after the swap the pools sit at *different* spot prices (offset by their fee tiers) whose
fee-adjusted marginals all converge on the solver's cut (to ~5 ppm). All are part of
`npm run test:recipes:evm`.

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
BASE_RPC_URL=<url> npx tsx recipes/test/ecoswap.test.ts
```

Boots a Base fork pinned to a fixed block, deploys the router, funds/approves, prepares + compiles +
cooks, and asserts on balance deltas, events, and ladder invariants. (Not wired into `npm test`,
which only runs the fork-free compile suite.)

## Status

**Verified across Uniswap V2, V3 and V4** on a local EVM simulation (anvil, no fork) running against
**real protocol bytecode** — see `recipes/test/ecoswap.evm.test.ts` (`npm run test:recipes:evm`):

- **V3** — real `@uniswap/v3-core` factory + minted concentrated liquidity; multi-pool split with
  marginal-price equalization.
- **V2** — the canonical constant-product pair runtime **etched** into anvil; swapped via the unified
  `swap(SwapParams)` path. Mixed V2+V3 split verified.
- **V4** — the **real Base PoolManager + StateView runtime etched** at their canonical addresses (so
  StateView's baked-in `poolManager` immutable resolves), a pool initialised + funded through the real
  singleton, then swapped via `swap(SwapParams)` (`poolType=UniV4`). Solo V4 and a V3+V4 split verified.

Also **verified end-to-end on a Base mainnet fork** for direct V3 swaps + multi-hop routes
(`BASE_RPC_URL=<url> npx tsx recipes/test/ecoswap.test.ts`).

## Supported sources & compromises

- **Sources:** Uniswap **V2** (constant-product), **V3** (concentrated), and **V4** (singleton). Other
  AMM families (Curve, Balancer, DODO, TraderJoe LB, Maverick, WOOFi) and Algebra/Solidly-stable
  exotics are excluded in prepare for now (bespoke curve math) — they come later.
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
- **Env knobs:** `ECO_MAX_POOLS` (default 12), `ECO_MAX_ROUTES` (default 2) bound the on-chain loop.

### SauceScript / compiler notes (hard-won)

- Contract calls **auto-decode**: `IERC20.at(x).balanceOf(y)` returns the value directly (no
  `abi.decode`). Multi-return calls (`slot0()`, `getReserves()`) return an indexable tuple but **must
  be indexed inline** — `slot0()[0]` works, `const s = slot0(); s[0]` reverts.
- Added `Math.mulDiv` and `Math.neg` to the compiler (`compiler/src/globals.ts`, mapping to engine
  opcodes `MUL_DIV=0x28` / `NEG=0x29`). `SUB` is checked, so use `Math.neg` for two's-complement.
- `compile()` takes `baseDirs: string[]` and returns `{ bytecode }`; pass addresses as `BigInt`
  scalars; strict `===` only; no mutable arrays / `.push()`; big constants via `2 ** 96`.
