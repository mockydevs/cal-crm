// Settings → External Tracking → Troubleshoot: whether the script has been heard from and
// when, the latest events it reported and each page last seen, and what to check when
// nothing arrives (from GoHighLevel's own troubleshooting list).
import { Trans, useLingui } from '@lingui/react/macro';
import { getExternalTrackingActivity, type TrackingActivity } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { useId, type ReactElement } from 'react';
import { apiIn } from '../api';
import { useBusiness } from '../workspace';
import { pageAddress } from './rules';
import { cardClassName, problemOf, retryFaults, TrackingFrame } from './shared';

const cellClassName = 'px-3 py-2 text-start align-top break-words';
const headClassName = `${cellClassName} text-sm font-medium text-muted-foreground`;

export default function TroubleshootTab(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const eventsId = useId();
  const pagesId = useId();
  const checksId = useId();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const numbers = new Intl.NumberFormat(i18n.locale);
  const activity = useQuery({
    queryKey: ['b', business.id, 'external-tracking', 'activity'],
    queryFn: (): Promise<TrackingActivity> =>
      apiIn(business.id).request(getExternalTrackingActivity, {}),
    retry: retryFaults,
  });
  const data = activity.data;
  const lastSeen =
    data?.lastEventAt === undefined || data.lastEventAt === null
      ? ''
      : dates.format(new Date(data.lastEventAt));
  return (
    <TrackingFrame>
      <section className={cardClassName} aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-lg font-medium">
              <Trans>Script status</Trans>
            </h2>
            {data === undefined ? null : data.lastEventAt === null ? (
              <>
                <Badge variant="neutral" className="self-start">
                  <Trans>Not detected yet</Trans>
                </Badge>
                <p className="text-md text-body">
                  <Trans>
                    No event has been received. Install the script, then open a page of your
                    website.
                  </Trans>
                </p>
              </>
            ) : (
              <>
                <Badge className="self-start">
                  <Trans>Receiving events</Trans>
                </Badge>
                <p className="text-md text-body">
                  <Trans>Last event received {lastSeen}.</Trans>
                </p>
              </>
            )}
            {activity.isError ? (
              <p role="alert" className="text-sm">
                {problemOf(activity.error, t`What the script reported couldn't be loaded.`)}
              </p>
            ) : null}
          </div>
          <Button
            variant="secondary"
            disabled={activity.isFetching}
            onClick={() => {
              void activity.refetch();
            }}
          >
            <Trans>Refresh</Trans>
          </Button>
        </div>
      </section>
      {data !== undefined && data.events.length > 0 ? (
        <section className={cardClassName} aria-labelledby={eventsId}>
          <h2 id={eventsId} className="text-lg font-medium">
            <Trans>Recent events</Trans>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-md">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={headClassName}>
                    <Trans>Time</Trans>
                  </th>
                  <th scope="col" className={headClassName}>
                    <Trans>Event</Trans>
                  </th>
                  <th scope="col" className={headClassName}>
                    <Trans>Page</Trans>
                  </th>
                  <th scope="col" className={headClassName}>
                    <Trans>Form</Trans>
                  </th>
                  <th scope="col" className={headClassName}>
                    <Trans>Contact</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event, index) => (
                  <tr
                    key={`${event.receivedAt}-${String(index)}`}
                    className="border-b border-border"
                  >
                    <td className={cellClassName}>
                      <time dateTime={event.receivedAt}>
                        {dates.format(new Date(event.receivedAt))}
                      </time>
                    </td>
                    <td className={cellClassName}>
                      {event.kind === 'form_submission' ? t`Form submission` : t`Page view`}
                    </td>
                    <td className={cellClassName}>{pageAddress(event)}</td>
                    <td className={cellClassName}>{event.formName ?? ''}</td>
                    <td className={cellClassName}>
                      {event.contactId === null ? (
                        <span className="text-muted-foreground">
                          <Trans>Unknown visitor</Trans>
                        </span>
                      ) : (
                        <a
                          className="text-primary underline-offset-2 hover:underline"
                          href={`/b/${business.slug}/contacts/${event.contactId}`}
                        >
                          <Trans>View contact</Trans>
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {data !== undefined && data.pages.length > 0 ? (
        <section className={cardClassName} aria-labelledby={pagesId}>
          <h2 id={pagesId} className="text-lg font-medium">
            <Trans>Pages</Trans>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-md">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={headClassName}>
                    <Trans>Page</Trans>
                  </th>
                  <th scope="col" className={headClassName}>
                    <Trans>Views (30 days)</Trans>
                  </th>
                  <th scope="col" className={headClassName}>
                    <Trans>Form submissions</Trans>
                  </th>
                  <th scope="col" className={headClassName}>
                    <Trans>Last seen</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.pages.map((page) => (
                  <tr key={pageAddress(page)} className="border-b border-border">
                    <td className={cellClassName}>{pageAddress(page)}</td>
                    <td className={cellClassName}>{numbers.format(page.pageViews)}</td>
                    <td className={cellClassName}>{numbers.format(page.formSubmissions)}</td>
                    <td className={cellClassName}>
                      <time dateTime={page.lastSeenAt}>
                        {dates.format(new Date(page.lastSeenAt))}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <section className={cardClassName} aria-labelledby={checksId}>
        <h2 id={checksId} className="text-lg font-medium">
          <Trans>If nothing arrives</Trans>
        </h2>
        <ul className="list-disc ps-5 text-md text-body">
          <li>
            <Trans>
              Check the tag is on the page and still has its data-tracking-id. Google Tag Manager
              can strip data attributes: paste the tag into the page itself.
            </Trans>
          </li>
          <li>
            <Trans>
              Add data-debug="true" to the tag and open the browser's console: the script says what
              it sent.
            </Trans>
          </li>
          <li>
            <Trans>
              In the browser's network tab, the script's requests should answer 200. A 403 means the
              website is not in Settings → Allowed websites, or the tracking ID was regenerated.
            </Trans>
          </li>
          <li>
            <Trans>
              A Content-Security-Policy on your website must allow this CRM in script-src and
              connect-src.
            </Trans>
          </li>
          <li>
            <Trans>
              A form appears here only when it is a real &lt;form&gt; with named, visible fields,
              and becomes a contact only with an email or phone field.
            </Trans>
          </li>
        </ul>
      </section>
    </TrackingFrame>
  );
}
