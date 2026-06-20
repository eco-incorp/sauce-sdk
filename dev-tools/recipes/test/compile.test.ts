/**
 * Recipe COMPILE-ONLY unit tests (no fork, no RPC).
 *
 * Every recipe's .sauce.ts must compile against the current in-repo compiler.
 * This is the fast guard that catches drift from the compiler's real surface
 * (e.g. THIS_ADDRESS()/ABI_DECODE()/MUL_DIV() — intrinsics from the deprecated
 * compiler-poc that the current compiler replaced with address.self / auto-decode
 * / Math.mulDiv). The struct swap() bodies are exercised at runtime by the fork
 * tests; here we only assert they produce bytecode.
 *
 * Run: npx tsx --test recipes/test/compile.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import ts from "typescript";

import { compile } from "../../../compiler/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECIPES = join(__dirname, "..");
const DEV_TOOLS = join(RECIPES, "..");

function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

// recipe → its .sauce.ts (relative to recipes/)
const SCRIPTS: [string, string][] = [
  ["megaswap", "megaswap/megaswap.sauce.ts"],
  ["gigaswap", "gigaswap/gigaswap.sauce.ts"],
  ["alphaswap", "alphaswap/alphaswap.sauce.ts"],
  ["terraswap", "terraswap/swap-series.sauce.ts"],
];

describe("recipe sauce scripts compile", () => {
  for (const [name, rel] of SCRIPTS) {
    it(`${name} (${rel}) compiles to bytecode`, () => {
      const recipeDir = join(RECIPES, dirname(rel));
      const src = stripTypes(readFileSync(join(RECIPES, rel), "utf-8"));
      // DEV_TOOLS resolves "./artifacts/*.json"; recipeDir resolves recipe-local JSON imports.
      const result: any = compile(src, { baseDirs: [DEV_TOOLS, RECIPES, recipeDir] });
      const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;

      assert.ok(Array.isArray(segments) && segments.length >= 1, "should produce >=1 bytecode segment");
      for (const seg of segments) assert.ok(seg.length > 0, "segment should not be empty");
      assert.deepEqual(result.warnings ?? [], [], "compiler should emit no warnings");
    });
  }
});
