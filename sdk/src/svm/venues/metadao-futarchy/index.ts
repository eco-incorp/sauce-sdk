/**
 * MetaDAO Futarchy AMM — spot leg (SvmRoute ladder fragment).
 *
 * MetaDAO's `futarchy` program (fully open source,
 * github.com/metaDAOproject/programs, `programs/futarchy/src/`) embeds a
 * `FutarchyAmm` directly on each `Dao` account: `amm.state` is a `PoolState`
 * enum, `Spot { spot: Pool }` (no proposal in flight — a plain two-reserve
 * constant-product AMM) or `Futarchy { spot, pass, fail }` (an active
 * proposal — three linked pools). This module wires ONLY the `Spot` variant
 * (per the integration plan): a `spotSwap` against a `Futarchy`-state dao
 * ALSO runs `arbitrage_after_spot_swap` — a 100-step off-chain-style search
 * that rebalances spot against the conditional pass/fail markets
 * (`programs/programs/futarchy/src/state/futarchy_amm.rs:60-83` at the
 * `2d4ceb`-adjacent tree fetched 2026-07-31) — which this recipe does not
 * model. Conditional (pass/fail) markets stay OUT of the universe until that
 * leg lands; `fetchPoolConfig` below gates any `Futarchy`-state dao with a
 * named error (self-drop, same shape as every other prepare-time gate in
 * this recipe) rather than emitting a wrong quote for it.
 *
 * SAFE ON A LATE STATE FLIP (prepare fetched Spot, the dao transitions to
 * Futarchy before the cook lands): `arbitrage_after_spot_swap`'s search only
 * ever ACCEPTS a candidate that raises `best_profit` above 0
 * (`state/futarchy_amm.rs:671-677`), so the real output is always
 * `spot_output + arbitrage_result.spot_profit` with `spot_profit >= 0` — the
 * plain two-reserve quote below is a FLOOR on the real fill, never an
 * over-promise. `minOut` (the recipe's sole atomic bound) stays safe either
 * way; no on-chain state-tag re-check is worth the extra codegen.
 *
 * QUOTE MATH (`Pool::swap`, `state/futarchy_amm.rs:495-546`): a protocol fee
 * is taken off the input, then the REMAINDER runs a plain Uniswap-v1-style
 * constant-product swap (LP_TAKER_FEE_BPS is 0 today, so the "LP fee" leg is
 * an identity multiply that cancels exactly — see the derivation below):
 *
 *   netIn  = floor(x * (MAX_BPS - PROTOCOL_TAKER_FEE_BPS) / MAX_BPS)   [protocol fee]
 *   out    = floor(netIn * reserveOut / (reserveIn + netIn))
 *
 * Full derivation of the collapse (`programs/futarchy/src/lib.rs:42-50` pins
 * MAX_BPS=10_000, PROTOCOL_TAKER_FEE_BPS=50, LP_TAKER_FEE_BPS=0 — program-wide
 * constants, not stored per-pool on chain, so this adapter bakes them at
 * compile time like any other closed-source-equivalent constant; re-verify
 * against the cited lines if MetaDAO ever redeploys with different fees):
 * `input_amount_after_lp_fee = netIn * (MAX_BPS - LP_TAKER_FEE_BPS) = netIn *
 * MAX_BPS` (exact, no floor, since the multiplier is a whole `MAX_BPS`);
 * `numerator = input_amount_after_lp_fee * reserveOut = netIn * MAX_BPS *
 * reserveOut`; `denominator = reserveIn * MAX_BPS + input_amount_after_lp_fee
 * = MAX_BPS * (reserveIn + netIn)`. `MAX_BPS` divides numerator and
 * denominator exactly, so `floor(numerator / denominator) === floor(netIn *
 * reserveOut / (reserveIn + netIn))` bit-for-bit — the two-step Rust
 * computation and the one-step form above always agree. Monotone
 * non-decreasing and concave in `x` (a haircut constant-product is still a
 * constant-product), so it cannot trigger the "coarse ladder gets allocated
 * ZERO" failure mode.
 *
 * ACCOUNTS: `spotSwap`'s 9-account order (dao, userBaseAccount,
 * userQuoteAccount, ammBaseVault, ammQuoteVault, user, tokenProgram,
 * eventAuthority, program — `programs/futarchy/src/instructions/spot_swap.rs`)
 * was cross-checked against two real mainnet transactions on two different
 * Spot-state daos (signatures `3rJxfuQ...` and `4MtVuNv...`/`2NPHutC...`,
 * fetched via a keyless `getTransaction`) — both matched this order exactly,
 * INCLUDING `eventAuthority` (Anchor's `#[event_cpi]` self-log PDA,
 * `["__event_authority"]` off the program id — computed once, pinned below,
 * and matched byte-for-byte against both transactions' account lists).
 *
 * CPI CU: measured directly off those two real mainnet transactions' logs
 * ("Program FUTARELB...consumed 40708 of..." on the flagship META/USDC dao,
 * "...consumed 39309 of..." on the SoLo/USDC dao — both PoolState::Spot,
 * both already including the nested `emit_cpi` self-log's own ~3634 CU) —
 * see `the consuming app SVM CU-budget module`'s `CU_FAMILIES.metadao-futarchy` for how that
 * folds into the pin.
 */
