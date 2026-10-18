// Who a deal is with and whose it is, against a migrated Postgres as crm_app under
// row-level security, through the routes the server registers.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  contactDeals,
  deal,
  dealDetails,
  dealList,
  MAX_CONTACT_FOLLOWERS,
  MAX_DEAL_ADDITIONAL_CONTACTS,
  setDealContactsInput,
  type Deal,
  type DealDetails,
} from '@repo/contracts';
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

import { detailOptions, waitingForLock, type Gate } from '../../test/contact-details.js';
import { dealScene, type DealScene } from '../../test/deal-people.js';
import { contactDetailRoutes } from '../contacts/detail-routes.js';
import { contactRoutes } from '../contacts/routes.js';
import { recordTagRoutes } from '../tags/assignment-routes.js';
import { createTagRoute } from '../tags/routes.js';
import { trashRoutes } from '../trash/routes.js';
import { readContactDealList } from './contact-deals.js';
import { dealPeopleRoutes } from './people-routes.js';
import { createDealRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const gate: Gate = { whenResolving: () => Promise.resolve() };
const options = detailOptions(gate);
const routes = [
  ...dealPeopleRoutes(options),
  ...createDealRoutes(options),
  ...contactDetailRoutes(options),
  ...contactRoutes,
  ...recordTagRoutes,
  ...trashRoutes,
  createTagRoute,
];

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
  request: { id?: string; params?: Record<string, string>; body?: unknown; query?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run(
    {
      invocation,
      params: request.params ?? (request.id === undefined ? {} : { id: request.id }),
      body: request.body,
      query: request.query ?? {},
    },
    services,
  );
}

const create = async (s: DealScene, invocation: Invocation, more: object = {}): Promise<Deal> =>
  deal.parse(
    await call('createDeal', invocation, {
      body: {
        name: 'Garden fence',
        pipelineId: s.pipelineId,
        stageId: s.stageId,
        currency: 'KES',
        ...more,
      },
    }),
  );
const details = async (operationId: string, invocation: Invocation, id: string, body?: unknown) =>
  dealDetails.parse(await call(operationId, invocation, { id, body }));
const read = (invocation: Invocation, id: string) => details('getDealDetails', invocation, id);
const assign = (invocation: Invocation, id: string, owner: string | null, revision: string) =>
  details('assignDealOwner', invocation, id, { owner, revision });
const follow = (invocation: Invocation, id: string, followers: readonly string[]) =>
  details('addDealFollowers', invocation, id, { followers });
const unfollow = (invocation: Invocation, id: string, followers: readonly string[]) =>
  details('removeDealFollowers', invocation, id, { followers });
const setContacts = (
  invocation: Invocation,
  current: DealDetails,
  primaryContactId: string | null,
  additionalContactIds: readonly string[] = [],
  revision = current.contactsRevision,
) =>
  details('setDealContacts', invocation, current.id, {
    primaryContactId,
    additionalContactIds,
    revision,
  });

const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
const issuesOf = (reason: unknown) => (reason as ValidationError).issues;

/** Holds the first command that resolves a member inside its transaction until released. */
function holdFirst(): { reached: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
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
  return { reached: atResolve, release };
}
const letThrough = () => {
  gate.whenResolving = () => Promise.resolve();
};

describe("a deal's details", () => {
  it('start with no contact, owner or follower, and say who made the deal', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const made = await create(s, dana.as());

    const seen = await read(dana.as(), made.id);
    expect(seen).toMatchObject({
      id: made.id,
      owner: null,
      followers: [],
      primaryContact: null,
      additionalContacts: [],
      createdBy: { kind: 'user', name: 'Dana Brooks', you: true },
      createdAt: made.createdAt,
      canManage: true,
      canReadAudit: true,
    });
    // Someone else reads who made it, and it is not them; without the permissions neither
    // a change nor the audit log is theirs.
    const other = await read(lee.as(new Set()), made.id);
    expect(other.createdBy).toEqual({ kind: 'user', name: 'Dana Brooks', you: false });
    expect(other).toMatchObject({ canManage: false, canReadAudit: false });
  });

  it("are not found for another business's deal, or for an id that is no deal's", async () => {
    const s = await dealScene(database);
    const elsewhere = await dealScene(database);
    const dana = await s.member();
    const theirs = await create(elsewhere, (await elsewhere.member()).as());
    const contactId = await s.contact();
    // A deal's id that names one of this business's contacts is no deal either.
    const noDeal = toPublicId('deal', parsePublicId('contact', contactId) ?? '');
    for (const id of [theirs.id, noDeal])
      expect(await failure(read(dana.as(), id))).toBeInstanceOf(NotFoundError);
    for (const refused of [
      await failure(assign(dana.as(), theirs.id, 'me', 'a'.repeat(64))),
      await failure(follow(dana.as(), theirs.id, ['me'])),
      await failure(unfollow(dana.as(), theirs.id, ['me'])),
      await failure(
        details('setDealContacts', dana.as(), theirs.id, {
          primaryContactId: contactId,
          additionalContactIds: [],
          revision: 'a'.repeat(64),
        }),
      ),
    ])
      expect(refused).toBeInstanceOf(NotFoundError);
    expect(await elsewhere.events('deal.contact')).toEqual([]);
    expect(await elsewhere.events('deal.owner')).toEqual([]);
  });
});

