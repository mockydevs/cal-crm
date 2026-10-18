// Migration 0086 over an install that already has contacts and form submissions: a database
// is migrated up to the migration before it, rows are stored as the modules stored them
// then, and the runner applies 0086 as it does on an upgrade. Every contact ends with a
// first and a latest touch, built from what was kept.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPostgres, type Postgres } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const ATTRIBUTION = '0086_reporting_attribution.sql';

let postgres: Postgres;
let earlier: string;
let upTo: string;
beforeAll(async () => {
  postgres = await startPostgres({ bootstrapFile });
  // The migrations an install had before attribution, and the ones up to it.
  earlier = await mkdtemp(join(tmpdir(), 'crm-before-attribution-'));
  upTo = await mkdtemp(join(tmpdir(), 'crm-with-attribution-'));
  for (const name of await readdir(migrationsDirectory)) {
    if (name < ATTRIBUTION) await cp(join(migrationsDirectory, name), join(earlier, name));
    if (name <= ATTRIBUTION) await cp(join(migrationsDirectory, name), join(upTo, name));
  }
});
afterAll(async () => {
  await postgres.stop();
  await rm(earlier, { recursive: true, force: true });
  await rm(upTo, { recursive: true, force: true });
});

it('gives every contact a first and a latest touch from its submissions, or from how it was made', async () => {
  const database = await postgres.createDatabase();
  const connectionString = postgres.url(database);
  const before = await migrate({ connectionString, directory: earlier });
  expect(before.applied).not.toContain(ATTRIBUTION);

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
    const contact = (source: string, createdAt: string): Promise<string> =>
      one(
        `with record as (
           insert into crm.records (business_id, kind, object_type_id)
           values ($1, 'contact', $2) returning id)
         insert into crm.contacts (business_id, id, first_name, created_by_kind, created_source, created_at)
         select $1, id, 'Maya', 'system', $3, $4::timestamptz from record returning id`,
        [business, objectType, source, createdAt],
      );
    const form = await one(
      `insert into forms.forms (business_id, name, definition, status, public_key, allowed_origins,
                                published_definition, published_at)
       values ($1, 'Enquiry', '{"fields": []}', 'published', 'pk_test_backfill_form_01',
               '{https://www.example.com}', '{"fields": []}', now()) returning id`,
      [business],
    );
    let sent = 0;
    const submission = (
      contactId: string | null,
      at: string,
      utm: Record<string, string>,
      page: string | null = 'https://www.example.com/contact',
    ): Promise<string> =>
      one(
        `insert into forms.submissions
           (business_id, form_id, contact_id, data, client_submission_id, request_digest, origin,
            page_url, utm, contact_outcome, submitted_at)
         values ($1, $2, $3, '{}', uuidv7(), $4, 'https://www.example.com', $5, $6::jsonb, $7,
                 $8::timestamptz) returning id`,
        [
          business,
          form,
          contactId,
          String((sent += 1)).padStart(64, '0'),
          page,
          JSON.stringify(utm),
          contactId === null ? 'unresolved' : 'created',
          at,
        ],
      );

    // Two submissions: Google Ads first, a newsletter later.
    const returning = await contact('form', '2026-09-01T09:00:00Z');
    const firstSubmission = await submission(returning, '2026-09-01T09:00:00Z', {
      source: 'google-adwords',
      medium: 'cpc',
      campaign: 'spring',
      term: 'venue hire',
      content: 'ad one',
    });
    await submission(returning, '2026-09-05T09:00:00Z', { source: 'newsletter' });
    // One submission each: a Facebook ad, and no label at all (and no page).
    const social = await contact('form', '2026-09-02T09:00:00Z');
    await submission(social, '2026-09-02T09:00:00Z', { source: 'fb_ad', campaign: 'summer' });
    const plain = await contact('form', '2026-09-03T09:00:00Z');
    await submission(plain, '2026-09-03T09:00:00Z', {}, null);
    // A submission that reached no contact makes no touch.
    await submission(null, '2026-09-03T10:00:00Z', { source: 'adwords' });
    // Contacts with no submission, by how each came to be.
    const made: Record<string, string> = {};
    for (const source of [
      'user',
      'api',
      'import',
      'automation',
      'assistant',
      'email',
      'sms',
      'webchat',
      'form',
      'booking',
      'unknown',
    ])
      made[source] = await contact(source, '2026-08-01T09:00:00Z');

    const { applied } = await migrate({ connectionString, directory: upTo });
    expect(applied).toEqual([ATTRIBUTION]);

    const touches = async (contactId: string) =>
      (
        await owner.query<Record<string, unknown>>(
          `select medium, session_source, utm_source, utm_medium, utm_campaign, utm_term,
                  utm_content, landing_url, subject_kind, subject_id::text, is_first, is_latest,
                  touched_at
           from crm.contact_attributions where contact_id = $1 order by touched_at, id`,
          [contactId],
        )
      ).rows;

    expect(await touches(returning)).toEqual([
      {
        medium: 'form',
        session_source: 'paid_search',
        utm_source: 'google-adwords',
        utm_medium: 'cpc',
        utm_campaign: 'spring',
        utm_term: 'venue hire',
        utm_content: 'ad one',
        landing_url: 'https://www.example.com/contact',
        subject_kind: 'form_submission',
        subject_id: firstSubmission,
        is_first: true,
        is_latest: false,
        touched_at: new Date('2026-09-01T09:00:00Z'),
      },
      // A label no rule names, with no referrer kept: others.
      expect.objectContaining({
        session_source: 'others',
        utm_source: 'newsletter',
        utm_medium: null,
        is_first: false,
        is_latest: true,
      }),
    ]);
    expect(await touches(social)).toMatchObject([
      { session_source: 'paid_social', utm_campaign: 'summer', is_first: true, is_latest: true },
    ]);
    expect(await touches(plain)).toMatchObject([
      {
        session_source: 'direct',
        utm_source: null,
        landing_url: null,
        is_first: true,
        is_latest: true,
      },
    ]);

    const expected: Record<string, [string, string]> = {
      user: ['manual', 'crm_ui'],
      api: ['api', 'third_party'],
      import: ['import', 'third_party'],
      automation: ['automation', 'third_party'],
      assistant: ['assistant', 'third_party'],
      email: ['message', 'others'],
      sms: ['message', 'others'],
      webchat: ['chat', 'direct'],
      form: ['form', 'direct'],
      booking: ['calendar', 'direct'],
      unknown: ['unknown', 'others'],
    };
    for (const [source, [medium, sessionSource]] of Object.entries(expected))
      expect(await touches(made[source] ?? ''), source).toEqual([
        expect.objectContaining({
          medium,
          session_source: sessionSource,
          subject_kind: 'contact',
          subject_id: made[source],
          is_first: true,
          is_latest: true,
          // The moment the contact was made.
          touched_at: new Date('2026-08-01T09:00:00Z'),
        }),
      ]);

    // Every contact has exactly one first and one latest touch.
    const { rows } = await owner.query<{ contacts: string; firsts: string; latests: string }>(
      `select (select count(*) from crm.contacts) as contacts,
              count(*) filter (where is_first) as firsts,
              count(*) filter (where is_latest) as latests
       from crm.contact_attributions`,
    );
    expect(rows).toEqual([{ contacts: '14', firsts: '14', latests: '14' }]);

    // The database holds what the application relies on: one first and one latest a contact.
    await expect(
      owner.query(
        `insert into crm.contact_attributions
           (business_id, contact_id, medium, session_source, subject_kind, subject_id, is_first)
         values ($1, $2, 'form', 'direct', 'contact', $2, true)`,
        [business, plain],
      ),
    ).rejects.toMatchObject({ constraint: 'contact_attributions_first_idx' });
    await expect(
      owner.query(
        `insert into crm.contact_attributions
           (business_id, contact_id, medium, session_source, subject_kind, subject_id, is_latest)
         values ($1, $2, 'form', 'direct', 'contact', $2, true)`,
        [business, plain],
      ),
    ).rejects.toMatchObject({ constraint: 'contact_attributions_latest_idx' });
    await expect(
      owner.query(
        `insert into crm.contact_attributions
           (business_id, contact_id, medium, session_source, subject_kind, subject_id, utm_source)
         values ($1, $2, 'form', 'direct', 'contact', $2, $3)`,
        [business, plain, 'x'.repeat(201)],
      ),
    ).rejects.toMatchObject({ constraint: 'contact_attributions_values_bounded' });
    // A contact purged takes its touches with it.
    await owner.query('delete from crm.records where id = $1', [plain]);
    expect(await touches(plain)).toEqual([]);
  } finally {
    await owner.end();
  }
});
