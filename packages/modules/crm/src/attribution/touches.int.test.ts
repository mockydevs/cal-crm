// Attribution against a migrated Postgres, as crm_app under row-level security: every
// contact gets a first touch when it is made, an interaction that made it fills that touch
// in, a later one becomes the latest, and the first never changes.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  contactAttributions,
  contactSources,
  createContactInput,
  publicVisit,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId, type ActorKind } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { sessionSourceCases } from '../../test/session-source-cases.js';
import { createContact } from '../contacts/contacts.js';
import { contactDetailRoutes } from '../contacts/detail-routes.js';
import { intakeContact } from '../contacts/intake.js';
import { readVisit, sessionSourceOf } from './session-source.js';
import { createTagRoute } from '../tags/routes.js';
import { recordBookingTouch } from './booking-touch.js';
import { readContactAttribution, recordTouch } from './touches.js';

let database: TestDatabase;
let db: Database;
let services: Services;
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

async function business(): Promise<{ id: string; as: (actorKind: ActorKind) => Invocation }> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return {
    id: created.id,
    as: (actorKind) => ({
      context: { ...created.context, actorKind, correlationId: randomUUID() },
      permissions: 'all',
    }),
  };
}

const touchesOf = (contactId: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{
      medium: string;
      session_source: string;
      utm_source: string | null;
      gclid: string | null;
      referrer_domain: string | null;
      landing_url: string | null;
      subject_kind: string;
      is_first: boolean;
      is_latest: boolean;
    }>(
      `select medium, session_source, utm_source, gclid, referrer_domain, landing_url,
              subject_kind, is_first, is_latest
       from crm.contact_attributions where contact_id = $1 order by touched_at, id`,
      [contactId],
    ),
  );

// As the modules that make contacts call it: with the way it came to be, and, for a form,
// the visit it was sent from, in the same transaction.
const made = defineCommand({
  name: 'test.contact.attributed',
  permission: 'contacts.manage',
  input: z.strictObject({
    source: z.enum(contactSources).optional(),
    email: z.string().optional(),
    visit: publicVisit.optional(),
  }),
  async handle(trx, input, command): Promise<string> {
    const contact = createContactInput.parse({
      firstName: 'Maya',
      emails: [input.email ?? `${randomUUID()}@example.test`],
    });
    const { contactId } = await intakeContact(trx, contact, command, input.source);
    if (input.visit !== undefined)
      await recordTouch(trx, command.context.businessId ?? '', {
        contactId,
        medium: 'form',
        visit: readVisit(input.visit),
        subject: { kind: 'form_submission', id: contactId },
      });
    return contactId;
  },
});

it('gives every new contact a first touch that says how it came to be', async () => {
  const { as } = await business();
  for (const [actorKind, source, medium, sessionSource] of [
    ['user', undefined, 'manual', 'crm_ui'],
    ['api_key', undefined, 'api', 'third_party'],
    ['import', undefined, 'import', 'third_party'],
    ['automation', undefined, 'automation', 'third_party'],
    ['system', 'email', 'message', 'others'],
    ['system', 'sms', 'message', 'others'],
    ['system', undefined, 'unknown', 'others'],
    ['contact', 'webchat', 'chat', 'direct'],
    ['contact', 'booking', 'calendar', 'direct'],
    ['form', undefined, 'form', 'direct'],
  ] as const) {
    const id = await runCommand(services, made, { source }, as(actorKind));
    expect(await touchesOf(id), `${actorKind} ${String(source)}`).toEqual([
      {
        medium,
        session_source: sessionSource,
        utm_source: null,
        gclid: null,
        referrer_domain: null,
        landing_url: null,
        subject_kind: 'contact',
        is_first: true,
        is_latest: true,
      },
    ]);
  }
});

it('fills the first touch in when the interaction that made the contact knows the visit', async () => {
  const { as } = await business();
  const id = await runCommand(
    services,
    made,
    {
      visit: {
        pageUrl: 'https://www.example.com/contact?utm_source=adwords&gclid=abc',
        referrer: 'https://www.google.com/',
      },
    },
    as('form'),
  );
  // One touch, not two: the form's visit is the contact's first.
  expect(await touchesOf(id)).toEqual([
    {
      medium: 'form',
      session_source: 'paid_search',
      utm_source: 'adwords',
      gclid: 'abc',
      referrer_domain: 'www.google.com',
      landing_url: 'https://www.example.com/contact',
      subject_kind: 'form_submission',
      is_first: true,
      is_latest: true,
    },
  ]);
});

