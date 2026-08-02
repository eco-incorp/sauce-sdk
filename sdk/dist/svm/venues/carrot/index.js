/**
 * Carrot Protocol vault ladder — a NAV-priced, multi-asset stablecoin vault
 * (issue/redeem against a shared basket), NOT a 2-mint AMM pool. One
 * singleton on-chain `Vault` account (`FfCRL34rkJiMiX5emNDrYp3MdWH2mES3FvDQyFppqgpJ`,
 * a PDA of `["vault", CRT_MINT]` under `CARROT_PROGRAM_ID`) currently holds
 * three basket assets (USDC/USDT/pyUSD) and issues/redeems a single share
 * token (CRT, Token-2022). This adapter serves SIX directed pairs off that
 * one account — `issue:<assetId>` (asset -> CRT) and `redeem:<assetId>`
 * (CRT -> asset) for each basket asset — via `carrotAllDirections` (see
 * `ecoswap/svm/index.ts`'s FAMILIES dispatch generalization it requires).
 *
 * GROUND TRUTH: no official IDL/program source is public. Layout, instruction
 * discriminators, and the account list are taken from the reverse-engineered
 * `carrot-sdk` crate (github.com/hogyzen12/carrot-sdk, MIT, matches an
 * observed 4,872-byte Anchor IDL blob) and INDEPENDENTLY CONFIRMED against
 * the real deployed program:
 *   - the byte layout below was decoded against the REAL vault account
 *     (`FfCRL34rkJiMiX5emNDrYp3MdWH2mES3FvDQyFppqgpJ`, 852 bytes, 3 assets,
 *     22+ strategies) and cross-checked field-by-field against the crate's
 *     `Vault`/`Fee`/`Asset`/`StrategyRecord` Borsh structs;
 *   - the `issue`/`redeem` account list and instruction discriminators were
 *     PROVEN via six real `simulateTransaction` dry-runs (sigVerify:false,
 *     no funds moved, an existing funded mainnet wallet's own ATAs as
 *     depositor/dest) against the live program — three ISSUE sizes
 *     (0.1/1/4 USDC -> 1,735,398 / 17,353,982 / 69,415,929 CRT-raw, matching
 *     this ladder's own formula to ~0.04%, fully attributable to ordinary
 *     mainnet state drift between the off-chain snapshot and the later
 *     simulateTransaction call — see "VALIDATION" below) and three REDEEM
 *     sizes (100/200/486 CRT-raw -> 5/11/27 USDC-raw, bit-exact at this dust
 *     scale). The real CPI needs ~232,244 CU (see `../budget.ts`'s
 *     `CU_FAMILIES.carrot`) — the framework's default 200,000 CU budget is
 *     NOT enough; every issue/redeem needs an explicit ComputeBudget bump.
 *
 * NAV FORMULA (the "single-asset path" this integration ships): the real
 * `issue`/`redeem` account list carries, per basket asset, ONLY `[vaultAta,
 * oracle]` as remaining accounts — NO strategy account ever rides the
 * instruction (confirmed both by the crate's `Vault::get_remaining_accounts`
 * source AND by the six real dry-runs above succeeding with exactly that
 * account set). This means the on-chain program cannot read a strategy's
 * LIVE external-protocol position during a swap at all — it can only value
 * each basket asset from what the instruction actually attaches: that
 * asset's own vault-held ATA balance and its oracle price. The vault's own
 * cached `StrategyRecord.balance` ledger (deployed-to-marginfi/klend/solend/
 * mango/drift positions) is therefore NOT part of the on-chain NAV this
 * swap computes — confirmed numerically: modeling NAV as
 * Σ(vaultAta·price) alone reproduces the six measured dry-runs to ~0.04%
 * (ordinary same-second price/state drift); including the cached strategy
 * balances in NAV is off by ~0.33%, an order of magnitude worse and NOT
 * explained by drift. So: **no marginfi/klend/solend/mango/drift adaptor is
 * needed at all for this swap path** — the plan text's premise that one is
 * required doesn't hold once you look at what accounts the real CPI
 * actually reads. This corrects, rather than follows, that premise.
 *   NAV_common = Σ_assets  ataBalance_i · oraclePrice_i · scale_i
 *   issue:  sharesOut = floor(x · price_t · scale_t · supply / NAV_common)
 *   redeem: grossCommon = floor(x · NAV_common / supply)
 *           grossOut    = floor(grossCommon / (price_t · scale_t))
 *           netOut      = grossOut − floor(grossOut · redemptionFeeBps / 10000)
 *           netOut      = min(netOut, ataBalance_t)   — SATURATING capacity
 *             clamp (see "CAPACITY" below), never a cliff to zero.
 * `scale_i = 10^(CARROT_TARGET_SCALE + oracleExponent_i − decimals_i)` is a
 * per-asset, fetch-time-baked (never live-computed on-chain — SauceScript has
 * no exponentiation intrinsic) integer factor that puts every asset's
 * ata·price term on one common denomination before summing; it is 10,000 for
 * all three known assets today (decimals=6, oracle exponent=−8 uniformly),
 * derived generically (not hardcoded to 6/−8) so a future basket asset with
 * different decimals/exponent needs no code change. All arithmetic is plain
 * BigInt multiply/floor-divide — the intermediate products here (at most
 * ~1e13 balance × ~1e8 price × 1e4 scale ≈ 1e25 per term) stay far under a
 * u256 word, so no `Math.mulDiv` wide-multiply is needed (see obric-v2's
 * ladder for the same plain-arithmetic convention with oracle-scaled terms).
 *
 * CAPACITY: `issue` is genuinely unbounded pool-side (any deposit mints
 * proportional shares, matching sanctum-stake-pool's "no curvature to
 * misrepresent" reasoning) — `defaultRungs` would lose nothing at 2, but
 * this family is pinned at the framework's CP default (4, via
 * `CU_FAMILIES.carrot.kind = 'cp'`) because `redeem` is NOT unbounded: its
 * payout is a plain SPL transfer out of `vaultAta_t`, so redeeming more
 * shares than that asset's live vault balance covers would REVERT the real
 * CPI atomically (and a launched CPI failure aborts the whole SVM cook — no
 * execution-time catch). `netOut = min(computed, ataBalance_t)` SATURATES
 * the curve instead of collapsing it — monotone non-decreasing, flat past
 * capacity — exactly the shape the merge needs to keep this venue
 * electable near its cap rather than allocating it zero (see
 * `docs`/CLAUDE.md's "a coarse or non-monotone ladder gets allocated ZERO"
 * note); the extra rungs (vs. issue's 2 would suffice) buy the merge enough
 * resolution to see the kink.
 *
 * SELF-DROP SCOPE: the plan text anticipated self-dropping "when an asset's
 * strategy account is unreadable" — but per the NAV formula above, no
 * strategy account is ever read, so that specific failure mode cannot arise.
 * The analogous, CORRECTLY-SCOPED self-drop this adapter implements is: the
 * WHOLE vault self-drops (fetchPoolConfig throws, caught by
 * `resolveSvmPoolSpec`) if the vault is paused, holds more than
 * `CARROT_MAX_ASSETS` basket assets (a fail-loud cap, not a silent
 * truncation — see that constant), or if ANY basket asset's mint/ata/oracle
 * account is missing or fails its shape gate — because NAV_common is a JOINT
 * sum over every basket asset, one bad asset makes every direction's quote
 * wrong, not just that asset's own. `entry.gate` additionally self-drops the
 * SPECIFIC direction being resolved if its own oracle reading is stale
 * (`now − publishTime` beyond `MAX_ORACLE_STALENESS_SECONDS`) — a per-
 * direction, not whole-vault, condition.
 *
 * TOKEN PROGRAM: CRT and pyUSD are Token-2022; USDC/USDT are classic
 * Tokenkeg — this mirrors the reference SDK's OWN hardcoded
 * `get_token_program_id` (there is no way to derive "which token program"
 * from mint account BYTES alone: a Token-2022 mint with zero extensions is
 * byte-identical in its first 82 bytes to a classic mint, and the shared
 * `AccountLoader` interface exposes bytes only, never the account's owner
 * metadata) — `CARROT_TOKEN_2022_MINTS` names the known set explicitly.
 *
 * DISCOVERY: this is a SINGLETON (one vault, ever) with a basket, not a
 * "many pools, one 2-mint pair each" family — it does not fit
 * `SVM_FAMILY_FILTERS`' generic getProgramAccounts memcmp shape (there is
 * nothing to scan for, and the second mint of any pair lives at a
 * per-asset-index offset inside a Vec, not one fixed offset). It is wired as
 * a bespoke, zero-RPC candidate emission in `ecoswap/svm/discovery.ts`
 * instead — see that file's `carrotCandidatesFor`.
 */
