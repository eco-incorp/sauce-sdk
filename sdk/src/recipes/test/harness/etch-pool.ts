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
  type Hex,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";

import { deployToken, erc20Abi, mint } from "./setup";

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
//   • the DODO factory (getDODO(base,quote) → address[]) the production FactoryType.DODOZoo
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

/** getDODO(address,address) selector (production FactoryType.DODOZoo discovery). */
const GET_DODO_SELECTOR = "1273b0c6";

/**
 * A minimal read-only DODO FACTORY shim: getDODO(base,quote) → the single reproduced pool as a
 * one-element address[]; every other pair / selector → an empty address[]. We setCode this at the
 * captured factory address and store the pool at slot0. NO Solidity compile, NO write tx.
 *
 * ABI return for a one-element address[]: head offset 0x20, then [length=1, pool] — 3 words.
 * Empty array: [0x20, 0] — 2 words. The shim answers getDODO unconditionally (address-agnostic):
 * the test stands up exactly ONE DODO pool for the pair, so a constant reply is faithful (the
 * production discovery queries BOTH orderings and de-dupes on the pool address, so replying the
 * SAME pool to both orderings is correct — the second is dropped by discovery's `seen` set).
 */
export function buildDodoFactoryShimRuntime(): Hex {
  // Runtime:
  //   sel = shr(0xe0, calldataload(0))
  //   if sel == getDODO: mstore(0,0x20); mstore(0x20,1); mstore(0x40,sload(0)); return(0,0x60)
  //   else:              mstore(0,0x20); mstore(0x20,0);                        return(0,0x40)
  //
  // Hand-assembled with an offset-exact JUMPDEST for the getDODO body.
  const bytes = (h: string) => h.length / 2;
  const header = "60003560e01c"; // PUSH1 0 CALLDATALOAD PUSH1 0xe0 SHR
  // DUP1 PUSH4 <sel> EQ PUSH2 <dest> JUMPI
  const cmp = (sel: string, dest: number) =>
    "8063" + sel + "1461" + dest.toString(16).padStart(4, "0") + "57";
  // Empty-array body (fallthrough): mstore(0,0x20) mstore(0x20,0) return(0,0x40)
  //   PUSH1 0x20 PUSH1 0 MSTORE  PUSH1 0 PUSH1 0x20 MSTORE  PUSH1 0x40 PUSH1 0 RETURN
  const emptyBody = "6020600052" + "6000602052" + "604060" + "00f3";
  // getDODO body (JUMPDEST): mstore(0,0x20) mstore(0x20,1) mstore(0x40,sload(0)) return(0,0x60)
  //   JUMPDEST PUSH1 0x20 PUSH1 0 MSTORE  PUSH1 1 PUSH1 0x20 MSTORE
  //   PUSH1 0 SLOAD PUSH1 0x40 MSTORE  PUSH1 0x60 PUSH1 0 RETURN
  const dodoBody =
    "5b" + "6020600052" + "6001602052" + "600054604052" + "606060" + "00f3";

  const dispatchLen = bytes(header) + bytes(cmp(GET_DODO_SELECTOR, 0)) + bytes(emptyBody);
  const dodoDest = dispatchLen; // getDODO JUMPDEST sits right after the empty-array fallthrough
  const code = header + cmp(GET_DODO_SELECTOR, dodoDest) + emptyBody + dodoBody;
  return ("0x" + code) as Hex;
}

/** MT fee-rate model shim slot layout: slot0 = the captured resolved mtFeeRate. */
const MT_SHIM_RATE_SLOT = 0;

/** getFeeRate(address) / _FEE_RATE_() selectors — the two readers the DSP + discovery use. */
const GET_FEE_RATE_SELECTOR = "8198edbf";
const FEE_RATE_SELECTOR = "bd2e6ca3";

export interface EtchedDodoPool {
  /** The DSP pool address (the getDODO / sell target discovery resolves). */
  pool: Hex;
  /** The DSP implementation address (etched with the real impl runtime). */
  impl: Hex;
  /** The DODO factory shim (getDODO) — point a poolConfig DODOZoo factory here. */
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

/** DODO factory shim read surface (getDODO). */
export const dodoFactoryShimAbi = parseAbi([
  "function getDODO(address baseToken, address quoteToken) view returns (address[] pools)",
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

export { erc20Abi };
