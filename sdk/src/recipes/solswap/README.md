# Solswap

Solswap is the SVM (Solana) quote-and-swap pattern: attach N pool state accounts **read-only**,
quote every pool **inside the VM** from `accountData` reads, branch to the single best venue, make
**one CPI** to the winner, enforce `minOut`, return `bestOut`. The recipe generates the SauceScript
per config (unrolled per pool, 2–8 pools), compiles it with `target: 'svm'`, and returns the
bytecode plus the ordered `AccountPlan` the send layer resolves.

## Why quotes are reads, not CPIs

Solana has no view functions: a program can only be *invoked*, and an invocation cannot return a
value to an off-chain caller without executing a full transaction. That is why Meteora and Jupiter
quote **off-chain** from fetched account state. Sauce moves the same idea **on-chain**: pool state
accounts are attached to the execute instruction and the engine's `accountData` (SVM `SLOAD`) reads
reserves directly from account data — no CPI, no writable locks, no quote staleness between the
quote and the swap (both happen in the same instruction against the same account state).

Quoting N venues therefore costs exactly N read-only account metas. The account plan is static, so
**every** candidate venue's swap accounts ride along with their declared flags — writable ones hold
writable locks for the whole transaction — but only the winner's accounts are actually written, and
only one CPI runs.

## Selection semantics

The winner scan is strictly-greater: on an exact quote tie the **first-listed** pool keeps the win,
so pool order encodes venue preference. The `minOut` bound is inclusive — `bestOut == minOut`
passes; the program reverts (payload `"minOut"`) only when `bestOut < minOut`.

## The CATCH platform law: pre-flight only

The engine's CATCH intercepts **pre-flight** CPI failures only (target program not attached, bad
calldata/accounts operands, index out of bounds). Once `invoke()` launches, a failing callee aborts
the **whole transaction** — there is no try/catch across a CPI on Solana. Design consequence baked
into this recipe: the `minOut` bound is checked **before** the dispatch (`throw "minOut"`), so a
losing quote reverts without ever starting the CPI. Do not write recipes that "try venue A, fall
back to venue B" across CPIs — that is not expressible on this platform.

## Account budget for 4 venues

The plan's metas union: N pool refs (readonly) + the venue program refs + the payer + every venue's
swap accounts. For the e2e shape (4 pools, 1 shared venue program, payer + 4 recipients):

| accounts                              | count |
| ------------------------------------- | ----- |
| fee payer + engine program + 3 PDAs   | 5     |
| pool state (readonly)                 | 4     |
| venue program (readonly)              | 1     |
| payer meta (in-plan, dedupes w/ payer)| 1     |
| per-venue swap accounts               | 4     |

≈ 15 static keys ≈ 480 bytes of keys; with ~430 bytes of bytecode the whole v0 message sits around
1.1 KB — under the 1232-byte packet cap with no address lookup tables, and far under the 64
account-lock cap. Real venues (~10–15 accounts each) blow past the packet cap quickly: budget with
`estimatePacket` (the recipe surfaces its warnings) and move venue account sets into ALTs.

## v1 scope

Real AMM adapters (Raydium/Orca layouts, little-endian u64 reserve decoding, CLMM tick math) are
explicitly out of v1 scope. The pool layout is the recipe's own canonical fixture layout — 32-byte
**big-endian** reserves at caller-supplied offsets — and the "swap" CPI is whatever instruction the
caller bakes (the e2e suite uses a system-program transfer standing in for the venue call). The
recipe's value is the compiled control-flow/account-plan shape, which is venue-agnostic.

Quote math is constant-product with fee, `mulDiv`-based and full-precision in the numerator:
`out = mulDiv(amountIn·(10000−feeBps), reserveOut, reserveIn·10000 + amountIn·(10000−feeBps))`.
Engine arithmetic **wraps**, so callers must keep reserves and `amountIn` below 2^128 (any real
token magnitude qualifies); `solswapQuote` is the exact off-chain mirror for computing expected
outputs.
