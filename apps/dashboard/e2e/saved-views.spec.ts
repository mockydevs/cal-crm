import { choose, expectChoice } from './select';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createViewInput,
  contactViewChanges,
  dealViewChanges,
  deleteViewInput,
  savedView,
  shareViewInput,
  viewSharingInput,
  type SavedView,
} from '@repo/contracts';
import { dana, harbor, northwind, inHarbor, signedIn, worksIn } from './session';
import { emptyRecordWork } from './contact-panels';
import {
  addView,
  createButton,
  editView,
  expectView,
  openFilters,
  openManageFields,
  openSort,
  openView,
  savedViews,
  refreshBehindPanel,
  saveSharing,
  viewAction,
  viewActions,
  viewName,
  viewPanel,
  viewRow,
  viewTab,
} from './lists';

/**
 * The opportunity table shows these after the columns of a view saved before it could
 * choose them, and until they are unticked under "Manage fields" (deals.tsx).
 */
const alwaysShown = ['Contact', 'Opportunity owner', 'Tags'];

const viewId = 'view_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';

/** What the owner of a private view may do with it, as the API says it. */
const ownersView = {
  visibility: 'private',
  access: 'owner',
  sharing: { everyone: null, people: [] },
  canChange: true,
  canShare: true,
  canUnshare: false,
  canDelete: true,
  canChangeSharing: true,
} as const;

/** The team a view can be shared with by name: Dana (the owner here), Ali and Sam. */
const team = [
  { id: 'mem_01m4bd188ff82s0add91b7pz71', name: 'Dana Brooks', you: true },
  { id: 'mem_01m4bd188ff82s0add91b7pz72', name: 'Ali Noor', you: false },
  { id: 'mem_01m4bd188ff82s0add91b7pz73', name: 'Sam Ortiz', you: false },
] as const;

async function contactViews(
  page: Page,
  items: SavedView[] = [],
  owner = true,
): Promise<{ writes: unknown[]; sharings: unknown[] }> {
  const writes: unknown[] = [];
  const sharings: unknown[] = [];
  await signedIn(
    page,
    owner ? dana : { id: 'usr_ali', name: 'Ali Noor', email: 'ali@example.com' },
  );
  await page.route('**/api/v1/tasks/assignees**', (route) =>
    route.fulfill({ json: { items: team, nextCursor: null } }),
  );
  await page.route('**/api/v1/fields', (route) =>
    route.fulfill({ json: { items: [], canManage: true } }),
  );
  await page.route(/\/api\/v1\/contacts\?.*|\/api\/v1\/contacts$/, (route) =>
    route.fulfill({
      json: {
        canManage: true,
        next: null,
        items: [
          {
            id: 'con_01m4bd188ff82s0add91b7pz63',
            name: 'Maya Thompson',
            email: 'maya@example.com',
            phone: { number: '+254712345678', display: '0712 345678' },
            createdAt: at,
          },
        ],
      },
    }),
  );
  await page.route(/\/api\/v1\/views(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          canSave: owner,
          items: owner
            ? items
            : items
                .filter((item) => item.visibility !== 'private')
                .map((item) => ({
                  ...item,
                  owner: { ...item.owner, you: false },
                  access: 'view',
                  canChange: false,
                  canShare: false,
                  canUnshare: false,
                  canDelete: false,
                  canChangeSharing: false,
                })),
        },
      });
      return;
    }
    const body: unknown = route.request().postDataJSON();
    writes.push(body);
    const input = createViewInput.parse(body);
    const created = savedView.parse({
      ...input,
      id: items.length === 0 ? viewId : 'view_01m4bd188ff82s0add91b7pz64',
      owner: { membershipId: 'mem_01m4bd188ff82s0add91b7pz71', name: 'Dana Brooks', you: true },
      ...ownersView,
      revision: 'a'.repeat(64),
      createdAt: at,
      updatedAt: at,
    });
    items.push(created);
    await route.fulfill({ status: 201, json: created });
  });
  await page.route(/\/api\/v1\/views\/[^/]+\/(?:share|unshare)$/, async (route) => {
    const input = shareViewInput.parse(route.request().postDataJSON());
    const view = items[0];
    if (view === undefined) {
      await route.fulfill({
        status: 404,
        json: { type: 'about:blank', title: 'Not Found', status: 404 },
      });
      return;
    }
    expect(input.revision).toBe(view.revision);
    const sharing = new URL(route.request().url()).pathname.endsWith('/share');
    items[0] = {
      ...view,
      visibility: sharing ? 'shared' : 'private',
      sharing: { everyone: sharing ? 'view' : null, people: [] },
      canShare: !sharing,
      canUnshare: sharing,
      revision: (sharing ? 'b' : 'c').repeat(64),
    };
    await route.fulfill({ json: items[0] });
  });
  // Sharing & permissions: everyone at a level, the people chosen, or nobody else.
  await page.route(/\/api\/v1\/views\/[^/]+\/sharing$/, async (route) => {
    const input = viewSharingInput.parse(route.request().postDataJSON());
    sharings.push(input);
    const view = items[0];
    if (view === undefined) {
      await route.fulfill({
        status: 404,
        json: { type: 'about:blank', title: 'Not Found', status: 404 },
      });
      return;
    }
    expect(input.revision).toBe(view.revision);
    const visibility =
      input.everyone !== null ? 'shared' : input.people.length > 0 ? 'selected' : 'private';
    items[0] = savedView.parse({
      ...view,
      visibility,
      sharing: {
        everyone: input.everyone,
        people: input.people.map((person) => ({
          membershipId: person.membershipId,
          name: team.find((member) => member.id === person.membershipId)?.name ?? null,
          you: false,
          access: person.access,
        })),
      },
      canShare: visibility === 'private',
      canUnshare: visibility !== 'private',
      revision: { private: 'c', shared: 'b', selected: 'd' }[visibility].repeat(64),
    });
    await route.fulfill({ json: items[0] });
  });
  await page.route(/\/api\/v1\/views\/[^/?]+$/, async (route) => {
    const view = items[0];
    if (view === undefined) {
      await route.fulfill({
        status: 404,
        json: { type: 'about:blank', title: 'Not Found', status: 404 },
      });
      return;
    }
    const body: unknown = route.request().postDataJSON();
    writes.push(body);
    if (route.request().method() === 'DELETE') {
      expect(deleteViewInput.parse(body).revision).toBe(view.revision);
      items.splice(0, 1);
      await route.fulfill({ status: 204 });
      return;
    }
    if (view.objectKey === 'contact') {
      const changed = contactViewChanges.parse(body);
      expect(changed.revision).toBe(view.revision);
      items[0] = { ...view, ...changed, revision: 'e'.repeat(64) };
    } else {
      const changed = dealViewChanges.parse(body);
      expect(changed.revision).toBe(view.revision);
      items[0] = { ...view, ...changed, revision: 'e'.repeat(64) };
    }
    await route.fulfill({ json: items[0] });
  });
  return { writes, sharings };
}

