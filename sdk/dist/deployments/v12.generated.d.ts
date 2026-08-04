/** CREATE2 salt the stack was deployed with. */
export declare const V12_SALT: "0x0000000000000000000000000000000000000000000000000000000000000001";
/** Which tool in the engine repo produced the underlying record. */
export declare const V12_GENERATED_BY: "dev-tools/scripts/deploy-v12.ts";
/** Chain-invariant EVM addresses (identical on every chain — see the note above). */
export declare const V12_EVM_CONTRACTS: {
    readonly router: "0x20BbEc03eE401B26938880cd23Aac00Cf927F06a";
    readonly v12Runtime: "0x3dfE79fBB6C62D00986F476c3F86E7D19E0cabeD";
    readonly v12Kitchen: "0xd57b452634c653D80A85160fea895BB07Ac41D8F";
};
/** Per-chain deploy outcome. `live` is the only field callers should gate on. */
export declare const V12_EVM_CHAINS: {
    readonly 1: {
        readonly name: "ethereum";
        readonly live: true;
        readonly status: "live";
    };
    readonly 10: {
        readonly name: "optimism";
        readonly live: true;
        readonly status: "live";
    };
    readonly 56: {
        readonly name: "bsc";
        readonly live: true;
        readonly status: "live";
    };
    readonly 130: {
        readonly name: "unichain";
        readonly live: true;
        readonly status: "live";
    };
    readonly 137: {
        readonly name: "polygon";
        readonly live: true;
        readonly status: "live";
    };
    readonly 146: {
        readonly name: "sonic";
        readonly live: true;
        readonly status: "live";
    };
    readonly 2020: {
        readonly name: "ronin";
        readonly live: false;
        readonly status: "failed";
        readonly error: "Contracts deployed with a Solidity version equal or higher than 0.8.20 might not work properly. For more information, please see https://eips.ethereum.org/EIPS/eip-3855 Error: Failed to send transacti";
    };
    readonly 8453: {
        readonly name: "base";
        readonly live: true;
        readonly status: "live";
    };
    readonly 9745: {
        readonly name: "plasma";
        readonly live: true;
        readonly status: "live";
    };
    readonly 42161: {
        readonly name: "arbitrum";
        readonly live: true;
        readonly status: "live";
    };
    readonly 42220: {
        readonly name: "celo";
        readonly live: true;
        readonly status: "live";
    };
    readonly 57073: {
        readonly name: "ink";
        readonly live: true;
        readonly status: "live";
    };
};
/** The SVM engine program (non-upgradeable when `upgradeable` is false). */
export declare const V12_SVM: {
    readonly programId: "CuHCniNMWLSkZWBQKon9tudGujZeXJRUwG2PCLDq4ipJ";
    readonly upgradeable: false;
    readonly clusters: {
        readonly devnet: {
            readonly cluster: "devnet";
            readonly status: "already-deployed";
        };
        readonly 'mainnet-beta': {
            readonly cluster: "mainnet-beta";
            readonly status: "already-deployed";
        };
    };
};
//# sourceMappingURL=v12.generated.d.ts.map