/**
 * Mercurial Finance Stable Swap (`stable-swap-n-pool`) — the pre-Meteora
 * multi-token stableswap, program `MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky`
 * (same address on mainnet-beta and devnet; Saber's own `stable-swap`
 * program is a documented fork of this exact codebase, which is why the
 * Newton math below matches saber-stableswap's `ann = amp*2` convention
 * bit-for-bit rather than the generalized Curve `ann = amp*n^n`).
 *
 * Layout source: `mercurial-finance/stable-swap-n-pool-instructions`
 * (`src/state.rs`'s `SwapV2`, `src/instruction.rs`'s `SwapInstruction`) and
 * `mercurial-finance/stable-swap-n-pool-js` (`src/index.ts`'s
 * `FEE_DENOMINATOR = 1e10`, the client account ordering for `Exchange`).
 * `SwapV2` is a Vec-backed struct but every array is declared at its
 * compile-time MAX (`PoolParameter::MAX_N_COINS = 4`), so every pool account
 * is a FIXED 265 bytes (1 version tag + `SwapV2::LEN` 264) regardless of how
 * many of the 4 coin slots are actually in use — `getProgramAccounts`
 * filtered on `dataSize: 265` finds every pool with no memcmp needed (the
 * -32010 the brief warns about is a Helius secondary-index limit on an
 * UNFILTERED gPA call; a plain `dataSize` filter is a primary index and
 * works directly, confirmed live: 24 pools returned in one call).
 *
 * THIS ADAPTER IS 2-COIN ONLY (a deliberate, checked scope limit, not a
 * layout gap): `stableComputeD`/`stableComputeYWarm` (shared with
 * saber-stableswap and meteora-damm-v1-stable) implement the CLASSIC 2-asset
 * invariant (`ann = amp*2`); a genuinely N>2 Mercurial pool (real examples
 * exist on-chain, e.g. 3- and 4-coin USD baskets) needs the generalized
 * N-coin Newton iteration (`ann = amp*n^n`, D/Y summed over every balance),
 * which is different math this repo does not implement. `fetchPoolConfig`
 * throws (self-drops the pool, never emits wrong-math bytecode) whenever
 * `tokens_len !== 2`.
 *
 * PRECISION MULTIPLIERS — the wrinkle Saber's 2-token-only design never
 * needed: each coin slot carries a live `precision_multipliers[i]` (u64,
 * `SetPrecisionMultipliers`-admin-settable) that both aligns decimals AND
 * bakes in a fixed exchange-rate snapshot for yield-bearing pairs (measured
 * live 2026-07-31: the mSOL/SOL pool `MAR1zHjHaQcniE2gXsDptkyKUnNfMEsLBVcfP7vLyv7`
 * carries `[1000, 1128]` — 1.128 being that pool's mSOL/SOL rate at whatever
 * point an admin last called `SetPrecisionMultipliers`, NOT live-updating
 * per-trade). The invariant math runs on VIRTUAL balances
 * `raw_reserve_i * precision_multipliers[i]` — homogeneous-degree-1 in the
 * multiplier choice, so D/Y math is exact for ANY shared scale, and only the
 * de-normalization (`virtual / precision_multipliers[dst]`) and the FEE
 * matter for byte-exactness. VALIDATED against the REAL deployed program
 * (see below) that the fee itself must be taken IN VIRTUAL SPACE before
 * de-normalizing — `dyRaw = floor((dyVirtual - floor(dyVirtual*fn/1e10)) / dstMult)`,
 * NOT `floor(dyVirtual/dstMult) - floor(floor(dyVirtual/dstMult)*fn/1e10)` —
 * the latter is off by up to a few raw units on any pool with a non-unit
 * multiplier (measured +1 raw-unit residual at 2 of 3 tested sizes on the
 * mSOL/SOL pool before the fix; 0 residual after, at all tested sizes on all
 * three real pools below).
 *
 * NO AMP RAMP: unlike Saber (and unlike Curve's usual `start/target/ramp_ts`
 * quad), Mercurial's `SwapV2.amplification_coefficient` is a single live u64
 * that `AdminSetting::SetAmplificationCoefficient` overwrites INSTANTLY —
 * there is no time-interpolated ramp field in the account at all (confirmed
 * from `state.rs`: the struct has no `initial_amp`/`target_amp`/ramp
 * timestamps, only the one field). The fragment therefore just reads amp
 * live, no branch.
 *
 * `admin_fee_numerator` is a stored-but-UNUSED field (`state.rs`'s own doc
 * comment: "Admin fee numerator, not implemented") — every sampled live pool
 * (24, all admin_fee_numerator = 0) confirms it; this adapter never reads it.
 * `FEE_DENOMINATOR` is a fixed protocol constant (`1e10`, from the JS SDK),
 * NOT a per-pool stored field, so it is baked as a compile-time literal.
 *
 * BIDIRECTIONAL: unlike Saber (asymmetric admin-fee-destination account,
 * A->B only in this codebase) and meteora-damm-v1-stable, Mercurial's
 * `Exchange` instruction accounts are fully symmetric — both vaults ride the
 * account list in STORED order regardless of which mint is source/dest, and
 * there is no direction-specific admin-fee account at all. So this adapter
 * serves BOTH `aToB` and `bToA`, doubling real coverage over the Saber
 * precedent for no extra on-chain cost.
 *
 * VALIDATED against the REAL deployed program on REAL mainnet state (LiteSVM
 * `simulateTransaction`, `sigVerify:false` impersonating a real token holder
 * as `userTransferAuthority` — never a funds-moving tx) at 3+ sizes on THREE
 * independent real pools, RE-CONFIRMED at fixture-capture time (2026-07-31;
 * these pools trade continuously — a pool's live reserves are a MOVING
 * TARGET, so `test/svm/venues/mercurial.test.ts`'s pinned numbers are a
 * regression pin against its OWN checked-in fixture snapshot, not a
 * permanent real-time truth — re-derive if the fixtures are ever recaptured):
 *  - `SoLw5ovBPNfodtAbxqEKHLGppyrdB4aZthdGwpfpQgi` (mult=[1,1], SOL vs an
 *    unlabeled SPL mint): 1/10/50 tokens, bit-exact at all three.
 *  - `MAR1zHjHaQcniE2gXsDptkyKUnNfMEsLBVcfP7vLyv7` (SOL/mSOL, mult=[1000,1128]):
 *    1/5/20 mSOL, bit-exact at all three (post-fix; see the fee-rounding note
 *    above for the pre-fix residual).
 *  - `LiDoU8ymvYptqxenJ4YpcURBchn4ef63tcbdznBCKJh` (stSOL/SOL, mult=[1122,1000]):
 *    1/10/30 stSOL, bit-exact at all three.
 * See `test/svm/venues/mercurial.test.ts` for the pinned worked examples.
 *
 * NO `ecoswap-svm.realcpi.e2e.test.ts` CELL (unlike every other SAUCE_VENUE_PROGRAMS-gated
 * venue): driving the real dumped `mercurial.so` through a raw single Exchange
 * CPI in LiteSVM (same pool/accounts/encoding the real-network probe above
 * validates) reproducibly fails a RUNTIME-LEVEL "sum of account balances
 * before and after instruction do not match" check — AFTER the program's own
 * logic (GetFeeAmount, GetDyUnderlying, both inner SPL transfers) already
 * completes correctly and reproduces the exact real-network quote. This is
 * independent of pool / precision-multiplier / lamport magnitude / SPL
 * `is_native` flagging / LiteSVM feature set (all varied individually, zero
 * change in outcome or CU) and is read as a LiteSVM-specific compatibility
 * gap with this one 2021-era non-Anchor binary — `simulateTransaction`
 * against REAL mainnet-beta runs the SAME Agave runtime code path as full
 * execution (unlike LiteSVM's independent reimplementation) and succeeds
 * cleanly, which is why the real-network probe above is trusted as the
 * fund-safety proof. budget.ts's `mercurial` CU_FAMILIES entry documents the
 * real CPI's OWN measured compute cost (61_473 CU, captured before that
 * runtime check fires) and folds it into the pin with a safety margin.
 *
 * Gates: 265-byte account size, version byte == 2 (SwapV2), initialized,
 * exactly 2 coin slots, both vault accounts classic-SPL (165 bytes) and
 * owned by the derived authority. `swap_enabled` is a live-reversible admin
 * toggle (same class as Saber's `is_paused`) — NOT a fetch-time gate; the
 * fragment re-checks it live every trade (a disabled pool quotes 0 and never
 * pays its CPI, the same self-drop-by-zero-quote convention Saber uses).
 */
