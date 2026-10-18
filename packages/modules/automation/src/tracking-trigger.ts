// The External Tracking Event trigger's filters, as GoHighLevel's trigger has them: which
// event (a page view or a form sent on another website), the domain (the site or a subdomain
// of it), a page path it contains, the external form's name and campaign labels. Each is
// compared without regard to case. The events are external_tracking.page_viewed and
// external_tracking.form_submitted (forms/src/tracking/public.ts), which carry the page's
// host and path, the form's name and the campaign labels of the page's address.
export interface TrackingFilter {
  readonly event?: 'page_view' | 'form_submission' | undefined;
  readonly domain?: string | undefined;
  readonly pagePath?: string | undefined;
  readonly formName?: string | undefined;
  readonly utmSource?: string | undefined;
  readonly utmMedium?: string | undefined;
  readonly utmCampaign?: string | undefined;
}

export interface TrackingMismatch {
  readonly filter: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

const lower = (value: unknown): string | null =>
  typeof value === 'string' ? value.toLowerCase() : null;

/** Why an event does not pass the trigger's filters; nothing when it does. */
export function trackingMismatch(
  filter: TrackingFilter,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): TrackingMismatch | undefined {
  const event = eventType === 'external_tracking.form_submitted' ? 'form_submission' : 'page_view';
  if (filter.event !== undefined && filter.event !== event)
    return { filter: 'event', expected: filter.event, actual: event };
  const host = lower(payload['pageHost']);
  if (filter.domain !== undefined) {
    const domain = filter.domain.toLowerCase();
    if (host === null || (host !== domain && !host.endsWith(`.${domain}`)))
      return { filter: 'domain', expected: filter.domain, actual: payload['pageHost'] ?? null };
  }
  if (
    filter.pagePath !== undefined &&
    !(lower(payload['pagePath']) ?? '').includes(filter.pagePath.toLowerCase())
  )
    return { filter: 'pagePath', expected: filter.pagePath, actual: payload['pagePath'] ?? null };
  for (const key of ['formName', 'utmSource', 'utmMedium', 'utmCampaign'] as const) {
    const wanted = filter[key];
    if (wanted !== undefined && lower(payload[key]) !== wanted.toLowerCase())
      return { filter: key, expected: wanted, actual: payload[key] ?? null };
  }
  return undefined;
}
