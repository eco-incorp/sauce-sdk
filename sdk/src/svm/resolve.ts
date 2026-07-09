import { AccountRole, isSignerRole } from '@solana/kit';
import type { Address, TransactionSigner } from '@solana/kit';
import type { AccountPlan } from '@eco-incorp/sauce-compiler';

/**
 * Maps each symbolic account ref from the compiler's AccountPlan to a concrete
 * address. `signer: true` upgrades the role only; pass the TransactionSigner
 * itself to also sign the transaction with it (required for any signer ref
 * other than the reserved fee-payer ref — the send layer has no other way to
 * obtain that signature).
 */
export interface AccountResolution {
  [ref: string]: Address | { address: Address; signer?: boolean | TransactionSigner };
}

/**
 * Reserved ref: resolves to the fee payer with signer:true (use it when
 * bytecode reads MSG_SENDER). A resolution entry under this key is a conflict
 * and throws — rename the plan ref if it must resolve to another address.
 */
export const PAYER_REF = 'payer';

export interface ResolveAccountsOptions {
  /**
   * Append the fee payer as a readonly signer at the END of the tail (plan
   * indices stay stable) when no resolved meta already signs. The engine's
   * NoSigner is LAZY — raised only when the program executes
   * MSG_SENDER/TX_ORIGIN — so a signerless list is valid for programs that
   * never read the sender (and lets simulations run sigVerify: false with no
   * signer at all). Set this for MSG_SENDER-reading programs whose plan
   * carries no signer meta; prefer the reserved 'payer' ref when the payer
   * should occupy a plan slot instead.
   */
  appendPayerSigner?: boolean;
}

export interface ResolvedAccountMeta {
  address: Address;
  role: AccountRole;
  /**
   * Present only when the resolution attached a TransactionSigner — kit's
   * signTransactionMessageWithSigners collects it from the instruction meta
   * (detection is `'signer' in meta`, so the key is omitted, not undefined).
   */
  signer?: TransactionSigner;
}

/**
 * Resolves an AccountPlan into ordered account metas: metas[i] is user-account
 * index i of the execute instruction (inline: instruction account i; staged:
 * i + 1, after the buffer). writable comes from the plan; signer is upgraded
 * by the plan flag, the resolution entry's signer flag or TransactionSigner,
 * or the reserved PAYER_REF. An attached TransactionSigner rides on the meta
 * so the transaction builder signs with it. Duplicate addresses across refs
 * are fine — Solana dedupes at message compile.
 *
 * MSG_SENDER/TX_ORIGIN is the first in-list signer, resolved LAZILY by the
 * engine (NoSigner only when the program actually reads the sender) — so no
 * signer is auto-appended; a MSG_SENDER-reading program whose plan carries no
 * signer meta passes `appendPayerSigner: true`.
 */
export function resolveAccounts(
  plan: AccountPlan,
  resolution: AccountResolution,
  payer: Address,
  { appendPayerSigner = false }: ResolveAccountsOptions = {},
): ResolvedAccountMeta[] {
  if (plan.usesRawIndices) {
    throw new Error('account plan uses raw indices: the caller owns the account ordering, build metas manually');
  }

  const unresolved: string[] = [];
  const metas: ResolvedAccountMeta[] = [];

  for (const meta of plan.metas) {
    let address: Address | undefined;
    let signer = meta.signer;
    let transactionSigner: TransactionSigner | undefined;

    if (meta.ref === PAYER_REF) {
      if (resolution[PAYER_REF] !== undefined) {
        throw new Error(`account ref 'payer' is reserved for the fee payer (rename the ref or remove it from the resolution map)`);
      }

      address = payer;
      signer = true;
    } else {
      const entry = resolution[meta.ref];

      if (entry !== undefined) {
        if (typeof entry === 'string') {
          address = entry;
        } else {
          address = entry.address;

          if (typeof entry.signer === 'object') {
            if (entry.signer.address !== entry.address) {
              throw new Error(
                `account ref '${meta.ref}' address ${entry.address} does not match its TransactionSigner address ${entry.signer.address}`,
              );
            }

            transactionSigner = entry.signer;
            signer = true;
          } else {
            signer = signer || (entry.signer ?? false);
          }
        }
      } else if (meta.pubkey !== undefined) {
        address = meta.pubkey as Address;
      }
    }

    if (address === undefined) {
      unresolved.push(meta.ref);
      continue;
    }

    const role = meta.writable
      ? (signer ? AccountRole.WRITABLE_SIGNER : AccountRole.WRITABLE)
      : (signer ? AccountRole.READONLY_SIGNER : AccountRole.READONLY);

    metas.push(transactionSigner ? { address, role, signer: transactionSigner } : { address, role });
  }

  if (unresolved.length > 0) {
    throw new Error(`unresolved account refs: ${unresolved.join(', ')} (provide addresses in the resolution map)`);
  }

  if (appendPayerSigner && !metas.some(meta => isSignerRole(meta.role))) {
    metas.push({ address: payer, role: AccountRole.READONLY_SIGNER });
  }

  return metas;
}
