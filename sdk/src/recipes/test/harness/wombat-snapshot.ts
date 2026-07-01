/**
 * One-time capture of the REAL Wombat Main Pool (single-sided stableswap) from BSC mainnet,
 * so the Wombat prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Wombat is a MULTI-ASSET singleton: the Pool (an EIP-1967 transparent proxy → logic impl)
 * holds NO tokens itself; each token's reserve lives in a per-token ASSET contract (cash +
 * liability, both WAD, packed in one storage slot). A tokenIn→tokenOut swap touches, in full:
 *
 *   Pool proxy  0x312Bc7…  (delegatecalls the impl; storage on the proxy)
 *     slot 202 ampFactor (WAD)   slot 203 haircutRate (WAD)
 *     slot 264 startCovRatio(low128) | endCovRatio(high128)   slot 0 reentrancy guard
 *     mapping _assets[token] at keccak256(abi.encode(token, 212))  → the token's Asset address
 *   Pool impl   0x3421…     (the delegatecall logic; storage-less, etched at its address)
 *   Asset(from) 0xb43E…     slot 8 = cash(low120) | liability(bits120-239); HOLDS the underlying ERC20
 *   Asset(to)   0x4F95…     slot 8 = cash | liability; HOLDS the underlying ERC20
 *
 * IMPORTANT — the Asset's `underlyingToken`/`decimals` are IMMUTABLES baked into the Asset
 * bytecode (not storage), so the offline test CANNOT repoint them via setStorageAt: it must
 * etch a local MintableERC20 AT THE REAL underlying token address (the same immutable-address
 * constraint the repo already handles for Uniswap-V4 StateView→PoolManager). We therefore
 * record the real underlying token addresses + decimals so the test etches tokens there.
 *
 * Captures, into two checked-in snapshots (WITH sha256 integrity anchors, mirroring
 * harness/solidly-snapshot.ts):
 *   fixtures/snapshots/bsc-wombat-USDCUSDT.bytecode.json — the REAL runtime of the Pool proxy,
 *     the Pool impl, and BOTH Asset contracts (eth_getCode each).
 *   fixtures/snapshots/bsc-wombat-USDCUSDT.state.json    — the swap-relevant STATE: ampFactor,
 *     haircutRate, cov-ratios, the two _assets[token] mapping slots + values, each Asset's raw
 *     storage window (cash/liability slot 8 etc.), decimals, and quotePotentialSwap probes.
 *
 * The deepest on-charter stable pair (BSC baseTokens USDC + USDT, see shared/constants.ts) that
 * the wired FactoryType.Wombat pool 0x312Bc7… serves — verified real (code + reserves + params).
 *
 * NEVER persists the RPC url / API key — only contract code + on-chain state.
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   BSC_RPC_URL=$BSC_RPC_URL npx tsx src/recipes/test/harness/wombat-snapshot.ts
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
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const BYTECODE_OUT = join(SNAP_DIR, "bsc-wombat-USDCUSDT.bytecode.json");
const STATE_OUT = join(SNAP_DIR, "bsc-wombat-USDCUSDT.state.json");

// BSC baseTokens + the wired FactoryType.Wombat Main Pool (see shared/constants.ts `bsc`).
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address; // Binance-Peg USDC, 18 dec
const USDT = "0x55d398326f99059fF775485246999027B3197955" as Address; // BSC-USD (USDT), 18 dec
const WOMBAT_MAIN_POOL = "0x312Bc7eAAF93f1C60Dc5AfC115FcCDE161055fb0" as Address;

// Storage layout (verified on-chain via cast access-list + slot scan against the pinned block):
//   Pool proxy: slot 202 ampFactor, slot 203 haircutRate, slot 264 covRatios, slot 0 reentrancy,
//               mapping _assets[token] base slot 212.
//   Asset:      slot 8 packs cash(uint120, low 120 bits) | liability(uint120, bits 120..239).
const POOL_AMP_SLOT = 202n;
const POOL_HAIRCUT_SLOT = 203n;
const POOL_COVRATIO_SLOT = 264n;
const POOL_GUARD_SLOT = 0n;
const POOL_ASSETS_MAP_BASE = 212n;
const ASSET_CASHLIAB_SLOT = 8n;

// EIP-1967 impl slot (bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)).
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

const RPC =
  process.argv[2] || process.env.BSC_RPC_URL || process.env.BSC_RPC || "";
if (!RPC) {
  console.error(
    "no RPC — pass one as argv[2] or set BSC_RPC_URL (set -a; . sdk/.env; set +a)",
  );
  process.exit(1);
}

const poolAbi = parseAbi([
  "function addressOfAsset(address token) view returns (address)",
  "function ampFactor() view returns (uint256)",
  "function haircutRate() view returns (uint256)",
  "function startCovRatio() view returns (uint256)",
  "function endCovRatio() view returns (uint256)",
  "function quotePotentialSwap(address fromToken, address toToken, int256 fromAmount) view returns (uint256 potentialOutcome, uint256 haircut)",
]);
const assetAbi = parseAbi([
  "function cash() view returns (uint256)",
  "function liability() view returns (uint256)",
  "function underlyingToken() view returns (address)",
  "function decimals() view returns (uint8)",
  "function underlyingTokenDecimals() view returns (uint8)",
  "function pool() view returns (address)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

const sha256 = (hex: string) =>
  ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

/** keccak256(abi.encode(token, baseSlot)) — the mapping(address=>…) storage slot. */
function assetsMapSlot(token: Address, base: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [getAddress(token), base],
    ),
  );
}

