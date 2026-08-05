/**
 * @eco-incorp/sauce-sdk/svm/verify — SVM intent extraction (the partner-facing path).
 *
 * An external partner consuming an Eco intent has only this package. So the whole chain is exercised
 * here: decode the Portal CalldataWithAccounts envelope that wraps each SVM route call, then extract the
 * settle params + resolved account identities (optionally verifying against staged bytecode).
 *
 * The Portal byte layout is pinned by a HAND-BUILT fixture (independent of the SDK's own codec choice),
 * so a Portal IDL field-order/type change can't drift the decoder silently; the full extraction path
 * then round-trips a real settle execution wrapped in a real envelope.
 */
import { createHash } from 'node:crypto';
import {
  AccountRole,
  addEncoderSizePrefix,
  getAddressDecoder,
  getAddressEncoder,
  getArrayEncoder,
  getBooleanEncoder,
  getBytesEncoder,
  getStructEncoder,
  getU8Encoder,
  getU32Encoder,
} from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { encodePayloadArgs } from '../../src/svm/args.js';
import { buildExecuteFromAccountInstruction } from '../../src/svm/instructions.js';
import { svmSettleRefs, svmSettleSource } from '../../src/svm/recipes/index.js';
import {
  decodePortalCalldataWithAccounts,
  extractSvmSettleFromCalls,
  extractSvmSettleFromIntent,
} from '../../src/svm/verify.js';

const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const PROGRAM = 'CuHCniNMWLSkZWBQKon9tudGujZeXJRUwG2PCLDq4ipJ';
const BUFFER = 'So11111111111111111111111111111111111111112';

const addrDecoder = getAddressDecoder();
const addrEncoder = getAddressEncoder();
function makeAddr(seed: number): string {
  return addrDecoder.decode(new Uint8Array(32).fill(seed));
}
function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}
function addressScalar(addr: string): bigint {
  let v = 0n;
  for (const b of addrEncoder.encode(addr as never)) v = (v << 8n) | BigInt(b);
  return v;
}

// The inverse of the SDK's Portal envelope decoder — used only to build fixtures for the extraction path.
const envelopeEncoder = getStructEncoder([
  ['calldata', getStructEncoder([
    ['data', addEncoderSizePrefix(getBytesEncoder(), getU32Encoder())],
    ['accountCount', getU8Encoder()],
  ])],
  ['accounts', getArrayEncoder(getStructEncoder([
    ['pubkey', getAddressEncoder()],
    ['isSigner', getBooleanEncoder()],
    ['isWritable', getBooleanEncoder()],
  ]), { size: getU32Encoder() })],
]);
function encodeEnvelope(instructionData: Uint8Array, accounts: { address: string; role: AccountRole }[]): Uint8Array {
  return new Uint8Array(
    envelopeEncoder.encode({
      calldata: { data: instructionData, accountCount: accounts.length },
      accounts: accounts.map((a) => ({ pubkey: a.address as never, isSigner: false, isWritable: false })),
    }),
  );
}

