#!/usr/bin/env node
// `tsc` only emits compiled .js/.d.ts — it does not copy the runtime asset
// `sdk/src/programs/token-sweep.sauce.ts` that `tokenSweepSource()`
// (sdk/dist/programs/index.js) reads from disk at RUN time via `readFileSync`.
// `src/**/*.sauce.ts` is excluded from the tsconfig (it is SauceScript, not
// TypeScript tsc can parse), so without this step a fresh `sdk/dist` would be
// missing the one file a partner needs in order to reproduce our bytecode.
// Mirrors `@eco-incorp/sauce-recipes`'s `scripts/copy-dist-assets.mjs` (same
// problem, same shape, different package).
//
// NOTE the dest directory is CREATED here rather than asserted. `tsc` does emit
// `dist/programs/` today (for `src/programs/index.ts`), so the mkdir is belt and
// braces — but the assert-only form this replaced would break the moment that
// directory holds nothing but `.sauce.ts` files, since every one of those is
// excluded from the tsconfig and tsc would emit no directory at all. Creating it
// costs nothing and removes that coupling to what else happens to live here.
//
// Run as part of `sdk`'s build: `tsc && node scripts/copy-verify-assets.mjs`.
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(SCRIPT_DIR, "..");

const ASSET = "token-sweep.sauce.ts";
const SUBDIR = "programs";
const src = join(SDK_DIR, "src", SUBDIR, ASSET);
const dest = join(SDK_DIR, "dist", SUBDIR, ASSET);

if (!existsSync(src)) {
  console.error(`copy-verify-assets: missing source asset ${src}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`copy-verify-assets: copied ${ASSET} -> dist/${SUBDIR}/`);
