# sauce-sdk

Sauce protocol tooling, organized as a pnpm workspace.

## Packages

| Package | Path | Description |
| --- | --- | --- |
| `@eco-incorp/sauce-compiler` | [`compiler/`](compiler/) | Compiles JS-like recipes into Sauce bytecode. |
| `@eco-incorp/sauce-dev-tools` | [`dev-tools/`](dev-tools/) | Local dev environment, hardhat fork, recipe runner, examples. |
| `@eco-incorp/sauce-sdk` | [`sdk/`](sdk/) | TypeScript SDK for building Sauce recipes (protocols, chains, skills). |
| `@eco-incorp/sauce-actions` | [`actions/`](actions/) | High-level action primitives (e.g. AMM swaps) built on the SDK and compiler. |

## Getting started

```sh
pnpm install
pnpm build       # build compiler, sdk, actions
pnpm typecheck   # typecheck all packages
pnpm test        # run each package's tests
```

Within each package you can use its native scripts, e.g.:

```sh
pnpm --filter @eco-incorp/sauce-dev-tools start:local
pnpm --filter @eco-incorp/sauce-compiler test
```

## Publishing

Tag-driven workflows in [`.github/workflows/`](.github/workflows/):

- `compiler-v*` &rarr; publishes `@eco-incorp/sauce-compiler`
- `dev-tools-v*` &rarr; publishes `@eco-incorp/sauce-dev-tools`

Both publish to the `npm.pkg.github.com` registry.