function recentCalls(): SavedView {
  return savedView.parse({
    id: viewId,
    objectKey: 'contact',
    name: 'Recent calls',
    state: { q: 'Maya', sort: 'name', added: 'week' },
    columns: ['phone', 'name'],
    owner: { membershipId: 'mem_01m4bd188ff82s0add91b7pz71', name: 'Dana Brooks', you: true },
    ...ownersView,
    revision: 'a'.repeat(64),
    createdAt: at,
    updatedAt: at,
  });
}

/** What the list's address says, read once it has settled. */
const addressHas = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

test('saves and reopens private contact filters and ordered columns after reload', async ({
  page,
}) => {
  const { writes } = await contactViews(page);
  await page.goto(inHarbor('/contacts'));
  await expectView(page, 'All');
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Maya');
  const sort = await openSort(page);
  await choose(sort.getByRole('combobox', { name: 'Sort by', exact: true }), 'name');
  await page.keyboard.press('Escape');
  const filters = await openFilters(page);
  await choose(filters.getByRole('combobox', { name: 'Created', exact: true }), 'week');
  await filters.getByRole('button', { name: 'Apply', exact: true }).click();
  const fields = await openManageFields(page);
  for (const name of ['Business name', 'Created', 'Last activity', 'Tags'])
    await fields.getByRole('checkbox', { name, exact: true }).uncheck();
  await fields.getByRole('button', { name: 'Move Email up', exact: true }).click();
  await fields.getByRole('button', { name: 'Apply', exact: true }).click();
  await addView(page).click();
  await viewName(page).fill('Recent calls');
  await createButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();
  expect(writes).toEqual([
    {
      objectKey: 'contact',
      name: 'Recent calls',
      state: { q: 'Maya', sort: 'name', added: 'week' },
      // The table's columns in the order chosen, and the four the first table had, which
      // the API still asks for, in its own order; the whole layout as well.
      columns: ['name', 'email', 'phone'],
      tableColumns: ['name', 'email', 'phone'],
      columnLayout: ['name', 'email', 'phone'],
    },
  ]);
  // The new view is a tab beside "All", and the one the list now shows. After the tabs
  // come "Add" and the views' menu, then what the page adds: "Add contact" and its own
  // menu. The menus have icons for names.
  await expect(savedViews(page).getByRole('button')).toHaveText([
    'All',
    'Recent calls',
    'Add',
    '',
    'Add contact',
    '',
  ]);
  await expectView(page, 'Recent calls');
  await expect(page.getByText('Private to you', { exact: true })).toBeVisible();
  await openView(page, 'All');
  await expectView(page, 'All');
  await expect(page.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('');
  await expect(page.getByRole('columnheader')).toHaveText([
    'Contact name',
    'Phone',
    'Email',
    'Business name',
    'Created',
    'Last activity',
    'Tags',
  ]);
  await openView(page, 'Recent calls');
  await expect(page.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya');
  await expect(page.getByRole('columnheader')).toHaveText(['Contact name', 'Email', 'Phone']);
  await page.reload();
  await expectView(page, 'Recent calls');
  await expect(page.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya');
  await expect(page.getByRole('button', { name: 'Sort (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filters (1)', exact: true })).toBeVisible();
  expect(addressHas(page, 'sort')).toBe('name');
  expect(addressHas(page, 'added')).toBe('week');
  await expect(page.getByRole('columnheader')).toHaveText(['Contact name', 'Email', 'Phone']);
  expect(new URL(page.url()).searchParams.has('after')).toBe(false);
});

test('shares contact configuration with a second member and removes access when made private', async ({
  page,
}) => {
  const items = [recentCalls()];
  await contactViews(page, items);
  await page.goto(inHarbor('/contacts'));
  await openView(page, 'Recent calls');
  await viewAction(page, 'Share with team');
  await saveSharing(page);
  await expect(
    page.getByRole('status').filter({ hasText: 'View shared with everyone.' }),
  ).toBeVisible();
  const member = await page.context().newPage();
  await contactViews(member, items, false);
  await member.goto(inHarbor('/contacts'));
  await openView(member, 'Recent calls');
  await expect(member.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya');
  await expect(member.getByRole('button', { name: 'Sort (1)', exact: true })).toBeVisible();
  await expect(member.getByRole('button', { name: 'Filters (1)', exact: true })).toBeVisible();
  expect(addressHas(member, 'sort')).toBe('name');
  expect(addressHas(member, 'added')).toBe('week');
  // A view saved with the name column second still shows it first: it always is.
  await expect(member.getByRole('columnheader')).toHaveText(['Contact name', 'Phone']);
  await expect(member.getByText('Shared with everyone', { exact: true })).toBeVisible();
  await expect(member.getByText('You can view', { exact: true })).toBeVisible();
  await expect(addView(member)).toHaveCount(0);
  await viewAction(page, 'Make private');
  await saveSharing(page);
  await expect(page.getByRole('status').filter({ hasText: 'View is private.' })).toBeVisible();
  await viewAction(member, 'Refresh saved views');
  await expect(viewTab(member, 'Recent calls')).toHaveCount(0);
  await expect(
    member.getByText('This saved view is no longer available. Your current filters are kept.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(member.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya');
  await member.close();
});

test('keeps edits and requires reviewing a changed revision before saving or deleting', async ({
  page,
}) => {
  const items = [recentCalls()];
  const { writes } = await contactViews(page, items);
  await page.goto(inHarbor('/contacts'));
  await openView(page, 'Recent calls');
  // The panel is over the list, so the list is changed first: the view is saved as it is.
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Maya VIP');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Maya VIP');
  await editView(page);
  await expect(viewName(page)).toBeFocused();
  await viewName(page).fill('My call list');
  items[0] = { ...recentCalls(), name: 'Changed by teammate', revision: 'c'.repeat(64) };
  await refreshBehindPanel(page);
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await expect(viewName(page)).toHaveValue('My call list');
  await page.getByRole('button', { name: 'Review latest view', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'View updated.' })).toBeVisible();
  // The view was saved before the table had more columns: it gains the table's own list,
  // the name first as it shows, and its whole layout, with no column resized.
  expect(writes[0]).toEqual({
    name: 'My call list',
    state: { q: 'Maya VIP', sort: 'name', added: 'week' },
    columns: ['name', 'phone'],
    tableColumns: ['name', 'phone'],
    columnLayout: ['name', 'phone'],
    columnWidths: null,
    revision: 'c'.repeat(64),
  });
  await viewAction(page, 'Delete saved view');
  const edited = items[0];
  items[0] = { ...edited, name: 'Final team name', revision: 'f'.repeat(64) };
  await refreshBehindPanel(page);
  await expect(
    page.getByRole('button', { name: 'Confirm deleting view', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Review latest view', exact: true }).click();
  await expect(
    page.getByText(
      'Delete “Final team name”? This removes the saved view, keeping your current filters.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm deleting view', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'View deleted.' })).toBeVisible();
  expect(writes[1]).toEqual({ revision: 'f'.repeat(64) });
  await expectView(page, 'All');
  await expect(viewTab(page, 'Final team name')).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya VIP');
  await expect(page.getByRole('columnheader')).toHaveText(['Contact name', 'Phone']);
});

test('a pending Harbor save cannot apply its private view after switching to Northwind', async ({
  page,
}) => {
  await contactViews(page);
  await worksIn(page, { agencyStaff: true, businesses: [harbor, northwind] });
  const saved = { ...recentCalls(), name: 'Harbor only', state: { q: 'Harbor' } };
  const hold = Promise.withResolvers<undefined>();
  const requested = Promise.withResolvers<undefined>();
  await page.route(/\/api\/v1\/views(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { canSave: true, items: [] } });
      return;
    }
    expect(await route.request().headerValue('business-id')).toBe(harbor.id);
    requested.resolve(undefined);
    await hold.promise;
    await route.fulfill({ status: 201, json: saved });
  });
  // From Northwind to Harbor without a reload, so Back leads to Northwind again: the
  // switcher is behind the panel while the save is pending, and Back is not.
  await page.goto('/b/northwind-weddings/contacts');
  await page.getByRole('combobox', { name: /^Business:/ }).click();
  await page.getByRole('option', { name: /Harbor Lights Events/ }).click();
  await expect(page).toHaveURL(inHarbor('/contacts'));
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Harbor');
  await addView(page).click();
  await viewName(page).fill('Harbor only');
  await createButton(page).click();
  await requested.promise;
  await page.goBack();
  await expect(page).toHaveURL('/b/northwind-weddings/contacts');
  await expect(viewName(page)).toHaveCount(0);
  const response = page.waitForResponse(
    (reply) => reply.request().method() === 'POST' && reply.url().endsWith('/views'),
  );
  hold.resolve(undefined);
  await (await response).finished();
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Northwind');
  await expect(page).toHaveURL(/q=Northwind/);
  expect(new URL(page.url()).searchParams.has('view')).toBe(false);
  await expectView(page, 'All');
  await expect(viewTab(page, 'Harbor only')).toHaveCount(0);
});

test('marks changed saved-view settings as modified before and after reload', async ({ page }) => {
  await contactViews(page, [recentCalls()]);
  await page.goto(inHarbor('/contacts'));
  await openView(page, 'Recent calls');
  const sort = await openSort(page);
  await sort.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Modified', { exact: true })).toBeVisible();
  await page.reload();
  await expectView(page, 'Recent calls');
  await expect(page.getByRole('button', { name: 'Sort', exact: true })).toBeVisible();
  expect(addressHas(page, 'sort')).toBeNull();
  await expect(page.getByText('Modified', { exact: true })).toBeVisible();
  await editView(page);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'View updated.' })).toBeVisible();
  await expect(page.getByText('Modified', { exact: true })).toHaveCount(0);
});