import { createHash } from 'node:crypto';
import { address, getAddressDecoder, getAddressEncoder, isOffCurveAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import { STABLE_D_HELPER, STABLE_YW_HELPER, stableComputeD, stableComputeYWarm } from '../stable-helpers.js';
import type { AccountBytesMap, AccountLoader, PoolConfig, SvmVenueLadderV2, SwapUser, VenueAccount } from '../types.js';

const SLUG = 'mercurial';

export const MERCURIAL_PROGRAM_ID = address('MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky');
// Mercurial predates Token-2022; every sampled vault is classic Tokenkeg.
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** 1 (version tag) + SwapV2::LEN (264, PoolParameter::MAX_N_COINS = 4 baked into the fixed-size arrays). */
const SWAP_STATE_LEN = 265;
/** Classic (non-Token-2022) SPL Token Account encoding length. */
const SPL_TOKEN_ACCOUNT_LEN = 165;
const OFF_SPL_AMOUNT = 64;

// SwapV2 offsets (absolute, i.e. including the leading version-tag byte — see module header).
const OFF_NONCE = 2;
const OFF_AMP = 3;
const OFF_FEE_NUM = 11;
const OFF_TOKENS_LEN = 27;
const OFF_MULT_A = 39;
const OFF_MULT_B = 47;
const OFF_VAULT_A = 71;
const OFF_VAULT_B = 103;
const OFF_SWAP_ENABLED = 263;

/** Fixed protocol constant (mercurial-js `FEE_DENOMINATOR = Math.pow(10, 10)`) — not a per-pool field. */
const FEE_DENOMINATOR = 10_000_000_000n;

export interface MercurialPoolConfig extends PoolConfig {
  venue: typeof SLUG;
  direction: 'aToB' | 'bToA';
  nonce: number;
  authority: Address;
  vaultA: Address;
  vaultB: Address;
  mintA: Address;
  mintB: Address;
}

function mercurialConfig(cfg: PoolConfig): MercurialPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as MercurialPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/**
 * create_program_address([pool (32B), [nonce]], programId) — identical
 * scheme to saber-stableswap's `deriveSwapAuthority` (Mercurial's own client
 * derives the SAME seeds via `findProgramAddress([pool], programId)`, whose
 * auto-appended bump IS the stored nonce for any canonically-initialized
 * pool; using the STORED nonce directly, like Saber, is exact even for a
 * hypothetical non-canonical nonce).
 */
async function deriveMercurialAuthority(pool: Address, nonce: number): Promise<Address> {
  const encoder = getAddressEncoder();
  const digest = createHash('sha256')
    .update(encoder.encode(pool) as Uint8Array)
    .update(Uint8Array.of(nonce))
    .update(encoder.encode(MERCURIAL_PROGRAM_ID) as Uint8Array)
    .update('ProgramDerivedAddress')
    .digest();
  const authority = getAddressDecoder().decode(digest);
  if (!isOffCurveAddress(authority)) {
    throw new Error(`${SLUG} pool ${pool} nonce ${nonce} derives an on-curve swap authority`);
  }
  return authority;
}

/** Fetch + decode one Mercurial SwapV2 pool, plus its two vaults' mints. Read-only against the loader. */
export async function fetchMercurialPoolConfig(load: AccountLoader, pool: Address): Promise<MercurialPoolConfig> {
  const data = await load(pool);
  if (data === null) throw new Error(`${SLUG}: pool account ${pool} not found`);
  if (data.length !== SWAP_STATE_LEN) {
    throw new Error(`${SLUG}: pool ${pool} data must be ${SWAP_STATE_LEN} bytes (SwapState), got ${data.length}`);
  }
  if (data[0] !== 2) throw new Error(`${SLUG}: pool ${pool} is not SwapV2 (version tag ${data[0]})`);
  if (data[1] !== 1) throw new Error(`${SLUG}: pool ${pool} is not initialized`);

  const tokensLen = Number(readUintLE(data, OFF_TOKENS_LEN, 4));
  if (tokensLen !== 2) {
    throw new Error(`${SLUG}: pool ${pool} has ${tokensLen} coin slots — only 2-coin pools are supported (see module header)`);
  }

  const nonce = data[OFF_NONCE];
  const pubkey = getAddressDecoder();
  const vaultA = pubkey.decode(data, OFF_VAULT_A);
  const vaultB = pubkey.decode(data, OFF_VAULT_B);
  const authority = await deriveMercurialAuthority(pool, nonce);

  const [vaultAData, vaultBData] = await Promise.all([load(vaultA), load(vaultB)]);
  if (vaultAData === null) throw new Error(`${SLUG}: pool ${pool} vault A ${vaultA} not found`);
  if (vaultBData === null) throw new Error(`${SLUG}: pool ${pool} vault B ${vaultB} not found`);
  if (vaultAData.length !== SPL_TOKEN_ACCOUNT_LEN) {
    throw new Error(`${SLUG}: pool ${pool} vault A ${vaultA} is not a classic SPL token account`);
  }
  if (vaultBData.length !== SPL_TOKEN_ACCOUNT_LEN) {
    throw new Error(`${SLUG}: pool ${pool} vault B ${vaultB} is not a classic SPL token account`);
  }
  const mintA = pubkey.decode(vaultAData, 0);
  const mintB = pubkey.decode(vaultBData, 0);
  const vaultAOwner = pubkey.decode(vaultAData, 32);
  const vaultBOwner = pubkey.decode(vaultBData, 32);
  if (vaultAOwner !== authority) {
    throw new Error(`${SLUG}: pool ${pool} vault A owner ${vaultAOwner} does not match the derived authority ${authority}`);
  }
  if (vaultBOwner !== authority) {
    throw new Error(`${SLUG}: pool ${pool} vault B owner ${vaultBOwner} does not match the derived authority ${authority}`);
  }

  return {
    venue: SLUG,
    pool,
    direction: 'aToB',
    nonce,
    authority,
    vaultA,
    vaultB,
    mintA,
    mintB,
  };
}

/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm/saber-stableswap). */
export const mercurial = {
  slug: SLUG,
  programId: MERCURIAL_PROGRAM_ID,
  tokenProgram: TOKEN_PROGRAM,
  fetchPoolConfig: fetchMercurialPoolConfig,
};

