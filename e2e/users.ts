// Settings → Users, as the tests that invite people drive it: "Add user" opens a page of
// five tabs, saving it sends the invitation, and the person shows in the table as Invited
// until they accept.
import { expect, type Locator, type Page } from '@playwright/test';

import { choose } from './select.js';

export interface NewUser {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** The role's name as the form shows it. Left out, the form's own choice stands: Member. */
  readonly role?: string;
  /** A number written with + and the country code, which any country chosen reads the same. */
  readonly phone?: string;
}

/** The table row of the person with this email address, on the Users page. */
export function userRow(page: Page, email: string): Locator {
  return page.getByRole('main').getByRole('row').filter({ hasText: email });
}

/**
 * On the Users page: asks the server for the person with this email address, and returns
 * their row. The list is paged, twenty to a page, and a business other tests work in has
 * more people than that, so a person is found by the search, never by being on the page.
 */
export async function findUser(page: Page, email: string): Promise<Locator> {
  const search = page.getByRole('main').getByRole('searchbox', { name: 'Search users' });
  await search.fill(email);
  await expect(search).toHaveValue(email);
  return userRow(page, email);
}

/**
 * On the Users page: adds a person through "Add user", and waits until the list shows
 * them as Invited with the role chosen. The invitation email is sent by then.
 */
export async function addUser(page: Page, person: NewUser): Promise<Locator> {
  const main = page.getByRole('main');
  await main.getByRole('link', { name: 'Add user', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add user' })).toBeVisible();
  // The form is whole once its two late parts have drawn: the phone box and the signature.
  const phone = main.getByRole('textbox', { name: 'Phone', exact: true });
  await expect(phone).toBeVisible();
  await expect(main.getByRole('textbox', { name: 'Email signature' })).toBeVisible();
  // Nobody types another person's password: adding is an invitation.
  await expect(main.getByLabel(/password/i)).toHaveCount(0);
  await main.getByRole('textbox', { name: 'First name' }).fill(person.firstName);
  await main.getByRole('textbox', { name: 'Last name' }).fill(person.lastName);
  await main.getByRole('textbox', { name: 'Email', exact: true }).fill(person.email);
  if (person.phone !== undefined) await phone.fill(person.phone);
  if (person.role !== undefined) {
    await page.getByRole('tab', { name: 'Roles & permissions', exact: true }).click();
    await choose(main.getByRole('combobox', { name: 'User role' }), { label: person.role });
  }
  await main.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await expect(
    main.getByText(
      `${person.firstName} ${person.lastName} was invited. They join when they accept the email.`,
    ),
  ).toBeVisible();
  const row = await findUser(page, person.email);
  await expect(row.getByRole('rowheader')).toContainText(`${person.firstName} ${person.lastName}`);
  await expect(row.getByText('Invited', { exact: true })).toBeVisible();
  await expect(
    row.getByText(new RegExp(`^(Agency|Account) - ${(person.role ?? 'Member').toLowerCase()}$`)),
  ).toBeVisible();
  return row;
}
