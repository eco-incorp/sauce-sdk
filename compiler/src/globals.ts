import type { Expression, Literal, ArrayExpression, ObjectExpression, Property } from 'acorn';
import { keccak256, toBytes } from 'viem';
import { OPS, Saucer } from './saucer/index.js';
import type { VariableKind } from './context.js';
import { compile } from './index.js';

type PropertyCompile = (saucer: Saucer) => Saucer;
type MethodCompile = (saucer: Saucer, args: Expression[], process: (e: Expression) => Saucer) => Saucer;

export interface GlobalDef {
  kind: VariableKind;
  compile: PropertyCompile | MethodCompile;
}

const ABI_TYPE_SPECS: Record<string, number> = {
  bool: OPS.BYTE_1,
  address: OPS.BYTE_20,
  bytes: OPS.BYTES,
  string: OPS.BYTES,
  ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`uint${(i + 1) * 8}`, OPS.BYTE_1 + i])),
};

const resolveAbiTypeSpec = (arg: Expression): number[] => {
  if (arg.type === 'Literal' && typeof (arg as Literal).value === 'string') {
    const name = (arg as Literal).value as string;
    const spec = ABI_TYPE_SPECS[name];

    if (!spec) throw new Error(`unknown ABI type: '${name}'`);

    return [spec];
  }

  if (arg.type === 'ObjectExpression') {
    const obj = arg as ObjectExpression;
    const sorted = (obj.properties as Property[])
      .map((prop) => {
        if (prop.type !== 'Property') throw new Error('spread properties are not supported');

        const key =
          prop.key.type === 'Identifier' ? (prop.key as { name: string }).name : String((prop.key as Literal).value);

        return { key, value: prop.value as Expression };
      })
      .sort((a, b) => a.key.localeCompare(b.key));

    const inner = sorted.flatMap((p) => resolveAbiTypeSpec(p.value));

    return [OPS.TUPLE, sorted.length, ...inner];
  }

  if (arg.type === 'ArrayExpression') {
    const arr = arg as ArrayExpression;

    if (arr.elements.length !== 1) throw new Error('array type spec must have exactly 1 element type');

    return [OPS.ARRAY, ...resolveAbiTypeSpec(arr.elements[0] as Expression)];
  }

  throw new Error('abi.decode type arguments must be string literals, objects, or arrays');
};

const extractByteLiteral = (el: ArrayExpression['elements'][number]): number => {
  if (!el || el.type !== 'Literal') throw new Error('Uint8Array elements must be number literals');

  const v = (el as Literal).value;

  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255)
    throw new Error('Uint8Array elements must be integers 0-255');

  return v;
};

const expectArity = (name: string, expected: number, args: Expression[]): void => {
  if (args.length !== expected)
    throw new Error(
      `${name} expects ${expected === 1 ? 'exactly 1 argument' : `${expected} argument(s), got ${args.length}`}`,
    );
};

// --- emit() helpers ---

interface EmitArgs {
  signature: string;
  fields: Map<string, Expression>;
  indexedNames: string[];
}

const parseEmitArgs = (args: Expression[]): EmitArgs => {
  if (args.length < 1) throw new Error('emit() requires at least a signature');

  if (args[0].type !== 'Literal' || typeof (args[0] as Literal).value !== 'string')
    throw new Error('emit() signature must be a string literal');

  const signature = (args[0] as Literal).value as string;

  if (args.length > 1 && args[1].type !== 'ObjectExpression') throw new Error('emit() data must be an object literal');

  const fields =
    args.length > 1
      ? ((args[1] as ObjectExpression).properties as Property[]).reduce((map, prop) => {
          const key =
            prop.key.type === 'Identifier' ? (prop.key as { name: string }).name : String((prop.key as Literal).value);

          return map.set(key, prop.value as Expression);
        }, new Map<string, Expression>())
      : new Map<string, Expression>();

  const indexedNames = args.slice(2).map((arg) => {
    if (arg.type !== 'Literal' || typeof (arg as Literal).value !== 'string')
      throw new Error('indexed field names must be string literals');

    return (arg as Literal).value as string;
  });

  if (indexedNames.length > 3) throw new Error('emit() supports at most 3 indexed fields');

  return { signature, fields, indexedNames };
};

const buildTopics = (
  s: Saucer,
  signature: string,
  fields: Map<string, Expression>,
  indexedNames: string[],
  process: (e: Expression) => Saucer,
): Saucer[] => {
  const topic0 = new Saucer(s.ctx).int(BigInt(keccak256(toBytes(signature))));

  return [
    topic0,
    ...indexedNames.map((name) => {
      if (!fields.has(name)) throw new Error(`indexed field '${name}' not found in data`);

      return process(fields.get(name)!);
    }),
  ];
};

