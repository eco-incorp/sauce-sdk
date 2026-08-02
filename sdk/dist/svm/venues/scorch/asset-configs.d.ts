/**
 * Scorch mint -> AssetConfig account address directory.
 *
 * WHY THIS FILE EXISTS: the swap CPI (SCoRcH8c2d.../ROUTER) needs the two
 * per-mint AssetConfig accounts (owned by the core program ojh19oj...) as
 * fixed account-list entries, but their address is NEITHER embedded in the
 * PairConfig account NOR a PDA of any seed scheme this repo could recover
 * (tried ["asset_config", mint], ["asset_configv0", mint] and combined-string
 * variants against @solana/kit's getProgramDerivedAddress — none matched the
 * 19 real on-chain addresses; the program is closed-source with no IDL). The
 * addresses ARE stable, small in count, and independently ground-truthable via
 * a memcmp getProgramAccounts scan (owner=ojh19ojaKduoJZuaJADhcVGp4xt1TcdAvZmpVsCorch,
 * dataSize=592, mint stored at byte offset 16), so this repo vendors the
 * directory as a checked-in snapshot — the same pattern this repo already uses
 * for anvil-state blobs and prod-mirror pool dumps (CLAUDE.md's "recapture"
 * convention) — rather than resolving it live on every fetch.
 *
 * SELF-DROP ON MISS: fetchPoolConfig throws a named error for a pair whose
 * mint is absent here (a newly listed Scorch asset) — that ONE pool drops out
 * of discovery/compile until the snapshot is refreshed; every other venue and
 * every other Scorch pair is unaffected (venue-robustness: one missing entry
 * never kills a cook).
 *
 * RECAPTURE (whenever a new asset is listed on Scorch):
 *   1. getProgramAccounts ojh19ojaKduoJZuaJADhcVGp4xt1TcdAvZmpVsCorch filtered to
 *      dataSize=592 (base64 encoding);
 *   2. for each match, mint = the 32 bytes at data offset 16 (base58-encode);
 *   3. regenerate this file's SCORCH_ASSET_CONFIGS map (mint -> account pubkey).
 * Captured 2026-07-31 against mainnet-beta (19 entries).
 */
export declare const SCORCH_ASSET_CONFIGS: Record<string, string>;
//# sourceMappingURL=asset-configs.d.ts.map