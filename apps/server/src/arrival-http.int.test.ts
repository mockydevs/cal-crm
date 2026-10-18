// The arrival survives the funnel, through the production start, over real HTTP, on real
// Postgres.
//
// A two-step funnel is built and published through the API: step 1 says something and
// links on, step 2 shows a form. A visitor lands on step 1 from a Google ad and sends the
// form on step 2, whose address has none of the ad's labels. The lead is Google Ads, not
// Direct. The same for a booking reached from a page of the site.
//
// What is real: the server as an install starts it, its public page, script, form and
// booking routes, the shared limiter, the database. What is stood in for: the browser. The
// requests are the ones the form embed and the booking page make, with what the page's
// script hands them (`first`); that the script itself does so in a browser is shown by
// packages/site-render/runtime/arrival.domtest.ts and bench/arrival.browser.ts.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  contactAttributions,
  EMPTY_PAGE_DOCUMENT,
  form as formContract,
  FORM_LIMITS,
  formSubmissionList,
  publicBookingReceipt,
  publicForm,
  site as siteContract,
  sitePage,
  siteStep,
  type ContactAttribution,
  type PageDocument,
  type Site,
} from '@repo/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { openBench, PUBLIC_URL, type Bench, type BenchBusiness } from '../bench/harness.js';

let bench: Bench;
beforeAll(async () => {
  bench = await openBench(inject('databaseServer'));
});
afterAll(async () => {
  await bench.close();
});