const buildData = (
  s: Saucer,
  fields: Map<string, Expression>,
  indexedNames: string[],
  process: (e: Expression) => Saucer,
): Saucer => {
  const nonIndexed = [...fields.entries()]
    .filter(([name]) => !indexedNames.includes(name))
    .map(([, expr]) => process(expr));

  return nonIndexed.length > 0
    ? s.abiEncode(new Saucer(s.ctx).tuple(nonIndexed))
    : new Saucer(s.ctx).bytes(new Uint8Array());
};

// Each global maps method/property names to { kind, compile }.
// Properties (compile.length === 1) are accessed as member expressions.
// Methods (compile.length === 3) are called with arguments.
// Add new globals here — the compiler dispatches automatically.
export const GLOBALS: Record<string, Record<string, GlobalDef>> = {
  // Math.sqrt(x) — integer square root
  //   Math.sqrt(16)  => 4
  //   Math.sqrt(10)  => 3
  //
  // Math.mulDiv(a, b, denominator) — full-precision a*b/denominator (floored)
  //   computes floor(a * b / denominator) in 512-bit precision (no intermediate overflow)
  //   Math.mulDiv(100, 50, 25)  => 200
  //
  // Math.neg(x) — two's-complement negation (wrapping), i.e. the int256 value -x
  //   for signed params like Uniswap amountSpecified (negative = exact input)
  Math: {
    sqrt: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('Math.sqrt', 1, args);

        return s.sqrt(process(args[0]));
      },
    },
    mulDiv: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('Math.mulDiv', 3, args);

        return s.mulDiv(process(args[0]), process(args[1]), process(args[2]));
      },
    },
    neg: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('Math.neg', 1, args);

        return s.neg(process(args[0]));
      },
    },
  },

  // crypto.keccak256(data) — compute keccak256 hash
  //   crypto.keccak256(msg.data)
  //   crypto.keccak256(Uint8Array.from([0x01, 0x02]))
  //
  // crypto.ecdsaVerify(signer, hash, signature) — verify ECDSA signature (EOA or EIP-1271)
  //   crypto.ecdsaVerify(signerAddress, messageHash, sig) => 1 if valid, 0 if invalid
  crypto: {
    keccak256: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('crypto.keccak256', 1, args);

        return s.keccak256(process(args[0]));
      },
    },
    ecdsaVerify: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('crypto.ecdsaVerify', 3, args);

        return s.ecdsaVerify(process(args[0]), process(args[1]), process(args[2]));
      },
    },
  },

  // storage.read(slot) — load value from persistent storage
  //   storage.read(0) => value at slot 0
  //
  // storage.write(slot, value) — store value to persistent storage
  //   storage.write(0, 42) => stores 42 at slot 0, returns 42
  //
  // storage.tRead(key) — load value from transient storage (EIP-1153)
  //   storage.tRead(0) => value at key 0
  //
  // storage.tWrite(key, value) — store value to transient storage (EIP-1153)
  //   storage.tWrite(0, 42) => stores 42 at key 0, returns 42
  storage: {
    read: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('storage.read', 1, args);

        return s.sload(process(args[0]));
      },
    },
    write: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('storage.write', 2, args);

        return s.sstore(process(args[0]), process(args[1]));
      },
    },
    tRead: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('storage.tRead', 1, args);

        return s.tload(process(args[0]));
      },
    },
    tWrite: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('storage.tWrite', 2, args);

        return s.tstore(process(args[0]), process(args[1]));
      },
    },
  },

  // Uint8Array.from([...]) — create a byte array from numeric elements
  //   Uint8Array.from([0xaa, 0xbb, 0xcc])
  Uint8Array: {
    from: {
      kind: 'dynamic',
      compile: (s: Saucer, args: Expression[], _process: (e: Expression) => Saucer) => {
        if (args.length !== 1) throw new Error('Uint8Array expects exactly 1 argument');

        if (args[0].type !== 'ArrayExpression') throw new Error('Uint8Array expects an array literal');

        const bytes = new Uint8Array((args[0] as ArrayExpression).elements.map(extractByteLiteral));

        return s.bytes(bytes);
      },
    },
  },

  // abi.encode(...args) — ABI-encode values into bytes
  //   abi.encode(42)
  //   abi.encode(1, "hello", [10, 20])
  //   abi.encode({ id: 1, name: "alice" })
  //
  // abi.decode(data, ...typeSpecs) — ABI-decode bytes into a tuple
  //   abi.decode(data, "uint256")
  //   abi.decode(data, "uint256", "string")
  //   abi.decode(data, "uint256", { id: "uint256", name: "string" })
  //   abi.decode(data, ["uint256"])
  //
  //   Supported type strings: uint8–uint256, bool, address, bytes, string
  //   Nested specs: { field: typeSpec } for structs, [typeSpec] for arrays
  abi: {
    encode: {
      kind: 'dynamic',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        if (args.length === 0) throw new Error('abi.encode expects at least 1 argument');

        const tuple =
          args.length === 1 && args[0].type === 'ObjectExpression'
            ? process(args[0])
            : new Saucer(s.ctx).tuple(args.map(process));

        return s.abiEncode(tuple);
      },
    },
    decode: {
      kind: 'dynamic',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        if (args.length < 2) throw new Error('abi.decode expects data and at least 1 type argument');

        const data = process(args[0]);
        const count = args.length - 1;
        const typeSpecs = args.slice(1).flatMap(resolveAbiTypeSpec);

        return s.abiDecode(count, data, typeSpecs);
      },
    },
  },

  // msg.sender  — caller address (uint256)
  // msg.value   — wei sent with the call (uint256)
  // msg.data    — raw calldata (bytes)
  msg: {
    sender: { kind: 'scalar', compile: (s: Saucer) => s.msgSender() },
    value: { kind: 'scalar', compile: (s: Saucer) => s.msgValue() },
    data: { kind: 'dynamic', compile: (s: Saucer) => s.msgData() },
  },

  // block.number      — current block number
  // block.timestamp    — current block timestamp (seconds since epoch)
  // block.coinbase     — block miner/validator address
  // block.prevrandao   — previous RANDAO value
  // block.gasLimit     — block gas limit
  // block.baseFee      — base fee per gas (EIP-1559)
  // block.blobBaseFee  — blob base fee (EIP-4844)
  // block.chainId      — chain ID (e.g. 1 for mainnet, 31337 for anvil)
  block: {
    number: { kind: 'scalar', compile: (s: Saucer) => s.blockNumber() },
    timestamp: { kind: 'scalar', compile: (s: Saucer) => s.blockTimestamp() },
    coinbase: { kind: 'scalar', compile: (s: Saucer) => s.blockCoinbase() },
    prevrandao: { kind: 'scalar', compile: (s: Saucer) => s.blockPrevrandao() },
    gasLimit: { kind: 'scalar', compile: (s: Saucer) => s.blockGasLimit() },
    baseFee: { kind: 'scalar', compile: (s: Saucer) => s.blockBaseFee() },
    blobBaseFee: { kind: 'scalar', compile: (s: Saucer) => s.blockBlobBaseFee() },
    chainId: { kind: 'scalar', compile: (s: Saucer) => s.blockChainId() },
  },

  // tx.origin    — transaction originator address
  // tx.gasPrice  — gas price of the transaction
  tx: {
    origin: { kind: 'scalar', compile: (s: Saucer) => s.txOrigin() },
    gasPrice: { kind: 'scalar', compile: (s: Saucer) => s.txGasPrice() },
  },

  // address.self               — this contract's address
  // address.balance            — this contract's ETH balance (wei)
  // address.balanceOf(addr)    — ETH balance of addr (wei)
  // address.codeSize(addr)     — deployed code size of addr (bytes)
  // address.codeHash(addr)     — keccak256 hash of addr's code
  // address.isContract(addr)   — 1 if addr has code, 0 otherwise
  // address.isEOA(addr)        — 1 if addr has no code, 0 otherwise
  address: {
    self: { kind: 'scalar', compile: (s: Saucer) => s.addressSelf() },
    balance: { kind: 'scalar', compile: (s: Saucer) => s.addressBalance() },
    balanceOf: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('address.balanceOf()', 1, args);

        return s.balanceOf(process(args[0]));
      },
    },
    codeSize: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('address.codeSize()', 1, args);

        return s.codeSize(process(args[0]));
      },
    },
    codeHash: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('address.codeHash()', 1, args);

        return s.codeHash(process(args[0]));
      },
    },
    isContract: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('address.isContract()', 1, args);

        return s.isContract(process(args[0]));
      },
    },
    isEOA: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('address.isEOA()', 1, args);

        return s.isEOA(process(args[0]));
      },
    },
  },

  // contract.call(target, value, calldata)             — raw external call
  // contract.static(target, calldata)                  — raw static call (read-only)
  // contract.delegate(target, calldata)                — raw delegate call
  // contract.create(value, bytecode)                   — deploy contract with CREATE
  // contract.create2(value, salt, bytecode)            — deploy contract with CREATE2
  // contract.create3(value, salt, bytecode)            — deploy contract with CREATE3
  // contract.predictCreate(deployer, nonce)            — predict CREATE address
  // contract.predictCreate2(deployer, salt, codeHash)  — predict CREATE2 address
  // contract.predictCreate3(salt)                      — predict CREATE3 address
  contract: {
    call: {
      kind: 'dynamic',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('contract.call', 3, args);

        return s.externalCall(process(args[0]), process(args[1]), process(args[2]));
      },
    },
    static: {
      kind: 'dynamic',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('contract.static', 2, args);

        return s.staticCall(process(args[0]), process(args[1]));
      },
    },
    delegate: {
      kind: 'dynamic',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('contract.delegate', 2, args);

        return s.delegateCall(process(args[0]), process(args[1]));
      },
    },
    create: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('contract.create', 2, args);

        return s.create(process(args[0]), process(args[1]));
      },
    },
    create2: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('contract.create2', 3, args);

        return s.create2(process(args[0]), process(args[1]), process(args[2]));
      },
    },
    create3: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('contract.create3', 3, args);

        return s.create3(process(args[0]), process(args[1]), process(args[2]));
      },
    },
    predictCreate: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('contract.predictCreate', 2, args);

        return s.createAddress(process(args[0]), process(args[1]));
      },
    },
    predictCreate2: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('contract.predictCreate2', 3, args);

        return s.create2Address(process(args[0]), process(args[1]), process(args[2]));
      },
    },
    predictCreate3: {
      kind: 'scalar',
      compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
        expectArity('contract.predictCreate3', 1, args);

        return s.create3Address(process(args[0]));
      },
    },
  },
};