test('counts a relative period from opening the view and restarts its pages', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-08T12:00:00.000Z'));
  await contactViews(page, [recentCalls()]);
  await page.goto(inHarbor('/contacts'));
  await expect(page.getByRole('link', { name: 'Maya Thompson', exact: true })).toBeVisible();
  await page.clock.setFixedTime(new Date('2026-10-09T12:00:00.000Z'));
  const firstOpening = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/v1/contacts' &&
      new URL(request.url()).searchParams.has('createdFrom'),
  );
  await openView(page, 'Recent calls');
  const firstQuery = new URL((await firstOpening).url()).searchParams;
  expect(firstQuery.get('createdFrom')).toBe('2026-10-02T12:00:00.000Z');
  expect(firstQuery.has('after')).toBe(false);
  await openView(page, 'All');
  await page.clock.setFixedTime(new Date('2026-10-10T12:00:00.000Z'));
  const secondOpening = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/v1/contacts' &&
      new URL(request.url()).searchParams.has('createdFrom'),
  );
  await openView(page, 'Recent calls');
  const secondQuery = new URL((await secondOpening).url()).searchParams;
  expect(secondQuery.get('createdFrom')).toBe('2026-10-03T12:00:00.000Z');
  expect(secondQuery.has('after')).toBe(false);
});

