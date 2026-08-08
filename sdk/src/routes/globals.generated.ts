// GENERATED FILE — do not edit by hand.
//
// Written by sdk/scripts/gen-route-globals.mjs from src/chains/canonical.ts's
// CANONICAL_CHAINS. Regenerate with `node scripts/gen-route-globals.mjs` after
// a registry change; sdk/test/routes-globals-drift.test.ts fails CI on drift.
//
// Ambient only -- carries no runtime code (the runtime install lives in
// ./globals.ts, generated separately by enumerating `chainAccessors`). Typing
// each entry as `Accessors["<Name>"]` rather than spelling out
// `ChainOrigin<RouteInput, RewardInput>` buys a free structural cross-check:
// `ChainAccessors` is keyed by `PascalOf<ChainSlug>`, so a name that no longer
// exists in the registry fails `tsc` here before the drift test even runs.
import type { ChainAccessors } from "./builder.js";
import type { RewardInput, RouteInput } from "./types.js";

type Accessors = ChainAccessors<RouteInput, RewardInput>;

declare global {
  /** eco-routes origin accessor for Ethereum (chain id 1). */
  const Ethereum: Accessors["Ethereum"];
  /** eco-routes origin accessor for Optimism (chain id 10). */
  const Optimism: Accessors["Optimism"];
  /** eco-routes origin accessor for BNB Chain (chain id 56). */
  const Bsc: Accessors["Bsc"];
  /** eco-routes origin accessor for Polygon (chain id 137). */
  const Polygon: Accessors["Polygon"];
  /** eco-routes origin accessor for Base (chain id 8453). */
  const Base: Accessors["Base"];
  /** eco-routes origin accessor for Arbitrum One (chain id 42161). */
  const Arbitrum: Accessors["Arbitrum"];
  /** eco-routes origin accessor for Celo (chain id 42220). */
  const Celo: Accessors["Celo"];
  /** eco-routes origin accessor for Cronos (chain id 25). */
  const Cronos: Accessors["Cronos"];
  /** eco-routes origin accessor for Gnosis (chain id 100). */
  const Gnosis: Accessors["Gnosis"];
  /** eco-routes origin accessor for Fuse (chain id 122). */
  const Fuse: Accessors["Fuse"];
  /** eco-routes origin accessor for Manta Pacific (chain id 169). */
  const Manta: Accessors["Manta"];
  /** eco-routes origin accessor for opBNB (chain id 204). */
  const Opbnb: Accessors["Opbnb"];
  /** eco-routes origin accessor for Fantom (chain id 250). */
  const Fantom: Accessors["Fantom"];
  /** eco-routes origin accessor for Boba (chain id 288). */
  const Boba: Accessors["Boba"];
  /** eco-routes origin accessor for zkSync Era (chain id 324). */
  const Zksync: Accessors["Zksync"];
  /** eco-routes origin accessor for PulseChain (chain id 369). */
  const Pulsechain: Accessors["Pulsechain"];
  /** eco-routes origin accessor for Metis (chain id 1088). */
  const Metis: Accessors["Metis"];
  /** eco-routes origin accessor for Core (chain id 1116). */
  const Core: Accessors["Core"];
  /** eco-routes origin accessor for Moonbeam (chain id 1284). */
  const Moonbeam: Accessors["Moonbeam"];
  /** eco-routes origin accessor for Sei (chain id 1329). */
  const Sei: Accessors["Sei"];
  /** eco-routes origin accessor for Kava (chain id 2222). */
  const Kava: Accessors["Kava"];
  /** eco-routes origin accessor for Mantle (chain id 5000). */
  const Mantle: Accessors["Mantle"];
  /** eco-routes origin accessor for ZetaChain (chain id 7000). */
  const Zetachain: Accessors["Zetachain"];
  /** eco-routes origin accessor for Klaytn (chain id 8217). */
  const Klaytn: Accessors["Klaytn"];
  /** eco-routes origin accessor for Evmos (chain id 9001). */
  const Evmos: Accessors["Evmos"];
  /** eco-routes origin accessor for Mode (chain id 34443). */
  const Mode: Accessors["Mode"];
  /** eco-routes origin accessor for Avalanche C-Chain (chain id 43114). */
  const Avalanche: Accessors["Avalanche"];
  /** eco-routes origin accessor for Linea (chain id 59144). */
  const Linea: Accessors["Linea"];
  /** eco-routes origin accessor for Berachain (chain id 80094). */
  const Berachain: Accessors["Berachain"];
  /** eco-routes origin accessor for Blast (chain id 81457). */
  const Blast: Accessors["Blast"];
  /** eco-routes origin accessor for Scroll (chain id 534352). */
  const Scroll: Accessors["Scroll"];
  /** eco-routes origin accessor for Zora (chain id 7777777). */
  const Zora: Accessors["Zora"];
  /** eco-routes origin accessor for Aurora (chain id 1313161554). */
  const Aurora: Accessors["Aurora"];
  /** eco-routes origin accessor for Unichain (chain id 130). */
  const Unichain: Accessors["Unichain"];
  /** eco-routes origin accessor for Sonic (chain id 146). */
  const Sonic: Accessors["Sonic"];
  /** eco-routes origin accessor for Ronin (chain id 2020). */
  const Ronin: Accessors["Ronin"];
  /** eco-routes origin accessor for Plasma (chain id 9745). */
  const Plasma: Accessors["Plasma"];
  /** eco-routes origin accessor for Ink (chain id 57073). */
  const Ink: Accessors["Ink"];
  /** eco-routes origin accessor for Solana (chain id 1399811149). */
  const Solana: Accessors["Solana"];
  /** Runtime-resolved origin: `chain('eth')`, `chain(8453)`. */
  const chain: typeof import("./accessors.js").chain;
}

export {};
