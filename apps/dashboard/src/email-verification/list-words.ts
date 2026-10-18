// What email verification found of an address, in one word each, as an email row's badge
// words it: for the contact list's column and its Filters panel.
import { useLingui } from '@lingui/react/macro';
import type { ContactEmailVerification } from '@repo/contracts';

export function useVerificationWords(): Readonly<Record<ContactEmailVerification, string>> {
  const { t } = useLingui();
  return {
    valid: t`Verified`,
    risky: t`Risky`,
    invalid: t`Invalid`,
    unknown: t`Unknown`,
    unchecked: t`Not verified`,
    excluded: t`Excluded`,
  };
}
