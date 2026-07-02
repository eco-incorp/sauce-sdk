/**
 * EcoSwap Trader Joe (LFJ) Liquidity Book v2.2 PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The LB analogue of ecoswap.dodo.prodmirror.evm.test.ts / ecoswap.woofi.prodmirror.evm.test.ts. Unlike
 * ecoswap.lb.evm.test.ts (which deploys the MOCK TraderJoeLBPair.sol fixture), this test stands up the
 * GENUINE Arbitrum LB v2.2 LBPair bytecode captured from mainnet and runs the swap against it — proving the
 * production FactoryType.TraderJoeLB discovery + the engine `_swapTraderJoeLB` execution path work on the
 * real contract, with NO fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * POOL: the deepest on-charter STABLE LBPair the wired FactoryType.TraderJoeLB discovery reaches — a
 * USDT0/USDC binStep=1 pair on Arbitrum (0xFC43…7427). FIDELITY / DEPTH DISCLOSURE (honest): LB stable
 * depth on Eco chains is THIN (this pair is ≈$2.6k total). LB's deep books are on Avalanche, which is NOT
 * an Eco chain. This is a FALLBACK (deepest stable-inclusive on an Eco chain), but a GENUINE, fully
 * on-charter, correctly-discovered LBPair with real bin liquidity on BOTH sides of the active bin — exactly
 * what the prod-mirror needs to run the REAL bin-crossing code offline.
 *
 * MECHANISM (mirrors the repo's V4 real-runtime etch, generalised in harness/etch-pool.ts → etchLbPool):
 *   CAPTURE (one-time, harness/lb-snapshot.ts, uses the RPC key):
 *     eth_getCode BOTH the 97-byte immutable-args clone proxy AND the LBPair implementation runtime (the
 *     bin/fee/swap math) — the FULL swap/quote dependency graph (the pair reads nothing else on the path;
 *     tokenX/tokenY/binStep are the clone's IMMUTABLE ARGS in the proxy bytecode, and the fee params are in
 *     its own packed storage). Both are sha256-anchored. The swap-relevant STATE goes to .state.json: the
 *     active bin id + a WINDOW of bins around it (reserveX/reserveY per bin — the discrete-bin analogue of a
 *     CL tick window), the static fee params, binStep, tokens/decimals, plus the RAW storage slots that back
 *     them — the packed param slots (0..11), the `_bins` mapping slots, AND the `_tree` bitmap slots (level0 +
 *     level1/level2 groups) so the etched pair's findFirstRight/Left bin walk CROSSES bins (without the tree
 *     it would drain only the active bin). Block + block.timestamp pinned. No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); pin block.timestamp to the capture ts (LB's
 *     _parameters.updateReferences(block.timestamp) underflows below timeOfLastUpdate); etch the REAL impl at
 *     its captured address + the REAL 97-byte proxy at the pool address; etch a local MintableERC20 AT EACH
 *     REAL token address (tokenX + tokenY) — the clone bakes tokenX/tokenY as immutable args in the proxy
 *     bytecode, so the local tokens MUST live at the real addresses (the Wombat-underlying constraint);
 *     setStorageAt the captured param/bin/tree storage VERBATIM (with the transient variableFeeControl field
 *     NEUTRALIZED — see the HONEST fee note); and stand up a tiny read-only LB factory shim
 *     (getLBPairInformation) at the captured factory address for the discovery read. The swap then runs the
 *     GENUINE LBPair bytecode: getSwapOut returns the mainnet-identical amountOut for the captured bins, and
 *     swap(swapForY, to) transfers real (local) tokens via the engine's transfer-first `_swapTraderJoeLB`.
 *
 * CENTRAL VERIFICATION (this file asserts all explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool + impl in the test == the captured real runtime, byte-for-
 *       byte (the bin/fee/swap math — the swap-relevant code). No mock TraderJoeLBPair.sol is in the swap
 *       path (the pool/impl addresses are the captured mainnet addresses, running captured code). The REAL
 *       getSwapOut reproduces the reconstructed bins.
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — spent == the neutral oracle's awarded input == oracle.totalInput, to the WEI (the SPLIT is
 *       wei-exact: an LB bin is a flat constant-sum slice, no sampling error). The neutral oracle's realized dy
 *       (ecoswap.optimal.ts optimalSplit, seeded from the REAL captured bins via the SHARED buildLbSegments) ==
 *       the REAL pool's OWN getSwapOut quote view of the awarded slice, to the WEI. The EXECUTED output the
 *       caller receives is exactly 1 wei below that quote — the DOCUMENTED, intrinsic LB v2.2 quoter-vs-executor
 *       discrepancy (the real `swap` executor rounds down exactly 1 wei more than the real `getSwapOut` view;
 *       verified fixed at 1 wei, both directions, every size). We assert that gap EXACTLY (not a tolerance), so
 *       any other-magnitude regression fails. This is honest: oracle and pool-view agree to the wei; the pool's
 *       OWN executor delivers 1 wei less than its OWN quoter.
 *
 * HONEST fee accounting (real-code fee/bin details): LB's total fee = baseFee + variableFee. The base fee is
 * `baseFactor·binStep·1e10` (a fixed per-block snapshot the off-chain lb-math models). The VARIABLE fee is a
 * TRANSIENT volatility surcharge that accrues per bin crossed and resets between blocks — a static snapshot
 * cannot faithfully carry it (the same fixed-fee assumption the recipe makes for V3 tiers / Curve fee). So the
 * etch NEUTRALIZES the packed `variableFeeControl` field (slot-4 bits [54,78)), which makes the real pair's
 * total fee == its base fee for ANY swap path — so the executed dy == lb-math.ts getSwapOut to the WEI. This
 * is the LB analogue of DODO's resolved-mtFeeRate scalar and WOOFi's CL round shims: the ONE transient piece a
 * static snapshot can't carry. ALL OTHER pair state (baseFactor, binStep, per-bin reserves, the tree bitmap)
 * is byte-identical to mainnet. The fee is charged on the INPUT (netted per bin), so the pair retains the full
 * tokenIn (poolIn == spent) and the fee shows up as a smaller tokenOut, exactly as the oracle models it.
 *
 * ROUNDING (real-code bin details): lb-math.ts + the fixture were made bit-for-bit with the real LBPair per-
 * bin ROUND-UP price/fee math (Bin.getAmounts + FeeHelper.getFeeAmount) — verified here to the WEI across the
 * whole reconstructed window (the earlier floor approximation was ~1-2 wei/bin short).
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts are
 * absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: ECO_LB_BIN_WINDOW=32 npx tsx --test src/recipes/test/ecoswap.lb.prodmirror.evm.test.ts
 *      ECO_ENGINE=both pnpm --filter './sdk' test:recipes:evm
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  mint,
  approve,
  balanceOf,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  etchLbPool,
  loadLbSnapshots,
  verifyLbBytecodeIntegrity,
  neutralizeVariableFee,
  lbPairReadAbi,
  lbFactoryShimAbi,
  type EtchedLbPool,
  type LbStateSnapshot,
} from "./harness/etch-pool";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { EcoBracketKind } from "../shared/types";
import { ecoSwap } from "../ecoswap/index";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { getSwapOut as lbGetSwapOut, buildLbSegments, type LbPool } from "../shared/lb-math";

const SNAP_NAME = "arbitrum-lb-USDCUSDT";
const ENGINE_CELLS = engineCells();

// Constrain the production LB discovery's per-side bin walk to the captured window (±32). The reconstructed
// pair only has 65 non-empty bins (±32 around the active id); discovery would read up to ±256 (getBin per id)
// and get (0,0) for the un-reconstructed ids — same 65 non-empty bins, just slower. Pinning it makes the
// on-chain discovered bin set EXACTLY the oracle's snapshot bin set (and keeps the local multicall small).
process.env.ECO_LB_BIN_WINDOW = process.env.ECO_LB_BIN_WINDOW ?? "32";

/**
 * Pin the cook block.timestamp to the captured block ts, moving BACKWARD if needed (anvil genesis ts is the
 * real wall clock, AFTER this future-dated Arbitrum block). LB v2.2 getSwapOut/swap call
 * `_parameters.updateReferences(block.timestamp)`, which underflows if block.timestamp < timeOfLastUpdate;
 * pinning to the capture ts keeps the (base-fee-only, vfc-neutralized) fee path deterministic at the captured
 * instant. Mirrors the WOOFi prod-mirror's pinCaptureTime.
 */
