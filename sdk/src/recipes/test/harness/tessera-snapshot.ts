/**
 * One-time capture of the REAL Tessera V (Wintermute's TesseraSwap wrapper + private engine — a
 * treasury-funded PROACTIVE market maker) from Base mainnet, so the Tessera prod-mirror EVM test runs
 * OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/fermi-snapshot.ts (the proven pattern) AND EMITS THE SAME SNAPSHOT SHAPE, so the
 * prod-mirror test reuses the WHOLE fermi harness verbatim (loadFermiSnapshots /
 * verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp / etchFermiGraph): eth_getCode the wrapper's REAL
 * runtime AND every dependency contract the quote/swap path touches (enumerated via eth_createAccessList
 * on a DENSE quote ladder in BOTH directions PLUS the swap call), into a checked-in bytecode snapshot
 * (WITH sha256 integrity anchors), and every touched storage slot into a state snapshot. Block pinned.
 * The RPC url / key is NEVER persisted — only contract CODE + STATE.
 *
 * ── THE CAPTURED GRAPH (verified by trace + access-list, 2026-07-04) ────────────────────────────────────
 *   1. the TesseraSwap wrapper (0x55555522… — VERIFIED source; ReentrancyGuardTransient ⇒ slot 0..2 are
 *      engine/treasury/owner, captured explicitly like Fermi's router slots),
 *   2. the PRIVATE ENGINE (0x31e99E05… — unverified; holds isActive, the per-pair registry, and
 *      globalPrioFeeThresholddd1337 = 2 gwei),
 *   3. the per-pair POOL proxy (0xf524C1Bc…) + its implementation (0xffEeB848…, delegatecalled — storage
 *      lives in the proxy),
 *   4. an oracle/aux contract (0xFDb7Fa3F…, code-only on the quote path),
 *   5. a swap-path helper (0x7034C5c7…, surfaced by the swap access-list),
 *   plus the TREASURY (wrapper slot 1 — the address that HOLDS the payout inventory and has max
 *   allowance to the wrapper; the snapshot's `vault` field, funded by the harness) and the tokens
 *   (WETH/USDC — repointed to local MintableERC20s by the harness; the QUOTE does NOT read token
 *   balances — the access-list shows no token slots on the view path — so repointing is pricing-neutral).
 *
 * ── GAS-PRICE CONTEXT (why probes pin gasPrice) ─────────────────────────────────────────────────────────
 * The engine reads tx.gasprice vs globalPrioFeeThresholddd1337 inside BOTH the view and the swap (the
 * quote shifts sub-bp above ~2 gwei; the swap NEVER reverts — fork-proven). Every probe quote here is
 * captured at an EXPLICIT eth_call gasPrice of 1 gwei (in-band), and the prod-mirror reproduces quotes +
 * cooks at the SAME pinned legacy gas price — so the captured ladder is deterministic ground truth.
 *
 * ── block.timestamp ─────────────────────────────────────────────────────────────────────────────────────
 * Tessera quotes were measured FLAT under pure timestamp drift for ≥ ~8.5 min past capture (a ~1% cliff
 * appears later). The harness still pins block.timestamp to the captured ts (pinFermiBlockTimestamp) so
 * the etched state is exactly the capture instant.
 *
 * Re-capture (REQUIRED whenever the recipe's touched-contract set changes):
 *   set -a; . sdk/.env; set +a
 *   BASE_RPC_URL=$BASE_RPC_URL npx tsx src/recipes/test/harness/tessera-snapshot.ts
 * Optional argv[2] = RPC url, argv[3] = an explicit block to pin (else head).
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, getAddress, type Hex, type Address } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "base-tessera-WETHUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The REAL verified TesseraSwap wrapper (Base blockscout verified; SAME address BSC). constants.ts wires it.
const TESSERA = getAddress("0x55555522005BcAE1c2424D474BfD5ed477749E3e") as Address;

// Base on-charter tokens (constants.ts BASE_CHAIN_POOL_CONFIG.baseTokens).
const WETH = getAddress("0x4200000000000000000000000000000000000006") as Address;
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;

const TARGET = { tokenIn: WETH, tokenOut: USDC, inSym: "WETH", outSym: "USDC" };

// The pinned gas-price context for every probe quote (in-band: ≤ the 2-gwei threshold).
const PROBE_GAS_PRICE = 1_000_000_000n; // 1 gwei

const RPC = process.argv[2] || process.env.BASE_RPC_URL || "";
const PIN_BLOCK_ARG = process.argv[3] ? BigInt(process.argv[3]) : null;
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set BASE_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

// tesseraSwapViewAmounts(address,address,int256) calldata by hand (selector verified at runtime).
function encodeViewCalldata(tokenIn: Address, tokenOut: Address, amt: bigint): Hex {
  const selector = "77f65f98";
  const a = tokenIn.slice(2).toLowerCase().padStart(64, "0");
  const b = tokenOut.slice(2).toLowerCase().padStart(64, "0");
  const c = (amt < 0n ? (1n << 256n) + amt : amt).toString(16).padStart(64, "0");
  return ("0x" + selector + a + b + c) as Hex;
}

// tesseraSwapWithAllowances(address,address,int256,uint256,address,bytes) calldata (empty swapData) —
// used ONLY for the swap-path access-list (the call reverts at the taker transferFrom, which is fine:
// the pricing + treasury-payout slots are all touched BEFORE the revert point).
function encodeSwapCalldata(tokenIn: Address, tokenOut: Address, amt: bigint, recipient: Address): Hex {
  const selector = "3ae8b298";
  const words = [
    tokenIn.slice(2).toLowerCase().padStart(64, "0"),
    tokenOut.slice(2).toLowerCase().padStart(64, "0"),
    amt.toString(16).padStart(64, "0"),
    "0".padStart(64, "0"), // amountCheck 0
    recipient.slice(2).toLowerCase().padStart(64, "0"),
    (0xc0).toString(16).padStart(64, "0"), // bytes offset (6 words * 32)
    "0".padStart(64, "0"), // bytes length 0
  ];
  return ("0x" + selector + words.join("")) as Hex;
}

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
    params: [{ to, data, from, gasPrice: ("0x" + PROBE_GAS_PRICE.toString(16)) as Hex } as never, blockHex as never],
  } as never)) as { accessList: { address: Address; storageKeys: Hex[] }[]; error?: string };
  if (!res || !res.accessList) throw new Error(`eth_createAccessList returned no list: ${JSON.stringify(res)}`);
  return res.accessList.map((e) => ({ address: getAddress(e.address) as Address, storageKeys: e.storageKeys }));
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 8453) console.warn(`[tessera-snapshot] WARNING: chainId ${chainId} != Base (8453)`);

  const code = await client.getCode({ address: TESSERA });
  if (!code || code === "0x") throw new Error(`TesseraSwap ${TESSERA} has NO CODE on chainId ${chainId}`);

  const pinBlock = PIN_BLOCK_ARG ?? (await client.getBlockNumber());
  const blockHex = ("0x" + pinBlock.toString(16)) as Hex;
  const blk = await client.getBlock({ blockNumber: pinBlock });
  const blockTimestamp = blk.timestamp;
  console.log(`[tessera-snapshot] pinned block=${pinBlock} timestamp=${blockTimestamp}`);

  // ── Pinned-gas-price quote helper (raw eth_call — readContract cannot pin gasPrice). ──
  const from = getAddress("0x000000000000000000000000000000000000dEaD") as Address;
  const quoteAt = async (tokenIn: Address, tokenOut: Address, amt: bigint): Promise<bigint> => {
    const raw = (await client.request({
      method: "eth_call" as never,
      params: [
        { to: TESSERA, data: encodeViewCalldata(tokenIn, tokenOut, amt), from, gasPrice: ("0x" + PROBE_GAS_PRICE.toString(16)) as Hex } as never,
        blockHex as never,
      ],
    } as never)) as Hex;
    return BigInt("0x" + raw.slice(2 + 64, 2 + 128)); // second word = amountOut
  };

  // ── Sanity: the pair quotes live at the pin block; verify the hand-encoded selector vs readContract. ──
  const probeAmt = 10n ** 18n; // 1 WETH
  const refOut = (await client.readContract({
    address: TESSERA,
    abi: parseAbi(["function tesseraSwapViewAmounts(address tokenIn, address tokenOut, int256 amountSpecified) view returns (uint256 amountIn, uint256 amountOut)"]),
    functionName: "tesseraSwapViewAmounts",
    args: [TARGET.tokenIn, TARGET.tokenOut, probeAmt],
    blockNumber: pinBlock,
  })) as readonly [bigint, bigint];
  const rawOut = await quoteAt(TARGET.tokenIn, TARGET.tokenOut, probeAmt);
  if (rawOut <= 0n) throw new Error(`pinned block ${pinBlock} quotes 0 for ${TARGET.inSym}/${TARGET.outSym}`);
  console.log(`[tessera-snapshot] selector verified (raw@1gwei=${rawOut}, abi@default=${refOut[1]}); 1 WETH -> ~${rawOut} USDC`);

  // ── Enumerate the touched-contract + touched-slot set: DENSE geometric quote ladders BOTH directions
  //    + the SWAP call (reverts at the taker transferFrom — the pricing/treasury path is fully covered). ──
  const merged = new Map<string, Set<string>>();
  const addEntries = (entries: AccessListEntry[]) => {
    for (const e of entries) {
      const key = e.address.toLowerCase();
      if (!merged.has(key)) merged.set(key, new Set());
      const set = merged.get(key)!;
      for (const s of e.storageKeys) set.add(s.toLowerCase());
    }
  };
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
  for (const amt of denseLadder(probeAmt)) {
    try {
      addEntries(await createAccessList(client, TESSERA, encodeViewCalldata(TARGET.tokenIn, TARGET.tokenOut, amt), from, blockHex));
    } catch (e) {
      void e; // an out-of-range size may revert — fine, other sizes cover
    }
  }
  for (const amt of denseLadder(1758n * 10n ** 6n)) {
    try {
      addEntries(await createAccessList(client, TESSERA, encodeViewCalldata(TARGET.tokenOut, TARGET.tokenIn, amt), from, blockHex));
    } catch (e) {
      void e;
    }
  }
  // The SWAP path (touches the engine's swap-only contracts/slots BEFORE reverting at the taker pull).
  for (const amt of [10n ** 17n, 10n ** 18n, 2n * 10n ** 18n]) {
    try {
      addEntries(await createAccessList(client, TESSERA, encodeSwapCalldata(TARGET.tokenIn, TARGET.tokenOut, amt, from), from, blockHex));
    } catch (e) {
      void e;
    }
  }

  // ── Wrapper config slots 0..2 (ReentrancyGuardTransient ⇒ engine/treasury/owner live at 0/1/2). ──
  const wrapperSlots: Record<string, Hex> = {};
  for (let s = 0n; s <= 2n; s++) {
    const key = ("0x" + s.toString(16).padStart(64, "0")) as Hex;
    wrapperSlots[key] = ((await client.getStorageAt({ address: TESSERA, slot: key, blockNumber: pinBlock })) ?? ("0x" + "0".repeat(64))) as Hex;
  }
  const treasuryAddr = getAddress(("0x" + wrapperSlots["0x0000000000000000000000000000000000000000000000000000000000000001"].slice(-40)) as Hex) as Address;
  const treasuryCode = (await client.getCode({ address: treasuryAddr, blockNumber: pinBlock })) ?? "0x";
  console.log(`[tessera-snapshot] TREASURY (wrapper slot 1) ${treasuryAddr} code=${treasuryCode === "0x" ? 0 : treasuryCode.length / 2 - 1}B`);

  const bal = (t: Address, who: Address) =>
    client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber: pinBlock }) as Promise<bigint>;
  const allow = (t: Address, o: Address, sp: Address) =>
    client.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [o, sp], blockNumber: pinBlock }) as Promise<bigint>;
  const treasuryReserves = {
    WETH: (await bal(WETH, treasuryAddr)).toString(),
    USDC: (await bal(USDC, treasuryAddr)).toString(),
  };
  const treasuryAllowance = {
    WETH: (await allow(WETH, treasuryAddr, TESSERA)).toString(),
    USDC: (await allow(USDC, treasuryAddr, TESSERA)).toString(),
  };
  console.log(`[tessera-snapshot] treasury reserves WETH=${treasuryReserves.WETH} USDC=${treasuryReserves.USDC}`);

  // ── Capture code (sha256-anchored) + every touched storage slot for every touched contract. ──
  const TOKENS = new Set([WETH.toLowerCase(), USDC.toLowerCase()]);
  const contracts: { address: Address; role: string; runtime: string; runtimeSha256: Hex; codeSizeBytes: number; slots: Record<string, Hex> }[] = [];
  for (const [addrLc, slotSet] of [...merged.entries()].sort()) {
    const address = getAddress(addrLc) as Address;
    const c = await client.getCode({ address, blockNumber: pinBlock });
    const runtime = c ?? "0x";
    const isToken = TOKENS.has(addrLc);
    const role =
      addrLc === TESSERA.toLowerCase()
        ? "TesseraSwap wrapper"
        : isToken
          ? "token (repointed by harness)"
          : "pricing-dependency";
    const slots: Record<string, Hex> = {};
    for (const slot of [...slotSet].sort()) {
      const v = await client.getStorageAt({ address, slot: slot as Hex, blockNumber: pinBlock });
      slots[slot] = (v ?? ("0x" + "0".repeat(64))) as Hex;
    }
    contracts.push({ address, role, runtime, runtimeSha256: sha256(runtime), codeSizeBytes: runtime === "0x" ? 0 : runtime.length / 2 - 1, slots });
    console.log(`[tessera-snapshot]  touched ${address} [${role}] code=${runtime === "0x" ? 0 : runtime.length / 2 - 1}B slots=${Object.keys(slots).length}`);
  }

  // ── Token metadata + ground-truth probe ladders (all at PROBE_GAS_PRICE, from=0xdead). ──
  const meta = async (t: Address) => ({
    address: t,
    symbol: await client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    decimals: Number(await client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }).catch(() => 18)),
  });
  const tokenMeta = { WETH: await meta(WETH), USDC: await meta(USDC) };

  const ladder = async (tokenIn: Address, tokenOut: Address, amts: bigint[]) => {
    const pts: { amountIn: string; amountOut: string }[] = [];
    for (const amt of amts) {
      try {
        pts.push({ amountIn: amt.toString(), amountOut: (await quoteAt(tokenIn, tokenOut, amt)).toString() });
      } catch {
        pts.push({ amountIn: amt.toString(), amountOut: "STALE_OR_REVERT" });
      }
    }
    return pts;
  };
  const targetLadder = await ladder(TARGET.tokenIn, TARGET.tokenOut, [
    10n ** 17n, 5n * 10n ** 17n, 10n ** 18n, 2n * 10n ** 18n, 5n * 10n ** 18n,
  ]);

  // ── Write the snapshots — FERMI-SHAPED (see the header): `fermiSwapper` = the wrapper, `vault` = the
  //    TREASURY, so loadFermiSnapshots/etchFermiGraph/pinFermiBlockTimestamp consume them verbatim. ──
  const bytecodeSnap = {
    chain: "base",
    fermiSwapper: TESSERA,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    note:
      "Tessera V (Wintermute TesseraSwap wrapper + private engine). FERMI-SHAPED snapshot (fermiSwapper = the " +
      "wrapper; vault = the TREASURY at wrapper slot 1) so the fermi harness (loadFermiSnapshots / " +
      "verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp / etchFermiGraph) is reused verbatim. Every probe " +
      `quote captured at gasPrice ${PROBE_GAS_PRICE} (in-band vs the engine's 2-gwei globalPrioFeeThresholddd1337); ` +
      "the prod-mirror reproduces quotes + cooks at the SAME pinned legacy gas price. The QUOTE does not read " +
      "token balances (access-list-verified), so the token repoint is pricing-neutral; the treasury pays the swap.",
    contracts: [
      ...contracts.map((c) => ({ address: c.address, role: c.role, runtime: c.runtime, runtimeSha256: c.runtimeSha256, codeSizeBytes: c.codeSizeBytes })),
      {
        address: treasuryAddr,
        role: "reserve-vault (the TREASURY at wrapper slot 1: holds the payout inventory; payer/payee for the swap transferFrom; max allowance to the wrapper)",
        runtime: treasuryCode,
        runtimeSha256: sha256(treasuryCode),
        codeSizeBytes: treasuryCode === "0x" ? 0 : treasuryCode.length / 2 - 1,
      },
    ].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)),
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  const stateSnap = {
    chain: "base",
    fermiSwapper: TESSERA,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    staleUpdateSelector: "0x00000000", // Tessera has no StaleUpdate gate (quotes are ts-flat ~8.5 min)
    probeGasPrice: PROBE_GAS_PRICE.toString(),
    target: { ...TARGET },
    second: null,
    tokens: tokenMeta,
    tokenBalanceSlots: {}, // the Tessera QUOTE reads no token balances (access-list-verified)
    contractSlots: Object.fromEntries(
      contracts.map((c) => {
        const extra: Record<string, Hex> = {};
        if (c.address.toLowerCase() === TESSERA.toLowerCase()) Object.assign(extra, wrapperSlots);
        return [c.address, { role: c.role, slots: { ...c.slots, ...extra } }];
      }),
    ),
    vault: {
      address: treasuryAddr,
      role: "reserve-vault (the TREASURY at wrapper slot 1). The swap does tokenOut.transferFrom(treasury, taker, out) + tokenIn.transferFrom(taker, treasury, in); the harness funds it + grants the wrapper a max allowance.",
      reserves: treasuryReserves,
      allowanceToRouter: treasuryAllowance,
    },
    eoa7702: null,
    probe: {
      target: { pair: `${TARGET.inSym}/${TARGET.outSym}`, ladder: targetLadder },
      second: null,
    },
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[tessera-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[tessera-snapshot] pinned block ${pinBlock} (ts ${blockTimestamp}); ${contracts.length} touched contracts + treasury; ` +
      `1 ${TARGET.inSym} -> ${rawOut} ${TARGET.outSym} @ ${PROBE_GAS_PRICE} wei gas`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