describe("a deal's contacts", () => {
  it('are one primary contact and the others, with how to reach each', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const maya = await s.contact('Maya', 'maya@example.test');
    const omar = await s.contact('Omar');
    const zed = await s.contact('Zed');
    const made = await create(s, dana.as());

    const after = await setContacts(dana.as(), await read(dana.as(), made.id), maya, [zed, omar]);
    expect(after.primaryContact).toEqual({
      id: maya,
      name: 'Maya',
      email: 'maya@example.test',
      phone: null,
      trashed: false,
    });
    // The others by name, whatever order they were named in.
    expect(after.additionalContacts.map((each) => each.id)).toEqual([omar, zed]);
    expect(await s.events('deal.contact')).toEqual([
      { type: 'deal.contact_linked', payload: { contactId: maya, primary: true } },
      { type: 'deal.contact_linked', payload: { contactId: zed, primary: false } },
      { type: 'deal.contact_linked', payload: { contactId: omar, primary: false } },
    ]);
    // Each link is on the deal's timeline and on the contact's.
    const timeline = await database.as('crm_owner', (sql) =>
      sql.query<{ record_id: string }>(
        `select record_id from crm.timeline_entries
         where business_id = $1 and event_type = 'deal.contact_linked'`,
        [s.businessId],
      ),
    );
    const records = timeline.map((row) => row.record_id);
    expect(records.filter((id) => id === parsePublicId('deal', made.id))).toHaveLength(3);
    for (const contact of [maya, omar, zed])
      expect(records).toContain(parsePublicId('contact', contact));
  });

  it('change nothing and report nothing when saved again as they are', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const maya = await s.contact('Maya');
    const omar = await s.contact('Omar');
    const made = await create(s, dana.as());
    const first = await setContacts(dana.as(), await read(dana.as(), made.id), maya, [omar]);
    const again = await setContacts(dana.as(), first, maya, [omar]);
    expect(again).toEqual(first);
    expect(await s.events('deal.contact')).toHaveLength(2);
  });

  it('swap the primary with another, drop one and add one, each reported once', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const maya = await s.contact('Maya');
    const omar = await s.contact('Omar');
    const zed = await s.contact('Zed');
    const ines = await s.contact('Ines');
    const made = await create(s, dana.as());
    const first = await setContacts(dana.as(), await read(dana.as(), made.id), maya, [omar, zed]);

    const after = await setContacts(dana.as(), first, omar, [maya, ines]);
    expect(after.primaryContact?.id).toBe(omar);
    expect(after.additionalContacts.map((each) => each.id)).toEqual([ines, maya]);
    expect(after.contactsRevision).not.toBe(first.contactsRevision);
    expect((await s.events('deal.contact')).slice(3)).toEqual([
      { type: 'deal.contact_link_changed', payload: { contactId: maya, primary: false } },
      { type: 'deal.contact_unlinked', payload: { contactId: zed } },
      { type: 'deal.contact_link_changed', payload: { contactId: omar, primary: true } },
      { type: 'deal.contact_linked', payload: { contactId: ines, primary: false } },
    ]);
    // Nobody at all.
    const none = await setContacts(dana.as(), after, null);
    expect(none).toMatchObject({ primaryContact: null, additionalContacts: [] });
  });

  it('refuse a save made from contacts someone has since changed, and change nothing', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const maya = await s.contact('Maya');
    const omar = await s.contact('Omar');
    const made = await create(s, dana.as());
    const opened = await read(dana.as(), made.id);
    await setContacts(dana.as(), opened, maya);
    const stale = await failure(setContacts(dana.as(), opened, omar));
    expect(stale).toBeInstanceOf(ConflictError);
    expect((await read(dana.as(), made.id)).primaryContact?.id).toBe(maya);
    expect(await s.events('deal.contact')).toHaveLength(1);
  });

  it('take at most ten others, none of them the primary, each once', () => {
    const id = (n: number) =>
      toPublicId('contact', `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`);
    const input = (primaryContactId: string | null, additionalContactIds: string[]) =>
      setDealContactsInput.safeParse({
        primaryContactId,
        additionalContactIds,
        revision: 'a'.repeat(64),
      });
    const eleven = Array.from({ length: MAX_DEAL_ADDITIONAL_CONTACTS + 1 }, (_, n) => id(n + 2));
    expect(input(id(1), eleven.slice(0, MAX_DEAL_ADDITIONAL_CONTACTS)).success).toBe(true);
    expect(input(id(1), eleven).success).toBe(false);
    expect(input(id(1), [id(1)]).success).toBe(false);
    expect(input(null, [id(2), id(2)]).success).toBe(false);
  });

  it("refuse another business's contact, one in the trash and an id that is no contact's, and link none of the rest", async () => {
    const s = await dealScene(database);
    const elsewhere = await dealScene(database);
    const dana = await s.member();
    const maya = await s.contact('Maya');
    const theirs = await elsewhere.contact('Theirs');
    const binned = await s.contact('Binned');
    await call('trashContact', dana.as(), { id: binned });
    const made = await create(s, dana.as());
    const opened = await read(dana.as(), made.id);

    expect(issuesOf(await failure(setContacts(dana.as(), opened, maya, [theirs])))).toEqual([
      expect.objectContaining({ path: '/additionalContactIds/0', code: 'unknown_contact' }),
    ]);
    expect(issuesOf(await failure(setContacts(dana.as(), opened, binned)))).toEqual([
      expect.objectContaining({ path: '/primaryContactId', code: 'contact_in_trash' }),
    ]);
    expect(await read(dana.as(), made.id)).toMatchObject({
      primaryContact: null,
      additionalContacts: [],
      contactsRevision: opened.contactsRevision,
    });
    expect(await s.events('deal.contact')).toEqual([]);
  });

  it('keep a contact that goes to the trash afterwards, and say so', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const maya = await s.contact('Maya');
    const made = await create(s, dana.as(), { primaryContactId: maya });
    await call('trashContact', dana.as(), { id: maya });
    const seen = await read(dana.as(), made.id);
    expect(seen.primaryContact).toMatchObject({ id: maya, trashed: true });
    // It can stay where it is through a save, and can be taken off.
    expect((await setContacts(dana.as(), seen, maya)).primaryContact?.id).toBe(maya);
    expect((await setContacts(dana.as(), seen, null)).primaryContact).toBeNull();
  });

  it('are refused for a deal in the trash', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const maya = await s.contact('Maya');
    const made = await create(s, dana.as());
    const opened = await read(dana.as(), made.id);
    await call('trashDeal', dana.as(), { id: made.id });
    expect(await failure(setContacts(dana.as(), opened, maya))).toBeInstanceOf(ConflictError);
    expect(await failure(assign(dana.as(), made.id, 'me', opened.ownerRevision))).toBeInstanceOf(
      ConflictError,
    );
    expect(await failure(follow(dana.as(), made.id, ['me']))).toBeInstanceOf(ConflictError);
    // It is still read, and says it can't be changed.
    expect((await read(dana.as(), made.id)).canManage).toBe(false);
  });
});

