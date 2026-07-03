/**
 * Reusable REAL-CODE, NO-FORK, OFFLINE pool harness.
 *
 * The pattern this file establishes (the template every future source follows):
 *
 *   CAPTURE (one-time, harness/<src>-snapshot.ts, uses the RPC key):
 *     eth_getCode the pool's REAL runtime (+ the implementation runtime when the pool
 *     is an EIP-1167 minimal-proxy / clone) into a checked-in bytecode snapshot, and
 *     the swap-relevant state (reserves/tokens/decimals/fee/raw slots) into a state
 *     snapshot. Pin a block. NEVER persist the RPC url / key.
 *
 *   ETCH (this file, at test time, OFFLINE):
 *     boot a plain anvil (NO fork), setCode the captured REAL runtime at the pool's
 *     address (and the impl address for a clone), setStorageAt the captured swap-
 *     relevant storage, repoint token0/token1 at locally-deployed MintableERC20s (so
 *     the caller can be funded and the pool's swap() moves real tokens), and fund the
 *     pool's reserves. The swap then executes the REAL contract bytecode against the
 *     REAL captured reserves — identical to mainnet — with no fork and no RPC.
 *
 * This is the SAME mechanism the repo already uses for Uniswap V4 (setup.ts
 * etchV4Singletons + harness/v4-bytecode-snapshot.ts) and Balancer's canonical Vault
 * — generalised here so callback-free reserve-priced pools (Solidly/Aerodrome, and any
 * V2-shaped clone) can be stood up as REAL code offline.
 *
 * WHY etch-runtime (B) not source-deploy (A) for Aerodrome:
 *   An Aerodrome/Velodrome Pool is deployed as an EIP-1167 CLONE of a single Pool
 *   implementation; the impl's swap/getAmountOut read the CLONE's storage (reserves,
 *   token0/1, decimals) and call factory.getFee(pool, stable). Cloning the real impl +
 *   setStorageAt-ing the captured reserves reproduces the pool's swap-relevant state
 *   EXACTLY, and the swap then runs the genuine impl bytecode — a higher-fidelity, far
 *   cheaper path than rebuilding the factory/gauge/voter graph a fresh createPool would
 *   need. (Source-deploy (A) suits protocols with a clean standalone constructor + a
 *   mint/sync entry; etch-runtime (B) suits clones / Vyper / opaque runtimes.)
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAbi,
  getAddress,
  pad,
  toHex as viemToHex,
  keccak256,
  encodeAbiParameters,
  type Hex,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";

import { deployToken, deployBurnableToken, erc20Abi, mint } from "./setup";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, "..", "fixtures", "snapshots");

// ── Captured-snapshot shapes (written by harness/<src>-snapshot.ts) ──

export interface PoolBytecodeSnapshot {
  chain: string;
  block: string;
  /** `runtimeSha256` is a self-contained integrity anchor (see verifyBytecodeIntegrity). */
  pool: { address: Hex; runtime: Hex; runtimeSha256?: Hex };
  /** Present iff the pool is an EIP-1167 clone: the delegate implementation runtime. */
  implementation?: { address: Hex; runtime: Hex; runtimeSha256?: Hex };
  isMinimalProxy: boolean;
}

export interface SolidlyStateSnapshot {
  chain: string;
  block: string;
  pool: Hex;
  factory: Hex;
  token0: Hex;
  token1: Hex;
  stable: boolean;
  decimals0: string; // 10**tokenDecimals0
  decimals1: string;
  tokenDecimals0: number;
  tokenDecimals1: number;
  reserve0: string;
  reserve1: string;
  blockTimestampLast: string;
  factoryFee: string;
  probe: { amountIn: string; tokenIn: Hex; amountOut: string };
  storage: Record<string, Hex>;
}

/** Load a `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadSolidlySnapshots(name: string): {
  bytecode: PoolBytecodeSnapshot;
  state: SolidlyStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as PoolBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as SolidlyStateSnapshot;
  return { bytecode, state };
}

/** sha256 of the lowercased runtime hex — matches the snapshot capture's anchor. */
export function runtimeSha256(runtime: Hex): Hex {
  return ("0x" + createHash("sha256").update(runtime.toLowerCase()).digest("hex")) as Hex;
}

/**
 * NO-NETWORK integrity tripwire: re-hash the loaded runtime(s) and assert they match the
 * `runtimeSha256` anchor recorded at capture time (byte-equal to the pinned-block on-chain
 * code). A reviewer WITHOUT the RPC key can run this — it proves the checked-in runtime blob
 * was not silently altered/truncated after capture, without ever touching RPC. Returns the
 * per-runtime {expected, actual, ok} so a caller can assert with a descriptive message.
 * Skips (ok:true) any runtime whose snapshot predates the anchor (no runtimeSha256 field).
 */
export function verifyBytecodeIntegrity(bytecode: PoolBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  implementation?: { expected?: Hex; actual: Hex; ok: boolean };
} {
  const poolActual = runtimeSha256(bytecode.pool.runtime);
  const out: ReturnType<typeof verifyBytecodeIntegrity> = {
    pool: {
      expected: bytecode.pool.runtimeSha256,
      actual: poolActual,
      ok: !bytecode.pool.runtimeSha256 || bytecode.pool.runtimeSha256.toLowerCase() === poolActual.toLowerCase(),
    },
  };
  if (bytecode.implementation) {
    const implActual = runtimeSha256(bytecode.implementation.runtime);
    out.implementation = {
      expected: bytecode.implementation.runtimeSha256,
      actual: implActual,
      ok:
        !bytecode.implementation.runtimeSha256 ||
        bytecode.implementation.runtimeSha256.toLowerCase() === implActual.toLowerCase(),
    };
  }
  return out;
}

// ── The Aerodrome Pool storage layout (verified against the captured slots). ──
//   slot 9  stable (bool)      slot 13 token0    slot 14 token1
//   slot 16 factory            slot 18 decimals0 slot 19 decimals1
//   slot 20 reserve0           slot 21 reserve1
const SLOT = {
  stable: 9,
  token0: 13,
  token1: 14,
  factory: 16,
  decimals0: 18,
  decimals1: 19,
  reserve0: 20,
  reserve1: 21,
} as const;

function slotHex(i: number): Hex {
  return pad(viemToHex(BigInt(i)), { size: 32 }) as Hex;
}
function word(v: bigint): Hex {
  return pad(viemToHex(v), { size: 32 }) as Hex;
}
function addrWord(a: Hex): Hex {
  return pad(getAddress(a).toLowerCase() as Hex, { size: 32 }) as Hex;
}

/**
 * A minimal SolidlyV2 factory shim so BOTH (a) the production discovery path resolves the
 * pool via getPool(a, b, true), and (b) the etched Pool impl's getAmountOut can read its
 * fee via factory.getFee(pool, true). We setCode this hand-assembled runtime at the
 * captured factory address, then setStorageAt its two slots directly (slot0 = fee,
 * slot1 = pool). This needs NO Solidity compile and NO write tx.
 *
 * READ dispatch (verified on anvil): each entry answers ONE selector by returning a storage
 * slot; any UNLISTED selector returns the explicit `defaultWord` (0 here).
 *   getFee(address,bool)          cc56b2c5 -> mstore(0, sload(0)); return(0,32)   (the pool fee)
 *   getPool(address,address,bool) 79bc57d5 -> mstore(0, sload(1)); return(0,32)   (the pool address)
 *   <unlisted>                             -> mstore(0, defaultWord); return(0,32)
 * It replies unconditionally (address/stable-agnostic): the test stands up exactly ONE
 * stable pool, so a constant reply is faithful.
 *
 * DEFAULT-0 IS AN EXPLICIT CHOICE, NOT A SILENT CATCH-ALL. Here it is the correct "false/none"
 * answer for every OTHER factory getter the real Aerodrome Pool.swap()/getAmountOut touches —
 * notably isPaused() (b187bd26) -> false, so the genuine swap invariant path runs unpaused
 * (verified: the swap lands and routes the fee to PoolFees). When ADAPTING this harness to a
 * NEW callback-free source, ENUMERATE the factory getters that source's real swap()/getAmountOut
 * calls and pass each a `{selector, slot}` entry (seed its real value via setStorageAt) — do NOT
 * rely on default-0 for a getter whose zero answer is not semantically "false/none" (e.g. a fee
 * recipient the pool transfers to, or a hook flag). `buildFactoryShimRuntime` takes the entries +
 * default explicitly precisely so the answered surface is visible at the call site.
 */
export const solidlyFactoryShimAbi = parseAbi([
  "function getFee(address pool, bool stable) view returns (uint256)",
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
]);

/** slot0 = fee, slot1 = pool. */
const SHIM_FEE_SLOT = 0;
const SHIM_POOL_SLOT = 1;

/** One answered getter: 4-byte selector (no 0x) -> the storage slot whose word it returns. */
export interface ShimSelectorEntry {
  /** 8 hex chars, no 0x prefix (e.g. "cc56b2c5"). */
  selector: string;
  /** Storage slot to SLOAD and return (32-byte word). */
  slot: number;
}

/**
 * Build a read-only factory-shim runtime as an N-target jump table with offset-exact JUMPDESTs.
 * Every listed selector returns `sload(entry.slot)`; any UNLISTED selector returns `defaultWord`
 * (an EXPLICIT default, not an accidental catch-all — see the doc on solidlyFactoryShimAbi).
 * Read-only (state is seeded via setStorageAt), so there is no write dispatch.
 *
 * The default entries reproduce the original Solidly shim exactly: getFee->slot0, getPool->slot1,
 * default 0. Callers adding a new source pass their own entries (and a non-zero default when the
 * "none" answer must be non-zero).
 */
export function buildFactoryShimRuntime(
  entries: ShimSelectorEntry[] = [
    { selector: "cc56b2c5", slot: SHIM_FEE_SLOT }, // getFee(address,bool)          -> fee
    { selector: "79bc57d5", slot: SHIM_POOL_SLOT }, // getPool(address,address,bool) -> pool
  ],
  defaultWord = 0n,
): Hex {
  const bytes = (h: string) => h.length / 2;
  // Return-slot body: PUSH1 <slot> SLOAD PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN.
  const retSlot = (slot: number) =>
    "60" + slot.toString(16).padStart(2, "0") + "54600052602060" + "00f3";
  // Return a constant word: PUSH32 <word> PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN.
  const retConst = (w: bigint) =>
    "7f" + w.toString(16).padStart(64, "0") + "600052602060" + "00f3";
  const header = "60003560e01c"; // sel = shr(0xe0, calldataload(0))
  const cmp = (sel: string, dest: number) =>
    "8063" + sel + "1461" + dest.toString(16).padStart(4, "0") + "57"; // DUP1 PUSH4 sel EQ PUSH2 dest JUMPI
  const gotoDefault = (dest: number) => "61" + dest.toString(16).padStart(4, "0") + "56"; // PUSH2 dest JUMP

  if (entries.length > 0xff) throw new Error("factory shim: too many selector entries");
  // Slots must be single-byte (PUSH1) so the return-body length is fixed at bytes(retSlot(0)).
  for (const e of entries) {
    if (e.selector.length !== 8) throw new Error(`factory shim: selector "${e.selector}" must be 8 hex chars`);
    if (e.slot < 0 || e.slot > 0xff) throw new Error(`factory shim: slot ${e.slot} out of PUSH1 range`);
  }

  // Header + one cmp per entry + the goto-default trailer, then the JUMPDEST bodies.
  const dispatchLen = bytes(header) + entries.length * bytes(cmp("00000000", 0)) + bytes(gotoDefault(0));
  let off = dispatchLen;
  const bodyLen = 1 + bytes(retSlot(0)); // +JUMPDEST
  const dests = entries.map((_, i) => off + i * bodyLen);
  off += entries.length * bodyLen;
  const defaultOff = off;

  const code =
    header +
    entries.map((e, i) => cmp(e.selector, dests[i])).join("") +
    gotoDefault(defaultOff) +
    entries.map((e) => "5b" + retSlot(e.slot)).join("") +
    "5b" +
    retConst(defaultWord); // <unlisted> -> defaultWord (0 == false/none for Solidly)
  return ("0x" + code) as Hex;
}

export interface EtchedSolidlyPool {
  /** The pool address (the getAmountOut/swap target discovery resolves). */
  pool: Hex;
  /** The delegate implementation address (etched with the real impl runtime). */
  impl: Hex;
  /** The SolidlyV2 factory shim (getPool/getFee) — point a poolConfig factory here. */
  factory: Hex;
  /** The locally-deployed token0/token1 (sorted so token0 < token1). */
  token0: Hex;
  token1: Hex;
  /** Captured reserves + fee, echoed for the test. */
  reserve0: bigint;
  reserve1: bigint;
  factoryFee: bigint;
}

type MiniTestClient = {
  setCode: (a: { address: Hex; bytecode: Hex }) => Promise<void>;
  setStorageAt: (a: { address: Hex; index: Hex; value: Hex }) => Promise<void>;
};

/**
 * Stand up the captured REAL Aerodrome sAMM pool on the local anvil, OFFLINE.
 *
 *   1. Deploy two MintableERC20s (captured token decimals), sorted so token0 < token1
 *      (mirrors the real USDC < USDbC ordering the impl assumes).
 *   2. setCode the READ-only SolidlyV2 factory shim at the captured factory address;
 *      seed its fee/pool slots via setStorageAt.
 *   3. setCode the REAL impl runtime at its captured address, and the REAL 45-byte
 *      EIP-1167 proxy runtime at a chosen pool address (the proxy embeds the impl
 *      address, so the impl MUST live at its captured address for the delegatecall to
 *      resolve — exactly the V4 StateView→PoolManager immutable constraint).
 *   4. setStorageAt the pool clone: stable, token0/token1 (the LOCAL tokens),
 *      decimals0/1, reserve0/reserve1, factory (the shim). Now the etched REAL impl
 *      code computes getReserves/getAmountOut against the captured state.
 *   5. Fund the pool's token0/token1 balances with the reserves so swap() can pay out,
 *      and give the caller some tokenIn headroom.
 *
 * The swap path then runs the GENUINE impl bytecode — getAmountOut(dx, tokenIn) returns
 * the mainnet-identical dy for the captured reserves, and swap() transfers real tokens.
 */
export async function etchSolidlyPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: PoolBytecodeSnapshot; state: SolidlyStateSnapshot },
  opts: { poolAddress?: Hex; minter?: Account; callerFund?: bigint } = {},
): Promise<EtchedSolidlyPool> {
  const { bytecode, state } = snapshots;
  if (!bytecode.isMinimalProxy || !bytecode.implementation) {
    throw new Error("etchSolidlyPool expects an EIP-1167 clone snapshot (pool + implementation)");
  }
  const acct = (opts.minter ?? walletClient.account) as Account;

  // 1. Local sorted tokens (match the captured token decimals so decimals0/1 stay valid).
  const a = await deployToken(walletClient, publicClient, "StableIn", "STIN", Number(state.tokenDecimals0));
  const b = await deployToken(walletClient, publicClient, "StableOut", "STOUT", Number(state.tokenDecimals1));
  const [token0, token1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];

  // 2. Factory shim at the captured factory address; seed fee/pool slots.
  const factory = getAddress(state.factory) as Hex;
  const poolAddress = getAddress(opts.poolAddress ?? bytecode.pool.address) as Hex;
  const factoryFee = BigInt(state.factoryFee);
  await testClient.setCode({ address: factory, bytecode: buildFactoryShimRuntime() });
  await testClient.setStorageAt({ address: factory, index: slotHex(SHIM_FEE_SLOT), value: word(factoryFee) });
  await testClient.setStorageAt({ address: factory, index: slotHex(SHIM_POOL_SLOT), value: addrWord(poolAddress) });

  // 3. Etch the REAL impl at its captured address, and the REAL proxy at the pool address.
  const impl = getAddress(bytecode.implementation.address) as Hex;
  await testClient.setCode({ address: impl, bytecode: bytecode.implementation.runtime });
  await testClient.setCode({ address: poolAddress, bytecode: bytecode.pool.runtime });

  // 4. Reconstruct the pool clone's storage. Apply EVERY captured slot VERBATIM first
  //    (so stable/decimals/reserves and any packed fields are byte-identical to mainnet),
  //    THEN override only token0/token1 (→ the local tokens) and factory (→ the shim).
  //    This makes the etched pool's state a faithful copy of the real pool: the impl's
  //    getReserves/getAmountOut compute exactly the mainnet dy, and swap() moves local
  //    tokens the caller can hold.
  const reserve0 = BigInt(state.reserve0);
  const reserve1 = BigInt(state.reserve1);
  const set = (slot: number, value: Hex) =>
    testClient.setStorageAt({ address: poolAddress, index: slotHex(slot), value });
  for (const [k, v] of Object.entries(state.storage)) {
    await set(Number(k), v);
  }
  // Repoint the pair at the LOCAL tokens + the factory at the shim.
  await set(SLOT.token0, addrWord(token0));
  await set(SLOT.token1, addrWord(token1));
  await set(SLOT.factory, addrWord(factory));
  // Re-affirm reserves/decimals from the typed state (they are already in `storage`, but
  // assert the canonical slots so a snapshot without the raw window still reconstructs).
  await set(SLOT.decimals0, word(BigInt(state.decimals0)));
  await set(SLOT.decimals1, word(BigInt(state.decimals1)));
  await set(SLOT.reserve0, word(reserve0));
  await set(SLOT.reserve1, word(reserve1));

  // 5. Fund the pool's reserves (so swap() can pay out) + the caller headroom.
  await mint(walletClient, publicClient, token0, poolAddress, reserve0);
  await mint(walletClient, publicClient, token1, poolAddress, reserve1);
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, token0, acct.address as Hex, opts.callerFund);
    await mint(walletClient, publicClient, token1, acct.address as Hex, opts.callerFund);
  }

  return { pool: poolAddress, impl, factory, token0, token1, reserve0, reserve1, factoryFee };
}

/** Solidly Pool read surface (the getters the test + discovery + oracle read). */
export const solidlyPoolReadAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)",
]);

// ══════════════════════════════════════════════════════════════════════════════
// DODO V2 PMM (DSP) prod-mirror etch — ADDITIVE extension of this harness.
//
// A DODO DSP pool is an EIP-1167 CLONE of a single DSP implementation, exactly like an
// Aerodrome Pool — so the SAME etch-runtime mechanism applies: setCode the REAL 45-byte
// proxy at the pool address + the REAL DSP impl at its captured address, setStorageAt the
// captured PMM curve state VERBATIM, then repoint the base/quote token slots at local
// MintableERC20s. The swap then runs the GENUINE DSP bytecode (getPMMStateForCall /
// querySellBase|Quote / sellBase|sellQuote), computing the mainnet-identical PMM integral.
//
// DEPENDENCY CONTRACTS the DSP swap/quote path touches (beyond pool + impl):
//   • the DODO DVMFactory (getDODOPool(base,quote) → address[]) the production FactoryType.DODOZoo
//     discovery reads — stood up as a tiny read-only shim returning [pool] for the pair (and
//     an empty array otherwise). NO factory graph rebuild needed.
//   • the MT (maintainer) FEE-RATE MODEL. The DSP's querySell*/sell* read the maintainer fee
//     from it (mulFloor(gross, mtFeeRate)). The REAL model reverts getFeeRate(trader) unless
//     msg.sender is the pool AND (per the capture) makes an external call to a downstream
//     fee-rate impl — so we stand up a tiny read-only shim at its CAPTURED address that returns
//     the CAPTURED RESOLVED mtFeeRate (read from the pool context at capture) for BOTH
//     getFeeRate(address) (the swap path, pool-as-caller) and _FEE_RATE_() (the discovery
//     fallback, recipe-as-caller). The fee is a scalar the DSP multiplies in; using the captured
//     resolved value keeps the executed dy EXACT vs the neutral oracle (whose mtFeeRate came
//     from the same capture) — see the test's HONEST fee accounting.
// ══════════════════════════════════════════════════════════════════════════════

/** A captured dependency runtime (beyond pool/impl) the swap/quote path touches. */
export interface DependencyBytecode {
  name: string;
  address: Hex;
  runtime: Hex;
  runtimeSha256?: Hex;
}

/** DODO bytecode snapshot: pool proxy + DSP impl (clone) + the dependency runtimes. */
export interface DodoBytecodeSnapshot extends PoolBytecodeSnapshot {
  dependencies?: DependencyBytecode[];
}

/** DODO state snapshot (written by harness/dodo-snapshot.ts). */
export interface DodoStateSnapshot {
  chain: string;
  block: string;
  pool: Hex;
  factory: Hex;
  dvmFactory?: Hex;
  dspFactory?: Hex;
  version: string;
  baseToken: Hex;
  quoteToken: Hex;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  pmm: { i: string; K: string; B: string; Q: string; B0: string; Q0: string; R: number };
  baseReserve: string;
  quoteReserve: string;
  lpFeeRate: string;
  mtFeeRate: string;
  mtFeeRateModel: Hex;
  probe: {
    sellBase: { payBaseAmount: string; receiveQuoteAmount: string; mtFee: string };
    sellQuote: { payQuoteAmount: string; receiveBaseAmount: string; mtFee: string };
  };
  storage: Record<string, Hex>;
  mtStorage?: Record<string, Hex>;
}

/** Load a DODO `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadDodoSnapshots(name: string): {
  bytecode: DodoBytecodeSnapshot;
  state: DodoStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as DodoBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as DodoStateSnapshot;
  return { bytecode, state };
}

/**
 * Extend verifyBytecodeIntegrity over the DODO dependency runtimes: re-hash each and match
 * its capture-time sha256 anchor (NO RPC). Returns pool/impl (via verifyBytecodeIntegrity) +
 * per-dependency {name, expected, actual, ok}.
 */
export function verifyDodoBytecodeIntegrity(bytecode: DodoBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  implementation?: { expected?: Hex; actual: Hex; ok: boolean };
  dependencies: { name: string; expected?: Hex; actual: Hex; ok: boolean }[];
} {
  const base = verifyBytecodeIntegrity(bytecode);
  const dependencies = (bytecode.dependencies ?? []).map((d) => {
    const actual = runtimeSha256(d.runtime);
    return {
      name: d.name,
      expected: d.runtimeSha256,
      actual,
      ok: !d.runtimeSha256 || d.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { ...base, dependencies };
}

// ── DSP clone storage layout (verified against the captured slots — see dodo-snapshot.ts). ──
//   slot 1 _BASE_TOKEN_    slot 2 _QUOTE_TOKEN_    slot 14 _MT_FEE_RATE_MODEL_
// The PMM curve state (packed reserves slot3 / packed targets slot5, guide price i slot17,
// slippage K slot16, R) is applied VERBATIM from the captured window; getPMMStateForCall
// recomputes B0/Q0 from it exactly (a DSP _expectTarget round-trip), so we touch ONLY the three
// address slots after the verbatim copy.
const DSP_SLOT = {
  baseToken: 1,
  quoteToken: 2,
  mtFeeRateModel: 14,
} as const;

/** getDODOPool(address,address) selector — the REAL DVMFactory getter the production
 *  FactoryType.DODOZoo discovery calls (verified on-chain; the V1 Zoo `getDODO` reverts on it). */
const GET_DODO_POOL_SELECTOR = "57a281dc";

/**
 * A minimal read-only DODO DVMFactory shim: getDODOPool(base,quote) → the single reproduced pool as
 * a one-element address[]; every other pair / selector → an empty address[]. We setCode this at the
 * captured factory address and store the pool at slot0. NO Solidity compile, NO write tx.
 *
 * This shim implements the REAL getter (getDODOPool), NOT the V1 Zoo `getDODO` — so the prod-mirror
 * exercises the exact discovery call path production uses and can no longer MASK a wrong-getter
 * mismatch (a shim that answered getDODO would reply to a call the fixed discovery never makes,
 * so discovery would find nothing — the test would fail loudly rather than pass on a fiction).
 *
 * ABI return for a one-element address[]: head offset 0x20, then [length=1, pool] — 3 words.
 * Empty array: [0x20, 0] — 2 words. The shim answers getDODOPool unconditionally (address-agnostic):
 * the test stands up exactly ONE DODO pool for the pair, so a constant reply is faithful (the
 * production discovery queries BOTH orderings and de-dupes on the pool address, so replying the
 * SAME pool to both orderings is correct — the second is dropped by discovery's `seen` set).
 */
export function buildDodoFactoryShimRuntime(): Hex {
  // Runtime:
  //   sel = shr(0xe0, calldataload(0))
  //   if sel == getDODOPool: mstore(0,0x20); mstore(0x20,1); mstore(0x40,sload(0)); return(0,0x60)
  //   else:                  mstore(0,0x20); mstore(0x20,0);                        return(0,0x40)
  //
  // Hand-assembled with an offset-exact JUMPDEST for the getDODOPool body.
  const bytes = (h: string) => h.length / 2;
  const header = "60003560e01c"; // PUSH1 0 CALLDATALOAD PUSH1 0xe0 SHR
  // DUP1 PUSH4 <sel> EQ PUSH2 <dest> JUMPI
  const cmp = (sel: string, dest: number) =>
    "8063" + sel + "1461" + dest.toString(16).padStart(4, "0") + "57";
  // Empty-array body (fallthrough): mstore(0,0x20) mstore(0x20,0) return(0,0x40)
  //   PUSH1 0x20 PUSH1 0 MSTORE  PUSH1 0 PUSH1 0x20 MSTORE  PUSH1 0x40 PUSH1 0 RETURN
  const emptyBody = "6020600052" + "6000602052" + "604060" + "00f3";
  // getDODOPool body (JUMPDEST): mstore(0,0x20) mstore(0x20,1) mstore(0x40,sload(0)) return(0,0x60)
  //   JUMPDEST PUSH1 0x20 PUSH1 0 MSTORE  PUSH1 1 PUSH1 0x20 MSTORE
  //   PUSH1 0 SLOAD PUSH1 0x40 MSTORE  PUSH1 0x60 PUSH1 0 RETURN
  const dodoBody =
    "5b" + "6020600052" + "6001602052" + "600054604052" + "606060" + "00f3";

  const dispatchLen = bytes(header) + bytes(cmp(GET_DODO_POOL_SELECTOR, 0)) + bytes(emptyBody);
  const dodoDest = dispatchLen; // getDODOPool JUMPDEST sits right after the empty-array fallthrough
  const code = header + cmp(GET_DODO_POOL_SELECTOR, dodoDest) + emptyBody + dodoBody;
  return ("0x" + code) as Hex;
}

/** MT fee-rate model shim slot layout: slot0 = the captured resolved mtFeeRate. */
const MT_SHIM_RATE_SLOT = 0;

/** getFeeRate(address) / _FEE_RATE_() selectors — the two readers the DSP + discovery use. */
const GET_FEE_RATE_SELECTOR = "8198edbf";
const FEE_RATE_SELECTOR = "bd2e6ca3";

export interface EtchedDodoPool {
  /** The DSP pool address (the getDODOPool / sell target discovery resolves). */
  pool: Hex;
  /** The DSP implementation address (etched with the real impl runtime). */
  impl: Hex;
  /** The DODO DVMFactory shim (getDODOPool) — point a poolConfig DODOZoo factory here. */
  factory: Hex;
  /** The MT fee-rate model shim (getFeeRate / _FEE_RATE_) at its captured address. */
  mtFeeModel: Hex;
  /** The locally-deployed base/quote tokens (captured decimals). */
  baseToken: Hex;
  quoteToken: Hex;
  /** Captured reserves + resolved fee rates, echoed for the test. */
  baseReserve: bigint;
  quoteReserve: bigint;
  lpFeeRate: bigint;
  mtFeeRate: bigint;
}

/**
 * Stand up the captured REAL DODO V2 DSP pool on the local anvil, OFFLINE.
 *
 *   1. Deploy two MintableERC20s (captured base/quote decimals) — base < NOT sorted: DODO is
 *      base/quote-ORIENTED, not address-sorted (the DSP stores _BASE_TOKEN_/_QUOTE_TOKEN_
 *      explicitly), so we assign base=first, quote=second regardless of address order.
 *   2. setCode the DODO factory shim at the captured factory address; store the pool at slot0.
 *   3. setCode the MT fee-rate model shim at its captured address; store the RESOLVED mtFeeRate.
 *   4. setCode the REAL DSP impl at its captured address + the REAL 45-byte EIP-1167 proxy at the
 *      pool address (the proxy embeds the impl address, so the impl MUST live at its captured
 *      address for the delegatecall to resolve — the same V4 StateView→PoolManager constraint).
 *   5. setStorageAt the pool clone VERBATIM (all captured slots), THEN override base/quote token
 *      (→ local tokens) + the MT fee model slot (→ the shim, which is already at its captured
 *      address, so this is a re-affirm — kept explicit so a snapshot without the raw window still
 *      reconstructs). getPMMStateForCall then recomputes the mainnet-identical PMM state.
 *   6. Fund the pool's base/quote balances with the captured reserves (so sell* can pay out and
 *      so the DSP's balance-minus-reserve paid-amount read is exact), + caller headroom.
 *
 * The swap path then runs the GENUINE DSP bytecode: querySellBase|Quote returns the mainnet-
 * identical dy for the captured PMM state, and sellBase|sellQuote transfers real tokens.
 */
export async function etchDodoPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: DodoBytecodeSnapshot; state: DodoStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint } = {},
): Promise<EtchedDodoPool> {
  const { bytecode, state } = snapshots;
  if (!bytecode.isMinimalProxy || !bytecode.implementation) {
    throw new Error("etchDodoPool expects an EIP-1167 clone snapshot (pool + DSP implementation)");
  }
  const acct = (opts.minter ?? walletClient.account) as Account;

  // 1. Local base/quote tokens with the CAPTURED decimals (DODO stores tokens explicitly and its
  //    PMM state is in raw units — decimals must match so the reserves stay valid raw values).
  const baseToken = await deployToken(
    walletClient, publicClient, `${state.baseSymbol}-local`, state.baseSymbol, Number(state.baseDecimals),
  );
  const quoteToken = await deployToken(
    walletClient, publicClient, `${state.quoteSymbol}-local`, state.quoteSymbol, Number(state.quoteDecimals),
  );

  const poolAddress = getAddress(bytecode.pool.address) as Hex;
  const factory = getAddress(state.factory) as Hex;
  const mtFeeModel = getAddress(state.mtFeeRateModel) as Hex;
  const mtFeeRate = BigInt(state.mtFeeRate);
  const lpFeeRate = BigInt(state.lpFeeRate);
  const baseReserve = BigInt(state.baseReserve);
  const quoteReserve = BigInt(state.quoteReserve);

  // 2. DODO factory shim at the captured factory address; store the pool at slot0.
  await testClient.setCode({ address: factory, bytecode: buildDodoFactoryShimRuntime() });
  await testClient.setStorageAt({ address: factory, index: slotHex(0), value: addrWord(poolAddress) });

  // 3. MT fee-rate model shim at its captured address; store the RESOLVED mtFeeRate at slot0.
  //    Answers BOTH getFeeRate(address) (swap path) and _FEE_RATE_() (discovery fallback) → slot0.
  await testClient.setCode({
    address: mtFeeModel,
    bytecode: buildFactoryShimRuntime(
      [
        { selector: GET_FEE_RATE_SELECTOR, slot: MT_SHIM_RATE_SLOT },
        { selector: FEE_RATE_SELECTOR, slot: MT_SHIM_RATE_SLOT },
      ],
      0n,
    ),
  });
  await testClient.setStorageAt({
    address: mtFeeModel,
    index: slotHex(MT_SHIM_RATE_SLOT),
    value: word(mtFeeRate),
  });

  // 4. Etch the REAL DSP impl at its captured address + the REAL proxy at the pool address.
  const impl = getAddress(bytecode.implementation.address) as Hex;
  await testClient.setCode({ address: impl, bytecode: bytecode.implementation.runtime });
  await testClient.setCode({ address: poolAddress, bytecode: bytecode.pool.runtime });

  // 5. Reconstruct the DSP clone's storage VERBATIM, then repoint tokens + MT model.
  const set = (slot: number, value: Hex) =>
    testClient.setStorageAt({ address: poolAddress, index: slotHex(slot), value });
  for (const [k, v] of Object.entries(state.storage)) {
    await set(Number(k), v);
  }
  await set(DSP_SLOT.baseToken, addrWord(baseToken));
  await set(DSP_SLOT.quoteToken, addrWord(quoteToken));
  await set(DSP_SLOT.mtFeeRateModel, addrWord(mtFeeModel));

  // 6. Fund the pool's reserves (so sell* can pay out + the paid-amount read is exact) + caller.
  await mint(walletClient, publicClient, baseToken, poolAddress, baseReserve);
  await mint(walletClient, publicClient, quoteToken, poolAddress, quoteReserve);
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, baseToken, acct.address as Hex, opts.callerFund);
    await mint(walletClient, publicClient, quoteToken, acct.address as Hex, opts.callerFund);
  }

  return {
    pool: poolAddress,
    impl,
    factory,
    mtFeeModel,
    baseToken,
    quoteToken,
    baseReserve,
    quoteReserve,
    lpFeeRate,
    mtFeeRate,
  };
}