/** The signed-in API over HTTP, as the dashboard calls it. */
async function api<T>(
  parse: { parse: (value: unknown) => T },
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${bench.app.address}/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${String(response.status)} ${text}`);
  return parse.parse(JSON.parse(text));
}

let visitors = 0;
/** A visitor's browser on the install's own address, at a network address of its own. */
function visitor() {
  const address = `198.51.100.${String((visitors += 1))}`;
  return (path: string, body?: unknown): Promise<Response> =>
    fetch(`${bench.app.address}${path}`, {
      redirect: 'manual',
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-forwarded-for': address,
        // A page of the install's own address: what a browser says of where it posts from.
        origin: PUBLIC_URL,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

const page = (children: unknown[]): PageDocument =>
  ({
    ...EMPTY_PAGE_DOCUMENT,
    sections: [
      {
        id: 'top',
        type: 'section',
        props: { width: 'medium' },
        rows: [
          {
            id: 'row',
            type: 'row',
            columns: [{ id: 'col', type: 'column', props: { span: 12 }, children }],
          },
        ],
      },
    ],
  }) as PageDocument;

const AD = '?utm_source=google&utm_medium=cpc&utm_campaign=spring&campaign_id=111&gclid=Cj0-secret';

interface Funnel {
  readonly site: Site;
  readonly key: string;
  readonly formKey: string;
  readonly formId: string;
  readonly offer: string;
  readonly details: string;
}

/** A published form, and a funnel of two published steps whose second shows it. */
async function funnel(): Promise<Funnel> {
  const draft = await api(formContract, 'POST', '/forms', {
    name: `Enquiry ${randomUUID().slice(0, 8)}`,
  });
  const live = await api(formContract, 'POST', `/forms/${draft.id}/publish`, {
    revision: draft.revision,
  });
  const made = await api(siteContract, 'POST', '/sites', {
    kind: 'funnel',
    name: `Spring ${randomUUID().slice(0, 8)}`,
  });
  // Both steps first, in the funnel's order; then each page, the last step's first, so
  // the link to the next step has a published step to lead to.
  const add = async (name: string, path: string): Promise<string> =>
    (await api(siteStep, 'POST', `/sites/${made.id}/steps`, { name, path })).pages[0]?.id ?? '';
  const pages = { offer: await add('Offer', 'offer'), details: await add('Details', 'details') };
  const step = async (pageId: string, children: unknown[]) => {
    const empty = await api(sitePage, 'GET', `/site-pages/${pageId}`);
    const saved = await api(sitePage, 'PUT', `/site-pages/${pageId}/draft`, {
      baseVersion: empty.currentVersion,
      document: page(children),
    });
    await api(sitePage, 'POST', `/site-pages/${pageId}/publish`, { revision: saved.revision });
  };
  const offer = [
    { id: 'title', type: 'headline', props: { text: [{ text: 'The spring offer' }], level: 1 } },
    {
      id: 'next',
      type: 'button',
      props: { label: 'Tell me more', subLabel: '', action: { type: 'next_step' } },
    },
  ];
  await step(pages.details, [{ id: 'signup', type: 'form', props: { formId: live.id } }]);
  await step(pages.offer, offer);
  const site = await api(siteContract, 'GET', `/sites/${made.id}`);
  const key = site.publicKey ?? '';
  return {
    site,
    key,
    formKey: live.publicKey,
    formId: live.id,
    offer: `${PUBLIC_URL}/s/${key}/offer`,
    details: `${PUBLIC_URL}/s/${key}/details`,
  };
}

/** Sends the form as the embed on a page of the install does, and answers the lead's touch. */
async function send(
  f: Funnel,
  said: { pageUrl: string; referrer?: string; first?: unknown },
): Promise<ContactAttribution> {
  const call = visitor();
  const shown = await call(`/api/v1/public/forms/${f.formKey}`);
  expect(shown.status).toBe(200);
  const view = publicForm.parse(await shown.json());
  // A person takes a moment to fill a form in; one sent at once is refused.
  await sleep(FORM_LIMITS.minFillSeconds * 1000 + 150);
  const email = `lead-${randomUUID().slice(0, 8)}@example.test`;
  const sent = await call(`/api/v1/public/forms/${f.formKey}/submissions`, {
    clientSubmissionId: randomUUID(),
    renderToken: view.renderToken,
    values: { first_name: 'Maya', email },
    consents: {},
    trap: '',
    ...said,
  });
  expect(sent.status, await sent.clone().text()).toBe(201);
  const listed = await api(formSubmissionList, 'GET', `/forms/${f.formId}/submissions`);
  const contactId = listed.items[0]?.contactId ?? '';
  const touches = await api(contactAttributions, 'GET', `/contacts/${contactId}/attribution`);
  if (touches.first === null) throw new Error('The lead has no touch.');
  return touches.first;
}

describe('a funnel whose form is on its second step', () => {
  let f: Funnel;
  beforeAll(async () => {
    f = await funnel();
  });

  it('names the arrival’s script on both steps, serves it for good, and allows nothing more', async () => {
    const open = visitor();
    const tags: string[] = [];
    for (const path of ['offer', 'details']) {
      const response = await open(`/s/${f.key}/${path}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      const tag =
        /<script defer src="(\/s\/_js\/arrival\.[0-9a-f]{16}\.js)" data-site="([a-z0-9]+)"><\/script>/.exec(
          html,
        );
      expect(tag?.[2], path).toBe(f.key);
      tags.push(tag?.[1] ?? '');
      const policy = response.headers.get('content-security-policy') ?? '';
      expect(policy, path).toContain("default-src 'none'; script-src 'self'; ");
      expect(policy, path).not.toContain('unsafe');
      // Only the page with the form may call the CRM; the landing page calls nothing.
      expect(policy.includes("connect-src 'self'"), path).toBe(path === 'details');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(tags[0]).toBe(tags[1]);
    // The landing page: one script, the arrival's, and nothing inline.
    const landing = await (await open(`/s/${f.key}/offer`)).text();
    expect(landing.match(/<script/g)).toHaveLength(1);
    expect(landing).toContain(`href="/s/${f.key}/details"`);

    const script = await open(tags[0] ?? '');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toMatch(/javascript/);
    expect(script.headers.get('cache-control')).toContain('immutable');
    expect(script.headers.get('set-cookie')).toBeNull();
    const body = await script.text();
    expect(body.startsWith('(function(){')).toBe(true);
    expect(Buffer.byteLength(body)).toBeLessThan(2048);
  });

  it('records the lead as Google Ads when the ad was followed to step 1 and the form sent on step 2', async () => {
    const touch = await send(f, {
      pageUrl: f.details,
      first: { pageUrl: `${f.offer}${AD}`, referrer: 'https://www.google.com', at: Date.now() },
    });
    expect(touch).toMatchObject({
      medium: 'form',
      source: 'Google Ads',
      sourceRule: 'google_ads',
      sessionSource: 'paid_search',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'spring',
      campaignId: '111',
      referrerDomain: 'www.google.com',
      // Where the visit began, and where the lead was taken.
      landingUrl: f.offer,
      pageUrl: f.details,
      arrivalCarried: true,
      clickIds: ['gclid'],
    });
    // The submission says the same, and keeps the campaign labels of the arrival.
    const listed = await api(formSubmissionList, 'GET', `/forms/${f.formId}/submissions`);
    expect(listed.items[0]).toMatchObject({
      leadSource: 'Google Ads',
      leadSourceRule: 'google_ads',
      pageUrl: f.details,
    });
    expect(JSON.stringify(listed.items[0])).not.toContain('Cj0-secret');
  });

  it('records it as Direct when nothing was carried, as before', async () => {
    const touch = await send(f, { pageUrl: f.details });
    expect(touch).toMatchObject({
      source: 'Direct',
      sessionSource: 'direct',
      landingUrl: f.details,
      pageUrl: f.details,
      arrivalCarried: false,
      clickIds: [],
    });
  });

  it('lets the page’s own labels win over what was carried', async () => {
    const touch = await send(f, {
      pageUrl: `${f.details}?utm_source=facebook&utm_medium=paid_social`,
      first: { pageUrl: `${f.offer}${AD}`, at: Date.now() },
    });
    expect(touch).toMatchObject({
      source: 'Facebook Ads',
      landingUrl: f.details,
      arrivalCarried: false,
      clickIds: [],
    });
  });

  it('ignores a carried arrival that names another website’s page, or is too old', async () => {
    const forged = await send(f, {
      pageUrl: f.details,
      first: { pageUrl: `https://www.rival.example/offer${AD}`, at: Date.now() },
    });
    expect(forged).toMatchObject({ source: 'Direct', landingUrl: f.details, clickIds: [] });
    const stale = await send(f, {
      pageUrl: f.details,
      first: { pageUrl: `${f.offer}${AD}`, at: Date.now() - 91 * 86_400_000 },
    });
    expect(stale).toMatchObject({ source: 'Direct', arrivalCarried: false, clickIds: [] });
  });

  it('refuses a carried arrival that is not what the contract takes', async () => {
    const call = visitor();
    const view = publicForm.parse(await (await call(`/api/v1/public/forms/${f.formKey}`)).json());
    for (const first of [
      { pageUrl: 'javascript:alert(1)' },
      { pageUrl: `${f.offer}?pad=${'a'.repeat(2000)}` },
      { pageUrl: f.offer, cookie: 'x' },
      { referrer: 'https://www.google.com' },
    ]) {
      const sent = await call(`/api/v1/public/forms/${f.formKey}/submissions`, {
        clientSubmissionId: randomUUID(),
        renderToken: view.renderToken,
        values: { email: 'x@example.test' },
        consents: {},
        trap: '',
        pageUrl: f.details,
        first,
      });
      expect(sent.status, JSON.stringify(first).slice(0, 60)).toBe(422);
    }
  });

  it('names no script once the site says never, and the lead is then Direct as before', async () => {
    const off = await api(siteContract, 'PATCH', `/sites/${f.site.id}`, {
      revision: (await api(siteContract, 'GET', `/sites/${f.site.id}`)).revision,
      keepArrival: 'never',
    });
    expect(off.keepArrival).toBe('never');
    const open = visitor();
    const landing = await open(`/s/${f.key}/offer`);
    expect(await landing.text()).not.toContain('<script');
    expect(landing.headers.get('content-security-policy')).not.toContain('script-src');
    const details = await (await open(`/s/${f.key}/details`)).text();
    expect(details.match(/<script/g)).toHaveLength(1);
    expect(details).toContain('/forms/embed.js');
    // With no script on the pages, the embed is handed nothing and sends nothing of it.
    const touch = await send(f, { pageUrl: f.details });
    expect(touch).toMatchObject({ source: 'Direct', arrivalCarried: false });
  });
});

