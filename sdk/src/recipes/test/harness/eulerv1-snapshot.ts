/**
 * One-time capture of the REAL EulerSwap V1 (euler-xyz/euler-swap tag eulerswap-1.0) pool + its WHOLE
 * quote/swap contract GRAPH from Ethereum mainnet, so the EulerSwap V1 prod-mirror EVM test runs OFFLINE
 * (no fork, no RPC at run time).
 *
 * Mirrors harness/mento-snapshot.ts (the proven WHOLE-GRAPH pattern): rather than hand-code the storage
 * layout of ~25 EVK/EVC/oracle contracts, we let the EVM enumerate the exact touched set via
 * `debug_traceCall(prestateTracer)` on EVERY production entry point the recipe's discovery + exec path hits
 * (getAssets / curve / getReserves / getParams / getLimits — the discovery reads; computeQuote — the exec
 * quote; and a FULL SUCCESSFUL swap — the exec write). prestateTracer returns {code, touched-storage} per
 * address, so the union across those calls is EXACTLY the code + slots the two paths depend on. We then
 * eth_getCode every touched contract (WITH a sha256 integrity anchor) into a bytecode snapshot, and record
 * the union of touched storage slots (verbatim, per absolute contract address) + the SEMANTIC swap-relevant
 * state (reserves, params, cash, oracle round data) + a computeQuote probe ladder into a state snapshot.
 * Block pinned. The RPC url / key is NEVER persisted — only contract CODE + STATE.
 *
 * ── WHY MULTI-CONTRACT (the ~25-contract graph) ──────────────────────────────────────────────────────
 * A EulerSwap pool is a MetaProxy delegatecalling a single EulerSwap impl; its swap reads VIRTUAL reserves
 * from its OWN CtxLib slot but moves the LP's funds through TWO EVK EVaults (deposit input into vault0,
 * withdraw/borrow output from vault1) on behalf of the LP's `eulerAccount`, gated by the Ethereum Vault
 * Connector (EVC) operator authorization. The vault withdraw/borrow runs a liquidity check that reads a
 * price ORACLE (an EulerRouter → two ChainlinkOracle adapters → their underlying Chainlink aggregators) and
 * the interest-rate model. So the FULL graph the prestate tracer enumerates is:
 *   Pool (MetaProxy) → EulerSwap impl (delegatecall) → EVC → vault0 eUSDC + vault1 eUSDT (EVK modular
 *   proxies) → 5 shared EVK module impls (Borrowing / RiskManager / Vault / … reached by delegatecall) →
 *   EulerRouter oracle → 2 ChainlinkOracle adapters → their Chainlink aggregators → IRM → the dToken →
 *   Permit2 (the vault's deposit pull path) + the two ERC20s.
 *
 * ── TOKEN REPOINTING (the Fluid/Wombat immutable-at-real-address class) ──────────────────────────────
 * Each EVault bakes its underlying token address as an IMMUTABLE in its 366-byte proxy runtime (verified:
 * the USDC address literally appears in vault0's runtime, USDT in vault1's). `getAssets()` on the pool ==
 * vault0.asset()/vault1.asset() resolves to those immutables. So the test CANNOT repoint the tokens via a
 * storage overwrite — it must etch a local MintableERC20 AT EACH REAL token address (so the vault's baked
 * immutable resolves to the local token), fund each vault with its captured `cash` in the local token, and
 * the swap then moves the LOCAL storage-backed tokens through the REAL vault code. Identical to Fluid's
 * token0/token1 immutable etch + Liquidity-layer funding.
 *
 * ── BLOCK-TIMESTAMP PIN (the Fluid/Mento accrual/staleness class) ────────────────────────────────────
 * The swap's vault liquidity check reads the EulerRouter oracle, whose ChainlinkOracle adapters enforce a
 * `maxStaleness` window (90000s here): `block.timestamp - feed.updatedAt > maxStaleness` REVERTS. The two
 * feeds' captured `updatedAt` are ~24060s and ~70476s before the pinned block, both < 90000s. So the offline
 * test MUST pin block.timestamp to the captured block ts (1783003307) — where both feeds are fresh — else
 * the staleness check reverts. (No accrual-underflow subtlety like Fluid — the vault interest accrual
 * tolerates the pin; pinning EXACTLY to the captured ts reproduces the captured quote to the wei.)
 *
 * ── WEI-EXACT ANCHOR ─────────────────────────────────────────────────────────────────────────────────
 * At the pinned block the pool's `computeQuote(tokenIn, tokenOut, A, true)` view equals the REAL
 * `pool.swap(...)` output bit-for-bit (the periphery `quoteExactInput` delegates to this view, and the view
 * IS the swap math), so the offline test asserts cook-output == computeQuote == the ecoswap.optimal.ts
 * oracle (which segments the same off-chain replay). We record a computeQuote ladder + a probe swap output.
 *
 * WHICH POOL: the deepest LIVE (operator-authorized) stable-stable V1 pool the wired FactoryType.EulerSwap
 * discovery reaches — USDC/USDT 0x3bBCC029f312ECe579a7dEb77B13CB8aE15F28A8 (constants.ts eulerSwapPools[0]).
 * curve()=="EulerSwap v1"; getReserves ≈179 USDC / ≈1165 USDT; the pool is an authorized EVC operator of its
 * eulerAccount (getLimits/computeQuote succeed).
 *
 * Re-capture (REQUIRED whenever the reconstruction changes):
 *   set -a; . sdk/.env; set +a
 *   ETH_RPC_URL=$ETH_RPC_URL npx tsx src/recipes/test/harness/eulerv1-snapshot.ts
 *   (optional block override as argv[3])
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
  encodeAbiParameters,
  keccak256,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "ethereum-eulerv1-USDCUSDT";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The wired FactoryType.EulerSwap target on Ethereum (constants.ts eulerSwapPools[0]) — the deepest LIVE
// operator-authorized stable-stable V1 pool.
const POOL = getAddress("0x3bBCC029f312ECe579a7dEb77B13CB8aE15F28A8") as Address;
const FACTORY = getAddress("0xb013be1D0D380C13B58e889f412895970A2Cf228") as Address;

// On-charter Ethereum stables (constants.ts CHAIN_POOL_CONFIGS.ethereum.baseTokens) — the expected pair.
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") as Address;
const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7") as Address;

// The pinned block — read every code/storage AT this block for determinism. Override with argv[3].
const PIN_BLOCK = BigInt(process.argv[3] ?? "25445491");

// The probe/exec trade size (100 USDC) + the discovery/oracle sampling ladder cap (100k USDC — the EVM
// test's solo cap). Both 6-dec USDC-in units.
const PROBE_IN = 100n * 10n ** 6n;
const LADDER_CAP = 100_000n * 10n ** 6n;

// Circle FiatToken (USDC) `balances` mapping is at storage slot 9 — used to pre-fund the pool with USDC in
// the SUCCESSFUL-swap trace's stateOverride (mirroring the recipe's pre-transfer), so the swap runs the
// FULL vault-deposit/withdraw success path and its prestate enumerates the whole write graph.
const USDC_BALANCES_SLOT = 9n;

const RPC = process.argv[2] || process.env.ETH_RPC_URL || process.env.ETHEREUM_RPC_URL || "";
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set ETH_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const poolAbi = parseAbi([
  "function curve() view returns (bytes32)",
  "function getAssets() view returns (address asset0, address asset1)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 status)",
  "function getParams() view returns ((address vault0, address vault1, address eulerAccount, uint112 equilibriumReserve0, uint112 equilibriumReserve1, uint256 priceX, uint256 priceY, uint256 concentrationX, uint256 concentrationY, uint256 fee, uint256 protocolFee, address protocolFeeRecipient) params)",
  "function getLimits(address tokenIn, address tokenOut) view returns (uint256 inLimit, uint256 outLimit)",
  "function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn) view returns (uint256)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
]);
const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function cash() view returns (uint256)",
  "function EVC() view returns (address)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);
const evcAbi = parseAbi([
  "function isAccountOperatorAuthorized(address account, address operator) view returns (bool)",
]);
const clAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

const sha256 = (hex: string) =>
  ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

/** keccak256(abi.encode(address key, uint256 slot)) — a Solidity mapping(address=>_) storage key. */
function erc20BalanceSlot(key: Hex, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(key), slot]));
}

