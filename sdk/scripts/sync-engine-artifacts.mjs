#!/usr/bin/env node
// Sync the committed Sauce engine artifacts (Router/SauceRouter/V12 runtime +
// interfaces) that downstream SDK consumers read for local tests and deploys,
// FROM the pinned `sauce` git dep's build output. These live at
// sdk/dist/artifacts/ (committed — sdk/dist ships to git-URL/tarball consumers)
// and were previously hand-maintained, so a `sauce` repin silently left them
// stale (their ABI + bytecode drift from the pinned engine). This script is the
// single source of truth; CI runs it and `git diff --exit-status`es the result,
// so a repin without a re-sync fails loudly instead of shipping a stale engine.
//
// Provenance (all present after `pnpm install` — the compiler postinstall
// `forge build`s engine/, and the v12 runtime snapshot is checked into the dep):
//   - 8 EVM artifacts: engine/out/<Sol>/<Name>.json (Foundry, solc 0.8.27 pinned
//     → byte-reproducible across machines on the same foundry version, which CI
//     pins to match)
//   - V12RuntimeBytecode: engine-v12/snapshots/V12RuntimeBytecode.json (a
//     prebuilt Huff-runtime snapshot committed in the dep — no Huff toolchain
//     needed here)
//
// Run: `pnpm --filter './sdk' sync-engine-artifacts` (after `pnpm install`).
// NOTE: a `rm -rf sdk/dist` clean build drops these (tsc emits no JSON) — re-run
// this after such a build. The normal `tsc` build leaves them in place.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(SDK_DIR, '..');

// The `sauce` dep is a devDep of the compiler; pnpm exposes it under a
// stable-named symlink there (or hoisted at the root). Same resolution rule as
// dev-tools/scripts/sync-artifacts.js — never hardcode the SHA-pinned store path.
const SAUCE_CANDIDATES = [
  resolve(REPO_ROOT, 'compiler', 'node_modules', 'sauce'),
  resolve(REPO_ROOT, 'node_modules', 'sauce'),
];
const sauce = SAUCE_CANDIDATES.find((p) => existsSync(p));

if (!sauce) {
  console.error(
    '[sync-engine-artifacts] `sauce` dep not found. Run `pnpm install` first ' +
      '(with Foundry installed so the compiler postinstall can `forge build` the engine).',
  );
  process.exit(1);
}

// name -> path within the sauce dep. Order/set matches the committed
// sdk/dist/artifacts contents exactly.
const SOURCES = {
  Router: 'engine/out/Router.sol/Router.json',
  SauceRouter: 'engine/out/SauceRouter.sol/SauceRouter.json',
  ISauceRouter: 'engine/out/ISauceRouter.sol/ISauceRouter.json',
  V12Pot: 'engine/out/V12Pot.sol/V12Pot.json',
  V12Kitchen: 'engine/out/V12Kitchen.sol/V12Kitchen.json',
  IERC20: 'engine/out/IERC20.sol/IERC20.json',
  IUniswapV3Pool: 'engine/out/IUniswapV3Pool.sol/IUniswapV3Pool.json',
  IStateView: 'engine/out/IUniswapV4.sol/IStateView.json',
  V12RuntimeBytecode: 'engine-v12/snapshots/V12RuntimeBytecode.json',
};

// Committed + shipped location first; the gitignored src copy is kept coherent
// for local dev (nothing imports it today, but a stale copy there is confusing).
const DESTS = [resolve(SDK_DIR, 'dist', 'artifacts'), resolve(SDK_DIR, 'src', 'artifacts')];
for (const d of DESTS) mkdirSync(d, { recursive: true });

const missing = [];
for (const [name, rel] of Object.entries(SOURCES)) {
  const src = resolve(sauce, rel);

  if (!existsSync(src)) {
    missing.push(`${name} (${rel})`);
    continue;
  }

  for (const dest of DESTS) copyFileSync(src, resolve(dest, `${name}.json`));
}

if (missing.length) {
  console.error(
    `[sync-engine-artifacts] missing from the pinned engine build: ${missing.join(', ')}. ` +
      'Ensure Foundry is installed and `pnpm install` ran the engine forge build.',
  );
  process.exit(1);
}

console.log(`[sync-engine-artifacts] synced ${Object.keys(SOURCES).length} artifacts from ${sauce}`);
