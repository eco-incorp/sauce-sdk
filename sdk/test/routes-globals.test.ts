/**
 * eco-routes DEFAULT GLOBALS -- runtime install tests. Pure in-process
 * `globalThis` assertions, no compiler/forge/network involved.
 *
 * `sdk/src/index.ts` installs on import (module-eval time), so by the time
 * this file's imports resolve, the globals are already live -- most of this
 * file exercises `installRouteGlobals`/`uninstallRouteGlobals` directly to
 * probe collision/idempotence/gating behavior without disturbing that
 * already-installed baseline for other test files in the same worker.
 */
import { canonicalChains, requireChain } from "../src/chains/canonical.js";
import { chainAccessors, pascalOfSlug } from "../src/routes/index.js";
import {
  installRouteGlobals,
  uninstallRouteGlobals,
  routeGlobals,
} from "../src/routes/globals.js";
import type { RewardInput, RouteInput } from "../src/routes/index.js";

function reward(overrides: Partial<RewardInput> = {}): RewardInput {
  return {
    deadline: 1000n,
    creator: "0x1111111111111111111111111111111111111111",
    prover: "0x2222222222222222222222222222222222222222",
    ...overrides,
  };
}

function route(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    deadline: 2000n,
    portal: "0x3333333333333333333333333333333333333333",
    calls: [{ target: "0x4444444444444444444444444444444444444444", data: "0xabcdef", value: 5n }],
    tokens: [{ token: "0x5555555555555555555555555555555555555555", amount: 10n }],
    ...overrides,
  };
}

const g = globalThis as unknown as Record<string, unknown>;

describe("routes globals: installed by default on import", () => {
  it("routeGlobals (the install-on-import result) installed every chain + chain, nothing skipped", () => {
    expect(routeGlobals.skipped).toEqual([]);
    expect(routeGlobals.installed).toHaveLength(canonicalChains.length + 1);
  });

  it("every canonical chain's PascalCase name resolves on globalThis to the SAME accessor object", () => {
    for (const c of canonicalChains) {
      const key = pascalOfSlug(c.slug);
      expect(g[key]).toBe(chainAccessors[key as keyof typeof chainAccessors]);
    }
  });

  it("`chain` the front door is also a global and behaves identically to the named import", () => {
    expect(typeof g.chain).toBe("function");
    const viaGlobal = (g.chain as (ref: unknown) => { chain: unknown })("base");
    expect(viaGlobal.chain).toEqual(requireChain("base"));
  });

  it("end-to-end: Base.route(...).Solana(...).route(...).Ethereum() through the bare globals matches the named-import build", () => {
    const rewardA = reward({ deadline: 111n });
    const rewardB = reward({ deadline: 222n });
    const routeA = route({ deadline: 1n });

    type OriginLike = { route: (r: RewardInput) => any };
    const viaGlobals = (g.Base as OriginLike)
      .route(rewardA)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .Solana(routeA as any)
      .route(rewardB)
      .Ethereum();

    const viaNamedImport = chainAccessors.Base.route(rewardA).Solana(routeA).route(rewardB).Ethereum();
    expect(viaGlobals).toEqual(viaNamedImport);
  });

  it("installed properties are non-enumerable (don't pollute Object.keys(globalThis))", () => {
    const enumerableKeys = Object.keys(globalThis);
    for (const c of canonicalChains) {
      expect(enumerableKeys).not.toContain(pascalOfSlug(c.slug));
    }
    expect(enumerableKeys).not.toContain("chain");
  });
});

describe("routes globals: installRouteGlobals / uninstallRouteGlobals", () => {
  afterEach(() => {
    // Restore the baseline the whole suite (and other test files sharing
    // this worker's globalThis) expects: everything installed, nothing
    // left over from a test-local sentinel.
    delete g.__ECO_ROUTES_TEST_SENTINEL__;
    installRouteGlobals();
  });

  it("never clobbers a name already present on the target -- skip, don't overwrite", () => {
    uninstallRouteGlobals();
    const SENTINEL = Symbol("sentinel");
    g.Zora = SENTINEL;

    const report = installRouteGlobals();

    expect(report.skipped).toContain("Zora");
    expect(report.installed).not.toContain("Zora");
    expect(g.Zora).toBe(SENTINEL);
  });

  it("`in` semantics: an inherited/getter-only property on the target still counts as taken", () => {
    uninstallRouteGlobals();
    const proto = { get Base() { return "inherited"; } };
    const target = Object.create(proto) as Record<string, unknown>;

    const report = installRouteGlobals({ target });

    expect(report.skipped).toContain("Base");
    expect(target.Base).toBe("inherited");
  });

  it("includeChain: false omits the `chain` front door only", () => {
    uninstallRouteGlobals();
    const report = installRouteGlobals({ includeChain: false });
    expect(report.installed).not.toContain("chain");
    expect(report.installed).toHaveLength(canonicalChains.length);
  });

  it("uninstallRouteGlobals removes exactly what this module installed, and re-install is idempotent (not self-skipping)", () => {
    uninstallRouteGlobals();
    const first = installRouteGlobals();
    expect(first.installed.length).toBe(canonicalChains.length + 1);

    uninstallRouteGlobals();
    for (const c of canonicalChains) {
      expect(g[pascalOfSlug(c.slug)]).toBeUndefined();
    }
    expect(g.chain).toBeUndefined();

    const second = installRouteGlobals();
    expect(second.skipped).toEqual([]);
    expect(second.installed.length).toBe(canonicalChains.length + 1);
  });

  it("uninstall leaves an unrelated pre-existing global alone", () => {
    g.__ECO_ROUTES_TEST_SENTINEL__ = "untouched";
    uninstallRouteGlobals();
    expect(g.__ECO_ROUTES_TEST_SENTINEL__).toBe("untouched");
    installRouteGlobals();
  });

  it("a custom target object is populated instead of globalThis, and globalThis is unaffected", () => {
    const target: Record<string, unknown> = {};
    const report = installRouteGlobals({ target });
    expect(report.skipped).toEqual([]);
    expect(target.Base).toBe(chainAccessors.Base);
    // globalThis's own Base is untouched by this call (still whatever the
    // top-level install-on-import set it to).
    expect(g.Base).toBe(chainAccessors.Base);
  });
});
