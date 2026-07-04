/**
 * EcoSwap multi-chain fork smokes — MANUAL / NETWORK tier (not picked up by the CI globs:
 * the fast tier is an explicit file list and the EVM tier matches *.evm.test.ts only).
 *
 * One parametrized runner over the newly-covered chains: for each chain with an RPC URL in
 * the environment it
 *   1. boots anvil as a FORK of the live chain pinned to a FIXED block (anvil disk-caches
 *      fork state per (chain, block) ⇒ repeat runs are cheap + deterministic),
 *   2. deploys the Sauce engine (Router → SauceRouter) on the fork,
 *   3. runs the REAL discovery + prepare via the chain's actual CHAIN_POOL_CONFIGS entry
 *      for its canonical hub pair (the on-chain lens eth_call + the typed off-chain
 *      discovery paths, exactly what production runs),
 *   4. quoteEcoSwap READ-ONLY (eth_call + state override — no funding) and asserts a sane
 *      nonzero quote plus the expected venue FAMILIES among the survivors (families are
 *      pinned from observed survivors at the pinned block; the relative-depth filter is
 *      free to drop thin venues — only venues verified to SURVIVE at the pin are asserted),
 *   5. on BSC (paid RPC, simple native-wrap funding) also lands a REAL cook() with a funded
 *      caller and asserts the realized output against the read-only quote.
 *
 * Env (skip-when-absent per chain):
 *   BSC_RPC_URL SONIC_RPC_URL CELO_RPC_URL            — paid endpoints (sdk/.env)
 *   HYPEREVM_RPC_URL WORLDCHAIN_RPC_URL PLASMA_RPC_URL UNICHAIN_RPC_URL — public/derived
 *
 * Run (all chains with env present):
 *   npx tsx src/recipes/test/ecoswap.chains.fork.test.ts
 * Run selected chains:
 *   npx tsx src/recipes/test/ecoswap.chains.fork.test.ts bsc hyperevm
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAbi,
  parseEther,
  decodeEventLog,
  keccak256,
  encodeAbiParameters,
  toHex,
  type Abi,
  type Hex,
  type Log,
} from "viem";

import { ecoSwap, quoteEcoSwap, type Erc20Slots } from "../ecoswap/index.js";
import { discoverPools } from "../shared/pool-discovery.js";
import { CHAIN_POOL_CONFIGS, MULTICALL3 } from "../shared/constants.js";
import type { EcoSwapPrepared, PoolInfo } from "../shared/types.js";
import { startAnvil } from "./harness/anvil.js";
import { makeClients } from "./harness/clients.js";
import { loadArtifact } from "./harness/artifacts.js";
import { deployContract, writeAndWait } from "./harness/deploy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(__dirname, "..", "..", "artifacts");

// ── Chain matrix ─────────────────────────────────────────────
//
// forkBlock pins recorded 2026-07-04 (~64 blocks behind each head at authoring). The
// families listed in `expectFamilies` are the venue families OBSERVED SURVIVING the
// relative-depth filter for the hub pair at that pinned block (substring match against the
// venue's source label) — i.e. the wired venues this smoke verifies end-to-end. Venues
// wired-but-depth-filtered at the pin are intentionally NOT asserted (the filter judges
// per-trade depth; see the repo instructions' relative-depth notes).

interface ChainSpec {
  chain: keyof typeof CHAIN_POOL_CONFIGS;
  envVar: string;
  forkBlock: number;
  tokenIn: Hex;
  tokenOut: Hex;
  inLabel: string;
  outLabel: string;
  amountIn: bigint;
  /** Sanity floor for the read-only quote (raw tokenOut units), pinned ≈50% of observed. */
  minQuote: bigint;
  /**
   * Venue families that must appear in DISCOVERY (discoverPools + the typed off-chain
   * paths) — proves the new factory entries are live-wired regardless of the
   * relative-depth filter (case-insensitive substring of the source label).
   */
  expectDiscovered: string[];
  /** Venue families expected among SURVIVORS (post-filter; observed at the pinned block). */
  expectFamilies: string[];
  /** tokenIn's ERC-20 storage layout for the quote state override (default OZ 0/1). */
  erc20Slots?: Erc20Slots;
  /** Also land a funded cook() (native-wrap funding) and check it against the quote. */
  landedCook?: { wrapNative: bigint };
}

