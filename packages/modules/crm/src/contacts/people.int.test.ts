// A contact's owner and followers, against a migrated Postgres as crm_app under row-level
// security, through the routes the server registers.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { contactDetails, MAX_CONTACT_FOLLOWERS, type ContactDetails } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  detailOptions,
  team,
  waitingForLock,
  type Gate,
  type Member,
  type Team,
} from '../../test/contact-details.js';
import { contactDetailRoutes } from './detail-routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const gate: Gate = { whenResolving: () => Promise.resolve() };
const routes = contactDetailRoutes(detailOptions(gate));

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

async function contactOf(t: Team): Promise<string> {
  return toPublicId('contact', (await database.fixtures.contact(t.context)).id);
}
const read = (invocation: Invocation, id: string) => call('getContactDetails', invocation, id);
const assign = (invocation: Invocation, id: string, owner: string | null, revision: string) =>
  call('assignContactOwner', invocation, id, { owner, revision });
const follow = (invocation: Invocation, id: string, followers: readonly string[]) =>
  call('addContactFollowers', invocation, id, { followers });
const unfollow = (invocation: Invocation, id: string, followers: readonly string[]) =>
  call('removeContactFollowers', invocation, id, { followers });

/** The contact's events of these kinds, oldest first, with what each says. */
const eventsOf = (t: Team, prefix: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ type: string; payload: unknown }>(
      `select type, payload from events.events
       where business_id = $1 and type like $2 order by recorded_at, id`,
      [t.businessId, `${prefix}%`],
    ),
  );

const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
/** What each attempt failed with. Every one is watched from the start, so none fails unseen. */
const failures = (attempts: readonly Promise<unknown>[]): Promise<unknown[]> =>
  Promise.all(attempts.map(failure));

