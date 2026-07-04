/**
 * LIVE PROBE (not a test): Algebra Integral PER-POOL tickSpacing discovery on REAL
 * HyperEVM pools — the nest/Kittenswap heterogeneity class.
 *
 * Algebra Integral spacing is a PER-POOL property the single per-factory
 * `algebraTickSpacing` cannot represent (nest hub ts=5 vs its factory default 60;
 * Kittenswap heterogeneous 10/60/500). The lens now reads each Algebra pool's OWN
 * tickSpacing() live and derives the step ratio ON-CHAIN (stepRatioTs — the exact
 * TickMath mirror); the config value is only the revert fallback. This probe runs the
 * REAL lens (fork of the public HyperEVM RPC + freshly deployed engine) against the
 * production nest + Kittenswap factory entries — with DELIBERATELY WRONG config
 * fallbacks — and asserts:
 *   (1) the nest WHYPE/USDT0 hub pool row carries tickSpacing 5 (not the lying config),
 *   (2) the Kittenswap WHYPE/USDT0 pool row carries tickSpacing 10,
 *   (3) the Kittenswap WHYPE/KITTEN pool row carries tickSpacing 500,
 *   (4) every emitted net-row tick of each pool is ON that pool's own grid
 *       (tick % tickSpacing === 0) — the walk STRIDE matches the live spacing.
 *
 * Run:  npx tsx src/recipes/test/harness/algebra-tickspacing-probe.ts
 *       (HYPEREVM_RPC_URL overrides the default public endpoint.)
 */

import { parseEther, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startAnvil } from "./anvil";
import { makeClients } from "./clients";
import { deployContract } from "./deploy";
import { runLens, type LensPool } from "../../ecoswap/lens";
import { SwapPoolType, FactoryType, type ChainPoolConfig, type FactoryConfig } from "../../shared/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(__dirname, "..", "..", "..", "artifacts");

const RPC = process.env.HYPEREVM_RPC_URL ?? "https://rpc.hyperliquid.xyz/evm";

// HyperEVM production addresses (constants.ts hyperevm entry + baseTokens).
const WHYPE = "0x5555555555555555555555555555555555555555" as Hex;
const USDT0 = "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb" as Hex;
const KITTEN = "0x618275F8EFE54c2afa87bfB9F210A52F0fF89364" as Hex; // Kittenswap gov token
const NEST_FACTORY = "0xF77Bd082c627aA54591cF2f2EaA811fd1AB3b1F3" as Hex;
const KITTEN_FACTORY = "0x5f95E92c338e6453111Fc55ee66D4AafccE661A7" as Hex;

// Live pools (probed 2026-07-04 via poolByPair + tickSpacing()):
const NEST_WHYPE_USDT0 = "0x20e6e73c91a29d21bde672562a4b16649d66623e"; // ts=5 (factory default 60)
const KITTEN_WHYPE_USDT0 = "0x3c1403335d0ca7d0a73c9e775b25514537c2b809"; // ts=10
const KITTEN_WHYPE_KITTEN = "0x71d1fde797e1810711e4c9abcfca6ef04c266196"; // ts=500 (L ≈ 5.7e23)

// DELIBERATELY WRONG config fallbacks — if the lens consumed the config instead of the
// live per-pool tickSpacing(), every assert below would see 777 instead of 5/10/500.
const LYING_TS = 777;

function loadArtifact(p: string): { abi: unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(p, "utf-8"));
  return { abi: j.abi, bytecode: (j.bytecode?.object ?? j.bytecode) as Hex };
}

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
}

function algebraConfig(factories: FactoryConfig[]): ChainPoolConfig {
  return { factories, feeTiers: [100, 500, 3000, 10000], baseTokens: [] };
}

let onGridRows = 0; // aggregate: at least one probed pool must yield real on-grid net rows

function assertPool(
  pools: LensPool[],
  address: string,
  expectTs: number,
  label: string,
): void {
  const row = pools.find((p) => p.address.toLowerCase() === address);
  check(row !== undefined, `${label}: pool ${address} discovered by the lens`);
  if (!row) return;
  check(
    row.tickSpacing === expectTs,
    `${label}: emitted tickSpacing == ${expectTs} (live per-pool read; config lied ${LYING_TS}) — got ${row.tickSpacing}`,
  );
  // STRIDE evidence: every emitted INITIALIZED tick lands on the pool's own ts grid. Zero-net
  // boundaries are dropped at decode (lens.ts), so a sparse pool can legally yield no rows in
  // the scanned window — the grid check is then vacuous for THIS pool (the aggregate check
  // below requires real rows from at least one probed pool).
  const ticks = [...row.net.keys()];
  const offGrid = ticks.filter((t) => t % expectTs !== 0);
  if (ticks.length === 0) {
    console.log(`  PASS  ${label}: no initialized ticks in the scanned window (grid check vacuous)`);
  } else {
    onGridRows += ticks.length - offGrid.length;
    check(
      offGrid.length === 0,
      `${label}: all ${ticks.length} emitted net-row ticks on the ts=${expectTs} grid (off-grid: ${offGrid.length})`,
    );
  }
  const windowNote = ticks.length > 0 ? ` tickWindow=[${Math.min(...ticks)}, ${Math.max(...ticks)}]` : "";
  console.log(
    `        spot tick=${row.tick} fee=${row.fee} L=${row.liquidity} scannedFwd=${row.scannedForward}${windowNote}`,
  );
}

