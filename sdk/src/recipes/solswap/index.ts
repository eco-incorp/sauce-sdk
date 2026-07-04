/**
 * Solswap recipe: N-pool on-chain quote-and-swap for the SVM engine.
 *
 * Attaches N pool state accounts read-only, quotes every pool IN the VM from
 * `accountData` reads, branches to the single best venue, makes ONE CPI to the
 * winner, enforces minOut (inclusive: bestOut == minOut passes), and returns
 * bestOut. On an exact quote tie the first-listed pool wins (the scan is
 * strictly-greater). Quoting N venues costs N read-only accounts; every
 * venue's swap accounts are attached with their declared flags, but only the
 * winner's swap accounts are written.
 *
 * v1 scope (deliberate): real AMM adapters (Raydium/Orca layouts, little-endian
 * u64 reserve decoding, CLMM tick math) are out of scope — the pool layout here
 * is the recipe's own canonical big-endian fixture layout (32-byte BE reserves
 * at caller-given offsets), and the "swap" CPI is whatever instruction the
 * caller bakes per pool (the e2e suite uses a system-program transfer standing
 * in for the venue call). The value is the compiled control-flow/account-plan
 * shape, which is venue-agnostic. See README.md.
 *
 * Overflow assumption: engine arithmetic wraps (no overflow revert). The quote
 * `mulDiv(ainFee, rOut, rIn * 10000 + ainFee)` is full-precision in the
 * numerator product, so the only wrap hazards are the denominator sum and the
 * quotient; both are safe while reserves and amountIn stay below 2^128 —
 * astronomically above real token magnitudes. Callers must not feed values
 * near 2^240.
 */

// Static ESM import, unlike the sibling recipes' createRequire shim: both this
// module and the compiler package are ESM, and jest's ESM runtime rejects a
// createRequire() of an ES module while it handles this import fine.
import { getAddressCodec } from "@solana/kit";
import { compile } from "@eco-incorp/sauce-compiler";
import type { AccountPlan } from "@eco-incorp/sauce-compiler";

export interface SolswapPool {
  /** Account ref of the pool state account (attached readonly, quoted in-VM). */
  ref: string;
  /** Byte offset of the 32-byte big-endian reserveIn word in the pool account data. */
  reserveInOffset: number;
  /** Byte offset of the 32-byte big-endian reserveOut word in the pool account data. */
  reserveOutOffset: number;
  /** Swap fee in basis points (e.g. 30n = 0.30%). */
  feeBps: bigint;
  /** What to CPI when this pool wins. */
  swap: {
    /** Ref of the venue program account (must be attached for the CPI to resolve). */
    programRef: string;
    /** The venue program id (32 bytes) — baked into the bytecode as the CALL target. */
    programId: Uint8Array;
    /** Raw CPI instruction data (venue discriminator included). */
    calldata: Uint8Array;
    accounts: { ref: string; writable?: boolean; signer?: boolean }[];
  };
}

export interface SolswapConfig {
  /** Candidate pools in preference order — the first-listed pool wins an exact quote tie. */
  pools: SolswapPool[];
  amountIn: bigint;
  /** Minimum acceptable bestOut, inclusive: the program reverts only when bestOut < minOut. */
  minOut: bigint;
}

export interface SolswapOutput {
  /** Generated SauceScript source (for debugging). */
  source: string;
  /** Compiled `target: 'svm'` bytecode for one engine execute instruction. */
  bytecode: Uint8Array;
  /**
   * Ordered user-account plan: metas[i] is user-account index i (instruction
   * account 3+i). Venue program metas carry their pubkey (from swap.programId),
   * so `resolveAccounts` binds them without a resolution entry.
   */
  accountPlan: AccountPlan;
  warnings: string[];
}

/**
 * Constant-product quote with fee — the exact integer math the generated
 * bytecode runs on-chain, for computing expected outputs off-chain:
 * `out = (amountIn * (10000 - feeBps) * reserveOut) / (reserveIn * 10000 + amountIn * (10000 - feeBps))`.
 */
export function solswapQuote(amountIn: bigint, feeBps: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * (10000n - feeBps);
  return (amountInWithFee * reserveOut) / (reserveIn * 10000n + amountInWithFee);
}

