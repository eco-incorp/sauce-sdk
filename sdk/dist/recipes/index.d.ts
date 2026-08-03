/** Absolute path to the `settle.sauce.ts` source inside THIS installed package. */
export declare const SETTLE_SOURCE_PATH: string;
/**
 * `baseDirs` for compiling any program in this directory.
 *
 * One entry is sufficient and it is not this directory: it is the package's dist root, because what
 * needs resolving is the program's `import { IERC20 } from "./artifacts/IERC20.json"` — which lands
 * at `<dist>/artifacts/IERC20.json` (vendored from the pinned engine and shipped in this package's
 * `files` list). Measured: `[distRoot]` alone reproduces the identical bytes.
 */
export declare const SAUCE_BASE_DIRS: readonly string[];
/**
 * The `settle.sauce.ts` program text — sweep the Pot's balance of every listed token to one
 * recipient, with a minimum-output floor on `tokens[0]`. Read once and cached.
 *
 * Returned as the raw source (not pre-stripped, not pre-compiled) so a partner can read, hash, or
 * diff exactly what gets compiled. Pass `tsSource: true` so the compiler's own front-end handles
 * the TypeScript annotations.
 */
export declare function settleSource(): string;
//# sourceMappingURL=index.d.ts.map