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
// The SVM analogue is `extractSvmSettleFromIntent` in `@eco-incorp/sauce-sdk/svm/verify`: an SVM intent
// wraps its settle CPI one layer deeper (the Eco Portal `CalldataWithAccounts` Borsh envelope), so that
// module decodes the envelope itself before handing the halves to `decodeSvmSettleExecution` /
// `verifySvmSettleExecution` — same "one call from intent to params" story, on the SVM side.
//
// ONE DELIBERATE ASYMMETRY vs the SVM twin: the SVM extractor returns a `genuine` verdict because a
// staged settle can ONLY be identified by recompiling it, so that module is node-side and verifies by
// default. This EVM path stays viem-only/browser-safe and therefore stops at a STRICT prologue decode:
// it cannot return a non-settle program (the prologue grammar is a real signature), and it reports
// `bodyHash` — but proving the trailing BODY is the genuine settle logic (not just prologue-shaped) is
// the caller's step: compile `@eco-incorp/sauce-sdk/recipes`'s settle source and compare `bodyHash`
// (the body is byte-identical across all params). That is the established EVM `/verify` contract; these
// helpers inherit it, they do not weaken it.
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { decodeSettleProgram, type DecodedSettleProgram } from "./decode.js";

/** `Pot.cook` / `SauceRouter.cook` — identical input signature on both (`sdk/src/artifacts/*.json`), so
 *  one fragment decodes either. Only the input array matters for decoding a call. */
const COOK_ABI = parseAbi(["function cook(bytes[] ingredients) payable returns (bytes)"]);

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
export function decodeSettleCall(callData: Hex): DecodedSettleCall | null {
  let ingredients: readonly Hex[];
  try {
    const decoded = decodeFunctionData({ abi: COOK_ABI, data: callData });
    if (decoded.functionName !== "cook") return null;
    ingredients = decoded.args[0] as readonly Hex[];
  } catch {
    return null; // not a cook call (wrong selector / malformed calldata)
  }

  for (let i = 0; i < ingredients.length; i++) {
    try {
      return { ...decodeSettleProgram(ingredients[i]!), ingredientIndex: i };
    } catch {
      // not a settle-shaped ingredient (e.g. the swap half) — keep looking
    }
  }
  return null;
}

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
export function extractEvmSettleFromCalls(calls: readonly IntentCallLike[]): ExtractedEvmSettle | null {
  for (let i = 0; i < calls.length; i++) {
    const decoded = decodeSettleCall(calls[i]!.data);
    if (decoded) return { ...decoded, callIndex: i, target: calls[i]!.target };
  }
  return null;
}

/** An intent, duck-typed to just the calls this reads — so it accepts eco-solver's `Intent` (and its
 *  persisted schema) without importing either. */
export interface IntentLike {
  route: { calls: readonly IntentCallLike[] };
}

/**
 * Extracts the EVM settle params `(tokens, minOut, recipient)` from an intent object — the thin
 * intent-level wrapper over `extractEvmSettleFromCalls`. Duck-typed on `{ route: { calls } }`, so it takes
 * an eco-solver `Intent` (runtime or persisted) as-is. `null` if the intent carries no settle cook.
 */
export function extractEvmSettleFromIntent(intent: IntentLike): ExtractedEvmSettle | null {
  return extractEvmSettleFromCalls(intent.route.calls);
}
