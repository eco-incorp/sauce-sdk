/**
 * EcoSwap Maverick V2 (bin-based directional AMM, CALLBACK pool) PROD-MIRROR — REAL BYTECODE, NO FORK,
 * OFFLINE.
 *
 * The Maverick analogue of ecoswap.dodo.prodmirror.evm.test.ts. Like ecoswap.maverick.evm.test.ts (which
 * deploys a MOCK MaverickV2Pool.sol fixture) this exercises the engine `_swapMaverickV2` + callback path —
 * but against the GENUINE Maverick V2 Pool bytecode captured from BSC mainnet, with NO fork and NO RPC at
 * run time (etch + setStorageAt, seconds).
 *
 * MECHANISM (mirrors the repo's real-runtime etch, generalised in harness/etch-pool.ts):
 *   CAPTURE (one-time, harness/maverick-snapshot.ts, uses the RPC key):
 *     the DEEPEST on-charter all-stablecoin Maverick V2 pool the wired FactoryType.MaverickV2Factory
 *     discovery reaches — the BSC USDT/USDC pool 0x0843…3eEA (~$23.5k) — is a SELF-CONTAINED runtime
 *     (NOT a proxy). We eth_getCode the pool runtime AND the MaverickV2Quoter runtime (the wei-exact
 *     `calculateSwap` ground truth) into fixtures/snapshots/bsc-maverick-USDTUSDC.bytecode.json (WITH
 *     sha256 anchors), and the active-bin/tick WINDOW around the active tick (the State struct + the
 *     _ticks[int32] + _bins[uint32] raw slots — the CL-tick-window analogue for a bin AMM) into
 *     .state.json. Block pinned. No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); etch a local MintableERC20 at EACH real
 *     token address (tokenA/tokenB are IMMUTABLES in the pool bytecode — 12 occurrences each in code,
 *     ZERO in storage — so they cannot be repointed by a storage overwrite; the Wombat/WOOFi immutable-
 *     token pattern); setCode the REAL quoter + the REAL pool at their captured addresses; setStorageAt
 *     the captured bin/tick window verbatim; and stand up a tiny Maverick factory shim (lookup) at the
 *     captured factory address. The swap then runs the GENUINE pool bytecode. The engine deployed by the
 *     harness (deployStack / deployV12Stack) is the one in sdk/src/artifacts — the FIXED engine.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * REAL ENGINE-CALLBACK EXECUTION (the FIXED engine — ../sauce PR #193). The engine's `_swapMaverickV2`
 * now calls `pool.swap(recipient, params, hex"01")` with NON-EMPTY data (which selects the REAL Maverick
 * V2 Pool's CALLBACK funding branch — the pool sends output first, then re-enters our
 * `maverickV2SwapCallback(IERC20 tokenIn, uint256 amountIn, uint256 amountOut, bytes data)` to PULL the
 * input, authenticated via the transient expected-pool context), and passes a per-direction full-range
 * tickLimit (type(int32).max for tokenA-in, type(int32).min for tokenB-in — matching Maverick's own
 * router). The captured real pool runtime DOES contain the 4-arg callback selector 0x67ca7c91 (verified),
 * so against the REAL bytecode the callback fires, the input is delivered, and the swap COMPLETES. (The
 * PREVIOUS broken engine sent EMPTY data + tickLimit:0 + a wrong 3-arg callback signature, so the real
 * pool reverted PoolTokenNotSolvent — this test used to PIN that revert. The fix is now live in the
 * artifacts, so this test asserts the REAL swap through the engine callback path instead.)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * CENTRAL VERIFICATION (this file asserts all explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool + the quoter in the test == the captured real runtime,
 *       byte-for-byte, at the captured mainnet addresses. NO mock MaverickV2Pool.sol is in the path.
 *       getState/getTick/getBin reproduce the captured bin state, and the REAL quoter's calculateSwap
 *       reproduces the captured probe quotes.
 *   (b) WALK MATH == REAL QUOTER at S sizes — the on-chain segKind-8 bin-walk mirrors maverick-math.ts
 *       (getDy / buildMaverickWalkLadder) bit-for-bit, so getDy(size) == the REAL MaverickV2Quoter to the
 *       WEI at every captured probe size proves the SPLIT GRID (the live bin-walk) is wei-exact vs the real
 *       pool's bin math across multi-tick crossings, engine-independently. FAST + OFFLINE — no fork, no RPC
 *       at run time; per-engine wall-clock logged (seconds).
 *   (c) REAL ENGINE-CALLBACK SWAP, WEI-EXACT — EcoSwap through the PRODUCTION FactoryType.MaverickV2Factory
 *       discovery path surfaces the real pool + ships the descriptor-only Maverick QL venue (asserted; the
 *       on-chain segKind-8 branch WALKS the bin book live — no off-chain sampling), then
 *       COOKs through the FIXED engine `_swapMaverickV2` → the REAL pool's `maverickV2SwapCallback`. The
 *       cook SUCCEEDS; the caller receives the output and the pool pulls exactly the input via the callback.
 *       The received dy == the REAL MaverickV2Quoter's calculateSwap(awarded Σ) view BIT-FOR-BIT (real ==
 *       real, the engine-independent ground truth), == the neutral oracle's awarded input (exact-on-grid),
 *       and the awarded input == amountIn to the WEI (single venue, full fill within the reachable window).
 *       This exercises the GENUINE captured pool bytecode's callback funding branch — no mock, no pre-pay.
 *
 * HONEST fidelity notes:
 *   • OFF-CHAIN REPLAY IS WEI-EXACT: the off-chain `maverick-math.ts` getDy now reproduces the REAL pool's
 *     bin math BIT-FOR-BIT (getDy(1000 USDC) = 1000382022226308903686 == the real pool/quoter, Δ=0) —
 *     the drain input mirrors the on-chain _remainingBinInputSpaceGivenOutput (reserve-extraction), not the
 *     old yldfi/ParaSwap price-edge port that diverged ~3.3e6 wei at the ~13th significant digit. So this
 *     test pins getDy == the REAL quoter TO THE WEI (assert.equal below), the same real == real ground
 *     truth as the engine-executed dy. The SPLIT input is exact (single venue ⇒ awarded == amountIn).
 *   • ENGINE tickLimit: the FIXED engine passes a full-range per-direction tickLimit. tokenA=USDT,
 *     tokenB=USDC, activeTick=+7 ⇒ the engine-executable trade is tokenB-in (USDC→USDT, walking DOWN);
 *     discovery still gates the pool to tokenB-in. 1000 USDC is a captured probe size that FULLY consumes
 *     within a handful of ticks of the active tick (well before tick 0), so the executed dy is identical
 *     whether the engine's tickLimit is 0 or type(int32).min — verified: the REAL quoter returns the same
 *     (in, out) for both — and it is a full fill (spent == amountIn), NOT a tickLimit partial.
 *   • RESIDUAL RISK — NEGATIVE-TICK REAL-QUOTER PARITY: this captured pool has activeTick=+7 (positive),
 *     and the trade consumes above tick 0, so the REAL bytecode here NEVER exercises the negative
 *     getState()[5] decode or the negative getTick(int32) ARG encode across the sign boundary — cell (b)
 *     compares off-chain getDy vs the real quoter (both positive-tick), and the engine-exec cell (c) is a
 *     solo venue (received == quoter(awarded) holds for any split). No negative / cross-0 real Maverick
 *     pool was capturable on BSC/Base at snapshot time (the discoverable stablecoin pools sit at positive
 *     ticks). So the negative-tick correctness of the on-chain walk (the signed-int32 activeTick decode +
 *     the negative getTick ARG encode) is validated ONLY against the local-fixture ground truth in
 *     ecoswap.maverick.evm.test.ts — where the fixture's Solidity decodes int32 correctly and its own
 *     calculateSwap is the exec ground truth (including a DISTINCT-per-tick-reserve cell so a mis-indexed
 *     negative getTick read diverges the split), NOT against the REAL MaverickV2Quoter. If a negative /
 *     cross-0 real pool becomes capturable, add it here to close this gap directly.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; v12 skipped in "both" when the artifacts
 * are absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.maverick.prodmirror.evm.test.ts
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
  etchMaverickPool,
  loadMaverickSnapshots,
  verifyMaverickBytecodeIntegrity,
  maverickPoolReadAbi,
  maverickQuoterAbi,
  maverickFactoryShimAbi,
  type EtchedMaverickPool,
  type MaverickStateSnapshot,
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
import {
  getDy,
  getTickL,
  getSqrtPrice,
  tickSqrtPrices,
  maverickFeeToPpm,
  type MaverickPool,
  type MaverickTick,
} from "../shared/maverick-math";

const SNAP_NAME = "bsc-maverick-USDTUSDC";
const ENGINE_CELLS = engineCells();

describe("EcoSwap Maverick V2 (bin AMM, callback pool) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadMaverickSnapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedMaverickPool;

  // Boot a fresh anvil + etch the real pool + deploy the engine. Called before each cell so each engine
  // runs in full isolation (no shared mutable node state — cheap because the whole setup is etch +
  // setStorageAt + a handful of deploys, seconds not minutes). Mirrors the DODO prod-mirror.
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // Caller headroom in the input token (USDC / tokenB): more than any trade we run.
    etched = await etchMaverickPool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: BigInt(snaps.state.state.reserveB) * 2n,
    });
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a MaverickV2Factory factory (the shim) → the production Maverick discovery
   *  path resolves the etched pool via lookup(tokenA,tokenB,0,N); the lens ignores non-V2/V3/V4 factory
   *  types, so no direct pools are surfaced and the Maverick pool rides entirely through
   *  discoverMaverickV2PoolsTyped → the descriptor-only Maverick QL venue (the on-chain bin-walk). */
  function maverickPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.factory,
          poolType: SwapPoolType.MaverickV2,
          factoryType: FactoryType.MaverickV2Factory,
          label: "Local Maverick V2 (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  /**
   * Reconstruct the off-chain MaverickPool descriptor for the etched pool by reading its OWN live
   * getters — the IDENTICAL reads discoverMaverickV2PoolsTyped performs (tokenA / getState / tickSpacing
   * / fee(tokenAIn) / getTick over the window). Because the etched pool answers these with the mainnet-
   * identical bin state, this descriptor == the one discovery builds, so the oracle's buildMaverickSegments
   * replays the SAME grid the on-chain solver's static segments consume ⇒ exact-on-grid by construction.
   *
   * Direction: tokenIn == USDC == tokenB ⇒ tokenAIn = false (walk DOWN from activeTick=+7 toward 0).
   */
  async function offPool(tokenIn: Hex): Promise<MaverickPool> {
    const [tokenARaw, tsRaw, stateRaw] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: maverickPoolReadAbi, functionName: "tokenA" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: maverickPoolReadAbi, functionName: "tickSpacing" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: maverickPoolReadAbi, functionName: "getState" }) as Promise<{
        reserveA: bigint; reserveB: bigint; activeTick: number; protocolFeeRatioD3: number;
      }>,
    ]);
    const tokenAIn = tokenIn.toLowerCase() === tokenARaw.toLowerCase();
    const activeTick = Number(stateRaw.activeTick);
    const tickSpacing = Number(tsRaw);
    const feeWad = (await c.publicClient.readContract({
      address: etched.pool, abi: maverickPoolReadAbi, functionName: "fee", args: [tokenAIn],
    })) as bigint;

    const window = snaps.state.tickWindow.window;
    const lo = activeTick - window;
    const hi = activeTick + window;
    const ticks: MaverickTick[] = [];
    for (let t = lo; t <= hi; t++) {
      const tk = (await c.publicClient.readContract({
        address: etched.pool, abi: maverickPoolReadAbi, functionName: "getTick", args: [t],
      })) as { reserveA: bigint; reserveB: bigint };
      if (tk.reserveA === 0n && tk.reserveB === 0n) continue;
      ticks.push({ tick: t, reserveA: tk.reserveA, reserveB: tk.reserveB });
    }
    const active = ticks.find((t) => t.tick === activeTick)!;
    const { sqrtLowerPrice, sqrtUpperPrice } = tickSqrtPrices(tickSpacing, activeTick);
    const activeL = getTickL(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice);
    const poolSqrtPrice = getSqrtPrice(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice, activeL);

    return {
      poolType: SwapPoolType.MaverickV2,
      address: etched.pool,
      tokenAIn,
      activeTick,
      poolSqrtPrice,
      tickSpacing,
      fee: feeWad,
      protocolFeeD3: BigInt(stateRaw.protocolFeeRatioD3),
      ticks,
      feePpm: maverickFeeToPpm(feeWad),
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL Maverick V2 bytecode (byte-equal) + reconstructs the captured bin/tick window", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime blobs still hash to the sha256 anchors
    // recorded at capture time. A reviewer without the RPC key can run this — it proves the snapshot was
    // not silently altered after capture, with NO RPC.
    const integ = verifyMaverickBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pool runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(snaps.bytecode.pool.runtimeSha256, "pool snapshot carries a sha256 integrity anchor");
    const quoterDep = integ.dependencies.find((d) => d.name === "maverickV2Quoter");
    assert.ok(quoterDep, "MaverickV2Quoter dependency present in the bytecode snapshot");
    assert.ok(quoterDep!.ok, `quoter runtime sha256 matches the capture anchor (got ${quoterDep!.actual})`);

    // getCode at the pool + quoter must EQUAL the captured real runtime (no mock in the path).
    const poolCode = await c.publicClient.getCode({ address: etched.pool });
    const quoterCode = await c.publicClient.getCode({ address: etched.quoter });
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pool.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL Maverick V2 pool runtime (byte-equal)",
    );
    assert.ok(quoterCode, "quoter has code");
    assert.equal(
      quoterCode!.toLowerCase(),
      snaps.bytecode.dependencies![0].runtime.toLowerCase(),
      "eth_getCode at the quoter == the captured REAL MaverickV2Quoter runtime (byte-equal)",
    );
    // The pool/quoter addresses are the CAPTURED mainnet addresses — no locally-compiled mock.
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.address.toLowerCase(), "pool at captured mainnet address");
    assert.equal(etched.quoter.toLowerCase(), snaps.bytecode.dependencies![0].address.toLowerCase(), "quoter at captured mainnet address");

    // The REAL pool code reads the reconstructed State + tokens (immutables) correctly.
    const [tA, tB, ts, state] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: maverickPoolReadAbi, functionName: "tokenA" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: maverickPoolReadAbi, functionName: "tokenB" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: maverickPoolReadAbi, functionName: "tickSpacing" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: maverickPoolReadAbi, functionName: "getState" }) as Promise<{
        reserveA: bigint; reserveB: bigint; activeTick: number; binCounter: number; protocolFeeRatioD3: number;
      }>,
    ]);
    // tokenA/tokenB are IMMUTABLES baked in the bytecode — they still name the REAL captured addresses
    // (the local MintableERC20 was etched AT those addresses, so the immutable + the local token coincide).
    assert.equal(tA.toLowerCase(), etched.tokenA.toLowerCase(), "tokenA() (immutable) == the captured real tokenA address");
    assert.equal(tB.toLowerCase(), etched.tokenB.toLowerCase(), "tokenB() (immutable) == the captured real tokenB address");
    assert.equal(Number(ts), snaps.state.tickSpacing, "tickSpacing() == captured");
    assert.equal(state.reserveA, BigInt(snaps.state.state.reserveA), "State.reserveA == captured");
    assert.equal(state.reserveB, BigInt(snaps.state.state.reserveB), "State.reserveB == captured");
    assert.equal(Number(state.activeTick), snaps.state.state.activeTick, "State.activeTick == captured (+7)");
    assert.equal(Number(state.binCounter), snaps.state.state.binCounter, "State.binCounter == captured");

    // getTick/getBin reproduce EVERY captured live tick + bin bit-for-bit (the reconstructed window).
    for (const dt of snaps.state.ticks) {
      const tk = (await c.publicClient.readContract({
        address: etched.pool, abi: maverickPoolReadAbi, functionName: "getTick", args: [dt.tick],
      })) as { reserveA: bigint; reserveB: bigint; totalSupply: bigint; binIdsByTick: readonly number[] };
      assert.equal(tk.reserveA, BigInt(dt.reserveA), `tick ${dt.tick} reserveA reconstructs`);
      assert.equal(tk.reserveB, BigInt(dt.reserveB), `tick ${dt.tick} reserveB reconstructs`);
      assert.equal(tk.totalSupply, BigInt(dt.totalSupply), `tick ${dt.tick} totalSupply reconstructs`);
    }
    for (const db of snaps.state.bins) {
      const bin = (await c.publicClient.readContract({
        address: etched.pool, abi: maverickPoolReadAbi, functionName: "getBin", args: [db.binId],
      })) as { tickBalance: bigint; totalSupply: bigint; kind: number; tick: number };
      assert.equal(bin.tickBalance, BigInt(db.tickBalance), `bin ${db.binId} tickBalance reconstructs`);
      assert.equal(bin.totalSupply, BigInt(db.totalSupply), `bin ${db.binId} totalSupply reconstructs`);
      assert.equal(Number(bin.kind), db.kind, `bin ${db.binId} kind reconstructs`);
      assert.equal(Number(bin.tick), db.tick, `bin ${db.binId} tick reconstructs`);
    }

    // The REAL MaverickV2Quoter reproduces the captured probe quotes (the real bin swap math), in the
    // tokenB-in direction this fixture drives (the trade consumes before tick 0, so the full-range
    // tickLimit is immaterial here). calculateSwap is state-mutating in signature (returns via a
    // revert-free path) → simulate on the pre-swap state.
    for (const p of snaps.state.probes) {
      const sim = await c.publicClient.simulateContract({
        address: etched.quoter, abi: maverickQuoterAbi, functionName: "calculateSwap",
        args: [etched.pool, BigInt(p.amountIn), false /* tokenB-in */, false /* exactInput */, 0],
      });
      const res = sim.result as readonly [bigint, bigint, bigint];
      assert.equal(res[0], BigInt(p.amountInUsed), `REAL quoter calculateSwap(${p.amountIn}) amountIn == captured`);
      assert.equal(res[1], BigInt(p.amountOut), `REAL quoter calculateSwap(${p.amountIn}) amountOut == captured mainnet value`);
    }

    // The Maverick factory shim resolves the pool the production discovery path reads.
    const lk = (await c.publicClient.readContract({
      address: etched.factory, abi: maverickFactoryShimAbi, functionName: "lookup",
      args: [etched.tokenB, etched.tokenA, 0n, 10n],
    })) as readonly Hex[];
    assert.equal(lk.length, 1, "shim lookup returns exactly one pool");
    assert.equal(lk[0].toLowerCase(), etched.pool.toLowerCase(), "shim lookup resolves the etched pool");

    console.log(
      `  [maverick-prod-mirror] REAL bytecode etched: pool ${etched.pool} (${(poolCode!.length - 2) / 2} B) + ` +
        `quoter ${etched.quoter} (${(quoterCode!.length - 2) / 2} B); captured block ${snaps.state.block}; ` +
        `activeTick ${etched.activeTick} reserveA/B ${etched.reserveA}/${etched.reserveB}; ` +
        `feeBIn ${etched.feeBIn}; ${snaps.state.ticks.length} live ticks / ${snaps.state.bins.length} bins reconstructed`,
    );
  });

  // ── (b) WALK MATH == REAL QUOTER at S sizes — the corrected-math payoff, no cook needed. ──
  // The on-chain segKind-8 bin-walk mirrors maverick-math.ts (getDy / buildMaverickWalkLadder) BIT-FOR-BIT
  // — so proving getDy(op, size) == the REAL MaverickV2Quoter.calculateSwap(size) to the WEI at every
  // captured probe size proves the on-chain walk (which the SPLIT is built from) is wei-exact vs the real
  // pool's bin math across multi-tick crossings, engine-independently (no cook — this is the SPLIT-GRID
  // fidelity that the reference-math fix delivered; the engine-EXEC wei-exactness is (c) below).
  it("the on-chain bin-walk math (getDy) == the REAL MaverickV2Quoter at every captured probe size", async () => {
    const op = await offPool(etched.tokenB); // tokenB-in (USDC→USDT), the engine-executable direction
    for (const p of snaps.state.probes) {
      const sim = await c.publicClient.simulateContract({
        address: etched.quoter, abi: maverickQuoterAbi, functionName: "calculateSwap",
        args: [etched.pool, BigInt(p.amountIn), false, false, 0],
      });
      const [qIn, qOut] = sim.result as readonly [bigint, bigint, bigint];
      const off = getDy(op, qIn); // getDy over the input the quoter actually consumed (a full fill here)
      assert.equal(qIn, BigInt(p.amountIn), `probe ${p.amountIn} fully consumes (no tickLimit partial)`);
      assert.equal(off, qOut, `getDy(${p.amountIn}) == REAL quoter calculateSwap to the WEI (Δ=${off > qOut ? off - qOut : qOut - off})`);
    }
    console.log(`  [maverick-prod-mirror] on-chain walk math == REAL quoter WEI-EXACT at ${snaps.state.probes.length} probe sizes`);
  });

  // ── (c1) ENGINE-PATH BUG + (c2) REAL-EXECUTION WEI-EXACT — through the production discovery path. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Direction: tokenIn = USDC (tokenB), tokenOut = USDT (tokenA). activeTick=+7, so a tokenB-in swap
    // walks DOWN in tick. The FIXED engine passes full-range tickLimit (type(int32).min for tokenB-in),
    // so the swap is not capped; this trade consumes within a few ticks of the active tick regardless.
    const tokenIn = etched.tokenB; // USDC
    const tokenOut = etched.tokenA; // USDT

    // ~1000 USDC — well within the tick-7→0 reachable payout window (~8963 USDT output reserve) and one of
    // the captured probe sizes that FULLY consumes, so the awarded Σ is a full fill (awarded == amountIn).
    const amountIn = 1_000n * 10n ** BigInt(snaps.state.tokenBDecimals);
    const poolConfig = maverickPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // The off-chain descriptor from the etched pool's OWN getters (== what discovery builds).
    const op = await offPool(tokenIn);
    assert.equal(op.tokenAIn, false, "prod-mirror direction is tokenB-in (USDC→USDT), the engine-executable side");

    // Run EcoSwap through the PRODUCTION FactoryType.MaverickV2Factory discovery path (prepare + compile).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced Maverick venue (via the real getters), oriented tokenB-in.
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (Maverick-only config)");
    assert.equal((prepared.maverickPools ?? []).length, 1, "discovered exactly the 1 reproduced Maverick venue");
    assert.equal(
      prepared.maverickPools![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered Maverick venue is the REAL etched pool",
    );
    assert.equal(prepared.maverickPools![0].tokenAIn, false, "discovery oriented the venue as tokenB-in (activeTick>=0)");
    // Maverick is now a QUOTE-LADDER (QL) venue — descriptor-only (address + tokenAIn + tickSpacing), NO
    // static sampled brackets (the on-chain segKind-8 branch WALKS the bin book live). Assert the descriptor
    // carries the walk seeds and ships zero MaverickV2 brackets.
    assert.ok(prepared.maverickPools![0].tickSpacing > 0, "descriptor carries the bin-walk tickSpacing seed");
    assert.equal(
      (prepared.brackets ?? []).filter((b) => b.kind === EcoBracketKind.MaverickV2).length,
      0,
      "Maverick ships NO static brackets (it is a live bin-walk QL venue)",
    );

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one Maverick venue seeded from the REAL captured tick book via
    // the SHARED buildMaverickSegments. Pure off-chain math (computed BEFORE any execution), so the awarded
    // Σ is known ahead. Single venue ⇒ the whole amountIn is awarded to it (asserted below).
    // NOTE (scope): this is a single-venue real-engine-callback wei-exactness proof, NOT a multi-venue SPLIT
    // proof — with one venue optimalSplit trivially awards the whole amountIn, so `awarded == amountIn` holds
    // by construction, not by allocation logic. Multi-venue split behavior (marginal-price equalization across
    // pools) is covered by the multi-pool prod-mirrors (e.g. ecoswap.v2v3v4 / ecoswap.allpools). Do NOT read
    // this cell as a split test; its strength is the real-vs-real wei-exact dy anchor through the engine below.
    const optPools: OptimalPool[] = [{ maverick: op, feePpm: op.feePpm }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced Maverick venue");
    // SPLIT INPUT is exact: single venue within the reachable window ⇒ awarded == oracle.totalInput ==
    // amountIn to the WEI (no tickLimit partial; 1000 USDC is a captured full-fill probe size).
    assert.equal(awarded, oracle.totalInput, "single venue: awarded == oracle totalInput (wei-exact)");
    assert.equal(awarded, amountIn, "full fill within the reachable window (probe size fully consumes)");

    // The REAL MaverickV2Quoter's OWN calculateSwap view for the KNOWN awarded Σ — the engine-independent,
    // BIT-EXACT ground truth for the executed dy of the awarded slice, on the PRE-swap state (the real
    // Solidity bin swap math). tokenB-in, tickLimit=0 (the trade consumes before tick 0, so the tickLimit
    // is immaterial — the FIXED engine's full-range type(int32).min yields the identical (in, out)).
    // calculateSwap is state-mutating in signature → simulate.
    const quoterSim = await c.publicClient.simulateContract({
      address: etched.quoter, abi: maverickQuoterAbi, functionName: "calculateSwap",
      args: [etched.pool, awarded, false, false, 0],
    });
    const [quoterIn, quoterOut] = quoterSim.result as readonly [bigint, bigint, bigint];
    assert.equal(quoterIn, awarded, "REAL quoter consumes the full awarded input (no tickLimit partial)");
    assert.ok(quoterOut > 0n, "REAL quoter returns a positive dy for the awarded Σ");

    // ── (c) REAL ENGINE-CALLBACK SWAP, WEI-EXACT — cook the production EcoSwap through the FIXED engine. ──
    // The engine `_swapMaverickV2` calls pool.swap(recipient, params, hex"01") with NON-EMPTY data, which
    // selects the REAL Maverick V2 Pool's CALLBACK funding branch: the pool sends output first, then
    // re-enters our maverickV2SwapCallback(tokenIn, amountIn, amountOut, data) to PULL the input. This runs
    // the GENUINE captured pool bytecode (the callback selector 0x67ca7c91 is present in the real runtime),
    // so the swap COMPLETES against real code — no mock, no pre-pay substitute. We assert the cook SUCCEEDS
    // and the caller's received dy == the REAL quoter's calculateSwap(awarded) BIT-FOR-BIT (real == real).
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, etched.pool);
    const poolOutBefore = await balanceOf(c.publicClient, tokenOut, etched.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(
      receipt.status,
      "success",
      "the production cook SUCCEEDS through the FIXED engine _swapMaverickV2 → real maverickV2SwapCallback",
    );

    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const poolIn = (await balanceOf(c.publicClient, tokenIn, etched.pool)) - poolInBefore;
    const poolOut = poolOutBefore - (await balanceOf(c.publicClient, tokenOut, etched.pool));

    // The engine pulled exactly the awarded input via the callback and the pool paid the REAL dy.
    assert.equal(spent, awarded, "the engine spent exactly the awarded input (callback pull, wei-exact)");
    assert.equal(poolIn, awarded, "the REAL pool received exactly the awarded input via maverickV2SwapCallback");
    assert.equal(poolOut, received, "the REAL pool paid out exactly what the caller received");
    // REAL == REAL, to the WEI: the executed dy through the engine callback == the REAL MaverickV2Quoter's
    // calculateSwap(awarded). The engine-independent ground truth is the real bin swap math (the quoter),
    // and the genuine pool bytecode computed the same value under the engine's callback funding path.
    assert.equal(received, quoterOut, "received == REAL MaverickV2Quoter calculateSwap(awarded Σ) — BIT-EXACT (real == real)");
    assert.ok(received > 0n, "non-zero fill through the REAL Maverick V2 bin swap math (engine callback path)");

    // WEI-EXACT off-chain replay: the off-chain maverick-math.ts getDy now mirrors the on-chain
    // _remainingBinInputSpaceGivenOutput (reserve-extraction) bit-for-bit, so it reproduces the REAL pool's
    // dy TO THE WEI — not the old yldfi/ParaSwap price-edge port that diverged ~3.3e6 wei. This is the tier
    // that locks the fidelity the reference-math fix delivered: getDy(awarded) == the engine-executed dy ==
    // the REAL MaverickV2Quoter, all three equal exactly. A regression that reintroduces any per-tick-cross
    // rounding drift trips this hard equality (the old loose Δ<1e-12 bound would have let ~3.3e6 wei slip).
    const offOut = getDy(op, awarded);
    const diff = offOut > received ? offOut - received : received - offOut;
    assert.equal(offOut, received, `off-chain getDy == the real dy to the WEI (Δ=${diff}, out=${received})`);

    const ms = Date.now() - t0;
    console.log(
      `  [maverick-prod-mirror:${engine}] REAL engine-callback swap WEI-EXACT vs real quoter — ` +
        `spent=${spent} received=${received} (quoterOut=${quoterOut}, awarded=${awarded}, ` +
        `oracle=${oracle.totalInput}, offGetDy=${offOut} Δ=${diff}); wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`REAL Maverick V2 bytecode [${engine}] — real engine-callback swap wei-exact vs quoter + oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
