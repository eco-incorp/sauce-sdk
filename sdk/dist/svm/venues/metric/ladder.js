/**
 * Metric adapter v2 (SvmRoute ladder fragment) — the amount-parametric sibling of ./index.ts's
 * buildSwap. See index.ts's module doc for the account/instruction layout and the full oracle-CPI
 * price mechanism; this file is the emitted-fragment side of that mechanism.
 *
 * THE ONE THING THIS FRAGMENT DOES THAT NO OTHER LADDER IN THIS TREE DOES: it issues a REAL CPI
 * (`contract.call`) inside `emitSetup`, not just an `accountUint` byte read. Every other oracle-
 * priced ladder (zerofi, obric-v2) decodes its price from plain account BYTES; Metric's oracle
 * exposes its price only through CALL return data (its own internal transform is closed and
 * unrecovered — see index.ts's module doc), so the fragment must actually invoke the oracle
 * program the same way `ecoswap/svm/codegen.ts`'s native-merge emission already does (intern the
 * target program's account with a zero-length `accountData` read so it rides the transaction's
 * account list, then `contract.call(targetPubkeyLiteral, calldata, accounts[])`, then decode the
 * returned `Bytes` descriptor with `.slice()` + `uint()` — the SVM engine's `CALL`/`Static` opcodes
 * push the callee's return data as exactly that descriptor, see
 * `../sauce/svm/programs/engine/src/opcode.rs` (0xA2/0xA3) + `ops/call.rs`'s `get_return_data()`).
 *
 * LIVE-GATES, BAKED-QUOTES: the live CPI result is used ONLY to gate the slot (self-drop on drift
 * beyond `METRIC_DRIFT_TOLERANCE_BPS` from the baked price) — the ACTUAL quote multiply always uses
 * the BAKED (params-carried) scale, never the freshly-read live value. This is what keeps
 * `referenceQuote` a pure function of `params` (state bytes cannot reproduce the oracle's closed
 * transform — see index.ts's module doc) while the on-chain fragment still pays for a live
 * freshness check. `referenceQuote` therefore assumes the gate passes (baked-at-fetch and
 * live-at-cook coincide, true within one fixture/test snapshot); it cannot reproduce a genuine
 * PRODUCTION drift self-drop, an honest, disclosed limitation of the same shape as
 * `continuousFees`'s "measurement only" caveat elsewhere in this framework — the drift check is a
 * pure availability/staleness safety net, never a fill-quality gate, and `minOut` remains the sole
 * atomic backstop regardless.
 *
 * CAPACITY: flat price, reserve-fraction capped (`liveReserveOut / CAP_DIVISOR`, see index.ts's
 * module doc) — stateless, closed-form; every rung (and the cold final quote) is an INDEPENDENT
 * evaluation via `emitQuoteCall`, mirroring zerofi's own "no warm-start chain needed" shape.
 *
 * ⚠ MEASURED RISK, NOT A HYPOTHETICAL — read before enabling this slot in production: this
 * fragment's CPI is a REAL invoke() of a program this adapter does not control, and unlike every
 * other read in this framework (`accountUint`, a plain byte fetch that cannot fail once the account
 * exists) an invoked callee CAN REVERT. A live standalone probe of this exact instruction
 * (`[0x02, feedByte]` against the ground-truth oracleConfig/priceAccount pair) reproduced BOTH
 * outcomes on the SAME feed within one working session: a clean 32-byte return (3,398 CU, matching
 * this adapter's baked measurement) on one call, and a custom program error `0x14` (2,092 CU — the
 * program was genuinely INVOKED, not rejected pre-flight) on a later call after the price account's
 * own bytes had visibly changed. `contract.call(...).catch()` CANNOT rescue this on the SVM target
 * — the compiler's own `resolveRawCallCatch` documents the engine's CATCH as PRE-FLIGHT-ONLY
 * (unresolvable target/calldata/accounts); "once invoke() launches, a failing callee aborts the
 * whole transaction" (`compiler/src/processor/expression.ts`'s `resolveRawCallCatch` doc, verbatim).
 * CONSEQUENCE: unlike a normal venue-CPI failure (contained to that one slot dropping its
 * contribution — the "one venue's live failure must never kill a cook" invariant this framework
 * otherwise upholds throughout), a Metric oracle revert aborts the ENTIRE transaction — every other
 * engaged venue's fill in the SAME cook, not just Metric's own slot. This is a genuine, wider blast
 * radius than any other family in this tree carries, and it is a PLATFORM property (SVM CPI
 * semantics), not a bug in this adapter — there is no in-VM mitigation available. It does not
 * threaten fund safety (an abort moves nothing; `minOut` still backstops any transaction that DOES
 * land), but it is a real liveness/robustness regression worth a maintainer decision before this
 * family serves alongside other venues in shared production traffic, not something to route around
 * silently in this file.
 */
