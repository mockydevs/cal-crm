// The lead source against a migrated Postgres, as crm_app under row-level security: every
// touch that was a visit carries its name and the rule that decided it, the contact's page
// is told which click ids are held, an opportunity's default source is read from the touch,
// and the one tag the system may make by itself can be made no other way.
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
  createContactInput,
  createTagInput,
  leadSourceKeys,
  leadSourceLabels,
  leadSources,
  leadSourceTags,
  publicVisit,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ForbiddenError, toPublicId, ValidationError, type ActorKind } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { leadSourceCases, leadSourcePage } from '../../test/lead-source-cases.js';
import { intakeContact } from '../contacts/intake.js';
import { updateContactCommand } from '../contacts/contacts.js';
import {
  ensureLeadSourceTagsCommand,
  findLeadSourceTag,
  tagLeadSource,
} from '../tags/lead-source-tags.js';
import { createTagGroupCommand } from '../tags/groups.js';
import { createTagCommand } from '../tags/tags.js';
import { recordBookingTouch } from './booking-touch.js';
import { NO_VISIT, readVisit } from './session-source.js';
import { readContactAttribution, readLeadSourceDefault, recordTouch } from './touches.js';

/** The keys a click id's value had in this answer before it was taken out of it. */
const CLICK_ID_VALUE_KEYS = [
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'ctwaClid',
  'ctwa_clid',
  'ttclid',
  'liFatId',
  'li_fat_id',
] as const;

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

const visitInput = z.strictObject({
  email: z.string(),
  visits: z.array(publicVisit),
  subjectIds: z.array(z.uuid()).optional(),
});

// A contact that sends a form once for each visit, as the forms module records it.
const visited = defineCommand({
  name: 'test.lead_source.visited',
  permission: 'contacts.manage',
  input: visitInput,
  async handle(trx, input, command): Promise<string> {
    const { contactId } = await intakeContact(
      trx,
      createContactInput.parse({ firstName: 'Maya', emails: [input.email] }),
      command,
    );
    for (const [index, visit] of input.visits.entries())
      await recordTouch(trx, command.context.businessId ?? '', {
        contactId,
        medium: 'form',
        visit: readVisit(visit),
        subject: { kind: 'form_submission', id: input.subjectIds?.[index] ?? randomUUID() },
      });
    return contactId;
  },
});

const tagged = defineCommand({
  name: 'test.lead_source.tagged',
  permission: 'contacts.manage',
  input: z.strictObject({ contactId: z.uuid(), key: z.string(), label: z.string() }),
  handle: (trx, input, command) =>
    tagLeadSource(trx, command, input.contactId, {
      // What a caller could hand over if it tried: any key, any name.
      key: input.key as (typeof leadSourceKeys)[number],
      label: input.label,
    }),
});

const sourcesOf = (contactId: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{
      medium: string;
      source_label: string | null;
      source_rule: string | null;
      session_source: string;
      page_url: string | null;
      landing_url: string | null;
    }>(
      `select medium, source_label, source_rule, session_source, page_url, landing_url
       from crm.contact_attributions where contact_id = $1 order by touched_at, id`,
      [contactId],
    ),
  );

const tagsOf = (businessId: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{
      id: string;
      name: string;
      system_key: string | null;
      group_name: string | null;
      group_key: string | null;
      created_by_kind: string;
    }>(
      `select t.id, t.name, t.system_key, g.name as group_name, g.system_key as group_key,
              t.created_by_kind
       from crm.tags t
       left join crm.tag_groups g on g.business_id = t.business_id and g.id = t.group_id
       where t.business_id = $1 order by t.name`,
      [businessId],
    ),
  );

const carried = (contactId: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ name: string; source_kind: string }>(
      `select t.name, rt.source_kind from crm.record_tags rt
       join crm.tags t on t.business_id = rt.business_id and t.id = rt.tag_id
       where rt.record_id = $1 order by t.name`,
      [contactId],
    ),
  );

