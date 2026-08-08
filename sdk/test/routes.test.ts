/**
 * eco-routes fluent builder — CONTRACT tests. Pure data assertions, no
 * compiler/forge/network involved.
 */
import { canonicalChains, requireChain } from "../src/chains/canonical.js";
import {
  chain,
  chainAccessors,
  pascalOfSlug,
  toUniversalAddress,
  toBigInt,
} from "../src/routes/index.js";
import type { Intent, RewardInput, RouteInput } from "../src/routes/index.js";

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

describe("routes: single leg", () => {
  it("assembles exactly one intent with the right ids and round-tripped data", () => {
    const r = reward();
    const rt = route();
    const intents = chain("base").route(r).Solana(rt).build();

    expect(intents).toHaveLength(1);
    const [intent] = intents;
    expect(intent.sourceChainId).toBe(8453n);
    expect(intent.destination).toBe(1399811149n);
    expect(intent.route.calls[0]!.data).toBe("0xabcdef");
    expect(intent.route.tokens[0]!.amount).toBe(10n);
  });

  it("copies caller arrays -- mutating the input afterward does not change the intent", () => {
    const calls: Array<NonNullable<RouteInput["calls"]>[number]> = [
      { target: "0x4444444444444444444444444444444444444444", data: "0xaa", value: 1n },
    ];
    const rt = route({ calls });
    const intents = chain("base").route(reward()).Solana(rt).build();
    calls.push({ target: "0x6666666666666666666666666666666666666666", data: "0xbb", value: 2n });
    expect(intents[0]!.route.calls).toHaveLength(1);
  });
});

describe("routes: the literal example, verbatim", () => {
  it("Base.route(rewardA).Solana(routeA).route(rewardB).Ethereum() yields 2 intents", () => {
    const { Base, Solana, Ethereum } = chainAccessors;
    const rewardA = reward({ deadline: 111n });
    const routeA = route({ deadline: 222n });
    const rewardB = reward({ deadline: 333n });

    const intents: Intent[] = Base.route(rewardA).Solana(routeA).route(rewardB).Ethereum();

    expect(intents).toHaveLength(2);
    const [leg1, leg2] = intents;

    expect(leg1!.sourceChainId).toBe(8453n);
    expect(leg1!.destination).toBe(1399811149n);
    expect(leg1!.reward.deadline).toBe(111n);
    expect(leg1!.route.deadline).toBe(222n);

    expect(leg2!.sourceChainId).toBe(1399811149n);
    expect(leg2!.destination).toBe(1n);
    expect(leg2!.reward.deadline).toBe(333n);
    // terminal close: leg2 gets a synthesized empty route
    expect(leg2!.route.calls).toHaveLength(0);
    expect(leg2!.route.tokens).toHaveLength(0);
  });
});

describe("routes: dest becomes next source", () => {
  it("holds across a 4-accessor pipeline", () => {
    const { Base, Solana, Ethereum, Arbitrum } = chainAccessors;
    const intents = Base.route(reward())
      .Solana(route())
      .route(reward())
      .Ethereum(route())
      .route(reward())
      .Arbitrum(route())
      .route(reward())
      .Base();

    expect(intents).toHaveLength(4);
    for (let i = 0; i < intents.length - 1; i++) {
      expect(intents[i + 1]!.sourceChainId).toBe(intents[i]!.destination);
    }
    expect(intents[0]!.sourceChainId).toBe(BigInt(requireChain("base").id));
  });
});

describe("routes: terminal close", () => {
  it("zero-arg dest returns Intent[] with an empty route inheriting the reward deadline", () => {
    const r = reward({ deadline: 999n });
    const result = chain("base").route(r).Solana();
    expect(Array.isArray(result)).toBe(true);
    const [intent] = result as Intent[];
    expect(intent!.route.deadline).toBe(999n);
    expect(intent!.route.calls).toHaveLength(0);
    expect(intent!.route.tokens).toHaveLength(0);
    expect(intent!.route.nativeAmount).toBe(0n);
    expect(intent!.route.portal).toBe("0x" + "00".repeat(32));
    expect(intent!.route.salt).toBe("0x" + "00".repeat(32));
  });

  it("with-route form returns a continuable stage, not an array", () => {
    const stage = chain("base").route(reward()).Solana(route());
    expect(Array.isArray(stage)).toBe(false);
    expect(typeof (stage as { route?: unknown }).route).toBe("function");
    expect(typeof (stage as { build?: unknown }).build).toBe("function");
  });
});