import { address, getAddressCodec } from '@solana/kit';
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SvmVenueLadder, SwapUser, VenueAccount } from '../types.js';

const SLUG = 'metadao-futarchy';

export const METADAO_FUTARCHY_PROGRAM_ID: Address<'FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq'> = address(
  'FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq',
);
const TOKEN_PROGRAM: Address = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/**
 * PDA(["__event_authority"], METADAO_FUTARCHY_PROGRAM_ID) — Anchor's
 * `#[event_cpi]` self-log signer, fixed for this program (independent of any
 * pool). Computed via `getProgramDerivedAddress` and confirmed byte-for-byte
 * against two real mainnet `spotSwap` transactions' account lists (see the
 * file header).
 */
export const METADAO_FUTARCHY_EVENT_AUTHORITY: Address = address('DGEympSS4qLvdr9r3uGHTfACdN8snShk4iGdJtZPxuBC');

/** sha256("account:Dao")[0:8] (Anchor account discriminator). */
const DAO_DISCRIMINATOR = [0xa3, 0x09, 0x2f, 0x1f, 0x34, 0x55, 0xc5, 0x31];
/** sha256("global:spot_swap")[0:8] (Anchor instruction discriminator). */
const SPOT_SWAP_DISCRIMINATOR = [0xa7, 0x61, 0x0c, 0xe7, 0xed, 0x4e, 0xa6, 0xfb];

/**
 * Fixed Dao account size REGARDLESS of PoolState variant (verified against
 * 82 real mainnet dao accounts, 80 Spot-state + 2 Futarchy-state, all
 * exactly 1205 bytes) — the account is pre-allocated at the `Futarchy`-sized
 * worst case (`resizeDao` exists but a fresh dao already carries the max
 * space), so `dataSize` alone is a safe, cheap gPA prune.
 */
const DAO_ACCOUNT_SIZE = 1205;

const STATE_TAG_OFFSET = 8; // 8-byte disc, then the PoolState enum's 1-byte variant tag.
const STATE_SPOT = 0; // PoolState::Spot { spot: Pool }
const SPOT_POOL_OFFSET = 9; // Pool starts right after the 1-byte tag.
// Pool { oracle: TwapOracle(100 bytes), quote_reserves: u64, base_reserves: u64,
//        quote_protocol_fee_balance: u64, base_protocol_fee_balance: u64 } = 132 bytes.
const SPOT_POOL_SIZE = 132;
const QUOTE_RESERVES_OFFSET = SPOT_POOL_OFFSET + 100; // 109
const BASE_RESERVES_OFFSET = QUOTE_RESERVES_OFFSET + 8; // 117
// FutarchyAmm continues after PoolState: total_liquidity: u128 (16 bytes), then the four Pubkeys.
const BASE_MINT_OFFSET = SPOT_POOL_OFFSET + SPOT_POOL_SIZE + 16; // 157
const QUOTE_MINT_OFFSET = BASE_MINT_OFFSET + 32; // 189
const AMM_BASE_VAULT_OFFSET = QUOTE_MINT_OFFSET + 32; // 221
const AMM_QUOTE_VAULT_OFFSET = AMM_BASE_VAULT_OFFSET + 32; // 253

// Program-wide fee constants (`programs/futarchy/src/lib.rs:42-50`) — NOT
// stored per-pool on chain, so baked at compile time (see the file header's
// derivation for why the LP-fee leg collapses to an identity at 0 bps today).
const MAX_BPS = 10_000n;
const PROTOCOL_TAKER_FEE_BPS = 50n;
const NET_FEE_NUM = MAX_BPS - PROTOCOL_TAKER_FEE_BPS; // 9_950n

export interface MetaDaoFutarchySpotPoolConfig extends PoolConfig {
  venue: typeof SLUG;
  /** 'buy' (default, quote in -> base out, SwapType::Buy=0) | 'sell' (base in -> quote out, SwapType::Sell=1). */
  direction: 'buy' | 'sell';
  baseMint: Address;
  quoteMint: Address;
  ammBaseVault: Address;
  ammQuoteVault: Address;
  tokenProgram: Address;
}

