import * as fs from 'fs';
import * as path from 'path';
import type { Abi, ContractInfo, ContractsConfig } from './contracts.js';
import { parseAbiMethods } from './contracts.js';
import { RESERVED_NAMES } from './globals.js';

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
}

export interface Scope {
  variables: Map<string, Variable>;
  parent?: Scope;
}

export class CompilerContext {
  readonly warnings: string[] = [];
  private scopes: Scope[] = [];
  private loopDepth = 0;
  public functions: string[] = [];
  private nextValueSlot = 0;
  private nextHeapSlot = 0;

  private contracts: Map<string, ContractInfo> = new Map();
  private baseDirs: string[];
  private pendingContractBinding?: { contractName: string; callTypeOverride?: 'static' | 'delegate' };
  private boundContracts: Map<string, { contract: ContractInfo; callTypeOverride?: 'static' | 'delegate' }> = new Map();

  /** Type info for main() function parameters, inferred from args option */
  mainArgTypes?: { kind: VariableKind; elementType?: ElementType }[];

  constructor(baseDirs: string[] = [], contracts: ContractsConfig = {}) {
    this.scopes.push({ variables: new Map() });
    this.baseDirs = baseDirs;

    for (const [name, config] of Object.entries(contracts)) {
      this.registerContract(name, config.abi);
    }
  }

  get valueSlotCount(): number {
    return this.nextValueSlot;
  }

  get heapSlotCount(): number {
    return this.nextHeapSlot;
  }

  /** @deprecated Use valueSlotCount instead */
  get slotCount(): number {
    return this.nextValueSlot;
  }

  get resolvedBaseDirs(): string[] {
    return this.baseDirs;
  }

  get contractsConfig(): ContractsConfig {
    const config: ContractsConfig = {};
    for (const [name, info] of this.contracts) {
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

    this.scopes.pop();
  }

  get currentScope(): Scope {
    return this.scopes[this.scopes.length - 1];
  }

  setVar(name: string, kind: VariableKind = 'scalar', elementType?: ElementType, structType?: StructType): Variable {
    if (RESERVED_NAMES.has(name)) throw new Error(`'${name}' is a reserved name`);

    const scope = this.currentScope;

    if (scope.variables.has(name)) {
      throw new Error(`variable '${name}' is already declared`);
    }

    const slot = kind === 'scalar' ? this.nextValueSlot++ : this.nextHeapSlot++;
    const variable: Variable = { name, slot, kind, elementType, structType };
    scope.variables.set(name, variable);

    return variable;
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
    if (this.contracts.has(name)) {
      throw new Error(`Contract "${name}" is already registered.`);
    }

    this.contracts.set(name, { name, abi, methods: parseAbiMethods(abi) });
  }

  lookupContract(name: string): ContractInfo | undefined {
    return this.contracts.get(name);
  }

  setPendingContractBinding(contractName: string, callTypeOverride?: 'static' | 'delegate'): void {
    this.pendingContractBinding = { contractName, callTypeOverride };
  }

  consumePendingContractBinding(variableName: string): void {
    if (!this.pendingContractBinding) return;

    const contract = this.contracts.get(this.pendingContractBinding.contractName);

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
