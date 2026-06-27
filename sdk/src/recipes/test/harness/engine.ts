/**
 * Engine selection for the local-anvil EcoSwap EVM tests.
 *
 * The recipe runs on two engines: the v1 Solidity SauceRouter (prefix bytecode)
 * and the v12 Huff runtime behind a V12Pot (postfix bytecode). v12 is the DEFAULT
 * — these tests are the correctness gate for the engine the SDK now ships against.
 *
 * Knob — `ECO_ENGINE`:
 *   unset | "v12" → v12 (DEFAULT)
 *   "v1"          → v1
 *   "both"        → v1 + v12 (matrix; v12 cell only if the artifacts are present)
 *
 * Back-compat: `SAUCE_ENGINE_V12=1`/`=true` is honored as an alias for
 * `ECO_ENGINE=v12` (the prior opt-in knob).
 *
 * v12 requires the synced v12 artifacts (V12_AVAILABLE). If v12 is explicitly
 * selected ("v12"/default/the alias) but the artifacts are absent, this throws a
 * clear, actionable error rather than silently falling back to v1 — the engine the
 * suite gates on must be the engine that actually ran. ("both" tolerates a missing
 * v12: the v12 cell is skipped so a v1-only environment can still run the matrix.)
 */

import type { Account, Hex } from "viem";

import {
  V12_AVAILABLE,
  deployV12Stack,
  type DeployedStack,
  type DeployedV12Stack,
} from "./setup";
import type { HarnessClients } from "./clients";

export type Engine = "v1" | "v12";

/** Compile/runtime target string for an engine (identity — explicit at call sites). */
export function engineTarget(engine: Engine): Engine {
  return engine;
}

const FIX_HINT =
  "pin the engine to feat/v12-descriptor-32bit and run " +
  "`pnpm --filter ./dev-tools sync-artifacts`, or set ECO_ENGINE=v1";

/** Raw ECO_ENGINE selection, folding in the SAUCE_ENGINE_V12 back-compat alias. */
function rawSelection(): "v1" | "v12" | "both" {
  const env = (process.env.ECO_ENGINE ?? "").trim().toLowerCase();
  if (env === "v1" || env === "v12" || env === "both") return env;
  if (env === "") {
    // No ECO_ENGINE: the legacy opt-in alias still maps to v12 (now the default
    // anyway), so it's a no-op for fresh runs but keeps old invocations working.
    const alias = process.env.SAUCE_ENGINE_V12;
    if (alias === "1" || alias === "true") return "v12";
    return "v12"; // DEFAULT
  }
  throw new Error(`invalid ECO_ENGINE=${env} (expected one of: v1, v12, both)`);
}

/**
 * The engines to iterate for a test, honoring ECO_ENGINE (default v12).
 *
 * Throws if v12 is EXPLICITLY selected (default/"v12"/alias) without the artifacts
 * — no silent fallback. For "both" a missing v12 is tolerated (cell skipped) so a
 * v1-only environment can still run the matrix.
 */
export function selectedEngines(): Engine[] {
  const sel = rawSelection();
  if (sel === "v1") return ["v1"];
  if (sel === "v12") {
    if (!V12_AVAILABLE) {
      throw new Error(`v12 selected but the v12 engine artifacts are missing — ${FIX_HINT}`);
    }
    return ["v12"];
  }
  // both
  return V12_AVAILABLE ? ["v1", "v12"] : ["v1"];
}

/**
 * Engine list as `{ engine, skip }` cells for a `for … of` over `it()`. v12 is
 * skipped (not thrown) only in the "both" matrix when artifacts are absent; an
 * explicit v12 selection has already thrown in selectedEngines().
 */
export function engineCells(): { engine: Engine; skip: boolean }[] {
  const sel = rawSelection();
  const cells: { engine: Engine; skip: boolean }[] = [];
  if (sel === "v1" || sel === "both") cells.push({ engine: "v1", skip: false });
  if (sel === "v12" || sel === "both") {
    cells.push({ engine: "v12", skip: sel === "both" && !V12_AVAILABLE });
  }
  if (sel === "v12") selectedEngines(); // throws here if v12 unavailable
  return cells;
}

/** True when any selected engine is v12 (so a before() should deploy the v12 stack). */
export function needsV12(): boolean {
  return selectedEngines().includes("v12");
}

/**
 * Deploy the v12 stack iff any selected engine is v12, returning null otherwise.
 * `owner` is the cook caller (the Pot's cook is owner-gated) and the recipe caller.
 * Callers that get a non-null result must approve the Pot for tokenIn (the program
 * does transferFrom(caller, self=Pot, …)).
 */
export async function maybeDeployV12Stack(
  c: HarnessClients,
  owner: Account,
): Promise<DeployedV12Stack | null> {
  if (!needsV12()) return null;
  return deployV12Stack(c.walletClient, c.publicClient, owner);
}

/**
 * The cook() entrypoint for an engine: the SauceRouter for v1, the owner's V12Pot
 * for v12 (delegatecalls the Huff runtime for cook + the SauceRouter for swap
 * callbacks, all in the Pot's context). This is also the address the program does
 * transferFrom(caller, self, …) into, so it's the address to approve for tokenIn.
 */
export function cookTarget(
  engine: Engine,
  stack: DeployedStack,
  v12: DeployedV12Stack | null,
): Hex {
  if (engine === "v1") return stack.sauceRouter;
  if (!v12) throw new Error("v12 cook target requested but the v12 stack was not deployed");
  return v12.pot;
}

/**
 * The SauceRouter to QUOTE against (route quoting is off-chain RPC reads, so it is
 * target-agnostic — but the v12 Pot's fallback reaches its OWN SauceRouter, so we
 * hand prepare that one when on v12 for consistency).
 */
export function quoteRouter(
  engine: Engine,
  stack: DeployedStack,
  v12: DeployedV12Stack | null,
): Hex {
  if (engine === "v1") return stack.sauceRouter;
  if (!v12) throw new Error("v12 quote router requested but the v12 stack was not deployed");
  return v12.sauceRouter;
}
