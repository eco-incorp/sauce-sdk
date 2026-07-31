/**
 * meteora-damm-v1-stable adapter units (no engine, no RPC): fixture decode,
 * the pinned mainnet worked example (USDC/USDT pool 32D4..., t=1783175236,
 * 1_000_000_000 uUSDC -> 1_000_605_351 uUSDT), quote gates on doctored
 * fixtures, the documented swap encoding, and fragment compilability.
 */
import { fileURLToPath } from 'url';
import { address } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { meteoraDammV1Stable } from '../../../src/svm/venues/meteora-damm-v1-stable/index.js';
import type { MeteoraDammV1StablePoolConfig } from '../../../src/svm/venues/meteora-damm-v1-stable/index.js';
import { meteoraDammV1StableLadder } from '../../../src/svm/venues/meteora-damm-v1-stable/ladder.js';
import { fixtureBytesMap, fixtureData, fixtureLoader, loadFixtures } from '../fixtures.js';
import type { AccountFixture } from '../fixtures.js';
import type { AccountBytesMap } from '../../../src/svm/index.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/meteora-damm-v1-stable/', import.meta.url));

const POOL = address('32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG');
const A_VAULT = '3ESUFCnRNgZ7Mn2mPPUMmXYaKU8jpnV9VtA17M7t2mHQ';
const B_VAULT = '5XCP3oD3JAuQyDpfBFFVUxsBxNjPQojpKuL4aVhHsDok';
const A_VAULT_LP = '24NYE3hHQyUTrHUT4n1CcVrMP9Xy3ULuT1Uurw1HDeck';
const B_VAULT_LP = 'Hv5ogVb2BZCF3ET2KnaEYj2seKHN5ffGDazm6BGt5DD9';
const A_TOKEN_VAULT = 'C2QoQ111jGHEy5918XkNXQro7gGwC9PKLXd1LqBiYNwA';
const B_TOKEN_VAULT = 'DQjGWHN9ERn1zSMpWLNvSpTFUSfnxbanBt9A7xyU2bVE';
const A_LP_MINT = '3RpEekjLE5cdcG15YcXJUpxSepemvq2FpmMcgo342BwC';
const B_LP_MINT = 'EZun6G5514FeqYtUv26cBHWLqXjAEdjGuoX6ThBpBtKj';

// Pinned observedState_2026-07-04 worked example.
const CLOCK_T = 1_783_175_236n;
const AMOUNT_IN = 1_000_000_000n;
const PINNED_OUT = 1_000_605_351n;

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

async function fetchConfig(from: AccountFixture[] = fixtures): Promise<MeteoraDammV1StablePoolConfig> {
  return (await meteoraDammV1Stable.fetchPoolConfig(fixtureLoader(from), POOL)) as MeteoraDammV1StablePoolConfig;
}