// ---------------------------------------------------------------------------
// Ladder (fragment emission + reference mirror). Newton math shared verbatim
// with saber-stableswap / meteora-damm-v1-stable via the SDK barrel's
// stable-helpers (dedupe-safe: the codegen merges helpers by {name, source}).

interface MercurialLive {
  enabled: boolean;
  src: bigint;
  dst: bigint;
  smu: bigint;
  dmu: bigint;
  amp: bigint;
  fn: bigint;
  vsrc: bigint;
  vdst: bigint;
  /** 0 when the slot is unquotable (disabled / empty reserve) — the master validity flag. */
  d: bigint;
}

function liveState(cfg: MercurialPoolConfig, state: AccountBytesMap): MercurialLive {
  const bytes = (addr: Address): Uint8Array => {
    const data = state[addr];
    if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
    return data;
  };
  const pool = bytes(cfg.pool);
  const enabled = pool[OFF_SWAP_ENABLED] !== 0;
  const aToB = cfg.direction === 'aToB';
  const srcVault = aToB ? cfg.vaultA : cfg.vaultB;
  const dstVault = aToB ? cfg.vaultB : cfg.vaultA;
  const srcMultOff = aToB ? OFF_MULT_A : OFF_MULT_B;
  const dstMultOff = aToB ? OFF_MULT_B : OFF_MULT_A;
  const src = readUintLE(bytes(srcVault), OFF_SPL_AMOUNT, 8);
  const dst = readUintLE(bytes(dstVault), OFF_SPL_AMOUNT, 8);
  const smu = readUintLE(pool, srcMultOff, 8);
  const dmu = readUintLE(pool, dstMultOff, 8);
  const amp = readUintLE(pool, OFF_AMP, 8);
  const fn = readUintLE(pool, OFF_FEE_NUM, 8);
  const vsrc = src * smu;
  const vdst = dst * dmu;
  const d = enabled && vsrc > 0n && vdst > 0n ? stableComputeD(amp, vsrc, vdst) : 0n;
  return { enabled, src, dst, smu, dmu, amp, fn, vsrc, vdst, d };
}

