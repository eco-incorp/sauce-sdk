/**
 * One-time capture of a REAL Balancer V2 ComposableStable pool + the canonical Balancer V2 Vault from
 * Ethereum mainnet, so the Balancer prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/solidly-snapshot.ts + harness/dodo-snapshot.ts (the proven pattern): eth_getCode the
 * REAL runtime of every contract the swap/quote path touches into a checked-in bytecode snapshot (WITH
 * sha256 integrity anchors), and the swap-relevant STATE (the pool's StableMath params + the Vault's
 * per-pool token-balance accounting, reconstructed from the exact storage slots) into a state snapshot.
 * Block pinned. The RPC url / key is NEVER persisted — only contract CODE + STATE.
 *
 * WHICH POOL — the deepest on-charter all-stablecoin pool of the two Ethereum ComposableStable venues
 * verified in constants.ts balancerStablePools:
 *   0x8353…Cb2aF  Balancer GHO/USDT/USDC ComposableStable v5  — ~$120k (GHO≈47,433 · USDC≈33,081 ·
 *                 USDT≈39,718), amp A=250, fee 0.05%, bptIndex 1, NO rate providers.  <-- PICKED
 *   0x06Df…1b42  legacy USD Stable Pool (DAI/USDC/USDT)       — ~$35k, and it is an older MetaStable-era
 *                 pool whose getScalingFactors() REVERTS (not a ComposableStable read surface), so it is
 *                 both shallower AND not the ComposableStable path this fixture targets.
 * The picked pool is ON-CHARTER (all three non-BPT tokens are stablecoins: GHO, USDC, USDT) and the
 * deeper of the two. All three registered non-BPT tokens are stablecoins and it has ZERO rate providers
 * (getRateProviders() all address(0)) — so onSwap makes NO external rate-provider call; the whole
 * dependency graph is exactly {Vault, pool}.
 *
 * DEPENDENCY CONTRACTS captured (every contract the engine `_swapBalancerV2` swap path touches):
 *   1. the Balancer V2 Vault runtime at the canonical 0xBA12222222228d8Ba445958a75a0704d566BF2C8 (the
 *      engine hardcodes this address; the pool is registered here and the swap runs Vault.swap(GIVEN_IN)).
 *   2. the ComposableStable pool runtime at its real address (self-contained — NOT a proxy; the whole
 *      swap-relevant StableMath state — amp, scaling factors, swap fee — lives in its own low slots, all
 *      captured verbatim). No rate-provider contracts to capture (there are none).
 *
 * VAULT ACCOUNTING RECONSTRUCTION — the hardest part of this source. The pool is a GENERAL-specialization
 * pool, so its registered token balances live in the Vault's `_generalPoolsBalances`:
 *     mapping(bytes32 poolId => EnumerableMap.IERC20ToBytes32Map)     // outer-mapping base slot = 1
 * Balancer's EnumerableMap.IERC20ToBytes32Map struct (rooted at P = keccak256(poolId . 1)):
 *     P+0  uint256                       _length                 (= number of registered tokens)
 *     P+1  mapping(uint256 => bytes32)   _keys                   token address at keccak(i . (P+1)),
 *                                                                 and the PACKED balance in the NEXT slot
 *                                                                 (keccak(i . (P+1)) + 1)
 *     P+2  mapping(bytes32 => uint256)   _indexes                1-based index at keccak(token . (P+2))
 * The packed balance is Balancer's BalanceAllocation: cash = low 112 bits, managed = next 112 bits,
 * lastChangeBlock = top 32 bits; the registered balance getPoolTokens returns is cash + managed.
 * Pool REGISTRATION is a second poolId-keyed Vault slot at outer base 5 (keccak256(poolId . 5) = 1).
 * We capture ALL of these slots VERBATIM (their exact keys + values), so the offline test etches the
 * Vault runtime and setStorageAt-s them to reconstruct getPoolTokens byte-identically and run the REAL
 * Vault.swap. (Empirically VALIDATED before shipping this script: a plain anvil, Vault+pool etched, these
 * slots set, MintableERC20 etched at each token address + the Vault funded, executes Vault.swap and lands
 * the EXACT queryBatchSwap output to the wei — see the `slots` block below, all self-describing.)
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   ETH_RPC_URL=$ETH_RPC_URL npx tsx src/recipes/test/harness/balancer-snapshot.ts
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
  keccak256,
  encodeAbiParameters,
  toHex,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "ethereum-balancer-GHOUSDCUSDT";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The canonical Balancer V2 Vault (same address on all EVM chains — the engine `_swapBalancerV2`
// hardcodes it) and the deepest on-charter Ethereum ComposableStable pool from constants.ts.
const VAULT = getAddress("0xBA12222222228d8Ba445958a75a0704d566BF2C8") as Address;
const POOL = getAddress("0x8353157092ED8Be69a9DF8F95af097bbF33Cb2aF") as Address; // GHO/USDT/USDC ComposableStable v5

// The Vault outer-mapping base slots (Solidity storage layout of Balancer V2 Vault):
//   _generalPoolsBalances @ slot 1   (mapping(bytes32 => EnumerableMap.IERC20ToBytes32Map))
//   the poolId-keyed pool-registration flag @ slot 5   (keccak(poolId . 5) == 1 for a registered pool)
const GENERAL_POOL_BALANCES_BASE = 1n;
const POOL_REGISTRATION_BASE = 5n;

const RPC =
  process.argv[2] || process.env.ETH_RPC_URL || process.env.ETHEREUM_RPC_URL || "";
if (!RPC) {
  console.error(
    "no RPC — pass one as argv[2] or set ETH_RPC_URL (set -a; . sdk/.env; set +a)",
  );
  process.exit(1);
}

const poolAbi = parseAbi([
  "function getPoolId() view returns (bytes32)",
  "function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)",
  "function getScalingFactors() view returns (uint256[] scalingFactors)",
  "function getSwapFeePercentage() view returns (uint256)",
  "function getBptIndex() view returns (uint256)",
  "function getRateProviders() view returns (address[])",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function version() view returns (string)",
  "function getRate() view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function getPool(bytes32 poolId) view returns (address, uint8)",
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
  "function getAuthorizer() view returns (address)",
  "function getProtocolFeesCollector() view returns (address)",
  // The engine path uses swap(SingleSwap,...); queryBatchSwap is only used here to capture a ground-truth
  // probe the offline test reproduces via the real Vault.swap.
  "struct BatchSwapStep { bytes32 poolId; uint256 assetInIndex; uint256 assetOutIndex; uint256 amount; bytes userData; }",
  "struct FundManagement { address sender; bool fromInternalBalance; address recipient; bool toInternalBalance; }",
  "function queryBatchSwap(uint8 kind, BatchSwapStep[] swaps, address[] assets, FundManagement funds) returns (int256[])",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const sha256 = (hex: string) =>
  ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

// keccak256-based storage slot helpers matching Solidity's mapping layout.
const mapBytes32Key = (key: Hex, mapSlot: bigint) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [key, mapSlot]) as Hex));
const mapUintKey = (key: bigint, mapSlot: bigint) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [key, mapSlot]) as Hex));

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 1) {
    console.warn(`[balancer-snapshot] WARNING: chainId ${chainId} != Ethereum (1)`);
  }
  const block = await client.getBlockNumber();
  console.log(`[balancer-snapshot] Ethereum chainId=${chainId} block=${block}`);

  // ── Pool identity + StableMath params via the pool's own getters (the read surface discovery uses). ──
  const [poolId, ampRaw, scalingRaw, feeRaw, bptIndexRaw, rateProviders, name, symbol, version] =
    await Promise.all([
      client.readContract({ address: POOL, abi: poolAbi, functionName: "getPoolId" }) as Promise<Hex>,
      client.readContract({ address: POOL, abi: poolAbi, functionName: "getAmplificationParameter" }) as Promise<readonly [bigint, boolean, bigint]>,
      client.readContract({ address: POOL, abi: poolAbi, functionName: "getScalingFactors" }) as Promise<readonly bigint[]>,
      client.readContract({ address: POOL, abi: poolAbi, functionName: "getSwapFeePercentage" }) as Promise<bigint>,
      client.readContract({ address: POOL, abi: poolAbi, functionName: "getBptIndex" }) as Promise<bigint>,
      client.readContract({ address: POOL, abi: poolAbi, functionName: "getRateProviders" }) as Promise<readonly Address[]>,
      client.readContract({ address: POOL, abi: poolAbi, functionName: "name" }).catch(() => "?"),
      client.readContract({ address: POOL, abi: poolAbi, functionName: "symbol" }).catch(() => "?"),
      client.readContract({ address: POOL, abi: poolAbi, functionName: "version" }).catch(() => "?"),
    ]);
  const bptIndex = Number(bptIndexRaw);
  console.log(`[balancer-snapshot] pool ${POOL} "${name}" (${symbol}) version=${version}`);
  console.log(`[balancer-snapshot] poolId=${poolId} amp=${ampRaw[0]} fee=${feeRaw} bptIndex=${bptIndex}`);

  // Rate providers MUST be all zero for this fixture's fidelity (else onSwap would call external
  // rate-provider contracts we'd have to capture too). Flag loudly if that ever changes.
  const nonZeroProviders = rateProviders.filter((p) => BigInt(p) !== 0n);
  if (nonZeroProviders.length > 0) {
    console.warn(
      `[balancer-snapshot] WARNING: pool has ${nonZeroProviders.length} NON-ZERO rate provider(s) ` +
        `${JSON.stringify(nonZeroProviders)} — onSwap will call them; capture their runtime + rate-cache ` +
        `slots too, or the offline swap will diverge/revert.`,
    );
  }

  // Vault specialization (must be 0 = GENERAL for the _generalPoolsBalances layout below).
  const [poolAddrFromVault, specialization] = (await client.readContract({
    address: VAULT, abi: vaultAbi, functionName: "getPool", args: [poolId],
  })) as [Address, number];
  if (getAddress(poolAddrFromVault) !== POOL) {
    throw new Error(`Vault.getPool(poolId) ${poolAddrFromVault} != pool ${POOL}`);
  }
  if (specialization !== 0) {
    throw new Error(
      `pool specialization ${specialization} != GENERAL(0) — the _generalPoolsBalances slot layout in ` +
        `this script only applies to GENERAL pools`,
    );
  }

  // ── Registered tokens + balances from the Vault (INCLUDING the BPT at bptIndex). ──
  const [tokens, balances, lastChangeBlock] = (await client.readContract({
    address: VAULT, abi: vaultAbi, functionName: "getPoolTokens", args: [poolId],
  })) as readonly [readonly Address[], readonly bigint[], bigint];
  if (tokens.length !== scalingRaw.length) {
    throw new Error(`token count ${tokens.length} != scalingFactors count ${scalingRaw.length}`);
  }

  const tokenMeta: { address: Address; symbol: string; decimals: number; isBpt: boolean }[] = [];
  let depthUsd = 0;
  for (let k = 0; k < tokens.length; k++) {
    const isBpt = k === bptIndex;
    const [dec, sym] = await Promise.all([
      client.readContract({ address: tokens[k], abi: erc20Abi, functionName: "decimals" }).then(Number).catch(() => 18),
      client.readContract({ address: tokens[k], abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    ]);
    tokenMeta.push({ address: getAddress(tokens[k]), symbol: sym as string, decimals: dec, isBpt });
    if (!isBpt) depthUsd += Number(balances[k]) / 10 ** dec;
    console.log(
      `  tok[${k}] ${tokens[k]} ${sym} dec=${dec} bal=${balances[k]}${isBpt ? " <BPT>" : ` (~$${(Number(balances[k]) / 10 ** dec).toFixed(0)})`}`,
    );
  }
  console.log(`[balancer-snapshot] ~depthUSD (non-BPT) = $${depthUsd.toFixed(0)}`);

  // ── Bytecode: the Vault runtime + the pool runtime (both self-contained; the pool is NOT a proxy). ──
  const vaultCode = await client.getCode({ address: VAULT });
  if (!vaultCode || vaultCode === "0x") throw new Error(`empty code at Vault ${VAULT}`);
  const poolCode = await client.getCode({ address: POOL });
  if (!poolCode || poolCode === "0x") throw new Error(`empty code at pool ${POOL}`);
  console.log(
    `[balancer-snapshot] vault runtime = ${vaultCode.length / 2 - 1} bytes; pool runtime = ${poolCode.length / 2 - 1} bytes`,
  );

  // ── Pool storage window (verbatim). The StableMath state (amp/scaling/fee + name/symbol) is dense in
  //    the low slots (empirically slots 2..13); capture 0..31 with margin for deterministic setStorageAt. ──
  const poolStorage: Record<string, Hex> = {};
  for (let i = 0; i < 32; i++) {
    const slot = toHex(BigInt(i), { size: 32 }) as Hex;
    poolStorage[i.toString()] = (await client.getStorageAt({ address: POOL, slot })) ?? (("0x" + "0".repeat(64)) as Hex);
  }

  // ── Vault accounting slots (verbatim, keyed by their ABSOLUTE storage key). These reconstruct
  //    getPoolTokens + the pool registration so the etched Vault runs Vault.swap offline. ──
  const P = mapBytes32Key(poolId, GENERAL_POOL_BALANCES_BASE); // EnumerableMap struct root
  const vaultSlots: Record<string, Hex> = {};
  const capV = async (slot: bigint, note: string) => {
    const key = toHex(slot, { size: 32 }) as Hex;
    const val = (await client.getStorageAt({ address: VAULT, slot: key })) ?? (("0x" + "0".repeat(64)) as Hex);
    vaultSlots[key] = val;
    return { note, key, val };
  };
  const captured: { note: string; key: Hex; val: Hex }[] = [];
  captured.push(await capV(P, "_generalPoolsBalances[poolId]._length"));
  captured.push(await capV(mapBytes32Key(poolId, POOL_REGISTRATION_BASE), "pool registration flag (base 5)"));
  for (let i = 0n; i < BigInt(tokens.length); i++) {
    const ks = mapUintKey(i, P + 1n); // _keys[i] slot; balance packed at ks+1
    captured.push(await capV(ks, `_keys[${i}] (token address)`));
    captured.push(await capV(ks + 1n, `_keys[${i}] packed BalanceAllocation (cash|managed|lastChangeBlock)`));
    captured.push(await capV(mapUintKey(BigInt(tokens[i]), P + 2n), `_indexes[token[${i}]] (1-based)`));
  }
  console.log(`[balancer-snapshot] captured ${Object.keys(vaultSlots).length} Vault storage slots for this pool`);

  // ── Ground-truth probe quote (the self-check the offline test reproduces via the REAL Vault.swap). ──
  // Pick two non-BPT stablecoins for the probe: the first two non-BPT tokens.
  const nonBpt = tokenMeta.filter((t) => !t.isBpt);
  const probeIn = nonBpt[0];
  const probeOut = nonBpt[1];
  const probeAmountIn = 100_000n * 10n ** BigInt(probeIn.decimals);
  const assets = [probeIn.address, probeOut.address];
  const deltas = (await client.readContract({
    address: VAULT,
    abi: vaultAbi,
    functionName: "queryBatchSwap",
    args: [
      0,
      [{ poolId, assetInIndex: 0n, assetOutIndex: 1n, amount: probeAmountIn, userData: "0x" }],
      assets,
      { sender: POOL, fromInternalBalance: false, recipient: POOL, toInternalBalance: false },
    ],
  })) as readonly bigint[];
  const probeAmountOut = -deltas[1];
  console.log(
    `[balancer-snapshot] probe queryBatchSwap(100000 ${probeIn.symbol}) = ${probeAmountOut} ${probeOut.symbol}`,
  );

  // Vault authorizer / protocol-fees collector (informational — not needed for the offline swap, but
  // recorded so a reviewer can see the swap path's peripheral contracts).
  const [authorizer, protocolFeesCollector] = await Promise.all([
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "getAuthorizer" }).catch(() => "?"),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "getProtocolFeesCollector" }).catch(() => "?"),
  ]);

  // ── Write the bytecode snapshot (WITH sha256 anchors). ──
  const bytecodeSnap = {
    chain: "ethereum",
    block: block.toString(),
    // The pool is the "primary" contract; the Vault is a captured dependency (the swap runs on both).
    pool: { address: POOL, runtime: poolCode, runtimeSha256: sha256(poolCode) },
    isMinimalProxy: false,
    dependencies: [
      { name: "balancerV2Vault", address: VAULT, runtime: vaultCode, runtimeSha256: sha256(vaultCode) },
    ],
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Write the state snapshot. ──
  const stateSnap = {
    chain: "ethereum",
    block: block.toString(),
    vault: VAULT,
    pool: POOL,
    poolId,
    poolName: name,
    poolSymbol: symbol,
    poolVersion: version,
    specialization, // 0 = GENERAL
    authorizer,
    protocolFeesCollector,
    // StableMath params (the discovery / off-chain replay read these).
    amp: ampRaw[0].toString(), // A·AMP_PRECISION (=250·1000)
    ampPrecision: ampRaw[2].toString(),
    swapFeeWad: feeRaw.toString(),
    bptIndex,
    scalingFactors: scalingRaw.map((s) => s.toString()),
    rateProviders: rateProviders.map((p) => getAddress(p)),
    lastChangeBlock: lastChangeBlock.toString(),
    // Registered tokens (INCLUDING the BPT at bptIndex), balances aligned by index.
    tokens: tokenMeta.map((t, k) => ({
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      isBpt: t.isBpt,
      balance: balances[k].toString(),
    })),
    // The Vault accounting layout so the offline harness can re-derive the slots (and a reviewer can
    // audit them) WITHOUT re-reading the chain.
    vaultLayout: {
      generalPoolBalancesBase: Number(GENERAL_POOL_BALANCES_BASE),
      poolRegistrationBase: Number(POOL_REGISTRATION_BASE),
      enumerableMapStructRoot: toHex(P, { size: 32 }),
      note:
        "P = keccak256(poolId . 1). _length@P, _keys[i]@keccak(i.(P+1)) with the packed BalanceAllocation " +
        "at keccak(i.(P+1))+1 (cash=low112|managed=next112|lastChangeBlock=top32; balance=cash+managed), " +
        "_indexes[token]@keccak(token.(P+2)) (1-based). Registration flag@keccak(poolId . 5)=1.",
    },
    // Every Vault slot captured verbatim (absolute storage key -> value) — set these on the etched Vault.
    vaultSlots,
    // A human-readable annotation of each captured Vault slot (parallel to vaultSlots).
    vaultSlotNotes: captured.map((c) => ({ key: c.key, value: c.val, note: c.note })),
    // Pool storage window 0..31, verbatim (set these on the etched pool).
    poolStorage,
    // Captured probe (the self-check the offline test reproduces via the REAL Vault.swap, wei-exact).
    probe: {
      tokenIn: probeIn.address,
      tokenInSymbol: probeIn.symbol,
      tokenOut: probeOut.address,
      tokenOutSymbol: probeOut.symbol,
      amountIn: probeAmountIn.toString(),
      amountOut: probeAmountOut.toString(),
    },
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[balancer-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[balancer-snapshot] state: ${symbol} amp=${ampRaw[0]}(A=${ampRaw[0] / ampRaw[2]}) fee=${feeRaw} bptIndex=${bptIndex}\n` +
      `  tokens=${tokenMeta.map((t) => `${t.symbol}${t.isBpt ? "(BPT)" : ""}`).join("/")} depth≈$${depthUsd.toFixed(0)}\n` +
      `  probe: 100000 ${probeIn.symbol} -> ${probeAmountOut} ${probeOut.symbol}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
