/**
 * EcoSwapSVM 2-hop route codegen — the compute-exec-compute-exec solver for a
 * composite A → X → B venue, assembled from the SAME adapter-v2 ladder
 * fragments the single-hop solver uses (codegen.ts) and compiled `{ target:
 * 'svm', staged: true }`. It introduces NO new SauceScript intrinsic, no new
 * adapter contract, no engine change: every leg pool is a slot of an existing
 * family reusing its ladder fragment BYTE-FOR-BYTE, and the only new codegen is
 * a second inlined merge phase plus an intermediate-delta read between the two.
 *
 * THE SVM ATOMICITY ADVANTAGE (why a route is lamport-EXACT, not fold-error
 * bounded): a single instruction can compute → exec → READ REALIZED STATE →
 * compute → exec, because after `invoke()` returns, `accountUint` reads the
 * callee's committed writes. So a route runs, in one atomic instruction:
 *   1. read leg-0 pools live + solve the leg-0 split for `amountIn`;
 *   2. execute ALL leg-0 CPIs (they credit X into the user's intermediate ATA);
 *   3. read the REALIZED intermediate delta on that ATA — `realizedX`;
 *   4. solve the leg-1 split on `realizedX` and the (leg-0-independent) live
 *      leg-1 pool state;
 *   5. execute ALL leg-1 CPIs (credit B into the user's out ATA);
 *   6. terminal: `realizedB >= minOut`.
 * leg-1 solves on GENUINE realized X, not a predicted fold — so there is no
 * fold-error to bound. The platform law is obeyed exactly as single-hop: each
 * leg's ENTIRE split is computed before that leg's first CPI, and a failing CPI
 * (or a `throw`) aborts the whole transaction — atomic, no partial fills.
 *
 * THE EXACTNESS KEYSTONE: the single-hop lamport-exact gate already holds per
 * family (referenceQuote == in-VM predicted == the real venue binary's realized
 * output). So per leg-0 venue predicted == realized, hence `Σ leg-0 predicted
 * == realizedX`; the off-chain oracle (routeReference) builds leg-1's grid on
 * `Σ leg-0 predicted` and gets the IDENTICAL grid the chain builds on
 * `realizedX`. The composed on-chain returndata equals the oracle by
 * construction (absent genuine drift; drift is caught by minOut). This is why
 * intermediate mints are restricted to classic SPL (wSOL/USDC/USDT — no
 * transfer fee) and leg-0 to the exact-quadrilateral families: anything with
 * `predicted != realized` desyncs the two leg-1 grids.
 *
 * DETERMINISM RULE (unchanged from single-hop): per-slot ladder DEPTH and the
 * leg structure are fixed at CODEGEN time by the CU budgeter (budget.ts) — a
 * pure function of (shape, args), never adapted from GasLeft. The leg-1 grid is
 * DATA-driven (`realizedX >> (r-j)` uses runtime realizedX with compile-time
 * shift constants) but rung COUNTS stay fixed, so the mirror (routeReference)
 * reproduces it. GasLeft (0x62) appears exactly once, as the hard `"cu"` throw.
 *
 * The generated merges are transcribed 1:1 by solver-reference.ts
 * (solveReference, called twice by routeReference) — change them together or
 * the lamport-exact gate breaks.
 */
import { getAddressCodec } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { accountEntry, bindAddress, collectHelpers, hexLiteral, LE8_HELPER, progRef, quoteMode, resolveSlotRungs, } from './codegen.js';
/** Structural leg-slot bounds: each leg carries 1..MAX_LEG_SLOTS pools, total 2..MAX_ROUTE_SLOTS. */
export const MAX_LEG_SLOTS = 3;
export const MAX_ROUTE_SLOTS = 4;
/** Default intermediate-ATA ref (leg-0's out ATA and leg-1's in ATA — one deduped, writable, non-signer key). */
export const DEFAULT_INTER_REF = 'user:inter';
/**
 * Emits one leg's ladder + merge + predicted + exec into main()'s body over
 * the FLAT slot range [flatStart, flatEnd). Every merge/exec local is
 * leg-suffixed (`L`) so leg-0 and leg-1 never redeclare in the shared function
 * scope. The "total input" identifier is parameterized: leg-0 passes
 * `amountIn`, leg-1 passes the `realizedX` local — the one generalization of
 * the single-hop emit.
 */
