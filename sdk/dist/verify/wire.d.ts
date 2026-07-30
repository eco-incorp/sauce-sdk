/** Wire-format constants for the `ecoswap-settle` v12 program shape. All values measured against
 *  the compiler's actual emission (`@eco-incorp/sauce-sdk/compiler` at this package's pin) —
 *  none of these are arbitrary choices. */
export declare const SETTLE_WIRE: {
    /** The compiler's TUPLE-build opcode. Not a legal PUSH width (`0x94 > 0x20`), which is exactly
     *  what lets a linear scan know where the leading token-push run ends. */
    readonly TUPLE_OP: 148;
    /** Smallest legal PUSH opcode — a 1-byte value. */
    readonly PUSH_MIN: 1;
    /** Largest legal PUSH opcode — a 32-byte (uint256) value. */
    readonly PUSH_MAX: 32;
    /** The TUPLE arity byte is a single raw byte (not itself a push), so it tops out at 255. */
    readonly MAX_ARITY: 255;
    /** An address is 20 bytes; token and recipient pushes must not exceed this width even though
     *  the PUSH opcode alone would allow up to 32 (see OVERSIZE_ADDRESS in decode.ts). */
    readonly ADDRESS_BYTES: 20;
};
/** Result of scanning one PUSH at a given offset. `ok:false` carries enough detail for a caller
 *  to render a precise failure without re-scanning. */
export type PushScanResult = {
    ok: true;
    value: bigint;
    offset: number;
    width: number;
    next: number;
} | {
    ok: false;
    code: "TRUNCATED_PUSH" | "NON_MINIMAL_PUSH" | "OVERSIZE_ADDRESS";
    offset: number;
    message: string;
};
/**
 * Scan ONE minimal-length integer PUSH at `pos` — §2 of the wire spec.
 *
 * A push is `L || data[L]` where `0x01 <= L <= 0x20`; the opcode byte IS the width. The encoder
 * is minimal-length: `L` is the smallest width holding the value, with the single exception that
 * `value === 0` encodes as `L=1, data=0x00` (never a bare zero-width opcode — there is no such
 * thing on this wire).
 *
 * `maxWidthBytes` additionally caps `L` (pass `SETTLE_WIRE.ADDRESS_BYTES` for token/recipient
 * slots, `SETTLE_WIRE.PUSH_MAX` — i.e. no extra cap beyond the opcode's own range — for `minOut`).
 * This is the STRICT/canonical scanner: it enforces minimality and the width cap unconditionally,
 * which is the behavior a partner-facing decoder must have (see decode.ts's module docstring,
 * §6 of the wire spec, for why: today's in-repo decoder in the recipes package predates this
 * package and does NOT make these checks — this scanner is the corrected replacement).
 *
 * Returns `ok:false` rather than throwing so callers can build a full checks report even when a
 * scan fails partway through.
 */
export declare function scanMinimalPush(bytes: Uint8Array, pos: number, maxWidthBytes?: number): PushScanResult;
/** Encode one value as a minimal-length PUSH — the exact inverse of `scanMinimalPush`. Throws if
 *  `value` needs more than `maxWidthBytes` bytes (never silently truncates). */
export declare function encodeMinimalPush(value: bigint, maxWidthBytes?: number): Uint8Array;
//# sourceMappingURL=wire.d.ts.map