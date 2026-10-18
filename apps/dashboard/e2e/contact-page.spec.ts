import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  createDealInput,
  sendConversationReplyInput,
  type ActivityEntry,
  type AuditEntry,
  type ContactDetails,
  type RecordField,
  type ThreadItem,
} from '@repo/contracts';
import { noAssistant } from './assistant-fixtures';
import {
  contactDetailsApi,
  detailsFor,
  emptyCompanyLinks,
  emptyRecordWork,
  openContactSection,
  plainContactDetails,
} from './contact-panels';
import { choose, expectChoice } from './select';
import { composerOf, conversationOf, messageId, messageOf } from './inbox-fixtures';
import { harbor, inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';

test.use({ timezoneId: 'America/Los_Angeles' });

const id = 'con_01m4bd188ff82s0add91b7pz63';
const eventId = 'evt_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';
const entry: ActivityEntry = {
  id: eventId,
  type: 'contact.updated',
  occurredAt: at,
  subject: { kind: 'contact', id },
  actor: { kind: 'user', name: 'Dana Brooks', you: true },
  payload: { changed: ['emails'] },
  causedBy: null,
};
const budget: RecordField = {
  definition: {
    id: 'fld_01m4bd188ff82s0add91b7pz63',
    objectKey: 'contact',
    key: 'budget',
    label: 'Budget',
    description: 'The agreed event budget.',
    valueType: 'money',
    currency: 'KES',
    options: [],
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    revision: 'a'.repeat(64),
  },
  value: '9007199254740993.25',
  source: { kind: 'ai_agent', eventId, you: false },
  updatedAt: at,
  confidence: 0.9,
  confirmedAt: null,
  revision: 'b'.repeat(64),
};
async function contactPageApi(page: Page) {
  await emptyCompanyLinks(page);
  await plainContactDetails(page);
  await page.route(`**/api/v1/contacts/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: 'Maya Thompson',
        emails: ['maya@example.com'],
        phones: [{ number: '+254712345678', display: '0712 345678' }],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        canManage: true,
      },
    }),
  );
  await page.route(`**/api/v1/contacts/${id}/deals`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            deal: {
              id: 'deal_01m4bd188ff82s0add91b7pz63',
              name: 'Garden wedding',
              pipelineId: 'pipe_01m4bd188ff82s0add91b7pz63',
              stageId: 'stage_01m4bd188ff82s0add91b7pz63',
              pipelineName: 'Weddings',
              stageName: 'New lead',
              amount: '11000.0000',
              currency: 'KES',
              expectedCloseDate: null,
              status: 'open',
              outcomeReason: null,
              closedAt: null,
              stageEnteredAt: at,
              createdAt: at,
              updatedAt: at,
              trashedAt: null,
              revision: 'a'.repeat(64),
              canManage: true,
            },
            primary: true,
          },
        ],
        more: false,
        canManage: true,
      },
    }),
  );
  await page.route(`**/api/v1/contacts/${id}/memory`, (route) =>
    route.fulfill({
      json: {
        summary: {
          text: 'Planning an outdoor wedding in October.',
          updatedAt: at,
          throughEventId: eventId,
        },
      },
    }),
  );
  await page.route(`**/api/v1/records/${id}/fields`, (route) =>
    route.fulfill({
      json: {
        items: state.fields,
        canManage: state.canManageFields,
        canConfirm: state.canManageFields,
      },
    }),
  );
  await page.route(`**/api/v1/records/${id}/tags`, (route) =>
    route.fulfill({ json: { items: [], canManage: true } }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
  const state = {
    entries: [entry],
    fields: [budget],
    cursors: [] as (string | null)[],
    failNext: false,
    canManageFields: false,
  };
  await page.route(new RegExp(`/api/v1/records/${id}/activity(?:\\?.*)?$`), (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    const after = new URL(route.request().url()).searchParams.get('after');
    state.cursors.push(after);
    if (state.failNext && after !== null)
      return route.fulfill({
        status: 503,
        json: { type: 'about:blank', title: 'Unavailable', status: 503 },
      });
    const start = after === null ? 0 : state.entries.findIndex((item) => item.id === after) + 1;
    const items = state.entries.slice(start, start + 50);
    return route.fulfill({
      json: { items, next: start + 50 < state.entries.length ? items.at(-1)?.id : null },
    });
  });
  await page.route(`**/api/v1/events/${eventId}/why`, (route) =>
    route.fulfill({ json: { items: [entry], reachesOrigin: true } }),
  );
  return state;
}

test('edits an exact field value and keeps a rejected draft for a corrected retry', async ({
  page,
}) => {
  await signedIn(page);
  const state = await contactPageApi(page);
  state.canManageFields = true;
  let reject = true;
  await page.route(`**/api/v1/records/${id}/fields/${budget.definition.id}`, async (route) => {
    const input: unknown = route.request().postDataJSON();
    const { setRecordFieldInput } = await import('@repo/contracts');
    const body = setRecordFieldInput.parse(input);
    expect(body.revision).toBe(budget.revision);
    if (reject)
      return route.fulfill({
        status: 422,
        json: {
          type: 'about:blank',
          title: 'Validation failed',
          status: 422,
          errors: [
            {
              path: '/value',
              code: 'invalid_field_value',
              message: 'Enter an exact decimal number.',
            },
          ],
        },
      });
    const saved: RecordField = {
      ...budget,
      value: body.value,
      source: { kind: 'user', you: true, eventId },
      confidence: null,
      confirmedAt: null,
      revision: 'c'.repeat(64),
    };
    state.fields = [saved];
    return route.fulfill({ json: saved });
  });
  await page.goto(inHarbor(`/contacts/${id}`));
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  await fields.getByRole('button', { name: 'Edit Budget', exact: true }).click();
  await expect(fields.getByLabel('Budget', { exact: true })).toBeFocused();
  await fields.getByLabel('Budget', { exact: true }).fill('not a number');
  await fields.getByRole('button', { name: 'Save value', exact: true }).click();
  await expect(fields.getByRole('alert')).toContainText('Enter an exact decimal number.');
  await expect(fields.getByLabel('Budget', { exact: true })).toHaveValue('not a number');
  await expect(fields.getByLabel('Budget', { exact: true })).toBeFocused();
  reject = false;
  await fields.getByLabel('Budget', { exact: true }).fill('9007199254740994.25');
  await fields.getByRole('button', { name: 'Save value', exact: true }).click();
  await expect(fields.getByText('KES 9007199254740994.25', { exact: true })).toBeVisible();
  await expect(fields.getByText('You', { exact: true })).toBeVisible();
});

test('confirms an AI value without replacing its source and returns keyboard focus', async ({
  page,
}) => {
  await signedIn(page);
  const state = await contactPageApi(page);
  state.canManageFields = true;
  await page.route(
    `**/api/v1/records/${id}/fields/${budget.definition.id}/confirm`,
    async (route) => {
      const { confirmRecordFieldInput } = await import('@repo/contracts');
      expect(confirmRecordFieldInput.parse(route.request().postDataJSON())).toEqual({
        revision: budget.revision,
      });
      const saved: RecordField = { ...budget, confirmedAt: at, revision: 'c'.repeat(64) };
      state.fields = [saved];
      await route.fulfill({ json: saved });
    },
  );
  await page.goto(inHarbor(`/contacts/${id}`));
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  await fields.getByRole('button', { name: 'Confirm Budget', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(fields.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(fields.getByText('AI assistant', { exact: true })).toBeVisible();
  await expect(fields.getByText('KES 9007199254740993.25', { exact: true })).toBeVisible();
  await expect(fields.getByRole('button', { name: 'Confirm Budget', exact: true })).toHaveCount(0);
  await expect(fields.getByRole('button', { name: 'Edit Budget', exact: true })).toBeFocused();
});

for (const width of [360, 1440]) {
  test(`edits a field accessibly at ${String(width)}px and keeps the opening revision during refresh`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page);
    const state = await contactPageApi(page);
    state.canManageFields = true;
    await page.goto(inHarbor(`/contacts/${id}`));
    const fields = page.getByRole('region', { name: 'Fields', exact: true });
    await fields.getByRole('button', { name: 'Edit Budget', exact: true }).click();
    await fields.getByLabel('Budget', { exact: true }).fill('9007199254740994.25');
    state.fields = [{ ...budget, value: '12', revision: 'd'.repeat(64) }];
    const refetched = page.waitForResponse((response) =>
      response.url().endsWith(`/records/${id}/fields`),
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    // A stale draft must send its opening revision even when the server has changed.
    await page.route(`**/api/v1/records/${id}/fields/${budget.definition.id}`, async (route) => {
      const { setRecordFieldInput } = await import('@repo/contracts');
      expect(setRecordFieldInput.parse(route.request().postDataJSON())).toEqual({
        value: '9007199254740994.25',
        revision: budget.revision,
      });
      await route.fulfill({
        status: 409,
        json: {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This value changed. Reload before editing again.',
        },
      });
    });
    await refetched;
    await expect(fields.getByLabel('Budget', { exact: true })).toHaveValue('9007199254740994.25');
    await fields.getByRole('button', { name: 'Save value', exact: true }).click();
    await expect(fields.getByRole('alert')).toContainText('This value changed.');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical'),
    ).toEqual([]);
    await fields.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(fields.getByRole('button', { name: 'Edit Budget', exact: true })).toBeFocused();
  });
}

for (const width of [360, 1440]) {
  test(`shows contact memory, identities, fields and activity accessibly at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page);
    await contactPageApi(page);
    await page.goto(inHarbor(`/contacts/${id}`));
    await expect(page.getByRole('link', { name: 'maya@example.com', exact: true })).toHaveAttribute(
      'href',
      'mailto:maya@example.com',
    );
    const fields = page.getByRole('region', { name: 'Fields', exact: true });
    await expect(fields.getByText('KES 9007199254740993.25', { exact: true })).toBeVisible();
    await expect(fields.getByText('AI assistant', { exact: true })).toBeVisible();
    // Beside the details on a wide screen; a narrow one shows one section at a time.
    if (width === 360) await openContactSection(page, 'Activity');
    const activity = page.getByRole('region', { name: 'Activity', exact: true });
    // The assistant's summary opens the activity.
    const memory = activity.getByRole('region', { name: 'What your assistant knows' });
    await expect(memory.getByText('Planning an outdoor wedding in October.')).toBeVisible();
    await expect(activity.getByText('Contact updated', { exact: true })).toBeVisible();
    await expect(activity.getByText('You', { exact: true })).toBeVisible();
    const why = activity.getByRole('button', { name: 'Why this change happened' });
    await why.focus();
    await page.keyboard.press('Enter');
    await expect(activity.getByRole('region', { name: 'Why this change happened' })).toBeVisible();
    await activity.getByRole('button', { name: 'Close explanation' }).click();
    await expect(why).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical'),
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`contact-page-${String(width)}.png`),
      fullPage: true,
    });
  });
}