describe('a new deal', () => {
  it('is linked to its contacts in the transaction that makes it, and takes its primary contact’s owner', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const maya = await s.contact('Maya');
    const omar = await s.contact('Omar');
    const contactOwner = await call('getContactDetails', dana.as(), { id: maya });
    await call('assignContactOwner', dana.as(), {
      id: maya,
      body: {
        owner: lee.membershipId,
        revision: (contactOwner as { ownerRevision: string }).ownerRevision,
      },
    });

    const made = await create(s, dana.as(), {
      primaryContactId: maya,
      additionalContactIds: [omar],
    });
    const seen = await read(dana.as(), made.id);
    expect(seen.primaryContact?.id).toBe(maya);
    expect(seen.additionalContacts.map((each) => each.id)).toEqual([omar]);
    expect(seen.owner).toEqual({ membershipId: lee.membershipId, name: 'Lee Park', you: false });
    expect(await s.events('deal.owner')).toEqual([
      { type: 'deal.owner_assigned', payload: { assignedUserId: lee.userId } },
    ]);
    // Without a contact, or with one nobody owns, the deal has no owner.
    const plain = await create(s, dana.as(), { primaryContactId: omar });
    expect((await read(dana.as(), plain.id)).owner).toBeNull();
  });

  it("is not made when a contact it names is another business's", async () => {
    const s = await dealScene(database);
    const elsewhere = await dealScene(database);
    const dana = await s.member();
    const theirs = await elsewhere.contact('Theirs');
    const refused = await failure(create(s, dana.as(), { primaryContactId: theirs }));
    expect(issuesOf(refused)).toEqual([
      expect.objectContaining({ path: '/primaryContactId', code: 'unknown_contact' }),
    ]);
    const deals = await database.as('crm_owner', (sql) =>
      sql.query('select 1 from crm.deals where business_id = $1', [s.businessId]),
    );
    expect(deals).toEqual([]);
    expect(await s.events('deal.')).toEqual([]);
  });
});