import { getAddressCodec } from '@solana/kit';
import { readUintLE } from '../math.js';
import { CAP_DIVISOR, METRIC_DRIFT_TOLERANCE_BPS, METRIC_ORACLE_PROGRAM_ID, METRIC_PROGRAM_ID, METRIC_SWAP_DISCRIMINATOR, metricSwapAccounts, } from './index.js';
const SLUG = 'metric';
/** SPL token account `amount` byte offset. */
const AMOUNT_OFFSET = 64;
function metricConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
const addressCodec = getAddressCodec();
/** 32-byte pubkey -> a big hex integer literal, the SauceScript-literal encoding for a fixed CALL target. */
function pubkeyHexLiteral(addr) {
    const bytes = addressCodec.encode(addr);
    let hex = '0x';
    for (const b of bytes)
        hex += b.toString(16).padStart(2, '0');
    return hex;
}
export const metricLadder = {
    slug: SLUG,
    defaultRungs: 4,
    shapeKey(base) {
        const c = metricConfig(base);
        return `${SLUG}:${c.direction}`;
    },
    helpers() {
        return [
            {
                name: 'qMetric',
                source: ['function qMetric(x, sn, sd, cap) {', '  let g = (x * sn) / sd;', '  if (g > cap) { g = cap }', '  return g;', '}'].join('\n'),
            },
        ];
    },
    /** [scaleNum, scaleDen, bakedPrice] — baked in fetchPoolConfig (index.ts) from the oracle CPI. */
    paramCount: 3,
    paramsFor(base) {
        const c = metricConfig(base);
        return [c.scaleNum, c.scaleDen, c.bakedPrice];
    },
    quoteRefs(base, slot) {
        const c = metricConfig(base);
        const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
        return [
            { ref: ref(slot, 'oracleProg'), address: METRIC_ORACLE_PROGRAM_ID },
            { ref: ref(slot, 'oracleConfig'), address: c.oracleConfig },
            { ref: ref(slot, 'price'), address: c.priceAccount },
            { ref: ref(slot, 'vout'), address: vaultOut },
        ];
    },
    emitSetup(base, slot, params, enableVar) {
        const c = metricConfig(base);
        const p = `s${slot}`;
        const oracleProg = JSON.stringify(ref(slot, 'oracleProg'));
        const oracleConfig = JSON.stringify(ref(slot, 'oracleConfig'));
        const priceAcc = JSON.stringify(ref(slot, 'price'));
        const vout = JSON.stringify(ref(slot, 'vout'));
        const [scaleNum, scaleDen, bakedPrice] = params;
        // bid halves the return data [0,16); ask halves [16,32) — direction 0 (mintA->mintB) gates on
        // the bid it was baked from, direction 1 (mintB->mintA) gates on the ask (see index.ts's
        // fetchPoolConfig: bakedPrice IS whichever half this direction baked its scale from).
        const liveOffset = c.direction === 0 ? 0 : 16;
        const target = pubkeyHexLiteral(METRIC_ORACLE_PROGRAM_ID);
        const gateBlock = [
            `    accountData(${oracleProg}, 0, 0);`,
            `    const ${p}calldata = Uint8Array.from([2, 0]);`,
            `    const ${p}or = contract.call(${target}, ${p}calldata, [${oracleConfig}, ${priceAcc}]);`,
            `    const ${p}live = uint(${p}or.slice(${liveOffset}, ${liveOffset + 16}));`,
            `    const ${p}diff = ${p}live > ${bakedPrice} ? ${p}live - ${bakedPrice} : ${bakedPrice} - ${p}live;`,
            `    if (${p}diff * 10000 <= ${bakedPrice} * ${METRIC_DRIFT_TOLERANCE_BPS}) {`,
            `      ${p}sn = ${scaleNum};`,
            `      ${p}sd = ${scaleDen};`,
            `    }`,
        ].join('\n');
        const lines = [
            // Unconditional, cheap: the vault read always happens (the account must be
            // readable regardless of enable), sizing the reserve-fraction cap.
            `  const ${p}rout = accountUint(${vout}, ${AMOUNT_OFFSET}, 8);`,
            `  const ${p}cap = ${p}rout / ${CAP_DIVISOR};`,
            // Default a disabled/dropped slot to a zero-output scale (0/1) — no
            // separate "ok" flag needed, unlike zerofi: sn === 0 already forces
            // qMetric(x, 0, 1, cap) === 0 for every x.
            `  let ${p}sn = 0;`,
            `  let ${p}sd = 1;`,
        ];
        if (enableVar !== undefined) {
            lines.push(`  if (${enableVar} !== 0) {`, gateBlock, `  }`);
        }
        else {
            lines.push(gateBlock);
        }
        return lines.join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        const p = `s${slot}`;
        return `qMetric(${x}, ${p}sn, ${p}sd, ${p}cap)`;
    },
    buildSwapV2(base, slot, user) {
        const c = metricConfig(base);
        const make = (r, addr, writable) => writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
        const accounts = metricSwapAccounts(c, user, make, (role) => ref(slot, role));
        return {
            programId: METRIC_PROGRAM_ID,
            // disc(1) ++ [runtime-patched amountIn u64 LE]
            prefix: Uint8Array.from([METRIC_SWAP_DISCRIMINATOR]),
            // [1] ++ direction ++ minOut u128 LE = 1
            suffix: Uint8Array.from([1, c.direction === 0 ? 1 : 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            patch: 'in',
            accounts,
        };
    },
    /**
     * TS mirror. Assumes the on-chain drift gate PASSES (baked-at-fetch == live-at-cook) — the
     * genuine oracle transform cannot be reproduced from `state` bytes at all (see index.ts's module
     * doc); this is a disclosed, narrow divergence from a true on-chain self-drop, never a fill-
     * quality gate (minOut remains the sole atomic backstop).
     */
    referenceQuote(base, state, params) {
        const c = metricConfig(base);
        const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
        const voutData = state[vaultOut];
        if (voutData === undefined)
            throw new Error(`${SLUG} reference is missing vault ${vaultOut}`);
        const [scaleNum, scaleDen] = params;
        const rout = readUintLE(voutData, AMOUNT_OFFSET, 8);
        const cap = rout / CAP_DIVISOR;
        return (x) => {
            if (x === 0n)
                return 0n;
            const g = (x * scaleNum) / scaleDen;
            return g > cap ? cap : g;
        };
    },
    depthReserves(base, state) {
        const c = metricConfig(base);
        const vaultIn = c.direction === 0 ? c.vaultA : c.vaultB;
        const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
        const vinData = state[vaultIn];
        const voutData = state[vaultOut];
        if (vinData === undefined || voutData === undefined) {
            throw new Error(`${SLUG} depth is missing a reserve vault`);
        }
        return {
            reserveIn: readUintLE(vinData, AMOUNT_OFFSET, 8),
            reserveOut: readUintLE(voutData, AMOUNT_OFFSET, 8),
        };
    },
    /**
     * Measurement only. The oracle spread (bid/ask, ~1bp measured — see index.ts's module doc) is
     * already folded into the baked scale, not a separate fee this ladder charges on top — so gamma
     * is the identity and mu is full retention, the same convention obric-v2/zerofi use when their
     * own venue fee is priced INTO the quote rather than deducted afterward.
     */
    continuousFees() {
        return { gammaPpm: 1000000n, muPpm: 1000000n };
    },
};
//# sourceMappingURL=ladder.js.map