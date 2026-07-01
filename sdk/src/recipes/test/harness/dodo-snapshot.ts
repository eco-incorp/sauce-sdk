/**
 * One-time capture of a REAL DODO V2 PMM (DSP — DODO Stable Pool) from Ethereum mainnet, so the
 * DODO prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time).
 *
 * Mirrors harness/solidly-snapshot.ts (the proven pattern): eth_getCode the pool's REAL runtime
 * (+ the EIP-1167 implementation runtime, since a DODO DSP is deployed as a minimal-proxy CLONE)
 * AND every dependency contract the swap/quote path touches, into a checked-in bytecode snapshot
 * (WITH sha256 integrity anchors), and the swap-relevant state (the full PMM curve state, tokens,
 * decimals, fee rates + the raw pool storage slots) into a state snapshot. Block pinned. The RPC
 * url / key is NEVER persisted — only contract CODE + STATE.
 *
 * WHICH POOL: the DEEPEST on-charter STABLE-pair DODO V2 pool the wired FactoryType.DODO discovery
 * reaches. Enumerated via the DODO V2 factory getDODOPool(base, quote) across the DVMFactory /
 * DSPFactory for {USDC, DAI, USDT}. On Ethereum the deepest stable venue is a DAI/USDT DSP 1.0.1
 * (~$17k in-pool); the Arbitrum/Polygon DVMFactory constants in constants.ts have NO CODE, and the
 * Ethereum stable DODO depth is thin overall — this is the deepest real stable DODO pool reachable
 * (SEE the task return notes: on-charter-stable, but shallow — DODO's deep liquidity is in its
 * volatile base/quote DVM pairs, not the near-abandoned stable pairs).
 *
 * DEPENDENCY CONTRACTS captured (every contract the DSP querySell / swap staticcall path touches):
 *   1. the DSP pool proxy (EIP-1167, 45 bytes) at the captured mainnet address,
 *   2. the DSP implementation runtime (the delegate the proxy forwards to),
 *   3. the MT (maintainer) FEE-RATE MODEL contract — the DSP's querySell* reads the maintainer fee
 *      from it. It is self-contained (SLOAD-only, no external CALL) and reverts getFeeRate(trader)
 *      unless msg.sender is the pool, so we ALSO record the RESOLVED mtFeeRate (read with the pool
 *      as the caller) for the offline harness. The LP fee reads 0 for this DSP; the MT fee is the
 *      only fee, applied inside querySell* (mtFee return leg).
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   ETH_RPC_URL=$ETH_RPC_URL npx tsx src/recipes/test/harness/dodo-snapshot.ts
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
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "ethereum-dodo-DAIUSDT";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// Ethereum on-charter stables (see constants.ts CHAIN_POOL_CONFIGS.ethereum.baseTokens).
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") as Address;
const DAI = getAddress("0x6B175474E89094C44Da98b954EedeAC495271d0F") as Address;
const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7") as Address;
const STABLES = [USDC, DAI, USDT] as const;

// DODO V2 factories on Ethereum (getDODOPool(base, quote) → address[] machines). The DVMFactory
// address is the one wired in constants.ts (FactoryType.DODOZoo); the DSPFactory holds the stable
// pools (the DVM stables are dust). We enumerate BOTH and pick the deepest stable venue.
const DVM_FACTORY = getAddress("0x72d220cE168C4f361dD4deE5D826a01AD8598f6C") as Address; // constants.ts DODO V2
const DSP_FACTORY = getAddress("0x6fdDB76c93299D985f4d3FC7ac468F9A168577A4") as Address; // DODO Stable Pool factory
const FACTORIES = [DVM_FACTORY, DSP_FACTORY] as const;

const RPC =
  process.argv[2] || process.env.ETH_RPC_URL || process.env.ETHEREUM_RPC_URL || "";
if (!RPC) {
  console.error(
    "no RPC — pass one as argv[2] or set ETH_RPC_URL (set -a; . sdk/.env; set +a)",
  );
  process.exit(1);
}

const factoryAbi = parseAbi([
  "function getDODOPool(address baseToken, address quoteToken) view returns (address[] machines)",
]);
const poolAbi = parseAbi([
  "function getPMMStateForCall() view returns (uint256 i, uint256 K, uint256 B, uint256 Q, uint256 B0, uint256 Q0, uint256 R)",
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function _LP_FEE_RATE_() view returns (uint256)",
  "function _MT_FEE_RATE_MODEL_() view returns (address)",
  "function _BASE_RESERVE_() view returns (uint256)",
  "function _QUOTE_RESERVE_() view returns (uint256)",
  "function version() view returns (string)",
  "function querySellBase(address trader, uint256 payBaseAmount) view returns (uint256 receiveQuoteAmount, uint256 mtFee)",
  "function querySellQuote(address trader, uint256 payQuoteAmount) view returns (uint256 receiveBaseAmount, uint256 mtFee)",
]);
const mtModelAbi = parseAbi([
  "function getFeeRate(address trader) view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** Detect an EIP-1167 minimal proxy and extract its implementation address. */
