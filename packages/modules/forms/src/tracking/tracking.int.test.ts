// External Tracking against a migrated Postgres: the business's tracking id and settings as
// Settings → External Tracking changes them, and what the script reports, through the real
// public handlers: page views kept anonymous until a form says who the visitor is, then the
// contact made or found, its touch, its timeline and its earlier page views.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation } from '@repo/commands';
import {
  externalTracking,
  trackingActivity,
  type ExternalTracking,
  type PublicTrackingEvent,
} from '@repo/contracts';
import { ConflictError, ForbiddenError, toPublicId, ValidationError } from '@repo/kernel';
import { beforeAll, describe, expect, it } from 'vitest';

import { formSuite, type FormFixture } from '../../test/form-fixtures.js';
import {
  createPublicTrackingHandlers,
  expireExternalTracking,
  externalTrackingRoutes,
  type PublicTrackingHandlers,
  type TrackingRequest,
} from '../index.js';

const SECRET = 'tracking-fixture-secret-of-at-least-32-bytes';
const SITE = 'https://www.acme-roofing.example';

const suite = formSuite();
let clock = Date.now();
let handlers: PublicTrackingHandlers;
beforeAll(() => {
  handlers = createPublicTrackingHandlers({ db: suite.db, secret: SECRET, now: () => clock });
});

const route = (operationId: string) => {
  const found = externalTrackingRoutes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`Missing ${operationId} route.`);
  return found;
};
const run = (
  f: FormFixture,
  operationId: string,
  body?: unknown,
  invocation: Invocation = f.manager,
): Promise<unknown> =>
  route(operationId).run(
    {
      invocation: {
        ...invocation,
        context: { ...invocation.context, correlationId: randomUUID() },
      },
      params: {},
      query: {},
      body,
    },
    { db: suite.db, authorize: allowEveryone },
  );
const settingsOf = async (f: FormFixture): Promise<ExternalTracking> =>
  externalTracking.parse(await run(f, 'getExternalTracking'));
const update = async (f: FormFixture, change: Partial<ExternalTracking>) => {
  const current = await settingsOf(f);
  return externalTracking.parse(
    await run(f, 'updateExternalTracking', {
      pageViews: current.pageViews,
      formCapture: current.formCapture,
      allowedDomains: current.allowedDomains,
      visitorIds: current.visitorIds,
      revision: current.revision,
      ...change,
    }),
  );
};

const request = (change: Partial<TrackingRequest> = {}): TrackingRequest => ({
  requestId: randomUUID(),
  ipAddress: '198.51.100.20',
  gpc: false,
  ...change,
});

interface Visitor {
  readonly visitorId: string;
  readonly sessionId: string;
}
const newVisitor = (): Visitor => ({ visitorId: randomUUID(), sessionId: randomUUID() });

/** The script on a page of SITE: its page view, answered with a view token. */
async function view(
  f: FormFixture,
  path: string,
  who: Visitor = newVisitor(),
  change: {
    readonly origin?: string;
    readonly request?: Partial<TrackingRequest>;
    readonly referrer?: string;
  } = {},
) {
  const { trackingId } = await settingsOf(f);
  const origin = change.origin ?? SITE;
  const admission = await handlers.admit(trackingId, origin);
  if (admission === undefined) throw new Error('The tracking id did not admit this website.');
  const event: PublicTrackingEvent = {
    type: 'page_view',
    pageUrl: `${origin}${path}`,
    title: 'Acme Roofing',
    ...(change.referrer === undefined ? {} : { referrer: change.referrer }),
    ...who,
    deviceType: 'desktop',
  };
  return handlers.record(admission, event, request(change.request));
}