describe("a contact's owner", () => {
  it('starts as nobody, and is one team member once assigned', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const id = await contactOf(t);

    const before = await read(dana.as(), id);
    expect(before).toMatchObject({ id, owner: null, followers: [], canManage: true });

    const after = await assign(dana.as(), id, dana.membershipId, before.ownerRevision);
    expect(after.owner).toEqual({
      membershipId: dana.membershipId,
      name: 'Dana Brooks',
      you: true,
    });
    expect(after.ownerRevision).not.toBe(before.ownerRevision);
    // Someone else reads the same owner, who is not them.
    const lee = await t.member('Lee Park');
    expect((await read(lee.as(), id)).owner).toMatchObject({ name: 'Dana Brooks', you: false });
    expect(await eventsOf(t, 'contact.owner_')).toEqual([
      { type: 'contact.owner_assigned', payload: { assignedUserId: dana.userId } },
    ]);
  });

  it('can be "me", can change hands, and can be nobody again, each reported once', async () => {
    const t = await team(database);
    const dana = await t.member();
    const lee = await t.member();
    const id = await contactOf(t);
    const first = await assign(dana.as(), id, 'me', (await read(dana.as(), id)).ownerRevision);
    expect(first.owner?.membershipId).toBe(dana.membershipId);
    // The same owner again changes nothing and reports nothing.
    const same = await assign(dana.as(), id, dana.membershipId, first.ownerRevision);
    expect(same.ownerRevision).toBe(first.ownerRevision);
    const second = await assign(dana.as(), id, lee.membershipId, same.ownerRevision);
    expect(second.owner).toMatchObject({ membershipId: lee.membershipId, you: false });
    const none = await assign(dana.as(), id, null, second.ownerRevision);
    expect(none.owner).toBeNull();
    expect(await eventsOf(t, 'contact.owner_')).toEqual([
      { type: 'contact.owner_assigned', payload: { assignedUserId: dana.userId } },
      { type: 'contact.owner_assigned', payload: { assignedUserId: lee.userId } },
      { type: 'contact.owner_unassigned', payload: {} },
    ]);
    // On the contact's own timeline, by the person who did it.
    const timeline = await database.as('crm_owner', (sql) =>
      sql.query(
        'select 1 from crm.timeline_entries where business_id = $1 and event_type like $2',
        [t.businessId, 'contact.owner_%'],
      ),
    );
    expect(timeline).toHaveLength(3);
  });

  it('is refused when based on an owner someone else has since changed', async () => {
    const t = await team(database);
    const dana = await t.member();
    const lee = await t.member();
    const id = await contactOf(t);
    const opened = await read(dana.as(), id);
    await assign(lee.as(), id, lee.membershipId, opened.ownerRevision);

    const stale = await failure(assign(dana.as(), id, dana.membershipId, opened.ownerRevision));
    expect(stale).toBeInstanceOf(ConflictError);
    expect((await read(dana.as(), id)).owner?.membershipId).toBe(lee.membershipId);
    expect(await eventsOf(t, 'contact.owner_')).toHaveLength(1);
  });

  it('goes to exactly one of two people who assign it at once from the same revision', async () => {
    const t = await team(database);
    const dana = await t.member();
    const lee = await t.member();
    const id = await contactOf(t);
    const { ownerRevision } = await read(dana.as(), id);
    // The first holds the contact's row inside its transaction until the second is waiting
    // for that row; only then does it go on. So the two truly overlap.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const atResolve = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let calls = 0;
    gate.whenResolving = async () => {
      calls += 1;
      if (calls === 1) {
        reached();
        await held;
      }
    };
    try {
      const first = assign(dana.as(), id, dana.membershipId, ownerRevision);
      await atResolve;
      const second = assign(lee.as(), id, lee.membershipId, ownerRevision);
      await waitingForLock(database);
      release();
      const [won, lost] = await Promise.allSettled([first, second]);
      expect(won.status).toBe('fulfilled');
      expect(lost.status === 'rejected' && lost.reason).toBeInstanceOf(ConflictError);
    } finally {
      gate.whenResolving = () => Promise.resolve();
    }
    expect((await read(dana.as(), id)).owner?.membershipId).toBe(dana.membershipId);
    expect(await eventsOf(t, 'contact.owner_')).toHaveLength(1);
  });

  it('must be someone on this team, and the refusal points at the field', async () => {
    const t = await team(database);
    const dana = await t.member();
    const outsider = await (await team(database)).member();
    const id = await contactOf(t);
    const { ownerRevision } = await read(dana.as(), id);
    const refused = await failure(assign(dana.as(), id, outsider.membershipId, ownerRevision));
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).issues).toEqual([
      expect.objectContaining({ path: '/owner', code: 'unavailable_member' }),
    ]);
    expect((await read(dana.as(), id)).owner).toBeNull();
    // The body is checked as the API documents it: a revision is always named over HTTP.
    const unnamed = await failure(
      call('assignContactOwner', dana.as(), id, { owner: dana.membershipId }),
    );
    expect((unnamed as ValidationError).issues[0]).toMatchObject({ path: '/revision' });
  });

  it('stays the owner, shown as no longer on the team, when they leave, until someone changes it', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const lee = await t.member();
    const id = await contactOf(t);
    await assign(dana.as(), id, dana.membershipId, (await read(dana.as(), id)).ownerRevision);
    await t.remove(dana);

    const left = await read(lee.as(), id);
    // Their name is the auth module's to show; it shows only people on the reader's team.
    expect(left.owner).toMatchObject({ membershipId: null, you: false });
    const taken = await assign(lee.as(), id, 'me', left.ownerRevision);
    expect(taken.owner?.membershipId).toBe(lee.membershipId);
  });
});

