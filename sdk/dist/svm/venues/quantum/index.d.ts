import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "quantum";
export declare const QUANTUM_PROGRAM_ID: Address<"QuaNtZsgYRe5Z9Bk4LZ4cTD9tbkVoyCNf1R2BN9bBDv">;
/**
 * The program's single global config account (one for every pool). Lived in
 * this venue's ladder module until the merge-decomposition ladders moved out;
 * it is a program address, not decomposition state, so it stays here.
 */
export declare const QUANTUM_GLOBAL: Address<"3JumrbigQRj9TqEuy5fKGPHsQ6zCTwqqfVGhFhyoEMqH">;
/** Exact pool account size (all 27 live mainnet pools). */
export declare const QUANTUM_POOL_SIZE = 2280;
export declare const OFF_MINT0 = 0;
export declare const OFF_MINT1 = 32;
export declare const OFF_VAULT0 = 64;
export declare const OFF_VAULT1 = 96;
export declare const OFF_RESERVE0 = 128;
export declare const OFF_RESERVE1 = 136;
export declare const OFF_SIDE0 = 144;
export declare const OFF_SIDE1 = 928;
export declare const OFF_DEC0 = 1760;
export declare const OFF_DEC1 = 1761;
export declare const OFF_LEVEL_COUNT = 1763;
export declare const SIDE_LEVELS = 0;
export declare const SIDE_LEVEL_STRIDE = 16;
export declare const SIDE_EXPIRY = 256;
export declare const SIDE_KINDS = 384;
/** Hard array bound inside a side struct (the venue's own index guard is < 17). */
export declare const QUANTUM_LEVEL_SLOTS = 16;
/** expirySlot is stored scaled by 1e4; the venue divides before comparing (.text 0x1058). */
export declare const EXPIRY_SCALE = 10000n;
/**
 * Shipped levels per direction. 16 is the venue's own array bound; all but 5
 * of the 27 live pools publish 5. The walk is a bounded loop (not unrolled),
 * so this costs three 16-entry arrays of slot locals, not 16x the fragment.
 */
export declare const QUANTUM_MAX_LEVELS = 16;
/** Level kinds the fragment implements: 1 = trapezoid (every live pool side). */
export declare const QUANTUM_KIND_TRAPEZOID = 1;
export interface QuantumLevel {
    /** Index within the side's level array — the venue's own prev-price index. */
    index: number;
}
export interface QuantumWindow {
    /** The walkable level prefix, in venue order (see the header's SHIPPED PREFIX). */
    levels: QuantumLevel[];
}
export interface QuantumPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'zeroIn' sells token0 for token1 (side1@928); 'oneIn' is the reverse (side0@144). */
    direction: 'zeroIn' | 'oneIn';
    mint0: Address;
    mint1: Address;
    vault0: Address;
    vault1: Address;
    dec0: number;
    dec1: number;
    levelCount: number;
    windows: {
        zeroIn: QuantumWindow;
        oneIn: QuantumWindow;
    };
}
/** Side-struct base offset for a direction (zeroIn reads side1, oneIn reads side0). */
export declare function quantumSideBase(direction: 'zeroIn' | 'oneIn'): number;
/** 10^decimals of the direction's OUTPUT token. */
export declare function quantumOutScale(cfg: QuantumPoolConfig): bigint;
/** The direction's output vault (whose live balance is the hard out cap). */
export declare function quantumOutVault(cfg: QuantumPoolConfig): Address;
/** The direction's input vault (the swap CPI's transfer destination). */
export declare function quantumInVault(cfg: QuantumPoolConfig): Address;
/** Cached out-reserve offset for the direction (the second half of the out cap). */
export declare function quantumOutReserveOffset(cfg: QuantumPoolConfig): number;
/**
 * Fetch + gate one Quantum pool and freeze both directions' walkable level
 * prefixes. Read-only against the loader.
 */
export declare function fetchQuantumConfig(load: AccountLoader, pool: Address): Promise<QuantumPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — not in the v1 registry). */
export declare const quantum: {
    slug: string;
    programId: Address<"QuaNtZsgYRe5Z9Bk4LZ4cTD9tbkVoyCNf1R2BN9bBDv">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchQuantumConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map