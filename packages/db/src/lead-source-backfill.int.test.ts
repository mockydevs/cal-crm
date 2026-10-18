// Migration 0091 over an install that already has touches, submissions and forms: a
// database is migrated up to the migration before it, rows are stored as the modules stored
// them then, and the runner applies 0091 as it does on an upgrade.
// - every touch that was a visit to a page gets its lead source, by the rules of
//   packages/modules/crm/src/attribution/lead-source.ts written in SQL. The table below is
//   that module's own table of cases (packages/modules/crm/test/lead-source-cases.ts), as
//   the facts a touch stored before 0091 and the outcome the module gave on 2026-10-13:
//   the migration is held to what the module decided on the day it was written;
// - a submission takes the lead source of its touch;
// - a form that gave "the name of this form" as the Source now reads how they arrived and
//   adds the tag, in its draft and in what it has published; every other form keeps what
//   it said.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPostgres, type Postgres } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const LEAD_SOURCE = '0091_lead_source.sql';

/** A case: its name, the columns the touch had, and the rule that names it. */
type Case = readonly [string, Readonly<Record<string, string>>, string];

const CASES: readonly Case[] = [
  ['an empty source= is no source', { gclid: 'abc' }, 'google_ads'],
  ['utm_source is not source', { utm_source: 'flyer' }, 'other'],
  ['gclid', { gclid: 'abc' }, 'google_ads'],
  ['gbraid', { gbraid: 'abc' }, 'google_ads'],
  ['wbraid', { wbraid: 'abc' }, 'google_ads'],
  ['utm_source adwords', { utm_source: 'adwords' }, 'google_ads'],
  ['utm_source containing AdWords, any case', { utm_source: 'Google-AdWords-US' }, 'google_ads'],
  ['google with cpc and no click id', { utm_source: 'google', utm_medium: 'cpc' }, 'google_ads'],
  [
    'google with a paid medium in capitals',
    { utm_source: 'Google', utm_medium: 'PPC' },
    'google_ads',
  ],
  ['google with a campaign id', { utm_source: 'google', campaign_id: '111' }, 'google_ads'],
  [
    'a paid medium, having come from Google',
    { utm_medium: 'cpc', referrer_domain: 'www.google.com' },
    'google_ads',
  ],
  [
    'a Google click id beats a Facebook source',
    { utm_source: 'facebook', utm_medium: 'cpc', gclid: 'abc' },
    'google_ads',
  ],
  ['a Google click id beats a Microsoft one', { gclid: 'abc', msclkid: 'def' }, 'google_ads'],
  ['msclkid', { msclkid: 'abc' }, 'microsoft_ads'],
  ['bing with cpc', { utm_source: 'bing', utm_medium: 'cpc' }, 'microsoft_ads'],
  [
    'microsoft with a paid medium',
    { utm_source: 'microsoft', utm_medium: 'paid' },
    'microsoft_ads',
  ],
  [
    'a paid medium, having come from Bing',
    { utm_medium: 'ppc', referrer_domain: 'www.bing.com' },
    'microsoft_ads',
  ],
  ["GoHighLevel's fb_ad", { utm_source: 'fb_ad' }, 'facebook_ads'],
  ['facebook with cpc', { utm_source: 'facebook', utm_medium: 'cpc' }, 'facebook_ads'],
  [
    'facebook with paid_social',
    { utm_source: 'facebook', utm_medium: 'paid_social' },
    'facebook_ads',
  ],
  ['meta with paid', { utm_source: 'meta', utm_medium: 'paid' }, 'facebook_ads'],
  ['fbclid with a paid medium', { utm_medium: 'paidsocial', fbclid: 'abc' }, 'facebook_ads'],
  ['fbclid with a campaign id', { campaign_id: '120211', fbclid: 'abc' }, 'facebook_ads'],
  ['fbclid with an ad id', { ad_id: '77', fbclid: 'abc' }, 'facebook_ads'],
  [
    'a paid medium, having come from Facebook',
    { utm_medium: 'cpc', referrer_domain: 'l.facebook.com' },
    'facebook_ads',
  ],
  ['a click-to-WhatsApp id', { ctwa_clid: 'abc' }, 'facebook_ads'],
  ['instagram with cpc', { utm_source: 'instagram', utm_medium: 'cpc' }, 'instagram_ads'],
  ['ig with a paid medium', { utm_source: 'ig', utm_medium: 'paid_social' }, 'instagram_ads'],
  [
    'instagram named by the link, with fbclid and an ad id',
    { utm_source: 'instagram', ad_id: '9', fbclid: 'abc' },
    'instagram_ads',
  ],
  [
    'a paid medium, having come from Instagram',
    { utm_medium: 'retargeting', referrer_domain: 'www.instagram.com' },
    'instagram_ads',
  ],
  [
    'a click-to-WhatsApp id on a link that names Instagram',
    { utm_source: 'instagram', ctwa_clid: 'abc' },
    'instagram_ads',
  ],
  ['tiktok with cpc', { utm_source: 'tiktok', utm_medium: 'cpc' }, 'tiktok_ads'],
  ['linkedin with cpc', { utm_source: 'linkedin', utm_medium: 'cpc' }, 'linkedin_ads'],
  ["GoHighLevel's linkedin_ad", { utm_source: 'linkedin_ad' }, 'linkedin_ads'],
  ['a paid medium alone', { utm_medium: 'cpc' }, 'paid_other'],
  [
    'a paid medium on an unknown source',
    { utm_source: 'taboola', utm_medium: 'cpc' },
    'paid_other',
  ],
  ["GoHighLevel's twitter_ad", { utm_source: 'twitter_ad' }, 'paid_other'],
  ["GoHighLevel's reddit_ad", { utm_source: 'reddit_ad' }, 'paid_other'],
  ['x with cpc', { utm_source: 'x', utm_medium: 'cpc' }, 'paid_other'],
  [
    'a campaign id alone is not a paid medium',
    { utm_source: 'taboola', campaign_id: '5' },
    'other',
  ],
  ['utm_medium email', { utm_source: 'newsletter', utm_medium: 'email' }, 'email'],
  ['utm_medium e-mail', { utm_medium: 'E-mail' }, 'email'],
  ['utm_source email', { utm_source: 'email' }, 'email'],
  [
    'an email link opened from a webmail site',
    { utm_medium: 'email', referrer_domain: 'mail.partner.example' },
    'email',
  ],
  [
    'an email link with a campaign id is still email',
    { utm_source: 'newsletter', utm_medium: 'email', campaign_id: '44' },
    'email',
  ],
  ['utm_medium sms', { utm_source: 'reminder', utm_medium: 'sms' }, 'sms'],
  ['a medium that only contains email', { utm_medium: 'emailer' }, 'other'],
  ['having come from Google', { referrer_domain: 'www.google.com' }, 'organic_search'],
  ['having come from Bing', { referrer_domain: 'www.bing.com' }, 'organic_search'],
  ['having come from DuckDuckGo', { referrer_domain: 'duckduckgo.com' }, 'organic_search'],
  ['having come from Brave Search', { referrer_domain: 'search.brave.com' }, 'organic_search'],
  [
    'google named by the link, unpaid',
    { utm_source: 'google', utm_medium: 'organic' },
    'organic_search',
  ],
  ['having come from Facebook', { referrer_domain: 'm.facebook.com' }, 'facebook'],
  ['fbclid alone', { fbclid: 'abc' }, 'facebook'],
  [
    'fbclid, having come from Instagram',
    { fbclid: 'abc', referrer_domain: 'l.instagram.com' },
    'instagram',
  ],
  [
    'fbclid with a paid medium, having come from Instagram',
    { utm_medium: 'cpc', fbclid: 'abc', referrer_domain: 'l.instagram.com' },
    'instagram_ads',
  ],
  [
    'facebook named by the link, unpaid',
    { utm_source: 'facebook', utm_medium: 'social' },
    'facebook',
  ],
  ['having come from Instagram', { referrer_domain: 'www.instagram.com' }, 'instagram'],
  ['having come from LinkedIn', { referrer_domain: 'www.linkedin.com' }, 'linkedin'],
  ['a LinkedIn short link', { referrer_domain: 'lnkd.in' }, 'linkedin'],
  ['having come from TikTok', { referrer_domain: 'www.tiktok.com' }, 'tiktok'],
  ['having come from YouTube', { referrer_domain: 'www.youtube.com' }, 'youtube'],
  ['a YouTube short link', { referrer_domain: 'youtu.be' }, 'youtube'],
  ['having come from X', { referrer_domain: 'x.com' }, 'x'],
  ['t.co', { referrer_domain: 't.co' }, 'x'],
  ['having come from Reddit', { referrer_domain: 'www.reddit.com' }, 'social'],
  ['pinterest named by the link', { utm_source: 'pinterest' }, 'social'],
  ['another site', { referrer_domain: 'blog.partner.example' }, 'referral'],
  [
    'a label no rule names, having come from another site',
    { utm_source: 'partner', referrer_domain: 'blog.partner.example' },
    'referral',
  ],
  [
    'a site whose name only ends like a short social one',
    { referrer_domain: 'notx.com' },
    'referral',
  ],
  ['utm_campaign alone', { utm_campaign: 'spring' }, 'other'],
  ['a source that names nothing', { utm_source: 'fbx' }, 'other'],
  ['no label and no site', {}, 'direct'],
  ['a page on the same site before it', {}, 'direct'],
  ['a parameter nobody reads', {}, 'direct'],
  // Hosts and words the module's table reaches by other roads.
  ['a short Facebook address', { referrer_domain: 'fb.me' }, 'facebook'],
  ['Messenger', { referrer_domain: 'l.messenger.com' }, 'facebook'],
  ['a host under x.com', { referrer_domain: 'mobile.x.com' }, 'x'],
  ['Twitter by its old name', { referrer_domain: 'twitter.com' }, 'x'],
  ['WhatsApp short link', { referrer_domain: 'wa.me' }, 'social'],
  ['Yahoo', { referrer_domain: 'uk.search.yahoo.com' }, 'organic_search'],
  ['a top-level domain named google', { referrer_domain: 'about.google' }, 'referral'],
  ['a host with one label', { referrer_domain: 'localhost' }, 'referral'],
  ['a word that only starts like one', { utm_source: 'fbx' }, 'other'],
  ['ig with a paid medium', { utm_source: 'IG-Story', utm_medium: 'Paid_Social' }, 'instagram_ads'],
  ['a campaign id alone', { campaign_id: '5' }, 'other'],
  ['an ad group id alone', { ad_group_id: '5' }, 'other'],
  ['a match type alone', { match_type: 'e' }, 'other'],
];

