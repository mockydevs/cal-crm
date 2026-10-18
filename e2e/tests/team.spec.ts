import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { address, asClient, inOurs } from '../servers.js';
import { emailTo, newPerson, query, signInByLink } from '../signing-in.js';
import { addUser, findUser } from '../users.js';

test.use(asClient('203.0.113.71'));

test('invites, rotates a link, accepts once, and removes a member', async ({ page, browser }) => {
  const admin = await newPerson();
  const email = `invited-${randomUUID()}@example.test`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, admin.email, 1);
  await page.goto(inOurs('/settings/team'));
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  const row = await addUser(page, {
    email,
    firstName: 'Riley',
    lastName: 'Invitee',
    phone: '+254712345678',
  });
  // The details typed with the invitation are kept with it, and survive a reload.
  await page.reload();
  await findUser(page, email);
  await expect(row.getByText('+254712345678', { exact: true })).toBeVisible();
  await expect(row.getByText('Account - member', { exact: true })).toBeVisible();
  const first = await emailTo(email);
  await row.getByRole('button', { name: 'Resend the invitation to Riley Invitee' }).click();
  await expect(
    page.getByRole('main').getByText('Invitation resent. The previous link no longer works.'),
  ).toBeVisible();
  const second = await emailTo(email, 2);
  expect(first.link).not.toBe(second.link);
  const context = await browser.newContext(asClient('203.0.113.72'));
  try {
    const invited = await context.newPage();
    await invited.goto(first.link);
    await expect(
      invited.getByRole('heading', { name: 'This invitation has run out' }),
    ).toBeVisible();
    const wrongEmail = await invited.request.post(`${address('app')}/api/auth/invitations/accept`, {
      headers: { origin: address('app') },
      data: {
        token: new URL(second.link).searchParams.get('token'),
        email: 'not-invited@example.test',
        name: 'Other',
        password: 'a few unrelated words for Other',
      },
    });
    expect(wrongEmail.status()).toBe(400);
    await invited.goto(second.link);
    await invited.getByLabel('Your name').fill('Invited Riley');
    await invited.getByLabel('Password', { exact: true }).fill('a few unrelated words for Riley');
    await invited.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(invited).toHaveURL(inOurs());
    await page.reload();
    // Accepted: no longer Invited, and what Add user wrote of them is their profile here.
    const member = await findUser(page, email);
    await expect(member.getByRole('rowheader')).toContainText('Riley Invitee');
    await expect(member.getByText('Account - member', { exact: true })).toBeVisible();
    await expect(member.getByText('+254712345678', { exact: true })).toBeVisible();
    await expect(member.getByText('Invited', { exact: true })).toHaveCount(0);
    await expect(member.getByRole('button', { name: /Resend the invitation/ })).toHaveCount(0);
    const [profile] = await query<{ first_name: string; last_name: string; phone: string }>(
      `select p.first_name, p.last_name, p.phone_e164 as phone from tenancy.user_profiles p
       join auth.users u on u.id = p.user_id where u.email = $1`,
      [email],
    );
    expect(profile).toEqual({
      first_name: 'Riley',
      last_name: 'Invitee',
      phone: '+254712345678',
    });
    await invited.goto(second.link);
    await expect(
      invited.getByRole('heading', { name: 'This invitation has run out' }),
    ).toBeVisible();
    await member.getByRole('button', { name: 'Remove Riley Invitee from this account' }).click();
    await page
      .getByRole('dialog', { name: 'Remove Riley Invitee?' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(page.getByRole('main').getByText('Riley Invitee was removed.')).toBeVisible();
    await expect(member).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    // Asked of the server again by their address: nobody, and the list says so.
    await findUser(page, email);
    await expect(page.getByRole('main').getByText('No users match.')).toBeVisible();
    await expect(member).toHaveCount(0);
    const answer = await invited.request.get(`${address('app')}/api/v1/me`);
    expect(answer.status()).toBe(403);
  } finally {
    await context.close();
  }
});

test('revoked and expired invitations cannot create an account', async ({ page, browser }) => {
  const admin = await newPerson();
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, admin.email, 1);
  await page.goto(inOurs('/settings/team'));
  const context = await browser.newContext(asClient('203.0.113.73'));
  try {
    const invited = await context.newPage();
    for (const status of ['revoked', 'expired']) {
      const email = `${status}-${randomUUID()}@example.test`;
      const row = await addUser(page, { email, firstName: 'Sam', lastName: status });
      const { link } = await emailTo(email);
      if (status === 'revoked') {
        await row.getByRole('button', { name: `Revoke the invitation of Sam ${status}` }).click();
        await page
          .getByRole('dialog', { name: `Revoke the invitation of Sam ${status}?` })
          .getByRole('button', { name: 'Revoke', exact: true })
          .click();
        await expect(page.getByRole('main').getByText('Invitation revoked.')).toBeVisible();
        await expect(row).toHaveCount(0);
      } else
        await query(
          `update tenancy.invitations set expires_at = now() - interval '1 second' where email = $1`,
          [email],
        );
      await invited.goto(link);
      await expect(
        invited.getByRole('heading', { name: 'This invitation has run out' }),
      ).toBeVisible();
      const users = await query('select id from auth.users where email = $1', [email]);
      expect(users).toHaveLength(0);
    }
  } finally {
    await context.close();
  }
});
