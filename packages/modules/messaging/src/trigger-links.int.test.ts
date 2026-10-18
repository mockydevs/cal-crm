// Trigger links against real Postgres: the link and its permanent key, the token a message
// carries for one contact, what opening it records and answers, and the Analyze reads.
// Another business sees none of it, and nothing in an address says who it is for.
import { createHash, randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  permissions,
  triggerLink,
  triggerLinkClickList,
  triggerLinkList,
  type Permission,
  type TriggerLink,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { ConflictError, ForbiddenError, NotFoundError, toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  issueTriggerLinkAddresses,
  openTriggerLink,
  renderWithTriggerLinks,
  TRIGGER_LINK_REPEAT_SECONDS,
} from './trigger-link-tokens.js';
import {
  createTriggerLinkCommand,
  deleteTriggerLinkCommand,
  readTriggerLink,
  readTriggerLinkClicks,
  readTriggerLinks,
  updateTriggerLinkCommand,
} from './trigger-links.js';

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

const PUBLIC_URL = 'https://crm.example';
const offer = { name: 'Spring offer', url: 'https://harbor.example/offer?x=1' };
const everythingBut = (...denied: Permission[]): readonly Permission[] =>
  permissions.filter((each) => !denied.includes(each));
const tokenOf = (address: string | undefined): string => address?.split('/').at(-1) ?? '';

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const as = (granted: readonly Permission[] | 'all' = 'all'): Invocation => ({
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: granted === 'all' ? 'all' : new Set(granted),
  });
  const run = <T>(work: (trx: DatabaseTransaction) => Promise<T>) =>
    withTenant(db, as().context, work);
  const sqlOf = <T extends object>(text: string, values: unknown[] = []) =>
    database.withTenant(business.context, (sql) => sql.query<T>(text, values));
  return {
    business,
    as,
    sqlOf,
    create: (input: unknown = offer, invocation = as()): Promise<TriggerLink> =>
      runCommand(services, createTriggerLinkCommand, input, invocation),
    update: (
      saved: Pick<TriggerLink, 'id' | 'revision' | 'name' | 'url'>,
      patch: Record<string, unknown> = {},
      invocation = as(),
    ): Promise<TriggerLink> =>
      runCommand(
        services,
        updateTriggerLinkCommand,
        { name: saved.name, url: saved.url, revision: saved.revision, ...patch, linkId: saved.id },
        invocation,
      ),
    remove: (linkId: string, invocation = as()) =>
      runCommand(services, deleteTriggerLinkCommand, { linkId }, invocation),
    read: (linkId: string) => run((trx) => readTriggerLink(trx, as(), linkId)),
    list: (query: Record<string, unknown> = {}, invocation = as()) =>
      run((trx) => readTriggerLinks(trx, invocation, { limit: 20, ...query })),
    clicks: (linkId: string, query: Record<string, unknown> = {}) =>
      run((trx) => readTriggerLinkClicks(trx, as(), linkId, { limit: 20, ...query })),
    contact: async (firstName = 'Ada') =>
      (await database.fixtures.contact(business.context, { firstName })).id,
    /** The address a message for this contact would carry for these keys. */
    issue: (contactId: string, keys: string[], ...address: [publicUrl?: string | undefined]) =>
      run((trx) =>
        issueTriggerLinkAddresses(trx, as().context, {
          contactId,
          keys,
          publicUrl: address.length === 0 ? PUBLIC_URL : address[0],
        }),
      ),
    renderFor: (
      contactId: string,
      body: string,
      values: Record<string, string> = {},
      ...address: [publicUrl?: string | undefined]
    ) =>
      run((trx) =>
        renderWithTriggerLinks(trx, as().context, {
          contactId,
          text: { subject: '', body },
          values,
          publicUrl: address.length === 0 ? PUBLIC_URL : address[0],
        }),
      ),
    count: async (table: string) =>
      Number((await sqlOf<{ n: string }>(`select count(*) as n from ${table}`))[0]?.n),
    events: (type: string) =>
      sqlOf<{
        subject_kind: string;
        actor_kind: string;
        payload: Record<string, unknown>;
        records: string[];
      }>(
        `select e.subject_kind, e.actor_kind, e.payload,
                array(select t.record_id::text from crm.timeline_entries t
                      where t.event_id = e.id) as records
         from events.events e where e.type = $1 order by e.recorded_at, e.id`,
        [type],
      ),
  };
}

