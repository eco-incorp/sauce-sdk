// @eco-incorp/sauce-sdk/verify — the partner-consumable settle-program authenticity + intent
// surface. Dependency closure is `viem` ONLY (no node:fs, no ./compiler, no @solana/*, no
// artifact resolution, no template on disk) — see this package's docs for why that closure is
// load-bearing across BOTH install modes (registry and git-URL pin).
export { SETTLE_WIRE, scanMinimalPush, encodeMinimalPush } from "./wire.js";
export { decodeSettleProgram, encodeSettleProgram, parseSettleProgram, bestEffortDecode, SettleDecodeError, } from "./decode.js";
export { SETTLE_TEMPLATES, CURRENT_SETTLE_TEMPLATE } from "./template.js";
export { SETTLE_VECTORS } from "./vectors.js";
export { inspectSettleProgram, verifySettleProgram, formatSettleReport, } from "./report.js";
// NOTE: `./internal/root-testing.js` is deliberately NOT re-exported here — see its own header
// doc. The only way to reach `authenticateBodyAgainstRoot` is a relative import of that file
// itself (as `sdk/test/verify.test.ts` does), never a package subpath.
//# sourceMappingURL=index.js.map