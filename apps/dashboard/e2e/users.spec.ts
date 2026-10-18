// Settings → Users in a real browser, against the stand-in API of users-fixtures.ts: the
// list as the owner's GoHighLevel screenshot has it, and Add user and Edit user with their
// five tabs. It replaces team.spec.ts's cases of the old Users page.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { choose, expectChoice } from './select';
import { agencyStaff, dana, inHarbor, signedIn } from './session';
import {
  builtinRoles,
  calendarOf,
  fakeUsersApi,
  invitedOf,
  memberOf,
  type UsersApi,
} from './users-fixtures';

const main = (page: Page): Locator => page.getByRole('main');
const row = (page: Page, name: string): Locator =>
  main(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name }) });
const tab = (page: Page, name: string): Locator => page.getByRole('tab', { name, exact: true });
const bodiesOf = (api: UsersApi, call: RegExp): unknown[] =>
  api.sent.filter((each) => call.test(each.call)).map((each) => each.body);
const tabNames = [
  'User info',
  'Roles & permissions',
  'Call & voicemail',
  'User availability',
  'Calendar configuration',
] as const;

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/** Harbor's people: an agency admin, Dana herself, a member, and someone invited. */
async function harborUsers(page: Page, options: { canManage?: boolean; country?: string } = {}) {
  const roles = builtinRoles();
  const canManage = options.canManage ?? true;
  const ava = memberOf('Ava Agency', roles.admin, {
    userType: 'agency',
    canEdit: false,
    canRemove: false,
  });
  const me = memberOf('Dana Brooks', roles.admin, {
    email: dana.email,
    isSelf: true,
    canEdit: canManage,
    canRemove: false,
    phone: '+13055550123',
    extension: '42',
  });
  const riley = memberOf('Riley Brooks', roles.member, {
    canEdit: canManage,
    canRemove: canManage,
  });
  const sam = invitedOf('Sam Okoro', roles.member, { canRemove: canManage });
  const consults = calendarOf('Consultations');
  const tours = calendarOf('Venue tours');
  const api = await fakeUsersApi(page, {
    people: [ava, me, riley, sam],
    roles: [roles.admin, roles.member, roles.owner, roles.viewer],
    canManage,
    calendars: [consults, tours],
    teams: { [consults.id]: [riley.id] },
    ...(options.country === undefined ? {} : { country: options.country }),
  });
  return { api, roles, ava, me, riley, sam, consults, tours };
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [390, 1280]) {
  test(`the list shows each kind of person and what may be done, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { riley } = await harborUsers(page);
    await page.goto(inHarbor('/settings/team'));
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    await expect(main(page).getByRole('columnheader').filter({ visible: true })).toHaveText([
      'Name',
      'Email',
      'Phone number',
      'User type',
      'Actions',
    ]);

    // The agency's own team: listed, and changed at the agency.
    const agency = row(page, 'Ava Agency');
    await expect(agency.getByText('Agency - admin')).toBeVisible();
    for (const name of ['Edit Ava Agency', 'Remove Ava Agency from this account']) {
      const button = agency.getByRole('button', { name });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveAttribute('title', "Managed in the agency's Users");
    }

    // Oneself: edited, never removed.
    const self = row(page, 'Dana Brooks');
    await expect(self.getByText('(you)')).toBeVisible();
    await expect(self.getByText('Account - admin')).toBeVisible();
    await expect(self.getByText('+13055550123 ext. 42')).toBeVisible();
    await expect(self.getByRole('link', { name: 'Edit Dana Brooks' })).toBeVisible();
    await expect(
      self.getByRole('button', { name: 'Remove Dana Brooks from this account' }),
    ).toHaveAttribute('title', "You can't remove yourself.");

    // A member of the account: both actions, and no invitation to resend.
    const account = row(page, 'Riley Brooks');
    await expect(account.getByText('Account - member')).toBeVisible();
    await expect(account.getByText(`id: ${riley.id}`)).toBeVisible();
    await expect(account.getByRole('cell', { name: '-', exact: true })).toBeVisible();
    await expect(account.getByRole('link', { name: 'Edit Riley Brooks' })).toBeVisible();
    await expect(
      account.getByRole('button', { name: 'Remove Riley Brooks from this account' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    await expect(account.getByRole('button', { name: /Resend/ })).toHaveCount(0);

    // Someone invited: not edited, revoked or sent again.
    const invited = row(page, 'Sam Okoro');
    await expect(invited.getByText('Invited', { exact: true })).toBeVisible();
    await expect(invited.getByRole('button', { name: 'Edit Sam Okoro' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(
      invited.getByRole('button', { name: 'Revoke the invitation of Sam Okoro' }),
    ).toBeVisible();
    await expect(
      invited.getByRole('button', { name: 'Resend the invitation to Sam Okoro' }),
    ).toBeVisible();

    await expect(main(page).getByRole('link', { name: 'Add user' })).toBeVisible();
    await expect(main(page).getByText('1 - 4 of 4')).toBeVisible();
    await expect(main(page).getByRole('navigation', { name: 'Breadcrumb' })).toHaveText(
      'Settings/Users',
    );
    await expectChoice(main(page).getByRole('combobox', { name: 'Rows per page' }), '20');
    await expectAccessible(page);
  });
}

test('search and the role filter are asked of the server, and the filter is cleared', async ({
  page,
}) => {
  const { api, roles } = await harborUsers(page);
  await page.goto(inHarbor('/settings/team'));
  await expect(row(page, 'Riley Brooks')).toBeVisible();
  const search = main(page).getByRole('searchbox', { name: 'Search users' });
  await expect(search).toHaveAttribute('placeholder', 'name, email, phone, ids');

  await search.fill('riley');
  await expect(row(page, 'Dana Brooks')).toHaveCount(0);
  await expect(row(page, 'Riley Brooks')).toBeVisible();
  expect(api.listed.at(-1)).toMatchObject({ q: 'riley', limit: 20 });

  // By phone, as digits; by id.
  await search.fill('305 555');
  await expect(row(page, 'Dana Brooks')).toBeVisible();
  await expect(row(page, 'Riley Brooks')).toHaveCount(0);
  await search.fill('nobody at all');
  await expect(main(page).getByText('No users match.')).toBeVisible();
  await search.fill('');
  await expect(row(page, 'Riley Brooks')).toBeVisible();

  const filter = main(page).getByRole('combobox', { name: 'User role' });
  await choose(filter, roles.admin.id);
  await expect(row(page, 'Riley Brooks')).toHaveCount(0);
  await expect(row(page, 'Ava Agency')).toBeVisible();
  expect(api.listed.at(-1)).toMatchObject({ role: roles.admin.id });
  expect(api.listed.at(-1)?.q).toBeUndefined();

  await choose(filter, 'type:agency');
  await expect(row(page, 'Dana Brooks')).toHaveCount(0);
  await expect(main(page).getByText('1 - 1 of 1')).toBeVisible();
  expect(api.listed.at(-1)).toMatchObject({ type: 'agency' });

  await main(page).getByRole('button', { name: 'Clear the user role filter' }).click();
  await expect(main(page).getByText('1 - 4 of 4')).toBeVisible();
  await expectChoice(filter, 'all');
  await expect(main(page).getByRole('button', { name: 'Clear the user role filter' })).toHaveCount(
    0,
  );
});

test('the list is walked a page at a time with the server’s cursor', async ({ page }) => {
  const roles = builtinRoles();
  const people = Array.from({ length: 23 }, (_, index) =>
    memberOf(`Person ${String(index + 1).padStart(2, '0')}`, roles.member),
  );
  const api = await fakeUsersApi(page, { people, roles: [roles.admin, roles.member] });
  await page.goto(inHarbor('/settings/team'));
  await expect(main(page).getByText('1 - 20 of 23')).toBeVisible();
  await choose(main(page).getByRole('combobox', { name: 'Rows per page' }), '10');
  await expect(main(page).getByText('1 - 10 of 23')).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Previous page' })).toBeDisabled();

  await main(page).getByRole('button', { name: 'Next page' }).click();
  await expect(main(page).getByText('11 - 20 of 23')).toBeVisible();
  await expect(row(page, 'Person 11')).toBeVisible();
  expect(api.listed.at(-1)).toMatchObject({ limit: 10 });
  expect(api.listed.at(-1)?.after).toEqual(expect.any(String));
  await main(page).getByRole('button', { name: 'Next page' }).click();
  await expect(main(page).getByText('21 - 23 of 23')).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Next page' })).toBeDisabled();
  await main(page).getByRole('button', { name: 'Previous page' }).click();
  await expect(main(page).getByText('11 - 20 of 23')).toBeVisible();
});

test('a person’s id is copied, and the page says so', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { riley } = await harborUsers(page);
  await page.goto(inHarbor('/settings/team'));
  await row(page, 'Riley Brooks')
    .getByRole('button', { name: 'Copy the id of Riley Brooks' })
    .click();
  await expect(main(page).getByText(`Copied ${riley.id}`)).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(riley.id);
});

test('adds a user through the five tabs with the keyboard, and lists them as Invited', async ({
  page,
}) => {
  const { api, roles, tours } = await harborUsers(page);
  await page.goto(inHarbor('/settings/team'));
  await main(page).getByRole('link', { name: 'Add user' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/settings/team/new')}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Add user' })).toBeVisible();
  const phone = main(page).getByRole('textbox', { name: 'Phone', exact: true });
  await expect(phone).toBeVisible();
  const signature = main(page).getByRole('textbox', { name: 'Email signature' });
  await expect(signature).toBeVisible();
  await expect(tab(page, 'User info')).toHaveAttribute('aria-selected', 'true');
  await expect(main(page).getByRole('tablist').getByRole('tab')).toHaveText([...tabNames]);
  // Nobody types another person's password here: adding is an invitation.
  await expect(main(page).getByLabel(/password/i)).toHaveCount(0);
  await expect(main(page).getByText(/Saving sends this person an email invitation/)).toBeVisible();

  // The details are asked for before the next tab.
  await main(page).getByRole('button', { name: 'Next' }).focus();
  await page.keyboard.press('Enter');
  await expect(main(page).getByText('Give the first name.')).toBeVisible();
  await expect(main(page).getByText('Give the last name.')).toBeVisible();
  await expect(main(page).getByText('Enter the email address.')).toBeVisible();
  await expect(tab(page, 'User info')).toHaveAttribute('aria-selected', 'true');
  const firstName = main(page).getByRole('textbox', { name: 'First name' });
  await expect(firstName).toBeFocused();
  await expectAccessible(page);

  await page.keyboard.type('Sam');
  await page.keyboard.press('Tab');
  await expect(main(page).getByRole('textbox', { name: 'Last name' })).toBeFocused();
  await page.keyboard.type('Okoro');
  await page.keyboard.press('Tab');
  await expect(main(page).getByRole('textbox', { name: 'Email', exact: true })).toBeFocused();
  await page.keyboard.type('Sam.Okoro@Example.test');
  await expect(main(page).getByText('Give the first name.')).toHaveCount(0);

  // The country, by the keyboard: it starts on the US, as the screenshot does.
  await page.keyboard.press('Tab');
  const country = main(page).getByRole('combobox', { name: 'Phone country' });
  await expect(country).toBeFocused();
  await expectChoice(country, 'US');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.type('Kenya');
  await page.keyboard.press('Enter');
  await expectChoice(country, 'KE');
  await page.keyboard.press('Tab');
  await expect(phone).toBeFocused();
  await page.keyboard.type('0712 345 678');
  await page.keyboard.press('Tab');
  await expect(main(page).getByRole('textbox', { name: 'Extension' })).toBeFocused();
  await page.keyboard.type('42');

  await page.keyboard.press('Tab');
  const calendar = main(page).getByRole('combobox', { name: 'Calendar', exact: true });
  await expect(calendar).toBeFocused();
  await expectChoice(calendar, '');
  await expect(calendar).toHaveText('Select a calendar');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.type('Venue');
  await page.keyboard.press('Enter');
  await expectChoice(calendar, tours.id);

  await page.keyboard.press('Tab');
  const signatureSwitch = main(page).getByRole('switch', {
    name: 'Add signature to outgoing emails',
  });
  await expect(signatureSwitch).toBeFocused();
  await page.keyboard.press('Space');
  await expect(signatureSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(signature.locator('p')).toHaveAttribute(
    'data-placeholder',
    'Create your email signature',
  );
  await signature.focus();
  await page.keyboard.type('Sam Okoro');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Harbor Lights Events');

  // Next walks the tabs; each is checked as it shows.
  await main(page).getByRole('button', { name: 'Next' }).focus();
  await page.keyboard.press('Enter');
  await expect(tab(page, 'Roles & permissions')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'Roles & permissions')).toBeFocused();
  const role = main(page).getByRole('combobox', { name: 'User role' });
  // Everyday work unless someone chooses otherwise (the old page's rule, 1A review A3).
  await expectChoice(role, roles.member.id);
  await role.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
    'Admin',
    'Member',
    'Viewer',
  ]);
  await page.keyboard.type('Admin');
  await page.keyboard.press('Enter');
  await expectChoice(role, roles.admin.id);
  await expect(
    main(page).getByRole('region', { name: 'What this role can do' }).getByRole('listitem'),
  ).toHaveCount(3);
  await expectAccessible(page);

  await tab(page, 'Roles & permissions').focus();
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'Call & voicemail')).toBeFocused();
  await expect(tab(page, 'Call & voicemail')).toHaveAttribute('aria-selected', 'true');
  await expect(
    main(page).getByText(
      "Calls and voicemail need the phone system, which isn't set up in this version.",
    ),
  ).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'User availability')).toHaveAttribute('aria-selected', 'true');
  await expect(
    main(page).getByText(/Availability can be set once this person has joined/),
  ).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'Calendar configuration')).toHaveAttribute('aria-selected', 'true');
  await expect(
    main(page).getByText(/Once this person has joined, the calendars they are on/),
  ).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Next' })).toHaveCount(0);
  await expectAccessible(page);

  await main(page).getByRole('button', { name: 'Save' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/settings/team')}$`));
  await expect(
    main(page).getByText('Sam Okoro was invited. They join when they accept the email.'),
  ).toBeVisible();
  expect(bodiesOf(api, /^POST \/users$/)).toEqual([
    {
      email: 'sam.okoro@example.test',
      firstName: 'Sam',
      lastName: 'Okoro',
      phone: '+254712345678',
      extension: '42',
      avatarFileId: null,
      roleId: roles.admin.id,
      calendarId: tours.id,
      signature: {
        enabled: true,
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Sam Okoro' },
                { type: 'hardBreak' },
                { type: 'text', text: 'Harbor Lights Events' },
              ],
            },
          ],
        },
      },
    },
  ]);
  const added = main(page).getByRole('row').filter({ hasText: 'sam.okoro@example.test' });
  await expect(added.getByText('Account - admin')).toBeVisible();
  await expect(added.getByText('Invited', { exact: true })).toBeVisible();
  await expect(added.getByText('+254712345678 ext. 42')).toBeVisible();
});

