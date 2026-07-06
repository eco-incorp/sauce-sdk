/**
 * Synthetic Manifest market fixtures: a minimal MarketFixed header (256 bytes,
 * real discriminant) plus a book side laid out byte-exact to the on-chain
 * 80-byte blocks (16-byte red-black-tree node overhead + 64-byte RestingOrder
 * payload). The orders are threaded as a LEFT-leaning chain — root = the best
 * order, each order's left child = the next-worse order — so the venue's
 * best_index + get_next_lower_index taker walk visits them best-first exactly
 * as fetchManifestConfig's off-chain walk does.
 *
 * Used by the oracle units (conversion round-trips, controlled price levels,
 * the global/expiring stop, seq-mismatch drift) and the e2e window-exhaustion
 * cell. The REAL mainnet market (fixtures/manifest/) drives the pinned worked
 * examples and the real-binary quadrilateral.
 */
import { getAddressCodec } from '@solana/kit';
import type { Address } from '@solana/kit';
import {
  MANIFEST_PROGRAM_ID,
  MARKET_DISCRIMINANT,
  MARKET_FIXED_SIZE,
  NIL,
} from '../../src/svm/venues/manifest/index.js';
import { randomAddr, splTokenAccountBytes, TOKENKEG } from './ecoswap-svm.fixtures.js';

/** MARKET_BLOCK_SIZE — the on-chain hypertree block stride. */
const BLOCK = 80;
/** OrderType enum (resting_order.rs). */
export const ORDER_LIMIT = 0;
export const ORDER_POST_ONLY = 2;
export const ORDER_GLOBAL = 3;
export const ORDER_REVERSE = 4;

export interface SyntheticManifestOrder {
  /** Price inner = quote_atoms_per_base_atom * 1e18 (u128). */
  priceInner: bigint;
  /** num_base_atoms (u64). */
  size: bigint;
  /** sequence_number (u64) — defaults to a descending-from-1000 counter. */
  seq?: bigint;
  /** OrderType (default Limit). */
  orderType?: number;
  /** last_valid_slot (default 0 = no expiration). */
  lastValidSlot?: number;
}

export interface SynthesizedManifestMarket {
  market: Address;
  baseVault: Address;
  quoteVault: Address;
  /** Account images keyed by address — feed to a loader AND setAccount. */
  accounts: { address: Address; owner: Address; data: Uint8Array }[];
}

export interface SynthesizeManifestOpts {
  /** Which book side the orders sit on: 'bids' (matched by a base-in sell) or 'asks' (a quote-in buy). */
  side: 'bids' | 'asks';
  /** Orders in BEST-FIRST order (bids: descending price; asks: ascending price). */
  orders: SyntheticManifestOrder[];
  baseMint: Address;
  quoteMint: Address;
  baseDecimals?: number;
  quoteDecimals?: number;
  baseVaultAmount?: bigint;
  quoteVaultAmount?: bigint;
}

const writeLE = (data: Uint8Array, offset: number, width: number, value: bigint): void => {
  for (let i = 0; i < width; i++) data[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn);
};

/** Convert a decimal price (quote per base, atom terms) to the inner u128 (price * 1e18). */
export function manifestPriceInner(quoteAtomsPerBaseAtom: number): bigint {
  // Exact for the round test prices used here; scale by 1e18.
  const scaled = Math.round(quoteAtomsPerBaseAtom * 1e9);
  return (BigInt(scaled) * 1_000_000_000_000_000_000n) / 1_000_000_000n;
}

/** Builds a market with one populated book side threaded as a best-first left-chain. */
export function synthesizeManifestMarket(opts: SynthesizeManifestOpts): SynthesizedManifestMarket {
  const codec = getAddressCodec();
  const market = randomAddr();
  const baseVault = randomAddr();
  const quoteVault = randomAddr();
  const isBid = opts.side === 'bids';

  const n = opts.orders.length;
  const data = new Uint8Array(MARKET_FIXED_SIZE + Math.max(1, n) * BLOCK);
  // MarketFixed header.
  writeLE(data, 0, 8, MARKET_DISCRIMINANT);
  data[9] = opts.baseDecimals ?? 9;
  data[10] = opts.quoteDecimals ?? 6;
  data.set(new Uint8Array(codec.encode(opts.baseMint)), 16);
  data.set(new Uint8Array(codec.encode(opts.quoteMint)), 48);
  data.set(new Uint8Array(codec.encode(baseVault)), 80);
  data.set(new Uint8Array(codec.encode(quoteVault)), 112);
  writeLE(data, 152, 4, BigInt(n * BLOCK)); // num_bytes_allocated
  // Both roots/best NIL by default; the populated side points at block 0.
  writeLE(data, 156, 4, BigInt(NIL)); // bids_root
  writeLE(data, 160, 4, BigInt(NIL)); // bids_best
  writeLE(data, 164, 4, BigInt(NIL)); // asks_root
  writeLE(data, 168, 4, BigInt(NIL)); // asks_best
  writeLE(data, 172, 4, BigInt(NIL)); // claimed_seats_root
  writeLE(data, 176, 4, BigInt(NIL)); // free_list_head

  if (n > 0) {
    const rootOffset = isBid ? 156 : 164;
    const bestOffset = isBid ? 160 : 168;
    writeLE(data, rootOffset, 4, 0n); // root = block 0 (best)
    writeLE(data, bestOffset, 4, 0n); // best = block 0
    opts.orders.forEach((order, k) => {
      const dataIndex = k * BLOCK;
      const base = MARKET_FIXED_SIZE + dataIndex;
      // Left-chain: left = next-worse (block k+1), right = NIL, parent = block k-1.
      writeLE(data, base + 0, 4, k + 1 < n ? BigInt((k + 1) * BLOCK) : BigInt(NIL)); // left
      writeLE(data, base + 4, 4, BigInt(NIL)); // right
      writeLE(data, base + 8, 4, k > 0 ? BigInt((k - 1) * BLOCK) : BigInt(NIL)); // parent
      // RestingOrder payload @ base + 16.
      const p = base + 16;
      writeLE(data, p + 0, 16, order.priceInner);
      writeLE(data, p + 16, 8, order.size);
      writeLE(data, p + 24, 8, order.seq ?? BigInt(1000 - k));
      writeLE(data, p + 36, 4, BigInt(order.lastValidSlot ?? 0));
      data[p + 40] = isBid ? 1 : 0; // is_bid
      data[p + 41] = order.orderType ?? ORDER_LIMIT;
    });
  }

  return {
    market,
    baseVault,
    quoteVault,
    accounts: [
      { address: market, owner: MANIFEST_PROGRAM_ID, data },
      { address: baseVault, owner: TOKENKEG, data: splTokenAccountBytes(opts.baseMint, market, opts.baseVaultAmount ?? 10n ** 15n) },
      { address: quoteVault, owner: TOKENKEG, data: splTokenAccountBytes(opts.quoteMint, market, opts.quoteVaultAmount ?? 10n ** 15n) },
    ],
  };
}
