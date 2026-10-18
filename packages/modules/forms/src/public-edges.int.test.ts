// Forms the builder would not have published, and requests the routes would not have let
// through: what the public handlers and the readers do with them anyway.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand } from '@repo/commands';
import { contact as contactContract, formDefinition, formSubmissionList } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { NotFoundError, toPublicId } from '@repo/kernel';
import { crmRoutes } from '@repo/module-crm';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';

import { formSuite, WEBSITE, type FormFixture } from '../test/form-fixtures.js';
import { discardSubmissionCommand, readSubmissions } from './submissions.js';

const suite = formSuite();
const { fixture, admin, published, submit, stored, visitor } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});

const OK = { outcome: 'ok', receipt: { status: 'received' } };
const key = () => `pk_edge_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
/** A published form written straight into the table, as an import or a repair could. */
const handWritten = async (f: FormFixture, definition: unknown): Promise<{ publicKey: string }> => {
  const publicKey = key();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into forms.forms (business_id, name, definition, status, public_key, allowed_origins,
                                published_definition, published_at)
       values (app.business_id(), 'By hand', $1::jsonb, 'published', $2, $3, $1::jsonb, now())`,
      [JSON.stringify(definition), publicKey, [WEBSITE]],
    ),
  );
  return { publicKey };
};

it('takes a form that asks only for a phone number, and a visitor whose browser names itself nothing', async () => {
  const f = await fixture();
  const form = await published(f, {
    fields: [
      {
        key: 'phone',
        type: 'phone',
        label: 'Phone',
        required: true,
        target: { kind: 'contact', attribute: 'phone' },
      },
    ],
    consents: [{ key: 'texts', channel: 'sms', wording: 'Text me offers.' }],
  });
  const sent = await submit(
    form,
    { phone: '+254 712 345678' },
    { consents: { texts: true }, visitor: { userAgent: undefined } },
  );
  expect(sent.result).toEqual(OK);
  expect(await stored(f)).toEqual({ submissions: 1, contacts: 1, consents: 1, events: 1 });
  const [made] = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ id: string }>('select id from crm.contacts'),
  );
  if (made === undefined) throw new Error('No contact.');
  const route = crmRoutes.find((each) => each.endpoint.operationId === 'getContact');
  if (route === undefined) throw new Error('Missing getContact route.');
  expect(
    contactContract.parse(
      await route.run(
        {
          invocation: f.manager,
          params: { id: toPublicId('contact', made.id) },
          query: {},
          body: undefined,
        },
        { db: suite.db, authorize: allowEveryone },
      ),
    ),
  ).toMatchObject({ emails: [], phones: [{ number: '+254712345678' }] });
  // The proof holds what there was: no page and no browser name were given.
  const [consent] = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ channel: string; proof: Record<string, string> }>(
      'select channel, proof from messaging.consents',
    ),
  );
  expect(consent?.channel).toBe('sms');
  expect(Object.keys(consent?.proof ?? {}).sort()).toEqual([
    'formId',
    'ipAddress',
    'submissionId',
    'wording',
  ]);
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query('select user_agent, host(ip) as ip from forms.submissions where business_id = $1', [
        f.business.id,
      ]),
    ),
  ).toEqual([{ user_agent: null, ip: '203.0.113.10' }]);
  // The same number again, written another way, is the same person.
  expect((await submit(form, { phone: '+254712345678' })).result).toEqual(OK);
  expect((await stored(f)).contacts).toBe(1);
});

it('serves nothing for a published row whose definition the builder did not write', async () => {
  const f = await fixture();
  for (const definition of [{ questions: ['email'] }, { fields: [{ key: 'email' }] }, {}]) {
    const form = await handWritten(f, definition);
    expect(await suite.handlers.admit(form.publicKey, WEBSITE)).toBeUndefined();
  }
});

it('refuses, in general words, a submission to a form that was published asking for no address', async () => {
  const f = await fixture();
  // The contract reads it, and publishing would have refused it: it identifies nobody.
  const form = await handWritten(
    f,
    formDefinition.parse({ fields: [{ key: 'notes', type: 'long_text', label: 'Notes' }] }),
  );
  const empty = await submit(form, {});
  expect(empty.result).toEqual({
    outcome: 'invalid',
    issues: [{ path: '', code: 'invalid', message: 'Check your details and try again.' }],
  });
  expect((await submit(form, { notes: 'Hello' })).result).toMatchObject({ outcome: 'invalid' });
  // No nameless contact was made, and nothing else either.
  expect(await stored(f)).toEqual({ submissions: 0, contacts: 0, consents: 0, events: 0 });
  const named = await handWritten(
    f,
    formDefinition.parse({
      fields: [
        {
          key: 'name',
          type: 'text',
          label: 'Name',
          target: { kind: 'contact', attribute: 'firstName' },
        },
      ],
    }),
  );
  // A name alone makes a contact each time: the reason publishing asks for an address.
  expect((await submit(named, { name: 'Maya' })).result).toEqual(OK);
  expect((await stored(f)).contacts).toBe(1);
});

it('finds nothing for an id that is not a form or a submission, whoever asks directly', async () => {
  const f = await fixture();
  const form = await published(f);
  await submit(form, { email: 'maya@example.test' });
  const [listed] = formSubmissionList.parse(
    await admin(f, 'listFormSubmissions', { params: { id: form.id } }),
  ).items;
  if (listed === undefined) throw new Error('Nothing is listed.');
  const services = { db: suite.db, authorize: allowEveryone };
  for (const id of ['nonsense', listed.id, 'con_01h455vb4pex5vsknk084sn02q'])
    await expect(
      withTenant(suite.db, f.manager.context, (trx) =>
        readSubmissions(trx, f.manager, id, { limit: 10 }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    withTenant(suite.db, f.manager.context, (trx) =>
      readSubmissions(trx, f.manager, form.id, { limit: 10, after: 'nonsense' }),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  for (const input of [
    { id: 'nonsense', submissionId: listed.id },
    { id: form.id, submissionId: 'nonsense' },
    { id: form.id, submissionId: form.id },
  ])
    await expect(
      runCommand(services, discardSubmissionCommand, input, {
        ...f.manager,
        context: { ...f.manager.context, correlationId: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  expect((await stored(f)).submissions).toBe(1);
  expect(
    await suite.handlers.submit(
      { agencyId: f.agency.id, businessId: f.business.id, formId: randomUUID(), origin: WEBSITE },
      {
        clientSubmissionId: randomUUID(),
        renderToken: `1790000000000.${'A'.repeat(43)}`,
        values: {},
        consents: {},
        trap: '',
      },
      visitor(),
    ),
  ).toEqual({ outcome: 'unavailable' });
});
