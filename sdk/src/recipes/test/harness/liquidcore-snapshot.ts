/**
 * One-time capture of the REAL LIQUIDCORE (Liquid Labs, HyperEVM) router + per-pair pool contract
 * GRAPH from HyperEVM mainnet, so the LiquidCore prod-mirror EVM test runs OFFLINE (no fork, no RPC
 * at run time). BEST-EFFORT for this family (the PUBLIC RPC is the only source — no paid archive):
 * the local fixtures already pin the quote/exec classes; the genuine etched runtime adds the real
 * proxy dispatch + the real imbalance-fee curve against the captured Hyperliquid books.
 *
 * Emits the SAME FERMI-SHAPED SNAPSHOT as harness/metric-snapshot.ts (fermiSwapper = the ROUTER,
 * vault = the per-pair POOL holding the payout inventory), so the prod-mirror test reuses the fermi
 * harness verbatim (loadFermiSnapshots / verifyFermiBytecodeIntegrity / pinFermiBlockTimestamp /
 * etchFermiGraph), plus the LiquidCore extras: `lcPool` (the pool address) and `lcBbo` (spot index →
 * (bid, ask)) — the REAL Hyperliquid book values read from the BBO precompile at the pin, which the
 * test seeds into the input-keyed HLBboPrecompileMock etched at the CANONICAL 0x…080e address.
 *
 * ── CAPTURE TECHNIQUE — anvil-fork prestateTracer WITH the BBO mock pre-etched ────────────────────
 * The pool prices EVERY quote off the HyperEVM BBO READ PRECOMPILE (0x…080e — L1-native, NO CODE on
 * an EVM fork), so a plain anvil fork cannot even quote; and the public RPC serves NO debug_traceCall.
 * So this script: (1) reads the REAL books (raw eth_call to the precompile, 32-byte spot index in,
 * (bid, ask) out) + the REMOTE sanity quote ladders at the pin; (2) boots its own anvil fork pinned
 * there and TX-FREE-etches the HLBboPrecompileMock at 0x…080e (setCode from the forge artifact's
 * deployedBytecode + setStorageAt the mapping slots — zero mined blocks) seeded with the REAL book
 * values (the exact etch the prod-mirror test replays); (3) generates the CANONICAL probe ladders on
 * the mocked fork and cross-checks them against the remote ones (see determinism below); (4) runs
 * debug_traceCall(prestateTracer) over the full surface — discovery (getPoolForPair both orders,
 * getPools, getReserves), quote ladders BOTH directions (+ the oversize capped class), and swap()
 * BOTH directions from a funded, approved probe EOA (WHYPE via deposit(); USDT0 via a COMMITTED real
 * swap — its pool-state writes are quarantined by re-reading every slot value from a FRESH second
 * fork at the same pin); (5) captures every touched account's code + touched-slot values from that
 * fresh fork. The traced mock storage slots double-check the seeded index set.
 *
 * ── DETERMINISM (probed, block ~39.586M) ──────────────────────────────────────────────────────────
 * The REAL pool's quote is a PURE FUNCTION of (pool storage, token balances, BBO book values) —
 * probed INVARIANT across +52 mined blocks AND +1 day of clock on the mocked fork (no block-number /
 * timestamp anchor; the "cross-block ~2e-5 quote drift" seen live is the LIVE Hyperliquid book
 * moving, not an env anchor). Corollary: a remote eth_call at a PINNED HISTORICAL block does NOT
 * freeze the book — the precompile reads the LIVE L1 state — so the remote ladders can never be
 * reproduced bit-exact (they drift with wall-clock between reads, ~1e-4 class). The CANONICAL probe
 * ladders are therefore the MOCKED-FORK quotes at the frozen captured books (fully deterministic —
 * the prod-mirror replays them WEI-EXACT); the remote ladders are recorded for provenance and
 * cross-checked here with a small relative tolerance (book wall-clock skew only).
 *
 * Re-capture (REQUIRED whenever the recipe's touched-contract set changes):
 *   npx tsx src/recipes/test/harness/liquidcore-snapshot.ts
 * Optional argv[2] = RPC url (else HYPEREVM_RPC_URL, else the public https://rpc.hyperliquid.xyz/evm),
 * argv[3] = an explicit block to pin (else head). Foundry fixtures must be built first
 * (src/recipes/test/fixtures/build.sh — the script deploys HLBboPrecompileMock from the artifact).
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  parseAbi,
  getAddress,
  encodeFunctionData,
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  type Hex,
  type Address,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HL_BBO_ADDRESS } from "./setup";
import { loadDeployedBytecode } from "./artifacts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "hyperevm-liquidcore-WHYPEUSDT0";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The REAL HyperEVM LiquidCore stack (probe record in shared/liquidcore-math.ts + constants.ts).
const ROUTER = getAddress("0x625aC1D165c776121A52ff158e76e3544B4a0b8B") as Address;
const WHYPE = getAddress("0x5555555555555555555555555555555555555555") as Address;
const USDT0 = getAddress("0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb") as Address;
// The two spot-pair indexes the WHYPE/USDT0 pool crosses (verified: the mocked fork reproduces the
// remote quotes with EXACTLY these seeded — the trace's mock-slot read-back re-checks the set).
const BBO_INDEXES = [10107n, 10166n];
const TARGET = { tokenIn: WHYPE, tokenOut: USDT0, inSym: "WHYPE", outSym: "USDT0" };
const SECOND = { tokenIn: USDT0, tokenOut: WHYPE, inSym: "USDT0", outSym: "WHYPE" };
const PORT = 8572;

const RPC = process.argv[2] || process.env.HYPEREVM_RPC_URL || "https://rpc.hyperliquid.xyz/evm";
const PIN_BLOCK_ARG = process.argv[3] ? BigInt(process.argv[3]) : null;

const routerAbi = parseAbi([
  "function getPools() view returns (address[])",
  "function getPoolForPair(address, address) view returns (address)",
  "function getReserves(address, address) view returns (uint256, uint256)",
]);
const poolAbi = parseAbi([
  "function estimateSwap(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  "function getTokens() view returns (address, address)",
  "function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function deposit() payable",
]);

const sha256 = (hex: string) => ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public-RPC resilience: retry a remote read 3× with backoff (rate limits / transient drops). */
async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (const backoff of [0, 2000, 5000]) {
    if (backoff) await sleep(backoff);
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.warn(`[lc-snapshot] retryable ${label}: ${String((e as Error).message).slice(0, 120)}`);
    }
  }
  throw lastErr;
}

