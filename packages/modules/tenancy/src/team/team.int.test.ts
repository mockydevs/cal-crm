import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import { ConflictError, parsePublicId, toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { teamRoutes } from './routes.js';
import { team, teamInvitation } from '@repo/contracts';
import {
  inviteCommand as makeInviteCommand,
  resendInvitationCommand,
  revokeInvitationCommand,
  removeMemberCommand,
  readTeam,
  type TeamPeople,
} from './team.js';

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
// Who people are, as the server would pass the auth module's lookup: here, read directly.
const people: TeamPeople = async (trx, ids) =>
  ids.length === 0
    ? new Map()
    : new Map(
        (
          await trx
            .selectFrom('auth.users')
            .select(['id', 'name', 'email'])
            .where('id', 'in', [...ids])
            .execute()
        ).map((row) => [row.id, { name: row.name, email: row.email }]),
      );
const inviteCommand = makeInviteCommand(people);

async function setup() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const person = await database.fixtures.user();
  const roles = await database.as('crm_owner', (sql) =>
    sql.query<{ id: string; key: string }>(
      "insert into tenancy.roles (agency_id, scope, key, name, is_builtin) values ($1, 'business', 'admin', 'Admin', true), ($1, 'business', 'member', 'Member', true), ($1, 'business', 'owner', 'Owner', true) returning id, key",
      [agency.id],
    ),
  );
  const role = (key: string) => {
    const found = roles.find((each) => each.key === key);
    if (found === undefined) throw new Error('No role.');
    return toPublicId('role', found.id);
  };
  const invocation: Invocation = {
    context: {
      agencyId: agency.id,
      businessId: business.id,
      userId: person.id,
      actorId: person.id,
      actorKind: 'user',
      correlationId: randomUUID(),
    },
    permissions: new Set(['team.manage']),
  };
  return { agency, business, person, invocation, role };
}
describe('team commands', () => {
  it('does not silently hide members or pending invitations beyond the first 200', async () => {
    const { agency, business, role, invocation } = await setup();
    await database.as('crm_owner', async (sql) => {
      await sql.query(
        `with people as (insert into auth.users (email, name) select 'team-' || n || '@example.test', 'Team ' || n from generate_series(1, 201) n returning id) insert into tenancy.memberships (user_id, agency_id, business_id, role_id) select id, $1, $2, $3 from people`,
        [agency.id, business.id, parsePublicId('role', role('member'))],
      );
      await sql.query(
        `insert into tenancy.invitations (agency_id, business_id, role_id, email, token_hash, expires_at) select $1, $2, $3, 'pending-' || n || '@example.test', decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'), now() + interval '7 days' from generate_series(1, 201) n`,
        [agency.id, business.id, parsePublicId('role', role('member'))],
      );
    });
    const current = await readTeam(services, invocation, () => Promise.resolve(new Map()));
    expect(current.members).toHaveLength(201);
    expect(current.invitations).toHaveLength(201);
  });
  it('delivers after commit, reports delivery failure, and runs the team routes without exposing tokens', async () => {
    const { invocation, role } = await setup();
    let emailSent = '';
    const routes = teamRoutes({
      people: () => Promise.resolve(new Map()),
      sendInvitation: async (email) => {
        const rows = await database.as('crm_owner', (sql) =>
          sql.query('select id from tenancy.invitations where email = $1', [email]),
        );
        expect(rows).toHaveLength(1);
        emailSent = email;
        return false;
      },
    });
    const run = (operationId: string, body?: unknown, params: unknown = {}) => {
      const route = routes.find((each) => each.endpoint.operationId === operationId);
      if (route === undefined) throw new Error('Missing team route.');
      return route.run({ invocation, body, params, query: {} }, services);
    };
    const created = teamInvitation.parse(
      await run('inviteMember', { email: 'delivered@example.test', roleId: role('member') }),
    );
    expect(created.deliveryFailed).toBe(true);
    expect(emailSent).toBe(created.email);
    expect(created).not.toHaveProperty('token');
    expect(team.parse(await run('listTeam')).invitations).toHaveLength(1);
    expect(
      teamInvitation.parse(await run('resendInvitation', undefined, { id: created.id }))
        .deliveryFailed,
    ).toBe(true);
    await run('revokeInvitation', undefined, { id: created.id });
    expect(team.parse(await run('listTeam')).invitations[0]?.status).toBe('revoked');
    const unconfigured = teamRoutes({
      people: () => Promise.resolve(new Map()),
      sendInvitation: undefined,
    });
    for (const route of unconfigured.filter((each) =>
      ['inviteMember', 'resendInvitation'].includes(each.endpoint.operationId),
    )) {
      await expect(
        route.run({ invocation, body: {}, params: {}, query: {} }, services),
      ).rejects.toThrow('Email delivery must be configured');
    }
    const remove = routes.find((each) => each.endpoint.operationId === 'removeTeamMember');
    if (remove === undefined) throw new Error('Missing remove route.');
    await expect(
      remove.run(
        {
          invocation,
          body: undefined,
          params: { id: toPublicId('membership', invocation.context.userId ?? '') },
          query: {},
        },
        services,
      ),
    ).rejects.toThrow('Membership');
  });
  it('stores only the token hash, audits no token, and rotates links on resend', async () => {
    const { invocation, role } = await setup();
    const first = await runCommand(
      services,
      inviteCommand,
      { email: ' RILEY@example.test ', roleId: role('member') },
      invocation,
    );
    const again = await runCommand(
      services,
      resendInvitationCommand,
      { id: first.invitation.id },
      invocation,
    );
    expect(first.token).not.toBe(again.token);
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ input: unknown }>('select input from audit.commands where correlation_id = $1', [
        invocation.context.correlationId,
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain(first.token);
    expect(JSON.stringify(rows)).not.toContain(again.token);
    await runCommand(services, revokeInvitationCommand, { id: first.invitation.id }, invocation);
    await expect(
      runCommand(services, resendInvitationCommand, { id: first.invitation.id }, invocation),
    ).rejects.toThrow();
  });
  it('refuses missing grants, foreign roles, ownership assignment and duplicate pending invitations', async () => {
    const ours = await setup();
    const theirs = await setup();
    const input = { email: 'riley@example.test', roleId: ours.role('member') };
    await expect(
      runCommand(services, inviteCommand, input, { ...ours.invocation, permissions: new Set() }),
    ).rejects.toThrow();
    await expect(
      runCommand(
        services,
        inviteCommand,
        { ...input, roleId: theirs.role('member') },
        ours.invocation,
      ),
    ).rejects.toThrow();
    await expect(
      runCommand(
        services,
        inviteCommand,
        { ...input, roleId: ours.role('owner') },
        ours.invocation,
      ),
    ).rejects.toThrow();
    await runCommand(services, inviteCommand, input, ours.invocation);
    await expect(runCommand(services, inviteCommand, input, ours.invocation)).rejects.toThrow();
  });
  it('refuses to invite someone already on the team, rather than drop the role later (1A review A5)', async () => {
    const { invocation, business, agency, role } = await setup();
    const member = await database.fixtures.user({ email: 'riley@example.test' });
    await database.as('crm_owner', (sql) =>
      sql.query(
        'insert into tenancy.memberships (user_id, agency_id, business_id, role_id) values ($1, $2, $3, $4)',
        [member.id, agency.id, business.id, parsePublicId('role', role('member'))],
      ),
    );

    const attempt = runCommand(
      services,
      inviteCommand,
      { email: 'riley@example.test', roleId: role('admin') },
      invocation,
    );

    await expect(attempt).rejects.toThrow(ConflictError);
    await expect(attempt).rejects.toThrow(
      'riley@example.test is already on the team. Remove them first to invite them with another role.',
    );
  });
  it('keeps agency-wide invitations out of a business team and refuses foreign invitation ids', async () => {
    const ours = await setup();
    const theirs = await setup();
    const agencyRole = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into tenancy.roles (agency_id, scope, key, name, is_builtin) values ($1, 'agency', 'member', 'Member', true) returning id`,
        [ours.agency.id],
      ),
    );
    const agencyInvocation: Invocation = {
      context: { agencyId: ours.agency.id, actorKind: 'system', correlationId: randomUUID() },
      permissions: 'all',
    };
    const agencyInvitation = await runCommand(
      services,
      inviteCommand,
      { email: 'staff@example.test', roleId: toPublicId('role', agencyRole.id) },
      agencyInvocation,
    );
    const first = await runCommand(
      services,
      inviteCommand,
      { email: 'riley@example.test', roleId: ours.role('member') },
      ours.invocation,
    );
    await expect(
      runCommand(services, revokeInvitationCommand, { id: first.invitation.id }, theirs.invocation),
    ).rejects.toThrow();
    const list = await readTeam(services, ours.invocation, () => Promise.resolve(new Map()));
    expect(list.invitations.map((each) => each.id)).toEqual([first.invitation.id]);
    const agencyTeam = await readTeam(services, agencyInvocation, () => Promise.resolve(new Map()));
    expect(agencyTeam.invitations.map((each) => each.id)).toEqual([agencyInvitation.invitation.id]);
    expect(agencyTeam.canManage).toBe(true);
    await expect(
      runCommand(
        services,
        resendInvitationCommand,
        { id: agencyInvitation.invitation.id },
        ours.invocation,
      ),
    ).rejects.toThrow('Invitation');
    await runCommand(
      services,
      resendInvitationCommand,
      { id: agencyInvitation.invitation.id },
      agencyInvocation,
    );
    await database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.invitations set accepted_at = now() where id = $1`, [
        parsePublicId('invitation', agencyInvitation.invitation.id),
      ]),
    );
    await expect(
      runCommand(
        services,
        revokeInvitationCommand,
        { id: agencyInvitation.invitation.id },
        agencyInvocation,
      ),
    ).rejects.toThrow('accepted');
    await expect(
      runCommand(
        services,
        resendInvitationCommand,
        { id: agencyInvitation.invitation.id },
        agencyInvocation,
      ),
    ).rejects.toThrow('pending');
    expect(
      (await readTeam(services, agencyInvocation, () => Promise.resolve(new Map()))).invitations[0]
        ?.status,
    ).toBe('accepted');
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update tenancy.invitations set expires_at = now() - interval '1 second' where id = $1`,
        [parsePublicId('invitation', first.invitation.id)],
      ),
    );
    expect(
      (await readTeam(services, ours.invocation, () => Promise.resolve(new Map()))).invitations[0]
        ?.status,
    ).toBe('expired');
    expect(parsePublicId('invitation', first.invitation.id)).toBeDefined();
  });
  it('removes an ordinary member but protects owners and self-removal', async () => {
    const { invocation, person, role, agency, business } = await setup();
    const member = await database.fixtures.user();
    const insert = (userId: string, key: string) =>
      database.as(
        'crm_owner',
        async (sql) =>
          (
            await sql.one<{ id: string }>(
              'insert into tenancy.memberships (user_id, agency_id, business_id, role_id) values ($1, $2, $3, $4) returning id',
              [userId, agency.id, business.id, parsePublicId('role', role(key))],
            )
          ).id,
      );
    const self = await insert(person.id, 'admin');
    const owner = await insert((await database.fixtures.user()).id, 'owner');
    const removable = await insert(member.id, 'member');
    const list = await readTeam(services, { ...invocation, permissions: new Set() }, () =>
      Promise.resolve(new Map([[person.id, { name: 'Admin', email: person.email }]])),
    );
    expect(list.canManage).toBe(false);
    expect(list.members.find((each) => each.isSelf)?.name).toBe('Admin');
    expect(list.members.find((each) => each.id === toPublicId('membership', owner))?.isOwner).toBe(
      true,
    );
    expect(list.members.find((each) => each.id === toPublicId('membership', removable))?.name).toBe(
      'Unknown person',
    );
    await expect(
      runCommand(services, removeMemberCommand, { id: toPublicId('membership', self) }, invocation),
    ).rejects.toThrow();
    await expect(
      runCommand(
        services,
        removeMemberCommand,
        { id: toPublicId('membership', owner) },
        invocation,
      ),
    ).rejects.toThrow();
    await runCommand(
      services,
      removeMemberCommand,
      { id: toPublicId('membership', removable) },
      invocation,
    );
    const rows = await database.as('crm_owner', (sql) =>
      sql.query('select id from tenancy.memberships where id = $1', [removable]),
    );
    expect(rows).toEqual([]);
  });
});
