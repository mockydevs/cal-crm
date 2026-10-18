import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { assignRecordTagInput, createTagInput, type RecordTag } from '@repo/contracts';
import { harbor, inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';
import { emptyContactPanels } from './contact-panels';

const contactId = 'con_01m4bd188ff82s0add91b7pz63';
const tagId = 'tag_01m4bd9fteedat3be9bqgx2047';
const otherTagId = 'tag_01m4bdmgqwfgatd5ch0pqddfxm';
const madeTagId = 'tag_01m4bdmgqwfgatd5ch0pqddfxn';
const eventId = 'evt_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';
const tag = {
  id: tagId,
  name: 'Hot lead',
  description: 'Asked for a quote.',
  createdAt: at,
  updatedAt: at,
};
const other = { ...tag, id: otherTagId, name: 'VIP', description: 'Returning customers.' };
async function recordApi(page: Page, writable = true, trashed = false) {
  await emptyContactPanels(page);
  const state = {
    items: [
      { tag, source: { kind: 'ai_agent', eventId, you: false }, createdAt: at },
    ] as RecordTag[],
    sent: [] as string[],
    made: [] as (typeof tag)[],
    fail: false,
  };
  await page.route(`**/api/v1/contacts/${contactId}`, (route) =>
    route.fulfill({
      json: {
        id: contactId,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: 'Maya Thompson',
        emails: ['maya@example.com'],
        phones: [],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        createdAt: at,
        updatedAt: at,
        trashedAt: trashed ? at : null,
        canManage: writable,
      },
    }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([tag, other, ...state.made]) }),
  );
  await page.route('**/api/v1/tags', (route) => {
    const made = {
      ...tag,
      id: madeTagId,
      name: createTagInput.parse(route.request().postDataJSON()).name,
      description: '',
    };
    state.sent.push('POST');
    state.made.push(made);
    return route.fulfill({ status: 201, json: made });
  });
  await page.route(/\/api\/v1\/records\/con_[^/]+\/tags(?:\/tag_[^/]+)?$/, async (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    const method = route.request().method();
    if (method === 'GET')
      return route.fulfill({ json: { items: state.items, canManage: writable && !trashed } });
    state.sent.push(method);
    if (state.fail)
      return route.fulfill({
        status: 409,
        json: {
          type: 'about:blank',
          status: 409,
          title: 'Conflict',
          detail: 'This record is in the trash. Restore it before changing tags.',
        },
      });
    if (method === 'PUT') {
      expect(assignRecordTagInput.parse(route.request().postDataJSON())).toEqual({});
      const assignedId = new URL(route.request().url()).pathname.split('/').at(-1);
      const assigned: RecordTag = {
        tag: state.made.find((each) => each.id === assignedId) ?? other,
        source: { kind: 'user', eventId, you: true },
        createdAt: at,
      };
      state.items.push(assigned);
      return route.fulfill({ json: assigned });
    }
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    state.items = state.items.filter((item) => item.tag.id !== id);
    return route.fulfill({ status: 204 });
  });
  await page.route(`**/api/v1/events/${eventId}/why`, (route) =>
    route.fulfill({
      json: {
        reachesOrigin: true,
        items: [
          {
            id: eventId,
            type: 'tag.assigned',
            occurredAt: at,
            subject: { kind: 'tag', id: tagId },
            actor: { kind: 'ai_agent', name: 'Assistant', you: false },
            payload: { recordId: contactId, tagId },
            causedBy: null,
          },
        ],
      },
    }),
  );
  return state;
}

