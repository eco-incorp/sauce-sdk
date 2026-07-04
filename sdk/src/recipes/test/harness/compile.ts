/**
 * Compile a SauceScript source string to bytecode segments via the in-repo
 * compiler, mirroring how recipes/ecoswap/index.ts strips TS types and resolves
 * artifact imports.
 *
 * baseDirs is set to [SRC_ROOT, recipeDir] so `import ... from "./artifacts/X.json"`
 * resolves against sdk/src/artifacts and recipe-local JSON resolves against the
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
    opts: {
      baseDirs: string[];
      args?: unknown[];
      target?: "v1" | "v12";
      treeshake?: boolean;
      defines?: Record<string, boolean>;
    },
  ) => {
    bytecode?: Uint8Array[];
    bytecodes?: Uint8Array[];
    warnings?: unknown[];
  };
};

const __dirname = dirname(fileURLToPath(import.meta.url));
// harness/ → test/ → recipes/ → src/ : sdk/src is the recipes' REPO_ROOT (resolves ./artifacts).
export const SRC_ROOT = join(__dirname, "..", "..", "..");
export const ECOSWAP_DIR = join(SRC_ROOT, "recipes", "ecoswap");

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
 * `opts.defines` + `opts.treeshake` exercise the PRODUCTION compile path (index.ts
 * passes protocolDefines(prepared) with treeshake:true); pass them to compile the
 * treeshaken define set a real cook carries, not the un-treeshaken all-true default.
 */
export function compileSauce(
  tsSource: string,
  args: unknown[],
  recipeDir: string = ECOSWAP_DIR,
  target: "v1" | "v12" = "v1",
  opts: { treeshake?: boolean; defines?: Record<string, boolean> } = {},
): { bytecodes: Hex[]; warnings: unknown[] } {
  const jsSource = stripTypes(tsSource);
  // UNDER-merge defaults for the NEWEST HAS_* flags: every per-family test carries an explicit,
  // historically-complete define map, and a family added AFTER a test was written would otherwise
  // keep its source-default `true` in that test's "my-family-only" build (dead venue code shipping
  // silently — or, pre-declaration, an undefined-variable compile error). Defaulting the new flags
  // to false preserves each old map's exact treeshake semantics; a caller that mentions the flag
  // explicitly (a new-family test / production protocolDefines, which is always complete) wins.
  const defines = opts.defines
    ? { HAS_TESSERA: false, HAS_ELFOMO: false, ...opts.defines }
    : undefined;
  const result = compile(jsSource, {
    baseDirs: [SRC_ROOT, recipeDir], args, target,
    treeshake: opts.treeshake, defines,
  });
  const segments = result.bytecode ?? result.bytecodes ?? [];
  return { bytecodes: segments.map(toHex), warnings: result.warnings ?? [] };
}