describe('a trigger link', () => {
  it('gets a key from its name that it keeps, and answers as its contract says', async () => {
    const world = await fixture();
    const saved = triggerLink.parse(await world.create());
    expect(saved).toMatchObject({
      name: 'Spring offer',
      url: offer.url,
      key: 'spring_offer',
      mergeKey: 'trigger_link.spring_offer',
      clicks: 0,
      contacts: 0,
      lastClickedAt: null,
    });
    const changed = await world.update(saved, { name: 'Summer', url: 'http://harbor.example/s' });
    expect(changed).toMatchObject({ name: 'Summer', key: 'spring_offer' });
    expect(await world.events('trigger_link.updated')).toMatchObject([
      {
        payload: {
          key: 'spring_offer',
          name: 'Summer',
          url: 'http://harbor.example/s',
          previousUrl: offer.url,
        },
      },
    ]);
  });

  it('numbers a key made from a name another link already gave, and refuses a chosen one', async () => {
    const world = await fixture();
    await world.create({ ...offer, name: 'Offer!' });
    expect((await world.create({ ...offer, name: 'offer' })).key).toBe('offer_2');
    expect((await world.create({ ...offer, name: '2026' })).key).toBe('link_2026');
    await expect(world.create({ ...offer, name: 'Other', key: 'offer' })).rejects.toMatchObject({
      issues: [{ path: '/key', code: 'taken' }],
    });
    await expect(world.create({ ...offer, name: ' OFFER! ' })).rejects.toMatchObject({
      issues: [{ path: '/name', code: 'taken' }],
    });
  });

  it('gives two creates of one name at the same moment one link', async () => {
    const world = await fixture();
    const results = await Promise.allSettled([world.create(), world.create()]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('keeps its key and a web address whatever writes to the table', async () => {
    const world = await fixture();
    await world.create();
    await expect(world.sqlOf(`update messaging.trigger_links set key = 'other'`)).rejects.toThrow(
      /keeps its key/,
    );
    for (const url of ['javascript:alert(1)', 'https://x.example/a b', '//x.example', ''])
      await expect(
        world.sqlOf(`update messaging.trigger_links set url = $1`, [url]),
      ).rejects.toThrow(/trigger_links_url_valid/);
  });

  it('is saved only from the revision it was read at, and a same save reports nothing', async () => {
    const world = await fixture();
    const saved = await world.create();
    expect((await world.update(saved)).revision).toBe(saved.revision);
    expect(await world.events('trigger_link.updated')).toEqual([]);
    await world.update(saved, { name: 'Later' });
    await expect(world.update(saved, { name: 'Stale' })).rejects.toBeInstanceOf(ConflictError);
    // An id that is not one names nothing, as an id nothing has does.
    await expect(world.read('not-an-id')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('records who made it, or nobody when the system did, and stops at 1,000 for one business', async () => {
    const world = await fixture();
    await world.create(
      { ...offer, name: 'By the system' },
      {
        context: world.business.context,
        permissions: 'all',
      },
    );
    expect(
      await world.sqlOf(`select created_by_id is not null as by from messaging.trigger_links`),
    ).toEqual([{ by: false }]);
    await world.sqlOf(
      `insert into messaging.trigger_links (business_id, name, key, url, created_by_kind)
       select app.business_id(), 'Link ' || n, 'link_' || n, 'https://harbor.example/', 'user'
       from generate_series(1, 999) n`,
    );
    await expect(world.create()).rejects.toMatchObject({
      issues: [{ path: '/name', code: 'limit_reached' }],
    });
  });

  it('is changed only by someone who may manage templates, and read by any member', async () => {
    const world = await fixture();
    const saved = await world.create();
    const viewer = world.as(everythingBut('templates.manage'));
    await expect(world.create({ ...offer, name: 'No' }, viewer)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(world.update(saved, { name: 'No' }, viewer)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(world.remove(saved.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await world.list({}, viewer)).toMatchObject({ total: 1, canManage: false });
    expect((await world.list()).canManage).toBe(true);
  });

  it('is invisible to another business, and so are its tokens', async () => {
    const world = await fixture();
    const other = await fixture();
    const saved = await world.create();
    await expect(other.read(saved.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.update(saved, { name: 'Theirs' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.remove(saved.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.clicks(saved.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await other.list()).toMatchObject({ items: [], total: 0 });
    // The other business has no link with this key, so nothing is issued there.
    expect(await other.issue(await other.contact(), ['spring_offer'])).toEqual({});
    await world.issue(await world.contact(), ['spring_offer']);
    expect(await other.count('messaging.trigger_link_tokens')).toBe(0);
  });

  it('lists newest first, a page at a time, and finds by name, key or address', async () => {
    const world = await fixture();
    for (const name of ['One', 'Two', 'Three'])
      await world.create({ name, url: `https://harbor.example/${name.toLowerCase()}` });
    const first = triggerLinkList.parse(await world.list({ limit: 2 }));
    expect(first.items.map((item) => item.name)).toEqual(['Three', 'Two']);
    expect(first.total).toBe(3);
    const second = await world.list({ limit: 2, after: first.next });
    expect(second.items.map((item) => item.name)).toEqual(['One']);
    expect(second.next).toBeNull();
    expect((await world.list({ q: 'example/tw' })).items.map((item) => item.name)).toEqual(['Two']);
    expect((await world.list({ q: 'THREE' })).total).toBe(1);
    // A % or an _ is looked for as written, not as "anything".
    expect((await world.list({ q: '%' })).total).toBe(0);
    expect((await world.list({ q: 'T_o' })).total).toBe(0);
    await expect(world.list({ after: 'nope' })).rejects.toMatchObject({
      issues: [{ path: '/after', code: 'invalid_cursor' }],
    });
  });
});

describe('a trigger link in a message', () => {
  it('becomes an address of this install that holds one random token and nothing else', async () => {
    const world = await fixture();
    const saved = await world.create();
    const contact = await world.contact();
    const addresses = await world.issue(contact, ['spring_offer', 'no_such_link']);
    expect(Object.keys(addresses)).toEqual(['trigger_link.spring_offer']);
    const address = addresses['trigger_link.spring_offer'] ?? '';
    expect(address).toMatch(/^https:\/\/crm\.example\/l\/[A-Za-z0-9_-]{43}$/);
    // No id of the link, the contact or the business is in it.
    for (const secret of [contact, saved.id, saved.key, world.business.id])
      expect(address).not.toContain(secret);
    // Only the token's digest is stored.
    const [stored] = await world.sqlOf<{ digest: string }>(
      `select digest from messaging.trigger_link_tokens`,
    );
    expect(stored?.digest).toBe(createHash('sha256').update(tokenOf(address)).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(tokenOf(address));
    // Each message gets its own.
    const again = await world.issue(contact, ['spring_offer']);
    expect(again['trigger_link.spring_offer']).not.toBe(address);
  });

  it('has no address on an install without a public web address', async () => {
    const world = await fixture();
    await world.create();
    const contact = await world.contact();
    expect(await world.issue(contact, ['spring_offer'], undefined)).toEqual({});
    expect(await world.issue(contact, ['spring_offer'], 'ftp://crm.example')).toEqual({});
    expect(await world.issue(contact, ['spring_offer'], 'https://u:p@crm.example')).toEqual({});
    expect(await world.issue(contact, ['spring_offer'], 'not a url')).toEqual({});
    // And a message that writes the link stops there, as for any field with no value.
    expect(
      await world.renderFor(contact, 'See {{trigger_link.spring_offer}}', {}, undefined),
    ).toEqual({
      ok: false,
      code: 'missing_values',
      fields: ['trigger_link.spring_offer'],
    });
    // Text with no link in it asks for nothing.
    expect(await world.issue(contact, [])).toEqual({});
    expect(await world.count('messaging.trigger_link_tokens')).toBe(0);
  });

  it('is filled in with the rest of the text, or stops the text with what is missing', async () => {
    const world = await fixture();
    await world.create();
    const contact = await world.contact();
    const body = 'Hi {{contact.firstName}}: {{trigger_link.spring_offer}} or {{trigger_link.gone}}';
    expect(await world.renderFor(contact, body, { 'contact.firstName': 'Ada' })).toEqual({
      ok: false,
      code: 'missing_values',
      fields: ['trigger_link.gone'],
    });
    expect(
      await world.renderFor(contact, 'Hi {{contact.firstName}} {{trigger_link.spring_offer}}'),
    ).toEqual({
      ok: false,
      code: 'missing_values',
      fields: ['contact.firstName'],
    });
    // Text that did not fill in issued nothing.
    expect(await world.count('messaging.trigger_link_tokens')).toBe(0);
    const rendered = await world.renderFor(
      contact,
      'Hi {{contact.firstName}}: {{trigger_link.spring_offer}}',
      { 'contact.firstName': 'Ada' },
    );
    expect(rendered).toMatchObject({ ok: true });
    expect(rendered.ok && rendered.body).toMatch(/^Hi Ada: https:\/\/crm\.example\/l\/.{43}$/);
    expect(await world.count('messaging.trigger_link_tokens')).toBe(1);
    expect(await world.renderFor(contact, 'No link here')).toEqual({
      ok: true,
      subject: '',
      body: 'No link here',
    });
  });
});

describe('opening a trigger link', () => {
  async function sent() {
    const world = await fixture();
    const link = await world.create();
    const contact = await world.contact();
    const addresses = await world.issue(contact, ['spring_offer']);
    const token = tokenOf(addresses['trigger_link.spring_offer']);
    return { world, link, contact, token, open: () => openTriggerLink(db, token, randomUUID()) };
  }

  it('records the click as the contact, tells the timeline, and answers the stored address', async () => {
    const { world, link, contact, open } = await sent();
    expect(await open()).toBe(offer.url);
    expect(await world.events('trigger_link.clicked')).toEqual([
      {
        subject_kind: 'trigger_link',
        actor_kind: 'contact',
        payload: { linkId: link.id, key: 'spring_offer', name: 'Spring offer' },
        records: [contact],
      },
    ]);
    const read = await world.read(link.id);
    expect(read).toMatchObject({ clicks: 1, contacts: 1 });
    expect(read.lastClickedAt).not.toBeNull();
  });

  it('answers nothing for a token that was never issued, or is not a token at all', async () => {
    const { world } = await sent();
    for (const token of [
      'A'.repeat(43),
      '',
      'short',
      `${'A'.repeat(42)}/`,
      `${'A'.repeat(43)}?next=https://evil.example`,
      '../../api/v1/me',
    ])
      expect(await openTriggerLink(db, token, randomUUID())).toBeUndefined();
    expect(await world.count('messaging.trigger_link_clicks')).toBe(0);
    expect(await world.events('trigger_link.clicked')).toEqual([]);
  });

  it(`sends the browser on again within ${String(TRIGGER_LINK_REPEAT_SECONDS)} seconds without counting twice`, async () => {
    const { world, open } = await sent();
    expect(await open()).toBe(offer.url);
    expect(await open()).toBe(offer.url);
    expect(await world.count('messaging.trigger_link_clicks')).toBe(1);
    expect(await world.events('trigger_link.clicked')).toHaveLength(1);
    // Once that time has passed, a click counts again.
    await database.as('postgres', (sql) =>
      sql.query(
        `update messaging.trigger_link_clicks set clicked_at = now() - make_interval(secs => $1)`,
        [TRIGGER_LINK_REPEAT_SECONDS + 1],
      ),
    );
    expect(await open()).toBe(offer.url);
    expect(await world.count('messaging.trigger_link_clicks')).toBe(2);
    expect(await world.events('trigger_link.clicked')).toHaveLength(2);
  });

  it('counts once when the same address is opened many times at the same moment', async () => {
    const { world, open } = await sent();
    const answers = await Promise.all(Array.from({ length: 6 }, () => open()));
    expect(answers).toEqual(Array.from({ length: 6 }, () => offer.url));
    expect(await world.count('messaging.trigger_link_clicks')).toBe(1);
  });

  it('follows the link’s destination when it changes, and stops when the link is deleted', async () => {
    const { world, link, open } = await sent();
    await world.update(link, { url: 'https://harbor.example/new' });
    expect(await open()).toBe('https://harbor.example/new');
    await world.remove(link.id);
    expect(await open()).toBeUndefined();
    expect(await world.count('messaging.trigger_link_tokens')).toBe(0);
    expect(await world.count('messaging.trigger_link_clicks')).toBe(0);
  });

  it('never answers with anything but a web address, whatever a row holds', async () => {
    const { open } = await sent();
    // The table's own check is taken away to stand in for a row that predates it.
    await database.as('postgres', async (sql) => {
      await sql.query(
        `alter table messaging.trigger_links drop constraint trigger_links_url_valid`,
      );
      await sql.query(`update messaging.trigger_links set url = 'javascript:alert(1)'`);
    });
    try {
      expect(await open()).toBeUndefined();
    } finally {
      await database.as('postgres', async (sql) => {
        await sql.query(`update messaging.trigger_links set url = 'https://harbor.example/'`);
        await sql.query(
          `alter table messaging.trigger_links add constraint trigger_links_url_valid
             check (length(url) between 1 and 2000 and url ~ '^https?://[^[:space:][:cntrl:]]+$')`,
        );
      });
    }
  });

  it('lists who clicked, newest first, with the counts for the range asked for', async () => {
    const { world, link, contact, open } = await sent();
    const grace = await world.contact('Grace');
    const second = tokenOf(
      (await world.issue(grace, ['spring_offer']))['trigger_link.spring_offer'],
    );
    await open();
    await database.as('postgres', (sql) =>
      sql.query(`update messaging.trigger_link_clicks set clicked_at = '2026-09-01T10:00:00Z'`),
    );
    await openTriggerLink(db, second, randomUUID());
    await open();
    const all = triggerLinkClickList.parse(await world.clicks(link.id));
    expect(all.items.map((item) => item.contact.name)).toEqual(['Ada', 'Grace', 'Ada']);
    expect(all).toMatchObject({ clicks: 3, contacts: 2, next: null });
    expect(all.items[0]?.contact).toEqual({
      id: toPublicId('contact', contact),
      name: 'Ada',
      trashed: false,
    });
    const first = await world.clicks(link.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    const rest = await world.clicks(link.id, { limit: 2, after: first.next });
    expect(rest.items.map((item) => item.clickedAt)).toEqual(['2026-09-01T10:00:00.000Z']);
    expect(rest.next).toBeNull();
    const september = await world.clicks(link.id, {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expect(september).toMatchObject({ clicks: 1, contacts: 1 });
    expect(september.items).toHaveLength(1);
    await expect(
      world.clicks(link.id, { from: '2026-10-01T00:00:00Z', to: '2026-09-01T00:00:00Z' }),
    ).rejects.toMatchObject({ issues: [{ path: '/to', code: 'invalid_range' }] });
    expect(await world.list()).toMatchObject({ items: [{ clicks: 3, contacts: 2 }] });
  });
});
