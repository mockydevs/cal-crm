// The duplicate finder against a migrated Postgres: the database's match keys, Manage
// Duplicates' groups by email, phone and name, Reject, a contact's possible duplicates, the
// lookup, and the fill of keys for addresses stored before keys existed.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  company,
  duplicateGroupList,
  duplicateSettings,
  duplicateLookup,
  possibleDuplicates,
  type DuplicateFindMode,
} from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import {
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { crmRoutes } from '../index.js';
import { contactDuplicateRoutes } from './duplicate-routes.js';
import { seedContacts } from '../../test/contacts.js';
import { fillMatchKeysTask, MATCH_KEY_BATCH } from './duplicates.js';
import { updateDuplicateSettingsCommand } from './duplicate-settings.js';

let database: TestDatabase;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  services = {
    db: connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    }),
    authorize: allowEveryone,
  };
});
afterAll(async () => {
  await services.db.destroy();
  await database.close();
});

interface Space {
  readonly businessId: string;
  readonly owner: Invocation;
  readonly member: Invocation;
}

/** A business with company links, its owner, and a member with a member's daily work. */
async function space(): Promise<Space> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  await database.withTenant(business.context, (sql) =>
    sql.query(
      `insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
         label, reverse_label, allows_primary)
       select app.business_id(), 'contact_company', c.id, o.id, 'Company', 'Person', true
       from crm.object_types c cross join crm.object_types o
       where c.kind = 'contact' and o.kind = 'company'`,
    ),
  );
  const context = { ...business.context, actorKind: 'user' as const, correlationId: randomUUID() };
  return {
    businessId: business.id,
    owner: { context, permissions: 'all' },
    member: { context, permissions: new Set(['contacts.manage']) },
  };
}

