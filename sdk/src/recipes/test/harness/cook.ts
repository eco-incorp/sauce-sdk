/**
 * cook() helper: call SauceRouter.cook(bytes[]) from a wallet and parse the
 * resulting ERC-20 Transfer logs for assertions.
 */

import {
  decodeEventLog,
  parseAbi,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type TransactionReceipt,
  type Account,
} from "viem";

const cookAbi = parseAbi([
  "function cook(bytes[] ingredients) payable returns (bytes returnData)",
]);

const transferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface TransferEvent {
  address: Hex; // token contract that emitted
  from: Hex;
  to: Hex;
  value: bigint;
}

export interface CookResult {
  receipt: TransactionReceipt;
  transfers: TransferEvent[];
}

/** Send SauceRouter.cook(bytecodes) and decode Transfer logs. */
export async function cook(
  walletClient: WalletClient,
  publicClient: PublicClient,
  sauceRouter: Hex,
  bytecodes: Hex[],
  caller?: Account,
): Promise<CookResult> {
  const account = (caller ?? walletClient.account) as Account;
  const hash = await walletClient.writeContract({
    address: sauceRouter,
    abi: cookAbi as Abi,
    functionName: "cook",
    args: [bytecodes],
    account,
    chain: walletClient.chain,
    // Pin a generous gas limit: viem's eth_estimateGas can undershoot the recipe's
    // many-staticcall tick walks (the estimate's heuristic buffer is too small for
    // the up/dn frontier reads), sending the tx with too little gas → an OOG revert
    // even though the call itself is valid. The block gas limit is 2e9 (anvil.ts),
    // so a fixed 1.9e9 ceiling stays under the block cap while never undershooting.
    gas: 1_900_000_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  const transfers: TransferEvent[] = [];
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "Transfer") {
        const args = decoded.args as unknown as { from: Hex; to: Hex; value: bigint };
        transfers.push({ address: log.address as Hex, from: args.from, to: args.to, value: args.value });
      }
    } catch {
      // not a Transfer log — skip
    }
  }
  return { receipt, transfers };
}
