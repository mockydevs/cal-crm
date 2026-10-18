import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import { expect, it } from 'vitest';
import {
  addressConsentStatus,
  identityKindOf,
  latestConsentFirst,
  latestConsentStatus,
} from './consent-state.js';

// Compiles SQL without a database.
const compiler = new Kysely<object>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
const squeezed = (text: string): string => text.replace(/\s+/g, ' ').trim();

it('orders the ledger newest first, with the id breaking a tie', () => {
  expect(latestConsentFirst.compile(compiler).sql).toBe('recorded_at desc,id desc');
});

it('is the rule the send check and the campaign audience build their queries from', async () => {
  // The display and enforcement must never disagree: both call the one fragment.
  for (const file of ['outbound.ts', 'campaign-audience.ts']) {
    const text = squeezed(await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8'));
    expect(text, file).toContain(
      'addressConsentStatus(sql`c.business_id`, sql`c.id`, sql`i.value_normalized`,',
    );
  }
});

it('counts a grant only for its contact and its own address, a withdrawal for its address whoever holds it', () => {
  const compiled = addressConsentStatus(
    sql.raw('b'),
    sql.raw('c'),
    sql.raw('a'),
    'email',
    'marketing',
  ).compile(compiler);
  const text = squeezed(compiled.sql);
  expect(text).toContain(
    "contact_id=c and channel=$1 and purpose=$2 and (status='withdrawn' or address_normalized is null or address_normalized=a)",
  );
  expect(text).toContain(
    "business_id=b and address_normalized=a and channel=$3 and purpose=$4 and status='withdrawn'",
  );
  expect(compiled.parameters).toEqual(['email', 'marketing', 'email', 'marketing']);
});

it("reads a contact's status from its own rows and the withdrawals of the addresses it holds", () => {
  const compiled = latestConsentStatus(sql.raw('b'), sql.raw('c'), 'sms', 'marketing').compile(
    compiler,
  );
  expect(squeezed(compiled.sql)).toContain(
    "and ci.kind=$3 where k.business_id=b and ci.contact_id=c and k.channel=$4 and k.purpose=$5 and k.status='withdrawn'",
  );
  expect(compiled.parameters).toContain('phone');
  expect(identityKindOf('email')).toBe('email');
  for (const channel of ['sms', 'whatsapp', 'call']) expect(identityKindOf(channel)).toBe('phone');
});

it('answers unknown, never granted, when nothing was recorded', () => {
  for (const status of [
    latestConsentStatus(sql.raw('b'), sql.raw('c'), 'sms', 'transactional'),
    addressConsentStatus(sql.raw('b'), sql.raw('c'), sql.raw('a'), 'sms', 'transactional'),
  ])
    expect(squeezed(status.compile(compiler).sql)).toMatch(
      /^coalesce\(\(select status from \([\s\S]+\) latest order by recorded_at desc,id desc limit 1\),'unknown'\)$/,
    );
});
