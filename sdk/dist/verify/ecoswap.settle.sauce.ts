import { IERC20 } from "./artifacts/IERC20.json";

// ecoswap.settle.sauce.ts — the SETTLE half of the split-cook composition (see the
// `@eco-incorp/sauce-recipes` package's ecoswap.sauce.ts SETTLE_SPLIT define). Lives here (under
// the SDK's verify surface, not a recipes tree) because a settler is a VERIFICATION primitive, not
// a recipe — this is the ONE source of truth: compiled from source by this package's
// `compileSettleProgram` (sdk/src/verify/compile.ts), and `@eco-incorp/sauce-recipes`'s
// `compileEcoSwapSettle` delegates to that same function rather than keeping a second copy.
//
// THE ARCHITECTURE (settled by the maintainer): a V12Pot.cook executes ONLY ingredients[0] and
// silently ignores the rest, so a single cook cannot run "swap then settle" — the composition is
// TWO TOP-LEVEL cook() calls joined by an owner-authorised multicall in ONE transaction:
//   multicall → [ Pot.cook([swapProgram]) , Pot.cook([settleProgram]) ]
// The multicall contract MUST be this Pot's `owner` (V12Pot.cook is
// `msg.sender == owner || msg.sender == address(this)`-gated — there is no third path) and MUST
// propagate a reverting call's revert data rather than swallow it (a non-reverting/tryAggregate
// dispatch turns a settle failure into "the swap landed, the recipient got nothing").
// SECURITY: the multicall must NEVER be a permissionless batcher. Multicall3's `aggregate3` CALLs
// from its own address, so if it owned a Pot, any address could call
// `aggregate3([{target: pot, callData: cook([drainProgram])}])` and drain it — owning the batcher
// IS owning the Pot. The operator's batcher must be owner-controlled (see OwnerMulticall.sol,
// this repo's test-only reference fixture for the shape a real deployment needs).
//
// THE SHAPE: `main(tokens, minOut, recipient)` sweeps the Pot's CURRENT balance of EVERY token in
// `tokens` to `recipient` — a full-balance sweep is the EXPLICIT INTENT (not a hazard to guard
// against): after this cook lands, the Pot holds none of the listed tokens. `tokens[0]` is the
// FLOOR TOKEN by POSITION (not a separately-named arg) — chosen over a named field because the
// decoded shape this way is exactly `(tokens[], minOut, recipient)`, the same three values the
// caller compiled it with, with no fourth field that could itself drift out of sync with which
// array slot it names. `minOut` is enforced against tokens[0]'s balance BEFORE any transfer runs,
// so an unmeetable floor reverts the WHOLE settle cook (and, because both cooks share one
// transaction via the multicall, the whole composed transaction) before anything moves.
//
// KNOWN PROPERTY, DOCUMENTED AND ACCEPTED — NOT DEFENDED AGAINST: the floor and the sweep both
// read the Pot's CURRENT balance, not a delta against a pre-swap baseline. A pre-existing or
// donated balance of tokens[0] in the Pot therefore counts toward minOut and rides to the
// recipient along with the swap's own output. This is a consequence of the sweep model the
// maintainer chose (the Pot ending clean is the point), not an oversight — do not add baseline/
// delta machinery to defend against it.
//
// A given compile's `tokens`/`minOut`/`recipient` are ordinary compile-time args (exactly like
// any other recipe's) — there is no cross-cook handoff of any kind (an earlier design used a
// tagged EIP-1153 transient-storage handoff between the two cooks; the sweep model made it
// unnecessary — a settle program simply carries its own destination and floor, and reads only the
// Pot's live balances). An orphan settle (run with no paired swap, e.g. against an empty Pot)
// simply sweeps whatever balance happens to be there (0, ordinarily) — there is nothing to
// "orphan" against, since the program's target and floor are self-contained.
//
// THE DECODER (see ecoswap/index.ts's decodeSettleProgram/validateSettleProgram): this template
// is helper-free (no jump-table offsets, no branches beyond the floor check) and always compiles
// to the SAME shape — N minimal-length pushes for `tokens` (reversed), a TUPLE-build opcode
// carrying the array's arity as its one operand, then one minimal-length push each for `minOut`
// and `recipient` — followed by a BODY that is a byte-for-byte CONSTANT regardless of the array's
// length or any of the three values (confirmed by direct compile: identical body hash for 1, 2, 3
// and 5-element token arrays with varying minOut/recipient). decodeSettleProgram parses that
// prologue back into (tokens, minOut, recipient); validateSettleProgram additionally hashes the
// trailing body against the hash of a genuine compile, so a settle-shaped program that decodes
// cleanly (parses as that exact prologue shape) but carries different/extra behavior after it
// (e.g. sweeping to a hardcoded address instead of the decoded `recipient`) is rejected on the
// body-hash mismatch, not on the decode step.
function main(tokens: Address[], minOut: Uint256, recipient: Address): Uint256 {
  const floorToken = IERC20.at(tokens[0]);
  const floorBal: Uint256 = floorToken.balanceOf(address.self);
  if (minOut > 0) {
    if (floorBal < minOut) {
      throw "ecoswap: amountOut below minOut";
    }
  }
  for (let i = 0; i < tokens.length; i = i + 1) {
    const t = IERC20.at(tokens[i]);
    const bal: Uint256 = t.balanceOf(address.self);
    if (bal > 0) {
      t.transfer(recipient, bal);
    }
  }
  return floorBal;
}
