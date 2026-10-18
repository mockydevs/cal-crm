// One of a contact's addresses at a time, against a migrated Postgres as crm_app under
// row-level security, through the routes the server registers.
import {
  allowEveryone,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  contactDetails,
  MAX_CONTACT_IDENTITIES,
  type ContactAddress,
  type ContactDetails,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, team, waitingForLock, type Team } from '../../test/contact-details.js';
import { readContact, updateContactCommand } from './contacts.js';
import { contactDetailRoutes } from './detail-routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const routes = contactDetailRoutes(detailOptions());

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

async function call(
  operationId: string,
  invocation: Invocation,
  params: { id: string; addressId?: string },
  body?: unknown,
  from: readonly ApiRoute[] = routes,
): Promise<ContactDetails> {
  const route = from.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return contactDetails.parse(await route.run({ invocation, params, body, query: {} }, services));
}

/** A business in Kenya with one team member, and a contact with a name. */
async function fixture(): Promise<{ t: Team; who: Invocation; id: string }> {
  const t = await team(database);
  await database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set address = '{"country": "KE"}' where id = $1`, [
      t.businessId,
    ]),
  );
  const who = (await t.member()).as();
  return { t, who, id: await contactOf(t) };
}
async function contactOf(t: Team, firstName = 'Maya'): Promise<string> {
  return toPublicId('contact', (await database.fixtures.contact(t.context, { firstName })).id);
}
const read = (who: Invocation, id: string) => call('getContactDetails', who, { id });
const add = (who: Invocation, id: string, body: unknown) =>
  call('addContactAddress', who, { id }, body);
const change = (who: Invocation, id: string, address: ContactAddress, body: object) =>
  call('updateContactAddress', who, { id, addressId: address.id }, body);
const remove = (who: Invocation, id: string, address: ContactAddress, revision: string) =>
  call('removeContactAddress', who, { id, addressId: address.id }, { revision });

const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
/** What each attempt failed with. Every one is watched from the start, so none fails unseen. */
const failures = (attempts: readonly Promise<unknown>[]): Promise<unknown[]> =>
  Promise.all(attempts.map(failure));
async function issuesOf(attempt: Promise<unknown>): Promise<readonly Issue[]> {
  const error = await failure(attempt);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).issues;
}
const values = (details: ContactDetails) =>
  details.addresses.map((each) => `${each.value}${each.primary ? ' *' : ''}`);
const found = (details: ContactDetails, value: string): ContactAddress => {
  const address = details.addresses.find((each) => each.value === value);
  if (address === undefined) throw new Error(`No ${value}`);
  return address;
};
const updates = (t: Team) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ payload: unknown }>(
      `select payload from events.events
       where business_id = $1 and type = 'contact.updated' order by recorded_at, id`,
      [t.businessId],
    ),
  );

describe('adding an address', () => {
  it('makes the first of its kind the primary, and a later one never changes which is', async () => {
    const { t, who, id } = await fixture();
    const one = await add(who, id, { kind: 'email', value: ' Maya@Example.test ' });
    expect(one.addresses).toEqual([
      {
        id: expect.any(String) as string,
        kind: 'email',
        value: 'maya@example.test',
        display: 'maya@example.test',
        label: null,
        primary: true,
      },
    ]);
    const two = await add(who, id, { kind: 'email', value: 'm.thompson@example.test' });
    const three = await add(who, id, { kind: 'phone', value: '0712 345678', label: 'mobile' });
    expect(values(three)).toEqual([
      'maya@example.test *',
      'm.thompson@example.test',
      '+254712345678 *',
    ]);
    expect(found(three, '+254712345678')).toMatchObject({
      display: '0712 345678',
      label: 'mobile',
    });
    expect(new Set([one, two, three].map((each) => each.addressesRevision)).size).toBe(3);
    // Reported as the contact command reports it: the field, never the value.
    expect(await updates(t)).toEqual([
      { payload: { changed: ['emails'] } },
      { payload: { changed: ['emails'] } },
      { payload: { changed: ['phones'] } },
    ]);
    // The contact itself reads the same rows, and the audit log keeps no address.
    const contact = await withTenant(db, who.context, (trx) => readContact(trx, who, id));
    expect(contact.emails).toEqual(['maya@example.test', 'm.thompson@example.test']);
    const audit = await database.as('crm_owner', (sql) =>
      sql.query<{ input: unknown }>(
        `select input from audit.commands where business_id = $1 and command = 'contact.add_address'`,
        [t.businessId],
      ),
    );
    expect(audit).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toMatch(/example\.test|712/);
  });

  it('refuses what is not an address, one the contact has, and one too many', async () => {
    const { who, id } = await fixture();
    await add(who, id, { kind: 'phone', value: '+254 712 345678' });
    expect(await issuesOf(add(who, id, { kind: 'phone', value: '0712345678' }))).toEqual([
      expect.objectContaining({ path: '/value', code: 'repeated' }),
    ]);
    expect(await issuesOf(add(who, id, { kind: 'phone', value: '12' }))).toEqual([
      expect.objectContaining({ path: '/value', code: 'phone_invalid' }),
    ]);
    for (let index = 1; index < MAX_CONTACT_IDENTITIES; index += 1)
      await add(who, id, { kind: 'phone', value: `+25471234500${String(index)}` });
    expect(await issuesOf(add(who, id, { kind: 'phone', value: '+254712345099' }))).toEqual([
      expect.objectContaining({ path: '/value', code: 'too_many' }),
    ]);
    expect((await read(who, id)).addresses).toHaveLength(MAX_CONTACT_IDENTITIES);
    // Ten numbers don't stop an email address.
    expect(values(await add(who, id, { kind: 'email', value: 'a@example.test' }))).toHaveLength(
      MAX_CONTACT_IDENTITIES + 1,
    );
  });

  it('refuses an address another contact holds, also as an additional one, and names the holder', async () => {
    const { t, who, id } = await fixture();
    const other = await contactOf(t, 'Jordan');
    await add(who, other, { kind: 'email', value: 'first@example.test' });
    await add(who, other, { kind: 'email', value: 'shared@example.test' });
    expect(await issuesOf(add(who, id, { kind: 'email', value: 'Shared@example.test' }))).toEqual([
      {
        path: '/value',
        code: 'taken',
        message: 'Another contact has this email address.',
        existing: { id: other, name: 'Jordan', trashed: false },
      },
    ]);
    expect((await read(who, id)).addresses).toEqual([]);
    expect(await updates(t)).toHaveLength(2);
  });

  it('goes to whoever claimed it first when two contacts are given one address at once', async () => {
    const { t, who, id } = await fixture();
    const other = await contactOf(t, 'Jordan');
    // The other contact's claim is written and not yet committed; this contact's waits for
    // it at the unique index, and is answered once it commits.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written = (): void => undefined;
    const claimed = new Promise<void>((resolve) => {
      written = resolve;
    });
    const first = database.as('crm_owner', async (sql) => {
      await sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
         values ($1, $2, 'phone', '+254700000001', '+254700000001')`,
        [t.businessId, parsePublicId('contact', other)],
      );
      written();
      await held;
    });
    await claimed;
    const second = add(who, id, { kind: 'phone', value: '+254700000001' });
    await waitingForLock(database);
    release();
    await first;
    expect(await issuesOf(second)).toEqual([
      expect.objectContaining({
        path: '/value',
        code: 'taken',
        existing: expect.objectContaining({ id: other }) as unknown,
      }),
    ]);
    expect((await read(who, id)).addresses).toEqual([]);
  });
});

