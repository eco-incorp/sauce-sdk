/**
 * EcoSwap WOOFi (WooPPV2 sPMM v2) PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The WOOFi analogue of ecoswap.solidly.prodmirror.evm.test.ts / ecoswap.dodo.prodmirror.evm.test.ts.
 * Unlike ecoswap.woofi.evm.test.ts (which deploys a MOCK WooFiPool.sol fixture), this test stands up the
 * GENUINE Arbitrum WooPPV2 sPMM bytecode captured from mainnet and runs the swap against it — proving the
 * production discovery + execution path works on the real contract, with NO fork and NO RPC at run time
 * (etch + setStorageAt, seconds).
 *
 * MECHANISM (mirrors the repo's V4 real-runtime etch, generalised in harness/etch-pool.ts → etchWooFiPool):
 *   CAPTURE (one-time, harness/woofi-snapshot.ts, uses the RPC key):
 *     the deepest real on-charter stable pair the wired FactoryType.WOOFi discovery reaches — the Arbitrum
 *     USDT→USDC leg of the WooPPV2 singleton 0x5520…9FA4 (an EIP-1967 transparent proxy) — is captured with
 *     the REAL runtime (eth_getCode) of EVERY contract the swap/quote touches: the WooPPV2 proxy AND its
 *     EIP-1967 impl, the SEPARATE WooracleV2 price feed, and the TWO Chainlink CL feed proxies (all
 *     sha256-anchored). The swap-relevant STATE goes to .state.json: pool tokenInfos(base+quote), the
 *     WooracleV2 sPMM inputs (price/spread/coeff/woFeasible) + its staleness/bound/PriceRange gate slots +
 *     the two CL rounds. Block + block.timestamp pinned. No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); pin block.timestamp to the capture ts (state()
 *     gates the WO price on block.timestamp ≤ oracle.timestamp + staleDuration); etch the REAL impl + proxy
 *     + WooracleV2 at their captured addresses with setStorageAt of the captured state VERBATIM; etch a
 *     local MintableERC20 AT EACH REAL token address (USDT + USDC) — the pool's tokenInfos/oracle woState/
 *     clOracles/priceRanges are keyed by the REAL token addresses, so the tokens CANNOT be repointed by a
 *     scalar overwrite, they must LIVE at those addresses; and etch a tiny read-only CL SHIM at each CL feed
 *     address replaying its captured latestRoundData (the real CL runtimes are aggregator proxies delegating
 *     to uncaptured aggregators — a shim is the only faithful offline stand-in). The swap then runs the
 *     GENUINE WooPPV2 impl + WooracleV2 bytecode: query() reads the LIVE oracle and returns the mainnet-
 *     identical toAmount, and swap() (transfer-first) pays out the quote.
 *
 * CENTRAL VERIFICATION (this file asserts all explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool + impl + WooracleV2 in the test == the captured real runtime,
 *       byte-for-byte (the sPMM math contracts — the swap-relevant code). No mock WooFiPool.sol is in the
 *       swap path (the pool/impl/oracle addresses are the captured mainnet addresses, running captured code).
 *       The REAL query() reproduces the captured probe quote to the wei, and state() reports the captured
 *       feasible sPMM inputs. The two CL feeds are etched as read-only round shims (their real runtimes
 *       delegate to uncaptured aggregators) — the state snapshot ships their sha256 anchors for the NO-RPC
 *       integrity tripwire, and this is called out HONESTLY below (it is the one non-byte-equal dependency).
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 * QUOTE-LADDER (QL). WOOFi is a QL venue now (like Curve StableSwap / CryptoSwap / Solidly): prepare ships
 * ONLY a descriptor and the on-chain solver BUILDS the price ladder in setup from LIVE tryQuery (the
 * GRACEFUL WooPPV2 quote — never reverts, this deployment returns the single toAmount). tryQuery/query are
 * self-contained in {pool, WooracleV2, CL shims} — all etched — so the QL ladder build runs OFFLINE against
 * the real bytecode; this test asserts the on-chain-built ladder matches the real pool tryQuery at every QL
 * point AND cooks the QL descriptor with ZERO prepared segments.
 *
 *   (c) WEI-EXACT — the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts optimalSplit,
 *       seeded from the REAL captured sPMM state via the SHARED buildWooFiQLLadder) == the REAL pool's own
 *       pre-swap query() view of the awarded slice, all to the wei. The off-chain query replay is proven
 *       bit-for-bit with the real tryQuery at every QL ladder point. spent == awarded is asserted explicitly.
 *
 * HONEST fee accounting (like DODO, unlike Solidly): WooPPV2 applies its swap fee to the OUTPUT (query()
 * already nets it) and RETAINS the full input — the fee accrues to the pool's `unclaimedFee` (claimed later
 * by an admin), it is NOT routed out to a separate fees contract. So the pool nets the FULL tokenIn
 * (poolIn == spent) and the fee shows up as a smaller tokenOut, exactly as the oracle's query() models it.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts are
 * absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.woofi.prodmirror.evm.test.ts
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
  etchWooFiPool,
  loadWooFiSnapshots,
  verifyWooFiBytecodeIntegrity,
  wooFiPoolReadAbi,
  wooracleV2ReadAbi,
  chainlinkFeedReadAbi,
  type EtchedWooFiPool,
  type WooFiStateSnapshot,
} from "./harness/etch-pool";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { query as wooFiQuery, buildWooFiQLLadder, type WooFiPool } from "../shared/woofi-math";

const SNAP_NAME = "arbitrum-woofi-USDTUSDC";
const ENGINE_CELLS = engineCells();

/** Round a WooPPV2 feeRate (1e5-scaled) to a ppm fee (the same rule discovery uses). */
function wooFiFeeToPpm(feeRate: bigint): number {
  return Number((feeRate * 1_000_000n + 100_000n / 2n) / 100_000n);
}