function metadaoConfig(cfg: PoolConfig): MetaDaoFutarchySpotPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} adapter got a config for venue '${cfg.venue}'`);
  return cfg as MetaDaoFutarchySpotPoolConfig;
}

const codec = getAddressCodec();
const pubkeyAt = (data: Uint8Array, offset: number): Address => codec.decode(data.subarray(offset, offset + 32));

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/**
 * Off-chain gate + decode: rejects the wrong account shape (size/discriminator),
 * an active-proposal dao (PoolState::Futarchy — see the file header), and a
 * drained side (Pool::swap requires both reserves nonzero). `pool` here is
 * the Dao account address itself (the AMM lives embedded on it, not on a
 * separate pool account).
 */
export async function fetchMetaDaoFutarchySpotConfig(load: AccountLoader, pool: Address): Promise<MetaDaoFutarchySpotPoolConfig> {
  const data = await load(pool);
  if (data === null) throw new Error(`${SLUG} dao ${pool} account not found`);
  if (data.length !== DAO_ACCOUNT_SIZE) {
    throw new Error(`${SLUG} dao ${pool} account is ${data.length} bytes, expected ${DAO_ACCOUNT_SIZE}`);
  }
  if (!DAO_DISCRIMINATOR.every((byte, i) => data[i] === byte)) {
    throw new Error(`${SLUG} dao ${pool} is not a Dao account (discriminator mismatch)`);
  }
  const stateTag = data[STATE_TAG_OFFSET];
  if (stateTag !== STATE_SPOT) {
    throw new Error(
      `${SLUG} dao ${pool} has an active proposal (PoolState::Futarchy, tag ${stateTag}) — conditional markets are ` +
        'not yet served by this adapter, only PoolState::Spot (see the consuming app metadao-futarchy venue module)',
    );
  }
  const quoteReserves = readUintLE(data, QUOTE_RESERVES_OFFSET, 8);
  const baseReserves = readUintLE(data, BASE_RESERVES_OFFSET, 8);
  if (quoteReserves === 0n || baseReserves === 0n) {
    throw new Error(`${SLUG} dao ${pool} has a zero-reserve side (quote=${quoteReserves}, base=${baseReserves}) — unquotable`);
  }
  return {
    venue: SLUG,
    pool,
    direction: 'buy',
    baseMint: pubkeyAt(data, BASE_MINT_OFFSET),
    quoteMint: pubkeyAt(data, QUOTE_MINT_OFFSET),
    ammBaseVault: pubkeyAt(data, AMM_BASE_VAULT_OFFSET),
    ammQuoteVault: pubkeyAt(data, AMM_QUOTE_VAULT_OFFSET),
    tokenProgram: TOKEN_PROGRAM,
  };
}

/**
 * Live reserves, oriented (reserveIn, reserveOut) for `direction` — read from
 * the DAO ACCOUNT'S OWN quote_reserves/base_reserves ledger fields (offsets
 * QUOTE_RESERVES_OFFSET/BASE_RESERVES_OFFSET), NOT the vault's raw SPL
 * `amount`. These differ: `vault.amount == dao.reserves +
 * dao.protocol_fee_balance` (measured live on the flagship META/USDC dao —
 * the vault carries an extra 211,846,701/871,687,994 base/quote raw units of
 * accrued, not-yet-swept protocol fee on top of the tradeable reserve).
 * `Pool::swap` (`state/futarchy_amm.rs:495-546`) reads `self.base_reserves`/
 * `self.quote_reserves` exclusively — using the vault balance instead would
 * over-quote by exactly the retained fee, which is precisely what the first
 * cut of this adapter did wrong (caught by the real-CPI lamport-exact gate:
 * `the consuming app realcpi e2e test`'s metadao-futarchy quadrilateral).
 */
function liveReserves(cfg: MetaDaoFutarchySpotPoolConfig, state: AccountBytesMap): { rin: bigint; rout: bigint } {
  const data = state[cfg.pool as unknown as string];
  if (data === undefined) throw new Error(`${SLUG} reference is missing the dao account ${cfg.pool}`);
  const rQuote = readUintLE(data, QUOTE_RESERVES_OFFSET, 8);
  const rBase = readUintLE(data, BASE_RESERVES_OFFSET, 8);
  return cfg.direction === 'sell' ? { rin: rBase, rout: rQuote } : { rin: rQuote, rout: rBase };
}

/** The COLD, venue-exact quote (see the file header's derivation). */
export function metadaoFutarchySpotQuote(x: bigint, rin: bigint, rout: bigint): bigint {
  if (x === 0n) return 0n;
  const netIn = (x * NET_FEE_NUM) / MAX_BPS;
  if (netIn === 0n) return 0n;
  return (netIn * rout) / (rin + netIn);
}

export const metadaoFutarchySpotLadder: SvmVenueLadder = {
  slug: SLUG,

  /** CP-class: a closed-form quote (one multiply-divide per rung), 4 rungs. */
  defaultRungs: 4,

  shapeKey(base: PoolConfig): string {
    return `${SLUG}:${metadaoConfig(base).direction}`;
  },

  helpers(): { name: string; source: string }[] {
    return [
      {
        name: 'qMetaDaoFutarchySpot',
        source: [
          'function qMetaDaoFutarchySpot(x, rin, rout) {',
          '  if (x === 0) { return 0 }',
          `  const netIn = Math.mulDiv(x, ${NET_FEE_NUM}, ${MAX_BPS});`,
          '  if (netIn === 0) { return 0 }',
          '  return Math.mulDiv(netIn, rout, rin + netIn);',
          '}',
        ].join('\n'),
      },
    ];
  },

  paramCount: 0,
  paramsFor(): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = metadaoConfig(base);
    // The dao account IS the reserve source (see liveReserves' doc comment) —
    // the vaults are swap-CPI-only (buildSwapV2), never read for quoting.
    return [{ ref: ref(slot, 'dao'), address: c.pool }];
  },

  emitSetup(base: PoolConfig, slot: number): string {
    const c = metadaoConfig(base);
    const daoRef = JSON.stringify(ref(slot, 'dao'));
    const [quoteOff, baseOff] = [QUOTE_RESERVES_OFFSET, BASE_RESERVES_OFFSET];
    const [rinOff, routOff] = c.direction === 'sell' ? [baseOff, quoteOff] : [quoteOff, baseOff];
    return [
      `  const s${slot}rin = accountUint(${daoRef}, ${rinOff}, 8);`,
      `  const s${slot}rout = accountUint(${daoRef}, ${routOff}, 8);`,
    ].join('\n');
  },

  emitQuoteCall(_base: PoolConfig, slot: number, x: string): string {
    return `qMetaDaoFutarchySpot(${x}, s${slot}rin, s${slot}rout)`;
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = metadaoConfig(base);
    const swapType = c.direction === 'sell' ? 1 : 0; // SwapType::Buy=0, Sell=1
    const make = (r: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
    const userBaseRef = c.direction === 'sell' ? user.inAta : user.outAta;
    const userQuoteRef = c.direction === 'sell' ? user.outAta : user.inAta;
    return {
      programId: METADAO_FUTARCHY_PROGRAM_ID,
      prefix: Uint8Array.from(SPOT_SWAP_DISCRIMINATOR),
      // SpotSwapParams field order: inputAmount(patched u64 LE) ++ swapType(u8) ++ minOutputAmount(u64 LE)=1.
      suffix: Uint8Array.from([swapType, 1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: [
        make(ref(slot, 'dao'), c.pool, true),
        { ref: userBaseRef, writable: true },
        { ref: userQuoteRef, writable: true },
        make(ref(slot, 'basevault'), c.ammBaseVault, true),
        make(ref(slot, 'quotevault'), c.ammQuoteVault, true),
        { ref: user.owner, signer: true },
        make(ref(slot, 'tp'), c.tokenProgram),
        make(ref(slot, 'ea'), METADAO_FUTARCHY_EVENT_AUTHORITY),
        make(ref(slot, 'prog'), METADAO_FUTARCHY_PROGRAM_ID),
      ],
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint {
    const c = metadaoConfig(base);
    const { rin, rout } = liveReserves(c, state);
    return (x: bigint): bigint => metadaoFutarchySpotQuote(x, rin, rout);
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const c = metadaoConfig(base);
    const { rin, rout } = liveReserves(c, state);
    return { reserveIn: rin, reserveOut: rout };
  },

  continuousFees(): { gammaPpm: bigint; muPpm: bigint } {
    // out(x) == gamma*x*rOut/(rIn + gamma*x) EXACTLY at gamma = NET_FEE_NUM/MAX_BPS
    // (see the file header derivation) — mu = 1 (no separate multiplicative
    // reduction; LP_TAKER_FEE_BPS is 0 today).
    return { gammaPpm: (NET_FEE_NUM * 1_000_000n) / MAX_BPS, muPpm: 1_000_000n };
  },
} satisfies SvmVenueLadder;