describe('a booking reached from a page of a site', () => {
  let business: BenchBusiness;
  let path: string;
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  beforeAll(async () => {
    business = await bench.business();
    const calendar = await bench.calendar(business);
    path = new URL(calendar.url).pathname;
  });

  let hour = 9;
  /** Books a slot as the booking page does, and answers the booker's touch. */
  async function book(visit: unknown): Promise<Record<string, unknown>> {
    const email = `booker-${randomUUID().slice(0, 8)}@example.test`;
    // As the booking page does: the page gives its proof to this visitor, who takes a
    // moment before booking (each proof is good for one booking).
    const as = visitor();
    const shown = (await (await as(path)).json()) as { readonly renderToken: string };
    await sleep(2100);
    const booked = await as(`${path}/appointments`, {
      renderToken: shown.renderToken,
      bookingRequestId: randomUUID(),
      startsAt: `${date}T${String((hour += 1)).padStart(2, '0')}:00:00Z`,
      contact: { firstName: 'Noor', email },
      notificationConsent: true,
      contactTimezone: 'UTC',
      ...(visit === undefined ? {} : { visit }),
    });
    expect(booked.status, await booked.clone().text()).toBe(200);
    expect(publicBookingReceipt.parse(await booked.json()).status).toBe('booked');
    return bench.database.withTenant(business.context, (sql) =>
      sql.one(
        `select t.source_label, t.session_source, t.campaign_id, t.landing_url, t.page_url,
                t.arrival_carried, t.gclid is not null as has_gclid, t.medium
         from crm.contact_attributions t
         join crm.contact_identities i on i.contact_id = t.contact_id
         where i.value_normalized = $1 and t.is_first`,
        [email],
      ),
    );
  }

  const SITE_PAGE = `${PUBLIC_URL}/s/0123456789abcdef0123456789abcdef/offer`;
  const bookingPage = (search = ''): string =>
    `${PUBLIC_URL}${path.replace('/api/v1/public', '')}${search}`;

  it('is Google Ads when the link carried how the visit began', async () => {
    const carried = `?arr=${encodeURIComponent(`${SITE_PAGE}${AD}`)}&arr_at=${String(Date.now())}`;
    expect(
      await book({
        pageUrl: bookingPage(carried),
        first: { pageUrl: `${SITE_PAGE}${AD}`, at: Date.now() },
      }),
    ).toEqual({
      medium: 'calendar',
      source_label: 'Google Ads',
      session_source: 'paid_search',
      campaign_id: '111',
      landing_url: SITE_PAGE,
      page_url: bookingPage(),
      arrival_carried: true,
      has_gclid: true,
    });
  });

  it('is Direct with nothing carried, and with a landing forged on another website', async () => {
    expect(await book({ pageUrl: bookingPage() })).toMatchObject({
      source_label: 'Direct',
      landing_url: bookingPage(),
      arrival_carried: false,
    });
    expect(
      await book({
        pageUrl: bookingPage(),
        first: { pageUrl: `https://www.rival.example/offer${AD}`, at: Date.now() },
      }),
    ).toMatchObject({ source_label: 'Direct', arrival_carried: false, has_gclid: false });
    // A booking page that says nothing of itself vouches for no first page either.
    expect(await book({ first: { pageUrl: `${SITE_PAGE}${AD}` } })).toMatchObject({
      source_label: 'Direct',
      landing_url: null,
      has_gclid: false,
    });
  });
});
