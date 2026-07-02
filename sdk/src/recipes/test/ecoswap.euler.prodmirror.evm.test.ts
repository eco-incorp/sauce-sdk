/**
 * EcoSwap EulerSwap PROD-MIRROR — BLOCKED (no mirrorable real target deployed).
 *
 * The EulerSwap analogue of ecoswap.fluid.prodmirror.evm.test.ts / ecoswap.dodo.prodmirror.evm.test.ts
 * CANNOT be built: there is NO deployed EulerSwap pool of the version the recipe targets. This file is a
 * documented placeholder (single `it.skip`) recording the exact blocker + the re-light condition, matching
 * how the codebase flags deferred/unlit sources (constants.ts EulerSwap FactoryConfig entries: mainnet
 * :481-487, Base :422-423, Arbitrum :567, Polygon :659). It is intentionally NOT wired to anvil/RPC/harness
 * so it runs OFFLINE in milliseconds and never fabricates a pool or stubs the core Euler pricing.
 *
 * WHY BLOCKED — STRUCTURAL, not a data gap. The recipe's `discoverEulerSwapPoolsTyped`
 * (shared/pool-discovery.ts:2718) hard-requires each pool's `getDynamicParams()` — the EulerSwap **v2**
 * curve bundle `(equilibriumReserve0/1, minReserve0/1, priceX/priceY, concentrationX/concentrationY,
 * directional fee0/fee1, expiration, swapHookedOperations, swapHook)` (the ABI at pool-discovery.ts:2673).
 * A pool that reverts `getDynamicParams()` fails the discovery multicall entry → is dropped, so the whole
 * production `FactoryType.EulerSwap` discovery→bracket→execute path has NOTHING to price. A prod-mirror
 * needs a REAL pool that responds to that view at a capturable state; none exists.
 *
 * EXHAUSTIVE SCAN (one-time, read-only RPC; pinned mainnet 25441767 / Base 48084524):
 *   · Ethereum factory 0xb013be1D0D380C13B58e889f412895970A2Cf228 — poolsLength() = 24. ALL 24 pools:
 *       curve() = 0x45756c6572537761702076310000… = ASCII "EulerSwap v1"; getDynamicParams() REVERTS
 *       (execution reverted). Several stable pairs exist (USDC/USDT ×several, USDC/DAI) and getReserves()
 *       works — e.g. USDC/USDT 0x701f1F0b…68a8 = 234004994 / 51847945 (~$234 / ~$51, tiny operator-bound
 *       reserves) — but NONE is v2. eulerSwapImpl() = 0xc35a0FDA69e9D71e68C0d9CBb541Adfd21D6B117
 *       (itself curve()="EulerSwap v1", getDynamicParams() reverts).
 *   · Base factory 0xf0CFe22d23699ff1B2CFe6B8f706A6DB63911262 — poolsLength() = 9. ALL 9 pools:
 *       curve() = "EulerSwap v1"; getDynamicParams() REVERTS. No pool pairs two Base baseTokens (only
 *       WETH/USDC, EURC/USDC, cbBTC-ish/USDC, EURC/WETH — mixed volatile/stable).
 *       eulerSwapImpl() = 0x3Ce63C16CB719a0c755DA25cd5dD35170A00424f (curve()="EulerSwap v1").
 *
 * ROOT CAUSE — every EulerSwap pool is an EIP-1167 minimal-proxy CLONE delegating to the factory's single
 * pinned `eulerSwapImpl`, and that implementation is **v1** on every chain the recipe knows. `getDynamicParams()`
 * is absent from the v1 impl's dispatch, so NO pool minted by either factory can EVER respond to it — a v2
 * state cannot be reconstructed from these deployments. (Confirms constants.ts verbatim: "expose the EulerSwap
 * **v1** surface (curve()=='EulerSwap v1', getParams()) — they REVERT getDynamicParams() … Re-light by address
 * once a stable-pair EulerSwap **v2** pool (getDynamicParams) is deployed. eulerSwapPools intentionally omitted.")
 *
 * COVERAGE THAT DOES EXIST — the synthetic ecoswap.euler.evm.test.ts stands up the EulerSwapPool.sol fixture
 * (CurveLib.f + QuoteLib.computeQuote mirroring eulerswap-math.ts bit-for-bit) and cooks the callback-free
 * exact-in-dy EcoSwap path on v1 (+ v12). That is the strongest available proof until a v2 pool ships; it is
 * a locally-deployed-fixture test, NOT a prod-mirror, so it does NOT assert against captured mainnet bytecode.
 *
 * RE-LIGHT (when this becomes buildable):
 *   1. Re-run the scan; if any pool's curve() reads "EulerSwap v2" AND getDynamicParams() returns a tuple:
 *   2. Enumerate the WHOLE touched contract set with `cast access-list` on the pool's quote (getDynamicParams
 *      / computeQuote) AND swap paths — the pool + its EVault(s) + the EVC (+ any price oracle) — resolving
 *      proxies via eth_getCode.
 *   3. Write harness/euler-snapshot.ts (ADDITIVELY reusing harness/etch-pool.ts, like fluid-snapshot.ts):
 *      eth_getCode every runtime → fixtures/snapshots/<chain>-euler-<pair>.bytecode.json (WITH sha256 anchors);
 *      eth_getStorageAt every touched slot across ALL dependency contracts → .state.json; pin the block.
 *   4. Register the pool: add its address to the wired FactoryConfig's `eulerSwapPools` (constants.ts) so the
 *      production FactoryType.EulerSwap discovery path finds it.
 *   5. Replace this it.skip with the real prod-mirror body (mirror ecoswap.fluid.prodmirror.evm.test.ts):
 *      boot a PLAIN anvil (NO fork), setCode every real runtime at its captured address, setStorageAt-
 *      reconstruct all captured slots across the whole graph, repoint tokens at local MintableERC20s, fund,
 *      cook EcoSwap through the real discovery path, and assert (a) eth_getCode byte-equals the captured
 *      runtime at the pool + every dependency, (b) OFFLINE + fast, (c) wei-exact vs ecoswap.optimal.ts AND
 *      vs the pool's own computeQuote view of the awarded slice — on v1 AND v12.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file) — SKIPS, milliseconds, offline.
 */

import { describe, it } from "node:test";

describe("EcoSwap EulerSwap PROD-MIRROR", () => {
  it.skip(
    "BLOCKED: no EulerSwap v2 pool deployed — every pool on the mainnet (0xb013be1D…, 24 pools) and " +
      "Base (0xf0CFe22d…, 9 pools) factories is an EIP-1167 clone of a v1 impl (curve()=\"EulerSwap v1\") " +
      "that REVERTS getDynamicParams(), which discoverEulerSwapPoolsTyped requires. No real target to " +
      "mirror. Re-light once a stable-pair EulerSwap v2 pool ships (see file header for the capture steps).",
    () => {},
  );
});