describe("a deal's owner", () => {
  it('is one team member, "me" or nobody, each change reported once and dated on the deal', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const made = await create(s, dana.as());
    const before = await read(dana.as(), made.id);

    const first = await assign(dana.as(), made.id, 'me', before.ownerRevision);
    expect(first.owner).toEqual({
      membershipId: dana.membershipId,
      name: 'Dana Brooks',
      you: true,
    });
    // The same owner again changes nothing and reports nothing.
    const same = await assign(dana.as(), made.id, dana.membershipId, first.ownerRevision);
    expect(same.ownerRevision).toBe(first.ownerRevision);
    const second = await assign(dana.as(), made.id, lee.membershipId, same.ownerRevision);
    expect(second.owner).toMatchObject({ membershipId: lee.membershipId, you: false });
    expect((await assign(dana.as(), made.id, null, second.ownerRevision)).owner).toBeNull();
    expect(await s.events('deal.owner')).toEqual([
      { type: 'deal.owner_assigned', payload: { assignedUserId: dana.userId } },
      { type: 'deal.owner_assigned', payload: { assignedUserId: lee.userId } },
      { type: 'deal.owner_unassigned', payload: {} },
    ]);
    // A change of owner is a change of the deal: its revision moves with it.
    const now = deal.parse(await call('getDeal', dana.as(), { id: made.id }));
    expect(now.revision).not.toBe(made.revision);
    expect(Date.parse(now.updatedAt)).toBeGreaterThan(Date.parse(made.updatedAt));
  });

  it('must be someone on this team, and a stale change is refused', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const lee = await s.member();
    const outsider = await (await dealScene(database)).member();
    const made = await create(s, dana.as());
    const { ownerRevision } = await read(dana.as(), made.id);
    expect(
      issuesOf(await failure(assign(dana.as(), made.id, outsider.membershipId, ownerRevision))),
    ).toEqual([expect.objectContaining({ path: '/owner', code: 'unavailable_member' })]);
    await assign(dana.as(), made.id, 'me', ownerRevision);
    expect(
      await failure(assign(lee.as(), made.id, lee.membershipId, ownerRevision)),
    ).toBeInstanceOf(ConflictError);
    expect((await read(dana.as(), made.id)).owner?.membershipId).toBe(dana.membershipId);
    expect(await s.events('deal.owner')).toHaveLength(1);
  });

  it('goes to one of two people who change it from the same revision at once', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const lee = await s.member();
    const made = await create(s, dana.as());
    const { ownerRevision } = await read(dana.as(), made.id);
    const hold = holdFirst();
    try {
      const first = assign(dana.as(), made.id, dana.membershipId, ownerRevision);
      await hold.reached;
      const second = assign(lee.as(), made.id, lee.membershipId, ownerRevision);
      await waitingForLock(database);
      hold.release();
      const [won, lost] = await Promise.allSettled([first, second]);
      expect(won.status).toBe('fulfilled');
      expect(lost.status === 'rejected' && lost.reason).toBeInstanceOf(ConflictError);
    } finally {
      hold.release();
      letThrough();
    }
    expect((await read(dana.as(), made.id)).owner?.membershipId).toBe(dana.membershipId);
    expect(await s.events('deal.owner')).toHaveLength(1);
  });
});

