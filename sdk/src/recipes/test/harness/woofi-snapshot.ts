/**
 * One-time capture of the REAL Arbitrum WOOFi (WooPPV2 sPMM v2) USDT/USDC pool, so the WOOFi
 * prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * WOOFi is an ORACLE-PRICED proactive market maker (NOT xy=k): the WooPPV2 pool reads a SEPARATE
 * WooracleV2 for the base token's (price, spread, coeff) and computes the swap output in closed form
 * off that snapshot (see shared/woofi-math.ts). WooracleV2.state(base) additionally consults TWO
 * Chainlink CL price feeds (base/USD and quote/USD) to gate feasibility (a bound check) and a WO-price
 * staleness window (block.timestamp <= oracle.timestamp + staleDuration). So the FULL swap/quote
 * dependency graph the test must reproduce is:
 *
 *   WooPPV2 proxy 0x5520…9FA4  (EIP-1967 transparent proxy)
 *     └ delegatecall → WooPPV2 impl  (the sPMM query/swap math)
 *          ├ USDT.balanceOf(pool)              (transfer-first: sold = balanceOf − reserve)
 *          ├ WooracleV2.state(base=USDT)        → the sPMM price/spread/coeff + feasibility
 *          │    ├ CL[USDT].latestRoundData()    (Chainlink USDT/USD feed, cloPreferred=false)
 *          │    └ CL[USDC].latestRoundData()    (Chainlink USDC/USD feed)
 *          ├ WooracleV2.quoteToken() / decimals(base)
 *          └ tokenIn.decimals() / tokenOut.decimals()
 *
 * DEEPEST ON-CHARTER STABLE PAIR. WooPPV2 is deployed at the SAME singleton address
 * 0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4 on base/arbitrum/optimism/polygon/bsc (see
 * shared/constants.ts FactoryType.WOOFi). WooPPV2 is a base/quote PMM whose quoteToken is the
 * numeraire; a DIRECT base↔quote leg needs BOTH tokens to be chain baseTokens. Probing the wired
 * chains for the USDT↔USDC leg (both are baseTokens on arbitrum/optimism/polygon):
 *   arbitrum : quote=USDC(6d)  base=USDT(6d)  reserves ≈ 251,724 USDC + 29,569 USDT (~$281k)  ← DEEPEST
 *   optimism : quote=USDC(6d)  base=USDT(6d)  reserves ≈  66,743 USDC + 39,007 USDT (~$105k)
 *   polygon  : quote=USDC(6d)  base=USDT(6d)  reserves ≈  50,902 USDC + 48,313 USDT (~$99k)
 *   bsc      : quote=USDT(18d) base=USDC      NOT feasible — USDC not a WooracleV2 base (state reverts),
 *             pool holds ~0.1 USDT (empty). Off-charter for stable↔stable.
 * Arbitrum's USDT/USDC pool is the deepest and fully on-charter (USDT 0xFd08… + USDC 0xaf88… are both
 * Arbitrum baseTokens), oracle-FEASIBLE (woFeasible=true, price>0), and quotes deeply (query(100k USDT)
 * → 99,903 USDC). Captured here.
 *
 * Captured into two checked-in snapshots (fixtures/snapshots/arbitrum-woofi-USDTUSDC.*):
 *   .bytecode.json — the REAL runtime (eth_getCode) of every contract the swap/quote touches:
 *       the WooPPV2 proxy AND its EIP-1967 implementation, the WooracleV2, and the two Chainlink CL
 *       feed proxies. Each carries a sha256 anchor (see verifyBytecodeIntegrity) — a NO-RPC tamper
 *       tripwire a reviewer without the key can run.
 *   .state.json — the swap-relevant STATE (via getters + raw slots) for deterministic reconstruction:
 *       pool reserves + tokens + decimals + tokenInfos(base){reserve,feeRate,maxGamma,maxNotionalSwap};
 *       WooPPV2 storage scalars (quoteToken/wooracle/feeAddr) + its EIP-1967 impl slot + the packed
 *       tokenInfos(base) slot; WooracleV2 scalars (quoteToken/timestamp/staleDuration/bound/wooPP) + the
 *       woState(base)/clOracles(base)/clOracles(quote) mapping slots for BOTH tokens; the two CL feeds'
 *       latestRoundData (roundId/answer/startedAt/updatedAt/answeredInRound) so the test can seed a
 *       deterministic CL shim; the oracle-state getter outputs; and a query() probe self-check. The block
 *       is pinned for provenance — its timestamp MUST be pinned in the test so state()'s WO-staleness +
 *       CL-updatedAt windows pass exactly as at capture.
 *
 * NEVER persists the RPC url / API key — only contract code + on-chain state.
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   ARBITRUM_RPC_URL=$ARBITRUM_RPC_URL npx tsx src/recipes/test/harness/woofi-snapshot.ts
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
  encodeAbiParameters,
  keccak256,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const NAME = "arbitrum-woofi-USDTUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${NAME}.state.json`);

// Arbitrum WOOFi WooPPV2 singleton + the two on-charter stable baseTokens (see shared/constants.ts).
const WOOPP = "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4" as Address; // WooPPV2 (EIP-1967 proxy)
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address; // native USDC (quote, 6d)
const ARB_USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address; // USDT (base, 6d)

// EIP-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

// WooracleV2_2 storage layout (verified against on-chain reads at the pinned block; Ownable._owner is
// slot 0, so the WooracleV2_2 fields start at slot 1):
//   slot 0  owner                slot 4  quoteToken       slot 5  timestamp (uint256)
//   slot 6  staleDuration        slot 7  bound(low) | wooPP(high, packed)
//   mapping infos       at base slot 1 : keccak(token, 1) → packed {price, coeff, spread} (== woState)
//   mapping clOracles   at base slot 2 : keccak(token, 2) → packed {oracle addr, int8 decimal, bool preferred}
//   mapping priceRanges at base slot 3 : keccak(token, 3) → packed PriceRange{uint128 min, uint128 max}
// The GUARDIAN PriceRange gate (require(min < priceOut < max) in price()) reverts "WooracleV2_2: !max"
// when priceRanges[base] is unset — so it MUST be captured + reconstructed for state() to be feasible.
const ORACLE_SLOT = { owner: 0, quoteToken: 4, timestamp: 5, staleDuration: 6, boundWooPP: 7 } as const;
const ORACLE_MAP_BASE = { woState: 1n, clOracles: 2n, priceRanges: 3n } as const;

// WooPPV2 storage layout (verified against on-chain reads at the pinned block; storage lives at the PROXY
// because the impl reads via delegatecall):
//   slot 0 unclaimedFee   slot 1 maxGasPrice   slot 4 quoteToken   slot 5 wooracle   slot 6 feeAddr
//   mapping tokenInfos at base slot 3 : keccak(token, 3) → packed {reserve, feeRate, maxGamma, maxNotionalSwap}
// slot 1 (maxGasPrice) is an ANTI-MEV gate: swap() does `require(maxGasPrice > tx.gasprice)`. It MUST be
// captured + reconstructed, else the etched swap reverts under any non-zero-gasprice tx (eth_call runs at
// gasprice 0 and passes, so query() works, but a real cook tx would revert without it).
const WOOPP_SLOT = { unclaimedFee: 0, maxGasPrice: 1, quoteToken: 4, wooracle: 5, feeAddr: 6 } as const;
const WOOPP_TOKENINFOS_BASE = 3n;

const RPC =
  process.argv[2] ||
  process.env.ARBITRUM_RPC_URL ||
  process.env.ARBITRUM_RPC ||
  "";
if (!RPC) {
  console.error(
    "no RPC — pass one as argv[2] or set ARBITRUM_RPC_URL (set -a; . sdk/.env; set +a)",
  );
  process.exit(1);
}

const wooPPAbi = parseAbi([
  "function quoteToken() view returns (address)",
  "function wooracle() view returns (address)",
  "function tokenInfos(address token) view returns (uint192 reserve, uint16 feeRate, uint128 maxGamma, uint128 maxNotionalSwap)",
  "function query(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)",
]);
const oracleAbi = parseAbi([
  "function state(address base) view returns (uint128 price, uint64 spread, uint64 coeff, bool woFeasible)",
  "function woState(address base) view returns (uint128 price, uint64 spread, uint64 coeff, bool woFeasible)",
  "function decimals(address base) view returns (uint8)",
  "function quoteToken() view returns (address)",
  "function timestamp() view returns (uint256)",
  "function staleDuration() view returns (uint256)",
  "function bound() view returns (uint64)",
  "function clOracles(address token) view returns (address oracle, int8 decimal, bool cloPreferred)",
]);
const clFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

function slotHex(i: bigint | number): Hex {
  return ("0x" + BigInt(i).toString(16).padStart(64, "0")) as Hex;
}
/** keccak256(abi.encode(token, base)) — the Solidity mapping(address=>...) slot. */
function mapSlot(token: Address, base: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, base]),
  );
}
const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex"));

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 42161) {
    console.warn(`[woofi-snapshot] WARNING: chainId ${chainId} != Arbitrum (42161)`);
  }
  const block = await client.getBlockNumber();
  const blk = await client.getBlock({ blockNumber: block });
  const blockTimestamp = blk.timestamp;
  console.log(`[woofi-snapshot] Arbitrum chainId=${chainId} block=${block} ts=${blockTimestamp}`);

  // ── WooPPV2 pool scalars: numeraire + oracle. Orient the swap as USDT(base) → USDC(quote). ──
  const [quoteToken, wooracle] = await Promise.all([
    client.readContract({ address: WOOPP, abi: wooPPAbi, functionName: "quoteToken" }) as Promise<Address>,
    client.readContract({ address: WOOPP, abi: wooPPAbi, functionName: "wooracle" }) as Promise<Address>,
  ]);
  if (getAddress(quoteToken) !== getAddress(ARB_USDC)) {
    throw new Error(`WooPPV2 quoteToken ${quoteToken} != expected USDC ${ARB_USDC}`);
  }
  const base = ARB_USDT; // USDT is the base token (priced by WooracleV2 against the USDC quote)
  const quote = quoteToken as Address;
  console.log(`[woofi-snapshot] quoteToken=${quote} wooracle=${wooracle} base=${base}`);

  // ── REAL runtimes (eth_getCode) of every contract the swap/quote touches. ──
  const proxyCode = await client.getCode({ address: WOOPP });
  if (!proxyCode || proxyCode === "0x") throw new Error(`empty code at WooPPV2 ${WOOPP}`);

  // WooPPV2 is an EIP-1967 proxy — resolve + capture the implementation.
  const implRaw = await client.getStorageAt({ address: WOOPP, slot: EIP1967_IMPL_SLOT });
  const implAddr = getAddress(("0x" + (implRaw ?? ZERO32).slice(-40)) as Hex) as Address;
  if (BigInt(implAddr) === 0n) throw new Error("WooPPV2 EIP-1967 impl slot is empty");
  const implCode = await client.getCode({ address: implAddr });
  if (!implCode || implCode === "0x") throw new Error(`empty code at WooPPV2 impl ${implAddr}`);

  const oracleCode = await client.getCode({ address: wooracle });
  if (!oracleCode || oracleCode === "0x") throw new Error(`empty code at WooracleV2 ${wooracle}`);

  // The two Chainlink CL feeds WooracleV2.state(base) consults (base/USD and quote/USD).
  const [clBase, clQuote] = await Promise.all([
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "clOracles", args: [base] }) as Promise<
      readonly [Address, number, boolean]
    >,
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "clOracles", args: [quote] }) as Promise<
      readonly [Address, number, boolean]
    >,
  ]);
  const clBaseAddr = clBase[0];
  const clQuoteAddr = clQuote[0];
  const [clBaseCode, clQuoteCode] = await Promise.all([
    client.getCode({ address: clBaseAddr }),
    client.getCode({ address: clQuoteAddr }),
  ]);
  if (!clBaseCode || clBaseCode === "0x") throw new Error(`empty code at CL[base] ${clBaseAddr}`);
  if (!clQuoteCode || clQuoteCode === "0x") throw new Error(`empty code at CL[quote] ${clQuoteAddr}`);
  console.log(
    `[woofi-snapshot] runtimes: proxy=${proxyCode.length / 2 - 1}B impl=${implCode.length / 2 - 1}B ` +
      `oracle=${oracleCode.length / 2 - 1}B clBase=${clBaseCode.length / 2 - 1}B clQuote=${clQuoteCode.length / 2 - 1}B`,
  );

  // ── Swap-relevant STATE via getters (the ground truth the test asserts against). ──
  const [state, woStateOut, priceDecRaw, quoteDecRaw, tokenInfos, poolUSDC, poolUSDT] = await Promise.all([
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "state", args: [base] }) as Promise<
      readonly [bigint, bigint, bigint, boolean]
    >,
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "woState", args: [base] }) as Promise<
      readonly [bigint, bigint, bigint, boolean]
    >,
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "decimals", args: [base] }).then((d) => Number(d)),
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "decimals", args: [quote] }).then((d) => Number(d)).catch(() => 8),
    client.readContract({ address: WOOPP, abi: wooPPAbi, functionName: "tokenInfos", args: [base] }) as Promise<
      readonly [bigint, bigint, bigint, bigint]
    >,
    client.readContract({ address: ARB_USDC, abi: erc20Abi, functionName: "balanceOf", args: [WOOPP] }) as Promise<bigint>,
    client.readContract({ address: ARB_USDT, abi: erc20Abi, functionName: "balanceOf", args: [WOOPP] }) as Promise<bigint>,
  ]);
  const [price, spread, coeff, woFeasible] = state;
  if (!woFeasible || price <= 0n) throw new Error("WooracleV2.state(base) is not feasible — pool would revert");

  const [oracleTimestamp, oracleStaleDuration, oracleBound] = await Promise.all([
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "timestamp" }) as Promise<bigint>,
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "staleDuration" }) as Promise<bigint>,
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "bound" }) as Promise<bigint>,
  ]);

  // Token metadata.
  const [decIn, decOut, symIn, symOut, oracleQuoteToken] = await Promise.all([
    client.readContract({ address: ARB_USDT, abi: erc20Abi, functionName: "decimals" }).then((d) => Number(d)),
    client.readContract({ address: ARB_USDC, abi: erc20Abi, functionName: "decimals" }).then((d) => Number(d)),
    client.readContract({ address: ARB_USDT, abi: erc20Abi, functionName: "symbol" }).catch(() => "USDT"),
    client.readContract({ address: ARB_USDC, abi: erc20Abi, functionName: "symbol" }).catch(() => "USDC"),
    client.readContract({ address: wooracle, abi: oracleAbi, functionName: "quoteToken" }) as Promise<Address>,
  ]);

  // The two CL feeds' latestRoundData (what state() reads) + their reported decimals.
  const [clBaseRound, clQuoteRound, clBaseDec, clQuoteDec] = await Promise.all([
    client.readContract({ address: clBaseAddr, abi: clFeedAbi, functionName: "latestRoundData" }) as Promise<
      readonly [bigint, bigint, bigint, bigint, bigint]
    >,
    client.readContract({ address: clQuoteAddr, abi: clFeedAbi, functionName: "latestRoundData" }) as Promise<
      readonly [bigint, bigint, bigint, bigint, bigint]
    >,
    client.readContract({ address: clBaseAddr, abi: clFeedAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 8),
    client.readContract({ address: clQuoteAddr, abi: clFeedAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 8),
  ]);

  // ── Raw storage slots for deterministic setStorageAt reconstruction. ──
  const [
    oracleOwner, oracleQuoteSlot, oracleTsSlot, oracleStaleSlot, oracleBoundSlot,
    oracleWoBase, oracleWoQuote, oracleClBase, oracleClQuote, oraclePriceRangeBase,
    poolUnclaimed, poolMaxGasPrice, poolQuoteSlot, poolWooracleSlot, poolFeeAddr, poolTokenInfoBase,
  ] = await Promise.all([
    client.getStorageAt({ address: wooracle, slot: slotHex(ORACLE_SLOT.owner) }),
    client.getStorageAt({ address: wooracle, slot: slotHex(ORACLE_SLOT.quoteToken) }),
    client.getStorageAt({ address: wooracle, slot: slotHex(ORACLE_SLOT.timestamp) }),
    client.getStorageAt({ address: wooracle, slot: slotHex(ORACLE_SLOT.staleDuration) }),
    client.getStorageAt({ address: wooracle, slot: slotHex(ORACLE_SLOT.boundWooPP) }),
    client.getStorageAt({ address: wooracle, slot: mapSlot(base, ORACLE_MAP_BASE.woState) }),
    client.getStorageAt({ address: wooracle, slot: mapSlot(quote, ORACLE_MAP_BASE.woState) }),
    client.getStorageAt({ address: wooracle, slot: mapSlot(base, ORACLE_MAP_BASE.clOracles) }),
    client.getStorageAt({ address: wooracle, slot: mapSlot(quote, ORACLE_MAP_BASE.clOracles) }),
    client.getStorageAt({ address: wooracle, slot: mapSlot(base, ORACLE_MAP_BASE.priceRanges) }),
    client.getStorageAt({ address: WOOPP, slot: slotHex(WOOPP_SLOT.unclaimedFee) }),
    client.getStorageAt({ address: WOOPP, slot: slotHex(WOOPP_SLOT.maxGasPrice) }),
    client.getStorageAt({ address: WOOPP, slot: slotHex(WOOPP_SLOT.quoteToken) }),
    client.getStorageAt({ address: WOOPP, slot: slotHex(WOOPP_SLOT.wooracle) }),
    client.getStorageAt({ address: WOOPP, slot: slotHex(WOOPP_SLOT.feeAddr) }),
    client.getStorageAt({ address: WOOPP, slot: mapSlot(base, WOOPP_TOKENINFOS_BASE) }),
  ]);
  // tokenInfos is a multi-slot packed struct — capture a small window from its base slot for BOTH the
  // base AND the quote token. The quote's tokenInfos.reserve is REQUIRED: WooPPV2.query()/swap() gate on
  // `toAmount <= tokenInfos[toToken].reserve`, so for a base→quote sell the quote reserve must be present
  // (else query reverts a custom out-of-reserve error even though state() is feasible).
  const poolTokenInfoSlots: Record<string, Hex> = {};
  for (const tok of [base, quote]) {
    const tokenInfoBaseNum = BigInt(mapSlot(tok, WOOPP_TOKENINFOS_BASE));
    for (let i = 0n; i < 3n; i++) {
      const s = slotHex(tokenInfoBaseNum + i);
      poolTokenInfoSlots[s] = (await client.getStorageAt({ address: WOOPP, slot: s })) ?? ZERO32;
    }
  }

  // ── A query() probe at the captured state — the self-check the offline test reproduces. ──
  const probeIn = 10_000n * 10n ** BigInt(decIn); // 10,000 USDT
  const probeOut = (await client.readContract({
    address: WOOPP,
    abi: wooPPAbi,
    functionName: "query",
    args: [base, quote, probeIn],
  })) as bigint;

  // ── Write the bytecode snapshot (real runtimes + sha256 anchors). ──
  const bytecodeSnap = {
    chain: "arbitrum",
    chainId,
    block: block.toString(),
    blockTimestamp: blockTimestamp.toString(),
    pool: { address: getAddress(WOOPP), runtime: proxyCode, runtimeSha256: sha256(proxyCode) },
    implementation: { address: getAddress(implAddr), runtime: implCode, runtimeSha256: sha256(implCode) },
    isMinimalProxy: false, // EIP-1967 (not EIP-1167 clone); impl resolved via the impl storage slot
    dependencies: {
      wooracle: { address: getAddress(wooracle), runtime: oracleCode, runtimeSha256: sha256(oracleCode) },
      clBase: { address: getAddress(clBaseAddr), runtime: clBaseCode, runtimeSha256: sha256(clBaseCode) },
      clQuote: { address: getAddress(clQuoteAddr), runtime: clQuoteCode, runtimeSha256: sha256(clQuoteCode) },
    },
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Write the state snapshot (getters + raw slots + CL rounds + probe). ──
  const stateSnap = {
    chain: "arbitrum",
    chainId,
    block: block.toString(),
    blockTimestamp: blockTimestamp.toString(),
    source: "woofi",
    pool: getAddress(WOOPP),
    poolImpl: getAddress(implAddr),
    eip1967ImplSlot: EIP1967_IMPL_SLOT,
    wooracle: getAddress(wooracle),
    // Orientation: a direct base↔quote leg. tokenIn=USDT(base) → tokenOut=USDC(quote), sellBase=true.
    tokenIn: getAddress(base),
    tokenOut: getAddress(quote),
    base: getAddress(base),
    quote: getAddress(quote),
    sellBase: true,
    tokenInSymbol: symIn,
    tokenOutSymbol: symOut,
    decimalsIn: decIn,
    decimalsOut: decOut,
    // WooracleV2 sPMM inputs for the base (the SNAPSHOT the recipe replays).
    oracle: {
      quoteToken: getAddress(oracleQuoteToken),
      price: price.toString(),
      spread: spread.toString(),
      coeff: coeff.toString(),
      woFeasible,
      priceDecimals: priceDecRaw, // oracle.decimals(base); priceDec = 10**priceDecimals (canonically 8)
      quoteDecimals: quoteDecRaw,
      timestamp: oracleTimestamp.toString(),
      staleDuration: oracleStaleDuration.toString(),
      bound: oracleBound.toString(),
      // woState (stored, pre-CL-bound) — cross-checks the packed woState slot decode.
      woState: {
        price: woStateOut[0].toString(),
        spread: woStateOut[1].toString(),
        coeff: woStateOut[2].toString(),
        woFeasible: woStateOut[3],
      },
    },
    // WooPPV2 per-base-token config (feeRate 1e5-scaled; caps bound the query view).
    tokenInfos: {
      reserve: tokenInfos[0].toString(),
      feeRate: tokenInfos[1].toString(),
      maxGamma: tokenInfos[2].toString(),
      maxNotionalSwap: tokenInfos[3].toString(),
    },
    // Pool token balances (the reserves the swap moves; USDT balance == tokenInfos.reserve, USDC pays out).
    reserves: { usdc: poolUSDC.toString(), usdt: poolUSDT.toString() },
    // The two Chainlink CL feeds state() consults + their captured rounds (for a deterministic CL shim).
    clOracles: {
      base: {
        token: getAddress(base),
        feed: getAddress(clBaseAddr),
        decimals: clBaseDec,
        oracleDecimal: clBase[1],
        cloPreferred: clBase[2],
        latestRoundData: {
          roundId: clBaseRound[0].toString(),
          answer: clBaseRound[1].toString(),
          startedAt: clBaseRound[2].toString(),
          updatedAt: clBaseRound[3].toString(),
          answeredInRound: clBaseRound[4].toString(),
        },
      },
      quote: {
        token: getAddress(quote),
        feed: getAddress(clQuoteAddr),
        decimals: clQuoteDec,
        oracleDecimal: clQuote[1],
        cloPreferred: clQuote[2],
        latestRoundData: {
          roundId: clQuoteRound[0].toString(),
          answer: clQuoteRound[1].toString(),
          startedAt: clQuoteRound[2].toString(),
          updatedAt: clQuoteRound[3].toString(),
          answeredInRound: clQuoteRound[4].toString(),
        },
      },
    },
    // Raw storage slots (keyed by 0x-slot) for setStorageAt reconstruction of the etched contracts.
    storage: {
      wooracle: {
        [slotHex(ORACLE_SLOT.owner)]: oracleOwner ?? ZERO32,
        [slotHex(ORACLE_SLOT.quoteToken)]: oracleQuoteSlot ?? ZERO32,
        [slotHex(ORACLE_SLOT.timestamp)]: oracleTsSlot ?? ZERO32,
        [slotHex(ORACLE_SLOT.staleDuration)]: oracleStaleSlot ?? ZERO32,
        [slotHex(ORACLE_SLOT.boundWooPP)]: oracleBoundSlot ?? ZERO32,
        [mapSlot(base, ORACLE_MAP_BASE.woState)]: oracleWoBase ?? ZERO32,
        [mapSlot(quote, ORACLE_MAP_BASE.woState)]: oracleWoQuote ?? ZERO32,
        [mapSlot(base, ORACLE_MAP_BASE.clOracles)]: oracleClBase ?? ZERO32,
        [mapSlot(quote, ORACLE_MAP_BASE.clOracles)]: oracleClQuote ?? ZERO32,
        // Guardian PriceRange{min,max} for the base — the price() min/max gate reads this; without it
        // state() reverts "WooracleV2_2: !max" (priceOut < max(=0) is false when the range is unset).
        [mapSlot(base, ORACLE_MAP_BASE.priceRanges)]: oraclePriceRangeBase ?? ZERO32,
      },
      pool: {
        [EIP1967_IMPL_SLOT]: implRaw ?? ZERO32,
        [slotHex(WOOPP_SLOT.unclaimedFee)]: poolUnclaimed ?? ZERO32,
        // maxGasPrice — the anti-MEV gate swap() checks via `require(maxGasPrice > tx.gasprice)`.
        [slotHex(WOOPP_SLOT.maxGasPrice)]: poolMaxGasPrice ?? ZERO32,
        [slotHex(WOOPP_SLOT.quoteToken)]: poolQuoteSlot ?? ZERO32,
        [slotHex(WOOPP_SLOT.wooracle)]: poolWooracleSlot ?? ZERO32,
        [slotHex(WOOPP_SLOT.feeAddr)]: poolFeeAddr ?? ZERO32,
        ...poolTokenInfoSlots,
      },
    },
    // A captured query() probe (10,000 USDT → USDC) at this state — the offline test reproduces it
    // against its etched pool to prove REAL code + REAL state compute the mainnet-identical toAmount.
    probe: {
      fromToken: getAddress(base),
      toToken: getAddress(quote),
      fromAmount: probeIn.toString(),
      toAmount: probeOut.toString(),
    },
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[woofi-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[woofi-snapshot] state: base=${base}(${symIn},${decIn}d) quote=${quote}(${symOut},${decOut}d)\n` +
      `  price=${price} spread=${spread} coeff=${coeff} woFeasible=${woFeasible} priceDec=1e${priceDecRaw}\n` +
      `  feeRate=${tokenInfos[1]} maxGamma=${tokenInfos[2]} maxNotionalSwap=${tokenInfos[3]}\n` +
      `  reserves: USDC=${poolUSDC} USDT=${poolUSDT}\n` +
      `  oracle.timestamp=${oracleTimestamp} staleDuration=${oracleStaleDuration} bound=${oracleBound} blockTs=${blockTimestamp}\n` +
      `  CL[base]=${clBaseAddr} answer=${clBaseRound[1]} updatedAt=${clBaseRound[3]}\n` +
      `  CL[quote]=${clQuoteAddr} answer=${clQuoteRound[1]} updatedAt=${clQuoteRound[3]}\n` +
      `  probe query(${probeIn} USDT) = ${probeOut} USDC`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