test('clears an unavailable field filter without losing the search or disabling saved views', async ({
  page,
}) => {
  await contactViews(page, [recentCalls()]);
  await page.route(/\/api\/v1\/contacts(?:\?.*)?$/, async (route) => {
    if (!new URL(route.request().url()).searchParams.has('fieldId')) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 422,
      json: {
        type: 'about:blank',
        title: 'Unprocessable Content',
        status: 422,
        errors: [
          {
            path: '/fieldId',
            code: 'unknown_field',
            message: 'This field is no longer available.',
          },
        ],
      },
    });
  });
  await page.goto(
    inHarbor('/contacts?fieldId=fld_01m4bd188ff82s0add91b7pz63&fieldOperator=is_set&q=Maya'),
  );
  await expect(page.getByText("We couldn't load the contacts.", { exact: false })).toBeVisible({
    timeout: 10000,
  });
  await expect(viewTab(page, 'All')).toBeEnabled();
  await expect(viewTab(page, 'Recent calls')).toBeEnabled();
  await page.getByRole('button', { name: 'Clear field filter and order', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Maya Thompson', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya');
  expect(new URL(page.url()).searchParams.has('fieldId')).toBe(false);
});

async function dealList(page: Page): Promise<{ pipelineId: string; dealId: string }> {
  await emptyRecordWork(page);
  const pipelineId = 'pipe_01m4bd9fteedat3be9bqgx2047';
  const stageId = 'stage_01m4bd9fteedat3be9bqgx2047';
  const deal = {
    id: 'deal_01m4bd188ff82s0add91b7pz63',
    name: 'Maya’s wedding',
    pipelineId,
    stageId,
    pipelineName: 'Weddings',
    stageName: 'Proposal sent',
    amount: '11000.0000',
    currency: 'KES',
    expectedCloseDate: '2027-06-13',
    status: 'open',
    outcomeReason: null,
    closedAt: null,
    stageEnteredAt: at,
    createdAt: at,
    updatedAt: at,
    trashedAt: null,
    revision: 'a'.repeat(64),
    canManage: true,
  };
  await page.route('**/api/v1/pipelines', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'pipe_01m4bd188ff82s0add91b7pz63',
            name: 'Corporate',
            description: '',
            archived: false,
            stages: [
              {
                id: 'stage_01m4bd188ff82s0add91b7pz63',
                name: 'New lead',
                description: '',
                archived: false,
              },
            ],
          },
          {
            id: pipelineId,
            name: 'Weddings',
            description: '',
            archived: false,
            stages: [{ id: stageId, name: 'Proposal sent', description: '', archived: false }],
          },
        ],
        revision: 'b'.repeat(64),
        canManage: false,
      },
    }),
  );
  await page.route(/\/api\/v1\/deals(?:[/?].*)?$/, (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(deal.id)
        ? deal
        : { items: [deal], next: null, canManage: true },
    }),
  );
  await page.route(/\/api\/v1\/records\/deal_[^/]+\/activity(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  await page.route(/\/api\/v1\/records\/deal_[^/]+\/fields$/, (route) =>
    route.fulfill({ json: { items: [], canManage: true, canConfirm: true } }),
  );
  return { pipelineId, dealId: deal.id };
}

function weddingQuotes(): SavedView {
  return savedView.parse({
    ...recentCalls(),
    objectKey: 'deal',
    name: 'Wedding quotes',
    state: {
      pipelineId: 'pipe_01m4bd9fteedat3be9bqgx2047',
      status: 'all',
      layout: 'table',
      q: 'Maya',
    },
    columns: ['amount', 'name'],
  });
}

test('keeps default deal choices equivalent to the saved configuration', async ({ page }) => {
  await contactViews(page, [{ ...weddingQuotes(), state: {} }]);
  await dealList(page);
  await page.goto(inHarbor('/deals'));
  await openView(page, 'Wedding quotes');
  await choose(page.getByRole('combobox', { name: 'Status filter', exact: true }), 'open');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByText('Modified', { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('status')).toBe(false);
  expect(new URL(page.url()).searchParams.has('layout')).toBe(false);
});

test('an open opportunity keeps its draft: the views behind it wait until it closes', async ({
  page,
}) => {
  await contactViews(page, [weddingQuotes()]);
  const { dealId } = await dealList(page);
  await page.goto(inHarbor(`/deals?deal=${dealId}`));
  const dialog = page.getByRole('dialog', { name: 'Edit Maya’s wedding', exact: true });
  await dialog.getByLabel('Value', { exact: true }).fill('12345.6789');
  // The dialog is modal: the row of views behind it can't be reached while it is open, so
  // no view can be saved or opened over the draft.
  await expect(savedViews(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Saved views', includeHidden: true })).toHaveCount(
    1,
  );
  await page.keyboard.press('Escape');
  const guard = page.getByRole('dialog', { name: 'You have unsaved changes', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog.getByLabel('Value', { exact: true })).toHaveValue('12345.6789');
  expect(new URL(page.url()).searchParams.get('deal')).toBe(dealId);
});

test('deal search keeps raw typing while matching the trimmed saved query', async ({ page }) => {
  await contactViews(page);
  await dealList(page);
  await page.goto(inHarbor('/deals'));
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search opportunities', exact: true }).fill('  Maya  ');
  await expect(page.getByRole('rowheader', { name: 'Maya’s wedding', exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Maya');
  await expect(
    page.getByRole('searchbox', { name: 'Search opportunities', exact: true }),
  ).toHaveValue('  Maya  ');
});

test('a second member restores a shared deal view and can recover from its missing pipeline', async ({
  page,
}) => {
  const shared = {
    ...weddingQuotes(),
    visibility: 'shared' as const,
    sharing: { everyone: 'view' as const, people: [] },
    canShare: false,
    canUnshare: true,
  };
  await contactViews(page, [shared], false);
  const { pipelineId } = await dealList(page);
  await page.goto(inHarbor('/deals'));
  await openView(page, 'Wedding quotes');
  await expectChoice(page.getByRole('combobox', { name: 'Pipeline', exact: true }), pipelineId);
  await expect(page.getByRole('columnheader')).toHaveText([
    'Opportunity name',
    'Value',
    ...alwaysShown,
  ]);
  await expect(
    page.getByRole('searchbox', { name: 'Search opportunities', exact: true }),
  ).toHaveValue('Maya');
  // Someone who only reads the view is offered no change to it: refreshing is all there is.
  await viewActions(page).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Refresh saved views']);
  await page.keyboard.press('Escape');
  const address = new URL(page.url());
  address.searchParams.set('pipelineId', 'pipe_01m4bd9fteedat3be9bqgx2048');
  await page.goto(address.toString());
  await expectChoice(
    page.getByRole('combobox', { name: 'Pipeline', exact: true }),
    'pipe_01m4bd9fteedat3be9bqgx2048',
  );
  await expect(page.getByRole('combobox', { name: 'Pipeline', exact: true })).toContainText(
    'Unavailable pipeline',
  );
  await expect(page.getByRole('table')).toHaveCount(0);
  await choose(page.getByRole('combobox', { name: 'Pipeline', exact: true }), pipelineId);
  await expect(page.getByRole('columnheader')).toHaveText([
    'Opportunity name',
    'Value',
    ...alwaysShown,
  ]);
});

test('saves deal pipeline, outcome, layout, search and columns and keeps them when closing a linked deal', async ({
  page,
}) => {
  const { writes } = await contactViews(page);
  const { pipelineId, dealId } = await dealList(page);
  await page.goto(inHarbor('/deals'));
  await expect(addView(page)).toBeVisible();
  await choose(page.getByRole('combobox', { name: 'Pipeline', exact: true }), pipelineId);
  await choose(page.getByRole('combobox', { name: 'Status filter', exact: true }), 'all');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search opportunities', exact: true }).fill('Maya');
  const fields = await openManageFields(page);
  await fields.getByRole('checkbox', { name: 'Status', exact: true }).uncheck();
  await fields.getByRole('checkbox', { name: 'Expected close', exact: true }).uncheck();
  await fields.getByRole('button', { name: 'Move Stage up', exact: true }).click();
  await fields.getByRole('button', { name: 'Apply', exact: true }).click();
  await addView(page).click();
  await viewName(page).fill('Wedding quotes');
  await createButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();
  expect(writes).toEqual([
    {
      objectKey: 'deal',
      name: 'Wedding quotes',
      state: { pipelineId, status: 'all', layout: 'table', q: 'Maya' },
      // The five columns the first table had, and the table's own list, which now holds the
      // contact, the owner and the tags too.
      columns: ['name', 'stage', 'amount'],
      tableColumns: ['name', 'stage', 'value', 'contact', 'owner', 'tags'],
    },
  ]);
  await openView(page, 'All');
  await expect(page.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await openView(page, 'Wedding quotes');
  await page.reload();
  await expectView(page, 'Wedding quotes');
  await expectChoice(page.getByRole('combobox', { name: 'Pipeline', exact: true }), pipelineId);
  await expectChoice(page.getByRole('combobox', { name: 'Status filter', exact: true }), 'all');
  await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.getByRole('searchbox', { name: 'Search opportunities', exact: true }),
  ).toHaveValue('Maya');
  await expect(page.getByRole('columnheader')).toHaveText([
    'Opportunity name',
    'Stage',
    'Value',
    ...alwaysShown,
  ]);
  const beforeLink = new URL(page.url());
  const linkedAddress = new URL(beforeLink);
  linkedAddress.searchParams.set('deal', dealId);
  await page.goto(linkedAddress.toString());
  await page
    .getByRole('dialog', { name: 'Edit Maya’s wedding', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(page).toHaveURL(beforeLink.toString());
  await expect(page.getByRole('columnheader')).toHaveText([
    'Opportunity name',
    'Stage',
    'Value',
    ...alwaysShown,
  ]);
});

test('blocks competing view actions during a pending save and retains the submitted name', async ({
  page,
}) => {
  await contactViews(page, [recentCalls()]);
  const hold = Promise.withResolvers<undefined>();
  const requested = Promise.withResolvers<undefined>();
  await page.route(/\/api\/v1\/views(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fallback();
      return;
    }
    requested.resolve(undefined);
    await hold.promise;
    await route.fulfill({
      status: 422,
      json: {
        type: 'about:blank',
        title: 'Unprocessable Content',
        status: 422,
        errors: [{ path: '/name', code: 'invalid', message: 'Choose another view name.' }],
      },
    });
  });
  await page.goto(inHarbor('/contacts'));
  await openView(page, 'Recent calls');
  await addView(page).click();
  await viewName(page).fill('My pending view');
  await createButton(page).click();
  await requested.promise;
  try {
    // Nothing else can start: no other view opens, none is added, and the menu that
    // edits, deletes, shares and refreshes is shut.
    // They are behind the panel, which a reader of the page is not told about: found here
    // by what they are called, hidden or not.
    for (const name of ['All', 'Recent calls', 'Add smart list', 'View actions'])
      await expect(
        page.getByRole('button', { name, exact: true, includeHidden: true }),
      ).toBeDisabled();
    await expect(viewName(page)).toBeDisabled();
    // The panel itself offers no other way on: no step, no cancel, no second save.
    for (const control of [
      viewRow(page, 'Filters'),
      viewPanel(page).getByRole('button', { name: 'Cancel', exact: true }),
      createButton(page),
    ])
      await expect(control).toBeDisabled();
  } finally {
    hold.resolve(undefined);
  }
  await expect(page.getByRole('alert')).toContainText('Choose another view name.');
  await expect(viewName(page)).toHaveValue('My pending view');
  await expect(createButton(page)).toBeEnabled();
});

test('keeps a rejected draft after permission loss and returns focus to an available control', async ({
  page,
}) => {
  await contactViews(page);
  let allowed = true;
  await page.route(/\/api\/v1\/views(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { canSave: allowed, items: [] } });
      return;
    }
    allowed = false;
    await route.fulfill({
      status: 403,
      json: { type: 'about:blank', title: 'Forbidden', status: 403 },
    });
  });
  await page.goto(inHarbor('/contacts'));
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Maya VIP');
  await addView(page).click();
  await expect(viewName(page)).toBeFocused();
  await viewName(page).fill('My retained draft');
  await createButton(page).click();
  await expect(createButton(page)).toBeDisabled();
  await expect(addView(page)).toHaveCount(0);
  await expect(viewName(page)).toHaveValue('My retained draft');
  await expect(page.getByRole('alert')).toContainText(
    'You no longer have permission to save this view. Your draft is kept.',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(viewActions(page)).toBeFocused();
  await expect(page.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya VIP');
});

test('switches between name and field ordering without saving contradictory sort settings', async ({
  page,
}) => {
  const { writes } = await contactViews(page);
  const fieldId = 'fld_01m4bd188ff82s0add91b7pz63';
  await page.route('**/api/v1/fields', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: fieldId,
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
  await page.goto(inHarbor('/contacts?sort=name&q=Maya'));
  const filters = await openFilters(page);
  await filters.getByRole('button', { name: 'Budget', exact: true }).click();
  await choose(filters.getByRole('combobox', { name: 'Match', exact: true }), 'is_set');
  await filters.getByRole('button', { name: 'Apply', exact: true }).click();
  const sort = await openSort(page);
  await choose(sort.getByRole('combobox', { name: 'Sort by', exact: true }), `field:${fieldId}`);
  await expect.poll(() => new URL(page.url()).searchParams.get('sortField')).toBe(fieldId);
  expect(new URL(page.url()).searchParams.has('sort')).toBe(false);
  await page.keyboard.press('Escape');
  await addView(page).click();
  await viewName(page).fill('Budget ordered');
  await createButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();
  expect(createViewInput.parse(writes[0]).state).toEqual({
    q: 'Maya',
    fieldId,
    fieldOperator: 'is_set',
    sortField: fieldId,
    fieldOrder: 'asc',
  });
  const again = await openSort(page);
  await choose(again.getByRole('combobox', { name: 'Sort by', exact: true }), 'name');
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('name');
  expect(new URL(page.url()).searchParams.has('sortField')).toBe(false);
  expect(new URL(page.url()).searchParams.has('fieldOrder')).toBe(false);
  expect(new URL(page.url()).searchParams.get('fieldId')).toBe(fieldId);
  await page.keyboard.press('Escape');
  await editView(page);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'View updated.' })).toBeVisible();
  expect(contactViewChanges.parse(writes[1]).state).toEqual({
    q: 'Maya',
    sort: 'name',
    fieldId,
    fieldOperator: 'is_set',
  });
});

test('a rejected share requires explicit revision review before a second request', async ({
  page,
}) => {
  const items = [recentCalls()];
  const attempts: string[] = [];
  await contactViews(page, items);
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/sharing')) {
      attempts.push(viewSharingInput.parse(request.postDataJSON()).revision);
    }
  });
  await page.route(
    `**/api/v1/views/${viewId}/sharing`,
    async (route) => {
      items[0] = { ...recentCalls(), revision: 'f'.repeat(64) };
      await route.fulfill({
        status: 409,
        json: { type: 'about:blank', title: 'Conflict', status: 409 },
      });
    },
    { times: 1 },
  );
  await page.goto(inHarbor('/contacts'));
  await openView(page, 'Recent calls');
  await viewAction(page, 'Share with team');
  await saveSharing(page);
  await expect(page.getByRole('button', { name: 'Review latest view', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save sharing', exact: true })).toBeDisabled();
  expect(attempts).toEqual(['a'.repeat(64)]);
  // Reviewing shows the sharing the view has now; the choice is made again on it.
  await page.getByRole('button', { name: 'Review latest view', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Only me', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'All users', exact: true }).check();
  await saveSharing(page);
  await expect(
    page.getByRole('status').filter({ hasText: 'View shared with everyone.' }),
  ).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya');
  expect(attempts).toEqual(['a'.repeat(64), 'f'.repeat(64)]);
});

test('shares a smart list with chosen team members, each able to view or edit it', async ({
  page,
}) => {
  const items = [recentCalls()];
  const { sharings } = await contactViews(page, items);
  await page.goto(inHarbor('/contacts'));
  await openView(page, 'Recent calls');
  await editView(page);
  await viewRow(page, /^Sharing & permissions/).click();
  const panel = viewPanel(page);
  // The owner keeps it, or shares it with all users or with selected users; nothing to
  // save until something changes.
  await expect(panel.getByRole('radio')).toHaveCount(3);
  await expect(panel.getByRole('radio', { name: 'Only me', exact: true })).toBeChecked();
  await expect(panel.getByRole('button', { name: 'Save sharing', exact: true })).toBeDisabled();
  await panel.getByRole('radio', { name: 'Selected users', exact: true }).check();
  // The owner always has the list, so only the others are offered.
  const members = panel.getByRole('region', { name: 'Team members' });
  await expect(members.getByRole('checkbox')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: 'Save sharing', exact: true })).toBeDisabled();
  await members.getByRole('checkbox', { name: 'Ali Noor', exact: true }).check();
  await members.getByRole('checkbox', { name: 'Sam Ortiz', exact: true }).check();
  await expect(members.getByRole('combobox', { name: 'What Ali Noor can do' })).toHaveValue('view');
  await members.getByRole('combobox', { name: 'What Sam Ortiz can do' }).selectOption('edit');
  await members.getByRole('searchbox', { name: 'Search team members' }).fill('ali');
  await expect(members.getByRole('checkbox')).toHaveCount(1);
  const analysis = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(analysis.violations).toEqual([]);
  await saveSharing(page);
  await expect(
    page.getByRole('status').filter({ hasText: 'View shared with the people chosen.' }),
  ).toBeVisible();
  expect(sharings).toEqual([
    {
      everyone: null,
      people: [
        { membershipId: team[1].id, access: 'view' },
        { membershipId: team[2].id, access: 'edit' },
      ],
      revision: 'a'.repeat(64),
    },
  ]);
  await expect(page.getByText('Shared with 2 people', { exact: true })).toBeVisible();

  // Someone it is shared with to view opens it, and can't change it or its sharing.
  const member = await page.context().newPage();
  await contactViews(member, items, false);
  await member.goto(inHarbor('/contacts'));
  await openView(member, 'Recent calls');
  await expect(member.getByText('You can view', { exact: true })).toBeVisible();
  await viewActions(member).click();
  await expect(member.getByRole('menuitem')).toHaveText(['Refresh saved views']);
  await member.close();
});

test('retains the name and list configuration after a network failure for an explicit retry', async ({
  page,
}) => {
  await contactViews(page);
  await page.route(/\/api\/v1\/views(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') await route.fallback();
    else await route.abort('failed');
  });
  await page.goto(inHarbor('/contacts?q=Maya'));
  await addView(page).click();
  await viewName(page).fill('Keep this draft');
  await createButton(page).click();
  await expect(page.getByRole('alert')).toContainText(
    "We couldn't save the view. Your name is kept; try again.",
  );
  await expect(viewName(page)).toHaveValue('Keep this draft');
  await expect(createButton(page)).toBeEnabled();
  await viewPanel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya');
});

for (const width of [360, 1440]) {
  for (const object of ['contact', 'deal'] as const) {
    test(`${object} saved-view controls fit and support accessible keyboard confirmation at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const name = object === 'contact' ? 'Recent calls' : 'Wedding quotes';
      await contactViews(page, [object === 'contact' ? recentCalls() : weddingQuotes()]);
      if (object === 'deal') await dealList(page);
      await page.goto(inHarbor(object === 'contact' ? '/contacts' : '/deals'));
      await openView(page, name);
      await expectView(page, name);
      // Each tab and the menu beside them is big enough for a finger on a phone.
      if (width === 360)
        for (const control of [viewTab(page, 'All'), viewTab(page, name), viewActions(page)])
          expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await addView(page).click();
      await expect(viewName(page)).toBeFocused();
      await viewName(page).fill('An accessible view');
      const analysis = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(analysis.violations).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: join(tmpdir(), `crm-p122-${object}-${String(width)}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(addView(page)).toBeFocused();
      // The menu opens and is walked from the keyboard; with it open the page still passes.
      await viewActions(page).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitem')).toHaveText([
        object === 'contact' ? 'Edit smart list' : 'Edit view',
        'Refresh saved views',
      ]);
      const withMenu = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(withMenu.violations).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(viewActions(page)).toBeFocused();
      await editView(page);
      await viewRow(page, /^Sharing & permissions/).click();
      const back = viewPanel(page).getByRole('button', { name: 'Back', exact: true });
      await expect(back).toBeFocused();
      const withSharing = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(withSharing.violations).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      // Back leaves the step for the panel's first page, on the row that led to it.
      await page.keyboard.press('Enter');
      await expect(viewRow(page, /^Sharing & permissions/)).toBeFocused();
      // Each row of the panel is big enough for a finger on a phone.
      if (width === 360)
        for (const row of await viewPanel(page).locator('[data-view-row]').all())
          expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      await expect(viewPanel(page)).toBeHidden();
      await expect(viewActions(page)).toBeFocused();
    });
  }
}

test('a completed save keeps list changes made while its request was pending', async ({ page }) => {
  const items: SavedView[] = [];
  await contactViews(page, items);
  const hold = Promise.withResolvers<undefined>();
  const requested = Promise.withResolvers<undefined>();
  await page.route(/\/api\/v1\/views(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fallback();
      return;
    }
    const input = createViewInput.parse(route.request().postDataJSON());
    const created = savedView.parse({ ...recentCalls(), ...input });
    requested.resolve(undefined);
    await hold.promise;
    items.push(created);
    await route.fulfill({ status: 201, json: created });
  });
  await page.goto(inHarbor('/contacts?q=Maya'));
  const filters = await openFilters(page);
  await choose(filters.getByRole('combobox', { name: 'Created', exact: true }), 'week');
  await filters.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => addressHas(page, 'added')).toBe('week');
  await addView(page).click();
  await viewName(page).fill('Saved before going back');
  await createButton(page).click();
  await requested.promise;
  try {
    // The list is behind the panel while the save is pending; Back still changes it.
    await page.goBack();
    await expect.poll(() => addressHas(page, 'added')).toBeNull();
  } finally {
    hold.resolve(undefined);
  }
  await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();
  // The view is saved as it was sent, and the list stays as it now is.
  await expectView(page, 'Saved before going back');
  expect(addressHas(page, 'added')).toBeNull();
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
  await expect(page.getByText('Modified', { exact: true })).toBeVisible();
});

