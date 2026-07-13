function hexToBytes(hex) {
    const h = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h))
        throw new Error(`invalid hex bytes value: ${hex}`);
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}
/** Encodes one runtime value against its layout slot (scalar → 32B BE word, bytes → raw). */
export function encodeArgSlot(slot, value) {
    if (slot.kind === 'scalar') {
        if (typeof value !== 'bigint') {
            throw new Error(`arg ${slot.arg} is a scalar slot; got ${Array.isArray(value) ? 'array' : typeof value}`);
        }
        if (value < 0n || value >= 1n << 256n)
            throw new Error(`arg ${slot.arg} out of u256 range`);
        const bytes = new Uint8Array(32);
        let v = value;
        for (let i = 31; i >= 0 && v > 0n; i--) {
            bytes[i] = Number(v & 0xffn);
            v >>= 8n;
        }
        return bytes;
    }
    if (typeof value !== 'string') {
        throw new Error(`arg ${slot.arg} is a bytes slot; got ${Array.isArray(value) ? 'array' : typeof value}`);
    }
    const bytes = hexToBytes(value);
    if (bytes.length !== slot.length) {
        throw new Error(`arg ${slot.arg} bytes length ${bytes.length} does not match the compiled slot length ${slot.length}`);
    }
    return bytes;
}
/**
 * Encodes the full payload-args tail against the compile's argsLayout: slot i's
 * bytes land at exactly layout.slots[i].offset, back to back — the compiled
 * prologue's baked SLICE offsets leave no room for drift, so any layout/value
 * mismatch throws instead of producing silently shifted reads.
 */
export function encodePayloadArgs(layout, values) {
    if (values.length !== layout.slots.length) {
        throw new Error(`argsLayout has ${layout.slots.length} slots but ${values.length} values were provided`);
    }
    const payload = new Uint8Array(layout.byteLength);
    let offset = 0;
    layout.slots.forEach((slot, i) => {
        if (slot.offset !== offset) {
            throw new Error(`argsLayout slot ${i} offset ${slot.offset} does not match the packed position ${offset}`);
        }
        const bytes = encodeArgSlot(slot, values[i]);
        payload.set(bytes, offset);
        offset += bytes.length;
    });
    if (offset !== layout.byteLength) {
        throw new Error(`argsLayout byteLength ${layout.byteLength} does not match the packed length ${offset}`);
    }
    return payload;
}
//# sourceMappingURL=args.js.map