/**
 * Pin the cook block.timestamp to the captured block ts, moving BACKWARD if needed.
 * WooracleV2.state() gates the WO price on `block.timestamp ≤ oracle.timestamp + staleDuration` and cross-
 * checks the CL updatedAt windows, so the block time MUST equal the capture ts for the sPMM to be feasible.
 * anvil's genesis timestamp is the real wall clock (which, for a future-dated pin like this Arbitrum block,
 * is AFTER the capture ts), so `setNextBlockTimestamp` (which refuses to go backward) is insufficient — we
 * use `anvil_setTime` (accepts a backward jump) + a zero block-time interval so subsequent mined blocks keep
 * the pinned ts (the cook runs at exactly the capture instant).
 */
async function pinCaptureTime(c: HarnessClients, ts: bigint): Promise<void> {
  await c.testClient.request({ method: "anvil_setTime", params: [("0x" + ts.toString(16)) as Hex] } as never);
  // Keep the timestamp fixed across the setup mints + the cook (no per-block drift past the stale window).
  await c.testClient.setBlockTimestampInterval({ interval: 0 });
  await c.testClient.mine({ blocks: 1 });
}

describe("EcoSwap WOOFi (WooPPV2 sPMM) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadWooFiSnapshots(SNAP_NAME);
  const captureTs = BigInt(snaps.state.blockTimestamp);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedWooFiPool;

  // Boot a fresh anvil + pin the capture time + etch the real pool + deploy the engine. Called before each
  // cell so each engine runs in full isolation (cheap — the whole setup is etch + setStorageAt + a few deploys).
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    await pinCaptureTime(c, captureTs);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // ~2x the base reserve as caller headroom (6-decimal base; reserve ~29k USDT).
    etched = await etchWooFiPool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: BigInt(snaps.state.tokenInfos.reserve) * 2n,
    });
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a WOOFi factory (the captured WooPPV2 pool address) → the production WOOFi
   *  discovery path (discoverWooFiPoolsTyped) resolves the etched pool; the lens ignores non-V2/V3/V4
   *  factory types, so no direct pools are surfaced and the WOOFi venue rides entirely through the typed
   *  discovery + the callback-free query/transfer/swap exec block. */
  function wooFiPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.pool,
          poolType: SwapPoolType.WOOFi,
          factoryType: FactoryType.WOOFi,
          label: "Local WOOFi WooPPV2 (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  /** The neutral oracle's WooFiPool descriptor for the single reproduced WooPPV2, seeded from the REAL
   *  captured sPMM state. tokenIn == base (sellBase → quote). query() nets the swap fee, so this replays the
   *  pool's own query() bit-for-bit at the snapshot oracle. */
  function offPool(state: WooFiStateSnapshot): WooFiPool {
    const priceDec = 10n ** BigInt(state.oracle.priceDecimals);
    const dec = 10n ** BigInt(state.decimalsIn); // base + quote are both 6-dec here
    return {
      address: etched.pool,
      tokenIn: etched.tokenIn,
      tokenOut: etched.tokenOut,
      sellBase: true, // tokenIn == base
      price: BigInt(state.oracle.price),
      spread: BigInt(state.oracle.spread),
      coeff: BigInt(state.oracle.coeff),
      priceDec,
      quoteDec: 10n ** BigInt(state.decimalsOut),
      baseDec: dec,
      feeRate: BigInt(state.tokenInfos.feeRate),
      maxNotionalSwap: BigInt(state.tokenInfos.maxNotionalSwap),
      maxGamma: BigInt(state.tokenInfos.maxGamma),
      feePpm: wooFiFeeToPpm(BigInt(state.tokenInfos.feeRate)),
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL WooPPV2 sPMM bytecode (byte-equal) + reconstructs the captured oracle state", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime blobs (pool proxy + impl + WooracleV2 +
    // both CL feeds) still hash to the sha256 anchors recorded at capture time. A reviewer without the RPC
    // key can run this — it proves the snapshot wasn't silently altered/truncated after capture, with NO RPC.
    const integ = verifyWooFiBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pool runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(integ.implementation.ok, `impl runtime sha256 matches the capture anchor (got ${integ.implementation.actual})`);
    for (const d of integ.dependencies) {
      assert.ok(d.ok, `${d.name} runtime sha256 matches the capture anchor (got ${d.actual})`);
    }
    assert.ok(snaps.bytecode.pool.runtimeSha256, "pool snapshot carries a sha256 integrity anchor");
    assert.ok(snaps.bytecode.implementation.runtimeSha256, "impl snapshot carries a sha256 integrity anchor");
    assert.ok(snaps.bytecode.dependencies.wooracle.runtimeSha256, "WooracleV2 snapshot carries a sha256 anchor");

    // getCode at the pool + impl + WooracleV2 must EQUAL the captured real runtime (no mock in the path).
    // These are the sPMM math contracts — the swap-relevant code. (The two CL feeds are etched as read-only
    // round shims — see the HONEST note below — so byte-equality is asserted for pool/impl/oracle only.)
    const [poolCode, implCode, oracleCode] = await Promise.all([
      c.publicClient.getCode({ address: etched.pool }),
      c.publicClient.getCode({ address: etched.impl }),
      c.publicClient.getCode({ address: etched.wooracle }),
    ]);
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pool.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL WooPPV2 proxy runtime (byte-equal)",
    );
    assert.ok(implCode, "impl has code");
    assert.equal(
      implCode!.toLowerCase(),
      snaps.bytecode.implementation.runtime.toLowerCase(),
      "eth_getCode at the impl == the captured REAL WooPPV2 sPMM implementation runtime (byte-equal)",
    );
    assert.ok(oracleCode, "WooracleV2 has code");
    assert.equal(
      oracleCode!.toLowerCase(),
      snaps.bytecode.dependencies.wooracle.runtime.toLowerCase(),
      "eth_getCode at the WooracleV2 == the captured REAL WooracleV2 runtime (byte-equal)",
    );
    // The pool/impl/oracle addresses are the CAPTURED mainnet addresses — no locally-compiled mock.
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.address.toLowerCase(), "pool at captured mainnet address");
    assert.equal(etched.impl.toLowerCase(), snaps.bytecode.implementation.address.toLowerCase(), "impl at captured mainnet address");
    assert.equal(etched.wooracle.toLowerCase(), snaps.bytecode.dependencies.wooracle.address.toLowerCase(), "WooracleV2 at captured mainnet address");

    // The REAL code reads the reconstructed state correctly.
    const [qt, wo, tiBase] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: wooFiPoolReadAbi, functionName: "quoteToken" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: wooFiPoolReadAbi, functionName: "wooracle" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: wooFiPoolReadAbi, functionName: "tokenInfos", args: [etched.base] }) as Promise<readonly [bigint, bigint, bigint, bigint]>,
    ]);
    assert.equal(qt.toLowerCase(), etched.quote.toLowerCase(), "quoteToken == the (local, real-address) quote token");
    assert.equal(wo.toLowerCase(), etched.wooracle.toLowerCase(), "wooracle points at the etched WooracleV2");
    assert.equal(BigInt(tiBase[0]), etched.reserve, "tokenInfos(base).reserve == captured");
    assert.equal(BigInt(tiBase[1]), etched.feeRate, "tokenInfos(base).feeRate == captured");

    // WooracleV2.state(base) reports the captured feasible sPMM inputs (gated by the pinned ts + CL shims +
    // the reconstructed guardian PriceRange). This is the REAL oracle contract computing off the CL shims.
    const st = (await c.publicClient.readContract({
      address: etched.wooracle, abi: wooracleV2ReadAbi, functionName: "state", args: [etched.base],
    })) as readonly [bigint, bigint, bigint, boolean];
    assert.equal(st[0], etched.price, "state price == captured");
    assert.equal(st[1], etched.spread, "state spread == captured");
    assert.equal(st[2], etched.coeff, "state coeff == captured");
    assert.equal(st[3], true, "state woFeasible == true (the gated sPMM is live at the pinned ts)");

    // Each CL shim replays the captured latestRoundData (the deterministic values state() gated on).
    for (const cl of [snaps.state.clOracles.base, snaps.state.clOracles.quote]) {
      const lrd = (await c.publicClient.readContract({
        address: cl.feed, abi: chainlinkFeedReadAbi, functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      assert.equal(lrd[1], BigInt(cl.latestRoundData.answer), `CL[${cl.feed}] shim answer == captured`);
      assert.equal(lrd[3], BigInt(cl.latestRoundData.updatedAt), `CL[${cl.feed}] shim updatedAt == captured`);
    }

    // The REAL query() computes the mainnet-identical toAmount for the captured probe (real sPMM integral,
    // real reserves, real oracle) — the strongest single-shot proof the etched code IS the mainnet code.
    const dy = (await c.publicClient.readContract({
      address: etched.pool, abi: wooFiPoolReadAbi, functionName: "query",
      args: [etched.base, etched.quote, BigInt(snaps.state.probe.fromAmount)],
    })) as bigint;
    assert.equal(
      dy.toString(),
      snaps.state.probe.toAmount,
      "REAL query(probe) == the captured mainnet value (real code, real oracle, real reserves)",
    );

    console.log(
      `  [woofi-prod-mirror] REAL bytecode etched: pool ${etched.pool} (proxy ${(poolCode!.length - 2) / 2} B) ` +
        `-> impl ${etched.impl} (${(implCode!.length - 2) / 2} B); WooracleV2 ${etched.wooracle} ` +
        `(${(oracleCode!.length - 2) / 2} B); captured block ${snaps.state.block} ts ${captureTs}; ` +
        `reserve ${etched.reserve}; price ${etched.price} feeRate ${etched.feeRate}. ` +
        `CL feeds etched as read-only round shims (real runtimes delegate to uncaptured aggregators).`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Sell base → quote (the captured probe direction): tokenIn = base (USDT), tokenOut = quote (USDC).
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    const feePpm = wooFiFeeToPpm(etched.feeRate);

    // A meaningful stable trade: ~5% of the base reserve — well within both caps (maxNotionalSwap 1e12,
    // maxGamma 5e14), so the WOOFi ladder covers [0, amountIn] and the whole trade allocates to this single
    // venue (single-venue full-fill, asserted below).
    const amountIn = etched.reserve / 20n;
    const poolConfig = wooFiPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // Run EcoSwap through the PRODUCTION FactoryType.WOOFi discovery path.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced WOOFi venue (via the real getters).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (WOOFi-only config)");
    assert.equal((prepared.wooFiPools ?? []).length, 1, "discovered exactly the 1 reproduced WOOFi venue");
    assert.equal(
      prepared.wooFiPools![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered WOOFi venue is the REAL etched pool",
    );
    assert.equal(
      prepared.wooFiPools![0].fromToken.toLowerCase(),
      tokenIn.toLowerCase(),
      "discovery oriented the venue fromToken == tokenIn (== base, sellBase)",
    );
    // WOOFi is a QUOTE-LADDER (QL) venue now: prepare ships ONLY a descriptor, NO sampled segments (the
    // on-chain solver builds the ladder live from tryQuery). Assert the stream is empty.
    assert.equal(
      (prepared.brackets ?? []).length,
      0,
      "WOOFi QL ships NO sampled segments (descriptor-only, ladder built on-chain)",
    );

    // PRODUCTION QL LADDER, unmasked: buildWooFiQLLadder replays the descriptor off-chain (no RPC) — the
    // SAME geometric quote ladder the on-chain solver builds in setup from live tryQuery. This is what the
    // neutral oracle consumes, so the split is wei-exact vs the solver by construction (descriptor only).
    const op = offPool(snaps.state);
    const ladder = buildWooFiQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "production QL ladder is non-empty");

    // LADDER PARITY — the core gate: at EVERY cumulative QL ladder point the off-chain replay (query on the
    // captured sPMM state) == the REAL etched WooPPV2's OWN pre-swap tryQuery view (the GRACEFUL quote the
    // solver's qlv loop reads — this deployment returns the single toAmount) reading the REAL WooracleV2, to
    // the WEI. These are the EXACT points the on-chain qlv loop quotes, so this pins the whole QL quote path
    // (the _calc* sPMM integral + the output fee) against the genuine deployed bytecode. (Read BEFORE the
    // cook — the sell mutates the reserves.) The off-chain `query` MODELS WooPPV2's notionalSwap/maxGamma
    // caps (via wooFiInputCap, seeded from the captured tokenInfos), returning 0 past a cap — the SAME point
    // the real tryQuery self-truncates — so this equality holds even if a recapture/resize pushes a cum past
    // a cap (both sides 0), not only for the within-cap sizing used here.
    let cum = 0n;
    let cumOut = 0n;
    for (const s of ladder) {
      cum += s.capacity;
      cumOut += s.effOut;
      const offChain = wooFiQuery(op, cum);
      const onChain = (await c.publicClient.readContract({
        address: etched.pool, abi: wooFiPoolReadAbi, functionName: "tryQuery", args: [tokenIn, tokenOut, cum],
      })) as bigint;
      assert.equal(offChain, onChain, `QL ladder parity at cum=${cum}: query == REAL tryQuery (wei-exact)`);
      assert.equal(cumOut, offChain, `QL ladder partition at cum=${cum}: Σ effOut == query(cum)`);
    }

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one WOOFi venue seeded from the REAL captured sPMM state via the
    // SHARED buildWooFiQLLadder. Pure off-chain math (computed BEFORE the cook), so the awarded Σ is known
    // ahead — and the on-chain-built ladder is the IDENTICAL grid, so on-chain spent == oracle.totalInput
    // to the wei.
    const optPools: OptimalPool[] = [{ woofi: op, feePpm } as OptimalPool];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced WOOFi venue");

    // The REAL pool's OWN PRE-swap query() view for the KNOWN awarded Σ — the engine-independent ground
    // truth for the executed dy of the awarded slice, read on the pre-swap state (the sell mutates reserves).
    // This is the REAL Solidity sPMM curve reading the REAL oracle, NOT the off-chain replay.
    const onViewPre = (await c.publicClient.readContract({
      address: etched.pool, abi: wooFiPoolReadAbi, functionName: "query", args: [tokenIn, tokenOut, awarded],
    })) as bigint;

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, etched.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL WooPPV2 bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, etched.pool)) - poolInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // HONEST fee accounting: WooPPV2 applies its swap fee to the OUTPUT (query() already nets it) and RETAINS
    // the full input — the fee accrues to the pool's `unclaimedFee` (an admin claims it later), it is NOT
    // routed out to a separate fees contract. So the pool receives the FULL tokenIn (contrast Solidly, which
    // routes the input fee to a separate PoolFees contract). Assert the pool netted exactly what was spent.
    assert.equal(poolIn, spent, "REAL WooPPV2 netted the FULL input (fee is taken on the output as unclaimedFee, not the input)");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI. NO tolerance. The QL ladder
    // covers [0, amountIn] (QL_SEED_DIV=16 forces the clamp on the final slice for a convex sPMM curve), so
    // the single venue absorbs the whole trade. The on-chain-built ladder is the IDENTICAL grid the oracle
    // awarded (proven at every point above), so spent == awarded == oracle.totalInput == amountIn.
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact)");
    // SINGLE-VENUE FULL-FILL: the ~5%-of-reserve sizing keeps the ladder within [0, amountIn] and well
    // within the pool caps, so the whole trade allocates to the one WOOFi venue. Assert it EXPLICITLY (a
    // regression that under-fills or splits fails here, not silently). Unlike the pre-QL sampled-segment
    // path (which dropped a near-saturation tail), the QL ladder covers the full amountIn.
    assert.equal(spent, amountIn, "single-venue full-fill: spent == amountIn (no unspent wei, no split)");

    // The caller-received tokenOut == query(spent) (the oracle's realized dy for the awarded Σ) == the REAL
    // pool's OWN pre-swap query(awarded Σ) view, all to the WEI. NO tolerance. The three-way agreement (TS
    // oracle replay == real Solidity query view == executed swap), for exactly the awarded Σ the solver spent,
    // ties the executed output to the real pool's own sPMM curve reading the real oracle.
    assert.equal(received, wooFiQuery(op, spent), "received == neutral-oracle query(spent) (wei-exact-in-dy)");
    assert.equal(received, onViewPre, "received == REAL pool pre-swap query(awarded Σ) (exact-in-dy)");

    const ms = Date.now() - t0;
    console.log(
      `  [woofi-prod-mirror:${engine}] WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, query=${wooFiQuery(op, spent)}, realView=${onViewPre}, amountIn=${amountIn}); ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL WooPPV2 bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
