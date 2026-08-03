/**
 * 1DEX (`one-intro-swap`) LADDER fragment (EcoSwapSVM adapter contract v2) —
 * see ./index.ts's module header for the account-model / instruction-shape
 * rationale. This file owns the swap MATH, fully reverse-engineered and
 * BIT-EXACT-proven against the real deployed binary (LiteSVM, `solana
 * program dump`'d `one-intro-swap.so`), not merely inferred from a mainnet
 * observation:
 *
 * THE CURVE IS NOT PRICED OFF THE LIVE SPL VAULT BALANCE. Proven directly:
 * overriding the real `vault0`/`vault1` SPL token amounts to arbitrary values
 * (equal, 2:1, 10:1, 1:10 — every ratio tried) leaves a fixed-size quote's
 * output UNCHANGED, while resetting the PoolState's own two 8-byte
 * `virtualReserve0`/`virtualReserve1` fields between calls is what pins the
 * quote back to a REPRODUCIBLE baseline. Five SEQUENTIAL real-CPI swaps at a
 * fixed gross input, letting `virtualReserve{0,1}` accumulate naturally
 * (never reset), produced a smoothly decaying output sequence that a plain
 * constant-product invariant over `virtualReserve{0,1}` alone reproduces
 * EXACTLY (see below) — this is a Uniswap-V2-style pool that tracks its OWN
 * reserve accounting internally (in `PoolState`, decoupled from the token
 * vault's real balance) rather than reading `vault.amount` live, presumably
 * as a donation/manipulation defense. The live SPL vault balance therefore
 * matters ONLY as the real payout ceiling (this ladder's `vaultOutBal` live
 * read, folded into the quote as a hard cap) — the same "output-vault-
 * balance-as-hard-cap" shape obric-v2 uses, just with the PRICE coming from
 * a self-tracked virtual reserve pair instead of an external oracle.
 *
 * FORMULA (all integer, bit-exact against the real binary at every size
 * tested: 1e6 through 5e10 raw units, both directions, both on real
 * mainnet-dumped reserves AND on synthetic reserves spanning 12 orders of
 * magnitude):
 *
 *   feeUnit = floor(grossIn / 100_000)
 *   effIn   = grossIn - 10 * feeUnit        // netIn (= grossIn - 2*feeUnit,
 *                                           // what actually lands in the
 *                                           // deposit vault) minus an
 *                                           // ADDITIONAL implicit 8*feeUnit
 *                                           // retained fee that grows the
 *                                           // pool's own virtual reserve
 *                                           // without affecting THIS
 *                                           // trade's price (Uniswap-V2's
 *                                           // "fee stays in reserves" shape)
 *   out     = virtualReserveOut
 *             - ceil(virtualReserveIn * virtualReserveOut
 *                     / (virtualReserveIn + effIn))
 *   out     = min(out, liveVaultOutBalance)          // the hard cap
 *
 * Total fee is exactly 10 * feeUnit / grossIn ~= 1 basis point (0.01%): TWO
 * explicit streams of `feeUnit` each, real SPL transfers out of the DEPOSIT
 * vault to `ATA(FEE_OWNER_A, mintIn)` / `ATA(FEE_OWNER_B, mintIn)` (ground-
 * truthed: `feeUnit == floor(grossIn / 100_000)` matched EVERY real mainnet
 * transaction's own fee-transfer amount exactly, 14/14 sampled, both
 * directions, sizes from 14,598 to 32,373,715 raw units), plus one implicit
 * `8 * feeUnit` that never leaves the pool (folds into `virtualReserveIn`'s
 * own growth every trade, i.e. `virtualReserveIn_new = virtualReserveIn +
 * (grossIn - 2*feeUnit)`, NOT `+ effIn`).
 *
 * CEILING, NOT FLOOR, on the division: proven by re-simulating 5 sequential
 * real swaps against the exact `virtualReserve{0,1}` values read out of
 * PoolState before each one — floor division overshoots the real output by
 * exactly 1 raw unit on every single swap; ceiling division matches all 5
 * to the last integer.
 *
 * `virtualReserve{0,1}` are READ LIVE (accountUint over the PoolState
 * account already attached for direction bookkeeping) — nothing about a
 * trade is baked into the bytecode; the 100_000/10 constants are protocol
 * literals (no evidence anywhere of a per-pool override — the ONE market
 * grounded here never varies them, and no field in PoolState changes with
 * amountIn other than the two virtual reserves themselves).
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SvmVenueLadderV2, SwapUser, VenueAccount } from '../types.js';
import { oneIntroSwapConfig, ONE_INTRO_SWAP_METADATA_STATE, ONE_INTRO_SWAP_PROGRAM_ID, OFF_VIRTUAL_RESERVE0, OFF_VIRTUAL_RESERVE1, TOKEN_ACCOUNT_AMOUNT_OFFSET } from './index.js';

const SLUG = 'one-intro-swap';
// sha256("global:swap_exact_amount_in")[0..8] — read directly off the Anchor
// debug log's "Instruction: SwapExactAmountIn" line paired with the observed
// mainnet instruction's own 8-byte data prefix (both real mainnet txs AND
// this adapter's own independently-built real-CPI calls hit this exact
// discriminator successfully).
const SWAP_EXACT_AMOUNT_IN_DISCRIMINATOR = [0x08, 0x97, 0xf5, 0x4c, 0xac, 0xcb, 0x90, 0x27];
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const FEE_UNIT_DENOM = 100_000n;
const TOTAL_FEE_MULT = 10n; // 2 explicit (1x each) + 1 implicit (8x), all in units of feeUnit.

const ref = (slot: number, role: string): string => `${SLUG}:s${slot}:${role}`;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** grossIn -> effIn — the SAME split on-chain and off-chain. */
function effectiveIn(grossIn: bigint): bigint {
  const feeUnit = grossIn / FEE_UNIT_DENOM;
  return grossIn - TOTAL_FEE_MULT * feeUnit;
}