async function main(): Promise<void> {
  console.log(`Forking HyperEVM (${process.env.HYPEREVM_RPC_URL ? "HYPEREVM_RPC_URL" : "public rpc.hyperliquid.xyz"}) ...`);
  const anvil = await startAnvil({ forkUrl: RPC, timeoutMs: 300_000 });
  try {
    const clients = await makeClients(anvil.rpcUrl);
    // Engine: Router impl -> SauceRouter proxy (the v1 cook entry the lens runs on).
    const router = loadArtifact(join(ARTIFACTS, "Router.json"));
    const sauceRouter = loadArtifact(join(ARTIFACTS, "SauceRouter.json"));
    const impl = await deployContract(clients.walletClient, clients.publicClient, {
      abi: router.abi,
      bytecode: router.bytecode,
    });
    const cookEntry = await deployContract(clients.walletClient, clients.publicClient, {
      abi: sauceRouter.abi,
      bytecode: sauceRouter.bytecode,
      args: [impl],
    });
    console.log(`Engine deployed: SauceRouter ${cookEntry}\n`);

    const nestEntry: FactoryConfig = {
      address: NEST_FACTORY,
      poolType: SwapPoolType.UniV3,
      factoryType: FactoryType.AlgebraV3,
      label: "nest CL",
      algebraFeeLayout: "integral",
      algebraTickSpacing: LYING_TS,
    };
    const kittenEntry: FactoryConfig = {
      address: KITTEN_FACTORY,
      poolType: SwapPoolType.UniV3,
      factoryType: FactoryType.AlgebraV3,
      label: "Kittenswap CL",
      algebraFeeLayout: "integral",
      algebraTickSpacing: LYING_TS,
    };

    // ── Probe 1: WHYPE → USDT0 (nest ts=5 hub + Kittenswap ts=10, one lens call) ──
    console.log("Probe 1: WHYPE/USDT0 through nest + Kittenswap (config ts lies: 777)");
    const r1 = await runLens(clients.publicClient, cookEntry, algebraConfig([nestEntry, kittenEntry]), {
      tokenIn: WHYPE,
      tokenOut: USDT0,
      zeroForOne: BigInt(WHYPE) < BigInt(USDT0),
      amountIn: parseEther("2000"), // deep enough that the emit walk crosses initialized ticks
      minRelBps: 0, // no survivor filter — assert BOTH pools' rows
      maxTicks: 12, // keep the public-RPC storage-fetch volume tiny
      driftTicks: 2,
      target: "v1", // the deployed engine above is the v1 SauceRouter
    });
    console.log(`  lens: discovered=${r1.discoveredCount} survivors=${r1.survivorCount}`);
    assertPool(r1.pools, NEST_WHYPE_USDT0, 5, "nest WHYPE/USDT0 hub");
    assertPool(r1.pools, KITTEN_WHYPE_USDT0, 10, "Kittenswap WHYPE/USDT0");

    // ── Probe 2: WHYPE → KITTEN (Kittenswap ts=500 — the wide-spacing extreme) ──
    console.log("\nProbe 2: WHYPE/KITTEN through Kittenswap (config ts lies: 777)");
    const r2 = await runLens(clients.publicClient, cookEntry, algebraConfig([kittenEntry]), {
      tokenIn: WHYPE,
      tokenOut: KITTEN,
      zeroForOne: BigInt(WHYPE) < BigInt(KITTEN),
      amountIn: parseEther("5"),
      minRelBps: 0,
      maxTicks: 12,
      driftTicks: 2,
      target: "v1",
    });
    console.log(`  lens: discovered=${r2.discoveredCount} survivors=${r2.survivorCount}`);
    assertPool(r2.pools, KITTEN_WHYPE_KITTEN, 500, "Kittenswap WHYPE/KITTEN");

    console.log("");
    check(onGridRows > 0, `aggregate: ${onGridRows} real on-grid net rows across probed pools`);
    console.log(failures === 0 ? "\nALL PROBES PASS" : `\n${failures} PROBE FAILURE(S)`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    anvil.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
