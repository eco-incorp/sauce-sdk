/**
 * PancakeSwap INFINITY CL prod snapshot capturer (RPC-gated, standalone).
 *
 *   BSC_RPC_URL=<url> npx tsx src/recipes/test/harness/infinity-snapshot.ts
 *
 * Captures TWO checked-in artifacts for the Infinity prod-mirror lane:
 *
 * 1. `fixtures/snapshots/infinity-bytecode.json` — the GENUINE deployed runtime of the three
 *    singletons at their canonical (create3 — same on BSC/Base) addresses: Vault, CLPoolManager,
 *    CLTickLens — plus the TWO storage-slot indices the etch harness needs to re-animate the
 *    fresh-storage runtime (both LOCATED BY SCANNING the real BSC storage, never hardcoded):
 *      · vaultIsAppRegisteredSlot — the Vault's `mapping(address app => bool)` base slot (the
 *        etch pokes `isAppRegistered[CLPM] = true`; registerApp is onlyOwner and the etched
 *        owner slot is empty).
 *      · clpmProtocolFeeControllerSlot — the CLPoolManager slot holding the protocolFeeController
 *        address (the prod-mirror pokes a test EOA there, then calls the REAL
 *        setProtocolFee(key, fee) to reproduce the live packed 12+12 protocol fee through the
 *        genuine code path).
 *
 * 2. `fixtures/snapshots/bsc-infinity-<pair>-<fee>.json` — the REAL USDT/Beat pool state (the
 *    venue's #1 TVL pool, hookless static-fee ts=1): slot0 (incl. protocolFee + lpFee words),
 *    active liquidity, the recovered 6-field PoolKey (poolIdToPoolKey — the reverse-verification
 *    getter), and the initialized-tick profile read via CLTickLens.getPopulatedTicksInWord over
 *    a word window around the live tick (±WORD_WINDOW words = ±(256·WORD_WINDOW) compressed
 *    ticks — ts=1 ⇒ raw ticks — comfortably wider than the lens's 256-boundary band).
 *
 * The snapshot reuses the V4 `ProdV4Snapshot` shape (deriveSegments applies unchanged) plus the
 * Infinity key/fee words.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  getAddress,
  keccak256,
  encodeAbiParameters,
  type PublicClient,
  type Hex,
} from "viem";

import { MULTICALL3 } from "../../shared/constants";
import type { ProdV4Snapshot } from "./v4-snapshot";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "fixtures", "snapshots");

// Canonical BSC (== Base, create3) Infinity addresses — cross-verified in the 2026-07-04 probe
// (Vault.isAppRegistered(CLPM) true, CLPM.vault() == Vault, TickLens reads live).
export const INFINITY_VAULT = "0x238a358808379702088667322f80aC48bAd5e6c4" as Hex;
export const INFINITY_CL_POOL_MANAGER = "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b" as Hex;
export const INFINITY_CL_TICK_LENS = "0x8BcF30285413F25032fb983C2bF4deFe29a33f3a" as Hex;

// The venue's #1 TVL pool: USDT/Beat, fee 67 static, ts 1, HOOKLESS (poolId keccak-reproduced).
const USDT_BEAT_POOL_ID = "0xb2842060d68177ff202e81b3bd8588630fe7ede60e1a19f4d327125f73ae92be" as Hex;
// ± words of populated ticks around the live tick's word. USDT/Beat's real profile is SPARSE —
// 31 initialized boundaries spread across words −77..+2 (live word −39 at capture) — so the
// window must span the WHOLE book: ±60 words = ±15360 compressed ticks (ts=1 ⇒ raw ticks,
// ≈ ±365% in price), 121 TickLens calls.
const WORD_WINDOW = 60;

/** Infinity prod snapshot: the V4 shape + the live fee words + the packed parameters. */
export interface ProdInfinitySnapshot extends ProdV4Snapshot {
  /** The 12+12-packed per-direction protocol fee (slot0 word [2]) — reproduced via the real
   *  setProtocolFee through the poked controller slot. */
  protocolFee: number;
  /** The static lpFee (slot0 word [3]; == the key fee for a static-fee pool). */
  lpFee: number;
  /** The key's packed `parameters` bytes32 (tickSpacing<<16, hookless bitmap 0). */
  parameters: Hex;
}

