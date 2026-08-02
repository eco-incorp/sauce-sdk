/**
 * HumidiFi (EcoSwapSVM ladder fragment) — a top-10 chain-wide venue
 * (201.9M/7d, 40.3M/24h per the benchmark's Jupiter-label capture) with NO
 * on-chain IDL. This module is a from-scratch binary reverse-engineering,
 * not a port of any published adapter — the SDK ships no `humidifi` ladder.
 *
 * ── What was recovered (all evidence below is re-derivable — see
 *    `docs/humidifi-evidence.md` for the exact signatures/RPC calls) ──
 *
 * 1. TWO on-chain programs: a route/setup program (`AubCGUt9FfbuzrpFWcFgS4U6
 *    FTYRAfuzxrdtttN5TGP`) and the swap-settlement program this module
 *    targets (`9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp`).
 * 2. The 25-byte swap instruction's XOR obfuscation scheme: a 1:1 port of
 *    the public "HumidiFi Swap Parser" gist
 *    (gist.github.com/fengtality/fbfa28597be122ed74d4f25046b3e5a5, MIT-style
 *    utility script, independently verified against live mainnet
 *    transactions in this PR): 8-byte key `HUMIDIFI_XOR_KEY`, XORed in
 *    8-byte chunks with a per-chunk position mask (`pos·0x0001_0001_0001_
 *    0001`, `pos` = the 0-based chunk index). Layout: bytes 0-7 = an
 *    unstructured "header" that changes on EVERY observed transaction (see
 *    #4), bytes 8-15 = amountIn (u64 LE), byte 16 = a direction flag, bytes
 *    17-24 = mostly-zero trailer.
 * 3. The account order for the swap CPI (verified against >20 real
 *    transactions across 4 distinct pools): [user transfer authority
 *    (signer), pool state, base-token vault, quote-token vault, <2
 *    per-transaction accounts, see #4>, SysvarClock, token program (x2),
 *    ...variable trailing accounts]. The pool's own vaults are STANDARD SPL
 *    Token accounts (decoded the ordinary way — `amount` at offset 64) —
 *    confirmed via `preTokenBalances`/`postTokenBalances` on every sampled
 *    transaction.
 * 4. TWO STRUCTURAL BLOCKERS to fully autonomous instruction construction,
 *    both confirmed by direct evidence, not inferred from "thin docs":
 *      a. The 8-byte "header" (bytes 0-7) is DIFFERENT on every single
 *         sampled transaction, including repeated trades on the identical
 *         pool seconds apart with different amounts. It is not a
 *         discriminator (constant) or a simple function of amountIn/
 *         direction/pool/user we could reproduce.
 *      b. Two of the instruction's accounts (index 4 and 5 of the swap ix)
 *         are DIFFERENT on every single sampled transaction, even for
 *         repeated trades on the identical pool by different callers.
 *    Both point to the same mechanism: HumidiFi settles a per-trade,
 *      off-chain-negotiated commitment (consistent with its integration with
 *      DFlow's order-flow auction — the router in every sampled route is
 *      DFlow's `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH`, and the
 *      program logs a `dflow_score` event on every swap). An on-chain
 *      SauceScript program cannot participate in that off-chain negotiation,
 *      so `buildSwapV2` below cannot fill in a header/pair of accounts that
 *      the deployed program will accept for a NEW trade it never
 *      pre-negotiated. This is the documented, evidenced basis for the
 *      `humidifi` family's prepare-time gate in `ecoswap/svm/index.ts`
 *      (`FAMILIES.humidifi.gate`) — not a permission/whitelist gate, and not
 *      env-flagged; see that file for exactly what is gated and why lifting
 *      it needs an off-chain RFQ-participation slice, not a code tweak here.
 * 5. The pool's OWN account (e.g. `3QYYvFWgSuGK8bbxMSAYkCqE8QfSuFtByagnZAuek
 *    ia2`, 1728 bytes, owner = the swap program) does not expose the pair's
 *    mints/vaults in plaintext at any offset/width/scale we scanned
 *    (verified by brute-force byte-window scanning cross-checked against
 *    TWO pools' independently-known real values — zero matches beyond one
 *    coincidental hit disproved by a 3rd pool). Discovery therefore cannot
 *    use `getProgramAccounts` + memcmp like every other family (see
 *    `SVM_FAMILY_FILTERS`'s `Partial<>` widening in discovery.ts) — pools
 *    are served from `HUMIDIFI_POOL_REGISTRY` below, a small hand-verified
 *    seed (curated the same way the EcoSwapSVM route lane already curates
 *    hub mints instead of running an unbounded search).
 * 6. The realized price is NOT a function of the vault reserve ratio.
 *    Constant-product-over-reserves diverges from 21 real trades (2 pools,
 *    both directions, sizes from 0.01 to 10.57 SOL-equivalent) by 12.9%-57.8%, and the SIGN
 *    of the divergence flips within minutes on the SAME pool (proof: two
 *    snapshots of pool `3QYY...` four minutes apart show naive
 *    constant-product first UNDER- then OVER-estimating real output) — this
 *    venue quotes at a price set by an external process (again consistent
 *    with an RFQ), not by its own vault ratio. See `HUMIDIFI_SAFETY_FEE_PPM`
 *    below for how the quote curve stays conservative despite this.
 *
 * ── Pricing model (deliberately NOT venue-exact — see #6) ──
 *
 * The quote curve is textbook constant-product over the two vaults' LIVE
 * balances, with a 70% "safety haircut" applied to the input before the
 * curve (`HUMIDIFI_SAFETY_FEE_PPM` = 300,000 of 1,000,000, i.e. only 30% of
 * the input counts) — NOT a claim about HumidiFi's real fee, a conservative
 * bound sized so the merge never over-promises this venue's output (a
 * favourable error would win elections it cannot back up — see CLAUDE.md's
 * dust-K1 note). A 50% haircut (the first value tried) is NOT enough: it
 * stays safe across the 21-trade SOL/USDC-wormhole sample but OVER-promises
 * the second, memecoin/USDC pool by 18.6% on its one sampled trade — the
 * reserve-ratio-vs-real-price gap is pair-dependent, not just
 * time-dependent (see #6), so the constant had to be re-derived against
 * BOTH pools together, not just the one with more samples. At 70% haircut
 * the model stays BELOW the real realized output on all 22 gathered real
 * trades across both pools, worst-case margin 28.8% (the memecoin pool's
 * one sample) — see `docs/humidifi-evidence.md` for the full table and the
 * 50%-haircut counter-example. The curve is monotone and concave in the
 * input (a haircut constant-product IS a constant-product, just steeper),
 * so it cannot trigger the "coarse ladder gets allocated ZERO" failure mode.
 *
 * ── CU (`ecoswap/svm/budget.ts`'s `CU_FAMILIES.humidifi`) ──
 *
 * MEASURED, not modeled: two real mainnet CPI costs were read directly off
 * transaction logs — "Program 9H6tua7...consumed 40326 of ... compute
 * units" (tx `bCw8o8Aymp7T6kiGb3ac11DQo9ssx4TTKiBiM7TYSNfJw9wpCLNuCMhfZiCh9M
 * PHpNbV5JRQPrT5fairRt81xVk`) and "...consumed 31586..." (tx `dWC5fQYJog1i2
 * XbKDsZvXMK6wFLin8WDFdjdobRUFBafX4AzNzT1h7heP7Pwo9Zo4mZZBsGjC3dwdWAry8fv3Q5
 * `). The pin adds a margin-padded 45,000 (the higher measurement + ~12%)
 * on top of a same-complexity-family analog baseline (raydium-cp-swap's
 * 183,187 — two vault reads + one constant-product formula + merge share,
 * structurally identical to this family's fragment) instead of reusing a
 * placeholder, per the standing "existing pins omit the venue CPI" gap.
 */
