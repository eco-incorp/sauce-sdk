/**
 * Manifest ladder adapter units (no engine, no RPC): a REGRESSION PIN for the
 * quoteIn arithmetic-safety collapse fixed in ladder.ts (see its header for
 * the full derivation) — a shipped ask level whose price is low enough that
 * `manifestBaseForQuote` (base_limit = floor(1e18*remaining/price)) overflows
 * u64 at an ORDINARY (not astronomical) remaining. Before the fix, crossing
 * that boundary made the ENTIRE walk `break` with nothing, so a LARGER grid
 * point quoted LESS than a smaller one — the collapse the merge-altitude
 * contract (every quote closure nondecreasing, quote(0)==0) forbids. After
 * the fix the walk SATURATES at the largest safe remaining instead.
 *
 * Pure synthetic single-level market (no mainnet fixture needed): the bug is
 * a property of the conversion arithmetic, not any particular book state.
 */
import { address } from '@solana/kit';
import { manifestLadder, manifestBaseForQuote, manifestBaseForQuoteSafeCap } from '../../../src/svm/venues/manifest/ladder.js';
import type { ManifestPoolConfig } from '../../../src/svm/venues/manifest/index.js';
import { MARKET_FIXED_SIZE, OFF_ORDER_PRICE, OFF_ORDER_SIZE, OFF_ORDER_SEQ } from '../../../src/svm/venues/manifest/index.js';
import type { AccountBytesMap } from '../../../src/svm/index.js';

const MARKET = address('ENhU8LsaR7BX5oHwEyMkbYCkMAT8pALZeimcCV7f3Kfc');
const DUMMY = address('So11111111111111111111111111111111111111112');

/** One-level synthetic market: order at DataIndex 0, price/size/seq patched in. */
function marketWithOrder(price: bigint, size: bigint, seq: bigint): Uint8Array {
  const data = new Uint8Array(MARKET_FIXED_SIZE + 128);
  const view = new DataView(data.buffer);
  const base = MARKET_FIXED_SIZE + 0; // DataIndex 0
  view.setBigUint64(base + OFF_ORDER_PRICE, price & ((1n << 64n) - 1n), true);
  view.setBigUint64(base + OFF_ORDER_PRICE + 8, price >> 64n, true); // u128 LE, high word
  view.setBigUint64(base + OFF_ORDER_SIZE, size, true);
  view.setBigUint64(base + OFF_ORDER_SEQ, seq, true);
  return data;
}

function quoteInCfg(): ManifestPoolConfig {
  return {
    venue: 'manifest',
    pool: MARKET,
    direction: 'quoteIn',
    baseMint: DUMMY,
    quoteMint: DUMMY,
    baseVault: DUMMY,
    quoteVault: DUMMY,
    baseDecimals: 9,
    quoteDecimals: 6,
    windows: { baseIn: { orders: [] }, quoteIn: { orders: [{ dataIndex: 0, sequenceNumber: 42n }] } },
  };
}

describe('manifestBaseForQuoteSafeCap', () => {
  it('is the largest remaining that does not overflow manifestBaseForQuote', () => {
    const price = 10n;
    const cap = manifestBaseForQuoteSafeCap(price);
    expect(manifestBaseForQuote(price, cap, false) <= (1n << 64n) - 1n).toBe(true);
    // String()-wrapped: see ladder-contract.test.ts's note on raw-bigint
    // .toBe() failures vanishing whole suites under jest workers (BigInt is
    // not JSON-serializable, and jest-worker's IPC to the parent uses JSON).
    expect(String(manifestBaseForQuote(price, cap + 1n, false))).toBe(String(1n << 65n)); // SENT
  });

  it('is unbounded (SENT sentinel) for a zero price — manifestBaseForQuote always returns 0 there', () => {
    expect(String(manifestBaseForQuoteSafeCap(0n))).toBe(String(1n << 65n));
    expect(String(manifestBaseForQuote(0n, 10_000_000_000n, false))).toBe(String(0n));
  });
});

