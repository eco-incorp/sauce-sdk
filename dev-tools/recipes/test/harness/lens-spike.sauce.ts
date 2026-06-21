import { IUniswapV3PoolFull } from "./recipes/ecoswap/IUniswapV3PoolFull.json";

// De-risk spike for the EcoSwap on-chain prepare lens.
//
// A read-only main() that, given a V3 pool address and two tick indices (one
// POSITIVE, one NEGATIVE — the negative supplied as its absolute value), reads
// the pool's live slot0() and the per-tick liquidityNet at BOTH ticks, then
// returns abi.encode of the four raw words. The whole point is to validate the
// negative-int24 staticcall arg path:
//
//   negTick = Math.neg(negTickAbs)   // full-256-bit two's complement (NEG=0x29)
//   ticks(negTick)                   // abi.encode lays it as a 32-byte word,
//                                    // == int24 sign-extended-to-256 = correct
//
// Signed return words (tick int24, liquidityNet int128) are ZERO-extended by the
// engine's contract-return decode, so the low N bytes are the correct two's
// complement; the caller reinterprets them off-chain via BigInt.asIntN.
//
// Multi-return contract calls MUST be indexed INLINE (a stored tuple is not
// re-indexable), so slot0()/ticks() are called once per field read.
function main(pool: Address, posTick: Uint256, negTickAbs: Uint256): bytes {
  const v3 = IUniswapV3PoolFull.at(pool);

  // Live price + current tick (int24, zero-extended on return).
  const sqrtPriceX96: Uint256 = v3.slot0()[0];
  const currentTick: Uint256 = v3.slot0()[1];

  // liquidityNet at the POSITIVE tick (positive int24 arg — trivial).
  const liqNetPos: Uint256 = v3.ticks(posTick)[1];

  // liquidityNet at the NEGATIVE tick. Form the negative int24 at runtime via
  // Math.neg (SUB is checked → 0-x panics; Math.neg wraps to the two's
  // complement). This is the path the real lens uses for negative ticks.
  const negTick: Uint256 = Math.neg(negTickAbs);
  const liqNetNeg: Uint256 = v3.ticks(negTick)[1];

  return abi.encode(sqrtPriceX96, currentTick, liqNetPos, liqNetNeg);
}
