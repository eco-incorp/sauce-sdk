# manifest fixtures

Mainnet dump of the Manifest SOL/USDC CLOB market and its two vaults, one
account per JSON file in the standard `{ address, owner, base64Data }` shape.

- **Snapshot 2026-07-06** (public mainnet RPC). The whole order book lives in
  the ONE market account, so this single dump carries the full bid/ask depth
  the worked examples price against.
- Market `ENhU8LsaR7vDD2G1CsWcsuSGNrih9Cv5WZEk7q9kPapQ`: 238,896 bytes
  (`MarketFixed` 256 + a 238,640-byte dynamic hypertree region), owner
  `MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms`, discriminant
  4859840929024028656, base = WSOL (9 decimals), quote = USDC (6). At the
  snapshot the ask side has >= 16 non-global levels (the shipped cap) and the
  bid side 10; every level carries `last_valid_slot` 0 (no expiration).
- Vaults: base (WSOL) `AKjfJDv4ywdpCDrj7AURuNkGA3696GTVFgrMwk4TjkKs`
  (203.32 SOL), quote (USDC) `FN9K6rTdWtRDUPmLTN2FnGvLZpHVNRN2MeRghKknSGDs`
  (19,839.54 USDC) — the vault PDAs stored in the market header @80 / @112.
- Mints: WSOL `So1111…112`, USDC `EPjF…Dt1v` (82-byte classic SPL, loaded only
  for the Tokenkeg gate).

Re-dump with `solana account <addr> --url <rpc> --output json` for each of the
five accounts and rewrite the `{address, owner, base64Data}` JSONs. **Keep the
five from ONE market snapshot** (the book is live) and re-pin the worked
examples in `test/svm/venues/manifest.test.ts` + the e2e/quadrilateral pins
from the independent Manifest port (scratchpad `independent-manifest.py`, a
throwing `impact_base_atoms` / `place_order` / `checked_*_for_*` transcription
written separately from the adapter — it and the adapter share nothing but the
venue), per that suite's header.
