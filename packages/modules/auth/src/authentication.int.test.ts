import { ValidationError } from '@repo/kernel';
import {
  softPasskey,
  testDatabase,
  totpCode,
  type Ceremony,
  type Passkey,
  type TestDatabase,
} from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import {
  CLIENT_IP_HEADER,
  createAuthentication,
  type Authentication,
  type Email,
  type SignedIn,
} from './index.js';

const PUBLIC_URL = 'https://crm.example.test';
const PASSWORD = 'correct horse battery staple';

let database: TestDatabase;
let auth: Authentication;
const logged: { level: string; message: string }[] = [];
const sent: Email[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  // The install's agency, first in, so the emails are from it.
  await database.fixtures.agency({ name: 'Bluebird Digital' });
  auth = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-that-is-at-least-32-characters-long',
    publicUrl: PUBLIC_URL,
    onConnectionError: () => undefined,
    log: (level, message) => logged.push({ level, message }),
    sendMail: (email) => {
      sent.push(email);
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await auth.close();
  await database.close();
});

let clients = 0;
/** A client IP of its own, so each test has its own rate-limit bucket. */
const newClient = () => `203.0.113.${String(++clients)}`;

function post(
  path: string,
  body: unknown,
  options: { ip: string; cookie?: string; origin?: string },
): Promise<Response> {
  return auth.handle(
    new Request(`${PUBLIC_URL}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: options.origin ?? PUBLIC_URL,
        [CLIENT_IP_HEADER]: options.ip,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
      body: JSON.stringify(body),
    }),
  );
}

const signIn = (email: string, password: string, ip: string, origin?: string) =>
  post('/sign-in/email', { email, password }, { ip, ...(origin === undefined ? {} : { origin }) });

/** The session cookie a response set, as a browser would send it back. */
function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((each) => each.startsWith('__Secure-crm.session_token='));
  if (cookie === undefined) throw new Error('No session cookie was set.');
  return cookie.split(';')[0] ?? '';
}

let people = 0;
async function person(
  options: { emailVerified?: boolean } = {},
): Promise<{ id: string; email: string }> {
  const email = `person-${String(++people)}@example.com`;
  const { id } = await auth.createUser({
    email,
    name: 'Dana Brooks',
    password: PASSWORD,
    emailVerified: options.emailVerified ?? true,
  });
  return { id, email };
}

/** The mail sent to an address, oldest first. */
const sentTo = (address: string): Email[] => sent.filter((each) => each.to === address);

/** The link in an email's text. */
function linkIn(email: Email | undefined): string {
  const link = /https:\/\/\S+/.exec(email?.text ?? '')?.[0];
  if (link === undefined) throw new Error('No link in the email.');
  return link;
}

const get = (url: string): Promise<Response> =>
  auth.handle(new Request(url, { headers: { [CLIENT_IP_HEADER]: newClient() } }));

/** Makes the links whose stored value matches run out (their tokens are stored hashed). */
const expire = (matches: (value: string) => boolean) =>
  database.as('crm_owner', async (sql) => {
    const rows = await sql.query<{ id: string; value: string }>(
      'select id, value from auth.verifications',
    );
    const ids = rows.filter((row) => matches(row.value)).map((row) => row.id);
    expect(ids.length).toBeGreaterThan(0);
    await sql.query(
      `update auth.verifications set expires_at = now() - interval '1 second' where id = any($1)`,
      [ids],
    );
  });

/** Gives the user a membership in a new business, with a business-scoped role. */
async function memberOf(
  userId: string,
  agencyId?: string,
): Promise<{ agencyId: string; businessId: string }> {
  const agency = agencyId === undefined ? await database.fixtures.agency() : { id: agencyId };
  const business = await database.fixtures.business(agency.id);
  await database.as('crm_owner', async (sql) => {
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name) values ($1, 'business', 'owner', 'Owner')
       on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
      [agency.id],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id) values ($1, $2, $3, $4)`,
      [userId, agency.id, business.id, role.id],
    );
  });
  return { agencyId: agency.id, businessId: business.id };
}

describe('signing in with an email and password', () => {
  it('sets a session cookie a script can’t read and other sites don’t send', async () => {
    const { email } = await person();

    const response = await signIn(email, PASSWORD, newClient());

    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .find((each) => each.startsWith('__Secure-crm.session_token='));
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\//i);
  });

  it('finds the person behind a session, with their agency and business', async () => {
    const { id, email } = await person();
    const membership = await memberOf(id);

    const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));

    expect(await auth.signedIn(new Headers({ cookie }))).toEqual({
      userId: id,
      sessionId: expect.any(String) as unknown,
      agencyId: membership.agencyId,
      memberOf: [membership.businessId],
      agencyStaff: false,
      roles: {
        agency: undefined,
        businesses: new Map([
          [
            membership.businessId,
            { scope: 'business', key: 'owner', isBuiltin: false, permissions: [] },
          ],
        ]),
      },
      twoFactorEnabled: false,
      twoFactorRequired: false,
    });
  });

  it('lists every business the person works in, and says they aren’t agency staff', async () => {
    // Without a business, only agency staff may act agency-wide.
    const { id, email } = await person();
    const first = await memberOf(id);
    const second = await memberOf(id, first.agencyId);

    const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));

    expect(await auth.signedIn(new Headers({ cookie }))).toMatchObject({
      userId: id,
      agencyId: first.agencyId,
      agencyStaff: false,
    });
    expect((await auth.signedIn(new Headers({ cookie })))?.memberOf.toSorted()).toEqual(
      [first.businessId, second.businessId].toSorted(),
    );
  });

  it('signs agency staff into their agency, with no business until they choose one', async () => {
    const { id, email } = await person();
    const agency = await database.fixtures.agency();
    await database.as('crm_owner', async (sql) => {
      const role = await sql.one<{ id: string }>(
        `insert into tenancy.roles (agency_id, scope, key, name)
         values ($1, 'agency', 'admin', 'Admin') returning id`,
        [agency.id],
      );
      await sql.query(
        'insert into tenancy.memberships (user_id, agency_id, role_id) values ($1, $2, $3)',
        [id, agency.id, role.id],
      );
    });

    const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));

    expect(await auth.signedIn(new Headers({ cookie }))).toMatchObject({
      userId: id,
      agencyId: agency.id,
      memberOf: [],
      agencyStaff: true,
    });
  });

  it('knows the person but no agency or business before they have a membership', async () => {
    const { id, email } = await person();

    const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));

    expect(await auth.signedIn(new Headers({ cookie }))).toMatchObject({
      userId: id,
      agencyId: undefined,
      memberOf: [],
      agencyStaff: false,
    });
  });

  it('answers a wrong password and an unknown email the same way', async () => {
    const { email } = await person();

    const wrongPassword = await signIn(email, 'not the password', newClient());
    const unknownEmail = await signIn('nobody@example.com', PASSWORD, newClient());

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
    expect(wrongPassword.headers.getSetCookie()).toEqual([]);
  });

  it('refuses the 11th attempt from one client within 15 minutes, and not other clients', async () => {
    const { email } = await person();
    const client = newClient();

    const statuses: number[] = [];
    for (let attempt = 1; attempt <= 11; attempt++) {
      statuses.push((await signIn(email, 'not the password', client)).status);
    }

    expect(statuses).toEqual([...Array<number>(10).fill(401), 429]);
    expect((await signIn(email, PASSWORD, newClient())).status).toBe(200);
  });

  it('refuses a request from another site', async () => {
    const { email } = await person();

    const response = await signIn(email, PASSWORD, newClient(), 'https://evil.example');

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    // Better Auth's own messages reach the server's log, not the console.
    expect(logged).toContainEqual({
      level: 'error',
      message: 'Invalid origin: https://evil.example',
    });
  });

  it('lets nobody sign themselves up', async () => {
    const response = await post(
      '/sign-up/email',
      { email: 'newcomer@example.com', password: PASSWORD, name: 'Newcomer' },
      { ip: newClient() },
    );

    expect(response.status).toBe(400);
    expect(
      await database.as('crm_owner', (sql) =>
        sql.query(`select id from auth.users where email = 'newcomer@example.com'`),
      ),
    ).toEqual([]);
  });
});

