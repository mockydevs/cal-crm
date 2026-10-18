// The query engine against real Postgres: every source's measures against rows whose
// numbers were worked out by hand (the comments say how), under row-level security, in the
// business's own time zone.
import {
  reportResult,
  type ReportCatalog,
  type ReportResult,
  type ReportRow,
} from '@repo/contracts';
import { ForbiddenError, toPublicId, ValidationError } from '@repo/kernel';
import { withTenant } from '@repo/db';
import { beforeAll, describe, expect, it } from 'vitest';

import { runQuery } from './index.js';

import {
  refusalOf,
  reportingOptions,
  reportingSuite,
  type Seeded,
} from '../test/reporting-fixtures.js';

const suite = reportingSuite();
const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' };

let one: Seeded;
let other: Seeded;
let tags: { a: string; b: string };
let pipeline: { id: string; stages: string[] };
let calendars: { k1: string; k2: string };

beforeAll(async () => {
  one = await suite.business();
  // Contacts, by their day in Nairobi (UTC+3):
  //   c1  1 Sep 10:00  form   first touch paid_search (adwords, spring), latest social_media
  //   c2  1 Sep 23:30  user   crm_ui                      owned by the team member
  //   c3  2 Sep 00:30  form   organic_search   (1 Sep 21:30 in UTC: the day is Nairobi's)
  //   c4 15 Sep        api    third_party, in the trash: never counted
  //   c5 31 Aug 23:59  user   crm_ui: the day before the range
  //   c6 20 Sep        user   no touch recorded
  const c1 = await suite.contact(
    one,
    { createdAt: '2026-09-01T10:00:00+03:00', createdSource: 'form', source: 'Fair' },
    [
      {
        at: '2026-09-01T10:00:00+03:00',
        sessionSource: 'paid_search',
        utmSource: 'adwords',
        utmCampaign: 'spring',
        referrer: 'www.google.com',
        leadSource: 'Google Ads',
      },
      {
        at: '2026-09-10T10:00:00+03:00',
        sessionSource: 'social_media',
        referrer: 'www.facebook.com',
        leadSource: 'Facebook',
      },
    ],
  );
  const c2 = await suite.contact(one, { createdAt: '2026-09-01T23:30:00+03:00', owner: true }, [
    { at: '2026-09-01T23:30:00+03:00', medium: 'manual', sessionSource: 'crm_ui' },
  ]);
  const c3 = await suite.contact(
    one,
    { createdAt: '2026-09-02T00:30:00+03:00', createdSource: 'form' },
    [
      {
        at: '2026-09-02T00:30:00+03:00',
        sessionSource: 'organic_search',
        referrer: 'www.bing.com',
      },
    ],
  );
  await suite.contact(
    one,
    { createdAt: '2026-09-15T12:00:00+03:00', createdSource: 'api', trashed: true },
    [{ at: '2026-09-15T12:00:00+03:00', medium: 'api', sessionSource: 'third_party' }],
  );
  await suite.contact(one, { createdAt: '2026-08-31T23:59:00+03:00' }, [
    { at: '2026-08-31T23:59:00+03:00', medium: 'manual', sessionSource: 'crm_ui' },
  ]);
  await suite.contact(one, { createdAt: '2026-09-20T12:00:00+03:00' });
  tags = {
    a: await suite.tag(one, 'Alpha', [c1, c2]),
    b: await suite.tag(one, 'Beta', [c1]),
  };

  // Opportunities, all created in September:
  //   d1 c1 open        stage 1  KES 1000
  //   d2 c1 won  5 Sep  stage 2  KES 2500.50
  //   d3 c3 won  6 Sep  stage 2  USD 300
  //   d4 c2 lost 8 Sep  stage 1  no value
  //   d5 —  open        stage 1  KES 100
  //   d6 c1 open, in the trash: never counted
  pipeline = await suite.pipeline(one, 'Sales', ['New', 'Closing']);
  await suite.deal(one, {
    pipeline,
    contactId: c1,
    createdAt: '2026-09-03T09:00:00+03:00',
    amount: 1000,
    source: 'Fair',
  });
  await suite.deal(one, {
    pipeline,
    stage: 1,
    contactId: c1,
    createdAt: '2026-09-04T09:00:00+03:00',
    status: 'won',
    closedAt: '2026-09-05T09:00:00+03:00',
    amount: 2500.5,
  });
  await suite.deal(one, {
    pipeline,
    stage: 1,
    contactId: c3,
    createdAt: '2026-09-04T10:00:00+03:00',
    status: 'won',
    closedAt: '2026-09-06T09:00:00+03:00',
    amount: 300,
    currency: 'USD',
  });
  await suite.deal(one, {
    pipeline,
    contactId: c2,
    createdAt: '2026-09-07T09:00:00+03:00',
    status: 'lost',
    closedAt: '2026-09-08T09:00:00+03:00',
    amount: null,
  });
  await suite.deal(one, { pipeline, createdAt: '2026-09-09T09:00:00+03:00', amount: 100 });
  await suite.deal(one, {
    pipeline,
    contactId: c1,
    createdAt: '2026-09-09T10:00:00+03:00',
    amount: 999,
    trashed: true,
  });

  // Appointments:
  //   a1 K1 c1 Mon 7 Sep   booked     booking_page  assigned
  //   a2 K1 c3 Tue 8 Sep   cancelled on 6 Sep, user
  //   a3 K2 c2 Mon 14 Sep  completed  user          nobody assigned
  const k1 = await suite.calendar(one, 'Consultations');
  const k2 = await suite.calendar(one, 'Site visits');
  calendars = { k1, k2 };
  await suite.appointment(one, {
    calendarId: k1,
    contactId: c1,
    startsAt: '2026-09-07T10:00:00+03:00',
    source: 'booking_page',
    assigned: true,
  });
  await suite.appointment(one, {
    calendarId: k1,
    contactId: c3,
    startsAt: '2026-09-08T10:00:00+03:00',
    status: 'cancelled',
    cancelledAt: '2026-09-06T10:00:00+03:00',
  });
  await suite.appointment(one, {
    calendarId: k2,
    contactId: c2,
    startsAt: '2026-09-14T10:00:00+03:00',
    status: 'completed',
  });

  // Another business of the same agency, with more of everything: none of it is ever counted.
  other = await suite.business('Africa/Nairobi', one.agencyId);
  const stranger = await suite.contact(
    other,
    { createdAt: '2026-09-03T10:00:00+03:00', createdSource: 'form' },
    [{ at: '2026-09-03T10:00:00+03:00', sessionSource: 'paid_search', utmSource: 'adwords' }],
  );
  const theirs = await suite.pipeline(other, 'Theirs', ['Only']);
  await suite.deal(other, {
    pipeline: theirs,
    contactId: stranger,
    createdAt: '2026-09-03T09:00:00+03:00',
    amount: 77777,
  });
  const theirCalendar = await suite.calendar(other, 'Theirs');
  await suite.appointment(other, {
    calendarId: theirCalendar,
    contactId: stranger,
    startsAt: '2026-09-07T10:00:00+03:00',
  });
});

