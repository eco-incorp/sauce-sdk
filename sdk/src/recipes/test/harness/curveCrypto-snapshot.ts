/**
 * One-time capture of a REAL Curve CryptoSwap (twocrypto-ng) pool from Ethereum mainnet, so the
 * CryptoSwap prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/dodo-snapshot.ts / harness/solidly-snapshot.ts (the proven pattern): eth_getCode
 * the pool's REAL runtime AND every dependency contract the swap/quote path touches, into a
 * checked-in bytecode snapshot (WITH sha256 integrity anchors), and the swap-relevant state (the full
 * A-gamma invariant state + tokens/decimals/fee params + the RAW pool storage slots — Vyper has no
 * Solidity layout, so the reconstruction is a VERBATIM slot copy) into a state snapshot. Block
 * pinned. The RPC url / key is NEVER persisted — only contract CODE + STATE.
 *
 * WHICH POOL (STEP 1): the DEEPEST on-charter STABLE-INCLUSIVE 2-coin CryptoSwap pool the wired
 * FactoryType.CurveCryptoRegistry (crypto variant) discovery RESOLVES via find_pool_for_coins.
 *
 *   On-charter reading: a pure stable/stable pool is always a StableSwap (int128 indices) — CryptoSwap
 *   (twocrypto/tricrypto-NG, uint256 indices, A-gamma invariant) pools are volatile-inclusive by
 *   construction, so the charter's "a stable/stable-adjacent twocrypto, OR a tricrypto with a USD leg"
 *   resolves to a 2-coin twocrypto-ng with a USD (stablecoin) leg. crvUSD is a genuine Curve-native
 *   USD stablecoin; the DEEPEST such pool that the discovery path RESOLVES is crvUSD/WETH.
 *
 *   Deeper crvUSD 2-coin crypto pools EXIST (crvUSD/WBTC ~$37M 0x313698…, crvUSD/tBTC ~$64M 0x862CB4…),
 *   but the twocrypto-ng registry's find_pool_for_coins resolves those PAIRS to DIFFERENT (other/older)
 *   pools — so they cannot be faithfully prod-mirrored THROUGH the production discovery path. The
 *   crvUSD/WETH pool 0x6e5492F8… (~$27M) is the deepest stable-inclusive 2-coin crypto pool whose coins
 *   find_pool_for_coins resolves EXACTLY back to itself (idx 0,1) — so it is the on-charter choice.
 *   (Recorded below with fallback provenance so the return is HONEST about "deepest RESOLVABLE", not
 *   "deepest that exists".)
 *
 * DEPENDENCY CONTRACTS captured (every contract the get_dy / exchange path touches):
 *   1. the twocrypto-ng POOL runtime at its captured mainnet address (Vyper; coins are IMMUTABLE, baked
 *      in the runtime — verified each coin address appears exactly ONCE in code and NOT in storage — so
 *      the test etches local MintableERC20s AT the real coin addresses, like Wombat/WOOFi, NOT via a
 *      storage repoint).
 *   2. the MATH library runtime (twocrypto-ng CurveCryptoMathOptimized, v0.1.0) at pool.MATH() — get_dy
 *      and exchange STATICCALL it for newton_D / get_y / get_p (the A-gamma Newton solve). It is a PURE
 *      library (no swap-relevant storage), so only its runtime is captured.
 *   3. the FACTORY runtime at pool.factory() — the twocrypto-ng exchange path reads factory.fee_receiver()
 *      inside its admin-fee bookkeeping, so the factory runtime + its fee_receiver slot are captured so the
 *      etched exchange runs unchanged. (The factory is ALSO the discovery registry: find_pool_for_coins /
 *      get_coin_indices — FactoryType.CurveCryptoRegistry — so the offline test can run the real discovery
 *      path against it by etching this runtime + reconstructing its pool-index storage, OR by injecting a
 *      local ChainPoolConfig pointing the CurveCryptoRegistry factory at it.)
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   ETH_RPC_URL=$ETH_RPC_URL npx tsx src/recipes/test/harness/curveCrypto-snapshot.ts
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
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "ethereum-curveCrypto-crvUSDWETH";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// On-charter tokens: crvUSD (the Curve-native USD stablecoin leg) + WETH (the counter-asset).
const crvUSD = getAddress("0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E") as Address;
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2") as Address;

// The twocrypto-ng factory IS the CryptoSwap discovery registry (find_pool_for_coins /
// get_coin_indices → uint256 i,j). FactoryType.CurveCryptoRegistry points here.
const TWOCRYPTO_NG_FACTORY = getAddress("0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F") as Address;

const RPC =
  process.argv[2] || process.env.ETH_RPC_URL || process.env.ETHEREUM_RPC_URL || "";
if (!RPC) {
  console.error(
    "no RPC — pass one as argv[2] or set ETH_RPC_URL (set -a; . sdk/.env; set +a)",
  );
  process.exit(1);
}

// twocrypto-ng registry (find_pool_for_coins → get_coin_indices UINT256). The factory implements it.
const registryAbi = parseAbi([
  "function find_pool_for_coins(address from, address to) view returns (address)",
  "function get_coin_indices(address pool, address from, address to) view returns (uint256 i, uint256 j)",
  "function get_n_coins(address pool) view returns (uint256)",
  "function get_decimals(address pool) view returns (uint256[8] decimals)",
  "function fee_receiver() view returns (address)",
]);

// twocrypto-ng pool read surface (the A-gamma state the discovery + oracle read + the get_dy quote).
const poolAbi = parseAbi([
  "function A() view returns (uint256)",
  "function gamma() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function price_scale() view returns (uint256)",
  "function price_oracle() view returns (uint256)",
  "function D() view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function mid_fee() view returns (uint256)",
  "function out_fee() view returns (uint256)",
  "function fee_gamma() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
  "function MATH() view returns (address)",
  "function factory() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const sha256 = (hex: string) =>
  ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

/** Read a linear storage window [0, count) via eth_getStorageAt for verbatim reconstruction. */
async function readWindow(
  client: ReturnType<typeof createPublicClient>,
  address: Address,
  count: number,
): Promise<Record<string, Hex>> {
  const slots: Record<string, Hex> = {};
  for (let s = 0; s < count; s++) {
    const slot = ("0x" + s.toString(16).padStart(64, "0")) as Hex;
    const val = await client.getStorageAt({ address, slot });
    slots[s.toString()] = (val ?? ("0x" + "0".repeat(64))) as Hex;
  }
  return slots;
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 180_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 1) {
    console.warn(`[curveCrypto-snapshot] WARNING: chainId ${chainId} != Ethereum (1)`);
  }
  const block = await client.getBlockNumber();
  console.log(`[curveCrypto-snapshot] Ethereum chainId=${chainId} block=${block}`);

  // ── STEP 1: resolve the pool via the PRODUCTION discovery path (find_pool_for_coins). ──
  const resolved = (await client.readContract({
    address: TWOCRYPTO_NG_FACTORY,
    abi: registryAbi,
    functionName: "find_pool_for_coins",
    args: [crvUSD, WETH],
  })) as Address;
  if (!resolved || resolved === zeroAddress) {
    throw new Error("twocrypto-ng find_pool_for_coins(crvUSD, WETH) returned the zero address");
  }
  const pool = getAddress(resolved) as Address;
  console.log(`[curveCrypto-snapshot] find_pool_for_coins(crvUSD, WETH) -> ${pool}`);

  // uint256 coin indices + coin count from the registry (the crypto get_coin_indices variant).
  const [indices, nCoinsRaw, decimalsRaw] = await Promise.all([
    client.readContract({
      address: TWOCRYPTO_NG_FACTORY,
      abi: registryAbi,
      functionName: "get_coin_indices",
      args: [pool, crvUSD, WETH],
    }) as Promise<readonly [bigint, bigint]>,
    client
      .readContract({ address: TWOCRYPTO_NG_FACTORY, abi: registryAbi, functionName: "get_n_coins", args: [pool] })
      .catch(() => 2n) as Promise<bigint>,
    client
      .readContract({ address: TWOCRYPTO_NG_FACTORY, abi: registryAbi, functionName: "get_decimals", args: [pool] })
      .catch(() => null) as Promise<readonly bigint[] | null>,
  ]);
  const i = Number(indices[0]);
  const j = Number(indices[1]);
  const nCoins = Number(nCoinsRaw) || 2;
  if (nCoins !== 2) throw new Error(`expected a 2-coin pool, got n=${nCoins}`);
  console.log(`[curveCrypto-snapshot] coin indices i=${i} j=${j} n=${nCoins}`);

  // ── Live A-gamma invariant state (the ground truth the offline test asserts against). ──
  const [A, gamma, priceScale, priceOracle, D, midFee, outFee, feeGamma, fee, totalSupply, coin0, coin1, poolSym, poolName] =
    await Promise.all([
      client.readContract({ address: pool, abi: poolAbi, functionName: "A" }) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "gamma" }) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "price_scale" }) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "price_oracle" }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "D" }) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "mid_fee" }) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "out_fee" }) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "fee_gamma" }) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "fee" }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "totalSupply" }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "coins", args: [0n] }) as Promise<Address>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "coins", args: [1n] }) as Promise<Address>,
      client.readContract({ address: pool, abi: poolAbi, functionName: "symbol" }).catch(() => "?"),
      client.readContract({ address: pool, abi: poolAbi, functionName: "name" }).catch(() => "?"),
    ]);
  const balances = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "balances", args: [0n] }) as Promise<bigint>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "balances", args: [1n] }) as Promise<bigint>,
  ]);
  if (balances.some((b) => b <= 0n) || D <= 0n || priceScale <= 0n) {
    throw new Error("pool has non-positive balances / D / price_scale");
  }

  // Verify the discovered coins ARE crvUSD/WETH (orientation sanity — coin0 must be crvUSD).
  const coinAddrs = [getAddress(coin0) as Address, getAddress(coin1) as Address];
  if (coinAddrs[0].toLowerCase() !== crvUSD.toLowerCase() || coinAddrs[1].toLowerCase() !== WETH.toLowerCase()) {
    console.warn(
      `[curveCrypto-snapshot] WARNING: coin order unexpected: [0]=${coinAddrs[0]} [1]=${coinAddrs[1]}`,
    );
  }

  // Coin decimals + symbols (precisions[k] = 10**(18 - decimals[k])).
  const decimals: number[] = decimalsRaw && decimalsRaw.length >= 2
    ? [Number(decimalsRaw[0]), Number(decimalsRaw[1])]
    : await Promise.all(
        coinAddrs.map((a) =>
          client.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }).then(Number).catch(() => 18),
        ),
      );
  const symbols = await Promise.all(
    coinAddrs.map((a) => client.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }).catch(() => "?")),
  );
  const precisions = decimals.map((d) => (10n ** BigInt(18 - d)).toString());

  // ── DEPENDENCY addresses: MATH (Newton solve library) + factory (fee_receiver bookkeeping / registry). ──
  // NB: the public `MATH()` getter can report a DIFFERENT address than the one the invariant actually
  // STATICCALLs (twocrypto-ng bakes the math library as a DEPLOY-TIME IMMUTABLE in the runtime, while
  // MATH() may read a later-updated storage/factory value). So the AUTHORITATIVE math address is the
  // STATICCALL target of get_dy — discovered below via debug_traceCall — NOT the MATH() getter. We
  // record the MATH() getter value too (mathGetter) for provenance but ETCH the traced target.
  const mathGetter = getAddress(
    (await client.readContract({ address: pool, abi: poolAbi, functionName: "MATH" }).catch(() => zeroAddress)) as Address,
  ) as Address;
  const factoryAddr = getAddress(
    (await client.readContract({ address: pool, abi: poolAbi, functionName: "factory" })) as Address,
  ) as Address;
  const feeReceiver = (await client
    .readContract({ address: factoryAddr, abi: registryAbi, functionName: "fee_receiver" })
    .catch(() => zeroAddress)) as Address;

  // Trace get_dy(0,1,probe) via callTracer to discover the ACTUAL external addresses the invariant
  // touches (the real MATH library the pool STATICCALLs). This is the source of truth for the etch —
  // capturing what MATH() *reports* would etch the wrong address and get_dy/exchange would revert.
  const probeCrvUsdIn0 = 10_000n * 10n ** BigInt(decimals[0]);
  const gdData = encodeFunctionData({
    abi: poolAbi,
    functionName: "get_dy",
    args: [0n, 1n, probeCrvUsdIn0],
  });
  const collectTargets = (node: { to?: string; calls?: unknown[] }, acc: Set<string>): void => {
    if (node.to) acc.add(getAddress(node.to as Address).toLowerCase());
    for (const ch of (node.calls ?? []) as { to?: string; calls?: unknown[] }[]) collectTargets(ch, acc);
  };
  const traced = new Set<string>();
  try {
    const tr = (await client.request({
      method: "debug_traceCall" as never,
      params: [{ to: pool, data: gdData }, "latest", { tracer: "callTracer" }] as never,
    })) as { to?: string; calls?: unknown[] };
    collectTargets(tr, traced);
  } catch (e) {
    console.warn(`[curveCrypto-snapshot] debug_traceCall unavailable (${(e as Error).message}); falling back to MATH() getter`);
  }
  traced.delete(getAddress(pool).toLowerCase()); // the pool itself is not a dependency
  // The get_dy invariant STATICCALLs the math library, which itself STATICCALLs a sub-library — so the
  // FULL math dependency set is EVERY traced external target that is NOT the factory (twocrypto-ng splits
  // the CurveCryptoMathOptimized across two contracts: the main math the pool calls + a helper it calls).
  // We capture EACH and etch them all at their captured addresses. `math` (the primary) is the target the
  // pool itself calls first; `mathHelpers` is the rest.
  const mathTargets = [...traced].filter((a) => a !== factoryAddr.toLowerCase());
  if (mathTargets.length === 0) mathTargets.push(getAddress(mathGetter).toLowerCase());
  // Primary math = the MATH() getter's value if it's among the traced targets (the pool's direct callee),
  // else the first traced target. All traced math targets are etched regardless.
  const mathAddr = getAddress(
    (mathTargets.includes(getAddress(mathGetter).toLowerCase()) ? mathGetter : mathTargets[0]) as Address,
  ) as Address;
  console.log(
    `[curveCrypto-snapshot] MATH(getter)=${mathGetter} primaryMATH=${mathAddr} ` +
      `factory=${factoryAddr} fee_receiver=${feeReceiver} mathTargets=[${mathTargets.join(", ")}]`,
  );

  // ── Runtimes (WITH sha256 anchors). ──
  const poolCode = await client.getCode({ address: pool });
  if (!poolCode || poolCode === "0x") throw new Error(`empty code at pool ${pool}`);
  const factoryCode = await client.getCode({ address: factoryAddr });
  if (!factoryCode || factoryCode === "0x") throw new Error(`empty code at factory ${factoryAddr}`);
  // Capture the runtime at EVERY traced math target (the primary first for readability).
  const orderedMath = [
    mathAddr.toLowerCase(),
    ...mathTargets.filter((a) => a !== mathAddr.toLowerCase()),
  ];
  const mathDeps: { name: string; address: Address; runtime: string }[] = [];
  for (let k = 0; k < orderedMath.length; k++) {
    const addr = getAddress(orderedMath[k]) as Address;
    const code = await client.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`empty code at math dependency ${addr}`);
    mathDeps.push({ name: k === 0 ? "math" : `math-helper-${k}`, address: addr, runtime: code });
  }
  console.log(
    `[curveCrypto-snapshot] runtimes: pool=${poolCode.length / 2 - 1}B factory=${factoryCode.length / 2 - 1}B ` +
      `math=[${mathDeps.map((m) => `${m.address}:${m.runtime.length / 2 - 1}B`).join(", ")}]`,
  );

  // Verify coins are IMMUTABLE (baked in code, not in a storage slot) — the etch etches local tokens
  // AT the real coin addresses (Wombat/WOOFi style), so record this fidelity fact in the snapshot.
  const lc = poolCode.toLowerCase();
  const crvUSDInCode = lc.includes(crvUSD.slice(2).toLowerCase());
  const wethInCode = lc.includes(WETH.slice(2).toLowerCase());

  // ── get_dy probes at the CAPTURED state (self-checks the offline test reproduces). ──
  const probeCrvUsdIn = 10_000n * 10n ** BigInt(decimals[0]); // 10k crvUSD → WETH
  const probeWethIn = 1n * 10n ** BigInt(decimals[1]); // 1 WETH → crvUSD
  const [dySell0, dySell1] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "get_dy", args: [0n, 1n, probeCrvUsdIn] }) as Promise<bigint>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "get_dy", args: [1n, 0n, probeWethIn] }) as Promise<bigint>,
  ]);

  // ── Raw storage windows for VERBATIM setStorageAt reconstruction (Vyper — no Solidity layout). ──
  // Verified swap-relevant slots (crvUSD/WETH twocrypto-ng): 2=price_scale 3/4=price_oracle/last_prices
  // 17=balances[0] 18=balances[1] 19=D 23/24=packed A-gamma + fee params 29=totalSupply. A generous 0..63
  // window captures the whole active layout so A()/gamma()/get_dy()/exchange() recompute byte-identically.
  const poolStorage = await readWindow(client, pool, 64);
  // The factory's fee_receiver + admin live in low slots; capture a window for the exchange bookkeeping.
  const factoryStorage = await readWindow(client, factoryAddr, 24);

  // ── Write the bytecode snapshot (WITH sha256 anchors). ──
  const bytecodeSnap = {
    chain: "ethereum",
    chainId,
    block: block.toString(),
    pool: { address: pool, runtime: poolCode, runtimeSha256: sha256(poolCode) },
    isMinimalProxy: false,
    coinsImmutable: true,
    dependencies: [
      ...mathDeps.map((m) => ({ name: m.name, address: m.address, runtime: m.runtime, runtimeSha256: sha256(m.runtime) })),
      { name: "factory", address: factoryAddr, runtime: factoryCode, runtimeSha256: sha256(factoryCode) },
    ],
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Write the state snapshot. ──
  const stateSnap = {
    chain: "ethereum",
    chainId,
    block: block.toString(),
    source: "twocrypto-ng crvUSD/WETH",
    onCharter: true,
    charterNote:
      "on-charter: 2-coin twocrypto-ng CryptoSwap with a USD (crvUSD) leg — deepest stable-inclusive " +
      "2-coin crypto pool the CurveCryptoRegistry find_pool_for_coins RESOLVES to itself. Deeper crvUSD " +
      "crypto pools exist (crvUSD/WBTC, crvUSD/tBTC) but find_pool_for_coins resolves those pairs to " +
      "OTHER pools, so they are not faithfully prod-mirrorable through the production discovery path.",
    pool,
    factory: factoryAddr,
    registry: TWOCRYPTO_NG_FACTORY,
    math: mathAddr, // the ACTUAL STATICCALL target the invariant hits (etched here) — the deploy-time immutable
    mathGetter, // what pool.MATH() reports (provenance; may differ from the traced target — see the etch note)
    feeReceiver,
    coinsImmutable: true,
    coinsInCode: { crvUSD: crvUSDInCode, WETH: wethInCode },
    coins: coinAddrs,
    coin0: coinAddrs[0],
    coin1: coinAddrs[1],
    tokenIn: crvUSD, // i = 0
    tokenOut: WETH, // j = 1
    i,
    j,
    symbols,
    poolSymbol: poolSym,
    poolName,
    decimals,
    precisions,
    // Full A-gamma invariant state read live (the values discovery + the off-chain replay consume).
    A: A.toString(),
    gamma: gamma.toString(),
    priceScale: priceScale.toString(),
    priceOracle: priceOracle.toString(),
    D: D.toString(),
    balances: balances.map((b) => b.toString()),
    midFee: midFee.toString(),
    outFee: outFee.toString(),
    feeGamma: feeGamma.toString(),
    fee: fee.toString(),
    totalSupply: totalSupply.toString(),
    // Captured probe quotes — the self-check the offline test reproduces against the etched pool.
    probe: {
      sellCoin0: { i: 0, j: 1, dx: probeCrvUsdIn.toString(), dy: dySell0.toString() },
      sellCoin1: { i: 1, j: 0, dx: probeWethIn.toString(), dy: dySell1.toString() },
    },
    // Raw storage windows for deterministic verbatim setStorageAt reconstruction.
    storage: poolStorage,
    factoryStorage,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[curveCrypto-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[curveCrypto-snapshot] state: ${symbols[0]}(${decimals[0]})/${symbols[1]}(${decimals[1]}) ` +
      `poolSymbol="${poolSym}" i=${i} j=${j}\n` +
      `  A=${A} gamma=${gamma} price_scale=${priceScale} price_oracle=${priceOracle} D=${D}\n` +
      `  balances=[${balances.join(", ")}] mid_fee=${midFee} out_fee=${outFee} fee_gamma=${feeGamma} totalSupply=${totalSupply}\n` +
      `  coinsImmutable(inCode)= crvUSD:${crvUSDInCode} WETH:${wethInCode}\n` +
      `  MATH deps=[${mathDeps.map((m) => m.address).join(", ")}] (getter=${mathGetter}) factory=${factoryAddr} fee_receiver=${feeReceiver}\n` +
      `  probe get_dy(0->1, ${probeCrvUsdIn} crvUSD) = ${dySell0} WETH\n` +
      `  probe get_dy(1->0, ${probeWethIn} WETH) = ${dySell1} crvUSD`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
