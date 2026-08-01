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