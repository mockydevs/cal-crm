// The Filters panel's conditions on the contact list and its count, against a migrated
// Postgres as crm_app under row-level security, through the routes the server registers.
// The budget at 100,000 contacts is list.budget.test.ts.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  contactCount,
  contactList,
  fieldDefinition,
  recordFields,
  type ContactFilterCondition,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, team, type Member, type Team } from '../../test/contact-details.js';
import { seedContacts } from '../../test/contacts.js';
import { createCrmRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const routes = createCrmRoutes({}, detailOptions());

function route(operationId: string) {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`Missing ${operationId}`);
  return found;
}

/** A condition as a test writes it: sent as JSON, so checked by the server, not the compiler. */
interface Condition {
  readonly field: string;
  readonly operator: ContactFilterCondition['operator'];
  readonly value?: string;
  readonly values?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly days?: number;
}
interface Filter {
  readonly match: 'all' | 'any';
  readonly groups: readonly {
    readonly match: 'all' | 'any';
    readonly conditions: readonly Condition[];
  }[];
}
const all = (...conditions: Condition[]): Filter => ({
  match: 'all',
  groups: [{ match: 'all', conditions }],
});

/** Harbor Lights: five contacts and one in the trash, each different in what a filter asks. */
interface World {
  readonly t: Team;
  readonly dana: Member;
  readonly lee: Member;
  readonly tags: Readonly<Record<'vip' | 'newsletter' | 'unused', string>>;
  readonly fields: Readonly<Record<'city' | 'score' | 'renewal' | 'signed' | 'plan', string>>;
}
let world: World;

const owner = (run: string, values: readonly unknown[] = []) =>
  database.as('crm_owner', (sql) => sql.query<Record<string, string>>(run, [...values]));

async function person(
  t: Team,
  body: Record<string, unknown>,
  set: Record<string, unknown> = {},
): Promise<string> {
  const made = (await route('createContact').run(
    { invocation: t.system(), params: {}, query: {}, body },
    services,
  )) as { id: string };
  const id = parsePublicId('contact', made.id);
  for (const [column, value] of Object.entries(set))
    await owner(`update crm.contacts set ${column} = $2 where id = $1`, [id, value]);
  return made.id;
}

async function tag(t: Team, name: string): Promise<string> {
  const [row] = await owner(
    `insert into crm.tags (business_id, name, created_by_kind) values ($1, $2, 'system') returning id`,
    [t.businessId, name],
  );
  return toPublicId('tag', row?.['id'] ?? '');
}

const tagged = (t: Team, contact: string, tagId: string) =>
  owner(
    `insert into crm.record_tags (business_id, record_id, tag_id, source_kind)
     values ($1, $2, $3, 'system')`,
    [t.businessId, parsePublicId('contact', contact), parsePublicId('tag', tagId)],
  );

async function field(t: Team, key: string, valueType: string, options: string[] = []) {
  const made = fieldDefinition.parse(
    await route('createField').run(
      {
        invocation: t.system(),
        params: {},
        query: {},
        body: {
          objectKey: 'contact',
          key,
          label: key,
          description: 'What it means.',
          valueType,
          options: options.map((option) => ({
            key: option,
            label: option,
            description: '',
            archived: false,
          })),
          currency: null,
          aiFillSources: [],
          aiOverwrite: 'ask',
          archived: false,
          ...(valueType === 'file' ? { files: { formats: ['pdf'], limit: 1 } } : {}),
        },
      },
      services,
    ),
  );
  return made.id;
}

async function value(t: Team, contact: string, fieldId: string, to: unknown): Promise<void> {
  const invocation = t.system();
  const before = recordFields.parse(
    await route('getRecordFields').run(
      { invocation, params: { id: contact }, query: {}, body: undefined },
      services,
    ),
  );
  const revision = before.items.find((item) => item.definition.id === fieldId)?.revision;
  await route('setRecordField').run(
    { invocation, params: { id: contact, fieldId }, query: {}, body: { value: to, revision } },
    services,
  );
}

