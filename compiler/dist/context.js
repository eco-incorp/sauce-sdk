import * as fs from 'fs';
import * as path from 'path';
import { parseAbiMethods } from './contracts.js';
import { RESERVED_NAMES } from './globals.js';
import { Saucer } from './saucer/saucer.js';
import { V12Saucer } from './saucer/saucer-v12.js';
import { AccountRegistry } from './planner/registry.js';
export class CompilerContext {
    warnings = [];
    target;
    scopes = [];
    loopDepth = 0;
    nextValueSlot = 0;
    nextHeapSlot = 0;
    nextTempId = 0;
    // High-water marks: the ALLOCATE_VALUE/ALLOCATE_HEAP prefix must cover the largest
    // slot INDEX ever used (slots are reused across non-overlapping scopes, so the
    // live count is far below the total declared). Slot indices are 1 byte, so >255
    // distinct LIVE slots would wrap — slot reuse keeps real programs well under that.
    maxValueSlot = 0;
    maxHeapSlot = 0;
    // Free-lists of slot indices released when a scope pops (its locals go out of
    // scope, so a later sibling scope can reuse the slot). SauceScript has no
    // closures, so a block-scoped local can never be read after its scope ends.
    freeValueSlots = [];
    freeHeapSlots = [];
    /** Module-level state, shared across a v12 module's per-function contexts. */
    module;
    baseDirs;
    pendingContractBinding;
    boundContracts = new Map();
    // v12: function parameters live on the EVM stack (not memory slots). This tracks
    // the per-function stack layout so reads/writes resolve to SDUP/SSWAP positions.
    stackDepth = 0;
    stackVars = new Map();
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
    mainArgTypes;
    /**
     * Optional hook to transform an imported SOURCE module's text before it is parsed —
     * e.g. strip TypeScript types. Receives (code, absoluteFilePath); returns plain JS the
     * acorn parser accepts. Set from CompileOptions.transformModule. Consulted ONLY for
     * source-file imports (a `.json` contract ABI is never passed through it). Kept off the
     * compiler's own dependency graph so it carries no typescript dep — callers that import
     * `.ts`/`.sauce.ts` modules supply the stripper (the recipes pass ts.transpileModule).
     */
    transformModule;
    /** Drop functions unreachable from main() after constant folding (CompileOptions.treeshake). */
    treeshake = false;
    /**
     * Compile-time constant environment for conditional compilation: names (from
     * CompileOptions.defines and top-level `const X = <literal>`) → their known bigint value.
     * Shared across a v12 module's per-function child contexts so a folded `if (HAS_CURVE)` in
     * any function sees the same defines. Booleans are normalized to 1n/0n.
     */
    get defines() {
        return this.module.defines;
    }
    /**
     * Whether compile-time constant folding is active. Gated so a LEGACY caller (no
     * `treeshake`, no `defines`) gets byte-identical output — e.g. `if (1 === 1)` is
     * NOT folded for them, it still emits a runtime branch. Folding turns on the moment
     * either knob is set: treeshake needs it for constant-aware reachability, and any
     * define implies the caller wants conditional compilation. A top-level `const X = …`
     * also populates `defines`, so a program that declares one folds its own conditions.
     */
    get foldEnabled() {
        return this.treeshake || this.defines.size > 0;
    }
    constructor(baseDirs = [], contracts = {}, target = 'v1', shared) {
        this.scopes.push({ variables: new Map() });
        this.baseDirs = baseDirs;
        this.target = target;
        this.module = shared ?? {
            functions: [],
            contracts: new Map(),
            funcMeta: [],
            defines: new Map(),
            accounts: new AccountRegistry(),
            staged: false,
        };
        for (const [name, config] of Object.entries(contracts)) {
            this.registerContract(name, config.abi);
        }
    }
    /** True for BOTH postfix v12 dialects — 'v12' (EVM Huff runtime) and 'svm' (Solana engine). */
    get isV12() {
        return this.target !== 'v1';
    }
    /** True only for the Solana target ('svm' is a v12 dialect with divergent call/storage lowering). */
    get isSvm() {
        return this.target === 'svm';
    }
    /** svm: compiling for staged execution — args read from the payload via CALLDATA; msg.data rejected. */
    get staged() {
        return this.module.staged;
    }
    /** svm: mark the module staged (set once by compile() before processing). */
    setStaged(staged) {
        this.module.staged = staged;
    }
    /** The function index table (shared across a v12 module's contexts). */
    get functions() {
        return this.module.functions;
    }
    /** v12: per-function build artifacts collected during processing. */
    get funcMeta() {
        return this.module.funcMeta;
    }
    /** Target-aware builder factory — the seam that keeps the processor agnostic. */
    newSaucer() {
        return this.target === 'v1' ? new Saucer(this) : new V12Saucer(this);
    }
    // ── svm account registry (module-shared, see planner/registry.ts) ──
    /** svm: intern a symbolic account ref → stable user-account index (first-use order). */
    internAccount(ref, flags = {}) {
        return this.module.accounts.intern(ref, flags);
    }
    /** svm: record that a raw numeric account index was used (locks out symbolic refs). */
    useRawAccountIndex() {
        this.module.accounts.useRawIndex();
    }
    /** svm: the ordered account plan assembled from the shared registry. */
    buildAccountPlan() {
        return this.module.accounts.buildPlan();
    }
    /**
     * v12: a child context for compiling one function body — fresh slots, scopes
     * and stack tracker, but a SHARED module (function index table, contracts,
     * collected metadata) so calls resolve across functions.
     */
    forFunction() {
        return new CompilerContext(this.baseDirs, {}, this.target, this.module);
    }
    recordFunction(meta) {
        this.module.funcMeta.push(meta);
    }
    // ── v12 stack-variable tracking ──
    /** Push a named value onto the (tracked) EVM stack — e.g. a function param. */
    pushStack(name) {
        this.stackDepth++;
        if (name)
            this.stackVars.set(name, this.stackDepth);
    }
    /** Absolute 1-indexed stack position of a tracked variable (0 = not found). */
    getStackVarPos(name) {
        return this.stackVars.get(name) ?? 0;
    }
    /** Relative-from-top position of a tracked variable (0 = not found). */
    findStackVar(name) {
        const stored = this.stackVars.get(name) ?? 0;
        if (stored === 0 || this.stackDepth < stored)
            return 0;
        return this.stackDepth - stored + 1;
    }
    get valueSlotCount() {
        // High-water mark (largest index + 1), NOT the total declared — slots are reused
        // across non-overlapping scopes, so this is what the ALLOCATE_VALUE prefix needs.
        return this.maxValueSlot;
    }
    get heapSlotCount() {
        return this.maxHeapSlot;
    }
    /** @deprecated Use valueSlotCount instead */
    get slotCount() {
        return this.maxValueSlot;
    }
    get resolvedBaseDirs() {
        return this.baseDirs;
    }
    get contractsConfig() {
        const config = {};
        for (const [name, info] of this.module.contracts) {
            config[name] = { abi: info.abi };
        }
        return config;
    }
    pushScope() {
        const parent = this.scopes[this.scopes.length - 1];
        this.scopes.push({ variables: new Map(), parent });
    }
    popScope() {
        if (this.scopes.length <= 1) {
            throw new Error('cannot pop global scope');
        }
        // Release this scope's memory slots so a later sibling scope can reuse them.
        // (v12 params are slot -1 and live on the stack — skip those.) No closures in
        // SauceScript, so a popped local is unreachable and its slot is safe to reuse.
        const scope = this.scopes.pop();
        for (const v of scope.variables.values()) {
            if (v.slot < 0)
                continue;
            if (v.kind === 'scalar')
                this.freeValueSlots.push(v.slot);
            else
                this.freeHeapSlots.push(v.slot);
        }
    }
    get currentScope() {
        return this.scopes[this.scopes.length - 1];
    }
    setVar(name, kind = 'scalar', elementType, structType, isParam = false) {
        if (RESERVED_NAMES.has(name))
            throw new Error(`'${name}' is a reserved name`);
        const scope = this.currentScope;
        if (scope.variables.has(name)) {
            throw new Error(`variable '${name}' is already declared`);
        }
        // v12 params live on the EVM stack, not a memory slot (slot -1 = unused).
        // Memory-slot allocation reuses a slot freed by a popped sibling scope (lower
        // index → tighter packing → fewer total slots), else bumps the high-water mark.
        let slot;
        if (isParam) {
            slot = -1;
        }
        else if (kind === 'scalar') {
            slot = this.freeValueSlots.length > 0 ? this.freeValueSlots.pop() : this.nextValueSlot++;
            if (slot + 1 > this.maxValueSlot)
                this.maxValueSlot = slot + 1;
        }
        else {
            slot = this.freeHeapSlots.length > 0 ? this.freeHeapSlots.pop() : this.nextHeapSlot++;
            if (slot + 1 > this.maxHeapSlot)
                this.maxHeapSlot = slot + 1;
        }
        const variable = { name, slot, kind, elementType, structType, isParam };
        scope.variables.set(name, variable);
        return variable;
    }
    /**
     * Allocate a uniquely-named scratch local (a memory slot, never a stack param).
     * The `#` prefix can never collide with a parsed SauceScript identifier, so the
     * lowering can stash an intermediate value (e.g. a compound-assignment index that
     * must be evaluated exactly once) without shadowing a user variable.
     */
    freshTemp(kind = 'scalar') {
        const name = `#tmp${this.nextTempId++}`;
        this.setVar(name, kind);
        return name;
    }
    getVar(name) {
        let scope = this.currentScope;
        while (scope) {
            const variable = scope.variables.get(name);
            if (variable)
                return variable;
            scope = scope.parent;
        }
        return;
    }
    addFunc(functionName) {
        if (RESERVED_NAMES.has(functionName))
            throw new Error(`'${functionName}' is a reserved name`);
        const index = this.functions.findIndex((name) => name === functionName);
        if (index !== -1) {
            throw new Error(`Duplicate definition of function "${functionName}".`);
        }
        this.functions.push(functionName);
    }
    /** Seed the compile-time constant environment from CompileOptions.defines. */
    setDefines(defines) {
        for (const [name, value] of Object.entries(defines)) {
            this.defines.set(name, defineToBigint(value));
        }
    }
    /**
     * Register a top-level `const X = <literal>` as a compile-time constant (so it can fold
     * branch conditions). A define of the same name already set via CompileOptions wins (an
     * explicit override), so a const never clobbers a caller-provided flag.
     */
    registerConstant(name, value) {
        if (!this.defines.has(name))
            this.defines.set(name, value);
    }
    /** Compile-time value of a name (define or folded top-level const), or undefined if unknown. */
    getConstant(name) {
        return this.defines.get(name);
    }
    getFunc(functionName) {
        const index = this.functions.findIndex((name) => name === functionName);
        if (index === -1) {
            throw new Error(`Function ${functionName} is undefined.`);
        }
        return index;
    }
    pushLoop() {
        this.loopDepth++;
    }
    popLoop() {
        this.loopDepth--;
    }
    assertInLoop(keyword) {
        if (this.loopDepth === 0) {
            throw new Error(`${keyword} outside loop`);
        }
    }
    warn(message) {
        this.warnings.push(message);
    }
    resolveImport(source) {
        for (const baseDir of this.baseDirs) {
            const filePath = path.resolve(baseDir, source);
            try {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
            catch {
                continue;
            }
        }
        throw new Error(`Cannot resolve import "${source}". File not found in any of the provided baseDirs.`);
    }
    /**
     * Resolve a SOURCE-FILE import (a SauceScript module that exports functions) — distinct
     * from `resolveImport`, which loads a `.json` contract ABI. Returns the module's raw text
     * + absolute path, or undefined if no source file resolves (the caller then treats the
     * import as a `.json` contract). Tries the literal path, then the common SauceScript source
     * extensions, across every baseDir. A `.json` source is never a module (returns undefined).
     */
    resolveModuleSource(source) {
        if (source.endsWith('.json'))
            return undefined; // a .json import is a contract ABI, not a module
        const candidates = [
            source,
            `${source}.ts`,
            `${source}.sauce.ts`,
            `${source}.js`,
            `${source}.sauce`,
            `${source}.mjs`,
        ];
        for (const baseDir of this.baseDirs) {
            for (const cand of candidates) {
                const filePath = path.resolve(baseDir, cand);
                try {
                    return { code: fs.readFileSync(filePath, 'utf-8'), filePath };
                }
                catch {
                    continue;
                }
            }
        }
        return undefined;
    }
    registerContract(name, abi) {
        if (this.module.contracts.has(name)) {
            throw new Error(`Contract "${name}" is already registered.`);
        }
        this.module.contracts.set(name, { name, abi, methods: parseAbiMethods(abi) });
    }
    lookupContract(name) {
        return this.module.contracts.get(name);
    }
    setPendingContractBinding(contractName, callTypeOverride) {
        this.pendingContractBinding = { contractName, callTypeOverride };
    }
    consumePendingContractBinding(variableName) {
        if (!this.pendingContractBinding)
            return;
        const contract = this.module.contracts.get(this.pendingContractBinding.contractName);
        if (contract) {
            this.boundContracts.set(variableName, {
                contract,
                callTypeOverride: this.pendingContractBinding.callTypeOverride,
            });
        }
        this.pendingContractBinding = undefined;
    }
    lookupBoundContract(variableName) {
        return this.boundContracts.get(variableName);
    }
}
/** Normalize a `defines` value to a compile-time bigint (booleans → 1n/0n). */
function defineToBigint(value) {
    if (typeof value === 'boolean')
        return value ? 1n : 0n;
    return BigInt(value);
}
