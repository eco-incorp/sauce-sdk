import { IUniswapV3Factory } from "./IUniswapV3Factory.json";
import { IUniswapV2Factory } from "./IUniswapV2Factory.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";
import { IStateViewFull } from "./IStateViewFull.json";

// EcoSwap on-chain PREPARE LENS (v1, THIN READ-LENS).
//
// A single read-only main() invoked via ONE eth_call cook(). It discovers every
// direct V2/V3/V4 pool for (tokenIn, tokenOut) across the configured factories,
// reads each pool's LIVE state (slot0/getReserves/StateView), and reads a fixed
// window of ticks() / getTickLiquidity in the swap direction. It returns ONLY
// RAW reads — the off-chain TS (prepare.ts) builds brackets, sorts, water-fills,
// trims and composes routes. NO bracket math here.
//
// COMPILER CONSTRAINTS that shape this code:
//  (1) Only main() has the imported contracts in scope — helper functions get a
//      fresh compiler context (no contracts / baseDirs), so every contract
//      STATICCALL must be INLINED in main(). Only pure-math helpers are split out.
//  (2) The VM cannot build a runtime array of SCALAR values (a scalar var read is
//      READ_VALUE, which the array encoder rejects). So output is accumulated as a
//      raw BYTES blob: each row = abi.encode(word, word, ...) (32 bytes/word),
//      concatenated. The blob is an integer number of 32-byte words off-chain.
//
// ── Compiler-arg layout (all bigint scalars / scalar-tuples) ─────────────────
//   tokenIn, tokenOut : Address
//   zeroForOne        : Uint256 (1 if tokenIn < tokenOut)
//   tickStepsAbs      : Uint256 (window size; V3_TICK_STEPS)
//   v3Factories[i]    = [factoryAddr]                       (Uniswap-V3-style getPool)
//   v3FeeTiers[j]     = [fee]
//   v2Factories[i]    = [factoryAddr]                       (Uniswap-V2-style getPair)
//   v4Factories[i]    = [poolManager, stateView]            (V4 singleton + lens)
//   v4Specs[j]        = [fee, tickSpacing]
//   v4PoolIds[i*J+j]  = [poolId]                            (precomputed keccak per factory×spec)
//
// V4 poolId is passed precomputed (off-chain discovery already hashes the PoolKey).
// It is a bytes32 INPUT (encoded as a 32-byte word). bytes32 is never an OUTPUT.
//
// ── Return shape (documented; off-chain abi.decode against this EXACTLY) ──────
//   abi.encode(poolBlob: bytes, tickBlob: bytes)
//
//   poolBlob = concatenated 32-byte words, POOL_STRIDE = 11 words per pool:
//     [0] poolType (0=V2,1=V3,2=V4)  [1] address  [2] fee  [3] tickSpacing
//     [4] hooks(0)  [5] sqrtPriceX96 (0 for V2)  [6] liquidity (synthetic √(rIn·rOut) for V2)
//     [7] tickRaw (int24 ZERO-EXTENDED → asIntN(24))  [8] inIsToken0 (V2 only)
//     [9] stateView (V4 only)  [10] poolId (V4 only)
//   poolBlob.length / 32 / 11 = number of pools (decode words via DataView/BigInt).
//
//   tickBlob = concatenated 32-byte words, TICK_STRIDE = 3 words per tick row
//   ((tickStepsAbs+1) rows per V3/V4 pool, in poolBlob order; V2 emits none):
//     [0] poolIdx  [1] tickIndexRaw (int24 ZERO-EXT → asIntN(24))
//     [2] liquidityNetRaw (int128 ZERO-EXT → asIntN(128); 0 if uninitialized)

