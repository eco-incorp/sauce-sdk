import { ata, BUY_DISCRIMINATOR, computeScaleQuote, CONFIG_SEED, CURVE_CONSTANT_PRODUCT, detectTokenProgram, pda, POOL_SEED, pubkeyAt, readFeeBeneficiaries, readUintLE, SCALE_AMM_PROGRAM_ID, SCALE_VMM_PROGRAM_ID, scaleContinuousFees, scaleDepthReserves, SCALE_CURVE_HELPER_NAME, SCALE_CURVE_HELPER_SOURCE, SELL_DISCRIMINATOR, SYSTEM_PROGRAM, } from '../scale-common.js';
const SLUG = 'scale-vmm';
const PAIR_SIZE = 327;
const PAIR_DISCRIMINATOR = Uint8Array.of(229, 212, 222, 222, 191, 128, 176, 235);
const CONFIG_DISCRIMINATOR = Uint8Array.of(160, 78, 128, 0, 248, 83, 230, 160);
const OFFSETS = {
    enabled: 8,
    graduated: 9,
    mintA: 10,
    mintB: 42,
    reservesA: 74,
    reservesB: 90,
    shift: 106,
    curve: 122,
    feeBeneficiaryCount: 123,
    feeBeneficiaries: 124,
};
const CONFIG_OFFSETS = { feeBeneficiary: 40, platformFeeBps: 104 };
const CONFIG_MIN_SIZE = 115;
function hasDiscriminator(data, disc) {
    return data.length >= 8 && disc.every((byte, i) => data[i] === byte);
}
async function loadRequired(load, addr, label) {
    const data = await load(addr);
    if (data === null)
        throw new Error(`${SLUG}: ${label} ${addr} not found`);
    return data;
}
function vmm(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
export const scaleVmm = {
    slug: SLUG,
    kind: 'constant-product',
    programId: SCALE_VMM_PROGRAM_ID,
    async fetchPoolConfig(load, pair) {
        const data = await loadRequired(load, pair, 'pair');
        if (data.length !== PAIR_SIZE) {
            throw new Error(`${SLUG} pair ${pair} data is ${data.length} bytes, expected ${PAIR_SIZE}`);
        }
        if (!hasDiscriminator(data, PAIR_DISCRIMINATOR)) {
            throw new Error(`${SLUG} pair ${pair} has a wrong discriminator (not a PairState account)`);
        }
        const enabled = data[OFFSETS.enabled] !== 0;
        const graduated = data[OFFSETS.graduated] !== 0;
        if (!enabled || graduated) {
            throw new Error(`${SLUG} pair ${pair} is ${graduated ? 'graduated' : 'disabled'} (liquidity has migrated off this account)`);
        }
        const curve = data[OFFSETS.curve];
        if (curve !== CURVE_CONSTANT_PRODUCT) {
            throw new Error(`${SLUG} pair ${pair} uses curve type ${curve}, only ConstantProduct (0) is supported`);
        }
        const mintA = pubkeyAt(data, OFFSETS.mintA);
        const mintB = pubkeyAt(data, OFFSETS.mintB);
        const reservesA = readUintLE(data, OFFSETS.reservesA, 16);
        const reservesB = readUintLE(data, OFFSETS.reservesB, 16);
        const shift = readUintLE(data, OFFSETS.shift, 16);
        const feeBeneficiaryCount = data[OFFSETS.feeBeneficiaryCount];
        const feeBeneficiaries = readFeeBeneficiaries(data, OFFSETS.feeBeneficiaries);
        const configPda = await pda([CONFIG_SEED], SCALE_VMM_PROGRAM_ID);
        const configData = await loadRequired(load, configPda, 'platform config');
        if (configData.length < CONFIG_MIN_SIZE || !hasDiscriminator(configData, CONFIG_DISCRIMINATOR)) {
            throw new Error(`${SLUG} platform config ${configPda} has a wrong discriminator or size`);
        }
        const feeBeneficiaryWallet = pubkeyAt(configData, CONFIG_OFFSETS.feeBeneficiary);
        const platformFeeBps = readUintLE(configData, CONFIG_OFFSETS.platformFeeBps, 2);
        const [mintAData, mintBData] = await Promise.all([loadRequired(load, mintA, 'mint_a'), loadRequired(load, mintB, 'mint_b')]);
        const tokenProgramA = detectTokenProgram(mintA, mintAData);
        const tokenProgramB = detectTokenProgram(mintB, mintBData);
        const [vaultA, vaultB, platformFeeTaA, ammPool] = await Promise.all([
            pda([pair, mintA], SCALE_VMM_PROGRAM_ID),
            pda([pair, mintB], SCALE_VMM_PROGRAM_ID),
            ata(feeBeneficiaryWallet, mintA, tokenProgramA),
            pda([POOL_SEED, pair, mintA, mintB], SCALE_AMM_PROGRAM_ID),
        ]);
        const [ammVaultA, ammVaultB, ammConfig] = await Promise.all([
            pda([ammPool, mintA], SCALE_AMM_PROGRAM_ID),
            pda([ammPool, mintB], SCALE_AMM_PROGRAM_ID),
            pda([CONFIG_SEED], SCALE_AMM_PROGRAM_ID),
        ]);
        const beneficiaryAtas = await Promise.all(feeBeneficiaries.slice(0, feeBeneficiaryCount).map((b) => ata(b.wallet, mintA, tokenProgramA)));
        return {
            venue: SLUG,
            pool: pair,
            mintA,
            mintB,
            reservesA,
            reservesB,
            shift,
            feeBeneficiaryCount,
            feeBeneficiaries,
            vaultA,
            vaultB,
            platformConfig: configPda,
            platformFeeBps,
            platformFeeTaA,
            beneficiaryAtas,
            tokenProgramA,
            tokenProgramB,
            ammPool,
            ammVaultA,
            ammVaultB,
            ammConfig,
            direction: 'aToB',
        };
    },
};
const ref = (slot, role) => `s${slot}:${role}`;
function directionOfParam(dirParam) {
    return dirParam === 0n ? 'aToB' : 'bToA';
}
export const scaleVmmLadder = {
    slug: SLUG,
    shapeKey(base) {
        const cfg = vmm(base);
        return `${SLUG}:${cfg.direction}:${cfg.feeBeneficiaryCount}`;
    },
    helpers() {
        return [{ name: SCALE_CURVE_HELPER_NAME, source: SCALE_CURVE_HELPER_SOURCE }];
    },
    paramCount: 1,
    paramsFor(base) {
        const cfg = vmm(base);
        return [cfg.direction === 'bToA' ? 1n : 0n];
    },
    quoteRefs(base, slot) {
        const cfg = vmm(base);
        return [
            { ref: ref(slot, 'pair'), address: cfg.pool },
            { ref: ref(slot, 'cfg'), address: cfg.platformConfig },
        ];
    },
    emitSetup(base, slot, params) {
        const cfg = vmm(base);
        const pair = JSON.stringify(ref(slot, 'pair'));
        const config = JSON.stringify(ref(slot, 'cfg'));
        return [
            `  const s${slot}rA = accountUint(${pair}, ${OFFSETS.reservesA}, 16);`,
            `  const s${slot}rB = accountUint(${pair}, ${OFFSETS.reservesB}, 16);`,
            `  const s${slot}shift = accountUint(${pair}, ${OFFSETS.shift}, 16);`,
            `  const s${slot}pbps = accountUint(${config}, ${CONFIG_OFFSETS.platformFeeBps}, 2);`,
            ...cfg.feeBeneficiaries.map((_, i) => `  const s${slot}s${i} = accountUint(${pair}, ${OFFSETS.feeBeneficiaries + i * 34 + 32}, 2);`),
            `  const s${slot}dir = ${params[0]};`,
        ].join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        return `${SCALE_CURVE_HELPER_NAME}(${x}, s${slot}rA, s${slot}rB, s${slot}shift, s${slot}pbps, s${slot}s0, s${slot}s1, s${slot}s2, s${slot}s3, s${slot}s4, s${slot}dir)`;
    },
    buildSwapV2(base, slot, user) {
        const cfg = vmm(base);
        const sell = cfg.direction === 'bToA';
        const [userTaA, userTaB] = sell ? [user.outAta, user.inAta] : [user.inAta, user.outAta];
        const fixed = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        const accounts = [
            fixed('pair', cfg.pool, true),
            { ref: user.owner, signer: true, writable: true },
            fixed('mintA', cfg.mintA),
            fixed('mintB', cfg.mintB),
            { ref: userTaA, writable: true },
            { ref: userTaB, writable: true },
            fixed('vaultA', cfg.vaultA, true),
            fixed('vaultB', cfg.vaultB, true),
            fixed('feeTaA', cfg.platformFeeTaA, true),
            fixed('tpA', cfg.tokenProgramA),
            fixed('tpB', cfg.tokenProgramB),
            fixed('sys', SYSTEM_PROGRAM),
            fixed('cfg', cfg.platformConfig),
            fixed('ammProgram', SCALE_AMM_PROGRAM_ID),
            fixed('ammPool', cfg.ammPool, true),
            fixed('ammVaultA', cfg.ammVaultA, true),
            fixed('ammVaultB', cfg.ammVaultB, true),
            fixed('ammConfig', cfg.ammConfig),
            ...cfg.beneficiaryAtas.map((addr, i) => fixed(`ben${i}`, addr, true)),
        ];
        return {
            programId: SCALE_VMM_PROGRAM_ID,
            prefix: sell ? SELL_DISCRIMINATOR : BUY_DISCRIMINATOR,
            suffix: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0), // limit = 1 (venue min_out convention)
            patch: 'in',
            accounts,
        };
    },
    referenceQuote(base, state, params) {
        const cfg = vmm(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
            return data;
        };
        const pair = bytes(cfg.pool);
        const config = bytes(cfg.platformConfig);
        const curveState = {
            reservesA: readUintLE(pair, OFFSETS.reservesA, 16),
            reservesB: readUintLE(pair, OFFSETS.reservesB, 16),
            shift: readUintLE(pair, OFFSETS.shift, 16),
            platformFeeBps: readUintLE(config, CONFIG_OFFSETS.platformFeeBps, 2),
            shareBps: cfg.feeBeneficiaries.map((_, i) => readUintLE(pair, OFFSETS.feeBeneficiaries + i * 34 + 32, 2)),
        };
        const direction = directionOfParam(params[0]);
        return (x) => computeScaleQuote(curveState, x, direction);
    },
    depthReserves(base, state) {
        const cfg = vmm(base);
        const pair = state[cfg.pool];
        if (pair === undefined)
            throw new Error(`${SLUG} ladder depth is missing account ${cfg.pool}`);
        const curveState = {
            reservesA: readUintLE(pair, OFFSETS.reservesA, 16),
            reservesB: readUintLE(pair, OFFSETS.reservesB, 16),
            shift: readUintLE(pair, OFFSETS.shift, 16),
            platformFeeBps: 0n,
            shareBps: [],
        };
        return scaleDepthReserves(curveState, cfg.direction);
    },
    continuousFees(base, state, params) {
        const cfg = vmm(base);
        const pair = state[cfg.pool];
        const config = state[cfg.platformConfig];
        if (pair === undefined || config === undefined) {
            throw new Error(`${SLUG} ladder fees are missing account state`);
        }
        const curveState = {
            reservesA: 0n,
            reservesB: 0n,
            shift: 0n,
            platformFeeBps: readUintLE(config, CONFIG_OFFSETS.platformFeeBps, 2),
            shareBps: cfg.feeBeneficiaries.map((_, i) => readUintLE(pair, OFFSETS.feeBeneficiaries + i * 34 + 32, 2)),
        };
        return scaleContinuousFees(curveState, directionOfParam(params[0]));
    },
};
//# sourceMappingURL=index.js.map