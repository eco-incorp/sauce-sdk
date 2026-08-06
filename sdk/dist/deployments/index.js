/**
 * WHERE THE DEPLOYED SAUCE v12 STACK LIVES.
 *
 * The package already shipped the engine's ABIs (`sdk/dist/artifacts/`) and the
 * v12 runtime creation code, but not the ADDRESSES of the deployed contracts —
 * so a consumer could encode a call and had nowhere to send it, and
 * `createSauceSvmClient` (which takes a required `programId`) had no default to
 * offer. This module closes that: the addresses come from the pinned engine's
 * own deploy record, vendored by `pnpm --filter './sdk' sync-engine-artifacts`
 * into `v12.generated.ts`, so they cannot drift from the pinned engine.
 *
 * The EVM addresses are CREATE2-deterministic — factory + salt + initcode only,
 * with no deployer or nonce in the preimage — so they are IDENTICAL on every
 * chain. That is why this exposes one flat address set plus per-chain liveness
 * rather than repeating the same three addresses twelve times. Do not read that
 * as "the stack is live everywhere": liveness is per chain, and one chain in the
 * record is not live (see `v12FailedChainIds`).
 */
import { V12_EVM_CHAINS, V12_EVM_CONTRACTS, V12_GENERATED_BY, V12_SALT, V12_SVM } from './v12.generated.js';
export { V12_EVM_CHAINS, V12_EVM_CONTRACTS, V12_GENERATED_BY, V12_SALT, V12_SVM };
const CHAINS = V12_EVM_CHAINS;
/** Every chain id in the record, live or not, ascending. */
export function v12ChainIds() {
    return Object.keys(CHAINS)
        .map(Number)
        .sort((a, b) => a - b);
}
/** Chain ids where the stack is live and usable, ascending. */
export function v12LiveChainIds() {
    return v12ChainIds().filter((id) => CHAINS[id].live);
}
/** Chain ids present in the record whose deploy did NOT land. */
export function v12FailedChainIds() {
    return v12ChainIds().filter((id) => !CHAINS[id].live);
}
/** True only when the stack is live on `chainId`. */
export function isV12Live(chainId) {
    return CHAINS[chainId]?.live === true;
}
/** The raw per-chain record (including a failed chain's `error`), or undefined if unknown. */
export function v12ChainDeployment(chainId) {
    const c = CHAINS[chainId];
    return c === undefined ? undefined : { chainId, ...c };
}
/**
 * The Sauce Recipes API chain slug (its `chain=` query param, e.g. `'base'`) for
 * `chainId`, or undefined when the v12 stack is not live there.
 *
 * The slug IS the engine-side chain name from the pinned deploy record, which by
 * construction equals the API's pool-config key — both derive from the same
 * `deployments/v12.json` `evm.chains` id map — so a consumer can gate provider
 * capability AND build the API URL from ONE source, with no hand-maintained
 * chainId→slug table to drift (and go stale the next time a chain is added).
 * Gated on `live` for the same reason as {@link v12Deployment}: a chain with no
 * Kitchen has no Pot to cook on, so emitting a slug there would misreport a
 * permanent deployment gap as a servable route.
 */
export function v12ChainSlug(chainId) {
    const c = CHAINS[chainId];
    return c === undefined || !c.live ? undefined : c.name;
}
/**
 * Every live v12 chain as a `chainId → slug` map, ascending — the direct
 * replacement for a hand-maintained slug constant. Excludes chains whose deploy
 * did not land (see {@link v12FailedChainIds}).
 */
export function v12LiveChainSlugs() {
    const out = {};
    for (const id of v12LiveChainIds())
        out[id] = CHAINS[id].name;
    return out;
}
/**
 * Addresses for `chainId`, or undefined when the stack is not live there.
 *
 * Returns undefined rather than the addresses for a non-live chain on purpose:
 * the addresses are chain-invariant, so they are non-null even where nothing is
 * deployed, and handing them back would point callers at empty accounts.
 */
export function v12Deployment(chainId) {
    const c = CHAINS[chainId];
    if (c === undefined || !c.live)
        return undefined;
    return { chainId, name: c.name, ...V12_EVM_CONTRACTS };
}
/** Like {@link v12Deployment}, but throws with the reason instead of returning undefined. */
export function requireV12Deployment(chainId) {
    const found = v12Deployment(chainId);
    if (found !== undefined)
        return found;
    const c = CHAINS[chainId];
    if (c === undefined) {
        throw new Error(`Sauce v12 is not deployed on chain ${chainId} (known chains: ${v12ChainIds().join(', ')})`);
    }
    throw new Error(`Sauce v12 is not live on chain ${chainId} (${c.name}): status '${c.status}'` +
        (c.error === undefined ? '' : ` — ${c.error}`));
}
/** The SVM engine program id — pass as `programId` to `createSauceSvmClient`. */
export const v12SvmProgramId = V12_SVM.programId;
/** True if the SVM engine is deployed on `cluster` (`'devnet'` | `'mainnet-beta'`). */
export function isV12SvmDeployed(cluster) {
    return Object.prototype.hasOwnProperty.call(V12_SVM.clusters, cluster);
}
//# sourceMappingURL=index.js.map