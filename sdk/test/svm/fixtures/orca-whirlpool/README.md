# orca-whirlpool fixtures

Mainnet dump of the Orca SOL/USDC 0.04% whirlpool (tick_spacing 4) and its
swap-window satellites, one account per JSON file in the standard
`{ address, owner, base64Data }` shape.

- **Snapshot slot 431094837** (2026-07-06, one `getMultipleAccounts` call via
  the public mainnet RPC — every account in this set is from that single
  slot). The two mint files were fetched separately at slot 431097707 (mints
  are effectively immutable).
- Pool `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE`: 653 bytes, at the
  snapshot sqrt_price 5244461737044097829, tick_current_index -25156,
  liquidity 832740502930995, fee_rate 400 (0.04%), fee_tier_index 4 (static
  tier), reward_last_updated_timestamp 1783313301.
- Tick arrays (FixedTickArray, 9988 bytes, 88/88 ticks initialized — the
  pool's spacing-4 grid is fully dense near spot): start indexes -26048,
  -25696, -25344 (the aToB window), -24992, -24640 (the bToA tail). PDAs are
  `['tick_array', whirlpool, ascii(start)]`.
- Vaults: WSOL `EUuU...5he9` (amount 189369944712673), USDC `2WLW...SUVP`
  (amount 10344272248003).
- The oracle PDA `FoKY...9PGTX` is uninitialized on mainnet (static-fee pool)
  and deliberately not part of the set.

Re-dump with the scratch script used originally (derives the window PDAs from
the live tick and writes this directory):

```sh
node dump-orca-whirlpool.mjs sdk/test/svm/fixtures/orca-whirlpool
```

(any getMultipleAccounts-equivalent works — keep ONE slot for the whole set,
record it here, and re-pin the worked examples in
`test/svm/venues/orca-whirlpool.test.ts` from an independent port of the
whirlpool sources, per that suite's header).
