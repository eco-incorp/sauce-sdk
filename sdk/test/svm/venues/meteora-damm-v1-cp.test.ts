/**
 * meteora-damm-v1-cp adapter units (no engine, no RPC): fixture decode, the
 * pinned mainnet worked example (USDC/SOL pool 5yuefgbJ..., t=1785363978,
 * 1_000_000 uUSDC -> 13_563_294 lamports SOL), quote gates on doctored
 * fixtures, the documented swap encoding, and v1/v2 lockstep.
 *
 * Fixture dumped live from mainnet-beta (public RPC, no key) 2026-07-29 — one
 * of only 8 on-chain Meteora DAMM v1 pools with curve_type tag 0
 * (ConstantProduct pools are rare on this legacy program; most liquidity
 * migrated to DAMM v2). The pinned worked example is INTERNALLY derived from
 * this repo's own referenceQuote implementation (no independent on-chain CPI
 * confirmation yet — see the venue's module doc for the assumed curve
 * lineage).
 */
import { fileURLToPath } from 'url';
import { address } from '@solana/kit';
import { meteoraDammV1Cp } from '../../../src/svm/venues/meteora-damm-v1-cp/index.js';
import type { MeteoraDammV1CpPoolConfig } from '../../../src/svm/venues/meteora-damm-v1-cp/index.js';
import { meteoraDammV1CpLadder } from '../../../src/svm/venues/meteora-damm-v1-cp/ladder.js';
import { fixtureBytesMap, fixtureData, fixtureLoader, loadFixtures } from '../fixtures.js';
import type { AccountFixture } from '../fixtures.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/meteora-damm-v1-cp/', import.meta.url));

const POOL = address('5yuefgbJJpmFNK2iiYbLSpv1aZXq7F9AUKkZKErTYCvs');
const A_VAULT = '3ESUFCnRNgZ7Mn2mPPUMmXYaKU8jpnV9VtA17M7t2mHQ';
const B_VAULT = 'FERjPVNEa7Udq8CEv68h6tPL46Tq7ieE49HrE2wea3XT';
const A_VAULT_LP = 'CNc2A5yjKUa9Rp3CVYXF9By1qvRHXMncK9S254MS9JeV';
const B_VAULT_LP = '7LHUMZd12RuanSXhXjQWPSXS6QEVQimgwxde6xYTJuA7';
const A_TOKEN_VAULT = 'C2QoQ111jGHEy5918XkNXQro7gGwC9PKLXd1LqBiYNwA';
const B_TOKEN_VAULT = 'HZeLxbZ9uHtSpwZC3LBr4Nubd14iHwz7bRSghRZf5VCG';
const A_LP_MINT = '3RpEekjLE5cdcG15YcXJUpxSepemvq2FpmMcgo342BwC';
const B_LP_MINT = 'FZN7QZ8ZUUAxMPfxYEYkH3cXUASzH8EqA6B4tyCL8f1j';

// Pinned mainnet-state worked example (dumped 2026-07-29; clock pinned to the
// vaults' own last_report so the locked-profit decay ratio is exactly 0).
const CLOCK_T = 1_785_363_978n;
const AMOUNT_IN = 1_000_000n; // 1 uUSDC (6 decimals)
const PINNED_OUT = 13_563_294n; // lamports SOL (9 decimals)

const fixtures = loadFixtures(FIXTURE_DIR);
const state = fixtureBytesMap(fixtures);

/** Fixture set with `mutate` applied to one account's data. */
function doctored(addr: string, mutate: (data: Uint8Array) => void): AccountFixture[] {
  return fixtures.map((fixture) => {
    if (fixture.address !== addr) return fixture;
    const data = fixtureData(fixture);
    mutate(data);
    return { ...fixture, base64Data: Buffer.from(data).toString('base64') };
  });
}

async function fetchConfig(from: AccountFixture[] = fixtures): Promise<MeteoraDammV1CpPoolConfig> {
  return (await meteoraDammV1Cp.fetchPoolConfig(fixtureLoader(from), POOL)) as MeteoraDammV1CpPoolConfig;
}

