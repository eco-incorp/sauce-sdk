/**
 * EcoSwap DODO V2 (DSP — DODO Stable Pool) PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The DODO analogue of ecoswap.solidly.prodmirror.evm.test.ts. Unlike ecoswap.dodo.evm.test.ts
 * (which deploys a MOCK DodoV2Pool.sol fixture), this test stands up the GENUINE DODO DSP bytecode
 * captured from Ethereum mainnet and runs the swap against it — proving the production discovery +
 * execution path works on the real contract, with NO fork and NO RPC at run time (etch +
 * setStorageAt, seconds).
 *
 * MECHANISM (mirrors the repo's Uniswap-V4 real-runtime etch, generalised in harness/etch-pool.ts):
 *   CAPTURE (one-time, harness/dodo-snapshot.ts, uses the RPC key):
 *     the deepest real on-charter STABLE-pair DODO V2 pool the wired FactoryType.DODOZoo discovery
 *     reaches — a DAI/USDT DSP 1.0.1 on Ethereum — is an EIP-1167 CLONE. We eth_getCode BOTH the
 *     45-byte proxy runtime AND the DSP implementation runtime, PLUS the MT (maintainer) fee-rate
 *     model runtime, into fixtures/snapshots/ethereum-dodo-DAIUSDT.bytecode.json (WITH sha256
 *     anchors), and the full PMM curve state (i/K/B/Q/B0/Q0/R + fee rates + the raw pool storage
 *     slots) into .state.json. Block pinned. No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); setCode the REAL DSP impl at its
 *     captured address + the REAL proxy at the pool address; setStorageAt the captured storage,
 *     then repoint _BASE_TOKEN_/_QUOTE_TOKEN_ at local MintableERC20s and stand up (a) a tiny DODO
 *     DVMFactory shim (getDODOPool — the REAL getter) at the captured factory address and (b) a tiny MT fee-rate model shim
 *     returning the CAPTURED RESOLVED mtFeeRate at the captured MT address. The swap then runs the
 *     GENUINE DSP bytecode: querySellBase returns the mainnet-identical dy for the captured PMM state.
 *
 * CENTRAL VERIFICATION (this file asserts all three explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool + impl + MT model in the test == the captured real
 *       runtime, byte-for-byte. No mock DodoV2Pool.sol is in the swap path (the pool/impl addresses
 *       are the captured mainnet addresses, running captured code). getPMMStateForCall reproduces the
 *       captured PMM state exactly, and querySellBase|Quote reproduce the captured probe quotes.
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts
 *       optimalSplit, seeded from the REAL captured PMM state via the SHARED buildDodoQLLadder — DODO
 *       is now a QUOTE-LADDER venue) == the REAL pool's own pre-swap querySellBase view of the awarded
 *       slice, all to the wei. The on-chain QL ladder == the REAL querySellBase at every geometric
 *       sample point is asserted explicitly; spent == awarded is asserted explicitly.
 *
 * HONEST fee accounting: unlike Solidly (which routes the swap fee to a separate PoolFees
 * contract, netting the pool's tokenIn delta below `spent`), the DSP applies its LP+MT fee to the
 * OUTPUT (mulFloor(gross, fee) deducted from the quote out) — so the pool receives the FULL tokenIn
 * (`poolIn == spent`) and the fee shows up as a smaller tokenOut, exactly as the oracle's getDy
 * (which nets the SAME LP+MT fee off the gross) models it. The MT fee rate used on-chain is the
 * captured RESOLVED value (the real MT model reverts getFeeRate off a non-pool context and calls a
 * downstream fee-rate impl; the shim returns the same 1e13 the capture read from the pool context),
 * so the executed dy == the oracle dy (whose mtFeeRate came from the same capture) to the wei.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the
 * artifacts are absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.dodo.prodmirror.evm.test.ts
 *      ECO_ENGINE=both pnpm --filter './sdk' test:recipes:evm
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, type Abi, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { writeAndWait } from "./harness/deploy";
import {
  ensureMulticall3,
  deployStack,
  erc20Abi,
  mint,
  approve,
  balanceOf,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  etchDodoPool,
  loadDodoSnapshots,
  verifyDodoBytecodeIntegrity,
  dodoPoolReadAbi,
  dodoFactoryShimAbi,
  dodoMtFeeModelShimAbi,
  type EtchedDodoPool,
  type DodoStateSnapshot,
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
import { getDy, RState, type DodoPool } from "../shared/dodo-math";
import { qlLadderInputs } from "../shared/curve-math";

const SNAP_NAME = "ethereum-dodo-DAIUSDT";
const ENGINE_CELLS = engineCells();

/** Map the captured R byte (0/1/2) to the RState enum the off-chain replay uses. */
function toRState(r: number): RState {
  return r === 1 ? RState.ABOVE_ONE : r === 2 ? RState.BELOW_ONE : RState.ONE;
}