describe("routes: unknown chain", () => {
  it("chain(ref) throws for an unknown ref", () => {
    expect(() => chain("bogus")).toThrow(/Unknown chain 'bogus'/);
  });

  it("pendingLeg.to(ref) throws for an unknown ref", () => {
    const pending = chain("base").route(reward());
    expect(() => pending.to("bogus")).toThrow(/Unknown chain 'bogus'/);
  });

  it("has no accessor for an unknown chain", () => {
    expect("Bogus" in chainAccessors).toBe(false);
  });

  it("resolves known aliases (positive control)", () => {
    expect(chain("eth").chain.slug).toBe("ethereum");
    expect(chain(8453).chain.slug).toBe("base");
    expect(chain("BNB Chain").chain.slug).toBe("bsc");
  });
});

describe("routes: EVM + SVM legs", () => {
  it("EVM -> SVM -> EVM pipeline", () => {
    const { Base, Solana, Ethereum } = chainAccessors;
    const intents = Base.route(reward()).Solana(route()).route(reward()).Ethereum(route());
    expect(intents.chain.kind).toBe("evm");
    expect(intents.build()[0]!.destination).toBe(1399811149n);
  });

  it("SVM-origin pipeline", () => {
    const { Solana, Base } = chainAccessors;
    const intents = Solana.route(reward()).Base();
    expect(intents[0]!.sourceChainId).toBe(1399811149n);
    expect(intents[0]!.destination).toBe(8453n);
  });

  it("chain('solana').chain.kind is svm; EVM ends are evm", () => {
    expect(chain("solana").chain.kind).toBe("svm");
    expect(chain("base").chain.kind).toBe("evm");
    expect(chain("ethereum").chain.kind).toBe("evm");
  });

  it("Call.value survives on an SVM leg (the value-drop is an encode-time concern, not this layer's)", () => {
    const rt = route({
      calls: [{ target: "0x7777777777777777777777777777777777777777", data: "0x01", value: 42n }],
    });
    const intents = chain("base").route(reward()).Solana(rt).build();
    expect(intents[0]!.route.calls[0]!.value).toBe(42n);
  });
});

describe("routes: accessor generation is registry-derived", () => {
  it("the key set matches a fresh pascal derivation from canonicalChains, no literal list", () => {
    const expectedKeys = canonicalChains.map((c) => pascalOfSlug(c.slug)).sort();
    const actualKeys = Object.keys(chainAccessors).sort();
    expect(actualKeys).toEqual(expectedKeys);
    expect(new Set(expectedKeys).size).toBe(expectedKeys.length); // duplicate-free
    expect(Object.keys(chainAccessors)).toHaveLength(canonicalChains.length);
  });

  it("each accessor's .chain is the matching registry record", () => {
    for (const c of canonicalChains) {
      const key = pascalOfSlug(c.slug);
      expect((chainAccessors as Record<string, { chain: unknown }>)[key]!.chain).toEqual(c);
    }
  });
});

describe("routes: stage immutability / branching", () => {
  it("one PendingLeg reused for two different destinations yields independent results", () => {
    const pending = chain("base").route(reward());
    const toSolana = pending.Solana();
    const toEthereum = pending.Ethereum();
    expect(toSolana[0]!.destination).toBe(1399811149n);
    expect(toEthereum[0]!.destination).toBe(1n);
  });

  it("two build() calls return distinct arrays with equal contents", () => {
    const stage = chain("base").route(reward()).Solana(route());
    const a = stage.build();
    const b = stage.build();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("mutating a returned array leaves a later build() unaffected", () => {
    const stage = chain("base").route(reward()).Solana(route());
    const a = stage.build();
    a.pop();
    expect(stage.build()).toHaveLength(1);
  });
});

describe("routes: normalization", () => {
  it("left-pads a 20-byte EVM address into a 32-byte UniversalAddress", () => {
    const got = toUniversalAddress("0x1111111111111111111111111111111111111111");
    expect(got).toBe("0x" + "00".repeat(12) + "11".repeat(20));
  });

  it("passes an already-32-byte value through unchanged", () => {
    const value = `0x${"ab".repeat(32)}` as const;
    expect(toUniversalAddress(value)).toBe(value);
  });

  it("throws on a malformed/oversized address", () => {
    expect(() => toUniversalAddress("0x1234" as never)).toThrow();
    expect(() => toUniversalAddress(("0x" + "11".repeat(21)) as never)).toThrow();
  });

  it("toBigInt accepts number/string/bigint and rejects negatives", () => {
    expect(toBigInt(5)).toBe(5n);
    expect(toBigInt("5")).toBe(5n);
    expect(toBigInt(5n)).toBe(5n);
    expect(() => toBigInt(-1)).toThrow();
    expect(() => toBigInt("-1")).toThrow();
    expect(() => toBigInt(-1n)).toThrow();
  });
});