test('every tab of Add user fits a phone and passes the accessibility check', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await harborUsers(page, { country: 'KE' });
  await page.goto(inHarbor('/settings/team/new'));
  await expect(main(page).getByRole('textbox', { name: 'Phone', exact: true })).toBeVisible();
  await expect(main(page).getByRole('textbox', { name: 'Email signature' })).toBeVisible();
  // A new number starts in the business's own country.
  await expectChoice(main(page).getByRole('combobox', { name: 'Phone country' }), 'KE');
  for (const name of tabNames) {
    await tab(page, name).click();
    await expect(page.getByRole('tabpanel', { name })).toBeVisible();
    await expectAccessible(page);
  }
});

test('a profile image is checked before it is sent, uploaded, and saved with the person', async ({
  page,
}) => {
  const { api, riley } = await harborUsers(page);
  await page.goto(inHarbor(`/settings/team/${riley.id}`));
  await expect(page.getByRole('heading', { level: 1, name: 'Edit user' })).toBeVisible();
  const file = main(page).getByLabel('Choose a profile image');
  await expect(
    main(page).getByText('The proposed size is 512*512 px no bigger than 2.5 MB'),
  ).toBeVisible();
  await file.setInputFiles({
    name: 'big.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(2_500_001),
  });
  await expect(
    main(page).getByText('That image is bigger than 2.5 MB. Choose a smaller one.'),
  ).toBeVisible();
  await file.setInputFiles({
    name: 'me.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg/>'),
  });
  await expect(main(page).getByText('Choose a PNG, JPEG, GIF or WebP image.')).toBeVisible();
  expect(bodiesOf(api, /^POST \/files$/)).toEqual([]);

  await file.setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from('png') });
  await expect(main(page).getByRole('img', { name: 'Profile preview' })).toBeVisible();
  expect(bodiesOf(api, /^POST \/files$/)).toEqual([
    { filename: 'me.png', type: 'image/png', size: 3 },
  ]);
  await expectAccessible(page);
  await main(page).getByRole('button', { name: 'Save' }).click();
  await expect(main(page).getByText('Riley Brooks was saved.')).toBeVisible();
  expect(bodiesOf(api, /^PUT \/users\//)).toEqual([
    expect.objectContaining({ avatarFileId: expect.stringMatching(/^file_/) }),
  ]);
});

