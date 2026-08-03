/**
 * XOrca (SvmRoute ladder fragment) — Orca's liquid-staking wrapper: stake
 * ORCA into a single global vault and mint xORCA shares at the vault's live
 * ratio. No on-chain IDL is published, but the program (`orca-so/xorca` on
 * GitHub, Pinocchio + shank-generated) is open source; this adapter is a
 * direct, byte-verified port of its instruction/state layout and math, NOT a
 * reverse-engineered approximation.
 *
 * ── Why only ONE direction is a venue (see file header item below) ──
 *
 * The program exposes three swap-adjacent instructions: `Stake` (ORCA in,
 * xORCA out, ATOMIC — mints and delivers in one instruction),
 * `Unstake` (burns xORCA, creates a `PendingWithdraw` account, delivers
 * NOTHING now), and `Withdraw` (delivers the ORCA, but only after
 * `cool_down_period_s` has elapsed — LIVE-VERIFIED at 604,800s = exactly 7
 * days by decoding the real State account, `state.json` in this venue's test
 * fixtures, offset 16, matching Orca's own published 7-day unstake cooldown).
 * `Unstake` therefore CANNOT be a Sauce venue leg: it does not deliver its
 * output atomically, only a claim redeemable in a separate transaction days
 * later. This is a STRUCTURAL fact about the program, not a permission or
 * whitelist gap — `xorcaLadder` only ever implements the `Stake` direction
 * (ORCA -> xORCA); there is no `direction` field to flip (unlike every other
 * family in `FAMILIES`, which is why `ecoswap/svm/index.ts`'s `xorca` entry
 * carries no `REVERSE_DIRECTION` entry, the same shape as `saber-stableswap`
 * and `orca-legacy-token-swap`, which are also single-direction-only).
 *
 * ── Verified account/instruction layout (orca-so/xorca @ main, fetched 2026-07-31) ──
 *
 * `solana-program/src/state/state.rs`: `State` is a fixed 2048-byte account,
 * `#[repr(C)]`, discriminator(1) + padding(5) + bump(1) + vault_bump(1) +
 * escrowed_orca_amount(u64 LE, offset 8) + cool_down_period_s(i64 LE, offset
 * 16) + update_authority(32) + padding(1992). There is exactly ONE State
 * account in existence (seed `["state"]`, no per-pair proliferation) — this
 * is a SINGLETON venue, not a multi-pool family, so `pool` is always
 * `XORCA_STATE_PDA` and there is no `getProgramAccounts` geometry to publish
 * (mints are hardcoded program constants, `cpi/token/mod.rs`'s `ORCA_MINT_ID`/
 * `XORCA_MINT_ID`, never stored as pool-account bytes at any offset — see
 * `ecoswap/svm/discovery.ts`'s `withXorcaStaticCandidates` for how this venue
 * is discovered instead of via `SVM_FAMILY_FILTERS`).
 *
 * `solana-program/src/instructions/mod.rs`'s `Instruction` enum (Borsh,
 * variant index = declaration order, 0-based; NOT reordered by
 * `strum::EnumDiscriminants`, which only affects the DERIVED
 * `InstructionDiscriminator` type, never Borsh's own enum tag): `Stake=0`,
 * `Unstake=1`, `Withdraw=2`, `Initialize=3`, `Set=4`. `Stake{orca_stake_amount:u64}`
 * therefore serializes to exactly 9 bytes: `[0][u64 LE]` — CONFIRMED against
 * 3 real mainnet transactions (decoded instruction data `00...`, see below).
 *
 * `Stake`'s account list (`solana-program/src/instructions/stake.rs` +
 * its `#[account(...)]` shank annotations):
 *   0 staker_account       signer, writable  — the CPI caller (user.owner)
 *   1 vault_account        writable          — XORCA_VAULT_ATA
 *   2 staker_orca_ata      writable          — user.inAta
 *   3 staker_xorca_ata     writable          — user.outAta
 *   4 xorca_mint_account   writable          — XORCA_MINT_ID
 *   5 state_account        (read-only)       — XORCA_STATE_PDA
 *   6 orca_mint_account    (read-only)       — ORCA_MINT_ID
 *   7 token_program_account (read-only)      — SPL_TOKEN_PROGRAM_ID
 * CONFIRMED byte-for-byte against 3 real mainnet `Stake` transactions'
 * `accountKeys` (getTransaction, 2026-07-31): every account at every index
 * above matches, INCLUDING that `XORCA_STATE_PDA`/`XORCA_VAULT_ATA` (this
 * file's constants, independently re-derived via `getProgramDerivedAddress`
 * from the documented seeds) are the exact addresses those transactions use,
 * and that `State.bump`/`State.vault_bump` decoded from the live account
 * (250/254) equal the bumps those PDA derivations produce.
 *
 * ── Quote math — an EXACT port, not an approximation (`util/math.rs`) ──
 *
 * `convert_orca_to_xorca(orcaIn, nonEscrowedOrca, xorcaSupply)`:
 *   nonEscrowedOrca == 0 || xorcaSupply == 0 -> return orcaIn (1:1 bootstrap,
 *     dead in practice — the live pool has ~7.45M ORCA / ~4.77M xORCA, see
 *     below — kept for completeness, never reachable via this ladder's
 *     `qXorca` because both denominators below already carry the +100
 *     virtual offset and can never be 0).
 *   else -> floor(orcaIn * (xorcaSupply + 100) / (nonEscrowedOrca + 100))
 * `nonEscrowedOrca = vault.amount - state.escrowed_orca_amount` (the vault
 * ATA's live SPL balance minus the ORCA currently reserved for pending
 * `Unstake` claims — `escrowed_orca_amount` is NOT itself a vault-balance
 * concept, it lives on the `State` account).
 * VIRTUAL_XORCA_SUPPLY = VIRTUAL_NON_ESCROWED_ORCA_AMOUNT = 100 (raw base
 * units, ERC-4626-style inflation-attack offset) — negligible at the pool's
 * real scale (millions of raw-unit-scaled tokens) but ported EXACTLY, not
 * dropped, so this fragment's output matches the deployed program to the
 * LAST WEI, not just approximately.
 *
 * Because minting shares does not touch any OTHER trader's counterparty
 * reserve (staking is impact-FREE: after a stake of x, vault and supply both
 * grow by the same relative amount, so the very next wei stakes at the exact
 * same rate — verified analytically and empirically below), the quote curve
 * is EXACTLY LINEAR over the rung grid: strictly monotone non-decreasing,
 * trivially concave (a flat marginal price satisfies "non-increasing
 * marginal" with equality). This is the BEST case for the merge, not the
 * "coarse/non-monotone ladder gets allocated ZERO" hazard CLAUDE.md warns
 * about — that hazard is about a WRONG curve, not a genuinely flat one.
 *
 * ── Validated against the REAL deployed program on REAL mainnet state ──
 *
 * Live state fetched 2026-07-31 (this venue's `test/svm/fixtures/xorca/`):
 * vault.amount = 7,615,177,202,770 (7,615,177.202770 ORCA, 6 decimals),
 * state.escrowed_orca_amount = 163,973,096,167, xORCA mint supply =
 * 4,772,054,556,591 -> nonEscrowedOrca = 7,451,204,106,603.
 *
 * `qXorca` at four sizes on that exact snapshot: 1 ORCA (1e6) -> 640,440
 * xORCA-raw; 1,000 ORCA (1e9) -> 640,440,724; 100,000 ORCA (1e11) ->
 * 64,044,072,452; 5,000,000 ORCA (5e12) -> 3,202,203,622,632 — the marginal
 * rate (out/in) is IDENTICAL to 10 significant figures across all four sizes
 * (640,440.7245 per 1e6 in, every time), confirming the analytical
 * flat-curve claim above, not just asserting it.
 *
 * Cross-checked against 3 REAL mainnet `Stake` transactions (getTransaction,
 * 2026-07-31), applying THIS SAME formula to the CURRENT (not historical)
 * snapshot above (state moves only via subsequent stakes/unstakes, so a
 * residual is expected and is the ENTIRE explanation for the gap — see the
 * relative errors, all three sub-0.005%, growing with how many slots have
 * elapsed since each transaction, exactly as vault drift would predict):
 *   staked=1,304,812        observed_mint=835,664         predicted=835,654    (-10,    -0.0012%, slot 436440052, ~newest)
 *   staked=48,000,000       observed_mint=30,742,058      predicted=30,741,154 (-904,   -0.0029%, slot 436425717)
 *   staked=10,787,576,727   observed_mint=6,909,119,305   predicted=6,908,803,454 (-315,851, -0.0046%, slot 436385363, ~oldest/most drift)
 * The residual growing monotonically with transaction age (not with size) is
 * exactly the signature of state drift, not formula error — this is the
 * strongest available evidence the port is bit-exact without a full
 * historical-state replay (public RPC does not serve arbitrary historical
 * account snapshots).
 *
 * ── CU (`ecoswap/svm/budget.ts`'s `CU_FAMILIES.xorca`) ──
 *
 * MEASURED from 3 real mainnet `Stake` transactions' own compute logs
 * (`getTransaction`, 2026-07-31) — "Program StaKE6XN...consumed N of ...
 * compute units" where the log's N is the WHOLE Stake CPI including its two
 * nested SPL Token CPIs (one `Transfer`, one `MintTo` — exactly
 * `stake.rs`'s body): 5,735 / 5,891 / 6,008 CU (txs
 * `Pxd7hDw9gi2KHi8PdJzRmqjrpy1FuiKwh7shn9dSz21udb1T7V1JCA8jZiu4vjTiWh7CMttTfbt8PH2XX1gzSxq`,
 * `63EHsm4Pz1FdS1zf1MJU1CvYYVqHNVMiSsHdKxSf1HGheAH9KMqMDVYjzfX9SNdVeuR3JDrjftU7wKLXzEwtoB8k`,
 * `5BThcy3gDcYyYSnAT2yqtJVnof5tfyWk66SWef1Dm2kgp8nsBui3WKrmD1FPvXXXCWd6wjXHZiznhD8N4bQKARMq`).
 * This CPI (~6k CU) is dramatically CHEAPER than `raydium-cp-swap`'s (whose
 * pin folds a real ~50k-CU CPI), so per the standing "existing pins omit the
 * venue CPI" gap this pin deliberately does NOT reuse raydium-cp-swap's slot
 * number outright (that would double-count a CPI cost this venue doesn't
 * pay): it takes raydium-cp-swap's slot (183,187 — same-complexity NON-CPI
 * analog: our setup is 3 live account reads + one virtual-offset `mulDiv`,
 * raydium-cp-swap's is 2 vault reads + a fee-adjusted CP formula, comparable
 * or cheaper) as the baseline and adds a margin over OUR OWN measured CPI
 * instead (6,008 max + ~15% -> 6,900, rounded up to 7,000), so the pin only
 * ever over-estimates. `rung` reuses raydium-cp-swap's 65,054 verbatim (our
 * per-rung cost is a single `mulDiv` call over already-read setup locals —
 * no extra account reads — at most as expensive as raydium-cp-swap's own
 * per-rung fee-adjusted CP formula; the venue CPI itself runs once per SLOT,
 * not once per rung).
 */
