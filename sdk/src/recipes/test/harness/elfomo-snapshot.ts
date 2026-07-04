/**
 * One-time capture of the REAL ElfomoFi (a vault-funded PMM priced by an on-chain pricing module +
 * oracle feed) from Base mainnet, so the Elfomo prod-mirror EVM test runs OFFLINE (no fork, no RPC at
 * run time).
 *
 * Mirrors harness/fermi-snapshot.ts / harness/tessera-snapshot.ts (the proven pattern) AND EMITS THE SAME
 * FERMI SNAPSHOT SHAPE, so the prod-mirror test reuses the WHOLE fermi harness verbatim
 * (loadFermiSnapshots / verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp / etchFermiGraph):
 * eth_getCode the wrapper's REAL runtime AND every dependency contract the quote/swap path touches
 * (enumerated via eth_createAccessList on a DENSE quote ladder in BOTH directions PLUS the swap call),
 * into a checked-in bytecode snapshot (WITH sha256 anchors), and every touched storage slot into a state
 * snapshot. Block pinned. The RPC url / key is NEVER persisted — only contract CODE + STATE.
 *
 * ── THE CAPTURED GRAPH (verified by trace + access-list, 2026-07-04) ────────────────────────────────────
 *   1. the ElfomoFi wrapper (0xf0f0F0F0… — VERIFIED source; pricing + vault are IMMUTABLES baked into the
 *      runtime, so etching the real runtime carries them),
 *   2. the PRICING proxy (0xFFFFffBB…, TransparentUpgradeableProxy) + its implementation (0x00E36cE2…,
 *      delegatecalled — storage lives in the proxy),
 *   3. pricing SUB-MODULES (0x7F7B413D…, 0x0505E7E3… — surfaced by the access-list),
 *   4. the ORACLE FEED (0xf9b0c8Ee… — `timestamp()`/`infos` staleness + price source; slot 5 carries the
 *      last-update ts),
 *   plus the VAULT (0xBb1b19F1… — an IMMUTABLE of the wrapper; holds the payout inventory with max
 *   allowance to the wrapper; the snapshot's `vault` field, funded by the harness) and the tokens
 *   (WETH/USDC — repointed to local MintableERC20s by the harness; the quote reads token.balanceOf(vault),
 *   whose slot the harness seeds by FUNDING the vault with the captured reserves).
 *
 * ── THE STALENESS CUTOFF (why block.timestamp is PINNED) ────────────────────────────────────────────────
 * The pricing hard-zeroes the quote once block.timestamp is ~5–30 s past the feed's last update
 * (fork-measured; flat ≤ ~2 s extra). The feed's price slots are byte-identical fresh-vs-stale — only the
 * clock gates — so pinning block.timestamp to the captured block ts (where the feed is ≤ ~2 s old — Base
 * publishes every block or two) reproduces the EXACT real quote (NO price is fabricated; the same
 * un-stale-a-real-captured-price mechanism as Fermi's StaleUpdate pin). pinFermiBlockTimestamp does this.
 *
 * Re-capture (REQUIRED whenever the recipe's touched-contract set changes):
 *   set -a; . sdk/.env; set +a
 *   BASE_RPC_URL=$BASE_RPC_URL npx tsx src/recipes/test/harness/elfomo-snapshot.ts
 * Optional argv[2] = RPC url, argv[3] = an explicit fresh block to pin (else auto-scans backward).
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, getAddress, type Hex, type Address } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "base-elfomo-WETHUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The REAL verified ElfomoFi wrapper (Base blockscout verified; SAME address BSC). constants.ts wires it.
const ELFOMO = getAddress("0xf0f0F0F0FB0d738452EfD03A28e8be14C76d5f73") as Address;
// The VAULT — an IMMUTABLE of the wrapper (trace-verified 2026-07-04: the swap pays out via
// tokenOut.transferFrom(vault, receiver, out)); verified below to hold both-token inventory.
const VAULT = getAddress("0xBb1b19F138dB3925883a96FF7a304277460E0C99") as Address;

// Base on-charter tokens.
const WETH = getAddress("0x4200000000000000000000000000000000000006") as Address;
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;

const TARGET = { tokenIn: WETH, tokenOut: USDC, inSym: "WETH", outSym: "USDC" };

const RPC = process.argv[2] || process.env.BASE_RPC_URL || "";
const PIN_BLOCK_ARG = process.argv[3] ? BigInt(process.argv[3]) : null;
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set BASE_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const elfomoAbi = parseAbi([
  "function getAmountOut(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

// getAmountOut(address,address,uint256) calldata by hand (selector 0x4aa06652, verified at runtime).
function encodeQuoteCalldata(fromToken: Address, toToken: Address, amt: bigint): Hex {
  const selector = "4aa06652";
  const a = fromToken.slice(2).toLowerCase().padStart(64, "0");
  const b = toToken.slice(2).toLowerCase().padStart(64, "0");
  const c = amt.toString(16).padStart(64, "0");
  return ("0x" + selector + a + b + c) as Hex;
}

// swap(address,address,int256,uint256,address,uint256) calldata (limit 0, partnerId 0) — used ONLY for
// the swap-path access-list: the call runs pricing.getAmountOut + pricing.update + the vault payout
// transferFrom (which SUCCEEDS in simulation — the vault's real allowance exists) and reverts only at the
// final taker transferFrom, so every pricing/vault slot is touched before the revert point.
function encodeSwapCalldata(fromToken: Address, toToken: Address, amt: bigint, receiver: Address): Hex {
  const selector = "598edcad";
  const words = [
    fromToken.slice(2).toLowerCase().padStart(64, "0"),
    toToken.slice(2).toLowerCase().padStart(64, "0"),
    amt.toString(16).padStart(64, "0"),
    "0".padStart(64, "0"), // limitAmount 0
    receiver.slice(2).toLowerCase().padStart(64, "0"),
    "0".padStart(64, "0"), // partnerId 0
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
    params: [{ to, data, from } as never, blockHex as never],
  } as never)) as { accessList: { address: Address; storageKeys: Hex[] }[]; error?: string };
  if (!res || !res.accessList) throw new Error(`eth_createAccessList returned no list: ${JSON.stringify(res)}`);
  return res.accessList.map((e) => ({ address: getAddress(e.address) as Address, storageKeys: e.storageKeys }));
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 8453) console.warn(`[elfomo-snapshot] WARNING: chainId ${chainId} != Base (8453)`);

  const code = await client.getCode({ address: ELFOMO });
  if (!code || code === "0x") throw new Error(`ElfomoFi ${ELFOMO} has NO CODE on chainId ${chainId}`);

  // ── Pin a FRESH block: the quote must be > 0 (the graceful pricing zeroes once the feed is stale). ──
  const head = await client.getBlockNumber();
  const probeAmt = 10n ** 18n; // 1 WETH
  const quoteAtBlock = async (bn: bigint): Promise<bigint> =>
    (await client
      .readContract({
        address: ELFOMO, abi: elfomoAbi, functionName: "getAmountOut",
        args: [TARGET.tokenIn, TARGET.tokenOut, probeAmt], blockNumber: bn,
      })
      .catch(() => 0n)) as bigint;

  let pinBlock: bigint | null = PIN_BLOCK_ARG;
  if (pinBlock !== null) {
    const q = await quoteAtBlock(pinBlock);
    if (q <= 0n) throw new Error(`pinned block ${pinBlock} quotes 0 (stale feed) — pick another`);
    console.log(`[elfomo-snapshot] using explicit fresh block ${pinBlock} (out=${q})`);
  } else {
    for (let off = 0n; off <= 40n; off++) {
      const bn = head - off;
      const q = await quoteAtBlock(bn);
      if (q > 0n) {
        pinBlock = bn;
        console.log(`[elfomo-snapshot] FRESH at block ${bn} (1 ${TARGET.inSym} -> ${q} ${TARGET.outSym})`);
        break;
      }
    }
  }
  if (pinBlock === null) throw new Error("no FRESH block found in the last 40 blocks — try again");

  const blockHex = ("0x" + pinBlock.toString(16)) as Hex;
  const blk = await client.getBlock({ blockNumber: pinBlock });
  const blockTimestamp = blk.timestamp;
  console.log(`[elfomo-snapshot] pinned block=${pinBlock} timestamp=${blockTimestamp}`);

  // ── Verify the hand-encoded selector against readContract at the pin. ──
  const from = getAddress("0x000000000000000000000000000000000000dEaD") as Address;
  const rawQuote = (await client.request({
    method: "eth_call" as never,
    params: [{ to: ELFOMO, data: encodeQuoteCalldata(TARGET.tokenIn, TARGET.tokenOut, probeAmt), from } as never, blockHex as never],
  } as never)) as Hex;
  const outFromRaw = BigInt("0x" + rawQuote.slice(2, 2 + 64));
  const refOut = (await client.readContract({
    address: ELFOMO, abi: elfomoAbi, functionName: "getAmountOut",
    args: [TARGET.tokenIn, TARGET.tokenOut, probeAmt], blockNumber: pinBlock,
  })) as bigint;
  if (outFromRaw !== refOut) throw new Error(`hand-encoded getAmountOut mismatch: raw ${outFromRaw} != abi ${refOut}`);
  console.log(`[elfomo-snapshot] getAmountOut selector verified (raw==abi out=${outFromRaw})`);

  // ── Enumerate the touched-contract + touched-slot set: DENSE geometric quote ladders BOTH directions
  //    + the SWAP call (covers pricing.update + the vault payout before the taker-pull revert). ──
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
      addEntries(await createAccessList(client, ELFOMO, encodeQuoteCalldata(TARGET.tokenIn, TARGET.tokenOut, amt), from, blockHex));
    } catch (e) {
      void e;
    }
  }
  for (const amt of denseLadder(1758n * 10n ** 6n)) {
    try {
      addEntries(await createAccessList(client, ELFOMO, encodeQuoteCalldata(TARGET.tokenOut, TARGET.tokenIn, amt), from, blockHex));
    } catch (e) {
      void e;
    }
  }
  for (const amt of [10n ** 17n, 10n ** 18n, 2n * 10n ** 18n]) {
    try {
      addEntries(await createAccessList(client, ELFOMO, encodeSwapCalldata(TARGET.tokenIn, TARGET.tokenOut, amt, from), from, blockHex));
    } catch (e) {
      void e;
    }
  }
  // getSupportedPairs() — the DISCOVERY surface: the pairs array lives in the PRICING proxy's storage
  // (length slot + keccak-derived element slots), which the quote/swap paths never touch. Without these
  // slots the etched wrapper enumerates an empty pair set and discovery finds nothing.
  addEntries(await createAccessList(client, ELFOMO, "0xd527c998" as Hex, from, blockHex));

  // ── The VAULT (an IMMUTABLE — no wrapper storage slot to read it from): verify + capture reserves. ──
  const bal = (t: Address, who: Address) =>
    client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber: pinBlock }) as Promise<bigint>;
  const allow = (t: Address, o: Address, sp: Address) =>
    client.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [o, sp], blockNumber: pinBlock }) as Promise<bigint>;
  const vaultReserves = {
    WETH: (await bal(WETH, VAULT)).toString(),
    USDC: (await bal(USDC, VAULT)).toString(),
  };
  const vaultAllowance = {
    WETH: (await allow(WETH, VAULT, ELFOMO)).toString(),
    USDC: (await allow(USDC, VAULT, ELFOMO)).toString(),
  };
  if (BigInt(vaultReserves.WETH) === 0n && BigInt(vaultReserves.USDC) === 0n) {
    throw new Error(`vault ${VAULT} holds NO WETH/USDC — the immutable vault address changed? Re-derive from a trace.`);
  }
  const vaultCode = (await client.getCode({ address: VAULT, blockNumber: pinBlock })) ?? "0x";
  console.log(`[elfomo-snapshot] VAULT ${VAULT} reserves WETH=${vaultReserves.WETH} USDC=${vaultReserves.USDC} code=${vaultCode === "0x" ? 0 : vaultCode.length / 2 - 1}B`);

  // ── Capture code (sha256-anchored) + every touched storage slot for every touched contract. ──
  const TOKENS = new Set([WETH.toLowerCase(), USDC.toLowerCase()]);
  const contracts: { address: Address; role: string; runtime: string; runtimeSha256: Hex; codeSizeBytes: number; slots: Record<string, Hex> }[] = [];
  for (const [addrLc, slotSet] of [...merged.entries()].sort()) {
    const address = getAddress(addrLc) as Address;
    const c = await client.getCode({ address, blockNumber: pinBlock });
    const runtime = c ?? "0x";
    const isToken = TOKENS.has(addrLc);
    const role =
      addrLc === ELFOMO.toLowerCase()
        ? "ElfomoFi wrapper"
        : addrLc === VAULT.toLowerCase()
          ? "vault (also touched on the swap path)"
          : isToken
            ? "token (repointed by harness)"
            : "pricing-dependency";
    const slots: Record<string, Hex> = {};
    for (const slot of [...slotSet].sort()) {
      const v = await client.getStorageAt({ address, slot: slot as Hex, blockNumber: pinBlock });
      slots[slot] = (v ?? ("0x" + "0".repeat(64))) as Hex;
    }
    contracts.push({ address, role, runtime, runtimeSha256: sha256(runtime), codeSizeBytes: runtime === "0x" ? 0 : runtime.length / 2 - 1, slots });
    console.log(`[elfomo-snapshot]  touched ${address} [${role}] code=${runtime === "0x" ? 0 : runtime.length / 2 - 1}B slots=${Object.keys(slots).length}`);
  }

  // ── Token metadata + ground-truth probe ladder at the pinned fresh block. ──
  const meta = async (t: Address) => ({
    address: t,
    symbol: await client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    decimals: Number(await client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }).catch(() => 18)),
  });
  const tokenMeta = { WETH: await meta(WETH), USDC: await meta(USDC) };

  const ladder = async (fromT: Address, toT: Address, amts: bigint[]) => {
    const pts: { amountIn: string; amountOut: string }[] = [];
    for (const amt of amts) {
      try {
        const out = (await client.readContract({
          address: ELFOMO, abi: elfomoAbi, functionName: "getAmountOut",
          args: [fromT, toT, amt], blockNumber: pinBlock,
        })) as bigint;
        pts.push({ amountIn: amt.toString(), amountOut: out.toString() });
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
  //    Elfomo VAULT, so loadFermiSnapshots/etchFermiGraph/pinFermiBlockTimestamp consume them verbatim. ──
  const bytecodeSnap = {
    chain: "base",
    fermiSwapper: ELFOMO,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    note:
      "ElfomoFi (vault-funded PMM + on-chain pricing module + oracle feed). FERMI-SHAPED snapshot (fermiSwapper " +
      "= the wrapper; vault = the Elfomo VAULT — an IMMUTABLE of the wrapper runtime) so the fermi harness " +
      "(loadFermiSnapshots / verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp / etchFermiGraph) is reused " +
      "verbatim. The pricing HARD-ZEROES quotes once block.timestamp is ~5-30 s past the feed's last update, so " +
      "the harness MUST pin block.timestamp to blockTimestamp (pinFermiBlockTimestamp) before every quote/cook — " +
      "the same un-stale-a-real-captured-price mechanism as Fermi's StaleUpdate gate.",
    contracts: [
      ...contracts.map((c) => ({ address: c.address, role: c.role, runtime: c.runtime, runtimeSha256: c.runtimeSha256, codeSizeBytes: c.codeSizeBytes })),
      // The vault (if the access-list didn't already surface it — merged below by address sort/unique).
      ...(merged.has(VAULT.toLowerCase())
        ? []
        : [
            {
              address: VAULT as Address,
              role: "reserve-vault (an IMMUTABLE of the wrapper: holds the payout inventory; payer/payee for the swap transferFrom; max allowance to the wrapper)",
              runtime: vaultCode,
              runtimeSha256: sha256(vaultCode),
              codeSizeBytes: vaultCode === "0x" ? 0 : vaultCode.length / 2 - 1,
            },
          ]),
    ].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)),
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  const stateSnap = {
    chain: "base",
    fermiSwapper: ELFOMO,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    staleUpdateSelector: "0x00000000", // Elfomo's staleness is a GRACEFUL 0, not a revert selector
    target: { ...TARGET },
    second: null,
    tokens: tokenMeta,
    tokenBalanceSlots: {}, // token balances are repointed (the vault is FUNDED by the harness)
    contractSlots: Object.fromEntries(
      contracts.map((c) => [c.address, { role: c.role, slots: c.slots }]),
    ),
    vault: {
      address: VAULT,
      role: "reserve-vault (an IMMUTABLE of the wrapper). The quote path reads token.balanceOf(vault); the swap does tokenOut.transferFrom(vault, receiver, out) + tokenIn.transferFrom(taker, vault, in); the harness funds it + grants the wrapper a max allowance.",
      reserves: vaultReserves,
      allowanceToRouter: vaultAllowance,
    },
    eoa7702: null,
    probe: {
      target: { pair: `${TARGET.inSym}/${TARGET.outSym}`, ladder: targetLadder },
      second: null,
    },
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[elfomo-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[elfomo-snapshot] pinned block ${pinBlock} (ts ${blockTimestamp}); ${contracts.length} touched contracts; ` +
      `1 ${TARGET.inSym} -> ${refOut} ${TARGET.outSym}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
