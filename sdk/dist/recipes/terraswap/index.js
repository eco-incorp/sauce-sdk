/**
 * TerraSwap recipe — cross-chain parallel swap orchestrator.
 *
 * Executes an iterative series of swaps across multiple chains with a single
 * global price limit. Each series refines execution quality:
 *
 *   Series 1: pre-computed splits + global price limit → parallel TXs
 *   Series 2: depth-weighted re-split from series 1 + new price limit → parallel TXs
 *   Series 3: final sweep with no price limit (if leftovers remain) → parallel TXs
 */
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, decodeEventLog, defineChain, } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import ts from "typescript";
import { prepareTerraSwap, prepareNextSeries } from "./prepare.js";
import { MULTICALL3 } from "../shared/constants.js";
const require = createRequire(import.meta.url);
const { compile } = require("@eco-incorp/sauce-compiler");
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const MAX_SERIES = 3;
const DUST_THRESHOLD = 1000n; // negligible leftover (in wei)
// ── ABIs ─────────────────────────────────────────────────────
const erc20Abi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
]);
const sauceAbi = parseAbi([
    "function cook(bytes[] memory calls) public payable returns (bytes memory)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
// ── Helpers ──────────────────────────────────────────────────
function toHex(bytes) {
    return ("0x" + Buffer.from(bytes).toString("hex"));
}
function stripTypes(source) {
    return ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
}
function buildDirectPoolTuple(dp) {
    return [
        BigInt(dp.pool.poolType),
        BigInt(dp.pool.address),
        BigInt(dp.pool.fee),
        0n, // tickSpacing
        0n, // hooks
        dp.splitAmount,
    ];
}
function buildMultiHopTuple(mr) {
    return [
        BigInt(mr.route.intermediateToken),
        BigInt(mr.route.hop1Pool.poolType),
        BigInt(mr.route.hop1Pool.address),
        BigInt(mr.route.hop1Pool.fee),
        0n,
        0n,
        BigInt(mr.route.hop2Pool.poolType),
        BigInt(mr.route.hop2Pool.address),
        BigInt(mr.route.hop2Pool.fee),
        0n,
        0n,
        mr.splitAmount,
    ];
}
// ── Compile a single series for one chain ────────────────────
function compileSwapSeries(tokenIn, tokenOut, amountIn, caller, priceLimitedPools, noLimitPools, multiHopRoutes, globalPriceLimit, isFirstSeries) {
    const source = readFileSync(join(__dirname, "swap-series.sauce.ts"), "utf-8");
    const jsSource = stripTypes(source);
    const result = compile(jsSource, {
        baseDir: REPO_ROOT,
        args: [
            tokenIn,
            tokenOut,
            amountIn,
            caller,
            priceLimitedPools.map(buildDirectPoolTuple),
            noLimitPools.map(buildDirectPoolTuple),
            multiHopRoutes.map(buildMultiHopTuple),
            globalPriceLimit,
            isFirstSeries ? 1n : 0n,
        ],
    });
    return result.bytecodes.map(toHex);
}
async function setupChainClients(rpcUrl, name, privateKey) {
    const transport = http(rpcUrl, { timeout: 120_000 });
    const tempClient = createPublicClient({ transport });
    const chainId = await tempClient.getChainId();
    const chainDef = defineChain({
        id: chainId,
        name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
        contracts: { multicall3: { address: MULTICALL3 } },
    });
    const account = privateKeyToAccount(privateKey);
    const publicClient = createPublicClient({ chain: chainDef, transport });
    const walletClient = createWalletClient({ account, chain: chainDef, transport });
    return { chainDef, account, publicClient, walletClient };
}
// ── Main orchestrator ────────────────────────────────────────
export async function terraSwap(config, privateKey) {
    console.log(`\n=== TerraSwap: ${config.chains.length} chains ===\n`);
    // Set up per-chain clients
    const clientsMap = new Map();
    for (const chain of config.chains) {
        clientsMap.set(chain.name, await setupChainClients(chain.rpcUrl, chain.name, privateKey));
    }
    const caller = privateKeyToAccount(privateKey).address;
    // Initial preparation
    let prepared = await prepareTerraSwap(config);
    const allSeries = [];
    let totalReceived = 0n;
    let totalGas = 0n;
    for (let seriesNum = 1; seriesNum <= MAX_SERIES; seriesNum++) {
        const isLastSeries = seriesNum === MAX_SERIES;
        const priceLimit = isLastSeries ? 0n : prepared.globalPriceLimit;
        if (prepared.chains.length === 0)
            break;
        console.log(`\n── Series ${seriesNum} (${isLastSeries ? "final sweep" : `priceLimit=${priceLimit}`}) ──`);
        // Compile + execute on all chains in parallel
        const chainResults = await Promise.all(prepared.chains.map(async (chain) => {
            const clients = clientsMap.get(chain.config.name);
            const { publicClient, walletClient, account, chainDef } = clients;
            const { tokenIn, tokenOut, amountIn, sauceRouterAddress } = chain.config;
            // Approve
            const approveHash = await walletClient.writeContract({
                address: tokenIn,
                abi: erc20Abi,
                functionName: "approve",
                args: [sauceRouterAddress, amountIn],
                chain: chainDef,
                account,
            });
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            // Compile
            const bytecodes = compileSwapSeries(tokenIn, tokenOut, amountIn, caller, chain.priceLimitedPools, chain.noLimitPools, chain.multiHopRoutes, priceLimit, seriesNum === 1);
            // Snapshot tokenIn balance before cook
            const balBefore = (await publicClient.readContract({
                address: tokenIn,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [account.address],
            }));
            // Execute cook()
            console.log(`  [${chain.config.name}] cooking (${bytecodes.length} segments)...`);
            const cookHash = await walletClient.writeContract({
                address: sauceRouterAddress,
                abi: sauceAbi,
                functionName: "cook",
                args: [bytecodes],
                chain: chainDef,
                account,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: cookHash });
            // Snapshot tokenIn balance after cook
            const balAfter = (await publicClient.readContract({
                address: tokenIn,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [account.address],
            }));
            // leftover = tokens returned by the SauceScript
            // balAfter = balBefore - amountIn + leftover → leftover = balAfter - balBefore + amountIn
            const leftover = balAfter - balBefore + amountIn;
            // Parse received tokenOut from Transfer events
            let received = 0n;
            const sauceLower = sauceRouterAddress.toLowerCase();
            for (const log of receipt.logs) {
                try {
                    const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
                    if (decoded.eventName !== "Transfer")
                        continue;
                    const { to, value } = decoded.args;
                    if (log.address.toLowerCase() === tokenOut.toLowerCase() &&
                        to.toLowerCase() === account.address.toLowerCase()) {
                        received += value;
                    }
                }
                catch { }
            }
            console.log(`  [${chain.config.name}] gas=${receipt.gasUsed} received=${received} leftover=${leftover}`);
            return {
                chainName: chain.config.name,
                txHash: cookHash,
                gasUsed: receipt.gasUsed,
                leftover,
                received,
            };
        }));
        allSeries.push({ seriesNumber: seriesNum, priceLimit, chainResults });
        totalReceived += chainResults.reduce((sum, r) => sum + r.received, 0n);
        totalGas += chainResults.reduce((sum, r) => sum + r.gasUsed, 0n);
        // Check total leftover across all chains
        const totalLeftover = chainResults.reduce((sum, r) => sum + r.leftover, 0n);
        if (totalLeftover <= DUST_THRESHOLD) {
            console.log(`  Total leftover ${totalLeftover} <= dust threshold, done.`);
            break;
        }
        if (isLastSeries) {
            console.log(`  Max series reached. Remaining leftover: ${totalLeftover}`);
            break;
        }
        // Prepare next series from post-swap pool states
        const leftovers = new Map();
        for (const r of chainResults) {
            if (r.leftover > DUST_THRESHOLD) {
                leftovers.set(r.chainName, r.leftover);
            }
        }
        console.log(`  Preparing series ${seriesNum + 1} for ${leftovers.size} chains with leftovers...`);
        prepared = await prepareNextSeries(prepared.chains, leftovers);
    }
    console.log(`\n=== TerraSwap complete: ${allSeries.length} series, totalReceived=${totalReceived}, totalGas=${totalGas} ===\n`);
    return { series: allSeries, totalReceived, totalGas };
}
//# sourceMappingURL=index.js.map