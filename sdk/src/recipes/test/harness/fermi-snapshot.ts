/**
 * One-time capture of the REAL Fermi / propAMM FermiSwapper (gattaca-com/propamm — an Obric-style
 * PROACTIVE, oracle-priced AMM) from Ethereum mainnet, so the Fermi prod-mirror EVM test runs OFFLINE
 * (no fork, no RPC at run time).
 *
 * Mirrors harness/dodo-snapshot.ts / harness/woofi-snapshot.ts (the proven pattern): eth_getCode the
 * FermiSwapper's REAL runtime AND every dependency contract the quote/swap path touches, into a
 * checked-in bytecode snapshot (WITH sha256 integrity anchors), and the swap-relevant state (every
 * touched storage slot across ALL those contracts, enumerated via eth_createAccessList on the quote AND
 * swap calls) into a state snapshot. Block pinned. The RPC url / key is NEVER persisted — only contract
 * CODE + STATE.
 *
 * ── THE FRESHNESS / STALEUPDATE FACT (why the block must be pinned) ──────────────────────────────────
 * The FermiSwapper is a PROACTIVE, oracle-priced AMM: `quoteAmounts(tokenIn, tokenOut, +amt)` returns a
 * price computed from an on-chain ORACLE STORE (0xe514A3c4…), guarded by a staleness check. When
 * `block.timestamp` is more than a small maxAge past the feed's last on-chain update, the quote REVERTS
 * `StaleUpdate()` (selector 0x666a2814). Empirically the per-pair freshness window is ≈2 blocks (≈24 s):
 * a pair quotes fresh for a couple of blocks after each feed update, then goes stale until the next.
 *
 * VERIFIED (this capture): the oracle store slots for the target feed are BYTE-IDENTICAL at a fresh block
 * and the next (stale) block — ONLY `block.timestamp` crosses the maxAge deadline; the price/config state
 * does not change. So etching the captured code + reconstructing the captured storage slots + PINNING
 * `block.timestamp` to the captured fresh block's timestamp reproduces the EXACT real quote. This is the
 * "bump a timestamp to un-stale a REAL captured price" case: NO price is fabricated — the price is the
 * real on-chain oracle value in the captured slots; only the staleness clock is held at the capture
 * instant (exactly the SNAPSHOTTED-QUOTE class fermi-math.ts documents). The offline harness therefore
 * MUST set `block.timestamp` to `state.blockTimestamp` (via setNextBlockTimestamp) before every
 * quote/cook, or the quote reverts StaleUpdate.
 *
 * WHICH PAIR: the deepest on-charter quotable pair. FermiSwapper.getPairs() lists WETH/USDC, WETH/USDT,
 * USDC/USDT, WBTC/USDT, WBTC/USDC, cbBTC/USDC, cbBTC/USDT, WBTC/cbBTC. The USDC/USDT stable feed is
 * PERSISTENTLY stale (never quotes). Of the quotable pairs, WETH/USDC has the deepest, cleanest depth
 * curve (real curvature across sizes; caps near the reserve-implied max) and pairs the volatile leg with
 * the on-charter stablecoin baseToken USDC — the same on-charter-with-a-stable convention as the
 * WOOFi/DODO WETH-USDC prod-mirrors. It is captured as the target; WBTC/USDC is captured as a second
 * quotable pair for the split cell (same oracle store, one extra feed).
 *
 * DEPENDENCY CONTRACTS captured (every contract the quote/swap staticcall path touches, per the
 * access-list — proxies resolved; all are non-proxy self-contained runtimes):
 *   1. the FermiSwapper itself (0xb1076fE3…),
 *   2. the ORACLE STORE (0xe514A3c4…) — the priced-feed state store (per-feed price/config/last-update),
 *   3. a MATH/LIBRARY contract (0x43506849…) — code-only touched (CALLed, no storage),
 *   4. a small feed helper (0xDa7AfeeD…) — one touched slot,
 *   5. any further contract the access-list surfaces (enumerated dynamically, not hardcoded).
 * The tokens (WETH/USDC/WBTC) are NOT pricing dependencies — their storage is inventory only; the
 * offline harness repoints them at local MintableERC20s and funds the pool, so their code/slots are
 * recorded for reference but the reconstruction repoints them.
 *
 * Re-capture (REQUIRED whenever the recipe's touched-contract set changes):
 *   set -a; . sdk/.env; set +a
 *   ETH_RPC_URL=$ETH_RPC_URL npx tsx src/recipes/test/harness/fermi-snapshot.ts
 * Optional argv[2] = RPC url, argv[3] = an explicit fresh block to pin (else auto-scans backward for one).
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, getAddress, keccak256, encodeAbiParameters, type Hex, type Address } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "ethereum-fermi-WETHUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The REAL verified FermiSwapper (Etherscan-verified; Ethereum only). constants.ts flags it.
const FERMI = getAddress("0xb1076fE3AB5e28005C7c323Bac5AC06a680d452e") as Address;

// Ethereum on-charter baseTokens (constants.ts CHAIN_POOL_CONFIGS.ethereum.baseTokens).
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2") as Address;
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") as Address;
const WBTC = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599") as Address;

// Target pair (deepest quotable, on-charter via USDC) + a second quotable pair for the split cell.
const TARGET = { tokenIn: WETH, tokenOut: USDC, inSym: "WETH", outSym: "USDC" };
const SECOND = { tokenIn: WBTC, tokenOut: USDC, inSym: "WBTC", outSym: "USDC" };

const STALE_UPDATE_SELECTOR = "0x666a2814"; // StaleUpdate()

const RPC = process.argv[2] || process.env.ETH_RPC_URL || process.env.ETHEREUM_RPC_URL || "";
const PIN_BLOCK_ARG = process.argv[3] ? BigInt(process.argv[3]) : null;
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set ETH_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const fermiAbi = parseAbi([
  "function quoteAmounts(address tokenIn, address tokenOut, int256 amountSpecified) view returns (uint256 amountIn, uint256 amountOut)",
  "function isActive(address a, address b) view returns (bool)",
  "function getPairs() view returns (bytes)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

// Encode quoteAmounts(tokenIn, tokenOut, int256 amt) calldata by hand (avoid pulling in extra deps).
// selector of quoteAmounts(address,address,int256) — verified at runtime against a real fresh quote.
function encodeQuoteCalldata(tokenIn: Address, tokenOut: Address, amt: bigint): Hex {
  const selector = "300aa47f";
  const a = tokenIn.slice(2).toLowerCase().padStart(64, "0");
  const b = tokenOut.slice(2).toLowerCase().padStart(64, "0");
  const c = (amt < 0n ? (1n << 256n) + amt : amt).toString(16).padStart(64, "0");
  return ("0x" + selector + a + b + c) as Hex;
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
  if (chainId !== 1) console.warn(`[fermi-snapshot] WARNING: chainId ${chainId} != Ethereum (1)`);

  // ── Sanity: the FermiSwapper has code and lists the target pair active. ──
  const code = await client.getCode({ address: FERMI });
  if (!code || code === "0x") throw new Error(`FermiSwapper ${FERMI} has NO CODE on chainId ${chainId}`);

  // ── Pin a FRESH block: scan backward until quoteAmounts(target) does NOT revert StaleUpdate. ──
  const head = await client.getBlockNumber();
  const probeAmt = 10n ** 18n; // 1 WETH probe (target is WETH-in)
  const isFreshAt = async (bn: bigint): Promise<{ fresh: boolean; out?: bigint }> => {
    try {
      const r = (await client.readContract({
        address: FERMI,
        abi: fermiAbi,
        functionName: "quoteAmounts",
        args: [TARGET.tokenIn, TARGET.tokenOut, probeAmt],
        blockNumber: bn,
      })) as readonly [bigint, bigint];
      return { fresh: true, out: r[1] };
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (!msg.includes(STALE_UPDATE_SELECTOR) && !/StaleUpdate|stale|revert/i.test(msg)) {
        // An unexpected error (not staleness) — surface it.
        console.warn(`[fermi-snapshot] block ${bn}: unexpected quote error: ${msg.slice(0, 160)}`);
      }
      return { fresh: false };
    }
  };

  let pinBlock: bigint | null = PIN_BLOCK_ARG;
  if (pinBlock !== null) {
    const f = await isFreshAt(pinBlock);
    if (!f.fresh) throw new Error(`pinned block ${pinBlock} is STALE for ${TARGET.inSym}/${TARGET.outSym} — pick another`);
    console.log(`[fermi-snapshot] using explicit fresh block ${pinBlock} (out=${f.out})`);
  } else {
    console.log(`[fermi-snapshot] scanning backward from head ${head} for a FRESH ${TARGET.inSym}/${TARGET.outSym} block…`);
    for (let off = 0n; off <= 40n; off++) {
      const bn = head - off;
      const f = await isFreshAt(bn);
      if (f.fresh) {
        pinBlock = bn;
        console.log(`[fermi-snapshot] FRESH at block ${bn} (1 ${TARGET.inSym} -> ${f.out} ${TARGET.outSym})`);
        break;
      }
    }
  }
  if (pinBlock === null) throw new Error(`no FRESH ${TARGET.inSym}/${TARGET.outSym} block found in the last 40 blocks — try again (the feed updates roughly every ~24s)`);

  const blockHex = ("0x" + pinBlock.toString(16)) as Hex;
  const blk = await client.getBlock({ blockNumber: pinBlock });
  const blockTimestamp = blk.timestamp;
  console.log(`[fermi-snapshot] pinned block=${pinBlock} timestamp=${blockTimestamp}`);

  // Also confirm the SECOND pair is fresh at the same pinned block (else drop it — the target still holds).
  let secondFresh = false;
  let secondOut = 0n;
  try {
    const r2 = (await client.readContract({
      address: FERMI, abi: fermiAbi, functionName: "quoteAmounts",
      args: [SECOND.tokenIn, SECOND.tokenOut, 10n ** 8n], blockNumber: pinBlock,
    })) as readonly [bigint, bigint];
    secondFresh = true;
    secondOut = r2[1];
    console.log(`[fermi-snapshot] SECOND ${SECOND.inSym}/${SECOND.outSym} also FRESH at pin (1 ${SECOND.inSym} -> ${secondOut} ${SECOND.outSym})`);
  } catch {
    console.log(`[fermi-snapshot] SECOND ${SECOND.inSym}/${SECOND.outSym} is STALE at the pin block — capturing target-only`);
  }

  // ── Verify the quoteAmounts selector our access-list calldata uses is correct (guards a silent typo). ──
  const targetCalldata = encodeQuoteCalldata(TARGET.tokenIn, TARGET.tokenOut, probeAmt);
  const rawQuote = (await client.request({
    method: "eth_call" as never,
    params: [{ to: FERMI, data: targetCalldata } as never, blockHex as never],
  } as never)) as Hex;
  // decode the second word (amountOut) and compare to the readContract out
  const outFromRaw = BigInt("0x" + rawQuote.slice(2 + 64, 2 + 128));
  const refOut = (await client.readContract({
    address: FERMI, abi: fermiAbi, functionName: "quoteAmounts",
    args: [TARGET.tokenIn, TARGET.tokenOut, probeAmt], blockNumber: pinBlock,
  })) as readonly [bigint, bigint];
  if (outFromRaw !== refOut[1]) {
    throw new Error(`hand-encoded quoteAmounts calldata mismatch: raw ${outFromRaw} != abi ${refOut[1]} (selector wrong?)`);
  }
  console.log(`[fermi-snapshot] quoteAmounts selector verified (raw==abi out=${outFromRaw})`);

  // ── Enumerate the WHOLE touched-contract + touched-slot set via eth_createAccessList on the quote calls
  //    for BOTH pairs (and both would-be swap directions we cover). We only access-list the QUOTE (view)
  //    — the swap exec path (fermiSwapWithAllowances) touches the SAME oracle/library/store set (verified),
  //    plus token inventory slots that the harness repoints; capturing the quote's set is the pricing state. ──
  const from = getAddress("0x000000000000000000000000000000000000dEaD") as Address;
  const merged = new Map<string, Set<string>>();
  const addEntries = (entries: AccessListEntry[]) => {
    for (const e of entries) {
      const key = e.address.toLowerCase();
      if (!merged.has(key)) merged.set(key, new Set());
      const set = merged.get(key)!;
      for (const s of e.storageKeys) set.add(s.toLowerCase());
    }
  };

  // The quote is PRICE-PATH-DEPENDENT: different trade sizes walk different segments of the oracle
  // store's tier/liquidity ladder, touching DIFFERENT slots. A sparse size set misses the slots that
  // intermediate sizes read (verified: a 5-WETH quote reads two 0x4455…68a8/9 slots a 1/100-WETH quote
  // does not). So we access-list a DENSE geometric ladder across [tiny, cap] in BOTH directions and
  // UNION every touched slot — the reconstruction is complete only if every size's slots are captured.
  const denseLadder = (base: bigint): bigint[] => {
    const out: bigint[] = [];
    // ~90 points across ~7 decades around `base` (base = the pair's ~1-unit size). The wide, fine grid
    // guarantees every price segment the oracle store walks (per size) is surfaced by SOME sample, so
    // the unioned slot set is complete for any trade size the recipe's own ladder sampler will use.
    for (let e = -4; e <= 3; e++) {
      for (const m of [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]) {
        const scale = 10n ** BigInt(Math.abs(e));
        const v = e < 0 ? (base * m) / (10n * scale) : base * m * scale;
        if (v > 0n) out.push(v);
      }
    }
    return [...new Set(out)].sort((a, b) => (a < b ? -1 : 1));
  };
  const targetSizes = denseLadder(probeAmt); // probeAmt = 1 WETH
  for (const amt of targetSizes) {
    addEntries(await createAccessList(client, FERMI, encodeQuoteCalldata(TARGET.tokenIn, TARGET.tokenOut, amt), from, blockHex));
  }
  // The reverse direction (USDC->WETH) touches the same feed store, capture its ladder too.
  for (const amt of denseLadder(1613n * 10n ** 6n)) {
    try {
      addEntries(await createAccessList(client, FERMI, encodeQuoteCalldata(TARGET.tokenOut, TARGET.tokenIn, amt), from, blockHex));
    } catch (e) {
      void e; // a stale/reverting reverse leg is fine — the forward leg is the target
    }
  }
  // Second pair (if fresh) — its feed slots live in the SAME oracle store; capture them so the split cell
  // works. WBTC is 8-dec and its quote caps by ~0.5 WBTC, so base the ladder at 0.1 WBTC (1e7) to sample
  // densely BELOW the cap where the segments change.
  if (secondFresh) {
    for (const amt of denseLadder(10n ** 7n)) {
      try {
        addEntries(await createAccessList(client, FERMI, encodeQuoteCalldata(SECOND.tokenIn, SECOND.tokenOut, amt), from, blockHex));
      } catch (e) {
        void e;
      }
    }
  }

  // Also access-list the EXACT probe-ladder sizes both pairs will be asserted at — guarantees the
  // reconstruction is complete for every point the offline self-check reads (belt-and-suspenders over
  // the geometric ladder above).
  const probeSizes: [{ tokenIn: Address; tokenOut: Address }, bigint[]][] = [
    [TARGET, [10n ** 17n, 5n * 10n ** 17n, 10n ** 18n, 5n * 10n ** 18n, 10n ** 19n, 2n * 10n ** 19n, 5n * 10n ** 19n, 10n ** 20n]],
  ];
  if (secondFresh) probeSizes.push([SECOND, [10n ** 7n, 5n * 10n ** 7n, 10n ** 8n, 5n * 10n ** 8n, 10n ** 9n]]);
  for (const [pair, sizes] of probeSizes) {
    for (const amt of sizes) {
      try {
        addEntries(await createAccessList(client, FERMI, encodeQuoteCalldata(pair.tokenIn, pair.tokenOut, amt), from, blockHex));
      } catch (e) {
        void e;
      }
    }
  }

  // ── Resolve token proxy IMPLEMENTATIONS. The quote reads token.balanceOf(fermiSwapper) THROUGH the
  //    token; USDC is a proxy whose impl lives in a NON-standard slot (0x7050c9e0…), reached via
  //    delegatecall — so the impl runtime is ALSO touched (as a code-only entry) and MUST be captured.
  //    The access-list surfaces the impl as its own address; we tag it as the token's implementation. ──
  const USDC_IMPL_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3" as Hex;
  const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
  const readAddrSlot = async (proxy: Address, slot: Hex): Promise<Address | null> => {
    const v = await client.getStorageAt({ address: proxy, slot, blockNumber: pinBlock });
    if (!v || v === "0x" || BigInt(v) === 0n) return null;
    return getAddress(("0x" + v.slice(-40)) as Hex) as Address;
  };
  const tokenImpls = new Map<string, Address>(); // impl addr(lc) -> owning token
  for (const t of [USDC, WETH, WBTC]) {
    const impl = (await readAddrSlot(t, USDC_IMPL_SLOT)) ?? (await readAddrSlot(t, EIP1967_IMPL_SLOT));
    if (impl && impl.toLowerCase() !== t.toLowerCase()) {
      tokenImpls.set(impl.toLowerCase(), t);
      console.log(`[fermi-snapshot]  token ${t} is a proxy -> impl ${impl}`);
    }
  }

  // ── Explicitly capture each token's balanceOf(fermiSwapper) slot — the quote is RESERVE-SENSITIVE
  //    (the oracle-priced curve reads the pool's live reserve into its math). USDC balances live in
  //    mapping slot 9, WETH/WBTC in mapping slot 3 (FiatToken/WETH9 layouts). We record these so the
  //    reconstruction can set the EXACT captured reserve for a wei-exact quote-vs-view self-check (the
  //    harness OVERRIDES them when funding the pool for the executable prod-mirror). ──
  const tokenBalanceSlots: Record<string, { balanceMappingSlot: number; slot: Hex; reserve: string }> = {};
  const balSlot = (holder: Address, mappingSlot: number): Hex =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(mappingSlot)]));
  for (const [t, sym, mappingSlot] of [
    [USDC, "USDC", 9],
    [WETH, "WETH", 3],
    [WBTC, "WBTC", 0],
  ] as const) {
    const slot = balSlot(FERMI, mappingSlot);
    const reserve = (await client.getStorageAt({ address: t, slot, blockNumber: pinBlock })) ?? ("0x" + "0".repeat(64));
    tokenBalanceSlots[sym] = { balanceMappingSlot: mappingSlot, slot, reserve };
    console.log(`[fermi-snapshot]  reserve ${sym}.balanceOf(fermi) slot ${slot} = ${BigInt(reserve)}`);
  }

  // ── Capture code (sha256-anchored) + every touched storage slot for every touched contract. ──
  const TOKENS = new Set([WETH.toLowerCase(), USDC.toLowerCase(), WBTC.toLowerCase()]);
  const contracts: {
    address: Address;
    role: string;
    runtime: string;
    runtimeSha256: Hex;
    codeSizeBytes: number;
    slots: Record<string, Hex>;
  }[] = [];

  for (const [addrLc, slotSet] of [...merged.entries()].sort()) {
    const address = getAddress(addrLc) as Address;
    const c = await client.getCode({ address, blockNumber: pinBlock });
    const runtime = c ?? "0x";
    const isToken = TOKENS.has(addrLc);
    const isFermi = addrLc === FERMI.toLowerCase();
    const ownerTok = tokenImpls.get(addrLc);
    const role = isFermi
      ? "FermiSwapper"
      : isToken
        ? "token (repointed by harness)"
        : ownerTok
          ? `token-implementation of ${ownerTok} (repointed by harness)`
          : "pricing-dependency";
    const slots: Record<string, Hex> = {};
    for (const slot of [...slotSet].sort()) {
      const v = await client.getStorageAt({ address, slot: slot as Hex, blockNumber: pinBlock });
      slots[slot] = (v ?? ("0x" + "0".repeat(64))) as Hex;
    }
    contracts.push({
      address,
      role,
      runtime,
      runtimeSha256: sha256(runtime),
      codeSizeBytes: runtime === "0x" ? 0 : runtime.length / 2 - 1,
      slots,
    });
    console.log(`[fermi-snapshot]  touched ${address} [${role}] code=${runtime === "0x" ? 0 : runtime.length / 2 - 1}B slots=${Object.keys(slots).length}`);
  }

  // ── The RESERVE VAULT + router config slots + the EIP-7702 EOA designator (the pieces the QUOTE access-list
  //    does NOT surface but the QUOTE and SWAP require — verified by the offline replay). ────────────────────
  //
  //  · FermiSwapper storage slots 0..3 hold config. Slot 2 == the oracle store (already in the access-list);
  //    slot 3 == the RESERVE VAULT (the address that HOLDS the token inventory). The QUOTE reads
  //    token.balanceOf(VAULT) for its curve math (NOT balanceOf the router — the router's own balances are
  //    dust); the SWAP does token.transferFrom(VAULT, taker, out) + transferFrom(taker, VAULT, in), so the
  //    payer/payee is the VAULT, resolved via slot 3. The access-list on the QUOTE only surfaces slot 2, so we
  //    capture slots 0..3 explicitly here.
  //  · The VAULT's runtime + reserves + its (max) allowance to the router are ALL needed offline: the harness
  //    funds the vault with the captured reserves and grants it the router allowance so the payout transferFrom
  //    lands. (The vault CODE is captured for the byte-equal integrity anchor even though the quote reads only
  //    its token balances.)
  //  · The quote/swap path also touches an EIP-7702 delegated EOA (0x4838b1…) via EXTCODESIZE/BALANCE — an
  //    empty (codeless) account makes the FermiSwapper branch to a 0 quote, so we capture its 24-byte
  //    0xef0100||delegate designator and the harness etches it.
  const routerSlots: Record<string, Hex> = {};
  for (let s = 0n; s <= 3n; s++) {
    const key = ("0x" + s.toString(16).padStart(64, "0")) as Hex;
    routerSlots[key] = ((await client.getStorageAt({ address: FERMI, slot: key, blockNumber: pinBlock })) ?? ("0x" + "0".repeat(64))) as Hex;
  }
  const vaultAddr = getAddress(("0x" + routerSlots["0x0000000000000000000000000000000000000000000000000000000000000003"].slice(-40)) as Hex) as Address;
  const vaultCode = (await client.getCode({ address: vaultAddr, blockNumber: pinBlock })) ?? "0x";
  console.log(`[fermi-snapshot]  reserve VAULT (router slot 3) ${vaultAddr} code=${vaultCode === "0x" ? 0 : vaultCode.length / 2 - 1}B`);
  const bal = (t: Address, who: Address) =>
    client.readContract({ address: t, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who], blockNumber: pinBlock }) as Promise<bigint>;
  const allow = (t: Address, o: Address, sp: Address) =>
    client.readContract({ address: t, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [o, sp], blockNumber: pinBlock }) as Promise<bigint>;
  const vaultReserves = {
    WETH: (await bal(WETH, vaultAddr)).toString(),
    USDC: (await bal(USDC, vaultAddr)).toString(),
    WBTC: (await bal(WBTC, vaultAddr)).toString(),
  };
  const vaultAllowance = {
    WETH: (await allow(WETH, vaultAddr, FERMI)).toString(),
    USDC: (await allow(USDC, vaultAddr, FERMI)).toString(),
    WBTC: (await allow(WBTC, vaultAddr, FERMI)).toString(),
  };
  console.log(`[fermi-snapshot]  vault reserves WETH=${vaultReserves.WETH} USDC=${vaultReserves.USDC} WBTC=${vaultReserves.WBTC}`);

  // The EIP-7702 EOA (touched via EXTCODESIZE/BALANCE) — enumerate it from the QUOTE prestate would be ideal,
  // but it is stable; capture the designator of any 7702 EOA the FermiSwapper references. We know it from the
  // trace; capture its code (0xef0100||delegate). If it has no 7702 code it is skipped (best-effort).
  const EOA7702 = getAddress("0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97") as Address;
  const eoa7702Code = (await client.getCode({ address: EOA7702, blockNumber: pinBlock })) ?? "0x";
  const eoa7702Delegate = eoa7702Code.startsWith("0xef0100") ? (getAddress(("0x" + eoa7702Code.slice(8)) as Hex) as Address) : null;
  if (eoa7702Delegate) console.log(`[fermi-snapshot]  EIP-7702 EOA ${EOA7702} -> delegate ${eoa7702Delegate}`);

  // ── Token metadata (decimals/symbol) for the harness's local-mint repoint. ──
  const meta = async (t: Address) => ({
    address: t,
    symbol: await client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    decimals: Number(await client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }).catch(() => 18)),
  });
  const tokenMeta = {
    WETH: await meta(WETH),
    USDC: await meta(USDC),
    WBTC: await meta(WBTC),
  };

  // ── Probe quote ladders at the pinned fresh block — the ground truth the offline test reproduces. ──
  const ladder = async (pair: { tokenIn: Address; tokenOut: Address }, amts: bigint[]) => {
    const pts: { amountIn: string; amountOut: string }[] = [];
    for (const amt of amts) {
      try {
        const r = (await client.readContract({
          address: FERMI, abi: fermiAbi, functionName: "quoteAmounts",
          args: [pair.tokenIn, pair.tokenOut, amt], blockNumber: pinBlock,
        })) as readonly [bigint, bigint];
        pts.push({ amountIn: amt.toString(), amountOut: r[1].toString() });
      } catch {
        pts.push({ amountIn: amt.toString(), amountOut: "STALE_OR_REVERT" });
      }
    }
    return pts;
  };
  const targetLadder = await ladder(TARGET, [
    10n ** 17n, 5n * 10n ** 17n, 10n ** 18n, 5n * 10n ** 18n, 10n ** 19n, 2n * 10n ** 19n, 5n * 10n ** 19n, 10n ** 20n,
  ]);
  const secondLadder = secondFresh ? await ladder(SECOND, [10n ** 7n, 5n * 10n ** 7n, 10n ** 8n, 5n * 10n ** 8n, 10n ** 9n]) : [];

  // ── Write the bytecode snapshot (WITH sha256 anchors). ──
  const bytecodeSnap = {
    chain: "ethereum",
    fermiSwapper: FERMI,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    note:
      "Fermi / propAMM oracle-priced proactive AMM. The QUOTE reads token.balanceOf(VAULT = FermiSwapper slot 3), " +
      "NOT balanceOf(the router). Offline harness MUST pin block.timestamp to blockTimestamp (setNextBlockTimestamp) " +
      "before every quoteAmounts/cook, else the oracle staleness gate reverts StaleUpdate() (0x666a2814). The oracle " +
      "price/config slots are byte-identical fresh-vs-stale — only block.timestamp gates.",
    contracts: [
      ...contracts.map((c) => ({
        address: c.address,
        role: c.role,
        runtime: c.runtime,
        runtimeSha256: c.runtimeSha256,
        codeSizeBytes: c.codeSizeBytes,
      })),
      // The reserve VAULT (router slot 3) — captured for the byte-equal integrity anchor + etched by the harness
      // so the swap's transferFrom(vault,…) executes. The QUOTE reads token.balanceOf(vault); the vault CODE is
      // etched so the graph is complete (byte-equal), though the quote reads only its token balances.
      {
        address: vaultAddr,
        role: "reserve-vault (holds token inventory; payer/payee for the swap transferFrom; read via FermiSwapper storage slot 3)",
        runtime: vaultCode,
        runtimeSha256: sha256(vaultCode),
        codeSizeBytes: vaultCode === "0x" ? 0 : vaultCode.length / 2 - 1,
      },
      // The EIP-7702 delegated EOA (touched via EXTCODESIZE/BALANCE) — its 24-byte 0xef0100||delegate designator.
      ...(eoa7702Delegate
        ? [
            {
              address: EOA7702 as Address,
              role: `EIP-7702 delegated EOA (quote/swap path touches its code designator via EXTCODESIZE/BALANCE; delegate ${eoa7702Delegate})`,
              runtime: eoa7702Code,
              runtimeSha256: sha256(eoa7702Code),
              codeSizeBytes: eoa7702Code.length / 2 - 1,
            },
          ]
        : []),
    ].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)),
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Write the state snapshot (every touched slot across every touched contract + probe ladders). ──
  const stateSnap = {
    chain: "ethereum",
    fermiSwapper: FERMI,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    staleUpdateSelector: STALE_UPDATE_SELECTOR,
    target: { ...TARGET },
    second: secondFresh ? { ...SECOND } : null,
    tokens: tokenMeta,
    // The quote is RESERVE-SENSITIVE: quoteAmounts reads token.balanceOf(fermiSwapper) into its curve
    // math (and caps at an oracle-configured notional). These are the exact captured reserves + their
    // storage slots. The offline harness sets these EXACT values for a wei-exact quote-vs-view self-check;
    // it OVERRIDES them (funds the pool) for the executable prod-mirror — at which point the quote tracks
    // the FUNDED reserve, not the dust-reserve capture (see the mirrorability note in the return).
    tokenBalanceSlots,
    // The touched-slot reconstruction: for EVERY touched contract, address -> { slot: value }.
    // The harness setCode's each contract's runtime (from the bytecode snapshot) and setStorageAt's these.
    // The per-token balanceOf(fermi) slots above are folded into the token entries here so a naive
    // "set every slot" reconstruction is complete.
    contractSlots: Object.fromEntries(
      contracts.map((c) => {
        const extra: Record<string, Hex> = {};
        for (const [sym, bs] of Object.entries(tokenBalanceSlots)) {
          if (tokenMeta[sym as keyof typeof tokenMeta].address.toLowerCase() === c.address.toLowerCase()) {
            extra[bs.slot.toLowerCase()] = bs.reserve as Hex;
          }
        }
        // Fold the FermiSwapper's config slots 0..3 in (slot 3 == the vault the swap resolves the payer from).
        if (c.address.toLowerCase() === FERMI.toLowerCase()) {
          Object.assign(extra, routerSlots);
        }
        return [c.address, { role: c.role, slots: { ...c.slots, ...extra } }];
      }),
    ),
    // The RESERVE VAULT (router slot 3) — the harness funds it with these reserves and grants it a max
    // allowance to the router so the swap's token.transferFrom(vault, taker, out) lands. The QUOTE reads
    // token.balanceOf(vault) — so these reserves are the PRICING reserve (the tokenBalanceSlots above are the
    // router's dust balances, NOT the pricing reserve).
    vault: {
      address: vaultAddr,
      role: "reserve-vault (holds token inventory; read via FermiSwapper storage slot 3). The quote reads token.balanceOf(vault); the swap does token.transferFrom(vault, taker, out) + transferFrom(taker, vault, in).",
      reserves: vaultReserves,
      allowanceToRouter: vaultAllowance,
    },
    // The EIP-7702 delegated EOA the quote/swap path touches (EXTCODESIZE/BALANCE) — the harness etches this
    // 24-byte designator so the account is code-bearing (an empty account makes the FermiSwapper quote 0).
    eoa7702: eoa7702Delegate
      ? { address: EOA7702, designator: eoa7702Code, delegate: eoa7702Delegate }
      : null,
    // Ground-truth probe ladders at the pinned fresh block (the offline self-check).
    probe: {
      target: { pair: `${TARGET.inSym}/${TARGET.outSym}`, ladder: targetLadder },
      second: secondFresh ? { pair: `${SECOND.inSym}/${SECOND.outSym}`, ladder: secondLadder } : null,
    },
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[fermi-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[fermi-snapshot] pinned block ${pinBlock} (ts ${blockTimestamp}); ${contracts.length} touched contracts; ` +
      `target ${TARGET.inSym}/${TARGET.outSym} 1${TARGET.inSym}->${refOut[1]}${TARGET.outSym}` +
      (secondFresh ? `; second ${SECOND.inSym}/${SECOND.outSym} 1${SECOND.inSym}->${secondOut}${SECOND.outSym}` : "; second STALE (target-only)"),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
