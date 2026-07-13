/**
 * Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed re-centering AMM) —
 * QUOTE-LADDER (QL) model over the pool's LIVE resolver quote.
 *
 * THE SINGLE SOURCE for how a Fluid DEX venue is modeled off-chain. Fluid is a QUOTE-LADDER family
 * (segKind 12): prepare ships ONLY a descriptor (address, resolver, swap0to1, fee) — NO sampled segments —
 * and the on-chain solver builds each venue's price ladder in setup from LIVE cook-time
 * `resolver.estimateSwapIn(dex, swap0to1, xNext, 0)` quote-differencing (the SAME curve-agnostic
 * `buildQLLadder` recurrence every other QL family runs). The neutral oracle (ecoswap.optimal.ts) and the
 * cursor-faithful reference mirror it via `buildFluidQLLadder` below, driven by a caller-supplied `getDy`
 * quote model (a bit-exact fixture replay in the local tests; a prefetched real-resolver quote grid in the
 * prod-mirror), so solver == oracle by construction — one recurrence, one grid.
 *
 * REAL ON-CHAIN SURFACE (VERIFIED, not fabricated). A Fluid DexT1 pool prices off the Liquidity-Layer
 * supply/borrow exchange prices + a re-centering center price + utilization/borrow caps — ALL canonical
 * on-chain state — so there is NO closed form to replay off-chain and NO getAmountOut view on the pool. The
 * verified surface is:
 *   FluidDexT1 pool:
 *     swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_)
 *         payable returns (uint256 amountOut_)
 *       — pulls tokenIn via SafeTransfer.safeTransferFrom(msg.sender, LIQUIDITY, amountIn) (APPROVE-FIRST,
 *         like Fermi/Wombat/Curve — NOT transfer-first like WOOFi), sends amountOut to `to_`. When
 *         to_ == ADDRESS_DEAD (0x…dEaD) the pool `revert FluidDexSwapResult(amountOut_)` BEFORE touching
 *         the Liquidity layer — the protocol's own estimate hook.
 *     swapOut(bool, uint256 amountOut_, uint256 amountInMax_, address to_) payable returns (uint256 amountIn_)
 *   FluidDexReservesResolver (periphery, DexReservesResolver):
 *     getDexTokens(address dex_) view returns (address token0_, address token1_)
 *       — orients the pair. The DexT1 POOL has NO standalone token0()/token1() getters (token0/token1 are
 *         immutables exposed only inside constantsView()'s struct), so both discovery and the on-chain
 *         solver read getDexTokens off the resolver, never the pool.
 *     estimateSwapIn(address dex_, bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_)
 *         payable returns (uint256 amountOut_)
 *       — implemented by `try IFluidDexT1(dex_).swapIn(swap0to1_, amountIn_, amountOutMin_, ADDRESS_DEAD)
 *         catch (bytes lowLevelData_) { amountOut_ = _decodeLowLevelUint1x(lowLevelData_,
 *         IFluidDexT1.FluidDexSwapResult.selector); }`. It reads the LIVE layer state + caps, so it is the
 *         canonical exact-in quote. GRACEFUL: `_decodeLowLevelUint1x` returns 0 for ANY underlying revert
 *         whose selector is not FluidDexSwapResult (cap exceeded / paused / invalid amounts), so the QL
 *         quote is a plain single-return call with `q == 0 ⇒ stop` (the WOOFi-tryQuery class — NO
 *         probe-then-decode `.catch` needed).
 * `swap0to1_` is a BOOL: true ⇒ token0→token1, false ⇒ token1→token0.
 *
 * WHY THE RECIPE QUOTES VIA THE RESOLVER, NOT THE POOL. The pool's own estimate is a REVERT
 * (FluidDexSwapResult), and SauceScript has no try/catch — a call that reverts propagates. The RESOLVER's
 * `estimateSwapIn` does the try/catch in Solidity and returns a plain uint256, so the on-chain solver
 * calls the RESOLVER for both the QL ladder (setup) and the per-venue exec quote (the amountOutMin).
 * NB estimateSwapIn is a plain CALL, NOT a staticcall: the real FluidDexT1 pool WRITES STATE on the
 * ADDRESS_DEAD estimate path before it reverts with the result, so a STATICCALL would revert the inner
 * swapIn with the static-state-change error and the resolver's catch would return 0 (proven by
 * ecoswap.fluid.prodmirror.evm.test.ts) — IFluidDexResolver.json marks estimateSwapIn `nonpayable` for
 * exactly this; the internal revert rolls back any state, so the CALL is side-effect-free in effect (each
 * ladder quote sees the same frozen state).
 *
 * ON-CHAIN EXECUTION is CALLBACK-FREE (Fluid DexT1 re-enters ITS OWN Liquidity layer via operate(), never
 * the cooking contract — the non-callback swapIn pulls via safeTransferFrom, so it needs NO engine
 * dispatch): the solver re-reads the out for the awarded share LIVE via the resolver
 * `estimateSwapIn(dex, swap0to1, +share, 0)` (used as amountOutMin), APPROVES the pool for the input
 * (Fluid PULLS via transferFrom), then calls `pool.swapIn(swap0to1, share, amountOutMin, self)`.
 *
 * WEI-EXACTNESS CLASS — LIVE-WALK (the strongest). The ladder is built from LIVE cook-time quotes (no
 * prepare-time snapshot survives into the split), so the split RE-ANCHORS to any drift between prepare and
 * cook: the layer's exchange prices accruing every block + a utilization/borrow cap shrinking are absorbed
 * by the cook-time ladder, exactly like every other QL family. The cap is modeled like EulerSwap's inLimit:
 * estimateSwapIn quotes 0 past the tradeable cap, so the ladder self-truncates at the LIVE cap and the
 * awarded Σ is bounded by live capacity (the exec's estimateSwapIn amountOutMin re-reads the same live
 * state atomically).
 *
 * Sources (VERIFIED):
 *   https://github.com/Instadapp/fluid-contracts-public/blob/f8a93859822cbe7ca7b9bac076c5e81fe1fcadaf/contracts/protocols/dex/poolT1/coreModule/core/main.sol  (swapIn / FluidDexSwapResult / ADDRESS_DEAD estimate hook)
 *   https://github.com/Instadapp/fluid-contracts-public/blob/main/contracts/periphery/resolvers/dex/main.sol  (estimateSwapIn revert-decode; _decodeLowLevelUint1x → 0 on selector mismatch)
 *   https://docs.fluid.instadapp.io/integrate/dex-swaps.html  (integration guide — swapIn + resolver estimate())
 *   FluidDexT1 0x6d83f60eEac0e50A1250760151E81Db2a278e03a (Etherscan verified)
 */
