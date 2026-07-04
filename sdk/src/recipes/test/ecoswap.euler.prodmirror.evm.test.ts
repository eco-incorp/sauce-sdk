/**
 * EcoSwap EulerSwap V1 (Euler vault-backed AMM, euler-xyz/euler-swap tag eulerswap-1.0) PROD-MIRROR —
 * REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The EulerSwap analogue of ecoswap.mento.prodmirror.evm.test.ts / ecoswap.fluid.prodmirror.evm.test.ts.
 * Unlike ecoswap.euler.evm.test.ts (which deploys a MOCK EulerSwapPool.sol fixture), this test stands up
 * the GENUINE deployed EulerSwap V1 pool 0x3bBCC029 (USDC/USDT, mainnet) + its WHOLE ~24-contract
 * EVK/EVC/oracle quote+swap contract GRAPH captured from Ethereum mainnet, and runs the swap against it —
 * proving the production discovery + execution path works on the real contracts, with NO fork and NO RPC at
 * run time (etch + setStorageAt + a timestamp pin, seconds).
 *
 * MECHANISM (mirrors Mento's whole-graph etch + Fluid's immutable-token/ts-pin, in harness/etch-pool.ts):
 *   CAPTURE (one-time, harness/eulerv1-snapshot.ts, uses the RPC key):
 *     the wired FactoryType.EulerSwap target on Ethereum — the DEEPEST LIVE (operator-authorized) stable
 *     V1 pool (USDC/USDT 0x3bBCC029, constants.ts eulerSwapPools[0]) — moves the LP's funds through a
 *     ~24-contract graph (pool MetaProxy → EulerSwap impl → EVC → 2 EVK EVaults + their module impls →
 *     EulerRouter oracle → 2 ChainlinkOracle adapters → their Chainlink aggregators → IRM → dToken →
 *     Permit2 + the two ERC20s). We enumerate the EXACT touched set via debug_traceCall(prestateTracer) on
 *     EVERY production entry point (getAssets/curve/getReserves/getParams/getLimits — discovery; computeQuote
 *     — the exec quote; a FULL SUCCESSFUL swap under a pre-transfer stateOverride — the exec write) and dump
 *     {code, touched-storage} per address into fixtures/snapshots/ethereum-eulerv1-USDCUSDT.{bytecode,state}
 *     .json (WITH sha256 anchors). Block pinned (25445491). No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); setCode EVERY captured contract at its captured
 *     address; setStorageAt every captured slot VERBATIM by absolute key (pool CtxLib reserves, vault
 *     accounting, EVC operator-auth + on-behalf, oracle feed rounds, …); etch a local MintableERC20 AT EACH
 *     REAL token address (asset0/asset1 are EVault IMMUTABLES — the V4 StateView→PoolManager immutable
 *     class), fund each vault with its captured `cash`, reconstruct the pool→Permit2 pull allowance on the
 *     local tokens (the one piece the token-repoint drops — see etch-pool.ts), then PIN block.timestamp to
 *     the captured block ts (pinEulerV1BlockTimestamp — the oracle's ChainlinkOracle adapters enforce a
 *     90000s maxStaleness; the captured feeds are ~24060s/~70476s stale, both fresh at the pinned ts). The
 *     swap then runs the GENUINE graph: computeQuote returns the mainnet-identical dy and pool.swap deposits
 *     the pre-transferred input into vault0 + withdraws the output from vault1 through the EVC + the real
 *     oracle liquidity check.
 *
 * CENTRAL VERIFICATION (this file asserts all three explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool + EVERY dependency (EVC, both vaults, the EulerSwap impl,
 *       the EulerRouter oracle, the module impls, …) in the test == the captured real runtime, byte-for-byte
 *       (a NO-RPC sha256 tripwire proves the checked-in blobs are intact). No mock EulerSwapPool.sol is in
 *       the swap path (the addresses are the captured mainnet addresses, running captured code). The REAL
 *       pool getters reconstruct exactly — curve()=="EulerSwap v1", getAssets/getReserves/getParams/getLimits
 *       == captured, and computeQuote reproduces the captured probe ladder to the WEI.
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts optimalSplit,
 *       which replays the IDENTICAL QL ladder via the SHARED buildEulerSwapQLLadder — the same live
 *       computeQuote geometric ladder the on-chain solver walks) == the REAL pool's OWN pre-swap computeQuote
 *       view of the awarded slice, all to the wei. spent == the awarded Σ is asserted explicitly.
 *
 * HONEST fidelity — FULL-REAL-CODE, NO STUB/SHIM: every contract in the swap path (pool, EulerSwap impl,
 * EVC, both EVaults + all EVK module impls, the EulerRouter oracle + its two ChainlinkOracle adapters +
 * their REAL Chainlink aggregators, the IRM, the dToken, Permit2) is the REAL captured runtime, byte-for-
 * byte, and the Chainlink feed runtimes carry the REAL captured rounds (NOT read-only shims) — the oracle
 * prices the vault liquidity check off genuine mainnet feed data at the pinned timestamp. The ONE
 * reconstructed-not-captured item is a GATING allowance (pool→Permit2 max approval on the LOCAL token; the
 * real pool holds a near-infinite one, verified DECREMENTED by the swap) — GATING, not pricing, so the
 * executed dy is still the real curve/vault result. computeQuote is EXACT-IN-DY (the periphery
 * quoteExactInput delegates to it, and the view IS the swap math EulerSwap.swap enforces), so received ==
 * computeQuote(awarded Σ) to the wei.
 *
 * EULERSWAP IS A QUOTE-LADDER (QL) VENUE (like Curve / DODO / Wombat / Fermi): prepare ships ONLY the
 * descriptor and the on-chain solver builds each venue's price ladder in setup from LIVE computeQuote
 * staticcalls (probe-then-decode; the view REVERTS/returns 0 past the live vault cap, so the ladder self-
 * truncates at the live cap). The neutral oracle replays the IDENTICAL geometric ladder off-chain via the
 * closed-form buildEulerSwapQLLadder — and this test proves the closed-form computeQuote == the REAL etched
 * computeQuote at every ladder point (below), so the on-chain ladder == the oracle to the wei. At this
 * well-within-cap sizing the geometric ladder covers [0, amountIn], so spent == the oracle's awarded Σ ==
 * amountIn to the wei (single deep venue, full-fill).
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts are
 * absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.euler.prodmirror.evm.test.ts
 *      ECO_ENGINE=both pnpm --filter './sdk' test:recipes:evm
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  type Abi,
  type Account,
  type Hex,
} from "viem";

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
  etchEulerV1Pool,
  loadEulerV1Snapshots,
  verifyEulerV1BytecodeIntegrity,
  pinEulerV1BlockTimestamp,
  eulerV1PoolReadAbi,
  type EtchedEulerV1Pool,
  type EulerV1StateSnapshot,
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
import { computeQuote, buildEulerSwapQLLadder, eulerFeeToPpm, type EulerSwapPool } from "../shared/eulerswap-math";
import { qlLadderInputs } from "../shared/curve-math";

const SNAP_NAME = "ethereum-eulerv1-USDCUSDT";
const ENGINE_CELLS = engineCells();

describe("EcoSwap EulerSwap V1 (Euler vault-backed AMM) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadEulerV1Snapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedEulerV1Pool;

  // Boot a fresh anvil + etch the real pool graph + deploy the engine, then PIN the block clock (the
  // oracle's Chainlink staleness window). Called before each cell so each engine runs in full isolation
  // (cheap: the whole setup is etch + setStorageAt + a handful of deploys, seconds not minutes).
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // Caller headroom in tokenIn — 2x the trade sizing below.
    etched = await etchEulerV1Pool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: 200_000n * 10n ** BigInt(snaps.state.tokenInDecimals),
    });
    // PIN block.timestamp to the captured block ts — the window where the swap's oracle Chainlink feeds
    // are within their maxStaleness (see the harness header). A fresh anvil's wall-clock is FAR past.
    await pinEulerV1BlockTimestamp(c.testClient, snaps.state);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a EulerSwap factory carrying the reproduced pool → the production
   *  FactoryType.EulerSwap discovery path resolves the etched pool via curve()+getParams()+getReserves()+
   *  getLimits(); the lens ignores non-V2/V3/V4 factory types, so no direct pools are surfaced and the
   *  EulerSwap venue rides entirely through discoverEulerSwapPoolsTyped. (No factory shim is needed —
   *  discovery reads the config-carried eulerSwapPools list directly.) The `address`/`poolType` are inert
   *  placeholders (discovery keys off factoryType). */
  function eulerPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.factory,
          poolType: SwapPoolType.UniV2, // inert for EulerSwap — discovery keys off factoryType
          factoryType: FactoryType.EulerSwap,
          label: "Local EulerSwap V1 (prod-mirror)",
          eulerSwapPools: [etched.pool],
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // The pool's own on-chain computeQuote view (the exact-in-dy ground truth for the executed slice) —
  // the periphery quoteExactInput delegates to this, and the view IS the swap math the pool enforces.
  async function onQuote(amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: etched.pool, abi: eulerV1PoolReadAbi, functionName: "computeQuote",
      args: [etched.tokenIn, etched.tokenOut, amt, true],
    })) as bigint;
  }

  // A read-only cook (eth_call) of the swap bytecodes — builds the QL ladder LIVE and returns the total out
  // WITHOUT landing the swap. Per-engine return decode: v1 wraps the cook return in a bytes envelope
  // (simulate/decodeFunctionResult), v12 returns it verbatim; the last 32 bytes are the total out uint.
  const cookCallAbi = parseAbi(["function cook(bytes[] ingredients) payable returns (bytes returnData)"]);
  async function zeroCacheQuote(target: Hex, caller: Hex, bytecodes: readonly Hex[], engine: Engine): Promise<bigint> {
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    if (!ret || ret === "0x") return 0n;
    if (engine === "v1") {
      const blob = decodeFunctionResult({ abi: cookCallAbi as Abi, functionName: "cook", data: ret as Hex }) as unknown as Hex;
      const hex = blob.slice(2);
      return hex.length >= 64 ? BigInt("0x" + hex.slice(-64)) : 0n;
    }
    const hex = (ret as Hex).slice(2);
    return hex.length >= 64 ? BigInt("0x" + hex.slice(-64)) : 0n;
  }

  /** The neutral oracle's EulerSwapPool descriptor, built from the CAPTURED V1 params + live reserves,
   *  oriented for tokenIn == asset0 (the captured direction). The oracle walks this via the SHARED
   *  buildEulerSwapQLLadder — the IDENTICAL geometric QL ladder the solver builds on-chain from live
   *  computeQuote (replayed through the closed-form f/fInverse computeQuote, which reproduces the pool's
   *  on-chain computeQuote to the wei — proven below + in ecoswap.math.ts) — so the split is wei-exact vs
   *  the solver by construction. `outLimit` mirrors the captured vault output cap so the ladder self-
   *  truncates at the SAME point the on-chain computeQuote would (a no-op at this well-within-cap sizing). */
  function offPool(state: EulerV1StateSnapshot): EulerSwapPool {
    const p = state.params;
    const inIsToken0 = state.isAsset0In; // true for this pool (tokenIn == asset0 == USDC)
    const r0 = BigInt(state.reserve0);
    const r1 = BigInt(state.reserve1);
    const x0 = BigInt(p.equilibriumReserve0);
    const y0 = BigInt(p.equilibriumReserve1);
    const px = BigInt(p.priceX);
    const py = BigInt(p.priceY);
    const cx = BigInt(p.concentrationX);
    const cy = BigInt(p.concentrationY);
    const feeWad = BigInt(p.fee); // v1 single non-directional fee
    return {
      address: etched.pool,
      inIsToken0,
      reserveIn: inIsToken0 ? r0 : r1,
      reserveOut: inIsToken0 ? r1 : r0,
      equilIn: inIsToken0 ? x0 : y0,
      equilOut: inIsToken0 ? y0 : x0,
      priceIn: inIsToken0 ? px : py,
      priceOut: inIsToken0 ? py : px,
      concIn: inIsToken0 ? cx : cy,
      concOut: inIsToken0 ? cy : cx,
      feeWad,
      inLimit: BigInt(state.getLimits.inLimit),
      outLimit: BigInt(state.getLimits.outLimit), // vault output cap — QL self-truncation bound (mirrors on-chain)
      feePpm: eulerFeeToPpm(feeWad), // round-half-up — THE SINGLE SOURCE discovery uses (matches the descriptor)
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL EulerSwap V1 pool + its whole EVK/EVC/oracle graph bytecode (byte-equal) + reproduces the captured quotes", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime blobs still hash to the sha256 anchors
    // recorded at capture time (byte-equal to the pinned-block on-chain code). A reviewer without the RPC
    // key can run this — it proves the snapshot wasn't silently altered after capture, with NO RPC.
    const integ = verifyEulerV1BytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, "every contract runtime sha256 matches its capture anchor");
    assert.ok(integ.contracts.length >= 20, `the full graph is captured (${integ.contracts.length} contracts)`);
    for (const con of integ.contracts) {
      assert.ok(con.expected, `contract ${con.address} (${con.role}) carries a sha256 integrity anchor`);
      assert.ok(con.ok, `contract ${con.address} (${con.role}) runtime sha256 matches the capture anchor (got ${con.actual})`);
    }

    // getCode at the pool + EVERY dependency must EQUAL the captured real runtime (no mock in the path).
    // The two token addresses are repointed to local MintableERC20s (asset0/asset1 are vault immutables),
    // so they are the ONLY captured addresses whose code intentionally differs — skip them here.
    const tokenSet = new Set([etched.asset0.toLowerCase(), etched.asset1.toLowerCase()]);
    for (const con of snaps.bytecode.contracts) {
      if (tokenSet.has(con.address.toLowerCase())) continue;
      const code = await c.publicClient.getCode({ address: con.address });
      assert.ok(code, `dependency ${con.role} (${con.address}) has code`);
      assert.equal(
        code!.toLowerCase(),
        con.runtime.toLowerCase(),
        `eth_getCode at ${con.role} (${con.address}) == the captured REAL runtime (byte-equal)`,
      );
    }
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.toLowerCase(), "pool at captured mainnet address");

    // The REAL pool getters reconstruct exactly (real code + verbatim state). curve() discriminates v1.
    const curve = (await c.publicClient.readContract({ address: etched.pool, abi: eulerV1PoolReadAbi, functionName: "curve" })) as Hex;
    assert.equal(curve.toLowerCase(), snaps.state.curve.toLowerCase(), "curve() == the captured \"EulerSwap v1\" constant");
    const assets = (await c.publicClient.readContract({ address: etched.pool, abi: eulerV1PoolReadAbi, functionName: "getAssets" })) as readonly [Hex, Hex];
    assert.equal(assets[0].toLowerCase(), etched.asset0.toLowerCase(), "getAssets asset0 == the etched local token at the real asset0 address");
    assert.equal(assets[1].toLowerCase(), etched.asset1.toLowerCase(), "getAssets asset1 == the etched local token at the real asset1 address");
    const reserves = (await c.publicClient.readContract({ address: etched.pool, abi: eulerV1PoolReadAbi, functionName: "getReserves" })) as readonly [bigint, bigint, number];
    assert.equal(reserves[0], BigInt(snaps.state.reserve0), "getReserves reserve0 == captured");
    assert.equal(reserves[1], BigInt(snaps.state.reserve1), "getReserves reserve1 == captured");
    assert.equal(reserves[2], snaps.state.status, "getReserves status == captured (1 = unlocked)");
    const params = (await c.publicClient.readContract({ address: etched.pool, abi: eulerV1PoolReadAbi, functionName: "getParams" })) as {
      vault0: Hex; vault1: Hex; eulerAccount: Hex; equilibriumReserve0: bigint; equilibriumReserve1: bigint;
      priceX: bigint; priceY: bigint; concentrationX: bigint; concentrationY: bigint; fee: bigint;
    };
    assert.equal(params.vault0.toLowerCase(), etched.vault0.toLowerCase(), "getParams vault0 == captured");
    assert.equal(params.vault1.toLowerCase(), etched.vault1.toLowerCase(), "getParams vault1 == captured");
    assert.equal(params.equilibriumReserve0, BigInt(snaps.state.params.equilibriumReserve0), "getParams eqReserve0 == captured");
    assert.equal(params.priceX, BigInt(snaps.state.params.priceX), "getParams priceX == captured");
    assert.equal(params.priceY, BigInt(snaps.state.params.priceY), "getParams priceY == captured");
    assert.equal(params.concentrationX, BigInt(snaps.state.params.concentrationX), "getParams concentrationX == captured");
    assert.equal(params.fee, BigInt(snaps.state.params.fee), "getParams fee == captured (single non-directional v1 fee)");

    // getLimits reads the vault caps THROUGH the module graph (RiskManager) — reconstructed exactly.
    const limits = (await c.publicClient.readContract({
      address: etched.pool, abi: eulerV1PoolReadAbi, functionName: "getLimits", args: [etched.tokenIn, etched.tokenOut],
    })) as readonly [bigint, bigint];
    assert.equal(limits[0], BigInt(snaps.state.getLimits.inLimit), "getLimits inLimit == captured (vault cap through the module graph)");
    assert.equal(limits[1], BigInt(snaps.state.getLimits.outLimit), "getLimits outLimit == captured");

    // The REAL computeQuote reproduces the captured probe ladder to the WEI (the f/fInverse curve over the
    // reconstructed reserves + params, netting the fee) — the exec-quote + discovery-sampler ground truth.
    for (let i = 0; i < snaps.state.ladder.cumIn.length; i++) {
      const amt = BigInt(snaps.state.ladder.cumIn[i]);
      const got = await onQuote(amt);
      assert.equal(got.toString(), snaps.state.ladder.cumOut[i], `REAL computeQuote(${amt}) == captured mainnet value`);
    }
    const probe = await onQuote(BigInt(snaps.state.probe.amountIn));
    assert.equal(probe.toString(), snaps.state.probe.amountOut, "REAL computeQuote(probe) == the captured mainnet value to the wei");

    console.log(
      `  [eulerv1-prod-mirror] REAL bytecode etched: pool ${etched.pool} + ${etched.contractCount - 1} deps ` +
        `(EVC/2 vaults/impl/EulerRouter oracle/module impls/…), ${etched.slotCount} storage slots; ` +
        `captured block ${snaps.state.block} ts ${snaps.state.blockTimestamp}; reserves ${reserves[0]}/${reserves[1]}; ` +
        `${snaps.state.tokenInSymbol}/${snaps.state.tokenOutSymbol}`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Swap tokenIn → tokenOut (USDC → USDT, the captured direction): tokenIn == asset0, tokenOut == asset1.
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;

    // amountIn == 1000 USDC — well within BOTH the vault inLimit (~$299M) AND the pool's VIRTUAL output
    // reserve (~1165 USDT curve reserveOut; the swappable output saturates there — the getReserves are the
    // curve virtual reserves, NOT the deep vault cash). At 1000 USDC → ~999.5 USDT the trade sits on the
    // productive part of the f/fInverse curve (well left of saturation), so the M=24 grid covers [0, amountIn]
    // and the merge awards the WHOLE grid Σ to this one venue (single-venue full-fill, asserted below). A
    // 100k+ USDC trade would overshoot the ~1165 USDT reserveOut and saturate — not a meaningful mirror.
    const amountIn = 1_000n * 10n ** BigInt(snaps.state.tokenInDecimals);
    const poolConfig = eulerPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // Run EcoSwap through the PRODUCTION FactoryType.EulerSwap discovery path (reads the etched pool graph).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced EulerSwap venue (via the real getters).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (EulerSwap-only config)");
    assert.equal((prepared.eulerSwaps ?? []).length, 1, "discovered exactly the 1 reproduced EulerSwap venue");
    assert.equal(
      prepared.eulerSwaps![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered EulerSwap venue is the REAL etched pool",
    );
    assert.equal(prepared.eulerSwaps![0].inIsToken0, true, "discovery oriented the venue as inIsToken0 (tokenIn == asset0)");
    assert.ok(prepared.eulerSwaps![0].source.includes("v1"), `the discovered venue is tagged v1 (${prepared.eulerSwaps![0].source})`);
    // EulerSwap is a QUOTE-LADDER venue: prepare ships ONLY the descriptor (in prepared.eulerSwaps), NO
    // static sampled brackets — index.ts buildQLVenues emits the segKind-7 descriptor (segs is always []).
    assert.equal(
      (prepared.brackets ?? []).filter((b) => b.kind === EcoBracketKind.EulerSwap).length,
      0,
      "EulerSwap ships NO static brackets (QL descriptor-only)",
    );

    // THE ON-CHAIN QL LADDER == THE REAL ETCHED computeQuote at the S geometric ladder points. The solver
    // builds its ladder by staticcalling the REAL pool computeQuote at exactly these xNext values, and the
    // oracle replays the closed-form computeQuote at the same points — so proving the etched view matches the
    // closed-form replay at every ladder point ties the on-chain ladder to the oracle to the wei.
    const op = offPool(snaps.state);
    for (const xNext of qlLadderInputs(amountIn)) {
      const onView = await onQuote(xNext);
      assert.equal(computeQuote(op, xNext), onView, `QL ladder point: closed-form computeQuote(${xNext}) == REAL etched computeQuote (wei-exact)`);
    }

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one QL EulerSwap venue seeded from the CAPTURED curve params via
    // the SHARED buildEulerSwapQLLadder (the identical geometric ladder the solver builds on-chain from live
    // computeQuote). Pure off-chain math (computed BEFORE the cook), so the awarded Σ is known ahead — and the
    // solver walks the IDENTICAL live ladder, so on-chain spent == oracle.totalInput to the wei.
    assert.ok(buildEulerSwapQLLadder(op, amountIn).length > 0, "non-empty QL EulerSwap ladder from the captured params");
    const optPools: OptimalPool[] = [{ eulerSwap: op, feePpm: op.feePpm }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced EulerSwap venue");

    // The REAL pool's OWN pre-swap computeQuote view for the KNOWN awarded Σ — the engine-independent
    // ground truth for the executed dy of the awarded slice (the periphery quoteExactInput delegates to
    // this view, and the view IS the swap math). The block clock is PINNED (oracle stays fresh).
    const onViewAwarded = await onQuote(awarded);

    // ZERO-CACHE QUOTE — a read-only cook (eth_call) of the SAME bytecodes builds the QL ladder LIVE against
    // the REAL etched graph with NO prepared segments (prepare shipped descriptor-only) and returns the total
    // out; it must equal the pre-swap computeQuote(awarded) view to the wei. Proves the ladder is built live
    // in the read call (no static segment cache).
    const quoted = await zeroCacheQuote(target, caller, bytecodes, engine);
    assert.equal(quoted, onViewAwarded, "zero-cache QUOTE == pre-swap computeQuote(awarded) to the wei (ladder built live in the eth_call)");

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    // EulerSwap PULLS the awarded input the recipe pre-transferred to the pool into the Liquidity vault0 (NOT
    // held by the pool) — measure the vault0 tokenIn delta for the "netted the full input" check.
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, etched.vault0);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL EulerSwap graph");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const vaultIn = (await balanceOf(c.publicClient, tokenIn, etched.vault0)) - vaultInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // HONEST fee accounting: EulerSwap nets the FULL awarded input into the Liquidity vault0 (the fee is
    // folded into a smaller output, not a smaller input). Assert vault0 received exactly what was spent.
    assert.equal(vaultIn, spent, "REAL EulerSwap vault0 netted the FULL input (fee is folded into the output quote)");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI. NO tolerance. EulerSwap is a
    // QUOTE-LADDER venue (like Curve/DODO/Wombat/Fermi), but at this sizing (well left of the output-reserve
    // saturation) the geometric QL ladder covers [0, amountIn] with monotone-descending marginals, so the
    // merge awards the WHOLE amountIn — spent == oracle awarded Σ == oracle.totalInput == amountIn to the WEI.
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact)");
    assert.equal(spent, amountIn, "single-venue full-fill: spent == amountIn (QL ladder covers [0, amountIn], one deep venue)");

    // The caller-received tokenOut == the neutral-oracle computeQuote(spent) == the REAL pool's OWN pre-swap
    // computeQuote(awarded Σ) view, all to the WEI. NO tolerance. The three-way agreement (TS oracle replay
    // == the real on-chain view == the executed swap), for exactly the awarded Σ the solver spent, ties the
    // executed output to the real pool's own asymmetric f/fInverse curve.
    assert.equal(received, computeQuote(op, spent), "received == neutral-oracle computeQuote(spent) (wei-exact-in-dy)");
    assert.equal(received, onViewAwarded, "received == REAL pool pre-swap computeQuote(awarded Σ) (exact-in-dy)");

    const ms = Date.now() - t0;
    console.log(
      `  [eulerv1-prod-mirror:${engine}] WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, computeQuote=${computeQuote(op, spent)}, realView=${onViewAwarded}, amountIn=${amountIn}); ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL EulerSwap V1 graph [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
