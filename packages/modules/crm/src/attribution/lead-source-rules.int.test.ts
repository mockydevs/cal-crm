// The business's own lead source rules against a migrated Postgres, as crm_app under
// row-level security: kept through the module's routes with revision checks, read once for
// a lead in their order, and applied to a contact through the CRM's own commands. What a
// form does with them is the forms module's to prove
// (packages/modules/forms/src/lead-source-rules.int.test.ts).
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  fieldDefinition,
  leadSourceFactNames,
  leadSourceRule,
  leadSourceRuleList,
  publicVisit,
  type LeadSourceRule,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { crmRoutes } from '../index.js';
import { readArrival } from './arrival.js';
import { applyLeadSourceRules } from './lead-source-apply.js';
import { decideLeadSourceFor, readActiveLeadSourceRules, taggedAs } from './lead-source-rules.js';
import { readVisit } from './session-source.js';
import { recordBookingTouch } from './booking-touch.js';

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

interface Business {
  readonly id: string;
  readonly as: (permissions?: readonly Permission[]) => Invocation;
}

async function business(): Promise<Business> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return {
    id: created.id,
    as: (permissions) => ({
      context: {
        ...created.context,
        actorKind: 'user',
        actorId: user.id,
        userId: user.id,
        correlationId: randomUUID(),
      },
      permissions: permissions === undefined ? 'all' : new Set(permissions),
    }),
  };
}

/** Runs a route of the module as the server runs it. */
const call = (
  b: Business,
  operationId: string,
  input: { params?: unknown; body?: unknown } = {},
  invocation = b.as(),
): Promise<unknown> => {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return Promise.resolve(
    route.run({ invocation, params: input.params ?? {}, query: {}, body: input.body }, services),
  );
};

const tag = async (b: Business, name: string): Promise<string> =>
  z.object({ id: z.string() }).parse(await call(b, 'createTag', { body: { name } })).id;

const field = async (b: Business, key: string, valueType = 'text'): Promise<string> =>
  fieldDefinition.parse(
    await call(b, 'createField', {
      body: {
        objectKey: 'contact',
        key,
        label: key,
        description: 'A field a lead source rule fills.',
        valueType,
        options: [],
        currency: null,
        aiFillSources: [],
        aiOverwrite: 'ask',
        archived: false,
      },
    }),
  ).id;

const FORM = [{ fact: 'medium', op: 'is', value: 'form' }];
const make = async (b: Business, body: Record<string, unknown>): Promise<LeadSourceRule> =>
  leadSourceRule.parse(
    await call(b, 'createLeadSourceRule', { body: { conditions: FORM, ...body } }),
  );
const list = async (b: Business, invocation = b.as()) =>
  leadSourceRuleList.parse(await call(b, 'listLeadSourceRules', {}, invocation));
const whole = (rule: LeadSourceRule, change: Record<string, unknown> = {}) => ({
  name: rule.name,
  enabled: rule.enabled,
  conditions: rule.conditions,
  source: rule.source,
  tagIds: rule.tagIds,
  fieldWrites: rule.fieldWrites,
  revision: rule.revision,
  ...change,
});
const issuesOf = (work: Promise<unknown>): Promise<string[]> =>
  work.then(
    () => [],
    (error: unknown) =>
      error instanceof ValidationError
        ? error.issues.map((issue) => `${issue.path} ${issue.code}`)
        : [String(error)],
  );