it('adds a later interaction as the latest touch, and never changes the first', async () => {
  const { as } = await business();
  const email = `${randomUUID()}@example.test`;
  const id = await runCommand(
    services,
    made,
    { email, visit: { pageUrl: 'https://www.example.com/?utm_source=fb_ad' } },
    as('form'),
  );
  // The same person sends a form again, from a search this time, and then once more.
  for (const referrer of ['https://www.bing.com/', 'https://partner.example/'])
    expect(
      await runCommand(
        services,
        made,
        { email, visit: { pageUrl: 'https://www.example.com/', referrer } },
        as('form'),
      ),
    ).toBe(id);
  expect(
    (await touchesOf(id)).map((touch) => [touch.session_source, touch.is_first, touch.is_latest]),
  ).toEqual([
    ['paid_social', true, false],
    ['organic_search', false, false],
    ['referral', false, true],
  ]);

  const read = contactAttributions.parse(
    await withTenant(db, as('user').context, (trx) =>
      readContactAttribution(trx, as('user'), toPublicId('contact', id)),
    ),
  );
  expect(read.first).toMatchObject({
    sessionSource: 'paid_social',
    utmSource: 'fb_ad',
    medium: 'form',
  });
  expect(read.latest).toMatchObject({
    sessionSource: 'referral',
    referrerDomain: 'partner.example',
  });
});

it('records a booking’s visit, and the first touch of a contact from before touches were kept', async () => {
  const { as } = await business();
  // A contact with no touch at all, as one made before the migration's backfill would be.
  const old = await database.fixtures.contact(as('user').context, { firstName: 'Old' });
  const booked = defineCommand({
    name: 'test.contact.booked',
    permission: 'contacts.manage',
    input: z.strictObject({ contactId: z.string(), visit: publicVisit.optional() }),
    handle: (trx, input, command) =>
      recordBookingTouch(trx, { ...input, appointmentId: randomUUID() }, command),
  });
  await runCommand(
    services,
    booked,
    { contactId: old.id, visit: { pageUrl: 'https://book.example.com/?utm_source=linkedin_ad' } },
    as('contact'),
  );
  expect(await touchesOf(old.id)).toMatchObject([
    {
      medium: 'calendar',
      session_source: 'paid_social',
      subject_kind: 'appointment',
      is_first: true,
      is_latest: true,
    },
  ]);
  // A page that says nothing of the visit still records the booking: direct.
  await runCommand(services, booked, { contactId: old.id }, as('contact'));
  expect((await touchesOf(old.id)).map((touch) => [touch.session_source, touch.is_latest])).toEqual(
    [
      ['paid_social', false],
      ['direct', true],
    ],
  );
  // A contact that is not this business's records nothing, and nothing fails.
  const elsewhere = await business();
  const theirs = await database.fixtures.contact(elsewhere.as('user').context);
  await runCommand(services, booked, { contactId: theirs.id }, as('contact'));
  expect(await touchesOf(theirs.id)).toEqual([]);
});

