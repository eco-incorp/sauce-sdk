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
   `L` from `liquidity()` + `liquidityNet`. For each V2 pool: one wide bracket discretised into
   geometric steps. For each route: sample input sizes, quote both hops, derive route segments.
3. Fee-adjust each bracket's sqrt boundaries, compute its gross input capacity, and **sort the whole
   ladder descending** by fee-adjusted marginal price.

**On-chain (`ecoswap.sauce.ts`)**
- **Phase A** — walk the pre-sorted ladder once, summing capacity until `amountIn` is reached, to find
  the common marginal-price cut `cutSqrtAdj` (the water-fill level).
- **Phase B** — for each direct pool, re-read its **live** price (`slot0` / `getReserves`), integrate
  the exact input to move from the live price down to the cut, and do one swap. Routes allocate whole
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

## Fork test

```sh
BASE_RPC_URL=<url> npx tsx recipes/test/ecoswap.test.ts
```

Boots a Base fork pinned to a fixed block, deploys the router, funds/approves, prepares + compiles +
cooks, and asserts on balance deltas, events, and ladder invariants. (Not wired into `npm test`,
which only runs the fork-free compile suite.)

## Status

**Verified end-to-end on a Base mainnet fork** (block ~47.56M): direct V3 multi-pool swaps and
multi-hop routes both execute, full input is spent, output is received, and the per-pool "crossed
ticks" trim scales with trade size (e.g. 1 WETH → 8 brackets, 100 WETH → 108 brackets, all input
deployed across pools). Run `BASE_RPC_URL=<url> npx tsx recipes/test/ecoswap.test.ts` to re-verify.

## v1 scope & known compromises

- **Execution is V3/V4 only.** Direct pools are swapped via the router's flat legacy
  `swapV3(pool, tokenIn, tokenOut, amountSpecified, limit, payer, recipient)` (positive
  `amountSpecified` = exact input). The unified `swap(SwapParams)` — the **only** on-chain path for
  V2/constant-product pools — currently can't be called from SauceScript because the compiler
  **mis-encodes the nested `PoolKey` struct** for the call (the self-call reverts with empty data).
  So **V2 pools are discovered but not executed** in v1; re-enabling them needs either that compiler
  nested-struct fix or a flat `swapV2` in the engine. Algebra/Solidly-stable/exotic AMMs are excluded
  in prepare (bespoke curve math).
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
