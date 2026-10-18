// The contact page's Attribution group: where the contact first came from
// and where it last came from, read-only, as GET /contacts/{id}/attribution answers. It
// folds like the other groups of "All fields" and is fetched apart from them: the contact
// page's own code is at its budget.
//
// Each touch leads with its lead source, the one name for how they arrived, then the
// session source and medium, then only what the visit said: its UTM labels, the campaign,
// ad group and ad ids, the referrer and the page. Whose click ids are held is said by
// platform; an id itself is never shown.
import { Trans, useLingui } from '@lingui/react/macro';
import { getContactAttribution, type ContactAttribution } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { isClickIdPlatform, platformNames } from '../click-id-platforms';
import { useBusiness } from '../workspace';
import {
  heldClickIds,
  isCarried,
  isOneTouch,
  touchRows,
  type TouchFactKey,
} from './contact-attribution-rules';
import { useReportWords } from './words';

function Touch({
  title,
  touch,
  all,
}: {
  readonly title: string;
  readonly touch: ContactAttribution;
  /** Every field is listed, said by the visit or not. */
  readonly all: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const words = useReportWords();
  const headingId = useId();
  const when = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(touch.touchedAt));
  const factNames: Readonly<Record<TouchFactKey, string>> = {
    utmSource: t`UTM source`,
    utmMedium: t`UTM medium`,
    utmCampaign: t`UTM campaign`,
    utmContent: t`UTM content`,
    utmTerm: t`UTM term`,
    matchType: t`Match type`,
    campaignId: t`Campaign ID`,
    adGroupId: t`Ad group ID`,
    adId: t`Ad ID`,
    referrerDomain: t`Referrer`,
    landingUrl: t`Landing page`,
    pageUrl: t`Page`,
  };
  const facts = touchRows(touch, all);
  const carried = isCarried(touch);
  const clickIds = heldClickIds(touch).map((key) =>
    isClickIdPlatform(key) ? i18n._(platformNames[key]) : key,
  );
  const rowClassName = 'flex min-w-0 flex-col gap-0.5';
  const labelClassName = 'text-sm text-muted-foreground';
  return (
    <div role="group" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h4 id={headingId} className="text-sm font-medium text-foreground">
        {title}
      </h4>
      <dl className="flex min-w-0 flex-col gap-2">
        {/* The one name for how they arrived, first and largest. */}
        <div className={rowClassName}>
          <dt className={labelClassName}>
            <Trans>Lead source</Trans>
          </dt>
          <dd className="min-w-0 text-base font-semibold break-words text-foreground">
            {touch.source ?? (
              <>
                <span aria-hidden>--</span>
                <span className="sr-only">
                  <Trans>Not set</Trans>
                </span>
              </>
            )}
          </dd>
        </div>
        <div className={rowClassName}>
          <dt className={labelClassName}>
            <Trans>Session source</Trans>
          </dt>
          <dd className="min-w-0 font-medium break-words text-foreground">
            {words.sessionSource(touch.sessionSource)}
          </dd>
        </div>
        <div className={rowClassName}>
          <dt className={labelClassName}>
            <Trans>Medium</Trans>
          </dt>
          <dd className="min-w-0 font-medium break-words text-foreground">
            {words.medium(touch.medium)}
          </dd>
        </div>
        {facts.map((fact) => (
          <div key={fact.key} className={rowClassName}>
            <dt className={labelClassName}>{factNames[fact.key]}</dt>
            <dd className="min-w-0 font-medium break-all text-foreground">
              {fact.value ?? (
                <>
                  <span aria-hidden>--</span>
                  <span className="sr-only">
                    <Trans>Not set</Trans>
                  </span>
                </>
              )}
            </dd>
          </div>
        ))}
        <div className={rowClassName}>
          <dt className={labelClassName}>
            <Trans>When</Trans>
          </dt>
          <dd className="min-w-0 font-medium break-words text-foreground">
            <time dateTime={touch.touchedAt}>{when}</time>
          </dd>
        </div>
        {clickIds.length === 0 ? null : (
          <div className={rowClassName}>
            <dt className={labelClassName}>
              <Trans>Click ids held</Trans>
            </dt>
            <dd className="min-w-0 font-medium break-words text-foreground">
              {clickIds.join(', ')}
            </dd>
          </div>
        )}
      </dl>
      {carried ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Arrival carried from an earlier page: they arrived on the landing page and became a lead
            on the page named after it.
          </Trans>
        </p>
      ) : null}
      {facts.length === 0 && clickIds.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Nothing more is known of this touch: no campaign labels, ids or referrer.</Trans>
        </p>
      ) : null}
    </div>
  );
}

