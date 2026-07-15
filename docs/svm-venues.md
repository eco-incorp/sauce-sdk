# SVM venue facts

Normative reference for the seven venue adapters in `sdk/src/svm/venues/`. Every byte offset,
quote formula, rounding rule, gate and pinned constant that the adapters and their test suites
cite lives here. The adapters were written against the venues' published sources and deployed
mainnet binaries; this document is regenerated from that code and its fixtures and is the
companion the adapter doc comments point at.

## How quoting works

Solana has no view functions, so the solswap recipe quotes **inside the VM**: each venue's pool
state accounts are attached to the execute instruction **read-only**, and the adapter's
`emitQuote` fragment reads live fields with `accountUint(ref, offset, width)` — a little-endian
unsigned read, mirrored off-chain by `readUintLE` in `sdk/src/svm/venues/math.ts`. All seven
venues are pure little-endian; big-endian never occurs. Anything that is a compile-time constant
for a fixed `amountIn` (immutable fee rates, multipliers, direction branches) is folded off-chain
at generation time; anything trade- or admin-mutable (reserves, live fee rates, pause bytes) stays
a live in-VM read. The quote and the swap execute in the same instruction against the same account
state, so there is no staleness between them.

**Exactness criterion.** An adapter ships only when its in-VM quote equals the venue program's
realized output **bit-exact** over the supported pool class — same integer operations, same
floor/ceil sides, same guard order as the venue's own execution path. Pools whose output cannot be
reproduced from account reads alone (amount-dependent fee schedulers, slot-gated activation,
transfer-fee mints, unverified fee routing) are rejected at `fetchPoolConfig` time with a named
gate error; a gated pool never reaches the generator. Each venue's triangle —
`emitQuote` on the real engine == `referenceQuote` in TS == the pinned worked example below — is
asserted in `sdk/test/svm/venue-triangle.e2e.test.ts`, and `referenceQuote` is deliberately
derived from this document's formulas, never from the emitted SauceScript, so a shared bug cannot
self-verify.

**Fixture provenance.** All pinned worked examples run over real mainnet account dumps
(2026-07-03/04 snapshots unless a venue section says otherwise), stored one account per JSON file
under `sdk/test/svm/fixtures/<slug>/` as `{ address, owner, base64Data }`.

## Exclusions

- **CLMM venues** (Orca Whirlpools, Raydium CLMM, Meteora DLMM): quoting requires a tick-array
  walk across a data-dependent set of accounts — it does not fit the one-adapter-one-pool,
  fixed-account-plan shape. No adapter.
- **Proprietary AMMs** (SolFi, Obric v2, ZeroFi, HumidiFi, ...): over 92% of aggregator flow, but
  closed-source — no published math, often no published layouts, nothing for an in-VM quote to
  read. Covered exclusively through the external-quote path (`quoteViaSimulation` + the recipe's
  post-swap delta check).
- **Lifinity** (v2): prices from a live oracle with proactive inventory shifts, so a baked in-VM
  quote is stale by construction; the protocol wound down its DEX liquidity in 2025-12. No
  adapter.
- **Sanctum Infinity**: open math and grounded — the research is adapter-ready — but LST pricing
  runs through per-LST pricing programs plus the stake-pool rate, a multi-program account graph
  that the one-pool adapter shape does not carry yet. Planned follow-up; until then route Sanctum
  through the external-quote path.

---

## raydium-cp-swap

Constant-product CPMM (non-OpenBook). Program `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`;
source-verified against `raydium-io/raydium-cp-swap` commit `78f254e`. Vault/LP-mint authority is
the constant PDA `["vault_and_lp_mint_auth_seed"]` = `GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL`.

### PoolState account (637 bytes, Anchor)

Discriminator `sha256("account:PoolState")[0..8]` = `f7 ed e3 f5 d7 c3 de 46`. Offsets are byte
sums over the declared field order (`repr(C, packed)`).

| field | offset | encoding |
| --- | --- | --- |
| amm_config | 8 | pubkey (32B) |
| token_0_vault | 72 | pubkey |
| token_1_vault | 104 | pubkey |
| token_0_mint | 168 | pubkey |
| token_1_mint | 200 | pubkey |
| token_0_program | 232 | pubkey |
| token_1_program | 264 | pubkey |
| observation_key | 296 | pubkey |
| status | 329 | u8 bitfield (bit 2 = swap disabled) |
| protocol_fees_token_0 | 341 | u64 LE |
| protocol_fees_token_1 | 349 | u64 LE |
| fund_fees_token_0 | 357 | u64 LE |
| fund_fees_token_1 | 365 | u64 LE |
| open_time | 373 | u64 LE (unix seconds) |
| creator_fee_on | 389 | u8 (0 = BothToken, 1 = OnlyToken0, 2 = OnlyToken1) |
| enable_creator_fee | 390 | u8 bool |
| creator_fees_token_0 | 397 | u64 LE |
| creator_fees_token_1 | 405 | u64 LE |

AmmConfig account (236 bytes, discriminator `da f4 21 68 cb cb 2b 6f`): `trade_fee_rate` u64 LE
@12, `creator_fee_rate` u64 LE @108 — both parts-per-1e6. Vaults are SPL token accounts (classic
or Token-2022): mint @0, amount u64 LE @64.

### Quote (exactIn, both directions)

```
reserve_side = vault.amount − protocol_fees_side − fund_fees_side − creator_fees_side
```

Fee rates are admin-mutable (`update_amm_config`), so the fragment reads them live from AmmConfig;
`creator_fee_on` / `enable_creator_fee` are pool-creation-time constants and the fee-side branch is
resolved at generation time. `enable_creator_fee == 0` zeroes the effective creator rate. With
`ceil(x) = (x + 999999) / 1e6`:

