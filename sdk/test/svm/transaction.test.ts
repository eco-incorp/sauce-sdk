import { address, generateKeyPairSigner, getCompiledTransactionMessageDecoder } from '@solana/kit';
import type { Blockhash, KeyPairSigner } from '@solana/kit';
import {
  buildComputeBudgetPrepend,
  buildExecuteInstruction,
  buildExecuteTransaction,
  deriveEnginePdas,
  getTransactionSize,
} from '../../src/svm/index.js';

const PROGRAM_ID = address('Stake11111111111111111111111111111111111111');
// 32 base58 '1's decode to the 32-byte zero blockhash
const BLOCKHASH = {
  blockhash: '11111111111111111111111111111111' as Blockhash,
  lastValidBlockHeight: 1000n,
};

let payer: KeyPairSigner;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
});

describe('buildExecuteTransaction', () => {
  it('signs a version-0 transaction with the fee payer and all instructions', async () => {
    const pdas = await deriveEnginePdas(PROGRAM_ID);
    const instructions = [
      ...buildComputeBudgetPrepend({ unitLimit: 200_000 }),
      buildExecuteInstruction({ programId: PROGRAM_ID, pdas, bytecode: new Uint8Array([0x00]), accounts: [] }),
    ];

    const transaction = await buildExecuteTransaction({ payer, instructions, latestBlockhash: BLOCKHASH });

    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    expect(compiled.version).toBe(0);
    if (compiled.version !== 0) throw new Error('expected a v0 compiled message');
    expect(compiled.instructions).toHaveLength(2);
    // fee payer is the first static account
    expect(compiled.staticAccounts[0]).toBe(payer.address);

    // fully signed: the payer's 64-byte ed25519 signature is present
    const signature = transaction.signatures[payer.address];
    expect(signature).not.toBeNull();
    expect(signature).toHaveLength(64);

    expect(transaction.lifetimeConstraint).toEqual(BLOCKHASH);

    const size = getTransactionSize(transaction);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(1232);
  });
});
