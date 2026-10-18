// The business's own lead source rules through a form, with the real public handlers and
// the real routes against a migrated Postgres: a rule renames the Facebook Ads leads of one
// campaign and tags them; the built-in rules still name every other lead; tags and field
// values of every matching rule apply within the limits; "Check a link" says the same
// before anybody clicks; and the rules of one business are nothing to another.
import { randomUUID } from 'node:crypto';

import { allowEveryone } from '@repo/commands';
import {
  DEFAULT_FORM_DEFINITION,
  leadSourcePreview,
  leadSourceRule,
  leadSourceRuleList,
  type FormDefinitionInput,
  type LeadSourceRule,
} from '@repo/contracts';
import { ConflictError, NotFoundError, ValidationError } from '@repo/kernel';
import { crmRoutes } from '@repo/module-crm';
import { expect, it } from 'vitest';
import * as z from 'zod';

import { formSuite, WEBSITE, type FormFixture } from '../test/form-fixtures.js';

const suite = formSuite();
const { fixture, published, submit, admin } = suite;
const OK = { outcome: 'ok', receipt: { status: 'received' } };

const GOOGLE_AD = `${WEBSITE}/offer?utm_source=google&utm_medium=cpc&utm_campaign=spring&campaign_id=111&gclid=Cj0abc`;
const SPRING_AD = `${WEBSITE}/offer?utm_source=facebook&utm_medium=paid_social&utm_campaign=Spring-2026&campaign_id=120211&fbclid=IwAR0`;
const AUTUMN_AD = `${WEBSITE}/offer?utm_source=facebook&utm_medium=paid_social&utm_campaign=autumn&campaign_id=120212`;

const actions = (
  contactActions: NonNullable<FormDefinitionInput['contactActions']>,
): FormDefinitionInput => ({ ...DEFAULT_FORM_DEFINITION, contactActions });

/** Runs a route of the CRM module as the server runs it. */
const crm = async (
  f: FormFixture,
  operationId: string,
  input: { params?: unknown; body?: unknown } = {},
  invocation = f.manager,
): Promise<unknown> => {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run(
    {
      invocation: {
        ...invocation,
        context: { ...invocation.context, correlationId: randomUUID() },
      },
      params: input.params ?? {},
      query: {},
      body: input.body,
    },
    { db: suite.db, authorize: allowEveryone },
  );
};

const tag = async (f: FormFixture, name: string): Promise<string> =>
  z.object({ id: z.string() }).parse(await crm(f, 'createTag', { body: { name } })).id;

const rule = async (f: FormFixture, body: unknown): Promise<LeadSourceRule> =>
  leadSourceRule.parse(await crm(f, 'createLeadSourceRule', { body }));

const rulesOf = async (f: FormFixture, invocation = f.manager) =>
  leadSourceRuleList.parse(await crm(f, 'listLeadSourceRules', {}, invocation));

const check = async (f: FormFixture, body: unknown) =>
  leadSourcePreview.parse(await admin(f, 'previewLeadSource', { body }));

interface Lead {
  readonly source: string | null;
  readonly tags: string[];
  readonly touch: { readonly rule: string; readonly label: string } | null;
  readonly submission: { readonly rule: string; readonly label: string } | null;
  readonly fields: Record<string, string>;
}

/** Every contact of the business by email: its Source, tags, latest touch, submission and text fields. */
async function leadsOf(f: FormFixture): Promise<Record<string, Lead>> {
  const rows = await suite.database.withTenant(f.business.context, (sql) =>
    sql.query<Lead & { email: string }>(
      `select i.value_normalized as email, c.source,
              coalesce((select array_agg(t.name order by t.name)
                        from crm.record_tags rt
                        join crm.tags t on t.business_id = rt.business_id and t.id = rt.tag_id
                        where rt.record_id = c.id), '{}') as tags,
              (select jsonb_build_object('rule', a.source_rule, 'label', a.source_label)
               from crm.contact_attributions a where a.contact_id = c.id and a.is_latest) as touch,
              (select jsonb_build_object('rule', s.lead_source_rule, 'label', s.lead_source)
               from forms.submissions s where s.contact_id = c.id
               order by s.submitted_at desc limit 1) as submission,
              coalesce((select jsonb_object_agg(d.key, v.value_text)
                        from crm.field_values v
                        join crm.field_definitions d
                          on d.business_id = v.business_id and d.id = v.field_id
                        where v.record_id = c.id and v.value_text is not null), '{}') as fields
       from crm.contacts c
       join crm.contact_identities i
         on i.business_id = c.business_id and i.contact_id = c.id and i.kind = 'email'
       order by 1`,
    ),
  );
  return Object.fromEntries(rows.map(({ email, ...lead }) => [email, lead]));
}

