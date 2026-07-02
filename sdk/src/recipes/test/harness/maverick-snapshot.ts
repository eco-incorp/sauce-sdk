/**
 * One-time capture of a REAL Maverick V2 (bin-based directional AMM) pool + its MaverickV2Quoter from
 * BSC mainnet, so the Maverick prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/solidly-snapshot.ts + dodo-snapshot.ts (the proven pattern): eth_getCode the pool's
 * REAL runtime AND every dependency the swap / quote path touches — into a checked-in bytecode snapshot
 * (WITH sha256 integrity anchors) — and the swap-relevant STATE (the active bin/tick WINDOW around the
 * active tick) into a state snapshot, as RAW storage slots (keyed by their computed slot hash) so the
 * offline test reconstructs the pool byte-identically via setStorageAt. Block pinned. The RPC url / key
 * is NEVER persisted — only contract CODE + STATE.
 *
 * WHICH POOL: the DEEPEST on-charter all-stablecoin Maverick V2 pool the wired
 * FactoryType.MaverickV2Factory discovery reaches, across the Eco chains where the Maverick V2 factory
 * (0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e — the same deterministic address on base/ethereum/bsc) is
 * configured. Enumerated via the factory `lookup(tokenA, tokenB, 0, N)` across {USDC, USDT} both
 * orderings and ranked by in-pool reserves. The deepest all-stablecoin Maverick V2 pool across all
 * three Eco chains is the BSC USDT/USDC pool 0x0843924689E0451885633c31CD135658e2EC3eEA (~$23.5k,
 * far deeper than the best Base DAI/USDC ≈$10.9k or Ethereum USDC/USDT ≈$7.9k). ON-CHARTER stables
 * (USDT + USDC are both BSC baseTokens), but SHALLOW — Maverick's deep liquidity is in its volatile
 * WETH / BTC pairs, not the near-abandoned stable pairs (the same story as DODO's stable venues).
 *
 * ENGINE tickLimit (../sauce PR #193 — the OLD tickLimit=0 gate is gone). The FIXED engine
 * `_swapMaverickV2` passes a per-direction FULL-RANGE tickLimit (type(int32).max for tokenA-in,
 * type(int32).min for tokenB-in), so a swap walks the WHOLE live tick book bounded only by liquidity, in
 * EITHER direction — there is no active-tick side gate anymore. This pool's tokenA is USDT, tokenB is
 * USDC, activeTick = +7; this prod-mirror exercises the tokenB-in direction (USDC -> USDT), sizing the
 * trade within the pool's available output (tokenA/USDT) reserve.
 *
 * DEPENDENCY CONTRACTS captured (every contract the swap / quote path touches):
 *   1. the pool runtime at the captured BSC address (self-contained — NOT a proxy),
 *   2. the MaverickV2Quoter runtime (0xb40AfdB85a07f37aE217E7D6462e609900dD8D7A on BSC, self-contained,
 *      NOT a proxy). calculateSwap(pool, amount, tokenAIn, exactOutput, tickLimit) is the wei-exact
 *      ground truth the prod-mirror test cross-checks the engine swap against — it takes the pool as an
 *      ARGUMENT and CALLs only the pool, so it needs no further dependency (verified: no live embedded
 *      contract address in its runtime). tokenA/tokenB are ERC20s the test repoints to local mints.
 *
 * STATE captured (the active bin/tick WINDOW — the CL-tick-window analogue for a bin AMM):
 *   - the State struct (packed slots 4,5): reserveA/reserveB + activeTick/binCounter/protocolFeeRatioD3,
 *   - `_ticks[int32]` (mapping base slot 3, 3 words/entry: word0=reserveA|reserveB, word1=totalSupply,
 *     word2=binIdsByTick packed) for every tick in [activeTick - WINDOW, activeTick + WINDOW],
 *   - `_bins[uint32]` (mapping base slot 2, 2 words/entry: word0=mergeBinBalance|tickBalance,
 *     word1=totalSupply|kind|tick|mergeId) for every binId referenced by any captured tick,
 *   captured as RAW (slot -> value) pairs the offline test replays with setStorageAt. The mapping bases
 *   were verified against getTick / getBin / getState on the live pool (see the probe in the git
 *   history). A swap only touches the active tick + the bins it crosses, so this window is exactly the
 *   state the tick 7 -> 0 walk reads.
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   BSC_RPC_URL=$BSC_RPC_URL npx tsx src/recipes/test/harness/maverick-snapshot.ts
 * (optional argv[2] = RPC url; the deepest-pool discovery re-runs each time so the pinned pool/block
 * stay current.)
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
  pad,
  toHex,
  zeroAddress,
  type Hex,
  type Address,
  type PublicClient,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "bsc-maverick-USDTUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The Maverick V2 factory (same deterministic address on base/ethereum/bsc — see constants.ts).
const MAVERICK_FACTORY = getAddress("0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e") as Address;
// The MaverickV2Quoter on BSC (the calculateSwap ground truth). Self-contained, not a proxy.
const MAVERICK_QUOTER = getAddress("0xb40AfdB85a07f37aE217E7D6462e609900dD8D7A") as Address;

// BSC on-charter stables (see constants.ts CHAIN_POOL_CONFIGS.bsc.baseTokens — 18 decimals on BSC).
const USDC = getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d") as Address;
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955") as Address;
const STABLES = [USDC, USDT] as const;

// How many ticks on each side of the active tick to capture (matches ECO_MAVERICK_TICK_WINDOW default).
const TICK_WINDOW = Number(process.env.ECO_MAVERICK_TICK_WINDOW ?? 40);

// The OLD-engine tick limit this capture picked its direction under (the engine was later made full-range —
// ../sauce PR #193; maverick-math.ts now exports MAVERICK_ENGINE_TICK_LIMIT_MAX/_MIN). Kept as-is: the
// checked-in BSC snapshot was captured with a tokenB-in direction (activeTick 7 >= 0) that the old engine
// could already fill, so it stays a valid full wei-exact real swap under the full-range engine too — no
// recapture needed. This tool only documents how that frozen snapshot was taken.
const ENGINE_TICK_LIMIT = 0;

// Verified real Maverick V2 Pool storage layout (BSC pool, matched against getState/getTick/getBin):
//   State struct: slot 4 = reserveA(lo128)|reserveB(hi128); slot 5 = packed activeTick/binCounter/...
//   _ticks[int32] mapping base slot = 3, 3 words/entry.
//   _bins[uint32]  mapping base slot = 2, 2 words/entry.
const STATE_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8]; // low window (State at 4,5) + safety margin
const TICKS_BASE_SLOT = 3;
const TICK_WORDS = 3;
const BINS_BASE_SLOT = 2;
const BIN_WORDS = 2;

const RPC = process.argv[2] || process.env.BSC_RPC_URL || process.env.BSC_RPC || "";
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set BSC_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const factoryAbi = parseAbi([
  "function lookup(address tokenA, address tokenB, uint256 startIndex, uint256 endIndex) external view returns (address[] pools)",
]);
const poolAbi = parseAbi([
  "function tokenA() external view returns (address)",
  "function tokenB() external view returns (address)",
  "function tickSpacing() external view returns (uint256)",
  "function fee(bool tokenAIn) external view returns (uint256)",
  "function factory() external view returns (address)",
  "function getState() external view returns ((uint128 reserveA, uint128 reserveB, int64 lastTwaD8, int64 lastLogPriceD8, uint40 lastTimestamp, int32 activeTick, bool isLocked, uint32 binCounter, uint8 protocolFeeRatioD3) state)",
  "function getTick(int32 tick) external view returns ((uint128 reserveA, uint128 reserveB, uint128 totalSupply, uint32[4] binIdsByTick) tickState)",
  "function getBin(uint32 binId) external view returns ((uint128 mergeBinBalance, uint128 tickBalance, uint128 totalSupply, uint8 kind, int32 tick, uint32 mergeId) bin)",
]);
const quoterAbi = parseAbi([
  "function calculateSwap(address pool, uint128 amount, bool tokenAIn, bool exactOutput, int32 tickLimit) external returns (uint256 amountIn, uint256 amountOut, uint256 gasEstimate)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** Detect an EIP-1167 minimal proxy and extract its implementation address (mirrors dodo/solidly). */
