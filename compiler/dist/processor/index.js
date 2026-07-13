import * as acorn from 'acorn';
import { CompilerContext } from '../context.js';
import { processLiteral, processUnaryExpression, processBinaryExpression, processLogicalExpression, processCallExpression, processMemberExpression, processNewExpression, processTaggedTemplateExpression, } from './expression.js';
import { processVariableDeclaration, processIfStatement, processForStatement, processWhileStatement, processMutation, } from './statement.js';
import { processArrayExpression, processObjectExpression } from './collection.js';
import { evalConst, evalConstBool } from './const-eval.js';
export function processNode(node, ctx) {
    switch (node.type) {
        case 'Program':
            return processProgram(node, ctx);
        default:
            throw new Error(`not implemented: ${node.type}`);
    }
}
function processImportDeclaration(stmt, ctx) {
    const source = stmt.source.value;
    const artifact = ctx.resolveImport(source);
    const abi = artifact.abi;
    if (!abi) {
        throw new Error(`import "${source}" does not contain an ABI.`);
    }
    for (const specifier of stmt.specifiers) {
        const localName = specifier.local.name;
        // Idempotent: the SAME contract ABI imported by two source modules (or already
        // bound) must not throw "already registered" — skip a re-import of an identical
        // ABI. But a DIFFERENT ABI under the same local name is a genuine collision: the
        // first registration would silently win and the second module's functions would
        // compile against the wrong ABI (wrong selector/calldata), so reject it.
        const existing = ctx.lookupContract(localName);
        if (existing) {
            if (!abisEqual(existing.abi, abi)) {
                throw new Error(`Conflicting ABIs registered for "${localName}".`);
            }
            continue;
        }
        ctx.registerContract(localName, abi);
    }
}
// Stable structural equality of two ABIs (key order irrelevant) so a re-import of the
// same ABI dedups while a different ABI under the same local name is rejected.
function abisEqual(a, b) {
    return canonicalJson(a) === canonicalJson(b);
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
// Top-level FunctionDeclarations, including those behind `export`/`export default`.
// Imported modules and the main program both expose their functions this way.
function extractFunctionDeclarations(program) {
    const out = [];
    for (const stmt of program.body) {
        if (stmt.type === 'FunctionDeclaration') {
            out.push(stmt);
        }
        else if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
            const decl = stmt.declaration;
            if (decl && decl.type === 'FunctionDeclaration')
                out.push(decl);
        }
    }
    return out;
}
// Recursively pull function declarations from `import { fn } from "./mod"` source
// modules into the SAME function table as local functions, so they compile/emit
// identically. A `.json` import remains a contract ABI (processImportDeclaration).
// `seen` maps an imported function name → the module file it came from (duplicate
// detection across modules); `visited` is the set of already-pulled module paths
// (a shared module imported by two parents is pulled once). Imports recurse FIRST
// so a transitively-imported function is registered before the importing module's.
function collectImportedFunctions(program, ctx, seen, visited) {
    const out = [];
    for (const stmt of program.body) {
        if (stmt.type !== 'ImportDeclaration')
            continue;
        const source = stmt.source.value;
        const mod = ctx.resolveModuleSource(source);
        if (!mod) {
            // No source file resolves → a `.json` contract ABI import.
            processImportDeclaration(stmt, ctx);
            continue;
        }
        if (visited.has(mod.filePath))
            continue; // shared module already pulled
        visited.add(mod.filePath);
        const code = ctx.transformModule ? ctx.transformModule(mod.code, mod.filePath) : mod.code;
        let modAst;
        try {
            modAst = acorn.parse(code, {
                ecmaVersion: 'latest',
                sourceType: 'module',
                allowReturnOutsideFunction: true,
            });
        }
        catch (e) {
            throw new Error(`failed to parse imported module "${mod.filePath}": ${e.message}` +
                ` (if it is TypeScript, pass options.transformModule to strip types before parsing)`);
        }
        // Recurse into the imported module's own imports FIRST so transitive functions
        // (and contracts) are registered before this module's.
        out.push(...collectImportedFunctions(modAst, ctx, seen, visited));
        for (const fn of extractFunctionDeclarations(modAst)) {
            const name = fn.id?.name;
            if (!name)
                continue;
            if (name === 'main')
                throw new Error(`imported module "${mod.filePath}" must not define main()`);
            const prev = seen.get(name);
            // Same name from a DIFFERENT module is an ambiguous collision; the same module
            // seen twice (re-entrant graph) is already handled by `visited`, so a repeat
            // here with the same path is just skipped.
            if (prev && prev !== mod.filePath) {
                throw new Error(`duplicate imported function "${name}" (from "${prev}" and "${mod.filePath}")`);
            }
            if (prev)
                continue;
            seen.set(name, mod.filePath);
            out.push(fn);
        }
    }
    return out;
}
// Reachability walk for tree-shaking: every function name transitively CALLED from
// main(). Constant-aware — an if/ternary with a const-known test is pruned to its
// taken branch EXACTLY as the emitter prunes it (statement.ts), so the set of CALL
// targets walked == the set emitted; with treeshake on, every emitted call therefore
// targets a registered (kept) function.
function treeshake(declarations, ctx) {
    const declMap = new Map();
    for (const d of declarations) {
        const name = d.id?.name;
        if (name)
            declMap.set(name, d);
    }
    const reachable = new Set();
    const stack = ['main'];
    while (stack.length > 0) {
        const name = stack.pop();
        if (reachable.has(name))
            continue;
        reachable.add(name);
        const decl = declMap.get(name);
        if (!decl)
            continue;
        for (const callee of collectCalls(decl.body, ctx, declMap)) {
            if (!reachable.has(callee))
                stack.push(callee);
        }
    }
    return declarations.filter((d) => d.id?.name === 'main' || reachable.has(d.id?.name ?? ''));
}
// Collect the names of user functions a node (sub)tree calls. Conservative by design:
// EVERYTHING is traversed fully EXCEPT an if/ternary with a const-known test, which is
// pruned to its taken branch — matching the emitter bit-for-bit. Loops and value-position
// `&&`/`||` are NOT special-cased (traversed fully) so the walker never drops a call the
// emitter still emits.
function collectCalls(node, ctx, declMap, out = new Set()) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string')
        return out;
    switch (node.type) {
        case 'IfStatement': {
            const stmt = node;
            if (ctx.foldEnabled) {
                const taken = evalConstBool(stmt.test, ctx);
                if (taken === true)
                    return collectCalls(stmt.consequent, ctx, declMap, out);
                if (taken === false)
                    return collectCalls(stmt.alternate, ctx, declMap, out); // alternate may be undefined
            }
            break;
        }
        case 'ConditionalExpression': {
            const expr = node;
            if (ctx.foldEnabled) {
                const taken = evalConstBool(expr.test, ctx);
                if (taken === true)
                    return collectCalls(expr.consequent, ctx, declMap, out);
                if (taken === false)
                    return collectCalls(expr.alternate, ctx, declMap, out);
            }
            break;
        }
        case 'CallExpression': {
            const callee = node.callee;
            if (callee.type === 'Identifier') {
                const name = callee.name;
                if (declMap.has(name))
                    out.add(name);
            }
            break;
        }
    }
    // Generic walk: recurse into every child node / array of nodes.
    eachChild(node, (child) => collectCalls(child, ctx, declMap, out));
    return out;
}
// Walk every AST-node child of a node (node-valued props + arrays of nodes), skipping
// acorn's bookkeeping fields. Generic so collectCalls needn't enumerate node shapes.
function eachChild(node, visit) {
    for (const [key, value] of Object.entries(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range')
            continue;
        if (Array.isArray(value)) {
            for (const el of value) {
                if (el && typeof el === 'object' && typeof el.type === 'string')
                    visit(el);
            }
        }
        else if (value && typeof value === 'object' && typeof value.type === 'string') {
            visit(value);
        }
    }
}
// Register top-level `const X = <foldable init>` (and `export const`) in the MAIN
// program as compile-time constants BEFORE treeshake/compile, so they fold branch
// conditions. They emit no runtime code (top-level consts are compile-time only).
function registerTopLevelConsts(program, ctx) {
    for (const stmt of program.body) {
        const decl = stmt.type === 'VariableDeclaration'
            ? stmt
            : stmt.type === 'ExportNamedDeclaration' &&
                stmt.declaration?.type === 'VariableDeclaration'
                ? stmt.declaration
                : undefined;
        if (!decl || decl.kind !== 'const')
            continue;
        for (const d of decl.declarations) {
            if (d.id.type !== 'Identifier' || !d.init)
                continue;
            const value = evalConst(d.init, ctx);
            if (value !== undefined)
                ctx.registerConstant(d.id.name, value);
        }
    }
}
// Top-level node types allowed in the main program: imports, function declarations
// (incl. exported), empty statements, and `const X = …` (compile-time constants).
function isAllowedTopLevel(stmt) {
    switch (stmt.type) {
        case 'ImportDeclaration':
        case 'FunctionDeclaration':
        case 'ExportNamedDeclaration':
        case 'ExportDefaultDeclaration':
        case 'EmptyStatement':
            return true;
        case 'VariableDeclaration':
            return stmt.kind === 'const';
        default:
            return false;
    }
}
function processProgram(program, ctx) {
    // Pull imported source-module functions (and process .json contract imports) FIRST,
    // so they join the same function table as local functions. Recursive across modules.
    const importedFns = collectImportedFunctions(program, ctx, new Map(), new Set());
    // Register top-level consts (compile-time only) before validating / folding.
    registerTopLevelConsts(program, ctx);
    const nonAllowed = program.body.find((stmt) => !isAllowedTopLevel(stmt));
    if (nonAllowed) {
        throw new Error('top-level statements not allowed, use function main()');
    }
    const localFns = extractFunctionDeclarations(program);
    let declarations = [...importedFns, ...localFns];
    const mainFunc = declarations.find((stmt) => stmt.id?.name === 'main');
    if (!mainFunc) {
        throw new Error('missing main() function');
    }
    // Drop functions unreachable from main() (constant-aware) so an imported-but-unused
    // function — or a handler behind a statically-false branch — is never emitted.
    if (ctx.treeshake)
        declarations = treeshake(declarations, ctx);
    if (ctx.isV12) {
        return processProgramV12(declarations, mainFunc, ctx);
    }
    const functions = declarations
        .filter((stmt) => stmt.id?.name !== 'main')
        .map((stmt) => {
        ctx.addFunc(stmt.id?.name);
        // Compile each helper in a CHILD context (fresh slots/scopes, isolated like the
        // legacy fresh-context behaviour) that SHARES the module's function index table
        // and contracts — so an imported helper that calls a sibling imported function
        // (or uses an imported contract ABI) resolves instead of failing late with
        // "Function … is undefined".
        return processFunction(stmt, ctx.forFunction());
    });
    ctx.addFunc('main');
    return [...functions, processFunction(mainFunc, ctx)];
}
/**
 * v12: every function (helpers + main) compiles in its own child context (fresh
 * slots/scopes/stack) sharing the module's function index table, so calls resolve
 * across functions. Each function's build artifacts are recorded for the single-blob
 * assembly in compile(). Function names are registered up front so a body can call a
 * function declared later.
 */
function processProgramV12(declarations, mainFunc, ctx) {
    const helpers = declarations.filter((stmt) => stmt.id?.name !== 'main');
    for (const stmt of helpers)
        ctx.addFunc(stmt.id?.name);
    ctx.addFunc('main');
    const helperSaucers = helpers.map((stmt) => processFunctionV12(stmt, ctx));
    const mainSaucer = processFunctionV12(mainFunc, ctx);
    return [...helperSaucers, mainSaucer];
}
function processFunctionV12(stmt, parentCtx) {
    const ctx = parentCtx.forFunction();
    const name = stmt.id?.name ?? 'main';
    const isMain = name === 'main';
    // Helpers self-terminate every `return` with FUNC_RETURN; main is inlined and
    // just leaves its value (see CompilerContext.isMainFunction / V12Saucer.return).
    ctx.isMainFunction = isMain;
    const argTypes = isMain ? parentCtx.mainArgTypes : undefined;
    // Params live on the EVM stack (isParam) in declaration order.
    stmt.params.forEach((param, i) => {
        if (param.type !== 'Identifier')
            throw new Error(`Unsupported function variable type: ${param.type}`);
        const argType = argTypes?.[i];
        ctx.setVar(param.name, argType?.kind ?? 'scalar', argType?.elementType, argType?.structType, true);
        ctx.pushStack(param.name);
    });
    const body = stmt.body.body.reduce((saucer, st) => processStatement(st, ctx, saucer), ctx.newSaucer());
    ctx.recordFunction({ name, isMain, paramCount: stmt.params.length, saucer: body });
    return body;
}
function processFunction(stmt, ctx = new CompilerContext()) {
    const argTypes = ctx.mainArgTypes;
    stmt.params.forEach((param, i) => {
        if (param.type !== 'Identifier')
            throw new Error(`Unsupported function variable type: ${param.type}`);
        const argType = argTypes?.[i];
        ctx.setVar(param.name, argType?.kind ?? 'scalar', argType?.elementType, argType?.structType);
    });
    return stmt.body.body.reduce((saucer, st) => processStatement(st, ctx, saucer), ctx.newSaucer());
}
export function processStatement(stmt, ctx, saucer) {
    switch (stmt.type) {
        case 'VariableDeclaration':
            return processVariableDeclaration(stmt, ctx, saucer);
        case 'IfStatement':
            return processIfStatement(stmt, ctx, saucer);
        case 'ReturnStatement':
            return processReturnStatement(stmt, ctx, saucer);
        case 'ForStatement':
            return processForStatement(stmt, ctx, saucer);
        case 'WhileStatement':
            return processWhileStatement(stmt, ctx, saucer);
        case 'BreakStatement':
            return saucer.break();
        case 'ContinueStatement':
            return saucer.continue();
        case 'ExpressionStatement':
            return processMutation(stmt.expression, ctx, saucer);
        case 'ThrowStatement':
            return processThrowStatement(stmt, ctx, saucer);
        default:
            throw new Error(`not implemented: ${stmt.type}`);
    }
}
function processReturnStatement(stmt, ctx, saucer) {
    return stmt.argument ? saucer.return(processExpression(stmt.argument, ctx)) : saucer.return();
}
function processThrowStatement(stmt, ctx, saucer) {
    return saucer.revert(processExpression(stmt.argument, ctx));
}
export function processExpression(expr, ctx) {
    const saucer = ctx.newSaucer();
    switch (expr.type) {
        case 'Literal':
            return processLiteral(expr, saucer);
        case 'Identifier': {
            // A compile-time constant (CompileOptions.defines or a top-level `const X = …`)
            // emits its literal value here, so it behaves as a true constant in non-folding
            // positions too (e.g. `rt + SCALE`, or a partially-folding `FLAG && rt`) — not
            // just inside a fully-foldable condition. A runtime variable falls through to read.
            const constant = ctx.getConstant(expr.name);
            if (constant !== undefined && !ctx.getVar(expr.name))
                return saucer.int(constant);
            return saucer.read(expr.name);
        }
        case 'UnaryExpression':
            return processUnaryExpression(expr, ctx, saucer);
        case 'BinaryExpression':
            return processBinaryExpression(expr, ctx, saucer);
        case 'LogicalExpression':
            return processLogicalExpression(expr, ctx, saucer);
        case 'CallExpression':
            return processCallExpression(expr, ctx, saucer);
        case 'ArrayExpression':
            return processArrayExpression(expr, ctx, saucer);
        case 'ObjectExpression':
            return processObjectExpression(expr, ctx, saucer);
        case 'NewExpression':
            return processNewExpression(expr, ctx, saucer);
        case 'MemberExpression':
            return processMemberExpression(expr, ctx, saucer);
        case 'TaggedTemplateExpression':
            return processTaggedTemplateExpression(expr, ctx, saucer);
        case 'ConditionalExpression':
            throw new Error('ternary must be used directly in an assignment');
        default:
            throw new Error(`not implemented: ${expr.type}`);
    }
}
