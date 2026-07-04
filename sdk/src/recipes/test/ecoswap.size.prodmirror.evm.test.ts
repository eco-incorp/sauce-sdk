/**
 * EcoSwap INTEGRAL SIZE (TwapRelayer) PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE, BOTH REAL
 * PAIRS. MANDATORY-GRADE for this family: the OUT-amount [min, cap] WINDOW logic (TR03/TR3A,
 * enforced at quote AND at exec by the VERIFIED TwapRelayer source) is the integration risk, and
 * only the genuine relayer + its REAL TWAP-oracle graph (ITwapPair → TwapOracleV3 → the Uniswap-V3
 * pool's observe()) proves the seed-floor grid + cap truncation against production rounding.
 *
 * Unlike ecoswap.size.evm.test.ts (which deploys the SizeRelayer.sol fixture), this test stands up
 * the GENUINE Ethereum-mainnet graph captured by harness/size-snapshot.ts — relayer proxy + impl +
 * TwapFactory + BOTH ITwapPairs (WETH/USDC + WETH/USDT) + their TwapOracleV3s + the REAL Uniswap-V3
 * pools they read observe() from + the TwapDelay hedge queue — via the fermi harness verbatim (the
 * snapshot is FERMI-SHAPED: fermiSwapper = vault = the RELAYER, which holds every pair's payout
 * inventory), and runs the swap against it: etch + setStorageAt, seconds, no RPC.
 *
 * ── block.timestamp (the TWAP interpolation) ────────────────────────────────────────────────────────
 * The TWAP path interpolates the V3 pool's observe() around block.timestamp and the hedge Orders
 * check deadlines against it, so the harness pins the anvil clock to the capture instant
 * (pinFermiBlockTimestamp, zero interval) — every quote and every cook sees the capture block's
 * exact TWAP, making the etched quotes deterministic ground truth. The relayer also needs its
 * captured ETH balance (sizeRelayerEth — the hedge-enqueue prepay sell() pays from it).
 *
 * ── the CAPTURED LIVE WINDOW (block 25461101) ───────────────────────────────────────────────────────
 * USDC→WETH OPEN [minIn 2153.39 USDC, cap ≈ 30.37 WETH out]; WETH→USDT OPEN [minIn ≈ 2.788 WETH,
 * cap ≈ 9132.7 USDT out]; WETH→USDC CLOSED — the relayer's USDC inventory (3207.56) sits BELOW
 * getTokenLimitMin(USDC) (5000): the window bounds have CROSSED and EVERY quote reverts (a real
 * mainnet state, not a synthetic construction — the discovery-drop cell runs against it).
 *
 * Cells (× v1/v12 via ECO_ENGINE):
 *   (a) INTEGRITY — every checked-in runtime hashes to its capture anchor, eth_getCode matches
 *       byte-for-byte, and the captured probe ladders (BOTH pairs, in-window points wei-exact AND
 *       out-of-window points reverting with the SAME TR03/TR3A tags) reproduce; the CLOSED
 *       direction reproduces (TR03 low / TR3A high) and production discovery DROPS it.
 *   (b) The production discovery→window-hoist→seed-floor-QL→sell exec run on the TARGET pair
 *       (USDC→WETH), wei-exact vs the prefetched-grid oracle + the real relayer's own quoteSell;
 *       pull lands on the REAL TwapDelay; allowance residue == 0.
 *   (c) The SAME run on the SECOND pair (WETH→USDT) — the single-relayer MULTI-PAIR cell (one
 *       contract, one claim key, two inventories).
 *   (d) WINDOW-EDGE — an award pushed against the REAL inventory cap: the full-size quote reverts
 *       TR3A on the genuine relayer, the ladder truncates at the last in-window grid point, the
 *       cook spends EXACTLY the coverage, refunds the remainder, residue == 0.
 *   (e) DRIFT — a REAL sell() through the etched relayer shrinks the WETH inventory (the movable
 *       live state: the cap is balanceOf(relayer)-keyed), then the PRE-drift bytecodes cook: the
 *       in-cook window hoist + live ladder RE-ANCHOR to the smaller cap (spent == the post-drift
 *       coverage < baseline). The TWAP PRICE itself is NOT movable locally — moving it needs a
 *       real swap through the captured Uniswap-V3 pool, whose tick/position state is not part of
 *       the quote-path capture (observe() slots only), so the price-drift class stays covered by
 *       the fixture suite's TWAP re-price cell; the INVENTORY window drift here is the
 *       production-real analogue on genuine bytecode.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.size.prodmirror.evm.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, getAddress, type Abi, type Account, type Hex, type PublicClient } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { ensureMulticall3, deployStack, approve, balanceOf, type DeployedStack, type DeployedV12Stack } from "./harness/setup";
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
import { SIZE_PRECISION, type SizePool } from "../shared/size-math";
import { discoverSizePoolsTyped } from "../shared/pool-discovery";

const SNAP_NAME = "eth-size-WETHUSDC";
const ENGINE_CELLS = engineCells();

const relayerAbi = parseAbi([
  "function quoteSell(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  "function quoteBuy(address tokenIn, address tokenOut, uint256 amountOut) view returns (uint256)",
  "function getTokenLimitMin(address token) view returns (uint256)",
  "function sell((address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, bool wrapUnwrap, address to, uint32 submitDeadline) p) payable returns (uint256 orderId)",
]);
const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

describe("EcoSwap SIZE prod-mirror — REAL TwapRelayer+TWAP-oracle graph, no fork, offline, both pairs", () => {
  const snaps = loadFermiSnapshots(SNAP_NAME);
  const RELAYER = getAddress(snaps.state.fermiSwapper) as Hex;
  const DELAY = getAddress(snaps.state.sizeDelay!) as Hex;
  const WETH = getAddress(snaps.state.tokens.WETH.address) as Hex;
  const USDC = getAddress(snaps.state.tokens.USDC.address) as Hex;
  const USDT = getAddress(snaps.state.tokens.USDT.address) as Hex;

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedFermiGraph;

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
      callerFund: 10n ** 24n, // covers USDC (6 dec) cooks + WETH (18 dec) second-pair cooks + the drift sell
    });
    // The relayer's captured ETH balance — sell() pays the TwapDelay hedge-enqueue prepay from it.
    await c.testClient.setBalance({ address: RELAYER, value: BigInt(snaps.state.sizeRelayerEth!) });
    // PIN THE CLOCK to the capture instant — the TWAP reads observe() around block.timestamp.
    // MUST precede the first quote/cook.
    await pinFermiBlockTimestamp(c.testClient as never, snaps.state);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** The etched relayer's LIVE quoteSell — throws out-of-window (TR03/TR3A), like the real surface. */
  async function onQuote(tokenIn: Hex, tokenOut: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: RELAYER, abi: relayerAbi as Abi, functionName: "quoteSell", args: [tokenIn, tokenOut, amt],
    })) as bigint;
  }

  /** probe-then-decode quoteSell: the TR tag on revert, the amount on success (the capture-ladder shape). */
  async function quoteTagged(tokenIn: Hex, tokenOut: Hex, amt: bigint): Promise<string> {
    try {
      return (await onQuote(tokenIn, tokenOut, amt)).toString();
    } catch (e) {
      const m = String((e as Error).message ?? e).match(/TR[0-9A-Z]{2}/);
      return `REVERT:${m ? m[0] : "?"}`;
    }
  }

  /** The LIVE window hoist off the etched relayer (the solver's own prelude, mirrored): minOut →
   *  quoteBuy ⇒ the seed-floor minIn (probe-then-decode: a revert ⇒ 0 ⇒ dead venue). */
  async function liveWindow(tokenIn: Hex, tokenOut: Hex): Promise<{ minOut: bigint; minIn: bigint }> {
    const minOut = (await c.publicClient.readContract({
      address: RELAYER, abi: relayerAbi as Abi, functionName: "getTokenLimitMin", args: [tokenOut],
    })) as bigint;
    if (minOut === 0n) return { minOut, minIn: 0n };
    const minIn = (await c.publicClient
      .readContract({ address: RELAYER, abi: relayerAbi as Abi, functionName: "quoteBuy", args: [tokenIn, tokenOut, minOut] })
      .catch(() => 0n)) as bigint;
    return { minOut, minIn };
  }

  /** The Fluid/Metric PREFETCH pattern: quote the REAL etched relayer at the DETERMINISTIC seed-
   *  floored QL grid (qlLadderInputs(amountIn, liveMinIn) — the exact points the on-chain solver's
   *  floored ladder queries), answer by exact-point lookup; out-of-window points quote 0 (the
   *  probe-then-decode sentinel), truncating the oracle ladder in lockstep with the solver. */
  async function offPool(tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<SizePool> {
    const { minOut, minIn } = await liveWindow(tokenIn, tokenOut);
    const grid = qlLadderInputs(amountIn, minIn);
    const quotes = new Map<bigint, bigint>();
    for (const x of grid) {
      const q = (await c.publicClient
        .readContract({ address: RELAYER, abi: relayerAbi as Abi, functionName: "quoteSell", args: [tokenIn, tokenOut, x] })
        .catch(() => 0n)) as bigint;
      quotes.set(x, q);
    }
    return {
      address: RELAYER, tokenIn, tokenOut, minOut, minIn,
      feePpm: Number((BigInt(snaps.state.sizeWindow!.swapFeeTarget) * 10n ** 6n) / SIZE_PRECISION),
      source: "prod-mirror-prefetch",
      getDy: (dx: bigint): bigint => {
        const q = quotes.get(dx);
        if (q === undefined) throw new Error(`size prefetch grid miss at ${dx}`);
        return q;
      },
      liveMinIn: minIn,
    };
  }

  function sizePoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: RELAYER,
          poolType: SwapPoolType.UniV2, // INERT placeholder (discovery keys off factoryType)
          factoryType: FactoryType.IntegralSize,
          label: "Local SIZE (prod-mirror)",
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

  // ── (a) REAL BYTECODE — integrity + BOTH probe ladders (values AND window-revert tags) + the
  //        CLOSED direction + its production discovery drop ──
  it("etches the REAL SIZE relayer+TWAP-oracle graph (byte-equal) + reproduces BOTH captured ladders incl. the TR03/TR3A edges + drops the CLOSED direction", async () => {
    await setup();
    // NO-NETWORK integrity tripwire FIRST: every checked-in runtime still hashes to its capture anchor.
    const integ = verifyFermiBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, "every captured runtime sha256 matches its capture anchor");

    for (const cc of snaps.bytecode.contracts) {
      const addr = getAddress(cc.address) as Hex;
      const isToken = ["WETH", "USDC", "USDT"].some(
        (sym) => getAddress(snaps.state.tokens[sym].address).toLowerCase() === addr.toLowerCase(),
      );
      if (isToken) continue; // repointed to local MintableERC20s
      const code = await c.publicClient.getCode({ address: addr });
      assert.equal(code?.toLowerCase(), cc.runtime.toLowerCase(), `eth_getCode at ${addr} == captured REAL runtime [${cc.role}]`);
    }

    // BOTH captured probe ladders reproduce — the in-window points WEI-EXACT and the out-of-window
    // points REVERTING WITH THE SAME TAG (TR03 below the min, TR3A above the cap): the strongest
    // single-shot proof the etched graph IS mainnet (real relayer dispatch, real ITwapPair→
    // TwapOracleV3→UniswapV3.observe() pricing, real checkLimits window).
    for (const [dir, tin, tout] of [
      ["target", USDC, WETH],
      ["second", WETH, USDT],
    ] as const) {
      const ladder = dir === "target" ? snaps.state.probe.target.ladder : snaps.state.probe.second!.ladder;
      for (const p of ladder) {
        const got = await quoteTagged(tin, tout, BigInt(p.amountIn));
        assert.equal(got, p.amountOut, `REAL quoteSell ${dir}(${p.amountIn}) == captured mainnet ${p.amountOut}`);
      }
    }

    // The CLOSED direction (WETH→USDC): the capture caught a REAL crossed window (USDC inventory
    // 3207.56 < the 5000 min) — both domain ends revert, and PRODUCTION DISCOVERY drops the venue
    // (quoteBuy(minOut) reverts ⇒ probe-then-decode ⇒ no descriptor, never a DoS).
    for (const p of snaps.state.sizeWindow!.closed!.ladder) {
      const got = await quoteTagged(WETH, USDC, BigInt(p.amountIn));
      assert.equal(got, p.amountOut, `CLOSED-window quoteSell(${p.amountIn}) reproduces ${p.amountOut}`);
    }
    const closedVenues = await discoverSizePoolsTyped(
      WETH, USDC, c.publicClient as PublicClient, sizePoolConfig(WETH, USDC).factories, 5n * 10n ** 18n,
    );
    assert.equal(closedVenues.length, 0, "discovery DROPS the closed-window direction (no venue, no DoS)");

    console.log(
      `  [size-prod-mirror] REAL bytecode etched (${etched.contractCount} contracts, ${etched.slotCount} slots); ` +
        `inventory ${snaps.state.vault.reserves.WETH} WETH / ${snaps.state.vault.reserves.USDC} USDC / ` +
        `${snaps.state.vault.reserves.USDT} USDT; BOTH ladders + the closed window reproduce @ pinned ts ${snaps.state.blockTimestamp}`,
    );
  });

  // ── (b)/(c) The production discovery→window-hoist→seed-floor-QL→sell run, either REAL pair. ──
  async function runProdMirror(engine: Engine, which: "target" | "second"): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // TARGET: 20,000 USDC → WETH (in-window: minIn 2153.39, cap ≈ 54.5k). SECOND: 4 WETH → USDT
    // (in-window: minIn ≈ 2.788 WETH, cap ≈ 5.09 WETH) — the seed floor is LOAD-BEARING here
    // (amountIn/16 = 0.25 WETH ≪ minIn: an unfloored grid's first slices would all revert TR03).
    const tokenIn = which === "target" ? USDC : WETH;
    const tokenOut = which === "target" ? WETH : USDT;
    const amountIn = which === "target" ? 20_000n * 10n ** 6n : 4n * 10n ** 18n;
    const poolConfig = sizePoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [target as never, "0x8AC7230489E80000" as never],
    } as never);

    // Discovery + compile against the etched graph (the venue window-hoists live at the pinned clock).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal(prepared.pools.length, 0, "no direct pools (SIZE-only config)");
    assert.equal((prepared.sizePools ?? []).length, 1, "discovered exactly the 1 REAL SIZE venue");
    const venue = prepared.sizePools![0];
    assert.equal(venue.address.toLowerCase(), RELAYER.toLowerCase(), "the venue IS the etched relayer (the claim key)");
    assert.equal(venue.fromToken.toLowerCase(), tokenIn.toLowerCase(), "descriptor fromToken == the edge from-token");
    assert.equal(venue.toToken.toLowerCase(), tokenOut.toLowerCase(), "descriptor toToken == the edge to-token");
    const live = await liveWindow(tokenIn, tokenOut);
    assert.equal(venue.minOut, live.minOut, "descriptor minOut == the REAL getTokenLimitMin(tokenOut)");
    assert.equal(venue.minIn, live.minIn, "descriptor minIn == the REAL quoteBuy(minOut) conversion");

    // PREFETCH the REAL relayer's quotes at the seed-floored deterministic grid → the oracle.
    const op = await offPool(tokenIn, tokenOut, amountIn);
    if (which === "second") {
      assert.ok(op.liveMinIn > amountIn / 16n, "cell precondition: the seed floor is LOAD-BEARING on the second pair");
    }
    const oracle = optimalSplit({ pools: [{ size: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.equal(awarded, amountIn, "the floored ladder covers the FULL amountIn (in-window trade)");

    // The REAL relayer's own pre-cook quote of the award — the exec re-quotes exactly this in-tx
    // (same pinned TWAP, same inventory) and sells with it as amountOutMin.
    const onViewPre = await onQuote(tokenIn, tokenOut, awarded);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const delayBefore = await balanceOf(c.publicClient, tokenIn, DELAY);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `cook() must succeed against the REAL SIZE graph (${which})`);

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const pulled = (await balanceOf(c.publicClient, tokenIn, DELAY)) - delayBefore;

    assert.equal(spent, awarded, "on-chain spent == prefetched-oracle awarded (wei-exact)");
    assert.equal(pulled, spent, "the REAL sell() pulled EXACTLY the award into the TwapDelay (pull == approve)");
    assert.equal(received, onViewPre, "received == REAL quoteSell(award) (wei-exact-vs-live-quote)");
    assert.equal(await allowanceOf(tokenIn, target, RELAYER), 0n, "no relayer allowance residue (pull == approve always)");

    const ms = Date.now() - t0;
    console.log(
      `  [size-prod-mirror:${engine}:${which}] WEI-EXACT — spent=${spent} received=${received} ` +
        `(== real quoteSell); pulled→TwapDelay=${pulled}; wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  // ── (d) WINDOW-EDGE — the award pushed against the REAL inventory cap (TR3A truncation). ──
  async function runCapEdge(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = USDC;
    const tokenOut = WETH;
    // 100k USDC ≈ 55.7 WETH out demanded ≫ the real cap (31.969 WETH inventory × 0.95 ≈ 30.37):
    // the full-size quote REVERTS TR3A on the genuine relayer and the ladder truncates mid-grid.
    const amountIn = 100_000n * 10n ** 6n;
    const poolConfig = sizePoolConfig(tokenIn, tokenOut);

    await assert.rejects(() => onQuote(tokenIn, tokenOut, amountIn), /TR3A/, "the full-size quote REVERTS TR3A on the REAL relayer");

    const { bytecodes } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    const op = await offPool(tokenIn, tokenOut, amountIn);
    const oracle = optimalSplit({ pools: [{ size: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const coverage = oracle.perPoolInput[0] ?? 0n;
    assert.ok(coverage > 0n && coverage < amountIn, `the ladder truncates strictly inside amountIn (coverage=${coverage})`);
    const onViewCov = await onQuote(tokenIn, tokenOut, coverage);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const delayBefore = await balanceOf(c.publicClient, tokenIn, DELAY);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "window-edge cook() must succeed (award bounded by the in-window ladder)");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const pulled = (await balanceOf(c.publicClient, tokenIn, DELAY)) - delayBefore;

    assert.equal(spent, coverage, "net spent == the truncated coverage (the un-fillable remainder never left the caller)");
    assert.equal(pulled, coverage, "pulled == the awarded coverage exactly (pull == approve at the cap edge)");
    assert.equal(received, onViewCov, "received == REAL quoteSell(coverage) to the wei");
    assert.equal(await allowanceOf(tokenIn, target, RELAYER), 0n, "no relayer allowance residue at the window edge");
    console.log(
      `  [size-prod-mirror window-edge:${engine}] amountIn=${amountIn} coverage=${coverage} received=${received} ` +
        `(REAL TR3A truncation; remainder stays with the caller; residue 0)`,
    );
  }

  // ── (e) DRIFT — a REAL sell() through the etched relayer moves the inventory cap; the PRE-drift
  //        bytecodes re-anchor. ──
  async function runDrift(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = USDC;
    const tokenOut = WETH;
    const amountIn = 100_000n * 10n ** 6n; // cap-bound (see the window-edge cell)
    const poolConfig = sizePoolConfig(tokenIn, tokenOut);

    const { bytecodes } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    const opPre = await offPool(tokenIn, tokenOut, amountIn);
    const covPre = (optimalSplit({ pools: [{ size: opPre, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true }).perPoolInput[0] ?? 0n);
    assert.ok(covPre > 0n, "baseline coverage exists");

    // GENUINE drift: a REAL sell (10k USDC → WETH) from the caller THROUGH THE ETCHED RELAYER —
    // the WETH payout shrinks balanceOf(relayer), which the checkLimits cap is keyed on (the
    // movable live window state). Bonus wei-exactness proof: the sell's realized out == the
    // pre-sell quote on genuine bytecode.
    const driftAmt = 10_000n * 10n ** 6n;
    const driftQuote = await onQuote(tokenIn, tokenOut, driftAmt);
    await approve(c.walletClient, c.publicClient, tokenIn, RELAYER, driftAmt);
    const wethBefore = await balanceOf(c.publicClient, WETH, caller);
    const deadline = Number(BigInt(snaps.state.blockTimestamp) + 3600n);
    const driftHash = await c.walletClient.writeContract({
      address: RELAYER, abi: relayerAbi as Abi, functionName: "sell",
      args: [{ tokenIn, tokenOut, amountIn: driftAmt, amountOutMin: driftQuote, wrapUnwrap: false, to: caller, submitDeadline: deadline }],
      account: c.walletClient.account as Account, chain: c.walletClient.chain, gas: 3_000_000n,
    });
    const driftReceipt = await c.publicClient.waitForTransactionReceipt({ hash: driftHash });
    assert.equal(driftReceipt.status, "success", "the REAL drift sell lands on the etched graph");
    assert.equal(
      (await balanceOf(c.publicClient, WETH, caller)) - wethBefore, driftQuote,
      "the REAL sell paid EXACTLY its pre-sell quote (genuine-bytecode wei-exactness)",
    );

    // Re-prefetch the POST-drift grid — the smaller cap the PRE-drift bytecodes must re-anchor to.
    const opDrift = await offPool(tokenIn, tokenOut, amountIn);
    const covDrift = (optimalSplit({ pools: [{ size: opDrift, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true }).perPoolInput[0] ?? 0n);
    assert.ok(covDrift > 0n && covDrift < covPre, `the REAL inventory move SHRANK the coverage (${covDrift} < ${covPre})`);
    const onViewDrift = await onQuote(tokenIn, tokenOut, covDrift);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [target as never, "0x8AC7230489E80000" as never],
    } as never);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "PRE-drift bytecodes cook successfully after the REAL inventory move");
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(spent, covDrift, "spent == the POST-drift coverage (re-anchored to the moved cap, wei-exact)");
    assert.equal(received, onViewDrift, "received == the POST-drift live quote of the coverage (wei-exact)");
    assert.equal(await allowanceOf(tokenIn, target, RELAYER), 0n, "no relayer allowance residue after the drift cook");
    console.log(
      `  [size-prod-mirror drift:${engine}] real 10k-USDC sell shrank the cap — coverage ${covPre} → ${covDrift}; ` +
        `pre-drift cook spent=${spent} received=${received} (re-anchored)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL SIZE graph on the TARGET pair (USDC→WETH) [${engine}] — wei-exact, offline`, { skip }, async () => {
      await runProdMirror(engine, "target");
    });
    it(`runs EcoSwap through the REAL SIZE graph on the SECOND pair (WETH→USDT) [${engine}] — the multi-pair single-relayer + load-bearing seed floor cell`, { skip }, async () => {
      await runProdMirror(engine, "second");
    });
    it(`REAL window-edge [${engine}] — the award truncates at the genuine TR3A inventory cap, remainder preserved, residue 0`, { skip }, async () => {
      await runCapEdge(engine);
    });
    it(`REAL-sell inventory drift re-anchor [${engine}] — pre-drift bytecodes re-anchor to the moved cap`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});