function parseMinimalProxy(code: string): Hex | null {
  const m = code.match(/^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/);
  if (m) return getAddress(("0x" + m[1]) as Hex);
  const m2 = code.match(/363d3d373d3d3d363d73([0-9a-fA-F]{40})5af4/);
  if (m2) return getAddress(("0x" + m2[1]) as Hex);
  return null;
}

const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

// ── mapping-slot helpers (Solidity `mapping(K => V)` at base slot `b`: keccak256(keyWord . bWord)) ──
function int32Word(tick: number): Hex {
  return pad(toHex(BigInt.asUintN(256, BigInt(tick))), { size: 32 });
}
function uint32Word(id: number): Hex {
  return pad(toHex(BigInt(id)), { size: 32 });
}
function mapSlot(keyWord: Hex, base: number): Hex {
  return keccak256((keyWord + pad(toHex(BigInt(base)), { size: 32 }).slice(2)) as Hex);
}
function addSlot(slot: Hex, n: number): Hex {
  return pad(toHex(BigInt(slot) + BigInt(n)), { size: 32 });
}
function slotHex(n: number): Hex {
  return pad(toHex(BigInt(n)), { size: 32 });
}

const ZERO32 = ("0x" + "0".repeat(64)) as Hex;

async function readSlot(client: PublicClient, address: Address, slot: Hex): Promise<Hex> {
  const v = await client.getStorageAt({ address, slot });
  return (v ?? ZERO32) as Hex;
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 180_000 }) }) as PublicClient;
  const chainId = await client.getChainId();
  if (chainId !== 56) {
    console.warn(`[maverick-snapshot] WARNING: chainId ${chainId} != BSC (56)`);
  }
  const block = await client.getBlockNumber();
  console.log(`[maverick-snapshot] BSC chainId=${chainId} block=${block}`);

  const facCode = await client.getCode({ address: MAVERICK_FACTORY }).catch(() => undefined);
  if (!facCode || facCode === "0x") throw new Error(`Maverick factory ${MAVERICK_FACTORY} has NO code on this RPC`);

  // ── Discover every stable-pair Maverick V2 pool via lookup(base, quote) both orderings + rank by depth. ──
  const decOf = new Map<string, number>();
  for (const t of STABLES) {
    decOf.set(t.toLowerCase(), Number(await client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" })));
  }

  const seen = new Set<string>();
  const candidates: {
    pool: Address;
    tokenA: Address;
    tokenB: Address;
    reserveA: bigint;
    reserveB: bigint;
    activeTick: number;
    tickSpacing: number;
    protocolFeeD3: number;
    binCounter: number;
    depthUsd: number;
    tokenBInExecutable: boolean;
  }[] = [];

  for (const A of STABLES) {
    for (const B of STABLES) {
      if (A === B) continue;
      let addrs: readonly Address[] = [];
      try {
        addrs = (await client.readContract({
          address: MAVERICK_FACTORY,
          abi: factoryAbi,
          functionName: "lookup",
          args: [A, B, 0n, 20n],
        })) as Address[];
      } catch {
        continue;
      }
      for (const addr of addrs) {
        if (!addr || addr === zeroAddress) continue;
        const key = addr.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const [tokenA, tokenB, state, tsRaw] = await Promise.all([
            client.readContract({ address: addr, abi: poolAbi, functionName: "tokenA" }) as Promise<Address>,
            client.readContract({ address: addr, abi: poolAbi, functionName: "tokenB" }) as Promise<Address>,
            client.readContract({ address: addr, abi: poolAbi, functionName: "getState" }) as Promise<any>,
            client.readContract({ address: addr, abi: poolAbi, functionName: "tickSpacing" }) as Promise<bigint>,
          ]);
          const da = decOf.get(tokenA.toLowerCase()) ?? 18;
          const db = decOf.get(tokenB.toLowerCase()) ?? 18;
          const depthUsd = Number(state.reserveA) / 10 ** da + Number(state.reserveB) / 10 ** db;
          const activeTick = Number(state.activeTick);
          // tokenB-in (walks DOWN toward tick 0) is engine-executable iff activeTick >= ENGINE_TICK_LIMIT.
          const tokenBInExecutable = activeTick >= ENGINE_TICK_LIMIT;
          candidates.push({
            pool: addr,
            tokenA: getAddress(tokenA),
            tokenB: getAddress(tokenB),
            reserveA: state.reserveA,
            reserveB: state.reserveB,
            activeTick,
            tickSpacing: Number(tsRaw),
            protocolFeeD3: Number(state.protocolFeeRatioD3),
            binCounter: Number(state.binCounter),
            depthUsd,
            tokenBInExecutable,
          });
        } catch {
          /* non-Maverick surface / partial pool — skip */
        }
      }
    }
  }

  candidates.sort((a, b) => b.depthUsd - a.depthUsd);
  if (candidates.length === 0) throw new Error("no stable-pair Maverick V2 pool found on BSC");
  console.log(`[maverick-snapshot] ${candidates.length} stable-pair Maverick V2 pools; top candidates:`);
  for (const c of candidates.slice(0, 6)) {
    console.log(
      `  ${c.pool} depth≈$${c.depthUsd.toFixed(0)} activeTick=${c.activeTick} ts=${c.tickSpacing} ` +
        `tokenB-in engine-executable=${c.tokenBInExecutable}`,
    );
  }
  // Pick the deepest pool this fixture exercises in the tokenB-in direction (both directions are now
  // engine-executable under the full-range tickLimit — ../sauce PR #193; the fixture drives tokenB-in).
  const top = candidates.find((c) => c.tokenBInExecutable) ?? candidates[0];
  const pool = top.pool;
  console.log(
    `[maverick-snapshot] chosen pool = ${pool} (depth≈$${top.depthUsd.toFixed(0)}, activeTick=${top.activeTick})`,
  );

  // ── Bytecode: the pool runtime + the quoter runtime (both self-contained, verify not a proxy). ──
  const poolCode = await client.getCode({ address: pool });
  if (!poolCode || poolCode === "0x") throw new Error(`empty code at pool ${pool}`);
  const poolProxy = parseMinimalProxy(poolCode);
  if (poolProxy) throw new Error(`pool ${pool} is a minimal proxy -> ${poolProxy} (unexpected; extend capture)`);
  console.log(`[maverick-snapshot] pool runtime = ${poolCode.length / 2 - 1} bytes (self-contained)`);

  const quoterCode = await client.getCode({ address: MAVERICK_QUOTER });
  if (!quoterCode || quoterCode === "0x") throw new Error(`empty code at quoter ${MAVERICK_QUOTER}`);
  const quoterProxy = parseMinimalProxy(quoterCode);
  if (quoterProxy) throw new Error(`quoter is a minimal proxy -> ${quoterProxy} (unexpected; extend capture)`);
  console.log(`[maverick-snapshot] quoter runtime = ${quoterCode.length / 2 - 1} bytes (self-contained)`);

  // ── Swap-relevant STATE via the pool's own getters (the ground truth the test asserts against). ──
  const [tokenA, tokenB, tickSpacingRaw, feeAIn, feeBIn, factoryOnPool, state] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "tokenA" }) as Promise<Address>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "tokenB" }) as Promise<Address>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "tickSpacing" }) as Promise<bigint>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "fee", args: [true] }) as Promise<bigint>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "fee", args: [false] }) as Promise<bigint>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "factory" }).catch(() => zeroAddress as Address) as Promise<Address>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "getState" }) as Promise<any>,
  ]);
  const activeTick = Number(state.activeTick);
  const tickSpacing = Number(tickSpacingRaw);

  const [decA, decB, symA, symB] = await Promise.all([
    client.readContract({ address: getAddress(tokenA), abi: erc20Abi, functionName: "decimals" }).then(Number),
    client.readContract({ address: getAddress(tokenB), abi: erc20Abi, functionName: "decimals" }).then(Number),
    client.readContract({ address: getAddress(tokenA), abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    client.readContract({ address: getAddress(tokenB), abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
  ]);

  // ── Active bin/tick WINDOW: getTick over [activeTick - WINDOW, activeTick + WINDOW], collecting the
  //    per-tick reserves AND every referenced binId, then getBin for each. Decoded ground truth. ──
  const tickLo = activeTick - TICK_WINDOW;
  const tickHi = activeTick + TICK_WINDOW;
  const decodedTicks: {
    tick: number;
    reserveA: string;
    reserveB: string;
    totalSupply: string;
    binIdsByTick: number[];
  }[] = [];
  const referencedBinIds = new Set<number>();
  for (let t = tickLo; t <= tickHi; t++) {
    let tk: any;
    try {
      tk = await client.readContract({ address: pool, abi: poolAbi, functionName: "getTick", args: [t] });
    } catch {
      continue;
    }
    if (tk.reserveA === 0n && tk.reserveB === 0n) continue;
    const binIds = (tk.binIdsByTick as readonly number[]).map((x) => Number(x));
    for (const b of binIds) if (b !== 0) referencedBinIds.add(b);
    decodedTicks.push({
      tick: t,
      reserveA: tk.reserveA.toString(),
      reserveB: tk.reserveB.toString(),
      totalSupply: tk.totalSupply.toString(),
      binIdsByTick: binIds,
    });
  }
  const decodedBins: {
    binId: number;
    mergeBinBalance: string;
    tickBalance: string;
    totalSupply: string;
    kind: number;
    tick: number;
    mergeId: number;
  }[] = [];
  for (const bid of [...referencedBinIds].sort((a, b) => a - b)) {
    let b: any;
    try {
      b = await client.readContract({ address: pool, abi: poolAbi, functionName: "getBin", args: [bid] });
    } catch {
      continue;
    }
    decodedBins.push({
      binId: bid,
      mergeBinBalance: b.mergeBinBalance.toString(),
      tickBalance: b.tickBalance.toString(),
      totalSupply: b.totalSupply.toString(),
      kind: Number(b.kind),
      tick: Number(b.tick),
      mergeId: Number(b.mergeId),
    });
  }

  // ── RAW storage window (slot -> value) for deterministic setStorageAt reconstruction. ──
  const storage: Record<string, Hex> = {};
  // (1) State + low-slot safety window.
  for (const s of STATE_SLOTS) storage[slotHex(s)] = await readSlot(client, pool, slotHex(s));
  // (2) _ticks[int32] × TICK_WORDS for every tick in the window (whether or not it decoded nonzero:
  //     capture ONLY the ticks that carry liquidity — the walk skips empties, and empty slots are 0).
  for (const dt of decodedTicks) {
    const baseHash = mapSlot(int32Word(dt.tick), TICKS_BASE_SLOT);
    for (let off = 0; off < TICK_WORDS; off++) {
      const slot = addSlot(baseHash, off);
      storage[slot] = await readSlot(client, pool, slot);
    }
  }
  // (3) _bins[uint32] × BIN_WORDS for every referenced bin.
  for (const db of decodedBins) {
    const baseHash = mapSlot(uint32Word(db.binId), BINS_BASE_SLOT);
    for (let off = 0; off < BIN_WORDS; off++) {
      const slot = addSlot(baseHash, off);
      storage[slot] = await readSlot(client, pool, slot);
    }
  }

  // ── Quoter probe(s) — the wei-exact ground truth the offline prod-mirror test reproduces. The
  //    engine-executable direction is tokenB-in (USDC -> tokenA/USDT), walking DOWN from activeTick=+7
  //    toward tickLimit=0. Probe a few sizes within the reachable range. calculateSwap is state-mutating
  //    in signature (returns via revert-free path) → simulate. ──
  const probeSizes = [
    100n * 10n ** BigInt(decB),
    1_000n * 10n ** BigInt(decB),
    5_000n * 10n ** BigInt(decB),
  ];
  const probes: { direction: string; tokenAIn: boolean; amountIn: string; amountInUsed: string; amountOut: string; gasEstimate: string }[] = [];
  for (const amt of probeSizes) {
    try {
      const sim = await client.simulateContract({
        address: MAVERICK_QUOTER,
        abi: quoterAbi,
        functionName: "calculateSwap",
        args: [pool, amt, false /* tokenB-in */, false /* exactInput */, ENGINE_TICK_LIMIT],
      });
      const res = sim.result as readonly [bigint, bigint, bigint];
      probes.push({
        direction: `${symB}->${symA} (tokenB-in)`,
        tokenAIn: false,
        amountIn: amt.toString(),
        amountInUsed: res[0].toString(),
        amountOut: res[1].toString(),
        gasEstimate: res[2].toString(),
      });
    } catch (e) {
      probes.push({
        direction: `${symB}->${symA} (tokenB-in)`,
        tokenAIn: false,
        amountIn: amt.toString(),
        amountInUsed: "REVERT",
        amountOut: (e as Error).message.split("\n")[0],
        gasEstimate: "0",
      });
    }
  }

  // ── Write the bytecode snapshot (WITH sha256 anchors). ──
  const bytecodeSnap = {
    chain: "bsc",
    block: block.toString(),
    pool: { address: pool, runtime: poolCode, runtimeSha256: sha256(poolCode) },
    isMinimalProxy: false,
    // Dependency contracts beyond the pool (every contract the swap / quote path touches).
    dependencies: [
      {
        name: "maverickV2Quoter",
        address: MAVERICK_QUOTER,
        runtime: quoterCode,
        runtimeSha256: sha256(quoterCode),
      },
    ],
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Write the state snapshot. ──
  const stateSnap = {
    chain: "bsc",
    chainId,
    block: block.toString(),
    pool,
    factory: MAVERICK_FACTORY,
    factoryOnPool,
    quoter: MAVERICK_QUOTER,
    tokenA: getAddress(tokenA),
    tokenB: getAddress(tokenB),
    tokenASymbol: symA,
    tokenBSymbol: symB,
    tokenADecimals: decA,
    tokenBDecimals: decB,
    tickSpacing,
    feeAIn: feeAIn.toString(),
    feeBIn: feeBIn.toString(),
    protocolFeeRatioD3: Number(state.protocolFeeRatioD3),
    engineTickLimit: ENGINE_TICK_LIMIT,
    // The direction this fixture exercises (tokenB-in walks DOWN from activeTick). Both directions are
    // engine-executable under the full-range tickLimit (../sauce PR #193).
    engineExecutableDirection: `${symB}->${symA} (tokenB-in)`,
    engineTokenAIn: false,
    state: {
      reserveA: state.reserveA.toString(),
      reserveB: state.reserveB.toString(),
      activeTick,
      binCounter: Number(state.binCounter),
      isLocked: Boolean(state.isLocked),
      lastTimestamp: Number(state.lastTimestamp),
      lastTwaD8: state.lastTwaD8.toString(),
      lastLogPriceD8: state.lastLogPriceD8.toString(),
    },
    tickWindow: { lo: tickLo, hi: tickHi, window: TICK_WINDOW },
    // Decoded active bin/tick window (the CL-tick-window analogue for a bin AMM).
    ticks: decodedTicks,
    bins: decodedBins,
    // Storage-layout provenance (verified against getState/getTick/getBin on the live pool).
    storageLayout: {
      stateSlots: STATE_SLOTS,
      ticksBaseSlot: TICKS_BASE_SLOT,
      tickWords: TICK_WORDS,
      binsBaseSlot: BINS_BASE_SLOT,
      binWords: BIN_WORDS,
    },
    // Captured quoter probes — the exact-in-dy self-check the offline test reproduces.
    probes,
    // Raw storage window (slot -> value) for deterministic setStorageAt reconstruction.
    storage,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[maverick-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[maverick-snapshot] state: ${symA}(${decA})=tokenA / ${symB}(${decB})=tokenB tickSpacing=${tickSpacing}\n` +
      `  activeTick=${activeTick} reserveA=${state.reserveA} reserveB=${state.reserveB} protocolFeeD3=${Number(state.protocolFeeRatioD3)}\n` +
      `  feeAIn=${feeAIn} feeBIn=${feeBIn} binCounter=${Number(state.binCounter)}\n` +
      `  captured ${decodedTicks.length} live ticks in [${tickLo}, ${tickHi}], ${decodedBins.length} bins, ${Object.keys(storage).length} raw slots\n` +
      `  fixture direction: ${symB}->${symA} (tokenB-in), full-range tickLimit\n` +
      probes
        .map((p) => `  probe calculateSwap(${p.amountIn} ${symB}) -> in=${p.amountInUsed} out=${p.amountOut} gas=${p.gasEstimate}`)
        .join("\n"),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