describe('meteora-damm-v1-cp adapter identity', () => {
  it('declares the slug, constant-product kind and mainnet program id', () => {
    expect(meteoraDammV1Cp.slug).toBe('meteora-damm-v1-cp');
    expect(meteoraDammV1Cp.kind).toBe('constant-product');
    expect(meteoraDammV1Cp.programId).toBe('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
  });
});

describe('meteora-damm-v1-cp fetchPoolConfig', () => {
  it('decodes the mainnet USDC/SOL pool fixture', async () => {
    const cfg = await fetchConfig();
    expect(cfg.venue).toBe('meteora-damm-v1-cp');
    expect(cfg.pool).toBe(POOL);
    expect(cfg.tokenAMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(cfg.tokenBMint).toBe('So11111111111111111111111111111111111111112');
    expect(cfg.aVault).toBe(A_VAULT);
    expect(cfg.bVault).toBe(B_VAULT);
    expect(cfg.aVaultLp).toBe(A_VAULT_LP);
    expect(cfg.bVaultLp).toBe(B_VAULT_LP);
    expect(cfg.aTokenVault).toBe(A_TOKEN_VAULT);
    expect(cfg.bTokenVault).toBe(B_TOKEN_VAULT);
    expect(cfg.aLpMint).toBe(A_LP_MINT);
    expect(cfg.bLpMint).toBe(B_LP_MINT);
    expect(cfg.tradeFeeNumerator).toBe(25n);
    expect(cfg.tradeFeeDenominator).toBe(10_000n);
    expect(cfg.protocolTradeFeeNumerator).toBe(20_000n);
    expect(cfg.protocolTradeFeeDenominator).toBe(100_000n);
    expect(cfg.activationPoint).toBe(0n);
    expect(cfg.activationType).toBe(0);
  });

  it('throws when the pool account is missing', async () => {
    const load = fixtureLoader(fixtures.filter((fixture) => fixture.address !== POOL));
    await expect(meteoraDammV1Cp.fetchPoolConfig(load, POOL)).rejects.toThrow(
      `meteora-damm-v1-cp pool account ${POOL} not found`,
    );
  });

  it('throws on a wrong pool discriminator', async () => {
    const bad = doctored(POOL, (data) => { data[0] = 0x00; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-cp pool account ${POOL} has discriminator 009a6d0411b16dbc, expected f19a6d0411b16dbc`,
    );
  });

  it('gate: throws when the pool is disabled (enabled byte 233 flipped)', async () => {
    const bad = doctored(POOL, (data) => { data[233] = 0; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-cp pool ${POOL} is disabled (enabled = 0)`,
    );
  });

  it('gate: throws on a stable pool (curve tag byte 874 flipped to 1)', async () => {
    const bad = doctored(POOL, (data) => { data[874] = 1; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-cp pool ${POOL} curve_type tag is 1, expected 0 (ConstantProduct)`,
    );
  });

  it('gate: throws on a slot-gated activation point (u64 at 403, activation_type 0)', async () => {
    const bad = doctored(POOL, (data) => { data[403] = 42; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-cp pool ${POOL} has slot-based activation_point 42 — slot-gated pools are out of scope`,
    );
  });

  it('throws on a wrong vault discriminator', async () => {
    const bad = doctored(A_VAULT, (data) => { data[0] = 0xff; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-cp vault a account ${A_VAULT} has discriminator ff08e82b02987577, expected d308e82b02987577`,
    );
  });
});

describe('meteora-damm-v1-cp referenceQuote (v1 adapter)', () => {
  it('reproduces the pinned worked example exactly (1 uUSDC -> 13563294 lamports SOL)', async () => {
    const cfg = await fetchConfig();
    expect(meteoraDammV1Cp.referenceQuote(cfg, state, AMOUNT_IN, CLOCK_T)).toBe(PINNED_OUT);
  });

  it('gate: throws when a timestamp activation point is in the future', async () => {
    const bad = doctored(POOL, (data) => {
      data[475] = 1; // activation_type = Timestamp
      new DataView(data.buffer, data.byteOffset).setBigUint64(403, CLOCK_T + 1n, true);
    });
    const cfg = await fetchConfig(bad);
    expect(() => meteoraDammV1Cp.referenceQuote(cfg, fixtureBytesMap(bad), AMOUNT_IN, CLOCK_T)).toThrow(
      `meteora-damm-v1-cp pool ${POOL} is not activated until ${CLOCK_T + 1n} (now ${CLOCK_T})`,
    );
  });
});

describe('meteora-damm-v1-cp buildSwap (v1 adapter)', () => {
  it('encodes the swap discriminator + amountIn + minOut=1, 15-account list', async () => {
    const cfg = await fetchConfig();
    const user = { inAta: 'user:in', outAta: 'user:out', owner: 'user:owner' };
    const swap = meteoraDammV1Cp.buildSwap(cfg, user, AMOUNT_IN);
    expect(swap.programId).toBe('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
    expect(swap.data.length).toBe(24);
    expect(Buffer.from(swap.data.subarray(0, 8)).toString('hex')).toBe('f8c69e91e17587c8');
    expect(new DataView(swap.data.buffer).getBigUint64(8, true)).toBe(AMOUNT_IN);
    expect(new DataView(swap.data.buffer).getBigUint64(16, true)).toBe(1n);
    expect(swap.accounts).toHaveLength(15);
    expect(swap.accounts[1]?.ref).toBe('user:in');
    expect(swap.accounts[2]?.ref).toBe('user:out');
    expect(swap.accounts[12]?.ref).toBe('user:owner');
    expect(swap.accounts[12]?.signer).toBe(true);
  });
});

describe('meteora-damm-v1-cp ladder v2 (EcoSwapSVM fragment)', () => {
  it('quoteRefs / emitSetup / emitQuoteCall name-consistent locals for a slot', async () => {
    const cfg = await fetchConfig();
    const refs = meteoraDammV1CpLadder.quoteRefs(cfg, 2);
    expect(refs).toHaveLength(8);
    expect(refs.map((r) => r.ref)).toEqual([
      's2:pool', 's2:av', 's2:bv', 's2:avlp', 's2:bvlp', 's2:alpm', 's2:blpm', 's2:btv',
    ]);
    const setup = meteoraDammV1CpLadder.emitSetup(cfg, 2, []);
    expect(setup).toContain('s2rin');
    expect(setup).toContain('s2rout');
    const call = meteoraDammV1CpLadder.emitQuoteCall!(cfg, 2, 'x');
    expect(call).toBe(
      'qDammCp(x, s2rin, s2rout, s2au, s2bu, s2alp, s2asu, s2bsu, s2fn, s2fd, s2pn, s2pd, s2idl)',
    );
  });

  it('declares exactly one helper (qDammCp) — a pointwise CP form, no Newton chain', () => {
    const helpers = meteoraDammV1CpLadder.helpers(undefined as never);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]?.name).toBe('qDammCp');
    expect(meteoraDammV1CpLadder.paramCount).toBe(0);
    expect(meteoraDammV1CpLadder.emitLadderQuote).toBeUndefined();
    expect(meteoraDammV1CpLadder.emitFinalQuote).toBeUndefined();
  });

  it('referenceQuote matches the v1 adapter exactly (lockstep) at the pinned worked example', async () => {
    const cfg = await fetchConfig();
    const ladderQuote = meteoraDammV1CpLadder.referenceQuote(cfg, state, [], CLOCK_T);
    expect(ladderQuote(AMOUNT_IN)).toBe(PINNED_OUT);
    expect(ladderQuote(AMOUNT_IN)).toBe(meteoraDammV1Cp.referenceQuote(cfg, state, AMOUNT_IN, CLOCK_T));
  });

  it('referenceQuote returns 0 for x = 0 (adapter contract)', async () => {
    const cfg = await fetchConfig();
    const ladderQuote = meteoraDammV1CpLadder.referenceQuote(cfg, state, [], CLOCK_T);
    expect(ladderQuote(0n)).toBe(0n);
  });

  it('depthReserves matches the vault-share-math reserves the quote uses', async () => {
    const cfg = await fetchConfig();
    const { reserveIn, reserveOut } = meteoraDammV1CpLadder.depthReserves!(cfg, state, CLOCK_T);
    expect(reserveIn).toBe(39_145_332_738n);
    expect(reserveOut).toBe(532_283_940_646n);
  });

  it('buildSwapV2 encodes the same 15-account list shape as buildSwap, patch: in', async () => {
    const cfg = await fetchConfig();
    const user = { inAta: 'user:in', outAta: 'user:out', owner: 'user:owner' };
    const tmpl = meteoraDammV1CpLadder.buildSwapV2(cfg, 3, user);
    expect(tmpl.patch).toBe('in');
    expect(tmpl.programId).toBe('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
    expect(Buffer.from(tmpl.prefix).toString('hex')).toBe('f8c69e91e17587c8');
    expect(tmpl.accounts).toHaveLength(15);
    expect(tmpl.accounts[0]?.ref).toBe('s3:pool');
    expect(tmpl.accounts[12]?.ref).toBe('user:owner');
  });
});
