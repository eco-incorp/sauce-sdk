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
import { address, getAddressCodec } from '@solana/kit';
import type { Address } from '@solana/kit';
import { solfiV2, OFF_MINT_A, OFF_MINT_B, OFF_VAULT_A, OFF_VAULT_B, OFF_ORACLE, OFF_REGISTRY } from '../../../src/svm/venues/solfi-v2/index.js';
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
    expect(cfg.additiveK).toBe(1932n);
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

  it('rejects a pool whose additive-impact K has never been independently verified', async () => {
    const UNVERIFIED = address('11111111111111111111111111111112');
    const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/solfi-v2-dir0'));
    const base = fixtureLoader(fixtures);
    // Relabel the REAL, well-formed pool bytes under an address POOL_K has no
    // entry for — the pool data itself is fine; only its address (hence K) is
    // unverified. Never falls back to a registry-mate's K (see below).
    const relabeled: AccountLoader = async (addr) => {
      if (addr === UNVERIFIED) return base(POOL);
      return addr === REGISTRY ? SYNTHETIC_REGISTRY : base(addr);
    };
    await expect(solfiV2.fetchPoolConfig(relabeled, UNVERIFIED, 0)).rejects.toThrow(
      `solfi-v2 pool ${UNVERIFIED} has no independently-verified additive-impact constant K`,
    );
  });
});

describe('per-pool K resolution — the FATAL registry-keyed bug (fixed)', () => {
  // Registry QoFvFhDZg9TaZEi4SsasWpH5xXzk3zBqfRyicGexfNQ carries (at least) two
  // live pools with DIFFERENT, independently-verified K: FkEB6uvy... (USDT/USDC)
  // needs K=0, 2Q6S8p9i... needs K=5832. The pre-fix table (90f9c3f) was keyed
  // by REGISTRY and had exactly one entry for this registry (5832), so BOTH
  // pools resolved to 5832 — the USDT/USDC pool was systematically wrong by
  // 5832 units of 1e-7 impact. No real fixture exists for either pool (they
  // are not the wSOL/USDC fixture this file otherwise uses), so these cases
  // synthesize a minimal, correctly-sized pool account pointing at that
  // registry — enough to reach the K resolution step (fetchPoolConfig throws
  // or resolves before reading anything else).
  const QOFVFHDZ_REGISTRY = address('QoFvFhDZg9TaZEi4SsasWpH5xXzk3zBqfRyicGexfNQ');
  const USDT_USDC_POOL = address('FkEB6uvyzuoaGpgs4yRtFtxC4WJxhejNFbUkj5R6wR32');
  const OTHER_POOL_SAME_REGISTRY = address('2Q6S8p9iZNzMvpTemiC56HqCJ3F3szNoyRkvqEKfCanY');

  function syntheticPoolBytes(registry: Address): Uint8Array {
    const data = new Uint8Array(1728);
    const codec = getAddressCodec();
    const put = (offset: number, addr: Address): void => data.set(new Uint8Array(codec.encode(addr)), offset);
    put(OFF_ORACLE, address(ORACLE));
    put(OFF_MINT_A, address(MINT_A));
    put(OFF_MINT_B, address(MINT_B));
    put(OFF_VAULT_A, address(VAULT_A));
    put(OFF_VAULT_B, address(VAULT_B));
    put(OFF_REGISTRY, registry);
    return data;
  }

  function loaderFor(pool: Address, poolBytes: Uint8Array): AccountLoader {
    const base = fixtureLoader(loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/solfi-v2-dir0')));
    return async (addr) => {
      if (addr === pool) return poolBytes;
      if (addr === QOFVFHDZ_REGISTRY) return SYNTHETIC_REGISTRY;
      return base(addr);
    };
  }

  it('REGRESSION (fails on the pre-fix registry-keyed lookup, 90f9c3f): FkEB6uvy (USDT/USDC) resolves its OWN verified K=0, not its registry-mate 2Q6S8p9i\'s 5832', async () => {
    const cfg = await solfiV2.fetchPoolConfig(loaderFor(USDT_USDC_POOL, syntheticPoolBytes(QOFVFHDZ_REGISTRY)), USDT_USDC_POOL, 0);
    expect(cfg.additiveK).toBe(0n);
  });

  it('the OTHER pool on the same registry independently resolves its own verified K=5832', async () => {
    const cfg = await solfiV2.fetchPoolConfig(
      loaderFor(OTHER_POOL_SAME_REGISTRY, syntheticPoolBytes(QOFVFHDZ_REGISTRY)),
      OTHER_POOL_SAME_REGISTRY,
      0,
    );
    expect(cfg.additiveK).toBe(5832n);
  });

  it('an UNVERIFIED pool on that same registry is REFUSED, not silently given a registry-mate\'s K', async () => {
    const UNVERIFIED = address('11111111111111111111111111111112');
    await expect(
      solfiV2.fetchPoolConfig(loaderFor(UNVERIFIED, syntheticPoolBytes(QOFVFHDZ_REGISTRY)), UNVERIFIED, 0),
    ).rejects.toThrow(`solfi-v2 pool ${UNVERIFIED} has no independently-verified additive-impact constant K`);
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
      additiveK: 1932n,
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
      additiveK: 1932n,
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
      additiveK: 1932n,
    };
    const state = stateFor('dir0');
    // Far past any real expirySlot (~slot+200) -> stale -> deactivated.
    const q = solfiV2Ladder.referenceQuote(cfg, state, [1932n], 999_999_999_999n);
    expect(q(2_000_000_000n)).toBe(0n);
  });
});

