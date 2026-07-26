# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Developer-facing tooling for the **Sauce protocol** — an on-chain bytecode runtime that executes
Turing-complete, atomic scripts in a single EVM transaction. The runtime engine itself lives in the
separate private `eco-incorp/sauce` repo (often checked out at `../sauce`); this repo only *targets*
it.

A **pnpm monorepo** of four workspace packages, all `private: true`, bundled and published as a
**single npm package `@eco-incorp/sauce-sdk`** via subpath exports — only the root `package.json`
publishes. This bundling is the key mental model: code lives in four packages for development,
consumers import everything from one name.

| Workspace | Internal name | Published as | Role |
| --- | --- | --- | --- |
| `compiler/` | `@eco-incorp/sauce-compiler` | `/compiler` | SauceScript (JS subset) → Sauce bytecode |
| `sdk/` | `@eco-incorp/sauce-sdk-source` | `.`, `/protocols/*`, `/chains`, `/skills`, `/recipes` | 127+ protocol registry, chains, recipes, AI skill files |
| `actions/` | `@eco-incorp/sauce-actions` | `/actions` | High-level routing actions (swaps/bridges) → bytecode |
| `dev-tools/` | `@eco-incorp/sauce-dev-tools` | bin `sauce-dev-tools` | Local/forked hardhat env + recipe runner |

This repo was **extracted from `../sauce`** (the source of truth, which still has its own copies of
these four packages, generally more built-out). The packages here are **siblings, not generations**:
`dev-tools` is a dev harness, not a legacy `sdk`. The genuinely deprecated compiler is
`../sauce/compiler-poc/`, nothing here.

## Build, test, lint

Run from the repo root. **Build order matters** — sdk and actions consume the compiler's `dist/`, so
the compiler builds first (the `build` script enforces this).

```sh
pnpm install
pnpm build          # compiler, THEN sdk + actions
pnpm typecheck      # all workspaces
pnpm test           # all workspaces
```

Per-workspace (`--filter`):

```sh
pnpm --filter './compiler' test          # jest: unit test/ + integration-test/ (needs Foundry)
pnpm --filter './compiler' lint          # eslint; also: format:check (CI enforces)
pnpm --filter './sdk' test               # compiles every protocol's SauceScript fn (1400+ tests)
pnpm --filter './actions' test:unit      # fork-free subset CI runs
```

Single test file: jest (compiler/sdk) → `pnpm --filter './compiler' test -- arithmetic.test.ts`.
Actions and dev-tools use the **node test runner**, not jest → `pnpm --filter './actions' exec tsx
--test tests/megas-swap.unit.test.ts`.

## Toolchain gotchas (why a fresh clone may fail)

- **Private `sauce` git dep.** The compiler depends on `sauce` from `git+https://…/eco-incorp/sauce`
  (private). Cloning needs GitHub auth — locally `gh auth setup-git` or an `~/.npmrc` token; CI uses
  the `ECO_INCORP_TOKEN` secret via a `git config insteadOf` rewrite.
