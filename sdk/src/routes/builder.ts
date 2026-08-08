/**
 * Fluent builder stage machinery. Generic over `<TRoute, TReward>` and
 * parameterized by an `assemble` function, so a v3 reward-leg model can
 * instantiate a whole new builder without forking this file — only
 * `intent.ts` (and `types.ts`) need to change.
 *
 * Every stage is an immutable value: a transition allocates a new stage
 * rather than mutating one in place, so a `PendingLeg`/`ChainStage` can be
 * branched and reused safely (see `sdk/test/routes.test.ts`'s "stage
 * immutability" cases).
 */
import type { CanonicalChain, ChainSlug } from "../chains/canonical.js";
import { canonicalChains, requireChain } from "../chains/canonical.js";
import type { Intent, RouteInput, RewardInput } from "./types.js";

export type ChainRef = number | string | CanonicalChain;

/**
 * `PascalOf<"bnb-chain">` = `"BnbChain"`. Matches the runtime `pascal()`
 * derivation in `accessors.ts` by construction (both reduce to
 * `Capitalize<S>` composed across `-`-separated segments) — re-exported from
 * `accessors.ts` so callers only need one import site.
 */
export type PascalOf<S extends string> = S extends `${infer H}-${infer T}`
  ? `${Capitalize<H>}${PascalOf<T>}`
  : Capitalize<S>;

/** One generated method per canonical chain slug, PascalCase-keyed. */
export type DestinationSelectors<R, W> = {
  readonly [S in ChainSlug as PascalOf<S>]: DestinationMethod<R, W>;
};

export interface DestinationMethod<R = RouteInput, W = RewardInput> {
  /** TERMINAL close: no destination route -> the chain is finished, intents are returned. */
  (): Intent[];
  /** CONTINUING close: attaches the destination route; this chain becomes the next leg's source. */
  (route: R): ChainStage<R, W>;
}

export interface ChainOrigin<R = RouteInput, W = RewardInput> {
  /** The registry record this accessor was generated from (or resolved via `chain(ref)`). */
  readonly chain: CanonicalChain;
  /** Opens a leg FROM this chain, escrowing `reward` here. */
  route(reward: W): PendingLeg<R, W>;
}

export interface PendingLeg<R = RouteInput, W = RewardInput> extends DestinationSelectors<R, W> {
  /** Dynamic destination (runtime-resolved chain). Mirrors the generated selectors' two arities. */
  to(ref: ChainRef): Intent[];
  to(ref: ChainRef, route: R): ChainStage<R, W>;
}

export interface ChainStage<R = RouteInput, W = RewardInput> extends Iterable<Intent> {
  /** The chain the previous leg landed on -- the SOURCE of the next leg. */
  readonly chain: CanonicalChain;
  /** Opens the next leg from `chain`. */
  route(reward: W): PendingLeg<R, W>;
  /** Finishes without another leg. Returns a fresh array each call. */
  build(): Intent[];
}

export type Assembler<R, W> = (
  source: CanonicalChain,
  destination: CanonicalChain,
  route: R | undefined,
  reward: W,
) => Intent;

/** Builds the immutable `ChainStage` standing on `chain`, having accumulated `legs` so far. */
function makeChainStage<R, W>(
  chain: CanonicalChain,
  legs: readonly Intent[],
  assemble: Assembler<R, W>,
): ChainStage<R, W> {
  return {
    chain,
    route(reward: W): PendingLeg<R, W> {
      return makePendingLeg(chain, legs, reward, assemble);
    },
    build(): Intent[] {
      return legs.slice();
    },
    [Symbol.iterator](): Iterator<Intent> {
      return legs.slice()[Symbol.iterator]();
    },
  };
}

/** Builds the immutable `PendingLeg` open from `source`, awaiting a destination. */
function makePendingLeg<R, W>(
  source: CanonicalChain,
  legs: readonly Intent[],
  reward: W,
  assemble: Assembler<R, W>,
): PendingLeg<R, W> {
  function closeTo(ref: ChainRef): Intent[];
  function closeTo(ref: ChainRef, route: R): ChainStage<R, W>;
  function closeTo(ref: ChainRef, route?: R): Intent[] | ChainStage<R, W> {
    const destination = requireChain(ref);
    const intent = assemble(source, destination, route, reward);
    const nextLegs = [...legs, intent];
    if (route === undefined) {
      return nextLegs;
    }
    return makeChainStage(destination, nextLegs, assemble);
  }

  const pending: Record<string, unknown> = {
    to: closeTo,
  };
  for (const c of canonicalChains) {
    const key = pascalOfSlug(c.slug);
    pending[key] = (route?: R) => (route === undefined ? closeTo(c) : closeTo(c, route));
  }
  return pending as unknown as PendingLeg<R, W>;
}

/**
 * Builds the top-level `ChainOrigin` for `chain` -- what a generated
 * accessor (`chainAccessors.Base`) or `chain(ref)` returns.
 */
export function makeChainOrigin<R, W>(
  chain: CanonicalChain,
  assemble: Assembler<R, W>,
): ChainOrigin<R, W> {
  return {
    chain,
    route(reward: W): PendingLeg<R, W> {
      return makePendingLeg(chain, [], reward, assemble);
    },
  };
}

/** One generated `ChainOrigin` per canonical chain, PascalCase-keyed. */
export type ChainAccessors<R = RouteInput, W = RewardInput> = {
  readonly [S in ChainSlug as PascalOf<S>]: ChainOrigin<R, W>;
};

/**
 * Generates the top-level chain accessors from `../chains/canonical.js`,
 * parameterized by `assemble` -- the v3-swappable seam. Adding a chain to
 * `CANONICAL_CHAINS` adds an accessor here with zero code changes; a
 * duplicate PascalCase key (two slugs colliding after casing) throws at
 * module-eval time rather than silently overwriting one accessor with
 * another.
 */
export function createChainAccessors<R, W>(assemble: Assembler<R, W>): ChainAccessors<R, W> {
  const out: Record<string, ChainOrigin<R, W>> = {};
  for (const c of canonicalChains) {
    const key = pascalOfSlug(c.slug);
    if (key in out) {
      throw new Error(`duplicate chain accessor '${key}' (from slug '${c.slug}')`);
    }
    out[key] = makeChainOrigin(c, assemble);
  }
  return out as ChainAccessors<R, W>;
}

// --- shared slug/pascal helpers (also used by accessors.ts) ---

/**
 * `PascalOf`'s runtime mirror: split on `-`, upper-case each segment's first
 * character, join. Agrees with the type-level `PascalOf` by construction
 * (both reduce to `Capitalize<S>` per `-`-separated segment) as long as a
 * slug matches `^[a-z0-9]+(-[a-z0-9]+)*$` -- pinned by
 * `chains-canonical.test.ts`.
 */
export function pascalOfSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
