import { TOKEN_SWAP_V1_PROGRAM_ID, DEXLAB_PROGRAM_ID, SAROS_PROGRAM_ID, ORCA_V1_PROGRAM_ID, PENGUIN_PROGRAM_ID, STEPN_PROGRAM_ID } from './index.js';
const VAULT_AMOUNT_OFFSET = 64;
function readUintLE(data, offset, width) {
    let value = 0n;
    for (let i = width - 1; i >= 0; i--)
        value = (value << 8n) | BigInt(data[offset + i]);
    return value;
}
function forkConfig(slug, base) {
    if (base.venue !== slug)
        throw new Error(`${slug} ladder adapter got a '${base.venue}' pool config`);
    return base;
}
const ref = (slug, slot, role) => `${slug}:s${slot}:${role}`;
/**
 * One ladder per deployed spl-token-swap fork — SAME quote math/CPI shape as
 * orca-legacy-token-swap's ladder (see ./index.ts), parameterized by the
 * fork's own program id.
 */
export function makeSplTokenSwapForkLadder(slug, programId) {
    return {
        slug,
        shapeKey() {
            return `${slug}:AtoB`;
        },
        // fees.rs calculate_fee (floor, min 1 when rate and amount are nonzero) on
        // both fee legs, then the ceiling-divided constant-product curve rounding
        // against the trader — identical to orca-legacy-token-swap's qOrca (see
        // that ladder's header for why there is no early "would underflow"
        // return: the ceil-division is well-defined and monotone for any x once
        // rin > 0 && rout > 0).
        helpers() {
            return [
                {
                    name: 'qSplTokenSwapFork',
                    source: [
                        'function qSplTokenSwapFork(x, rin, rout, tn, td, on, od) {',
                        '  if (x === 0) { return 0 }',
                        '  if (rin === 0 || rout === 0) { return 0 }',
                        '  let tf = 0;',
                        '  if (tn > 0) { tf = x * tn / td; if (tf === 0) { tf = 1 } }',
                        '  let of = 0;',
                        '  if (on > 0) { of = x * on / od; if (of === 0) { of = 1 } }',
                        '  if (tf + of >= x) { return 0 }',
                        '  const net = x - tf - of;',
                        '  const ni = rin + net;',
                        '  const no = (rin * rout + ni - 1) / ni;',
                        '  if (no >= rout) { return 0 }',
                        '  return rout - no;',
                        '}',
                    ].join('\n'),
                },
            ];
        },
        /** Four params: trade fee numerator/denominator, owner fee numerator/denominator. */
        paramCount: 4,
        paramsFor(base) {
            const cfg = forkConfig(slug, base);
            return [cfg.tradeFeeNumerator, cfg.tradeFeeDenominator, cfg.ownerTradeFeeNumerator, cfg.ownerTradeFeeDenominator];
        },
        quoteRefs(base, slot) {
            const cfg = forkConfig(slug, base);
            return [
                { ref: ref(slug, slot, 'vin'), address: cfg.vaultIn },
                { ref: ref(slug, slot, 'vout'), address: cfg.vaultOut },
            ];
        },
        emitSetup(_base, slot, params) {
            return [
                `  const s${slot}rin = accountUint(${JSON.stringify(ref(slug, slot, 'vin'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
                `  const s${slot}rout = accountUint(${JSON.stringify(ref(slug, slot, 'vout'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
                `  const s${slot}tn = ${params[0]};`,
                `  const s${slot}td = ${params[1]};`,
                `  const s${slot}on = ${params[2]};`,
                `  const s${slot}od = ${params[3]};`,
            ].join('\n');
        },
        emitQuoteCall(_base, slot, x) {
            return `qSplTokenSwapFork(${x}, s${slot}rin, s${slot}rout, s${slot}tn, s${slot}td, s${slot}on, s${slot}od)`;
        },
        buildSwapV2(base, slot, user) {
            const cfg = forkConfig(slug, base);
            const roled = (role, addr, writable) => writable ? { ref: ref(slug, slot, role), address: addr, writable: true } : { ref: ref(slug, slot, role), address: addr };
            return {
                programId,
                // SwapInstruction::Swap: [tag=1] ++ amount_in u64 LE (patched) ++
                // minimum_amount_out u64 LE = 1.
                prefix: Uint8Array.from([1]),
                suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
                patch: 'in',
                // instruction.rs Swap account list 0-9; the optional host fee account
                // (10) is omitted.
                accounts: [
                    roled('pool', cfg.pool),
                    roled('auth', cfg.swapAuthority),
                    { ref: user.owner, signer: true },
                    { ref: user.inAta, writable: true },
                    roled('vin', cfg.vaultIn, true),
                    roled('vout', cfg.vaultOut, true),
                    { ref: user.outAta, writable: true },
                    roled('pmint', cfg.poolMint, true),
                    roled('pfee', cfg.poolFeeAccount, true),
                    roled('tp', cfg.tokenProgram),
                ],
            };
        },
        referenceQuote(base, state, params) {
            const cfg = forkConfig(slug, base);
            const bytes = (addr) => {
                const data = state[addr];
                if (data === undefined)
                    throw new Error(`${slug} ladder reference is missing account ${addr}`);
                return data;
            };
            const rin = readUintLE(bytes(cfg.vaultIn), VAULT_AMOUNT_OFFSET, 8);
            const rout = readUintLE(bytes(cfg.vaultOut), VAULT_AMOUNT_OFFSET, 8);
            const [tn, td, on, od] = params;
            return (x) => {
                if (x === 0n)
                    return 0n;
                if (rin === 0n || rout === 0n)
                    return 0n;
                let tf = 0n;
                if (tn > 0n) {
                    tf = (x * tn) / td;
                    if (tf === 0n)
                        tf = 1n;
                }
                let of = 0n;
                if (on > 0n) {
                    of = (x * on) / od;
                    if (of === 0n)
                        of = 1n;
                }
                if (tf + of >= x)
                    return 0n;
                const net = x - tf - of;
                const ni = rin + net;
                const no = (rin * rout + ni - 1n) / ni;
                if (no >= rout)
                    return 0n;
                return rout - no;
            };
        },
        depthReserves(base, state) {
            const cfg = forkConfig(slug, base);
            const bytes = (addr) => {
                const data = state[addr];
                if (data === undefined)
                    throw new Error(`${slug} ladder depth is missing account ${addr}`);
                return data;
            };
            return {
                reserveIn: readUintLE(bytes(cfg.vaultIn), VAULT_AMOUNT_OFFSET, 8),
                reserveOut: readUintLE(bytes(cfg.vaultOut), VAULT_AMOUNT_OFFSET, 8),
            };
        },
        continuousFees(_base, _state, params) {
            const [tn, td, on, od] = params;
            let gamma = 1000000n;
            if (tn > 0n)
                gamma -= (tn * 1000000n) / td;
            if (on > 0n)
                gamma -= (on * 1000000n) / od;
            return { gammaPpm: gamma, muPpm: 1000000n };
        },
    };
}
export const tokenSwapV1Ladder = makeSplTokenSwapForkLadder('token-swap-v1', TOKEN_SWAP_V1_PROGRAM_ID);
export const dexlabLadder = makeSplTokenSwapForkLadder('dexlab', DEXLAB_PROGRAM_ID);
export const sarosLadder = makeSplTokenSwapForkLadder('saros', SAROS_PROGRAM_ID);
export const orcaV1Ladder = makeSplTokenSwapForkLadder('orca-v1', ORCA_V1_PROGRAM_ID);
export const penguinLadder = makeSplTokenSwapForkLadder('penguin', PENGUIN_PROGRAM_ID);
export const stepnLadder = makeSplTokenSwapForkLadder('stepn', STEPN_PROGRAM_ID);
//# sourceMappingURL=ladder.js.map