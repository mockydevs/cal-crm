// Email verification on the contact list: the bulk "Verify emails" action and its preview,
// the "Email verification is …" filter and the "Email verification" column. Against a
// migrated Postgres as crm_app under row-level security, through the routes the server
// registers. Queuing a check is messaging's (bulk-options.ts), so a stand-in takes its
// place: what it was asked, and what it answered. The filter and the column read
// messaging's results table itself, so those rows are written as messaging writes them.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  contactBulkAction,
  contactBulkItemList,
  contactEmailCheckPreview,
  contactList,
  type ContactBulkAction,
  type ContactEmailCheckPreview,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, parsePublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, team, type Team } from '../../test/contact-details.js';
import { createCrmRoutes } from '../index.js';
import type { BulkEmailCheckOutcome, ContactBulkOptions } from './bulk-options.js';
import { contactBulkRoutes } from './bulk-routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;

/** What the stand-in for email verification answers for a contact, and what it was asked. */
const outcomes = new Map<string, BulkEmailCheckOutcome>();
const queued: { contactId: string; position: number; since: Date }[] = [];
/** How many batches began, each reading the day's limit once. */
let batches = 0;
const previewed: string[][] = [];
let enabled = true;
const emailChecks: NonNullable<ContactBulkOptions['emailChecks']> = {
  enabled: () => Promise.resolve(enabled),
  preview: (_trx, _invocation, ids): Promise<ContactEmailCheckPreview> => {
    previewed.push([...ids]);
    return Promise.resolve({
      contacts: ids.length,
      noEmail: 0,
      excluded: 0,
      current: 0,
      checks: ids.length,
      providerCalls: ids.length,
      overLimit: 0,
      remainingToday: 1000,
      provider: 'connected',
      enabled,
    });
  },
  start: () => {
    batches += 1;
    return Promise.resolve({
      queue: (_trx, _invocation, contactId, place) => {
        queued.push({ contactId, ...place });
        return Promise.resolve(outcomes.get(contactId) ?? 'queued');
      },
    });
  },
};
const options: ContactBulkOptions = { ...detailOptions(), emailChecks };
const routes = [...createCrmRoutes({}, options), ...contactBulkRoutes(options)];
const without = contactBulkRoutes({ ...detailOptions() });

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

function call(
  operationId: string,
  invocation: Invocation,
  request: { query?: Record<string, string>; params?: Record<string, string>; body?: unknown } = {},
  from = routes,
): Promise<unknown> {
  const route = from.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return Promise.resolve(
    route.run(
      { invocation, params: request.params ?? {}, query: request.query ?? {}, body: request.body },
      services,
    ),
  );
}

const person = async (t: Team, firstName: string, email?: string): Promise<string> =>
  (
    (await call('createContact', t.system(), {
      body: { firstName, ...(email === undefined ? {} : { emails: [email] }) },
    })) as { id: string }
  ).id;
const uuid = (id: string) => parsePublicId('contact', id) ?? '';
const owner = (run: string, values: readonly unknown[] = []) =>
  database.as('crm_owner', (sql) => sql.query(run, [...values]));
/** A result as messaging keeps it, for one business's address. */
const result = (t: Team, address: string, values: { status?: string | null; excluded?: boolean }) =>
  owner(
    `insert into messaging.email_verifications (business_id, address_normalized, status, depth, checked_at, excluded)
     values ($1, $2, $3, case when $3::text is null then null else 'mailbox' end,
       case when $3::text is null then null else now() end, $4)`,
    [t.businessId, address, values.status ?? null, values.excluded ?? false],
  );