describe('renewing a session', () => {
  /** When the session behind a cookie expires, read straight from the database. */
  async function expiresAt(cookie: string): Promise<Date> {
    const token = decodeURIComponent(cookie.split('=')[1] ?? '').split('.')[0] ?? '';
    const { expires_at } = await database.as('crm_owner', (sql) =>
      sql.one<{ expires_at: Date }>('select expires_at from auth.sessions where token = $1', [
        token,
      ]),
    );
    return expires_at;
  }

  /** Makes the session look a few days old: past Better Auth's one-day update age. */
  const age = (cookie: string) =>
    database.as('crm_owner', (sql) =>
      sql.query(
        `update auth.sessions set expires_at = now() + interval '5 days' where token = $1`,
        [decodeURIComponent(cookie.split('=')[1] ?? '').split('.')[0] ?? ''],
      ),
    );

  it("leaves it to get-session, which sends the renewed cookie; the API's look-up never writes", async () => {
    const { email } = await person();
    const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));
    await age(cookie);
    const aged = await expiresAt(cookie);

    // An API request: the session is read, not renewed, since the API can't pass a cookie on.
    expect(await auth.signedIn(new Headers({ cookie }))).toBeDefined();
    expect(await expiresAt(cookie)).toEqual(aged);

    // The dashboard's own check renews it, and its response carries the renewed cookie.
    const response = await auth.handle(
      new Request(`${PUBLIC_URL}/api/auth/get-session`, { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    const renewed = response.headers
      .getSetCookie()
      .find((each) => each.startsWith('__Secure-crm.session_token='));
    expect(renewed).toMatch(/; Max-Age=604800/i);
    expect((await expiresAt(cookie)).getTime()).toBeGreaterThan(aged.getTime());
  });
});

describe('magic links', () => {
  it('signs someone in once, from the link emailed to them', async () => {
    const { id, email } = await person();

    const asked = await post(
      '/sign-in/magic-link',
      { email, callbackURL: '/' },
      { ip: newClient() },
    );
    await auth.idle();

    expect(asked.status).toBe(200);
    const [message] = sentTo(email);
    expect(message?.subject).toBe('Sign in to Bluebird Digital');
    expect(message?.text).toContain('It works once, within 15 minutes.');
    const link = linkIn(message);
    const first = await get(link);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe(`${PUBLIC_URL}/`);
    expect((await auth.signedIn(new Headers({ cookie: sessionCookie(first) })))?.userId).toBe(id);

    const again = await get(link);
    expect(again.headers.get('location')).toBe(`${PUBLIC_URL}/?error=INVALID_TOKEN`);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it('stops working after 15 minutes', async () => {
    const { email } = await person();
    await post('/sign-in/magic-link', { email, callbackURL: '/' }, { ip: newClient() });
    await auth.idle();

    await expire((value) => value.includes(`"email":"${email}"`));

    expect((await get(linkIn(sentTo(email)[0]))).headers.get('location')).toBe(
      `${PUBLIC_URL}/?error=INVALID_TOKEN`,
    );
  });

  it('answers an address nobody uses the same way, and mails it nothing', async () => {
    const { email } = await person();

    const known = await post(
      '/sign-in/magic-link',
      { email, callbackURL: '/' },
      { ip: newClient() },
    );
    const unknown = await post(
      '/sign-in/magic-link',
      { email: 'nobody@example.com', callbackURL: '/' },
      { ip: newClient() },
    );
    await auth.idle();

    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
    expect(sentTo('nobody@example.com')).toEqual([]);
  });

  it('proves the mailbox of an unverified address, and takes away access set up before', async () => {
    // Better Auth's revokeUnprovenAccountAccess: whatever was linked to an address before
    // its owner proved it, such as a password, is removed. Invitations prove the address.
    const { email } = await person({ emailVerified: false });
    const before = sessionCookie(await signIn(email, PASSWORD, newClient()));

    await post('/sign-in/magic-link', { email, callbackURL: '/' }, { ip: newClient() });
    await auth.idle();
    const signedIn = await get(linkIn(sentTo(email)[0]));

    expect(signedIn.status).toBe(302);
    expect(await auth.signedIn(new Headers({ cookie: before }))).toBeUndefined();
    expect((await signIn(email, PASSWORD, newClient())).status).toBe(401);
    expect(
      await database.as('crm_owner', (sql) =>
        sql.query('select email_verified from auth.users where email = $1', [email]),
      ),
    ).toEqual([{ email_verified: true }]);
  });
});

describe('when the mail server fails', () => {
  it('logs the failure, and answers as it would anyway', async () => {
    const failures: { level: string; message: string }[] = [];
    const failing = createAuthentication({
      connectionString: database.url('crm_auth'),
      secret: 'a-test-secret-that-is-at-least-32-characters-long',
      publicUrl: PUBLIC_URL,
      onConnectionError: () => undefined,
      log: (level, message) => failures.push({ level, message }),
      sendMail: () => Promise.reject(new Error('connection refused')),
    });
    try {
      const { email } = await person();

      const response = await failing.handle(
        new Request(`${PUBLIC_URL}/api/auth/sign-in/magic-link`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: PUBLIC_URL,
            [CLIENT_IP_HEADER]: newClient(),
          },
          body: JSON.stringify({ email, callbackURL: '/' }),
        }),
      );
      await failing.idle();

      expect(response.status).toBe(200);
      expect(failures).toContainEqual({
        level: 'error',
        message: 'sending a sign-in email failed',
      });
    } finally {
      await failing.close();
    }
  });
});

describe('someone whose account is disabled', () => {
  it('gets no magic link and no reset link', async () => {
    const { id, email } = await person();
    await database.as('crm_owner', (sql) =>
      sql.query('update auth.users set disabled_at = now() where id = $1', [id]),
    );

    await post('/sign-in/magic-link', { email, callbackURL: '/' }, { ip: newClient() });
    await post(
      '/request-password-reset',
      { email, redirectTo: `${PUBLIC_URL}/reset-password` },
      { ip: newClient() },
    );
    await auth.idle();

    expect(sentTo(email)).toEqual([]);
  });
});

describe('resetting a password', () => {
  const RESET_PAGE = `${PUBLIC_URL}/reset-password`;

  /** Asks for a reset link and returns the token the emailed link leads to. */
  async function resetToken(email: string): Promise<string> {
    await post('/request-password-reset', { email, redirectTo: RESET_PAGE }, { ip: newClient() });
    await auth.idle();
    const landing = await get(linkIn(sentTo(email).at(-1)));
    const location = new URL(landing.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(RESET_PAGE);
    return location.searchParams.get('token') ?? '';
  }

  const reset = (token: string, newPassword: string) =>
    post('/reset-password', { token, newPassword }, { ip: newClient() });

  it('sets a new password once, from the emailed link, and signs the person out elsewhere', async () => {
    const { email } = await person();
    const elsewhere = sessionCookie(await signIn(email, PASSWORD, newClient()));

    const token = await resetToken(email);
    const [message] = sentTo(email);
    expect(message?.subject).toBe('Reset your password for Bluebird Digital');
    expect((await reset(token, 'a brand new passphrase')).status).toBe(200);

    expect(await auth.signedIn(new Headers({ cookie: elsewhere }))).toBeUndefined();
    expect((await signIn(email, PASSWORD, newClient())).status).toBe(401);
    expect((await signIn(email, 'a brand new passphrase', newClient())).status).toBe(200);
    expect((await reset(token, 'yet another passphrase')).status).toBe(400);
  });

  it('stops working after an hour', async () => {
    const { id, email } = await person();
    const token = await resetToken(email);

    await expire((value) => value === id);

    expect((await reset(token, 'a brand new passphrase')).status).toBe(400);
  });

  it('answers an address nobody uses the same way, and mails it nothing', async () => {
    const { email } = await person();

    const known = await post(
      '/request-password-reset',
      { email, redirectTo: RESET_PAGE },
      { ip: newClient() },
    );
    const unknown = await post(
      '/request-password-reset',
      { email: 'nobody@example.com', redirectTo: RESET_PAGE },
      { ip: newClient() },
    );
    await auth.idle();

    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
    expect(sentTo('nobody@example.com')).toEqual([]);
  });

  it('proves the address, so a later sign-in link leaves the new password alone', async () => {
    const { email } = await person({ emailVerified: false });

    expect((await reset(await resetToken(email), 'a brand new passphrase')).status).toBe(200);
    await post('/sign-in/magic-link', { email, callbackURL: '/' }, { ip: newClient() });
    await auth.idle();
    expect((await get(linkIn(sentTo(email).at(-1)))).status).toBe(302);

    expect((await signIn(email, 'a brand new passphrase', newClient())).status).toBe(200);
  });

  it("ends the person's other links when the password changes", async () => {
    const { email } = await person();
    const olderReset = await resetToken(email);
    await post('/sign-in/magic-link', { email, callbackURL: '/' }, { ip: newClient() });
    await auth.idle();
    const magicLink = linkIn(sentTo(email).at(-1));

    expect((await reset(await resetToken(email), 'a brand new passphrase')).status).toBe(200);

    expect((await reset(olderReset, 'yet another passphrase')).status).toBe(400);
    expect((await get(magicLink)).headers.get('location')).toBe(
      `${PUBLIC_URL}/?error=INVALID_TOKEN`,
    );
  });
});

describe('signing out', () => {
  it('ends the session, so its cookie no longer signs anyone in', async () => {
    const { email } = await person();
    const ip = newClient();
    const cookie = sessionCookie(await signIn(email, PASSWORD, ip));

    const response = await post('/sign-out', {}, { ip, cookie });

    expect(response.status).toBe(200);
    expect(await auth.signedIn(new Headers({ cookie }))).toBeUndefined();
  });

  it('signs nobody in without a cookie, or with one that was never issued', async () => {
    expect(await auth.signedIn(new Headers())).toBeUndefined();
    expect(
      await auth.signedIn(new Headers({ cookie: '__Secure-crm.session_token=made.up' })),
    ).toBeUndefined();
  });

  it('answers a request without a session cookie without asking the database', async () => {
    const { email } = await person();
    const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));
    // Nothing listens on port 1, so anything that asks the database fails.
    const offline = createAuthentication({
      connectionString: 'postgres://crm_auth:unused@127.0.0.1:1/crm',
      secret: 'a-test-secret-that-is-at-least-32-characters-long',
      publicUrl: PUBLIC_URL,
      onConnectionError: () => undefined,
      log: () => undefined,
      sendMail: () => Promise.resolve(),
    });
    try {
      expect(await offline.signedIn(new Headers())).toBeUndefined();
      expect(await offline.signedIn(new Headers({ cookie: 'theme=dark' }))).toBeUndefined();
      await expect(offline.signedIn(new Headers({ cookie }))).rejects.toThrow();
    } finally {
      await offline.close();
    }
  });
});