- creator fee on the **input** side (`creator_fee_on` 0, or 1 with token_0 in, or 2 with token_1
  in): `fee = ceil(amountIn * (trade_rate + creator_rate))`, `net = amountIn − fee`,
  `out = floor(net * reserveOut / (reserveIn + net))`.
- creator fee on the **output** side: `fee = ceil(amountIn * trade_rate)`, `net = amountIn − fee`,
  `outSwapped = floor(net * reserveOut / (reserveIn + net))`,
  `out = outSwapped − ceil(outSwapped * creator_rate)`.

Pools created before the creator-fee upgrade carry zeroed creator fields, so the unified formula is
safe everywhere. Overflow bound: every product is (u64) × (u64 or 1e6 rate) < 2^128, matching the
program's own u128 curve math.

Gates (fetch time): PoolState/AmmConfig size + discriminator, status bit 2, `now < open_time`,
each vault exists and holds the declared mint, and a Token-2022 mint with a TransferFeeConfig
extension (TLV type 1) on either side is rejected — a transfer-fee mint changes wire amounts on
that leg.

### Swap instruction: `swap_base_input`

Data (24 bytes): discriminator `sha256("global:swap_base_input")[0..8]` =
`[143, 190, 90, 218, 196, 30, 51, 222]`, then `amount_in` u64 LE, then `minimum_amount_out` u64 LE
(always 1 — the recipe's post-swap outAta delta check enforces the real bound).

| # | account | flags |
| --- | --- | --- |
| 0 | payer (user owner) | signer |
| 1 | authority PDA `GpMZ…xFbL` | |
| 2 | amm_config | |
| 3 | pool_state | writable |
| 4 | user input token account | writable |
| 5 | user output token account | writable |
| 6 | input vault | writable |
| 7 | output vault | writable |
| 8 | input token program | |
| 9 | output token program | |
| 10 | input token mint | |
| 11 | output token mint | |
| 12 | observation_state | writable |

### Pinned worked example

Mainnet WSOL/USDC pool `7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny`, snapshot 2026-07-04
(`sdk/test/svm/fixtures/raydium-cp-swap/`): vault_0 amount 1_927_052_254, vault_1 amount
146_870_650; protocol fees 69_220_427 / 869_850, fund fees 86_140_625 / 1_264_457, creator fees
0 / 0; `trade_fee_rate` 2500, `creator_fee_rate` 500 (creator fee disabled); open_time
1_715_746_443.

- reserves: 1_771_691_202 WSOL-side, 144_736_343 USDC-side.
- 1_000_000 WSOL lamports in: fee ceil(1e6 · 2500 / 1e6) = 2500, out = **81_443** USDC raw.
- reverse (token_1 in): 1_000_000 USDC in → **12_126_640** lamports.

### Caveats

- Quote-account refs are the base58 addresses themselves: unique across pools and venues, and
  shared reads (two pools on one AmmConfig) dedupe in the plan.
- `fetchPoolConfig` snapshots the fee rates for reference math, but the emitted quote re-reads
  them live.

---

## raydium-amm-v4

Legacy hybrid AMM, constant-product quoting for its non-orderbook statuses. Program
`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`; source-verified against
`raydium-io/raydium-amm` (`state.rs`, `math.rs`, `processor.rs`) and the deployed mainnet binary.

### AmmInfo account (752 bytes)

`#[repr(C, packed)]`, **no discriminator** — all offsets absolute from byte 0, all integers
little-endian.

| field | offset | encoding |
| --- | --- | --- |
| status | 0 | u64 LE (AmmStatus) |
| coin_decimals | 32 | u64 LE |
| pc_decimals | 40 | u64 LE |
| fees.swap_fee_numerator | 176 | u64 LE (default 25) |
| fees.swap_fee_denominator | 184 | u64 LE (default 10000) |
| state_data.need_take_pnl_coin | 192 | u64 LE |
| state_data.need_take_pnl_pc | 200 | u64 LE |
| state_data.pool_open_time | 224 | u64 LE (unix seconds) |
| coin_vault | 336 | pubkey |
| pc_vault | 368 | pubkey |
| coin_mint | 400 | pubkey |
| pc_mint | 432 | pubkey |

Vaults are 165-byte SPL token accounts: mint @0, amount u64 LE @64.

### Quote (exactIn, direction = `inputIsCoin`)

Scope gate: ONLY status 6 (SwapOnly) and 7 (WaitingTrade) are quotable. For those the program uses
`calc_total_without_take_pnl_no_orderbook` (math.rs:322):

```
reserve_side = vault.amount − need_take_pnl_side
```

— bit-exact from three accounts, no Serum open-orders term. Status 1/5 (orderbook enabled) fold in
open-orders totals plus an event-queue walk and are rejected; status 2/3/4 have no swap
permission. Status-7 pools additionally reject swaps while `now < pool_open_time` — gated at
fetch (wall clock) and re-checked in `referenceQuote` against the live state snapshot.

Fee is **ceil-charged on the input** (`checked_ceil_div`, processor.rs:2396-2400):

```
inAfterFee = amountIn − ceil(amountIn · swap_fee_numerator / swap_fee_denominator)
out        = floor(reserveOut · inAfterFee / (reserveIn + inAfterFee))    (math.rs:373)
```

The fee side is all compile-time constants, so it folds off-chain; the fragment reads only the two
vault amounts and the two `need_take_pnl` fields. All operands are u64, so
`reserveOut · inAfterFee < 2^128` — matching the program's U128 floor division exactly.

### Swap instruction: `swap_base_in_v2`

Data (17 bytes): tag byte `0x10`, `amount_in` u64 LE, `minimum_amount_out` u64 LE (always 1). No
Serum market accounts — the instruction enforces the same non-orderbook restriction on-chain. The
program infers direction from the user token account mints, so the account list is
direction-independent.

| # | account | flags |
| --- | --- | --- |
| 0 | SPL token program | |
| 1 | amm pool (AmmInfo) | writable |
| 2 | amm authority `5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1` | |
| 3 | amm coin vault | writable |
| 4 | amm pc vault | writable |
| 5 | user token source | writable |
| 6 | user token destination | writable |
| 7 | user source owner | signer |

The authority is `create_program_address([b"amm authority", [nonce]], programId)` — one PDA for
the whole program (`AUTHORITY_AMM`, processor.rs:111), pinned above.

### Pinned worked example

Mainnet SOL/USDC pool `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2`, snapshot 2026-07-04
(`sdk/test/svm/fixtures/raydium-amm-v4/`): status 6, fees 25/10000, coin vault amount
66_599_328_743_661, decimals 9/6.

- 1 SOL (1_000_000_000) in: fee 2_500_000, out = **81_386_311** (81.386311 USDC).
- 1 USDC (1_000_000) in: fee 2_500, out = **12_225_534** (0.012225534 SOL).

### Caveats

- `inputIsCoin` defaults true from `fetchPoolConfig`; flip a config copy for pc→coin — only the
  quote math flips, `buildSwap` is direction-independent.
- The status gate re-runs in `referenceQuote` against the live snapshot (a pool can be disabled
  after fetch).

---

## pumpswap

pump.fun AMM, constant product over **raw** SPL vault balances — nothing subtracted:
protocol/creator/buyback fees leave to their own ATAs at swap time and the LP fee stays in the
vault. Program `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`; fee program
`pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`. Layouts follow the official Anchor IDL, quote math
the official SDK, both verified byte-exact against recorded mainnet BuyEvent/SellEvent
simulations.

### Pool account

Discriminator `[241, 154, 109, 4, 17, 177, 109, 188]`. Core fields run through `lp_supply` at
203..211; observed sizes vary — pools shorter than 243 bytes predate `coin_creator`, which then
reads as `Pubkey::default`.

| field | offset | encoding |
| --- | --- | --- |
| creator | 11 | pubkey |
| base_mint | 43 | pubkey |
| quote_mint | 75 | pubkey |
| pool_base_token_account | 139 | pubkey |
| pool_quote_token_account | 171 | pubkey |
| lp_supply | 203 | u64 LE |
| coin_creator | 211 | pubkey (when length ≥ 243) |
| is_mayhem_mode | 243 | u8 bool (when present) |
| is_cashback_coin | 244 | u8 bool (when present) |

GlobalConfig `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw` (discriminator
`[149, 8, 156, 202, 160, 252, 176, 217]`): `disable_flags` u8 @56 (bit 3 disables buys, bit 4
sells), `protocol_fee_recipients[0]` pubkey @57, `buyback_fee_recipients[0]` pubkey @643.

FeeConfig `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` under the fee program (discriminator
`[143, 52, 146, 187, 219, 123, 76, 155]`): flat fees lp/protocol/creator u64 LE @41/@49/@57; fee
tier vec count u32 LE @65, then 40-byte borsh entries at 69 + i·40: `market_cap_threshold` u128 LE,
`lp_fee_bps` u64 LE, `protocol_fee_bps` u64 LE, `creator_fee_bps` u64 LE.

### Fee selection (at fetch time)

A pool is **canonical** iff `pool.creator == pda(['pool-authority', base_mint])` under the pump
bonding program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. Canonical pools pay the market-cap
tier: `mc = quote_reserve · base_mint_supply / base_reserve` (mint supply u64 LE @36 of the base
mint); below `tiers[0].threshold` pick `tiers[0]`, otherwise the highest tier whose threshold `mc`
clears. Non-canonical pools pay `flat_fees`. `creator_fee_bps` is zeroed when `coin_creator` is
`Pubkey::default`. Fees are re-read on every `fetchPoolConfig` (admin-mutable) and the selected
tier is **baked** into the emitted quote — staleness across a tier boundary is covered by the
recipe's post-swap outAta delta check. Observed 2026-07 tiers (verified on-chain): tier 0 =
2/93/30 bps below a 420-SOL market cap, tier 1 = 20/5/95 bps up to the 1470-SOL threshold.

### Quote (exactIn, both directions), BPS = 10000

Buy (`quoteToBase`, instruction `buy_exact_quote_in`) — the fee arithmetic strips the fee share
off the spendable budget, ceil-rounding each component separately, then corrects any over-budget:

```
eff  = floor(spend · BPS / (BPS + lp + protocol + creator))
fees = ceil(eff·lp/BPS) + ceil(eff·protocol/BPS) + ceil(eff·creator/BPS)
eff -= max(0, eff + fees − spend);   require eff ≥ 2
out  = floor(base_reserve · (eff − 1) / (quote_reserve + (eff − 1)))
```

The `eff − 1` is the program's own on-chain adjustment. The `eff ≥ 2` guard covers an edge that is
unverified on-chain (see caveats). All fee terms are compile-time constants, so the fragment reads
exactly two accounts: base and quote vault amounts (u64 LE @64).

Sell (`baseToQuote`, instruction `sell`) — fees are per-component ceilDiv on the **output**:

```
quoteOut = floor(quote_reserve · baseIn / (base_reserve + baseIn))
out      = quoteOut − ceil(quoteOut·lp/BPS) − ceil(quoteOut·protocol/BPS) − ceil(quoteOut·creator/BPS)
```

Gates: pool/GlobalConfig/FeeConfig discriminators, pool length ≥ 211, `is_mayhem_mode` (mayhem fee
routing is unverified), `is_cashback_coin` (cashback swaps need user-derived remaining accounts),
buys disabled (`disable_flags` bit 3; bit 4 blocks `buildSwap` for sells), and a Token-2022 mint
carrying a TransferFeeConfig extension. Token program detection is by mint data alone: exactly 82
bytes = classic Tokenkeg (an extensionless Token-2022 mint is indistinguishable, and every pump
Token-2022 mint carries extensions), longer = Token-2022 TLV.

### Swap instructions

Buy `buy_exact_quote_in` (25 bytes): discriminator `[198, 46, 21, 82, 180, 217, 232, 112]`,
`spendable_quote_in` u64 LE, `min_base_amount_out` u64 LE (1), `track_volume` OptionBool `0x00`.
Sell (24 bytes): discriminator `[51, 230, 133, 164, 1, 127, 131, 173]`, `base_amount_in` u64 LE,
`min_quote_amount_out` u64 LE (1).

Ordered accounts (buy; sell drops the two volume accumulators):

| # | account | flags |
| --- | --- | --- |
| 0 | pool | writable |
| 1 | user | writable, signer |
| 2 | global config | |
| 3 | base mint | |
| 4 | quote mint | |
| 5 | user base token account | writable |
| 6 | user quote token account | writable |
| 7 | pool base vault | writable |
| 8 | pool quote vault | writable |
| 9 | protocol fee recipient | |
| 10 | protocol fee recipient quote ATA | writable |
| 11 | base token program | |
| 12 | quote token program | |
| 13 | system program | |
| 14 | associated token program | |
| 15 | event authority `GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR` | |
| 16 | amm program | |
| 17 | coin creator vault ATA | writable |
| 18 | coin creator vault authority | |
| 19 | global volume accumulator `C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw` | buy only |
| 20 | user volume accumulator | writable, buy only, caller-resolved |
| 21 | fee config | |
| 22 | fee program | |

Remaining accounts, in order: the `['pool-v2', base_mint]` PDA when `coin_creator` is set, then
**always** the buyback fee recipient + its quote ATA (writable) — omitting the pair fails with
error 6058. The user volume accumulator is `['user_volume_accumulator', user]` under the amm
program — a PDA over the user's own wallet, so the adapter attaches it as the caller-resolved ref
`pumpswap-user-volume-accumulator`. Coin creator vault authority is
`['creator_vault', coin_creator]` under the amm program.

### Pinned worked examples

Mainnet-simulation-verified vectors (PUMP/USDC pool
`2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd`, non-canonical, flat fees 25/5/0 bps):

- buy: reserves base 4_154_251_682_177_570 / quote 6_515_063_678_232, spend 1_000_000_000 →
  **635_633_459_193** (matches the recorded BuyEvent).
- sell: reserves base 4_153_516_048_718_377 / quote 6_516_220_452_584, baseIn 50_000_000_000 →
  **78_205_951** (matches the recorded SellEvent).

Untouched fixture snapshot (`sdk/test/svm/fixtures/pumpswap/`, vaults 4_144_782_727_340_999 /
6_530_283_775_547, dumped 2026-07-03/04; quotes recomputed from the formulas above outside the
package): buy 1e9 → **632_706_768_908**; sell 50e9 → **78_539_874**. The canonical fixture pool
`GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J` pins the tier selection (market cap ~220 SOL →
tier 0, fees 2/93/30).

### Caveats

- The fee tier is a fetch-time snapshot; the emitted quote does not re-read FeeConfig.
- The `eff < 2` throw guards an on-chain edge that was never observed in simulation — kept
  conservative rather than risking a divergent tiny-input quote.
- `referenceQuote` is written from the formulas above and deliberately does not share the
  `emitQuote` fee fold, keeping the two independently derived.

---

## orca-legacy-token-swap

Orca's v2 fork of the SPL token-swap program (layout/math per `spl-token-swap`
token-swap-v2.1.0). Program `9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP`; the v1 deployment
(`DjVE6…`) is deprecated and out of scope. Constant-product (`curve_type == 0`) pools only —
Orca's fork also ran stable pools (nonzero curve_type, amp in the calculator blob), which are
gated.