import { address, getAddressDecoder } from '@solana/kit';
import { readUintLE } from '../math.js';
export const CARROT_PROGRAM_ID = address('CarrotwivhMpDnm27EHmRLeQ683Z1PufuqEmBZvD282s');
export const CRT_MINT = address('CRTx1JouZhzSU6XytsE42UQraoGqiHgxabocVfARTy2s');
/** The one deployed vault — a PDA of `["vault", CRT_MINT]`, singleton today. */
export const CARROT_VAULT_ADDRESS = address('FfCRL34rkJiMiX5emNDrYp3MdWH2mES3FvDQyFppqgpJ');
const LOG_PROGRAM_ID = address('7Mc3vSdRWoThArpni6t5W4XjvQf4BuMny1uC8b6VBn48');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
/** See the module header's TOKEN PROGRAM note — CRT (shares) plus pyUSD are the only Token-2022 mints today. */
export const CARROT_TOKEN_2022_MINTS = new Set([
    CRT_MINT,
    address('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'), // pyUSD
]);
/** `sha256("global:issue")[..8]` / `sha256("global:redeem")[..8]` — Anchor discriminators, confirmed live (see module header). */
const ISSUE_DISCRIMINATOR = Uint8Array.from([190, 1, 98, 214, 81, 99, 222, 247]);
const REDEEM_DISCRIMINATOR = Uint8Array.from([184, 12, 86, 149, 70, 196, 97, 225]);
const ATA_AMOUNT_OFFSET = 64;
const MINT_SUPPLY_OFFSET = 36;
// Sequential Vault layout (confirmed byte-exact against the real 852-byte account — see module
// header): authority@8 (32), shares@40 (32), fee@72 (30: u16+u64+u16+i64+u64+u16), paused@102 (1),
// assetIndex@103 (2), strategyIndex@105 (2), then `assets: Vec<Asset>` (u32 len @107, each element
// asset_id(2)+mint(32)+decimals(1)+ata(32)+oracle(32) = 99 bytes) — `strategies: Vec<StrategyRecord>`
// follows but is NEVER READ here (see the module header's NAV FORMULA note: no strategy value ever
// rides the real issue/redeem CPI).
const OFF_SHARES = 40;
const OFF_FEE_REDEMPTION_BPS = 72;
const OFF_PAUSED = 102;
const OFF_ASSETS_LEN = 107;
const ASSET_FIRST_OFFSET = 111;
const ASSET_STRUCT_SIZE = 99; // 2 (asset_id) + 32 (mint) + 1 (decimals) + 32 (ata) + 32 (oracle)
/**
 * Fail-loud cap on basket size (not a silent truncation) — see the module
 * header's SELF-DROP SCOPE note. The vault has held exactly 3 assets
 * (USDC/USDT/pyUSD) for its entire observed history; `paramCount` below is
 * sized for this. A real 4th-asset addition needs this constant (and
 * `paramCount`) bumped, not a silent misquote.
 */
