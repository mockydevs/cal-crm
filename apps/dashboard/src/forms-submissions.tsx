// A form's submissions, newest first: each with its answers under the labels they were
// asked under, the contact it reached, what became of its consent boxes, and where it came
// from. One that reached no contact can be discarded; one that did belongs to the contact,
// and goes when the contact does. The list can be narrowed to one lead source: the server
// filters by the built-in rule's key, from the contract's own list.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  discardFormSubmission,
  leadSources,
  listFormSubmissions,
  type Form,
  type FormSubmission,
  type LeadSourceKey,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type ReactElement } from 'react';
import { useBusiness } from './workspace';

export const submissionsKey = (businessId: string, formId: string): readonly string[] => [
  'b',
  businessId,
  'form-submissions',
  formId,
];

export function FormSubmissions({
  form,
  client,
  onChanged,
}: {
  readonly form: Pick<Form, 'id' | 'name'>;
  readonly client: Client;
  /** Told when a submission was discarded, so counts elsewhere can be read again. */
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  // Every lead source, or the one chosen: the key of a built-in rule.
  const [source, setSource] = useState<LeadSourceKey | ''>('');
  const submissions = useInfiniteQuery({
    // Under the form's own key, so discarding one reads every filtered list again too.
    queryKey: [...submissionsKey(business.id, form.id), source],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      client.request(listFormSubmissions, {
        params: { id: form.id },
        query: {
          limit: 25,
          ...(source === '' ? {} : { leadSourceRule: source }),
          ...(pageParam === '' ? {} : { after: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = submissions.data?.pages.flatMap((page) => page.items) ?? [];
  const canManage = submissions.data?.pages[0]?.canManage === true;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id={headingId} className="text-lg font-semibold">
          <Trans>Submissions</Trans>
        </h2>
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            <Trans>Lead source</Trans>
          </span>
          <select
            className="min-h-11 min-w-0 rounded-control border border-input bg-card px-2.5 text-md text-foreground lg:min-h-9"
            value={source}
            onChange={(event) => {
              setSource(event.target.value as LeadSourceKey | '');
            }}
          >
            <option value="">{t`Every lead source`}</option>
            {/* The names are the server's own: what each submission's badge says. */}
            {leadSources.map((each) => (
              <option key={each.key} value={each.key}>
                {each.label}
              </option>
            ))}
            <option value="source_param">{t`Named by the link (source=…)`}</option>
          </select>
        </label>
      </div>
      {submissions.isPending ? (
        <p role="status">
          <Trans>Loading submissions…</Trans>
        </p>
      ) : null}
      {submissions.isError ? (
        <p role="alert">
          <Trans>We couldn't load the submissions.</Trans>{' '}
          <Button
            variant="quiet"
            onClick={() => {
              void submissions.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : null}
      {submissions.data !== undefined && items.length === 0 ? (
        <p className="text-muted-foreground">
          {source === '' ? (
            <Trans>Nobody has sent this form yet.</Trans>
          ) : (
            <Trans>No submission of this form arrived this way.</Trans>
          )}
        </p>
      ) : null}
      {items.length === 0 ? null : (
        <ol aria-label={t`Submissions, newest first`} className="flex list-none flex-col gap-3 p-0">
          {items.map((submission) => (
            <li key={submission.id}>
              <SubmissionCard
                formId={form.id}
                submission={submission}
                client={client}
                canManage={canManage}
                onChanged={onChanged}
              />
            </li>
          ))}
        </ol>
      )}
      {submissions.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={submissions.isFetchingNextPage}
          onClick={() => {
            void submissions.fetchNextPage();
          }}
        >
          <Trans>Show earlier submissions</Trans>
        </Button>
      ) : null}
    </section>
  );
}

function SubmissionCard({
  formId,
  submission,
  client,
  canManage,
  onChanged,
}: {
  readonly formId: string;
  readonly submission: FormSubmission;
  readonly client: Client;
  readonly canManage: boolean;
  readonly onChanged: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const headingId = useId();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();
  const when = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(submission.submittedAt));
  const discard = useMutation({
    mutationFn: () =>
      client.request(discardFormSubmission, {
        params: { id: formId, submissionId: submission.id },
      }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: submissionsKey(business.id, formId) });
      onChanged();
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? error.message
          : t`The submission wasn't discarded. Check your connection and try again.`,
      );
    },
  });
  const outcomes = {
    granted: t`Consent recorded`,
    not_ticked: t`Not ticked`,
    withdrawn_kept: t`Ticked, but this contact had withdrawn consent, so nothing changed`,
    no_address: t`Ticked, but there was no address or contact to record it for`,
  } satisfies Record<FormSubmission['consents'][number]['outcome'], string>;
  const campaign = Object.entries(submission.utm);
  return (
    <article
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-[18px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h3 id={headingId} className="font-semibold">
            <time dateTime={submission.submittedAt}>{when}</time>
          </h3>
          {/* How this person arrived, as the lead source rules named it. One stored before lead sources were kept has none, and shows none. */}
          {submission.leadSource === null ? null : (
            <p className="flex min-w-0 items-baseline gap-1.5 text-sm">
              <span className="text-muted-foreground">
                <Trans>Lead source</Trans>
              </span>
              <span className="min-w-0 rounded-full bg-secondary px-2.5 py-0.5 font-medium wrap-anywhere">
                {submission.leadSource}
              </span>
            </p>
          )}
        </div>
        {submission.contactId === null ? (
          <span className="rounded-full bg-attention px-3 py-1.5 text-sm font-medium text-attention-foreground">
            <Trans>Not attached to a contact</Trans>
          </span>
        ) : (
          <Link
            to="/b/$slug/contacts/$contactId"
            params={{ slug: business.slug, contactId: submission.contactId }}
            className="inline-flex min-h-11 items-center rounded-full border border-input bg-card px-4 text-md hover:bg-muted"
          >
            {submission.contactOutcome === 'created'
              ? t`Open the new contact`
              : t`Open the contact`}
          </Link>
        )}
      </div>
      {submission.contactOutcome === 'unresolved' ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            These details match more than one contact, or a contact in the trash, so no contact was
            changed. Read the answers and add them yourself, or discard the submission.
          </Trans>
        </p>
      ) : null}
      <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {submission.answers.map((answer) => (
          <div key={answer.key} className="contents">
            <dt className="min-w-0 font-medium break-words text-muted-foreground">
              {answer.label}
            </dt>
            {/* As text, with its line breaks: an answer is never read as markup. */}
            <dd className="m-0 min-w-0 whitespace-pre-wrap break-words">
              {answer.value === null
                ? t`No answer`
                : answer.value === true
                  ? t`Yes`
                  : answer.value === false
                    ? t`No`
                    : Array.isArray(answer.value)
                      ? // Several choices: one a line.
                        answer.value.join('\n')
                      : answer.value}
            </dd>
          </div>
        ))}
      </dl>
      {submission.skippedFields.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Some answers could not be written to the contact's fields, because a field was archived
            or no longer takes that answer. They are kept here.
          </Trans>
        </p>
      )}
      {submission.consents.length === 0 ? null : (
        <ul className="flex list-none flex-col gap-1 p-0 text-sm">
          {submission.consents.map((consent) => (
            <li key={consent.key} className="break-words">
              <span className="font-medium">{consent.wording}</span>{' '}
              <span className="text-muted-foreground">{outcomes[consent.outcome]}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs break-all text-muted-foreground">
        {[
          submission.pageUrl ?? submission.origin,
          ...campaign.map(([label, value]) => `${label}: ${value}`),
          submission.ipAddress,
        ]
          .filter((part) => part !== null)
          .join(' · ')}
      </p>
      {canManage && submission.contactId === null ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              <Trans>Discard this submission for good?</Trans>
            </span>
            <Button
              size="small"
              disabled={discard.isPending}
              onClick={() => {
                setProblem(undefined);
                discard.mutate();
              }}
            >
              {discard.isPending ? t`Discarding…` : t`Discard it`}
            </Button>
            <Button
              size="small"
              variant="quiet"
              disabled={discard.isPending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              <Trans>Keep it</Trans>
            </Button>
          </div>
        ) : (
          <Button
            size="small"
            variant="quiet"
            className="self-start"
            onClick={() => {
              setConfirming(true);
            }}
          >
            <Trans>Discard…</Trans>
          </Button>
        )
      ) : null}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </article>
  );
}
