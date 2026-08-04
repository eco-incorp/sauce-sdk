// GENERATED FILE — do not edit by hand.
//
// Written by sdk/scripts/gen-engine-abi.mjs from the pinned `sauce` dep's
// svm/abi/engine-abi.json (itself generated from the engine's Rust constants and
// CI-asserted byte-equal to them). Run `pnpm --filter './sdk' sync-engine-artifacts`
// after a repin; CI regenerates and `git diff`s this, and engine-abi-drift.test.ts
// asserts every artifact key is mapped. See engine.ts for how it is consumed.
/** Structural mirror of svm/abi/engine-abi.json (minus `$comment`) — the drift test's ground truth. */
export const ENGINE_ABI = {
    "bufferHeaderBytes": 112,
    "bufferSeedBytes": 32,
    "bufferSeedPrefix": "buffer",
    "executeFlags": {
        "hasPin": 1,
        "hasSlice": 2
    },
    "headerFlags": {
        "finalized": 1
    },
    "headerOffsets": {
        "authority": 8,
        "bump": 1,
        "contentSha256": 48,
        "flags": 3,
        "kind": 0,
        "len": 40,
        "reservedHigh": 44,
        "reservedLow": 4,
        "reservedVersion": 2,
        "seed": 80
    },
    "instructions": [
        {
            "accounts": [
                "...user"
            ],
            "discriminator": "82ddf29a0dc1bd1d",
            "name": "execute",
            "payload": "raw bytecode (args may ride appended after the compiled STOP)"
        },
        {
            "accounts": [
                "code (READ-ONLY)",
                "...user"
            ],
            "discriminator": "712cd572829558c3",
            "name": "execute_from_account",
            "payload": "[flags: u8][pin: [u8;32] iff flags&0x01][offset: u32 LE ++ len: u32 LE iff flags&0x02][args…]"
        },
        {
            "accounts": [
                "buffer (WRITABLE)",
                "...user (must include the buffer authority: signer + writable)"
            ],
            "discriminator": "ebc4a85d5149f2a2",
            "name": "execute_and_close",
            "payload": "same grammar as execute_from_account"
        },
        {
            "accounts": [
                "payer (signer, writable)",
                "buffer (writable)",
                "system program"
            ],
            "discriminator": "7bd3e9d2a68bda3c",
            "name": "init_buffer",
            "payload": "seed: [u8;32] ++ capacity: u32 LE (exactly 36 bytes)"
        },
        {
            "accounts": [
                "authority (signer)",
                "buffer (writable)"
            ],
            "discriminator": "a4c2459a4ba9e455",
            "name": "write_buffer",
            "payload": "offset: u32 LE ++ chunk"
        },
        {
            "accounts": [
                "authority (signer)",
                "buffer (writable)"
            ],
            "discriminator": "219c88b114c37a43",
            "name": "finalize_buffer",
            "payload": "len: u32 LE ++ expected_sha256: [u8;32] (exactly 36 bytes)"
        },
        {
            "accounts": [
                "authority (signer, writable)",
                "buffer (writable)"
            ],
            "discriminator": "2e72b33a392dc2ac",
            "name": "close_buffer",
            "payload": "none"
        },
        {
            "accounts": [
                "authority (signer, writable)",
                "buffer (writable)"
            ],
            "discriminator": "f0bcb58fa204f587",
            "name": "close_buffer_checked",
            "payload": "expected_sha256: [u8;32] (exactly 32 bytes)"
        }
    ],
    "kindBuffer": 5,
    "maxBufferCapacity": 65535
};
// ── sizes / discriminants ──
export const BUFFER_HEADER_BYTES = 112;
export const BUFFER_SEED_BYTES = 32;
export const BUFFER_SEED = "buffer";
export const KIND_BUFFER = 5;
export const MAX_BUFFER_CAPACITY = 65535;
// ── header flags ──
export const FLAG_FINALIZED = 1;
// ── execute_from_account / execute_and_close payload flags ──
export const EXECUTE_FLAG_HAS_PIN = 1;
export const EXECUTE_FLAG_HAS_SLICE = 2;
// ── buffer header offsets ──
export const BUFFER_OFFSET_AUTHORITY = 8;
export const BUFFER_OFFSET_BUMP = 1;
export const BUFFER_OFFSET_CONTENT_SHA256 = 48;
export const BUFFER_OFFSET_FLAGS = 3;
export const BUFFER_OFFSET_KIND = 0;
export const BUFFER_OFFSET_LEN = 40;
export const BUFFER_OFFSET_RESERVED_HIGH = 44;
export const BUFFER_OFFSET_RESERVED_LOW = 4;
export const BUFFER_OFFSET_RESERVED_VERSION = 2;
export const BUFFER_OFFSET_SEED = 80;
// ── instruction discriminators (Anchor sha256("global:<name>")[..8]) ──
export const EXECUTE_DISCRIMINATOR = /* 82ddf29a0dc1bd1d */ new Uint8Array([0x82, 0xdd, 0xf2, 0x9a, 0x0d, 0xc1, 0xbd, 0x1d]);
export const EXECUTE_FROM_ACCOUNT_DISCRIMINATOR = /* 712cd572829558c3 */ new Uint8Array([0x71, 0x2c, 0xd5, 0x72, 0x82, 0x95, 0x58, 0xc3]);
export const EXECUTE_AND_CLOSE_DISCRIMINATOR = /* ebc4a85d5149f2a2 */ new Uint8Array([0xeb, 0xc4, 0xa8, 0x5d, 0x51, 0x49, 0xf2, 0xa2]);
export const INIT_BUFFER_DISCRIMINATOR = /* 7bd3e9d2a68bda3c */ new Uint8Array([0x7b, 0xd3, 0xe9, 0xd2, 0xa6, 0x8b, 0xda, 0x3c]);
export const WRITE_BUFFER_DISCRIMINATOR = /* a4c2459a4ba9e455 */ new Uint8Array([0xa4, 0xc2, 0x45, 0x9a, 0x4b, 0xa9, 0xe4, 0x55]);
export const FINALIZE_BUFFER_DISCRIMINATOR = /* 219c88b114c37a43 */ new Uint8Array([0x21, 0x9c, 0x88, 0xb1, 0x14, 0xc3, 0x7a, 0x43]);
export const CLOSE_BUFFER_DISCRIMINATOR = /* 2e72b33a392dc2ac */ new Uint8Array([0x2e, 0x72, 0xb3, 0x3a, 0x39, 0x2d, 0xc2, 0xac]);
export const CLOSE_BUFFER_CHECKED_DISCRIMINATOR = /* f0bcb58fa204f587 */ new Uint8Array([0xf0, 0xbc, 0xb5, 0x8f, 0xa2, 0x04, 0xf5, 0x87]);
//# sourceMappingURL=engine-abi.generated.js.map