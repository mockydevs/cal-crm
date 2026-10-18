import { choose, expectChoice } from './select';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  companyLinkInput,
  createCompanyInput,
  listCompaniesQuery,
  updateCompanyInput,
  type Company,
  type ContactCompanies,
} from '@repo/contracts';
import { reachesRightGutter } from './lists';
import { harbor, inHarbor, signedIn } from './session';
import { emptyContactPanels, emptyRecordWork } from './contact-panels';

const companyId = 'com_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';
const byDana = { kind: 'user', name: 'Dana Brooks', you: true } as const;

/** A company as the server sends one: every key, the empty ones null. */
function companyOf(id: string, name: string, rest: Partial<Company> = {}): Company {
  return {
    id,
    name,
    domain: null,
    phone: null,
    email: null,
    website: null,
    address: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    description: null,
    createdBy: { kind: 'user', name: 'Lee Park', you: false },
    trashedAt: null,
    createdAt: at,
    updatedAt: at,
    canManage: true,
    ...rest,
  };
}

const acme = (): Company =>
  companyOf(companyId, 'Acme Events', {
    domain: 'acme.example',
    phone: '+254712345678',
    email: 'hello@acme.example',
    website: 'www.acme.example',
    address: '12 Harbour Road',
    city: 'Mombasa',
    state: 'Coast',
    postalCode: '80100',
    country: 'KE',
    description: 'Weddings by the sea.',
    createdBy: byDana,
  });

/** Twenty-five companies, "Company 00" to "Company 24". */
const many = (canManage = true): Company[] =>
  Array.from({ length: 25 }, (_, index) => {
    const number = String(index).padStart(2, '0');
    return companyOf(`com_01m4bd188ff82s0add91b7pz${number}`, `Company ${number}`, {
      email: `team${number}@example.test`,
      canManage,
    });
  });