/** A contact with these addresses, written as an import would write them. */
async function person(
  where: Space,
  name: string,
  addresses: { emails?: readonly string[]; phones?: readonly string[] } = {},
): Promise<string> {
  const [first, ...rest] = name.split(' ');
  const contact = await database.fixtures.contact(where.owner.context, {
    firstName: first ?? name,
    ...(rest.length === 0 ? {} : { lastName: rest.join(' ') }),
  });
  const identities = [
    ...(addresses.emails ?? []).map((value) => ['email', value] as const),
    ...(addresses.phones ?? []).map((value) => ['phone', value] as const),
  ];
  for (const [kind, value] of identities)
    await database.withTenant(where.owner.context, (sql) =>
      sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
         values (app.business_id(), $1, $2, $3, $3)`,
        [contact.id, kind, value],
      ),
    );
  return toPublicId('contact', contact.id);
}

async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
) {
  const route = [...contactDuplicateRoutes, ...crmRoutes].find(
    (each) => each.endpoint.operationId === operationId,
  );
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run(
    { invocation, params: request.params ?? {}, query: request.query ?? {}, body: request.body },
    services,
  );
}

const groups = async (where: Space, by: DuplicateFindMode, query: Record<string, unknown> = {}) =>
  duplicateGroupList.parse(
    await call('listDuplicateGroups', where.owner, { query: { by, ...query } }),
  );

/** Each group as its key and its contacts' ids. */
const shape = (list: {
  items: readonly { valueKey: string; contacts: readonly { id: string }[] }[];
}) => list.items.map((group) => [group.valueKey, group.contacts.map((each) => each.id)]);

const trash = (where: Space, id: string) => call('trashContact', where.owner, { params: { id } });

describe('the match key the database keeps', () => {
  it.each([
    ['email', 'jane.doe@gmail.com', 'janedoe@gmail.com'],
    ['email', 'janedoe+news@gmail.com', 'janedoe@gmail.com'],
    ['email', 'j.a.n.e.d.o.e+a+b@googlemail.com', 'janedoe@gmail.com'],
    ['email', 'jane.doe+news@work.example', 'jane.doe@work.example'],
    ['email', 'jane.doe@work.example', 'jane.doe@work.example'],
    ['email', '+only@work.example', '+only@work.example'],
    ['email', '...@gmail.com', '...@gmail.com'],
    ['phone', '+254712345678', '4712345678'],
    ['phone', '+12125550142', '2125550142'],
    ['phone', '+2125550142', '2125550142'],
    ['phone', '+4420123', '4420123'],
    ['whatsapp', '+254712345678', null],
  ])('keys %s %s as %s', async (kind, value, key) => {
    const { key: stored } = await database.as('crm_owner', (sql) =>
      sql.one<{ key: string | null }>('select private.contact_match_key($1, $2) as key', [
        kind,
        value,
      ]),
    );
    expect(stored).toBe(key);
  });
});

describe('Manage Duplicates by email', () => {
  it('puts together the addresses one Gmail inbox receives: dots, +tags and googlemail.com', async () => {
    const where = await space();
    const a = await person(where, 'Jane Doe', { emails: ['jane.doe@gmail.com'] });
    const b = await person(where, 'Jane Doe', { emails: ['janedoe+news@googlemail.com'] });
    const c = await person(where, 'J Doe', { emails: ['j.a.n.e.doe@gmail.com'] });
    await person(where, 'Jane Other', { emails: ['jane.doe@outlook.example'] });

    const page = await groups(where, 'email');

    expect(shape(page)).toEqual([['janedoe@gmail.com', [a, b, c]]]);
    expect(page.items[0]).toMatchObject({ by: 'email', reasons: ['email'], weak: false, total: 3 });
    expect(page.items[0]?.contacts[1]).toMatchObject({
      name: 'Jane Doe',
      emails: ['janedoe+news@googlemail.com'],
      phones: [],
    });
    expect(page.next).toBeNull();
  });

  it('puts a +tag on another domain with the address before it, as a weaker sign, and keeps dots there', async () => {
    const where = await space();
    const a = await person(where, 'Sam Lee', { emails: ['sam@work.example'] });
    const b = await person(where, 'Sam Lee', { emails: ['sam+crm@work.example'] });
    await person(where, 'Al Bee', { emails: ['a.b@work.example'] });
    await person(where, 'Al Bee', { emails: ['ab@work.example'] });

    const page = await groups(where, 'email');

    expect(shape(page)).toEqual([['sam@work.example', [a, b]]]);
    expect(page.items[0]?.weak).toBe(true);
  });

  it('pages in key order, each group once', async () => {
    const where = await space();
    for (const local of ['ann', 'bob', 'cat'])
      for (const tag of ['', '+x'])
        await person(where, `${local} person`, { emails: [`${local}${tag}@work.example`] });

    const first = await groups(where, 'email', { limit: 2 });
    expect(first.items.map((group) => group.valueKey)).toEqual([
      'ann@work.example',
      'bob@work.example',
    ]);
    expect(first.next).not.toBeNull();
    const second = await groups(where, 'email', { limit: 2, cursor: first.next });
    expect(second.items.map((group) => group.valueKey)).toEqual(['cat@work.example']);
    expect(second.next).toBeNull();
    await expect(groups(where, 'email', { cursor: '!!' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('leaves out a contact in the trash, and a group that is then one contact', async () => {
    const where = await space();
    const a = await person(where, 'Ann One', { emails: ['ann@gmail.com'] });
    const b = await person(where, 'Ann One', { emails: ['a.n.n@gmail.com'] });
    const c = await person(where, 'Ann One', { emails: ['ann+1@gmail.com'] });
    await trash(where, b);
    expect(shape(await groups(where, 'email'))).toEqual([['ann@gmail.com', [a, c]]]);
    await trash(where, c);
    expect((await groups(where, 'email')).items).toEqual([]);
  });

  it("never shows another business's contacts", async () => {
    const mine = await space();
    const theirs = await space();
    await person(mine, 'Jane Doe', { emails: ['jane.doe@gmail.com'] });
    await person(theirs, 'Jane Doe', { emails: ['janedoe@gmail.com'] });
    await person(theirs, 'Jane Doe', { emails: ['jane.doe+x@gmail.com'] });

    expect((await groups(mine, 'email')).items).toEqual([]);
    expect((await groups(theirs, 'email')).items).toHaveLength(1);
  });
});

describe('Manage Duplicates by phone', () => {
  it('puts together numbers whose last ten digits agree, weaker when the names differ', async () => {
    const where = await space();
    const a = await person(where, 'Maya Chen', { phones: ['+12125550142'] });
    const b = await person(where, 'Maya Chen', { phones: ['+2125550142'] });
    const c = await person(where, 'Ken Wu', { phones: ['+254712345678'] });
    const d = await person(where, 'Ken Woo', { phones: ['+44712345678'] });
    await person(where, 'Ken Wu', { phones: ['+1712345678'] });

    const page = await groups(where, 'phone');

    // +1 712 345678 ends in 1712345678: nine digits alike are not ten.
    expect(shape(page)).toEqual([
      ['2125550142', [a, b]],
      ['4712345678', [c, d]],
    ]);
    expect(page.items.map(({ reasons, weak }) => ({ reasons, weak }))).toEqual([
      { reasons: ['phone'], weak: false },
      { reasons: ['phone'], weak: true },
    ]);
  });
});

describe('Manage Duplicates by name', () => {
  async function companyFor(where: Space, name: string, ...contactIds: string[]) {
    const saved = company.parse(await call('createCompany', where.owner, { body: { name } }));
    for (const id of contactIds)
      await call('linkContactCompany', where.owner, {
        params: { id, companyId: saved.id },
        body: {},
      });
  }

  it('pairs names alike only where a second sign agrees, and says which', async () => {
    const where = await space();
    const kate = await person(where, 'Katherine Johnson', { emails: ['kate@one.example'] });
    const kath = await person(where, 'Katharine Johnson', { emails: ['kj@two.example'] });
    await companyFor(where, 'Johnson Studio', kate, kath);
    const maria = await person(where, 'Maria Garcia', { emails: ['maria.g+x@one.example'] });
    const mari = await person(where, 'Maria Garcia', { emails: ['maria.g@two.example'] });
    const tom = await person(where, 'Tom Baker', { phones: ['+12125550199'] });
    const tim = await person(where, 'Tom Baker', { phones: ['+2125550199'] });
    // Alike, and nothing else in common: two people, as far as anyone can tell.
    await person(where, 'Alex Turner', { emails: ['alex@one.example'] });
    await person(where, 'Alex Turner', { emails: ['turner@two.example'] });
    const { alike } = await database.as('crm_owner', (sql) =>
      sql.one<{ alike: number }>(
        `select similarity('Katherine Johnson', 'Katharine Johnson') as alike`,
      ),
    );
    expect(alike).toBeGreaterThan(0.6);

    const page = await groups(where, 'name');

    expect(shape(page)).toEqual([
      ['katherine johnson', [kate, kath]],
      ['maria garcia', [maria, mari]],
      ['tom baker', [tom, tim]],
    ]);
    expect(page.items.map((group) => group.reasons)).toEqual([
      ['name', 'company'],
      ['name', 'email_name'],
      ['name', 'phone'],
    ]);
    expect(page.items.every((group) => !group.weak)).toBe(true);
    expect(page.next).toBeNull();
  });

  it('finds a pair a second sign backs behind more namesakes than a group lists', async () => {
    const where = await space();
    const john = await person(where, 'John Smith', { emails: ['john.smith@one.example'] });
    // Twenty-five later John Smiths who share nothing with him.
    for (let n = 0; n < 25; n++)
      await person(where, 'John Smith', { emails: [`other${String(n)}@elsewhere.example`] });
    const twin = await person(where, 'John Smith', { emails: ['johnsmith@two.example'] });

    const page = await groups(where, 'name');

    expect(shape(page)).toEqual([['john smith', [john, twin]]]);
    expect(page.items[0]?.reasons).toEqual(['name', 'email_name']);
  });

  it('looks names up through the trigram index', async () => {
    const where = await space();
    await seedContacts(database, where.businessId, 30_000);
    const jane = await person(where, 'Jane Doe', { emails: ['jane@one.example'] });
    // The function's own body, planned with its arguments as parameters, as it runs.
    const plan = await database.as('postgres', async (sql) => {
      const { body } = await sql.one<{ body: string }>(
        `select prosrc as body from pg_proc where proname = 'similar_contact_names'`,
      );
      const query = body
        .replaceAll('p_contact_ids', '$1::uuid[]')
        .replaceAll('p_later_only', '$2::boolean')
        .replaceAll('p_per_contact', '$3::integer');
      await sql.query(`select set_config('app.business_id', $1, true)`, [where.businessId]);
      await sql.query(`select set_config('pg_trgm.similarity_threshold', '0.6', true)`);
      const rows = await sql.query<{ 'QUERY PLAN': string }>(`explain ${query}`, [
        [parsePublicId('contact', jane)],
        false,
        25,
      ]);
      return rows.map((row) => row['QUERY PLAN']).join(' ');
    });
    expect(plan, plan).toContain('contacts_display_name_trgm_idx');
  });

  it('pages a name group at a time', async () => {
    const where = await space();
    await person(where, 'Ann Lake', { emails: ['ann@one.example'] });
    await person(where, 'Ann Lake', { emails: ['ann@two.example'] });
    await person(where, 'Bo Hill', { emails: ['bo@one.example'] });
    await person(where, 'Bo Hill', { emails: ['bo@two.example'] });

    const first = await groups(where, 'name', { limit: 1 });
    expect(first.items.map((group) => group.valueKey)).toEqual(['ann lake']);
    const second = await groups(where, 'name', { limit: 1, cursor: first.next });
    expect(second.items.map((group) => group.valueKey)).toEqual(['bo hill']);
    const third = await groups(where, 'name', { limit: 1, cursor: second.next });
    expect(third).toEqual({ items: [], next: null });
  });

  // private.similar_contact_names reads as its owner, past row-level security, so it must
  // keep to the request's business itself: given another business's ids too, it pairs only
  // the request's own contacts, and with no business it refuses.
  it("compares names only in the request's business, whatever ids it is given", async () => {
    const mine = await space();
    const theirs = await space();
    const uuid = (id: string) => parsePublicId('contact', id);
    // Each pair shares an email name, the second sign the function looks for.
    const ann = uuid(await person(mine, 'Ann Lake', { emails: ['ann@one.example'] }));
    const annToo = uuid(await person(mine, 'Ann Lake', { emails: ['ann@two.example'] }));
    const theirAnn = uuid(await person(theirs, 'Ann Lake', { emails: ['ann@three.example'] }));
    const theirAnnToo = uuid(await person(theirs, 'Ann Lake', { emails: ['ann@four.example'] }));
    const pairs = (context: Space['owner']['context']) =>
      database.withTenant(context, (sql) =>
        sql.query<{ contact_id: string; similar_id: string }>(
          `select contact_id, similar_id
           from private.similar_contact_names($1::uuid[], false, 25)
           order by contact_id, similar_id`,
          [[ann, annToo, theirAnn, theirAnnToo]],
        ),
      );
    const sorted = (rows: readonly (readonly [unknown, unknown])[]) =>
      rows
        .map(([contact_id, similar_id]) => ({ contact_id, similar_id }))
        .sort((left, right) =>
          `${String(left.contact_id)}${String(left.similar_id)}` <
          `${String(right.contact_id)}${String(right.similar_id)}`
            ? -1
            : 1,
        );

    expect(await pairs(mine.owner.context)).toEqual(
      sorted([
        [ann, annToo],
        [annToo, ann],
      ]),
    );
    expect(await pairs(theirs.owner.context)).toEqual(
      sorted([
        [theirAnn, theirAnnToo],
        [theirAnnToo, theirAnn],
      ]),
    );
    await expect(
      database.as('crm_app', (sql) =>
        sql.query('select * from private.similar_contact_names($1::uuid[], false, 25)', [[ann]]),
      ),
    ).rejects.toThrow(/app.business_id is not set/);
  });
});

describe('Reject', () => {
  it('hides the group for good, until another contact joins it', async () => {
    const where = await space();
    const a = await person(where, 'Jane Doe', { emails: ['jane.doe@gmail.com'] });
    const b = await person(where, 'Jane Doe', { emails: ['janedoe@gmail.com'] });
    const reject = (contactIds: string[]) =>
      call('rejectDuplicateGroup', where.owner, {
        body: { by: 'email', valueKey: 'janedoe@gmail.com', contactIds },
      });

    await reject([b, a]);
    await reject([a, b]);
    expect((await groups(where, 'email')).items).toEqual([]);
    const { count } = await database.as('crm_owner', (sql) =>
      sql.one<{ count: string }>(
        'select count(*) from crm.duplicate_rejections where business_id = $1',
        [where.businessId],
      ),
    );
    expect(count).toBe('1');

    const c = await person(where, 'Jane Doe', { emails: ['jane.doe+x@gmail.com'] });
    expect(shape(await groups(where, 'email'))).toEqual([['janedoe@gmail.com', [a, b, c]]]);
  });

  it('hides a name group by its contacts, and keeps the email address out of the audit log', async () => {
    const where = await space();
    const a = await person(where, 'Ann Lake', { emails: ['ann@one.example'] });
    const b = await person(where, 'Ann Lake', { emails: ['ann@two.example'] });
    await call('rejectDuplicateGroup', where.owner, {
      body: { by: 'name', valueKey: 'Ann Lake', contactIds: [a, b] },
    });
    expect((await groups(where, 'name')).items).toEqual([]);
    const audit = await database.as('crm_owner', (sql) =>
      sql.query<{ input: unknown }>(
        `select input from audit.commands
         where business_id = $1 and command = 'contact_duplicates.reject'`,
        [where.businessId],
      ),
    );
    expect(audit.map((row) => row.input)).toEqual([{ by: 'name', contactIds: [a, b] }]);
  });

  it('needs contacts.merge, as seeing every group does', async () => {
    const where = await space();
    const a = await person(where, 'Jane Doe', { emails: ['jane.doe@gmail.com'] });
    const b = await person(where, 'Jane Doe', { emails: ['janedoe@gmail.com'] });
    await expect(
      call('listDuplicateGroups', where.member, { query: { by: 'email' } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      call('rejectDuplicateGroup', where.member, {
        body: { by: 'email', valueKey: 'janedoe@gmail.com', contactIds: [a, b] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await call(
        'listDuplicateGroups',
        { ...where.member, permissions: new Set(['contacts.merge']) },
        {
          query: { by: 'email' },
        },
      ),
    ).toMatchObject({ items: [{ valueKey: 'janedoe@gmail.com' }] });
  });

  it("refuses another business's contact, as not found", async () => {
    const mine = await space();
    const theirs = await space();
    const a = await person(mine, 'Jane Doe', { emails: ['jane.doe@gmail.com'] });
    const b = await person(theirs, 'Jane Doe', { emails: ['janedoe@gmail.com'] });
    await expect(
      call('rejectDuplicateGroup', mine.owner, {
        body: { by: 'email', valueKey: 'janedoe@gmail.com', contactIds: [a, b] },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Reject of a group larger than it lists', () => {
  it('rejects every contact of the group, not only the ones shown', async () => {
    const where = await space();
    const ids: string[] = [];
    for (let n = 0; n < 27; n++)
      ids.push(
        await person(where, `Sam ${String(n)}`, { emails: [`sam+${String(n)}@work.example`] }),
      );
    const [shown] = (await groups(where, 'email')).items;
    expect(shown).toMatchObject({ total: 27 });
    expect(shown?.contacts).toHaveLength(25);

    await call('rejectDuplicateGroup', where.owner, {
      body: {
        by: 'email',
        valueKey: 'sam@work.example',
        contactIds: shown?.contacts.map((each) => each.id) ?? [],
      },
    });

    expect((await groups(where, 'email')).items).toEqual([]);
  });
});

describe("a contact's possible duplicates", () => {
  it('lists the groups that hold it, for anyone who may read contacts', async () => {
    const where = await space();
    const jane = await person(where, 'Jane Doe', {
      emails: ['jane.doe@gmail.com'],
      phones: ['+12125550142'],
    });
    const twin = await person(where, 'Jane Doe', { emails: ['janedoe@gmail.com'] });
    const tail = await person(where, 'J Doe', { phones: ['+2125550142'] });
    const named = await person(where, 'Jane Doe', { emails: ['jane.doe@work.example'] });
    await person(where, 'Jane Doe', { emails: ['someone@else.example'] });

    const found = possibleDuplicates.parse(
      await call('listPossibleDuplicates', where.member, { params: { id: jane } }),
    );

    expect(found.groups.map((group) => [group.by, group.contacts.map((each) => each.id)])).toEqual([
      ['email', [jane, twin]],
      ['phone', [jane, tail]],
      ['name', [jane, twin, named].sort()],
    ]);
    expect(found.groups.at(-1)?.reasons).toEqual(['name', 'email_name']);
    expect(found.count).toBe(3);
  });

  it('leaves out what was rejected, and says nothing for a contact in the trash', async () => {
    const where = await space();
    const jane = await person(where, 'Jane Doe', { emails: ['jane.doe@gmail.com'] });
    const twin = await person(where, 'Jane Doe', { emails: ['janedoe@gmail.com'] });
    await call('rejectDuplicateGroup', where.owner, {
      body: { by: 'email', valueKey: 'janedoe@gmail.com', contactIds: [jane, twin] },
    });
    await call('rejectDuplicateGroup', where.owner, {
      body: { by: 'name', valueKey: 'jane doe', contactIds: [jane, twin] },
    });
    expect(await call('listPossibleDuplicates', where.member, { params: { id: jane } })).toEqual({
      groups: [],
      count: 0,
    });

    const other = await person(where, 'Ann Lake', { emails: ['ann@gmail.com'] });
    await person(where, 'Ann Lake', { emails: ['a.nn@gmail.com'] });
    await trash(where, other);
    expect(await call('listPossibleDuplicates', where.member, { params: { id: other } })).toEqual({
      groups: [],
      count: 0,
    });
  });

  it("is not found for another business's contact", async () => {
    const mine = await space();
    const theirs = await space();
    const id = await person(theirs, 'Jane Doe', { emails: ['jane.doe@gmail.com'] });
    await expect(
      call('listPossibleDuplicates', mine.owner, { params: { id } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the duplicate lookup', () => {
  it('finds the contact holding the email address or the phone number, in the business’s order', async () => {
    const where = await space();
    const byEmail = await person(where, 'Mail Holder', { emails: ['maya@example.com'] });
    const byPhone = await person(where, 'Phone Holder', { phones: ['+12125550142'] });
    const find = async (query: Record<string, string>) =>
      duplicateLookup.parse(await call('findDuplicateContact', where.member, { query }));
    const both = { email: 'Maya@Example.com', phone: '+1 212 555 0142' };

    expect(await find(both)).toMatchObject({ contact: { id: byEmail }, matchedBy: 'email' });
    expect(await find({ email: 'nobody@example.com', phone: both.phone })).toEqual({
      contact: null,
      matchedBy: null,
    });
    expect(await find({ phone: both.phone })).toMatchObject({
      contact: { id: byPhone, phones: ['+12125550142'], trashedAt: null },
      matchedBy: 'phone',
    });

    const { revision } = duplicateSettings.parse(await call('getDuplicateSettings', where.member));
    await runCommand(
      services,
      updateDuplicateSettingsCommand,
      { primary: 'phone', secondary: 'email', revision },
      where.owner,
    );
    expect(await find(both)).toMatchObject({ contact: { id: byPhone }, matchedBy: 'phone' });
    expect(await find({ email: both.email, phone: '+1 212 555 0199' })).toMatchObject({
      contact: { id: byEmail },
      matchedBy: 'email',
    });

    await trash(where, byPhone);
    const trashed = await find({ phone: both.phone });
    expect(trashed.contact?.id).toBe(byPhone);
    expect(trashed.contact?.trashedAt).not.toBeNull();
    await expect(find({ phone: 'not a number' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('filling the keys of addresses stored before keys existed', () => {
  it('keys every email address and phone number of the business, a batch at a time', async () => {
    const where = await space();
    const uuid = parsePublicId('contact', await person(where, 'Many Addresses'));
    const count = MATCH_KEY_BATCH + 5;
    await database.as('crm_owner', async (sql) => {
      await sql.query(
        'alter table crm.contact_identities disable trigger contact_identities_match_key',
      );
      await sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
         select $1, $2, 'email', 'p.' || n || '@gmail.com', 'p.' || n || '@gmail.com'
         from generate_series(1, $3::int) as n`,
        [where.businessId, uuid, count],
      );
      await sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
         values ($1, $2, 'phone', '+12125550142', '+12125550142'),
                ($1, $2, 'whatsapp', '+12125550142', '+12125550142')`,
        [where.businessId, uuid],
      );
      await sql.query(
        'alter table crm.contact_identities enable trigger contact_identities_match_key',
      );
    });
    const keys = () =>
      database.as('crm_owner', (sql) =>
        sql.one<{ keyed: string; unkeyed: string; whatsapp: string | null }>(
          `select count(*) filter (where match_key is not null) as keyed,
                  count(*) filter (where match_key is null and kind in ('email', 'phone')) as unkeyed,
                  max(match_key) filter (where kind = 'whatsapp') as whatsapp
           from crm.contact_identities where business_id = $1`,
          [where.businessId],
        ),
      );
    expect(await keys()).toEqual({ keyed: '0', unkeyed: String(count + 1), whatsapp: null });

    await fillMatchKeysTask.run(
      {},
      {
        invocation: {
          context: { ...where.owner.context, actorKind: 'system' },
          permissions: 'all',
        },
        services,
      },
    );

    expect(await keys()).toEqual({ keyed: String(count + 1), unkeyed: '0', whatsapp: null });
    const { key } = await database.as('crm_owner', (sql) =>
      sql.one<{ key: string }>(
        `select match_key as key from crm.contact_identities
         where business_id = $1 and value_normalized = 'p.7@gmail.com'`,
        [where.businessId],
      ),
    );
    expect(key).toBe('p7@gmail.com');
  });
});
