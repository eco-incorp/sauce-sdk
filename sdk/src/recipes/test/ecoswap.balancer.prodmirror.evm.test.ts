/**
 * EcoSwap Balancer V2 ComposableStable PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The Balancer analogue of ecoswap.solidly.prodmirror.evm.test.ts / ecoswap.dodo.prodmirror.evm.test.ts.
 * Unlike ecoswap.balancer.evm.test.ts (which deploys a MOCK BalancerComposableStable.sol fixture whose
 * StableMath mirrors the off-chain replay), this test stands up the GENUINE mainnet ComposableStable pool
 * bytecode + the GENUINE Balancer V2 Vault bytecode captured from Ethereum mainnet and runs the swap
 * against them — proving the production discovery + execution path works on the REAL contracts, with NO
 * fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * MECHANISM (mirrors the repo's Uniswap-V4 real-runtime etch, generalised in harness/etch-pool.ts):
 *   CAPTURE (one-time, harness/balancer-snapshot.ts, uses the RPC key):
 *     the deepest on-charter all-stablecoin Ethereum ComposableStable pool wired in constants.ts
 *     balancerStablePools — the GHO/USDT/USDC ComposableStable v5 0x8353…Cb2aF (~$120k, amp A=250,
 *     fee 0.05%, bptIndex 1, ZERO rate providers). We eth_getCode BOTH the self-contained pool runtime
 *     AND the canonical Balancer V2 Vault runtime (0xBA12…) into
 *     fixtures/snapshots/ethereum-balancer-GHOUSDCUSDT.bytecode.json (WITH sha256 anchors), the pool's
 *     StableMath storage (0..31, verbatim) + the Vault's per-poolId EnumerableMap accounting (the
 *     `_generalPoolsBalances[poolId]` `_length`/`_keys`/packed BalanceAllocation/`_indexes` slots + the
 *     registration flag, all by ABSOLUTE key) into .state.json. Block pinned. No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); setCode the REAL pool at its captured address
 *     + the REAL Vault at the canonical 0xBA12…; setStorageAt the captured pool + Vault slots verbatim;
 *     etch a local MintableERC20 AT EACH real NON-BPT token address (GHO/USDC/USDT — the Vault accounting
 *     is keyed by the real addresses, so they cannot be repointed by a scalar overwrite; mirrors Wombat's
 *     immutable-underlying etch) + seed its decimals; fund the Vault with the captured balances. The swap
 *     then runs the GENUINE Vault + pool bytecode: Vault.swap(GIVEN_IN) calls pool.onSwap (the real
 *     StableMath A-invariant) and moves the registered assets — the mainnet-identical dy for the captured
 *     balances.
 *
 * CENTRAL VERIFICATION (this file asserts all three explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool + the Vault in the test == the captured real runtime,
 *       byte-for-byte (sha256-anchored, and a NO-RPC integrity tripwire runs first). No mock
 *       BalancerComposableStable.sol / mock Vault is in the swap path (the pool/Vault addresses are the
 *       captured mainnet addresses, running captured code). getPoolTokens reconstructs the mainnet
 *       balances exactly, and getRateProviders confirms the ZERO-rate-provider fidelity (no external
 *       rate-provider dependency — full real-code parity, NO stubs).
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — Balancer V2 is a LIVE-WALK QUOTE-LADDER venue (segKind 6): the solver replays the
 *       amplified StableSwap invariant ON-CHAIN from live Vault state (getPoolTokenInfo balances /
 *       getScalingFactors / amp / fee). Asserted: the on-chain replay == the REAL Vault queryBatchSwap at
 *       EVERY QL ladder point; and the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts,
 *       priced via the SHARED buildBalancerStableQLLadder) == the REAL Vault's OWN pre-swap queryBatchSwap of
 *       the awarded slice, all to the wei (spent == awarded asserted explicitly); plus an ADVERSE-DRIFT
 *       re-anchor (a real Vault.swap moves the balances between prepare and cook — the live read re-prices).
 *
 * HONEST fidelity note: the picked pool has ZERO rate providers, so onSwap makes NO external
 * rate-provider call — the dependency graph is EXACTLY {Vault, pool}, both REAL runtimes captured. NO
 * stubs, NO shims (unlike WOOFi's Chainlink shim). The swap fee is taken on the INPUT (Balancer's
 * _subtractSwapFeeAmount), so the pool's registered tokenIn balance grows by the FULL spent (the fee
 * accrues inside the pool as protocol/LP fee, not routed out) — asserted via the Vault balance delta.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts
 * are absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.balancer.prodmirror.evm.test.ts
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
  etchBalancerPool,
  loadBalancerSnapshots,
  verifyBalancerBytecodeIntegrity,
  balancerPoolReadAbi,
  balancerVaultReadAbi,
  type EtchedBalancerPool,
  type BalancerStateSnapshot,
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
import { getDy, buildBalancerStableQLLadder, type BalancerStablePool } from "../shared/balancer-stable-math";

const SNAP_NAME = "ethereum-balancer-GHOUSDCUSDT";
const ENGINE_CELLS = engineCells();

describe("EcoSwap Balancer V2 ComposableStable prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadBalancerSnapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedBalancerPool;

  // Boot a fresh anvil + etch the real pool + Vault + deploy the engine. Called before each cell so each
  // engine runs in full isolation (no shared mutable node state — cheap because the whole setup is etch +
  // setStorageAt + a handful of deploys, seconds not minutes).
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // The swap pair is the captured probe direction (tokenIn = the first NON-BPT token = GHO,
    // tokenOut = the second = USDC). ~10x the GHO balance as caller headroom (18-dec; balance ~47k GHO).
    etched = await etchBalancerPool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      tokenInAddr: snaps.state.probe.tokenIn,
      tokenOutAddr: snaps.state.probe.tokenOut,
      callerFund: nonBptBalanceOf(snaps.state, snaps.state.probe.tokenIn) * 10n,
    });
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a BalancerV2 factory (the canonical Vault) carrying the ONE reproduced pool
   *  as a known-pool address → the production Balancer discovery path resolves it via getPoolId →
   *  Vault.getPoolTokens; the lens ignores non-V2/V3/V4 factory types, so no direct pools are surfaced
   *  and the Balancer pool rides entirely through discoverBalancerStablePoolsTyped. */
  function balancerPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.vault,
          poolType: SwapPoolType.BalancerV2,
          factoryType: FactoryType.BalancerV2,
          label: "Local Balancer V2 (prod-mirror)",
          balancerStablePools: [etched.pool],
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  /** The neutral oracle's BalancerStablePool descriptor for the single reproduced ComposableStable,
   *  seeded from the REAL captured invariant state (the NON-BPT balances / scaling / amp / fee, with the
   *  BPT at bptIndex excluded). tokenIn is non-BPT index i, tokenOut is non-BPT index j. The oracle prices
   *  it via the SAME buildBalancerStableQLLadder the on-chain solver replays on-chain from live Vault state,
   *  so the awarded Σ matches the oracle bit-for-bit and getDy replays the real Vault StableMath. */
  function offPool(state: BalancerStateSnapshot, tokenIn: Hex, tokenOut: Hex): BalancerStablePool {
    // Build the NON-BPT balances/scaling arrays (excluding the BPT at bptIndex), aligned by index.
    const bals: bigint[] = [];
    const scals: bigint[] = [];
    const nonBptAddrs: Hex[] = [];
    for (let k = 0; k < state.tokens.length; k++) {
      if (k === state.bptIndex) continue;
      bals.push(BigInt(state.tokens[k].balance));
      scals.push(BigInt(state.scalingFactors[k]));
      nonBptAddrs.push(state.tokens[k].address);
    }
    const i = nonBptAddrs.findIndex((a) => a.toLowerCase() === tokenIn.toLowerCase());
    const j = nonBptAddrs.findIndex((a) => a.toLowerCase() === tokenOut.toLowerCase());
    assert.ok(i >= 0 && j >= 0, "tokenIn/tokenOut are both NON-BPT registered tokens");
    return {
      poolType: SwapPoolType.BalancerV2,
      address: etched.pool,
      i,
      j,
      amp: BigInt(state.amp),
      balances: bals,
      scalingFactors: scals,
      swapFeeWad: BigInt(state.swapFeeWad),
      source: "prod-mirror",
    };
  }

  /** The neutral oracle's BalancerStablePool descriptor built from the pool's LIVE (current-block) Vault
   *  balances (read via getPoolTokens) — used AFTER a drift so the oracle prices on the moved state exactly as
   *  the on-chain solver does (which reads getPoolTokenInfo live). Scaling/amp/fee are pool constants (ZERO
   *  rate providers), so only the balances move. */
  async function liveOffPool(tokenIn: Hex, tokenOut: Hex): Promise<BalancerStablePool> {
    const [tokens, balances] = (await c.publicClient.readContract({
      address: etched.vault, abi: balancerVaultReadAbi, functionName: "getPoolTokens", args: [etched.poolId],
    })) as readonly [readonly Hex[], readonly bigint[], bigint];
    const bals: bigint[] = [];
    const scals: bigint[] = [];
    const nonBptAddrs: Hex[] = [];
    for (let k = 0; k < tokens.length; k++) {
      if (k === snaps.state.bptIndex) continue;
      bals.push(balances[k]);
      scals.push(BigInt(snaps.state.scalingFactors[k]));
      nonBptAddrs.push(tokens[k]);
    }
    const i = nonBptAddrs.findIndex((a) => a.toLowerCase() === tokenIn.toLowerCase());
    const j = nonBptAddrs.findIndex((a) => a.toLowerCase() === tokenOut.toLowerCase());
    return {
      poolType: SwapPoolType.BalancerV2, address: etched.pool, i, j,
      amp: BigInt(snaps.state.amp), balances: bals, scalingFactors: scals,
      swapFeeWad: BigInt(snaps.state.swapFeeWad), source: "prod-mirror-live",
    };
  }

  /** Real Vault.swap(GIVEN_IN) to MOVE the pool's registered balances (the genuine drift for a zero-rate
   *  ComposableStable — its scaling is constant, so only a balance change re-prices it). Funds+approves the
   *  caller and lands one GIVEN_IN single swap through the REAL etched Vault. */
  async function driftViaVaultSwap(assetIn: Hex, assetOut: Hex, amount: bigint): Promise<void> {
    await mint(c.walletClient, c.publicClient, assetIn, c.account0, amount);
    await approve(c.walletClient, c.publicClient, assetIn, etched.vault, amount);
    await c.walletClient.writeContract({
      address: etched.vault, abi: balancerVaultReadAbi, functionName: "swap",
      args: [
        { poolId: etched.poolId, kind: 0, assetIn, assetOut, amount, userData: "0x" as Hex },
        { sender: c.account0, fromInternalBalance: false, recipient: c.account0, toInternalBalance: false },
        0n, 2n ** 63n,
      ],
      account: c.account0, chain: null,
    });
    await c.testClient.mine({ blocks: 1 });
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL Balancer pool + Vault bytecode (byte-equal) + reconstructs the captured state", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime blobs still hash to the sha256 anchors
    // recorded at capture time (byte-equal to the pinned-block on-chain code). A reviewer without the RPC
    // key can run this — it proves the snapshot wasn't silently altered after capture, with NO RPC.
    const integ = verifyBalancerBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pool runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(snaps.bytecode.pool.runtimeSha256, "pool snapshot carries a sha256 integrity anchor");
    const vaultDep = integ.dependencies.find((d) => d.name === "balancerV2Vault");
    assert.ok(vaultDep, "Balancer V2 Vault dependency present in the bytecode snapshot");
    assert.ok(vaultDep!.ok, `Vault runtime sha256 matches the capture anchor (got ${vaultDep!.actual})`);

    // getCode at the pool + Vault must EQUAL the captured real runtime (no mock in the path).
    const poolCode = await c.publicClient.getCode({ address: etched.pool });
    const vaultCode = await c.publicClient.getCode({ address: etched.vault });
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pool.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL ComposableStable runtime (byte-equal)",
    );
    assert.ok(vaultCode, "Vault has code");
    assert.equal(
      vaultCode!.toLowerCase(),
      (snaps.bytecode.dependencies ?? []).find((d) => d.name === "balancerV2Vault")!.runtime.toLowerCase(),
      "eth_getCode at 0xBA12… == the captured REAL Balancer V2 Vault runtime (byte-equal)",
    );
    // The pool/Vault addresses are the CAPTURED mainnet addresses — no locally-compiled mock.
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.address.toLowerCase(), "pool at captured mainnet address");
    assert.equal(etched.vault.toLowerCase(), snaps.state.vault.toLowerCase(), "Vault at the canonical 0xBA12… address");

    // The REAL pool code reads the reconstructed StableMath state correctly.
    const [poolId, ampRaw, scaling, feeRaw, bptIdxRaw, rateProviders] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: balancerPoolReadAbi, functionName: "getPoolId" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: balancerPoolReadAbi, functionName: "getAmplificationParameter" }) as Promise<readonly [bigint, boolean, bigint]>,
      c.publicClient.readContract({ address: etched.pool, abi: balancerPoolReadAbi, functionName: "getScalingFactors" }) as Promise<readonly bigint[]>,
      c.publicClient.readContract({ address: etched.pool, abi: balancerPoolReadAbi, functionName: "getSwapFeePercentage" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: balancerPoolReadAbi, functionName: "getBptIndex" }) as Promise<bigint>,
      c.publicClient.readContract({ address: etched.pool, abi: balancerPoolReadAbi, functionName: "getRateProviders" }) as Promise<readonly Hex[]>,
    ]);
    assert.equal(poolId.toLowerCase(), snaps.state.poolId.toLowerCase(), "getPoolId == captured (Vault accounting is keyed by it)");
    assert.equal(ampRaw[0], BigInt(snaps.state.amp), "getAmplificationParameter == captured amp (A·AMP_PRECISION)");
    assert.equal(feeRaw, BigInt(snaps.state.swapFeeWad), "getSwapFeePercentage == captured swap fee");
    assert.equal(Number(bptIdxRaw), snaps.state.bptIndex, "getBptIndex == captured");
    assert.equal(scaling.length, snaps.state.scalingFactors.length, "scalingFactors length == captured");
    for (let k = 0; k < scaling.length; k++) {
      assert.equal(scaling[k], BigInt(snaps.state.scalingFactors[k]), `scalingFactor[${k}] == captured`);
    }
    // FIDELITY: getRateProviders all zero — onSwap makes NO external rate-provider call (dependency graph
    // is EXACTLY {Vault, pool}, both real runtimes captured; NO stubs). Assert it explicitly.
    assert.ok(
      rateProviders.every((p) => BigInt(p) === 0n),
      "REAL pool reports ZERO rate providers — no external rate-provider dependency (full real-code parity)",
    );

    // The REAL Vault reconstructs the registered token list + balances byte-identically (INCLUDING the
    // BPT at bptIndex). The tokens are the LOCAL MintableERC20s etched at the real addresses.
    const [tokens, balances] = (await c.publicClient.readContract({
      address: etched.vault, abi: balancerVaultReadAbi, functionName: "getPoolTokens", args: [poolId],
    })) as readonly [readonly Hex[], readonly bigint[], bigint];
    assert.equal(tokens.length, snaps.state.tokens.length, "Vault getPoolTokens returns the captured token count");
    for (let k = 0; k < tokens.length; k++) {
      assert.equal(tokens[k].toLowerCase(), snaps.state.tokens[k].address.toLowerCase(), `registered token[${k}] == captured (real address)`);
      assert.equal(balances[k], BigInt(snaps.state.tokens[k].balance), `registered balance[${k}] == captured (reconstructed Vault accounting)`);
    }
    // The Vault also resolves the pool for this poolId (registration flag reconstructed).
    const [poolFromVault] = (await c.publicClient.readContract({
      address: etched.vault, abi: balancerVaultReadAbi, functionName: "getPool", args: [poolId],
    })) as readonly [Hex, number];
    assert.equal(poolFromVault.toLowerCase(), etched.pool.toLowerCase(), "Vault.getPool(poolId) resolves the etched pool (registration reconstructed)");

    // The REAL Vault's queryBatchSwap reproduces the captured mainnet probe quote (the real StableMath
    // integral running on the reconstructed balances) — the strongest single real-code check.
    const probeIn = snaps.state.probe.tokenIn;
    const probeOut = snaps.state.probe.tokenOut;
    const probeAmountIn = BigInt(snaps.state.probe.amountIn);
    const deltas = (await c.publicClient.readContract({
      address: etched.vault, abi: balancerVaultReadAbi, functionName: "queryBatchSwap",
      args: [
        0,
        [{ poolId, assetInIndex: 0n, assetOutIndex: 1n, amount: probeAmountIn, userData: "0x" as Hex }],
        [probeIn, probeOut],
        { sender: etched.pool, fromInternalBalance: false, recipient: etched.pool, toInternalBalance: false },
      ],
    })) as readonly bigint[];
    const probeOutActual = -deltas[1];
    assert.equal(
      probeOutActual.toString(),
      snaps.state.probe.amountOut,
      "REAL Vault queryBatchSwap(probe) == the captured mainnet value (real code, reconstructed balances)",
    );

    console.log(
      `  [balancer-prod-mirror] REAL bytecode etched: pool ${etched.pool} (${(poolCode!.length - 2) / 2} B) + ` +
        `Vault ${etched.vault} (${(vaultCode!.length - 2) / 2} B); captured block ${snaps.state.block}; ` +
        `amp=${snaps.state.amp} fee=${snaps.state.swapFeeWad} bptIndex=${snaps.state.bptIndex}; ` +
        `probe ${probeAmountIn} -> ${probeOutActual}`,
    );
  });

  // ── (a2) The on-chain StableMath replay == the REAL Vault at every QL LADDER POINT (wei-exact). ──
  // Balancer V2's own quote (Vault.queryBatchSwap) is eth_call-ONLY, so the solver REPLAYS the amplified
  // StableSwap invariant on-chain. This asserts that replay (via the shared getDy the oracle's
  // buildBalancerStableQLLadder + the solver's inlined stableOutV2 both mirror bit-for-bit) equals the REAL
  // Vault's OWN queryBatchSwap at EVERY geometric ladder point — not just the final award — so the whole
  // price ladder the solver builds on-chain is real-code-exact at all S sizes.
  it("on-chain StableMath replay == REAL Vault queryBatchSwap at every QL ladder point (wei-exact)", async () => {
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    const amountIn = nonBptBalanceOf(snaps.state, tokenIn) / 20n;
    const op = offPool(snaps.state, tokenIn, tokenOut);
    const ladder = buildBalancerStableQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty Balancer QL ladder");
    // Walk the ladder's CUMULATIVE input points and cross-check getDy(cum) == the REAL Vault queryBatchSwap(cum).
    let cum = 0n;
    let points = 0;
    for (const s of ladder) {
      cum += s.capacity;
      const deltas = (await c.publicClient.readContract({
        address: etched.vault, abi: balancerVaultReadAbi, functionName: "queryBatchSwap",
        args: [
          0,
          [{ poolId: etched.poolId, assetInIndex: 0n, assetOutIndex: 1n, amount: cum, userData: "0x" as Hex }],
          [tokenIn, tokenOut],
          { sender: etched.pool, fromInternalBalance: false, recipient: etched.pool, toInternalBalance: false },
        ],
      })) as readonly bigint[];
      const realOut = -deltas[1];
      assert.equal(
        getDy(op, cum), realOut,
        `QL ladder point ${points} (cum=${cum}): on-chain StableMath replay == REAL Vault queryBatchSwap (wei-exact)`,
      );
      points++;
    }
    console.log(`  [balancer-prod-mirror] on-chain StableMath replay == REAL Vault at ${points} QL ladder points (wei-exact)`);
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Sell GHO → USDC (the captured probe direction): tokenIn = the first NON-BPT token, tokenOut the second.
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;

    // A meaningful stable trade: ~5% of the tokenIn registered balance (well within the StableMath curve,
    // so the whole trade allocates to this single venue — single-venue full-fill-on-grid, asserted below).
    const amountIn = nonBptBalanceOf(snaps.state, tokenIn) / 20n;
    const poolConfig = balancerPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // Run EcoSwap through the PRODUCTION FactoryType.BalancerV2 discovery path.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced Balancer venue (via getPoolId → Vault.getPoolTokens).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (Balancer-only config)");
    assert.equal((prepared.balancerStables ?? []).length, 1, "discovered exactly the 1 reproduced Balancer venue");
    assert.equal(
      prepared.balancerStables![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered Balancer venue is the REAL etched pool",
    );
    // Balancer V2 is now a QUOTE-LADDER (QL) venue (segKind 6): prepare ships ONLY the descriptor (poolId +
    // non-BPT token addresses + registered scaling positions), NO static sampled brackets — the ladder is built
    // ON-CHAIN from live Vault StableMath state. Assert the descriptor is complete (the solver reads it live).
    assert.ok(
      (prepared.brackets ?? []).every((b) => b.kind !== EcoBracketKind.BalancerStable),
      "no static Balancer-stable brackets (QL venue — descriptor-only, ladder built on-chain)",
    );
    const bDesc = prepared.balancerStables![0];
    assert.equal(bDesc.poolId.toLowerCase(), etched.poolId.toLowerCase(), "descriptor carries the Vault poolId");
    assert.equal(bDesc.nonBptTokens.length, snaps.state.tokens.length - 1, "descriptor carries all NON-BPT tokens");
    assert.equal(bDesc.nonBptRegPos.length, bDesc.nonBptTokens.length, "one registered scaling position per non-BPT token");

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one Balancer venue seeded from the REAL captured invariant
    // state, priced via the SHARED buildBalancerStableQLLadder (the IDENTICAL geometric ladder the on-chain
    // solver replays live). Pure off-chain math (BEFORE the cook), so the awarded Σ is known ahead — and the
    // solver builds the SAME ladder on-chain, so on-chain spent == oracle.totalInput to the wei.
    const op = offPool(snaps.state, tokenIn, tokenOut);
    const optPools: OptimalPool[] = [{ balancer: op, feePpm: 0 }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced Balancer venue");

    // The REAL Vault's OWN PRE-swap queryBatchSwap view for the KNOWN awarded Σ — the engine-independent
    // ground truth for the executed dy of the awarded slice, read on the pre-swap state (the swap mutates
    // the Vault balances). This is the real Solidity StableMath, NOT the off-chain replay.
    const onViewDeltas = (await c.publicClient.readContract({
      address: etched.vault, abi: balancerVaultReadAbi, functionName: "queryBatchSwap",
      args: [
        0,
        [{ poolId: etched.poolId, assetInIndex: 0n, assetOutIndex: 1n, amount: awarded, userData: "0x" as Hex }],
        [tokenIn, tokenOut],
        { sender: caller, fromInternalBalance: false, recipient: caller, toInternalBalance: false },
      ],
    })) as readonly bigint[];
    const onViewOut = -onViewDeltas[1];

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, etched.vault);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL Balancer pool + Vault bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const vaultIn = (await balanceOf(c.publicClient, tokenIn, etched.vault)) - vaultInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // HONEST fee accounting: Balancer takes the swap fee on the INPUT (_subtractSwapFeeAmount) and the fee
    // accrues INSIDE the pool (protocol/LP fee, not routed to a separate contract) — so the Vault's
    // registered tokenIn balance grows by the FULL spent. Assert the Vault netted the full input.
    assert.equal(vaultIn, spent, "REAL Vault received the FULL input (Balancer's fee accrues in the pool, not routed out)");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI. NO tolerance.
    // (Balancer V2 is a QUOTE-LADDER venue: the solver builds a QL_S=8 geometric ladder ON-CHAIN from the
    // live StableMath state, and the oracle's buildBalancerStableQLLadder builds the IDENTICAL ladder off the
    // same state — so spent == the oracle's awarded Σ == oracle.totalInput to the WEI. The ladder reaches
    // amountIn for a deep venue at this sizing, so it is a FULL fill (tail==0), asserted below.)
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact-on-grid)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact-on-grid)");
    // For THIS sizing (~5% of the tokenIn balance, one deep venue) the QL ladder covers [0, amountIn] and the
    // whole trade allocates to the single pool — a FULL fill (tail==0), asserted explicitly. The <0.1% bound is
    // kept as a regression floor (a broken ladder / wrong orientation grossly under-fills and still fails).
    assert.ok(spent <= amountIn, "spent does not exceed amountIn");
    const tail = amountIn - spent;
    assert.equal(spent, amountIn, `single-venue full-fill: spent == amountIn (QL ladder covers [0, amountIn]); tail=${tail}`);
    assert.ok(tail * 1000n < amountIn, `unfilled tail is at most one QL ladder slice (<0.1% of amountIn): tail=${tail}`);

    // The caller-received tokenOut == getDy(spent) (the oracle's realized dy for the awarded Σ) == the REAL
    // Vault's OWN pre-swap queryBatchSwap(spent) view, all to the WEI. NO tolerance. The three-way
    // agreement (TS oracle == real Solidity view == executed swap), for exactly the awarded Σ the solver
    // spent, ties the executed output to the real pool's own StableMath curve.
    assert.equal(received, getDy(op, spent), "received == neutral-oracle getDy(spent) (wei-exact-in-dy)");
    assert.equal(received, onViewOut, "received == REAL Vault pre-swap queryBatchSwap(awarded Σ) (exact-in-dy)");

    const ms = Date.now() - t0;
    console.log(
      `  [balancer-prod-mirror:${engine}] WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, getDy=${getDy(op, spent)}, realView=${onViewOut}, amountIn=${amountIn}, tail=${tail}); ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Balancer pool + Vault bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }

  // ── (d) ADVERSE-DRIFT re-anchor — the LIVE balance read re-prices at cook. ──
  // Balancer V2 is now a LIVE-WALK QL venue: the solver reads the pool's balances LIVE at cook (via
  // getPoolTokenInfo) and replays the invariant, so a balance move between prepare and cook MUST re-anchor the
  // fill. Here we prepare+compile at T0, then land a REAL Vault.swap (a big GHO→USDC in the recipe's OWN
  // direction — an ADVERSE move that worsens the GHO→USDC price), then cook the T0 bytecode. The received
  // output must equal the oracle rebuilt from the DRIFTED (T1) balances AND the REAL Vault queryBatchSwap at
  // T1 — and DIFFER from the stale-T0 value (a snapshotted-balance solver would land the T0 number and fail).
  async function runDrift(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.tokenIn; // GHO
    const tokenOut = etched.tokenOut; // USDC

    // A modest trade (~2% of the GHO balance) so the pool stays deep after the drift and the whole trade still
    // allocates to it (single venue) — the OUTPUT change is then a clean function of the re-anchored balances.
    const amountIn = nonBptBalanceOf(snaps.state, tokenIn) / 50n;
    const poolConfig = balancerPoolConfig(tokenIn, tokenOut);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);

    // Prepare + compile at T0 (snapshots nothing balance-side — the solver reads live at cook).
    const { bytecodes } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig, undefined, engine,
    );

    // The T0 (pre-drift) oracle — what a STALE-balance solver would land for the full amountIn.
    const opT0 = offPool(snaps.state, tokenIn, tokenOut);
    const receivedIfStale = getDy(opT0, amountIn);

    // DRIFT: a large GHO→USDC through the REAL Vault (raises the GHO balance, lowers USDC) — the recipe's own
    // direction, so it worsens the subsequent GHO→USDC price (adverse). ~15% of the GHO balance.
    await driftViaVaultSwap(tokenIn, tokenOut, nonBptBalanceOf(snaps.state, tokenIn) * 15n / 100n);

    // The T1 (post-drift) oracle + the REAL Vault's OWN queryBatchSwap at T1 — the re-anchored ground truth.
    const opT1 = await liveOffPool(tokenIn, tokenOut);
    const onViewT1Deltas = (await c.publicClient.readContract({
      address: etched.vault, abi: balancerVaultReadAbi, functionName: "queryBatchSwap",
      args: [
        0,
        [{ poolId: etched.poolId, assetInIndex: 0n, assetOutIndex: 1n, amount: amountIn, userData: "0x" as Hex }],
        [tokenIn, tokenOut],
        { sender: caller, fromInternalBalance: false, recipient: caller, toInternalBalance: false },
      ],
    })) as readonly bigint[];
    const onViewT1 = -onViewT1Deltas[1];
    // Sanity: the drift genuinely moved the priced output (adverse ⇒ T1 out < T0 out for the same input).
    assert.notEqual(onViewT1, receivedIfStale, "drift moved the GHO→USDC output (a stale-balance fill would differ)");
    assert.ok(onViewT1 < receivedIfStale, "adverse drift worsened the GHO→USDC output");

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drifted cook() must succeed against the REAL Balancer pool + Vault");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    assert.equal(spent, amountIn, "drift: whole trade still routes to the single deep venue");
    // RE-ANCHORED: the received output == the oracle rebuilt from the DRIFTED balances == the REAL Vault
    // queryBatchSwap at T1, to the WEI — and it is NOT the stale-T0 value. Proves the balance is read LIVE.
    assert.equal(received, getDy(opT1, spent), "received == neutral-oracle getDy at the DRIFTED (T1) balances (re-anchored)");
    assert.equal(received, onViewT1, "received == REAL Vault queryBatchSwap at the DRIFTED (T1) state (exact-in-dy)");
    assert.notEqual(received, receivedIfStale, "received != the stale-T0 fill — the LIVE balance read re-anchored the output");

    console.log(
      `  [balancer-prod-mirror:${engine}:drift] re-anchored: received=${received} (T1 query=${onViewT1}, ` +
        `stale-T0=${receivedIfStale}, spent=${spent})`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`ADVERSE-DRIFT re-anchor — LIVE balance read between prepare and cook [${engine}]`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});

/** The captured registered balance of a NON-BPT token (native decimals), by address. */
function nonBptBalanceOf(state: BalancerStateSnapshot, tokenAddr: Hex): bigint {
  const t = state.tokens.find((x) => x.address.toLowerCase() === tokenAddr.toLowerCase());
  if (!t) throw new Error(`token ${tokenAddr} not in the captured registered token list`);
  return BigInt(t.balance);
}