import { address } from '@solana/kit';
const SLUG = 'humidifi';
/** The swap-settlement program (NOT the `AubCGUt9...` route/setup program). */
export const HUMIDIFI_PROGRAM_ID = address('9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp');
const SYSVAR_CLOCK = address('SysvarC1ock11111111111111111111111111111111');
// ── obfuscation scheme (verified against >20 live mainnet transactions) ──
/** The 8-byte XOR key, per the public "HumidiFi Swap Parser" gist (see file header, item 2). */
export const HUMIDIFI_XOR_KEY = [58, 255, 47, 255, 226, 186, 235, 195];
/** The 8-byte keystream for 8-byte chunk `pos` (0-based): `HUMIDIFI_XOR_KEY[j] ^ ((pos·0x0001_0001_0001_0001) bytes)[j]`. */
export function humidifiKeystream(pos) {
    const out = new Uint8Array(8);
    const lo = pos & 0xff;
    const hi = (pos >> 8) & 0xff;
    for (let j = 0; j < 8; j += 2) {
        out[j] = HUMIDIFI_XOR_KEY[j] ^ lo;
        out[j + 1] = HUMIDIFI_XOR_KEY[j + 1] ^ hi;
    }
    return out;
}
/** chunk 0 (bytes 0-7, the "header") keystream — our own instructions carry a zero-plaintext header. */
const HEADER_KEYSTREAM = humidifiKeystream(0);
/** chunk 1 (bytes 8-15, amountIn) keystream, as a little-endian u64 — XORing a runtime LE value
 *  with this constant is byte-for-byte equivalent to XORing the two 8-byte arrays (see file header
 *  item 2 and `buildSwapV2` below), so this is exactly what `patchXorMaskIn` needs to be. */