/**
 * dyVirtual = vdst - y - 1 (the -1 rounding buffer, in VIRTUAL units), fee
 * taken IN VIRTUAL SPACE, THEN de-normalized (floor) to raw dst units — see
 * the module header for the empirical validation that fixed the rounding
 * order (fee-after-de-normalize is off by up to 1 raw unit on a non-unit
 * multiplier pool).
 */
function outFromVirtualY(live: MercurialLive, y: bigint): bigint {
  if (live.vdst <= y) return 0n;
  const dyVirtual = live.vdst - y - 1n;
  const feeVirtual = (dyVirtual * live.fn) / FEE_DENOMINATOR;
  return (dyVirtual - feeVirtual) / live.dmu;
}

export const mercurialLadder = {
  slug: SLUG,

  /** Stable slots default to 2 rungs (cap 4) — a Newton quote is ~2 orders costlier than a CP one. */
  defaultRungs: 2,

  shapeKey(base: PoolConfig): string {
    const cfg = mercurialConfig(base);
    return `${SLUG}:${cfg.direction}`;
  },

  helpers(): { name: string; source: string }[] {
    return [STABLE_D_HELPER, STABLE_YW_HELPER];
  },

  /** Everything is a live read — no per-trade params. */
  paramCount: 0,

  paramsFor(_base: PoolConfig): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = mercurialConfig(base);
    return [
      { ref: ref(slot, 'pool'), address: cfg.pool },
      { ref: ref(slot, 'va'), address: cfg.vaultA },
      { ref: ref(slot, 'vb'), address: cfg.vaultB },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string {
    const cfg = mercurialConfig(base);
    const pool = JSON.stringify(ref(slot, 'pool'));
    const aToB = cfg.direction === 'aToB';
    const srcVaultRef = JSON.stringify(ref(slot, aToB ? 'va' : 'vb'));
    const dstVaultRef = JSON.stringify(ref(slot, aToB ? 'vb' : 'va'));
    const srcMultOff = aToB ? OFF_MULT_A : OFF_MULT_B;
    const dstMultOff = aToB ? OFF_MULT_B : OFF_MULT_A;
    const enabled = enableVar ?? `s${slot}en`;
    return [
      `  const s${slot}en2 = accountUint(${pool}, ${OFF_SWAP_ENABLED}, 1);`,
      `  const s${slot}src = accountUint(${srcVaultRef}, ${OFF_SPL_AMOUNT}, 8);`,
      `  const s${slot}dst = accountUint(${dstVaultRef}, ${OFF_SPL_AMOUNT}, 8);`,
      `  const s${slot}smu = accountUint(${pool}, ${srcMultOff}, 8);`,
      `  const s${slot}dmu = accountUint(${pool}, ${dstMultOff}, 8);`,
      `  const s${slot}amp = accountUint(${pool}, ${OFF_AMP}, 8);`,
      `  const s${slot}fn = accountUint(${pool}, ${OFF_FEE_NUM}, 8);`,
      `  const s${slot}vsrc = s${slot}src * s${slot}smu;`,
      `  const s${slot}vdst = s${slot}dst * s${slot}dmu;`,
      // Newton D — ONCE per trade, only for an enabled, funded slot. d == 0
      // is the master validity flag every quote checks (mirrors saber).
      `  let s${slot}d = 0;`,
      `  if (${enabled} !== 0 && s${slot}en2 !== 0 && s${slot}vsrc > 0 && s${slot}vdst > 0) { s${slot}d = stableD(s${slot}amp, s${slot}vsrc, s${slot}vdst) }`,
    ].join('\n');
  },

  emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string {
    const lines: string[] = [];
    // The warm cursor: rung 0 seeds from D (the venue's own cold start).
    if (rung === 0) lines.push(`    let s${slot}wy = s${slot}d;`);
    lines.push(
      `    let ${outVar} = 0;`,
      `    if (s${slot}d > 0 && ${x} > 0) {`,
      `      s${slot}wy = stableYW(s${slot}amp, s${slot}vsrc + ${x} * s${slot}smu, s${slot}d, s${slot}wy);`,
      `      if (s${slot}vdst > s${slot}wy) {`,
      `        const s${slot}dv${rung} = s${slot}vdst - s${slot}wy - 1;`,
      `        const s${slot}fv${rung} = Math.mulDiv(s${slot}dv${rung}, s${slot}fn, ${FEE_DENOMINATOR});`,
      `        ${outVar} = (s${slot}dv${rung} - s${slot}fv${rung}) / s${slot}dmu;`,
      '      }',
      '    }',
    );
    return lines.join('\n');
  },

  emitFinalQuote(_base: PoolConfig, slot: number, x: string, outVar: string): string {
    // COLD: y0 = D — byte-identical to the venue's own from-scratch compute_y.
    return [
      `  let ${outVar} = 0;`,
      `  if (s${slot}d > 0 && ${x} > 0) {`,
      `    const s${slot}fy = stableYW(s${slot}amp, s${slot}vsrc + ${x} * s${slot}smu, s${slot}d, s${slot}d);`,
      `    if (s${slot}vdst > s${slot}fy) {`,
      `      const s${slot}fdv = s${slot}vdst - s${slot}fy - 1;`,
      `      const s${slot}ffv = Math.mulDiv(s${slot}fdv, s${slot}fn, ${FEE_DENOMINATOR});`,
      `      ${outVar} = (s${slot}fdv - s${slot}ffv) / s${slot}dmu;`,
      '    }',
      '  }',
    ].join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser) {
    const cfg = mercurialConfig(base);
    // tag 0x04 (Exchange) ++ in_amount u64 LE (runtime-patched) ++
    // minimum_out_amount u64 LE = 1 (the recipe's terminal delta check
    // enforces the real bound). Accounts per mercurial-finance's own
    // stable-swap-n-pool-js `SwapInstruction.exchange` (validated against the
    // real program, see module header): swapInfo(w), TOKEN_PROGRAM, authority,
    // userTransferAuthority(signer), BOTH vaults in STORED order (symmetric —
    // direction never changes this list), userSource(w), userDest(w).
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: MERCURIAL_PROGRAM_ID,
      prefix: Uint8Array.from([0x04]),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in' as const,
      accounts: [
        roled('pool', cfg.pool, true),
        roled('tp', TOKEN_PROGRAM),
        roled('auth', cfg.authority),
        { ref: user.owner, signer: true },
        roled('va', cfg.vaultA, true),
        roled('vb', cfg.vaultB, true),
        { ref: user.inAta, writable: true },
        { ref: user.outAta, writable: true },
      ],
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], _now?: bigint): (x: bigint) => bigint {
    const live = liveState(mercurialConfig(base), state);
    return (x: bigint): bigint => {
      if (live.d === 0n || x === 0n) return 0n;
      const y = stableComputeYWarm(live.amp, live.vsrc + x * live.smu, live.d, live.d); // COLD
      return outFromVirtualY(live, y);
    };
  },

  referenceLadderQuotes(
    base: PoolConfig,
    state: AccountBytesMap,
    _params: readonly bigint[],
    _now?: bigint,
  ): (grid: readonly bigint[]) => bigint[] {
    const live = liveState(mercurialConfig(base), state);
    return (grid: readonly bigint[]): bigint[] => {
      let wy = live.d;
      return grid.map((g) => {
        if (live.d === 0n || g === 0n) return 0n; // wy unchanged, exactly like the fragment
        wy = stableComputeYWarm(live.amp, live.vsrc + g * live.smu, live.d, wy);
        return outFromVirtualY(live, wy);
      });
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const live = liveState(mercurialConfig(base), state);
    return { reserveIn: live.src, reserveOut: live.dst };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap): { gammaPpm: bigint; muPpm: bigint } {
    const live = liveState(mercurialConfig(base), state);
    // Output-side fee retention; the CP form badly understates a stable
    // curve's depth — measurement oracle only, never a gate (like saber).
    return { gammaPpm: 1_000_000n, muPpm: 1_000_000n - (live.fn * 1_000_000n) / FEE_DENOMINATOR };
  },
} satisfies SvmVenueLadderV2;