describe('a label', () => {
  it('is for a phone number, once for a contact, and can be changed and cleared', async () => {
    const { who, id } = await fixture();
    await add(who, id, { kind: 'email', value: 'maya@example.test' });
    await add(who, id, { kind: 'phone', value: '+254712345001', label: 'mobile' });
    let details = await add(who, id, { kind: 'phone', value: '+254712345002' });
    const [email, mobile, plain] = [
      found(details, 'maya@example.test'),
      found(details, '+254712345001'),
      found(details, '+254712345002'),
    ];
    const revision = () => ({ revision: details.addressesRevision });

    expect(
      await issuesOf(add(who, id, { kind: 'phone', value: '+254712345003', label: 'mobile' })),
    ).toEqual([expect.objectContaining({ path: '/label', code: 'label_taken' })]);
    expect(await issuesOf(change(who, id, plain, { label: 'mobile', ...revision() }))).toEqual([
      expect.objectContaining({ path: '/label', code: 'label_taken' }),
    ]);
    expect(await issuesOf(change(who, id, email, { label: 'work', ...revision() }))).toEqual([
      expect.objectContaining({ path: '/label', code: 'label_not_for_email' }),
    ]);
    details = await change(who, id, plain, { label: 'work', ...revision() });
    expect(found(details, plain.value).label).toBe('work');
    // The same label again changes nothing, and says nothing.
    const same = await change(who, id, plain, { label: 'work', ...revision() });
    expect(same.addressesRevision).toBe(details.addressesRevision);
    details = await change(who, id, mobile, { label: null, ...revision() });
    details = await change(who, id, plain, { label: 'mobile', ...revision() });
    expect(details.addresses.map((each) => each.label)).toEqual([null, null, 'mobile']);
  });

  it('stays on a number when the contact command replaces the list around it', async () => {
    const { who, id } = await fixture();
    await add(who, id, { kind: 'phone', value: '+254712345001', label: 'home' });
    await add(who, id, { kind: 'phone', value: '+254712345002', label: 'work' });
    // The list as a form or an import sends it: one kept, one dropped, one new, a new first.
    await runCommand(
      services,
      updateContactCommand,
      { id, phones: ['+254712345003', '+254712345002'] },
      who,
    );
    const details = await read(who, id);
    expect(details.addresses.map((each) => [each.value, each.label, each.primary])).toEqual([
      ['+254712345003', null, true],
      ['+254712345002', 'work', false],
    ]);
  });
});