import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SvmVenueLadder, SwapUser, VenueAccount } from '../types.js';

const SLUG = 'xorca';

export const XORCA_PROGRAM_ID: Address<'StaKE6XNKVVhG8Qu9hDJBqCW3eRe7MDGLz17nJZetLT'> = address(
  'StaKE6XNKVVhG8Qu9hDJBqCW3eRe7MDGLz17nJZetLT',
);
/** Hardcoded program constants (`cpi/token/mod.rs`) — never stored as pool-account bytes. */
export const ORCA_MINT_ID: Address<'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'> = address(
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
);
export const XORCA_MINT_ID: Address<'xorcaYqbXUNz3474ubUMJAdu2xgPsew3rUCe5ughT3N'> = address(
  'xorcaYqbXUNz3474ubUMJAdu2xgPsew3rUCe5ughT3N',
);
const SPL_TOKEN_PROGRAM_ID: Address<'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'> = address(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/**
 * The single global State PDA — seed `["state"]` under `XORCA_PROGRAM_ID`,
 * bump 250. The single vault ATA — seed `[statePda, tokenProgram, orcaMint]`
 * under the ATA program, bump 254. Both re-derived independently via
 * `getProgramDerivedAddress` and cross-checked against the live account's own
 * `State.bump`/`State.vault_bump` fields (250/254 exactly) AND against 3 real
 * mainnet `Stake` transactions' account lists (see file header) — hardcoded
 * here rather than derived at call time because both are permanently fixed
 * (there is exactly one xORCA vault; the mints never change).
 */
export const XORCA_STATE_PDA: Address<'CSqKhyW1cpdyjheAx5HXx4ibcnYrzpL5JywEMAkZixBK'> = address(
  'CSqKhyW1cpdyjheAx5HXx4ibcnYrzpL5JywEMAkZixBK',
);
export const XORCA_VAULT_ATA: Address<'Ce5j11WAsSzM3nkzrw4Kw6v6ic3nbyqpv5eywjYKeKc5'> = address(
  'Ce5j11WAsSzM3nkzrw4Kw6v6ic3nbyqpv5eywjYKeKc5',
);

const STATE_LEN = 2048;
const STATE_DISCRIMINATOR_STATE = 1;
/** `State.escrowed_orca_amount`, u64 LE. */
export const STATE_ESCROWED_OFFSET = 8;
/** SPL `TokenAccount.amount`, u64 LE — the vault's live ORCA balance. */
export const VAULT_AMOUNT_OFFSET = 64;
/** SPL `Mint.supply`, u64 LE (4-byte COption tag + 32-byte pubkey precede it). */
export const MINT_SUPPLY_OFFSET = 36;

/** `util/math.rs`'s `VIRTUAL_XORCA_SUPPLY` / `VIRTUAL_NON_ESCROWED_ORCA_AMOUNT` — ported verbatim. */
const VIRTUAL_XORCA_SUPPLY = 100n;
const VIRTUAL_NON_ESCROWED_ORCA = 100n;

export interface XorcaPoolConfig extends PoolConfig {
  venue: typeof SLUG;
  /** The only tradable direction — see file header for why Unstake/Withdraw cannot be one. */
  direction: 'orcaToXorca';
}

function xorcaConfig(cfg: PoolConfig): XorcaPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as XorcaPoolConfig;
}

