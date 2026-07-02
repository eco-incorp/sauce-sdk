/**
 * One-time capture of a REAL Fluid DEX (Instadapp fluid-contracts-public FluidDexT1) stable pool + its
 * whole quote/swap contract graph from Ethereum mainnet, so the Fluid prod-mirror EVM test runs OFFLINE
 * (no fork, no RPC at run time).
 *
 * Mirrors harness/dodo-snapshot.ts + harness/balancer-snapshot.ts (the proven pattern): eth_getCode the
 * pool's REAL runtime AND every dependency contract the quote/swap path touches — resolving the Liquidity
 * layer's proxy dispatch to its module implementations — into a checked-in bytecode snapshot (WITH sha256
 * integrity anchors), and the swap-relevant state (the pool's low storage slots + the Liquidity layer's
 * touched slots — the packed exchange prices / supply-borrow caps / the operate() module-dispatch entry —
 * captured by ABSOLUTE storage key) into a state snapshot. Block pinned. The RPC url / key is NEVER
 * persisted — only contract CODE + STATE.
 *
 * WHY MULTI-CONTRACT: a FluidDexT1 pool has NO closed-form curve state and NO getAmountOut view — its
 * price comes from the shared Liquidity-Layer supply/borrow exchange prices + a re-centering center
 * price + utilization/borrow caps (all canonical on-chain state). The recipe QUOTES via the periphery
 * DexResolver's `estimateSwapIn(dex, swap0to1, amountIn, 0)` (which try/catches the pool's revert-with-data
 * FluidDexSwapResult estimate hook) and EXECUTES via `pool.swapIn(swap0to1, amt, amountOutMin, to)`
 * (approve-first; Fluid PULLS via safeTransferFrom into the Liquidity layer, which pays the output out).
 *
 * TOUCHED CONTRACT GRAPH (enumerated via `cast access-list` on estimateSwapIn AND a real swapIn on a
 * pinned fork, cross-checked with a full `cast run` call-tree — see the task notes):
 *   1. Resolver (DexResolver 0x11D80…) — the quote surface `getDexTokens` + `estimateSwapIn`. Reads NO
 *      storage of its own for these calls (pure logic that staticcalls the pool); code only.
 *   2. Pool (FluidDexT1 0x6677…9F9B) — token0/token1 + the impl-module addresses are IMMUTABLES baked into
 *      the runtime (read via constantsView()); the pool touches only its own slots 0/1.
 *   3. Liquidity layer proxy (0x52Aa…) — Fluid InfiniteProxy. The pool reads its packed exchange-price /
 *      supply-borrow slots directly (SLOAD) for the estimate, and DELEGATECALLs into it for the exec
 *      operate(). Touched slots captured by absolute key (incl. the operate() sig→module dispatch entry).
 *   4. Liquidity operate module (0x4bDC…) — the InfiniteProxy dispatch target for operate() (runs in the
 *      proxy's storage context; code only).
 *   5. Liquidity secondary module (0x4350…) — a second dispatch target reached during exec (code only).
 * (token0/token1 are repointed to local MintableERC20s in the test; the Liquidity proxy is funded with the
 * output token so it can pay the swap out, mirroring the real ~$15M/$11M USDC/USDT reserves it holds.)
 *
 * WHICH POOL: the DEEPEST on-charter STABLE-pair Fluid DexT1 pool the wired FactoryType.Fluid discovery
 * reaches — the Ethereum USDC/USDT DexT1 pool (dexId 2) in constants.ts CHAIN_POOL_CONFIGS.ethereum
 * fluidPools[0] = 0x667701e51B4D1Ca244F17C78F7aB8744B4C99F9B. Both tokens are on-charter baseTokens
 * (USDC + USDT). estimateSwapIn is deep (1,000,000 USDC → 1,000,736 USDT). (Arbitrum dexId 3
 * 0x3C0441B42195F4aD6aa9a0978E06096ea616CDa7, native USDC/USDT, is an equally-deep FALLBACK — same code
 * graph, different chain; not captured here.)
 *
 * WEI-EXACT ANCHOR: at the pinned block the resolver `estimateSwapIn(pool, true, A, 0)` equals the REAL
 * `pool.swapIn(true, A, 0, to)` output bit-for-bit (verified on the pinned fork), so the offline test can
 * assert cook-output == the recorded quote == the ecoswap.optimal.ts oracle (which segments the same
 * resolver ladder).
 *
 * Re-capture:
 *   set -a; . sdk/.env; set +a
 *   ETH_RPC_URL=$ETH_RPC_URL npx tsx src/recipes/test/harness/fluid-snapshot.ts
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  type Hex,
  type Address,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");
const SNAP_NAME = "ethereum-fluid-USDCUSDT";
const BYTECODE_OUT = join(SNAP_DIR, `${SNAP_NAME}.bytecode.json`);
const STATE_OUT = join(SNAP_DIR, `${SNAP_NAME}.state.json`);

// The wired FactoryType.Fluid target on Ethereum (constants.ts fluidPools[0] + fluidResolver).
const POOL = getAddress("0x667701e51B4D1Ca244F17C78F7aB8744B4C99F9B") as Address;
const RESOLVER = getAddress("0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07") as Address;

// On-charter Ethereum stables (constants.ts CHAIN_POOL_CONFIGS.ethereum.baseTokens) — the expected pair.
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") as Address;
const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7") as Address;

// The pinned block — read every code/storage AT this block for determinism. Override with argv[3].
const PIN_BLOCK = BigInt(process.argv[3] ?? "25441755");

// The Liquidity-proxy storage slots the estimate + exec path touch (union), enumerated via
// `cast access-list` on estimateSwapIn AND a real swapIn (see the header). Captured by ABSOLUTE key so the
// offline test setStorageAt-s them verbatim onto the etched proxy. Includes:
//   · the operate() sig→module dispatch entry (keccak-derived: 0xad967e15…382bbc == the InfiniteProxy
//     mapping slot for selector 0xad967e15; value == the 0x4bDC operate module),
//   · the packed exchange-price / supply-borrow / center-price slots the pool reads for the estimate,
//   · the low proxy admin slots (0/1) + the exec-only accounting slots.
const LIQUIDITY_TOUCHED_SLOTS: Hex[] = [
  // Proxy admin + config low slots.
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000000000000000000000000000001",
  // operate() sig→module dispatch entry (InfiniteProxy mapping; value == 0x4bDC operate module).
  "0xad967e153ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  // Packed exchange-price / supply / borrow / center-price slots (read by the estimate + exec).
  "0x0a7e0e74b40a947daf7b6df34c66be699f819f509940d1bd48c4d99bc5e3353c",
  "0x1896ebc2024c7aa4c1c8e9dcf092da3b896c6f3857be190faeb9f2104fe60e75",
  "0xa8e1248eddf82e10c0adc6c737b6d8da17674abf51801ea5a4549f41c2dfdf21",
  "0xd8164253f72ff9db61eec7a4c9f386bfe79062ab784446f430b9054d92f291b1",
  // Exec-only accounting slots surfaced by the swapIn access-list.
  "0x76591fc11dbbd749b6df72a71faf88b812c3702b5747249a615a8b3dc6bb6a6a",
  "0xf942f4688cdba65adc8aa59da583acae93fa87351143ebc775559218bfa5f832",
];

const RPC =
  process.argv[2] || process.env.ETH_RPC_URL || process.env.ETHEREUM_RPC_URL || "";
if (!RPC) {
  console.error(
    "no RPC — pass one as argv[2] or set ETH_RPC_URL (set -a; . sdk/.env; set +a)",
  );
  process.exit(1);
}

const resolverAbi = parseAbi([
  "function getDexTokens(address dex) view returns (address token0, address token1)",
  "function estimateSwapIn(address dex, bool swap0to1, uint256 amountIn, uint256 amountOutMin) view returns (uint256 amountOut)",
]);
// constantsView() (selector 0xb7791bf2) returns the ConstantViews struct DIRECTLY (word0=dexId,
// word1=liquidity, word2=factory, word3..7=implementations, word8=deployer, word9=token0, word10=token1,
// then bytes32 exchange-price slot keys). We read it via a RAW eth_call and slice the fixed head words.
const CONSTANTS_VIEW_SELECTOR = "0xb7791bf2" as Hex;
const proxyAbi = parseAbi([
  "function getAdmin() view returns (address)",
  "function getDummyImplementation() view returns (address)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

const sha256 = (hex: string) =>
  ("0x" + createHash("sha256").update(hex.toLowerCase()).digest("hex")) as Hex;

/** Read a 32-byte word at word-index `w` of a RAW abi-return blob (skip the head offset+length). */
function wordAt(rawNoPrefix: string, w: number): string {
  return rawNoPrefix.slice(w * 64, w * 64 + 64);
}
function addrFromWord(word: string): Address {
  return getAddress(("0x" + word.slice(24)) as Hex) as Address;
}

