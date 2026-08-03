/**
 * GooseFX GAMMA (gamma-swap) — a constant-product AMM forked from
 * raydium-cp-swap's account layout, with GooseFX's own dynamic (volatility-
 * based) fee and oracle-observation bookkeeping layered on top. Program id
 * GAMMA7meSFWaBXF25oSUgmGRwaW6sCMFLmBNiMSdbHVT, 71 live pools measured at
 * PoolState dataSize 637 (integration time).
 *
 * Layout source: the program is fully open source
 * (github.com/GooseFX1/gamma-swap, `programs/gamma/src/states/pool.rs` /
 * `config.rs` / `oracle.rs`), CROSS-VERIFIED against a real mainnet dump
 * (pool CM681mP5GjxrzFWg452RfJ2W4zEnshR9kkgg34NdAthi, WSOL/pump-token):
 * PoolState = 637 bytes, discriminator sha256('account:PoolState')[0..8] =
 * f7 ed e3 f5 d7 c3 de 46 — BYTE-IDENTICAL to raydium-cp-swap's, because
 * GooseFX kept the same Anchor struct/account NAMES for the shared prefix
 * (amm_config@8, token_0_vault@72, token_1_vault@104, a 32-byte padding
 * where raydium keeps lp_mint, token_0_mint@168, token_1_mint@200,
 * token_0/1_program@232/264, observation_key@296, auth_bump@328, status@329,
 * mint_0/1_decimals@331/332) — this is EXACTLY why the wired
 * raydium-cp-swap `SVM_FAMILY_FILTERS` geometry ({dataSize:637,
 * mintAOffset:168, mintBOffset:200}) already finds GAMMA pools for free.
 * AmmConfig is likewise byte-identical through its shared prefix (236
 * bytes, discriminator da f4 21 68 cb cb 2b 6f, trade_fee_rate@12).
 *
 * PAST THE SHARED PREFIX THE STRUCTS DIVERGE — this is NOT a byte-identical
 * clone of raydium-cp-swap's SWAP MATH, only of its account header:
 *
 * 1. **Reserves are CACHED FIELDS, not vault-minus-fees.** PoolState carries
 *    its own `token_0_vault_amount`@477 / `token_1_vault_amount`@485 (u64
 *    each) — "the current balance of token0/1 in the vault, EXCLUDING fund
 *    fees and protocol fees" — updated incrementally by every swap
 *    (`instructions/swap_base_input.rs`). The on-chain curve reads these
 *    fields directly (`pool_state.vault_amount_without_fee()` is a plain
 *    tuple return of the two fields), never `vault.amount - protocolFees -
 *    fundFees` the way raydium-cp-swap computes it live. The two happen to
 *    coincide numerically on a freshly-fetched pool (both derive from the
 *    same swap history), but the CACHED field is the venue's own source of
 *    truth and the only one guaranteed to stay in lockstep with its curve
 *    after admin fee collection (`collect_protocol_fee`/`collect_fund_fee`
 *    move real vault balance without touching the trading-amount fields).
 *
 * 2. **The swap CPI is `oracle_based_swap_base_input`, NOT `swap_base_input`
 *    — MEASURED live, corrects the initial assumption.** The classic
 *    `swap_base_input` discriminator (sha256('global:swap_base_input')
 *    [0..8]) still exists on-chain but is a deprecated shim that
 *    unconditionally forwards into `oracle_based_swap_base_input`'s
 *    handler and reverts `NotApproved` (Anchor error 6000) when called
 *    directly — reproduced against the real dumped `gamma.so` via LiteSVM.
 *    Every real mainnet swap sampled (10 consecutive `getSignaturesForAddress`
 *    hits) uses the OTHER discriminator, `ef 52 c0 bb a0 1a df df` =
 *    sha256('global:oracle_based_swap_base_input')[0..8], with the IDENTICAL
 *    13-account shape and 16-byte (amount_in, minimum_amount_out) payload as
 *    raydium-cp-swap's `swap_base_input` — confirmed both by live-tx replay
 *    and by a REAL-BINARY LiteSVM swap at 4 sizes (see below).
 *
 * 3. **The fee is DYNAMIC (volatility-based), not the flat AmmConfig
 *    `trade_fee_rate`.** `curve/calculator.rs::swap_base_input` computes
 *    `dynamic_fee_rate = min(trade_fee_rate + volatility_factor *
 *    |ln(max_price)-ln(min_price)|/|ln(twap_price)|, max_trade_fee_rate)`
 *    from up to 100 `ObservationState` price samples inside a rolling
 *    3600s window (falling back to the flat `trade_fee_rate` when fewer
 *    than 2 samples are in-window) — see `fees/dynamic_fee.rs`. This
 *    genuinely depends on a NATURAL LOG the compiler's `Math` intrinsics
 *    do not provide (only `sqrt`/`mulDiv`/`neg`), so it cannot be
 *    replicated on-chain bit-for-bit the way the rest of this fragment is.
 *    **Fix: use `pool_state.max_trade_fee_rate`@461 (falling back to the
 *    program's own default of 100_000 = 10% when the field reads 0, exactly
 *    mirroring `DEFAULT_MAX_FEE` in `fees/dynamic_fee.rs`) as the fee rate.**
 *    Because the real `dynamic_fee_rate` is PROVABLY `<= max_trade_fee_rate`
 *    at every trade (the Rust code takes an explicit `min(...)` against it),
 *    substituting the ceiling for the true rate can only ever OVER-charge
 *    our own quote's fee relative to the real one — i.e. this fragment's
 *    predicted output is a SAFE LOWER BOUND, never a favourable
 *    over-quote. It is honest but conservative, exactly the required
 *    trade-off: MEASURED live against the real binary (below) at 1e6 /
 *    1e7 / 5e7 / 2e8 lamports-in, this fragment's prediction sits at
 *    98.0% / 98.1% / 98.2% / 98.6% of the realized output on the sampled
 *    pool (whose live `max_trade_fee_rate` is 20_000 = 2%, vs. an actual
 *    dynamic rate around 258-305 = 0.026-0.03% at the time) — a real,
 *    disclosed under-quote, never an over-quote, backstopped like every
 *    other venue's quote-vs-execution drift by `minOut`.
 *
 * No creator-fee concept exists in GAMMA's PoolState (unlike
 * raydium-cp-swap's later creator-fee upgrade) — the bytes a raydium-cp-swap
 * decoder would read as `creatorFeeOn`/`enableCreatorFee` at 389/390 are
 * actually the low bytes of GAMMA's own `cumulative_trade_fees_token_0`
 * (u128 @389), a stats counter with no effect on live quoting.
 *
 * VALIDATED against the REAL gamma.so binary (dumped from mainnet-beta)
 * executing on REAL mainnet pool state via LiteSVM, at 4 sizes (1_000_000,
 * 10_000_000, 50_000_000, 200_000_000 WSOL lamports in, ~0.2% to ~45% of
 * the sampled pool's reserve): this fragment's formula predicts <= the
 * realized output at every size (bit-exact match when fed the pool's
 * OWN live `max_trade_fee_rate` as computed here; the true dynamic rate
 * traded a little tighter, per the disclosed residual above).
 *
 * Gates (named errors caught by the orchestrator's TOCTOU self-drop):
 * account size / discriminator / owner (fetch-time, mirrors raydium-cp-swap);
 * swap-disabled status bit / not-yet-open pools; non-Tokenkeg vault/mint
 * mismatches; a Token-2022 transfer-fee extension on either mint (wire
 * amounts would diverge from the quote, same gate raydium-cp-swap uses).
 */
