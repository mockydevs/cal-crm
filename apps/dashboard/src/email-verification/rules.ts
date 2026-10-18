// What an email address's row says about it, read from its delivery (can it be sent to) and
// its verification (what a check found) together, and what a person may do to it from the
// row's menu. The words are in the parts that show them.
import type { ContactAddress, EmailVerification } from '@repo/contracts';

/** Why an address is blocked, as the contact's details say. */
export type BlockReason = NonNullable<NonNullable<ContactAddress['delivery']>['reason']>;

/** The one status a row shows, the first that applies in this order. */
export type AddressStatus =
  | { readonly kind: 'blocked'; readonly reason: BlockReason | null }
  | { readonly kind: 'excluded' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'risky' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'verified' }
  | { readonly kind: 'domain_checked' }
  | { readonly kind: 'not_verified' };

type Address = Pick<ContactAddress, 'delivery' | 'verification'>;

/**
 * Blocked (with its reason), then Excluded, then what the check found, then Not verified.
 * Undefined when the server says nothing about verification and nothing blocks the address:
 * a server without verification shows what it showed before.
 */
export function statusOf(address: Address): AddressStatus | undefined {
  if (address.delivery?.status === 'blocked')
    return { kind: 'blocked', reason: address.delivery.reason };
  const verification = address.verification;
  if (verification === undefined || verification === null) return undefined;
  if (verification.excluded) return { kind: 'excluded' };
  switch (verification.status) {
    case 'invalid':
      return { kind: 'invalid' };
    case 'risky':
      return { kind: 'risky' };
    case 'unknown':
      return { kind: 'unknown' };
    case 'valid':
      // Without a provider only the domain is checked: never "Verified" for that.
      return verification.depth === 'mailbox' ? { kind: 'verified' } : { kind: 'domain_checked' };
    case 'unchecked':
      return { kind: 'not_verified' };
  }
}

/** Codes that describe an address without saying anything is wrong with it. */
const HINTS: ReadonlySet<string> = new Set(['role', 'free_provider']);

/** A check's reasons, the problems apart from the hints, each once, in the server's order. */
export function reasonsOf(verification: EmailVerification | null | undefined): {
  readonly problems: readonly string[];
  readonly hints: readonly string[];
} {
  const reasons = [...new Set(verification?.reasons ?? [])];
  return {
    problems: reasons.filter((reason) => !HINTS.has(reason)),
    hints: reasons.filter((reason) => HINTS.has(reason)),
  };
}

/** Whether a check's result has passed its expiry, so it is checked again before a send. */
export function isExpired(verification: EmailVerification | null | undefined, now: Date): boolean {
  if (verification?.expiresAt === undefined || verification.expiresAt === null) return false;
  return Date.parse(verification.expiresAt) <= now.getTime();
}

/** What the row's menu offers. Null where the action is not offered at all. */
export interface AddressActions {
  readonly verify: 'verify' | 'reverify' | null;
  readonly exclusion: 'exclude' | 'include';
  /**
   * Block it; lift a block at once (one a person or a check made); lift a hard bounce,
   * after typing "unblock"; or explain that an opt-out is not lifted here.
   */
  readonly block: 'block' | 'unblock' | 'unblock_bounce' | 'opted_out' | null;
}

/**
 * The menu of a row someone may change. A hard bounce is unblocked only by someone who may
 * manage email verification; for anyone else it is left out of the menu.
 */
export function actionsOf(address: Address, mayManageVerification: boolean): AddressActions {
  const verification = address.verification;
  const excluded = verification?.excluded === true;
  const verify = excluded
    ? null
    : verification === undefined || verification === null || verification.status === 'unchecked'
      ? 'verify'
      : 'reverify';
  const reason = address.delivery?.status === 'blocked' ? address.delivery.reason : undefined;
  const block =
    reason === undefined
      ? 'block'
      : reason === 'complaint' || reason === 'unsubscribe'
        ? 'opted_out'
        : reason === 'hard_bounce'
          ? mayManageVerification
            ? 'unblock_bounce'
            : null
          : 'unblock';
  return { verify, exclusion: excluded ? 'include' : 'exclude', block };
}
