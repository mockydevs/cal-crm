// Email verification against the built dashboard, with the API stood in for: an email row's
// status on the contact page and what it means, the row's menu (Verify, Exclude, Block and
// Unblock, with the typed hard-bounce confirmation), and Settings → Email Services → Email
// Verification with its provider; on the contact list, the bulk "Verify emails" with what it
// would do, the Email verification filter and column; and the workflow builder's Email
// verification step. The real server is exercised by @repo/e2e.
import AxeBuilder from '@axe-core/playwright';
import { parseContactFilter } from '@repo/contracts';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { openBuilder, world } from './automation-api';
import { harborSetup } from './automation-fixtures';
import { bulkActionOf } from './contact-bulk-fixtures';
import {
  contactDetailsApi,
  detailsFor,
  emptyContactPanels,
  type DetailsApi,
} from './contact-panels';
import {
  addressOf,
  emailCheckPreviewOf,
  blockedFor,
  blockIn,
  checked,
  connectIn,
  contactAddressesIn,
  disconnectIn,
  excludeIn,
  isRefusal,
  settingsIn,
  testIn,
  unblockIn,
  unchecked,
  updateSettingsIn,
  verificationWorldOf,
  verifiedAt,
  verifiedContactId,
  verifyIn,
  workingKey,
  type VerificationWorld,
} from './email-verification-fixtures';
import { openManageFields } from './lists';
import { choose } from './select';
import { harbor, inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';

const dana = { id: 'mem_01k8e2wzr0e008000000000301', name: 'Dana Brooks', you: true };

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const noPageScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

function answer(route: Route, value: unknown): Promise<void> {
  if (isRefusal(value)) {
    const { refusal: _refusal, ...problem } = value;
    return route.fulfill({
      status: problem.status,
      contentType: 'application/problem+json',
      json: { type: 'about:blank', title: 'Refused', ...problem },
    });
  }
  return route.fulfill({ json: value });
}

/**
 * Stands in for the email verification endpoints of one business, and keeps the contact's
 * details in step with them: the details hold each address's delivery and verification.
 */
async function fakeVerificationApi(
  page: Page,
  world: VerificationWorld,
  onChange: () => void = () => undefined,
): Promise<void> {
  await page.route('**/api/v1/me/permissions', (route) =>
    route.fulfill({
      json: {
        business: route.request().headers()['business-id'] ?? null,
        permissions: world.permissions,
      },
    }),
  );
  await page.route(/\/api\/v1\/email-verification\/.+$/, async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const path = new URL(request.url()).pathname.replace('/api/v1/email-verification/', '');
    const method = request.method();
    const body: unknown = request.postData() === null ? undefined : request.postDataJSON();
    const answers: Record<string, (() => unknown) | undefined> = {
      'GET settings': () => settingsIn(world),
      'PUT settings': () => updateSettingsIn(world, body),
      'PUT provider': () => connectIn(world, body),
      'DELETE provider': () => disconnectIn(world),
      'POST provider/test': () => testIn(world),
      'POST verify': () => verifyIn(world, body),
      'POST exclude': () => excludeIn(world, body, true),
      'POST include': () => excludeIn(world, body, false),
      'POST block': () => blockIn(world, body),
      'POST unblock': () => unblockIn(world, body),
    };
    const found = answers[`${method} ${path}`];
    if (found === undefined) throw new Error(`Unexpected ${method} ${path}`);
    const value = found();
    onChange();
    await answer(route, value);
  });
}