describe('the primary address', () => {
  it('is whichever is made it, one of each kind, and is what the contact shows first', async () => {
    const { t, who, id } = await fixture();
    await add(who, id, { kind: 'email', value: 'first@example.test' });
    const before = await add(who, id, { kind: 'email', value: 'second@example.test' });
    const after = await change(who, id, found(before, 'second@example.test'), {
      primary: true,
      revision: before.addressesRevision,
    });
    expect(values(after)).toEqual(['second@example.test *', 'first@example.test']);
    const contact = await withTenant(db, who.context, (trx) => readContact(trx, who, id));
    expect(contact.emails).toEqual(['second@example.test', 'first@example.test']);
    // Making the primary the primary changes nothing.
    await change(who, id, found(after, 'second@example.test'), {
      primary: true,
      revision: after.addressesRevision,
    });
    expect(await updates(t)).toHaveLength(3);
  });

  it('passes to the oldest other one when it is removed', async () => {
    const { who, id } = await fixture();
    await add(who, id, { kind: 'phone', value: '+254712345001' });
    await add(who, id, { kind: 'phone', value: '+254712345002' });
    const before = await add(who, id, { kind: 'phone', value: '+254712345003' });
    const after = await remove(who, id, found(before, '+254712345001'), before.addressesRevision);
    expect(values(after)).toEqual(['+254712345002 *', '+254712345003']);
    const last = await remove(who, id, found(after, '+254712345003'), after.addressesRevision);
    expect(values(last)).toEqual(['+254712345002 *']);
  });
});

describe('a change to an address', () => {
  it('is refused when based on addresses someone else has since changed', async () => {
    const { who, id } = await fixture();
    await add(who, id, { kind: 'phone', value: '+254712345001' });
    const opened = await add(who, id, { kind: 'phone', value: '+254712345002' });
    const second = found(opened, '+254712345002');
    await change(who, id, second, { label: 'work', revision: opened.addressesRevision });
    for (const refused of await failures([
      change(who, id, second, { primary: true, revision: opened.addressesRevision }),
      remove(who, id, second, opened.addressesRevision),
    ]))
      expect(refused).toBeInstanceOf(ConflictError);
    expect(values(await read(who, id))).toEqual(['+254712345001 *', '+254712345002']);
  });

  it('is made by exactly one of two people who change the same addresses at once', async () => {
    const { t, who, id } = await fixture();
    await add(who, id, { kind: 'phone', value: '+254712345001' });
    const opened = await add(who, id, { kind: 'phone', value: '+254712345002' });
    // Someone holds the contact's row; both changes wait for it, then run one after the other.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = database.as('crm_owner', async (sql) => {
      await sql.query('select 1 from crm.contacts where business_id = $1 and id = $2 for update', [
        t.businessId,
        parsePublicId('contact', id),
      ]);
      locked();
      await held;
    });
    await holding;
    // Whichever runs first, the other was based on addresses that have since changed.
    const second = found(opened, '+254712345002');
    const attempts = [
      change(who, id, second, { primary: true, revision: opened.addressesRevision }),
      change(who, id, second, { label: 'work', revision: opened.addressesRevision }),
    ];
    await waitingForLock(database, 2);
    release();
    await holder;
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((each) => each.status === 'fulfilled')).toHaveLength(1);
    const [lost] = settled.flatMap((each) =>
      each.status === 'rejected' ? [each.reason as unknown] : [],
    );
    expect(lost).toBeInstanceOf(ConflictError);
  });

  it("can't leave a contact with nothing to know it by", async () => {
    const t = await team(database);
    const who = (await t.member()).as();
    const nameless = toPublicId(
      'contact',
      (
        await database.as('crm_owner', (sql) =>
          sql.one<{ id: string }>(
            `with record as (
               insert into crm.records (business_id, kind, object_type_id)
               select $1, 'contact', id from crm.object_types where business_id = $1 and kind = 'contact'
               returning id)
             insert into crm.contacts (business_id, id, created_by_kind)
             select $1, id, 'system' from record returning id`,
            [t.businessId],
          ),
        )
      ).id,
    );
    await add(who, nameless, { kind: 'email', value: 'only@example.test' });
    const two = await add(who, nameless, { kind: 'phone', value: '+254712345001' });
    const one = await remove(who, nameless, found(two, '+254712345001'), two.addressesRevision);
    expect(
      await issuesOf(remove(who, nameless, found(one, 'only@example.test'), one.addressesRevision)),
    ).toEqual([expect.objectContaining({ path: '', code: 'contact_empty' })]);
    expect(values(await read(who, nameless))).toEqual(['only@example.test *']);
  });
});

