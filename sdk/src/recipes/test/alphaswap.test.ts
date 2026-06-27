/**
 * AlphaSwap fork test — deterministic, pinned to a specific Base block.
 *
 * Verifies:
 *  - WETH was spent (caller balance decreased by swapAmount)
 *  - USDC was received (caller balance > 0, above a sane minimum)
 *  - ERC-20 Transfer events emitted for both tokens
 *  - Uniswap V3 Swap events emitted (at least one pool was hit)
 *  - Multiple pools were used (liquidity-proportional splitting)
 *
 * Env:
 *   BASE_RPC_URL   — Base archive/full-node RPC (required)
 *
 * Run:
 *   BASE_RPC_URL=<url> npx tsx src/recipes/test/alphaswap.test.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  Hex,
  defineChain,
  decodeEventLog,
  type Log,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

import { alphaSwap } from "../alphaswap/index";
import { WETH, USDC } from "../shared/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", ".."); // sdk/src — holds artifacts/
const REPO_ROOT = join(ROOT, "..");
// The hardhat fork env (config + deps) lives in dev-tools; spawn `hardhat node` there.
const HARDHAT_DIR = join(REPO_ROOT, "..", "dev-tools");
const RPC_URL = "http://127.0.0.1:8545";

// Pinned block for deterministic results
const FORK_BLOCK = 25_000_000;

const ACCOUNT0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ── ABIs ─────────────────────────────────────────────────────

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const sauceAbi = parseAbi([
  "function cook(bytes[] memory calls) public payable returns (bytes memory)",
]);

const v3SwapEventAbi = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const V3_SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as Hex;

const MIN_USDC_OUT = 1_000n * 10n ** 6n; // 1000 USDC

// ── Test harness ─────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.log(`  \u2717 ${msg}`);
    failed++;
  }
}

// ── Node lifecycle ──────────────────────────────────────────

async function waitForNode(maxRetries = 60): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = createPublicClient({ transport: http(RPC_URL) });
      await client.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Hardhat node did not start in time");
}

async function resetForkState(
  forkUrl: string,
  blockNumber: number,
): Promise<void> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "hardhat_reset",
      id: 1,
      params: [{ forking: { jsonRpcUrl: forkUrl, blockNumber } }],
    }),
  });
  const result = await response.json();
  if (!result.result) throw new Error("hardhat_reset failed");
}

async function startForkNode(
  forkUrl: string,
  blockNumber: number,
): Promise<number> {
  try {
    const client = createPublicClient({ transport: http(RPC_URL) });
    await client.getChainId();
    console.log("Using existing node, resetting fork state...");
    await resetForkState(forkUrl, blockNumber);
    return 0;
  } catch {}

  try {
    execSync("lsof -ti :8545 | xargs kill -9 2>/dev/null", {
      stdio: "ignore",
    });
  } catch {}
  await new Promise((r) => setTimeout(r, 500));

  const child = spawn(
    "npx",
    [
      "hardhat",
      "node",
      "--fork",
      forkUrl,
      "--fork-block-number",
      String(blockNumber),
    ],
    {
      cwd: HARDHAT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env },
    },
  );
  child.unref();
  child.stdout?.resume();
  child.stderr?.resume();

  await waitForNode();
  return child.pid!;
}

async function deploySauceRouter(): Promise<Hex> {
  const chainId = await createPublicClient({
    transport: http(RPC_URL),
  }).getChainId();
  const chain = defineChain({
    id: chainId,
    name: "Base Fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

  const account = privateKeyToAccount(ACCOUNT0_KEY);
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(RPC_URL),
  });

  // Step 1: Deploy Router
  const routerImplArtifact = JSON.parse(
    readFileSync(
      join(ROOT, "artifacts/Router.json"),
      "utf-8",
    ),
  );
  const implHash = await walletClient.deployContract({
    abi: routerImplArtifact.abi,
    bytecode: routerImplArtifact.bytecode.object as Hex,
    account,
    chain,
  });
  const implReceipt = await publicClient.waitForTransactionReceipt({
    hash: implHash,
  });
  if (!implReceipt.contractAddress)
    throw new Error("Router deployment failed");
  const routerImplAddress = implReceipt.contractAddress as Hex;
  console.log(`  Router at ${routerImplAddress}`);

  // Step 2: Deploy SauceRouter(routerImplementation)
  const sauceRouterArtifact = JSON.parse(
    readFileSync(
      join(ROOT, "artifacts/SauceRouter.json"),
      "utf-8",
    ),
  );
  const routerHash = await walletClient.deployContract({
    abi: sauceRouterArtifact.abi,
    bytecode: sauceRouterArtifact.bytecode.object as Hex,
    args: [routerImplAddress],
    account,
    chain,
  });
  const routerReceipt = await publicClient.waitForTransactionReceipt({
    hash: routerHash,
  });
  if (!routerReceipt.contractAddress)
    throw new Error("SauceRouter deployment failed");
  return routerReceipt.contractAddress as Hex;
}

function stopNode(pid: number) {
  if (pid === 0) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  try {
    execSync("lsof -ti :8545 | xargs kill -9 2>/dev/null", {
      stdio: "ignore",
    });
  } catch {}
}

// ── Event helpers ────────────────────────────────────────────

function findTransferLogs(
  logs: Log[],
  token: Hex,
): { from: Hex; to: Hex; value: bigint }[] {
  return logs
    .filter(
      (l) =>
        l.address.toLowerCase() === token.toLowerCase() &&
        l.topics[0] === TRANSFER_TOPIC,
    )
    .map((l) => {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: l.data,
        topics: l.topics,
      });
      const args = decoded.args as { from: Hex; to: Hex; value: bigint };
      return args;
    });
}

function findV3SwapLogs(
  logs: Log[],
): {
  sender: Hex;
  recipient: Hex;
  amount0: bigint;
  amount1: bigint;
}[] {
  return logs
    .filter((l) => l.topics[0] === V3_SWAP_TOPIC)
    .map((l) => {
      const decoded = decodeEventLog({
        abi: v3SwapEventAbi,
        data: l.data,
        topics: l.topics,
      });
      const args = decoded.args as {
        sender: Hex;
        recipient: Hex;
        amount0: bigint;
        amount1: bigint;
      };
      return args;
    });
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const forkUrl = process.env.BASE_RPC_URL;
  if (!forkUrl) {
    console.error("Error: BASE_RPC_URL environment variable required");
    console.error(
      "Usage: BASE_RPC_URL=<url> npx tsx src/recipes/test/alphaswap.test.ts",
    );
    process.exit(1);
  }

  console.log("\nAlphaSwap Fork Test (on-chain intelligence)");
  console.log(`  Fork block: ${FORK_BLOCK}\n`);

  const pid = await startForkNode(forkUrl, FORK_BLOCK);

  try {
    console.log("Deploying SauceRouter...");
    const sauceRouterAddress = await deploySauceRouter();
    console.log(`SauceRouter at ${sauceRouterAddress}`);

    const chainId = await createPublicClient({
      transport: http(RPC_URL),
    }).getChainId();
    const chain = defineChain({
      id: chainId,
      name: "Base Fork",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    });

    const account = privateKeyToAccount(ACCOUNT0_KEY);
    const publicClient = createPublicClient({
      chain,
      transport: http(RPC_URL),
    });
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(RPC_URL),
    });

    // Fund with WETH
    const wethDepositAbi = parseAbi(["function deposit() payable"]);
    const depositAmount = parseEther("10");
    const swapAmount = parseEther("1");

    console.log("Depositing ETH -> WETH...");
    const depositHash = await walletClient.writeContract({
      address: WETH,
      abi: wethDepositAbi,
      functionName: "deposit",
      value: depositAmount,
      chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });

    // Approve
    console.log("Approving SauceRouter...");
    const approveHash = await walletClient.writeContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "approve",
      args: [sauceRouterAddress, depositAmount],
      chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Snapshot balances before
    const wethBefore = (await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    const usdcBefore = (await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;

    // Prepare + compile (off-chain: pool discovery only)
    console.log(`\nPreparing AlphaSwap: ${swapAmount} WETH -> USDC...`);
    const result = await alphaSwap(
      { tokenIn: WETH, tokenOut: USDC, amountIn: swapAmount },
      RPC_URL,
      sauceRouterAddress,
      account.address,
    );

    // Log discovered pools
    console.log(
      `  Direct pools: ${result.prepared.directPools.length}`,
    );
    for (const p of result.prepared.directPools) {
      console.log(
        `    ${p.address.slice(0, 10)}... fee=${p.fee} liq=${p.liquidity}`,
      );
    }
    console.log(
      `  Multi-hop routes: ${result.prepared.multiHopRoutes.length}`,
    );
    for (const r of result.prepared.multiHopRoutes) {
      console.log(
        `    via ${r.intermediateToken.slice(0, 10)}... : ${r.hop1Pool.address.slice(0, 10)}...(fee:${r.hop1Pool.fee}) -> ${r.hop2Pool.address.slice(0, 10)}...(fee:${r.hop2Pool.fee})`,
      );
    }

    // Log generated SauceScript for debugging
    console.log("\n  Generated SauceScript:");
    for (const line of result.source.split("\n")) {
      console.log(`    ${line}`);
    }

    // Execute cook()
    console.log("\nExecuting cook()...");
    const cookHash = await walletClient.writeContract({
      address: sauceRouterAddress,
      abi: sauceAbi,
      functionName: "cook",
      args: [result.bytecodes],
      chain,
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: cookHash,
    });

    // Snapshot balances after
    const wethAfter = (await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    const usdcAfter = (await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;

    const wethSpent = wethBefore - wethAfter;
    const usdcReceived = usdcAfter - usdcBefore;

    console.log(`\n  Gas used:      ${receipt.gasUsed}`);
    console.log(`  WETH spent:    ${wethSpent}`);
    console.log(`  USDC received: ${usdcReceived}`);

    // ── Assertions ───────────────────────────────────────────

    console.log("\nAssertions:");

    assert(
      receipt.status === "success",
      "cook() transaction succeeded",
    );

    assert(
      wethSpent === swapAmount,
      `WETH spent equals swap amount (${wethSpent} == ${swapAmount})`,
    );

    assert(usdcReceived > 0n, `USDC received > 0 (got ${usdcReceived})`);

    assert(
      usdcReceived >= MIN_USDC_OUT,
      `USDC received >= ${MIN_USDC_OUT} (got ${usdcReceived})`,
    );

    // Event checks
    const transferLogs = receipt.logs.filter(
      (l: Log) => l.topics[0] === TRANSFER_TOPIC,
    );
    assert(
      transferLogs.length >= 2,
      `At least 2 Transfer events emitted (got ${transferLogs.length})`,
    );

    const wethTransfers = findTransferLogs(receipt.logs as Log[], WETH);
    assert(
      wethTransfers.length > 0,
      `WETH Transfer event(s) emitted (${wethTransfers.length})`,
    );

    const usdcTransfers = findTransferLogs(receipt.logs as Log[], USDC);
    assert(
      usdcTransfers.length > 0,
      `USDC Transfer event(s) emitted (${usdcTransfers.length})`,
    );

    // Verify caller received USDC
    const usdcToCaller = usdcTransfers.filter(
      (t) => t.to.toLowerCase() === account.address.toLowerCase(),
    );
    assert(usdcToCaller.length > 0, "USDC was transferred to caller");

    // V3 Swap events — with on-chain splitting, expect multiple pool swaps
    const swapLogs = findV3SwapLogs(receipt.logs as Log[]);
    assert(
      swapLogs.length > 0,
      `Uniswap V3 Swap event(s) emitted (${swapLogs.length})`,
    );
    for (const s of swapLogs) {
      console.log(
        `    V3 Swap: amount0=${s.amount0} amount1=${s.amount1}`,
      );
    }

    // With multiple pools, we should see multiple V3 Swap events
    const totalTargets =
      result.prepared.directPools.length +
      result.prepared.multiHopRoutes.length;
    if (totalTargets > 1) {
      assert(
        swapLogs.length >= 2,
        `Multiple V3 Swap events (${swapLogs.length}) — on-chain splitting worked`,
      );
    }
  } finally {
    stopNode(pid);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
