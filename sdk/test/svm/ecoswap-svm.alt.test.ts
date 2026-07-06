/**
 * EcoSwapSVM address-lookup-table packet accounting (no engine, no RPC).
 *
 * Pins the raw v0 packet OVERFLOW THRESHOLD for staged EcoSwapSVM trades and
 * proves an ALT brings an overflowing shape back under Solana's 1,232-byte
 * limit while the 64 account-LOCK cap is untouched (the ALT shrinks message
 * BYTES, never locks). Sizes are the real `getTransactionSize` of the signed
 * v0 transaction the send layer builds (deduped keys), cross-checked against
 * the conservative meta-space `estimatePacket` model.
 *
 * Threshold (Orca Whirlpool CLMM, the account+args-heaviest family, real swap
 * template): a 2-slot shape FITS raw; a 3-slot shape OVERFLOWS. The overflow
 * is driven by BOTH the per-slot account footprint (pool + 3 tick arrays +
 * 2 vaults + oracle + program) AND the 16-word-per-slot cfg args (the shipped
 * tick boundaries), which is why args-light constant-product families do not
 * overflow at the 4-slot template cap.
 */
import { generateKeyPairSigner, getAddressCodec } from '@solana/kit';
import type { Address } from '@solana/kit';
import { estimatePacket } from '@eco-incorp/sauce-compiler';
import type { AccountPlan } from '@eco-incorp/sauce-compiler';
import {
  buildComputeBudgetPrepend,
  buildExecuteFromAccountInstruction,
  buildExecuteTransaction,
  buildHeapFramePrepend,
  encodePayloadArgs,
  getTransactionSize,
  resolveAccounts,
} from '../../src/svm/index.js';
import { fetchOrcaWhirlpoolConfig } from '../../src/svm/venues/orca-whirlpool/index.js';
import { orcaWhirlpoolLadder } from '../../src/svm/venues/orca-whirlpool/ladder.js';
import {
  ecoSwapSvmPacketBudget,
  generateEcoSwapSvm,
  prepareAltForUniverse,
  selectEcoSwapSvmAltAddresses,
} from '../../src/recipes/ecoswap/svm/index.js';
import type { GeneratedEcoSwapSvm } from '../../src/recipes/ecoswap/svm/index.js';
import type { EnsuredLookupTable, SauceSvmClient } from '../../src/svm/index.js';
import { synthesizeWhirlpool } from './orca-whirlpool.fixtures.js';
import { syntheticMintBytes, WSOL_MINT, USDC_MINT } from './ecoswap-svm.fixtures.js';

const PACKET_LIMIT = 1232;
const LOCK_LIMIT = 64;
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
const codec = getAddressCodec();
const rand = (): Address => codec.decode(crypto.getRandomValues(new Uint8Array(32)));

/** Builds a k-slot Whirlpool shape (real swap template) offline — no engine, no RPC. */
async function whirlpoolShape(k: number): Promise<GeneratedEcoSwapSvm> {
  const mem: Record<string, Uint8Array> = { [WSOL_MINT]: syntheticMintBytes(9), [USDC_MINT]: syntheticMintBytes(6) };
  const load = async (a: Address) => (mem[a] ? new Uint8Array(mem[a]) : null);
  const cfgs = [];
  for (let i = 0; i < k; i++) {
    const w = synthesizeWhirlpool({
      mintA: WSOL_MINT, mintB: USDC_MINT, tickSpacing: 64, tickCurrentIndex: 0,
      liquidity: 5_000_000_000n + BigInt(i) * 1_000_000_000n, feeRate: 3000,
      ticks: [{ tick: -128, net: 5_000_000_000n }], arrayStarts: [0, -5632],
    });
    for (const a of w.accounts) mem[a.address] = a.data;
    cfgs.push(await fetchOrcaWhirlpoolConfig(load, w.pool));
  }
  return generateEcoSwapSvm({ slots: cfgs.map((cfg) => ({ adapter: orcaWhirlpoolLadder, cfg })), user: USER, cuFloor: 1 });
}

interface Assembled {
  rawBytes: number;
  altBytes: number;
  altAddressCount: number;
  metaCount: number;
}

/** Signs the raw and the ALT-compressed staged v0 transaction; returns real sizes. */
async function assemble(output: GeneratedEcoSwapSvm): Promise<Assembled> {
  const payer = await generateKeyPairSigner();
  const resolution = { [USER.outAta]: rand(), [USER.inAta]: rand() };
  const metas = resolveAccounts(output.accountPlan, resolution, payer.address);
  const buffer = rand();
  const exec = buildExecuteFromAccountInstruction({
    programId: (await generateKeyPairSigner()).address,
    buffer,
    accounts: metas,
    expectedSha256: new Uint8Array(32),
    args: encodePayloadArgs(output.argsLayout, ['0x' + '00'.repeat(output.argsLayout.byteLength)]),
  });
  const ixs = [...buildComputeBudgetPrepend({ unitLimit: 1_400_000 }), buildHeapFramePrepend(), exec];
  const blockhash = { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 1000n };

  const rawTx = await buildExecuteTransaction({ payer, instructions: ixs, latestBlockhash: blockhash });

  const altAddresses = selectEcoSwapSvmAltAddresses(output, buffer, resolution, payer.address);
  const table = rand();
  const altTx = await buildExecuteTransaction({
    payer, instructions: ixs, latestBlockhash: blockhash, lookupTables: { [table]: altAddresses },
  });

  // The signer (fee payer) is never in the table; the buffer always is.
  expect(altAddresses).not.toContain(payer.address);
  expect(altAddresses).toContain(buffer);

  return { rawBytes: getTransactionSize(rawTx), altBytes: getTransactionSize(altTx), altAddressCount: altAddresses.length, metaCount: metas.length };
}

