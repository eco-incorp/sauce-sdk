// @eco-incorp/sauce-sdk/verify — turn a compiled Sauce program's bytes back into the input params it
// was compiled with: `(tokens, minOut, recipient)`.
//
// That is the whole job. Dependency closure is `viem` ONLY (no node:fs, no ./compiler, no
// @solana/*, no artifact resolution, no program source on disk), so this surface is safe to import
// anywhere — including a browser or an edge runtime.
//
// SCOPE, stated plainly: this decodes the PROLOGUE. It tells you which tokens, floor and recipient a
// program carries, and it is strict about the encoding (every push minimal-length, addresses capped
// at 20 bytes, a zero recipient rejected), so an accepted program is the UNIQUE byte encoding of the
// values it decodes to. It does NOT tell you the trailing body is a program you have audited — a
// prologue-shaped program can carry anything after it. If you need that guarantee, compile the
// program from source yourself and byte-compare (see `@eco-incorp/sauce-sdk/programs`), which is a
// direct check against source you can read rather than a hash pinned in a table.
export { SETTLE_WIRE, scanMinimalPush, encodeMinimalPush, type PushScanResult } from "./wire.js";
export {
  decodeSettleProgram,
  encodeSettleProgram,
  parseSettleProgram,
  bestEffortDecode,
  SettleDecodeError,
  type DecodedSettleProgram,
  type SettleFailureCode,
  type SettleParse,
  type Address20,
} from "./decode.js";
export { SETTLE_VECTORS, type ConformanceVector } from "./vectors.js";