/** DODO DSP read surface (the getters the test + discovery + oracle read on the REAL pool). */
export const dodoPoolReadAbi = parseAbi([
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function _LP_FEE_RATE_() view returns (uint256)",
  "function _MT_FEE_RATE_MODEL_() view returns (address)",
  "function getPMMStateForCall() view returns (uint256 i, uint256 K, uint256 B, uint256 Q, uint256 B0, uint256 Q0, uint256 R)",
  "function querySellBase(address trader, uint256 payBaseAmount) view returns (uint256 receiveQuoteAmount, uint256 mtFee)",
  "function querySellQuote(address trader, uint256 payQuoteAmount) view returns (uint256 receiveBaseAmount, uint256 mtFee)",
  "function version() view returns (string)",
]);

/** DODO DVMFactory shim read surface (getDODOPool — the REAL getter). */
export const dodoFactoryShimAbi = parseAbi([
  "function getDODOPool(address baseToken, address quoteToken) view returns (address[] machines)",
]);

/** MT fee-rate model shim read surface (getFeeRate / _FEE_RATE_). */
export const dodoMtFeeModelShimAbi = parseAbi([
  "function getFeeRate(address trader) view returns (uint256)",
  "function _FEE_RATE_() view returns (uint256)",
]);

// ══════════════════════════════════════════════════════════════════════════════
// Wombat Exchange (single-sided stableswap) prod-mirror etch — ADDITIVE extension.
//
// A Wombat Main Pool is NOT an EIP-1167 clone (like Aerodrome/DODO): it is an EIP-1967 TRANSPARENT
// PROXY delegatecalling a logic impl, and it holds NO tokens itself. Each token's reserve lives in a
// per-token ASSET contract (cash + liability, both WAD, packed in one storage slot; the Asset HOLDS
// the underlying ERC20). So the etch shape is richer than a 2-contract clone: proxy + impl + N assets +
// the underlying ERC20s. The SAME etch-runtime mechanism still applies — setCode the REAL runtimes at
// their captured addresses, setStorageAt the captured state VERBATIM — but with TWO wrinkles:
//
//   • The proxy delegatecalls its impl (the impl address is baked in the proxy runtime as a PUSH20
//     constant AND stored at the EIP-1967 impl slot), so the impl MUST be etched at its captured
//     address for swap/quotePotentialSwap to resolve (the same V4 StateView→PoolManager constraint).
//   • The Asset's `underlyingToken`/`decimals` are IMMUTABLES baked into the Asset bytecode (verified:
//     the token address literally appears in the Asset runtime, NOT in any storage slot), so the test
//     CANNOT repoint them via setStorageAt. It must etch a local MintableERC20 AT THE REAL underlying
//     token address (setCode the MintableERC20 runtime there + seed the `decimals` storage slot). The
//     Asset then transfers/pulls the LOCAL token (identical bytecode, storage-backed balances) while
//     satisfying its immutable == the real address.
//
// NO factory shim is needed: the production FactoryType.Wombat discovery reads addressOfAsset(token) /
// ampFactor() / haircutRate() / cash() / liability() directly off the pool + assets (the FactoryConfig
// `address` IS the pool), so reconstructing the pool + asset state is sufficient for discovery to
// surface the venue. The on-chain execution is callback-free (quotePotentialSwap staticcall + approve +
// pool.swap; Wombat PULLS via transferFrom), so no engine SwapPoolType and no factory/gauge graph.
// ══════════════════════════════════════════════════════════════════════════════

/** One captured Asset runtime + its swap-relevant state (cash/liability packed in slot 8). */
export interface WombatAssetSnapshot {
  address: Hex;
  runtime: Hex;
  runtimeSha256?: Hex;
}

/** Wombat bytecode snapshot: Pool proxy + logic impl + per-token Asset runtimes (keyed by lowercased
 *  underlying token address, matching the state snapshot's `assetsMap`). Underlying ERC20 runtimes are
 *  NOT captured — the test etches its own MintableERC20 at each real token address. */
export interface WombatBytecodeSnapshot {
  chain: string;
  block: string;
  pool: { address: Hex; runtime: Hex; runtimeSha256?: Hex };
  implementation: { address: Hex; runtime: Hex; runtimeSha256?: Hex };
  isMinimalProxy: boolean;
  /** Per-token Asset runtimes, keyed by lowercased underlying token address. */
  assets: Record<string, WombatAssetSnapshot>;
}

/** Per-Asset captured state (cash/liability WAD, underlying + held balance, decimals, raw slot window). */
export interface WombatAssetState {
  address: Hex;
  cash: string;
  liability: string;
  underlyingToken: Hex;
  underlyingBalance: string;
  lpDecimals: number;
  underlyingDecimals: number;
  cashLiabSlot: string;
  storage: Record<string, Hex>;
}

/** Wombat state snapshot (written by harness/wombat-snapshot.ts). */
export interface WombatStateSnapshot {
  chain: string;
  block: string;
  pool: Hex;
  implementation: Hex;
  tokenUSDC: Hex;
  tokenUSDT: Hex;
  decimalsUSDC: number;
  decimalsUSDT: number;
  ampFactor: string;
  haircutRate: string;
  startCovRatio: string;
  endCovRatio: string;
  poolSlots: Record<string, { slot: string; value: Hex }>;
  /** _assets[token] mapping slots, keyed by lowercased token address. */
  assetsMap: Record<string, { slot: Hex; value: Hex; asset: Hex }>;
  poolStorage: Record<string, Hex>;
  assetUSDC: WombatAssetState;
  assetUSDT: WombatAssetState;
  probe: { fromToken: Hex; toToken: Hex; amountIn: string; amountOut: string; haircut: string };
}

/** Load a Wombat `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadWombatSnapshots(name: string): {
  bytecode: WombatBytecodeSnapshot;
  state: WombatStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as WombatBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as WombatStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the Wombat bytecode integrity (NO RPC): re-hash the Pool proxy, impl, and every Asset runtime
 * and match each capture-time sha256 anchor. Returns pool/impl (via verifyBytecodeIntegrity's shape) +
 * per-asset {token, expected, actual, ok}.
 */
export function verifyWombatBytecodeIntegrity(bytecode: WombatBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  implementation: { expected?: Hex; actual: Hex; ok: boolean };
  assets: { token: string; expected?: Hex; actual: Hex; ok: boolean }[];
} {
  const poolActual = runtimeSha256(bytecode.pool.runtime);
  const implActual = runtimeSha256(bytecode.implementation.runtime);
  const assets = Object.entries(bytecode.assets).map(([token, a]) => {
    const actual = runtimeSha256(a.runtime);
    return {
      token,
      expected: a.runtimeSha256,
      actual,
      ok: !a.runtimeSha256 || a.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return {
    pool: {
      expected: bytecode.pool.runtimeSha256,
      actual: poolActual,
      ok: !bytecode.pool.runtimeSha256 || bytecode.pool.runtimeSha256.toLowerCase() === poolActual.toLowerCase(),
    },
    implementation: {
      expected: bytecode.implementation.runtimeSha256,
      actual: implActual,
      ok:
        !bytecode.implementation.runtimeSha256 ||
        bytecode.implementation.runtimeSha256.toLowerCase() === implActual.toLowerCase(),
    },
    assets,
  };
}

// ── MintableERC20 storage layout (verified empirically): slot2 = decimals (uint8). name/symbol/supply/
//    balanceOf/allowance are set by the constructor / mint(); only `decimals()` needs seeding when the
//    runtime is etched at a foreign address (the constructor never ran there). ──
const ERC20_DECIMALS_SLOT = 2;

// EIP-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

export interface EtchedWombatPool {
  /** The Wombat Main Pool proxy address (the quotePotentialSwap/swap + discovery target). */
  pool: Hex;
  /** The logic implementation address (etched with the real impl runtime). */
  impl: Hex;
  /** The from-token (== state.tokenUSDC) — a local MintableERC20 etched at the REAL underlying address. */
  fromToken: Hex;
  /** The to-token (== state.tokenUSDT). */
  toToken: Hex;
  /** The from/to Asset addresses (etched with the real Asset runtimes at their captured addresses). */
  fromAsset: Hex;
  toAsset: Hex;
  /** Captured pool-wide params, echoed for the test. */
  ampFactor: bigint;
  haircutRate: bigint;
}

/**
 * Stand up the captured REAL Wombat Main Pool on the local anvil, OFFLINE.
 *
 *   1. Deploy ONE local MintableERC20 to capture its runtime, then setCode that runtime at EACH real
 *      underlying token address (USDC + USDT) and seed the `decimals` slot — because the Asset's
 *      `underlyingToken` immutable points at the real address, the local token MUST live there.
 *   2. setCode the REAL Pool impl at its captured address + the REAL Pool proxy at the pool address
 *      (the proxy delegatecalls the impl; the impl address is baked in the proxy runtime, so the impl
 *      MUST sit at its captured address).
 *   3. setCode each REAL Asset runtime at its captured address; setStorageAt the captured Asset storage
 *      VERBATIM (slot 8 packs cash|liability — the swap-relevant state).
 *   4. Reconstruct the Pool proxy storage: the EIP-1967 impl slot, the captured linear window (amp 202 /
 *      haircut 203 / covRatio 264 / reentrancy guard 0), and the two hashed _assets[token] mapping slots
 *      (so addressOfAsset(token) resolves each Asset — the production discovery + the swap read this).
 *   5. Fund each Asset with its captured underlying balance (so pool.swap can pay out tokenOut and the
 *      Asset's held-balance invariants hold), + caller headroom in the from-token.
 *
 * The swap path then runs the GENUINE impl + Asset bytecode: quotePotentialSwap returns the mainnet-
 * identical dy for the captured coverage-ratio state, and pool.swap PULLS the from-token via
 * transferFrom + pays out the to-token.
 */
export async function etchWombatPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: WombatBytecodeSnapshot; state: WombatStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint } = {},
): Promise<EtchedWombatPool> {
  const { bytecode, state } = snapshots;
  const acct = (opts.minter ?? walletClient.account) as Account;

  const pool = getAddress(state.pool) as Hex;
  const impl = getAddress(bytecode.implementation.address) as Hex;
  const fromToken = getAddress(state.tokenUSDC) as Hex;
  const toToken = getAddress(state.tokenUSDT) as Hex;

  // 1. Capture a local MintableERC20 runtime, then etch it at EACH real underlying token address.
  //    (The Asset bakes underlyingToken as an immutable → the local token must live at the real addr.)
  const scratch = await deployToken(walletClient, publicClient, "wombat-scratch", "WSCR", 18);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  for (const [tok, dec] of [
    [fromToken, state.decimalsUSDC],
    [toToken, state.decimalsUSDT],
  ] as [Hex, number][]) {
    await testClient.setCode({ address: tok, bytecode: erc20Runtime });
    await testClient.setStorageAt({ address: tok, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(dec)) });
  }

  // 2. Etch the REAL impl at its captured address + the REAL proxy at the pool address.
  await testClient.setCode({ address: impl, bytecode: bytecode.implementation.runtime });
  await testClient.setCode({ address: pool, bytecode: bytecode.pool.runtime });

  // 3. Etch each REAL Asset runtime at its captured address + setStorageAt its captured storage verbatim.
  const assetByToken: Record<string, WombatAssetState> = {
    [fromToken.toLowerCase()]: state.assetUSDC,
    [toToken.toLowerCase()]: state.assetUSDT,
  };
  for (const [tokLower, aState] of Object.entries(assetByToken)) {
    const assetRuntime = bytecode.assets[tokLower];
    if (!assetRuntime) throw new Error(`no Asset runtime in snapshot for token ${tokLower}`);
    const assetAddr = getAddress(aState.address) as Hex;
    await testClient.setCode({ address: assetAddr, bytecode: assetRuntime.runtime });
    for (const [k, v] of Object.entries(aState.storage)) {
      await testClient.setStorageAt({ address: assetAddr, index: slotHex(Number(k)), value: v });
    }
  }

  // 4. Reconstruct the Pool proxy storage: EIP-1967 impl slot, the captured linear window, and the two
  //    hashed _assets[token] mapping slots (addressOfAsset(token) → the Asset).
  await testClient.setStorageAt({ address: pool, index: EIP1967_IMPL_SLOT, value: addrWord(impl) });
  for (const [k, v] of Object.entries(state.poolStorage)) {
    await testClient.setStorageAt({ address: pool, index: slotHex(Number(k)), value: v });
  }
  for (const entry of Object.values(state.assetsMap)) {
    await testClient.setStorageAt({ address: pool, index: entry.slot, value: entry.value });
  }

  // 5. Fund each Asset with its captured held underlying balance, + caller headroom in the from-token.
  await mint(walletClient, publicClient, fromToken, getAddress(state.assetUSDC.address) as Hex, BigInt(state.assetUSDC.underlyingBalance));
  await mint(walletClient, publicClient, toToken, getAddress(state.assetUSDT.address) as Hex, BigInt(state.assetUSDT.underlyingBalance));
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, fromToken, acct.address as Hex, opts.callerFund);
  }

  return {
    pool,
    impl,
    fromToken,
    toToken,
    fromAsset: getAddress(state.assetUSDC.address) as Hex,
    toAsset: getAddress(state.assetUSDT.address) as Hex,
    ampFactor: BigInt(state.ampFactor),
    haircutRate: BigInt(state.haircutRate),
  };
}

/** Wombat Pool read surface (the getters the test + discovery + oracle read on the REAL pool). */
export const wombatPoolReadAbi = parseAbi([
  "function addressOfAsset(address token) view returns (address)",
  "function ampFactor() view returns (uint256)",
  "function haircutRate() view returns (uint256)",
  "function quotePotentialSwap(address fromToken, address toToken, int256 fromAmount) view returns (uint256 potentialOutcome, uint256 haircut)",
]);

/** Wombat Asset read surface (cash/liability WAD; underlyingToken immutable). */
export const wombatAssetReadAbi = parseAbi([
  "function cash() view returns (uint120)",
  "function liability() view returns (uint120)",
  "function underlyingToken() view returns (address)",
  "function decimals() view returns (uint8)",
]);

// ══════════════════════════════════════════════════════════════════════════════
// WOOFi (WooPPV2 sPMM v2) prod-mirror etch — ADDITIVE extension of this harness.
//
// A WooPPV2 pool is NOT an EIP-1167 clone (like Aerodrome/DODO) and NOT a Wombat-style asset graph: it is
// an EIP-1967 TRANSPARENT PROXY delegatecalling a sPMM logic impl, plus a SEPARATE WooracleV2 price feed
// contract, plus TWO Chainlink CL aggregator feeds the oracle consults for feasibility/staleness. So the
// FULL swap/quote dependency graph the test reproduces is:
//
//   WooPPV2 proxy 0x5520…9FA4  (EIP-1967 transparent proxy)
//     └ delegatecall → WooPPV2 impl  (the sPMM query/swap math)
//          ├ tokenIn.balanceOf(pool)              (transfer-first: sold = balanceOf − tokenInfos.reserve)
//          ├ WooracleV2.state(base)                → the sPMM price/spread/coeff + feasibility
//          │    ├ CL[base].latestRoundData()       (Chainlink base/USD feed)
//          │    └ CL[quote].latestRoundData()      (Chainlink quote/USD feed)
//          └ tokenInfos(base) / quoteToken()       (per-base feeRate + reserve; numeraire)
//
// The SAME etch-runtime mechanism applies for the pool + impl + oracle — setCode the REAL runtimes at their
// captured addresses, setStorageAt the captured state VERBATIM — with THREE wrinkles unique to WOOFi:
//
//   • EIP-1967 impl slot. The proxy delegatecalls the impl address stored at the EIP-1967 impl slot (NOT a
//     PUSH20 in the runtime like an EIP-1167 clone), so we reconstruct that slot + etch the REAL impl at its
//     captured address (the same V4 StateView→PoolManager immutable constraint — the swap resolves only when
//     the impl sits at the address the slot names).
//   • MAPPING-KEYED STATE. WooPPV2.tokenInfos(base), WooracleV2.woState(base)/clOracles(base)/clOracles(quote)
//     are all mapping entries keyed by the REAL token address (keccak(token, baseSlot)). They CANNOT be
//     repointed at a fresh local token by overwriting a scalar (like Solidly's token0 slot) — the keys would
//     no longer match. So (mirroring Wombat's immutable-underlying) the test etches a local MintableERC20
//     runtime AT EACH REAL token address (USDT + USDC) and seeds its `decimals` slot; every captured mapping
//     slot then stays valid and the pool moves the local (storage-backed) tokens.
//   • CHAINLINK FEEDS ARE AGGREGATOR PROXIES that DELEGATECALL an underlying aggregator NOT in the capture —
//     so their REAL runtime cannot be etched and made to answer latestRoundData() (it forwards to an
//     uncaptured aggregator). Per the capture note, the test etches a tiny READ-ONLY CL SHIM at each CL feed
//     address that returns the CAPTURED latestRoundData 5-tuple (roundId, answer, startedAt, updatedAt,
//     answeredInRound) + decimals — the deterministic values state() gated on at the pinned block. The block
//     TIMESTAMP must be pinned in the test (setNextBlockTimestamp) so state()'s WO-staleness (block.timestamp
//     ≤ oracle.timestamp + staleDuration) + the CL updatedAt windows pass exactly as at capture.
//
// NO factory shim is needed: FactoryType.WOOFi discovery reads quoteToken()/wooracle()/tokenInfos()/
// state()/decimals() directly off the pool + oracle (the FactoryConfig `address` IS the WooPPV2 pool). The
// on-chain execution is callback-free (query() staticcall → transfer → pool.swap; WooPPV2 is TRANSFER-FIRST),
// so no engine SwapPoolType and no router/gauge graph.
// ══════════════════════════════════════════════════════════════════════════════

/** WOOFi bytecode snapshot: WooPPV2 proxy + impl + dependency runtimes (wooracle + the two CL feeds). */
export interface WooFiBytecodeSnapshot {
  chain: string;
  chainId?: number;
  block: string;
  blockTimestamp?: string;
  pool: { address: Hex; runtime: Hex; runtimeSha256?: Hex };
  implementation: { address: Hex; runtime: Hex; runtimeSha256?: Hex };
  isMinimalProxy: boolean;
  /** wooracle + clBase + clQuote real runtimes (each sha256-anchored). */
  dependencies: {
    wooracle: DependencyBytecode;
    clBase: DependencyBytecode;
    clQuote: DependencyBytecode;
  };
}

/** One captured Chainlink round (the deterministic latestRoundData the CL shim replays). */
export interface WooFiClRound {
  token: Hex;
  feed: Hex;
  decimals: number;
  oracleDecimal: number;
  cloPreferred: boolean;
  latestRoundData: {
    roundId: string;
    answer: string;
    startedAt: string;
    updatedAt: string;
    answeredInRound: string;
  };
}

/** WOOFi state snapshot (written by harness/woofi-snapshot.ts). */
export interface WooFiStateSnapshot {
  chain: string;
  chainId?: number;
  block: string;
  blockTimestamp: string;
  source: string;
  pool: Hex;
  poolImpl: Hex;
  eip1967ImplSlot: Hex;
  wooracle: Hex;
  tokenIn: Hex; // == base (sellBase: base → quote)
  tokenOut: Hex; // == quote
  base: Hex;
  quote: Hex;
  sellBase: boolean;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  decimalsIn: number;
  decimalsOut: number;
  oracle: {
    quoteToken: Hex;
    price: string;
    spread: string;
    coeff: string;
    woFeasible: boolean;
    priceDecimals: number;
    quoteDecimals: number;
    timestamp: string;
    staleDuration: string;
    bound: string;
    woState: { price: string; spread: string; coeff: string; woFeasible: boolean };
  };
  tokenInfos: { reserve: string; feeRate: string; maxGamma: string; maxNotionalSwap: string };
  reserves: { usdc: string; usdt: string };
  clOracles: { base: WooFiClRound; quote: WooFiClRound };
  storage: {
    wooracle: Record<string, Hex>;
    pool: Record<string, Hex>;
  };
  probe: { fromToken: Hex; toToken: Hex; fromAmount: string; toAmount: string };
}

/** Load a WOOFi `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadWooFiSnapshots(name: string): {
  bytecode: WooFiBytecodeSnapshot;
  state: WooFiStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as WooFiBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as WooFiStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the WOOFi bytecode integrity (NO RPC): re-hash the WooPPV2 proxy, impl, and the wooracle + both CL
 * feed runtimes and match each capture-time sha256 anchor. Returns pool/impl (via verifyBytecodeIntegrity's
 * shape) + per-dependency {name, expected, actual, ok}. (The two CL runtimes carry anchors too even though
 * the test etches SHIMS in their place — the anchor still proves the CAPTURED real runtime blob is intact.)
 */
