# EcoSwapSVM (Phase 0)

The Solana sibling of EcoSwap: split ONE swap across multiple constant-product venues so the
**post-fee marginal execution prices equalize**, with the whole solve computed **LIVE in one atomic
engine instruction**. Same thesis as the EVM recipe (`../README.md`) — pouring input into the best
marginal price first and stopping at a common level IS the convex optimum — restated for a chain
with no view functions: pool state accounts are attached read-only, the engine's `accountUint`
reads pull the reserves inside the VM, and the quote, the split and the swaps all happen against
the same account state in the same instruction. No off-chain quote can be stale, because there is
no off-chain quote.

## The quantized water-fill

Solana's compute budget cannot afford a continuous marginal-equalization solve per trade, so the
split is **quantized**:

- every active slot builds a **geometric quote ladder** from its LIVE reserves: `QL_S = 4` rungs on
  the cumulative grid `G_j = amountIn >> (QL_S − j)` (so `G_4 = amountIn` — one venue can always
  absorb the whole trade; fine rungs near zero, coarse near the top), each rung carrying its exact
  venue output delta `dOut_j = out(G_j) − out(G_{j−1})`;
- one **k-way cheapest-rung-first merge** fills `amountIn`: each step elects the best next rung by
  average execution price (integer-exact cross-multiplication `dOut_c·dIn_b > dOut_b·dIn_c`, ties
  keep the earliest slot — slot order encodes preference) and advances only that slot; the marginal
  rung fills **partially**, so the binding venue's cut is exact to the lamport;
- the **entire split is computed before the first CPI** (platform law: once `invoke()` launches, a
  failing callee aborts the whole transaction — nothing is catchable), then each engaged slot's
  venue swap executes with its instruction-data amount **patched at runtime** from the merge
  result, and **one terminal realized-delta check** on the user's outAta enforces `minOut` across
  all slots at once (venue-level `min_out` is 1 everywhere, the solswap discipline).

## The shape-blob model (stage once, trade many)

`codegen.ts` assembles the solver from **positional family slots** and compiles it
`{ target: 'svm', staged: true }`. ONE compiled blob per **shape** — the ordered list of
`(family, direction, optional-account layout)` (`shapeKey`) — serves ANY matching pool set:

- pool ACCOUNTS ride the transaction account list at fixed per-slot positions (slot-role refs
  `s<i>:*`), rebound per trade through the resolution map (the plan's adapter-resolved refs are
  pre-stamped with pubkeys; callers resolve only `user:*` refs);
- per-trade VALUES ride the payload args as ONE packed bytes `cfg` (u64 LE words:
  `[amountIn][minOut]` then per slot `[enable][…params]`) — `main(cfg)` takes a single parameter,
  keeping the staged arg prologue flat; `encodeEcoSwapSvmTrade` / `output.encodeTrade` re-encode
  for new trades without re-staging;
- the blob is staged once through the buffer protocol (hash-pinned; `stageEcoSwapSvm`) and every
  trade is ONE `execute_from_account` instruction (`executeEcoSwapSvm`).

Adapter contract **v2** (`SvmVenueLadderV2`, `sdk/src/svm/venues/*/ladder.ts`): amount-PARAMETRIC
fragments. Unlike v1's `emitQuote` (folds the trade amount into compile-time constants), a v2
fragment reads the amount and the live reserves at RUNTIME — nothing about the trade is baked.
Families in Phase 0: **raydium-cp-swap** (reserves = vaults minus the fee accumulators, AmmConfig
fee rates read live, creator-fee side as a per-trade param), **pumpswap** (raw vault reserves, fee
bps as per-trade params, buy and sell directions), **orca-legacy-token-swap** (raw vault reserves,
the SwapV1 fee fractions as params, floor-min-1 fees + ceiling-divided curve).

## The exactness gate + the two oracles

- `solver-reference.ts` — the TS mirror of the quantized solver, transcribed **bit-for-bit** (same
  grid, same merge scan order, same integer ops and truncation). It is the **lamport-exact gate**:
  the e2e suite asserts the engine's returndata (per-slot slices, predicted outputs, realized
  total) equals the mirror evaluated on the same account bytes — including after doctored-reserve
  drift. It is also the **user-facing quote**: `quoteEcoSwapSvm` runs it over account bytes fetched
  once through the injected `AccountLoader` (e.g. one `getMultipleAccounts` sweep) — zero
  simulation.
- `optimal.ts` — the **continuous** closed-form CP marginal equalization
  (`x_i(λ) = (√(μγ·rIn·rOut/λ) − rIn)/γ` over the active set), used ONLY to measure the
  quantization efficiency loss. Never a gate.

## Usage