async function company(t: Team, contact: string, name: string): Promise<void> {
  await owner(
    `insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
                                 label, reverse_label, allows_primary)
     select $1, 'contact_company', origin.id, target.id, 'Company', 'Person', true
     from crm.object_types origin, crm.object_types target
     where origin.business_id = $1 and origin.kind = 'contact'
       and target.business_id = $1 and target.kind = 'company'
       and not exists (select 1 from crm.link_types
                       where business_id = $1 and key = 'contact_company')`,
    [t.businessId],
  );
  await owner(
    `with made as (
       insert into crm.records (business_id, kind, object_type_id)
       select $1, 'company', id from crm.object_types where business_id = $1 and kind = 'company'
       returning id
     ), named as (
       insert into crm.companies (business_id, id, name, created_by_kind)
       select $1, id, $3, 'system' from made
     )
     insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id,
                                   is_primary, source_kind)
     select $1, link.id, $2, made.id, true, 'system'
     from made, crm.link_types link
     where link.business_id = $1 and link.key = 'contact_company'`,
    [t.businessId, parsePublicId('contact', contact), name],
  );
}

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };

  const t = await team(database);
  // A business in Kenya: its numbers are written in national form, 0712 345678.
  await owner(`update tenancy.businesses set address = '{"country":"KE"}' where id = $1`, [
    t.businessId,
  ]);
  const dana = await t.member('Dana Brooks');
  const lee = await t.member('Lee Park');
  const tags = {
    vip: await tag(t, 'VIP'),
    newsletter: await tag(t, 'Newsletter'),
    unused: await tag(t, 'Unused'),
  };
  const fields = {
    city: await field(t, 'city', 'text'),
    score: await field(t, 'score', 'number'),
    renewal: await field(t, 'renewal', 'date'),
    signed: await field(t, 'signed', 'boolean'),
    plan: await field(t, 'plan', 'single_choice', ['gold', 'silver']),
  };
  const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  const ada = await person(
    t,
    {
      firstName: 'Ada',
      lastName: 'Lovelace',
      emails: ['ada@example.com', 'countess@lovelace.example'],
      phones: ['+254712000001'],
    },
    {
      owner_user_id: dana.userId,
      created_at: days(100),
      date_of_birth: '1990-04-23',
      source: 'Trade fair',
      contact_type: 'customer',
      do_not_contact: true,
      timezone: 'Africa/Nairobi',
      created_source: 'import',
    },
  );
  const grace = await person(
    t,
    { firstName: 'Grace', lastName: 'Hopper', emails: ['grace@navy.example'] },
    {
      owner_user_id: lee.userId,
      created_at: days(20),
      contact_type: 'lead',
      dnd_channels: '{email}',
      source: 'Referral',
      created_source: 'form',
    },
  );
  const alan = await person(
    t,
    {
      firstName: 'Alan',
      lastName: 'Turing',
      emails: ['alan@example.com'],
      phones: ['+254712000003'],
    },
    { created_at: days(5), timezone: 'Europe/London', date_of_birth: today },
  );
  const unnamed = await person(t, { emails: ['nobody@example.com'] }, { created_at: days(1) });
  const katherine = await person(
    t,
    { firstName: 'Katherine', lastName: 'Johnson', phones: ['+254733000005'] },
    { owner_user_id: dana.userId, created_at: days(40) },
  );
  const gone = await person(t, { firstName: 'Trashed', lastName: 'Person' }, {});
  await tagged(t, ada, tags.vip);
  await tagged(t, ada, tags.newsletter);
  await tagged(t, grace, tags.vip);
  await tagged(t, unnamed, tags.newsletter);
  await tagged(t, gone, tags.vip);
  await company(t, ada, 'Analytical Engines');
  await company(t, grace, 'Navy Yard');
  await value(t, ada, fields.city, 'Nairobi');
  await value(t, grace, fields.city, 'Mombasa');
  await value(t, ada, fields.score, '80');
  await value(t, grace, fields.score, '55.5');
  await value(t, katherine, fields.score, '10');
  await value(t, ada, fields.renewal, '2026-01-10');
  await value(t, alan, fields.renewal, soon);
  await value(t, ada, fields.signed, true);
  await value(t, grace, fields.signed, false);
  await value(t, ada, fields.plan, 'gold');
  await value(t, grace, fields.plan, 'silver');
  await owner(`update crm.contacts set deleted_at = now() where id = $1`, [
    parsePublicId('contact', gone),
  ]);
  world = { t, dana, lee, tags, fields };
}, 180_000);

afterAll(async () => {
  await db.destroy();
  await database.close();
});

const EVERYONE = [
  'Ada Lovelace',
  'Alan Turing',
  'Grace Hopper',
  'Katherine Johnson',
  'nobody@example.com',
];

/**
 * Who a filter keeps, by name (or email, for the unnamed), in alphabetical order. Every
 * call also proves the count agrees with the list.
 */