const SPECS: ChainSpec[] = [
  {
    // WBNB/USDT hub — incl. the new Topaz CL + THENA Integral + Uniswap V4 entries (3c5751a).
    chain: "bsc",
    envVar: "BSC_RPC_URL",
    forkBlock: 107_957_000,
    tokenIn: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB (18)
    tokenOut: "0x55d398326f99059fF775485246999027B3197955", // USDT (BSC-USD, 18)
    inLabel: "WBNB",
    outLabel: "USDT",
    amountIn: parseEther("5"),
    minQuote: 1_500n * 10n ** 18n, // ≈50% of the observed ~3.4k USDT for 5 WBNB
    // Discovery at the pin surfaces all the newly-wired CL/V4 entries with real liquidity
    // (Topaz ts=50 fee=57, THENA Fusion fee=844, THENA Integral fee=988, V4 500+3000).
    expectDiscovered: [
      "PancakeSwap V3",
      "Uniswap V3",
      "Topaz",
      "THENA Fusion",
      "THENA Integral",
      "Uniswap V4",
      "PancakeSwap V2",
      "Maverick V2",
    ],
    expectFamilies: ["Uniswap V3", "Maverick V2"],
    landedCook: { wrapNative: parseEther("10") },
  },
  {
    // wS/USDC.e hub — SwapX Integral + Shadow CL + WAGMI V3 + Metropolis DLMM (3c5751a).
    chain: "sonic",
    envVar: "SONIC_RPC_URL",
    forkBlock: 75_336_000,
    tokenIn: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", // wS (18)
    tokenOut: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", // USDC.e (6)
    inLabel: "wS",
    outLabel: "USDC.e",
    amountIn: parseEther("1000"),
    // Observed 27.375 USDC.e for 1000 wS — cross-checked against the WAGMI 1500 pool's live
    // slot0 (spot $0.02744/wS at the pin), quote ≈ spot − fees/impact.
    minQuote: 13n * 10n ** 6n,
    expectDiscovered: [
      "SwapX (Algebra Integral CL)",
      "Shadow Exchange CL",
      "WAGMI V3",
      "Metropolis DLMM",
    ],
    // All four wired CL/DLMM families SURVIVE at the pin (Metropolis via LB QL descriptors).
    expectFamilies: [
      "WAGMI V3",
      "Shadow Exchange CL",
      "SwapX (Algebra Integral CL)",
      "Metropolis DLMM",
    ],
  },
  {
    // cUSD/USDC — the Mento on-charter pair (same pair as the mento prod-mirror snapshot),
    // exercising Mento + Uniswap V3 on celo. NOT the CELO hub pair: CELO (GoldToken
    // 0x471E…a438) proxies the NATIVE balance (balanceOf == address.balance) and its
    // transfers go through a celo-specific transfer precompile that anvil does not
    // implement — on an anvil fork a CELO transfer SUCCEEDS but moves NOTHING, so any
    // CELO-legged swap (and the quote's balance-slot state override) is un-forkable.
    // cUSD (Mento StableTokenV2): balances slot 5, allowances slot 7 (probed on-fork).
    //
    // RESOLVED (was: KNOWN FAILURE, MemoryOOG at any trade size, 2026-07-04). The OOG was
    // NOT the quote cook — it was PREPARE's route-edge LENS eth_call: the lens EMIT pass
    // appended one 3-word tick row per concat, whose bump-allocator memory grows ~48·R²
    // (gas ∝ R⁴), and celo's CELO/stable edges carry several ts=1 pools × 256-boundary
    // full-band walks (no pool solo-covers ⇒ floorAdj=0 disables early-stop) ⇒ ~1088 rows
    // ⇒ >2e9 gas. That also explains the bisect (Ubeswap V3 / Uniswap V4 added the ts=1
    // edge pools that crossed the ~830-row threshold) and the ECO_MAX_ROUTES=0 anomaly
    // (the DFS lens-read edges before the cap could gate anything — also fixed; a zero
    // cap now skips the DFS outright). Fixed by the lens's chunked emit (identical bytes,
    // O(rows) allocation) — see ecoswap.lens.sauce.ts "EMIT ALLOCATION SHAPE" and the
    // local no-fork regression at src/recipes/test/ecoswap.lens-scale.evm.test.ts.
    // Verified green on this fork pin post-fix (quote ≈992 USDC for 1000 cUSD).
    chain: "celo",
    envVar: "CELO_RPC_URL",
    forkBlock: 71_238_500,
    tokenIn: "0x765DE816845861e75A25fCA122bb6898B8B1282a", // cUSD (18)
    tokenOut: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", // USDC (Circle native, 6)
    inLabel: "cUSD",
    outLabel: "USDC",
    amountIn: parseEther("1000"),
    minQuote: 900n * 10n ** 6n, // stable-stable: ~1:1 minus fees
    expectDiscovered: ["Uniswap V3", "Mento V2"],
    expectFamilies: ["Uniswap V3", "Mento V2"],
    erc20Slots: { balanceSlot: 5n, allowanceSlot: 7n },
  },
  {
    // WHYPE/USDT0 hub — the full 8-venue HyperEVM sweep (3c5751a + 4f3b020).
    //
    // ENV CAVEAT (2026-07-04): no free ARCHIVAL HyperEVM RPC was found. The official
    // rpc.hyperliquid.xyz/evm and hyperliquid.drpc.org both (a) serve near-latest state
    // regardless of the pinned fork block (pool liquidity drifts between runs — the pin
    // is not honored for storage), and (b) cannot sustain the lens eth_call's storage
    // fetch volume (rate-limit -32005 / the recipe's fixed 120s per-request client
    // timeout). Discovery + slot detection DO complete on both (all 8 wired venues
    // verified live), so this spec is correct — the quote lane needs a paid/archival
    // HYPEREVM_RPC_URL to go green.
    chain: "hyperevm",
    envVar: "HYPEREVM_RPC_URL",
    forkBlock: 39_531_900,
    tokenIn: "0x5555555555555555555555555555555555555555", // WHYPE (18)
    tokenOut: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", // USDT0 (6)
    inLabel: "WHYPE",
    outLabel: "USDT0",
    amountIn: parseEther("10"),
    minQuote: 150n * 10n ** 6n, // ≈50% of the observed ~370 USDT0 for 10 WHYPE
    expectDiscovered: [
      "HyperSwap V3",
      "Project X CL",
      "nest CL",
      "Ramses CL",
      "Kittenswap CL",
      "Hybra V3",
      "Hybra V4",
      "HyperSwap V2",
    ],
    expectFamilies: ["Hybra V4"],
  },
  {
    // WLD/USDC hub — the new World Chain block (3c5751a): official Uniswap V3 + V4.
    chain: "worldchain",
    envVar: "WORLDCHAIN_RPC_URL",
    forkBlock: 31_901_800,
    tokenIn: "0x2cFc85d8E48F8EAB294be644d9E25C3030863003", // WLD (18)
    tokenOut: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1", // USDC (Circle native, 6)
    inLabel: "WLD",
    outLabel: "USDC",
    amountIn: parseEther("500"),
    minQuote: 100n * 10n ** 6n, // ≈50% of the observed 220.56 USDC for 500 WLD
    expectDiscovered: ["Uniswap V3", "Uniswap V4"],
    // Both wired venues SURVIVE (V4 as a direct survivor via the StateView lens path).
    expectFamilies: ["Uniswap V3", "Uniswap V4"],
  },
  {
    // USDe/USDT0 — the Plasma Fluid DEX entry (3c5751a) + Uniswap V3.
    chain: "plasma",
    envVar: "PLASMA_RPC_URL",
    forkBlock: 26_199_000,
    tokenIn: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", // USDe (18)
    tokenOut: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", // USDT0 (6)
    inLabel: "USDe",
    outLabel: "USDT0",
    amountIn: parseEther("1000"),
    minQuote: 900n * 10n ** 6n, // stable-stable: ~1:1 minus fees (observed 999.46 USDT0)
    expectDiscovered: ["Fluid DEX", "Curve", "Uniswap V3"],
    // All three venues survive: Fluid via sampled segments, Curve via QL, Uni V3 direct.
    expectFamilies: ["Fluid DEX", "Curve", "Uniswap V3"],
  },
  {
    // WETH/USDC (ETH pair) — Velodrome Slipstream CL (3c5751a) + Uniswap V2/V3/V4.
    chain: "unichain",
    envVar: "UNICHAIN_RPC_URL",
    forkBlock: 52_391_000,
    tokenIn: "0x4200000000000000000000000000000000000006", // WETH (18)
    tokenOut: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", // USDC (6)
    inLabel: "WETH",
    outLabel: "USDC",
    amountIn: parseEther("0.5"),
    minQuote: 400n * 10n ** 6n, // ≈50% of the observed 872.56 USDC for 0.5 WETH
    // V4 is discovered but its only WETH/USDC pool is dust (L=1.8e7) — lens-dropped.
    expectDiscovered: ["Uniswap V3", "Uniswap V4", "Velodrome CL"],
    // Velodrome Slipstream CL (fee 150, ts 100) SURVIVES and walks clean.
    expectFamilies: ["Uniswap V3", "Velodrome CL"],
  },
];

