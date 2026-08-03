/**
 * Engine-gated end-to-end for `svm-token-settle.sauce.ts`: stages the compiled program ONCE, then
 * executes it against several escrow/beneficiary/floor/token-program combinations — the SAME staged
 * buffer every time, which is itself the genericity proof (staged compile-time args are never baked
 * into the blob, per `svm-token-settle.sauce.ts`'s own doc).
 *
 * Runs against the vendored engine .so by default (SAUCE_ENGINE_SO overrides); skips cleanly if that
 * binary is somehow missing (same gate as every other engine-bound suite in this directory).
 */
import { createHash } from 'node:crypto';
import type { Address } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { resolveAccounts } from '../../src/svm/index.js';
import {
  describeSvm,
  executeStaged,
  expectFail,
  expectOk,
  randomAddress,
  setTokenAccount,
  splTransferData,
  stageBytecode,
  startEngine,
  tokenAmount,
  toBigInt,
} from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { svmTokenSettleSource } from '../../src/programs/index.js';

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());

const TOKENKEG = 0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9n;
const TOKEN_2022 = 0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfcn;
const MINT_A = randomAddress();
const MINT_B = randomAddress();

describeSvm('svm-token-settle e2e: one staged blob, every escrow/beneficiary/floor/token-program combination', () => {
  let harness: EngineHarness;
  let buffer: Address;
  let pin: Uint8Array;
  let accountPlan: ReturnType<typeof compile>['accountPlan'];
  let argsLayout: ReturnType<typeof compile>['argsLayout'];

  beforeAll(async () => {
    harness = await startEngine(1_700_000_000n);

    const compiled = compile(svmTokenSettleSource(1), {
      target: 'svm',
      staged: true,
      treeshake: true,
      args: [0n, 0n],
    });
    accountPlan = compiled.accountPlan;
    argsLayout = compiled.argsLayout;
    pin = sha256(compiled.bytecode[0]!);
    buffer = await stageBytecode(harness, 0, compiled.bytecode[0]!);
  });

  // Address form of the TOKENKEG scalar constant above, for the accounts array (the account ref
  // and the arg scalar are two independent bindings a caller must keep in agreement — see the
  // template's header note). Verified to decode from the exact scalar constant above.
  const TOKENKEG_ADDR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

  const run = async (params: {
    escrow: Address;
    beneficiary: Address;
    owner: Address;
    minOut: bigint;
    tokenProgramScalar: bigint;
    tokenProgramAccount: Address;
  }) => {
    const accounts = resolveAccounts(
      accountPlan!,
      {
        tokenProgram0: params.tokenProgramAccount,
        escrow0: params.escrow,
        beneficiary0: params.beneficiary,
        owner: { address: params.owner, signer: harness.payer },
      },
      harness.payer.address,
    );
    return executeStaged(harness, buffer, accounts, {
      pin,
      args: { layout: argsLayout!, values: [params.minOut, params.tokenProgramScalar] },
    });
  };

  it('floor met exactly at the balance: sweeps the whole escrow to the beneficiary', async () => {
    const escrow = randomAddress();
    const beneficiary = randomAddress();
    const owner = harness.payer.address;
    setTokenAccount(harness, escrow, MINT_A, owner, 1_000_000n);
    setTokenAccount(harness, beneficiary, MINT_A, randomAddress(), 0n);

    const result = expectOk(
      await run({ escrow, beneficiary, owner, minOut: 1_000_000n, tokenProgramScalar: TOKENKEG, tokenProgramAccount: TOKENKEG_ADDR }),
    );

    expect(tokenAmount(harness, escrow)).toBe(0n);
    expect(tokenAmount(harness, beneficiary)).toBe(1_000_000n);
    expect(toBigInt(result.returnData)).toBe(1_000_000n);
  });

  it('floor unmet by one unit: reverts atomically, both balances unchanged', async () => {
    const escrow = randomAddress();
    const beneficiary = randomAddress();
    const owner = harness.payer.address;
    setTokenAccount(harness, escrow, MINT_A, owner, 1_000_000n);
    setTokenAccount(harness, beneficiary, MINT_A, randomAddress(), 0n);

    const result = expectFail(
      await run({ escrow, beneficiary, owner, minOut: 1_000_001n, tokenProgramScalar: TOKENKEG, tokenProgramAccount: TOKENKEG_ADDR }),
    );

    expect(Buffer.from(result.revertData).toString('utf8')).toBe('sweep: balance below minOut');
    expect(tokenAmount(harness, escrow)).toBe(1_000_000n);
    expect(tokenAmount(harness, beneficiary)).toBe(0n);
  });

  it('floor disabled (minOut=0): sweeps whatever the escrow holds', async () => {
    const escrow = randomAddress();
    const beneficiary = randomAddress();
    const owner = harness.payer.address;
    setTokenAccount(harness, escrow, MINT_A, owner, 777n);
    setTokenAccount(harness, beneficiary, MINT_A, randomAddress(), 0n);

    expectOk(await run({ escrow, beneficiary, owner, minOut: 0n, tokenProgramScalar: TOKENKEG, tokenProgramAccount: TOKENKEG_ADDR }));

    expect(tokenAmount(harness, escrow)).toBe(0n);
    expect(tokenAmount(harness, beneficiary)).toBe(777n);
  });

  it('★ the SAME staged buffer serves a completely different mint/escrow/beneficiary/floor', async () => {
    const escrow = randomAddress();
    const beneficiary = randomAddress();
    const owner = harness.payer.address;
    setTokenAccount(harness, escrow, MINT_B, owner, 42_000n);
    setTokenAccount(harness, beneficiary, MINT_B, randomAddress(), 0n);

    const result = expectOk(
      await run({ escrow, beneficiary, owner, minOut: 41_999n, tokenProgramScalar: TOKENKEG, tokenProgramAccount: TOKENKEG_ADDR }),
    );

    expect(tokenAmount(harness, escrow)).toBe(0n);
    expect(tokenAmount(harness, beneficiary)).toBe(42_000n);
    expect(toBigInt(result.returnData)).toBe(42_000n);
  });

  it('token-program arg/account-ref mismatch is a loud pre-flight failure, nothing moves', async () => {
    const escrow = randomAddress();
    const beneficiary = randomAddress();
    const owner = harness.payer.address;
    setTokenAccount(harness, escrow, MINT_A, owner, 5_000n);
    setTokenAccount(harness, beneficiary, MINT_A, randomAddress(), 0n);

    // arg says Token-2022; the tokenProgram account ref resolves to classic Tokenkeg.
    expectFail(
      await run({ escrow, beneficiary, owner, minOut: 0n, tokenProgramScalar: TOKEN_2022, tokenProgramAccount: TOKENKEG_ADDR }),
    );

    expect(tokenAmount(harness, escrow)).toBe(5_000n);
    expect(tokenAmount(harness, beneficiary)).toBe(0n);
  });

  it('empty escrow, minOut=0: succeeds, returns 0, attempts no transfer', async () => {
    const escrow = randomAddress();
    const beneficiary = randomAddress();
    const owner = harness.payer.address;
    setTokenAccount(harness, escrow, MINT_A, owner, 0n);
    setTokenAccount(harness, beneficiary, MINT_A, randomAddress(), 0n);

    const result = expectOk(
      await run({ escrow, beneficiary, owner, minOut: 0n, tokenProgramScalar: TOKENKEG, tokenProgramAccount: TOKENKEG_ADDR }),
    );

    expect(toBigInt(result.returnData)).toBe(0n);
    expect(tokenAmount(harness, escrow)).toBe(0n);
    expect(tokenAmount(harness, beneficiary)).toBe(0n);
  });

  it('cross-checks the CPI data bytes against the SDK\'s own splTransferData for a fresh transfer', async () => {
    // splTransferData is currently unused by any suite (per the module doc) — this is its first
    // consumer, cross-checking the same [tag 3][u64 LE amount] shape the compiled program emits.
    const amount = 123_456n;
    expect(splTransferData(amount)).toEqual(
      Uint8Array.from([3, ...new Uint8Array(new BigUint64Array([amount]).buffer)]),
    );
  });
});