export function verifyWooFiBytecodeIntegrity(bytecode: WooFiBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  implementation: { expected?: Hex; actual: Hex; ok: boolean };
  dependencies: { name: string; expected?: Hex; actual: Hex; ok: boolean }[];
} {
  const poolActual = runtimeSha256(bytecode.pool.runtime);
  const implActual = runtimeSha256(bytecode.implementation.runtime);
  const dependencies = Object.entries(bytecode.dependencies).map(([name, d]) => {
    const actual = runtimeSha256(d.runtime);
    return {
      name,
      expected: d.runtimeSha256,
      actual,
      ok: !d.runtimeSha256 || d.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return {
    pool: {
      expected: bytecode.pool.runtimeSha256,
      actual: poolActual,
      ok: !bytecode.pool.runtimeSha256 || bytecode.pool.runtimeSha256.toLowerCase() === poolActual.toLowerCase(),
    },
    implementation: {
      expected: bytecode.implementation.runtimeSha256,
      actual: implActual,
      ok:
        !bytecode.implementation.runtimeSha256 ||
        bytecode.implementation.runtimeSha256.toLowerCase() === implActual.toLowerCase(),
    },
    dependencies,
  };
}

/**
 * Build a tiny READ-ONLY Chainlink-feed shim runtime that replays a CAPTURED round.
 *
 * Answers exactly the two selectors WooracleV2.state() calls on a CL feed:
 *   latestRoundData() feaf968c → the 5-word tuple (roundId, answer, startedAt, updatedAt, answeredInRound)
 *   decimals()        313ce567 → the feed's uint8 decimals
 * Any UNLISTED selector returns a single zero word (an explicit default — state() touches no other CL getter).
 *
 * The round is HARDCODED as PUSH32 constants in the return body (the values are captured constants — no
 * storage seeding needed). `answer` is an int256 stored as its two's-complement 256-bit word; all captured
 * answers are positive (a USD stable feed), so the raw bigint is the correct word. Hand-assembled with an
 * offset-exact JUMPDEST per body, so it needs NO Solidity compile and NO write tx.
 */
export function buildChainlinkFeedShimRuntime(round: {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
  decimals: bigint;
}): Hex {
  const bytes = (h: string) => h.length / 2;
  const w = (v: bigint) => {
    // int256/uint256 two's-complement 256-bit word (positive values fit directly).
    const masked = ((v % (1n << 256n)) + (1n << 256n)) % (1n << 256n);
    return masked.toString(16).padStart(64, "0");
  };
  // latestRoundData body: mstore each of 5 words at 0x00,0x20,0x40,0x60,0x80 then return(0,0xa0).
  //   PUSH32 <word> PUSH1 <off> MSTORE  (×5), then PUSH1 0xa0 PUSH1 0 RETURN.
  const mstore = (word: bigint, off: number) =>
    "7f" + w(word) + "60" + off.toString(16).padStart(2, "0") + "52";
  const lrdBody =
    "5b" + // JUMPDEST
    mstore(round.roundId, 0x00) +
    mstore(round.answer, 0x20) +
    mstore(round.startedAt, 0x40) +
    mstore(round.updatedAt, 0x60) +
    mstore(round.answeredInRound, 0x80) +
    "60a0" + "6000" + "f3"; // PUSH1 0xa0 PUSH1 0 RETURN (return(0, 0xa0))
  // decimals body: PUSH32 <dec> PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN.
  const decBody = "5b" + "7f" + w(round.decimals) + "600052602060" + "00f3";
  // default body (fallthrough): return one zero word.
  const zeroBody = "600060005260206000" + "f3"; // PUSH1 0 PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN

  const header = "60003560e01c"; // sel = shr(0xe0, calldataload(0))
  const cmp = (sel: string, dest: number) =>
    "8063" + sel + "1461" + dest.toString(16).padStart(4, "0") + "57"; // DUP1 PUSH4 sel EQ PUSH2 dest JUMPI

  // Dispatch: header + cmp(latestRoundData) + cmp(decimals) + zero-body fallthrough, THEN the two JUMPDEST bodies.
  const dispatchLen =
    bytes(header) + bytes(cmp("00000000", 0)) + bytes(cmp("00000000", 0)) + bytes(zeroBody);
  const lrdDest = dispatchLen;
  const decDest = lrdDest + bytes(lrdBody);
  const code =
    header +
    cmp("feaf968c", lrdDest) + // latestRoundData()
    cmp("313ce567", decDest) + // decimals()
    zeroBody +
    lrdBody +
    decBody;
  return ("0x" + code) as Hex;
}

// EIP-1967 impl slot: reuse the constant defined for Wombat (EIP1967_IMPL_SLOT), and the ERC20 decimals slot.

export interface EtchedWooFiPool {
  /** The WooPPV2 pool proxy address (the query/swap + discovery target — captured mainnet address). */
  pool: Hex;
  /** The sPMM logic implementation address (etched with the real impl runtime at its captured address). */
  impl: Hex;
  /** The WooracleV2 price-feed address (etched with the real oracle runtime at its captured address). */
  wooracle: Hex;
  /** The two Chainlink CL feed addresses (etched with the read-only round shims at their captured addresses). */
  clBase: Hex;
  clQuote: Hex;
  /** The tokenIn (== base, sellBase) — a local MintableERC20 etched at the REAL base token address. */
  tokenIn: Hex;
  /** The tokenOut (== quote). */
  tokenOut: Hex;
  base: Hex;
  quote: Hex;
  /** Captured per-base config, echoed for the test. */
  reserve: bigint;
  feeRate: bigint;
  /** Captured oracle state, echoed for the test. */
  price: bigint;
  spread: bigint;
  coeff: bigint;
  /** The pinned capture block timestamp — the test MUST setNextBlockTimestamp to this before cook. */
  blockTimestamp: bigint;
}

/**
 * Stand up the captured REAL Arbitrum WooPPV2 sPMM pool on the local anvil, OFFLINE.
 *
 *   1. Capture a local MintableERC20 runtime, then etch it AT EACH real token address (base + quote) and
 *      seed its `decimals` slot — because tokenInfos/woState/clOracles are keyed by the REAL token address,
 *      the local tokens MUST live at those addresses (mirrors Wombat's immutable-underlying etch).
 *   2. setCode the REAL WooPPV2 impl at its captured address + the REAL proxy at the pool address (the proxy
 *      delegatecalls the impl named by the EIP-1967 slot, so the impl MUST sit at its captured address).
 *   3. setCode the REAL WooracleV2 runtime at its captured address; setStorageAt its captured storage verbatim.
 *   4. setCode a read-only CL shim at EACH CL feed address, replaying its captured latestRoundData + decimals
 *      (the real CL runtimes are aggregator proxies delegating to uncaptured aggregators — a shim is the only
 *      faithful offline stand-in, and the captured rounds are the deterministic values state() gated on).
 *   5. setStorageAt the WooPPV2 proxy storage verbatim (EIP-1967 impl slot + quoteToken/wooracle/feeAddr +
 *      the packed tokenInfos(base) slots) and the wooracle storage verbatim (already in step 3).
 *   6. Fund the pool's BASE balance to EXACTLY tokenInfos.reserve (so the transfer-first sold = balanceOf −
 *      reserve reads the transferred amount) and its QUOTE balance generously (so swap can pay out), + caller
 *      headroom in tokenIn.
 *
 * The swap path then runs the GENUINE impl + oracle bytecode: query(base, quote, dx) reads the LIVE oracle
 * state (gated on the pinned timestamp + the CL shims) and returns the mainnet-identical toAmount, and swap()
 * computes sold from the transferred balance and pays out the quote.
 */
export async function etchWooFiPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: WooFiBytecodeSnapshot; state: WooFiStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint } = {},
): Promise<EtchedWooFiPool> {
  const { bytecode, state } = snapshots;
  const acct = (opts.minter ?? walletClient.account) as Account;

  const pool = getAddress(state.pool) as Hex;
  const impl = getAddress(bytecode.implementation.address) as Hex;
  const wooracle = getAddress(state.wooracle) as Hex;
  const base = getAddress(state.base) as Hex;
  const quote = getAddress(state.quote) as Hex;
  const tokenIn = getAddress(state.tokenIn) as Hex; // == base (sellBase)
  const tokenOut = getAddress(state.tokenOut) as Hex; // == quote
  const clBase = getAddress(state.clOracles.base.feed) as Hex;
  const clQuote = getAddress(state.clOracles.quote.feed) as Hex;
  const reserve = BigInt(state.tokenInfos.reserve);
  const feeRate = BigInt(state.tokenInfos.feeRate);
  const blockTimestamp = BigInt(state.blockTimestamp);

  // 1. Capture a local MintableERC20 runtime, then etch it at EACH real token address + seed decimals.
  const scratch = await deployToken(walletClient, publicClient, "woofi-scratch", "WSCR", 18);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  for (const [tok, dec] of [
    [base, state.decimalsIn],
    [quote, state.decimalsOut],
  ] as [Hex, number][]) {
    await testClient.setCode({ address: tok, bytecode: erc20Runtime });
    await testClient.setStorageAt({ address: tok, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(dec)) });
  }

  // 2. Etch the REAL impl at its captured address + the REAL proxy at the pool address.
  await testClient.setCode({ address: impl, bytecode: bytecode.implementation.runtime });
  await testClient.setCode({ address: pool, bytecode: bytecode.pool.runtime });

  // 3. Etch the REAL WooracleV2 runtime at its captured address + setStorageAt its captured storage verbatim.
  await testClient.setCode({ address: wooracle, bytecode: bytecode.dependencies.wooracle.runtime });
  for (const [k, v] of Object.entries(state.storage.wooracle)) {
    await testClient.setStorageAt({ address: wooracle, index: k as Hex, value: v });
  }

  // 4. Etch a read-only CL shim at EACH CL feed address, replaying its captured latestRoundData + decimals.
  for (const cl of [state.clOracles.base, state.clOracles.quote]) {
    const rd = cl.latestRoundData;
    const shim = buildChainlinkFeedShimRuntime({
      roundId: BigInt(rd.roundId),
      answer: BigInt(rd.answer),
      startedAt: BigInt(rd.startedAt),
      updatedAt: BigInt(rd.updatedAt),
      answeredInRound: BigInt(rd.answeredInRound),
      decimals: BigInt(cl.decimals),
    });
    await testClient.setCode({ address: getAddress(cl.feed) as Hex, bytecode: shim });
  }

  // 5. setStorageAt the WooPPV2 proxy storage verbatim (EIP-1967 impl slot + scalars + packed tokenInfos).
  for (const [k, v] of Object.entries(state.storage.pool)) {
    await testClient.setStorageAt({ address: pool, index: k as Hex, value: v });
  }
  // Re-affirm the EIP-1967 impl slot from the typed field (already in storage.pool, but explicit so a
  // snapshot without the raw window still resolves the delegate).
  await testClient.setStorageAt({ address: pool, index: state.eip1967ImplSlot, value: addrWord(impl) });

  // 6. Fund the pool: BASE to EXACTLY tokenInfos.reserve (transfer-first sold = balanceOf − reserve), QUOTE
  //    generously (so swap pays out), + caller headroom in tokenIn.
  await mint(walletClient, publicClient, base, pool, reserve);
  await mint(walletClient, publicClient, quote, pool, BigInt(state.reserves.usdc));
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, tokenIn, acct.address as Hex, opts.callerFund);
  }

  return {
    pool,
    impl,
    wooracle,
    clBase,
    clQuote,
    tokenIn,
    tokenOut,
    base,
    quote,
    reserve,
    feeRate,
    price: BigInt(state.oracle.price),
    spread: BigInt(state.oracle.spread),
    coeff: BigInt(state.oracle.coeff),
    blockTimestamp,
  };
}

/** WooPPV2 pool read surface (the getters the test + discovery + oracle read on the REAL pool). */
export const wooFiPoolReadAbi = parseAbi([
  "function quoteToken() view returns (address)",
  "function wooracle() view returns (address)",
  "function tokenInfos(address token) view returns (uint192 reserve, uint16 feeRate, uint128 maxGamma, uint128 maxNotionalSwap)",
  "function query(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)",
  "function tryQuery(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)",
]);

/** WooracleV2 read surface (state / decimals — the sPMM inputs the test cross-checks). */
export const wooracleV2ReadAbi = parseAbi([
  "function state(address base) view returns (uint128 price, uint64 spread, uint64 coeff, bool woFeasible)",
  "function decimals(address base) view returns (uint8)",
  "function clOracles(address token) view returns (address oracle, int8 decimal, bool cloPreferred)",
]);

/** Chainlink CL feed read surface (the two getters the CL shim answers). */
export const chainlinkFeedReadAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

// ══════════════════════════════════════════════════════════════════════════════
// Balancer V2 ComposableStable prod-mirror etch — ADDITIVE extension of this harness.
//
// A Balancer ComposableStable pool is NEITHER an EIP-1167 clone (Aerodrome/DODO) NOR a proxy (Wombat/
// WOOFi): it is a SELF-CONTAINED contract holding its whole StableMath state (amp / scaling / swap fee /
// name / symbol) in its own low storage slots — and it holds NO tokens. The registered token BALANCES
// live in the canonical Balancer V2 Vault (0xBA12…, the engine `_swapBalancerV2` constant) under a
// per-poolId EnumerableMap. So the FULL swap/quote dependency graph the engine touches is exactly:
//
//   ComposableStablePool 0x8353…Cb2aF   (self-contained; getPoolId / StableMath getters)
//     └ Balancer V2 Vault 0xBA12…        (holds the pooled tokens; Vault.swap(GIVEN_IN) does the math?
//          — NO: the Vault CALLS pool.onSwap(...), which runs the StableMath, then the Vault moves the
//            registered assets. Both runtimes are real + captured, so the whole path runs offline.)
//
// The etch shape (mirrors Wombat/WOOFi's immutable/mapping-keyed token constraint):
//   • The Vault's per-pool accounting (`_generalPoolsBalances[poolId]`, an EnumerableMap) is keyed by the
//     REAL poolId (whose first 20 bytes ARE the real pool address) and stores the REAL token addresses in
//     its `_keys[i]` / `_indexes[token]` slots. Those keys CANNOT be repointed by overwriting one scalar
//     (Solidly-style) — the keccak keys would no longer match. So the pool MUST be etched at its captured
//     address (so getPoolId is consistent) and each REAL non-BPT token MUST be a local MintableERC20 etched
//     AT its real address (setCode the ERC20 runtime there + seed `decimals`), exactly like Wombat's
//     immutable-underlying / WOOFi's mapping-keyed tokens. The BPT (`_keys[bptIndex]` == the pool address)
//     is NOT a swap token and is NOT repointed — StableMath excludes it.
//   • Every captured Vault slot (the EnumerableMap `_length`, `_keys[i]`, the packed BalanceAllocation at
//     `_keys[i]+1`, `_indexes[token]`, and the registration flag) is applied VERBATIM by its ABSOLUTE key,
//     so getPoolTokens reconstructs the mainnet balances byte-identically and the real Vault.swap runs.
//   • Every captured pool slot (0..31) is applied VERBATIM, so getAmplificationParameter / getScalingFactors
//     / getSwapFeePercentage / getBptIndex return the mainnet values the production discovery reads.
//
// NO factory shim is needed: FactoryType.BalancerV2 discovery is KNOWN-POOL-ADDRESS based — the
// FactoryConfig.address IS the Vault (canonical) and `balancerStablePools` carries the pool address; the
// discovery reads getPoolId off the pool then getPoolTokens off the Vault (both etched real runtimes).
// The on-chain execution is the EXISTING engine BalancerV2 dispatch (poolType 4 → _swapBalancerV2 →
// pool.getPoolId() → Vault.swap(SingleSwap{GIVEN_IN})), so no engine SwapPoolType is added.
//
// FIDELITY: this fixture's picked pool has ZERO rate providers (getRateProviders() all address(0)), so
// onSwap makes NO external rate-provider call — the dependency graph is EXACTLY {Vault, pool}, both real
// runtimes captured. NO stubs, NO shims, NO read-only stand-ins. Full real-code parity offline.
// ══════════════════════════════════════════════════════════════════════════════

/** One registered token in the Balancer pool's Vault token list (INCLUDING the BPT at bptIndex). */
export interface BalancerStateToken {
  address: Hex;
  symbol: string;
  decimals: number;
  isBpt: boolean;
  balance: string;
}

/** Balancer bytecode snapshot: the self-contained pool + the Vault dependency runtime (both sha256-anchored). */
export interface BalancerBytecodeSnapshot extends PoolBytecodeSnapshot {
  dependencies?: DependencyBytecode[];
}

/** Balancer state snapshot (written by harness/balancer-snapshot.ts). */
export interface BalancerStateSnapshot {
  chain: string;
  block: string;
  vault: Hex;
  pool: Hex;
  poolId: Hex;
  poolName: string;
  poolSymbol: string;
  poolVersion: string;
  specialization: number;
  authorizer: Hex;
  protocolFeesCollector: Hex;
  amp: string;
  ampPrecision: string;
  swapFeeWad: string;
  bptIndex: number;
  scalingFactors: string[];
  rateProviders: Hex[];
  lastChangeBlock: string;
  tokens: BalancerStateToken[];
  vaultLayout: { generalPoolBalancesBase: number; poolRegistrationBase: number; enumerableMapStructRoot: Hex; note: string };
  /** Every captured Vault slot, ABSOLUTE storage key → value (set verbatim on the etched Vault). */
  vaultSlots: Record<string, Hex>;
  vaultSlotNotes: { key: Hex; value: Hex; note: string }[];
  /** Pool storage window 0..31 (set verbatim on the etched pool). */
  poolStorage: Record<string, Hex>;
  probe: { tokenIn: Hex; tokenInSymbol: string; tokenOut: Hex; tokenOutSymbol: string; amountIn: string; amountOut: string };
}

/** Load a Balancer `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadBalancerSnapshots(name: string): {
  bytecode: BalancerBytecodeSnapshot;
  state: BalancerStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as BalancerBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as BalancerStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the Balancer bytecode integrity (NO RPC): re-hash the pool runtime + the Vault dependency runtime
 * and match each capture-time sha256 anchor. Returns pool (via verifyBytecodeIntegrity's shape) +
 * per-dependency {name, expected, actual, ok}. Reuses verifyDodoBytecodeIntegrity's structure — the
 * Balancer snapshot has the SAME {pool, dependencies[]} shape.
 */
export function verifyBalancerBytecodeIntegrity(bytecode: BalancerBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  dependencies: { name: string; expected?: Hex; actual: Hex; ok: boolean }[];
} {
  const base = verifyBytecodeIntegrity(bytecode);
  const dependencies = (bytecode.dependencies ?? []).map((d) => {
    const actual = runtimeSha256(d.runtime);
    return {
      name: d.name,
      expected: d.runtimeSha256,
      actual,
      ok: !d.runtimeSha256 || d.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { pool: base.pool, dependencies };
}

export interface EtchedBalancerPool {
  /** The ComposableStable pool address (the getPoolId / discovery / swap target — captured mainnet address). */
  pool: Hex;
  /** The Balancer V2 Vault address (etched with the real Vault runtime at the canonical 0xBA12…). */
  vault: Hex;
  /** The pool's real poolId (getPoolId returns it; the Vault accounting is keyed by it). */
  poolId: Hex;
  /** The swap tokenIn/tokenOut — local MintableERC20s etched at the REAL token addresses. */
  tokenIn: Hex;
  tokenOut: Hex;
  /** The NON-BPT registered token addresses (each a local MintableERC20 at its real address). */
  nonBptTokens: Hex[];
  /** The 0-based bptIndex in the full registered token list. */
  bptIndex: number;
}

/**
 * Stand up the captured REAL Balancer V2 ComposableStable pool + Vault on the local anvil, OFFLINE.
 *
 *   1. Capture a local MintableERC20 runtime, then etch it AT EACH real NON-BPT token address + seed its
 *      `decimals` slot — because the Vault's `_keys`/`_indexes` are keyed by the real token addresses, the
 *      local tokens MUST live at those addresses (mirrors Wombat's immutable-underlying / WOOFi's mapping-
 *      keyed token etch). The BPT (`_keys[bptIndex]` == the pool address) is NOT a swap token, not repointed.
 *   2. setCode the REAL Vault runtime at the canonical 0xBA12… + setStorageAt every captured Vault slot
 *      VERBATIM by its ABSOLUTE key (the EnumerableMap `_length`/`_keys`/packed BalanceAllocation/`_indexes`
 *      + the pool-registration flag) — so getPoolTokens reconstructs the mainnet balances byte-identically.
 *   3. setCode the REAL pool runtime at its captured address + setStorageAt its captured 0..31 storage
 *      VERBATIM — so the StableMath getters return the mainnet amp / scaling / fee / bptIndex.
 *   4. Fund the Vault with each NON-BPT token's captured registered balance (so Vault.swap can pay out), +
 *      caller headroom in tokenIn.
 *
 * The swap path then runs the GENUINE Vault + pool bytecode: Vault.swap(GIVEN_IN) calls pool.onSwap (the
 * real StableMath A-invariant) and moves the registered assets — the mainnet-identical dy for the captured
 * balances, with NO fork and NO RPC. `opts.tokenInAddr`/`tokenOutAddr` pick the swap pair (default: the
 * first two NON-BPT tokens, matching the captured probe direction).
 */
export async function etchBalancerPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: BalancerBytecodeSnapshot; state: BalancerStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint; tokenInAddr?: Hex; tokenOutAddr?: Hex } = {},
): Promise<EtchedBalancerPool> {
  const { bytecode, state } = snapshots;
  const vaultDep = (bytecode.dependencies ?? []).find((d) => BigInt(d.address) === BigInt(state.vault));
  if (!vaultDep) throw new Error("etchBalancerPool: no Balancer V2 Vault runtime in the bytecode snapshot");
  const acct = (opts.minter ?? walletClient.account) as Account;

  const pool = getAddress(state.pool) as Hex;
  const vault = getAddress(state.vault) as Hex;
  const bptIndex = state.bptIndex;

  // 1. Capture a local MintableERC20 runtime, etch it at each REAL non-BPT token address + seed decimals.
  const scratch = await deployToken(walletClient, publicClient, "balancer-scratch", "BSCR", 18);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  const nonBptTokens: Hex[] = [];
  for (let k = 0; k < state.tokens.length; k++) {
    const t = state.tokens[k];
    if (t.isBpt) continue; // the BPT is the pool itself — not a swap token, not repointed
    const tok = getAddress(t.address) as Hex;
    await testClient.setCode({ address: tok, bytecode: erc20Runtime });
    await testClient.setStorageAt({ address: tok, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(t.decimals)) });
    nonBptTokens.push(tok);
  }

  // 2. Etch the REAL Vault at the canonical address + setStorageAt every captured Vault slot VERBATIM.
  await testClient.setCode({ address: vault, bytecode: vaultDep.runtime });
  for (const [key, val] of Object.entries(state.vaultSlots)) {
    await testClient.setStorageAt({ address: vault, index: key as Hex, value: val });
  }

  // 3. Etch the REAL pool at its captured address + setStorageAt its captured 0..31 storage VERBATIM.
  await testClient.setCode({ address: pool, bytecode: bytecode.pool.runtime });
  for (const [k, v] of Object.entries(state.poolStorage)) {
    await testClient.setStorageAt({ address: pool, index: slotHex(Number(k)), value: v });
  }

  // 4. Fund the Vault with each NON-BPT token's captured registered balance (so Vault.swap can pay out), +
  //    caller headroom in tokenIn.
  for (let k = 0; k < state.tokens.length; k++) {
    const t = state.tokens[k];
    if (t.isBpt) continue;
    await mint(walletClient, publicClient, getAddress(t.address) as Hex, vault, BigInt(t.balance));
  }
  const tokenIn = getAddress(opts.tokenInAddr ?? nonBptTokens[0]) as Hex;
  const tokenOut = getAddress(opts.tokenOutAddr ?? nonBptTokens[1]) as Hex;
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, tokenIn, acct.address as Hex, opts.callerFund);
  }

  return { pool, vault, poolId: state.poolId, tokenIn, tokenOut, nonBptTokens, bptIndex };
}

/** Balancer ComposableStable pool read surface (the getters the test + discovery read on the REAL pool). */
export const balancerPoolReadAbi = parseAbi([
  "function getPoolId() view returns (bytes32)",
  "function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)",
  "function getScalingFactors() view returns (uint256[] scalingFactors)",
  "function getSwapFeePercentage() view returns (uint256)",
  "function getBptIndex() view returns (uint256)",
  "function getRateProviders() view returns (address[])",
]);

/** Balancer V2 Vault read + swap surface (getPoolTokens for reconstruction, swap/queryBatchSwap for the
 *  ground-truth cross-check the test reads on the etched real Vault). */
export const balancerVaultReadAbi = parseAbi([
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
  "function getPool(bytes32 poolId) view returns (address, uint8)",
  "struct SingleSwap { bytes32 poolId; uint8 kind; address assetIn; address assetOut; uint256 amount; bytes userData; }",
  "struct FundManagement { address sender; bool fromInternalBalance; address recipient; bool toInternalBalance; }",
  "function swap(SingleSwap singleSwap, FundManagement funds, uint256 limit, uint256 deadline) returns (uint256)",
  "struct BatchSwapStep { bytes32 poolId; uint256 assetInIndex; uint256 assetOutIndex; uint256 amount; bytes userData; }",
  "function queryBatchSwap(uint8 kind, BatchSwapStep[] swaps, address[] assets, FundManagement funds) returns (int256[])",
]);

// ══════════════════════════════════════════════════════════════════════════════
// Curve StableSwap-NG prod-mirror etch — ADDITIVE extension of this harness.
//
// A Curve StableSwap-NG plain pool is a SELF-CONTAINED Vyper contract (NOT a proxy, NOT an
// EIP-1167 clone): its whole invariant state (A/fee/balances/admin-balances/rate-oracle
// bookkeeping) lives in its own LINEAR storage slots, and the two coins are baked as IMMUTABLES
// in the runtime bytecode (verified: `coins(0)`/`coins(1)` resolve to the real token addresses
// straight from an etched runtime with NO storage seeding). So the etch shape is the leanest of
// all the sources: setCode the ONE real runtime + setStorageAt the captured linear window.
//
// EXECUTION vs VIEW — the honest fidelity split for Curve-NG:
//   • The EXECUTION path — `exchange(i, j, dx, min_dy)`, exactly what the engine `_swapCurve`
//     calls — is FULLY SELF-CONTAINED in the etched pool runtime: it computes the StableSwap-NG
//     invariant (get_D / get_y) + the off-peg DYNAMIC fee entirely inline and moves the coins. It
//     makes NO external call. So the on-chain swap is 100% REAL captured code with NO stub.
//   • The read-only `get_dy` VIEW, by contrast, DELEGATES: the NG pool staticcalls its immutable
//     Factory's `views_implementation()` and forwards to an external `StableSwapViews.get_dy`
//     (verified via a callTracer: get_dy STATICCALLs the NG Factory `0x6a8cbed7…`,
//     selector `views_implementation()` = 0xe31593d8). That Factory + Views graph is NOT in the
//     capture, so `get_dy` reverts offline. This is IRRELEVANT to the recipe: neither discovery
//     nor the oracle nor the engine calls `get_dy` — the off-chain quote is the bit-for-bit Vyper
//     replay (curve-math.ts, now NG-dynamic-fee-aware), and the on-chain quote ground-truth is a
//     read-only `eth_call` of the REAL `exchange` on the pre-swap state (the actual swap path).
//     The test asserts BOTH the replay AND the real `exchange` eth_call agree with the executed
//     swap to the wei — a STRONGER cross-check than the delegated view would be.
//
// DISCOVERY (FactoryType.CurveRegistry): the production path reads the registry surface
// (find_pool_for_coins → get_coin_indices(int128 i,j,bool) → get_n_coins / get_decimals[uint256×8])
// then the pool getters (A / fee / offpeg_fee_multiplier / balances[k] / coins[k] → decimals()).
// The pool getters run the REAL etched runtime. The registry surface is stood up as a tiny
// READ-ONLY MetaRegistry SHIM at the WIRED CurveRegistry address (the legacy StableSwap registry
// wired in constants.ts returns address(0) for this NG pool on mainnet — see the capture note — so
// the offline shim faithfully stands in for the resolved MetaRegistry the reader would otherwise
// hit). The shim returns CONSTANTS (the captured pool address / indices / n_coins / decimals) — a
// read-only registry lookup for the single reproduced pair, no compile, no write tx.
// ══════════════════════════════════════════════════════════════════════════════

/** Curve bytecode snapshot: the self-contained NG pool (no proxy, no clone, no dependencies). */
export interface CurveBytecodeSnapshot extends PoolBytecodeSnapshot {
  dependencies?: DependencyBytecode[];
}

/** One coin in the captured Curve pool (address is a runtime IMMUTABLE — restored by setCode). */
export interface CurveStateCoin {
  address: Hex;
  symbol: string;
  decimals: number;
  poolBalanceOf: string;
  immutableInRuntime: boolean;
}

/** Curve StableSwap-NG state snapshot (written by harness/curveStable-snapshot.ts). */
export interface CurveStateSnapshot {
  chain: string;
  chainId: number;
  block: string;
  pool: Hex;
  poolSymbol: string;
  source: string;
  discovery: {
    wiredRegistry: Hex;
    wiredFindPool: Hex;
    metaRegistry: Hex;
    metaFindPool: Hex;
    addressProvider: Hex;
  };
  i: number;
  j: number;
  underlying: boolean;
  nCoins: number;
  coins: CurveStateCoin[];
  tokenIn: Hex;
  tokenOut: Hex;
  A: string;
  aPrecision: string;
  fee: string;
  adminFee: string;
  offpegFeeMultiplier: string;
  storedRates: string[];
  balances: string[];
  adminBalances: string[];
  storedBalances: string[];
  rates: string[];
  virtualPrice: string;
  probe: {
    forward: { i: number; j: number; dx: string; dy: string };
    reverse: { i: number; j: number; dx: string; dy: string };
  };
  storage: Record<string, Hex>;
}

/** Load a Curve `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadCurveSnapshots(name: string): {
  bytecode: CurveBytecodeSnapshot;
  state: CurveStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as CurveBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as CurveStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the Curve bytecode integrity (NO RPC): re-hash the pool runtime + any dependency runtimes
 * and match each capture-time sha256 anchor. Reuses verifyBytecodeIntegrity for the pool (a Curve
 * NG pool is self-contained ⇒ typically no dependencies) + per-dependency {name, expected, actual, ok}.
 */
