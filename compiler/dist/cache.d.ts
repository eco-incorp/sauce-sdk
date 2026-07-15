import type { CompileOptions, CompileResult } from './index.js';
/**
 * A memo store `compile()` consults when passed `{ cache }`. `Map` satisfies it;
 * `createCompileCache()` adds bounded size + hit/miss stats. Values handed to
 * `set` and returned from `get` are already defensively cloned by `compile()`,
 * so an implementation may store the reference as-is.
 */
export interface CompileCache {
    get(key: string): CompileResult | undefined;
    set(key: string, value: CompileResult): void;
}
/**
 * The cache key for a compile. Includes every input that affects output, with
 * the SAME defaults `compile()` applies (so `{}` and `{ treeshake: true }` share
 * an entry). `transformModule` collapses to a presence flag — its behavior is
 * part of the cache's environment contract, not the key (see the file header).
 */
export declare function compileCacheKey(source: string, options?: CompileOptions): string;
/**
 * Deep copy so a cached result and a caller's copy never share mutable state:
 * bytecode buffers are fresh (a caller may transfer/patch them), and the plan/
 * argsLayout — plain data (no class instances, no functions) — are rebuilt.
 * `compile()` stores a clone and returns a clone on a hit, so nothing a caller
 * does to a returned result can corrupt the cache, and nothing a later compile
 * does can corrupt an already-returned result.
 */
export declare function cloneCompileResult(result: CompileResult): CompileResult;
export interface CompileCacheStats {
    hits: number;
    misses: number;
    size: number;
}
/** A `CompileCache` with insertion-order (LRU) eviction and hit/miss counters. */
export interface BoundedCompileCache extends CompileCache {
    readonly stats: CompileCacheStats;
    clear(): void;
}
/**
 * A bounded, in-process compile cache. `maxEntries` (default 1024) caps memory:
 * on overflow the least-recently-used entry is evicted (a hit refreshes
 * recency). Pass one to `compile(src, { cache })` from a long-lived process that
 * recompiles recurring programs — a recipe solver, a dev server, a batch job.
 * A fresh process starts empty; the cache never persists to disk.
 */
export declare function createCompileCache(maxEntries?: number): BoundedCompileCache;
//# sourceMappingURL=cache.d.ts.map