const ask = async (body: Record<string, unknown>, seeded = one, invocation = seeded.manager) =>
  // Parsed by the contract too: what the engine answers is what the API documents.
  reportResult.parse(
    await suite.api(seeded, 'runReportQuery', { body: { range: SEPTEMBER, ...body } }, invocation),
  );
const byKey = (result: ReportResult, index = 0) =>
  Object.fromEntries(result.rows.map((row) => [row.group[index]?.key ?? 'none', row.values]));
const labels = (rows: readonly ReportRow[]) =>
  rows.map((row) => row.group.map((each) => each.label).join(' / '));

describe('contacts', () => {
  it('counts the contacts created in the range, by the business’s own days', async () => {
    const result = await ask({ source: 'contacts', measures: ['count'] });
    // c1, c2, c3 and c6. Not c4 (trash) or c5 (31 August in Nairobi).
    expect(result.totals).toEqual([4]);
    expect(result.rows).toEqual([]);
    expect(result).toMatchObject({
      timeZone: 'Africa/Nairobi',
      dateProperty: 'created',
      attribution: 'first',
      range: {
        preset: null,
        from: '2026-09-01',
        to: '2026-09-30',
        fromInstant: '2026-08-31T21:00:00.000Z',
        toInstant: '2026-09-30T21:00:00.000Z',
      },
      truncated: { other: false, incomplete: false },
    });
  });

  it('gives one row a day, zeros included, and a contact made after midnight there its own day', async () => {
    const result = await ask({ source: 'contacts', measures: ['count'], time: { grain: 'day' } });
    expect(result.rows).toHaveLength(30);
    const days = byKey(result);
    expect(days['2026-09-01']).toEqual([2]);
    expect(days['2026-09-02']).toEqual([1]);
    expect(days['2026-09-03']).toEqual([0]);
    expect(days['2026-09-20']).toEqual([1]);
    expect(result.columns.map((column) => column.role)).toEqual(['time', 'measure']);
    const weeks = await ask({ source: 'contacts', measures: ['count'], time: { grain: 'week' } });
    // Weeks from Monday: 31 Aug (c1, c2, c3), 14 Sep (c6).
    expect(byKey(weeks)).toMatchObject({ '2026-08-31': [3], '2026-09-14': [1], '2026-09-07': [0] });
    const months = await ask({ source: 'contacts', measures: ['count'], time: { grain: 'month' } });
    expect(months.rows.map((row) => [row.group[0]?.key, row.values])).toEqual([
      ['2026-09-01', [4]],
    ]);
  });

  it('groups by the first or the latest touch, with the contacts that have none apart', async () => {
    const first = await ask({
      source: 'contacts',
      measures: ['count'],
      groupBy: ['sessionSource'],
    });
    expect(byKey(first)).toEqual({ paid_search: [1], crm_ui: [1], organic_search: [1], none: [1] });
    expect(labels(first.rows)).toContain('Paid search');
    const latest = await ask({
      source: 'contacts',
      measures: ['count'],
      groupBy: ['sessionSource'],
      attribution: 'latest',
    });
    expect(byKey(latest)).toEqual({
      social_media: [1],
      crm_ui: [1],
      organic_search: [1],
      none: [1],
    });
    const campaigns = await ask({
      source: 'contacts',
      measures: ['count'],
      groupBy: ['utmSource', 'utmCampaign'],
    });
    expect(campaigns.rows.map((row) => [row.group.map((each) => each.key), row.values])).toEqual([
      [[null, null], [3]],
      [['adwords', 'spring'], [1]],
    ]);
  });

  it('groups by tag, owner, source and how a contact was made', async () => {
    const tagged = await ask({ source: 'contacts', measures: ['count'], groupBy: ['tag'] });
    // c1 has both tags and is in both groups; c3 and c6 have none. The total stays four.
    expect(byKey(tagged)).toEqual({
      [toPublicId('tag', tags.a)]: [2],
      [toPublicId('tag', tags.b)]: [1],
      none: [2],
    });
    expect(tagged.totals).toEqual([4]);
    expect(labels(tagged.rows)).toEqual(['Alpha', '', 'Beta']);
    const owners = await ask({ source: 'contacts', measures: ['count'], groupBy: ['owner'] });
    expect(owners.rows.map((row) => row.values)).toEqual([[3], [1]]);
    expect(owners.rows[1]?.group[0]?.key).toMatch(/^mem_/);
    expect(owners.rows[1]?.group[0]?.label).not.toBe('');
    const made = await ask({
      source: 'contacts',
      measures: ['count'],
      groupBy: ['createdSource', 'source'],
    });
    expect(made.rows.map((row) => [row.group.map((each) => each.key), row.values])).toEqual([
      [['user', null], [2]],
      // Equal counts: in the groups' own order, and the ones without a value last.
      [['form', 'Fair'], [1]],
      [['form', null], [1]],
    ]);
  });

  it('filters by text, choices, tags and people, all or any', async () => {
    const filtered = (filters: unknown) =>
      ask({ source: 'contacts', measures: ['count'], filters });
    const group = (...conditions: unknown[]) => ({
      match: 'all',
      groups: [{ match: 'all', conditions }],
    });
    const total = async (...conditions: unknown[]) =>
      (await filtered(group(...conditions))).totals[0];
    expect(await total({ field: 'utmSource', operator: 'is', value: 'AdWords' })).toBe(1);
    expect(await total({ field: 'utmSource', operator: 'is_not', value: 'adwords' })).toBe(3);
    expect(await total({ field: 'utmSource', operator: 'contains', value: 'word' })).toBe(1);
    expect(await total({ field: 'utmSource', operator: 'not_contains', value: 'word' })).toBe(3);
    expect(await total({ field: 'utmSource', operator: 'any_of', values: ['adwords', 'x'] })).toBe(
      1,
    );
    expect(await total({ field: 'utmSource', operator: 'none_of', values: ['adwords'] })).toBe(3);
    expect(await total({ field: 'utmSource', operator: 'is_empty' })).toBe(3);
    expect(await total({ field: 'utmSource', operator: 'is_not_empty' })).toBe(1);
    expect(
      await total({
        field: 'sessionSource',
        operator: 'any_of',
        values: ['paid_search', 'crm_ui'],
      }),
    ).toBe(2);
    expect(
      await total({ field: 'sessionSource', operator: 'none_of', values: ['paid_search'] }),
    ).toBe(3);
    expect(await total({ field: 'sessionSource', operator: 'is_empty' })).toBe(1);
    expect(await total({ field: 'sessionSource', operator: 'is_not_empty' })).toBe(3);
    const a = toPublicId('tag', tags.a);
    expect(await total({ field: 'tag', operator: 'any_of', values: [a] })).toBe(2);
    expect(await total({ field: 'tag', operator: 'none_of', values: [a] })).toBe(2);
    expect(await total({ field: 'tag', operator: 'is_empty' })).toBe(2);
    expect(await total({ field: 'tag', operator: 'is_not_empty' })).toBe(2);
    expect(await total({ field: 'owner', operator: 'any_of', values: ['me'] })).toBe(1);
    expect(await total({ field: 'owner', operator: 'is_empty' })).toBe(3);
    // Both must hold, then either.
    expect(
      await total(
        { field: 'tag', operator: 'any_of', values: [a] },
        { field: 'createdSource', operator: 'any_of', values: ['form'] },
      ),
    ).toBe(1);
    const either = await filtered({
      match: 'any',
      groups: [
        {
          match: 'all',
          conditions: [{ field: 'createdSource', operator: 'any_of', values: ['form'] }],
        },
        {
          match: 'any',
          conditions: [
            { field: 'owner', operator: 'is_not_empty' },
            { field: 'source', operator: 'is', value: 'nothing' },
          ],
        },
      ],
    });
    expect(either.totals).toEqual([3]);
  });

  it('refuses a condition that names nobody or nothing, with a pointer to it', async () => {
    const refused = await refusalOf(
      () =>
        ask({
          source: 'contacts',
          measures: ['count'],
          filters: {
            match: 'all',
            groups: [
              {
                match: 'all',
                conditions: [
                  { field: 'tag', operator: 'any_of', values: ['tag_nope'] },
                  { field: 'owner', operator: 'any_of', values: ['mem_nobody'] },
                ],
              },
            ],
          },
        }),
      ValidationError,
    );
    expect(refused.issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['/filters/groups/0/conditions/0/values/0', 'unknown_reference'],
      ['/filters/groups/0/conditions/1/values/0', 'unknown_reference'],
    ]);
  });

  it('compares with the period before and with a year before', async () => {
    const before = await ask({
      source: 'contacts',
      measures: ['count'],
      compare: 'previous_period',
    });
    // The 30 days before 1 September: 2 to 31 August, which holds c5.
    expect(before.compare).toMatchObject({
      mode: 'previous_period',
      range: { from: '2026-08-02', to: '2026-08-31', preset: null },
      totals: [1],
    });
    const grouped = await ask({
      source: 'contacts',
      measures: ['count'],
      groupBy: ['sessionSource'],
      compare: 'previous_period',
    });
    expect(
      Object.fromEntries(grouped.rows.map((row) => [row.group[0]?.key ?? 'none', row.compare])),
    ).toEqual({
      paid_search: [0],
      crm_ui: [1],
      organic_search: [0],
      none: [0],
    });
    const year = await ask({
      source: 'contacts',
      measures: ['count'],
      time: { grain: 'month' },
      compare: 'previous_year',
    });
    expect(year.compare).toMatchObject({
      range: { from: '2025-09-01', to: '2025-09-30' },
      totals: [0],
    });
    expect(year.rows[0]?.compare).toEqual([0]);
  });

  it('keeps the largest groups and adds the rest up as Other', async () => {
    const result = await ask({
      source: 'contacts',
      measures: ['count'],
      groupBy: ['createdSource', 'source'],
      limit: 1,
    });
    expect(
      result.rows.map((row) => [row.other, row.group.map((each) => each.label), row.values]),
    ).toEqual([
      [false, ['User', ''], [2]],
      [true, ['Other', 'Other'], [2]],
    ]);
    expect(result.truncated).toEqual({ other: true, incomplete: false, limit: 1 });
    const series = await ask({
      source: 'contacts',
      measures: ['count'],
      groupBy: ['createdSource'],
      time: { grain: 'month' },
      order: { by: 'count', direction: 'asc' },
      limit: 1,
    });
    expect(series.rows.map((row) => [row.group.map((each) => each.key), row.values])).toEqual([
      // Two apiece: the first of them as the choices are listed.
      [['2026-09-01', 'user'], [2]],
      [['2026-09-01', null], [2]],
    ]);
  });

  it('says so when there were more groups than it reads', async () => {
    const result = reportResult.parse(
      await suite.api(
        one,
        'runReportQuery',
        {
          body: {
            source: 'contacts',
            measures: ['count'],
            groupBy: ['createdSource', 'source'],
            range: SEPTEMBER,
          },
        },
        one.manager,
        { ...reportingOptions, limits: { groupsRead: 1 } },
      ),
    );
    expect(result.truncated.incomplete).toBe(true);
    expect(result.totals).toEqual([4]);
  });
});