import { buildQLLadder } from "./curve-math.js";
/** Fluid fee scale — feePpm is 1e6-scaled (0.01% = 100). */
export const FLUID_FEE_SCALE = 10n ** 6n;
/**
 * The DETERMINISTIC cumulative input grid the QL recurrence quotes at for a ladder capped at `cap`
 * (Fluid has no LB-style absorbed-capacity override, so the grid is exactly the shared geometric
 * ladder points). An early `q == 0` / non-descending stop consumes a PREFIX of this grid, so
 * prefetching quotes at exactly these points fully covers every `getDy` the ladder build can ask
 * for. Used by the prod-mirror (which has no closed form) to prefetch the REAL resolver's quotes;
 * for a DIRECT venue `cap == amountIn`. This IS `qlLadderInputs` (curve-math.ts) — the same grid
 * the Mento/Fermi/Wombat/DODO/Euler/BalV3 prod-mirrors prefetch at — re-exported under the Fluid
 * name for the prefetch contract's readability.
 */
export { qlLadderInputs as fluidQLGridInputs } from "./curve-math.js";
/**
 * Build one Fluid venue's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the venue's `getDy` quote model, so the oracle stays wei-exact with the
 * on-chain solver by construction. The solver builds the IDENTICAL geometric ladder live from
 * `resolver.estimateSwapIn(dex, swap0to1, xNext, 0)` (a graceful single-return CALL — 0 past the
 * utilization/borrow cap ⇒ the ladder self-truncates at the LIVE cap, the EulerSwap-inLimit class, with
 * NO separate cap read). estimateSwapIn is post-fee + post-cap, so marginalOI IS the execution price.
 * Emits the same {capacity, effOut, marginalOI} slices the merged sampled-segment stream consumes.
 */
export function buildFluidQLLadder(pool, amountIn) {
    return buildQLLadder((dx) => pool.getDy(dx), amountIn);
}
//# sourceMappingURL=fluid-math.js.map