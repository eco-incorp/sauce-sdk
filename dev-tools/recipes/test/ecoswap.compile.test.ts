/**
 * EcoSwap COMPILE-ONLY unit test (no fork, no RPC).
 *
 * Builds a minimal hand-rolled "prepared" dataset — the simplest real case:
 * TWO Uniswap V3 pools, a few brackets, no routes — and runs it through the
 * real compiler exactly the way index.ts does. This deterministically catches
 * compiler errors in ecoswap.sauce.ts (and arg-tuple encoding) without a fork.
 *
 * Run: npx tsx --test recipes/test/ecoswap.compile.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import ts from "typescript";

import { compile } from "../../../compiler/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECIPE_DIR = join(__dirname, "..", "ecoswap");
const REPO_ROOT = join(__dirname, "..", "..");

function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

// ── Minimal fixture: 2 V3 pools, no routes ───────────────────
const Q96 = 1n << 96n;

const WETH = BigInt("0x4200000000000000000000000000000000000006");
const USDC = BigInt("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const CALLER = BigInt("0x1111111111111111111111111111111111111111");
const PRICE_LIMIT = 4295128740n; // MIN_SQRT_RATIO + 1

// [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0]
const pools: bigint[][] = [
  [1n, BigInt("0xaaaa000000000000000000000000000000000001"), 500n, 10n, 0n, 500n, 0n, 1n],
  [1n, BigInt("0xbbbb000000000000000000000000000000000002"), 3000n, 60n, 0n, 3000n, 0n, 1n],
];
const routes: bigint[][] = [];

const sqrtNear = 2n * Q96;
function brkt(refIdx: bigint, near: bigint, far: bigint, L: bigint): bigint[] {
  // [kind, refIdx, sqrtNear, sqrtFar, liquidity, capacity, sqrtAdjNear, sqrtAdjFar]
  const cap = (L * Q96) / far - (L * Q96) / near;
  return [0n, refIdx, near, far, L, cap > 0n ? cap : 1n, near, far];
}
const brackets: bigint[][] = [
  brkt(0n, sqrtNear, (sqrtNear * 99n) / 100n, 10n ** 18n),
  brkt(0n, (sqrtNear * 99n) / 100n, (sqrtNear * 98n) / 100n, 10n ** 18n),
  brkt(1n, sqrtNear, (sqrtNear * 99n) / 100n, 5n * 10n ** 17n),
  brkt(1n, (sqrtNear * 99n) / 100n, (sqrtNear * 98n) / 100n, 5n * 10n ** 17n),
];

describe("ecoswap.sauce.ts", () => {
  it("compiles with a 2-V3-pool fixture", () => {
    const source = readFileSync(join(RECIPE_DIR, "ecoswap.sauce.ts"), "utf-8");
    const result: any = compile(stripTypes(source), {
      baseDirs: [REPO_ROOT, RECIPE_DIR],
      args: [WETH, USDC, 10n ** 18n, CALLER, 1n, PRICE_LIMIT, pools, routes, brackets],
    });
    const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;

    assert.ok(Array.isArray(segments) && segments.length >= 1, "should produce >=1 bytecode segment");
    for (const seg of segments) assert.ok(seg.length > 0, "segment should not be empty");
  });
});