function main(
  tokenIn: Address,
  tokenOut: Address,
  zeroForOne: Uint256,
  tickStepsAbs: Uint256,
  v3Factories: Tuple,
  v3FeeTiers: Tuple,
  v2Factories: Tuple,
  v4Factories: Tuple,
  v4Specs: Tuple,
  v4PoolIds: Tuple
): bytes {
  // Empty BYTES accumulators (slice(0,0) of any encode → zero-length dynamic bytes).
  let poolBlob: bytes = abi.encode(tokenIn).slice(0, 0);
  let tickBlob: bytes = abi.encode(tokenIn).slice(0, 0);
  let poolCount: Uint256 = 0;

  const SIGN_BIT: Uint256 = 2 ** 23; // int24 sign bit
  const MOD24: Uint256 = 2 ** 24;
  const count: Uint256 = tickStepsAbs + 1;

  // ── Direct V3 discovery (getPool per factory × fee tier) ──
  for (let fi = 0; fi < v3Factories.length; fi = fi + 1) {
    const vf: Tuple = v3Factories[fi];
    const factory: Address = vf[0];
    for (let ti = 0; ti < v3FeeTiers.length; ti = ti + 1) {
      const ft: Tuple = v3FeeTiers[ti];
      const fee: Uint256 = ft[0];

      const poolAddr: Address = IUniswapV3Factory.at(factory).getPool(tokenIn, tokenOut, fee);
      if (poolAddr !== 0) {
        const sqrtP: Uint256 = IUniswapV3PoolFull.at(poolAddr).slot0()[0];
        const liq: Uint256 = IUniswapV3PoolFull.at(poolAddr).liquidity();
        if (sqrtP > 0) {
          if (liq > 0) {
            const tickRaw: Uint256 = IUniswapV3PoolFull.at(poolAddr).slot0()[1];
            const tsRaw: Uint256 = IUniswapV3PoolFull.at(poolAddr).tickSpacing();
            const poolIdx: Uint256 = poolCount;

            poolBlob = poolBlob.concat(
              abi.encode(1, poolAddr, fee, tsRaw, 0, sqrtP, liq, tickRaw, 0, 0, 0)
            );
            poolCount = poolCount + 1;

            // First boundary (curNeg,curMag) in the swap direction.
            const tickNeg: Uint256 = tickRaw >= SIGN_BIT ? 1 : 0;
            const tickAbs: Uint256 = tickNeg === 1 ? MOD24 - tickRaw : tickRaw;
            let baseMag: Uint256 = 0;
            let baseNeg: Uint256 = 0;
            if (tickNeg === 1) {
              const q: Uint256 = tickAbs / tsRaw;
              const rem: Uint256 = tickAbs - q * tsRaw;
              const ceilQ: Uint256 = rem === 0 ? q : q + 1;
              baseMag = ceilQ * tsRaw;
              baseNeg = baseMag === 0 ? 0 : 1;
            } else {
              baseMag = (tickAbs / tsRaw) * tsRaw;
              baseNeg = 0;
            }
            let curMag: Uint256 = baseMag;
            let curNeg: Uint256 = baseNeg;
            // oneForZero starts the walk one tickSpacing ABOVE base.
            if (zeroForOne === 0) {
              if (curNeg === 1) {
                // negative base + ts: magnitude shrinks (toward 0 / positive)
                if (curMag >= tsRaw) {
                  curMag = curMag - tsRaw;
                  curNeg = curMag === 0 ? 0 : 1;
                } else {
                  curMag = tsRaw - curMag;
                  curNeg = 0;
                }
              } else {
                curMag = curMag + tsRaw;
              }
            }

            for (let k = 0; k < count; k = k + 1) {
              const argWord: Uint256 = curNeg === 1 ? Math.neg(curMag) : curMag;
              const netRaw: Uint256 = IUniswapV3PoolFull.at(poolAddr).ticks(argWord)[1];
              tickBlob = tickBlob.concat(abi.encode(poolIdx, argWord, netRaw));
              if (zeroForOne === 1) {
                // step DOWN by tickSpacing: cur - ts
                if (curNeg === 1) {
                  curMag = curMag + tsRaw; // more negative
                } else {
                  if (curMag >= tsRaw) {
                    curMag = curMag - tsRaw;
                  } else {
                    curMag = tsRaw - curMag;
                    curNeg = 1;
                  }
                }
              } else {
                // step UP by tickSpacing: cur + ts
                if (curNeg === 1) {
                  if (curMag >= tsRaw) {
                    curMag = curMag - tsRaw;
                    curNeg = curMag === 0 ? 0 : 1;
                  } else {
                    curMag = tsRaw - curMag;
                    curNeg = 0;
                  }
                } else {
                  curMag = curMag + tsRaw;
                }
              }
            }
          }
        }
      }
    }
  }

  // ── Direct V2 discovery (getPair per factory) ──
  for (let vi = 0; vi < v2Factories.length; vi = vi + 1) {
    const vf2: Tuple = v2Factories[vi];
    const factory2: Address = vf2[0];

    const pairAddr: Address = IUniswapV2Factory.at(factory2).getPair(tokenIn, tokenOut);
    if (pairAddr !== 0) {
      const r0: Uint256 = IUniswapV2Pair.at(pairAddr).getReserves()[0];
      const r1: Uint256 = IUniswapV2Pair.at(pairAddr).getReserves()[1];
      if (r0 > 0) {
        if (r1 > 0) {
          const t0: Address = IUniswapV2Pair.at(pairAddr).token0();
          const inIsT0: Uint256 = t0 === tokenIn ? 1 : 0;
          const reserveIn: Uint256 = inIsT0 === 1 ? r0 : r1;
          const reserveOut: Uint256 = inIsT0 === 1 ? r1 : r0;
          const synthL: Uint256 = Math.sqrt(reserveIn * reserveOut);
          // Synthetic out/in sqrtPrice (Q96), matching the on-chain solver's live
          // V2 anchor curSqrt = sqrt(reserveOut * 2^192 / reserveIn).
          const Q192: Uint256 = 2 ** 192;
          const synthSqrt: Uint256 = Math.sqrt(Math.mulDiv(reserveOut, Q192, reserveIn));

          poolBlob = poolBlob.concat(
            abi.encode(0, pairAddr, 3000, 0, 0, synthSqrt, synthL, 0, inIsT0, 0, 0)
          );
          poolCount = poolCount + 1;
          // V2 emits no tick rows (off-chain reads reserves directly).
        }
      }
    }
  }

  // ── Direct V4 discovery (StateView per factory × spec, keyed by precomputed poolId) ──
  for (let qi = 0; qi < v4Factories.length; qi = qi + 1) {
    const vf4: Tuple = v4Factories[qi];
    const poolManager: Address = vf4[0];
    const stateView: Address = vf4[1];
    for (let si = 0; si < v4Specs.length; si = si + 1) {
      const spec: Tuple = v4Specs[si];
      const v4fee: Uint256 = spec[0];
      const v4ts: Uint256 = spec[1];
      const idRow: Tuple = v4PoolIds[qi * v4Specs.length + si];
      const poolId: Uint256 = idRow[0];

      const sqrtP4: Uint256 = IStateViewFull.at(stateView).getSlot0(poolId)[0];
      if (sqrtP4 > 0) {
        const liq4: Uint256 = IStateViewFull.at(stateView).getLiquidity(poolId);
        if (liq4 > 0) {
          const tick4: Uint256 = IStateViewFull.at(stateView).getSlot0(poolId)[1];
          const poolIdx4: Uint256 = poolCount;

          poolBlob = poolBlob.concat(
            abi.encode(2, poolManager, v4fee, v4ts, 0, sqrtP4, liq4, tick4, 0, stateView, poolId)
          );
          poolCount = poolCount + 1;

          const tickNeg4: Uint256 = tick4 >= SIGN_BIT ? 1 : 0;
          const tickAbs4: Uint256 = tickNeg4 === 1 ? MOD24 - tick4 : tick4;
          let baseMag4: Uint256 = 0;
          let baseNeg4: Uint256 = 0;
          if (tickNeg4 === 1) {
            const q4: Uint256 = tickAbs4 / v4ts;
            const rem4: Uint256 = tickAbs4 - q4 * v4ts;
            const ceilQ4: Uint256 = rem4 === 0 ? q4 : q4 + 1;
            baseMag4 = ceilQ4 * v4ts;
            baseNeg4 = baseMag4 === 0 ? 0 : 1;
          } else {
            baseMag4 = (tickAbs4 / v4ts) * v4ts;
            baseNeg4 = 0;
          }
          let curMag4: Uint256 = baseMag4;
          let curNeg4: Uint256 = baseNeg4;
          if (zeroForOne === 0) {
            if (curNeg4 === 1) {
              if (curMag4 >= v4ts) {
                curMag4 = curMag4 - v4ts;
                curNeg4 = curMag4 === 0 ? 0 : 1;
              } else {
                curMag4 = v4ts - curMag4;
                curNeg4 = 0;
              }
            } else {
              curMag4 = curMag4 + v4ts;
            }
          }

          for (let k4 = 0; k4 < count; k4 = k4 + 1) {
            const argWord4: Uint256 = curNeg4 === 1 ? Math.neg(curMag4) : curMag4;
            const netRaw4: Uint256 = IStateViewFull.at(stateView).getTickLiquidity(poolId, argWord4)[1];
            tickBlob = tickBlob.concat(abi.encode(poolIdx4, argWord4, netRaw4));
            if (zeroForOne === 1) {
              if (curNeg4 === 1) {
                curMag4 = curMag4 + v4ts;
              } else {
                if (curMag4 >= v4ts) {
                  curMag4 = curMag4 - v4ts;
                } else {
                  curMag4 = v4ts - curMag4;
                  curNeg4 = 1;
                }
              }
            } else {
              if (curNeg4 === 1) {
                if (curMag4 >= v4ts) {
                  curMag4 = curMag4 - v4ts;
                  curNeg4 = curMag4 === 0 ? 0 : 1;
                } else {
                  curMag4 = v4ts - curMag4;
                  curNeg4 = 0;
                }
              } else {
                curMag4 = curMag4 + v4ts;
              }
            }
          }
        }
      }
    }
  }

  return abi.encode(poolBlob, tickBlob);
}
