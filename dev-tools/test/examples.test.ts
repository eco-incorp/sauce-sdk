/**
 * Tests that all example scripts in sauce/js and sauce/ts compile successfully.
 * Run with: npm test
 */

import { join, dirname } from "path";
import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { compile } = require("@eco/sauce-compiler");

/** Strip TypeScript type annotations, returning plain JS */
function stripTypes(source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  return result.outputText;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const JS_DIR = join(ROOT, "sauce", "js");
const TS_DIR = join(ROOT, "sauce", "ts");
const BASE_DIRS = [ROOT, join(ROOT, "node_modules")];

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✕ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

function ok(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function eq(actual: any, expected: any, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`);
  }
}

console.log("\nexample scripts compile (sauce/js)");
const jsScripts = readdirSync(JS_DIR).filter((f) => f.endsWith(".js"));

for (const file of jsScripts) {
  test(`sauce/js/${file}`, () => {
    const source = readFileSync(join(JS_DIR, file), "utf-8");
    const result = compile(source, { baseDirs: BASE_DIRS });
    ok(result.bytecode.length >= 1, "should produce at least one segment");
    for (const seg of result.bytecode) {
      ok(seg.length > 0, "segment should not be empty");
    }
    eq(
      result.warnings.length,
      0,
      `unexpected warnings: ${result.warnings.join(", ")}`,
    );
  });
}

console.log("\nexample scripts compile (sauce/ts)");
const tsScripts = readdirSync(TS_DIR).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
);

for (const file of tsScripts) {
  test(`sauce/ts/${file}`, () => {
    const raw = readFileSync(join(TS_DIR, file), "utf-8");
    const source = stripTypes(raw);
    const result = compile(source, { baseDirs: BASE_DIRS });
    ok(result.bytecode.length >= 1, "should produce at least one segment");
    for (const seg of result.bytecode) {
      ok(seg.length > 0, "segment should not be empty");
    }
    eq(
      result.warnings.length,
      0,
      `unexpected warnings: ${result.warnings.join(", ")}`,
    );
  });
}

console.log("\nts and js produce identical bytecodes");

for (const tsFile of tsScripts) {
  const jsFile = tsFile.replace(/\.ts$/, ".js");
  if (!jsScripts.includes(jsFile)) continue;
  test(`sauce/ts/${tsFile} matches sauce/js/${jsFile}`, () => {
    const jsSource = readFileSync(join(JS_DIR, jsFile), "utf-8");
    const tsSource = stripTypes(readFileSync(join(TS_DIR, tsFile), "utf-8"));
    const jsResult = compile(jsSource, { baseDirs: BASE_DIRS });
    const tsResult = compile(tsSource, { baseDirs: BASE_DIRS });
    eq(
      jsResult.bytecode.length,
      tsResult.bytecode.length,
      "segment count mismatch",
    );
    for (let i = 0; i < jsResult.bytecode.length; i++) {
      const jsHex = Buffer.from(jsResult.bytecode[i]).toString("hex");
      const tsHex = Buffer.from(tsResult.bytecode[i]).toString("hex");
      eq(jsHex, tsHex, `segment ${i} bytecode mismatch`);
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
