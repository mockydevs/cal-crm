import { choose } from './select';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';
import { bulkActionOf } from './contact-bulk-fixtures';
import { contactDetailsApi, detailsFor, emptyContactPanels } from './contact-panels';
import {
  columnsButton,
  filtersButton,
  openFilters,
  openManageFields,
  openSort,
  reachesRightGutter,
  savedViews,
  sortButton,
} from './lists';

// Adding, changing and trashing contacts, against the built dashboard with the API stood in
// for, so each answer the API can give is tried. The real server is exercised by
// @repo/e2e.

interface StoredContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  emails: string[];
  phones: { number: string; display: string }[];
  timeZone: string | null;
  doNotContact: boolean;
  preferencesRevision: string;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canManage: boolean;
  /** What the list also says of the contact when asked: see the API's `include`. */
  lastActivity?: { at: string; channel: string } | null;
  tags?: { id: string; name: string }[];
  company?: { id: string; name: string } | null;
}

interface Body {
  firstName?: string | null;
  lastName?: string | null;
  emails?: string[];
  phones?: string[];
}

// Ids the server made: the contract checks each wraps a UUIDv7.
const ids = [
  'con_01m4bd188ff82s0add91b7pz63',
  'con_01m4bd9fteedat3be9bqgx2047',
  'con_01m4bdmgqwfgatd5ch0pqddfxm',
] as const;
const at = '2026-10-08T12:00:00.000Z';

// TypeID's base32: changing an id's last two characters changes only the low, random bits
// of its UUIDv7, so each id here is valid too.
const base32 = '0123456789abcdefghjkmnpqrstvwxyz';
const idAt = (index: number) =>
  `con_01m4bd188ff82s0add91b7pz${base32.charAt(index >> 5)}${base32.charAt(index & 31)}`;