// ── ABIs ─────────────────────────────────────────────────────

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const wethAbi = parseAbi(["function deposit() payable"]);
const sauceAbi = parseAbi(["function cook(bytes[] memory calls) public payable returns (bytes memory)"]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

// ── Assertion harness (per-chain tallies, ecoswap.test.ts pattern) ──

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  + ${msg}`);
    passed++;
  } else {
    console.log(`  x ${msg}`);
    failed++;
  }
}

// ── Venue-family extraction ──────────────────────────────────
//
// Direct V2/V3/V4 survivors come out of the ON-CHAIN lens with generic sources
// ("lens V3" …), so their family is resolved by address against the off-chain
// discoverPools() map (same factories, same labels as CHAIN_POOL_CONFIGS). Venues
// appended off-chain (Kyber, Solidly volatile, QL/sampled venues) already carry
// their real factory label in `source`.

const QL_VENUE_KEYS = [
  "curves", "lbs", "dodos", "solidlyStables", "wombats", "balancerStables",
  "eulerSwaps", "maverickPools", "cryptoSwaps", "wooFiPools", "fermiPools",
  "fluidPools", "mentoPools", "balancerV3Pools",
] as const;

function survivorFamilies(prepared: EcoSwapPrepared, discovered: PoolInfo[]): string[] {
  const byAddr = new Map<string, string>();
  for (const p of discovered) {
    const k = p.address.toLowerCase();
    // V4 shares the PoolManager address across pools — one label ("Uniswap V4") is fine.
    if (!byAddr.has(k)) byAddr.set(k, p.source);
  }
  const fams = new Set<string>();
  for (const p of prepared.pools) {
    const own = (p as { source?: string }).source;
    const fam =
      own && !own.startsWith("lens")
        ? own
        : byAddr.get(p.address.toLowerCase()) ?? own ?? `unknown(${p.address})`;
    fams.add(fam);
  }
  for (const key of QL_VENUE_KEYS) {
    const arr = (prepared as unknown as Record<string, { source?: string }[] | undefined>)[key];
    for (const v of arr ?? []) fams.add(v.source ?? key);
  }
  return [...fams].sort();
}

// ── ERC-20 storage-slot detection ────────────────────────────
//
// The read-only quote injects the caller's tokenIn balance + allowance via eth_call
// stateOverride, which needs the token's REAL mapping slots — and they vary by
// implementation (OZ 0/1, WETH9 3/4, Mento StableTokenV2 5/7, FiatToken 9/10, …).
// Detect them empirically on the fork: write a marker into candidate mapping slots
// for a THROWAWAY holder via anvil_setStorageAt and read balanceOf/allowance back
// (then zero the probe slots). Falls back to the spec override / OZ when nothing
// responds (e.g. celo's GoldToken, whose balance is the NATIVE account balance).

const PROBE_HOLDER = "0x00000000000000000000000000000000deadbeef" as Hex;
const PROBE_SPENDER = "0x00000000000000000000000000000000feed5eed" as Hex;
const PROBE_VALUE = ("0x" + 123456789n.toString(16).padStart(64, "0")) as Hex;

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

function mapSlot(key: Hex, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
}

async function detectErc20Slots(
  rpcUrl: string,
  publicClient: { readContract: (a: unknown) => Promise<unknown> },
  token: Hex,
): Promise<Erc20Slots | undefined> {
  const setSlot = (slot: Hex, value: Hex) =>
    rpc(rpcUrl, "anvil_setStorageAt", [token, slot, value]);
  const read = (fn: string, args: unknown[]) =>
    publicClient.readContract({ address: token, abi: erc20Abi as Abi, functionName: fn, args }) as Promise<bigint>;

  let balanceSlot: bigint | undefined;
  let allowanceSlot: bigint | undefined;
  for (let s = 0n; s <= 20n; s++) {
    const slot = mapSlot(PROBE_HOLDER, s);
    await setSlot(slot, PROBE_VALUE);
    const bal = await read("balanceOf", [PROBE_HOLDER]).catch(() => 0n);
    await setSlot(slot, toHex(0n, { size: 32 }));
    if (bal === 123456789n) {
      balanceSlot = s;
      break;
    }
  }
  if (balanceSlot === undefined) return undefined;
  for (let s = 0n; s <= 20n; s++) {
    const slot = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [PROBE_SPENDER, mapSlot(PROBE_HOLDER, s)]),
    );
    await setSlot(slot, PROBE_VALUE);
    const alw = await read("allowance", [PROBE_HOLDER, PROBE_SPENDER]).catch(() => 0n);
    await setSlot(slot, toHex(0n, { size: 32 }));
    if (alw === 123456789n) {
      allowanceSlot = s;
      break;
    }
  }
  if (allowanceSlot === undefined) return undefined;
  return { balanceSlot, allowanceSlot };
}

// ── Engine deploy (Router → SauceRouter; no fixture deps) ────

async function deployEngine(
  clients: Awaited<ReturnType<typeof makeClients>>,
): Promise<Hex> {
  const router = loadArtifact(join(ARTIFACTS, "Router.json"));
  const sauceRouter = loadArtifact(join(ARTIFACTS, "SauceRouter.json"));
  const impl = await deployContract(clients.walletClient, clients.publicClient, {
    abi: router.abi,
    bytecode: router.bytecode,
  });
  return deployContract(clients.walletClient, clients.publicClient, {
    abi: sauceRouter.abi,
    bytecode: sauceRouter.bytecode,
    args: [impl],
  });
}

/** Etch Multicall3 if the forked chain somehow lacks it (all current targets have it). */
async function ensureMulticall3(clients: Awaited<ReturnType<typeof makeClients>>): Promise<void> {
  const code = await clients.publicClient.getCode({ address: MULTICALL3 });
  if (code && code !== "0x") return;
  const solc = JSON.parse(
    readFileSync(join(__dirname, "harness", "Multicall3.solc.json"), "utf-8"),
  ) as { contracts: Record<string, { "bin-runtime": string }> };
  const runtime = solc.contracts["Multicall3.sol:Multicall3"]["bin-runtime"];
  await clients.testClient.setCode({ address: MULTICALL3, bytecode: ("0x" + runtime) as Hex });
}

// ── Per-chain run ────────────────────────────────────────────

async function runChain(spec: ChainSpec): Promise<"PASS" | "SKIP" | "FAIL"> {
  const forkUrl = process.env[spec.envVar];
  if (!forkUrl) {
    console.log(`\n=== ${spec.chain}: SKIP (${spec.envVar} not set) ===`);
    return "SKIP";
  }
  const failedBefore = failed;
  console.log(`\n=== ${spec.chain}: fork @ block ${spec.forkBlock} ===`);

  const anvil = await startAnvil({ forkUrl, forkBlock: spec.forkBlock, timeoutMs: 300_000 });
  try {
    const clients = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(clients);
    const sauceRouter = await deployEngine(clients);
    console.log(`  SauceRouter at ${sauceRouter}`);

    const config = CHAIN_POOL_CONFIGS[spec.chain];
    const swap = { tokenIn: spec.tokenIn, tokenOut: spec.tokenOut, amountIn: spec.amountIn };

    // Off-chain discovery (labels only — the family map for the lens survivors).
    const discovered = await discoverPools(
      spec.tokenIn, spec.tokenOut, clients.publicClient, config,
    );
    console.log(`  discoverPools: ${discovered.length} candidate pools`);
    for (const p of discovered) {
      console.log(`    - ${p.source}  ${p.address}  fee=${p.fee}  L=${p.liquidity}`);
    }

    // tokenIn's real balance/allowance mapping slots for the quote's state override.
    const slots =
      spec.erc20Slots ??
      (await detectErc20Slots(anvil.rpcUrl, clients.publicClient, spec.tokenIn));
    console.log(
      slots
        ? `  tokenIn slots: balance=${slots.balanceSlot} allowance=${slots.allowanceSlot}`
        : "  tokenIn slots: NOT detected (falling back to OZ 0/1)",
    );

    // READ-ONLY quote through the real prepare (lens) + compiled solver (state-override eth_call).
    const t0 = Date.now();
    const quote = await quoteEcoSwap(swap, anvil.rpcUrl, sauceRouter, clients.account0, config, {
      erc20Slots: slots,
    });
    const quoteSecs = ((Date.now() - t0) / 1000).toFixed(1);
    const fams = survivorFamilies(quote.prepared, discovered);
    console.log(`  quote: ${quote.amountOut} ${spec.outLabel} for ${spec.amountIn} ${spec.inLabel} (${quoteSecs}s)`);
    console.log(`  survivors: ${quote.prepared.pools.length} direct, ${quote.prepared.routes.length} routes`);
    console.log(`  families: ${fams.join(" | ")}`);

    assert(quote.prepared.pools.length > 0, `direct survivors present (${quote.prepared.pools.length})`);
    assert(quote.amountOut > 0n, `quote is nonzero (${quote.amountOut})`);
    assert(
      quote.amountOut >= spec.minQuote,
      `quote >= sanity floor (${quote.amountOut} >= ${spec.minQuote})`,
    );
    // Discovery check runs against the UNION of discoverPools sources and the prepared
    // venue sources: some typed venues (Fluid/Mento/EulerSwap/…) are discovered inside
    // prepare, not by the standalone discoverPools sweep.
    const discoveredFams = new Set<string>([...discovered.map((p) => p.source), ...fams]);
    for (const fam of spec.expectDiscovered) {
      const hit = [...discoveredFams].some((f) => f.toLowerCase().includes(fam.toLowerCase()));
      assert(hit, `family discovered (wired): ${fam}`);
    }
    for (const fam of spec.expectFamilies) {
      const hit = fams.some((f) => f.toLowerCase().includes(fam.toLowerCase()));
      assert(hit, `family among survivors: ${fam}`);
    }

    // Landed cook (BSC): native-wrap funding, approve, ecoSwap → cook(), compare to the quote.
    if (spec.landedCook) {
      console.log(`  landing a real cook() (${spec.amountIn} ${spec.inLabel})...`);
      await writeAndWait(clients.walletClient, clients.publicClient, {
        address: spec.tokenIn,
        abi: wethAbi as Abi,
        functionName: "deposit",
        value: spec.landedCook.wrapNative,
      });
      await writeAndWait(clients.walletClient, clients.publicClient, {
        address: spec.tokenIn,
        abi: erc20Abi as Abi,
        functionName: "approve",
        args: [sauceRouter, spec.landedCook.wrapNative],
      });

      const result = await ecoSwap(swap, anvil.rpcUrl, sauceRouter, clients.account0, config);
      const readBal = (token: Hex) =>
        clients.publicClient.readContract({
          address: token, abi: erc20Abi as Abi, functionName: "balanceOf", args: [clients.account0],
        }) as Promise<bigint>;
      const inBefore = await readBal(spec.tokenIn);
      const outBefore = await readBal(spec.tokenOut);
      const receipt = await writeAndWait(clients.walletClient, clients.publicClient, {
        address: sauceRouter,
        abi: sauceAbi as Abi,
        functionName: "cook",
        args: [result.bytecodes],
      });
      const spent = inBefore - (await readBal(spec.tokenIn));
      const received = (await readBal(spec.tokenOut)) - outBefore;
      console.log(`  cook: gas=${receipt.gasUsed} spent=${spent} received=${received}`);

      assert(receipt.status === "success", "cook() transaction succeeded");
      assert(spent > 0n && spent <= spec.amountIn, `input spent within amountIn (${spent})`);
      assert(spent >= (spec.amountIn * 95n) / 100n, `>=95% of input deployed (${spent})`);
      assert(received > 0n, `tokenOut received (${received})`);
      // The landed output should match the read-only quote on identical state (same pinned
      // fork, nothing moved between the two prepares) to well under the 0.5% slippage floor.
      const lo = (quote.amountOut * 99n) / 100n;
      const hi = (quote.amountOut * 101n) / 100n;
      assert(received >= lo && received <= hi, `output within 1% of quote (${received} vs ${quote.amountOut})`);
      const outXfers = (receipt.logs as Log[])
        .filter((l) => l.address.toLowerCase() === spec.tokenOut.toLowerCase() && l.topics[0] === TRANSFER_TOPIC)
        .map((l) => decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics }).args as { to: Hex });
      assert(
        outXfers.some((t) => t.to.toLowerCase() === clients.account0.toLowerCase()),
        "tokenOut Transfer to caller emitted",
      );
    }
  } catch (e) {
    console.log(`  x ${spec.chain} errored: ${(e as Error).message?.slice(0, 400)}`);
    failed++;
  } finally {
    anvil.stop();
    await anvil.stopped;
  }
  return failed > failedBefore ? "FAIL" : "PASS";
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const wanted = process.argv.slice(2).map((s) => s.toLowerCase());
  const specs = wanted.length > 0 ? SPECS.filter((s) => wanted.includes(s.chain)) : SPECS;
  if (specs.length === 0) {
    console.error(`No matching chains. Known: ${SPECS.map((s) => s.chain).join(", ")}`);
    process.exit(1);
  }

  const results: Record<string, string> = {};
  for (const spec of specs) {
    results[spec.chain] = await runChain(spec);
  }

  console.log("\n── Summary ──");
  for (const [chain, r] of Object.entries(results)) console.log(`  ${chain}: ${r}`);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