describe('the touch', () => {
  it('names every visit as the table of rules says, and keeps the rule that decided', async () => {
    const { as } = await business();
    const id = await runCommand(
      services,
      visited,
      {
        email: `${randomUUID()}@example.test`,
        visits: leadSourceCases.map((each) => ({
          pageUrl: leadSourcePage(each.query ?? ''),
          ...(each.referrer === undefined ? {} : { referrer: each.referrer }),
        })),
      },
      as('form'),
    );
    const stored = await sourcesOf(id);
    expect(stored).toHaveLength(leadSourceCases.length);
    for (const [index, expected] of leadSourceCases.entries())
      expect(
        [stored[index]?.source_rule, stored[index]?.source_label],
        `${expected.name} (${expected.query ?? ''})`,
      ).toEqual([
        expected.expected,
        expected.expected === 'source_param' ? expected.label : leadSourceLabels[expected.expected],
      ]);
    // The page of the interaction is the page the visit began on, for now.
    expect(stored.every((touch) => touch.page_url === touch.landing_url)).toBe(true);
    expect(stored[0]?.page_url).toBe(leadSourcePage());
  });

  it('gives no lead source to a contact that arrived by no address', async () => {
    const { as } = await business();
    const byHand = defineCommand({
      name: 'test.lead_source.by_hand',
      permission: 'contacts.manage',
      input: z.strictObject({}),
      handle: async (trx, _input, command) =>
        (
          await intakeContact(
            trx,
            createContactInput.parse({ emails: [`${randomUUID()}@example.test`] }),
            command,
          )
        ).contactId,
    });
    for (const actor of ['user', 'api_key', 'import', 'automation'] as const) {
      const id = await runCommand(services, byHand, {}, as(actor));
      expect(await sourcesOf(id), actor).toMatchObject([{ source_label: null, source_rule: null }]);
    }
    // A form that says nothing of its page is a visit all the same: Direct.
    const form = await runCommand(services, byHand, {}, as('form'));
    expect(await sourcesOf(form)).toMatchObject([
      { medium: 'form', source_label: 'Direct', source_rule: 'direct' },
    ]);
  });

  it('names a booking’s visit and a chat’s by the same rules', async () => {
    const { id: businessId, as } = await business();
    const contact = await database.fixtures.contact(as('user').context, { firstName: 'Booker' });
    const interacted = defineCommand({
      name: 'test.lead_source.interacted',
      permission: 'contacts.manage',
      input: z.strictObject({}),
      async handle(trx, _input, command): Promise<void> {
        await recordBookingTouch(
          trx,
          {
            contactId: contact.id,
            appointmentId: randomUUID(),
            visit: { pageUrl: 'https://book.example.com/intro?utm_source=facebook&utm_medium=cpc' },
          },
          command,
        );
        // The booking page of today, which says nothing of the visit.
        await recordBookingTouch(
          trx,
          { contactId: contact.id, appointmentId: randomUUID() },
          command,
        );
        // What the web chat records: its website and nothing else.
        await recordTouch(trx, businessId, {
          contactId: contact.id,
          medium: 'chat',
          visit: { ...NO_VISIT, landingUrl: 'https://www.example.com' },
          subject: { kind: 'webchat_session', id: randomUUID() },
        });
      },
    });
    await runCommand(services, interacted, {}, as('contact'));
    expect(
      (await sourcesOf(contact.id)).map((touch) => [
        touch.medium,
        touch.source_rule,
        touch.source_label,
        touch.session_source,
      ]),
    ).toEqual([
      ['calendar', 'facebook_ads', 'Facebook Ads', 'paid_social'],
      ['calendar', 'direct', 'Direct', 'direct'],
      ['chat', 'direct', 'Direct', 'direct'],
    ]);
  });

  it('tells a contact’s page the name, the rule, the ids and which click ids are held', async () => {
    const { as } = await business();
    const id = await runCommand(
      services,
      visited,
      {
        email: `${randomUUID()}@example.test`,
        visits: [
          {
            pageUrl:
              'https://www.example.com/offer?utm_source=google&utm_medium=cpc&campaign_id=11&ad_group_id=22&ad_id=33&gclid=G1&wbraid=W1',
          },
          {
            pageUrl:
              'https://www.example.com/offer?utm_source=tiktok&utm_medium=paid&ttclid=T1&li_fat_id=L1&fbclid=F1',
          },
        ],
      },
      as('form'),
    );
    const read = contactAttributions.parse(
      await withTenant(db, as('user').context, (trx) =>
        readContactAttribution(trx, as('user'), toPublicId('contact', id)),
      ),
    );
    expect(read.first).toMatchObject({
      source: 'Google Ads',
      sourceRule: 'google_ads',
      campaignId: '11',
      adGroupId: '22',
      adId: '33',
      clickIds: ['gclid', 'wbraid'],
      pageUrl: 'https://www.example.com/offer',
    });
    expect(read.latest).toMatchObject({
      source: 'TikTok Ads',
      sourceRule: 'tiktok_ads',
      clickIds: ['fbclid', 'ttclid', 'li_fat_id'],
    });
    // Which click ids are held, and never one of them: the answer has no field for a value
    // (the schema keeps keys it does not name, so one sent by mistake would show here), and
    // no value is anywhere in it. They are still stored, for conversions later.
    for (const touch of [read.first, read.latest]) {
      for (const key of CLICK_ID_VALUE_KEYS) expect(touch, key).not.toHaveProperty(key);
    }
    for (const value of ['G1', 'W1', 'T1', 'L1', 'F1'])
      expect(JSON.stringify(read), value).not.toContain(`"${value}"`);
    const stored = await database.as('crm_owner', (sql) =>
      sql.query<{ gclid: string | null; ttclid: string | null }>(
        `select gclid, ttclid from crm.contact_attributions where contact_id = $1 order by touched_at, id`,
        [id],
      ),
    );
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        { gclid: 'G1', ttclid: null },
        { gclid: null, ttclid: 'T1' },
      ]),
    );
    // A contact added by hand: no name, and no click id.
    const byHand = await database.fixtures.contact(as('user').context);
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into crm.contact_attributions
           (business_id, contact_id, medium, session_source, subject_kind, subject_id, is_first, is_latest)
         select business_id, id, 'manual', 'crm_ui', 'contact', id, true, true
         from crm.contacts where id = $1`,
        [byHand.id],
      ),
    );
    const bare = contactAttributions.parse(
      await withTenant(db, as('user').context, (trx) =>
        readContactAttribution(trx, as('user'), toPublicId('contact', byHand.id)),
      ),
    );
    expect(bare.first).toMatchObject({ source: null, sourceRule: null, clickIds: [] });
  });
});

describe('the source a new opportunity takes when nobody names one', () => {
  it('is the lead source of the touch that started it, else the contact’s Source, else nothing', async () => {
    const { id: businessId, as } = await business();
    const [google, facebook] = [randomUUID(), randomUUID()];
    const id = await runCommand(
      services,
      visited,
      {
        email: `${randomUUID()}@example.test`,
        visits: [
          { pageUrl: 'https://www.example.com/?gclid=abc' },
          { pageUrl: 'https://www.example.com/?utm_source=facebook&utm_medium=cpc' },
        ],
        subjectIds: [google, facebook],
      },
      as('form'),
    );
    const read = (input: Parameters<typeof readLeadSourceDefault>[2]) =>
      withTenant(db, as('user').context, (trx) => readLeadSourceDefault(trx, businessId, input));
    // Each submission's own touch, whichever is the latest by now.
    expect(await read({ contactId: id, subject: { kind: 'form_submission', id: google } })).toBe(
      'Google Ads',
    );
    expect(await read({ contactId: id, subject: { kind: 'form_submission', id: facebook } })).toBe(
      'Facebook Ads',
    );
    // Nothing started it, or what started it recorded no touch: the contact's own Source.
    expect(await read({ contactId: id })).toBeNull();
    await runCommand(
      services,
      updateContactCommand,
      { id: toPublicId('contact', id), source: '  Trade fair  ' },
      as('user'),
    );
    expect(await read({ contactId: id })).toBe('Trade fair');
    expect(await read({ contactId: id, subject: { kind: 'appointment', id: randomUUID() } })).toBe(
      'Trade fair',
    );
    // Another business reads nothing of it.
    const elsewhere = await business();
    expect(
      await withTenant(db, elsewhere.as('user').context, (trx) =>
        readLeadSourceDefault(trx, elsewhere.id, {
          contactId: id,
          subject: { kind: 'form_submission', id: google },
        }),
      ),
    ).toBeNull();
  });
});

describe('the tag of a lead source', () => {
  it('is made by the system the first time, in its own group, and used again after', async () => {
    const { id: businessId, as } = await business();
    const one = await database.fixtures.contact(as('user').context, { firstName: 'One' });
    const two = await database.fixtures.contact(as('user').context, { firstName: 'Two' });
    const google = { key: 'google_ads', label: 'Google Ads' };
    expect(await runCommand(services, tagged, { contactId: one.id, ...google }, as('form'))).toBe(
      true,
    );
    expect(await runCommand(services, tagged, { contactId: two.id, ...google }, as('form'))).toBe(
      true,
    );
    // The same contact again: it carries it once.
    await runCommand(services, tagged, { contactId: one.id, ...google }, as('form'));
    await runCommand(
      services,
      tagged,
      { contactId: one.id, key: 'facebook', label: 'Facebook' },
      as('form'),
    );
    expect(await tagsOf(businessId)).toMatchObject([
      {
        name: 'Source: Facebook',
        system_key: 'lead_source:facebook',
        group_name: 'Lead source',
        group_key: 'lead_source',
        created_by_kind: 'system',
      },
      {
        name: 'Source: Google Ads',
        system_key: 'lead_source:google_ads',
        group_name: 'Lead source',
      },
    ]);
    expect(await carried(one.id)).toEqual([
      { name: 'Source: Facebook', source_kind: 'form' },
      { name: 'Source: Google Ads', source_kind: 'form' },
    ]);
    expect(await carried(two.id)).toEqual([{ name: 'Source: Google Ads', source_kind: 'form' }]);
    // Each was announced once, as a tag a person makes is.
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string; count: string }>(
        `select type, count(*)::text as count from events.events
         where business_id = $1 and type in ('tag.created', 'tag_group.created', 'tag.assigned')
         group by type order by type`,
        [businessId],
      ),
    );
    expect(events).toEqual([
      { type: 'tag.assigned', count: '3' },
      { type: 'tag.created', count: '2' },
      { type: 'tag_group.created', count: '1' },
    ]);
  });

  it('is found again by its key after a person renames it or moves it', async () => {
    const { id: businessId, as } = await business();
    const contact = await database.fixtures.contact(as('user').context);
    const direct = { key: 'direct', label: 'Direct' };
    await runCommand(services, tagged, { contactId: contact.id, ...direct }, as('form'));
    await database.as('crm_owner', (sql) =>
      sql.query(`update crm.tags set name = 'Walk-in', group_id = null where business_id = $1`, [
        businessId,
      ]),
    );
    const other = await database.fixtures.contact(as('user').context);
    await runCommand(services, tagged, { contactId: other.id, ...direct }, as('form'));
    expect(await tagsOf(businessId)).toMatchObject([
      { name: 'Walk-in', system_key: 'lead_source:direct', group_name: null },
    ]);
    expect(await carried(other.id)).toEqual([{ name: 'Walk-in', source_kind: 'form' }]);
  });

  it('uses the tag a person already made under that name, and their group', async () => {
    const { id: businessId, as } = await business();
    await database.as('crm_owner', (sql) =>
      sql.query(
        `with made as (
           insert into crm.tag_groups (business_id, name) values ($1, 'LEAD Source') returning id)
         insert into crm.tags (business_id, name, group_id, created_by_kind)
         select $1, 'source:_referral', id, 'user' from made`,
        [businessId],
      ),
    );
    const contact = await database.fixtures.contact(as('user').context);
    await runCommand(
      services,
      tagged,
      { contactId: contact.id, key: 'referral', label: 'Referral' },
      as('form'),
    );
    await runCommand(
      services,
      tagged,
      { contactId: contact.id, key: 'email', label: 'Email' },
      as('form'),
    );
    // No second "Source: Referral", and no second group: the new tag joined theirs. The
    // tag a person made is now that lead source's tag, by the key, and still theirs.
    expect(await tagsOf(businessId)).toMatchObject([
      { name: 'Source: Email', system_key: 'lead_source:email', group_name: 'LEAD Source' },
      {
        name: 'source:_referral',
        system_key: 'lead_source:referral',
        group_name: 'LEAD Source',
        created_by_kind: 'user',
      },
    ]);
    expect((await carried(contact.id)).map((tag) => tag.name)).toEqual([
      'Source: Email',
      'source:_referral',
    ]);
    // So renaming it afterwards makes no second one.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update crm.tags set name = 'Word of mouth' where business_id = $1 and system_key = 'lead_source:referral'`,
        [businessId],
      ),
    );
    const next = await database.fixtures.contact(as('user').context);
    await runCommand(
      services,
      tagged,
      { contactId: next.id, key: 'referral', label: 'Referral' },
      as('form'),
    );
    expect((await tagsOf(businessId)).map((tag) => tag.name)).toEqual([
      'Source: Email',
      'Word of mouth',
    ]);
    expect(await carried(next.id)).toEqual([{ name: 'Word of mouth', source_kind: 'form' }]);
  });

  it('gives a person the same tags a form makes, by key, and makes no lookalike', async () => {
    const { id: businessId, as } = await business();
    const ensure = (sources: readonly string[], invocation = as('user')) =>
      runCommand(services, ensureLeadSourceTagsCommand, { sources }, invocation);
    // A form made one first; a person had made another by hand, ungrouped.
    const lead = await database.fixtures.contact(as('user').context);
    await runCommand(
      services,
      tagged,
      { contactId: lead.id, key: 'google_ads', label: 'Google Ads' },
      as('form'),
    );
    const byHand = await runCommand(
      services,
      createTagCommand,
      { name: 'source: facebook-ads' },
      as('user'),
    );

    const first = leadSourceTags.parse(
      await ensure(['google_ads', 'facebook_ads', 'organic_search', 'google_ads']),
    );
    // In the order asked, each once, with the business's own tag of that lead source.
    expect(first.items.map((item) => [item.source, item.label, item.tag.name])).toEqual([
      ['google_ads', 'Google Ads', 'Source: Google Ads'],
      ['facebook_ads', 'Facebook Ads', 'source: facebook-ads'],
      ['organic_search', 'Organic Search', 'Source: Organic Search'],
    ]);
    expect(first.items[1]?.tag.id).toBe(byHand.id);
    const byKey = async (): Promise<Record<string, unknown>> =>
      Object.fromEntries((await tagsOf(businessId)).map((tag) => [tag.system_key ?? '', tag]));
    expect(await byKey()).toMatchObject({
      // The form's, as it was.
      'lead_source:google_ads': { name: 'Source: Google Ads', group_key: 'lead_source' },
      // Made now, as a form would have made it: the system's, in its group.
      'lead_source:organic_search': {
        name: 'Source: Organic Search',
        group_name: 'Lead source',
        created_by_kind: 'system',
      },
      // The person's, taken as the lead source's tag: keyed, and otherwise theirs.
      'lead_source:facebook_ads': {
        name: 'source: facebook-ads',
        group_name: null,
        created_by_kind: 'user',
      },
    });
    expect(await tagsOf(businessId)).toHaveLength(3);

    // Asked again, also after a rename: the same three tags and nothing made.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update crm.tags set name = 'Paid Google' where business_id = $1 and system_key = 'lead_source:google_ads'`,
        [businessId],
      ),
    );
    const again = leadSourceTags.parse(
      await ensure(['google_ads', 'facebook_ads', 'organic_search']),
    );
    expect(again.items.map((item) => item.tag.id)).toEqual(first.items.map((item) => item.tag.id));
    expect(again.items[0]?.tag.name).toBe('Paid Google');
    expect(await tagsOf(businessId)).toHaveLength(3);
    // And the next lead of a form carries that same renamed tag.
    const later = await database.fixtures.contact(as('user').context);
    await runCommand(
      services,
      tagged,
      { contactId: later.id, key: 'google_ads', label: 'Google Ads' },
      as('form'),
    );
    expect(await carried(later.id)).toEqual([{ name: 'Paid Google', source_kind: 'form' }]);

    // The list is closed: a key nobody ships, the one whose name is anybody's, a name, none.
    for (const sources of [['vip'], ['source_param'], ['Source: Mine'], []])
      await expect(ensure(sources), JSON.stringify(sources)).rejects.toBeInstanceOf(
        ValidationError,
      );
    // People only: not an automation, an assistant, a form or a visitor.
    for (const actor of ['automation', 'ai_agent', 'form', 'contact'] as const)
      await expect(ensure(['direct'], as(actor)), actor).rejects.toBeInstanceOf(ForbiddenError);
    expect(await tagsOf(businessId)).toHaveLength(3);
  });

  it('makes no tag from a name an address chose, and uses one only if a person made it', async () => {
    const { id: businessId, as } = await business();
    const contact = await database.fixtures.contact(as('user').context);
    const flyer = { key: 'source_param', label: 'Spring flyer' };
    expect(
      await runCommand(services, tagged, { contactId: contact.id, ...flyer }, as('form')),
    ).toBe(false);
    expect(await tagsOf(businessId)).toEqual([]);
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into crm.tags (business_id, name, created_by_kind)
         values ($1, 'Source: Spring Flyer', 'user')`,
        [businessId],
      ),
    );
    expect(
      await runCommand(services, tagged, { contactId: contact.id, ...flyer }, as('form')),
    ).toBe(true);
    expect(await carried(contact.id)).toEqual([
      { name: 'Source: Spring Flyer', source_kind: 'form' },
    ]);
    // A name an address chose that happens to be a built-in's is still not the system's.
    expect(
      await runCommand(
        services,
        tagged,
        { contactId: contact.id, key: 'source_param', label: 'Google Ads' },
        as('form'),
      ),
    ).toBe(false);
    expect(await tagsOf(businessId)).toHaveLength(1);
  });

  it('cannot be used to make any other tag', async () => {
    const { id: businessId, as } = await business();
    const contact = await database.fixtures.contact(as('user').context);
    for (const [key, label] of [
      // A built-in key with a name of the caller's own.
      ['google_ads', 'Free money'],
      ['google_ads', 'google ads'],
      // No such rule.
      ['vip', 'VIP'],
      ['__proto__', 'Google Ads'],
      // Too long for a tag, and empty.
      ['source_param', 'a'.repeat(61)],
      ['direct', ''],
    ] as const)
      expect(
        await runCommand(services, tagged, { contactId: contact.id, key, label }, as('form')),
        `${key} ${label.slice(0, 12)}`,
      ).toBe(false);
    expect(await tagsOf(businessId)).toEqual([]);
    expect(await carried(contact.id)).toEqual([]);

    // The API takes no key: a person cannot mark a tag as the system's.
    expect(
      createTagInput.safeParse({ name: 'Mine', systemKey: 'lead_source:google_ads' }).success,
    ).toBe(false);
    // Automations and assistants still make no tag at all, and neither does a form or a
    // visitor through the command people use: not a name of its own, and not even a lead
    // source's name. The only tag a form causes is the system's, above, by its key.
    for (const actor of ['automation', 'ai_agent', 'form', 'contact'] as const)
      for (const name of ['Source: Google Ads', 'Anything a form likes'])
        await expect(
          runCommand(services, createTagCommand, { name }, as(actor)),
          `${actor} ${name}`,
        ).rejects.toBeInstanceOf(ForbiddenError);
    for (const actor of ['form', 'contact'] as const)
      await expect(
        runCommand(services, createTagGroupCommand, { name: 'Mine' }, as(actor)),
      ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await tagsOf(businessId)).toEqual([]);
    // And the database lets the key name nothing but a lead source, once a business.
    const refused = (statement: string) =>
      database
        .as('crm_owner', (sql) => sql.query(statement, [businessId]))
        .then(
          () => 'stored',
          (error: unknown) => (error as { constraint?: string }).constraint,
        );
    expect(
      await refused(
        `insert into crm.tags (business_id, name, created_by_kind, system_key)
         values ($1, 'Anything', 'user', 'billing:vip')`,
      ),
    ).toBe('tags_system_key_valid');
    expect(
      await refused(
        `insert into crm.tag_groups (business_id, name, system_key) values ($1, 'Mine', 'other')`,
      ),
    ).toBe('tag_groups_system_key_valid');
    await runCommand(
      services,
      tagged,
      { contactId: contact.id, key: 'direct', label: 'Direct' },
      as('form'),
    );
    expect(
      await refused(
        `insert into crm.tags (business_id, name, created_by_kind, system_key)
         values ($1, 'A second one', 'user', 'lead_source:direct')`,
      ),
    ).toBe('tags_system_key_idx');
  });

  it('makes one tag when two leads need it at the same moment', async () => {
    const { id: businessId, as } = await business();
    const contacts = await Promise.all(
      [1, 2, 3, 4].map(() => database.fixtures.contact(as('user').context)),
    );
    await Promise.all(
      contacts.map((contact) =>
        runCommand(
          services,
          tagged,
          { contactId: contact.id, key: 'organic_search', label: 'Organic Search' },
          as('form'),
        ),
      ),
    );
    expect(await tagsOf(businessId)).toMatchObject([
      { name: 'Source: Organic Search', group_name: 'Lead source' },
    ]);
    for (const contact of contacts) expect(await carried(contact.id)).toHaveLength(1);
  });

  it('is each business’s own', async () => {
    const mine = await business();
    const theirs = await business();
    const contact = await database.fixtures.contact(mine.as('user').context);
    await runCommand(
      services,
      tagged,
      { contactId: contact.id, key: 'google_ads', label: 'Google Ads' },
      mine.as('form'),
    );
    const find = (seeded: typeof mine) =>
      withTenant(db, seeded.as('user').context, (trx) =>
        findLeadSourceTag(trx, seeded.id, { key: 'google_ads', label: 'Google Ads' }),
      );
    expect((await find(mine))?.name).toBe('Source: Google Ads');
    expect(await find(theirs)).toBeUndefined();
    // Named with the other business's id, under this one's row-level security: still nothing.
    expect(
      await withTenant(db, theirs.as('user').context, (trx) =>
        findLeadSourceTag(trx, mine.id, { key: 'google_ads', label: 'Google Ads' }),
      ),
    ).toBeUndefined();
    expect(await tagsOf(theirs.id)).toEqual([]);
  });

  it('has a name a tag can hold for every built-in lead source', () => {
    expect(leadSources).toHaveLength(leadSourceKeys.length - 1);
  });
});

// Stage 2 of the plan: the lead is taken on one page and how the visitor arrived was read
// from the page the visit began on, handed over by the browser (arrival.ts).
describe('a touch whose arrival was carried from another page', () => {
  const SITE = 'https://crm.example.test';
  const LANDING = `${SITE}/s/site/offer`;
  const BOOKING = `${SITE}/book/agency/events/tour`;
  const AD = '?utm_source=google&utm_medium=cpc&campaign_id=42&gclid=G1';

  it('keeps both pages, says it was carried, and tells the contact’s page so', async () => {
    const { as } = await business();
    const contact = await database.fixtures.contact(as('user').context, { firstName: 'Booker' });
    const booked = defineCommand({
      name: 'test.lead_source.carried',
      permission: 'contacts.manage',
      input: z.strictObject({ visits: z.array(publicVisit) }),
      async handle(trx, input, command): Promise<void> {
        for (const visit of input.visits)
          await recordBookingTouch(
            trx,
            { contactId: contact.id, appointmentId: randomUUID(), visit },
            command,
          );
      },
    });
    await runCommand(
      services,
      booked,
      {
        visits: [
          // Reached from a page of the site, which handed over how the visit began.
          { pageUrl: BOOKING, first: { pageUrl: `${LANDING}${AD}`, at: Date.now() } },
          // The booking page's own labels win.
          {
            pageUrl: `${BOOKING}?utm_source=facebook&utm_medium=paid_social`,
            first: { pageUrl: `${LANDING}${AD}`, at: Date.now() },
          },
          // A landing on another website is not believed.
          {
            pageUrl: BOOKING,
            first: { pageUrl: `https://www.rival.example/offer${AD}`, at: Date.now() },
          },
        ],
      },
      as('contact'),
    );
    const stored = await database.as('crm_owner', (sql) =>
      sql.query(
        `select source_label, landing_url, page_url, arrival_carried, gclid is not null as has_gclid
         from crm.contact_attributions where contact_id = $1 and medium = 'calendar'
         order by touched_at, id`,
        [contact.id],
      ),
    );
    expect(stored).toEqual([
      {
        source_label: 'Google Ads',
        landing_url: LANDING,
        page_url: BOOKING,
        arrival_carried: true,
        has_gclid: true,
      },
      {
        source_label: 'Facebook Ads',
        landing_url: BOOKING,
        page_url: BOOKING,
        arrival_carried: false,
        has_gclid: false,
      },
      {
        source_label: 'Direct',
        landing_url: BOOKING,
        page_url: BOOKING,
        arrival_carried: false,
        has_gclid: false,
      },
    ]);
    const read = contactAttributions.parse(
      await withTenant(db, as('user').context, (trx) =>
        readContactAttribution(trx, as('user'), toPublicId('contact', contact.id)),
      ),
    );
    expect(read.latest).toMatchObject({ source: 'Direct', arrivalCarried: false });
  });

  it('is false on every touch that knew only its own page, and on a contact made by hand', async () => {
    const { as } = await business();
    const contact = await database.fixtures.contact(as('user').context, { firstName: 'Manual' });
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ arrival_carried: boolean }>(
        'select arrival_carried from crm.contact_attributions where contact_id = $1',
        [contact.id],
      ),
    );
    for (const row of rows) expect(row.arrival_carried).toBe(false);
  });
});