/** Blank is no value, as the server stores it. */
const valueOf = (text: string | null | undefined): string | null => {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

const stored = (id: string, body: Body, trashedAt: string | null = null): StoredContact => {
  const firstName = valueOf(body.firstName);
  const lastName = valueOf(body.lastName);
  return {
    id,
    firstName,
    lastName,
    name: valueOf([firstName, lastName].filter((part) => part !== null).join(' ')),
    emails: (body.emails ?? []).map((email) => email.trim().toLowerCase()),
    phones: (body.phones ?? []).map((phone) => ({
      number: `+254${phone.replace(/\D/g, '').replace(/^0/, '')}`,
      display: phone,
    })),
    timeZone: null,
    doNotContact: false,
    preferencesRevision: 'a'.repeat(64),
    trashedAt,
    createdAt: at,
    updatedAt: at,
    canManage: true,
  };
};

const maya = stored(ids[0], {
  firstName: 'Maya',
  lastName: 'Thompson',
  emails: ['maya@example.com'],
  phones: ['0712 345678'],
});

const problem = (status: number, title: string, errors?: unknown[]) => ({
  status,
  contentType: 'application/problem+json',
  body: JSON.stringify({ type: 'about:blank', title, status, ...(errors ? { errors } : {}) }),
});

/** How the list shows a contact, with what the request's `include` names. */
const summaryOf = (contact: StoredContact, include: readonly string[] = []) => ({
  id: contact.id,
  name: contact.name,
  email: contact.emails[0] ?? null,
  phone: contact.phones[0] ?? null,
  createdAt: contact.createdAt,
  ...(include.includes('lastActivity') ? { lastActivity: contact.lastActivity ?? null } : {}),
  ...(include.includes('tags') ? { tags: contact.tags ?? [] } : {}),
  ...(include.includes('company') ? { company: contact.company ?? null } : {}),
});

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/**
 * An API that keeps contacts in memory, refusing an email address another contact has as
 * the server does, and listing them 50 a page; `answer` can replace any reply. It records
 * each request, those that count the list apart in `counts`. `canAdd` is what the list
 * says about adding contacts. `counting` is how it counts the list: to the end, not at all
 * (an error), or up to a limit it says it stopped at.
 */
async function fakeApi(
  page: Page,
  contacts: StoredContact[],
  answer?: (route: Route) => Promise<boolean>,
  canAdd = true,
  counting: 'exact' | 'fails' | 'limited' = 'exact',
): Promise<{ sent: Sent[]; counts: Sent[] }> {
  const sent: Sent[] = [];
  const counts: Sent[] = [];
  /** The contacts a search keeps, as both the list and its count read them. */
  const matching = (query: URLSearchParams) => {
    const q = (query.get('q') ?? '').toLowerCase();
    return contacts.filter(
      (contact) =>
        contact.trashedAt === null &&
        ((contact.name ?? '').toLowerCase().includes(q) ||
          contact.emails.some((email) => email.includes(q))),
    );
  };
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
  // The zones a new contact can be given, in the Add Contact panel.
  // What the person may do here: the bulk action bar offers only what their role allows.
  await page.route('**/api/v1/me/permissions', (route) =>
    route.fulfill({
      json: {
        business: null,
        permissions: [
          'automations.manage',
          'campaigns.send',
          'contacts.export',
          'contacts.manage',
          'deals.manage',
          'tags.manage',
        ],
      },
    }),
  );
  await page.route('**/api/v1/time-zones', (route) =>
    route.fulfill({ json: { items: ['Africa/Nairobi', 'Europe/London', 'UTC'] } }),
  );
  await page.route(/\/api\/v1\/records\/con_[^/]+\/tags$/, (route) =>
    route.fulfill({ json: { items: [], canManage: canAdd } }),
  );
  await page.route(/\/api\/v1\/contacts(\/[^?]*)?(\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = request.postData() === null ? undefined : (request.postDataJSON() as Body);
    if (request.method() === 'GET' && path === '/contacts/count') {
      counts.push({ method: 'GET', path, query: url.searchParams, body });
      if (counting === 'fails') return route.fulfill(problem(500, 'Internal Server Error'));
      const count = matching(url.searchParams).length;
      return route.fulfill({
        json: counting === 'limited' ? { count: 10000, exact: false } : { count, exact: true },
      });
    }
    sent.push({ method: request.method(), path, query: url.searchParams, body });
    if (answer !== undefined && (await answer(route))) return;
    const [, , id, action] = path.split('/');
    if (request.method() === 'GET' && id === undefined) {
      const live = matching(url.searchParams);
      const include = (url.searchParams.get('include') ?? '').split(',');
      const ordered =
        url.searchParams.get('sort') === 'name'
          ? live.toSorted((a, b) => (a.name ?? '~').localeCompare(b.name ?? '~'))
          : live;
      const after = url.searchParams.get('after');
      const start = after === null ? 0 : ordered.findIndex((each) => each.id === after) + 1;
      const items = ordered.slice(start, start + 50);
      return route.fulfill({
        json: {
          items: items.map((item) => summaryOf(item, include)),
          next: start + 50 < ordered.length ? (items.at(-1)?.id ?? null) : null,
          canManage: canAdd,
        },
      });
    }
    const found = contacts.find((contact) => contact.id === id);
    const duplicate = (emails: string[] | undefined, self?: string) =>
      (emails ?? []).flatMap((email, index) => {
        const holder = contacts.find(
          (contact) => contact.id !== self && contact.emails.includes(email.trim().toLowerCase()),
        );
        return holder === undefined
          ? []
          : [
              {
                path: `/emails/${String(index)}`,
                code: 'taken',
                message:
                  holder.trashedAt === null
                    ? 'Another contact has this email address.'
                    : 'A contact in the trash has this email address. Restore it instead.',
                existing: { id: holder.id, name: holder.name, trashed: holder.trashedAt !== null },
              },
            ];
      });
    if (request.method() === 'POST' && id === undefined) {
      const issues = duplicate(body?.emails);
      if (issues.length > 0) return route.fulfill(problem(422, 'Unprocessable Content', issues));
      const created = stored(ids[contacts.length] ?? ids[2], body ?? {});
      contacts.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (found === undefined) return route.fulfill(problem(404, 'Not Found'));
    if (request.method() === 'PATCH') {
      const issues = duplicate(body?.emails, found.id);
      if (issues.length > 0) return route.fulfill(problem(422, 'Unprocessable Content', issues));
      Object.assign(found, stored(found.id, { ...found, ...body, phones: body?.phones ?? [] }));
    }
    if (request.method() === 'DELETE') found.trashedAt = at;
    if (action === 'restore') found.trashedAt = null;
    return route.fulfill({ json: found });
  });
  await emptyContactPanels(page);
  return { sent, counts };
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

/** The panel that slides in over the list to add a contact. */
const adding = (page: Page) => page.getByRole('dialog', { name: 'Add Contact', exact: true });
const addContact = (page: Page) => page.getByRole('button', { name: 'Add contact', exact: true });
const savePanel = (page: Page) => adding(page).getByRole('button', { name: 'Save', exact: true });

const fitsTheWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** The page's own status line, not a panel's: each panel, such as Notes, has its own. */
const pageStatus = (page: Page) => page.locator('[role="status"]:not(section [role="status"])');

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('adds a contact in a panel over the list, and says so with the way to it', async ({
    page,
  }) => {
    const contacts: StoredContact[] = [];
    const { sent } = await fakeApi(page, contacts);
    await page.goto(inHarbor('/contacts'));

    await addContact(page).click();
    await expect(page).toHaveURL(inHarbor('/contacts?add=contact'));
    const panel = adding(page);
    await expect(panel.getByLabel('First name')).toBeFocused();
    await expectNoAccessibilityViolations(page);
    // Nothing GoHighLevel's panel has that this server does not keep.
    for (const absent of ['Contact image', 'Contact type', 'Customize form'])
      await expect(panel.getByText(absent)).toHaveCount(0);
    // Nothing to save until there is a first name.
    await expect(savePanel(page)).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: 'Save and add another', exact: true }),
    ).toBeDisabled();
    await panel.getByLabel('First name').fill('Maya');
    await panel.getByLabel('Last name').fill('Thompson');
    await panel.getByLabel('Email 1', { exact: true }).fill(' Maya@Example.com ');
    await panel.getByRole('button', { name: 'Add email', exact: true }).click();
    await panel.getByLabel('Email 2', { exact: true }).fill('maya.work@example.com');
    await panel.getByLabel('Phone 1', { exact: true }).fill('0712 345678');
    await savePanel(page).click();

    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/contacts'));
    await expect(addContact(page)).toBeFocused();
    await expect(pageStatus(page).filter({ hasText: 'Maya Thompson added.' })).toBeVisible();
    // The list is read again, with the new contact in it.
    await expect(contactRows(page)).toHaveCount(1);
    expect(sent.find((request) => request.method === 'POST')?.body).toEqual({
      firstName: 'Maya',
      lastName: 'Thompson',
      // An email field drops surrounding spaces itself (HTML's value sanitization).
      emails: ['Maya@Example.com', 'maya.work@example.com'],
      phones: ['0712 345678'],
    });
    await expectNoAccessibilityViolations(page);

    await page.getByRole('link', { name: 'Open contact', exact: true }).click();
    await expect(page).toHaveURL(inHarbor(`/contacts/${ids[0]}`));
    await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'maya@example.com' })).toHaveAttribute(
      'href',
      'mailto:maya@example.com',
    );
    await expect(page.getByRole('link', { name: '0712 345678' })).toHaveAttribute(
      'href',
      'tel:+254712345678',
    );
    // Back goes to the list, not to a panel already sent.
    await page.goBack();
    await expect(page).toHaveURL(inHarbor('/contacts'));
    await expect(adding(page)).toHaveCount(0);
  });

  test('saves and adds another: the panel stays, empty, and says what it added', async ({
    page,
  }) => {
    const contacts: StoredContact[] = [];
    await fakeApi(page, contacts);
    await page.goto(inHarbor('/contacts'));
    await addContact(page).click();
    const panel = adding(page);
    await panel.getByLabel('First name').fill('Maya');
    await panel.getByLabel('Email 1', { exact: true }).fill('maya@example.com');
    await panel.getByRole('button', { name: 'Save and add another', exact: true }).click();

    await expect(panel.getByRole('status')).toHaveText('Maya added.');
    await expect(panel.getByLabel('First name')).toHaveValue('');
    await expect(panel.getByLabel('First name')).toBeFocused();
    await expect(panel.getByLabel('Email 1', { exact: true })).toHaveValue('');
    // An emptied panel does not complain yet about the name it has not been given.
    await expect(panel.getByText('This field is required')).toHaveCount(0);
    await panel.getByLabel('First name').fill('Dana');
    await savePanel(page).click();
    await expect(panel).toBeHidden();
    await expect(contactRows(page)).toHaveCount(2);
    expect(contacts.map((contact) => contact.name)).toEqual(['Maya', 'Dana']);
  });

  test('sets the primary, a phone label, the time zone and do not disturb on the new contact', async ({
    page,
  }) => {
    const contacts: StoredContact[] = [];
    const { sent } = await fakeApi(page, contacts);
    // The details the new contact will have, once it is made: its two numbers in the order sent.
    const details = await contactDetailsApi(
      page,
      detailsFor({
        id: ids[0],
        emails: ['maya.work@example.com', 'maya@example.com'],
        phones: [
          { number: '+254733000111', display: '0733 000111' },
          { number: '+254712345678', display: '0712 345678' },
        ],
        createdAt: at,
        canManage: true,
      }),
      [],
    );
    await page.goto(inHarbor('/contacts'));
    await addContact(page).click();
    const panel = adding(page);
    await panel.getByLabel('First name').fill('Maya');
    await panel.getByLabel('Email 1', { exact: true }).fill('maya@example.com');
    await panel.getByRole('button', { name: 'Add email', exact: true }).click();
    await panel.getByLabel('Email 2', { exact: true }).fill('maya.work@example.com');
    await panel.getByRole('radio', { name: 'Email 2 is the primary', exact: true }).check();
    // A third row, added and then taken away again.
    await panel.getByRole('button', { name: 'Add email', exact: true }).click();
    await panel.getByRole('button', { name: 'Remove email 3', exact: true }).click();
    await expect(panel.getByLabel('Email 3', { exact: true })).toHaveCount(0);

    await panel.getByLabel('Phone 1', { exact: true }).fill('0712 345678');
    await choose(panel.getByRole('combobox', { name: 'Label for phone 1', exact: true }), 'mobile');
    await panel.getByRole('button', { name: 'Add phone', exact: true }).click();
    await panel.getByLabel('Phone 2', { exact: true }).fill('0733 000111');
    await panel.getByRole('radio', { name: 'Phone 2 is the primary', exact: true }).check();
    // A contact uses each label once: the second number cannot be "Mobile" too.
    await panel.getByRole('combobox', { name: 'Label for phone 2', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Mobile', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');

    await panel.getByRole('combobox', { name: 'Time zone' }).fill('Nairobi');
    await page.getByRole('option', { name: /Nairobi/ }).click();

    await panel.getByRole('checkbox', { name: 'Text messages', exact: true }).check();
    // Why is asked as soon as a switch is on, and Save waits for it.
    await expect(savePanel(page)).toBeDisabled();
    await panel.getByLabel('Reason').fill('Asked by phone to get no more text messages.');
    await expectNoAccessibilityViolations(page);
    await savePanel(page).click();

    await expect(pageStatus(page).filter({ hasText: 'Maya added.' })).toBeVisible();
    expect(sent.find((request) => request.method === 'POST')?.body).toEqual({
      firstName: 'Maya',
      lastName: '',
      emails: ['maya.work@example.com', 'maya@example.com'],
      phones: ['0733 000111', '0712 345678'],
    });
    expect(sent.find((request) => request.method === 'PATCH')?.body).toEqual({
      timeZone: 'Africa/Nairobi',
      preferencesRevision: 'a'.repeat(64),
    });
    expect(details.sent).toEqual([
      {
        method: 'PATCH',
        path: `/addresses/${details.details.addresses[3]?.id ?? ''}`,
        body: { label: 'mobile', revision: 'a'.repeat(64) },
      },
      {
        method: 'PUT',
        path: '/dnd',
        body: {
          all: false,
          channels: ['sms'],
          reason: 'Asked by phone to get no more text messages.',
          revision: 'a'.repeat(64),
        },
      },
    ]);
  });

  test('says what was not saved when the contact was made but a setting was refused', async ({
    page,
  }) => {
    await fakeApi(page, []);
    await page.route(new RegExp(`/api/v1/contacts/${ids[0]}/dnd$`), (route) =>
      route.fulfill(problem(500, 'Internal Server Error')),
    );
    await page.goto(inHarbor('/contacts?add=contact'));
    const panel = adding(page);
    await panel.getByLabel('First name').fill('Maya');
    await panel.getByRole('checkbox', { name: 'DND all channels', exact: true }).check();
    // "All channels" stands for each of them.
    await expect(panel.getByRole('checkbox', { name: 'Email', exact: true })).toBeDisabled();
    await panel.getByLabel('Reason').fill('Asked not to be contacted at all.');
    await savePanel(page).click();
    await expect(
      pageStatus(page).filter({
        hasText:
          "Maya was added, but this wasn't saved: do not disturb. Open the contact to set it.",
      }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open contact', exact: true })).toBeVisible();
  });

  test('asks for a first name once the field is left, and checks the rest before sending', async ({
    page,
  }) => {
    const { sent } = await fakeApi(page, []);
    // The address the new-contact page had opens the list with the panel.
    await page.goto(inHarbor('/contacts/new'));
    await expect(page).toHaveURL(inHarbor('/contacts?add=contact'));
    const panel = adding(page);
    const firstName = panel.getByLabel('First name');
    await expect(firstName).toBeFocused();
    // Not before the field has been touched.
    await expect(panel.getByText('This field is required')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(panel.getByText('This field is required', { exact: true })).toBeVisible();
    await expect(firstName).toHaveAttribute('aria-invalid', 'true');
    await expect(savePanel(page)).toBeDisabled();
    await expectNoAccessibilityViolations(page);
    await firstName.fill('Maya');
    await expect(panel.getByText('This field is required')).toHaveCount(0);

    await panel.getByLabel('Email 1', { exact: true }).fill('not an address');
    await savePanel(page).click();
    await expect(panel.getByLabel('Email 1', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(
      panel.getByText('Enter an email address, such as maya@example.com.'),
    ).toBeVisible();
    expect(sent.filter((request) => request.method === 'POST')).toEqual([]);

    // The panel is in the address: a reload opens it again, and closing gives the list back.
    await page.reload();
    await expect(adding(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(adding(page)).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/contacts'));
  });

  test('links a duplicate email address to the contact that has it', async ({ page }) => {
    await fakeApi(page, [structuredClone(maya)]);
    await page.goto(inHarbor('/contacts?add=contact'));

    const panel = adding(page);
    await panel.getByLabel('First name').fill('Someone');
    await panel.getByLabel('Email 1', { exact: true }).fill('other@example.com');
    await panel.getByRole('button', { name: 'Add email', exact: true }).click();
    await panel.getByLabel('Email 2', { exact: true }).fill('MAYA@example.com');
    await savePanel(page).click();

    await expect(panel.getByLabel('Email 2', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(panel.getByLabel('Email 1', { exact: true })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page.getByText('Another contact has this email address.')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.getByRole('link', { name: 'Open Maya Thompson' }).click();
    await expect(page).toHaveURL(inHarbor(`/contacts/${maya.id}`));
    await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
  });

  test('offers to restore the contact in the trash that has the email address', async ({
    page,
  }) => {
    const { sent } = await fakeApi(page, [{ ...structuredClone(maya), trashedAt: at }]);
    await page.goto(inHarbor('/contacts?add=contact'));

    await adding(page).getByLabel('First name').fill('Maya');
    await adding(page).getByLabel('Email 1', { exact: true }).fill('maya@example.com');
    await savePanel(page).click();
    await expect(
      page.getByText('A contact in the trash has this email address. Restore it instead.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Restore Maya Thompson' }).click();

    await expect(page).toHaveURL(inHarbor(`/contacts/${maya.id}`));
    await expect(page.getByText('This contact is in the trash.')).toBeHidden();
    expect(sent).toContainEqual(
      expect.objectContaining({ method: 'POST', path: `/contacts/${maya.id}/restore` }),
    );
  });

  test('changes a contact, keeping what it had', async ({ page }) => {
    const { sent } = await fakeApi(page, [structuredClone(maya)]);
    await page.goto(inHarbor(`/contacts/${maya.id}`));

    await page.getByRole('link', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Edit Maya Thompson' })).toBeVisible();
    await expect(page.getByLabel('Email address 1', { exact: true })).toHaveValue(
      'maya@example.com',
    );
    await expect(page.getByLabel('Phone number 1', { exact: true })).toHaveValue('0712 345678');
    await page.getByLabel('Last name').fill('Okafor');
    await page.getByRole('button', { name: 'Remove phone number 1' }).click();
    await expect(page.getByRole('button', { name: 'Add phone number' })).toBeFocused();
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(inHarbor(`/contacts/${maya.id}`));
    await expect(page.getByRole('heading', { level: 1, name: 'Maya Okafor' })).toBeVisible();
    // With no phone number left, the field shows two dashes, and reads "Not set"; beside
    // them is the plus that adds one.
    const phone = page
      .getByRole('region', { name: 'Fields', exact: true })
      .getByRole('group', { name: 'Contact', exact: true })
      .getByText('Phone', { exact: true })
      .locator('xpath=following-sibling::dd[1]');
    await expect(phone).toHaveText('--Not set');
    await expect(phone.getByRole('button', { name: 'Add phone', exact: true })).toBeVisible();
    await expect(phone.getByRole('link')).toHaveCount(0);
    expect(sent.find((request) => request.method === 'PATCH')?.body).toEqual({
      firstName: 'Maya',
      lastName: 'Okafor',
      emails: ['maya@example.com'],
      phones: [],
    });
  });

  test('moves a contact to the trash and back, keeping the keyboard in place', async ({ page }) => {
    await fakeApi(page, [structuredClone(maya)]);
    await page.goto(inHarbor(`/contacts/${maya.id}`));

    await page.getByRole('button', { name: 'Move to trash' }).click();
    await expect(pageStatus(page).filter({ hasText: /^Moved to trash\.$/ })).toHaveText(
      'Moved to trash.',
    );
    await expect(page.getByText('This contact is in the trash.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Restore' })).toBeFocused();
    await expectNoAccessibilityViolations(page);

    await page.keyboard.press('Enter');
    await expect(pageStatus(page).filter({ hasText: /^Contact restored\.$/ })).toHaveText(
      'Contact restored.',
    );
    await expect(page.getByRole('button', { name: 'Move to trash' })).toBeFocused();
  });

  test("says why a contact couldn't be moved to the trash", async ({ page }) => {
    await fakeApi(page, [structuredClone(maya)], async (route) => {
      if (route.request().method() !== 'DELETE') return false;
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: "Your role doesn't allow this: it needs contacts.manage.",
          permission: 'contacts.manage',
        }),
      });
      return true;
    });
    await page.goto(inHarbor(`/contacts/${maya.id}`));

    await page.getByRole('button', { name: 'Move to trash' }).click();

    await expect(page.getByRole('alert')).toHaveText(
      "Your role doesn't allow this: it needs contacts.manage.",
    );
    await expect(page.getByText('This contact is in the trash.')).toBeHidden();
  });

  test('shows a contact without changes to someone who may only read it', async ({ page }) => {
    await fakeApi(page, [{ ...structuredClone(maya), canManage: false }]);
    await page.goto(inHarbor(`/contacts/${maya.id}`));

    await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Move to trash' })).toBeHidden();
    await page.goto(inHarbor(`/contacts/${maya.id}/edit`));
    await expect(
      page.getByText('Only someone with permission can change this contact.'),
    ).toBeVisible();
  });

  test("says when a contact can't be found", async ({ page }) => {
    await fakeApi(page, []);
    await page.goto(inHarbor(`/contacts/${ids[1]}`));

    await expect(page.getByRole('alert')).toContainText(
      "This contact doesn't exist, or it belongs to another business.",
    );
    await page.getByRole('link', { name: 'Go to contacts' }).click();
    await expect(page).toHaveURL(inHarbor('/contacts'));
  });

  test('is filled in and sent by keyboard alone', async ({ page }) => {
    const contacts: StoredContact[] = [];
    await fakeApi(page, contacts);
    await page.goto(inHarbor('/contacts'));

    await addContact(page).focus();
    await page.keyboard.press('Enter');
    await expect(adding(page).getByLabel('First name')).toBeFocused();
    await page.keyboard.type('Dana');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Brooks');
    // The primary radio is before the address in its row.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('dana@example.com');
    await page.keyboard.press('Enter');

    await expect(pageStatus(page).filter({ hasText: 'Dana Brooks added.' })).toBeVisible();
    await expect(addContact(page)).toBeFocused();
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.emails).toEqual(['dana@example.com']);
  });
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('fits the form and the contact page on a phone', async ({ page }) => {
    await fakeApi(page, [
      stored(ids[0], {
        firstName: 'Maya',
        lastName: 'Thompson',
        emails: ['maya.thompson.with.a.long.address@example.com'],
        phones: ['0712 345678'],
      }),
    ]);

    await page.goto(inHarbor('/contacts?add=contact'));
    const panel = adding(page);
    await expect(panel.getByLabel('First name')).toBeFocused();
    expect(await fitsTheWidth(page)).toBe(true);
    // The panel is as wide as the phone, and nothing in it is cut off at the right.
    const box = await panel.boundingBox();
    expect(box?.width).toBe(360);
    expect(
      await panel.evaluate((element) =>
        [...element.querySelectorAll('input, button, [role="combobox"]')].every(
          (control) => control.getBoundingClientRect().right <= element.clientWidth,
        ),
      ),
    ).toBe(true);
    await panel.getByRole('button', { name: 'Add phone', exact: true }).click();
    await panel.getByRole('checkbox', { name: 'Email', exact: true }).check();
    await expectNoAccessibilityViolations(page);
    // Each control is big enough for a finger.
    for (const control of [
      panel.getByLabel('First name'),
      panel.getByRole('button', { name: 'Remove phone 2', exact: true }),
      panel.getByRole('button', { name: 'Add email', exact: true }),
      panel.getByRole('button', { name: 'Save', exact: true }),
    ])
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(40);

    await page.goto(inHarbor(`/contacts/${ids[0]}`));
    await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
    expect(await fitsTheWidth(page)).toBe(true);
    await expectNoAccessibilityViolations(page);
  });
});

/** People 000 to count - 1, newest first as the server lists them. */
const people = (count: number): StoredContact[] =>
  Array.from({ length: count }, (_, index) =>
    stored(idAt(index), {
      firstName: 'Person',
      lastName: String(index).padStart(3, '0'),
      emails: [`person${String(index)}@example.com`],
    }),
  );

const contactRows = (page: Page) =>
  page.getByRole('table', { name: 'Contacts' }).locator('tbody tr[data-index]');

/** The chip beside Filters and Sort that says how many contacts the list holds. */
const contactCount = (page: Page) => page.getByRole('status').filter({ hasText: /Contacts?$/ });

/** The footer's line that says which page of the list shows. */
const pageShown = (page: Page) =>
  page.getByRole('navigation', { name: 'Pages' }).getByRole('status');

const budgetId = 'fld_01m4bd188ff82s0add91b7pz63';

/** One custom field of contacts, a sum of money, for the filters and the order. */
async function budgetField(page: Page): Promise<void> {
  await page.route('**/api/v1/fields', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: budgetId,
            objectKey: 'contact',
            key: 'budget',
            label: 'Budget',
            description: 'Available budget',
            valueType: 'money',
            currency: 'KES',
            options: [],
            aiFillSources: [],
            aiOverwrite: 'ask',
            archived: false,
            revision: 'a'.repeat(64),
          },
        ],
        objects: [{ key: 'contact', label: 'Contact' }],
        canManage: false,
      },
    }),
  );
}