/** The contact page of one contact whose emails the world holds. */
async function contactWith(page: Page, world: VerificationWorld): Promise<DetailsApi> {
  await signedIn(page);
  await emptyContactPanels(page);
  const contact = {
    id: verifiedContactId,
    emails: world.addresses.map((each) => each.value),
    phones: [],
    createdAt: verifiedAt,
    canManage: world.permissions.includes('contacts.manage'),
  };
  await page.route(`**/api/v1/contacts/${verifiedContactId}`, (route) =>
    route.fulfill({
      json: {
        id: verifiedContactId,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: 'Maya Thompson',
        emails: contact.emails,
        phones: [],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        createdAt: verifiedAt,
        updatedAt: verifiedAt,
        trashedAt: null,
        canManage: contact.canManage,
      },
    }),
  );
  await page.route(`**/api/v1/contacts/${verifiedContactId}/deals`, (route) =>
    route.fulfill({ json: { items: [], more: false, canManage: contact.canManage } }),
  );
  await page.route(`**/api/v1/records/${verifiedContactId}/tags`, (route) =>
    route.fulfill({ json: { items: [], canManage: contact.canManage } }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
  const details = await contactDetailsApi(
    page,
    detailsFor(contact, { addresses: contactAddressesIn(world) }),
    [dana],
  );
  await fakeVerificationApi(page, world, () => {
    details.details = { ...details.details, addresses: contactAddressesIn(world) };
  });
  return details;
}

const fieldsOf = (page: Page) => page.getByRole('region', { name: 'Fields', exact: true });
const badge = (page: Page, label: string, address: string) =>
  fieldsOf(page).getByRole('button', { name: `${label}: what this means for ${address}` });

for (const width of [1440, 360]) {
  test(`shows an email's verification and verifies, excludes and blocks it at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const world = verificationWorldOf({
      addresses: [
        addressOf(1, 'maya@example.com', checked('risky', { reasons: ['catch_all', 'role'] })),
        addressOf(2, 'maya.t@example.com', unchecked()),
      ],
    });
    const details = await contactWith(page, world);
    await page.goto(inHarbor(`/contacts/${verifiedContactId}`));

    const risky = badge(page, 'Risky', 'maya@example.com');
    await expect(risky).toHaveText('Risky');
    await expect(badge(page, 'Not verified', 'maya.t@example.com')).toHaveText('Not verified');
    await risky.click();
    const meaning = page.getByRole('dialog', { name: 'Risky' });
    await expect(
      meaning.getByText('Emails are still sent to it, but they may not arrive.'),
    ).toBeVisible();
    await expect(meaning.getByRole('list', { name: 'Why' })).toHaveText(
      "Its domain accepts mail for any address, so this mailbox can't be confirmed.",
    );
    await expect(meaning.getByText('Good to know')).toBeVisible();
    await expectNoViolations(page);
    await page.keyboard.press('Escape');
    await expect(risky).toBeFocused();

    const menuOf = (address: string) =>
      fieldsOf(page).getByRole('button', { name: `Email verification for ${address}` });
    // Big enough for a finger below the desktop layout.
    if (width === 360)
      expect((await menuOf('maya.t@example.com').boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await menuOf('maya.t@example.com').click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Verify email',
      'Exclude from email verification',
      'Block email',
    ]);
    await expectNoViolations(page);
    await menu.getByRole('menuitem', { name: 'Verify email' }).click();
    await expect(
      fieldsOf(page).getByText(
        "Checking maya.t@example.com. The result shows here once it's done.",
      ),
    ).toBeVisible();
    // The check finishes on the server; the row reads the details again by itself.
    const [, second] = world.addresses;
    if (second !== undefined) second.verification = checked('valid');
    details.details = { ...details.details, addresses: contactAddressesIn(world) };
    await expect(badge(page, 'Verified', 'maya.t@example.com')).toBeVisible({ timeout: 15_000 });
    await expect(
      fieldsOf(page).getByText('The check of maya.t@example.com is done.'),
    ).toBeVisible();

    await menuOf('maya@example.com').click();
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: 'Exclude from email verification' })
      .click();
    await expect(badge(page, 'Excluded', 'maya@example.com')).toBeVisible();
    await menuOf('maya@example.com').click();
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([
      'Include in email verification',
      'Block email',
    ]);
    await page.getByRole('menu').getByRole('menuitem', { name: 'Block email' }).click();
    const block = page.getByRole('dialog', { name: 'Block maya@example.com?' });
    await block.getByRole('textbox', { name: 'Reason (optional)' }).fill('Asked us to stop');
    await expectNoViolations(page);
    await block.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(block).toBeHidden();
    await expect(menuOf('maya@example.com')).toBeFocused();
    await expect(badge(page, 'Blocked', 'maya@example.com')).toBeVisible();
    await expect(
      fieldsOf(page).getByText('maya@example.com is blocked. No email is sent to it.'),
    ).toBeVisible();
    expect(await noPageScroll(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`email-verification-contact-${String(width)}.png`),
      fullPage: true,
    });

    await menuOf('maya@example.com').click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Unblock' }).click();
    await expect(badge(page, 'Excluded', 'maya@example.com')).toBeVisible();
    const ids = (number: number) => ({
      contactId: verifiedContactId,
      addressId: world.addresses[number]?.id,
    });
    expect(world.writes).toEqual([
      { operationId: 'verifyEmailAddress', body: ids(1) },
      { operationId: 'excludeEmailAddress', body: ids(0) },
      { operationId: 'blockEmailAddress', body: { ...ids(0), reason: 'Asked us to stop' } },
      { operationId: 'unblockEmailAddress', body: ids(0) },
    ]);
  });
}

test('unblocks a hard bounce once "unblock" is typed, and explains an unsubscribe', async ({
  page,
}) => {
  const world = verificationWorldOf({
    addresses: [
      addressOf(1, 'maya@example.com', checked('invalid'), blockedFor('hard_bounce')),
      addressOf(2, 'old@example.com', checked('valid'), blockedFor('unsubscribe')),
    ],
  });
  await contactWith(page, world);
  await page.goto(inHarbor(`/contacts/${verifiedContactId}`));
  await badge(page, 'Blocked', 'maya@example.com').click();
  await expect(
    page.getByText("An email to it bounced: the mailbox doesn't take mail."),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await fieldsOf(page)
    .getByRole('button', { name: 'Email verification for maya@example.com' })
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Unblock' }).click();
  const dialog = page.getByRole('dialog', { name: 'Unblock maya@example.com?' });
  const confirm = dialog.getByRole('button', { name: 'Unblock', exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Type unblock to confirm' }).fill('unblock');
  await expectNoViolations(page);
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(badge(page, 'Invalid', 'maya@example.com')).toBeVisible();

  await fieldsOf(page)
    .getByRole('button', { name: 'Email verification for old@example.com' })
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: "Why it can't be unblocked" }).click();
  const why = page.getByRole('dialog', { name: "old@example.com can't be unblocked here" });
  await expect(why).toContainText('They unsubscribed from your email.');
  await expectNoViolations(page);
  await page.keyboard.press('Escape');
  await expect(why).toBeHidden();
  expect(world.writes).toEqual([
    {
      operationId: 'unblockEmailAddress',
      body: {
        contactId: verifiedContactId,
        addressId: world.addresses[0]?.id,
        confirm: 'unblock',
      },
    },
  ]);
});

test('reads the status, with no menu, for someone who may not change the contact', async ({
  page,
}) => {
  const world = verificationWorldOf({
    permissions: [],
    addresses: [addressOf(1, 'maya@example.com', checked('valid'))],
  });
  await contactWith(page, world);
  await page.goto(inHarbor(`/contacts/${verifiedContactId}`));
  await expect(badge(page, 'Verified', 'maya@example.com')).toBeVisible();
  await expect(fieldsOf(page).getByRole('button', { name: /^Email verification for/ })).toHaveCount(
    0,
  );
});

async function emailServices(page: Page, world: VerificationWorld): Promise<void> {
  await signedIn(page);
  await page.route('**/api/v1/mailboxes', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/v1/email-campaign-settings', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      json: { type: 'about:blank', title: 'Forbidden', status: 403 },
    }),
  );
  await fakeVerificationApi(page, world);
}

for (const width of [1440, 360]) {
  test(`connects Emailable and sets verification in Settings → Email Services at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const world = verificationWorldOf();
    await emailServices(page, world);
    await page.goto(inHarbor('/settings/email'));
    const section = page.getByRole('region', { name: 'Email Verification' });
    await expect(
      section.getByText('Mailbox checks need a verification provider. Domain checks still run.'),
    ).toBeVisible();
    await expectNoViolations(page);

    await section.getByRole('button', { name: 'Connect Emailable' }).click();
    const key = section.getByLabel('Emailable API key');
    await expect(key).toBeFocused();
    await key.fill('test_not_a_working_key');
    await section.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(section.getByRole('alert')).toHaveText(
      'The verification provider could not confirm this key.',
    );
    await key.fill(workingKey);
    await section.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(section.getByText('Emailable connected')).toBeVisible();
    await expect(section.getByText('4,800 credits left.')).toBeVisible();
    await expect(section.getByText('Test mode', { exact: true })).toBeVisible();

    const form = section.getByRole('form', { name: 'Verification settings' });
    await form.getByRole('checkbox', { name: 'Re-verify results older than 90 days' }).uncheck();
    await form.getByRole('textbox', { name: 'Daily verification limit' }).fill('250');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByText('Email verification saved.')).toBeVisible();
    await expect(
      form.getByRole('checkbox', { name: 'Re-verify results older than 90 days' }),
    ).not.toBeChecked();

    await section.getByRole('button', { name: 'Test connection' }).click();
    await expect(
      section.getByText('Testing the connection. Its credits and status update here in a moment.'),
    ).toBeVisible();
    await expectNoViolations(page);
    expect(await noPageScroll(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`email-verification-settings-${String(width)}.png`),
      fullPage: true,
    });

    const disconnect = section.getByRole('button', { name: 'Disconnect' });
    await disconnect.click();
    const dialog = page.getByRole('dialog', { name: 'Disconnect Emailable?' });
    await expectNoViolations(page);
    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      section.getByText('Emailable is disconnected. Only domains are checked now.'),
    ).toBeVisible();
    expect(world.writes.map((each) => each.operationId)).toEqual([
      'connectEmailVerificationProvider',
      'connectEmailVerificationProvider',
      'updateEmailVerificationSettings',
      'testEmailVerificationProvider',
      'disconnectEmailVerificationProvider',
    ]);
    expect(world.writes[2]?.body).toEqual({
      enabled: true,
      reverifyAfter90Days: false,
      dailyLimit: 250,
    });
    // The key went to the server only, and is not on the page any more.
    await expect(page.getByLabel('Emailable API key')).toHaveCount(0);
  });
}

