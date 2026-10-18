import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { CLIENT_IP_HEADER, createAuthentication, type Authentication } from './index.js';

// The first admin. A file of its own, so its database has nobody running the agency yet, as
// a new install hasn't.
const PUBLIC_URL = 'https://crm.example.test';
const PASSWORD = 'correct horse battery staple';

let database: TestDatabase;
let auth: Authentication;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  auth = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-that-is-at-least-32-characters-long',
    publicUrl: PUBLIC_URL,
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
const headers = (cookie?: string): Record<string, string> => ({
  'content-type': 'application/json',
  origin: PUBLIC_URL,
  [CLIENT_IP_HEADER]: `203.0.113.${String(++clients)}`,
  ...(cookie === undefined ? {} : { cookie }),
});

const check = async (token: string): Promise<unknown> =>
  (
    await auth.handle(
      new Request(`${PUBLIC_URL}/api/auth/setup?${new URLSearchParams({ token }).toString()}`, {
        headers: headers(),
      }),
    )
  ).json();

const setUp = (body: Record<string, unknown>): Promise<Response> =>
  auth.handle(
    new Request(`${PUBLIC_URL}/api/auth/setup`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    }),
  );

const admin = (token: string, email = 'clare@bluebird.example') =>
  setUp({ token, name: 'Clare Walsh', email, password: PASSWORD });

async function newLink(): Promise<string> {
  const start = await auth.firstAdminLink();
  if (start.kind !== 'link') throw new Error(`Expected a setup link, not ${start.kind}.`);
  const url = new URL(start.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${PUBLIC_URL}/setup`);
  return url.searchParams.get('token') ?? '';
}

const sessionCookie = (response: Response): string =>
  (
    response.headers
      .getSetCookie()
      .find((each) => each.startsWith('__Secure-crm.session_token=')) ?? ''
  ).split(';')[0] ?? '';

describe('the first admin', () => {
  it('waits for the install step to make the agency before giving a link', async () => {
    expect(await auth.firstAdminLink()).toEqual({ kind: 'no_agency' });
  });

  it('gives links that run out after 24 hours', async () => {
    const agency = await database.fixtures.agency({ name: 'Bluebird Digital' });
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
         values ($1, 'agency', 'owner', 'Owner', true)`,
        [agency.id],
      ),
    );
    const token = await newLink();
    const [stored] = await database.as('crm_owner', (sql) =>
      sql.query<{ hours: number; token_hash: string }>(
        `select extract(epoch from expires_at - created_at)::float8 / 3600 as hours, token_hash
         from auth.setup_links`,
      ),
    );
    expect(stored?.hours).toBe(24);
    // Only the token's hash is kept.
    expect(stored?.token_hash).not.toContain(token);

    await database.as('crm_owner', (sql) =>
      sql.query(`update auth.setup_links set expires_at = now() - interval '1 second'`),
    );

    expect(await check(token)).toEqual({ valid: false });
    const refused = await admin(token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it("keeps a link when the details don't fit, so they can try again", async () => {
    const token = await newLink();

    const short = await setUp({
      token,
      name: 'Clare',
      email: 'clare@bluebird.example',
      password: 'short',
    });
    const unnamed = await setUp({
      token,
      name: ' ',
      email: 'clare@bluebird.example',
      password: PASSWORD,
    });

    await database.fixtures.user({ email: 'taken@bluebird.example' });
    const taken = await admin(token, 'taken@bluebird.example');

    const long = await setUp({
      token,
      name: 'Clare',
      email: 'clare@bluebird.example',
      password: 'x'.repeat(129),
    });

    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
    expect(await long.json()).toMatchObject({ code: 'PASSWORD_TOO_LONG' });
    expect(unnamed.status).toBe(400);
    expect(taken.status).toBe(400);
    expect(await taken.json()).toMatchObject({ code: 'EMAIL_TAKEN' });
    expect(await check(token)).toEqual({ valid: true });
  });

  it('creates the first admin from any link, signs them in, and then no link works', async () => {
    const first = await newLink();
    const second = await newLink();
    expect(await check('not-a-token')).toEqual({ valid: false });
    expect(await check(second)).toEqual({ valid: true });

    const created = await admin(second, ' Clare@Bluebird.example ');

    expect(created.status).toBe(200);
    const signedIn = await auth.signedIn(new Headers({ cookie: sessionCookie(created) }));
    expect(signedIn).toMatchObject({ agencyStaff: true, memberOf: [] });
    const [person] = await database.as('crm_owner', (sql) =>
      sql.query<{ email: string; email_verified: boolean; role: string; scope: string }>(
        `select u.email, u.email_verified, r.key as role, r.scope
         from auth.users u
         join tenancy.memberships m on m.user_id = u.id and m.business_id is null
         join tenancy.roles r on r.id = m.role_id`,
      ),
    );
    expect(person).toEqual({
      email: 'clare@bluebird.example',
      email_verified: true,
      role: 'owner',
      scope: 'agency',
    });
    // They signed in with the password they chose.
    const password = await auth.handle(
      new Request(`${PUBLIC_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email: 'clare@bluebird.example', password: PASSWORD }),
      }),
    );
    expect(password.status).toBe(200);

    for (const token of [first, second]) {
      expect(await check(token)).toEqual({ valid: false });
      const again = await admin(token, 'someone@else.example');
      expect(again.status).toBe(403);
      expect(z.object({ code: z.string() }).parse(await again.json()).code).toBe('SETUP_DONE');
    }
    expect(await auth.firstAdminLink()).toEqual({ kind: 'admin_exists' });
    const left = await database.as('crm_owner', (sql) =>
      sql.query('select id from auth.setup_links'),
    );
    expect(left).toEqual([]);
  });
});
