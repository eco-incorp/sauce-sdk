/**
 * One-time capture of the REAL METRIC (metric.xyz — an oracle-anchored bin-curve OMM: per-pair pool +
 * Router + PriceProvider + its Chainlink/offchain-oracle graph) from Base mainnet, so the Metric
 * prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time). MANDATORY for this family: every
 * Metric contract is UNVERIFIED (no source anywhere), so the genuine etched bytecode is the ONLY way
 * to test the production surface.
 *
 * Mirrors harness/tessera-snapshot.ts (the proven pattern) AND EMITS THE SAME FERMI-SHAPED SNAPSHOT,
 * so the prod-mirror test reuses the WHOLE fermi harness verbatim (loadFermiSnapshots /
 * verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp / etchFermiGraph): eth_getCode every contract
 * the quote/anchor/swap paths touch (enumerated via eth_createAccessList on DENSE quote ladders in
 * BOTH directions PLUS getBidAndAskPrice PLUS getImmutables PLUS swapExactInput calls BOTH
 * directions), into a checked-in bytecode snapshot (WITH sha256 integrity anchors), and every touched
 * storage slot into a state snapshot. Block pinned. The RPC url / key is NEVER persisted — only
 * contract CODE + STATE.
 *
 * ── THE CAPTURED GRAPH (traced live 2026-07-04 via debug_traceTransaction on a real swap) ───────────
 *   1. the ROUTER (0xA6A16C00… — quoteSwap / swapExactInput / its own metricOmmSwapCallback; the
 *      snapshot's `fermiSwapper` field),
 *   2. the per-pair POOL (0x770004fE… WETH/USDC — the bin book + the inventory holder; the snapshot's
 *      `vault` field, funded by the harness with the captured balances),
 *   3. the POOL's PriceProvider (0x69454A23… — getBidAndAskPrice; staleness-reverts 0x9a0423af past
 *      MAX_TIME_DELTA = 10 s, which is why the harness PINS block.timestamp to the capture instant),
 *   4. the provider's OFFCHAIN-ORACLE hub (0x28d9CCED… — the maker's posted price/ts store),
 *   5. the provider's Chainlink graph — the sequencer-uptime feed proxy + the ETH/USD + USDC/USD feed
 *      proxies and their aggregators (all captured with their REAL round data at the pin),
 *   plus the tokens (WETH/USDC — repointed to local MintableERC20s by the harness; the QUOTE path
 *   touches NO token slots — trace-verified: router.quoteSwap → pool.quote only — so repointing is
 *   pricing-neutral; the SWAP moves the LOCAL tokens through the REAL pool/router code).
 *
 * ── THE ANCHOR CONTEXT (why the captured bid/ask are persisted) ─────────────────────────────────────
 * quoteSwap prices DIRECTLY off the CALLER-SUPPLIED (bid, ask) (probed: doubling both doubles the
 * out), so every captured probe quote is taken at the LIVE anchor read at the pinned block, and that
 * anchor is persisted (`metricAnchor`) — at replay the etched provider returns EXACTLY these values
 * (its state is the pinned capture + the pinned timestamp), so the prod-mirror's prefetch and the
 * cook's in-tx hoist read the SAME frozen anchor by construction.
 *
 * ── block.timestamp ─────────────────────────────────────────────────────────────────────────────────
 * The provider gates the maker post's freshness on block.timestamp (MAX_TIME_DELTA = 10 s — measured
 * by fork time-warp: fresh at the fork instant, 0x9a0423af at +30 s) and runs Chainlink staleness/
 * sequencer-grace checks. The harness pins block.timestamp to the captured ts
 * (pinFermiBlockTimestamp), where every gate is fresh — reproducing the exact capture-instant quotes.
 *
 * Re-capture (REQUIRED whenever the recipe's touched-contract set changes):
 *   set -a; . sdk/.env; set +a
 *   BASE_RPC_URL=$BASE_RPC_URL npx tsx src/recipes/test/harness/metric-snapshot.ts
 * Optional argv[2] = RPC url, argv[3] = an explicit block to pin (else head).
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, getAddress, encodeFunctionData, type Hex, type Address, type Abi } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "base-metric-WETHUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The REAL Base Metric stack (UNVERIFIED bytecode; addresses from the metric.xyz metadata API,
// cross-probed live — see shared/metric-math.ts + shared/constants.ts for the probe record).
const ROUTER = getAddress("0xA6A16C00B7E9DBE1D54acEd7d6FE264fc4732eaF") as Address;
const POOL = getAddress("0x770004fE4411E42eA51a7fcAca32b267d791f3D4") as Address;

// Base on-charter tokens (constants.ts BASE_CHAIN_POOL_CONFIG.baseTokens).
const WETH = getAddress("0x4200000000000000000000000000000000000006") as Address;
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;

const TARGET = { tokenIn: WETH, tokenOut: USDC, inSym: "WETH", outSym: "USDC" };
const U128MAX = (1n << 128n) - 1n;

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
]);
const providerAbi = parseAbi(["function getBidAndAskPrice() view returns (uint128 bid, uint128 ask)"]);
const poolAbi = parseAbi([
  "function getImmutables() view returns (address factory, address priceProvider, address token0, address token1)",
]);
const routerAbi = parseAbi([
  "function quoteSwap(address pool, bool xToY, int128 amountSpecified, uint128 priceLimit, uint128 bid, uint128 ask) view returns (int256 amount0Delta, int256 amount1Delta)",
  "function swapExactInput(address pool, address recipient, bool xToY, uint128 amountIn, uint128 priceLimit, uint256 minAmountOut, uint256 deadline)",
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

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 8453) console.warn(`[metric-snapshot] WARNING: chainId ${chainId} != Base (8453)`);

  const pinBlock = PIN_BLOCK_ARG ?? (await client.getBlockNumber());
  const blockHex = ("0x" + pinBlock.toString(16)) as Hex;
  const blk = await client.getBlock({ blockNumber: pinBlock });
  const blockTimestamp = blk.timestamp;
  console.log(`[metric-snapshot] pinned block=${pinBlock} timestamp=${blockTimestamp}`);

  // ── Resolve the provider from the pool's own immutables + read the LIVE anchor at the pin. ──
  const imm = (await client.readContract({
    address: POOL, abi: poolAbi as Abi, functionName: "getImmutables", blockNumber: pinBlock,
  })) as readonly [Address, Address, Address, Address];
  const provider = getAddress(imm[1]) as Address;
  if (imm[2].toLowerCase() !== WETH.toLowerCase() || imm[3].toLowerCase() !== USDC.toLowerCase()) {
    throw new Error(`pool immutables mismatch: token0=${imm[2]} token1=${imm[3]}`);
  }
  const [bid, ask] = (await client.readContract({
    address: provider, abi: providerAbi as Abi, functionName: "getBidAndAskPrice", blockNumber: pinBlock,
  })) as readonly [bigint, bigint];
  if (bid <= 0n || ask < bid) throw new Error(`anchor unusable at pin: bid=${bid} ask=${ask} (stale maker? re-run)`);
  console.log(`[metric-snapshot] provider=${provider} anchor bid=${bid} ask=${ask} (X64; ~${Number(bid) / 2 ** 64} / ~${Number(ask) / 2 ** 64})`);

  // ── The pinned-anchor quote helper (the router's clean view; out = |negative delta|). ──
  const quoteAt = async (xToY: boolean, amt: bigint): Promise<bigint> => {
    const [a0, a1] = (await client.readContract({
      address: ROUTER, abi: routerAbi as Abi, functionName: "quoteSwap",
      args: [POOL, xToY, amt, xToY ? 0n : U128MAX, bid, ask], blockNumber: pinBlock,
    })) as readonly [bigint, bigint];
    const outDelta = xToY ? a1 : a0;
    return outDelta < 0n ? -outDelta : 0n;
  };

  const probeAmt = 10n ** 18n; // 1 WETH
  const refOut = await quoteAt(true, probeAmt);
  if (refOut <= 0n) throw new Error(`pinned block ${pinBlock} quotes 0 for ${TARGET.inSym}/${TARGET.outSym}`);
  console.log(`[metric-snapshot] 1 WETH -> ${refOut} USDC @ the pinned anchor`);

  // ── Enumerate the touched-contract + touched-slot set: the anchor read, getImmutables, DENSE
  //    quote ladders BOTH directions, and swapExactInput BOTH directions (reverts at the taker
  //    transferFrom — the provider/oracle/bin/payout path is fully touched BEFORE the revert). ──
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
      void e; // out-of-range sizes / reverting swaps still surfaced their touched set where supported
    }
  };
  await tryAdd(provider, encodeFunctionData({ abi: providerAbi as Abi, functionName: "getBidAndAskPrice" }));
  await tryAdd(POOL, encodeFunctionData({ abi: poolAbi as Abi, functionName: "getImmutables" }));
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
    await tryAdd(ROUTER, encodeFunctionData({ abi: routerAbi as Abi, functionName: "quoteSwap", args: [POOL, true, amt, 0n, bid, ask] }));
  }
  for (const amt of denseLadder(1765n * 10n ** 6n)) {
    await tryAdd(ROUTER, encodeFunctionData({ abi: routerAbi as Abi, functionName: "quoteSwap", args: [POOL, false, amt, U128MAX, bid, ask] }));
  }
  // The SWAP paths (touch the provider graph + the payout/pull path before the taker pull reverts).
  const deadline = blockTimestamp + 3600n;
  for (const amt of [10n ** 17n, 10n ** 18n, 2n * 10n ** 18n]) {
    await tryAdd(ROUTER, encodeFunctionData({ abi: routerAbi as Abi, functionName: "swapExactInput", args: [POOL, from, true, amt, 0n, 0n, deadline] }));
  }
  for (const amt of [100n * 10n ** 6n, 1765n * 10n ** 6n]) {
    await tryAdd(ROUTER, encodeFunctionData({ abi: routerAbi as Abi, functionName: "swapExactInput", args: [POOL, from, false, amt, U128MAX, 0n, deadline] }));
  }
  // Belt-and-braces: the core stack is captured even if an access-list call was quietly dropped.
  for (const must of [ROUTER, POOL, provider]) {
    const key = must.toLowerCase();
    if (!merged.has(key)) merged.set(key, new Set());
  }

  // ── Pool inventory (the vault funding) + token metadata. ──
  const bal = (t: Address, who: Address) =>
    client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber: pinBlock }) as Promise<bigint>;
  const poolReserves = {
    WETH: (await bal(WETH, POOL)).toString(),
    USDC: (await bal(USDC, POOL)).toString(),
  };
  console.log(`[metric-snapshot] pool inventory WETH=${poolReserves.WETH} USDC=${poolReserves.USDC}`);

  // ── Capture code (sha256-anchored) + every touched storage slot for every touched contract. ──
  const TOKENS = new Set([WETH.toLowerCase(), USDC.toLowerCase()]);
  const contracts: { address: Address; role: string; runtime: string; runtimeSha256: Hex; codeSizeBytes: number; slots: Record<string, Hex> }[] = [];
  for (const [addrLc, slotSet] of [...merged.entries()].sort()) {
    const address = getAddress(addrLc) as Address;
    const code = await client.getCode({ address, blockNumber: pinBlock });
    const runtime = code ?? "0x";
    const role =
      addrLc === ROUTER.toLowerCase()
        ? "Metric Router (quoteSwap / swapExactInput / its own metricOmmSwapCallback)"
        : addrLc === POOL.toLowerCase()
          ? "Metric per-pair pool (bin book + inventory; the snapshot vault)"
          : addrLc === provider.toLowerCase()
            ? "Metric PriceProvider (getBidAndAskPrice — the maker anchor)"
            : TOKENS.has(addrLc)
              ? "token (repointed by harness)"
              : "oracle-dependency (offchain hub / Chainlink proxy / aggregator)";
    const slots: Record<string, Hex> = {};
    for (const slot of [...slotSet].sort()) {
      const v = await client.getStorageAt({ address, slot: slot as Hex, blockNumber: pinBlock });
      slots[slot] = (v ?? ("0x" + "0".repeat(64))) as Hex;
    }
    contracts.push({ address, role, runtime, runtimeSha256: sha256(runtime), codeSizeBytes: runtime === "0x" ? 0 : runtime.length / 2 - 1, slots });
    console.log(`[metric-snapshot]  touched ${address} [${role}] code=${runtime === "0x" ? 0 : runtime.length / 2 - 1}B slots=${Object.keys(slots).length}`);
  }

  const meta = async (t: Address) => ({
    address: t,
    symbol: await client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    decimals: Number(await client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }).catch(() => 18)),
  });
  const tokenMeta = { WETH: await meta(WETH), USDC: await meta(USDC) };

  // ── Ground-truth probe ladders BOTH directions at the pinned anchor. ──
  const ladder = async (xToY: boolean, amts: bigint[]) => {
    const pts: { amountIn: string; amountOut: string }[] = [];
    for (const amt of amts) {
      try {
        pts.push({ amountIn: amt.toString(), amountOut: (await quoteAt(xToY, amt)).toString() });
      } catch {
        pts.push({ amountIn: amt.toString(), amountOut: "STALE_OR_REVERT" });
      }
    }
    return pts;
  };
  const fwdLadder = await ladder(true, [10n ** 17n, 5n * 10n ** 17n, 10n ** 18n, 2n * 10n ** 18n, 5n * 10n ** 18n]);
  const revLadder = await ladder(false, [100n * 10n ** 6n, 500n * 10n ** 6n, 1765n * 10n ** 6n, 5000n * 10n ** 6n]);

  // ── Write the snapshots — FERMI-SHAPED (see the header): `fermiSwapper` = the ROUTER, `vault` =
  //    the POOL (funded with the captured inventory), plus the metric extras. ──
  const bytecodeSnap = {
    chain: "base",
    fermiSwapper: ROUTER,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    note:
      "METRIC (metric.xyz oracle-anchored bin-curve OMM; ALL contracts UNVERIFIED — the genuine runtime is the " +
      "only testable surface). FERMI-SHAPED snapshot (fermiSwapper = the ROUTER; vault = the per-pair POOL " +
      "holding the inventory) so the fermi harness (loadFermiSnapshots / verifyFermiBytecodeIntegrity / " +
      "pinFermiBlockTimestamp / etchFermiGraph) is reused verbatim. The QUOTE path touches no token slots " +
      "(trace-verified) so the token repoint is pricing-neutral; the provider gates on block.timestamp " +
      "(MAX_TIME_DELTA = 10 s) so the harness MUST pin the clock to blockTimestamp before any quote/cook.",
    contracts: contracts
      .map((cc) => ({ address: cc.address, role: cc.role, runtime: cc.runtime, runtimeSha256: cc.runtimeSha256, codeSizeBytes: cc.codeSizeBytes }))
      .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)),
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  const stateSnap = {
    chain: "base",
    fermiSwapper: ROUTER,
    block: pinBlock.toString(),
    blockTimestamp: blockTimestamp.toString(),
    staleUpdateSelector: "0x9a0423af", // the provider's staleness custom error (informational)
    target: { ...TARGET },
    second: null,
    tokens: tokenMeta,
    tokenBalanceSlots: {}, // the Metric QUOTE reads no token balances (trace-verified)
    contractSlots: Object.fromEntries(
      contracts.map((cc) => [cc.address, { role: cc.role, slots: cc.slots }]),
    ),
    vault: {
      address: POOL,
      role:
        "the per-pair Metric POOL (the inventory holder): the swap pays the out FROM it and the router's " +
        "callback pulls the input INTO it; the harness funds it with the captured balances.",
      reserves: poolReserves,
      allowanceToRouter: { WETH: "0", USDC: "0" }, // nothing transferFroms the pool — informational
    },
    eoa7702: null,
    metricPool: POOL,
    metricProvider: provider,
    metricAnchor: { bid: bid.toString(), ask: ask.toString() },
    probe: {
      target: { pair: `${TARGET.inSym}/${TARGET.outSym}`, ladder: fwdLadder },
      second: { pair: `${TARGET.outSym}/${TARGET.inSym}`, ladder: revLadder },
    },
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[metric-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[metric-snapshot] pinned block ${pinBlock} (ts ${blockTimestamp}); ${contracts.length} touched contracts; ` +
      `1 ${TARGET.inSym} -> ${refOut} ${TARGET.outSym} @ the pinned anchor`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