export function verifyCurveBytecodeIntegrity(bytecode: CurveBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  dependencies: { name: string; expected?: Hex; actual: Hex; ok: boolean }[];
} {
  const base = verifyBytecodeIntegrity(bytecode);
  const dependencies = (bytecode.dependencies ?? []).map((d) => {
    const actual = runtimeSha256(d.runtime);
    return {
      name: d.name,
      expected: d.runtimeSha256,
      actual,
      ok: !d.runtimeSha256 || d.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { pool: base.pool, dependencies };
}

/** MetaRegistry-shim selectors (the surface discoverCurvePoolsTyped reads via curveRegistryAbi). */
const CURVE_REG_SELECTOR = {
  findPool: "a87df06c", // find_pool_for_coins(address,address)          -> address
  coinIndices: "eb85226d", // get_coin_indices(address,address,address)  -> (int128 i, int128 j, bool)
  nCoins: "940494f1", // get_n_coins(address)                            -> uint256
  decimals: "52b51555", // get_decimals(address)                         -> uint256[8]
} as const;

/** One answered registry getter: 4-byte selector (no 0x) -> its CONSTANT return-data words. */
interface ConstResponseEntry {
  selector: string; // 8 hex chars, no 0x
  words: bigint[]; // the ABI return words (each a 32-byte word), returned verbatim
}

/**
 * Build a tiny READ-ONLY shim runtime that answers each listed selector with a CONSTANT sequence of
 * 32-byte return words, and every UNLISTED selector with a single zero word. Hand-assembled as an
 * N-target jump table with offset-exact JUMPDESTs — NO Solidity compile, NO write tx.
 *
 * This generalises `buildFactoryShimRuntime` (which returns a single SLOADed slot per selector) to
 * MULTI-WORD constant responses, needed by the Curve MetaRegistry surface: get_coin_indices returns
 * 3 words (int128 i, int128 j, bool underlying) and get_decimals returns a uint256[8] FIXED array (8
 * inline words) — neither fits the one-slot shim. Every response here is a compile-time constant
 * (the captured pool address / indices / n_coins / decimals for the single reproduced pair), so a
 * constant reply is faithful (the reader queries exactly this one pair).
 */
export function buildConstResponseShimRuntime(entries: ConstResponseEntry[]): Hex {
  const bytes = (h: string) => h.length / 2;
  const w = (v: bigint) => (((v % (1n << 256n)) + (1n << 256n)) % (1n << 256n)).toString(16).padStart(64, "0");
  const header = "60003560e01c"; // sel = shr(0xe0, calldataload(0))
  const cmp = (sel: string, dest: number) =>
    "8063" + sel + "1461" + dest.toString(16).padStart(4, "0") + "57"; // DUP1 PUSH4 sel EQ PUSH2 dest JUMPI
  const gotoDefault = (dest: number) => "61" + dest.toString(16).padStart(4, "0") + "56"; // PUSH2 dest JUMP
  // Return `words`: for each k, PUSH32 <word> PUSH2 <off> MSTORE ; then PUSH2 <len> PUSH1 0 RETURN.
  const retWords = (words: bigint[]) => {
    let body = "";
    for (let k = 0; k < words.length; k++) {
      const off = k * 0x20;
      body += "7f" + w(words[k]) + "61" + off.toString(16).padStart(4, "0") + "52"; // PUSH32 v PUSH2 off MSTORE
    }
    const len = words.length * 0x20;
    body += "61" + len.toString(16).padStart(4, "0") + "6000f3"; // PUSH2 len PUSH1 0 RETURN
    return body;
  };
  const bodyFor = (e: ConstResponseEntry) => "5b" + retWords(e.words); // JUMPDEST + return body
  const defaultBody = "5b" + retWords([0n]); // JUMPDEST + return one zero word

  for (const e of entries) {
    if (e.selector.length !== 8) throw new Error(`const shim: selector "${e.selector}" must be 8 hex chars`);
  }
  if (entries.length > 0xff) throw new Error("const shim: too many selector entries");

  // Dispatch: header + one cmp per entry + goto-default trailer, then each JUMPDEST body, then default.
  const dispatchLen = bytes(header) + entries.length * bytes(cmp("00000000", 0)) + bytes(gotoDefault(0));
  let off = dispatchLen;
  const dests: number[] = [];
  for (const e of entries) {
    dests.push(off);
    off += bytes(bodyFor(e));
  }
  const defaultOff = off;
  const code =
    header +
    entries.map((e, i) => cmp(e.selector, dests[i])).join("") +
    gotoDefault(defaultOff) +
    entries.map((e) => bodyFor(e)).join("") +
    defaultBody;
  return ("0x" + code) as Hex;
}

/** Build the Curve MetaRegistry shim from a captured state snapshot (constant per-pair responses). */
export function buildCurveMetaRegistryShimRuntime(state: CurveStateSnapshot): Hex {
  const pool = BigInt(getAddress(state.pool));
  const i = BigInt(state.i);
  const j = BigInt(state.j);
  const underlying = state.underlying ? 1n : 0n;
  const n = BigInt(state.nCoins);
  // get_decimals returns uint256[8] — the first nCoins are the real decimals, the rest 0.
  const decWords: bigint[] = Array.from({ length: 8 }, (_, k) =>
    k < state.coins.length ? BigInt(state.coins[k].decimals) : 0n,
  );
  return buildConstResponseShimRuntime([
    { selector: CURVE_REG_SELECTOR.findPool, words: [pool] },
    { selector: CURVE_REG_SELECTOR.coinIndices, words: [i, j, underlying] },
    { selector: CURVE_REG_SELECTOR.nCoins, words: [n] },
    { selector: CURVE_REG_SELECTOR.decimals, words: decWords },
  ]);
}

export interface EtchedCurvePool {
  /** The pool address (the exchange()/discovery target — the captured mainnet address). */
  pool: Hex;
  /** The MetaRegistry shim address (the WIRED CurveRegistry address — point a poolConfig factory here). */
  registry: Hex;
  /** The locally-deployed coins, etched at the REAL coin addresses (immutables ⇒ must live there). */
  coins: Hex[];
  /** tokenIn == coins[i], tokenOut == coins[j] — echoed for the test. */
  tokenIn: Hex;
  tokenOut: Hex;
  /** Captured invariant params, echoed for the test. */
  A: bigint;
  fee: bigint;
  offpegFeeMultiplier: bigint;
  /** balances(k) (net of admin) + storedBalances(k) (the pool's ERC20 balanceOf reserve). */
  balances: bigint[];
  storedBalances: bigint[];
}

/** MintableERC20 decimals slot (verified in the Wombat/WOOFi section). */
const CURVE_ERC20_DECIMALS_SLOT = 2;

/**
 * Stand up the captured REAL Curve StableSwap-NG pool on the local anvil, OFFLINE.
 *
 *   1. Capture a local MintableERC20 runtime, then etch it AT EACH real coin address + seed its
 *      `decimals` slot — because the pool's `coins(k)` are IMMUTABLES baked in the runtime (they
 *      resolve to the real addresses off the etched code), the local tokens MUST live at those
 *      addresses (mirrors Wombat's immutable-underlying / WOOFi's mapping-keyed token etch). The
 *      pool's exchange() then moves the LOCAL storage-backed tokens.
 *   2. setCode the REAL NG pool runtime at its captured address (coins auto-restored via immutables).
 *   3. setStorageAt the captured linear storage window VERBATIM (A-ramp / fee / offpeg / stored &
 *      admin balances / rate-oracle bookkeeping) — so A()/fee()/balances(k)/get_virtual_price() and
 *      the inline exchange() invariant compute the mainnet-identical dy.
 *   4. setCode the READ-ONLY MetaRegistry shim at the WIRED CurveRegistry address (constant per-pair
 *      find_pool_for_coins / get_coin_indices / get_n_coins / get_decimals from the snapshot).
 *   5. Fund the pool with each coin's captured storedBalance (its ERC20 balanceOf reserve, so
 *      exchange() can pay out + the balance invariants hold), + caller headroom in tokenIn.
 *
 * The swap path then runs the GENUINE NG bytecode: exchange(i, j, dx, min_dy) computes the mainnet-
 * identical dy (get_D / get_y + the off-peg dynamic fee, ALL inline) for the captured state and moves
 * the local coins. `opts.registryAddr` overrides the shim address (default: the wired CurveRegistry).
 */
export async function etchCurveStablePool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: CurveBytecodeSnapshot; state: CurveStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint; registryAddr?: Hex } = {},
): Promise<EtchedCurvePool> {
  const { bytecode, state } = snapshots;
  if (bytecode.isMinimalProxy || bytecode.implementation) {
    throw new Error("etchCurveStablePool expects a self-contained pool snapshot (no proxy/impl)");
  }
  const acct = (opts.minter ?? walletClient.account) as Account;

  const pool = getAddress(bytecode.pool.address) as Hex;
  const registry = getAddress(opts.registryAddr ?? state.discovery.wiredRegistry) as Hex;
  const A = BigInt(state.A);
  const fee = BigInt(state.fee);
  const offpegFeeMultiplier = BigInt(state.offpegFeeMultiplier);
  const balances = state.balances.map((b) => BigInt(b));
  const storedBalances = state.storedBalances.map((b) => BigInt(b));

  // 1. Capture a local MintableERC20 runtime, then etch it at EACH real coin address + seed decimals.
  //    (coins(k) are immutables → the local tokens must live at the real coin addresses.)
  const scratch = await deployToken(walletClient, publicClient, "curve-scratch", "CSCR", 18);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  const coins: Hex[] = [];
  for (const coin of state.coins) {
    const tok = getAddress(coin.address) as Hex;
    await testClient.setCode({ address: tok, bytecode: erc20Runtime });
    await testClient.setStorageAt({
      address: tok,
      index: slotHex(CURVE_ERC20_DECIMALS_SLOT),
      value: word(BigInt(coin.decimals)),
    });
    coins.push(tok);
  }

  // 2. Etch the REAL NG pool runtime at its captured address (coins restored via immutables).
  await testClient.setCode({ address: pool, bytecode: bytecode.pool.runtime });

  // 3. setStorageAt the captured linear storage window VERBATIM.
  for (const [k, v] of Object.entries(state.storage)) {
    await testClient.setStorageAt({ address: pool, index: slotHex(Number(k)), value: v });
  }

  // 4. Read-only MetaRegistry shim at the wired CurveRegistry address.
  await testClient.setCode({ address: registry, bytecode: buildCurveMetaRegistryShimRuntime(state) });

  // 5. Fund the pool with each coin's captured ERC20 balanceOf reserve (storedBalance) + caller.
  for (let k = 0; k < coins.length; k++) {
    await mint(walletClient, publicClient, coins[k], pool, storedBalances[k]);
  }
  const tokenIn = coins[state.i];
  const tokenOut = coins[state.j];
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, tokenIn, acct.address as Hex, opts.callerFund);
  }

  return {
    pool,
    registry,
    coins,
    tokenIn,
    tokenOut,
    A,
    fee,
    offpegFeeMultiplier,
    balances,
    storedBalances,
  };
}

/** Curve NG pool read surface (the getters the test + discovery read on the REAL pool). */
export const curvePoolReadAbi = parseAbi([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function get_virtual_price() view returns (uint256)",
  // exchange is the REAL execution path — read-only via eth_call on the pre-swap state = the quote.
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
]);

/** Curve MetaRegistry shim read surface (the registry getters discovery reads). */
export const curveRegistryShimAbi = parseAbi([
  "function find_pool_for_coins(address from, address to) view returns (address)",
  "function get_coin_indices(address pool, address from, address to) view returns (int128 i, int128 j, bool underlying)",
  "function get_n_coins(address pool) view returns (uint256)",
  "function get_decimals(address pool) view returns (uint256[8])",
]);

// ══════════════════════════════════════════════════════════════════════════════
// Curve CryptoSwap (twocrypto-NG) prod-mirror etch — ADDITIVE extension of this harness.
//
// A twocrypto-NG CryptoSwap pool is a SELF-CONTAINED Vyper contract like the StableSwap-NG pool
// (coins baked as IMMUTABLES, invariant state in linear slots), BUT its get_dy/exchange dependency
// graph is RICHER — verified statically against the captured runtimes (the pool references the MATH
// library selectors 0x43d188fb/0x81d18d87/0xe6864766 and the factory selector 0xcab4d3db):
//
//   Pool 0x6e54…A9C2  (twocrypto-NG, coins crvUSD+WETH baked as immutables)
//     ├ MATH library 0x7983…2e51  (CurveCryptoMathOptimized) — get_dy AND exchange STATICCALL it for
//     │   newton_D / get_y (A-gamma invariant). A PURE library: no swap-relevant storage. The pool
//     │   references it as a baked immutable address, so it MUST be etched at its captured address
//     │   (the same V4 StateView→PoolManager / EIP-1167-impl immutable constraint) or the STATICCALL
//     │   returns 0x → the invariant reads garbage → get_dy/exchange revert.
//     └ Factory 0x98EE…AF7F  — exchange() reads factory.fee_receiver() (0xcab4d3db) in its admin-fee
//         bookkeeping. This SAME address is ALSO the CurveCryptoRegistry discovery registry the
//         production FactoryType.CurveCryptoRegistry path queries. So ONE shim at the factory address
//         serves BOTH roles: it answers fee_receiver() (the CAPTURED real receiver address, from
//         factory slot 3 — a benign scalar exchange stores for later admin claims; a single exchange
//         makes NO transfer to it) AND the registry surface (find_pool_for_coins / get_coin_indices
//         [UINT256 i,j — 2 words, NOT the StableSwap 3-word (i,j,underlying)] / get_n_coins /
//         get_decimals[uint256[8]]). The real factory's find_pool_for_coins returns 0 for a PAIR
//         lookup (Curve factories resolve by pool, not pair), so the shim faithfully stands in for the
//         resolved registry the production reader would otherwise reach — read-only discovery metadata,
//         output-irrelevant to the swap.
//
// EXECUTION vs VIEW — the honest fidelity split for CryptoSwap:
//   • The EXECUTION path — exchange(uint256 i,j,dx,min_dy), what the recipe calls CALLBACK-FREE — runs
//     the REAL etched pool + MATH runtimes end-to-end (newton_D/get_y + the A-gamma dynamic fee inline,
//     the fee_receiver read serviced by the shim). 100% real captured code on the swap path.
//   • The on-chain get_dy(uint256 i,j,dx) VIEW (the recipe's min_dy source AND the test's exact-in-dy
//     ground truth) is ALSO fully self-contained in {pool, MATH} — it does NOT touch the factory — so
//     it runs offline against the etched real code. (Contrast the StableSwap-NG pool, whose get_dy
//     delegates to an uncaptured views contract; twocrypto-NG's get_dy is inline + MATH only.)
//   • FIDELITY: the off-chain `cryptoswap-math.ts` replay mirrors THIS deployed family (Twocrypto
//     v2.1.0d — stableswap-invariant get_y + post-swap-xp dynamic fee + raw-product xp scaling) and
//     reproduces the pool's own get_dy to the wei across the prod-mirror ladder. The test still uses
//     the pool's OWN on-chain get_dy view as the exact-in-dy ground truth (the ACTUAL swap math the
//     recipe reads for min_dy) — ground truth by construction, with the replay ladder-parity-pinned
//     against it.
// ══════════════════════════════════════════════════════════════════════════════

/** Curve CryptoSwap bytecode snapshot: the self-contained NG pool + the MATH library + factory runtimes. */
export interface CurveCryptoBytecodeSnapshot extends PoolBytecodeSnapshot {
  /** MATH library + factory real runtimes (each sha256-anchored). */
  dependencies?: DependencyBytecode[];
}

/** One coin in the captured CryptoSwap pool (address is a runtime IMMUTABLE — restored by setCode). */
export interface CurveCryptoStateCoin {
  address: Hex;
  symbol: string;
  decimals: number;
}

/** Curve CryptoSwap (twocrypto-NG) state snapshot (written by harness/curveCrypto-snapshot.ts). */
export interface CurveCryptoStateSnapshot {
  chain: string;
  chainId: number;
  block: string;
  source: string;
  onCharter?: boolean;
  charterNote?: string;
  pool: Hex;
  factory: Hex;
  registry: Hex;
  math: Hex;
  feeReceiver: Hex;
  coinsImmutable: boolean;
  coins: Hex[];
  coin0: Hex;
  coin1: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  i: number;
  j: number;
  symbols: string[];
  poolSymbol: string;
  poolName: string;
  decimals: number[];
  precisions: string[];
  A: string;
  gamma: string;
  priceScale: string;
  priceOracle: string;
  D: string;
  balances: string[];
  midFee: string;
  outFee: string;
  feeGamma: string;
  fee: string;
  totalSupply: string;
  probe: {
    sellCoin0: { i: number; j: number; dx: string; dy: string };
    sellCoin1: { i: number; j: number; dx: string; dy: string };
  };
  storage: Record<string, Hex>;
  factoryStorage: Record<string, Hex>;
}

/** Load a Curve CryptoSwap `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadCurveCryptoSnapshots(name: string): {
  bytecode: CurveCryptoBytecodeSnapshot;
  state: CurveCryptoStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as CurveCryptoBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as CurveCryptoStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the Curve CryptoSwap bytecode integrity (NO RPC): re-hash the pool runtime + the MATH + factory
 * dependency runtimes and match each capture-time sha256 anchor. Returns pool (via verifyBytecodeIntegrity's
 * shape) + per-dependency {name, expected, actual, ok}. Reuses verifyDodoBytecodeIntegrity's structure.
 */
export function verifyCurveCryptoBytecodeIntegrity(bytecode: CurveCryptoBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  dependencies: { name: string; expected?: Hex; actual: Hex; ok: boolean }[];
} {
  const base = verifyBytecodeIntegrity(bytecode);
  const dependencies = (bytecode.dependencies ?? []).map((d) => {
    const actual = runtimeSha256(d.runtime);
    return {
      name: d.name,
      expected: d.runtimeSha256,
      actual,
      ok: !d.runtimeSha256 || d.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { pool: base.pool, dependencies };
}

/** CryptoRegistry-shim selectors (find_pool_for_coins / get_coin_indices[UINT256] / n_coins / decimals). */
const CURVE_CRYPTO_REG_SELECTOR = {
  findPool: "a87df06c", // find_pool_for_coins(address,address)      -> address
  coinIndices: "eb85226d", // get_coin_indices(address,address,address) -> (uint256 i, uint256 j)  [2 words]
  nCoins: "940494f1", // get_n_coins(address)                          -> uint256
  decimals: "52b51555", // get_decimals(address)                       -> uint256[8]
} as const;

/** fee_receiver() selector the pool's exchange() reads on the factory. */
const CURVE_CRYPTO_FEE_RECEIVER_SELECTOR = "cab4d3db";

/**
 * Build the Curve CryptoSwap combined factory-shim runtime from a captured state snapshot: ONE read-only
 * contract at the factory address that answers BOTH the discovery-registry surface (find_pool_for_coins /
 * get_coin_indices [UINT256 i,j — 2 words] / get_n_coins / get_decimals[8]) AND the pool's fee_receiver()
 * read — constant per-pair responses (the captured pool/indices/n_coins/decimals/feeReceiver). Generalises
 * `buildConstResponseShimRuntime`; every reply is a compile-time constant (the reader queries exactly this
 * one pair; exchange reads the one fee_receiver), so a constant reply is faithful.
 */
export function buildCurveCryptoFactoryShimRuntime(state: CurveCryptoStateSnapshot): Hex {
  const pool = BigInt(getAddress(state.pool));
  const i = BigInt(state.i);
  const j = BigInt(state.j);
  const n = BigInt(state.coins.length);
  const feeReceiver = BigInt(getAddress(state.feeReceiver));
  const decWords: bigint[] = Array.from({ length: 8 }, (_, k) =>
    k < state.coins.length ? BigInt(state.decimals[k]) : 0n,
  );
  return buildConstResponseShimRuntime([
    { selector: CURVE_CRYPTO_REG_SELECTOR.findPool, words: [pool] },
    { selector: CURVE_CRYPTO_REG_SELECTOR.coinIndices, words: [i, j] }, // UINT256 (i,j) — 2 words
    { selector: CURVE_CRYPTO_REG_SELECTOR.nCoins, words: [n] },
    { selector: CURVE_CRYPTO_REG_SELECTOR.decimals, words: decWords },
    { selector: CURVE_CRYPTO_FEE_RECEIVER_SELECTOR, words: [feeReceiver] }, // exchange() admin-fee read
  ]);
}

export interface EtchedCurveCryptoPool {
  /** The pool address (the get_dy/exchange/discovery target — the captured mainnet address). */
  pool: Hex;
  /** The MATH library address (etched with the real CurveCryptoMathOptimized runtime at its captured address). */
  math: Hex;
  /** The factory/registry shim address (the CurveCryptoRegistry + fee_receiver source). */
  registry: Hex;
  /** The locally-deployed coins, etched at the REAL coin addresses (immutables ⇒ must live there). */
  coins: Hex[];
  /** tokenIn == coins[i], tokenOut == coins[j] — echoed for the test. */
  tokenIn: Hex;
  tokenOut: Hex;
  /** The captured resolved fee_receiver (echoed for the test). */
  feeReceiver: Hex;
  /** Captured invariant params, echoed for the test. */
  A: bigint;
  gamma: bigint;
  priceScale: bigint;
  D: bigint;
  midFee: bigint;
  outFee: bigint;
  feeGamma: bigint;
  /** balances(k) — the pool's coin reserves (native units). */
  balances: bigint[];
}

/**
 * Stand up the captured REAL Curve CryptoSwap (twocrypto-NG) pool on the local anvil, OFFLINE.
 *
 *   1. Capture a local MintableERC20 runtime, then etch it AT EACH real coin address + seed its
 *      `decimals` slot — because the pool's `coins(k)` are IMMUTABLES baked in the runtime, the local
 *      tokens MUST live at those addresses (mirrors the StableSwap-NG / Wombat immutable-coin etch).
 *      The pool's exchange() then PULLS the LOCAL storage-backed coin i via transferFrom + pays out j.
 *   2. setCode the REAL MATH library runtime at its captured address (the pool STATICCALLs it for
 *      newton_D/get_y — a baked immutable address, so it MUST sit there or the invariant reverts).
 *   3. setCode the REAL NG pool runtime at its captured address (coins auto-restored via immutables).
 *   4. setStorageAt the captured linear pool storage window VERBATIM (A / gamma / price_scale / D /
 *      balances / dynamic-fee params / rate-oracle bookkeeping) — so A()/gamma()/price_scale()/D()/
 *      balances(k) and the inline get_dy/exchange invariant compute the mainnet-identical dy.
 *   5. setCode the combined READ-ONLY factory/registry shim at the captured factory address (constant
 *      per-pair find_pool_for_coins / get_coin_indices / get_n_coins / get_decimals + fee_receiver).
 *   6. Fund the pool with each coin's captured balance (so exchange() can pay out + the balance
 *      invariants hold), + caller headroom in tokenIn.
 *
 * The swap path then runs the GENUINE pool + MATH bytecode: get_dy(i,j,dx) / exchange(i,j,dx,min_dy)
 * compute the mainnet-identical dy (newton_D/get_y + the A-gamma dynamic fee) for the captured state and
 * move the local coins. `opts.registryAddr` overrides the shim address (default: the captured factory).
 */
export async function etchCurveCryptoPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: CurveCryptoBytecodeSnapshot; state: CurveCryptoStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint; registryAddr?: Hex } = {},
): Promise<EtchedCurveCryptoPool> {
  const { bytecode, state } = snapshots;
  if (bytecode.isMinimalProxy || bytecode.implementation) {
    throw new Error("etchCurveCryptoPool expects a self-contained pool snapshot (no proxy/impl)");
  }
  // The A-gamma invariant is served by ONE OR MORE math contracts (twocrypto-ng splits
  // CurveCryptoMathOptimized across a primary the pool STATICCALLs + a helper that primary calls) —
  // etch EVERY captured math dependency (name "math" / "math-helper-*") at its captured address.
  const mathDeps = (bytecode.dependencies ?? []).filter((d) => d.name === "math" || d.name.startsWith("math-helper"));
  if (mathDeps.length === 0) throw new Error("etchCurveCryptoPool: no MATH library runtime in the bytecode snapshot");
  const acct = (opts.minter ?? walletClient.account) as Account;

  const pool = getAddress(bytecode.pool.address) as Hex;
  const math = getAddress(mathDeps[0].address) as Hex; // the primary math (the pool's direct callee)
  const registry = getAddress(opts.registryAddr ?? state.factory) as Hex;
  const balances = state.balances.map((b) => BigInt(b));

  // 1. Capture a local MintableERC20 runtime, then etch it at EACH real coin address + seed decimals.
  const scratch = await deployToken(walletClient, publicClient, "curve-crypto-scratch", "CCSCR", 18);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  const coins: Hex[] = [];
  for (let k = 0; k < state.coins.length; k++) {
    const tok = getAddress(state.coins[k]) as Hex;
    await testClient.setCode({ address: tok, bytecode: erc20Runtime });
    await testClient.setStorageAt({
      address: tok,
      index: slotHex(CURVE_ERC20_DECIMALS_SLOT),
      value: word(BigInt(state.decimals[k])),
    });
    coins.push(tok);
  }

  // 2. Etch EVERY REAL MATH library runtime at its captured address (the pool STATICCALLs the primary,
  //    which in turn STATICCALLs the helper — both must be present or the invariant reverts).
  for (const md of mathDeps) {
    await testClient.setCode({ address: getAddress(md.address) as Hex, bytecode: md.runtime });
  }

  // 3. Etch the REAL NG pool runtime at its captured address (coins restored via immutables).
  await testClient.setCode({ address: pool, bytecode: bytecode.pool.runtime });

  // 4. setStorageAt the captured linear pool storage window VERBATIM.
  for (const [k, v] of Object.entries(state.storage)) {
    await testClient.setStorageAt({ address: pool, index: slotHex(Number(k)), value: v });
  }

  // 5. Combined read-only factory/registry shim at the captured factory address (discovery + fee_receiver).
  await testClient.setCode({ address: registry, bytecode: buildCurveCryptoFactoryShimRuntime(state) });

  // 6. Fund the pool with each coin's captured balance (so exchange() can pay out) + caller headroom.
  for (let k = 0; k < coins.length; k++) {
    await mint(walletClient, publicClient, coins[k], pool, balances[k]);
  }
  const tokenIn = coins[state.i];
  const tokenOut = coins[state.j];
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, tokenIn, acct.address as Hex, opts.callerFund);
  }

  return {
    pool,
    math,
    registry,
    coins,
    tokenIn,
    tokenOut,
    feeReceiver: getAddress(state.feeReceiver) as Hex,
    A: BigInt(state.A),
    gamma: BigInt(state.gamma),
    priceScale: BigInt(state.priceScale),
    D: BigInt(state.D),
    midFee: BigInt(state.midFee),
    outFee: BigInt(state.outFee),
    feeGamma: BigInt(state.feeGamma),
    balances,
  };
}

/** Curve CryptoSwap (twocrypto-NG) pool read surface (the getters the test + discovery read). */
export const curveCryptoPoolReadAbi = parseAbi([
  "function A() view returns (uint256)",
  "function gamma() view returns (uint256)",
  "function price_scale() view returns (uint256)",
  "function D() view returns (uint256)",
  "function mid_fee() view returns (uint256)",
  "function out_fee() view returns (uint256)",
  "function fee_gamma() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function fee_receiver() view returns (address)",
  // get_dy is the REAL exact quote (self-contained in pool + MATH) — the exact-in-dy ground truth.
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
  // exchange is the REAL execution path — read-only via eth_call on the pre-swap state = the quote.
  "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)",
]);

/** Curve CryptoSwap factory/registry shim read surface (the registry getters discovery reads + fee_receiver). */
export const curveCryptoRegistryShimAbi = parseAbi([
  "function find_pool_for_coins(address from, address to) view returns (address)",
  "function get_coin_indices(address pool, address from, address to) view returns (uint256 i, uint256 j)",
  "function get_n_coins(address pool) view returns (uint256)",
  "function get_decimals(address pool) view returns (uint256[8])",
  "function fee_receiver() view returns (address)",
]);

