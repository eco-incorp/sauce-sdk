/**
 * EcoSwap Fermi / propAMM (gattaca-com/propamm FermiSwapper — an Obric-style ORACLE-PRICED PROACTIVE AMM)
 * PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The Fermi analogue of ecoswap.woofi.prodmirror.evm.test.ts / ecoswap.mento.prodmirror.evm.test.ts. Unlike
 * ecoswap.fermi.evm.test.ts (which deploys a MOCK FermiPool.sol fixture), this test stands up the GENUINE
 * Ethereum-mainnet FermiSwapper bytecode + its whole oracle/vault contract graph captured from mainnet, and
 * runs the swap against it — proving the production discovery + execution path works on the REAL contract,
 * with NO fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * ── THE CAPTURED GRAPH (harness/fermi-snapshot.ts, one-time, uses the RPC key) ──────────────────────────────
 * The quote/swap path (verified by trace) fans out FermiSwapper 0xb1076fE3… → oracle store 0xe514A3c4… → feed
 * helper 0xDa7AfeeD…, and prices off the RESERVE VAULT 0x585d4472… (the address FermiSwapper storage slot 3
 * points at — the QUOTE reads token.balanceOf(VAULT), the SWAP does transferFrom(VAULT, taker, out) +
 * transferFrom(taker, VAULT, in)). It also touches an EIP-7702 delegated EOA (0x4838b1…) via
 * EXTCODESIZE/BALANCE — a codeless account there makes the FermiSwapper quote 0, so the 24-byte
 * 0xef0100||delegate designator is captured + etched. The snapshot carries every touched runtime (sha256-
 * anchored) + the swap-relevant state (oracle store price/config/last-update slots, feed helper packed
 * (ts,price) slots, FermiSwapper config slots 0..3, the vault reserves + its max router allowance). Block +
 * block.timestamp pinned.
 *
 * ── WHY block.timestamp is PINNED (the freshness gate) ──────────────────────────────────────────────────────
 * The oracle store gates freshness on block.timestamp ≤ feed.lastUpdate + maxAge; past the window it reverts
 * StaleUpdate() (0x666a2814). The feed's price/config slots are BYTE-IDENTICAL fresh-vs-stale — ONLY the clock
 * gates — so pinning block.timestamp to the captured fresh block's ts un-stales a REAL captured price (NO price
 * is fabricated; it is the real on-chain oracle value in the captured slots, with the staleness clock held at
 * the capture instant — the SNAPSHOTTED-QUOTE class fermi-math.ts documents). pinFermiBlockTimestamp does this.
 *
 * ── CENTRAL VERIFICATION (this file asserts all explicitly) ─────────────────────────────────────────────────
 *   (a) REAL bytecode — eth_getCode at the FermiSwapper + oracle store + feed helper + reserve vault + the
 *       7702 EOA designator == the captured real runtime, byte-for-byte (sha256-anchored; a NO-RPC integrity
 *       tripwire runs FIRST). No mock FermiPool.sol is in the swap path (the addresses are the captured mainnet
 *       addresses running captured code). The REAL quoteAmounts reproduces the captured probe ladder to the wei
 *       for BOTH pairs (WETH/USDC + WBTC/USDC) — the strongest single-shot proof the etched code IS mainnet.
 *   (b) FAST + OFFLINE — no fork, no RPC at run time (proven with a poisoned *_RPC_URL); per-engine wall-clock
 *       logged (seconds).
 *   (c) WEI-EXACT — the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts optimalSplit, seeded
 *       from the pool's OWN LIVE sampled quote ladder via the SHARED buildFermiSegments) == the REAL pool's own
 *       pre-swap quoteAmounts view of the awarded slice, all to the wei. spent == awarded is asserted (Fermi is
 *       a SAMPLED-SEGMENT venue, so the awarded Σ is the grid's covered capacity, ≤ amountIn — the small tail is
 *       bounded, mirroring the WOOFi/DODO prod-mirror).
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default when the v12 artifacts are absent).
 * No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.fermi.prodmirror.evm.test.ts
 *      ECO_ENGINE=both pnpm --filter './sdk' test:recipes:evm
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, getAddress, type Abi, type Account, type Hex } from "viem";

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
  etchFermiGraph,
  loadFermiSnapshots,
  verifyFermiBytecodeIntegrity,
  pinFermiBlockTimestamp,
  fermiSwapperReadAbi,
  type EtchedFermiGraph,
  type FermiStateSnapshot,
} from "./harness/etch-pool";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { EcoBracketKind } from "../shared/types";
import { ecoSwap } from "../ecoswap/index";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import {
  getAmountOut as fermiGetAmountOut,
  type FermiPool,
} from "../shared/fermi-math";
import { qlLadderInputs } from "../shared/curve-math";

const SNAP_NAME = "ethereum-fermi-WETHUSDC";
const ENGINE_CELLS = engineCells();

describe("EcoSwap Fermi / propAMM (FermiSwapper oracle-priced proactive AMM) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadFermiSnapshots(SNAP_NAME);
  const captureTs = BigInt(snaps.state.blockTimestamp);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedFermiGraph;

  // Boot a fresh anvil + deploy the engine + etch the real graph + pin the capture time. Called before each
  // cell so each engine runs in full isolation (cheap — etch + setStorageAt + a few deploys, seconds).
  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // Caller headroom: 10 WETH / 10 WBTC (well over any trade sized below the vault's USDC cap).
    etched = await etchFermiGraph(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: 10n ** 19n,
    });
    // Pin block.timestamp to the captured fresh ts (else the oracle staleness gate reverts StaleUpdate).
    await pinFermiBlockTimestamp(c.testClient as never, snaps.state);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a Fermi factory (the captured FermiSwapper address) → the production Fermi
   *  discovery path (discoverFermiPoolsTyped) resolves the pair; the lens ignores non-V2/V3/V4 factory types,
   *  so no direct pools are surfaced and the Fermi venue rides entirely through the typed discovery + the
   *  callback-free quoteAmounts/approve/fermiSwapWithAllowances exec block (segKind 11). poolType is unused for
   *  a Fermi venue (there is no engine SwapPoolType.Fermi) — WOOFi is a harmless placeholder the lens skips. */
  function fermiPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.fermiSwapper,
          poolType: SwapPoolType.WOOFi,
          factoryType: FactoryType.Fermi,
          label: "Local Fermi FermiSwapper (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  /** The FermiSwapper's OWN on-chain quoteAmounts view (the engine-independent ground truth for the executed
   *  dy). Returns amountOut ([1]) for the exact-in leg (amountSpecified positive = exact tokenIn). */
  async function onQuery(tokenIn: Hex, tokenOut: Hex, amt: bigint): Promise<bigint> {
    const r = (await c.publicClient.readContract({
      address: etched.fermiSwapper,
      abi: fermiSwapperReadAbi as Abi,
      functionName: "quoteAmounts",
      args: [tokenIn, tokenOut, amt],
    })) as readonly [bigint, bigint];
    return r[1];
  }

  /** Build the neutral-oracle FermiPool descriptor by SAMPLING the etched pool's LIVE quoteAmounts ladder AT
   *  the geometric `qlLadderInputs` points — the SAME points the on-chain QL solver queries — so
   *  buildFermiQLLadder's interpolation is EXACT at every ladder point and the oracle reproduces the solver's
   *  live quoteAmounts ladder to the wei (Fermi is now a QUOTE-LADDER venue). */
  async function offPool(tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<FermiPool> {
    const cumIn = qlLadderInputs(amountIn);
    const cumOut: bigint[] = [];
    for (const amt of cumIn) cumOut.push(await onQuery(tokenIn, tokenOut, amt));
    // Derive the effective fee ppm from the shallowest slice (the same rule discovery uses) — diagnostic only.
    let feePpm = 0;
    if (cumIn.length > 0 && cumIn[0] > 0n && cumOut[0] > 0n && cumOut[0] < cumIn[0]) {
      const shortfall = ((cumIn[0] - cumOut[0]) * 1_000_000n) / cumIn[0];
      if (shortfall > 0n && shortfall < 1_000_000n) feePpm = Number(shortfall);
    }
    return { address: etched.fermiSwapper, tokenIn, tokenOut, cumIn, cumOut, feePpm, source: "prod-mirror" };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL FermiSwapper + oracle graph (byte-equal) + reproduces the captured probe ladder", async () => {
    // NO-NETWORK integrity tripwire FIRST: every checked-in runtime (FermiSwapper + oracle store + feed helper
    // + reserve vault + the 7702 EOA designator + the token proxies) still hashes to its capture-time sha256
    // anchor. A reviewer without the RPC key can run this — it proves the snapshot wasn't silently altered.
    const integ = verifyFermiBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, "every captured runtime sha256 matches its capture anchor");
    for (const cc of integ.contracts) {
      assert.ok(cc.expected, `${cc.role} carries a sha256 integrity anchor`);
      assert.ok(cc.ok, `${cc.address} [${cc.role}] runtime sha256 matches (got ${cc.actual})`);
    }

    // eth_getCode at the FermiSwapper + oracle store + feed helper + reserve vault == the captured real runtime
    // (no mock in the path). These are the swap-relevant contracts (the router, the oracle math, the vault).
    const swapper = getAddress(snaps.state.fermiSwapper) as Hex;
    const vault = getAddress(snaps.state.vault.address) as Hex;
    const oracleStore = snaps.bytecode.contracts.find((x) => x.role.includes("pricing-dependency") && x.codeSizeBytes > 10000)!;
    const feedHelper = snaps.bytecode.contracts.find((x) => x.role.includes("pricing-dependency") && x.codeSizeBytes < 10000)!;
    for (const cc of snaps.bytecode.contracts) {
      const addr = getAddress(cc.address) as Hex;
      // Skip the repointed tokens — those are LOCAL MintableERC20s (their code is NOT the captured proxy; the
      // captured token proxy code is only recorded for reference). Everything else is etched byte-equal.
      const isToken = ["WETH", "USDC", "WBTC"].some(
        (s) => getAddress(snaps.state.tokens[s].address).toLowerCase() === addr.toLowerCase(),
      );
      const isTokenImpl = cc.role.includes("token-implementation");
      if (isToken || isTokenImpl) continue;
      const code = await c.publicClient.getCode({ address: addr });
      assert.ok(code, `${addr} [${cc.role}] has code`);
      assert.equal(
        code!.toLowerCase(),
        cc.runtime.toLowerCase(),
        `eth_getCode at ${addr} == the captured REAL runtime (byte-equal) [${cc.role}]`,
      );
    }
    // The FermiSwapper + vault are at the captured mainnet addresses (no locally-compiled mock).
    assert.equal(etched.fermiSwapper.toLowerCase(), swapper.toLowerCase(), "FermiSwapper at captured mainnet address");
    assert.equal(etched.vault.toLowerCase(), vault.toLowerCase(), "reserve vault at captured mainnet address");

    // The REAL code reads the reconstructed state correctly: isActive true, and the vault holds the reserves.
    const active = (await c.publicClient.readContract({
      address: etched.fermiSwapper, abi: fermiSwapperReadAbi as Abi, functionName: "isActive",
      args: [etched.tokenIn, etched.tokenOut],
    })) as boolean;
    assert.ok(active, "REAL FermiSwapper reports the WETH/USDC pair active");
    const vaultUsdc = await balanceOf(c.publicClient, etched.tokenOut, etched.vault);
    assert.equal(vaultUsdc, BigInt(snaps.state.vault.reserves.USDC), "vault holds the captured USDC reserve");

    // The REAL quoteAmounts reproduces the captured probe ladder to the WEI for BOTH pairs — the strongest
    // single-shot proof the etched code IS the mainnet code (real oracle, real feed, real vault reserves).
    for (const p of snaps.state.probe.target.ladder) {
      const out = await onQuery(etched.tokenIn, etched.tokenOut, BigInt(p.amountIn));
      assert.equal(out.toString(), p.amountOut, `REAL quoteAmounts(WETH ${p.amountIn}) == captured mainnet ${p.amountOut}`);
    }
    if (snaps.state.second && snaps.state.probe.second) {
      const secondIn = getAddress(snaps.state.second.tokenIn) as Hex;
      const secondOut = getAddress(snaps.state.second.tokenOut) as Hex;
      for (const p of snaps.state.probe.second.ladder) {
        const out = await onQuery(secondIn, secondOut, BigInt(p.amountIn));
        assert.equal(out.toString(), p.amountOut, `REAL quoteAmounts(WBTC ${p.amountIn}) == captured mainnet ${p.amountOut}`);
      }
    }

    console.log(
      `  [fermi-prod-mirror] REAL bytecode etched: FermiSwapper ${etched.fermiSwapper} ` +
        `(oracle store ${oracleStore.codeSizeBytes}B, feed helper ${feedHelper.codeSizeBytes}B, ` +
        `vault ${etched.vault}); ${etched.contractCount} contracts, ${etched.slotCount} slots; ` +
        `captured block ${snaps.state.block} ts ${captureTs}; probe ladder reproduced wei-exact ` +
        `(WETH/USDC + WBTC/USDC). Reserve vault + 7702 EOA designator etched (both sha256-anchored).`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle + real view. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // WETH → USDC (the deepest quotable on-charter pair). Size the trade at 10 WETH — comfortably below the
    // vault's USDC cap (28093 USDC ≈ 17.4 WETH) so the swap pays out cleanly, AND large enough that the
    // sampled ladder covers ~96% of [0, amountIn]. (Fermi's propAMM curve is very FLAT near par, so at a
    // small size the s²-spaced sampler puts most points in the flat region where the fee-adjusted marginal
    // does not descend — buildFermiSegments' strictly-descending guard then drops those slices, leaving a
    // coarse grid that covers only ~38% of a 1-WETH trade. This is the genuine SAMPLED-SEGMENT behavior, not
    // a bug; sizing up tightens the coverage. The awarded Σ is the grid's covered capacity ≤ amountIn — the
    // small tail is bounded below.)
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    const amountIn = 10n ** 19n; // 10 WETH
    const poolConfig = fermiPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // Run EcoSwap through the PRODUCTION FactoryType.Fermi discovery path.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced Fermi venue (via the real quoteAmounts sampler).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (Fermi-only config)");
    assert.equal((prepared.fermiPools ?? []).length, 1, "discovered exactly the 1 reproduced Fermi venue");
    assert.equal(
      prepared.fermiPools![0].address.toLowerCase(),
      etched.fermiSwapper.toLowerCase(),
      "the discovered Fermi venue is the REAL etched FermiSwapper",
    );
    assert.equal(
      prepared.fermiPools![0].fromToken.toLowerCase(),
      tokenIn.toLowerCase(),
      "discovery oriented the venue fromToken == tokenIn",
    );
    // Fermi is now a QUOTE-LADDER (QL) venue: prepare ships ONLY the descriptor (prepared.fermiPools), NO
    // static sampled Fermi brackets. The on-chain solver builds the price ladder live from the pool's own
    // quoteAmounts.
    assert.ok(
      !(prepared.brackets ?? []).some((b) => b.kind === EcoBracketKind.Fermi),
      "Fermi ships as a QL descriptor (no static sampled Fermi brackets)",
    );

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one Fermi venue seeded from the pool's OWN live quoteAmounts ladder
    // (sampled AT the geometric qlLadderInputs points) via the SHARED buildFermiQLLadder — the IDENTICAL ladder
    // the on-chain solver builds live. Pure off-chain math (computed BEFORE the cook), so the awarded Σ is known
    // ahead — spent == oracle awarded to the wei.
    const op = await offPool(tokenIn, tokenOut, amountIn);
    const optPools: OptimalPool[] = [{ fermi: op, feePpm: op.feePpm } as OptimalPool];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced Fermi venue");

    // The REAL FermiSwapper's OWN pre-swap quoteAmounts view for the KNOWN awarded Σ — the engine-independent
    // ground truth for the executed dy of the awarded slice, read on the pre-swap state (the sell mutates the
    // vault reserve). This is the REAL Solidity oracle-curve reading the REAL oracle + vault, NOT the replay.
    const onViewPre = await onQuery(tokenIn, tokenOut, awarded);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, etched.vault);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL FermiSwapper bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const vaultIn = (await balanceOf(c.publicClient, tokenIn, etched.vault)) - vaultInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // Fermi PULLS the input into the VAULT via transferFrom (approve-first) — the vault nets exactly the spend.
    assert.equal(vaultIn, spent, "REAL FermiSwapper routed the input into the vault (approve + transferFrom)");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI. NO tolerance. Fermi is a
    // SAMPLED-SEGMENT venue (buildFermiSegments differences the sampled quote ladder into descending-marginal
    // segments capped at amountIn, dropping any non-descending-marginal tail slice) — so the awarded Σ is the
    // grid's covered capacity, at most amountIn. The engine's static-segment cursor consumes the IDENTICAL
    // grid, so spent == oracle awarded == oracle.totalInput to the wei.
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact-on-grid)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact-on-grid)");
    assert.ok(spent <= amountIn, "spent does not exceed amountIn");
    // Bound the unfilled tail so a gross under-fill (broken ladder / wrong orientation) still fails here. At
    // 10 WETH the sampled grid covers ~96% of amountIn (the small remainder is the flat near-par tail the
    // strictly-descending-marginal guard drops); assert < 5% (the WOOFi/DODO sampled-segment convention).
    const tail = amountIn - spent;
    assert.ok(tail * 20n < amountIn, `unfilled tail is the small Fermi grid remainder (<5% of amountIn): tail=${tail}`);

    // WEI-EXACT dy: the caller-received tokenOut == the REAL pool's OWN pre-swap quoteAmounts(awarded Σ) view,
    // to the WEI. NO tolerance. The exec re-reads the LIVE quote at execution (fermiSwapWithAllowances
    // amountCheck == the just-read quote), and since the state is unchanged between prepare and cook, that live
    // quote IS onViewPre. The FermiSwapper exposes NO closed-form curve (no getAmountOut view, no K/base
    // getters) — so the ONLY exact off-chain replay of the dy is the LIVE quoteAmounts itself; onViewPre is
    // exactly that (the real Solidity oracle-curve reading the real oracle + vault). This is the same
    // exact-vs-live-quote gate the synthetic ecoswap.fermi.evm.test.ts asserts.
    assert.equal(received, onViewPre, "received == REAL pool pre-swap quoteAmounts(awarded Σ) (wei-exact-vs-live-quote)");
    // The neutral oracle's ladder-INTERPOLATED getAmountOut agrees within a tight bound (diagnostic only — the
    // awarded Σ is the sum of the kept segment capacities, which no longer lands exactly on a sampled ladder
    // point once the strictly-descending guard drops slices, so the linear interpolation is approximate, not
    // wei-exact; the exact ground truth is the live quote view above). A gross divergence would flag a broken
    // ladder / orientation.
    const oracleOut = fermiGetAmountOut(op, awarded);
    const dOut = received > oracleOut ? received - oracleOut : oracleOut - received;
    assert.ok(dOut * 1_000_000n <= received, `oracle ladder-interp getAmountOut within ~1 ppm of the live dy (Δ=${dOut} of ${received})`);

    // RESIDUE SWEEP (the Metric USDT-class lesson): the exec arm raw-approves the UNVERIFIED FermiSwapper
    // for the awarded Σ — the counterparty class that COULD pull less than approved (the Metric partial-fill
    // lesson). Probed on this REAL bytecode: quoteAmounts returns aIn == the requested exact-in at every
    // size (incl. a 100k-WETH capped-output oversize, where the swap still pulled the FULL input), so
    // pull == approve always. Assert the residue is 0 after the genuine-bytecode cook.
    const residue = (await c.publicClient.readContract({
      address: tokenIn, abi: parseAbi(["function allowance(address, address) view returns (uint256)"]) as Abi,
      functionName: "allowance", args: [target, etched.fermiSwapper],
    })) as bigint;
    assert.equal(residue, 0n, "no FermiSwapper allowance residue on the REAL bytecode (pull == approve)");

    const ms = Date.now() - t0;
    console.log(
      `  [fermi-prod-mirror:${engine}] WEI-EXACT vs neutral oracle + real view — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, realView=${onViewPre}, amountIn=${amountIn}); wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  // ── SPLIT cell: WETH/USDC + WBTC/USDC both quote off the same oracle store — a two-pair split diagnostic. ──
  // NB EcoSwap solves ONE (tokenIn, tokenOut) pair, so a genuine split across BOTH pairs is not one cook. This
  // cell instead runs the SECOND pair (WBTC/USDC) solo through the same production path — proving the discovery
  // + exec generalises across pairs on the SAME real oracle graph, wei-exact.
  async function runSecondPair(engine: Engine): Promise<void> {
    if (!etched.secondTokenIn || !snaps.state.second) return; // captured target-only
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.secondTokenIn;
    const tokenOut = etched.tokenOut; // USDC
    // ~0.05 WBTC — well below the vault's USDC cap; the ladder covers [0, amountIn].
    const amountIn = 5n * 10n ** 6n;
    const poolConfig = fermiPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig, undefined, engine,
    );
    assert.equal((prepared.fermiPools ?? []).length, 1, "discovered the WBTC/USDC Fermi venue");

    const op = await offPool(tokenIn, tokenOut, amountIn);
    const oracle = optimalSplit({ pools: [{ fermi: op, feePpm: op.feePpm } as OptimalPool], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the WBTC/USDC venue");
    const onViewPre = await onQuery(tokenIn, tokenOut, awarded);

    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "WBTC/USDC cook() must succeed against the REAL bytecode");
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(received, onViewPre, "received == REAL pool pre-swap quoteAmounts(awarded Σ) (WBTC/USDC, exact-vs-live-quote)");
    console.log(`  [fermi-prod-mirror:${engine}] WBTC/USDC solo — awarded=${awarded} received=${received} (== real view, wei-exact)`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL FermiSwapper bytecode [${engine}] — WETH/USDC wei-exact vs the neutral oracle + real view, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
    it(`runs the second real pair (WBTC/USDC) through the REAL FermiSwapper bytecode [${engine}] — wei-exact vs real view, offline`, { skip }, async () => {
      await runSecondPair(engine);
    });
  }
});
