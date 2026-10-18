// What the list and board screens ask for and are answered with. Each existing answer only
// gained optional members, so what was valid before still is.
import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  bulkConversationsInput,
  bulkConversationsResult,
  bulkUpdateConversations,
  CALENDAR_EVENTS_FILTER_LIMIT,
  calendarEventFilterIds,
  calendarEvents,
  CONTACT_COUNT_LIMIT,
  contactCount,
  contactList,
  contactListExtras,
  contactListExtrasOf,
  contactTableColumnKeys,
  contactTableColumns,
  contactViewChanges,
  conversation,
  CONVERSATION_BULK_LIMIT,
  countContacts,
  countContactsQuery,
  createDealInput,
  createViewInput,
  deal,
  dealListQuery,
  dealStageSummary,
  dealStageSummaryQuery,
  dealViewChanges,
  endpoints,
  getDealStageSummary,
  getOpportunityReport,
  listCalendarEvents,
  listCalendarEventsQuery,
  listContactsQuery,
  listConversations,
  opportunityReport,
  opportunityReportQuery,
  savedView,
  updateDealInput,
} from './index.js';

const uuid = (last: number) => `01890a5d-ac96-774b-bcce-b302099a${String(last).padStart(4, '0')}`;
const id = (kind: Parameters<typeof toPublicId>[0], last = 57) => toPublicId(kind, uuid(last));
const at = '2026-10-09T09:00:00.000Z';
const revision = 'a'.repeat(64);
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.map(String).join('/')) ?? [];