describe('opportunities', () => {
  it('counts them and adds their values up for each currency', async () => {
    const result = await ask({
      source: 'opportunities',
      measures: ['count', 'value', 'averageValue'],
    });
    // Five, not the one in the trash. KES 1000 + 2500.50 + 100; USD 300. d4 has no value:
    // the average is over the three KES deals that have one, 3600.50 / 3 = 1200.1667.
    expect(result.totals).toEqual([
      5,
      [
        { currency: 'KES', amount: '3600.5000' },
        { currency: 'USD', amount: '300.0000' },
      ],
      [
        { currency: 'KES', amount: '1200.1667' },
        { currency: 'USD', amount: '300.0000' },
      ],
    ]);
  });

  it('groups by status, stage and pipeline, in their own order when asked', async () => {
    const statuses = await ask({
      source: 'opportunities',
      measures: ['count', 'value'],
      groupBy: ['status'],
      order: { by: 'group' },
    });
    expect(statuses.rows.map((row) => [row.group[0]?.key, ...row.values])).toEqual([
      ['open', 2, [{ currency: 'KES', amount: '1100.0000' }]],
      [
        'won',
        2,
        [
          { currency: 'KES', amount: '2500.5000' },
          { currency: 'USD', amount: '300.0000' },
        ],
      ],
      ['lost', 1, []],
    ]);
    const stages = await ask({
      source: 'opportunities',
      measures: ['count'],
      groupBy: ['pipeline', 'stage'],
      order: { by: 'group', direction: 'asc' },
    });
    expect(stages.rows.map((row) => [row.group.map((each) => each.label), row.values])).toEqual([
      [['Sales', 'New'], [3]],
      [['Sales', 'Closing'], [2]],
    ]);
    expect(stages.rows[0]?.group.map((each) => each.key)).toEqual([
      toPublicId('pipeline', pipeline.id),
      toPublicId('stage', pipeline.stages[0] ?? ''),
    ]);
    const byValue = await ask({
      source: 'opportunities',
      measures: ['count', 'value'],
      groupBy: ['stage'],
      order: { by: 'value', direction: 'desc' },
    });
    expect(labels(byValue.rows)).toEqual(['Closing', 'New']);
  });

  it('reads each of its dates', async () => {
    const closed = await ask({
      source: 'opportunities',
      measures: ['count'],
      time: { property: 'closed', grain: 'day' },
      range: { from: '2026-09-05', to: '2026-09-08' },
    });
    expect(closed.rows.map((row) => row.values[0])).toEqual([1, 1, 0, 1]);
    const changed = await ask({
      source: 'opportunities',
      measures: ['count'],
      time: { property: 'statusChanged' },
      range: { from: '2026-09-05', to: '2026-09-06' },
    });
    expect(changed.totals).toEqual([2]);
  });

  it('takes the attribution of the primary contact', async () => {
    const result = await ask({
      source: 'opportunities',
      measures: ['count', 'value'],
      groupBy: ['sessionSource'],
    });
    expect(byKey(result)).toEqual({
      // d1 and d2 are c1's, d3 is c3's, d4 is c2's, d5 has no contact.
      paid_search: [2, [{ currency: 'KES', amount: '3500.5000' }]],
      organic_search: [1, [{ currency: 'USD', amount: '300.0000' }]],
      crm_ui: [1, []],
      none: [1, [{ currency: 'KES', amount: '100.0000' }]],
    });
    const latest = await ask({
      source: 'opportunities',
      measures: ['count'],
      groupBy: ['sessionSource'],
      attribution: 'latest',
    });
    expect(byKey(latest)).toMatchObject({ social_media: [2] });
  });

  it('filters by value, pipeline, stage and lost reason', async () => {
    const total = async (...conditions: unknown[]) =>
      (
        await ask({
          source: 'opportunities',
          measures: ['count'],
          filters: { match: 'all', groups: [{ match: 'all', conditions }] },
        })
      ).totals[0];
    expect(await total({ field: 'value', operator: 'gt', value: '500' })).toBe(2);
    expect(await total({ field: 'value', operator: 'gte', value: '1000' })).toBe(2);
    expect(await total({ field: 'value', operator: 'lt', value: '300' })).toBe(1);
    expect(await total({ field: 'value', operator: 'lte', value: '300' })).toBe(2);
    expect(await total({ field: 'value', operator: 'is', value: '300' })).toBe(1);
    expect(await total({ field: 'value', operator: 'is_not', value: '300' })).toBe(4);
    expect(await total({ field: 'value', operator: 'between', from: '100', to: '1000' })).toBe(3);
    expect(await total({ field: 'value', operator: 'is_empty' })).toBe(1);
    expect(await total({ field: 'value', operator: 'is_not_empty' })).toBe(4);
    expect(
      await total({
        field: 'pipeline',
        operator: 'any_of',
        values: [toPublicId('pipeline', pipeline.id)],
      }),
    ).toBe(5);
    expect(
      await total({
        field: 'stage',
        operator: 'none_of',
        values: [toPublicId('stage', pipeline.stages[1] ?? '')],
      }),
    ).toBe(3);
    expect(await total({ field: 'lostReason', operator: 'is_empty' })).toBe(5);
    expect(await total({ field: 'lostReason', operator: 'is_not_empty' })).toBe(0);
    const refused = await refusalOf(
      () => total({ field: 'value', operator: 'gt', value: 'lots' }),
      ValidationError,
    );
    expect(refused.issues[0]).toMatchObject({
      code: 'invalid_number',
      path: '/filters/groups/0/conditions/0/value',
    });
    const between = await refusalOf(
      () => total({ field: 'value', operator: 'between', from: 'a', to: '2' }),
      ValidationError,
    );
    expect(between.issues[0].path).toBe('/filters/groups/0/conditions/0/from');
  });
});