### SwapV1 pool account (324 bytes)

`SwapVersion::pack`: version byte at 0, then the 323-byte SwapV1 body — manual Pack, no
discriminator, no padding.

| field | offset | encoding |
| --- | --- | --- |
| version | 0 | u8 (= 1) |
| is_initialized | 1 | u8 bool |
| bump_seed | 2 | u8 |
| token_program_id | 3 | pubkey |
| token_a (vault) | 35 | pubkey |
| token_b (vault) | 67 | pubkey |
| pool_mint | 99 | pubkey |
| token_a_mint | 131 | pubkey |
| token_b_mint | 163 | pubkey |
| pool_fee_account | 195 | pubkey |
| trade_fee_numerator | 227 | u64 LE |
| trade_fee_denominator | 235 | u64 LE |
| owner_trade_fee_numerator | 243 | u64 LE |
| owner_trade_fee_denominator | 251 | u64 LE |
| curve_type | 291 | u8 (= 0, constant product) |

### Quote (exactIn, A → B)

Reserves ARE the raw vault balances — both fees stay in the vaults as tokens; the owner fee is
compensated by minting LP tokens to `pool_fee_account`. Fees are charged on the **input** with the
floor-min-1 rule (`fees.rs calculate_fee`): zero when the rate or the amount is zero, otherwise
`max(1, floor(x · n / d))`.

