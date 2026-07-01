/**
 * EcoSwap Wombat (single-sided stableswap) PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The Wombat analogue of ecoswap.solidly.prodmirror.evm.test.ts / ecoswap.dodo.prodmirror.evm.test.ts.
 * Unlike ecoswap.wombat.evm.test.ts (which deploys a MOCK WombatPool.sol fixture), this test stands
 * up the GENUINE Wombat Main Pool bytecode captured from BSC mainnet and runs the swap against it —
 * proving the production discovery + execution path works on the real contract, with NO fork and NO
 * RPC at run time (etch + setStorageAt, seconds).
 *
 * MECHANISM (mirrors the repo's Uniswap-V4 real-runtime etch, generalised in harness/etch-pool.ts):
 *   CAPTURE (one-time, harness/wombat-snapshot.ts, uses the RPC key):
 *     the wired FactoryType.Wombat Main Pool 0x312Bc7… serving the on-charter BSC baseTokens USDC ↔
 *     USDT is an EIP-1967 TRANSPARENT PROXY (→ a logic impl) that holds NO tokens — each token's
 *     reserve lives in a per-token ASSET contract (cash + liability packed in one WAD slot; the Asset
 *     HOLDS the underlying ERC20). We eth_getCode the Pool proxy + impl + BOTH Asset runtimes into
 *     fixtures/snapshots/bsc-wombat-USDCUSDT.bytecode.json (WITH sha256 anchors), and the swap-relevant
 *     STATE (ampFactor/haircutRate/covRatios + the two _assets[token] mapping slots + each Asset's raw
 *     storage window incl. the packed cash|liability + decimals + a quotePotentialSwap probe) into
 *     .state.json. Block pinned. No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); setCode the REAL impl at its captured
 *     address + the REAL proxy at the pool address + each REAL Asset at its captured address;
 *     setStorageAt the captured pool + asset storage VERBATIM (incl. the EIP-1967 impl slot + the two
 *     hashed _assets[token] mapping slots), and etch a local MintableERC20 AT EACH REAL underlying
 *     token address (the Asset's underlyingToken is an IMMUTABLE baked in the Asset bytecode — the same
 *     V4 StateView→PoolManager immutable-address constraint), funding each Asset with its captured held
 *     balance. The swap then runs the GENUINE impl + Asset bytecode: quotePotentialSwap returns the
 *     mainnet-identical dy for the captured coverage-ratio state.
 *
 * CENTRAL VERIFICATION (this file asserts all three explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool + impl + BOTH assets in the test == the captured real
 *       runtime, byte-for-byte. No mock WombatPool.sol is in the swap path (the pool/impl/asset
 *       addresses are the captured mainnet addresses, running captured code). ampFactor/haircutRate +
 *       addressOfAsset + cash/liability reproduce the captured state, and quotePotentialSwap reproduces
 *       the captured probe quote.
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts optimalSplit,
 *       seeded from the REAL captured cash/liability/amp/haircut via the SHARED buildWombatSegments) ==
 *       the REAL pool's own pre-swap quotePotentialSwap view of the awarded slice, all to the wei. spent
 *       == awarded is asserted explicitly.
 *
 * HONEST fee accounting: like DODO (and UNLIKE Solidly, which routes the swap fee to a separate
 * PoolFees contract, netting the pool's tokenIn delta below `spent`), Wombat applies its haircut to the
 * OUTPUT (haircut = idealOut·haircutRate, deducted from the quote out) — so the from-Asset receives the
 * FULL tokenIn (`assetIn == spent`) and the fee shows up as a smaller tokenOut, exactly as the oracle's
 * quotePotentialSwap (which nets the SAME haircut off the ideal out) models it. Assert assetIn == spent.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts
 * are absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.wombat.prodmirror.evm.test.ts
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
  etchWombatPool,
  loadWombatSnapshots,
  verifyWombatBytecodeIntegrity,
  wombatPoolReadAbi,
  wombatAssetReadAbi,
  type EtchedWombatPool,
  type WombatStateSnapshot,
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
import { quotePotentialSwap, WAD, type WombatPool } from "../shared/wombat-math";

const SNAP_NAME = "bsc-wombat-USDCUSDT";
const ENGINE_CELLS = engineCells();

describe("EcoSwap Wombat (single-sided stableswap) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadWombatSnapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedWombatPool;

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
    // Caller headroom in the from-token (USDC). The pool's deep-payout side (USDT asset holds ~45.9k)
    // comfortably covers the ~2.3k trade sized below.
    etched = await etchWombatPool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: BigInt(snaps.state.assetUSDT.underlyingBalance),
    });
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a Wombat factory (the pool itself) → the production Wombat discovery path
   *  resolves the etched pool via addressOfAsset/cash/liability/amp/haircut; the lens ignores non-
   *  V2/V3/V4 factory types, so no direct pools are surfaced and the Wombat venue rides entirely through
   *  discoverWombatPoolsTyped. (No factory shim is needed — the FactoryConfig.address IS the pool.) */
  function wombatPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.pool,
          poolType: SwapPoolType.UniV2, // inert for Wombat — discovery keys off factoryType
          factoryType: FactoryType.Wombat,
          label: "Local Wombat (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  /** The neutral oracle's WombatPool descriptor for the reproduced Main Pool, seeded from the REAL
   *  captured asset cash/liability + pool amp/haircut. tokenIn == the from-asset (USDC). decIn/decOut are
   *  the WAD↔native factors (both 18-dec Binance-Peg here). This replays quotePotentialSwap bit-for-bit,
   *  because the pool's quotePotentialSwap view IS the math its swap enforces. */
  function offPool(state: WombatStateSnapshot): WombatPool {
    return {
      address: etched.pool,
      fromCash: BigInt(state.assetUSDC.cash),
      fromLiability: BigInt(state.assetUSDC.liability),
      toCash: BigInt(state.assetUSDT.cash),
      toLiability: BigInt(state.assetUSDT.liability),
      ampFactor: BigInt(state.ampFactor),
      haircutRate: BigInt(state.haircutRate),
      decIn: 10n ** BigInt(state.decimalsUSDC),
      decOut: 10n ** BigInt(state.decimalsUSDT),
      tokenIn: etched.fromToken,
      tokenOut: etched.toToken,
      feePpm: Number((BigInt(state.haircutRate) * 1_000_000n + WAD / 2n) / WAD),
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL Wombat pool bytecode (byte-equal) + reconstructs the captured coverage state", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime blobs still hash to the sha256
    // anchors recorded at capture time (byte-equal to the pinned-block on-chain code). A reviewer
    // without the RPC key can run this — it proves the snapshot wasn't silently altered after capture,
    // with NO RPC.
    const integ = verifyWombatBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pool proxy runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(integ.implementation.ok, `impl runtime sha256 matches the capture anchor (got ${integ.implementation.actual})`);
    assert.ok(snaps.bytecode.pool.runtimeSha256, "pool snapshot carries a sha256 integrity anchor");
    assert.ok(snaps.bytecode.implementation.runtimeSha256, "impl snapshot carries a sha256 integrity anchor");
    assert.equal(integ.assets.length, 2, "both Asset runtimes present in the bytecode snapshot");
    for (const a of integ.assets) {
      assert.ok(a.ok, `Asset ${a.token} runtime sha256 matches the capture anchor (got ${a.actual})`);
    }

    // getCode at the pool + impl + BOTH assets must EQUAL the captured real runtime (no mock in path).
    const [poolCode, implCode, fromAssetCode, toAssetCode] = await Promise.all([
      c.publicClient.getCode({ address: etched.pool }),
      c.publicClient.getCode({ address: etched.impl }),
      c.publicClient.getCode({ address: etched.fromAsset }),
      c.publicClient.getCode({ address: etched.toAsset }),
    ]);
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pool.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL Wombat proxy runtime (byte-equal)",
    );
    assert.ok(implCode, "impl has code");
    assert.equal(
      implCode!.toLowerCase(),
      snaps.bytecode.implementation.runtime.toLowerCase(),
      "eth_getCode at the impl == the captured REAL Wombat impl runtime (byte-equal)",
    );
    assert.equal(
      fromAssetCode!.toLowerCase(),
      snaps.bytecode.assets[etched.fromToken.toLowerCase()].runtime.toLowerCase(),
      "eth_getCode at the from-Asset == the captured REAL Asset runtime (byte-equal)",
    );
    assert.equal(
      toAssetCode!.toLowerCase(),
      snaps.bytecode.assets[etched.toToken.toLowerCase()].runtime.toLowerCase(),
      "eth_getCode at the to-Asset == the captured REAL Asset runtime (byte-equal)",
    );
    // The pool/impl/asset addresses are the CAPTURED mainnet addresses — no locally-compiled mock.
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.address.toLowerCase(), "pool at captured mainnet address");
    assert.equal(etched.impl.toLowerCase(), snaps.bytecode.implementation.address.toLowerCase(), "impl at captured mainnet address");

    // The REAL code reads the reconstructed state correctly through the proxy delegatecall.
    const [fromAsset, toAsset, amp, haircut] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: wombatPoolReadAbi, functionName: "addressOfAsset", args: [etched.fromToken] }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: wombatPoolReadAbi, functionName: "addressOfAsset", args: [etched.toToken] }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: wombatPoolReadAbi, functionName: "ampFactor" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: wombatPoolReadAbi, functionName: "haircutRate" }) as Promise<bigint>,
    ]);
    assert.equal(fromAsset.toLowerCase(), etched.fromAsset.toLowerCase(), "addressOfAsset(from) resolves the from-Asset");
    assert.equal(toAsset.toLowerCase(), etched.toAsset.toLowerCase(), "addressOfAsset(to) resolves the to-Asset");
    assert.equal(amp, BigInt(snaps.state.ampFactor), "ampFactor == captured");
    assert.equal(haircut, BigInt(snaps.state.haircutRate), "haircutRate == captured");

    // Each Asset's cash/liability + immutable underlyingToken reconstruct exactly.
    const [fCash, fLiab, fUnd, tCash, tLiab, tUnd] = await Promise.all([
      c.publicClient.readContract({ address: etched.fromAsset, abi: wombatAssetReadAbi, functionName: "cash" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.fromAsset, abi: wombatAssetReadAbi, functionName: "liability" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.fromAsset, abi: wombatAssetReadAbi, functionName: "underlyingToken" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.toAsset, abi: wombatAssetReadAbi, functionName: "cash" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.toAsset, abi: wombatAssetReadAbi, functionName: "liability" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.toAsset, abi: wombatAssetReadAbi, functionName: "underlyingToken" }) as Promise<Hex>,
    ]);
    assert.equal(fCash, BigInt(snaps.state.assetUSDC.cash), "from-Asset cash == captured");
    assert.equal(fLiab, BigInt(snaps.state.assetUSDC.liability), "from-Asset liability == captured");
    assert.equal(fUnd.toLowerCase(), etched.fromToken.toLowerCase(), "from-Asset underlyingToken immutable == the etched local token address");
    assert.equal(tCash, BigInt(snaps.state.assetUSDT.cash), "to-Asset cash == captured");
    assert.equal(tLiab, BigInt(snaps.state.assetUSDT.liability), "to-Asset liability == captured");
    assert.equal(tUnd.toLowerCase(), etched.toToken.toLowerCase(), "to-Asset underlyingToken immutable == the etched local token address");

    // The REAL quotePotentialSwap reproduces the captured mainnet probe quote (real coverage-ratio math).
    const probeIn = BigInt(snaps.state.probe.amountIn);
    const q = (await c.publicClient.readContract({
      address: etched.pool, abi: wombatPoolReadAbi, functionName: "quotePotentialSwap",
      args: [etched.fromToken, etched.toToken, probeIn],
    })) as readonly [bigint, bigint];
    assert.equal(q[0], BigInt(snaps.state.probe.amountOut), "REAL quotePotentialSwap(probe) == the captured mainnet value");
    assert.equal(q[1], BigInt(snaps.state.probe.haircut), "REAL quotePotentialSwap(probe) haircut == captured");

    console.log(
      `  [wombat-prod-mirror] REAL bytecode etched: pool ${etched.pool} (proxy ${(poolCode!.length - 2) / 2} B) ` +
        `-> impl ${etched.impl} (${(implCode!.length - 2) / 2} B); assets ${etched.fromAsset}/${etched.toAsset}; ` +
        `captured block ${snaps.state.block}; amp ${etched.ampFactor} haircut ${etched.haircutRate}`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Sell USDC → USDT (the captured probe direction): tokenIn = from (USDC), tokenOut = to (USDT).
    const tokenIn = etched.fromToken;
    const tokenOut = etched.toToken;

    // A meaningful stable trade well within the deep USDT payout side. Small vs the ~45.9k USDT the
    // to-Asset holds, so the whole trade allocates to this single venue (single-venue full-fill,
    // asserted below); the from-Asset (USDC) has ~7.8k cash which comfortably absorbs it.
    const amountIn = 2000n * 10n ** BigInt(snaps.state.decimalsUSDC);
    const poolConfig = wombatPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // Run EcoSwap through the PRODUCTION FactoryType.Wombat discovery path.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced Wombat venue (via the real getters).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (Wombat-only config)");
    assert.equal((prepared.wombats ?? []).length, 1, "discovered exactly the 1 reproduced Wombat venue");
    assert.equal(
      prepared.wombats![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered Wombat venue is the REAL etched pool",
    );
    assert.ok(
      (prepared.brackets ?? []).some((b) => b.kind === EcoBracketKind.Wombat),
      "Wombat segments present",
    );

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one Wombat venue seeded from the REAL captured coverage
    // state via the SHARED buildWombatSegments. This is pure off-chain math (computed BEFORE the cook),
    // so the awarded Σ is known ahead — and the engine's static-segment cursor consumes the IDENTICAL
    // grid, so on-chain spent == oracle.totalInput to the wei.
    const op = offPool(snaps.state);
    const optPools: OptimalPool[] = [{ wombat: op, feePpm: op.feePpm }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced Wombat venue");

    // The REAL pool's OWN PRE-swap quotePotentialSwap view for the KNOWN awarded Σ — the engine-
    // independent ground truth for the executed dy, read on the pre-swap state (the swap mutates cash).
    // This is the real Solidity coverage-ratio curve, NOT the off-chain replay.
    const onViewPre = (await c.publicClient.readContract({
      address: etched.pool, abi: wombatPoolReadAbi, functionName: "quotePotentialSwap",
      args: [tokenIn, tokenOut, awarded],
    })) as readonly [bigint, bigint];
    const onViewOut = onViewPre[0];

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    // Wombat is a MULTI-ASSET singleton — the tokenIn lands in the FROM-Asset (which HOLDS the ERC20),
    // NOT the pool proxy. Measure the from-Asset delta for the "pool netted the input" check.
    const assetInBefore = await balanceOf(c.publicClient, tokenIn, etched.fromAsset);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL Wombat bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const assetIn = (await balanceOf(c.publicClient, tokenIn, etched.fromAsset)) - assetInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // HONEST fee accounting: like DODO, Wombat applies its haircut to the OUTPUT (haircut =
    // idealOut·haircutRate, deducted from the quote out), NOT the input — so the from-Asset nets the
    // FULL tokenIn (contrast Solidly, which routes the input fee to a separate PoolFees contract).
    // Assert the from-Asset received exactly what was spent.
    assert.equal(assetIn, spent, "REAL Wombat from-Asset netted the FULL input (haircut is on the output, not the input)");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI. NO tolerance.
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact-on-grid)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact-on-grid)");
    // SINGLE-VENUE FULL-FILL is the documented expectation for this sizing (amountIn well inside the deep
    // payout side, one Wombat venue, the segment ladder covers [0, amountIn]) — so the whole trade
    // allocates to this one pool and spent == amountIn. Assert it EXPLICITLY (not a silent guard): a
    // regression that leaves a wei unspent, or splits the trade, must fail here rather than quietly skip
    // the strongest cross-check.
    assert.equal(spent, amountIn, "single-venue full-fill: spent == amountIn (no unspent wei, no split)");

    // The caller-received tokenOut == quotePotentialSwap(spent) (the oracle's realized dy for the
    // awarded Σ) == the REAL pool's OWN pre-swap quotePotentialSwap(spent) view, all to the WEI. NO
    // tolerance. The three-way agreement (TS oracle == real Solidity view == executed swap), for exactly
    // the awarded Σ the solver spent, ties the executed output to the real pool's own curve.
    assert.equal(received, quotePotentialSwap(op, spent), "received == neutral-oracle quotePotentialSwap(spent) (wei-exact-in-dy)");
    assert.equal(received, onViewOut, "received == REAL pool pre-swap quotePotentialSwap(awarded Σ) (exact-in-dy)");

    const ms = Date.now() - t0;
    console.log(
      `  [wombat-prod-mirror:${engine}] WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, quotePotentialSwap=${quotePotentialSwap(op, spent)}, realView=${onViewOut}, amountIn=${amountIn}); ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Wombat bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
