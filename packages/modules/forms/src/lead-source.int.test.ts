// The lead source through a form, with the real public handlers against a migrated
// Postgres: the same form on the same page gives a lead from a Google ad and a lead from a
// Facebook ad two different Sources, two different tags and two different touches, with no
// setup; and "Check a link" says the same before anybody clicks.
import { randomUUID } from 'node:crypto';

import { allowEveryone, defineCommand, runCommand } from '@repo/commands';
import {
  DEFAULT_FORM_DEFINITION,
  formSubmissionList,
  leadSourcePreview,
  type FormDefinitionInput,
} from '@repo/contracts';
import { NotFoundError, ValidationError } from '@repo/kernel';
import { readLeadSourceDefault } from '@repo/module-crm';
import { expect, it } from 'vitest';
import * as z from 'zod';

import { formSuite, WEBSITE, type FormFixture } from '../test/form-fixtures.js';

const suite = formSuite();
const { fixture, published, submit, admin } = suite;
const OK = { outcome: 'ok', receipt: { status: 'received' } };

const GOOGLE_AD = `${WEBSITE}/offer?utm_source=google&utm_medium=cpc&utm_campaign=spring&campaign_id=111&ad_group_id=222&ad_id=333&gclid=Cj0abc`;
const FACEBOOK_AD = `${WEBSITE}/offer?utm_source=facebook&utm_medium=paid_social&utm_campaign=spring&campaign_id=120211&ad_id=120299&fbclid=IwAR0`;

const actions = (
  contactActions: NonNullable<FormDefinitionInput['contactActions']>,
): FormDefinitionInput => ({ ...DEFAULT_FORM_DEFINITION, contactActions });

interface Lead {
  readonly email: string;
  readonly source: string | null;
  readonly tags: string[];
  readonly touches: { readonly rule: string; readonly label: string; readonly session: string }[];
}

/** Every contact of the business with its Source, its tags and its touches, by email. */
async function leadsOf(f: FormFixture): Promise<Record<string, Omit<Lead, 'email'>>> {
  const rows = await suite.database.withTenant(f.business.context, (sql) =>
    sql.query<{
      email: string;
      source: string | null;
      tags: string[];
      touches: Lead['touches'];
    }>(
      `select i.value_normalized as email, c.source,
              coalesce((select array_agg(t.name order by t.name)
                        from crm.record_tags rt
                        join crm.tags t on t.business_id = rt.business_id and t.id = rt.tag_id
                        where rt.record_id = c.id), '{}') as tags,
              (select jsonb_agg(jsonb_build_object('rule', a.source_rule, 'label', a.source_label,
                                                   'session', a.session_source)
                                order by a.touched_at, a.id)
               from crm.contact_attributions a where a.contact_id = c.id) as touches
       from crm.contacts c
       join crm.contact_identities i
         on i.business_id = c.business_id and i.contact_id = c.id and i.kind = 'email'
       order by 1`,
    ),
  );
  return Object.fromEntries(rows.map(({ email, ...lead }) => [email, lead]));
}

const tag = async (f: FormFixture, name: string): Promise<{ id: string }> => {
  const { crmRoutes } = await import('@repo/module-crm');
  const route = crmRoutes.find((each) => each.endpoint.operationId === 'createTag');
  if (route === undefined) throw new Error('Missing createTag route.');
  return z
    .object({ id: z.string() })
    .parse(
      await route.run(
        { invocation: f.manager, params: {}, query: {}, body: { name } },
        { db: suite.db, authorize: allowEveryone },
      ),
    );
};

const submissionsOf = async (f: FormFixture, formId: string, query: unknown = {}) =>
  formSubmissionList.parse(
    await admin(f, 'listFormSubmissions', { params: { id: formId }, query }),
  );

const check = async (f: FormFixture, body: unknown) =>
  leadSourcePreview.parse(await admin(f, 'previewLeadSource', { body }));

