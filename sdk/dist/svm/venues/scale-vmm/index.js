import { ata, CONFIG_SEED, CURVE_CONSTANT_PRODUCT, detectTokenProgram, pda, POOL_SEED, pubkeyAt, readFeeBeneficiaries, readUintLE, SCALE_AMM_PROGRAM_ID, SCALE_VMM_PROGRAM_ID } from '../scale-common.js';
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
//# sourceMappingURL=index.js.map