// Do not disturb for every channel or for some, against a migrated Postgres as crm_app
// under row-level security, through the route the server registers. What sending does with
// it is proved where sending lives (messaging's contact-dnd-outbound.int.test.ts).
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { contactDetails, type ContactDetails } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, team, waitingForLock, type Team } from '../../test/contact-details.js';
import { readContact, updateContactCommand } from './contacts.js';
import { contactDetailRoutes } from './detail-routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const routes = contactDetailRoutes(detailOptions());

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

async function call(
  operationId: string,
  invocation: Invocation,
  id: string,
  body?: unknown,
): Promise<ContactDetails> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return contactDetails.parse(
    await route.run({ invocation, params: { id }, body, query: {} }, services),
  );
}
const reason = 'Asked by phone on 9 October to get no more text messages.';
const read = (who: Invocation, id: string) => call('getContactDetails', who, id);
const set = (
  who: Invocation,
  id: string,
  all: boolean,
  channels: readonly string[],
  revision: string,
) => call('setContactDnd', who, id, { all, channels, reason, revision });

async function fixture(): Promise<{ t: Team; who: Invocation; id: string }> {
  const t = await team(database);
  const who = (await t.member()).as();
  return { t, who, id: toPublicId('contact', (await database.fixtures.contact(t.context)).id) };
}
const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
const eventsOf = (t: Team) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ type: string; payload: unknown }>(
      `select type, payload from events.events
       where business_id = $1 and type <> 'contact.updated' order by recorded_at, id`,
      [t.businessId],
    ),
  );
const stored = (t: Team) =>
  database.as('crm_owner', (sql) =>
    sql.one<{ do_not_contact: boolean; dnd_channels: string[] }>(
      'select do_not_contact, dnd_channels from crm.contacts where business_id = $1',
      [t.businessId],
    ),
  );
const storedInbound = (t: Team) =>
  database.as(
    'crm_owner',
    async (sql) =>
      (
        await sql.one<{ dnd_inbound: boolean }>(
          'select dnd_inbound from crm.contacts where business_id = $1',
          [t.businessId],
        )
      ).dnd_inbound,
  );