import { address, getAddressCodec } from '@solana/kit';
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SvmVenueLadder, SwapUser, VenueAccount } from '../types.js';

const SLUG = 'gamma';
export const GAMMA_PROGRAM_ID = address('GAMMA7meSFWaBXF25oSUgmGRwaW6sCMFLmBNiMSdbHVT');
/** PDA ["vault_and_lp_mint_auth_seed"] equivalent — GAMMA's own AUTH_SEED PDA, one per program. Verified via getProgramDerivedAddress and against real swap tx account lists. */
const AUTHORITY = address('ALfS4oPB5684XwTvCjWw7XddFfmyTNdcY7xHxbh2Ui8s');
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// sha256("account:PoolState")[0..8] / sha256("account:AmmConfig")[0..8] — byte-identical to
// raydium-cp-swap's (same Anchor account type names on the shared struct prefix).
const POOL_STATE_DISCRIMINATOR = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
const AMM_CONFIG_DISCRIMINATOR = [0xda, 0xf4, 0x21, 0x68, 0xcb, 0xcb, 0x2b, 0x6f];
// sha256("global:oracle_based_swap_base_input")[0..8] — NOT swap_base_input, see module header.
const ORACLE_SWAP_DISCRIMINATOR = [0xef, 0x52, 0xc0, 0xbb, 0xa0, 0x1a, 0xdf, 0xdf];