// ══════════════════════════════════════════════════════════════════════════════
// Maverick V2 (bin-based directional AMM, CALLBACK pool) prod-mirror etch — ADDITIVE extension.
//
// A Maverick V2 Pool is a SELF-CONTAINED runtime (NOT an EIP-1167 clone, NOT a proxy) — like a
// WooPPV2/Curve pool it holds its own swap/tick logic. So the etch is a 2-contract graph: the pool +
// the MaverickV2Quoter (the wei-exact `calculateSwap` ground truth the test cross-checks against). The
// SAME etch-runtime mechanism applies — setCode the REAL runtimes at their captured addresses,
// setStorageAt the captured active-bin/tick WINDOW verbatim — with ONE wrinkle unique to Maverick:
//
//   • TOKENS ARE IMMUTABLES baked into the pool BYTECODE, not storage. The captured runtime embeds
//     tokenA (USDT) and tokenB (USDC) at MANY code positions (verified: 12 occurrences each in the
//     runtime, ZERO in any storage slot) — Solidity inlines an immutable at each use site. So the test
//     CANNOT repoint the tokens by overwriting a storage scalar (the Solidly token0-slot trick). It
//     must etch a local MintableERC20 runtime AT EACH REAL token address (USDT + USDC) and seed its
//     `decimals` slot — exactly the Wombat/WOOFi immutable-token pattern. The pool then moves the LOCAL
//     (storage-backed) tokens while its immutable tokenA()/tokenB() still name the real addresses.
//
// Maverick is a CALLBACK pool: the engine `_swapMaverickV2` (SwapPoolType 7) reads the pool's tokenA(),
// sets tokenAIn, calls pool.swap(recipient, SwapParams{amount, tokenAIn, exactOutput:false, tickLimit:
// per-direction full-range}, "") and the pool RE-ENTERS the engine's `maverickV2SwapCallback` to PULL the
// input mid-swap. The real
// Maverick V2 Pool.swap does NOT check the factory/CREATE2 during the swap (it trusts msg.sender — the
// engine — to pay via the callback), so a non-canonical locally-etched pool is accepted exactly like the
// V3/V4 local-pool cases. The FACTORY is needed ONLY for discovery: FactoryType.MaverickV2Factory reads
// lookup(tokenA, tokenB, 0, N) → the pool. We setCode a tiny read-only factory shim at the captured
// factory address returning [pool] for the pair; the pool's own factory() immutable is irrelevant to the
// swap. NO factory graph rebuild.
//
// ENGINE tickLimit (documented in maverick-math.ts): the FIXED engine (../sauce PR #193) passes a
// per-direction FULL-RANGE tickLimit (type(int32).max/min), so BOTH directions are executable across the
// whole live tick book (the OLD tickLimit=0 gate + its tokenB-in-only discovery gate are gone). This
// fixture's captured quoter probes (100/1000/5000 USDC, tokenB-in USDC→USDT) FULLY consume within the
// pool's available payout reserve, so the trade lands exactly.
// ══════════════════════════════════════════════════════════════════════════════

/** Maverick bytecode snapshot: the self-contained pool runtime + dependency runtimes (the quoter). */
export interface MaverickBytecodeSnapshot {
  chain: string;
  block: string;
  pool: { address: Hex; runtime: Hex; runtimeSha256?: Hex };
  isMinimalProxy: boolean;
  /** Every contract beyond the pool the swap / quote path touches — here the MaverickV2Quoter. */
  dependencies?: DependencyBytecode[];
}

/** One decoded tick (per-tick reserves + referenced bin ids) from the captured active-tick window. */
export interface MaverickTickSnapshot {
  tick: number;
  reserveA: string;
  reserveB: string;
  totalSupply: string;
  binIdsByTick: number[];
}

/** One decoded bin from the captured window. */
export interface MaverickBinSnapshot {
  binId: number;
  mergeBinBalance: string;
  tickBalance: string;
  totalSupply: string;
  kind: number;
  tick: number;
  mergeId: number;
}

/** Maverick state snapshot (written by harness/maverick-snapshot.ts). */
export interface MaverickStateSnapshot {
  chain: string;
  chainId?: number;
  block: string;
  pool: Hex;
  factory: Hex;
  factoryOnPool?: Hex;
  quoter: Hex;
  tokenA: Hex; // USDT (== tokenOut in the engine-executable tokenB-in direction)
  tokenB: Hex; // USDC (== tokenIn)
  tokenASymbol: string;
  tokenBSymbol: string;
  tokenADecimals: number;
  tokenBDecimals: number;
  tickSpacing: number;
  feeAIn: string;
  feeBIn: string;
  protocolFeeRatioD3: number;
  engineTickLimit: number;
  engineExecutableDirection: string;
  engineTokenAIn: boolean;
  state: {
    reserveA: string;
    reserveB: string;
    activeTick: number;
    binCounter: number;
    isLocked: boolean;
    lastTimestamp: number;
    lastTwaD8: string;
    lastLogPriceD8: string;
  };
  tickWindow: { lo: number; hi: number; window: number };
  ticks: MaverickTickSnapshot[];
  bins: MaverickBinSnapshot[];
  storageLayout: {
    stateSlots: number[];
    ticksBaseSlot: number;
    tickWords: number;
    binsBaseSlot: number;
    binWords: number;
  };
  probes: {
    direction: string;
    tokenAIn: boolean;
    amountIn: string;
    amountInUsed: string;
    amountOut: string;
    gasEstimate: string;
  }[];
  /** Raw storage window (slot -> value) for deterministic setStorageAt reconstruction. */
  storage: Record<string, Hex>;
}

/** Load a Maverick `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadMaverickSnapshots(name: string): {
  bytecode: MaverickBytecodeSnapshot;
  state: MaverickStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as MaverickBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as MaverickStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the Maverick bytecode integrity (NO RPC): re-hash the pool + every dependency runtime (the
 * quoter) and match each capture-time sha256 anchor. Returns pool (via verifyBytecodeIntegrity's shape)
 * + per-dependency {name, expected, actual, ok}.
 */
export function verifyMaverickBytecodeIntegrity(bytecode: MaverickBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  dependencies: { name: string; expected?: Hex; actual: Hex; ok: boolean }[];
} {
  const base = verifyBytecodeIntegrity(bytecode);
  const dependencies = (bytecode.dependencies ?? []).map((d) => {
    const actual = runtimeSha256(d.runtime);
    return {
      name: d.name,
      expected: d.runtimeSha256,
      actual,
      ok: !d.runtimeSha256 || d.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { pool: base.pool, dependencies };
}

/** lookup(address,address,uint256,uint256) selector (production FactoryType.MaverickV2Factory discovery). */
const MAVERICK_LOOKUP_SELECTOR = "e262790d";

/**
 * A minimal read-only Maverick V2 FACTORY shim: lookup(tokenA,tokenB,startIndex,endIndex) → the single
 * reproduced pool as a one-element address[]; every other selector → an empty address[]. We setCode this
 * at the captured factory address and store the pool at slot0. NO Solidity compile, NO write tx.
 *
 * ABI return for a one-element address[]: head offset 0x20, then [length=1, pool] — 3 words. Empty array:
 * [0x20, 0] — 2 words. The shim answers lookup UNCONDITIONALLY (address/index-agnostic): the test stands
 * up exactly ONE Maverick pool for the pair, and discovery queries BOTH token orderings + de-dupes on the
 * pool address, so replying the SAME pool to both orderings is correct (the second is dropped by the
 * `seen` set). This mirrors buildDodoFactoryShimRuntime's getDODOPool array reply, retargeted to `lookup`.
 */
export function buildMaverickFactoryShimRuntime(): Hex {
  const bytes = (h: string) => h.length / 2;
  const header = "60003560e01c"; // sel = shr(0xe0, calldataload(0))
  const cmp = (sel: string, dest: number) =>
    "8063" + sel + "1461" + dest.toString(16).padStart(4, "0") + "57"; // DUP1 PUSH4 sel EQ PUSH2 dest JUMPI
  // Empty-array body (fallthrough): mstore(0,0x20) mstore(0x20,0) return(0,0x40)
  const emptyBody = "6020600052" + "6000602052" + "604060" + "00f3";
  // lookup body (JUMPDEST): mstore(0,0x20) mstore(0x20,1) mstore(0x40,sload(0)) return(0,0x60)
  const lookupBody =
    "5b" + "6020600052" + "6001602052" + "600054604052" + "606060" + "00f3";

  const dispatchLen = bytes(header) + bytes(cmp(MAVERICK_LOOKUP_SELECTOR, 0)) + bytes(emptyBody);
  const lookupDest = dispatchLen; // lookup JUMPDEST sits right after the empty-array fallthrough
  const code = header + cmp(MAVERICK_LOOKUP_SELECTOR, lookupDest) + emptyBody + lookupBody;
  return ("0x" + code) as Hex;
}

export interface EtchedMaverickPool {
  /** The Maverick V2 pool address (the lookup / swap(SwapParams{poolType:7}) target). */
  pool: Hex;
  /** The MaverickV2Quoter address (etched with the real quoter runtime at its captured address). */
  quoter: Hex;
  /** The Maverick V2 factory shim (lookup) — point a poolConfig MaverickV2Factory factory here. */
  factory: Hex;
  /** The local MintableERC20s etched AT the REAL token addresses (immutables in the pool bytecode). */
  tokenA: Hex; // USDT (== tokenOut for tokenB-in)
  tokenB: Hex; // USDC (== tokenIn)
  /** Captured pool-wide fields, echoed for the test. */
  reserveA: bigint;
  reserveB: bigint;
  activeTick: number;
  tickSpacing: number;
  feeAIn: bigint;
  feeBIn: bigint;
  protocolFeeRatioD3: number;
}

/**
 * Stand up the captured REAL Maverick V2 pool + its MaverickV2Quoter on the local anvil, OFFLINE.
 *
 *   1. Capture a local MintableERC20 runtime, then etch it at EACH REAL token address (tokenA=USDT,
 *      tokenB=USDC) and seed the `decimals` slot — the pool bakes tokenA/tokenB as IMMUTABLES, so the
 *      local token MUST live at the real address for the pool's immutable getters + transfers to resolve.
 *   2. setCode the REAL MaverickV2Quoter runtime at its captured address (self-contained — calculateSwap
 *      takes the pool as an ARGUMENT and CALLs only it, no further dependency).
 *   3. setCode the Maverick factory shim at the captured factory address; store the pool at slot0 (so
 *      lookup(tokenA,tokenB,0,N) → [pool] for the production discovery path).
 *   4. setCode the REAL pool runtime at its captured address; setStorageAt the captured active-bin/tick
 *      WINDOW VERBATIM (State slots + _ticks[int32]×3 words per live tick + _bins[uint32]×2 words per
 *      referenced bin). The pool's getState/getTick/getBin then read the mainnet-identical bin state.
 *   5. Fund the pool with the captured reserveA (USDT, the output side) + reserveB (USDC) so pool.swap
 *      can pay out tokenOut and the callback-pulled tokenIn lands in the pool; + caller headroom in USDC.
 *
 * The swap path then runs the GENUINE pool bytecode: swap() walks the reconstructed tick book and
 * re-enters maverickV2SwapCallback to pull the input, and calculateSwap(pool, amount, tokenAIn=false, ...)
 * returns the mainnet-identical dy for the captured window.
 */
export async function etchMaverickPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: MaverickBytecodeSnapshot; state: MaverickStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint } = {},
): Promise<EtchedMaverickPool> {
  const { bytecode, state } = snapshots;
  if (bytecode.isMinimalProxy) {
    throw new Error("etchMaverickPool expects a self-contained pool snapshot (not a proxy)");
  }
  const acct = (opts.minter ?? walletClient.account) as Account;

  const poolAddress = getAddress(bytecode.pool.address) as Hex;
  const factory = getAddress(state.factory) as Hex;
  const quoterDep = (bytecode.dependencies ?? []).find((d) => d.name === "maverickV2Quoter");
  if (!quoterDep) throw new Error("Maverick snapshot missing the maverickV2Quoter dependency runtime");
  const quoter = getAddress(quoterDep.address) as Hex;
  const tokenA = getAddress(state.tokenA) as Hex; // USDT
  const tokenB = getAddress(state.tokenB) as Hex; // USDC
  const reserveA = BigInt(state.state.reserveA);
  const reserveB = BigInt(state.state.reserveB);

  // 1. Capture a local MintableERC20 runtime, then etch it at EACH real token address (immutables in
  //    the pool bytecode → the local token must live at the real addr). Seed the `decimals` slot.
  const scratch = await deployToken(walletClient, publicClient, "maverick-scratch", "MSCR", 18);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  for (const [tok, dec] of [
    [tokenA, state.tokenADecimals],
    [tokenB, state.tokenBDecimals],
  ] as [Hex, number][]) {
    await testClient.setCode({ address: tok, bytecode: erc20Runtime });
    await testClient.setStorageAt({ address: tok, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(dec)) });
  }

  // 2. Etch the REAL MaverickV2Quoter at its captured address.
  await testClient.setCode({ address: quoter, bytecode: quoterDep.runtime });

  // 3. Maverick factory shim at the captured factory address; store the pool at slot0.
  await testClient.setCode({ address: factory, bytecode: buildMaverickFactoryShimRuntime() });
  await testClient.setStorageAt({ address: factory, index: slotHex(0), value: addrWord(poolAddress) });

  // 4. Etch the REAL pool runtime + replay the captured active-bin/tick storage window VERBATIM.
  await testClient.setCode({ address: poolAddress, bytecode: bytecode.pool.runtime });
  for (const [slot, value] of Object.entries(state.storage)) {
    await testClient.setStorageAt({ address: poolAddress, index: slot as Hex, value });
  }

  // 5. Fund the pool's reserves (so pool.swap pays out tokenOut + the callback-pulled tokenIn lands) +
  //    caller headroom in the input token (USDC / tokenB).
  await mint(walletClient, publicClient, tokenA, poolAddress, reserveA);
  await mint(walletClient, publicClient, tokenB, poolAddress, reserveB);
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, tokenB, acct.address as Hex, opts.callerFund);
  }

  return {
    pool: poolAddress,
    quoter,
    factory,
    tokenA,
    tokenB,
    reserveA,
    reserveB,
    activeTick: state.state.activeTick,
    tickSpacing: state.tickSpacing,
    feeAIn: BigInt(state.feeAIn),
    feeBIn: BigInt(state.feeBIn),
    protocolFeeRatioD3: state.protocolFeeRatioD3,
  };
}

/** Maverick V2 pool read surface (the getters the test + discovery + oracle read on the REAL pool). */
export const maverickPoolReadAbi = parseAbi([
  "function tokenA() external view returns (address)",
  "function tokenB() external view returns (address)",
  "function tickSpacing() external view returns (uint256)",
  "function fee(bool tokenAIn) external view returns (uint256)",
  "function factory() external view returns (address)",
  "function getState() external view returns ((uint128 reserveA, uint128 reserveB, int64 lastTwaD8, int64 lastLogPriceD8, uint40 lastTimestamp, int32 activeTick, bool isLocked, uint32 binCounter, uint8 protocolFeeRatioD3) state)",
  "function getTick(int32 tick) external view returns ((uint128 reserveA, uint128 reserveB, uint128 totalSupply, uint32[4] binIdsByTick) tickState)",
  "function getBin(uint32 binId) external view returns ((uint128 mergeBinBalance, uint128 tickBalance, uint128 totalSupply, uint8 kind, int32 tick, uint32 mergeId) bin)",
]);

/** MaverickV2Quoter read surface — calculateSwap is the wei-exact ground truth (state-mutating sig → simulate). */
export const maverickQuoterAbi = parseAbi([
  "function calculateSwap(address pool, uint128 amount, bool tokenAIn, bool exactOutput, int32 tickLimit) external returns (uint256 amountIn, uint256 amountOut, uint256 gasEstimate)",
]);

/** Maverick V2 factory shim read surface (lookup). */
export const maverickFactoryShimAbi = parseAbi([
  "function lookup(address tokenA, address tokenB, uint256 startIndex, uint256 endIndex) external view returns (address[] pools)",
]);

export { erc20Abi };

// ══════════════════════════════════════════════════════════════════════════════
// Trader Joe (LFJ) Liquidity Book v2.2 LBPair prod-mirror etch — ADDITIVE extension.
//
// An LB v2.2 LBPair is an LFJ IMMUTABLE-ARGS CLONE (Clones-with-immutable-args), NOT an EIP-1167 minimal
// proxy: the 97-byte proxy runtime delegatecalls a fixed IMPLEMENTATION and APPENDS the immutable args
// (tokenX, tokenY, binStep) to the calldata:
//   363d3d373d3d3d3d61002c806035363936013d73<impl:20>5af43d3d93803e603357fd5bf3<tokenX:20><tokenY:20><binStep:2>
// So (like the V4 StateView→PoolManager etch) the impl MUST live at its captured address, and tokenX/tokenY
// are BAKED INTO THE PROXY BYTECODE (NOT storage) — the offline test therefore etches local MintableERC20s
// AT the real tokenX/tokenY addresses (the Wombat-underlying pattern), so the immutable args stay valid and
// the pair moves local (storage-backed) tokens. The bin RESERVES + fee params DO live in storage (the LBPair
// `_bins` mapping at base slot 7, plus the packed param slots 0..11 and the `_tree` bitmap at base slot 8),
// reconstructed VERBATIM via setStorageAt.
//
// DEPENDENCY GRAPH the getSwapOut staticcall + transfer+swap path touches (offline, all etched REAL code):
//   LBPair proxy (97-byte clone) → delegatecall → LBPair IMPLEMENTATION (all bin/fee/swap math).
// The pair reads NOTHING else on the quote/swap path (fee params are self-contained in its packed storage;
// tokenX/tokenY/binStep are the clone's immutable args). The factory is used ONLY off-chain by discovery
// (getLBPairInformation) — reproduced by a tiny read-only shim at the captured factory address; it is NOT on
// the swap path, so its runtime is not captured/etched (a shim is the faithful stand-in for the discovery read).
//
// TWO OUTPUT-RELEVANT reconstruction choices, both disclosed + proven output-EQUIVALENT to the neutral oracle:
//   1. block.timestamp is PINNED to the capture ts in the test (like WOOFi). LB v2.2 getSwapOut/swap call
//      `_parameters.updateReferences(block.timestamp)`, which underflows if block.timestamp < timeOfLastUpdate
//      — the pin keeps the fee path deterministic at the captured instant.
//   2. The packed param slot 4's `variableFeeControl` field [bits 54..78) is ZEROED at etch time
//      (neutralizeVariableFee). LB's total fee = baseFee + variableFee, where the variable (volatility)
//      surcharge is a TRANSIENT, swap-path-dependent term (it accrues per bin crossed) that the off-chain
//      snapshot model (lb-math.ts) omits — the same fixed-base-fee snapshot assumption the recipe makes for
//      V3 tiers / Curve fee. Setting variableFeeControl=0 makes the real pair's total fee == its base fee
//      (baseFactor·binStep·1e10) for ANY swap path, so the executed dy == lb-math.ts getSwapOut to the WEI
//      (verified: with vfc=0 + the ceil per-bin math the real LBPair getSwapOut matches lb-math across the
//      whole reconstructed window, both directions). ALL OTHER params (baseFactor, binStep, reserves, tree)
//      are byte-identical to mainnet — only the transient volatility surcharge (which the snapshot cannot
//      faithfully reproduce off-chain) is neutralized. This is the LB analogue of DODO's resolved-mtFeeRate
//      scalar and WOOFi's CL round shims: the ONE piece of transient state a static snapshot can't carry.

/** LB v2.2 packed pair parameters bit layout (slot 4) — the fields we touch (variableFeeControl only). */
const LB_VFC_BIT_LO = 54n;
const LB_VFC_BIT_HI = 78n; // variableFeeControl occupies [54, 78)
/** LBPair `_bins` mapping base slot + `_tree` (TreeMath.TreeUint24) struct base slot (verified at capture). */
const LB_TREE_BASE_SLOT = 8;

/** One captured window bin's `_bins` mapping slot + packed (reserveY<<128 | reserveX) value. */
export interface LbBinStorageEntry {
  slot: Hex;
  value: Hex;
}

/** The captured `_tree` bitmap slots (level0 single word + level1/level2 mapping groups). */
export interface LbTreeStorage {
  level0: LbBinStorageEntry;
  level1: Record<string, LbBinStorageEntry>; // keyed by (id >> 16)
  level2: Record<string, LbBinStorageEntry>; // keyed by (id >> 8)
}

/** LB bytecode snapshot: pair proxy (immutable-args clone) + LBPair implementation runtime. */
export interface LbBytecodeSnapshot {
  chain: string;
  chainId?: number;
  block: string;
  blockTimestamp?: string;
  pair: { address: Hex; runtime: Hex; runtimeSha256?: Hex };
  implementation: { address: Hex; runtime: Hex; runtimeSha256?: Hex };
  isImmutableArgsClone: boolean;
  immutableArgs: {
    tokenX: Hex;
    tokenY: Hex;
    binStep: number;
    argsHex: Hex;
    argsByteOffset: number;
  };
  dependencies?: DependencyBytecode[];
}

/** LB state snapshot (written by harness/lb-snapshot.ts). */
export interface LbStateSnapshot {
  chain: string;
  chainId?: number;
  block: string;
  blockTimestamp: string;
  pair: Hex;
  factory: Hex;
  factoryType: string;
  implementation: Hex;
  tokenX: Hex;
  tokenY: Hex;
  tokenXSymbol: string;
  tokenYSymbol: string;
  decimalsX: number;
  decimalsY: number;
  binStep: number;
  activeId: number;
  reserveX: string;
  reserveY: string;
  staticFeeParameters: {
    baseFactor: number;
    filterPeriod: number;
    decayPeriod: number;
    reductionFactor: number;
    variableFeeControl: number;
    protocolShare: number;
    maxVolatilityAccumulator: number;
  };
  variableFeeParameters: {
    volatilityAccumulator: number;
    volatilityReference: number;
    idReference: number;
    timeOfLastUpdate: number;
  } | null;
  binWindow: { lo: number; hi: number; bins: { id: number; reserveX: string; reserveY: string }[] };
  probe: {
    swapForY: { amountIn: string; amountInLeft: string; amountOut: string; fee: string };
    swapForX: { amountIn: string; amountInLeft: string; amountOut: string; fee: string };
  };
  binsMappingSlot: number;
  paramStorage: Record<string, Hex>;
  binStorage: Record<string, LbBinStorageEntry>;
  treeBaseSlot: number;
  treeStorage: LbTreeStorage;
}

/** Load an LB `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadLbSnapshots(name: string): {
  bytecode: LbBytecodeSnapshot;
  state: LbStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as LbBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as LbStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the LB bytecode integrity (NO RPC): re-hash the pair proxy + LBPair impl and match each capture-time
 * sha256 anchor. Returns pool/implementation in verifyBytecodeIntegrity's shape (the shared assertion helper).
 * NOTE the snapshot names the pair field `pair` (not `pool`), so we adapt to the shared PoolBytecodeSnapshot.
 */
export function verifyLbBytecodeIntegrity(bytecode: LbBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  implementation: { expected?: Hex; actual: Hex; ok: boolean };
} {
  const poolActual = runtimeSha256(bytecode.pair.runtime);
  const implActual = runtimeSha256(bytecode.implementation.runtime);
  return {
    pool: {
      expected: bytecode.pair.runtimeSha256,
      actual: poolActual,
      ok: !bytecode.pair.runtimeSha256 || bytecode.pair.runtimeSha256.toLowerCase() === poolActual.toLowerCase(),
    },
    implementation: {
      expected: bytecode.implementation.runtimeSha256,
      actual: implActual,
      ok:
        !bytecode.implementation.runtimeSha256 ||
        bytecode.implementation.runtimeSha256.toLowerCase() === implActual.toLowerCase(),
    },
  };
}

/** Zero the `variableFeeControl` field (bits [54,78)) in the packed LB param slot-4 word. See the block
 *  comment above for WHY (neutralize the transient volatility surcharge the static snapshot can't carry). */
export function neutralizeVariableFee(slot4: Hex): Hex {
  const v = BigInt(slot4);
  const mask = ((1n << LB_VFC_BIT_HI) - 1n) ^ ((1n << LB_VFC_BIT_LO) - 1n);
  return word(v & ~mask);
}

/** getLBPairInformation(address,address,uint256) selector (production FactoryType.TraderJoeLB discovery). */
const GET_LB_PAIR_INFORMATION_SELECTOR = "704037bd";

/**
 * A minimal read-only LB v2.2 FACTORY shim: getLBPairInformation(tokenX, tokenY, binStep) returns the ABI
 * 4-tuple (binStep, LBPair, createdByOwner=false, ignoredForRouting=false) IFF the calldata binStep (3rd arg,
 * calldata offset 0x44) equals the captured binStep at slot0; otherwise (any other binStep / any other
 * selector) it returns the ALL-ZERO 4-tuple (pair == address(0)) — which discovery treats as "no pair for
 * this step" and skips. Token args are IGNORED (getLBPairInformation is order-independent, and the test stands
 * up exactly ONE pair) — the binStep gate is what makes discovery surface the pair for its true step only,
 * exactly matching the real factory's per-step lookup. NO Solidity compile, NO write tx.
 *
 * slot0 = the captured binStep ; slot1 = the pair address. Hand-assembled with an offset-exact JUMPDEST.
 */
export function buildLbFactoryShimRuntime(): Hex {
  const bytes = (h: string) => h.length / 2;
  // header: sel = shr(0xe0, calldataload(0))
  const header = "60003560e01c"; // PUSH1 0 CALLDATALOAD PUSH1 0xe0 SHR
  // DUP1 PUSH4 <sel> EQ PUSH2 <dest> JUMPI
  const cmp = (sel: string, dest: number) =>
    "8063" + sel + "1461" + dest.toString(16).padStart(4, "0") + "57";
  // ZERO 4-tuple body (fallthrough — unknown selector / non-matching binStep):
  //   PUSH1 0x80 PUSH1 0 RETURN  (return 0x80 bytes of zero-initialised memory — MSTORE nothing)
  const zeroBody = "608060" + "00f3";
  // MATCH body (getLBPairInformation with the captured binStep):
  //   mstore(0x00, sload(0))   // binStep
  //   mstore(0x20, sload(1))   // pair
  //   mstore(0x40, 0) mstore(0x60, 0) implicit (memory is zero) — but MSTORE to be explicit
  //   return(0, 0x80)
  // and BEFORE the tuple, gate on calldataload(0x44) == sload(0): if not equal, jump to zeroBody.
  //   JUMPDEST
  //   PUSH1 0x44 CALLDATALOAD  PUSH1 0 SLOAD  EQ  ISZERO  PUSH2 <zeroDest> JUMPI
  //   PUSH1 0 SLOAD PUSH1 0 MSTORE
  //   PUSH1 1 SLOAD PUSH1 0x20 MSTORE
  //   PUSH1 0x80 PUSH1 0 RETURN
  // (memory 0x40/0x60 stay zero → createdByOwner=false, ignoredForRouting=false.)
  const zeroBodyLen = 1 + bytes(zeroBody); // +JUMPDEST prefix on the zero body target
  const dispatchLen = bytes(header) + bytes(cmp(GET_LB_PAIR_INFORMATION_SELECTOR, 0)) + bytes(zeroBody);
  // Layout: [header][cmp → matchDest][zeroBody fallthrough]  then  [zeroDest JUMPDEST + zeroBody][matchDest body]
  // We need TWO zero exits: the plain fallthrough (no JUMPDEST needed — control just falls in) AND a
  // jump target for the binStep-mismatch. Simplest: put a JUMPDEST'd zero body AFTER the match body and
  // fall through to a copy for the selector-miss. To keep offsets exact, structure as:
  //   header
  //   cmp(sel → MATCH)
  //   zeroBody                      (selector miss → return zero, no JUMPDEST)
  //   MATCH: JUMPDEST ... EQ ISZERO PUSH2 ZERO JUMPI ... return tuple
  //   ZERO:  JUMPDEST zeroBody      (binStep miss → return zero)
  const matchDest = dispatchLen;
  // MATCH body assembly (compute its length to place ZERO after it):
  //   5b 6044 35 6000 54 14 15 61<zero>57 6000 54 600052 6001 54 602052 608060 00f3
  const gateHead = "5b" + "604435" + "600054" + "1415"; // JUMPDEST; cdl(0x44); sload0; EQ; ISZERO
  const gateJumpiPrefix = "61"; // PUSH2 <zeroDest>
  const gateJumpiSuffix = "57"; // JUMPI
  const tupleBody = "600054600052" + "600154602052" + "608060" + "00f3";
  const matchLen = bytes(gateHead) + 1 + 2 + 1 + bytes(tupleBody); // gateHead + PUSH2 + 2 + JUMPI + tuple
  const zeroDest = matchDest + matchLen;
  const code =
    header +
    cmp(GET_LB_PAIR_INFORMATION_SELECTOR, matchDest) +
    zeroBody +
    gateHead +
    gateJumpiPrefix +
    zeroDest.toString(16).padStart(4, "0") +
    gateJumpiSuffix +
    tupleBody +
    "5b" +
    zeroBody;
  void zeroBodyLen;
  return ("0x" + code) as Hex;
}

