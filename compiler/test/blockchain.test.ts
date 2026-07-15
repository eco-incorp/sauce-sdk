import { compile } from '../src/index.js';
import { OPS } from '../src/saucer/index.js';

describe('blockchain context', () => {
  it('compiles msg.sender', () => {
    const result = compile('function main() { const x = msg.sender; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.MSG_SENDER]));
  });

  it('compiles msg.value', () => {
    const result = compile('function main() { const x = msg.value; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.CALL_VALUE]));
  });

  it('compiles msg.data to heap slot', () => {
    const result = compile('function main() { const data = msg.data; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_HEAP, 1, OPS.WRITE_HEAP, 0, OPS.CALLDATA]));
  });

  it('compiles block.number', () => {
    const result = compile('function main() { const x = block.number; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.BLOCK_NUMBER]));
  });

  it('compiles block.timestamp', () => {
    const result = compile('function main() { const x = block.timestamp; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.TIMESTAMP]));
  });

  it('compiles block.coinbase', () => {
    const result = compile('function main() { const x = block.coinbase; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.COINBASE]));
  });

  it('compiles block.prevrandao', () => {
    const result = compile('function main() { const x = block.prevrandao; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.PREVRANDAO]));
  });

  it('compiles block.gasLimit', () => {
    const result = compile('function main() { const x = block.gasLimit; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.GAS_LIMIT]));
  });

  it('compiles block.baseFee', () => {
    const result = compile('function main() { const x = block.baseFee; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.BASE_FEE]));
  });

  it('compiles block.blobBaseFee', () => {
    const result = compile('function main() { const x = block.blobBaseFee; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.BLOB_BASE_FEE]));
  });

  it('compiles block.chainId', () => {
    const result = compile('function main() { const x = block.chainId; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.CHAIN_ID]));
  });

  it('compiles tx.origin', () => {
    const result = compile('function main() { const x = tx.origin; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.TX_ORIGIN]));
  });

  it('compiles tx.gasPrice', () => {
    const result = compile('function main() { const x = tx.gasPrice; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.GAS_PRICE]));
  });

  it('compiles address.self', () => {
    const result = compile('function main() { const x = address.self; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.THIS_ADDRESS]));
  });

  it('compiles address.balance', () => {
    const result = compile('function main() { const x = address.balance; }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.SELF_BALANCE]));
  });

  it('compiles gasLeft()', () => {
    const result = compile('function main() { const g = gasLeft(); }');
    expect(result.bytecode[0]).toEqual(new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.GAS_LEFT]));
  });

  it('compiles blockHash(n)', () => {
    const result = compile('function main() { const h = blockHash(100); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.BLOCK_HASH, OPS.BYTE_1, 100]),
    );
  });

  it('compiles blobHash(n)', () => {
    const result = compile('function main() { const h = blobHash(0); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.BLOB_HASH, OPS.BYTE_1, 0]),
    );
  });

  it('compiles address.balanceOf(addr)', () => {
    const result = compile('function main() { const b = address.balanceOf(42); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.BALANCE, OPS.BYTE_1, 42]),
    );
  });

  it('compiles address.codeSize(addr)', () => {
    const result = compile('function main() { const s = address.codeSize(42); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.EXT_CODE_SIZE, OPS.BYTE_1, 42]),
    );
  });

  it('compiles address.codeHash(addr)', () => {
    const result = compile('function main() { const h = address.codeHash(42); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.EXT_CODE_HASH, OPS.BYTE_1, 42]),
    );
  });

  it('compiles address.isContract(addr)', () => {
    const result = compile('function main() { const c = address.isContract(42); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.IS_CONTRACT, OPS.BYTE_1, 42]),
    );
  });

  it('compiles address.isEOA(addr)', () => {
    const result = compile('function main() { const e = address.isEOA(42); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.IS_EOA, OPS.BYTE_1, 42]),
    );
  });

  it('compiles context in arithmetic expression', () => {
    const result = compile('function main() { const x = block.number + 1; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.ADD, OPS.BLOCK_NUMBER, OPS.BYTE_1, 1]),
    );
  });

  it('compiles blockHash with variable argument', () => {
    const result = compile('function main() { const n = 10; const h = blockHash(n); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        2,
        OPS.WRITE_VALUE,
        0,
        OPS.BYTE_1,
        10,
        OPS.WRITE_VALUE,
        1,
        OPS.BLOCK_HASH,
        OPS.READ_VALUE,
        0,
      ]),
    );
  });

  it('throws on gasLeft with arguments', () => {
    expect(() => compile('function main() { const g = gasLeft(1); }')).toThrow(
      'gasLeft() expects 0 argument(s), got 1',
    );
  });

  it('throws on blockHash with no arguments', () => {
    expect(() => compile('function main() { const h = blockHash(); }')).toThrow(
      'blockHash() expects exactly 1 argument',
    );
  });

  it('throws on address.balanceOf with no arguments', () => {
    expect(() => compile('function main() { const b = address.balanceOf(); }')).toThrow(
      'address.balanceOf() expects exactly 1 argument',
    );
  });

  it('throws on variable named msg', () => {
    expect(() => compile('function main() { const msg = 5; }')).toThrow("'msg' is a reserved name");
  });

  it('throws on variable named block', () => {
    expect(() => compile('function main() { const block = 5; }')).toThrow("'block' is a reserved name");
  });

  it('throws on function named tx', () => {
    // Called from main — treeshake defaults to true, so an unreferenced function is
    // dropped (never compiled, never validated); this must stay reachable to fire.
    expect(() => compile('function tx() { return 1; }\nfunction main() { return tx(); }')).toThrow(
      "'tx' is a reserved name",
    );
  });

  it('throws on function parameter named address', () => {
    // Called from main — see the 'tx' comment above.
    expect(() => compile('function foo(address) { return address; }\nfunction main() { return foo(1); }')).toThrow(
      "'address' is a reserved name",
    );
  });

  it('throws on variable named Math', () => {
    expect(() => compile('function main() { const Math = 5; }')).toThrow("'Math' is a reserved name");
  });

  it('throws on variable named gasLeft', () => {
    expect(() => compile('function main() { const gasLeft = 5; }')).toThrow("'gasLeft' is a reserved name");
  });

  it('throws on variable named Uint8Array', () => {
    expect(() => compile('function main() { const Uint8Array = 5; }')).toThrow("'Uint8Array' is a reserved name");
  });

  it('throws on variable named abi', () => {
    expect(() => compile('function main() { const abi = 5; }')).toThrow("'abi' is a reserved name");
  });

  it('throws on variable named blockHash', () => {
    expect(() => compile('function main() { const blockHash = 5; }')).toThrow("'blockHash' is a reserved name");
  });

  it('throws on variable named blobHash', () => {
    expect(() => compile('function main() { const blobHash = 5; }')).toThrow("'blobHash' is a reserved name");
  });

  it('throws on calling a property as a method', () => {
    expect(() => compile('function main() { const x = msg.sender(); }')).toThrow('not implemented: msg.sender');
  });

  it('throws on blobHash with no arguments', () => {
    expect(() => compile('function main() { const h = blobHash(); }')).toThrow('blobHash() expects exactly 1 argument');
  });

  it('throws on Math.sqrt with no arguments', () => {
    expect(() => compile('function main() { const x = Math.sqrt(); }')).toThrow('Math.sqrt expects exactly 1 argument');
  });

  it('throws on unknown global property', () => {
    expect(() => compile('function main() { const x = msg.foo(); }')).toThrow('not implemented: msg.foo');
  });

  // crypto tests
  it('compiles crypto.keccak256 with bytes', () => {
    const result = compile('function main() { const h = crypto.keccak256(msg.data); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.KECCAK256, OPS.CALLDATA]),
    );
  });

  it('throws on crypto.keccak256 with no arguments', () => {
    expect(() => compile('function main() { const h = crypto.keccak256(); }')).toThrow(
      'crypto.keccak256 expects exactly 1 argument',
    );
  });

  it('compiles crypto.ecdsaVerify', () => {
    const result = compile('function main() { const valid = crypto.ecdsaVerify(42, 100, msg.data); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        1,
        OPS.WRITE_VALUE,
        0,
        OPS.ECDSA_VERIFY,
        OPS.BYTE_1,
        42,
        OPS.BYTE_1,
        100,
        OPS.CALLDATA,
      ]),
    );
  });

  it('throws on crypto.ecdsaVerify with wrong arity', () => {
    expect(() => compile('function main() { const v = crypto.ecdsaVerify(1, 2); }')).toThrow(
      'crypto.ecdsaVerify expects 3 argument(s), got 2',
    );
  });

  it('throws on variable named crypto', () => {
    expect(() => compile('function main() { const crypto = 5; }')).toThrow("'crypto' is a reserved name");
  });

  // storage tests
  it('compiles storage.read', () => {
    const result = compile('function main() { const v = storage.read(0); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.SLOAD, OPS.BYTE_1, 0]),
    );
  });

  it('compiles storage.write', () => {
    const result = compile('function main() { const v = storage.write(0, 42); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.SSTORE, OPS.BYTE_1, 0, OPS.BYTE_1, 42]),
    );
  });

  it('compiles storage.tRead', () => {
    const result = compile('function main() { const v = storage.tRead(0); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.TLOAD, OPS.BYTE_1, 0]),
    );
  });

  it('compiles storage.tWrite', () => {
    const result = compile('function main() { const v = storage.tWrite(0, 42); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.TSTORE, OPS.BYTE_1, 0, OPS.BYTE_1, 42]),
    );
  });

  it('throws on storage.read with wrong arity', () => {
    expect(() => compile('function main() { const v = storage.read(); }')).toThrow(
      'storage.read expects exactly 1 argument',
    );
  });

  it('throws on storage.write with wrong arity', () => {
    expect(() => compile('function main() { const v = storage.write(0); }')).toThrow(
      'storage.write expects 2 argument(s), got 1',
    );
  });

  it('throws on variable named storage', () => {
    expect(() => compile('function main() { const storage = 5; }')).toThrow("'storage' is a reserved name");
  });

  // contract.* tests
  it('compiles contract.create', () => {
    const result = compile('function main() { const a = contract.create(0, Uint8Array.from([0x60, 0x00])); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.CREATE, OPS.BYTE_1, 0, OPS.BYTES, 2, 0x60, 0x00]),
    );
  });

  it('compiles contract.create2', () => {
    const result = compile('function main() { const a = contract.create2(0, 123, Uint8Array.from([0x60, 0x00])); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        1,
        OPS.WRITE_VALUE,
        0,
        OPS.CREATE2,
        OPS.BYTE_1,
        0,
        OPS.BYTE_1,
        123,
        OPS.BYTES,
        2,
        0x60,
        0x00,
      ]),
    );
  });

  it('compiles contract.create3', () => {
    const result = compile('function main() { const a = contract.create3(0, 456, Uint8Array.from([0x60, 0x00])); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        1,
        OPS.WRITE_VALUE,
        0,
        OPS.CREATE3,
        OPS.BYTE_1,
        0,
        OPS.BYTE_2,
        1,
        200,
        OPS.BYTES,
        2,
        0x60,
        0x00,
      ]),
    );
  });

  it('compiles contract.predictCreate', () => {
    const result = compile('function main() { const a = contract.predictCreate(42, 1); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.CREATE_ADDRESS, OPS.BYTE_1, 42, OPS.BYTE_1, 1]),
    );
  });

  it('compiles contract.predictCreate2', () => {
    const result = compile('function main() { const a = contract.predictCreate2(42, 123, 456); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        1,
        OPS.WRITE_VALUE,
        0,
        OPS.CREATE2_ADDRESS,
        OPS.BYTE_1,
        42,
        OPS.BYTE_1,
        123,
        OPS.BYTE_2,
        1,
        200,
      ]),
    );
  });

  it('compiles contract.predictCreate3', () => {
    const result = compile('function main() { const a = contract.predictCreate3(99); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.CREATE3_ADDRESS, OPS.BYTE_1, 99]),
    );
  });

  it('throws on contract.create with wrong arity', () => {
    expect(() => compile('function main() { const a = contract.create(0); }')).toThrow(
      'contract.create expects 2 argument(s), got 1',
    );
  });

  it('throws on contract.predictCreate3 with wrong arity', () => {
    expect(() => compile('function main() { const a = contract.predictCreate3(); }')).toThrow(
      'contract.predictCreate3 expects exactly 1 argument',
    );
  });

  it('throws on variable named contract', () => {
    expect(() => compile('function main() { const contract = 5; }')).toThrow("'contract' is a reserved name");
  });

  // emit tests
  it('compiles emit with signature and data', () => {
    const result = compile('function main() { emit("Foo(uint256)", {value: 42}); }');
    // LOG with 1 topic (signature hash), data is ABI-encoded {value: 42}
    expect(result.bytecode[0]).toContain(OPS.LOG);
    // Topic0 should be the keccak256 hash (32 bytes)
    expect(result.bytecode[0]).toContain(OPS.BYTE_32);
  });

  it('compiles emit with indexed fields', () => {
    const result = compile('function main() { emit("Transfer(address,uint256)", {to: 1, value: 42}, "to"); }');
    // LOG with 2 topics (signature hash + indexed "to")
    expect(result.bytecode[0]).toContain(OPS.LOG);
  });

  it('throws on emit with non-string signature', () => {
    expect(() => compile('function main() { emit(123, {value: 1}); }')).toThrow(
      'emit() signature must be a string literal',
    );
  });

  it('throws on emit with non-object data', () => {
    expect(() => compile('function main() { emit("Foo()", 123); }')).toThrow('emit() data must be an object literal');
  });

  it('throws on emit with more than 3 indexed fields', () => {
    expect(() =>
      compile('function main() { emit("Foo(uint256,uint256,uint256,uint256)", {a:1,b:2,c:3,d:4}, "a","b","c","d"); }'),
    ).toThrow('emit() supports at most 3 indexed fields');
  });

  it('throws on emit with unknown indexed field', () => {
    expect(() => compile('function main() { emit("Foo(uint256)", {value: 1}, "unknown"); }')).toThrow(
      "indexed field 'unknown' not found in data",
    );
  });

  it('throws on variable named emit', () => {
    expect(() => compile('function main() { const emit = 5; }')).toThrow("'emit' is a reserved name");
  });

  it('throws on emit with no arguments', () => {
    expect(() => compile('function main() { emit(); }')).toThrow('emit() requires at least a signature');
  });

  it('compiles emit with no data (empty event)', () => {
    const result = compile('function main() { emit("Ping()"); }');
    expect(result.bytecode[0]).toContain(OPS.LOG);
  });

  // eval tests
  it('compiles eval with string literal', () => {
    const result = compile('function main() { const x = eval("return 42"); }');
    expect(result.bytecode[0][0]).toBe(OPS.ALLOCATE_VALUE);
    expect(result.bytecode[0]).toContain(OPS.EVAL);
  });

  it('compiles eval with non-string argument (dynamic eval)', () => {
    const result = compile('function main() { const x = eval(42); }');
    expect(result.bytecode[0]).toContain(OPS.EVAL);
  });

  it('compiles eval with variable argument (dynamic eval)', () => {
    const result = compile('function main() { const code = "return 1"; const x = eval(code); }');
    expect(result.bytecode[0]).toContain(OPS.EVAL);
  });

  it('throws on variable named eval (strict mode)', () => {
    expect(() => compile('function main() { const eval = 5; }')).toThrow('Binding eval in strict mode');
  });
});