describe("a deal's followers", () => {
  it('are added and removed by name, each once, in the order they were added', async () => {
    const s = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const lee = await s.member('Lee Park');
    const made = await create(s, dana.as());

    await follow(dana.as(), made.id, [lee.membershipId, lee.membershipId]);
    const followed = await follow(dana.as(), made.id, ['me', lee.membershipId]);
    expect(followed.followers.map((each) => each.name)).toEqual(['Lee Park', 'Dana Brooks']);
    // Again changes nothing and reports nothing.
    await follow(dana.as(), made.id, ['me']);
    const left = await unfollow(dana.as(), made.id, [lee.membershipId]);
    expect(left.followers.map((each) => each.name)).toEqual(['Dana Brooks']);
    await unfollow(dana.as(), made.id, [lee.membershipId]);
    expect(await s.events('deal.follower')).toEqual([
      { type: 'deal.follower_added', payload: { followerUserId: lee.userId } },
      { type: 'deal.follower_added', payload: { followerUserId: dana.userId } },
      { type: 'deal.follower_removed', payload: { followerUserId: lee.userId } },
    ]);
    // Following does not change the deal itself.
    const now = deal.parse(await call('getDeal', dana.as(), { id: made.id }));
    expect(now.revision).toBe(made.revision);
  });

  it('are at most ten people on the team; one who left is neither shown nor counted', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const members = [];
    for (let n = 0; n < MAX_CONTACT_FOLLOWERS + 1; n += 1) members.push(await s.member());
    const outsider = await (await dealScene(database)).member();
    const made = await create(s, dana.as());
    const ten = members.slice(0, MAX_CONTACT_FOLLOWERS).map((each) => each.membershipId);
    const last = members[MAX_CONTACT_FOLLOWERS];
    const first = members[0];
    if (last === undefined || first === undefined) throw new Error('Missing a member.');

    expect(
      issuesOf(
        await failure(follow(dana.as(), made.id, [first.membershipId, outsider.membershipId])),
      ),
    ).toEqual([expect.objectContaining({ path: '/followers/1', code: 'unavailable_member' })]);
    expect((await follow(dana.as(), made.id, ten)).followers).toHaveLength(MAX_CONTACT_FOLLOWERS);
    expect(issuesOf(await failure(follow(dana.as(), made.id, [last.membershipId])))).toEqual([
      expect.objectContaining({ path: '/followers', code: 'too_many_followers' }),
    ]);
    await s.remove(first);
    expect((await read(dana.as(), made.id)).followers).toHaveLength(MAX_CONTACT_FOLLOWERS - 1);
    const filled = await follow(dana.as(), made.id, [last.membershipId]);
    expect(filled.followers).toHaveLength(MAX_CONTACT_FOLLOWERS);
  });

  it('never pass ten when two people add the last ones at once', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const lee = await s.member();
    const members = [];
    for (let n = 0; n < MAX_CONTACT_FOLLOWERS + 1; n += 1) members.push(await s.member());
    const made = await create(s, dana.as());
    await follow(
      dana.as(),
      made.id,
      members.slice(0, MAX_CONTACT_FOLLOWERS - 2).map((each) => each.membershipId),
    );
    const last = members.slice(MAX_CONTACT_FOLLOWERS - 2).map((each) => each.membershipId);
    const hold = holdFirst();
    try {
      const first = follow(dana.as(), made.id, last.slice(0, 2));
      await hold.reached;
      const second = follow(lee.as(), made.id, last.slice(1, 3));
      await waitingForLock(database);
      hold.release();
      const [won, lost] = await Promise.allSettled([first, second]);
      expect(won.status).toBe('fulfilled');
      expect(lost.status === 'rejected' && lost.reason).toBeInstanceOf(ValidationError);
    } finally {
      hold.release();
      letThrough();
    }
    expect((await read(dana.as(), made.id)).followers).toHaveLength(MAX_CONTACT_FOLLOWERS);
  });
});