const POOL_STATE_SIZE = 637;
const AMM_CONFIG_SIZE = 236;
const FEE_RATE_DENOMINATOR = 1_000_000n;
/** DEFAULT_MAX_FEE in fees/dynamic_fee.rs — used when pool_state.max_trade_fee_rate reads 0. */
const DEFAULT_MAX_TRADE_FEE_RATE = 100_000n;

// PoolState offsets (repr(packed), declared field order — states/pool.rs).
const POOL_OFFSETS = {
  ammConfig: 8,
  token0Vault: 72,
  token1Vault: 104,
  token0Mint: 168,
  token1Mint: 200,
  token0Program: 232,
  token1Program: 264,
  observationKey: 296,
  status: 329,
  openTime: 373,
  maxTradeFeeRate: 461,
  token0VaultAmount: 477,
  token1VaultAmount: 485,
};

/** SPL token account (Tokenkeg and Token-2022): mint @0, amount u64 LE @64. */
const VAULT_MINT_OFFSET = 0;
const VAULT_AMOUNT_OFFSET = 64;

export interface GammaPoolConfig extends PoolConfig {
  venue: typeof SLUG;
  ammConfig: Address;
  token0Vault: Address;
  token1Vault: Address;
  token0Mint: Address;
  token1Mint: Address;
  token0Program: Address;
  token1Program: Address;
  observation: Address;
  /** Bitfield; bit2 (value 4) = swap disabled. Gated at fetch time. */
  status: number;
  /** Unix seconds; the program rejects swaps while now < openTime. */
  openTime: bigint;
  /** Swap direction: true = token_0 in, token_1 out. fetchPoolConfig defaults to true; flip for the reverse direction. */
  inputIsToken0: boolean;
}

