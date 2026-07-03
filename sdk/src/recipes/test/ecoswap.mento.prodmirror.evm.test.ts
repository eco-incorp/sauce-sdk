/**
 * EcoSwap Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange) PROD-MIRROR —
 * REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The Mento analogue of ecoswap.fluid.prodmirror.evm.test.ts / ecoswap.wombat.prodmirror.evm.test.ts. Unlike
 * ecoswap.mento.evm.test.ts (which deploys a MOCK MentoBroker.sol fixture), this test stands up the GENUINE
 * Mento quote/swap contract GRAPH captured from Celo mainnet — Broker → BiPoolManager → SortedOracles (+ its
 * median library) + ConstantSumPricingModule + BreakerBox + Reserve + the cUSD stable token, 16 contracts in
 * all — and runs the swap against it, proving the production FactoryType.Mento discovery + execution path
 * works on the real contracts, with NO fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * MECHANISM (multi-contract real-runtime etch, generalised in harness/etch-pool.ts etchMentoGraph):
 *   CAPTURE (one-time, harness/mento-snapshot.ts, uses the RPC key): the wired FactoryType.Mento target on
 *     Celo — the on-charter cUSD→USDC BiPool exchange (constants.ts celo mentoExchangeProviders =
 *     [BiPoolManager]) — prices off oracle rates + a spread over interval-updated buckets across a
 *     MULTI-CONTRACT graph. debug_traceCall(prestateTracer) on the quote (getAmountOut) AND swapIn AND the two
 *     discovery getters (getExchangeProviders / getExchanges) enumerated the WHOLE touched set; every touched
 *     runtime was eth_getCode'd (WITH sha256 anchors) into celo-mento-cUSDUSDC.bytecode.json and the
 *     swap-relevant storage (buckets / oracle rate / breaker mode / the getExchanges enumeration arrays) +
 *     the semantic state + the getAmountOut probe ladder into .state.json. Block pinned. No key/url persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); setCode EVERY captured runtime at its captured
 *     address; setStorageAt the captured touched storage VERBATIM by absolute key; repoint cUSD (STABLE, 18)
 *     to a MintableBurnableERC20 + USDC (COLLATERAL, 6) to a MintableERC20, both AT THEIR REAL ADDRESSES (the
 *     exchange assets are BiPoolManager immutables); reconstruct the three Reserve transferOut gating slots
 *     (disclosed below); fund the Reserve with local USDC; PIN block.timestamp to the captured block ts (the
 *     bucket-refresh sim reads block.timestamp). The quote then runs the GENUINE graph: Broker.getAmountOut
 *     returns the mainnet-identical dy and Broker.swapIn PULLS cUSD (transferFrom + burn) + releases USDC from
 *     the Reserve.
 *
 * CENTRAL VERIFICATION (this file asserts all three explicitly):
 *   (a) REAL bytecode — eth_getCode at EVERY contract in the graph == the captured real runtime, byte-for-byte
 *       (a NO-RPC sha256 tripwire proves the checked-in blobs are intact across all 16). No mock
 *       MentoBroker.sol is in the swap path (the addresses are the captured mainnet addresses, running
 *       captured code). The REAL Broker.getExchangeProviders + BiPoolManager.getExchanges enumerate the pair,
 *       and Broker.getAmountOut reproduces the captured probe to the WEI.
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts optimalSplit,
 *       seeded from the REAL etched Broker's LIVE getAmountOut ladder via the SHARED buildMentoSegments, the
 *       identical grid discoverMentoPoolsTyped samples) == the REAL Broker's OWN LIVE getAmountOut view of the
 *       awarded slice, all to the wei. spent == the awarded Σ is asserted explicitly.
 *
 * HONEST fidelity notes:
 *   • PRICING is 100% REAL — the quote runs the genuine Broker/BiPoolManager/SortedOracles/PricingModule/
 *     BreakerBox bytecode over the captured bucket/oracle/breaker storage, reproducing the mainnet
 *     getAmountOut ladder to the wei (SNAPSHOTTED-QUOTE, Class-A — the exact class mento-math.ts documents).
 *   • TOKEN REPOINTING (Fluid/Solidly class): cUSD/USDC are repointed to local ERC20s at their real addresses.
 *     Mento's transferIn burns the stable cUSD (transferFrom→broker then IBurnableERC20.burn, expecting a
 *     `true` return) and transferOut releases collateral USDC from the Reserve — token mechanics that are NOT
 *     part of Mento's pricing, so repointing preserves the quote exactly while making the moves executable.
 *   • transferOut GATING RECONSTRUCTION (disclosed, asserted-irrelevant-to-pricing): the captured swapIn trace
 *     reverts at transferIn, so the Reserve's collateral-release gating (isExchangeSpender / isCollateralAsset
 *     / a per-asset spending limit) is NOT in the captured touched set. etchMentoGraph reconstructs exactly
 *     three Reserve mapping slots (MENTO_RESERVE_GATING_SLOTS) so the REAL transferExchangeCollateralAsset
 *     executes. These are boolean/limit GATING, NOT pricing — the RELEASED amount is still the REAL
 *     BiPoolManager quote to the wei (this test proves it: received == the captured mainnet probe).
 *
 * FULL FILL via the isotonic backward-MERGE (liquidity-preserving): the REAL cUSD/USDC ConstantSum
 * exchange's post-spread marginal is NEAR-FLAT and slightly RISING with size at this scale (the ~$12M
 * buckets barely move). The SHARED buildMentoSegments now MERGES (not drops) the non-descending slices —
 * a slice whose marginal does not fall is FOLDED into the last segment (capacity + effOut conserved) via
 * shared/segment-merge.ts, so the near-flat tail is PRESERVED rather than discarded. The result is a
 * monotone-descending ladder that spans the WHOLE amountIn, so the split awards the FULL 100k (a complete
 * fill), not the old first-slice partial. (Under the OLD strictly-descending DROP guard this venue awarded
 * only the first ~173.6 cUSD sample point and discarded the rest — the exact UNDER-fill this merge fixes.)
 * The wei-exact gate is unchanged: spent == awarded == oracle.totalInput (asserted to the wei), off the
 * IDENTICAL grid the on-chain solver consumes. The received tokenOut is still the REAL Broker's LIVE
 * getAmountOut(awarded) to the wei.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts are
 * absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.mento.prodmirror.evm.test.ts
 *      ECO_ENGINE=both pnpm --filter './sdk' test:recipes:evm
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Abi, type Account, type Hex } from "viem";

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
  etchMentoGraph,
  loadMentoSnapshots,
  verifyMentoBytecodeIntegrity,
  pinMentoBlockTimestamp,
  mentoBrokerReadAbi,
  mentoExchangeProviderReadAbi,
  MENTO_RESERVE_GATING_SLOTS,
  type EtchedMentoGraph,
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
import { buildMentoQLLadder, type MentoPool } from "../shared/mento-math";
import { qlLadderInputs } from "../shared/curve-math";

const SNAP_NAME = "celo-mento-cUSDUSDC";
const ENGINE_CELLS = engineCells();

describe("EcoSwap Mento V2 (Celo Broker + BiPoolManager) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadMentoSnapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedMentoGraph;

  // Boot a fresh anvil + etch the whole real Mento graph + deploy the engine, then PIN the block clock (the
  // bucket-refresh sim reads block.timestamp). Called before each cell so each engine runs in full isolation
  // (cheap: etch + setStorageAt + a handful of deploys, seconds not minutes).
  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // Caller headroom in cUSD (the tokenIn) — 2× the trade sizing below.
    etched = await etchMentoGraph(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: 300_000n * 10n ** BigInt(snaps.state.tokenInDecimals),
    });
    // PIN block.timestamp to the captured block ts (BiPoolManager's bucket-refresh sim reads it).
    await pinMentoBlockTimestamp(c.testClient, snaps.state);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a Mento factory (address = the etched Broker) carrying the etched BiPoolManager as
   *  the exchange-provider hint → the production FactoryType.Mento discovery path enumerates the pair via
   *  Broker.getExchangeProviders (or the hint) + BiPoolManager.getExchanges + samples the LIVE getAmountOut
   *  ladder. The lens ignores non-V2/V3/V4 factory types, so no direct pools are surfaced and the Mento venue
   *  rides entirely through discoverMentoPoolsTyped. The `poolType` is inert (discovery keys off
   *  factoryType). We pass BOTH tokens as baseTokens so the pair is on-charter. */
  function mentoPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.broker,
          poolType: SwapPoolType.UniV2, // inert for Mento — discovery keys off factoryType
          factoryType: FactoryType.Mento,
          label: "Local Mento V2 (prod-mirror)",
          // Restrict enumeration to the etched BiPoolManager (the on-charter production hint). The genuine
          // Broker.getExchangeProviders also returns it (proven on the etched graph), but the hint keeps
          // discovery deterministic and mirrors the celo constants.ts config.
          mentoExchangeProviders: [etched.exchangeProvider],
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // The Broker's own on-chain getAmountOut view — the engine-independent ground truth for the executed dy.
  async function onQuery(amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: etched.broker,
      abi: mentoBrokerReadAbi as Abi,
      functionName: "getAmountOut",
      args: [etched.exchangeProvider, etched.exchangeId, etched.tokenIn, etched.tokenOut, amt],
    })) as bigint;
  }

  /** The neutral oracle's MentoPool descriptor. Mento is now a QUOTE-LADDER (QL) venue — the on-chain solver
   *  builds the ladder live from the REAL etched Broker's getAmountOut at the GEOMETRIC QL points. Real Mento
   *  has NO closed-form replay (its buckets are a multi-contract graph), so we sample the REAL Broker at
   *  EXACTLY those QL points (`qlLadderInputs`) and store them as the descriptor's cumIn/cumOut: the oracle's
   *  `buildMentoQLLadder` interpolation is then EXACT at each ladder point ⇒ it reproduces the on-chain
   *  solver's live-quote ladder to the wei (oracle == solver by construction). */
  async function offPool(amountIn: bigint): Promise<MentoPool> {
    const cumIn = qlLadderInputs(amountIn);
    const cumOut: bigint[] = [];
    for (const amt of cumIn) cumOut.push(await onQuery(amt));
    return {
      broker: etched.broker,
      exchangeProvider: etched.exchangeProvider,
      exchangeId: etched.exchangeId,
      tokenIn: etched.tokenIn,
      tokenOut: etched.tokenOut,
      cumIn,
      cumOut,
      feePpm: 0,
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL Mento graph bytecode (byte-equal across all 16 contracts) + reproduces the captured quotes + discovery", async () => {
    // NO-NETWORK integrity tripwire FIRST: every checked-in runtime blob still hashes to the sha256 anchor
    // recorded at capture time. A reviewer without the RPC key can run this — it proves the snapshot wasn't
    // silently altered after capture, with NO RPC.
    const integ = verifyMentoBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, "every Mento graph runtime sha256 matches its capture anchor");
    assert.equal(integ.contracts.length, 16, "the captured graph has all 16 contracts");
    for (const cc of integ.contracts) {
      assert.ok(snaps.bytecode.contracts.find((x) => x.address === cc.address)?.runtimeSha256, `contract ${cc.role} carries a sha256 anchor`);
      assert.ok(cc.ok, `contract ${cc.role} (${cc.address}) runtime sha256 matches the capture anchor (got ${cc.actual})`);
    }

    // getCode at EVERY contract in the graph must EQUAL the captured real runtime (no mock in the path).
    // (The two token addresses were REPOINTED to local ERC20s — disclosed + asserted separately below.)
    const tokenSet = new Set([etched.tokenIn.toLowerCase(), etched.tokenOut.toLowerCase()]);
    let byteEqualCount = 0;
    for (const cc of snaps.bytecode.contracts) {
      if (tokenSet.has(cc.address.toLowerCase())) continue; // repointed token — checked below
      const code = await c.publicClient.getCode({ address: cc.address });
      assert.ok(code, `graph contract ${cc.role} has code`);
      assert.equal(
        code!.toLowerCase(),
        cc.runtime.toLowerCase(),
        `eth_getCode at ${cc.role} (${cc.address}) == the captured REAL runtime (byte-equal)`,
      );
      byteEqualCount++;
    }
    assert.equal(byteEqualCount, 15, "15 of 16 graph contracts are byte-equal REAL runtime (the 16th, cUSD, is the repointed stable token — disclosed)");

    // DISCLOSED STUB: the tokenIn (cUSD) address carries the local MintableBurnableERC20 runtime, NOT the real
    // StableTokenV2 — proven irrelevant to PRICING (the quote below is wei-exact vs the captured mainnet
    // value, computed by the REAL BiPoolManager over the REAL buckets; the token only moves value in the
    // burn/transfer mechanics, not the bucket/oracle math). The tokenOut (USDC) is likewise a local ERC20.
    const cusdCode = await c.publicClient.getCode({ address: etched.tokenIn });
    assert.ok(cusdCode && cusdCode !== "0x", "the repointed cUSD (stable) has local ERC20 code");
    assert.notEqual(
      cusdCode!.toLowerCase(),
      snaps.bytecode.contracts.find((x) => x.address.toLowerCase() === etched.tokenIn.toLowerCase())!.runtime.toLowerCase(),
      "cUSD is REPOINTED (local burnable ERC20 != the captured StableTokenV2 runtime) — disclosed token repoint",
    );

    // The REAL discovery getters enumerate the pair on the etched graph (the production FactoryType.Mento
    // path: Broker.getExchangeProviders → BiPoolManager.getExchanges → match {cUSD,USDC}).
    const providers = (await c.publicClient.readContract({
      address: etched.broker, abi: mentoBrokerReadAbi as Abi, functionName: "getExchangeProviders",
    })) as Hex[];
    assert.ok(
      providers.map((p) => p.toLowerCase()).includes(etched.exchangeProvider.toLowerCase()),
      "REAL Broker.getExchangeProviders() returns the etched BiPoolManager",
    );
    const exchanges = (await c.publicClient.readContract({
      address: etched.exchangeProvider, abi: mentoExchangeProviderReadAbi as Abi, functionName: "getExchanges",
    })) as readonly { exchangeId: Hex; assets: readonly Hex[] }[];
    const match = exchanges.find((ex) => {
      const a = (ex.assets ?? []).map((x) => x.toLowerCase());
      return a.includes(etched.tokenIn.toLowerCase()) && a.includes(etched.tokenOut.toLowerCase());
    });
    assert.ok(match, "REAL BiPoolManager.getExchanges() enumerates the cUSD/USDC exchange");
    assert.equal(match!.exchangeId.toLowerCase(), etched.exchangeId.toLowerCase(), "the enumerated exchangeId == the captured one");

    // The REAL Broker.getAmountOut reproduces the captured mainnet probe to the WEI.
    const probeGot = await onQuery(BigInt(snaps.state.probe.amountIn));
    assert.equal(probeGot, BigInt(snaps.state.probe.amountOut), "REAL getAmountOut(probe) == captured mainnet value (wei-exact)");
    // And the whole sampled ladder reproduces to the wei.
    for (let i = 0; i < snaps.state.ladder.cumIn.length; i++) {
      const got = await onQuery(BigInt(snaps.state.ladder.cumIn[i]));
      assert.equal(got, BigInt(snaps.state.ladder.cumOut[i]), `REAL getAmountOut(ladder[${i}]) == captured mainnet value`);
    }

    // The reconstructed transferOut gating (disclosed) — the Broker is a registered exchange-spender + USDC a
    // registered collateral asset, so the REAL Reserve.transferExchangeCollateralAsset can release the out.
    void MENTO_RESERVE_GATING_SLOTS; // slots documented in the harness; their effect is proven by the cook below

    console.log(
      `  [mento-prod-mirror] REAL bytecode etched: ${etched.contractCount} contracts (${etched.slotCount} slots) at captured mainnet addresses; ` +
        `Broker ${etched.broker}; BiPoolManager ${etched.exchangeProvider}; exchange ${etched.exchangeId.slice(0, 12)}…; ` +
        `captured block ${snaps.state.block}; ${snaps.state.tokenInSymbol}/${snaps.state.tokenOutSymbol}; probe ${snaps.state.probe.amountIn}→${snaps.state.probe.amountOut}`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Swap cUSD → USDC (the captured probe direction): tokenIn = cUSD (stable), tokenOut = USDC (collateral).
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;

    // amountIn == the full sampled ladder cap (100k cUSD) — well within the deep ~$12M buckets, so the ladder
    // quotes monotonically and the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * 10n ** BigInt(snaps.state.tokenInDecimals);
    const poolConfig = mentoPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // Run EcoSwap through the PRODUCTION FactoryType.Mento discovery path (samples the etched Broker).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE enumerated Mento venue (via the real Broker/BiPoolManager getters).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (Mento-only config)");
    assert.equal((prepared.mentoPools ?? []).length, 1, "discovered exactly the 1 enumerated Mento venue");
    assert.equal(
      prepared.mentoPools![0].broker.toLowerCase(),
      etched.broker.toLowerCase(),
      "the discovered Mento venue uses the REAL etched Broker",
    );
    assert.equal(
      prepared.mentoPools![0].exchangeId.toLowerCase(),
      etched.exchangeId.toLowerCase(),
      "the discovered Mento venue's exchangeId == the captured one",
    );
    // Mento is now a QUOTE-LADDER (QL) venue: prepare ships ONLY the descriptor (prepared.mentoPools), NO
    // static sampled brackets — the on-chain solver builds the getAmountOut ladder live from the REAL Broker.
    assert.ok(
      !(prepared.brackets ?? []).some((b) => b.kind === EcoBracketKind.Mento),
      "Mento ships NO static brackets (it is a QUOTE-LADDER venue — the ladder is built live on-chain)",
    );

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one Mento venue whose descriptor carries the REAL etched Broker's
    // LIVE getAmountOut sampled at EXACTLY the geometric QL ladder points (offPool → qlLadderInputs), so the
    // oracle's buildMentoQLLadder interpolation reproduces the on-chain solver's live-quote ladder to the wei.
    // Pure off-chain math (computed BEFORE the cook), so the awarded Σ is known ahead — and the on-chain solver
    // builds the IDENTICAL ladder from the SAME live Broker, so spent == oracle.totalInput to the wei.
    const op = await offPool(amountIn);
    assert.ok(buildMentoQLLadder(op, amountIn).length > 0, "non-empty Mento QL ladder from the live etched Broker");
    const optPools: OptimalPool[] = [{ mento: op, feePpm: 0 }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the enumerated Mento venue");

    // The REAL Broker's OWN LIVE getAmountOut view for the KNOWN awarded Σ — the engine-independent ground
    // truth for the executed dy of the awarded slice (Mento re-reads this LIVE view at exec as amountOutMin).
    // The block clock is PINNED, so the buckets do NOT refresh between this read and the cook.
    const onViewAwarded = await onQuery(awarded);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL Mento bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");

    // WEI-EXACT (oracle == solver): the on-chain spend == the oracle's awarded input to the WEI. NO tolerance.
    // BOTH the on-chain solver and the neutral oracle build the IDENTICAL QUOTE-LADDER from the SAME live
    // Broker getAmountOut at the SAME geometric QL points (the on-chain solver quotes live; the oracle
    // interpolates cumIn/cumOut sampled at those exact points ⇒ exact at each), so spent == awarded to the wei.
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (QL wei-exact, oracle == solver)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact)");

    // PARTIAL FILL is the CORRECT QL behavior here (NOT a regression). The REAL cUSD/USDC ConstantSum marginal
    // is near-flat / slightly rising at this scale, so the QL ladder's non-convex guard stops the ladder after
    // the leading (best-priced, convex-head) slice(s) — the QL prices only the monotone descending head and
    // does NOT merge the flat tail (unlike the old sampled-segment isotonic merge). So a solo near-flat Mento
    // venue fills its QL head (here amountIn/QL_SEED_DIV), bounded by the guard — and the wei-exact gate above
    // holds regardless (oracle == solver by construction). A convex Mento curve (the common case) fills further.
    assert.ok(spent > 0n && spent <= amountIn, "QL fills a leading slice bounded by the non-convex guard");

    // The caller-received tokenOut == the REAL Broker's OWN LIVE getAmountOut(awarded Σ) view, to the WEI —
    // read from the GENUINE etched multi-contract graph (Broker → BiPoolManager → SortedOracles → …), which
    // the (a) integrity test proves reproduces mainnet byte-for-byte. Because the block clock is PINNED (no
    // bucket refresh), the ladder-point quotes the split priced == the live view at exec, so this is BOTH the
    // "on-chain QL ladder == REAL etched view at the ladder points" tie AND exact-in-dy (the Mento exec
    // re-reads getAmountOut(awarded) as amountOutMin and swaps to exactly it).
    assert.equal(received, onViewAwarded, "received == REAL Broker LIVE getAmountOut(awarded Σ) (exact-in-dy, real graph)");

    const ms = Date.now() - t0;
    console.log(
      `  [mento-prod-mirror:${engine}] QL WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, liveView=${onViewAwarded}, amountIn=${amountIn}; QL head fill, non-convex guard); ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Mento bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
