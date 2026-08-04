import { ata, computeScaleQuote, CONFIG_SEED, CURVE_CONSTANT_PRODUCT, detectTokenProgram, pda, pubkeyAt, readFeeBeneficiaries, readUintLE, SCALE_AMM_PROGRAM_ID } from '../scale-common.js';
const SLUG = 'scale-amm';
const POOL_SIZE = 326;
const POOL_DISCRIMINATOR = Uint8Array.of(241, 154, 109, 4, 17, 177, 109, 188);
const CONFIG_DISCRIMINATOR = Uint8Array.of(160, 78, 128, 0, 248, 83, 230, 160);
const OFFSETS = {
    enabled: 8,
    owner: 9,
    mintA: 41,
    mintB: 73,
    reservesA: 105,
    reservesB: 121,
    shift: 137,
    curve: 153,
    feeBeneficiaryCount: 154,
    feeBeneficiaries: 155,
};
const CONFIG_OFFSETS = { feeBeneficiary: 40, platformFeeBps: 104 };
const CONFIG_MIN_SIZE = 107;
function hasDiscriminator(data, disc) {
    return data.length >= 8 && disc.every((byte, i) => data[i] === byte);
}
async function loadRequired(load, addr, label) {
    const data = await load(addr);
    if (data === null)
        throw new Error(`${SLUG}: ${label} ${addr} not found`);
    return data;
}
function stateOf(cfg) {
    return {
        reservesA: cfg.reservesA,
        reservesB: cfg.reservesB,
        shift: cfg.shift,
        platformFeeBps: cfg.platformFeeBps,
        shareBps: cfg.feeBeneficiaries.map((b) => BigInt(b.shareBps)),
    };
}
function amm(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
export const scaleAmm = {
    slug: SLUG,
    kind: 'constant-product',
    programId: SCALE_AMM_PROGRAM_ID,
    async fetchPoolConfig(load, pool) {
        const data = await loadRequired(load, pool, 'pool');
        if (data.length !== POOL_SIZE) {
            throw new Error(`${SLUG} pool ${pool} data is ${data.length} bytes, expected ${POOL_SIZE}`);
        }
        if (!hasDiscriminator(data, POOL_DISCRIMINATOR)) {
            throw new Error(`${SLUG} pool ${pool} has a wrong discriminator (not a Pool account)`);
        }
        const enabled = data[OFFSETS.enabled] !== 0;
        if (!enabled)
            throw new Error(`${SLUG} pool ${pool} is disabled`);
        const curve = data[OFFSETS.curve];
        if (curve !== CURVE_CONSTANT_PRODUCT) {
            throw new Error(`${SLUG} pool ${pool} uses curve type ${curve}, only ConstantProduct (0) is supported`);
        }
        const owner = pubkeyAt(data, OFFSETS.owner);
        const mintA = pubkeyAt(data, OFFSETS.mintA);
        const mintB = pubkeyAt(data, OFFSETS.mintB);
        const reservesA = readUintLE(data, OFFSETS.reservesA, 16);
        const reservesB = readUintLE(data, OFFSETS.reservesB, 16);
        const shift = readUintLE(data, OFFSETS.shift, 16);
        const feeBeneficiaryCount = data[OFFSETS.feeBeneficiaryCount];
        const feeBeneficiaries = readFeeBeneficiaries(data, OFFSETS.feeBeneficiaries);
        const configPda = await pda([CONFIG_SEED], SCALE_AMM_PROGRAM_ID);
        const configData = await loadRequired(load, configPda, 'platform config');
        if (configData.length < CONFIG_MIN_SIZE || !hasDiscriminator(configData, CONFIG_DISCRIMINATOR)) {
            throw new Error(`${SLUG} platform config ${configPda} has a wrong discriminator or size`);
        }
        const feeBeneficiaryWallet = pubkeyAt(configData, CONFIG_OFFSETS.feeBeneficiary);
        const platformFeeBps = readUintLE(configData, CONFIG_OFFSETS.platformFeeBps, 2);
        const [mintAData, mintBData] = await Promise.all([loadRequired(load, mintA, 'mint_a'), loadRequired(load, mintB, 'mint_b')]);
        const tokenProgramA = detectTokenProgram(mintA, mintAData);
        const tokenProgramB = detectTokenProgram(mintB, mintBData);
        const [vaultA, vaultB, platformFeeTaA] = await Promise.all([
            pda([pool, mintA], SCALE_AMM_PROGRAM_ID),
            pda([pool, mintB], SCALE_AMM_PROGRAM_ID),
            ata(feeBeneficiaryWallet, mintA, tokenProgramA),
        ]);
        const beneficiaryAtas = await Promise.all(feeBeneficiaries.slice(0, feeBeneficiaryCount).map((b) => ata(b.wallet, mintA, tokenProgramA)));
        return {
            venue: SLUG,
            pool,
            owner,
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
            direction: 'aToB',
        };
    },
    referenceQuote(base, state, amountIn) {
        const cfg = amm(base);
        return computeScaleQuote(stateOf(cfg), amountIn, cfg.direction);
    },
};
//# sourceMappingURL=index.js.map