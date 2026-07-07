#!/usr/bin/env node
// DIST-resolution smoke: proves the PUBLISHED /recipes export resolves its runtime
// assets from dist (no live RPC). Verifies, against sdk/dist:
//   1. the built recipe barrel imports and exposes ecoSwap/megaSwap/etc.
//   2. each recipe's `.sauce.ts` exists at the dist __dirname it readFileSyncs.
//   3. compiling a recipe's `.sauce.ts` with the recipe's OWN dist baseDirs
//      ([REPO_ROOT=dist, __dirname=dist/recipes/<name>]) resolves every JSON
//      import — the engine `./artifacts/*.json` AND the sibling ABI JSONs —
//      i.e. the exact path the dist-run recipe takes, with no ENOENT.
//
// Run (after `pnpm --filter ./sdk build`): node src/recipes/test/dist-resolution.smoke.mjs
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { compile } = require("@eco-incorp/sauce-compiler");

const HERE = dirname(fileURLToPath(import.meta.url)); // sdk/src/recipes/test
const SDK = join(HERE, "..", "..", "..");             // sdk
const DIST = join(SDK, "dist");
const DIST_RECIPES = join(DIST, "recipes");

function stripTypes(src) {
  return ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

const Q96 = 1n << 96n;
const WETH = BigInt("0x4200000000000000000000000000000000000006");
const USDC = BigInt("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const CALLER = BigInt("0x1111111111111111111111111111111111111111");
const PRICE_LIMIT = 4295128740n;
const sqrtNear = 2n * Q96;
const brkt = (refIdx, near, far, L) => {
  const cap = (L * Q96) / far - (L * Q96) / near;
  return [0n, refIdx, near, far, L, cap > 0n ? cap : 1n, near, far];
};

async function main() {
  // (1) the built barrel loads and exposes the recipe fns.
  const barrel = await import(join(DIST_RECIPES, "index.js"));
  for (const fn of ["ecoSwap", "megaSwap", "alphaSwap", "gigaSwap", "terraSwap"]) {
    assert.equal(typeof barrel[fn], "function", `dist barrel must export ${fn}()`);
  }
  console.log("[smoke] dist barrel exports all 5 recipe fns OK");

  // (2) every recipe's runtime-read .sauce.ts exists at its dist __dirname.
  const sauceReads = [
    ["megaswap", "megaswap.sauce.ts"],
    ["alphaswap", "alphaswap.sauce.ts"],
    ["gigaswap", "gigaswap.sauce.ts"],
    ["terraswap", "swap-series.sauce.ts"],
    ["ecoswap", "ecoswap.sauce.ts"],
    ["ecoswap", "ecoswap.lens.sauce.ts"],
  ];
  for (const [name, file] of sauceReads) {
    const p = join(DIST_RECIPES, name, file);
    assert.ok(existsSync(p), `dist must contain ${name}/${file} (recipe readFileSyncs it)`);
  }
  console.log(`[smoke] all ${sauceReads.length} runtime .sauce.ts present in dist OK`);

  // (3) compile ecoswap.sauce.ts from dist with the recipe's OWN dist baseDirs.
  //     REPO_ROOT = join(__dirname,"..","..") = dist; __dirname = dist/recipes/ecoswap.
  //     This resolves ./artifacts/*.json (engine) + ./IUniswapV2Pair.json etc. (siblings).
  const ecoDir = join(DIST_RECIPES, "ecoswap");
  const REPO_ROOT = join(ecoDir, "..", ".."); // === DIST
  assert.equal(REPO_ROOT, DIST, "recipe REPO_ROOT must resolve to dist");
  const source = readFileSync(join(ecoDir, "ecoswap.sauce.ts"), "utf-8");
  const stripped = stripTypes(source);
  const pools = [
    [1n, BigInt("0xaaaa000000000000000000000000000000000001"), 500n, 10n, 0n, 500n, 0n, 1n, 0n, 0n],
    [1n, BigInt("0xbbbb000000000000000000000000000000000002"), 3000n, 60n, 0n, 3000n, 0n, 1n, 0n, 0n],
  ];
  const brackets = [
    brkt(0n, sqrtNear, (sqrtNear * 99n) / 100n, 10n ** 18n),
    brkt(1n, sqrtNear, (sqrtNear * 99n) / 100n, 5n * 10n ** 17n),
  ];
  const args = [WETH, USDC, 10n ** 18n, CALLER, 1n, PRICE_LIMIT, pools, [], brackets];

  for (const target of ["v1", "v12"]) {
    const result = compile(stripped, { baseDirs: [REPO_ROOT, ecoDir], args, target });
    const segments = result.bytecode ?? result.bytecodes;
    assert.ok(Array.isArray(segments) && segments.length >= 1, `${target}: >=1 segment from dist compile`);
    assert.ok(segments.every((s) => s.length > 0), `${target}: no empty segment`);
  }
  console.log("[smoke] ecoswap.sauce.ts compiled from dist (v1+v12) — artifacts + sibling ABIs resolved OK");

  console.log("[smoke] PASS — published /recipes resolves its dist assets without ENOENT");
}

main().catch((e) => {
  console.error("[smoke] FAIL:", e?.message ?? e);
  process.exit(1);
});