export default function ContactAttributionGroup({
  contactId,
  query,
}: {
  readonly contactId: string;
  /** What "Search fields and folders" holds: the group shows when it is empty or names it. */
  readonly query: string;
}): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  const bodyId = useId();
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const attribution = useQuery({
    queryKey: ['b', business.id, 'contact', contactId, 'attribution'],
    queryFn: () => apiIn(business.id).request(getContactAttribution, { params: { id: contactId } }),
    staleTime: 60_000,
    retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
  });
  const wanted = query.trim().toLowerCase();
  const names = [
    t`Attribution`,
    t`First attribution`,
    t`Latest attribution`,
    t`Lead source`,
    t`Session source`,
    t`Medium`,
    t`UTM source`,
    t`UTM medium`,
    t`UTM campaign`,
    t`UTM content`,
    t`UTM term`,
    t`Match type`,
    t`Campaign ID`,
    t`Ad group ID`,
    t`Ad ID`,
    t`Referrer`,
    t`Landing page`,
    t`Page`,
    t`Click ids held`,
  ];
  if (wanted !== '' && !names.some((name) => name.toLowerCase().includes(wanted))) return null;
  // Someone who may not read it is shown nothing, as with any field they may not see.
  if (attribution.error instanceof ApiError && attribution.error.status === 403) return null;
  const Chevron = open ? ChevronUp : ChevronDown;
  const data = attribution.data;
  const first = data?.first ?? null;
  const latest = data?.latest ?? null;
  const once = isOneTouch(first, latest);
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="min-w-0 overflow-clip rounded-lg border border-border bg-card"
    >
      <h3>
        <button
          type="button"
          id={headingId}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          className="flex min-h-11 w-full items-center justify-between gap-2 px-3.5 text-left font-medium hover:bg-muted"
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          <Trans>Attribution</Trans>
          <Chevron aria-hidden className="size-4 shrink-0" strokeWidth={2} />
        </button>
      </h3>
      {open ? (
        <div id={bodyId} className="flex min-w-0 flex-col gap-4 border-t border-border p-3.5">
          {attribution.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading attribution…</Trans>
            </p>
          ) : attribution.isError ? (
            <div role="alert" className="flex flex-col items-start gap-2 text-sm">
              <p>
                <Trans>The attribution couldn't be loaded.</Trans>
              </p>
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void attribution.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : first === null && latest === null ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                No touch is recorded for this contact yet. One is kept when the contact fills a
                form, books, chats or is added.
              </Trans>
            </p>
          ) : (
            <>
              <button
                type="button"
                className="min-h-9 self-start rounded-control text-sm text-link underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setAll((current) => !current);
                }}
              >
                {all ? <Trans>Hide empty fields</Trans> : <Trans>Show all fields</Trans>}
              </button>
              {first === null ? null : (
                <Touch title={t`First attribution`} touch={first} all={all} />
              )}
              {latest === null ? null : once ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Latest attribution is the same: this contact has one touch recorded.
                  </Trans>
                </p>
              ) : (
                <Touch title={t`Latest attribution`} touch={latest} all={all} />
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
