// settle.sauce.ts — a STANDALONE, reusable SVM Sauce program: enforce a minimum-output
// floor on the FIRST escrow SPL token account's CURRENT balance, then sweep every listed escrow's
// whole balance to ONE recipient.
//
// This is the SVM twin of the EVM `settle.sauce.ts` (@eco-incorp/sauce-sdk/recipes), statement for
// statement: read the floor token's balance, revert if it is below `minOut`, then sweep each token
// in turn, skipping empty ones, and return the floor balance. Only the VM mechanics differ — there
// is no Pot and no `balanceOf` call: a balance lives IN the escrow account's own data, and moving it
// is an SPL Token `TransferChecked` CPI rather than an ERC20 call.
//
// GENERATED, NOT HAND-WRITTEN — by `svmSettleSource(escrowCount)` (sdk/src/svm/recipes/index.ts).
// On EVM the token list is DATA, so one static program loops over it at runtime; on SVM a token
// account must be ATTACHED to the instruction and addressed by a LITERAL account index, so the
// escrow count is a compile-time property and the sweeps are unrolled. The generator returns the
// EXACT text that gets compiled, so a partner still reads precisely what they byte-compare.
//
// It is deliberately NOT tied to any recipe, protocol, or product. Nothing below knows what produced
// the escrows' balances — a swap, a bridge, an airdrop, or nothing at all. Keep it that way: no
// caller-specific names, in the code OR in the revert string (identical to the EVM twin's).
//
// THE SHAPE: `main(minOut, splCount, tokenProgram0, tokenProgram1)`.
//   - `minOut` is an ordinary scalar arg — the direct mirror of the EVM twin's `minOut` — and applies
//     to `escrow0` ONLY, exactly as the EVM floor applies to `tokens[0]`. Every other escrow is swept
//     unconditionally (a dust sweep).
//   - `splCount` groups escrows by token program: escrow i sweeps via `tokenProgram0` when
//     `i < splCount`, else `tokenProgram1`. Classic SPL and Token-2022 in one settle; order escrows
//     classic-first. When every mint shares one program, pass `tokenProgram1 == tokenProgram0`.
//   - Every identity — which escrows, which recipient ATAs, which owner authorizes, which token
//     programs — binds at EXECUTION time via the AccountPlan's refs, so one blob per escrow count
//     serves every mint/recipient/split.
//
// ONE RECIPIENT, N DESTINATIONS: the `dest_i` refs are the ONE recipient wallet's associated token
// account per mint. An SPL token account holds a single mint, so N mints need N destination accounts
// even for a single recipient; the SDK derives them from the recipient wallet + each mint. This is
// the SPL-shaped equivalent of the EVM twin's single `recipient` address.
//
// TransferChecked (ix 12), NOT the legacy Transfer (ix 3): legacy Transfer reverts on a Token-2022
// mint with a transfer fee (e.g. PYUSD), so it cannot honour "works for SPL or Token-2022".
// TransferChecked is uniform across both programs and reads the mint's decimals to self-check — the
// reason each escrow attaches its `mint_i`, and the reason decimals are read on-chain rather than
// passed as an argument. Transfer-HOOK mints (rare; compliance/allowlist tokens) are out of scope:
// they need per-mint hook accounts a generic program cannot enumerate, and a transfer targeting one
// reverts atomically. A resolver should reject a hook-configured mint up front with a clear error.
//
// ⚠ CONSTRUCTION GOTCHA, LOAD-BEARING: the two `accountData("tokenProgram*", 0, 0)` reads are
// zero-length reads that look like dead code, but the engine resolves a `contract.call` CPI target
// by scanning the instruction's ATTACHED accounts for the target's pubkey — so each token program
// must occupy an AccountPlan slot. Omit them and the compile still succeeds, but the CPI fails
// pre-flight the moment it runs.
//
// ⚠ EACH `tokenProgram_p` IS TWO INDEPENDENT BINDINGS a caller makes at execution time — the scalar
// argument (the CPI target value) and the account ref (so the engine finds it attached). Nothing
// here enforces they name the same program; a mismatch is a loud, atomic pre-flight CPI failure that
// moves nothing. Bind both from the same source value.
//
// KNOWN PROPERTY, DOCUMENTED AND ACCEPTED — NOT DEFENDED AGAINST: the floor and the sweeps read
// CURRENT balances, not a delta against a baseline, so a donated balance counts toward `minOut` and
// rides along. Same accepted property as the EVM twin — but materially EASIER to trigger here, since
// an associated token account is a public address anyone can permissionlessly transfer into. Do not
// add baseline/delta machinery; the chosen model is the escrows ending clean.
//
// u64-ONLY ARITHMETIC: `le8` is a 64-bit byteswap, sound because both the SPL `amount` field and the
// `minOut` argument are u64-shaped.
//
// PARTNER VERIFY: recompile `svmSettleSource(n)` yourself with the options in
// sdk/src/svm/recipes/index.ts and byte-compare against what you were handed. There is no golden hash.
/** 64-bit byte swap: the LE image of a u64 amount, MSTORE'd big-endian by abi.encode. */
function le8(x) {
  return ((x & 255) << 56) | ((x & 65280) << 40) | ((x & 16711680) << 24) | ((x & 4278190080) << 8)
    | ((x >> 8) & 4278190080) | ((x >> 24) & 16711680) | ((x >> 40) & 65280) | (x >> 56);
}

function main(minOut, splCount, tokenProgram0, tokenProgram1) {
  // Load-bearing: interns both token-program accounts so the TransferChecked CPIs can resolve their
  // target from the instruction's attached accounts. See the header note above.
  accountData("tokenProgram0", 0, 0);
  accountData("tokenProgram1", 0, 0);

  const floorBal = accountUint("escrow0", 64, 8);
  if (minOut > 0) {
    if (floorBal < minOut) {
      throw "sweep: balance below minOut";
    }
  }

  // escrow 0: read balance then decimals (fixed order → deterministic AccountPlan slots), then
  // TransferChecked the whole balance to this recipient's ATA, via this escrow's token program
  // (tokenProgram0 for the first `splCount` escrows, tokenProgram1 for the rest).
  const bal0 = accountUint("escrow0", 64, 8);
  const dec0 = accountUint("mint0", 44, 1);
  if (bal0 > 0) {
    const tp0 = 0 < splCount ? tokenProgram0 : tokenProgram1;
    const tag0 = Uint8Array.from([12]);                     // TransferChecked
    const amt0 = abi.encode(le8(bal0)).slice(24, 32);     // 8-byte LE amount
    const dcb0 = abi.encode(dec0).slice(31, 32);          // 1-byte decimals
    const data0 = tag0.concat(amt0).concat(dcb0);
    contract.call(tp0, data0, [
      { ref: "escrow0", writable: true },
      { ref: "mint0" },
      { ref: "dest0", writable: true },
      { ref: "owner", signer: true }
    ]);
  }

  return floorBal;
}
