import * as fs from 'fs';
import * as path from 'path';
import type { Abi, ContractInfo, ContractsConfig } from './contracts.js';
import { parseAbiMethods } from './contracts.js';
import { RESERVED_NAMES } from './globals.js';
import { Saucer } from './saucer/saucer.js';
import { V12Saucer } from './saucer/saucer-v12.js';
import type { SaucerLike } from './saucer/saucer-like.js';

export type CompileTarget = 'v1' | 'v12';

export type VariableKind = 'scalar' | 'dynamic';

export interface ElementType {
  kind: VariableKind;
  element?: ElementType; // Nested element type for arrays of arrays
  structType?: StructType; // For structs: the field names
}

export interface StructType {
  fields: string[]; // Sorted alphabetically
  fieldStructTypes?: (StructType | undefined)[]; // Struct type for each field (parallel to fields array)
}

export interface Variable {
  name: string;
  slot: number;
  kind: VariableKind;
  elementType?: ElementType; // For arrays: the full element type chain
  structType?: StructType; // For structs: the field names
  /** v12: a function parameter (lives on the EVM stack, not a memory slot). */
  isParam?: boolean;
  /**
   * Holds a static packed array literal (`[1, 2, 3]`) — element-width-packed and
   * IMMUTABLE in the engine, which reverts SET_INDEX on it. Element assignment
   * (`arr[i] = x`) requires a mutable collection (`new Array(n)` / object literal,
   * both TUPLE), so the lowering rejects assignment to a flagged variable.
   */
  immutablePacked?: boolean;
}

export interface Scope {
  variables: Map<string, Variable>;
  parent?: Scope;
}

/** v12: per-function build artifacts collected during processing, assembled by compile(). */
export interface FunctionMeta {
  name: string;
  isMain: boolean;
  paramCount: number;
  saucer: V12Saucer;
}

/** State shared across a v12 module's per-function child contexts. */
interface SharedModule {
  functions: string[];
  contracts: Map<string, ContractInfo>;
  funcMeta: FunctionMeta[];
}

export class CompilerContext {
  readonly warnings: string[] = [];
  readonly target: CompileTarget;
  private scopes: Scope[] = [];
  private loopDepth = 0;
  private nextValueSlot = 0;
  private nextHeapSlot = 0;
  private nextTempId = 0;
  // High-water marks: the ALLOCATE_VALUE/ALLOCATE_HEAP prefix must cover the largest
  // slot INDEX ever used (slots are reused across non-overlapping scopes, so the
  // live count is far below the total declared). Slot indices are 1 byte, so >255
  // distinct LIVE slots would wrap — slot reuse keeps real programs well under that.
  private maxValueSlot = 0;
  private maxHeapSlot = 0;
  // Free-lists of slot indices released when a scope pops (its locals go out of
  // scope, so a later sibling scope can reuse the slot). SauceScript has no
  // closures, so a block-scoped local can never be read after its scope ends.
  private freeValueSlots: number[] = [];
  private freeHeapSlots: number[] = [];

  /** Module-level state, shared across a v12 module's per-function contexts. */
  private readonly module: SharedModule;
  private baseDirs: string[];
  private pendingContractBinding?: { contractName: string; callTypeOverride?: 'static' | 'delegate' };
  private boundContracts: Map<string, { contract: ContractInfo; callTypeOverride?: 'static' | 'delegate' }> = new Map();

  // v12: function parameters live on the EVM stack (not memory slots). This tracks
  // the per-function stack layout so reads/writes resolve to SDUP/SSWAP positions.
  private stackDepth = 0;
  private stackVars: Map<string, number> = new Map();

  /**
   * v12: true while compiling main()'s body. main is INLINED (no call frame,
   * terminated by the assembly's trailing STOP), so its `return` just leaves the
   * value on the stack. A HELPER is entered via CALL_FUNCTION, so EVERY `return`
   * in it must emit FUNC_RETURN to pop its frame+params and jump back — including
   * an EARLY return inside a conditional, which otherwise just leaks the value and
   * falls through into the rest of the body (corrupting the stack — see
   * V12Saucer.return).
   */
  isMainFunction = true;