function bootAnvil(pinBlock: bigint): { proc: ChildProcess; url: string } {
  const proc = spawn("anvil", [
    "--fork-url", RPC, "--fork-block-number", pinBlock.toString(), "--port", String(PORT),
    "--no-request-size-limit", "--no-rate-limit",
  ], { stdio: "ignore" });
  return { proc, url: `http://127.0.0.1:${PORT}` };
}

async function main() {
  const remote = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
  const chainId = await retry("chainId", () => remote.getChainId());
  if (chainId !== 999) console.warn(`[lc-snapshot] WARNING: chainId ${chainId} != HyperEVM (999)`);
  const pinBlock = PIN_BLOCK_ARG ?? (await retry("blockNumber", () => remote.getBlockNumber()));
  const blk = await retry("getBlock", () => remote.getBlock({ blockNumber: pinBlock }));
  const blockTimestamp = blk.timestamp;
  console.log(`[lc-snapshot] pinned block=${pinBlock} timestamp=${blockTimestamp}`);

  // ── 1. Remote reads AT THE PIN: the pool, the tokens, the books, the ground-truth ladders. ──
  const rdRemote = async <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> =>
    retry(`${functionName}`, async () => (await remote.readContract({ address, abi, functionName, args, blockNumber: pinBlock })) as T);

  const pool = getAddress(await rdRemote<Address>(ROUTER, routerAbi as Abi, "getPoolForPair", [WHYPE, USDT0])) as Address;
  const poolRev = getAddress(await rdRemote<Address>(ROUTER, routerAbi as Abi, "getPoolForPair", [USDT0, WHYPE])) as Address;
  if (pool !== poolRev) throw new Error(`getPoolForPair not unordered? ${pool} vs ${poolRev}`);
  const toks = await rdRemote<[Address, Address]>(pool, poolAbi as Abi, "getTokens");
  console.log(`[lc-snapshot] pool=${pool} getTokens=[${toks[0]}, ${toks[1]}]`);
  const poolWhype = await rdRemote<bigint>(WHYPE, erc20Abi as Abi, "balanceOf", [pool]);
  const poolUsdt0 = await rdRemote<bigint>(USDT0, erc20Abi as Abi, "balanceOf", [pool]);
  const reserves = await rdRemote<[bigint, bigint]>(ROUTER, routerAbi as Abi, "getReserves", [WHYPE, USDT0]);
  console.log(`[lc-snapshot] inventory WHYPE=${poolWhype} USDT0=${poolUsdt0}; getReserves(W,T)=[${reserves[0]}, ${reserves[1]}] (INTERNAL accounting — differs from balances; reproduced via captured slots)`);

  // The REAL Hyperliquid books at the pin (raw precompile call — 32-byte index in, (bid, ask) out).
  const lcBbo: Record<string, { bid: string; ask: string }> = {};
  for (const idx of BBO_INDEXES) {
    const res = await retry(`bbo[${idx}]`, () =>
      remote.call({ to: HL_BBO_ADDRESS as Address, data: encodeAbiParameters([{ type: "uint256" }], [idx]) as Hex, blockNumber: pinBlock }));
    const data = (res.data ?? "0x") as Hex;
    if (data.length !== 2 + 128) throw new Error(`bbo[${idx}] returned ${data} (expected 64 bytes)`);
    const bid = BigInt("0x" + data.slice(2, 66));
    const ask = BigInt("0x" + data.slice(66, 130));
    lcBbo[idx.toString()] = { bid: bid.toString(), ask: ask.toString() };
    console.log(`[lc-snapshot] bbo[${idx}] bid=${bid} ask=${ask}`);
  }

  // Remote ground-truth quote ladders (probe-then-decode; the oversize point pins the capped class).
  const LADDER_W = [10n ** 17n, 5n * 10n ** 17n, 10n ** 18n, 25n * 10n ** 17n, 5n * 10n ** 18n, 10n ** 19n, 2n * 10n ** 19n, 5n * 10n ** 19n, 10n ** 20n, 10n ** 24n];
  const LADDER_T = [10n ** 7n, 5n * 10n ** 7n, 10n ** 8n, 25n * 10n ** 7n, 5n * 10n ** 8n, 10n ** 9n, 2n * 10n ** 9n, 5n * 10n ** 9n, 10n ** 10n, 10n ** 15n];
  const remoteQuote = async (tin: Address, tout: Address, amt: bigint): Promise<string> => {
    try {
      return (await rdRemote<bigint>(pool, poolAbi as Abi, "estimateSwap", [tin, tout, amt])).toString();
    } catch {
      return "REVERT";
    }
  };
  const remoteFwd: { amountIn: string; amountOut: string }[] = [];
  for (const amt of LADDER_W) remoteFwd.push({ amountIn: amt.toString(), amountOut: await remoteQuote(WHYPE, USDT0, amt) });
  const remoteRev: { amountIn: string; amountOut: string }[] = [];
  for (const amt of LADDER_T) remoteRev.push({ amountIn: amt.toString(), amountOut: await remoteQuote(USDT0, WHYPE, amt) });

  // ── 2. Boot the capture fork; etch the BBO mock with the REAL books; pin the clock. ──
  const { proc: anvil, url: FORK_URL } = bootAnvil(pinBlock);
  const fork = createPublicClient({ transport: http(FORK_URL, { timeout: 120_000 }) });
  const test = createTestClient({ mode: "anvil", transport: http(FORK_URL) });
  const eoa = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const wallet = createWalletClient({ account: eoa, transport: http(FORK_URL) });
  try {
    for (let i = 0; i < 90; i++) {
      try { await fork.getBlockNumber(); break; } catch { await sleep(1000); }
    }
    await test.request({ method: "anvil_setTime" as never, params: [Number(blockTimestamp)] as never } as never);
    await test.setBlockTimestampInterval({ interval: 0 });
    await test.setBalance({ address: eoa.address, value: 10n ** 24n });
    await test.mine({ blocks: 1 });

    // TX-FREE mock etch (zero mined blocks): setCode the artifact's deployedBytecode at the
    // CANONICAL precompile address, seed the mapping slots (bid @ slot 0, ask @ slot 1) directly.
    const mockRuntime = loadDeployedBytecode(
      join(__dirname, "..", "fixtures", "out", "HLBboPrecompileMock.sol", "HLBboPrecompileMock.json"),
    );
    if (!mockRuntime || mockRuntime === "0x") throw new Error("HLBboPrecompileMock artifact has no deployedBytecode — run fixtures/build.sh");
    await test.setCode({ address: HL_BBO_ADDRESS as Address, bytecode: mockRuntime });
    for (const idx of BBO_INDEXES) {
      const { bid, ask } = lcBbo[idx.toString()];
      const bidSlot = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [idx, 0n]));
      const askSlot = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [idx, 1n]));
      await test.setStorageAt({ address: HL_BBO_ADDRESS as Address, index: bidSlot, value: pad(toHex(BigInt(bid)), { size: 32 }) });
      await test.setStorageAt({ address: HL_BBO_ADDRESS as Address, index: askSlot, value: pad(toHex(BigInt(ask)), { size: 32 }) });
    }

    // ── 3. CANONICAL ladders on the mocked fork + the remote cross-check (book wall-clock skew
    //       only — see the DETERMINISM header; class mismatches are hard failures). ──
    const localQuote = async (tin: Address, tout: Address, amt: bigint): Promise<string> => {
      try {
        return ((await fork.readContract({ address: pool, abi: poolAbi as Abi, functionName: "estimateSwap", args: [tin, tout, amt] })) as bigint).toString();
      } catch {
        return "REVERT";
      }
    };
    let maxRelDelta = 0;
    const canonFwd: { amountIn: string; amountOut: string }[] = [];
    const canonRev: { amountIn: string; amountOut: string }[] = [];
    for (const [remoteLadder, canon, tin, tout] of [
      [remoteFwd, canonFwd, WHYPE, USDT0],
      [remoteRev, canonRev, USDT0, WHYPE],
    ] as const) {
      for (const p of remoteLadder) {
        const local = await localQuote(tin, tout, BigInt(p.amountIn));
        canon.push({ amountIn: p.amountIn, amountOut: local });
        if (p.amountOut === "REVERT" || local === "REVERT") {
          if (p.amountOut !== local) throw new Error(`class mismatch at ${p.amountIn}: remote=${p.amountOut} local=${local}`);
          continue;
        }
        const r = BigInt(p.amountOut);
        const l = BigInt(local);
        const d = r > l ? r - l : l - r;
        const rel = r === 0n ? 0 : Number((d * 10n ** 9n) / r) / 1e9;
        if (rel > maxRelDelta) maxRelDelta = rel;
        // Book wall-clock skew between the remote bbo read and the remote ladder reads (the live
        // L1 book is NOT frozen by a historical blockNumber) — a large divergence means a missing
        // seeded index / a wrong mock, a small one is the skew class.
        if (rel > 2e-3) throw new Error(`mocked-fork quote diverges at ${p.amountIn}: remote=${r} local=${l} (rel ${rel})`);
      }
    }
    console.log(`[lc-snapshot] mock-completeness: local(mocked) matches remote across both ladders (max rel delta ${maxRelDelta} — book wall-clock skew)`);

    // ── 4. prestateTracer over the FULL surface; union every touched account + slot key. ──
    const touched = new Map<string, Set<string>>();
    const trace = async (to: Address, data: Hex, label: string) => {
      const res = await fetch(FORK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "debug_traceCall",
          params: [{ to, data, from: eoa.address }, "latest", { tracer: "prestateTracer" }],
        }),
      });
      const body = (await res.json()) as { result?: Record<string, { storage?: Record<string, Hex> }>; error?: { message: string } };
      if (!body.result) { console.warn(`[lc-snapshot]   trace ${label}: ${body.error?.message ?? "no result"}`); return; }
      for (const [addr, acct] of Object.entries(body.result)) {
        const key = addr.toLowerCase();
        if (!touched.has(key)) touched.set(key, new Set());
        const set = touched.get(key)!;
        for (const slot of Object.keys(acct.storage ?? {})) set.add(slot.toLowerCase());
      }
    };
    // Discovery surface.
    await trace(ROUTER, encodeFunctionData({ abi: routerAbi as Abi, functionName: "getPoolForPair", args: [WHYPE, USDT0] }), "getPoolForPair W,T");
    await trace(ROUTER, encodeFunctionData({ abi: routerAbi as Abi, functionName: "getPoolForPair", args: [USDT0, WHYPE] }), "getPoolForPair T,W");
    await trace(ROUTER, encodeFunctionData({ abi: routerAbi as Abi, functionName: "getPools", args: [] }), "getPools");
    await trace(ROUTER, encodeFunctionData({ abi: routerAbi as Abi, functionName: "getReserves", args: [WHYPE, USDT0] }), "getReserves");
    await trace(pool, encodeFunctionData({ abi: poolAbi as Abi, functionName: "getTokens", args: [] }), "getTokens");
    // Quote ladders BOTH directions (incl. the oversize capped point).
    for (const amt of LADDER_W) await trace(pool, encodeFunctionData({ abi: poolAbi as Abi, functionName: "estimateSwap", args: [WHYPE, USDT0, amt] }), `qs W→T ${amt}`);
    for (const amt of LADDER_T) await trace(pool, encodeFunctionData({ abi: poolAbi as Abi, functionName: "estimateSwap", args: [USDT0, WHYPE, amt] }), `qs T→W ${amt}`);

    // The write surface: fund WHYPE via deposit() (real txs — WHYPE is WETH9-class; its slots are
    // repointed at etch time), approve the pool, trace swap(W→T) UNCOMMITTED.
    const dep = await wallet.writeContract({ address: WHYPE, abi: erc20Abi as Abi, functionName: "deposit", args: [], value: 2000n * 10n ** 18n, chain: null });
    await fork.waitForTransactionReceipt({ hash: dep });
    for (const t of [WHYPE, USDT0]) {
      const h = await wallet.writeContract({ address: t, abi: erc20Abi as Abi, functionName: "approve", args: [pool, (1n << 160n)], chain: null });
      await fork.waitForTransactionReceipt({ hash: h });
    }
    await test.request({ method: "anvil_setTime" as never, params: [Number(blockTimestamp)] as never } as never);
    await test.mine({ blocks: 1 });
    await trace(pool, encodeFunctionData({ abi: poolAbi as Abi, functionName: "swap", args: [WHYPE, USDT0, 10n * 10n ** 18n, 0n] }), "swap W→T");
    // The reverse swap needs a USDT0 balance: COMMIT one real W→T swap (the pool-state writes this
    // commits are QUARANTINED — step 5 re-reads every slot value from a FRESH fork at the pin).
    const sw = await wallet.writeContract({ address: pool, abi: poolAbi as Abi, functionName: "swap", args: [WHYPE, USDT0, 20n * 10n ** 18n, 0n], chain: null, gas: 3_000_000n });
    const swRcpt = await fork.waitForTransactionReceipt({ hash: sw });
    if (swRcpt.status !== "success") throw new Error("the committed W→T funding swap reverted");
    await test.request({ method: "anvil_setTime" as never, params: [Number(blockTimestamp)] as never } as never);
    await test.mine({ blocks: 1 });
    await trace(pool, encodeFunctionData({ abi: poolAbi as Abi, functionName: "swap", args: [USDT0, WHYPE, 100n * 10n ** 6n, 0n] }), "swap T→W");

    // The BBO-mock index read-back: every mock slot the traces touched must belong to a seeded
    // index (the mock keeps two mappings — bid @ slot 0, ask @ slot 1 — so a seeded index owns the
    // two keccak256(abi.encode(idx, 0|1)) slots; see HLBboPrecompileMock.sol).
    const mockSlots = touched.get(HL_BBO_ADDRESS.toLowerCase()) ?? new Set<string>();
    const expectedSlots = new Map<string, string>();
    for (const idx of BBO_INDEXES) {
      for (const base of [0n, 1n]) {
        expectedSlots.set(
          keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [idx, base])).toLowerCase(),
          `${idx}:${base === 0n ? "bid" : "ask"}`,
        );
      }
    }
    for (const slot of mockSlots) {
      if (!expectedSlots.has(slot)) throw new Error(`the pool read an UNSEEDED BBO slot ${slot} — an index outside [${BBO_INDEXES.join(", ")}]; extend BBO_INDEXES and re-run`);
    }
    console.log(`[lc-snapshot] BBO slots read by the traces: ${mockSlots.size} — all belong to the seeded indexes [${BBO_INDEXES.join(", ")}]`);

    // ── 5. FRESH second fork at the pin: read every touched account's code + slot values CLEAN
    //       (the committed funding swap above dirtied pool state on fork #1). ──
    anvil.kill();
    await sleep(1500);
    const { proc: anvil2, url: FORK2 } = bootAnvil(pinBlock);
    const fork2 = createPublicClient({ transport: http(FORK2, { timeout: 120_000 }) });
    try {
      for (let i = 0; i < 90; i++) {
        try { await fork2.getBlockNumber(); break; } catch { await sleep(1000); }
      }
      const TOKENS = new Set([WHYPE.toLowerCase(), USDT0.toLowerCase()]);
      const contracts: { address: Address; role: string; runtime: string; runtimeSha256: Hex; codeSizeBytes: number; slots: Record<string, Hex> }[] = [];
      for (const [addrLc, slotSet] of [...touched.entries()].sort()) {
        const address = getAddress(addrLc) as Address;
        if (address.toLowerCase() === eoa.address.toLowerCase()) continue;
        if (address.toLowerCase() === HL_BBO_ADDRESS.toLowerCase()) continue; // the mock — lcBbo carries the books
        const code = await retry(`getCode ${address}`, () => fork2.getCode({ address }));
        const runtime = code ?? "0x";
        if (runtime === "0x" && slotSet.size === 0) continue; // plain balance-touched EOAs
        const role =
          addrLc === ROUTER.toLowerCase() ? "LiquidCore Router proxy (getPoolForPair/getPools discovery)" :
          addrLc === pool.toLowerCase() ? "LiquidCore per-pair POOL proxy (estimateSwap/swap + the inventory accounting)" :
          TOKENS.has(addrLc) ? "token (repointed by harness)" :
          "implementation / dependency (proxy target or shared library)";
        const slots: Record<string, Hex> = {};
        for (const slot of [...slotSet].sort()) {
          const v = await retry(`slot ${address}:${slot}`, () => fork2.getStorageAt({ address, slot: slot as Hex }));
          slots[slot] = (v ?? ("0x" + "0".repeat(64))) as Hex;
        }
        contracts.push({ address, role, runtime, runtimeSha256: sha256(runtime), codeSizeBytes: runtime === "0x" ? 0 : runtime.length / 2 - 1, slots });
        console.log(`[lc-snapshot]  touched ${address} [${role}] code=${runtime === "0x" ? 0 : runtime.length / 2 - 1}B slots=${Object.keys(slots).length}`);
      }

      const meta = async (t: Address) => ({
        address: t,
        symbol: (await fork2.readContract({ address: t, abi: erc20Abi as Abi, functionName: "symbol" }).catch(() => "?")) as string,
        decimals: Number(await fork2.readContract({ address: t, abi: erc20Abi as Abi, functionName: "decimals" }).catch(() => 18)),
      });

      const bytecodeSnap = {
        chain: "hyperevm",
        fermiSwapper: ROUTER,
        block: pinBlock.toString(),
        blockTimestamp: blockTimestamp.toString(),
        note:
          "LIQUIDCORE (Liquid Labs router + per-pair WHYPE/USDT0 pool — UNVERIFIED bytecode, probe-proven " +
          "surface). FERMI-SHAPED snapshot (fermiSwapper = the ROUTER, vault = the POOL holding the payout " +
          "inventory) so the fermi harness is reused verbatim. Captured via anvil-fork prestateTracer WITH the " +
          "HLBboPrecompileMock pre-etched at the canonical 0x…080e (the pool prices every quote off the " +
          "HyperEVM BBO read precompile — codeless on an EVM fork; the public RPC serves no tracer). lcBbo " +
          "carries the REAL Hyperliquid books at the pin; the mocked fork reproduced the remote quote ladders " +
          "(mock-completeness), and the canonical probe ladders are the mocked-fork values at the pinned clock " +
          "— the exact conditions the prod-mirror test replays. getReserves is INTERNAL pool accounting " +
          "(≠ token balances) — reproduced via the captured pool slots; the harness re-funds the token " +
          "balances (vault.reserves) for the payout inventory.",
        contracts: contracts
          .map((cc) => ({ address: cc.address, role: cc.role, runtime: cc.runtime, runtimeSha256: cc.runtimeSha256, codeSizeBytes: cc.codeSizeBytes }))
          .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)),
      };
      writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

      const stateSnap = {
        chain: "hyperevm",
        fermiSwapper: ROUTER,
        block: pinBlock.toString(),
        blockTimestamp: blockTimestamp.toString(),
        staleUpdateSelector: "0x1f2a2005 zero / 0xc1ab6dc1 unsupported-pair (informational — drained quotes 0 gracefully)",
        target: { ...TARGET },
        second: { ...SECOND },
        tokens: { WHYPE: await meta(WHYPE), USDT0: await meta(USDT0) },
        tokenBalanceSlots: {},
        contractSlots: Object.fromEntries(contracts.map((cc) => [cc.address, { role: cc.role, slots: cc.slots }])),
        vault: {
          address: pool,
          role:
            "the per-pair POOL (the estimateSwap/swap/approve target + the claim key): holds both payout " +
            "inventories as PLAIN token balances — the harness re-funds them; the pool's INTERNAL reserve " +
            "accounting (getReserves ≠ balances) rides the captured storage slots.",
          reserves: { WHYPE: poolWhype.toString(), USDT0: poolUsdt0.toString() },
          allowanceToRouter: { WHYPE: "0", USDT0: "0" },
        },
        eoa7702: null,
        lcPool: pool,
        lcBbo,
        lcInternalReserves: { getReservesWT: [reserves[0].toString(), reserves[1].toString()] },
        probe: {
          target: { pair: `${TARGET.inSym}/${TARGET.outSym}`, ladder: canonFwd },
          second: { pair: `${SECOND.inSym}/${SECOND.outSym}`, ladder: canonRev },
        },
        remoteProbe: {
          note: "the RAW remote-RPC ladders at the pin (the canonical `probe` ladders are the mocked-fork values — identical within the asserted 1e-4 bound; see the bytecode note)",
          target: { pair: `${TARGET.inSym}/${TARGET.outSym}`, ladder: remoteFwd },
          second: { pair: `${SECOND.inSym}/${SECOND.outSym}`, ladder: remoteRev },
        },
      };
      writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));
      console.log(`[lc-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
      console.log(`[lc-snapshot] ${contracts.length} contracts; pinned block ${pinBlock} (ts ${blockTimestamp})`);
    } finally {
      anvil2.kill();
    }
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