const SPRING_RULE = (tagIds: string[] = []) => ({
  name: 'Spring campaign',
  conditions: [
    { fact: 'lead_source', op: 'is', value: 'facebook_ads' },
    { fact: 'utm_campaign', op: 'contains', value: 'spring' },
  ],
  source: 'Spring promo',
  tagIds,
});

it('renames the Facebook Ads leads of one campaign and tags them, and leaves every other lead to the built-in rules', async () => {
  const f = await fixture();
  const promo = await tag(f, 'Promo lead');
  const spring = await rule(f, SPRING_RULE([promo]));
  expect(spring).toMatchObject({ position: 1, enabled: true, revision: 1, problems: [] });
  const form = await published(
    f,
    actions({ tagIds: [], source: { kind: 'arrived' }, tagBySource: true }),
  );

  for (const [email, pageUrl] of [
    ['spring@example.test', SPRING_AD],
    ['autumn@example.test', AUTUMN_AD],
    ['google@example.test', GOOGLE_AD],
    ['direct@example.test', `${WEBSITE}/offer`],
  ] as const)
    expect((await submit(form, { email }, { pageUrl })).result, email).toEqual(OK);

  const leads = await leadsOf(f);
  // The rule's name is the contact's Source, the touch's and the submission's, and what
  // decided it is the rule, by its id. The rule's own tag is added; the system makes no
  // "Source: Spring promo" tag, since nobody made one.
  expect(leads['spring@example.test']).toEqual({
    source: 'Spring promo',
    tags: ['Promo lead'],
    touch: { rule: spring.id, label: 'Spring promo' },
    submission: { rule: spring.id, label: 'Spring promo' },
    fields: {},
  });
  // Every other lead is named as before there were rules.
  expect(leads['autumn@example.test']).toMatchObject({
    source: 'Facebook Ads',
    tags: ['Source: Facebook Ads'],
    touch: { rule: 'facebook_ads', label: 'Facebook Ads' },
    submission: { rule: 'facebook_ads', label: 'Facebook Ads' },
  });
  expect(leads['google@example.test']).toMatchObject({
    source: 'Google Ads',
    tags: ['Source: Google Ads'],
    touch: { rule: 'google_ads', label: 'Google Ads' },
  });
  expect(leads['direct@example.test']).toMatchObject({
    source: 'Direct',
    touch: { rule: 'direct', label: 'Direct' },
  });

  // "Check a link" says what the submission got, and which rule said it.
  const preview = await check(f, { url: SPRING_AD, formId: form.id });
  expect(preview).toMatchObject({
    source: 'Spring promo',
    sourceRule: 'facebook_ads',
    decidedBy: { kind: 'rule', ruleId: spring.id, name: 'Spring campaign' },
    builtIn: { source: 'Facebook Ads', sourceRule: 'facebook_ads' },
    rules: [
      {
        id: spring.id,
        name: 'Spring campaign',
        position: 1,
        source: 'Spring promo',
        decidesSource: true,
        tags: [{ id: promo, name: 'Promo lead' }],
        fieldWrites: [],
      },
    ],
    form: {
      contactSource: 'Spring promo',
      tags: [{ name: 'Promo lead', kind: 'rule', exists: true }],
    },
    warnings: [{ code: 'no_tag' }],
  });
  expect(preview.reason).toBe(
    'Your rule “Spring campaign” names this lead. Without it, it would be “Facebook Ads”.',
  );
  expect(await check(f, { url: AUTUMN_AD })).toMatchObject({
    source: 'Facebook Ads',
    decidedBy: { kind: 'built_in', key: 'facebook_ads' },
    builtIn: { source: 'Facebook Ads', sourceRule: 'facebook_ads' },
    rules: [],
  });

  // A tag a person made under the name is the one "Also tag by source" then uses.
  await tag(f, 'Source: Spring promo');
  await submit(form, { email: 'second@example.test' }, { pageUrl: SPRING_AD });
  expect((await leadsOf(f))['second@example.test']?.tags).toEqual([
    'Promo lead',
    'Source: Spring promo',
  ]);
});