describe('appointments', () => {
  it('counts them by status, calendar, person, channel and weekday', async () => {
    const result = await ask({
      source: 'appointments',
      measures: ['count'],
      groupBy: ['status'],
      order: { by: 'group' },
    });
    expect(result.totals).toEqual([3]);
    expect(result.rows.map((row) => [row.group[0]?.label, row.values[0]])).toEqual([
      ['Booked', 1],
      ['Cancelled', 1],
      ['Showed', 1],
    ]);
    const weekdays = await ask({
      source: 'appointments',
      measures: ['count'],
      groupBy: ['weekday'],
      order: { by: 'group' },
    });
    // 7 and 14 September are Mondays, the 8th a Tuesday.
    expect(
      weekdays.rows.map((row) => [row.group[0]?.key, row.group[0]?.label, row.values[0]]),
    ).toEqual([
      ['1', 'Monday', 2],
      ['2', 'Tuesday', 1],
    ]);
    const byCalendar = await ask({
      source: 'appointments',
      measures: ['count'],
      groupBy: ['calendar'],
    });
    expect(byKey(byCalendar)).toEqual({
      [toPublicId('calendar', calendars.k1)]: [2],
      [toPublicId('calendar', calendars.k2)]: [1],
    });
    const people = await ask({
      source: 'appointments',
      measures: ['count'],
      groupBy: ['assignee', 'bookingSource'],
    });
    expect(
      people.rows.map((row) => [
        row.group.map((each) => (each.key === null ? null : each.key.slice(0, 4))),
        row.values[0],
      ]),
    ).toEqual([
      [[null, 'user'], 2],
      [['mem_', 'book'], 1],
    ]);
  });

  it('reads when one was booked and when one was cancelled, and its contact’s attribution', async () => {
    const cancelled = await ask({
      source: 'appointments',
      measures: ['count'],
      time: { property: 'cancelled' },
    });
    expect(cancelled.totals).toEqual([1]);
    const booked = await ask({
      source: 'appointments',
      measures: ['count'],
      time: { property: 'created' },
      range: { from: '2026-09-07', to: '2026-09-07' },
    });
    expect(booked.totals).toEqual([1]);
    const sources = await ask({
      source: 'appointments',
      measures: ['count'],
      groupBy: ['sessionSource'],
    });
    expect(byKey(sources)).toEqual({ paid_search: [1], organic_search: [1], crm_ui: [1] });
    const filtered = await ask({
      source: 'appointments',
      measures: ['count'],
      filters: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [
              {
                field: 'calendar',
                operator: 'any_of',
                values: [toPublicId('calendar', calendars.k1)],
              },
              { field: 'assignee', operator: 'is_not_empty' },
            ],
          },
        ],
      },
    });
    expect(filtered.totals).toEqual([1]);
  });
});