// A geometric-ish cumulative sampler over [0, cap] (∝ s^2, denser near 0) — the SAME grid the production
// EULERSWAP_SAMPLES (M=24) buildEulerSwapSegments produces, so the offline test's discovery/oracle ladder
// lines up with the recipe's.
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

type Prestate = Record<string, { balance?: string; nonce?: number; code?: Hex; storage?: Record<string, Hex> }>;

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 180_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 1) console.warn(`[eulerv1-snapshot] WARNING: chainId ${chainId} != Ethereum (1)`);
  const pinnedBlock = await client.getBlock({ blockNumber: PIN_BLOCK });
  const pinnedTimestamp = pinnedBlock.timestamp;
  console.log(`[eulerv1-snapshot] Ethereum chainId=${chainId} pinned block=${PIN_BLOCK} ts=${pinnedTimestamp}`);
  const blockHex = ("0x" + PIN_BLOCK.toString(16)) as Hex;

  // ── Orient + validate the pair (the discovery surface) + the version discriminator. ──
  const [assets, curve, reserves, params, limits] = await Promise.all([
    client.readContract({ address: POOL, abi: poolAbi, functionName: "getAssets", blockNumber: PIN_BLOCK }) as Promise<readonly [Address, Address]>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "curve", blockNumber: PIN_BLOCK }) as Promise<Hex>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "getReserves", blockNumber: PIN_BLOCK }) as Promise<readonly [bigint, bigint, number]>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "getParams", blockNumber: PIN_BLOCK }) as Promise<{
      vault0: Address; vault1: Address; eulerAccount: Address;
      equilibriumReserve0: bigint; equilibriumReserve1: bigint; priceX: bigint; priceY: bigint;
      concentrationX: bigint; concentrationY: bigint; fee: bigint; protocolFee: bigint; protocolFeeRecipient: Address;
    }>,
    client.readContract({ address: POOL, abi: poolAbi, functionName: "getLimits", args: [USDC, USDT], blockNumber: PIN_BLOCK }) as Promise<readonly [bigint, bigint]>,
  ]);
  const [asset0, asset1] = [getAddress(assets[0]), getAddress(assets[1])];
  const CURVE_V1 = "0x45756c6572537761702076310000000000000000000000000000000000000000";
  if (curve.toLowerCase() !== CURVE_V1) throw new Error(`pool ${POOL} curve() ${curve} != "EulerSwap v1"`);
  if (
    !(
      (asset0.toLowerCase() === USDC.toLowerCase() && asset1.toLowerCase() === USDT.toLowerCase()) ||
      (asset0.toLowerCase() === USDT.toLowerCase() && asset1.toLowerCase() === USDC.toLowerCase())
    )
  ) {
    throw new Error(`pool ${POOL} is not the expected USDC/USDT pair (got ${asset0}/${asset1})`);
  }
  const vault0 = getAddress(params.vault0);
  const vault1 = getAddress(params.vault1);
  const eulerAccount = getAddress(params.eulerAccount);
  console.log(
    `[eulerv1-snapshot] curve=v1 assets=[${asset0},${asset1}] reserves=[${reserves[0]},${reserves[1]},status=${reserves[2]}]\n` +
      `  vault0=${vault0} vault1=${vault1} eulerAccount=${eulerAccount}\n` +
      `  params: eqR0=${params.equilibriumReserve0} eqR1=${params.equilibriumReserve1} px=${params.priceX} py=${params.priceY} ` +
      `cx=${params.concentrationX} cy=${params.concentrationY} fee=${params.fee}\n` +
      `  getLimits(USDC->USDT)=[inLimit=${limits[0]}, outLimit=${limits[1]}]`,
  );

  // ── Vault + EVC facts (echoed to the state snapshot; the etch funds each vault with its cash). ──
  const [v0asset, v1asset, v0cash, v1cash, v0evc, operatorAuthorized] = await Promise.all([
    client.readContract({ address: vault0, abi: vaultAbi, functionName: "asset", blockNumber: PIN_BLOCK }) as Promise<Address>,
    client.readContract({ address: vault1, abi: vaultAbi, functionName: "asset", blockNumber: PIN_BLOCK }) as Promise<Address>,
    client.readContract({ address: vault0, abi: vaultAbi, functionName: "cash", blockNumber: PIN_BLOCK }) as Promise<bigint>,
    client.readContract({ address: vault1, abi: vaultAbi, functionName: "cash", blockNumber: PIN_BLOCK }) as Promise<bigint>,
    client.readContract({ address: vault0, abi: vaultAbi, functionName: "EVC", blockNumber: PIN_BLOCK }) as Promise<Address>,
    client.readContract({ address: vault0, abi: vaultAbi, functionName: "EVC", blockNumber: PIN_BLOCK }).then((evc) =>
      client.readContract({ address: evc as Address, abi: evcAbi, functionName: "isAccountOperatorAuthorized", args: [eulerAccount, POOL], blockNumber: PIN_BLOCK }),
    ) as Promise<boolean>,
  ]);
  const evc = getAddress(v0evc);
  if (v0asset.toLowerCase() !== asset0.toLowerCase() || v1asset.toLowerCase() !== asset1.toLowerCase()) {
    throw new Error(`vault asset() mismatch: v0.asset=${v0asset} v1.asset=${v1asset} vs assets=[${asset0},${asset1}]`);
  }
  if (!operatorAuthorized) throw new Error(`pool ${POOL} is NOT an authorized EVC operator of ${eulerAccount} — dead pool`);
  console.log(`[eulerv1-snapshot] vault0.cash=${v0cash} vault1.cash=${v1cash} EVC=${evc} operatorAuthorized=${operatorAuthorized}`);

  // Which asset is the swap tokenIn (asset0) vs tokenOut (asset1); the deep stable pool trades USDC->USDT.
  const tokenIn = asset0.toLowerCase() === USDC.toLowerCase() ? USDC : USDT;
  const tokenOut = tokenIn === USDC ? USDT : USDC;
  const [decIn, decOut, symIn, symOut] = await Promise.all([
    client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "decimals", blockNumber: PIN_BLOCK }).then(Number),
    client.readContract({ address: tokenOut, abi: erc20Abi, functionName: "decimals", blockNumber: PIN_BLOCK }).then(Number),
    client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "symbol", blockNumber: PIN_BLOCK }).catch(() => "?"),
    client.readContract({ address: tokenOut, abi: erc20Abi, functionName: "symbol", blockNumber: PIN_BLOCK }).catch(() => "?"),
  ]);

  // ── The computeQuote ladder (the wei-exact anchor + the segment source) + the probe quote. ──
  const cumIn = sampleInputs(LADDER_CAP);
  const cumOut: string[] = [];
  for (const amt of cumIn) {
    const o = (await client.readContract({
      address: POOL, abi: poolAbi, functionName: "computeQuote", args: [tokenIn, tokenOut, amt, true], blockNumber: PIN_BLOCK,
    })) as bigint;
    cumOut.push(o.toString());
  }
  const probeOut = (await client.readContract({
    address: POOL, abi: poolAbi, functionName: "computeQuote", args: [tokenIn, tokenOut, PROBE_IN, true], blockNumber: PIN_BLOCK,
  })) as bigint;
  console.log(`[eulerv1-snapshot] computeQuote(${PROBE_IN} ${symIn}) = ${probeOut} ${symOut}; ladder points=${cumIn.length}`);

  // ── Enumerate the WHOLE touched contract graph via debug_traceCall(prestateTracer) on EVERY production
  //    entry point the discovery + exec path hits. The union is the offline etch set. ──
  const isAsset0In = tokenIn === asset0;
  const swapArgs = isAsset0In ? [0n, probeOut, USDC, "0x"] : [probeOut, 0n, USDC, "0x"]; // out in the tokenOut slot; `to` is inert
  const traceCalls: { label: string; call: { from?: Address; to: Address; data: Hex }; override?: Record<string, unknown> }[] = [
    { label: "getAssets", call: { to: POOL, data: encodeFunctionData({ abi: poolAbi, functionName: "getAssets" }) } },
    { label: "curve", call: { to: POOL, data: encodeFunctionData({ abi: poolAbi, functionName: "curve" }) } },
    { label: "getReserves", call: { to: POOL, data: encodeFunctionData({ abi: poolAbi, functionName: "getReserves" }) } },
    { label: "getParams", call: { to: POOL, data: encodeFunctionData({ abi: poolAbi, functionName: "getParams" }) } },
    { label: "getLimits", call: { to: POOL, data: encodeFunctionData({ abi: poolAbi, functionName: "getLimits", args: [tokenIn, tokenOut] }) } },
    { label: "computeQuote", call: { to: POOL, data: encodeFunctionData({ abi: poolAbi, functionName: "computeQuote", args: [tokenIn, tokenOut, PROBE_IN, true] }) } },
  ];
  // The FULL SUCCESSFUL swap: pre-fund the pool with PROBE_IN tokenIn (USDC) via a stateOverride on the
  // Circle FiatToken balances slot (mirrors the recipe's pre-transfer), so the swap runs the ENTIRE
  // vault-deposit/withdraw success path and its prestate enumerates the whole write graph (oracle + IRM
  // + dToken included) — NOT just the fanned-out-before-revert subset a bare (no-input) swap trace gives.
  const poolUsdcBalanceSlot = erc20BalanceSlot(POOL, USDC_BALANCES_SLOT);
  const swapOverride = {
    [USDC]: { stateDiff: { [poolUsdcBalanceSlot]: ("0x" + PROBE_IN.toString(16).padStart(64, "0")) as Hex } },
  };
  const swapData = encodeFunctionData({ abi: poolAbi, functionName: "swap", args: swapArgs as [bigint, bigint, Address, Hex] });

  // Sanity: the successful swap must return non-revert under the pre-transfer override.
  const swapEthCall = await client.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "eth_call" as any,
    params: [{ from: getAddress("0x000000000000000000000000000000000000dEaD"), to: POOL, data: swapData }, blockHex, swapOverride] as any,
  }).catch((e) => { throw new Error(`pre-transfer swap eth_call reverted (graph capture would be incomplete): ${e}`); });
  console.log(`[eulerv1-snapshot] pre-transfer swap eth_call OK (${JSON.stringify(swapEthCall)}) — full success path enumerated`);

  async function trace(call: { from?: Address; to: Address; data: Hex }, override?: Record<string, unknown>): Promise<Prestate> {
    const cfg: Record<string, unknown> = { tracer: "prestateTracer" };
    if (override) cfg.stateOverrides = override;
    return (await client.request({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method: "debug_traceCall" as any,
      params: [call, blockHex, cfg] as any,
    })) as Prestate;
  }

  const prestates: Prestate[] = [];
  for (const t of traceCalls) prestates.push(await trace(t.call, t.override));
  prestates.push(await trace({ from: getAddress("0x000000000000000000000000000000000000dEaD"), to: POOL, data: swapData }, swapOverride));

  // Union the prestates: per address, take the code + the union of touched storage slots. Skip EOAs (no
  // code) and the zero/precompile addresses.
  const graph: Record<string, { code: Hex; storage: Record<string, Hex> }> = {};
  for (const src of prestates) {
    for (const [addr, o] of Object.entries(src)) {
      if (!o.code || o.code === "0x") continue;
      const a = getAddress(addr as Hex).toLowerCase();
      if (!graph[a]) graph[a] = { code: o.code as Hex, storage: {} };
      for (const [slot, val] of Object.entries(o.storage ?? {})) {
        graph[a].storage[slot.toLowerCase()] = val as Hex;
      }
    }
  }
  console.log(`[eulerv1-snapshot] traced graph: ${Object.keys(graph).length} contracts`);

  // Human labels for the well-known members (the rest are EVK module impls / oracle adapters / feeds).
  const roleOf = (a: string): string => {
    const m: Record<string, string> = {
      [POOL.toLowerCase()]: "Pool (EulerSwap V1 MetaProxy)",
      [evc.toLowerCase()]: "EVC (Ethereum Vault Connector)",
      [vault0.toLowerCase()]: `vault0 (EVK ${symIn === "USDC" ? "eUSDC" : "e" + symIn})`,
      [vault1.toLowerCase()]: `vault1 (EVK ${symOut === "USDT" ? "eUSDT" : "e" + symOut})`,
      [tokenIn.toLowerCase()]: `${symIn} (tokenIn ERC20, proxy)`,
      [tokenOut.toLowerCase()]: `${symOut} (tokenOut ERC20)`,
      "0xc35a0fda69e9d71e68c0d9cbb541adfd21d6b117": "EulerSwap impl (delegatecall)",
      "0xa77a6ceabd36b261c4ddea5a7528efed7299f627": "EulerRouter (price oracle)",
      "0x2214e9e19c53edd647726ba2b9258594e9d1fa05": "IRM (interest-rate model)",
      "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
    };
    return m[a] ?? "EVK module impl / oracle adapter / feed";
  };

  // ── Build the bytecode snapshot: eth_getCode every traced contract (fresh, block-pinned) WITH sha256. ──
  const contracts: { address: Hex; role: string; runtime: Hex; runtimeSha256: Hex; touchedSlots: number }[] = [];
  for (const a of Object.keys(graph).sort()) {
    const addr = getAddress(a as Hex) as Address;
    const runtime = await client.getCode({ address: addr, blockNumber: PIN_BLOCK });
    if (!runtime || runtime === "0x") continue; // an EOA that only showed up as a balance touch — skip
    if (runtime.toLowerCase() !== graph[a].code.toLowerCase()) {
      throw new Error(`traced code != eth_getCode for ${addr} (block skew?)`);
    }
    contracts.push({ address: addr, role: roleOf(a), runtime, runtimeSha256: sha256(runtime), touchedSlots: Object.keys(graph[a].storage).length });
  }

  // ── The two Chainlink feeds' captured round data (the freshness the swap's oracle staleness check reads;
  //    recorded for provenance + so a future recapture can diff the pinned window). ──
  const chainlinkFeeds: { feed: Hex; roundId: string; answer: string; updatedAt: string; staleSecs: string }[] = [];
  for (const c of contracts) {
    const rd = await client
      .readContract({ address: c.address, abi: clAbi, functionName: "latestRoundData", blockNumber: PIN_BLOCK })
      .catch(() => null) as readonly [bigint, bigint, bigint, bigint, bigint] | null;
    if (rd && rd[3] > 0n) {
      chainlinkFeeds.push({
        feed: c.address, roundId: rd[0].toString(), answer: rd[1].toString(), updatedAt: rd[3].toString(),
        staleSecs: (pinnedTimestamp - rd[3]).toString(),
      });
    }
  }

  const bytecodeSnap = {
    chain: "ethereum",
    chainId,
    block: PIN_BLOCK.toString(),
    blockTimestamp: pinnedTimestamp.toString(),
    source: "EulerSwap v1",
    pool: POOL,
    factory: FACTORY,
    impl: getAddress("0xc35a0FDA69e9D71e68C0d9CBb541Adfd21D6B117"),
    contracts,
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Build the state snapshot: the union touched storage (verbatim, per contract) + the SEMANTIC state +
  //    the probe/ladder. ──
  const storageByContract: Record<string, Record<string, Hex>> = {};
  for (const a of Object.keys(graph).sort()) {
    if (Object.keys(graph[a].storage).length > 0) storageByContract[getAddress(a as Hex)] = graph[a].storage;
  }

  const stateSnap = {
    chain: "ethereum",
    chainId,
    block: PIN_BLOCK.toString(),
    // The offline test PINS block.timestamp to this (the Chainlink staleness window; see the header).
    blockTimestamp: pinnedTimestamp.toString(),
    source: "EulerSwap v1",
    pool: POOL,
    factory: FACTORY,
    // Discovery orientation.
    asset0,
    asset1,
    tokenIn,
    tokenOut,
    tokenInSymbol: symIn,
    tokenOutSymbol: symOut,
    tokenInDecimals: decIn,
    tokenOutDecimals: decOut,
    isAsset0In,
    curve,
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
    status: reserves[2],
    // The V1 immutable curve params (getParams) — the off-chain replay + the on-chain view agree on these.
    params: {
      vault0, vault1, eulerAccount,
      equilibriumReserve0: params.equilibriumReserve0.toString(),
      equilibriumReserve1: params.equilibriumReserve1.toString(),
      priceX: params.priceX.toString(),
      priceY: params.priceY.toString(),
      concentrationX: params.concentrationX.toString(),
      concentrationY: params.concentrationY.toString(),
      fee: params.fee.toString(),
      protocolFee: params.protocolFee.toString(),
      protocolFeeRecipient: getAddress(params.protocolFeeRecipient),
    },
    getLimits: { inLimit: limits[0].toString(), outLimit: limits[1].toString() },
    // The vault graph roots (the etch funds each vault with its cash in the local token).
    evc,
    vault0,
    vault1,
    eulerAccount,
    vault0Cash: v0cash.toString(),
    vault1Cash: v1cash.toString(),
    operatorAuthorized,
    // The Chainlink feeds' captured freshness (the swap's oracle staleness window — proves the pinned ts
    // keeps them fresh; NOT reconstructed, just recorded — the etched feed runtimes carry the real rounds).
    chainlinkFeeds,
    // Wei-exact anchor: the computeQuote ladder (== the real swap output) + the probe.
    probe: { amountIn: PROBE_IN.toString(), amountOut: probeOut.toString() },
    ladder: { cap: LADDER_CAP.toString(), cumIn: cumIn.map(String), cumOut },
    // The union touched storage per contract (verbatim setStorageAt reconstruction).
    storage: storageByContract,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[eulerv1-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(`[eulerv1-snapshot] contracts captured (${contracts.length}):`);
  for (const c of contracts) {
    console.log(`  ${c.address}  ${c.role.padEnd(34)} ${(c.runtime.length / 2 - 1).toString().padStart(6)}B  slots=${c.touchedSlots}`);
  }
  console.log(`[eulerv1-snapshot] chainlink feeds: ${chainlinkFeeds.map((f) => `${f.feed} stale=${f.staleSecs}s`).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
