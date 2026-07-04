# Solswap

Solswap is the SVM (Solana) quote-and-swap pattern: attach the candidate pools' state accounts
**read-only**, quote every pool **inside the VM** from account reads, branch to the single best
venue, make **one CPI** to the winner, and enforce `minOut`. The module ships two generators:

- **`solswapBest(config)`** — multi-venue best-quote over the real venue adapters
  (`sdk/src/svm/venues/`), plus off-chain **external quotes** baked as constants. Returns the
  **realized** outAta delta, verified on-chain after the swap.
- **`solswap(config)`** — the original fixture-layout recipe (canonical big-endian reserves at
  caller-given offsets, caller-baked CPI). Kept as-is for the control-flow/account-plan e2e suite;
  see [the v1 section](#solswap-v1-fixture-layout-recipe) at the end.

Both are pure and offline: they generate SauceScript, compile it with `target: 'svm'`, and return
bytecode + the ordered `AccountPlan`; callers resolve the plan and send via the `/svm` module.

## Why quotes are reads, not CPIs

Solana has no view functions: a program can only be *invoked*, and an invocation cannot return a
value to an off-chain caller without executing a full transaction. That is why aggregators quote
**off-chain** from fetched account state. Sauce moves the same idea **on-chain**: pool state
accounts are attached to the execute instruction and the engine's account reads (`accountData` /
`accountUint`) pull reserves directly from account data — no CPI, no writable locks, and no
staleness between the quote and the swap: both happen in the same instruction against the same
account state.

Quoting a venue costs exactly its quote accounts as read-only metas. The account plan is static, so
**every** candidate venue's swap accounts ride along with their declared flags — writable ones hold
writable locks for the whole transaction — but only the winner's accounts are actually written, and
only one CPI runs.

## Venue matrix

Seven adapters, registered in `sdk/src/svm/venues/registry.ts` (`listVenues()` /
`venueAdapter(slug)`). Every adapter decodes its pool off-chain once (`fetchPoolConfig`), emits the
in-VM quote fragment (`emitQuote`), builds the swap CPI (`buildSwap`, venue-level `min_out = 1`),
and mirrors the quote math in TS for tests (`referenceQuote`). Out-of-scope pools are rejected at
fetch time with a named **gate** error — a gated pool never reaches the generator.

| venue (slug)             | kind             | program                                        | in-VM quote reads                                | fetch-time gates |
| ------------------------ | ---------------- | ---------------------------------------------- | ------------------------------------------------ | ---------------- |
| `raydium-cp-swap`        | constant-product | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | 4: pool + AmmConfig + both vaults                 | swap-disabled status bit, future `open_time`, vault/mint integrity, token-2022 transfer-fee mints |
| `raydium-amm-v4`         | constant-product | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | 3: AmmInfo + both vaults                          | status must be 6 (SwapOnly) or 7 (WaitingTrade) — orderbook-enabled pools (status 1/5) are rejected |
| `pumpswap`               | constant-product | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`  | 2: base + quote vaults (fee tier baked at fetch)  | mayhem-mode pools, cashback coins, global disable flags, fee-config integrity |
| `orca-legacy-token-swap` | constant-product | `9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP` | 2: both vaults (fees are pool constants)          | SwapV1 version + initialized, `curve_type` must be 0 (constant product), zero fee denominators |
| `meteora-damm-v2`        | sqrt-price       | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`  | 1: the pool account only (never vault balances)   | pool enabled, `collect_fee_mode` in {0, 1}, static base fee only (no rate-limiter/scheduler), no transfer-fee mints |
| `saber-stableswap`       | stable           | `SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ`  | 3: pool (live pause byte) + both vaults           | initialized, not paused, positive trade-fee denominator |
| `meteora-damm-v1-stable` | stable           | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | 8: pool, dynamic vaults, vault LP accounts, LP mints | pool enabled, Stable curve only, depeg pools out of scope, timestamp (not slot) activation only |

The two stable venues share one pair of Newton helpers (`stableD` / `stableY`: ann = amp·2, ≤ 256
iterations, converged at |Δ| ≤ 1, floor division), which the generator declares **once** when any
stable pool is present — `break` does not exist on the v12 target, so convergence rides in the loop
condition.

## Selection semantics

The winner scan is strictly-greater: on an exact quote tie the **first-listed** pool keeps the win,
so pool order encodes venue preference. The `minOut` bound is inclusive — `bestOut == minOut`
passes; the program reverts (payload `"minOut"`) only when `bestOut < minOut`, **before** any CPI
starts.

## Post-swap verification

Every venue swap is built with venue-level `min_out = 1` — the venue's own slippage check is
deliberately disarmed. Instead the generated program snapshots the user's outAta balance (SPL
`amount`, u64 LE at offset 64) right before the dispatch, re-reads it after the winner CPI, and
reverts with payload `"out"` when `after − before < minOut`. This single check:

