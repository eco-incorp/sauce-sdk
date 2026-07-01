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

export { erc20Abi };
