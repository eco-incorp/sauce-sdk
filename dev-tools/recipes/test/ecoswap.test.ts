/**
 * EcoSwap fork test — deterministic, pinned to a specific Base block.
 *
 * Verifies:
 *  - cook() succeeds
 *  - WETH was spent (most of swapAmount; EcoSwap refunds any unspent dust)
 *  - USDC was received above a sane minimum
 *  - ERC-20 Transfer events for both tokens; caller received USDC
 *  - Uniswap V3 Swap events emitted (pools were hit)
 *  - The off-chain ladder built brackets across multiple pools
 *
 * Env:
 *   BASE_RPC_URL   — Base archive/full-node RPC (required)
 *
 * Run:
 *   BASE_RPC_URL=<url> npx tsx recipes/test/ecoswap.test.ts
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

import { ecoSwap } from "../ecoswap/index";
import { WETH, USDC } from "../shared/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RPC_URL = "http://127.0.0.1:8545";

const FORK_BLOCK = 25_000_000;
const ACCOUNT0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ── ABIs ─────────────────────────────────────────────────────

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const sauceAbi = parseAbi(["function cook(bytes[] memory calls) public payable returns (bytes memory)"]);
const v3SwapEventAbi = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as Hex;

const MIN_USDC_OUT = 1_000n * 10n ** 6n; // 1000 USDC

// ── Assertion harness ────────────────────────────────────────

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

// ── Node lifecycle (shared pattern with the other recipe fork tests) ──

async function waitForNode(maxRetries = 60): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await createPublicClient({ transport: http(RPC_URL) }).getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Hardhat node did not start in time");
}

async function resetForkState(forkUrl: string, blockNumber: number): Promise<void> {
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

async function startForkNode(forkUrl: string, blockNumber: number): Promise<number> {
  try {
    await createPublicClient({ transport: http(RPC_URL) }).getChainId();
    console.log("Using existing node, resetting fork state...");
    await resetForkState(forkUrl, blockNumber);
    return 0;
  } catch {}

  try {
    execSync("lsof -ti :8545 | xargs kill -9 2>/dev/null", { stdio: "ignore" });
  } catch {}
  await new Promise((r) => setTimeout(r, 500));

  const child = spawn(
    "npx",
    ["hardhat", "node", "--fork", forkUrl, "--fork-block-number", String(blockNumber)],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env } },
  );
  child.unref();
  child.stdout?.resume();
  child.stderr?.resume();
  await waitForNode();
  return child.pid!;
}

async function deploySauceRouter(): Promise<Hex> {
  const chainId = await createPublicClient({ transport: http(RPC_URL) }).getChainId();
  const chain = defineChain({
    id: chainId,
    name: "Base Fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const account = privateKeyToAccount(ACCOUNT0_KEY);
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

  const routerImpl = JSON.parse(readFileSync(join(ROOT, "artifacts/Router.json"), "utf-8"));
  const implHash = await walletClient.deployContract({
    abi: routerImpl.abi,
    bytecode: routerImpl.bytecode.object as Hex,
    account,
    chain,
  });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!implReceipt.contractAddress) throw new Error("Router deployment failed");
  console.log(`  Router at ${implReceipt.contractAddress}`);

  const sauceRouter = JSON.parse(readFileSync(join(ROOT, "artifacts/SauceRouter.json"), "utf-8"));
  const routerHash = await walletClient.deployContract({
    abi: sauceRouter.abi,
    bytecode: sauceRouter.bytecode.object as Hex,
    args: [implReceipt.contractAddress as Hex],
    account,
    chain,
  });
  const routerReceipt = await publicClient.waitForTransactionReceipt({ hash: routerHash });
  if (!routerReceipt.contractAddress) throw new Error("SauceRouter deployment failed");
  return routerReceipt.contractAddress as Hex;
}

function stopNode(pid: number) {
  if (pid === 0) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  try {
    execSync("lsof -ti :8545 | xargs kill -9 2>/dev/null", { stdio: "ignore" });
  } catch {}
}

function findTransferLogs(logs: Log[], token: Hex): { from: Hex; to: Hex; value: bigint }[] {
  return logs
    .filter((l) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER_TOPIC)
    .map((l) => decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics }).args as { from: Hex; to: Hex; value: bigint });
}

function findV3SwapLogs(logs: Log[]): { amount0: bigint; amount1: bigint }[] {
  return logs
    .filter((l) => l.topics[0] === V3_SWAP_TOPIC)
    .map((l) => decodeEventLog({ abi: v3SwapEventAbi, data: l.data, topics: l.topics }).args as { amount0: bigint; amount1: bigint });
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const forkUrl = process.env.BASE_RPC_URL;
  if (!forkUrl) {
    console.error("Error: BASE_RPC_URL environment variable required");
    console.error("Usage: BASE_RPC_URL=<url> npx tsx recipes/test/ecoswap.test.ts");
    process.exit(1);
  }

  console.log("\nEcoSwap Fork Test (per-tick bracket water-fill, one swap per pool)");
  console.log(`  Fork block: ${FORK_BLOCK}\n`);

  const pid = await startForkNode(forkUrl, FORK_BLOCK);

  try {
    console.log("Deploying SauceRouter...");
    const sauceRouterAddress = await deploySauceRouter();
    console.log(`SauceRouter at ${sauceRouterAddress}`);

    const chainId = await createPublicClient({ transport: http(RPC_URL) }).getChainId();
    const chain = defineChain({
      id: chainId,
      name: "Base Fork",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    });
    const account = privateKeyToAccount(ACCOUNT0_KEY);
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
    const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

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

    const readBal = async (token: Hex) =>
      (await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;

    const wethBefore = await readBal(WETH);
    const usdcBefore = await readBal(USDC);

    console.log(`\nPreparing EcoSwap: ${swapAmount} WETH -> USDC...`);
    const result = await ecoSwap(
      { tokenIn: WETH, tokenOut: USDC, amountIn: swapAmount },
      RPC_URL,
      sauceRouterAddress,
      account.address,
    );

    const v3 = result.prepared.pools.filter((p) => !p.isV2);
    const v2 = result.prepared.pools.filter((p) => p.isV2);
    console.log(`  V3 pools: ${v3.length}, V2 pools: ${v2.length}, routes: ${result.prepared.routes.length}`);
    console.log(`  Brackets: ${result.prepared.brackets.length}`);
    console.log(`  Direction: ${result.prepared.zeroForOne ? "zeroForOne" : "oneForZero"}`);
    console.log(`  Bytecode segments: ${result.bytecodes.length}`);

    console.log("\nExecuting cook()...");
    const cookHash = await walletClient.writeContract({
      address: sauceRouterAddress,
      abi: sauceAbi,
      functionName: "cook",
      args: [result.bytecodes],
      chain,
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: cookHash });

    const wethAfter = await readBal(WETH);
    const usdcAfter = await readBal(USDC);
    const wethSpent = wethBefore - wethAfter;
    const usdcReceived = usdcAfter - usdcBefore;

    console.log(`\n  Gas used:      ${receipt.gasUsed}`);
    console.log(`  WETH spent:    ${wethSpent}`);
    console.log(`  USDC received: ${usdcReceived}`);

    // ── Assertions ───────────────────────────────────────────
    console.log("\nAssertions:");

    assert(receipt.status === "success", "cook() transaction succeeded");
    assert(result.prepared.pools.length > 0, `Discovered direct pools (${result.prepared.pools.length})`);
    assert(result.prepared.brackets.length > 0, `Built liquidity brackets (${result.prepared.brackets.length})`);
    assert(wethSpent > 0n, `WETH was spent (${wethSpent})`);
    assert(wethSpent <= swapAmount, `WETH spent never exceeds amountIn (${wethSpent} <= ${swapAmount})`);
    // EcoSwap refunds unspent dust; expect the vast majority of input deployed.
    assert(wethSpent >= (swapAmount * 95n) / 100n, `>=95% of input deployed (${wethSpent} of ${swapAmount})`);
    assert(usdcReceived > 0n, `USDC received > 0 (got ${usdcReceived})`);
    assert(usdcReceived >= MIN_USDC_OUT, `USDC received >= ${MIN_USDC_OUT} (got ${usdcReceived})`);

    const usdcTransfers = findTransferLogs(receipt.logs as Log[], USDC);
    assert(usdcTransfers.length > 0, `USDC Transfer event(s) emitted (${usdcTransfers.length})`);
    assert(
      usdcTransfers.some((t) => t.to.toLowerCase() === account.address.toLowerCase()),
      "USDC was transferred to caller",
    );

    const swapLogs = findV3SwapLogs(receipt.logs as Log[]);
    assert(swapLogs.length > 0, `Uniswap V3 Swap event(s) emitted (${swapLogs.length})`);
    for (const s of swapLogs) console.log(`    V3 Swap: amount0=${s.amount0} amount1=${s.amount1}`);

    // Water-fill across multiple pools should hit more than one when available.
    if (v3.length > 1) {
      assert(swapLogs.length >= 2, `Split across multiple pools (${swapLogs.length} V3 swaps)`);
    }

    // Bracket sanity: the ladder must be sorted DESC by sqrtAdjNear.
    let sorted = true;
    for (let i = 1; i < result.prepared.brackets.length; i++) {
      if (result.prepared.brackets[i].sqrtAdjNear > result.prepared.brackets[i - 1].sqrtAdjNear) sorted = false;
    }
    assert(sorted, "Bracket ladder is sorted by descending fee-adjusted price");
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
