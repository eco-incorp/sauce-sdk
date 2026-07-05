/**
 * One-time capture of the REAL EKUBO V3 quote+swap graph (EkuboProtocol/evm-contracts v3.1.1 —
 * the Core singleton + the MEVCaptureRouter + the top USDe/USDC virtual pool's state) from ETH
 * mainnet, so the Ekubo prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time). Ekubo's
 * periphery is only PARTLY verified and its math is a bespoke family this recipe deliberately does
 * NOT port — the genuine etched bytecode is the mandatory production surface per the repo
 * discipline.
 *
 * Mirrors harness/metric-snapshot.ts (the proven pattern) AND EMITS THE SAME FERMI-SHAPED
 * SNAPSHOT, so the prod-mirror test reuses the WHOLE fermi harness verbatim (loadFermiSnapshots /
 * verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp / etchFermiGraph): eth_getCode every
 * contract the quote/swap paths touch (enumerated via eth_createAccessList on DENSE quote ladders
 * BOTH directions PLUS the ticks-territory-covering OVERSIZE quotes PLUS swap calls BOTH
 * directions), into a checked-in bytecode snapshot (WITH sha256 integrity anchors), and every
 * touched storage slot into a state snapshot. Block pinned. The RPC url / key is NEVER persisted.
 *
 * ── THE CAPTURED GRAPH ───────────────────────────────────────────────────────────────────────────
 *   1. the MEVCaptureRouter 0xd26f2000… (quote 0x3bc52842 / the 7-arg full-fill swap 0xf196187f;
 *      the snapshot's `fermiSwapper` field),
 *   2. the CORE singleton 0x0000…d701 (every pool VIRTUAL inside it: poolState slot == poolId,
 *      tick/bitmap/FPL slots at the CoreStorageLayout offsets — all enumerated via the access
 *      lists; the snapshot's `vault` field, funded by the harness with the captured till
 *      inventory),
 *   plus the tokens (USDe/USDC — repointed to local MintableERC20s by the harness; the QUOTE path
 *   touches NO token slots — the swap settles tokens only in the SWAP path, which then moves the
 *   LOCAL tokens through the REAL router/Core code).
 *
 * ── TICK-TERRITORY COVERAGE (why the slot union is complete) ─────────────────────────────────────
 * A quote executes the REAL swap walk inside the lock (reading every tick/bitmap slot it crosses)
 * and unwinds. The enumeration includes an OVERSIZE exact-in quote in EACH direction — the walk
 * consumes the pool's ENTIRE initialized liquidity (the graceful partial-fill class), touching
 * EVERY initialized tick, bitmap word and FPL slot in that direction — so any smaller cook-time
 * quote/swap reads a SUBSET of the captured slots by construction.
 *
 * ── CLZ (EIP-7939) ───────────────────────────────────────────────────────────────────────────────
 * The genuine runtime executes the CLZ opcode (Osaka) — the replaying anvil MUST boot
 * `--hardfork osaka` (startAnvil({ hardfork: "osaka" })); the prod-mirror's integrity cell
 * re-executes the captured probe ladders as its CLZ gate.
 *
 * Re-capture (REQUIRED whenever the recipe's touched-contract set changes):
 *   set -a; . sdk/.env; set +a
 *   npx tsx src/recipes/test/harness/ekubo-snapshot.ts
 * Optional argv[2] = RPC url, argv[3] = an explicit block to pin (else head).
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, getAddress, encodeFunctionData, type Hex, type Address, type Abi } from "viem";

import { EKUBO_DEFAULT_PRESETS, ekuboConcentratedConfig, ekuboPoolId } from "../../shared/ekubo-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "eth-ekubo-USDeUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The REAL ETH mainnet Ekubo v3.1.1 stack (E0 freeze record in shared/ekubo-math.ts).
const ROUTER = getAddress("0xd26f20001a72a18C002b00e6710000d68700ce00") as Address; // MEVCaptureRouter
const CORE = getAddress("0x00000000000014aA86C5d3c41765bb24e11bd701") as Address;

// The top pool's pair (USDe/USDC 0.003%/ts100 — id 0xc86d5ef1…, ~$0.9M/side, $4.19M/24h).
const USDE = getAddress("0x4c9EDD5852cd905f086C759E8383e09bff1E68B3") as Address;
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") as Address;
const CONFIG = ekuboConcentratedConfig(EKUBO_DEFAULT_PRESETS[0].fee, EKUBO_DEFAULT_PRESETS[0].tickSpacing);
const POOL_ID = ekuboPoolId(USDE, USDC, CONFIG);

const TARGET = { tokenIn: USDE, tokenOut: USDC, inSym: "USDe", outSym: "USDC" };

const RPC = process.argv[2] || process.env.ETH_RPC_URL || "";
const PIN_BLOCK_ARG = process.argv[3] ? BigInt(process.argv[3]) : null;
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set ETH_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);
const routerAbi = parseAbi([
  "function quote((address token0, address token1, bytes32 config) poolKey, bool isToken1, int128 amount, uint96 sqrtRatioLimit, uint256 skipAhead) view returns (bytes32 balanceUpdate, bytes32 stateAfter)",
  "function swap((address token0, address token1, bytes32 config) poolKey, bool isToken1, int128 amount, uint96 sqrtRatioLimit, uint256 skipAhead, int256 calculatedAmountThreshold, address recipient) returns (bytes32 balanceUpdate)",
]);

const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

type AccessListEntry = { address: Address; storageKeys: Hex[] };

async function createAccessList(
  client: ReturnType<typeof createPublicClient>,
  to: Address,
  data: Hex,
  from: Address,
  blockHex: Hex,
): Promise<AccessListEntry[]> {
  const res = (await client.request({
    method: "eth_createAccessList" as never,
    params: [{ to, data, from } as never, blockHex as never],
  } as never)) as { accessList: { address: Address; storageKeys: Hex[] }[]; error?: string };
  if (!res || !res.accessList) throw new Error(`eth_createAccessList returned no list: ${JSON.stringify(res)}`);
  return res.accessList.map((e) => ({ address: getAddress(e.address) as Address, storageKeys: e.storageKeys }));
}

/** Decode |the out-side int128 lane| of a packed PoolBalanceUpdate word for the direction. */
function outOf(bu: Hex, isToken1: boolean): bigint {
  const word = BigInt(bu);
  const lane = isToken1 ? word >> 128n : word & ((1n << 128n) - 1n);
  return lane > (1n << 127n) - 1n ? (1n << 128n) - lane : 0n;
}
/** Decode the CONSUMED in-side int128 lane (the graceful partial-fill cap). */
function consumedOf(bu: Hex, isToken1: boolean): bigint {
  const word = BigInt(bu);
  const lane = isToken1 ? word & ((1n << 128n) - 1n) : word >> 128n;
  return lane <= (1n << 127n) - 1n ? lane : 0n;
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 1) console.warn(`[ekubo-snapshot] WARNING: chainId ${chainId} != Ethereum (1)`);

  const pinBlock = PIN_BLOCK_ARG ?? (await client.getBlockNumber());
  const blockHex = ("0x" + pinBlock.toString(16)) as Hex;
  const blk = await client.getBlock({ blockNumber: pinBlock });
  const blockTimestamp = blk.timestamp;
  console.log(`[ekubo-snapshot] pinned block=${pinBlock} timestamp=${blockTimestamp} poolId=${POOL_ID}`);

  // ── The pinned-block quote helper (the REAL router; eth_call — not a static context). ──
  const quoteAt = async (isToken1: boolean, amt: bigint): Promise<{ out: bigint; consumed: bigint }> => {
    const [bu] = (await client.readContract({
      address: ROUTER, abi: routerAbi as Abi, functionName: "quote",
      args: [{ token0: USDE, token1: USDC, config: CONFIG }, isToken1, amt, 0n, 0n], blockNumber: pinBlock,
    })) as readonly [Hex, Hex];
    return { out: outOf(bu, isToken1), consumed: consumedOf(bu, isToken1) };
  };

  const probeAmt = 1000n * 10n ** 18n; // 1000 USDe
  const ref = await quoteAt(false, probeAmt);
  if (ref.out <= 0n) throw new Error(`pinned block ${pinBlock} quotes 0 for ${TARGET.inSym}/${TARGET.outSym}`);
  console.log(`[ekubo-snapshot] 1000 USDe -> ${ref.out} USDC (consumed ${ref.consumed}) @ the pin`);

  // ── Enumerate the touched-contract + touched-slot union: dense quote ladders BOTH directions,
  //    the OVERSIZE tick-territory-covering quotes, and swap calls BOTH directions (the settlement
  //    path is touched BEFORE the taker transferFrom revert). ──
  const from = getAddress("0x000000000000000000000000000000000000dEaD") as Address;
  const merged = new Map<string, Set<string>>();
  const addEntries = (entries: AccessListEntry[]) => {
    for (const e of entries) {
      const key = e.address.toLowerCase();
      if (!merged.has(key)) merged.set(key, new Set());
      const set = merged.get(key)!;
      for (const sKey of e.storageKeys) set.add(sKey.toLowerCase());
    }
  };
  const tryAdd = async (to: Address, data: Hex) => {
    try {
      addEntries(await createAccessList(client, to, data, from, blockHex));
    } catch (e) {
      void e; // reverting swaps still surfaced their touched set where supported
    }
  };
  const quoteData = (isToken1: boolean, amt: bigint): Hex =>
    encodeFunctionData({
      abi: routerAbi as Abi, functionName: "quote",
      args: [{ token0: USDE, token1: USDC, config: CONFIG }, isToken1, amt, 0n, 0n],
    });
  const denseLadder = (base: bigint): bigint[] => {
    const out: bigint[] = [];
    for (let e = -4; e <= 3; e++) {
      for (const m of [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]) {
        const scale = 10n ** BigInt(Math.abs(e));
        const v = e < 0 ? (base * m) / (10n * scale) : base * m * scale;
        if (v > 0n) out.push(v);
      }
    }
    return [...new Set(out)].sort((a, b) => (a < b ? -1 : 1));
  };
  for (const amt of denseLadder(10_000n * 10n ** 18n)) await tryAdd(ROUTER, quoteData(false, amt));
  for (const amt of denseLadder(10_000n * 10n ** 6n)) await tryAdd(ROUTER, quoteData(true, amt));
  // The OVERSIZE territory walks — consume the WHOLE initialized liquidity in each direction, so
  // every tick/bitmap/FPL slot any smaller cook can read is in the union by construction.
  await tryAdd(ROUTER, quoteData(false, 100_000_000_000n * 10n ** 18n));
  await tryAdd(ROUTER, quoteData(true, 100_000_000_000n * 10n ** 6n));
  // The SWAP settlement paths (withdraw-out + payFrom-in touched before the taker pull reverts).
  for (const amt of [1000n * 10n ** 18n, 50_000n * 10n ** 18n]) {
    await tryAdd(ROUTER, encodeFunctionData({
      abi: routerAbi as Abi, functionName: "swap",
      args: [{ token0: USDE, token1: USDC, config: CONFIG }, false, amt, 0n, 0n, 0n, from],
    }));
  }
  for (const amt of [1000n * 10n ** 6n, 50_000n * 10n ** 6n]) {
    await tryAdd(ROUTER, encodeFunctionData({
      abi: routerAbi as Abi, functionName: "swap",
      args: [{ token0: USDE, token1: USDC, config: CONFIG }, true, amt, 0n, 0n, 0n, from],
    }));
  }
  // Belt-and-braces: the core stack is captured even if an access-list call was quietly dropped,
  // and the poolState slot (== the poolId) is force-included.
  for (const must of [ROUTER, CORE]) {
    const key = must.toLowerCase();
    if (!merged.has(key)) merged.set(key, new Set());
  }
  merged.get(CORE.toLowerCase())!.add(POOL_ID.toLowerCase());

  // ── The till inventory (the vault funding) + token metadata. ──
  const bal = (t: Address, who: Address) =>
    client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber: pinBlock }) as Promise<bigint>;
  const tillReserves = {
    USDe: (await bal(USDE, CORE)).toString(),
    USDC: (await bal(USDC, CORE)).toString(),
  };
  console.log(`[ekubo-snapshot] Core till USDe=${tillReserves.USDe} USDC=${tillReserves.USDC}`);

  // ── Capture code (sha256-anchored) + every touched storage slot for every touched contract. ──
  const TOKENS = new Set([USDE.toLowerCase(), USDC.toLowerCase()]);
  const contracts: { address: Address; role: string; runtime: string; runtimeSha256: Hex; codeSizeBytes: number; slots: Record<string, Hex> }[] = [];
  for (const [addrLc, slotSet] of [...merged.entries()].sort()) {
    const address = getAddress(addrLc) as Address;
    const code = await client.getCode({ address, blockNumber: pinBlock });
    const runtime = code ?? "0x";
    const role =
      addrLc === ROUTER.toLowerCase()
        ? "Ekubo MEVCaptureRouter (quote 0x3bc52842 / full-fill swap 0xf196187f)"
        : addrLc === CORE.toLowerCase()
          ? "Ekubo Core singleton (virtual pools + the till inventory; the snapshot vault)"
          : TOKENS.has(addrLc)
            ? "token (repointed by harness)"
            : "swap-path dependency";
    const slots: Record<string, Hex> = {};
    for (const slot of [...slotSet].sort()) {
      const v = await client.getStorageAt({ address, slot: slot as Hex, blockNumber: pinBlock });
      slots[slot] = (v ?? ("0x" + "0".repeat(64))) as Hex;
    }
    contracts.push({ address, role, runtime, runtimeSha256: sha256(runtime), codeSizeBytes: runtime === "0x" ? 0 : runtime.length / 2 - 1, slots });
    console.log(`[ekubo-snapshot]  touched ${address} [${role}] code=${runtime === "0x" ? 0 : runtime.length / 2 - 1}B slots=${Object.keys(slots).length}`);
  }

  const meta = async (t: Address) => ({
    address: t,
    symbol: await client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    decimals: Number(await client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }).catch(() => 18)),
  });
  const tokenMeta = { USDe: await meta(USDE), USDC: await meta(USDC) };

  // ── Ground-truth probe ladders BOTH directions at the pin (offline-reproducible: the quote
  //    reads ONLY the captured Core storage). ──
  const ladder = async (isToken1: boolean, amts: bigint[]) => {
    const pts: { amountIn: string; amountOut: string; consumed: string }[] = [];
    for (const amt of amts) {
      try {
        const r = await quoteAt(isToken1, amt);
        pts.push({ amountIn: amt.toString(), amountOut: r.out.toString(), consumed: r.consumed.toString() });
      } catch {
        pts.push({ amountIn: amt.toString(), amountOut: "REVERT", consumed: "0" });
      }
    }
    return pts;
  };
  const E18 = 10n ** 18n;
  const E6 = 10n ** 6n;
  const fwdLadder = await ladder(false, [1000n * E18, 10_000n * E18, 50_000n * E18, 100_000n * E18, 200_000n * E18]);
  const revLadder = await ladder(true, [1000n * E6, 10_000n * E6, 50_000n * E6, 100_000n * E6, 200_000n * E6]);

  // ── Write the snapshots — FERMI-SHAPED (see the header): `fermiSwapper` = the ROUTER, `vault` =
  //    the CORE (funded with the captured till inventory), plus the ekubo extras. ──
  const bytecodeSnap = {
    chain: "ethereum",
    fermiSwapper: ROUTER,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    note:
      "EKUBO V3 (v3.1.1 till-based singleton CL; partly verified — the genuine runtime is the mandatory " +
      "production surface). FERMI-SHAPED snapshot (fermiSwapper = the MEVCaptureRouter; vault = the CORE " +
      "singleton holding the till inventory) so the fermi harness (loadFermiSnapshots / " +
      "verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp / etchFermiGraph) is reused verbatim. The QUOTE " +
      "path touches no token slots (the settlement runs only in the SWAP path) so the token repoint is " +
      "pricing-neutral. REPLAY REQUIRES --hardfork osaka (the runtime executes CLZ, EIP-7939). The slot union " +
      "covers the pool's ENTIRE tick territory (oversize quotes both directions walk all initialized liquidity).",
    contracts: contracts
      .map((cc) => ({ address: cc.address, role: cc.role, runtime: cc.runtime, runtimeSha256: cc.runtimeSha256, codeSizeBytes: cc.codeSizeBytes }))
      .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)),
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  const stateSnap = {
    chain: "ethereum",
    fermiSwapper: ROUTER,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    staleUpdateSelector: "0x486aa307", // PoolNotInitialized (informational — the probe-then-decode class)
    target: { ...TARGET },
    second: { tokenIn: USDC, tokenOut: USDE, inSym: "USDC", outSym: "USDe" },
    tokens: tokenMeta,
    tokenBalanceSlots: {}, // the Ekubo QUOTE reads no token balances (settlement is swap-only)
    contractSlots: Object.fromEntries(
      contracts.map((cc) => [cc.address, { role: cc.role, slots: cc.slots }]),
    ),
    vault: {
      address: CORE,
      role:
        "the Ekubo CORE singleton (the till): every pool's inventory is a Core token balance — the swap " +
        "pulls the input INTO Core (payFrom) and withdraws the output FROM it; the harness funds it with " +
        "the captured balances.",
      reserves: tillReserves,
      allowanceToRouter: { USDe: "0", USDC: "0" }, // the router never transferFroms the Core — informational
    },
    eoa7702: null,
    ekuboCore: CORE,
    ekuboPoolKey: { token0: USDE, token1: USDC, config: CONFIG },
    ekuboPoolId: POOL_ID,
    probe: {
      target: { pair: `${TARGET.inSym}/${TARGET.outSym}`, ladder: fwdLadder },
      second: { pair: `${TARGET.outSym}/${TARGET.inSym}`, ladder: revLadder },
    },
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[ekubo-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[ekubo-snapshot] pinned block ${pinBlock} (ts ${blockTimestamp}); ${contracts.length} touched contracts; ` +
      `1000 ${TARGET.inSym} -> ${ref.out} ${TARGET.outSym} @ the pin`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