function parseMinimalProxy(code: string): Hex | null {
  const m = code.match(
    /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/,
  );
  if (m) return getAddress(("0x" + m[1]) as Hex);
  const m2 = code.match(/363d3d373d3d3d363d73([0-9a-fA-F]{40})5af4/);
  if (m2) return getAddress(("0x" + m2[1]) as Hex);
  return null;
}

const sha256 = (hex: string) =>
  ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 1) {
    console.warn(`[dodo-snapshot] WARNING: chainId ${chainId} != Ethereum (1)`);
  }
  const block = await client.getBlockNumber();
  console.log(`[dodo-snapshot] Ethereum chainId=${chainId} block=${block}`);

  // ── Discover every stable-pair DODO V2 pool via getDODOPool(base, quote) both orderings. ──
  const seen = new Set<string>();
  const candidates: {
    pool: Address;
    factory: Address;
    base: Address;
    quote: Address;
    state: readonly bigint[];
    lpFee: bigint;
    mtModel: Address;
    depthUsd: number;
  }[] = [];

  const decOf = new Map<string, number>();
  for (const t of STABLES) {
    decOf.set(t.toLowerCase(), Number(await client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" })));
  }

  for (const fac of FACTORIES) {
    const code = await client.getCode({ address: fac }).catch(() => undefined);
    if (!code || code === "0x") {
      console.log(`[dodo-snapshot] factory ${fac}: NO CODE, skipping`);
      continue;
    }
    for (const base of STABLES) {
      for (const quote of STABLES) {
        if (base === quote) continue;
        let addrs: readonly Address[];
        try {
          addrs = (await client.readContract({
            address: fac,
            abi: factoryAbi,
            functionName: "getDODOPool",
            args: [base, quote],
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
            const [state, baseTok, quoteTok, lpFee, mtModel] = await Promise.all([
              client.readContract({ address: addr, abi: poolAbi, functionName: "getPMMStateForCall" }) as Promise<readonly bigint[]>,
              client.readContract({ address: addr, abi: poolAbi, functionName: "_BASE_TOKEN_" }) as Promise<Address>,
              client.readContract({ address: addr, abi: poolAbi, functionName: "_QUOTE_TOKEN_" }) as Promise<Address>,
              client.readContract({ address: addr, abi: poolAbi, functionName: "_LP_FEE_RATE_" }).catch(() => 0n) as Promise<bigint>,
              client.readContract({ address: addr, abi: poolAbi, functionName: "_MT_FEE_RATE_MODEL_" }).catch(() => zeroAddress as Address) as Promise<Address>,
            ]);
            const [, , B, Q] = state;
            const bdec = decOf.get(baseTok.toLowerCase()) ?? 18;
            const qdec = decOf.get(quoteTok.toLowerCase()) ?? 18;
            const depthUsd = Number(B) / 10 ** bdec + Number(Q) / 10 ** qdec;
            candidates.push({ pool: addr, factory: fac, base: baseTok, quote: quoteTok, state, lpFee, mtModel, depthUsd });
          } catch {
            /* non-PMM / partial pool — skip */
          }
        }
      }
    }
  }

  candidates.sort((a, b) => b.depthUsd - a.depthUsd);
  if (candidates.length === 0) throw new Error("no stable-pair DODO V2 pool found on Ethereum");
  const top = candidates[0];
  console.log(
    `[dodo-snapshot] deepest stable DODO V2 pool = ${top.pool} (factory ${top.factory}, depth≈$${top.depthUsd.toFixed(0)})`,
  );
  for (const c of candidates.slice(0, 6)) {
    console.log(`  candidate ${c.pool} depth≈$${c.depthUsd.toFixed(0)} base=${c.base} quote=${c.quote}`);
  }

  const pool = top.pool;
  const baseToken = getAddress(top.base) as Address;
  const quoteToken = getAddress(top.quote) as Address;

  // ── Bytecode: the pool proxy runtime + (clone) impl runtime + the MT fee-rate model runtime. ──
  const poolCode = await client.getCode({ address: pool });
  if (!poolCode || poolCode === "0x") throw new Error(`empty code at pool ${pool}`);
  console.log(`[dodo-snapshot] pool runtime = ${poolCode.length / 2 - 1} bytes`);

  const impl = parseMinimalProxy(poolCode);
  let implCode: string | null = null;
  if (impl) {
    implCode = await client.getCode({ address: impl });
    if (!implCode || implCode === "0x") throw new Error(`empty code at impl ${impl}`);
    console.log(`[dodo-snapshot] pool is an EIP-1167 clone -> impl ${impl} (${implCode.length / 2 - 1} bytes)`);
  } else {
    console.log("[dodo-snapshot] pool is NOT a minimal proxy (self-contained runtime)");
  }

  const mtModel = getAddress(top.mtModel) as Address;
  let mtModelCode: string | null = null;
  if (mtModel && mtModel !== zeroAddress) {
    mtModelCode = await client.getCode({ address: mtModel });
    if (!mtModelCode || mtModelCode === "0x") throw new Error(`empty code at MT fee model ${mtModel}`);
    console.log(`[dodo-snapshot] MT fee-rate model ${mtModel} (${mtModelCode.length / 2 - 1} bytes)`);
  }

  // ── Swap-relevant STATE via the pool's own getters (the ground truth the test asserts against). ──
  const [i, K, B, Q, B0, Q0, Rraw] = top.state;
  const R = Number(Rraw);
  const version = await client.readContract({ address: pool, abi: poolAbi, functionName: "version" }).catch(() => "");
  const [baseReserve, quoteReserve] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "_BASE_RESERVE_" }).catch(() => 0n) as Promise<bigint>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "_QUOTE_RESERVE_" }).catch(() => 0n) as Promise<bigint>,
  ]);
  const [baseDec, quoteDec, baseSym, quoteSym] = await Promise.all([
    client.readContract({ address: baseToken, abi: erc20Abi, functionName: "decimals" }).then(Number),
    client.readContract({ address: quoteToken, abi: erc20Abi, functionName: "decimals" }).then(Number),
    client.readContract({ address: baseToken, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    client.readContract({ address: quoteToken, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
  ]);

  // The MT fee model reverts getFeeRate(trader) unless msg.sender is the pool (it reads msg.sender
  // internally). Resolve the maintainer fee rate the pool would use by calling it FROM the pool.
  let mtFeeRate = 0n;
  if (mtModel && mtModel !== zeroAddress) {
    mtFeeRate = (await client
      .readContract({ address: mtModel, abi: mtModelAbi, functionName: "getFeeRate", args: [zeroAddress], account: pool })
      .catch(() => 0n)) as bigint;
  }

  // Probe quotes at the CAPTURED state — self-checks the offline test reproduces (real code, real
  // reserves). querySellBase(payBase) sells base→quote; querySellQuote(payQuote) sells quote→base.
  const probeBaseIn = 100n * 10n ** BigInt(baseDec); // 100 base units
  const probeQuoteIn = 100n * 10n ** BigInt(quoteDec); // 100 quote units
  const [sellBaseRes, sellQuoteRes] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "querySellBase", args: [zeroAddress, probeBaseIn] }) as Promise<readonly [bigint, bigint]>,
    client.readContract({ address: pool, abi: poolAbi, functionName: "querySellQuote", args: [zeroAddress, probeQuoteIn] }) as Promise<readonly [bigint, bigint]>,
  ]);

  // Raw storage windows for deterministic setStorageAt reconstruction. The DSP clone packs its PMM
  // curve state (tokens, packed reserves/target-reserves, guide price i, slippage K, MT fee model)
  // into low slots (verified: slot1 base, slot2 quote, slot3 packed reserves, slot5 packed targets,
  // slot14 MT model, slot16 K, slot17 i). Capture a generous window so the etched pool reconstructs
  // byte-identically. The MT model is SLOAD-only (no external call) — capture its low slots too.
  const readWindow = async (address: Address, count: number): Promise<Record<string, Hex>> => {
    const slots: Record<string, Hex> = {};
    for (let s = 0; s < count; s++) {
      const slot = ("0x" + s.toString(16).padStart(64, "0")) as Hex;
      const val = await client.getStorageAt({ address, slot });
      slots[s.toString()] = (val ?? ("0x" + "0".repeat(64))) as Hex;
    }
    return slots;
  };
  const poolStorage = await readWindow(pool, 41);
  const mtStorage = mtModel && mtModel !== zeroAddress ? await readWindow(mtModel, 9) : {};

  // ── Write the bytecode snapshot (WITH sha256 anchors). ──
  const bytecodeSnap = {
    chain: "ethereum",
    block: block.toString(),
    pool: { address: pool, runtime: poolCode, runtimeSha256: sha256(poolCode) },
    ...(impl && implCode
      ? { implementation: { address: impl, runtime: implCode, runtimeSha256: sha256(implCode) } }
      : {}),
    isMinimalProxy: Boolean(impl),
    // Dependency contracts beyond the pool/impl (every contract the swap/quote staticcall touches).
    dependencies:
      mtModel && mtModel !== zeroAddress && mtModelCode
        ? [
            {
              name: "mtFeeRateModel",
              address: mtModel,
              runtime: mtModelCode,
              runtimeSha256: sha256(mtModelCode),
            },
          ]
        : [],
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Write the state snapshot. ──
  const stateSnap = {
    chain: "ethereum",
    block: block.toString(),
    pool,
    factory: top.factory,
    dvmFactory: DVM_FACTORY,
    dspFactory: DSP_FACTORY,
    version,
    baseToken,
    quoteToken,
    baseSymbol: baseSym,
    quoteSymbol: quoteSym,
    baseDecimals: baseDec,
    quoteDecimals: quoteDec,
    // Full PMM curve state read from getPMMStateForCall() (i,K,B,Q,B0,Q0,R).
    pmm: {
      i: i.toString(),
      K: K.toString(),
      B: B.toString(),
      Q: Q.toString(),
      B0: B0.toString(),
      Q0: Q0.toString(),
      R,
    },
    baseReserve: baseReserve.toString(),
    quoteReserve: quoteReserve.toString(),
    // Fee rates. lpFeeRate reads 0 for this DSP; the MT model resolves the maintainer fee (from the
    // pool as caller). Combined fee = lpFeeRate + mtFeeRate (1e18-scaled).
    lpFeeRate: top.lpFee.toString(),
    mtFeeRate: mtFeeRate.toString(),
    mtFeeRateModel: mtModel,
    // Captured probe quotes — the self-check the offline test reproduces against the etched pool.
    probe: {
      sellBase: { payBaseAmount: probeBaseIn.toString(), receiveQuoteAmount: sellBaseRes[0].toString(), mtFee: sellBaseRes[1].toString() },
      sellQuote: { payQuoteAmount: probeQuoteIn.toString(), receiveBaseAmount: sellQuoteRes[0].toString(), mtFee: sellQuoteRes[1].toString() },
    },
    // Raw storage windows for setStorageAt reconstruction.
    storage: poolStorage,
    mtStorage,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[dodo-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[dodo-snapshot] state: ${baseSym}(${baseDec})/${quoteSym}(${quoteDec}) version="${version}" R=${R}\n` +
      `  i=${i} K=${K} B=${B} Q=${Q} B0=${B0} Q0=${Q0}\n` +
      `  lpFeeRate=${top.lpFee} mtFeeRate=${mtFeeRate} mtModel=${mtModel}\n` +
      `  probe querySellBase(100 ${baseSym}) = ${sellBaseRes[0]} ${quoteSym} (mtFee ${sellBaseRes[1]})\n` +
      `  probe querySellQuote(100 ${quoteSym}) = ${sellQuoteRes[0]} ${baseSym} (mtFee ${sellQuoteRes[1]})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