async function kept(
  filter: Filter,
  query: Record<string, string> = {},
  invocation: Invocation = world.t.system(),
): Promise<string[]> {
  const parameters = { ...query, filter: JSON.stringify(filter) };
  const page = contactList.parse(
    await route('listContacts').run(
      { invocation, params: {}, query: parameters, body: undefined },
      services,
    ),
  );
  const count = contactCount.parse(
    await route('countContacts').run(
      { invocation, params: {}, query: parameters, body: undefined },
      services,
    ),
  );
  expect(page.next).toBeNull();
  expect(count).toEqual({ count: page.items.length, exact: true });
  return page.items.map((item) => item.name ?? item.email ?? '').sort();
}

const without = (...names: string[]) => EVERYONE.filter((name) => !names.includes(name));

describe('a text condition', () => {
  it.for([
    [{ field: 'firstName', operator: 'is', value: ' ADA ' }, ['Ada Lovelace']],
    [{ field: 'firstName', operator: 'is_not', value: 'ada' }, without('Ada Lovelace')],
    [{ field: 'lastName', operator: 'contains', value: 'OP' }, ['Grace Hopper']],
    [
      { field: 'lastName', operator: 'not_contains', value: 'o' },
      ['Alan Turing', 'nobody@example.com'],
    ],
    [
      { field: 'name', operator: 'any_of', values: ['alan turing', 'Grace Hopper', 'Nobody'] },
      ['Alan Turing', 'Grace Hopper'],
    ],
    [
      { field: 'name', operator: 'none_of', values: ['alan turing', 'grace hopper'] },
      without('Alan Turing', 'Grace Hopper'),
    ],
    [{ field: 'name', operator: 'is_empty' }, ['nobody@example.com']],
    [{ field: 'name', operator: 'is_not_empty' }, without('nobody@example.com')],
    [{ field: 'timezone', operator: 'is', value: 'europe/london' }, ['Alan Turing']],
    [{ field: 'source', operator: 'contains', value: 'fair' }, ['Ada Lovelace']],
    [{ field: 'source', operator: 'is_empty' }, without('Ada Lovelace', 'Grace Hopper')],
  ] as const)('%o', async ([condition, expected]) => {
    expect(await kept(all(condition))).toEqual(expected);
  });

  it('takes a percent sign and an underscore as the characters they are', async () => {
    expect(await kept(all({ field: 'name', operator: 'contains', value: '%' }))).toEqual([]);
    expect(await kept(all({ field: 'name', operator: 'contains', value: 'a_a' }))).toEqual([]);
  });
});

describe('a condition on an address or the company', () => {
  it.for([
    // Any of a contact's addresses counts, not only the primary.
    [{ field: 'email', operator: 'is', value: 'Countess@Lovelace.example' }, ['Ada Lovelace']],
    [
      { field: 'email', operator: 'contains', value: '@example.com' },
      ['Ada Lovelace', 'Alan Turing', 'nobody@example.com'],
    ],
    // "Is not" holds when no address is it, so a contact with none passes too.
    [{ field: 'email', operator: 'is_not', value: 'ada@example.com' }, without('Ada Lovelace')],
    [
      { field: 'email', operator: 'not_contains', value: 'example.com' },
      ['Grace Hopper', 'Katherine Johnson'],
    ],
    [
      { field: 'email', operator: 'any_of', values: ['alan@example.com', 'grace@navy.example'] },
      ['Alan Turing', 'Grace Hopper'],
    ],
    [
      { field: 'email', operator: 'none_of', values: ['alan@example.com', 'grace@navy.example'] },
      without('Alan Turing', 'Grace Hopper'),
    ],
    [{ field: 'email', operator: 'is_empty' }, ['Katherine Johnson']],
    [{ field: 'email', operator: 'is_not_empty' }, without('Katherine Johnson')],
    // A number as people write it, in national form with its trunk zero.
    [{ field: 'phone', operator: 'is', value: '0712 000 001' }, ['Ada Lovelace']],
    [{ field: 'phone', operator: 'contains', value: '71200' }, ['Ada Lovelace', 'Alan Turing']],
    [{ field: 'phone', operator: 'is_not', value: '+254 712 000001' }, without('Ada Lovelace')],
    // "Is" is the whole number, never a part of one (contacts-data #11).
    [{ field: 'phone', operator: 'is', value: '+254 712 000 002' }, []],
    [
      { field: 'phone', operator: 'any_of', values: ['0712 000 001', '+254712000003'] },
      ['Ada Lovelace', 'Alan Turing'],
    ],
    [{ field: 'phone', operator: 'none_of', values: ['0712 000 001'] }, without('Ada Lovelace')],
    [{ field: 'phone', operator: 'is_empty' }, ['Grace Hopper', 'nobody@example.com']],
    [{ field: 'company', operator: 'contains', value: 'engines' }, ['Ada Lovelace']],
    [{ field: 'company', operator: 'is', value: 'navy yard' }, ['Grace Hopper']],
    [{ field: 'company', operator: 'is_empty' }, without('Ada Lovelace', 'Grace Hopper')],
    [{ field: 'company', operator: 'is_not', value: 'Navy Yard' }, without('Grace Hopper')],
  ] as const)('%o', async ([condition, expected]) => {
    expect(await kept(all(condition))).toEqual(expected);
  });
});

