/**
 * Deploy + write helpers for the local harness.
 *
 * deployContract sends a creation tx, waits for the receipt, and returns the
 * deployed address (throws if the receipt has no contractAddress). writeAndWait
 * sends a state-changing call and waits for its receipt.
 */

import type {
  Abi,
  Account,
  Hex,
  PublicClient,
  WalletClient,
  TransactionReceipt,
} from "viem";

export async function deployContract(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: { abi: Abi; bytecode: Hex; args?: readonly unknown[] },
): Promise<Hex> {
  const account = walletClient.account as Account;
  const hash = await walletClient.deployContract({
    abi: params.abi,
    bytecode: params.bytecode,
    args: params.args as never,
    account,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`deploy tx ${hash} produced no contractAddress (status=${receipt.status})`);
  }
  return receipt.contractAddress;
}

/** Send a contract write from `walletClient` and wait for the receipt. */
export async function writeAndWait(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: {
    address: Hex;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    account?: Account;
    value?: bigint;
  },
): Promise<TransactionReceipt> {
  const account = (params.account ?? walletClient.account) as Account;
  const hash = await walletClient.writeContract({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args as never,
    account,
    chain: walletClient.chain,
    value: params.value,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}
