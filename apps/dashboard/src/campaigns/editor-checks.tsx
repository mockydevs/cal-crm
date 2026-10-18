// What stands in the way of sending a draft campaign, as the server works it out for the
// saved draft: blocking items first, each with its sentence and the way to where it is put
// right (a section of this page, or a page of Settings), then warnings, then notes.
import { Trans, useLingui } from '@lingui/react/macro';
import type { EmailCampaignCheck, EmailCampaignChecks } from '@repo/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactElement } from 'react';
import { saidBy } from './data';
import { hintClassName, linkClassName } from './parts';
import { checkPlace, checkSentence, sortedChecks, type CheckPlace } from './rules';

/** The sections of the editor a check can point at. */
export type EditorSection = Extract<CheckPlace, 'details' | 'content' | 'audience'>;

export function ChecksList({
  checks,
  saved,
  slug,
  onGo,
}: {
  readonly checks: UseQueryResult<EmailCampaignChecks>;
  /** Whether what is on screen is what the server checked. */
  readonly saved: boolean;
  readonly slug: string;
  /** Takes the person to a section of the editor. */
  readonly onGo: (section: EditorSection) => void;
}): ReactElement {
  const { t } = useLingui();
  if (checks.isError)
    return (
      <p role="alert" className="text-sm">
        {saidBy(checks.error, t`The checks couldn't be read. Check your connection.`)}{' '}
        <button
          type="button"
          className={linkClassName}
          onClick={() => {
            void checks.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </button>
      </p>
    );
  if (checks.data === undefined)
    return (
      <p role="status" className={hintClassName}>
        {saved ? (
          <Trans>Checking the campaign…</Trans>
        ) : (
          <Trans>Checked once your changes are saved.</Trans>
        )}
      </p>
    );
  const items = sortedChecks(checks.data.items);
  const sectionWords: Readonly<Record<EditorSection, string>> = {
    details: t`Go to Details`,
    content: t`Go to Email`,
    audience: t`Go to Audience`,
  };
  const way = (check: EmailCampaignCheck): ReactElement | null => {
    const place = checkPlace(check);
    if (place === undefined) return null;
    if (place === 'email-settings')
      return (
        <Link to="/b/$slug/settings/email" params={{ slug }} className={linkClassName}>
          <Trans>Open Email Services</Trans>
        </Link>
      );
    if (place === 'business-profile')
      return (
        <Link to="/b/$slug/settings/business" params={{ slug }} className={linkClassName}>
          <Trans>Open Business Profile</Trans>
        </Link>
      );
    return (
      <button
        type="button"
        className={linkClassName}
        onClick={() => {
          onGo(place);
        }}
      >
        {sectionWords[place]}
      </button>
    );
  };
  if (items.length === 0)
    return (
      <p className="flex items-center gap-2 text-md">
        <CircleCheck aria-hidden className="size-5 shrink-0 text-success" strokeWidth={1.8} />
        <Trans>Nothing stands in the way of sending.</Trans>
      </p>
    );
  return (
    <ul aria-label={t`Checks before sending`} className="flex min-w-0 flex-col gap-2">
      {items.map((check, index) => (
        <li
          // Two checks may share a code: one per failing setup check.
          key={`${check.code}:${check.check ?? ''}:${String(index)}`}
          className="flex min-w-0 items-start gap-2.5 rounded-lg border border-border px-3 py-2"
        >
          {check.severity === 'blocking' ? (
            <CircleAlert
              aria-hidden
              className="mt-0.5 size-5 shrink-0 text-destructive"
              strokeWidth={1.8}
            />
          ) : check.severity === 'warning' ? (
            <TriangleAlert
              aria-hidden
              className="mt-0.5 size-5 shrink-0 text-attention-foreground"
              strokeWidth={1.8}
            />
          ) : (
            <Info
              aria-hidden
              className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              strokeWidth={1.8}
            />
          )}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">
              {check.severity === 'blocking' ? (
                <Trans>Must be fixed before sending</Trans>
              ) : check.severity === 'warning' ? (
                <Trans>Worth knowing</Trans>
              ) : (
                <Trans>Note</Trans>
              )}
            </span>
            <span className="text-md text-body">{checkSentence(check)}</span>
            {way(check)}
          </span>
        </li>
      ))}
    </ul>
  );
}
