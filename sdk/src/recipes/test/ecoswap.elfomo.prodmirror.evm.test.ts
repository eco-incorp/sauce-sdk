/**
 * EcoSwap ElfomoFi (a vault-funded PMM priced by an on-chain pricing module + oracle feed) PROD-MIRROR —
 * REAL BYTECODE, NO FORK, OFFLINE.
 *
 * Unlike ecoswap.elfomo.evm.test.ts (which deploys a MOCK ElfomoFi.sol fixture), this test stands up the
 * GENUINE Base-mainnet wrapper + pricing proxy/impl + sub-modules + oracle feed + vault graph captured
 * from Base (harness/elfomo-snapshot.ts — emitted FERMI-SHAPED, so the whole fermi harness is reused
 * verbatim: loadFermiSnapshots / verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp / etchFermiGraph),
 * and runs the swap against it — proving the production discovery + QL-ladder + execution path works on
 * the REAL contracts, with NO fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * ── THE STALENESS CUTOFF (why block.timestamp is PINNED) ───────────────────────────────────────────────
 * The REAL pricing hard-zeroes quotes once block.timestamp is ~5–30 s past the oracle feed's last update
 * (fork-measured). The feed's price slots are byte-identical fresh-vs-stale — only the clock gates — so
 * pinning block.timestamp to the captured block ts (pinFermiBlockTimestamp; the feed is ≤ ~2 s old there)
 * reproduces the EXACT real quote. Differential-verified: the etched graph quotes the captured Base value
 * BIT-FOR-BIT with only the clock pinned, and is BLOCK-NUMBER-INSENSITIVE (unlike Tessera) — quotes are
 * identical from pin−250 through pin+100.
 *
 * ── QUOTE-LADDER fidelity (the Fluid PREFETCH pattern) ─────────────────────────────────────────────────
 * Elfomo has NO off-chain closed form (the pricing impl is unverified), so the neutral oracle's
 * ElfomoPool model prefetches the REAL etched wrapper's LIVE getAmountOut quotes at the DETERMINISTIC
 * direct-venue QL grid (elfomoQLGridInputs == qlLadderInputs — the exact points the on-chain solver's
 * ladder staticcalls) FROM THE COOK TARGET (the pricing keys quotes by the wrapper's msg.sender) and
 * answers by exact-point lookup — solver == oracle wei-exact BY CONSTRUCTION.
 *
 * Cells: (a) byte-equal integrity + captured-probe-ladder reproduction (wei-exact), (b) the production
 * discovery→QL→exec run wei-exact vs the prefetched oracle + real view (the REAL Elfomo curve is
 * genuinely SHALLOW — it collapses its marginal well inside the vault inventory, so the ladder's
 * strict-descent guard folds the flat tail; the split stays wei-exact and the covered fraction is
 * asserted ≥ 40%, measured 51% at the 20-WETH sizing), (c) a REAL-swap DRIFT cell (move the pricing
 * state with a genuine swap — pricing.update writes — then cook the PRE-drift bytecodes; the live ladder
 * re-anchors).
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE. Run:
 *   npx tsx --test src/recipes/test/ecoswap.elfomo.prodmirror.evm.test.ts
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
import { elfomoQLGridInputs, type ElfomoPool } from "../shared/elfomo-math";

const SNAP_NAME = "base-elfomo-WETHUSDC";
const ENGINE_CELLS = engineCells();

const elfomoAbi = parseAbi([
  "function getAmountOut(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)",
  "function getSupportedPairs() view returns ((address tokenA, address tokenB)[])",
  "function swap(address fromToken, address toToken, int256 specifiedAmount, uint256 limitAmount, address receiver, uint256 partnerId)",
]);

describe("EcoSwap ElfomoFi (vault-funded PMM + pricing module) prod-mirror — REAL bytecode, no fork, offline", () => {
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
    // High-genesis boot for uniformity with the Tessera prod-mirror (Elfomo is block-INSENSITIVE —
    // differential-verified — but a realistic block number costs nothing and keeps the pattern one).
    anvil = await startAnvil({ initGenesisNumber: pinBlock - 300n });
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    etched = await etchFermiGraph(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: 100n * 10n ** 18n, // 100 WETH headroom (the 20-WETH cook + the 10-WETH drift swap)
    });
    // Pin block.timestamp to the captured ts — the REAL pricing hard-zeroes past the ~5–30 s feed
    // staleness window (the Fermi StaleUpdate class, graceful-0 flavored).
    await pinFermiBlockTimestamp(c.testClient as never, snaps.state);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** The REAL wrapper's LIVE view FROM a given sender (the pricing keys quotes by the wrapper's
   *  msg.sender — the cook's staticcalls originate from the cook target) AT a given block-number
   *  override. The PRISTINE pricing state is block-insensitive (differential-verified), but AFTER a
   *  trade the pricing's recent-trade state makes quotes BLOCK-KEYED (the drift cell measured it) — so
   *  every prefetch reads at the PREDICTED COOK BLOCK's number via eth_call blockOverrides (anvil
   *  honors them; the same mechanism the Tessera prod-mirror pins). */
  async function onView(from: Hex, tokenIn: Hex, tokenOut: Hex, amt: bigint, blockNumber: bigint): Promise<bigint> {
    const data = encodeFunctionData({ abi: elfomoAbi as Abi, functionName: "getAmountOut", args: [tokenIn, tokenOut, amt] });
    const raw = (await c.publicClient.request({
      method: "eth_call" as never,
      params: [
        { to: etched.fermiSwapper, data, from } as never,
        "latest" as never,
        {} as never,
        { number: ("0x" + blockNumber.toString(16)) } as never,
      ],
    } as never)) as Hex;
    if (!raw || raw === "0x") return 0n;
    return BigInt("0x" + raw.slice(2, 2 + 64));
  }

  /** The Fluid PREFETCH pattern: prefetch the REAL etched wrapper's quotes at the DETERMINISTIC QL grid
   *  (elfomoQLGridInputs), from the cook target, at the cook block's number, and answer by exact-point
   *  lookup. */
  async function offPool(target: Hex, tokenIn: Hex, tokenOut: Hex, amountIn: bigint, cookBlock: bigint): Promise<ElfomoPool> {
    const grid = elfomoQLGridInputs(amountIn);
    const quotes = new Map<bigint, bigint>();
    for (const x of grid) quotes.set(x, await onView(target, tokenIn, tokenOut, x, cookBlock));
    return {
      address: etched.fermiSwapper, tokenIn, tokenOut, feePpm: 0, source: "prod-mirror-prefetch",
      getDy: (dx: bigint): bigint => {
        const q = quotes.get(dx);
        if (q === undefined) throw new Error(`elfomo prefetch grid miss at ${dx}`);
        return q;
      },
    };
  }

  function elfomoPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.fermiSwapper,
          poolType: SwapPoolType.WOOFi, // INERT placeholder (discovery keys off factoryType)
          factoryType: FactoryType.Elfomo,
          label: "Local Elfomo wrapper (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // ── (a) REAL BYTECODE — byte-equal integrity + the captured probe ladder reproduces wei-exact. ──
  it("etches the REAL ElfomoFi + pricing graph (byte-equal) + reproduces the captured probe ladder", async () => {
    await setup();
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

    // The REAL getSupportedPairs enumerates the captured pair set (the production discovery surface).
    const pairs = (await c.publicClient.readContract({
      address: etched.fermiSwapper, abi: elfomoAbi as Abi, functionName: "getSupportedPairs",
    })) as readonly { tokenA: Hex; tokenB: Hex }[];
    assert.ok(
      pairs.some(
        (p) =>
          (p.tokenA.toLowerCase() === etched.tokenIn.toLowerCase() && p.tokenB.toLowerCase() === etched.tokenOut.toLowerCase()) ||
          (p.tokenB.toLowerCase() === etched.tokenIn.toLowerCase() && p.tokenA.toLowerCase() === etched.tokenOut.toLowerCase()),
      ),
      "REAL getSupportedPairs lists WETH/USDC",
    );

    // The captured probe ladder reproduces WEI-EXACT (only the clock is pinned — no price fabricated).
    for (const p of snaps.state.probe.target.ladder) {
      const out = await onView("0x000000000000000000000000000000000000dEaD" as Hex, etched.tokenIn, etched.tokenOut, BigInt(p.amountIn), pinBlock);
      assert.equal(out.toString(), p.amountOut, `REAL getAmountOut(WETH ${p.amountIn}) == captured Base ${p.amountOut}`);
    }
    console.log(
      `  [elfomo-prod-mirror] REAL bytecode etched (${etched.contractCount} contracts, ${etched.slotCount} slots); ` +
        `vault ${etched.vault}; getSupportedPairs + probe ladder reproduced WEI-EXACT`,
    );
  });

  // ── (b) The production discovery→QL-ladder→exec run, wei-exact vs the prefetched oracle + real view. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const tokenIn = etched.tokenIn; // WETH (local mint at the real address)
    const tokenOut = etched.tokenOut; // USDC
    // 20 WETH: the REAL Elfomo curve is genuinely SHALLOW (its marginal collapses well inside the ~64k
    // USDC vault inventory), so the QL ladder's strict-descent guard folds the flat tail — measured 51%
    // coverage at this size (the best across 2–30 WETH). The split stays wei-exact (solver == oracle
    // stop identically); the coverage floor below guards a gross under-fill.
    const amountIn = 20n * 10n ** 18n;
    const poolConfig = elfomoPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal(prepared.pools.length, 0, "no direct pools (Elfomo-only config)");
    assert.equal((prepared.elfomoPools ?? []).length, 1, "discovered exactly the 1 REAL Elfomo venue (via getSupportedPairs)");
    assert.equal(prepared.elfomoPools![0].address.toLowerCase(), etched.fermiSwapper.toLowerCase(), "the venue IS the etched wrapper");

    // PREFETCH the REAL wrapper's quote grid (the Fluid pattern) at the PREDICTED cook block → oracle.
    const cookBlock = ((await c.publicClient.getBlock({ blockTag: "latest" })).number ?? 0n) + 1n;
    const op = await offPool(target, tokenIn, tokenOut, amountIn, cookBlock);
    const oracle = optimalSplit({ pools: [{ elfomo: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the REAL Elfomo venue");
    assert.ok(awarded * 5n >= amountIn * 2n, `awarded covers >= 40% of amountIn (awarded=${awarded} — the real shallow-curve fold)`);

    const onViewPre = await onView(target, tokenIn, tokenOut, awarded, cookBlock);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, etched.vault);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL ElfomoFi bytecode");
    assert.equal(receipt.blockNumber, cookBlock, "the cook landed in the predicted (prefetched) block");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const vaultIn = (await balanceOf(c.publicClient, tokenIn, etched.vault)) - vaultInBefore;

    assert.equal(spent, awarded, "on-chain spent == prefetched-oracle awarded (wei-exact)");
    assert.equal(vaultIn, spent, "the REAL wrapper routed the input into the vault (approve + transferFrom)");
    assert.equal(received, onViewPre, "received == REAL wrapper pre-swap getAmountOut(awarded) (wei-exact-vs-live-quote)");
    assert.ok(received > 0n, "caller receives tokenOut from the vault");
    // RESIDUE SWEEP (the Metric USDT-class lesson): the exec arm raw-approves the UNVERIFIED Elfomo
    // wrapper for the awarded Σ — the counterparty class that COULD pull less than approved (the Metric
    // partial-fill lesson). Probed on this REAL bytecode: even a 100k-WETH capped-output oversize pulled
    // the FULL input with residue 0 — pull == approve always. Assert the allowance is 0 after the cook.
    const residue = (await c.publicClient.readContract({
      address: tokenIn, abi: parseAbi(["function allowance(address, address) view returns (uint256)"]) as Abi,
      functionName: "allowance", args: [target, etched.fermiSwapper],
    })) as bigint;
    assert.equal(residue, 0n, "no Elfomo wrapper allowance residue on the REAL bytecode (pull == approve)");

    const ms = Date.now() - t0;
    console.log(
      `  [elfomo-prod-mirror:${engine}] WEI-EXACT — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded} of ${amountIn}); wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  // ── (c) DRIFT — move the REAL pricing state with a GENUINE swap (pricing.update writes), then cook
  // the PRE-drift bytecodes — the live ladder re-anchors to the post-drift state, wei-exact. ──
  async function runDrift(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    const amountIn = 20n * 10n ** 18n;
    const poolConfig = elfomoPoolConfig(tokenIn, tokenOut);

    const driftAmt = 10n * 10n ** 18n;
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn + driftAmt);
    await approve(c.walletClient, c.publicClient, tokenIn, etched.fermiSwapper, driftAmt);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal((prepared.elfomoPools ?? []).length, 1, "discovered the REAL Elfomo venue");

    // GENUINE drift: a REAL swap (10 WETH) through the REAL wrapper — pricing.update + the vault
    // inventory move (the same live state the cook's ladder reads).
    const driftHash = await c.walletClient.writeContract({
      address: etched.fermiSwapper, abi: elfomoAbi as Abi, functionName: "swap",
      args: [tokenIn, tokenOut, driftAmt, 0n, caller, 0n], account: c.walletClient.account as Account,
      chain: c.walletClient.chain, gas: 5_000_000n,
    });
    const driftReceipt = await c.publicClient.waitForTransactionReceipt({ hash: driftHash });
    assert.equal(driftReceipt.status, "success", "the REAL drift swap lands on the etched wrapper");

    // Re-prefetch the POST-drift grid at the (new) predicted cook block — after a trade the pricing's
    // recent-trade state makes quotes BLOCK-KEYED, so the override is what keeps this wei-exact.
    const cookBlock = ((await c.publicClient.getBlock({ blockTag: "latest" })).number ?? 0n) + 1n;
    const opDrift = await offPool(target, tokenIn, tokenOut, amountIn, cookBlock);
    const oracleDrift = optimalSplit({ pools: [{ elfomo: opDrift, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awardedDrift = oracleDrift.perPoolInput[0] ?? 0n;
    const onViewDrift = await onView(target, tokenIn, tokenOut, awardedDrift, cookBlock);

    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "PRE-drift bytecodes cook successfully after a REAL state move");
    assert.equal(receipt.blockNumber, cookBlock, "the cook landed in the predicted (prefetched) block");
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(received, onViewDrift, "received == the POST-drift live view of the awarded share (re-anchored, wei-exact)");
    console.log(`  [elfomo-prod-mirror drift:${engine}] real 10-WETH drift swap, then pre-drift cook — received=${received} == post-drift view (re-anchored)`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL ElfomoFi bytecode [${engine}] — wei-exact vs the prefetched oracle + real view, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
    it(`REAL-swap drift re-anchor [${engine}] — pre-drift bytecodes re-anchor to the moved pricing state`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});