/** The etch-side singleton bytecode + re-animation slot indices. */
export interface InfinityBytecodeSnapshot {
  chainId: number;
  vault: { address: Hex; runtime: Hex };
  clPoolManager: { address: Hex; runtime: Hex };
  clTickLens: { address: Hex; runtime: Hex };
  /** Vault `mapping(address app => bool isAppRegistered)` base slot (scanned, not hardcoded). */
  vaultIsAppRegisteredSlot: number;
  /** CLPoolManager slot holding the protocolFeeController address (scanned). */
  clpmProtocolFeeControllerSlot: number;
}

const clpmAbi = parseAbi([
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 id) view returns (uint128)",
  "function poolIdToPoolKey(bytes32 id) view returns (address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)",
  "function protocolFeeController() view returns (address)",
]);
const tickLensAbi = parseAbi([
  "struct PopulatedTick { int24 tick; int128 liquidityNet; uint128 liquidityGross; }",
  "function getPopulatedTicksInWord(bytes32 id, int16 tickBitmapIndex) view returns (PopulatedTick[] populatedTicks)",
]);
const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

async function makeClient(rpcUrl: string): Promise<PublicClient> {
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
  const chain = defineChain({
    id: chainId,
    name: "Snapshot Source",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  return createPublicClient({ chain, transport: http(rpcUrl, { timeout: 120_000 }) }) as PublicClient;
}

async function symbolOf(client: PublicClient, token: Hex): Promise<{ symbol: string; decimals: number }> {
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
    ]);
    return { symbol, decimals: Number(decimals) };
  } catch {
    return { symbol: token.slice(2, 6).toUpperCase(), decimals: 18 };
  }
}

/** Scan the Vault's plain slots for the isAppRegistered mapping base (value 1 under CLPM key). */
async function findVaultAppSlot(client: PublicClient): Promise<number> {
  for (let slot = 0; slot <= 30; slot++) {
    const key = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [INFINITY_CL_POOL_MANAGER, BigInt(slot)],
      ),
    );
    const v = await client.getStorageAt({ address: INFINITY_VAULT, slot: key });
    if (v && BigInt(v) === 1n) return slot;
  }
  throw new Error("infinity-snapshot: Vault isAppRegistered slot not found in slots 0..30");
}

/** Scan the CLPM's plain slots for the one holding the LIVE protocolFeeController address. */
async function findClpmControllerSlot(client: PublicClient): Promise<number> {
  const controller = (await client.readContract({
    address: INFINITY_CL_POOL_MANAGER, abi: clpmAbi, functionName: "protocolFeeController",
  })) as Hex;
  for (let slot = 0; slot <= 30; slot++) {
    const v = await client.getStorageAt({
      address: INFINITY_CL_POOL_MANAGER,
      slot: ("0x" + slot.toString(16)) as Hex,
    });
    if (v && BigInt(v) === BigInt(controller)) return slot;
  }
  throw new Error("infinity-snapshot: CLPM protocolFeeController slot not found in slots 0..30");
}

