/**
 * EcoSwap Balancer V3 (balancer/balancer-v3-monorepo — Vault singleton + per-chain Router) PROD-MIRROR —
 * REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The Balancer V3 analogue of ecoswap.fluid.prodmirror.evm.test.ts / ecoswap.mento.prodmirror.evm.test.ts.
 * Unlike ecoswap.balancerv3.evm.test.ts (which deploys a MOCK BalancerV3.sol fixture), this test stands up
 * the GENUINE ~20-contract Balancer V3 quote/swap graph captured from BASE mainnet and runs the swap against
 * it — proving the production discovery + CALLBACK-FREE execution path works on the real contracts, with NO
 * fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * MECHANISM (the Mento whole-graph etch, generalised in harness/etch-pool.ts):
 *   CAPTURE (one-time, harness/balancerv3-snapshot.ts, uses the RPC key):
 *     the wired FactoryType.BalancerV3 target on Base — 0x7ab1… "Balancer Aave USDC-Aave GHO" (constants.ts
 *     BASE_CHAIN_POOL_CONFIG balancerV3Pools[0]) — is StableSurge-HOOKED (dynamic fee) + rate-scaled (its
 *     swappable tokens are the ERC4626 StaticATokenLM WRAPPERS waGHO/waUSDC whose rate = Aave
 *     getReserveNormalizedIncome). There is NO closed-form curve — the price comes from a ~20-contract graph
 *     (Router → Vault/VaultExtension → Pool → StableSurgeHook + 2 rate providers → 2 ERC4626 wrappers + impl →
 *     Aave Pool + rewards controller + aToken → Permit2). We enumerate the exact touched set via
 *     debug_traceCall(prestateTracer) on the production QUERY AND a REAL successful SWAP (captured on a local
 *     fork), and eth_getCode every traced contract fresh (WITH sha256 anchors) into
 *     fixtures/snapshots/base-balancerv3-waUSDCwaGHO.bytecode.json + the union touched storage into
 *     .state.json. Block pinned (48120913). No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); setCode EVERY captured contract at its captured
 *     address; setStorageAt the captured touched storage VERBATIM by absolute key; fund the caller with tokenIn
 *     via a REAL StaticATokenLM transfer from the impersonated Vault (the swappable tokens ARE the real
 *     wrappers — NOT repointed, since their rate is pricing-relevant); re-seed `_reservesOf[token]` (Vault
 *     mapping base slot 8, PERSISTENT) = balanceOf(vault) for BOTH tokens (the on-unlock invariant settle()
 *     relies on — else BalanceNotSettled); then PIN block.timestamp to the captured ts (the wrapper rate
 *     accrues on it). The swap then runs the GENUINE graph: Router.querySwapSingleTokenExactIn returns the
 *     mainnet-identical dy and Router.swapSingleTokenExactIn PULLS tokenIn via Permit2 into the Vault + pays
 *     tokenOut out via Vault.sendTo — the cooking contract is NEVER re-entered (callback-free).
 *
 * CENTRAL VERIFICATION (this file asserts all three explicitly):
 *   (a) REAL bytecode — eth_getCode at EVERY graph contract in the test == the captured real runtime,
 *       byte-for-byte (a NO-RPC sha256 tripwire proves the checked-in blobs are intact). No mock BalancerV3.sol
 *       is in the swap path (the addresses are the captured mainnet addresses, running captured code). The REAL
 *       Vault.getPoolTokens orients the pair, and the REAL Router.querySwapSingleTokenExactIn reproduces the
 *       captured probe ladder to the WEI, both directions.
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts optimalSplit, seeded
 *       from the REAL etched Router's LIVE querySwapSingleTokenExactIn ladder via the SHARED
 *       buildBalancerV3Segments, the identical grid discoverBalancerV3PoolsTyped samples) == the REAL Router's
 *       OWN LIVE querySwapSingleTokenExactIn view of the awarded slice, all to the wei; and it equals the
 *       CAPTURED mainnet probe for the full trade size — a direct tie to the real chain value. (The querySwap
 *       reads here are OFF-CHAIN cross-checks by the test, NOT an on-chain re-read: the exec passes
 *       minAmountOut=0 — the query is eth_call-only — and the exactIn fill equals the live query because the
 *       block clock is pinned so the state is unchanged between prepare and cook.)
 *
 * HONEST fidelity — SNAPSHOTTED-QUOTE (Class-A, the SAME class the recipe documents for Balancer V3 /
 * Fluid / Mento): the split is priced off the LIVE querySwapSingleTokenExactIn ladder sampled at prepare (a
 * SNAPSHOT of the Vault balances + rate providers + surge-hook state), so it is EXACT-ON-GRID vs the oracle
 * (both segment the SAME sampled ladder off the SAME etched Router at the SAME pinned block); per-pool
 * EXECUTION runs exactIn with minAmountOut=0 (the querySwapSingleTokenExactIn quote is eth_call-ONLY and NOT
 * callable on-chain, so there is no per-leg on-chain minOut), so the realized out equals the live query for
 * the awarded share to the wei. Because block.timestamp is PINNED, the wrapper rate + surge fee
 * do NOT accrue between prepare and cook here, so the snapshot ladder == the live view and the fill is exact-
 * on-grid AND exact-in-dy — the strongest form. Balancer V3 folds its dynamic hook fee + rate scaling into the
 * query (no separate fee getter), and the pool nets the FULL tokenIn into the Vault via Permit2, so poolIn
 * (== the Vault tokenIn delta) == spent is asserted explicitly.
 *
 * SINGLE-VENUE FULL-FILL is the documented expectation for this sizing (amountIn == the full sampled ladder
 * cap, one Balancer V3 venue, the deep ~$358k/$131k pool quotes monotonically over [0, amountIn]) — so the
 * whole trade allocates to this one pool and spent == amountIn.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts are
 * absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.balancerv3.prodmirror.evm.test.ts
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
  approve,
  balanceOf,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  etchBalancerV3Graph,
  loadBalancerV3Snapshots,
  verifyBalancerV3BytecodeIntegrity,
  pinBalancerV3BlockTimestamp,
  balancerV3VaultReadAbi,
  balancerV3RouterReadAbi,
  type EtchedBalancerV3Graph,
} from "./harness/etch-pool";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { EcoBracketKind } from "../shared/types";
import { ecoSwap } from "../ecoswap/index";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import {
  buildBalancerV3Segments,
  balancerV3SampleInputs,
  type BalancerV3Pool,
} from "../shared/balancer-v3-math";

const SNAP_NAME = "base-balancerv3-waUSDCwaGHO";
const ENGINE_CELLS = engineCells();
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

describe("EcoSwap Balancer V3 (Vault + per-chain Router, StableSurge + rate-scaled) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadBalancerV3Snapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedBalancerV3Graph;

  // Boot a fresh anvil + etch the whole real graph + deploy the engine, then PIN the block clock (the wrapper
  // rate accrual). Called before each cell so each engine runs in full isolation (cheap: the whole setup is
  // setCode + setStorageAt + a real transfer + a handful of deploys, seconds not minutes).
  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // Caller funded with EXACTLY the trade size in tokenIn (waUSDC). The caller is funded by a REAL transfer
    // FROM the etched Vault (which holds ~122,742 waUSDC via the captured pristine storage), so callerFund
    // MUST be ≤ the Vault's waUSDC balance — the 100k trade fits (and the Permit2 pull returns it to the Vault
    // during the swap, so the Vault's balance nets back up to pay-out capacity).
    const callerFund = 100_000n * 10n ** BigInt(snaps.state.tokenInDecimals);
    etched = await etchBalancerV3Graph(
      c.walletClient,
      c.publicClient,
      c.testClient as unknown as Parameters<typeof etchBalancerV3Graph>[2],
      anvil.rpcUrl,
      snaps,
      { caller: c.account0, callerFund },
    );
    // PIN block.timestamp to the captured ts — the ERC4626 wrapper rate (Aave getReserveNormalizedIncome)
    // accrues on block.timestamp; pinning reproduces the captured probe rate exactly.
    await pinBalancerV3BlockTimestamp(
      c.testClient as unknown as Parameters<typeof pinBalancerV3BlockTimestamp>[0],
      snaps.state,
    );
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a Balancer V3 factory carrying the reproduced Vault + Router + pool → the
   *  production FactoryType.BalancerV3 discovery path resolves the etched pool via Vault.getPoolTokens +
   *  the Router querySwapSingleTokenExactIn ladder; the lens ignores non-V2/V3/V4 factory types, so no direct
   *  pools are surfaced and the Balancer V3 venue rides entirely through discoverBalancerV3PoolsTyped. The
   *  `address` is the CREATE2 Vault; `poolType` is an inert placeholder (discovery keys off factoryType). */
  function balancerV3PoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.vault, // the CREATE2 Vault singleton (probed via getPoolTokens)
          poolType: SwapPoolType.UniV2, // inert for Balancer V3 — discovery keys off factoryType
          factoryType: FactoryType.BalancerV3,
          label: "Local Balancer V3 (prod-mirror)",
          balancerV3Router: etched.router,
          balancerV3Pools: [etched.pool],
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // The Router's own on-chain querySwapSingleTokenExactIn view — the engine-independent ground truth for the
  // executed dy. sender = ZERO, userData = "0x" (a pure quote; the query unlock()s the Vault in QUERY mode).
  async function onQuery(amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: etched.router,
      abi: balancerV3RouterReadAbi,
      functionName: "querySwapSingleTokenExactIn",
      args: [etched.pool, etched.tokenIn, etched.tokenOut, amt, ZERO, "0x"],
    })) as bigint;
  }

  /** The neutral oracle's BalancerV3Pool descriptor — sample the REAL etched Router's LIVE
   *  querySwapSingleTokenExactIn ladder over [0, amountIn] on the SAME grid discoverBalancerV3PoolsTyped uses
   *  (balancerV3SampleInputs). Since the oracle and prepare sample the IDENTICAL grid off the IDENTICAL etched
   *  Router at the SAME pinned block, they produce identical segments ⇒ the split is exact-on-grid vs the
   *  oracle by construction. */
  async function offPool(amountIn: bigint): Promise<BalancerV3Pool> {
    const cumIn = balancerV3SampleInputs(amountIn);
    const cumOut: bigint[] = [];
    for (const amt of cumIn) cumOut.push(await onQuery(amt));
    return {
      address: etched.pool,
      router: etched.router,
      tokenIn: etched.tokenIn,
      tokenOut: etched.tokenOut,
      cumIn,
      cumOut,
      feePpm: 0,
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL Balancer V3 graph bytecode (byte-equal) + reproduces the captured quotes", async () => {
    // NO-NETWORK integrity tripwire FIRST: every checked-in runtime blob still hashes to the sha256 anchor
    // recorded at capture time (byte-equal to the pinned-block on-chain code). A reviewer without the RPC key
    // can run this — it proves the snapshot wasn't silently altered after capture, with NO RPC.
    const integ = verifyBalancerV3BytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, `all ${integ.contracts.length} graph runtimes hash to their capture anchors`);
    for (const cc of integ.contracts) {
      assert.ok(cc.expected, `contract ${cc.address} (${cc.role}) carries a sha256 anchor`);
      assert.ok(cc.ok, `contract ${cc.address} (${cc.role}) runtime sha256 matches (got ${cc.actual})`);
    }
    assert.ok(snaps.bytecode.contracts.length >= 15, "the whole ~20-contract graph is captured");

    // getCode at EVERY graph contract must EQUAL the captured real runtime (no mock in the path).
    for (const cc of snaps.bytecode.contracts) {
      const code = await c.publicClient.getCode({ address: cc.address });
      assert.ok(code, `contract ${cc.address} (${cc.role}) has code`);
      assert.equal(
        code!.toLowerCase(),
        cc.runtime.toLowerCase(),
        `eth_getCode at ${cc.role} (${cc.address}) == the captured REAL runtime (byte-equal)`,
      );
    }
    // The three central members are at their captured mainnet addresses (the Vault is a CREATE2 singleton).
    assert.equal(etched.vault.toLowerCase(), snaps.bytecode.vault.toLowerCase(), "Vault at captured mainnet address");
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.toLowerCase(), "pool at captured mainnet address");
    assert.equal(etched.router.toLowerCase(), snaps.bytecode.router.toLowerCase(), "Router at captured mainnet address");

    // The REAL Vault getters orient the pair + confirm registration (the production discovery surface).
    const registered = (await c.publicClient.readContract({
      address: etched.vault, abi: balancerV3VaultReadAbi, functionName: "isPoolRegistered", args: [etched.pool],
    })) as boolean;
    assert.ok(registered, "REAL Vault.isPoolRegistered(pool) == true");
    const tokens = (await c.publicClient.readContract({
      address: etched.vault, abi: balancerV3VaultReadAbi, functionName: "getPoolTokens", args: [etched.pool],
    })) as readonly Hex[];
    const set = new Set(tokens.map((t) => t.toLowerCase()));
    assert.ok(set.has(etched.tokenIn.toLowerCase()) && set.has(etched.tokenOut.toLowerCase()),
      "REAL Vault.getPoolTokens returns the swappable waGHO/waUSDC pair");
    // The Router's Permit2 is the canonical singleton (the solver hardcodes it).
    const p2 = (await c.publicClient.readContract({
      address: etched.router, abi: balancerV3RouterReadAbi, functionName: "getPermit2",
    })) as Hex;
    assert.equal(p2.toLowerCase(), etched.permit2.toLowerCase(), "REAL Router.getPermit2() == canonical Permit2");

    // The REAL Router.querySwapSingleTokenExactIn reproduces the captured probe ladder to the WEI, BOTH
    // directions (the whole ~20-contract rate/hook/StableMath fan-out against the reconstructed state).
    for (const p of snaps.state.probe.inToOut) {
      const got = (await c.publicClient.readContract({
        address: etched.router, abi: balancerV3RouterReadAbi, functionName: "querySwapSingleTokenExactIn",
        args: [etched.pool, etched.tokenIn, etched.tokenOut, BigInt(p.amountIn), ZERO, "0x"],
      })) as bigint;
      assert.equal(got, BigInt(p.amountOut), `REAL querySwap(in->out, ${p.amountIn}) == captured mainnet value`);
    }
    for (const p of snaps.state.probe.outToIn) {
      const got = (await c.publicClient.readContract({
        address: etched.router, abi: balancerV3RouterReadAbi, functionName: "querySwapSingleTokenExactIn",
        args: [etched.pool, etched.tokenOut, etched.tokenIn, BigInt(p.amountIn), ZERO, "0x"],
      })) as bigint;
      assert.equal(got, BigInt(p.amountOut), `REAL querySwap(out->in, ${p.amountIn}) == captured mainnet value`);
    }

    console.log(
      `  [bv3-prod-mirror] REAL bytecode etched: ${etched.contractCount} contracts ` +
        `(${etched.slotCount} storage slots); Vault ${etched.vault}; pool ${etched.pool}; ` +
        `captured block ${snaps.state.block}; ${snaps.state.tokenInSymbol}(${snaps.state.tokenInDecimals}) -> ` +
        `${snaps.state.tokenOutSymbol}(${snaps.state.tokenOutDecimals})`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Swap tokenIn → tokenOut (waUSDC → waGHO, the captured probe direction).
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;

    // amountIn == the full sampled ladder cap (100k waUSDC) — well within the deep ~$358k/$131k pool, so the
    // ladder quotes monotonically and the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * 10n ** BigInt(snaps.state.tokenInDecimals);
    const poolConfig = balancerV3PoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    // Run EcoSwap through the PRODUCTION FactoryType.BalancerV3 discovery path (samples the etched Router).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      target,
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced Balancer V3 venue (via the real Vault + Router getters).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (Balancer-V3-only config)");
    assert.equal((prepared.balancerV3Pools ?? []).length, 1, "discovered exactly the 1 reproduced Balancer V3 venue");
    assert.equal(
      prepared.balancerV3Pools![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered Balancer V3 venue is the REAL etched pool",
    );
    assert.equal(prepared.balancerV3Pools![0].router.toLowerCase(), etched.router.toLowerCase(), "venue carries the etched Router");
    assert.ok(
      (prepared.brackets ?? []).some((b) => b.kind === EcoBracketKind.BalancerV3),
      "Balancer V3 segments present",
    );

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one Balancer V3 venue seeded from the REAL etched Router's LIVE
    // querySwapSingleTokenExactIn ladder via the SHARED buildBalancerV3Segments (the identical grid
    // discoverBalancerV3PoolsTyped sampled). Pure off-chain math (computed BEFORE the cook), so the awarded Σ
    // is known ahead — and the engine's static-segment cursor consumes the IDENTICAL grid ⇒ spent == oracle.
    const op = await offPool(amountIn);
    assert.ok(buildBalancerV3Segments(op, amountIn).length > 0, "non-empty Balancer V3 segment ladder from the live etched Router");
    const optPools: OptimalPool[] = [{ balancerV3: op, feePpm: 0 }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced Balancer V3 venue");

    // The REAL Router's OWN LIVE querySwapSingleTokenExactIn view for the KNOWN awarded Σ — the engine-
    // independent ground truth for the executed dy (an OFF-CHAIN cross-check; the exec itself passes
    // minAmountOut=0 — this query is eth_call-only — and the exactIn fill equals this view because the state
    // is unchanged). The block clock is PINNED, so the wrapper rate + surge fee do NOT accrue between this read
    // and the cook.
    const onViewAwarded = await onQuery(awarded);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    // Balancer V3 PULLS tokenIn via Permit2 into the Vault (NOT the pool) — measure the Vault tokenIn delta.
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, etched.vault);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL Balancer V3 bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const vaultIn = (await balanceOf(c.publicClient, tokenIn, etched.vault)) - vaultInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // HONEST fee accounting: Balancer V3 folds its dynamic hook fee + rate scaling into the query (no separate
    // fee getter) and the pool nets the FULL tokenIn into the Vault — the fee shows up as a smaller tokenOut,
    // not a smaller input. Assert the Vault received exactly what was spent (Permit2 pull).
    assert.equal(vaultIn, spent, "REAL Balancer V3 Vault netted the FULL input (fee is folded into the output quote)");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI. NO tolerance. (The ladder is
    // sampled to cover [0, amountIn]; the deep monotonic reserves ⇒ the merge awards the whole Σ, and the
    // engine's static-segment cursor consumes the IDENTICAL grid ⇒ spent == oracle.totalInput.)
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact-on-grid)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact-on-grid)");
    // SINGLE-VENUE FULL-FILL (documented for this sizing): the whole trade allocates to this one pool.
    assert.equal(spent, amountIn, "single-venue full-fill: spent == amountIn (no unspent wei, no split)");

    // The caller-received tokenOut == the REAL Router's OWN LIVE querySwapSingleTokenExactIn(spent) view, to
    // the WEI. Because the block clock is PINNED (no accrual), the snapshot ladder the split priced == the live
    // view at exec, so this is BOTH exact-on-grid AND exact-in-dy (the strongest cross-check).
    assert.equal(received, onViewAwarded, "received == REAL Router LIVE querySwap(awarded Σ) (exact-in-dy)");
    // And it equals the CAPTURED mainnet probe for this exact size — a direct tie to the real chain value.
    const probe100k = snaps.state.probe.inToOut.find((p) => BigInt(p.amountIn) === amountIn);
    assert.ok(probe100k, "captured probe includes the 100k waUSDC size");
    assert.equal(received, BigInt(probe100k!.amountOut), "received == the CAPTURED mainnet querySwap(100k waUSDC) value to the wei");

    const ms = Date.now() - t0;
    console.log(
      `  [bv3-prod-mirror:${engine}] WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, liveView=${onViewAwarded}, capturedProbe=${probe100k!.amountOut}, amountIn=${amountIn}); ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Balancer V3 bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
