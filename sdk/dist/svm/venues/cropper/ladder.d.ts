import { whirlpoolSqrtPriceAtTick } from '../orca-whirlpool/tick-math.js';
import type { SvmVenueLadder } from '../types.js';
import { CROPPER_MAX_BOUNDARIES } from './index.js';
export { whirlpoolSqrtPriceAtTick, CROPPER_MAX_BOUNDARIES };
/** TS mirror of wpDA. */
export declare function cropperDeltaA(l: bigint, lo: bigint, hi: bigint, roundUp: boolean): bigint;
/** TS mirror of wpDB. */
export declare function cropperDeltaB(l: bigint, lo: bigint, hi: bigint, roundUp: boolean): bigint;
/** TS mirror of wpNxA. */
export declare function cropperNextSqrtA(sp: bigint, l: bigint, amt: bigint): bigint;
export declare const cropperLadder: SvmVenueLadder;
//# sourceMappingURL=ladder.d.ts.map