/**
 * One-time capture of a REAL Trader Joe (LFJ) Liquidity Book v2.2 LBPair from Arbitrum mainnet,
 * so the LB prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/solidly-snapshot.ts / dodo-snapshot.ts / woofi-snapshot.ts (the proven pattern):
 * eth_getCode the pair's REAL runtime + every dependency the swap/quote path touches, into a
 * checked-in bytecode snapshot (WITH sha256 integrity anchors), and the swap-relevant STATE (the
 * active bin id + a WINDOW of bin reserves around it, the fee params, binStep, tokens, decimals,
 * plus the raw storage slots that back them) into a state snapshot. Block pinned. The RPC url / key
 * is NEVER persisted — only contract CODE + on-chain STATE.
 *
 * BIN-AMM MODEL. A Liquidity Book pair is a DISCRETE-BIN AMM: liquidity is quantized into fixed-price
 * bins. A swap only touches the ACTIVE bin plus the bins it crosses in the swap direction — the exact
 * analogue of a concentrated-liquidity tick window. So we capture the active bin id + a symmetric
 * WINDOW of bins around it (each bin's reserveX/reserveY via getBin) and reconstruct just that window,
 * NOT the whole book — the same bounded-window fidelity the CL prod-mirror uses for ticks.
 *
 * WHICH POOL: the DEEPEST on-charter STABLE-pair LBPair the wired FactoryType.TraderJoeLB discovery
 * reaches. Discovery enumerates the LB v2.2 factory (0x8e42…Fd4e — the ONLY TraderJoeLB factory wired
 * in constants.ts, on ARBITRUM) via getLBPairInformation(tokenX, tokenY, binStep) across the standard
 * bin steps {1,5,10,15,20,25} for the Arbitrum stablecoin baseTokens {USDC, DAI, USDT}. The deepest
 * such pair is USDC/USDT binStep=1.
 *
 * ⚠️ FIDELITY / DEPTH DISCLOSURE (honest): LB stable depth on Eco chains is THIN. LB's deep books are
 * on AVALANCHE, which is NOT an Eco chain. On Arbitrum (the only Eco chain with a wired LB factory)
 * the deepest STABLE LBPair reachable is the USDC/USDT bs=1 pair 0xFC43…7427 — only ≈$2.6k total
 * across its bins at capture. This is a FALLBACK (deepest stable-inclusive on an Eco chain), NOT a
 * deep on-charter book. It is nonetheless a GENUINE, fully on-charter (both tokens are Arbitrum
 * baseTokens), correctly-discovered LBPair with real bin liquidity on both sides of the active bin —
 * exactly what the prod-mirror needs to run the REAL bin-crossing code offline. Flagged in the return.
 *
 * ADDRESS-IMMUTABLE-CLONE NOTE (why the impl must sit at its captured address, and where tokens live).
 * An LB v2.2 LBPair is an IMMUTABLE-ARGS CLONE (LFJ Clones-with-immutable-args), NOT an EIP-1167
 * minimal proxy: the 97-byte proxy runtime is
 *   363d3d373d3d3d3d61002c806035363936013d73<impl:20>5af43d3d93803e603357fd5bf3<tokenX:20><tokenY:20><binStep:2>
 * i.e. it delegatecalls a fixed IMPLEMENTATION and appends the IMMUTABLE ARGS (tokenX, tokenY,
 * binStep) to the calldata. So:
 *   • the implementation runtime (0x3e30…2d8f, ≈22.5 kB) must be etched at ITS captured address (the
 *     proxy hard-codes it — same immutable constraint as the V4 StateView→PoolManager etch), and
 *   • tokenX / tokenY / binStep are NOT in storage — they are baked into the PROXY BYTECODE. The
 *     offline test therefore repoints tokens by ONE of: (a) etching local MintableERC20s AT the real
 *     tokenX/tokenY addresses (the immutable-args constraint, the cleanest), or (b) rewriting the
 *     proxy's appended arg bytes to local token addresses. We capture the decoded immutable args +
 *     their byte offsets so either path is deterministic. The per-bin reserves DO live in storage
 *     (the LBPair `_bins` mapping, base slot 7: keccak256(abi.encode(uint256(id), uint256(7))) →
 *     bytes32 packing (reserveX<<128 | reserveY)), plus the packed fee/oracle param slots (3..8) — all
 *     captured raw for deterministic setStorageAt reconstruction of the active-bin WINDOW. NOTE the
 *     packing order verified on-chain at capture is (reserveY << 128 | reserveX) — the HIGH 128 bits
 *     hold reserveY, the LOW 128 bits hold reserveX (confirmed identical across all 65 captured bins).
 *
 * DEPENDENCY CONTRACTS captured (every contract the getSwapOut staticcall + transfer+swap path touches):
 *   1. the LBPair proxy runtime (97-byte immutable-args clone) at the captured Arbitrum address,
 *   2. the LBPair IMPLEMENTATION runtime (the delegate the proxy forwards to — all bin/fee/swap math).
 * The pair reads NOTHING else on the quote/swap path (no external oracle, no factory call in getSwapOut
 * or swap — the fee params are self-contained in the pair's own packed storage; tokenX/tokenY are the
 * immutable args). The factory is used ONLY off-chain by discovery (getLBPairInformation), reproduced
 * by a tiny shim in the test — it is NOT on the swap path, so its runtime is not captured here.
 *
 * Quote view: getSwapOut(uint128 amountIn, bool swapForY) → (amountInLeft, amountOut, fee).
 * Execution (callback-free): getSwapOut staticcall → transfer amountIn to the pair → pair.swap(swapForY,
 * to) (the engine _swapTraderJoeLB resolves swapForY on-chain from getTokenX()).
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   ARBITRUM_RPC_URL=$ARBITRUM_RPC_URL npx tsx src/recipes/test/harness/lb-snapshot.ts
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
  keccak256,
  encodeAbiParameters,
  pad,
  toHex,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const NAME = "arbitrum-lb-USDCUSDT";
const BYTECODE_OUT = join(SNAP_DIR, `${NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${NAME}.state.json`);

// Arbitrum stablecoin baseTokens (constants.ts arbitrum.baseTokens minus WETH/WBTC).
const USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831") as Address;
const DAI = getAddress("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1") as Address;
const USDT = getAddress("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9") as Address;
const STABLES = [USDC, DAI, USDT] as const;

// The ONLY TraderJoeLB factory wired in constants.ts (Arbitrum, LB v2.2).
const LB_FACTORY = getAddress("0x8e42f2F4101563bF679975178e880FD87d3eFd4e") as Address;

// The standard LB bin steps discovery queries (constants.ts TRADER_JOE_BIN_STEPS).
const BIN_STEPS = [1, 5, 10, 15, 20, 25] as const;

// How many bins on EACH side of the active bin to capture (the reconstructed swap window). A swap only
// crosses bins in the swap direction from the active bin, so a symmetric window covers both directions.
// 32 each side is far wider than this thin book's ~40-bin total span and than any test swap will cross.
const BIN_WINDOW = 32;

// LBPair `_bins` mapping base slot (verified on-chain at capture: keccak256(abi.encode(uint256(id),
// uint256(7))) → bytes32 packing (reserveX<<128 | reserveY), matching getBin(id)). Captured raw so the
// test can setStorageAt-reconstruct the window bins byte-identically.
// Packing order verified across all captured bins: the bytes32 value is (reserveY << 128 | reserveX)
// — HIGH 128 bits = reserveY, LOW 128 bits = reserveX. (Recorded here for the reconstruction author.)
const BINS_MAPPING_SLOT = 7;

// LBPair `_tree` (TreeMath.TreeUint24) struct base slot — VERIFIED on-chain at capture (slots 8/9/10):
//   struct TreeUint24 { bytes32 level0; mapping(bytes32 => bytes32) level1; mapping(bytes32 => bytes32) level2; }
// level0 is a single bytes32 at slot 8; level1 is a mapping at base slot 9 (key = bytes32(id >> 16));
// level2 is a mapping at base slot 10 (key = bytes32(id >> 8)). The pair's swap/getSwapOut walk uses this
// bitmap tree (findFirstRight/Left) to locate the NEXT initialized bin — so a faithful offline reconstruction
// MUST reconstruct the tree slots for every group the window bins touch, or the etched pair will find ONLY the
// active bin and stop (drained-active-bin-only, no bin crossing). We capture level0 + the level1/level2 mapping
// slots for every group the window ids fall into (2 groups per level for a window straddling the 2^23 anchor).
const TREE_BASE_SLOT = 8; // level0 at 8, level1 mapping at 9, level2 mapping at 10

// Low packed param slots to capture verbatim (fee params / oracle sample / active id / reserves live
// packed in slots 3..8 on the LB v2.2 pair; a generous 0..11 window is captured for provenance).
const PARAM_SLOT_COUNT = 12;

const RPC =
  process.argv[2] ||
  process.env.ARBITRUM_RPC_URL ||
  process.env.ARB_RPC_URL ||
  "";
if (!RPC) {
  console.error(
    "no RPC — pass one as argv[2] or set ARBITRUM_RPC_URL (set -a; . sdk/.env; set +a)",
  );
  process.exit(1);
}

const factoryAbi = parseAbi([
  "function getLBPairInformation(address tokenX, address tokenY, uint256 binStep) view returns (uint256 binStep2, address LBPair, bool createdByOwner, bool ignoredForRouting)",
  "function getLBPairImplementation() view returns (address)",
]);
const pairAbi = parseAbi([
  "function getReserves() view returns (uint128 reserveX, uint128 reserveY)",
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
  "function getActiveId() view returns (uint24 activeId)",
  "function getBinStep() view returns (uint16 binStep)",
  "function getBin(uint24 id) view returns (uint128 binReserveX, uint128 binReserveY)",
  "function getStaticFeeParameters() view returns (uint16 baseFactor, uint16 filterPeriod, uint16 decayPeriod, uint16 reductionFactor, uint24 variableFeeControl, uint16 protocolShare, uint24 maxVolatilityAccumulator)",
  "function getVariableFeeParameters() view returns (uint24 volatilityAccumulator, uint24 volatilityReference, uint24 idReference, uint40 timeOfLastUpdate)",
  "function getSwapOut(uint128 amountIn, bool swapForY) view returns (uint128 amountInLeft, uint128 amountOut, uint128 fee)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const sha256 = (hex: string) =>
  ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

/**
 * Decode an LB v2.2 immutable-args clone runtime. Layout:
 *   363d3d373d3d3d3d61002c806035363936013d73<impl:20>5af43d3d93803e603357fd5bf3<tokenX:20><tokenY:20><binStep:2>
 * Returns the impl address + the appended immutable args (tokenX, tokenY, binStep) with byte offsets,
 * or null if it is not this clone shape.
 */