```
netIn = amountIn − tradeFee − ownerFee        (throws when ≤ 0)
out   = rsOut − ceil(rsIn · rsOut / (rsIn + netIn))
```

The curve ceiling rounds against the trader. On-chain `checked_ceil_div` maps a zero
floor-quotient to failure before ceiling, and a zero `out` also fails — `referenceQuote` mirrors
both. All arithmetic is u128 on-chain; reserves are u64, so `rsIn · rsOut ≤ 2^128` and nothing
approaches the engine's 256-bit wrap. Fee rates are immutable SwapV1 fields and are baked; the
fragment reads only the two vault amounts.

The swap authority is `create_program_address([pool, [bump_seed @2]], program)` with the
**stored** bump — the pool may have been initialized with a non-canonical nonce, so find-style
derivation is wrong. No on-curve rejection: the pool exists on-chain with this bump.

### Swap instruction: `SwapInstruction::Swap`

Data (17 bytes): tag `0x01`, `amount_in` u64 LE, `minimum_amount_out` u64 LE (1). Accounts
(instruction.rs list 0–9; the optional host fee account 10 is omitted):

| # | account | flags |
| --- | --- | --- |
| 0 | swap (pool state) | |
| 1 | swap authority | |
| 2 | user transfer authority | signer |
| 3 | user source token account | writable |
| 4 | pool source vault | writable |
| 5 | pool destination vault | writable |
| 6 | user destination token account | writable |
| 7 | pool mint | writable |
| 8 | pool fee account | writable |
| 9 | token program | |

