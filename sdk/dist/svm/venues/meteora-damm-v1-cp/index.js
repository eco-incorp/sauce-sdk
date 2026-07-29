/**
 * Meteora DAMM v1 (Dynamic AMM, ex-Mercurial) constant-product-curve venue
 * adapter — the sibling of ./meteora-damm-v1-stable for CurveType::ConstantProduct
 * pools (curve_type tag 0). Same program, same Pool/Vault account layouts up
 * to the curve tag; a ConstantProduct pool's content ENDS at offset 875 (no
 * amp / token multiplier / depeg payload — those are Stable-only fields), so
 * POOL_MIN_LENGTH here is 875, not 925.
 *
 * Reserves come from the SAME dynamic-vault share math as the stable sibling
 * (reserve_X = floor(x_vault_lp.amount * vault_x_unlocked(t) / x_lp_mint.supply),
 * locked-profit decay denominator 1e12) and fees carry the identical
 * input-token, minimum-1, protocol-cut-of-trade-fee rule. Only the curve step
 * differs: constant product with a ceiling-divided quote that rounds against
 * the trader — the same spl-token-swap-lineage form as
 * ../orca-legacy-token-swap (dst = rOut - ceil(rIn*rOut / (rIn+netIn))) — in
 * place of the stable sibling's 2-coin Newton stableswap. A vault
 * deposit/withdraw share-math simulation (identical to the stable sibling)
 * still captures 1-2 native units of rounding loss on each side.
 *
 * Quotes exact-in A -> B (token_a -> token_b, the pool's canonical
 * direction), matching the stable sibling's single-direction convention.
 */
