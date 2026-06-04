# sauce-sdk

Tooling for the Sauce protocol, published as a single npm package: `@eco-incorp/sauce-sdk`.

Includes:

- A JS-like recipe **compiler** that emits Sauce bytecode.
- A TypeScript **SDK** for building recipes against on-chain protocols (Uniswap, Curve, Balancer, …).
- High-level **action primitives** (AMM swaps, multi-hop, split routing).
- A local **dev environment** (hardhat fork, recipe runner, examples).

## Install

```sh
pnpm add @eco-incorp/sauce-sdk
# or
npm install @eco-incorp/sauce-sdk
```

## Repo layout

Sources are organised as a pnpm workspace for development; everything ships under the single `@eco-incorp/sauce-sdk` name at publish time.

| Path | What's in it |
| --- | --- |
| [`compiler/`](compiler/) | Recipe compiler (JS → Sauce bytecode) |
| [`sdk/`](sdk/) | Protocols, chains, skills, recipes |
| [`actions/`](actions/) | High-level action primitives |
| [`dev-tools/`](dev-tools/) | Local fork environment, recipe runner, examples |

## Development

```sh
pnpm install
pnpm build       # build compiler, sdk, actions
pnpm typecheck   # typecheck all packages
pnpm test        # run all tests
```

## Publishing

Tag-driven via [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

```sh
git tag v1.2.3 && git push origin v1.2.3
```

The workflow stamps every workspace package with the tag's version and publishes to npmjs.
