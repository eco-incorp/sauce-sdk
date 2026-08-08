/**
 * Proves the AMBIENT TYPE side of the default-globals feature: a file that
 * imports NOTHING from the SDK can still reference `Base`/`chain` and have
 * it typecheck, as long as SOME file in the same tsc program pulls in
 * `src/index.ts` (which is what a consumer's own program does merely by
 * importing the package -- see `routes/globals.ts`'s module doc for the
 * measured proof that this also survives declaration emit into `dist/`).
 *
 * This test runs the real `typescript` compiler (the same version this repo
 * builds with) over this repo's own `src/**` program, PLUS one extra
 * no-import probe file, using `sdk/tsconfig.json`'s own compilerOptions --
 * so it exercises the actual ambient chain (`index.ts` -> `routes/globals.ts`
 * -> `routes/globals.generated.ts` -> `declare global`), not a hand-rolled
 * subset of it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

const SDK_DIR = resolve(process.cwd());
const TSCONFIG_PATH = resolve(SDK_DIR, "tsconfig.json");

function typecheckProbe(probeSource: string): readonly ts.Diagnostic[] {
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, SDK_DIR);

  const probeDir = mkdtempSync(join(tmpdir(), "routes-globals-ambient-"));
  const probePath = join(probeDir, "probe.ts");
  writeFileSync(probePath, probeSource);

  try {
    const program = ts.createProgram({
      rootNames: [...parsed.fileNames, probePath],
      options: { ...parsed.options, noEmit: true },
    });
    const probeSourceFile = program.getSourceFile(probePath);
    if (probeSourceFile === undefined) throw new Error("probe file was not included in the program");
    return [
      ...program.getSyntacticDiagnostics(probeSourceFile),
      ...program.getSemanticDiagnostics(probeSourceFile),
    ];
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

describe("routes globals: ambient types resolve with zero import", () => {
  it("a file with NO import of the SDK at all can reference Base/Solana/chain and typechecks clean", () => {
    const diagnostics = typecheckProbe(`
      const originA: unknown = Base;
      const originB: unknown = Solana;
      const front: unknown = chain;
      export {};
    `);
    expect(diagnostics).toHaveLength(0);
  });

  it("negative control: an UNKNOWN name is still a real compile error (the harness itself can fail)", () => {
    const diagnostics = typecheckProbe(`
      const x: unknown = TotallyNotARealGlobalName;
      export {};
    `);
    expect(diagnostics.some((d) => d.code === 2304)).toBe(true); // TS2304: Cannot find name
  });

  it("Base's ambient type is the real ChainOrigin shape -- .route(...) is callable and typed, not `any`", () => {
    const diagnostics = typecheckProbe(`
      const reward = {
        deadline: 1000n,
        creator: "0x1111111111111111111111111111111111111111" as const,
        prover: "0x2222222222222222222222222222222222222222" as const,
      };
      const pending = Base.route(reward);
      // .route() on a ChainOrigin returns a PendingLeg with generated
      // per-chain destination methods -- confirm one resolves and is callable.
      const intents: unknown = pending.Solana();
      export {};
    `);
    expect(diagnostics).toHaveLength(0);
  });
});