describe('createUser', () => {
  it('stores the email in lower case, so signing in finds it however it was typed', async () => {
    const { id } = await auth.createUser({
      email: 'Mixed.Case@Example.com',
      name: 'Mixed Case',
      password: PASSWORD,
      emailVerified: true,
    });

    const response = await signIn('mixed.case@example.com', PASSWORD, newClient());

    expect(response.status).toBe(200);
    expect(
      await database.as('crm_owner', (sql) =>
        sql.query('select email from auth.users where id = $1', [id]),
      ),
    ).toEqual([{ email: 'mixed.case@example.com' }]);
  });

  it('keeps the password only as a hash', async () => {
    const { id } = await person();

    const [account] = await database.as('crm_owner', (sql) =>
      sql.query<{ provider_id: string; password: string }>(
        'select provider_id, password from auth.accounts where user_id = $1',
        [id],
      ),
    );

    expect(account?.provider_id).toBe('credential');
    expect(account?.password).not.toContain(PASSWORD);
  });

  it('refuses a password longer than 128 characters', async () => {
    await expect(
      auth.createUser({
        email: 'long@example.com',
        name: 'Long',
        password: 'x'.repeat(129),
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/password', code: 'too_long' }] });
  });

  it('refuses a password shorter than 8 characters, and creates nobody', async () => {
    const error: unknown = await auth
      .createUser({
        email: 'short@example.com',
        name: 'Short',
        password: 'short',
        emailVerified: true,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ issues: [{ path: '/password', code: 'too_short' }] });
    expect(
      await database.as('crm_owner', (sql) =>
        sql.query(`select id from auth.users where email = 'short@example.com'`),
      ),
    ).toEqual([]);
  });

  it('refuses an email address someone already uses, however it’s capitalized', async () => {
    const { email } = await person();

    const error: unknown = await auth
      .createUser({
        email: email.toUpperCase(),
        name: 'Duplicate',
        password: PASSWORD,
        emailVerified: true,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      issues: [
        { path: '/email', code: 'taken', message: 'Someone already uses this email address.' },
      ],
    });
  });

  it('creates both the user and their password, or neither', async () => {
    // Makes storing this one person's password fail, after their user row is written.
    await database.as('crm_owner', (sql) =>
      sql.query(`
        create function auth.refuse_password_for_test() returns trigger language plpgsql as $$
        begin
          if (select email from auth.users where id = new.user_id) = 'half.made@example.com' then
            raise exception 'the password could not be stored';
          end if;
          return new;
        end $$;
        create trigger refuse_password before insert on auth.accounts
          for each row execute function auth.refuse_password_for_test();`),
    );
    try {
      await expect(
        auth.createUser({
          email: 'half.made@example.com',
          name: 'Half Made',
          password: PASSWORD,
          emailVerified: true,
        }),
      ).rejects.toThrow();
    } finally {
      await database.as('crm_owner', (sql) =>
        sql.query(`
          drop trigger refuse_password on auth.accounts;
          drop function auth.refuse_password_for_test();`),
      );
    }

    expect(
      await database.as('crm_owner', (sql) =>
        sql.query(`select id from auth.users where email = 'half.made@example.com'`),
      ),
    ).toEqual([]);
  });
});

// Two-factor sign-in and passkeys ---------------------------------------------

/** A Cookie header's cookies, by name. */
const cookiesIn = (header: string): Map<string, string> =>
  new Map(
    header
      .split('; ')
      .filter((pair) => pair !== '')
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  );

/** The cookies a browser keeps after a response: each one's last value, less those deleted. */
function keptCookies(response: Response, before = ''): Map<string, string> {
  const kept = cookiesIn(before);
  for (const each of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = each.split(';');
    const name = pair.slice(0, pair.indexOf('='));
    const value = pair.slice(pair.indexOf('=') + 1);
    const deleted = value === '' || attributes.some((part) => /^\s*max-age=0\s*$/i.test(part));
    if (deleted) kept.delete(name);
    else kept.set(name, value);
  }
  return kept;
}

const cookieHeader = (cookies: ReadonlyMap<string, string>): string =>
  [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');

/** A GET to Better Auth's endpoints, with the browser's cookies. */
function getWith(path: string, cookie: string): Promise<Response> {
  return auth.handle(
    new Request(`${PUBLIC_URL}/api/auth${path}`, {
      headers: { cookie, [CLIENT_IP_HEADER]: newClient() },
    }),
  );
}

const setUp = z.object({ totpURI: z.string(), backupCodes: z.array(z.string()) });

/**
 * Turns on two-factor sign-in for someone, as the set-up page does: it asks for an
 * authenticator app's link, then checks the first code. Two-factor endpoints allow three
 * requests per client in 10 seconds, so each request comes from a client of its own.
 */
async function withAuthenticator(
  email: string,
): Promise<{ link: string; recoveryCodes: string[] }> {
  const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));
  const enabled = await post(
    '/two-factor/enable',
    { password: PASSWORD },
    { ip: newClient(), cookie },
  );
  expect(enabled.status).toBe(200);
  const { totpURI, backupCodes } = setUp.parse(await enabled.json());
  const verified = await post(
    '/two-factor/verify-totp',
    { code: totpCode(totpURI) },
    { ip: newClient(), cookie },
  );
  expect(verified.status).toBe(200);
  return { link: totpURI, recoveryCodes: backupCodes };
}

/** Signs in with the password and a code from the app, as the two pages do. */
async function signInWithCode(email: string, link: string): Promise<string> {
  const challenge = cookieHeader(keptCookies(await signIn(email, PASSWORD, newClient())));
  return sessionCookie(
    await post(
      '/two-factor/verify-totp',
      { code: totpCode(link) },
      {
        ip: newClient(),
        cookie: challenge,
      },
    ),
  );
}

/** A code that isn't the right one now. */
function wrongCode(link: string): string {
  const right = totpCode(link);
  return `${right.slice(0, 5)}${String((Number(right.slice(5)) + 1) % 10)}`;
}

async function twoFactorEnabled(userId: string): Promise<boolean> {
  const row = await database.as('crm_owner', (sql) =>
    sql.one<{ two_factor_enabled: boolean }>(
      'select two_factor_enabled from auth.users where id = $1',
      [userId],
    ),
  );
  return row.two_factor_enabled;
}

/** Makes the person agency staff: a member of the agency itself. */
async function staffOf(userId: string, agencyId: string): Promise<void> {
  await database.as('crm_owner', async (sql) => {
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name) values ($1, 'agency', 'admin', 'Admin')
       on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
      [agencyId],
    );
    await sql.query(
      'insert into tenancy.memberships (user_id, agency_id, role_id) values ($1, $2, $3)',
      [userId, agencyId, role.id],
    );
  });
}

