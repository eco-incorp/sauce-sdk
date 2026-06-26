/**
 * Boot a fresh local anvil node (NO fork) for integration tests.
 *
 * Spawns `anvil --port <p> --silent`, polls eth_blockNumber until the RPC is
 * live, and returns a handle with a reliable stop(). Every caller MUST stop()
 * the node it boots (use node:test after()/afterEach or try/finally).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface AnvilHandle {
  rpcUrl: string;
  port: number;
  stop(): void;
}

/** Find a free TCP port by binding to :0 and reading the assigned port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine free port")));
      }
    });
  });
}

async function rpcReady(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: string };
        if (typeof json.result === "string") return;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil RPC at ${rpcUrl} not ready within ${timeoutMs}ms: ${String(lastErr)}`);
}

/**
 * Boot a fresh anvil. Retries port selection a few times in case of a race
 * between freePort() releasing the socket and anvil claiming it.
 */
export async function startAnvil(opts: { timeoutMs?: number } = {}): Promise<AnvilHandle> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    const child: ChildProcess = spawn(
      "anvil",
      // Raise the block gas limit high so (a) batched mints (many V3 positions per
      // tx, used by the prod-mirror reconstruction) fit in a single block, and
      // (b) the read-only lens eth_call can request multi-hundred-million gas:
      // anvil caps an eth_call's gas at the block gas limit (it has no separate
      // --rpc-gas-cap), and the full discovery+state+tick scan over a ~10-pool
      // universe (4 passes × 96 ticks × ~10 pools of staticcalls on the v1
      // interpreter) exceeds the prior 200M. 2e9 is well within u64 / JS safe-int,
      // so gas estimation for the mint txs is unaffected (unlike
      // --disable-block-gas-limit, which sets the limit to u64::MAX and perturbs
      // the mint path).
      // --no-request-size-limit: the prod-mirror state cache loads a reconstructed
      // anvil state via anvil_loadState, whose hex payload (~2.5MB for the 10-pool
      // all-pools fixture) exceeds anvil's default 2MB request body limit — without
      // this the loadState RPC fails with "JSON is not a valid request object".
      ["--port", String(port), "--silent", "--gas-limit", "2000000000", "--no-request-size-limit"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });

    let exited = false;
    child.once("exit", () => {
      exited = true;
    });

    const stop = () => {
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    try {
      await rpcReady(rpcUrl, timeoutMs);
      if (exited) throw new Error(`anvil exited during boot: ${stderr}`);
      return { rpcUrl, port, stop };
    } catch (e) {
      lastErr = e;
      stop();
      // small backoff before retrying with a new port
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  throw new Error(`failed to boot anvil after retries: ${String(lastErr)}`);
}
