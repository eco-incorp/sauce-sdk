#!/usr/bin/env node
// Copies the recipe RUNTIME assets that `tsc` does not emit into dist, so the
// published `/recipes` export resolves them when imported from dist:
//
//   - the `.sauce.ts` SauceScript templates (each recipe's index.ts/lens.ts does
//     `readFileSync(join(__dirname, "<name>.sauce.ts"))` — they're read as text,
//     not compiled, and are excluded from the tsc build).
//   - the checked-in ABI `*.json` next to the recipe code (the `.sauce.ts` files
//     `import { X } from "./IUniswapV2Pair.json"`, resolved by the compiler's
//     `baseDirs: [REPO_ROOT, __dirname]` at compile time, NOT by tsc).
//   - the engine `artifacts/*.json`, resolved via each recipe's
//     `REPO_ROOT = join(__dirname, "..", "..")` → `dist` when running from
//     `dist/recipes/<name>/`, so they must live at `dist/artifacts/`.
//
// The recipe `test/` tree (harness + ~5 MB anvil-state fixtures + Solidity src)
// is in-repo only and is NOT copied (it is also excluded from publish via the
// root `.npmignore`).
//
// Mirrors structure: src/recipes/<name>/<asset> → dist/recipes/<name>/<asset>,
// and src/artifacts/<x>.json → dist/artifacts/<x>.json. Run after `tsc` (sdk
// `build` script). No deps — plain Node + node:fs.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(SDK, "src");
const DIST = join(SDK, "dist");

if (!existsSync(DIST)) {
  // Soft skip: nothing to populate (no build yet). The sdk `build` script always
  // runs `tsc` before this, so a missing dist only happens when invoked standalone
  // (e.g. prepack before a build) — in which case there's nothing to publish anyway.
  console.warn("[copy-recipe-assets] dist/ not found — skipping (run `tsc` first).");
  process.exit(0);
}

/** Recursively copy files under `srcDir` matching `keep`, into `destDir`,
 *  preserving structure and skipping any path segment named in `skipDirs`. */
function copyTree(srcDir, destDir, keep, skipDirs = new Set()) {
  let copied = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile() && keep(entry.name)) {
        const dest = join(destDir, relative(srcDir, abs));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(abs, dest);
        copied++;
      }
    }
  };
  walk(srcDir);
  return copied;
}

// Recipe assets: .sauce.ts + checked-in ABI .json (excl. the test tree).
const recipesSrc = join(SRC, "recipes");
const isAsset = (name) => name.endsWith(".sauce.ts") || name.endsWith(".json");
const recipeCopied = copyTree(
  recipesSrc,
  join(DIST, "recipes"),
  isAsset,
  new Set(["test"]),
);

// Engine artifacts → dist/artifacts (recipe REPO_ROOT = dist when run from dist).
let artifactCopied = 0;
const artifactsSrc = join(SRC, "artifacts");
if (existsSync(artifactsSrc) && statSync(artifactsSrc).isDirectory()) {
  artifactCopied = copyTree(artifactsSrc, join(DIST, "artifacts"), (n) => n.endsWith(".json"));
}
if (artifactCopied === 0) {
  console.warn(
    "[copy-recipe-assets] no artifacts copied — run `pnpm sync-artifacts` so " +
      "dist-run recipes can resolve ./artifacts/*.json (build still emitted code).",
  );
}

console.log(
  `[copy-recipe-assets] copied ${recipeCopied} recipe assets + ${artifactCopied} artifacts into dist/`,
);
