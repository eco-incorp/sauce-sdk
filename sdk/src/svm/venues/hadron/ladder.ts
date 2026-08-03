/**
 * Hadron (Solana) adapter v2 (EcoSwapSVM ladder fragment) — the oracle-
 * anchored inventory (obric-style) family. See ./index.ts for the account
 * layout, the registry, and the discovery/SCOPE notes.
 *
 * ── SWAP INSTRUCTION (26 bytes, disc 0x03) — reverse-engineered from 8 real
 * historical landed transactions across 4 pools/both directions PLUS 8
 * fresh `simulateTransaction` probes (see below) ──
 *   byte 0      : discriminator, 0x03 ("swap" — the only variant this
 *                 adapter's evidence covers)
 *   byte 1      : direction — 1 = mintA deposited / mintB withdrawn ("AtoB"),
 *                 0 = mintB deposited / mintA withdrawn ("BtoA") — confirmed
 *                 on the SAME pool both ways (6rK6, jitoSOL/WSOL): subtag=1
 *                 trades always transfer INTO the mintA vault and OUT of the
 *                 mintB vault; subtag=0 trades the mirror.
 *   bytes 2..10 : amountIn, u64 LE (patched at runtime) — EXACT: equals the
 *                 real pre-fee amount debited from the payer's token
 *                 account in every real/simulated sample (a small protocol
 *                 fee, measured EXACTLY 10 ppm on both directions of both
 *                 pairs tested, is then deducted internally before the
 *                 swap CPI moves anything).
 *   bytes 10..18: 0 in every real AND simulated sample (an on-chain
 *                 minOut/threshold this recipe never relies on — Sauce's
 *                 own `minOut`/`priceLimit` are the real floor).
 *   bytes 18..26: `0x7FFFFFFFFFFFFFFF` (i64::MAX) in every real AND
 *                 simulated sample — a "no limit" sentinel every real caller
 *                 passes unconditionally.
 *
 * ── Accounts (16, FIXED order regardless of direction — only WHICH vault/
 * user-ATA/fee-ATA sits in the "in" vs "out" slot changes) ──
 *   0  TOKEN_PROGRAM (readonly)                7  user.owner (signer)
 *   1  TOKEN_PROGRAM (readonly, listed TWICE — 8  userSrc = user.inAta
 *      confirmed against real chain data)       9  vaultIn
 *   2  PAIR (writable)                         10 vaultOut
 *   3  mintA's AssetConfig (128B, writable)     11 userDst = user.outAta
 *   4  mintB's role-B record (56B, writable)    12 global (686B, writable)
 *   5  mintA's "growing" history (writable)     13 feeDest (writable)
 *   6  PAIR AGAIN (writable — the pool PDA      14 SysvarC1ock (readonly)
 *      signs the outbound payout CPI itself,    15 mintA's "meta" (998B,
 *      confirmed: `authority` on the real           writable)
 *      outbound transfer == the pool address)
 *
 * ── QUOTE MODEL — evidence ──
 * mintA's 128-byte AssetConfig carries a LIVE, keeper-updated oracle price
 * at byte offset 40 (u64 LE, Q32.32 fixed point) representing raw
 * mintB-units per raw mintA-unit — found by scanning every u64-aligned
 * offset of that account for a value whose Q32.32 (and other) scaling
 * matched the REAL measured execution rate to within 0.1%: jitoSOL/WSOL
 * matched to within 0.0094% (field 1.292229 vs. measured executed rates
 * 1.292148/1.292141/1.292121/1.292092 across 4 real sizes, the field always
 * a hair ABOVE — consistent with a small spread beyond the already-
 * accounted 10 ppm fee), and USDC/USDT's reciprocal matched a REAL
 * historical landed swap to within 0.006% (field-implied 0.999171 vs.
 * measured 0.999114). Re-reading the SAME jitoSOL/WSOL field minutes apart
 * showed it moving (1.292229 -> 1.292320, ~0.007%), confirming it is live
 * (not a cached/stale constant) — this pass could not fully map the field's
 * neighboring bytes (a plausible last-update-slot value sits at offset 56)
 * so no on-chain staleness gate is implemented; the haircut below already
 * covers several multiples of the observed live-drift rate.
 *
 * The modeled quote applies a further 30 bps (0.3%) haircut
 * (`HADRON_HAIRCUT_PPM`) on top of the field-implied rate — ~30x the
 * largest real oracle-vs-executed gap measured above (0.0106%) — chosen so
 * the model stays BELOW the real venue's output at every rung even
 * accounting for keeper-update lag between quote time and cook time; this
 * is intentionally one-sided (a venue that looks worse than reality costs a
 * missed optimization; a venue that looks better wins elections it cannot
 * honor — the documented "favourable error" hazard). The real swap CPI
 * always delivers the venue's own authoritative output at cook time — this
 * quote only shapes off-chain ranking and the on-chain slot's predicted-
 * output bookkeeping, never the real transfer; `minOut`/`priceLimit` remain
 * the fund-safety floor regardless of this model's accuracy.
 *
 * CAPACITY: the real program reverts (`Custom(7)`) rather than partially
 * filling once requested output would exceed the live output vault's
 * balance (measured: a 2 SOL jitoSOL->WSOL probe left only ~0.40 WSOL of a
 * ~2.99 WSOL vault; the next-tier 50 SOL probe reverted). The ladder mirrors
 * this as a hard input-side clamp (`icap`, computed from the live output
 * vault balance and the SAME haircut rate) — a clamped-linear curve,
 * trivially monotone/concave, matching the Obric-style "vault balance as
 * the cap" shape named in this venue's integration brief.
 *
 * ── CU (measured 2026-07-31, REAL mainnet `simulateTransaction` against the
 * deployed program, `sigVerify:false`, 400k CU budget) ──
 * jitoSOL->WSOL (mintA in): 30,936-30,937 CU across 4 sizes (0.05-2 SOL).
 * WSOL->jitoSOL (mintB in): 40,859-40,861 CU across 4 sizes (0.001-0.5 SOL,
 * self-wrapped from the probing wallet's own SOL balance). The mintB-in
 * direction costs a real, consistent ~9,900 CU more — plausibly a
 * different internal accounting branch touched only on that side; both
 * directions engage the SAME 16 accounts. Recipe-side `CU_FAMILIES` is
 * calibrated generously above the WORSE-direction ceiling — see
 * `ecoswap/svm/budget.ts` in the sauce-recipes repo — no native quote arm
 * needed (the native merge program only does the k-way merge, never a
 * per-venue quote).
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SvmVenueLadderV2, SwapUser, VenueAccount } from '../types.js';
import {
  HADRON_AMOUNT_OFF,
  HADRON_CLOCK_SYSVAR,
  HADRON_FEE_PPM,
  HADRON_HAIRCUT_PPM,
  HADRON_PPM_DENOM,
  HADRON_PRICE_OFFSET,
  HADRON_PRICE_SCALE,
  HADRON_PROGRAM_ID,
  HADRON_TOKEN_PROGRAM,
  hadronConfig,
} from './index.js';

const SLUG = 'hadron';

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

export function hadronQuoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
  const cfg = hadronConfig(base);
  const vout = cfg.direction === 'BtoA' ? cfg.vaultA : cfg.vaultB;
  return [
    { ref: ref(slot, 'price'), address: cfg.assetCfgA },
    { ref: ref(slot, 'vout'), address: vout },
  ];
}

export const hadronLadder: SvmVenueLadderV2 = {
  slug: SLUG,
  /** Near-flat oracle-anchored rate, clamped by a hard capacity ceiling — 4 rungs. */
  defaultRungs: 4,
  shapeKey(base) {
    return `${SLUG}:${hadronConfig(base).direction}`;
  },
  helpers() {
    return [
      {
        name: 'qHadron',
        source: [
          'function qHadron(x, icap, en, ed) {',
          '  if (x === 0) { return 0 }',
          '  let cx = x;',
          '  if (cx > icap) { cx = icap }',
          '  if (cx === 0) { return 0 }',
          `  const fee = Math.mulDiv(cx, ${HADRON_FEE_PPM}, ${HADRON_PPM_DENOM});`,
          '  const net = cx - fee;',
          '  return Math.mulDiv(net, en, ed);',
          '}',
        ].join('\n'),
      },
    ];
  },
  paramCount: 0,
  paramsFor(_base: PoolConfig): bigint[] {
    return [];
  },
  quoteRefs: hadronQuoteRefs,
  emitSetup(base: PoolConfig, slot: number): string {
    const cfg = hadronConfig(base);
    const priceRef = JSON.stringify(ref(slot, 'price'));
    const voutRef = JSON.stringify(ref(slot, 'vout'));
    const twoPow32TimesHaircut = (HADRON_PRICE_SCALE * HADRON_HAIRCUT_PPM).toString();
    const twoPow32TimesPpmDenom = (HADRON_PRICE_SCALE * HADRON_PPM_DENOM).toString();
    const lines = [
      `  const s${slot}price = accountUint(${priceRef}, ${HADRON_PRICE_OFFSET}, 8);`,
      `  const s${slot}rout = accountUint(${voutRef}, ${HADRON_AMOUNT_OFF}, 8);`,
      `  let s${slot}pnum = 0; let s${slot}pden = 1; let s${slot}icap = 0;`,
      `  if (s${slot}price !== 0) {`,
    ];
    if (cfg.direction === 'BtoA') {
      lines.push(`    s${slot}pnum = ${twoPow32TimesHaircut};`);
      lines.push(`    s${slot}pden = s${slot}price * ${HADRON_PPM_DENOM};`);
    } else {
      lines.push(`    s${slot}pnum = s${slot}price * ${HADRON_HAIRCUT_PPM};`);
      lines.push(`    s${slot}pden = ${twoPow32TimesPpmDenom};`);
    }
    lines.push(`    s${slot}icap = Math.mulDiv(s${slot}rout, s${slot}pden, s${slot}pnum);`);
    lines.push('  }');
    return lines.join('\n');
  },
  emitQuoteCall(_base: PoolConfig, slot: number, x: string): string {
    return `qHadron(${x}, s${slot}icap, s${slot}pnum, s${slot}pden)`;
  },
  /**
   * 26-byte swap ix: disc(1)=0x03 ++ direction(1) ++ amountIn(8, patched) ++
   * minOut(8)=0 ++ i64::MAX sentinel(8) — see file header for the real/
   * simulated evidence.
   */
  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = hadronConfig(base);
    const isBtoA = cfg.direction === 'BtoA';
    const [vaultIn, vaultOut, feeDest] = isBtoA
      ? [cfg.vaultB, cfg.vaultA, cfg.feeVaultB]
      : [cfg.vaultA, cfg.vaultB, cfg.feeVaultA];

    const roled = (role: string, addr: Address): VenueAccount => ({ ref: ref(slot, role), address: addr, writable: true });

    return {
      programId: HADRON_PROGRAM_ID,
      prefix: Uint8Array.from([3, isBtoA ? 0 : 1]),
      suffix: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]),
      patch: 'in',
      accounts: [
        { ref: ref(slot, 'tp1'), address: HADRON_TOKEN_PROGRAM },
        { ref: ref(slot, 'tp2'), address: HADRON_TOKEN_PROGRAM },
        roled('pool', cfg.pool),
        roled('assetCfgA', cfg.assetCfgA),
        roled('assetCfgB', cfg.assetCfgB),
        roled('growingA', cfg.growingA),
        roled('poolAuth', cfg.pool),
        { ref: user.owner, signer: true },
        { ref: user.inAta, writable: true },
        roled('vaultIn', vaultIn),
        roled('vaultOut', vaultOut),
        { ref: user.outAta, writable: true },
        roled('global', cfg.global),
        roled('feeDest', feeDest),
        { ref: ref(slot, 'clock'), address: HADRON_CLOCK_SYSVAR },
        roled('metaA', cfg.metaA),
      ],
    };
  },
  referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint {
    const cfg = hadronConfig(base);
    const priceData = state[cfg.assetCfgA];
    if (priceData === undefined) throw new Error(`${SLUG} reference is missing price account ${cfg.assetCfgA}`);
    const voutAddr = cfg.direction === 'BtoA' ? cfg.vaultA : cfg.vaultB;
    const voutData = state[voutAddr];
    if (voutData === undefined) throw new Error(`${SLUG} reference is missing vault ${voutAddr}`);

    const price = readUintLE(priceData, HADRON_PRICE_OFFSET, 8);
    if (price === 0n) return () => 0n;
    const rout = readUintLE(voutData, HADRON_AMOUNT_OFF, 8);
    const [en, ed] =
      cfg.direction === 'BtoA'
        ? [HADRON_PRICE_SCALE * HADRON_HAIRCUT_PPM, price * HADRON_PPM_DENOM]
        : [price * HADRON_HAIRCUT_PPM, HADRON_PRICE_SCALE * HADRON_PPM_DENOM];
    const icap = (rout * ed) / en;
    return (x: bigint): bigint => {
      if (x === 0n) return 0n;
      const cx = x > icap ? icap : x;
      if (cx === 0n) return 0n;
      const fee = (cx * HADRON_FEE_PPM) / HADRON_PPM_DENOM;
      const net = cx - fee;
      return (net * en) / ed;
    };
  },
  /** Real, un-haircut live vault balances — the true liquidity depth for the relative-depth filter. */
  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = hadronConfig(base);
    const [vinAddr, voutAddr] = cfg.direction === 'BtoA' ? [cfg.vaultB, cfg.vaultA] : [cfg.vaultA, cfg.vaultB];
    const vin = state[vinAddr];
    const vout = state[voutAddr];
    if (vin === undefined || vout === undefined) throw new Error(`${SLUG} depth is missing a vault`);
    return { reserveIn: readUintLE(vin, HADRON_AMOUNT_OFF, 8), reserveOut: readUintLE(vout, HADRON_AMOUNT_OFF, 8) };
  },
  continuousFees(): { gammaPpm: bigint; muPpm: bigint } {
    // Flat oracle-anchored rate (no additional per-rung decay term — gammaPpm
    // at par); muPpm folds BOTH the measured protocol fee and the
    // conservative safety haircut, so the efficiency oracle reads the same
    // conservative curve the ladder actually quotes.
    const kept = (HADRON_HAIRCUT_PPM * (HADRON_PPM_DENOM - HADRON_FEE_PPM)) / HADRON_PPM_DENOM;
    return { gammaPpm: HADRON_PPM_DENOM, muPpm: kept };
  },
};
