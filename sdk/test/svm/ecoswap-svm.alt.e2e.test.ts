/**
 * EcoSwapSVM address-lookup-table transport on the REAL engine (LiteSVM).
 *
 *   a. OVERFLOW → ALT: a 3-slot Orca Whirlpool shape assembles to a raw v0
 *      transaction ABOVE the 1,232-byte packet (a real cluster/RPC drops it);
 *      compressed against an ALT over its non-signer keys + the buffer it fits
 *      under 1,232, with account LOCKS still ≤ 64 (the ALT shrinks BYTES, not
 *      locks). Not executed — three CLMM slots exceed the 1.4M CU cap (one
 *      CLMM slot ≈ 590k; see the combined-ceiling note below); this cell is
 *      the packet-shape proof, the CU wall is a separate ceiling.
 *
 *   b. ALT EXECUTES, lamport-exact and TRANSPARENT: a 3-slot constant-product
 *      shape (raydium-cp, ~313k CU/slot — fits the cap) staged once and cooked
 *      through a v0 transaction compressed against a fabricated ALT — the
 *      in-VM split (slices, predicted, realized) equals the solver-reference,
 *      and the returndata is BYTE-IDENTICAL to the same trade sent raw (the
 *      ALT is a pure transport, never a dialect).
 *
 *   c. ALT REUSE across trades: the SAME table drives two different-amount
 *      trades on one universe (the account set is as stable as the staged
 *      blob), each lamport-exact.
 *
 * The ALT is fabricated directly in the bank (harness.fabricateAlt) — the
 * active on-chain layout the create/extend path would build — and the v0
 * transaction is compressed with the sdk's own buildExecuteTransaction, the
 * exact path the client's executeStaged (and executeEcoSwapSvm's `alt` option)
 * take. Requires the engine .so; skips cleanly when absent.
 */
