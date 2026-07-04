/**
 * EcoSwap Curve CryptoSwap (twocrypto-NG) PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The CryptoSwap analogue of ecoswap.solidly.prodmirror.evm.test.ts. Unlike ecoswap.crypto.evm.test.ts
 * (which deploys a MOCK CryptoSwapPool.sol fixture whose tricrypto-ng math the off-chain replay
 * mirrors bit-for-bit), this test stands up the GENUINE twocrypto-NG CryptoSwap pool bytecode captured
 * from Ethereum mainnet — the pool + its TWO real MATH library contracts + the factory — and runs the
 * swap against them, proving the production discovery + execution path works on the real Vyper contract,
 * with NO fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * QUOTE-LADDER (QL) — closing the offline COOK gap. CryptoSwap is a QL venue (like Curve StableSwap):
 * prepare ships ONLY a descriptor and the on-chain solver BUILDS the price ladder in setup from LIVE
 * get_dy. Unlike Curve's FRAXUSDe prod-mirror (whose get_dy delegates to UNCAPTURED singletons, so its
 * QL cook is skipped), this Twocrypto v2.1.0d pool's get_dy is SELF-CONTAINED in {pool, VIEW, MATH} —
 * all etched — so the on-chain QL ladder build runs OFFLINE against the real bytecode. This test COOKS
 * it via the QL path with ZERO prepared segments (only the descriptor), asserting the on-chain-built
 * ladder matches the real pool get_dy at every QL point AND lands the neutral oracle's split to the wei.
 *
 * POOL: crvUSD/WETH Twocrypto (0x6e5492F8…), Ethereum, block 2544xxxx — the fxswap/"boom" twocrypto-ng
 * generation (sourcify-verified, `version() == "v2.1.0d"`, Vyper 0.4.3) the canonical factory deploys:
 * crypto periphery (price_scale repeg + dynamic fee) over a STABLESWAP invariant. A self-contained
 * Vyper pool (coins baked as IMMUTABLES) whose get_dy/exchange STATICCALL its storage-held periphery
 * (MATH = the StableswapMath 0x79839…, VIEW = 0x35048188… — both unverified on-chain, both captured
 * byte-for-byte) and whose exchange reads factory.fee_receiver(). ALL captured; see the fidelity note.
 *
 * MECHANISM (mirrors the repo's real-runtime etch, generalised in harness/etch-pool.ts):
 *   CAPTURE (one-time, harness/curveCrypto-snapshot.ts, uses the RPC key): eth_getCode the pool's REAL
 *     23.6 KB Vyper runtime + EVERY external contract the get_dy invariant STATICCALLs (discovered via a
 *     debug_traceCall of get_dy — the AUTHORITATIVE source, because the public MATH() getter reports a
 *     DIFFERENT address than the deploy-time-baked immutable the invariant actually calls) + the factory,
 *     into fixtures/snapshots/ethereum-curveCrypto-crvUSDWETH.bytecode.json (WITH sha256 anchors), and the
 *     full invariant state + the raw pool/factory storage into .state.json. Block pinned. No
 *     key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); setCode the REAL pool runtime at its captured
 *     address (coins restore for free from the runtime immutables); setCode BOTH real MATH runtimes at
 *     their captured addresses; etch local MintableERC20s AT the real coin addresses (immutable-keyed,
 *     Wombat/WOOFi-style, NOT setStorageAt); setStorageAt the captured linear pool storage verbatim; stand
 *     up ONE combined read-only factory/registry shim at the captured factory address (the CryptoRegistry
 *     discovery surface AND fee_receiver()). The swap then runs the GENUINE pool + MATH bytecode:
 *     get_dy(uint256 i,j,dx) / exchange(uint256 i,j,dx,min_dy) compute the mainnet-identical dy and move
 *     the local coins.
 *
 * CENTRAL VERIFICATION (this file asserts all three explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool AND every dependency (both MATH contracts + the factory)
 *       byte-equals the captured real runtime, hashing to the sha256 anchor with NO RPC. NO mock
 *       CryptoSwapPool.sol is in the swap path (the pool/math addresses are the captured mainnet
 *       addresses, running captured code). The one non-real contract is the READ-ONLY factory/registry
 *       shim — discovery metadata + a benign fee_receiver scalar, DISCLOSED as output-irrelevant below.
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — the caller-received tokenOut == the REAL pool's OWN pre-swap get_dy view of the
 *       awarded slice (== the actual swap math the recipe reads for min_dy) AND == the neutral oracle's
 *       realized dy, all to the wei. spent == awarded is asserted explicitly.
 *
 * FULL PRODUCTION-PATH FIDELITY — the SWAP is 100% real code AND the off-chain replay models it:
 *   • EXECUTION path (100% real): exchange(uint256 i,j,dx,min_dy) — what the recipe calls CALLBACK-FREE —
 *     runs the REAL etched pool + BOTH periphery runtimes end-to-end (the fx/boom STABLESWAP
 *     get_y/newton_D + the v2.1.0d dynamic fee inline, fee_receiver serviced by the shim). The on-chain
 *     get_dy view (the recipe's min_dy source AND this test's ground truth) is ALSO self-contained in
 *     {pool, VIEW, MATH} — it does NOT touch the factory — so it runs offline against the real code
 *     (verified: it reproduces the captured probe dy AND == exchange to the wei).
 *   • The shared off-chain `cryptoswap-math.ts` replay mirrors THIS deployed pool family (the fxswap/
 *     "boom" Twocrypto v2.1.0d: STABLESWAP get_y/newton_D with Ann = A·N and gamma ignored, the view's
 *     RAW-product xp scaling, the v2.1.0d dynamic fee on the POST-swap xp) — wei-exact against the
 *     captured mainnet probes AND, in this test, against the etched real bytecode at EVERY QL
 *     ladder point. So this test runs the FULL production path unmasked: DISCOVERY
 *     (discoverCryptoSwapPoolsTyped → find_pool_for_coins → get_coin_indices [UINT256] → the live pool
 *     reads) resolves + orients the pool, the PRODUCTION buildCryptoSwapQLLadder replays the descriptor
 *     off-chain (asserted == the real pool's own get_dy at every QL grid point — the SAME points the
 *     on-chain qlv loop quotes), and the PRODUCTION ecoswap.sauce.ts solver (the same template index.ts
 *     compiles) COOKS the QL descriptor, building the ladder ON-CHAIN from the real live get_dy.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts
 * are absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.crypto.prodmirror.evm.test.ts
 *      ECO_ENGINE=both pnpm --filter './sdk' test:recipes:evm
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  etchCurveCryptoPool,
  loadCurveCryptoSnapshots,
  verifyCurveCryptoBytecodeIntegrity,
  curveCryptoPoolReadAbi,
  curveCryptoRegistryShimAbi,
  type EtchedCurveCryptoPool,
} from "./harness/etch-pool";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { SwapPoolType, FactoryType, MIN_SQRT_RATIO, type ChainPoolConfig } from "../shared/constants";
import { discoverCryptoSwapPoolsTyped } from "../shared/pool-discovery";
import { getDyCrypto, buildCryptoSwapQLLadder } from "../shared/cryptoswap-math";
import { optimalSplit } from "./ecoswap.optimal";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_NAME = "ethereum-curveCrypto-crvUSDWETH";
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");
const ENGINE_CELLS = engineCells();

describe("EcoSwap Curve CryptoSwap (twocrypto-NG) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadCurveCryptoSnapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedCurveCryptoPool;
  let solverSrc: string;

  // Boot a fresh anvil + etch the real pool + deploy the engine. Called before each cell so each engine
  // runs in full isolation (cheap — the whole setup is etch + setStorageAt + a handful of deploys).
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    solverSrc = readFileSync(SOLVER, "utf-8");
    // ~2x the coin0 (crvUSD) balance as caller headroom (18-decimal coin; balance ~13.4M crvUSD).
    etched = await etchCurveCryptoPool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: BigInt(snaps.state.balances[0]) * 2n,
    });
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a CurveCryptoRegistry factory (the combined shim) → the production
   *  CryptoSwap discovery path resolves the etched pool; the lens ignores non-V2/V3/V4 factory types. */
  function cryptoPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.registry,
          poolType: SwapPoolType.Curve,
          factoryType: FactoryType.CurveCryptoRegistry,
          label: "Local Curve CryptoSwap (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // The solver's 6 compiler args, in index.ts order (cfg, pools, netCache, routing, segs, qlv). CryptoSwap
  // is a QUOTE-LADDER (QL) venue now: ZERO prepared segments (segs = []) — the venue rides entirely inside
  // qlv as a DESCRIPTOR, and the solver builds its price ladder ON-CHAIN from live get_dy at cook time.
  function cryptoArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, qlv: bigint[][]): unknown[] {
    return [
      [
        BigInt(tokenIn),
        BigInt(tokenOut),
        amountIn,
        BigInt(caller),
        MIN_SQRT_RATIO + 1n, // priceLimit (unused by QL venues)
        0n, // directCount — no direct pools
      ],
      [], // pools
      [], // netCache
      [], // routing
      [], // segs — ZERO prepared static segments (the QL cook is prepare-optional)
      qlv,
    ];
  }

  // One QL CryptoSwap descriptor: [poolAddr, i, j, feePpm, segKind=9, refIdx]. i/j are the UINT256 coin
  // indices discovery resolved; feePpm is informational (a CryptoSwap get_dy is post-fee — the on-chain
  // head needs no fee-adjust). NO sampled values: the solver builds the ladder from live get_dy on-chain.
  function cryptoDescriptor(pool: Hex, i: number, j: number, feePpm: number, refIdx: number): bigint[] {
    return [BigInt(pool), BigInt(i), BigInt(j), BigInt(feePpm), 9n, BigInt(refIdx)];
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL twocrypto-NG pool + MATH + factory bytecode (byte-equal) + reconstructs the state", async () => {
    // NO-NETWORK integrity tripwire FIRST: every checked-in runtime blob still hashes to the sha256 anchor
    // recorded at capture time (byte-equal to the pinned-block on-chain code). A reviewer without the RPC
    // key can run this — it proves the snapshot wasn't silently altered after capture, with NO RPC.
    const integ = verifyCurveCryptoBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pool runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(snaps.bytecode.pool.runtimeSha256, "pool snapshot carries a sha256 integrity anchor");
    assert.equal(snaps.bytecode.isMinimalProxy, false, "not a clone/proxy (self-contained Vyper)");
    // BOTH MATH contracts + the factory are anchored + intact.
    const mathDeps = integ.dependencies.filter((d) => d.name === "math" || d.name.startsWith("math-helper"));
    assert.ok(mathDeps.length >= 2, "captured the split twocrypto-NG MATH (primary + helper)");
    for (const d of integ.dependencies) {
      assert.ok(d.ok, `${d.name} runtime sha256 matches the capture anchor (got ${d.actual})`);
    }
    const factoryDep = integ.dependencies.find((d) => d.name === "factory");
    assert.ok(factoryDep && factoryDep.ok, "factory runtime sha256 matches the capture anchor");

    // getCode at the pool + BOTH MATH contracts must EQUAL the captured real runtime (no mock in the path).
    const poolCode = await c.publicClient.getCode({ address: etched.pool });
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pool.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL twocrypto-NG Vyper runtime (byte-equal)",
    );
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.address.toLowerCase(), "pool at captured mainnet address");
    for (const md of (snaps.bytecode.dependencies ?? []).filter((d) => d.name === "math" || d.name.startsWith("math-helper"))) {
      const mc = await c.publicClient.getCode({ address: md.address });
      assert.ok(mc, `MATH dep ${md.name} has code`);
      assert.equal(
        mc!.toLowerCase(),
        md.runtime.toLowerCase(),
        `eth_getCode at ${md.name} (${md.address}) == the captured REAL CurveCryptoMathOptimized runtime (byte-equal)`,
      );
    }

    // The REAL code reads the reconstructed state correctly — coins from IMMUTABLES, the rest from the
    // setStorageAt'd linear window, fee_receiver from the shim.
    const [coin0, coin1, A, gamma, ps, D, b0, b1, feeR] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "coins", args: [0n] }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "coins", args: [1n] }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "A" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "gamma" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "price_scale" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "D" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "balances", args: [0n] }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "balances", args: [1n] }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "fee_receiver" }) as Promise<Hex>,
    ]);
    assert.equal(coin0.toLowerCase(), etched.coins[0].toLowerCase(), "coins(0) resolves the local token at the real coin address (immutable-baked)");
    assert.equal(coin1.toLowerCase(), etched.coins[1].toLowerCase(), "coins(1) resolves the local token at the real coin address (immutable-baked)");
    assert.equal(A, etched.A, "A() == captured");
    assert.equal(gamma, etched.gamma, "gamma() == captured");
    assert.equal(ps, etched.priceScale, "price_scale() == captured");
    assert.equal(D, etched.D, "D() == captured");
    assert.equal(b0, etched.balances[0], "balances(0) == captured");
    assert.equal(b1, etched.balances[1], "balances(1) == captured");
    assert.equal(feeR.toLowerCase(), etched.feeReceiver.toLowerCase(), "fee_receiver() == the captured resolved receiver (via the shim)");

    // The REAL get_dy view — self-contained in {pool, VIEW, MATH}, no factory — reproduces the captured
    // mainnet probe dy to the WEI (the fx/boom stableswap get_y + the v2.1.0d dynamic fee, ALL through
    // the real periphery runtimes).
    const dyF = (await c.publicClient.readContract({
      address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "get_dy", args: [0n, 1n, BigInt(snaps.state.probe.sellCoin0.dx)],
    })) as bigint;
    assert.equal(dyF.toString(), snaps.state.probe.sellCoin0.dy, "REAL get_dy(0->1, probe) == the captured mainnet value (real Vyper+MATH code)");
    const dyR = (await c.publicClient.readContract({
      address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "get_dy", args: [1n, 0n, BigInt(snaps.state.probe.sellCoin1.dx)],
    })) as bigint;
    assert.equal(dyR.toString(), snaps.state.probe.sellCoin1.dy, "REAL get_dy(1->0, probe) == the captured mainnet value (real Vyper+MATH code)");

    // The REAL execution path — a read-only eth_call of exchange on the pre-swap state — == get_dy to the
    // WEI (the view IS the swap math; get_dy is the recipe's min_dy source).
    await approve(c.walletClient, c.publicClient, etched.tokenIn, etched.pool, BigInt(snaps.state.probe.sellCoin0.dx));
    const simFwd = (await c.publicClient.simulateContract({
      address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "exchange",
      args: [0n, 1n, BigInt(snaps.state.probe.sellCoin0.dx), 0n], account: c.account0,
    })).result as bigint;
    assert.equal(simFwd, dyF, "REAL exchange(probe) eth_call == REAL get_dy(probe) (the view IS the swap math)");

    // The combined shim resolves the pool + indices + n_coins + decimals the production CryptoSwap discovery
    // reads (UINT256 i,j — 2 words, NOT the StableSwap 3-word variant).
    const [fp, ci, nc, dec] = await Promise.all([
      c.publicClient.readContract({ address: etched.registry, abi: curveCryptoRegistryShimAbi, functionName: "find_pool_for_coins", args: [etched.tokenIn, etched.tokenOut] }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.registry, abi: curveCryptoRegistryShimAbi, functionName: "get_coin_indices", args: [etched.pool, etched.tokenIn, etched.tokenOut] }) as Promise<readonly [bigint, bigint]>,
      c.publicClient.readContract({ address: etched.registry, abi: curveCryptoRegistryShimAbi, functionName: "get_n_coins", args: [etched.pool] }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.registry, abi: curveCryptoRegistryShimAbi, functionName: "get_decimals", args: [etched.pool] }) as Promise<readonly bigint[]>,
    ]);
    assert.equal(fp.toLowerCase(), etched.pool.toLowerCase(), "shim find_pool_for_coins resolves the etched pool");
    assert.equal(ci[0], BigInt(snaps.state.i), "shim get_coin_indices i == captured (uint256)");
    assert.equal(ci[1], BigInt(snaps.state.j), "shim get_coin_indices j == captured (uint256)");
    assert.equal(nc, BigInt(snaps.state.coins.length), "shim get_n_coins == captured (2)");
    assert.equal(dec[0], BigInt(snaps.state.decimals[0]), "shim get_decimals[0] == captured");
    assert.equal(dec[1], BigInt(snaps.state.decimals[1]), "shim get_decimals[1] == captured");

    console.log(
      `  [crypto-prod-mirror] REAL bytecode etched: pool ${etched.pool} (${(poolCode!.length - 2) / 2} B Vyper) ` +
        `-> MATH [${(snaps.bytecode.dependencies ?? []).filter((d) => d.name.startsWith("math")).map((d) => d.address).join(", ")}]; ` +
        `captured block ${snaps.state.block}; A ${etched.A} gamma ${etched.gamma} D ${etched.D}; ` +
        `balances ${etched.balances[0]}/${etched.balances[1]}`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the real pool view. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Swap coin i (crvUSD) → coin j (WETH) — the captured probe direction (tokenIn = coins[i]).
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    const iBig = BigInt(snaps.state.i);
    const jBig = BigInt(snaps.state.j);

    // A meaningful trade: ~1% of the (net) tokenIn balance — well inside the curve, so the whole trade
    // allocates to this single venue (single-venue full-fill, asserted below).
    const amountIn = etched.balances[snaps.state.i] / 100n;
    const poolConfig = cryptoPoolConfig(tokenIn, tokenOut);

    // Exercise the PRODUCTION CryptoSwap discovery path to RESOLVE + orient the pool (find_pool_for_coins →
    // get_coin_indices [UINT256] → the live pool reads). This is the same discoverCryptoSwapPoolsTyped the
    // production prepare() calls, and the SAME typed descriptor the production sampler consumes below.
    const discovered = await discoverCryptoSwapPoolsTyped(tokenIn, tokenOut, c.publicClient, poolConfig.factories);
    assert.equal(discovered.length, 1, "production discovery surfaced exactly the 1 reproduced CryptoSwap venue");
    assert.equal(discovered[0].address.toLowerCase(), etched.pool.toLowerCase(), "the discovered venue is the REAL etched pool");
    assert.equal(discovered[0].i, snaps.state.i, "discovery oriented coin index i (uint256)");
    assert.equal(discovered[0].j, snaps.state.j, "discovery oriented coin index j (uint256)");
    assert.equal(discovered[0].A, etched.A, "discovery read the live A off the real pool");
    assert.equal(discovered[0].D, etched.D, "discovery read the live D off the real pool");

    // PRODUCTION QL LADDER, unmasked: buildCryptoSwapQLLadder replays the discovered descriptor off-chain
    // (no RPC) — the SAME geometric quote ladder the on-chain solver builds in setup from live get_dy. This
    // is what the neutral oracle consumes, so the split is wei-exact vs the solver by construction.
    const ladder = buildCryptoSwapQLLadder(discovered[0], amountIn);
    assert.ok(ladder.length > 0, "production QL ladder is non-empty");
    const ladderSum = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(ladderSum, amountIn, "production QL ladder covers the full amountIn");

    // LADDER PARITY — the core gate this test exists for: at EVERY cumulative QL ladder point the off-chain
    // replay (getDyCrypto on the discovered state) == the REAL etched pool's OWN get_dy view, to the WEI.
    // These are the EXACT points the on-chain qlv loop quotes, so this pins the whole QL quote path (raw-
    // product xp scaling, the fx/boom stableswap get_y, the v2.1.0d dynamic fee on the post-swap xp) against
    // the genuine deployed bytecode: the on-chain-built ladder == the oracle ladder == the solver's, wei-exact.
    let cum = 0n;
    let cumOut = 0n;
    for (const s of ladder) {
      cum += s.capacity;
      cumOut += s.effOut;
      const offChain = getDyCrypto(discovered[0], cum);
      const onChain = (await c.publicClient.readContract({
        address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "get_dy", args: [iBig, jBig, cum],
      })) as bigint;
      assert.equal(offChain, onChain, `QL ladder parity at cum=${cum}: getDyCrypto == REAL get_dy (wei-exact)`);
      assert.equal(cumOut, offChain, `QL ladder partition at cum=${cum}: Σ effOut == getDyCrypto(cum)`);
    }

    // NEUTRAL ORACLE over the SAME QL ladder (buildCryptoSwapQLLadder): the awarded input Σ each venue
    // receives. With ONE venue whose ladder covers [0, amountIn], the merge awards the whole covered Σ to
    // it — the awarded == amountIn by construction (single-venue full-fill, asserted on-chain below).
    const oracle = optimalSplit({ pools: [{ cryptoSwap: discovered[0], feePpm: 0 }], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.equal(awarded, amountIn, "oracle awards the whole trade to the reproduced CryptoSwap QL venue");

    // The REAL pool's OWN pre-swap get_dy view for the KNOWN awarded Σ — the engine-independent ground
    // truth for the executed dy (the ACTUAL swap math the recipe reads for min_dy). Already proven ==
    // the off-chain replay at every ladder point above.
    const onViewPre = (await c.publicClient.readContract({
      address: etched.pool, abi: curveCryptoPoolReadAbi, functionName: "get_dy", args: [iBig, jBig, awarded],
    })) as bigint;
    assert.equal(onViewPre, getDyCrypto(discovered[0], awarded), "REAL get_dy(awarded) == production replay (wei-exact)");

    // Compile the PRODUCTION ecoswap.sauce.ts solver (the same template index.ts compiles) with ZERO
    // prepared segments — only the QL DESCRIPTOR — and cook it: the solver builds the ladder ON-CHAIN from
    // the REAL pool's live get_dy (self-contained in {pool, VIEW, MATH}, all etched — so it runs OFFLINE,
    // the gap Curve's FRAXUSDe prod-mirror could not close), reads real get_dy for min_dy, and runs real
    // exchange. This is the QL prod-mirror COOK gap, closed against genuine mainnet twocrypto-NG bytecode.
    const qlv = [cryptoDescriptor(etched.pool, discovered[0].i, discovered[0].j, discovered[0].feePpm, 0)];
    const { bytecodes } = compileSauce(solverSrc, cryptoArgs(tokenIn, tokenOut, amountIn, caller, qlv), ECOSWAP_DIR, engine);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, etched.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL twocrypto-NG bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, etched.pool)) - poolInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // HONEST fee accounting: CryptoSwap exchange() takes the dynamic fee on the OUTPUT (dy is netted of
    // the fee before payout) and PULLS the full dx into the pool via transferFrom (like Curve/Wombat, NOT
    // the transfer-first Solidly path) — so the pool nets the FULL input.
    assert.equal(poolIn, spent, "REAL CryptoSwap pool netted the FULL input (fee is taken on the output dy, not the input)");

    // WEI-EXACT: the on-chain spend == the awarded Σ to the WEI. NO tolerance. The on-chain-built QL ladder
    // is the IDENTICAL grid the oracle awarded (proven at every point above), so spent == awarded == ladderSum.
    assert.equal(spent, awarded, "on-chain spent == awarded input (wei-exact vs oracle)");
    // Single-venue full-fill: the ~1%-of-reserve sizing keeps the ladder within [0, amountIn], so the whole
    // trade allocates to the one pool. Assert it EXPLICITLY (a regression that under-fills or splits fails
    // here, not silently). ladderSum == amountIn was asserted on the production QL ladder above.
    assert.equal(spent, amountIn, "single-venue full-fill: spent == amountIn (no unspent wei)");

    // The caller-received tokenOut == the REAL pool's OWN pre-swap get_dy view for the awarded Σ, to the
    // WEI — the actual swap math the recipe read for min_dy AND executed. NO tolerance. (get_dy MUST be
    // read on the PRE-swap state — exchange mutates balances, so a post-swap re-read quotes a moved pool.)
    // With spent == awarded this ties the executed output to the real pool's own twocrypto-NG curve.
    assert.equal(received, onViewPre, "received == REAL pool pre-swap get_dy(spent == awarded Σ) (exact-in-dy)");

    // RESIDUE SWEEP (the Metric USDT-class lesson): the exec arm raw-approves the POOL for the awarded Σ
    // and twocrypto-NG's exchange pulls EXACTLY dx via transferFrom (verified vyper source — no
    // partial-fill path). Assert pull == approve on the GENUINE bytecode: a leftover allowance on the
    // shared cooking contract would brick later cooks on nonzero→nonzero-revert tokens (mainnet USDT).
    const residue = (await c.publicClient.readContract({
      address: tokenIn, abi: parseAbi(["function allowance(address, address) view returns (uint256)"]) as Abi,
      functionName: "allowance", args: [target, etched.pool],
    })) as bigint;
    assert.equal(residue, 0n, "no pool allowance residue on the REAL twocrypto-NG bytecode (pull == approve)");

    const ms = Date.now() - t0;
    console.log(
      `  [crypto-prod-mirror:${engine}] WEI-EXACT vs the REAL pool get_dy — spent=${spent} received=${received} ` +
        `(awarded Σ=${awarded}, realGetDy=${onViewPre}); ${ladder.length} on-chain QL slices; ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL twocrypto-NG bytecode [${engine}] — wei-exact vs the real pool get_dy view, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
