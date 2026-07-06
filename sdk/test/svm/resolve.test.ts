import { AccountRole, address, createNoopSigner } from '@solana/kit';
import type { AccountPlan } from '@eco-incorp/sauce-compiler';
import { PAYER_REF, resolveAccounts } from '../../src/svm/index.js';

const PAYER = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const POOL = address('So11111111111111111111111111111111111111112');
const ORACLE = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

describe('resolveAccounts', () => {
  it('preserves plan order: metas[i] is user-account index i', () => {
    const plan: AccountPlan = {
      metas: [
        { ref: 'pool', writable: true, signer: false },
        { ref: PAYER_REF, writable: false, signer: false },
        { ref: 'oracle', writable: false, signer: false },
      ],
    };
    const metas = resolveAccounts(plan, { pool: POOL, oracle: ORACLE }, PAYER);

    expect(metas).toEqual([
      { address: POOL, role: AccountRole.WRITABLE },
      { address: PAYER, role: AccountRole.READONLY_SIGNER },
      { address: ORACLE, role: AccountRole.READONLY },
    ]);
  });

  it('resolves the reserved payer ref to the fee payer as a signer', () => {
    const plan: AccountPlan = { metas: [{ ref: PAYER_REF, writable: true, signer: false }] };
    const metas = resolveAccounts(plan, {}, PAYER);

    expect(metas).toEqual([{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }]);
  });

  it('rejects a resolution entry under the reserved payer ref instead of silently overriding it', () => {
    const plan: AccountPlan = { metas: [{ ref: PAYER_REF, writable: false, signer: false }] };

    expect(() => resolveAccounts(plan, { [PAYER_REF]: POOL }, PAYER)).toThrow(
      "account ref 'payer' is reserved for the fee payer (rename the ref or remove it from the resolution map)",
    );
  });

  it('throws the exact message listing every unresolved ref', () => {
    const plan: AccountPlan = {
      metas: [
        { ref: 'a', writable: false, signer: false },
        { ref: 'pool', writable: false, signer: false },
        { ref: 'b', writable: false, signer: false },
      ],
    };

    expect(() => resolveAccounts(plan, { pool: POOL }, PAYER)).toThrow(
      'unresolved account refs: a, b (provide addresses in the resolution map)',
    );
  });

  it('upgrades signer from the plan flag', () => {
    const plan: AccountPlan = { metas: [{ ref: 'auth', writable: false, signer: true }] };
    const metas = resolveAccounts(plan, { auth: ORACLE }, PAYER);

    expect(metas).toEqual([{ address: ORACLE, role: AccountRole.READONLY_SIGNER }]);
  });

  it('upgrades signer from the resolution entry flag', () => {
    const plan: AccountPlan = { metas: [{ ref: 'auth', writable: true, signer: false }] };
    const metas = resolveAccounts(plan, { auth: { address: ORACLE, signer: true } }, PAYER);

    expect(metas).toEqual([{ address: ORACLE, role: AccountRole.WRITABLE_SIGNER }]);
  });

  it('carries a resolution-attached TransactionSigner on the meta and upgrades the role', () => {
    const signer = createNoopSigner(ORACLE);
    const plan: AccountPlan = { metas: [{ ref: 'delegate', writable: false, signer: true }] };
    const metas = resolveAccounts(plan, { delegate: { address: ORACLE, signer } }, PAYER);

    expect(metas).toEqual([{ address: ORACLE, role: AccountRole.READONLY_SIGNER, signer }]);
    expect(metas[0].signer).toBe(signer);
  });

  it("omits the signer key on metas without an attached signer (kit detects signers via 'signer' in meta)", () => {
    const plan: AccountPlan = { metas: [{ ref: 'auth', writable: false, signer: true }] };
    const metas = resolveAccounts(plan, { auth: { address: ORACLE, signer: true } }, PAYER);

    expect('signer' in metas[0]).toBe(false);
  });

  it('rejects a TransactionSigner whose address differs from the resolved address', () => {
    const plan: AccountPlan = { metas: [{ ref: 'delegate', writable: false, signer: false }] };

    expect(() => resolveAccounts(plan, { delegate: { address: POOL, signer: createNoopSigner(ORACLE) } }, PAYER)).toThrow(
      `account ref 'delegate' address ${POOL} does not match its TransactionSigner address ${ORACLE}`,
    );
  });

  it('takes writable from the plan, not the resolution', () => {
    const plan: AccountPlan = {
      metas: [
        { ref: 'ro', writable: false, signer: false },
        { ref: 'rw', writable: true, signer: false },
      ],
    };
    const metas = resolveAccounts(plan, { ro: POOL, rw: ORACLE }, PAYER);

    expect(metas[0].role).toBe(AccountRole.READONLY);
    expect(metas[1].role).toBe(AccountRole.WRITABLE);
  });

  it('falls back to the plan pubkey when the resolution map omits the ref', () => {
    const plan: AccountPlan = { metas: [{ ref: 'pool', pubkey: POOL, writable: false, signer: false }] };
    const metas = resolveAccounts(plan, {}, PAYER);

    expect(metas).toEqual([{ address: POOL, role: AccountRole.READONLY }]);
  });

  it('allows duplicate addresses across refs', () => {
    const plan: AccountPlan = {
      metas: [
        { ref: 'a', writable: false, signer: false },
        { ref: 'b', writable: true, signer: false },
      ],
    };
    const metas = resolveAccounts(plan, { a: POOL, b: POOL }, PAYER);

    expect(metas.map(m => m.address)).toEqual([POOL, POOL]);
  });

  it('a signerless plan stays signerless by default (NoSigner is lazy — only MSG_SENDER readers need one)', () => {
    const plan: AccountPlan = {
      metas: [
        { ref: 'pool', writable: true, signer: false },
        { ref: 'oracle', writable: false, signer: false },
      ],
    };
    const metas = resolveAccounts(plan, { pool: POOL, oracle: ORACLE }, PAYER);

    expect(metas).toEqual([
      { address: POOL, role: AccountRole.WRITABLE },
      { address: ORACLE, role: AccountRole.READONLY },
    ]);
  });

  it('appendPayerSigner appends the payer AT THE END when no meta signs (plan indices stable)', () => {
    const plan: AccountPlan = {
      metas: [
        { ref: 'pool', writable: true, signer: false },
        { ref: 'oracle', writable: false, signer: false },
      ],
    };
    const metas = resolveAccounts(plan, { pool: POOL, oracle: ORACLE }, PAYER, { appendPayerSigner: true });

    // For MSG_SENDER-reading programs whose plan carries no signer meta; the
    // append keeps user-account indices 0..n-1 exactly the plan's.
    expect(metas).toEqual([
      { address: POOL, role: AccountRole.WRITABLE },
      { address: ORACLE, role: AccountRole.READONLY },
      { address: PAYER, role: AccountRole.READONLY_SIGNER },
    ]);
  });

  it('appendPayerSigner does NOT append when any resolved meta already signs', () => {
    const viaPlanFlag = resolveAccounts(
      { metas: [{ ref: 'auth', writable: false, signer: true }] },
      { auth: ORACLE },
      PAYER,
      { appendPayerSigner: true },
    );
    const viaPayerRef = resolveAccounts({ metas: [{ ref: PAYER_REF, writable: false, signer: false }] }, {}, PAYER, {
      appendPayerSigner: true,
    });

    expect(viaPlanFlag).toHaveLength(1);
    expect(viaPayerRef).toHaveLength(1);
  });

  it('rejects raw-index plans (the caller owns the ordering)', () => {
    const plan: AccountPlan = { metas: [], usesRawIndices: true };

    expect(() => resolveAccounts(plan, {}, PAYER)).toThrow(
      'account plan uses raw indices: the caller owns the account ordering, build metas manually',
    );
  });
});