async function main(): Promise<void> {
  const rpcUrl = process.env.BSC_RPC_URL;
  if (!rpcUrl) {
    console.error("infinity-snapshot: BSC_RPC_URL not set.");
    process.exit(0);
    return;
  }
  const client = await makeClient(rpcUrl);
  const chainId = await client.getChainId();

  // ── 1. Singleton bytecode + re-animation slots ──
  const [vaultCode, clpmCode, lensCode, vaultAppSlot, controllerSlot] = await Promise.all([
    client.getCode({ address: INFINITY_VAULT }),
    client.getCode({ address: INFINITY_CL_POOL_MANAGER }),
    client.getCode({ address: INFINITY_CL_TICK_LENS }),
    findVaultAppSlot(client),
    findClpmControllerSlot(client),
  ]);
  if (!vaultCode || !clpmCode || !lensCode) throw new Error("missing singleton code on chain");

  const bytecodeSnap: InfinityBytecodeSnapshot = {
    chainId,
    vault: { address: INFINITY_VAULT, runtime: vaultCode },
    clPoolManager: { address: INFINITY_CL_POOL_MANAGER, runtime: clpmCode },
    clTickLens: { address: INFINITY_CL_TICK_LENS, runtime: lensCode },
    vaultIsAppRegisteredSlot: vaultAppSlot,
    clpmProtocolFeeControllerSlot: controllerSlot,
  };
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const bytecodeFile = join(SNAPSHOT_DIR, "infinity-bytecode.json");
  writeFileSync(bytecodeFile, JSON.stringify(bytecodeSnap, null, 2) + "\n");
  console.log(
    `infinity-snapshot: wrote ${bytecodeFile}\n  vault ${(vaultCode.length - 2) / 2}B, ` +
      `clpm ${(clpmCode.length - 2) / 2}B, ticklens ${(lensCode.length - 2) / 2}B, ` +
      `appSlot=${vaultAppSlot}, controllerSlot=${controllerSlot}`,
  );

  // ── 2. USDT/Beat pool state ──
  const key = (await client.readContract({
    address: INFINITY_CL_POOL_MANAGER, abi: clpmAbi, functionName: "poolIdToPoolKey", args: [USDT_BEAT_POOL_ID],
  })) as readonly [Hex, Hex, Hex, Hex, number, Hex];
  const [currency0, currency1, hooks, poolManager, fee, parameters] = key;
  if (poolManager.toLowerCase() !== INFINITY_CL_POOL_MANAGER.toLowerCase()) {
    throw new Error("poolIdToPoolKey returned a foreign poolManager — wrong pool id?");
  }
  const slot0 = (await client.readContract({
    address: INFINITY_CL_POOL_MANAGER, abi: clpmAbi, functionName: "getSlot0", args: [USDT_BEAT_POOL_ID],
  })) as readonly [bigint, number, number, number];
  const liquidity = (await client.readContract({
    address: INFINITY_CL_POOL_MANAGER, abi: clpmAbi, functionName: "getLiquidity", args: [USDT_BEAT_POOL_ID],
  })) as bigint;
  const [sqrtPriceX96, tick, protocolFee, lpFee] = slot0;
  const tickSpacing = Number((BigInt(parameters) >> 16n) & 0xffffffn);
  if (tickSpacing <= 0 || tickSpacing > 32767) throw new Error(`bad tickSpacing ${tickSpacing}`);

  // Tick profile: populated ticks via the CLTickLens, ±WORD_WINDOW words around the live word.
  // The bitmap indexes COMPRESSED ticks (tick / tickSpacing), 256 per word.
  const compressed = Math.floor(tick / tickSpacing);
  const liveWord = compressed >> 8;
  const ticks: [number, string][] = [];
  for (let w = liveWord - WORD_WINDOW; w <= liveWord + WORD_WINDOW; w++) {
    const rows = (await client.readContract({
      address: INFINITY_CL_TICK_LENS, abi: tickLensAbi, functionName: "getPopulatedTicksInWord",
      args: [USDT_BEAT_POOL_ID, w],
    })) as readonly { tick: number; liquidityNet: bigint; liquidityGross: bigint }[];
    for (const r of rows) {
      if (r.liquidityNet !== 0n) ticks.push([Number(r.tick), r.liquidityNet.toString()]);
    }
  }
  ticks.sort((a, b) => a[0] - b[0]);

  const [sym0, sym1] = await Promise.all([symbolOf(client, currency0), symbolOf(client, currency1)]);
  const snap: ProdInfinitySnapshot = {
    chainId,
    pool: INFINITY_CL_POOL_MANAGER, // singleton (schema parity with V4)
    poolId: USDT_BEAT_POOL_ID,
    currency0: getAddress(currency0),
    currency1: getAddress(currency1),
    hooks,
    token0: getAddress(currency0),
    token1: getAddress(currency1),
    symbol0: sym0.symbol,
    symbol1: sym1.symbol,
    decimals0: sym0.decimals,
    decimals1: sym1.decimals,
    fee,
    tickSpacing,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: Number(tick),
    liquidity: liquidity.toString(),
    ticks,
    windowTickSpacings: WORD_WINDOW * 256, // word-window semantics (compressed ticks per side)
    protocolFee,
    lpFee,
    parameters,
  };

  const file = join(SNAPSHOT_DIR, `bsc-infinity-${snap.symbol0}${snap.symbol1}-${snap.fee}.json`);
  writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");
  console.log(
    `infinity-snapshot: wrote ${file}\n  ${snap.symbol0}/${snap.symbol1} fee=${snap.fee} ts=${snap.tickSpacing}` +
      ` protocolFee=${snap.protocolFee} lpFee=${snap.lpFee}\n  tick=${snap.tick} sqrtPriceX96=${snap.sqrtPriceX96}` +
      ` activeLiquidity=${snap.liquidity}\n  initialized boundaries in ±${WORD_WINDOW} words: ${snap.ticks.length}`,
  );
}

main().catch((e) => {
  console.error("infinity-snapshot failed:", e);
  process.exit(1);
});
