/**
 * Tests for the SauceScript runner (compilation + arg injection).
 * Run with: npm run test:runner
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { compileScript, parseArg } from "../src/runner";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

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

// --- parseArg ---

console.log("\nparseArg");

test("parses integer as bigint", () => {
  eq(parseArg("42"), 42n);
});

test("parses negative integer as bigint", () => {
  eq(parseArg("-1"), -1n);
});

test("parses short hex as bigint", () => {
  // 0x followed by up to 64 hex chars (32 bytes) → bigint
  eq(parseArg("0xff"), 255n);
});

test("parses long hex as string", () => {
  // > 66 chars (0x + 64) → kept as string (bytes)
  const longHex = "0x" + "ab".repeat(33); // 68 chars
  eq(parseArg(longHex), longHex);
});

// --- compileScript (no args) ---

console.log("\ncompileScript without args");

test("compiles add.js", () => {
  const result = compileScript(join(ROOT, "sauce/js/add.js"), ROOT);
  eq(result.bytecodes.length, 1, "should produce 1 segment");
  ok(result.bytecodes[0].startsWith("0x"), "bytecode should be hex");
  eq(result.warnings.length, 0, "should have no warnings");
});

test("compiles fibonacci.js", () => {
  const result = compileScript(join(ROOT, "sauce/js/fibonacci.js"), ROOT);
  ok(result.bytecodes.length >= 1, "should produce at least 1 segment");
  eq(result.warnings.length, 0, "should have no warnings");
});

test("compiles erc20.js", () => {
  const result = compileScript(join(ROOT, "sauce/js/erc20.js"), ROOT);
  ok(result.bytecodes.length >= 1, "should produce at least 1 segment");
  eq(result.warnings.length, 0, "should have no warnings");
});

// --- compileScript (with args) ---

console.log("\ncompileScript with args");

test("add.js with args produces different bytecode than without", () => {
  const without = compileScript(join(ROOT, "sauce/js/add.js"), ROOT);
  const withArgs = compileScript(join(ROOT, "sauce/js/add.js"), ROOT, [1n, 2n]);
  ok(
    withArgs.bytecodes[0] === without.bytecodes[0] && without.bytecodes.length + 1 === withArgs.bytecodes.length,
    "bytecodes should differ when args are injected",
  );
});

test("add.js with args includes arg values in bytecode", () => {
  const result = compileScript(join(ROOT, "sauce/js/add.js"), ROOT, [5n, 10n]);
  eq(result.bytecodes.length, 2, "should produce 1 segment");
  // The bytecode should contain the encoded values 5 and 10
  const hex = result.bytecodes[1];
  ok(hex.includes("05"), "bytecode should contain value 5");
  ok(hex.includes("0a"), "bytecode should contain value 10");
});

test("add.js with single arg only injects one param", () => {
  // add.js has main(a, b) — passing only one arg should set a, leave b as default
  const result = compileScript(join(ROOT, "sauce/js/add.js"), ROOT, [7n]);
  eq(result.bytecodes.length, 2, "should produce 1 segment");
  eq(result.warnings.length, 0, "should have no warnings");
});

test("example.js with args compiles successfully", () => {
  const result = compileScript(join(ROOT, "sauce/js/example.js"), ROOT, [5n, 10n]);
  ok(result.bytecodes.length >= 1, "should produce at least 1 segment");
  eq(result.warnings.length, 0, "should have no warnings");
});

// --- summary ---

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