export const HUMIDIFI_AMOUNT_XOR_MASK = (() => {
    const k = humidifiKeystream(1);
    let v = 0n;
    for (let i = 7; i >= 0; i--)
        v = (v << 8n) | BigInt(k[i]);
    return v;
})();
/** chunk 2 (bytes 16-23: direction flag + 7 zero-plaintext trailer bytes) keystream. */
const CHUNK2_KEYSTREAM = humidifiKeystream(2);
/** chunk 3 (byte 24 only) keystream. */
const CHUNK3_KEYSTREAM = humidifiKeystream(3);
/** Deobfuscate a captured 25-byte HumidiFi swap instruction (test/verification use). */
export function humidifiDeobfuscate(data) {
    const out = new Uint8Array(data.length);
    let pos = 0;
    for (let i = 0; i < data.length; i += 8) {
        const chunkLen = Math.min(8, data.length - i);
        const ks = humidifiKeystream(pos);
        for (let j = 0; j < chunkLen; j++)
            out[i + j] = data[i + j] ^ ks[j];
        pos++;
    }
    return out;
}
/**
 * Hand-verified HumidiFi pools: for each, a real mainnet swap transaction was
 * decoded (obfuscation removed, account order matched) and the vault/mint
 * addresses were cross-checked against `preTokenBalances`/`postTokenBalances`
 * on that transaction. Ranked by observed activity in the sampled window;
 * extend by repeating the same verification (see docs/humidifi-evidence.md).
 */
export const HUMIDIFI_POOL_REGISTRY = {
    // SOL / USDC (native, EPjF...) — the top pair by sampled tx frequency.
    '8sKQHfjNhvmAw94PhfvfMcytmqW6jmxvwieYyzXCCPu': {
        baseVault: address('H292B1VbSvD6GuUmSvUvfQstg1Acfzog796uQ7d1ccCw'),
        quoteVault: address('A3C9xwv4Hfx92M5HQpxUiibSqCa5pYhD2kTwnU5fEPq'),
        baseMint: address('So11111111111111111111111111111111111111112'),
        quoteMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        baseDecimals: 9,
        quoteDecimals: 6,
    },
    // SOL / USDC (Wormhole, Es9v...) — heavily sampled (21 real trades, see file header item 6).
    '3QYYvFWgSuGK8bbxMSAYkCqE8QfSuFtByagnZAuekia2': {
        baseVault: address('AzzKL5BpnX9UXfJRyiGbAwyFvw93vwCTBvW56tJebsqd'),
        quoteVault: address('EmyNiSYtMYZsBCVYpzLwNduQFqCpDGR8qM1h2CoLpWnM'),
        baseMint: address('So11111111111111111111111111111111111111112'),
        quoteMint: address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
        baseDecimals: 9,
        quoteDecimals: 6,
    },
    // A memecoin / USDC pair, sampled to confirm the pricing model generalizes off SOL pairs.
    'H3TyE2Q3rDrvRXD8PzHYE7BS2hafGuybje4qXCtyWqMH': {
        baseVault: address('49pft8q7cyugVDWnJCXjMHJdb5Uji198k5MognVvA48n'),
        quoteVault: address('EKFwmKoPA9o3HpoL8AnQd8uNBxtJbaPv4w4tbxNn6iei'),
        baseMint: address('98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g'),
        quoteMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        baseDecimals: 9,
        quoteDecimals: 6,
    },
    'ELp3rjbAncW8FLAPvmWS6vjG4FXFLDo1HiKh4PhQBgvx': {
        baseVault: address('4uGxv6uabyEmHzhi7LBWGzqSwGEE98VzYL2NahRqbfCP'),
        quoteVault: address('2XCEJJf3hnuMeot5dJST9yaj92i1wCLB2c67eH7WYzvR'),
        baseMint: address('Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk'),
        quoteMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        baseDecimals: 6,
        quoteDecimals: 6,
    },
};
function humidifiConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
/**
 * Registry lookup + liveness check ONLY — this family's pool account carries
 * no plaintext structure we can decode (file header item 5), so there is
 * nothing further to read off it. `load(pool)` still runs once so a pool
 * whose account has since closed/reallocated (a stale registry entry) is
 * dropped like any other vanished pool, never silently misquoted.
 */
