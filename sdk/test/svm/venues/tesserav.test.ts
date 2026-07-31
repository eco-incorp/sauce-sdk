/**
 * TesseraV conservativeness pin — the adapter's off-chain quote vs. the
 * DEPLOYED program, replayed in LiteSVM against the checked-in fixture (the
 * real SOL/USDC pool `FLckHLGMJy5gEoXWwcE68Nprde1D4araK4TGLw4pQq2n`, one
 * frozen mainnet snapshot).
 *
 * Every `measured` vector below is the REAL amountOut a real `sendTransaction`
 * produced in LiteSVM at the fixture's own pinned slot, loading the ACTUAL
 * deployed TesseraV binary (`TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH`)
 * plus the ACTUAL deployed Jupiter aggregator binary
 * (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`) — the real `route`
 * instruction, decoded and replayed with the amount patched, exactly the CPI
 * shape ./ladder.ts's header documents. This is NOT a claim of bit-exactness
 * (see ladder.ts's header for why): the adapter is an EMPIRICALLY CALIBRATED
 * model with a deliberate 20 bps safety haircut, so the assertion here is the
 * safety property this SDK actually needs — the quote never exceeds the real
 * venue's output — not lamport equality.
 *
 * Regenerate the fixture + vectors with a fresh LiteSVM replay (real mainnet
 * RPC, real program dumps) rather than hand-editing either.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import { fetchTesseraVConfig, tesseravLadder } from '../../../src/svm/index.js';
import type { TesseraVPoolConfig } from '../../../src/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/tesserav');
const POOL = address('FLckHLGMJy5gEoXWwcE68Nprde1D4araK4TGLw4pQq2n');

// Measured against the deployed binaries at this fixture's own frozen slot —
// see the file header. [amountIn, realAmountOut] (both raw units: mintA =
// wSOL, 9dp; mintB = USDC, 6dp).
const MEASURED_A_TO_B: [string, string][] = [
  ['1000000', '73119'],
  ['10000000', '731199'],
  ['100000000', '7311999'],
  ['500000000', '36559997'],
  ['1000000000', '73119995'],
  ['5000000000', '365599976'],
  ['10000000000', '731199952'],
  ['50000000000', '3655942351'],
  ['100000000000', '7311791091'],
];

/** Real per-CPI compute measured across every replay in this pass (Jupiter-mediated and direct-CPI-passthrough alike): 46,908-59,767 CU. */
const MEASURED_CU_MAX = 59_767;

async function loadConfig(): Promise<{ cfg: TesseraVPoolConfig; state: ReturnType<typeof fixtureBytesMap> }> {
  const fixtures = loadFixtures(FIXTURES);
  const cfg = (await fetchTesseraVConfig(fixtureLoader(fixtures), POOL, 'aToB')) as TesseraVPoolConfig;
  return { cfg, state: fixtureBytesMap(fixtures) };
}

describe('tesserav ladder', () => {
  test('fetchPoolConfig decodes the real fixture', async () => {
    const { cfg } = await loadConfig();
    expect(cfg.venue).toBe('tesserav');
    expect(cfg.direction).toBe('aToB');
    expect(cfg.mintA).toBe('So11111111111111111111111111111111111111112');
    expect(cfg.mintB).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  test('bToA is a hard gate (unverified account order — see index.ts/ladder.ts)', async () => {
    const fixtures = loadFixtures(FIXTURES);
    await expect(fetchTesseraVConfig(fixtureLoader(fixtures), POOL, 'bToA')).rejects.toThrow(/unverified/);
  });

  test('referenceQuote never exceeds the real deployed program\'s output, at every measured size', async () => {
    const { cfg, state } = await loadConfig();
    const quote = tesseravLadder.referenceQuote(cfg, state, tesseravLadder.paramsFor(cfg));
    for (const [inStr, outStr] of MEASURED_A_TO_B) {
      const x = BigInt(inStr);
      const realOut = BigInt(outStr);
      const modelOut = quote(x);
      expect(modelOut <= realOut).toBe(true);
      // The haircut is 20 bps (SAFETY_NUM/SAFETY_DEN = 998/1000): the model
      // should track the real venue closely, not just trivially undershoot.
      // Loose bound (50 bps) to stay robust to the mid/price drifting between
      // this fixture's capture and any future re-capture of the SAME pool.
      const shortfallBps = ((realOut - modelOut) * 10_000n) / realOut;
      expect(shortfallBps <= 50n).toBe(true);
    }
  });

  test('quote(0) === 0 and the quote is nondecreasing (the merge-solver premise)', async () => {
    const { cfg, state } = await loadConfig();
    const quote = tesseravLadder.referenceQuote(cfg, state, tesseravLadder.paramsFor(cfg));
    expect(quote(0n)).toBe(0n);
    let prevOut = 0n;
    let prevX = 0n;
    for (const [inStr] of MEASURED_A_TO_B) {
      const x = BigInt(inStr);
      const out = quote(x);
      expect(out >= prevOut).toBe(true);
      expect(x > prevX).toBe(true);
      prevOut = out;
      prevX = x;
    }
  });

  test('capacity clamp saturates rather than reverting far past level-0', async () => {
    const { cfg, state } = await loadConfig();
    const params = tesseravLadder.paramsFor(cfg);
    const quote = tesseravLadder.referenceQuote(cfg, state, params);
    const { reserveIn } = tesseravLadder.depthReserves(cfg, state);
    const past = reserveIn * 1000n + 1n;
    const atCap = quote(reserveIn);
    const pastCap = quote(past);
    expect(pastCap).toBe(atCap); // saturates — never a cliff/collapse.
  });

  test('referenceCapacities mirrors the capacity clamp over an ordered grid', async () => {
    const { cfg, state } = await loadConfig();
    const params = tesseravLadder.paramsFor(cfg);
    const { reserveIn } = tesseravLadder.depthReserves(cfg, state);
    const grid = [reserveIn / 4n, reserveIn / 2n, reserveIn, reserveIn * 2n, reserveIn * 1000n];
    const caps = tesseravLadder.referenceCapacities!(cfg, state, params)(grid);
    expect(caps[0]).toBeLessThanOrEqual(reserveIn);
    expect(caps[caps.length - 1]).toBe(reserveIn);
    for (let i = 1; i < caps.length; i++) expect(caps[i] >= caps[i - 1]).toBe(true);
  });

  test('shapeKey is direction-scoped; rungs ride the CP default (the flat-rate model is exact at any rung count)', async () => {
    const { cfg } = await loadConfig();
    expect(tesseravLadder.shapeKey(cfg)).toBe('tesserav:aToB');
    expect(tesseravLadder.defaultRungs).toBeUndefined();
  });

  test('the real per-CPI CU this pass measured stays under the CU_FAMILIES budget the recipe wires (documentation pin, not a live measurement)', () => {
    // See recipes/ecoswap/svm/budget.ts's tesserav entry — it must exceed this.
    expect(MEASURED_CU_MAX).toBeLessThan(70_000);
  });
});
