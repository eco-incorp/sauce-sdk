#!/usr/bin/env node
// Copies the contract artifacts the dev-tools recipes and deploy.ts read at runtime
// into dev-tools/artifacts/. That directory is gitignored (build output) but ships in
// the published package (root package.json `files`), so this runs at `prepack` — and
// on demand via `pnpm sync-artifacts` for local recipe runs / fork tests.
//
// Source: the `sauce` git dep's Foundry build output (engine/out/<X>.sol/<X>.json),
// produced by the compiler's postinstall `forge build`. Requires Foundry installed and
// `pnpm install` already run. Fails loudly rather than silently shipping empty artifacts.
import { existsSync, mkdirSync, copyFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEV_TOOLS_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(DEV_TOOLS_DIR, "..");
const ARTIFACTS_DIR = resolve(DEV_TOOLS_DIR, "artifacts");

// Contracts the recipes (`import … from "./artifacts/X.json"`, quoting.ts) and the
// deploy/fork-test flow (Router + SauceRouter, which carry deploy bytecode) read.
const ARTIFACTS = ["IERC20", "ISauceRouter", "IUniswapV3Pool", "Router", "SauceRouter"];

// Artifacts whose Foundry source file name differs from the contract name
// (name -> containing `<file>.sol` dir). IStateView lives in IUniswapV4.sol.
const EXTRA_ARTIFACTS = { IStateView: "IUniswapV4.sol" };

// V12 bridge contracts (engine/out). The Huff v12 runtime path deploys via the
// V12Kitchen/V12Pot proxy pair instead of the Solidity Router. Soft group: an
// older engine without them only warns (the v1 Router sync above still hard-fails).
const V12_ARTIFACTS = ["V12Kitchen", "V12Pot"];

// engine/out is reachable via the stable-named `sauce` symlink in compiler's (or the
// hoisted root) node_modules — avoids hardcoding the SHA-pinned pnpm store path.
const OUT_CANDIDATES = [
  resolve(REPO_ROOT, "compiler", "node_modules", "sauce", "engine", "out"),
  resolve(REPO_ROOT, "node_modules", "sauce", "engine", "out"),
];
const engineOut = OUT_CANDIDATES.find((p) => existsSync(p));

if (!engineOut) {
  console.error(
    "[sync-artifacts] engine build output not found. Run `pnpm install` with Foundry " +
      "installed so the compiler postinstall can `forge build` the sauce engine.",
  );
  process.exit(1);
}

mkdirSync(ARTIFACTS_DIR, { recursive: true });

const missing = [];
for (const name of ARTIFACTS) {
  const src = resolve(engineOut, `${name}.sol`, `${name}.json`);
  if (existsSync(src)) {
    copyFileSync(src, resolve(ARTIFACTS_DIR, `${name}.json`));
  } else {
    missing.push(name);
  }
}
for (const [name, srcDir] of Object.entries(EXTRA_ARTIFACTS)) {
  const src = resolve(engineOut, srcDir, `${name}.json`);
  if (existsSync(src)) {
    copyFileSync(src, resolve(ARTIFACTS_DIR, `${name}.json`));
  } else {
    missing.push(name);
  }
}

if (missing.length) {
  console.error(
    `[sync-artifacts] missing from engine build (${engineOut}): ${missing.join(", ")}`,
  );
  process.exit(1);
}

// V12 extras: bridge contracts + the Huff runtime creation-code snapshot. Soft —
// an older engine (pre-v12) lacks these, so warn (don't hard-fail) and let the v1
// flow proceed. engine-v12/snapshots lives one level up from engine/out.
const ENGINE_ROOT = resolve(engineOut, "..", "..");
let v12Copied = 0;
const v12Missing = [];
for (const name of V12_ARTIFACTS) {
  const src = resolve(engineOut, `${name}.sol`, `${name}.json`);
  if (existsSync(src)) {
    copyFileSync(src, resolve(ARTIFACTS_DIR, `${name}.json`));
    v12Copied++;
  } else {
    v12Missing.push(name);
  }
}
const v12SnapshotSrc = resolve(ENGINE_ROOT, "engine-v12", "snapshots", "V12RuntimeBytecode.json");
if (existsSync(v12SnapshotSrc)) {
  copyFileSync(v12SnapshotSrc, resolve(ARTIFACTS_DIR, "V12RuntimeBytecode.json"));
  v12Copied++;
} else {
  v12Missing.push("V12RuntimeBytecode");
}

if (v12Missing.length) {
  console.warn(
    `[sync-artifacts] V12 extras not found (engine predates v12 runtime?): ${v12Missing.join(", ")} ` +
      "— v12 recipe path will be unavailable; v1 sync unaffected.",
  );
}

const total = ARTIFACTS.length + Object.keys(EXTRA_ARTIFACTS).length + v12Copied;
console.log(`[sync-artifacts] copied ${total} artifacts -> dev-tools/artifacts/`);