test.describe('the list at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('lists contacts, opens one, and is accessible', async ({ page }) => {
    await fakeApi(page, [structuredClone(maya), ...people(2)]);
    await page.goto(inHarbor('/contacts'));

    await expect(contactRows(page)).toHaveCount(3);
    await expect(contactCount(page)).toHaveText('3 Contacts');
    await expect(page.getByRole('columnheader')).toHaveText([
      'Contact name',
      'Phone',
      'Email',
      'Business name',
      'Created',
      'Last activity',
      'Tags',
    ]);
    await expect(page.getByRole('cell', { name: 'person1@example.com' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '0712 345678' })).toBeVisible();
    // Each row is 42px tall, with the contact's initials before the name.
    expect((await contactRows(page).first().boundingBox())?.height).toBe(42);
    await expect(contactRows(page).first().locator('[data-slot="avatar"]')).toHaveText('MT');
    await expectNoAccessibilityViolations(page);
    await page.getByRole('link', { name: 'Maya Thompson' }).click();
    await expect(page).toHaveURL(inHarbor(`/contacts/${maya.id}`));
  });

  test('adds the selected contacts to a published workflow chosen by search, and says what came of it', async ({
    page,
  }) => {
    const workflow = {
      id: 'aut_01m4bd188ff82s0add91b7pz63',
      name: 'Clean service interest',
      description: '',
      status: 'active',
      draftVersion: 2,
      liveVersion: 2,
      lastRunAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const searched: string[] = [];
    await page.route(/\/api\/v1\/automations\?/, (route) => {
      const url = new URL(route.request().url());
      searched.push(url.search);
      return route.fulfill({
        json: { canManage: true, items: [workflow], nextCursor: null },
      });
    });
    const { sent } = await fakeApi(page, [structuredClone(maya), ...people(2)], async (route) => {
      const request = route.request();
      if (request.method() !== 'POST' || !request.url().endsWith('/contacts/bulk')) return false;
      await route.fulfill({
        status: 201,
        json: bulkActionOf(1, {
          action: 'add_to_workflow',
          requested: 2,
          done: 1,
          skipped: 1,
        }),
      });
      return true;
    });
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(3);

    await page.getByRole('checkbox', { name: 'Select Maya Thompson' }).check();
    await page.getByRole('checkbox', { name: 'Select Person 000' }).check();
    const bar = page.getByRole('group', { name: 'Bulk actions' });
    await expect(bar).toContainText('2 selected');
    await bar.getByRole('button', { name: 'Add to Workflow' }).click();

    const dialog = page.getByRole('dialog', { name: 'Add to Workflow' });
    await expect(dialog).toContainText('2 contacts are selected.');
    const apply = dialog.getByRole('button', { name: 'Add to Workflow' });
    await expect(apply).toBeDisabled();
    await dialog.getByRole('button', { name: 'Workflow: Select a workflow' }).click();
    await dialog.getByRole('combobox', { name: 'Search workflows' }).fill('clean');
    await dialog.getByRole('option', { name: 'Clean service interest' }).click();
    await expectNoAccessibilityViolations(page);
    await apply.click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Done:' })).toHaveText(
      /Done: 1 changed, 0 already as asked, 1 skipped\./,
    );
    await expect(
      page.getByRole('link', { name: 'See each contact in Bulk Actions' }),
    ).toBeVisible();
    await expect(bar).toBeHidden();
    // Only published workflows that are not paused are offered.
    expect(searched.every((query) => query.includes('status=active'))).toBe(true);
    expect(sent.find((each) => each.path === '/contacts/bulk')?.body).toEqual({
      action: 'add_to_workflow',
      workflowId: workflow.id,
      selection: { ids: [maya.id, idAt(0)] },
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
  });

  test('selects every contact the list holds, past the ones loaded, and texts them in the background', async ({
    page,
  }) => {
    await page.route('**/api/v1/phone-numbers', (route) => route.fulfill({ json: { data: [] } }));
    const { sent } = await fakeApi(page, people(60), async (route) => {
      const request = route.request();
      if (request.method() !== 'POST' || !request.url().endsWith('/contacts/bulk')) return false;
      await route.fulfill({
        status: 201,
        json: bulkActionOf(1, {
          action: 'send_sms',
          status: 'queued',
          requested: 59,
          done: 0,
          skipped: 0,
          startedAt: null,
          finishedAt: null,
          canCancel: true,
        }),
      });
      return true;
    });
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(50);

    await page.getByRole('checkbox', { name: 'Select all contacts on this page' }).check();
    const bar = page.getByRole('group', { name: 'Bulk actions' });
    await expect(bar).toContainText('50 selected');
    await bar.getByRole('button', { name: 'Select all 60 contacts' }).click();
    await expect(bar).toContainText('All 60 contacts selected');
    // One unticked is left out, and the count says so.
    await page.getByRole('checkbox', { name: 'Select Person 003' }).uncheck();
    await expect(bar).toContainText('All 59 contacts selected');

    await bar.getByRole('button', { name: 'Send SMS' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send SMS' });
    await expect(dialog).toContainText('59 contacts are selected.');
    await dialog.getByLabel('Message').fill('Hi {{contact.first_name}}, we open Saturday.');
    await expectNoAccessibilityViolations(page);
    await dialog.getByRole('button', { name: 'Send to 59 contacts' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'background' })).toHaveText(
      /Started in the background for 59 contacts\./,
    );
    expect(sent.find((each) => each.path === '/contacts/bulk')?.body).toEqual({
      action: 'send_sms',
      message: 'Hi {{contact.first_name}}, we open Saturday.',
      selection: { all: true, except: [idAt(3)] },
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
  });

  test('exports the selected contacts with the columns the list shows', async ({ page }) => {
    const { sent } = await fakeApi(page, [structuredClone(maya), ...people(2)], async (route) => {
      const request = route.request();
      if (request.method() !== 'POST' || !request.url().endsWith('/contacts/bulk')) return false;
      await route.fulfill({
        status: 201,
        json: bulkActionOf(1, {
          action: 'export',
          status: 'queued',
          requested: 1,
          done: 0,
          skipped: 0,
          startedAt: null,
          finishedAt: null,
        }),
      });
      return true;
    });
    await page.goto(inHarbor('/contacts'));
    await page.getByRole('checkbox', { name: 'Select Maya Thompson' }).check();
    const bar = page.getByRole('group', { name: 'Bulk actions' });
    await bar.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export contacts' });
    // The list's columns are ticked to start with, in its order.
    await expect(dialog.getByRole('checkbox', { name: 'Contact name' })).toBeChecked();
    await dialog.getByRole('checkbox', { name: 'Last activity' }).uncheck();
    await dialog.getByRole('button', { name: 'Export 1 contact' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: 'Download it from Bulk Actions' })).toBeVisible();
    expect(sent.find((each) => each.path === '/contacts/bulk')?.body).toMatchObject({
      action: 'export',
      columns: ['name', 'phone', 'email', 'company', 'added', 'tags'],
      selection: { ids: [maya.id] },
    });
  });

  test('shows a question mark for a contact with no name', async ({ page }) => {
    await fakeApi(page, [stored(ids[1], { emails: ['nameless@example.com'] })]);
    await page.goto(inHarbor('/contacts'));

    const row = contactRows(page).first();
    await expect(row.getByRole('link', { name: 'nameless@example.com' })).toBeVisible();
    await expect(row.locator('[data-slot="avatar"]')).toHaveText('?');
  });

  for (const width of [1440, 1920]) {
    test(`fills the column beside the sidebar at ${String(width)} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await fakeApi(page, [structuredClone(maya), ...people(2)]);
      await page.goto(inHarbor('/contacts'));
      await expect(contactRows(page)).toHaveCount(3);

      const card = page.getByRole('region', { name: 'Contacts', exact: true });
      expect(await reachesRightGutter(page, savedViews(page))).toBe(true);
      expect(await reachesRightGutter(page, card)).toBe(true);
      // The table fills the card: its right edge is the card's, less the card's padding.
      const cardBox = await card.boundingBox();
      const tableBox = await page.getByRole('region', { name: 'Contacts table' }).boundingBox();
      expect(cardBox).not.toBeNull();
      expect(tableBox).not.toBeNull();
      expect(
        (cardBox?.x ?? 0) + (cardBox?.width ?? 0) - ((tableBox?.x ?? 0) + (tableBox?.width ?? 0)),
      ).toBeLessThanOrEqual(16);
      // The sidebar is 224px wide, and the card starts one gutter after it.
      expect(cardBox?.x).toBe(240);
      expect(await fitsTheWidth(page)).toBe(true);
    });
  }

  test('searches as you type, keeping the search in the address', async ({ page }) => {
    const { sent } = await fakeApi(page, [structuredClone(maya), ...people(3)]);
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(4);

    await page.getByLabel('Search contacts').fill('maya');

    await expect(page).toHaveURL(inHarbor('/contacts?q=maya'));
    await expect(page.getByLabel('Search contacts')).toBeFocused();
    await expect(contactRows(page)).toHaveCount(1);
    await expect(contactCount(page)).toHaveText('1 Contact');
    expect(sent.some((request) => request.query.get('q') === 'maya')).toBe(true);
    await page.reload();
    await expect(page.getByLabel('Search contacts')).toHaveValue('maya');
    await expect(contactRows(page)).toHaveCount(1);
  });

  test('resets the search when Contacts is opened from the sidebar', async ({ page }) => {
    await fakeApi(page, [structuredClone(maya), ...people(3)]);
    await page.goto(inHarbor('/contacts?q=maya'));
    await expect(contactRows(page)).toHaveCount(1);

    await page.getByRole('link', { name: 'Contacts', exact: true }).click();

    await expect(page).toHaveURL(inHarbor('/contacts'));
    await expect(page.getByLabel('Search contacts')).toHaveValue('');
    await expect(contactRows(page)).toHaveCount(4);

    await page.goBack();
    await expect(page.getByLabel('Search contacts')).toHaveValue('maya');
    await expect(contactRows(page)).toHaveCount(1);
    await page.goForward();
    await expect(page.getByLabel('Search contacts')).toHaveValue('');
    await expect(contactRows(page)).toHaveCount(4);
  });

  test('cancels a pending search when the sidebar opens Contacts', async ({ page }) => {
    await fakeApi(page, [structuredClone(maya), ...people(3)]);
    await page.goto(inHarbor('/contacts?q=maya'));
    await expect(contactRows(page)).toHaveCount(1);
    await page.getByLabel('Search contacts').fill('Person');

    await page.getByRole('link', { name: 'Contacts', exact: true }).click();

    await expect(page).toHaveURL(inHarbor('/contacts'));
    await expect(page.getByLabel('Search contacts')).toHaveValue('');
    await expect(contactRows(page)).toHaveCount(4);
  });

  test('orders by name from Sort and keeps those added lately from Filters, by keyboard', async ({
    page,
  }) => {
    const { sent } = await fakeApi(page, people(3));
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(3);

    // Sort is a small popover: opened and closed from the keyboard, which it gives back.
    await sortButton(page).focus();
    await page.keyboard.press('Enter');
    const sort = page.getByRole('dialog', { name: 'Sort by', exact: true });
    await expect(sort).toBeVisible();
    await expect(sort.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();
    await expectNoAccessibilityViolations(page);
    await choose(sort.getByRole('combobox', { name: 'Sort by', exact: true }), 'name');
    await expect(page).toHaveURL(inHarbor('/contacts?sort=name'));
    await page.keyboard.press('Escape');
    await expect(sort).toBeHidden();
    await expect(page.getByRole('button', { name: 'Sort (1)', exact: true })).toBeFocused();
    await expect(page.getByRole('columnheader', { name: 'Contact name' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    // Filters is a panel at the right: nothing changes until Apply, which closes it.
    const filters = await openFilters(page);
    await expect(filters.getByRole('searchbox', { name: 'Search field' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await choose(filters.getByRole('combobox', { name: 'Created', exact: true }), 'week');
    await expect(page).toHaveURL(inHarbor('/contacts?sort=name'));
    await filters.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(filters).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/contacts?sort=name&added=week'));
    await expect(page.getByRole('button', { name: 'Filters (1)', exact: true })).toBeFocused();

    await expect
      .poll(() => sent.at(-1)?.query.toString() ?? '')
      .toMatch(/^sort=name&createdFrom=\d{4}-\d\d-\d\dT/);

    // Clear puts the order back to the newest first.
    const again = await openSort(page);
    await again.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/contacts?added=week'));
    await expect(page.getByRole('columnheader', { name: 'Created' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  test('orders from a column heading where the server has that order', async ({ page }) => {
    await fakeApi(page, people(3));
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(3);

    await page
      .getByRole('columnheader', { name: 'Contact name' })
      .getByRole('button', { name: 'Contact name', exact: true })
      .click();
    await expect(page).toHaveURL(inHarbor('/contacts?sort=name'));
    await page
      .getByRole('columnheader', { name: 'Created' })
      .getByRole('button', { name: 'Created', exact: true })
      .click();
    await expect(page).toHaveURL(inHarbor('/contacts'));
    // The server orders by neither of these, so neither heading is a sort button; each has
    // only its width menu.
    for (const name of ['Email', 'Phone']) {
      const heading = page.getByRole('columnheader', { name, exact: true });
      await expect(heading.getByRole('button', { name, exact: true })).toHaveCount(0);
      await expect(heading.getByRole('button')).toHaveText(['']);
      await expect(heading.getByRole('button')).toHaveAccessibleName(
        `Change the width of the ${name} column`,
      );
    }
  });

  test('filters and orders by an exact field value, retaining it after reload', async ({
    page,
  }) => {
    const { sent } = await fakeApi(page, [structuredClone(maya)]);
    await budgetField(page);
    await page.goto(inHarbor('/contacts'));
    const filters = await openFilters(page);
    await filters.getByRole('button', { name: 'Budget', exact: true }).click();
    await choose(filters.getByRole('combobox', { name: 'Match', exact: true }), 'gte');
    await filters.getByLabel('Field value', { exact: true }).fill('9007199254740993.1250');
    await filters.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect.poll(() => sent.at(-1)?.query.get('fieldValue')).toBe('9007199254740993.1250');
    expect(sent.at(-1)?.query.get('fieldOperator')).toBe('gte');

    const sort = await openSort(page);
    await choose(sort.getByRole('combobox', { name: 'Sort by', exact: true }), `field:${budgetId}`);
    await expect.poll(() => sent.at(-1)?.query.get('sortField')).toBe(budgetId);
    expect(sent.at(-1)?.query.get('fieldOrder')).toBe('asc');
    await sort.getByRole('button', { name: 'Ascending', exact: true }).click();
    await expect.poll(() => sent.at(-1)?.query.get('fieldOrder')).toBe('desc');
    await expect(sort.getByRole('button', { name: 'Descending', exact: true })).toBeVisible();
    expect(sent.at(-1)?.query.get('fieldValue')).toBe('9007199254740993.1250');
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(page.getByRole('button', { name: 'Filters (1)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sort (1)', exact: true })).toBeVisible();
    const reopened = await openFilters(page);
    await expect(reopened.getByRole('button', { name: 'Budget', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(reopened.getByLabel('Field value', { exact: true })).toHaveValue(
      '9007199254740993.1250',
    );
    await expectNoAccessibilityViolations(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await expectNoAccessibilityViolations(page);
    expect(await fitsTheWidth(page)).toBe(true);
    await reopened.getByRole('button', { name: 'Clear all', exact: true }).click();
    await expect(reopened).toBeHidden();
    await expect.poll(() => sent.at(-1)?.query.has('fieldId')).toBe(false);
    // The order was chosen in Sort, and clearing the filters leaves it.
    expect(sent.at(-1)?.query.get('sortField')).toBe(budgetId);
  });

  test('finds a field in Filters by its name, and leaves the list alone on Cancel', async ({
    page,
  }) => {
    const { sent } = await fakeApi(page, [structuredClone(maya)]);
    await budgetField(page);
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(1);
    const requests = sent.length;

    const filters = await openFilters(page);
    await filters.getByRole('searchbox', { name: 'Search field' }).fill('budg');
    await expect(filters.getByRole('button', { name: 'Budget', exact: true })).toBeVisible();
    await expect(filters.getByRole('combobox', { name: 'Created', exact: true })).toHaveCount(0);
    await filters.getByRole('searchbox', { name: 'Search field' }).fill('nothing like it');
    await expect(filters.getByText('No field matches this search.')).toBeVisible();
    await filters.getByRole('searchbox', { name: 'Search field' }).fill('');
    await filters.getByRole('button', { name: 'Budget', exact: true }).click();
    await filters.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(filters).toBeHidden();
    await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeFocused();
    await expect(page).toHaveURL(inHarbor('/contacts'));
    expect(sent).toHaveLength(requests);
  });

  test('chooses and orders the columns in Manage fields, applying them together', async ({
    page,
  }) => {
    await fakeApi(page, [structuredClone(maya)]);
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(1);
    // Email verification is a column a new list leaves out: Manage fields adds it.
    await expect(columnsButton(page)).toHaveText('7/8 columns');

    await columnsButton(page).focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: 'Manage fields', exact: true });
    await expect(panel).toBeVisible();
    const inTable = panel.getByRole('region', { name: 'Fields in table' });
    // The name always shows, first; nothing is applied until something changes.
    await expect(inTable.getByRole('checkbox', { name: 'Contact name' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await expectNoAccessibilityViolations(page);

    // Unchecked from the keyboard, a field stays where it is, with the keyboard still on it.
    await inTable.getByRole('checkbox', { name: 'Email', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(inTable.getByRole('checkbox', { name: 'Email', exact: true })).not.toBeChecked();
    await expect(inTable.getByRole('checkbox', { name: 'Email', exact: true })).toBeFocused();
    // Only the column a new list leaves out is there to add; Email stays where it was.
    const toAdd = panel.getByRole('region', { name: 'Add fields' }).getByRole('checkbox');
    await expect(toAdd).toHaveCount(1);
    await expect(toAdd).toHaveAccessibleName('Email verification');
    await panel.getByRole('button', { name: 'Move Created up', exact: true }).click();
    // The table behind is as it was until Apply.
    await expect(page.getByRole('columnheader', { includeHidden: true })).toHaveText([
      'Contact name',
      'Phone',
      'Email',
      'Business name',
      'Created',
      'Last activity',
      'Tags',
    ]);
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(panel).toBeHidden();
    await expect(page.getByRole('columnheader')).toHaveText([
      'Contact name',
      'Phone',
      'Created',
      'Business name',
      'Last activity',
      'Tags',
    ]);
    await expect(columnsButton(page)).toHaveText('6/8 columns');
    await expect(columnsButton(page)).toBeFocused();
    await page.reload();
    await expect(page.getByRole('columnheader')).toHaveText([
      'Contact name',
      'Phone',
      'Created',
      'Business name',
      'Last activity',
      'Tags',
    ]);

    // Escape closes the panel without applying, and gives the keyboard back.
    const again = await openManageFields(page);
    await again
      .getByRole('region', { name: 'Add fields' })
      .getByRole('checkbox', { name: 'Email', exact: true })
      .check();
    await page.keyboard.press('Escape');
    await expect(again).toBeHidden();
    await expect(columnsButton(page)).toBeFocused();
    await expect(page.getByRole('columnheader')).toHaveText([
      'Contact name',
      'Phone',
      'Created',
      'Business name',
      'Last activity',
      'Tags',
    ]);
  });

  test('walks the pages the server gives, one at a time, with Prev and Next', async ({ page }) => {
    const { sent, counts } = await fakeApi(page, people(120));
    await page.goto(inHarbor('/contacts'));
    await expect(page.getByRole('link', { name: 'Person 000' })).toBeVisible();
    // A page is 50 contacts: only those are drawn. How many there are in all, and so how
    // many pages, is what the server counted, with the list's own search and filters.
    await expect(contactRows(page)).toHaveCount(50);
    await expect(contactCount(page)).toHaveText('120 Contacts');
    await expect(pageShown(page)).toHaveText('Page 1 of 3');
    expect(counts.at(-1)?.query.toString()).toBe('');
    await expect(page.getByText('50 per page', { exact: true })).toBeVisible();
    const previous = page.getByRole('button', { name: 'Previous page' });
    const next = page.getByRole('button', { name: 'Next page' });
    await expect(previous).toBeDisabled();

    await next.click();
    await expect(page.getByRole('link', { name: 'Person 050' })).toBeVisible();
    await expect(contactRows(page)).toHaveCount(50);
    await expect(pageShown(page)).toHaveText('Page 2 of 3');
    await expect(contactCount(page)).toHaveText('120 Contacts');
    expect(sent.filter((request) => request.query.get('after') !== null)).toHaveLength(1);
    expect(sent.find((request) => request.query.get('after') !== null)?.query.get('after')).toBe(
      idAt(49),
    );

    await next.click();
    await expect(page.getByRole('link', { name: 'Person 119' })).toBeVisible();
    await expect(contactRows(page)).toHaveCount(20);
    await expect(pageShown(page)).toHaveText('Page 3 of 3');
    await expect(contactCount(page)).toHaveText('120 Contacts');
    await expect(next).toBeDisabled();
    expect(sent.at(-1)?.query.get('after')).toBe(idAt(99));

    // A page already here shows again without asking the server.
    const requests = sent.length;
    await previous.click();
    await expect(page.getByRole('link', { name: 'Person 050' })).toBeVisible();
    await expect(pageShown(page)).toHaveText('Page 2 of 3');
    expect(sent).toHaveLength(requests);
    await expectNoAccessibilityViolations(page);
  });

  test('says how many have loaded when the server cannot count the list', async ({ page }) => {
    await fakeApi(page, people(120), undefined, true, 'fails');
    await page.goto(inHarbor('/contacts'));
    await expect(page.getByRole('link', { name: 'Person 000' })).toBeVisible();
    // Nothing is made up: the chip says what is here and that there is more, and the footer
    // says no number of pages until the last one has come.
    await expect(contactCount(page)).toHaveText('50+ Contacts');
    await expect(pageShown(page)).toHaveText('Page 1');
    const next = page.getByRole('button', { name: 'Next page' });
    await next.click();
    await expect(pageShown(page)).toHaveText('Page 2');
    await expect(contactCount(page)).toHaveText('100+ Contacts');
    await next.click();
    await expect(pageShown(page)).toHaveText('Page 3 of 3');
    await expect(contactCount(page)).toHaveText('120 Contacts');
  });

  test('says "10,000+" when the server stopped counting a narrowed list', async ({ page }) => {
    const { counts } = await fakeApi(page, people(120), undefined, true, 'limited');
    await page.goto(inHarbor('/contacts?q=person'));
    await expect(page.getByRole('link', { name: 'Person 000' })).toBeVisible();
    await expect(contactCount(page)).toHaveText('10,000+ Contacts');
    await expect(pageShown(page)).toHaveText('Page 1');
    // The count is asked for with the list's search, and without its order or its place.
    expect(counts.at(-1)?.query.toString()).toBe('q=person');
  });

  test('shows the business name, the last activity and the tags when their columns show', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-10-11T12:00:00.000Z'));
    const { sent } = await fakeApi(page, [
      {
        ...structuredClone(maya),
        lastActivity: { at: '2026-10-08T12:00:00.000Z', channel: 'email' },
        tags: [
          { id: 'tag_01m4bd188ff82s0add91b7pz63', name: 'customer' },
          { id: 'tag_01m4bd188ff82s0add91b7pz64', name: 'vip' },
          { id: 'tag_01m4bd188ff82s0add91b7pz65', name: 'wedding' },
        ],
        company: { id: 'com_01m4bd188ff82s0add91b7pz63', name: 'Hale Rentals' },
      },
      ...people(1),
    ]);
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(2);
    expect(sent.at(-1)?.query.get('include')).toBe('lastActivity,tags,company');

    const row = contactRows(page).first();
    await expect(row.getByRole('link', { name: 'Hale Rentals', exact: true })).toHaveAttribute(
      'href',
      inHarbor('/contacts/companies/com_01m4bd188ff82s0add91b7pz63'),
    );
    // The first cell holds the row's checkbox, for a bulk action.
    await expect(row.getByRole('cell').nth(6)).toHaveText('Email·3 days ago');
    await expect(row.getByRole('cell').nth(7)).toHaveText('customervip+1 more');
    // A contact with none of them has empty cells, not made-up ones.
    const other = contactRows(page).nth(1);
    await expect(other.getByRole('cell').nth(4)).toHaveText('');
    await expect(other.getByRole('cell').nth(6)).toHaveText('');
    await expect(other.getByRole('cell').nth(7)).toHaveText('');
    await expectNoAccessibilityViolations(page);

    // A column that is hidden is not asked for.
    const fields = await openManageFields(page);
    for (const name of ['Business name', 'Tags'])
      await fields.getByRole('checkbox', { name, exact: true }).uncheck();
    await fields.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('columnheader', { name: 'Tags' })).toHaveCount(0);
    await expect.poll(() => sent.at(-1)?.query.get('include')).toBe('lastActivity');
  });

  test('loads the next page from its button, by keyboard', async ({ page }) => {
    const { sent } = await fakeApi(page, people(60));
    await page.goto(inHarbor('/contacts'));
    await expect(page.getByRole('link', { name: 'Person 000' })).toBeVisible();

    await page.getByRole('button', { name: 'Next page' }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('link', { name: 'Person 059' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(sent.some((request) => request.query.get('after') === idAt(49))).toBe(true);
    await expect(pageShown(page)).toHaveText('Page 2 of 2');
    await expect(contactCount(page)).toHaveText('60 Contacts');
  });

  test('starts again from the first page when the list is searched', async ({ page }) => {
    await fakeApi(page, people(120));
    await page.goto(inHarbor('/contacts'));
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(pageShown(page)).toHaveText('Page 2 of 3');

    await page.getByLabel('Search contacts').fill('Person 0');

    await expect(page.getByRole('link', { name: 'Person 000' })).toBeVisible();
    // A hundred are named "Person 0…": two pages, counted with the search.
    await expect(pageShown(page)).toHaveText('Page 1 of 2');
    await expect(contactCount(page)).toHaveText('100 Contacts');
  });

  test('walks the list from a contact opened from it, and goes back to it as it was', async ({
    page,
  }) => {
    await fakeApi(page, [structuredClone(maya), ...people(60)]);
    await page.goto(inHarbor('/contacts?sort=name'));
    await expect(page.getByRole('link', { name: 'Maya Thompson' })).toBeVisible();

    await page.getByRole('link', { name: 'Maya Thompson' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
    // By name, Maya is first of the 61 the server counted, of which 50 have loaded.
    const place = page.getByRole('group', { name: 'Place in the list' });
    await expect(place).toContainText('1/61');
    await expect(place).toContainText('Contact 1 of 61');
    await expect(place.getByRole('link', { name: 'Previous contact' })).toHaveCount(0);

    await place.getByRole('link', { name: 'Next contact' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Person 000' })).toBeVisible();
    await expect(page).toHaveURL(inHarbor(`/contacts/${idAt(0)}`));
    await expect(place).toContainText('2/61');
    await place.getByRole('link', { name: 'Previous contact' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByRole('link', { name: 'Back to contacts' }).click();
    await expect(page).toHaveURL(inHarbor('/contacts?sort=name'));
    await expect(page.getByRole('link', { name: 'Maya Thompson' })).toBeVisible();
  });

  test('loads the next page of the list when the walk reaches the end of what has loaded', async ({
    page,
  }) => {
    const { sent } = await fakeApi(page, people(52));
    await page.goto(inHarbor('/contacts'));
    await page.getByRole('link', { name: 'Person 049' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Person 049' })).toBeVisible();

    const place = page.getByRole('group', { name: 'Place in the list' });
    await expect(place).toContainText('50/52');
    expect(sent.some((request) => request.query.get('after') === idAt(49))).toBe(true);
    await place.getByRole('link', { name: 'Next contact' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Person 050' })).toBeVisible();
    await expect(place).toContainText('51/52');
  });

  test('says a place among what has loaded when the server cannot count the list', async ({
    page,
  }) => {
    await fakeApi(page, people(60), undefined, true, 'fails');
    await page.goto(inHarbor('/contacts'));
    await page.getByRole('link', { name: 'Person 003' }).click();
    const place = page.getByRole('group', { name: 'Place in the list' });
    await expect(place).toContainText('4/50+');
    await expect(place).toContainText('Contact 4 of 50 or more');
  });

  test('shows a contact opened by its address without a place in any list', async ({ page }) => {
    await fakeApi(page, [structuredClone(maya), ...people(2)]);
    await page.goto(inHarbor(`/contacts/${maya.id}`));

    await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Place in the list' })).toHaveCount(0);
  });

  test('says when there are no contacts, and when none match', async ({ page }) => {
    await fakeApi(page, []);
    await page.goto(inHarbor('/contacts'));
    await expect(page.getByRole('heading', { name: 'No contacts yet' })).toBeVisible();
    await expect(contactCount(page)).toHaveText('0 Contacts');

    await page.getByLabel('Search contacts').fill('nobody');

    await expect(page.getByText('No contacts match this search.')).toBeVisible();
  });

  test('offers Add contact only to people who may add contacts', async ({ page }) => {
    await fakeApi(page, [structuredClone(maya)], undefined, false);
    // Not by its address either.
    await page.goto(inHarbor('/contacts?add=contact'));

    await expect(contactRows(page)).toHaveCount(1);
    await expect(addContact(page)).toBeHidden();
    await expect(adding(page)).toHaveCount(0);
  });

  test('keeps the trash in the More menu, and links to the import', async ({ page }) => {
    await fakeApi(page, [structuredClone(maya)]);
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(1);
    // Import is a link beside Add contact, to the import in Settings.
    await expect(page.getByRole('link', { name: 'Import', exact: true })).toHaveAttribute(
      'href',
      inHarbor('/settings/import'),
    );
    // A row, and the page's rows together, can be selected for a bulk action.
    await expect(page.getByRole('main').getByRole('checkbox')).toHaveCount(2);
    await expect(
      page.getByRole('checkbox', { name: 'Select all contacts on this page' }),
    ).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Select Maya Thompson' })).not.toBeChecked();

    const more = page.getByRole('button', { name: 'More', exact: true });
    await more.focus();
    await page.keyboard.press('Enter');
    const trash = page.getByRole('menuitem', { name: 'Trash', exact: true });
    await expect(trash).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await more.click();
    await trash.click();
    await expect(page).toHaveURL(inHarbor('/trash'));
  });
});

test.describe('the list at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('shows each name with its email address, and scrolls the other columns inside the card', async ({
    page,
  }) => {
    await fakeApi(page, [structuredClone(maya), ...people(2)]);
    await page.goto(inHarbor('/contacts'));

    await expect(contactRows(page)).toHaveCount(3);
    await expect(page.getByRole('cell', { name: /^Maya Thompson/ })).toContainText(
      'maya@example.com',
    );
    // The table is wider than the phone: it scrolls inside its card, and the page doesn't.
    const table = page.getByRole('region', { name: 'Contacts table' });
    expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await fitsTheWidth(page)).toBe(true);
    await expectNoAccessibilityViolations(page);
    // Every control is big enough for a finger.
    for (const control of [
      filtersButton(page),
      sortButton(page),
      columnsButton(page),
      page.getByLabel('Search contacts'),
      page.getByRole('button', { name: 'Next page' }),
      addContact(page),
      page.getByRole('button', { name: 'More', exact: true }),
    ])
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(40);
  });

  test('opens Filters and Manage fields as panels that fit the phone', async ({ page }) => {
    await fakeApi(page, [structuredClone(maya)]);
    await budgetField(page);
    await page.goto(inHarbor('/contacts'));
    await expect(contactRows(page)).toHaveCount(1);

    const filters = await openFilters(page);
    await filters.getByRole('button', { name: 'Budget', exact: true }).click();
    expect((await filters.boundingBox())?.width).toBeLessThanOrEqual(360);
    expect(await fitsTheWidth(page)).toBe(true);
    await expectNoAccessibilityViolations(page);
    await page.keyboard.press('Escape');
    await expect(filtersButton(page)).toBeFocused();

    const fields = await openManageFields(page);
    expect((await fields.boundingBox())?.width).toBeLessThanOrEqual(360);
    await expectNoAccessibilityViolations(page);
    await fields.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(columnsButton(page)).toBeFocused();

    const sort = await openSort(page);
    const sortBox = await sort.boundingBox();
    expect(sortBox?.x).toBeGreaterThanOrEqual(0);
    expect((sortBox?.x ?? 0) + (sortBox?.width ?? 361)).toBeLessThanOrEqual(360);
    await expectNoAccessibilityViolations(page);
  });
});