test('leaves Email Verification out of Settings for someone who may not manage it', async ({
  page,
}) => {
  const world = verificationWorldOf({ permissions: ['contacts.manage'] });
  await emailServices(page, world);
  await page.goto(inHarbor('/settings/email'));
  await expect(page.getByRole('heading', { level: 1, name: 'Email Services' })).toBeVisible();
  await expect(
    page.getByText('No mailboxes connected yet. Add a mailbox to get started.'),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Email Verification' })).toHaveCount(0);
});

// The contact list, with each contact's primary email and what verification found of it.
const listed = [
  { number: 1, name: 'Maya Thompson', email: 'maya@example.com', state: 'valid' },
  { number: 2, name: 'Theo Varga', email: 'theo@example.com', state: 'invalid' },
  { number: 3, name: 'Ana Ruiz', email: null, state: null },
] as const;
const listedId = (number: number): string =>
  `con_01k8e2wzr0e00800000000${String(number + 400).padStart(4, '0')}`;

interface ListApi {
  /** Each list read: its query. */
  readonly lists: URLSearchParams[];
  /** Each count: its query. */
  readonly counts: URLSearchParams[];
  /** Each preview and each bulk action asked for: its body. */
  readonly previews: unknown[];
  readonly bulk: unknown[];
}

/** The condition a list's filter parameter holds, read the way the server reads it. */
function verificationCondition(
  text: string,
): { operator: string; values: readonly string[] } | undefined {
  const [group] = parseContactFilter(text)?.groups ?? [];
  const [condition] = group?.conditions ?? [];
  return condition?.field === 'emailVerification'
    ? { operator: condition.operator, values: condition.values ?? [] }
    : undefined;
}

/** The contacts list of one business, its count, the preview of a check, and bulk actions. */
async function contactList(page: Page, preview = emailCheckPreviewOf()): Promise<ListApi> {
  const api: ListApi = { lists: [], counts: [], previews: [], bulk: [] };
  await signedIn(page);
  await emptyContactPanels(page);
  await page.route('**/api/v1/me/permissions', (route) =>
    route.fulfill({ json: { business: harbor.id, permissions: ['contacts.manage'] } }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
  /** The contacts the list's filter keeps: only the one condition the page writes. */
  const kept = (query: URLSearchParams) => {
    const text = query.get('filter');
    const condition = text === null ? undefined : verificationCondition(text);
    return listed.filter((each) => {
      if (condition === undefined) return true;
      if (condition.operator === 'is_empty') return each.state === null;
      if (condition.operator === 'is_not_empty') return each.state !== null;
      const holds = each.state !== null && condition.values.includes(each.state);
      return condition.operator === 'any_of' ? holds : !holds;
    });
  };
  await page.route('**/api/v1/contacts/count**', (route) => {
    const query = new URL(route.request().url()).searchParams;
    api.counts.push(query);
    return route.fulfill({ json: { count: kept(query).length, exact: true } });
  });
  await page.route(/\/api\/v1\/contacts(?:\?.*)?$/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    api.lists.push(query);
    const include = (query.get('include') ?? '').split(',');
    return route.fulfill({
      json: {
        canManage: true,
        next: null,
        items: kept(query).map((each) => ({
          id: listedId(each.number),
          name: each.name,
          email: each.email,
          phone: null,
          createdAt: verifiedAt,
          ...(include.includes('emailVerification') ? { emailVerification: each.state } : {}),
        })),
      },
    });
  });
  await page.route('**/api/v1/contacts/bulk/verify-emails/preview', (route) => {
    api.previews.push(route.request().postDataJSON());
    return route.fulfill({ json: preview });
  });
  await page.route(/\/api\/v1\/contacts\/bulk$/, (route) => {
    api.bulk.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: bulkActionOf(4, {
        action: 'verify_emails',
        status: 'queued',
        requested: 2,
        done: 0,
        skipped: 0,
        startedAt: null,
        finishedAt: null,
      }),
    });
  });
  return api;
}