export interface EtchedLbPool {
  /** The LBPair proxy address (the discovery + swap target). */
  pool: Hex;
  /** The LBPair implementation address (etched with the real impl runtime at its captured address). */
  impl: Hex;
  /** The LB v2.2 factory shim (getLBPairInformation) — point a poolConfig TraderJoeLB factory here. */
  factory: Hex;
  /** The local MintableERC20s etched AT the real tokenX/tokenY addresses (immutable-args constraint). */
  tokenX: Hex;
  tokenY: Hex;
  binStep: number;
  baseFactor: number;
  activeId: number;
  reserveX: bigint;
  reserveY: bigint;
}

/**
 * Stand up the captured REAL Trader Joe LB v2.2 pair on the local anvil, OFFLINE.
 *
 *   1. Capture a local MintableERC20 runtime, then etch it at EACH real token address (tokenX + tokenY) and
 *      seed the `decimals` slot — the clone bakes tokenX/tokenY as IMMUTABLE ARGS in the proxy bytecode, so
 *      the local tokens MUST live at the real addresses (the Wombat-underlying constraint).
 *   2. setCode the LB v2.2 factory shim at the captured factory address; store binStep@slot0, pair@slot1.
 *   3. setCode the REAL LBPair impl at its captured address + the REAL 97-byte immutable-args proxy at the
 *      pool address (the proxy hard-codes the impl address, so the impl MUST sit at its captured address).
 *   4. setStorageAt the pair VERBATIM: the packed param slots (0..11, with variableFeeControl NEUTRALIZED in
 *      slot 4 — see the block comment), the `_bins` mapping slots for the window, and the `_tree` bitmap slots
 *      (level0 + level1/level2 groups) — REQUIRED so the pair's findFirstRight/Left bin walk crosses bins
 *      (without the tree it drains ONLY the active bin).
 *   5. Fund the pair's tokenX/tokenY balances with the captured reserves (so swap() can pay out) + caller
 *      headroom.
 *
 * The swap path then runs the GENUINE LBPair bytecode: getSwapOut(amountIn, swapForY) returns the mainnet-
 * identical amountOut for the captured bins (base fee only, vfc neutralized), and swap(swapForY, to) transfers
 * real (local) tokens. The engine `_swapTraderJoeLB` is callback-free (transfer-first + pool.swap).
 */
export async function etchLbPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: LbBytecodeSnapshot; state: LbStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint } = {},
): Promise<EtchedLbPool> {
  const { bytecode, state } = snapshots;
  if (!bytecode.isImmutableArgsClone) {
    throw new Error("etchLbPool expects an LB immutable-args clone snapshot (pair + implementation)");
  }
  const acct = (opts.minter ?? walletClient.account) as Account;

  const tokenX = getAddress(state.tokenX) as Hex;
  const tokenY = getAddress(state.tokenY) as Hex;
  const poolAddress = getAddress(bytecode.pair.address) as Hex;
  const impl = getAddress(bytecode.implementation.address) as Hex;
  const factory = getAddress(state.factory) as Hex;
  const reserveX = BigInt(state.reserveX);
  const reserveY = BigInt(state.reserveY);

  // 1. Local MintableERC20 runtime → etch at EACH real token address (immutable-args constraint), seed decimals.
  const scratch = await deployToken(walletClient, publicClient, "lb-scratch", "LBSCR", 18);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  for (const [tok, dec] of [
    [tokenX, state.decimalsX],
    [tokenY, state.decimalsY],
  ] as [Hex, number][]) {
    await testClient.setCode({ address: tok, bytecode: erc20Runtime });
    await testClient.setStorageAt({ address: tok, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(dec)) });
  }

  // 2. LB factory shim at the captured factory address; store binStep@slot0, pair@slot1.
  await testClient.setCode({ address: factory, bytecode: buildLbFactoryShimRuntime() });
  await testClient.setStorageAt({ address: factory, index: slotHex(0), value: word(BigInt(state.binStep)) });
  await testClient.setStorageAt({ address: factory, index: slotHex(1), value: addrWord(poolAddress) });

  // 3. Etch the REAL impl at its captured address + the REAL immutable-args proxy at the pool address.
  await testClient.setCode({ address: impl, bytecode: bytecode.implementation.runtime });
  await testClient.setCode({ address: poolAddress, bytecode: bytecode.pair.runtime });

  // 4. Reconstruct storage: packed params (vfc neutralized in slot 4), _bins window, _tree bitmap.
  const setPool = (slot: number, value: Hex) =>
    testClient.setStorageAt({ address: poolAddress, index: slotHex(slot), value });
  for (const [k, v] of Object.entries(state.paramStorage)) {
    const value = Number(k) === 4 ? neutralizeVariableFee(v) : v;
    await setPool(Number(k), value);
  }
  for (const entry of Object.values(state.binStorage)) {
    await testClient.setStorageAt({ address: poolAddress, index: entry.slot, value: entry.value });
  }
  await testClient.setStorageAt({ address: poolAddress, index: state.treeStorage.level0.slot, value: state.treeStorage.level0.value });
  for (const e of Object.values(state.treeStorage.level1)) {
    await testClient.setStorageAt({ address: poolAddress, index: e.slot, value: e.value });
  }
  for (const e of Object.values(state.treeStorage.level2)) {
    await testClient.setStorageAt({ address: poolAddress, index: e.slot, value: e.value });
  }

  // 5. Fund the pair's reserves (so swap() can pay out) + caller headroom.
  await mint(walletClient, publicClient, tokenX, poolAddress, reserveX);
  await mint(walletClient, publicClient, tokenY, poolAddress, reserveY);
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, tokenX, acct.address as Hex, opts.callerFund);
    await mint(walletClient, publicClient, tokenY, acct.address as Hex, opts.callerFund);
  }

  return {
    pool: poolAddress,
    impl,
    factory,
    tokenX,
    tokenY,
    binStep: state.binStep,
    baseFactor: state.staticFeeParameters.baseFactor,
    activeId: state.activeId,
    reserveX,
    reserveY,
  };
}

/** LB pair read surface (the getters the test + discovery + oracle read on the REAL pair). */
export const lbPairReadAbi = parseAbi([
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
  "function getActiveId() view returns (uint24 activeId)",
  "function getBinStep() view returns (uint16 binStep)",
  "function getBin(uint24 id) view returns (uint128 binReserveX, uint128 binReserveY)",
  "function getReserves() view returns (uint128 reserveX, uint128 reserveY)",
  "function getStaticFeeParameters() view returns (uint16 baseFactor, uint16 filterPeriod, uint16 decayPeriod, uint16 reductionFactor, uint24 variableFeeControl, uint16 protocolShare, uint24 maxVolatilityAccumulator)",
  "function getSwapOut(uint128 amountIn, bool swapForY) view returns (uint128 amountInLeft, uint128 amountOut, uint128 fee)",
]);

/** LB v2.2 factory shim read surface (getLBPairInformation). */
export const lbFactoryShimAbi = parseAbi([
  "function getLBPairInformation(address tokenX, address tokenY, uint256 binStep) view returns (uint256 binStep2, address LBPair, bool createdByOwner, bool ignoredForRouting)",
]);

// ══════════════════════════════════════════════════════════════════════════════
// Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed re-centering AMM)
// prod-mirror etch — ADDITIVE extension of this harness.
//
// A FluidDexT1 pool is NEITHER an EIP-1167 clone NOR a standalone reserve pool. Its price comes from the
// SHARED Liquidity-Layer supply/borrow exchange prices + a re-centering center price + utilization/borrow
// caps — ALL canonical on-chain state living across a MULTI-CONTRACT graph — so there is NO closed-form
// curve to replay off-chain and NO getAmountOut view on the pool. The FULL quote/swap dependency graph the
// test reproduces (enumerated at capture via `cast access-list` + a `cast run` call-tree, see
// harness/fluid-snapshot.ts) is:
//
//   pool (FluidDexT1 0x6677…)            — token0/token1 + the module map are IMMUTABLES in the runtime
//     ├ resolver (DexResolver 0x11D8…)   — the quote surface getDexTokens + estimateSwapIn (pure logic;
//     │                                    reads NO storage of its own — it staticcalls the pool)
//     └ liquidity (InfiniteProxy 0x52Aa…)— the shared Liquidity layer the pool SLOADs (packed exchange
//          ├ operate module   (0x4bDC…)    prices / supply-borrow / center-price) for the estimate AND
//          └ secondary module (0x4350…)    DELEGATECALLs into for the exec operate() (the 2 dispatch targets)
//
// The SAME etch-runtime mechanism applies (setCode every REAL runtime at its captured address, setStorageAt
// the captured state VERBATIM by ABSOLUTE key), with TWO Fluid-specific wrinkles:
//
//   • token0/token1 ARE IMMUTABLES. The DexT1 pool bakes token0/token1 into its runtime (exposed only
//     inside constantsView()'s struct — there are NO token0()/token1() getters), so the test CANNOT repoint
//     them via setStorageAt. It etches a local MintableERC20 AT EACH REAL token address (USDC + USDT) and
//     seeds its `decimals` slot (mirrors Wombat's immutable-underlying / WOOFi's mapping-keyed token etch).
//     The pool then pulls/pays the LOCAL (storage-backed) tokens while its immutables == the real addresses.
//   • BLOCK TIMESTAMP MUST BE PINNED to storedTs + a few seconds. Fluid's exchange-price accrual computes
//     `block.timestamp - lastUpdateTimestamp`; at now == storedTs it PANICS 0x11 (underflow) → the resolver
//     catches it → returns 0, and a large positive delta ACCRUES the prices away from the captured probe. A
//     fresh anvil's genesis clock is at wall-time (already PAST storedTs on a 2026 machine), so the test
//     uses `anvil_setTime` (which CAN jump BACKWARD, unlike setNextBlockTimestamp) to land the next mined
//     block at storedTs + delta (verified bit-exact for 1..12s — see pinFluidBlockTimestamp). NOTE: the
//     etch alone leaves the clock at wall-time — the test MUST call pinFluidBlockTimestamp AFTER etching and
//     BEFORE the first quote/cook, and every fresh anvil (per engine cell) must re-pin.
//
// NO factory shim is needed: the production FactoryType.Fluid discovery reads the RESOLVER's getDexTokens +
// estimateSwapIn (a config-carried resolver address) and the FactoryConfig.fluidPools list directly — so
// reconstructing the pool + resolver + Liquidity graph state is sufficient for discovery to surface the
// venue. The on-chain execution is CALLBACK-FREE (a live resolver estimateSwapIn staticcall for
// amountOutMin + approve + pool.swapIn — Fluid PULLS via safeTransferFrom, re-entering its OWN Liquidity
// layer via operate(), never the cooking contract), so no engine SwapPoolType and no router dispatch.
// ══════════════════════════════════════════════════════════════════════════════

/** Fluid bytecode snapshot: the DexT1 pool + the resolver + the Liquidity proxy + its 2 modules (each
 *  sha256-anchored). Same {pool, dependencies[]} shape as the DODO/Balancer snapshots. */
export interface FluidBytecodeSnapshot extends PoolBytecodeSnapshot {
  blockTimestamp?: string;
  dependencies?: DependencyBytecode[];
}

/** Fluid state snapshot (written by harness/fluid-snapshot.ts). */
export interface FluidStateSnapshot {
  chain: string;
  block: string;
  /** The pinned block's timestamp — the test pins block.timestamp to this + a few seconds (accrual). */
  blockTimestamp: string;
  pool: Hex;
  resolver: Hex;
  factory: Hex;
  liquidity: Hex;
  proxyAdmin: Hex;
  proxyDummyImplementation: Hex;
  implementations: Hex[];
  deployer: Hex;
  operateDispatchSlot: Hex;
  operateModule: Hex;
  secondaryModule: Hex;
  token0: Hex;
  token1: Hex;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  /** The REAL Liquidity-layer reserves at the pinned block (the test funds the etched proxy with these). */
  liquidityReserve0: string;
  liquidityReserve1: string;
  /** Wei-exact anchor: the resolver estimateSwapIn ladder (== the real swapIn output), both directions. */
  probe: {
    swap0to1: { amountIn: string; amountOut: string }[];
    swap1to0: { amountIn: string; amountOut: string }[];
  };
  /** Raw pool storage window (absolute slot → value), set verbatim on the etched pool. */
  poolStorage: Record<string, Hex>;
  /** The Liquidity proxy's touched slots (absolute slot → value), set verbatim on the etched proxy. */
  liquidityStorage: Record<string, Hex>;
}

/** Load a Fluid `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadFluidSnapshots(name: string): {
  bytecode: FluidBytecodeSnapshot;
  state: FluidStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as FluidBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as FluidStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the Fluid bytecode integrity (NO RPC): re-hash the pool runtime + every dependency runtime
 * (resolver + Liquidity proxy + the two modules) and match each capture-time sha256 anchor. Returns pool
 * (via verifyBytecodeIntegrity's shape) + per-dependency {name, expected, actual, ok}. Reuses the DODO/
 * Balancer {pool, dependencies[]} structure.
 */
export function verifyFluidBytecodeIntegrity(bytecode: FluidBytecodeSnapshot): {
  pool: { expected?: Hex; actual: Hex; ok: boolean };
  dependencies: { name: string; expected?: Hex; actual: Hex; ok: boolean }[];
} {
  const base = verifyBytecodeIntegrity(bytecode);
  const dependencies = (bytecode.dependencies ?? []).map((d) => {
    const actual = runtimeSha256(d.runtime);
    return {
      name: d.name,
      expected: d.runtimeSha256,
      actual,
      ok: !d.runtimeSha256 || d.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { pool: base.pool, dependencies };
}

/** A minimal test-client surface for the Fluid block-timestamp pin (anvil_setTime + mine). */
type FluidTimeClient = {
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
  mine: (a: { blocks: number }) => Promise<void>;
  getBlockTimestamp?: () => Promise<bigint>;
};

/**
 * Pin the anvil block clock to `state.blockTimestamp + deltaSeconds` (default 3) and mine one block, so the
 * next quote/cook sees a `block.timestamp` a FEW seconds past the pinned block's stored `lastUpdateTimestamp`
 * — the ONLY window in which Fluid's exchange-price accrual (`block.timestamp - lastUpdateTimestamp`) is
 * (a) non-underflowing (it PANICS 0x11 at delta==0) and (b) below the accrual rounding quantum (so the
 * resolver quote stays BIT-EXACT with the captured probe; verified 1..12s). Uses `anvil_setTime`, which CAN
 * jump BACKWARD — a fresh anvil's genesis clock is at wall-time (PAST storedTs on a 2026 machine), and
 * `evm_setNextBlockTimestamp` refuses to go backward. Call AFTER etching and BEFORE the first quote/cook, on
 * EVERY fresh anvil.
 */
export async function pinFluidBlockTimestamp(
  testClient: FluidTimeClient,
  state: { blockTimestamp: string },
  deltaSeconds = 3,
): Promise<bigint> {
  const ts = BigInt(state.blockTimestamp) + BigInt(deltaSeconds);
  await testClient.request({ method: "anvil_setTime", params: [Number(ts)] });
  await testClient.mine({ blocks: 1 });
  return ts;
}

export interface EtchedFluidPool {
  /** The FluidDexT1 pool address (the swapIn / approve target + the resolver `dex_` arg — captured mainnet address). */
  pool: Hex;
  /** The periphery DexResolver address (the getDexTokens / estimateSwapIn quote target). */
  resolver: Hex;
  /** The shared Liquidity-layer InfiniteProxy address (funded with the reserves so the pool can pay out). */
  liquidity: Hex;
  /** token0/token1 — local MintableERC20s etched at the REAL token addresses (Fluid immutables). */
  token0: Hex;
  token1: Hex;
  token0Decimals: number;
  token1Decimals: number;
  /** Captured Liquidity-layer reserves, echoed for the test. */
  reserve0: bigint;
  reserve1: bigint;
  /** The pinned block timestamp (state.blockTimestamp) the test must pin the clock to (+ a few s). */
  blockTimestamp: bigint;
}

/**
 * Stand up the captured REAL Fluid DexT1 pool + its whole quote/swap contract graph on the local anvil,
 * OFFLINE. (Proven bit-exact vs the captured probe — see harness/fluid-snapshot.ts's anchor.)
 *
 *   1. Capture a local MintableERC20 runtime, then etch it AT EACH REAL token address (token0=USDC,
 *      token1=USDT) + seed its `decimals` slot — because token0/token1 are IMMUTABLES baked into the pool
 *      runtime (read via constantsView()), the local tokens MUST live at the real addresses.
 *   2. setCode the REAL pool runtime at its captured address + EVERY dependency runtime (resolver +
 *      Liquidity proxy + the operate/secondary modules) at its captured address.
 *   3. setStorageAt the pool's captured storage + the Liquidity proxy's captured touched slots, VERBATIM by
 *      ABSOLUTE key (incl. the operate() sig→module dispatch entry + the packed exchange-price slots).
 *   4. Fund the etched Liquidity proxy with the captured reserves (so swapIn can pay the output out), +
 *      caller headroom in the from-token.
 *
 * The swap path then runs the GENUINE pool + resolver + Liquidity bytecode: resolver.estimateSwapIn returns
 * the mainnet-identical dy for the captured layer state, and pool.swapIn PULLS the from-token via
 * safeTransferFrom into the Liquidity layer + pays out the to-token. NOTE: the caller MUST call
 * pinFluidBlockTimestamp after this and before the first quote/cook (Fluid accrual — see the header).
 */
export async function etchFluidPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: FluidBytecodeSnapshot; state: FluidStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint } = {},
): Promise<EtchedFluidPool> {
  const { bytecode, state } = snapshots;
  const acct = (opts.minter ?? walletClient.account) as Account;

  const pool = getAddress(state.pool) as Hex;
  const resolver = getAddress(state.resolver) as Hex;
  const liquidity = getAddress(state.liquidity) as Hex;
  const token0 = getAddress(state.token0) as Hex; // real USDC address
  const token1 = getAddress(state.token1) as Hex; // real USDT address
  const reserve0 = BigInt(state.liquidityReserve0);
  const reserve1 = BigInt(state.liquidityReserve1);

  // 1. Capture a local MintableERC20 runtime, etch it at each REAL token address + seed decimals.
  //    (token0/token1 are pool immutables → the local tokens MUST live at the real addresses.)
  const scratch = await deployToken(walletClient, publicClient, "fluid-scratch", "FSCR", 6);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  for (const [tok, dec] of [
    [token0, state.token0Decimals],
    [token1, state.token1Decimals],
  ] as [Hex, number][]) {
    await testClient.setCode({ address: tok, bytecode: erc20Runtime });
    await testClient.setStorageAt({ address: tok, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(dec)) });
  }

  // 2. Etch the REAL pool + every dependency runtime at its captured address.
  await testClient.setCode({ address: pool, bytecode: bytecode.pool.runtime });
  for (const d of bytecode.dependencies ?? []) {
    await testClient.setCode({ address: getAddress(d.address) as Hex, bytecode: d.runtime });
  }

  // 3. setStorageAt the captured pool + Liquidity storage VERBATIM by absolute key.
  for (const [k, v] of Object.entries(state.poolStorage)) {
    await testClient.setStorageAt({ address: pool, index: k as Hex, value: v });
  }
  for (const [k, v] of Object.entries(state.liquidityStorage)) {
    await testClient.setStorageAt({ address: liquidity, index: k as Hex, value: v });
  }

  // 4. Fund the etched Liquidity proxy with the captured reserves (so swapIn can pay the output out), +
  //    caller headroom in the from-token (token0 == USDC, the swap0to1 direction).
  await mint(walletClient, publicClient, token0, liquidity, reserve0);
  await mint(walletClient, publicClient, token1, liquidity, reserve1);
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, token0, acct.address as Hex, opts.callerFund);
  }

  return {
    pool,
    resolver,
    liquidity,
    token0,
    token1,
    token0Decimals: state.token0Decimals,
    token1Decimals: state.token1Decimals,
    reserve0,
    reserve1,
    blockTimestamp: BigInt(state.blockTimestamp),
  };
}

/** Fluid DexT1 pool read surface (constantsView returns the immutable struct; swapIn is the exec entry). */
export const fluidPoolReadAbi = parseAbi([
  "function constantsView() view returns (uint256 dexId, address liquidity, address factory, address implementation0, address implementation1, address implementation2, address implementation3, address implementation4, address deployerContract, address token0, address token1, bytes32 supplyToken0Slot, bytes32 borrowToken0Slot, bytes32 supplyToken1Slot, bytes32 borrowToken1Slot)",
  "function swapIn(bool swap0to1, uint256 amountIn, uint256 amountOutMin, address to) payable returns (uint256 amountOut)",
]);

/** Fluid periphery DexResolver read surface (the getters discovery + the on-chain solver read). */
export const fluidResolverReadAbi = parseAbi([
  "function getDexTokens(address dex) view returns (address token0, address token1)",
  "function estimateSwapIn(address dex, bool swap0to1, uint256 amountIn, uint256 amountOutMin) view returns (uint256 amountOut)",
]);

// ── Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange) ──────────────────
//
// Mento is the FIRST multi-contract prod-mirror captured as a WHOLE traced GRAPH (16 contracts): the
// quote/swap path fans out across Broker → BiPoolManager → SortedOracles (+ its median library) +
// ConstantSumPricingModule + BreakerBox + Reserve + the cUSD stable token, each an EIP-1967 / Celo proxy
// delegating to an impl. Rather than hand-code 16 storage layouts, harness/mento-snapshot.ts let the EVM
// enumerate the exact touched set (debug_traceCall prestateTracer on the quote AND swapIn AND the two
// discovery getters) and dumped {code, touched-storage} per address. So the snapshot's `contracts` is the
// FULL graph and `storage` is the union of touched slots keyed by ABSOLUTE contract address.
//
// TOKEN REPOINTING (the Fluid/Solidly class — repoint the tokens, keep the REAL pricing contracts): cUSD
// (tokenIn, STABLE, 18) is repointed to a MintableBurnableERC20 and USDC (tokenOut, COLLATERAL, 6) to a
// MintableERC20, both etched AT THEIR REAL ADDRESSES (the exchange assets are baked into the BiPoolManager's
// exchange config, so the local tokens MUST live at the real addresses). Mento's Broker.swapIn for a stable
// tokenIn does `transferFrom(sender, broker, amt)` then `IBurnableERC20(cUSD).burn(amt)` (expects a `true`
// return — hence the burnable fixture) and for a collateral tokenOut does
// `reserve.transferExchangeCollateralAsset(USDC, to, out)` (a plain ERC20 safeTransfer from the Reserve). The
// token ERC20 mechanics are NOT part of Mento's bucket/oracle pricing — the quote is already wei-exact with
// the real contracts — so repointing preserves 100% of the pricing fidelity while making the token movements
// executable offline (proven: a full swapIn against this etch received USDC == the captured mainnet
// getAmountOut probe, wei-exact).
//
// transferOut GATING RECONSTRUCTION (disclosed): the captured swapIn TRACE reverts at transferIn (insufficient
// allowance), so it never reaches transferOut — the Reserve's collateral-release gating (isExchangeSpender,
// isCollateralAsset, a per-asset spending limit) is NOT in the captured touched-storage set. The etch
// reconstructs exactly three Reserve mapping slots (empirically located in the mento-core Reserve layout,
// pinned below) so the REAL transferExchangeCollateralAsset executes. Two of the three are set to their
// VERIFIED on-chain values (FAITHFUL to mainnet reality, independently confirmed at the pinned Celo block):
// isCollateralAsset(USDC)=true (slot 25) and isExchangeSpender(Broker)=true (slot 20) are BOTH already `true`
// on the real Reserve — reconstructing them is a replay of the real state, not a fabrication. ONLY the third,
// collateralAssetSpendingLimit(USDC)=<permissive> (slot 26), is a PERMISSIVE SUBSTITUTION: the real Reserve's
// live value is 0 (its daily-ratio mechanism gates differently and its running-total/last-reset accounting is
// not captured), so the etch sets a permissive limit to let the collateral release through. All three are
// boolean/limit GATING, NOT pricing — they do not touch the bucket/oracle math (the quote is wei-exact without
// them), so the released AMOUNT is still the REAL BiPoolManager quote to the wei.

/** One contract in the Mento graph bytecode snapshot (harness/mento-snapshot.ts `contracts[]`). */
export interface MentoContractBytecode {
  address: Hex;
  role: string;
  runtime: Hex;
  runtimeSha256?: Hex;
  implementation?: Hex;
  touchedSlots: number;
}

/** Mento graph bytecode snapshot (harness/mento-snapshot.ts). */
export interface MentoBytecodeSnapshot {
  chain: string;
  chainId: number;
  block: string;
  source: string;
  broker: Hex;
  biPoolManager: Hex;
  exchangeId: Hex;
  contracts: MentoContractBytecode[];
}

/** Mento graph state snapshot (harness/mento-snapshot.ts). */
export interface MentoStateSnapshot {
  chain: string;
  chainId: number;
  block: string;
  blockTimestamp: string;
  source: string;
  broker: Hex;
  exchangeProvider: Hex;
  exchangeId: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  tokenInIsStable: boolean;
  tokenOutIsCollateral: boolean;
  onCharter: boolean;
  sortedOracles: Hex;
  reserve: Hex;
  breakerBox: Hex;
  pricingModule: Hex;
  referenceRateFeedID: Hex;
  reserveUSDC: string;
  /** transferOut gating (see the section header) — recorded by the recapture; reconstructed by the etch. */
  reserveIsExchangeSpender?: boolean;
  reserveCollateralSpendingLimit?: string;
  probe: { amountIn: string; amountOut: string };
  ladder: { cap: string; cumIn: string[]; cumOut: string[] };
  /** The union touched storage per contract (absolute slot → value), set verbatim on each etched contract. */
  storage: Record<string, Record<string, Hex>>;
}

/** Load a Mento `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadMentoSnapshots(name: string): {
  bytecode: MentoBytecodeSnapshot;
  state: MentoStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as MentoBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as MentoStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the Mento bytecode-graph integrity (NO RPC): re-hash EVERY contract runtime in the graph and match
 * its capture-time sha256 anchor. Returns per-contract {address, role, expected, actual, ok}. A reviewer with
 * no RPC key can run this to prove the checked-in blobs are the pinned-block mainnet code, byte-for-byte.
 */
