import { AccountRole } from '@solana/kit';
import type { Address } from '@solana/kit';
import type { AccountPlan } from '@eco-incorp/sauce-compiler';

/** Maps each symbolic account ref from the compiler's AccountPlan to a concrete address. */
export interface AccountResolution {
  [ref: string]: Address | { address: Address; signer?: boolean };
}

/**
 * Reserved ref: resolves to the fee payer with signer:true (use it when
 * bytecode reads MSG_SENDER). A resolution entry under this key is a conflict
 * and throws — rename the plan ref if it must resolve to another address.
 */
export const PAYER_REF = 'payer';

export interface ResolvedAccountMeta {
  address: Address;
  role: AccountRole;
}

/**
 * Resolves an AccountPlan into ordered account metas: metas[i] is user-account
 * index i of the execute instruction (i.e. instruction account index i + 3).
 * writable comes from the plan; signer is upgraded by the plan flag, the
 * resolution entry's signer flag, or the reserved PAYER_REF. Duplicate
 * addresses across refs are fine — Solana dedupes at message compile.
 */
export function resolveAccounts(plan: AccountPlan, resolution: AccountResolution, payer: Address): ResolvedAccountMeta[] {
  if (plan.usesRawIndices) {
    throw new Error('account plan uses raw indices: the caller owns the account ordering, build metas manually');
  }

  const unresolved: string[] = [];
  const metas: ResolvedAccountMeta[] = [];

  for (const meta of plan.metas) {
    let address: Address | undefined;
    let signer = meta.signer;

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
          signer = signer || (entry.signer ?? false);
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

    metas.push({ address, role });
  }

  if (unresolved.length > 0) {
    throw new Error(`unresolved account refs: ${unresolved.join(', ')} (provide addresses in the resolution map)`);
  }

  return metas;
}