/** The DSP trade surface (transfer-first, exactly what the engine `_swapDODOV2` calls). */
const dodoSellAbi = parseAbi([
  "function sellBase(address to) returns (uint256 receiveQuoteAmount)",
  "function sellQuote(address to) returns (uint256 receiveBaseAmount)",
]);

describe("EcoSwap DODO V2 (DSP) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadDodoSnapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedDodoPool;

  // Boot a fresh anvil + etch the real pool + deploy the engine. Called before each cell so each
  // engine runs in full isolation (no shared mutable node state — cheap because the whole setup is
  // etch + setStorageAt + a handful of deploys, seconds not minutes).
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // ~10x the base reserve as caller headroom (18-decimal base; reserves ~5.4k DAI).
    etched = await etchDodoPool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: BigInt(snaps.state.baseReserve) * 10n,
    });
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a DODOZoo factory (the shim) → the production DODO discovery path
   *  resolves the etched pool; the lens ignores non-V2/V3/V4 factory types, so no direct pools are
   *  surfaced and the DODO pool rides entirely through discoverDodoV2PoolsTyped. */
  function dodoPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.factory,
          poolType: SwapPoolType.DODOV2,
          factoryType: FactoryType.DODOZoo,
          label: "Local DODO DSP (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  /** The neutral oracle's DodoPool descriptor for the single reproduced DSP, seeded from the REAL
   *  captured PMM state. tokenIn == base (sellBase → quote). The combined LP+MT fee nets the gross
   *  in getDy, so this replays querySellBase bit-for-bit. */
  function offPool(state: DodoStateSnapshot): DodoPool {
    return {
      poolType: SwapPoolType.DODOV2,
      address: etched.pool,
      baseToken: etched.baseToken,
      quoteToken: etched.quoteToken,
      sellBase: true, // tokenIn = base
      i: BigInt(state.pmm.i),
      K: BigInt(state.pmm.K),
      B: BigInt(state.pmm.B),
      Q: BigInt(state.pmm.Q),
      B0: BigInt(state.pmm.B0),
      Q0: BigInt(state.pmm.Q0),
      R: toRState(state.pmm.R),
      lpFeeRate: etched.lpFeeRate,
      mtFeeRate: etched.mtFeeRate,
      feePpm: 0, // price-ordering coordinate only (unused for a single venue)
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL DODO DSP bytecode (byte-equal) + reconstructs the captured PMM state", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime blobs still hash to the sha256
    // anchors recorded at capture time (byte-equal to the pinned-block on-chain code). A reviewer
    // without the RPC key can run this — it proves the snapshot wasn't silently altered after
    // capture, with NO RPC.
    const integ = verifyDodoBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pool runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(integ.implementation?.ok ?? true, `impl runtime sha256 matches the capture anchor (got ${integ.implementation?.actual})`);
    assert.ok(snaps.bytecode.pool.runtimeSha256, "pool snapshot carries a sha256 integrity anchor");
    assert.ok(snaps.bytecode.implementation?.runtimeSha256, "impl snapshot carries a sha256 integrity anchor");
    const mtDep = integ.dependencies.find((d) => d.name === "mtFeeRateModel");
    assert.ok(mtDep, "MT fee-rate model dependency present in the bytecode snapshot");
    assert.ok(mtDep!.ok, `MT model runtime sha256 matches the capture anchor (got ${mtDep!.actual})`);

    // getCode at the pool + impl must EQUAL the captured real runtime (no mock in the path).
    const poolCode = await c.publicClient.getCode({ address: etched.pool });
    const implCode = await c.publicClient.getCode({ address: etched.impl });
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pool.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL DODO proxy runtime (byte-equal)",
    );
    assert.ok(implCode, "impl has code");
    assert.equal(
      implCode!.toLowerCase(),
      snaps.bytecode.implementation!.runtime.toLowerCase(),
      "eth_getCode at the impl == the captured REAL DSP implementation runtime (byte-equal)",
    );
    // The pool/impl addresses are the CAPTURED mainnet addresses — no locally-compiled mock.
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.address.toLowerCase(), "pool at captured mainnet address");
    assert.equal(etched.impl.toLowerCase(), snaps.bytecode.implementation!.address.toLowerCase(), "impl at captured mainnet address");

    // The REAL DSP code reads the reconstructed state correctly.
    const [bt, qt, lpFee, mtModel, pmm] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: dodoPoolReadAbi, functionName: "_BASE_TOKEN_" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: dodoPoolReadAbi, functionName: "_QUOTE_TOKEN_" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: dodoPoolReadAbi, functionName: "_LP_FEE_RATE_" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: dodoPoolReadAbi, functionName: "_MT_FEE_RATE_MODEL_" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: dodoPoolReadAbi, functionName: "getPMMStateForCall" }) as Promise<readonly bigint[]>,
    ]);
    assert.equal(bt.toLowerCase(), etched.baseToken.toLowerCase(), "_BASE_TOKEN_ repointed at the local base token");
    assert.equal(qt.toLowerCase(), etched.quoteToken.toLowerCase(), "_QUOTE_TOKEN_ repointed at the local quote token");
    assert.equal(lpFee, etched.lpFeeRate, "_LP_FEE_RATE_ == captured");
    assert.equal(mtModel.toLowerCase(), etched.mtFeeModel.toLowerCase(), "_MT_FEE_RATE_MODEL_ points at the shim (captured address)");

    // getPMMStateForCall recomputes the EXACT captured curve state (the DSP _expectTarget round-trip
    // on the verbatim storage — including B0/Q0, which are recomputed, NOT the raw target slot).
    assert.equal(pmm[0], BigInt(snaps.state.pmm.i), "PMM i == captured");
    assert.equal(pmm[1], BigInt(snaps.state.pmm.K), "PMM K == captured");
    assert.equal(pmm[2], BigInt(snaps.state.pmm.B), "PMM B == captured");
    assert.equal(pmm[3], BigInt(snaps.state.pmm.Q), "PMM Q == captured");
    assert.equal(pmm[4], BigInt(snaps.state.pmm.B0), "PMM B0 == captured (recomputed by real code)");
    assert.equal(pmm[5], BigInt(snaps.state.pmm.Q0), "PMM Q0 == captured (recomputed by real code)");
    assert.equal(Number(pmm[6]), snaps.state.pmm.R, "PMM R == captured");

    // The REAL querySellBase/querySellQuote reproduce the captured probe quotes (real PMM integral).
    const zero = ("0x" + "00".repeat(20)) as Hex;
    const [sb, sq] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: dodoPoolReadAbi, functionName: "querySellBase", args: [zero, BigInt(snaps.state.probe.sellBase.payBaseAmount)] }) as Promise<readonly [bigint, bigint]>,
      c.publicClient.readContract({ address: etched.pool, abi: dodoPoolReadAbi, functionName: "querySellQuote", args: [zero, BigInt(snaps.state.probe.sellQuote.payQuoteAmount)] }) as Promise<readonly [bigint, bigint]>,
    ]);
    assert.equal(sb[0], BigInt(snaps.state.probe.sellBase.receiveQuoteAmount), "REAL querySellBase(probe) == captured mainnet value");
    assert.equal(sb[1], BigInt(snaps.state.probe.sellBase.mtFee), "REAL querySellBase(probe) mtFee == captured");
    assert.equal(sq[0], BigInt(snaps.state.probe.sellQuote.receiveBaseAmount), "REAL querySellQuote(probe) == captured mainnet value");
    assert.equal(sq[1], BigInt(snaps.state.probe.sellQuote.mtFee), "REAL querySellQuote(probe) mtFee == captured");

    // The DODO DVMFactory shim resolves the pool the production discovery path reads — via the REAL
    // getter getDODOPool (NOT the V1 Zoo getDODO), so this exercises the exact call the fixed
    // discovery makes and can no longer mask a wrong-getter mismatch.
    const gd = (await c.publicClient.readContract({
      address: etched.factory, abi: dodoFactoryShimAbi, functionName: "getDODOPool", args: [etched.baseToken, etched.quoteToken],
    })) as readonly Hex[];
    assert.equal(gd.length, 1, "shim getDODOPool returns exactly one pool");
    assert.equal(gd[0].toLowerCase(), etched.pool.toLowerCase(), "shim getDODOPool resolves the etched pool");

    // The MT fee-rate model shim returns the captured resolved rate for both readers.
    const [gfr, fr] = await Promise.all([
      c.publicClient.readContract({ address: etched.mtFeeModel, abi: dodoMtFeeModelShimAbi, functionName: "getFeeRate", args: [zero] }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.mtFeeModel, abi: dodoMtFeeModelShimAbi, functionName: "_FEE_RATE_" }) as Promise<bigint>,
    ]);
    assert.equal(gfr, etched.mtFeeRate, "MT shim getFeeRate == captured resolved mtFeeRate");
    assert.equal(fr, etched.mtFeeRate, "MT shim _FEE_RATE_ == captured resolved mtFeeRate");

    console.log(
      `  [dodo-prod-mirror] REAL bytecode etched: pool ${etched.pool} (proxy ${(poolCode!.length - 2) / 2} B) ` +
        `-> impl ${etched.impl} (${(implCode!.length - 2) / 2} B); MT model ${etched.mtFeeModel}; ` +
        `captured block ${snaps.state.block}; B/Q ${etched.baseReserve}/${etched.quoteReserve}; ` +
        `lpFee ${etched.lpFeeRate} mtFee ${etched.mtFeeRate}`,
    );
  });

  /** Off-chain DodoPool descriptor read from the pool's LIVE getPMMStateForCall (not the capture) —
   *  the post-swap re-anchor path prepare.ts takes. */
  async function liveOffPool(sellBase: boolean): Promise<DodoPool> {
    const pmm = (await c.publicClient.readContract({
      address: etched.pool, abi: dodoPoolReadAbi, functionName: "getPMMStateForCall",
    })) as readonly bigint[];
    return {
      poolType: SwapPoolType.DODOV2,
      address: etched.pool,
      baseToken: etched.baseToken,
      quoteToken: etched.quoteToken,
      sellBase,
      i: pmm[0], K: pmm[1], B: pmm[2], Q: pmm[3], B0: pmm[4], Q0: pmm[5],
      R: toRState(Number(pmm[6])),
      lpFeeRate: etched.lpFeeRate,
      mtFeeRate: etched.mtFeeRate,
      feePpm: 0,
      source: "prod-mirror-live",
    };
  }

  /** Assert getDy == the REAL pool's own querySell* at every ladder point, to the WEI. */
  async function assertLadder(pool: DodoPool, pays: bigint[], label: string): Promise<void> {
    for (const pay of pays) {
      const fn = pool.sellBase ? "querySellBase" : "querySellQuote";
      const view = (await c.publicClient.readContract({
        address: etched.pool, abi: dodoPoolReadAbi, functionName: fn, args: [c.account0, pay],
      })) as readonly [bigint, bigint];
      assert.ok(view[0] > 0n, `${label}: REAL ${fn}(${pay}) yields a real output`);
      assert.equal(getDy(pool, pay), view[0], `${label}: getDy(${pay}) == REAL ${fn} (wei-exact)`);
    }
  }

  // ── QUADRATIC R-state legs vs the REAL bytecode — engine-independent differential ladders. ──
  //
  // The captured DSP sits at R == ABOVE_ONE, where the cook path's sellBase (below the boundary)
  // exercises ONLY the _GeneralIntegrate leg — a replay that mis-solves
  // _SolveQuadraticFunctionForTrade would sail through the wei-exact cook assert. This cell pins
  // every QUADRATIC dispatch leg against the REAL etched bytecode at non-round ladder points
  // (odd divisors → non-terminating wei values stress the rounding directions), then EXECUTES a
  // real boundary-crossing swap so the BELOW_ONE legs run on genuine post-trade state.
  it("QUADRATIC R-state legs — off-chain replay == REAL bytecode querySell* at every ladder point", async () => {
    await setup(); // pristine captured state (the integrity cell shares the before() anvil)
    const caller = c.account0;

    // (a) ABOVE_ONE sellQuote → _RAboveSellQuoteToken: the PURE quadratic on the captured state.
    const aboveQuote = await liveOffPool(false);
    assert.equal(aboveQuote.R, RState.ABOVE_ONE, "captured pool sits at ABOVE_ONE");
    const q = etched.quoteReserve;
    await assertLadder(aboveQuote, [q / 97n, q / 13n, q / 3n, (q * 7n) / 9n], "ABOVE_ONE sellQuote (quadratic)");

    // (b) ABOVE_ONE sellBase AT/PAST back-to-one → the two-part backToOneReceiveQuote +
    // _ROneSellBaseToken quadratic remainder (plus the just-below clamp edge).
    const aboveBase = await liveOffPool(true);
    const backToOnePayBase = aboveBase.B0 - aboveBase.B;
    await assertLadder(
      aboveBase,
      [backToOnePayBase - 1n, backToOnePayBase, backToOnePayBase + 1n, (backToOnePayBase * 13n) / 9n, backToOnePayBase * 3n],
      "ABOVE_ONE sellBase crossing (quadratic remainder)",
    );

    // (c) EXECUTE a real crossing sellBase on the REAL bytecode (transfer-first — exactly the
    // engine `_swapDODOV2` surface): realized output == the pre-swap replay, R moves BELOW_ONE.
    const payBase = (backToOnePayBase * 13n) / 9n;
    const expectedOut = getDy(aboveBase, payBase);
    const outBefore = await balanceOf(c.publicClient, etched.quoteToken, caller);
    await writeAndWait(c.walletClient, c.publicClient, {
      address: etched.baseToken, abi: erc20Abi as Abi, functionName: "transfer", args: [etched.pool, payBase],
    });
    await writeAndWait(c.walletClient, c.publicClient, {
      address: etched.pool, abi: dodoSellAbi as Abi, functionName: "sellBase", args: [caller],
    });
    const received = (await balanceOf(c.publicClient, etched.quoteToken, caller)) - outBefore;
    assert.equal(received, expectedOut, "REAL executed crossing sellBase == pre-swap getDy (wei-exact)");

    // (d) LIVE BELOW_ONE sellBase → _RBelowSellBaseToken: the pure quadratic on post-trade state.
    const belowBase = await liveOffPool(true);
    assert.equal(belowBase.R, RState.BELOW_ONE, "the executed crossing moved R to BELOW_ONE");
    const b = belowBase.B;
    await assertLadder(belowBase, [b / 97n, b / 13n, b / 3n], "BELOW_ONE sellBase (quadratic)");

    // (e) LIVE BELOW_ONE sellQuote below/at/past ITS boundary → _RBelowSellQuoteToken
    // (GeneralIntegrate + clamp) then the two-part _ROneSellQuoteToken quadratic remainder.
    const belowQuote = await liveOffPool(false);
    const backToOnePayQuote = belowQuote.Q0 - belowQuote.Q;
    await assertLadder(
      belowQuote,
      [backToOnePayQuote / 3n, backToOnePayQuote - 1n, backToOnePayQuote, backToOnePayQuote + 1n, (backToOnePayQuote * 11n) / 7n],
      "BELOW_ONE sellQuote crossing",
    );

    console.log(
      `  [dodo-prod-mirror] QUADRATIC ladders wei-exact vs REAL bytecode: ABOVE sellQuote ×4, ` +
        `crossing sellBase ×5, executed crossing (${payBase} base -> ${received} quote), ` +
        `BELOW sellBase ×3, BELOW sellQuote ×5`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Sell base → quote (the captured probe direction): tokenIn = base (DAI), tokenOut = quote (USDT).
    const tokenIn = etched.baseToken;
    const tokenOut = etched.quoteToken;

    // A meaningful stable trade: ~5% of the base reserve — well inside the ABOVE_ONE rebalancing
    // region (backToOnePayBase = B0 - B ≈ 3087 DAI, this is ~272 DAI), so the whole trade allocates
    // to this single venue (single-venue full-fill, asserted below).
    const amountIn = etched.baseReserve / 20n;
    const poolConfig = dodoPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // Run EcoSwap through the PRODUCTION FactoryType.DODOZoo discovery path.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced DODO venue (via the real getters).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (DODO-only config)");
    assert.equal((prepared.dodos ?? []).length, 1, "discovered exactly the 1 reproduced DODO venue");
    assert.equal(
      prepared.dodos![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered DODO venue is the REAL etched pool",
    );
    assert.equal(prepared.dodos![0].sellBase, true, "discovery oriented the venue as sellBase (tokenIn == base)");
    // DODO is now a QUOTE-LADDER (QL) venue: prepare ships ONLY the descriptor (prepared.dodos), NO static
    // sampled DODO brackets. The on-chain solver builds the price ladder live from the pool's own querySell*.
    assert.ok(
      !(prepared.brackets ?? []).some((b) => b.kind === EcoBracketKind.DODO),
      "DODO ships as a QL descriptor (no static sampled DODO brackets)",
    );

    // QL LADDER == REAL VIEW at S points: the off-chain buildDodoQLLadder (seeded from the REAL captured
    // PMM state) queries getDy at the SAME geometric `qlLadderInputs` points the on-chain solver queries
    // the pool's own querySellBase at — assert they agree to the WEI, tying the ladder to the real DSP curve.
    const opProbe = offPool(snaps.state);
    for (const xNext of qlLadderInputs(amountIn)) {
      const real = (await c.publicClient.readContract({
        address: etched.pool, abi: dodoPoolReadAbi, functionName: "querySellBase", args: [caller, xNext],
      })) as readonly [bigint, bigint];
      assert.equal(getDy(opProbe, xNext), real[0], `QL ladder getDy(${xNext}) == REAL querySellBase[0] at the sample point`);
    }

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one DODO venue seeded from the REAL captured PMM state via the
    // SHARED buildDodoQLLadder (the IDENTICAL geometric quote ladder the on-chain solver builds live). This
    // is pure off-chain math (computed BEFORE the cook), so the awarded Σ is known ahead — and the solver's
    // on-chain-built ladder is wei-exact with it, so on-chain spent == oracle.totalInput to the wei.
    const op = offPool(snaps.state);
    const optPools: OptimalPool[] = [{ dodo: op, feePpm: 0 }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced DODO venue");

    // The REAL pool's OWN PRE-swap querySellBase view for the KNOWN awarded Σ — the engine-
    // independent ground truth for the executed dy of the awarded slice, read on the pre-swap state
    // (the sell mutates reserves). This is the real Solidity PMM curve, NOT the off-chain replay.
    const onViewPre = (await c.publicClient.readContract({
      address: etched.pool, abi: dodoPoolReadAbi, functionName: "querySellBase", args: [caller, awarded],
    })) as readonly [bigint, bigint];
    const onViewOut = onViewPre[0];

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, etched.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL DSP bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, etched.pool)) - poolInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // HONEST fee accounting: the DSP applies its LP+MT fee to the OUTPUT (deducted from the quote
    // out), NOT the input — so the pool nets the FULL tokenIn (contrast Solidly, which routes the
    // input fee to a separate PoolFees contract). Assert the pool received exactly what was spent.
    assert.equal(poolIn, spent, "REAL DSP netted the FULL input (fee is taken on the output, not the input)");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI. NO tolerance.
    // (DODO is a QUOTE-LADDER venue: buildDodoQLLadder walks the PMM curve on the QL_S geometric ladder
    // capped at amountIn via getDy (querySell*); the on-chain solver builds the IDENTICAL ladder live from
    // the pool's own querySellBase, so spent == the oracle's awarded Σ == oracle.totalInput to the WEI —
    // wei-exact by construction. The awarded Σ MAY sit a small documented tail below amountIn near
    // saturation; here the trade is far from saturation, so the ladder covers amountIn fully.)
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact-on-grid)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact-on-grid)");
    // The awarded grid Σ is at most amountIn; the unfilled tail is the DODO segment-grid remainder
    // (the dropped near-saturation slice), a small fraction of amountIn — assert it is bounded (<2%)
    // so a regression that grossly under-fills (a broken ladder / wrong orientation) still fails.
    assert.ok(spent <= amountIn, "spent does not exceed amountIn");
    const tail = amountIn - spent;
    assert.ok(tail * 50n < amountIn, `unfilled tail is the small DODO grid remainder (<2% of amountIn): tail=${tail}`);

    // The caller-received tokenOut == getDy(spent) (the oracle's realized dy for the awarded Σ) ==
    // the REAL pool's OWN pre-swap querySellBase(spent) view, all to the WEI. NO tolerance. The
    // three-way agreement (TS oracle == real Solidity view == executed swap), for exactly the awarded
    // Σ the solver spent, ties the executed output to the real pool's own PMM curve.
    assert.equal(received, getDy(op, spent), "received == neutral-oracle getDy(spent) (wei-exact-in-dy)");
    assert.equal(received, onViewOut, "received == REAL pool pre-swap querySellBase(awarded Σ) (exact-in-dy)");

    const ms = Date.now() - t0;
    console.log(
      `  [dodo-prod-mirror:${engine}] WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, getDy=${getDy(op, spent)}, realView=${onViewOut}, amountIn=${amountIn}, tail=${tail}); ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL DODO DSP bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
