/**
 * Anvil state cache for the prod-mirror EVM tests.
 *
 * The prod-mirror tests reconstruct REAL Base WETH/USDC pools by minting one
 * position per initialised snapshot tick (the all-pools fixture rebuilds TEN
 * pools — ~1200 boundaries — over ~10 minutes). That reconstruction is fully
 * deterministic given the engine artifacts + the checked-in pool snapshots, so we
 * do it ONCE, snapshot the resulting anvil state to a checked-in blob, and load it
 * instantly on every later run (anvil_dumpState / anvil_loadState). Loading also
 * pins the block timestamp, which removes the evm_revert oracle-accumulator drift
 * that made the heavy tests flake.
 *
 * WHAT THE BLOB BAKES IN
 *   - the deployed Sauce engine bytecode (Router/SauceRouter, factory, helper) and
 *     — when v12 is selected — the V12 stack (kitchen/pot/runtime),
 *   - every reconstructed pool (full tick profiles, etched V2/V4 singletons),
 *   - the funded/approved minter balances.
 * Because addresses come from deterministic CREATE nonces + fixed etch slots, a
 * loadState onto a fresh anvil restores every contract at the SAME address. The
 * derived values the test needs (stack/pool addresses, reserves, poolConfig) are
 * NOT recoverable from raw state, so the builder also returns a small MANIFEST that
 * is checked in alongside the state and rehydrated on load.
 *
 * BLOB LAYOUT (checked in — NOT gitignored, so CI + fresh clones load it):
 *   fixtures/anvil-state/<name>.state.json.gz   gzipped anvil dumpState hex
 *   fixtures/anvil-state/<name>.manifest.json   the builder's derived manifest
 *
 * RECAPTURE (required whenever the engine artifacts OR the reconstruction change):
 *   RECAPTURE_ANVIL_STATE=1 npx tsx --test recipes/test/<fixture>.prodmirror.evm.test.ts
 * Recapture is ALSO implicit on a fresh clone where the blob is absent: the first
 * run reconstructs + writes it. Mirrors the fixtures/snapshots recapture convention.
 *
 * The manifest embeds the engine selection (v1 / v12) it was captured under: a v12
 * blob carries the v12 stack, a v1 blob does not. Loading a blob captured under a
 * DIFFERENT engine than the current selection is a cache miss (forces recapture),
 * so the v1 and v12 lanes keep separate blobs (<name>-v1 / <name>-v12).
 */

import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";

import type { HarnessClients } from "./clients";
import type { Engine } from "./engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "fixtures", "anvil-state");

/** A fixed, far-future block timestamp every cached run is pinned to. */
export const CACHED_BLOCK_TIMESTAMP = 2_000_000_000n;

/** True when the caller asked to force a fresh reconstruction + recapture. */
export function shouldRecapture(): boolean {
  const v = (process.env.RECAPTURE_ANVIL_STATE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Blob paths are suffixed by ENGINE so the v1 and v12 lanes keep separate, checked-
 * in state (the v12 blob carries the V12 stack; the v1 one does not — they must not
 * clobber each other). A given run only touches its own engine's pair.
 */
function statePath(name: string, engine: Engine): string {
  return join(STATE_DIR, `${name}-${engine}.state.json.gz`);
}
function manifestPath(name: string, engine: Engine): string {
  return join(STATE_DIR, `${name}-${engine}.manifest.json`);
}

/** True when both halves of a cached blob exist on disk for `engine`. */
function blobExists(name: string, engine: Engine): boolean {
  return existsSync(statePath(name, engine)) && existsSync(manifestPath(name, engine));
}

interface StoredManifest<M> {
  /** Engine the blob was captured under — a different selection is a cache miss. */
  engine: Engine;
  /** The derived values the test needs (addresses, reserves, …). */
  data: M;
}

/** bigint-aware JSON replacer/reviver so a manifest can carry reserves etc. */
function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? { __bigint__: v.toString() } : v;
}
function bigintReviver(_k: string, v: unknown): unknown {
  if (v && typeof v === "object" && "__bigint__" in (v as Record<string, unknown>)) {
    return BigInt((v as { __bigint__: string }).__bigint__);
  }
  return v;
}

/** Read a stored manifest for `name`/`engine`, or null if absent / wrong engine. */
function readManifest<M>(name: string, engine: Engine): M | null {
  if (!blobExists(name, engine)) return null;
  const stored = JSON.parse(readFileSync(manifestPath(name, engine), "utf-8"), bigintReviver) as StoredManifest<M>;
  if (stored.engine !== engine) return null;
  return stored.data;
}

function writeBlob<M>(name: string, engine: Engine, state: Hex, data: M): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(name, engine), gzipSync(Buffer.from(state.slice(2), "hex")));
  const stored: StoredManifest<M> = { engine, data };
  writeFileSync(manifestPath(name, engine), JSON.stringify(stored, bigintReplacer, 2) + "\n");
}

function readState(name: string, engine: Engine): Hex {
  const gz = readFileSync(statePath(name, engine));
  return ("0x" + gunzipSync(gz).toString("hex")) as Hex;
}

/**
 * Either LOAD the cached reconstructed state (fast) or BUILD it once and write the
 * blob (slow, then fast forever). Returns the manifest the test consumes.
 *
 * The caller boots a FRESH anvil first (cheap), then calls this with the FULL
 * deploy+reconstruct as `build`. On a cache HIT none of `build` runs: a single
 * anvil_loadState restores every contract (engine, factories, etched singletons)
 * and every reconstructed pool at its original deterministic address, and the
 * manifest (addresses, reserves, poolConfig data the test needs) is rehydrated from
 * disk. On a MISS (no blob / RECAPTURE / blob captured under a different engine),
 * `build` runs the full reconstruction and returns the manifest, which is dumped +
 * checked in for next time. Either way the next block's timestamp is pinned to
 * CACHED_BLOCK_TIMESTAMP so the V3 oracle accumulator is deterministic across runs.
 *
 * Because loadState restores the dev account's nonce too, subsequent CREATE/tx
 * nonces line up exactly as if the contracts had just been deployed — so a HIT and
 * a MISS leave the chain in byte-identical states.
 */
export async function withCachedState<M>(opts: {
  name: string;
  engine: Engine;
  c: HarnessClients;
  /** Run the full deploy + reconstruction; returns the manifest. Only on a MISS. */
  build: () => Promise<M>;
}): Promise<{ manifest: M; fromCache: boolean }> {
  const { name, engine, c, build } = opts;

  if (!shouldRecapture()) {
    const manifest = readManifest<M>(name, engine);
    if (manifest) {
      await c.testClient.loadState({ state: readState(name, engine) });
      await c.testClient.setNextBlockTimestamp({ timestamp: CACHED_BLOCK_TIMESTAMP });
      return { manifest, fromCache: true };
    }
  }

  // MISS (or forced recapture): run the full reconstruction, then snapshot it.
  const manifest = await build();
  const state = (await c.testClient.dumpState()) as Hex;
  writeBlob(name, engine, state, manifest);
  // Pin the timestamp on the freshly-built path too, so the no-cache and cache
  // runs cook against an identical block context.
  await c.testClient.setNextBlockTimestamp({ timestamp: CACHED_BLOCK_TIMESTAMP });
  return { manifest, fromCache: false };
}
