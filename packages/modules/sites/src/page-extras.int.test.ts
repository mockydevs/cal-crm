// What a page gained on 2026-10-13, against real Postgres: a calendar as a link to its own
// booking page, merge fields filled in from the business's custom values, the small page
// scripts named only where they are needed, and the word on whether the install serves
// public pages. Each thing a kept page now depends on is changed, and the very next visit
// is the new page (private.site_page_state, 0090).
import { randomUUID } from 'node:crypto';

import {
  site as siteContract,
  sitePage,
  sitePageElementList,
  sitePublicStatus,
  siteStep,
  type SitePage,
} from '@repo/contracts';
import { toPublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  headline,
  openHarness,
  pageWith,
  PREVIEW_SECRET,
  PUBLIC_URL,
  SCRIPTS,
  type Harness,
  type Tenant,
} from '../test/harness.js';
import { createPublicSiteHandlers } from './index.js';

let harness: Harness;
beforeAll(async () => {
  harness = await openHarness(inject('databaseServer'));
});
afterAll(async () => {
  await harness.close();
});

const request = () => ({ requestId: randomUUID() });
const publish = (t: Tenant, page: SitePage): Promise<unknown> =>
  t.call('publishSitePage', { params: { id: page.id }, body: { revision: page.revision } });
const codesOf = async (work: Promise<unknown>): Promise<string[]> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).issues.map((issue) => issue.code);
};

/** A funnel with one step at `landing` whose draft shows these elements, not yet published. */
async function draft(t: Tenant, children: unknown[], extra: Record<string, unknown> = {}) {
  const site = await t.site();
  const step = siteStep.parse(
    await t.call('createSiteStep', {
      params: { id: site.id },
      body: { name: 'Landing', path: 'landing' },
    }),
  );
  const page = await t.save(await t.page(step.pages[0]?.id ?? ''), {
    ...pageWith(children),
    ...extra,
  });
  const key =
    siteContract.parse(await t.call('getSite', { params: { id: site.id } })).publicKey ?? '';
  return { page, key };
}
async function visit(key: string): Promise<{ html: string | undefined; rendered: boolean }> {
  const before = harness.renders.length;
  const page = await harness.visit.page(key, 'landing', request());
  return { html: page?.html, rendered: harness.renders.length > before };
}
const calendarElement = (calendarId: string | null, label?: string) => ({
  id: 'cal',
  type: 'calendar',
  props: { calendarId, ...(label === undefined ? {} : { label }) },
});

