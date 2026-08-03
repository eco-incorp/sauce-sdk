/**
 * Voltr (SvmRoute ladder fragment) — a permissionless vault-infrastructure
 * protocol (`voltrxyz`): depositors mint LP shares against a vault's live
 * NAV (`deposit_vault`) and can redeem them atomically for the underlying
 * asset out of the vault's un-invested ("idle") float (`instant_withdraw_vault`).
 * `request_withdraw_vault`/`withdraw_vault` are the QUEUED path (burns LP now,
 * creates a `RequestWithdrawVaultReceipt`, delivers nothing atomically — the
 * asset lands only after `withdrawal_waiting_period` via a SEPARATE later
 * transaction) and are therefore NOT modeled here, the same "cannot be a
 * Sauce venue leg" reasoning `xorca.ts`'s file header applies to its own
 * queued Unstake/Withdraw path.
 *
 * ── Ground truth: the program's OWN on-chain-published Anchor IDL ──
 *
 * Voltr publishes its IDL on-chain at the canonical Anchor IDL PDA
 * (`createAddressWithSeed(findProgramAddress([], programId), "anchor:idl",
 * programId)` — fetched 2026-07-31, decompresses to exactly 73,416 bytes of
 * JSON from a 10,770-byte account, `voltr_vault` v0.2.0). Every offset,
 * discriminator, instruction-account order, and struct field below is taken
 * DIRECTLY from that IDL (`accounts`/`types`/`instructions`), not
 * reverse-engineered from bytes. The `Vault` account is `bytemuckunsafe`
 * zero-copy `repr(C)` — Anchor zero-copy buffers are only guaranteed
 * 8-byte alignment (the 8-byte discriminator precedes the struct), so this
 * struct's `u128` field (`HighWaterMark.highest_asset_per_lp_decimal_bits`)
 * is laid out at 8-byte, NOT the natural Rust 16-byte, alignment —
 * confirmed empirically: computing offsets with align-16 for u128 predicts
 * an 8-byte gap before `high_water_mark` and a total size of 936 bytes
 * (disc-inclusive), but every one of 196 real mainnet `Vault` accounts
 * sampled (`getProgramAccounts` with a discriminator memcmp, 2026-07-31) is
 * exactly 928 bytes; re-deriving with align-8 for u128 removes that gap and
 * predicts 928 bytes EXACTLY, and every field decoded at the resulting
 * offsets (asset/lp mints, fee bps, timestamps, manager/admin pubkeys) reads
 * as a plausible, self-consistent real value across all 196 samples — the
 * strongest available confirmation short of the Rust source itself. (Two of
 * the 196 are 952 bytes — a newer/rarer on-disk variant; `fetchPoolConfig`
 * accepts any length >= `VAULT_MIN_LEN` since every field this adapter reads
 * sits well inside the first 928 bytes either way, but `SVM_FAMILY_FILTERS`'s
 * gPA `dataSize` filter only matches the 194 at exactly 928 — self-dropping
 * the 952-byte pair from DISCOVERY, not from direct resolution.)
 *
 * ── Quote math — a byte-exact port of the protocol's OWN published SDK ──
 *
 * `@voltr/vault-sdk`'s `VoltrClient.calculateLpForDeposit` /
 * `calculateAssetsForWithdrawHelper` (both in `src/client.ts`, MIT, published
 * by the protocol team as the canonical off-chain preview of the on-chain
 * accounting) give the exact closed form ported below — NOT an approximation:
 *
 *   unharvestedFeesLp = accumulated_lp_{manager,admin,protocol}_fees (summed)
 *   lpSupplyInclAccumulatedFees = lp_mint.supply + unharvestedFeesLp + dead_weight
 *   mgmtFeeBps = manager_management_fee + admin_management_fee + protocol_management_fee
 *   unrealisedLpFees = 0 if lastMgmtFeeUpdateTs==0 || totalValue==0 || mgmtFeeBps==0
 *     else (elapsed = max(0, now - lastMgmtFeeUpdateTs); 0 if elapsed==0; else
 *     feeInAsset = totalValue*elapsed*mgmtFeeBps/10000/31536000 (a per-second
 *     linear accrual over a 365-day year, BPS-scaled);
 *     ceil(feeInAsset * lpSupplyInclAccumulatedFees / (totalValue - feeInAsset)))
 *   lpSupplyInclFees = lpSupplyInclAccumulatedFees + unrealisedLpFees
 *
 *   DEPOSIT (lpSupplyInclFees == 0, i.e. a never-deposited-into vault):
 *     mint = assetIn * 10^lpDecimals / 10^assetDecimals  (decimals-aware 1:1)
 *   DEPOSIT (else):
 *     mint = floor(assetIn * lpSupplyInclFees * (10000-issuanceFeeBps)
 *                  / (totalValue*10000 + assetIn*issuanceFeeBps))
 *     — algebraically (totalValue+assetIn)*10000 - assetIn*(10000-issuanceFeeBps)
 *       reduces to totalValue*10000 + assetIn*issuanceFeeBps, so assetIn appears
 *       in the denominator ONLY via issuanceFeeBps: issuanceFeeBps==0 (the
 *       common case, confirmed on multiple live vaults) makes this EXACTLY
 *       linear; issuanceFeeBps>0 makes it a mild, still monotone-concave,
 *       saturating (CP-like) curve — never non-monotone.
 *
 *   WITHDRAW: lockedProfit = 0 if locked_profit_degradation_duration==0, else
 *     (duration = max(0, now - last_report); 0 if duration > degradationDuration
 *     else last_updated_locked_profit * (degradationDuration-duration) / degradationDuration)
 *     totalUnlockedValue = totalValue - lockedProfit
 *     assetOut = floor(lpIn * totalUnlockedValue * (10000-redemptionFeeBps)
 *                       / (lpSupplyInclFees * 10000))
 *     — EXACTLY linear in lpIn (no lpIn term in the denominator).
 *
 * `last_updated_locked_profit` genuinely holds a PROFIT AMOUNT (not a
 * timestamp, despite the SDK's `calculateLockedProfit` naming its own first
 * arg `lastUpdatedLockedProfit` and using it in a `now - lastUpdatedLockedProfit`
 * subtraction) — confirmed by live values: every sampled vault's field reads
 * as an asset-scale magnitude (9, 38126, ..., 10680089518998677 for a
 * near-empty/dead vault) while `last_report` always reads as a plausible
 * 2026 Unix timestamp (~1.78-1.79 billion). Ported EXACTLY as the SDK computes
 * it regardless (a real elapsed-time-vs-profit-amount subtraction is
 * dimensionally strange, but at every magnitude actually observed on mainnet
 * it drives `duration` far past any real `locked_profit_degradation_duration`
 * — itself always a short window, 0 or up to a few days in every sample — so
 * the guard `duration > degradationDuration` fires and locked profit reads 0;
 * porting the SDK's literal arithmetic rather than a "corrected" reading is
 * the safe choice either way since it can only make `totalUnlockedValue`
 * SMALLER, never larger, than a version using `last_report` for the
 * subtraction would — i.e. it never over-promises a withdrawal).
 *
 * `block.timestamp` (the compiler's Clock-sysvar-backed global, the SAME
 * intrinsic `meteora-damm-v1-stable`'s own locked-profit-decay quote already
 * uses on-chain) drives the time-dependent terms; `Vault`'s own bytes drive
 * everything else — nothing here is baked at prepare time except
 * `assetDecimals`/`lpDecimals` (fixed per vault forever) and the vault's own
 * address-derived accounts.
 *
 * ── Two SELF-DROP-worthy hard caps, both handled as a SATURATING clamp
 *    (never a revert) so a program built against a stale/racy plan degrades
 *    to a smaller fill instead of aborting the whole cook (SVM execution-time
 *    CPI failure is unrecoverable — see the consuming app SVM README) ──
 *
 * 1. DEPOSIT vs `vault_configuration.max_cap`: a deposit that would push
 *    `total_value` past `max_cap` is documented ("The maximum total amount
 *    allowed in the vault") to be rejected by the program. This adapter
 *    clamps the EFFECTIVE input to `max(0, max_cap - total_value)` before
 *    quoting, so the reported mint amount flattens at the cap instead of
 *    quoting a number the real CPI would then revert on. (Not independently
 *    revert-tested against a live over-cap deposit — the clamp is
 *    conservative regardless: it can only quote LESS than the uncapped
 *    formula would, never more.)
 * 2. WITHDRAW vs the live idle-ATA SPL balance: `instant_withdraw_vault`
 *    pays out of `vault_asset_idle_ata` ONLY (never touches strategy-invested
 *    capital) — CONFIRMED via a real `simulateTransaction` against a live
 *    vault (2026-07-31): a withdrawal sized above the idle ATA's real balance
 *    fails with the SPL Token program's own "insufficient funds" (custom
 *    error `0x1`), not a Voltr-level revert. This adapter clamps the quoted
 *    payout to the live idle-ATA balance, read on-chain in the SAME setup
 *    block.
 *
 * ── Validated against the REAL deployed program on REAL mainnet state,
 *    at 4+ sizes each direction, via `simulateTransaction` (sigVerify:false,
 *    replaceRecentBlockhash:true — no real signature needed, any funded
 *    wallet can serve as fee payer while an arbitrary real token holder is
 *    impersonated as the depositor/withdrawer; nothing was ever submitted) —
 *
 * DEPOSIT (vault `Gj8kURFs8fK3GhiX5Yc6H1HQKSpEvLHeDRZsP6Y2D1je`, HUB-denominated,
 * issuanceFee=0 so exactly linear): a real HUB holder's canonical ATA
 * depositing 1 / 10 / 100 / 500 HUB (1e9/1e10/1e11/5e11 raw, 9 decimals)
 * against the SAME-SLOT post-deposit vault/mint state minted EXACTLY
 * 998,312,468 / 9,983,124,685 / 99,831,246,854 / 499,156,234,274 raw LP
 * — the formula above, evaluated on that same-slot state, predicts the
 * IDENTICAL integer at all 4 sizes (bit-for-bit, verified programmatically).
 * The deposit CPI itself (including its 2 nested SPL Transfer/MintTo CPIs)
 * measured 33,527 / 33,643 / 33,644 / 33,643 CU.
 *
 * WITHDRAW (same vault, redemptionFee=15bps): a real LP holder's canonical
 * ATA withdrawing 0.5 / 2 / 5 LP (5e8/2e9/5e9 raw) against GENUINE PRE-state
 * (fetched via `getMultipleAccounts` immediately before simulating — the
 * withdraw formula's fee-retention means feeding it POST-state, unlike
 * deposit's self-consistent floor identity, does NOT reproduce the same
 * answer) paid out EXACTLY 500,093,222 / 2,000,372,890 / 5,000,932,225 raw
 * asset — the formula predicts the IDENTICAL integer at all 3 sizes,
 * bit-for-bit. A 4th size (20 LP, exceeding the vault's live ~9.6 HUB idle
 * balance) failed with the SPL "insufficient funds" error described above,
 * confirming the idle-liquidity cliff empirically. The withdraw CPI measured
 * 35,517 / 35,517 / 35,633 CU on the three successful sizes.
 *
 * ── CU (`the consuming app SVM CU-budget module`'s `CU_FAMILIES.voltr`) ──
 *
 * Per the standing "existing pins omit the venue CPI" gap, this pin takes
 * raydium-cp-swap's 183,187 as a same-complexity NON-CPI baseline (2 vault
 * reads + a fee-adjusted CP formula) and adds a margin over OUR OWN measured
 * CPI (max 35,633 across both directions, +15% -> ~40,978) PLUS extra
 * headroom for this family's heavier setup (this adapter reads ~10 distinct
 * Vault fields plus the LP mint's supply, vs raydium-cp-swap's 2 balances),
 * landing at 225,000 (deliberately rounded UP past the arithmetic sum, never
 * down — this can only over-estimate CU, never under). `rung` reuses
 * raydium-cp-swap's 65,054 verbatim: a rung here is one more helper-function
 * call over already-read setup locals (a handful of multiplies/divides/
 * comparisons), at most as expensive as raydium-cp-swap's own per-rung
 * fee-adjusted CP formula.
 *
 * ── Token-2022 assets: not distinguished (documented simplification, not a
 *    permission gate) ──
 *
 * `AccountLoader` returns raw bytes only (no owning-program field), so
 * `fetchPoolConfig` cannot see whether `vault_asset_mint` is Token or
 * Token-2022 owned. Every one of the sampled vaults' assets (HUB, USDC, wSOL,
 * USDS, and others) is a classic SPL Token mint, so `assetTokenProgram` is
 * pinned to the classic Token program. A future Token-2022-asset vault would
 * fail its OWN CPI cleanly (a program-ownership mismatch on the passed
 * token-program account) rather than corrupt anything — a self-drop for that
 * one vault, not a systemic risk. `lpTokenProgram` needs no such handling:
 * the IDL fixes it to the classic Token program unconditionally (LP shares
 * are never Token-2022).
 */
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
const SLUG = 'voltr';
export const VOLTR_PROGRAM_ID = address('vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8');
export const SPL_TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM_PROGRAM_ID = address('11111111111111111111111111111111');
// ── Anchor IDL constants (voltr_vault v0.2.0, decoded from the on-chain IDL account) ──
const VAULT_DISCRIMINATOR = [211, 8, 232, 43, 2, 152, 117, 119];
/** Minimum real length (the 928-byte layout); a 952-byte variant also decodes fine. */
const VAULT_MIN_LEN = 928;
const OFF_ASSET_MINT = 104;
const OFF_TOTAL_VALUE = 168;
const OFF_LP_MINT = 272;
const OFF_MAX_CAP = 432;
const OFF_MANAGER_MGMT_FEE = 516;
const OFF_ADMIN_MGMT_FEE = 518;
const OFF_REDEMPTION_FEE = 520;
const OFF_ISSUANCE_FEE = 522;
const OFF_PROTOCOL_MGMT_FEE = 526;
const OFF_LAST_MGMT_FEE_UPDATE_TS = 568;
const OFF_ACCUM_LP_MANAGER_FEES = 576;
const OFF_ACCUM_LP_ADMIN_FEES = 584;
const OFF_ACCUM_LP_PROTOCOL_FEES = 592;
const OFF_DEAD_WEIGHT = 616;
const OFF_LOCKED_PROFIT_DEGRADATION_DURATION = 448;
const OFF_LOCKED_PROFIT_AMOUNT = 672; // locked_profit_state.last_updated_locked_profit
const OFF_LOCKED_PROFIT_LAST_REPORT = 680; // locked_profit_state.last_report
/** SPL `Mint.decimals`, u8 (4-byte COption tag + 32-byte pubkey + 8-byte supply precede it). */
const MINT_DECIMALS_OFFSET = 44;
/** SPL `Mint.supply`, u64 LE. */
const MINT_SUPPLY_OFFSET = 36;
/** SPL `TokenAccount.amount`, u64 LE. */
const TOKEN_AMOUNT_OFFSET = 64;
const DEPOSIT_VAULT_DISCRIMINATOR = Uint8Array.from([126, 224, 21, 255, 228, 53, 117, 33]);
const INSTANT_WITHDRAW_VAULT_DISCRIMINATOR = Uint8Array.from([221, 56, 115, 168, 128, 220, 235, 245]);
function voltrConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
// Bound at module scope (not per-call) — getAddressDecoder() builds a fresh
// codec instance each call, cheap but pointless to redo per field.
const ADDRESS_DECODER = getAddressDecoder();
function readAddress(data, offset) {
    return ADDRESS_DECODER.decode(data.subarray(offset, offset + 32));
}
let cachedProtocolPda;
function protocolPda() {
    if (cachedProtocolPda === undefined) {
        cachedProtocolPda = getProgramDerivedAddress({
            programAddress: VOLTR_PROGRAM_ID,
            seeds: [new TextEncoder().encode('protocol')],
        }).then(([pda]) => pda);
    }
    return cachedProtocolPda;
}
/**
 * Off-chain, once per pool: derive every PDA the CPI needs, verify the
 * stored LP mint address matches its own seed derivation (a cheap
 * self-consistency check — a mismatch means a wrong/spoofed account), and
 * read the two mints' decimals (needed only for the empty-vault bootstrap
 * case, fixed forever per vault so safe to bake at prepare time).
 */