  /** Type info for main() function parameters, inferred from args option */
  mainArgTypes?: { kind: VariableKind; elementType?: ElementType }[];

  constructor(
    baseDirs: string[] = [],
    contracts: ContractsConfig = {},
    target: CompileTarget = 'v1',
    shared?: SharedModule,
  ) {
    this.scopes.push({ variables: new Map() });
    this.baseDirs = baseDirs;
    this.target = target;
    this.module = shared ?? { functions: [], contracts: new Map(), funcMeta: [] };

    for (const [name, config] of Object.entries(contracts)) {
      this.registerContract(name, config.abi);
    }
  }

  get isV12(): boolean {
    return this.target === 'v12';
  }

  /** The function index table (shared across a v12 module's contexts). */
  get functions(): string[] {
    return this.module.functions;
  }

  /** v12: per-function build artifacts collected during processing. */
  get funcMeta(): FunctionMeta[] {
    return this.module.funcMeta;
  }

  /** Target-aware builder factory — the seam that keeps the processor agnostic. */
  newSaucer(): SaucerLike {
    return this.target === 'v12' ? new V12Saucer(this) : new Saucer(this);
  }

  /**
   * v12: a child context for compiling one function body — fresh slots, scopes
   * and stack tracker, but a SHARED module (function index table, contracts,
   * collected metadata) so calls resolve across functions.
   */
  forFunction(): CompilerContext {
    return new CompilerContext(this.baseDirs, {}, this.target, this.module);
  }

  recordFunction(meta: FunctionMeta): void {
    this.module.funcMeta.push(meta);
  }

  // ── v12 stack-variable tracking ──

  /** Push a named value onto the (tracked) EVM stack — e.g. a function param. */
  pushStack(name: string): void {
    this.stackDepth++;

    if (name) this.stackVars.set(name, this.stackDepth);
  }

  /** Absolute 1-indexed stack position of a tracked variable (0 = not found). */
  getStackVarPos(name: string): number {
    return this.stackVars.get(name) ?? 0;
  }

  /** Relative-from-top position of a tracked variable (0 = not found). */
  findStackVar(name: string): number {
    const stored = this.stackVars.get(name) ?? 0;

    if (stored === 0 || this.stackDepth < stored) return 0;

    return this.stackDepth - stored + 1;
  }

  get valueSlotCount(): number {
    // High-water mark (largest index + 1), NOT the total declared — slots are reused
    // across non-overlapping scopes, so this is what the ALLOCATE_VALUE prefix needs.
    return this.maxValueSlot;
  }

  get heapSlotCount(): number {
    return this.maxHeapSlot;
  }

  /** @deprecated Use valueSlotCount instead */
  get slotCount(): number {
    return this.maxValueSlot;
  }

  get resolvedBaseDirs(): string[] {
    return this.baseDirs;
  }

  get contractsConfig(): ContractsConfig {
    const config: ContractsConfig = {};
    for (const [name, info] of this.module.contracts) {
      config[name] = { abi: info.abi };
    }

    return config;
  }

  pushScope(): void {
    const parent = this.scopes[this.scopes.length - 1];
    this.scopes.push({ variables: new Map(), parent });
  }

  popScope(): void {
    if (this.scopes.length <= 1) {
      throw new Error('cannot pop global scope');
    }

    // Release this scope's memory slots so a later sibling scope can reuse them.
    // (v12 params are slot -1 and live on the stack — skip those.) No closures in
    // SauceScript, so a popped local is unreachable and its slot is safe to reuse.
    const scope = this.scopes.pop()!;
    for (const v of scope.variables.values()) {
      if (v.slot < 0) continue;

      if (v.kind === 'scalar') this.freeValueSlots.push(v.slot);
      else this.freeHeapSlots.push(v.slot);
    }
  }

  get currentScope(): Scope {
    return this.scopes[this.scopes.length - 1];
  }

