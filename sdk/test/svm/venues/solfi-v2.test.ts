/**
 * solfi-v2 adapter units (no engine, no RPC): pool/oracle decode + the XOR
 * keystream, the pinned mainnet worked examples (both directions), a
 * capacity/staleness gate, and the swap CPI account shape (13 accounts,
 * positional by mint). Fixtures are two REAL snapshots of mainnet pool
 * 65ZHSArs5XxPseKQbB1B4r16vDxMWnCxHMzogDAqiDUc (wSOL/USDC), one per trade
 * direction, captured seconds apart via live `simulateTransaction` batches —
 * `real` below is the venue's OWN on-chain output at that exact snapshot,
 * not a value derived from this adapter.
 *
 * All pinned expectations were verified by independently RE-RUNNING the
 * closed form (crack/quote.mjs, transcribed from the disassembly — see
 * ladder.ts's module doc) against fresh `simulateTransaction` calls at the
 * SAME slot the fixtures were captured at: 4/4 exact (0 wei of drift) across
 * both directions, plus a separate capacity sweep (not checked in as a
 * fixture — the account state would need a third snapshot) that reproduced
 * the venue's own saturate-then-Custom(18)-revert boundary exactly. The
 * emitted SauceScript fragment (emitSetup + emitLadderQuote + emitFinalQuote)
 * was additionally run end-to-end through the real committed SVM engine
 * (artifacts/svm/engine.so) against these exact fixture bytes and reproduced
 * every number below bit-for-bit, including the two capacity-edge points
 * (verified to return 0 rather than a wrapped/negative value) — that harness
 * lives outside this fast/no-engine suite (see the PR body for the numbers).
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import { solfiV2 } from '../../../src/svm/venues/solfi-v2/index.js';
import { solfiV2Ladder } from '../../../src/svm/venues/solfi-v2/ladder.js';
import type { SolfiV2PoolConfig } from '../../../src/svm/venues/solfi-v2/index.js';
import type { AccountLoader } from '../../../src/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const POOL = address('65ZHSArs5XxPseKQbB1B4r16vDxMWnCxHMzogDAqiDUc');
const ORACLE = '2ny7eGyZCoeEVTkNLf5HcnJFBKkyA4p4gcrtb3b8y8ou';
const VAULT_A = 'CRo8DBwrmd97DJfAnvCv96tZPL5Mktf2NZy2ZnhDer1A'; // wSOL
const VAULT_B = 'GhFfLFSprPpfoRaWakPMmJTMJBHuz6C694jYwxy2dAic'; // USDC
const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REGISTRY = 'FmxXDSR9WvpJTCh738D1LEDuhMoA8geCtZgHb3isy7Dp';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// A synthetic (zero-filled, correctly-sized) registry: fetchPoolConfig only
// gates on its SIZE and its address (to resolve K from the static
// REGISTRY_K map) — the real 1 MiB registry's bytes are never checked in
// (see CLAUDE.md's "dumped venue binaries are never committed"; the
// registry is a plain account, not a binary, but it is large and its
// content-derived K constant is NOT re-derived by this adapter — see
// ladder.ts's "residualRisk" doc).
const SYNTHETIC_REGISTRY = new Uint8Array(1_048_576);

function loaderFor(dir: 'dir0' | 'dir1'): AccountLoader {
  const fixtures = loadFixtures(resolve(process.cwd(), `test/svm/fixtures/solfi-v2-${dir}`));
  const base = fixtureLoader(fixtures);
  return async (addr) => {
    if (addr === REGISTRY) return SYNTHETIC_REGISTRY;
    return base(addr);
  };
}

function stateFor(dir: 'dir0' | 'dir1') {
  const fixtures = loadFixtures(resolve(process.cwd(), `test/svm/fixtures/solfi-v2-${dir}`));
  return fixtureBytesMap(fixtures);
}

describe('solfi-v2 fetchPoolConfig', () => {
  it('decodes the mainnet pool account (dir0 snapshot)', async () => {
    const cfg = (await solfiV2.fetchPoolConfig(loaderFor('dir0'), POOL, 0)) as SolfiV2PoolConfig;
    expect(cfg.venue).toBe('solfi-v2');
    expect(cfg.direction).toBe(0);
    expect(cfg.oracle).toBe(ORACLE);
    expect(cfg.vaultA).toBe(VAULT_A);
    expect(cfg.vaultB).toBe(VAULT_B);
    expect(cfg.mintA).toBe(MINT_A);
    expect(cfg.mintB).toBe(MINT_B);
    expect(cfg.registry).toBe(REGISTRY);
    expect(cfg.tokenProgram).toBe(TOKEN_PROGRAM);
    expect(cfg.registryK).toBe(1932n);
  });

  it('throws when the pool account does not exist', async () => {
    const empty: AccountLoader = async () => null;
    await expect(solfiV2.fetchPoolConfig(empty, POOL, 0)).rejects.toThrow(`solfi-v2 pool ${POOL} account not found`);
  });

  it('gates on the pool account size', async () => {
    const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/solfi-v2-dir0'));
    const base = fixtureLoader(fixtures);
    const truncating: AccountLoader = async (addr) => {
      if (addr === POOL) {
        const data = await base(addr);
        return data === null ? null : data.subarray(0, 100);
      }
      return addr === REGISTRY ? SYNTHETIC_REGISTRY : base(addr);
    };
    await expect(solfiV2.fetchPoolConfig(truncating, POOL, 0)).rejects.toThrow(
      `solfi-v2 pool ${POOL} account is 100 bytes, expected 1728`,
    );
  });

  it('rejects an unrecognized registry (no proven/disclosed K)', async () => {
    const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/solfi-v2-dir0'));
    const base = fixtureLoader(fixtures);
    const doctored: AccountLoader = async (addr) => {
      if (addr === POOL) {
        const data = await base(addr);
        if (data === null) return null;
        const copy = new Uint8Array(data);
        copy.fill(0, 256, 288); // zero out the registry pubkey field
        return copy;
      }
      return addr === REGISTRY ? SYNTHETIC_REGISTRY : base(addr);
    };
    await expect(solfiV2.fetchPoolConfig(doctored, POOL, 0)).rejects.toThrow(/unrecognized registry/);
  });
});

describe('solfi-v2 referenceQuote — pinned mainnet worked examples', () => {
  it('dir0 (wSOL -> USDC): 2 SOL -> 148944767 USDC base units', () => {
    const cfg: SolfiV2PoolConfig = {
      venue: 'solfi-v2',
      pool: POOL,
      direction: 0,
      mintA: address(MINT_A),
      mintB: address(MINT_B),
      vaultA: address(VAULT_A),
      vaultB: address(VAULT_B),
      oracle: address(ORACLE),
      registry: address(REGISTRY),
      tokenProgram: address(TOKEN_PROGRAM),
      registryK: 1932n,
    };
    const state = stateFor('dir0');
    const q = solfiV2Ladder.referenceQuote(cfg, state, [1932n], 436_250_364n);
    expect(q(2_000_000_000n)).toBe(148_944_767n);
    expect(q(50_000_000_000n)).toBe(3_722_911_187n);
    expect(q(0n)).toBe(0n);
  });

  it('dir1 (USDC -> wSOL): 300 USDC -> 4026330185 lamports', () => {
    const cfg: SolfiV2PoolConfig = {
      venue: 'solfi-v2',
      pool: POOL,
      direction: 1,
      mintA: address(MINT_A),
      mintB: address(MINT_B),
      vaultA: address(VAULT_A),
      vaultB: address(VAULT_B),
      oracle: address(ORACLE),
      registry: address(REGISTRY),
      tokenProgram: address(TOKEN_PROGRAM),
      registryK: 1932n,
    };
    const state = stateFor('dir1');
    const q = solfiV2Ladder.referenceQuote(cfg, state, [1932n], 436_250_365n);
    expect(q(300_000_000n)).toBe(4_026_330_185n);
    expect(q(5_000_000_000n)).toBe(67_061_523_744n);
  });

  it('deactivates (returns 0) once block.number passes the oracle expirySlot', () => {
    const cfg: SolfiV2PoolConfig = {
      venue: 'solfi-v2',
      pool: POOL,
      direction: 0,
      mintA: address(MINT_A),
      mintB: address(MINT_B),
      vaultA: address(VAULT_A),
      vaultB: address(VAULT_B),
      oracle: address(ORACLE),
      registry: address(REGISTRY),
      tokenProgram: address(TOKEN_PROGRAM),
      registryK: 1932n,
    };
    const state = stateFor('dir0');
    // Far past any real expirySlot (~slot+200) -> stale -> deactivated.
    const q = solfiV2Ladder.referenceQuote(cfg, state, [1932n], 999_999_999_999n);
    expect(q(2_000_000_000n)).toBe(0n);
  });
});

describe('solfi-v2 capacityInputVar / referenceLadderQuotes — saturates, never collapses', () => {
  it('is nondecreasing, quote(0) = 0, and never negative/huge-wrapped across an escalating grid', () => {
    const cfg: SolfiV2PoolConfig = {
      venue: 'solfi-v2',
      pool: POOL,
      direction: 0,
      mintA: address(MINT_A),
      mintB: address(MINT_B),
      vaultA: address(VAULT_A),
      vaultB: address(VAULT_B),
      oracle: address(ORACLE),
      registry: address(REGISTRY),
      tokenProgram: address(TOKEN_PROGRAM),
      registryK: 1932n,
    };
    const state = stateFor('dir0');
    const grid = [0n, 1_000_000_000n, 10_000_000_000n, 100_000_000_000n, 10_000_000_000_000n, 1_000_000_000_000_000n];
    const quotes = solfiV2Ladder.referenceLadderQuotes!(cfg, state, [1932n], 436_250_364n)(grid);
    const caps = solfiV2Ladder.referenceCapacities!(cfg, state, [1932n], 436_250_364n)(grid);
    expect(quotes[0]).toBe(0n);
    for (let i = 1; i < quotes.length; i++) {
      expect(quotes[i]).toBeGreaterThanOrEqual(quotes[i - 1]);
      expect(quotes[i]).toBeGreaterThanOrEqual(0n);
      expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
      expect(caps[i]).toBeLessThanOrEqual(grid[i]);
    }
  });
});

describe('solfi-v2 buildSwap / buildSwapV2 — CPI account shape', () => {
  const user = { inAta: 'user:in', outAta: 'user:out', owner: 'user:owner' };

  it('builds the 13-account, 18-byte swap ix (disc 0x07)', async () => {
    const cfg = (await solfiV2.fetchPoolConfig(loaderFor('dir0'), POOL, 0)) as SolfiV2PoolConfig;
    const swap = solfiV2.buildSwap(cfg, user, 2_000_000_000n);
    expect(swap.data.length).toBe(18);
    expect(swap.data[0]).toBe(0x07);
    expect(swap.data[17]).toBe(0); // direction
    expect(swap.accounts).toHaveLength(13);
    expect(swap.accounts[0]).toMatchObject({ ref: 'user:owner', signer: true });
    expect(swap.accounts[2]).toMatchObject({ address: ORACLE });
    // dir 0: mintA (wSOL) is the SOURCE -> userA = inAta (POSITIONAL BY MINT).
    expect(swap.accounts[6]).toMatchObject({ ref: 'user:in' });
    expect(swap.accounts[7]).toMatchObject({ ref: 'user:out' });
    expect(swap.accounts[12]).toMatchObject({ ref: 'Sysvar1nstructions1111111111111111111111111' });
  });

  it('buildSwapV2 patches the amount in-place (patch: "in") with a runtime-patchable template', async () => {
    const cfg = (await solfiV2.fetchPoolConfig(loaderFor('dir1'), POOL, 1)) as SolfiV2PoolConfig;
    const tmpl = solfiV2Ladder.buildSwapV2(cfg, 0, user);
    expect(tmpl.patch).toBe('in');
    expect(tmpl.prefix).toEqual(Uint8Array.from([0x07]));
    expect(tmpl.suffix).toEqual(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 1]));
    expect(tmpl.accounts).toHaveLength(13);
    // dir 1: mintB (USDC) is the SOURCE -> userB = inAta.
    expect(tmpl.accounts[7]).toMatchObject({ ref: 'user:in' });
    expect(tmpl.accounts[6]).toMatchObject({ ref: 'user:out' });
  });
});