describe("a contact's followers", () => {
  it('are added once each, in the order added, and removed, each change reported once', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const lee = await t.member('Lee Park');
    const id = await contactOf(t);

    const one = await follow(dana.as(), id, ['me']);
    expect(one.followers).toEqual([
      { membershipId: dana.membershipId, name: 'Dana Brooks', you: true },
    ]);
    // Naming someone who already follows, or the same person twice, adds them once.
    const two = await follow(dana.as(), id, [
      dana.membershipId,
      lee.membershipId,
      lee.membershipId,
    ]);
    expect(two.followers.map((each) => each.name)).toEqual(['Dana Brooks', 'Lee Park']);
    // Removing someone who doesn't follow changes nothing.
    const gone = await unfollow(dana.as(), id, [dana.membershipId]);
    expect(gone.followers.map((each) => each.name)).toEqual(['Lee Park']);
    expect((await unfollow(dana.as(), id, [dana.membershipId])).followers).toHaveLength(1);

    expect(await eventsOf(t, 'contact.follower_')).toEqual([
      { type: 'contact.follower_added', payload: { followerUserId: dana.userId } },
      { type: 'contact.follower_added', payload: { followerUserId: lee.userId } },
      { type: 'contact.follower_removed', payload: { followerUserId: dana.userId } },
    ]);
    const stored = await database.as('crm_owner', (sql) =>
      sql.query<{ added_by_kind: string; added_by_id: string }>(
        'select added_by_kind, added_by_id from crm.contact_followers where business_id = $1',
        [t.businessId],
      ),
    );
    expect(stored).toEqual([{ added_by_kind: 'user', added_by_id: dana.userId }]);
  });

  it(`are at most ${String(MAX_CONTACT_FOLLOWERS)}, and a list over that adds nobody`, async () => {
    const t = await team(database);
    const members: Member[] = [];
    for (let index = 0; index <= MAX_CONTACT_FOLLOWERS; index += 1) members.push(await t.member());
    const [first, ...rest] = members;
    if (first === undefined) throw new Error('No members.');
    const id = await contactOf(t);
    await follow(first.as(), id, ['me']);
    const refused = await failure(
      follow(
        first.as(),
        id,
        rest.map((each) => each.membershipId),
      ),
    );
    expect((refused as ValidationError).issues).toEqual([
      expect.objectContaining({ path: '/followers', code: 'too_many_followers' }),
    ]);
    expect((await read(first.as(), id)).followers).toHaveLength(1);
    const full = await follow(
      first.as(),
      id,
      rest.slice(1).map((each) => each.membershipId),
    );
    expect(full.followers).toHaveLength(MAX_CONTACT_FOLLOWERS);
  });

  it('never pass the limit when two people add the last ones at once', async () => {
    const t = await team(database);
    const members: Member[] = [];
    for (let index = 0; index < MAX_CONTACT_FOLLOWERS + 1; index += 1)
      members.push(await t.member());
    const id = await contactOf(t);
    const [dana, lee] = members;
    if (dana === undefined || lee === undefined) throw new Error('No members.');
    // Eight follow already; each of two requests adds two more, which together is over.
    await follow(
      dana.as(),
      id,
      members.slice(0, MAX_CONTACT_FOLLOWERS - 2).map((each) => each.membershipId),
    );
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const atResolve = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let calls = 0;
    gate.whenResolving = async () => {
      calls += 1;
      if (calls === 1) {
        reached();
        await held;
      }
    };
    const last = members.slice(MAX_CONTACT_FOLLOWERS - 2).map((each) => each.membershipId);
    try {
      const first = follow(dana.as(), id, last.slice(0, 2));
      await atResolve;
      const second = follow(lee.as(), id, last.slice(1, 3));
      await waitingForLock(database);
      release();
      const [won, lost] = await Promise.allSettled([first, second]);
      expect(won.status).toBe('fulfilled');
      expect(lost.status === 'rejected' && lost.reason).toBeInstanceOf(ValidationError);
    } finally {
      gate.whenResolving = () => Promise.resolve();
    }
    expect((await read(dana.as(), id)).followers).toHaveLength(MAX_CONTACT_FOLLOWERS);
  });

  it('must be on this team; one who leaves is left out, and follows again on coming back', async () => {
    const t = await team(database);
    const dana = await t.member();
    const lee = await t.member('Lee Park');
    const outsider = await (await team(database)).member();
    const id = await contactOf(t);
    const refused = await failure(follow(dana.as(), id, [lee.membershipId, outsider.membershipId]));
    expect((refused as ValidationError).issues).toEqual([
      expect.objectContaining({ path: '/followers/1', code: 'unavailable_member' }),
    ]);
    expect((await read(dana.as(), id)).followers).toEqual([]);

    await follow(dana.as(), id, [lee.membershipId]);
    await t.remove(lee);
    expect((await read(dana.as(), id)).followers).toEqual([]);
    // Their row is kept: a follower is a person, as an owner is.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into tenancy.memberships (agency_id, business_id, role_id, user_id)
         select agency_id, $1, id, $2 from tenancy.roles
         where agency_id = (select agency_id from tenancy.businesses where id = $1) limit 1`,
        [t.businessId, lee.userId],
      ),
    );
    expect((await read(dana.as(), id)).followers).toEqual([
      expect.objectContaining({ name: 'Lee Park' }),
    ]);
  });
});

describe('who can read and change them', () => {
  it("can't reach another business's contact, by reading or by any change", async () => {
    const t = await team(database);
    const other = await team(database);
    const dana = await t.member();
    const id = await contactOf(other);
    const { ownerRevision } = await read(other.system(), id);
    for (const refused of await failures([
      read(dana.as(), id),
      assign(dana.as(), id, dana.membershipId, ownerRevision),
      follow(dana.as(), id, ['me']),
      unfollow(dana.as(), id, ['me']),
    ]))
      expect(refused).toBeInstanceOf(NotFoundError);
    expect(await read(other.system(), id)).toMatchObject({ owner: null, followers: [] });
  });

  it('needs contacts.manage for a change, and nothing for a read', async () => {
    const t = await team(database);
    const dana = await t.member();
    const id = await contactOf(t);
    const viewer = dana.as(new Set());
    const seen = await read(viewer, id);
    expect(seen.canManage).toBe(false);
    for (const refused of await failures([
      assign(viewer, id, 'me', seen.ownerRevision),
      follow(viewer, id, ['me']),
      unfollow(viewer, id, ['me']),
    ])) {
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect((refused as ForbiddenError).permission).toBe('contacts.manage');
    }
    // Each refusal is in the audit log, and nothing else is.
    const audit = await database.as('crm_owner', (sql) =>
      sql.query<{ command: string; outcome: string }>(
        'select command, outcome from audit.commands where business_id = $1 order by command',
        [t.businessId],
      ),
    );
    expect(audit).toEqual([
      { command: 'contact.add_followers', outcome: 'denied' },
      { command: 'contact.assign_owner', outcome: 'denied' },
      { command: 'contact.remove_followers', outcome: 'denied' },
    ]);
  });

  it('holds a contact in the trash as it is, and still shows it', async () => {
    const t = await team(database);
    const dana = await t.member();
    const id = await contactOf(t);
    await follow(dana.as(), id, ['me']);
    await database.as('crm_owner', (sql) =>
      sql.query('update crm.contacts set deleted_at = now() where business_id = $1', [
        t.businessId,
      ]),
    );
    const trashed = await read(dana.as(), id);
    expect(trashed).toMatchObject({ canManage: false });
    expect(trashed.followers).toHaveLength(1);
    for (const refused of await failures([
      assign(dana.as(), id, 'me', trashed.ownerRevision),
      follow(dana.as(), id, ['me']),
      unfollow(dana.as(), id, ['me']),
    ]))
      expect(refused).toBeInstanceOf(ConflictError);
    expect((await read(dana.as(), id)).followers).toHaveLength(1);
  });
});
