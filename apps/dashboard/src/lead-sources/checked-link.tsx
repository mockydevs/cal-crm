// The answer to a checked link in Settings → Lead Sources, with every step of the decision:
// the business's rules that match, the built-in rule, then what results.
import { Trans } from '@lingui/react/macro';
import type { LeadSourcePreview } from '@repo/contracts';
import { useId, type ReactElement } from 'react';
import { linkCheckView } from '../forms-link-check-rules';
import { LinkCheckResult } from '../link-check-result';
import { cardClassName } from './frame';

export function CheckedLink({
  preview,
}: {
  readonly preview: LeadSourcePreview | undefined;
}): ReactElement {
  const id = useId();
  const view = preview === undefined ? undefined : linkCheckView(preview);
  // Before a link is checked there is no card: only the region that will say the answer.
  return view === undefined ? (
    <LinkCheckResult view={undefined} steps />
  ) : (
    <section className={cardClassName} aria-labelledby={id}>
      <h2 id={id} className="text-base font-medium">
        <Trans>What a lead arriving by this link would be</Trans>
      </h2>
      <LinkCheckResult view={view} steps />
    </section>
  );
}