export async function fetchHumidifiConfig(load, pool) {
    const entry = HUMIDIFI_POOL_REGISTRY[pool];
    if (entry === undefined) {
        throw new Error(`${SLUG}: pool ${pool} is not in HUMIDIFI_POOL_REGISTRY — this venue's pool state has no ` +
            'decodable plaintext layout (verified by exhaustive offset scan), so unregistered pools ' +
            'cannot be resolved at all; see ecoswap/svm/venues/humidifi.ts for how to add one');
    }
    const raw = await load(pool);
    if (raw === null)
        throw new Error(`${SLUG}: pool ${pool} account not found (registry entry stale?)`);
    return { venue: SLUG, pool, direction: 'baseToQuote', ...entry };
}
const VAULT_AMOUNT_OFFSET = 64;
const ref = (slot, role) => `s${slot}:${role}`;
/**
 * Safety haircut on the INPUT before a plain constant-product curve — NOT a
 * claim about HumidiFi's real fee (unknown, see file header item 6). Only
 * 300,000 (of 1,000,000) = 30% of the input counts (a 70% haircut). Chosen
 * so the model stays below every one of 22 real sampled trades' realized
 * output ACROSS TWO DIFFERENT POOLS (worst-case margin 28.8%, on the
 * memecoin/USDC pool) — a 50% haircut passes the 21-trade SOL/USDC sample
 * but over-promises the second pool by 18.6%, so this constant is
 * calibrated against the worst pool sampled, not the best-sampled one.
 */