function slotHex(i: bigint): Hex {
  return pad(toHex(i), { size: 32 }) as Hex;
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 56) {
    console.warn(`[wombat-snapshot] WARNING: chainId ${chainId} != BSC (56)`);
  }
  const block = await client.getBlockNumber();
  console.log(`[wombat-snapshot] BSC chainId=${chainId} block=${block}`);

  const pool = WOMBAT_MAIN_POOL;

  // ── Resolve the per-token Asset contracts (both must exist for the pair to trade). ──
  const [assetUsdc, assetUsdt] = (await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "addressOfAsset", args: [USDC] }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "addressOfAsset", args: [USDT] }),
  ])) as [Address, Address];
  if (!assetUsdc || BigInt(assetUsdc) === 0n) throw new Error("addressOfAsset(USDC) == 0");
  if (!assetUsdt || BigInt(assetUsdt) === 0n) throw new Error("addressOfAsset(USDT) == 0");
  console.log(`[wombat-snapshot] assets: USDC→${assetUsdc}  USDT→${assetUsdt}`);

  // ── REAL runtime: Pool proxy + its EIP-1967 impl + BOTH Asset contracts. ──
  const poolCode = await client.getCode({ address: pool });
  if (!poolCode || poolCode === "0x") throw new Error(`empty code at pool ${pool}`);
  const implSlotVal = (await client.getStorageAt({ address: pool, slot: EIP1967_IMPL_SLOT }))!;
  const impl = getAddress(("0x" + implSlotVal.slice(-40)) as Hex) as Address;
  const implCode = await client.getCode({ address: impl });
  if (!implCode || implCode === "0x") throw new Error(`empty code at pool impl ${impl}`);
  const assetUsdcCode = await client.getCode({ address: assetUsdc });
  const assetUsdtCode = await client.getCode({ address: assetUsdt });
  if (!assetUsdcCode || assetUsdcCode === "0x") throw new Error(`empty code at USDC asset ${assetUsdc}`);
  if (!assetUsdtCode || assetUsdtCode === "0x") throw new Error(`empty code at USDT asset ${assetUsdt}`);
  console.log(
    `[wombat-snapshot] runtimes: proxy ${poolCode.length / 2 - 1} B → impl ${impl} ` +
      `(${implCode.length / 2 - 1} B); assetUSDC ${assetUsdcCode.length / 2 - 1} B; ` +
      `assetUSDT ${assetUsdtCode.length / 2 - 1} B`,
  );

  // ── Swap-relevant STATE via the pool's/assets' own getters (ground truth). ──
  const [amp, haircut, startCov, endCov] = (await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "ampFactor" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "haircutRate" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "startCovRatio" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "endCovRatio" }),
  ])) as [bigint, bigint, bigint, bigint];

  const readAsset = async (asset: Address) => {
    const [cash, liability, underlying, dec, underlyingDec] = (await Promise.all([
      client.readContract({ address: asset, abi: assetAbi, functionName: "cash" }),
      client.readContract({ address: asset, abi: assetAbi, functionName: "liability" }),
      client.readContract({ address: asset, abi: assetAbi, functionName: "underlyingToken" }),
      client.readContract({ address: asset, abi: assetAbi, functionName: "decimals" }),
      client.readContract({ address: asset, abi: assetAbi, functionName: "underlyingTokenDecimals" }),
    ])) as [bigint, bigint, Address, number, number];
    // The Asset HOLDS the underlying ERC20; capture that balance so the test funds it identically.
    const underlyingBal = (await client.readContract({
      address: underlying, abi: erc20Abi, functionName: "balanceOf", args: [asset],
    })) as bigint;
    // Raw storage window (0..40 covers owner/ERC20/name/symbol/pool + the packed cash|liability at 8).
    const storage: Record<string, Hex> = {};
    for (let i = 0; i <= 40; i++) {
      const v = await client.getStorageAt({ address: asset, slot: slotHex(BigInt(i)) });
      storage[i.toString()] = (v ?? slotHex(0n)) as Hex;
    }
    return { cash, liability, underlying, dec, underlyingDec, underlyingBal, storage };
  };
  const [aUsdc, aUsdt] = await Promise.all([readAsset(assetUsdc), readAsset(assetUsdt)]);

  // The two _assets[token] mapping slots (so the etched proxy resolves addressOfAsset).
  const usdcMapSlot = assetsMapSlot(USDC, POOL_ASSETS_MAP_BASE);
  const usdtMapSlot = assetsMapSlot(USDT, POOL_ASSETS_MAP_BASE);
  const [usdcMapVal, usdtMapVal, guardVal, covRatioRaw] = await Promise.all([
    client.getStorageAt({ address: pool, slot: usdcMapSlot }),
    client.getStorageAt({ address: pool, slot: usdtMapSlot }),
    client.getStorageAt({ address: pool, slot: slotHex(POOL_GUARD_SLOT) }),
    client.getStorageAt({ address: pool, slot: slotHex(POOL_COVRATIO_SLOT) }),
  ]);

  // A generous Pool proxy storage window (0..270) for deterministic reconstruction — captures the
  // reentrancy guard, amp(202)/haircut(203)/covRatio(264) and any packed neighbours. The two hashed
  // _assets slots are captured separately (they live outside the linear window).
  const poolStorage: Record<string, Hex> = {};
  for (let i = 0; i <= 270; i++) {
    const v = await client.getStorageAt({ address: pool, slot: slotHex(BigInt(i)) });
    if (v && v !== slotHex(0n)) poolStorage[i.toString()] = v as Hex;
  }

  // Token decimals (the WAD↔native scaling — 18/18 for BSC Binance-Peg USDC/USDT).
  const [decUsdc, decUsdt] = (await Promise.all([
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: USDT, abi: erc20Abi, functionName: "decimals" }),
  ])) as [number, number];

  // quotePotentialSwap probes at the captured state — self-checks the offline test reproduces.
  const probeIn = 5_000n * 10n ** BigInt(decUsdc); // 5000 USDC in (USDC→USDT; the deep-payout side)
  const [probeOut, probeHaircut] = (await client.readContract({
    address: pool, abi: poolAbi, functionName: "quotePotentialSwap", args: [USDC, USDT, probeIn],
  })) as [bigint, bigint];

  // ── Write the snapshots (bytecode + state), with sha256 integrity anchors. ──
  const bytecodeSnap = {
    chain: "bsc",
    chainId,
    block: block.toString(),
    pool: { address: pool, runtime: poolCode, runtimeSha256: sha256(poolCode) },
    implementation: { address: impl, runtime: implCode, runtimeSha256: sha256(implCode) },
    isMinimalProxy: false, // EIP-1967 transparent proxy (not an EIP-1167 clone)
    assets: {
      [USDC.toLowerCase()]: {
        address: assetUsdc,
        runtime: assetUsdcCode,
        runtimeSha256: sha256(assetUsdcCode),
      },
      [USDT.toLowerCase()]: {
        address: assetUsdt,
        runtime: assetUsdtCode,
        runtimeSha256: sha256(assetUsdtCode),
      },
    },
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  const stateSnap = {
    chain: "bsc",
    chainId,
    block: block.toString(),
    pool,
    implementation: impl,
    // Underlying tokens — their `underlyingToken` is an Asset IMMUTABLE, so the test etches local
    // MintableERC20s AT THESE ADDRESSES (immutable-address constraint).
    tokenUSDC: USDC,
    tokenUSDT: USDT,
    decimalsUSDC: decUsdc,
    decimalsUSDT: decUsdt,
    // Pool-wide params.
    ampFactor: amp.toString(),
    haircutRate: haircut.toString(),
    startCovRatio: startCov.toString(),
    endCovRatio: endCov.toString(),
    // Pool storage: the reentrancy guard, the amp/haircut/covRatio slots (echoed for provenance),
    // the raw linear window, and the two hashed _assets[token] mapping slots.
    poolSlots: {
      ampFactor: { slot: POOL_AMP_SLOT.toString(), value: slotHex(amp) },
      haircutRate: { slot: POOL_HAIRCUT_SLOT.toString(), value: slotHex(haircut) },
      covRatio: { slot: POOL_COVRATIO_SLOT.toString(), value: (covRatioRaw ?? slotHex(0n)) as Hex },
      reentrancyGuard: { slot: POOL_GUARD_SLOT.toString(), value: (guardVal ?? slotHex(0n)) as Hex },
    },
    assetsMap: {
      [USDC.toLowerCase()]: { slot: usdcMapSlot, value: (usdcMapVal ?? slotHex(0n)) as Hex, asset: assetUsdc },
      [USDT.toLowerCase()]: { slot: usdtMapSlot, value: (usdtMapVal ?? slotHex(0n)) as Hex, asset: assetUsdt },
    },
    poolStorage,
    // Per-Asset state (cash/liability WAD, underlying + held balance, decimals, raw slot window).
    assetUSDC: {
      address: assetUsdc,
      cash: aUsdc.cash.toString(),
      liability: aUsdc.liability.toString(),
      underlyingToken: aUsdc.underlying,
      underlyingBalance: aUsdc.underlyingBal.toString(),
      lpDecimals: aUsdc.dec,
      underlyingDecimals: aUsdc.underlyingDec,
      cashLiabSlot: ASSET_CASHLIAB_SLOT.toString(),
      storage: aUsdc.storage,
    },
    assetUSDT: {
      address: assetUsdt,
      cash: aUsdt.cash.toString(),
      liability: aUsdt.liability.toString(),
      underlyingToken: aUsdt.underlying,
      underlyingBalance: aUsdt.underlyingBal.toString(),
      lpDecimals: aUsdt.dec,
      underlyingDecimals: aUsdt.underlyingDec,
      cashLiabSlot: ASSET_CASHLIAB_SLOT.toString(),
      storage: aUsdt.storage,
    },
    // quotePotentialSwap probe (5000 USDC → USDT) at the captured state.
    probe: {
      fromToken: USDC,
      toToken: USDT,
      amountIn: probeIn.toString(),
      amountOut: probeOut.toString(),
      haircut: probeHaircut.toString(),
    },
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[wombat-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[wombat-snapshot] state: amp=${amp} haircut=${haircut} startCov=${startCov} endCov=${endCov}\n` +
      `  assetUSDC ${assetUsdc}: cash=${aUsdc.cash} liab=${aUsdc.liability} held=${aUsdc.underlyingBal}\n` +
      `  assetUSDT ${assetUsdt}: cash=${aUsdt.cash} liab=${aUsdt.liability} held=${aUsdt.underlyingBal}\n` +
      `  probe quotePotentialSwap(5000 USDC → USDT) = ${probeOut} (haircut ${probeHaircut})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
