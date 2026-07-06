/**
 * EcoSwapSVM 2-hop route e2e on the REAL engine (LiteSVM): the
 * compute-exec-compute-exec chain landed in ONE atomic execute_from_account
 * instruction, lamport-exact against the composed routeReference mirror.
 *
 * A route A → X → B: leg-0 splits `amountIn` across its pool set (credits X
 * into the user's intermediate ATA), the instruction READS the realized
 * intermediate delta, leg-1 splits that realized X across its own pool set
 * (credits B into the user's out ATA), and one terminal realizedB ≥ minOut
 * guards the whole thing. Because per leg-0 venue predicted == realized (the
 * single-hop quadrilateral gate), the on-chain realizedX == Σ leg-0 predicted
 * == the oracle's intermediate, so the two leg-1 grids coincide and the whole
 * result is bit-for-bit reproducible.
 *
 * Stand-in CPIs (SPL-transfer) model the two token flows:
 *  - FAITHFUL-output stand-ins (cells a–d, f, g): leg-0 credits the
 *    intermediate ATA the slot's PREDICTED X (patch 'out') from a source vault;
 *    leg-1 credits the out ATA the PREDICTED B — so realizedX == oracle
 *    intermediate AND realizedB == oracle totalOut (the strongest gate). Under
 *    stand-ins the intermediate ATA is credited by leg-0 and not drained by
 *    leg-1 (a stand-in artifact — a real venue consumes it; see cell e).
 *  - CUSTODY/net-zero stand-ins (cell e): a degenerate A → X → X route (out
 *    mint == intermediate mint) whose leg-1 stand-in PULLS the input slice from
 *    the intermediate ATA (patch 'in') into the out ATA — draining it exactly,
 *    so the intermediate net delta across the instruction is 0 (dust
 *    absorption), the production leg-1 invariant.
 * The real-binary route quadrilateral (both legs real venue binaries) is the
 * env-gated cell h.
 *
 * Requires the engine .so; skips cleanly when absent.
 */