export const HUMIDIFI_SAFETY_FEE_PPM = 300000n;
const FEE_PPM_DENOM = 1000000n;
export const humidifiLadder = {
    slug: SLUG,
    defaultRungs: 4,
    shapeKey(base) {
        const cfg = humidifiConfig(base);
        return `${SLUG}:${cfg.direction}`;
    },
    helpers() {
        return [
            {
                name: 'qHumidiFi',
                source: [
                    'function qHumidiFi(x, rin, rout) {',
                    '  if (x === 0) { return 0 }',
                    `  const net = Math.mulDiv(x, ${HUMIDIFI_SAFETY_FEE_PPM}, ${FEE_PPM_DENOM});`,
                    '  return Math.mulDiv(net, rout, rin + net);',
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
        const cfg = humidifiConfig(base);
        return [
            { ref: ref(slot, 'basevault'), address: cfg.baseVault },
            { ref: ref(slot, 'quotevault'), address: cfg.quoteVault },
        ];
    },
    emitSetup(base, slot) {
        const cfg = humidifiConfig(base);
        const [vinRef, voutRef] = cfg.direction === 'quoteToBase' ? [ref(slot, 'quotevault'), ref(slot, 'basevault')] : [ref(slot, 'basevault'), ref(slot, 'quotevault')];
        return [
            `  const s${slot}rin = accountUint(${JSON.stringify(vinRef)}, ${VAULT_AMOUNT_OFFSET}, 8);`,
            `  const s${slot}rout = accountUint(${JSON.stringify(voutRef)}, ${VAULT_AMOUNT_OFFSET}, 8);`,
        ].join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        return `qHumidiFi(${x}, s${slot}rin, s${slot}rout)`;
    },
    /**
     * Builds the swap CPI's KNOWN-CORRECT surface (program id, the two vaults,
     * token program, SysvarClock, and the amountIn XOR-patched via
     * `patchXorMaskIn` — see ecoswap/svm/codegen.ts) — but see file header item
     * 4: two accounts (a per-transaction pair this recipe cannot derive) and
     * the 8-byte header (a per-transaction commitment this recipe cannot
     * produce) have NO correct value here. Both are filled with a
     * zero-plaintext placeholder (still correctly XOR-obfuscated, so the
     * BYTES this emits match what a real all-zero-header trade would look
     * like) rather than garbage, but the deployed program is expected to
     * reject a not-pre-negotiated trade at this point — this is why
     * `FAMILIES.humidifi.gate` in ecoswap/svm/index.ts drops every candidate
     * before compile today. Kept real (not stubbed) so the encoding itself —
     * the part that IS fully solved — stays tested against the exact bytes
     * captured on mainnet.
     */
    buildSwapV2(base, slot, user) {
        const cfg = humidifiConfig(base);
        const directionFlag = cfg.direction === 'quoteToBase' ? 1 : 0;
        const suffixByte0 = directionFlag ^ CHUNK2_KEYSTREAM[0];
        const suffix = Uint8Array.from([
            suffixByte0,
            CHUNK2_KEYSTREAM[1],
            CHUNK2_KEYSTREAM[2],
            CHUNK2_KEYSTREAM[3],
            CHUNK2_KEYSTREAM[4],
            CHUNK2_KEYSTREAM[5],
            CHUNK2_KEYSTREAM[6],
            CHUNK2_KEYSTREAM[7],
            CHUNK3_KEYSTREAM[0],
        ]);
        return {
            programId: HUMIDIFI_PROGRAM_ID,
            prefix: HEADER_KEYSTREAM.slice(),
            suffix,
            patch: 'in',
            accounts: [
                { ref: user.owner, signer: true },
                { ref: ref(slot, 'pool'), address: cfg.pool },
                { ref: ref(slot, 'basevault'), address: cfg.baseVault, writable: true },
                { ref: ref(slot, 'quotevault'), address: cfg.quoteVault, writable: true },
                // Per-transaction accounts this recipe cannot derive (file header item 4b) —
                // placeholders so the account LIST SHAPE matches; never reachable (the family gate).
                { ref: ref(slot, 'pool'), address: cfg.pool },
                { ref: ref(slot, 'pool'), address: cfg.pool },
                { ref: ref(slot, 'clock'), address: SYSVAR_CLOCK },
                cfg.direction === 'quoteToBase'
                    ? { ref: user.inAta, writable: true }
                    : { ref: user.outAta, writable: true },
                cfg.direction === 'quoteToBase'
                    ? { ref: user.outAta, writable: true }
                    : { ref: user.inAta, writable: true },
            ],
        };
    },
    referenceQuote(base, state) {
        const cfg = humidifiConfig(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
            return data;
        };
        const readAmount = (data) => {
            let v = 0n;
            for (let i = 7; i >= 0; i--)
                v = (v << 8n) | BigInt(data[VAULT_AMOUNT_OFFSET + i]);
            return v;
        };
        const [rinAddr, routAddr] = cfg.direction === 'quoteToBase' ? [cfg.quoteVault, cfg.baseVault] : [cfg.baseVault, cfg.quoteVault];
        const rin = readAmount(bytes(rinAddr));
        const rout = readAmount(bytes(routAddr));
        return (x) => {
            if (x === 0n)
                return 0n;
            const net = (x * HUMIDIFI_SAFETY_FEE_PPM) / FEE_PPM_DENOM;
            return (net * rout) / (rin + net);
        };
    },
    depthReserves(base, state) {
        const cfg = humidifiConfig(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
            return data;
        };
        const readAmount = (data) => {
            let v = 0n;
            for (let i = 7; i >= 0; i--)
                v = (v << 8n) | BigInt(data[VAULT_AMOUNT_OFFSET + i]);
            return v;
        };
        const rBase = readAmount(bytes(cfg.baseVault));
        const rQuote = readAmount(bytes(cfg.quoteVault));
        return cfg.direction === 'quoteToBase' ? { reserveIn: rQuote, reserveOut: rBase } : { reserveIn: rBase, reserveOut: rQuote };
    },
    continuousFees() {
        // Measurement-only oracle input (never a gate) — reuse the same conservative
        // haircut as the real curve; there is no separate protocol-fee figure to report.
        return { gammaPpm: HUMIDIFI_SAFETY_FEE_PPM, muPpm: FEE_PPM_DENOM };
    },
};
//# sourceMappingURL=index.js.map