/** A form sent from a page the visitor viewed a few seconds before. */
async function send(
  f: FormFixture,
  fields: readonly { name: string; label?: string; value: string }[],
  options: {
    readonly who?: Visitor;
    readonly path?: string;
    readonly after?: number;
    readonly clientSubmissionId?: string;
    readonly formName?: string;
    readonly request?: Partial<TrackingRequest>;
    readonly viewToken?: string;
  } = {},
) {
  const who = options.who ?? newVisitor();
  const path = options.path ?? '/contact?utm_source=google&utm_medium=cpc&utm_campaign=Spring';
  const shown = await view(f, path, who, { request: options.request ?? {} });
  if (shown.outcome !== 'ok' || shown.receipt.viewToken === undefined)
    throw new Error('No view token.');
  clock += options.after ?? 3000;
  const { trackingId } = await settingsOf(f);
  const admission = await handlers.admit(trackingId, SITE);
  if (admission === undefined) throw new Error('Not admitted.');
  return handlers.record(
    admission,
    {
      type: 'form_submission',
      pageUrl: `${SITE}${path}`,
      ...who,
      viewToken: options.viewToken ?? shown.receipt.viewToken,
      clientSubmissionId: options.clientSubmissionId ?? randomUUID(),
      formName: options.formName ?? 'Free estimate',
      fields: [...fields],
    },
    request(options.request),
  );
}

const rows = <T extends Record<string, unknown>>(
  f: FormFixture,
  text: string,
  values: unknown[] = [],
) => suite.database.withTenant(f.business.context, (sql) => sql.query<T>(text, values));

const OK = { outcome: 'ok', receipt: { status: 'received' } };