describe('who can change an address', () => {
  it("can't reach another business's contact, or another contact's address", async () => {
    const { t, who, id } = await fixture();
    // This contact has an address of its own, which no other contact's id may stand for.
    await add(who, id, { kind: 'email', value: 'mine@example.test' });
    const elsewhere = await fixture();
    const theirs = await add(elsewhere.who, elsewhere.id, {
      kind: 'email',
      value: 'b@example.test',
    });
    const [address] = theirs.addresses;
    if (address === undefined) throw new Error('No address.');
    const revision = theirs.addressesRevision;
    for (const refused of await failures([
      add(who, elsewhere.id, { kind: 'email', value: 'a@example.test' }),
      change(who, elsewhere.id, address, { primary: true, revision }),
      remove(who, elsewhere.id, address, revision),
      // Their address under a contact of one's own is not that contact's.
      remove(who, id, address, revision),
    ]))
      expect(refused).toBeInstanceOf(NotFoundError);
    // A neighbour's address in the same business is not this contact's either.
    const neighbour = await contactOf(t, 'Jordan');
    const near = await add(who, neighbour, { kind: 'email', value: 'near@example.test' });
    const mine = await read(who, id);
    expect(
      await failure(remove(who, id, found(near, 'near@example.test'), mine.addressesRevision)),
    ).toBeInstanceOf(NotFoundError);
    expect(values(await read(who, neighbour))).toEqual(['near@example.test *']);
    expect(values(await read(who, id))).toEqual(['mine@example.test *']);
    expect(values(await read(elsewhere.who, elsewhere.id))).toEqual(['b@example.test *']);
  });

  it('needs contacts.manage, and a contact that is not in the trash', async () => {
    const { t, who, id } = await fixture();
    const details = await add(who, id, { kind: 'email', value: 'maya@example.test' });
    const [address] = details.addresses;
    if (address === undefined) throw new Error('No address.');
    const viewer = { ...who, permissions: new Set<never>() };
    const attempts = (as: Invocation) => [
      add(as, id, { kind: 'email', value: 'more@example.test' }),
      change(as, id, address, { primary: true, revision: details.addressesRevision }),
      remove(as, id, address, details.addressesRevision),
    ];
    for (const refused of await failures(attempts(viewer))) {
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect((refused as ForbiddenError).permission).toBe('contacts.manage');
    }
    await database.as('crm_owner', (sql) =>
      sql.query('update crm.contacts set deleted_at = now() where business_id = $1', [
        t.businessId,
      ]),
    );
    for (const refused of await failures(attempts(who)))
      expect(refused).toBeInstanceOf(ConflictError);
    expect(values(await read(who, id))).toEqual(['maya@example.test *']);
  });
});

describe('whether an address can be sent to', () => {
  it('is shown when the server can tell, and left out when it cannot', async () => {
    const { who, id } = await fixture();
    await add(who, id, { kind: 'email', value: 'bounced@example.test' });
    const plain = await add(who, id, { kind: 'email', value: 'fine@example.test' });
    expect(plain.addresses.every((each) => each.delivery === undefined)).toBe(true);
    const since = new Date('2026-10-07T09:30:00.000Z');
    const telling = contactDetailRoutes({
      ...detailOptions(),
      blockedAddresses: () =>
        Promise.resolve([
          { kind: 'email', value: 'bounced@example.test', reason: 'hard_bounce', since },
          // A number written like the address is not the address.
          { kind: 'phone', value: 'fine@example.test', reason: 'invalid', since },
        ]),
    });
    const told = await call('getContactDetails', who, { id }, undefined, telling);
    expect(told.addresses.map((each) => each.delivery)).toEqual([
      { status: 'blocked', reason: 'hard_bounce', since: since.toISOString() },
      { status: 'unchecked', reason: null, since: null },
    ]);
  });
});