describe('quoteIn arithmetic-safety cliff (the collapse fix)', () => {
  // A deliberately low-priced ask (inner=10, i.e. a vanishingly small real
  // price) whose base_limit conversion overflows u64 at remaining=234 but not
  // at remaining=100 — and whose own size (just above the value the
  // conversion reaches at the largest safe remaining) means it can NEVER be
  // fully matched without overflowing: the genuine arithmetic-safety cliff,
  // not an ordinary full match reached early.
  const price = 10n;
  const cap = manifestBaseForQuoteSafeCap(price); // 184
  const blAtCap = manifestBaseForQuote(price, cap, false); // 18_400_000_000_000_000_000
  const size = blAtCap + 1000n; // just above — never fully matches even at the cap
  const seq = 42n;

  function refQuote(): (x: bigint) => bigint {
    const cfg = quoteInCfg();
    const state: AccountBytesMap = { [MARKET]: marketWithOrder(price, size, seq) };
    const params: bigint[] = [1n, 0n, seq];
    return manifestLadder.referenceQuote(cfg, state, params);
  }

  function refCapacities(): (grid: readonly bigint[]) => bigint[] {
    const cfg = quoteInCfg();
    const state: AccountBytesMap = { [MARKET]: marketWithOrder(price, size, seq) };
    const params: bigint[] = [1n, 0n, seq];
    return manifestLadder.referenceCapacities!(cfg, state, params);
  }

  it('sanity: cap sits strictly between the two probed grid points (100 < 184 < 234)', () => {
    // String()-wrapped: see ladder-contract.test.ts's note on raw-bigint
    // .toBe() failures vanishing whole suites under jest workers.
    expect(String(cap)).toBe(String(184n));
    expect(100n < cap).toBe(true);
    expect(cap < 234n).toBe(true);
  });

  it('saturates instead of collapsing: quote(234) >= quote(100), never a lower value at a larger x', () => {
    const quote = refQuote();
    const outSmall = quote(100n);
    const outLarge = quote(234n);
    expect(outSmall).toBeGreaterThan(0n);
    expect(outLarge).toBeGreaterThanOrEqual(outSmall);
    // Saturates exactly at the cap's own output — going past the arithmetic
    // boundary buys nothing more from this level.
    expect(String(outLarge)).toBe(String(blAtCap));
  });

  it('referenceCapacities is nondecreasing across the same two points (never a negative dIn)', () => {
    const capacities = refCapacities();
    const [cSmall, cLarge] = capacities([100n, 234n]);
    expect(String(cSmall)).toBe(String(100n));
    expect(String(cLarge)).toBe(String(cap)); // saturates the PRODUCTIVE input at the safety cap
    expect(cLarge).toBeGreaterThanOrEqual(cSmall);
  });

  it('quote(0) == 0', () => {
    expect(String(refQuote()(0n))).toBe(String(0n));
  });

  it('REGRESSION: reproduces the pre-fix collapse shape via the raw (unpatched) arithmetic — proves the bug was real', () => {
    // The pre-fix walk computed bl unconditionally at the FULL remaining and
    // broke with nothing the moment it overflowed — exactly what the old
    // `if (bl >= SENT) break` (no cap, no saturation) did.
    const oldWalk = (x: bigint): { out: bigint; consumed: bigint } => {
      if (x <= 0n) return { out: 0n, consumed: 0n };
      const bl = manifestBaseForQuote(price, x, false);
      if (bl >= 1n << 65n) return { out: 0n, consumed: 0n }; // the old unconditional break
      if (bl >= size) return { out: size, consumed: x };
      return { out: bl, consumed: x };
    };
    const small = oldWalk(100n);
    const large = oldWalk(234n);
    expect(small.out).toBeGreaterThan(0n);
    // String()-wrapped: see ladder-contract.test.ts's note on raw-bigint
    // .toBe() failures vanishing whole suites under jest workers.
    expect(String(large.out)).toBe(String(0n)); // the collapse
    expect(large.out).toBeLessThan(small.out); // dOut < 0 across this pair — the merge-altitude violation
    expect(large.consumed).toBeLessThan(small.consumed); // dIn < 0 too
  });
});