describe('the contact list', () => {
  it('reads its extras by name, each once, in one order', () => {
    expect(contactListExtrasOf(undefined)).toEqual([]);
    expect(contactListExtrasOf('tags')).toEqual(['tags']);
    expect(contactListExtrasOf('company,lastActivity,company')).toEqual([
      'lastActivity',
      'company',
    ]);
    expect(contactListExtrasOf(contactListExtras.join(','))).toEqual([...contactListExtras]);
  });

  it('takes include as a list of those names and nothing else', () => {
    expect(listContactsQuery.parse({})).toEqual({ sort: 'newest' });
    expect(listContactsQuery.parse({ include: 'lastActivity,tags,company' }).include).toBe(
      'lastActivity,tags,company',
    );
    for (const include of ['', 'owner', 'tags,', ',tags', 'tags company', 'TAGS'])
      expect(listContactsQuery.safeParse({ include }).success, include).toBe(false);
  });

  it('answers a row with or without its extras', () => {
    const row = { id: id('contact'), name: 'Maya', email: null, phone: null, createdAt: at };
    const page = (items: unknown[]) =>
      contactList.safeParse({ items, next: null, canManage: true });
    // What the list answered before, and what a fixture written then holds.
    expect(page([row]).success).toBe(true);
    expect(
      page([
        {
          ...row,
          lastActivity: { at, channel: 'webchat' },
          tags: [{ id: id('tag'), name: 'Wedding' }],
          company: { id: id('company'), name: 'Garden Venue Ltd' },
        },
        { ...row, lastActivity: null, tags: [], company: null },
      ]).success,
    ).toBe(true);
    expect(page([{ ...row, lastActivity: { at, channel: 'carrier pigeon' } }]).success).toBe(false);
    expect(page([{ ...row, lastActivity: { channel: 'sms' } }]).success).toBe(false);
    expect(page([{ ...row, tags: [{ id: id('company'), name: 'Not a tag' }] }]).success).toBe(
      false,
    );
  });

  it('counts with the filters of the list, and nothing that orders or pages it', () => {
    expect(countContactsQuery.parse({})).toEqual({});
    expect(
      countContactsQuery.parse({
        q: '  maya ',
        createdFrom: at,
        fieldId: id('field'),
        fieldOperator: 'is_set',
      }),
    ).toEqual({ q: 'maya', createdFrom: at, fieldId: id('field'), fieldOperator: 'is_set' });
    for (const extra of [
      { sort: 'name' },
      { after: id('contact') },
      { include: 'tags' },
      { sortField: id('field') },
    ])
      expect(countContactsQuery.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
    // The same rules for a field filter as the list has.
    expect(paths(countContactsQuery.safeParse({ fieldOperator: 'is_set' }))).toEqual(['fieldId']);
    expect(countContacts).toMatchObject({ method: 'get', path: '/contacts/count' });
  });

  it('answers a count with whether it is exact', () => {
    expect(contactCount.parse({ count: 36, exact: true })).toEqual({ count: 36, exact: true });
    expect(contactCount.safeParse({ count: CONTACT_COUNT_LIMIT, exact: false }).success).toBe(true);
    for (const answer of [{ count: -1, exact: true }, { count: 1.5, exact: true }, { count: 3 }])
      expect(contactCount.safeParse(answer).success).toBe(false);
  });
});

describe("a contact view's table columns", () => {
  const view = { objectKey: 'contact', name: 'Venues', state: {}, columns: ['name'] };

  it('are the table in order, the name first, each column once', () => {
    expect(contactTableColumns.parse([...contactTableColumnKeys])).toEqual([
      ...contactTableColumnKeys,
    ]);
    expect(contactTableColumns.parse(['name', 'tags', 'lastActivity'])).toEqual([
      'name',
      'tags',
      'lastActivity',
    ]);
    for (const columns of [
      [],
      ['tags', 'name'],
      ['name', 'tags', 'tags'],
      ['name', 'owner'],
      ['tags'],
    ])
      expect(contactTableColumns.safeParse(columns).success, JSON.stringify(columns)).toBe(false);
  });

  it("are optional when a view is saved, and are the contact list's own columns", () => {
    expect(createViewInput.parse(view)).toEqual(view);
    expect(createViewInput.parse({ ...view, tableColumns: ['name', 'company'] })).toMatchObject({
      tableColumns: ['name', 'company'],
    });
    // Saved once, they are cleared by null and never by leaving them out.
    expect(createViewInput.safeParse({ ...view, tableColumns: null }).success).toBe(false);
    const deals = { objectKey: 'deal', name: 'Open', state: {}, columns: ['name'] };
    // A deal view has columns of its own, and takes none of a contact's.
    expect(createViewInput.safeParse({ ...deals, tableColumns: ['name', 'company'] }).success).toBe(
      false,
    );
    expect(createViewInput.safeParse({ ...view, tableColumns: ['name', 'stage'] }).success).toBe(
      false,
    );
  });

  it('stay, change or go when a view is replaced', () => {
    const changes = { name: 'Venues', state: {}, columns: ['name'], revision };
    expect(contactViewChanges.parse(changes)).not.toHaveProperty('tableColumns');
    expect(contactViewChanges.parse({ ...changes, tableColumns: null }).tableColumns).toBeNull();
    expect(
      contactViewChanges.parse({ ...changes, tableColumns: ['name', 'phone'] }).tableColumns,
    ).toEqual(['name', 'phone']);
    expect(contactViewChanges.safeParse({ ...changes, tableColumns: ['phone'] }).success).toBe(
      false,
    );
    expect(
      dealViewChanges.safeParse({ ...changes, tableColumns: ['name', 'lastActivity'] }).success,
    ).toBe(false);
  });

  it('are answered with a contact view, and a view saved before them still reads', () => {
    const shown = {
      id: id('saved_view'),
      objectKey: 'contact',
      name: 'Venues',
      visibility: 'private',
      access: 'owner',
      owner: { membershipId: null, name: 'Dana Brooks', you: true },
      sharing: { everyone: null, people: [] },
      state: {},
      columns: ['name', 'email'],
      canChange: true,
      canShare: true,
      canUnshare: false,
      canDelete: true,
      canChangeSharing: true,
      createdAt: at,
      updatedAt: at,
      revision,
    };
    expect(savedView.safeParse(shown).success).toBe(true);
    expect(savedView.safeParse({ ...shown, tableColumns: null }).success).toBe(true);
    expect(savedView.parse({ ...shown, tableColumns: ['name', 'tags'] })).toMatchObject({
      tableColumns: ['name', 'tags'],
    });
    expect(savedView.safeParse({ ...shown, tableColumns: ['tags'] }).success).toBe(false);
  });
});

describe('a deal', () => {
  const input = {
    name: 'Roof repair',
    pipelineId: id('pipeline'),
    stageId: id('stage'),
    currency: 'KES',
  };

  it('has an optional source, trimmed, of 1 to 200 characters', () => {
    expect(createDealInput.parse(input)).not.toHaveProperty('source');
    expect(createDealInput.parse({ ...input, source: '  Website form ' }).source).toBe(
      'Website form',
    );
    expect(createDealInput.parse({ ...input, source: null }).source).toBeNull();
    expect(createDealInput.parse({ ...input, source: 'x'.repeat(200) }).source).toHaveLength(200);
    for (const source of ['', '   ', 'x'.repeat(201), 7])
      expect(paths(createDealInput.safeParse({ ...input, source })), String(source)).toEqual([
        'source',
      ]);
    // An edit that leaves it out says nothing about it.
    expect(updateDealInput.parse({ ...input, revision })).not.toHaveProperty('source');
    expect(updateDealInput.parse({ ...input, revision, source: null }).source).toBeNull();
  });

  it('reads with or without its source, as an answer written before it does', () => {
    const answer = {
      ...createDealInput.parse(input),
      id: id('deal'),
      pipelineName: 'Sales',
      stageName: 'New',
      closedAt: null,
      stageEnteredAt: at,
      createdAt: at,
      updatedAt: at,
      trashedAt: null,
      revision,
      canManage: true,
    };
    expect(deal.safeParse(answer).success).toBe(true);
    expect(deal.parse({ ...answer, source: 'Referral' }).source).toBe('Referral');
    expect(deal.parse({ ...answer, source: null }).source).toBeNull();
  });

  it('pages one column of the board by its stage', () => {
    expect(dealListQuery.parse({})).toEqual({ status: 'open', limit: 100 });
    expect(dealListQuery.parse({ stageId: id('stage') }).stageId).toBe(id('stage'));
    expect(dealListQuery.safeParse({ stageId: id('pipeline') }).success).toBe(false);
  });

  it("asks for the board's headers by pipeline, with the board's filters and no page", () => {
    expect(dealStageSummaryQuery.parse({ pipelineId: id('pipeline') })).toEqual({
      pipelineId: id('pipeline'),
      status: 'open',
    });
    expect(
      dealStageSummaryQuery.parse({
        pipelineId: id('pipeline'),
        status: 'all',
        fieldId: id('field'),
        fieldOperator: 'gte',
        fieldValue: '10',
      }),
    ).toMatchObject({ status: 'all', fieldOperator: 'gte' });
    expect(paths(dealStageSummaryQuery.safeParse({}))).toEqual(['pipelineId']);
    for (const extra of [
      { limit: '5' },
      { after: id('deal') },
      { stageId: id('stage') },
      { status: 'abandoned' },
    ])
      expect(
        dealStageSummaryQuery.safeParse({ pipelineId: id('pipeline'), ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    expect(
      paths(dealStageSummaryQuery.safeParse({ pipelineId: id('pipeline'), fieldId: id('field') })),
    ).toEqual(['fieldOperator']);
    expect(getDealStageSummary).toMatchObject({ method: 'get', path: '/deals/stage-summary' });
  });

  it('answers each stage with a count and totals by currency, as exact decimals', () => {
    const stage = { stageId: id('stage'), name: 'New', archived: false, count: 2 };
    const totals = [
      { currency: 'KES', amount: '123456789012345.1237' },
      { currency: 'USD', amount: '10.0000' },
    ];
    const answer = { pipelineId: id('pipeline'), count: 2, totals, stages: [{ ...stage, totals }] };
    expect(dealStageSummary.parse(answer)).toEqual(answer);
    expect(
      dealStageSummary.safeParse({
        ...answer,
        stages: [{ ...stage, totals: [{ currency: 'KES', amount: 5 }] }],
      }).success,
    ).toBe(false);
    expect(dealStageSummary.safeParse({ ...answer, count: -1 }).success).toBe(false);
  });
});

describe('the inbox', () => {
  it('lists every conversation or only the starred ones', () => {
    expect(listConversations.query.parse({})).toMatchObject({ starred: 'any', status: 'open' });
    expect(listConversations.query.parse({ starred: 'only' }).starred).toBe('only');
    expect(listConversations.query.safeParse({ starred: 'true' }).success).toBe(false);
  });

  it('answers a conversation with or without its star and its last message id', () => {
    const shown = {
      id: id('conversation'),
      contact: { id: id('contact'), name: 'Maya', trashed: false },
      status: 'open',
      snoozedUntil: null,
      assignee: null,
      needsReply: true,
      unreadCount: 1,
      unverified: false,
      claimedContact: null,
      lastActivityAt: at,
      lastMessage: {
        preview: 'Hello',
        direction: 'inbound',
        channel: 'email',
        status: 'received',
        at,
      },
      canManage: true,
      canReply: true,
      revision,
    };
    expect(conversation.safeParse(shown).success).toBe(true);
    expect(
      conversation.parse({
        ...shown,
        starred: true,
        lastMessage: { ...shown.lastMessage, id: id('message') },
      }),
    ).toMatchObject({ starred: true, lastMessage: { id: id('message') } });
    expect(conversation.safeParse({ ...shown, starred: 'yes' }).success).toBe(false);
    expect(
      conversation.safeParse({ ...shown, lastMessage: { ...shown.lastMessage, id: id('contact') } })
        .success,
    ).toBe(false);
  });

  const ids = (count: number) =>
    Array.from({ length: count }, (_unused, index) => id('conversation', index));

  it('marks read each conversation up to a message, and the rest by id alone', () => {
    const items = [{ id: id('conversation'), through: id('message') }];
    expect(bulkConversationsInput.parse({ action: 'mark_read', items })).toEqual({
      action: 'mark_read',
      items,
    });
    for (const action of ['mark_unread', 'star', 'unstar'] as const)
      expect(bulkConversationsInput.parse({ action, ids: ids(2) })).toEqual({
        action,
        ids: ids(2),
      });
    // Reading "everything" is not on offer: each conversation says how far.
    expect(bulkConversationsInput.safeParse({ action: 'mark_read', ids: ids(1) }).success).toBe(
      false,
    );
    expect(
      bulkConversationsInput.safeParse({ action: 'mark_read', items: [{ id: id('conversation') }] })
        .success,
    ).toBe(false);
    expect(bulkConversationsInput.safeParse({ action: 'star', items }).success).toBe(false);
  });

  it(`takes 1 to ${String(CONVERSATION_BULK_LIMIT)} conversations, each once, and only the four actions`, () => {
    expect(
      bulkConversationsInput.safeParse({ action: 'star', ids: ids(CONVERSATION_BULK_LIMIT) })
        .success,
    ).toBe(true);
    for (const body of [
      { action: 'star', ids: [] },
      { action: 'star', ids: ids(CONVERSATION_BULK_LIMIT + 1) },
      { action: 'star', ids: [id('conversation'), id('conversation')] },
      { action: 'star', ids: [id('contact')] },
      { action: 'mark_read', items: [] },
      {
        action: 'mark_read',
        items: [
          { id: id('conversation'), through: id('message', 1) },
          { id: id('conversation'), through: id('message', 2) },
        ],
      },
      { action: 'assign', ids: ids(1), assignee: 'me' },
      { action: 'close', ids: ids(1) },
      { action: 'delete', ids: ids(1) },
      { ids: ids(1) },
      { action: 'star', ids: ids(1), revision },
    ])
      expect(
        bulkConversationsInput.safeParse(body).success,
        JSON.stringify(body).slice(0, 60),
      ).toBe(false);
  });

  it('answers what became of each conversation, with a reason from a closed list', () => {
    const answer = {
      action: 'mark_unread',
      results: [
        { id: id('conversation', 1), outcome: 'done', reason: null },
        { id: id('conversation', 2), outcome: 'unchanged', reason: null },
        {
          id: id('conversation', 3),
          outcome: 'skipped',
          reason: { code: 'not_found', message: 'This conversation was not found.' },
        },
      ],
      done: 1,
      unchanged: 1,
      skipped: 1,
    };
    expect(bulkConversationsResult.parse(answer)).toEqual(answer);
    expect(
      bulkConversationsResult.safeParse({
        ...answer,
        results: [
          { id: id('conversation'), outcome: 'skipped', reason: { code: 'locked', message: 'x' } },
        ],
      }).success,
    ).toBe(false);
    expect(bulkConversationsResult.safeParse({ ...answer, action: 'delete' }).success).toBe(false);
    expect(bulkUpdateConversations).toMatchObject({ method: 'post', path: '/conversations/bulk' });
  });
});

describe('the calendar between two instants', () => {
  const window = { from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z' };

  it('takes a window of at most 62 days and shows everything unless told otherwise', () => {
    expect(listCalendarEventsQuery.parse(window)).toEqual({ ...window, type: 'all' });
    expect(
      listCalendarEventsQuery.safeParse({
        from: '2026-11-01T00:00:00Z',
        to: '2027-01-02T00:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      paths(
        listCalendarEventsQuery.safeParse({
          from: '2026-11-01T00:00:00Z',
          to: '2027-01-02T00:00:00.001Z',
        }),
      ),
    ).toEqual(['to']);
    expect(paths(listCalendarEventsQuery.safeParse({ from: window.to, to: window.from }))).toEqual([
      'to',
    ]);
    expect(
      paths(listCalendarEventsQuery.safeParse({ from: window.from, to: window.from })),
    ).toEqual(['to']);
    for (const query of [
      { from: window.from },
      { ...window, type: 'rentals' },
      { ...window, groups: 'x' },
      { from: '2026-11-02', to: '2026-11-09' },
    ])
      expect(listCalendarEventsQuery.safeParse(query).success, JSON.stringify(query)).toBe(false);
  });

  it('names people and calendars by their ids, each once, separated by commas', () => {
    const members = [id('membership', 1), id('membership', 2)];
    const parsed = listCalendarEventsQuery.parse({
      ...window,
      users: members.join(','),
      calendars: id('calendar'),
      type: 'blocked',
    });
    expect(calendarEventFilterIds(parsed.users)).toEqual(members);
    expect(calendarEventFilterIds(parsed.calendars)).toEqual([id('calendar')]);
    expect(calendarEventFilterIds(undefined)).toEqual([]);
    const tooMany = Array.from({ length: CALENDAR_EVENTS_FILTER_LIMIT + 1 }, (_unused, index) =>
      toPublicId('membership', `01890a5d-ac96-774b-bcce-b3020${String(index).padStart(7, '0')}`),
    );
    expect(
      listCalendarEventsQuery.safeParse({ ...window, users: tooMany.slice(1).join(',') }).success,
    ).toBe(true);
    for (const filters of [
      { users: '' },
      { users: `${members[0] ?? ''},${members[0] ?? ''}` },
      { users: id('calendar') },
      { users: `${members[0] ?? ''},` },
      { users: tooMany.join(',') },
      { calendars: id('membership') },
      { calendars: 'cal_1' },
    ])
      expect(
        listCalendarEventsQuery.safeParse({ ...window, ...filters }).success,
        JSON.stringify(filters).slice(0, 60),
      ).toBe(false);
  });

  it('answers appointments and blocked slots, told apart by their kind', () => {
    const appointment = {
      kind: 'appointment',
      id: id('appointment'),
      title: 'Site visit',
      startsAt: at,
      endsAt: at,
      status: 'confirmed',
      calendar: { id: id('calendar'), name: 'Site visits' },
      contact: { id: id('contact'), name: 'Maya', trashed: false },
      assignee: { membershipId: null, you: false },
    };
    const blocked = {
      kind: 'blocked',
      id: id('blocked_slot'),
      // To the microsecond, as the blocked slot itself is kept.
      startsAt: '2026-11-06T06:00:00.000001Z',
      endsAt: '2026-11-06T09:00:00.000002Z',
      user: { membershipId: id('membership'), you: true, name: 'Dana Brooks' },
      calendar: null,
      title: null,
    };
    const answer = {
      items: [appointment, { ...appointment, assignee: null }, blocked],
      truncated: false,
      canManage: false,
    };
    expect(calendarEvents.parse(answer)).toEqual(answer);
    for (const item of [
      { ...appointment, status: 'tentative' },
      { ...appointment, kind: 'rental' },
      { ...blocked, id: id('calendar') },
      { ...blocked, title: 7 },
    ])
      expect(
        calendarEvents.safeParse({ ...answer, items: [item] }).success,
        JSON.stringify(item).slice(0, 60),
      ).toBe(false);
    expect(listCalendarEvents).toMatchObject({ method: 'get', path: '/calendars/events' });
  });
});

describe("the dashboard's opportunity numbers", () => {
  const range = {
    pipelineId: id('pipeline'),
    from: '2026-03-01T00:00:00Z',
    to: '2026-04-01T00:00:00Z',
  };

  it('are asked for one pipeline over a range, by status change unless told otherwise', () => {
    expect(opportunityReportQuery.parse(range)).toEqual({
      ...range,
      dateProperty: 'status_changed',
    });
    expect(opportunityReportQuery.parse({ ...range, dateProperty: 'created' }).dateProperty).toBe(
      'created',
    );
    expect(
      opportunityReportQuery.safeParse({
        ...range,
        from: '2024-01-01T00:00:00Z',
        to: '2027-01-01T00:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      paths(
        opportunityReportQuery.safeParse({
          ...range,
          from: '2024-01-01T00:00:00Z',
          to: '2027-01-01T00:00:00.001Z',
        }),
      ),
    ).toEqual(['to']);
    expect(paths(opportunityReportQuery.safeParse({ ...range, to: range.from }))).toEqual(['to']);
    expect(
      paths(opportunityReportQuery.safeParse({ ...range, from: range.to, to: range.from })),
    ).toEqual(['to']);
    for (const query of [
      { from: range.from, to: range.to },
      { ...range, dateProperty: 'closed' },
      { ...range, status: 'open' },
      { ...range, pipelineId: id('stage') },
    ])
      expect(
        opportunityReportQuery.safeParse(query).success,
        JSON.stringify(query).slice(0, 80),
      ).toBe(false);
    expect(getOpportunityReport).toMatchObject({ method: 'get', path: '/reports/opportunities' });
  });

  it('are answered as counts, exact totals and rates from 0 to 1', () => {
    const totals = [{ currency: 'KES', amount: '1300.0000' }];
    const answer = {
      ...range,
      dateProperty: 'status_changed',
      count: 8,
      statuses: [
        { status: 'open', count: 4, totals },
        { status: 'won', count: 2, totals },
        { status: 'lost', count: 2, totals: [] },
      ],
      conversion: { won: 2, total: 8, rate: 0.25, wonTotals: totals },
      funnel: [
        {
          stageId: id('stage', 1),
          name: 'New',
          count: 6,
          totals,
          cumulativeRate: 1,
          nextStepRate: null,
        },
        {
          stageId: id('stage', 2),
          name: 'Quoted',
          count: 4,
          totals,
          cumulativeRate: 4 / 6,
          nextStepRate: 4 / 6,
        },
      ],
      stages: [{ stageId: id('stage', 1), name: 'New', archived: false, count: 2, totals }],
    };
    expect(opportunityReport.parse(answer)).toEqual(answer);
    const empty = { ...answer, conversion: { won: 0, total: 0, rate: null, wonTotals: [] } };
    expect(opportunityReport.safeParse(empty).success).toBe(true);
    for (const conversion of [
      { ...answer.conversion, rate: 1.5 },
      { ...answer.conversion, rate: -0.1 },
      { ...answer.conversion, rate: '25%' },
    ])
      expect(opportunityReport.safeParse({ ...answer, conversion }).success).toBe(false);
    expect(
      opportunityReport.safeParse({
        ...answer,
        statuses: [{ status: 'abandoned', count: 1, totals }],
      }).success,
    ).toBe(false);
  });
});

describe('the API', () => {
  it('registers each new operation once', () => {
    for (const operationId of [
      'countContacts',
      'getDealStageSummary',
      'getOpportunityReport',
      'bulkUpdateConversations',
      'listCalendarEvents',
    ])
      expect(
        endpoints.filter((endpoint) => endpoint.operationId === operationId),
        operationId,
      ).toHaveLength(1);
  });
});
