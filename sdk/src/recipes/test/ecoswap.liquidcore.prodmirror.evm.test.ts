/**
 * EcoSwap LIQUIDCORE (Liquid Labs, HyperEVM) PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE, BOTH
 * DIRECTIONS. The LiquidCore router + per-pair pool are UNVERIFIED upgradeable proxies (probe-proven
 * surface only), so the genuine etched runtime is the only way to prove the production discovery +
 * QL-ladder + approve-POOL exec path against the real proxy dispatch + imbalance-fee curve.
 *
 * Unlike ecoswap.liquidcore.evm.test.ts (which deploys the LiquidCorePool/Router .sol fixtures),
 * this test stands up the GENUINE HyperEVM-mainnet graph captured by harness/liquidcore-snapshot.ts
 * — router proxy + impl, the WHYPE/USDT0 pool proxy + impls, and the pool's captured internal
 * reserve accounting (getReserves ≠ token balances — the accounting rides the captured slots; the
 * payout inventory is the re-funded token balances) — via the fermi harness verbatim (the snapshot
 * is FERMI-SHAPED: fermiSwapper = the ROUTER, vault = the POOL), PLUS the family's one
 * chain-specific etch: the HLBboPrecompileMock at the CANONICAL HyperEVM BBO read-precompile
 * address (0x…080e), seeded with the REAL captured Hyperliquid books (`lcBbo`) — the pool's REAL
 * bytecode then prices exactly as it does on HyperEVM (the precompile is L1-native and codeless on
 * any EVM chain, so the mock IS the production integration pattern).
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────────────────────────────
 * The REAL pool's quote is a PURE FUNCTION of (pool storage, token balances, BBO books) — probed
 * invariant across +52 blocks and +1 day of clock (harness/liquidcore-snapshot.ts header). The
 * capture's canonical probe ladders are the mocked-fork quotes at the frozen captured books, so this
 * test reproduces them WEI-EXACT (no tolerance). The clock is still pinned for hygiene.
 *
 * Cells (× v1/v12 via ECO_ENGINE):
 *   (a) INTEGRITY — every checked-in runtime hashes to its capture anchor, eth_getCode matches
 *       byte-for-byte, and BOTH captured canonical ladders (incl. the OVERSIZE capped points — the
 *       asymptotic inventory saturation) reproduce WEI-EXACT off the etched graph + seeded books.
 *   (b) The production discovery→QL→exec run FORWARD (WHYPE→USDT0) — router-enumerated discovery
 *       (getPoolForPair on the REAL router), wei-exact vs the prefetched-grid oracle + the real
 *       pool's own estimateSwap; pull == approve; residue == 0.
 *   (c) The SAME run in REVERSE (USDT0→WHYPE).
 *   (d) OVERSIZE / CAPPED-OUTPUT — an award against the saturating output inventory on the REAL
 *       curve: the ladder truncates, the cook spends exactly the award, the pool pulls it IN FULL
 *       (the fork-proven pull == approve class), residue == 0.
 *   (e) DRIFT — a REAL swap through the etched pool moves the inventory + internal accounting (the
 *       adaptive imbalance fee), then the PRE-drift bytecodes cook: the live ladder RE-ANCHORS
 *       (spent == the post-drift oracle award; received == the post-drift live quote).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.liquidcore.prodmirror.evm.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAbi,
  getAddress,
  keccak256,
  encodeAbiParameters,
  pad,
  toHex,
  type Abi,
  type Account,
  type Hex,
} from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { ensureMulticall3, deployStack, approve, balanceOf, HL_BBO_ADDRESS, type DeployedStack, type DeployedV12Stack } from "./harness/setup";
import { loadDeployedBytecode } from "./harness/artifacts";
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
import { qlLadderInputs } from "../shared/curve-math";
import { type LiquidCorePool } from "../shared/liquidcore-math";

const SNAP_NAME = "hyperevm-liquidcore-WHYPEUSDT0";
const ENGINE_CELLS = engineCells();
const __dirname = dirname(fileURLToPath(import.meta.url));

const poolAbi = parseAbi([
  "function estimateSwap(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  "function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) returns (uint256)",
  "function getTokens() view returns (address, address)",
]);
const routerAbi = parseAbi(["function getPoolForPair(address, address) view returns (address)"]);
const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

describe("EcoSwap LIQUIDCORE prod-mirror — REAL router+pool proxy graph + captured Hyperliquid books, no fork, offline", () => {
  const snaps = loadFermiSnapshots(SNAP_NAME);
  const ROUTER = getAddress(snaps.state.fermiSwapper) as Hex;
  const POOL = getAddress(snaps.state.lcPool!) as Hex;
  const WHYPE = getAddress(snaps.state.tokens.WHYPE.address) as Hex;
  const USDT0 = getAddress(snaps.state.tokens.USDT0.address) as Hex;

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedFermiGraph;

  /** Etch the HLBboPrecompileMock at the CANONICAL 0x…080e + seed the REAL captured books (tx-free:
   *  setCode from the forge artifact's runtime + setStorageAt the two mapping slots per index). */
  async function etchBboBooks(): Promise<void> {
    const runtime = loadDeployedBytecode(
      join(__dirname, "fixtures", "out", "HLBboPrecompileMock.sol", "HLBboPrecompileMock.json"),
    );
    await c.testClient.setCode({ address: HL_BBO_ADDRESS, bytecode: runtime });
    for (const [idx, book] of Object.entries(snaps.state.lcBbo!)) {
      const bidSlot = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(idx), 0n]));
      const askSlot = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(idx), 1n]));
      await c.testClient.setStorageAt({ address: HL_BBO_ADDRESS, index: bidSlot, value: pad(toHex(BigInt(book.bid)), { size: 32 }) });
      await c.testClient.setStorageAt({ address: HL_BBO_ADDRESS, index: askSlot, value: pad(toHex(BigInt(book.ask)), { size: 32 }) });
    }
  }

  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    etched = await etchFermiGraph(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: 10n ** 24n, // WHYPE (18 dec) cooks + USDT0 (6 dec) reverse cooks + the drift swap
    });
    await etchBboBooks();
    await pinFermiBlockTimestamp(c.testClient as never, snaps.state);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** The etched REAL pool's LIVE estimateSwap (probe-then-decode: revert ⇒ 0, the drained class). */
  async function onQuote(tokenIn: Hex, tokenOut: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient
      .readContract({ address: POOL, abi: poolAbi as Abi, functionName: "estimateSwap", args: [tokenIn, tokenOut, amt] })
      .catch(() => 0n)) as bigint;
  }

  /** The Fluid/Metric PREFETCH pattern: quote the REAL etched pool at the DETERMINISTIC QL grid,
   *  answer by exact-point lookup — the oracle's getDy model (0 ⇒ unquotable, ladder truncates in
   *  lockstep with the on-chain probe-then-decode build). */
  async function offPool(tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<LiquidCorePool> {
    const grid = qlLadderInputs(amountIn);
    const quotes = new Map<bigint, bigint>();
    for (const x of grid) quotes.set(x, await onQuote(tokenIn, tokenOut, x));
    return {
      address: POOL, router: ROUTER, tokenIn, tokenOut, feePpm: 0, source: "prod-mirror-prefetch",
      getDy: (dx: bigint): bigint => {
        const q = quotes.get(dx);
        if (q === undefined) throw new Error(`liquidcore prefetch grid miss at ${dx}`);
        return q;
      },
    };
  }

  function lcPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: ROUTER,
          poolType: SwapPoolType.UniV2, // INERT placeholder (discovery keys off factoryType)
          factoryType: FactoryType.LiquidCore,
          label: "Local LiquidCore (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  async function allowanceOf(token: Hex, owner: Hex, spender: Hex): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: token, abi: allowanceAbi as Abi, functionName: "allowance", args: [owner, spender],
    })) as bigint;
  }

  // ── (a) REAL BYTECODE — integrity + BOTH canonical ladders (incl. the oversize capped points). ──
  it("etches the REAL LiquidCore router+pool proxy graph (byte-equal) + reproduces BOTH captured ladders WEI-EXACT off the seeded books", async () => {
    await setup();
    const integ = verifyFermiBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, "every captured runtime sha256 matches its capture anchor");

    for (const cc of snaps.bytecode.contracts) {
      const addr = getAddress(cc.address) as Hex;
      const isToken = ["WHYPE", "USDT0"].some(
        (sym) => getAddress(snaps.state.tokens[sym].address).toLowerCase() === addr.toLowerCase(),
      );
      if (isToken) continue; // repointed to local MintableERC20s
      const code = await c.publicClient.getCode({ address: addr });
      assert.equal(code?.toLowerCase(), cc.runtime.toLowerCase(), `eth_getCode at ${addr} == captured REAL runtime [${cc.role}]`);
    }

    // The REAL router's discovery surface answers off the etched storage (UNORDERED, both orders).
    for (const [a, b] of [[WHYPE, USDT0], [USDT0, WHYPE]] as const) {
      const p = (await c.publicClient.readContract({
        address: ROUTER, abi: routerAbi as Abi, functionName: "getPoolForPair", args: [a, b],
      })) as Hex;
      assert.equal(p.toLowerCase(), POOL.toLowerCase(), "REAL router.getPoolForPair resolves the etched pool (unordered)");
    }

    // BOTH canonical ladders reproduce WEI-EXACT — the pool's quote is a pure function of the etched
    // state + the seeded books (determinism probed at capture), so NO tolerance. The tails are the
    // OVERSIZE capped class (1e24 WHYPE / 1e15 USDT0 quote the saturated inventory asymptote).
    for (const [dir, tin, tout, ladder] of [
      ["fwd", WHYPE, USDT0, snaps.state.probe.target.ladder],
      ["rev", USDT0, WHYPE, snaps.state.probe.second!.ladder],
    ] as const) {
      for (const p of ladder) {
        const got = await onQuote(tin, tout, BigInt(p.amountIn));
        const want = p.amountOut === "REVERT" ? 0n : BigInt(p.amountOut);
        assert.equal(got, want, `REAL estimateSwap ${dir}(${p.amountIn}) == captured canonical ${p.amountOut}`);
      }
    }
    console.log(
      `  [lc-prod-mirror] REAL bytecode etched (${etched.contractCount} contracts, ${etched.slotCount} slots); ` +
        `inventory ${snaps.state.vault.reserves.WHYPE} WHYPE / ${snaps.state.vault.reserves.USDT0} USDT0; ` +
        `books ${Object.entries(snaps.state.lcBbo!).map(([i, b]) => `${i}:(${b.bid},${b.ask})`).join(" ")}; ` +
        `BOTH ladders wei-exact @ pinned ts ${snaps.state.blockTimestamp}`,
    );
  });

  // ── (b)/(c) The production discovery→QL→exec run, either direction, wei-exact. ──
  async function runProdMirror(engine: Engine, forward: boolean): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // FORWARD: 20 WHYPE ≈ 1392 USDT0 — well inside the ~3505-USDT0 payout inventory. REVERSE:
    // 1000 USDT0 ≈ 14.3 WHYPE — well inside the ~883-WHYPE side.
    const tokenIn = forward ? WHYPE : USDT0;
    const tokenOut = forward ? USDT0 : WHYPE;
    const amountIn = forward ? 20n * 10n ** 18n : 1_000n * 10n ** 6n;
    const poolConfig = lcPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [target as never, "0x8AC7230489E80000" as never],
    } as never);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal(prepared.pools.length, 0, "no direct pools (LiquidCore-only config)");
    assert.equal((prepared.liquidCorePools ?? []).length, 1, "discovered exactly the 1 REAL LiquidCore venue");
    const venue = prepared.liquidCorePools![0];
    assert.equal(venue.address.toLowerCase(), POOL.toLowerCase(), "the venue IS the etched pool (the claim key)");
    assert.equal(venue.router.toLowerCase(), ROUTER.toLowerCase(), "the descriptor carries the etched ROUTER");
    assert.equal(venue.fromToken.toLowerCase(), tokenIn.toLowerCase(), "descriptor fromToken == the edge from-token");
    assert.equal(venue.toToken.toLowerCase(), tokenOut.toLowerCase(), "descriptor toToken == the edge to-token");

    const op = await offPool(tokenIn, tokenOut, amountIn);
    const oracle = optimalSplit({ pools: [{ liquidcore: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the REAL LiquidCore venue");
    const onViewPre = await onQuote(tokenIn, tokenOut, awarded);
    assert.ok(onViewPre > 0n, "the awarded share quotes live");

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, POOL);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `cook() must succeed against the REAL LiquidCore graph (${forward ? "fwd" : "REV"})`);

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, POOL)) - poolInBefore;

    assert.equal(spent, awarded, "on-chain spent == prefetched-oracle awarded (wei-exact)");
    assert.equal(poolIn, spent, "the REAL pool pulled EXACTLY the award via transferFrom (pull == approve)");
    assert.equal(received, onViewPre, "received == REAL pool pre-cook estimateSwap(awarded) (wei-exact-vs-live-quote)");
    assert.equal(await allowanceOf(tokenIn, target, POOL), 0n, "no pool allowance residue (pull == approve always)");

    const ms = Date.now() - t0;
    console.log(
      `  [lc-prod-mirror:${engine}:${forward ? "fwd" : "REV"}] WEI-EXACT — spent=${spent} received=${received} ` +
        `(== real estimateSwap); wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  // ── (d) OVERSIZE / CAPPED-OUTPUT — the pull == approve edge on the REAL saturating curve. ──
  async function runOversize(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = WHYPE;
    const tokenOut = USDT0;
    // 500 WHYPE ≈ 34.8k USDT0 linear-cross demand ≫ the ~3505-USDT0 inventory: the REAL asymptotic
    // imbalance curve caps the output and the QL ladder's non-descending-head guard truncates.
    const amountIn = 500n * 10n ** 18n;
    const poolConfig = lcPoolConfig(tokenIn, tokenOut);

    const { bytecodes } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    const op = await offPool(tokenIn, tokenOut, amountIn);
    const oracle = optimalSplit({ pools: [{ liquidcore: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "the truncated ladder still awards its head");
    const onViewPre = await onQuote(tokenIn, tokenOut, awarded);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, POOL);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "oversize cook() must succeed (capped output, never a revert)");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, POOL)) - poolInBefore;

    assert.equal(spent, awarded, "spent == the truncated-ladder award (the un-awarded remainder never left the caller)");
    // THE RESIDUE-SWEEP EDGE (fork-proven, now pinned on the REAL bytecode): even against a capped
    // output the pool pulls 100% of the input — pull == approve, residue == 0.
    assert.equal(poolIn, spent, "the REAL pool pulled the FULL award even at the capped-output edge");
    assert.equal(received, onViewPre, "received == the capped live quote of the award (wei-exact)");
    assert.equal(await allowanceOf(tokenIn, target, POOL), 0n, "no allowance residue at the capped-output edge");
    console.log(
      `  [lc-prod-mirror oversize:${engine}] amountIn=${amountIn} awarded=${awarded} received=${received} ` +
        `(REAL saturating curve; pull == approve; residue 0)`,
    );
  }

  // ── (e) DRIFT — a REAL swap through the etched pool, then the PRE-drift bytecodes re-anchor. ──
  async function runDrift(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = WHYPE;
    const tokenOut = USDT0;
    const amountIn = 20n * 10n ** 18n;
    const poolConfig = lcPoolConfig(tokenIn, tokenOut);

    const { bytecodes } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    const baselineQuote = await onQuote(tokenIn, tokenOut, amountIn);

    // GENUINE drift: a REAL 10-WHYPE swap through the REAL pool — the inventory + the internal
    // accounting move (the adaptive imbalance fee reads both), exactly the live state the cook's
    // ladder re-reads. Sized to move the curve visibly while leaving the ~3.5k-USDT0 payout side
    // deep enough that the post-drift ladder still allocates (a 50-WHYPE drift nearly drains it —
    // the saturating curve then quotes a sub-head first slice and the ladder self-truncates to 0).
    // Wei-exactness bonus: the swap pays exactly its own pre-swap quote.
    const driftAmt = 10n * 10n ** 18n;
    const driftQuote = await onQuote(tokenIn, tokenOut, driftAmt);
    assert.ok(driftQuote > 0n, "the drift size quotes live");
    await approve(c.walletClient, c.publicClient, tokenIn, POOL, driftAmt);
    const outBeforeDrift = await balanceOf(c.publicClient, tokenOut, caller);
    const driftHash = await c.walletClient.writeContract({
      address: POOL, abi: poolAbi as Abi, functionName: "swap",
      args: [tokenIn, tokenOut, driftAmt, driftQuote], account: c.walletClient.account as Account,
      chain: c.walletClient.chain, gas: 5_000_000n,
    });
    const driftReceipt = await c.publicClient.waitForTransactionReceipt({ hash: driftHash });
    assert.equal(driftReceipt.status, "success", "the REAL drift swap lands on the etched pool");
    assert.equal(
      (await balanceOf(c.publicClient, tokenOut, caller)) - outBeforeDrift, driftQuote,
      "the REAL drift swap paid EXACTLY its pre-swap quote (genuine-bytecode wei-exactness)",
    );

    // Re-prefetch the POST-drift grid — the moved curve the PRE-drift bytecodes must re-anchor to.
    const opDrift = await offPool(tokenIn, tokenOut, amountIn);
    const oracleDrift = optimalSplit({ pools: [{ liquidcore: opDrift, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awardedDrift = oracleDrift.perPoolInput[0] ?? 0n;
    assert.ok(awardedDrift > 0n, "post-drift oracle still allocates");
    const postDriftQuote = await onQuote(tokenIn, tokenOut, amountIn);
    assert.ok(postDriftQuote < baselineQuote, `the REAL swap moved the curve (${postDriftQuote} < ${baselineQuote})`);
    const onViewDrift = await onQuote(tokenIn, tokenOut, awardedDrift);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "PRE-drift bytecodes cook successfully after the REAL inventory move");
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(spent, awardedDrift, "spent == the POST-drift oracle award (re-anchored, wei-exact)");
    assert.equal(received, onViewDrift, "received == the POST-drift live quote of the award (re-anchored, wei-exact)");
    assert.equal(await allowanceOf(tokenIn, target, POOL), 0n, "no allowance residue after the drift cook");
    console.log(
      `  [lc-prod-mirror drift:${engine}] real 10-WHYPE swap moved the curve (${baselineQuote} → ${postDriftQuote}); ` +
        `pre-drift cook spent=${spent} received=${received} (re-anchored)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL LiquidCore graph FORWARD (WHYPE→USDT0) [${engine}] — wei-exact, offline`, { skip }, async () => {
      await runProdMirror(engine, true);
    });
    it(`runs EcoSwap through the REAL LiquidCore graph REVERSE (USDT0→WHYPE) [${engine}] — wei-exact, offline`, { skip }, async () => {
      await runProdMirror(engine, false);
    });
    it(`REAL oversize / capped-output [${engine}] — pull == approve at the saturation edge, residue 0`, { skip }, async () => {
      await runOversize(engine);
    });
    it(`REAL-swap drift re-anchor [${engine}] — pre-drift bytecodes re-anchor to the moved curve`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});