  setVar(
    name: string,
    kind: VariableKind = 'scalar',
    elementType?: ElementType,
    structType?: StructType,
    isParam = false,
  ): Variable {
    if (RESERVED_NAMES.has(name)) throw new Error(`'${name}' is a reserved name`);

    const scope = this.currentScope;

    if (scope.variables.has(name)) {
      throw new Error(`variable '${name}' is already declared`);
    }

    // v12 params live on the EVM stack, not a memory slot (slot -1 = unused).
    // Memory-slot allocation reuses a slot freed by a popped sibling scope (lower
    // index → tighter packing → fewer total slots), else bumps the high-water mark.
    let slot: number;

    if (isParam) {
      slot = -1;
    } else if (kind === 'scalar') {
      slot = this.freeValueSlots.length > 0 ? this.freeValueSlots.pop()! : this.nextValueSlot++;

      if (slot + 1 > this.maxValueSlot) this.maxValueSlot = slot + 1;
    } else {
      slot = this.freeHeapSlots.length > 0 ? this.freeHeapSlots.pop()! : this.nextHeapSlot++;

      if (slot + 1 > this.maxHeapSlot) this.maxHeapSlot = slot + 1;
    }

    const variable: Variable = { name, slot, kind, elementType, structType, isParam };
    scope.variables.set(name, variable);

    return variable;
  }

  /**
   * Allocate a uniquely-named scratch local (a memory slot, never a stack param).
   * The `#` prefix can never collide with a parsed SauceScript identifier, so the
   * lowering can stash an intermediate value (e.g. a compound-assignment index that
   * must be evaluated exactly once) without shadowing a user variable.
   */
  freshTemp(kind: VariableKind = 'scalar'): string {
    const name = `#tmp${this.nextTempId++}`;
    this.setVar(name, kind);

    return name;
  }

  getVar(name: string): Variable | undefined {
    let scope: Scope | undefined = this.currentScope;
    while (scope) {
      const variable = scope.variables.get(name);

      if (variable) return variable;

      scope = scope.parent;
    }

    return;
  }

  addFunc(functionName: string) {
    if (RESERVED_NAMES.has(functionName)) throw new Error(`'${functionName}' is a reserved name`);

    const index = this.functions.findIndex((name) => name === functionName);

    if (index !== -1) {
      throw new Error(`Duplicate definition of function "${functionName}".`);
    }

    this.functions.push(functionName);
  }

  getFunc(functionName: string): number {
    const index = this.functions.findIndex((name) => name === functionName);

    if (index === -1) {
      throw new Error(`Function ${functionName} is undefined.`);
    }

    return index;
  }

  pushLoop(): void {
    this.loopDepth++;
  }

  popLoop(): void {
    this.loopDepth--;
  }

  assertInLoop(keyword: string): void {
    if (this.loopDepth === 0) {
      throw new Error(`${keyword} outside loop`);
    }
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  resolveImport(source: string): Record<string, unknown> {
    for (const baseDir of this.baseDirs) {
      const filePath = path.resolve(baseDir, source);

      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        continue;
      }
    }
    throw new Error(`Cannot resolve import "${source}". File not found in any of the provided baseDirs.`);
  }

  registerContract(name: string, abi: Abi): void {
    if (this.module.contracts.has(name)) {
      throw new Error(`Contract "${name}" is already registered.`);
    }

    this.module.contracts.set(name, { name, abi, methods: parseAbiMethods(abi) });
  }

  lookupContract(name: string): ContractInfo | undefined {
    return this.module.contracts.get(name);
  }

  setPendingContractBinding(contractName: string, callTypeOverride?: 'static' | 'delegate'): void {
    this.pendingContractBinding = { contractName, callTypeOverride };
  }

  consumePendingContractBinding(variableName: string): void {
    if (!this.pendingContractBinding) return;

    const contract = this.module.contracts.get(this.pendingContractBinding.contractName);

    if (contract) {
      this.boundContracts.set(variableName, {
        contract,
        callTypeOverride: this.pendingContractBinding.callTypeOverride,
      });
    }

    this.pendingContractBinding = undefined;
  }

  lookupBoundContract(
    variableName: string,
  ): { contract: ContractInfo; callTypeOverride?: 'static' | 'delegate' } | undefined {
    return this.boundContracts.get(variableName);
  }
}