describe('changing who a deal is with or whose it is', () => {
  it('takes deals.manage: a viewer is refused, each refusal is audited, and nothing changes', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const maya = await s.contact('Maya');
    const made = await create(s, dana.as());
    const viewer = dana.as(new Set());
    const seen = await read(viewer, made.id);
    for (const refused of [
      await failure(assign(viewer, made.id, 'me', seen.ownerRevision)),
      await failure(follow(viewer, made.id, ['me'])),
      await failure(unfollow(viewer, made.id, ['me'])),
      await failure(setContacts(viewer, seen, maya)),
    ]) {
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect((refused as ForbiddenError).permission).toBe('deals.manage');
    }
    const audit = await database.as('crm_owner', (sql) =>
      sql.query<{ command: string; outcome: string }>(
        `select command, outcome from audit.commands
         where business_id = $1 and command <> 'deal.create' order by command`,
        [s.businessId],
      ),
    );
    expect(audit).toEqual([
      { command: 'deal.add_followers', outcome: 'denied' },
      { command: 'deal.assign_owner', outcome: 'denied' },
      { command: 'deal.remove_followers', outcome: 'denied' },
      { command: 'deal.set_contacts', outcome: 'denied' },
    ]);
    expect(await read(dana.as(), made.id)).toMatchObject({
      owner: null,
      followers: [],
      primaryContact: null,
    });
  });
});

