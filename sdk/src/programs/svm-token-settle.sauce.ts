// svm-token-settle.sauce.ts — a STANDALONE, reusable SVM Sauce program: enforce a minimum-output
// floor on the FIRST escrow SPL token account's CURRENT balance, then sweep every listed escrow's
// whole balance to its beneficiary.
//
// This is the SVM twin of `token-sweep.sauce.ts`, statement for statement: read the floor token's
// balance, revert if it is below `minOut`, then sweep each token in turn, skipping empty ones. Only
// the VM mechanics differ — there is no Pot and no `balanceOf` call here: a balance lives IN the
// escrow account's own data, and moving it is an SPL Token `Transfer` CPI rather than an ERC20 call.
//
// GENERATED, NOT HAND-WRITTEN — by `svmTokenSettleSource(escrowCount)` in sdk/src/programs/index.ts.
// On EVM the token list is DATA, so one static program loops over it at runtime; on SVM a token
// account must be ATTACHED to the instruction and addressed by a LITERAL account index, so the
// escrow count is necessarily a compile-time property. The generator returns the EXACT text that
// gets compiled, so a partner still reads precisely what they byte-compare.
//
// It is deliberately NOT tied to any recipe, protocol, or product. Nothing below knows what produced
// the escrows' balances — a swap, a bridge, an airdrop, or nothing at all. Keep it that way: no
// caller-specific names, in the code OR in the revert string (which is identical to the EVM twin's).
//
// THE SHAPE: `main(minOut, tokenProgram)`. `minOut` is an ordinary scalar argument — the direct
// mirror of the EVM twin's `minOut` parameter — and applies to `escrow0` ONLY, exactly as the EVM
// floor applies to `tokens[0]`; every other escrow is swept unconditionally as a dust sweep. Every
// identity — which escrows, which beneficiaries, which owner authorizes, which token program to CPI
// into — binds at EXECUTION time via the AccountPlan's refs, so one compiled blob per escrowCount
// serves every mint and every escrow/beneficiary/token-program set.
//
// The refs are `(escrow_i, beneficiary_i)` PAIRS rather than one shared destination: EVM sends every
// token to a single `recipient` address, but an SPL token account holds exactly one mint, so N
// escrows of N mints need N destinations. That is the one shape difference the account model forces.
//
// ⚠ CONSTRUCTION GOTCHA, LOAD-BEARING: `accountData("tokenProgram", 0, 0)` is a zero-length read of
// the token program account. It looks like dead code — nothing reads its bytes — but the engine
// resolves a `contract.call` CPI target by scanning the instruction's ATTACHED accounts for the
// target's pubkey, so the token program must occupy an AccountPlan slot. Omit it and the compile
// still succeeds, but the Transfer CPI fails pre-flight the moment it runs.
//
// PER-ESCROW TOKEN PROGRAM, not one shared: a mint belongs to a specific token program, and N mints
// can span classic SPL Token AND Token-2022, so escrow_i is swept via its OWN `tokenProgram_i`. When
// every mint does share one program, pass the same value N times. (There is no way to read an
// account's pubkey as a value, so the target must be an argument.)
//
// ⚠ EACH `tokenProgram_i` IS TWO INDEPENDENT BINDINGS a caller makes at execution time — the scalar
// argument (the CPI target) and the account ref (so the engine can find it attached). Nothing here
// enforces they name the same program. A mismatch is a loud, atomic pre-flight CPI failure that moves
// nothing, but bind both from the same source value.
//
// KNOWN PROPERTY, DOCUMENTED AND ACCEPTED — NOT DEFENDED AGAINST: the floor and the sweeps read
// CURRENT balances, not a delta against a baseline, so a donated balance counts toward `minOut` and
// rides along. Same accepted property as the EVM twin — but materially EASIER to trigger here, since
// an associated token account is a public address anyone can permissionlessly transfer into. Do not
// add baseline/delta machinery; the chosen model is the escrows ending clean.
//
// u64-ONLY ARITHMETIC: `le8` is a 64-bit byteswap, sound because both the SPL `amount` field and the
// `minOut` argument are u64-shaped. A minOut above u64 range can never match an on-chain amount.
//
// PARTNER VERIFY: recompile `svmTokenSettleSource(n)` yourself with the options in
// sdk/src/programs/index.ts and byte-compare against what you were handed. There is no golden hash.
//
// THE DECODER: in staged mode compile-time args are NOT baked into the blob, so unlike the EVM twin
// there is no prologue to parse params back out of — `minOut` rides in the per-execution payload and
// the account identities ride in the instruction's account list, not in the program.
/** 64-bit byte swap: the LE image of a u64 amount, MSTORE'd big-endian by abi.encode. */
function le8(x) {
  return ((x & 255) << 56) | ((x & 65280) << 40) | ((x & 16711680) << 24) | ((x & 4278190080) << 8)
    | ((x >> 8) & 4278190080) | ((x >> 24) & 16711680) | ((x >> 40) & 65280) | (x >> 56);
}

function main(minOut, tokenProgram0) {
  accountData("tokenProgram0", 0, 0);

  const floorBal = accountUint("escrow0", 64, 8);
  if (minOut > 0) {
    if (floorBal < minOut) {
      throw "sweep: balance below minOut";
    }
  }

  const bal0 = accountUint("escrow0", 64, 8);
  if (bal0 > 0) {
    const pfx0 = Uint8Array.from([3]);
    const amt0 = abi.encode(le8(bal0));
    const data0 = pfx0.concat(amt0.slice(24, 32));
    contract.call(tokenProgram0, data0, [
      { ref: "escrow0", writable: true },
      { ref: "beneficiary0", writable: true },
      { ref: "owner", signer: true }
    ]);
  }

  return floorBal;
}
