// @eco-incorp/sauce-sdk/verify — the partner-consumable settle-program authenticity + intent
// surface. Dependency closure is `viem` ONLY (no node:fs, no ./compiler, no @solana/*, no
// artifact resolution, no template on disk) — see this package's docs for why that closure is
// load-bearing across BOTH install modes (registry and git-URL pin).
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
export { SETTLE_TEMPLATES, CURRENT_SETTLE_TEMPLATE, type TemplateEntry, type TemplateStatus } from "./template.js";
export { SETTLE_VECTORS, type ConformanceVector } from "./vectors.js";
export {
  inspectSettleProgram,
  verifySettleProgram,
  formatSettleReport,
  type CheckStatus,
  type CheckSeverity,
  type VerifyCheck,
  type EffectAmount,
  type SettleEffect,
  type Disclosure,
  type HashSource,
  type VerifyOpts,
  type SettleExpectation,
  type SettleReportEnvelope,
  type SettleInspection,
  type SettleReport,
} from "./report.js";