describe('a date condition', () => {
  it('refuses unsupported empty and future creation-time operators at the public boundary', async () => {
    for (const operator of ['is_empty', 'is_not_empty', 'in_next'] as const)
      await expect(
        kept(all({ field: 'created', operator, ...(operator === 'in_next' ? { days: 7 } : {}) })),
      ).rejects.toThrow(ValidationError);
  });

  it('distinguishes known birthdays, recent birthdays and birthdays outside the recent interval', async () => {
    expect(await kept(all({ field: 'dateOfBirth', operator: 'is_not_empty' }))).toEqual([
      'Ada Lovelace',
      'Alan Turing',
    ]);
    expect(await kept(all({ field: 'dateOfBirth', operator: 'in_last', days: 7 }))).toEqual([
      'Alan Turing',
    ]);
    expect(await kept(all({ field: 'dateOfBirth', operator: 'not_in_last', days: 7 }))).toEqual([
      'Ada Lovelace',
    ]);
    expect(await kept(all({ field: 'dateOfBirth', operator: 'in_next', days: 7 }))).toEqual([]);
  });
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  it('compares when a contact was added with a moment, a range and a number of days', async () => {
    const created = (rest: Omit<Condition, 'field'>) => kept(all({ field: 'created', ...rest }));
    expect(await created({ operator: 'in_last', days: 7 })).toEqual([
      'Alan Turing',
      'nobody@example.com',
    ]);
    expect(await created({ operator: 'in_last', days: 30 })).toEqual(
      without('Ada Lovelace', 'Katherine Johnson'),
    );
    expect(await created({ operator: 'not_in_last', days: 30 })).toEqual([
      'Ada Lovelace',
      'Katherine Johnson',
    ]);
    expect(await created({ operator: 'before', value: ago(30) })).toEqual([
      'Ada Lovelace',
      'Katherine Johnson',
    ]);
    expect(await created({ operator: 'after', value: ago(30) })).toEqual(
      without('Ada Lovelace', 'Katherine Johnson'),
    );
    expect(await created({ operator: 'between', from: ago(50), to: ago(10) })).toEqual([
      'Grace Hopper',
      'Katherine Johnson',
    ]);
  });

  it('orders by the last change the same way', async () => {
    expect(await kept(all({ field: 'updated', operator: 'in_last', days: 1 }))).toEqual(EVERYONE);
    expect(await kept(all({ field: 'updated', operator: 'not_in_last', days: 1 }))).toEqual([]);
  });

  it('compares a date of birth as a calendar day', async () => {
    const born = (rest: Omit<Condition, 'field'>) => kept(all({ field: 'dateOfBirth', ...rest }));
    expect(await born({ operator: 'is', value: '1990-04-23' })).toEqual(['Ada Lovelace']);
    expect(await born({ operator: 'is_not', value: '1990-04-23' })).toEqual(
      without('Ada Lovelace'),
    );
    expect(await born({ operator: 'before', value: '1990-04-24' })).toEqual(['Ada Lovelace']);
    expect(await born({ operator: 'after', value: '1990-04-23' })).toEqual(['Alan Turing']);
    expect(await born({ operator: 'between', from: '1990-04-23', to: '1990-04-23' })).toEqual([
      'Ada Lovelace',
    ]);
    expect(await born({ operator: 'in_last', days: 1 })).toEqual(['Alan Turing']);
    expect(await born({ operator: 'not_in_last', days: 1 })).toEqual(['Ada Lovelace']);
    expect(await born({ operator: 'is_empty' })).toEqual(without('Ada Lovelace', 'Alan Turing'));
    expect(await born({ operator: 'is_not_empty' })).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('a condition on tags, the owner and the switches', () => {
  it('keeps contacts by their tags, by id', async () => {
    const { vip, newsletter, unused } = world.tags;
    const tags = (rest: Omit<Condition, 'field'>) => kept(all({ field: 'tags', ...rest }));
    expect(await tags({ operator: 'any_of', values: [vip, unused] })).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    expect(await tags({ operator: 'all_of', values: [vip, newsletter] })).toEqual(['Ada Lovelace']);
    expect(await tags({ operator: 'none_of', values: [vip] })).toEqual(
      without('Ada Lovelace', 'Grace Hopper'),
    );
    expect(await tags({ operator: 'any_of', values: [unused] })).toEqual([]);
    expect(await tags({ operator: 'is_empty' })).toEqual(['Alan Turing', 'Katherine Johnson']);
    expect(await tags({ operator: 'is_not_empty' })).toEqual(
      without('Alan Turing', 'Katherine Johnson'),
    );
  });

  it('keeps contacts by their owner, named by membership or as me', async () => {
    const { dana, lee } = world;
    const owned = (rest: Omit<Condition, 'field'>, invocation?: Invocation) =>
      kept(all({ field: 'owner', ...rest }), {}, invocation);
    expect(await owned({ operator: 'any_of', values: [dana.membershipId] })).toEqual([
      'Ada Lovelace',
      'Katherine Johnson',
    ]);
    expect(await owned({ operator: 'any_of', values: ['me'] }, lee.as())).toEqual(['Grace Hopper']);
    expect(
      await owned({ operator: 'any_of', values: [dana.membershipId, lee.membershipId] }),
    ).toEqual(without('Alan Turing', 'nobody@example.com'));
    expect(await owned({ operator: 'none_of', values: [dana.membershipId] })).toEqual(
      without('Ada Lovelace', 'Katherine Johnson'),
    );
    expect(await owned({ operator: 'is_empty' })).toEqual(['Alan Turing', 'nobody@example.com']);
    expect(await owned({ operator: 'is_not_empty' })).toEqual(
      without('Alan Turing', 'nobody@example.com'),
    );
  });

  it.for([
    [{ field: 'dnd', operator: 'enabled', value: 'all' }, ['Ada Lovelace']],
    [{ field: 'dnd', operator: 'disabled', value: 'all' }, without('Ada Lovelace')],
    [{ field: 'dnd', operator: 'enabled', value: 'email' }, ['Grace Hopper']],
    [{ field: 'dnd', operator: 'disabled', value: 'email' }, without('Grace Hopper')],
    [{ field: 'dnd', operator: 'enabled', value: 'sms' }, []],
    [{ field: 'type', operator: 'any_of', values: ['lead'] }, ['Grace Hopper']],
    [{ field: 'type', operator: 'none_of', values: ['lead'] }, without('Grace Hopper')],
    [{ field: 'type', operator: 'is_empty' }, without('Ada Lovelace', 'Grace Hopper')],
    [{ field: 'type', operator: 'is_not_empty' }, ['Ada Lovelace', 'Grace Hopper']],
    [
      { field: 'createdSource', operator: 'any_of', values: ['import', 'form'] },
      ['Ada Lovelace', 'Grace Hopper'],
    ],
    [{ field: 'createdSource', operator: 'none_of', values: ['import'] }, without('Ada Lovelace')],
  ] as const)('%o', async ([condition, expected]) => {
    expect(await kept(all(condition))).toEqual(expected);
  });
});

describe('a condition on a custom field', () => {
  it('filters text box lists and file fields only by whether they hold a value', async () => {
    const boxes = await field(world.t, 'references', 'text_list', ['home']);
    const documents = await field(world.t, 'documents', 'file');
    const [ada] = await owner(
      'select id from crm.contacts where business_id = $1 and first_name = $2',
      [world.t.businessId, 'Ada'],
    );
    if (ada === undefined) throw new Error('The fixture has no Ada.');
    await value(world.t, toPublicId('contact', ada['id'] ?? ''), boxes, { home: 'Desk' });
    expect(await kept(all({ field: boxes, operator: 'is_not_empty' }))).toEqual(['Ada Lovelace']);
    expect(await kept(all({ field: boxes, operator: 'is_empty' }))).toEqual(
      without('Ada Lovelace'),
    );
    expect(await kept(all({ field: documents, operator: 'is_empty' }))).toEqual(EVERYONE);
    expect(await kept(all({ field: documents, operator: 'is_not_empty' }))).toEqual([]);
    await expect(kept(all({ field: boxes, operator: 'contains', value: 'Desk' }))).rejects.toThrow(
      ValidationError,
    );
  });

  it('compares a custom date-time field by its stored instant', async () => {
    const signedAt = await field(world.t, 'signed_at', 'datetime');
    const [ada] = await owner(
      'select id from crm.contacts where business_id = $1 and first_name = $2',
      [world.t.businessId, 'Ada'],
    );
    if (ada === undefined) throw new Error('The fixture has no Ada.');
    await value(
      world.t,
      toPublicId('contact', ada['id'] ?? ''),
      signedAt,
      '2026-01-10T09:00:00+03:00',
    );
    expect(
      await kept(all({ field: signedAt, operator: 'before', value: '2026-01-10T06:01:00Z' })),
    ).toEqual(['Ada Lovelace']);
    expect(
      await kept(all({ field: signedAt, operator: 'after', value: '2026-01-10T06:01:00Z' })),
    ).toEqual([]);
  });
  it('compares text, numbers, dates, yes or no and choices by the field’s type', async () => {
    const { city, score, renewal, signed, plan } = world.fields;
    const on = (field: string, rest: Omit<Condition, 'field'>) => kept(all({ field, ...rest }));
    expect(await on(city, { operator: 'is', value: 'nairobi' })).toEqual(['Ada Lovelace']);
    expect(await on(city, { operator: 'contains', value: 'OMB' })).toEqual(['Grace Hopper']);
    expect(await on(city, { operator: 'is_not', value: 'Nairobi' })).toEqual(
      without('Ada Lovelace'),
    );
    expect(await on(city, { operator: 'any_of', values: ['Nairobi', 'Mombasa'] })).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    expect(await on(city, { operator: 'is_empty' })).toEqual(
      without('Ada Lovelace', 'Grace Hopper'),
    );
    expect(await on(city, { operator: 'is_not_empty' })).toEqual(['Ada Lovelace', 'Grace Hopper']);

    expect(await on(score, { operator: 'is', value: '55.5' })).toEqual(['Grace Hopper']);
    expect(await on(score, { operator: 'is_not', value: '55.5' })).toEqual(without('Grace Hopper'));
    expect(await on(score, { operator: 'gt', value: '55.5' })).toEqual(['Ada Lovelace']);
    expect(await on(score, { operator: 'gte', value: '55.5' })).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    expect(await on(score, { operator: 'lt', value: '55.5' })).toEqual(['Katherine Johnson']);
    expect(await on(score, { operator: 'lte', value: '55.5' })).toEqual([
      'Grace Hopper',
      'Katherine Johnson',
    ]);
    expect(await on(score, { operator: 'between', from: '10', to: '55.5' })).toEqual([
      'Grace Hopper',
      'Katherine Johnson',
    ]);

    expect(await on(renewal, { operator: 'before', value: '2026-01-11' })).toEqual([
      'Ada Lovelace',
    ]);
    expect(await on(renewal, { operator: 'in_next', days: 7 })).toEqual(['Alan Turing']);
    expect(await on(renewal, { operator: 'is_not', value: '2026-01-10' })).toEqual(
      without('Ada Lovelace'),
    );

    expect(await on(signed, { operator: 'is', value: 'true' })).toEqual(['Ada Lovelace']);
    expect(await on(signed, { operator: 'is', value: 'false' })).toEqual(['Grace Hopper']);
    expect(await on(signed, { operator: 'is_empty' })).toEqual(
      without('Ada Lovelace', 'Grace Hopper'),
    );

    expect(await on(plan, { operator: 'any_of', values: ['gold', 'silver'] })).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    expect(await on(plan, { operator: 'none_of', values: ['gold'] })).toEqual(
      without('Ada Lovelace'),
    );
  });
});

describe('groups of conditions', () => {
  const vip = (): Condition => ({ field: 'tags', operator: 'any_of', values: [world.tags.vip] });
  const recent: Condition = { field: 'created', operator: 'in_last', days: 30 };
  const turing: Condition = { field: 'lastName', operator: 'is', value: 'Turing' };

  it('hold together or one at a time, inside a group and between groups', async () => {
    expect(
      await kept({ match: 'all', groups: [{ match: 'all', conditions: [vip(), recent] }] }),
    ).toEqual(['Grace Hopper']);
    expect(
      await kept({ match: 'all', groups: [{ match: 'any', conditions: [vip(), turing] }] }),
    ).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
    // (VIP or Turing) and added in the last 30 days.
    expect(
      await kept({
        match: 'all',
        groups: [
          { match: 'any', conditions: [vip(), turing] },
          { match: 'all', conditions: [recent] },
        ],
      }),
    ).toEqual(['Alan Turing', 'Grace Hopper']);
    // (VIP and added in the last 30 days) or Turing.
    expect(
      await kept({
        match: 'any',
        groups: [
          { match: 'all', conditions: [vip(), recent] },
          { match: 'all', conditions: [turing] },
        ],
      }),
    ).toEqual(['Alan Turing', 'Grace Hopper']);
  });

  it('narrow further with the search and the older filters', async () => {
    expect(await kept(all(vip()), { q: 'grace' })).toEqual(['Grace Hopper']);
    expect(await kept(all(vip()), { q: 'nobody-here' })).toEqual([]);
    expect(
      await kept(all(vip()), { createdFrom: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
    ).toEqual(['Grace Hopper']);
    expect(
      await kept(all(vip()), {
        fieldId: world.fields.city,
        fieldOperator: 'equals',
        fieldValue: 'Nairobi',
      }),
    ).toEqual(['Ada Lovelace']);
  });

  it('never keep a contact in the trash, or of another business', async () => {
    // The trashed contact has the VIP tag and is not listed.
    expect(await kept(all(vip()))).toEqual(['Ada Lovelace', 'Grace Hopper']);
    const other = await team(database);
    await person(other, { firstName: 'Ada', lastName: 'Elsewhere' });
    expect(await kept(all({ field: 'firstName', operator: 'is', value: 'Ada' }))).toEqual([
      'Ada Lovelace',
    ]);
    expect(
      await kept(all({ field: 'firstName', operator: 'is', value: 'Ada' }), {}, other.system()),
    ).toEqual(['Ada Elsewhere']);
  });
});

describe('a filter that names what the business does not have', () => {
  const issues = async (filter: unknown, invocation = world.t.system()) => {
    const failed: unknown[] = [];
    for (const operationId of ['listContacts', 'countContacts']) {
      try {
        await route(operationId).run(
          {
            invocation,
            params: {},
            query: { filter: typeof filter === 'string' ? filter : JSON.stringify(filter) },
            body: undefined,
          },
          services,
        );
        failed.push(null);
      } catch (error) {
        failed.push(error instanceof ValidationError ? error.issues : error);
      }
    }
    // The list and the count refuse it in the same words.
    expect(failed[0]).toEqual(failed[1]);
    return failed[0];
  };
  const at = (member: string) => `/filter/groups/0/conditions/0/${member}`;

  it('is refused with a pointer to the condition, and nothing is listed', async () => {
    const other = await team(database);
    const theirTag = await tag(other, 'Theirs');
    const theirField = await field(other, 'theirs', 'text');
    const outsider = await other.member('Out Sider');

    expect(
      await issues(all({ field: 'tags', operator: 'any_of', values: [theirTag] })),
    ).toMatchObject([{ path: at('values/0'), code: 'unknown_tag' }]);
    expect(
      await issues(all({ field: 'tags', operator: 'any_of', values: ['not-a-tag'] })),
    ).toMatchObject([{ path: at('values/0'), code: 'unknown_tag' }]);
    expect(await issues(all({ field: theirField, operator: 'is', value: 'x' }))).toMatchObject([
      { path: at('field'), code: 'unknown_field' },
    ]);
    expect(
      await issues(all({ field: 'owner', operator: 'any_of', values: [outsider.membershipId] })),
    ).toMatchObject([{ path: at('values/0'), code: 'unavailable_member' }]);
    expect(
      await issues(all({ field: 'type', operator: 'any_of', values: ['vendor'] })),
    ).toMatchObject([{ path: at('values/0'), code: 'unknown_choice' }]);
    expect(
      await issues(all({ field: world.fields.plan, operator: 'any_of', values: ['platinum'] })),
    ).toMatchObject([{ path: at('values/0'), code: 'unknown_choice' }]);
  });

  it('is refused when an operator or a value does not fit the field', async () => {
    const { city, score, signed } = world.fields;
    expect(await issues(all({ field: score, operator: 'contains', value: '5' }))).toMatchObject([
      { path: at('operator'), code: 'invalid_operator' },
    ]);
    expect(await issues(all({ field: city, operator: 'gt', value: '5' }))).toMatchObject([
      { path: at('operator'), code: 'invalid_operator' },
    ]);
    expect(await issues(all({ field: score, operator: 'gt', value: 'many' }))).toMatchObject([
      { path: at('value'), code: 'invalid_number' },
    ]);
    expect(await issues(all({ field: signed, operator: 'is', value: 'maybe' }))).toMatchObject([
      { path: at('value'), code: 'invalid_boolean' },
    ]);
    expect(
      await issues(all({ field: 'created', operator: 'before', value: 'yesterday' })),
    ).toMatchObject([{ path: at('value'), code: 'invalid_timestamp' }]);
    expect(
      await issues(all({ field: 'dateOfBirth', operator: 'is', value: '2026-02-30' })),
    ).toMatchObject([{ path: at('value'), code: 'invalid_date' }]);
    // A phone "is" that is no whole number is refused, never read as "contains".
    expect(await issues(all({ field: 'phone', operator: 'is', value: '1' }))).toMatchObject([
      { path: at('value'), code: 'phone_invalid' },
    ]);
    expect(
      await issues(all({ field: 'phone', operator: 'any_of', values: ['+254712000001', 'x'] })),
    ).toMatchObject([{ path: at('values/1'), code: 'phone_invalid' }]);
    // Every bad condition is named, not only the first.
    expect(
      await issues({
        match: 'any',
        groups: [
          { match: 'all', conditions: [{ field: 'firstName', operator: 'is', value: 'Ada' }] },
          {
            match: 'all',
            conditions: [
              { field: 'created', operator: 'before', value: 'x' },
              { field: 'type', operator: 'any_of', values: ['vendor'] },
            ],
          },
        ],
      }),
    ).toMatchObject([
      { path: '/filter/groups/1/conditions/0/value' },
      { path: '/filter/groups/1/conditions/1/values/0' },
    ]);
  });

  it('is refused by its form before anything is read', async () => {
    expect(await issues('{not json')).toMatchObject([{ path: '/filter', code: 'invalid_json' }]);
    expect(await issues({ match: 'all', groups: [] })).toMatchObject([{ path: '/filter/groups' }]);
    expect(await issues(all({ field: 'shoeSize', operator: 'is', value: '9' }))).toMatchObject([
      { path: at('field'), code: 'unknown_field' },
    ]);
    expect(await issues(all({ field: 'created', operator: 'contains', value: 'x' }))).toMatchObject(
      [{ path: at('operator'), code: 'invalid_operator' }],
    );
    expect(await issues(all({ field: 'firstName', operator: 'is' }))).toMatchObject([
      { path: at('value'), code: 'required' },
    ]);
    expect(await issues(all({ field: 'dnd', operator: 'enabled', value: 'fax' }))).toMatchObject([
      { path: at('value'), code: 'invalid_channel' },
    ]);
  });

  it('cannot be filtered by owner where nobody says who is on the team', async () => {
    const bare = createCrmRoutes().find((each) => each.endpoint.operationId === 'listContacts');
    const attempt = bare?.run(
      {
        invocation: world.t.system(),
        params: {},
        query: {
          filter: JSON.stringify(
            all({ field: 'owner', operator: 'any_of', values: [world.dana.membershipId] }),
          ),
        },
        body: undefined,
      },
      services,
    );
    await expect(attempt).rejects.toMatchObject({
      issues: [{ path: at('field'), code: 'unavailable_field' }],
    });
  });
});

describe('a filter over many contacts', () => {
  it('pages a common match to its end, and reads a rare one whole, each agreeing with the count', async () => {
    const t = await team(database);
    await seedContacts(database, t.businessId, 1100);
    const invocation = t.system();
    const pages = async (filter: Filter) => {
      const query: Record<string, string> = { filter: JSON.stringify(filter), limit: '100' };
      const ids: string[] = [];
      let after: string | null = null;
      do {
        const page = contactList.parse(
          await route('listContacts').run(
            {
              invocation,
              params: {},
              query: after === null ? query : { ...query, after },
              body: undefined,
            },
            services,
          ),
        );
        ids.push(...page.items.map((item) => item.id));
        after = page.next;
      } while (after !== null);
      const count = contactCount.parse(
        await route('countContacts').run(
          { invocation, params: {}, query: { filter: query['filter'] ?? '' }, body: undefined },
          services,
        ),
      );
      expect(new Set(ids).size).toBe(ids.length);
      expect(count).toEqual({ count: ids.length, exact: true });
      return ids.length;
    };
    // More than a thousand match: the list walks its order, testing each contact.
    expect(await pages(all({ field: 'firstName', operator: 'contains', value: 'first' }))).toBe(
      1100,
    );
    // Eleven match (First1 and First10 to First19… by name): read by their ids.
    expect(await pages(all({ field: 'lastName', operator: 'contains', value: 'last109' }))).toBe(
      11,
    );
    expect(await pages(all({ field: 'lastName', operator: 'is', value: 'nobody' }))).toBe(0);
  });
});
