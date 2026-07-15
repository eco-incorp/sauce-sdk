import type { Expression } from 'acorn';
import type { SaucerLike } from './saucer/index.js';
import type { VariableKind } from './context.js';
type PropertyCompile = (saucer: SaucerLike) => SaucerLike;
type MethodCompile = (saucer: SaucerLike, args: Expression[], process: (e: Expression) => SaucerLike) => SaucerLike;
export interface GlobalDef {
    kind: VariableKind;
    compile: PropertyCompile | MethodCompile;
}
export declare const GLOBALS: Record<string, Record<string, GlobalDef>>;
export declare const GLOBAL_FUNCTIONS: Record<string, GlobalDef>;
export declare const RESERVED_NAMES: Set<string>;
export {};
//# sourceMappingURL=globals.d.ts.map