function quoteOut(biV: bigint, boV: bigint, grossIn: bigint, vaultOutBal: bigint): bigint {
  if (grossIn === 0n || biV === 0n || boV === 0n) return 0n;
  const effIn = effectiveIn(grossIn);
  if (effIn <= 0n) return 0n;
  const denom = biV + effIn;
  const div = ceilDiv(biV * boV, denom);
  if (div >= boV) return 0n;
  const out = boV - div;
  return out < vaultOutBal ? out : vaultOutBal;
}

export const oneIntroSwapLadder: SvmVenueLadderV2 = {
  slug: SLUG,
  shapeKey(base: PoolConfig) {
    const cfg = oneIntroSwapConfig(base);
    return `${SLUG}:${cfg.direction}`;
  },
  helpers() {
    return [
      {
        name: 'qOneIntroSwap',
        source: [
          'function qOneIntroSwap(x, biv, bov, vob) {',
          '  if (x === 0) { return 0 }',
          '  if (biv === 0 || bov === 0) { return 0 }',
          '  const feeUnit = x / 100000;',
          '  const effIn = x - feeUnit * 10;',
          '  if (effIn <= 0) { return 0 }',
          '  const denom = biv + effIn;',
          '  const div = (biv * bov + denom - 1) / denom;',
          '  if (div >= bov) { return 0 }',
          '  const out = bov - div;',
          '  const capped = out < vob ? out : vob;',
          '  return capped;',
          '}',
        ].join('\n'),
      },
    ];
  },
  paramCount: 0,
  paramsFor() {
    return [];
  },
  quoteRefs(base: PoolConfig, slot: number) {
    const cfg = oneIntroSwapConfig(base);
    const vaultOut = cfg.direction === '1to0' ? cfg.vault0 : cfg.vault1;
    return [
      { ref: ref(slot, 'pool'), address: cfg.pool },
      { ref: ref(slot, 'vout'), address: vaultOut },
    ];
  },
  emitSetup(base: PoolConfig, slot: number) {
    const cfg = oneIntroSwapConfig(base);
    const zeroToOne = cfg.direction === '0to1';
    const pool = JSON.stringify(ref(slot, 'pool'));
    const vout = JSON.stringify(ref(slot, 'vout'));
    const [inOff, outOff] = zeroToOne ? [OFF_VIRTUAL_RESERVE0, OFF_VIRTUAL_RESERVE1] : [OFF_VIRTUAL_RESERVE1, OFF_VIRTUAL_RESERVE0];
    return [
      `  const s${slot}biv = accountUint(${pool}, ${inOff}, 8);`,
      `  const s${slot}bov = accountUint(${pool}, ${outOff}, 8);`,
      `  const s${slot}vob = accountUint(${vout}, ${TOKEN_ACCOUNT_AMOUNT_OFFSET}, 8);`,
    ].join('\n');
  },
  emitQuoteCall(_base: PoolConfig, slot: number, x: string) {
    return `qOneIntroSwap(${x}, s${slot}biv, s${slot}bov, s${slot}vob)`;
  },
  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = oneIntroSwapConfig(base);
    const zeroToOne = cfg.direction === '0to1';
    const [vaultIn, vaultOut] = zeroToOne ? [cfg.vault0, cfg.vault1] : [cfg.vault1, cfg.vault0];
    const [feeA, feeB] = zeroToOne ? [cfg.feeA0, cfg.feeB0] : [cfg.feeA1, cfg.feeB1];
    const suffix = new Uint8Array(8);
    new DataView(suffix.buffer).setBigUint64(0, 1n, true); // minimum_amount_out = 1 (recipe's own outAta delta check is the real bound).

    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: ONE_INTRO_SWAP_PROGRAM_ID,
      prefix: Uint8Array.from(SWAP_EXACT_AMOUNT_IN_DISCRIMINATOR),
      suffix,
      patch: 'in',
      accounts: [
        roled('metadata', ONE_INTRO_SWAP_METADATA_STATE),
        roled('pool', cfg.pool, true),
        roled('authority', cfg.authority),
        roled('vin', vaultIn, true),
        roled('vout', vaultOut, true),
        { ref: user.owner, signer: true, writable: true },
        { ref: user.inAta, writable: true },
        { ref: user.outAta, writable: true },
        roled('feeA', feeA, true),
        roled('feeB', feeB, true),
        roled('tp', TOKEN_PROGRAM),
      ],
    };
  },
  referenceQuote(base: PoolConfig, state: AccountBytesMap) {
    const cfg = oneIntroSwapConfig(base);
    const zeroToOne = cfg.direction === '0to1';
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
      return data;
    };
    const pool = bytes(cfg.pool);
    const vaultOutAddr = zeroToOne ? cfg.vault1 : cfg.vault0;
    const [inOff, outOff] = zeroToOne ? [OFF_VIRTUAL_RESERVE0, OFF_VIRTUAL_RESERVE1] : [OFF_VIRTUAL_RESERVE1, OFF_VIRTUAL_RESERVE0];
    const biV = readUintLE(pool, inOff, 8);
    const boV = readUintLE(pool, outOff, 8);
    const vaultOutBal = readUintLE(bytes(vaultOutAddr), TOKEN_ACCOUNT_AMOUNT_OFFSET, 8);
    return (x: bigint): bigint => quoteOut(biV, boV, x, vaultOutBal);
  },
  depthReserves(base: PoolConfig, state: AccountBytesMap) {
    const cfg = oneIntroSwapConfig(base);
    const zeroToOne = cfg.direction === '0to1';
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
      return data;
    };
    const pool = bytes(cfg.pool);
    const vaultOutAddr = zeroToOne ? cfg.vault1 : cfg.vault0;
    const [inOff, outOff] = zeroToOne ? [OFF_VIRTUAL_RESERVE0, OFF_VIRTUAL_RESERVE1] : [OFF_VIRTUAL_RESERVE1, OFF_VIRTUAL_RESERVE0];
    const reserveIn = readUintLE(pool, inOff, 8);
    const virtualOut = readUintLE(pool, outOff, 8);
    const vaultOutBal = readUintLE(bytes(vaultOutAddr), TOKEN_ACCOUNT_AMOUNT_OFFSET, 8);
    // Honest depth: the smaller of the pool's own belief and what the real vault can actually pay out.
    const reserveOut = virtualOut < vaultOutBal ? virtualOut : vaultOutBal;
    return { reserveIn, reserveOut };
  },
  continuousFees() {
    // Total fee is exactly 10 * feeUnit / grossIn ~= 100 ppm (1 bps) — see the
    // module header. muPpm stays 1e6 (no separate output-side skim).
    return { gammaPpm: 999_900n, muPpm: 1_000_000n };
  },
};
