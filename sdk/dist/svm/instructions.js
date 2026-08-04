import { AccountRole } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { BUFFER_HEADER_BYTES, BUFFER_SEED_BYTES, BUFFER_WRITE_CHUNK_BYTES, CLOSE_BUFFER_CHECKED_DISCRIMINATOR, CLOSE_BUFFER_DISCRIMINATOR, EXECUTE_AND_CLOSE_DISCRIMINATOR, EXECUTE_DISCRIMINATOR, EXECUTE_FLAG_HAS_PIN, EXECUTE_FLAG_HAS_SLICE, EXECUTE_FROM_ACCOUNT_DISCRIMINATOR, FINALIZE_BUFFER_DISCRIMINATOR, INIT_BUFFER_DISCRIMINATOR, MAX_BUFFER_CAPACITY, PDA_GROWTH_STEP, WRITE_BUFFER_DISCRIMINATOR, } from './engine.js';
function assertSeed(seed, name) {
    if (!(seed instanceof Uint8Array) || seed.length !== BUFFER_SEED_BYTES) {
        const got = seed instanceof Uint8Array ? `${seed.length} bytes` : 'a non-Uint8Array';
        throw new Error(`${name} must be exactly ${BUFFER_SEED_BYTES} bytes, got ${got}`);
    }
}
function assertU32(value, name) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new Error(`${name} must be a u32 (0-4294967295), got ${value}`);
    }
}
function u32Le(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
}
function concatBytes(...parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
function withDiscriminator(discriminator, ...parts) {
    const total = discriminator.length + parts.reduce((n, p) => n + p.length, 0);
    const data = new Uint8Array(total);
    data.set(discriminator, 0);
    let offset = discriminator.length;
    for (const part of parts) {
        data.set(part, offset);
        offset += part.length;
    }
    return data;
}
/**
 * Builds the engine execute instruction. The account list IS the user-account
 * index space: accounts[i] is user index i (no fixed prefix — interpreter
 * memory lives in the transaction's heap frame, not accounts). MSG_SENDER is
 * the first in-list signer, resolved LAZILY: a signerless list is valid unless
 * the program reads MSG_SENDER/TX_ORIGIN (NoSigner then). Every transaction
 * carrying this instruction MUST also carry RequestHeapFrame(262144) — see
 * buildHeapFramePrepend.
 */
export function buildExecuteInstruction({ programId, bytecode, accounts }) {
    return {
        programAddress: programId,
        accounts: [...accounts],
        data: withDiscriminator(EXECUTE_DISCRIMINATOR, bytecode),
    };
}
/**
 * Encodes the shared execute_from_account / execute_and_close payload grammar:
 * `[flags: u8][pin: 32B iff 0x01][offset: u32 LE ++ len: u32 LE iff 0x02][args…]`.
 * The flags byte is REQUIRED — an empty payload is InvalidInstruction — so the
 * minimal pinless, sliceless, argless payload is `[0x00]`.
 */
function encodeExecutePayload(expectedSha256, slice, args) {
    if (expectedSha256 !== undefined && expectedSha256.length !== 32) {
        throw new Error(`expectedSha256 must be exactly 32 bytes, got ${expectedSha256.length}`);
    }
    if (slice !== undefined) {
        assertU32(slice.offset, 'slice offset');
        assertU32(slice.len, 'slice len');
    }
    let flags = 0x00;
    if (expectedSha256 !== undefined)
        flags |= EXECUTE_FLAG_HAS_PIN;
    if (slice !== undefined)
        flags |= EXECUTE_FLAG_HAS_SLICE;
    return concatBytes([flags], expectedSha256 ?? new Uint8Array(0), 
    // Order matters: pin precedes the slice, both precede args (engine grammar).
    slice === undefined ? new Uint8Array(0) : concatBytes(u32Le(slice.offset), u32Le(slice.len)), args ?? new Uint8Array(0));
}
/**
 * Builds the staged/foreign execute instruction. Account order is
 * [code (read-only), ...user] — the code account rides FIRST so the user tail
 * (and every account index baked into compiled bytecode) is byte-identical to
 * inline execute's list. The engine dispatches on the ACCOUNT (engine-owned +
 * header-parseable ⇒ managed; anything else ⇒ foreign), never on a payload flag.
 */
export function buildExecuteFromAccountInstruction({ programId, buffer, accounts, expectedSha256, slice, args, }) {
    return {
        programAddress: programId,
        accounts: [{ address: buffer, role: AccountRole.READONLY }, ...accounts],
        data: withDiscriminator(EXECUTE_FROM_ACCOUNT_DISCRIMINATOR, encodeExecutePayload(expectedSha256, slice, args)),
    };
}
/**
 * Builds execute_and_close: run a managed buffer and reap it (drain rent to the
 * authority, resize to 0, reassign to system) in ONE atomic instruction. Use this
 * instead of an execute_from_account + close_buffer pair: the execute needs the
 * buffer read-only and the close needs it writable, and account writability is a
 * transaction-level property — so the pair can never share a transaction. The
 * fixed prefix stays ONE account (buffer), so baked account indices agree with
 * execute_from_account. No slice: managed only.
 */
export function buildExecuteAndCloseInstruction({ programId, buffer, accounts, expectedSha256, args, }) {
    return {
        programAddress: programId,
        accounts: [{ address: buffer, role: AccountRole.WRITABLE }, ...accounts],
        data: withDiscriminator(EXECUTE_AND_CLOSE_DISCRIMINATOR, encodeExecutePayload(expectedSha256, undefined, args)),
    };
}
/**
 * Builds the create-then-grow init sequence for a bytecode buffer. Capacity
 * ≤ ~10,128 is one instruction; a 16 KB buffer is 2 — all packable into one
 * transaction. Payload is `seed[32] ++ capacity u32 LE` (exactly 36 bytes) on
 * every step (the engine grows toward BUFFER_HEADER_BYTES + capacity per
 * invocation; at/above target is a no-op). The seed is fixed across steps — the
 * engine records it once at create and rejects a mismatch thereafter.
 */
export function buildInitBufferInstructions({ programId, payer, buffer, seed, capacity, currentBytes = 0, }) {
    assertSeed(seed, 'buffer seed');
    if (!Number.isInteger(capacity) || capacity <= 0 || capacity > MAX_BUFFER_CAPACITY) {
        throw new Error(`buffer capacity must be 1-${MAX_BUFFER_CAPACITY} bytes, got ${capacity}`);
    }
    const targetBytes = BUFFER_HEADER_BYTES + capacity;
    const steps = Math.ceil(Math.max(0, targetBytes - currentBytes) / PDA_GROWTH_STEP);
    // Fresh objects per step, with fresh data arrays, so mutating one returned
    // instruction cannot corrupt the others.
    return Array.from({ length: steps }, () => ({
        programAddress: programId,
        accounts: [
            { address: payer, role: AccountRole.WRITABLE_SIGNER },
            { address: buffer, role: AccountRole.WRITABLE },
            { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        ],
        data: withDiscriminator(INIT_BUFFER_DISCRIMINATOR, seed, u32Le(capacity)),
    }));
}
export function buildWriteBufferInstruction({ programId, authority, buffer, offset, chunk }) {
    return {
        programAddress: programId,
        accounts: [
            { address: authority, role: AccountRole.READONLY_SIGNER },
            { address: buffer, role: AccountRole.WRITABLE },
        ],
        data: withDiscriminator(WRITE_BUFFER_DISCRIMINATOR, u32Le(offset), chunk),
    };
}
export function buildFinalizeBufferInstruction({ programId, authority, buffer, length, sha256 }) {
    if (sha256.length !== 32)
        throw new Error(`sha256 must be exactly 32 bytes, got ${sha256.length}`);
    return {
        programAddress: programId,
        accounts: [
            { address: authority, role: AccountRole.READONLY_SIGNER },
            { address: buffer, role: AccountRole.WRITABLE },
        ],
        data: withDiscriminator(FINALIZE_BUFFER_DISCRIMINATOR, u32Le(length), sha256),
    };
}
export function buildCloseBufferInstruction({ programId, authority, buffer }) {
    return {
        programAddress: programId,
        accounts: [
            { address: authority, role: AccountRole.WRITABLE_SIGNER },
            { address: buffer, role: AccountRole.WRITABLE },
        ],
        data: CLOSE_BUFFER_DISCRIMINATOR.slice(),
    };
}
/** Builds close_buffer_checked — close only if the content hash still matches. */
export function buildCloseBufferCheckedInstruction({ programId, authority, buffer, expectedSha256, }) {
    if (expectedSha256.length !== 32)
        throw new Error(`expectedSha256 must be exactly 32 bytes, got ${expectedSha256.length}`);
    return {
        programAddress: programId,
        accounts: [
            { address: authority, role: AccountRole.WRITABLE_SIGNER },
            { address: buffer, role: AccountRole.WRITABLE },
        ],
        data: withDiscriminator(CLOSE_BUFFER_CHECKED_DISCRIMINATOR, expectedSha256),
    };
}
/** Mirrors the engine's staging protocol batching (spec §2.5/§6.3). */
export function buildStagingPlan(bytecodeLength, chunkBytes = BUFFER_WRITE_CHUNK_BYTES) {
    if (!Number.isInteger(bytecodeLength) || bytecodeLength <= 0 || bytecodeLength > MAX_BUFFER_CAPACITY) {
        throw new Error(`bytecode length must be 1-${MAX_BUFFER_CAPACITY} bytes, got ${bytecodeLength}`);
    }
    if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
        throw new Error(`chunk size must be a positive integer, got ${chunkBytes}`);
    }
    const chunks = [];
    for (let offset = 0; offset < bytecodeLength; offset += chunkBytes) {
        chunks.push({ offset, length: Math.min(chunkBytes, bytecodeLength - offset) });
    }
    const initInstructionCount = Math.ceil((BUFFER_HEADER_BYTES + bytecodeLength) / PDA_GROWTH_STEP);
    return {
        capacity: bytecodeLength,
        initInstructionCount,
        chunks,
        transactions: { init: 1, writes: chunks.length, finalize: 1, execute: 1, total: 1 + chunks.length + 2 },
    };
}
//# sourceMappingURL=instructions.js.map