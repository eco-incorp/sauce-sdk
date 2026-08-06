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
/** The three chain-invariant EVM contract addresses. */
export interface V12EvmContracts {
    /** Swap surface every Pot's fallback delegatecalls into. */
    router: string;
    /** The Huff interpreter runtime that executes Sauce bytecode. */
    v12Runtime: string;
    /** Factory — mint a Pot via `deployPot(owner, salt)`. */
    v12Kitchen: string;
}
/** One chain's deploy outcome, as recorded by the engine's deploy script. */
export interface V12ChainDeployment {
    chainId: number;
    /** Engine-side chain slug (e.g. `'base'`) — not necessarily the SDK's chain name. */
    name: string;
    /** The only field to gate on. False means the stack is NOT usable on this chain. */
    live: boolean;
    status: string;
    /** Present only for a failed deploy. */
    error?: string;
}
/** A resolved, usable deployment: the addresses plus which chain they are live on. */
export interface V12Deployment extends V12EvmContracts {
    chainId: number;
    name: string;
}
/** Every chain id in the record, live or not, ascending. */
export declare function v12ChainIds(): number[];
/** Chain ids where the stack is live and usable, ascending. */
export declare function v12LiveChainIds(): number[];
/** Chain ids present in the record whose deploy did NOT land. */
export declare function v12FailedChainIds(): number[];
/** True only when the stack is live on `chainId`. */
export declare function isV12Live(chainId: number): boolean;
/** The raw per-chain record (including a failed chain's `error`), or undefined if unknown. */
export declare function v12ChainDeployment(chainId: number): V12ChainDeployment | undefined;
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
export declare function v12ChainSlug(chainId: number): string | undefined;
/**
 * Every live v12 chain as a `chainId → slug` map, ascending — the direct
 * replacement for a hand-maintained slug constant. Excludes chains whose deploy
 * did not land (see {@link v12FailedChainIds}).
 */
export declare function v12LiveChainSlugs(): Record<number, string>;
/**
 * Addresses for `chainId`, or undefined when the stack is not live there.
 *
 * Returns undefined rather than the addresses for a non-live chain on purpose:
 * the addresses are chain-invariant, so they are non-null even where nothing is
 * deployed, and handing them back would point callers at empty accounts.
 */
export declare function v12Deployment(chainId: number): V12Deployment | undefined;
/** Like {@link v12Deployment}, but throws with the reason instead of returning undefined. */
export declare function requireV12Deployment(chainId: number): V12Deployment;
/** The SVM engine program id — pass as `programId` to `createSauceSvmClient`. */
export declare const v12SvmProgramId: string;
/** True if the SVM engine is deployed on `cluster` (`'devnet'` | `'mainnet-beta'`). */
export declare function isV12SvmDeployed(cluster: string): boolean;
//# sourceMappingURL=index.d.ts.map