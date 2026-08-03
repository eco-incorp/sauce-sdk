/**
 * Jupiter Lend Earn — a lending-vault deposit/redeem (an Anchor program,
 * NO on-chain IDL; the layout/ABI below is ground-truthed against the
 * PUBLISHED Rust source — `Instadapp/fluid-solana-programs` @
 * `626b177f235224bc5d074d39439cd2558f542886` (the commit Code4rena's
 * `code-423n4/2026-02-jupiter-lend` audit scope points at after the sponsor
 * had the code itself removed from the audit repo), `programs/lending/**`
 * + `programs/liquidity/**` — NOT reverse-engineered. Two program deploys:
 * Lending `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9` (this family's
 * `programId` — the CPI target) and the Liquidity layer it delegates all
 * actual token accounting to, `jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC`
 * (both confirmed live executable accounts on mainnet-beta, 2026-07-31).
 *
 * MECHANISM — a share-vault, not an AMM: `deposit(assets)` mints fTokens at
 * the CURRENT `token_exchange_price` (a linear rate, assets-per-share scaled
 * by `EXCHANGE_PRICES_PRECISION` = 1e12); `redeem(shares)` burns fTokens for
 * assets at the same rate. There is no curvature and no fee parameter on
 * either instruction — the rate IS the whole quote. This is why the plan
 * calls for "quote = exact linear rate, monotone": `defaultRungs` is pinned
 * at the framework floor (2, like `sanctum-stake-pool`'s identical affine
 * case) — a straight line loses nothing to a coarser grid.
 *
 * LAYOUT — the `Lending` account (Anchor `#[account]`, sequential, NOT
 * zero-copy — every field is a fixed-width primitive so offsets ARE fixed
 * regardless): disc(8) + mint(32)@8 + f_token_mint(32)@40 + lending_id(u16)@72
 * + decimals(u8)@74 + rewards_rate_model(32)@75 + liquidity_exchange_price(u64)@107
 * + token_exchange_price(u64)@115 + last_update_timestamp(u64)@123 +
 * token_reserves_liquidity(32)@131 + supply_position_on_liquidity(32)@163 +
 * bump(u8)@195 — 196 bytes total. VERIFIED against three real mainnet
 * `Lending` PDAs (USDC/USDT/wSOL markets; PDA = `["lending", mint,
 * f_token_mint]`, `f_token_mint` itself `["f_token_mint", mint]`, both on
 * this program): every one is EXACTLY 196 bytes with the Anchor discriminator
 * `sha256("account:Lending")[0..8]` this file computes independently and
 * both matched a live `getAccountInfo` byte-for-byte at the stated offsets
 * (mint/f_token_mint/rewards_rate_model/token_reserves_liquidity/
 * supply_position_on_liquidity all decoded to real, owner-correct accounts).
 *
 * ACCOUNTS the CPI needs beyond the `Lending` PDA itself — every one
 * ground-truthed live, not guessed:
 * - `lending_admin` = PDA(["lending_admin"], LENDING_PROGRAM) — ONE GLOBAL
 *   singleton across every market (verified: a real, LENDING_PROGRAM-owned
 *   account at the derived address).
 * - `rate_model` = PDA(["rate_model", mint], LIQUIDITY_PROGRAM) — per-mint,
 *   NOT constrained by a PDA seed in the Anchor `Operate` context itself
 *   (`AccountLoader<RateModel>` with only a `has_one = mint` check), so this
 *   file derives it the same way `set_rate_model`'s own seed constant
 *   (`RATE_MODEL_SEED` in `liquidity/src/state/seeds.rs`) implies; verified
 *   live for all three test markets (LIQUIDITY_PROGRAM-owned, 53-byte
 *   `RateModel` accounts, `sha256("account:RateModel")[0..8]` discriminator
 *   match).
 * - `liquidity` = PDA(["liquidity"], LIQUIDITY_PROGRAM) — the SECOND global
 *   singleton (the whole protocol's lock/authority state; verified live,
 *   74 bytes, LIQUIDITY_PROGRAM-owned).
 * - `supply_token_reserves_liquidity` = `lending.token_reserves_liquidity`
 *   (a stored field — this file reads it rather than re-deriving; it
 *   independently matches `PDA(["reserve", mint], LIQUIDITY_PROGRAM)` for
 *   all three test markets, confirming the field and the seed agree).
 * - `vault` = the `TokenReserve.vault` field (offset 40 within that
 *   account, itself an Anchor zero-copy `#[account]` — disc(8) + mint(32)@8
 *   + vault(32)@40 + ...). This file reads it via a second account load
 *   rather than re-deriving the ATA (sidesteps classic-SPL-vs-Token-2022 ATA
 *   derivation entirely — see the token-program gate below). Verified live:
 *   the USDC market's vault is a real 165-byte SPL Token Account, owner
 *   TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA, `authority` field equal to
 *   the `liquidity` PDA above, holding real USDC (41.8M-ish at verification
 *   time).
 * - `token_program` — this adapter GATES to classic Tokenkeg only (Token-2022
 *   extensions — transfer fees, gating hooks — are not modeled, matching
 *   `sanctum-stake-pool`'s identical scope decision). `AccountLoader` returns
 *   only bytes, never the owning program, so the gate is by SIZE instead: a
 *   classic `Mint` account is exactly 82 bytes (see `assertClassicMint`
 *   below for the residual edge case this doesn't catch).
 *
 * DISCOVERY — `Lending` stores BOTH mints at fixed offsets (mint@8,
 * f_token_mint@40) with a fixed 196-byte size, so it discovers exactly like
 * a two-mint AMM pool (see `SVM_FAMILY_FILTERS['jupiter-lend-earn']`) —
 * no `fixedMint` special-case needed, unlike `sanctum-stake-pool`.
 *
 * QUOTE MATH — ground-truthed via `simulateTransaction` (sigVerify:false,
 * `replaceRecentBlockhash:true` — nothing submitted for real) against the
 * REAL deployed program on REAL mainnet state, 2026-07-31, USDC market, a
 * real depositor wallet (`9936VF...cdL3QK`, a top fToken holder with a real
 * USDC balance) as signer, at THREE sizes each direction:
 *   deposit 1 USDC    -> predicted 948,989  shares, actual 948,988  (LogDeposit)
 *   deposit 100 USDC  -> predicted 94,898,933 shares, actual 94,898,915
 *   deposit 10,000 USDC -> predicted 9,489,893,345 shares, actual 9,489,891,642
 *   redeem 1 share(*) -> predicted 1,053,752 assets, actual 1,053,752 (LogWithdraw) EXACT
 *   redeem 100(*)     -> predicted 105,375,262 assets, actual 105,375,281
 *   redeem 10,000(*)  -> predicted 10,537,526,225 assets, actual 10,537,528,114
 * (* raw share units, not UI units — `redeem`'s CPI target is
 * `global:redeem` / discriminator `[184,12,86,149,70,196,97,225]`, computed
 * as `sha256("global:redeem")[0..8]` the SAME way this file independently
 * re-derived `deposit`'s and `withdraw`'s documented discriminators and got
 * an exact match — `redeem` itself is undocumented in the public CPI guide
 * but shares the `Withdraw` account context verbatim per `lib.rs`/
 * `utils/withdraw.rs`, confirmed live by the simulation above).
 * Every deposit case matches within 18 raw units on a 9-10 digit number
 * (<0.0002%); every redeem case is EQUAL or the offline estimate is LOWER
 * than the real payout (the safe direction). Mechanism: `token_exchange_price`
 * is monotonically non-decreasing and only refreshes when SOMEONE calls
 * deposit/withdraw/redeem/rebalance — this file's on-chain fragment reads
 * the STORED value live via `accountUint` (whatever the chain has AT COOK
 * TIME, not a prepare-time snapshot), but the real CPI's OWN internal
 * `update_rates` call recomputes a FRESH (>= stored) price inside the SAME
 * instruction before minting/burning. `assets/price` (deposit's shares
 * formula) is DECREASING in price, so the stale-vs-fresh gap makes deposit's
 * offline estimate a THIN OVER-estimate (bounded by the measured <0.0002%
 * above); `shares*price` (redeem's assets formula) is INCREASING in price,
 * so the same gap makes redeem's estimate a THIN UNDER-estimate — the SAFE
 * direction (never promises more than the venue delivers). Both are
 * empirically tiny because the tested markets are touched every few minutes
 * to under an hour (USDC last_update_timestamp was 17s stale at
 * verification time, wSOL 429s, USDT 2,818s) — the codebase's existing
 * tolerance for prepare/cook price drift elsewhere (CLMM tick movement,
 * etc.) is the same shape of bound, not a new risk class.
 *
 * WITHDRAW CAP SELF-DROP — `redeem`'s underlying SPL transfer pulls straight
 * from `vault`'s real balance; a redemption bigger than the vault can cover
 * FAILS THE CPI (`simulateTransaction` reproduced this live: a redeem sized
 * at ~4.7x the vault's real USDC balance reverted with
 * `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`'s `Error: insufficient
 * funds`, custom program error 0x1) — and a launched CPI failure aborts the
 * WHOLE cook on SVM (no execution-time catch, see the consuming app SVM README's
 * settled parity verdicts), so this MUST be a quote-time clamp, not a
 * runtime guard. `emitQuoteCall`'s redeem branch reads `vault`'s LIVE SPL
 * balance (the same `accountUint` pattern as every other family's reserve
 * read) and saturates the predicted payout at 99.99% of it (a 1 bps margin
 * against the residual "fresh-price-recompute" drift documented above,
 * which is real but too small to eliminate without replicating the
 * liquidity layer's own interest-accrual formula) — a monotone, concave
 * (flat past the cap) curve, exactly the shape the merge election requires;
 * past the cap this venue's marginal return is zero and the merge simply
 * stops routing more here, never emitting a program that can revert this
 * way.
 *
 * PROTOCOL LOCKDOWN SELF-DROP — `Liquidity.status` (offset 72, 1 byte) is a
 * real, live "the whole protocol is paused" bool the Anchor program itself
 * enforces (`Liquidity::is_locked()`, gates both `PreOperate`/`Operate` with
 * `ErrorCodes::ProtocolLockdown`); this file reads it live in `emitSetup`
 * (one more `accountUint`, shared by both directions since `liquidity` rides
 * every deposit/redeem CPI already) and zeroes the quote when locked —
 * cheap, and a genuine platform-level failure mode, not a speculative gate.
 *
 * DUST — a `deposit` whose `shares_minted` would compute to 0 reverts on
 * -chain (`FTokenDepositInsignificant`); this file's helper already returns
 * 0 for that input (floor division), matching the "returns 0 for dust"
 * convention every other family's helper follows (a 0-quote slot is simply
 * not elected by the merge, never emitted with a doomed CPI).
 *
 * CU — see `../budget.ts`'s `CU_FAMILIES['jupiter-lend-earn']` for the
 * measurement + calibration method (real `simulateTransaction` CU: deposit
 * ~56.3-57.5k, redeem ~66.3-67.7k raw CPI cost).
 */
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
const SLUG = 'jupiter-lend-earn';
export const JUPITER_LEND_EARN_PROGRAM_ID = address('jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9');
/** The Liquidity layer every deposit/redeem CPI delegates real token accounting to. */
export const JUPITER_LEND_LIQUIDITY_PROGRAM_ID = address('jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
/** PDA(["lending_admin"], LENDING_PROGRAM) — ONE global singleton, verified live. */
const LENDING_ADMIN = address('5nmGjA4s7ATzpBQXC5RNceRpaJ7pYw2wKsNBWyuSAZV6');
/** PDA(["liquidity"], LIQUIDITY_PROGRAM) — the second global singleton, verified live. */
const LIQUIDITY_GLOBAL = address('7s1da8DduuBFqGra5bJBjpnvL5E9mGzCuMk1Qkh4or2Z');
const EXCHANGE_PRICES_PRECISION = 1000000000000n; // 1e12
// `Lending` account field offsets (after the 8-byte Anchor discriminator; see module header).
const OFF_MINT = 8;
const OFF_F_TOKEN_MINT = 40;
const OFF_REWARDS_RATE_MODEL = 75;
const OFF_TOKEN_EXCHANGE_PRICE = 115;
const OFF_TOKEN_RESERVES_LIQUIDITY = 131;
const OFF_SUPPLY_POSITION_ON_LIQUIDITY = 163;
export const LENDING_ACCOUNT_SIZE = 196;
// `TokenReserve` (Liquidity layer, zero-copy) field offsets.
const OFF_RESERVE_VAULT = 40;
// SPL Token Account (classic Tokenkeg) field offsets.
const OFF_TOKEN_AMOUNT = 64;
// `Liquidity` (global singleton) field offsets.
const OFF_LIQUIDITY_STATUS = 72;
/** `global:deposit` — sha256-derived, cross-checked against Jupiter's published CPI doc. */
const DEPOSIT_DISCRIMINATOR = Uint8Array.from([242, 35, 198, 137, 82, 225, 242, 182]);
/** `global:redeem` — sha256("global:redeem")[0..8]; undocumented publicly but shares `Withdraw`'s
 *  account context verbatim (see `utils/withdraw.rs::redeem_internal`), confirmed live above. */
const REDEEM_DISCRIMINATOR = Uint8Array.from([184, 12, 86, 149, 70, 196, 97, 225]);
function config(base) {
    if (base.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
    return base;
}
async function fetchJupiterLendEarnConfig(load, pool) {
    const data = await load(pool);
    if (data === null)
        throw new Error(`jupiter-lend-earn Lending ${pool} account not found`);
    if (data.length !== LENDING_ACCOUNT_SIZE) {
        throw new Error(`jupiter-lend-earn Lending ${pool} has unexpected size ${data.length}, expected ${LENDING_ACCOUNT_SIZE}`);
    }
    const decoder = getAddressDecoder();
    const mint = decoder.decode(data.subarray(OFF_MINT, OFF_MINT + 32));
    const fTokenMint = decoder.decode(data.subarray(OFF_F_TOKEN_MINT, OFF_F_TOKEN_MINT + 32));
    const rewardsRateModel = decoder.decode(data.subarray(OFF_REWARDS_RATE_MODEL, OFF_REWARDS_RATE_MODEL + 32));
    const liquidityReserve = decoder.decode(data.subarray(OFF_TOKEN_RESERVES_LIQUIDITY, OFF_TOKEN_RESERVES_LIQUIDITY + 32));
    const supplyPositionOnLiquidity = decoder.decode(data.subarray(OFF_SUPPLY_POSITION_ON_LIQUIDITY, OFF_SUPPLY_POSITION_ON_LIQUIDITY + 32));
    const [reserveData, , rateModel] = await Promise.all([
        load(liquidityReserve),
        assertClassicMint(load, mint),
        deriveRateModel(mint),
    ]);
    if (reserveData === null)
        throw new Error(`jupiter-lend-earn TokenReserve ${liquidityReserve} account not found`);
    const vault = decoder.decode(reserveData.subarray(OFF_RESERVE_VAULT, OFF_RESERVE_VAULT + 32));
    return {
        venue: SLUG,
        pool,
        mint,
        fTokenMint,
        rewardsRateModel,
        rateModel,
        liquidityReserve,
        supplyPositionOnLiquidity,
        vault,
        tokenProgram: TOKEN_PROGRAM,
        direction: 'deposit',
    };
}
/**
 * `AccountLoader` only returns raw bytes, never the account's owning program —
 * so this adapter gates Token-2022 out by SIZE instead: a classic Tokenkeg
 * `Mint` account is EXACTLY 82 bytes; a Token-2022 mint (same program-owned
 * struct prefix) carries a trailing extension TLV the moment any extension
 * is configured, which is the overwhelming majority of real Token-2022
 * mints. A Token-2022 mint with literally zero extensions would slip past
 * this check with the (wrong) classic token program attached — the CPI's own
 * `token::token_program` constraint would then reject it on-chain, a loud
 * revert rather than a silent bad fill. Every market this adapter has
 * verified live (USDC/USDT/wSOL) is classic and exactly 82 bytes.
 */
async function assertClassicMint(load, mint) {
    const data = await load(mint);
    if (data === null)
        throw new Error(`jupiter-lend-earn mint ${mint} account not found`);
    if (data.length !== 82) {
        throw new Error(`jupiter-lend-earn mint ${mint} has non-classic size ${data.length} (expected 82) — Token-2022/extension mints are not implemented by this adapter`);
    }
}
/** PDA(["rate_model", mint], LIQUIDITY_PROGRAM) — verified live for all three test markets. */
async function deriveRateModel(mint) {
    const [pda] = await getProgramDerivedAddress({
        programAddress: JUPITER_LEND_LIQUIDITY_PROGRAM_ID,
        seeds: [Buffer.from('rate_model'), Uint8Array.from(getAddressEncoder().encode(mint))],
    });
    return pda;
}
function makeJupiterLendEarn() {
    return {
        slug: SLUG,
        programId: JUPITER_LEND_EARN_PROGRAM_ID,
        fetchPoolConfig: (load, pool) => fetchJupiterLendEarnConfig(load, pool),
    };
}
export const jupiterLendEarn = makeJupiterLendEarn();
// ---------------------------------------------------------------------------
// Ladder (fragment emission + reference mirror)
// ---------------------------------------------------------------------------
const ref = (slot, role) => `s${slot}:${role}`;
const DEPOSIT_HELPER = 'qJupLendEarnDeposit';
const REDEEM_HELPER = 'qJupLendEarnRedeem';
export const jupiterLendEarnLadder = {
    slug: SLUG,
    // Exactly affine (see module header) — a straight line loses nothing to a
    // coarser grid, so this pins the framework floor instead of the CP default
    // of 4, matching sanctum-stake-pool's identical affine case.
    defaultRungs: 2,
    shapeKey(cfg) {
        const c = config(cfg);
        return `${SLUG}:${c.direction}`;
    },
    helpers() {
        return [
            {
                name: DEPOSIT_HELPER,
                source: [
                    `function ${DEPOSIT_HELPER}(x, price, locked) {`,
                    '  if (x === 0) { return 0 }',
                    '  if (locked !== 0) { return 0 }',
                    '  if (price === 0) { return 0 }',
                    '  return Math.mulDiv(x, 1000000000000, price);',
                    '}',
                ].join('\n'),
            },
            {
                name: REDEEM_HELPER,
                source: [
                    `function ${REDEEM_HELPER}(x, price, locked, vaultCap) {`,
                    '  if (x === 0) { return 0 }',
                    '  if (locked !== 0) { return 0 }',
                    '  let out = Math.mulDiv(x, price, 1000000000000);',
                    '  if (out > vaultCap) { out = vaultCap }',
                    '  return out;',
                    '}',
                ].join('\n'),
            },
        ];
    },
    // No fee/curve parameters — the linear rate IS the whole quote.
    paramCount: 0,
    paramsFor() {
        return [];
    },
    quoteRefs(cfg, slot) {
        const c = config(cfg);
        const accounts = [
            { ref: ref(slot, 'lending'), address: c.pool },
            { ref: ref(slot, 'liquidity'), address: LIQUIDITY_GLOBAL },
        ];
        if (c.direction === 'redeem') {
            accounts.push({ ref: ref(slot, 'vault'), address: c.vault });
        }
        return accounts;
    },
    emitSetup(cfg, slot) {
        const c = config(cfg);
        const lines = [
            `  const s${slot}price = accountUint(${JSON.stringify(ref(slot, 'lending'))}, ${OFF_TOKEN_EXCHANGE_PRICE}, 8);`,
            `  const s${slot}locked = accountUint(${JSON.stringify(ref(slot, 'liquidity'))}, ${OFF_LIQUIDITY_STATUS}, 1);`,
        ];
        if (c.direction === 'redeem') {
            // 1 bps margin against the fresh-price-recompute drift documented in
            // the module header — never quote past 99.99% of the live vault balance.
            lines.push(`  const s${slot}vaultbal = accountUint(${JSON.stringify(ref(slot, 'vault'))}, ${OFF_TOKEN_AMOUNT}, 8);`, `  const s${slot}vaultcap = s${slot}vaultbal - s${slot}vaultbal / 10000;`);
        }
        return lines.join('\n');
    },
    emitQuoteCall(cfg, slot, x) {
        const c = config(cfg);
        return c.direction === 'redeem'
            ? `${REDEEM_HELPER}(${x}, s${slot}price, s${slot}locked, s${slot}vaultcap)`
            : `${DEPOSIT_HELPER}(${x}, s${slot}price, s${slot}locked)`;
    },
    buildSwapV2(cfg, slot, user) {
        const c = config(cfg);
        const w = (r, addr) => ({ ref: ref(slot, r), address: addr, writable: true });
        const ro = (r, addr) => ({ ref: ref(slot, r), address: addr });
        if (c.direction === 'deposit') {
            const accounts = [
                { ref: user.owner, signer: true, writable: true }, // signer
                { ref: user.inAta, writable: true }, // depositor_token_account
                { ref: user.outAta, writable: true }, // recipient_token_account
                ro('mint', c.mint),
                ro('lendingAdmin', LENDING_ADMIN),
                w('lending', c.pool),
                w('fTokenMint', c.fTokenMint),
                w('reserve', c.liquidityReserve),
                w('supplyPosition', c.supplyPositionOnLiquidity),
                ro('rateModel', c.rateModel),
                w('vault', c.vault),
                w('liquidity', LIQUIDITY_GLOBAL),
                ro('liquidityProgram', JUPITER_LEND_LIQUIDITY_PROGRAM_ID),
                ro('rewardsRateModel', c.rewardsRateModel),
                ro('tokenProgram', c.tokenProgram),
                ro('associatedTokenProgram', ASSOCIATED_TOKEN_PROGRAM),
                ro('systemProgram', SYSTEM_PROGRAM),
            ];
            return { programId: JUPITER_LEND_EARN_PROGRAM_ID, prefix: DEPOSIT_DISCRIMINATOR, suffix: Uint8Array.from([]), patch: 'in', accounts };
        }
        // redeem(shares): the `Withdraw` account context verbatim (see module header).
        const accounts = [
            { ref: user.owner, signer: true, writable: true }, // signer
            { ref: user.inAta, writable: true }, // owner_token_account (fToken, burned FROM)
            { ref: user.outAta, writable: true }, // recipient_token_account (underlying, paid TO)
            ro('lendingAdmin', LENDING_ADMIN),
            w('lending', c.pool),
            ro('mint', c.mint),
            w('fTokenMint', c.fTokenMint),
            w('reserve', c.liquidityReserve),
            w('supplyPosition', c.supplyPositionOnLiquidity),
            ro('rateModel', c.rateModel),
            w('vault', c.vault),
            // claim_account: Option<UncheckedAccount>, None for a direct (non-claim) settlement —
            // the program's own id is the sentinel; validated live via simulateTransaction (module header).
            ro('claimAccountNone', JUPITER_LEND_EARN_PROGRAM_ID),
            w('liquidity', LIQUIDITY_GLOBAL),
            ro('liquidityProgram', JUPITER_LEND_LIQUIDITY_PROGRAM_ID),
            ro('rewardsRateModel', c.rewardsRateModel),
            ro('tokenProgram', c.tokenProgram),
            ro('associatedTokenProgram', ASSOCIATED_TOKEN_PROGRAM),
            ro('systemProgram', SYSTEM_PROGRAM),
        ];
        return { programId: JUPITER_LEND_EARN_PROGRAM_ID, prefix: REDEEM_DISCRIMINATOR, suffix: Uint8Array.from([]), patch: 'in', accounts };
    },
    referenceQuote(cfg, state) {
        const c = config(cfg);
        const lending = state[c.pool];
        if (lending === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${c.pool}`);
        const price = readU64(lending, OFF_TOKEN_EXCHANGE_PRICE);
        const liquidity = state[LIQUIDITY_GLOBAL];
        const locked = liquidity !== undefined && liquidity[OFF_LIQUIDITY_STATUS] !== 0;
        if (c.direction === 'deposit') {
            return (x) => {
                if (x === 0n || locked || price === 0n)
                    return 0n;
                return (x * EXCHANGE_PRICES_PRECISION) / price;
            };
        }
        const vaultData = state[c.vault];
        if (vaultData === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${c.vault}`);
        const vaultBal = readU64(vaultData, OFF_TOKEN_AMOUNT);
        const vaultCap = vaultBal - vaultBal / 10000n;
        return (x) => {
            if (x === 0n || locked)
                return 0n;
            let out = (x * price) / EXCHANGE_PRICES_PRECISION;
            if (out > vaultCap)
                out = vaultCap;
            return out;
        };
    },
    depthReserves(cfg, state) {
        const c = config(cfg);
        const lending = state[c.pool];
        if (lending === undefined)
            throw new Error(`${SLUG} ladder depth is missing account ${c.pool}`);
        const price = readU64(lending, OFF_TOKEN_EXCHANGE_PRICE);
        const vaultData = state[c.vault];
        const vaultBal = vaultData === undefined ? 0n : readU64(vaultData, OFF_TOKEN_AMOUNT);
        if (c.direction === 'deposit') {
            // Deposit capacity is not pool-bounded (the liquidity layer always
            // accepts more supply) — vaultBal is a SIZE PROXY for relative-depth
            // ranking only, on both sides, matching sanctum-stake-pool's identical
            // treatment of its own unbounded deposit direction.
            return { reserveIn: vaultBal, reserveOut: vaultBal };
        }
        // Redeem is genuinely capped by the vault's real balance — reserveOut is
        // the hard cap in asset terms; reserveIn is the share-terms equivalent
        // (how many shares the vault could cover at the live rate).
        const reserveIn = price === 0n ? 0n : (vaultBal * EXCHANGE_PRICES_PRECISION) / price;
        return { reserveIn, reserveOut: vaultBal };
    },
    continuousFees() {
        // No fee on either instruction — the exchange rate IS the whole quote.
        return { gammaPpm: 1000000n, muPpm: 1000000n };
    },
};
function readU64(buf, offset) {
    if (offset + 8 > buf.length)
        throw new Error(`${SLUG}: truncated account data`);
    let v = 0n;
    for (let i = 7; i >= 0; i--)
        v = (v << 8n) | BigInt(buf[offset + i]);
    return v;
}
//# sourceMappingURL=index.js.map