describe('attribution', () => {
  it('counts touches and the different contacts they are of', async () => {
    const all = await ask({ source: 'attribution', measures: ['touches', 'contacts'] });
    // c1 twice, c2, c3. Not c4 (trash), c5 (August) or c6 (no touch).
    expect(all.totals).toEqual([4, 3]);
    expect(all.attribution).toBe('all');
    const first = await ask({
      source: 'attribution',
      measures: ['touches', 'contacts'],
      attribution: 'first',
    });
    expect(first.totals).toEqual([3, 3]);
    const latest = await ask({
      source: 'attribution',
      measures: ['touches'],
      attribution: 'latest',
      groupBy: ['sessionSource'],
    });
    expect(byKey(latest)).toEqual({ social_media: [1], crm_ui: [1], organic_search: [1] });
    // The different contacts of each week (counted per person, then per week): c1 is in both.
    const weeks = await ask({
      source: 'attribution',
      measures: ['touches', 'contacts'],
      time: { grain: 'week' },
    });
    expect(byKey(weeks)).toMatchObject({ '2026-08-31': [3, 3], '2026-09-07': [1, 1] });
    const months = await ask({
      source: 'attribution',
      measures: ['contacts', 'touches'],
      time: { grain: 'month' },
      groupBy: ['medium'],
    });
    expect(months.rows.map((row) => [row.group.map((each) => each.key), row.values])).toEqual([
      [
        ['2026-09-01', 'form'],
        [2, 3],
      ],
      [
        ['2026-09-01', 'manual'],
        [1, 1],
      ],
    ]);
  });

  it('groups by medium and referrer, and gives no count of people for Other', async () => {
    const result = await ask({
      source: 'attribution',
      measures: ['touches', 'contacts'],
      groupBy: ['medium'],
      limit: 1,
    });
    expect(result.rows.map((row) => [row.group[0]?.label, row.values])).toEqual([
      ['Form', [3, 2]],
      ['Other', [1, null]],
    ]);
    const referrers = await ask({
      source: 'attribution',
      measures: ['contacts'],
      groupBy: ['referrerDomain'],
      order: { by: 'contacts' },
    });
    expect(byKey(referrers)).toEqual({
      'www.google.com': [1],
      'www.facebook.com': [1],
      'www.bing.com': [1],
      none: [1],
    });
    const days = await ask({
      source: 'attribution',
      measures: ['touches'],
      time: { grain: 'week' },
      groupBy: ['landingPage'],
    });
    expect(days.rows).toHaveLength(5);
  });
});