const requireTwoFactor = (agencyId: string, required: boolean) =>
  database.as('crm_owner', (sql) =>
    sql.query('update tenancy.agencies set two_factor_required = $2 where id = $1', [
      agencyId,
      required,
    ]),
  );

describe('the test authenticator app', () => {
  it('shows the codes RFC 6238 gives for its test secret', () => {
    // RFC 6238 appendix B: the secret "12345678901234567890" with SHA-1 and eight digits.
    const link = 'otpauth://totp/Test:test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8';
    expect(totpCode(link, 59_000)).toBe('94287082');
    expect(totpCode(link, 1_111_111_109_000)).toBe('07081804');
    expect(() => totpCode('https://example.com/?secret=AB')).toThrow(/otpauth/);
    expect(() => totpCode('otpauth://totp/x?secret=A1')).toThrow(/base32/);
  });
});

describe('two-factor sign-in', () => {
  it('turns on once the first code from the app checks out, with ten recovery codes', async () => {
    const { id, email } = await person();
    const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));

    const enabled = await post(
      '/two-factor/enable',
      { password: PASSWORD, issuer: 'Somebody Else' },
      { ip: newClient(), cookie },
    );
    const { totpURI, backupCodes } = setUp.parse(await enabled.json());

    // The app names the agency, whatever the page asked for.
    expect(new URL(totpURI).searchParams.get('issuer')).toBe('Bluebird Digital');
    expect(backupCodes).toHaveLength(10);
    expect(await twoFactorEnabled(id)).toBe(false);
    const wrong = await post(
      '/two-factor/verify-totp',
      { code: wrongCode(totpURI) },
      { ip: newClient(), cookie },
    );
    expect(wrong.status).toBe(401);
    expect(await twoFactorEnabled(id)).toBe(false);
    const right = await post(
      '/two-factor/verify-totp',
      { code: totpCode(totpURI) },
      { ip: newClient(), cookie },
    );
    expect(right.status).toBe(200);
    expect(await twoFactorEnabled(id)).toBe(true);
  });

  it('asks for a code after the password, and signs in only once one checks out', async () => {
    const { id, email } = await person();
    const { link } = await withAuthenticator(email);

    const response = await signIn(email, PASSWORD, newClient());

    expect(await response.json()).toEqual({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    const cookies = keptCookies(response);
    expect([...cookies.keys()]).toEqual(['__Secure-crm.two_factor']);
    const challenge = cookieHeader(cookies);
    expect(await auth.signedIn(new Headers({ cookie: challenge }))).toBeUndefined();
    const wrong = await post(
      '/two-factor/verify-totp',
      { code: wrongCode(link) },
      { ip: newClient(), cookie: challenge },
    );
    expect(wrong.status).toBe(401);
    const right = await post(
      '/two-factor/verify-totp',
      { code: totpCode(link) },
      { ip: newClient(), cookie: challenge },
    );
    expect(right.status).toBe(200);
    expect(await auth.signedIn(new Headers({ cookie: sessionCookie(right) }))).toMatchObject({
      userId: id,
      twoFactorEnabled: true,
    });
  });

  it('takes a recovery code instead of a code from the app, each code once', async () => {
    const { email } = await person();
    const { recoveryCodes } = await withAuthenticator(email);
    const [code = ''] = recoveryCodes;
    const challenge = async () =>
      cookieHeader(keptCookies(await signIn(email, PASSWORD, newClient())));

    const first = await post(
      '/two-factor/verify-backup-code',
      { code },
      {
        ip: newClient(),
        cookie: await challenge(),
      },
    );
    const again = await post(
      '/two-factor/verify-backup-code',
      { code },
      {
        ip: newClient(),
        cookie: await challenge(),
      },
    );

    expect(first.status).toBe(200);
    expect(await auth.signedIn(new Headers({ cookie: sessionCookie(first) }))).toBeDefined();
    expect(again.status).toBe(401);
  });

  it('asks someone who follows a sign-in link for a code too, then goes where they were going', async () => {
    const { id, email } = await person();
    const { link } = await withAuthenticator(email);
    await post(
      '/sign-in/magic-link',
      { email, callbackURL: '/contacts?view=all' },
      {
        ip: newClient(),
      },
    );
    await auth.idle();

    const followed = await get(linkIn(sentTo(email).at(-1)));

    expect(followed.status).toBe(302);
    expect(followed.headers.get('location')).toBe(
      `${PUBLIC_URL}/sign-in/two-factor?next=%2Fcontacts%3Fview%3Dall`,
    );
    const cookies = keptCookies(followed);
    expect([...cookies.keys()]).toEqual(['__Secure-crm.two_factor']);
    const verified = await post(
      '/two-factor/verify-totp',
      { code: totpCode(link) },
      { ip: newClient(), cookie: cookieHeader(cookies) },
    );
    expect((await auth.signedIn(new Headers({ cookie: sessionCookie(verified) })))?.userId).toBe(
      id,
    );
  });

  it('asks for the code, then goes to the home page, when the link names no page', async () => {
    const { email } = await person();
    await withAuthenticator(email);
    await post('/sign-in/magic-link', { email }, { ip: newClient() });
    await auth.idle();

    const followed = await get(linkIn(sentTo(email).at(-1)));

    expect(followed.headers.get('location')).toBe(`${PUBLIC_URL}/sign-in/two-factor?next=%2F`);
  });

  it('signs in from a link at once for someone without two-factor sign-in', async () => {
    const { email } = await person();
    await post('/sign-in/magic-link', { email, callbackURL: '/contacts' }, { ip: newClient() });
    await auth.idle();

    const followed = await get(linkIn(sentTo(email).at(-1)));

    expect(followed.headers.get('location')).toBe(`${PUBLIC_URL}/contacts`);
    expect(keptCookies(followed).has('__Secure-crm.session_token')).toBe(true);
  });
});