it('lets the first matching rule that names a Source decide, and applies the tags and fields of every match', async () => {
  const f = await fixture();
  const [paid, campaign, never] = await Promise.all(
    ['Paid lead', 'Campaign 120211', 'Never'].map((name) => tag(f, name)),
  );
  const channel = await suite.field(f, 'lead_channel');
  const season = await suite.field(f, 'lead_season');
  // In order: a rule that names nothing, the rule that names the lead, a later rule that
  // would name it differently, a rule that does not match, and one switched off.
  const tagging = await rule(f, {
    name: 'Paid social',
    conditions: [{ fact: 'session_source', op: 'is', value: 'paid_social' }],
    tagIds: [paid],
    fieldWrites: [{ fieldId: channel.id, value: 'Paid social' }],
  });
  const naming = await rule(f, {
    ...SPRING_RULE(),
    fieldWrites: [
      { fieldId: channel.id, value: 'Overwritten?' },
      { fieldId: season.id, value: 'Spring' },
    ],
  });
  await rule(f, {
    name: 'By campaign id',
    conditions: [{ fact: 'campaign_id', op: 'is_one_of', values: ['120211', '120212'] }],
    source: 'Campaign by id',
    tagIds: [campaign],
  });
  await rule(f, {
    name: 'Google only',
    conditions: [{ fact: 'click_id_google', op: 'is_not_empty' }],
    source: 'Google by click',
    tagIds: [never],
  });
  await rule(f, {
    name: 'Switched off',
    enabled: false,
    conditions: [{ fact: 'medium', op: 'is', value: 'form' }],
    source: 'Off',
    tagIds: [never],
  });
  const form = await published(f, actions({ tagIds: [], source: { kind: 'arrived' } }));
  expect(
    (await submit(form, { email: 'spring@example.test' }, { pageUrl: SPRING_AD })).result,
  ).toEqual(OK);
  expect((await leadsOf(f))['spring@example.test']).toEqual({
    source: 'Spring promo',
    tags: ['Campaign 120211', 'Paid lead'],
    touch: { rule: naming.id, label: 'Spring promo' },
    submission: { rule: naming.id, label: 'Spring promo' },
    // A field goes to the first matching rule that names it.
    fields: { lead_channel: 'Paid social', lead_season: 'Spring' },
  });
  const preview = await check(f, { url: SPRING_AD });
  expect(preview.rules?.map((each) => [each.position, each.decidesSource])).toEqual([
    [1, false],
    [2, true],
    [3, false],
  ]);
  expect(preview.rules?.[1]?.fieldWrites).toEqual([
    { fieldId: channel.id, label: 'lead_channel', value: 'Overwritten?', applies: false },
    { fieldId: season.id, label: 'lead_season', value: 'Spring', applies: true },
  ]);

  // A rule that names nothing leaves the name to the built-in rules.
  await submit(form, { email: 'autumn@example.test' }, { pageUrl: AUTUMN_AD });
  expect((await leadsOf(f))['autumn@example.test']).toMatchObject({
    source: 'Campaign by id',
    tags: ['Campaign 120211', 'Paid lead'],
  });
  await crm(f, 'deleteLeadSourceRule', { params: { ruleId: (await rulesOf(f)).items[2]?.id } });
  await submit(form, { email: 'later@example.test' }, { pageUrl: AUTUMN_AD });
  expect((await leadsOf(f))['later@example.test']).toMatchObject({
    source: 'Facebook Ads',
    tags: ['Paid lead'],
    touch: { rule: 'facebook_ads', label: 'Facebook Ads' },
    fields: { lead_channel: 'Paid social' },
  });
  // Reordered, the same rules name the next lead differently: only the order changed.
  const before = await rulesOf(f);
  expect(before.items.map((each) => each.name)).toEqual([
    'Paid social',
    'Spring campaign',
    'Google only',
    'Switched off',
  ]);
  expect(tagging.id).toBe(before.items[0]?.id);
});

it('adds at most ten tags a lead: the form’s own, the lead source’s, then the rules’', async () => {
  const f = await fixture();
  const own = await Promise.all(Array.from({ length: 8 }, (_, n) => tag(f, `Own ${String(n)}`)));
  const extra = await Promise.all(Array.from({ length: 3 }, (_, n) => tag(f, `Rule ${String(n)}`)));
  await rule(f, {
    name: 'Three more',
    conditions: [{ fact: 'medium', op: 'is', value: 'form' }],
    tagIds: extra,
  });
  const form = await published(
    f,
    actions({ tagIds: own, source: { kind: 'arrived' }, tagBySource: true }),
  );
  await submit(form, { email: 'full@example.test' }, { pageUrl: GOOGLE_AD });
  const { tags } = (await leadsOf(f))['full@example.test'] ?? { tags: [] };
  expect(tags).toHaveLength(10);
  expect(tags).toEqual([...own.map((_, n) => `Own ${String(n)}`), 'Rule 0', 'Source: Google Ads']);
  const preview = await check(f, { url: GOOGLE_AD, formId: form.id });
  expect(preview.form?.tags.map((each) => each.kind)).toEqual([
    ...own.map(() => 'form'),
    'source',
    'rule',
  ]);
});

