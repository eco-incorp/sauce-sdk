/**
 * One-time capture of a REAL Curve StableSwap PLAIN pool from Ethereum mainnet, so the
 * Curve prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/solidly-snapshot.ts + harness/dodo-snapshot.ts (the proven pattern): eth_getCode
 * the pool's REAL Vyper runtime into a checked-in bytecode snapshot (WITH sha256 integrity anchors),
 * and the swap-relevant STATE (the full StableSwap invariant state — coins[], balances[], A, fee,
 * offpeg/admin fee, stored_rates, the coin indices) + the RAW storage slots needed to reconstruct it
 * (eth_getStorageAt) into a state snapshot. Block pinned. The RPC url / key is NEVER persisted — only
 * contract CODE + STATE.
 *
 * ── WHICH POOL (and WHY not the on-charter 3Pool) ────────────────────────────────────────────────
 * The DEEPEST on-charter all-stablecoin Curve pool on Ethereum is the classic 3Pool DAI/USDC/USDT
 * (0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7, ≈$160M). But 3Pool is an ANCIENT Vyper (0.1.0-beta)
 * whose `coins`/`balances` arrays live at keccak-HASHED storage slots (verified via eth_getProof:
 * slots 0..1200 hold ONLY fee/admin_fee/owner/A-ramp — the balances are NOT in any linear slot), and
 * this Alchemy tier exposes NO debug_storageRangeAt / trie dump. So its swap-relevant state CANNOT be
 * verbatim-reconstructed offline without the exact (unavailable) compiler storage-layout map — it is
 * NOT a faithful etch target.
 *
 * We therefore capture the DEEPEST reachable Curve StableSwap PLAIN pool with a CLEAN, sequential
 * (etchable) storage layout: the StableSwap-NG FRAX/USDe pool
 * 0x5dc1BF6f1e983C0b21EfB003c105133736fA0743 (≈$50M, 2 coins, both 18-dec, A=250, A_PRECISION=100 —
 * the modern default the recipe's `A_PRECISION_DEFAULT` assumes). Its layout is linear and verified:
 *   slot 0 = N_COINS(3? packed length marker)   slot 1 = 2
 *   slot 2 = balances[0] (FRAX)                  slot 3 = balances[1] (USDe)
 *   slot 10 = fee                                slot 11 = offpeg_fee_multiplier
 *   slot 12 = initial_A (= A*A_PRECISION)        slot 13 = future_A
 * The `coins[]` are IMMUTABLES baked into the runtime bytecode (FRAX/USDe found verbatim in the
 * runtime hex) — NOT storage — so an offline etch reconstructs them for free by setCode-ing the REAL
 * runtime, and (like Wombat/WOOFi) repoints the tokens by etching local MintableERC20s AT the real
 * FRAX/USDe addresses (setStorageAt cannot move an immutable-baked coin).
 *
 * ── DISCOVERY / on-charter caveat (DISCLOSED) ────────────────────────────────────────────────────
 * The production FactoryType.CurveRegistry reads the address wired in constants.ts for Ethereum
 * (0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5 — the LEGACY StableSwap registry). That registry
 * find_pool_for_coins(FRAX,USDe) returns the ZERO address (it only indexes old-registry pools: the
 * 3Pool + a couple metapools). This NG pool is reachable via the resolved Curve MetaRegistry
 * (0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC, = AddressProvider.get_address(7)) — same
 * find_pool_for_coins / get_coin_indices (int128 i,j) surface the CurveRegistry reader uses. We record
 * BOTH registries' results in the snapshot so the offline test can drive discovery through a
 * MetaRegistry shim at the wired address (the reader is registry-agnostic — it just calls
 * find_pool_for_coins → get_coin_indices → get_n_coins/get_decimals, then the pool's A()/fee()/
 * balances()/coins()). This is the on-charter/discovery FALLBACK, disclosed per the task charter.
 *
 * Quote view: get_dy(int128 i, int128 j, uint256 dx). Exec: approve + exchange(int128 i, int128 j,
 * dx, min_dy) — the engine _swapCurve path (SwapPoolType.Curve = 3).
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   ETH_RPC_URL=$ETH_RPC_URL npx tsx src/recipes/test/harness/curveStable-snapshot.ts
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  zeroAddress,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "ethereum-curveStable-FRAXUSDe";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The DEEPEST reachable Curve StableSwap PLAIN pool with a clean/etchable Vyper layout (StableSwap-NG
// FRAX/USDe). See the module header for why NOT the deeper-but-unetchable 3Pool.
const POOL = getAddress("0x5dc1BF6f1e983C0b21EfB003c105133736fA0743") as Address;

// The two Curve StableSwap registries. WIRED = the address FactoryType.CurveRegistry uses on Ethereum
// (constants.ts) — the LEGACY registry; it does NOT index this NG pool (returns zero). META = the
// resolved MetaRegistry that DOES (AddressProvider.get_address(7)). Both recorded for disclosure.
const WIRED_REGISTRY = getAddress("0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5") as Address;
const META_REGISTRY = getAddress("0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC") as Address;
const ADDRESS_PROVIDER = getAddress("0x0000000022D53366457F9d5E68Ec105046FC4383") as Address;

// The pool's two stable coins (both 18-dec) — the discovery from/to pair.
const FRAX = getAddress("0x853d955aCEf822Db058eb8505911ED77F175b99e") as Address;
const USDe = getAddress("0x4c9EDD5852cd905f086C759E8383e09bff1E68B3") as Address;

const RPC =
  process.argv[2] || process.env.ETH_RPC_URL || process.env.ETHEREUM_RPC_URL || "";
if (!RPC) {
  console.error(
    "no RPC — pass one as argv[2] or set ETH_RPC_URL (set -a; . sdk/.env; set +a)",
  );
  process.exit(1);
}

const registryAbi = parseAbi([
  "function find_pool_for_coins(address from, address to) view returns (address)",
  "function get_coin_indices(address pool, address from, address to) view returns (int128 i, int128 j, bool underlying)",
  "function get_n_coins(address pool) view returns (uint256)",
  "function get_decimals(address pool) view returns (uint256[8])",
]);
const providerAbi = parseAbi(["function get_address(uint256 id) view returns (address)"]);
const poolAbi = parseAbi([
  "function coins(uint256 i) view returns (address)",
  "function balances(uint256 i) view returns (uint256)",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function admin_fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function admin_balances(uint256 i) view returns (uint256)",
  "function initial_A() view returns (uint256)",
  "function future_A() view returns (uint256)",
  "function N_COINS() view returns (uint256)",
  "function stored_rates() view returns (uint256[])",
  "function get_virtual_price() view returns (uint256)",
  "function symbol() view returns (string)",
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

const sha256 = (hex: string) =>
  ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 1) {
    console.warn(`[curveStable-snapshot] WARNING: chainId ${chainId} != Ethereum (1)`);
  }
  // Pin the block for provenance + a deterministic reconstruction (all reads below use it).
  const block = await client.getBlockNumber();
  console.log(`[curveStable-snapshot] Ethereum chainId=${chainId} block=${block}`);

  // ── Discovery (BOTH registries) — records the on-charter wired miss + the MetaRegistry hit. ──
  const providerMeta = (await client
    .readContract({ address: ADDRESS_PROVIDER, abi: providerAbi, functionName: "get_address", args: [7n] })
    .catch(() => zeroAddress)) as Address;

  const discover = async (registry: Address) => {
    const pool = (await client
      .readContract({ address: registry, abi: registryAbi, functionName: "find_pool_for_coins", args: [FRAX, USDe], blockNumber: block })
      .catch(() => zeroAddress)) as Address;
    if (!pool || pool === zeroAddress) return { registry, pool: zeroAddress as Address };
    const [indices, nCoins, decimals] = await Promise.all([
      client.readContract({ address: registry, abi: registryAbi, functionName: "get_coin_indices", args: [pool, FRAX, USDe], blockNumber: block }).catch(() => null) as Promise<readonly [bigint, bigint, boolean] | null>,
      client.readContract({ address: registry, abi: registryAbi, functionName: "get_n_coins", args: [pool], blockNumber: block }).catch(() => null) as Promise<bigint | null>,
      client.readContract({ address: registry, abi: registryAbi, functionName: "get_decimals", args: [pool], blockNumber: block }).catch(() => null) as Promise<readonly bigint[] | null>,
    ]);
    return { registry, pool, indices, nCoins, decimals };
  };

  const wired = await discover(WIRED_REGISTRY);
  const meta = await discover(META_REGISTRY);
  console.log(`[curveStable-snapshot] WIRED registry ${WIRED_REGISTRY} find_pool_for_coins(FRAX,USDe) = ${wired.pool} (expected ZERO — legacy registry does not index this NG pool)`);
  console.log(`[curveStable-snapshot] META registry ${META_REGISTRY} (AddressProvider.get_address(7)=${providerMeta}) find_pool_for_coins(FRAX,USDe) = ${meta.pool}`);
  if (!meta.pool || meta.pool === zeroAddress || getAddress(meta.pool) !== POOL) {
    throw new Error(`MetaRegistry did not resolve the expected NG pool ${POOL} (got ${meta.pool})`);
  }
  if (!meta.indices) throw new Error("MetaRegistry get_coin_indices failed");
  const i = Number(meta.indices[0]);
  const j = Number(meta.indices[1]);
  const underlying = meta.indices[2];
  if (underlying) throw new Error("discovered pool is UNDERLYING (meta) — expected a plain pool");
  console.log(`[curveStable-snapshot] coin indices (FRAX->USDe): i=${i} j=${j} underlying=${underlying}`);

  // ── The pool's REAL Vyper runtime (self-contained — coins are immutables baked in the bytecode). ──
  const poolCode = await client.getCode({ address: POOL });
  if (!poolCode || poolCode === "0x") throw new Error(`empty code at pool ${POOL}`);
  console.log(`[curveStable-snapshot] pool runtime = ${poolCode.length / 2 - 1} bytes`);

  const N = Number((await client.readContract({ address: POOL, abi: poolAbi, functionName: "N_COINS", blockNumber: block })) as bigint) || 2;

  // Coins + per-coin decimals/symbol/pool-held balanceOf (the coins are immutable-in-runtime).
  const coins: Address[] = [];
  for (let k = 0; k < N; k++) {
    coins.push((await client.readContract({ address: POOL, abi: poolAbi, functionName: "coins", args: [BigInt(k)], blockNumber: block })) as Address);
  }
  const coinInfo = await Promise.all(
    coins.map(async (addr) => {
      const [sym, dec, held] = await Promise.all([
        client.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
        client.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }).then(Number).catch(() => 18),
        client.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [POOL], blockNumber: block }).catch(() => 0n) as Promise<bigint>,
      ]);
      // Verify the coin address IS baked as an immutable in the runtime (so the offline etch restores it).
      const inRuntime = poolCode.toLowerCase().includes(addr.slice(2).toLowerCase());
      return { address: addr, symbol: sym as string, decimals: dec, poolBalanceOf: held, immutableInRuntime: inRuntime };
    }),
  );
  console.log("[curveStable-snapshot] coins:", coinInfo.map((c) => `${c.symbol}(${c.decimals})=${c.address}${c.immutableInRuntime ? " [immutable]" : " [NOT-in-runtime!]"}`).join(", "));

  // ── Swap-relevant invariant STATE via the pool's own getters (the ground truth). ──
  const balances: bigint[] = [];
  for (let k = 0; k < N; k++) {
    balances.push((await client.readContract({ address: POOL, abi: poolAbi, functionName: "balances", args: [BigInt(k)], blockNumber: block })) as bigint);
  }
  // admin_balances[k]: NG stores `stored_balances[k]` (raw held, slots 2..1+N) and exposes
  // balances(k) = stored_balances[k] − admin_balances[k]. Capturing admin_balances lets the offline
  // etch reconcile the raw storage window (slots 2/3) with the balances() getter output byte-exactly.
  const adminBalances: bigint[] = [];
  for (let k = 0; k < N; k++) {
    adminBalances.push(
      (await client
        .readContract({ address: POOL, abi: poolAbi, functionName: "admin_balances", args: [BigInt(k)], blockNumber: block })
        .catch(() => 0n)) as bigint,
    );
  }
  const [A, fee, adminFee, offpeg, initialA, futureA, virtualPrice, symbol] = await Promise.all([
    client.readContract({ address: POOL, abi: poolAbi, functionName: "A", blockNumber: block }) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "fee", blockNumber: block }) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "admin_fee", blockNumber: block }).catch(() => -1n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "offpeg_fee_multiplier", blockNumber: block }).catch(() => -1n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "initial_A", blockNumber: block }).catch(() => -1n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "future_A", blockNumber: block }).catch(() => -1n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "get_virtual_price", blockNumber: block }).catch(() => 0n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "symbol" }).catch(() => "?") as Promise<string>,
  ]);
  // stored_rates: NG returns the per-coin rate multipliers (1e18 for a plain no-rate-oracle stable).
  const storedRates = (await client
    .readContract({ address: POOL, abi: poolAbi, functionName: "stored_rates", blockNumber: block })
    .catch(() => null)) as bigint[] | null;

  // ── Probe get_dy at the CAPTURED state (both directions) — the self-check the offline test reproduces
  //    against the etched pool (real Vyper code, real reconstructed balances). ──
  const dxIn = 100_000n * 10n ** BigInt(coinInfo[i].decimals); // 100k tokenIn units
  const dxRev = 100_000n * 10n ** BigInt(coinInfo[j].decimals);
  const [dyFwd, dyRev] = await Promise.all([
    client.readContract({ address: POOL, abi: poolAbi, functionName: "get_dy", args: [BigInt(i), BigInt(j), dxIn], blockNumber: block }) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "get_dy", args: [BigInt(j), BigInt(i), dxRev], blockNumber: block }) as Promise<bigint>,
  ]);

  // ── Raw storage window for deterministic setStorageAt reconstruction. The NG pool packs its
  //    swap-relevant state into a linear window (verified): slot 0/1 markers, slot 2..(1+N) balances,
  //    slot 10 fee, slot 11 offpeg, slot 12 initial_A, slot 13 future_A. Capture 0..63 (a generous
  //    window covering balances/fees/A-ramp/rate-oracle bookkeeping) so the etch reconstructs the
  //    invariant state byte-identically. eth_getStorageAt is pinned to the block. ──
  const SLOT_WINDOW = 64;
  const storage: Record<string, Hex> = {};
  for (let s = 0; s < SLOT_WINDOW; s++) {
    const slot = ("0x" + s.toString(16).padStart(64, "0")) as Hex;
    const v = await client.getStorageAt({ address: POOL, slot, blockNumber: block });
    if (v && BigInt(v) !== 0n) storage[s.toString()] = v as Hex; // only persist nonzero slots
  }

  // ── Write the bytecode snapshot (WITH sha256 anchor). ──
  const bytecodeSnap = {
    chain: "ethereum",
    chainId,
    block: block.toString(),
    pool: { address: POOL, runtime: poolCode, runtimeSha256: sha256(poolCode) },
    // No proxy: a StableSwap-NG pool is a self-contained Vyper runtime (coins baked as immutables).
    isMinimalProxy: false,
    dependencies: [] as unknown[],
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Write the state snapshot. ──
  const stateSnap = {
    chain: "ethereum",
    chainId,
    block: block.toString(),
    pool: POOL,
    poolSymbol: symbol,
    source: "Curve",
    // Discovery: the wired (legacy) registry MISSES this NG pool (records zero); the MetaRegistry hits.
    // The offline test drives FactoryType.CurveRegistry via a MetaRegistry shim at the wired address.
    discovery: {
      wiredRegistry: WIRED_REGISTRY,
      wiredFindPool: wired.pool, // expected zeroAddress — the disclosed on-charter/discovery fallback
      metaRegistry: META_REGISTRY,
      metaRegistryFromProvider: providerMeta,
      metaFindPool: meta.pool,
      addressProvider: ADDRESS_PROVIDER,
    },
    // Coin indices for the engine exchange(int128 i, int128 j, dx, min_dy) — tokenIn=coins[i]=FRAX.
    i,
    j,
    underlying,
    nCoins: N,
    coins: coinInfo.map((c) => ({
      address: c.address,
      symbol: c.symbol,
      decimals: c.decimals,
      poolBalanceOf: c.poolBalanceOf.toString(),
      immutableInRuntime: c.immutableInRuntime,
    })),
    tokenIn: coins[i],
    tokenOut: coins[j],
    // The StableSwap invariant state (the ground truth the offline oracle + test assert against).
    // A_PRECISION = 100 (modern/NG). initial_A/future_A are A*A_PRECISION (both 25000 here ⇒ A=250,
    // no active ramp). fee is 1e10-scaled (1_000_000 = 0.01%). offpeg_fee_multiplier is the NG dynamic
    // fee multiplier; stored_rates are the per-coin 1e18 rate multipliers (both 1e18: plain, no oracle).
    A: A.toString(),
    aPrecision: "100",
    fee: fee.toString(),
    adminFee: adminFee.toString(),
    offpegFeeMultiplier: offpeg.toString(),
    initialA: initialA.toString(),
    futureA: futureA.toString(),
    storedRates: storedRates ? storedRates.map(String) : null,
    balances: balances.map(String),
    // stored_balances[k] (raw held, slots 2..1+N) = balances[k] + adminBalances[k]. The etch
    // reconciles the verbatim storage window against balances() via: balances(k) = slot(2+k) − slot(17+k).
    adminBalances: adminBalances.map(String),
    storedBalances: balances.map((b, k) => (b + adminBalances[k]).toString()),
    // rates[k] = 1e18 * 10**(18 - decimals[k]) — the recipe/oracle scaling (see curve-math.ts).
    rates: coinInfo.map((c) => (10n ** 18n * 10n ** BigInt(18 - c.decimals)).toString()),
    virtualPrice: virtualPrice.toString(),
    // Captured get_dy probes — the self-check the offline test reproduces against the etched pool.
    probe: {
      forward: { i, j, dx: dxIn.toString(), dy: dyFwd.toString() },
      reverse: { i: j, j: i, dx: dxRev.toString(), dy: dyRev.toString() },
    },
    // Raw storage window (nonzero slots 0..63) for setStorageAt reconstruction.
    storage,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[curveStable-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[curveStable-snapshot] state: ${symbol} pool=${POOL}\n` +
      `  coins=[${coinInfo.map((c) => `${c.symbol}(${c.decimals})`).join(", ")}] i=${i} j=${j}\n` +
      `  A=${A} (aPrecision=100) fee=${fee} admin_fee=${adminFee} offpeg=${offpeg} initial_A=${initialA} future_A=${futureA}\n` +
      `  balances=[${balances.join(", ")}] storedRates=[${storedRates ?? "n/a"}] virtualPrice=${virtualPrice}\n` +
      `  probe get_dy(${i}->${j}, 100k) = ${dyFwd}  ;  get_dy(${j}->${i}, 100k) = ${dyRev}\n` +
      `  storage slots captured (nonzero, 0..63): ${Object.keys(storage).length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