interface Refusal {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

async function companyApi(page: Page) {
  await emptyRecordWork(page);
  const state = {
    items: [] as Company[],
    /** What the next save is refused with, until it is cleared. */
    refuseSave: undefined as readonly Refusal[] | undefined,
    canManage: true,
    /** Whether the list is refused outright, as for someone who may not read companies. */
    forbidden: false,
    failNext: false,
    /** While set, a search (a list asked for with `q`) isn't answered until it settles. */
    searchHeld: undefined as Promise<void> | undefined,
    /** Every list the page asked for, as its query string was. */
    lists: [] as string[],
    /** Every body a save sent. */
    saves: [] as unknown[],
  };
  await page.route('**/api/v1/fields', (route) => route.fulfill({ json: { items: [] } }));
  await page.route(/\/api\/v1\/companies(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').slice(4);
    const method = route.request().method();
    const refused = () =>
      route.fulfill({
        status: 422,
        json: {
          type: 'about:blank',
          title: 'Validation failed',
          status: 422,
          detail: 'Correct the company.',
          errors: state.refuseSave,
        },
      });
    if (parts.length === 0) {
      if (method === 'GET') {
        state.lists.push(url.search);
        // The server's own schema: a question it would refuse fails the test here.
        const query = listCompaniesQuery.parse(Object.fromEntries(url.searchParams));
        if (query.q !== undefined) await state.searchHeld;
        if (state.forbidden)
          return route.fulfill({
            status: 403,
            json: { type: 'about:blank', title: 'Forbidden', status: 403 },
          });
        if (query.after !== undefined && state.failNext)
          return route.fulfill({
            status: 503,
            json: { type: 'about:blank', title: 'Unavailable', status: 503 },
          });
        const q = (query.q ?? '').toLowerCase();
        const matches = state.items.filter(
          (item) =>
            item.trashedAt === null &&
            [item.name, item.email, item.phone, item.website, item.domain]
              .join(' ')
              .toLowerCase()
              .includes(q),
        );
        // Only the two orders the tests read are stood in for: by name, each way.
        if (query.sort === 'name')
          matches.sort(
            (a, b) => a.name.localeCompare(b.name) * (query.direction === 'desc' ? -1 : 1),
          );
        const limit = query.limit ?? 50;
        const start =
          query.after === undefined ? 0 : matches.findIndex((item) => item.id === query.after) + 1;
        const items = matches.slice(start, start + limit);
        return route.fulfill({
          json: {
            items,
            next: start + limit < matches.length ? items.at(-1)?.id : null,
            total: matches.length,
            canManage: state.canManage,
          },
        });
      }
      const body: unknown = route.request().postDataJSON();
      state.saves.push(body);
      if (state.refuseSave !== undefined) return refused();
      const saved = companyOf(companyId, '', {
        ...createCompanyInput.parse(body),
        createdBy: byDana,
      });
      state.items.push(saved);
      return route.fulfill({ status: 201, json: saved });
    }
    const current = state.items.find((item) => item.id === parts[0]);
    if (current === undefined)
      return route.fulfill({
        status: 404,
        json: { type: 'about:blank', title: 'Not Found', status: 404 },
      });
    if (method === 'PATCH') {
      const body: unknown = route.request().postDataJSON();
      state.saves.push(body);
      if (state.refuseSave !== undefined) return refused();
      Object.assign(current, updateCompanyInput.parse(body));
    }
    if (method === 'DELETE') current.trashedAt = at;
    if (parts[1] === 'restore') current.trashedAt = null;
    return route.fulfill({ json: current });
  });
  await page.route(/\/api\/v1\/records\/com_[^/]+\/fields$/, (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route(/\/api\/v1\/records\/com_[^/]+\/tags$/, (route) =>
    route.fulfill({ json: { items: [], canManage: false } }),
  );
  await page.route(/\/api\/v1\/records\/com_[^/]+\/activity(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  return state;
}

const companiesTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Companies table', exact: true }).getByRole('table');
const companyRow = (page: Page, name: string): Locator =>
  companiesTable(page).getByRole('row').filter({ hasText: name });
const addPanel = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Add new Company', exact: true });
const editPanel = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Edit company', exact: true });
const columnHeading = (page: Page, name: string): Locator =>
  companiesTable(page).getByRole('columnheader', { name, exact: true });
// While a panel is open the page behind it is inert, so its notice is found by its markup.
const pageNotice = (page: Page): Locator => page.locator('main p.sr-only[role="status"]');
/** The last list the page asked for, as the keys and values of its query. */
const lastList = (state: { readonly lists: readonly string[] }): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(state.lists.at(-1) ?? ''));

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("lists companies under GoHighLevel's columns and asks the server for each heading's order", async ({
  page,
}) => {
  await signedIn(page);
  const state = await companyApi(page);
  state.items.push(acme(), companyOf('com_01m4bd188ff82s0add91b7pz64', 'Northwind'));
  await page.goto(inHarbor('/contacts/companies'));
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
  await expect(companiesTable(page).getByRole('columnheader')).toHaveText([
    'Company Name',
    'Phone',
    'Email',
    'Website',
    'Address',
    'State',
    'City',
    'Description',
    'Postal Code',
    'Country',
    'Created At',
    'Updated At',
    'Created By',
    'Actions',
  ]);
  const row = companyRow(page, 'Acme Events');
  for (const value of [
    '+254712345678',
    'hello@acme.example',
    'www.acme.example',
    '12 Harbour Road',
    'Coast',
    'Mombasa',
    'Weddings by the sea.',
    '80100',
    'Kenya',
    'You',
  ])
    await expect(row.getByRole('cell', { name: value, exact: true })).toBeVisible();
  await expect(companyRow(page, 'Northwind').getByRole('cell', { name: 'Lee Park' })).toBeVisible();
  await expect(page.getByText('2 Companies', { exact: true })).toBeVisible();
  // Newest first until a heading is pressed: no order is named, and Created At says so.
  expect(lastList(state)).toEqual({ limit: '20' });
  await expect(columnHeading(page, 'Created At')).toHaveAttribute('aria-sort', 'descending');

  await columnHeading(page, 'Company Name').getByRole('button').click();
  await expect(columnHeading(page, 'Company Name')).toHaveAttribute('aria-sort', 'ascending');
  await expect(page).toHaveURL(inHarbor('/contacts/companies?sort=name'));
  await expect.poll(() => lastList(state)).toEqual({ sort: 'name', direction: 'asc', limit: '20' });
  await expect(companiesTable(page).getByRole('rowheader')).toHaveText([
    'Acme Events',
    'Northwind',
  ]);

  await columnHeading(page, 'Company Name').getByRole('button').click();
  await expect(columnHeading(page, 'Company Name')).toHaveAttribute('aria-sort', 'descending');
  await expect
    .poll(() => lastList(state))
    .toEqual({ sort: 'name', direction: 'desc', limit: '20' });
  await expect(companiesTable(page).getByRole('rowheader')).toHaveText([
    'Northwind',
    'Acme Events',
  ]);

  // Every other heading sends its own key; the two times start newest first.
  for (const [heading, sort, direction] of [
    ['Phone', 'phone', 'asc'],
    ['Email', 'email', 'asc'],
    ['Website', 'website', 'asc'],
    ['Address', 'address', 'asc'],
    ['State', 'state', 'asc'],
    ['City', 'city', 'asc'],
    ['Description', 'description', 'asc'],
    ['Postal Code', 'postalCode', 'asc'],
    ['Country', 'country', 'asc'],
    ['Updated At', 'updated', 'desc'],
    ['Created By', 'createdBy', 'asc'],
  ] as const) {
    await columnHeading(page, heading).getByRole('button').click();
    await expect.poll(() => lastList(state)).toEqual({ sort, direction, limit: '20' });
  }
  // Coming from another column, Created At starts newest first by name; the next press
  // turns it, and the one after goes back to no order.
  await columnHeading(page, 'Created At').getByRole('button').click();
  await expect
    .poll(() => lastList(state))
    .toEqual({ sort: 'created', direction: 'desc', limit: '20' });
  await columnHeading(page, 'Created At').getByRole('button').click();
  await expect
    .poll(() => lastList(state))
    .toEqual({ sort: 'created', direction: 'asc', limit: '20' });
  await columnHeading(page, 'Created At').getByRole('button').click();
  await expect.poll(() => lastList(state)).toEqual({ limit: '20' });
  await expect(page).toHaveURL(inHarbor('/contacts/companies'));
});

test('searches companies as the server does and keeps the search in the address', async ({
  page,
}) => {
  await signedIn(page);
  const state = await companyApi(page);
  state.items.push(acme(), companyOf('com_01m4bd188ff82s0add91b7pz64', 'Northwind'));
  await page.goto(inHarbor('/contacts/companies?sort=name'));
  await expect(companyRow(page, 'Northwind')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search companies', exact: true });
  // Part of an email address: the server's search covers it, not only the name.
  await search.fill('hello@acme');
  await expect(companyRow(page, 'Northwind')).toHaveCount(0);
  await expect(companyRow(page, 'Acme Events')).toBeVisible();
  expect(lastList(state)).toEqual({ q: 'hello@acme', sort: 'name', direction: 'asc', limit: '20' });
  await expect(page).toHaveURL(inHarbor('/contacts/companies?q=hello%40acme&sort=name'));
  await expect(page.getByText('1 Company', { exact: true })).toBeVisible();
  await search.fill('nobody at all');
  await expect(page.getByText('No companies match.', { exact: true })).toBeVisible();
  await expect(page.getByText('0 Companies', { exact: true })).toBeVisible();
  await search.fill('');
  await expect(companyRow(page, 'Northwind')).toBeVisible();
  await expect.poll(() => lastList(state)).toEqual({ sort: 'name', direction: 'asc', limit: '20' });
  // A search that came with the address shows in the box.
  await page.goto(inHarbor('/contacts/companies?q=North'));
  await expect(search).toHaveValue('North');
  await expect(companyRow(page, 'Acme Events')).toHaveCount(0);
});

test('turns pages on the cursor, keeps a failed page to itself and changes the rows per page', async ({
  page,
}) => {
  await signedIn(page);
  const state = await companyApi(page);
  state.items.push(...many());
  await page.goto(inHarbor('/contacts/companies'));
  await expect(companyRow(page, 'Company 19')).toBeVisible();
  await expect(companyRow(page, 'Company 20')).toHaveCount(0);
  const pages = page.getByRole('navigation', { name: 'Pages', exact: true });
  await expect(pages.getByRole('status')).toHaveText('1 - 20 of 25');
  await expect(pages.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await expect(page.getByText('25 Companies', { exact: true })).toBeVisible();

  state.failNext = true;
  await pages.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText("The companies couldn't be loaded.", {
    timeout: 15000,
  });
  state.failNext = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(companyRow(page, 'Company 24')).toBeVisible();
  expect(lastList(state)).toEqual({ limit: '20', after: 'com_01m4bd188ff82s0add91b7pz19' });
  await expect(pages.getByRole('status')).toHaveText('21 - 25 of 25');
  await expect(pages.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();

  await pages.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(companyRow(page, 'Company 00')).toBeVisible();
  await expect(pages.getByRole('status')).toHaveText('1 - 20 of 25');

  await pages.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(companyRow(page, 'Company 24')).toBeVisible();
  await choose(pages.getByRole('combobox', { name: 'Rows per page', exact: true }), '50');
  await expect(companyRow(page, 'Company 00')).toBeVisible();
  await expect(companyRow(page, 'Company 24')).toBeVisible();
  expect(lastList(state)).toEqual({ limit: '50' });
  await expect(pages.getByRole('status')).toHaveText('1 - 25 of 25');
});

test('adds a company with every field in the right-hand panel, after a refusal shown on its fields', async ({
  page,
}) => {
  await signedIn(page);
  const state = await companyApi(page);
  await page.goto(inHarbor('/contacts/companies'));
  await expect(page.getByText('No Companies yet', { exact: true })).toBeVisible();
  const add = page.getByRole('button', { name: 'Add Company', exact: true }).first();
  await add.click();
  const panel = addPanel(page);
  await expect(panel).toBeVisible();
  // The list stays where it is behind the panel, and can't be reached while it is open.
  await expect(page).toHaveURL(inHarbor('/contacts/companies'));
  await expect(page.getByRole('searchbox', { name: 'Search companies' })).toHaveCount(0);
  const save = panel.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await panel.getByLabel('Company Name', { exact: true }).fill('Acme Events');
  await panel.getByLabel('Phone', { exact: true }).fill('+254712345678');
  await panel.getByLabel('Email', { exact: true }).fill('Hello@Acme.example');
  await panel.getByLabel('Website', { exact: true }).fill('ftp://acme.example');
  await panel.getByLabel('Address', { exact: true }).fill('12 Harbour Road');
  await panel.getByLabel('State', { exact: true }).fill('Coast');
  await panel.getByLabel('City', { exact: true }).fill('Mombasa');
  await panel.getByLabel('Description', { exact: true }).fill('Weddings by the sea.');
  await panel.getByLabel('Postal Code', { exact: true }).fill('80100');
  const country = panel.getByRole('combobox', { name: 'Country', exact: true });
  await choose(country, 'KE');
  await expectChoice(country, 'KE');
  await expect(country).toHaveText('Kenya');
  await panel.getByLabel('Domain', { exact: true }).fill('acme.example');

  // The API's own rule is said under the field before anything is sent.
  await save.click();
  await expect(
    panel.getByText('Enter a web address, such as www.acme.example.', { exact: true }),
  ).toBeVisible();
  expect(state.saves).toEqual([]);
  await panel.getByLabel('Website', { exact: true }).fill('www.acme.example');

  // The server's refusal lands on the fields it names, and the draft stays.
  state.refuseSave = [
    { path: '/domain', code: 'taken', message: 'Another company uses this domain.' },
    { path: '/phone', code: 'invalid_phone', message: 'Enter a phone number with its country.' },
  ];
  await save.click();
  await expect(panel.getByText('Another company uses this domain.', { exact: true })).toBeVisible();
  await expect(
    panel.getByText('Enter a phone number with its country.', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByLabel('Domain', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(panel.getByLabel('Company Name', { exact: true })).toHaveValue('Acme Events');
  await expect(companiesTable(page)).toHaveCount(0);

  state.refuseSave = undefined;
  await panel.getByLabel('Domain', { exact: true }).fill('acme-events.example');
  await save.click();
  await expect(panel).toHaveCount(0);
  expect(state.saves.at(-1)).toEqual({
    name: 'Acme Events',
    phone: '+254712345678',
    email: 'Hello@Acme.example',
    website: 'www.acme.example',
    address: '12 Harbour Road',
    city: 'Mombasa',
    state: 'Coast',
    postalCode: '80100',
    country: 'KE',
    description: 'Weddings by the sea.',
    domain: 'acme-events.example',
  });
  await expect(pageNotice(page)).toHaveText('Company added.');
  await expect(companyRow(page, 'Acme Events').getByRole('cell', { name: 'Kenya' })).toBeVisible();
  await expect(page.getByText('1 Company', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Company', exact: true })).toBeFocused();

  // "Save and add another" keeps the panel for the next one.
  await page.getByRole('button', { name: 'Add Company', exact: true }).click();
  await addPanel(page).getByLabel('Company Name', { exact: true }).fill('Northwind');
  state.items.length = 0;
  await addPanel(page).getByRole('button', { name: 'Save and add another', exact: true }).click();
  await expect(
    addPanel(page).getByText('Company added. Add another, or close the panel.', { exact: true }),
  ).toBeVisible();
  await expect(addPanel(page).getByLabel('Company Name', { exact: true })).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(addPanel(page)).toHaveCount(0);
  await expect(companyRow(page, 'Northwind')).toBeVisible();
});

test('edits a company from its row and from its page in the same panel, then trashes and restores it', async ({
  page,
}) => {
  await signedIn(page);
  const state = await companyApi(page);
  state.items.push(acme());
  await page.goto(inHarbor('/contacts/companies'));
  await companyRow(page, 'Acme Events')
    .getByRole('button', { name: 'Edit Acme Events', exact: true })
    .click();
  const panel = editPanel(page);
  await expect(panel.getByLabel('Company Name', { exact: true })).toHaveValue('Acme Events');
  await expect(panel.getByLabel('Email', { exact: true })).toHaveValue('hello@acme.example');
  await expectChoice(panel.getByRole('combobox', { name: 'Country', exact: true }), 'KE');
  await expect(panel.getByRole('button', { name: 'Save and add another' })).toHaveCount(0);
  await panel.getByLabel('City', { exact: true }).fill('Kilifi');
  await panel.getByLabel('Postal Code', { exact: true }).fill('');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(state.saves.at(-1)).toMatchObject({
    name: 'Acme Events',
    city: 'Kilifi',
    postalCode: null,
  });
  await expect(pageNotice(page)).toHaveText('Company saved.');
  await expect(companyRow(page, 'Acme Events').getByRole('cell', { name: 'Kilifi' })).toBeVisible();
  await expect(
    companyRow(page, 'Acme Events').getByRole('button', { name: 'Edit Acme Events', exact: true }),
  ).toBeFocused();

  // The company's own page shows what the table shows, and who made it.
  await companyRow(page, 'Acme Events').getByRole('link', { name: 'Acme Events' }).click();
  await expect(page.getByRole('heading', { name: 'Acme Events', exact: true })).toBeVisible();
  const details = page.getByRole('region', { name: 'Details', exact: true });
  await expect(
    details.getByRole('link', { name: 'hello@acme.example', exact: true }),
  ).toHaveAttribute('href', 'mailto:hello@acme.example');
  await expect(
    details.getByRole('link', { name: 'www.acme.example', exact: true }),
  ).toHaveAttribute('href', 'https://www.acme.example');
  await expect(details.getByRole('link', { name: 'acme.example', exact: true })).toHaveAttribute(
    'href',
    'https://acme.example',
  );
  for (const [term, value] of [
    ['Address', '12 Harbour Road'],
    ['State', 'Coast'],
    ['City', 'Kilifi'],
    ['Description', 'Weddings by the sea.'],
    ['Postal Code', 'Not set'],
    ['Country', 'Kenya'],
    ['Created By', 'You'],
  ] as const)
    await expect(
      details.locator('dt', { hasText: new RegExp(`^${term}$`) }).locator('+ dd'),
    ).toHaveText(value);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await editPanel(page).getByLabel('Company Name', { exact: true }).fill('Acme Weddings');
  await editPanel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editPanel(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Acme Weddings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();

  await page.getByRole('button', { name: 'Move to trash', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('This company is in the trash.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Move to trash', exact: true })).toBeFocused();
});

test('lets someone without the permission read companies and offers nothing to change', async ({
  page,
}) => {
  await signedIn(page);
  const state = await companyApi(page);
  state.canManage = false;
  state.items.push(...many(false));
  await page.goto(inHarbor('/contacts/companies'));
  await expect(companyRow(page, 'Company 07')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Company', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit Company/ })).toHaveCount(0);
  await expect(columnHeading(page, 'Actions')).toHaveCount(0);
  await expect(
    page.getByText(
      'You can read companies. Adding and changing them needs permission to manage companies.',
      { exact: true },
    ),
  ).toBeVisible();
  await companyRow(page, 'Company 07').getByRole('link', { name: 'Company 07' }).click();
  await expect(page.getByRole('heading', { name: 'Company 07', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move to trash', exact: true })).toHaveCount(0);

  // Refused outright: the list says so, and offers no retry that would be refused again.
  state.forbidden = true;
  await page.goto(inHarbor('/contacts/companies'));
  await expect(page.getByRole('alert')).toHaveText(
    "You don't have permission to see this business's companies.",
  );
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
});

test('says a save was refused when the permission went while the panel was open', async ({
  page,
}) => {
  await signedIn(page);
  const state = await companyApi(page);
  state.items.push(acme());
  await page.goto(inHarbor('/contacts/companies'));
  await page.getByRole('button', { name: 'Add Company', exact: true }).click();
  await addPanel(page).getByLabel('Company Name', { exact: true }).fill('Northwind');
  await page.route('**/api/v1/companies', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 403,
          json: {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'You need permission to manage companies.',
          },
        })
      : route.fallback(),
  );
  await addPanel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(addPanel(page).getByRole('alert')).toHaveText(
    'You need permission to manage companies.',
  );
  await expect(addPanel(page).getByLabel('Company Name', { exact: true })).toHaveValue('Northwind');
  expect(state.items).toHaveLength(1);
});

for (const width of [1440, 360]) {
  test.describe(`${String(width)} px companies screens`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the list, the panel and the company page are accessible', async ({ page }, testInfo) => {
      await signedIn(page);
      const state = await companyApi(page);
      state.items.push(acme(), ...many());
      await page.goto(inHarbor('/contacts/companies'));
      await expect(companyRow(page, 'Acme Events')).toBeVisible();
      await expectNoAccessibilityViolations(page);
      // The table is wider than a phone: it scrolls inside its own frame, by keyboard too.
      const region = page.getByRole('region', { name: 'Companies table', exact: true });
      expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`companies-${String(width)}.png`),
        fullPage: true,
      });

      await page.getByRole('button', { name: 'Add Company', exact: true }).click();
      await expect(addPanel(page).getByLabel('Company Name', { exact: true })).toBeVisible();
      await expectNoAccessibilityViolations(page);
      const box = await addPanel(page).boundingBox();
      expect(box?.width).toBe(Math.min(520, width));
      // A refusal on a field and one on the country are announced accessibly too.
      await addPanel(page).getByLabel('Company Name', { exact: true }).fill('Acme');
      state.refuseSave = [
        { path: '/email', code: 'invalid', message: 'Enter an email address.' },
        {
          path: '/country',
          code: 'invalid',
          message: 'Use a two-letter country code, such as KE.',
        },
      ];
      await addPanel(page).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        addPanel(page).getByText('Enter an email address.', { exact: true }),
      ).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await page.screenshot({ path: testInfo.outputPath(`company-panel-${String(width)}.png`) });
      state.refuseSave = undefined;
      await addPanel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(addPanel(page)).toHaveCount(0);

      await companyRow(page, 'Acme Events').getByRole('link', { name: 'Acme Events' }).click();
      await expect(page.getByRole('heading', { name: 'Acme Events', exact: true })).toBeVisible();
      await expect(page.getByText('Created By', { exact: true })).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await page.screenshot({
        path: testInfo.outputPath(`company-${String(width)}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(editPanel(page).getByLabel('Company Name', { exact: true })).toHaveValue(
        'Acme Events',
      );
      await expectNoAccessibilityViolations(page);
    });
  });
}

test.describe('the companies page at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await signedIn(page);
    const state = await companyApi(page);
    state.items.push(acme());
    await page.goto(inHarbor('/contacts/companies'));
    await expect(companyRow(page, 'Acme Events')).toBeVisible();
    expect(
      await reachesRightGutter(page, page.getByRole('region', { name: 'Companies', exact: true })),
    ).toBe(true);
  });
});

const secondId = 'com_01m4bd188ff82s0add91b7pz64';
const id = 'con_01m4bd188ff82s0add91b7pz63';

/** Maya's contact page, and two companies she can be linked to: Acme Events and Northwind. */
async function contactAndTwoCompanies(
  page: Page,
  state: Awaited<ReturnType<typeof companyApi>>,
): Promise<void> {
  state.items.push(
    ...[companyId, secondId].map((key, index): Company => ({
      id: key,
      name: index === 0 ? 'Acme Events' : 'Northwind',
      domain: index === 0 ? 'acme.example' : 'northwind.example',
      phone: null,
      trashedAt: null,
      createdAt: at,
      updatedAt: at,
      canManage: true,
    })),
  );
  const links: ContactCompanies['items'] = [];
  await page.route(`**/api/v1/contacts/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: 'Maya Thompson',
        emails: [],
        phones: [],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        trashedAt: null,
        createdAt: at,
        updatedAt: at,
        canManage: true,
      },
    }),
  );
  await page.route(`**/api/v1/records/${id}/tags`, (route) =>
    route.fulfill({ json: { items: [], canManage: false } }),
  );
  await page.route(
    new RegExp(`/api/v1/contacts/${id}/companies(?:/[^?]+)?(?:\\?.*)?$`),
    async (route) => {
      const method = route.request().method();
      if (method === 'GET')
        return route.fulfill({ json: { items: links, next: null, canManage: true } });
      const targetId = new URL(route.request().url()).pathname.split('/').at(-1);
      const target = state.items.find((item) => item.id === targetId);
      if (target === undefined) throw new Error('Missing mock company.');
      if (method === 'DELETE') {
        const index = links.findIndex((item) => item.company.id === target.id);
        if (index >= 0) links.splice(index, 1);
        return route.fulfill({ status: 204, body: '' });
      }
      const body: unknown = route.request().postDataJSON();
      const input = companyLinkInput.parse(body);
      let linked = links.find((item) => item.company.id === target.id);
      if (linked === undefined) {
        linked = { company: target, isPrimary: false, linkedAt: at };
        links.push(linked);
      }
      if (input.primary === true) for (const item of links) item.isPrimary = false;
      if (input.primary !== undefined) linked.isPrimary = input.primary;
      return route.fulfill({ json: linked });
    },
  );
}

test('links companies from a contact and changes the single primary using the keyboard', async ({
  page,
}) => {
  await signedIn(page);
  const state = await companyApi(page);
  await emptyContactPanels(page);
  await contactAndTwoCompanies(page, state);
  await page.clock.install({ time: new Date(at) });
  await page.goto(inHarbor(`/contacts/${id}?view=companies`));
  const panel = page.getByRole('region', { name: 'Companies', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByLabel('Company', { exact: true }).click();
  await expect(
    page.getByRole('listbox').getByRole('option', { name: 'Acme Events', exact: true }),
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.clock.pauseAt(new Date('2026-10-08T13:00:00Z'));
  await panel.getByLabel('Find company', { exact: true }).fill('Acme');
  await panel.getByLabel('Company', { exact: true }).click();
  await page.clock.runFor(40);
  await page.getByRole('listbox').getByRole('option', { name: 'Acme Events', exact: true }).click();
  await expectChoice(panel.getByLabel('Company', { exact: true }), companyId);
  await page.clock.runFor(300);
  await page.clock.resume();
  await expectChoice(panel.getByLabel('Company', { exact: true }), companyId);
  await panel.getByRole('button', { name: 'Link company', exact: true }).click();
  await panel.getByRole('button', { name: 'Make Acme Events primary', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByText('Primary', { exact: true })).toHaveCount(1);
  await panel.getByLabel('Find company', { exact: true }).fill('');
  await page.clock.runFor(300);
  await choose(panel.getByLabel('Company', { exact: true }), secondId);
  await panel.getByRole('button', { name: 'Link company', exact: true }).click();
  await panel.getByRole('button', { name: 'Make Northwind primary', exact: true }).click();
  await expect(panel.getByText('Primary', { exact: true })).toHaveCount(1);
  const acme = panel
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: 'Acme Events', exact: true }) });
  await expect(acme.getByText('Primary', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Remove Acme Events company link', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('link', { name: 'Acme Events', exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Find company', { exact: true })).toBeFocused();
});

test('keeps the companies to choose from while a search is still being answered', async ({
  page,
}) => {
  await signedIn(page);
  const state = await companyApi(page);
  await emptyContactPanels(page);
  await contactAndTwoCompanies(page, state);
  await page.goto(inHarbor(`/contacts/${id}?view=companies`));
  const panel = page.getByRole('region', { name: 'Companies', exact: true });
  const company = panel.getByLabel('Company', { exact: true });
  await expect(company).toBeEnabled();

  // A slow server: the search has been asked for and its answer is on the way.
  let answer: () => void = () => undefined;
  state.searchHeld = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const asked = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get('q') === 'North',
  );
  await panel.getByLabel('Find company', { exact: true }).fill('North');
  await asked;

  // The list isn't taken away meanwhile: it opens, with the companies it had.
  await expect(company).toBeEnabled();
  await company.click();
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option', { name: 'Acme Events', exact: true })).toHaveCount(1);

  // The answer narrows the open list, and what's left can be chosen.
  answer();
  await expect(list.getByRole('option', { name: 'Acme Events', exact: true })).toHaveCount(0);
  await list.getByRole('option', { name: 'Northwind', exact: true }).click();
  await expectChoice(company, secondId);
  await expect(panel.getByRole('button', { name: 'Link company', exact: true })).toBeEnabled();
});