test('a deal view can clear an unavailable field while retaining its pipeline, layout and query', async ({
  page,
}) => {
  await contactViews(page, [weddingQuotes()]);
  const { pipelineId } = await dealList(page);
  await page.route(/\/api\/v1\/deals(?:\?.*)?$/, async (route) => {
    if (!new URL(route.request().url()).searchParams.has('fieldId')) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 422,
      json: {
        type: 'about:blank',
        title: 'Unprocessable Content',
        status: 422,
        errors: [
          {
            path: '/fieldId',
            code: 'unknown_field',
            message: 'This field is no longer available.',
          },
        ],
      },
    });
  });
  await page.goto(
    inHarbor(
      `/deals?pipelineId=${pipelineId}&layout=table&q=Maya&fieldId=fld_01m4bd188ff82s0add91b7pz63&fieldOperator=is_set`,
    ),
  );
  await expect(page.getByRole('alert')).toContainText("We couldn't load the opportunities.", {
    timeout: 10000,
  });
  await page.getByRole('button', { name: 'Clear field filter and order', exact: true }).click();
  await expect(page.getByRole('rowheader', { name: 'Maya’s wedding', exact: true })).toBeVisible();
  await expectChoice(page.getByRole('combobox', { name: 'Pipeline', exact: true }), pipelineId);
  await expect(
    page.getByRole('searchbox', { name: 'Search opportunities', exact: true }),
  ).toHaveValue('Maya');
  expect(new URL(page.url()).searchParams.has('fieldId')).toBe(false);
});

