/**
 * One-time capture of a REAL Balancer V3 (balancer/balancer-v3-monorepo — Vault singleton + per-chain
 * Router) StableSurge-hooked, rate-scaled pool + its WHOLE quote/swap contract GRAPH from Base mainnet, so
 * the Balancer V3 prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/mento-snapshot.ts (the proven WHOLE-GRAPH pattern): let the EVM enumerate the exact
 * touched contract set via `debug_traceCall(prestateTracer)` on the production quote AND a REAL successful
 * swap, dump {code, touched-storage} per address, `eth_getCode` every traced contract fresh at the pinned
 * block (WITH sha256 integrity anchors), and record the swap-relevant probes. Block pinned. The RPC url /
 * key is NEVER persisted — only contract CODE + STATE.
 *
 * WHICH POOL — the wired FactoryType.BalancerV3 target on Base (constants.ts BASE_CHAIN_POOL_CONFIG
 * balancerV3Pools[0]): 0x7ab124ec4029316c2a42f713828ddf2a192b36db "Balancer Aave USDC-Aave GHO"
 * (StableSurge-hooked, 2-token, A=1000, staticFee 5e13). The swappable tokens are the ERC4626 StaticATokenLM
 * WRAPPERS waGHO (0x88b1…, 18d, WITH_RATE) + waUSDC (0xC768…, 6d, WITH_RATE) — NOT raw GHO/USDC. It is the
 * Base V3 depth the config-audit flagged as MISSING under the V2-only Balancer wiring. Deliberately picked
 * because it exercises the HARD real surface uniformly: a DYNAMIC StableSurge hook fee AND rate-provider
 * rate scaling (a static-fee StableMath replay could NOT price it), so the recipe's LIVE query-ladder
 * surface is the ONLY faithful one — and the prod-mirror proves it works on the genuine bytecode.
 *
 * TOUCHED CONTRACT GRAPH (traced — the union is the offline etch set):
 *   Router 0x3f17…DC10 (single-swap v3-router-v2) — querySwapSingleTokenExactIn / swapSingleTokenExactIn.
 *   Vault 0xbA13…bA9 (CREATE2 singleton proxy) — holds pool balances + `_reservesOf` (mapping base slot 8).
 *   VaultExtension 0x0E8B… — the Vault's `quote()` delegate (the query path only).
 *   Pool 0x7ab1… (StablePool) — onSwap (the StableMath curve).
 *   StableSurgeHook 0xb200… — onComputeDynamicSwapFeePercentage (the dynamic fee).
 *   Rate providers 0xf8CDA… (waGHO) + 0x0368… (waUSDC) — getRate → wrapper.convertToAssets(1e18).
 *   ERC4626 wrappers waGHO 0x88b1… + waUSDC 0xC768… (StaticATokenLM proxies → impl 0xbCb1…) — the swappable
 *     tokens; their rate comes from Aave, and their transfer accrues rewards (swap path).
 *   Aave Pool 0xA238… (proxy → impl 0xA4Ab…) — getReserveNormalizedIncome (the wrapper's rate source).
 *   Aave rewards controller 0xf9cc… (proxy → impl 0x4D01…) + underlying aToken 0x4e65… (proxy → impl
 *     0x273E…) — touched by StaticATokenLM.transferFrom's reward accrual (swap path only).
 *
 * WEI-EXACT ANCHOR: the recorded probe ladder (Router.querySwapSingleTokenExactIn both directions) is what
 * the offline test reproduces to the WEI against the etched real graph — and a REAL swapSingleTokenExactIn
 * of the awarded share lands that same out (the query is the exact-in surface the exec re-reads).
 *
 * OFFLINE SWAP SETTLEMENT — the ONE reconstruction nuance (disclosed, verified). Balancer V3's `_reservesOf`
 * (mapping(token=>uint256) at Vault storage base slot 8) is PERSISTENT and MUST equal `token.balanceOf(vault)`
 * at unlock; `settle()` credits `balanceOf(vault) - _reservesOf[token]`. On any non-live state (a fresh etch,
 * or a fork) the persisted `_reservesOf` is a STALE value from the last mainnet tx, so `settle` mis-credits and
 * the swap reverts `BalanceNotSettled` (0x20f1d86d). The etch RE-SEEDS `_reservesOf[token] = balanceOf(vault)`
 * for BOTH tokens right before the swap — a replay of the real on-unlock invariant, NOT a fabrication (verified:
 * with the reserves seeded to the live balance, a REAL swapSingleTokenExactIn against the etched graph lands
 * the captured mainnet out to the wei). The swap-only prestate below is captured from a REAL successful swap on
 * a LOCAL FORK with exactly this seeding, so the snapshot's storage covers the whole swap fan-out.
 *
 * BLOCK-TIMESTAMP PIN: the wrapper rate = Aave getReserveNormalizedIncome, which accrues on `block.timestamp`.
 * The offline test pins block.timestamp to the captured block ts so the reconstructed rate == the captured
 * probe to the wei (the Mento/Fluid accrual class).
 *
 * Re-capture (REQUIRED whenever the reconstruction changes):
 *   set -a; . sdk/.env; set +a
 *   BASE_RPC_URL=$BASE_RPC_URL npx tsx src/recipes/test/harness/balancerv3-snapshot.ts
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  parseAbi,
  getAddress,
  encodeFunctionData,
  keccak256,
  encodeAbiParameters,
  pad,
  toHex,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "base-balancerv3-waUSDCwaGHO";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The wired FactoryType.BalancerV3 target on Base (constants.ts BASE_CHAIN_POOL_CONFIG).
const VAULT = getAddress("0xbA1333333333a1BA1108E8412f11850A5C319bA9") as Address; // CREATE2 singleton
const ROUTER = getAddress("0x3f170631ed9821Ca51A59D996aB095162438DC10") as Address; // Base single-swap v3-router-v2
const POOL = getAddress("0x7ab124ec4029316c2a42f713828ddf2a192b36db") as Address; // Aave USDC-GHO StableSurge
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3") as Address; // canonical singleton

// The swappable ERC4626 StaticATokenLM wrappers (Vault.getPoolTokens order: [waGHO, waUSDC]).
const WAGHO = getAddress("0x88b1Cd4b430D95b406E382C3cDBaE54697a0286E") as Address; // 18d
const WAUSDC = getAddress("0xC768c589647798a6EE01A91FdE98EF2ed046DBD6") as Address; // 6d

// `_reservesOf` is mapping(IERC20 => uint256) at Vault storage BASE SLOT 8 (brute-force-confirmed:
// keccak(abi.encode(token,8)) holds balanceOf(vault) on mainnet at the pinned block).
const RESERVES_OF_BASE_SLOT = 8n;

const PIN_BLOCK = BigInt(process.argv[3] ?? "48120913");

const RPC = process.argv[2] || process.env.BASE_RPC_URL || "";
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set BASE_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

const routerAbi = parseAbi([
  "function querySwapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, address sender, bytes userData) returns (uint256 amountOut)",
  "function swapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, uint256 minAmountOut, uint256 deadline, bool wethIsEth, bytes userData) payable returns (uint256 amountOut)",
  "function getPermit2() view returns (address)",
]);
const vaultAbi = parseAbi([
  "function getPoolTokens(address pool) view returns (address[])",
  "function isPoolRegistered(address pool) view returns (bool)",
  "function getReservesOf(address token) view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);
const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

/** mapping(address=>uint256) storage key: keccak256(abi.encode(token, baseSlot)). */
function mappingSlot(key: Address, baseSlot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(key), baseSlot]));
}
function word(v: bigint): Hex {
  return pad(toHex(v), { size: 32 }) as Hex;
}