async function pinCaptureTime(c: HarnessClients, ts: bigint): Promise<void> {
  await c.testClient.request({ method: "anvil_setTime", params: [("0x" + ts.toString(16)) as Hex] } as never);
  await c.testClient.setBlockTimestampInterval({ interval: 0 });
  await c.testClient.mine({ blocks: 1 });
}

describe("EcoSwap Trader Joe LB v2.2 prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadLbSnapshots(SNAP_NAME);
  const captureTs = BigInt(snaps.state.blockTimestamp);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedLbPool;

  // Boot a fresh anvil + pin the capture time + etch the real pair + deploy the engine. Called before each
  // cell so each engine runs in full isolation (cheap — the whole setup is etch + setStorageAt + a few deploys).
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    await pinCaptureTime(c, captureTs);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // ~2x the pool reserve as caller headroom (6-decimal tokens; reserves ~1.4k each side).
    etched = await etchLbPool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: BigInt(snaps.state.reserveX) * 2n,
    });
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a TraderJoeLB factory (the shim) → the production LB discovery path
   *  (discoverTraderJoeLBPoolsTyped) resolves the etched pair; the lens ignores non-V2/V3/V4 factory types,
   *  so no direct pools are surfaced and the LB venue rides entirely through the typed discovery + the
   *  callback-free transfer-first swap(SwapParams{poolType:6}) → engine `_swapTraderJoeLB` exec block. */
  function lbPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.factory,
          poolType: SwapPoolType.TraderJoeLB,
          factoryType: FactoryType.TraderJoeLB,
          label: "Local LB v2.2 (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  /** The neutral oracle's LbPool descriptor for the single reproduced LBPair, seeded from the REAL captured
   *  bins. `swapForY` follows tokenIn == the pair's tokenX. buildLbSegments enumerates the SAME per-bin flat
   *  segments the production prepare consumes, so the split is EXACT by construction. */
  function offPool(state: LbStateSnapshot, tokenIn: Hex): LbPool {
    return {
      poolType: SwapPoolType.TraderJoeLB,
      address: etched.pool,
      binStep: state.binStep,
      baseFactor: state.staticFeeParameters.baseFactor,
      activeId: state.activeId,
      swapForY: tokenIn.toLowerCase() === state.tokenX.toLowerCase(),
      bins: state.binWindow.bins.map((b) => ({
        id: b.id,
        reserveX: BigInt(b.reserveX),
        reserveY: BigInt(b.reserveY),
      })),
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL LB v2.2 bytecode (byte-equal) + reconstructs the captured bins + tree", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime blobs (pair proxy + LBPair impl) still hash
    // to the sha256 anchors recorded at capture time (byte-equal to the pinned-block on-chain code). A reviewer
    // WITHOUT the RPC key can run this — it proves the snapshot wasn't silently altered/truncated after capture.
    const integ = verifyLbBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pair runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(integ.implementation.ok, `impl runtime sha256 matches the capture anchor (got ${integ.implementation.actual})`);
    assert.ok(snaps.bytecode.pair.runtimeSha256, "pair snapshot carries a sha256 integrity anchor");
    assert.ok(snaps.bytecode.implementation.runtimeSha256, "impl snapshot carries a sha256 integrity anchor");
    assert.equal(snaps.bytecode.isImmutableArgsClone, true, "snapshot flags the LB immutable-args clone shape");

    // getCode at the pool + impl must EQUAL the captured real runtime (no mock in the path). These are the
    // swap-relevant contracts: the 97-byte clone proxy + the ~22.5 kB LBPair implementation (all bin/fee math).
    const [poolCode, implCode] = await Promise.all([
      c.publicClient.getCode({ address: etched.pool }),
      c.publicClient.getCode({ address: etched.impl }),
    ]);
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pair.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL LB v2.2 immutable-args clone proxy runtime (byte-equal)",
    );
    assert.ok(implCode, "impl has code");
    assert.equal(
      implCode!.toLowerCase(),
      snaps.bytecode.implementation.runtime.toLowerCase(),
      "eth_getCode at the impl == the captured REAL LBPair implementation runtime (byte-equal)",
    );
    // The pool/impl addresses are the CAPTURED mainnet addresses — no locally-compiled mock.
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pair.address.toLowerCase(), "pool at captured mainnet address");
    assert.equal(etched.impl.toLowerCase(), snaps.bytecode.implementation.address.toLowerCase(), "impl at captured mainnet address");
    // The clone proxy embeds the impl address (immutable-args delegatecall target) — the impl MUST sit there.
    assert.ok(
      poolCode!.toLowerCase().includes(etched.impl.slice(2).toLowerCase()),
      "the clone proxy runtime embeds the impl address (immutable-args delegatecall target)",
    );

    // The REAL LBPair code reads the reconstructed state correctly.
    const [tX, tY, aId, bStep, sfp, reserves] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: lbPairReadAbi, functionName: "getTokenX" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: lbPairReadAbi, functionName: "getTokenY" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: lbPairReadAbi, functionName: "getActiveId" }) as Promise<number>,
      c.publicClient.readContract({ address: etched.pool, abi: lbPairReadAbi, functionName: "getBinStep" }) as Promise<number>,
      c.publicClient.readContract({ address: etched.pool, abi: lbPairReadAbi, functionName: "getStaticFeeParameters" }) as Promise<readonly number[]>,
      c.publicClient.readContract({ address: etched.pool, abi: lbPairReadAbi, functionName: "getReserves" }) as Promise<readonly [bigint, bigint]>,
    ]);
    assert.equal(tX.toLowerCase(), etched.tokenX.toLowerCase(), "getTokenX == the (local, real-address) tokenX");
    assert.equal(tY.toLowerCase(), etched.tokenY.toLowerCase(), "getTokenY == the (local, real-address) tokenY");
    assert.equal(Number(aId), etched.activeId, "getActiveId == captured");
    assert.equal(Number(bStep), etched.binStep, "getBinStep == captured");
    assert.equal(Number(sfp[0]), etched.baseFactor, "getStaticFeeParameters().baseFactor == captured");
    // The transient variableFeeControl is neutralized (the ONE disclosed output-relevant edit) — every other
    // static fee param is byte-identical to mainnet.
    assert.equal(Number(sfp[4]), 0, "variableFeeControl neutralized (transient volatility surcharge → base-fee-only)");
    assert.equal(Number(sfp[1]), snaps.state.staticFeeParameters.filterPeriod, "filterPeriod byte-identical to mainnet");
    assert.equal(Number(sfp[3]), snaps.state.staticFeeParameters.reductionFactor, "reductionFactor byte-identical to mainnet");
    assert.equal(Number(sfp[6]), snaps.state.staticFeeParameters.maxVolatilityAccumulator, "maxVolatilityAccumulator byte-identical to mainnet");
    assert.equal(reserves[0], BigInt(snaps.state.reserveX), "getReserves().reserveX == captured");
    assert.equal(reserves[1], BigInt(snaps.state.reserveY), "getReserves().reserveY == captured");

    // The tree bitmap reconstruction lets the REAL code SEE the whole window's bins (not just the active bin):
    // read the active bin + a couple of neighbours via the real getBin and match the captured reserves.
    const sampleIds = [etched.activeId, etched.activeId - 1, etched.activeId + 1].filter((id) => id >= 0);
    for (const id of sampleIds) {
      const snapBin = snaps.state.binWindow.bins.find((b) => b.id === id);
      if (!snapBin) continue;
      const [rX, rY] = (await c.publicClient.readContract({
        address: etched.pool, abi: lbPairReadAbi, functionName: "getBin", args: [id],
      })) as readonly [bigint, bigint];
      assert.equal(rX, BigInt(snapBin.reserveX), `getBin(${id}).reserveX == captured`);
      assert.equal(rY, BigInt(snapBin.reserveY), `getBin(${id}).reserveY == captured`);
    }

    // The LB factory shim resolves the pair for its true binStep and NOTHING for the others (the per-step
    // discovery gate) — so discovery surfaces the pair exactly once, on its real step.
    const infoMatch = (await c.publicClient.readContract({
      address: etched.factory, abi: lbFactoryShimAbi, functionName: "getLBPairInformation", args: [etched.tokenX, etched.tokenY, BigInt(etched.binStep)],
    })) as readonly [bigint, Hex, boolean, boolean];
    assert.equal(Number(infoMatch[0]), etched.binStep, "shim getLBPairInformation(binStep) returns the binStep");
    assert.equal(infoMatch[1].toLowerCase(), etched.pool.toLowerCase(), "shim resolves the etched pair for its binStep");
    assert.equal(infoMatch[3], false, "shim reports ignoredForRouting=false (routable)");
    const otherStep = etched.binStep === 5 ? 10 : 5;
    const infoMiss = (await c.publicClient.readContract({
      address: etched.factory, abi: lbFactoryShimAbi, functionName: "getLBPairInformation", args: [etched.tokenX, etched.tokenY, BigInt(otherStep)],
    })) as readonly [bigint, Hex, boolean, boolean];
    assert.equal(infoMiss[1], "0x0000000000000000000000000000000000000000", "shim returns no pair for a non-matching binStep");

    // The REAL getSwapOut reproduces the neutral-oracle getSwapOut for a probe within the window, to the WEI —
    // the strongest single-shot proof the etched code IS the mainnet bin/fee math (base-fee-only, vfc-neutral).
    const opProbe = offPool(snaps.state, etched.tokenX); // swapForY (sell tokenX)
    const probeCap = buildLbSegments(opProbe, 10n ** 18n).reduce((a, s) => a + s.capacity, 0n);
    const probeIn = probeCap / 4n;
    const realProbe = (await c.publicClient.readContract({
      address: etched.pool, abi: lbPairReadAbi, functionName: "getSwapOut", args: [probeIn, true],
    })) as readonly [bigint, bigint, bigint];
    assert.equal(realProbe[0], 0n, "probe fully consumed (amountInLeft == 0 — within the reconstructed window)");
    assert.equal(
      realProbe[1],
      lbGetSwapOut(opProbe, probeIn),
      "REAL getSwapOut(probe) == neutral-oracle lb-math getSwapOut (wei-exact — real bin/fee math, vfc-neutral)",
    );

    console.log(
      `  [lb-prod-mirror] REAL bytecode etched: pool ${etched.pool} (clone proxy ${(poolCode!.length - 2) / 2} B) ` +
        `-> impl ${etched.impl} (${(implCode!.length - 2) / 2} B); captured block ${snaps.state.block} ts ${captureTs}; ` +
        `binStep ${etched.binStep} baseFactor ${etched.baseFactor} activeId ${etched.activeId}; ` +
        `reserves X=${etched.reserveX} Y=${etched.reserveY}; ${snaps.state.binWindow.bins.length} bins + tree reconstructed. ` +
        `variableFeeControl neutralized (transient volatility surcharge → base-fee-only, disclosed).`,
    );
  });

  // Sanity: the neutralizeVariableFee helper only clears the variableFeeControl field (leaves every other bit).
  it("neutralizeVariableFee clears ONLY the variableFeeControl field of the packed param word", () => {
    const slot4 = snaps.state.paramStorage["4"];
    const cleared = neutralizeVariableFee(slot4);
    const v = BigInt(slot4);
    const cv = BigInt(cleared);
    const vfcField = (x: bigint) => (x >> 54n) & ((1n << 24n) - 1n);
    assert.ok(vfcField(v) > 0n, "captured variableFeeControl is non-zero (a real volatility surcharge was live)");
    assert.equal(vfcField(cv), 0n, "neutralized variableFeeControl == 0");
    // Every bit OUTSIDE [54,78) is unchanged.
    const outsideMask = ((1n << 256n) - 1n) ^ (((1n << 78n) - 1n) ^ ((1n << 54n) - 1n));
    assert.equal(v & outsideMask, cv & outsideMask, "all bits outside variableFeeControl are byte-identical");
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Sell tokenX → tokenY (swapForY). tokenIn = tokenX, tokenOut = tokenY.
    const tokenIn = etched.tokenX;
    const tokenOut = etched.tokenY;

    // Size the trade to ~half the window's tokenX-side capacity — a genuine MULTI-BIN swap (crosses several
    // bins, exercising the real tree walk + per-bin fee) that stays well within the reconstructed window (so
    // the on-chain-discovered bin set == the oracle's snapshot bin set, and the fill is complete).
    const opFull = offPool(snaps.state, tokenIn);
    const windowCap = buildLbSegments(opFull, 10n ** 30n).reduce((a, s) => a + s.capacity, 0n);
    const amountIn = windowCap / 2n;
    assert.ok(amountIn > 0n, "non-zero swap sized from the window capacity");

    const poolConfig = lbPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // Run EcoSwap through the PRODUCTION FactoryType.TraderJoeLB discovery path (reads the etched pair's real
    // getters + the factory shim; builds the LB brackets from the REAL live bins via buildLbSegments).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced LB venue (via the real getters + the per-step shim).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (LB-only config)");
    assert.equal((prepared.lbs ?? []).length, 1, "discovered exactly the 1 reproduced LB venue");
    assert.equal(
      prepared.lbs![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered LB venue is the REAL etched pair",
    );
    assert.equal(prepared.lbs![0].binStep, etched.binStep, "discovery read the real binStep");
    assert.ok(
      (prepared.brackets ?? []).some((b) => b.kind === EcoBracketKind.LB),
      "LB segments present in the prepared brackets",
    );

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one LB venue seeded from the REAL captured bins via the SHARED
    // buildLbSegments (the SAME enumerator prepare uses). Pure off-chain math (computed BEFORE the cook), so
    // the awarded Σ is known ahead — and the engine's static-segment cursor consumes the IDENTICAL grid, so
    // on-chain spent == oracle.totalInput to the wei.
    const optPools: OptimalPool[] = [{ lb: opFull, feePpm: prepared.lbs![0].feePpm } as OptimalPool];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced LB venue");

    // The REAL pair's OWN PRE-swap getSwapOut view for the KNOWN awarded Σ — the engine-independent ground
    // truth for the executed dy of the awarded slice, read on the pre-swap bins (the swap mutates them). This
    // is the REAL Solidity bin/fee math, NOT the off-chain replay.
    const onViewPre = (await c.publicClient.readContract({
      address: etched.pool, abi: lbPairReadAbi, functionName: "getSwapOut", args: [awarded, true],
    })) as readonly [bigint, bigint, bigint];
    assert.equal(onViewPre[0], 0n, "awarded Σ fully consumed within the window (amountInLeft == 0)");
    const onViewOut = onViewPre[1];

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, etched.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL LBPair bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, etched.pool)) - poolInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // HONEST fee accounting: LB nets the fee OFF the per-bin input inside swap() (transfer-first, the pair
    // KEEPS the full input it receives). So the pair receives the FULL tokenIn — the fee shows up as a smaller
    // tokenOut, exactly as the oracle's getSwapOut (which nets the SAME base fee per bin) models it.
    assert.equal(poolIn, spent, "REAL LBPair netted the FULL input (fee taken per-bin on the output, not routed out)");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI. NO tolerance. An LB bin is a flat
    // constant-sum slice (buildLbSegments emits ONE flat segment per bin — no sampling error), and the engine's
    // static-segment cursor consumes the IDENTICAL grid, so spent == the oracle's awarded Σ == oracle.totalInput
    // to the WEI. Unlike a sampled-curve source (Curve/DODO/WOOFi), the LB ladder can cover the FULL amountIn
    // (the last bin enters whole once cumulative capacity tips over), and the merge caps the spend at amountIn.
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact)");
    assert.ok(spent <= amountIn, "spent does not exceed amountIn");

    // (1) The neutral oracle's realized dy == the REAL pair's OWN quote view, TO THE WEI. NO tolerance. This
    //     is the "wei-exact vs the oracle AND vs the pool's own quote view" gate: lb-math.ts's per-bin ceil
    //     price/fee math (buildLbSegments/getSwapOut) reproduces the real LBPair's getSwapOut quoter bit-for-bit
    //     for the awarded Σ (base-fee-only, vfc-neutralized). Both quoters agree exactly.
    const oracleDy = lbGetSwapOut(opFull, spent);
    assert.equal(oracleDy, onViewOut, "neutral-oracle lb-math getSwapOut(Σ) == REAL pair getSwapOut quote view (wei-exact)");

    // (2) The EXECUTED output (what the caller/engine receives) == the pool's own quote view MINUS exactly 1
    //     wei — the DOCUMENTED, intrinsic LB v2.2 quoter-vs-executor discrepancy: the real LBPair's `swap`
    //     executor's per-swap `Bin.getAmounts` composition rounds down exactly ONE wei more than its own
    //     `getSwapOut` view (verified: EXACTLY 1 wei, both directions, every swap size — see the harness
    //     characterization). This is a property of the REAL contract, NOT a modeling gap: the view (== the
    //     oracle) is the pool's published quote, and the executor delivers 1 wei less. We assert the gap
    //     EXACTLY (not a loose tolerance), so a regression of any OTHER magnitude — a wrong split, a broken
    //     fee, a wrong bin walk — fails here. The engine measures the recipient balance delta, so `received`
    //     IS the executor's output.
    const LB_QUOTE_MINUS_EXEC_WEI = 1n; // real LB v2.2 getSwapOut(view) − swap(exec), verified fixed at 1
    assert.equal(
      onViewOut - received,
      LB_QUOTE_MINUS_EXEC_WEI,
      `executed output is exactly ${LB_QUOTE_MINUS_EXEC_WEI} wei below the pool's own getSwapOut quote (documented LB v2.2 quoter/executor discrepancy)`,
    );
    assert.equal(
      oracleDy - received,
      LB_QUOTE_MINUS_EXEC_WEI,
      "executed output is exactly 1 wei below the neutral oracle (same LB v2.2 quoter/executor discrepancy)",
    );

    const ms = Date.now() - t0;
    console.log(
      `  [lb-prod-mirror:${engine}] spent=${spent} received=${received} — spent WEI-EXACT vs oracle awarded=${awarded}; ` +
        `oracle dy=${oracleDy} == REAL getSwapOut view=${onViewOut} (wei-exact); executed=${received} = quote − 1 wei ` +
        `(documented LB v2.2 quoter/executor gap); multi-bin swap through the REAL LBPair; ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL LBPair bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