describe('requiring two-factor sign-in', () => {
  it("tells agency staff of an agency that requires it until they've set it up, and nobody else", async () => {
    const agency = await database.fixtures.agency();
    await requireTwoFactor(agency.id, true);
    const staff = await person();
    await staffOf(staff.id, agency.id);
    const client = await person();
    await memberOf(client.id, agency.id);
    const staffCookie = sessionCookie(await signIn(staff.email, PASSWORD, newClient()));
    const clientCookie = sessionCookie(await signIn(client.email, PASSWORD, newClient()));

    expect(await auth.signedIn(new Headers({ cookie: staffCookie }))).toMatchObject({
      twoFactorEnabled: false,
      twoFactorRequired: true,
    });
    expect(await (await getWith('/security', staffCookie)).json()).toEqual({
      twoFactorRequired: true,
      hasPassword: true,
    });
    expect(await auth.signedIn(new Headers({ cookie: clientCookie }))).toMatchObject({
      twoFactorRequired: false,
    });

    await withAuthenticator(staff.email);
    expect(await auth.signedIn(new Headers({ cookie: staffCookie }))).toMatchObject({
      twoFactorEnabled: true,
      twoFactorRequired: true,
    });
  });

  it('answers what sign-in asks of someone only once they are signed in', async () => {
    const { id, email } = await person();
    const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));
    // As after a first sign-in link, which removes a password someone else set up.
    await database.as('crm_owner', (sql) =>
      sql.query('delete from auth.accounts where user_id = $1', [id]),
    );

    expect((await getWith('/security', '')).status).toBe(401);
    expect(await (await getWith('/security', cookie)).json()).toEqual({
      twoFactorRequired: false,
      hasPassword: false,
    });
  });

  it('keeps it on while the agency requires it', async () => {
    const agency = await database.fixtures.agency();
    await requireTwoFactor(agency.id, true);
    const { id, email } = await person();
    await staffOf(id, agency.id);
    const { link } = await withAuthenticator(email);

    const refused = await post(
      '/two-factor/disable',
      { password: PASSWORD },
      {
        ip: newClient(),
        cookie: await signInWithCode(email, link),
      },
    );

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    expect(await twoFactorEnabled(id)).toBe(true);
    await requireTwoFactor(agency.id, false);
    const allowed = await post(
      '/two-factor/disable',
      { password: PASSWORD },
      {
        ip: newClient(),
        cookie: await signInWithCode(email, link),
      },
    );
    expect(allowed.status).toBe(200);
    expect(await twoFactorEnabled(id)).toBe(false);
  });
});