describe('the lead source', () => {
  it('groups touches, and contacts by their first or latest touch, by its name', async () => {
    const touches = await ask({
      source: 'attribution',
      measures: ['touches'],
      groupBy: ['leadSource'],
    });
    expect(touches.columns.find((column) => column.key === 'leadSource')?.label).toBe(
      'Lead source',
    );
    // c1's two touches have a name each; the rest were not visits to a page, or had none kept.
    expect(byKey(touches)).toMatchObject({ 'Google Ads': [1], Facebook: [1] });
    const first = await ask({ source: 'contacts', measures: ['count'], groupBy: ['leadSource'] });
    expect(byKey(first)).toMatchObject({ 'Google Ads': [1] });
    expect(byKey(first)).not.toHaveProperty('Facebook');
    const latest = await ask({
      source: 'contacts',
      measures: ['count'],
      groupBy: ['leadSource'],
      attribution: 'latest',
    });
    expect(byKey(latest)).toMatchObject({ Facebook: [1] });
    expect(byKey(latest)).not.toHaveProperty('Google Ads');
  });

  it('filters by it, as by any text', async () => {
    const only = await ask({
      source: 'attribution',
      measures: ['touches'],
      filters: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [{ field: 'leadSource', operator: 'contains', value: 'google' }],
          },
        ],
      },
    });
    expect(only.totals).toEqual([1]);
  });
});

