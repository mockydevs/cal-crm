// Who a draft campaign is for, and the live count of who would get it: everyone, a smart
// list, or contacts with some tags. Under the choice, the audience preview as the server
// counts it for the saved draft: how many will receive it, how many will not, and each
// reason with its count, a few of the contacts it holds back, and what to do about it.
// The same rules decide again as each email leaves; the preview is what they say now.
//
// A filter audience (conditions on contacts) can be set through the API. This screen
// shows one and keeps it; it has no builder for one yet.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  EMAIL_CAMPAIGN_LIMITS,
  type EmailCampaignAudience,
  type EmailCampaignAudiencePreview,
} from '@repo/contracts';
import type { Client } from '@repo/sdk';
// The kit's own list, not the lighter one of controls.tsx: the tag chips below open in the
// kit's popover, and a chunk that has the popover without the kit's list makes the bundler
// split what the two share, which costs every other page that has both about half a KB.
import { Select } from '@repo/ui/components/select';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import { SearchPicker } from '../search-picker';
import { TagPicker } from '../tag-picker';
import { iconButtonClassName } from './controls';
import { campaignKeys, isRefusal, retryFaults, saidBy } from './data';
import { hintClassName, labelClassName, linkClassName } from './parts';
import { audienceSentence, momentIn, skipReasonWords, type AudienceNames } from './rules';

type Kind = EmailCampaignAudience['kind'];