function decodeImmutableClone(code: string): {
  impl: Address;
  tokenX: Address;
  tokenY: Address;
  binStep: number;
  argsHex: Hex;
  argsByteOffset: number; // offset (in runtime bytes) where the immutable args begin
} | null {
  const hex = code.startsWith("0x") ? code.slice(2) : code;
  const TAIL = "5af43d3d93803e603357fd5bf3";
  const tailIdx = hex.indexOf(TAIL);
  if (tailIdx < 0) return null;
  // impl is the PUSH20 immediately before the delegatecall tail (…73<impl:20>5af4…).
  const implHex = hex.slice(tailIdx - 40, tailIdx);
  if (!/^[0-9a-fA-F]{40}$/.test(implHex)) return null;
  const argsStart = tailIdx + TAIL.length;
  const args = hex.slice(argsStart);
  if (args.length < 84) return null; // need tokenX(40)+tokenY(40)+binStep(4) chars
  return {
    impl: getAddress(("0x" + implHex) as Hex) as Address,
    tokenX: getAddress(("0x" + args.slice(0, 40)) as Hex) as Address,
    tokenY: getAddress(("0x" + args.slice(40, 80)) as Hex) as Address,
    binStep: parseInt(args.slice(80, 84), 16),
    argsHex: ("0x" + args) as Hex,
    argsByteOffset: argsStart / 2,
  };
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 180_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 42161) {
    console.warn(`[lb-snapshot] WARNING: chainId ${chainId} != Arbitrum (42161)`);
  }
  const block = await client.getBlockNumber();
  const blk = await client.getBlock({ blockNumber: block });
  console.log(`[lb-snapshot] Arbitrum chainId=${chainId} block=${block} ts=${blk.timestamp}`);

  const decOf = new Map<string, number>();
  const symOf = new Map<string, string>();
  for (const t of STABLES) {
    decOf.set(
      t.toLowerCase(),
      Number(await client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" })),
    );
    symOf.set(
      t.toLowerCase(),
      (await client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => "?")) as string,
    );
  }

  // ── Discover every stable-pair LBPair via getLBPairInformation(tokenX, tokenY, binStep). ──
  const seen = new Set<string>();
  const candidates: {
    pair: Address;
    binStep: number;
    activeId: number;
    tokenX: Address;
    tokenY: Address;
    reserveX: bigint;
    reserveY: bigint;
    depthUsd: number;
  }[] = [];

  for (let a = 0; a < STABLES.length; a++) {
    for (let b = a + 1; b < STABLES.length; b++) {
      const tA = STABLES[a];
      const tB = STABLES[b];
      for (const binStep of BIN_STEPS) {
        let info;
        try {
          info = (await client.readContract({
            address: LB_FACTORY,
            abi: factoryAbi,
            functionName: "getLBPairInformation",
            args: [tA, tB, BigInt(binStep)],
          })) as readonly [bigint, Address, boolean, boolean];
        } catch {
          continue;
        }
        const [, pairAddr, , ignoredForRouting] = info;
        if (!pairAddr || pairAddr === zeroAddress) continue;
        if (ignoredForRouting) continue; // discovery drops ignored-for-routing pairs
        const key = pairAddr.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const [reserves, activeIdRaw, tokenXRaw, tokenYRaw] = await Promise.all([
            client.readContract({ address: pairAddr, abi: pairAbi, functionName: "getReserves" }) as Promise<readonly [bigint, bigint]>,
            client.readContract({ address: pairAddr, abi: pairAbi, functionName: "getActiveId" }) as Promise<number>,
            client.readContract({ address: pairAddr, abi: pairAbi, functionName: "getTokenX" }) as Promise<Address>,
            client.readContract({ address: pairAddr, abi: pairAbi, functionName: "getTokenY" }) as Promise<Address>,
          ]);
          const tokenX = getAddress(tokenXRaw) as Address;
          const tokenY = getAddress(tokenYRaw) as Address;
          const dX = decOf.get(tokenX.toLowerCase()) ?? 18;
          const dY = decOf.get(tokenY.toLowerCase()) ?? 18;
          const depthUsd = Number(reserves[0]) / 10 ** dX + Number(reserves[1]) / 10 ** dY;
          candidates.push({
            pair: pairAddr,
            binStep,
            activeId: Number(activeIdRaw),
            tokenX,
            tokenY,
            reserveX: reserves[0],
            reserveY: reserves[1],
            depthUsd,
          });
        } catch {
          /* non-LB-v2.x surface — skip */
        }
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error("no stable-pair LBPair found on the wired Arbitrum LB v2.2 factory");
  }
  candidates.sort((p, q) => q.depthUsd - p.depthUsd);
  const top = candidates[0];
  console.log(
    `[lb-snapshot] deepest stable LBPair = ${top.pair} (binStep ${top.binStep}, depth≈$${top.depthUsd.toFixed(0)}, activeId ${top.activeId})`,
  );
  for (const c of candidates) {
    console.log(
      `  candidate ${c.pair} bs=${c.binStep} depth≈$${c.depthUsd.toFixed(0)} tokenX=${symOf.get(c.tokenX.toLowerCase())} tokenY=${symOf.get(c.tokenY.toLowerCase())}`,
    );
  }

  const pair = top.pair;
  const tokenX = top.tokenX;
  const tokenY = top.tokenY;

  // ── Bytecode: the clone proxy runtime + its resolved implementation runtime. ──
  const pairCode = await client.getCode({ address: pair });
  if (!pairCode || pairCode === "0x") throw new Error(`empty code at pair ${pair}`);
  console.log(`[lb-snapshot] pair runtime = ${pairCode.length / 2 - 1} bytes`);

  const clone = decodeImmutableClone(pairCode);
  if (!clone) throw new Error(`pair ${pair} is not a recognised LB immutable-args clone`);
  // Cross-check the on-chain factory's declared implementation and the pair getters.
  const facImpl = (await client
    .readContract({ address: LB_FACTORY, abi: factoryAbi, functionName: "getLBPairImplementation" })
    .catch(() => zeroAddress as Address)) as Address;
  if (facImpl !== zeroAddress && getAddress(facImpl) !== getAddress(clone.impl)) {
    console.warn(
      `[lb-snapshot] WARNING: clone impl ${clone.impl} != factory.getLBPairImplementation() ${facImpl}`,
    );
  }
  if (getAddress(clone.tokenX) !== getAddress(tokenX) || getAddress(clone.tokenY) !== getAddress(tokenY)) {
    console.warn(
      `[lb-snapshot] WARNING: clone immutable tokens (${clone.tokenX}/${clone.tokenY}) != getters (${tokenX}/${tokenY})`,
    );
  }
  const implCode = await client.getCode({ address: clone.impl });
  if (!implCode || implCode === "0x") throw new Error(`empty code at impl ${clone.impl}`);
  console.log(
    `[lb-snapshot] pair is an LB immutable-args clone -> impl ${clone.impl} (${implCode.length / 2 - 1} bytes); binStep=${clone.binStep}`,
  );

  // ── Swap-relevant STATE via the pair's own getters (ground truth). ──
  const [activeIdRaw, binStepRaw, reserves, staticFeeRaw, varFeeRaw] = await Promise.all([
    client.readContract({ address: pair, abi: pairAbi, functionName: "getActiveId" }) as Promise<number>,
    client.readContract({ address: pair, abi: pairAbi, functionName: "getBinStep" }) as Promise<number>,
    client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }) as Promise<readonly [bigint, bigint]>,
    client.readContract({ address: pair, abi: pairAbi, functionName: "getStaticFeeParameters" }) as Promise<
      readonly [number, number, number, number, number, number, number]
    >,
    client
      .readContract({ address: pair, abi: pairAbi, functionName: "getVariableFeeParameters" })
      .catch(() => null) as Promise<readonly [number, number, number, number] | null>,
  ]);
  const activeId = Number(activeIdRaw);
  const binStep = Number(binStepRaw);

  const [decX, decY] = [decOf.get(tokenX.toLowerCase()) ?? 18, decOf.get(tokenY.toLowerCase()) ?? 18];
  const [symX, symY] = [symOf.get(tokenX.toLowerCase()) ?? "?", symOf.get(tokenY.toLowerCase()) ?? "?"];

  // ── Bin WINDOW around the active bin (one getBin per id) — the reconstructed swap window. ──
  const windowLo = activeId - BIN_WINDOW;
  const windowHi = activeId + BIN_WINDOW;
  const ids: number[] = [];
  for (let id = windowLo; id <= windowHi; id++) if (id >= 0) ids.push(id);
  // Sequential getBin reads (no multicall — the client has no chain configured, and a plain loop is
  // fine for a one-time capture of a ~65-id window).
  const bins: { id: number; reserveX: string; reserveY: string }[] = [];
  for (const id of ids) {
    let rX: bigint;
    let rY: bigint;
    try {
      [rX, rY] = (await client.readContract({
        address: pair,
        abi: pairAbi,
        functionName: "getBin",
        args: [id],
      })) as [bigint, bigint];
    } catch {
      continue; // uninitialized id may revert on some LB versions — treat as empty
    }
    if (rX === 0n && rY === 0n) continue; // uninitialized / empty bin
    bins.push({ id, reserveX: rX.toString(), reserveY: rY.toString() });
  }
  if (bins.length === 0) throw new Error("no non-empty bins in the captured window");
  console.log(`[lb-snapshot] captured ${bins.length} non-empty bins in [${windowLo}, ${windowHi}]`);

  // ── Raw storage: the packed param slots (0..11) + the _bins mapping slots for the window ids. ──
  const paramStorage: Record<string, Hex> = {};
  for (let s = 0; s < PARAM_SLOT_COUNT; s++) {
    const slot = pad(toHex(s)) as Hex;
    const v = await client.getStorageAt({ address: pair, slot });
    paramStorage[s.toString()] = (v ?? ("0x" + "0".repeat(64))) as Hex;
  }
  // _bins mapping: keccak256(abi.encode(uint256(id), uint256(BINS_MAPPING_SLOT))) → packed reserves.
  const binStorage: Record<string, { slot: Hex; value: Hex }> = {};
  for (const b of bins) {
    const slot = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [BigInt(b.id), BigInt(BINS_MAPPING_SLOT)],
      ),
    ) as Hex;
    const v = (await client.getStorageAt({ address: pair, slot })) as Hex;
    binStorage[b.id.toString()] = { slot, value: (v ?? ("0x" + "0".repeat(64))) as Hex };
  }

  // ── _tree bitmap slots (so the etched pair can WALK bins, not just drain the active one). ──
  // level0 = the single bytes32 at TREE_BASE_SLOT. level1/level2 are mappings keyed by bytes32(id>>16) /
  // bytes32(id>>8) — capture every distinct group the window ids touch (a window straddling the anchor
  // touches 2 groups per level). The mapping-slot for key k at base B is keccak256(abi.encode(bytes32(k), B)).
  const bytes32Word = (v: bigint) => pad(toHex(v), { size: 32 }) as Hex;
  const mapSlot = (keyWord: Hex, base: number) =>
    keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [keyWord, BigInt(base)])) as Hex;
  const treeLevel0Slot = (pad(toHex(BigInt(TREE_BASE_SLOT))) as Hex);
  const level1Keys = new Set<bigint>();
  const level2Keys = new Set<bigint>();
  for (const b of bins) {
    level1Keys.add(BigInt(b.id) >> 16n);
    level2Keys.add(BigInt(b.id) >> 8n);
  }
  const treeStorage: {
    level0: { slot: Hex; value: Hex };
    level1: Record<string, { slot: Hex; value: Hex }>; // keyed by (id>>16)
    level2: Record<string, { slot: Hex; value: Hex }>; // keyed by (id>>8)
  } = {
    level0: {
      slot: treeLevel0Slot,
      value: ((await client.getStorageAt({ address: pair, slot: treeLevel0Slot })) ?? ("0x" + "0".repeat(64))) as Hex,
    },
    level1: {},
    level2: {},
  };
  for (const k of level1Keys) {
    const slot = mapSlot(bytes32Word(k), TREE_BASE_SLOT + 1);
    treeStorage.level1[k.toString()] = {
      slot,
      value: ((await client.getStorageAt({ address: pair, slot })) ?? ("0x" + "0".repeat(64))) as Hex,
    };
  }
  for (const k of level2Keys) {
    const slot = mapSlot(bytes32Word(k), TREE_BASE_SLOT + 2);
    treeStorage.level2[k.toString()] = {
      slot,
      value: ((await client.getStorageAt({ address: pair, slot })) ?? ("0x" + "0".repeat(64))) as Hex,
    };
  }
  console.log(
    `[lb-snapshot] captured tree bitmap: level0 + ${Object.keys(treeStorage.level1).length} level1 group(s) + ` +
      `${Object.keys(treeStorage.level2).length} level2 group(s)`,
  );

  // ── getSwapOut probes (the quote-view self-checks the offline test reproduces). ──
  // swapForY=true sells tokenX for tokenY; swapForY=false sells tokenY for tokenX.
  const probeInX = 1_000n * 10n ** BigInt(decX);
  const probeInY = 1_000n * 10n ** BigInt(decY);
  const [swapOutY, swapOutX] = await Promise.all([
    client.readContract({ address: pair, abi: pairAbi, functionName: "getSwapOut", args: [probeInX, true] }) as Promise<readonly [bigint, bigint, bigint]>,
    client.readContract({ address: pair, abi: pairAbi, functionName: "getSwapOut", args: [probeInY, false] }) as Promise<readonly [bigint, bigint, bigint]>,
  ]);

  // ── Write the bytecode snapshot (WITH sha256 anchors). ──
  const bytecodeSnap = {
    chain: "arbitrum",
    chainId,
    block: block.toString(),
    blockTimestamp: blk.timestamp.toString(),
    pair: { address: pair, runtime: pairCode, runtimeSha256: sha256(pairCode) },
    implementation: {
      address: clone.impl,
      runtime: implCode,
      runtimeSha256: sha256(implCode),
    },
    isImmutableArgsClone: true,
    // The immutable args baked into the proxy runtime (NOT storage). The test repoints tokens either
    // by etching local MintableERC20s at these addresses OR by rewriting these arg bytes.
    immutableArgs: {
      tokenX: clone.tokenX,
      tokenY: clone.tokenY,
      binStep: clone.binStep,
      argsHex: clone.argsHex,
      argsByteOffset: clone.argsByteOffset,
    },
    dependencies: [] as { name: string; address: Address; runtime: string; runtimeSha256: Hex }[],
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Write the state snapshot. ──
  const stateSnap = {
    chain: "arbitrum",
    chainId,
    block: block.toString(),
    blockTimestamp: blk.timestamp.toString(),
    pair,
    factory: LB_FACTORY,
    factoryType: "trader-joe-lb",
    implementation: clone.impl,
    tokenX,
    tokenY,
    tokenXSymbol: symX,
    tokenYSymbol: symY,
    decimalsX: decX,
    decimalsY: decY,
    binStep,
    activeId,
    reserveX: reserves[0].toString(),
    reserveY: reserves[1].toString(),
    // Static fee params (getStaticFeeParameters): [baseFactor, filterPeriod, decayPeriod,
    // reductionFactor, variableFeeControl, protocolShare, maxVolatilityAccumulator]. baseFactor is
    // what lb-math.baseFee uses; the rest gate the (transient, snapshot-zero) variable fee.
    staticFeeParameters: {
      baseFactor: staticFeeRaw[0],
      filterPeriod: staticFeeRaw[1],
      decayPeriod: staticFeeRaw[2],
      reductionFactor: staticFeeRaw[3],
      variableFeeControl: staticFeeRaw[4],
      protocolShare: staticFeeRaw[5],
      maxVolatilityAccumulator: staticFeeRaw[6],
    },
    // Variable fee params (getVariableFeeParameters): [volatilityAccumulator, volatilityReference,
    // idReference, timeOfLastUpdate]. Transient (block-decayed); recorded for provenance.
    variableFeeParameters: varFeeRaw
      ? {
          volatilityAccumulator: varFeeRaw[0],
          volatilityReference: varFeeRaw[1],
          idReference: varFeeRaw[2],
          timeOfLastUpdate: varFeeRaw[3],
        }
      : null,
    // The captured active-bin WINDOW (id ASC, non-empty only) — the reconstructed swap window.
    binWindow: { lo: windowLo, hi: windowHi, bins },
    // getSwapOut probe self-checks (the offline test reproduces these against the etched pair).
    probe: {
      swapForY: {
        amountIn: probeInX.toString(),
        amountInLeft: swapOutY[0].toString(),
        amountOut: swapOutY[1].toString(),
        fee: swapOutY[2].toString(),
      },
      swapForX: {
        amountIn: probeInY.toString(),
        amountInLeft: swapOutX[0].toString(),
        amountOut: swapOutX[1].toString(),
        fee: swapOutX[2].toString(),
      },
    },
    // Raw storage for deterministic setStorageAt reconstruction: the packed param slots (0..11) and
    // the _bins mapping slots (keccak256(abi.encode(id, 7))) for each captured window bin.
    binsMappingSlot: BINS_MAPPING_SLOT,
    paramStorage,
    binStorage,
    // The _tree (TreeMath.TreeUint24) bitmap slots — level0 (single bytes32 at TREE_BASE_SLOT) + the
    // level1/level2 mapping slots for every group the window ids touch. REQUIRED so the etched pair's
    // findFirstRight/Left bin walk crosses bins (without it, the pair drains ONLY the active bin).
    treeBaseSlot: TREE_BASE_SLOT,
    treeStorage,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[lb-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[lb-snapshot] state: pair=${pair} tokenX=${symX}(${decX}) tokenY=${symY}(${decY}) binStep=${binStep} activeId=${activeId}\n` +
      `  reserves X=${reserves[0]} Y=${reserves[1]} depth≈$${top.depthUsd.toFixed(0)} (THIN — LB deep books are on Avalanche, NOT an Eco chain)\n` +
      `  baseFactor=${staticFeeRaw[0]} bins captured=${bins.length}\n` +
      `  probe getSwapOut(${probeInX} tokenX, swapForY=true)  = out ${swapOutY[1]} fee ${swapOutY[2]} (inLeft ${swapOutY[0]})\n` +
      `  probe getSwapOut(${probeInY} tokenY, swapForY=false) = out ${swapOutX[1]} fee ${swapOutX[2]} (inLeft ${swapOutX[0]})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