### Pinned worked example

Mainnet SOL/USDC pool `EGZ7tiLeH62TPV1gL8WwbXGzEPa9zmcpVnnkPKKnrE2U`
(`sdk/test/svm/fixtures/orca-legacy-token-swap/`, dumped 2026-07-03/04): reserves
16_016_066_895_173 / 1_306_595_296_770; fees 25/10000 trade + 5/10000 owner; bump_seed 252 →
authority `JU8kmKzDHF9sXWsnoznaFDFezLsE5uomX2JkRMbmsQP` (derivation verified:
`sha256(pool || 0xFC || program || 'ProgramDerivedAddress')`).

- 1 SOL in: tradeFee 2_500_000, ownerFee 500_000, netIn 997_000_000 → **81_330_481** USDC raw.
- 10 SOL in → **812_849_439**.
- dust 1000 in: tradeFee 2, ownerFee floors to 0 → min 1, netIn 997 → **81**.

### Caveats

- Quote direction is token A → token B (matching the pinned example); the reverse direction needs
  the roles swapped by the caller.
- The emitted ceiling is spelled `(rIn·rOut + rIn + netIn − 1) / (rIn + netIn)`.

---

## meteora-damm-v2

cp-amm, sqrt-price quoting from the Pool account **only**. Program
`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`; source-verified against
`github.com/MeteoraAg/damm-v2`. Vault balances must never enter the quote: they overstate reserves
by unclaimed LP/protocol fees, and for concentrated pools the virtual reserves differ from real
reserves.

### Pool account (1112 bytes)

8-byte discriminator `sha256('account:Pool')[0..8]` = `f1 9a 6d 04 11 b1 6d bc` + 1104-byte
zero-copy struct.

| field | offset | encoding |
| --- | --- | --- |
| pool_fees.base_fee.cliff_fee_numerator | 8 | u64 LE |
| pool_fees.base_fee.base_fee_mode | 16 | u8 |
| pool_fees.base_fee.period_frequency | 24 | u64 LE |
| pool_fees.dynamic_fee.initialized | 56 | u8 bool |
| pool_fees.dynamic_fee.variable_fee_control | 68 | u32 LE |
| pool_fees.dynamic_fee.bin_step | 72 | u16 LE |
| pool_fees.dynamic_fee.volatility_accumulator | 120 | u128 LE |
| token_a_mint | 168 | pubkey |
| token_b_mint | 200 | pubkey |
| token_a_vault | 232 | pubkey |
| token_b_vault | 264 | pubkey |
| liquidity | 360 | u128 LE |
| sqrt_min_price | 424 | u128 LE |
| sqrt_max_price | 440 | u128 LE |
| sqrt_price | 456 | u128 LE |
| activation_point | 472 | u64 LE |
| activation_type | 480 | u8 (0 = slot, 1 = unix timestamp) |
| pool_status | 481 | u8 (0 = enabled) |
| token_a_flag | 482 | u8 (0 = Tokenkeg, 1 = Token-2022) |
| token_b_flag | 483 | u8 |
| collect_fee_mode | 484 | u8 (0 = BothToken, 1 = OnlyB, 2 = compounding) |
| fee_version selector | 486 | u8 (0 → cap 5e8, else cap 9.9e8) |

### Quote (exactIn, fee denominator 1e9)

```
total_fee = min(cliff_fee_numerator + variable_fee, max_fee_numerator)
variable_fee = ceil((volatility_accumulator · bin_step)² · variable_fee_control / 1e11)   when initialized
```

The variable term uses the **stored** volatility accumulator — exact only within `filter_period`
(the program refreshes volatility references from elapsed time pre-swap). Base fee numerator,
liquidity and sqrt_price change under trading, so the fragment reads them live; band bounds and
dynamic-fee config are immutable pool parameters and are baked as literals.

- **aToB**: `next = ceil(L · sp / (L + dIn · sp))` (price moves down, rounds up); when
  `next < sqrt_min_price` the quote is **clamped to 0** (fragment and `referenceQuote` alike) so
  the other venues in a multi-venue program stay quotable; `gross = floor(L · (sp − next) / 2^128)`
  (delta_b); fee is **always on the output** for aToB: `out = gross − ceil(gross · fee / 1e9)`.
