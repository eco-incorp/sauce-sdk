/** Structural mirror of svm/abi/engine-abi.json (minus `$comment`) — the drift test's ground truth. */
export declare const ENGINE_ABI: {
    readonly bufferHeaderBytes: 112;
    readonly bufferSeedBytes: 32;
    readonly bufferSeedPrefix: "buffer";
    readonly executeFlags: {
        readonly hasPin: 1;
        readonly hasSlice: 2;
    };
    readonly headerFlags: {
        readonly finalized: 1;
    };
    readonly headerOffsets: {
        readonly authority: 8;
        readonly bump: 1;
        readonly contentSha256: 48;
        readonly flags: 3;
        readonly kind: 0;
        readonly len: 40;
        readonly reservedHigh: 44;
        readonly reservedLow: 4;
        readonly reservedVersion: 2;
        readonly seed: 80;
    };
    readonly instructions: readonly [{
        readonly accounts: readonly ["...user"];
        readonly discriminator: "82ddf29a0dc1bd1d";
        readonly name: "execute";
        readonly payload: "raw bytecode (args may ride appended after the compiled STOP)";
    }, {
        readonly accounts: readonly ["code (READ-ONLY)", "...user"];
        readonly discriminator: "712cd572829558c3";
        readonly name: "execute_from_account";
        readonly payload: "[flags: u8][pin: [u8;32] iff flags&0x01][offset: u32 LE ++ len: u32 LE iff flags&0x02][args…]";
    }, {
        readonly accounts: readonly ["buffer (WRITABLE)", "...user (must include the buffer authority: signer + writable)"];
        readonly discriminator: "ebc4a85d5149f2a2";
        readonly name: "execute_and_close";
        readonly payload: "same grammar as execute_from_account";
    }, {
        readonly accounts: readonly ["payer (signer, writable)", "buffer (writable)", "system program"];
        readonly discriminator: "7bd3e9d2a68bda3c";
        readonly name: "init_buffer";
        readonly payload: "seed: [u8;32] ++ capacity: u32 LE (exactly 36 bytes)";
    }, {
        readonly accounts: readonly ["authority (signer)", "buffer (writable)"];
        readonly discriminator: "a4c2459a4ba9e455";
        readonly name: "write_buffer";
        readonly payload: "offset: u32 LE ++ chunk";
    }, {
        readonly accounts: readonly ["authority (signer)", "buffer (writable)"];
        readonly discriminator: "219c88b114c37a43";
        readonly name: "finalize_buffer";
        readonly payload: "len: u32 LE ++ expected_sha256: [u8;32] (exactly 36 bytes)";
    }, {
        readonly accounts: readonly ["authority (signer, writable)", "buffer (writable)"];
        readonly discriminator: "2e72b33a392dc2ac";
        readonly name: "close_buffer";
        readonly payload: "none";
    }, {
        readonly accounts: readonly ["authority (signer, writable)", "buffer (writable)"];
        readonly discriminator: "f0bcb58fa204f587";
        readonly name: "close_buffer_checked";
        readonly payload: "expected_sha256: [u8;32] (exactly 32 bytes)";
    }];
    readonly kindBuffer: 5;
    readonly maxBufferCapacity: 65535;
};
export declare const BUFFER_HEADER_BYTES = 112;
export declare const BUFFER_SEED_BYTES = 32;
export declare const BUFFER_SEED = "buffer";
export declare const KIND_BUFFER = 5;
export declare const MAX_BUFFER_CAPACITY = 65535;
export declare const FLAG_FINALIZED = 1;
export declare const EXECUTE_FLAG_HAS_PIN = 1;
export declare const EXECUTE_FLAG_HAS_SLICE = 2;
export declare const BUFFER_OFFSET_AUTHORITY = 8;
export declare const BUFFER_OFFSET_BUMP = 1;
export declare const BUFFER_OFFSET_CONTENT_SHA256 = 48;
export declare const BUFFER_OFFSET_FLAGS = 3;
export declare const BUFFER_OFFSET_KIND = 0;
export declare const BUFFER_OFFSET_LEN = 40;
export declare const BUFFER_OFFSET_RESERVED_HIGH = 44;
export declare const BUFFER_OFFSET_RESERVED_LOW = 4;
export declare const BUFFER_OFFSET_RESERVED_VERSION = 2;
export declare const BUFFER_OFFSET_SEED = 80;
export declare const EXECUTE_DISCRIMINATOR: Uint8Array<ArrayBuffer>;
export declare const EXECUTE_FROM_ACCOUNT_DISCRIMINATOR: Uint8Array<ArrayBuffer>;
export declare const EXECUTE_AND_CLOSE_DISCRIMINATOR: Uint8Array<ArrayBuffer>;
export declare const INIT_BUFFER_DISCRIMINATOR: Uint8Array<ArrayBuffer>;
export declare const WRITE_BUFFER_DISCRIMINATOR: Uint8Array<ArrayBuffer>;
export declare const FINALIZE_BUFFER_DISCRIMINATOR: Uint8Array<ArrayBuffer>;
export declare const CLOSE_BUFFER_DISCRIMINATOR: Uint8Array<ArrayBuffer>;
export declare const CLOSE_BUFFER_CHECKED_DISCRIMINATOR: Uint8Array<ArrayBuffer>;
//# sourceMappingURL=engine-abi.generated.d.ts.map