import { lamports } from '@solana/kit';
import type { Address, AddressesByLookupTableAddress } from '@solana/kit';
import { FailedTransactionMetadata } from 'litesvm';
import {
  buildComputeBudgetPrepend,
  buildExecuteFromAccountInstruction,
  buildExecuteTransaction,
  buildHeapFramePrepend,
  encodePayloadArgs,
  getTransactionSize,
  resolveAccounts,
} from '../../src/svm/index.js';
import type { AccountLoader, AccountResolution, LadderSwapTemplate } from '../../src/svm/index.js';
import {
  ecoSwapSvmPacketBudget,
  estimateShapeCu,
  quoteEcoSwapSvm,
  quoteRouteEcoSwapSvm,
  routeEcoSwapSvm,
  selectEcoSwapSvmAltAddresses,
  solveReference,
} from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmPoolSpec, EcoSwapSvmRouteOutput } from '../../src/recipes/ecoswap/svm/index.js';
import {
  describeSvm,
  fabricateAlt,
  randomAddress,
  setTokenAccount,
  startEngine,
  tokenAmount,
} from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { synthesizeRaydiumCpPool, TOKENKEG } from './ecoswap-svm.fixtures.js';
import type { SynthesizedRaydiumCpPool } from './ecoswap-svm.fixtures.js';
import { execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const CLOCK = 1_783_175_236n;
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
const INTER = 'user:inter';
const AMOUNT_IN = 400_000_000n;

interface RouteWords {
  slices: bigint[];
  predictedOuts: bigint[];
  realizedX: bigint;
  realizedB: bigint;
}

/** Decode the route returndata: [fills…][predicted…][realizedX][realizedB] 32-byte BE words. */
function decodeRoute(returnData: Uint8Array, k: number): RouteWords {
  const expected = (2 * k + 2) * 32;
  if (returnData.length !== expected) {
    throw new Error(`route returndata is ${returnData.length} bytes, expected ${expected}`);
  }
  const word = (i: number): bigint => BigInt('0x' + Buffer.from(returnData.subarray(i * 32, (i + 1) * 32)).toString('hex'));
  return {
    slices: Array.from({ length: k }, (_, i) => word(i)),
    predictedOuts: Array.from({ length: k }, (_, i) => word(k + i)),
    realizedX: word(2 * k),
    realizedB: word(2 * k + 1),
  };
}

/** SPL-transfer stand-in from `source` → `dest`, paying the slice ('in') or the predicted output ('out'). */
const standIn = (source: string, dest: string, patch: 'in' | 'out'): LadderSwapTemplate => ({
  programId: TOKENKEG,
  prefix: Uint8Array.of(3),
  suffix: new Uint8Array(0),
  patch,
  accounts: [
    { ref: source, writable: true },
    { ref: dest, writable: true },
    { ref: USER.owner, signer: true },
  ],
});

describeSvm('ecoswap-svm 2-hop route e2e: compute-exec-compute-exec, lamport-exact', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  let bufferIndex = 0;

  const setPool = (p: SynthesizedRaydiumCpPool): SynthesizedRaydiumCpPool => {
    for (const a of p.accounts) {
      harness.svm.setAccount({
        address: a.address,
        data: a.data,
        executable: false,
        lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(a.data.length))),
        programAddress: a.owner,
        space: BigInt(a.data.length),
      });
    }
    return p;
  };

  /** A funded (payer-owned) token account of `mint` — a stand-in source vault or a user ATA. */
  const fund = (mint: Address, amount: bigint): Address => setTokenAccount(harness, randomAddress(), mint, harness.payer.address, amount);

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
  });

  it('a. 1+1 route lands lamport-exact: returndata == routeReference, custody on both ATAs', async () => {
    const p0 = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n)); // leg-0 A -> X
    const p1 = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n)); // leg-1 X -> B

    const leg0Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p0.pool, swapOverride: standIn('l0src0', INTER, 'out') }];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p1.pool, swapOverride: standIn('l1src0', USER.outAta, 'out') }];

    const output = await routeEcoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK });
    expect(output.leg0Count).toBe(1);
    expect(output.leg1Count).toBe(1);
    expect(output.source).toContain(`if (gasLeft() < ${output.quote.estimatedCu}) { throw "cu" }`);

    const xMint = randomAddress();
    const bMint = randomAddress();
    const inter = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n);
    const outAta = setTokenAccount(harness, randomAddress(), bMint, harness.payer.address, 7_000_000n);
    const resolution: Record<string, Address> = {
      [INTER]: inter,
      [USER.outAta]: outAta,
      l0src0: fund(xMint, 10n ** 15n),
      l1src0: fund(bMint, 10n ** 15n),
    };

    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, resolution, output.encodeTrade(AMOUNT_IN, output.quote.totalOut));
    if (!result.ok) throw new Error(`route trade failed: ${result.err}\n${result.logs.join('\n')}`);

    const w = decodeRoute(result.returnData, 2);
    // fills: [leg-0 slice, leg-1 slice]; predicted: [leg-0 out, leg-1 out]
    expect(w.slices).toEqual([...output.quote.leg0.slices, ...output.quote.leg1.slices]);
    expect(w.predictedOuts).toEqual([...output.quote.leg0.predictedOuts, ...output.quote.leg1.predictedOuts]);
    expect(w.realizedX).toBe(output.quote.intermediate);
    expect(w.realizedB).toBe(output.quote.totalOut);
    // the keystone: realizedX == Σ leg-0 predicted; leg-0 filled all of amountIn
    expect(w.realizedX).toBe(output.quote.leg0.predictedOuts.reduce((s, x) => s + x, 0n));
    expect(w.slices[0]).toBe(AMOUNT_IN);
    // custody: the intermediate ATA holds the realized X, the out ATA gained realizedB
    expect(tokenAmount(harness, inter)).toBe(w.realizedX);
    expect(tokenAmount(harness, outAta)).toBe(7_000_000n + w.realizedB);
    console.log(`1+1 route: ${result.cu} CU (floor ${output.quote.estimatedCu}); realizedX ${w.realizedX} realizedB ${w.realizedB}`);

    // Measure the CU_TWO_HOP intercept: actual − the single-hop model of the
    // combined 2 CP slots (both @4 rungs) ≈ the route's second-merge + delta reads.
    const combined = estimateShapeCu([{ slug: 'raydium-cp-swap', rungs: 4 }, { slug: 'raydium-cp-swap', rungs: 4 }]);
    console.log(`CU_TWO_HOP measurement: actual ${result.cu} − combined-model ${combined} ≈ ${Number(result.cu) - combined}`);
  });

  it('b. multi-pool leg-0 (2 pools) splits and re-composes: realizedX == Σ leg-0 slice outs, exact vs mirror', async () => {
    const p0a = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n));
    const p0b = setPool(synthesizeRaydiumCpPool(3_400_000_000n, 260_000_000n)); // similar depth+price → a genuine split
    const p1 = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n));

    const leg0Pools: EcoSwapSvmPoolSpec[] = [
      { venue: 'raydium-cp-swap', pool: p0a.pool, swapOverride: standIn('l0src0', INTER, 'out') },
      { venue: 'raydium-cp-swap', pool: p0b.pool, swapOverride: standIn('l0src1', INTER, 'out') },
    ];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p1.pool, swapOverride: standIn('l1src0', USER.outAta, 'out') }];

    const output = await routeEcoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK });
    expect(output.leg0Count).toBe(2);
    // CU-fit: a 3-slot CP route models under the 1.4M cap (budgeter may have degraded rungs).
    expect(output.quote.estimatedCu).toBeLessThan(1_400_000);

    const xMint = randomAddress();
    const bMint = randomAddress();
    const inter = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n);
    const outAta = setTokenAccount(harness, randomAddress(), bMint, harness.payer.address, 0n);
    const resolution: Record<string, Address> = {
      [INTER]: inter,
      [USER.outAta]: outAta,
      l0src0: fund(xMint, 10n ** 15n),
      l0src1: fund(xMint, 10n ** 15n),
      l1src0: fund(bMint, 10n ** 15n),
    };

    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, resolution, output.encodeTrade(AMOUNT_IN, output.quote.totalOut));
    if (!result.ok) throw new Error(`multi-pool route failed: ${result.err}\n${result.logs.join('\n')}`);

    const w = decodeRoute(result.returnData, 3);
    expect(w.slices).toEqual([...output.quote.leg0.slices, ...output.quote.leg1.slices]);
    expect(w.predictedOuts).toEqual([...output.quote.leg0.predictedOuts, ...output.quote.leg1.predictedOuts]);
    // leg-0 genuinely split across both pools
    expect(output.quote.leg0.slices[0] > 0n && output.quote.leg0.slices[1] > 0n).toBe(true);
    expect(output.quote.leg0.slices[0] + output.quote.leg0.slices[1]).toBe(AMOUNT_IN);
    // realizedX == Σ leg-0 slice outputs (intermediate dust absorbed into custody)
    expect(w.realizedX).toBe(w.predictedOuts[0] + w.predictedOuts[1]);
    expect(w.realizedX).toBe(output.quote.intermediate);
    expect(w.realizedB).toBe(output.quote.totalOut);
    expect(tokenAmount(harness, inter)).toBe(w.realizedX);
    console.log(`2+1 route: ${result.cu} CU; leg-0 split ${output.quote.leg0.slices.join('/')}, realizedX ${w.realizedX}`);
  });

  it('c. drift a LEG-1 pool between prepare and execute: the SAME blob re-anchors leg-1, still exact vs the live mirror', async () => {
    const p0 = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n));
    const p1 = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n));
    const leg0Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p0.pool, swapOverride: standIn('l0src0', INTER, 'out') }];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p1.pool, swapOverride: standIn('l1src0', USER.outAta, 'out') }];

    const output = await routeEcoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK });
    const preDrift = output.quote.totalOut;

    const xMint = randomAddress();
    const bMint = randomAddress();
    const inter = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n);
    const outAta = setTokenAccount(harness, randomAddress(), bMint, harness.payer.address, 0n);
    const resolution: Record<string, Address> = {
      [INTER]: inter,
      [USER.outAta]: outAta,
      l0src0: fund(xMint, 10n ** 15n),
      l1src0: fund(bMint, 10n ** 15n),
    };
    const staged = await stageEcoBlob(harness, bufferIndex++, output);

    // Doctor the leg-1 out-vault down (worse price for X -> B) AFTER prepare.
    const before = harness.svm.getAccount(p1.vault1);
    if (!before.exists) throw new Error('leg-1 out vault missing');
    const doctored = new Uint8Array(before.data);
    new DataView(doctored.buffer, doctored.byteOffset).setBigUint64(64, 460_000_000n, true); // was 520e6
    harness.svm.setAccount({ ...before, address: p1.vault1, data: doctored });

    // The live mirror over the drifted bytes uses the SAME compiled rungs.
    const driftQuote = await quoteRouteEcoSwapSvm({ amountIn: AMOUNT_IN, leg0Pools, leg1Pools, load: liveLoader, now: CLOCK });
    expect(driftQuote.totalOut).toBeLessThan(preDrift); // the shallower leg-1 prices B worse

    const result = await execEcoTrade(harness, staged, output, resolution, output.encodeTrade(AMOUNT_IN, driftQuote.totalOut));
    if (!result.ok) throw new Error(`leg-1 drift trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const w = decodeRoute(result.returnData, 2);

    expect(w.realizedX).toBe(driftQuote.intermediate); // leg-0 unaffected
    expect(w.realizedX).toBe(preDrift > 0n ? output.quote.intermediate : w.realizedX); // (leg-0 identical to pre-drift)
    expect(w.realizedX).toBe(output.quote.intermediate);
    expect(w.slices[1]).toBe(driftQuote.leg1.slices[0]);
    expect(w.predictedOuts[1]).toBe(driftQuote.leg1.predictedOuts[0]);
    expect(w.realizedB).toBe(driftQuote.totalOut); // re-anchored leg-1, exact vs the LIVE mirror
    expect(w.realizedB).toBeLessThan(preDrift); // and worse than the stale prepare-time quote
  });

  it('d. drift a LEG-0 pool: realizedX moves, the on-chain leg-1 grid rebuilds on it — no "fill" revert, minOut holds', async () => {
    const p0 = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n));
    const p1 = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n));
    const leg0Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p0.pool, swapOverride: standIn('l0src0', INTER, 'out') }];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p1.pool, swapOverride: standIn('l1src0', USER.outAta, 'out') }];

    const output = await routeEcoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK });

    const xMint = randomAddress();
    const bMint = randomAddress();
    const inter = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n);
    const outAta = setTokenAccount(harness, randomAddress(), bMint, harness.payer.address, 0n);
    const resolution: Record<string, Address> = {
      [INTER]: inter,
      [USER.outAta]: outAta,
      l0src0: fund(xMint, 10n ** 15n),
      l1src0: fund(bMint, 10n ** 15n),
    };
    const staged = await stageEcoBlob(harness, bufferIndex++, output);

    // Doctor leg-0's out-vault down → less X produced → smaller realizedX.
    const before = harness.svm.getAccount(p0.vault1);
    if (!before.exists) throw new Error('leg-0 out vault missing');
    const doctored = new Uint8Array(before.data);
    new DataView(doctored.buffer, doctored.byteOffset).setBigUint64(64, 230_000_000n, true); // was 262e6
    harness.svm.setAccount({ ...before, address: p0.vault1, data: doctored });

    const driftQuote = await quoteRouteEcoSwapSvm({ amountIn: AMOUNT_IN, leg0Pools, leg1Pools, load: liveLoader, now: CLOCK });
    expect(driftQuote.intermediate).toBeLessThan(output.quote.intermediate); // less X out of leg-0

    const result = await execEcoTrade(harness, staged, output, resolution, output.encodeTrade(AMOUNT_IN, driftQuote.totalOut));
    if (!result.ok) throw new Error(`leg-0 drift trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const w = decodeRoute(result.returnData, 2);

    expect(w.realizedX).toBe(driftQuote.intermediate); // the on-chain realized X moved
    expect(w.slices[1]).toBe(driftQuote.leg1.slices[0]); // leg-1 rebuilt its grid on the NEW realizedX
    expect(w.realizedB).toBe(driftQuote.totalOut);
    expect(w.realizedB).toBeGreaterThanOrEqual(driftQuote.totalOut); // minOut held
  });

  it('e. dust absorption: an A -> X -> X route DRAINS the intermediate ATA exactly (net delta 0), pre-seed untouched', async () => {
    // out mint == intermediate mint (X), so the leg-1 stand-in can PULL the
    // input slice from the intermediate ATA (patch 'in') into the out ATA —
    // draining it exactly, the real leg-1 consume-from-custody behavior.
    const p0 = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n));
    const p1 = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n));
    const leg0Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p0.pool, swapOverride: standIn('l0src0', INTER, 'out') }];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p1.pool, swapOverride: standIn(INTER, USER.outAta, 'in') }];

    const output = await routeEcoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK });

    const xMint = randomAddress();
    const SEED = 3_333_333n; // a pre-existing intermediate balance the trade must not touch
    const inter = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, SEED);
    const outAta = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n); // out mint == X
    const resolution: Record<string, Address> = {
      [INTER]: inter,
      [USER.outAta]: outAta,
      l0src0: fund(xMint, 10n ** 15n),
    };

    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    // The pre-CPI leg-1 check binds on the PREDICTED leg-1 output (totalOut),
    // which is < the intermediate (the leg-1 curve takes a fee); the
    // pass-through stand-in then credits the full realizedX. So minOut =
    // totalOut passes, and realizedB (pass-through) == realizedX > totalOut.
    const result = await execEcoTrade(harness, staged, output, resolution, output.encodeTrade(AMOUNT_IN, output.quote.totalOut));
    if (!result.ok) throw new Error(`dust route failed: ${result.err}\n${result.logs.join('\n')}`);
    const w = decodeRoute(result.returnData, 2);

    // leg-1 consumed exactly realizedX from the intermediate → net delta 0, seed intact.
    expect(w.slices).toEqual([...output.quote.leg0.slices, ...output.quote.leg1.slices]);
    expect(w.predictedOuts).toEqual([...output.quote.leg0.predictedOuts, ...output.quote.leg1.predictedOuts]);
    expect(w.realizedX).toBe(output.quote.intermediate);
    expect(w.realizedB).toBe(w.realizedX); // pass-through stand-in credits the full input slice sum
    expect(w.realizedB).toBeGreaterThanOrEqual(output.quote.totalOut); // minOut held
    expect(tokenAmount(harness, inter)).toBe(SEED); // drained back to the pre-trade balance (net delta 0)
    expect(tokenAmount(harness, outAta)).toBe(w.realizedB);
  });

  it('f. minOut violation reverts the WHOLE route atomically — leg-0 CPIs rolled back, nothing lands', async () => {
    const p0 = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n));
    const p1 = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n));
    const leg0Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p0.pool, swapOverride: standIn('l0src0', INTER, 'out') }];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p1.pool, swapOverride: standIn('l1src0', USER.outAta, 'out') }];
    const output = await routeEcoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK });

    const xMint = randomAddress();
    const bMint = randomAddress();
    const inter = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n);
    const outAta = setTokenAccount(harness, randomAddress(), bMint, harness.payer.address, 0n);
    const l0src = fund(xMint, 10n ** 15n);
    const resolution: Record<string, Address> = { [INTER]: inter, [USER.outAta]: outAta, l0src0: l0src, l1src0: fund(bMint, 10n ** 15n) };
    const staged = await stageEcoBlob(harness, bufferIndex++, output);

    const interBefore = tokenAmount(harness, inter);
    const outBefore = tokenAmount(harness, outAta);
    const srcBefore = tokenAmount(harness, l0src);
    // minOut above the achievable leg-1 output → pre-leg-1-CPI "minOut" throw.
    const impossible = output.quote.totalOut + 1_000_000_000n;
    const reverted = await execEcoTrade(harness, staged, output, resolution, output.encodeTrade(AMOUNT_IN, impossible));
    expect(reverted.ok).toBe(false);
    if (reverted.ok) throw new Error('unreachable');
    expect(Buffer.from(reverted.revertData).toString('utf8')).toBe('minOut');
    // atomic rollback: the leg-0 CPI that already credited the intermediate is undone.
    expect(tokenAmount(harness, inter)).toBe(interBefore);
    expect(tokenAmount(harness, outAta)).toBe(outBefore);
    expect(tokenAmount(harness, l0src)).toBe(srcBefore);
  });

  it('g. realizedX == 0 reverts "x": a trade too small for leg-0 to produce any X', async () => {
    const p0 = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n));
    const p1 = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n));
    const leg0Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p0.pool, swapOverride: standIn('l0src0', INTER, 'out') }];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p1.pool, swapOverride: standIn('l1src0', USER.outAta, 'out') }];
    const output = await routeEcoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK });

    const xMint = randomAddress();
    const bMint = randomAddress();
    const inter = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n);
    const resolution: Record<string, Address> = {
      [INTER]: inter,
      [USER.outAta]: setTokenAccount(harness, randomAddress(), bMint, harness.payer.address, 0n),
      l0src0: fund(xMint, 10n ** 15n),
      l1src0: fund(bMint, 10n ** 15n),
    };
    const staged = await stageEcoBlob(harness, bufferIndex++, output);

    // amountIn = 1: the 0.25% fee swallows the lot, leg-0 quotes 0 → realizedX 0.
    const reverted = await execEcoTrade(harness, staged, output, resolution, output.encodeTrade(1n, 1n));
    expect(reverted.ok).toBe(false);
    if (reverted.ok) throw new Error('unreachable');
    expect(Buffer.from(reverted.revertData).toString('utf8')).toBe('x');
    expect(tokenAmount(harness, inter)).toBe(0n); // nothing landed
  });

  it('h. stage once, trade many: a second amountIn on the SAME blob re-solves both legs live', async () => {
    const p0 = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n));
    const p1 = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n));
    const leg0Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p0.pool, swapOverride: standIn('l0src0', INTER, 'out') }];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p1.pool, swapOverride: standIn('l1src0', USER.outAta, 'out') }];
    const output = await routeEcoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK });

    const xMint = randomAddress();
    const bMint = randomAddress();
    const inter = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n);
    const outAta = setTokenAccount(harness, randomAddress(), bMint, harness.payer.address, 0n);
    const resolution: Record<string, Address> = {
      [INTER]: inter,
      [USER.outAta]: outAta,
      l0src0: fund(xMint, 10n ** 15n),
      l1src0: fund(bMint, 10n ** 15n),
    };
    const staged = await stageEcoBlob(harness, bufferIndex++, output);

    const second = 120_000_000n; // a different trade on the SAME staged blob
    const secondQuote = await quoteRouteEcoSwapSvm({ amountIn: second, leg0Pools, leg1Pools, load: liveLoader, now: CLOCK });
    expect(secondQuote.intermediate).not.toBe(output.quote.intermediate);

    const result = await execEcoTrade(harness, staged, output, resolution, output.encodeTrade(second, secondQuote.totalOut));
    if (!result.ok) throw new Error(`second trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const w = decodeRoute(result.returnData, 2);
    expect(w.slices[0]).toBe(second);
    expect(w.realizedX).toBe(secondQuote.intermediate);
    expect(w.realizedB).toBe(secondQuote.totalOut);
    expect(tokenAmount(harness, outAta)).toBe(w.realizedB);
  });

  it('i. a 2-CP-per-leg route executes through an ALT: quote == cook, byte-identical to raw, locks ≤ 64', async () => {
    // A genuine 2+2 route (both legs split). cuBudget 1.3M admits 4 CP slots
    // at MIN_RUNGS (modeled ~1.25M, floor < the 1.4M cap); the account list
    // (both legs' 4 pools + vaults + programs + the intermediate ATA) is where
    // routes grow — an ALT compresses it while the split is unchanged.
    const p0a = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n));
    const p0b = setPool(synthesizeRaydiumCpPool(3_300_000_000n, 268_000_000n));
    const p1a = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n));
    const p1b = setPool(synthesizeRaydiumCpPool(2_050_000_000n, 530_000_000n));
    const leg0Pools: EcoSwapSvmPoolSpec[] = [
      { venue: 'raydium-cp-swap', pool: p0a.pool, swapOverride: standIn('l0src0', INTER, 'out') },
      { venue: 'raydium-cp-swap', pool: p0b.pool, swapOverride: standIn('l0src1', INTER, 'out') },
    ];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [
      { venue: 'raydium-cp-swap', pool: p1a.pool, swapOverride: standIn('l1src0', USER.outAta, 'out') },
      { venue: 'raydium-cp-swap', pool: p1b.pool, swapOverride: standIn('l1src1', USER.outAta, 'out') },
    ];
    const output: EcoSwapSvmRouteOutput = await routeEcoSwapSvm({
      amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK, cuBudget: 1_300_000,
    });
    expect(output.leg0Count).toBe(2);
    expect(output.leg1Count).toBe(2);
    expect(output.quote.estimatedCu).toBeLessThan(1_400_000);

    const xMint = randomAddress();
    const bMint = randomAddress();
    const outAta = setTokenAccount(harness, randomAddress(), bMint, harness.payer.address, 0n);
    const resolution: AccountResolution = {
      [INTER]: setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n),
      [USER.outAta]: outAta,
      l0src0: fund(xMint, 10n ** 15n),
      l0src1: fund(xMint, 10n ** 15n),
      l1src0: fund(bMint, 10n ** 15n),
      l1src1: fund(bMint, 10n ** 15n),
    };
    const staged = await stageEcoBlob(harness, bufferIndex++, output);

    // The ALT machinery is transport-only and works on the route output
    // unchanged (accountPlan/argsLayout/bytecode) — the lock cap is invariant.
    const budget = ecoSwapSvmPacketBudget(output, { resolution, payerAddress: harness.payer.address });
    expect(budget.raw.accountLocks).toBeLessThanOrEqual(64);
    if (budget.withAlt !== undefined) {
      expect(budget.withAlt.overflowBytes).toBeLessThanOrEqual(budget.raw.overflowBytes);
      expect(budget.withAlt.accountLocks).toBe(budget.raw.accountLocks); // ALT shrinks bytes, not locks
    }

    const args = output.encodeTrade(AMOUNT_IN, output.quote.totalOut);
    const buildTx = async (lookupTables?: AddressesByLookupTableAddress) => {
      const accounts = resolveAccounts(output.accountPlan, resolution, harness.payer.address);
      const exec = buildExecuteFromAccountInstruction({
        programId: harness.programId,
        buffer: staged.buffer,
        accounts,
        expectedSha256: output.sha256,
        args: encodePayloadArgs(output.argsLayout, args as unknown as string[]),
      });
      harness.svm.expireBlockhash();
      return buildExecuteTransaction({
        payer: harness.payer,
        instructions: [...buildComputeBudgetPrepend({ unitLimit: 1_400_000 }), buildHeapFramePrepend(), exec],
        latestBlockhash: { blockhash: harness.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
        lookupTables,
      });
    };
    const lookupTables = fabricateAlt(harness, selectEcoSwapSvmAltAddresses(output, staged.buffer, resolution, harness.payer.address));
    const altTx = await buildTx(lookupTables);
    const altSize = getTransactionSize(altTx);
    const altResult = harness.svm.sendTransaction(altTx);
    if (altResult instanceof FailedTransactionMetadata) {
      throw new Error(`ALT route trade failed: ${String(altResult.err())}\n${altResult.meta().logs().join('\n')}`);
    }
    const w = decodeRoute(altResult.returnData().data(), 4);
    // quote == cook, through the ALT
    expect(w.slices).toEqual([...output.quote.leg0.slices, ...output.quote.leg1.slices]);
    expect(w.predictedOuts).toEqual([...output.quote.leg0.predictedOuts, ...output.quote.leg1.predictedOuts]);
    expect(w.realizedX).toBe(output.quote.intermediate);
    expect(w.realizedB).toBe(output.quote.totalOut);
    // both legs genuinely split
    expect(output.quote.leg0.slices.every((s) => s > 0n)).toBe(true);
    expect(output.quote.leg1.slices.every((s) => s > 0n)).toBe(true);

    // byte-identical to the raw transport (ALT is a pure transport, never a dialect)
    const rawTx = await buildTx();
    const rawSize = getTransactionSize(rawTx);
    const rawResult = harness.svm.sendTransaction(rawTx);
    if (rawResult instanceof FailedTransactionMetadata) {
      throw new Error(`raw route trade failed: ${String(rawResult.err())}\n${rawResult.meta().logs().join('\n')}`);
    }
    expect(altResult.returnData().data()).toEqual(rawResult.returnData().data());
    expect(altSize).toBeLessThanOrEqual(rawSize);
    console.log(`2+2 route ALT: raw ${rawSize} B, alt ${altSize} B, locks ${budget.raw.accountLocks}, ${altResult.computeUnitsConsumed()} CU`);
  });

  it('j (adversarial). leg-1 builds on the REALIZED intermediate delta, not the in-VM predicted sum', async () => {
    // The faithful cells (a–d) use a patch-'out' leg-0 stand-in that credits the
    // intermediate EXACTLY the predicted X, so realizedX == Σ leg-0 predicted by
    // construction — they cannot tell whether leg-1 reads the measured ATA delta
    // or the in-VM predicted sum. This cell forces them APART: a patch-'in' leg-0
    // stand-in credits the intermediate the INPUT slice (fill, == amountIn for a
    // single pool), so the measured realizedX diverges hugely from the predicted
    // p0. leg-1 must split its grid on the MEASURED realizedX; a blob that fed it
    // the predicted sum would split ~p0 (~29e6) and RED the slices[1] assert.
    const p0 = setPool(synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n));
    const p1 = setPool(synthesizeRaydiumCpPool(2_000_000_000n, 520_000_000n));
    const leg0Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p0.pool, swapOverride: standIn('l0src0', INTER, 'in') }];
    const leg1Pools: EcoSwapSvmPoolSpec[] = [{ venue: 'raydium-cp-swap', pool: p1.pool, swapOverride: standIn('l1src0', USER.outAta, 'out') }];

    const output = await routeEcoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, leg0Pools, leg1Pools, user: USER, load: liveLoader, now: CLOCK });

    const xMint = randomAddress();
    const bMint = randomAddress();
    const inter = setTokenAccount(harness, randomAddress(), xMint, harness.payer.address, 0n);
    const outAta = setTokenAccount(harness, randomAddress(), bMint, harness.payer.address, 0n);
    const resolution: Record<string, Address> = {
      [INTER]: inter,
      [USER.outAta]: outAta,
      l0src0: fund(xMint, 10n ** 15n),
      l1src0: fund(bMint, 10n ** 15n),
    };
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, resolution, output.encodeTrade(AMOUNT_IN, 1n));
    if (!result.ok) throw new Error(`adversarial route failed: ${result.err}\n${result.logs.join('\n')}`);
    const w = decodeRoute(result.returnData, 2);

    // the measured delta is the credited INPUT slice, DISTINCT from the predicted X
    expect(w.slices[0]).toBe(AMOUNT_IN);
    expect(w.realizedX).toBe(AMOUNT_IN); // == the credited fill, NOT p0
    expect(w.predictedOuts[0]).toBeGreaterThan(0n);
    expect(w.predictedOuts[0] * 10n).toBeLessThan(w.realizedX); // p0 ≈ 29e6 ≪ 400e6 realizedX
    expect(tokenAmount(harness, inter)).toBe(w.realizedX); // custody: exactly the credited delta

    // THE DISCRIMINATOR: leg-1 split its grid on realizedX (== AMOUNT_IN), so the
    // single leg-1 pool absorbs ALL of realizedX. Fed p0 it would fill ~29e6.
    expect(w.slices[1]).toBe(w.realizedX);

    // lamport-exact: leg-1 == a single-hop solve on the REALIZED delta (same rungs)
    const leg1Solo = await quoteEcoSwapSvm({ amountIn: w.realizedX, pools: leg1Pools, load: liveLoader, now: CLOCK });
    expect(w.slices[1]).toBe(leg1Solo.slices[0]);
    expect(w.predictedOuts[1]).toBe(leg1Solo.predictedOuts[0]);
    expect(w.realizedB).toBe(leg1Solo.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(w.realizedB);
    console.log(
      `adversarial (realizedX≠Σpredicted): realizedX ${w.realizedX} vs p0 ${w.predictedOuts[0]}; leg-1 slice ${w.slices[1]}, realizedB ${w.realizedB}`,
    );
  });

  // Guard the reference-mirror composition the cells lean on: leg-1 solves on
  // the realized intermediate, not amountIn.
  it('reference sanity: the composed mirror chains leg-0 output into leg-1', () => {
    const leg0 = [{ quote: (x: bigint) => x / 2n }];
    const leg1 = [{ quote: (x: bigint) => x / 3n }];
    const ref = solveReference(leg1, solveReference(leg0, 600n).totalPredicted);
    expect(ref.totalPredicted).toBe(100n); // (600/2)/3
  });
});
