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

if (missing.length) {
  console.error(
    `[sync-artifacts] missing from engine build (${engineOut}): ${missing.join(", ")}`,
  );
  process.exit(1);
}

console.log(`[sync-artifacts] copied ${ARTIFACTS.length} artifacts -> dev-tools/artifacts/`);