- **bToA**: `next = sp + floor(dIn · 2^128 / L)` (price moves up, rounds down); when
  `next > sqrt_max_price` the quote is clamped to 0 likewise;
  `gross = floor(L · (next − sp) / (sp · next))` (delta_a); fee on the **input**
  (`dIn = amountIn − ceil(amountIn · fee / 1e9)`) when `collect_fee_mode == 1` (OnlyB), on the
  output when it is 0.

Gates: size/discriminator, `pool_status != 0`, `collect_fee_mode == 2` (compounding pools quote
x·y=k on `token_a_amount`/`token_b_amount` instead — different math, not supported),
`base_fee_mode ≥ 2` (rate-limiter/market-cap schedulers are amount-dependent),
`period_frequency != 0` (time-scheduled fees need a clock the in-VM quote lacks),
`cliff_fee_numerator` above the version cap, sqrt price band escapes
`[4295048016, 79226673521066979257578248091]` or `sqrt_price` outside its own band, zero
liquidity, unknown token flags, Token-2022 transfer-fee mints, and a nonzero **slot-typed**
`activation_point` (`activation_type == 0` — the fragment has no slot read, so slot-gated pools
are out of scope, mirroring meteora-damm-v1-stable). Re-checking the bands makes the in-VM
overflow bound unconditional: sqrt prices < 2^97, so `L · sqrt_price < 2^225`,
`amount_in << 128 < 2^192` — all below the engine's 2^256 wrap, no `Math.mulDiv` needed (a
band-violating bToA `sp · next` may wrap, but every such quote is clamped to 0 before use).

### Swap instruction

Data (24 bytes): discriminator `sha256('global:swap')[0..8]` =
`[248, 198, 158, 145, 225, 117, 135, 200]`, `amount_in` u64 LE, `minimum_amount_out` u64 LE (1).

| # | account | flags |
| --- | --- | --- |
| 0 | pool authority `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC` (PDA `['pool_authority']`) | |
| 1 | pool | writable |
| 2 | user input token account | writable |
| 3 | user output token account | writable |
| 4 | token_a_vault | writable |
| 5 | token_b_vault | writable |
| 6 | token_a_mint | |
| 7 | token_b_mint | |
| 8 | user owner | signer |
| 9 | token_a program | |
| 10 | token_b program | |
| 11 | program id (Anchor-optional referral placeholder) | |
| 12 | event authority `3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet` (PDA `['__event_authority']`) | |
| 13 | program id | |

### Pinned worked example

Mainnet WSOL/USDC pool `8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie`
(`sdk/test/svm/fixtures/meteora-damm-v2/`, dumped 2026-07-03/04): liquidity
127_981_592_641_713_518_779_758_772_562_077, sqrt_price 5_268_463_945_783_193_101, cliff fee
400_000 (0.04%), fee_version 0 (cap 5e8), collect_fee_mode 0, activation_point 1_754_985_927
(unix), evaluated at clock 1_780_000_000.

- 1 SOL aToB: next_sqrt_price 5_268_247_074_206_624_762, gross 81_566_288, output fee 32_627 →
  **81_533_661** (81.533661 USDC).
- 100 USDC bToA: gross 1_225_884_357, output fee ceil(gross · 4e5 / 1e9) = 490_354 →
  **1_225_394_003**.
- 100 USDC bToA with `collect_fee_mode = 1`: dIn 99_960_000, gross returned unfeed →
  **1_225_394_028**.

The compounding fixture pool `HybT1fLHfZDjQVnfBdFh9qT8kjPfb6wJCkKkoLZKqunm` pins the
collect_fee_mode gate on real bytes.

### Caveats

- Activation: slot-typed (`activation_type == 0`) pools with a nonzero `activation_point` are
  rejected at fetch. Timestamp-typed (`activation_type == 1`) nonzero points gate in-fragment on
  `block.timestamp` (quote 0 before activation); `referenceQuote` throws pre-activation, with
  `now` in unix seconds.
- Band violations quote 0 (fragment and `referenceQuote` alike) instead of throwing, so the other
  venues in a multi-venue solswapBest program stay quotable.
- Direction defaults to `aToB` from `fetchPoolConfig` (it cannot see the trade); callers flip to
  `bToA` when the input mint is token_b — the mints are exposed for that decision.

---

## saber-stableswap

Two-coin stableswap. Program `SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ` (same address on
mainnet-beta and devnet). Non-Anchor: no 8-byte discriminators anywhere. Layouts and math verified
against `saber-hq/stable-swap` sources: `stable-swap-client/src/state.rs` (SwapInfo), `fees.rs`
(Fees, 8 × u64 LE), `instruction.rs` (SwapInstruction tag 1, account order),
`stable-swap-math/src/curve.rs` (`compute_d` / `compute_y_raw` / `swap_to`).

### SwapInfo account (395 bytes, program_pack)

| field | offset | encoding |
| --- | --- | --- |
| is_initialized | 0 | u8 bool |
| is_paused | 1 | u8 bool |
| nonce | 2 | u8 |
| initial_amp_factor | 3 | u64 LE |
| target_amp_factor | 11 | u64 LE |
| start_ramp_ts | 19 | i64 LE, read unsigned |
| stop_ramp_ts | 27 | i64 LE, read unsigned |
| token_a.reserves (vault A) | 107 | pubkey |
| token_b.reserves (vault B) | 139 | pubkey |
| token_a.mint | 203 | pubkey |
| token_b.mint | 235 | pubkey |
| token_a.admin_fees | 267 | pubkey |
| token_b.admin_fees | 299 | pubkey |
| fees.admin_trade_fee_numerator | 331 | u64 LE |
| fees.admin_trade_fee_denominator | 339 | u64 LE |
| fees.trade_fee_numerator | 363 | u64 LE |
| fees.trade_fee_denominator | 371 | u64 LE |

