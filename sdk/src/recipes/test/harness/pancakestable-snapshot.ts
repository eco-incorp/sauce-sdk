/**
 * One-time capture of a REAL PancakeSwap StableSwap 2-pool from BSC, so the PancakeStableSwap
 * prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/curveStable-snapshot.ts (the proven pattern): eth_getCode the pool's REAL
 * Solidity runtime into a checked-in bytecode snapshot (WITH sha256 integrity anchors), and the
 * swap-relevant STATE (the full StableSwap invariant state — coins/balances/A/fee/admin_fee/RATES,
 * the coin indices, the A-ramp bookkeeping) + the RAW storage slots needed to reconstruct it
 * (eth_getStorageAt) into a state snapshot. Block pinned. The RPC url / key is NEVER persisted —
 * only contract CODE + STATE.
 *
 * ── WHICH POOL ──────────────────────────────────────────────────────────────────────────────────
 * The canonical on-charter USDT/USDC 2-pool 0x3EFebC418efB585248A0D2140cfb87afcc2c63dd (the pair
 * every other BSC prod-mirror uses; probed 2026-07-04: ≈162.9k USDT + 91.2k USDC, A=1000,
 * fee=1e6/1e10=0.01%, both coins 18-dec ⇒ RATES 1e18/1e18 and the view/exchange dy rounding forms
 * COINCIDE). The pool is a SELF-CONTAINED Solidity contract: get_dy/exchange call NO external
 * contract except the two coin ERC20s (the admin fee accrues in the pool's own `balances`
 * bookkeeping — no factory read on the swap path), so the etch needs only {pool runtime + verbatim
 * storage window + local ERC20s at the real coin addresses}. Coins live in STORAGE (slots inside
 * the captured window), so the verbatim copy restores them and the local tokens are etched AT
 * those captured addresses (the Wombat/WOOFi repoint pattern).
 *
 * ── DISCOVERY ───────────────────────────────────────────────────────────────────────────────────
 * The production FactoryType.PancakeStableSwap reader calls the factory's ORDER-INDEPENDENT
 * getPairInfo(tokenA, tokenB) → (swapContract, token0, token1, LP). Both argument orders are
 * captured for the offline shim (a const-response shim keyed on the selector alone reproduces the
 * order-independence for the one reproduced pair — the reader queries exactly this pair).
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   BSC_RPC_URL=$BSC_RPC_URL npx tsx src/recipes/test/harness/pancakestable-snapshot.ts
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, getAddress, type Hex, type Address } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "bsc-pancakestable-USDTUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The wired PancakeStableSwapFactory (constants.ts BSC entry) + the on-charter USDT/USDC 2-pool.
const FACTORY = getAddress("0x25a55f9f2279A54951133D503490342b50E5cd15") as Address;
const POOL = getAddress("0x3EFebC418efB585248A0D2140cfb87afcc2c63dd") as Address;
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955") as Address;
const USDC = getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d") as Address;

const RPC = process.argv[2] || process.env.BSC_RPC_URL || "";
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set BSC_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const factoryAbi = parseAbi([
  "function getPairInfo(address tokenA, address tokenB) view returns (address swapContract, address token0, address token1, address LPContract)",
  "function pairLength() view returns (uint256)",
]);
const poolAbi = parseAbi([
  "function coins(uint256 i) view returns (address)",
  "function balances(uint256 i) view returns (uint256)",
  "function RATES(uint256 i) view returns (uint256)",
  "function PRECISION_MUL(uint256 i) view returns (uint256)",
  "function N_COINS() view returns (uint256)",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function admin_fee() view returns (uint256)",
  "function initial_A() view returns (uint256)",
  "function future_A() view returns (uint256)",
  "function initial_A_time() view returns (uint256)",
  "function future_A_time() view returns (uint256)",
  "function is_killed() view returns (bool)",
  "function token() view returns (address)",
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
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
  if (chainId !== 56) {
    console.warn(`[pancakestable-snapshot] WARNING: chainId ${chainId} != BSC (56)`);
  }
  const block = await client.getBlockNumber();
  console.log(`[pancakestable-snapshot] BSC chainId=${chainId} block=${block}`);

  // ── Discovery (BOTH argument orders — the order-independence the reader relies on). ──
  const fwd = (await client.readContract({
    address: FACTORY, abi: factoryAbi, functionName: "getPairInfo", args: [USDT, USDC], blockNumber: block,
  })) as readonly [Address, Address, Address, Address];
  const rev = (await client.readContract({
    address: FACTORY, abi: factoryAbi, functionName: "getPairInfo", args: [USDC, USDT], blockNumber: block,
  })) as readonly [Address, Address, Address, Address];
  const pairLength = (await client.readContract({
    address: FACTORY, abi: factoryAbi, functionName: "pairLength", blockNumber: block,
  })) as bigint;
  if (getAddress(fwd[0]) !== POOL) throw new Error(`getPairInfo(USDT,USDC) != expected pool (got ${fwd[0]})`);
  if (fwd.join() !== rev.join()) throw new Error("getPairInfo is NOT order-independent (?)");
  console.log(`[pancakestable-snapshot] getPairInfo → pool=${fwd[0]} token0=${fwd[1]} token1=${fwd[2]} LP=${fwd[3]} (both orders identical); pairLength=${pairLength}`);

  // ── The pool's REAL Solidity runtime. ──
  const poolCode = await client.getCode({ address: POOL });
  if (!poolCode || poolCode === "0x") throw new Error(`empty code at pool ${POOL}`);
  console.log(`[pancakestable-snapshot] pool runtime = ${poolCode.length / 2 - 1} bytes`);

  // ── Swap-relevant invariant STATE via the pool's own getters (the ground truth). ──
  const N = Number(
    (await client.readContract({ address: POOL, abi: poolAbi, functionName: "N_COINS", blockNumber: block }).catch(() => 2n)) as bigint,
  ) || 2;
  const coins: Address[] = [];
  const balances: bigint[] = [];
  const rates: bigint[] = [];
  const precisionMul: bigint[] = [];
  for (let k = 0; k < N; k++) {
    coins.push((await client.readContract({ address: POOL, abi: poolAbi, functionName: "coins", args: [BigInt(k)], blockNumber: block })) as Address);
    balances.push((await client.readContract({ address: POOL, abi: poolAbi, functionName: "balances", args: [BigInt(k)], blockNumber: block })) as bigint);
    rates.push((await client.readContract({ address: POOL, abi: poolAbi, functionName: "RATES", args: [BigInt(k)], blockNumber: block })) as bigint);
    precisionMul.push((await client.readContract({ address: POOL, abi: poolAbi, functionName: "PRECISION_MUL", args: [BigInt(k)], blockNumber: block })) as bigint);
  }
  const coinInfo = await Promise.all(
    coins.map(async (addr) => {
      const [sym, dec, held] = await Promise.all([
        client.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
        client.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }).then(Number).catch(() => 18),
        client.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [POOL], blockNumber: block }).catch(() => 0n) as Promise<bigint>,
      ]);
      return { address: addr, symbol: sym as string, decimals: dec, poolBalanceOf: held.toString() };
    }),
  );
  const [A, fee, adminFee, initialA, futureA, initialATime, futureATime, isKilled, lpToken] = await Promise.all([
    client.readContract({ address: POOL, abi: poolAbi, functionName: "A", blockNumber: block }) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "fee", blockNumber: block }) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "admin_fee", blockNumber: block }).catch(() => -1n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "initial_A", blockNumber: block }).catch(() => -1n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "future_A", blockNumber: block }).catch(() => -1n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "initial_A_time", blockNumber: block }).catch(() => -1n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "future_A_time", blockNumber: block }).catch(() => -1n) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "is_killed", blockNumber: block }).catch(() => false) as Promise<boolean>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "token", blockNumber: block }).catch(() => "0x0000000000000000000000000000000000000000") as Promise<Address>,
  ]);
  if (isKilled) throw new Error("pool is_killed — not a capture target");
  // The A-ramp must be SETTLED (future_A_time in the past) or the offline anvil timestamp would
  // interpolate a different A than the capture (fresh anvil starts at the current wall clock).
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (futureATime > 0n && futureATime > nowSec) {
    throw new Error(`A-ramp ACTIVE (future_A_time=${futureATime} > now) — capture after it settles`);
  }

  // ── Coin indices for the USDT→USDC direction (tokenIn = USDT). token0/token1 are SORTED. ──
  const i = getAddress(fwd[1]) === USDT ? 0 : 1;
  const j = 1 - i;

  // ── get_dy probes at the CAPTURED state (both directions) — the offline self-check. ──
  const dxFwd = 10_000n * 10n ** BigInt(coinInfo[i].decimals);
  const dxRev = 10_000n * 10n ** BigInt(coinInfo[j].decimals);
  const [dyFwd, dyRev] = await Promise.all([
    client.readContract({ address: POOL, abi: poolAbi, functionName: "get_dy", args: [BigInt(i), BigInt(j), dxFwd], blockNumber: block }) as Promise<bigint>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "get_dy", args: [BigInt(j), BigInt(i), dxRev], blockNumber: block }) as Promise<bigint>,
  ]);

  // ── Raw storage window for the verbatim setStorageAt reconstruction. The pool is a plain
  //    Solidity contract with a LINEAR layout (Ownable._owner, ReentrancyGuard._status,
  //    PRECISION_MUL[2], RATES[2], coins[2], balances[2], fee, admin_fee, the A-ramp + kill
  //    bookkeeping — all inside the first few dozen slots; STABLESWAP_FACTORY is an immutable in
  //    the runtime). Capture 0..63 (nonzero) — the etch test asserts every getter equals the
  //    captured value, which VALIDATES the window covered everything swap-relevant. ──
  const SLOT_WINDOW = 64;
  const storage: Record<string, Hex> = {};
  for (let s = 0; s < SLOT_WINDOW; s++) {
    const slot = ("0x" + s.toString(16).padStart(64, "0")) as Hex;
    const v = await client.getStorageAt({ address: POOL, slot, blockNumber: block });
    if (v && BigInt(v) !== 0n) storage[s.toString()] = v as Hex;
  }

  const bytecodeSnap = {
    chain: "bsc",
    chainId,
    block: block.toString(),
    pool: { address: POOL, runtime: poolCode, runtimeSha256: sha256(poolCode) },
    // Self-contained Solidity pool: get_dy/exchange touch NOTHING but the two coin ERC20s (the
    // admin fee accrues in the pool's own balances bookkeeping — no factory read on the swap path).
    isMinimalProxy: false,
    dependencies: [] as unknown[],
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  const stateSnap = {
    chain: "bsc",
    chainId,
    block: block.toString(),
    pool: POOL,
    factory: FACTORY,
    source: "PancakeSwap StableSwap",
    discovery: {
      factory: FACTORY,
      pairLength: pairLength.toString(),
      getPairInfo: { swapContract: fwd[0], token0: fwd[1], token1: fwd[2], LPContract: fwd[3] },
      orderIndependent: true,
    },
    i,
    j,
    nCoins: N,
    coins: coinInfo,
    tokenIn: coins[i],
    tokenOut: coins[j],
    // The StableSwap invariant state. A is RAW (the LEGACY A_PRECISION=1 variant — Ann = A·N in
    // the verified source); fee/admin_fee are 1e10-scaled; RATES = 1e18·PRECISION_MUL.
    A: A.toString(),
    aPrecision: "1",
    fee: fee.toString(),
    adminFee: adminFee.toString(),
    initialA: initialA.toString(),
    futureA: futureA.toString(),
    initialATime: initialATime.toString(),
    futureATime: futureATime.toString(),
    isKilled,
    lpToken,
    balances: balances.map(String),
    rates: rates.map(String),
    precisionMul: precisionMul.map(String),
    probe: {
      forward: { i, j, dx: dxFwd.toString(), dy: dyFwd.toString() },
      reverse: { i: j, j: i, dx: dxRev.toString(), dy: dyRev.toString() },
    },
    storage,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[pancakestable-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[pancakestable-snapshot] state: pool=${POOL}\n` +
      `  coins=[${coinInfo.map((c) => `${c.symbol}(${c.decimals})`).join(", ")}] i=${i} j=${j}\n` +
      `  A=${A} (aPrecision=1) fee=${fee} admin_fee=${adminFee} initial_A=${initialA} future_A=${futureA} (ramp settled)\n` +
      `  balances=[${balances.join(", ")}] rates=[${rates.join(", ")}]\n` +
      `  probe get_dy(${i}->${j}, 10k) = ${dyFwd}  ;  get_dy(${j}->${i}, 10k) = ${dyRev}\n` +
      `  storage slots captured (nonzero, 0..63): ${Object.keys(storage).length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