async function main() {
  const client = createPublicClient({ transport: http(RPC, { timeout: 180_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 1) console.warn(`[fluid-snapshot] WARNING: chainId ${chainId} != Ethereum (1)`);
  // The pinned block's timestamp — the offline test MUST mine a block at (this + a few seconds) before it
  // quotes/cooks: Fluid's exchange-price update computes `block.timestamp - lastUpdateTimestamp`, which
  // UNDERFLOWS (panic 0x11) at now == storedTs and reverts. A few-second delta is below the accrual
  // rounding quantum, so the quote stays bit-exact with the recorded probe (verified 1s..12s).
  const pinnedBlock = await client.getBlock({ blockNumber: PIN_BLOCK });
  const pinnedTimestamp = pinnedBlock.timestamp;
  console.log(`[fluid-snapshot] Ethereum chainId=${chainId} pinned block=${PIN_BLOCK} ts=${pinnedTimestamp}`);

  // ── Orient the pair via the resolver's getDexTokens (the recipe's discovery surface). ──
  const [t0, t1] = (await client.readContract({
    address: RESOLVER,
    abi: resolverAbi,
    functionName: "getDexTokens",
    args: [POOL],
    blockNumber: PIN_BLOCK,
  })) as [Address, Address];
  const token0 = getAddress(t0) as Address;
  const token1 = getAddress(t1) as Address;
  console.log(`[fluid-snapshot] getDexTokens => token0=${token0} token1=${token1}`);
  if (
    !(
      (token0.toLowerCase() === USDC.toLowerCase() && token1.toLowerCase() === USDT.toLowerCase()) ||
      (token0.toLowerCase() === USDT.toLowerCase() && token1.toLowerCase() === USDC.toLowerCase())
    )
  ) {
    throw new Error(`pool ${POOL} is not the expected USDC/USDT pair (got ${token0}/${token1})`);
  }

  // ── Decode the pool's constantsView() immutables (liquidity + module map). RAW-slice the fixed head. ──
  // Layout (verified): [0]dexId [1]liquidity [2]factory [3..7]implementations(5) [8]deployer
  //                    [9]token0 [10]token1 [11..] bytes32 exchange-price slot keys.
  const cvRes = await client.call({ to: POOL, data: CONSTANTS_VIEW_SELECTOR, blockNumber: PIN_BLOCK });
  const structHex = ((cvRes.data ?? "0x") as string).replace(/^0x/, "");
  if (structHex.length < 11 * 64) throw new Error(`constantsView() returned too little data (${structHex.length / 64} words)`);
  // Sanity: word[9]/word[10] must be token0/token1 (already confirmed via getDexTokens above).
  const cvTok0 = addrFromWord(wordAt(structHex, 9));
  const cvTok1 = addrFromWord(wordAt(structHex, 10));
  if (cvTok0.toLowerCase() !== token0.toLowerCase() || cvTok1.toLowerCase() !== token1.toLowerCase()) {
    throw new Error(`constantsView token words (${cvTok0}/${cvTok1}) disagree with getDexTokens (${token0}/${token1})`);
  }
  const liquidity = addrFromWord(wordAt(structHex, 1));
  const factory = addrFromWord(wordAt(structHex, 2));
  const implementations = [3, 4, 5, 6, 7].map((w) => addrFromWord(wordAt(structHex, w)));
  const deployer = addrFromWord(wordAt(structHex, 8));
  console.log(
    `[fluid-snapshot] pool immutables: liquidity=${liquidity} factory=${factory}\n` +
      `  implementations=${implementations.join(",")}\n  deployer=${deployer}`,
  );

  // ── Determine the operate() module the InfiniteProxy dispatches to (the exec delegate) + a 2nd module
  //    seen during exec — read directly from the captured dispatch slot + the traced call graph. ──
  const OPERATE_DISPATCH_SLOT =
    "0xad967e153ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
  const operateModuleWord = await client.getStorageAt({
    address: liquidity,
    slot: OPERATE_DISPATCH_SLOT,
    blockNumber: PIN_BLOCK,
  });
  const operateModule = addrFromWord((operateModuleWord ?? "0x").replace(/^0x/, "").padStart(64, "0"));
  // The second exec delegate (0x4350…) is not in the sig map (an internal module the operate path calls);
  // it is enumerated from the swapIn call-tree trace (see the header). Hard-pin it — verified touched.
  const secondaryModule = getAddress("0x43506849D7C04F9138D1A2050bbF3A0c054402dd") as Address;
  console.log(`[fluid-snapshot] operate module=${operateModule} secondary module=${secondaryModule}`);

  // ── Bytecode: pool + resolver + Liquidity proxy + the two Liquidity modules (all at the pinned block). ──
  const getCode = async (address: Address): Promise<Hex> => {
    const code = await client.getCode({ address, blockNumber: PIN_BLOCK });
    if (!code || code === "0x") throw new Error(`empty code at ${address}`);
    return code;
  };
  const [poolCode, resolverCode, liqCode, operateCode, secondaryCode] = await Promise.all([
    getCode(POOL),
    getCode(RESOLVER),
    getCode(liquidity),
    getCode(operateModule),
    getCode(secondaryModule),
  ]);
  console.log(
    `[fluid-snapshot] code sizes: pool=${poolCode.length / 2 - 1} resolver=${resolverCode.length / 2 - 1} ` +
      `liquidity=${liqCode.length / 2 - 1} operateModule=${operateCode.length / 2 - 1} secondaryModule=${secondaryCode.length / 2 - 1}`,
  );

  const [proxyAdmin, proxyDummyImpl] = await Promise.all([
    client.readContract({ address: liquidity, abi: proxyAbi, functionName: "getAdmin", blockNumber: PIN_BLOCK }).catch(() => "0x") as Promise<Hex>,
    client.readContract({ address: liquidity, abi: proxyAbi, functionName: "getDummyImplementation", blockNumber: PIN_BLOCK }).catch(() => "0x") as Promise<Hex>,
  ]);

  // ── Storage: pool low window (0..7 with margin) + the Liquidity proxy's touched slots (union), all at
  //    the pinned block, keyed by absolute slot for verbatim setStorageAt reconstruction. ──
  const readSlot = async (address: Address, slot: Hex): Promise<Hex> =>
    ((await client.getStorageAt({ address, slot, blockNumber: PIN_BLOCK })) ??
      (("0x" + "0".repeat(64)) as Hex)) as Hex;

  const poolStorage: Record<string, Hex> = {};
  for (let s = 0; s < 8; s++) {
    const slot = ("0x" + s.toString(16).padStart(64, "0")) as Hex;
    poolStorage[slot] = await readSlot(POOL, slot);
  }
  const liquidityStorage: Record<string, Hex> = {};
  for (const slot of LIQUIDITY_TOUCHED_SLOTS) {
    liquidityStorage[slot] = await readSlot(liquidity, slot);
  }

  // ── Token metadata + the REAL Liquidity-layer reserves (the offline test funds the etched proxy with the
  //    output token so it can pay the swap out — mirroring these). ──
  const [dec0, dec1, sym0, sym1, liqBal0, liqBal1] = await Promise.all([
    client.readContract({ address: token0, abi: erc20Abi, functionName: "decimals", blockNumber: PIN_BLOCK }).then(Number),
    client.readContract({ address: token1, abi: erc20Abi, functionName: "decimals", blockNumber: PIN_BLOCK }).then(Number),
    client.readContract({ address: token0, abi: erc20Abi, functionName: "symbol", blockNumber: PIN_BLOCK }).catch(() => "?"),
    client.readContract({ address: token1, abi: erc20Abi, functionName: "symbol", blockNumber: PIN_BLOCK }).catch(() => "?"),
    client.readContract({ address: token0, abi: erc20Abi, functionName: "balanceOf", args: [liquidity], blockNumber: PIN_BLOCK }) as Promise<bigint>,
    client.readContract({ address: token1, abi: erc20Abi, functionName: "balanceOf", args: [liquidity], blockNumber: PIN_BLOCK }) as Promise<bigint>,
  ]);

  // ── Probe quotes at the pinned block — the wei-exact anchor the offline test reproduces (real code +
  //    real state). swap0to1=true ⇒ token0→token1; false ⇒ token1→token0. A ladder over several sizes. ──
  const unit0 = 10n ** BigInt(dec0);
  const unit1 = 10n ** BigInt(dec1);
  const probeSizes0 = [1_000n, 10_000n, 100_000n, 1_000_000n].map((n) => n * unit0);
  const probeSizes1 = [1_000n, 10_000n, 100_000n, 1_000_000n].map((n) => n * unit1);
  const est = (swap0to1: boolean, amt: bigint) =>
    client
      .readContract({
        address: RESOLVER,
        abi: resolverAbi,
        functionName: "estimateSwapIn",
        args: [POOL, swap0to1, amt, 0n],
        blockNumber: PIN_BLOCK,
      })
      .then((r) => r as bigint)
      .catch(() => 0n);
  const quotes0to1 = await Promise.all(probeSizes0.map((a) => est(true, a)));
  const quotes1to0 = await Promise.all(probeSizes1.map((a) => est(false, a)));

  // ── Write the bytecode snapshot (WITH sha256 anchors). ──
  const bytecodeSnap = {
    chain: "ethereum",
    block: PIN_BLOCK.toString(),
    blockTimestamp: pinnedTimestamp.toString(),
    pool: { address: POOL, runtime: poolCode, runtimeSha256: sha256(poolCode) },
    isMinimalProxy: false,
    // Every OTHER contract the quote/swap staticcall + exec path touches (resolver + Liquidity graph).
    dependencies: [
      { name: "resolver", address: RESOLVER, runtime: resolverCode, runtimeSha256: sha256(resolverCode) },
      { name: "liquidity", address: liquidity, runtime: liqCode, runtimeSha256: sha256(liqCode) },
      { name: "liquidityOperateModule", address: operateModule, runtime: operateCode, runtimeSha256: sha256(operateCode) },
      { name: "liquiditySecondaryModule", address: secondaryModule, runtime: secondaryCode, runtimeSha256: sha256(secondaryCode) },
    ],
  };
  writeFileSync(BYTECODE_OUT, JSON.stringify(bytecodeSnap, null, 2));

  // ── Write the state snapshot. ──
  const stateSnap = {
    chain: "ethereum",
    block: PIN_BLOCK.toString(),
    // The pinned block's timestamp. The offline test mines a block at (blockTimestamp + a few seconds)
    // before quoting/cooking — see the note above (Fluid exchange-price accrual underflows at ts==storedTs).
    blockTimestamp: pinnedTimestamp.toString(),
    pool: POOL,
    resolver: RESOLVER,
    factory,
    liquidity,
    proxyAdmin,
    proxyDummyImplementation: proxyDummyImpl,
    implementations,
    deployer,
    operateDispatchSlot: OPERATE_DISPATCH_SLOT,
    operateModule,
    secondaryModule,
    token0,
    token1,
    token0Symbol: sym0,
    token1Symbol: sym1,
    token0Decimals: dec0,
    token1Decimals: dec1,
    // The REAL Liquidity-layer reserves at the pinned block — the offline test funds the etched proxy with
    // (at least) the output-token amount so the real code can pay the swap out.
    liquidityReserve0: liqBal0.toString(),
    liquidityReserve1: liqBal1.toString(),
    // Wei-exact anchor: the resolver estimateSwapIn ladder (== the real swapIn output, verified on the
    // pinned fork) for both directions. The offline test asserts cook-output == these == the oracle.
    probe: {
      swap0to1: probeSizes0.map((amt, i) => ({ amountIn: amt.toString(), amountOut: quotes0to1[i].toString() })),
      swap1to0: probeSizes1.map((amt, i) => ({ amountIn: amt.toString(), amountOut: quotes1to0[i].toString() })),
    },
    // Raw storage windows for deterministic setStorageAt reconstruction (absolute slot -> value).
    poolStorage,
    liquidityStorage,
  };
  writeFileSync(STATE_OUT, JSON.stringify(stateSnap, null, 2));

  console.log(`[fluid-snapshot] wrote:\n  ${BYTECODE_OUT}\n  ${STATE_OUT}`);
  console.log(
    `[fluid-snapshot] ${sym0}(${dec0})/${sym1}(${dec1}) liquidity reserves: ` +
      `${(Number(liqBal0) / Number(unit0)).toFixed(0)} ${sym0} / ${(Number(liqBal1) / Number(unit1)).toFixed(0)} ${sym1}\n` +
      `  probe swap0to1 (${sym0}->${sym1}): ` +
      probeSizes0.map((a, i) => `${a / unit0}${sym0}=>${quotes0to1[i]}`).join(" ") +
      `\n  probe swap1to0 (${sym1}->${sym0}): ` +
      probeSizes1.map((a, i) => `${a / unit1}${sym1}=>${quotes1to0[i]}`).join(" ") +
      `\n  pool storage slots: ${Object.keys(poolStorage).length}, liquidity storage slots: ${Object.keys(liquidityStorage).length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