### Quote (exactIn, A → B)

Reserves are the **live raw** SPL vault balances (amount u64 LE @64): admin fees are transferred
out of the destination vault in the same swap instruction, so `vault.amount` is directly the
quotable reserve — nothing to subtract.

Amp (`compute_amp_factor`): linear interpolation while `now < stop_ramp_ts` (floor division),
otherwise — including `stop_ramp_ts == 0` — the target. The interpolation direction depends only
on compile-time constants, so the fragment bakes the up- or down-ramp branch behind a
`block.timestamp < stop_ramp_ts` check.

Invariant and destination balance are Newton iterations shared with meteora-damm-v1-stable
(`stableD` / `stableY`, declared once by the generator: `ann = amp · 2` inside, ≤ 256 iterations,
converged when successive estimates differ by ≤ 1, floor division throughout — on-chain U192,
exact in bigint because `d ≤ xa + xb < 2^65` keeps d³-scale intermediates below 2^192 for u64
reserves).

```
d  = stableD(amp, srcRes, dstRes)
y  = stableY(amp, srcRes + amountIn, d)
dy = dstRes − y − 1                          (the −1 rounding buffer)
out = dy − floor(dy · trade_fee_num / trade_fee_den)   (fee on the OUTPUT)
```

The fragment reads the live `is_paused` byte and quotes 0 when paused or when `dstRes ≤ y`
(mirroring the on-chain checked_subs — without the guard a paused/dust quote would wrap and
falsely win the best scan). `referenceQuote` returns 0 for `amount_in == 0` (on-chain no-op
success) and throws on an empty reserve (`compute_d` divides by each balance; on-chain
CalculationFailure).

The swap authority is `create_program_address([pool, [nonce @2]], program)` with the **stored**
nonce (find-style would be wrong for non-canonical bumps); an on-curve derivation is rejected.