test('edits a user: the name, the role and the signature are saved', async ({ page }) => {
  const { api, roles, riley } = await harborUsers(page);
  await page.goto(inHarbor('/settings/team'));
  await row(page, 'Riley Brooks').getByRole('link', { name: 'Edit Riley Brooks' }).click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor(`/settings/team/${riley.id}`)}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Edit user' })).toBeVisible();
  const firstName = main(page).getByRole('textbox', { name: 'First name' });
  await expect(firstName).toHaveValue('Riley');
  const email = main(page).getByRole('textbox', { name: 'Email', exact: true });
  await expect(email).toHaveValue(riley.email);
  await expect(email).toHaveAttribute('readonly', '');
  await expect(main(page).getByText(/Saving sends this person an email invitation/)).toHaveCount(0);
  await expectAccessible(page);

  await firstName.fill('Rae');
  await main(page).getByRole('switch', { name: 'Add signature to outgoing emails' }).click();
  const signature = main(page).getByRole('textbox', { name: 'Email signature' });
  await signature.click();
  const bold = main(page).getByRole('button', { name: 'Bold' });
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  // The button hands the keyboard back to the editor a frame later.
  await expect(signature).toBeFocused();
  await page.keyboard.type('Rae');
  await tab(page, 'Roles & permissions').click();
  await choose(main(page).getByRole('combobox', { name: 'User role' }), roles.viewer.id);
  await expect(main(page).getByText('Can view this workspace.')).toBeVisible();
  await main(page).getByRole('button', { name: 'Save' }).click();

  await expect(page).toHaveURL(new RegExp(`${inHarbor('/settings/team')}$`));
  await expect(main(page).getByText('Rae Brooks was saved.')).toBeVisible();
  expect(bodiesOf(api, /^PUT \/users\//)).toEqual([
    {
      firstName: 'Rae',
      lastName: 'Brooks',
      phone: null,
      extension: null,
      avatarFileId: null,
      roleId: roles.viewer.id,
      calendarId: null,
      signature: {
        enabled: true,
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Rae', marks: [{ type: 'bold' }] }],
            },
          ],
        },
      },
    },
  ]);
  await expect(row(page, 'Rae Brooks').getByText('Account - viewer')).toBeVisible();
  await expect(row(page, 'Riley Brooks')).toHaveCount(0);

  // Oneself: the role stays, and the page says why.
  await row(page, 'Dana Brooks').getByRole('link', { name: 'Edit Dana Brooks' }).click();
  await expect(main(page).getByRole('textbox', { name: 'Phone', exact: true })).toHaveValue(
    '(305) 555-0123',
  );
  await expectChoice(main(page).getByRole('combobox', { name: 'Phone country' }), 'US');
  await tab(page, 'Roles & permissions').click();
  await expect(main(page).getByRole('combobox', { name: 'User role' })).toBeDisabled();
  await expect(main(page).getByText("You can't change your own role.")).toBeVisible();
  await expectAccessible(page);
  await main(page).getByRole('link', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/settings/team')}$`));
});

