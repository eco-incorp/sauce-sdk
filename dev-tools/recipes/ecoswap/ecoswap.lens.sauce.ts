import { IUniswapV3Factory } from "./IUniswapV3Factory.json";
import { IUniswapV2Factory } from "./IUniswapV2Factory.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";
import { IStateViewFull } from "./IStateViewFull.json";

// EcoSwap on-chain PREPARE LENS (v2, LAZY / dynamic tick reading).
//
// A single read-only main() invoked via ONE eth_call cook(). It discovers every
// direct V2/V3/V4 pool for (tokenIn, tokenOut), reads each pool's LIVE state
// (slot0/getReserves/StateView), and reads ONLY the ticks the trade can actually
// cross — NOT a fixed 96-tick window. Returns ONLY RAW reads; the off-chain TS
// (prepare.ts) builds brackets, sorts, water-fills, trims and composes routes.
//
// THREE INTERNAL PASSES (all in one eth_call):
//   1. CHEAP STATE PASS — discover all pools, read slot0 + liquidity ONLY (no
//      ticks). Sum total liquidity. Apply the relative-depth filter (minRelBps
//      of total Σliquidity) to mark SURVIVORS. Track the DEEPEST survivor's
//      coords (max active L).
//   2. FLOOR PASS — lazily walk the deepest survivor in the swap direction
//      until its cumulative gross capacity covers amountIn. Record floorAdj =
//      feeAdjust(far) at the stop. floorAdj is a SAFE UPPER BOUND on every
//      pool's needed tick depth (deepest pool has the smallest eats-all
//      excursion → adding shallower pools only RAISES the cut).
//   3. BOUNDED PASS — for every SURVIVOR, lazy-walk forward until
//      (cumIn >= amountIn) OR (feeAdjust(far) <= floorAdj), then driftTicks MORE
//      forward, plus read driftTicks on the REVERSE side of spot for runtime
//      drift. Hard cap at MAX_TICKS. Emit pool row (incl scannedForward) + tick
//      rows. NON-survivors (below the relative-depth floor) are NOT emitted at
//      all — the lens is the single source of truth for survivorship, so the
//      off-chain consumer treats every returned pool row as a survivor.
//
// TICK REPRESENTATION (avoids sign-magnitude branching): a tick is carried as a
// non-negative "shifted" value s = tick + OFFSET, OFFSET = 888000 (a multiple of
// every tickSpacing's LCM 3000, and > the max |tick| 887272 so s stays positive).
// Stepping is plain unsigned s ± tickSpacing. The int24 STATICCALL arg is
// recovered via tickArg(): s>=OFFSET ? s-OFFSET : Math.neg(OFFSET-s).
//
// All math via Math.mulDiv / Math.sqrt / Math.neg + guarded ifs. The expensive
// ticks()/getTickLiquidity STATICCALLs are gated behind a per-pool `done` flag so
// gas scales with ticks ACTUALLY read.
//
// ── Compiler-arg layout (all bigint scalars / scalar-tuples) ─────────────────
//   tokenIn, tokenOut : Address
//   zeroForOne        : Uint256 (1 if tokenIn < tokenOut)
//   amountIn          : Uint256 (gross tokenIn; sizes the lazy walk)
//   driftTicks        : Uint256 (extra boundaries past the stop, each side)
//   minRelBps         : Uint256 (relative-depth floor in bps of Σliquidity)
//   maxTicks          : Uint256 (hard cap on forward tick reads per pool)
//   v3Factories[i]    = [factoryAddr]
//   v3FeeTiers[j]     = [fee, stepRatio]            stepRatio=floor(sqrt(1.0001^ts)*2^96)
//   v2Factories[i]    = [factoryAddr]
//   v4Factories[i]    = [poolManager, stateView]
//   v4Specs[j]        = [fee, tickSpacing, stepRatio]
//   v4PoolIds[i*J+j]  = [poolId]
//
// ── Return shape (off-chain abi.decode against this EXACTLY) ──────────────────
//   abi.encode(poolBlob: bytes, tickBlob: bytes)
//
//   poolBlob = a HEADER followed by SURVIVOR pool rows. The lens is the single
//   source of truth for survivorship: only pools with L >= liqFloor (relative-
//   depth floor) are emitted, so the consumer never re-filters.
//
//   HEADER (HEADER_WORDS = 4 words, exactly once at the start):
//     [0] discoveredCount (alive pools seen across all families)
//     [1] survivorCount   (pool rows that follow)
//     [2] totalL          (Σ liquidity over alive pools, for diagnostics)
//     [3] liqFloor        (the relative-depth survivor threshold actually applied)
//
//   then survivorCount rows, POOL_STRIDE = 13 words per pool:
//     [0] poolType (0=V2,1=V3,2=V4)  [1] address  [2] fee  [3] tickSpacing
//     [4] hooks(0)  [5] sqrtPriceX96 (synthetic out/in for V2)
//     [6] liquidity (synthetic √(rIn·rOut) for V2)  [7] tickRaw (int24 ZERO-EXT)
//     [8] inIsToken0 (V2 only)  [9] stateView (V4)  [10] poolId (V4)
//     [11] scannedForward (forward tick boundaries walked; 0 for V2)
//     [12] scannedReverse (reverse-drift tick boundaries walked; 0 for V2)
//
//   tickBlob = concatenated 32-byte words, TICK_STRIDE = 3 words per tick row:
//     [0] poolIdx  [1] tickIndexRaw (int24 ZERO-EXT)  [2] liquidityNetRaw (int128 ZERO-EXT)

