# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Developer-facing tooling for the **Sauce protocol** — an on-chain bytecode runtime that executes
Turing-complete, atomic scripts in a single EVM transaction. The runtime engine itself lives in the
separate private `eco-incorp/sauce` repo (often checked out at `../sauce`); this repo only *targets*
it.

A **pnpm monorepo** of four workspace packages, all `private: true`, bundled and published as a
**single npm package `@eco-incorp/sauce-sdk`** via subpath exports — only the root `package.json`
publishes. This bundling is the key mental model: code lives in four packages for development,
consumers import everything from one name.

| Workspace | Internal name | Published as | Role |
| --- | --- | --- | --- |
| `compiler/` | `@eco-incorp/sauce-compiler` | `/compiler` | SauceScript (JS subset) → Sauce bytecode |
| `sdk/` | `@eco-incorp/sauce-sdk-source` | `.`, `/protocols/*`, `/chains`, `/skills`, `/recipes` | 127+ protocol registry, chains, recipes, AI skill files |
| `actions/` | `@eco-incorp/sauce-actions` | `/actions` | High-level routing actions (swaps/bridges) → bytecode |
| `dev-tools/` | `@eco-incorp/sauce-dev-tools` | bin `sauce-dev-tools` | Local/forked hardhat env + recipe runner |

This repo was **extracted from `../sauce`** (the source of truth, which still has its own copies of
these four packages, generally more built-out). The packages here are **siblings, not generations**:
`dev-tools` is a dev harness, not a legacy `sdk`. The genuinely deprecated compiler is
`../sauce/compiler-poc/`, nothing here.

## Build, test, lint

Run from the repo root. **Build order matters** — sdk and actions consume the compiler's `dist/`, so
the compiler builds first (the `build` script enforces this).

```sh
pnpm install
pnpm build          # compiler, THEN sdk + actions
pnpm typecheck      # all workspaces
pnpm test           # all workspaces
```

Per-workspace (`--filter`):

```sh
pnpm --filter './compiler' test          # jest: unit test/ + integration-test/ (needs Foundry)
pnpm --filter './compiler' lint          # eslint; also: format:check (CI enforces)
pnpm --filter './sdk' test               # compiles every protocol's SauceScript fn (1400+ tests)
pnpm --filter './actions' test:unit      # fork-free subset CI runs
```

Single test file: jest (compiler/sdk) → `pnpm --filter './compiler' test -- arithmetic.test.ts`.
Actions and dev-tools use the **node test runner**, not jest → `pnpm --filter './actions' exec tsx
--test tests/megas-swap.unit.test.ts`.

## Toolchain gotchas (why a fresh clone may fail)

- **Private `sauce` git dep.** The compiler depends on `sauce` from `git+https://…/eco-incorp/sauce`
  (private). Cloning needs GitHub auth — locally `gh auth setup-git` or an `~/.npmrc` token; CI uses
  the `ECO_INCORP_TOKEN` secret via a `git config insteadOf` rewrite.
