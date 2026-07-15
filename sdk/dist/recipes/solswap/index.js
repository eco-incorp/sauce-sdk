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
import { compile, estimatePacket } from "@eco-incorp/sauce-compiler";
import { venueAdapter } from "../../svm/venues/registry.js";
/**
 * Constant-product quote with fee — the exact integer math the generated
 * bytecode runs on-chain, for computing expected outputs off-chain:
 * `out = (amountIn * (10000 - feeBps) * reserveOut) / (reserveIn * 10000 + amountIn * (10000 - feeBps))`.
 */
export function solswapQuote(amountIn, feeBps, reserveIn, reserveOut) {
    const amountInWithFee = amountIn * (10000n - feeBps);
    return (amountInWithFee * reserveOut) / (reserveIn * 10000n + amountInWithFee);
}
function hexLiteral(bytes) {
    return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function accountEntry(account) {
    const flags = [
        ...(account.writable ? ["writable: true"] : []),
        ...(account.signer ? ["signer: true"] : []),
    ];
    if (flags.length === 0)
        return JSON.stringify(account.ref);
    return `{ ref: ${JSON.stringify(account.ref)}, ${flags.join(", ")} }`;
}
function validate({ pools, amountIn, minOut }) {
    if (pools.length < 2 || pools.length > 8) {
        throw new Error(`solswap expects 2 to 8 pools, got ${pools.length}`);
    }
    if (amountIn <= 0n)
        throw new Error(`solswap amountIn must be positive, got ${amountIn}`);
    if (minOut < 0n)
        throw new Error(`solswap minOut must be non-negative, got ${minOut}`);
    const programIds = new Map();
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
function generateSource({ pools, amountIn, minOut }) {
    const lines = ["function main() {"];
    pools.forEach((pool, i) => {
        // amountIn * (10000 - feeBps) is folded off-chain (both are compile-time
        // constants), so the in-VM quote is one mulDiv over the live reserves.
        const amountInWithFee = amountIn * (10000n - pool.feeBps);
        const ref = JSON.stringify(pool.ref);
        lines.push(`  const rIn${i} = abi.decode(accountData(${ref}, ${pool.reserveInOffset}, 32), "uint256");`, `  const rOut${i} = abi.decode(accountData(${ref}, ${pool.reserveOutOffset}, 32), "uint256");`, `  const quote${i} = Math.mulDiv(${amountInWithFee}, rOut${i}[0], rIn${i}[0] * 10000 + ${amountInWithFee});`);
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
        lines.push(`  if (bestIndex === ${i}) { contract.call(${hexLiteral(pool.swap.programId)}, Uint8Array.from([${calldata}]), [${accounts}]) }`);
    });
    lines.push("  return bestOut;", "}");
    return lines.join("\n");
}
/**
 * Generate and compile the quote-and-swap program for `config.pools`
 * (unrolled per pool, 2..8 pools). Pure and off-line: no RPC — callers
 * resolve the plan and send via `@eco-incorp/sauce-sdk`'s /svm module.
 */
export function solswap(config) {
    validate(config);
    const source = generateSource(config);
    const { bytecode, warnings, accountPlan } = compile(source, { target: "svm" });
    if (!accountPlan)
        throw new Error("svm compile produced no account plan");
    // Stamp each venue program meta with its pubkey so resolveAccounts binds it
    // without a resolution entry — the address is already fixed by the baked
    // CALL target, so making the caller re-supply it would just invite a
    // mismatched-ref pre-flight failure.
    const codec = getAddressCodec();
    const venuePubkeys = new Map();
    for (const pool of config.pools)
        venuePubkeys.set(pool.swap.programRef, codec.decode(pool.swap.programId));
    const metas = accountPlan.metas.map((meta) => {
        const pubkey = venuePubkeys.get(meta.ref);
        return pubkey === undefined ? meta : { ...meta, pubkey };
    });
    return { source, bytecode: bytecode[0], accountPlan: { ...accountPlan, metas }, warnings };
}
/**
 * Shared stable-curve Newton helpers, declared ONCE when any stable-kind pool
 * is present. Signatures and semantics are the adapter contract (the saber
 * and meteora-damm-v1-stable fragments call them): ann = amp * 2 computed
 * inside, at most 256 iterations, converged when successive estimates differ
 * by <= 1, floor division throughout — numerically identical to the adapters'
 * TS computeD/computeY mirrors. `break` does not exist on the v12 target, so
 * convergence rides in the loop condition: `diff` starts at the sentinel 2
 * (> 1, guaranteeing the first iteration) and each pass recomputes it, exactly
 * reproducing the mirrors' iterate-then-break sequence. Math.mulDiv (512-bit
 * intermediate) carries the d^3-scale Newton products; the remaining plain
 * products stay far below the 256-bit wrap for the documented per-venue
 * bounds (u64 reserves, D of multiplier-upscaled stable pairs < 2^100).
 */
export const SOLSWAP_STABLE_HELPERS = [
    "function stableD(amp, xa, xb) {",
    "  const s = xa + xb;",
    "  if (s === 0) { return 0 }",
    "  const ann = amp * 2;",
    "  let d = s;",
    "  let diff = 2;",
    "  for (let r = 0; r < 256 && diff > 1; r++) {",
    "    let dp = Math.mulDiv(d, d, xa * 2);",
    "    dp = Math.mulDiv(dp, d, xb * 2);",
    "    const prev = d;",
    "    d = Math.mulDiv(d, dp * 2 + s * ann, d * (ann - 1) + dp * 3);",
    "    diff = d - prev;",
    "    if (prev > d) { diff = prev - d }",
    "  }",
    "  return d;",
    "}",
    "function stableY(amp, x, d) {",
    "  const ann = amp * 2;",
    "  const c = Math.mulDiv(Math.mulDiv(d, d, x * 2), d, ann * 2);",
    "  const b = d / ann + x;",
    "  let y = d;",
    "  let diff = 2;",
    "  for (let r = 0; r < 256 && diff > 1; r++) {",
    "    const prev = y;",
    "    y = (y * y + c) / (2 * y + b - d);",
    "    diff = y - prev;",
    "    if (prev > y) { diff = prev - y }",
    "  }",
    "  return y;",
    "}",
].join("\n");
function validateBest({ pools, amountIn, minOut, user }) {
    if (pools.length < 2 || pools.length > 8) {
        throw new Error(`solswapBest expects 2 to 8 pools, got ${pools.length}`);
    }
    if (amountIn <= 0n)
        throw new Error(`solswapBest amountIn must be positive, got ${amountIn}`);
    if (minOut < 0n)
        throw new Error(`solswapBest minOut must be non-negative, got ${minOut}`);
    for (const key of ["outAta", "inAta", "owner"]) {
        if (user[key].length === 0)
            throw new Error(`solswapBest user.${key} ref must not be empty`);
    }
    for (const entry of pools) {
        if (!("external" in entry))
            continue;
        const { label, quotedOut, swap } = entry.external;
        if (label.length === 0)
            throw new Error("solswapBest external quote label must not be empty");
        if (quotedOut <= 0n) {
            throw new Error(`solswapBest external quote '${label}' quotedOut must be positive, got ${quotedOut}`);
        }
        if (swap.accounts.length === 0) {
            throw new Error(`solswapBest external quote '${label}' swap.accounts must not be empty`);
        }
    }
}
/** Records ref → address; a ref claiming two different addresses is a config error. */
function bindAddress(addressByRef, ref, address) {
    if (address === undefined)
        return;
    const bound = addressByRef.get(ref);
    if (bound !== undefined && bound !== address) {
        throw new Error(`solswapBest account ref '${ref}' is bound to two different addresses (${bound}, ${address})`);
    }
    addressByRef.set(ref, address);
}
function generateBestSource(entries, { minOut, user }) {
    const lines = [];
    if (entries.some((entry) => entry.stable))
        lines.push(SOLSWAP_STABLE_HELPERS);
    lines.push("function main() {");
    for (const entry of entries)
        lines.push(entry.fragment);
    // Zero-length reads intern each winner-candidate program account: the
    // engine resolves a CALL target by scanning the attached user accounts for
    // the program's pubkey, so the account must ride along even though the CALL
    // references the program by id, not by index.
    for (const programId of new Set(entries.map((entry) => entry.swap.programId))) {
        lines.push(`  accountData(${JSON.stringify(programId)}, 0, 0);`);
    }
    // Strictly-greater scan: on an exact quote tie the earliest-listed pool
    // keeps the win, so pool order encodes venue preference.
    lines.push("  let bestOut = q0;", "  let bestIndex = 0;");
    for (let i = 1; i < entries.length; i++) {
        lines.push(`  if (q${i} > bestOut) { bestOut = q${i}; bestIndex = ${i} }`);
    }
    // Pre-flight bound (inclusive) BEFORE the dispatch: once invoke() launches,
    // a callee failure aborts the whole transaction (CATCH cannot intercept it).
    lines.push(`  if (bestOut < ${minOut}) { throw "minOut" }`);
    // outAta balance before the CPI — the baseline of the post-swap delta check.
    const outAta = JSON.stringify(user.outAta);
    lines.push(`  const before = accountUint(${outAta}, 64, 8);`);
    const codec = getAddressCodec();
    entries.forEach((entry, i) => {
        const target = hexLiteral(new Uint8Array(codec.encode(entry.swap.programId)));
        const data = Array.from(entry.swap.data).join(", ");
        const accounts = entry.swap.accounts.map(accountEntry).join(", ");
        lines.push(`  if (bestIndex === ${i}) { contract.call(${target}, Uint8Array.from([${data}]), [${accounts}]) }`);
    });
    // Post-swap verification: the realized outAta delta must clear minOut.
    // Venue-level min_out is 1 everywhere, so this single check enforces the
    // real bound for live venues AND catches stale external quotes.
    lines.push(`  const after = accountUint(${outAta}, 64, 8);`, "  const realized = after - before;", `  if (realized < ${minOut}) { throw "out" }`, "  return realized;", "}");
    return lines.join("\n");
}
/**
 * Multi-venue best-quote solswap: quote every candidate pool in-VM through
 * its venue adapter (or as a baked external constant), pick the strictly
 * best, enforce minOut before the single winner CPI, and verify the realized
 * outAta delta after it (revert payload "out"). Returns the realized delta,
 * not the predicted quote. Async and read-only against `load` — nothing is
 * sent; callers resolve the plan and send via `@eco-incorp/sauce-sdk`'s /svm
 * module.
 */
export async function solswapBest(config) {
    validateBest(config);
    const { amountIn, user, load } = config;
    // Reference quotes evaluate against the same loader state the fragments
    // will read on-chain; time-dependent venues (amp ramps, locked-profit
    // decay) evaluate at the current wall clock.
    const now = BigInt(Math.floor(Date.now() / 1000));
    const addressByRef = new Map();
    const entries = [];
    for (const [i, entry] of config.pools.entries()) {
        if ("external" in entry) {
            const { label, quotedOut, swap } = entry.external;
            for (const account of swap.accounts)
                bindAddress(addressByRef, account.ref, account.address);
            entries.push({ label, fragment: `  const q${i} = ${quotedOut};`, swap, reference: quotedOut, stable: false });
            continue;
        }
        const adapter = venueAdapter(entry.venue);
        const cfg = await adapter.fetchPoolConfig(load, entry.pool);
        const state = {};
        for (const account of adapter.quoteAccounts(cfg)) {
            bindAddress(addressByRef, account.ref, account.address);
            if (account.address === undefined || state[account.address] !== undefined)
                continue;
            const data = await load(account.address);
            if (data === null)
                throw new Error(`solswapBest quote account ${account.address} of pool ${entry.pool} not found`);
            state[account.address] = data;
        }
        const swap = adapter.buildSwap(cfg, user, amountIn);
        for (const account of swap.accounts)
            bindAddress(addressByRef, account.ref, account.address);
        entries.push({
            label: entry.pool,
            fragment: adapter.emitQuote(cfg, i, amountIn),
            swap,
            reference: adapter.referenceQuote(cfg, state, amountIn, now),
            stable: adapter.kind === "stable",
        });
    }
    // Winner-candidate program accounts ride along under their own address as
    // the ref (see generateBestSource's zero-length reads).
    for (const { swap } of entries)
        bindAddress(addressByRef, swap.programId, swap.programId);
    const source = generateBestSource(entries, config);
    const { bytecode, warnings: compileWarnings, accountPlan } = compile(source, { target: "svm" });
    if (!accountPlan)
        throw new Error("svm compile produced no account plan");
    // Stamp every venue-resolved ref with its address so resolveAccounts binds
    // it without a resolution entry — callers resolve only their own refs
    // (outAta/inAta/owner plus any caller-side ref a venue swap declares).
    const metas = accountPlan.metas.map((meta) => {
        const pubkey = addressByRef.get(meta.ref);
        return pubkey === undefined ? meta : { ...meta, pubkey };
    });
    const plan = { ...accountPlan, metas };
    // Budget surfacing: the packet estimate (fee payer + engine accounts + this
    // plan, execute as the only instruction) rides on the result warnings. The
    // compiler folds the same estimate into its own warnings, so merge without
    // duplicating; overflow means the send needs an address lookup table (see
    // README.md, "Packet budget and the ALT path").
    const budget = estimatePacket(plan, bytecode[0].length);
    const warnings = [...compileWarnings];
    for (const warning of budget.warnings) {
        if (!warnings.includes(warning))
            warnings.push(warning);
    }
    return {
        source,
        bytecode: bytecode[0],
        accountPlan: plan,
        warnings,
        quotes: entries.map(({ label, reference }) => ({ pool: label, reference })),
    };
}
//# sourceMappingURL=index.js.map