// ── Pure helpers (no contract scope needed) ──────────────────────────────────

// int24 STATICCALL arg from a shifted tick.
function tickArg(shifted: Uint256, OFFSET: Uint256): Uint256 {
  if (shifted >= OFFSET) {
    return shifted - OFFSET;
  }
  return Math.neg(OFFSET - shifted);
}

// fee-adjusted out/in sqrt: sqrt * sqrt(1-fee) (sqrt(1-fee) scaled by 1e6).
function feeAdj(sqrtV: Uint256, fee: Uint256): Uint256 {
  const sf: Uint256 = Math.sqrt((1000000 - fee) * 1000000);
  return Math.mulDiv(sqrtV, sf, 1000000);
}

// Convert a real pool sqrt (token1/token0) into unified out/in sqrt.
function toOutIn(sqrtReal: Uint256, zeroForOne: Uint256): Uint256 {
  if (zeroForOne === 1) {
    return sqrtReal;
  }
  const Q192: Uint256 = 2 ** 192;
  return Q192 / sqrtReal;
}

// Next REAL sqrt one tickSpacing step in the swap direction.
//   zeroForOne (price down): sqrt' = mulDiv(sqrt, 2^96, stepRatio)
//   oneForZero (price up):   sqrt' = mulDiv(sqrt, stepRatio, 2^96)
function stepReal(sqrtReal: Uint256, stepRatio: Uint256, zeroForOne: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  if (zeroForOne === 1) {
    return Math.mulDiv(sqrtReal, Q96, stepRatio);
  }
  return Math.mulDiv(sqrtReal, stepRatio, Q96);
}