describe('changing how someone without a password signs in', () => {
  /** Makes the person's sessions as old as given, in minutes. */
  const sessionsAged = (userId: string, minutes: number) =>
    database.as('crm_owner', (sql) =>
      sql.query(
        'update auth.sessions set created_at = now() - make_interval(mins => $2) where user_id = $1',
        [userId, minutes],
      ),
    );
  /** As after a first sign-in link, which removes a password someone else set up. */
  const withoutPassword = (userId: string) =>
    database.as('crm_owner', (sql) =>
      sql.query('delete from auth.accounts where user_id = $1', [userId]),
    );

  it('asks them to have signed in within the last 15 minutes', async () => {
    const { id, email } = await person();
    const { link } = await withAuthenticator(email);
    const cookie = await signInWithCode(email, link);
    await withoutPassword(id);
    const change = (path: string) => post(path, {}, { ip: newClient(), cookie });

    expect((await change('/two-factor/get-totp-uri')).status).toBe(200);
    expect((await change('/two-factor/generate-backup-codes')).status).toBe(200);

    await sessionsAged(id, 16);
    for (const path of [
      '/two-factor/get-totp-uri',
      '/two-factor/generate-backup-codes',
      '/two-factor/disable',
      '/two-factor/enable',
    ]) {
      const refused = await change(path);
      expect(refused.status, path).toBe(403);
      expect(await refused.json(), path).toMatchObject({ code: 'SIGN_IN_AGAIN' });
    }
    expect(await twoFactorEnabled(id)).toBe(true);

    await sessionsAged(id, 14);
    expect((await change('/two-factor/disable')).status).toBe(200);
    expect(await twoFactorEnabled(id)).toBe(false);
  });

  it('leaves someone with a password to confirm it, however long ago they signed in', async () => {
    const { id, email } = await person();
    const { link } = await withAuthenticator(email);
    const cookie = await signInWithCode(email, link);
    await sessionsAged(id, 60 * 12);

    const allowed = await post(
      '/two-factor/generate-backup-codes',
      { password: PASSWORD },
      { ip: newClient(), cookie },
    );

    expect(allowed.status).toBe(200);
  });
});

describe('passkeys', () => {
  const creationOptions = z.object({
    challenge: z.string(),
    rp: z.object({ id: z.string() }),
    authenticatorSelection: z.object({ userVerification: z.string(), residentKey: z.string() }),
  });
  const requestOptions = z.object({ challenge: z.string(), rpId: z.string() });

  /** Adds a passkey for someone signed in, as the settings page does. */
  async function addPasskey(cookie: string, key: Passkey, ceremony?: Ceremony): Promise<Response> {
    const asked = await getWith('/passkey/generate-register-options', cookie);
    const options = creationOptions.parse(await asked.json());
    expect(options.rp.id).toBe('crm.example.test');
    expect(options.authenticatorSelection).toEqual({
      userVerification: 'required',
      residentKey: 'required',
    });
    return post(
      '/passkey/verify-registration',
      { response: key.register(options, PUBLIC_URL, ceremony), name: 'Laptop' },
      { ip: newClient(), cookie: cookieHeader(keptCookies(asked, cookie)) },
    );
  }

  /** Signs in with a passkey from the sign-in page, where nobody is signed in yet. */
  async function signInWithPasskey(key: Passkey, ceremony?: Ceremony): Promise<Response> {
    const asked = await getWith('/passkey/generate-authenticate-options', '');
    const options = requestOptions.parse(await asked.json());
    return post(
      '/passkey/verify-authentication',
      { response: key.signIn(options, PUBLIC_URL, ceremony) },
      { ip: newClient(), cookie: cookieHeader(keptCookies(asked)) },
    );
  }

  it('signs in with a passkey that checked who it was, without asking for a code', async () => {
    const { id, email } = await person();
    const { link } = await withAuthenticator(email);
    const key = softPasskey();

    expect((await addPasskey(await signInWithCode(email, link), key)).status).toBe(200);
    const signedIn = await signInWithPasskey(key);

    expect(signedIn.status).toBe(200);
    expect((await auth.signedIn(new Headers({ cookie: sessionCookie(signedIn) })))?.userId).toBe(
      id,
    );
  });

  it('removes the app and passkeys someone set up before proving their address', async () => {
    // Whoever knew the password they were given could have added them. Their first
    // sign-in link proves the address, and removes the password and these with it.
    const { id, email } = await person({ emailVerified: false });
    const { link } = await withAuthenticator(email);
    const key = softPasskey();
    expect((await addPasskey(await signInWithCode(email, link), key)).status).toBe(200);
    await post('/sign-in/magic-link', { email, callbackURL: '/' }, { ip: newClient() });
    await auth.idle();

    const followed = await get(linkIn(sentTo(email).at(-1)));

    expect(followed.headers.get('location')).toBe(`${PUBLIC_URL}/`);
    expect(keptCookies(followed).has('__Secure-crm.session_token')).toBe(true);
    expect(await twoFactorEnabled(id)).toBe(false);
    expect((await signInWithPasskey(key)).status).toBe(401);
  });

  it("won't add or sign in with a passkey that didn't check who it was", async () => {
    const { email } = await person();
    const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));
    const key = softPasskey();

    const unverified = await addPasskey(cookie, key, { userVerified: false });
    expect(unverified.status).toBe(400);
    expect(await unverified.json()).toMatchObject({ code: 'USER_NOT_VERIFIED' });
    expect((await addPasskey(cookie, key)).status).toBe(200);
    const signedIn = await signInWithPasskey(key, { userVerified: false });

    expect(signedIn.status).toBe(401);
    expect(await signedIn.json()).toMatchObject({ code: 'USER_NOT_VERIFIED' });
    expect(keptCookies(signedIn).has('__Secure-crm.session_token')).toBe(false);
  });
});