for (const object of ['contact', 'deal'] as const) {
  test(`${object} search keeps a trailing space when a view save completes mid-typing`, async ({
    page,
  }) => {
    const items: SavedView[] = [];
    await contactViews(page, items);
    if (object === 'deal') await dealList(page);
    const hold = Promise.withResolvers<undefined>();
    const requested = Promise.withResolvers<undefined>();
    await page.route(/\/api\/v1\/views(?:\?.*)?$/, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fallback();
        return;
      }
      const input = createViewInput.parse(route.request().postDataJSON());
      const created = savedView.parse({ ...recentCalls(), ...input });
      requested.resolve(undefined);
      await hold.promise;
      items.push(created);
      await route.fulfill({ status: 201, json: created });
    });
    await page.goto(inHarbor(object === 'contact' ? '/contacts?q=Maya' : '/deals?q=Maya'));
    const search = page.getByRole('searchbox', {
      name: object === 'contact' ? 'Search contacts' : 'Search opportunities',
      exact: true,
    });
    // Typed before the panel opens over the list: the search is "Maya", the box "Maya ".
    await search.fill('Maya ');
    await addView(page).click();
    await viewName(page).fill('Saved while typing');
    await createButton(page).click();
    await requested.promise;
    hold.resolve(undefined);
    await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();
    await expect(search).toHaveValue('Maya ');
    await search.press('End');
    await search.pressSequentially('Smith');
    await expect(search).toHaveValue('Maya Smith');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Maya Smith');
  });
}