function gammaConfig(cfg: PoolConfig): GammaPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} adapter got a '${cfg.venue}' pool config`);
  return cfg as GammaPoolConfig;
}

/**
 * Token-2022 mint TLV scan for the TransferFeeConfig extension (type 1): a
 * transfer-fee mint changes wire amounts on both swap legs, so such pools are
 * out of scope (mirrors raydium-cp-swap's own gate — same account layout).
 */
function hasTransferFeeExtension(mint: Uint8Array): boolean {
  if (mint.length <= 165) return false;
  let offset = 166;
  while (offset + 4 <= mint.length) {
    const type = mint[offset]! | (mint[offset + 1]! << 8);
    if (type === 0) break; // Uninitialized — trailing padding
    if (type === 1) return true; // TransferFeeConfig
    const length = mint[offset + 2]! | (mint[offset + 3]! << 8);
    offset += 4 + length;
  }
  return false;
}

/** Fetch + decode one GAMMA pool (mirrors raydium-cp-swap's fetchPoolConfig gates). Read-only against the loader. */
export async function fetchGammaPoolConfig(load: AccountLoader, pool: Address): Promise<GammaPoolConfig> {
  const codec = getAddressCodec();
  const pubkey = (data: Uint8Array, offset: number): Address => codec.decode(data.subarray(offset, offset + 32)) as Address;

  const data = await load(pool);
  if (data === null) throw new Error(`${SLUG} pool ${pool} not found`);
  if (data.length !== POOL_STATE_SIZE) {
    throw new Error(`${SLUG} pool ${pool} data is ${data.length} bytes, expected ${POOL_STATE_SIZE}`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== POOL_STATE_DISCRIMINATOR[i]) {
      throw new Error(`${SLUG} pool ${pool} has a wrong discriminator (not a PoolState account)`);
    }
  }

  const status = Number(readUintLE(data, POOL_OFFSETS.status, 1));
  if ((status & 4) !== 0) {
    throw new Error(`${SLUG} pool ${pool} swap is disabled (status ${status} has bit 2 set)`);
  }
  const openTime = readUintLE(data, POOL_OFFSETS.openTime, 8);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < openTime) {
    throw new Error(`${SLUG} pool ${pool} is not open yet (open_time ${openTime}, now ${now})`);
  }

  const ammConfig = pubkey(data, POOL_OFFSETS.ammConfig);
  const configData = await load(ammConfig);
  if (configData === null) throw new Error(`${SLUG} amm config ${ammConfig} not found`);
  if (configData.length !== AMM_CONFIG_SIZE) {
    throw new Error(`${SLUG} amm config ${ammConfig} data is ${configData.length} bytes, expected ${AMM_CONFIG_SIZE}`);
  }
  for (let i = 0; i < 8; i++) {
    if (configData[i] !== AMM_CONFIG_DISCRIMINATOR[i]) {
      throw new Error(`${SLUG} amm config ${ammConfig} has a wrong discriminator (not an AmmConfig account)`);
    }
  }

  const cfg: GammaPoolConfig = {
    venue: SLUG,
    pool,
    ammConfig,
    token0Vault: pubkey(data, POOL_OFFSETS.token0Vault),
    token1Vault: pubkey(data, POOL_OFFSETS.token1Vault),
    token0Mint: pubkey(data, POOL_OFFSETS.token0Mint),
    token1Mint: pubkey(data, POOL_OFFSETS.token1Mint),
    token0Program: pubkey(data, POOL_OFFSETS.token0Program),
    token1Program: pubkey(data, POOL_OFFSETS.token1Program),
    observation: pubkey(data, POOL_OFFSETS.observationKey),
    status,
    openTime,
    inputIsToken0: true,
  };

  // Vault integrity: each pool vault must exist and hold the declared mint.
  for (const [vault, mint] of [
    [cfg.token0Vault, cfg.token0Mint],
    [cfg.token1Vault, cfg.token1Mint],
  ] as const) {
    const vaultData = await load(vault);
    if (vaultData === null) throw new Error(`${SLUG} vault ${vault} not found`);
    if (vaultData.length < VAULT_AMOUNT_OFFSET + 8) {
      throw new Error(`${SLUG} vault ${vault} data is ${vaultData.length} bytes, expected an SPL token account`);
    }
    const vaultMint = pubkey(vaultData, VAULT_MINT_OFFSET);
    if (vaultMint !== mint) {
      throw new Error(`${SLUG} vault ${vault} holds mint ${vaultMint}, expected ${mint}`);
    }
  }

  // Token-2022 transfer-fee gate: a transfer-fee extension on either mint
  // changes wire amounts on that leg, so the classic quote formula is wrong.
  for (const [program, mint, side] of [
    [cfg.token0Program, cfg.token0Mint, 'token_0'],
    [cfg.token1Program, cfg.token1Mint, 'token_1'],
  ] as const) {
    if (program !== TOKEN_2022_PROGRAM) continue;
    const mintData = await load(mint);
    if (mintData === null) {
      throw new Error(`${SLUG} ${side} mint ${mint} is token-2022 but could not be loaded to check transfer-fee extensions`);
    }
    if (hasTransferFeeExtension(mintData)) {
      throw new Error(`${SLUG} ${side} mint ${mint} has a token-2022 transfer-fee extension (wire amounts diverge from the quote)`);
    }
  }

  return cfg;
}

/** Family facade for the recipe orchestrator (ladder-only, like raydium-amm-v4/raydium-cp-swap). */
export const gamma = {
  slug: SLUG,
  programId: GAMMA_PROGRAM_ID,
  fetchPoolConfig: fetchGammaPoolConfig,
};

// ---------------------------------------------------------------------------
// Ladder (fragment emission + reference mirror). Flat-fee constant-product,
// same shape as raydium-amm-v4's ladder — the ONLY per-pool live reads are
// the two cached vault-amount fields and the fee ceiling, all inside
// PoolState itself (no separate vault/config account reads needed for the
// quote — the config account is still attached for the CPI, see buildSwapV2).
// ---------------------------------------------------------------------------
const ref = (slot: number, role: string): string => `s${slot}:${role}`;

export const gammaLadder: SvmVenueLadder = {
  slug: SLUG,
  shapeKey(base) {
    const cfg = gammaConfig(base);
    return `${SLUG}:${cfg.inputIsToken0 ? '0to1' : '1to0'}`;
  },
  // Fee is ceil-charged on the input (mirrors the program's ceil_div in
  // fees/mod.rs), curve floors (constant_product.rs's checked_div). feeRate
  // is the pool's max_trade_fee_rate ceiling — see module header for why
  // this is a SAFE (never-favourable) stand-in for the true dynamic rate.
  helpers() {
    return [
      {
        name: 'qGamma',
        source: [
          'function qGamma(x, rin, rout, fee) {',
          '  if (x === 0) { return 0 }',
          `  const f = (x * fee + ${FEE_RATE_DENOMINATOR - 1n}) / ${FEE_RATE_DENOMINATOR};`,
          '  if (f >= x) { return 0 }',
          '  const net = x - f;',
          '  return Math.mulDiv(net, rout, rin + net);',
          '}',
        ].join('\n'),
      },
    ];
  },
  /** Everything is a live read — no per-trade params. */
  paramCount: 0,
  paramsFor(_base) {
    return [];
  },
  quoteRefs(base, slot) {
    const cfg = gammaConfig(base);
    return [{ ref: ref(slot, 'pool'), address: cfg.pool }];
  },
  emitSetup(base, slot) {
    const cfg = gammaConfig(base);
    const pool = JSON.stringify(ref(slot, 'pool'));
    const [inOff, outOff] = cfg.inputIsToken0
      ? [POOL_OFFSETS.token0VaultAmount, POOL_OFFSETS.token1VaultAmount]
      : [POOL_OFFSETS.token1VaultAmount, POOL_OFFSETS.token0VaultAmount];
    return [
      `  const s${slot}rin = accountUint(${pool}, ${inOff}, 8);`,
      `  const s${slot}rout = accountUint(${pool}, ${outOff}, 8);`,
      `  const s${slot}mfee = accountUint(${pool}, ${POOL_OFFSETS.maxTradeFeeRate}, 8);`,
      `  let s${slot}fee = s${slot}mfee;`,
      `  if (${`s${slot}mfee`} === 0) { s${slot}fee = ${DEFAULT_MAX_TRADE_FEE_RATE} }`,
    ].join('\n');
  },
  emitQuoteCall(_base, slot, x) {
    return `qGamma(${x}, s${slot}rin, s${slot}rout, s${slot}fee)`;
  },
  buildSwapV2(base, slot, user: SwapUser): LadderSwapTemplate {
    const cfg = gammaConfig(base);
    const [inMint, outMint] = cfg.inputIsToken0 ? [cfg.token0Mint, cfg.token1Mint] : [cfg.token1Mint, cfg.token0Mint];
    const [inProg, outProg] = cfg.inputIsToken0
      ? [cfg.token0Program, cfg.token1Program]
      : [cfg.token1Program, cfg.token0Program];
    // oracle_based_swap_base_input: disc(8) ++ amount_in u64 LE (runtime-patched) ++
    // minimum_amount_out u64 LE = 1 (the recipe's terminal delta check enforces the real bound).
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: GAMMA_PROGRAM_ID,
      prefix: Uint8Array.from(ORACLE_SWAP_DISCRIMINATOR),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: [
        { ref: user.owner, signer: true },
        roled('auth', AUTHORITY),
        roled('cfg', cfg.ammConfig),
        roled('pool', cfg.pool, true),
        { ref: user.inAta, writable: true },
        { ref: user.outAta, writable: true },
        roled('vin', cfg.inputIsToken0 ? cfg.token0Vault : cfg.token1Vault, true),
        roled('vout', cfg.inputIsToken0 ? cfg.token1Vault : cfg.token0Vault, true),
        roled('tpin', inProg),
        roled('tpout', outProg),
        roled('min', inMint),
        roled('mout', outMint),
        roled('obs', cfg.observation, true),
      ],
    };
  },
  referenceQuote(base, state: AccountBytesMap) {
    const cfg = gammaConfig(base);
    const bytes = (addr: string): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
      return data;
    };
    const pool = bytes(cfg.pool);
    const [inOff, outOff] = cfg.inputIsToken0
      ? [POOL_OFFSETS.token0VaultAmount, POOL_OFFSETS.token1VaultAmount]
      : [POOL_OFFSETS.token1VaultAmount, POOL_OFFSETS.token0VaultAmount];
    const rin = readUintLE(pool, inOff, 8);
    const rout = readUintLE(pool, outOff, 8);
    const rawFee = readUintLE(pool, POOL_OFFSETS.maxTradeFeeRate, 8);
    const feeRate = rawFee === 0n ? DEFAULT_MAX_TRADE_FEE_RATE : rawFee;
    return (x: bigint): bigint => {
      if (x === 0n) return 0n;
      const fee = (x * feeRate + FEE_RATE_DENOMINATOR - 1n) / FEE_RATE_DENOMINATOR;
      if (fee >= x) return 0n;
      const net = x - fee;
      return (net * rout) / (rin + net);
    };
  },
  depthReserves(base, state: AccountBytesMap) {
    const cfg = gammaConfig(base);
    const pool = state[cfg.pool];
    if (pool === undefined) throw new Error(`${SLUG} ladder depth is missing account ${cfg.pool}`);
    const r0 = readUintLE(pool, POOL_OFFSETS.token0VaultAmount, 8);
    const r1 = readUintLE(pool, POOL_OFFSETS.token1VaultAmount, 8);
    return cfg.inputIsToken0 ? { reserveIn: r0, reserveOut: r1 } : { reserveIn: r1, reserveOut: r0 };
  },
  continuousFees(base, state: AccountBytesMap) {
    const cfg = gammaConfig(base);
    const pool = state[cfg.pool];
    if (pool === undefined) throw new Error(`${SLUG} ladder fees are missing account ${cfg.pool}`);
    const rawFee = readUintLE(pool, POOL_OFFSETS.maxTradeFeeRate, 8);
    const feeRate = rawFee === 0n ? DEFAULT_MAX_TRADE_FEE_RATE : rawFee;
    return { gammaPpm: FEE_RATE_DENOMINATOR - feeRate, muPpm: FEE_RATE_DENOMINATOR };
  },
};