describe('Settings → External Tracking', () => {
  it('gives each business one tracking id of its own, kept from then on', async () => {
    const f = await suite.fixture();
    const first = await settingsOf(f);
    expect(first).toEqual({
      trackingId: expect.stringMatching(/^tk_[a-z0-9]{32}$/) as string,
      pageViews: true,
      formCapture: true,
      allowedDomains: [],
      visitorIds: 'unless_opted_out',
      revision: 1,
    });
    expect((await settingsOf(f)).trackingId).toBe(first.trackingId);
    const other = await suite.fixture();
    expect((await settingsOf(other)).trackingId).not.toBe(first.trackingId);
  });

  it('changes what the script does without overwriting a change made meanwhile', async () => {
    const f = await suite.fixture();
    const before = await settingsOf(f);
    const changed = await update(f, {
      pageViews: false,
      allowedDomains: ['Acme-Roofing.example'],
      visitorIds: 'always',
    });
    expect(changed).toMatchObject({
      pageViews: false,
      formCapture: true,
      allowedDomains: ['acme-roofing.example'],
      visitorIds: 'always',
      revision: 2,
    });
    await expect(
      run(f, 'updateExternalTracking', {
        pageViews: true,
        formCapture: true,
        allowedDomains: [],
        visitorIds: 'never',
        revision: before.revision,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      run(f, 'updateExternalTracking', { ...changed, allowedDomains: ['https://x.com'] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('gives a new tracking id on request, and the old one stops at once', async () => {
    const f = await suite.fixture();
    const before = await settingsOf(f);
    const after = externalTracking.parse(
      await run(f, 'regenerateTrackingId', { revision: before.revision }),
    );
    expect(after.trackingId).not.toBe(before.trackingId);
    expect(after.revision).toBe(before.revision + 1);
    expect(await handlers.admit(before.trackingId, SITE)).toBeUndefined();
    expect(await handlers.admit(after.trackingId, SITE)).toBeDefined();
    await expect(
      run(f, 'regenerateTrackingId', { revision: before.revision }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets only someone who manages sites change it, and anyone in the business read it', async () => {
    const f = await suite.fixture();
    const reader: Invocation = { ...f.manager, permissions: new Set(['contacts.manage']) };
    expect(
      externalTracking.parse(await run(f, 'getExternalTracking', undefined, reader)),
    ).toBeDefined();
    const current = await settingsOf(f);
    await expect(
      run(
        f,
        'updateExternalTracking',
        {
          pageViews: current.pageViews,
          formCapture: current.formCapture,
          allowedDomains: current.allowedDomains,
          visitorIds: current.visitorIds,
          revision: current.revision,
        },
        reader,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      run(f, 'regenerateTrackingId', { revision: current.revision }, reader),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('who the script answers', () => {
  it('answers any secure website until the business lists some, then those and their subdomains', async () => {
    const f = await suite.fixture();
    const { trackingId } = await settingsOf(f);
    expect(await handlers.admit(trackingId, 'https://anything.example')).toMatchObject({
      businessId: f.business.id,
      origin: 'https://anything.example',
    });
    expect(await handlers.admit(trackingId, 'http://insecure.example')).toBeUndefined();
    await update(f, { allowedDomains: ['acme-roofing.example'] });
    expect(await handlers.admit(trackingId, SITE)).toBeDefined();
    expect(await handlers.admit(trackingId, 'https://anything.example')).toBeUndefined();
  });

  it('answers no unknown id, and no business that is not active', async () => {
    const f = await suite.fixture();
    const { trackingId } = await settingsOf(f);
    expect(await handlers.admit(`tk_${'0'.repeat(32)}`, SITE)).toBeUndefined();
    expect(await handlers.admit('tk_bad', SITE)).toBeUndefined();
    await suite.database.as('postgres', (sql) =>
      sql.query("update tenancy.businesses set status = 'suspended' where id = $1", [
        f.business.id,
      ]),
    );
    expect(await handlers.admit(trackingId, SITE)).toBeUndefined();
  });
});

describe('a page view', () => {
  it('is kept with its page and campaign, never the query, and answered with a view token', async () => {
    const f = await suite.fixture();
    const result = await view(
      f,
      '/pricing?utm_source=facebook&utm_medium=paid&utm_campaign=Roofs&gclid=abc&email=pat@example.com',
      newVisitor(),
      { referrer: 'https://www.google.com/search?q=roof' },
    );
    expect(result).toEqual({
      outcome: 'ok',
      receipt: { status: 'received', viewToken: expect.stringMatching(/^\d{13}\./) as string },
    });
    expect(
      await rows(
        f,
        `select kind, page_host, page_path, page_title, referrer_domain, campaign, device_type,
                contact_id, visitor_id is not null as identified from forms.tracking_events`,
      ),
    ).toEqual([
      {
        kind: 'page_view',
        page_host: 'www.acme-roofing.example',
        page_path: '/pricing',
        page_title: 'Acme Roofing',
        referrer_domain: 'www.google.com',
        campaign: {
          utmSource: 'facebook',
          utmMedium: 'paid',
          utmCampaign: 'Roofs',
          clickIds: ['gclid'],
        },
        device_type: 'desktop',
        contact_id: null,
        identified: true,
      },
    ]);
    expect(
      await rows(f, 'select page_views, form_submissions from forms.tracking_page_days'),
    ).toEqual([{ page_views: 1, form_submissions: 0 }]);
    expect(
      await rows(f, "select id from events.events where type like 'external_tracking.%'"),
    ).toEqual([]);
  });

  it('is not kept when page views are off, and still proves the page was shown', async () => {
    const f = await suite.fixture();
    await update(f, { pageViews: false });
    const result = await view(f, '/');
    expect(result.outcome === 'ok' && result.receipt.viewToken !== undefined).toBe(true);
    expect(await rows(f, 'select id from forms.tracking_events')).toEqual([]);
  });

  it('is refused for a page on another website than the one it came from', async () => {
    const f = await suite.fixture();
    const { trackingId } = await settingsOf(f);
    const admission = await handlers.admit(trackingId, SITE);
    if (admission === undefined) throw new Error('Not admitted.');
    expect(
      await handlers.record(
        admission,
        { type: 'page_view', pageUrl: 'https://elsewhere.example/', ...newVisitor() },
        request(),
      ),
    ).toEqual({ outcome: 'unavailable' });
  });

  it('keeps no visitor id for a browser that asks not to be tracked, unless told to', async () => {
    const f = await suite.fixture();
    await view(f, '/a', newVisitor(), { request: { gpc: true } });
    await update(f, { visitorIds: 'always' });
    await view(f, '/b', newVisitor(), { request: { gpc: true } });
    await update(f, { visitorIds: 'never' });
    await view(f, '/c', newVisitor());
    expect(
      await rows(
        f,
        'select page_path, visitor_id is not null as identified from forms.tracking_events order by page_path',
      ),
    ).toEqual([
      { page_path: '/a', identified: false },
      { page_path: '/b', identified: true },
      { page_path: '/c', identified: false },
    ]);
  });
});

describe('a form sent on another website', () => {
  it('makes the contact, with its touch, its timeline and the page views before it', async () => {
    const f = await suite.fixture();
    const who = newVisitor();
    await view(f, '/', who);
    await view(f, '/services', who);
    const result = await send(
      f,
      [
        { name: 'your-name', value: 'Pat Lee' },
        { name: 'your-email', value: 'pat@example.com' },
        { name: 'your-message', label: 'Message', value: 'Leaking roof' },
        { name: 'card_number', value: '4111111111111111' },
      ],
      { who },
    );
    expect(result).toEqual(OK);
    const [contact] = await rows<{
      id: string;
      first_name: string;
      last_name: string;
      source: string;
    }>(f, 'select id, first_name, last_name, source from crm.contacts');
    expect(contact).toMatchObject({ first_name: 'Pat', last_name: 'Lee', source: 'Google Ads' });
    const id = contact?.id ?? '';
    expect(
      await rows(
        f,
        `select subject_kind, utm_source, utm_campaign, landing_url, is_first
         from crm.contact_attributions where contact_id = $1`,
        [id],
      ),
    ).toEqual([
      {
        subject_kind: 'external_submission',
        utm_source: 'google',
        utm_campaign: 'Spring',
        landing_url: `${SITE}/contact`,
        is_first: true,
      },
    ]);
    // Every page view of the visitor is now the contact's, the form's page included.
    expect(
      await rows(
        f,
        'select kind, contact_id = $1 as theirs from forms.tracking_events order by received_at, id',
        [id],
      ),
    ).toEqual([
      { kind: 'page_view', theirs: true },
      { kind: 'page_view', theirs: true },
      { kind: 'page_view', theirs: true },
      { kind: 'form_submission', theirs: true },
    ]);
    const [submission] = await rows<{ fields: unknown; form_name: string; lead_source: string }>(
      f,
      'select fields, form_name, lead_source from forms.external_submissions',
    );
    expect(submission).toEqual({
      form_name: 'Free estimate',
      lead_source: 'Google Ads',
      // The card number never reached the database.
      fields: [
        { name: 'your-name', value: 'Pat Lee' },
        { name: 'your-email', value: 'pat@example.com' },
        { name: 'your-message', label: 'Message', value: 'Leaking roof' },
      ],
    });
    // The message filled nothing: the team reads it in a note.
    const [note] = await rows<{ body_text: string }>(
      f,
      'select body_text from crm.notes where record_id = $1',
      [id],
    );
    expect(note?.body_text).toContain('Message: "Leaking roof"');
    expect(
      await rows(
        f,
        `select e.type, e.payload from crm.timeline_entries t
         join events.events e on e.id = t.event_id
         where t.record_id = $1 and e.type like 'external_tracking.%' order by e.id`,
        [id],
      ),
    ).toEqual([
      { type: 'external_tracking.visitor_identified', payload: { pageViews: 3 } },
      {
        type: 'external_tracking.form_submitted',
        payload: expect.objectContaining({
          formName: 'Free estimate',
          pageHost: 'www.acme-roofing.example',
          pagePath: '/contact',
          utmSource: 'google',
          utmMedium: 'cpc',
          utmCampaign: 'Spring',
        }) as unknown,
      },
    ]);
    // Sent twice, stored once.
    expect(
      await rows(
        f,
        'select page_views, form_submissions from forms.tracking_page_days where page_path = $1',
        ['/contact'],
      ),
    ).toEqual([{ page_views: 1, form_submissions: 1 }]);
  });

  it('finds the contact that already has the address, and fills a custom field by its key', async () => {
    const f = await suite.fixture();
    await suite.field(f, 'roof_type');
    await send(f, [{ name: 'email', value: 'sam@example.com' }]);
    await send(f, [
      { name: 'Email', value: 'sam@example.com' },
      { name: 'roof_type', value: 'Metal' },
      { name: 'first_name', value: 'Sam' },
    ]);
    const contacts = await rows<{ id: string; first_name: string | null }>(
      f,
      'select id, first_name from crm.contacts',
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.first_name).toBe('Sam');
    expect(
      await rows(
        f,
        `select v.value_text from crm.field_values v join crm.field_definitions d
           on d.business_id = v.business_id and d.id = v.field_id where d.key = 'roof_type'`,
      ),
    ).toEqual([{ value_text: 'Metal' }]);
    expect(await rows(f, 'select id from forms.external_submissions')).toHaveLength(2);
  });

  it('is stored once for the id the script chose, however often it is sent', async () => {
    const f = await suite.fixture();
    const id = randomUUID();
    expect(
      await send(f, [{ name: 'email', value: 'a@example.com' }], { clientSubmissionId: id }),
    ).toEqual(OK);
    expect(
      await send(f, [{ name: 'email', value: 'a@example.com' }], { clientSubmissionId: id }),
    ).toEqual(OK);
    expect(await rows(f, 'select id from forms.external_submissions')).toHaveLength(1);
  });

  it('keeps nothing personal when it gives no email address or phone number', async () => {
    const f = await suite.fixture();
    expect(await send(f, [{ name: 'q', value: 'Just looking' }])).toEqual(OK);
    expect(await rows(f, 'select id from crm.contacts')).toEqual([]);
    expect(await rows(f, 'select id from forms.external_submissions')).toEqual([]);
    expect(
      await rows(
        f,
        "select form_name, contact_id from forms.tracking_events where kind = 'form_submission'",
      ),
    ).toEqual([{ form_name: 'Free estimate', contact_id: null }]);
  });

  it('is not taken when form capture is off', async () => {
    const f = await suite.fixture();
    await update(f, { formCapture: false });
    expect(await send(f, [{ name: 'email', value: 'off@example.com' }])).toEqual(OK);
    expect(await rows(f, 'select id from crm.contacts')).toEqual([]);
    expect(
      await rows(f, "select id from forms.tracking_events where kind = 'form_submission'"),
    ).toEqual([]);
  });

  it('is refused sent the moment its page loads, or with a token of another visitor', async () => {
    const f = await suite.fixture();
    expect(await send(f, [{ name: 'email', value: 'bot@example.com' }], { after: 100 })).toEqual({
      outcome: 'limited',
      retryAfterSeconds: 2,
    });
    expect(
      await send(f, [{ name: 'email', value: 'bot@example.com' }], {
        viewToken: `${'1'.repeat(13)}.${'a'.repeat(43)}`,
      }),
    ).toEqual({ outcome: 'stale' });
    expect(await rows(f, 'select id from crm.contacts')).toEqual([]);
  });

  it('takes a few forms from one page shown, and no more', async () => {
    const f = await suite.fixture();
    const who = newVisitor();
    const shown = await view(f, '/contact', who);
    if (shown.outcome !== 'ok' || shown.receipt.viewToken === undefined)
      throw new Error('No token.');
    clock += 3000;
    const results = [];
    for (let i = 0; i < 6; i++)
      results.push(
        await send(f, [{ name: 'email', value: `n${String(i)}@example.com` }], {
          who,
          viewToken: shown.receipt.viewToken,
          after: 0,
        }),
      );
    expect(results.slice(0, 5)).toEqual(Array(5).fill(OK));
    expect(results[5]).toEqual({ outcome: 'limited', retryAfterSeconds: 60 });
  });

  it('puts a known visitor’s later page views on their timeline, once a page each half hour', async () => {
    const f = await suite.fixture();
    const who = newVisitor();
    await send(f, [{ name: 'email', value: 'back@example.com' }], { who });
    await view(f, '/gallery', who);
    // Half an hour on, by the database's clock: what was seen is moved back.
    await suite.database.as('postgres', (sql) =>
      sql.query(
        "update forms.tracking_events set received_at = received_at - interval '31 minutes' where business_id = $1",
        [f.business.id],
      ),
    );
    await view(f, '/gallery', who);
    const [contact] = await rows<{ id: string }>(f, 'select id from crm.contacts');
    expect(
      await rows(
        f,
        `select e.payload->>'pagePath' as path from crm.timeline_entries t
         join events.events e on e.id = t.event_id
         where t.record_id = $1 and e.type = 'external_tracking.page_viewed'`,
        [contact?.id],
      ),
    ).toEqual([{ path: '/gallery' }, { path: '/gallery' }]);
  });
});

describe('Troubleshoot', () => {
  it('shows the latest events, each page last seen, and when the script was last heard from', async () => {
    const f = await suite.fixture();
    expect(trackingActivity.parse(await run(f, 'getExternalTrackingActivity'))).toEqual({
      lastEventAt: null,
      events: [],
      pages: [],
    });
    await view(f, '/');
    await send(f, [{ name: 'email', value: 'seen@example.com' }], { path: '/quote' });
    const activity = trackingActivity.parse(await run(f, 'getExternalTrackingActivity'));
    const [contact] = await rows<{ id: string }>(f, 'select id from crm.contacts');
    expect(activity.lastEventAt).not.toBeNull();
    expect(
      activity.events.map(({ kind, pagePath, formName, contactId }) => [
        kind,
        pagePath,
        formName,
        contactId,
      ]),
    ).toEqual([
      ['form_submission', '/quote', 'Free estimate', toPublicId('contact', contact?.id ?? '')],
      ['page_view', '/quote', null, toPublicId('contact', contact?.id ?? '')],
      ['page_view', '/', null, null],
    ]);
    expect(
      activity.pages.map(({ pagePath, pageViews, formSubmissions }) => [
        pagePath,
        pageViews,
        formSubmissions,
      ]),
    ).toEqual([
      ['/quote', 1, 1],
      ['/', 1, 0],
    ]);
  });

  it('shows one business nothing of another', async () => {
    const f = await suite.fixture();
    const other = await suite.fixture();
    await view(f, '/private');
    expect(trackingActivity.parse(await run(other, 'getExternalTrackingActivity')).events).toEqual(
      [],
    );
  });
});

describe('retention', () => {
  it('removes raw events past thirty days and keeps the rest', async () => {
    const f = await suite.fixture();
    await view(f, '/old');
    await view(f, '/new');
    await suite.database.as('postgres', (sql) =>
      sql.query(
        "update forms.tracking_events set received_at = now() - interval '31 days' where business_id = $1 and page_path = '/old'",
        [f.business.id],
      ),
    );
    expect(
      await expireExternalTracking({ db: suite.db, authorize: allowEveryone }, 1),
    ).toBeGreaterThanOrEqual(1);
    expect(await rows(f, 'select page_path from forms.tracking_events')).toEqual([
      { page_path: '/new' },
    ]);
  });
});

describe('the edges', () => {
  it('makes a contact from a phone number alone', async () => {
    const f = await suite.fixture();
    expect(await send(f, [{ name: 'phone', value: '+1 415 555 0142' }])).toEqual(OK);
    expect(await rows(f, 'select id from crm.contacts')).toHaveLength(1);
  });

  it('makes the contact from the email address when the phone number is not one, and notes it', async () => {
    const f = await suite.fixture();
    await send(f, [
      { name: 'email', value: 'odd@example.com' },
      { name: 'phone', value: '+999 1234567' },
      { name: 'notes', value: 'No label here' },
    ]);
    const [contact] = await rows<{ id: string }>(f, 'select id from crm.contacts');
    const [note] = await rows<{ body_text: string }>(
      f,
      'select body_text from crm.notes where record_id = $1',
      [contact?.id],
    );
    expect(note?.body_text).toContain('Phone: "+999 1234567"');
    expect(note?.body_text).toContain('notes: "No label here"');
  });

  it('keeps a form whose only address cannot be read, belonging to nobody and with nothing personal', async () => {
    const f = await suite.fixture();
    expect(
      await send(f, [
        { name: 'phone', value: '+999 1234567' },
        { name: 'full_name', value: 'Robin Unreadable' },
      ]),
    ).toEqual(OK);
    expect(await rows(f, 'select id from crm.contacts')).toEqual([]);
    // No contact to read it on or erase it with: none of what the visitor typed is kept.
    expect(await rows(f, 'select contact_id, fields from forms.external_submissions')).toEqual([
      { contact_id: null, fields: [] },
    ]);
    expect(
      await rows(f, "select id from events.events where type like 'external_tracking.%'"),
    ).toEqual([]);
  });

  it('leaves a custom field the contact has, and one that refuses the value, to the note', async () => {
    const f = await suite.fixture();
    await suite.field(f, 'roof_type');
    await suite.field(f, 'budget', 'number');
    await send(f, [
      { name: 'email', value: 'kept@example.com' },
      { name: 'roof_type', value: 'Metal' },
    ]);
    await send(f, [
      { name: 'email', value: 'kept@example.com' },
      { name: 'roof_type', label: 'Roof', value: 'Tile' },
      { name: 'budget', label: 'Budget', value: 'lots' },
    ]);
    expect(
      await rows(
        f,
        `select v.value_text from crm.field_values v join crm.field_definitions d
           on d.business_id = v.business_id and d.id = v.field_id where d.key = 'roof_type'`,
      ),
    ).toEqual([{ value_text: 'Metal' }]);
    const notes = await rows<{ body_text: string }>(f, 'select body_text from crm.notes');
    const text = notes.map((each) => each.body_text).join('\n');
    expect(text).toContain('Roof: "Tile"');
    expect(text).toContain('Budget: "lots"');
  });

  it('names a form with no name as GoHighLevel does, and keeps every campaign label', async () => {
    const f = await suite.fixture();
    await send(f, [{ name: 'email', value: 'unnamed@example.com' }], {
      formName: '   ',
      path: '/x?utm_source=a&utm_medium=b&utm_campaign=c&utm_content=d&utm_term=e',
    });
    expect(await rows(f, 'select form_name from forms.external_submissions')).toEqual([
      { form_name: 'Unidentified Form' },
    ]);
    const [viewed] = await rows<{ campaign: unknown }>(
      f,
      "select campaign from forms.tracking_events where kind = 'page_view'",
    );
    expect(viewed?.campaign).toEqual({
      utmSource: 'a',
      utmMedium: 'b',
      utmCampaign: 'c',
      utmContent: 'd',
      utmTerm: 'e',
    });
  });

  it('links no visitor to a contact for a browser that asks not to be tracked', async () => {
    const f = await suite.fixture();
    await send(f, [{ name: 'email', value: 'private@example.com' }], { request: { gpc: true } });
    expect(await rows(f, 'select visitor_id from forms.tracking_visitors')).toEqual([]);
    expect(await rows(f, 'select id from crm.contacts')).toHaveLength(1);
  });

  it('answers nothing for a business switched off after its request was let in', async () => {
    const f = await suite.fixture();
    const { trackingId } = await settingsOf(f);
    const admission = await handlers.admit(trackingId, SITE);
    if (admission === undefined) throw new Error('Not admitted.');
    await suite.database.as('postgres', (sql) =>
      sql.query("update tenancy.businesses set status = 'suspended' where id = $1", [
        f.business.id,
      ]),
    );
    expect(
      await handlers.record(
        admission,
        { type: 'page_view', pageUrl: `${SITE}/`, ...newVisitor() },
        request(),
      ),
    ).toEqual({ outcome: 'unavailable' });
  });

  it('takes so many forms a business an hour, and keeps a page view without a device', async () => {
    const f = await suite.fixture();
    const strict = createPublicTrackingHandlers({
      db: suite.db,
      secret: SECRET,
      now: () => clock,
      limits: { perBusinessHour: 1 },
    });
    const { trackingId } = await settingsOf(f);
    const admission = await strict.admit(trackingId, SITE);
    if (admission === undefined) throw new Error('Not admitted.');
    const who = newVisitor();
    const shown = await strict.record(
      admission,
      { type: 'page_view', pageUrl: `${SITE}/quote`, ...who },
      request(),
    );
    if (shown.outcome !== 'ok' || shown.receipt.viewToken === undefined)
      throw new Error('No token.');
    clock += 3000;
    const form = (email: string) =>
      strict.record(
        admission,
        {
          type: 'form_submission',
          pageUrl: `${SITE}/quote`,
          ...who,
          viewToken: shown.receipt.viewToken ?? '',
          clientSubmissionId: randomUUID(),
          formName: 'Quote',
          fields: [{ name: 'email', value: email }],
        },
        request(),
      );
    expect(await form('one@example.com')).toEqual(OK);
    expect(await form('two@example.com')).toEqual({ outcome: 'limited', retryAfterSeconds: 600 });
    expect(
      await rows(f, "select device_type from forms.tracking_events where kind = 'page_view'"),
    ).toEqual([{ device_type: null }]);
  });

  it('runs on the real clock when given none', async () => {
    const f = await suite.fixture();
    const live = createPublicTrackingHandlers({ db: suite.db, secret: SECRET });
    const { trackingId } = await settingsOf(f);
    const admission = await live.admit(trackingId, SITE);
    if (admission === undefined) throw new Error('Not admitted.');
    const result = await live.record(
      admission,
      { type: 'page_view', pageUrl: `${SITE}/`, ...newVisitor() },
      request(),
    );
    expect(result.outcome).toBe('ok');
  });
});