function emitLegBlock(params) {
    const { flats, flatStart, legIx, rungs, rungBase, inputExpr, deltaRef, deltaVar, checkMinOut, codec } = params;
    const L = legIx;
    const flatEnd = flatStart + flats.length;
    const legRungs = rungs.slice(flatStart, flatEnd).reduce((sum, r) => sum + r, 0);
    const lines = [];
    // ── ladders: rungs[flat] rungs per enabled slot on the geometric grid
    //    G_j = inputExpr >> (rungs[flat] − j); a disabled slot is born exhausted. ──
    flats.forEach(({ slot }, i) => {
        const flat = flatStart + i;
        const { adapter, cfg } = slot;
        const mode = quoteMode(adapter);
        const r = rungs[flat];
        const base = rungBase[flat];
        lines.push(`  if (s${flat}en !== 0) {`);
        for (let j = 1; j <= r; j++) {
            const rung = base + (j - 1);
            const g = j === r ? inputExpr : `s${flat}g${j}`;
            if (j < r)
                lines.push(`    const ${g} = ${inputExpr} >> ${r - j};`);
            if (mode === 'expression') {
                lines.push(`    const s${flat}o${j} = ${adapter.emitQuoteCall(cfg, flat, g)};`);
            }
            else {
                lines.push(adapter.emitLadderQuote(cfg, flat, j - 1, g, `s${flat}o${j}`));
            }
            if (j === 1) {
                lines.push(`    din[${rung}] = ${g}; dout[${rung}] = s${flat}o${j};`);
            }
            else {
                lines.push(`    din[${rung}] = ${g} - s${flat}g${j - 1}; dout[${rung}] = s${flat}o${j} - s${flat}o${j - 1};`);
            }
        }
        lines.push('  }');
        lines.push(`  if (s${flat}en === 0) { ptr[${flat}] = ${r} }`);
    });
    // ── merge: greedy cheapest-rung-first over THIS leg's flat slot range;
    //    election by cross-multiplied average price, first-scanned slot keeps
    //    ties. Mirrored 1:1 by solveReference (routeReference calls it per leg). ──
    lines.push(`  let rem${L} = ${inputExpr};`, `  for (let it${L} = 0; it${L} < ${legRungs} && rem${L} > 0; it${L}++) {`, `    let best${L} = ${flatEnd};`, `    for (let sc${L} = ${flatStart}; sc${L} < ${flatEnd}; sc${L}++) {`, `      if (ptr[sc${L}] < rl[sc${L}]) {`, `        if (best${L} === ${flatEnd}) { best${L} = sc${L} }`, `        if (best${L} !== sc${L}) {`, `          const cc${L} = rb[sc${L}] + ptr[sc${L}];`, `          const bb${L} = rb[best${L}] + ptr[best${L}];`, `          if (dout[cc${L}] * din[bb${L}] > dout[bb${L}] * din[cc${L}]) { best${L} = sc${L} }`, '        }', '      }', '    }', `    if (best${L} === ${flatEnd}) { throw "fill" }`, `    const rr${L} = rb[best${L}] + ptr[best${L}];`, `    let tk${L} = din[rr${L}];`, `    if (tk${L} > rem${L}) { tk${L} = rem${L} }`, `    fill[best${L}] += tk${L};`, `    rem${L} -= tk${L};`, `    if (tk${L} === din[rr${L}]) { ptr[best${L}] = ptr[best${L}] + 1 }`, '  }', `  if (rem${L} > 0) { throw "fill" }`);
    // ── predicted outputs (ALWAYS the COLD quote — venue-exact at the elected
    //    slice), then, on leg-1, the pre-CPI minOut bound. ──
    flats.forEach(({ slot }, i) => {
        const flat = flatStart + i;
        const { adapter, cfg } = slot;
        if (quoteMode(adapter) === 'expression') {
            lines.push(`  const p${flat} = ${adapter.emitQuoteCall(cfg, flat, `fill[${flat}]`)};`);
        }
        else {
            lines.push(adapter.emitFinalQuote(cfg, flat, `fill[${flat}]`, `p${flat}`));
        }
    });
    if (checkMinOut) {
        const predictedSum = flats.map((_, i) => `p${flatStart + i}`).join(' + ');
        lines.push(`  const predicted${L} = ${predictedSum};`);
        lines.push(`  if (predicted${L} < minOut) { throw "minOut" }`);
    }
    // ── execution: `before` delta on the leg's realized-output ATA, one patched
    //    CPI per engaged slot, `after` − `before` = the leg's realized output. ──
    const delta = JSON.stringify(deltaRef);
    lines.push(`  const before${L} = accountUint(${delta}, 64, 8);`);
    flats.forEach(({ slot, legUser }, i) => {
        const flat = flatStart + i;
        const { adapter, cfg, swapOverride } = slot;
        const template = swapOverride ?? adapter.buildSwapV2(cfg, flat, legUser);
        const target = hexLiteral(new Uint8Array(codec.encode(template.programId)));
        const patched = template.patch === 'out' ? `p${flat}` : `fill[${flat}]`;
        const accounts = template.accounts.map(accountEntry).join(', ');
        const parts = [`s${flat}pfx`, `s${flat}amt.slice(24, 32)`, ...(template.suffix.length > 0 ? [`s${flat}sfx`] : [])];
        lines.push(`  if (fill[${flat}] > 0 && p${flat} > 0) {`, `    const s${flat}pfx = Uint8Array.from([${Array.from(template.prefix).join(', ')}]);`, ...(template.suffix.length > 0
            ? [`    const s${flat}sfx = Uint8Array.from([${Array.from(template.suffix).join(', ')}]);`]
            : []), `    const s${flat}amt = abi.encode(le8(${patched}));`, `    const s${flat}cd = ${parts[0]}.concat(${parts.slice(1).join(', ')});`, `    contract.call(${target}, s${flat}cd, [${accounts}]);`, '  }');
    });
    lines.push(`  const after${L} = accountUint(${delta}, 64, 8);`, `  const ${deltaVar} = after${L} - before${L};`);
    return lines;
}
function generateRouteSource(input) {
    const { user, cuFloor } = input;
    const interRef = input.interRef ?? DEFAULT_INTER_REF;
    const codec = getAddressCodec();
    const user0 = { inAta: user.inAta, outAta: interRef, owner: user.owner };
    const user1 = { inAta: interRef, outAta: user.outAta, owner: user.owner };
    const flats = [
        ...input.leg0.map((slot) => ({ slot, legUser: user0, leg: 0 })),
        ...input.leg1.map((slot) => ({ slot, legUser: user1, leg: 1 })),
    ];
    const leg0Count = input.leg0.length;
    const k = flats.length;
    const rungs = flats.map(({ slot }) => resolveSlotRungs(slot));
    const rungBase = [];
    let totalRungs = 0;
    for (const r of rungs) {
        rungBase.push(totalRungs);
        totalRungs += r;
    }
    const lines = [LE8_HELPER, ...collectHelpers(flats.map((f) => f.slot))];
    lines.push('function main(cfg) {');
    // ── the GasLeft hard safety throw (never a split input — see header) ──
    if (cuFloor !== undefined) {
        if (!Number.isInteger(cuFloor) || cuFloor <= 0) {
            throw new Error(`ecoSwapSvm route cuFloor must be a positive integer, got ${cuFloor}`);
        }
        lines.push(`  if (gasLeft() < ${cuFloor}) { throw "cu" }`);
    }
    // ── cfg words: [amountIn][minOut] then per FLAT slot [enable][...params] ──
    let word = 0;
    const slice = () => {
        const at = word * 8;
        word += 1;
        return `uint(cfg.slice(${at}, ${at + 8}))`;
    };
    lines.push(`  const amountIn = ${slice()};`);
    lines.push(`  const minOut = ${slice()};`);
    const slotParams = [];
    flats.forEach(({ slot }, i) => {
        lines.push(`  const s${i}en = ${slice()};`);
        const p = [];
        for (let j = 0; j < slot.adapter.paramCount; j++) {
            lines.push(`  const s${i}p${j} = ${slice()};`);
            p.push(`s${i}p${j}`);
        }
        slotParams.push(p);
    });
    const cfgByteLength = word * 8;
    // ── setup: LIVE reserve/fee reads for EVERY slot (both legs). Leg-1 pool
    //    state is unaffected by leg-0 (disjoint pools), so both legs' setup is
    //    hoisted here (a disabled slot still needs readable accounts attached). ──
    flats.forEach(({ slot }, i) => lines.push(slot.adapter.emitSetup(slot.cfg, i, slotParams[i], `s${i}en`)));
    // Intern each slot's CPI target program account (zero-length read).
    for (let i = 0; i < k; i++)
        lines.push(`  accountData(${JSON.stringify(progRef(i))}, 0, 0);`);
    // ── shared ladder/merge arrays over totalRungs (BOTH legs), flat bases ──
    lines.push(`  const din = new Array(${totalRungs});`, `  const dout = new Array(${totalRungs});`, `  const rl = new Array(${k});`, `  const rb = new Array(${k});`, `  const ptr = new Array(${k});`, `  const fill = new Array(${k});`);
    flats.forEach((_, i) => lines.push(`  rl[${i}] = ${rungs[i]}; rb[${i}] = ${rungBase[i]};`));
    // ── LEG 0: input=amountIn, {A → inter}, delta target = inter ──
    lines.push('  // ===== LEG 0 (A -> X) =====');
    lines.push(...emitLegBlock({
        flats: flats.slice(0, leg0Count),
        flatStart: 0,
        legIx: 0,
        rungs,
        rungBase,
        inputExpr: 'amountIn',
        deltaRef: interRef,
        deltaVar: 'realizedX',
        checkMinOut: false,
        codec,
    }));
    lines.push('  if (realizedX === 0) { throw "x" }');
    // ── LEG 1: input=realizedX, {inter → B}, delta target = outAta, minOut ──
    lines.push('  // ===== LEG 1 (X -> B) =====');
    lines.push(...emitLegBlock({
        flats: flats.slice(leg0Count),
        flatStart: leg0Count,
        legIx: 1,
        rungs,
        rungBase,
        inputExpr: 'realizedX',
        deltaRef: user.outAta,
        deltaVar: 'realizedB',
        checkMinOut: true,
        codec,
    }));
    lines.push('  if (realizedB < minOut) { throw "out" }');
    // ── returndata: [fills…][predicted…][realizedX][realizedB] as 32-byte BE words ──
    const returns = [...flats.map((_, i) => `fill[${i}]`), ...flats.map((_, i) => `p${i}`), 'realizedX', 'realizedB'];
    lines.push(`  return abi.encode(${returns.join(', ')});`, '}');
    return { source: lines.join('\n'), cfgByteLength, rungs, flats, leg0Count };
}
/**
 * Shape discriminant for route blob reuse: leg-0 family slots, `>>`, leg-1
 * family slots (each slot rung-count-suffixed when off QL_S, plus any swap
 * override), so `k0` (the leg boundary) is recoverable and pool sets sharing
 * the shape reuse the identical blob.
 */
