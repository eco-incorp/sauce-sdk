/**
 * Artifact loading helpers.
 *
 * Engine artifacts (Router/SauceRouter) and fixtures may carry creation
 * bytecode either as `.bytecode` (a hex string) OR `.bytecode.object`
 * (Foundry's nested form). Uniswap v3-core artifacts use `.bytecode` string.
 * normalizeBytecode handles all three.
 */

import { readFileSync } from "node:fs";
import type { Abi, Hex } from "viem";

export interface LoadedArtifact {
  abi: Abi;
  bytecode: Hex;
}

/** Coerce a raw artifact `bytecode` field (string | { object }) to a 0x Hex. */
export function normalizeBytecode(raw: unknown): Hex {
  let hex: string | undefined;
  if (typeof raw === "string") {
    hex = raw;
  } else if (raw && typeof raw === "object" && "object" in raw) {
    const obj = (raw as { object?: unknown }).object;
    if (typeof obj === "string") hex = obj;
  }
  if (hex === undefined) {
    throw new Error("artifact bytecode missing or in unexpected shape");
  }
  if (!hex.startsWith("0x")) hex = "0x" + hex;
  return hex as Hex;
}

/** Load an artifact JSON from disk and extract { abi, bytecode }. */
export function loadArtifact(path: string): LoadedArtifact {
  const json = JSON.parse(readFileSync(path, "utf-8")) as {
    abi: Abi;
    bytecode: unknown;
  };
  return { abi: json.abi, bytecode: normalizeBytecode(json.bytecode) };
}