it('keeps the lead when a rule’s tag or field is gone, and says so when the rule is read', async () => {
  const f = await fixture();
  const gone = await tag(f, 'Gone');
  const kept = await tag(f, 'Kept');
  const field = await suite.field(f, 'lead_note');
  const made = await rule(f, {
    name: 'Everything',
    conditions: [{ fact: 'landing_page', op: 'starts_with', value: WEBSITE }],
    source: 'Website',
    tagIds: [gone, kept],
    fieldWrites: [{ fieldId: field.id, value: 'From the website' }],
  });
  await suite.database.as('crm_owner', (sql) =>
    sql.query(`delete from crm.tags where business_id = $1 and name = 'Gone'`, [f.business.id]),
  );
  const form = await published(f, actions({ tagIds: [], source: { kind: 'arrived' } }));
  expect(
    (await submit(form, { email: 'a@example.test' }, { pageUrl: `${WEBSITE}/offer` })).result,
  ).toEqual(OK);
  expect((await leadsOf(f))['a@example.test']).toMatchObject({
    source: 'Website',
    tags: ['Kept'],
    fields: { lead_note: 'From the website' },
  });
  const read = leadSourceRule.parse(
    await crm(f, 'getLeadSourceRule', { params: { ruleId: made.id } }),
  );
  expect(read.problems).toEqual([expect.objectContaining({ code: 'tag_missing', id: gone })]);
  expect((await check(f, { url: `${WEBSITE}/offer` })).rules?.[0]?.tags).toEqual([
    { id: gone, name: null },
    { id: kept, name: 'Kept' },
  ]);
});

