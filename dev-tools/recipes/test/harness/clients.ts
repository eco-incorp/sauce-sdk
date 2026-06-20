/**
 * viem clients for the local anvil harness.
 *
 * Builds public/wallet/test clients against a defineChain whose
 * multicall3 contract is pinned to the canonical MULTICALL3 address (anvil
 * pre-deploys it there). discoverPools() relies on client.multicall, so the
 * multicall3 contract MUST be configured on the chain.
 */

import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
  type TestClient,
  type Hex,
} from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { MULTICALL3 } from "../../shared/constants";

/** Default anvil dev account #0. */
export const ANVIL_PK_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
export const ANVIL_MNEMONIC =
  "test test test test test test test test test test test junk";

export interface HarnessClients {
  chain: Chain;
  publicClient: PublicClient;
  walletClient: WalletClient;
  testClient: TestClient;
  /** Account #0 address (deployer / default caller). */
  account0: Hex;
}

/** Derive the address of anvil account at HD index `i`. */
export function anvilAccount(i: number) {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
}

export async function makeClients(
  rpcUrl: string,
  multicall3: Hex = MULTICALL3,
): Promise<HarnessClients> {
  // Read chain id from the node so the chain object is accurate.
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();

  const chain = defineChain({
    id: chainId,
    name: "Local Anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: multicall3 } },
  });

  const account = privateKeyToAccount(ANVIL_PK_0);

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 120_000 }),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl, { timeout: 120_000 }),
  });
  const testClient = createTestClient({
    mode: "anvil",
    chain,
    transport: http(rpcUrl, { timeout: 120_000 }),
  });

  return {
    chain,
    publicClient: publicClient as PublicClient,
    walletClient: walletClient as WalletClient,
    testClient: testClient as TestClient,
    account0: account.address,
  };
}
