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
// Provenance:
//   - 8 EVM artifacts (REQUIRED): engine/out/<Sol>/<Name>.json — present after
//     `pnpm install`, whose compiler postinstall `forge build`s engine/. Foundry,
//     solc 0.8.27 pinned → byte-reproducible across machines on the same foundry
//     version, which CI pins to match. These are what CI's drift check enforces.
//   - V12RuntimeBytecode (OPTIONAL): engine-v12/snapshots/V12RuntimeBytecode.json.
//
// Why the v12 runtime is OPTIONAL rather than required. It used to be a snapshot
// committed IN the dep, so this script just copied it. The engine dropped that
// committed copy (`chore(v12): compile the runtime at deploy time` — it was a
// second source of truth that rotted: a change to six .huff handlers shipped with
// a snapshot built from the pre-change source, through green CI, and the deploy
// script would have pushed those stale bytes to eleven live chains). The engine
// now compiles `v12/Runtime.huff` via `hnc` at deploy time, and `hnc` is a
// first-class dependency THERE.
//
// It is not one here: this repo's CI installs Foundry only (no Huff toolchain, no
// Solana toolchain — see .github/workflows/ci.yml), and that same CI re-runs this
// script and fails on any drift in sdk/dist/artifacts. So requiring the snapshot
// would make the drift check unsatisfiable on every pin that lacks it. The
// engine's own generator (engine-v12/script/V12RuntimeBytecode.s.sol) exists for
// exactly this consumer — its doc comment names "the sauce-sdk viem test harness,
// which deploys engine runtimes from checked-in creation code" as the reason it
// still writes the JSON on demand.
//
// So: when the pinned dep HAS the snapshot it is copied (older pins keep working
// unchanged); when it does not, the committed copy is left alone and reported.
// Refreshing it after a v12 runtime change is a deliberate, Huff-toolchain-local
// step — from a checkout of the pinned commit, with `hnc` on PATH:
//   cd engine-v12 && git submodule update --init --recursive --depth 1
//   forge script script/V12RuntimeBytecode.s.sol --sig "run()" --ffi
// then copy snapshots/V12RuntimeBytecode.json over sdk/src/artifacts/ +
// sdk/dist/artifacts/ and commit. The generator sanity-deploys the creation code
// before writing, so a broken snapshot fails there rather than downstream.
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
};

// Copied when the pinned dep provides it, skipped (committed copy left intact)
// when it does not — see the header for why this one cannot be required here.
const OPTIONAL_SOURCES = {
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

// Optional artifacts: copy when the pin ships them, otherwise keep the committed
// copy and say so. Never fatal — a pin that compiles its Huff runtime at deploy
// time legitimately has no snapshot to copy.
const skipped = [];
for (const [name, rel] of Object.entries(OPTIONAL_SOURCES)) {
  const src = resolve(sauce, rel);

  if (!existsSync(src)) {
    skipped.push(name);
    continue;
  }

  for (const dest of DESTS) copyFileSync(src, resolve(dest, `${name}.json`));
}

console.log(`[sync-engine-artifacts] synced ${Object.keys(SOURCES).length} artifacts from ${sauce}`);

if (skipped.length) {
  console.log(
    `[sync-engine-artifacts] kept the committed copy of: ${skipped.join(', ')} — not shipped by this ` +
      'pin (the engine compiles its v12 Huff runtime at deploy time). Refresh it with the engine\'s own ' +
      'generator when the v12 runtime changes; see this script\'s header for the exact commands.',
  );
}