- enforces the real bound for live venues (covering any drift between the in-VM quote formula and
  the venue's execution math — rounding, fee-tier boundaries), and
- is the on-chain safety net for **stale external quotes** (below).

`solswapBest` **returns the realized delta**, not the predicted quote — the caller reads what the
swap actually delivered.

## External quotes and the staleness contract

Pools whose math cannot be reproduced from account reads enter as external entries:

```ts
{ external: { label: 'solfi', quotedOut, swap } }  // swap: VenueSwap from your own builder
```

`quotedOut` is baked into the bytecode as a **constant** candidate in the best scan. Get it from
`quoteViaSimulation` (`sdk/src/svm/quoteSim.ts`): it simulates the swap instruction standalone
(`replaceRecentBlockhash`, no signature verification round-trip) and returns the outAta balance
delta.

**Staleness contract:** an external quote is exact at simulate time ONLY. Any state change between
the simulation and on-chain execution — someone else trades, fees change, an oracle ticks —
silently invalidates it. The engine cannot re-verify a constant, so a stale external quote can win
the scan with a number the venue will no longer pay. That is acceptable *by design*: the post-swap
outAta delta check reverts the transaction (`"out"`) whenever the realized output falls below
`minOut`, whatever the scan believed.

### Prop-AMM coverage

The closed-source prop AMMs (SolFi, Obric v2, ZeroFi, HumidiFi, …) publish no pool math and often
no layouts — there is nothing for an in-VM `emitQuote` to read. They are covered exclusively
through the external-quote path above. This is the intended split: **adapters for open-math
venues, simulation for black boxes.**

### Sanctum (follow-up)

Sanctum's LST swaps (s-controller / Infinity) have open math but quote through per-LST pricing
programs and the stake-pool rate — a multi-program account graph that does not fit the
one-adapter-one-pool shape yet. Planned as a follow-up adapter; until then route Sanctum through
the external-quote path.

### Lifinity (wind-down)

Lifinity v2 prices from a live oracle with proactive market-making inventory shifts; a baked in-VM
quote would be stale by construction, and the protocol is winding down its DEX liquidity. No
adapter is planned — if a route still crosses Lifinity, use the external-quote path.

## The CATCH platform law: pre-flight only

The engine's CATCH intercepts **pre-flight** CPI failures only (target program not attached, bad
calldata/accounts operands, index out of bounds). Once `invoke()` launches, a failing callee aborts
the **whole transaction** — there is no try/catch across a CPI on Solana. Design consequences baked
into this recipe: the `minOut` bound is checked **before** the dispatch (`throw "minOut"`), so a
losing quote reverts without ever starting the CPI, and the post-swap `"out"` check can never be
"caught" around a failing venue. Do not write recipes that "try venue A, fall back to venue B"
across CPIs — that is not expressible on this platform.

## Packet budget and the ALT path

Both generators run `estimatePacket` over the final plan (fee payer + engine accounts + the execute
instruction) and surface its warnings on the result's `warnings` (deduplicated against the
compiler's own copy). Real venues cost real accounts — a raydium-cp-swap CPI alone is 13 accounts —
so a multi-venue plan overruns the 1232-byte packet cap quickly. An overflow warning means the send
needs an address lookup table: move the venue-resolved metas (every meta the recipe stamped with a
`pubkey`) into an ALT and keep caller-resolved refs (outAta/inAta/owner) in the static section. The
64-account lock cap is the hard ceiling ALTs cannot lift.

## Testing on the real engine — and against real venue programs

The engine-gated suites (`sdk/test/svm/venue-triangle.e2e.test.ts`,
`sdk/test/svm/solswap-best.e2e.test.ts`) execute generated bytecode on the real SVM engine inside
LiteSVM. They need the engine binary (`SAUCE_ENGINE_SO`, built with `make build` / `cargo
build-sbf` in the sauce repo) and skip cleanly without it. Venue programs are *not* deployed
there: the winning CPI is either an SPL-token-transfer stand-in or bracketed through the pre-CPI
`"minOut"` revert.

The **real-binary CPI suite** (bottom of `solswap-best.e2e.test.ts`) additionally loads a venue
program dumped from mainnet and asserts the full quadrilateral — facts pin == `referenceQuote` ==
in-VM quote == the realized output of the actual venue binary. Point `SAUCE_VENUE_PROGRAMS` at a
directory of dumps named `<venue slug>.so`:

```sh
mkdir -p ~/venue-programs
solana program dump SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ \
  ~/venue-programs/saber-stableswap.so --url https://api.mainnet-beta.solana.com

cd sdk && NODE_OPTIONS=--experimental-vm-modules \
  SAUCE_ENGINE_SO=path/to/engine.so \
  SAUCE_VENUE_PROGRAMS=~/venue-programs \
  npx jest --config jest.config.cjs test/svm/solswap-best.e2e.test.ts
```

The suite skips cleanly when `SAUCE_VENUE_PROGRAMS` is unset or the dump is missing. Note the
program binary alone is enough for saber; venues whose swap path reads accounts outside the quote
fixtures (e.g. saber's admin-fee destination) get those fabricated by the test.

## solswap v1 (fixture-layout recipe)

The original `solswap(config)` recipe survives unchanged underneath `solswapBest`. Real AMM layouts
are explicitly out of its scope: the pool layout is the recipe's own canonical fixture layout —
32-byte **big-endian** reserves at caller-supplied offsets — and the "swap" CPI is whatever
instruction the caller bakes (the e2e suite uses a system-program transfer standing in for the
venue call). Its value is the compiled control-flow/account-plan shape, which is venue-agnostic,
and it enforces `minOut` pre-CPI only (payload `"minOut"`, no post-swap delta check) and returns
`bestOut`, the predicted quote.

Quote math is constant-product with fee, `mulDiv`-based and full-precision in the numerator:
`out = mulDiv(amountIn·(10000−feeBps), reserveOut, reserveIn·10000 + amountIn·(10000−feeBps))`.
Engine arithmetic **wraps**, so callers must keep reserves and `amountIn` below 2^128 (any real
token magnitude qualifies); `solswapQuote` is the exact off-chain mirror for computing expected
outputs.