describe('solfi-v2 capacityInputVar / referenceLadderQuotes — saturates, never collapses', () => {
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
    additiveK: 1932n,
  };

  it('is nondecreasing, quote(0) = 0, and never negative/huge-wrapped across an escalating grid', () => {
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

  // REGRESSION (fails pre-fix): the previous grid topped out at 1e15, well
  // below this pool's ~1.65e12*~15 = ~2.5e13 impact/110% revert boundary --
  // vacuously "monotone" because it never actually reached the collapse.
  // This grid (powers of 2 to 2^60, matching the audit's own methodology)
  // crosses that boundary: pre-fix, referenceLadderQuotes/referenceCapacities
  // latched on `solfiRawQuote(...) === null` and recorded NOTHING, so both
  // arrays dropped straight to a frozen value well below the true cap the
  // moment the grid stepped past it (measured pre-fix: quotes/caps at 2^45
  // and beyond all sat at whatever the LAST sub-2^44 grid point achieved,
  // never reflecting the venue's real ~1.64e12-output capacity). Post-fix,
  // both bump-then-latch to (satOut, satCap) and STAY there.
  it('REGRESSION: referenceLadderQuotes/referenceCapacities do not freeze below the true saturation point once the grid crosses the 110%-of-vault boundary', () => {
    const state = stateFor('dir0');
    const grid = Array.from({ length: 31 }, (_, i) => 1n << BigInt(30 + i)); // 2^30 .. 2^60
    const quotes = solfiV2Ladder.referenceLadderQuotes!(cfg, state, [1932n], 436_250_364n)(grid);
    const caps = solfiV2Ladder.referenceCapacities!(cfg, state, [1932n], 436_250_364n)(grid);
    for (let i = 1; i < quotes.length; i++) {
      expect(quotes[i]).toBeGreaterThanOrEqual(quotes[i - 1]);
      expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
    }
    // The tail must plateau at the setup-computed satOut/satCap, not freeze
    // at some earlier, smaller sub-boundary grid point (the exact collapse
    // this regression guards).
    const last = quotes.length - 1;
    expect(quotes[last]).toBe(1_639_878_705_876n);
    expect(quotes[last]).toBe(quotes[last - 1]); // plateaued, not still climbing
    expect(quotes[last]).toBeGreaterThan(0n);
    expect(caps[last]).toBeGreaterThan(0n);
  });
});

describe('solfi-v2 referenceQuote — no longer collapses to 0 past the 110%-of-vault boundary', () => {
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
    additiveK: 1932n,
  };

  // REGRESSION (fails pre-fix): solfiColdQuote used to map `solfiRawQuote(...)
  // === null` straight to 0n (`r ?? 0n`) -- an unbounded collapse for EVERY x
  // past the venue's 110%-of-vault boundary, violating solver-reference.ts's
  // "nondecreasing in x" contract outright (q(2^45) = 0 while q(2^44) =
  // 1,300,298,808,776 on the real mainnet fixture below). Post-fix it plateaus
  // at satOut (a closed-form, provably-safe UNDER-estimate of the vault's
  // true balance -- see ladder.ts's module doc; NOT the vault balance itself).
  it('plateaus at satOut instead of collapsing, for x arbitrarily far past the boundary', () => {
    const state = stateFor('dir0');
    const q = solfiV2Ladder.referenceQuote(cfg, state, [1932n], 436_250_364n);
    const SAT_OUT = 1_639_878_705_876n;
    expect(q(1n << 45n)).toBe(SAT_OUT);
    expect(q(1n << 60n)).toBe(SAT_OUT);
    expect(q((1n << 100n) + 12345n)).toBe(SAT_OUT);
    // 2^44 is still organically below the boundary (the real closed-form
    // output, not yet needing the satOut fallback at all) -- pinned exact.
    expect(q(1n << 44n)).toBe(1_300_298_808_776n);
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

describe('FRAGMENT/REFERENCE PARITY — the emitted SauceScript now has a staleness gate (fixed)', () => {
  // REGRESSION: pre-fix (90f9c3f), emitSetup decoded s{slot}expSlot but never
  // compared it to s{slot}slot (block.number) anywhere in the emitted source —
  // only the TS reference (liveState's `if (slot > expSlot) return null`) had
  // the check. A rung/final quote past oracle expiry (where the real program
  // reverts Custom(23)) was predicted as an ordinary positive fill on-chain
  // instead of deactivating.
  it('emitSetup\'s source contains the staleness comparison the reference has always had', () => {
    const source = solfiV2Ladder.emitSetup({ venue: 'solfi-v2', direction: 0 } as SolfiV2PoolConfig, 0, ['0']);
    expect(source).toMatch(/s0slot\s*>\s*s0expSlot/);
  });

  it('compiles as valid SauceScript (emitSetup + one ladder rung + emitFinalQuote)', async () => {
    const { compile } = await import('@eco-incorp/sauce-compiler');
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
      additiveK: 1932n,
    };
    const params = solfiV2Ladder.paramsFor(cfg).map((v) => v.toString());
    const source = [
      ...solfiV2Ladder.helpers().map((h) => h.source),
      'function main() {',
      '  let s0en = 1;',
      solfiV2Ladder.emitSetup(cfg, 0, params),
      solfiV2Ladder.emitLadderQuote!(cfg, 0, 0, '1000000000', 's0o1'),
      solfiV2Ladder.emitFinalQuote!(cfg, 0, '1000000000', 'qFinal'),
      '  return qFinal;',
      '}',
    ].join('\n');
    const { bytecode } = compile(source, { target: 'svm' });
    expect(bytecode[0].length).toBeGreaterThan(0);
  });
});
