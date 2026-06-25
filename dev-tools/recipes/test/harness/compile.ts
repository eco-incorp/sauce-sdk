/**
 * Compile a SauceScript source string to bytecode segments via the in-repo
 * compiler, mirroring how recipes/ecoswap/index.ts strips TS types and resolves
 * artifact imports.
 *
 * baseDirs is set to [DEV_TOOLS, recipeDir] so `import ... from "./artifacts/X.json"`
 * resolves against dev-tools/artifacts and recipe-local JSON resolves against the
 * recipe dir (same convention as index.ts).
 */

import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Hex } from "viem";

const require = createRequire(import.meta.url);
const { compile } = require("@eco-incorp/sauce-compiler") as {
  compile: (
    src: string,
    opts: { baseDirs: string[]; args?: unknown[]; target?: "v1" | "v12" },
  ) => {
    bytecode?: Uint8Array[];
    bytecodes?: Uint8Array[];
    warnings?: unknown[];
  };
};

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEV_TOOLS = join(__dirname, "..", "..", "..");
export const ECOSWAP_DIR = join(DEV_TOOLS, "recipes", "ecoswap");

function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

function toHex(bytes: Uint8Array): Hex {
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

/**
 * Compile a TS-typed SauceScript string with the given compiler args.
 * `recipeDir` (for recipe-local JSON imports) defaults to the ecoswap dir; the
 * minimal gate script only imports from ./artifacts so either works.
 * `target` selects the bytecode surface: "v1" (prefix, Solidity Router) or "v12"
 * (postfix, Huff runtime). Both produce a `bytes[]` blob that cook() accepts.
 */
export function compileSauce(
  tsSource: string,
  args: unknown[],
  recipeDir: string = ECOSWAP_DIR,
  target: "v1" | "v12" = "v1",
): { bytecodes: Hex[]; warnings: unknown[] } {
  const jsSource = stripTypes(tsSource);
  const result = compile(jsSource, { baseDirs: [DEV_TOOLS, recipeDir], args, target });
  const segments = result.bytecode ?? result.bytecodes ?? [];
  return { bytecodes: segments.map(toHex), warnings: result.warnings ?? [] };
}
