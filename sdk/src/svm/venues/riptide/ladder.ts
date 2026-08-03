/**
 * Riptide adapter v2 (SvmRoute ladder fragment).
 *
 * ── Swap instruction (disc 0x02 "SwapExactIn", 12 bytes total) —
 * reverse-engineered from 15 real landed swaps (both direct calls and
 * Jupiter/router-wrapped `SharedAccountsRoute` CPIs) plus `simulateTransaction`
 * probes ──
 *   byte 0        : discriminator, 0x02 ("SwapExactIn" — confirmed via the
 *                   program's own `Program log: Instruction: SwapExactIn`)
 *   bytes 1..9    : amountIn, u64 LE (EXACT — confirmed lamport-for-lamport
 *                   against the input-side vault's balance delta on-chain,
 *                   at 15 real sizes spanning 6 orders of magnitude)
 *   byte 9        : direction — 1 = mintA deposited / mintB withdrawn,
 *                   0 = mintB deposited / mintA withdrawn (confirmed via
 *                   real "SwapToc" vs "SwapTob" router-labeled calls on the
 *                   IDENTICAL account list, whose vault-side transfer
 *                   directions flip exactly with this bit and nothing else)
 *   byte 10       : always 0 in every one of the 15 real samples AND our
 *                   own probes (unused/reserved — never observed non-zero)
 *   byte 11       : an independent flag observed as 0 (2 of 15, both via a
 *                   direct non-Jupiter router) or 1 (13 of 15, mostly via
 *                   Jupiter's `SharedAccountsRoute`) — not correlated with
 *                   direction or amount in the sample, and probes succeeded
 *                   at value 1 at every size/direction tested; fixed here
 *                   at 1, the majority value (same treatment as bisonfi's
 *                   TAIL_FLAG).
 *
 * ── Accounts (13, FIXED order regardless of direction — confirmed by
 * probing the reverse direction with the account order unchanged, and by
 * two independent real router labels "SwapToc"/"SwapTob" sharing the exact
 * same 13-address list) ──
 *   0 owner    (signer)              — the trader authorizing the transfer
 *                                       out of its own mintA/mintB ATAs
 *   1 pool     (writable)            — the 1024-byte pool state account
 *                                       (ALSO the vault authority — see
 *                                       index.ts)
 *   2 mintA    (readonly)
 *   3 mintB    (readonly)
 *   4 userAtaA (writable)            — owner's mintA token account (role
 *                                       flips source/dest with direction)
 *   5 userAtaB (writable)            — owner's mintB token account (role
 *                                       flips source/dest with direction)
 *   6 vaultA   (writable)            — ATA(pool, mintA)
 *   7 vaultB   (writable)            — ATA(pool, mintB)
 *   8 TOKEN_PROGRAM (readonly)
 *   9 TOKEN_PROGRAM (readonly, listed TWICE — verified against real chain
 *     data, not a transcription artifact; the same doubling bisonfi
 *     documents for its own program)
 *   10 MEMO_PROGRAM (readonly)
 *   11 SYSVAR_INSTRUCTIONS (readonly)
 *   12 JITODONTFRONT (readonly) — the well-known anti-frontrun sentinel
 *      address (`jitodontfront111111111111111111111111111111`), present on
 *      every real transaction inspected; a fixed constant, not resolved
 *      per-trade.
 *
 * ── Quote curve — HONEST LIMITATION (same class as bisonfi/solfi-v2) ──
 * The real executed price is **not** the vaults' raw balance ratio.
 * Measured on the live USDT/USDC pool (5 real transactions plus 5 probes,
 * spanning 1 to 500 USDT/USDC): the REAL rate holds essentially FIXED at
 * ~0.998739 (mintA->mintB) / ~1.000313 (mintB->mintA) regardless of trade
 * size, while the raw vault ratio at the same moments was ~0.7115 /
 * ~1.4105 — the raw ratio would OVERSHOOT the real reverse-direction rate
 * by ~41% (a real, measured, FAVOURABLE-error hazard) while undershooting
 * the forward direction. A second pair (wSOL/USDC, real trade of ~2.2 SOL)
 * showed a smaller but still real ~2% raw-ratio overshoot. This confirms
 * Riptide prices off an internal/external reference (a periodic ~529-byte
 * "push-quote" instruction observed separately, disc 0x01, signed by a
 * dedicated quoting authority key) — NOT the vaults' own balances, and the
 * true encoding was not recovered (same honest gap as solfi-v2's documented
 * XOR keystream). Rather than ship a favourable model, or none at all, this
 * ladder quotes a DELIBERATELY-CONSERVATIVE virtual constant-product curve
 * over the vaults' own live balances with the output side discounted by a
 * fixed 50% margin (OUT_DISCOUNT_NUM/DEN = 1/2) — comfortably past the
 * worst ~41% real gap measured above, with headroom for pools not yet
 * probed. The real Riptide CPI still delivers its own authoritative output
 * at cook time; this quote only shapes off-chain ranking and the on-chain
 * slot's own predicted-output bookkeeping, never the real transfer.
 * Tightening this (recovering the true push-quote encoding) is a follow-up
 * model-fidelity item, not a blocker for shipping the venue.
 *
 * ── CU (measured, REAL mainnet, both via 15 observed production
 * transactions AND simulateTransaction probes at 5 sizes/both directions,
 * sigVerify:false, up to 1.4M CU budget) ──
 * The real `SwapExactIn` CPI alone (excluding Sauce's own setup/quote/merge
 * overhead) consumes a remarkably SIZE-INDEPENDENT ~533,000-566,270 CU on
 * every successful swap observed (both directions, sizes from ~1 to ~500
 * raw-unit-scaled and up to ~2.2 SOL) — dramatically heavier than most
 * other wired families (the next heaviest single-CPI cost, solfi-v2's whole
 * slot, is 585,136 including its OWN setup/quote/merge). The CU_FAMILIES
 * pin in ecoswap/svm/budget.ts (sauce-recipes) is calibrated generously
 * above the observed ceiling rather than off a LiteSVM slot/rung split — no
 * local engine.so was available at the time this was measured; re-pin with
 * ECO_SVM_CU_PRINT=1 once one is.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type {
  AccountBytesMap,
  SvmVenueLadder,
  SwapUser,
  VenueAccount,
} from '../types.js';
import { AMOUNT_OFF, JITODONTFRONT, MEMO_PROGRAM, RIPTIDE_PROGRAM_ID, SYSVAR_INSTRUCTIONS, TOKEN_PROGRAM, riptideConfig } from './index.js';

const SLUG = 'riptide';

/** disc(1) ++ amountIn u64 LE (patched) ++ direction(1) ++ reserved(1)=0 ++ flag(1) = 12 bytes. */
const SWAP_DISCRIMINATOR = 0x02;
/** Byte 11: observed as 0 or 1 across real swaps, uncorrelated with direction; fixed at the majority value. */
const TAIL_FLAG = 1;

