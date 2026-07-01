/**
 * One-time capture of a REAL Aerodrome sAMM (stable) pool from Base mainnet, so the
 * Solidly prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Captures, into two checked-in snapshots:
 *   fixtures/snapshots/base-solidly-USDCUSDbC.bytecode.json  — the pool's REAL runtime
 *     bytecode (eth_getCode). If the pool is a minimal-proxy/clone, ALSO captures the
 *     implementation runtime + records the proxy target so the test can etch both.
 *   fixtures/snapshots/base-solidly-USDCUSDbC.state.json     — the swap-relevant STATE
 *     (reserve0/reserve1, token0/1, decimals0/1, stable flag, factory fee, symbols),
 *     plus every raw storage slot the pool touches on getReserves/getAmountOut/swap
 *     (eth_getStorageAt) so the test can reconstruct the pool's state by setStorageAt.
 *
 * We discover the deepest sAMM pool for the two Base baseTokens USDC/USDbC via the
 * Aerodrome PoolFactory getPool(USDC, USDbC, true). We pin the block for provenance.
 *
 * NEVER persists the RPC url / API key — only contract code + state.
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   BASE_RPC_URL=$BASE_RPC_URL npx tsx src/recipes/test/harness/solidly-snapshot.ts
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
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const BYTECODE_OUT = join(SNAP_DIR, "base-solidly-USDCUSDbC.bytecode.json");
const STATE_OUT = join(SNAP_DIR, "base-solidly-USDCUSDbC.state.json");

// Base baseTokens + the Aerodrome (SolidlyV2) PoolFactory (see shared/constants.ts).
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDbC = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" as Address;
const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address;

const RPC =
  process.argv[2] ||
  process.env.BASE_RPC_URL ||
  process.env.BASE_RPC ||
  "";
if (!RPC) {
  console.error(
    "no RPC — pass one as argv[2] or set BASE_RPC_URL " +
      "(set -a; . sdk/.env; set +a)",
  );
  process.exit(1);
}

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
  "function getFee(address pool, bool stable) view returns (uint256)",
]);
const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function decimals() view returns (uint8)",
  "function decimals0() view returns (uint256)",
  "function decimals1() view returns (uint256)",
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)",
  "function factory() view returns (address)",
  "function symbol() view returns (string)",
]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);

/** Detect an EIP-1167 minimal proxy and extract its implementation address. */
function parseMinimalProxy(code: string): Hex | null {
  // EIP-1167 canonical: 363d3d373d3d3d363d73<20-byte impl>5af43d82803e903d91602b57fd5bf3
  const m = code.match(/^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/);
  if (m) return getAddress(("0x" + m[1]) as Hex);
  // Some clones use a slightly different push/runtime tail — try to find the 73<addr>5af4 pattern.
  const m2 = code.match(/363d3d373d3d3d363d73([0-9a-fA-F]{40})5af4/);
  if (m2) return getAddress(("0x" + m2[1]) as Hex);
  return null;
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 8453) {
    console.warn(`[solidly-snapshot] WARNING: chainId ${chainId} != Base (8453)`);
  }
  const block = await client.getBlockNumber();
  console.log(`[solidly-snapshot] Base chainId=${chainId} block=${block}`);

  // Discover the sAMM (stable=true) pool for USDC/USDbC.
  const pool = (await client.readContract({
    address: AERODROME_FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [USDC, USDbC, true],
  })) as Address;
  if (!pool || BigInt(pool) === 0n) {
    throw new Error("Aerodrome getPool(USDC, USDbC, true) returned the zero address");
  }
  console.log(`[solidly-snapshot] deepest USDC/USDbC sAMM pool = ${pool}`);

  // The pool's REAL runtime bytecode.
  const poolCode = await client.getCode({ address: pool });
  if (!poolCode || poolCode === "0x") throw new Error(`empty code at pool ${pool}`);
  console.log(`[solidly-snapshot] pool runtime = ${poolCode.length / 2 - 1} bytes`);

  // Minimal-proxy resolution: if the pool is a clone, capture the implementation too.
  const impl = parseMinimalProxy(poolCode);
  let implCode: string | null = null;
  if (impl) {
    implCode = await client.getCode({ address: impl });
    if (!implCode || implCode === "0x") throw new Error(`empty code at impl ${impl}`);
    console.log(
      `[solidly-snapshot] pool is an EIP-1167 clone -> impl ${impl} (${implCode.length / 2 - 1} bytes)`,
    );
  } else {
    console.log("[solidly-snapshot] pool is NOT a minimal proxy (self-contained runtime)");
  }

  // Swap-relevant STATE via the pool's own getters (the ground truth the test asserts against).
  const [token0, token1, stable, reserves] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }) as Promise<Address>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "token1" }) as Promise<Address>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "stable" }) as Promise<boolean>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "getReserves" }) as Promise<
      readonly [bigint, bigint, bigint]
    >,
  ]);
  if (!stable) throw new Error("discovered pool is NOT a stable (sAMM) pool");

  // decimals0/decimals1 are the pool's normalisation factors (= 10**tokenDecimals). Read them
  // from the pool if it exposes them; else derive from the tokens' erc20 decimals().
  const [dec0, dec1] = await Promise.all([
    client
      .readContract({ address: pool, abi: poolAbi, functionName: "decimals0" })
      .then((d) => BigInt(d as bigint))
      .catch(async () => 10n ** BigInt(await client.readContract({ address: token0, abi: erc20Abi, functionName: "decimals" }))),
    client
      .readContract({ address: pool, abi: poolAbi, functionName: "decimals1" })
      .then((d) => BigInt(d as bigint))
      .catch(async () => 10n ** BigInt(await client.readContract({ address: token1, abi: erc20Abi, functionName: "decimals" }))),
  ]);

  const [decTok0, decTok1] = await Promise.all([
    client.readContract({ address: token0, abi: erc20Abi, functionName: "decimals" }).then((d) => Number(d)),
    client.readContract({ address: token1, abi: erc20Abi, functionName: "decimals" }).then((d) => Number(d)),
  ]);

  // Factory fee for the stable pool (ppm-or-bps; the discovery path normalises).
  const factoryFee = (await client
    .readContract({ address: AERODROME_FACTORY, abi: factoryAbi, functionName: "getFee", args: [pool, true] })
    .catch(() => 0n)) as bigint;

  // A tiny getAmountOut probe at the CAPTURED state — a self-check the test can reproduce
  // to prove the etched pool computes identically (real code, real reserves).
  const probeIn = 1_000n * 10n ** BigInt(decTok0); // 1000 token0 units
  const probeOut = (await client.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "getAmountOut",
    args: [probeIn, token0],
  })) as bigint;

  // Raw storage slots the pool touches. The Aerodrome Pool packs token0/token1/reserve0/reserve1
  // into low slots; capturing a generous window lets the test reconstruct state deterministically
  // via setStorageAt even if the implementation reads packed slots the getters abstract. We snapshot
  // slots 0..40 (covers tokens, decimals, reserves, factory, observations head) + the proxy's slots.
  const slotCount = 41;
  const slots: Record<string, Hex> = {};
  for (let i = 0; i < slotCount; i++) {
    const slot = ("0x" + i.toString(16).padStart(64, "0")) as Hex;
    const val = await client.getStorageAt({ address: pool, slot });
    slots[i.toString()] = (val ?? "0x0000000000000000000000000000000000000000000000000000000000000000") as Hex;
  }

  // sha256 of the (lowercased) runtime hex — a self-contained integrity anchor. The offline
  // test re-hashes the loaded runtime and asserts equality, a cheap tamper/regression tripwire
  // that needs NO RPC (a reviewer without the key can still verify the loaded code is unaltered).
  const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex"));
  const bytecodeSnap = {
    chain: "base",
    block: block.toString(),
    pool: { address: pool, runtime: poolCode, runtimeSha256: sha256(poolCode) },
    ...(impl && implCode
      ? { implementation: { address: impl, runtime: implCode, runtimeSha256: sha256(implCode) } }
      : {}),
    isMinimalProxy: Boolean(impl),
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  const stateSnap = {
    chain: "base",
    block: block.toString(),
    pool: pool,
    factory: AERODROME_FACTORY,
    token0,
    token1,
    stable,
    decimals0: dec0.toString(),
    decimals1: dec1.toString(),
    tokenDecimals0: decTok0,
    tokenDecimals1: decTok1,
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
    blockTimestampLast: reserves[2].toString(),
    factoryFee: factoryFee.toString(),
    // A captured getAmountOut probe (1000 token0 units → token0-side in) at these reserves —
    // the self-check the offline test reproduces against its etched pool.
    probe: { amountIn: probeIn.toString(), tokenIn: token0, amountOut: probeOut.toString() },
    // Raw storage slots (0..40) for deterministic setStorageAt reconstruction.
    storage: slots,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[solidly-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[solidly-snapshot] state: token0=${token0} token1=${token1} stable=${stable}\n` +
      `  reserve0=${reserves[0]} reserve1=${reserves[1]} dec0=${dec0} dec1=${dec1} factoryFee=${factoryFee}\n` +
      `  probe getAmountOut(${probeIn} token0) = ${probeOut}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