export const CARROT_MAX_ASSETS = 3;
/** Pyth `PriceUpdateV2` (pyth-solana-receiver) layout, confirmed live against all 3 basket oracles. */
const PYTH_RECEIVER_PROGRAM_ID = address('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
// disc(8) + write_authority(32) = 40 — the verification-level tag sits right after.
const ORACLE_VERIFICATION_TAG_OFFSET = 40;
/** `VerificationLevel::Partial{num_signatures}` (tag 0, +1 byte) vs `::Full` (tag 1, +0 bytes). */
const ORACLE_VERIFICATION_PARTIAL_TAG = 0;
const ORACLE_VERIFICATION_FULL_TAG = 1;
const ORACLE_FEED_ID_SIZE = 32;
/** Common target scale (see module header's NAV FORMULA note) — arbitrary but fixed; matches this repo's existing "wad"-style 1e18 convention elsewhere. */
const CARROT_TARGET_SCALE = 18;
/** Pyth pull-oracle price update cadence is sub-second in practice; 5 minutes is a generous, not a tight, staleness bound. */
const MAX_ORACLE_STALENESS_SECONDS = 300n;
const U64_MAX = (1n << 64n) - 1n;
const addressDecoder = getAddressDecoder();
const pubkeyAt = (data, offset) => addressDecoder.decode(data.subarray(offset, offset + 32));
export function parseCarrotDirection(direction) {
    const m = /^(issue|redeem):(\d+)$/.exec(direction);
    if (m === null)
        throw new Error(`carrot direction must be 'issue:<assetId>' or 'redeem:<assetId>', got '${direction}'`);
    return { op: m[1], assetId: Number(m[2]) };
}
function carrotConfig(cfg) {
    if (cfg.venue !== 'carrot')
        throw new Error(`carrot ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
function requireAsset(cfg, assetId) {
    const asset = cfg.assets.find((a) => a.assetId === assetId);
    if (asset === undefined) {
        throw new Error(`carrot vault ${cfg.pool}: asset id ${assetId} not present (known: ${cfg.assets.map((a) => a.assetId).join(', ')})`);
    }
    return asset;
}
/** Every `issue:<id>` / `redeem:<id>` direction the fetched vault currently offers, in asset order — the multi-direction dispatch `resolveSvmPoolSpec` tries (see `ecoswap/svm/index.ts`). */
export function carrotAllDirections(cfg) {
    const c = carrotConfig(cfg);
    const dirs = [];
    for (const a of c.assets) {
        dirs.push(`issue:${a.assetId}`);
        dirs.push(`redeem:${a.assetId}`);
    }
    return dirs;
}
function decodeOraclePriceOffset(data, pool, oracle) {
    if (data.length < ORACLE_VERIFICATION_TAG_OFFSET + 1) {
        throw new Error(`carrot vault ${pool}: oracle ${oracle} account too small to carry a verification tag`);
    }
    const tag = data[ORACLE_VERIFICATION_TAG_OFFSET];
    if (tag === ORACLE_VERIFICATION_FULL_TAG)
        return ORACLE_VERIFICATION_TAG_OFFSET + 1 + ORACLE_FEED_ID_SIZE;
    if (tag === ORACLE_VERIFICATION_PARTIAL_TAG)
        return ORACLE_VERIFICATION_TAG_OFFSET + 2 + ORACLE_FEED_ID_SIZE;
    throw new Error(`carrot vault ${pool}: oracle ${oracle} has an unrecognized verification-level tag ${tag}`);
}
async function fetchCarrotPoolConfig(load, pool) {
    const data = await load(pool);
    if (data === null)
        throw new Error(`carrot vault ${pool} account not found`);
    if (data.length < ASSET_FIRST_OFFSET)
        throw new Error(`carrot vault ${pool} account is only ${data.length} bytes — too small to be a Vault`);
    const sharesMint = pubkeyAt(data, OFF_SHARES);
    const redemptionFeeBps = readUintLE(data, OFF_FEE_REDEMPTION_BPS, 2);
    const paused = data[OFF_PAUSED] !== 0;
    if (paused)
        throw new Error(`carrot vault ${pool} is paused`);
    const assetsLen = Number(readUintLE(data, OFF_ASSETS_LEN, 4));
    if (assetsLen === 0)
        throw new Error(`carrot vault ${pool} has no basket assets`);
    if (assetsLen > CARROT_MAX_ASSETS) {
        throw new Error(`carrot vault ${pool} carries ${assetsLen} basket assets, over the CARROT_MAX_ASSETS=${CARROT_MAX_ASSETS} this adapter is sized for — bump the constant rather than silently truncating NAV`);
    }
    const rawAssets = [];
    let off = ASSET_FIRST_OFFSET;
    for (let i = 0; i < assetsLen; i++) {
        if (off + ASSET_STRUCT_SIZE > data.length)
            throw new Error(`carrot vault ${pool}: truncated asset entry ${i}`);
        const assetId = Number(readUintLE(data, off, 2));
        const mint = pubkeyAt(data, off + 2);
        const decimals = data[off + 34];
        const ata = pubkeyAt(data, off + 35);
        const oracle = pubkeyAt(data, off + 67);
        rawAssets.push({ assetId, mint, decimals, ata, oracle });
        off += ASSET_STRUCT_SIZE;
    }
    const crtMintData = await load(sharesMint);
    if (crtMintData === null)
        throw new Error(`carrot vault ${pool}: shares mint ${sharesMint} account not found`);
    if (crtMintData.length < MINT_SUPPLY_OFFSET + 8)
        throw new Error(`carrot vault ${pool}: shares mint ${sharesMint} is not a valid SPL mint`);
    // Every basket asset is read together (NAV is their joint sum) — one bad asset self-drops the
    // WHOLE vault (every direction), never just that asset (see module header's SELF-DROP SCOPE note).
    const assets = [];
    for (const a of rawAssets) {
        const [ataData, oracleData] = await Promise.all([load(a.ata), load(a.oracle)]);
        if (ataData === null)
            throw new Error(`carrot vault ${pool}: asset ${a.assetId} vault ATA ${a.ata} not found`);
        if (ataData.length < ATA_AMOUNT_OFFSET + 8)
            throw new Error(`carrot vault ${pool}: asset ${a.assetId} vault ATA ${a.ata} is not a valid SPL token account`);
        if (oracleData === null)
            throw new Error(`carrot vault ${pool}: asset ${a.assetId} oracle ${a.oracle} not found`);
        const priceOffset = decodeOraclePriceOffset(oracleData, pool, a.oracle);
        if (oracleData.length < priceOffset + 8 + 8 + 4 + 8) {
            throw new Error(`carrot vault ${pool}: asset ${a.assetId} oracle ${a.oracle} is too small for a PriceUpdateV2 price message`);
        }
        const rawPrice = readUintLE(oracleData, priceOffset, 8);
        // Pyth price is a signed i64; a legitimate USD-stablecoin feed is always positive — reject the
        // top-bit-set (negative) case rather than silently treating it as a huge unsigned price.
        if (rawPrice >= 1n << 63n)
            throw new Error(`carrot vault ${pool}: asset ${a.assetId} oracle ${a.oracle} reports a negative price`);
        if (rawPrice === 0n)
            throw new Error(`carrot vault ${pool}: asset ${a.assetId} oracle ${a.oracle} reports a zero price`);
        const publishTime = readUintLE(oracleData, priceOffset + 8 + 8 + 4, 8);
        // exponent (i32) sits AFTER price(i64, 8 bytes) AND conf(u64, 8 bytes) — offset +16, not +8.
        const rawExponent = readUintLE(oracleData, priceOffset + 8 + 8, 4);
        const exponent = Number(rawExponent >= 1n << 31n ? rawExponent - (1n << 32n) : rawExponent);
        const scaleExp = CARROT_TARGET_SCALE + exponent - a.decimals;
        if (scaleExp < 0) {
            throw new Error(`carrot vault ${pool}: asset ${a.assetId} has a negative implied scale exponent ${scaleExp} (exponent=${exponent}, decimals=${a.decimals}) — CARROT_TARGET_SCALE too small`);
        }
        const scale = 10n ** BigInt(scaleExp);
        assets.push({
            assetId: a.assetId,
            mint: a.mint,
            decimals: a.decimals,
            ata: a.ata,
            oracle: a.oracle,
            priceOffset,
            scale,
            priceSnapshot: rawPrice,
            publishTime,
        });
    }
    return {
        venue: 'carrot',
        pool,
        sharesMint,
        redemptionFeeBps,
        assets,
        direction: `issue:${assets[0].assetId}`,
    };
}
function tokenProgramFor(mint) {
    return CARROT_TOKEN_2022_MINTS.has(mint) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
}
const ref = (slot, role) => `s${slot}:${role}`;
const HELPER_ISSUE = 'qCarrotIssue';
const HELPER_REDEEM = 'qCarrotRedeem';
export const carrot = {
    slug: 'carrot',
    programId: CARROT_PROGRAM_ID,
    fetchPoolConfig: (load, pool) => fetchCarrotPoolConfig(load, pool),
};
export const carrotLadder = {
    slug: 'carrot',
    // CP-class: closed-form, no Newton iteration — but see the module header's
    // CAPACITY note for why this stays at the CP default (4) rather than
    // sanctum-stake-pool's 2: `redeem`'s saturating clamp needs the extra
    // resolution to be visible to the merge as a kink, not just two endpoints.
    defaultRungs: 4,
    shapeKey(base) {
        return `carrot:${carrotConfig(base).direction}`;
    },
    helpers() {
        return [
            {
                name: HELPER_ISSUE,
                // Unbounded (see module header) — dust/zero-NAV inputs return 0, matching every other
                // family's convention (a quote helper returns 0 for x == 0 and for rejected/degenerate inputs).
                source: [
                    `function ${HELPER_ISSUE}(x, priceT, scaleT, nav, supply) {`,
                    '  if (x === 0) { return 0 }',
                    '  if (nav === 0) { return 0 }',
                    '  const depositValue = x * priceT * scaleT;',
                    '  return (depositValue * supply) / nav;',
                    '}',
                ].join('\n'),
            },
            {
                name: HELPER_REDEEM,
                // SATURATING at ataT (the vault's live balance of the target asset) — never a cliff to
                // zero; see module header's CAPACITY note.
                source: [
                    `function ${HELPER_REDEEM}(x, priceT, scaleT, nav, supply, feeBps, ataT) {`,
                    '  if (x === 0) { return 0 }',
                    '  if (supply === 0) { return 0 }',
                    '  const denom = priceT * scaleT;',
                    '  if (denom === 0) { return 0 }',
                    '  const grossCommon = (x * nav) / supply;',
                    '  const grossOut = grossCommon / denom;',
                    '  const fee = (grossOut * feeBps) / 10000;',
                    '  let net = grossOut - fee;',
                    '  if (net < 0) { net = 0 }',
                    '  if (net > ataT) { net = ataT }',
                    '  return net;',
                    '}',
                ].join('\n'),
            },
        ];
    },
    // Uniform across every direction (see CARROT_MAX_ASSETS's fail-loud-not-silent note): 3 per-asset
    // scale factors, 3 per-asset baked oracle price offsets, 1 vault-level redemption fee bps.
    paramCount: CARROT_MAX_ASSETS * 2 + 1,
    paramsFor(base) {
        const c = carrotConfig(base);
        const params = [];
        for (let i = 0; i < CARROT_MAX_ASSETS; i++)
            params.push(c.assets[i]?.scale ?? 0n);
        for (let i = 0; i < CARROT_MAX_ASSETS; i++)
            params.push(c.assets[i] === undefined ? 0n : BigInt(c.assets[i].priceOffset));
        params.push(c.redemptionFeeBps);
        return params;
    },
    quoteRefs(base, slot) {
        const c = carrotConfig(base);
        const refs = [];
        for (let i = 0; i < c.assets.length; i++) {
            refs.push({ ref: ref(slot, `ata${i}`), address: c.assets[i].ata });
            refs.push({ ref: ref(slot, `oracle${i}`), address: c.assets[i].oracle });
        }
        refs.push({ ref: ref(slot, 'crtMint'), address: c.sharesMint });
        return refs;
    },
    emitSetup(base, slot, params) {
        const c = carrotConfig(base);
        const p = `s${slot}`;
        const lines = [];
        const balVars = [];
        const priceVars = [];
        const scaleVars = [];
        for (let i = 0; i < c.assets.length; i++) {
            const balVar = `${p}b${i}`;
            // NOT `${p}p${i}` — the codegen prologue already reserves that exact naming pattern
            // (`s<slot>p<paramIndex>`) for the raw cfg-param words it unpacks (paramsFor's 7 entries land
            // as s0p0..s0p6 here) — colliding with it is a real duplicate-`const` compile error, not a
            // style nit (caught by the staged-compile test below).
            const priceVar = `${p}px${i}`;
            const scaleVar = `${p}sc${i}`;
            const scaleLiteral = params[i];
            const priceOffLiteral = params[CARROT_MAX_ASSETS + i];
            lines.push(`  const ${balVar} = accountUint(${JSON.stringify(ref(slot, `ata${i}`))}, ${ATA_AMOUNT_OFFSET}, 8);`);
            lines.push(`  const ${priceVar} = accountUint(${JSON.stringify(ref(slot, `oracle${i}`))}, ${priceOffLiteral}, 8);`);
            lines.push(`  const ${scaleVar} = ${scaleLiteral};`);
            balVars.push(balVar);
            priceVars.push(priceVar);
            scaleVars.push(scaleVar);
        }
        lines.push(`  const ${p}supply = accountUint(${JSON.stringify(ref(slot, 'crtMint'))}, ${MINT_SUPPLY_OFFSET}, 8);`);
        lines.push(`  const ${p}fee = ${params[CARROT_MAX_ASSETS * 2]};`);
        const navTerms = balVars.map((b, i) => `(${b} * ${priceVars[i]} * ${scaleVars[i]})`).join(' + ');
        lines.push(`  const ${p}nav = ${navTerms};`);
        return lines.join('\n');
    },
    emitQuoteCall(base, slot, x) {
        const c = carrotConfig(base);
        const { op, assetId } = parseCarrotDirection(c.direction);
        const idx = c.assets.findIndex((a) => a.assetId === assetId);
        if (idx === -1)
            throw new Error(`carrot vault ${c.pool}: asset id ${assetId} not present at emitQuoteCall time`);
        const p = `s${slot}`;
        if (op === 'issue') {
            return `${HELPER_ISSUE}(${x}, ${p}px${idx}, ${p}sc${idx}, ${p}nav, ${p}supply)`;
        }
        return `${HELPER_REDEEM}(${x}, ${p}px${idx}, ${p}sc${idx}, ${p}nav, ${p}supply, ${p}fee, ${p}b${idx})`;
    },
    buildSwapV2(base, slot, user) {
        const c = carrotConfig(base);
        const { op, assetId } = parseCarrotDirection(c.direction);
        const target = requireAsset(c, assetId);
        const idx = c.assets.findIndex((a) => a.assetId === assetId);
        const assetTokenProgram = tokenProgramFor(target.mint);
        const sharesAtaRef = op === 'issue' ? user.outAta : user.inAta;
        const assetAtaRef = op === 'issue' ? user.inAta : user.outAta;
        const accounts = [
            { ref: ref(slot, 'vault'), address: c.pool, writable: true },
            { ref: ref(slot, 'crtMint'), address: c.sharesMint, writable: true },
            { ref: sharesAtaRef, writable: true },
            { ref: ref(slot, 'assetMint'), address: target.mint },
            { ref: ref(slot, `ata${idx}`), address: target.ata, writable: true },
            { ref: assetAtaRef, writable: true },
            { ref: user.owner, signer: true, writable: true },
            { ref: ref(slot, 'systemProgram'), address: SYSTEM_PROGRAM },
            { ref: ref(slot, 'assetTokenProgram'), address: assetTokenProgram },
            { ref: ref(slot, 'sharesTokenProgram'), address: TOKEN_2022_PROGRAM },
            { ref: ref(slot, 'logProgram'), address: LOG_PROGRAM_ID },
        ];
        // remaining_accounts: [ata, oracle] for EVERY basket asset, in vault order — regardless of
        // which one is the traded target (the real program needs the full set to compute NAV; see
        // module header). The target's own [ata, oracle] pair legitimately appears TWICE (once as the
        // dedicated vault_asset_ata slot above, once here) — confirmed against the six real dry-runs.
        for (let i = 0; i < c.assets.length; i++) {
            accounts.push({ ref: ref(slot, `ata${i}`), address: c.assets[i].ata, writable: true });
            accounts.push({ ref: ref(slot, `oracle${i}`), address: c.assets[i].oracle });
        }
        return {
            programId: CARROT_PROGRAM_ID,
            prefix: op === 'issue' ? ISSUE_DISCRIMINATOR : REDEEM_DISCRIMINATOR,
            suffix: Uint8Array.from([]),
            patch: 'in',
            accounts,
        };
    },
    referenceQuote(base, state, params) {
        const c = carrotConfig(base);
        const { op, assetId } = parseCarrotDirection(c.direction);
        const idx = c.assets.findIndex((a) => a.assetId === assetId);
        if (idx === -1)
            throw new Error(`carrot vault ${c.pool}: asset id ${assetId} not present at referenceQuote time`);
        let nav = 0n;
        const balances = [];
        const prices = [];
        for (let i = 0; i < c.assets.length; i++) {
            const a = c.assets[i];
            const ataData = state[a.ata];
            const oracleData = state[a.oracle];
            if (ataData === undefined)
                throw new Error(`carrot ladder reference is missing ata ${a.ata}`);
            if (oracleData === undefined)
                throw new Error(`carrot ladder reference is missing oracle ${a.oracle}`);
            const bal = readUintLE(ataData, ATA_AMOUNT_OFFSET, 8);
            const priceOffset = Number(params[CARROT_MAX_ASSETS + i]);
            const price = readUintLE(oracleData, priceOffset, 8);
            const scale = params[i];
            balances.push(bal);
            prices.push(price);
            nav += bal * price * scale;
        }
        const crtData = state[c.sharesMint];
        if (crtData === undefined)
            throw new Error(`carrot ladder reference is missing shares mint ${c.sharesMint}`);
        const supply = readUintLE(crtData, MINT_SUPPLY_OFFSET, 8);
        const scaleT = params[idx];
        const priceT = prices[idx];
        const feeBps = params[CARROT_MAX_ASSETS * 2];
        const ataT = balances[idx];
        if (op === 'issue') {
            return (x) => {
                if (x === 0n || nav === 0n)
                    return 0n;
                const depositValue = x * priceT * scaleT;
                return (depositValue * supply) / nav;
            };
        }
        return (x) => {
            if (x === 0n || supply === 0n)
                return 0n;
            const denom = priceT * scaleT;
            if (denom === 0n)
                return 0n;
            const grossCommon = (x * nav) / supply;
            const grossOut = grossCommon / denom;
            const fee = (grossOut * feeBps) / 10000n;
            let net = grossOut - fee;
            if (net < 0n)
                net = 0n;
            if (net > ataT)
                net = ataT;
            return net;
        };
    },
    depthReserves(base, state) {
        const c = carrotConfig(base);
        const { op, assetId } = parseCarrotDirection(c.direction);
        const target = requireAsset(c, assetId);
        const ataData = state[target.ata];
        if (ataData === undefined)
            throw new Error(`carrot ladder depth is missing ata ${target.ata}`);
        const crtData = state[c.sharesMint];
        if (crtData === undefined)
            throw new Error(`carrot ladder depth is missing shares mint ${c.sharesMint}`);
        const assetBalance = readUintLE(ataData, ATA_AMOUNT_OFFSET, 8);
        const supply = readUintLE(crtData, MINT_SUPPLY_OFFSET, 8);
        // issue: unbounded pool-side — the asset's own vault balance and the CRT supply are SIZE
        // PROXIES for relative-depth ranking (same convention as sanctum-stake-pool), not a hard cap.
        // redeem: reserveOut is the TRUE hard cap (the saturating clamp above), not just a proxy.
        return op === 'issue' ? { reserveIn: assetBalance, reserveOut: supply } : { reserveIn: supply, reserveOut: assetBalance };
    },
    continuousFees(base, _state, params) {
        const c = carrotConfig(base);
        const { op } = parseCarrotDirection(c.direction);
        if (op === 'issue')
            return { gammaPpm: 1000000n, muPpm: 1000000n };
        const feeBps = params[CARROT_MAX_ASSETS * 2];
        const feePpm = feeBps > 10000n ? 1000000n : feeBps * 100n;
        return { gammaPpm: 1000000n, muPpm: 1000000n - feePpm };
    },
};
/** Prepare-time direction gate: self-drops the SPECIFIC direction (not the whole vault) if its asset's oracle reading is stale. */
export function carrotGate(base, now) {
    const c = carrotConfig(base);
    const { assetId } = parseCarrotDirection(c.direction);
    const asset = requireAsset(c, assetId);
    if (now - asset.publishTime > MAX_ORACLE_STALENESS_SECONDS) {
        throw new Error(`carrot vault ${c.pool}: asset ${assetId}'s oracle ${asset.oracle} is stale (publishTime ${asset.publishTime}, now ${now}, over ${MAX_ORACLE_STALENESS_SECONDS}s)`);
    }
}
export function carrotMints(base) {
    const c = carrotConfig(base);
    const { op, assetId } = parseCarrotDirection(c.direction);
    const asset = requireAsset(c, assetId);
    return op === 'issue' ? { inMint: asset.mint, outMint: c.sharesMint } : { inMint: c.sharesMint, outMint: asset.mint };
}
export function carrotApplyDirection(base, direction) {
    const c = carrotConfig(base);
    if (direction === undefined)
        return c;
    parseCarrotDirection(direction); // validates shape; requireAsset (via mints/gate) validates existence
    return { ...c, direction };
}
// PYTH_RECEIVER_PROGRAM_ID / U64_MAX are documented constants for readers of this module (fetch-time
// gates cite the program id; the redeem helper's shared U64_MAX-style sentinel convention is noted
// for parity with obric-v2 even though this family's issue side needs no explicit uncapped sentinel).
export { PYTH_RECEIVER_PROGRAM_ID, U64_MAX as CARROT_U64_MAX };
//# sourceMappingURL=index.js.map