for (const width of [360, 1440]) {
  test(`shows tags side by side, explains one and adds and removes by keyboard at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page);
    const state = await recordApi(page);
    await page.goto(inHarbor(`/contacts/${contactId}`));
    const tags = page.getByRole('region', { name: 'Tags', exact: true });
    // A tag is a chip; pressing it says what it means, who added it and why.
    await tags.getByRole('button', { name: 'Hot lead', exact: true }).click();
    const about = page.getByRole('dialog', { name: 'Hot lead' });
    await expect(about.getByText('Asked for a quote.', { exact: true })).toBeVisible();
    await expect(about.getByText('AI assistant', { exact: true })).toBeVisible();
    const why = about.getByRole('button', { name: 'Why Hot lead was added' });
    await why.click();
    const explanation = about.getByRole('region', { name: 'Why Hot lead was added' });
    await expect(explanation.getByText('Tag assigned', { exact: true })).toBeVisible();
    await expect(explanation.getByText('Assistant', { exact: true })).toBeVisible();
    await explanation.getByRole('button', { name: 'Close explanation' }).click();
    await expect(why).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(about).toBeHidden();
    // The plus beside the title opens the tags that can be added, filtered as you type.
    await tags.getByRole('button', { name: 'Add tag', exact: true }).click();
    const adding = page.getByRole('dialog', { name: 'Add a tag' });
    const name = adding.getByRole('textbox', { name: 'Tag name' });
    await expect(name).toBeFocused();
    await expect(adding.getByRole('button', { name: 'VIP', exact: true })).toBeVisible();
    await expect(adding.getByRole('button', { name: 'Hot lead', exact: true })).toBeHidden();
    await name.fill('vi');
    await page.keyboard.press('Enter');
    await expect(tags.getByRole('button', { name: 'VIP', exact: true })).toBeVisible();
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('');
    await page.keyboard.press('Escape');
    await tags.getByRole('button', { name: 'Remove VIP', exact: true }).click();
    await expect(tags.getByRole('button', { name: 'VIP', exact: true })).toBeHidden();
    expect(state.sent).toEqual(['PUT', 'DELETE']);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('record-tags.png'), fullPage: true });
  });
}

test('makes a new tag from the name typed and puts it on the record', async ({ page }) => {
  await signedIn(page);
  const state = await recordApi(page);
  await page.goto(inHarbor(`/contacts/${contactId}`));
  const tags = page.getByRole('region', { name: 'Tags', exact: true });
  await tags.getByRole('button', { name: 'Add tag', exact: true }).click();
  const adding = page.getByRole('dialog', { name: 'Add a tag' });
  await adding.getByRole('textbox', { name: 'Tag name' }).fill('Smokers');
  // The button carries the tag's own name.
  const create = adding.getByRole('button', { name: 'Create tag Smokers', exact: true });
  await expect(create).toHaveText('Smokers');
  await create.click();
  await expect(tags.getByRole('button', { name: 'Smokers', exact: true })).toBeVisible();
  expect(state.sent).toEqual(['POST', 'PUT']);
  // A name already on the record is neither offered nor made again.
  await adding.getByRole('textbox', { name: 'Tag name' }).fill('hot-lead');
  await expect(adding.getByText('This tag is already on the record.')).toBeVisible();
  await expect(adding.getByRole('button', { name: /Create tag/ })).toBeHidden();
});

for (const mode of ['viewer', 'trash'] as const) {
  test(`retains tags and sources without write controls for ${mode}`, async ({ page }) => {
    await signedIn(page);
    const state = await recordApi(page, mode !== 'viewer', mode === 'trash');
    await page.goto(inHarbor(`/contacts/${contactId}`));
    const tags = page.getByRole('region', { name: 'Tags', exact: true });
    await tags.getByRole('button', { name: 'Hot lead', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Hot lead' }).getByText('AI assistant', { exact: true }),
    ).toBeVisible();
    await expect(tags.getByRole('button', { name: 'Add tag', exact: true })).toBeHidden();
    await expect(tags.getByRole('button', { name: /Remove / })).toBeHidden();
    expect(state.sent).toEqual([]);
  });
}

test('keeps what was typed and the assigned tags when a write fails', async ({ page }) => {
  await signedIn(page);
  const state = await recordApi(page);
  state.fail = true;
  await page.goto(inHarbor(`/contacts/${contactId}`));
  const tags = page.getByRole('region', { name: 'Tags', exact: true });
  await tags.getByRole('button', { name: 'Add tag', exact: true }).click();
  const adding = page.getByRole('dialog', { name: 'Add a tag' });
  await adding.getByRole('textbox', { name: 'Tag name' }).fill('VIP');
  await adding.getByRole('button', { name: 'VIP', exact: true }).click();
  await expect(tags.getByRole('alert')).toContainText('This record is in the trash.');
  await expect(adding.getByRole('textbox', { name: 'Tag name' })).toHaveValue('VIP');
  await page.keyboard.press('Escape');
  await tags.getByRole('button', { name: 'Remove Hot lead', exact: true }).click();
  await expect(tags.getByRole('button', { name: 'Hot lead', exact: true })).toBeVisible();
  expect(state.sent).toEqual(['PUT', 'DELETE']);
});