import { address, getAddressCodec } from '@solana/kit';
import { readUintLE, ceilDiv } from '../math.js';
const SLUG = 'meteora-damm-v1-cp';
const PROGRAM_ID = address('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
const VAULT_PROGRAM_ID = address('24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi');
const TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// sha256("account:Pool")[..8] / sha256("account:Vault")[..8] — same discriminators
// as the stable sibling (one Pool/Vault account shape, distinguished by the
// curve_type tag byte, not by a different discriminator).
const POOL_DISCRIMINATOR = new Uint8Array([0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc]);
const VAULT_DISCRIMINATOR = new Uint8Array([0xd3, 0x08, 0xe8, 0x2b, 0x02, 0x98, 0x75, 0x77]);
// sha256("global:swap")[..8].
const SWAP_DISCRIMINATOR = new Uint8Array([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]);
// Locked-profit degradation rate denominator (per-second rate / 1e12).
const DEGRADATION_DENOMINATOR = 1000000000000n;
// Pool account field offsets (borsh, no padding). A ConstantProduct pool's
// content ends right after the curve_type tag at 875 — there is no
// amp/multiplier/depeg payload (Stable-only fields, see the sibling adapter).
const POOL_MIN_LENGTH = 875;
const POOL_OFFSETS = {
    tokenAMint: 40,
    tokenBMint: 72,
    aVault: 104,
    bVault: 136,
    aVaultLp: 168,
    bVaultLp: 200,
    enabled: 233,
    protocolTokenAFee: 234,
    protocolTokenBFee: 266,
    tradeFeeNumerator: 330,
    tradeFeeDenominator: 338,
    protocolTradeFeeNumerator: 346,
    protocolTradeFeeDenominator: 354,
    activationPoint: 403,
    activationType: 475,
    curveTag: 874,
};
// Dynamic-vault account field offsets — identical to the stable sibling.
const VAULT_MIN_LENGTH = 1227;
const VAULT_OFFSETS = {
    totalAmount: 11,
    tokenVault: 19,
    lpMint: 115,
    lastUpdatedLockedProfit: 1203,
    lastReport: 1211,
    lockedProfitDegradation: 1219,
};
// SPL token account amount (u64 LE) / SPL mint supply (u64 LE).
const TOKEN_AMOUNT_OFFSET = 64;
const MINT_SUPPLY_OFFSET = 36;
function poolRefs(pool) {
    const base = `damm1cp:${pool}`;
    return {
        pool: `${base}:pool`,
        aVault: `${base}:a-vault`,
        bVault: `${base}:b-vault`,
        aVaultLp: `${base}:a-vault-lp`,
        bVaultLp: `${base}:b-vault-lp`,
        aLpMint: `${base}:a-lp-mint`,
        bLpMint: `${base}:b-lp-mint`,
        aTokenVault: `${base}:a-token-vault`,
        bTokenVault: `${base}:b-token-vault`,
        protocolTokenAFee: `${base}:protocol-token-a-fee`,
    };
}
function expectDiscriminator(data, expected, what) {
    for (let i = 0; i < 8; i++) {
        if (data[i] !== expected[i]) {
            const got = Buffer.from(data.subarray(0, 8)).toString('hex');
            const want = Buffer.from(expected).toString('hex');
            throw new Error(`${SLUG} ${what} has discriminator ${got}, expected ${want}`);
        }
    }
}
async function loadVault(load, vault, side) {
    const data = await load(vault);
    if (data === null)
        throw new Error(`${SLUG} vault ${side} account ${vault} not found`);
    if (data.length < VAULT_MIN_LENGTH) {
        throw new Error(`${SLUG} vault ${side} account ${vault} data is ${data.length} bytes, expected at least ${VAULT_MIN_LENGTH}`);
    }
    expectDiscriminator(data, VAULT_DISCRIMINATOR, `vault ${side} account ${vault}`);
    const codec = getAddressCodec();
    return {
        tokenVault: codec.decode(data.subarray(VAULT_OFFSETS.tokenVault, VAULT_OFFSETS.tokenVault + 32)),
        lpMint: codec.decode(data.subarray(VAULT_OFFSETS.lpMint, VAULT_OFFSETS.lpMint + 32)),
    };
}
/**
 * calculate_fee(x, n, d): 0 when n == 0 or x == 0, else max(1, floor(x*n/d)) —
 * identical rule to the stable sibling and to ../orca-legacy-token-swap.
 */
function calculateFee(x, numerator, denominator) {
    if (numerator === 0n || x === 0n)
        return 0n;
    const fee = (x * numerator) / denominator;
    return fee === 0n ? 1n : fee;
}
/** Vault unlocked amount at t — identical decay law to the stable sibling. */
function unlockedAmount(vault, t) {
    const duration = t - vault.lastReport;
    if (duration < 0n)
        throw new Error(`${SLUG} clock ${t} is behind vault last_report ${vault.lastReport}`);
    const ratio = duration * vault.degradation;
    const locked = ratio > DEGRADATION_DENOMINATOR
        ? 0n
        : (vault.lockedProfit * (DEGRADATION_DENOMINATOR - ratio)) / DEGRADATION_DENOMINATOR;
    return vault.total - locked;
}
function assertU64Amount(amountIn, what) {
    if (amountIn <= 0n || amountIn >= 1n << 64n) {
        throw new Error(`${SLUG} ${what} amountIn must be a positive u64, got ${amountIn}`);
    }
}
export const meteoraDammV1Cp = {
    slug: SLUG,
    kind: 'constant-product',
    programId: PROGRAM_ID,
    async fetchPoolConfig(load, pool) {
        const data = await load(pool);
        if (data === null)
            throw new Error(`${SLUG} pool account ${pool} not found`);
        if (data.length < POOL_MIN_LENGTH) {
            throw new Error(`${SLUG} pool account ${pool} data is ${data.length} bytes, expected at least ${POOL_MIN_LENGTH}`);
        }
        expectDiscriminator(data, POOL_DISCRIMINATOR, `pool account ${pool}`);
        const enabled = data[POOL_OFFSETS.enabled];
        if (enabled !== 1)
            throw new Error(`${SLUG} pool ${pool} is disabled (enabled = ${enabled})`);
        const curveTag = data[POOL_OFFSETS.curveTag];
        if (curveTag !== 0) {
            throw new Error(`${SLUG} pool ${pool} curve_type tag is ${curveTag}, expected 0 (ConstantProduct)`);
        }
        const activationPoint = readUintLE(data, POOL_OFFSETS.activationPoint, 8);
        const activationType = data[POOL_OFFSETS.activationType];
        if (activationType === 0 && activationPoint !== 0n) {
            throw new Error(`${SLUG} pool ${pool} has slot-based activation_point ${activationPoint} — slot-gated pools are out of scope`);
        }
        const codec = getAddressCodec();
        const pk = (offset) => codec.decode(data.subarray(offset, offset + 32));
        const aVault = pk(POOL_OFFSETS.aVault);
        const bVault = pk(POOL_OFFSETS.bVault);
        const vaultA = await loadVault(load, aVault, 'a');
        const vaultB = await loadVault(load, bVault, 'b');
        const tradeFeeDenominator = readUintLE(data, POOL_OFFSETS.tradeFeeDenominator, 8);
        const protocolTradeFeeDenominator = readUintLE(data, POOL_OFFSETS.protocolTradeFeeDenominator, 8);
        const tradeFeeNumerator = readUintLE(data, POOL_OFFSETS.tradeFeeNumerator, 8);
        const protocolTradeFeeNumerator = readUintLE(data, POOL_OFFSETS.protocolTradeFeeNumerator, 8);
        if (tradeFeeNumerator !== 0n && tradeFeeDenominator === 0n) {
            throw new Error(`${SLUG} pool ${pool} trade fee denominator is 0 with nonzero numerator ${tradeFeeNumerator}`);
        }
        if (protocolTradeFeeNumerator !== 0n && protocolTradeFeeDenominator === 0n) {
            throw new Error(`${SLUG} pool ${pool} protocol trade fee denominator is 0 with nonzero numerator ${protocolTradeFeeNumerator}`);
        }
        return {
            venue: SLUG,
            pool,
            tokenAMint: pk(POOL_OFFSETS.tokenAMint),
            tokenBMint: pk(POOL_OFFSETS.tokenBMint),
            aVault,
            bVault,
            aVaultLp: pk(POOL_OFFSETS.aVaultLp),
            bVaultLp: pk(POOL_OFFSETS.bVaultLp),
            protocolTokenAFee: pk(POOL_OFFSETS.protocolTokenAFee),
            protocolTokenBFee: pk(POOL_OFFSETS.protocolTokenBFee),
            aTokenVault: vaultA.tokenVault,
            bTokenVault: vaultB.tokenVault,
            aLpMint: vaultA.lpMint,
            bLpMint: vaultB.lpMint,
            tradeFeeNumerator,
            tradeFeeDenominator,
            protocolTradeFeeNumerator,
            protocolTradeFeeDenominator,
            activationPoint,
            activationType,
        };
    },
    quoteAccounts(cfg) {
        const c = cfg;
        const refs = poolRefs(c.pool);
        return [
            { ref: refs.pool, address: c.pool },
            { ref: refs.aVault, address: c.aVault },
            { ref: refs.bVault, address: c.bVault },
            { ref: refs.aVaultLp, address: c.aVaultLp },
            { ref: refs.bVaultLp, address: c.bVaultLp },
            { ref: refs.aLpMint, address: c.aLpMint },
            { ref: refs.bLpMint, address: c.bLpMint },
            { ref: refs.bTokenVault, address: c.bTokenVault },
        ];
    },
    emitQuote(cfg, i, amountIn) {
        const c = cfg;
        assertU64Amount(amountIn, 'emitQuote');
        const refs = poolRefs(c.pool);
        const pool = JSON.stringify(refs.pool);
        const aVault = JSON.stringify(refs.aVault);
        const bVault = JSON.stringify(refs.bVault);
        const DEG = DEGRADATION_DENOMINATOR;
        return [
            `const t${i} = block.timestamp;`,
            `const aTot${i} = accountUint(${aVault}, ${VAULT_OFFSETS.totalAmount}, 8);`,
            `const aLok${i} = accountUint(${aVault}, ${VAULT_OFFSETS.lastUpdatedLockedProfit}, 8);`,
            `const aRatio${i} = (t${i} - accountUint(${aVault}, ${VAULT_OFFSETS.lastReport}, 8)) * accountUint(${aVault}, ${VAULT_OFFSETS.lockedProfitDegradation}, 8);`,
            `let aUnl${i} = aTot${i};`,
            `if (aRatio${i} <= ${DEG}) { aUnl${i} = aTot${i} - aLok${i} * (${DEG} - aRatio${i}) / ${DEG} }`,
            `const bTot${i} = accountUint(${bVault}, ${VAULT_OFFSETS.totalAmount}, 8);`,
            `const bLok${i} = accountUint(${bVault}, ${VAULT_OFFSETS.lastUpdatedLockedProfit}, 8);`,
            `const bRatio${i} = (t${i} - accountUint(${bVault}, ${VAULT_OFFSETS.lastReport}, 8)) * accountUint(${bVault}, ${VAULT_OFFSETS.lockedProfitDegradation}, 8);`,
            `let bUnl${i} = bTot${i};`,
            `if (bRatio${i} <= ${DEG}) { bUnl${i} = bTot${i} - bLok${i} * (${DEG} - bRatio${i}) / ${DEG} }`,
            `const aLpAmt${i} = accountUint(${JSON.stringify(refs.aVaultLp)}, ${TOKEN_AMOUNT_OFFSET}, 8);`,
            `const bLpAmt${i} = accountUint(${JSON.stringify(refs.bVaultLp)}, ${TOKEN_AMOUNT_OFFSET}, 8);`,
            `const aSup${i} = accountUint(${JSON.stringify(refs.aLpMint)}, ${MINT_SUPPLY_OFFSET}, 8);`,
            `const bSup${i} = accountUint(${JSON.stringify(refs.bLpMint)}, ${MINT_SUPPLY_OFFSET}, 8);`,
            `const rIn${i} = aLpAmt${i} * aUnl${i} / aSup${i};`,
            `const rOut${i} = bLpAmt${i} * bUnl${i} / bSup${i};`,
            `const fNum${i} = accountUint(${pool}, ${POOL_OFFSETS.tradeFeeNumerator}, 8);`,
            `let tFee${i} = ${amountIn} * fNum${i} / accountUint(${pool}, ${POOL_OFFSETS.tradeFeeDenominator}, 8);`,
            `if (fNum${i} > 0) { if (tFee${i} === 0) { tFee${i} = 1 } }`,
            `const pNum${i} = accountUint(${pool}, ${POOL_OFFSETS.protocolTradeFeeNumerator}, 8);`,
            `let pFee${i} = tFee${i} * pNum${i} / accountUint(${pool}, ${POOL_OFFSETS.protocolTradeFeeDenominator}, 8);`,
            `if (pNum${i} > 0) { if (tFee${i} > 0) { if (pFee${i} === 0) { pFee${i} = 1 } } }`,
            `tFee${i} = tFee${i} - pFee${i};`,
            `const inNet${i} = ${amountIn} - pFee${i};`,
            // Vault deposit simulation — identical to the stable sibling.
            `const inLp${i} = inNet${i} * aSup${i} / aUnl${i};`,
            `const aft${i} = (inLp${i} + aLpAmt${i}) * (aUnl${i} + inNet${i}) / (aSup${i} + inLp${i});`,
            `const srcNet${i} = aft${i} - rIn${i} - tFee${i};`,
            // Constant-product curve: dest = rOut - ceil(rIn*rOut / (rIn+srcNet)),
            // ceiled via (num + den - 1) / den — the same spl-token-swap-lineage
            // form as ../orca-legacy-token-swap, in place of the stable Newton D/y.
            `const ni${i} = rIn${i} + srcNet${i};`,
            `const dest${i} = rOut${i} - (rIn${i} * rOut${i} + ni${i} - 1) / ni${i};`,
            // Vault withdraw simulation (two more floors) — identical to the stable sibling.
            `const outLp${i} = dest${i} * bSup${i} / bUnl${i};`,
            `let out${i} = outLp${i} * bUnl${i} / bSup${i};`,
            `if (out${i} >= accountUint(${JSON.stringify(refs.bTokenVault)}, ${TOKEN_AMOUNT_OFFSET}, 8)) { out${i} = 0 }`,
            ...(c.activationType === 1 && c.activationPoint > 0n ? [`if (t${i} < ${c.activationPoint}) { out${i} = 0 }`] : []),
            `const q${i} = out${i};`,
        ].map((line) => `  ${line}`).join('\n');
    },
    buildSwap(cfg, user, amountIn) {
        const c = cfg;
        assertU64Amount(amountIn, 'buildSwap');
        const refs = poolRefs(c.pool);
        const data = new Uint8Array(24);
        data.set(SWAP_DISCRIMINATOR, 0);
        new DataView(data.buffer).setBigUint64(8, amountIn, true);
        new DataView(data.buffer).setBigUint64(16, 1n, true);
        return {
            programId: PROGRAM_ID,
            data,
            accounts: [
                { ref: refs.pool, address: c.pool, writable: true },
                { ref: user.inAta, writable: true },
                { ref: user.outAta, writable: true },
                { ref: refs.aVault, address: c.aVault, writable: true },
                { ref: refs.bVault, address: c.bVault, writable: true },
                { ref: refs.aTokenVault, address: c.aTokenVault, writable: true },
                { ref: refs.bTokenVault, address: c.bTokenVault, writable: true },
                { ref: refs.aLpMint, address: c.aLpMint, writable: true },
                { ref: refs.bLpMint, address: c.bLpMint, writable: true },
                { ref: refs.aVaultLp, address: c.aVaultLp, writable: true },
                { ref: refs.bVaultLp, address: c.bVaultLp, writable: true },
                { ref: refs.protocolTokenAFee, address: c.protocolTokenAFee, writable: true },
                { ref: user.owner, signer: true },
                { ref: 'damm1cp:vault-program', address: VAULT_PROGRAM_ID },
                { ref: 'token-program', address: TOKEN_PROGRAM_ID },
            ],
        };
    },
    referenceQuote(cfg, state, amountIn, now) {
        const c = cfg;
        const bytes = (addr, what) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} referenceQuote state is missing ${what} account ${addr}`);
            return data;
        };
        if (c.activationType === 1 && now < c.activationPoint) {
            throw new Error(`${SLUG} pool ${c.pool} is not activated until ${c.activationPoint} (now ${now})`);
        }
        const poolData = bytes(c.pool, 'pool');
        const tradeFeeNumerator = readUintLE(poolData, POOL_OFFSETS.tradeFeeNumerator, 8);
        const tradeFeeDenominator = readUintLE(poolData, POOL_OFFSETS.tradeFeeDenominator, 8);
        const protocolFeeNumerator = readUintLE(poolData, POOL_OFFSETS.protocolTradeFeeNumerator, 8);
        const protocolFeeDenominator = readUintLE(poolData, POOL_OFFSETS.protocolTradeFeeDenominator, 8);
        const vault = (addr, what) => {
            const data = bytes(addr, what);
            return {
                total: readUintLE(data, VAULT_OFFSETS.totalAmount, 8),
                lockedProfit: readUintLE(data, VAULT_OFFSETS.lastUpdatedLockedProfit, 8),
                lastReport: readUintLE(data, VAULT_OFFSETS.lastReport, 8),
                degradation: readUintLE(data, VAULT_OFFSETS.lockedProfitDegradation, 8),
            };
        };
        const vaultA = vault(c.aVault, 'vault a');
        const vaultB = vault(c.bVault, 'vault b');
        const aVaultLpAmount = readUintLE(bytes(c.aVaultLp, 'a_vault_lp'), TOKEN_AMOUNT_OFFSET, 8);
        const bVaultLpAmount = readUintLE(bytes(c.bVaultLp, 'b_vault_lp'), TOKEN_AMOUNT_OFFSET, 8);
        const aLpSupply = readUintLE(bytes(c.aLpMint, 'a lp mint'), MINT_SUPPLY_OFFSET, 8);
        const bLpSupply = readUintLE(bytes(c.bLpMint, 'b lp mint'), MINT_SUPPLY_OFFSET, 8);
        const outIdleFloat = readUintLE(bytes(c.bTokenVault, 'b token vault'), TOKEN_AMOUNT_OFFSET, 8);
        const unlockedA = unlockedAmount(vaultA, now);
        const unlockedB = unlockedAmount(vaultB, now);
        const reserveIn = (aVaultLpAmount * unlockedA) / aLpSupply;
        const reserveOut = (bVaultLpAmount * unlockedB) / bLpSupply;
        let tradeFee = calculateFee(amountIn, tradeFeeNumerator, tradeFeeDenominator);
        const protocolFee = calculateFee(tradeFee, protocolFeeNumerator, protocolFeeDenominator);
        tradeFee -= protocolFee;
        const inAfterProtocol = amountIn - protocolFee;
        const inLp = (inAfterProtocol * aLpSupply) / unlockedA;
        const unlockedAAfter = unlockedAmount({ ...vaultA, total: vaultA.total + inAfterProtocol }, now);
        const afterTotal = ((inLp + aVaultLpAmount) * unlockedAAfter) / (aLpSupply + inLp);
        const actualInAfterFee = afterTotal - reserveIn - tradeFee;
        // Constant-product curve, ceiled against the trader (checked_ceil_div
        // convention): a floor quotient of 0 means the swap fails on-chain.
        const newIn = reserveIn + actualInAfterFee;
        if ((reserveIn * reserveOut) / newIn === 0n) {
            throw new Error(`${SLUG} swap fails on-chain (zero quotient)`);
        }
        const destinationAmount = reserveOut - ceilDiv(reserveIn * reserveOut, newIn);
        if (destinationAmount === 0n)
            throw new Error(`${SLUG} swap fails on-chain (zero output)`);
        const outLp = (destinationAmount * bLpSupply) / unlockedB;
        const outAmount = (outLp * unlockedB) / bLpSupply;
        if (outAmount >= outIdleFloat) {
            throw new Error(`${SLUG} quote ${outAmount} exceeds vault idle liquidity ${outIdleFloat}`);
        }
        return outAmount;
    },
};
//# sourceMappingURL=index.js.map