const rows = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('link') });
const rowOf = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });

async function openVerifyEmails(page: Page): Promise<Locator> {
  await page
    .getByRole('group', { name: 'Bulk actions' })
    .getByRole('button', { name: 'More' })
    .click();
  await page.getByRole('menuitem', { name: 'Verify emails' }).click();
  return page.getByRole('dialog', { name: 'Verify emails' });
}

for (const width of [1440, 360]) {
  test(`verifies the selected contacts' emails after saying what it would do at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await contactList(page);
    await page.goto(inHarbor('/contacts'));
    await expect(rows(page)).toHaveCount(3);
    await page.getByRole('checkbox', { name: 'Select Maya Thompson' }).check();
    await page.getByRole('checkbox', { name: 'Select Theo Varga' }).check();
    const dialog = await openVerifyEmails(page);
    await expect(dialog.getByText('120 contacts in the selection.')).toBeVisible();
    await expect(
      dialog.getByText('30 already have a current result: kept as they are, at no cost.'),
    ).toBeVisible();
    await expect(
      dialog.getByText('70 will be checked, 60 of them using a provider credit.'),
    ).toBeVisible();
    await expect(dialog.getByText('20 skipped:')).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveText([
      '8 have no email address',
      '2 are excluded from email verification',
      "10 are over today's verification limit",
    ]);
    await expect(dialog.getByText('60 provider checks left today.')).toBeVisible();
    // The counts are of the same contacts the action is for.
    const selection = { ids: [listedId(1), listedId(2)] };
    expect(api.previews).toEqual([{ selection }]);
    await expectNoViolations(page);
    expect(await noPageScroll(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`email-verification-bulk-${String(width)}.png`),
      fullPage: true,
    });

    await dialog.getByRole('button', { name: 'Verify 2 contacts' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('status').filter({ hasText: 'Started in the background' }),
    ).toHaveText(/Started in the background for 2 contacts\./);
    expect(api.bulk).toEqual([
      {
        action: 'verify_emails',
        selection,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      },
    ]);
  });
}

test('says domain checks still run without a provider, and offers no Verify while verification is off', async ({
  page,
}) => {
  await contactList(
    page,
    emailCheckPreviewOf({ provider: null, providerCalls: 0, remainingToday: null, enabled: false }),
  );
  await page.goto(inHarbor('/contacts'));
  await page.getByRole('checkbox', { name: 'Select Maya Thompson' }).check();
  const dialog = await openVerifyEmails(page);
  await expect(
    dialog.getByText(
      'Email verification is off. Turn it on in Settings → Email Services → Email Verification.',
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText('Mailbox checks need a verification provider. Domain checks still run.'),
  ).toBeVisible();
  await expect(dialog.getByText(/checks left today/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Verify 1 contact' })).toBeDisabled();
  await expectNoViolations(page);
});

for (const width of [1440, 360]) {
  test(`filters the contact list by email verification and shows it as a column at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await contactList(page);
    await page.goto(inHarbor('/contacts'));
    await expect(rows(page)).toHaveCount(3);
    // A new list neither shows the column nor asks for it.
    await expect(page.getByRole('columnheader', { name: 'Email verification' })).toHaveCount(0);
    expect(
      api.lists.every((query) => !(query.get('include') ?? '').includes('emailVerification')),
    ).toBe(true);

    const fields = await openManageFields(page);
    await fields
      .getByRole('region', { name: 'Add fields' })
      .getByRole('checkbox', { name: 'Email verification', exact: true })
      .check();
    await fields.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('columnheader', { name: 'Email verification' })).toBeVisible();
    await expect.poll(() => api.lists.at(-1)?.get('include') ?? '').toContain('emailVerification');
    await expect(rowOf(page, 'Maya Thompson').getByText('Verified', { exact: true })).toBeVisible();
    await expect(rowOf(page, 'Theo Varga').getByText('Invalid', { exact: true })).toBeVisible();
    await expect(rowOf(page, 'Ana Ruiz').getByText('No email address')).toBeAttached();
    await expectNoViolations(page);

    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Filters' });
    const group = panel.locator('details').filter({
      has: page.getByText('Email verification', { exact: true }),
    });
    await expect(group.getByRole('checkbox')).toHaveCount(6);
    await group.getByRole('checkbox', { name: 'Invalid' }).check();
    await group.getByRole('checkbox', { name: 'Risky' }).check();
    await expectNoViolations(page);
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(rows(page)).toHaveCount(1);
    await expect(rowOf(page, 'Theo Varga')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filters (1)' })).toBeVisible();
    const sent = {
      match: 'all',
      groups: [
        {
          match: 'all',
          conditions: [
            { field: 'emailVerification', operator: 'any_of', values: ['risky', 'invalid'] },
          ],
        },
      ],
    };
    await expect.poll(() => api.lists.at(-1)?.get('filter')).toBe(JSON.stringify(sent));
    expect(api.counts.at(-1)?.get('filter')).toBe(JSON.stringify(sent));
    expect(await noPageScroll(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`email-verification-list-${String(width)}.png`),
      fullPage: true,
    });

    // Kept in the address: the list opens the same again.
    await page.reload();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Filters (1)' })).toBeVisible();

    // No email address is a filter too.
    await page.getByRole('button', { name: 'Filters (1)' }).click();
    await choose(panel.getByRole('combobox', { name: 'Email verification is' }), 'is_empty');
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(rowOf(page, 'Ana Ruiz')).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
  });
}

