import { type Hex } from "viem";
import { type DecodedSettleProgram } from "./decode.js";
export interface DecodedSettleCall extends DecodedSettleProgram {
    /** Index of the `cook` ingredient that decoded as a settle program (the batch may carry others). */
    ingredientIndex: number;
}
/**
 * Decodes one `Pot.cook(bytes[])` / `SauceRouter.cook(bytes[])` call and returns the settle program it
 * carries — or `null` if the calldata is not a `cook` call, or no ingredient is a valid settle program.
 * Never throws for a non-cook / non-settle input: a mismatched selector, malformed ABI, or a cook whose
 * ingredients are all non-settle all return `null`. The settle detection IS the strict
 * `decodeSettleProgram` (every push minimal-length, addresses ≤ 20 bytes, recipient nonzero), so an
 * accepted ingredient is the unique byte encoding of the `(tokens, minOut, recipient)` reported.
 */
export declare function decodeSettleCall(callData: Hex): DecodedSettleCall | null;
/** An intent call, duck-typed: only `data` (the cook calldata) is required; `target` (the Pot address)
 *  is carried through when present. Matches eco-solver's `Call` (`{ data, target, value }`). */
export interface IntentCallLike {
    data: Hex;
    target?: `0x${string}`;
}
export interface ExtractedEvmSettle extends DecodedSettleCall {
    /** Index of the `route.calls[]` entry the settle cook was found in. */
    callIndex: number;
    /** The call's `target` (the Pot / router address), when the input carried one. */
    target?: `0x${string}`;
}
/**
 * Scans an intent's `route.calls[]` and returns the settle params from the first `cook` call carrying a
 * settle program — the EVM settle in a batch is a `Pot.cook(settleBytecodes)` alongside a
 * `Pot.cook(swapBytecodes)`, so this finds it by CONTENT (which cook decodes as settle), not by position.
 * `null` if no call carries a settle program.
 */
export declare function extractEvmSettleFromCalls(calls: readonly IntentCallLike[]): ExtractedEvmSettle | null;
/** An intent, duck-typed to just the calls this reads — so it accepts eco-solver's `Intent` (and its
 *  persisted schema) without importing either. */
export interface IntentLike {
    route: {
        calls: readonly IntentCallLike[];
    };
}
/**
 * Extracts the EVM settle params `(tokens, minOut, recipient)` from an intent object — the thin
 * intent-level wrapper over `extractEvmSettleFromCalls`. Duck-typed on `{ route: { calls } }`, so it takes
 * an eco-solver `Intent` (runtime or persisted) as-is. `null` if the intent carries no settle cook.
 */
export declare function extractEvmSettleFromIntent(intent: IntentLike): ExtractedEvmSettle | null;
//# sourceMappingURL=intent.d.ts.map