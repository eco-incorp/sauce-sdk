import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "invariant";
export declare const INVARIANT_PROGRAM_ID: Address<"HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt">;
export declare const POOL_ACCOUNT_SIZE = 400;
/** sha256('account:Pool')[0..8]. */
export declare const POOL_DISCRIMINATOR: number[];
/** sha256('account:Tick')[0..8]. */
export declare const TICK_DISCRIMINATOR: number[];
export declare const TICK_ACCOUNT_SIZE = 150;
export declare const TICKMAP_ACCOUNT_SIZE: number;
/** Shipped boundaries per direction — one ACCOUNT per boundary (no shared tick-array amortization). */
export declare const INVARIANT_MAX_BOUNDARIES = 3;
export declare function invariantSqrtPriceAtTick(tickIndex: number): bigint;
export declare function invariantDeltaX(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, up: boolean): bigint;
export declare function invariantDeltaY(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, up: boolean): bigint;
/** get_next_sqrt_price_x_up(price, liquidity, amount, add=true) — the ONLY branch a by-amount-in ladder ever needs. */
export declare function invariantNextSqrtXUp(price: bigint, liquidity: bigint, amount: bigint): bigint;
/** get_next_sqrt_price_y_down(price, liquidity, amount, add=true). */
export declare function invariantNextSqrtYDown(price: bigint, liquidity: bigint, amount: bigint): bigint;
export interface InvariantSwapStep {
    nextSqrt: bigint;
    amountIn: bigint;
    amountOut: bigint;
    feeAmount: bigint;
}
/**
 * compute_swap_step (math.rs), BY-AMOUNT-IN ONLY (the merge ladder never
 * quotes by-amount-out). `xToY` is derived exactly like the Rust source
 * (`current_price_sqrt >= target_price_sqrt`).
 */
export declare function invariantComputeSwapStepIn(currentSqrt: bigint, targetSqrt: bigint, liquidity: bigint, amount: bigint, fee: bigint): InvariantSwapStep;
export interface InvariantBoundary {
    tick: number;
    sqrtPrice: bigint;
    address: Address;
}
export interface InvariantWindow {
    boundaries: InvariantBoundary[];
}
export interface InvariantPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    direction: 'xToY' | 'yToX';
    tokenXMint: Address;
    tokenYMint: Address;
    tokenXReserve: Address;
    tokenYReserve: Address;
    tickmap: Address;
    windows: {
        xToY: InvariantWindow;
        yToX: InvariantWindow;
    };
}
/** Fetch + decode one Invariant Pool and freeze both directions' boundary windows. Read-only against the loader. */
export declare function fetchInvariantPoolConfig(load: AccountLoader, pool: Address): Promise<InvariantPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm). */
export declare const invariant: {
    slug: string;
    programId: Address<"HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchInvariantPoolConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map