export function verifyMentoBytecodeIntegrity(bytecode: MentoBytecodeSnapshot): {
  contracts: { address: Hex; role: string; expected?: Hex; actual: Hex; ok: boolean }[];
  allOk: boolean;
} {
  const contracts = bytecode.contracts.map((c) => {
    const actual = runtimeSha256(c.runtime);
    return {
      address: c.address,
      role: c.role,
      expected: c.runtimeSha256,
      actual,
      ok: !c.runtimeSha256 || c.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { contracts, allOk: contracts.every((c) => c.ok) };
}

/** A minimal test-client surface for the Mento block-timestamp pin (anvil_setTime + mine). */
type MentoTimeClient = {
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
  mine: (a: { blocks: number }) => Promise<void>;
};

/**
 * Pin the anvil block clock to `state.blockTimestamp` and mine one block. BiPoolManager.getAmountOut and
 * swapIn simulate a bucket refresh off `block.timestamp - lastBucketUpdate` (refresh only every
 * referenceRateResetFrequency), so pinning to the captured block ts reproduces the captured quote EXACTLY.
 * Uses `anvil_setTime` (can jump BACKWARD — a fresh anvil's genesis clock is at wall-time, PAST the captured
 * Celo ts). Call AFTER etching and BEFORE the first quote/cook, on EVERY fresh anvil.
 */
export async function pinMentoBlockTimestamp(
  testClient: MentoTimeClient,
  state: { blockTimestamp: string },
): Promise<bigint> {
  const ts = BigInt(state.blockTimestamp);
  // anvil_setTime sets the NEXT block's timestamp; mining once lands a block AT ts (then subsequent blocks
  // advance by ~1s, still within the same refresh window, so the quote stays bit-exact).
  await testClient.request({ method: "anvil_setTime", params: [Number(ts)] });
  await testClient.mine({ blocks: 1 });
  return ts;
}

/**
 * The three Reserve mapping-slot indices the transferOut gating reconstruction sets (mento-core Reserve
 * storage layout; located empirically + pinned). See the section header for why they are reconstructed (the
 * captured swapIn trace reverts at transferIn, so transferOut gating is not in the touched set). These are
 * GATING (bool/limit), NOT pricing. Exposed so a future recapture that DOES reach transferOut can diff them.
 */
export const MENTO_RESERVE_GATING_SLOTS = {
  /** mapping isCollateralAsset(address) → bool. */
  isCollateralAsset: 25n,
  /** mapping isExchangeSpender(address) → bool. */
  isExchangeSpender: 20n,
  /** mapping collateralAssetSpendingLimit(address) → uint256 (a per-asset limit). */
  collateralAssetSpendingLimit: 26n,
} as const;

/** keccak256(abi.encode(address key, uint256 slot)) — a Solidity mapping(address=>_) storage key. */
function mentoMappingSlot(key: Hex, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(key), slot]));
}

export interface EtchedMentoGraph {
  /** Broker (BrokerProxy) — the discovery/getAmountOut/swapIn/approve target (captured mainnet address). */
  broker: Hex;
  /** The exchange provider (BiPoolManager) — a getAmountOut/swapIn arg + getExchanges discovery target. */
  exchangeProvider: Hex;
  /** The resolved bytes32 exchangeId for the cUSD/USDC pair. */
  exchangeId: Hex;
  /** The Reserve proxy (funded with local USDC so a collateral-out swapIn can pay out). */
  reserve: Hex;
  /** tokenIn (cUSD, STABLE) — a MintableBurnableERC20 etched at the real cUSD address. */
  tokenIn: Hex;
  /** tokenOut (USDC, COLLATERAL) — a MintableERC20 etched at the real USDC address. */
  tokenOut: Hex;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  /** Number of contracts etched (the whole graph). */
  contractCount: number;
  /** Number of storage slots reconstructed (captured touched slots + the transferOut gating slots). */
  slotCount: number;
  /** The pinned block timestamp the test must pin the clock to. */
  blockTimestamp: bigint;
}

/**
 * Stand up the captured REAL Mento V2 quote/swap contract GRAPH on the local anvil, OFFLINE. (Proven a full
 * swapIn against this etch receives USDC == the captured mainnet getAmountOut probe, wei-exact — see the
 * section header + harness/mento-snapshot.ts's anchor.)
 *
 *   1. Repoint the tokens: MintableBurnableERC20 for cUSD (stable, 18) + MintableERC20 for USDC (collateral,
 *      6), etched AT THEIR REAL ADDRESSES (the exchange assets are baked into the BiPoolManager config).
 *   2. setCode EVERY captured contract runtime at its captured address (the whole 16-contract graph).
 *   3. setStorageAt the captured touched storage VERBATIM by absolute key, per contract (incl. the buckets /
 *      oracle rate / breaker mode / getExchanges enumeration arrays).
 *   4. Reconstruct the three Reserve transferOut gating slots (see MENTO_RESERVE_GATING_SLOTS) so the REAL
 *      transferExchangeCollateralAsset executes (disclosed gating, not pricing).
 *   5. Fund the etched Reserve with local USDC (the collateral a swapIn releases) + optional caller headroom
 *      in the from-token (cUSD). NOTE: pin the clock with pinMentoBlockTimestamp after this, before the first
 *      quote/cook.
 */
export async function etchMentoGraph(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: MentoBytecodeSnapshot; state: MentoStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint; reserveFund?: bigint } = {},
): Promise<EtchedMentoGraph> {
  const { bytecode, state } = snapshots;
  const acct = (opts.minter ?? walletClient.account) as Account;

  const broker = getAddress(state.broker) as Hex;
  const provider = getAddress(state.exchangeProvider) as Hex;
  const reserve = getAddress(state.reserve) as Hex;
  const tokenIn = getAddress(state.tokenIn) as Hex; // real cUSD address (STABLE)
  const tokenOut = getAddress(state.tokenOut) as Hex; // real USDC address (COLLATERAL)

  // 1. Repoint the tokens: capture the burnable + plain runtimes, etch each at its real address + seed
  //    decimals. cUSD is STABLE (burned in transferIn) → burnable; USDC is COLLATERAL (Reserve safeTransfer)
  //    → plain. The exchange assets are BiPoolManager immutables ⇒ the local tokens MUST live at the reals.
  const burnScratch = await deployBurnableToken(walletClient, publicClient, "mento-cUSD-scratch", "SCUSD", state.tokenInDecimals);
  const burnRuntime = await publicClient.getCode({ address: burnScratch });
  if (!burnRuntime || burnRuntime === "0x") throw new Error("failed to capture MintableBurnableERC20 runtime");
  const plainScratch = await deployToken(walletClient, publicClient, "mento-USDC-scratch", "SUSDC", state.tokenOutDecimals);
  const plainRuntime = await publicClient.getCode({ address: plainScratch });
  if (!plainRuntime || plainRuntime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  await testClient.setCode({ address: tokenIn, bytecode: burnRuntime });
  await testClient.setStorageAt({ address: tokenIn, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(state.tokenInDecimals)) });
  await testClient.setCode({ address: tokenOut, bytecode: plainRuntime });
  await testClient.setStorageAt({ address: tokenOut, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(state.tokenOutDecimals)) });

  // 2. setCode EVERY captured contract runtime at its captured address (skip the two token addresses — they
  //    were repointed above; the graph's cUSD entry is the real proxy runtime, which we DON'T want).
  const tokenSet = new Set([tokenIn.toLowerCase(), tokenOut.toLowerCase()]);
  for (const c of bytecode.contracts) {
    const addr = getAddress(c.address) as Hex;
    if (tokenSet.has(addr.toLowerCase())) continue;
    await testClient.setCode({ address: addr, bytecode: c.runtime });
  }

  // 3. setStorageAt the captured touched storage VERBATIM by absolute key, per contract (skip the repointed
  //    token addresses — their captured proxy slots don't apply to the local ERC20 layout).
  let slotCount = 0;
  for (const [addr, slots] of Object.entries(state.storage)) {
    if (tokenSet.has(addr.toLowerCase())) continue;
    const a = getAddress(addr) as Hex;
    for (const [slot, value] of Object.entries(slots)) {
      await testClient.setStorageAt({ address: a, index: slot as Hex, value });
      slotCount++;
    }
  }

  // 4. Reconstruct the three Reserve transferOut gating slots (disclosed gating, not pricing) so the REAL
  //    collateral release executes. Set a permissive spending limit (100× the captured probe out) — the
  //    RELEASED amount is still the REAL BiPoolManager quote to the wei.
  const probeOut = BigInt(state.probe.amountOut);
  const spendLimit = probeOut * 100n > 0n ? probeOut * 100n : 10n ** 30n;
  await testClient.setStorageAt({ address: reserve, index: mentoMappingSlot(tokenOut, MENTO_RESERVE_GATING_SLOTS.isCollateralAsset), value: word(1n) });
  await testClient.setStorageAt({ address: reserve, index: mentoMappingSlot(broker, MENTO_RESERVE_GATING_SLOTS.isExchangeSpender), value: word(1n) });
  await testClient.setStorageAt({ address: reserve, index: mentoMappingSlot(tokenOut, MENTO_RESERVE_GATING_SLOTS.collateralAssetSpendingLimit), value: word(spendLimit) });
  slotCount += 3;

  // 5. Fund the etched Reserve with local USDC (the collateral released by a swapIn) + caller headroom in the
  //    from-token (cUSD). The Reserve holds the collateral the exchange pays out; fund it generously.
  const reserveFund = opts.reserveFund ?? probeOut * 1000n;
  await mint(walletClient, publicClient, tokenOut, reserve, reserveFund);
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, tokenIn, acct.address as Hex, opts.callerFund);
  }

  return {
    broker,
    exchangeProvider: provider,
    exchangeId: state.exchangeId as Hex,
    reserve,
    tokenIn,
    tokenOut,
    tokenInDecimals: state.tokenInDecimals,
    tokenOutDecimals: state.tokenOutDecimals,
    contractCount: bytecode.contracts.length,
    slotCount,
    blockTimestamp: BigInt(state.blockTimestamp),
  };
}

/** Mento V2 read surface (the discovery getters + the on-chain solver quote — the REAL verified interface). */
export const mentoBrokerReadAbi = parseAbi([
  "function getExchangeProviders() view returns (address[])",
  "function getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  "function swapIn(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (uint256)",
]);

/** BiPoolManager (exchange provider) discovery read surface. */
export const mentoExchangeProviderReadAbi = parseAbi([
  "function getExchanges() view returns ((bytes32 exchangeId, address[] assets)[])",
]);

// ── Fermi / propAMM (gattaca-com/propamm FermiSwapper — an Obric-style oracle-priced proactive AMM) ─────────
//
// Fermi is the FIRST oracle-priced proactive AMM captured as a real-code multi-contract GRAPH whose PRICING
// RESERVE lives in a SEPARATE vault (not the router). The quote/swap path (verified by trace) is:
//   quoteAmounts / fermiSwapWithAllowances (FermiSwapper 0xb1076fE3…)
//     -> oracle store getState/getSwapState (0xe514A3c4…)  [reads a per-feed price/config/last-update store]
//       -> feed helper getState (0xDa7AfeeD…)              [returns (timestamp, packed price) — the stale gate]
//       -> token.balanceOf(VAULT 0x585d4472…)              [the RESERVE the curve prices off — NOT the router]
//   the SWAP then does token.transferFrom(VAULT, taker, out) + token.transferFrom(taker, VAULT, in), resolving
//   the VAULT (payer/payee) from FermiSwapper storage SLOT 3.
//
// WHY the snapshot carries a VAULT + router slots 0..3 + an EIP-7702 EOA designator beyond the QUOTE
// access-list (the QUOTE access-list surfaces only the oracle store slot 2, the feed helper, and the token
// balanceOf reads):
//   · The QUOTE reads token.balanceOf(VAULT) — so the VAULT must HOLD the captured reserves offline (funded via
//     the local MintableERC20 mint), and the router's slot 3 must point at it. The router's OWN token balances
//     are dust and are NOT the pricing reserve (an early capture misdiagnosed them as "reserves").
//   · The SWAP does transferFrom(VAULT, taker, out) — so the VAULT must have APPROVED the router (mainnet grants
//     a max allowance); the harness sets the local token's allowance[vault][router] slot to max.
//   · The quote/swap path touches an EIP-7702 delegated EOA (0x4838b1…) via EXTCODESIZE/BALANCE. An empty
//     (codeless) account makes the FermiSwapper branch to a 0 quote, so the harness etches the captured 24-byte
//     0xef0100||delegate designator (the account is then code-bearing; the delegate itself is never CALLed on
//     the quote path, so its code is not required — only the designator's presence).
//
// TOKEN REPOINTING (the Fluid/Mento class — repoint the tokens, keep the REAL pricing contracts): WETH/USDC/
// WBTC are repointed to local MintableERC20s etched AT THEIR REAL ADDRESSES (the oracle-store feed configs are
// keyed by the real token addresses, so the local tokens MUST live at the reals). The ERC20 mechanics are NOT
// part of Fermi's oracle/curve pricing — the quote is wei-exact with the real oracle contracts regardless — so
// repointing preserves 100% of the pricing fidelity while making the token movements executable offline
// (PROVEN: a full fermiSwapWithAllowances against this etch received USDC == the captured mainnet quote, wei-
// exact, and the whole probe ladder reproduces bit-for-bit — see harness/fermi-snapshot.ts's anchor).
//
// BLOCK.TIMESTAMP: the oracle store gates freshness on block.timestamp ≤ feed.lastUpdate + maxAge; the price/
// config slots are byte-identical fresh-vs-stale (only the clock gates), so PINNING block.timestamp to the
// captured fresh ts reproduces the EXACT real quote (no price is fabricated). Call pinFermiBlockTimestamp AFTER
// etching and BEFORE the first quote/cook, on EVERY fresh anvil.

/** One contract in the Fermi graph bytecode snapshot (harness/fermi-snapshot.ts `contracts[]`). */
export interface FermiContractBytecode {
  address: Hex;
  role: string;
  runtime: Hex;
  runtimeSha256?: Hex;
  codeSizeBytes: number;
}

/** Fermi graph bytecode snapshot (harness/fermi-snapshot.ts). */
export interface FermiBytecodeSnapshot {
  chain: string;
  fermiSwapper: Hex;
  block: string;
  blockTimestamp: string;
  note?: string;
  contracts: FermiContractBytecode[];
}

/** Fermi graph state snapshot (harness/fermi-snapshot.ts). */
export interface FermiStateSnapshot {
  chain: string;
  fermiSwapper: Hex;
  block: string;
  blockTimestamp: string;
  staleUpdateSelector: string;
  target: { tokenIn: Hex; tokenOut: Hex; inSym: string; outSym: string };
  second: { tokenIn: Hex; tokenOut: Hex; inSym: string; outSym: string } | null;
  tokens: Record<string, { address: Hex; symbol: string; decimals: number }>;
  /** The union touched storage per contract (absolute slot → value), set verbatim on each etched contract. */
  contractSlots: Record<string, { role: string; slots: Record<string, Hex> }>;
  /** The RESERVE VAULT (FermiSwapper slot 3): the harness funds it + grants it a max router allowance. */
  vault: {
    address: Hex;
    role: string;
    reserves: Record<string, string>;
    allowanceToRouter: Record<string, string>;
  };
  /** The EIP-7702 EOA touched via EXTCODESIZE/BALANCE — the harness etches its 24-byte designator. */
  eoa7702: { address: Hex; designator: Hex; delegate: Hex } | null;
  probe: {
    target: { pair: string; ladder: { amountIn: string; amountOut: string }[] };
    second: { pair: string; ladder: { amountIn: string; amountOut: string }[] } | null;
  };
}

/** Load a Fermi `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadFermiSnapshots(name: string): {
  bytecode: FermiBytecodeSnapshot;
  state: FermiStateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as FermiBytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as FermiStateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the Fermi bytecode-graph integrity (NO RPC): re-hash EVERY contract runtime in the graph (FermiSwapper
 * + oracle store + feed helper + reserve vault + the 7702 EOA designator + the token proxies) and match its
 * capture-time sha256 anchor. A reviewer with no RPC key can run this to prove the checked-in blobs are the
 * pinned-block mainnet code, byte-for-byte.
 */
export function verifyFermiBytecodeIntegrity(bytecode: FermiBytecodeSnapshot): {
  contracts: { address: Hex; role: string; expected?: Hex; actual: Hex; ok: boolean }[];
  allOk: boolean;
} {
  const contracts = bytecode.contracts.map((c) => {
    const actual = runtimeSha256(c.runtime);
    return {
      address: c.address,
      role: c.role,
      expected: c.runtimeSha256,
      actual,
      ok: !c.runtimeSha256 || c.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { contracts, allOk: contracts.every((c) => c.ok) };
}

/** A minimal test-client surface for the Fermi block-timestamp pin (anvil_setTime + interval + mine). */
type FermiTimeClient = {
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
  setBlockTimestampInterval: (a: { interval: number }) => Promise<void>;
  mine: (a: { blocks: number }) => Promise<void>;
};

/**
 * Pin the anvil block clock to `state.blockTimestamp` and hold it (zero block-time interval) so the next
 * quote/cook — and every subsequent mined block through the cook — sees exactly the captured fresh ts. The
 * FermiSwapper's oracle store gates freshness on block.timestamp ≤ feed.lastUpdate + maxAge; at the captured ts
 * the feed is fresh and the quote is the real on-chain value. Uses `anvil_setTime` (can jump BACKWARD — a fresh
 * anvil's genesis clock is wall-time, PAST the pinned ts) + a zero interval so the setup mints + the cook do
 * not drift the clock past the stale window. Call AFTER etching and BEFORE the first quote/cook, on EVERY fresh
 * anvil.
 */
export async function pinFermiBlockTimestamp(
  testClient: FermiTimeClient,
  state: { blockTimestamp: string },
): Promise<bigint> {
  const ts = BigInt(state.blockTimestamp);
  await testClient.request({ method: "anvil_setTime", params: [Number(ts)] });
  await testClient.setBlockTimestampInterval({ interval: 0 });
  await testClient.mine({ blocks: 1 });
  return ts;
}

/** The local MintableERC20 allowance[owner][spender] storage slot (nested mapping at slot 5). */
function fermiAllowanceSlot(owner: Hex, spender: Hex): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(owner), 5n]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [getAddress(spender), inner]));
}

export interface EtchedFermiGraph {
  /** FermiSwapper (the discovery/quoteAmounts/fermiSwapWithAllowances/approve target — captured mainnet address). */
  fermiSwapper: Hex;
  /** The reserve vault (funded with the captured reserves; approves the router; payer/payee for the swap). */
  vault: Hex;
  /** tokenIn/tokenOut for the target pair — local MintableERC20s etched at the REAL token addresses. */
  tokenIn: Hex;
  tokenOut: Hex;
  /** The second quotable pair's from-token (WBTC) for the split cell — local MintableERC20 at the real address. */
  secondTokenIn: Hex | null;
  decimalsByAddress: Record<string, number>;
  /** Number of contracts etched (the whole graph) + storage slots reconstructed. */
  contractCount: number;
  slotCount: number;
  /** The pinned block timestamp the test must pin the clock to. */
  blockTimestamp: bigint;
}

/**
 * Stand up the captured REAL Fermi / propAMM quote/swap contract GRAPH on the local anvil, OFFLINE. (Proven a
 * full fermiSwapWithAllowances against this etch receives tokenOut == the captured mainnet quote, wei-exact,
 * and the whole probe ladder reproduces bit-for-bit — see the section header + harness/fermi-snapshot.ts.)
 *
 *   1. Repoint the tokens: a MintableERC20 etched AT EACH REAL token address (WETH/USDC/WBTC) + its decimals.
 *      For each token, set allowance[vault][router] = MAX (the vault's real max approval to the router, so the
 *      swap's transferFrom(vault, taker, out) lands).
 *   2. setCode EVERY captured contract runtime at its captured address (FermiSwapper + oracle store + feed
 *      helper + reserve vault + the EIP-7702 EOA designator + the token proxies — the token addresses are
 *      SKIPPED here, they were repointed in step 1).
 *   3. setStorageAt the captured touched storage VERBATIM by absolute key, per contract (incl. the FermiSwapper
 *      config slots 0..3 — slot 3 is the vault the swap resolves the payer from — + the oracle store's per-feed
 *      price/config/last-update slots + the feed helper's packed (ts,price) slots).
 *   4. Fund the VAULT with the captured reserves (the pricing reserve the quote reads via balanceOf(vault) +
 *      the inventory the swap pays out) + optional caller headroom in the from-token(s). NOTE: pin the clock
 *      with pinFermiBlockTimestamp after this, before the first quote/cook (the oracle staleness gate).
 */
export async function etchFermiGraph(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: FermiBytecodeSnapshot; state: FermiStateSnapshot },
  opts: { minter?: Account; callerFund?: bigint } = {},
): Promise<EtchedFermiGraph> {
  const { bytecode, state } = snapshots;
  const acct = (opts.minter ?? walletClient.account) as Account;
  const MAX = (1n << 256n) - 1n;

  const fermiSwapper = getAddress(state.fermiSwapper) as Hex;
  const vault = getAddress(state.vault.address) as Hex;
  const tokenIn = getAddress(state.target.tokenIn) as Hex;
  const tokenOut = getAddress(state.target.tokenOut) as Hex;
  const secondTokenIn = state.second ? (getAddress(state.second.tokenIn) as Hex) : null;

  // The token addresses (repointed) + their decimals.
  const decimalsByAddress: Record<string, number> = {};
  for (const t of Object.values(state.tokens)) decimalsByAddress[getAddress(t.address).toLowerCase()] = t.decimals;
  const tokenSet = new Set(Object.values(state.tokens).map((t) => getAddress(t.address).toLowerCase()));

  // 1. Repoint the tokens: capture a MintableERC20 runtime, etch at each real address + seed decimals + set the
  //    vault→router max allowance (the swap pulls the output from the vault).
  const scratch = await deployToken(walletClient, publicClient, "fermi-scratch", "FSCR", 18);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  for (const t of Object.values(state.tokens)) {
    const addr = getAddress(t.address) as Hex;
    await testClient.setCode({ address: addr, bytecode: erc20Runtime });
    await testClient.setStorageAt({ address: addr, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(t.decimals)) });
    await testClient.setStorageAt({ address: addr, index: fermiAllowanceSlot(vault, fermiSwapper), value: word(MAX) });
  }

  // 2. setCode EVERY captured contract runtime at its captured address (skip the repointed token addresses).
  for (const c of bytecode.contracts) {
    const addr = getAddress(c.address) as Hex;
    if (tokenSet.has(addr.toLowerCase())) continue;
    await testClient.setCode({ address: addr, bytecode: c.runtime });
  }

  // 3. setStorageAt the captured touched storage VERBATIM by absolute key, per contract (skip the repointed
  //    token addresses — their captured proxy slots don't apply to the local ERC20 layout).
  let slotCount = 0;
  for (const [addr, entry] of Object.entries(state.contractSlots)) {
    if (tokenSet.has(addr.toLowerCase())) continue;
    const a = getAddress(addr) as Hex;
    for (const [slot, value] of Object.entries(entry.slots)) {
      await testClient.setStorageAt({ address: a, index: slot as Hex, value });
      slotCount++;
    }
  }

  // 4. Fund the VAULT with the captured reserves (the pricing reserve + the swap-payout inventory) + optional
  //    caller headroom in the from-token(s).
  for (const [sym, reserve] of Object.entries(state.vault.reserves)) {
    const tok = state.tokens[sym];
    if (!tok) continue;
    await mint(walletClient, publicClient, getAddress(tok.address) as Hex, vault, BigInt(reserve));
  }
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, tokenIn, acct.address as Hex, opts.callerFund);
    if (secondTokenIn) await mint(walletClient, publicClient, secondTokenIn, acct.address as Hex, opts.callerFund);
  }

  return {
    fermiSwapper,
    vault,
    tokenIn,
    tokenOut,
    secondTokenIn,
    decimalsByAddress,
    contractCount: bytecode.contracts.length,
    slotCount,
    blockTimestamp: BigInt(state.blockTimestamp),
  };
}

/** Fermi / propAMM (FermiSwapper) read surface — the REAL verified interface (the quote/swap/aliveness path). */
export const fermiSwapperReadAbi = parseAbi([
  "function quoteAmounts(address tokenIn, address tokenOut, int256 amountSpecified) view returns (uint256 amountIn, uint256 amountOut)",
  "function isActive(address a, address b) view returns (bool)",
  "function fermiSwapWithAllowances(address tokenIn, address tokenOut, int256 amountSpecified, uint256 amountCheck, address recipient) returns (uint256, uint256)",
]);

// ══════════════════════════════════════════════════════════════════════════════
// EulerSwap V1 (euler-xyz/euler-swap tag eulerswap-1.0) prod-mirror etch — ADDITIVE extension.
//
// EulerSwap V1 is the SECOND WHOLE-GRAPH prod-mirror captured via debug_traceCall(prestateTracer) (after
// Mento): the swap moves the LP's funds through a ~24-contract EVK/EVC/oracle graph, so harness/
// eulerv1-snapshot.ts traces EVERY production entry point (getAssets/curve/getReserves/getParams/getLimits —
// discovery; computeQuote — the exec quote; a FULL SUCCESSFUL swap under a pre-transfer stateOverride — the
// exec write) and dumps {code, touched-storage} per address. So the snapshot's `contracts` is the FULL graph
// and `storage` is the union of touched slots keyed by ABSOLUTE contract address. This etch is the direct
// analogue of etchMentoGraph — setCode every captured contract at its captured address + setStorageAt every
// captured slot verbatim — with TWO source-specific wrinkles:
//
//   • TOKEN REPOINTING (Fluid/Wombat immutable-at-real-address class). Each EVK EVault bakes its underlying
//     token address as an IMMUTABLE in its 366-byte proxy runtime (verified: the real USDC address appears
//     in vault0's runtime; USDT in vault1's), and `getAssets()` == vault0.asset()/vault1.asset() resolves to
//     them. So the tokens CANNOT be repointed by a scalar overwrite — the etch etches a local MintableERC20
//     AT EACH REAL token address, funds each vault with its captured `cash` in the local token, and the swap
//     then deposits/withdraws the LOCAL storage-backed tokens through the REAL vault code (identical to
//     Fluid's token0/token1 + Liquidity-layer funding).
//   • BLOCK-TIMESTAMP PIN (Fluid/Mento class). The swap's vault liquidity check reads an EulerRouter oracle
//     whose ChainlinkOracle adapters enforce a `maxStaleness` window (90000s): the two captured feeds are
//     ~24060s / ~70476s stale at the pinned block, both < 90000s, so the test PINS block.timestamp to the
//     captured block ts (pinEulerV1BlockTimestamp) — where both feeds are fresh — reproducing the captured
//     quote to the wei. A fresh anvil's wall-clock (~2026) is FAR past ⇒ the staleness check would revert.
//
// NO factory shim is needed: FactoryType.EulerSwap discovery is KNOWN-POOL-ADDRESS based (the config carries
// the pool in `eulerSwapPools`; discoverEulerSwapPoolsTyped reads curve()+getParams()+getReserves()+
// getLimits() off the etched pool graph). The on-chain execution is CALLBACK-FREE (computeQuote staticcall +
// token.transfer(pool) + pool.swap(...,"") — the only re-entry is INTERNAL to Euler, the EVC self-wrap +
// vault deposit/withdraw, never the cooking contract), so NO engine SwapPoolType.
//
// FIDELITY: every contract in the swap path — pool, EulerSwap impl, EVC, both EVaults + all EVK module impls,
// the EulerRouter oracle + its two ChainlinkOracle adapters + their real Chainlink aggregators, the IRM, the
// dToken, Permit2 — is the REAL captured runtime, byte-for-byte. The Chainlink feed runtimes carry the REAL
// captured rounds (NOT shims), so the oracle prices the liquidity check off genuine mainnet feed data at the
// pinned timestamp. NO mock, NO shim, NO stand-in in the swap path.
// ══════════════════════════════════════════════════════════════════════════════

/** One contract in the EulerSwap V1 graph bytecode snapshot (harness/eulerv1-snapshot.ts `contracts[]`). */
export interface EulerV1ContractBytecode {
  address: Hex;
  role: string;
  runtime: Hex;
  runtimeSha256?: Hex;
  touchedSlots: number;
}

/** EulerSwap V1 graph bytecode snapshot (harness/eulerv1-snapshot.ts). */
export interface EulerV1BytecodeSnapshot {
  chain: string;
  chainId: number;
  block: string;
  blockTimestamp?: string;
  source: string;
  pool: Hex;
  factory: Hex;
  impl: Hex;
  contracts: EulerV1ContractBytecode[];
}

