import { expect, type Locator, type Page } from '@playwright/test';

// What the contacts list and the opportunities list share on screen: the saved views as a
// row of tabs with one actions menu, and Filters, Sort and Manage fields beside the count.

/** The row of saved views above a list. */
export const savedViews = (page: Page): Locator =>
  page.getByRole('region', { name: 'Saved views', exact: true });

/** One saved view's tab, or "All" for the list with no view. */
export const viewTab = (page: Page, name: string): Locator =>
  savedViews(page).getByRole('button', { name, exact: true });

export async function openView(page: Page, name: string): Promise<void> {
  await viewTab(page, name).click();
}

/** The tab that is the list's current view. */
export async function expectView(page: Page, name: string): Promise<void> {
  await expect(viewTab(page, name)).toHaveAttribute('aria-current', 'true');
  await expect(savedViews(page).locator('[aria-current="true"]')).toHaveCount(1);
}

/** The button that opens the actions of the saved views: edit and refresh. */
export const viewActions = (page: Page): Locator =>
  savedViews(page).getByRole('button', { name: 'View actions', exact: true });

/**
 * The panel at the right that adds a saved view or edits one: "smart list" on the contacts
 * list, "view" on the opportunities list.
 */
export const viewPanel = (page: Page): Locator =>
  page.getByRole('dialog', { name: /^(?:Add|Edit) (?:smart list|view)$/ });

/** The name of the view in the panel. */
export const viewName = (page: Page): Locator =>
  viewPanel(page).getByRole('textbox', { name: /^(?:Smart list|View) name$/ });

/** The panel's primary button for a new view. */
export const createButton = (page: Page): Locator =>
  viewPanel(page).getByRole('button', { name: 'Create', exact: true });

/** A row of the panel: a step such as "Filters", or something done to the view. */
export const viewRow = (page: Page, name: string | RegExp): Locator =>
  viewPanel(page).getByRole('button', { name });

/** Opens the panel that edits the selected view, from the actions menu. */
export async function editView(page: Page): Promise<void> {
  await viewActions(page).click();
  await page.getByRole('menuitem', { name: /^Edit (?:smart list|view)$/ }).click();
  await expect(viewPanel(page)).toBeVisible();
}

/**
 * Starts one of the things done to the selected view. Refreshing is in the actions menu;
 * the others are in the panel that edits the view: Sharing & permissions, where sharing
 * with the team chooses "All users" and making it private "Only me", each then saved with
 * "Save sharing"; and the row that deletes it, leading to its confirmation.
 */
export async function viewAction(
  page: Page,
  name: 'Refresh saved views' | 'Share with team' | 'Make private' | 'Delete saved view',
): Promise<void> {
  if (name === 'Refresh saved views') {
    await viewActions(page).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
    return;
  }
  await editView(page);
  if (name === 'Delete saved view') {
    await viewRow(page, /^Delete (?:list|view)$/).click();
    return;
  }
  await viewRow(page, /^Sharing & permissions/).click();
  await viewPanel(page)
    .getByRole('radio', { name: name === 'Share with team' ? 'All users' : 'Only me', exact: true })
    .check();
}

/** Saves the choice made in Sharing & permissions. */
export const saveSharing = (page: Page): Promise<void> =>
  viewPanel(page).getByRole('button', { name: 'Save sharing', exact: true }).click();

/**
 * Reads the saved views again while the panel is open over the list, as the page does when
 * someone comes back to its tab: the menu's own refresh is behind the panel then.
 */
export async function refreshBehindPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Starts saving the list as it is as a new view: the "+ Add" beside the tabs. */
export const addView = (page: Page): Locator =>
  savedViews(page).getByRole('button', { name: /^Add (?:smart list|view)$/ });

/** The Filters button, whatever number of filters it shows. */
export const filtersButton = (page: Page): Locator =>
  page.getByRole('button', { name: /^Filters(?: \(\d+\))?$/ });

/** Opens the Filters panel at the right, and answers it. */
export async function openFilters(page: Page): Promise<Locator> {
  await filtersButton(page).click();
  const panel = page.getByRole('dialog', { name: 'Filters', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

/** The Sort button, whether or not an order is chosen. */
export const sortButton = (page: Page): Locator =>
  page.getByRole('button', { name: /^Sort(?: \(1\))?$/ });

/** Opens the Sort popover, and answers it. */
export async function openSort(page: Page): Promise<Locator> {
  await sortButton(page).click();
  const popover = page.getByRole('dialog', { name: 'Sort by', exact: true });
  await expect(popover).toBeVisible();
  return popover;
}

/** The button that says how many columns show, which opens Manage fields. */
export const columnsButton = (page: Page): Locator =>
  page.getByRole('button', { name: /^\d+\/\d+ columns$/ });

/** Opens the Manage fields panel at the right, and answers it. */
export async function openManageFields(page: Page): Promise<Locator> {
  await columnsButton(page).click();
  const panel = page.getByRole('dialog', { name: 'Manage fields', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

/** Whether an element reaches the 16px gutter at the right of the window. */
export async function reachesRightGutter(page: Page, element: Locator): Promise<boolean> {
  const box = await element.boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  return box !== null && Math.abs(box.x + box.width - (width - 16)) <= 1;
}
