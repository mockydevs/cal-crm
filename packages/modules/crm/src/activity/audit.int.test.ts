// A record's audit log, against a migrated Postgres as crm_app under row-level security,
// through the route the server registers. The commands are the real ones.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { AUDIT_PAGE_SIZE, auditLog, type AuditLog } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { detailOptions, team, type Member, type Team } from '../../test/contact-details.js';
import { createContactCommand, readContact, updateContactCommand } from '../contacts/contacts.js';
import { readContactDetails } from '../contacts/details.js';
import { setContactDndCommand } from '../contacts/dnd.js';
import { assignContactOwnerCommand } from '../contacts/people.js';
import { activityRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const options = detailOptions();
const routes = activityRoutes({ actorNames: options.actorNames });
const setDnd = setContactDndCommand(options);
const assignOwner = assignContactOwnerCommand(options);

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

async function read(invocation: Invocation, id: string, after?: string): Promise<AuditLog> {
  const route = routes.find((each) => each.endpoint.operationId === 'listRecordAudit');
  if (route === undefined) throw new Error('Missing listRecordAudit');
  return auditLog.parse(
    await route.run(
      { invocation, params: { id }, query: after === undefined ? {} : { after }, body: undefined },
      services,
    ),
  );
}
const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const reason = 'Asked by phone on 9 October not to be contacted again.';

/** A contact Dana made, renamed, marked do not contact, put on do not disturb and took as owner. */
async function history(): Promise<{ t: Team; dana: Member; id: string }> {
  const t = await team(database);
  const dana = await t.member('Dana Brooks');
  // As a request arrives: with the address and the browser it came from.
  const who = (): Invocation => ({ ...dana.as(), ip: '203.0.113.9', userAgent: 'Browser/1.0' });
  const { id } = await runCommand(
    services,
    createContactCommand,
    { firstName: 'Maya', emails: ['maya.private@example.test'] },
    who(),
  );
  await runCommand(services, updateContactCommand, { id, lastName: 'Thompson' }, who());
  const contact = await withTenant(db, who().context, (trx) => readContact(trx, who(), id));
  await runCommand(
    services,
    updateContactCommand,
    {
      id,
      doNotContact: true,
      doNotContactReason: reason,
      timeZone: 'Africa/Nairobi',
      preferencesRevision: contact.preferencesRevision,
    },
    who(),
  );
  const details = await withTenant(db, who().context, (trx) =>
    readContactDetails(trx, who(), id, options),
  );
  await runCommand(
    services,
    setDnd,
    {
      id,
      all: true,
      channels: ['sms'],
      inbound: true,
      reason: 'Texts in particular.',
      revision: details.dnd.revision,
    },
    who(),
  );
  await runCommand(
    services,
    assignOwner,
    { id, owner: 'me', revision: details.ownerRevision },
    who(),
  );
  return { t, dana, id };
}

describe("a record's audit log", () => {
  it('lists the commands that changed it, newest first: who, what, when, and what each reported', async () => {
    const { dana, id } = await history();
    const log = await read(dana.as(), id);
    expect(log.next).toBeNull();
    expect(
      log.items.map((entry) => [entry.command, entry.events.map((event) => event.type)]),
    ).toEqual([
      ['contact.assign_owner', ['contact.owner_assigned']],
      ['contact.set_dnd', ['contact.inbound_dnd_set', 'contact.dnd_changed']],
      ['contact.update', ['contact.do_not_contact_set', 'contact.updated']],
      ['contact.update', ['contact.updated']],
      ['contact.create', ['contact.created']],
    ]);
    for (const entry of log.items) {
      expect(entry).toMatchObject({
        outcome: 'ok',
        errorCode: null,
        proposed: false,
        actor: { kind: 'user', name: 'Dana Brooks', you: true },
      });
      expect(parsePublicId('audit_entry', entry.id)).toBeDefined();
    }
    const times = log.items.map((entry) => Date.parse(entry.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // Someone in another business finds no such record.
    const lee = await (await team(database)).member();
    expect(await failure(read(lee.as(), id))).toBeInstanceOf(NotFoundError);
  });

  it('shows the reason for a do-not-contact change, and nothing else of what a command was given', async () => {
    const { dana, id } = await history();
    const log = await read(dana.as(), id);
    expect(log.items.map((entry) => entry.detail)).toEqual([
      {},
      { all: true, channels: ['sms'], inbound: true, reason: 'Texts in particular.' },
      { timeZone: 'Africa/Nairobi', doNotContact: true, doNotContactReason: reason },
      {},
      {},
    ]);
    // Not the name or the address the contact was made with, the revisions, the address the
    // request came from, or its browser: all of which the stored rows hold.
    const text = JSON.stringify(log);
    for (const kept of ['maya.private', 'Thompson', '203.0.113.9', 'Browser/1.0', 'Revision'])
      expect(text).not.toContain(kept);
    const stored = await database.as('crm_owner', (sql) =>
      sql.query<{ ip: string | null; input: unknown }>(
        `select host(ip) as ip, input from audit.commands where command = 'contact.create' and input ->> 'firstName' = 'Maya' and ip = '203.0.113.9'`,
      ),
    );
    expect(stored.length).toBeGreaterThan(0);
  });

  it('leaves out attempts that changed nothing, other records, and rows that are not this business’s', async () => {
    const { t, dana, id } = await history();
    const before = await read(dana.as(), id);
    // A refused attempt and an invalid one on this contact, and a change to another contact.
    await failure(
      runCommand(services, updateContactCommand, { id, lastName: 'Refused' }, dana.as(new Set())),
    );
    await failure(
      runCommand(services, updateContactCommand, { id, timeZone: 'Nowhere/Land' }, dana.as()),
    );
    const other = await runCommand(
      services,
      createContactCommand,
      { firstName: 'Jordan' },
      dana.as(),
    );
    // Rows that name this contact's own events at the very moment they were recorded, but
    // are the agency's own, or another business's: neither is this business's to read.
    const hostile = await database.as('crm_owner', (sql) =>
      sql.query(
        `with sibling as (
           insert into tenancy.businesses (agency_id, name, slug)
           select agency_id, 'Sibling', 'sibling-' || substr(gen_random_uuid()::text, 1, 8)
           from tenancy.businesses where id = $1 returning id)
         insert into audit.commands (agency_id, business_id, command, actor_kind, outcome,
                                     event_ids, correlation_id, recorded_at, input)
         select a.agency_id, place.business_id, 'contact.update', 'system', 'ok', a.event_ids,
                gen_random_uuid(), a.recorded_at, '{"doNotContactReason": "Not yours to read."}'
         from audit.commands a,
           (select null::uuid as business_id union all select id from sibling) place
         where a.business_id = $1 and a.outcome = 'ok'
         returning business_id`,
        [t.businessId],
      ),
    );
    // Six of each: one for every command that changed something in this business.
    expect(hostile).toHaveLength(12);
    const after = await read(dana.as(), id);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('Not yours');
    // The other contact has its own log, of one entry.
    expect((await read(dana.as(), other.id)).items.map((entry) => entry.command)).toEqual([
      'contact.create',
    ]);
  });

  it('shows, of a command that changed several records, only what it reported about this one', async () => {
    const t = await team(database);
    const dana = await t.member();
    const [first, second] = [
      await database.fixtures.contact(t.context),
      await database.fixtures.contact(t.context),
    ];
    const both = defineCommand({
      name: 'test.touch_two',
      permission: 'contacts.manage',
      input: z.strictObject({}),
      async handle(_trx, _input, command) {
        for (const contact of [first, second, first])
          await command.emit({
            type: contact === first ? 'test.first_touched' : 'test.second_touched',
            subject: { kind: 'contact', id: contact.id },
            records: [contact.id],
          });
      },
    });
    await runCommand(services, both, {}, dana.as());
    const logOf = async (contactId: string) =>
      (await read(dana.as(), toPublicId('contact', contactId))).items.map((entry) => [
        entry.command,
        entry.events.map((event) => event.type),
      ]);
    // One entry for the command, however many events it wrote about the record.
    expect(await logOf(first.id)).toEqual([
      ['test.touch_two', ['test.first_touched', 'test.first_touched']],
    ]);
    expect(await logOf(second.id)).toEqual([['test.touch_two', ['test.second_touched']]]);
  });

  it('is read a page at a time, each entry once, from the entry a page ended on', async () => {
    const t = await team(database);
    const dana = await t.member();
    const { id } = await runCommand(
      services,
      createContactCommand,
      { firstName: 'Paged' },
      dana.as(),
    );
    const changes = AUDIT_PAGE_SIZE + 2;
    for (let index = 0; index < changes; index += 1)
      await runCommand(
        services,
        updateContactCommand,
        { id, lastName: `Change ${String(index)}` },
        dana.as(),
      );
    const first = await read(dana.as(), id);
    expect(first.items).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.next).toBe(first.items.at(-1)?.id);
    const second = await read(dana.as(), id, first.next ?? undefined);
    expect(second.items.map((entry) => entry.command)).toEqual([
      'contact.update',
      'contact.update',
      'contact.create',
    ]);
    expect(second.next).toBeNull();
    const ids = [...first.items, ...second.items].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(changes + 1);

    // An entry of another record is not a place in this one's log.
    const other = await runCommand(
      services,
      createContactCommand,
      { firstName: 'Other' },
      dana.as(),
    );
    const [foreign] = (await read(dana.as(), other.id)).items;
    const refused = await failure(read(dana.as(), id, foreign?.id));
    expect((refused as ValidationError).issues).toEqual([
      expect.objectContaining({ path: '/after', code: 'not_in_audit_log' }),
    ]);
    expect(
      (await failure(read(dana.as(), id, toPublicId('audit_entry', randomUUID7())))) instanceof
        ValidationError,
    ).toBe(true);
  });

  it('needs audit.read, which a refusal says before saying anything of the record', async () => {
    const { t, dana, id } = await history();
    for (const permissions of [new Set<never>(), new Set(['contacts.manage'] as const)])
      for (const record of [id, toPublicId('contact', randomUUID7())]) {
        const refused = await failure(read(dana.as(permissions), record));
        expect(refused).toBeInstanceOf(ForbiddenError);
        expect((refused as ForbiddenError).permission).toBe('audit.read');
      }
    expect((await read(dana.as(new Set(['audit.read'] as const)), id)).items).toHaveLength(5);
    // A record that isn't there, of this business or any other, is not found.
    expect(await failure(read(dana.as(), toPublicId('contact', randomUUID7())))).toBeInstanceOf(
      NotFoundError,
    );
    // The contact page is told whether to offer the log at all.
    const shown = (permissions: Invocation['permissions']) =>
      withTenant(db, t.context, (trx) =>
        readContactDetails(trx, dana.as(permissions), id, options),
      );
    expect((await shown(new Set(['contacts.manage'] as const))).canReadAudit).toBe(false);
    expect((await shown('all')).canReadAudit).toBe(true);
  });
});

/** A UUIDv7 nothing has: the time now, and random bits. */
function randomUUID7(): string {
  const time = Date.now().toString(16).padStart(12, '0');
  const random = randomUUID().replaceAll('-', '');
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-8${random.slice(3, 6)}-${random.slice(6, 18)}`;
}