- **Foundry** (`anvil`/`forge`/`cast`) is required for the compiler's integration tests (jest
  `globalSetup` spawns anvil, `forge create`s the engine, runs compiled bytecode) and to build the
  engine artifacts. The compiler `postinstall` (`integration-test/fetch-engine-libs.js`) clones the
  OpenZeppelin submodule into the `sauce` dep and `forge build`s it (pnpm doesn't recurse submodules).
- **`FORK_URL`** — actions `test`/`test:megas-swap` and dev-tools fork flows hit a hardhat mainnet
  fork (loaded from `.env`). `test:unit` is the fork-free subset.
- **`SAUCE_ENGINE_SO`** — path to the Solana engine binary (`engine.so`, built with
  `cargo build-sbf` in the sauce repo's `svm/`). The SVM integration suites
  (`compiler/integration-test/svm-*.test.ts`, `sdk/test/svm/solswap.e2e.test.ts`) run compiled
  `target: 'svm'` bytecode on it via LiteSVM; default is the sibling-checkout path
  `../sauce/svm/target/deploy/engine.so`, and the suites **skip cleanly** when the binary is absent
  (so CI stays green without it). The `'svm'` compile target, its account-plan output, and the
  `/svm` SDK subpath are documented in `docs/plans/2026-07-03-solana-svm-support.md`.

## Architecture

**`compiler/`** — parses **SauceScript** (a uint256-only JS subset; no closures/classes/async, strict
equality; full surface in `compiler/README.md`) to bytecode. `src/index.ts` `compile()` parses via
`acorn` and emits `Uint8Array[]`; `src/processor/` walks the AST (expression/statement/collection/
inference); `src/saucer/` emits bytecode (`Saucer` builder, `ops.ts` opcode table, per-type encoders);
`src/context.ts` tracks functions/var kinds/ABIs; `src/contracts.ts` loads contract ABIs from artifact
JSON for `import { X } from "./X.json"` + `.at()/.view()/.lib()` binding.

**Compiler fixes (this branch):** (a) `new Array(n)` now **infers as DYNAMIC (heap) storage** so the
TUPLE descriptor survives a variable round-trip — scalar/bytes32 storage dropped the descriptor, so
`arr[i]` read/write reverted after `let a = new Array(n)`. (b) v12 `staticCall`/`delegateCall`
`stackEffect` is **-1** (they push a result), not -2 — fixes corrupt SDUP positions when a param is read
after a static call. (c) v12 assembly emits a **no-param ARG-PROLOGUE entry** that pushes the
compile-time args then falls through into `main` (the v12 analogue of v1's appended `CALL_FUNCTION` arg
segment) — so **parameterized recipes run on the Huff runtime**. (`main` is inlined, not a table fn → it
can't recurse, same as v1.) Engine dep is pinned to `sauce.git#feat/v12-kitchen` (V12Kitchen/V12Pot
bridge + `NEW_ARRAY`/`SET_INDEX` engine opcodes; PR #176) — a temporary dev pin, retarget to the engine
default branch after that PR merges.

**Known v12 limit (follow-up):** the Huff runtime's dynamic-value descriptor packs the data pointer in
16 bits (region `0x5000`→`0xFFFF`, ≈45 KB), so a program whose total dynamic data exceeds that (≈80
nested-8-element bracket tuples) gets a truncated pointer → garbage read → revert. Normal EcoSwap (≈24
brackets) is well within budget and runs with exact v1 parity; only oversized (>~80-bracket) programs hit
it. The fix needs a runtime-wide Huff pointer widening — out of scope here.

**`sdk/`** — a data registry, no runtime logic. `src/protocols/<slug>/` per protocol (`info`,
`addresses`, `abis` as-const, `functions` SauceScript templates); `src/protocols/index.ts` is the
query registry. `src/skills/*.md` are AI-ready per-protocol docs (loaded by `loader.ts`, shipped in
the package). `src/chains/`, `src/recipes/`, `src/core/types.ts`. **SDK tests compile every protocol's
`sauceFunctions` through the real compiler — build the compiler first or they fail.**

**`actions/`** — `actionsToSauce(actions)` lowers routing intents (`uniswapV3ExactInput`, bridges,
wraps, stakes) to bytecode. Actions **chain**: output feeds the next implicitly (no `amountIn`) or via
`saveOutputAs`/`amountRef`. See `actions/AMM_SWAP_INTERFACES.md`.

**`dev-tools/`** — harness: `start:local`/`start:fork` boot a hardhat net + deploy the engine;
`npm run sauce <file.js> [args]` compiles+runs a SauceScript; `npm run recipe …` runs recipes (the
runner imports them from the canonical `sdk/src/recipes/` tree). The recipes themselves now live in
`sdk/` — dev-tools keeps only the CLI runner + the local hardhat env. See **Recipes** below.

## The swap Router (`../sauce/engine/src/Router.sol`)

Lives in the **private engine repo**, not here, but recipes target it (its `Router`/`SauceRouter`
artifacts are what `cook()` runs against). `SauceRouter` is a thin delegatecall proxy → `Router`
(`~1218` lines). Recipes import the minimal `ISauceRouter` ABI from `sdk/src/artifacts/`.

**Entry points** (all the `swap*` ones are `onlySelf` — callable only via `cook()` from the same
contract, so a recipe calls them as `ISauceRouter.at(address.self).swapX(...)`):
- `swap(SwapParams)` — unified swap; dispatches on `params.poolType` to `_swapV2/_swapV3/_swapV4/
  _swapCurve/_swapBalancerV2/_swapDODOV2/_swapTraderJoeLB/_swapMaverickV2/_swapWOOFi`.
  `SwapParams` embeds a `PoolKey` struct (`currency0,currency1,fee,tickSpacing,hooks`) used **only by
  V4** (ignored for V2/V3). Calling this from SauceScript **now works**: the compiler orders
  object-literal struct fields by the ABI's declared component order at the call boundary (recursively
  for nested tuples) — see `compiler/src/processor/expression.ts` `processAbiArg`/`orderedStructTuple`,
  unit-pinned by `compiler/test/struct-arg-order.test.ts`. (Previously it sorted fields alphabetically,
  scrambling the nested `PoolKey` → empty revert.) The flat methods below remain valid alternatives.
- `swapV3(pool, tokenIn, tokenOut, amountSpecified, sqrtPriceLimitX96, payer, recipient)` and
  `swapV4(...)` — **flat** legacy methods (no nested struct), verified working from SauceScript.
- `quote(QuoteParams)` — off-chain simulation; performs the swap and reverts with `QuoteRevert(amountIn,
  amountOut, sqrtPriceAfter, gas)` (caught by `shared/quoting.ts`). Never lands a swap.

**`amountSpecified` sign is inconsistent by path** (this bit us): the flat `swapV3` passes through to
Uniswap, where **positive = exact input** (verified on fork). The unified `swap()`/V4 path and the
`SwapParams`/`QuoteParams` doc say **negative = exact input** (Uniswap-V4/quote convention). For
recipes using flat `swapV3`, pass a **positive** amount.

**`SwapPoolType` enum** (must match recipe constants): `UniV2=0, UniV3=1, UniV4=2, Curve=3,
BalancerV2=4, DODOV2=5, TraderJoeLB=6, MaverickV2=7, WOOFi=8`.

**Callbacks vs callback-free** — the key architectural split for "where does swap logic live":
- **V2/Solidly/Curve/DODO** are *callback-free*: `_swapV2` reads reserves, computes out (V2 fee
  hardcoded 0.3% via `_getAmountOut`'s `*997/1000`), transfers tokenIn to the pool, calls
  `pair.swap(...)`. A recipe can replicate this **entirely in SauceScript** (transfer + `pool.swap`),
  bypassing the router — so new callback-free sources need only new SauceScript, no engine change.
- **V3/V4 (and Maverick)** use *callbacks*: the pool re-enters the contract mid-swap
  (`uniswapV3SwapCallback`/`pancakeV3SwapCallback`/`unlockCallback`/`maverickV2SwapCallback`) to pull
  input, reading transient-storage context set by `_swapV3`. A reentrant call during `cook()` hits the
  contract's Solidity dispatcher, **not** the paused bytecode interpreter — so callbacks can only be
  serviced by the router's compiled code. These swaps **must** go through the router (`swapV3`/`swapV4`).

## Recipes

A recipe prepares pool data off-chain and executes it on-chain via one `cook()`. **Recipes live in ONE
canonical tree: `sdk/src/recipes/`** (`megaswap`, `alphaswap`, `gigaswap`, `terraswap`, `ecoswap` + the
full test suite + harness + fixtures). This is the published `/recipes` export (and is re-exported from
the sdk's main entry). The dev-tools package keeps only the **runner CLI** (`scripts/recipe.ts`,
`scripts/run.ts`, the start/stop shell scripts), which imports the recipes from the sdk tree by source
path (`../../sdk/src/recipes/…`, run via tsx). *(Historical note: the recipes used to live at
`dev-tools/recipes/`, with an older drifted copy under `sdk/src/recipes/`; the dev-tools tree was moved
in and is now the single source of truth.)*

Each recipe dir: `prepare.ts` (off-chain read-only RPC — discover/quote pools, compute slippage),
`<name>.sauce.ts` (a **static** SauceScript template — not string-interpolated; read from disk, types
stripped via `ts.transpileModule`, pool data passed as compiler **`args`**), `index.ts` (orchestrator:
client → prepare → compile → `{ bytecodes, prepared, source }`), `shared/` (pool-discovery, quoting,
constants, types). **The compiler must be built first** — recipes resolve it via the
`@eco-incorp/sauce-compiler` workspace dep (added to `sdk`); the fast compile tests import its built
`dist` by relative path.

**EcoSwap unified per-pool live walk (this branch).** EcoSwap's on-chain solver (`ecoswap.sauce.ts`) is
ONE price-ordered k-way merge where **every direct pool walks a single frontier from its LIVE spot**, one
tickSpacing per step. There are **no two modes** (no cache-vs-re-anchor, no stale-skip, no drift gate): a
tick's `liquidityNet` is **drift-invariant**, so the walk ALWAYS computes sqrt/price on the LIVE grid
(identical to the neutral oracle `ecoswap.optimal.ts`) and reuses only the **per-pool NET cache** prepare
ships — a cache lookup for an in-window boundary, a `ticks()`/`getTickLiquidity()` staticcall for an
out-of-window one (same net either way ⇒ **wei-exact with the oracle by construction**, for any drift).
The cache is a pure gas optimization (`windowTop=0` ⇒ every boundary staticcalls ⇒ the 1-RPC quote path
with no prepared ticks). A pool is **never** deactivated while liquidity is known ahead — it walks
THROUGH interior `dL==0` gaps and deactivates only on the price limit, the per-pool budget cap, or
(`dL==0` AND the boundary is past the pool's deepest initialized tick). The merge's per-pool head scan is
**lazy-far**: each step computes only the near fee-adjusted price for every active pool and computes the
far (the near-tie break) ONLY when the near could win or tie the current best — split-identical, ~60% of
the per-pool scan arithmetic saved. It is **compute-then-pull** — `transferFrom`s exactly the merged `cum`
(one guarded terminal refund for the limit-price edge), not a pre-pull. The wei-exact gate vs the oracle is
mirrored bit-for-bit by `ecoswap.solver-reference.ts`. **N-hop routes are LIVE composite venues (the
QL-legs epic):** a route's head is the product fold of its legs' best heads, and each LEG is a SET of
members — universe pools (V2/V3/V4/Algebra families, appended after the direct pools; a leg pool reuses
the per-pool frontier code byte-identically via `pd[7]`) AND the 13 quote-ladder families (Curve/
CryptoSwap/Solidly-stable/WOOFi/LB/Mento/DODO/Wombat/Fermi/Euler/BalV2/BalV3/Maverick; Fluid stays
direct-only). Leg-venue price LADDERS are built ON-CHAIN in setup on the leg's EDGE pair, sized by the
chain-order live fold of `amountIn` through the upstream legs' live heads; the merge elects the per-leg
binding MEMBER (strict-near win, near-tie by strictly-higher far, pools before venues) and advances a
route via binding-leg events with slice branches; exec is ONE unified per-leg loop (13-family dispatch,
venue shares ride `qinp[]`, a per-route intermediate sweep returns residual mid-route dust). Prepare
discovers leg venues per DIRECTED edge (memoized, `discoverQlVenuesForPair` shared with the direct path)
under global pool+venue CLAIMS — a multi-coin venue holding several route tokens is admitted on exactly
ONE leg, never both direct and leg. Plumbing: stride-5 routing tuples
`[legCount,{poolBase,poolCount,qlvBase,qlvCount,inter}×L]`, a 12-column `qlv` partition (direct rows
first, then per-`(route,leg)` rows) with `cfg[12]=directQlvCount`; the whole leg-QLV surface is
`HAS_LEG_QLV`-gated and treeshaken away for pool-only universes. Prepare stays an OPTIONAL cache
throughout (except Fluid, which is still prepare-sampled via the chain-wide resolver): venue descriptors
carry no sampled data — ladders come from live cook-time state — and `quoteEcoSwap`'s zero-cache path
carries the leg venues too. The **on-chain lens is the single
source of truth** for survivorship: it emits **survivors-only** plus a header `[discoveredCount,
survivorCount, totalL, liqFloor]`, and `prepare.ts` consumes them with **no re-filter**. The absolute
`MIN_LIQUIDITY` floor was **dropped** — relative-depth `minRelBps` (plus a `>0` aliveness gate) is now the
sole liquidity filter.

### Running recipes against a fork / RPC (in `dev-tools/`)

```sh
pnpm sync-artifacts                                          # populate sdk/src/artifacts/ (once)
npm run start:fork https://eth-mainnet.g.alchemy.com/v2/KEY  # boot fork + deploy, writes .deployment.json
npm run recipe megaswap WETH USDC 1
npm run stop
npm run recipe megaswap WETH USDC 0.01 -- --network base     # live: hardcoded router + BASE_RPC_URL + PRIVATE_KEY
```

`dev-tools/scripts/recipe.ts` (the CLI runner) imports the recipes from `sdk/src/recipes/`, reads
`.deployment.json`, auto-wraps ETH→WETH, auto-approves the router, prepares+compiles, `cook()`s, and
parses `Transfer` logs. Tokens: `WETH/USDC/DAI/USDbC` or raw `0x`.

### Artifacts

`sdk/src/artifacts/*.json` (gitignored build output) are the **canonical** engine artifacts, read by the
recipes (`quoting.ts`, the `.sauce.ts` JSON imports — resolved via each recipe's `REPO_ROOT` = `sdk/src`)
and by dev-tools' `deploy.ts` + start scripts (`Router`/`SauceRouter` carry deploy bytecode). Populate
them with **`pnpm sync-artifacts`** (`dev-tools/scripts/sync-artifacts.js`), which copies the `sauce`
engine's Foundry build output (`forge build` runs in the compiler `postinstall`) into `sdk/src/artifacts/`.
`sync-artifacts` **also ships `V12Kitchen`/`V12Pot` + the Huff runtime creation-code snapshot** (for the
dual-engine v12 test path). It runs automatically at **`prepack`** so the published package ships them
(root `package.json` `files` lists `sdk/src/artifacts`).

**Dist runtime assets (published-recipe completeness).** `tsc` compiles the recipe `.ts` to
`sdk/dist/recipes/` but does NOT emit the assets the recipes read at *runtime*: the `.sauce.ts` templates
(`readFileSync(join(__dirname, "<n>.sauce.ts"))`), the checked-in sibling ABI `*.json` (the `.sauce.ts`
`import`s them, resolved by the compiler's `baseDirs:[REPO_ROOT,__dirname]`), and `./artifacts/*.json`
(`REPO_ROOT = join(__dirname,"..","..")` = `dist` when running from `dist/recipes/<n>/`). So sdk's `build`
is **`tsc && node scripts/copy-recipe-assets.mjs`**: the copy step mirrors `src/recipes/**/*.{sauce.ts,json}`
→ `dist/recipes/` (excluding `test/`) and `src/artifacts/*.json` → `dist/artifacts/`. `prepack` runs
`sync-artifacts` THEN the copy, so the tarball's `dist/artifacts` is fresh. Recipe relative imports MUST
carry the `.js` extension (Node-ESM requirement; the dev-tools tree was authored extensionless and was fixed
on the move) or the published `dist/recipes/index.js` barrel fails to import. The dist-resolution smoke
(`src/recipes/test/dist-resolution.smoke.mjs`) guards this: it imports the built barrel and compiles a recipe
from `dist` with the recipe's own dist `baseDirs`.

### Recipe tests

Three tiers under `sdk/src/recipes/test/`, all using the **node:test** runner (`tsx --test`) except the
legacy fork tests. Run from the **sdk** workspace: `pnpm --filter './sdk' test:recipes` (fast) /
`test:recipes:evm` (anvil). The `test/` tree is in-repo only — it is excluded from publish via **`files`
negation** in the root `package.json` (`"!sdk/src/recipes/test"`, `"!sdk/src/recipes/test/**"`) so the
~5 MB anvil-state fixtures don't ship; recipe SOURCE does ship under `sdk/src/recipes`. (Note: a root
`.npmignore` does NOT work here — when `files` whitelists `sdk/src/recipes`, npm ignores `.npmignore` for
those paths, so the `!`-negation entries in `files` are the mechanism.)

1. **Fast, no-network (`pnpm --filter './sdk' test:recipes`)** — `compile.test.ts` +
   `ecoswap.compile.test.ts` (compile all 4 flat recipes + ecoswap to bytecode) and
   `ecoswap.math.test.ts` (pure-bigint known-answer math: TickMath `getSqrtRatioAtTick`, fee-adjust,
   V2≡V3-bracket unification, water-fill conservation/interior-cut via the `ecoswap.reference.ts`
   oracle). No anvil, no RPC.
2. **Local EVM simulation (`pnpm --filter './sdk' test:recipes:evm`)** — `*.evm.test.ts`. Boots a fresh **anvil (NO
   fork)**, etches Multicall3, deploys the **real** `@uniswap/v3-core` Factory + the Sauce engine
   (`Router`→`SauceRouter`), mints our own concentrated liquidity across ticks via a `V3LiquidityHelper`,
   then runs the compiled recipe through `cook()` and asserts the split + marginal-price equalization,
   cross-checked against the `ecoswap.reference.ts` oracle. The script first `forge build`s the Solidity
   fixtures (`src/recipes/test/fixtures/`: `MintableERC20`, `V3LiquidityHelper`, `V2Pair`/`V2Factory`,
   `V4LiquidityHelper`) — **Foundry required**. EcoSwap executes **V2, V3 and V4**: V3 via flat
   `swapV3`; V2/V4 via the unified `swap(SwapParams)` (nested `PoolKey`, negative `amountSpecified`).
   `ecoswap.evm.test.ts` covers V3 splits, a V2+V3 mix (canonical pair runtime **etched** + funded),
   solo V4 and a V3+V4 split (**real Base PoolManager + StateView runtime etched at their canonical
   addresses** — StateView bakes the PoolManager address as an immutable, so both must sit at the real
   addresses; runtime captured by `src/recipes/test/harness/v4-bytecode-snapshot.ts`, checked in at
   `fixtures/snapshots/v4-bytecode.json`).
   **Dual-engine (this branch):** `ecoswap.evm.test.ts` Phase 3 is parametrized
   the **single-pass solver × {v1, v12}**; the v12 cells deploy the V12 stack (`deployV12Stack`) and cook
   through **V12Pot on the Huff runtime**, **gated by `SAUCE_ENGINE_V12=1`** (skip-by-default). The cook
   block timestamp is pinned (`setNextBlockTimestamp`) because the V3 pool oracle accumulator depends on
   `block.timestamp`, which drifts across `evm_revert`. Two new tier-2 tests: `ecoswap.adaptive.evm.test.ts`
   (window-exceeded adaptive fill) and `ecoswap.gas.evm.test.ts` + `GAS.md` (`ECO_GAS=1`, {2 single-pass
   solver variants: array + unrolled}×{v1,v12} gas + bytecode size).
   **QL-legs tests:** `ecoswap.legql.evm.test.ts` (hand-built prepared driving the production
   `buildSolverArgs` path — venue-only leg, mixed pool+venue leg, budget-clamp-on-the-slice,
   dead-upstream born-exhausted ladder, venue-funded output custody, the pinned 2-route example, a
   leg-venue adverse-drift cell; both engines) and `ecoswap.legql.prepare.evm.test.ts` (the same
   example through PRODUCTION `ecoSwap(config,…,poolConfig)` discovery — per-edge direction stamping,
   the 3-coin claims cell, direct-vs-leg exclusion, pool-only shape stability, quote == cook).
   **Prod-mirror tests** replay REAL Base pool state from checked-in snapshots: `*.prodmirror.evm.test.ts`
   for V3 (`prod-snapshot.ts`, heavy ~10 min — one mint per boundary), V2 (`v2-snapshot.ts`, asserts
   output == exact constant-product) and V4 (`v4-snapshot.ts`, re-mints the tick profile into the etched
   PoolManager). `ecoswap.v2v3v4.prodmirror.evm.test.ts` is the **cross-version** one: it reproduces all
   three real Base WETH/USDC pools onto ONE anvil sharing ONE local token pair (decimals don't affect
   fidelity — `reproducePool` takes an optional pre-deployed pair) and runs a SINGLE EcoSwap, sized so the
   deepest/cheapest V3 0.05% pool is pushed below the V2/V4 0.30% tiers, asserting a tokenIn slice lands
   in every version's pool (also heavy, ~10 min — inherits the V3 reconstruction) and that post-fee
   marginals **equalize** at the cut (spot prices differ by fee, fee-adjusted marginals agree to ~5 ppm).
   `ecoswap.allpools.prodmirror.evm.test.ts` is the **discover→filter→split** one: it reproduces the
   FULL real Base WETH/USDC universe on ONE anvil — Uniswap V3 ×4 tiers + **PancakeSwap V3 ×4 tiers**
   (GENUINE pancake pool bytecode that calls `pancakeV3SwapCallback`; deployed from the npm package's
   prebuilt creation code via the `PancakeV3Deployer` fixture, since pancake ships no factory/deployer
   source) + V2 + V4 — then asserts (a) `discoverPools` surfaces all 10 across both forks/every tier
   (per-factory `feeTiers` catch Pancake's 2500), (b) the **relative-depth filter** (1% of total Σ
   IN-RANGE capacity — the gross tokenIn each pool absorbs from spot to the common cut, NOT spot
   active-L) keeps only the deep pools and drops the thin V2/V4 + shallow tiers, and (c) ONE EcoSwap
   splits across BOTH forks (exercising uniswap+pancake callbacks) with marginals equalized; plus a
   drift case on a Pancake survivor. The deep survivors are Uni 500+3000 and Pancake 500 (always),
   plus Pancake **100** as a **knife-edge** case: its in-range capacity is ≈47.2 WETH ≈ **1.0%** of
   the Σ, right at the 1% floor — the engines compute Σ with marginally different mulDiv/sqrt rounding
   (v12 Σ≈4701→floor≈47.01→Pancake-100 **kept**, 4 survivors; v1 Σ≈4741→floor≈47.41→**dropped**, 3
   survivors), so the test asserts the 3 unambiguous survivors strictly and treats Pancake-100 as the
   documented engine-dependent borderline. (Verify per-pool capacity with `npx tsx
   src/recipes/test/harness/lens-capacity-probe.ts`, which loads the cached state + replays the lens's
   capacity walk off-chain.) Survivors are fully reconstructed (real tick profiles); droppees are
   light-minted at real price + real active L.
   Beyond the Uniswap-lineage ones, **every venue family has its own prod-mirror**
   (`ecoswap.<family>.prodmirror.evm.test.ts` — curve/crypto/dodo/lb/solidly/euler/fermi/fluid/mento/
   balancer/balancerv3/maverick/slipstream/algebra/…) replaying that family's REAL captured pool state,
   wei-exact both engines + a drift case; the newest lineages are `ecoswap.algebraintegral.prodmirror`
   (BSC THENA Integral — 6-word `globalState` with a poisoned word 3, reconstructed via
   `harness/reproduce-pool-shifted.ts` for its negative-prefix net profile), `ecoswap.topaz.prodmirror`
   (BSC Topaz CL, dynamic per-pool `fee()` read live), `ecoswap.projectx.prodmirror` (HyperEVM
   Project X, complete 1064-boundary profile + the odd fee-400/ts-8 tier),
   `ecoswap.infinity.prodmirror` (BSC PancakeSwap Infinity CL — the GENUINE Vault/CLPoolManager/
   CLTickLens runtime etched at the canonical create3 addresses, real USDT/Beat tick profile,
   cooked through the engine's `swapInfinityCL` Vault lock) and `ecoswap.ekubo.prodmirror`
   (Ethereum Ekubo — the genuine CLZ-dependent runtime on an **osaka-hardfork anvil**, slot-union
   capture via `eth_createAccessList` oversize quotes both directions).
   Recapture the prod SNAPSHOTS with `BASE_RPC_URL=<url> npx tsx src/recipes/test/harness/<x>-snapshot.ts`
   (V3/Pancake take an optional source-tag arg → `base-WETHUSDC-pancake<fee>.json`).
   **Anvil-state cache (fast setup).** Reconstruction is deterministic given the engine artifacts +
   snapshots, so each prod-mirror `before()` reconstructs ONCE per engine, dumps the full anvil state
   (`anvil_dumpState`) + a small manifest to a CHECKED-IN blob under
   `src/recipes/test/fixtures/anvil-state/<fixture>-<engine>.{state.json.gz,manifest.json}` (NOT gitignored
   — CI + fresh clones load it), and on later runs `anvil_loadState`s it in **seconds** (the whole
   prod-mirror lane: ~50 min → ~42 s/engine) and pins `block.timestamp` (kills the `evm_revert` oracle
   drift). Shared harness: `src/recipes/test/harness/state-cache.ts` (`withCachedState`); anvil boots with
   `--no-request-size-limit` (the ~2.5 MB loadState payload exceeds anvil's default 2 MB body limit).
   **RECAPTURE is REQUIRED whenever the engine artifacts OR the reconstruction change** (the blob bakes
   in the engine bytecode + the reconstructed pools): `RECAPTURE_ANVIL_STATE=1 npx tsx --test
   src/recipes/test/<fixture>.prodmirror.evm.test.ts` (and `ECO_ENGINE=v1 …` for the v1 blob). A fresh
   clone with a missing blob recaptures implicitly on first run. Mirrors the snapshots convention.
   Every prod-mirror test ALSO has a **drift / runtime re-anchoring** case: snapshot the reconstructed
   pools, `prepare()`+compile, move a pool's price with a REAL swap (`harness/drift.ts` cooks the one-swap
   `harness/drift.sauce.ts` through the engine), then `cook()` the pre-drift bytecodes — so Phase B's
   live-price read (slot0 / StateView / getReserves) runs against genuine drift. It asserts the recipe
   filled only the remaining gap to the cut (`drift + recipe ≈ baseline`; gross input → cut is path-additive)
   and still re-anchored to the cut — in the combined test the drifted pool's share shrinks while untouched
   pools keep theirs, i.e. the split adapts at runtime. Drift cases revert to a clean snapshot via viem's
   `testClient` (anvil `evm_snapshot`/`evm_revert`) so they prepare against the same pools as the no-drift run.
   The harness lives in `src/recipes/test/harness/`. Why local pools work: the engine `Router` authenticates
   V3 swap callbacks via transient storage (`expectedPool`), not a hardcoded factory/CREATE2 check, and
   V4 callbacks via the in-flight PoolManager — so non-canonical locally-deployed/etched pools are
   accepted. EcoSwap discovery is config-injectable — `ecoSwap(config, rpcUrl, sauceRouter, caller,
   poolConfig?)` threads a local `ChainPoolConfig` so the real `discoverPools`→bracket→filter path runs
   against local pools. Discovery now queries each factory across **its own** `FactoryConfig.feeTiers`
   (forks differ — Pancake V3 uses 2500, not Uniswap's 3000). Liquidity filtering is **relative-depth
   only** (this branch): drop pools < `ECO_MIN_REL_BPS`/1e4 of total liquidity (default 1%; per-call
   `{minRelBps}` opt, 0 disables) plus a `>0` aliveness gate — the absolute `MIN_LIQUIDITY` floor was
   dropped, and the filter now lives in the **lens** (single source of truth; prepare does not re-filter).
3. **Fork tests (manual)** — `{megaswap,alphaswap,gigaswap}.test.ts` are self-contained fork tests
   (plain `tsx` + hand-rolled asserts) — boot a fork pinned to a fixed block, deploy router,
   fund/approve, `prepare+compile+cook`, assert on balance deltas + events. Require `BASE_RPC_URL`, run
   manually (`BASE_RPC_URL=<url> npx tsx src/recipes/test/megaswap.test.ts` from `sdk/`). `terraswap` has
   no fork test. These spawn `hardhat node` from `dev-tools/` (where the hardhat config + fork env live).
   `ecoswap.chains.fork.test.ts` is the manual **network** tier for EcoSwap: one parametrized runner
   over the covered chains (per-chain env-gated `<CHAIN>_RPC_URL`, skip-when-absent; block-pinned anvil
   forks so re-runs hit anvil's disk cache) — real discovery + prepare via the chain's
   `CHAIN_POOL_CONFIGS` entry, a read-only `quoteEcoSwap`, and on BSC a landed `cook()` asserted against
   the quote. The Celo known-failure note (deterministic quote-cook MemoryOOG with deep ts=1 route-leg
   universes) lives in-file.

## Publishing

Tag-driven (`.github/workflows/publish.yml`): `git tag v1.2.3 && git push origin v1.2.3` (or manual
`workflow_dispatch`). Builds all areas, runs `prepack` (syncs artifacts), stamps the **root**
`package.json` version, and publishes the single `@eco-incorp/sauce-sdk` to **both** npmjs.com
(`NPM_TOKEN`) and GitHub Packages (`GITHUB_TOKEN`). Only the root version is published; workspace
packages stay `private`.