function hexLiteral(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function accountEntry(account: { ref: string; writable?: boolean; signer?: boolean }): string {
  const flags = [
    ...(account.writable ? ["writable: true"] : []),
    ...(account.signer ? ["signer: true"] : []),
  ];
  if (flags.length === 0) return JSON.stringify(account.ref);
  return `{ ref: ${JSON.stringify(account.ref)}, ${flags.join(", ")} }`;
}

function validate({ pools, amountIn, minOut }: SolswapConfig): void {
  if (pools.length < 2 || pools.length > 8) {
    throw new Error(`solswap expects 2 to 8 pools, got ${pools.length}`);
  }
  if (amountIn <= 0n) throw new Error(`solswap amountIn must be positive, got ${amountIn}`);
  if (minOut < 0n) throw new Error(`solswap minOut must be non-negative, got ${minOut}`);

  const programIds = new Map<string, string>();
  for (const pool of pools) {
    if (pool.feeBps < 0n || pool.feeBps >= 10000n) {
      throw new Error(`solswap pool '${pool.ref}' feeBps must be in [0, 10000), got ${pool.feeBps}`);
    }
    for (const offset of [pool.reserveInOffset, pool.reserveOutOffset]) {
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`solswap pool '${pool.ref}' reserve offsets must be non-negative integers, got ${offset}`);
      }
    }
    if (pool.swap.programId.length !== 32) {
      throw new Error(`solswap pool '${pool.ref}' swap.programId must be 32 bytes, got ${pool.swap.programId.length}`);
    }
    if (pool.swap.accounts.length === 0) {
      throw new Error(`solswap pool '${pool.ref}' swap.accounts must not be empty`);
    }

    const programId = hexLiteral(pool.swap.programId);
    const bound = programIds.get(pool.swap.programRef);
    if (bound !== undefined && bound !== programId) {
      throw new Error(`solswap program ref '${pool.swap.programRef}' is bound to two different program ids`);
    }
    programIds.set(pool.swap.programRef, programId);
  }
}

function generateSource({ pools, amountIn, minOut }: SolswapConfig): string {
  const lines: string[] = ["function main() {"];

  pools.forEach((pool, i) => {
    // amountIn * (10000 - feeBps) is folded off-chain (both are compile-time
    // constants), so the in-VM quote is one mulDiv over the live reserves.
    const amountInWithFee = amountIn * (10000n - pool.feeBps);
    const ref = JSON.stringify(pool.ref);
    lines.push(
      `  const rIn${i} = abi.decode(accountData(${ref}, ${pool.reserveInOffset}, 32), "uint256");`,
      `  const rOut${i} = abi.decode(accountData(${ref}, ${pool.reserveOutOffset}, 32), "uint256");`,
      `  const quote${i} = Math.mulDiv(${amountInWithFee}, rOut${i}[0], rIn${i}[0] * 10000 + ${amountInWithFee});`,
    );
  });

  // Zero-length reads intern each venue program account into the plan: the
  // engine resolves a CALL target by scanning the attached user accounts for
  // the program's pubkey, so the account must ride along even though the CALL
  // references the program by id, not by index.
  for (const programRef of new Set(pools.map((pool) => pool.swap.programRef))) {
    lines.push(`  accountData(${JSON.stringify(programRef)}, 0, 0);`);
  }

  // Strictly-greater scan: on an exact quote tie the earliest-listed pool
  // keeps the win, so pool order encodes venue preference.
  lines.push("  let bestOut = quote0;", "  let bestIndex = 0;");
  for (let i = 1; i < pools.length; i++) {
    lines.push(`  if (quote${i} > bestOut) { bestOut = quote${i}; bestIndex = ${i} }`);
  }

  // Pre-flight bound (inclusive: bestOut == minOut passes): revert BEFORE the
  // CPI — once invoke() launches, a callee failure aborts the whole
  // transaction (CATCH cannot intercept it).
  lines.push(`  if (bestOut < ${minOut}) { throw "minOut" }`);

  pools.forEach((pool, i) => {
    const calldata = Array.from(pool.swap.calldata).join(", ");
    const accounts = pool.swap.accounts.map(accountEntry).join(", ");
    lines.push(
      `  if (bestIndex === ${i}) { contract.call(${hexLiteral(pool.swap.programId)}, Uint8Array.from([${calldata}]), [${accounts}]) }`,
    );
  });

  lines.push("  return bestOut;", "}");
  return lines.join("\n");
}

/**
 * Generate and compile the quote-and-swap program for `config.pools`
 * (unrolled per pool, 2..8 pools). Pure and off-line: no RPC — callers
 * resolve the plan and send via `@eco-incorp/sauce-sdk`'s /svm module.
 */
export function solswap(config: SolswapConfig): SolswapOutput {
  validate(config);

  const source = generateSource(config);
  const { bytecode, warnings, accountPlan } = compile(source, { target: "svm" });
  if (!accountPlan) throw new Error("svm compile produced no account plan");

  // Stamp each venue program meta with its pubkey so resolveAccounts binds it
  // without a resolution entry — the address is already fixed by the baked
  // CALL target, so making the caller re-supply it would just invite a
  // mismatched-ref pre-flight failure.
  const codec = getAddressCodec();
  const venuePubkeys = new Map<string, string>();
  for (const pool of config.pools) venuePubkeys.set(pool.swap.programRef, codec.decode(pool.swap.programId));
  const metas = accountPlan.metas.map((meta) => {
    const pubkey = venuePubkeys.get(meta.ref);
    return pubkey === undefined ? meta : { ...meta, pubkey };
  });

  return { source, bytecode: bytecode[0], accountPlan: { ...accountPlan, metas }, warnings };
}
