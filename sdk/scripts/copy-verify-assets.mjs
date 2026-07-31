#!/usr/bin/env node
// `tsc` only emits compiled .js/.d.ts — it does not copy the runtime asset
// `sdk/src/verify/ecoswap.settle.sauce.ts`'s own sibling `compileSettleProgram`
// (sdk/dist/verify/compile.js) reads from disk at RUN time via `readFileSync`.
// `src/**/*.sauce.ts` is excluded from the tsconfig (it is SauceScript, not
// TypeScript tsc can parse), so without this step a fresh `sdk/dist` would be
// missing the one file `compileSettleProgram` needs to do anything at all.
// Mirrors `@eco-incorp/sauce-recipes`'s `scripts/copy-dist-assets.mjs` (same
// problem, same shape, different package).
//
// Run as part of `sdk`'s build: `tsc && node scripts/copy-verify-assets.mjs`.
import { existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(SCRIPT_DIR, "..");

const ASSET = "ecoswap.settle.sauce.ts";
const src = join(SDK_DIR, "src", "verify", ASSET);
const dest = join(SDK_DIR, "dist", "verify", ASSET);

if (!existsSync(src)) {
  console.error(`copy-verify-assets: missing source asset ${src}`);
  process.exit(1);
}
if (!existsSync(dirname(dest))) {
  console.error(`copy-verify-assets: dist/verify does not exist yet — did tsc run first? (${dest})`);
  process.exit(1);
}
copyFileSync(src, dest);
console.log(`copy-verify-assets: copied ${ASSET} -> dist/verify/`);