it('keeps the rules in an order with no gaps, and refuses a stale save or a stale order', async () => {
  const f = await fixture();
  const make = (name: string) =>
    rule(f, {
      name,
      conditions: [{ fact: 'utm_source', op: 'is', value: name }],
      source: name,
    });
  const [a, b, c] = [await make('a'), await make('b'), await make('c')];
  expect([a.position, b.position, c.position]).toEqual([1, 2, 3]);
  const list = await rulesOf(f);
  expect(list).toMatchObject({ limit: 50, canManage: true });
  expect(list.items.map((each) => each.name)).toEqual(['a', 'b', 'c']);

  // A save names the revision it read.
  const whole = {
    name: 'b renamed',
    enabled: true,
    conditions: b.conditions,
    source: 'B',
    tagIds: [],
    fieldWrites: [],
  };
  const saved = leadSourceRule.parse(
    await crm(f, 'updateLeadSourceRule', {
      params: { ruleId: b.id },
      body: { ...whole, revision: 1 },
    }),
  );
  expect(saved).toMatchObject({ name: 'b renamed', source: 'B', revision: 2, position: 2 });
  await expect(
    crm(f, 'updateLeadSourceRule', { params: { ruleId: b.id }, body: { ...whole, revision: 1 } }),
  ).rejects.toBeInstanceOf(ConflictError);

  // The list changed since it was read: the order is refused, and nothing moved.
  const order = { ruleIds: [c.id, a.id, b.id] };
  await expect(
    crm(f, 'reorderLeadSourceRules', { body: { ...order, revision: list.revision } }),
  ).rejects.toBeInstanceOf(ConflictError);
  const fresh = await rulesOf(f);
  expect(fresh.items.map((each) => each.name)).toEqual(['a', 'b renamed', 'c']);
  // Every rule once: a list that leaves one out or names a stranger is refused.
  for (const ruleIds of [
    [c.id, a.id],
    [c.id, a.id, 'lsr_01h455vb4pex5vsknk084sn02q'],
  ])
    await expect(
      crm(f, 'reorderLeadSourceRules', { body: { ruleIds, revision: fresh.revision } }),
    ).rejects.toBeInstanceOf(ValidationError);
  const moved = leadSourceRuleList.parse(
    await crm(f, 'reorderLeadSourceRules', { body: { ...order, revision: fresh.revision } }),
  );
  expect(moved.items.map((each) => [each.name, each.position])).toEqual([
    ['c', 1],
    ['a', 2],
    ['b renamed', 3],
  ]);
  // A reorder is not an edit of a rule: each keeps its revision.
  expect(moved.items.map((each) => each.revision)).toEqual([1, 1, 2]);

  // Deleting one moves the later ones up.
  await crm(f, 'deleteLeadSourceRule', { params: { ruleId: a.id } });
  expect((await rulesOf(f)).items.map((each) => [each.name, each.position])).toEqual([
    ['c', 1],
    ['b renamed', 2],
  ]);
  await expect(crm(f, 'deleteLeadSourceRule', { params: { ruleId: a.id } })).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

it('refuses a tag or a field a rule may not name, and a fifty-first rule', async () => {
  const f = await fixture();
  const other = await fixture();
  const theirs = await tag(other, 'Theirs');
  const number = await suite.field(f, 'lead_score', 'number');
  const base = {
    name: 'R',
    conditions: [{ fact: 'medium', op: 'is', value: 'form' }],
  };
  const refusal = async (does: unknown) =>
    crm(f, 'createLeadSourceRule', { body: { ...base, ...(does as object) } }).then(
      () => [],
      (error: unknown) =>
        error instanceof ValidationError
          ? error.issues.map((issue) => `${issue.path} ${issue.code}`)
          : [String(error)],
    );
  expect(await refusal({ tagIds: [theirs] })).toEqual(['/tagIds/0 invalid_tag']);
  expect(await refusal({ fieldWrites: [{ fieldId: number.id, value: '5' }] })).toEqual([
    '/fieldWrites/0/fieldId invalid_field',
  ]);
  expect((await rulesOf(f)).items).toEqual([]);

  for (let n = 1; n <= 50; n += 1)
    await rule(f, { ...base, name: `Rule ${String(n)}`, source: 'S' });
  expect(await refusal({ source: 'S' })).toEqual(['/name limit_reached']);
  const all = await rulesOf(f);
  expect(all.items).toHaveLength(50);
  expect(all.items.map((each) => each.position)).toEqual(
    Array.from({ length: 50 }, (_, n) => n + 1),
  );
  // The database holds the same bound, whatever asks.
  await expect(
    suite.database.withTenant(f.business.context, (sql) =>
      sql.query(
        `insert into crm.lead_source_rules
           (business_id, position, name, conditions, source_label, created_by_kind)
         values ($1, 51, 'One more', '[{"fact":"medium","op":"is","value":"form"}]', 'S', 'user')`,
        [f.business.id],
      ),
    ),
  ).rejects.toMatchObject({ constraint: 'lead_source_rules_position_valid' });
});

it('keeps one business’s rules from another: not listed, not found, not applied', async () => {
  const mine = await fixture();
  const theirs = await fixture();
  const made = await rule(mine, {
    name: 'Mine',
    conditions: [{ fact: 'medium', op: 'is', value: 'form' }],
    source: 'Mine only',
  });
  expect((await rulesOf(theirs)).items).toEqual([]);
  for (const [operationId, body] of [
    ['getLeadSourceRule', undefined],
    ['deleteLeadSourceRule', undefined],
    [
      'updateLeadSourceRule',
      {
        name: 'x',
        enabled: true,
        conditions: made.conditions,
        source: 'x',
        tagIds: [],
        fieldWrites: [],
        revision: 1,
      },
    ],
  ] as const)
    await expect(
      crm(theirs, operationId, { params: { ruleId: made.id }, body }),
      operationId,
    ).rejects.toBeInstanceOf(NotFoundError);
  const form = await published(theirs, actions({ tagIds: [], source: { kind: 'arrived' } }));
  await submit(form, { email: 'them@example.test' }, { pageUrl: GOOGLE_AD });
  expect((await leadsOf(theirs))['them@example.test']?.source).toBe('Google Ads');
  expect((await check(theirs, { url: GOOGLE_AD })).rules).toEqual([]);
  // Row-level security, not the query: asked for every row, the other business sees none.
  const seen = await suite.database.withTenant(theirs.business.context, (sql) =>
    sql.query<{ n: string }>('select count(*) as n from crm.lead_source_rules'),
  );
  expect(seen).toEqual([{ n: '0' }]);
  expect((await rulesOf(mine)).items).toHaveLength(1);
});

it('lets anyone in the business read the rules, and says who may change them', async () => {
  const f = await fixture();
  await rule(f, {
    name: 'R',
    conditions: [{ fact: 'medium', op: 'is', value: 'form' }],
    source: 'S',
  });
  const reader = { ...f.manager, permissions: new Set<never>() };
  const list = await rulesOf(f, reader);
  expect(list.items).toHaveLength(1);
  expect(list.canManage).toBe(false);
});