export function AudienceChoice({
  client,
  businessId,
  audience,
  names,
  onChange,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly audience: EmailCampaignAudience | null;
  readonly names: AudienceNames;
  readonly onChange: (audience: EmailCampaignAudience | null) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  // The kind ticked, which may be ahead of the audience: tags with none chosen yet.
  const [kind, setKind] = useState<Kind | undefined>(audience?.kind);
  const [match, setMatch] = useState<'any' | 'all'>(
    audience?.kind === 'tags' ? audience.match : 'any',
  );
  const views = useQuery({
    queryKey: campaignKeys.views(businessId),
    queryFn: async () =>
      client.request((await import('../saved-view-api')).listViews, {
        query: { object: 'contact' },
      }),
    retry: retryFaults,
    staleTime: 60_000,
  });
  const tagIds = audience?.kind === 'tags' ? audience.tagIds : [];
  const choose = (next: Kind): void => {
    setKind(next);
    if (next === 'all') onChange({ kind: 'all' });
    // A list or tags are chosen next: until then the campaign has no audience.
    else if (audience?.kind !== next) onChange(null);
  };
  const kinds: readonly (readonly [Kind, string, string])[] = [
    ['all', t`Everyone`, t`Every contact of the business.`],
    ['smart_list', t`A smart list`, t`The contacts a saved smart list shows when sending starts.`],
    ['tags', t`Tags`, t`Contacts with the tags you choose.`],
    // Offered only to a campaign that already has one.
    ...(audience?.kind === 'filter'
      ? ([['filter', t`A filter`, audienceSentence(audience, names)]] as const)
      : []),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <fieldset className="grid min-w-0 gap-2 sm:grid-cols-3">
        <legend className={`${labelClassName} mb-1.5`}>
          <Trans>Send to</Trans>
        </legend>
        {kinds.map(([value, label, hint]) => (
          <div
            key={value}
            className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-3 has-checked:border-primary has-checked:bg-accent"
          >
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-md font-medium lg:min-h-0">
              <input
                type="radio"
                name={`${id}-kind`}
                className="size-4 shrink-0 accent-primary"
                aria-describedby={`${id}-${value}-hint`}
                checked={kind === value}
                onChange={() => {
                  choose(value);
                }}
              />
              {label}
            </label>
            <p id={`${id}-${value}-hint`} className="pl-6.5 text-sm text-body">
              {hint}
            </p>
          </div>
        ))}
      </fieldset>
      {kind === 'smart_list' ? (
        <div className="flex w-80 max-w-full min-w-0 flex-col gap-1">
          <span className={labelClassName}>
            <Trans>Smart list</Trans>
          </span>
          <SearchPicker
            label={t`Smart list`}
            placeholder={t`Choose a smart list`}
            searchLabel={t`Search smart lists`}
            items={(views.data?.items ?? []).map((view) => ({ id: view.id, name: view.name }))}
            selected={audience?.kind === 'smart_list' ? [audience.viewId] : []}
            unlisted={() => t`A smart list that is gone`}
            loading={views.isPending}
            onRetry={
              views.isError
                ? () => {
                    void views.refetch();
                  }
                : undefined
            }
            empty={t`No smart lists match.`}
            none={t`There are no smart lists yet. Save one from the Contacts page.`}
            onChange={([viewId]) => {
              if (viewId !== undefined) onChange({ kind: 'smart_list', viewId });
            }}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>
              A smart list is a saved view of Contacts. Who is on it is read when sending starts.
            </Trans>
          </p>
        </div>
      ) : null}
      {kind === 'tags' ? (
        <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-64">
            <TagPicker
              label={t`Tags`}
              chosen={tagIds}
              limit={EMAIL_CAMPAIGN_LIMITS.tags}
              client={client}
              cacheKey={campaignKeys.tags(businessId)}
              onChange={(next) => {
                onChange(next.length === 0 ? null : { kind: 'tags', tagIds: next, match });
              }}
            />
          </div>
          {tagIds.length > 1 ? (
            <div className="flex w-56 max-w-full flex-col gap-1">
              <label htmlFor={`${id}-match`} className={labelClassName}>
                <Trans>A contact must have</Trans>
              </label>
              <Select
                id={`${id}-match`}
                value={match}
                onValueChange={(next) => {
                  const chosen = next === 'all' ? 'all' : 'any';
                  setMatch(chosen);
                  onChange({ kind: 'tags', tagIds: [...tagIds], match: chosen });
                }}
              >
                <option value="any">{t`Any of these tags`}</option>
                <option value="all">{t`All of these tags`}</option>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}
      {kind === 'filter' ? (
        <p className={hintClassName}>
          <Trans>
            This audience is a filter that was set through the API. It is kept as it is: this screen
            can't change its conditions yet. Choosing another audience replaces it.
          </Trans>
        </p>
      ) : null}
    </div>
  );
}

export function AudiencePreview({
  preview,
  chosen,
  saved,
  timeZone,
  slug,
}: {
  readonly preview: UseQueryResult<EmailCampaignAudiencePreview>;
  /** Whether the draft on screen has an audience. */
  readonly chosen: boolean;
  /** Whether what is on screen is what the server holds: the count is of the saved draft. */
  readonly saved: boolean;
  readonly timeZone: string;
  readonly slug: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  const headingId = useId();
  const number = (value: number): string => value.toLocaleString(i18n.locale);
  const heading = (
    <h3 id={headingId} className="text-md font-medium">
      <Trans>Who will get it</Trans>
    </h3>
  );
  if (!chosen)
    return (
      <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1">
        {heading}
        <p className={hintClassName}>
          <Trans>Choose an audience to see who will get the email and who will not, and why.</Trans>
        </p>
      </section>
    );
  const { data } = preview;
  const gone = isRefusal(preview.error, 404) || isRefusal(preview.error, 422);
  const counted = data === undefined ? '' : momentIn(data.countedAt, timeZone);
  const received = number(data?.willReceive ?? 0);
  const held = number(data?.willNot ?? 0);
  const most = number(EMAIL_CAMPAIGN_LIMITS.audience);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        {heading}
        {data === undefined ? null : (
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="min-w-0">{t`Counted ${counted}`}</span>
            <button
              type="button"
              className={iconButtonClassName}
              aria-label={t`Count again`}
              title={t`Count again`}
              disabled={preview.isFetching}
              onClick={() => {
                void preview.refetch();
              }}
            >
              <RefreshCw aria-hidden className="size-4" strokeWidth={1.8} />
            </button>
          </span>
        )}
      </div>
      {!saved && data === undefined ? (
        <p role="status" className={hintClassName}>
          <Trans>Counted once your changes are saved.</Trans>
        </p>
      ) : preview.isError ? (
        <p role="alert" className="text-sm">
          {gone
            ? t`This audience names a smart list or a tag that is gone, or that you cannot open. Choose it again.`
            : saidBy(
                preview.error,
                t`The audience couldn't be counted. Check your connection.`,
              )}{' '}
          {gone ? null : (
            <button
              type="button"
              className={linkClassName}
              onClick={() => {
                void preview.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </button>
          )}
        </p>
      ) : data === undefined ? (
        <p role="status" className={hintClassName}>
          <Trans>Counting the audience…</Trans>
        </p>
      ) : (
        <>
          <p role="status" className="text-lg font-medium">
            <span className="text-success">{t`${received} will receive it`}</span>
            <span aria-hidden className="px-2 text-muted-foreground">
              ·
            </span>
            <span className="text-body">{t`${held} will not`}</span>
          </p>
          {!saved ? (
            <p className={hintClassName}>
              <Trans>
                This is the count before your last change. It is counted again once saved.
              </Trans>
            </p>
          ) : null}
          {data.tooMany ? (
            <p role="alert" className="rounded-lg border border-destructive px-3 py-2 text-sm">
              {t`More than ${most} contacts match, which is the most one campaign reaches. The counts stop there. Narrow the audience, or split it in two.`}
            </p>
          ) : null}
          {data.receiving.length === 0 ? null : (
            <p className="text-sm text-body">
              <Trans>Among those who will receive it:</Trans>{' '}
              <Sample contacts={data.receiving} slug={slug} />
            </p>
          )}
          {data.reasons.length === 0 ? (
            data.total === 0 ? (
              <p className={hintClassName}>
                <Trans>Nobody matches this audience.</Trans>
              </p>
            ) : (
              <p className={hintClassName}>
                <Trans>Everyone in the audience can be sent it.</Trans>
              </p>
            )
          ) : (
            <ul
              aria-label={t`Why some will not receive it`}
              className="flex min-w-0 flex-col divide-y divide-border rounded-lg border border-border"
            >
              {data.reasons.map((row) => {
                const words = skipReasonWords[row.reason];
                const more = row.count - row.sample.length;
                return (
                  <li key={row.reason} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
                    <span className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className="text-md font-medium">{i18n._(words.label)}</span>
                      <span className="shrink-0 text-md tabular-nums">{number(row.count)}</span>
                    </span>
                    <span className="text-sm text-body">{i18n._(words.todo)}</span>
                    {row.sample.length === 0 ? null : (
                      <span className="text-sm text-body">
                        <Sample contacts={row.sample} slug={slug} />
                        {more > 0 ? (
                          <span className="text-muted-foreground">
                            {' '}
                            {plural(more, { one: 'and # more', other: 'and # more' })}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            <Trans>
              Counted by the rules a send is decided by. Each email is decided again as it leaves,
              so someone who unsubscribes meanwhile gets nothing. Quiet hours and daily limits delay
              an email and refuse none.
            </Trans>
          </p>
        </>
      )}
    </section>
  );
}

function Sample({
  contacts,
  slug,
}: {
  readonly contacts: EmailCampaignAudiencePreview['receiving'];
  readonly slug: string;
}): ReactElement {
  const { t } = useLingui();
  return (
    <>
      {contacts.map((contact, index) => (
        <span key={contact.contactId}>
          {index === 0 ? null : ', '}
          <Link
            to="/b/$slug/contacts/$contactId"
            params={{ slug, contactId: contact.contactId }}
            className={linkClassName}
          >
            {contact.name ?? contact.email ?? t`A contact with no name`}
          </Link>
        </span>
      ))}
    </>
  );
}