describe('bulk Verify emails', () => {
  it('queues each contact’s check, keeps a current result, and says why one is skipped', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const [ada, bea, cal, dee, eve] = [
      await person(t, 'Ada', 'ada@example.com'),
      await person(t, 'Bea', 'bea@example.com'),
      await person(t, 'Cal'),
      await person(t, 'Dee', 'dee@example.com'),
      await person(t, 'Eve', 'eve@example.com'),
    ];
    outcomes.set(uuid(bea), 'current');
    outcomes.set(uuid(cal), 'no_email');
    outcomes.set(uuid(dee), 'excluded');
    outcomes.set(uuid(eve), 'daily_limit');
    const before = batches;
    const action = contactBulkAction.parse(
      await call('bulkUpdateContacts', dana.as(), {
        body: { action: 'verify_emails', selection: { ids: [ada, bea, cal, dee, eve] } },
      }),
    );
    expect(action).toMatchObject({
      action: 'verify_emails',
      status: 'completed',
      requested: 5,
      done: 1,
      unchanged: 1,
      skipped: 3,
    });
    const asked = queued.slice(-5);
    expect(asked.map((each) => each.contactId)).toEqual([ada, bea, cal, dee, eve].map(uuid));
    // Each in its place in the action, all from when it began, in one batch.
    expect(asked.map((each) => each.position)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(asked.map((each) => each.since.getTime())).size).toBe(1);
    expect(batches - before).toBe(1);
    const items = contactBulkItemList.parse(
      await call('listContactBulkActionItems', dana.as(), {
        params: { id: action.id },
        query: { outcome: 'skipped' },
      }),
    ).items;
    expect(items.map((item) => item.reason)).toEqual([
      { code: 'no_address', message: 'This contact has no email address to verify.' },
      {
        code: 'verification_excluded',
        message: 'This email address is excluded from email verification.',
      },
      {
        code: 'daily_limit',
        message: "Today's email verification limit is used up. Verify the rest tomorrow.",
      },
    ]);
  });

  it('is refused while verification is off, and where the install has none', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada', 'ada@example.com');
    enabled = false;
    try {
      await expect(
        call('bulkUpdateContacts', t.system(), {
          body: { action: 'verify_emails', selection: { ids: [ada] } },
        }),
      ).rejects.toMatchObject({ issues: [{ path: '/action', code: 'verification_off' }] });
    } finally {
      enabled = true;
    }
    await expect(
      call(
        'bulkUpdateContacts',
        t.system(),
        { body: { action: 'verify_emails', selection: { ids: [ada] } } },
        [...createCrmRoutes({}, detailOptions()), ...without],
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('skips a contact when verification is turned off as it runs', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada', 'ada@example.com');
    outcomes.set(uuid(ada), 'off');
    const action = contactBulkAction.parse(
      await call('bulkUpdateContacts', t.system(), {
        body: { action: 'verify_emails', selection: { ids: [ada] } },
      }),
    );
    expect(action).toMatchObject({ skipped: 1 });
  });

  it('needs contacts.manage, as Verify on the contact page does', async () => {
    const t = await team(database);
    const viewer = await t.member();
    const ada = await person(t, 'Ada', 'ada@example.com');
    await expect(
      call('bulkUpdateContacts', viewer.as(new Set(['contacts.export'] as const)), {
        body: { action: 'verify_emails', selection: { ids: [ada] } },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      call('previewContactEmailChecks', viewer.as(new Set(['contacts.export'] as const)), {
        body: { selection: { ids: [ada] } },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('the preview of Verify emails', () => {
  it('counts the contacts a selection holds, by hand or the whole filtered list', async () => {
    const t = await team(database);
    const [ada, bea] = [
      await person(t, 'Ada', 'ada@example.com'),
      await person(t, 'Bea', 'bea@example.com'),
    ];
    await person(t, 'Cal', 'cal@example.com');
    const byHand = contactEmailCheckPreview.parse(
      await call('previewContactEmailChecks', t.system(), {
        body: { selection: { ids: [ada, bea] } },
      }),
    );
    expect(byHand).toMatchObject({ contacts: 2, checks: 2 });
    expect(new Set(previewed.at(-1))).toEqual(new Set([ada, bea].map(uuid)));
    const all = contactEmailCheckPreview.parse(
      await call('previewContactEmailChecks', t.system(), {
        body: { selection: { all: true, except: [bea] } },
      }),
    );
    expect(all).toMatchObject({ contacts: 2 });
    expect(new Set(previewed.at(-1))).not.toContain(uuid(bea));
    // A contact in the trash, and another business's, are not counted.
    const gone = await person(t, 'Gone', 'gone@example.com');
    await call('trashContact', t.system(), { params: { id: gone } });
    const elsewhere = await person(await team(database), 'Far', 'far@example.com');
    expect(
      contactEmailCheckPreview.parse(
        await call('previewContactEmailChecks', t.system(), {
          body: { selection: { ids: [ada, gone, elsewhere] } },
        }),
      ),
    ).toMatchObject({ contacts: 1 });
    expect(previewed.at(-1)).toEqual([uuid(ada)]);
    // A search that matches nobody is refused, as starting the action would be.
    await expect(
      call('previewContactEmailChecks', t.system(), {
        body: { selection: { all: true, q: 'nobody-by-this-name' } },
      }),
    ).rejects.toMatchObject({ issues: [{ code: 'empty_selection' }] });
    await expect(
      call('previewContactEmailChecks', t.system(), { body: { selection: { ids: [ada] } } }, [
        ...createCrmRoutes({}, detailOptions()),
        ...without,
      ]),
    ).rejects.toMatchObject({ issues: [{ code: 'verification_unavailable' }] });
  });
});

describe('the Email verification filter and column', () => {
  /** The list with a filter on email verification, and the column asked for. */
  const listed = async (t: Team, condition: Record<string, unknown>) =>
    contactList
      .parse(
        await call('listContacts', t.system(), {
          query: {
            include: 'emailVerification',
            filter: JSON.stringify({
              match: 'all',
              groups: [
                { match: 'all', conditions: [{ field: 'emailVerification', ...condition }] },
              ],
            }),
          },
        }),
      )
      .items.map((item) => [item.name, item.emailVerification])
      .sort();

  it('reads what verification found of the primary address, in this business only', async () => {
    const t = await team(database);
    await person(t, 'Ada', 'ada@example.com');
    await person(t, 'Bea', 'bea@example.com');
    await person(t, 'Cal', 'cal@example.com');
    await person(t, 'Dee', 'dee@example.com');
    await person(t, 'Eve');
    await result(t, 'ada@example.com', { status: 'valid' });
    await result(t, 'bea@example.com', { status: 'risky' });
    await result(t, 'cal@example.com', { status: 'invalid', excluded: true });
    // Another business's result for an address this one has is never read.
    const other = await team(database);
    await result(other, 'dee@example.com', { status: 'valid' });

    const all = contactList.parse(
      await call('listContacts', t.system(), { query: { include: 'emailVerification' } }),
    );
    expect(all.items.map((item) => [item.name, item.emailVerification]).sort()).toEqual([
      ['Ada', 'valid'],
      ['Bea', 'risky'],
      ['Cal', 'excluded'],
      ['Dee', 'unchecked'],
      ['Eve', null],
    ]);
    // Without asking for it, a row has no such member.
    const plain = contactList.parse(await call('listContacts', t.system(), {}));
    expect(plain.items[0]).not.toHaveProperty('emailVerification');

    expect(await listed(t, { operator: 'any_of', values: ['valid', 'unchecked'] })).toEqual([
      ['Ada', 'valid'],
      ['Dee', 'unchecked'],
    ]);
    expect(await listed(t, { operator: 'none_of', values: ['valid', 'risky'] })).toEqual([
      ['Cal', 'excluded'],
      ['Dee', 'unchecked'],
      ['Eve', null],
    ]);
    expect(await listed(t, { operator: 'any_of', values: ['excluded'] })).toEqual([
      ['Cal', 'excluded'],
    ]);
    expect(await listed(t, { operator: 'is_empty' })).toEqual([['Eve', null]]);
    expect(await listed(t, { operator: 'is_not_empty' })).toHaveLength(4);
  });

  it('refuses a state verification never has, pointing into the filter', async () => {
    const t = await team(database);
    await expect(
      call('listContacts', t.system(), {
        query: {
          filter: JSON.stringify({
            match: 'all',
            groups: [
              {
                match: 'all',
                conditions: [
                  { field: 'emailVerification', operator: 'any_of', values: ['deliverable'] },
                ],
              },
            ],
          }),
        },
      }),
    ).rejects.toMatchObject({
      issues: [{ path: '/filter/groups/0/conditions/0/values/0', code: 'unknown_choice' }],
    });
  });

  it('starts Verify emails for a whole list filtered by it', async () => {
    const t = await team(database);
    const ada = await person(t, 'Ada', 'ada@example.com');
    await person(t, 'Bea', 'bea@example.com');
    await result(t, 'bea@example.com', { status: 'valid' });
    const action: ContactBulkAction = contactBulkAction.parse(
      await call('bulkUpdateContacts', t.system(), {
        body: {
          action: 'verify_emails',
          selection: {
            all: true,
            filter: {
              match: 'all',
              groups: [
                {
                  match: 'all',
                  conditions: [
                    { field: 'emailVerification', operator: 'any_of', values: ['unchecked'] },
                  ],
                },
              ],
            },
          },
        },
      }),
    );
    expect(action).toMatchObject({ requested: 1, done: 1 });
    expect(queued.at(-1)?.contactId).toBe(uuid(ada));
  });
});
