/**
 * One-time capture of the REAL INTEGRAL SIZE (TwapRelayer) quote/sell contract GRAPH from Ethereum
 * mainnet, so the SIZE prod-mirror EVM test runs OFFLINE (no fork, no RPC at run time). MANDATORY
 * for this family: the WINDOW logic (TR03/TR3A on the OUT amount, enforced at quote AND at exec) is
 * the integration risk, and only the genuine relayer + its REAL TWAP-oracle graph (ITwapPair →
 * TwapOracle → the Uniswap-V3 pool's observe()) can prove it against production rounding.
 *
 * Emits the SAME FERMI-SHAPED SNAPSHOT as harness/metric-snapshot.ts (fermiSwapper = the RELAYER,
 * vault = the RELAYER — it holds every pair's payout inventory itself), so the prod-mirror test
 * reuses the fermi harness verbatim (loadFermiSnapshots / verifyFermiBytecodeIntegrity /
 * pinFermiBlockTimestamp / etchFermiGraph), plus SIZE extras (the TwapDelay address the sell
 * forwards input to, the relayer's ETH balance funding its hedge prepay, and the window reads).
 *
 * ── CAPTURE TECHNIQUE — anvil-fork prestateTracer (NOT the metric access-list capture) ─────────────
 * sell() PULLS the input FIRST (transferIn → the TwapDelay) and only then walks the payout + hedge
 * path, so an unfunded eth_createAccessList capture would revert at the pull and MISS the whole
 * tail (TwapDelay.relayerSell + its Orders storage + the payout). Instead this script boots its own
 * anvil fork pinned at the capture block, funds + approves a probe EOA with REAL txs, and runs
 * debug_traceCall with the PRESTATE tracer over the full surface — quote ladders BOTH directions,
 * quoteBuy window conversions, the config reads, and sell() BOTH directions — capturing EVERY
 * touched account + storage slot on the COMPLETE path (debug_traceCall commits nothing, so the
 * pinned state stays clean; the only committed txs touch the tokens, which the harness repoints).
 *
 * ── THE CAPTURED GRAPH ──────────────────────────────────────────────────────────────────────────────
 *   the RELAYER proxy + implementation (quoteSell/quoteBuy/sell + the window config),
 *   the TwapFactory + the WETH/USDC + WETH/USDT ITwapPairs (oracle()/swapFee),
 *   the TwapOracleV3s + their configured Uniswap-V3 pools (getAveragePrice → observe()),
 *   the TwapDelay (relayerSell — the hedge enqueue the sell finishes with) + its gas/Orders config,
 *   plus the tokens (repointed to local MintableERC20s by the harness; the RELAYER's captured
 *   token balances are re-funded so checkLimits' balanceOf(relayer) caps reproduce exactly).
 *
 * ── block.timestamp ─────────────────────────────────────────────────────────────────────────────────
 * The TWAP read interpolates observe() around block.timestamp and Orders checks the deadline
 * against it, so the harness pins the anvil clock to the capture instant (pinFermiBlockTimestamp)
 * — reproducing the exact capture-block quotes deterministically.
 *
 * Re-capture (REQUIRED whenever the recipe's touched-contract set changes):
 *   set -a; . sdk/.env; set +a
 *   npx tsx src/recipes/test/harness/size-snapshot.ts
 * Optional argv[2] = RPC url (else ETH_RPC_URL), argv[3] = an explicit block to pin (else head).
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  parseAbi,
  getAddress,
  encodeFunctionData,
  keccak256,
  encodeAbiParameters,
  pad,
  toHex,
  type Hex,
  type Address,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "eth-size-WETHUSDC";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The REAL Ethereum SIZE stack (VERIFIED source; see shared/size-math.ts for the probe record).
// SECOND is WETH→USDT, NOT WETH→USDC: at capture (block ~25.46M) the relayer's USDC inventory
// (~3207e6) sits BELOW getTokenLimitMin(USDC) (5000e6), so the WETH→USDC OUT-window is EMPTY —
// every quote reverts (TR03 below the min, TR3A above the inventory cap, and the two bounds have
// CROSSED). That live state is itself captured as `sizeWindow.closed` ground truth (the
// closed-window discovery-drop cell); the quotable second direction exercises the OTHER real pair
// (WETH/USDT) on the SAME single-inventory relayer — the multi-pair claim-scope evidence.
const RELAYER = getAddress("0xd17b3c9784510E33cD5B87b490E79253BcD81e2E") as Address;
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2") as Address;
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") as Address;
const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7") as Address;
const TARGET = { tokenIn: USDC, tokenOut: WETH, inSym: "USDC", outSym: "WETH" };
const SECOND = { tokenIn: WETH, tokenOut: USDT, inSym: "WETH", outSym: "USDT" };
const PORT = 8571;

const RPC = process.argv[2] || process.env.ETH_RPC_URL || process.env.ETHEREUM_RPC_URL || "";
const PIN_BLOCK_ARG = process.argv[3] ? BigInt(process.argv[3]) : null;
if (!RPC) {
  console.error("no RPC — pass one as argv[2] or set ETH_RPC_URL (set -a; . sdk/.env; set +a)");
  process.exit(1);
}

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const relayerAbi = parseAbi([
  "function quoteSell(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 amountOut)",
  "function quoteBuy(address tokenIn, address tokenOut, uint256 amountOut) view returns (uint256 amountIn)",
  "function getTokenLimitMin(address token) view returns (uint256)",
  "function getTokenLimitMaxMultiplier(address token) view returns (uint256)",
  "function factory() view returns (address)",
  "function delay() view returns (address)",
  "function isPairEnabled(address pair) view returns (bool)",
  "function swapFee(address pair) view returns (uint256)",
  "function sell((address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, bool wrapUnwrap, address to, uint32 submitDeadline) p) payable returns (uint256 orderId)",
]);
const factoryAbi = parseAbi(["function getPair(address, address) view returns (address)"]);

const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

async function main() {
  const remote = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await remote.getChainId();
  if (chainId !== 1) console.warn(`[size-snapshot] WARNING: chainId ${chainId} != Ethereum (1)`);
  const pinBlock = PIN_BLOCK_ARG ?? (await remote.getBlockNumber());
  const blk = await remote.getBlock({ blockNumber: pinBlock });
  const blockTimestamp = blk.timestamp;
  console.log(`[size-snapshot] pinned block=${pinBlock} timestamp=${blockTimestamp}`);

  // ── Boot the capture fork pinned at the block; pin its clock to the capture instant. ──
  const anvil = spawn("anvil", [
    "--fork-url", RPC, "--fork-block-number", pinBlock.toString(), "--port", String(PORT),
    "--no-request-size-limit",
  ], { stdio: "ignore" });
  const FORK_URL = `http://127.0.0.1:${PORT}`;
  const fork = createPublicClient({ transport: http(FORK_URL, { timeout: 120_000 }) });
  const test = createTestClient({ mode: "anvil", transport: http(FORK_URL) });
  const eoa = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const wallet = createWalletClient({ account: eoa, transport: http(FORK_URL) });
  for (let i = 0; i < 60; i++) {
    try { await fork.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  try {
    await test.request({ method: "anvil_setTime" as never, params: [Number(blockTimestamp)] as never } as never);
    await test.setBlockTimestampInterval({ interval: 0 });
    await test.mine({ blocks: 1 });

    // ── The window + graph reads at the pin. ──
    const rd = async <T>(fn: string, args: unknown[] = []): Promise<T> =>
      (await fork.readContract({ address: RELAYER, abi: relayerAbi as Abi, functionName: fn, args })) as T;
    const factory = getAddress(await rd<Address>("factory")) as Address;
    const delay = getAddress(await rd<Address>("delay")) as Address;
    const minWeth = await rd<bigint>("getTokenLimitMin", [WETH]);
    const minUsdc = await rd<bigint>("getTokenLimitMin", [USDC]);
    const minUsdt = await rd<bigint>("getTokenLimitMin", [USDT]);
    const maxMult = await rd<bigint>("getTokenLimitMaxMultiplier", [WETH]);
    const pair = (await fork.readContract({ address: factory, abi: factoryAbi as Abi, functionName: "getPair", args: [WETH, USDC] })) as Address;
    const swapFee = await rd<bigint>("swapFee", [pair]);
    const pair2 = (await fork.readContract({ address: factory, abi: factoryAbi as Abi, functionName: "getPair", args: [WETH, USDT] })) as Address;
    const swapFee2 = await rd<bigint>("swapFee", [pair2]);
    const minInUsdcToWeth = await rd<bigint>("quoteBuy", [USDC, WETH, minWeth]);
    const minInWethToUsdt = await rd<bigint>("quoteBuy", [WETH, USDT, minUsdt]);
    // The CLOSED direction (WETH→USDC): quoteBuy(minOut) REVERTS when the inventory cap sits below
    // the out-min — captured probe-then-decode as the closed-window ground truth (discovery drops it).
    const closedWethToUsdc = await rd<bigint>("quoteBuy", [WETH, USDC, minUsdc]).then(
      (v) => `OPEN:minIn=${v}`,
      (e) => `REVERT:${(String((e as Error).message ?? e).match(/TR[0-9A-Z]{2}/) ?? ["?"])[0]}`,
    );
    const relayerWeth = (await fork.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [RELAYER] })) as bigint;
    const relayerUsdc = (await fork.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [RELAYER] })) as bigint;
    const relayerUsdt = (await fork.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [RELAYER] })) as bigint;
    const relayerEth = await fork.getBalance({ address: RELAYER });
    console.log(
      `[size-snapshot] window: minOut WETH=${minWeth} USDC=${minUsdc} USDT=${minUsdt} maxMult=${maxMult}; ` +
        `minIn USDC→WETH=${minInUsdcToWeth} WETH→USDT=${minInWethToUsdt}; WETH→USDC ${closedWethToUsdc}; ` +
        `inventory WETH=${relayerWeth} USDC=${relayerUsdc} USDT=${relayerUsdt} ETH=${relayerEth}; ` +
        `pair=${pair} swapFee=${swapFee} pair2=${pair2} swapFee2=${swapFee2} delay=${delay}`,
    );

    // ── Fund + approve the probe EOA (REAL txs on the fork; tokens are repointed at etch time so
    //    the committed token-slot changes never reach the snapshot's slot capture for tokens). ──
    await test.setBalance({ address: eoa.address, value: 10n ** 21n });
    // USDC balance slot (FiatToken slot 9 — verified) + WETH balance slot (slot 3).
    const usdcSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [eoa.address, 9n]));
    await test.setStorageAt({ address: USDC, index: usdcSlot, value: pad(toHex(10n ** 12n), { size: 32 }) });
    const wethSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [eoa.address, 3n]));
    await test.setStorageAt({ address: WETH, index: wethSlot, value: pad(toHex(10n ** 22n), { size: 32 }) });
    for (const t of [USDC, WETH]) {
      const hash = await wallet.writeContract({
        address: t, abi: erc20Abi as Abi, functionName: "approve", args: [RELAYER, (1n << 160n)], chain: null,
      });
      await fork.waitForTransactionReceipt({ hash });
    }
    // Re-pin the clock (the funding txs mined blocks).
    await test.request({ method: "anvil_setTime" as never, params: [Number(blockTimestamp)] as never } as never);
    await test.mine({ blocks: 1 });

    // ── prestateTracer over the FULL surface; union every touched account + slot key. ──
    const touched = new Map<string, Set<string>>();
    const trace = async (to: Address, data: Hex, from: Address, label: string) => {
      const res = await fetch(FORK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "debug_traceCall",
          params: [{ to, data, from }, "latest", { tracer: "prestateTracer" }],
        }),
      });
      const body = (await res.json()) as { result?: Record<string, { storage?: Record<string, Hex> }>; error?: { message: string } };
      if (!body.result) { console.warn(`[size-snapshot]   trace ${label}: ${body.error?.message ?? "no result"}`); return; }
      for (const [addr, acct] of Object.entries(body.result)) {
        const key = addr.toLowerCase();
        if (!touched.has(key)) touched.set(key, new Set());
        const set = touched.get(key)!;
        for (const slot of Object.keys(acct.storage ?? {})) set.add(slot.toLowerCase());
      }
    };
    const enc = (fn: string, args: unknown[]): Hex => encodeFunctionData({ abi: relayerAbi as Abi, functionName: fn, args });

    // Quote ladders BOTH directions across the in-window range (min → near-cap), quoteBuy, config.
    const ladderSizes = (minIn: bigint): bigint[] => {
      const out: bigint[] = [];
      for (const m of [100n, 105n, 125n, 150n, 200n, 300n, 400n, 600n, 800n, 1200n, 1600n, 2400n, 3200n, 4800n, 6400n, 9600n]) {
        out.push((minIn * m) / 100n);
      }
      return out;
    };
    for (const amt of ladderSizes(minInUsdcToWeth)) await trace(RELAYER, enc("quoteSell", [USDC, WETH, amt]), eoa.address, `qs U→W ${amt}`);
    for (const amt of ladderSizes(minInWethToUsdt)) await trace(RELAYER, enc("quoteSell", [WETH, USDT, amt]), eoa.address, `qs W→T ${amt}`);
    // The CLOSED direction's revert paths (TR03 + TR3A) — captured so the prod-mirror reproduces them.
    await trace(RELAYER, enc("quoteSell", [WETH, USDC, 2n * 10n ** 18n]), eoa.address, "qs W→U closed TR03");
    await trace(RELAYER, enc("quoteSell", [WETH, USDC, 5n * 10n ** 18n]), eoa.address, "qs W→U closed TR3A");
    await trace(RELAYER, enc("quoteBuy", [USDC, WETH, minWeth]), eoa.address, "qb U→W min");
    await trace(RELAYER, enc("quoteBuy", [WETH, USDT, minUsdt]), eoa.address, "qb W→T min");
    await trace(RELAYER, enc("quoteBuy", [WETH, USDC, minUsdc]), eoa.address, "qb W→U min (closed)");
    for (const t of [WETH, USDC, USDT]) {
      await trace(RELAYER, enc("getTokenLimitMin", [t]), eoa.address, "limitMin");
      await trace(RELAYER, enc("getTokenLimitMaxMultiplier", [t]), eoa.address, "limitMax");
    }
    await trace(RELAYER, enc("factory", []), eoa.address, "factory");
    await trace(RELAYER, enc("delay", []), eoa.address, "delay");
    await trace(factory, encodeFunctionData({ abi: factoryAbi as Abi, functionName: "getPair", args: [WETH, USDC] }), eoa.address, "getPair");
    await trace(factory, encodeFunctionData({ abi: factoryAbi as Abi, functionName: "getPair", args: [WETH, USDT] }), eoa.address, "getPair2");
    await trace(RELAYER, enc("isPairEnabled", [pair]), eoa.address, "isPairEnabled");
    await trace(RELAYER, enc("swapFee", [pair]), eoa.address, "swapFee");
    await trace(RELAYER, enc("isPairEnabled", [pair2]), eoa.address, "isPairEnabled2");
    await trace(RELAYER, enc("swapFee", [pair2]), eoa.address, "swapFee2");
    // sell() BOTH quotable directions — the funded/approved EOA walks transferIn→payout→TwapDelay.relayerSell.
    const deadline = Number(blockTimestamp) + 3600;
    await trace(
      RELAYER,
      enc("sell", [{ tokenIn: USDC, tokenOut: WETH, amountIn: (minInUsdcToWeth * 3n) / 2n, amountOutMin: 0n, wrapUnwrap: false, to: eoa.address, submitDeadline: deadline }]),
      eoa.address, "sell U→W",
    );
    await trace(
      RELAYER,
      enc("sell", [{ tokenIn: WETH, tokenOut: USDT, amountIn: (minInWethToUsdt * 3n) / 2n, amountOutMin: 0n, wrapUnwrap: false, to: eoa.address, submitDeadline: deadline }]),
      eoa.address, "sell W→T",
    );
    for (const must of [RELAYER, factory, pair, pair2, delay]) {
      const key = must.toLowerCase();
      if (!touched.has(key)) touched.set(key, new Set());
    }

    // ── Capture code + slot VALUES for every touched contract (debug_traceCall committed nothing,
    //    so `latest` still reflects the pinned mainnet state for all non-token contracts). ──
    const TOKENS = new Set([WETH.toLowerCase(), USDC.toLowerCase(), USDT.toLowerCase()]);
    const contracts: { address: Address; role: string; runtime: string; runtimeSha256: Hex; codeSizeBytes: number; slots: Record<string, Hex> }[] = [];
    for (const [addrLc, slotSet] of [...touched.entries()].sort()) {
      const address = getAddress(addrLc) as Address;
      if (address.toLowerCase() === eoa.address.toLowerCase()) continue;
      const code = await fork.getCode({ address });
      const runtime = code ?? "0x";
      if (runtime === "0x" && slotSet.size === 0) continue; // plain balance-touched EOAs
      const role =
        addrLc === RELAYER.toLowerCase() ? "TwapRelayer proxy (quoteSell/quoteBuy/sell + the out-window)" :
        addrLc === factory.toLowerCase() ? "TwapFactory (getPair)" :
        addrLc === pair.toLowerCase() ? "ITwapPair WETH/USDC (oracle()/swapFee source)" :
        addrLc === pair2.toLowerCase() ? "ITwapPair WETH/USDT (oracle()/swapFee source)" :
        addrLc === delay.toLowerCase() ? "TwapDelay (relayerSell hedge enqueue — the sell()'s input sink)" :
        TOKENS.has(addrLc) ? "token (repointed by harness)" :
        "oracle-dependency (TwapOracle / Uniswap-V3 pool / relayer impl)";
      const slots: Record<string, Hex> = {};
      for (const slot of [...slotSet].sort()) {
        const v = await fork.getStorageAt({ address, slot: slot as Hex });
        slots[slot] = (v ?? ("0x" + "0".repeat(64))) as Hex;
      }
      contracts.push({ address, role, runtime, runtimeSha256: sha256(runtime), codeSizeBytes: runtime === "0x" ? 0 : runtime.length / 2 - 1, slots });
      console.log(`[size-snapshot]  touched ${address} [${role}] code=${runtime === "0x" ? 0 : runtime.length / 2 - 1}B slots=${Object.keys(slots).length}`);
    }

    // ── Ground-truth probe ladders BOTH directions at the pinned clock (in- AND out-of-window). ──
    const quoteAt = async (tin: Address, tout: Address, amt: bigint): Promise<string> => {
      try {
        return ((await fork.readContract({ address: RELAYER, abi: relayerAbi as Abi, functionName: "quoteSell", args: [tin, tout, amt] })) as bigint).toString();
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        const m = msg.match(/TR[0-9A-Z]{2}/);
        return `REVERT:${m ? m[0] : "?"}`;
      }
    };
    const ladder = async (tin: Address, tout: Address, minIn: bigint) => {
      const pts: { amountIn: string; amountOut: string }[] = [];
      for (const amt of [minIn / 2n, minIn - 10n ** 6n, minIn, (minIn * 3n) / 2n, minIn * 2n, minIn * 4n, minIn * 8n, minIn * 1000n]) {
        if (amt <= 0n) continue;
        pts.push({ amountIn: amt.toString(), amountOut: await quoteAt(tin, tout, amt) });
      }
      return pts;
    };
    const fwdLadder = await ladder(USDC, WETH, minInUsdcToWeth);
    const revLadder = await ladder(WETH, USDT, minInWethToUsdt);
    // The CLOSED direction's ground truth: BOTH domain ends revert (the crossed window).
    const closedLadder: { amountIn: string; amountOut: string }[] = [];
    for (const amt of [2n * 10n ** 18n, 5n * 10n ** 18n]) {
      closedLadder.push({ amountIn: amt.toString(), amountOut: await quoteAt(WETH, USDC, amt) });
    }

    const meta = async (t: Address) => ({
      address: t,
      symbol: (await fork.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => "?")) as string,
      decimals: Number(await fork.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }).catch(() => 18)),
    });

    const bytecodeSnap = {
      chain: "ethereum",
      fermiSwapper: RELAYER,
      block: pinBlock.toString(),
      blockTimestamp: blockTimestamp.toString(),
      note:
        "INTEGRAL SIZE (TwapRelayer — VERIFIED source; the WINDOW logic is the tested risk). FERMI-SHAPED " +
        "snapshot (fermiSwapper = vault = the RELAYER, which holds every pair's payout inventory) so the fermi " +
        "harness is reused verbatim. Captured via anvil-fork prestateTracer over quote ladders + quoteBuy + " +
        "sell() BOTH directions (the sell tail — TwapDelay.relayerSell — is only reachable with a funded, " +
        "approved caller, which access-list capture cannot express). The TWAP path reads the Uniswap-V3 pool's " +
        "observe() around block.timestamp — the harness MUST pin the clock to blockTimestamp before any " +
        "quote/cook. The relayer needs its captured ETH balance (sizeRelayerEth) for the hedge prepay.",
      contracts: contracts
        .map((cc) => ({ address: cc.address, role: cc.role, runtime: cc.runtime, runtimeSha256: cc.runtimeSha256, codeSizeBytes: cc.codeSizeBytes }))
        .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)),
    };
    writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

    const stateSnap = {
      chain: "ethereum",
      fermiSwapper: RELAYER,
      block: pinBlock.toString(),
      blockTimestamp: blockTimestamp.toString(),
      staleUpdateSelector: "TR03/TR3A (out-window string reverts — informational)",
      target: { ...TARGET },
      second: { ...SECOND },
      tokens: { WETH: await meta(WETH), USDC: await meta(USDC), USDT: await meta(USDT) },
      tokenBalanceSlots: {},
      contractSlots: Object.fromEntries(contracts.map((cc) => [cc.address, { role: cc.role, slots: cc.slots }])),
      vault: {
        address: RELAYER,
        role:
          "the RELAYER ITSELF (single-contract multi-pair inventory): checkLimits caps on balanceOf(relayer) " +
          "and the sell pays out of it — the harness re-funds the captured balances so the window reproduces.",
        reserves: { WETH: relayerWeth.toString(), USDC: relayerUsdc.toString(), USDT: relayerUsdt.toString() },
        allowanceToRouter: { WETH: "0", USDC: "0", USDT: "0" },
      },
      eoa7702: null,
      sizeDelay: delay,
      sizeRelayerEth: relayerEth.toString(),
      sizeWindow: {
        maxMultiplier: maxMult.toString(),
        minOut: { WETH: minWeth.toString(), USDC: minUsdc.toString(), USDT: minUsdt.toString() },
        minInTarget: minInUsdcToWeth.toString(),
        minInSecond: minInWethToUsdt.toString(),
        pairTarget: pair,
        pairSecond: pair2,
        swapFeeTarget: swapFee.toString(),
        swapFeeSecond: swapFee2.toString(),
        closed: {
          tokenIn: "WETH",
          tokenOut: "USDC",
          evidence: closedWethToUsdc,
          reason:
            "relayer USDC inventory below getTokenLimitMin(USDC) at the pin — the OUT-window bounds have " +
            "crossed (min > cap): EVERY WETH→USDC quote reverts (TR03 low / TR3A high) and quoteBuy(minOut) " +
            "reverts too, so discovery drops the direction (probe-then-decode).",
          ladder: closedLadder,
        },
      },
      probe: {
        target: { pair: `${TARGET.inSym}/${TARGET.outSym}`, ladder: fwdLadder },
        second: { pair: `${SECOND.inSym}/${SECOND.outSym}`, ladder: revLadder },
      },
    };
    writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));
    console.log(`[size-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
    console.log(`[size-snapshot] ${contracts.length} contracts; pinned block ${pinBlock} (ts ${blockTimestamp})`);
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
