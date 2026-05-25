/**
 * CLI entry point for recipe runner.
 *
 * Usage: npm run recipe <name> <tokenIn> <tokenOut> <amountIn> [--network base]
 *
 * Examples:
 *   npm run recipe megaswap WETH USDC 1              # local fork
 *   npm run recipe megaswap WETH USDC 0.01 --network base  # Base mainnet
 *
 * Local: Run `npm run start:fork <rpc-url>` first.
 * Base:  Requires PRIVATE_KEY and BASE_RPC_URL env vars.
 */

import { config as dotenvConfig } from "dotenv";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  decodeEventLog,
  type Hex,
  defineChain,
  formatUnits,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { WETH, USDC, DAI, USDbC } from "../recipes/shared/constants";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");

// Load .env from repo root (parent of dev-tools)
dotenvConfig({ path: join(REPO_ROOT, "..", ".env") });

// Use PRIVATE_KEY from env for mainnet, fall back to Hardhat account 0 for local dev
const HARDHAT_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PRIVATE_KEY = (process.env.PRIVATE_KEY ?? HARDHAT_KEY) as Hex;

// ── Network deployments ─────────────────────────────────────

const DEPLOYMENTS: Record<string, { sauceAddress: Hex; rpcEnvVar: string }> = {
  base: {
    sauceAddress: "0xcC4F96d8Db447888Bc0D73C0708a6cA49C4F930e",
    rpcEnvVar: "BASE_RPC_URL",
  },
};

// ── Token symbol resolution ──────────────────────────────────

const TOKEN_MAP: Record<string, Hex> = {
  WETH,
  USDC,
  DAI,
  USDbC,
};

function resolveToken(input: string): Hex {
  const upper = input.toUpperCase();
  if (TOKEN_MAP[upper]) return TOKEN_MAP[upper];
  if (input.startsWith("0x") && input.length === 42) return input as Hex;
  const known = Object.keys(TOKEN_MAP).join(", ");
  console.error(`Unknown token: ${input}`);
  console.error(`Known symbols: ${known}`);
  console.error(`Or pass a full 0x address.`);
  process.exit(1);
}


// ── ABIs ─────────────────────────────────────────────────────

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const wethAbi = parseAbi(["function deposit() payable"]);

