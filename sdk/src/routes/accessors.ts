/**
 * Default-schema instantiation of the builder, generated from
 * `../chains/canonical.js` at module-eval time. Adding a chain to
 * `CANONICAL_CHAINS` adds an accessor here with zero code changes — see
 * `sdk/test/routes.test.ts`'s "accessor generation is registry-derived"
 * case for the proof.
 *
 * `PascalOf`/`pascalOfSlug` live in `builder.ts` (needed there for the
 * `DestinationSelectors`/`ChainAccessors` mapped types) and are re-exported
 * here so a caller only needs one import site for the whole `routes/`
 * surface, matching the module layout in the design doc.
 */
import type { CanonicalChain } from "../chains/canonical.js";
import { requireChain } from "../chains/canonical.js";
import {
  createChainAccessors,
  makeChainOrigin,
  pascalOfSlug,
  type ChainAccessors,
  type ChainOrigin,
  type PascalOf,
} from "./builder.js";
import { assembleIntent } from "./intent.js";
import type { RewardInput, RouteInput } from "./types.js";

export type { PascalOf };
export { pascalOfSlug };

/** The generated record: `const { Base, Solana, Ethereum } = chainAccessors;`. */
export const chainAccessors: ChainAccessors<RouteInput, RewardInput> =
  createChainAccessors(assembleIntent);

/**
 * Dynamic front door for a runtime-resolved chain (`chain('eth')`,
 * `chain(8453)`, `chain('BNB Chain')`) — delegates to `requireChain`, so it
 * inherits the registry's alias resolution and unknown-chain throw.
 */
export function chain(ref: number | string | CanonicalChain): ChainOrigin<RouteInput, RewardInput> {
  const resolved = requireChain(ref);
  return makeChainOrigin(resolved, assembleIntent);
}