describe('do not disturb', () => {
  it('is off for a new contact, and is turned on for the channels named, each once, in one order', async () => {
    const { t, who, id } = await fixture();
    const before = await read(who, id);
    expect(before.dnd).toMatchObject({ all: false, channels: [] });

    const after = await set(who, id, false, ['sms', 'email', 'sms'], before.dnd.revision);
    expect(after.dnd).toMatchObject({ all: false, channels: ['email', 'sms'] });
    expect(after.dnd.revision).not.toBe(before.dnd.revision);
    expect(await stored(t)).toEqual({ do_not_contact: false, dnd_channels: ['email', 'sms'] });
    // A channel that is not built yet can be switched off before it exists.
    const more = await set(who, id, false, ['whatsapp', 'call', 'webchat'], after.dnd.revision);
    expect(more.dnd.channels).toEqual(['call', 'webchat', 'whatsapp']);
    // Each change says the channels now stopped, and which it turned on and off.
    expect(await eventsOf(t)).toEqual([
      {
        type: 'contact.dnd_changed',
        payload: { channels: ['email', 'sms'], enabled: ['email', 'sms'], disabled: [] },
      },
      {
        type: 'contact.dnd_changed',
        payload: {
          channels: ['call', 'webchat', 'whatsapp'],
          enabled: ['call', 'webchat', 'whatsapp'],
          disabled: ['email', 'sms'],
        },
      },
    ]);
  });

  it('for every channel is the contact’s do not contact, reported as the contact command reports it', async () => {
    const { t, who, id } = await fixture();
    const before = await read(who, id);
    const on = await set(who, id, true, ['email'], before.dnd.revision);
    expect(on.dnd).toMatchObject({ all: true, channels: ['email'] });
    const contact = await withTenant(db, who.context, (trx) => readContact(trx, who, id));
    expect(contact.doNotContact).toBe(true);
    // The same settings again change nothing and report nothing.
    const same = await set(who, id, true, ['email'], on.dnd.revision);
    expect(same.dnd.revision).toBe(on.dnd.revision);
    const off = await set(who, id, false, ['email'], same.dnd.revision);
    expect(off.dnd).toMatchObject({ all: false, channels: ['email'] });
    expect(await eventsOf(t)).toEqual([
      { type: 'contact.do_not_contact_set', payload: {} },
      // The same save turned do not contact on: its channel change says so, for whoever
      // counts saves rather than events (the Contact DND trigger).
      {
        type: 'contact.dnd_changed',
        payload: { channels: ['email'], enabled: ['email'], disabled: [], doNotContact: 'set' },
      },
      { type: 'contact.do_not_contact_cleared', payload: {} },
    ]);
  });

  it('blocks calls and text messages from the contact when inbound is on, apart from what is sent to them', async () => {
    const { t, who, id } = await fixture();
    const before = await read(who, id);
    expect(before.dnd).toMatchObject({ all: false, channels: [], inbound: false });

    const on = await call('setContactDnd', who, id, {
      all: false,
      channels: ['email'],
      inbound: true,
      reason,
      revision: before.dnd.revision,
    });
    expect(on.dnd).toMatchObject({ all: false, channels: ['email'], inbound: true });
    expect(on.dnd.revision).not.toBe(before.dnd.revision);
    expect(await storedInbound(t)).toBe(true);
    // Left out, inbound stays as it is; the outbound channels change alone.
    const kept = await set(who, id, false, ['email', 'sms'], on.dnd.revision);
    expect(kept.dnd).toMatchObject({ channels: ['email', 'sms'], inbound: true });
    // Turning inbound off alone changes only inbound, and its revision.
    const off = await call('setContactDnd', who, id, {
      all: false,
      channels: ['email', 'sms'],
      inbound: false,
      reason,
      revision: kept.dnd.revision,
    });
    expect(off.dnd).toMatchObject({ channels: ['email', 'sms'], inbound: false });
    expect(off.dnd.revision).not.toBe(kept.dnd.revision);
    // A revision from before inbound changed is stale.
    expect(
      await failure(
        call('setContactDnd', who, id, {
          all: false,
          channels: [],
          inbound: true,
          reason,
          revision: kept.dnd.revision,
        }),
      ),
    ).toBeInstanceOf(ConflictError);
    expect(await eventsOf(t)).toEqual([
      { type: 'contact.inbound_dnd_set', payload: {} },
      {
        type: 'contact.dnd_changed',
        payload: { channels: ['email'], enabled: ['email'], disabled: [] },
      },
      {
        type: 'contact.dnd_changed',
        payload: { channels: ['email', 'sms'], enabled: ['sms'], disabled: [] },
      },
      { type: 'contact.inbound_dnd_cleared', payload: {} },
    ]);
  });

  it('keeps the reason in the audit log and in no event, and needs one', async () => {
    const { t, who, id } = await fixture();
    const { dnd } = await read(who, id);
    for (const body of [
      { all: false, channels: ['sms'], revision: dnd.revision },
      { all: false, channels: ['sms'], revision: dnd.revision, reason: 'Too short' },
    ]) {
      const refused = await failure(call('setContactDnd', who, id, body));
      expect((refused as ValidationError).issues[0]).toMatchObject({ path: '/reason' });
    }
    expect(await stored(t)).toEqual({ do_not_contact: false, dnd_channels: [] });
    await set(who, id, false, ['sms'], dnd.revision);
    const audit = await database.as('crm_owner', (sql) =>
      sql.query<{ input: { reason: string }; outcome: string }>(
        `select input, outcome from audit.commands
         where business_id = $1 and command = 'contact.set_dnd' and outcome = 'ok'`,
        [t.businessId],
      ),
    );
    expect(audit.map((row) => row.input.reason)).toEqual([reason]);
    expect(JSON.stringify(await eventsOf(t))).not.toContain('Asked by phone');
  });

  it('is refused when based on settings someone else has since changed, by either command', async () => {
    const { t, who, id } = await fixture();
    const opened = await read(who, id);
    await set(who, id, false, ['email'], opened.dnd.revision);
    expect(await failure(set(who, id, false, ['sms'], opened.dnd.revision))).toBeInstanceOf(
      ConflictError,
    );
    expect((await stored(t)).dnd_channels).toEqual(['email']);

    // The contact command turns do not contact on: what this page opened is stale too.
    const fresh = await read(who, id);
    const contact = await withTenant(db, who.context, (trx) => readContact(trx, who, id));
    await runCommand(
      services,
      updateContactCommand,
      {
        id,
        doNotContact: true,
        doNotContactReason: reason,
        preferencesRevision: contact.preferencesRevision,
      },
      who,
    );
    expect(await failure(set(who, id, false, [], fresh.dnd.revision))).toBeInstanceOf(
      ConflictError,
    );
    // And the other way round: this command turns it off, so the contact command's
    // revision from before is stale.
    const now = await read(who, id);
    const during = await withTenant(db, who.context, (trx) => readContact(trx, who, id));
    await set(who, id, false, ['email'], now.dnd.revision);
    expect(
      await failure(
        runCommand(
          services,
          updateContactCommand,
          { id, timeZone: 'UTC', preferencesRevision: during.preferencesRevision },
          who,
        ),
      ),
    ).toBeInstanceOf(ConflictError);
    expect(await stored(t)).toEqual({ do_not_contact: false, dnd_channels: ['email'] });
  });

  it('is changed by exactly one of two people who change it at once from the same revision', async () => {
    const { t, who, id } = await fixture();
    const { dnd } = await read(who, id);
    // Someone holds the contact's row; both changes wait for it, then run one after the other.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = database.as('crm_owner', async (sql) => {
      await sql.query('select 1 from crm.contacts where business_id = $1 and id = $2 for update', [
        t.businessId,
        parsePublicId('contact', id),
      ]);
      locked();
      await held;
    });
    await holding;
    const attempts = [
      set(who, id, false, ['email'], dnd.revision),
      set(who, id, false, ['sms'], dnd.revision),
    ];
    await waitingForLock(database, 2);
    release();
    await holder;
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((each) => each.status === 'fulfilled')).toHaveLength(1);
    const [lost] = settled.flatMap((each) =>
      each.status === 'rejected' ? [each.reason as unknown] : [],
    );
    expect(lost).toBeInstanceOf(ConflictError);
    // One switch is on, not both and not neither.
    expect((await stored(t)).dnd_channels).toHaveLength(1);
  });

  it('is another business’s to change only for that business, needs contacts.manage, and waits for a contact in the trash to be restored', async () => {
    const { t, who, id } = await fixture();
    const elsewhere = await fixture();
    const { dnd } = await read(who, id);
    expect(await failure(set(elsewhere.who, id, true, [], dnd.revision))).toBeInstanceOf(
      NotFoundError,
    );
    const refused = await failure(
      set({ ...who, permissions: new Set<never>() }, id, true, [], dnd.revision),
    );
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as ForbiddenError).permission).toBe('contacts.manage');
    await database.as('crm_owner', (sql) =>
      sql.query('update crm.contacts set deleted_at = now() where business_id = $1', [
        t.businessId,
      ]),
    );
    expect(await failure(set(who, id, true, [], dnd.revision))).toBeInstanceOf(ConflictError);
    expect(await stored(t)).toEqual({ do_not_contact: false, dnd_channels: [] });
    expect((await read(who, id)).dnd).toMatchObject({ all: false, channels: [] });
  });
});