describe('a page of deals', () => {
  const list = async (invocation: Invocation, s: DealScene, include?: string) =>
    dealList.parse(
      await call('getDeals', invocation, {
        query: { pipelineId: s.pipelineId, ...(include === undefined ? {} : { include }) },
      }),
    );

  it('adds each deal’s primary contact, owner and own tags when asked, and nothing otherwise', async () => {
    const s = await dealScene(database);
    const elsewhere = await dealScene(database);
    const dana = await s.member('Dana Brooks');
    const maya = await s.contact('Maya', 'maya@example.test');
    const omar = await s.contact('Omar');
    const withAll = await create(s, dana.as(), {
      name: 'With all',
      primaryContactId: maya,
      additionalContactIds: [omar],
    });
    const bare = await create(s, dana.as(), { name: 'Bare' });
    await assign(dana.as(), withAll.id, 'me', (await read(dana.as(), withAll.id)).ownerRevision);
    const tag = (await call('createTag', dana.as(), { body: { name: 'Priority' } })) as {
      id: string;
    };
    await call('assignRecordTag', dana.as(), {
      params: { id: withAll.id, tagId: tag.id },
      body: {},
    });
    // Another business's deal, contact and tag change nothing here.
    const other = await elsewhere.member();
    await create(elsewhere, other.as(), { primaryContactId: await elsewhere.contact('Theirs') });

    const plain = await list(dana.as(), s);
    expect(plain.items.map((each) => each.name)).toEqual(['Bare', 'With all']);
    for (const item of plain.items) {
      expect(item).not.toHaveProperty('primaryContact');
      expect(item).not.toHaveProperty('owner');
      expect(item).not.toHaveProperty('tags');
    }

    const full = await list(dana.as(), s, 'contact,owner,tags');
    expect(full.items[1]).toMatchObject({
      id: withAll.id,
      primaryContact: { id: maya, name: 'Maya', email: 'maya@example.test', trashed: false },
      owner: { membershipId: dana.membershipId, name: 'Dana Brooks', you: true },
      tags: [{ id: tag.id, name: 'Priority' }],
    });
    expect(full.items[0]).toMatchObject({
      id: bare.id,
      primaryContact: null,
      owner: null,
      tags: [],
    });
    // Only what was named.
    const some = await list(dana.as(), s, 'tags');
    expect(some.items[1]).toHaveProperty('tags');
    expect(some.items[1]).not.toHaveProperty('owner');
    expect(await failure(list(dana.as(), s, 'contact,notes'))).toBeInstanceOf(ValidationError);
  });
});

describe("a contact's deals", () => {
  const dealsOf = async (invocation: Invocation, id: string, query: object = {}) =>
    contactDeals.parse(await call('listContactDeals', invocation, { id, query }));

  it('are the deals it is with, newest first, with whether it is the primary; never the trash', async () => {
    const s = await dealScene(database);
    const dana = await s.member();
    const maya = await s.contact('Maya');
    const omar = await s.contact('Omar');
    const first = await create(s, dana.as(), { name: 'First', primaryContactId: maya });
    const second = await create(s, dana.as(), {
      name: 'Second',
      primaryContactId: omar,
      additionalContactIds: [maya],
    });
    const won = await create(s, dana.as(), {
      name: 'Won',
      primaryContactId: maya,
      status: 'won',
    });
    const binned = await create(s, dana.as(), { name: 'Binned', primaryContactId: maya });
    await call('trashDeal', dana.as(), { id: binned.id });
    await create(s, dana.as(), { name: 'Not hers' });

    const all = await dealsOf(dana.as(), maya);
    expect(all.items.map((each) => [each.deal.id, each.primary])).toEqual([
      [won.id, true],
      [second.id, false],
      [first.id, true],
    ]);
    expect(all).toMatchObject({ more: false, canManage: true });
    const open = await dealsOf(dana.as(), maya, { status: 'open' });
    expect(open.items.map((each) => each.deal.name)).toEqual(['Second', 'First']);
    expect((await dealsOf(dana.as(), maya, { pipelineId: s.pipelineId })).items).toHaveLength(3);
    expect((await dealsOf(dana.as(new Set()), maya)).canManage).toBe(false);
  });

  it("are not found for another business's contact, and name none of its deals", async () => {
    const s = await dealScene(database);
    const elsewhere = await dealScene(database);
    const dana = await s.member();
    const theirs = await elsewhere.contact('Theirs');
    await create(elsewhere, (await elsewhere.member()).as(), { primaryContactId: theirs });
    expect(await failure(dealsOf(dana.as(), theirs))).toBeInstanceOf(NotFoundError);
    // Only a contact has deals: asked directly with a deal's id, the reader finds nothing.
    const own = await create(s, dana.as());
    await expect(
      withTenant(db, dana.as().context, (trx) =>
        readContactDealList(trx, dana.as(), own.id, { status: 'all' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A pipeline of another business narrows to nothing.
    const mine = await s.contact('Mine');
    await create(s, dana.as(), { primaryContactId: mine });
    expect((await dealsOf(dana.as(), mine, { pipelineId: elsewhere.pipelineId })).items).toEqual(
      [],
    );
  });
});