/** A real settle execution for `n` escrows, plus its Portal-envelope wrapping (full [buffer, ...user] list). */
function buildIntentFixture(n: number, opts: { minOut?: bigint } = {}) {
  const { minOut = 555n } = opts;
  const { bytecode, argsLayout } = compile(svmSettleSource(n), { target: 'svm', staged: true, treeshake: true, args: [0n, 0n, 0n, 0n] });
  const args = encodePayloadArgs(argsLayout!, [minOut, 1n, addressScalar(TOKENKEG), addressScalar(TOKEN_2022)]);
  const refs = svmSettleRefs(n);
  const addrByRef: Record<string, string> = {};
  refs.forEach((ref, i) => {
    addrByRef[ref] = ref === 'tokenProgram0' ? TOKENKEG : ref === 'tokenProgram1' ? TOKEN_2022 : makeAddr(i + 1);
  });
  const userMetas = refs.map((ref) => ({ address: addrByRef[ref] as never, role: AccountRole.READONLY }));
  const pin = sha256(bytecode[0]!);
  const ix = buildExecuteFromAccountInstruction({ programId: PROGRAM as never, buffer: BUFFER as never, accounts: userMetas, expectedSha256: pin, args });
  const envelope = encodeEnvelope((ix.data ?? new Uint8Array()) as Uint8Array, (ix.accounts ?? []).map((a) => ({ address: a.address as string, role: AccountRole.READONLY })));
  return { bytecode: bytecode[0]!, envelope, refs, addrByRef, minOut, n };
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

describe('decodePortalCalldataWithAccounts', () => {
  it('decodes a HAND-BUILT envelope byte-for-byte (independent layout pin)', () => {
    // [u32 data_len][data][u8 account_count][u32 accounts_len][ N×(32 pubkey + 1 isSigner + 1 isWritable) ]
    const bytes = new Uint8Array([
      ...u32le(3), 0xaa, 0xbb, 0xcc, // calldata.data = 0xaabbcc
      0x02, // calldata.account_count = 2
      ...u32le(2), // accounts vec len = 2
      ...new Array(32).fill(0x01), 0x01, 0x00, // acc0: pubkey 01*32, signer, !writable
      ...new Array(32).fill(0x02), 0x00, 0x01, // acc1: pubkey 02*32, !signer, writable
    ]);
    const decoded = decodePortalCalldataWithAccounts(bytes);
    expect(Array.from(decoded.instructionData)).toEqual([0xaa, 0xbb, 0xcc]);
    expect(decoded.accountCount).toBe(2);
    expect(decoded.accounts).toEqual([
      { pubkey: makeAddr(1), isSigner: true, isWritable: false },
      { pubkey: makeAddr(2), isSigner: false, isWritable: true },
    ]);
  });

  it('accepts the same envelope as 0x-hex and as base64', () => {
    const bytes = buildIntentFixture(1).envelope;
    const hex = ('0x' + Buffer.from(bytes).toString('hex'));
    const b64 = Buffer.from(bytes).toString('base64');
    const fromBytes = decodePortalCalldataWithAccounts(bytes);
    expect(decodePortalCalldataWithAccounts(hex).instructionData).toEqual(fromBytes.instructionData);
    expect(decodePortalCalldataWithAccounts(b64).accounts).toEqual(fromBytes.accounts);
  });
});

describe('extractSvmSettleFromIntent / extractSvmSettleFromCalls', () => {
  it('extracts args + resolved accounts from an intent (no bytecode → decode only)', () => {
    const fx = buildIntentFixture(2, { minOut: 4242n });
    const intent = { route: { calls: [{ data: fx.envelope }] } };
    const found = extractSvmSettleFromIntent(intent);
    expect(found).not.toBeNull();
    expect(found!.callIndex).toBe(0);
    expect(found!.escrowCount).toBe(2);
    expect(found!.hadBufferAccount).toBe(true); // the envelope carried the full [buffer, ...user] list
    expect(found!.args.minOut).toBe(4242n);
    expect(found!.args.tokenProgram0).toBe(TOKENKEG);
    expect(found!.accounts.owner).toBe(fx.addrByRef.owner);
    expect(found!.tokenProgramsConsistent).toBe(true);
    expect('genuine' in found!).toBe(false); // no verify without bytecode
  });

  it('verifies genuineness when the staged bytecode is supplied', () => {
    const fx = buildIntentFixture(2);
    const found = extractSvmSettleFromIntent({ route: { calls: [{ data: fx.envelope }] } }, { bytecode: fx.bytecode });
    expect(found).not.toBeNull();
    expect((found as { genuine: boolean }).genuine).toBe(true);
    expect((found as { pinMatchesBytecode: boolean }).pinMatchesBytecode).toBe(true);
  });

  it('finds the settle call by content within a mixed batch', () => {
    const settle = buildIntentFixture(1);
    // A non-settle call: a Portal envelope wrapping an unrelated 5-byte instruction + 2 accounts.
    const junk = encodeEnvelope(new Uint8Array([1, 2, 3, 4, 5]), [
      { address: makeAddr(9), role: AccountRole.READONLY },
      { address: makeAddr(10), role: AccountRole.READONLY },
    ]);
    const calls = [{ data: junk }, { data: settle.envelope }];
    const found = extractSvmSettleFromCalls(calls);
    expect(found!.callIndex).toBe(1);
    expect(found!.escrowCount).toBe(1);
  });

  it('returns null when no call carries a settle execution', () => {
    const junk = encodeEnvelope(new Uint8Array([9, 9, 9]), [{ address: makeAddr(7), role: AccountRole.READONLY }]);
    expect(extractSvmSettleFromCalls([{ data: junk }])).toBeNull();
    // A call that is not even a Portal envelope is skipped, not thrown.
    expect(extractSvmSettleFromCalls([{ data: '0x1234' }])).toBeNull();
  });
});