it('gives two leads of one form two sources, two tags and two touches, with no setup', async () => {
  const f = await fixture();
  // The form a business starts with: nothing was chosen, no tag was made.
  const form = await published(f);
  expect(
    (await submit(form, { email: 'gina@example.test' }, { pageUrl: GOOGLE_AD })).result,
  ).toEqual(OK);
  expect(
    (
      await submit(
        form,
        { email: 'felix@example.test' },
        { pageUrl: FACEBOOK_AD, referrer: 'https://l.facebook.com/' },
      )
    ).result,
  ).toEqual(OK);
  expect(await leadsOf(f)).toEqual({
    'felix@example.test': {
      source: 'Facebook Ads',
      tags: ['Source: Facebook Ads'],
      touches: [{ rule: 'facebook_ads', label: 'Facebook Ads', session: 'paid_social' }],
    },
    'gina@example.test': {
      source: 'Google Ads',
      tags: ['Source: Google Ads'],
      touches: [{ rule: 'google_ads', label: 'Google Ads', session: 'paid_search' }],
    },
  });

  // The submissions say the same, newest first.
  const { items } = await submissionsOf(f, form.id);
  expect(items.map((item) => [item.leadSource, item.leadSourceRule])).toEqual([
    ['Facebook Ads', 'facebook_ads'],
    ['Google Ads', 'google_ads'],
  ]);

  // And an opportunity made for each lead would take a different source: the touch of the
  // submission that started it (what a workflow's Create opportunity step reads).
  const sources = await suite.database.withTenant(f.business.context, (sql) =>
    sql.query<{ contact_id: string; id: string }>(
      `select contact_id, id from forms.submissions order by id`,
    ),
  );
  const defaults = defineCommand({
    name: 'test.lead_source.deal_default',
    permission: 'contacts.manage',
    input: z.strictObject({}),
    handle: (trx, _input, command) =>
      Promise.all(
        sources.map((row) =>
          readLeadSourceDefault(trx, command.context.businessId ?? '', {
            contactId: row.contact_id,
            subject: { kind: 'form_submission', id: row.id },
          }),
        ),
      ),
  });
  expect(
    await runCommand({ db: suite.db, authorize: allowEveryone }, defaults, {}, f.manager),
  ).toEqual(['Google Ads', 'Facebook Ads']);

  // The tags are the system's, in its own group; nobody made them.
  const tags = await suite.database.withTenant(f.business.context, (sql) =>
    sql.query(
      `select t.name, t.system_key, t.created_by_kind, g.name as "group"
       from crm.tags t join crm.tag_groups g on g.business_id = t.business_id and g.id = t.group_id
       order by t.name`,
    ),
  );
  expect(tags).toEqual([
    {
      name: 'Source: Facebook Ads',
      system_key: 'lead_source:facebook_ads',
      created_by_kind: 'system',
      group: 'Lead source',
    },
    {
      name: 'Source: Google Ads',
      system_key: 'lead_source:google_ads',
      created_by_kind: 'system',
      group: 'Lead source',
    },
  ]);
});

it('keeps the Source of a contact that has one, and still adds the tag of each return', async () => {
  const f = await fixture();
  const vip = await tag(f, 'Wedding enquiry');
  const form = await published(
    f,
    actions({ tagIds: [vip.id], source: { kind: 'arrived' }, tagBySource: true }),
  );
  await submit(form, { email: 'maya@example.test' }, { pageUrl: GOOGLE_AD });
  // The same person comes back from a Facebook ad, and then by typing the address.
  await submit(form, { email: 'maya@example.test' }, { pageUrl: FACEBOOK_AD });
  await submit(form, { email: 'maya@example.test' }, { pageUrl: `${WEBSITE}/offer` });
  expect(await leadsOf(f)).toEqual({
    'maya@example.test': {
      // The first source is the source; it is written once.
      source: 'Google Ads',
      tags: ['Source: Direct', 'Source: Facebook Ads', 'Source: Google Ads', 'Wedding enquiry'],
      touches: [
        { rule: 'google_ads', label: 'Google Ads', session: 'paid_search' },
        { rule: 'facebook_ads', label: 'Facebook Ads', session: 'paid_social' },
        { rule: 'direct', label: 'Direct', session: 'direct' },
      ],
    },
  });
});