test('pages newest first without gaps, retains history on failure, and rebuilds cursors after a new change', async ({
  page,
}) => {
  await signedIn(page);
  const state = await contactPageApi(page);
  const base32 = '0123456789abcdefghjkmnpqrstvwxyz';
  const eventAt = (index: number) =>
    `evt_01m4bd188ff82s0add91b7pz${base32.charAt(index >> 5)}${base32.charAt(index & 31)}`;
  state.entries = Array.from({ length: 61 }, (_, index) => ({
    ...entry,
    id: eventAt(index),
    occurredAt: new Date(Date.parse(at) - index * 1000).toISOString(),
    actor: { kind: 'user', name: `Person ${String(61 - index)}`, you: false },
  }));
  await page.goto(inHarbor(`/contacts/${id}`));
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  await expect(activity.getByRole('listitem')).toHaveCount(50);
  state.failNext = true;
  await activity.getByRole('button', { name: 'Load older activity' }).click();
  await expect(activity.getByRole('alert')).toContainText('Your current history is still here.', {
    timeout: 10000,
  });
  await expect(activity.getByRole('listitem')).toHaveCount(50);
  state.failNext = false;
  await activity.getByRole('button', { name: 'Load older activity' }).focus();
  await page.keyboard.press('Enter');
  await expect(activity.getByRole('listitem')).toHaveCount(61);
  await expect(activity.getByRole('listitem').last()).toBeFocused();
  await expect(activity.getByText('Person 1', { exact: true })).toBeVisible();
  expect(state.cursors.filter((cursor) => cursor !== null)).toContain(eventAt(49));
  state.entries.unshift({
    ...entry,
    id: eventAt(64),
    occurredAt: '2026-10-08T13:00:00.000Z',
    actor: { kind: 'automation', name: 'Newest change', you: false },
  });
  await page.evaluate(() => {
    window.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(activity.getByRole('listitem')).toHaveCount(62);
  const names = await activity
    .getByRole('listitem')
    .locator('span[data-slot="badge"]')
    .allTextContents();
  expect(names).toEqual([
    'Newest change',
    ...Array.from({ length: 61 }, (_, index) => `Person ${String(61 - index)}`),
  ]);
  expect(state.cursors.at(-1)).toBe(eventAt(48));
});

test('retries independent read failures and shows honest empty sections', async ({ page }) => {
  await signedIn(page);
  const state = await contactPageApi(page);
  state.entries = [];
  let fail = true;
  await page.route(`**/api/v1/contacts/${id}/memory`, (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { type: 'about:blank', title: 'Unavailable', status: 503 },
        })
      : route.fulfill({ json: { summary: null } }),
  );
  await page.route(`**/api/v1/records/${id}/fields`, (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto(inHarbor(`/contacts/${id}`));
  const memory = page.getByRole('region', { name: 'What your assistant knows' });
  await expect(memory.getByRole('alert')).toContainText("The summary couldn't be loaded.", {
    timeout: 10000,
  });
  await expect(page.getByRole('region', { name: 'Activity', exact: true })).toContainText(
    'No activity yet.',
  );
  await expect(page.getByRole('region', { name: 'Fields', exact: true })).toContainText(
    'No fields have been added for this record.',
  );
  fail = false;
  await memory.getByRole('button', { name: 'Try again' }).click();
  // A contact with no summary shows none: the panel is the activity alone.
  await expect(memory).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Activity', exact: true })).toContainText(
    'No activity yet.',
  );
});

test('keeps date-only days, false values, archived choices and plain text intact', async ({
  page,
}) => {
  await signedIn(page);
  const state = await contactPageApi(page);
  const values: [string, RecordField['definition']['valueType'], RecordField['value']][] = [
    ['Event date', 'date', '2026-10-31'],
    ['Booked', 'boolean', false],
    ['Unset', 'text', null],
    ['Visit', 'datetime', '2026-10-31T01:30:00Z'],
    ['Venue', 'single_choice', 'garden'],
    ['Services', 'multi_choice', ['garden', 'unknown']],
    ['Description', 'long_text', '<img src=x onerror=alert(1)>'],
  ];
  state.fields = values.map(([label, valueType, value], index) => ({
    ...budget,
    definition: {
      ...budget.definition,
      id: `fld_01m4bd188ff82s0add91b7pz6${String(index)}`,
      key: `field_${String(index)}`,
      label,
      valueType,
      currency: null,
      archived: label === 'Venue',
      options: valueType.endsWith('choice')
        ? [{ key: 'garden', label: 'Garden', description: 'Outdoor venue.', archived: true }]
        : [],
    },
    value,
    source: value === null ? null : budget.source,
    updatedAt: value === null ? null : at,
  }));
  await page.goto(inHarbor(`/contacts/${id}`));
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  await expect(fields.getByText('Oct 31, 2026', { exact: true })).toBeVisible();
  await expect(fields.getByText(/Oct 30, 2026/)).toBeVisible();
  await expect(fields.getByText('No', { exact: true })).toBeVisible();
  // An unset value shows two dashes, and reads "Not set".
  const unset = fields
    .getByRole('group', { name: 'Additional Info', exact: true })
    .locator('div')
    .filter({ has: page.getByText('Unset', { exact: true }) })
    .last();
  await expect(unset.getByText('--', { exact: true })).toBeVisible();
  await expect(unset.getByText('Not set', { exact: true })).toHaveCount(1);
  await expect(fields.getByText('Garden (archived)', { exact: true })).toBeVisible();
  await expect(fields.getByText('Garden (archived), unknown', { exact: true })).toBeVisible();
  await expect(fields.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(fields.locator('img')).toHaveCount(0);
});

/** Where a part of the page is, in whole pixels. */
async function boxOf(
  page: Page,
  role: 'region' | 'navigation',
  name: string,
): Promise<{ x: number; y: number; width: number; height: number; right: number; bottom: number }> {
  const box = await page.getByRole(role, { name, exact: true }).boundingBox();
  if (box === null) throw new Error(`${name} is not on the page`);
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
    right: Math.round(box.x + box.width),
    bottom: Math.round(box.y + box.height),
  };
}

const seriousOf = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter(
    (item) => item.impact === 'serious' || item.impact === 'critical',
  );

test('lays the contact out in three panes that fill the width at 1440px', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  await page.goto(inHarbor(`/contacts/${id}`));
  await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Activity', exact: true }).getByText('Contact updated'),
  ).toBeVisible();

  const details = await boxOf(page, 'region', 'Contact Details');
  const conversation = await boxOf(page, 'region', 'Conversations');
  const activity = await boxOf(page, 'region', 'Activity');
  const rail = await boxOf(page, 'navigation', 'Contact panels');
  // Beside the 224px sidebar with 16px gutters, 12px between the panes, and nothing left over.
  expect(details.x).toBe(224 + 16);
  expect(details.width).toBe(320);
  expect(conversation.x).toBe(details.right + 12);
  expect(rail.right).toBe(1440 - 16);
  expect(activity.x).toBeGreaterThan(conversation.right + 12);
  expect(activity.right).toBeLessThan(rail.x);
  expect(conversation.width).toBeGreaterThanOrEqual(400);
  // One row, as tall as the window leaves it: each pane scrolls by itself, not the page.
  expect(conversation.y).toBe(details.y);
  expect(conversation.bottom).toBe(details.bottom);
  expect(details.bottom).toBe(900 - 16);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollHeight <= window.innerHeight &&
        document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // The panes' own colours and corners.
  const looks = await page.evaluate(() => {
    const look = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(selector);
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.borderTopLeftRadius];
    };
    return [look('section[aria-labelledby]:has(h1)'), look('section:has(> div > div > h2)')];
  });
  expect(looks).toEqual([
    ['rgb(247, 249, 253)', '12px'],
    ['rgb(236, 238, 242)', '12px'],
  ]);
  // No section links on a wide screen: the rail chooses the panel.
  await expect(page.getByRole('navigation', { name: 'Contact sections' })).toBeHidden();
  expect(await seriousOf(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('contact-three-panes-1440.png') });
});

