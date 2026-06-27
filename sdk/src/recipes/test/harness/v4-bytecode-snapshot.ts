/**
 * One-time capture of the REAL Uniswap V4 runtime bytecode (PoolManager +
 * StateView) from Base mainnet, checked in so the V4 EVM sim runs OFFLINE.
 *
 * The EVM test etches these at their CANONICAL Base addresses (see constants
 * UNISWAP_V4_POOL_MANAGER / UNISWAP_V4_STATE_VIEW) — StateView bakes the
 * PoolManager address into its runtime as an immutable, so both MUST live at the
 * real addresses for the lens→manager extsload calls to resolve.
 *
 * Re-capture:  npx tsx src/recipes/test/harness/v4-bytecode-snapshot.ts [rpcUrl]
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UNISWAP_V4_POOL_MANAGER, UNISWAP_V4_STATE_VIEW } from "../../shared/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "fixtures", "snapshots", "v4-bytecode.json");

const RPCS = [
  process.argv[2],
  process.env.BASE_RPC_URL,
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
].filter(Boolean) as string[];

async function getCode(rpc: string, address: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  });
  const json = (await res.json()) as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  if (!json.result || json.result === "0x") throw new Error(`empty code at ${address}`);
  return json.result;
}

async function main() {
  let lastErr: unknown;
  for (const rpc of RPCS) {
    try {
      console.log(`[v4-snapshot] fetching from ${rpc}`);
      const poolManager = await getCode(rpc, UNISWAP_V4_POOL_MANAGER);
      const stateView = await getCode(rpc, UNISWAP_V4_STATE_VIEW);
      // NB: never persist `rpc` here — it may carry an API key.
      const snap = {
        chain: "base",
        poolManager: { address: UNISWAP_V4_POOL_MANAGER, runtime: poolManager },
        stateView: { address: UNISWAP_V4_STATE_VIEW, runtime: stateView },
      };
      writeFileSync(OUT, JSON.stringify(snap, null, 2));
      console.log(
        `[v4-snapshot] wrote ${OUT}\n  PoolManager ${poolManager.length / 2 - 1} bytes\n  StateView ${stateView.length / 2 - 1} bytes`,
      );
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[v4-snapshot] ${rpc} failed: ${(e as Error).message}`);
    }
  }
  throw new Error(`all RPCs failed: ${(lastErr as Error)?.message}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