it('lets a name the business wrote beat the rules, and the form’s name or nothing be chosen', async () => {
  const f = await fixture();
  const fixed = await published(f, actions({ source: { kind: 'text', text: 'Trade fair 2026' } }));
  const named = await published(f, actions({ source: { kind: 'form_name' }, tagBySource: true }));
  const silent = await published(f, actions({ source: { kind: 'none' } }));
  const bare = await published(f, { ...DEFAULT_FORM_DEFINITION, contactActions: undefined });
  // source= in the address is a rule too: the fixed name beats it as well.
  await submit(fixed, { email: 'fixed@example.test' }, { pageUrl: `${GOOGLE_AD}&source=Radio` });
  await submit(named, { email: 'named@example.test' }, { pageUrl: FACEBOOK_AD });
  await submit(silent, { email: 'silent@example.test' }, { pageUrl: GOOGLE_AD });
  await submit(bare, { email: 'bare@example.test' }, { pageUrl: GOOGLE_AD });
  expect(await leadsOf(f)).toEqual({
    'bare@example.test': {
      source: null,
      tags: [],
      touches: [{ rule: 'google_ads', label: 'Google Ads', session: 'paid_search' }],
    },
    'fixed@example.test': {
      source: 'Trade fair 2026',
      tags: [],
      // The touch says how they arrived, whatever the form wrote as the Source.
      touches: [{ rule: 'source_param', label: 'Radio', session: 'paid_search' }],
    },
    'named@example.test': {
      source: 'Enquiry',
      // The tag is of how they arrived, not of the form's choice of Source.
      tags: ['Source: Facebook Ads'],
      touches: [{ rule: 'facebook_ads', label: 'Facebook Ads', session: 'paid_social' }],
    },
    'silent@example.test': {
      source: null,
      tags: [],
      touches: [{ rule: 'google_ads', label: 'Google Ads', session: 'paid_search' }],
    },
  });
});

it('takes source= as the Source, and makes no tag of a name an address chose', async () => {
  const f = await fixture();
  const form = await published(f);
  await tag(f, 'Source: Spring flyer');
  await submit(
    form,
    { email: 'a@example.test' },
    { pageUrl: `${WEBSITE}/offer?source=Spring+flyer` },
  );
  // Anyone can write an address: a name nobody made a tag for adds none, and makes none.
  for (const name of ['Free money', 'x'.repeat(120), 'Buy <b>now</b>'])
    await submit(
      form,
      { email: `${randomUUID()}@example.test` },
      { pageUrl: `${WEBSITE}/offer?source=${encodeURIComponent(name)}` },
    );
  const leads = await leadsOf(f);
  expect(leads['a@example.test']).toEqual({
    source: 'Spring flyer',
    tags: ['Source: Spring flyer'],
    touches: [{ rule: 'source_param', label: 'Spring flyer', session: 'direct' }],
  });
  expect(
    Object.values(leads)
      .map((lead) => lead.source)
      .sort(),
  ).toEqual(['Buy <b>now</b>', 'Free money', 'Spring flyer', 'x'.repeat(120)].sort());
  const tags = await suite.database.withTenant(f.business.context, (sql) =>
    sql.query<{ name: string }>(`select name from crm.tags order by name`),
  );
  expect(tags).toEqual([{ name: 'Source: Spring flyer' }]);
});