test('adds a smart list from the panel: its name, filters, order and fields as steps', async ({
  page,
}) => {
  const { writes } = await contactViews(page);
  await page.goto(inHarbor('/contacts'));
  await addView(page).click();
  const panel = page.getByRole('dialog', { name: 'Add smart list', exact: true });
  // The name is there to type over.
  await expect(viewName(page)).toHaveValue('New smart list');
  await expect(viewName(page)).toBeFocused();
  // What is done to a list that exists waits until this one does.
  for (const name of ['Duplicate', /^Sharing & permissions/, 'Delete list'])
    await expect(viewRow(page, name)).toBeDisabled();
  await expect(viewRow(page, /^Export/)).toHaveCount(0);
  await expect(viewRow(page, /^Fields/)).toContainText('7 selected');

  await viewRow(page, /^Filters/).click();
  await expect(panel.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
  await choose(panel.getByRole('combobox', { name: 'Created', exact: true }), 'week');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(viewRow(page, /^Filters/)).toContainText('1 applied');
  await expect(viewRow(page, /^Filters/)).toBeFocused();

  await viewRow(page, /^Sort by/).click();
  await choose(panel.getByRole('combobox'), 'name');
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(viewRow(page, /^Sort by/)).toContainText('Contact name, A to Z');

  await viewRow(page, /^Fields/).click();
  for (const name of ['Business name', 'Created', 'Last activity', 'Tags'])
    await panel.getByRole('checkbox', { name, exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Move Email up', exact: true }).click();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(viewRow(page, /^Fields/)).toContainText('3 selected');
  // A step left by its Back button changes nothing.
  await viewRow(page, /^Fields/).click();
  await panel.getByRole('checkbox', { name: 'Phone', exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(viewRow(page, /^Fields/)).toContainText('3 selected');
  const analysis = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(analysis.violations).toEqual([]);

  await viewName(page).fill('This week by name');
  await createButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();
  await expect(panel).toBeHidden();
  expect(writes).toEqual([
    {
      objectKey: 'contact',
      name: 'This week by name',
      state: { sort: 'name', added: 'week' },
      columns: ['name', 'email', 'phone'],
      tableColumns: ['name', 'email', 'phone'],
      columnLayout: ['name', 'email', 'phone'],
    },
  ]);
  await expectView(page, 'This week by name');
  await expect(page.getByRole('columnheader')).toHaveText(['Contact name', 'Email', 'Phone']);
  await expect(page.getByRole('button', { name: 'Filters (1)', exact: true })).toBeVisible();
});

test('cancelling the panel puts the list back as the panel found it', async ({ page }) => {
  const { writes } = await contactViews(page);
  await page.goto(inHarbor('/contacts?q=Maya'));
  await addView(page).click();
  const panel = page.getByRole('dialog', { name: 'Add smart list', exact: true });
  await viewRow(page, /^Filters/).click();
  await choose(panel.getByRole('combobox', { name: 'Created', exact: true }), 'week');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => addressHas(page, 'added')).toBe('week');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(addView(page)).toBeFocused();
  await expect.poll(() => addressHas(page, 'added')).toBeNull();
  expect(addressHas(page, 'q')).toBe('Maya');
  expect(writes).toEqual([]);
});

test('edits a smart list in the same panel: duplicates it, then deletes the copy', async ({
  page,
}) => {
  const items = [recentCalls()];
  const { writes } = await contactViews(page, items);
  await page.goto(inHarbor('/contacts'));
  await openView(page, 'Recent calls');
  await editView(page);
  const panel = page.getByRole('dialog', { name: 'Edit smart list', exact: true });
  await expect(viewName(page)).toHaveValue('Recent calls');
  // With the list there, what is done to it is offered.
  for (const name of ['Duplicate', /^Sharing & permissions/, 'Delete list'])
    await expect(viewRow(page, name)).toBeEnabled();
  await expect(viewRow(page, /^Sharing & permissions/)).toContainText('Private to you');

  await viewRow(page, 'Duplicate').click();
  await expect(page.getByRole('status').filter({ hasText: 'View duplicated.' })).toBeVisible();
  await expect(panel).toBeHidden();
  expect(writes).toEqual([
    {
      objectKey: 'contact',
      name: 'Copy of Recent calls',
      state: { q: 'Maya', sort: 'name', added: 'week' },
      // As the original has them: saved with the name column second.
      columns: ['phone', 'name'],
    },
  ]);
  // The copy is the list now showing, with what the original kept.
  await expectView(page, 'Copy of Recent calls');
  await expect(page.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('Maya');

  // The stand-in changes and deletes its first view: the original.
  await openView(page, 'Recent calls');
  await viewAction(page, 'Delete saved view');
  await expect(
    page.getByText(
      'Delete “Recent calls”? This removes the saved view, keeping your current filters.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm deleting view', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'View deleted.' })).toBeVisible();
  await expect(viewTab(page, 'Recent calls')).toHaveCount(0);
  await expect(viewTab(page, 'Copy of Recent calls')).toBeVisible();
  await expectView(page, 'All');
});
