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

## Architecture

**`compiler/`** — parses **SauceScript** (a uint256-only JS subset; no closures/classes/async, strict
equality; full surface in `compiler/README.md`) to bytecode. `src/index.ts` `compile()` parses via
`acorn` and emits `Uint8Array[]`; `src/processor/` walks the AST (expression/statement/collection/
inference); `src/saucer/` emits bytecode (`Saucer` builder, `ops.ts` opcode table, per-type encoders);
`src/context.ts` tracks functions/var kinds/ABIs; `src/contracts.ts` loads contract ABIs from artifact
JSON for `import { X } from "./X.json"` + `.at()/.view()/.lib()` binding.

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

## Recipes

A recipe prepares pool data off-chain and executes it on-chain via one `cook()`. **Recipes exist in
two drifted trees:**

- `sdk/src/recipes/` — published library copy (`megaswap`, `alphaswap`), **untested**, behind dev-tools.
- `dev-tools/recipes/` — source of truth (`megaswap`, `alphaswap`, `gigaswap`, `terraswap`), with the
  CLI runner and fork tests. **Trust this tree.**

Each recipe dir: `prepare.ts` (off-chain read-only RPC — discover/quote pools, compute slippage),
`<name>.sauce.ts` (a **static** SauceScript template — not string-interpolated; read from disk, types
stripped via `ts.transpileModule`, pool data passed as compiler **`args`**), `index.ts` (orchestrator:
client → prepare → compile → `{ bytecodes, prepared, source }`), `shared/` (pool-discovery, quoting,
constants, types). **The compiler must be built first** — sdk recipes import it by relative `dist`
path, dev-tools recipes via the `@eco-incorp/sauce-compiler` workspace dep.

### Running recipes against a fork / RPC (in `dev-tools/`)

```sh
pnpm sync-artifacts                                          # populate dev-tools/artifacts/ (once)
npm run start:fork https://eth-mainnet.g.alchemy.com/v2/KEY  # boot fork + deploy, writes .deployment.json
npm run recipe megaswap WETH USDC 1
npm run stop
npm run recipe megaswap WETH USDC 0.01 -- --network base     # live: hardcoded router + BASE_RPC_URL + PRIVATE_KEY
```

`scripts/recipe.ts` reads `.deployment.json`, auto-wraps ETH→WETH, auto-approves the router,
prepares+compiles, `cook()`s, and parses `Transfer` logs. Tokens: `WETH/USDC/DAI/USDbC` or raw `0x`.

### Artifacts

`dev-tools/artifacts/*.json` (gitignored build output) are read by recipes (`quoting.ts`, the
`.sauce.ts` JSON imports) and `deploy.ts` (`Router`/`SauceRouter` carry deploy bytecode). Populate
them with **`pnpm sync-artifacts`**, which copies the `sauce` engine's Foundry build output (`forge
build` runs in the compiler `postinstall`). This also runs automatically at **`prepack`** so the
published package ships them.

### Recipe tests (not wired into `npm test`)

`dev-tools/recipes/test/{megaswap,alphaswap,gigaswap}.test.ts` are self-contained fork tests (plain
`tsx` + hand-rolled asserts) — boot a fork pinned to a fixed block, deploy router, fund/approve,
`prepare+compile+cook`, assert on balance deltas + events. Require `BASE_RPC_URL`, run manually
(`BASE_RPC_URL=<url> npx tsx recipes/test/megaswap.test.ts`). dev-tools `npm test` only runs the
`examples`/`runner` compile tests; sdk recipes have no tests; `terraswap` has no test.

## Publishing

Tag-driven (`.github/workflows/publish.yml`): `git tag v1.2.3 && git push origin v1.2.3` (or manual
`workflow_dispatch`). Builds all areas, runs `prepack` (syncs artifacts), stamps the **root**
`package.json` version, and publishes the single `@eco-incorp/sauce-sdk` to **both** npmjs.com
(`NPM_TOKEN`) and GitHub Packages (`GITHUB_TOKEN`). Only the root version is published; workspace
packages stay `private`.
