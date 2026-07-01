/**
 * CHAIN_POOL_CONFIGS shape smoke test (no fork, no RPC).
 *
 * Asserts every per-chain config is well-formed: each factory address is a
 * checksummed 20-byte 0x string, poolType/factoryType are valid enum members,
 * any stateView is a checksummed 20-byte 0x string, baseTokens is non-empty and
 * all checksummed, and feeTiers is a non-empty list of positive ints. Guards the
 * newly-added chains (bsc, sonic, celo, ink, plasma, hyperevm) against silent
 * address/enum drift.
 *
 * Run: npx tsx --test src/recipes/test/chain-pool-configs.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Hex } from "viem";

import {
  CHAIN_POOL_CONFIGS,
  SwapPoolType,
  FactoryType,
} from "../shared/constants.js";

const POOL_TYPE_VALUES = new Set(Object.values(SwapPoolType).filter((v) => typeof v === "number"));
const FACTORY_TYPE_VALUES = new Set(Object.values(FactoryType));

// Chains added/owned by this test — enforce strict EIP-55 checksums here. The older
// pre-existing chains carry some non-checksummed (but valid) addresses, so for those we
// only assert the 20-byte 0x format.
const STRICT_CHECKSUM_CHAINS = new Set([
  "bsc", "sonic", "celo", "ink", "plasma", "hyperevm", "unichain", "ronin",
]);

function assertAddrFormat(addr: Hex, where: string): void {
  assert.match(addr, /^0x[0-9a-fA-F]{40}$/, `${where}: not a 20-byte 0x address (${addr})`);
}

function assertChecksummed(addr: Hex, where: string): void {
  assertAddrFormat(addr, where);
  assert.equal(addr, getAddress(addr), `${where}: not checksummed (${addr})`);
}

describe("CHAIN_POOL_CONFIGS shape", () => {
  for (const [chainKey, config] of Object.entries(CHAIN_POOL_CONFIGS)) {
    const strict = STRICT_CHECKSUM_CHAINS.has(chainKey);
    const assertAddr = strict ? assertChecksummed : assertAddrFormat;
    describe(chainKey, () => {
      it("has non-empty baseTokens, all well-formed", () => {
        assert.ok(config.baseTokens.length > 0, "baseTokens must be non-empty");
        config.baseTokens.forEach((t, i) => assertAddr(t, `${chainKey}.baseTokens[${i}]`));
      });

      it("has a non-empty positive-int feeTiers list", () => {
        assert.ok(config.feeTiers.length > 0, "feeTiers must be non-empty");
        for (const f of config.feeTiers) {
          assert.ok(Number.isInteger(f) && f > 0, `feeTier must be a positive int (${f})`);
        }
      });

      it("has at least one factory", () => {
        assert.ok(config.factories.length > 0, "factories must be non-empty");
      });

      config.factories.forEach((f, i) => {
        it(`factory[${i}] (${f.label}) is well-formed`, () => {
          assertAddr(f.address, `${chainKey}.factories[${i}].address`);
          assert.ok(POOL_TYPE_VALUES.has(f.poolType), `invalid poolType ${f.poolType}`);
          assert.ok(FACTORY_TYPE_VALUES.has(f.factoryType), `invalid factoryType ${f.factoryType}`);
          if (f.stateView !== undefined) {
            assertAddr(f.stateView, `${chainKey}.factories[${i}].stateView`);
          }
          if (f.feeTiers !== undefined) {
            assert.ok(f.feeTiers.length > 0, "per-factory feeTiers, when set, must be non-empty");
            for (const t of f.feeTiers) {
              assert.ok(Number.isInteger(t) && t > 0, `per-factory feeTier must be a positive int (${t})`);
            }
          }
          if (f.v2FeePpm !== undefined) {
            assert.ok(Number.isInteger(f.v2FeePpm) && f.v2FeePpm > 0, "v2FeePpm must be a positive int");
          }
          if (f.slipstreamTickSpacings !== undefined) {
            assert.equal(
              f.factoryType, FactoryType.SlipstreamCL,
              "slipstreamTickSpacings is only valid on a SlipstreamCL factory",
            );
            assert.ok(f.slipstreamTickSpacings.length > 0, "slipstreamTickSpacings, when set, must be non-empty");
            for (const s of f.slipstreamTickSpacings) {
              assert.ok(Number.isInteger(s) && s > 0, `slipstreamTickSpacing must be a positive int (${s})`);
            }
          }
        });
      });
    });
  }

  it("SlipstreamCL is a recognized FactoryType enum member", () => {
    assert.ok(FACTORY_TYPE_VALUES.has(FactoryType.SlipstreamCL), "SlipstreamCL must be a FactoryType value");
  });

  it("re-tags the verified Slipstream CL factories to FactoryType.SlipstreamCL", () => {
    // The flagship Aerodrome CL (Base) + the verified Velodrome/Shadow Slipstream CL factories are
    // discovered by tickSpacing key. Each was on-chain-verified to respond to getPool(a,b,int24).
    const slip = (chain: string) =>
      CHAIN_POOL_CONFIGS[chain].factories.filter((f) => f.factoryType === FactoryType.SlipstreamCL);
    assert.ok(
      slip("base").some((f) => f.label === "Aerodrome CL"),
      "Base Aerodrome CL must be tagged SlipstreamCL",
    );
    assert.ok(slip("optimism").length > 0, "Optimism Velodrome CL must be tagged SlipstreamCL");
    assert.ok(slip("sonic").length > 0, "Sonic Shadow CL must be tagged SlipstreamCL");
    assert.ok(slip("celo").length > 0, "Celo Velodrome CL must be tagged SlipstreamCL");
    assert.ok(slip("ink").length > 0, "Ink Velodrome Slipstream CL must be tagged SlipstreamCL");
  });

  it("includes the newly-added chains", () => {
    assert.ok(CHAIN_POOL_CONFIGS.bsc, "bsc config present");
    assert.ok(CHAIN_POOL_CONFIGS.sonic, "sonic config present");
    assert.ok(CHAIN_POOL_CONFIGS.celo, "celo config present");
    assert.ok(CHAIN_POOL_CONFIGS.ink, "ink config present");
    assert.ok(CHAIN_POOL_CONFIGS.plasma, "plasma config present");
    assert.ok(CHAIN_POOL_CONFIGS.hyperevm, "hyperevm config present");
    assert.ok(CHAIN_POOL_CONFIGS.unichain, "unichain config present");
    assert.ok(CHAIN_POOL_CONFIGS.ronin, "ronin config present");
  });
});