it('adds at most ten tags a submission: the form’s own first, then the lead source’s', async () => {
  const f = await fixture();
  const own = [];
  for (let index = 0; index < 10; index += 1) own.push(await tag(f, `Own ${String(index)}`));
  const full = await published(
    f,
    actions({ tagIds: own.map((each) => each.id), source: { kind: 'arrived' }, tagBySource: true }),
  );
  const nine = await published(
    f,
    actions({
      tagIds: own.slice(0, 9).map((each) => each.id),
      source: { kind: 'arrived' },
      tagBySource: true,
    }),
  );
  await submit(full, { email: 'full@example.test' }, { pageUrl: GOOGLE_AD });
  await submit(nine, { email: 'nine@example.test' }, { pageUrl: GOOGLE_AD });
  const leads = await leadsOf(f);
  expect(leads['full@example.test']?.tags).toHaveLength(10);
  expect(leads['full@example.test']?.tags).not.toContain('Source: Google Ads');
  expect(leads['nine@example.test']?.tags).toHaveLength(10);
  expect(leads['nine@example.test']?.tags).toContain('Source: Google Ads');
  // A form may not name an eleventh of its own.
  const extra = await tag(f, 'Own 10');
  await expect(
    published(f, actions({ tagIds: [...own, extra].map((each) => each.id) })),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('keeps the lead when the lead source’s tag was deleted, and makes it again', async () => {
  const f = await fixture();
  const form = await published(f);
  await submit(form, { email: 'one@example.test' }, { pageUrl: GOOGLE_AD });
  await suite.database.as('crm_owner', (sql) =>
    sql.query(`delete from crm.tags where business_id = $1`, [f.business.id]),
  );
  expect(
    (await submit(form, { email: 'two@example.test' }, { pageUrl: GOOGLE_AD })).result,
  ).toEqual(OK);
  const leads = await leadsOf(f);
  expect(leads['one@example.test']?.tags).toEqual([]);
  expect(leads['two@example.test']?.tags).toEqual(['Source: Google Ads']);
});

it('keeps the lead source and the touch of a submission whose details name two contacts', async () => {
  const f = await fixture();
  const form = await published(f);
  // Two contacts hold the two addresses a submission gives: the email's contact takes it.
  const both = await published(f, {
    ...DEFAULT_FORM_DEFINITION,
    fields: [
      ...DEFAULT_FORM_DEFINITION.fields,
      {
        key: 'phone',
        type: 'phone',
        label: 'Phone',
        helpText: '',
        required: false,
        options: [],
        target: { kind: 'contact', attribute: 'phone' },
      },
    ],
  });
  await submit(both, { email: 'first@example.test', phone: '+12025550101' });
  await submit(both, { email: 'second@example.test', phone: '+12025550102' });
  await submit(
    both,
    { email: 'first@example.test', phone: '+12025550102' },
    { pageUrl: FACEBOOK_AD },
  );
  const { items } = await submissionsOf(f, both.id);
  expect(items[0]).toMatchObject({
    contactId: items[2]?.contactId,
    contactOutcome: 'updated',
    leadSource: 'Facebook Ads',
    leadSourceRule: 'facebook_ads',
  });
  // The click id is kept on the contact the visitor became, once.
  const touches = await suite.database.withTenant(f.business.context, (sql) =>
    sql.query<{ count: string }>(
      `select count(*)::text as count from crm.contact_attributions where fbclid is not null`,
    ),
  );
  expect(touches).toEqual([{ count: '1' }]);
  expect((await submissionsOf(f, form.id)).items).toEqual([]);
});

it('lists only the submissions of one lead source when asked, by the rule and not the name', async () => {
  const f = await fixture();
  const form = await published(f);
  const other = await published(f);
  const sent = [
    ['gina@example.test', { pageUrl: GOOGLE_AD }],
    ['felix@example.test', { pageUrl: FACEBOOK_AD, referrer: 'https://l.facebook.com/' }],
    ['gail@example.test', { pageUrl: `${WEBSITE}/offer?gclid=second` }],
    ['fay@example.test', { pageUrl: `${WEBSITE}/offer?source=Trade%20fair` }],
    ['dina@example.test', { pageUrl: `${WEBSITE}/offer` }],
  ] as const;
  for (const [email, visit] of sent)
    expect((await submit(form, { email }, visit)).result, email).toEqual(OK);
  // Another form's Google lead is no part of this form's list.
  expect(
    (await submit(other, { email: 'gus@example.test' }, { pageUrl: GOOGLE_AD })).result,
  ).toEqual(OK);

  const sources = async (query: unknown) =>
    (await submissionsOf(f, form.id, query)).items.map((item) => item.leadSource);
  expect(await sources({})).toEqual([
    'Direct',
    'Trade fair',
    'Google Ads',
    'Facebook Ads',
    'Google Ads',
  ]);
  expect(await sources({ leadSourceRule: 'google_ads' })).toEqual(['Google Ads', 'Google Ads']);
  expect(await sources({ leadSourceRule: 'facebook_ads' })).toEqual(['Facebook Ads']);
  expect(await sources({ leadSourceRule: 'direct' })).toEqual(['Direct']);
  // A name a link chose is found by its rule, whatever the name.
  expect(await sources({ leadSourceRule: 'source_param' })).toEqual(['Trade fair']);
  expect(await sources({ leadSourceRule: 'tiktok_ads' })).toEqual([]);

  // Page by page, the filter holds: the cursor is the last one shown of that source.
  const first = await submissionsOf(f, form.id, { leadSourceRule: 'google_ads', limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).toBe(first.items[0]?.id);
  const second = await submissionsOf(f, form.id, {
    leadSourceRule: 'google_ads',
    limit: 1,
    after: first.nextCursor,
  });
  expect(second.items.map((item) => item.leadSourceRule)).toEqual(['google_ads']);
  expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  expect(second.nextCursor).toBeNull();

  // The vocabulary is the contract's closed list: a name, or a key nobody ships, is refused.
  for (const leadSourceRule of ['Google Ads', 'vip', ''])
    await expect(
      admin(f, 'listFormSubmissions', { params: { id: form.id }, query: { leadSourceRule } }),
      leadSourceRule,
    ).rejects.toBeInstanceOf(ValidationError);
});

it('checks a link: the same answer a submission would get, and nothing stored', async () => {
  const f = await fixture();
  const wedding = await tag(f, 'Wedding enquiry');
  const form = await published(
    f,
    actions({ tagIds: [wedding.id], source: { kind: 'arrived' }, tagBySource: true }),
  );
  const before = await suite.stored(f);

  const google = await check(f, { url: GOOGLE_AD, formId: form.id });
  expect(google).toMatchObject({
    sessionSource: 'paid_search',
    source: 'Google Ads',
    sourceRule: 'google_ads',
    facts: {
      utmSource: 'google',
      utmMedium: 'cpc',
      campaignId: '111',
      adGroupId: '222',
      adId: '333',
      landingUrl: `${WEBSITE}/offer`,
    },
    clickIds: ['gclid'],
    form: {
      id: form.id,
      contactSource: 'Google Ads',
      tags: [
        { name: 'Wedding enquiry', kind: 'form', exists: true },
        // Not made yet: the first such lead makes it.
        { name: 'Source: Google Ads', kind: 'source', exists: false },
      ],
    },
    warnings: [],
  });
  // The click id's value is nowhere in the answer.
  expect(JSON.stringify(google)).not.toContain('Cj0abc');

  expect(
    await check(f, { url: FACEBOOK_AD, referrer: 'https://l.facebook.com/l.php?u=x' }),
  ).toMatchObject({
    sessionSource: 'paid_social',
    source: 'Facebook Ads',
    sourceRule: 'facebook_ads',
    facts: { referrerDomain: 'l.facebook.com' },
    clickIds: ['fbclid'],
    form: null,
  });

  // What a link is missing, in words.
  const codes = async (url: string, formId?: string) =>
    (await check(f, { url, ...(formId === undefined ? {} : { formId }) })).warnings.map(
      (warning) => warning.code,
    );
  expect(await codes(`${WEBSITE}/offer`)).toEqual(['no_tracking']);
  expect(await codes(`${WEBSITE}/offer?fbclid=IwAR0`)).toEqual(['click_id_only']);
  expect(await codes(`${WEBSITE}/offer?source=Radio`, form.id)).toEqual(['source_param', 'no_tag']);
  expect(await codes(`${WEBSITE}/offer?utm_source=newsletter&utm_medium=email`)).toEqual([]);

  // After a real lead the tag is there, and the preview says so.
  await submit(form, { email: 'gina@example.test' }, { pageUrl: GOOGLE_AD });
  expect((await check(f, { url: GOOGLE_AD, formId: form.id })).form?.tags).toEqual([
    { name: 'Wedding enquiry', kind: 'form', exists: true },
    { name: 'Source: Google Ads', kind: 'source', exists: true },
  ]);
  const after = await suite.stored(f);
  expect(after).toEqual({
    ...before,
    submissions: before.submissions + 1,
    contacts: before.contacts + 1,
    events: after.events,
  });

  // A form with a fixed name, the form's name, ten tags of its own.
  const fixed = await published(f, actions({ source: { kind: 'text', text: 'Trade fair' } }));
  expect((await check(f, { url: GOOGLE_AD, formId: fixed.id })).form).toEqual({
    id: fixed.id,
    contactSource: 'Trade fair',
    tags: [],
  });
  const none = await published(f, actions({ source: { kind: 'none' } }));
  expect((await check(f, { url: GOOGLE_AD, formId: none.id })).form?.contactSource).toBeNull();
  const own = [];
  for (let index = 0; index < 10; index += 1) own.push(await tag(f, `Own ${String(index)}`));
  const full = await published(
    f,
    actions({
      tagIds: own.map((each) => each.id),
      source: { kind: 'form_name' },
      tagBySource: true,
    }),
  );
  const crowded = await check(f, { url: GOOGLE_AD, formId: full.id });
  expect(crowded.form?.contactSource).toBe('Enquiry');
  expect(crowded.form?.tags).toHaveLength(10);
  expect(crowded.warnings.map((warning) => warning.code)).toEqual(['too_many_tags']);
});

it('checks a link only for a form of the business, and only a web address', async () => {
  const f = await fixture();
  const other = await fixture();
  const theirs = await published(other);
  await expect(check(f, { url: GOOGLE_AD, formId: theirs.id })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(
    check(f, { url: GOOGLE_AD, formId: 'form_01h455vb4pex5vsknk084sn02q' }),
  ).rejects.toBeInstanceOf(NotFoundError);
  for (const body of [{}, { url: 'not an address' }, { url: 'ftp://example.com/' }])
    await expect(check(f, body)).rejects.toBeInstanceOf(ValidationError);
  // Someone who may only read can ask: it is a read.
  const reader = { ...f.manager, permissions: new Set(['assistant.use'] as const) };
  expect(
    leadSourcePreview.parse(
      await admin(f, 'previewLeadSource', { body: { url: GOOGLE_AD } }, reader),
    ).source,
  ).toBe('Google Ads');
});

// The arrival survives the funnel: the form is on step 2, the ad's
// labels were in the address of step 1, and the page's own script hands that first address
// over with the form.
it('names a lead after the page the visit began on when the form’s own page says nothing', async () => {
  const f = await fixture();
  const form = await published(f);
  const step2 = `${WEBSITE}/details`;
  const first = { pageUrl: GOOGLE_AD, referrer: 'https://www.google.com', at: suite.now() };
  const carried = await submit(form, { email: 'gina@example.test' }, { pageUrl: step2, first });
  expect(carried.result).toEqual(OK);
  // The same form, the same page, nothing handed over: Direct, as before.
  expect((await submit(form, { email: 'dina@example.test' }, { pageUrl: step2 })).result).toEqual(
    OK,
  );
  // The page's own labels win over what was carried.
  expect(
    (
      await submit(
        form,
        { email: 'felix@example.test' },
        { pageUrl: FACEBOOK_AD.replace('/offer', '/details'), first },
      )
    ).result,
  ).toEqual(OK);
  // A first page on another website is not believed, and neither is one from long ago.
  expect(
    (
      await submit(
        form,
        { email: 'rita@example.test' },
        {
          pageUrl: step2,
          first: { pageUrl: GOOGLE_AD.replace(WEBSITE, 'https://www.rival.example') },
        },
      )
    ).result,
  ).toEqual(OK);
  expect(
    (
      await submit(
        form,
        { email: 'olga@example.test' },
        { pageUrl: step2, first: { ...first, at: suite.now() - 91 * 86_400_000 } },
      )
    ).result,
  ).toEqual(OK);

  const leads = await leadsOf(f);
  expect(
    Object.fromEntries(Object.entries(leads).map(([email, lead]) => [email, lead.source])),
  ).toEqual({
    'gina@example.test': 'Google Ads',
    'dina@example.test': 'Direct',
    'felix@example.test': 'Facebook Ads',
    'rita@example.test': 'Direct',
    'olga@example.test': 'Direct',
  });
  expect(leads['gina@example.test']?.tags).toEqual(['Source: Google Ads']);
  const touches = await suite.database.withTenant(f.business.context, (sql) =>
    sql.query<{ email: string; landing_url: string; page_url: string; carried: boolean }>(
      `select i.value_normalized as email, a.landing_url, a.page_url, a.arrival_carried as carried
       from crm.contact_attributions a
       join crm.contact_identities i
         on i.business_id = a.business_id and i.contact_id = a.contact_id and i.kind = 'email'
       order by i.value_normalized`,
    ),
  );
  expect(touches).toEqual([
    { email: 'dina@example.test', landing_url: step2, page_url: step2, carried: false },
    { email: 'felix@example.test', landing_url: step2, page_url: step2, carried: false },
    // Where the visit began, and where the lead was taken.
    { email: 'gina@example.test', landing_url: `${WEBSITE}/offer`, page_url: step2, carried: true },
    { email: 'olga@example.test', landing_url: step2, page_url: step2, carried: false },
    { email: 'rita@example.test', landing_url: step2, page_url: step2, carried: false },
  ]);

  // The submission keeps its own page, and the campaign labels of the arrival it was named by.
  const { items } = await submissionsOf(f, form.id, { leadSourceRule: 'google_ads' });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    leadSource: 'Google Ads',
    pageUrl: step2,
    utm: { source: 'google', medium: 'cpc', campaign: 'spring' },
  });

  // How the visit began is part of what was sent: the same request again is stored once,
  // and the same id with another arrival is another request.
  const once = await submissionsOf(f, form.id);
  expect(await suite.handlers.submit(carried.admission, carried.input, suite.visitor())).toEqual(
    OK,
  );
  expect(
    await suite.handlers.submit(
      carried.admission,
      { ...carried.input, first: { ...first, pageUrl: `${GOOGLE_AD}&x=1` } },
      suite.visitor(),
    ),
  ).toEqual({ outcome: 'changed' });
  const { first: _dropped, ...without } = carried.input;
  expect(await suite.handlers.submit(carried.admission, without, suite.visitor())).toEqual({
    outcome: 'changed',
  });
  expect((await submissionsOf(f, form.id)).items).toHaveLength(once.items.length);
});