test('a refusal from the server is shown under the field it names', async ({ page }) => {
  const { api } = await harborUsers(page);
  await page.goto(inHarbor('/settings/team/new'));
  await expect(main(page).getByRole('textbox', { name: 'Phone', exact: true })).toBeVisible();
  await main(page).getByRole('textbox', { name: 'First name' }).fill('Riley');
  await main(page).getByRole('textbox', { name: 'Last name' }).fill('Again');
  await main(page)
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill('riley@harborlights.example');
  await main(page).getByRole('textbox', { name: 'Phone', exact: true }).fill('12345');
  await tab(page, 'Call & voicemail').click();
  await main(page).getByRole('button', { name: 'Save' }).click();
  // What the form itself knows is wrong is said first, on the tab that holds it.
  await expect(tab(page, 'User info')).toHaveAttribute('aria-selected', 'true');
  await expect(
    main(page).getByText('Enter a phone number of the country chosen, or leave it empty.'),
  ).toBeVisible();
  expect(bodiesOf(api, /^POST \/users$/)).toEqual([]);
  await main(page).getByRole('textbox', { name: 'Phone', exact: true }).fill('');
  await main(page).getByRole('button', { name: 'Save' }).click();
  await expect(
    main(page).getByText('This person is already on the team or has a pending invitation.'),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/settings/team/new')}$`));
  await expectAccessible(page);
});

test('removes a person only after asking', async ({ page }) => {
  const { api, riley } = await harborUsers(page);
  await page.goto(inHarbor('/settings/team'));
  const remove = row(page, 'Riley Brooks').getByRole('button', {
    name: 'Remove Riley Brooks from this account',
  });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove Riley Brooks?' });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  expect(api.sent).toEqual([]);

  await remove.click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(main(page).getByText('Riley Brooks was removed.')).toBeVisible();
  await expect(row(page, 'Riley Brooks')).toHaveCount(0);
  await expect(main(page).getByText('1 - 3 of 3')).toBeVisible();
  expect(api.sent.map((each) => each.call)).toEqual([`DELETE /team/members/${riley.id}`]);
});

test('resends an invitation at once, and revokes one after asking', async ({ page }) => {
  const { api, sam } = await harborUsers(page);
  await page.goto(inHarbor('/settings/team'));
  const invited = row(page, 'Sam Okoro');
  await invited.getByRole('button', { name: 'Resend the invitation to Sam Okoro' }).click();
  await expect(
    main(page).getByText('Invitation resent. The previous link no longer works.'),
  ).toBeVisible();
  expect(api.sent.map((each) => each.call)).toEqual([`POST /team/invitations/${sam.id}/resend`]);

  await invited.getByRole('button', { name: 'Revoke the invitation of Sam Okoro' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revoke the invitation of Sam Okoro?' });
  await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(main(page).getByText('Invitation revoked.')).toBeVisible();
  await expect(row(page, 'Sam Okoro')).toHaveCount(0);
  expect(api.sent.map((each) => each.call).at(-1)).toBe(`DELETE /team/invitations/${sam.id}`);
});

test('someone who may not manage users reads the list and a person, and changes nothing', async ({
  page,
}) => {
  const { api, riley } = await harborUsers(page, { canManage: false });
  await page.goto(inHarbor('/settings/team'));
  await expect(row(page, 'Riley Brooks')).toBeVisible();
  await expect(main(page).getByRole('link', { name: 'Add user' })).toHaveCount(0);
  await expect(main(page).getByRole('link', { name: /^Edit / })).toHaveCount(0);
  const actions = main(page)
    .getByRole('row')
    .getByRole('button', {
      name: /^(?:Edit|Remove|Revoke|Resend) /,
    });
  await expect(actions).toHaveCount(9);
  for (const button of await actions.all())
    await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(
    row(page, 'Riley Brooks').getByRole('button', { name: 'Edit Riley Brooks' }),
  ).toHaveAttribute('title', 'You need permission to manage users.');
  // A greyed action does nothing when pressed.
  await row(page, 'Riley Brooks')
    .getByRole('button', { name: 'Remove Riley Brooks from this account' })
    // Playwright waits for a button to be enabled; this one says it is not.
    .click({ force: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectAccessible(page);

  await page.goto(inHarbor(`/settings/team/${riley.id}`));
  await expect(main(page).getByRole('textbox', { name: 'First name' })).toBeDisabled();
  await expect(main(page).getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(main(page).getByText(/needs permission to manage users/)).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Next' })).toBeVisible();
  await expectAccessible(page);
  expect(api.sent).toEqual([]);
});

test('a person’s availability and calendars are on their own tabs of Edit user', async ({
  page,
}) => {
  const { api, riley } = await harborUsers(page);
  await page.goto(inHarbor(`/settings/team/${riley.id}`));
  await tab(page, 'User availability').click();
  const inherit = main(page).getByRole('switch', { name: "Use each calendar's hours" });
  await expect(inherit).toHaveAttribute('aria-checked', 'true');
  await expectAccessible(page);
  await inherit.click();
  await main(page).getByRole('button', { name: 'Add hours' }).click();
  const hours = main(page).getByRole('group', { name: 'Hours 1' });
  await choose(hours.getByRole('combobox', { name: 'Day' }), '3');
  await hours.getByLabel('Start time').fill('08:30');
  await hours.getByLabel('End time').fill('12:00');
  await main(page).getByRole('button', { name: 'Add hours' }).click();
  await main(page)
    .getByRole('group', { name: 'Hours 2' })
    .getByRole('checkbox', { name: 'Until midnight' })
    .check();
  await main(page).getByRole('combobox', { name: 'Time zone' }).fill('Africa/Nairobi');
  await expectAccessible(page);
  await main(page).getByRole('button', { name: 'Save availability' }).click();
  await expect(main(page).getByText('Availability saved.')).toBeVisible();
  expect(bodiesOf(api, /^PUT \/calendars\/users\//)).toEqual([
    {
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
      profile: {
        timezone: 'Africa/Nairobi',
        inheritCalendarHours: false,
        weeklyHours: [
          { weekday: 3, startMinute: 510, endMinute: 720 },
          { weekday: 1, startMinute: 540, endMinute: 1440 },
        ],
        dateOverrides: [],
      },
    },
  ]);
  // A second save goes out on the revision the first one gave back.
  await main(page).getByRole('button', { name: 'Remove hours 2' }).click();
  await main(page).getByRole('button', { name: 'Save availability' }).click();
  await expect.poll(() => bodiesOf(api, /^PUT \/calendars\/users\//).length).toBe(2);
  await expect(main(page).getByRole('alert')).toHaveCount(0);
  expect(api.availability.get(riley.id)?.weeklyHours).toEqual([
    { weekday: 3, startMinute: 510, endMinute: 720 },
  ]);
  // Saving hours never sends the person's own details.
  expect(bodiesOf(api, /^PUT \/users\//)).toEqual([]);

  await tab(page, 'Calendar configuration').click();
  const panel = page.getByRole('tabpanel', { name: 'Calendar configuration' });
  await expect(panel.getByText('Consultations')).toBeVisible();
  await expect(panel.getByText('Venue tours')).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Settings, Calendars' })).toHaveAttribute(
    'href',
    inHarbor('/settings/calendars'),
  );
  await expectAccessible(page);
});

test('the agency’s own team is on the same pages, with no calendar to choose', async ({ page }) => {
  await signedIn(page, dana, {}, agencyStaff);
  const roles = builtinRoles();
  const me = memberOf('Dana Brooks', roles.owner, {
    userType: 'agency',
    isSelf: true,
    canRemove: false,
  });
  const noor = memberOf('Noor Haddad', roles.member, { userType: 'agency' });
  const api = await fakeUsersApi(page, {
    people: [me, noor],
    roles: [roles.admin, roles.member, roles.owner],
    workspace: null,
  });
  await page.goto('/agency/settings/team');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await expect(row(page, 'Noor Haddad').getByText('Agency - member')).toBeVisible();
  await expect(
    row(page, 'Noor Haddad').getByRole('button', { name: 'Remove Noor Haddad from the agency' }),
  ).toBeVisible();
  await main(page).getByRole('combobox', { name: 'User role' }).click();
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
    'All',
    'Admin',
    'Member',
    'Owner',
  ]);
  await page.keyboard.press('Escape');
  await expectAccessible(page);

  await main(page).getByRole('link', { name: 'Add user' }).click();
  await expect(page).toHaveURL(/\/agency\/settings\/team\/new$/);
  await expect(main(page).getByRole('textbox', { name: 'Phone', exact: true })).toBeVisible();
  await expect(main(page).getByRole('combobox', { name: 'Calendar', exact: true })).toHaveCount(0);
  await main(page).getByRole('textbox', { name: 'First name' }).fill('Lee');
  await main(page).getByRole('textbox', { name: 'Last name' }).fill('Park');
  await main(page)
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill('lee@bluebird.example');
  await tab(page, 'User availability').click();
  await expect(main(page).getByText(/Availability is set business by business/)).toBeVisible();
  await expectAccessible(page);
  await main(page).getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/agency\/settings\/team$/);
  const added = row(page, 'Lee Park');
  await expect(added.getByText('Agency - member')).toBeVisible();
  await expect(added.getByText('Invited', { exact: true })).toBeVisible();
  expect(bodiesOf(api, /^POST \/users$/)).toEqual([
    expect.objectContaining({ email: 'lee@bluebird.example', calendarId: null }),
  ]);

  await row(page, 'Noor Haddad').getByRole('link', { name: 'Edit Noor Haddad' }).click();
  await expect(page).toHaveURL(new RegExp(`/agency/settings/team/${noor.id}$`));
  await expect(main(page).getByRole('textbox', { name: 'First name' })).toHaveValue('Noor');
});