const LABELS: Readonly<Record<string, string>> = {
  google_ads: 'Google Ads',
  microsoft_ads: 'Microsoft Ads',
  facebook_ads: 'Facebook Ads',
  instagram_ads: 'Instagram Ads',
  tiktok_ads: 'TikTok Ads',
  linkedin_ads: 'LinkedIn Ads',
  paid_other: 'Paid (other)',
  email: 'Email',
  sms: 'SMS',
  organic_search: 'Organic Search',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  social: 'Social',
  referral: 'Referral',
  other: 'Other',
  direct: 'Direct',
};

const COLUMNS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'match_type',
  'campaign_id',
  'ad_group_id',
  'ad_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'ctwa_clid',
  'referrer_domain',
] as const;

let postgres: Postgres;
let earlier: string;
beforeAll(async () => {
  postgres = await startPostgres({ bootstrapFile });
  earlier = await mkdtemp(join(tmpdir(), 'crm-before-lead-source-'));
  for (const name of await readdir(migrationsDirectory))
    if (name < LEAD_SOURCE) await cp(join(migrationsDirectory, name), join(earlier, name));
});
afterAll(async () => {
  await postgres.stop();
  await rm(earlier, { recursive: true, force: true });
});

it('names the touches, the submissions and the forms an install already had', async () => {
  const database = await postgres.createDatabase();
  const connectionString = postgres.url(database);
  const before = await migrate({ connectionString, directory: earlier });
  expect(before.applied).not.toContain(LEAD_SOURCE);

  // crm_owner, as an import or a repair would write: it is not held to a tenant.
  const owner = new pg.Client({ connectionString });
  await owner.connect();
  try {
    const one = async (text: string, values: readonly unknown[] = []): Promise<string> => {
      const { rows } = await owner.query<{ id: string }>(text, [...values]);
      const [row] = rows;
      if (row === undefined) throw new Error(`No row: ${text}`);
      return row.id;
    };
    const agency = await one(
      "insert into tenancy.agencies (name, slug) values ('Agency', 'agency') returning id",
    );
    const business = await one(
      "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
      [agency],
    );
    const objectType = await one(
      `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
       values ($1, 'contact', 'contact', 'Contact', 'Contacts') returning id`,
      [business],
    );
    const contact = (): Promise<string> =>
      one(
        `with record as (
           insert into crm.records (business_id, kind, object_type_id)
           values ($1, 'contact', $2) returning id)
         insert into crm.contacts (business_id, id, first_name, created_by_kind, created_source)
         select $1, id, 'Maya', 'system', 'form' from record returning id`,
        [business, objectType],
      );

    // One contact carries every case, as touches of a form, in the table's order.
    const visitor = await contact();
    for (const [index, [, facts]] of CASES.entries())
      await owner.query(
        `insert into crm.contact_attributions
           (business_id, contact_id, touched_at, medium, session_source, subject_kind, subject_id,
            landing_url, ${COLUMNS.join(', ')})
         values ($1, $2, timestamptz '2026-09-01T09:00:00Z' + make_interval(secs => $3), 'form',
                 'others', 'contact', $2, 'https://www.example.com/offer',
                 ${COLUMNS.map((_, place) => `$${String(place + 4)}`).join(', ')})`,
        [business, visitor, index, ...COLUMNS.map((column) => facts[column] ?? null)],
      );
    // Touches that were no visit to a page: by hand, by an import, by a message.
    const offline = await contact();
    for (const medium of [
      'manual',
      'api',
      'import',
      'message',
      'automation',
      'assistant',
      'unknown',
    ])
      await owner.query(
        `insert into crm.contact_attributions
           (business_id, contact_id, medium, session_source, utm_source, gclid, subject_kind, subject_id)
         values ($1, $2, $3, 'others', 'adwords', 'abc', 'contact', $2)`,
        [business, offline, medium],
      );
    // A booking and a chat are visits: with nothing known, Direct.
    const booker = await contact();
    for (const medium of ['calendar', 'chat'])
      await owner.query(
        `insert into crm.contact_attributions
           (business_id, contact_id, medium, session_source, subject_kind, subject_id)
         values ($1, $2, $3, 'direct', 'contact', $2)`,
        [business, booker, medium],
      );

    // Forms, by what each said of the Source, as draft and as published.
    const named = { tagIds: [], source: { kind: 'form_name' } };
    const tagId = 'tag_01h455vb4pex5vsknk084sn02q';
    const documents: Readonly<Record<string, readonly [unknown, unknown]>> = {
      // Left on the old default, in both.
      both: [
        { fields: [], contactActions: named },
        { fields: [], contactActions: named },
      ],
      // The draft was moved to a fixed text and not published yet.
      edited: [
        { fields: [], contactActions: { tagIds: [tagId], source: { kind: 'text', text: 'Fair' } } },
        {
          title: 'Live',
          fields: [],
          contactActions: { tagIds: [tagId], source: { kind: 'form_name' } },
        },
      ],
      // Named nothing, which read as the form's name.
      unsaid: [{ fields: [], contactActions: { tagIds: [tagId] } }, null],
      none: [{ fields: [], contactActions: { tagIds: [], source: { kind: 'none' } } }, null],
      // From before forms could say: no contactActions at all.
      old: [{ fields: [] }, { fields: [] }],
    };
    const forms: Record<string, string> = {};
    for (const [name, [draft, live]] of Object.entries(documents))
      forms[name] = await one(
        `insert into forms.forms (business_id, name, definition, status, public_key, allowed_origins,
                                  published_definition, published_at)
         values ($1, $2, $3::jsonb, $4, $5, '{https://www.example.com}', $6::jsonb, $7) returning id`,
        [
          business,
          name,
          JSON.stringify(draft),
          live === null ? 'draft' : 'published',
          `pk_test_lead_source_${name.padEnd(8, '0')}`,
          live === null ? null : JSON.stringify(live),
          live === null ? null : new Date('2026-09-01T09:00:00Z'),
        ],
      );

    // A submission whose touch is one of the cases, and one that reached no contact.
    const submission = (contactId: string | null, digest: string): Promise<string> =>
      one(
        `insert into forms.submissions
           (business_id, form_id, contact_id, data, client_submission_id, request_digest, origin,
            contact_outcome)
         values ($1, $2, $3, '{}', uuidv7(), $4, 'https://www.example.com', $5) returning id`,
        [business, forms['both'], contactId, digest, contactId === null ? 'unresolved' : 'created'],
      );
    const sender = await contact();
    const attached = await submission(sender, 'a'.repeat(64));
    const unattached = await submission(null, 'b'.repeat(64));
    await owner.query(
      `insert into crm.contact_attributions
         (business_id, contact_id, medium, session_source, utm_source, utm_medium, subject_kind, subject_id)
       values ($1, $2, 'form', 'others', 'facebook', 'cpc', 'form_submission', $3)`,
      [business, sender, attached],
    );

    const after = await migrate({ connectionString, directory: migrationsDirectory });
    expect(after.applied).toContain(LEAD_SOURCE);

    const touches = await owner.query<{
      source_rule: string | null;
      source_label: string | null;
      page_url: string | null;
      session_source: string;
    }>(
      `select source_rule, source_label, page_url, session_source
       from crm.contact_attributions where contact_id = $1 order by touched_at, id`,
      [visitor],
    );
    expect(touches.rows).toHaveLength(CASES.length);
    for (const [index, [name, facts, expected]] of CASES.entries())
      expect(
        [touches.rows[index]?.source_rule, touches.rows[index]?.source_label],
        `${name} ${JSON.stringify(facts)}`,
      ).toEqual([expected, LABELS[expected]]);
    // The page of the interaction is the page the touch had; the session source is history.
    expect(
      touches.rows.every(
        (row) =>
          row.page_url === 'https://www.example.com/offer' && row.session_source === 'others',
      ),
    ).toBe(true);
    // Every name a stored touch can be given is in the table (the two new click ids, which
    // no stored touch has, lead only to names that other facts lead to as well).
    expect([...new Set(CASES.map(([, , expected]) => expected))].sort()).toEqual(
      Object.keys(LABELS).sort(),
    );

    const others = await owner.query<{
      medium: string;
      source_rule: string | null;
      source_label: string | null;
    }>(
      `select medium, source_rule, source_label from crm.contact_attributions
       where contact_id = any($1::uuid[]) order by medium`,
      [[offline, booker]],
    );
    expect(others.rows).toEqual([
      { medium: 'api', source_rule: null, source_label: null },
      { medium: 'assistant', source_rule: null, source_label: null },
      { medium: 'automation', source_rule: null, source_label: null },
      { medium: 'calendar', source_rule: 'direct', source_label: 'Direct' },
      { medium: 'chat', source_rule: 'direct', source_label: 'Direct' },
      { medium: 'import', source_rule: null, source_label: null },
      { medium: 'manual', source_rule: null, source_label: null },
      { medium: 'message', source_rule: null, source_label: null },
      { medium: 'unknown', source_rule: null, source_label: null },
    ]);

    const submissions = await owner.query<{
      id: string;
      lead_source: string | null;
      lead_source_rule: string | null;
    }>(
      `select id, lead_source, lead_source_rule from forms.submissions where id = any($1::uuid[])`,
      [[attached, unattached]],
    );
    expect(
      Object.fromEntries(submissions.rows.map((row) => [row.id, row.lead_source_rule])),
    ).toEqual({ [attached]: 'facebook_ads', [unattached]: null });
    expect(submissions.rows.find((row) => row.id === attached)?.lead_source).toBe('Facebook Ads');

    const stored = await owner.query<{
      name: string;
      definition: unknown;
      published_definition: unknown;
    }>(`select name, definition, published_definition from forms.forms order by name`);
    const arrived = { source: { kind: 'arrived' }, tagBySource: true };
    expect(
      Object.fromEntries(
        stored.rows.map((row) => [row.name, [row.definition, row.published_definition]]),
      ),
    ).toEqual({
      both: [
        { fields: [], contactActions: { tagIds: [], ...arrived } },
        { fields: [], contactActions: { tagIds: [], ...arrived } },
      ],
      edited: [
        // A fixed text stays, and says in so many words that it adds no tag by source.
        {
          fields: [],
          contactActions: {
            tagIds: [tagId],
            source: { kind: 'text', text: 'Fair' },
            tagBySource: false,
          },
        },
        // What is live was still on the form's name: it is switched, and nothing else of it.
        { title: 'Live', fields: [], contactActions: { tagIds: [tagId], ...arrived } },
      ],
      none: [
        {
          fields: [],
          contactActions: { tagIds: [], source: { kind: 'none' }, tagBySource: false },
        },
        null,
      ],
      old: [{ fields: [] }, { fields: [] }],
      unsaid: [{ fields: [], contactActions: { tagIds: [tagId], ...arrived } }, null],
    });

    // Applied once: running the migrations again changes nothing.
    const again = await migrate({ connectionString, directory: migrationsDirectory });
    expect(again.applied).toEqual([]);
  } finally {
    await owner.end();
  }
});