Gates: size 395, initialized, not paused, positive `trade_fee_denominator` (a zero denominator
fails on-chain with CalculationFailure and aborts the engine's mulDiv).

### Swap instruction

Data (17 bytes): tag `0x01`, `amount_in` u64 LE, `minimum_amount_out` u64 LE (1).

| # | account | flags |
| --- | --- | --- |
| 0 | swap info (pool) | |
| 1 | swap authority | |
| 2 | user transfer authority | signer |
| 3 | user source token account | writable |
| 4 | vault A | writable |
| 5 | vault B | writable |
| 6 | user destination token account | writable |
| 7 | admin fee account of the OUTPUT token (admin_fee_b for A→B) | writable |
| 8 | token program (Tokenkeg — Saber predates Token-2022) | |

### Pinned worked example

Mainnet USDC/USDT pool `YAkoNb6HKmSxQN9L8hiBE5tPJRsniSSMzND1boHmZxe`
(`sdk/test/svm/fixtures/saber-stableswap/`, dumped from mainnet): reserves 203_694_923_631 /
905_506_529_186; amp ramp 8000 → 5000 over 1_747_460_323..1_747_719_515 (finished 2025-05-20), so
any later clock quotes at amp 5000; trade fee 1/10000; nonce 255 → authority
`5C1k9yV7y4CjMnKv8eGYDgWND8P89Pdfj79Trk2qmfGo`.

- 1.0 USDC at now 1_751_500_000: D 1_109_127_433_350, y 905_505_528_482, dy 1_000_703, fee 100 →
  **1_000_603** (1.000603 USDT).
- mid-ramp at start + 100_000: amp = 8000 − floor(3000 · 100000 / 259192) = 6843 → **1_000_413**.

### Caveats

- Quote/swap direction is A → B; B → A is the same math with the roles swapped (the adapter
  interface carries no direction flag).
- `start_ramp_ts`/`stop_ramp_ts` are i64 read unsigned — the sign bit is never set for real
  timestamps.

---

## meteora-damm-v1-stable

Meteora DAMM v1 (Dynamic AMM, ex-Mercurial), stable curve. Program
`Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`; dynamic-vault program
`24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi`. Quotes exact-in A → B (the pool's canonical
direction).

Reserves do NOT come from the pool account nor from raw SPL vault balances: pool funds live inside
two dynamic-vault accounts (lending aggregator), so the quote runs vault share math with
locked-profit decay.

### Pool account

Discriminator `sha256("account:Pool")[0..8]` = `f1 9a 6d 04 11 b1 6d bc`; borsh, no padding;
content ends at 925 of the over-allocated 1387-byte account.

| field | offset | encoding |
| --- | --- | --- |
| token_a_mint | 40 | pubkey |
| token_b_mint | 72 | pubkey |
| a_vault | 104 | pubkey |
| b_vault | 136 | pubkey |
| a_vault_lp | 168 | pubkey |
| b_vault_lp | 200 | pubkey |
| enabled | 233 | u8 bool |
| protocol_token_a_fee | 234 | pubkey |
| protocol_token_b_fee | 266 | pubkey |
| trade_fee_numerator | 330 | u64 LE |
| trade_fee_denominator | 338 | u64 LE |
| protocol_trade_fee_numerator | 346 | u64 LE |
| protocol_trade_fee_denominator | 354 | u64 LE |
| activation_point | 403 | u64 LE |
| activation_type | 475 | u8 (0 = slot, 1 = unix timestamp) |
| curve_type tag | 874 | u8 (1 = Stable) |
| amp | 875 | u64 LE |
| token_a_multiplier | 883 | u64 LE |
| token_b_multiplier | 891 | u64 LE |
| depeg_type | 916 | u8 (0 = None) |

### Dynamic-vault account (≥ 1227 bytes)

Discriminator `sha256("account:Vault")[0..8]` = `d3 08 e8 2b 02 98 75 77`; borsh (`total_amount`
at 11 is unaligned).

| field | offset | encoding |
| --- | --- | --- |
| total_amount | 11 | u64 LE |
| token_vault | 19 | pubkey |
| lp_mint | 115 | pubkey |
| locked_profit_tracker.last_updated_locked_profit | 1203 | u64 LE |
| locked_profit_tracker.last_report | 1211 | u64 LE |
| locked_profit_tracker.locked_profit_degradation | 1219 | u64 LE |

SPL satellites: token account amount u64 LE @64, mint supply u64 LE @36.

### Quote (exactIn, A → B, 8 steps)

1. **Unlocked amounts** at the cluster clock t (`block.timestamp` in-VM): locked profit decays
   linearly at `locked_profit_degradation` per second since `last_report`, denominator 1e12;
   `ratio = (t − last_report) · degradation`; when `ratio > 1e12` the locked profit is 0:
   `unlocked = total_amount − locked_profit · (1e12 − ratio) / 1e12`.
2. **Reserves via share math** (never raw balances):
   `reserve_x = floor(x_vault_lp.amount · unlocked_x / x_lp_mint.supply)`.
3. **Trade fee on the INPUT token** (`calculate_fee`): 0 when the numerator or amount is 0, else
   `max(1, floor(x · n / d))` — the minimum fee of 1 native unit is deliberate conservative
   rounding.
4. **Protocol fee** = same rule applied to the trade fee; `tradeFee −= protocolFee`;
   `inNet = amountIn − protocolFee`.
5. **Vault deposit simulation**: `inLp = floor(inNet · aSup / aUnl)`;
   `afterTotal = floor((inLp + aLpAmt) · (aUnl + inNet) / (aSup + inLp))` (unlocked' = unlocked +
   inNet because total' = total + inNet while locked_profit(t) is unchanged);
   `srcNet = afterTotal − reserveIn − tradeFee`.
6. **Stable curve on multiplier-upscaled reserves** (multipliers immutable, baked; amp re-read
   live — it is admin-adjustable), same `stableD`/`stableY` helpers as saber:
   `d = stableD(amp, rIn·multA, rOut·multB)`; `y = stableY(amp, (rIn + srcNet)·multA, d)`;
   `dest = floor((rOut·multB − y − 1) / multB)` (dy carries the −1 guard).
7. **Vault withdraw simulation** (two more floors): `outLp = floor(dest · bSup / bUnl)`;
   `out = floor(outLp · bUnl / bSup)`.
8. **Strict idle-float bound**: funds deployed to lending strategies are not withdrawable inside
   swap, so `out < b_token_vault.amount` (strict). The fragment clamps to 0 instead of throwing so
   the other venues in a multi-pool program stay quotable; `referenceQuote` throws.

Fees and amp are re-read at quote time (admin-mutable). The deposit/withdraw simulations capture
the 1–2 native units of extra rounding loss the program realizes on each side. Timestamp
activation gates ride in the fragment (`out = 0` before `activation_point` when
`activation_type == 1`).

Gates: discriminators, pool length ≥ 925, vault length ≥ 1227, enabled, curve tag 1 (Stable),
`depeg_type != 0` (depeg pools are out of scope), slot-based activation (`activation_type == 0`
with a nonzero point cannot be evaluated against the unix clock; every settled pool carries 0).

Overflow bounds: every in-fragment product is at most u64 × u64 or u64 × 1e12 < 2^128; the curve
intermediates for stable pairs stay under D < 2^100 (u128 suffices; amp ≤ 10000, 6-decimal
magnitudes), so no fragment product approaches 2^256.

### Swap instruction

Data (24 bytes): discriminator `sha256("global:swap")[0..8]` = `f8 c6 9e 91 e1 75 87 c8`,
`in_amount` u64 LE, `minimum_out_amount` u64 LE (1). Same 15-account list for both directions;
A → B puts inAta on the source side and the A-side protocol fee account at index 11.

| # | account | flags |
| --- | --- | --- |
| 0 | pool | writable |
| 1 | user source token account | writable |
| 2 | user destination token account | writable |
| 3 | a_vault | writable |
| 4 | b_vault | writable |
| 5 | a token_vault (vault's idle SPL float) | writable |
| 6 | b token_vault | writable |
| 7 | a lp_mint | writable |
| 8 | b lp_mint | writable |
| 9 | a_vault_lp | writable |
| 10 | b_vault_lp | writable |
| 11 | protocol_token_a_fee | writable |
| 12 | user owner | signer |
| 13 | vault program `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` | |
| 14 | token program | |

### Pinned worked example

Mainnet USDC/USDT pool `32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG`
(`sdk/test/svm/fixtures/meteora-damm-v1-stable/`, observed state 2026-07-04): trade fee
100/1_000_000 (0.01%), protocol fee 0/1_000_000, amp 8000, multipliers 1/1, vault_a last_report
1_783_173_885.

- 1_000_000_000 uUSDC at the exact snapshot clock t = 1_783_175_236 → **1_000_605_351** uUSDT.

### Caveats

- The quote attaches 8 read-only accounts (pool, both vaults, both vault-LP token accounts, both
  LP mints, and only the OUT-side token_vault for the idle-float bound); t comes from the Clock
  sysvar.
- `a_lp_mint`/`b_lp_mint` are read from the vault account @115 — NOT reliably the canonical PDA.
- `t < last_report` cannot happen on-chain (the vault crank stamps last_report from the same
  clock); if it ever wrapped, the ratio would exceed 1e12 and the fragment falls back to
  `total_amount`. `referenceQuote` throws on it instead.
