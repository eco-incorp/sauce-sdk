/**
 * EcoSwap PANCAKESWAP STABLESWAP PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * Unlike ecoswap.pancakestable.evm.test.ts (which deploys the PancakeStableSwapPool.sol fixture
 * whose math the off-chain replay mirrors bit-for-bit), this test stands up the GENUINE
 * PancakeSwap StableSwap pool bytecode captured from BSC — the on-charter USDT/USDC 2-pool
 * 0x3EFebC41… (VERIFIED source, the pancake-smart-contracts stable-swap project) — and runs the
 * production discovery + QL cook against it, with NO fork and NO RPC at run time (etch +
 * setStorageAt, seconds).
 *
 * The pool is the SIMPLEST etch class: a SELF-CONTAINED Solidity contract whose get_dy/exchange
 * touch NOTHING but the two coin ERC20s (the admin fee accrues in the pool's own `balances`
 * bookkeeping — no factory call on the swap path), and whose coins live in STORAGE inside the
 * captured window — so the etch is {real runtime + verbatim slots + local MintableERC20s at the
 * real coin addresses + a read-only getPairInfo factory shim at the captured factory address}.
 *
 * CENTRAL VERIFICATION:
 *   (a) REAL bytecode — eth_getCode at the pool byte-equals the captured runtime (sha256-anchored,
 *       verifiable with NO RPC); the reconstructed state reads back EXACTLY (coins/balances/A/fee/
 *       RATES) and the REAL get_dy reproduces the captured mainnet probes to the WEI, both
 *       directions. The one non-real contract is the READ-ONLY factory shim — discovery metadata
 *       only, DISCLOSED (constant getPairInfo replies keyed on the selector alone, which IS the
 *       real factory's order-independence for the one reproduced pair).
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — production discovery (discoverPancakeStablePoolsTyped → getPairInfo → the
 *       liveness get_dy probe) resolves + orients the pool; the PRODUCTION
 *       buildPancakeStableQLLadder replay (curve-math getD/getY at the LEGACY A_PRECISION=1 —
 *       asserted == the REAL pool's own get_dy at EVERY QL grid point, the exact points the
 *       on-chain qlv loop quotes); the PRODUCTION ecoswap.sauce.ts solver cooks the descriptor
 *       with ZERO prepared segments, building the ladder ON-CHAIN from the real live get_dy;
 *       received == the REAL pool's pre-swap get_dy(awarded) (18-dec pair ⇒ the view/exchange
 *       rounding forms coincide), spent == awarded == amountIn, allowance residue == 0.
 *   (d) DRIFT / RUNTIME RE-ANCHORING — a REAL exchange() on the genuine bytecode moves the pool
 *       AFTER compile; the SAME pre-drift bytecodes re-anchor: received == the POST-drift live
 *       get_dy(amountIn), not the stale pre-drift quote.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE. No state cache — etch+setStorage is seconds.
 *
 * Recapture: BSC_RPC_URL=<url> npx tsx src/recipes/test/harness/pancakestable-snapshot.ts
 * Run: ECO_ENGINE=both npx tsx --test src/recipes/test/ecoswap.pancakestable.prodmirror.evm.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi, type Abi, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { compileSauce, ECOSWAP_DIR } from "./harness/compile";
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
  etchPancakeStablePool,
  loadPancakeStableSnapshots,
  verifyBytecodeIntegrity,
  pancakeStablePoolReadAbi,
  pancakeStableFactoryShimAbi,
  type EtchedPancakeStablePool,
} from "./harness/etch-pool";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { SwapPoolType, FactoryType, MIN_SQRT_RATIO, type ChainPoolConfig } from "../shared/constants";
import { discoverPancakeStablePoolsTyped } from "../shared/pool-discovery";
import {
  pancakeStableGetDy,
  buildPancakeStableQLLadder,
  type PancakeStablePool,
  type PancakeStableState,
} from "../shared/pancakestable-math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";

const SNAP_NAME = "bsc-pancakestable-USDTUSDC";
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");
const ENGINE_CELLS = engineCells();

describe("EcoSwap PancakeSwap StableSwap prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadPancakeStableSnapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedPancakeStablePool;
  let solverSrc: string;

  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    solverSrc = readFileSync(SOLVER, "utf-8");
    // ~2x the tokenIn (USDT) balance as caller headroom (18-dec coin; balance ~162.5k USDT).
    etched = await etchPancakeStablePool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: BigInt(snaps.state.balances[snaps.state.i]) * 2n,
    });
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY the PancakeStableSwap factory (the shim at the captured address) →
   *  the production discovery path resolves the etched pool. */
  function pksPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.factory,
          poolType: SwapPoolType.Curve,
          factoryType: FactoryType.PancakeStableSwap,
          label: "Local PancakeStableSwap (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // The solver's 6 compiler args, in index.ts order. PancakeStableSwap is a QUOTE-LADDER venue:
  // ZERO prepared segments — the venue rides entirely inside qlv as a DESCRIPTOR, and the solver
  // builds its price ladder ON-CHAIN from live get_dy at cook time.
  function pksArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, qlv: bigint[][]): unknown[] {
    return [
      [BigInt(tokenIn), BigInt(tokenOut), amountIn, BigInt(caller), MIN_SQRT_RATIO + 1n, 0n],
      [], [], [], [], qlv,
    ];
  }

  function pksDescriptor(pool: Hex, i: number, j: number, feePpm: number, refIdx: number): bigint[] {
    return [BigInt(pool), BigInt(i), BigInt(j), BigInt(feePpm), 20n, BigInt(refIdx)];
  }

  /** The etched pool's LIVE invariant state (for the off-chain replay). */
  async function liveState(): Promise<PancakeStableState> {
    const read = (fn: string, args: unknown[] = []) =>
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi as Abi, functionName: fn, args }) as Promise<bigint>;
    const [A, fee, b0, b1, r0, r1] = await Promise.all([
      read("A"), read("fee"), read("balances", [0n]), read("balances", [1n]), read("RATES", [0n]), read("RATES", [1n]),
    ]);
    return { A, fee, balances: [b0, b1], rates: [r0, r1] };
  }

  async function onGetDy(i: number, j: number, dx: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: etched.pool, abi: pancakeStablePoolReadAbi as Abi, functionName: "get_dy", args: [BigInt(i), BigInt(j), dx],
    })) as bigint;
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured BSC runtime, byte-for-byte. ──
  it("etches the REAL PancakeSwap StableSwap bytecode (byte-equal) + reconstructs the state", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime still hashes to the capture anchor.
    const integ = verifyBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pool runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(snaps.bytecode.pool.runtimeSha256, "pool snapshot carries a sha256 integrity anchor");
    assert.equal(snaps.bytecode.isMinimalProxy, false, "not a clone/proxy (self-contained Solidity)");

    const poolCode = await c.publicClient.getCode({ address: etched.pool });
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pool.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL PancakeSwap StableSwap runtime (byte-equal)",
    );
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.address.toLowerCase(), "pool at the captured BSC address");

    // The REAL code reads the reconstructed state correctly — coins/balances/A/fee/RATES from the
    // verbatim storage window (this VALIDATES the captured window covered everything swap-relevant;
    // the settled A-ramp reads future_A == the captured A at the anvil wall clock).
    const [coin0, coin1, A, fee, adminFee, b0, b1, r0, r1, killed] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "coins", args: [0n] }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "coins", args: [1n] }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "A" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "fee" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "admin_fee" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "balances", args: [0n] }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "balances", args: [1n] }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "RATES", args: [0n] }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "RATES", args: [1n] }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: pancakeStablePoolReadAbi, functionName: "is_killed" }) as Promise<boolean>,
    ]);
    assert.equal(coin0.toLowerCase(), etched.coins[0].toLowerCase(), "coins(0) points at the local token at the real coin address (storage-restored)");
    assert.equal(coin1.toLowerCase(), etched.coins[1].toLowerCase(), "coins(1) points at the local token at the real coin address (storage-restored)");
    assert.equal(A, etched.A, "A() == captured (the ramp is settled — future_A)");
    assert.equal(fee, etched.fee, "fee() == captured");
    assert.equal(adminFee, etched.adminFee, "admin_fee() == captured");
    assert.equal(b0, etched.balances[0], "balances(0) == captured");
    assert.equal(b1, etched.balances[1], "balances(1) == captured");
    assert.equal(r0, etched.rates[0], "RATES(0) == captured");
    assert.equal(r1, etched.rates[1], "RATES(1) == captured");
    assert.equal(killed, false, "is_killed == false (captured live)");

    // The REAL get_dy reproduces the captured mainnet probes to the WEI, BOTH directions.
    const pf = snaps.state.probe.forward;
    const pr = snaps.state.probe.reverse;
    assert.equal(
      (await onGetDy(pf.i, pf.j, BigInt(pf.dx))).toString(), pf.dy,
      "REAL get_dy(forward probe) == the captured mainnet value",
    );
    assert.equal(
      (await onGetDy(pr.i, pr.j, BigInt(pr.dx))).toString(), pr.dy,
      "REAL get_dy(reverse probe) == the captured mainnet value",
    );

    // The PRODUCTION replay (curve-math getD/getY at A_PRECISION=1, VIEW-form rounding) == the
    // REAL bytecode at the captured probes — the off-chain model is pinned against genuine code.
    const st = await liveState();
    assert.equal(
      pancakeStableGetDy(st, pf.i, pf.j, BigInt(pf.dx)).toString(), pf.dy,
      "pancakeStableGetDy replay == the REAL get_dy (forward probe, wei-exact)",
    );
    assert.equal(
      pancakeStableGetDy(st, pr.i, pr.j, BigInt(pr.dx)).toString(), pr.dy,
      "pancakeStableGetDy replay == the REAL get_dy (reverse probe, wei-exact)",
    );

    // The shim answers the production discovery surface — BOTH argument orders (the real factory's
    // sortTokens order-independence, reproduced by the selector-keyed constant reply).
    const infoF = (await c.publicClient.readContract({
      address: etched.factory, abi: pancakeStableFactoryShimAbi, functionName: "getPairInfo", args: [etched.tokenIn, etched.tokenOut],
    })) as readonly [Hex, Hex, Hex, Hex];
    const infoR = (await c.publicClient.readContract({
      address: etched.factory, abi: pancakeStableFactoryShimAbi, functionName: "getPairInfo", args: [etched.tokenOut, etched.tokenIn],
    })) as readonly [Hex, Hex, Hex, Hex];
    assert.equal(infoF[0].toLowerCase(), etched.pool.toLowerCase(), "shim getPairInfo resolves the etched pool");
    assert.deepEqual(infoF, infoR, "shim getPairInfo is order-independent (both orders, one sorted struct)");
    assert.equal(infoF[1].toLowerCase(), snaps.state.discovery.getPairInfo.token0.toLowerCase(), "shim token0 == captured sorted token0");

    console.log(
      `  [pancakestable-prod-mirror] REAL bytecode etched: pool ${etched.pool} (${(poolCode!.length - 2) / 2} B Solidity); ` +
        `captured block ${snaps.state.block}; A ${etched.A} fee ${etched.fee}; balances ${etched.balances[0]}/${etched.balances[1]}`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE production-path run, wei-exact vs the real pool view. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;

    // ~2% of the tokenIn-side balance — well inside the curve (single-venue full-fill).
    const amountIn = etched.balances[snaps.state.i] / 50n;
    const poolConfig = pksPoolConfig(tokenIn, tokenOut);

    // PRODUCTION discovery: getPairInfo (the shim at the captured factory address) → i/j
    // orientation off the sorted token0/token1 → the liveness get_dy probe → feePpm from fee().
    const discovered = await discoverPancakeStablePoolsTyped(tokenIn, tokenOut, c.publicClient, poolConfig.factories, amountIn);
    assert.equal(discovered.length, 1, "production discovery surfaced exactly the 1 reproduced venue");
    assert.equal(discovered[0].address.toLowerCase(), etched.pool.toLowerCase(), "the discovered venue is the REAL etched pool");
    assert.equal(discovered[0].i, snaps.state.i, "discovery oriented coin index i (uint256)");
    assert.equal(discovered[0].j, snaps.state.j, "discovery oriented coin index j (uint256)");
    assert.equal(discovered[0].feePpm, 100, "feePpm read from the REAL fee() (1e6 of 1e10 ⇒ 100 ppm)");

    // PRODUCTION QL LADDER, unmasked: the replay drives buildPancakeStableQLLadder over the live
    // read state — the SAME geometric ladder the on-chain solver builds from live get_dy.
    const st = await liveState();
    const model: PancakeStablePool = {
      ...discovered[0],
      getDy: (dx: bigint) => pancakeStableGetDy(st, discovered[0].i, discovered[0].j, dx),
    };
    const ladder = buildPancakeStableQLLadder(model, amountIn);
    assert.ok(ladder.length > 0, "production QL ladder is non-empty");
    const ladderSum = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(ladderSum, amountIn, "production QL ladder covers the full amountIn");

    // LADDER PARITY — the core gate: at EVERY cumulative QL point the off-chain replay == the REAL
    // etched pool's OWN get_dy, to the WEI. These are the EXACT points the on-chain qlv loop quotes.
    let cum = 0n;
    let cumOut = 0n;
    for (const s of ladder) {
      cum += s.capacity;
      cumOut += s.effOut;
      const offChain = model.getDy(cum);
      const onChain = await onGetDy(discovered[0].i, discovered[0].j, cum);
      assert.equal(offChain, onChain, `QL ladder parity at cum=${cum}: replay == REAL get_dy (wei-exact)`);
      assert.equal(cumOut, offChain, `QL ladder partition at cum=${cum}: Σ effOut == getDy(cum)`);
    }

    // NEUTRAL ORACLE over the SAME ladder: with ONE venue covering [0, amountIn] the merge awards
    // it the whole trade.
    const oracle = optimalSplit({ pools: [{ pancakeStable: model, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.equal(awarded, amountIn, "oracle awards the whole trade to the reproduced venue");

    // The REAL pre-swap get_dy for the awarded Σ — the engine-independent ground truth (18-dec pair
    // ⇒ the exchange's realized dy == this view to the wei).
    const onViewPre = await onGetDy(discovered[0].i, discovered[0].j, awarded);
    assert.equal(onViewPre, model.getDy(awarded), "REAL get_dy(awarded) == production replay (wei-exact)");

    // Compile the PRODUCTION solver with ZERO prepared segments — only the QL descriptor — and
    // cook: the ladder is built ON-CHAIN from the REAL live get_dy, min_dy = quote − 1, exchange.
    const qlv = [pksDescriptor(etched.pool, discovered[0].i, discovered[0].j, discovered[0].feePpm, 0)];
    const { bytecodes } = compileSauce(solverSrc, pksArgs(tokenIn, tokenOut, amountIn, caller, qlv), ECOSWAP_DIR, engine);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // headroom

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, etched.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL PancakeSwap StableSwap bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, etched.pool)) - poolInBefore;

    assert.ok(spent > 0n && received > 0n, "caller spends tokenIn / receives tokenOut");
    // HONEST fee accounting: exchange takes the fee on the OUTPUT dy and PULLS the full dx via
    // transferFrom — the pool nets the FULL input.
    assert.equal(poolIn, spent, "the REAL pool netted the FULL input (fee on the output dy, exact-dx pull)");
    assert.equal(spent, awarded, "on-chain spent == awarded input (wei-exact vs oracle)");
    assert.equal(spent, amountIn, "single-venue full-fill: spent == amountIn (no unspent wei)");
    // 18-dec pair ⇒ the view/exchange rounding forms coincide: received == the pre-swap view.
    assert.equal(received, onViewPre, "received == REAL pre-swap get_dy(awarded) (exact-in-dy)");

    // RESIDUE SWEEP: exchange pulls EXACTLY dx (VERIFIED source; genuine bytecode) — pull == approve.
    const residue = (await c.publicClient.readContract({
      address: tokenIn, abi: parseAbi(["function allowance(address, address) view returns (uint256)"]) as Abi,
      functionName: "allowance", args: [target, etched.pool],
    })) as bigint;
    assert.equal(residue, 0n, "no pool allowance residue on the REAL bytecode (pull == approve)");

    const ms = Date.now() - t0;
    console.log(
      `  [pancakestable-prod-mirror:${engine}] WEI-EXACT vs the REAL get_dy — spent=${spent} received=${received} ` +
        `(awarded Σ=${awarded}, realGetDy=${onViewPre}); ${ladder.length} on-chain QL slices; wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  // ── (d) DRIFT — a REAL exchange moves the genuine pool AFTER compile; the bytecodes re-anchor. ──
  async function runDrift(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    const i = snaps.state.i;
    const j = snaps.state.j;

    const amountIn = etched.balances[i] / 50n;
    const qlv = [pksDescriptor(etched.pool, i, j, 100, 0)];
    // Compile against the PRE-drift state (the descriptor carries no pool state).
    const { bytecodes } = compileSauce(solverSrc, pksArgs(tokenIn, tokenOut, amountIn, caller, qlv), ECOSWAP_DIR, engine);
    const preDriftQuote = await onGetDy(i, j, amountIn);

    // ADVERSE DRIFT: a REAL exchange on the GENUINE bytecode (i → j imbalances the pool so
    // subsequent i → j swaps price WORSE).
    const driftIn = etched.balances[i] / 20n;
    await mint(c.walletClient, c.publicClient, tokenIn, caller, driftIn);
    await approve(c.walletClient, c.publicClient, tokenIn, etched.pool, driftIn);
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: etched.pool, abi: pancakeStablePoolReadAbi as Abi, functionName: "exchange",
        args: [BigInt(i), BigInt(j), driftIn, 0n], account: caller, chain: c.walletClient.chain,
      }),
    });

    const postDriftQuote = await onGetDy(i, j, amountIn);
    assert.ok(postDriftQuote < preDriftQuote, `the REAL exchange drifted the pool (${postDriftQuote} < ${preDriftQuote})`);

    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "post-drift cook() must succeed (the ladder re-reads live state)");
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // RE-ANCHORED: the pre-drift bytecodes landed the POST-drift live quote, not the stale one.
    assert.equal(received, postDriftQuote, "received == POST-drift live get_dy(amountIn) (re-anchored, wei-exact)");
    assert.notEqual(received, preDriftQuote, "received != the stale pre-drift quote (the ladder is live)");

    console.log(
      `  [pancakestable-prod-mirror drift:${engine}] pre=${preDriftQuote} → post=${postDriftQuote} received=${received} ` +
        `(pre-drift bytecodes re-anchored to the drifted REAL pool)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL PancakeSwap StableSwap bytecode [${engine}] — wei-exact vs the real get_dy, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
    it(`re-anchors to a REAL-exchange drift on the genuine bytecode [${engine}]`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});
