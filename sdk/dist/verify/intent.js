// @eco-incorp/sauce-sdk/verify — extract settle params from the CALLS an intent carries.
//
// `decodeSettleProgram` (decode.ts) turns a raw settle PROGRAM's bytes back into
// `(tokens, minOut, recipient)`. But a producer (eco-solver, the recipes API) never hands you the bare
// program — on EVM it hands you an intent whose `route.calls[]` batch ends with a `Pot.cook(bytes[])`
// call, and the settle program is ONE ingredient inside that call's ABI-encoded argument array. These
// helpers close that last gap: unwrap the `cook(bytes[])` calldata and hand the settle ingredient to the
// strict `decodeSettleProgram`, so a caller goes from an intent object to `(tokens, minOut, recipient)`
// in one step.
//
// Same dependency contract as decode.ts: `viem` ONLY (no compiler, no node, no artifact resolution), so
// this stays safe to import in a browser or edge runtime. And the same trust contract: the settle
// program is decoded from its own bytes with the strict decoder — a cook call whose ingredient is not a
// valid settle program yields `null`, never a guess.
//
// SVM has no analogue here: an SVM intent wraps its settle CPI in eco-solver's Portal
// `CalldataWithAccounts` (a Borsh envelope that is the SOLVER's encoding, not Sauce's), and the compiled
// bytecode lives out-of-band in `fulfillmentMetadata.svm.sauceStage`. The caller decodes that envelope
// itself and passes the `{ instructionData, accounts }` (and staged bytecode) to
// `@eco-incorp/sauce-sdk/svm/verify`'s `decodeSvmSettleExecution` / `verifySvmSettleExecution`.
import { decodeFunctionData, parseAbi } from "viem";
import { decodeSettleProgram } from "./decode.js";
/** `Pot.cook` / `SauceRouter.cook` — identical input signature on both (`sdk/src/artifacts/*.json`), so
 *  one fragment decodes either. Only the input array matters for decoding a call. */
const COOK_ABI = parseAbi(["function cook(bytes[] ingredients) payable returns (bytes)"]);
/**
 * Decodes one `Pot.cook(bytes[])` / `SauceRouter.cook(bytes[])` call and returns the settle program it
 * carries — or `null` if the calldata is not a `cook` call, or no ingredient is a valid settle program.
 * Never throws for a non-cook / non-settle input: a mismatched selector, malformed ABI, or a cook whose
 * ingredients are all non-settle all return `null`. The settle detection IS the strict
 * `decodeSettleProgram` (every push minimal-length, addresses ≤ 20 bytes, recipient nonzero), so an
 * accepted ingredient is the unique byte encoding of the `(tokens, minOut, recipient)` reported.
 */
export function decodeSettleCall(callData) {
    let ingredients;
    try {
        const decoded = decodeFunctionData({ abi: COOK_ABI, data: callData });
        if (decoded.functionName !== "cook")
            return null;
        ingredients = decoded.args[0];
    }
    catch {
        return null; // not a cook call (wrong selector / malformed calldata)
    }
    for (let i = 0; i < ingredients.length; i++) {
        try {
            return { ...decodeSettleProgram(ingredients[i]), ingredientIndex: i };
        }
        catch {
            // not a settle-shaped ingredient (e.g. the swap half) — keep looking
        }
    }
    return null;
}
/**
 * Scans an intent's `route.calls[]` and returns the settle params from the first `cook` call carrying a
 * settle program — the EVM settle in a batch is a `Pot.cook(settleBytecodes)` alongside a
 * `Pot.cook(swapBytecodes)`, so this finds it by CONTENT (which cook decodes as settle), not by position.
 * `null` if no call carries a settle program.
 */
export function extractEvmSettleFromCalls(calls) {
    for (let i = 0; i < calls.length; i++) {
        const decoded = decodeSettleCall(calls[i].data);
        if (decoded)
            return { ...decoded, callIndex: i, target: calls[i].target };
    }
    return null;
}
/**
 * Extracts the EVM settle params `(tokens, minOut, recipient)` from an intent object — the thin
 * intent-level wrapper over `extractEvmSettleFromCalls`. Duck-typed on `{ route: { calls } }`, so it takes
 * an eco-solver `Intent` (runtime or persisted) as-is. `null` if the intent carries no settle cook.
 */
export function extractEvmSettleFromIntent(intent) {
    return extractEvmSettleFromCalls(intent.route.calls);
}
//# sourceMappingURL=intent.js.map