type Prestate = Record<string, { balance?: string; nonce?: number; code?: Hex; storage?: Record<string, Hex> }>;

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 180_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 8453) console.warn(`[bv3-snapshot] WARNING: chainId ${chainId} != Base (8453)`);
  const pinnedBlock = await client.getBlock({ blockNumber: PIN_BLOCK });
  const blockTimestamp = pinnedBlock.timestamp;
  console.log(`[bv3-snapshot] Base chainId=${chainId} pinned block=${PIN_BLOCK} ts=${blockTimestamp}`);

  // ── Orient the pair via Vault.getPoolTokens (the recipe's discovery surface) + confirm registration. ──
  const registered = (await client.readContract({
    address: VAULT, abi: vaultAbi, functionName: "isPoolRegistered", args: [POOL], blockNumber: PIN_BLOCK,
  })) as boolean;
  if (!registered) throw new Error(`pool ${POOL} is not registered in the Vault`);
  const poolTokens = (await client.readContract({
    address: VAULT, abi: vaultAbi, functionName: "getPoolTokens", args: [POOL], blockNumber: PIN_BLOCK,
  })) as readonly Address[];
  console.log(`[bv3-snapshot] getPoolTokens => ${poolTokens.join(", ")}`);
  const tokenSet = new Set(poolTokens.map((t) => t.toLowerCase()));
  if (!tokenSet.has(WAGHO.toLowerCase()) || !tokenSet.has(WAUSDC.toLowerCase())) {
    throw new Error(`pool ${POOL} is not the expected waGHO/waUSDC pair (got ${poolTokens.join(",")})`);
  }
  const permit2 = (await client.readContract({
    address: ROUTER, abi: routerAbi, functionName: "getPermit2", blockNumber: PIN_BLOCK,
  })) as Address;
  if (permit2.toLowerCase() !== PERMIT2.toLowerCase()) {
    throw new Error(`Router.getPermit2() ${permit2} != canonical Permit2 ${PERMIT2}`);
  }

  // Direction: swap waUSDC (6d) -> waGHO (18d) — tokenIn = waUSDC, tokenOut = waGHO.
  const tokenIn = WAUSDC;
  const tokenOut = WAGHO;
  const [decIn, decOut, symIn, symOut] = await Promise.all([
    client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "decimals", blockNumber: PIN_BLOCK }).then(Number),
    client.readContract({ address: tokenOut, abi: erc20Abi, functionName: "decimals", blockNumber: PIN_BLOCK }).then(Number),
    client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "symbol", blockNumber: PIN_BLOCK }).catch(() => "?"),
    client.readContract({ address: tokenOut, abi: erc20Abi, functionName: "symbol", blockNumber: PIN_BLOCK }).catch(() => "?"),
  ]);

  // ── Probe ladder (Router.querySwapSingleTokenExactIn), both directions — the wei-exact anchor. ──
  const unitIn = 10n ** BigInt(decIn);
  const unitOut = 10n ** BigInt(decOut);
  const probeSizesIn = [100n, 1_000n, 10_000n, 50_000n, 100_000n].map((n) => n * unitIn);
  const probeSizesOut = [100n, 1_000n, 10_000n, 50_000n, 100_000n].map((n) => n * unitOut);
  const query = (pool: Address, tIn: Address, tOut: Address, amt: bigint) =>
    client
      .readContract({
        address: ROUTER, abi: routerAbi, functionName: "querySwapSingleTokenExactIn",
        args: [pool, tIn, tOut, amt, "0x0000000000000000000000000000000000000000", "0x"], blockNumber: PIN_BLOCK,
      })
      .then((r) => r as bigint)
      .catch(() => 0n);
  const quotesInToOut = await Promise.all(probeSizesIn.map((a) => query(POOL, tokenIn, tokenOut, a)));
  const quotesOutToIn = await Promise.all(probeSizesOut.map((a) => query(POOL, tokenOut, tokenIn, a)));

  // ── Trace 1: the QUERY (production discovery + the recipe's minAmountOut re-read) — pricing graph +
  //    the Vault's `quote()` delegate (VaultExtension), read from the RPC at the pinned block. ──
  const blockHex = ("0x" + PIN_BLOCK.toString(16)) as Hex;
  const queryData = encodeFunctionData({
    abi: routerAbi, functionName: "querySwapSingleTokenExactIn",
    args: [POOL, tokenIn, tokenOut, 100_000n * unitIn, "0x0000000000000000000000000000000000000000", "0x"],
  });
  const traceQuery = (await client.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "debug_traceCall" as any,
    params: [{ to: ROUTER, data: queryData }, blockHex, { tracer: "prestateTracer" }] as any,
  })) as Prestate;
  // ALSO trace the two discovery reads so the enumerable production path is reproduced.
  const getPoolTokensData = encodeFunctionData({ abi: vaultAbi, functionName: "getPoolTokens", args: [POOL] });
  const isRegisteredData = encodeFunctionData({ abi: vaultAbi, functionName: "isPoolRegistered", args: [POOL] });
  const traceGetTokens = (await client.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "debug_traceCall" as any,
    params: [{ to: VAULT, data: getPoolTokensData }, blockHex, { tracer: "prestateTracer" }] as any,
  })) as Prestate;
  const traceIsReg = (await client.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "debug_traceCall" as any,
    params: [{ to: VAULT, data: isRegisteredData }, blockHex, { tracer: "prestateTracer" }] as any,
  })) as Prestate;

  // ── Trace 2: a REAL SUCCESSFUL swapSingleTokenExactIn — captured on a LOCAL FORK (the public RPC swap
  //    reverts at Permit2). Boot anvil --fork-url at the pinned block, impersonate the Vault to fund the
  //    caller with waUSDC, RE-SEED `_reservesOf` to the live balance (the on-unlock invariant), Permit2
  //    two-step approve, then prestate-trace the swap. Its fan-out adds the swap-only contracts (the Aave
  //    rewards controller + the underlying aToken, touched by StaticATokenLM.transferFrom accrual). ──
  const traceSwap = await captureSwapPrestateOnFork(tokenIn, tokenOut, 100_000n * unitIn);

  // ── Union all prestates: per address, code + the union of touched storage slots (skip EOAs). ──
  const graph: Record<string, { code: Hex; storage: Record<string, Hex> }> = {};
  for (const src of [traceQuery, traceGetTokens, traceIsReg, traceSwap]) {
    for (const [addr, o] of Object.entries(src)) {
      if (!o.code || o.code === "0x") continue;
      const a = getAddress(addr as Hex).toLowerCase();
      if (!graph[a]) graph[a] = { code: o.code as Hex, storage: {} };
      for (const [slot, val] of Object.entries(o.storage ?? {})) {
        graph[a].storage[slot.toLowerCase()] = val as Hex;
      }
    }
  }
  // The Router/Permit2/pool are pricing-neutral for token movement; but a Base system precompile-ish
  // address (0x42000000…19/1a/1b — L1 fee/gas oracles) can appear in the fork trace. Drop any traced address
  // whose pinned-block code is empty on the SOURCE chain (they're not part of the deterministic swap graph).
  console.log(`[bv3-snapshot] traced graph (raw union): ${Object.keys(graph).length} contracts`);

  // ── Roles (well-known members; the rest are impls/libs). ──
  const roleOf = (a: string): string => {
    const m: Record<string, string> = {
      [VAULT.toLowerCase()]: "Vault (CREATE2 singleton proxy)",
      [ROUTER.toLowerCase()]: "Router (single-swap v3-router-v2)",
      [POOL.toLowerCase()]: "StablePool (StableSurge-hooked)",
      [PERMIT2.toLowerCase()]: "Permit2 (canonical singleton)",
      [WAGHO.toLowerCase()]: "waGHO (ERC4626 StaticATokenLM proxy)",
      [WAUSDC.toLowerCase()]: "waUSDC (ERC4626 StaticATokenLM proxy)",
      "0xb2007b8b7e0260042517f635cfd8e6dd2dd7f007": "StableSurgeHook",
      "0xf8cda16566a06f3c848258de4ec5fc3401cbb214": "waGHO rate provider",
      "0x0368b79b6a173a5ad589594e3227153d8cc7cecc": "waUSDC rate provider",
      "0x0e8b07657d719b86e06bf0806d6729e3d528c9a9": "VaultExtension (quote delegate)",
      "0xa238dd80c259a72e81d7e4664a9801593f98d1c5": "Aave Pool (proxy)",
    };
    return m[a] ?? "impl/lib/dep";
  };

  // ── Build the bytecode snapshot: eth_getCode every traced contract FRESH at the pinned block (WITH
  //    sha256 anchors); assert it equals the traced code (block-skew tripwire). ──
  const contracts: {
    address: Hex; role: string; runtime: Hex; runtimeSha256: Hex; touchedSlots: number;
  }[] = [];
  for (const a of Object.keys(graph).sort()) {
    const addr = getAddress(a as Hex) as Address;
    const runtime = await client.getCode({ address: addr, blockNumber: PIN_BLOCK });
    if (!runtime || runtime === "0x") {
      console.warn(`[bv3-snapshot] skip ${addr} — empty pinned-block code on source chain (system/precompile)`);
      delete graph[a];
      continue;
    }
    if (runtime.toLowerCase() !== graph[a].code.toLowerCase()) {
      // The swap-only contracts are traced on the fork; their code is identical to the source at the pinned
      // block (the fork forks that block), so a mismatch is a real block skew.
      throw new Error(`traced code != eth_getCode for ${addr} (block skew?)`);
    }
    contracts.push({
      address: addr, role: roleOf(a), runtime, runtimeSha256: sha256(runtime),
      touchedSlots: Object.keys(graph[a].storage).length,
    });
  }
  console.log(`[bv3-snapshot] final graph: ${contracts.length} contracts`);

  const bytecodeSnap = {
    chain: "base",
    chainId,
    block: PIN_BLOCK.toString(),
    blockTimestamp: blockTimestamp.toString(),
    source: "Balancer V3",
    vault: VAULT,
    router: ROUTER,
    pool: POOL,
    permit2: PERMIT2,
    contracts,
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── RE-READ every enumerated slot from the PRISTINE source RPC at the pinned block. The prestate traces
  //    enumerate WHICH slots the paths touch, but the SWAP trace ran on a LOCAL FORK where the setup transfer
  //    mutated the Vault/wrapper balance + `_reservesOf` slots — so their fork VALUES are polluted. The real
  //    on-chain value at the pinned block is the single source of truth: it reconstructs the pristine
  //    pre-swap state (the etch re-seeds `_reservesOf` after funding the caller anyway). This eliminates all
  //    fork mutation from the snapshot. ──
  const storageByContract: Record<string, Record<string, Hex>> = {};
  for (const a of Object.keys(graph).sort()) {
    const slots = Object.keys(graph[a].storage);
    if (slots.length === 0) continue;
    const addr = getAddress(a as Hex) as Address;
    const pristine: Record<string, Hex> = {};
    for (const slot of slots) {
      const val = (await client.getStorageAt({ address: addr, slot: slot as Hex, blockNumber: PIN_BLOCK })) ?? ("0x" + "0".repeat(64));
      pristine[slot.toLowerCase()] = pad(val as Hex, { size: 32 }) as Hex;
    }
    storageByContract[addr] = pristine;
  }

  // The Vault's live token balances at the pinned block == `_reservesOf` (the on-unlock invariant). Record
  // them so the etch can (a) fund the Vault and (b) seed `_reservesOf[token] = balanceOf(vault)`.
  const [vaultBalIn, vaultBalOut, reservesIn, reservesOut] = await Promise.all([
    client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [VAULT], blockNumber: PIN_BLOCK }) as Promise<bigint>,
    client.readContract({ address: tokenOut, abi: erc20Abi, functionName: "balanceOf", args: [VAULT], blockNumber: PIN_BLOCK }) as Promise<bigint>,
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "getReservesOf", args: [tokenIn], blockNumber: PIN_BLOCK }) as Promise<bigint>,
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: "getReservesOf", args: [tokenOut], blockNumber: PIN_BLOCK }) as Promise<bigint>,
  ]);

  const stateSnap = {
    chain: "base",
    chainId,
    block: PIN_BLOCK.toString(),
    blockTimestamp: blockTimestamp.toString(),
    source: "Balancer V3",
    vault: VAULT,
    router: ROUTER,
    pool: POOL,
    permit2: PERMIT2,
    tokenIn,
    tokenOut,
    tokenInSymbol: symIn,
    tokenOutSymbol: symOut,
    tokenInDecimals: decIn,
    tokenOutDecimals: decOut,
    // `_reservesOf` reconstruction anchors (mapping base slot 8). The etch seeds
    // `_reservesOf[token] = balanceOf(vault)` right before the swap (the on-unlock invariant).
    reservesOfBaseSlot: RESERVES_OF_BASE_SLOT.toString(),
    reservesOfSlotIn: mappingSlot(tokenIn, RESERVES_OF_BASE_SLOT),
    reservesOfSlotOut: mappingSlot(tokenOut, RESERVES_OF_BASE_SLOT),
    vaultBalanceIn: vaultBalIn.toString(),
    vaultBalanceOut: vaultBalOut.toString(),
    reservesOfIn: reservesIn.toString(),
    reservesOfOut: reservesOut.toString(),
    // Wei-exact anchor: the query ladders (== the real swap output).
    probe: {
      inToOut: probeSizesIn.map((amt, i) => ({ amountIn: amt.toString(), amountOut: quotesInToOut[i].toString() })),
      outToIn: probeSizesOut.map((amt, i) => ({ amountIn: amt.toString(), amountOut: quotesOutToIn[i].toString() })),
    },
    storage: storageByContract,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[bv3-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[bv3-snapshot] ${symIn}(${decIn}) -> ${symOut}(${decOut}); vault balances ` +
      `${vaultBalIn} ${symIn} / ${vaultBalOut} ${symOut}\n` +
      `  probe ${symIn}->${symOut}: ` +
      probeSizesIn.map((a, i) => `${a / unitIn}=>${quotesInToOut[i]}`).join(" ") +
      `\n  contracts: ${contracts.length}, total touched slots: ${contracts.reduce((s, c) => s + c.touchedSlots, 0)}`,
  );
}

/**
 * Boot a LOCAL anvil forked at the pinned block, set up a REAL successful swapSingleTokenExactIn (impersonate
 * the Vault to fund the caller + re-seed `_reservesOf` + Permit2 two-step approve), then prestate-trace the
 * swap so its fan-out enumerates the whole swap graph (incl. the swap-only Aave rewards controller + aToken).
 */
async function captureSwapPrestateOnFork(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Prestate> {
  const port = 8600 + Math.floor(Math.random() * 200);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn(
    "anvil",
    ["--fork-url", RPC, "--fork-block-number", PIN_BLOCK.toString(), "--port", String(port), "--no-request-size-limit"],
    { stdio: "ignore" },
  );
  try {
    // wait for the fork to accept requests
    const forkClient = createPublicClient({ transport: http(rpcUrl, { timeout: 60_000 }) });
    for (let i = 0; i < 60; i++) {
      try {
        await forkClient.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const test = createTestClient({ mode: "anvil", transport: http(rpcUrl) });
    const CALLER = getAddress("0x00000000000000000000000000000000000cA11E") as Address;
    // fund the caller with waUSDC by impersonating the Vault (a real StaticATokenLM transfer)
    await test.request({ method: "anvil_setBalance", params: [CALLER, toHex(10n ** 18n)] as any });
    await test.request({ method: "anvil_setBalance", params: [VAULT, toHex(10n ** 18n)] as any });
    await test.request({ method: "anvil_impersonateAccount", params: [VAULT] as any });
    const wcVault = createWalletClient({ account: VAULT, transport: http(rpcUrl) });
    const hFund = await wcVault.sendTransaction({
      to: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [CALLER, amountIn] }),
      account: VAULT, chain: null,
    });
    await forkClient.waitForTransactionReceipt({ hash: hFund });
    // re-seed `_reservesOf[token] = balanceOf(vault)` for BOTH tokens (restore the on-unlock invariant).
    for (const tok of [tokenIn, tokenOut]) {
      const bal = (await forkClient.readContract({ address: tok, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] })) as bigint;
      await test.request({ method: "anvil_setStorageAt", params: [VAULT, mappingSlot(tok, RESERVES_OF_BASE_SLOT), word(bal)] as any });
    }
    // Permit2 two-step approve from the caller.
    await test.request({ method: "anvil_impersonateAccount", params: [CALLER] as any });
    const wcCaller = createWalletClient({ account: CALLER, transport: http(rpcUrl) });
    const hAppr = await wcCaller.sendTransaction({
      to: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amountIn] }),
      account: CALLER, chain: null,
    });
    await forkClient.waitForTransactionReceipt({ hash: hAppr });
    const hP2 = await wcCaller.sendTransaction({
      to: PERMIT2, data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [tokenIn, ROUTER, amountIn, 281474976710655n] }),
      account: CALLER, chain: null,
    });
    await forkClient.waitForTransactionReceipt({ hash: hP2 });
    const ts = (await forkClient.getBlock()).timestamp;
    const swapData = encodeFunctionData({
      abi: routerAbi, functionName: "swapSingleTokenExactIn",
      args: [POOL, tokenIn, tokenOut, amountIn, 1n, ts + 100_000n, false, "0x"],
    });
    // prestate-trace the (now successful) swap.
    const trace = (await forkClient.request({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method: "debug_traceCall" as any,
      params: [{ from: CALLER, to: ROUTER, data: swapData }, "latest", { tracer: "prestateTracer" }] as any,
    })) as Prestate;
    const n = Object.values(trace).filter((v) => v.code && v.code !== "0x").length;
    console.log(`[bv3-snapshot] swap prestate (local fork): ${n} contracts`);
    return trace;
  } finally {
    anvil.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