it('serves a contact’s first and latest touch, and refuses a contact that is not there', async () => {
  const { as } = await business();
  const [route] = contactDetailRoutes({
    actorNames: {},
    assignees: {
      resolve: () => Promise.resolve(null),
      memberships: () => Promise.resolve(new Map()),
    },
  }).filter(({ endpoint }) => endpoint.operationId === 'getContactAttribution');
  const read = (id: string, invocation = as('user')) =>
    route?.run({ invocation, params: { id }, query: {}, body: undefined }, services);

  const created = await runCommand(services, made, {}, as('user'));
  const answer = contactAttributions.parse(await read(toPublicId('contact', created)));
  expect(answer.first).toMatchObject({ medium: 'manual', sessionSource: 'crm_ui', clickIds: [] });
  expect(answer.latest).toEqual(answer.first);

  // One with no touch recorded has neither.
  const bare = await database.fixtures.contact(as('user').context);
  expect(await read(toPublicId('contact', bare.id))).toEqual({ first: null, latest: null });

  const elsewhere = await business();
  await expect(read(toPublicId('contact', created), elsewhere.as('user'))).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(
    withTenant(db, as('user').context, (trx) =>
      readContactAttribution(trx, as('user'), 'con_nope'),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('decides every session source as the table says', () => {
  for (const { name, medium, pageUrl, referrer, expected } of sessionSourceCases)
    expect(sessionSourceOf(medium, readVisit({ pageUrl, referrer })), name).toBe(expected);
});

it('never makes a contact through createContact without its touch', async () => {
  const { as } = await business();
  const direct = defineCommand({
    name: 'test.contact.direct',
    permission: 'contacts.manage',
    input: z.strictObject({}),
    async handle(trx, _input, command): Promise<string> {
      const contact = await createContact(
        trx,
        createContactInput.parse({ firstName: 'Direct' }),
        command,
      );
      return parsePublicId('contact', contact.id) ?? '';
    },
  });
  const id = await runCommand(services, direct, {}, as('user'));
  expect(await touchesOf(id)).toHaveLength(1);
});

it('names a booking and a chat by the business’s own rules, and adds the rules’ tags', async () => {
  const { id: businessId, as } = await business();
  const tag = z
    .object({ id: z.string() })
    .parse(
      await createTagRoute.run(
        { invocation: as('user'), params: {}, query: {}, body: { name: 'Booked online' } },
        services,
      ),
    );
  const [rule] = await database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      `insert into crm.lead_source_rules
         (business_id, position, name, conditions, source_label, tag_ids, created_by_kind)
       values
         ($1, 1, 'Bookings', '[{"fact":"medium","op":"is","value":"calendar"}]',
          'Online booking', $2::uuid[], 'user'),
         ($1, 2, 'Chats', '[{"fact":"medium","op":"is","value":"chat"}]', 'Web chat', '{}', 'user')
       returning id`,
      [businessId, [parsePublicId('tag', tag.id)]],
    ),
  );
  const namedAs = (contactId: string) =>
    database.as('crm_owner', (sql) =>
      sql.query<{ medium: string; label: string | null; rule: string | null; tags: string[] }>(
        `select a.medium, a.source_label as label, a.source_rule as rule,
                coalesce((select array_agg(t.name order by t.name)
                          from crm.record_tags rt
                          join crm.tags t on t.business_id = rt.business_id and t.id = rt.tag_id
                          where rt.record_id = a.contact_id), '{}') as tags
         from crm.contact_attributions a where a.contact_id = $1 and a.is_latest`,
        [contactId],
      ),
    );
  const booked = defineCommand({
    name: 'test.contact.booked_by_rule',
    permission: 'contacts.manage',
    input: z.strictObject({ contactId: z.string(), visit: publicVisit.optional() }),
    handle: (trx, input, command) =>
      recordBookingTouch(trx, { ...input, appointmentId: randomUUID() }, command),
  });
  const chatted = defineCommand({
    name: 'test.contact.chatted_by_rule',
    permission: 'contacts.manage',
    input: z.strictObject({ contactId: z.string() }),
    handle: async (trx, input, command) =>
      (
        await recordTouch(trx, command.context.businessId ?? '', {
          contactId: input.contactId,
          medium: 'chat',
          visit: readVisit({}),
          subject: { kind: 'webchat_session', id: randomUUID() },
        })
      )?.label,
  });

  // A booking from a Google ad: the business's rule names it, before the built-in one, and
  // its tag is added. What decided it is the rule, by its public id.
  const booker = await database.fixtures.contact(as('user').context);
  await runCommand(
    services,
    booked,
    { contactId: booker.id, visit: { pageUrl: 'https://book.example.com/?gclid=abc' } },
    as('contact'),
  );
  expect(await namedAs(booker.id)).toEqual([
    {
      medium: 'calendar',
      label: 'Online booking',
      rule: toPublicId('lead_source_rule', rule?.id ?? ''),
      tags: ['Booked online'],
    },
  ]);
  // A chat is asked the same rules, and matches its own.
  const chatter = await database.fixtures.contact(as('user').context);
  expect(await runCommand(services, chatted, { contactId: chatter.id }, as('contact'))).toBe(
    'Web chat',
  );
  expect(await namedAs(chatter.id)).toMatchObject([
    { medium: 'chat', label: 'Web chat', tags: [] },
  ]);
  // Another business has no such rule: its booking is named by the built-in ones.
  const elsewhere = await business();
  const theirs = await database.fixtures.contact(elsewhere.as('user').context);
  await runCommand(
    services,
    booked,
    { contactId: theirs.id, visit: { pageUrl: 'https://book.example.com/?gclid=abc' } },
    elsewhere.as('contact'),
  );
  expect(await namedAs(theirs.id)).toEqual([
    { medium: 'calendar', label: 'Google Ads', rule: 'google_ads', tags: [] },
  ]);
});