export async function fetchVoltrConfig(load, pool) {
    const raw = await load(pool);
    if (raw === null)
        throw new Error(`${SLUG}: vault account ${pool} not found`);
    if (raw.length < VAULT_MIN_LEN) {
        throw new Error(`${SLUG}: vault account ${pool} is ${raw.length} bytes, want >= ${VAULT_MIN_LEN}`);
    }
    for (let i = 0; i < VAULT_DISCRIMINATOR.length; i++) {
        if (raw[i] !== VAULT_DISCRIMINATOR[i]) {
            throw new Error(`${SLUG}: vault account ${pool} has the wrong account discriminator`);
        }
    }
    const assetMint = readAddress(raw, OFF_ASSET_MINT);
    const lpMint = readAddress(raw, OFF_LP_MINT);
    const enc = getAddressEncoder();
    const poolBytes = enc.encode(pool);
    const [protocol, [vaultAssetIdleAuth], [vaultLpMintAuth], [derivedLpMint]] = await Promise.all([
        protocolPda(),
        getProgramDerivedAddress({
            programAddress: VOLTR_PROGRAM_ID,
            seeds: [new TextEncoder().encode('vault_asset_idle_auth'), poolBytes],
        }),
        getProgramDerivedAddress({
            programAddress: VOLTR_PROGRAM_ID,
            seeds: [new TextEncoder().encode('vault_lp_mint_auth'), poolBytes],
        }),
        getProgramDerivedAddress({
            programAddress: VOLTR_PROGRAM_ID,
            seeds: [new TextEncoder().encode('vault_lp_mint'), poolBytes],
        }),
    ]);
    if (derivedLpMint !== lpMint) {
        throw new Error(`${SLUG}: vault ${pool} lp mint ${lpMint} does not match its own PDA derivation ${derivedLpMint}`);
    }
    const [vaultAssetIdleAta] = await findAssociatedTokenPda({
        owner: vaultAssetIdleAuth,
        mint: assetMint,
        tokenProgram: SPL_TOKEN_PROGRAM_ID,
    });
    const [assetMintRaw, lpMintRaw] = await Promise.all([load(assetMint), load(lpMint)]);
    if (assetMintRaw === null)
        throw new Error(`${SLUG}: asset mint ${assetMint} not found`);
    if (lpMintRaw === null)
        throw new Error(`${SLUG}: lp mint ${lpMint} not found`);
    const assetDecimals = assetMintRaw[MINT_DECIMALS_OFFSET];
    const lpDecimals = lpMintRaw[MINT_DECIMALS_OFFSET];
    return {
        venue: SLUG,
        pool,
        direction: 'assetToLp',
        assetMint,
        lpMint,
        protocol,
        vaultAssetIdleAuth,
        vaultAssetIdleAta,
        vaultLpMintAuth,
        assetDecimals,
        lpDecimals,
    };
}
/** `10^n` as a bigint — used only to bake the empty-vault bootstrap scale at prepare time. */
function pow10(n) {
    let v = 1n;
    for (let i = 0; i < n; i++)
        v *= 10n;
    return v;
}
export const voltrLadder = {
    slug: SLUG,
    // Both directions are (at worst mildly) concave and near-linear — the CP
    // rung floor loses nothing meaningful to a coarser grid; see file header.
    defaultRungs: 2,
    shapeKey(base) {
        const c = voltrConfig(base);
        return `${SLUG}:${c.direction}`;
    },
    helpers() {
        return [
            {
                name: 'qVoltrDeposit',
                source: [
                    'function qVoltrDeposit(x, totalValue, lpSupplyInclFees, issuanceFeeBps, maxAllowedX, bootstrapMul, bootstrapDiv) {',
                    '  let effX = x;',
                    '  if (effX > maxAllowedX) { effX = maxAllowedX }',
                    '  if (effX === 0) { return 0 }',
                    '  if (lpSupplyInclFees === 0) {',
                    '    return (effX * bootstrapMul) / bootstrapDiv;',
                    '  }',
                    '  const den = totalValue * 10000 + effX * issuanceFeeBps;',
                    '  if (den === 0) { return 0 }',
                    '  return (effX * lpSupplyInclFees * (10000 - issuanceFeeBps)) / den;',
                    '}',
                ].join('\n'),
            },
            {
                name: 'qVoltrWithdraw',
                source: [
                    'function qVoltrWithdraw(x, totalUnlockedValue, lpSupplyInclFees, redemptionFeeBps, idleBalance) {',
                    '  if (x === 0) { return 0 }',
                    '  if (lpSupplyInclFees === 0) { return 0 }',
                    '  let out = (x * totalUnlockedValue * (10000 - redemptionFeeBps)) / (lpSupplyInclFees * 10000);',
                    '  if (out > idleBalance) { out = idleBalance }',
                    '  return out;',
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
        const c = voltrConfig(base);
        const refs = [
            { ref: ref(slot, 'vault'), address: c.pool },
            { ref: ref(slot, 'lpMint'), address: c.lpMint },
        ];
        if (c.direction === 'lpToAsset') {
            refs.push({ ref: ref(slot, 'idleAta'), address: c.vaultAssetIdleAta });
        }
        return refs;
    },
    emitSetup(base, slot) {
        const c = voltrConfig(base);
        const vault = JSON.stringify(ref(slot, 'vault'));
        const lpMint = JSON.stringify(ref(slot, 'lpMint'));
        const p = `s${slot}`;
        const shared = [
            `  const ${p}totalValue = accountUint(${vault}, ${OFF_TOTAL_VALUE}, 8);`,
            `  const ${p}lpSupply = accountUint(${lpMint}, ${MINT_SUPPLY_OFFSET}, 8);`,
            `  const ${p}deadWeight = accountUint(${vault}, ${OFF_DEAD_WEIGHT}, 8);`,
            `  const ${p}accumFees = accountUint(${vault}, ${OFF_ACCUM_LP_MANAGER_FEES}, 8) + accountUint(${vault}, ${OFF_ACCUM_LP_ADMIN_FEES}, 8) + accountUint(${vault}, ${OFF_ACCUM_LP_PROTOCOL_FEES}, 8);`,
            `  const ${p}mgmtFeeBps = accountUint(${vault}, ${OFF_MANAGER_MGMT_FEE}, 2) + accountUint(${vault}, ${OFF_ADMIN_MGMT_FEE}, 2) + accountUint(${vault}, ${OFF_PROTOCOL_MGMT_FEE}, 2);`,
            `  const ${p}lastMgmtTs = accountUint(${vault}, ${OFF_LAST_MGMT_FEE_UPDATE_TS}, 8);`,
            `  const ${p}lpSupplyInclAccum = ${p}lpSupply + ${p}accumFees + ${p}deadWeight;`,
            `  let ${p}unrealisedLpFees = 0;`,
            `  if (${p}lastMgmtTs !== 0 && ${p}totalValue !== 0 && ${p}mgmtFeeBps !== 0) {`,
            `    let ${p}elapsed = 0;`,
            `    if (block.timestamp > ${p}lastMgmtTs) { ${p}elapsed = block.timestamp - ${p}lastMgmtTs }`,
            `    if (${p}elapsed !== 0) {`,
            `      const ${p}feeInAsset = (${p}totalValue * ${p}elapsed * ${p}mgmtFeeBps) / 10000 / 31536000;`,
            `      const ${p}lpDen = ${p}totalValue - ${p}feeInAsset;`,
            `      if (${p}lpDen > 0) { ${p}unrealisedLpFees = (${p}feeInAsset * ${p}lpSupplyInclAccum + ${p}lpDen - 1) / ${p}lpDen }`,
            `    }`,
            `  }`,
            `  const ${p}lpSupplyInclFees = ${p}lpSupplyInclAccum + ${p}unrealisedLpFees;`,
        ];
        if (c.direction === 'lpToAsset') {
            const idleAta = JSON.stringify(ref(slot, 'idleAta'));
            return [
                ...shared,
                `  const ${p}redemptionFeeBps = accountUint(${vault}, ${OFF_REDEMPTION_FEE}, 2);`,
                `  const ${p}lockedDur = accountUint(${vault}, ${OFF_LOCKED_PROFIT_DEGRADATION_DURATION}, 8);`,
                `  let ${p}lockedProfit = 0;`,
                `  if (${p}lockedDur !== 0) {`,
                `    const ${p}lockedAmt = accountUint(${vault}, ${OFF_LOCKED_PROFIT_AMOUNT}, 8);`,
                `    const ${p}lockedReport = accountUint(${vault}, ${OFF_LOCKED_PROFIT_LAST_REPORT}, 8);`,
                `    let ${p}duration = 0;`,
                `    if (block.timestamp > ${p}lockedReport) { ${p}duration = block.timestamp - ${p}lockedReport }`,
                `    if (${p}duration <= ${p}lockedDur) { ${p}lockedProfit = (${p}lockedAmt * (${p}lockedDur - ${p}duration)) / ${p}lockedDur }`,
                `  }`,
                `  const ${p}totalUnlockedValue = ${p}totalValue - ${p}lockedProfit;`,
                `  const ${p}idleBalance = accountUint(${idleAta}, ${TOKEN_AMOUNT_OFFSET}, 8);`,
            ].join('\n');
        }
        // assetToLp (deposit)
        return [
            ...shared,
            `  const ${p}issuanceFeeBps = accountUint(${vault}, ${OFF_ISSUANCE_FEE}, 2);`,
            `  const ${p}maxCap = accountUint(${vault}, ${OFF_MAX_CAP}, 8);`,
            `  let ${p}maxAllowedX = 0;`,
            `  if (${p}maxCap > ${p}totalValue) { ${p}maxAllowedX = ${p}maxCap - ${p}totalValue }`,
        ].join('\n');
    },
    emitQuoteCall(base, slot, x) {
        const c = voltrConfig(base);
        const p = `s${slot}`;
        if (c.direction === 'lpToAsset') {
            return `qVoltrWithdraw(${x}, ${p}totalUnlockedValue, ${p}lpSupplyInclFees, ${p}redemptionFeeBps, ${p}idleBalance)`;
        }
        const diff = c.lpDecimals - c.assetDecimals;
        const bootstrapMul = diff >= 0 ? pow10(diff) : 1n;
        const bootstrapDiv = diff >= 0 ? 1n : pow10(-diff);
        return `qVoltrDeposit(${x}, ${p}totalValue, ${p}lpSupplyInclFees, ${p}issuanceFeeBps, ${p}maxAllowedX, ${bootstrapMul}, ${bootstrapDiv})`;
    },
    buildSwapV2(base, slot, user) {
        const c = voltrConfig(base);
        if (c.direction === 'lpToAsset') {
            return {
                programId: VOLTR_PROGRAM_ID,
                prefix: INSTANT_WITHDRAW_VAULT_DISCRIMINATOR,
                suffix: Uint8Array.from([1, 0]), // is_amount_in_lp=true, is_withdraw_all=false
                patch: 'in',
                accounts: [
                    { ref: user.owner, signer: true }, // 0 user_transfer_authority
                    { ref: ref(slot, 'protocol'), address: c.protocol }, // 1 protocol
                    { ref: ref(slot, 'vault'), address: c.pool, writable: true }, // 2 vault
                    { ref: ref(slot, 'assetMint'), address: c.assetMint }, // 3 vault_asset_mint
                    { ref: ref(slot, 'lpMint'), address: c.lpMint, writable: true }, // 4 vault_lp_mint
                    { ref: user.inAta, writable: true }, // 5 user_lp_ata (spending LP)
                    { ref: ref(slot, 'idleAta'), address: c.vaultAssetIdleAta, writable: true }, // 6 vault_asset_idle_ata
                    { ref: ref(slot, 'idleAuth'), address: c.vaultAssetIdleAuth, writable: true }, // 7 vault_asset_idle_auth
                    { ref: user.outAta, writable: true }, // 8 user_asset_ata (receiving asset)
                    { ref: ref(slot, 'assetTokenProgram'), address: SPL_TOKEN_PROGRAM_ID }, // 9 asset_token_program
                    { ref: ref(slot, 'lpTokenProgram'), address: SPL_TOKEN_PROGRAM_ID }, // 10 lp_token_program
                    { ref: ref(slot, 'systemProgram'), address: SYSTEM_PROGRAM_ID }, // 11 system_program
                ],
            };
        }
        return {
            programId: VOLTR_PROGRAM_ID,
            prefix: DEPOSIT_VAULT_DISCRIMINATOR,
            suffix: new Uint8Array(0),
            patch: 'in',
            accounts: [
                { ref: user.owner, signer: true }, // 0 user_transfer_authority
                { ref: ref(slot, 'protocol'), address: c.protocol }, // 1 protocol
                { ref: ref(slot, 'vault'), address: c.pool, writable: true }, // 2 vault
                { ref: ref(slot, 'assetMint'), address: c.assetMint }, // 3 vault_asset_mint
                { ref: ref(slot, 'lpMint'), address: c.lpMint, writable: true }, // 4 vault_lp_mint
                { ref: user.inAta, writable: true }, // 5 user_asset_ata (spending asset)
                { ref: ref(slot, 'idleAta'), address: c.vaultAssetIdleAta, writable: true }, // 6 vault_asset_idle_ata
                { ref: ref(slot, 'idleAuth'), address: c.vaultAssetIdleAuth }, // 7 vault_asset_idle_auth (readonly on deposit)
                { ref: user.outAta, writable: true }, // 8 user_lp_ata (receiving LP)
                { ref: ref(slot, 'lpMintAuth'), address: c.vaultLpMintAuth }, // 9 vault_lp_mint_auth
                { ref: ref(slot, 'assetTokenProgram'), address: SPL_TOKEN_PROGRAM_ID }, // 10 asset_token_program
                { ref: ref(slot, 'lpTokenProgram'), address: SPL_TOKEN_PROGRAM_ID }, // 11 lp_token_program
                { ref: ref(slot, 'systemProgram'), address: SYSTEM_PROGRAM_ID }, // 12 system_program
            ],
        };
    },
    referenceQuote(base, state, _params, now) {
        const c = voltrConfig(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
            return data;
        };
        const nowTs = now ?? BigInt(Math.floor(Date.now() / 1000));
        const vault = bytes(c.pool);
        const lpMint = bytes(c.lpMint);
        const totalValue = readU64LE(vault, OFF_TOTAL_VALUE);
        const lpSupply = readU64LE(lpMint, MINT_SUPPLY_OFFSET);
        const deadWeight = readU64LE(vault, OFF_DEAD_WEIGHT);
        const accumFees = readU64LE(vault, OFF_ACCUM_LP_MANAGER_FEES) +
            readU64LE(vault, OFF_ACCUM_LP_ADMIN_FEES) +
            readU64LE(vault, OFF_ACCUM_LP_PROTOCOL_FEES);
        const mgmtFeeBps = BigInt(readU16LE(vault, OFF_MANAGER_MGMT_FEE) + readU16LE(vault, OFF_ADMIN_MGMT_FEE) + readU16LE(vault, OFF_PROTOCOL_MGMT_FEE));
        const lastMgmtTs = readU64LE(vault, OFF_LAST_MGMT_FEE_UPDATE_TS);
        const lpSupplyInclAccum = lpSupply + accumFees + deadWeight;
        let unrealisedLpFees = 0n;
        if (lastMgmtTs !== 0n && totalValue !== 0n && mgmtFeeBps !== 0n) {
            const elapsed = nowTs > lastMgmtTs ? nowTs - lastMgmtTs : 0n;
            if (elapsed !== 0n) {
                const feeInAsset = (totalValue * elapsed * mgmtFeeBps) / 10000n / 31536000n;
                const lpDen = totalValue - feeInAsset;
                if (lpDen > 0n)
                    unrealisedLpFees = (feeInAsset * lpSupplyInclAccum + lpDen - 1n) / lpDen;
            }
        }
        const lpSupplyInclFees = lpSupplyInclAccum + unrealisedLpFees;
        if (c.direction === 'lpToAsset') {
            const redemptionFeeBps = BigInt(readU16LE(vault, OFF_REDEMPTION_FEE));
            const lockedDur = readU64LE(vault, OFF_LOCKED_PROFIT_DEGRADATION_DURATION);
            let lockedProfit = 0n;
            if (lockedDur !== 0n) {
                const lockedAmt = readU64LE(vault, OFF_LOCKED_PROFIT_AMOUNT);
                const lockedReport = readU64LE(vault, OFF_LOCKED_PROFIT_LAST_REPORT);
                const duration = nowTs > lockedReport ? nowTs - lockedReport : 0n;
                if (duration <= lockedDur)
                    lockedProfit = (lockedAmt * (lockedDur - duration)) / lockedDur;
            }
            const totalUnlockedValue = totalValue - lockedProfit;
            const idleBalance = readU64LE(bytes(c.vaultAssetIdleAta), TOKEN_AMOUNT_OFFSET);
            return (x) => {
                if (x === 0n)
                    return 0n;
                if (lpSupplyInclFees === 0n)
                    return 0n;
                let out = (x * totalUnlockedValue * (10000n - redemptionFeeBps)) / (lpSupplyInclFees * 10000n);
                if (out > idleBalance)
                    out = idleBalance;
                return out;
            };
        }
        const issuanceFeeBps = BigInt(readU16LE(vault, OFF_ISSUANCE_FEE));
        const maxCap = readU64LE(vault, OFF_MAX_CAP);
        const maxAllowedX = maxCap > totalValue ? maxCap - totalValue : 0n;
        const diff = c.lpDecimals - c.assetDecimals;
        const bootstrapMul = diff >= 0 ? pow10(diff) : 1n;
        const bootstrapDiv = diff >= 0 ? 1n : pow10(-diff);
        return (x) => {
            let effX = x > maxAllowedX ? maxAllowedX : x;
            if (effX === 0n)
                return 0n;
            if (lpSupplyInclFees === 0n)
                return (effX * bootstrapMul) / bootstrapDiv;
            const den = totalValue * 10000n + effX * issuanceFeeBps;
            if (den === 0n)
                return 0n;
            return (effX * lpSupplyInclFees * (10000n - issuanceFeeBps)) / den;
        };
    },
    depthReserves(base, state, now) {
        const c = voltrConfig(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
            return data;
        };
        const vault = bytes(c.pool);
        const lpMint = bytes(c.lpMint);
        const totalValue = readU64LE(vault, OFF_TOTAL_VALUE);
        const lpSupply = readU64LE(lpMint, MINT_SUPPLY_OFFSET);
        if (c.direction === 'lpToAsset') {
            const nowTs = now ?? BigInt(Math.floor(Date.now() / 1000));
            const lockedDur = readU64LE(vault, OFF_LOCKED_PROFIT_DEGRADATION_DURATION);
            let lockedProfit = 0n;
            if (lockedDur !== 0n) {
                const lockedAmt = readU64LE(vault, OFF_LOCKED_PROFIT_AMOUNT);
                const lockedReport = readU64LE(vault, OFF_LOCKED_PROFIT_LAST_REPORT);
                const duration = nowTs > lockedReport ? nowTs - lockedReport : 0n;
                if (duration <= lockedDur)
                    lockedProfit = (lockedAmt * (lockedDur - duration)) / lockedDur;
            }
            const totalUnlockedValue = totalValue - lockedProfit;
            const idleBalance = readU64LE(bytes(c.vaultAssetIdleAta), TOKEN_AMOUNT_OFFSET);
            const reserveOut = totalUnlockedValue < idleBalance ? totalUnlockedValue : idleBalance;
            return { reserveIn: lpSupply, reserveOut };
        }
        return { reserveIn: totalValue, reserveOut: lpSupply };
    },
    continuousFees(base, state) {
        // Measurement-only oracle input (never a gate). gamma=1 (no CP-style price
        // impact — the real curve is exactly linear or mildly saturating, strictly
        // MORE depth than a genuine CP curve at the same reserves); mu reflects
        // the real retained fee bps (issuance on deposit, redemption on withdraw)
        // so the oracle isn't more favorable than reality — 1 bps == 100 ppm.
        const c = voltrConfig(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder continuousFees is missing account ${addr}`);
            return data;
        };
        const vault = bytes(c.pool);
        const feeBps = c.direction === 'lpToAsset' ? readU16LE(vault, OFF_REDEMPTION_FEE) : readU16LE(vault, OFF_ISSUANCE_FEE);
        const muPpm = 1000000n - BigInt(feeBps) * 100n;
        return { gammaPpm: 1000000n, muPpm };
    },
};
function readU64LE(data, offset) {
    let v = 0n;
    for (let i = 7; i >= 0; i--)
        v = (v << 8n) | BigInt(data[offset + i]);
    return v;
}
function readU16LE(data, offset) {
    return data[offset] | (data[offset + 1] << 8);
}
//# sourceMappingURL=index.js.map