describe('who may read what', () => {
  it('refuses someone without reports.view, naming the permission', async () => {
    const viewer = one.withPermissions('assistant.use');
    for (const [operationId, input] of [
      ['runReportQuery', { body: { source: 'contacts', measures: ['count'], range: SEPTEMBER } }],
      ['getReportCatalog', {}],
      ['listReportTemplates', {}],
      ['getAttributionReport', {}],
      ['getAppointmentOverview', {}],
      ['listReports', {}],
    ] as const) {
      const refused = await refusalOf(
        () => suite.api(one, operationId, input, viewer),
        ForbiddenError,
      );
      expect(refused.permission, operationId).toBe('reports.view');
    }
  });

  it('lets a reader read, and says what they may do', async () => {
    const reader = one.withPermissions('reports.view');
    const result = await ask({ source: 'contacts', measures: ['count'] }, one, reader);
    expect(result.totals).toEqual([4]);
    const catalog = (await suite.api(one, 'getReportCatalog', {}, reader)) as ReportCatalog;
    expect(catalog.canManage).toBe(false);
    expect(catalog.sources.map((source) => [source.key, source.allowed])).toEqual([
      ['contacts', true],
      ['opportunities', true],
      ['appointments', true],
      ['attribution', true],
    ]);
    expect(catalog.sources[1]?.numberFilters).toEqual([
      {
        key: 'value',
        label: 'Value',
        operators: expect.arrayContaining(['gt', 'between']) as unknown,
      },
    ]);
    expect(((await suite.api(one, 'getReportCatalog')) as ReportCatalog).canManage).toBe(true);
  });

  it('never counts another business’s rows', async () => {
    // The other business has one contact, one deal and one appointment in the range.
    for (const [source, measure, mine, theirs] of [
      ['contacts', 'count', 4, 1],
      ['opportunities', 'count', 5, 1],
      ['appointments', 'count', 3, 1],
      ['attribution', 'touches', 4, 1],
    ] as const) {
      expect((await ask({ source, measures: [measure] })).totals, source).toEqual([mine]);
      expect((await ask({ source, measures: [measure] }, other)).totals, source).toEqual([theirs]);
    }
    // Naming the other business's pipeline finds nothing of it here.
    const smuggled = await ask({
      source: 'opportunities',
      measures: ['value'],
      groupBy: ['pipeline'],
    });
    expect(JSON.stringify(smuggled)).not.toContain('77777');
  });
});

