/**
 * EcoSwap EKUBO V3 PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE, BOTH DIRECTIONS. Ekubo's
 * periphery is only PARTLY verified and its micro-tick math is a bespoke family this recipe
 * deliberately does NOT port, so the genuine etched runtime is the mandatory way to prove the
 * production discovery → plain-CALL QL-ladder → full-fill exec path against the real pool math
 * (the repo's prod-mirror discipline).
 *
 * Unlike ecoswap.ekubo.evm.test.ts (which deploys the EkuboFixture .sol mirrors), this test
 * stands up the GENUINE ETH-mainnet graph captured by harness/ekubo-snapshot.ts — the
 * MEVCaptureRouter + the Core singleton with the top USDe/USDC virtual pool's ENTIRE tick
 * territory (the capture's oversize quotes walked ALL initialized liquidity both directions, so
 * every slot any smaller cook reads is present) — via the fermi harness verbatim (the snapshot is
 * FERMI-SHAPED: fermiSwapper = the ROUTER, vault = the CORE holding the till inventory), and runs
 * the swap against it: etch + setStorageAt, seconds, no RPC.
 *
 * ── CLZ (EIP-7939) ──────────────────────────────────────────────────────────────────────────────
 * The genuine runtime executes the CLZ opcode — the anvil boots `--hardfork osaka`
 * (startAnvil({ hardfork: "osaka" })); cell (a)'s captured-ladder reproduction IS the CLZ
 * execution gate (the E1 gate of the spec).
 *
 * Cells (× v1/v12 via ECO_ENGINE):
 *   (a) INTEGRITY — every checked-in runtime hashes to its capture anchor, eth_getCode matches
 *       byte-for-byte, and the captured probe ladders (BOTH directions) reproduce WEI-EXACT on
 *       the etched graph (real router dispatch, real lock, real micro-tick walk, real CLZ).
 *   (b) The production discovery→QL→exec run FORWARD (USDe→USDC), wei-exact vs the
 *       prefetched-grid oracle + the real router's own pre-cook quote; the Core till pulled
 *       exactly the consumed input; allowance residue 0.
 *   (c) The SAME run in REVERSE (USDC→USDe) — the isToken1 lane-decode cell on the real word.
 *   (d) DRIFT — move the REAL pool with a GENUINE swap through the etched router, then cook the
 *       PRE-drift bytecodes: the in-cook live ladder RE-ANCHORS to the moved state.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.ekubo.prodmirror.evm.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, getAddress, type Abi, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { ensureMulticall3, deployStack, mint, approve, balanceOf, type DeployedStack, type DeployedV12Stack } from "./harness/setup";
import {
  etchFermiGraph,
  loadFermiSnapshots,
  verifyFermiBytecodeIntegrity,
  pinFermiBlockTimestamp,
  type EtchedFermiGraph,
} from "./harness/etch-pool";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { ekuboQLGridInputs, EKUBO_DEFAULT_PRESETS, type EkuboPool } from "../shared/ekubo-math";

const SNAP_NAME = "eth-ekubo-USDeUSDC";
const ENGINE_CELLS = engineCells();

const routerAbi = parseAbi([
  "function quote((address token0, address token1, bytes32 config) poolKey, bool isToken1, int128 amount, uint96 sqrtRatioLimit, uint256 skipAhead) view returns (bytes32 balanceUpdate, bytes32 stateAfter)",
  "function swap((address token0, address token1, bytes32 config) poolKey, bool isToken1, int128 amount, uint96 sqrtRatioLimit, uint256 skipAhead, int256 calculatedAmountThreshold, address recipient) returns (bytes32 balanceUpdate)",
]);

describe("EcoSwap EKUBO prod-mirror — REAL router+Core bytecode (osaka/CLZ), no fork, offline, both directions", () => {
  const snaps = loadFermiSnapshots(SNAP_NAME);
  const ROUTER = getAddress(snaps.state.fermiSwapper) as Hex;
  const CORE = getAddress(snaps.state.ekuboCore!) as Hex;
  const KEY = {
    token0: getAddress(snaps.state.ekuboPoolKey!.token0) as Hex,
    token1: getAddress(snaps.state.ekuboPoolKey!.token1) as Hex,
    config: snaps.state.ekuboPoolKey!.config as Hex,
  };
  const POOL_ID = snaps.state.ekuboPoolId! as Hex;

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedFermiGraph;

  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    // OSAKA: the genuine Ekubo runtime executes CLZ (EIP-7939) — the default hardfork would
    // revert every quote/swap with an invalid-opcode.
    anvil = await startAnvil({ hardfork: "osaka" });
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    etched = await etchFermiGraph(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: 1_000_000n * 10n ** 18n, // USDe headroom (forward cooks + the drift swap)
    });
    // The REVERSE cells spend USDC — mint the caller a generous local-USDC balance (6 dec).
    await mint(c.walletClient, c.publicClient, etched.tokenOut, c.account0, 1_000_000n * 10n ** 6n);
    // Pin the clock to the capture instant (uniform prod-mirror discipline; extension-0
    // concentrated pools carry no time gate, so this is deterministic hygiene, not a freshness fix).
    await pinFermiBlockTimestamp(c.testClient as never, snaps.state);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** The REAL etched router's quote — |out lane| + the consumed in-lane of the packed word. */
  async function onQuote(isToken1: boolean, amt: bigint): Promise<{ out: bigint; consumed: bigint }> {
    const [bu] = (await c.publicClient.readContract({
      address: ROUTER, abi: routerAbi as Abi, functionName: "quote",
      args: [KEY, isToken1, amt, 0n, 0n],
    })) as readonly [Hex, Hex];
    const word = BigInt(bu);
    const HALF = (1n << 127n) - 1n;
    const LANE = 1n << 128n;
    const outLane = isToken1 ? word >> 128n : word & (LANE - 1n);
    const inLane = isToken1 ? word & (LANE - 1n) : word >> 128n;
    return {
      out: outLane > HALF ? LANE - outLane : 0n,
      consumed: inLane <= HALF ? inLane : 0n,
    };
  }

  /** The Fluid/Tessera/Metric PREFETCH pattern: quote the REAL etched router at the DETERMINISTIC
   *  QL grid (ekuboQLGridInputs), answer by exact-point lookup — the oracle's `getDy` model. */
  async function offPool(isToken1: boolean, amountIn: bigint): Promise<EkuboPool> {
    const grid = ekuboQLGridInputs(amountIn);
    const quotes = new Map<bigint, bigint>();
    for (const x of grid) quotes.set(x, (await onQuote(isToken1, x)).out);
    return {
      router: ROUTER, token0: KEY.token0, token1: KEY.token1, config: KEY.config,
      isToken1, poolId: POOL_ID,
      tokenIn: isToken1 ? KEY.token1 : KEY.token0,
      tokenOut: isToken1 ? KEY.token0 : KEY.token1,
      feePpm: 30, source: "prod-mirror-prefetch",
      getDy: (dx: bigint): bigint => {
        const q = quotes.get(dx);
        if (q === undefined) throw new Error(`ekubo prefetch grid miss at ${dx}`);
        return q;
      },
    };
  }

  function ekuboPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: CORE,
          poolType: SwapPoolType.UniV2, // INERT placeholder (discovery keys off factoryType)
          factoryType: FactoryType.Ekubo,
          label: "Local Ekubo (prod-mirror)",
          ekuboRouter: ROUTER,
          // The captured pool's tier only — the full default menu works too (dead candidates read
          // zero words in the ONE batched sload), but the single entry keeps the run surgical.
          ekuboPresets: [EKUBO_DEFAULT_PRESETS[0]],
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // ── (a) REAL BYTECODE — integrity + both captured probe ladders wei-exact (the CLZ gate) ──
  it("etches the REAL Ekubo router+Core graph (byte-equal, osaka) + reproduces BOTH captured probe ladders", async () => {
    await setup();
    // NO-NETWORK integrity tripwire FIRST: every checked-in runtime still hashes to its capture anchor.
    const integ = verifyFermiBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, "every captured runtime sha256 matches its capture anchor");

    for (const cc of snaps.bytecode.contracts) {
      const addr = getAddress(cc.address) as Hex;
      const isToken = ["USDe", "USDC"].some(
        (sym) => getAddress(snaps.state.tokens[sym].address).toLowerCase() === addr.toLowerCase(),
      );
      if (isToken) continue; // repointed to local MintableERC20s
      const code = await c.publicClient.getCode({ address: addr });
      assert.equal(code?.toLowerCase(), cc.runtime.toLowerCase(), `eth_getCode at ${addr} == captured REAL runtime [${cc.role}]`);
    }

    // BOTH captured probe ladders reproduce WEI-EXACT — the strongest single-shot proof the etched
    // graph IS mainnet (real lock protocol, real micro-tick walk, real compact-float sqrt math,
    // real CLZ execution — the E1 osaka gate).
    for (const p of snaps.state.probe.target.ladder) {
      const r = await onQuote(false, BigInt(p.amountIn));
      assert.equal(r.out.toString(), p.amountOut, `REAL quote fwd(${p.amountIn}) == captured mainnet ${p.amountOut}`);
    }
    for (const p of snaps.state.probe.second!.ladder) {
      const r = await onQuote(true, BigInt(p.amountIn));
      assert.equal(r.out.toString(), p.amountOut, `REAL quote rev(${p.amountIn}) == captured mainnet ${p.amountOut}`);
    }
    console.log(
      `  [ekubo-prod-mirror] REAL bytecode etched (${etched.contractCount} contracts, ${etched.slotCount} slots, osaka/CLZ); ` +
        `till ${snaps.state.vault.reserves.USDe} USDe / ${snaps.state.vault.reserves.USDC} USDC; BOTH probe ladders wei-exact`,
    );
  });

  // ── (b)/(c) The production discovery→QL→exec run, either direction, wei-exact. ──
  async function runProdMirror(engine: Engine, isToken1: boolean): Promise<void> {
    await setup();
    const t0ms = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const tokenIn = isToken1 ? KEY.token1 : KEY.token0; // USDC rev / USDe fwd (local mints at real addrs)
    const tokenOut = isToken1 ? KEY.token0 : KEY.token1;
    // FORWARD: 100k USDe — deep inside the captured ~732k-USDC till side. REVERSE: 50k USDC —
    // deep inside the ~957k-USDe side. Both sizes sit inside the captured tick territory by
    // construction (the capture's oversize walks covered ALL initialized liquidity).
    const amountIn = isToken1 ? 50_000n * 10n ** 6n : 100_000n * 10n ** 18n;
    const poolConfig = ekuboPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [target as never, "0x8AC7230489E80000" as never],
    } as never);

    // Production discovery + compile against the etched graph (ONE batched raw sload + ONE quote).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal(prepared.pools.length, 0, "no direct pools (Ekubo-only config)");
    assert.equal((prepared.ekuboPools ?? []).length, 1, "discovered exactly the 1 REAL Ekubo venue");
    const venue = prepared.ekuboPools![0];
    assert.equal(venue.router.toLowerCase(), ROUTER.toLowerCase(), "the descriptor carries the etched ROUTER");
    assert.equal(venue.poolId.toLowerCase(), POOL_ID.toLowerCase(), "the venue IS the captured virtual pool");
    assert.equal(venue.config.toLowerCase(), KEY.config.toLowerCase(), "the descriptor carries the captured config");
    assert.equal(venue.isToken1, isToken1, "the descriptor's direction stamp matches the edge");

    // PREFETCH the REAL router's quotes at the deterministic QL grid → the oracle model.
    const op = await offPool(isToken1, amountIn);
    const oracle = optimalSplit({ pools: [{ ekubo: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the REAL Ekubo venue");
    assert.ok(awarded * 2n >= amountIn, `awarded covers >= 50% of amountIn (awarded=${awarded})`);

    // The REAL router's own pre-cook quote of the awarded share — the ground truth for the
    // executed out (the exec re-quotes exactly this in-tx, same state ⇒ deterministic).
    const pre = await onQuote(isToken1, awarded);
    assert.equal(pre.consumed, awarded, "the award is fully consumable (deep inside the till)");

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const coreInBefore = await balanceOf(c.publicClient, tokenIn, CORE);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `cook() must succeed against the REAL Ekubo graph (${isToken1 ? "REV" : "fwd"})`);

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const coreIn = (await balanceOf(c.publicClient, tokenIn, CORE)) - coreInBefore;

    assert.equal(spent, awarded, "on-chain spent == prefetched-oracle awarded (wei-exact)");
    assert.equal(coreIn, spent, "the REAL router's payFrom pulled the input into the Core till");
    assert.equal(received, pre.out, "received == REAL router pre-cook quote(awarded) (wei-exact-vs-live-quote)");
    assert.ok(received > 0n, "caller receives tokenOut from the till inventory");
    // RESIDUE: the exec approves EXACTLY the quoted consumed input and payFrom pulls exactly that
    // (source-verified + fork-proven) — assert it held on the GENUINE router bytecode.
    const residue = (await c.publicClient.readContract({
      address: tokenIn, abi: parseAbi(["function allowance(address, address) view returns (uint256)"]) as Abi,
      functionName: "allowance", args: [target, ROUTER],
    })) as bigint;
    assert.equal(residue, 0n, "no router allowance residue on the GENUINE bytecode (pull == approve)");

    const ms = Date.now() - t0ms;
    console.log(
      `  [ekubo-prod-mirror:${engine}:${isToken1 ? "REV" : "fwd"}] WEI-EXACT — spent=${spent} received=${received} ` +
        `(== real quote); wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  // ── (d) DRIFT — move the REAL pool with a GENUINE swap, then cook the PRE-drift bytecodes. ──
  async function runDrift(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = KEY.token0; // USDe
    const tokenOut = KEY.token1; // USDC
    const amountIn = 100_000n * 10n ** 18n;
    const poolConfig = ekuboPoolConfig(tokenIn, tokenOut);

    const driftAmt = 50_000n * 10n ** 18n;
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, ROUTER, driftAmt);
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [target as never, "0x8AC7230489E80000" as never],
    } as never);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal((prepared.ekuboPools ?? []).length, 1, "discovered the REAL Ekubo venue");
    const baseline = await onQuote(false, amountIn);

    // GENUINE drift: a REAL full-fill swap (50k USDe) through the REAL router — the pool's tick
    // state moves (the same live state the cook's ladder will read).
    const driftQuote = await onQuote(false, driftAmt);
    const driftHash = await c.walletClient.writeContract({
      address: ROUTER, abi: routerAbi as Abi, functionName: "swap",
      args: [KEY, false, driftAmt, 0n, 0n, driftQuote.out, caller], account: c.walletClient.account as Account,
      chain: c.walletClient.chain, gas: 5_000_000n,
    });
    const driftReceipt = await c.publicClient.waitForTransactionReceipt({ hash: driftHash });
    assert.equal(driftReceipt.status, "success", "the REAL drift swap lands on the etched graph");

    // Re-prefetch the POST-drift grid — the oracle the PRE-drift bytecodes must re-anchor to.
    const opDrift = await offPool(false, amountIn);
    const postDriftFull = opDrift.getDy(ekuboQLGridInputs(amountIn).at(-1)!);
    assert.ok(postDriftFull < baseline.out, "adverse drift worsened the full-size quote");
    console.log(`  [ekubo-prod-mirror drift:${engine}] baseline quote=${baseline.out} post-drift full-size quote=${postDriftFull}`);
    const oracleDrift = optimalSplit({ pools: [{ ekubo: opDrift, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awardedDrift = oracleDrift.perPoolInput[0] ?? 0n;
    assert.ok(awardedDrift > 0n, "post-drift oracle still allocates");
    const onViewDrift = await onQuote(false, awardedDrift);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "PRE-drift bytecodes cook successfully after a REAL pool move");
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(spent, awardedDrift, "spent == the POST-drift prefetched-oracle award (re-anchored)");
    assert.equal(received, onViewDrift.out, "received == the POST-drift live quote of the awarded share (re-anchored, wei-exact)");
    console.log(
      `  [ekubo-prod-mirror drift:${engine}] real 50k-USDe drift swap, then pre-drift cook — ` +
        `spent=${spent} received=${received} == post-drift quote (re-anchored)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Ekubo graph FORWARD (USDe→USDC) [${engine}] — wei-exact, offline`, { skip }, async () => {
      await runProdMirror(engine, false);
    });
    it(`runs EcoSwap through the REAL Ekubo graph REVERSE (USDC→USDe) [${engine}] — the lane-decode cell, wei-exact`, { skip }, async () => {
      await runProdMirror(engine, true);
    });
    it(`REAL-swap drift re-anchor [${engine}] — pre-drift bytecodes re-anchor to the moved pool`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});