describe('a calendar on a page', () => {
  it('is published as a link to the calendar’s own booking page, on the install’s address', async () => {
    const t = await harness.tenant();
    const calendar = await harness.calendar(t);
    const { page, key } = await draft(t, [calendarElement(calendar.id, 'Book your visit')]);
    expect(page.problems).toEqual([]);
    await publish(t, page);
    const { html } = await visit(key);
    expect(html).toContain(
      `<a class="bt" href="${PUBLIC_URL}${calendar.path}">Book your visit</a>`,
    );
    // A link, never a frame: the policy names no frame for it. The one script is the
    // arrival's, which a site that can be booked names on its pages (arrival.int.test.ts);
    // it calls nothing.
    expect(html).not.toContain('<iframe');
    const served = await harness.visit.page(key, 'landing', request());
    expect(served?.policy).not.toContain('frame-src');
    expect((html ?? '').match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script defer src="${SCRIPTS.arrival}" data-site="${key}"></script>`);
    expect(served?.policy).not.toContain('connect-src');
  });

  it('is refused when none is chosen, when it is gone, and when it cannot be booked', async () => {
    const t = await harness.tenant();
    const off = await harness.calendar(t, { active: false });
    const gone = toPublicId('calendar', '0192f000-0000-7000-8000-000000000abc');
    const other = await harness.calendar(await harness.tenant());
    for (const [calendarId, code] of [
      [null, 'calendar_missing'],
      [gone, 'calendar_gone'],
      // Another business's calendar is one this business does not have.
      [other.id, 'calendar_gone'],
      [off.id, 'calendar_inactive'],
    ] as const) {
      const { page } = await draft(t, [headline('h', 'Hello'), calendarElement(calendarId)]);
      expect(page.problems?.map((each) => [each.code, each.blocking, each.nodeId])).toEqual([
        [code, true, 'cal'],
      ]);
      expect(await codesOf(publish(t, page))).toEqual([code]);
    }
    // Switched on, the same page publishes.
    const { page } = await draft(t, [headline('h', 'Hello'), calendarElement(off.id)]);
    await harness.setCalendar(off.uuid, { active: true });
    expect((await t.page(page.id)).problems).toEqual([]);
  });

  it('is refused on an install that serves no booking page', async () => {
    const t = await harness.tenant();
    const calendar = await harness.calendar(t);
    const { page } = await draft(t, [calendarElement(calendar.id)]);
    const without = { ...harness.options, booking: false };
    const read = sitePage.parse(
      await t.callWith(without, 'getSitePage', { params: { id: page.id } }),
    );
    expect(read.problems?.map((each) => each.code)).toEqual(['calendar_unavailable']);
    expect(
      await codesOf(
        t.callWith(without, 'publishSitePage', {
          params: { id: page.id },
          body: { revision: page.revision },
        }),
      ),
    ).toEqual(['calendar_unavailable']);
  });

  it('is rendered again when the calendar is switched off, moved or switched on again', async () => {
    const t = await harness.tenant();
    const calendar = await harness.calendar(t);
    const { page, key } = await draft(t, [headline('h', 'Hello'), calendarElement(calendar.id)]);
    await publish(t, page);
    expect((await visit(key)).html).toContain(calendar.path);
    expect((await visit(key)).rendered).toBe(false);

    await harness.setCalendar(calendar.uuid, { active: false });
    const off = await visit(key);
    expect(off.rendered).toBe(true);
    // Nothing that leads nowhere is left on the page.
    expect(off.html).not.toContain('/book/');
    expect(off.html).toContain('Hello');
    expect((await visit(key)).rendered).toBe(false);

    await harness.setCalendar(calendar.uuid, { active: true, slug: 'new-name' });
    const moved = await visit(key);
    expect(moved.rendered).toBe(true);
    expect(moved.html).toContain('/new-name">Book a time</a>');
  });
});

describe('merge fields on a page', () => {
  const words = [
    {
      id: 'p',
      type: 'paragraph',
      props: {
        text: [{ text: 'Call {{custom_values.phone}} or {{values.phone}}, {{contact.name}}.' }],
      },
    },
  ];

  it('are filled in with the business’s custom values, and the ones with none are named', async () => {
    const t = await harness.tenant();
    const before = await draft(t, words);
    expect(before.page.problems?.map((each) => [each.code, each.blocking])).toEqual([
      ['merge_fields', false],
    ]);
    expect(before.page.problems?.[0]?.message).toContain(
      '{{contact.name}}, {{custom_values.phone}}, {{values.phone}}',
    );
    await harness.setCustomValue(t.businessId, 'phone', '(555) 010-2000 <ext>');
    const page = await t.page(before.page.id);
    // Only what a page cannot know is still named.
    expect(page.problems?.[0]?.message).toContain('nothing: {{contact.name}}.');
    await publish(t, page);
    const { html } = await visit(before.key);
    expect(html).toContain('Call (555) 010-2000 &lt;ext&gt; or (555) 010-2000 &lt;ext&gt;, .');
    // Another business's value of the same key is never this page's.
    const other = await harness.tenant();
    const theirs = await draft(other, words);
    await publish(other, theirs.page);
    expect((await visit(theirs.key)).html).toContain('Call  or , .');
  });

  it('are rendered again when a value is changed, emptied or added', async () => {
    const t = await harness.tenant();
    await harness.setCustomValue(t.businessId, 'phone', '555-0100');
    const { page, key } = await draft(t, words);
    await publish(t, page);
    expect((await visit(key)).html).toContain('Call 555-0100');
    expect((await visit(key)).rendered).toBe(false);
    await harness.setCustomValue(t.businessId, 'phone', '555-0199');
    const changed = await visit(key);
    expect(changed.rendered).toBe(true);
    expect(changed.html).toContain('Call 555-0199');
    await harness.setCustomValue(t.businessId, 'phone', '  ');
    const emptied = await visit(key);
    expect(emptied.rendered).toBe(true);
    expect(emptied.html).toContain('Call  or ');
    expect((await visit(key)).rendered).toBe(false);
  });
});

describe('the small page scripts', () => {
  const countdown = (endsAt: string) => ({
    id: 'cd',
    type: 'countdown',
    props: { endsAt, whenOver: { type: 'text', text: 'Over' } },
  });
  const popups = [
    {
      id: 'offer',
      type: 'popup',
      name: 'Offer',
      props: { trigger: 'delay', delaySeconds: 5, width: 'small' },
      rows: [],
    },
  ];

  it('are named only on a page that holds what each is for, and allowed only there', async () => {
    const t = await harness.tenant();
    const plain = await draft(t, [headline('h', 'Hello')]);
    await publish(t, plain.page);
    const bare = await harness.visit.page(plain.key, 'landing', request());
    expect(bare?.html).not.toContain('<script');
    expect(bare?.policy).not.toContain('script-src');

    const ends = new Date(harness.clock.now + 3 * 86_400_000).toISOString();
    const counting = await draft(t, [headline('h', 'Hello'), countdown(ends)]);
    expect(counting.page.problems).toEqual([]);
    await publish(t, counting.page);
    const ticking = await harness.visit.page(counting.key, 'landing', request());
    expect(ticking?.html).toContain(`<script defer src="${SCRIPTS.countdown}"></script>`);
    expect(ticking?.html).not.toContain(SCRIPTS.popup);
    expect(ticking?.html).toContain('<span role="timer">3d 00h 00m</span> left, ends <time');
    expect(ticking?.policy).toContain("script-src 'self'");
    expect(ticking?.policy).not.toContain('connect-src');

    const opening = await draft(t, [headline('h', 'Hello')], { popups });
    expect(opening.page.problems).toEqual([]);
    await publish(t, opening.page);
    const popped = await harness.visit.page(opening.key, 'landing', request());
    expect(popped?.html).toContain(`<script defer src="${SCRIPTS.popup}"></script>`);
    expect(popped?.html).not.toContain(SCRIPTS.countdown);
    expect(popped?.html).toContain(' data-pt="delay" data-pd="5">');
    expect(popped?.policy).toContain("script-src 'self'");
  });

  it('change the page’s tag when a script’s address does, so no kept page names an old script', async () => {
    const t = await harness.tenant();
    const ends = new Date(harness.clock.now + 3 * 86_400_000).toISOString();
    const { page, key } = await draft(t, [countdown(ends)]);
    await publish(t, page);
    const served = await harness.visit.page(key, 'landing', request());
    // A server of the next release: the same page, another script file.
    const next = createPublicSiteHandlers({
      db: harness.db,
      secret: PREVIEW_SECRET,
      publicUrl: PUBLIC_URL,
      scripts: { ...SCRIPTS, countdown: '/s/_js/countdown.ffffffffffffffff.js' },
      now: () => harness.clock.now,
    });
    const later = await next.page(key, 'landing', request());
    expect(later?.html).toContain('/s/_js/countdown.ffffffffffffffff.js');
    expect(later?.etag).not.toBe(served?.etag);
    // And a server with no script to send names none, allows none, and says so.
    const none = createPublicSiteHandlers({
      db: harness.db,
      secret: PREVIEW_SECRET,
      publicUrl: PUBLIC_URL,
      now: () => harness.clock.now,
    });
    const without = await none.page(key, 'landing', request());
    expect(without?.html).not.toContain('<script');
    expect(without?.policy).not.toContain('script-src');
    expect(without?.html).toContain('<span role="timer">3d 00h 00m</span>');
    const told = sitePage.parse(
      await t.callWith({ ...harness.options, scripts: undefined }, 'getSitePage', {
        params: { id: page.id },
      }),
    );
    expect(told.problems?.map((each) => [each.code, each.blocking])).toEqual([
      ['countdown_static', false],
    ]);
  });

  it('let a kept page stand until the minute of its countdown turns, and no longer', async () => {
    const t = await harness.tenant();
    const started = harness.clock.now;
    const { page, key } = await draft(t, [
      countdown(new Date(started + 10 * 60_000 + 30_000).toISOString()),
    ]);
    await publish(t, page);
    try {
      expect((await visit(key)).html).toContain('<span role="timer">00h 10m</span>');
      harness.clock.now = started + 29_000;
      expect((await visit(key)).rendered).toBe(false);
      harness.clock.now = started + 31_000;
      const turned = await visit(key);
      expect(turned.rendered).toBe(true);
      expect(turned.html).toContain('<span role="timer">00h 09m</span>');
      harness.clock.now = started + 60_000;
      expect((await visit(key)).rendered).toBe(false);
    } finally {
      harness.clock.now = started;
    }
  });

  it('are in the preview of a draft too, which keeps nothing in the browser', async () => {
    const t = await harness.tenant();
    const { page } = await draft(t, [headline('h', 'Hello')], { popups });
    const link = (await t.call('getSitePagePreview', { params: { id: page.id } })) as {
      url: string;
    };
    const shown = await harness.visit.preview(link.url.split('/').at(-1) ?? '', request());
    expect(shown?.html).toContain(`<script defer src="${SCRIPTS.popup}"></script>`);
    expect(shown?.html).toContain(' data-pt="delay" data-pd="5" data-pf="always">');
  });
});

describe('what the editor is told', () => {
  it('whether the install serves public pages, to anyone in the business', async () => {
    const t = await harness.tenant();
    expect(sitePublicStatus.parse(await t.call('getSitePublicStatus', {}, t.as([])))).toEqual({
      enabled: true,
      code: 'enabled',
      reason: null,
      baseUrl: `${PUBLIC_URL}/s`,
      scripts: { countdown: true, popup: true },
    });
    const off = sitePublicStatus.parse(
      await t.callWith({ ...harness.options, publicUrl: undefined }, 'getSitePublicStatus'),
    );
    expect(off).toMatchObject({ enabled: false, code: 'no_public_secret', baseUrl: null });
    expect(off.reason).toContain('Public pages are switched off on this install');
  });

  it('how each element type is shown, as this install shows it', async () => {
    const t = await harness.tenant();
    const list = sitePageElementList.parse(await t.call('listSitePageElements', {}, t.as([])));
    expect(list.items).toHaveLength(13);
    const note = (type: string) => list.items.find((each) => each.type === type);
    expect(note('calendar')?.note).toContain('A link to the calendar’s own booking page');
    expect(note('countdown')).toMatchObject({ script: true });
    expect(note('countdown')?.note).toContain('Counts down each second');
    const bare = sitePageElementList.parse(
      await t.callWith({ ...harness.options, scripts: undefined }, 'listSitePageElements'),
    );
    expect(bare.items.find((each) => each.type === 'countdown')).toMatchObject({ script: false });
  });
});