/**
 * Singleton venue: `pool` must be `XORCA_STATE_PDA` (there is nothing else to
 * resolve it to). `load` re-reads the live account so a program
 * upgrade/migration is caught like any other vanished pool — never silently
 * misquoted — rather than trusting the hardcoded address blindly.
 */
export async function fetchXorcaConfig(load: AccountLoader, pool: Address): Promise<XorcaPoolConfig> {
  if (pool !== XORCA_STATE_PDA) {
    throw new Error(`${SLUG}: pool ${pool} is not the xORCA state singleton ${XORCA_STATE_PDA}`);
  }
  const raw = await load(pool);
  if (raw === null) throw new Error(`${SLUG}: state account ${pool} not found`);
  if (raw.length !== STATE_LEN) {
    throw new Error(`${SLUG}: state account ${pool} has length ${raw.length}, want ${STATE_LEN}`);
  }
  if (raw[0] !== STATE_DISCRIMINATOR_STATE) {
    throw new Error(`${SLUG}: state account ${pool} has discriminator ${raw[0]}, want ${STATE_DISCRIMINATOR_STATE} (State)`);
  }
  return { venue: SLUG, pool, direction: 'orcaToXorca' };
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

function readU64LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]!);
  return v;
}

export const xorcaLadder: SvmVenueLadder = {
  slug: SLUG,
  defaultRungs: 4,
  shapeKey(base: PoolConfig): string {
    xorcaConfig(base); // validates venue; nothing else varies — one shape total
    return SLUG;
  },
  helpers() {
    return [
      {
        name: 'qXorca',
        source: [
          'function qXorca(x, nonEscrowed, xorcaSupply) {',
          '  if (x === 0) { return 0 }',
          `  return Math.mulDiv(x, xorcaSupply + ${VIRTUAL_XORCA_SUPPLY}, nonEscrowed + ${VIRTUAL_NON_ESCROWED_ORCA});`,
          '}',
        ].join('\n'),
      },
    ];
  },
  paramCount: 0,
  paramsFor(): bigint[] {
    return [];
  },
  quoteRefs(_base: PoolConfig, slot: number): VenueAccount[] {
    return [
      { ref: ref(slot, 'vault'), address: XORCA_VAULT_ATA },
      { ref: ref(slot, 'xorcaMint'), address: XORCA_MINT_ID },
      { ref: ref(slot, 'state'), address: XORCA_STATE_PDA },
    ];
  },
  emitSetup(_base: PoolConfig, slot: number): string {
    return [
      `  const s${slot}vault = accountUint(${JSON.stringify(ref(slot, 'vault'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
      `  const s${slot}escrowed = accountUint(${JSON.stringify(ref(slot, 'state'))}, ${STATE_ESCROWED_OFFSET}, 8);`,
      `  const s${slot}supply = accountUint(${JSON.stringify(ref(slot, 'xorcaMint'))}, ${MINT_SUPPLY_OFFSET}, 8);`,
      `  const s${slot}rin = s${slot}vault - s${slot}escrowed;`,
    ].join('\n');
  },
  emitQuoteCall(_base: PoolConfig, slot: number, x: string): string {
    return `qXorca(${x}, s${slot}rin, s${slot}supply)`;
  },
  buildSwapV2(_base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    return {
      programId: XORCA_PROGRAM_ID,
      prefix: Uint8Array.from([0]), // Instruction::Stake discriminator (Borsh enum tag, declaration order)
      suffix: new Uint8Array(0), // Stake{orca_stake_amount:u64} carries nothing after the amount
      patch: 'in',
      accounts: [
        { ref: user.owner, signer: true, writable: true }, // 0 staker_account
        { ref: ref(slot, 'vault'), address: XORCA_VAULT_ATA, writable: true }, // 1 vault_account
        { ref: user.inAta, writable: true }, // 2 staker_orca_ata
        { ref: user.outAta, writable: true }, // 3 staker_xorca_ata
        { ref: ref(slot, 'xorcaMint'), address: XORCA_MINT_ID, writable: true }, // 4 xorca_mint_account
        { ref: ref(slot, 'state'), address: XORCA_STATE_PDA }, // 5 state_account (read-only)
        { ref: ref(slot, 'orcaMint'), address: ORCA_MINT_ID }, // 6 orca_mint_account (read-only)
        { ref: ref(slot, 'tokenProgram'), address: SPL_TOKEN_PROGRAM_ID }, // 7 token_program_account
      ],
    };
  },
  referenceQuote(_base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint {
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr as unknown as string];
      if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
      return data;
    };
    const vaultAmount = readU64LE(bytes(XORCA_VAULT_ATA), VAULT_AMOUNT_OFFSET);
    const escrowed = readU64LE(bytes(XORCA_STATE_PDA), STATE_ESCROWED_OFFSET);
    const supply = readU64LE(bytes(XORCA_MINT_ID), MINT_SUPPLY_OFFSET);
    const nonEscrowed = vaultAmount - escrowed;
    return (x: bigint): bigint => {
      if (x === 0n) return 0n;
      if (nonEscrowed === 0n || supply === 0n) return x; // convert_orca_to_xorca's 1:1 bootstrap case
      return (x * (supply + VIRTUAL_XORCA_SUPPLY)) / (nonEscrowed + VIRTUAL_NON_ESCROWED_ORCA);
    };
  },
  depthReserves(_base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr as unknown as string];
      if (data === undefined) throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
      return data;
    };
    const vaultAmount = readU64LE(bytes(XORCA_VAULT_ATA), VAULT_AMOUNT_OFFSET);
    const escrowed = readU64LE(bytes(XORCA_STATE_PDA), STATE_ESCROWED_OFFSET);
    const supply = readU64LE(bytes(XORCA_MINT_ID), MINT_SUPPLY_OFFSET);
    return { reserveIn: vaultAmount - escrowed, reserveOut: supply };
  },
  continuousFees(): { gammaPpm: bigint; muPpm: bigint } {
    // Measurement-only oracle input (never a gate — see the SvmVenueLadder
    // doc). The real curve is exactly LINEAR (no price impact at all — see
    // file header), strictly MORE depth than any CP curve models; reporting
    // a plain no-fee CP shape (gamma=mu=1) over the real reserves is a
    // CONSERVATIVE stand-in (the CP form under-states this venue's depth,
    // same documented caveat as every stable/oracle-anchored family's
    // continuousFees), never an over-promise.
    return { gammaPpm: 1_000_000n, muPpm: 1_000_000n };
  },
};