function main(
  tokenIn: Address,
  tokenOut: Address,
  zeroForOne: Uint256,
  amountIn: Uint256,
  driftTicks: Uint256,
  minRelBps: Uint256,
  maxTicks: Uint256,
  v3Factories: Tuple,
  v3FeeTiers: Tuple,
  v2Factories: Tuple,
  v4Factories: Tuple,
  v4Specs: Tuple,
  v4PoolIds: Tuple
): bytes {
  let poolBlob: bytes = abi.encode(tokenIn).slice(0, 0);
  let tickBlob: bytes = abi.encode(tokenIn).slice(0, 0);
  let poolCount: Uint256 = 0;
  let discovered: Uint256 = 0; // alive pools seen across all families (for header)

  const OFFSET: Uint256 = 888000; // tick shift (multiple of LCM(spacings)=3000, > max|tick|)
  const Q96: Uint256 = 2 ** 96;
  const Q192: Uint256 = 2 ** 192;
  const HALF128: Uint256 = 2 ** 127; // int128 sign bit
  const MOD128: Uint256 = 2 ** 128;

  // ════ PASS 1: CHEAP STATE — discover + slot0 + liquidity (NO ticks) ════
  // Accumulate total liquidity over every ALIVE pool (L > 0) and track the
  // deepest pool's coords (used by the floor pass). Survivorship is decided
  // below by the relative-depth floor alone (no absolute floor).
  let totalL: Uint256 = 0;
  let deepKind: Uint256 = 0; // 1=V3, 2=V4, 0=none
  let deepL: Uint256 = 0;
  let deepAddr: Address = 0;
  let deepFee: Uint256 = 0;
  let deepTs: Uint256 = 0;
  let deepStep: Uint256 = 0;
  let deepSqrt: Uint256 = 0;
  let deepTick: Uint256 = 0;
  let deepStateView: Address = 0;
  let deepPoolId: Uint256 = 0;

  for (let fi = 0; fi < v3Factories.length; fi = fi + 1) {
    const vf: Tuple = v3Factories[fi];
    const factory: Address = vf[0];
    for (let ti = 0; ti < v3FeeTiers.length; ti = ti + 1) {
      const ft: Tuple = v3FeeTiers[ti];
      const fee: Uint256 = ft[0];
      const step: Uint256 = ft[1];
      const poolAddr: Address = IUniswapV3Factory.at(factory).getPool(tokenIn, tokenOut, fee);
      if (poolAddr !== 0) {
        const sqrtP: Uint256 = IUniswapV3PoolFull.at(poolAddr).slot0()[0];
        const liq: Uint256 = IUniswapV3PoolFull.at(poolAddr).liquidity();
        if (sqrtP > 0) {
          if (liq > 0) {
            totalL = totalL + liq;
            discovered = discovered + 1;
            if (liq > deepL) {
              deepL = liq;
              deepKind = 1;
              deepAddr = poolAddr;
              deepFee = fee;
              deepTs = IUniswapV3PoolFull.at(poolAddr).tickSpacing();
              deepStep = step;
              deepSqrt = sqrtP;
              deepTick = IUniswapV3PoolFull.at(poolAddr).slot0()[1];
              deepStateView = 0;
              deepPoolId = 0;
            }
          }
        }
      }
    }
  }

  for (let qi = 0; qi < v4Factories.length; qi = qi + 1) {
    const vf4: Tuple = v4Factories[qi];
    const stateView: Address = vf4[1];
    for (let si = 0; si < v4Specs.length; si = si + 1) {
      const spec: Tuple = v4Specs[si];
      const v4fee: Uint256 = spec[0];
      const v4ts: Uint256 = spec[1];
      const v4step: Uint256 = spec[2];
      const idRow: Tuple = v4PoolIds[qi * v4Specs.length + si];
      const poolId: Uint256 = idRow[0];
      const sqrtP4: Uint256 = IStateViewFull.at(stateView).getSlot0(poolId)[0];
      if (sqrtP4 > 0) {
        const liq4: Uint256 = IStateViewFull.at(stateView).getLiquidity(poolId);
        if (liq4 > 0) {
          totalL = totalL + liq4;
          discovered = discovered + 1;
          if (liq4 > deepL) {
            deepL = liq4;
            deepKind = 2;
            deepAddr = vf4[0];
            deepFee = v4fee;
            deepTs = v4ts;
            deepStep = v4step;
            deepSqrt = sqrtP4;
            deepTick = IStateViewFull.at(stateView).getSlot0(poolId)[1];
            deepStateView = stateView;
            deepPoolId = poolId;
          }
        }
      }
    }
  }

  // V2 synthetic L also counts toward Σliquidity (prepare.ts includes V2 in the
  // total), so the relative-depth floor matches prepare's EXACTLY → the lens never
  // drops a pool prepare would keep (no phantom-data gap).
  for (let vli = 0; vli < v2Factories.length; vli = vli + 1) {
    const vlf: Tuple = v2Factories[vli];
    const factoryL: Address = vlf[0];
    const pairL: Address = IUniswapV2Factory.at(factoryL).getPair(tokenIn, tokenOut);
    if (pairL !== 0) {
      const lr0: Uint256 = IUniswapV2Pair.at(pairL).getReserves()[0];
      const lr1: Uint256 = IUniswapV2Pair.at(pairL).getReserves()[1];
      if (lr0 > 0) {
        if (lr1 > 0) {
          const synthLpre: Uint256 = Math.sqrt(lr0 * lr1);
          if (synthLpre > 0) {
            totalL = totalL + synthLpre;
            discovered = discovered + 1;
          }
        }
      }
    }
  }

  // Relative-depth floor (bps of Σliquidity) is the SOLE survivor gate now (no
  // absolute floor). Survivor iff L >= relFloor; minRelBps=0 keeps every alive pool.
  const relFloor: Uint256 = minRelBps > 0 ? Math.mulDiv(totalL, minRelBps, 10000) : 0;
  const liqFloor: Uint256 = relFloor;

  // ════ PASS 2: FLOOR — lazy-walk the deepest survivor → floorAdj ════
  // floorAdj defaults to 0 (no bound: walk every survivor to maxTicks) when the
  // walk never covers amountIn (amountIn exceeds the deepest pool's depth).
  let floorAdj: Uint256 = 0;
  if (deepKind > 0) {
    const baseShift: Uint256 = ((deepTick + OFFSET) / deepTs) * deepTs;
    // oneForZero walk starts one spacing ABOVE base.
    let curShift: Uint256 = baseShift;
    if (zeroForOne === 0) {
      curShift = baseShift + deepTs;
    }
    let L: Uint256 = deepL;
    let nearReal: Uint256 = deepSqrt;
    let cumIn: Uint256 = 0;
    let doneF: Uint256 = 0;
    for (let kf = 0; kf < maxTicks; kf = kf + 1) {
      if (doneF === 0) {
        const farReal: Uint256 = stepReal(nearReal, deepStep, zeroForOne);
        const nearOI: Uint256 = toOutIn(nearReal, zeroForOne);
        const farOI: Uint256 = toOutIn(farReal, zeroForOne);
        if (L > 0) {
          if (nearOI > farOI) {
            const effIn: Uint256 = Math.mulDiv(L, Q96, farOI) - Math.mulDiv(L, Q96, nearOI);
            const grossIn: Uint256 = Math.mulDiv(effIn, 1000000, 1000000 - deepFee);
            cumIn = cumIn + grossIn;
          }
        }
        // Cross the boundary tick: update L by liquidityNet.
        const argW: Uint256 = tickArg(curShift, OFFSET);
        let netRaw: Uint256 = 0;
        if (deepKind === 2) {
          netRaw = IStateViewFull.at(deepStateView).getTickLiquidity(deepPoolId, argW)[1];
        } else {
          netRaw = IUniswapV3PoolFull.at(deepAddr).ticks(argW)[1];
        }
        const isNeg: Uint256 = netRaw >= HALF128 ? 1 : 0;
        if (zeroForOne === 1) {
          // moving down: L -= net
          if (isNeg === 1) {
            L = L + (MOD128 - netRaw);
          } else {
            L = L >= netRaw ? L - netRaw : 0;
          }
          curShift = curShift - deepTs;
        } else {
          // moving up: L += net
          if (isNeg === 1) {
            const mag: Uint256 = MOD128 - netRaw;
            L = L >= mag ? L - mag : 0;
          } else {
            L = L + netRaw;
          }
          curShift = curShift + deepTs;
        }
        nearReal = farReal;
        if (cumIn >= amountIn) {
          floorAdj = feeAdj(farOI, deepFee);
          doneF = 1;
        }
      }
    }
  }

  // ════ PASS 3: BOUNDED — per survivor, lazy-walk + emit ════
  // V3 survivors.
  for (let fi3 = 0; fi3 < v3Factories.length; fi3 = fi3 + 1) {
    const vf3: Tuple = v3Factories[fi3];
    const factory3: Address = vf3[0];
    for (let ti3 = 0; ti3 < v3FeeTiers.length; ti3 = ti3 + 1) {
      const ft3: Tuple = v3FeeTiers[ti3];
      const fee3: Uint256 = ft3[0];
      const step3: Uint256 = ft3[1];
      const poolAddr3: Address = IUniswapV3Factory.at(factory3).getPool(tokenIn, tokenOut, fee3);
      if (poolAddr3 !== 0) {
        const sqrt3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).slot0()[0];
        const liq3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).liquidity();
        // SURVIVOR iff alive AND at/above the relative-depth floor. When liqFloor
        // is 0 (minRelBps=0) the > 0 check still drops empty pools.
        let surv3: Uint256 = 0;
        if (liq3 > 0) {
          if (liq3 >= liqFloor) {
            surv3 = 1;
          }
        }
        if (sqrt3 > 0) {
          if (surv3 === 1) {
            const ts3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).tickSpacing();
            const tick3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).slot0()[1];
            const idx3: Uint256 = poolCount;

            // ── Reverse-side drift reads (opposite direction), survivors only ──
            const baseRev3: Uint256 = ((tick3 + OFFSET) / ts3) * ts3;
            // reverse of swap dir: for zeroForOne (down) reverse is UP → start +ts.
            let revShift3: Uint256 = baseRev3;
            if (zeroForOne === 1) {
              revShift3 = baseRev3 + ts3;
            }
            let scanRev3: Uint256 = 0; // reverse boundaries walked (= count emitted)
            for (let rd3 = 0; rd3 < driftTicks; rd3 = rd3 + 1) {
              const ra3: Uint256 = tickArg(revShift3, OFFSET);
              const rn3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).ticks(ra3)[1];
              tickBlob = tickBlob.concat(abi.encode(idx3, ra3, rn3));
              scanRev3 = scanRev3 + 1;
              if (zeroForOne === 1) {
                revShift3 = revShift3 + ts3; // further up
              } else {
                revShift3 = revShift3 - ts3; // further down
              }
            }

            // ── Forward lazy walk (swap direction) ──
            const baseShift3: Uint256 = ((tick3 + OFFSET) / ts3) * ts3;
            let curShift3: Uint256 = baseShift3;
            if (zeroForOne === 0) {
              curShift3 = baseShift3 + ts3;
            }
            let L3: Uint256 = liq3;
            let nearReal3: Uint256 = sqrt3;
            let cumIn3: Uint256 = 0;
            let scanned3: Uint256 = 0;
            let stop3: Uint256 = 0;    // hit cumIn>=amountIn OR feeAdj(far)<=floorAdj
            let drift3: Uint256 = 0;   // extra ticks emitted after stop
            let done3: Uint256 = 0;
            for (let k3 = 0; k3 < maxTicks; k3 = k3 + 1) {
              if (done3 === 0) {
                const argW3: Uint256 = tickArg(curShift3, OFFSET);
                const net3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).ticks(argW3)[1];
                tickBlob = tickBlob.concat(abi.encode(idx3, argW3, net3));
                scanned3 = scanned3 + 1;

                const farReal3: Uint256 = stepReal(nearReal3, step3, zeroForOne);
                const nearOI3: Uint256 = toOutIn(nearReal3, zeroForOne);
                const farOI3: Uint256 = toOutIn(farReal3, zeroForOne);
                if (L3 > 0) {
                  if (nearOI3 > farOI3) {
                    const effIn3: Uint256 = Math.mulDiv(L3, Q96, farOI3) - Math.mulDiv(L3, Q96, nearOI3);
                    cumIn3 = cumIn3 + Math.mulDiv(effIn3, 1000000, 1000000 - fee3);
                  }
                }
                const isNeg3: Uint256 = net3 >= HALF128 ? 1 : 0;
                if (zeroForOne === 1) {
                  if (isNeg3 === 1) {
                    L3 = L3 + (MOD128 - net3);
                  } else {
                    L3 = L3 >= net3 ? L3 - net3 : 0;
                  }
                  curShift3 = curShift3 - ts3;
                } else {
                  if (isNeg3 === 1) {
                    const mag3: Uint256 = MOD128 - net3;
                    L3 = L3 >= mag3 ? L3 - mag3 : 0;
                  } else {
                    L3 = L3 + net3;
                  }
                  curShift3 = curShift3 + ts3;
                }
                nearReal3 = farReal3;

                // Stop test: covered amountIn OR fell to/below the floor price.
                if (stop3 === 0) {
                  const fa3: Uint256 = feeAdj(farOI3, fee3);
                  let hitFloor: Uint256 = 0;
                  if (floorAdj > 0) {
                    if (fa3 <= floorAdj) {
                      hitFloor = 1;
                    }
                  }
                  if (cumIn3 >= amountIn) {
                    stop3 = 1;
                  } else {
                    if (hitFloor === 1) {
                      stop3 = 1;
                    }
                  }
                }
                if (stop3 === 1) {
                  drift3 = drift3 + 1;
                  if (drift3 > driftTicks) {
                    done3 = 1;
                  }
                }
              }
            }

            poolBlob = poolBlob.concat(
              abi.encode(1, poolAddr3, fee3, ts3, 0, sqrt3, liq3, tick3, 0, 0, 0, scanned3, scanRev3)
            );
            poolCount = poolCount + 1;
          }
        }
      }
    }
  }

  // ── Direct V2 discovery (no ticks) ──
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
          // SURVIVORS ONLY: drop V2 pools below the relative-depth floor (matches
          // the V3/V4 gate so the lens decides V2 survivorship too).
          if (synthL >= liqFloor) {
            const synthSqrt: Uint256 = Math.sqrt(Math.mulDiv(reserveOut, Q192, reserveIn));
            poolBlob = poolBlob.concat(
              abi.encode(0, pairAddr, 3000, 0, 0, synthSqrt, synthL, 0, inIsT0, 0, 0, 0, 0)
            );
            poolCount = poolCount + 1;
          }
        }
      }
    }
  }

  // ── V4 survivors (lazy walk via StateView) ──
  for (let qi3 = 0; qi3 < v4Factories.length; qi3 = qi3 + 1) {
    const vf43: Tuple = v4Factories[qi3];
    const poolManager3: Address = vf43[0];
    const stateView3: Address = vf43[1];
    for (let si3 = 0; si3 < v4Specs.length; si3 = si3 + 1) {
      const spec3: Tuple = v4Specs[si3];
      const v4fee3: Uint256 = spec3[0];
      const v4ts3: Uint256 = spec3[1];
      const v4step3: Uint256 = spec3[2];
      const idRow3: Tuple = v4PoolIds[qi3 * v4Specs.length + si3];
      const poolId3: Uint256 = idRow3[0];
      const sqrtP43: Uint256 = IStateViewFull.at(stateView3).getSlot0(poolId3)[0];
      if (sqrtP43 > 0) {
        const liq43: Uint256 = IStateViewFull.at(stateView3).getLiquidity(poolId3);
        // SURVIVOR iff alive AND at/above the relative-depth floor (single gate).
        let surv4: Uint256 = 0;
        if (liq43 > 0) {
          if (liq43 >= liqFloor) {
            surv4 = 1;
          }
        }
        if (surv4 === 1) {
          const tick43: Uint256 = IStateViewFull.at(stateView3).getSlot0(poolId3)[1];
          const idx43: Uint256 = poolCount;

          const baseRev4: Uint256 = ((tick43 + OFFSET) / v4ts3) * v4ts3;
          let revShift4: Uint256 = baseRev4;
          if (zeroForOne === 1) {
            revShift4 = baseRev4 + v4ts3;
          }
          let scanRev4: Uint256 = 0; // reverse boundaries walked (= count emitted)
          for (let rd4 = 0; rd4 < driftTicks; rd4 = rd4 + 1) {
            const ra4: Uint256 = tickArg(revShift4, OFFSET);
            const rn4: Uint256 = IStateViewFull.at(stateView3).getTickLiquidity(poolId3, ra4)[1];
            tickBlob = tickBlob.concat(abi.encode(idx43, ra4, rn4));
            scanRev4 = scanRev4 + 1;
            if (zeroForOne === 1) {
              revShift4 = revShift4 + v4ts3;
            } else {
              revShift4 = revShift4 - v4ts3;
            }
          }

          const baseShift4: Uint256 = ((tick43 + OFFSET) / v4ts3) * v4ts3;
          let curShift4: Uint256 = baseShift4;
          if (zeroForOne === 0) {
            curShift4 = baseShift4 + v4ts3;
          }
          let L4: Uint256 = liq43;
          let nearReal4: Uint256 = sqrtP43;
          let cumIn4: Uint256 = 0;
          let scanned4: Uint256 = 0;
          let stop4: Uint256 = 0;
          let drift4: Uint256 = 0;
          let done4: Uint256 = 0;
          for (let k4 = 0; k4 < maxTicks; k4 = k4 + 1) {
            if (done4 === 0) {
              const argW4: Uint256 = tickArg(curShift4, OFFSET);
              const net4: Uint256 = IStateViewFull.at(stateView3).getTickLiquidity(poolId3, argW4)[1];
              tickBlob = tickBlob.concat(abi.encode(idx43, argW4, net4));
              scanned4 = scanned4 + 1;

              const farReal4: Uint256 = stepReal(nearReal4, v4step3, zeroForOne);
              const nearOI4: Uint256 = toOutIn(nearReal4, zeroForOne);
              const farOI4: Uint256 = toOutIn(farReal4, zeroForOne);
              if (L4 > 0) {
                if (nearOI4 > farOI4) {
                  const effIn4: Uint256 = Math.mulDiv(L4, Q96, farOI4) - Math.mulDiv(L4, Q96, nearOI4);
                  cumIn4 = cumIn4 + Math.mulDiv(effIn4, 1000000, 1000000 - v4fee3);
                }
              }
              const isNeg4: Uint256 = net4 >= HALF128 ? 1 : 0;
              if (zeroForOne === 1) {
                if (isNeg4 === 1) {
                  L4 = L4 + (MOD128 - net4);
                } else {
                  L4 = L4 >= net4 ? L4 - net4 : 0;
                }
                curShift4 = curShift4 - v4ts3;
              } else {
                if (isNeg4 === 1) {
                  const mag4: Uint256 = MOD128 - net4;
                  L4 = L4 >= mag4 ? L4 - mag4 : 0;
                } else {
                  L4 = L4 + net4;
                }
                curShift4 = curShift4 + v4ts3;
              }
              nearReal4 = farReal4;

              if (stop4 === 0) {
                const fa4: Uint256 = feeAdj(farOI4, v4fee3);
                let hitFloor4: Uint256 = 0;
                if (floorAdj > 0) {
                  if (fa4 <= floorAdj) {
                    hitFloor4 = 1;
                  }
                }
                if (cumIn4 >= amountIn) {
                  stop4 = 1;
                } else {
                  if (hitFloor4 === 1) {
                    stop4 = 1;
                  }
                }
              }
              if (stop4 === 1) {
                drift4 = drift4 + 1;
                if (drift4 > driftTicks) {
                  done4 = 1;
                }
              }
            }
          }

          poolBlob = poolBlob.concat(
            abi.encode(2, poolManager3, v4fee3, v4ts3, 0, sqrtP43, liq43, tick43, 0, stateView3, poolId3, scanned4, scanRev4)
          );
          poolCount = poolCount + 1;
        }
      }
    }
  }

  // Prepend the 4-word HEADER so the decoder reads survivorship straight from the
  // lens (single source of truth): discoveredCount, survivorCount (= poolCount),
  // totalL, liqFloor. Every row after the header is a survivor.
  const header: bytes = abi.encode(discovered, poolCount, totalL, liqFloor);
  return abi.encode(header.concat(poolBlob), tickBlob);
}
