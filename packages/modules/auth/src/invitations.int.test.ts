import { createHash, randomBytes } from 'node:crypto';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createAuthentication, type Authentication } from './index.js';
import { connectDatabase, withTenant } from '@repo/db';
import { readTeamPeople } from './team-people.js';
import { invitationEmail, type Email } from './emails.js';

const URL = 'https://crm.example.test';
const PASSWORD = 'correct horse battery staple';
let database: TestDatabase;
let auth: Authentication;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  auth = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-of-at-least-32-characters',
    publicUrl: URL,
    onConnectionError: () => undefined,
    log: () => undefined,
    sendMail: () => Promise.resolve(),
  });
});
afterAll(async () => {
  await auth.close();
  await database.close();
});
let clients = 0;
const call = (path: string, body?: object, cookie?: string) =>
  auth.handle(
    new Request(`${URL}/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        origin: URL,
        'x-crm-client-ip': `203.0.113.${String(++clients)}`,
        ...(cookie === undefined ? {} : { cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
async function invitation() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const token = randomBytes(32).toString('base64url');
  const email = `invited-${token.slice(0, 10)}@example.test`;
  const id = await database.as('crm_owner', async (sql) => {
    const role = await sql.one<{ id: string }>(
      "insert into tenancy.roles (agency_id, scope, key, name, is_builtin) values ($1, 'business', 'member', 'Member', true) returning id",
      [agency.id],
    );
    return (
      await sql.one<{ id: string }>(
        "insert into tenancy.invitations (agency_id, business_id, role_id, email, token_hash, expires_at) values ($1, $2, $3, $4, $5, now() + interval '7 days') returning id",
        [agency.id, business.id, role.id, email, createHash('sha256').update(token).digest()],
      )
    ).id;
  });
  return { id, email, token, business };
}
const accept = (link: { email: string; token: string }, cookie?: string) =>
  call('/invitations/accept', { ...link, name: 'Riley', password: PASSWORD }, cookie);
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((each) => each.split(';')[0])
    .join('; ');
describe('invitation acceptance', () => {
  it('rolls back the identity, password and membership when consuming the invitation fails', async () => {
    const link = await invitation();
    await database.as('crm_owner', (sql) =>
      sql.query(
        `create function tenancy.reject_invitation_test() returns trigger language plpgsql as $$ begin raise exception 'test failure consuming invitation'; end $$; create trigger reject_invitation_test before update on tenancy.invitations for each row execute function tenancy.reject_invitation_test()`,
      ),
    );
    try {
      expect((await accept(link)).status).toBe(500);
      const rows = await database.as('crm_owner', (sql) =>
        sql.query('select id from auth.users where email = $1', [link.email]),
      );
      expect(rows).toHaveLength(0);
    } finally {
      await database.as('crm_owner', (sql) =>
        sql.query(
          'drop trigger reject_invitation_test on tenancy.invitations; drop function tenancy.reject_invitation_test()',
        ),
      );
    }
    expect((await accept(link)).status).toBe(200);
  });
  it('checks possession without exposing other invitations, and identifies an existing account', async () => {
    const link = await invitation();
    expect(await (await call(`/invitations/check?token=${link.token}`)).json()).toEqual({
      valid: true,
      email: link.email,
      existingAccount: false,
    });
    expect(
      await (
        await call(`/invitations/check?token=${randomBytes(32).toString('base64url')}`)
      ).json(),
    ).toEqual({ valid: false });
    await auth.createUser({
      email: link.email,
      name: 'Existing',
      password: PASSWORD,
      emailVerified: true,
    });
    expect(await (await call(`/invitations/check?token=${link.token}`)).json()).toEqual({
      valid: true,
      email: link.email,
      existingAccount: true,
    });
    expect((await call('/invitations/accept', { token: 'bad', email: link.email })).status).toBe(
      400,
    );
  });
  it('requires new account details and rejects another signed-in email without consuming the link', async () => {
    const link = await invitation();
    expect(
      (await call('/invitations/accept', { token: link.token, email: link.email })).status,
    ).toBe(400);
    await auth.createUser({
      email: 'other-account@example.test',
      name: 'Other',
      password: PASSWORD,
      emailVerified: true,
    });
    const other = await call('/sign-in/email', {
      email: 'other-account@example.test',
      password: PASSWORD,
    });
    expect((await accept(link, cookieOf(other))).status).toBe(403);
    expect((await accept(link)).status).toBe(200);
  });
  it('reads team identity only inside its tenant transaction, including empty names and no ids', async () => {
    const link = await invitation();
    // A name of only spaces is no name, as readUserNames treats it (1A review A11).
    const user = await database.fixtures.user({ name: '   ' });
    const outsider = await database.fixtures.user();
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into tenancy.memberships (user_id, agency_id, business_id, role_id) select $1, agency_id, business_id, role_id from tenancy.invitations where id = $2`,
        [user.id, link.id],
      ),
    );
    const db = connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    });
    try {
      await withTenant(db, { ...link.business.context, userId: user.id }, async (trx) => {
        expect(await readTeamPeople(trx, [])).toEqual(new Map());
        const people = await readTeamPeople(trx, [user.id, outsider.id]);
        expect(people.get(user.id)).toEqual({ name: user.email, email: user.email });
        expect(people.has(outsider.id)).toBe(false);
      });
    } finally {
      await db.destroy();
    }
  });
  it('sends escaped invitation mail and handles delivery failure without logging the token', async () => {
    await invitation();
    const sent: Email[] = [];
    const logs: unknown[] = [];
    let fail = false;
    const sender = createAuthentication({
      connectionString: database.url('crm_auth'),
      secret: 'a-test-secret-of-at-least-32-characters',
      publicUrl: URL,
      onConnectionError: () => undefined,
      log: (...details) => {
        logs.push(details);
      },
      sendMail: (email) => {
        if (fail) {
          // As a transport fails: a code saying what kind of failure, and a message that
          // may echo the email, link and all.
          return Promise.reject(
            Object.assign(new Error('private-token'), { code: 'EAUTH', responseCode: 535 }),
          );
        }
        sent.push(email);
        return Promise.resolve();
      },
    });
    try {
      expect(await sender.sendInvitation('invited@example.test', 'private-token')).toBe(true);
      expect(sent[0]?.text).toContain('/accept-invitation?token=private-token');
      fail = true;
      expect(await sender.sendInvitation('invited@example.test', 'private-token')).toBe(false);
      expect(JSON.stringify(logs)).not.toContain('private-token');
      // What kind of failure, so an operator can tell a login problem from a DNS one.
      expect(logs.at(-1)).toEqual([
        'error',
        'invitation email delivery failed; the pending invitation can be resent',
        { name: 'Error', code: 'EAUTH', responseCode: 535 },
      ]);
      expect(invitationEmail('riley@example.test', '<script>&', `${URL}/?a=1&b=2`).html).toContain(
        '&lt;script&gt;&amp;',
      );
    } finally {
      await sender.close();
    }
  });
  it('releases startup database work when closed immediately after construction', async () => {
    const isolated = await testDatabase(inject('databaseServer'));
    const service = createAuthentication({
      connectionString: isolated.url('crm_auth'),
      secret: 'a-test-secret-of-at-least-32-characters',
      publicUrl: URL,
      onConnectionError: () => undefined,
      log: () => undefined,
      sendMail: () => Promise.resolve(),
    });
    await service.close();
    await isolated.close();
  });
  it('creates the invited person and membership, signs them in, and consumes the link once', async () => {
    const link = await invitation();
    const response = await accept({ email: link.email.toUpperCase(), token: link.token });
    expect(response.status).toBe(200);
    const person = await auth.signedIn(new Headers({ cookie: cookieOf(response) }));
    expect(person?.memberOf).toEqual([link.business.id]);
    expect((await accept(link)).status).toBe(400);
  });
  it('never consumes a link for a different email address', async () => {
    const link = await invitation();
    expect((await accept({ ...link, email: 'someone-else@example.test' })).status).toBe(400);
    expect((await accept(link)).status).toBe(200);
  });
  it.each(['expired', 'revoked', 'rotated'] as const)('refuses a %s link', async (state) => {
    const link = await invitation();
    await database.as('crm_owner', (sql) =>
      sql.query(
        state === 'expired'
          ? "update tenancy.invitations set expires_at = now() - interval '1 second' where id = $1"
          : state === 'revoked'
            ? 'update tenancy.invitations set revoked_at = now() where id = $1'
            : "update tenancy.invitations set token_hash = decode(repeat('00', 32), 'hex') where id = $1",
        [link.id],
      ),
    );
    expect((await accept(link)).status).toBe(400);
  });
  it('serializes concurrent acceptance so only one succeeds', async () => {
    const link = await invitation();
    const answers = await Promise.all([accept(link), accept(link)]);
    expect(answers.map((each) => each.status).sort()).toEqual([200, 400]);
  });
  it('requires an existing account to sign in and never resets its password', async () => {
    const link = await invitation();
    await auth.createUser({
      email: link.email,
      name: 'Existing',
      password: PASSWORD,
      emailVerified: true,
    });
    expect((await accept(link)).status).toBe(401);
    const signedIn = await call('/sign-in/email', { email: link.email, password: PASSWORD });
    expect(signedIn.status).toBe(200);
    const accepted = await call(
      '/invitations/accept',
      {
        token: link.token,
        email: link.email,
        password: 'this invitation cannot replace the password',
      },
      cookieOf(signedIn),
    );
    expect(accepted.status).toBe(200);
    expect((await call('/sign-in/email', { email: link.email, password: PASSWORD })).status).toBe(
      200,
    );
    expect(
      (
        await call('/sign-in/email', {
          email: link.email,
          password: 'this invitation cannot replace the password',
        })
      ).status,
    ).toBe(401);
  });
  it('refuses an existing disabled account', async () => {
    const link = await invitation();
    const user = await auth.createUser({
      email: link.email,
      name: 'Disabled',
      password: PASSWORD,
      emailVerified: true,
    });
    await database.as('crm_owner', (sql) =>
      sql.query('update auth.users set disabled_at = now() where id = $1', [user.id]),
    );
    expect((await accept(link)).status).toBe(403);
  });
});