// Standalone global functions (called without a namespace).
//
// gasLeft()              — remaining gas
// blockHash(blockNumber) — hash of the given block (0 for current or too old)
//   blockHash(block.number - 1)
// blobHash(index)        — versioned hash of the blob at index (EIP-4844)
//   blobHash(0)
// eval(code)             — compile and execute JS code at runtime
//   eval("return 42")
//   eval("let x = 10; return x * 2")
//   Code is compiled at compile-time; argument must be a string literal.
//   If code contains `function main`, it's compiled as-is; otherwise wrapped.
export const GLOBAL_FUNCTIONS: Record<string, GlobalDef> = {
  gasLeft: {
    kind: 'scalar',
    compile: (s: Saucer, args: Expression[], _process: (e: Expression) => Saucer) => {
      expectArity('gasLeft()', 0, args);

      return s.gasLeft();
    },
  },
  blockHash: {
    kind: 'scalar',
    compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
      expectArity('blockHash()', 1, args);

      return s.blockHash(process(args[0]));
    },
  },
  blobHash: {
    kind: 'scalar',
    compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
      expectArity('blobHash()', 1, args);

      return s.blobHash(process(args[0]));
    },
  },
  // emit(signature, data?, ...indexedFields) — emit a Solidity-style event
  //   emit("Ping()")  — event with no fields
  //   emit("Foo(uint256)", {value: 42})  — event with data
  //   emit("Transfer(address,address,uint256)", {from, to, value}, "from", "to")  — with indexed
  emit: {
    kind: 'scalar',
    compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
      const { signature, fields, indexedNames } = parseEmitArgs(args);
      const topics = buildTopics(s, signature, fields, indexedNames, process);
      const data = buildData(s, fields, indexedNames, process);

      return s.log(data, topics);
    },
  },
  eval: {
    kind: 'scalar',
    compile: (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => {
      expectArity('eval()', 1, args);

      // String literal: compile at compile time
      if (args[0].type === 'Literal' && typeof (args[0] as Literal).value === 'string') {
        const code = (args[0] as Literal).value as string;
        const source = /function\s+main\s*\(/.test(code) ? code : `function main() { ${code} }`;
        const { bytecode } = compile(source);

        return s.eval(new Saucer(s.ctx).bytes(bytecode[0]));
      }

      // Dynamic: pass runtime bytecodes to EVAL opcode
      return s.eval(process(args[0]));
    },
  },
};

export const RESERVED_NAMES: Set<string> = new Set([...Object.keys(GLOBALS), ...Object.keys(GLOBAL_FUNCTIONS)]);
