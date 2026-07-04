/**
 * EcoSwap Tessera V (Wintermute's TesseraSwap wrapper + PRIVATE engine — a treasury-funded proactive
 * market maker) PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE — including the PRIORITY-FEE-threshold
 * ship-blocker cells on the GENUINE engine.
 *
 * Unlike ecoswap.tessera.evm.test.ts (which deploys a MOCK TesseraSwap.sol fixture), this test stands up
 * the GENUINE Base-mainnet wrapper + engine + per-pair pool + oracle graph captured from Base
 * (harness/tessera-snapshot.ts — emitted FERMI-SHAPED, so the whole fermi harness is reused verbatim:
 * loadFermiSnapshots / verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp / etchFermiGraph), and runs
 * the swap against it — proving the production discovery + QL-ladder + execution path works on the REAL
 * contracts, with NO fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * ── THE BLOCK-NUMBER FRESHNESS GATE (why the chain boots at a HIGH GENESIS + aligns to the pin) ────────
 * The REAL engine gates + decays quotes on BLOCK NUMBER vs its posted refs (measured on the etched graph:
 * quotes are wei-identical to the capture at the pinned block [flat through pin+1], decay ~1% by pin+10,
 * and are 0 by pin+100 or before the refs) — the block-number analogue of Fermi's StaleUpdate clock gate.
 * So the test (a) boots anvil at a HIGH GENESIS NUMBER (startAnvil initGenesisNumber = pin − 300; anvil
 * honors genesis.number), (b) runs every funding tx first, (c) MINES up to exactly the pinned block, and
 * (d) prefetches every oracle quote via eth_call with blockOverrides.number == THE COOK BLOCK (anvil
 * honors blockOverrides — differential-verified), so the prefetched grid and the cook's live ladder read
 * ONE deterministic block context. bit-exact reproduction proven: override→pin returns the captured Base
 * quote to the WEI.
 *
 * ── GAS CONTEXT (the engine's globalPrioFeeThresholddd1337) ────────────────────────────────────────────
 * The REAL engine reads tx.gasprice (vs its 2-gwei knob) inside BOTH the view and the swap. Every
 * prefetch eth_call AND the cook tx pin the SAME legacy gas price, and the base fee is FIXED
 * (anvil_setNextBlockBaseFeePerGas before every mined block) — one deterministic gas context.
 *
 * ── THE PRIORITY-FEE VERDICT CELLS (the ship-blocker, on REAL bytecode) ────────────────────────────────
 * Cook the SAME universe once BELOW (1 gwei) and once ABOVE (5 gwei) the REAL captured threshold
 * (globalPrioFeeThresholddd1337() == 2 gwei, read off the etched engine): BOTH cooks LAND, and each fill
 * == the same-gas-context prefetched oracle/live view to the WEI — the fork-measured verdict (the swap
 * NEVER reverts on gas price; quote+exec read the same tx.gasprice, so the recipe's same-tx
 * quote-as-amountCheck pair is coherent at ANY gas price) encoded as a permanent offline regression.
 *
 * Plus the standard prod-mirror cells: (a) byte-equal integrity + captured-probe-ladder reproduction
 * (wei-exact at the pinned block + gas context), (b) the production discovery→QL→exec run wei-exact vs
 * the prefetched oracle + real view, (c) a REAL-swap DRIFT cell (move the engine state with a genuine
 * tesseraSwapWithAllowances, then cook the PRE-drift bytecodes — the live ladder re-anchors).
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE. Run:
 *   npx tsx --test src/recipes/test/ecoswap.tessera.prodmirror.evm.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi, getAddress, type Abi, type Account, type Hex } from "viem";

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
import { tesseraQLGridInputs, type TesseraPool } from "../shared/tessera-math";

const SNAP_NAME = "base-tessera-WETHUSDC";
const ENGINE_CELLS = engineCells();

// The pinned deterministic gas context: a FIXED base fee + the two legacy cook gas prices (below/above
// the REAL 2-gwei threshold). Every prefetch eth_call carries the same gasPrice as its cook.
const BASE_FEE = 1_000_000n; // 0.001 gwei — far below both cook prices
const GAS_BELOW = 1_000_000_000n; // 1 gwei (in-band; also the capture's probe context)
const GAS_ABOVE = 5_000_000_000n; // 5 gwei (above the 2-gwei knob)

const tesseraViewAbi = parseAbi([
  "function tesseraSwapViewAmounts(address tokenIn, address tokenOut, int256 amountSpecified) view returns (uint256 amountIn, uint256 amountOut)",
  "function tesseraSwapWithAllowances(address tokenIn, address tokenOut, int256 amountSpecified, uint256 amountCheck, address recipient, bytes swapData)",
]);
const prioAbi = parseAbi(["function globalPrioFeeThresholddd1337() view returns (uint256)"]);

describe("EcoSwap Tessera V (TesseraSwap wrapper + private engine) prod-mirror — REAL bytecode, no fork, offline + prio-fee verdict", () => {
  const snaps = loadFermiSnapshots(SNAP_NAME);
  const pinBlock = BigInt(snaps.state.block);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedFermiGraph;

  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    // HIGH-GENESIS boot: the REAL engine's block-number freshness gate needs the chain near the pinned
    // block (see the header). 300 blocks of setup headroom, then alignToPin() mines the remainder.
    anvil = await startAnvil({ initGenesisNumber: pinBlock - 300n });
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    etched = await etchFermiGraph(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: 200n * 10n ** 18n, // 200 WETH headroom (the 100-WETH cook + the 50-WETH drift swap)
    });
    await pinFermiBlockTimestamp(c.testClient as never, snaps.state);
    // Gas-priced eth_calls check the sender's ETH balance — fund the prefetch senders (0xdead == the
    // capture's probe context; the cook targets are funded per-run below).
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: ["0x000000000000000000000000000000000000dEaD" as never, "0x8AC7230489E80000" as never],
    } as never);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** Pin the NEXT mined block's base fee (each pin affects only one block; call before every tx/mine). */
  async function pinNextBaseFee(): Promise<void> {
    await c.publicClient.request({
      method: "anvil_setNextBlockBaseFeePerGas" as never,
      params: [("0x" + BASE_FEE.toString(16)) as never],
    } as never);
  }

  /** Mine up to EXACTLY the pinned block (latest == pinBlock), pinning the base fee on the last block so
   *  eth_calls against latest see the deterministic gas context. All funding txs must precede this. */
  async function alignToPin(): Promise<void> {
    const latest = (await c.publicClient.getBlock({ blockTag: "latest" })).number!;
    if (latest > pinBlock) throw new Error(`setup consumed past the pin block (${latest} > ${pinBlock}) — raise the genesis headroom`);
    if (latest < pinBlock - 1n) await c.testClient.mine({ blocks: Number(pinBlock - 1n - latest) });
    await pinNextBaseFee();
    await c.testClient.mine({ blocks: 1 }); // latest == pinBlock with basefee == BASE_FEE
  }

  /** The REAL wrapper's LIVE view at a PINNED (from, gasPrice, block-number-override) context. The engine
   *  keys quotes on tx.gasprice AND block.number, and the wrapper forwards its msg.sender to the engine —
   *  so the prefetch must reproduce the EXACT context the cook's staticcalls will run in. */
  async function onView(from: Hex, tokenIn: Hex, tokenOut: Hex, amt: bigint, gasPrice: bigint, blockNumber: bigint): Promise<bigint> {
    const data = encodeFunctionData({ abi: tesseraViewAbi as Abi, functionName: "tesseraSwapViewAmounts", args: [tokenIn, tokenOut, amt] });
    const raw = (await c.publicClient.request({
      method: "eth_call" as never,
      params: [
        { to: etched.fermiSwapper, data, from, gasPrice: ("0x" + gasPrice.toString(16)) } as never,
        "latest" as never,
        {} as never,
        { number: ("0x" + blockNumber.toString(16)) } as never,
      ],
    } as never)) as Hex;
    if (!raw || raw === "0x") return 0n;
    return BigInt("0x" + raw.slice(2 + 64, 2 + 128)); // second word = amountOut
  }

  /** The Fluid PREFETCH pattern: prefetch the REAL etched wrapper's quotes at the DETERMINISTIC QL grid
   *  (tesseraQLGridInputs) — from the cook target, at the cook's gas price, at the COOK BLOCK's number —
   *  and answer by exact-point lookup (the oracle's `getDy` quote model). */
  async function offPool(target: Hex, tokenIn: Hex, tokenOut: Hex, amountIn: bigint, gasPrice: bigint, cookBlock: bigint): Promise<TesseraPool> {
    const grid = tesseraQLGridInputs(amountIn);
    const quotes = new Map<bigint, bigint>();
    for (const x of grid) quotes.set(x, await onView(target, tokenIn, tokenOut, x, gasPrice, cookBlock));
    return {
      address: etched.fermiSwapper, tokenIn, tokenOut, feePpm: 0, source: "prod-mirror-prefetch",
      getDy: (dx: bigint): bigint => {
        const q = quotes.get(dx);
        if (q === undefined) throw new Error(`tessera prefetch grid miss at ${dx}`);
        return q;
      },
    };
  }

  function tesseraPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.fermiSwapper,
          poolType: SwapPoolType.WOOFi, // INERT placeholder (discovery keys off factoryType)
          factoryType: FactoryType.Tessera,
          label: "Local Tessera wrapper (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // ── (a) REAL BYTECODE — byte-equal integrity + the captured probe ladder reproduces wei-exact. ──
  it("etches the REAL TesseraSwap + engine graph (byte-equal) + reproduces the captured probe ladder", async () => {
    await setup();
    // NO-NETWORK integrity tripwire FIRST: every checked-in runtime still hashes to its capture anchor.
    const integ = verifyFermiBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, "every captured runtime sha256 matches its capture anchor");

    for (const cc of snaps.bytecode.contracts) {
      const addr = getAddress(cc.address) as Hex;
      const isToken = ["WETH", "USDC"].some(
        (s) => getAddress(snaps.state.tokens[s].address).toLowerCase() === addr.toLowerCase(),
      );
      if (isToken) continue; // repointed to local MintableERC20s
      const code = await c.publicClient.getCode({ address: addr });
      assert.equal(code?.toLowerCase(), cc.runtime.toLowerCase(), `eth_getCode at ${addr} == captured REAL runtime [${cc.role}]`);
    }

    // The REAL engine's prio-fee knob reads back the captured 2 gwei.
    const engineAddr = getAddress("0x31e99E05fee3DCE580af777C3fD63eE1B3B40c17") as Hex;
    const threshold = (await c.publicClient.readContract({
      address: engineAddr, abi: prioAbi as Abi, functionName: "globalPrioFeeThresholddd1337",
    })) as bigint;
    assert.equal(threshold, 2_000_000_000n, "REAL engine globalPrioFeeThresholddd1337 == 2 gwei (captured)");

    // The captured probe ladder reproduces WEI-EXACT at the capture context (block == pin via override,
    // gasPrice 1 gwei, from == 0xdead — exactly the snapshot's probe context). The strongest single-shot
    // proof the etched graph IS Base mainnet (real engine, real pool state, real block-keyed freshness).
    await alignToPin();
    const dead = getAddress("0x000000000000000000000000000000000000dEaD") as Hex;
    for (const p of snaps.state.probe.target.ladder) {
      const out = await onView(dead, etched.tokenIn, etched.tokenOut, BigInt(p.amountIn), GAS_BELOW, pinBlock);
      assert.equal(out.toString(), p.amountOut, `REAL viewAmounts(WETH ${p.amountIn}) == captured Base ${p.amountOut}`);
    }
    console.log(
      `  [tessera-prod-mirror] REAL bytecode etched (${etched.contractCount} contracts, ${etched.slotCount} slots); ` +
        `treasury ${etched.vault}; threshold=2 gwei; probe ladder reproduced WEI-EXACT @ block ${pinBlock}, 1 gwei`,
    );
  });

  // ── (b) The production discovery→QL-ladder→exec run, wei-exact vs the prefetched oracle + real view. ──
  // `gasPrice` selects the regime — GAS_BELOW is the standard cell; GAS_ABOVE is the prio-fee verdict cell.
  async function runProdMirror(engine: Engine, gasPrice: bigint): Promise<{ received: bigint; spent: bigint }> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const tokenIn = etched.tokenIn; // WETH (local mint at the real address)
    const tokenOut = etched.tokenOut; // USDC
    // 100 WETH ≈ 175.5k USDC — deep inside the ~515k USDC treasury, and LARGE enough that the real
    // curve's per-slice curvature clears USDC's 6-decimal integer rounding (at small sizes consecutive
    // geometric slices quote IDENTICAL integer marginals — a real flat-spread region — and the ladder's
    // strict-descent guard stops early: 2 WETH covers only ~6%, 100 WETH covers 100%, measured on the
    // etched graph). Both the solver and the oracle stop IDENTICALLY (wei-exact either way); the sizing
    // just makes the cell exercise a full-depth ladder.
    const amountIn = 100n * 10n ** 18n;
    const poolConfig = tesseraPoolConfig(tokenIn, tokenOut);

    // ALL funding txs BEFORE the block alignment (nothing may mine between the prefetch and the cook).
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [target as never, "0x8AC7230489E80000" as never],
    } as never);
    await alignToPin(); // latest == pinBlock; the cook will mine pinBlock+1

    // Discovery + compile at env == pinBlock (the venue quotes live there). No blocks are mined.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal(prepared.pools.length, 0, "no direct pools (Tessera-only config)");
    assert.equal((prepared.tesseraPools ?? []).length, 1, "discovered exactly the 1 REAL Tessera venue");
    assert.equal(prepared.tesseraPools![0].address.toLowerCase(), etched.fermiSwapper.toLowerCase(), "the venue IS the etched wrapper");

    // PREFETCH at the COOK BLOCK's context (blockOverrides.number == pinBlock+1; the engine's freshness
    // decay is block-keyed) → oracle (the Fluid pattern).
    const cookBlock = pinBlock + 1n;
    const op = await offPool(target, tokenIn, tokenOut, amountIn, gasPrice, cookBlock);
    const oracle = optimalSplit({ pools: [{ tessera: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the REAL Tessera venue");
    // The ladder's strict-descent guard may fold a flat-marginal tail (a REAL Tessera flat-spread
    // region + 6-dec USDC rounding) — the split stays wei-exact (solver == oracle stop identically);
    // bound the uncovered tail so a gross under-fill (broken ladder/orientation) still fails.
    assert.ok(awarded * 2n >= amountIn, `awarded covers >= 50% of amountIn (awarded=${awarded})`);

    // The REAL wrapper's own pre-swap view of the awarded share at the SAME context — the ground truth
    // for the executed dy (the exec's amountCheck re-reads exactly this inside the cook).
    const onViewPre = await onView(target, tokenIn, tokenOut, awarded, gasPrice, cookBlock);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const treasuryInBefore = await balanceOf(c.publicClient, tokenIn, etched.vault);

    await pinNextBaseFee(); // the cook block's base fee == BASE_FEE (the prefetch env's base fee)
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes, undefined, gasPrice);
    assert.equal(receipt.status, "success", `cook() must succeed against the REAL Tessera engine @ ${gasPrice} wei gas`);
    assert.equal(receipt.blockNumber, cookBlock, "the cook landed in the predicted (prefetched) block");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const treasuryIn = (await balanceOf(c.publicClient, tokenIn, etched.vault)) - treasuryInBefore;

    assert.equal(spent, awarded, "on-chain spent == prefetched-oracle awarded (wei-exact)");
    assert.equal(treasuryIn, spent, "the REAL wrapper routed the input into the treasury (approve + transferFrom)");
    assert.equal(received, onViewPre, "received == REAL wrapper pre-swap viewAmounts(awarded)[1] (wei-exact-vs-live-quote)");
    assert.ok(received > 0n, "caller receives tokenOut from the treasury");

    const ms = Date.now() - t0;
    console.log(
      `  [tessera-prod-mirror:${engine}@${gasPrice}wei] WEI-EXACT — spent=${spent} received=${received} ` +
        `(== real view @ block ${cookBlock}); wall-clock ${ms} ms (no fork, no RPC)`,
    );
    return { received, spent };
  }

  // ── (c) DRIFT — move the REAL engine state with a GENUINE swap, then cook the PRE-drift bytecodes. ──
  async function runDrift(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    const amountIn = 100n * 10n ** 18n;
    const poolConfig = tesseraPoolConfig(tokenIn, tokenOut);

    // Fund EVERYTHING first (cook input + the drift swap's input + approvals), then align.
    const driftAmt = 50n * 10n ** 18n;
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn + driftAmt);
    await approve(c.walletClient, c.publicClient, tokenIn, etched.fermiSwapper, driftAmt);
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [target as never, "0x8AC7230489E80000" as never],
    } as never);
    await alignToPin(); // latest == pinBlock

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal((prepared.tesseraPools ?? []).length, 1, "discovered the REAL Tessera venue");

    // GENUINE drift: a REAL tesseraSwapWithAllowances (50 WETH) through the REAL engine — mines
    // pinBlock+1; the engine/pool state mutates (the same live state the cook's ladder will read).
    await pinNextBaseFee();
    const driftHash = await c.walletClient.writeContract({
      address: etched.fermiSwapper, abi: tesseraViewAbi as Abi, functionName: "tesseraSwapWithAllowances",
      args: [tokenIn, tokenOut, driftAmt, 0n, caller, "0x"], account: c.walletClient.account as Account,
      chain: c.walletClient.chain, gas: 30_000_000n, gasPrice: GAS_BELOW,
    });
    const driftReceipt = await c.publicClient.waitForTransactionReceipt({ hash: driftHash });
    assert.equal(driftReceipt.status, "success", "the REAL drift swap lands on the etched engine");

    // Re-prefetch the POST-drift grid at the (new) cook block — the oracle the PRE-drift bytecodes must
    // re-anchor to.
    const cookBlock = pinBlock + 2n;
    const opDrift = await offPool(target, tokenIn, tokenOut, amountIn, GAS_BELOW, cookBlock);
    const oracleDrift = optimalSplit({ pools: [{ tessera: opDrift, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awardedDrift = oracleDrift.perPoolInput[0] ?? 0n;
    const onViewDrift = await onView(target, tokenIn, tokenOut, awardedDrift, GAS_BELOW, cookBlock);

    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    await pinNextBaseFee();
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes, undefined, GAS_BELOW);
    assert.equal(receipt.status, "success", "PRE-drift bytecodes cook successfully after a REAL state move");
    assert.equal(receipt.blockNumber, cookBlock, "the cook landed in the predicted (prefetched) block");
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(received, onViewDrift, "received == the POST-drift live view of the awarded share (re-anchored, wei-exact)");
    console.log(`  [tessera-prod-mirror drift:${engine}] real 50-WETH drift swap, then pre-drift cook — received=${received} == post-drift view (re-anchored)`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Tessera engine [${engine}] — BELOW the prio-fee threshold, wei-exact, offline`, { skip }, async () => {
      await runProdMirror(engine, GAS_BELOW);
    });
    it(`PRIO-FEE VERDICT [${engine}] — cook ABOVE the REAL 2-gwei threshold LANDS, wei-exact at its own gas context`, { skip }, async () => {
      // The ship-blocker cell: the REAL engine may shift the quote sub-bp above the knob but NEVER
      // reverts; quote+exec read the SAME tx.gasprice so the fill is wei-exact vs the same-regime prefetch.
      const above = await runProdMirror(engine, GAS_ABOVE);
      assert.ok(above.received > 0n, "above-threshold cook landed with a non-zero fill (no guard needed)");
    });
    it(`REAL-swap drift re-anchor [${engine}] — pre-drift bytecodes re-anchor to the moved engine state`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});