describe('meteora-damm-v1-stable adapter identity', () => {
  it('declares the slug, stable kind and mainnet program id', () => {
    expect(meteoraDammV1Stable.slug).toBe('meteora-damm-v1-stable');
    expect(meteoraDammV1Stable.kind).toBe('stable');
    expect(meteoraDammV1Stable.programId).toBe('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
  });
});

describe('meteora-damm-v1-stable fetchPoolConfig', () => {
  it('decodes the mainnet USDC/USDT pool fixture (docs/svm-venues.md field values)', async () => {
    const cfg = await fetchConfig();
    expect(cfg.venue).toBe('meteora-damm-v1-stable');
    expect(cfg.pool).toBe(POOL);
    expect(cfg.tokenAMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(cfg.tokenBMint).toBe('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
    expect(cfg.aVault).toBe(A_VAULT);
    expect(cfg.bVault).toBe(B_VAULT);
    expect(cfg.aVaultLp).toBe(A_VAULT_LP);
    expect(cfg.bVaultLp).toBe(B_VAULT_LP);
    expect(cfg.protocolTokenAFee).toBe('4Qjrnzp5jXPSBhyv495ApB1SdDbXdZ5Pc9ZSiabf9NmJ');
    // 2-hop fields, read from the two Vault accounts (offsets 19 / 115).
    expect(cfg.aTokenVault).toBe(A_TOKEN_VAULT);
    expect(cfg.bTokenVault).toBe(B_TOKEN_VAULT);
    expect(cfg.aLpMint).toBe(A_LP_MINT);
    expect(cfg.bLpMint).toBe(B_LP_MINT);
    // trade_fee 100/1000000 (0.01%), protocol_trade_fee 0/1000000.
    expect(cfg.tradeFeeNumerator).toBe(100n);
    expect(cfg.tradeFeeDenominator).toBe(1_000_000n);
    expect(cfg.protocolTradeFeeNumerator).toBe(0n);
    expect(cfg.protocolTradeFeeDenominator).toBe(1_000_000n);
    expect(cfg.amp).toBe(8000n);
    expect(cfg.tokenAMultiplier).toBe(1n);
    expect(cfg.tokenBMultiplier).toBe(1n);
    expect(cfg.activationPoint).toBe(0n);
    expect(cfg.activationType).toBe(0);
  });

  it('throws when the pool account is missing', async () => {
    const load = fixtureLoader(fixtures.filter((fixture) => fixture.address !== POOL));
    await expect(meteoraDammV1Stable.fetchPoolConfig(load, POOL)).rejects.toThrow(
      `meteora-damm-v1-stable pool account ${POOL} not found`,
    );
  });

  it('throws on a wrong pool discriminator', async () => {
    const bad = doctored(POOL, (data) => { data[0] = 0x00; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-stable pool account ${POOL} has discriminator 009a6d0411b16dbc, expected f19a6d0411b16dbc`,
    );
  });

  it('gate: throws when the pool is disabled (enabled byte 233 flipped)', async () => {
    const bad = doctored(POOL, (data) => { data[233] = 0; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-stable pool ${POOL} is disabled (enabled = 0)`,
    );
  });

  it('gate: throws on a constant-product pool (curve tag byte 874 flipped)', async () => {
    const bad = doctored(POOL, (data) => { data[874] = 0; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-stable pool ${POOL} curve_type tag is 0, expected 1 (Stable)`,
    );
  });

  it('gate: throws on a depeg pool (depeg_type byte 916 flipped to Marinade)', async () => {
    const bad = doctored(POOL, (data) => { data[916] = 1; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-stable pool ${POOL} depeg_type is 1, expected 0 (None) — depeg pools are out of scope`,
    );
  });

  it('gate: throws on a slot-gated activation point (u64 at 403, activation_type 0)', async () => {
    const bad = doctored(POOL, (data) => { data[403] = 42; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-stable pool ${POOL} has slot-based activation_point 42 — slot-gated pools are out of scope`,
    );
  });

  it('throws on a wrong vault discriminator', async () => {
    const bad = doctored(A_VAULT, (data) => { data[0] = 0xff; });
    await expect(fetchConfig(bad)).rejects.toThrow(
      `meteora-damm-v1-stable vault a account ${A_VAULT} has discriminator ff08e82b02987577, expected d308e82b02987577`,
    );
  });
});

describe('meteora-damm-v1-stable referenceQuote', () => {
  it('reproduces the pinned worked example exactly (1 USDC -> 1000605351 uUSDT)', async () => {
    const cfg = await fetchConfig();
    expect(meteoraDammV1Stable.referenceQuote(cfg, state, AMOUNT_IN, CLOCK_T)).toBe(PINNED_OUT);
  });

  it('gate: throws when a timestamp activation point is in the future', async () => {
    const bad = doctored(POOL, (data) => {
      data[475] = 1; // activation_type = Timestamp
      new DataView(data.buffer, data.byteOffset).setBigUint64(403, CLOCK_T + 1n, true);
    });
    const cfg = await fetchConfig(bad);
    expect(() => meteoraDammV1Stable.referenceQuote(cfg, fixtureBytesMap(bad), AMOUNT_IN, CLOCK_T)).toThrow(
      `meteora-damm-v1-stable pool ${POOL} is not activated until ${CLOCK_T + 1n} (now ${CLOCK_T})`,
    );
  });

  it('gate: throws when the clock is behind the vault last_report', async () => {
    const cfg = await fetchConfig();
    // vault_a.last_report = 1783173885 (u64 LE at 1211).
    expect(() => meteoraDammV1Stable.referenceQuote(cfg, state, AMOUNT_IN, 1_783_173_884n)).toThrow(
      'meteora-damm-v1-stable clock 1783173884 is behind vault last_report 1783173885',
    );
  });

  it('gate: throws when the quote exceeds the out-vault idle float (strict <)', async () => {
    const cfg = await fetchConfig();
    // Doctor b_token_vault.amount (u64 LE at 64) down to the pinned quote:
    // out == float must already fail the strict < check.
    const bad = doctored(B_TOKEN_VAULT, (data) => {
      new DataView(data.buffer, data.byteOffset).setBigUint64(64, PINNED_OUT, true);
    });
    expect(() => meteoraDammV1Stable.referenceQuote(cfg, fixtureBytesMap(bad), AMOUNT_IN, CLOCK_T)).toThrow(
      `meteora-damm-v1-stable quote ${PINNED_OUT} exceeds vault idle liquidity ${PINNED_OUT}`,
    );
    const justEnough = doctored(B_TOKEN_VAULT, (data) => {
      new DataView(data.buffer, data.byteOffset).setBigUint64(64, PINNED_OUT + 1n, true);
    });
    expect(meteoraDammV1Stable.referenceQuote(cfg, fixtureBytesMap(justEnough), AMOUNT_IN, CLOCK_T)).toBe(PINNED_OUT);
  });

  it('charges the minimum trade fee of 1 native unit on dust input', async () => {
    const cfg = await fetchConfig();
    // 100 * 100 / 1000000 floors to 0 -> minimum fee 1 applies; the quote
    // must be strictly below the no-fee stable quote of the same size.
    const dust = meteoraDammV1Stable.referenceQuote(cfg, state, 100n, CLOCK_T);
    expect(dust).toBeGreaterThan(0n);
    expect(dust).toBeLessThan(100n);
  });

  it('throws when a quote account is missing from state', async () => {
    const cfg = await fetchConfig();
    const partial = { ...state };
    delete partial[B_LP_MINT];
    expect(() => meteoraDammV1Stable.referenceQuote(cfg, partial, AMOUNT_IN, CLOCK_T)).toThrow(
      `meteora-damm-v1-stable referenceQuote state is missing b lp mint account ${B_LP_MINT}`,
    );
  });
});

describe('meteora-damm-v1-stable quoteAccounts + emitQuote', () => {
  const refs = (name: string) => `damm1s:${POOL}:${name}`;

  it('attaches the 8 read-only quote accounts with resolved addresses', async () => {
    const cfg = await fetchConfig();
    expect(meteoraDammV1Stable.quoteAccounts(cfg)).toEqual([
      { ref: refs('pool'), address: POOL },
      { ref: refs('a-vault'), address: A_VAULT },
      { ref: refs('b-vault'), address: B_VAULT },
      { ref: refs('a-vault-lp'), address: A_VAULT_LP },
      { ref: refs('b-vault-lp'), address: B_VAULT_LP },
      { ref: refs('a-lp-mint'), address: A_LP_MINT },
      { ref: refs('b-lp-mint'), address: B_LP_MINT },
      { ref: refs('b-token-vault'), address: B_TOKEN_VAULT },
    ]);
  });

  it('emits a q<i> fragment with the amountIn literal baked that compiles as SauceScript', async () => {
    const cfg = await fetchConfig();
    const fragment = meteoraDammV1Stable.emitQuote(cfg, 3, AMOUNT_IN);
    expect(fragment).toContain('const q3 = ');
    expect(fragment).toContain(`${AMOUNT_IN} * fNum3`);
    expect(fragment).toContain('stableD(');
    expect(fragment).toContain('stableY(');

    // Compile with stub Newton helpers standing in for the generator-declared
    // shared functions — validates the fragment is real SauceScript and that
    // it reads exactly the quoteAccounts refs.
    const source = [
      'function stableD(amp, xa, xb) { return xa + xb; }',
      'function stableY(amp, x, d) { return d - x; }',
      'function main() {',
      fragment,
      '  return q3;',
      '}',
    ].join('\n');
    const { bytecode, accountPlan } = compile(source, { target: 'svm' });
    expect(bytecode[0].length).toBeGreaterThan(0);
    const planned = accountPlan!.metas.map((meta) => meta.ref).sort();
    const quoted = meteoraDammV1Stable.quoteAccounts(cfg).map((account) => account.ref).sort();
    expect(planned).toEqual(quoted);
  });

  it('rejects a non-u64 amountIn', async () => {
    const cfg = await fetchConfig();
    expect(() => meteoraDammV1Stable.emitQuote(cfg, 0, 0n)).toThrow(
      'meteora-damm-v1-stable emitQuote amountIn must be a positive u64, got 0',
    );
    expect(() => meteoraDammV1Stable.emitQuote(cfg, 0, 1n << 64n)).toThrow(
      `meteora-damm-v1-stable emitQuote amountIn must be a positive u64, got ${1n << 64n}`,
    );
  });
});

describe('meteora-damm-v1-stable buildSwap', () => {
  const user = { inAta: 'user:usdc-ata', outAta: 'user:usdt-ata', owner: 'user:wallet' };

  it('encodes discriminator f8c69e91e17587c8 || in_amount u64 LE || min_out 1 u64 LE', async () => {
    const cfg = await fetchConfig();
    const swap = meteoraDammV1Stable.buildSwap(cfg, user, AMOUNT_IN);
    expect(swap.programId).toBe('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
    expect(Buffer.from(swap.data).toString('hex')).toBe(
      // sha256("global:swap")[..8] || 1_000_000_000 LE || 1 LE (24 bytes).
      'f8c69e91e17587c8' + '00ca9a3b00000000' + '0100000000000000',
    );
  });

  it('orders the 15 documented account metas with the docs/svm-venues.md flags', async () => {
    const cfg = await fetchConfig();
    const swap = meteoraDammV1Stable.buildSwap(cfg, user, AMOUNT_IN);
    expect(swap.accounts).toEqual([
      { ref: refsFor('pool'), address: POOL, writable: true },
      { ref: user.inAta, writable: true },
      { ref: user.outAta, writable: true },
      { ref: refsFor('a-vault'), address: A_VAULT, writable: true },
      { ref: refsFor('b-vault'), address: B_VAULT, writable: true },
      { ref: refsFor('a-token-vault'), address: A_TOKEN_VAULT, writable: true },
      { ref: refsFor('b-token-vault'), address: B_TOKEN_VAULT, writable: true },
      { ref: refsFor('a-lp-mint'), address: A_LP_MINT, writable: true },
      { ref: refsFor('b-lp-mint'), address: B_LP_MINT, writable: true },
      { ref: refsFor('a-vault-lp'), address: A_VAULT_LP, writable: true },
      { ref: refsFor('b-vault-lp'), address: B_VAULT_LP, writable: true },
      { ref: refsFor('protocol-token-a-fee'), address: '4Qjrnzp5jXPSBhyv495ApB1SdDbXdZ5Pc9ZSiabf9NmJ', writable: true },
      { ref: user.owner, signer: true },
      { ref: 'damm1s:vault-program', address: '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi' },
      { ref: 'token-program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    ]);
  });

  it('rejects a non-u64 amountIn', async () => {
    const cfg = await fetchConfig();
    expect(() => meteoraDammV1Stable.buildSwap(cfg, user, -1n)).toThrow(
      'meteora-damm-v1-stable buildSwap amountIn must be a positive u64, got -1',
    );
  });

  function refsFor(name: string): string {
    return `damm1s:${POOL}:${name}`;
  }
});

describe('meteora-damm-v1-stable LADDER idle-float CAPACITY — collapse-to-zero fixed to a freeze (types.ts capacityInputVar contract)', () => {
  // State with b_token_vault's SPL amount (u64 LE @ TOKEN_AMOUNT offset 64)
  // overridden — the out-side idle float the strict bound reads.
  function withIdleFloat(base: AccountBytesMap, idle: bigint): AccountBytesMap {
    const data = new Uint8Array(base[B_TOKEN_VAULT]);
    new DataView(data.buffer).setBigUint64(64, idle, true);
    return { ...base, [B_TOKEN_VAULT]: data };
  }

  function ladderGrid(amountIn: bigint, rungs: number): bigint[] {
    const grid: bigint[] = [];
    for (let j = 1; j <= rungs; j++) grid.push(amountIn >> BigInt(rungs - j));
    return grid;
  }

  it('the CHECKED-IN fixture never reaches the idle-float bound at all (its idle float, 959036927046, happens to exceed the curve\'s own asymptotic max, ~861412784533) — this is WHY every pre-fix test passed for an accidental reason, not because the collapse was absent', async () => {
    const cfg = await fetchConfig();
    const params = meteoraDammV1StableLadder.paramsFor(cfg);
    const quote = meteoraDammV1StableLadder.referenceQuote(cfg, state, params, CLOCK_T);
    expect(quote(1n << 63n)).toBe(861_412_784_533n);
    expect(quote((1n << 64n) - 1n)).toBe(861_412_784_533n); // same asymptote at u64::MAX — never climbs to idle
  });

  it('REGRESSION PIN: an ORDINARY idle float (500,000,000,000, well below that asymptote) puts the collapse at x=499,992,225,659 — a reachable, ordinary trade size, NOT an extreme one', async () => {
    const cfg = await fetchConfig();
    const doctored = withIdleFloat(state, 500_000_000_000n);
    const params = meteoraDammV1StableLadder.paramsFor(cfg);
    const quote = meteoraDammV1StableLadder.referenceQuote(cfg, doctored, params, CLOCK_T);
    const CLIFF = 499_992_225_659n;
    const PEAK = 499_999_999_998n;
    expect(quote(CLIFF)).toBe(PEAK);
    // The COLD, standalone quote still collapses past the boundary — the
    // DECLARED, merge-UNREACHABLE latent gap (see ladder.ts's module doc):
    // the ladder-chain path below never asks the cold quote for anything
    // past what it has already proven productive.
    expect(quote(CLIFF + 1n)).toBe(0n);
    expect(CLIFF < 1n << 64n).toBe(true); // merge-reachable domain (u64 cfg word)
  });

  it('capacityInputVar / referenceCapacities are wired (the merge-relevant path this fix adds)', async () => {
    expect(meteoraDammV1StableLadder.capacityInputVar).toBeDefined();
    expect(meteoraDammV1StableLadder.referenceCapacities).toBeDefined();
    expect(meteoraDammV1StableLadder.capacityInputVar!(7)).toBe('s7lx');
  });

  it('compiles as valid SauceScript (emitSetup + two ladder rungs + emitFinalQuote, target svm)', async () => {
    const cfg = await fetchConfig();
    const source = [
      ...meteoraDammV1StableLadder.helpers().map((h) => h.source),
      'function main() {',
      '  let s0en = 1;',
      meteoraDammV1StableLadder.emitSetup(cfg, 0, [], 's0en'),
      meteoraDammV1StableLadder.emitLadderQuote!(cfg, 0, 0, 's0g1', 's0o1'),
      meteoraDammV1StableLadder.emitLadderQuote!(cfg, 0, 1, '1000000000', 's0o2'),
      meteoraDammV1StableLadder.emitFinalQuote!(cfg, 0, '1000000000', 'qFinal'),
      '  return qFinal;',
      '}',
    ].join('\n');
    const sourceWithGrid = source.replace('function main() {', 'function main() {\n  const s0g1 = 500000000;');
    const { compile } = await import('@eco-incorp/sauce-compiler');
    const { bytecode } = compile(sourceWithGrid, { target: 'svm' });
    expect(bytecode[0].length).toBeGreaterThan(0);
  });

  it('the LADDER-CHAIN path (referenceLadderQuotes + referenceCapacities) FREEZES at the last productive checkpoint instead of collapsing — capacities pin the exact checkpoint at the cliff', async () => {
    const cfg = await fetchConfig();
    const doctored = withIdleFloat(state, 500_000_000_000n);
    const params = meteoraDammV1StableLadder.paramsFor(cfg);
    const CLIFF = 499_992_225_659n;
    const PEAK = 499_999_999_998n;
    const ladderQuotes = meteoraDammV1StableLadder.referenceLadderQuotes!(cfg, doctored, params, CLOCK_T);
    const capacities = meteoraDammV1StableLadder.referenceCapacities!(cfg, doctored, params, CLOCK_T);
    const [outAtCliff, outPastCliff] = ladderQuotes([CLIFF, CLIFF + 1n]);
    const [capAtCliff, capPastCliff] = capacities([CLIFF, CLIFF + 1n]);
    expect(outAtCliff).toBe(PEAK);
    expect(outPastCliff).toBe(PEAK); // FROZEN, not collapsed to 0
    expect(capAtCliff).toBe(CLIFF);
    expect(capPastCliff).toBe(CLIFF); // cumulative productive input frozen too — dIn folds to 0 past here
  });

  it('MERGE-ALTITUDE (the actual defect): differencing the pre-fix pointwise collapse across a ladder rung manufactured a NEGATIVE dOut — the post-fix capacity pair never does, across every rung straddling the cliff at 2/3/4 rungs', async () => {
    const cfg = await fetchConfig();
    const doctored = withIdleFloat(state, 500_000_000_000n);
    const params = meteoraDammV1StableLadder.paramsFor(cfg);
    const CLIFF = 499_992_225_659n;
    const sweep = [CLIFF - 1_000n, CLIFF, CLIFF + 1n, CLIFF + 1_000n, CLIFF * 2n, CLIFF * 10n, (1n << 64n) - 1n];
    const ladderQuotes = meteoraDammV1StableLadder.referenceLadderQuotes!(cfg, doctored, params, CLOCK_T);
    const capacities = meteoraDammV1StableLadder.referenceCapacities!(cfg, doctored, params, CLOCK_T);
    let sawNegative = false;
    for (const rungs of [2, 3, 4]) {
      for (const amountIn of sweep) {
        const grid = ladderGrid(amountIn, rungs);
        const outs = ladderQuotes(grid);
        const cins = capacities(grid);
        let cPrev = 0n;
        let oPrev = 0n;
        for (let i = 0; i < grid.length; i++) {
          const dIn = cins[i] - cPrev;
          const dOut = outs[i] - oPrev;
          if (dIn < 0n || dOut < 0n) sawNegative = true;
          cPrev = cins[i];
          oPrev = outs[i];
        }
      }
    }
    expect(sawNegative).toBe(false);
  });

  it('a WITHOUT-the-fix replay (the still-collapsing COLD quote, diffed pointwise per grid entry — exactly the pre-fix ladder-chain shape, which had no capacityInputVar and threaded warm y through the SAME collapsing formula) reproduces the historical NEGATIVE dOut at the SAME pinned cliff — proves the sweep above actually exercises the fixed mechanism, not passing vacuously', async () => {
    const cfg = await fetchConfig();
    const doctored = withIdleFloat(state, 500_000_000_000n);
    const params = meteoraDammV1StableLadder.paramsFor(cfg);
    const CLIFF = 499_992_225_659n;
    const coldQuote = meteoraDammV1StableLadder.referenceQuote(cfg, doctored, params, CLOCK_T);
    const amountIn = CLIFF * 2n; // straddles the cliff at the last (4th) rung
    const grid = ladderGrid(amountIn, 4);
    const outs = grid.map(coldQuote); // pointwise, still-collapsing — the pre-fix shape
    const cinsRaw = grid; // no capacityInputVar -> raw geometric span, the pre-fix shape
    let cPrev = 0n;
    let oPrev = 0n;
    let sawNegative = false;
    for (let i = 0; i < grid.length; i++) {
      const dIn = cinsRaw[i] - cPrev;
      const dOut = outs[i] - oPrev;
      if (dIn < 0n || dOut < 0n) sawNegative = true;
      cPrev = cinsRaw[i];
      oPrev = outs[i];
    }
    expect(sawNegative).toBe(true);
  });
});