for (const width of [1440, 360]) {
  test(`adds an Email verification step last under Contact in the workflow builder at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = world();
    await openBuilder(page, state, 'canvas');
    await page
      .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
      .click();
    const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
    const contact = picker.getByRole('region').filter({ hasText: /^Contact/ });
    await expect(contact.getByRole('listitem').last()).toHaveText(/^Email verification/);
    await picker
      .getByRole('searchbox', { name: 'Search actions', exact: true })
      .fill('verification');
    await expectNoViolations(page);
    await picker.getByRole('button', { name: /^Email verification/ }).click();

    const form = page.getByRole('dialog', { name: 'Email verification', exact: true });
    await expect(form).toContainText("The contact's primary email address is the one checked.");
    const age = form.getByRole('spinbutton', {
      name: 'Reuse a result up to this many days old (optional)',
      exact: true,
    });
    await expect(age).toHaveValue('90');
    await age.fill('30');
    await expectNoViolations(page);
    await form.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(page.locator('[id^="automation-step-email_verify"]')).toContainText(
      'Email verification',
    );
  });
}

test('shows Email verification as unavailable, pointing to Settings, while verification is off', async ({
  page,
}) => {
  const state = world({ setup: { ...harborSetup, emailVerification: false } });
  await openBuilder(page, state, 'canvas');
  await page.getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
  await expect(picker.getByRole('button', { name: /^Email verification/ })).toHaveCount(0);
  await expect(picker).toContainText('Email verification');
  await expect(picker).toContainText(
    'Turn on email verification in Settings → Email Services → Email Verification to use this action.',
  );
  await expectNoViolations(page);
  expect(state.writes).toEqual([]);
});