- **Foundry** (`anvil`/`forge`/`cast`) is required for the compiler's integration tests (jest
  `globalSetup` spawns anvil, `forge create`s the engine, runs compiled bytecode) and to build the
  engine artifacts. The compiler `postinstall` (`integration-test/fetch-engine-libs.js`) clones the
  OpenZeppelin submodule into the `sauce` dep and `forge build`s it (pnpm doesn't recurse submodules).
- **`FORK_URL`** — actions `test`/`test:megas-swap` and dev-tools fork flows hit a hardhat mainnet
  fork (loaded from `.env`). `test:unit` is the fork-free subset.
- **`SAUCE_ENGINE_SO`** — path to the Solana engine binary (`engine.so`, built with
  `cargo build-sbf` in the sauce repo's `svm/`). The SVM integration suites
  (`compiler/integration-test/svm-*.test.ts`, `sdk/test/svm/*.test.ts`) run compiled
  `target: 'svm'` bytecode on it via LiteSVM. The binary is **vendored** at
  `artifacts/svm/engine.so` (committed, force-added — `.so` is gitignored — same
  convention as the committed `compiler/dist`/`sdk/dist`) and that's the default both
  locally and in CI, so these suites run **offline by default**, same as the EVM ones; the
  suites **skip cleanly** only if that binary is somehow missing. Set `SAUCE_ENGINE_SO` to
  override — e.g. to test a freshly built engine before repinning the `sauce` dep. **Refresh
  the vendored binary whenever the `sauce` dep is repinned**: `cargo build-sbf` in the pinned
  commit's `svm/` checkout, copy `target/deploy/engine.so` over `artifacts/svm/engine.so`,
  force-commit — nothing re-derives this automatically, so a repin without a refresh silently
  tests against a stale engine again. The `'svm'` compile target, its account-plan output,
  and the `/svm` SDK subpath are documented in `docs/plans/2026-07-03-solana-svm-support.md`.
- **Committed EVM engine artifacts** (`sdk/dist/artifacts/` — `Router`, `SauceRouter`,
  `ISauceRouter`, `V12Pot`, `V12Kitchen`, `V12RuntimeBytecode`, `IERC20`, `IUniswapV3Pool`,
  `IStateView`) ship to downstream SDK consumers, which read them for local tests/deploys, so
  they must track the pinned `sauce` engine. Unlike `compiler/dist`, they are **not** build
  output — `tsc` never emits them — so a `sauce` repin would silently leave them stale. **After
  any repin run `pnpm --filter './sdk' sync-engine-artifacts`** (copies the 8 forge artifacts
  from the pinned dep's `engine/out/` + the `V12RuntimeBytecode` snapshot from
  `engine-v12/snapshots/`) **and commit the result**. CI enforces this: it re-syncs from the
  freshly-installed engine (foundry v1.5.1 + solc 0.8.27 → byte-reproducible) and fails on any
  drift, so a forgotten re-sync can't merge.

## Architecture

**`compiler/`** — parses **SauceScript** (a uint256-only JS subset; no closures/classes/async, strict
equality; full surface in `compiler/README.md`) to bytecode. `src/index.ts` `compile()` parses via
`acorn` and emits `Uint8Array[]`; `src/processor/` walks the AST (expression/statement/collection/
inference); `src/saucer/` emits bytecode (`Saucer` builder, `ops.ts` opcode table, per-type encoders);
`src/context.ts` tracks functions/var kinds/ABIs; `src/contracts.ts` loads contract ABIs from artifact
JSON for `import { X } from "./X.json"` + `.at()/.view()/.lib()` binding.

**TS front-end (`src/ts-frontend.ts`) — `.ts`/`.sauce.ts` sources/imports only.** The core pipeline
is acorn-only; a `.ts`/`.sauce.ts` source opts into a front-end that runs strictly BEFORE acorn: it
parses with the real `typescript` compiler, folds provably-constant `if`/ternary branches, literal
expressions, and countable `for` loops, then strips types via `ts.transpileModule` — handing acorn
plain JS text. Wired at both the import seam (`ctx.transformModule`, default for any resolved
`.ts`-suffixed module — a caller-supplied `transformModule` always overrides it) and the top level
(`CompileOptions.tsSource`).

TWO evaluators, layered: `tsEvalConst` (a hand-rolled bigint evaluator mirroring
`processor/const-eval.ts`, retargeted to `ts.Node`) is the PRIMARY one — because
**`ts-evaluator@2.0.0` cannot reliably evaluate bigint arithmetic at all** (`BigInt(node.text)` on a
bare BigInt literal like `"3n"` throws — the constructor rejects the literal's own `n` suffix — and
bigint binary expressions just fail silently), and SauceScript is bigint-only, so `ts-evaluator`'s
`evaluate()` (`tryEvaluate`) is only a fallback for shapes `tsEvalConst` doesn't cover (bare
boolean/string identifiers, ternaries-as-values, templates — same-file identifiers only, no
`ts.Program`/checker is built, so it can't see into array/object property access or function calls
either — that scope boundary is why loop unrolling can't (yet) fold real array/object DATA
processing, only countable counters). A failed/unresolvable fold always leaves the node untouched
(fails closed, never throws) — `tryEvaluate` wraps `evaluate()` in try/catch for whatever still
reaches it with a bigint present (e.g. a template literal substitution).

**Loop unrolling**: a `for` loop with a constant start/bound/step (`i++`/`i--`/`i +=
step`/`i -= step`/`i = i +/- step`, compared against a same-file `const` or literal bound) unrolls
into N copies of its body with the counter substituted by its per-iteration literal — capped at
`MAX_UNROLL_ITERATIONS` (256) so it can't blow up bytecode size; over the cap, or a
non-canonical/non-constant shape, or a body containing `break`/`continue`/`return` or shadowing the
counter name, leaves the loop as real runtime code (`JUMP_BACK`) untouched. The SAME counting-loop
core (`unrollCountingLoop`) also recognizes the `while` spelling of the identical idiom — a `while`
has no init/incrementor clauses of its own, so it's the pairing `let i = <const>; while (i <cmp>
bound) { ...; i +/- step; }` (the increment as the body's own last statement) that's matched, at the
statement-LIST level (`foldStatementList`, since eliding the pair replaces two adjacent statements
with N — a single-node visitor can't express that). Unrolling a `while` this way ELIDES the counter
declaration entirely, so it only fires when nothing after the loop still reads the counter (a
"found index" pattern must keep the loop as-is) — checked by scanning the rest of the enclosing
statement list. Each unrolled iteration re-enters the fold pass, so a nested `if`/inner loop keyed
on the counter cascades to a fully-resolved literal per iteration (e.g. a nested `while` inside an
unrolled `for` fully resolves both loops to straight-line arithmetic, no loop opcodes emitted at
all). Plain `.js`/`.sauce` sources never invoke any of this.

**Constant propagation to reads + dead-declaration elimination** (`constPropagationTransformer` /
`deadConstEliminationTransformer`, two more `before` transformer stages appended AFTER
`foldTransformer`, running on ITS output): a chain like `const a = 1; const b = a + 3; const c = b
+ 4; console.log(c);` now fully collapses to `console.log(8n);`. The fold pass above already
resolves every top-level `const`'s value into `consts` up front and folds it into a later
FOLDABLE initializer expression (`const b = a + 3` → `const b = 4n`), but never touched a bare
`Identifier` sitting in ordinary READ position — `constPropagationTransformer` closes that gap,
substituting every unshadowed read of a top-level const name with its resolved literal;
`deadConstEliminationTransformer` then deletes any top-level `const` left with ZERO remaining
`Identifier` occurrences of its name anywhere in the file. Running after fold+unroll means a const
used only as a now-fully-unrolled loop bound, or only inside a since-pruned dead `if`-branch, is
correctly eliminated too — its only textual reference already disappeared with the unrolled-away
loop condition or pruned branch, before either of these two passes ever looks for it. Scope-aware:
descending into a function body, block, catch clause, for-loop declaration, or parameter that
redeclares the SAME name shadows it for that whole (inner) scope, computed once up front per scope
rather than incrementally (matching real JS/TS semantics — a block-scoped name is reserved from the
top of its scope regardless of TDZ) — the outer const is correctly left un-substituted inside that
shadowed scope; `var` is additionally hoisted to its enclosing FUNCTION (not block) scope, via a
separate pre-scan that doesn't cross nested function/class boundaries, matching real `var`
semantics. Substitution never touches a WRITE position either — an assignment's left-hand side or an
update expression's (`++`/`--`) operand is walked by a dedicated `visitAssignmentTarget` that
recurses into any nested reads (a computed member-access key, a destructuring default's value) but
leaves the bound identifier(s) themselves untouched, mirroring `foldExpression`'s
`ASSIGNMENT_OPERATOR_TOKENS` guard one level down — the same "never fold/substitute an lvalue"
invariant, enforced by a second, independent guard for this second pass. Only the SAME same-file
top-level `consts` map the fold pass already trusts is ever
consulted — a `let`/`var`/mutable-reassignment chain (e.g. `a = 1; b = a + 3; console.log(b);`) is
untouched by construction, not by a special-cased guard: `collectTopLevelConsts` only ever records
`NodeFlags.Const` declarations, so such a name is simply never a key in `consts`, and a bare
Identifier that doesn't resolve in `consts` is always left exactly as found. Dead-declaration
elimination is deliberately a simple, NOT scope-aware, whole-file textual `Identifier` reference
count taken AFTER substitution (`countIdentifierRefs`) — a top-level const that happens to share
its name with an unrelated nested shadowing declaration elsewhere in the file may be kept around
(harmlessly inert, its value already fully propagated to every real reader) rather than removed,
but this can never cause an INCORRECT substitution, only an occasionally-missed cleanup. Tracking
itself is not extended by any of this: only the pre-existing top-level `consts` map is ever
consulted or mutated-by-removal; a nested/function-local `const` is never added to it and stays out
of scope, exactly as before.

**Folds a call to a same-file, side-effect-free, single-`return`-expression function** (`tsEvalCall`,
another case on `tsEvalConst` itself, alongside Literal/Identifier/Unary/Binary): `function
double(x) { return x * 2n; } const y = double(21n);` folds `double(21n)` to `42n` at the call
site, which then composes for free with the const-propagation/DCE passes above — `const y`
becomes `const y = 42n;` (an ordinary resolved top-level const as far as those two passes are
concerned), so a later `console.log(y)` collapses all the way to `console.log(42n);` and `y`'s
own now-dead declaration is removed, with zero special-casing needed in either pass. **Three hard
boundaries, deliberately not relaxed in this first cut:** (1) the callee's body must have ZERO
`CallExpression`/`NewExpression` anywhere — not just no *recursive* call, no call to ANYTHING,
even another otherwise-foldable function — which is what makes recursion analysis unnecessary (a
body that never calls out trivially can't recurse) and is the entire soundness argument for
folding the call away at all; (2) same-file only, exactly like every other lookup this evaluator
does (`consts`, now `functions` too) — an imported callee is never resolved this way, regardless
of the separate cross-file function-import mechanism; (3) the callee's own `FunctionDeclaration`
is NEVER touched or eliminated — only the call SITE becomes a literal — since it may still be
called elsewhere with non-constant arguments, or itself be pulled across a file boundary by that
same import mechanism; and (4) the callee must be neither a generator nor `async` — calling either
never yields its `return`ed value directly (a generator yields an Iterator, `async` a Promise), so
`foldableReturnExpr` rejects both up front. Parameters bind as a temporary overlay on top of
`consts` (never mutating it), so a body reading a module-level `const` alongside its own
parameter(s) resolves correctly; an omitted argument for a parameter with a default initializer
evaluates that default too (left-to-right, so a later default may see an earlier bound parameter)
— a deliberate choice, not a rejection, since the zero-nested-call check already covers default
initializers as well. Every one of the callee's OWN parameter names is excluded from the overlay's
initial seed (before any are individually bound) so an EARLIER default can never silently fall
back to an outer const sharing a LATER (not-yet-bound) parameter's name — real JS/TS parameter-list
TDZ semantics mean that would actually throw at runtime, so the fold correctly declines instead of
computing the wrong value. Because a zero-argument call is vacuously "every argument constant,"
this also folds calls like `used()` in `ts-frontend.test.ts`'s existing dead-branch-folding
fixture — which is why that fixture's expected `bytecode.length` dropped from 3 to 2 once this
landed (`used`'s own call is inlined away too, so treeshaking drops it exactly like the
already-dead `unused`). `isFoldableValueExpression` now includes `CallExpression` (it's likewise
never an lvalue), and `foldExpression` deliberately never hands a `CallExpression` to the
`ts-evaluator` fallback — call-folding is governed entirely by `tsEvalCall`'s own rules above, not
by whatever ts-evaluator's no-checker `evaluate()` happens to do with a same-file call today
(confirmed to fail closed on every call shape) or in some future version.

**Shadow-safe by construction, not just for calls.** `tsEvalConst`'s Identifier case and
`tsEvalCall`'s callee lookup both consult a `shadowed: ReadonlySet<string>` that `foldTransformer`
grows on the way down through every scope-introducing node it visits (function/method/getter/
setter bodies, blocks, catch clauses, for/for-in/for-of loops) — mirroring
`constPropagationTransformer`'s own shadow tracking one section below. A name reserved by ANYTHING
between the current node and the top level (a parameter, a nested function/let/const/var/
catch-binding of the same name, …) is never resolved against the top-level `consts`/`functions`
maps: a nested `function calc(x) { … }` shadowing an outer top-level `calc`, a parameter named the
same as an outer top-level function (the classic higher-order-function pattern, e.g. `function
callIt(greet) { return greet(1n); }`), a block-scoped `let` of the same name, or simply a
function's own parameter sharing a name with an unrelated top-level `const` (`function f(x) {
return x * 2n; }` beside a top-level `const x`) — all correctly decline to fold rather than
silently resolving against the wrong (top-level) binding.

**Array/object lookup-table folding.** A top-level `const NAME = [<foldable>, ...]` / `const NAME
= { key: <foldable>, ... }` — a fee-tier table, a tick-spacing table, any table written purely for
readable compile-time reference — where every element/property itself folds to a bigint (the SAME
`tsEvalConst`/`consts` machinery the scalar consts above already use — a table's elements may
reference an earlier scalar top-level const, but never another table: no "tables of tables") is a
candidate lookup table. A candidate is only ever actually tracked once a **whole-file, shadow-aware
soundness scan** (`checkTableSafety`/`isSafeTableRead`, mirroring `constPropagationTransformer`'s
own shadow-tracking) proves every remaining use of its name is a plain, constant-indexed read
(`NAME[k]`/`NAME.prop`/`NAME["prop"]`) that is itself neither a write nor a call target. This is a
strict **allowlist** (only the recognized-safe shape passes), not a blocklist of known-bad shapes,
so an unrecognized escape shape fails closed by construction: the identifier being reassigned or
`++`/`--`-updated; used as the base of ANY method call (`NAME.anything(...)`, regardless of method
name — no whitelist of "safe" methods); an element/property access used as a write target
(`NAME[i] = ...`, `NAME.x = ...`, including one nested — however deeply, climbing through the
object/array-literal "pattern" node shapes TypeScript reuses for destructuring assignment —
inside a destructuring-assignment target like `({ k: NAME.x } = obj)` / `[NAME.x] = arr`); or the
bare identifier passed as a call argument, aliased to another variable, returned, or spread — ANY
of these disqualifies the table from being tracked AT ALL, even if every other access to it would
individually have been perfectly safe (no partial folding of an otherwise-safe table). A
disqualifying use counts even inside unreachable code (`if (false) { ARR.push(1n); }` still
disqualifies) — the scan is purely syntactic, not reachability-aware. `checkTableSafety`
deliberately does NOT reuse the scalar-propagation passes' blanket "class/enum/namespace body →
skip entirely, don't descend" (sound there only because a const scalar's *value* can't be mutated
from inside one without illegally reassigning its binding, already a hard error): a class method
or namespace function CAN mutate a tracked table without reassigning the table's own binding, so
encountering one of these node kinds while scanning instead disqualifies the table outright the
moment its name occurs anywhere inside (a coarser, fail-closed check, not a re-derived "was it
actually a safe read" analysis) — these shapes don't occur in the supported base language surface
and are independently rejected by `compile()` regardless, but `tsPartialEval` is a separately
exported function so this scan fails closed on its own too. Once a table passes the
scan, `tableFoldTransformer` (running right after `foldTransformer`, so a loop-unrolled literal
index like `TABLE[i]` where `i` was just substituted by unrolling is still resolvable) replaces
each resolvable access with its literal element/property value; an access that ISN'T resolvable
(a non-constant index, an out-of-bounds or negative array index, a non-string-literal computed key
into an object table) is simply left untouched and does NOT disqualify other, provably-resolvable
accesses of the same table elsewhere — each access is judged independently once the file-wide
immutability proof holds. The now-fully-dead declaration is then removed by the SAME
`deadConstEliminationTransformer` dead-declaration-elimination pass already used for scalar consts
(extended to also track table names). **Explicitly out of scope**, a literal simply never becoming
a candidate (left completely untouched, same as any other non-fully-foldable initializer):
`new Array(n)` (a wholly different, engine-level HEAP-allocated SauceScript concept, untouched by
any of this); a spread element inside the literal itself (`[...x]`, `{...x}`); an object literal's
shorthand/method/getter/setter property or a COMPUTED property name in the declaration itself
(`{ [k]: v }` — only plain `key: value` / `"key": value` properties are supported); a nested
array/object literal as an element/property value ("tables of tables" — deliberately rejected
rather than supported, keeping the recursive-fold requirement to one flat level); and `for...in`
(this feature only ever folds direct index/property reads, never enumerates).

**Stretch: `for (const x of ARR) {...}` unrolling over a tracked ARRAY table.** Reuses the exact
same safety infrastructure as the numeric `for`/`while` unroller above (`MAX_UNROLL_ITERATIONS`,
`bodyBlocksUnrolling`'s break/continue/return/shadowing bail, `substituteCounter`) adapted to
iterate over the table's ELEMENTS instead of an arithmetic sequence — one copy of the body per
element, the loop variable substituted by its literal value each time, cascading into any nested
`if`/loop/table-access keyed on it exactly like the numeric unroller. Iterating an array table via
`for...of` is always a safe, read-only, non-aliasing use on its own (the elements are immutable
bigints) — so it never disqualifies the table from tracking, independent of whether THIS
particular loop shape can actually be unrolled. The unroll itself declines (leaves the loop as real
runtime code, keeping the declaration referenced) on: `for await...of`; a destructured loop
variable (`for (const [a] of ARR)` — only a single plain identifier loop variable is supported);
a body `bodyBlocksUnrolling` rejects; or the table has **more elements than
`MAX_UNROLL_ITERATIONS`** (256, the same cap the numeric unroller reuses). Because eliding one
`ForOfStatement` in favor of N unrolled statements replaces one statement-list entry with many —
which a single-node visitor cannot express — the attempt only ever fires from a genuine
statement-LIST position (`Block.statements`/`SourceFile.statements`, via a dedicated
`visitStatementList`, mirroring `foldStatementList`'s own role in the numeric/while unroller); a
`for...of` sitting in a single-statement slot (e.g. the un-braced body of an outer `for`/`if`) is
conservatively left un-unrolled. This isn't just a bytecode-shape optimization: plain acorn has
**no** `ForOfStatement` handling at all (`compile()` without `tsSource`/a `.ts` import throws
`not implemented: ForOfStatement` outright), so unrolling this away in the TS front-end is what
makes a `for...of` over a lookup table compilable at all, not merely more efficient — which also
means declining to unroll is a **harder failure here than for the numeric `for`/`while`
unroller**: those gracefully fall back to real `JUMP_BACK` runtime bytecode past their cap, but a
declined `for...of` (e.g. a table with >256 elements) leaves a `ForOfStatement` node with no
runtime-bytecode fallback at all, so `compile()` — even with `tsSource: true` — throws `not
implemented: ForOfStatement` rather than compiling suboptimally.

**Known limitation (not fixed)**: this only folds/propagates compile-time-known COUNTERS/BOUNDS,
same-file top-level `const` VALUES, the narrow same-file/single-return/constant-args CALL shape,
and the narrow compile-time-only lookup-table case above — not general array/object DATA
processing (`arr[i]`/`.push()`/`for...of` on non-table data, mutable arrays, arrays built at
runtime) — ts-evaluator's no-checker mode can't resolve property/array access or function calls at
all, and a full `ts.Program`/TypeChecker is a much bigger lift, out of scope here.

**Assignment expressions are never folded.** The TS AST represents `=`/`+=`/etc. as a
`BinaryExpression`, and `ts-evaluator`'s `evaluate()` "succeeds" on a bare assignment (e.g.
`evaluate(a = 1)` → `{success: true, value: 1}`), which would silently discard the assignment's
side effect if treated as an ordinary foldable value expression (rewriting `a = 1;` to bare `1;`).
`foldExpression` guards against this up front via an `ASSIGNMENT_OPERATOR_TOKENS` check — a
`BinaryExpression` using any assignment-family operator token always fails closed before either
evaluator runs, so `a = 1` (and `if (a = 1)`) are left untouched.

**Compile cache (`src/cache.ts`) — ON BY DEFAULT** — `compile()` is a pure function of (source,
options, on-disk import contents), so it memoizes: a repeat `(source, options)` returns a cached
`CompileResult` instead of recompiling (~9× on recurring compiles). `options.cache`: omitted/`true`
→ the process-global default store (`getDefaultCompileCache`, bounded LRU); `false` → bypass
(guaranteed-fresh compile); a `Map`/`createCompileCache(maxEntries)` → that store (with hit/miss
stats). The key (`compileCacheKey`) covers every output-affecting option with `compile()`'s own
defaults, so a difference can only MISS, never mis-hit; `baseDirs` resolve to absolute so a relative
dir keys by the file it actually reads (cwd-dependent). **The two inputs the key can't see —
`transformModule` behavior and imported-file bytes — are now a DEFAULT environment contract**: keep
them stable within a process, else a recompile of the same source returns stale bytecode. Escape
hatches: `cache: false` (bypass), `clearDefaultCompileCache()` (after editing an imported file), or
`cacheKeyExtra` (a fingerprint string mixed into the key). Results are cloned in and out, so a
caller can never corrupt the cache and every call returns a fresh mutable result.

**Compiler fixes (this branch):** (a) `new Array(n)` now **infers as DYNAMIC (heap) storage** so the
TUPLE descriptor survives a variable round-trip — scalar/bytes32 storage dropped the descriptor, so
`arr[i]` read/write reverted after `let a = new Array(n)`. (b) v12 `staticCall`/`delegateCall`
`stackEffect` is **-1** (they push a result), not -2 — fixes corrupt SDUP positions when a param is read
after a static call. (c) v12 assembly emits a **no-param ARG-PROLOGUE entry** that pushes the
compile-time args then falls through into `main` (the v12 analogue of v1's appended `CALL_FUNCTION` arg
segment) — so **parameterized programs run on the Huff runtime**. (`main` is inlined, not a table fn →
it can't recurse, same as v1.) (d) **Array destructuring of multi-output call returns**:
`const [price, tick] = pool.slot0()` compiles on v1+v12 and makes ONE external call — raw returndata
lands in a hidden heap temp, each bound element is re-derived via `INDEX(ABI_DECODE(READ(temp)))`, so
the decoded tuple is never stored and the v1 descriptor round-trip fault can't happen. Shape B
(`const s = pool.slot0()` then `s[k]`) keeps its store byte-identical (arrakis/pendle `return result`
bare reads still compile), but the indexed reads/writes that were guaranteed v1 runtime faults
(`SauceInvalidOperationArgs(INDEX)`) are now compile errors pointing at destructuring; v12 untouched.

**Known v12 limit (follow-up):** the Huff runtime's dynamic-value descriptor packs the data pointer in
16 bits (region `0x5000`→`0xFFFF`, ≈45 KB), so a program whose total dynamic data exceeds that gets a
truncated pointer → garbage read → revert. The fix needs a runtime-wide Huff pointer widening — out of
scope here.

**`sdk/`** — a data registry, no runtime logic. `src/protocols/<slug>/` per protocol (`info`,
`addresses`, `abis` as-const, `functions` SauceScript templates); `src/protocols/index.ts` is the
query registry. `src/skills/*.md` are AI-ready per-protocol docs (loaded by `loader.ts`, shipped in
the package). `src/chains/`, `src/recipes/`, `src/core/types.ts`. **SDK tests compile every protocol's
`sauceFunctions` through the real compiler — build the compiler first or they fail.**

**`actions/`** — `actionsToSauce(actions)` lowers routing intents (`uniswapV3ExactInput`, bridges,
wraps, stakes) to bytecode. Actions **chain**: output feeds the next implicitly (no `amountIn`) or via
`saveOutputAs`/`amountRef`. See `actions/AMM_SWAP_INTERFACES.md`.

**`dev-tools/`** — harness: `start:local`/`start:fork` boot a hardhat net + deploy the engine;
`npm run sauce <file.js> [args]` compiles+runs a SauceScript; `npm run recipe …` runs recipes.

## The swap Router (`../sauce/engine/src/Router.sol`)

Lives in the **private engine repo**, not here, but recipes target it (its `Router`/`SauceRouter`
artifacts are what `cook()` runs against). `SauceRouter` is a thin delegatecall proxy → `Router`
(`~1218` lines). Recipes import the minimal `ISauceRouter` ABI from `dev-tools/artifacts/`.

**Entry points** (all the `swap*` ones are `onlySelf` — callable only via `cook()` from the same
contract, so a recipe calls them as `ISauceRouter.at(address.self).swapX(...)`):
- `swap(SwapParams)` — unified swap; dispatches on `params.poolType` to `_swapV2/_swapV3/_swapV4/
  _swapCurve/_swapBalancerV2/_swapDODOV2/_swapTraderJoeLB/_swapMaverickV2/_swapWOOFi`.
  `SwapParams` embeds a `PoolKey` struct (`currency0,currency1,fee,tickSpacing,hooks`) used **only by
  V4** (ignored for V2/V3). Calling this from SauceScript **now works**: the compiler orders
  object-literal struct fields by the ABI's declared component order at the call boundary (recursively
  for nested tuples) — see `compiler/src/processor/expression.ts` `processAbiArg`/`orderedStructTuple`,
  unit-pinned by `compiler/test/struct-arg-order.test.ts`. (Previously it sorted fields alphabetically,
  scrambling the nested `PoolKey` → empty revert.) The flat methods below remain valid alternatives.
- `swapV3(pool, tokenIn, tokenOut, amountSpecified, sqrtPriceLimitX96, payer, recipient)` and
  `swapV4(...)` — **flat** legacy methods (no nested struct), verified working from SauceScript.
- `quote(QuoteParams)` — off-chain simulation; performs the swap and reverts with `QuoteRevert(amountIn,
  amountOut, sqrtPriceAfter, gas)` (caught by `shared/quoting.ts`). Never lands a swap.

**`amountSpecified` sign is inconsistent by path** (this bit us): the flat `swapV3` passes through to
Uniswap, where **positive = exact input** (verified on fork). The unified `swap()`/V4 path and the
`SwapParams`/`QuoteParams` doc say **negative = exact input** (Uniswap-V4/quote convention). For
recipes using flat `swapV3`, pass a **positive** amount.

**`SwapPoolType` enum** (must match recipe constants): `UniV2=0, UniV3=1, UniV4=2, Curve=3,
BalancerV2=4, DODOV2=5, TraderJoeLB=6, MaverickV2=7, WOOFi=8`.

**Callbacks vs callback-free** — the key architectural split for "where does swap logic live":
- **V2/Solidly/Curve/DODO** are *callback-free*: `_swapV2` reads reserves, computes out (V2 fee
  hardcoded 0.3% via `_getAmountOut`'s `*997/1000`), transfers tokenIn to the pool, calls
  `pair.swap(...)`. A recipe can replicate this **entirely in SauceScript** (transfer + `pool.swap`),
  bypassing the router — so new callback-free sources need only new SauceScript, no engine change.
- **V3/V4 (and Maverick)** use *callbacks*: the pool re-enters the contract mid-swap
  (`uniswapV3SwapCallback`/`pancakeV3SwapCallback`/`unlockCallback`/`maverickV2SwapCallback`) to pull
  input, reading transient-storage context set by `_swapV3`. A reentrant call during `cook()` hits the
  contract's Solidity dispatcher, **not** the paused bytecode interpreter — so callbacks can only be
  serviced by the router's compiled code. These swaps **must** go through the router (`swapV3`/`swapV4`).

## Publishing

Tag-driven (`.github/workflows/publish.yml`): `git tag v1.2.3 && git push origin v1.2.3` (or manual
`workflow_dispatch`). Builds all areas, runs `prepack` (syncs artifacts), stamps the **root**
`package.json` version, and publishes the single `@eco-incorp/sauce-sdk` to **both** npmjs.com
(`NPM_TOKEN`) and GitHub Packages (`GITHUB_TOKEN`). Only the root version is published; workspace
packages stay `private`.