test('switches the details between All fields, DND and Actions, and keeps the choice in the address', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  await page.goto(inHarbor(`/contacts/${id}`));
  const tabs = page.getByRole('navigation', { name: 'Contact details', exact: true });
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  await expect(tabs.getByRole('link', { name: 'All fields', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(fields.getByText('KES 9007199254740993.25', { exact: true })).toBeVisible();

  await tabs.getByRole('link', { name: 'DND', exact: true }).click();
  await expect(page).toHaveURL(inHarbor(`/contacts/${id}?tab=dnd`));
  await expect(tabs.getByRole('link', { name: 'DND', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(fields).toBeHidden();
  // What the server has: do not disturb for every channel or for each channel it stops,
  // inbound do not disturb, the time zone quiet hours follow, and consent by channel and
  // purpose. No switch is drawn for WhatsApp, which sends nothing yet.
  const switches = page.getByRole('region', { name: 'Do not disturb', exact: true });
  await expect(switches.getByRole('checkbox')).toHaveCount(6);
  for (const name of [
    'DND all channels',
    'Email',
    'Text messages',
    'Calls & Voicemails',
    'Web chat',
    'Inbound Calls and SMS',
  ])
    await expect(switches.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  await expect(switches.getByText('OR', { exact: true })).toBeVisible();
  // Inbound blocks text messages today, and says calls are not blocked yet.
  await expect(
    switches.getByRole('checkbox', { name: 'Inbound Calls and SMS', exact: true }),
  ).toHaveAccessibleDescription(/Blocking their calls is not available yet\./);
  await expect(page.getByText(/WhatsApp/)).toHaveCount(0);
  const preferences = page.getByRole('region', { name: 'Time zone and do not contact' });
  await expect(
    preferences.getByRole('heading', { name: 'Do not contact', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Consent', exact: true })).toBeVisible();
  expect(await seriousOf(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('contact-dnd-1440.png') });

  await tabs.getByRole('link', { name: 'Actions', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(inHarbor(`/contacts/${id}?tab=actions`));
  await expect(preferences).toBeHidden();
  const workflows = page.getByRole('button', { name: 'Workflows', exact: true });
  await expect(workflows).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page
      .getByRole('region', { name: 'Workflows', exact: true })
      .getByText('No automation has run for this contact.'),
  ).toBeVisible();
  await workflows.click();
  await expect(workflows).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: 'Workflows', exact: true })).toHaveCount(0);
  // The opportunities the contact is with, each opening on the Opportunities page.
  const opportunity = page
    .getByRole('list', { name: 'Opportunities of this contact', exact: true })
    .getByRole('listitem');
  await expect(opportunity).toHaveCount(1);
  await expect(opportunity).toContainText('Weddings: New lead');
  await expect(opportunity).toContainText('KES 11,000.0000');
  await expect(opportunity).toContainText('Primary contact');
  await expect(
    opportunity.getByRole('link', { name: 'Garden wedding', exact: true }),
  ).toHaveAttribute(
    'href',
    /\/deals\?deal=deal_01m4bd188ff82s0add91b7pz63&pipelineId=pipe_01m4bd188ff82s0add91b7pz63&status=all$/,
  );
  // The client portal has nothing behind it yet, so it isn't offered.
  await expect(page.getByRole('button', { name: /Client portal/ })).toHaveCount(0);
  expect(await seriousOf(page)).toEqual([]);

  // A reload opens the same part.
  await page.reload();
  await expect(tabs.getByRole('link', { name: 'Actions', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Workflows', exact: true })).toBeVisible();
  await tabs.getByRole('link', { name: 'All fields', exact: true }).click();
  await expect(page).toHaveURL(inHarbor(`/contacts/${id}`));
  await expect(fields.getByText('KES 9007199254740993.25', { exact: true })).toBeVisible();
});

test('keeps a value being edited while the details show another part', async ({ page }) => {
  await signedIn(page);
  await emptyRecordWork(page);
  const state = await contactPageApi(page);
  state.canManageFields = true;
  await page.goto(inHarbor(`/contacts/${id}`));
  const tabs = page.getByRole('navigation', { name: 'Contact details', exact: true });
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  await fields.getByRole('button', { name: 'Edit Budget', exact: true }).click();
  await fields.getByLabel('Budget', { exact: true }).fill('12.5');
  await tabs.getByRole('link', { name: 'DND', exact: true }).click();
  await expect(fields).toBeHidden();
  await tabs.getByRole('link', { name: 'All fields', exact: true }).click();
  await expect(fields.getByLabel('Budget', { exact: true })).toHaveValue('12.5');
});

test('opens one panel at a time from the rail, in the address, and a reload keeps it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  await page.goto(inHarbor(`/contacts/${id}`));
  const rail = page.getByRole('navigation', { name: 'Contact panels', exact: true });
  // Only the panels this server has anything for.
  await expect(rail.getByRole('link')).toHaveText(['', '', '', '', '', '']);
  expect(
    await rail
      .getByRole('link')
      .evaluateAll((links) => links.map((link) => link.getAttribute('aria-label'))),
  ).toEqual(['Activity', 'Tasks', 'Notes', 'Appointments', 'Documents', 'Companies']);
  await expect(rail.getByRole('link', { name: 'Activity', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  await expect(activity.getByText('Contact updated', { exact: true })).toBeVisible();

  await rail.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page).toHaveURL(inHarbor(`/contacts/${id}?view=notes`));
  const notes = page.getByRole('region', { name: 'Notes', exact: true });
  // An empty panel: what is missing, in one bold line and one grey one.
  await expect(notes.getByText('No notes yet.', { exact: true })).toBeVisible();
  await expect(
    notes.getByText('Keep track of important details by adding the first note.', { exact: true }),
  ).toBeVisible();
  await expect(activity).toBeHidden();
  await expect(rail.getByRole('link', { name: 'Notes', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(await seriousOf(page)).toEqual([]);

  await page.reload();
  await expect(notes.getByText('No notes yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Activity', exact: true })).toHaveCount(0);

  await rail.getByRole('link', { name: 'Tasks', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(inHarbor(`/contacts/${id}?view=tasks`));
  await expect(
    page.getByRole('region', { name: 'Tasks', exact: true }).getByText('No tasks yet.'),
  ).toBeVisible();
  await rail.getByRole('link', { name: 'Companies', exact: true }).click();
  await expect(page).toHaveURL(inHarbor(`/contacts/${id}?view=companies`));
  await expect(
    page.getByRole('region', { name: 'Companies', exact: true }).getByText('No companies linked.'),
  ).toBeVisible();
  // The details and the conversation stay beside whichever panel is open.
  await expect(page.getByRole('region', { name: 'Fields', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversations', exact: true })).toBeVisible();

  // An address naming a panel this server has nothing for opens the page as usual.
  await page.goto(inHarbor(`/contacts/${id}?view=payments`));
  await expect(activity.getByText('Contact updated', { exact: true })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Activity', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByRole('region', { name: /Payments/ })).toHaveCount(0);
});

test('shows one section at a time under the contact at 360px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  await page.goto(inHarbor(`/contacts/${id}`));
  // The contact's summary stays on top; under it, one section, chosen from a row of links.
  await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Contact sections', exact: true });
  await expect(sections.getByRole('link')).toHaveText([
    'Details',
    'Conversation',
    'Activity',
    'Tasks',
    'Notes',
    'Appointments',
    'Documents',
    'Companies',
  ]);
  await expect(page.getByRole('navigation', { name: 'Contact panels' })).toBeHidden();
  await expect(sections.getByRole('link', { name: 'Details', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  const conversation = page.getByRole('region', { name: 'Conversations', exact: true });
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  await expect(fields).toBeVisible();
  await expect(conversation).toBeHidden();
  await expect(activity).toHaveCount(0);
  // Fingers do the pressing here: every link and button in the summary is 44px or more.
  const targets = await page
    .getByRole('region', { name: 'Contact Details', exact: true })
    .locator('nav a, h1 ~ a, h1 ~ button, :scope > div:first-child a')
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => Math.round(element.getBoundingClientRect().height)),
    );
  expect(targets.length).toBeGreaterThanOrEqual(12);
  expect(Math.min(...targets)).toBeGreaterThanOrEqual(44);
  const noOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noOverflow()).toBe(true);
  expect(await seriousOf(page)).toEqual([]);

  await sections.getByRole('link', { name: 'Conversation', exact: true }).click();
  await expect(page).toHaveURL(inHarbor(`/contacts/${id}?view=conversation`));
  await expect(conversation.getByText('No conversation yet', { exact: true })).toBeVisible();
  await expect(fields).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
  expect(await noOverflow()).toBe(true);
  expect(await seriousOf(page)).toEqual([]);

  await sections.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(activity.getByText('Contact updated', { exact: true })).toBeVisible();
  await expect(conversation).toBeHidden();
  await sections.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page).toHaveURL(inHarbor(`/contacts/${id}?view=notes`));
  await expect(
    page.getByRole('region', { name: 'Notes', exact: true }).getByText('No notes yet.'),
  ).toBeVisible();
  await expect(activity).toBeHidden();
  expect(await noOverflow()).toBe(true);
  expect(await seriousOf(page)).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('contact-sections-360.png'),
    fullPage: true,
  });

  // A reload opens the same section, and Details is one press away.
  await page.reload();
  await expect(sections.getByRole('link', { name: 'Notes', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await sections.getByRole('link', { name: 'Details', exact: true }).click();
  await expect(fields).toBeVisible();
});

/** Stands in for the one conversation a contact has: its thread, composer and replies. */
async function conversationApi(page: Page): Promise<{ replies: string[]; reads: string[] }> {
  const contact = { id, name: 'Maya Thompson', trashed: false };
  let current = conversationOf({ contact, unreadCount: 1 });
  let thread: ThreadItem[] = [messageOf()];
  const sent = { replies: [] as string[], reads: [] as string[] };
  await page.route(/\/api\/v1\/inbox\/assignees(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(/\/api\/v1\/conversations\?/, (route) => {
    const asked = new URL(route.request().url()).searchParams;
    // Whatever its status: a closed conversation is still the contact's conversation.
    expect([asked.get('contactId'), asked.get('status')]).toEqual([id, 'all']);
    return route.fulfill({
      json: { canManage: true, canReply: true, items: [current], nextCursor: null },
    });
  });
  await page.route(/\/api\/v1\/conversations\/cvn_[^/?]+(?:\/[a-z]+)?(?:\?.*)?$/, (route) => {
    const request = route.request();
    const action = /\/conversations\/cvn_[^/?]+\/([a-z]+)/.exec(
      new URL(request.url()).pathname,
    )?.[1];
    if (request.method() === 'GET')
      return route.fulfill({
        json:
          action === 'messages'
            ? { items: thread, nextCursor: null }
            : action === 'composer'
              ? composerOf()
              : action === 'assistant'
                ? noAssistant()
                : current,
      });
    if (action === 'read') {
      sent.reads.push((request.postDataJSON() as { through: string }).through);
      current = { ...current, unreadCount: 0 };
      return route.fulfill({ json: current });
    }
    if (action === 'replies') {
      const reply = sendConversationReplyInput.parse(request.postDataJSON());
      sent.replies.push(reply.text);
      const message = messageOf({
        id: messageId('5'),
        direction: 'outbound',
        author: { kind: 'user', name: 'Dana Brooks', you: true },
        status: 'queued',
        subject: reply.subject,
        text: reply.text,
        createdAt: '2026-10-09T08:10:00.000Z',
      });
      thread = [message, ...thread];
      return route.fulfill({ status: 201, json: message });
    }
    return route.fulfill({
      status: 404,
      json: { type: 'about:blank', title: 'Not Found', status: 404 },
    });
  });
  return sent;
}

for (const width of [360, 1440]) {
  test(`reads and answers the contact's conversation in the middle pane at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page);
    await emptyRecordWork(page);
    await contactPageApi(page);
    const sent = await conversationApi(page);
    await page.goto(inHarbor(`/contacts/${id}`));
    await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
    const conversation = page.getByRole('region', { name: 'Conversations', exact: true });
    if (width === 360) {
      // Out of sight, the conversation is neither read from the server nor marked read.
      await expect(conversation).toBeHidden();
      expect(sent.reads).toEqual([]);
      await openContactSection(page, 'Conversation');
    }
    const messages = conversation.getByRole('region', { name: 'Messages with Maya Thompson' });
    await expect(
      messages.getByText('Is June 13 still open? We’d want DJ and video.'),
    ).toBeVisible();
    await expect.poll(() => sent.reads).toEqual([messageId('1')]);
    // The contact is already open, and there is no list to go back to.
    await expect(conversation.getByRole('link', { name: 'Open contact' })).toHaveCount(0);
    await expect(conversation.getByRole('link', { name: 'Back to conversations' })).toHaveCount(0);
    // Assignment and status are the conversation's own, as in Conversations.
    await expect(conversation.getByRole('combobox', { name: 'Assigned to' })).toBeVisible();

    const form = conversation.getByRole('form', { name: 'Reply to Maya Thompson' });
    await form.getByLabel('Message to Maya Thompson', { exact: true }).fill('June 13 is open.');
    await form.getByRole('button', { name: 'Send email', exact: true }).click();
    await expect(messages.getByText('June 13 is open.', { exact: true })).toBeVisible();
    expect(sent.replies).toEqual(['June 13 is open.']);
    await page.screenshot({
      path: testInfo.outputPath(`contact-conversation-${String(width)}.png`),
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(await seriousOf(page)).toEqual([]);
  });
}

test('says so when the contact has no conversation, and offers nothing that cannot be sent', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  await page.goto(inHarbor(`/contacts/${id}`));
  const conversation = page.getByRole('region', { name: 'Conversations', exact: true });
  await expect(conversation.getByText('No conversation yet', { exact: true })).toBeVisible();
  await expect(
    conversation.getByText(
      'Messages with this contact show here once the first one is sent or received.',
      { exact: true },
    ),
  ).toBeVisible();
  // The server starts a conversation with its first message and has no way to send one
  // from here yet, so there is no box to write in.
  await expect(conversation.getByRole('textbox')).toHaveCount(0);
  await expect(conversation.getByRole('button')).toHaveCount(0);
});

test("says so when the conversation can't be read, and reads it again on request", async ({
  page,
}) => {
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  let fail = true;
  await page.route(/\/api\/v1\/conversations\?/, (route) =>
    fail
      ? route.fulfill({
          status: 403,
          json: { type: 'about:blank', title: 'Forbidden', status: 403 },
        })
      : route.fulfill({ json: { canManage: false, canReply: false, items: [], nextCursor: null } }),
  );
  await page.goto(inHarbor(`/contacts/${id}`));
  const conversation = page.getByRole('region', { name: 'Conversations', exact: true });
  await expect(conversation.getByRole('alert')).toContainText(
    "The conversation couldn't be loaded.",
  );
  // The rest of the page is as it was.
  await expect(page.getByRole('region', { name: 'Fields', exact: true })).toBeVisible();
  fail = false;
  await conversation.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(conversation.getByText('No conversation yet', { exact: true })).toBeVisible();
});

// What the contact page reads beside the contact: its owner and followers, labelled
// addresses, do not disturb by channel, who created it and its audit log.
const dana = { id: 'mem_01m4bd188ff82s0add91b7pz61', name: 'Dana Brooks', you: true };
const jordan = { id: 'mem_01m4bd188ff82s0add91b7pz62', name: 'Jordan Lee', you: false };
const priya = { id: 'mem_01m4bd188ff82s0add91b7pz64', name: 'Priya Shah', you: false };
const contactOf = {
  id,
  emails: ['maya@example.com'],
  phones: [
    { number: '+254712345678', display: '0712 345678' },
    { number: '+254733000111', display: '0733 000111' },
  ],
  createdAt: at,
  canManage: true,
};
const detailed = (rest: Partial<ContactDetails> = {}): ContactDetails =>
  detailsFor(contactOf, rest);
const leftPane = (page: Page) => page.getByRole('region', { name: 'Contact Details', exact: true });

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const width of [1440, 360]) {
  test(`chooses the owner and the followers from the team at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedIn(page);
    await emptyRecordWork(page);
    await contactPageApi(page);
    const api = await contactDetailsApi(page, detailed(), [dana, jordan, priya]);
    await page.goto(inHarbor(`/contacts/${id}`));

    const owner = leftPane(page).getByRole('combobox', { name: 'Owner', exact: true });
    await expect(owner).toHaveText('No owner');
    await choose(owner, jordan.id);
    await expect(owner).toHaveText('Jordan Lee');
    expect(api.sent).toEqual([
      { method: 'PUT', path: '/owner', body: { owner: jordan.id, revision: 'a'.repeat(64) } },
    ]);
    // The reader is "You" among the people, as they are everywhere else.
    await choose(owner, dana.id);
    await expect(owner).toHaveText('You');
    expect(api.details.owner).toEqual({ membershipId: dana.id, name: 'Dana Brooks', you: true });

    const followers = leftPane(page).getByRole('button', { name: /^Followers/ });
    await expect(followers).toHaveText('No followers');
    await followers.click();
    const people = page.getByRole('dialog', { name: 'Followers', exact: true });
    await expect(people.getByText('Up to 10 people can follow a contact.')).toBeVisible();
    await expectNoViolations(page);
    // A box shows what the server holds: it is ticked once the server has answered.
    const jordanBox = people.getByRole('checkbox', { name: 'Jordan Lee', exact: true });
    await jordanBox.click();
    await expect(jordanBox).toBeChecked();
    await expect(followers).toHaveText('Jordan Lee');
    await people.getByRole('checkbox', { name: 'Priya Shah', exact: true }).click();
    await expect(followers).toHaveText('2 followers');
    await jordanBox.click();
    await expect(jordanBox).not.toBeChecked();
    await expect(followers).toHaveText('Priya Shah');
    expect(api.sent.slice(2)).toEqual([
      { method: 'POST', path: '/followers', body: { followers: [jordan.id] } },
      { method: 'POST', path: '/followers', body: { followers: [priya.id] } },
      { method: 'DELETE', path: '/followers', body: { followers: [jordan.id] } },
    ]);
    await page.keyboard.press('Escape');
    await expect(followers).toBeFocused();
    await expectNoViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // Each chip is big enough for a finger below the desktop layout.
    if (width === 360)
      for (const control of [owner, followers])
        expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  });
}

test('an owner change someone else got in first is refused, and the latest is shown', async ({
  page,
}) => {
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  const api = await contactDetailsApi(page, detailed(), [dana, jordan]);
  await page.goto(inHarbor(`/contacts/${id}`));
  const owner = leftPane(page).getByRole('combobox', { name: 'Owner', exact: true });
  await expect(owner).toHaveText('No owner');
  // The page has finished arriving (the fields tab reads the details too, a moment later).
  await expect(page.getByRole('region', { name: 'Fields', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  // A teammate gives the contact to Jordan meanwhile.
  api.details = {
    ...api.details,
    owner: { membershipId: jordan.id, name: 'Jordan Lee', you: false },
    ownerRevision: 'f'.repeat(64),
  };
  await choose(owner, dana.id);
  await expect(leftPane(page).getByRole('alert')).toContainText(
    "Someone else changed this while you had it open, so your change wasn't saved.",
  );
  await expect(owner).toHaveText('Jordan Lee');
  expect(api.details.owner?.membershipId).toBe(jordan.id);
});

test('someone who may not change the contact reads its owner, followers and labels', async ({
  page,
}) => {
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  const plain = detailed();
  await contactDetailsApi(
    page,
    {
      ...plain,
      canManage: false,
      // Someone who has left the team is still the owner until it is changed.
      owner: { membershipId: null, name: null, you: false },
      followers: [{ membershipId: jordan.id, name: 'Jordan Lee', you: false }],
      addresses: plain.addresses.map((address, index) =>
        index === 1 ? { ...address, label: 'mobile' as const } : address,
      ),
    },
    [dana, jordan],
  );
  await page.goto(inHarbor(`/contacts/${id}`));
  await expect(leftPane(page).getByText('Former team member', { exact: true })).toBeVisible();
  await expect(leftPane(page).getByText('Jordan Lee', { exact: true })).toBeVisible();
  await expect(leftPane(page).getByRole('combobox', { name: 'Owner' })).toHaveCount(0);
  await expect(leftPane(page).getByRole('button', { name: /^Followers/ })).toHaveCount(0);
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  await expect(fields.getByText('Mobile', { exact: true })).toBeVisible();
  await expect(fields.getByRole('button', { name: 'Add phone' })).toHaveCount(0);
  await expect(fields.getByRole('combobox')).toHaveCount(0);
});

test('labels a phone number, makes another the primary and adds an email where they are', async ({
  page,
}) => {
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  const api = await contactDetailsApi(page, detailed(), [dana]);
  await page.goto(inHarbor(`/contacts/${id}`));
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  const [, first, second] = api.details.addresses;
  await choose(
    fields.getByRole('combobox', { name: 'Label for 0712 345678', exact: true }),
    'work',
  );
  await expect(
    fields.getByRole('combobox', { name: 'Label for 0712 345678', exact: true }),
  ).toHaveText('Work');
  // The other number cannot take the label this one has.
  await fields.getByRole('combobox', { name: 'Label for 0733 000111', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Work', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await fields.getByRole('button', { name: 'Make 0733 000111 the primary', exact: true }).click();
  await expect(
    fields.getByRole('button', { name: 'Make 0712 345678 the primary', exact: true }),
  ).toBeVisible();

  await fields.getByRole('button', { name: 'Add email', exact: true }).click();
  await fields
    .getByRole('textbox', { name: 'New email address', exact: true })
    .fill('MW@example.com');
  await page.keyboard.press('Enter');
  await expect(fields.getByRole('link', { name: 'mw@example.com', exact: true })).toBeVisible();
  await expect(fields.getByRole('button', { name: 'Add email', exact: true })).toBeFocused();
  expect(api.sent).toEqual([
    {
      method: 'PATCH',
      path: `/addresses/${first?.id ?? ''}`,
      body: { label: 'work', revision: 'a'.repeat(64) },
    },
    {
      method: 'PATCH',
      path: `/addresses/${second?.id ?? ''}`,
      body: { primary: true, revision: '1'.repeat(64) },
    },
    { method: 'POST', path: '/addresses', body: { kind: 'email', value: 'MW@example.com' } },
  ]);
  await expectNoViolations(page);
});

test('turns do not disturb on for one channel with a reason, then for every channel', async ({
  page,
}) => {
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  // WhatsApp was switched off through the API: nothing is sent there yet, and it is kept.
  const api = await contactDetailsApi(
    page,
    detailed({
      dnd: { all: false, channels: ['whatsapp'], inbound: false, revision: 'a'.repeat(64) },
    }),
    [dana],
  );
  await page.goto(inHarbor(`/contacts/${id}?tab=dnd`));
  const switches = page.getByRole('region', { name: 'Do not disturb', exact: true });
  const sms = switches.getByRole('checkbox', { name: 'Text messages', exact: true });
  await expect(sms).not.toBeChecked();
  // Nothing to save, and no reason asked, until a switch changes.
  await expect(switches.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await sms.check();
  await expect(switches.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await switches.getByLabel('Reason').fill('Asked by phone to get no more text messages.');
  await expectNoViolations(page);
  await switches.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(switches.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(sms).toBeChecked();
  expect(api.sent[0]).toEqual({
    method: 'PUT',
    path: '/dnd',
    body: {
      all: false,
      channels: ['sms', 'whatsapp'],
      inbound: false,
      reason: 'Asked by phone to get no more text messages.',
      revision: 'a'.repeat(64),
    },
  });

  // A change put back is no change: the reason and Save go away again.
  await switches.getByRole('checkbox', { name: 'Email', exact: true }).check();
  await switches.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(switches.getByRole('checkbox', { name: 'Email', exact: true })).not.toBeChecked();
  await expect(switches.getByLabel('Reason')).toHaveCount(0);

  await switches.getByRole('checkbox', { name: 'DND all channels', exact: true }).check();
  // "All channels" stands for each of them.
  await expect(switches.getByRole('checkbox', { name: 'Email', exact: true })).toBeDisabled();
  await expect(switches.getByRole('checkbox', { name: 'Email', exact: true })).toBeChecked();
  await switches.getByLabel('Reason').fill('Asked not to be contacted at all.');
  await switches.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(switches.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  expect(api.details.dnd).toMatchObject({ all: true, channels: ['sms', 'whatsapp'] });
});

test('stops calls and web chat, and blocks inbound text messages, apart from every channel', async ({
  page,
}) => {
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  const api = await contactDetailsApi(page, detailed(), [dana]);
  await page.goto(inHarbor(`/contacts/${id}?tab=dnd`));
  const switches = page.getByRole('region', { name: 'Do not disturb', exact: true });
  const calls = switches.getByRole('checkbox', { name: 'Calls & Voicemails', exact: true });
  const chat = switches.getByRole('checkbox', { name: 'Web chat', exact: true });
  const inbound = switches.getByRole('checkbox', { name: 'Inbound Calls and SMS', exact: true });
  await calls.check();
  await chat.check();
  await inbound.check();
  await switches
    .getByLabel('Reason')
    .fill('Asked to hear nothing more from us, and calls at night.');
  await switches.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(switches.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  expect(api.sent.at(-1)).toEqual({
    method: 'PUT',
    path: '/dnd',
    body: {
      all: false,
      channels: ['call', 'webchat'],
      inbound: true,
      reason: 'Asked to hear nothing more from us, and calls at night.',
      revision: 'a'.repeat(64),
    },
  });
  await expect(inbound).toBeChecked();

  // Every channel stands for each outbound one, and leaves inbound to its own switch.
  await switches.getByRole('checkbox', { name: 'DND all channels', exact: true }).check();
  await expect(calls).toBeDisabled();
  await expect(chat).toBeChecked();
  await expect(inbound).toBeEnabled();
  await inbound.uncheck();
  await switches.getByLabel('Reason').fill('Asked by phone: nothing sent, but texts may come in.');
  await switches.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(switches.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  expect(api.details.dnd).toMatchObject({
    all: true,
    channels: ['call', 'webchat'],
    inbound: false,
  });
  await expectNoViolations(page);
});

for (const width of [1440, 360]) {
  test(`says who created the contact, and opens its audit log at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedIn(page);
    await emptyRecordWork(page);
    await contactPageApi(page);
    await contactDetailsApi(
      page,
      detailed({
        createdBy: { kind: 'form', name: 'Wedding enquiry', you: false },
        createdSource: 'form',
        canReadAudit: true,
      }),
      [dana],
    );
    const entries: AuditEntry[] = [
      {
        id: 'aud_01m4bd188ff82s0add91b7pz63',
        at,
        command: 'contact.set_dnd',
        outcome: 'ok',
        errorCode: null,
        actor: { kind: 'user', name: 'Dana Brooks', you: true },
        proposed: false,
        events: [{ id: eventId, type: 'contact.dnd_changed' }],
        detail: { all: false, channels: ['sms'], reason: 'Asked by phone on 9 October.' },
      },
      {
        id: 'aud_01m4bd188ff82s0add91b7pz64',
        at,
        command: 'contact.create',
        outcome: 'ok',
        errorCode: null,
        actor: { kind: 'form', name: 'Wedding enquiry', you: false },
        proposed: false,
        events: [{ id: eventId, type: 'contact.created' }],
        detail: {},
      },
    ];
    const asked: (string | null)[] = [];
    await page.route(new RegExp(`/api/v1/records/${id}/audit-log(?:\\?.*)?$`), (route) => {
      const after = new URL(route.request().url()).searchParams.get('after');
      asked.push(after);
      return route.fulfill({
        json:
          after === null
            ? { items: entries.slice(0, 1), next: entries[0]?.id ?? null }
            : { items: entries.slice(1), next: null },
      });
    });
    await page.goto(inHarbor(`/contacts/${id}`));
    await expect(
      leftPane(page).getByText('Created by Wedding enquiry, from a form', { exact: true }),
    ).toBeVisible();
    await expect(leftPane(page).getByText(/^Created on /)).toBeVisible();
    const button = leftPane(page).getByRole('button', { name: 'Audit logs', exact: true });
    await button.click();
    const log = page.getByRole('dialog', { name: 'Audit logs', exact: true });
    await expect(log.getByRole('listitem')).toHaveCount(1);
    await expect(log.getByRole('listitem').first()).toContainText('Do not disturb changed');
    await expect(log.getByRole('listitem').first()).toContainText('You');
    await expect(log.getByRole('listitem').first()).toContainText(
      'Reason: Asked by phone on 9 October.',
    );
    await expectNoViolations(page);
    await log.getByRole('button', { name: 'Load older entries', exact: true }).click();
    await expect(log.getByRole('listitem')).toHaveCount(2);
    await expect(log.getByRole('listitem').nth(1)).toContainText('Contact created');
    await expect(log.getByRole('listitem').nth(1)).toContainText('Wedding enquiry');
    await expect(log.getByRole('button', { name: 'Load older entries' })).toHaveCount(0);
    expect(asked).toEqual([null, 'aud_01m4bd188ff82s0add91b7pz63']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press('Escape');
    await expect(log).toBeHidden();
    await expect(button).toBeFocused();
  });
}

test('offers no audit log to someone who may not read it', async ({ page }) => {
  await signedIn(page);
  await emptyRecordWork(page);
  await contactPageApi(page);
  await page.goto(inHarbor(`/contacts/${id}`));
  await expect(
    leftPane(page).getByText('Created by You, in the app', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Audit logs' })).toHaveCount(0);
});

for (const width of [1440, 360]) {
  test(`adds an opportunity from the contact, with the contact as its primary contact, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedIn(page);
    await emptyRecordWork(page);
    await contactPageApi(page);
    const stage = (number: number, name: string) => ({
      id: `stage_01m4bd188ff82s0add91b7pz6${String(number)}`,
      name,
      description: '',
      archived: false,
    });
    const pipelineOf = (number: number, name: string, archived = false) => ({
      id: `pipe_01m4bd188ff82s0add91b7pz6${String(number)}`,
      name,
      description: '',
      archived,
      stages: [stage(number, `${name} enquiry`)],
    });
    const [old, weddings, corporate] = [
      pipelineOf(1, 'Old', true),
      pipelineOf(3, 'Weddings'),
      pipelineOf(4, 'Corporate events'),
    ];
    await page.route('**/api/v1/pipelines', (route) =>
      route.fulfill({
        json: { items: [old, weddings, corporate], revision: 'b'.repeat(64), canManage: false },
      }),
    );
    const created: unknown[] = [];
    await page.route('**/api/v1/deals', async (route) => {
      const input = createDealInput.parse(route.request().postDataJSON());
      created.push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        json: {
          id: 'deal_01m4bd188ff82s0add91b7pz69',
          name: input.name,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
          pipelineName: 'Corporate events',
          stageName: 'Corporate events enquiry',
          amount: input.amount,
          currency: input.currency,
          expectedCloseDate: input.expectedCloseDate,
          status: input.status,
          outcomeReason: input.outcomeReason,
          closedAt: null,
          stageEnteredAt: at,
          createdAt: at,
          updatedAt: at,
          trashedAt: null,
          source: null,
          revision: 'c'.repeat(64),
          canManage: true,
        },
      });
    });
    let reads = 0;
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().endsWith(`/contacts/${id}/deals`)) reads += 1;
    });
    await page.goto(inHarbor(`/contacts/${id}?tab=actions`));
    const add = page.getByRole('button', { name: 'Add opportunity', exact: true });
    await expect(add).toBeVisible();
    expect((await add.boundingBox())?.height).toBeGreaterThanOrEqual(width < 1024 ? 44 : 32);
    await expect.poll(() => reads).toBe(1);
    await add.click();
    const dialog = page.getByRole('dialog', { name: 'Add new opportunity', exact: true });
    // The contact is there already, and can still be taken off.
    await expect(dialog).toContainText('Maya Thompson');
    await expect(
      dialog.getByRole('button', { name: 'Remove the primary contact', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole('searchbox')).toHaveCount(0);
    await expect(dialog.getByLabel('Opportunity name')).toBeFocused();
    // The first pipeline in use, and any other in use on offer.
    const pipeline = dialog.getByRole('combobox', { name: 'Pipeline', exact: true });
    await expectChoice(pipeline, weddings.id);
    await expectNoViolations(page);
    await choose(pipeline, corporate.id);
    await expectChoice(
      dialog.getByRole('combobox', { name: 'Stage', exact: true }),
      corporate.stages[0]?.id ?? '',
    );
    await dialog.getByLabel('Opportunity name').fill('Garden party');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Garden party saved.', { exact: true })).toBeVisible();
    await expect(add).toBeFocused();
    expect(created).toEqual([
      {
        name: 'Garden party',
        pipelineId: corporate.id,
        stageId: corporate.stages[0]?.id,
        amount: null,
        currency: 'KES',
        expectedCloseDate: null,
        status: 'open',
        outcomeReason: null,
        source: null,
        primaryContactId: id,
      },
    ]);
    // The contact's opportunities are read again.
    await expect.poll(() => reads).toBe(2);
    await expectNoViolations(page);
  });
}