/** The person behind a fresh sign-in, as the API's hook sees them. */
async function signedInAs(email: string): Promise<SignedIn> {
  const cookie = sessionCookie(await signIn(email, PASSWORD, newClient()));
  const found = await auth.signedIn(new Headers({ cookie }));
  if (found === undefined) throw new Error('Not signed in.');
  return found;
}

const setStatus = (businessId: string, status: 'active' | 'suspended' | 'archived') =>
  database.as('crm_owner', (sql) =>
    sql.query('update tenancy.businesses set status = $2 where id = $1', [businessId, status]),
  );

// A request names the business it works in, checked against the person's memberships.
describe('where someone may work', () => {
  const refused = (status: number, code: string, message: string) => ({
    at: 'refused',
    status,
    code,
    message,
  });

  it('puts agency staff at the agency when they name no business, and in any of its businesses when they do', async () => {
    const { id, email } = await person();
    const agency = await database.fixtures.agency();
    await staffOf(id, agency.id);
    const business = await database.fixtures.business(agency.id);
    await setStatus(business.id, 'archived');
    const staff = await signedInAs(email);

    expect(await auth.workplace(staff, undefined)).toMatchObject({ at: 'agency' });
    expect(await auth.workplace(staff, business.id)).toMatchObject({
      at: 'business',
      businessId: business.id,
    });
  });

  it("keeps agency staff out of another agency's businesses, as if they didn't exist", async () => {
    const { id, email } = await person();
    await staffOf(id, (await database.fixtures.agency()).id);
    const elsewhere = await database.fixtures.business((await database.fixtures.agency()).id);

    expect(await auth.workplace(await signedInAs(email), elsewhere.id)).toEqual(
      refused(404, 'not_found', "There's no such business."),
    );
  });

  it('puts a business user in their only business when they name none', async () => {
    const { id, email } = await person();
    const { businessId } = await memberOf(id);

    expect(await auth.workplace(await signedInAs(email), undefined)).toMatchObject({
      at: 'business',
      businessId,
    });
  });

  it('never puts a business user at the agency, which would show them every business', async () => {
    const { id, email } = await person();
    const first = await memberOf(id);
    await memberOf(id, first.agencyId);
    const user = await signedInAs(email);

    expect(await auth.workplace(user, undefined)).toEqual(
      refused(403, 'choose_business', 'Choose a business first.'),
    );
    expect(await auth.workplace(user, first.businessId)).toMatchObject({
      at: 'business',
      businessId: first.businessId,
    });
  });

  it('lets a business user into their own businesses only', async () => {
    const { id, email } = await person();
    const ours = await memberOf(id);
    const sameAgency = await database.fixtures.business(ours.agencyId);
    const otherAgency = await database.fixtures.business((await database.fixtures.agency()).id);
    const user = await signedInAs(email);

    expect(await auth.workplace(user, sameAgency.id)).toEqual(
      refused(403, 'not_a_member', "You don't work in this business."),
    );
    expect(await auth.workplace(user, otherAgency.id)).toEqual(
      refused(404, 'not_found', "There's no such business."),
    );
    expect(await auth.workplace(user, '0199a000-0000-7000-8000-00000000dead')).toEqual(
      refused(404, 'not_found', "There's no such business."),
    );
  });

  it('keeps business users out of a suspended or archived business, even their only one', async () => {
    const { id, email } = await person();
    const { businessId } = await memberOf(id);
    const user = await signedInAs(email);

    await setStatus(businessId, 'suspended');
    expect(await auth.workplace(user, undefined)).toEqual(
      refused(403, 'unavailable', 'This business is suspended.'),
    );
    await setStatus(businessId, 'archived');
    expect(await auth.workplace(user, businessId)).toEqual(
      refused(403, 'unavailable', 'This business is archived.'),
    );
  });

  it('refuses someone with no agency yet', async () => {
    const { email } = await person();

    expect(await auth.workplace(await signedInAs(email), undefined)).toEqual(
      refused(403, 'no_agency', "You aren't a member of an agency yet."),
    );
  });
});

describe('who someone is', () => {
  it("gives a business user's name, agency and the businesses they may enter", async () => {
    const { id, email } = await person();
    const first = await memberOf(id);
    const second = await memberOf(id, first.agencyId);
    const archived = await memberOf(id, first.agencyId);
    await setStatus(archived.businessId, 'archived');

    const profile = await auth.whoIs(await signedInAs(email));

    expect(profile).toMatchObject({ name: 'Dana Brooks', email, agencyStaff: false });
    expect(profile.agency).toEqual({
      name: expect.any(String) as unknown,
      slug: expect.any(String) as unknown,
    });
    expect(profile.businesses.map((each) => each.id).sort()).toEqual(
      [first.businessId, second.businessId].sort(),
    );
  });

  it('gives agency staff every business of the agency, archived ones too', async () => {
    const { id, email } = await person();
    const agency = await database.fixtures.agency();
    await staffOf(id, agency.id);
    const active = await database.fixtures.business(agency.id);
    const archived = await database.fixtures.business(agency.id);
    await setStatus(archived.id, 'archived');

    const profile = await auth.whoIs(await signedInAs(email));

    expect(profile.agencyStaff).toBe(true);
    expect(profile.businesses.map((each) => [each.id, each.status]).sort()).toEqual(
      [
        [active.id, 'active'],
        [archived.id, 'archived'],
      ].sort(),
    );
  });

  it('lists businesses by name', async () => {
    const { id, email } = await person();
    const agency = await database.fixtures.agency();
    await staffOf(id, agency.id);
    await database.fixtures.business(agency.id, { name: 'Zephyr Bakery' });
    await database.fixtures.business(agency.id, { name: 'Atlas Plumbing' });

    const profile = await auth.whoIs(await signedInAs(email));

    expect(profile.businesses.map((each) => each.name)).toEqual([
      'Atlas Plumbing',
      'Zephyr Bakery',
    ]);
  });

  it('refuses someone with no agency yet, whom the API never lets this far', async () => {
    const { email } = await person();

    await expect(auth.whoIs(await signedInAs(email))).rejects.toThrow(
      "isn't a member of an agency",
    );
  });
});

