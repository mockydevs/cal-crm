// Every column that points at a contact is accounted for by a merge. Read from the migrated
// database itself: every foreign key to a contact, a record or a contact's address, and
// every column named for a contact or a record that has none. Each must be moved by crm's
// core, by a module's merge participant, or be named here as history a merge leaves alone.
// A new table that points at a contact fails this until someone says what a merge does to
// it; a name left here after its column is gone fails it too.
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { crmMergeColumns } from './merge-core.js';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

/** Not a reference to move: the registry row of a record, and the merge's own mark. */
const notReferences = [
  // Each kind of record's row shares its id with crm.records.
  'crm.contacts.id',
  'crm.companies.id',
  'crm.deals.id',
  'crm.custom_records.id',
  // A custom record's object, which its registry row names too (0128).
  'crm.custom_records.object_type_id',
  // The ledger of unique values, kept by the database from crm.field_values: a merge frees
  // the merged contact's values of the fields the contact kept takes (merge.ts).
  'crm.field_unique_values.record_id',
  // Where a contact merged away went.
  'crm.contacts.merged_into_id',
];

/** Rows that name an address, which keeps its id as it moves to the contact kept. */
const followTheAddress = [
  'messaging.outbound_dispatch.identity_id',
  'messaging.calls.contact_identity_id',
];

/**
 * History: what happened to the contact merged away stays its own. These go with it when
 * the trash is purged, or are kept by design (events and the audit log are never changed).
 */
const history = [
  // Immutable; the contact kept's timeline gets a copy of each entry instead.
  'events.events.subject_id',
  // The touch that made the contact: its subject is that contact, as it happened.
  'crm.contact_attributions.subject_id',
  // What a bulk action did, and the groups said not to be duplicates.
  'crm.contact_bulk_action_items.contact_id',
  'crm.duplicate_rejections.contact_ids',
  // What an import wrote, and a test run's sample.
  'imports.job_rows.record_id',
  'automation.test_runs.sample_record_id',
  // A notice about the contact merged away opens it, and its page answers with where it
  // went; notifications can only be marked read.
  'notifications.notifications.record_id',
  'notifications.notifications.subject_id',
];

/**
 * Each module's participant, by what it moves. Pending: the participant is still to be
 * written, and its tables are listed here so this test names every one of them.
 */
const participants: Record<string, { readonly moves: string[]; readonly pending: string[] }> = {
  messaging: {
    moves: [],
    pending: [
      'messaging.conversations.contact_id',
      'messaging.consents.contact_id',
      'messaging.webchat_sessions.contact_id',
      'messaging.webchat_sessions.claimed_contact_id',
      'messaging.trigger_link_tokens.contact_id',
      'messaging.trigger_link_clicks.contact_id',
      'messaging.email_campaign_recipients.contact_id',
      'messaging.email_campaign_tests.contact_id',
      'messaging.unsubscribe_links.contact_id',
      'messaging.calls.contact_id',
    ],
  },
  automation: {
    moves: [],
    pending: [
      'automation.enrolments.record_id',
      'automation.event_waits.record_id',
      'automation.trigger_firings.record_id',
      'automation.trigger_evaluations.record_id',
      'automation.manual_actions.contact_id',
    ],
  },
  forms: { moves: [], pending: ['forms.submissions.contact_id'] },
  calendar: { moves: [], pending: ['calendar.appointments.contact_id'] },
  commerce: { moves: [], pending: ['commerce.documents.contact_id'] },
  ai: {
    moves: [],
    pending: [
      'ai.contact_facts.contact_id',
      'ai.contact_summaries.contact_id',
      'ai.extractions.contact_id',
      'ai.autonomy_rules.contact_id',
      'ai.proposals.record_id',
    ],
  },
};

/** Every column that points at a contact, as schema.table.column. */
async function pointingAtContacts(): Promise<string[]> {
  const rows = await database.as('postgres', (sql) =>
    sql.query<{ name: string }>(
      `select distinct n.nspname || '.' || c.relname || '.' || a.attname as name
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
       where k.contype = 'f' and not c.relispartition
         and k.confrelid in ('crm.contacts'::regclass, 'crm.records'::regclass,
                             'crm.contact_identities'::regclass)
         and a.attname not in ('business_id', 'kind')
       union
       select n.nspname || '.' || c.relname || '.' || a.attname
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p') and not c.relispartition and a.attnum > 0
         and not a.attisdropped
         and n.nspname not in ('pg_catalog', 'information_schema', 'graphile_worker')
         and a.atttypid in ('uuid'::regtype, 'uuid[]'::regtype)
         and a.attname ~ '(^|_)(contact|record)_ids?$|^subject_id$'
       order by 1`,
    ),
  );
  return rows.map((row) => row.name);
}

it('accounts for every column that points at a contact, and names no column that is gone', async () => {
  const accounted = [
    ...crmMergeColumns,
    ...notReferences,
    ...followTheAddress,
    ...history,
    ...Object.values(participants).flatMap((each) => [...each.moves, ...each.pending]),
  ];
  expect(new Set(accounted).size).toBe(accounted.length);
  expect((await pointingAtContacts()).sort()).toEqual([...accounted].sort());
});
