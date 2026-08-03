// svm-token-settle.sauce.ts — a STANDALONE, reusable SVM Sauce program: enforce a minimum-output
// floor on an escrow SPL token account's CURRENT balance, then sweep that whole balance to one
// beneficiary. This is the SVM twin of `token-sweep.sauce.ts` — same contract (a floor, a
// destination, a full sweep), same "compiled by the ordinary compiler" delivery — adapted to SVM's
// account model, where there is no Pot and no `balanceOf` call: the balance lives IN the escrow
// account's own data, and moving it is an SPL Token `Transfer` CPI rather than an ERC20 call.
//
// It is deliberately NOT tied to any recipe, protocol, or product. Nothing below knows what
// produced the escrow's balance — a swap, a bridge, an airdrop, or nothing at all. Its contract is
// exactly "this escrow, this floor, this beneficiary, this token program", so any caller that needs
// an SVM escrow emptied to a destination can compile and run it. Keep it that way: no
// caller-specific names, in the code OR in the revert string (the string is inside the compiled
// body, and this program carries no golden-hash pin to rotate, but the same discipline applies —
// see the partner-verify note below).
//
// COMPOSING IT AFTER ANOTHER PROGRAM: `execute_from_account` lets multiple staged programs co-execute
// atomically as separate instructions in ONE transaction — there is no analogue of a Pot's
// single-ingredient `cook()` restriction to work around here. A producer program (e.g. a swap that
// lands its output in this escrow) and this settle program are simply two `execute_from_account`
// instructions in the same transaction; ordinary transaction atomicity means either both land or
// neither does. NOTHING IN THE SDK ENFORCES THAT A PRODUCER RAN FIRST — composing them is the
// caller's responsibility (this is the SVM-recipes-side follow-up to this file, not something this
// template can see or check). Run alone against an escrow holding nothing, it sweeps 0 (ordinarily)
// and there is nothing to "orphan" against, since its target and floor are self-contained.
//
// COMPILED BY THE ORDINARY COMPILER — see `sdk/src/programs/index.ts` for the exact snippet and
// options (`target: 'svm', staged: true, treeshake: true, args: [...]`). This file is the ONE
// source of truth for the program text; consumers compile it rather than keeping a second copy.
//
// THE SHAPE: `main(cfg, tokenProgram)` reads the escrow's LIVE SPL token `amount` field, reverts if
// it is below the `minOut` carried in `cfg`, and otherwise transfers the ENTIRE balance to the
// beneficiary — a full-balance sweep is the EXPLICIT INTENT, exactly like the EVM sibling: after this
// executes, the escrow holds none of its token. Every other identity — which escrow, which
// beneficiary, which owner authorizes the transfer, which SPL token program to CPI into — is bound
// at EXECUTION time via the compiled AccountPlan's refs (`escrow`, `beneficiary`, `owner`), not baked
// into the program: ONE canonical compiled blob serves every mint, every escrow/beneficiary pair, and
// every floor. `tokenProgram` rides as arg 1 (not a hardcoded literal) for the same reason: it lets
// one blob serve both the classic SPL Token program and Token-2022 (or any future token program with
// the same Transfer layout) — see the header note on binding discipline below.
//
// ⚠ CONSTRUCTION GOTCHA, LOAD-BEARING: `accountData("tokenProgram", 0, 0)` below is a zero-length
// read of the `tokenProgram` account. It looks like dead code — nothing reads its bytes — but it is
// not: the engine resolves a `contract.call` CPI target by scanning the instruction's ATTACHED
// accounts for the target's pubkey, so the token program must occupy an AccountPlan slot even though
// the program never inspects its data. Omit this line and the compile still succeeds, but the
// Transfer CPI fails pre-flight ("target program not attached") the moment it actually runs.
//
// ⚠ THE `tokenProgram` ARG AND THE `tokenProgram` ACCOUNT REF ARE TWO INDEPENDENT BINDINGS a caller
// makes at execution time — nothing here enforces they name the same program. Passing the Token-2022
// program id as the arg while resolving the `tokenProgram` ref to classic Tokenkeg (or vice versa) is
// a loud, atomic pre-flight CPI failure that moves nothing; it is not a silent misrouting hazard, but
// callers should still bind both from the same source value rather than two independently-chosen
// ones.
//
// KNOWN PROPERTY, DOCUMENTED AND ACCEPTED — NOT DEFENDED AGAINST: the floor and the sweep both read
// the escrow's CURRENT balance, not a delta against some baseline. A pre-existing or donated balance
// in the escrow therefore counts toward `minOut` and rides to the beneficiary along with whatever a
// producer program actually deposited. This is the same accepted property `token-sweep.sauce.ts`
// documents for its Pot balance — but it is materially EASIER to trigger here: an SPL associated
// token account is a public address anyone can permissionlessly transfer into, with no owner
// authorization required to donate to it (unlike a contract call). Do not add baseline/delta
// machinery to defend against it; the maintainer's chosen model is the escrow ending clean, exactly
// like the EVM sibling's Pot.
//
// u64-ONLY ARITHMETIC: `le8` below is a 64-bit byteswap. It is sound here because both the escrow's
// SPL `amount` field and the cfg's `minOut` word are structurally 8 bytes (u64) — `accountUint`'s
// width argument and the cfg slice are both fixed at 8 — but nothing HERE re-checks that; the
// decoder in `sdk/src/programs/index.ts` (`encodeSvmSettleCfg`) is the layer that rejects an
// out-of-u64-range `minOut` before it could ever reach this arithmetic.
//
// THE FLOOR COMPARISON IS UNSIGNED, SO THE OUTER "is the floor enabled" GUARD `token-sweep.sauce.ts`
// carries (`if (minOut > 0) { ... }`) IS DELIBERATELY OMITTED HERE: `minOut == 0` can never make
// `bal < minOut` true, so zero-as-disabled falls out of the arithmetic on its own, and adding the
// guard back would be pure wasted CU with no behavioral difference.
//
// PARTNER VERIFY: there is NO golden hash and NO reproducible-build attestation for this file (unlike
// the deployed SVM native-merge program, which is a different kind of artifact — a Rust program with
// its own immutability/build-reproducibility discipline). This is an ordinary SauceScript template;
// verify it exactly like `token-sweep.sauce.ts` — recompile `svmTokenSettleSource()` yourself with the
// same options and byte-compare against what you were handed.
//
// THE DECODER: unlike the EVM sibling, there is no `decodeSvmSettleProgram` analogue and there never
// will be — in staged SVM mode, compile-time `args` are NOT baked into the compiled blob (restaging to
// change one value is exactly what the buffer split exists to avoid), so there is no prologue to parse
// bytecode back out of. The only decodable settle parameter (`minOut`) lives in the per-execution
// PAYLOAD, not the program — see `sdk/src/programs/index.ts`'s `encodeSvmSettleCfg`/`decodeSvmSettleCfg`
// for that half of the contract.

/** 64-bit byte swap: the LE image of a u64 amount, MSTORE'd big-endian by abi.encode. */
function le8(x) {
  return ((x & 255) << 56) | ((x & 65280) << 40) | ((x & 16711680) << 24) | ((x & 4278190080) << 8)
    | ((x >> 8) & 4278190080) | ((x >> 24) & 16711680) | ((x >> 40) & 65280) | (x >> 56);
}

function main(cfg, tokenProgram) {
  // Load-bearing: interns the token program account so the Transfer CPI below can resolve its
  // target from the instruction's attached accounts. See the header note above.
  accountData("tokenProgram", 0, 0);

  const minOut = uint(cfg.slice(0, 8));
  const bal = accountUint("escrow", 64, 8);

  if (bal < minOut) {
    throw "settle: balance below minOut";
  }

  if (bal > 0) {
    const pfx = Uint8Array.from([3]); // SPL Token Transfer discriminator
    const amt = abi.encode(le8(bal));
    const data = pfx.concat(amt.slice(24, 32));
    contract.call(tokenProgram, data, [
      { ref: "escrow", writable: true },
      { ref: "beneficiary", writable: true },
      { ref: "owner", signer: true }
    ]);
  }

  return bal;
}
