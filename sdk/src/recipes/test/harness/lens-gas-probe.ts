/**
 * DIAGNOSTIC (audit-only, NOT committed as a test): measure the on-chain v1 lens
 * eth_call gas on the cached allpools 10-pool universe at the legacy fixed-96 window
 * vs the production price-band window (band=256, HI=256), to empirically confirm the
 * "gas stays bounded" claim in lens.ts. Loads the checked-in cached allpools-v1 state.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, createPublicClient, http, defineChain, type Hex } from "viem";

import { startAnvil } from "./anvil";
import { makeClients } from "./clients";
import { measureLensGas } from "../../ecoswap/lens";
import { SwapPoolType, FactoryType, MULTICALL3, type ChainPoolConfig } from "../../shared/constants";
import type { ProdV4Snapshot } from "./v4-snapshot";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "fixtures", "snapshots");
const STATE_DIR = join(__dirname, "..", "fixtures", "anvil-state");

async function main() {
  const blob = join(STATE_DIR, `allpools-v1.state.json.gz`);
  const manifestPath = join(STATE_DIR, `allpools-v1.manifest.json`);
  if (!existsSync(blob) || !existsSync(manifestPath)) {
    console.error(`cached allpools-v1 state not found`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")).data as {
    pancakeDeployer: Hex; poolManager: Hex; stateView: Hex; tokenIn: Hex; tokenOut: Hex;
    v2Factory: Hex; cake100: Hex; stack: { factory: Hex; sauceRouter: Hex };
  };

  const anvil = await startAnvil();
  try {
    const c = await makeClients(anvil.rpcUrl);
    const state = ("0x" + gunzipSync(readFileSync(blob)).toString("hex")) as Hex;
    await c.testClient.loadState({ state });

    const v4f = readdirSync(SNAPSHOT_DIR).find((x) => /-v4-.*\.json$/.test(x));
    const v4snap = v4f ? (JSON.parse(readFileSync(join(SNAPSHOT_DIR, v4f), "utf-8")) as ProdV4Snapshot) : null;

    const poolConfig: ChainPoolConfig = {
      factories: [
        { address: manifest.stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3", feeTiers: [100, 500, 3000, 10000] },
        { address: manifest.pancakeDeployer, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local PancakeV3", feeTiers: [100, 500, 2500, 10000] },
        { address: manifest.poolManager, stateView: manifest.stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Local UniV4", feeTiers: [v4snap!.fee] },
        { address: manifest.v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2" },
      ],
      feeTiers: [100, 500, 3000, 10000],
      baseTokens: [manifest.tokenIn, manifest.tokenOut],
    };
    const chainId = await c.publicClient.getChainId();
    const chain = defineChain({
      id: chainId, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [anvil.rpcUrl] } }, contracts: { multicall3: { address: MULTICALL3 } },
    });
    const client = createPublicClient({ chain, transport: http(anvil.rpcUrl, { timeout: 120_000 }) });

    const amountIn = parseEther("3000");
    const zeroForOne = BigInt(manifest.tokenIn) < BigInt(manifest.tokenOut);
    const router = manifest.stack.sauceRouter;

    const base = { tokenIn: manifest.tokenIn, tokenOut: manifest.tokenOut, zeroForOne, amountIn, driftTicks: 2, minRelBps: 100, target: "v1" as const };

    // Legacy fixed-96 window: band=0 → effTicks floors at 96 for every pool.
    const gasLegacy = await measureLensGas(client, router, poolConfig, { ...base, maxTicks: 96, bandTicks: 0 });
    // Production band: HI=256, band=256 → ts=1 pools walk up to 256, wide-ts floor at 96.
    const gasBand = await measureLensGas(client, router, poolConfig, { ...base, maxTicks: 256, bandTicks: 256 });

    console.log(`[lens-gas v1] legacy(96/band0) = ${gasLegacy} gas (${(Number(gasLegacy) / 1e6).toFixed(1)}M)`);
    console.log(`[lens-gas v1] band  (256/256)  = ${gasBand} gas (${(Number(gasBand) / 1e6).toFixed(1)}M)`);
    console.log(`[lens-gas v1] delta = ${((Number(gasBand) / Number(gasLegacy) - 1) * 100).toFixed(1)}%  (Alchemy eth_call cap ~550M)`);
  } finally {
    anvil.stop();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