export function ecoSwapSvmRouteShapeKey(leg0, leg1) {
    const key = (slots) => slots
        .map((slot) => {
        const { adapter, cfg, swapOverride } = slot;
        const rungs = resolveSlotRungs(slot);
        let base = adapter.shapeKey(cfg);
        if (rungs !== 4)
            base += `~r${rungs}`;
        if (swapOverride === undefined)
            return base;
        return `${base}#ov:${swapOverride.patch}:${swapOverride.programId}:${swapOverride.accounts.length}`;
    })
        .join('|');
    return `route:${key(leg0)}>>${key(leg1)}`;
}
const U64_MAX = (1n << 64n) - 1n;
/** Generates and compiles the staged 2-hop route blob for one shape. */
export function generateEcoSwapSvmRoute(input) {
    const { leg0, leg1, user } = input;
    if (leg0.length < 1 || leg0.length > MAX_LEG_SLOTS) {
        throw new Error(`ecoSwapSvm route leg-0 expects 1 to ${MAX_LEG_SLOTS} slots, got ${leg0.length}`);
    }
    if (leg1.length < 1 || leg1.length > MAX_LEG_SLOTS) {
        throw new Error(`ecoSwapSvm route leg-1 expects 1 to ${MAX_LEG_SLOTS} slots, got ${leg1.length}`);
    }
    if (leg0.length + leg1.length > MAX_ROUTE_SLOTS) {
        throw new Error(`ecoSwapSvm route expects at most ${MAX_ROUTE_SLOTS} total slots, got ${leg0.length + leg1.length}`);
    }
    const interRef = input.interRef ?? DEFAULT_INTER_REF;
    for (const [key, value] of [
        ['outAta', user.outAta],
        ['inAta', user.inAta],
        ['owner', user.owner],
        ['interRef', interRef],
    ]) {
        if (value.length === 0)
            throw new Error(`ecoSwapSvm route ${key} ref must not be empty`);
    }
    if (interRef === user.inAta || interRef === user.outAta) {
        throw new Error(`ecoSwapSvm route interRef '${interRef}' must differ from user.inAta and user.outAta`);
    }
    const { source, cfgByteLength, rungs, flats, leg0Count } = generateRouteSource(input);
    const { bytecode, warnings, accountPlan, argsLayout } = compile(source, {
        target: 'svm',
        staged: true,
        args: ['0x' + '00'.repeat(cfgByteLength)],
    });
    if (!accountPlan)
        throw new Error('svm route compile produced no account plan');
    if (!argsLayout)
        throw new Error('staged svm route compile produced no args layout');
    // Stamp adapter-resolved refs with their addresses (each slot's swap built
    // with ITS leg user) so resolveAccounts binds them without resolution
    // entries — callers resolve only outAta/inAta/interRef/owner + swap-override
    // bare refs.
    const addressByRef = new Map();
    flats.forEach(({ slot, legUser }, i) => {
        for (const account of slot.adapter.quoteRefs(slot.cfg, i))
            bindAddress(addressByRef, account.ref, account.address);
        const template = slot.swapOverride ?? slot.adapter.buildSwapV2(slot.cfg, i, legUser);
        for (const account of template.accounts)
            bindAddress(addressByRef, account.ref, account.address);
        bindAddress(addressByRef, progRef(i), template.programId);
    });
    const metas = accountPlan.metas.map((meta) => {
        const pubkey = addressByRef.get(meta.ref);
        return pubkey === undefined ? meta : { ...meta, pubkey };
    });
    return {
        source,
        bytecode: bytecode[0],
        argsLayout: argsLayout,
        accountPlan: { ...accountPlan, metas },
        shapeKey: ecoSwapSvmRouteShapeKey(leg0, leg1),
        rungs,
        cfgByteLength,
        warnings,
        leg0Count,
        leg1Count: flats.length - leg0Count,
    };
}
export { U64_MAX as ROUTE_U64_MAX };
//# sourceMappingURL=route.js.map