describe('limits', () => {
  it('refuses more rows than an answer holds', async () => {
    const refused = await refusalOf(
      () =>
        ask({
          source: 'contacts',
          measures: ['count'],
          time: { grain: 'day' },
          range: { from: '2024-01-01', to: '2026-09-30' },
        }),
      ValidationError,
    );
    expect(refused.issues[0]).toMatchObject({ code: 'too_many_rows', path: '/time/grain' });
    const grouped = await refusalOf(
      () =>
        ask({
          source: 'contacts',
          measures: ['count'],
          groupBy: ['source'],
          time: { grain: 'day' },
          limit: 100,
        }),
      ValidationError,
    );
    expect(grouped.issues[0]).toMatchObject({ code: 'too_many_rows', path: '/limit' });
  });

  it('answers a statement that runs out of time as a refusal, not a fault', async () => {
    // Another session holds the contacts table, so the count waits until its time is up.
    const blocker = suite.database.as('crm_owner', async (sql) => {
      await sql.query('lock table crm.contacts in access exclusive mode');
      await sql.query('select pg_sleep(1.5)');
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refused = await refusalOf(
      () =>
        suite.api(
          one,
          'runReportQuery',
          { body: { source: 'contacts', measures: ['count'], range: SEPTEMBER } },
          one.manager,
          { ...reportingOptions, limits: { statementTimeoutMs: 200 } },
        ),
      ValidationError,
    );
    expect(refused.issues[0]).toMatchObject({ code: 'query_timeout', path: '' });
    await blocker;
    // The connection is as good as new afterwards.
    expect((await ask({ source: 'contacts', measures: ['count'] })).totals).toEqual([4]);
  });

  it('holds one person to so many queries a minute', async () => {
    const limited = { ...reportingOptions, limits: { queriesPerMinute: 2 } };
    const run = () =>
      suite.api(
        one,
        'runReportQuery',
        { body: { source: 'contacts', measures: ['count'], range: SEPTEMBER } },
        one.manager,
        limited,
      );
    await run();
    await run();
    const refused = await refusalOf(run, ValidationError);
    expect(refused.issues[0].code).toBe('rate_limited');
    // Somebody else is not held by it.
    await suite.api(
      other,
      'runReportQuery',
      { body: { source: 'contacts', measures: ['count'], range: SEPTEMBER } },
      other.manager,
      limited,
    );
  });

  it('works presets out from today in the business’s time zone, and its days across a clock change', async () => {
    const preset = await ask({
      source: 'contacts',
      measures: ['count'],
      range: { preset: 'this_month' },
    });
    expect(preset.range.preset).toBe('this_month');
    expect(preset.range.from.endsWith('-01')).toBe(true);
    // New York leaves daylight saving on 1 November 2026: that day is 25 hours long.
    const newYork = await suite.business('America/New_York');
    await suite.contact(newYork, { createdAt: '2026-11-01T05:30:00Z' });
    await suite.contact(newYork, { createdAt: '2026-11-02T04:30:00Z' });
    await suite.contact(newYork, { createdAt: '2026-11-02T05:30:00Z' });
    const result = await ask(
      {
        source: 'contacts',
        measures: ['count'],
        time: { grain: 'day' },
        range: { from: '2026-11-01', to: '2026-11-02' },
      },
      newYork,
    );
    expect(result.range).toMatchObject({
      fromInstant: '2026-11-01T04:00:00.000Z',
      toInstant: '2026-11-03T05:00:00.000Z',
    });
    // 04:30 UTC on the 2nd is still 23:30 on the 1st there, now five hours behind.
    expect(result.rows.map((row) => row.values[0])).toEqual([2, 1]);
  });
});

describe('the engine itself, for a caller that is not the API', () => {
  const direct = (query: unknown, today?: string, invocation = one.manager) =>
    withTenant(suite.db, invocation.context, (trx) =>
      // Not parsed by the contract: the engine holds its own lines.
      runQuery(trx, invocation, query as Parameters<typeof runQuery>[2], reportingOptions, today),
    );

  it('works a preset out from the day it is told it is', async () => {
    const result = await direct(
      { source: 'contacts', measures: ['count'], groupBy: [], range: { preset: 'last_month' } },
      '2026-10-12',
    );
    expect(result.range).toMatchObject({
      preset: 'last_month',
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(result.totals).toEqual([4]);
  });

  it('refuses a field, an operator or a measure the catalogue does not list', async () => {
    const refused = await refusalOf(
      () =>
        direct({
          source: 'appointments',
          measures: ['count'],
          groupBy: [],
          range: SEPTEMBER,
          filters: {
            match: 'all',
            groups: [
              {
                match: 'all',
                conditions: [
                  { field: 'weekday', operator: 'any_of', values: ['1'] },
                  { field: 'nothing', operator: 'is', value: 'x' },
                  { field: 'utmSource', operator: 'gt', value: '1' },
                  { field: 'status', operator: 'contains', value: 'x' },
                ],
              },
            ],
          },
        }),
      ValidationError,
    );
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      'unknown_field',
      'unknown_field',
      'invalid_operator',
      'invalid_operator',
    ]);
    const number = await refusalOf(
      () =>
        direct({
          source: 'opportunities',
          measures: ['count'],
          groupBy: [],
          range: SEPTEMBER,
          filters: {
            match: 'all',
            groups: [
              { match: 'all', conditions: [{ field: 'value', operator: 'contains', value: '1' }] },
            ],
          },
        }),
      ValidationError,
    );
    expect(number.issues[0].code).toBe('invalid_operator');
  });

  it('counts for an API key and for the system as for a person', async () => {
    const { userId: _userId, ...context } = one.manager.context;
    for (const actor of [
      { ...context, actorKind: 'api_key' as const, actorId: one.userId },
      {
        agencyId: context.agencyId,
        businessId: one.businessId,
        actorKind: 'system' as const,
        correlationId: context.correlationId,
      },
    ]) {
      const result = reportResult.parse(
        await suite.api(
          one,
          'runReportQuery',
          { body: { source: 'contacts', measures: ['count'], range: SEPTEMBER } },
          { context: actor, permissions: 'all' },
          {
            ...reportingOptions,
            limits: { statementTimeoutMs: 4000, queriesPerMinute: 50, groupsRead: 100 },
          },
        ),
      );
      expect(result.totals, actor.actorKind).toEqual([4]);
    }
  });
});

describe('a team member a condition names', () => {
  const owned = (resolve: () => Promise<string | null>) =>
    suite.api(
      one,
      'runReportQuery',
      {
        body: {
          source: 'contacts',
          measures: ['count'],
          range: SEPTEMBER,
          filters: {
            match: 'all',
            groups: [
              {
                match: 'all',
                conditions: [{ field: 'owner', operator: 'any_of', values: ['me'] }],
              },
            ],
          },
        },
      },
      one.manager,
      { ...reportingOptions, members: { ...reportingOptions.members, resolve } },
    );

  it('is refused when the team says the selection is no good', async () => {
    const refused = await refusalOf(
      () =>
        owned(() =>
          Promise.reject(
            new ValidationError([{ path: '/assignee', code: 'unavailable', message: 'Not here.' }]),
          ),
        ),
      ValidationError,
    );
    expect(refused.issues[0]).toMatchObject({
      code: 'unknown_reference',
      path: '/filters/groups/0/conditions/0/values/0',
    });
  });

  it('is a fault of the server when the lookup itself fails', async () => {
    await expect(owned(() => Promise.reject(new TypeError('The lookup broke.')))).rejects.toThrow(
      'The lookup broke.',
    );
  });
});
