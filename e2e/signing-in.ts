// What the tests share for signing in: people to sign in as, the mail the app sent them
// (Mailpit), and the database, for what the app doesn't show.
import { randomUUID } from 'node:crypto';

import { expect, type Page } from '@playwright/test';
import { mailbox, totpCode } from '@repo/testing';
import pg from 'pg';

import { address, inOurs, owner } from './servers.js';

/** Reads or writes the database as crm_owner, for what the API doesn't show. */
export async function query<Row extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: address('database') });
  await client.connect();
  try {
    return (await client.query<Row>(text, [...values])).rows;
  } finally {
    await client.end();
  }
}

export interface Person {
  readonly id: string;
  readonly email: string;
}

/**
 * Someone new who works where the owner does, with no password yet. Each has their own
 * address, so tests running side by side don't read each other's mail.
 */
export async function newPerson(): Promise<Person> {
  const suffix = randomUUID().slice(0, 8);
  const [person] = await query<{ id: string; email: string }>(
    `with person as (
       insert into auth.users (email, name) values ($1, $2) returning id, email
     ), membership as (
       insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select person.id, m.agency_id, m.business_id, m.role_id
       from person, tenancy.memberships m join auth.users u on u.id = m.user_id
       where u.email = $3
     )
     select id, email from person`,
    [`riley-${suffix}@harborlights.example`, `Riley ${suffix}`, owner.email],
  );
  if (person === undefined) throw new Error('Making a person returned no row.');
  return person;
}

/** The nth email the app sent to this address (counting from 1) once it has come, and its link. */
export async function emailTo(to: string, nth = 1): Promise<{ subject: string; link: string }> {
  const inbox = mailbox({ apiUrl: address('mail') });
  // The app sends after it answers, so the mail can come a moment later.
  const email = async () => (await inbox.messagesTo(to))[nth - 1];
  await expect
    .poll(async () => (await email()) !== undefined, {
      message: `email ${String(nth)} to ${to} should come`,
    })
    .toBe(true);
  const found = await email();
  const link = /https?:\/\/\S+/.exec(found?.text ?? '')?.[0];
  if (found === undefined || link === undefined) throw new Error(`No link in the email to ${to}.`);
  return { subject: found.subject, link };
}

/** On the sign-in page: asks for a link that signs this address in, and waits until it's sent. */
export async function askForSignInLink(page: Page, email: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click();
  await expect(page.getByRole('status')).toContainText(email);
}

/**
 * Makes the person's emailed links run out now, as if their time had passed, and returns
 * the minutes each had left. Tokens are stored hashed, so a link's row is found by what it
 * holds: the person's id for a password reset, their address for a sign-in link.
 */
export async function expireLinksOf(person: Person): Promise<number[]> {
  const rows = await query<{ minutes_left: number }>(
    `update auth.verifications v set expires_at = now() - interval '1 second'
     from (select id, extract(epoch from expires_at - now()) / 60 as minutes_left
           from auth.verifications
           where value = $1
              or case when pg_input_is_valid(value, 'jsonb')
                      then lower(value::jsonb ->> 'email') = $2 else false end) as before
     where v.id = before.id
     returning before.minutes_left::float8 as minutes_left`,
    [person.id, person.email],
  );
  return rows.map((row) => row.minutes_left);
}

/**
 * Someone new on the agency's own team, with no password: agency staff, a member of the
 * agency itself rather than of one of its businesses.
 */
export async function newStaff(): Promise<Person> {
  const suffix = randomUUID().slice(0, 8);
  const [person] = await query<{ id: string; email: string }>(
    `with person as (
       insert into auth.users (email, name) values ($1, $2) returning id, email
     ), role as (
       insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       select m.agency_id, 'agency', 'admin', 'Admin', true
       from tenancy.memberships m join auth.users u on u.id = m.user_id
       where u.email = $3
       on conflict (agency_id, scope, key) do update set name = excluded.name
       returning id, agency_id
     ), membership as (
       insert into tenancy.memberships (user_id, agency_id, role_id)
       select person.id, role.agency_id, role.id from person, role
     )
     select id, email from person`,
    [`staff-${suffix}@bluebird.example`, `Staff ${suffix}`, owner.email],
  );
  if (person === undefined) throw new Error('Making a member of staff returned no row.');
  return person;
}

/**
 * Signs in with the nth link emailed to the address, asked for from the sign-in page
 * the page is on.
 */
export async function signInByLink(page: Page, email: string, nth: number): Promise<void> {
  await askForSignInLink(page, email);
  await page.goto((await emailTo(email, nth)).link);
}

/** The code an authenticator app shows for a key typed into it, as Settings shows it. */
export const codeFor = (key: string): string =>
  totpCode(`otpauth://totp/e2e?secret=${key.replace(/\s/g, '')}`);

/**
 * Sets up two-factor sign-in in Settings, as someone would with their phone, and returns
 * the key they'd have typed into the app and their recovery codes.
 */
export async function setUpTwoFactor(
  page: Page,
): Promise<{ key: string; recoveryCodes: string[] }> {
  await page.goto(inOurs('/settings/sign-in'));
  const section = page.getByRole('region', { name: 'Two-factor sign-in' });
  await section.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
  const key = (await section.getByTestId('set-up-key').textContent()) ?? '';
  await section.getByLabel('The 6-digit code from the app').fill(codeFor(key));
  await section.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
  const codes = section.getByRole('list', { name: 'Recovery codes' });
  await expect(codes).toBeVisible();
  const recoveryCodes = await codes.getByRole('listitem').allTextContents();
  await section.getByRole('button', { name: "I've saved my recovery codes" }).click();
  await expect(section.getByText('On', { exact: true })).toBeVisible();
  return { key, recoveryCodes };
}

/** Sees who is signed in: the account menu in the top bar says, and is closed again. */
export async function expectSignedInAs(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'Your account' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText(email, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

/** Signs out from the account menu in the top bar. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Your account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
}
