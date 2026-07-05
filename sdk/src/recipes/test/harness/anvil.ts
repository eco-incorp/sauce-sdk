/**
 * Boot a fresh local anvil node (NO fork) for integration tests.
 *
 * Spawns `anvil --port <p> --silent`, polls eth_blockNumber until the RPC is
 * live, and returns a handle with a reliable stop(). Every caller MUST stop()
 * the node it boots (use node:test after()/afterEach or try/finally).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AnvilHandle {
  rpcUrl: string;
  port: number;
  stop(): void;
  /** Resolves once the anvil child process has fully exited (its port is released). */
  stopped: Promise<void>;
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
 *
 * `forkUrl`/`forkBlock` (both optional, additive) boot anvil as a FORK of a live
 * chain pinned to a fixed block — anvil disk-caches fetched fork state per
 * (chain, block), so repeat runs against the same pin are cheap and
 * deterministic. Used by the manual network-tier fork smokes
 * (ecoswap.chains.fork.test.ts); omitted ⇒ the fresh no-fork node all the
 * local EVM tests boot (unchanged behavior).
 *
 * `initGenesisNumber` (optional, additive; no-fork only) boots the chain at a HIGH genesis
 * BLOCK NUMBER via a minimal `--init` genesis.json (anvil honors its `number` field; chainId
 * stays 31337 and the dev accounts stay funded — verified). Needed by prod-mirror etches whose
 * captured contracts gate on block.number vs an on-chain last-update BLOCK (the Tessera engine
 * class — a fresh anvil's block ~5 makes the real pricing read as prehistoric and quote 0), the
 * block-number analogue of pinFermiBlockTimestamp's clock pin. NB with --init the genesis
 * timestamp is 0 — callers must still pin the clock (anvil_setTime) after boot.
 *
 * `hardfork` (optional, additive) pins anvil's EVM hardfork — the Ekubo prod-mirror boots
 * `"osaka"` because the GENUINE etched Core/Router runtime executes the CLZ opcode (EIP-7939,
 * Osaka; anvil 1.5.1 accepts the name — boot-probed). Omitted ⇒ anvil's default (unchanged for
 * every existing test).
 */
export async function startAnvil(
  opts: {
    timeoutMs?: number;
    forkUrl?: string;
    forkBlock?: number;
    initGenesisNumber?: bigint;
    hardfork?: string;
  } = {},
): Promise<AnvilHandle> {
  // Forked boots pull state from a remote RPC — allow much longer to come up.
  const timeoutMs = opts.timeoutMs ?? (opts.forkUrl ? 120_000 : 30_000);
  let lastErr: unknown;

  // High-genesis boot (see docstring): a minimal London+Cancun genesis whose `number` anvil honors.
  let initPath: string | null = null;
  if (opts.initGenesisNumber !== undefined) {
    const genesis = {
      config: {
        chainId: 31337, homesteadBlock: 0, eip150Block: 0, eip155Block: 0, eip158Block: 0,
        byzantiumBlock: 0, constantinopleBlock: 0, petersburgBlock: 0, istanbulBlock: 0,
        berlinBlock: 0, londonBlock: 0, terminalTotalDifficulty: 0, shanghaiTime: 0, cancunTime: 0,
      },
      number: "0x" + opts.initGenesisNumber.toString(16),
      gasLimit: "0x77359400",
      difficulty: "0x0",
      alloc: {},
    };
    initPath = join(mkdtempSync(join(tmpdir(), "anvil-genesis-")), "genesis.json");
    writeFileSync(initPath, JSON.stringify(genesis));
  }

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
      [
        "--port", String(port), "--silent", "--gas-limit", "2000000000", "--no-request-size-limit",
        // Fork mode (see docstring): pin to a fixed block for determinism + disk cache reuse.
        ...(opts.forkUrl ? ["--fork-url", opts.forkUrl] : []),
        ...(opts.forkUrl && opts.forkBlock !== undefined
          ? ["--fork-block-number", String(opts.forkBlock)]
          : []),
        // High-genesis boot (no-fork): start the chain at the captured block number (see docstring).
        ...(initPath ? ["--init", initPath] : []),
        // Hardfork pin (see docstring) — the Ekubo prod-mirror needs osaka (EIP-7939 CLZ).
        ...(opts.hardfork ? ["--hardfork", opts.hardfork] : []),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });

    let exited = false;
    // `stopped` resolves on the child's exit event — a caller that boots a new
    // anvil right after stop() (the per-cell reset path) can await it to be sure
    // the prior process is fully gone (and its port released) before the next
    // startAnvil, closing the teardown/boot race that flaked under machine load.
    let markStopped: () => void;
    const stopped = new Promise<void>((resolve) => {
      markStopped = resolve;
    });
    child.once("exit", () => {
      exited = true;
      markStopped();
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
      return { rpcUrl, port, stop, stopped };
    } catch (e) {
      lastErr = e;
      stop();
      // small backoff before retrying with a new port
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  throw new Error(`failed to boot anvil after retries: ${String(lastErr)}`);
}