const sauceAbi = parseAbi([
  "function cook(bytes[] memory calls) public payable returns (bytes memory)",
]);

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2);

  // Extract --network flag
  const networkIdx = rawArgs.indexOf("--network");
  let network: string | null = null;
  const positionalArgs = [...rawArgs];
  if (networkIdx !== -1) {
    network = rawArgs[networkIdx + 1] ?? null;
    positionalArgs.splice(networkIdx, 2);
  }

  // ── TerraSwap: config-file based, handles its own execution ──
  if (positionalArgs[0] === "terraswap") {
    const configPath = positionalArgs[1];
    if (!configPath) {
      console.error("Usage: npm run recipe terraswap <config.json>");
      console.error("\nConfig JSON format:");
      console.error('  { "chains": [{ "name": "base", "rpcUrl": "...", "sauceRouterAddress": "0x...",');
      console.error('    "tokenIn": "0x...", "tokenOut": "0x...", "amountIn": "1000000000000000000" }] }');
      process.exit(1);
    }
    const { CHAIN_POOL_CONFIGS } = await import("../recipes/shared/constants");
    const configJson = JSON.parse(readFileSync(configPath, "utf-8"));
    const chains = configJson.chains.map((c: any) => ({
      ...c,
      amountIn: BigInt(c.amountIn),
      poolConfig: c.poolConfig ?? CHAIN_POOL_CONFIGS[c.name] ?? undefined,
    }));
    const { terraSwap } = await import("../recipes/terraswap/index");
    const result = await terraSwap({ chains }, PRIVATE_KEY);

    console.log("\n========================================");
    console.log("  TerraSwap Result");
    console.log("========================================");
    for (const s of result.series) {
      console.log(`\n  Series ${s.seriesNumber} (priceLimit=${s.priceLimit}):`);
      for (const cr of s.chainResults) {
        console.log(`    [${cr.chainName}] gas=${cr.gasUsed} received=${cr.received} leftover=${cr.leftover} tx=${cr.txHash.slice(0, 14)}...`);
      }
    }
    console.log(`\n  Total received: ${result.totalReceived}`);
    console.log(`  Total gas:      ${result.totalGas}`);
    console.log("");
    return;
  }

  if (positionalArgs.length < 4) {
    console.error(
      "Usage: npm run recipe <name> <tokenIn> <tokenOut> <amountIn> [--network base]",
    );
    console.error("Example: npm run recipe megaswap WETH USDC 1");
    console.error(
      "         npm run recipe megaswap WETH USDC 0.01 -- --network base",
    );
    console.error("         npm run recipe terraswap config.json");
    console.error("\nAvailable recipes: megaswap, alphaswap, gigaswap, terraswap");
    console.error(
      "Available tokens: WETH, USDC, DAI, USDbC (or pass 0x address)",
    );
    console.error(
      `Available networks: ${Object.keys(DEPLOYMENTS).join(", ")} (omit for local fork)`,
    );
    process.exit(1);
  }

  const [recipeName, tokenInArg, tokenOutArg, amountArg] = positionalArgs;
  const tokenIn = resolveToken(tokenInArg);
  const tokenOut = resolveToken(tokenOutArg);

  // Resolve deployment: --network uses hardcoded config, otherwise .deployment.json
  let sauceAddress: Hex;
  let rpcUrl: string;

  if (network) {
    const deployment = DEPLOYMENTS[network];
    if (!deployment) {
      console.error(`Unknown network: ${network}`);
      console.error(`Available: ${Object.keys(DEPLOYMENTS).join(", ")}`);
      process.exit(1);
    }
    rpcUrl = process.env[deployment.rpcEnvVar] ?? "";
    if (!rpcUrl) {
      console.error(
        `Missing env var ${deployment.rpcEnvVar} for network ${network}`,
      );
      process.exit(1);
    }
    sauceAddress = deployment.sauceAddress;
  } else {
    const deploymentPath = join(REPO_ROOT, ".deployment.json");
    if (!existsSync(deploymentPath)) {
      console.error(
        "Error: No deployment found. Run `npm run start:fork <rpc-url>` first, or use --network base.",
      );
      process.exit(1);
    }
    const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8"));
    sauceAddress = deployment.sauceAddress;
    rpcUrl = deployment.rpcUrl;
  }

  // Set up clients (fork RPC can be slow, use generous timeout)
  const transport = http(rpcUrl, { timeout: 120_000 });
  const account = privateKeyToAccount(PRIVATE_KEY);
  const tempClient = createPublicClient({ transport });
  const chainId = await tempClient.getChainId();

  const chain = defineChain({
    id: chainId,
    name: "Fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account,
    chain,
    transport,
  });

  // Fetch token decimals and parse human-readable amount (e.g. "0.01" -> wei)
  const [inDecimals, outDecimals] = await Promise.all([
    publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: "decimals",
    }) as Promise<number>,
    publicClient.readContract({
      address: tokenOut,
      abi: erc20Abi,
      functionName: "decimals",
    }) as Promise<number>,
  ]);
  const amountIn = parseUnits(amountArg, inDecimals);

  console.log("=== Sauce Recipe Runner ===\n");
  console.log("Network:   ", network ?? "local");
  console.log("Recipe:    ", recipeName);
  console.log("Token In:  ", tokenInArg, `(${tokenIn})`);
  console.log("Token Out: ", tokenOutArg, `(${tokenOut})`);
  console.log("Amount:    ", `${amountArg} (${amountIn} wei)`);
  console.log("Sauce:     ", sauceAddress);
  console.log("Caller:    ", account.address);
  console.log("RPC:       ", rpcUrl);
  console.log("");

  // ── Auto-fund: wrap ETH -> WETH if needed ──────────────────

  if (tokenIn.toLowerCase() === WETH.toLowerCase()) {
    const balance = (await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;

    if (balance < amountIn) {
      const needed = amountIn - balance;
      console.log(`Wrapping ${formatUnits(needed, 18)} ETH -> WETH...`);
      const hash = await walletClient.writeContract({
        address: WETH,
        abi: wethAbi,
        functionName: "deposit",
        value: needed,
        chain,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  } else {
    // Check balance for non-WETH tokens
    const balance = (await publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;

    if (balance < amountIn) {
      console.error(
        `Insufficient ${tokenInArg} balance: have ${balance}, need ${amountIn}`,
      );
      console.error(
        "Fund the caller account or use WETH (auto-wraps from ETH).",
      );
      process.exit(1);
    }
  }

  // ── Auto-approve ───────────────────────────────────────────

  console.log("Approving SauceRouter...");
  const approveHash = await walletClient.writeContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: "approve",
    args: [sauceAddress as Hex, amountIn],
    chain,
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // ── (balance snapshots taken from tx logs below) ──────────

  // ── Prepare recipe ─────────────────────────────────────────

  console.log("Preparing recipe...\n");

  let bytecodes: Hex[];

  if (recipeName === "megaswap") {
    const { megaSwap } = await import("../recipes/megaswap/index");
    const result = await megaSwap(
      { tokenIn, tokenOut, amountIn },
      rpcUrl,
      sauceAddress as Hex,
      account.address,
    );
    bytecodes = result.bytecodes;

    console.log(`  Pools: ${result.prepared.pools.length}`);
    for (const p of result.prepared.pools) {
      console.log(
        `    ${p.pool.address.slice(0, 10)}... fee=${p.pool.fee} type=${p.pool.poolType}`,
      );
    }
    console.log(`  Step size: ${result.prepared.stepSize}`);
    console.log(`  Expected output: ${result.prepared.expectedOutput}`);
  } else if (recipeName === "alphaswap") {
    const { alphaSwap } = await import("../recipes/alphaswap/index");
    const result = await alphaSwap(
      { tokenIn, tokenOut, amountIn },
      rpcUrl,
      sauceAddress as Hex,
      account.address,
    );
    bytecodes = result.bytecodes;

    console.log(`  Direct pools: ${result.prepared.directPools.length}`);
    for (const p of result.prepared.directPools) {
      console.log(
        `    ${p.address.slice(0, 10)}... fee=${p.fee} liq=${p.liquidity}`,
      );
    }
    console.log(`  Multi-hop routes: ${result.prepared.multiHopRoutes.length}`);
    for (const r of result.prepared.multiHopRoutes) {
      console.log(`    via ${r.intermediateToken.slice(0, 10)}...`);
    }
  } else if (recipeName === "gigaswap") {
    const { gigaSwap } = await import("../recipes/gigaswap/index");
    const result = await gigaSwap(
      { tokenIn, tokenOut, amountIn },
      rpcUrl,
      sauceAddress as Hex,
      account.address,
    );
    bytecodes = result.bytecodes;

    console.log(`  V3 pools (price-limited): ${result.prepared.priceLimitedPools.length}`);
    for (const dp of result.prepared.priceLimitedPools) {
      console.log(
        `    [V3] ${dp.pool.source} ${dp.pool.address.slice(0, 10)}... fee=${dp.pool.fee}`,
      );
    }
    console.log(`  V2 pools (no-limit): ${result.prepared.noLimitPools.length}`);
    for (const dp of result.prepared.noLimitPools) {
      console.log(
        `    [V2] ${dp.pool.source} ${dp.pool.address.slice(0, 10)}... split=${formatUnits(dp.splitAmount, inDecimals)}`,
      );
    }
    console.log(`  Multi-hop routes: ${result.prepared.multiHopRoutes.length}`);
    for (const r of result.prepared.multiHopRoutes) {
      console.log(
        `    via ${r.route.intermediateToken.slice(0, 10)}... split=${formatUnits(r.splitAmount, inDecimals)}`,
      );
    }
    console.log(`  Global price limit: ${result.prepared.globalPriceLimit}`);
    console.log(`  Direction: ${result.prepared.zeroForOne ? "zeroForOne" : "oneForZero"}`);
  } else {
    console.error(`Unknown recipe: ${recipeName}`);
    console.error("Available recipes: megaswap, alphaswap, gigaswap, terraswap");
    process.exit(1);
  }

  console.log(`\n  Bytecode segments: ${bytecodes.length}`);
  for (let i = 0; i < bytecodes.length; i++) {
    const seg = bytecodes[i];
    console.log(`    [${i}] ${(seg.length - 2) / 2} bytes`);
  }

  // ── Execute cook() ─────────────────────────────────────────

  console.log("\nExecuting cook()...");

  const cookHash = await walletClient.writeContract({
    address: sauceAddress as Hex,
    abi: sauceAbi,
    functionName: "cook",
    args: [bytecodes],
    chain,
    account,
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: cookHash,
    confirmations: 1,
  });

  // ── Results (parsed from Transfer logs) ────────────────────

  const transferEvent = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  );
  const sauceLower = (sauceAddress as string).toLowerCase();

  let spent = 0n;
  let received = 0n;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: (log as any).topics,
      });
      if ((decoded as any).eventName !== "Transfer") continue;
      const { from, to, value } = (decoded as any).args;
      // tokenIn transferred FROM caller -> sauce
      if (
        log.address.toLowerCase() === tokenIn.toLowerCase() &&
        from.toLowerCase() === account.address.toLowerCase()
      ) {
        spent += value;
      }
      // tokenOut transferred FROM sauce -> caller
      if (
        log.address.toLowerCase() === tokenOut.toLowerCase() &&
        to.toLowerCase() === account.address.toLowerCase() &&
        from.toLowerCase() === sauceLower
      ) {
        received += value;
      }
    } catch {
      // not a Transfer event, skip
    }
  }

  console.log("\n========================================");
  console.log("  Result");
  console.log("========================================");
  console.log(`  Status:       ${receipt.status}`);
  console.log(`  Gas used:     ${receipt.gasUsed}`);
  console.log(`  ${tokenInArg} spent:   ${formatUnits(spent, inDecimals)}`);
  console.log(
    `  ${tokenOutArg} received: ${formatUnits(received, outDecimals)}`,
  );
  console.log(`  Tx hash:      ${cookHash}`);
  console.log("");
}

main().catch((e) => {
  console.error("\nRecipe failed:", e.message ?? e);
  process.exit(1);
});