// A workplace comes with what the person's role allows there.
describe('what someone may change where they work', () => {
  interface Role {
    readonly scope: 'agency' | 'business';
    readonly key: string;
    readonly builtIn: boolean;
    readonly permissions?: readonly string[];
  }

  /** A membership of the agency (no business) or of a business, with the role given. */
  const withRole = (userId: string, agencyId: string, businessId: string | null, role: Role) =>
    database.as('crm_owner', async (sql) => {
      const { id: roleId } = await sql.one<{ id: string }>(
        `insert into tenancy.roles (agency_id, scope, key, name, is_builtin, permissions)
         values ($1, $2, $3, $3, $4, $5)
         on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
        [agencyId, role.scope, role.key, role.builtIn, role.permissions ?? []],
      );
      await sql.query(
        `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
         values ($1, $2, $3, $4)`,
        [userId, agencyId, businessId, roleId],
      );
    });

  const permissionsAt = async (email: string, businessId: string | undefined) => {
    const found = await auth.workplace(await signedInAs(email), businessId);
    return found.at === 'refused' ? found : [...found.permissions].sort();
  };

  it("gives agency staff their agency role's permissions, at the agency and in every business", async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const owner = await person();
    await withRole(owner.id, agency.id, null, { scope: 'agency', key: 'owner', builtIn: true });
    const member = await person();
    await withRole(member.id, agency.id, null, { scope: 'agency', key: 'member', builtIn: true });

    expect(await permissionsAt(owner.email, undefined)).toEqual([
      'agency.security',
      'ai.manage',
      'apps.manage',
      'businesses.create',
      'files.upload',
      'team.manage',
    ]);
    expect(await permissionsAt(owner.email, business.id)).toEqual([
      'ai.manage',
      'appointments.manage',
      'apps.manage',
      'assistant.use',
      'audit.read',
      'automations.manage',
      'automations.publish',
      'business.profile',
      'calendars.manage',
      'calls.place',
      'calls.read',
      'campaigns.manage',
      'campaigns.send',
      'companies.manage',
      'contacts.export',
      'contacts.import',
      'contacts.manage',
      'contacts.merge',
      'conversations.manage',
      'conversations.reply',
      'deals.manage',
      'domains.manage',
      'email.verification.manage',
      'fields.manage',
      'fields.values',
      'files.upload',
      'forms.manage',
      'mailboxes.manage',
      'media.manage',
      'notes.manage',
      'objects.manage',
      'payments.manage',
      'payments.read',
      'phone.manage',
      'pipelines.manage',
      'records.manage',
      'reports.manage',
      'reports.view',
      'sites.manage',
      'sites.publish',
      'sites.share',
      'sms.manage',
      'tags.configure',
      'tags.manage',
      'tasks.manage',
      'team.manage',
      'templates.manage',
      'trash.purge',
      'views.save',
      'views.share',
      'webchat.manage',
    ]);
    expect(await permissionsAt(member.email, undefined)).toEqual(['files.upload']);
    expect(await permissionsAt(member.email, business.id)).toEqual([
      'appointments.manage',
      'assistant.use',
      'calls.place',
      'calls.read',
      'campaigns.manage',
      'companies.manage',
      'contacts.manage',
      'conversations.manage',
      'conversations.reply',
      'deals.manage',
      'fields.values',
      'files.upload',
      'media.manage',
      'notes.manage',
      'payments.read',
      'records.manage',
      'reports.view',
      'tags.manage',
      'tasks.manage',
      'views.save',
    ]);
  });

  it("gives a business user their membership's role in that business", async () => {
    const agency = await database.fixtures.agency();
    const watched = await database.fixtures.business(agency.id);
    const worked = await database.fixtures.business(agency.id);
    const someone = await person();
    await withRole(someone.id, agency.id, watched.id, {
      scope: 'business',
      key: 'viewer',
      builtIn: true,
    });
    await withRole(someone.id, agency.id, worked.id, {
      scope: 'business',
      key: 'member',
      builtIn: true,
    });

    expect(await permissionsAt(someone.email, watched.id)).toEqual(['assistant.use']);
    expect(await permissionsAt(someone.email, worked.id)).toEqual([
      'appointments.manage',
      'assistant.use',
      'calls.place',
      'calls.read',
      'campaigns.manage',
      'companies.manage',
      'contacts.manage',
      'conversations.manage',
      'conversations.reply',
      'deals.manage',
      'fields.values',
      'files.upload',
      'media.manage',
      'notes.manage',
      'payments.read',
      'records.manage',
      'reports.view',
      'tags.manage',
      'tasks.manage',
      'views.save',
    ]);
  });

  it("gives a custom role the keys it stores, and a built-in one only its release's", async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const custom = await person();
    await withRole(custom.id, agency.id, business.id, {
      scope: 'business',
      key: 'tagger',
      builtIn: false,
      permissions: ['tags.manage', 'payments.refund'],
    });
    const viewer = await person();
    await withRole(viewer.id, agency.id, business.id, {
      scope: 'business',
      key: 'viewer',
      builtIn: true,
      permissions: ['tags.manage'],
    });

    expect(await permissionsAt(custom.email, business.id)).toEqual(['tags.manage']);
    expect(await permissionsAt(viewer.email, business.id)).toEqual(['assistant.use']);
  });

  it('refreshes role grants and membership on each request using the same session', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const someone = await person();
    await withRole(someone.id, agency.id, business.id, {
      scope: 'business',
      key: 'tagger',
      builtIn: false,
      permissions: ['tags.manage'],
    });
    const cookie = sessionCookie(await signIn(someone.email, PASSWORD, newClient()));
    const workplace = async () => {
      const signedIn = await auth.signedIn(new Headers({ cookie }));
      if (signedIn === undefined) throw new Error('Not signed in.');
      return auth.workplace(signedIn, business.id);
    };

    expect(await workplace()).toMatchObject({ permissions: new Set(['tags.manage']) });
    await database.as('crm_owner', (sql) =>
      sql.query(
        "update tenancy.roles set permissions = '{}' where agency_id = $1 and key = 'tagger'",
        [agency.id],
      ),
    );
    expect(await workplace()).toMatchObject({ permissions: new Set() });
    await database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.memberships where user_id = $1', [someone.id]),
    );
    expect(await workplace()).toMatchObject({ at: 'refused', status: 403, code: 'no_agency' });
  });
});
