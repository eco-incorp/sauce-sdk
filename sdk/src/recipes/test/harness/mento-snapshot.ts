/**
 * One-time capture of the REAL Mento V2 (Celo mento-protocol/mento-core) stablecoin-exchange contract
 * GRAPH so the Mento prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/curveStable-snapshot.ts + harness/dodo-snapshot.ts (the proven pattern) but for a
 * MULTI-CONTRACT source: Mento's quote/swap path fans out across a whole graph (Broker → BiPoolManager →
 * SortedOracles + ConstantSumPricingModule + BreakerBox + Reserve + the two ERC20s, each an EIP-1967 /
 * Celo proxy delegating to an impl, and SortedOracles' impl in turn delegates to an
 * AddressSortedLinkedListWithMedian library). So we DON'T hand-code 16 storage layouts — we let the EVM
 * tell us the exact touched set: `debug_traceCall(prestateTracer)` on BOTH the production quote
 * (`Broker.getAmountOut`) AND the production exec (`Broker.swapIn`) enumerates every contract the two paths
 * read/write, WITH the exact storage slots each touches. We then `eth_getCode` every touched address (WITH
 * a sha256 integrity anchor) into a bytecode snapshot, and record the union of touched storage slots
 * (verbatim) + the SEMANTIC swap-relevant state (bucket amounts, the SortedOracles median rate/timestamp,
 * the exchange config, breaker trading mode, reserve balances) + probe quotes into a state snapshot. Block
 * pinned. The RPC url / key is NEVER persisted — only contract CODE + STATE.
 *
 * ── WHICH PAIR (and why on-charter) ──────────────────────────────────────────────────────────────────
 * The deepest Mento exchanges hub on cUSD (Mento Dollar, now branded "USDm", 0x765DE816…, 18-dec). The
 * on-charter all-stablecoin pair we mirror is cUSD → USDC (Circle native, 0xceBA9300…, 6-dec) via exchange
 * 0xacc98838…2b8013bcffd7 on the BiPoolManager. BOTH tokens are in `constants.ts` celo `baseTokens`
 * (on-charter, NO fallback). Verified live: `Broker.getAmountOut(BiPoolManager, exchangeId, cUSD, USDC,
 * 1000e18)` ≈ 1000.14 USDC — a clean deterministic descending-marginal ladder (the split engages), and
 * `Broker.swapIn(…)` executes the FULL pricing path and reverts ONLY at the terminal transferFrom (an
 * `insufficient allowance` — trivially satisfied offline by minting the local tokenIn + approving), i.e.
 * the whole bucket/oracle/breaker/pricing computation succeeds. cUSD is a STABLE asset (mint/burn) and USDC
 * a COLLATERAL asset (Reserve-backed): swapIn burns cUSD from the sender and releases USDC from the Reserve
 * — reproduced offline by repointing BOTH at local MintableERC20s (which sidesteps USDC's Circle blacklist
 * and cUSD's broker-gated burn) and funding the Reserve with local USDC.
 *
 * ── DISCOVERY (on-charter, ENUMERABLE) ───────────────────────────────────────────────────────────────
 * The production FactoryType.Mento discovery reads the Broker wired in constants.ts (BrokerProxy
 * 0x777A8255…4CaD) → getExchangeProviders() (or the config `mentoExchangeProviders` hint =
 * [BiPoolManager]) → each provider's getExchanges() (Exchange { bytes32 exchangeId; address[] assets }) →
 * matches {cUSD,USDC} → samples the getAmountOut ladder. We record the provider + exchangeId + the sampled
 * ladder so the offline test drives the SAME enumerable path against the etched graph.
 *
 * Quote view: Broker.getAmountOut(provider, exchangeId, tokenIn, tokenOut, amountIn). Exec: approve(Broker)
 * + Broker.swapIn(provider, exchangeId, tokenIn, tokenOut, amountIn, amountOutMin) — CALLBACK-FREE (Mento
 * re-enters only the Reserve / stable mint-burn, never the cooking contract), so NO engine SwapPoolType.
 *
 * Re-capture (REQUIRED whenever the reconstruction changes):
 *   set -a; . sdk/.env; set +a
 *   CELO_RPC_URL=$CELO_RPC_URL npx tsx src/recipes/test/harness/mento-snapshot.ts
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
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "celo-mento-cUSDUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The production Mento entry points (constants.ts celo config). BrokerProxy + the ONE registered exchange
// provider (BiPoolManager). Both verified proxies on Celoscan.
const BROKER = getAddress("0x777A8255cA72412f0d706dc03C9D1987306B4CaD") as Address;
const BIPOOL = getAddress("0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901") as Address;

// The on-charter stable pair (both in celo baseTokens). cUSD (USDm, 18-dec) → USDC (Circle native, 6-dec).
const CUSD = getAddress("0x765DE816845861e75A25fCA122bb6898B8B1282a") as Address;
const USDC = getAddress("0xcebA9300f2b948710d2653dd7b07f33a8b32118C") as Address;

// The probe/exec trade size (1000 cUSD) + the discovery sampling ladder cap (100k cUSD — the EVM test's
// solo cap). Both 18-dec cUSD-in units.
const PROBE_IN = 1_000n * 10n ** 18n;
const LADDER_CAP = 100_000n * 10n ** 18n;

// EIP-1967 impl slot + the Celo `_getImplementation()` getter (both tried per contract for provenance).
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

const RPC = process.argv[2] || process.env.CELO_RPC_URL || "";
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set CELO_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const brokerAbi = parseAbi([
  "function getExchangeProviders() view returns (address[])",
  "function getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  "function swapIn(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (uint256)",
]);
const providerAbi = parseAbi([
  "function getExchanges() view returns ((bytes32 exchangeId, address[] assets)[])",
  "function sortedOracles() view returns (address)",
  "function reserve() view returns (address)",
  "function breakerBox() view returns (address)",
]);
// getPoolExchange returns a NESTED struct (PoolExchange) we decode by hand from the raw return — see
// decodePoolExchange. We fetch it via a raw eth_call (viem can't type the nested struct cleanly here).
const getPoolExchangeSelector = "0x278488a4"; // getPoolExchange(bytes32)
const sortedOraclesAbi = parseAbi([
  "function medianRate(address rateFeedId) view returns (uint256, uint256)",
  "function medianTimestamp(address rateFeedId) view returns (uint256)",
  "function numRates(address rateFeedId) view returns (uint256)",
  "function breakerBox() view returns (address)",
]);
const breakerBoxAbi = parseAbi([
  "function getRateFeedTradingMode(address rateFeedId) view returns (uint8)",
]);
const reserveAbi = parseAbi([
  "function isStableAsset(address) view returns (bool)",
  "function isCollateralAsset(address) view returns (bool)",
  // transferOut gating (the collateral release path a full swapIn takes — NOT reached by the captured
  // swapIn trace, which reverts at transferIn; recorded here so the offline etch reconstructs them).
  "function isExchangeSpender(address) view returns (bool)",
  "function collateralAssetSpendingLimit(address) view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

const sha256 = (hex: string) =>
  ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

// A geometric-ish cumulative sampler over [0, cap] (∝ s^2, denser near 0) — the SAME grid the production
// `mentoSampleInputs` produces (M=24), so the offline test's discovery ladder lines up with the recipe's.
function sampleInputs(amountIn: bigint, M = 24): bigint[] {
  const out: bigint[] = [];
  let prev = 0n;
  for (let s = 1; s <= M; s++) {
    const input = (amountIn * BigInt(s) * BigInt(s)) / (BigInt(M) * BigInt(M));
    if (input > prev) {
      out.push(input);
      prev = input;
    }
  }
  return out;
}

// PoolExchange struct decode (verified against getPoolExchange raw): asset0, asset1, pricingModule, bucket0,
// bucket1, lastBucketUpdate, config{spread, referenceRateFeedID, referenceRateResetFrequency,
// minimumReports, stablePoolResetSize}. We only need referenceRateFeedID (the SortedOracles feed) + the
// buckets + lastBucketUpdate for the semantic snapshot; the rest we take verbatim from storage.
function decodePoolExchange(raw: Hex): {
  asset0: Address; asset1: Address; pricingModule: Address;
  bucket0: bigint; bucket1: bigint; lastBucketUpdate: bigint;
  spread: bigint; referenceRateFeedID: Address; referenceRateResetFrequency: bigint;
  minimumReports: bigint; stablePoolResetSize: bigint;
} {
  const h = raw.slice(2);
  const word = (i: number) => BigInt("0x" + h.slice(i * 64, (i + 1) * 64));
  const addr = (i: number) => getAddress(("0x" + h.slice(i * 64 + 24, (i + 1) * 64)) as Hex) as Address;
  return {
    asset0: addr(0),
    asset1: addr(1),
    pricingModule: addr(2),
    bucket0: word(3),
    bucket1: word(4),
    lastBucketUpdate: word(5),
    spread: word(6),
    referenceRateFeedID: addr(7),
    referenceRateResetFrequency: word(8),
    minimumReports: word(9),
    stablePoolResetSize: word(10),
  };
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 42220) {
    console.warn(`[mento-snapshot] WARNING: chainId ${chainId} != Celo (42220)`);
  }
  // Pin the block for provenance + a deterministic reconstruction (all reads below use it; the offline
  // test pins block.timestamp to `blockTimestamp` because getAmountOut simulates a bucket refresh off it).
  const block = await client.getBlockNumber();
  const blk = await client.getBlock({ blockNumber: block });
  const blockTimestamp = blk.timestamp;
  console.log(`[mento-snapshot] Celo chainId=${chainId} block=${block} ts=${blockTimestamp}`);

  // ── DISCOVERY (production path): providers → exchanges → match {cUSD,USDC} → ladder. ──
  const providers = (await client.readContract({
    address: BROKER, abi: brokerAbi, functionName: "getExchangeProviders", blockNumber: block,
  })) as Address[];
  if (!providers.map((p) => p.toLowerCase()).includes(BIPOOL.toLowerCase())) {
    throw new Error(`BiPoolManager ${BIPOOL} not among Broker providers ${providers}`);
  }
  const exchanges = (await client.readContract({
    address: BIPOOL, abi: providerAbi, functionName: "getExchanges", blockNumber: block,
  })) as readonly { exchangeId: Hex; assets: readonly Address[] }[];

  const inLc = CUSD.toLowerCase();
  const outLc = USDC.toLowerCase();
  const match = exchanges.find((ex) => {
    const a = (ex.assets ?? []).map((x) => x.toLowerCase());
    return a.length >= 2 && ((a[0] === inLc && a[1] === outLc) || (a[1] === inLc && a[0] === outLc));
  });
  if (!match) throw new Error(`no BiPoolManager exchange for {cUSD,USDC}`);
  const exchangeId = match.exchangeId;
  console.log(`[mento-snapshot] matched exchange ${exchangeId} assets=[${match.assets.join(", ")}]`);

  // ── The BiPoolManager's wired deps (for the snapshot + a cross-check vs the traced set). ──
  const [soFromBipool, reserveFromBipool, breakerFromBipool] = await Promise.all([
    client.readContract({ address: BIPOOL, abi: providerAbi, functionName: "sortedOracles", blockNumber: block }) as Promise<Address>,
    client.readContract({ address: BIPOOL, abi: providerAbi, functionName: "reserve", blockNumber: block }) as Promise<Address>,
    client.readContract({ address: BIPOOL, abi: providerAbi, functionName: "breakerBox", blockNumber: block }) as Promise<Address>,
  ]);
  const peCall = await client.call({
    to: BIPOOL,
    data: (getPoolExchangeSelector + exchangeId.slice(2)) as Hex,
    blockNumber: block,
  });
  const poolExchangeRaw = (peCall.data ?? "0x") as Hex;
  if (poolExchangeRaw === "0x") throw new Error("getPoolExchange returned empty");
  const pe = decodePoolExchange(poolExchangeRaw);
  console.log(
    `[mento-snapshot] poolExchange: pricingModule=${pe.pricingModule} feed=${pe.referenceRateFeedID}\n` +
      `  bucket0=${pe.bucket0} bucket1=${pe.bucket1} lastBucketUpdate=${pe.lastBucketUpdate}\n` +
      `  spread=${pe.spread} resetFreq=${pe.referenceRateResetFrequency} minReports=${pe.minimumReports}`,
  );

  // ── The SortedOracles median rate + freshness for the exchange's feed (the price the quote reads). ──
  const [medianRate, medianTs, numRates] = await Promise.all([
    client.readContract({ address: soFromBipool, abi: sortedOraclesAbi, functionName: "medianRate", args: [pe.referenceRateFeedID], blockNumber: block }) as Promise<readonly [bigint, bigint]>,
    client.readContract({ address: soFromBipool, abi: sortedOraclesAbi, functionName: "medianTimestamp", args: [pe.referenceRateFeedID], blockNumber: block }) as Promise<bigint>,
    client.readContract({ address: soFromBipool, abi: sortedOraclesAbi, functionName: "numRates", args: [pe.referenceRateFeedID], blockNumber: block }) as Promise<bigint>,
  ]);
  const tradingMode = (await client.readContract({
    address: breakerFromBipool, abi: breakerBoxAbi, functionName: "getRateFeedTradingMode", args: [pe.referenceRateFeedID], blockNumber: block,
  }).catch(() => 255)) as number;
  console.log(
    `[mento-snapshot] feed rate=${medianRate[0]} (denom ${medianRate[1]}) ts=${medianTs} numRates=${numRates} tradingMode=${tradingMode}`,
  );
  if (tradingMode !== 0) throw new Error(`breaker tradingMode ${tradingMode} != 0 (feed halted — pick another block/pair)`);

  // ── Asset classification + token metadata. ──
  const [cusdSym, cusdDec, usdcSym, usdcDec] = await Promise.all([
    client.readContract({ address: CUSD, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
    client.readContract({ address: CUSD, abi: erc20Abi, functionName: "decimals" }).then(Number) as Promise<number>,
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "decimals" }).then(Number) as Promise<number>,
  ]);
  const [inIsStable, outIsCollateral, reserveUSDC] = await Promise.all([
    client.readContract({ address: reserveFromBipool, abi: reserveAbi, functionName: "isStableAsset", args: [CUSD], blockNumber: block }).catch(() => false) as Promise<boolean>,
    client.readContract({ address: reserveFromBipool, abi: reserveAbi, functionName: "isCollateralAsset", args: [USDC], blockNumber: block }).catch(() => false) as Promise<boolean>,
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [reserveFromBipool], blockNumber: block }) as Promise<bigint>,
  ]);
  console.log(
    `[mento-snapshot] tokenIn ${cusdSym}(${cusdDec}) isStable=${inIsStable}; tokenOut ${usdcSym}(${usdcDec}) isCollateral=${outIsCollateral}; reserve holds ${reserveUSDC} USDC`,
  );

  // ── The sampled quote ladder (the descending-marginal segment source) + the probe quote. ──
  const cumIn = sampleInputs(LADDER_CAP);
  const cumOut: string[] = [];
  for (const amt of cumIn) {
    const o = (await client.readContract({
      address: BROKER, abi: brokerAbi, functionName: "getAmountOut",
      args: [BIPOOL, exchangeId, CUSD, USDC, amt], blockNumber: block,
    })) as bigint;
    cumOut.push(o.toString());
  }
  const probeOut = (await client.readContract({
    address: BROKER, abi: brokerAbi, functionName: "getAmountOut",
    args: [BIPOOL, exchangeId, CUSD, USDC, PROBE_IN], blockNumber: block,
  })) as bigint;
  console.log(`[mento-snapshot] probe getAmountOut(${PROBE_IN}) = ${probeOut}; ladder points=${cumIn.length}`);

  // ── transferOut gating (the collateral-release path a FULL swapIn takes). The captured swapIn TRACE
  //    reverts at transferIn (insufficient allowance), so it never reaches transferOut — these Reserve
  //    values (Broker is a registered exchange-spender; USDC is a registered collateral asset with a daily
  //    spending limit) are read DIRECTLY here so the offline etch can reconstruct the exact live values and
  //    execute a full wei-exact swapIn. They are GATING (bool/limit), NOT pricing — they do not touch the
  //    bucket/oracle math (the quote is already wei-exact without them). ──
  const [brokerIsSpender, usdcSpendLimit] = await Promise.all([
    client.readContract({ address: reserveFromBipool, abi: reserveAbi, functionName: "isExchangeSpender", args: [BROKER], blockNumber: block }).catch(() => false) as Promise<boolean>,
    client.readContract({ address: reserveFromBipool, abi: reserveAbi, functionName: "collateralAssetSpendingLimit", args: [USDC], blockNumber: block }).catch(() => 0n) as Promise<bigint>,
  ]);
  console.log(`[mento-snapshot] transferOut gating: Reserve.isExchangeSpender(Broker)=${brokerIsSpender} collateralAssetSpendingLimit(USDC)=${usdcSpendLimit} isCollateralAsset(USDC)=${outIsCollateral}`);

  // ── Enumerate the WHOLE touched contract graph via debug_traceCall(prestateTracer) on BOTH the quote
  //    AND the swapIn (the union is the offline etch set). prestate gives {code, storage(slots read/written)}
  //    per address — exactly the code + slots the two paths depend on. swapIn is traced from the cUSD token
  //    address (a convenient non-participant sender) — it reverts at the terminal transferFrom (allowance),
  //    AFTER the full pricing/breaker/reserve fan-out, so its prestate still enumerates the whole graph. ──
  const quoteData = encodeFunctionData({
    abi: brokerAbi, functionName: "getAmountOut", args: [BIPOOL, exchangeId, CUSD, USDC, PROBE_IN],
  });
  const swapData = encodeFunctionData({
    abi: brokerAbi, functionName: "swapIn", args: [BIPOOL, exchangeId, CUSD, USDC, PROBE_IN, 0n],
  });
  // ALSO trace the two DISCOVERY getters so the offline etch reproduces the ENUMERABLE production path
  // (discoverMentoPoolsTyped: Broker.getExchangeProviders → provider.getExchanges → match {cUSD,USDC}). The
  // quote/swap traces only touch the per-exchangeId pricing mapping, NOT the enumeration arrays (the
  // `exchanges[]` list + its `assets[]` sub-arrays + the providers list), so without these the etched graph
  // returns empty from getExchanges/getExchangeProviders and discovery can't enumerate the pair.
  const providersData = encodeFunctionData({ abi: brokerAbi, functionName: "getExchangeProviders" });
  const getExchangesData = encodeFunctionData({ abi: providerAbi, functionName: "getExchanges" });
  const traceSender = CUSD; // a funded-code address that is not a swap participant balance-wise

  type Prestate = Record<string, { balance?: string; nonce?: number; code?: Hex; storage?: Record<string, Hex> }>;
  const traceQuote = (await client.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "debug_traceCall" as any,
    params: [{ to: BROKER, data: quoteData }, "0x" + block.toString(16), { tracer: "prestateTracer" }] as any,
  })) as Prestate;
  const traceSwap = (await client.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "debug_traceCall" as any,
    params: [{ from: traceSender, to: BROKER, data: swapData }, "0x" + block.toString(16), { tracer: "prestateTracer" }] as any,
  })) as Prestate;
  const traceProviders = (await client.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "debug_traceCall" as any,
    params: [{ to: BROKER, data: providersData }, "0x" + block.toString(16), { tracer: "prestateTracer" }] as any,
  })) as Prestate;
  const traceGetExchanges = (await client.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "debug_traceCall" as any,
    params: [{ to: BIPOOL, data: getExchangesData }, "0x" + block.toString(16), { tracer: "prestateTracer" }] as any,
  })) as Prestate;

  // Union the prestates: per address, take the code + the union of touched storage slots.
  const graph: Record<string, { code: Hex; storage: Record<string, Hex> }> = {};
  for (const src of [traceQuote, traceSwap, traceProviders, traceGetExchanges]) {
    for (const [addr, o] of Object.entries(src)) {
      if (!o.code || o.code === "0x") continue; // skip EOAs
      const a = getAddress(addr as Hex).toLowerCase();
      if (!graph[a]) graph[a] = { code: o.code as Hex, storage: {} };
      for (const [slot, val] of Object.entries(o.storage ?? {})) {
        graph[a].storage[slot.toLowerCase()] = val as Hex;
      }
    }
  }
  console.log(`[mento-snapshot] traced graph: ${Object.keys(graph).length} contracts`);

  // Resolve a proxy → impl for provenance labelling (best-effort; the etch does NOT need it — it setCodes
  // every traced address verbatim — but recording it documents the delegate targets in the snapshot).
  async function implOf(a: Address): Promise<Address | null> {
    const eip1967 = await client.getStorageAt({ address: a, slot: EIP1967_IMPL_SLOT, blockNumber: block }).catch(() => null);
    if (eip1967 && BigInt(eip1967) !== 0n) return getAddress(("0x" + eip1967.slice(26)) as Hex) as Address;
    const g = await client
      .readContract({ address: a, abi: parseAbi(["function _getImplementation() view returns (address)"]), functionName: "_getImplementation", blockNumber: block })
      .catch(() => null);
    return (g as Address) || null;
  }

  // A human label for the well-known members of the graph (the rest are impls/libs, labelled generically).
  const roleOf = (a: string): string => {
    const m: Record<string, string> = {
      [BROKER.toLowerCase()]: "Broker (proxy)",
      [BIPOOL.toLowerCase()]: "BiPoolManager (proxy)",
      [soFromBipool.toLowerCase()]: "SortedOracles (proxy)",
      [reserveFromBipool.toLowerCase()]: "Reserve (proxy)",
      [breakerFromBipool.toLowerCase()]: "BreakerBox",
      [pe.pricingModule.toLowerCase()]: "ConstantSumPricingModule",
      [CUSD.toLowerCase()]: "cUSD (stable, proxy)",
      [USDC.toLowerCase()]: "USDC (collateral, proxy)",
    };
    return m[a] ?? "impl/lib/dep";
  };

  // ── Build the bytecode snapshot: eth_getCode every traced contract (fresh, block-pinned) WITH sha256. ──
  const contracts: {
    address: Hex; role: string; runtime: Hex; runtimeSha256: Hex;
    implementation?: Hex; touchedSlots: number;
  }[] = [];
  for (const a of Object.keys(graph).sort()) {
    const addr = getAddress(a as Hex) as Address;
    const runtime = await client.getCode({ address: addr, blockNumber: block });
    if (!runtime || runtime === "0x") throw new Error(`empty code at traced contract ${addr}`);
    // integrity: the traced code must equal eth_getCode at the pinned block.
    if (runtime.toLowerCase() !== graph[a].code.toLowerCase()) {
      throw new Error(`traced code != eth_getCode for ${addr} (block skew?)`);
    }
    const impl = await implOf(addr);
    contracts.push({
      address: addr,
      role: roleOf(a),
      runtime,
      runtimeSha256: sha256(runtime),
      implementation: impl ?? undefined,
      touchedSlots: Object.keys(graph[a].storage).length,
    });
  }

  const bytecodeSnap = {
    chain: "celo",
    chainId,
    block: block.toString(),
    source: "Mento",
    broker: BROKER,
    biPoolManager: BIPOOL,
    exchangeId,
    contracts,
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Build the state snapshot: the union touched storage (verbatim, per contract) + the SEMANTIC
  //    swap-relevant state (buckets, oracle rate, config, breaker mode, reserve balance) + probes. ──
  const storageByContract: Record<string, Record<string, Hex>> = {};
  for (const a of Object.keys(graph).sort()) {
    if (Object.keys(graph[a].storage).length > 0) {
      storageByContract[getAddress(a as Hex)] = graph[a].storage;
    }
  }

  const stateSnap = {
    chain: "celo",
    chainId,
    block: block.toString(),
    blockTimestamp: blockTimestamp.toString(),
    source: "Mento",
    // Discovery (enumerable, on-charter): Broker → provider → exchange → ladder.
    broker: BROKER,
    exchangeProvider: BIPOOL,
    exchangeId,
    // The pair (both on-charter celo baseTokens). tokenIn=cUSD(stable), tokenOut=USDC(collateral).
    tokenIn: CUSD,
    tokenOut: USDC,
    tokenInSymbol: cusdSym,
    tokenOutSymbol: usdcSym,
    tokenInDecimals: cusdDec,
    tokenOutDecimals: usdcDec,
    tokenInIsStable: inIsStable,
    tokenOutIsCollateral: outIsCollateral,
    onCharter: true,
    // The BiPoolManager's wired deps (the graph roots).
    sortedOracles: soFromBipool,
    reserve: reserveFromBipool,
    breakerBox: breakerFromBipool,
    pricingModule: pe.pricingModule,
    referenceRateFeedID: pe.referenceRateFeedID,
    // The exchange's bucket + config state (the AMM ground truth).
    bucket0: pe.bucket0.toString(),
    bucket1: pe.bucket1.toString(),
    lastBucketUpdate: pe.lastBucketUpdate.toString(),
    spread: pe.spread.toString(),
    referenceRateResetFrequency: pe.referenceRateResetFrequency.toString(),
    minimumReports: pe.minimumReports.toString(),
    stablePoolResetSize: pe.stablePoolResetSize.toString(),
    poolExchangeRaw,
    // The SortedOracles median rate/freshness for the feed (the oracle price the quote reads).
    medianRate: medianRate[0].toString(),
    medianRateDenominator: medianRate[1].toString(),
    medianTimestamp: medianTs.toString(),
    numRates: numRates.toString(),
    breakerTradingMode: tradingMode,
    // The Reserve's USDC balance (the collateral the swapIn releases; the etch funds the local Reserve).
    reserveUSDC: reserveUSDC.toString(),
    // transferOut gating (see the read above) — the offline etch reconstructs these so a FULL swapIn (not
    // just the quote) executes wei-exact. Their storage slots (found empirically, mento-core Reserve layout)
    // are also carried in `reserveGatingSlots` for the etch. Boolean/limit gating, NOT pricing.
    reserveIsExchangeSpender: brokerIsSpender,
    reserveCollateralSpendingLimit: usdcSpendLimit.toString(),
    // Probe quotes — the self-check the offline test reproduces against the etched graph (real code, real
    // reconstructed state), and the sampled ladder the split/oracle differences into segments.
    probe: { amountIn: PROBE_IN.toString(), amountOut: probeOut.toString() },
    ladder: { cap: LADDER_CAP.toString(), cumIn: cumIn.map(String), cumOut },
    // The union touched storage per contract (verbatim setStorageAt reconstruction).
    storage: storageByContract,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[mento-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(`[mento-snapshot] contracts captured (${contracts.length}):`);
  for (const c of contracts) {
    console.log(
      `  ${c.address}  ${c.role.padEnd(28)} ${(c.runtime.length / 2 - 1).toString().padStart(6)}B  slots=${c.touchedSlots}` +
        (c.implementation ? `  impl=${c.implementation}` : ""),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