/** Conservative haircut on the modeled output side — see the module doc "Quote curve" note. */
const OUT_DISCOUNT_NUM = 1n;
const OUT_DISCOUNT_DEN = 2n;

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

export const riptideLadder: SvmVenueLadder = {
  slug: SLUG,
  /** Simple CP-style curve (no window walk / Newton iteration), 4 rungs. */
  defaultRungs: 4,
  shapeKey(base) {
    return `${SLUG}:${riptideConfig(base).direction}`;
  },
  helpers() {
    return [
      {
        name: 'qRiptide',
        source: [
          'function qRiptide(x, rin, rout) {',
          '  if (x === 0) { return 0 }',
          '  return Math.mulDiv(x, rout, rin + x);',
          '}',
        ].join('\n'),
      },
    ];
  },
  paramCount: 0,
  paramsFor() {
    return [];
  },
  quoteRefs(base, slot) {
    const cfg = riptideConfig(base);
    const [vin, vout] = cfg.direction === 0 ? [cfg.vaultA, cfg.vaultB] : [cfg.vaultB, cfg.vaultA];
    return [
      { ref: ref(slot, 'vin'), address: vin },
      { ref: ref(slot, 'vout'), address: vout },
    ];
  },
  emitSetup(base, slot) {
    riptideConfig(base);
    const vin = JSON.stringify(ref(slot, 'vin'));
    const vout = JSON.stringify(ref(slot, 'vout'));
    return [
      `  const s${slot}rin = accountUint(${vin}, ${AMOUNT_OFF}, 8);`,
      `  const s${slot}rout = (accountUint(${vout}, ${AMOUNT_OFF}, 8) * ${OUT_DISCOUNT_NUM}) / ${OUT_DISCOUNT_DEN};`,
    ].join('\n');
  },
  emitQuoteCall(_base, slot, x) {
    return `qRiptide(${x}, s${slot}rin, s${slot}rout)`;
  },
  buildSwapV2(base, slot, user: SwapUser) {
    const cfg = riptideConfig(base);
    const [userAtaA, userAtaB] = cfg.direction === 0 ? [user.inAta, user.outAta] : [user.outAta, user.inAta];
    const roled = (roleRef: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, roleRef), address: addr, writable: true } : { ref: ref(slot, roleRef), address: addr };
    // byte9 direction bit: 1 = mintA in, 0 = mintB in — the inverse of our own
    // cfg.direction numbering (0 = mintA in) — see index.ts's header.
    const directionBit = cfg.direction === 0 ? 1 : 0;
    return {
      programId: RIPTIDE_PROGRAM_ID,
      prefix: Uint8Array.from([SWAP_DISCRIMINATOR]),
      // direction ++ reserved(0) ++ TAIL_FLAG.
      suffix: Uint8Array.from([directionBit, 0, TAIL_FLAG]),
      patch: 'in',
      accounts: [
        { ref: user.owner, signer: true },
        roled('pool', cfg.pool, true),
        roled('mintA', cfg.mintA),
        roled('mintB', cfg.mintB),
        { ref: userAtaA, writable: true },
        { ref: userAtaB, writable: true },
        roled('vaultA', cfg.vaultA, true),
        roled('vaultB', cfg.vaultB, true),
        roled('tp1', TOKEN_PROGRAM),
        roled('tp2', TOKEN_PROGRAM),
        roled('memo', MEMO_PROGRAM),
        roled('sysvarInstructions', SYSVAR_INSTRUCTIONS),
        { ref: 'jitodontfront', address: JITODONTFRONT },
      ],
    };
  },
  referenceQuote(base, state: AccountBytesMap) {
    const cfg = riptideConfig(base);
    const [vin, vout] = cfg.direction === 0 ? [cfg.vaultA, cfg.vaultB] : [cfg.vaultB, cfg.vaultA];
    const vinData = state[vin];
    const voutData = state[vout];
    if (vinData === undefined) throw new Error(`${SLUG} reference is missing vault ${vin}`);
    if (voutData === undefined) throw new Error(`${SLUG} reference is missing vault ${vout}`);
    const rin = readUintLE(vinData, AMOUNT_OFF, 8);
    const rout = (readUintLE(voutData, AMOUNT_OFF, 8) * OUT_DISCOUNT_NUM) / OUT_DISCOUNT_DEN;
    return (x: bigint) => {
      if (x === 0n) return 0n;
      return (x * rout) / (rin + x);
    };
  },
  depthReserves(base, state: AccountBytesMap) {
    const cfg = riptideConfig(base);
    const vaData = state[cfg.vaultA];
    const vbData = state[cfg.vaultB];
    if (vaData === undefined || vbData === undefined) throw new Error(`${SLUG} depth is missing a vault`);
    // Real (undiscounted) vault balances — the true liquidity depth for the
    // relative-depth filter; the conservative haircut above is a QUOTE-only
    // safety margin, not a claim about real depth.
    const ra = readUintLE(vaData, AMOUNT_OFF, 8);
    const rb = readUintLE(vbData, AMOUNT_OFF, 8);
    return cfg.direction === 0 ? { reserveIn: ra, reserveOut: rb } : { reserveIn: rb, reserveOut: ra };
  },
  continuousFees() {
    // Measurement-only oracle (see the SvmVenueLadder doc comment) — no
    // additional denominator decay (gammaPpm at par), muPpm folds the
    // OUT_DISCOUNT_NUM/DEN conservative haircut so the efficiency oracle
    // reads the same conservative curve the ladder actually quotes.
    return { gammaPpm: 1_000_000n, muPpm: (1_000_000n * OUT_DISCOUNT_NUM) / OUT_DISCOUNT_DEN };
  },
};