/** EulerSwap V1 graph state snapshot (harness/eulerv1-snapshot.ts). */
export interface EulerV1StateSnapshot {
  chain: string;
  chainId: number;
  block: string;
  blockTimestamp: string;
  source: string;
  pool: Hex;
  factory: Hex;
  asset0: Hex;
  asset1: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  isAsset0In: boolean;
  curve: Hex;
  reserve0: string;
  reserve1: string;
  status: number;
  params: {
    vault0: Hex; vault1: Hex; eulerAccount: Hex;
    equilibriumReserve0: string; equilibriumReserve1: string;
    priceX: string; priceY: string; concentrationX: string; concentrationY: string;
    fee: string; protocolFee: string; protocolFeeRecipient: Hex;
  };
  getLimits: { inLimit: string; outLimit: string };
  evc: Hex;
  vault0: Hex;
  vault1: Hex;
  eulerAccount: Hex;
  vault0Cash: string;
  vault1Cash: string;
  operatorAuthorized: boolean;
  chainlinkFeeds: { feed: Hex; roundId: string; answer: string; updatedAt: string; staleSecs: string }[];
  probe: { amountIn: string; amountOut: string };
  ladder: { cap: string; cumIn: string[]; cumOut: string[] };
  /** The union touched storage per contract (absolute slot → value), set verbatim on each etched contract. */
  storage: Record<string, Record<string, Hex>>;
}

/** Load a EulerSwap V1 `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadEulerV1Snapshots(name: string): {
  bytecode: EulerV1BytecodeSnapshot;
  state: EulerV1StateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as EulerV1BytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as EulerV1StateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the EulerSwap V1 bytecode-graph integrity (NO RPC): re-hash EVERY contract runtime in the graph and
 * match its capture-time sha256 anchor. Returns per-contract {address, role, expected, actual, ok} + allOk.
 * A reviewer with no RPC key can run this to prove the checked-in blobs are the pinned-block mainnet code,
 * byte-for-byte (mirrors verifyMentoBytecodeIntegrity).
 */
export function verifyEulerV1BytecodeIntegrity(bytecode: EulerV1BytecodeSnapshot): {
  contracts: { address: Hex; role: string; expected?: Hex; actual: Hex; ok: boolean }[];
  allOk: boolean;
} {
  const contracts = bytecode.contracts.map((c) => {
    const actual = runtimeSha256(c.runtime);
    return {
      address: c.address,
      role: c.role,
      expected: c.runtimeSha256,
      actual,
      ok: !c.runtimeSha256 || c.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { contracts, allOk: contracts.every((c) => c.ok) };
}

/** A minimal test-client surface for the EulerSwap V1 block-timestamp pin (anvil_setTime + mine). */
type EulerV1TimeClient = {
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
  mine: (a: { blocks: number }) => Promise<void>;
};

/**
 * Pin the anvil block clock to `state.blockTimestamp` and mine one block, so the next quote/cook sees a
 * `block.timestamp` at the captured block's ts — the window where the swap's oracle Chainlink feeds are
 * within their `maxStaleness` (90000s; the captured feeds are ~24060s/~70476s stale). Uses `anvil_setTime`
 * (can jump BACKWARD — a fresh anvil's genesis clock is at wall-time, FAR past the captured Ethereum ts, and
 * `evm_setNextBlockTimestamp` refuses to go backward). Call AFTER etching and BEFORE the first quote/cook, on
 * EVERY fresh anvil. Mirrors pinMentoBlockTimestamp / pinFluidBlockTimestamp.
 */
export async function pinEulerV1BlockTimestamp(
  testClient: EulerV1TimeClient,
  state: { blockTimestamp: string },
): Promise<bigint> {
  const ts = BigInt(state.blockTimestamp);
  await testClient.request({ method: "anvil_setTime", params: [Number(ts)] });
  await testClient.mine({ blocks: 1 });
  return ts;
}

/** The canonical Permit2 (the EVault deposit pull path routes through it). */
const EULERV1_PERMIT2 = getAddress("0x000000000022D473030F116dDEE9f6B43aC78BA3") as Hex;
/** MintableERC20 allowance mapping is at storage slot 5 (slot0 name, 1 symbol, 2 decimals, 3 totalSupply,
 *  4 balanceOf, 5 allowance) — verified against the fixture source. */
const ERC20_ALLOWANCE_SLOT = 5n;

/** keccak for allowance[owner][spender]: keccak256(spender ‖ keccak256(owner ‖ slot)). */
function mappingSlot2(owner: Hex, spender: Hex, slot: bigint): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(owner), slot]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [getAddress(spender), inner]));
}

export interface EtchedEulerV1Pool {
  /** The EulerSwap V1 pool address (the discovery/computeQuote/swap target — captured mainnet address). */
  pool: Hex;
  /** The EulerSwap factory address (echoed; the config wires it, discovery keys off factoryType). */
  factory: Hex;
  /** The EVC (Ethereum Vault Connector) address (etched real runtime). */
  evc: Hex;
  /** vault0/vault1 (EVK EVault proxies, funded with their captured cash in the local token). */
  vault0: Hex;
  vault1: Hex;
  /** tokenIn/tokenOut — local MintableERC20s etched at the REAL token addresses (vault immutables). */
  tokenIn: Hex;
  tokenOut: Hex;
  /** asset0/asset1 (the pool's canonical orientation — asset0 == the local token at the real asset0 addr). */
  asset0: Hex;
  asset1: Hex;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  /** true ⇒ tokenIn == asset0 (the swap output is amount1Out). */
  isAsset0In: boolean;
  /** Number of contracts etched (the whole graph) + storage slots reconstructed. */
  contractCount: number;
  slotCount: number;
  /** The pinned block timestamp the test must pin the clock to (Chainlink staleness). */
  blockTimestamp: bigint;
}

/**
 * Stand up the captured REAL EulerSwap V1 pool + its whole ~24-contract EVK/EVC/oracle GRAPH on the local
 * anvil, OFFLINE. (Proven a full swap against this etch receives tokenOut == the captured mainnet
 * computeQuote probe, wei-exact — see harness/eulerv1-snapshot.ts's anchor + the section header.)
 *
 *   1. Repoint the tokens: capture a local MintableERC20 runtime, etch it AT EACH REAL token address
 *      (asset0=USDC, asset1=USDT) + seed its `decimals` slot — because the EVaults bake the underlying token
 *      as an IMMUTABLE, the local tokens MUST live at the real addresses.
 *   2. setCode EVERY captured contract runtime at its captured address (the whole graph), skipping the two
 *      token addresses (repointed above — their captured proxy runtime is NOT wanted).
 *   3. setStorageAt the captured touched storage VERBATIM by absolute key, per contract (skipping the tokens —
 *      their captured proxy slots don't apply to the local ERC20 layout). This reconstructs the pool CtxLib
 *      reserves, the vault accounting, the EVC operator-auth + on-behalf, the oracle feed rounds, etc.
 *   4. Fund each vault with its captured `cash` in the LOCAL token (so cash == balanceOf holds and the swap's
 *      deposit/withdraw moves real balances), + optional caller headroom in tokenIn. NOTE: pin the clock with
 *      pinEulerV1BlockTimestamp after this, before the first quote/cook (Chainlink staleness — see header).
 *
 * The swap path then runs the GENUINE graph: computeQuote returns the mainnet-identical dy for the captured
 * curve+vault state, and pool.swap deposits the pre-transferred tokenIn into vault0 + withdraws tokenOut from
 * vault1 (via the EVC + the real oracle liquidity check) — all real captured code, no fork, no RPC.
 */
export async function etchEulerV1Pool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient,
  snapshots: { bytecode: EulerV1BytecodeSnapshot; state: EulerV1StateSnapshot },
  opts: { minter?: Account; callerFund?: bigint } = {},
): Promise<EtchedEulerV1Pool> {
  const { bytecode, state } = snapshots;
  const acct = (opts.minter ?? walletClient.account) as Account;

  const pool = getAddress(state.pool) as Hex;
  const evc = getAddress(state.evc) as Hex;
  const vault0 = getAddress(state.vault0) as Hex;
  const vault1 = getAddress(state.vault1) as Hex;
  const asset0 = getAddress(state.asset0) as Hex;
  const asset1 = getAddress(state.asset1) as Hex;
  const tokenIn = getAddress(state.tokenIn) as Hex;
  const tokenOut = getAddress(state.tokenOut) as Hex;

  // 1. Repoint the tokens: one local MintableERC20 runtime, etched at EACH real asset address + seed decimals.
  //    asset0/asset1 (== the vaults' underlying) are EVault immutables ⇒ the local tokens MUST live there.
  const scratch = await deployToken(walletClient, publicClient, "eulerv1-scratch", "ESCR", 6);
  const erc20Runtime = await publicClient.getCode({ address: scratch });
  if (!erc20Runtime || erc20Runtime === "0x") throw new Error("failed to capture MintableERC20 runtime");
  const decByAsset: Record<string, number> = {
    [asset0.toLowerCase()]: asset0.toLowerCase() === tokenIn.toLowerCase() ? state.tokenInDecimals : state.tokenOutDecimals,
    [asset1.toLowerCase()]: asset1.toLowerCase() === tokenIn.toLowerCase() ? state.tokenInDecimals : state.tokenOutDecimals,
  };
  const tokenSet = new Set([asset0.toLowerCase(), asset1.toLowerCase()]);
  for (const tok of [asset0, asset1]) {
    await testClient.setCode({ address: tok, bytecode: erc20Runtime });
    await testClient.setStorageAt({ address: tok, index: slotHex(ERC20_DECIMALS_SLOT), value: word(BigInt(decByAsset[tok.toLowerCase()])) });
  }

  // 2. setCode EVERY captured contract runtime at its captured address (the whole graph; skip the tokens).
  for (const c of bytecode.contracts) {
    const addr = getAddress(c.address) as Hex;
    if (tokenSet.has(addr.toLowerCase())) continue;
    await testClient.setCode({ address: addr, bytecode: c.runtime });
  }

  // 3. setStorageAt the captured touched storage VERBATIM by absolute key, per contract (skip the repointed
  //    token addresses — their captured proxy slots don't apply to the local ERC20 layout). This INCLUDES
  //    the Permit2 record slot (keyed by the REAL pool/token/vault addresses, all preserved by the etch), so
  //    the Permit2-mediated pull below finds the pool's Permit2 allowance for the vault intact.
  let slotCount = 0;
  for (const [addr, slots] of Object.entries(state.storage)) {
    if (tokenSet.has(addr.toLowerCase())) continue;
    const a = getAddress(addr) as Hex;
    for (const [slot, value] of Object.entries(slots)) {
      await testClient.setStorageAt({ address: a, index: slot as Hex, value });
      slotCount++;
    }
  }

  // 4. Reconstruct the pool → Permit2 pull allowance on the LOCAL tokens (the ONE piece the token-repoint
  //    drops). EulerSwap's depositAssets pulls the pre-transferred input from the pool into the vault via
  //    Permit2: Permit2.transferFrom(pool, vault, amt, token) checks its OWN allowance record (reconstructed
  //    verbatim in step 3, keyed by the real pool/token/vault) THEN calls token.transferFrom(pool, vault, amt)
  //    with Permit2 as the spender — so the token must record allowance[pool][Permit2]. On mainnet the pool
  //    holds a near-infinite pool→Permit2 approval (verified: the swap DECREMENTS Circle-USDC's
  //    allowed[pool][Permit2] slot by exactly the input); that approval lives in the token's storage, which
  //    the repoint skipped. Set it to max on the LOCAL token layout (MintableERC20 allowance is slot 5, and
  //    its transferFrom treats type(uint256).max as infinite ⇒ no decrement) so the REAL Permit2-mediated
  //    pull succeeds. GATING, not pricing — the pulled AMOUNT is still the real curve/vault result.
  const set = async (addr: Hex, slot: Hex, value: Hex) =>
    testClient.setStorageAt({ address: addr, index: slot, value });
  for (const tok of [asset0, asset1]) {
    const allowanceSlot = mappingSlot2(pool, EULERV1_PERMIT2, ERC20_ALLOWANCE_SLOT);
    await set(tok, allowanceSlot, word((1n << 256n) - 1n));
  }

  // 5. Fund each vault with its captured `cash` in the LOCAL token (so the vault's cash == balanceOf invariant
  //    holds and the swap's deposit/withdraw moves real balances), + caller headroom in tokenIn. vault0 holds
  //    asset0, vault1 holds asset1.
  await mint(walletClient, publicClient, asset0, vault0, BigInt(state.vault0Cash));
  await mint(walletClient, publicClient, asset1, vault1, BigInt(state.vault1Cash));
  if (opts.callerFund && opts.callerFund > 0n) {
    await mint(walletClient, publicClient, tokenIn, acct.address as Hex, opts.callerFund);
  }

  return {
    pool,
    factory: getAddress(state.factory) as Hex,
    evc,
    vault0,
    vault1,
    tokenIn,
    tokenOut,
    asset0,
    asset1,
    tokenInDecimals: state.tokenInDecimals,
    tokenOutDecimals: state.tokenOutDecimals,
    isAsset0In: state.isAsset0In,
    contractCount: bytecode.contracts.length,
    slotCount,
    blockTimestamp: BigInt(state.blockTimestamp),
  };
}

/** EulerSwap V1 pool read surface (the getters the test + discovery + exec read on the REAL pool graph). */
export const eulerV1PoolReadAbi = parseAbi([
  "function curve() view returns (bytes32)",
  "function getAssets() view returns (address asset0, address asset1)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 status)",
  "function getParams() view returns ((address vault0, address vault1, address eulerAccount, uint112 equilibriumReserve0, uint112 equilibriumReserve1, uint256 priceX, uint256 priceY, uint256 concentrationX, uint256 concentrationY, uint256 fee, uint256 protocolFee, address protocolFeeRecipient) params)",
  "function getLimits(address tokenIn, address tokenOut) view returns (uint256 inLimit, uint256 outLimit)",
  "function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn) view returns (uint256)",
]);

// ══════════════════════════════════════════════════════════════════════════════
// Balancer V3 (balancer/balancer-v3-monorepo — Vault singleton + per-chain Router) prod-mirror etch —
// a WHOLE-GRAPH real-bytecode etch (the Mento class). See harness/balancerv3-snapshot.ts for the capture.
//
// The wired Base FactoryType.BalancerV3 pool 0x7ab1… ("Balancer Aave USDC-Aave GHO") is StableSurge-hooked
// (DYNAMIC fee) + rate-scaled (its swappable tokens are ERC4626 StaticATokenLM WRAPPERS waGHO/waUSDC whose
// rate = Aave getReserveNormalizedIncome). There is NO closed-form curve the recipe replays off-chain — the
// price comes from a ~20-contract graph (Router → Vault/VaultExtension → Pool → StableSurgeHook + 2 rate
// providers → 2 ERC4626 wrappers → Aave Pool + rewards controller + aToken). harness/balancerv3-snapshot.ts
// let the EVM enumerate the exact touched set (debug_traceCall prestateTracer on the production query AND a
// REAL successful swap) and dumped {code, touched-storage} per address. So the snapshot's `contracts[]` is the
// FULL graph and `storage` is the union of touched slots keyed by ABSOLUTE contract address.
//
// NO TOKEN REPOINTING (unlike Fluid/Mento). The swappable tokens ARE the ERC4626 wrappers, whose rate is
// pricing-relevant — so we keep the REAL wrapper bytecode + storage and fund the caller by a REAL transfer
// from the Vault (impersonated) at etch time. The ONE reconstruction nuance is `_reservesOf` (Vault mapping
// base slot 8, PERSISTENT, must == balanceOf(vault) at unlock; settle() credits balanceOf-_reservesOf): the
// etch re-seeds `_reservesOf[token] = balanceOf(vault)` for BOTH tokens after funding, restoring the on-unlock
// invariant (a replay of real state, not a fabrication — verified: with it seeded, a REAL swap lands the
// captured mainnet out to the wei). block.timestamp is pinned (the wrapper rate accrues on it).
// ══════════════════════════════════════════════════════════════════════════════

/** One contract in the Balancer V3 graph bytecode snapshot (harness/balancerv3-snapshot.ts `contracts[]`). */
export interface BalancerV3ContractBytecode {
  address: Hex;
  role: string;
  runtime: Hex;
  runtimeSha256?: Hex;
  touchedSlots: number;
}

/** Balancer V3 graph bytecode snapshot (harness/balancerv3-snapshot.ts). */
export interface BalancerV3BytecodeSnapshot {
  chain: string;
  chainId: number;
  block: string;
  blockTimestamp: string;
  source: string;
  vault: Hex;
  router: Hex;
  pool: Hex;
  permit2: Hex;
  contracts: BalancerV3ContractBytecode[];
}

/** Balancer V3 graph state snapshot (harness/balancerv3-snapshot.ts). */
export interface BalancerV3StateSnapshot {
  chain: string;
  chainId: number;
  block: string;
  blockTimestamp: string;
  source: string;
  vault: Hex;
  router: Hex;
  pool: Hex;
  permit2: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  /** `_reservesOf` reconstruction anchors — mapping base slot 8; the two token slots (verbatim keys). */
  reservesOfBaseSlot: string;
  reservesOfSlotIn: Hex;
  reservesOfSlotOut: Hex;
  vaultBalanceIn: string;
  vaultBalanceOut: string;
  reservesOfIn: string;
  reservesOfOut: string;
  /** Wei-exact anchor: the Router.querySwapSingleTokenExactIn ladders, both directions. */
  probe: {
    inToOut: { amountIn: string; amountOut: string }[];
    outToIn: { amountIn: string; amountOut: string }[];
  };
  /** The union touched storage per contract (absolute slot → value), set verbatim on each etched contract. */
  storage: Record<string, Record<string, Hex>>;
}

/** Load a Balancer V3 `<name>.bytecode.json` + `<name>.state.json` pair from fixtures/snapshots. */
export function loadBalancerV3Snapshots(name: string): {
  bytecode: BalancerV3BytecodeSnapshot;
  state: BalancerV3StateSnapshot;
} {
  const bytecode = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.bytecode.json`), "utf-8"),
  ) as BalancerV3BytecodeSnapshot;
  const state = JSON.parse(
    readFileSync(join(SNAP_DIR, `${name}.state.json`), "utf-8"),
  ) as BalancerV3StateSnapshot;
  return { bytecode, state };
}

/**
 * Verify the Balancer V3 bytecode-graph integrity (NO RPC): re-hash EVERY contract runtime in the graph and
 * match its capture-time sha256 anchor. Returns per-contract {address, role, expected, actual, ok} + allOk. A
 * reviewer with no RPC key can run this to prove the checked-in blobs are the pinned-block mainnet code,
 * byte-for-byte.
 */
export function verifyBalancerV3BytecodeIntegrity(bytecode: BalancerV3BytecodeSnapshot): {
  contracts: { address: Hex; role: string; expected?: Hex; actual: Hex; ok: boolean }[];
  allOk: boolean;
} {
  const contracts = bytecode.contracts.map((c) => {
    const actual = runtimeSha256(c.runtime);
    return {
      address: c.address,
      role: c.role,
      expected: c.runtimeSha256,
      actual,
      ok: !c.runtimeSha256 || c.runtimeSha256.toLowerCase() === actual.toLowerCase(),
    };
  });
  return { contracts, allOk: contracts.every((c) => c.ok) };
}

/** A minimal test-client surface for the Balancer V3 block-timestamp pin + Vault-impersonation funding. */
type BalancerV3TimeClient = {
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
  mine: (a: { blocks: number }) => Promise<void>;
};

/**
 * Pin the anvil block clock to `state.blockTimestamp` and mine one block. The ERC4626 wrappers' rate =
 * Aave getReserveNormalizedIncome, which accrues on `block.timestamp - lastUpdateTimestamp`; pinning to the
 * captured block ts reproduces the captured probe rate EXACTLY. Uses `anvil_setTime` (can jump BACKWARD — a
 * fresh anvil's genesis clock is at wall-time, PAST the captured Base ts). Call AFTER etching and BEFORE the
 * first quote/cook, on EVERY fresh anvil.
 */
export async function pinBalancerV3BlockTimestamp(
  testClient: BalancerV3TimeClient,
  state: { blockTimestamp: string },
): Promise<bigint> {
  const ts = BigInt(state.blockTimestamp);
  await testClient.request({ method: "anvil_setTime", params: [Number(ts)] });
  await testClient.mine({ blocks: 1 });
  return ts;
}

export interface EtchedBalancerV3Graph {
  /** Vault (CREATE2 singleton) — holds the pool balances + `_reservesOf`; funded so the swap pays out. */
  vault: Hex;
  /** The per-chain single-swap Router — the query/swap/Permit2-approve-spender target (cfg[8] chain-wide). */
  router: Hex;
  /** The StablePool address (the swap/query `pool` arg + discovery target). */
  pool: Hex;
  /** The canonical Permit2 (the solver hardcodes it; etched real). */
  permit2: Hex;
  /** tokenIn (waUSDC, 6d) — the REAL ERC4626 wrapper (kept, not repointed); the caller holds it. */
  tokenIn: Hex;
  /** tokenOut (waGHO, 18d) — the REAL ERC4626 wrapper. */
  tokenOut: Hex;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  /** Number of contracts etched (the whole graph). */
  contractCount: number;
  /** Number of storage slots reconstructed (captured touched slots + the 2 re-seeded `_reservesOf` slots). */
  slotCount: number;
  /** The pinned block timestamp the test must pin the clock to. */
  blockTimestamp: bigint;
  /** The amount of tokenIn the caller was funded with (real transfer from the impersonated Vault). */
  callerFunded: bigint;
}

/**
 * Stand up the captured REAL Balancer V3 quote/swap contract GRAPH on the local anvil, OFFLINE. (Proven: a
 * full swapSingleTokenExactIn against this etch receives the captured mainnet querySwap out, wei-exact — see
 * the section header + harness/balancerv3-snapshot.ts's anchor.)
 *
 *   1. setCode EVERY captured contract runtime at its captured address (the whole ~20-contract graph:
 *      Router + Vault + VaultExtension + Pool + StableSurgeHook + 2 rate providers + 2 ERC4626 wrappers +
 *      their impl + the Aave Pool + rewards controller + aToken + Permit2 + the impls). NO repointing — the
 *      wrappers ARE the swappable tokens and their rate is pricing-relevant.
 *   2. setStorageAt the captured touched storage VERBATIM by absolute key, per contract (the Vault's pool
 *      balance accounting + `_reservesOf`, the wrappers' share state, the Aave indices, the hook config).
 *   3. Fund the caller with `callerFund` of tokenIn (waUSDC) by a REAL StaticATokenLM transfer from the
 *      impersonated Vault (the Vault holds the tokens via the captured storage). Uses `rpcUrl` to bind a
 *      wallet client to the Vault.
 *   4. RE-SEED `_reservesOf[token] = balanceOf(vault)` for BOTH tokens (mapping base slot 8) AFTER funding —
 *      the on-unlock invariant settle() relies on (else BalanceNotSettled). A replay of real state.
 *   5. Fund the Vault with ETH headroom (impersonation gas is paid by anvil).
 *
 * NOTE: pin the clock with pinBalancerV3BlockTimestamp after this and before the first quote/cook (the
 * wrapper rate accrual — see the header).
 */
export async function etchBalancerV3Graph(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: MiniTestClient & BalancerV3TimeClient,
  rpcUrl: string,
  snapshots: { bytecode: BalancerV3BytecodeSnapshot; state: BalancerV3StateSnapshot },
  opts: { caller: Hex; callerFund: bigint },
): Promise<EtchedBalancerV3Graph> {
  // Lazy viem imports (kept local so the harness's default import surface stays lean).
  const { createWalletClient, http, encodeFunctionData, parseAbi: parseAbiL } = await import("viem");
  const { bytecode, state } = snapshots;

  const vault = getAddress(state.vault) as Hex;
  const router = getAddress(state.router) as Hex;
  const pool = getAddress(state.pool) as Hex;
  const permit2 = getAddress(state.permit2) as Hex;
  const tokenIn = getAddress(state.tokenIn) as Hex;
  const tokenOut = getAddress(state.tokenOut) as Hex;

  // 1. setCode EVERY captured contract runtime at its captured address (the whole graph).
  for (const c of bytecode.contracts) {
    await testClient.setCode({ address: getAddress(c.address) as Hex, bytecode: c.runtime });
  }

  // 2. setStorageAt the captured touched storage VERBATIM by absolute key, per contract.
  let slotCount = 0;
  for (const [addr, slots] of Object.entries(state.storage)) {
    const a = getAddress(addr) as Hex;
    for (const [slot, value] of Object.entries(slots)) {
      await testClient.setStorageAt({ address: a, index: slot as Hex, value });
      slotCount++;
    }
  }

  // 3. Fund the caller with tokenIn via a REAL transfer from the impersonated Vault (which holds the tokens
  //    via the captured storage). The wrapper is REAL StaticATokenLM code — this exercises its genuine
  //    scaled-share transfer, so the caller's balance is real. Give the Vault generous ETH headroom + send a
  //    legacy 0-gas-price tx so the impersonated transfer never fails on gas (the StaticATokenLM transfer is
  //    a heavy op; the anvil chain's base fee is irrelevant with gasPrice 0).
  await testClient.request({ method: "anvil_setBalance", params: [vault, viemToHex(10_000n * 10n ** 18n)] });
  await testClient.request({ method: "anvil_impersonateAccount", params: [vault] });
  const erc20 = parseAbiL(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
  // Bind the Vault wallet client to the public client's chain so viem estimates EIP-1559 fees correctly (the
  // anvil chain has a non-zero base fee, so a legacy gasPrice:0 is rejected; the Vault has ample ETH above).
  const vaultWallet = createWalletClient({ account: vault, chain: publicClient.chain, transport: http(rpcUrl) });
  // callerFund MUST be ≤ the Vault's tokenIn balance (the Vault is the token source). Fail loudly otherwise.
  const vaultTokenInBal = (await publicClient.readContract({ address: tokenIn, abi: erc20, functionName: "balanceOf", args: [vault] })) as bigint;
  if (opts.callerFund > vaultTokenInBal) {
    throw new Error(`callerFund ${opts.callerFund} exceeds the etched Vault's tokenIn balance ${vaultTokenInBal} (the fund source)`);
  }
  const hFund = await vaultWallet.sendTransaction({
    to: tokenIn,
    data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [opts.caller, opts.callerFund] }),
    account: vault,
  });
  const fundRcpt = await publicClient.waitForTransactionReceipt({ hash: hFund });
  if (fundRcpt.status !== "success") throw new Error("caller funding transfer (impersonated Vault) reverted");
  await testClient.request({ method: "anvil_stopImpersonatingAccount", params: [vault] });

  // 4. RE-SEED `_reservesOf[token] = balanceOf(vault)` for BOTH tokens AFTER funding (the on-unlock invariant).
  for (const [tok, slot] of [
    [tokenIn, state.reservesOfSlotIn],
    [tokenOut, state.reservesOfSlotOut],
  ] as [Hex, Hex][]) {
    const bal = (await publicClient.readContract({ address: tok, abi: erc20, functionName: "balanceOf", args: [vault] })) as bigint;
    await testClient.setStorageAt({ address: vault, index: slot, value: word(bal) });
    slotCount++;
  }

  return {
    vault,
    router,
    pool,
    permit2,
    tokenIn,
    tokenOut,
    tokenInDecimals: state.tokenInDecimals,
    tokenOutDecimals: state.tokenOutDecimals,
    contractCount: bytecode.contracts.length,
    slotCount,
    blockTimestamp: BigInt(state.blockTimestamp),
    callerFunded: opts.callerFund,
  };
}

/** Balancer V3 read surface (the discovery getters + the on-chain solver quote — the REAL verified interface). */
export const balancerV3VaultReadAbi = parseAbi([
  "function getPoolTokens(address pool) view returns (address[])",
  "function isPoolRegistered(address pool) view returns (bool)",
  "function getReservesOf(address token) view returns (uint256)",
]);
export const balancerV3RouterReadAbi = parseAbi([
  "function querySwapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, address sender, bytes userData) view returns (uint256 amountOut)",
  "function getPermit2() view returns (address)",
]);
