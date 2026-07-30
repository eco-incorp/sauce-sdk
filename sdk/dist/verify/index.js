// @eco-incorp/sauce-sdk/verify — the partner-consumable settle-program authenticity + intent
// surface. Dependency closure is `viem` ONLY (no node:fs, no ./compiler, no @solana/*, no
// artifact resolution, no template on disk) — see this package's docs for why that closure is
// load-bearing across BOTH install modes (registry and git-URL pin).
export { SETTLE_WIRE, scanMinimalPush, encodeMinimalPush } from "./wire.js";
export { decodeSettleProgram, encodeSettleProgram, parseSettleProgram, bestEffortDecode, SettleDecodeError, } from "./decode.js";
export { SETTLE_TEMPLATES, CURRENT_SETTLE_TEMPLATE } from "./template.js";
export { SETTLE_VECTORS } from "./vectors.js";
export { inspectSettleProgram, verifySettleProgram, formatSettleReport, } from "./report.js";
//# sourceMappingURL=index.js.map