describe('ecoswap-svm ALT: raw packet overflow threshold and the ALT remedy', () => {
  it('a 2-slot CLMM shape fits the raw v0 packet (no ALT needed)', async () => {
    const output = await whirlpoolShape(2);
    const { rawBytes } = await assemble(output);
    expect(rawBytes).toBeLessThanOrEqual(PACKET_LIMIT);
  });

  it('a 3-slot CLMM shape OVERFLOWS raw and an ALT brings it back under 1,232', async () => {
    const output = await whirlpoolShape(3);
    const { rawBytes, altBytes, altAddressCount } = await assemble(output);

    expect(rawBytes).toBeGreaterThan(PACKET_LIMIT); // a real cluster/RPC drops this packet
    expect(altBytes).toBeLessThanOrEqual(PACKET_LIMIT); // the ALT makes it sendable
    expect(altBytes).toBeLessThan(rawBytes);
    expect(altAddressCount).toBeGreaterThan(0);
  });

  it('the ALT shrinks BYTES, not LOCKS: the 64 account-lock cap is invariant', async () => {
    const output = await whirlpoolShape(3);
    const payer = await generateKeyPairSigner();
    const resolution = { [USER.outAta]: rand(), [USER.inAta]: rand() };
    const budget = ecoSwapSvmPacketBudget(output, { resolution, payerAddress: payer.address });

    expect(budget.raw.overflowBytes).toBeGreaterThan(0);
    expect(budget.withAlt).toBeDefined();
    expect(budget.withAlt!.overflowBytes).toBe(0);
    // Locks are unchanged by the ALT (locks = static keys + resolved addresses).
    expect(budget.withAlt!.accountLocks).toBe(budget.raw.accountLocks);
    expect(budget.withAlt!.accountLocks).toBeLessThanOrEqual(LOCK_LIMIT);
  });

  it('the planner still enforces the 64-lock cap even WITH an ALT', () => {
    // 70 distinct non-signer accounts: the ALT dissolves the byte overflow but
    // NOT the lock count — estimatePacket warns, proving ALT never lifts the cap.
    const metas = Array.from({ length: 70 }, (_, i) => ({ ref: `venue:${i}`, writable: false, signer: false }));
    const plan: AccountPlan = { metas };
    const withAlt = estimatePacket(plan, 8_000, { mode: 'staged', argsBytes: 32, lookupTables: 1, lookupAddresses: 69 });

    expect(withAlt.accountLocks).toBeGreaterThan(LOCK_LIMIT);
    expect(withAlt.warnings.some((w) => w.includes('account locks') && w.includes('64'))).toBe(true);
  });

  it('prepareAltForUniverse selects the universe keys and forwards reuse/commitment to the client', async () => {
    const output = await whirlpoolShape(2);
    const payer = await generateKeyPairSigner();
    const resolution = { [USER.outAta]: rand(), [USER.inAta]: rand() };
    const buffer = rand();
    const existingTable = rand();

    const calls: { addresses: readonly Address[]; opts: unknown }[] = [];
    const ensured: EnsuredLookupTable = { lookupTableAddress: existingTable, lookupTables: { [existingTable]: [] } };
    const mockClient = {
      payerAddress: payer.address,
      ensureLookupTable: async (addresses: readonly Address[], opts: unknown) => {
        calls.push({ addresses, opts });
        return ensured;
      },
    } as unknown as SauceSvmClient;

    const result = await prepareAltForUniverse(mockClient, buffer, output, resolution, {
      existingTable,
      commitment: 'finalized',
    });

    expect(result).toBe(ensured);
    expect(calls).toHaveLength(1);
    expect(calls[0].addresses).toEqual(selectEcoSwapSvmAltAddresses(output, buffer, resolution, payer.address));
    expect(calls[0].opts).toEqual({ existing: existingTable, commitment: 'finalized' });
  });

  it('selectEcoSwapSvmAltAddresses covers the buffer + every non-signer, excludes the signer, dedupes', async () => {
    const output = await whirlpoolShape(2);
    const payer = await generateKeyPairSigner();
    const resolution = { [USER.outAta]: rand(), [USER.inAta]: rand() };
    const buffer = rand();
    const metas = resolveAccounts(output.accountPlan, resolution, payer.address);
    const nonSigners = new Set(metas.filter((m) => m.role === 0 || m.role === 1).map((m) => m.address));

    const selected = selectEcoSwapSvmAltAddresses(output, buffer, resolution, payer.address);

    expect(new Set(selected).size).toBe(selected.length); // deduped
    expect(selected).toContain(buffer);
    expect(selected).not.toContain(payer.address); // the owner/fee-payer signer stays static
    for (const address of nonSigners) expect(selected).toContain(address);
    expect(selected.length).toBe(nonSigners.size + 1); // exactly the non-signers + the buffer
  });
});