it('keeps a business’s rules in order: added last, saved by revision, moved together, closed up when one goes', async () => {
  const b = await business();
  const vip = await tag(b, 'VIP');
  const note = await field(b, 'lead_note');
  expect(await list(b)).toMatchObject({ items: [], limit: 50, canManage: true });

  const first = await make(b, {
    name: ' Spring ',
    source: ' Spring promo ',
    tagIds: [vip],
    fieldWrites: [{ fieldId: note, value: 'From spring' }],
  });
  expect(first).toMatchObject({
    position: 1,
    name: 'Spring',
    enabled: true,
    conditions: FORM,
    source: 'Spring promo',
    tagIds: [vip],
    fieldWrites: [{ fieldId: note, value: 'From spring' }],
    problems: [],
    revision: 1,
  });
  expect(first.id).toMatch(/^lsr_/);
  const second = await make(b, { name: 'Tag only', tagIds: [vip] });
  const third = await make(b, { name: 'Off', source: 'Off', enabled: false });
  expect([second.position, third.position]).toEqual([2, 3]);
  expect(second.source).toBeNull();
  expect(
    leadSourceRule.parse(await call(b, 'getLeadSourceRule', { params: { ruleId: first.id } })),
  ).toEqual(first);

  // A save is the whole rule from the revision it was read at.
  const saved = leadSourceRule.parse(
    await call(b, 'updateLeadSourceRule', {
      params: { ruleId: second.id },
      body: whole(second, { name: 'Tagged', source: 'Tagged', tagIds: [], fieldWrites: [] }),
    }),
  );
  expect(saved).toMatchObject({ name: 'Tagged', source: 'Tagged', revision: 2, position: 2 });
  await expect(
    call(b, 'updateLeadSourceRule', { params: { ruleId: second.id }, body: whole(second) }),
  ).rejects.toBeInstanceOf(ConflictError);

  // An order names every rule once, from the list as it was read.
  const read = await list(b);
  expect(read.items.map((each) => each.name)).toEqual(['Spring', 'Tagged', 'Off']);
  const moved = leadSourceRuleList.parse(
    await call(b, 'reorderLeadSourceRules', {
      body: { ruleIds: [third.id, first.id, second.id], revision: read.revision },
    }),
  );
  expect(moved.items.map((each) => [each.name, each.position, each.revision])).toEqual([
    ['Off', 1, 1],
    ['Spring', 2, 1],
    ['Tagged', 3, 2],
  ]);
  expect(moved.revision).not.toBe(read.revision);
  await expect(
    call(b, 'reorderLeadSourceRules', {
      body: { ruleIds: [first.id, second.id, third.id], revision: read.revision },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  for (const ruleIds of [
    [first.id, second.id],
    [first.id, second.id, 'lsr_01h455vb4pex5vsknk084sn02q'],
  ])
    expect(
      await issuesOf(
        call(b, 'reorderLeadSourceRules', { body: { ruleIds, revision: moved.revision } }),
      ),
    ).toEqual(['/ruleIds incomplete_order']);
  // The same order again moves nothing and is no error.
  expect(
    leadSourceRuleList
      .parse(
        await call(b, 'reorderLeadSourceRules', {
          body: { ruleIds: moved.items.map((each) => each.id), revision: moved.revision },
        }),
      )
      .items.map((each) => each.position),
  ).toEqual([1, 2, 3]);

  // Only the rules switched on are read for a lead, in their order.
  const active = await withTenant(db, b.as().context, (trx) =>
    readActiveLeadSourceRules(trx, b.id),
  );
  expect(active.map((each) => [each.position, each.name, each.source])).toEqual([
    [2, 'Spring', 'Spring promo'],
    [3, 'Tagged', 'Tagged'],
  ]);
  expect(active[0]).toMatchObject({
    id: parsePublicId('lead_source_rule', first.id),
    tagIds: [parsePublicId('tag', vip)],
    fieldWrites: [{ fieldId: parsePublicId('field', note), value: 'From spring' }],
  });

  // Deleted, the ones after it move up.
  expect(await call(b, 'deleteLeadSourceRule', { params: { ruleId: first.id } })).toBeUndefined();
  expect((await list(b)).items.map((each) => [each.name, each.position])).toEqual([
    ['Off', 1],
    ['Tagged', 2],
  ]);
  for (const operationId of ['getLeadSourceRule', 'deleteLeadSourceRule'])
    await expect(
      call(b, operationId, { params: { ruleId: first.id } }),
      operationId,
    ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call(b, 'updateLeadSourceRule', { params: { ruleId: first.id }, body: whole(first) }),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('refuses what a rule may not name, a rule that is not one, and a fifty-first', async () => {
  const b = await business();
  const other = await business();
  const theirs = await tag(other, 'Theirs');
  const number = await field(b, 'lead_score', 'number');
  const text = await field(b, 'lead_text');
  const refused = (body: Record<string, unknown>) =>
    issuesOf(call(b, 'createLeadSourceRule', { body: { name: 'R', conditions: FORM, ...body } }));
  expect(await refused({ tagIds: [theirs] })).toEqual(['/tagIds/0 invalid_tag']);
  expect(await refused({ fieldWrites: [{ fieldId: number, value: '5' }] })).toEqual([
    '/fieldWrites/0/fieldId invalid_field',
  ]);
  expect(
    await refused({
      source: 'S',
      tagIds: [theirs, 'tag_01h455vb4pex5vsknk084sn02q'],
      fieldWrites: [
        { fieldId: text, value: 'ok' },
        { fieldId: 'fld_01h455vb4pex5vsknk084sn02q', value: 'x' },
      ],
    }),
  ).toEqual([
    '/tagIds/0 invalid_tag',
    '/tagIds/1 invalid_tag',
    '/fieldWrites/1/fieldId invalid_field',
  ]);
  // The contract's own refusals reach the caller as they are.
  await expect(
    call(b, 'createLeadSourceRule', { body: { name: 'R', conditions: FORM } }),
  ).rejects.toBeDefined();
  expect((await list(b)).items).toEqual([]);

  // A save is held to the same.
  const made = await make(b, { name: 'Kept', source: 'S' });
  expect(
    await issuesOf(
      call(b, 'updateLeadSourceRule', {
        params: { ruleId: made.id },
        body: whole(made, { tagIds: [theirs] }),
      }),
    ),
  ).toEqual(['/tagIds/0 invalid_tag']);

  for (let n = 2; n <= 50; n += 1) await make(b, { name: `Rule ${String(n)}`, source: 'S' });
  expect(await refused({ source: 'S' })).toEqual(['/name limit_reached']);
  expect((await list(b)).items.map((each) => each.position)).toEqual(
    Array.from({ length: 50 }, (_, n) => n + 1),
  );
});

it('lets anyone in the business read the rules, and nobody of another business', async () => {
  const mine = await business();
  const theirs = await business();
  const made = await make(mine, { name: 'Mine', source: 'Mine only' });
  // Someone with no permission at all reads them, and is told they may not change them.
  const reader = mine.as([]);
  expect(await list(mine, reader)).toMatchObject({ items: [{ id: made.id }], canManage: false });
  expect(
    leadSourceRule.parse(
      await call(mine, 'getLeadSourceRule', { params: { ruleId: made.id } }, reader),
    ).id,
  ).toBe(made.id);
  expect((await list(mine, mine.as(['forms.manage']))).canManage).toBe(true);

  expect((await list(theirs)).items).toEqual([]);
  for (const [operationId, body] of [
    ['getLeadSourceRule', undefined],
    ['deleteLeadSourceRule', undefined],
    ['updateLeadSourceRule', whole(made)],
  ] as const)
    await expect(
      call(theirs, operationId, { params: { ruleId: made.id }, body }),
      operationId,
    ).rejects.toBeInstanceOf(NotFoundError);
  // An order that names another business's rule moves nothing there.
  const own = await list(theirs);
  expect(
    await issuesOf(
      call(theirs, 'reorderLeadSourceRules', {
        body: { ruleIds: [made.id], revision: own.revision },
      }),
    ),
  ).toEqual(['/ruleIds incomplete_order']);
  expect(
    await withTenant(db, theirs.as().context, (trx) => readActiveLeadSourceRules(trx, theirs.id)),
  ).toEqual([]);
  expect((await list(mine)).items).toHaveLength(1);
});

it('names a lead by a rule on any fact of the visit, each read from one statement of the rules', async () => {
  const b = await business();
  const PAGE = 'https://www.harborlights.example/offer/step-2';
  const AD = `${PAGE}?utm_source=google&utm_medium=cpc&utm_campaign=c&utm_content=d&utm_term=kw&matchtype=p&campaign_id=1&ad_group_id=2&ad_id=3&gclid=abc&promo=spring`;
  // One rule a fact: each matches this visit, and names itself.
  const conditions: Record<string, Record<string, unknown>> = {
    lead_source: { op: 'is', value: 'google_ads' },
    session_source: { op: 'is_one_of', values: ['paid_search'] },
    medium: { op: 'is_not', value: 'chat' },
    utm_source: { op: 'is', value: 'GOOGLE' },
    utm_medium: { op: 'starts_with', value: 'cp' },
    utm_campaign: { op: 'is_not_empty' },
    utm_content: { op: 'is', value: 'd' },
    utm_term: { op: 'contains', value: 'k' },
    match_type: { op: 'is', value: 'p' },
    campaign_id: { op: 'is', value: '1' },
    ad_group_id: { op: 'is', value: '2' },
    ad_id: { op: 'is', value: '3' },
    click_id_google: { op: 'is_not_empty' },
    click_id_meta: { op: 'is_empty' },
    click_id_microsoft: { op: 'is_empty' },
    click_id_tiktok: { op: 'is_empty' },
    click_id_linkedin: { op: 'is_empty' },
    referrer_domain: { op: 'contains', value: 'google' },
    landing_page: { op: 'is', value: PAGE },
    form_page: { op: 'starts_with', value: 'https://www.harborlights.example/' },
    site: { op: 'is', value: 'www.harborlights.example' },
    step: { op: 'is', value: '/offer/step-2' },
    parameter: { op: 'is', value: 'spring', name: 'promo' },
  };
  expect(Object.keys(conditions)).toEqual([...leadSourceFactNames]);
  for (const [fact, condition] of Object.entries(conditions))
    await make(b, { name: fact, conditions: [{ fact, ...condition }], source: `By ${fact}` });

  const arrival = readArrival({ pageUrl: AD, referrer: 'https://www.google.com/' });
  const decide = (medium: 'form' | 'calendar' | 'chat', address = arrival.address) =>
    withTenant(db, b.as().context, (trx) =>
      decideLeadSourceFor(trx, b.id, {
        medium,
        visit: arrival.visit,
        pageUrl: arrival.pageUrl,
        address,
      }),
    );
  const decided = await decide('form');
  // Every rule matches, and the first names the lead.
  expect(decided.matches.map((each) => each.name)).toEqual([...leadSourceFactNames]);
  expect(decided.label).toBe('By lead_source');
  expect(decided.builtIn).toEqual({ key: 'google_ads', label: 'Google Ads' });
  expect(taggedAs(decided)).toEqual({ key: 'source_param', label: 'By lead_source' });
  // With no address to read a parameter from, that one rule does not match.
  const blind = await withTenant(db, b.as().context, (trx) =>
    decideLeadSourceFor(trx, b.id, {
      medium: 'form',
      visit: arrival.visit,
      pageUrl: null,
    }),
  );
  expect(
    leadSourceFactNames.filter((fact) => !blind.matches.some((each) => each.name === fact)),
  ).toEqual(['form_page', 'site', 'step', 'parameter']);
  // Another visit matches none of the ones that name a Source it has, and is named as before.
  const direct = await withTenant(db, b.as().context, (trx) =>
    decideLeadSourceFor(trx, b.id, {
      medium: 'chat',
      visit: readVisit({}),
      pageUrl: null,
    }),
  );
  expect(direct.matches.map((each) => each.name)).toEqual([
    'click_id_meta',
    'click_id_microsoft',
    'click_id_tiktok',
    'click_id_linkedin',
  ]);
  expect(direct.label).toBe('By click_id_meta');
});

it('applies the matching rules’ tags and field values to a contact, and skips what is gone', async () => {
  const b = await business();
  const [kept, gone, extra] = [await tag(b, 'Kept'), await tag(b, 'Gone'), await tag(b, 'Extra')];
  const note = await field(b, 'lead_note');
  const lost = await field(b, 'lead_lost');
  const rule = await leadSourceRule.parseAsync(
    await call(b, 'createLeadSourceRule', {
      body: {
        name: 'Bookings',
        conditions: [{ fact: 'medium', op: 'is', value: 'calendar' }],
        source: 'Online booking',
        tagIds: [gone, kept, extra],
        fieldWrites: [
          { fieldId: lost, value: 'Never written' },
          { fieldId: note, value: 'Booked online' },
        ],
      },
    }),
  );
  // After the rule was saved, a tag is deleted and a field archived.
  await database.as('crm_owner', (sql) =>
    sql.query(`delete from crm.tags where business_id = $1 and id = $2;`, [
      b.id,
      parsePublicId('tag', gone),
    ]),
  );
  await database.as('crm_owner', (sql) =>
    sql.query(
      `update crm.field_definitions set archived_at = now() where business_id = $1 and id = $2`,
      [b.id, parsePublicId('field', lost)],
    ),
  );
  // The rule says what it names that is no longer there.
  expect(
    leadSourceRule.parse(await call(b, 'getLeadSourceRule', { params: { ruleId: rule.id } }))
      .problems,
  ).toEqual([
    expect.objectContaining({ code: 'tag_missing', id: gone }),
    expect.objectContaining({ code: 'field_unavailable', id: lost }),
  ]);

  const booked = defineCommand({
    name: 'test.contact.booked_with_rules',
    permission: 'contacts.manage',
    input: z.strictObject({ contactId: z.string(), visit: publicVisit.optional() }),
    handle: (trx, input, command) =>
      recordBookingTouch(trx, { ...input, appointmentId: randomUUID() }, command),
  });
  const stateOf = (contactId: string) =>
    database.as('crm_owner', (sql) =>
      sql.one<{ tags: string[]; fields: Record<string, string>; rule: string; label: string }>(
        `select coalesce((select array_agg(t.name order by t.name)
                          from crm.record_tags rt
                          join crm.tags t on t.business_id = rt.business_id and t.id = rt.tag_id
                          where rt.record_id = $1), '{}') as tags,
                coalesce((select jsonb_object_agg(d.key, v.value_text)
                          from crm.field_values v
                          join crm.field_definitions d
                            on d.business_id = v.business_id and d.id = v.field_id
                          where v.record_id = $1 and v.value_text is not null), '{}') as fields,
                (select source_rule from crm.contact_attributions
                 where contact_id = $1 and is_latest) as rule,
                (select source_label from crm.contact_attributions
                 where contact_id = $1 and is_latest) as label`,
        [contactId],
      ),
    );
  const contact = await database.fixtures.contact(b.as().context);
  await runCommand(services, booked, { contactId: contact.id }, b.as());
  // The lead is kept and named; what is still there is applied, what is gone is skipped.
  expect(await stateOf(contact.id)).toEqual({
    tags: ['Extra', 'Kept'],
    fields: { lead_note: 'Booked online' },
    rule: rule.id,
    label: 'Online booking',
  });
  // A second booking writes nothing new: the tags are there and the field says the same.
  await runCommand(services, booked, { contactId: contact.id }, b.as());
  expect(await stateOf(contact.id)).toMatchObject({
    tags: ['Extra', 'Kept'],
    fields: { lead_note: 'Booked online' },
  });

  // With room for one tag only, the first that can be added is; with none, none.
  const applied = defineCommand({
    name: 'test.contact.rules_applied',
    permission: 'contacts.manage',
    input: z.strictObject({ contactId: z.string(), room: z.number() }),
    handle: (trx, input, command) =>
      applyLeadSourceRules(
        trx,
        command,
        input.contactId,
        {
          tagIds: [kept, extra].map((id) => parsePublicId('tag', id) ?? ''),
          fieldWrites: [],
        },
        input.room,
      ),
  });
  const one = await database.fixtures.contact(b.as().context);
  await runCommand(services, applied, { contactId: one.id, room: 1 }, b.as());
  expect((await stateOf(one.id)).tags).toEqual(['Kept']);
  const none = await database.fixtures.contact(b.as().context);
  await runCommand(services, applied, { contactId: none.id, room: -2 }, b.as());
  expect((await stateOf(none.id)).tags).toEqual([]);
});

it('leaves out a stored rule this release cannot read, so it matches nothing rather than everything', async () => {
  const b = await business();
  await make(b, { name: 'Good', source: 'Good' });
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into crm.lead_source_rules
         (business_id, position, name, conditions, source_label, field_writes, created_by_kind)
       values
         ($1, 2, 'From the future', '[{"fact":"weather","op":"is","value":"rain"}]', 'Rain', '[]', 'user'),
         ($1, 3, 'Odd writes', '[{"fact":"medium","op":"is","value":"form"}]', 'Odd',
          '[{"fieldId":"not-an-id","value":"x"}]', 'user')`,
      [b.id],
    ),
  );
  const active = await withTenant(db, b.as().context, (trx) =>
    readActiveLeadSourceRules(trx, b.id),
  );
  expect(active.map((each) => each.name)).toEqual(['Good']);
  // Read for the list, such a rule shows no condition and no write it could not read.
  const listed = (await list(b)).items;
  expect(
    listed.map((each) => [each.name, each.conditions.length, each.fieldWrites.length]),
  ).toEqual([
    ['Good', 1, 0],
    ['From the future', 0, 0],
    ['Odd writes', 1, 0],
  ]);
});