```ts
import { ecoSwapSvm, quoteEcoSwapSvm, stageEcoSwapSvm, executeEcoSwapSvm } from '@eco-incorp/sauce-sdk/recipes';

const output = await ecoSwapSvm({
  amountIn, minOut,
  pools: [
    { venue: 'raydium-cp-swap', pool: rayPool },                       // 0to1 (default)
    { venue: 'pumpswap', pool: pumpPool, direction: 'baseToQuote' },   // sell: base in
  ],
  user: { outAta: 'user:out', inAta: 'user:in', owner: 'payer' },
  load,                                                                 // AccountLoader (RPC or fixtures)
});

const staged = await stageEcoSwapSvm(client, 0, output);                // once
await executeEcoSwapSvm(client, staged, output, resolution);            // one instruction per trade
await executeEcoSwapSvm(client, staged, output, resolution, { amountIn: other, minOut });
```

`prepare` reuses the v1 adapters' `fetchPoolConfig` gates (status bits, transfer-fee mints, curve
types), then filters on **relative depth** (`L = isqrt(rIn·rOut)`; drop below `minRelBps`/1e4 of
ΣL, default 1%, 0 disables — the EVM recipe's discipline) and admits the deepest
`ECO_SVM_MAX_SLOTS` survivors.

## Measured (LiteSVM, real engine.so)

| metric | value |
| --- | --- |
| 2-venue full trade (split + 2 CPIs) | **841,592 CU** (cap 1,400,000) |
| 3-venue full trade | ≈ 1,308,000 CU |
| 4-venue full trade | exceeds the cap (`ProgramFailedToComplete`) |
| 2-slot blob | 1,461 bytes (staged cap 65,535) |
| execute transaction | 689 bytes (packet cap 1,232) |
| packed cfg args (2 slots) | 64 bytes |
| quantization loss vs continuous | 0.63% on the deliberately shallow test universe (trade ≈ 23%/12% of the two pools' depth); second-order — deep pools sit orders of magnitude lower |

## Honest limits (Phase 0)

- **CP-class venues only** (raydium-cp-swap, pumpswap, orca-legacy) — no stable curves, no
  CLMM/DLMM, no multihop routes yet.
- **Ladder quantization**: `QL_S = 4` fixed rungs; only the binding venue's marginal rung splits
  exactly, so non-binding slots quantize to rung boundaries (the 0.63% number above is the
  shallow-fixture worst case). GasLeft-adaptive ladder depth is **deferred** to Phase 1.
- **The 4-slot CU wall**: the codegen template is structurally 4-wide, but the interpreter's
  per-op cost (measured ≈ 470k CU per slot) walls a 4-slot trade above the 1.4M transaction cap —
  the orchestrator admits at most **3** slots until the Phase 1 CU budgeter / leaner codegen (or
  cheaper engine ops) lands.
- **Direction is part of the shape** (raydium's input-side fee-accumulator offsets, pumpswap's
  buy-vs-sell helper): flipping direction re-stages. So is pumpswap's optional `pool-v2` remaining
  account.
- **Disabled slots still read their accounts**: the setup reads are unconditional, so a disabled
  slot's accounts must stay attached and readable (the enable flag skips its ladder, merge
  participation and CPI).
- **Pumpswap fee params are prepare-time snapshots** (admin-mutable flat/tier bps ride as args, so
  a fee change re-encodes 24 payload bytes, not the blob) — staleness is covered by the terminal
  minOut delta check, same contract as the v1 adapter's baked tier.
- **Venue binaries are not deployed in the e2e** (repo convention — see
  `solswap-best.e2e.test.ts`): the split, ladders and merge run the production path against live
  account bytes on the real engine, and the CPIs exercise the same runtime calldata-patch path
  through SPL-transfer stand-ins paying each slot's predicted output (`patch: 'out'`); the real
  venue templates (`patch: 'in'`) are byte-built by the same adapters and pinned by the unit
  suite. A `SAUCE_VENUE_PROGRAMS`-gated real-binary lane is the natural Phase 1 extension.
- **Orca dust edge**: where the venue would throw (fees swallow the input, zero quotient/output),
  the ladder helper quotes 0 — a dust rung never wins the merge, and a slot with predicted output
  0 skips its CPI (the input dust stays in the user's inAta rather than aborting the trade).

## Phase 1 notes

Stable-curve families (saber, meteora-damm-v1-stable — the shared Newton helpers already exist in
solswap), more CP venues (raydium-amm-v4), the CU budgeter (fit ladder depth and slot count to the
remaining budget via `gasLeft()`), leaner merge codegen (unrolled variant, division-skip
branches), real-binary CPI lanes, and multihop legs once the single-hop skeleton has soaked.
