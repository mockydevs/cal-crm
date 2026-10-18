// The contact list's "Email verification" column: what email verification found of the
// primary email address, worded and coloured as an email row's badge is, or a dash for a
// contact without an email address. Fetched with its words when the column first shows.
import { useLingui } from '@lingui/react/macro';
import type { ContactEmailVerification } from '@repo/contracts';
import type { ReactElement } from 'react';
import { useVerificationWords } from './list-words';

// The badge's two tones (packages/ui badge.tsx, attention and neutral), as an email row's
// badge uses them: what needs a look is marked, the rest is quiet. Written out rather than
// taken from the badge, whose module brings base-ui's render helpers into a chunk of its
// own and so grows every route that shares them.
const attentionClassName = 'bg-attention text-attention-foreground';
const neutralClassName = 'bg-secondary text-secondary-foreground';
const toneOf = (state: ContactEmailVerification): string =>
  state === 'invalid' || state === 'risky' ? attentionClassName : neutralClassName;

export default function EmailVerificationCell({
  state,
}: {
  /** Null for a contact without an email address. */
  readonly state: ContactEmailVerification | null;
}): ReactElement {
  const { t } = useLingui();
  const words = useVerificationWords();
  if (state === null)
    return (
      <span className="text-muted-foreground">
        <span aria-hidden>—</span>
        <span className="sr-only">{t`No email address`}</span>
      </span>
    );
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${toneOf(state)}`}
    >
      {words[state]}
    </span>
  );
}