import { lamports } from '@solana/kit';
import type { Address, AddressesByLookupTableAddress } from '@solana/kit';
import { FailedTransactionMetadata } from 'litesvm';
import {
  buildComputeBudgetPrepend,
  buildExecuteFromAccountInstruction,
  buildExecuteTransaction,
  buildHeapFramePrepend,
  deriveBufferPda,
  encodePayloadArgs,
  getTransactionSize,
  raydiumCpSwap,
  raydiumCpSwapLadder,
  resolveAccounts,
} from '../../src/svm/index.js';
import type { AccountBytesMap, AccountResolution, LadderSwapTemplate } from '../../src/svm/index.js';
import {
  ecoSwapSvmPacketBudget,
  encodeEcoSwapSvmTrade,
  generateEcoSwapSvm,
  selectEcoSwapSvmAltAddresses,
  solveReference,
} from '../../src/recipes/ecoswap/svm/index.js';
import type { GeneratedEcoSwapSvm } from '../../src/recipes/ecoswap/svm/index.js';
import { fetchOrcaWhirlpoolConfig } from '../../src/svm/venues/orca-whirlpool/index.js';
import { orcaWhirlpoolLadder } from '../../src/svm/venues/orca-whirlpool/ladder.js';
import { describeSvm, fabricateAlt, randomAddress, setTokenAccount, startEngine } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { synthesizeWhirlpool } from './orca-whirlpool.fixtures.js';
import { synthesizeRaydiumCpPool, syntheticMintBytes, TOKENKEG, USDC_MINT, WSOL_MINT } from './ecoswap-svm.fixtures.js';
import { decodeEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';
import type { StagedEcoBlob } from './ecoswap-svm.harness.js';

const CLOCK = 1_783_175_236n;
const PACKET_LIMIT = 1232;
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
const OUT_ATA_START = 5_000_000n;

/** SPL-token transfer stand-in paying the slot's PREDICTED OUTPUT (patch: 'out'). */
const standIn = (slot: number): LadderSwapTemplate => ({
  programId: TOKENKEG,
  prefix: Uint8Array.of(3),
  suffix: new Uint8Array(0),
  patch: 'out',
  accounts: [
    { ref: `sv${slot}`, writable: true },
    { ref: USER.outAta, writable: true },
    { ref: USER.owner, signer: true },
  ],
});

describeSvm('ecoswap-svm ALT: overflow remedy + transparent execution on the real engine', () => {
  let harness: EngineHarness;
  let liveLoader: (addr: Address) => Promise<Uint8Array | null>;
  let bufferIndex = 0;

  const setAccount = (address: Address, owner: Address, data: Uint8Array): void =>
    harness.svm.setAccount({
      address,
      data,
      executable: false,
      lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      programAddress: owner,
      space: BigInt(data.length),
    });

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    for (const [mint, dec] of [[WSOL_MINT, 9], [USDC_MINT, 6]] as [Address, number][]) {
      setAccount(mint, TOKENKEG, syntheticMintBytes(dec));
    }
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
  });

  /** Signs the staged execute v0 tx (raw or ALT-compressed) — the client's transport, by hand. */
  const buildTx = async (
    output: GeneratedEcoSwapSvm,
    buffer: Address,
    resolution: AccountResolution,
    args: readonly [`0x${string}`],
    lookupTables?: AddressesByLookupTableAddress,
  ) => {
    const accounts = resolveAccounts(output.accountPlan, resolution, harness.payer.address);
    const exec = buildExecuteFromAccountInstruction({
      programId: harness.programId,
      buffer,
      accounts,
      expectedSha256: new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(output.bytecode))),
      args: encodePayloadArgs(output.argsLayout, args as unknown as string[]),
    });
    harness.svm.expireBlockhash();
    return buildExecuteTransaction({
      payer: harness.payer,
      instructions: [...buildComputeBudgetPrepend({ unitLimit: 1_400_000 }), buildHeapFramePrepend(), exec],
      latestBlockhash: { blockhash: harness.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
      lookupTables,
    });
  };

  it('a. a 3-slot CLMM shape overflows the raw packet; the ALT fits it under 1,232, locks ≤ 64', async () => {
    const whirls = Array.from({ length: 3 }, (_, i) => {
      const w = synthesizeWhirlpool({
        mintA: WSOL_MINT, mintB: USDC_MINT, tickSpacing: 64, tickCurrentIndex: 0,
        liquidity: 5_000_000_000n + BigInt(i) * 1_000_000_000n, feeRate: 3000,
        ticks: [{ tick: -128, net: 5_000_000_000n }], arrayStarts: [0, -5632],
      });
      for (const a of w.accounts) setAccount(a.address, a.owner, a.data);
      return w;
    });
    const cfgs = await Promise.all(whirls.map((w) => fetchOrcaWhirlpoolConfig(liveLoader, w.pool)));
    const output = generateEcoSwapSvm({
      slots: cfgs.map((cfg, i) => ({ adapter: orcaWhirlpoolLadder, cfg, swapOverride: standIn(i) })),
      user: USER,
      cuFloor: 1,
    });
    const params = cfgs.map((cfg) => orcaWhirlpoolLadder.paramsFor(cfg));
    const args = [encodeEcoSwapSvmTrade(params.map((p) => ({ params: p })), 1_000_000n, 0n)] as const;

    const { address: buffer } = await deriveBufferPda(harness.programId, harness.payer.address, bufferIndex++);
    const outAta = setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, OUT_ATA_START);
    const resolution: AccountResolution = { [USER.outAta]: outAta };
    whirls.forEach((_, i) => (resolution[`sv${i}`] = setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 15n)));

    const rawTx = await buildTx(output, buffer, resolution, args);
    const altAddresses = selectEcoSwapSvmAltAddresses(output, buffer, resolution, harness.payer.address);
    const altTx = await buildTx(output, buffer, resolution, args, fabricateAlt(harness, altAddresses));

    expect(getTransactionSize(rawTx)).toBeGreaterThan(PACKET_LIMIT); // un-sendable on a real cluster
    expect(getTransactionSize(altTx)).toBeLessThanOrEqual(PACKET_LIMIT); // the ALT makes it sendable

    const budget = ecoSwapSvmPacketBudget(output, { resolution, payerAddress: harness.payer.address });
    expect(budget.raw.overflowBytes).toBeGreaterThan(0);
    expect(budget.withAlt!.overflowBytes).toBe(0);
    expect(budget.withAlt!.accountLocks).toBe(budget.raw.accountLocks); // ALT never lifts the lock cap
    expect(budget.withAlt!.accountLocks).toBeLessThanOrEqual(64);
  });

  describe('b+c. a 3-slot CP shape executes lamport-exact through an ALT, reused across trades', () => {
    let output: GeneratedEcoSwapSvm;
    let staged: StagedEcoBlob;
    let resolution: AccountResolution;
    let lookupTables: AddressesByLookupTableAddress;
    let params: bigint[][];
    let states: AccountBytesMap[];
    let cfgs: Awaited<ReturnType<typeof raydiumCpSwap.fetchPoolConfig>>[];
    let pools: ReturnType<typeof synthesizeRaydiumCpPool>[];

    const referenceSplit = (amountIn: bigint) =>
      solveReference(
        params.map((p, i) => ({ quote: raydiumCpSwapLadder.referenceQuote(cfgs[i], states[i], p) })),
        amountIn,
      );

    beforeAll(async () => {
      pools = Array.from({ length: 3 }, (_, i) =>
        synthesizeRaydiumCpPool(1_000_000_000n + BigInt(i) * 100_000_000n, 160_000_000n + BigInt(i) * 20_000_000n),
      );
      for (const rp of pools) for (const a of rp.accounts) setAccount(a.address, a.owner, a.data);
      cfgs = await Promise.all(pools.map((rp) => raydiumCpSwap.fetchPoolConfig(liveLoader, rp.pool)));
      output = generateEcoSwapSvm({
        slots: cfgs.map((cfg, i) => ({ adapter: raydiumCpSwapLadder, cfg, swapOverride: standIn(i) })),
        user: USER,
        cuFloor: 1,
      });
      params = cfgs.map((cfg) => raydiumCpSwapLadder.paramsFor(cfg));
      states = await Promise.all(
        cfgs.map(async (cfg) => {
          const state: AccountBytesMap = {};
          for (const acct of raydiumCpSwapLadder.quoteRefs(cfg, 0)) {
            if (acct.address === undefined) continue;
            const data = await liveLoader(acct.address);
            if (data) state[acct.address] = data;
          }
          return state;
        }),
      );

      const outAta = setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, OUT_ATA_START);
      resolution = { [USER.outAta]: outAta };
      pools.forEach((_, i) => (resolution[`sv${i}`] = setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 15n)));
      staged = await stageEcoBlob(harness, bufferIndex++, output);

      // ONE table over the universe's non-signer keys + the buffer — built once, reused every trade.
      lookupTables = fabricateAlt(harness, selectEcoSwapSvmAltAddresses(output, staged.buffer, resolution, harness.payer.address));
    });

    const runTrade = async (amountIn: bigint, useAlt: boolean) => {
      const ref = referenceSplit(amountIn);
      const args = [encodeEcoSwapSvmTrade(params.map((p) => ({ params: p })), amountIn, ref.totalPredicted)] as const;
      const tx = await buildTx(output, staged.buffer, resolution, args, useAlt ? lookupTables : undefined);
      const result = harness.svm.sendTransaction(tx);
      if (result instanceof FailedTransactionMetadata) {
        throw new Error(`trade failed (alt=${useAlt}): ${String(result.err())}\n${result.meta().logs().join('\n')}`);
      }
      return { ref, words: decodeEcoTrade(result.returnData().data(), 3), returnData: result.returnData().data(), size: getTransactionSize(tx) };
    };

    it('b. executes lamport-exact through the ALT, byte-identical to the raw transport', async () => {
      const amountIn = 100_000_000n;
      const alt = await runTrade(amountIn, true);

      expect(alt.words.slices).toEqual(alt.ref.slices);
      expect(alt.words.predictedOuts).toEqual(alt.ref.predictedOuts);
      expect(alt.words.realized).toBe(alt.ref.totalPredicted);
      expect(alt.words.slices.every((s) => s > 0n)).toBe(true); // a genuine 3-way split
      expect(alt.words.slices.reduce((a, b) => a + b, 0n)).toBe(amountIn);

      const raw = await runTrade(amountIn, false);
      expect(alt.returnData).toEqual(raw.returnData); // ALT is a transparent transport
      expect(alt.size).toBeLessThan(raw.size); // and a smaller packet
    });

    it('c. the SAME ALT drives a second, different-amount trade — still lamport-exact', async () => {
      for (const amountIn of [40_000_000n, 250_000_000n]) {
        const { ref, words } = await runTrade(amountIn, true);
        expect(words.slices).toEqual(ref.slices);
        expect(words.predictedOuts).toEqual(ref.predictedOuts);
        expect(words.realized).toBe(ref.totalPredicted);
        expect(words.slices.reduce((a, b) => a + b, 0n)).toBe(amountIn);
      }
    });
  });
});
