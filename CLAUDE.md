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
  (`compiler/integration-test/svm-*.test.ts`, `sdk/test/svm/*.test.ts`) run compiled
  `target: 'svm'` bytecode on it via LiteSVM. The binary is **vendored** at
  `artifacts/svm/engine.so` (committed, force-added — `.so` is gitignored — same
  convention as the committed `compiler/dist`/`sdk/dist`) and that's the default both
  locally and in CI, so these suites run **offline by default**, same as the EVM ones; the
  suites **skip cleanly** only if that binary is somehow missing. Set `SAUCE_ENGINE_SO` to
  override — e.g. to test a freshly built engine before repinning the `sauce` dep. **Refresh
  the vendored binary whenever the `sauce` dep is repinned**: `cargo build-sbf` in the pinned
  commit's `svm/` checkout, copy `target/deploy/engine.so` over `artifacts/svm/engine.so`,
  force-commit — nothing re-derives this automatically, so a repin without a refresh silently
  tests against a stale engine again. The `'svm'` compile target, its account-plan output,
  and the `/svm` SDK subpath are documented in `docs/plans/2026-07-03-solana-svm-support.md`.

## Architecture

**`compiler/`** — parses **SauceScript** (a uint256-only JS subset; no closures/classes/async, strict
equality; full surface in `compiler/README.md`) to bytecode. `src/index.ts` `compile()` parses via
`acorn` and emits `Uint8Array[]`; `src/processor/` walks the AST (expression/statement/collection/
inference); `src/saucer/` emits bytecode (`Saucer` builder, `ops.ts` opcode table, per-type encoders);
`src/context.ts` tracks functions/var kinds/ABIs; `src/contracts.ts` loads contract ABIs from artifact
JSON for `import { X } from "./X.json"` + `.at()/.view()/.lib()` binding.

**Compile cache (`src/cache.ts`) — ON BY DEFAULT** — `compile()` is a pure function of (source,
options, on-disk import contents), so it memoizes: a repeat `(source, options)` returns a cached
`CompileResult` instead of recompiling (~9× on recurring compiles). `options.cache`: omitted/`true`
→ the process-global default store (`getDefaultCompileCache`, bounded LRU); `false` → bypass
(guaranteed-fresh compile); a `Map`/`createCompileCache(maxEntries)` → that store (with hit/miss
stats). The key (`compileCacheKey`) covers every output-affecting option with `compile()`'s own
defaults, so a difference can only MISS, never mis-hit; `baseDirs` resolve to absolute so a relative
dir keys by the file it actually reads (cwd-dependent). **The two inputs the key can't see —
`transformModule` behavior and imported-file bytes — are now a DEFAULT environment contract**: keep
them stable within a process, else a recompile of the same source returns stale bytecode. Escape
hatches: `cache: false` (bypass), `clearDefaultCompileCache()` (after editing an imported file), or
`cacheKeyExtra` (a fingerprint string mixed into the key). Results are cloned in and out, so a
caller can never corrupt the cache and every call returns a fresh mutable result.

**Compiler fixes (this branch):** (a) `new Array(n)` now **infers as DYNAMIC (heap) storage** so the
TUPLE descriptor survives a variable round-trip — scalar/bytes32 storage dropped the descriptor, so
`arr[i]` read/write reverted after `let a = new Array(n)`. (b) v12 `staticCall`/`delegateCall`
`stackEffect` is **-1** (they push a result), not -2 — fixes corrupt SDUP positions when a param is read
after a static call. (c) v12 assembly emits a **no-param ARG-PROLOGUE entry** that pushes the
compile-time args then falls through into `main` (the v12 analogue of v1's appended `CALL_FUNCTION` arg
segment) — so **parameterized programs run on the Huff runtime**. (`main` is inlined, not a table fn →
it can't recurse, same as v1.) (d) **Array destructuring of multi-output call returns**:
`const [price, tick] = pool.slot0()` compiles on v1+v12 and makes ONE external call — raw returndata
lands in a hidden heap temp, each bound element is re-derived via `INDEX(ABI_DECODE(READ(temp)))`, so
the decoded tuple is never stored and the v1 descriptor round-trip fault can't happen. Shape B
(`const s = pool.slot0()` then `s[k]`) keeps its store byte-identical (arrakis/pendle `return result`
bare reads still compile), but the indexed reads/writes that were guaranteed v1 runtime faults
(`SauceInvalidOperationArgs(INDEX)`) are now compile errors pointing at destructuring; v12 untouched.

**Known v12 limit (follow-up):** the Huff runtime's dynamic-value descriptor packs the data pointer in
16 bits (region `0x5000`→`0xFFFF`, ≈45 KB), so a program whose total dynamic data exceeds that gets a
truncated pointer → garbage read → revert. The fix needs a runtime-wide Huff pointer widening — out of
scope here.

**`sdk/`** — a data registry, no runtime logic. `src/protocols/<slug>/` per protocol (`info`,
`addresses`, `abis` as-const, `functions` SauceScript templates); `src/protocols/index.ts` is the
query registry. `src/skills/*.md` are AI-ready per-protocol docs (loaded by `loader.ts`, shipped in
the package). `src/chains/`, `src/recipes/`, `src/core/types.ts`. **SDK tests compile every protocol's
`sauceFunctions` through the real compiler — build the compiler first or they fail.**

**`actions/`** — `actionsToSauce(actions)` lowers routing intents (`uniswapV3ExactInput`, bridges,
wraps, stakes) to bytecode. Actions **chain**: output feeds the next implicitly (no `amountIn`) or via
`saveOutputAs`/`amountRef`. See `actions/AMM_SWAP_INTERFACES.md`.

**`dev-tools/`** — harness: `start:local`/`start:fork` boot a hardhat net + deploy the engine;
`npm run sauce <file.js> [args]` compiles+runs a SauceScript; `npm run recipe …` runs recipes.

## The swap Router (`../sauce/engine/src/Router.sol`)

Lives in the **private engine repo**, not here, but recipes target it (its `Router`/`SauceRouter`
artifacts are what `cook()` runs against). `SauceRouter` is a thin delegatecall proxy → `Router`
(`~1218` lines). Recipes import the minimal `ISauceRouter` ABI from `dev-tools/artifacts/`.

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

## Publishing

Tag-driven (`.github/workflows/publish.yml`): `git tag v1.2.3 && git push origin v1.2.3` (or manual
`workflow_dispatch`). Builds all areas, runs `prepack` (syncs artifacts), stamps the **root**
`package.json` version, and publishes the single `@eco-incorp/sauce-sdk` to **both** npmjs.com
(`NPM_TOKEN`) and GitHub Packages (`GITHUB_TOKEN`). Only the root version is published; workspace
packages stay `private`.
