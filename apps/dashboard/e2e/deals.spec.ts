import { choose, expectChoice } from './select';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  bulkDealsInput,
  createDealInput,
  dealListQuery,
  setDealContactsInput,
  updateDealInput,
  updateOpportunitySettingsInput,
  type DealDetails,
} from '@repo/contracts';
import { signedIn, inHarbor } from './session';
import { emptyRecordWork } from './contact-panels';
import { openFilters, reachesRightGutter, savedViews, viewActions } from './lists';

// Opportunities (the deals of the API), on the board and in the list, and the dialog one
// opens in, against the built dashboard with the API stood in for. The real server is
// exercised by @repo/e2e.

const pipelineId = 'pipe_01m4bd188ff82s0add91b7pz63';
const firstStage = 'stage_01m4bd188ff82s0add91b7pz63';
const secondStage = 'stage_01m4bd9fteedat3be9bqgx2047';
const at = '2026-10-08T12:00:00.000Z';
const original = {
  id: 'deal_01m4bd188ff82s0add91b7pz63',
  name: 'Maya’s wedding',
  pipelineId,
  stageId: firstStage,
  pipelineName: 'Weddings',
  stageName: 'New lead',
  amount: '11000.0000' as string | null,
  currency: 'KES',
  expectedCloseDate: '2027-06-13',
  status: 'open',
  outcomeReason: null,
  closedAt: null,
  stageEnteredAt: at,
  createdAt: at,
  updatedAt: at,
  trashedAt: null as string | null,
  source: null as string | null,
  revision: 'a'.repeat(64),
  canManage: true,
};
/** What the list adds to an opportunity when asked: its primary contact, owner and tags. */
interface ListExtras {
  primaryContact?: DealDetails['primaryContact'];
  owner?: DealDetails['owner'];
  tags?: { id: string; name: string }[];
  /** The opportunity's own chance of being won, read where its pipeline says so. */
  probability?: number | null;
}
type StoredDeal = typeof original & ListExtras;

// The people and contacts the opportunity dialog reads and changes (GET /deals/{id}/details).
const dana = { membershipId: 'mem_01m4bd188ff82s0add91b7pz61', name: 'Dana Brooks', you: true };
const lee = { membershipId: 'mem_01m4bd188ff82s0add91b7pz62', name: 'Lee Park', you: false };
const maya = {
  id: 'con_01m4bd188ff82s0add91b7pz61',
  name: 'Maya Thompson',
  email: 'maya@example.com',
  phone: { number: '+254712345678', display: '0712 345678' },
  trashed: false,
};
const omar = {
  id: 'con_01m4bd188ff82s0add91b7pz62',
  name: 'Omar Said',
  email: 'omar@example.com',
  phone: null,
  trashed: false,
};
const zuri = {
  id: 'con_01m4bd188ff82s0add91b7pz63',
  name: 'Zuri Kim',
  email: 'zuri@example.com',
  phone: null,
  trashed: false,
};
const contactBook = [maya, omar, zuri];
const emptyDetails: DealDetails = {
  id: original.id,
  owner: null,
  ownerRevision: 'd'.repeat(64),
  followers: [],
  primaryContact: null,
  additionalContacts: [],
  contactsRevision: 'e'.repeat(64),
  createdBy: { kind: 'user', name: 'Lee Park', you: false },
  createdAt: at,
  canManage: true,
  canReadAudit: false,
};
const pipeline = {
  id: pipelineId,
  name: 'Weddings',
  description: '',
  archived: false,
  stages: [
    { id: firstStage, name: 'New lead', description: '', archived: false },
    { id: secondStage, name: 'Proposal sent', description: '', archived: false },
  ],
};
const corporatePipeline = {
  ...pipeline,
  id: 'pipe_01m4bd9fteedat3be9bqgx2047',
  name: 'Corporate events',
  stages: [
    { id: 'stage_01m4bd9fteedat3be9bqgx2048', name: 'Enquiry', description: '', archived: false },
  ],
};
/** More opportunities of the first pipeline, each with what makes it differ. */
const another = (index: number, changes: Partial<StoredDeal>): StoredDeal => ({
  ...original,
  id: `deal_01m4bd188ff82s0add91b7pz6${String(index + 3)}`,
  ...changes,
});

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** What a read was asked with, after the question mark. */
  readonly query?: URLSearchParams;
}
/** The business's opportunity settings, as GET /opportunity-settings answers them. */
const savedSettings = {
  allowDifferentOwners: false,
  opportunityOwnerFollowsContact: true,
  contactOwnerFollowsOpportunity: false,
  revision: '5'.repeat(64),
};

async function setup(
  page: Page,
  options: {
    fail?: boolean;
    viewer?: boolean;
    empty?: boolean;
    multiplePipelines?: boolean;
    /** The pipelines the business has, when not the one or two above. */
    pipelines?: (typeof pipeline & Record<string, unknown>)[];
    delay?: Promise<void>;
    deals?: StoredDeal[];
    /**
     * A pipeline with more opportunities than a page: the list says there is another page
     * (an empty one), and the server answers this as its count and totals by stage.
     */
    summary?: unknown;
    /** Where the test starts, under the business. */
    path?: string;
    /** Who the opportunities are with and whose they are, as the dialog reads it. */
    details?: Partial<DealDetails>;
    /** What POST /deals/bulk answers for each opportunity named; left out, every one is done. */
    bulkOutcome?: (id: string) => 'done' | 'unchanged' | 'skipped';
  } = {},
) {
  await signedIn(page);
  await emptyRecordWork(page);
  await page.route(/\/api\/v1\/records\/deal_[^/]+\/activity(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  await page.route(/\/api\/v1\/records\/deal_[^/]+\/fields$/, (route) =>
    route.fulfill({ json: { items: [], canManage: !options.viewer, canConfirm: false } }),
  );
  let items: StoredDeal[] = options.empty
    ? []
    : (options.deals ?? [original]).map((deal) => ({ ...deal, canManage: !options.viewer }));
  const sent: unknown[] = [];
  const requests: Sent[] = [];
  const everyPipeline =
    options.pipelines ?? (options.multiplePipelines ? [pipeline, corporatePipeline] : [pipeline]);
  await page.route('**/api/v1/pipelines', (route) =>
    route.fulfill({
      json: { items: everyPipeline, revision: 'b'.repeat(64), canManage: false },
    }),
  );
  let settings = { ...savedSettings };
  await page.route('**/api/v1/opportunity-settings', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = updateOpportunitySettingsInput.parse(request.postDataJSON());
      requests.push({ method: 'PUT', path: '/opportunity-settings', body });
      settings = { ...body, revision: '6'.repeat(64) };
    }
    await route.fulfill({ json: { ...settings, canManage: !options.viewer } });
  });
  await page.route(/\/api\/v1\/deals(?:[/?].*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const id = /\/deals\/(deal_[^/]+)$/.exec(url.pathname)?.[1];
    requests.push({
      method: request.method(),
      path: url.pathname.replace('/api/v1', ''),
      body: request.postData() === null ? null : (request.postDataJSON() as unknown),
      ...(request.method() === 'GET' ? { query: url.searchParams } : {}),
    });
    if (request.method() === 'GET' && url.pathname.endsWith('/deals/stage-summary')) {
      await (options.summary === undefined
        ? route.fulfill({
            status: 404,
            contentType: 'application/problem+json',
            json: { type: 'about:blank', title: 'Not Found', status: 404 },
          })
        : route.fulfill({ json: options.summary }));
      return;
    }
    if (request.method() === 'GET' && id !== undefined) {
      const found = items.find((item) => item.id === id);
      await (found === undefined
        ? route.fulfill({
            status: 404,
            contentType: 'application/problem+json',
            json: { type: 'about:blank', title: 'Not Found', status: 404 },
          })
        : route.fulfill({ json: found }));
      return;
    }
    if (request.method() === 'GET') {
      const query = url.searchParams;
      // Only what the server takes is ever asked.
      dealListQuery.parse(Object.fromEntries(query));
      const status = query.get('status');
      // The server searches: here, by the opportunity's name.
      const q = (query.get('q') ?? '').toLowerCase();
      const kept = items.filter(
        (item) =>
          item.trashedAt === null &&
          (status === 'all' || item.status === status) &&
          (query.get('pipelineId') === null || item.pipelineId === query.get('pipelineId')) &&
          item.name.toLowerCase().includes(q),
      );
      const more = options.summary !== undefined && !query.has('after');
      await route.fulfill({
        json: {
          items: query.has('after') ? [] : kept,
          next: more ? (kept.at(-1)?.id ?? null) : null,
          canManage: !options.viewer,
        },
      });
      return;
    }
    if (request.method() === 'DELETE') {
      items = items.map((item) => (item.id === id ? { ...item, trashedAt: at } : item));
      await route.fulfill({ json: items.find((item) => item.id === id) });
      return;
    }
    const body = request.postDataJSON() as StoredDeal;
    sent.push(body);
    await options.delay;
    if (options.fail) {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        json: {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This deal changed. Reload before saving.',
        },
      });
      return;
    }
    // A new opportunity's contacts are linked, not kept on the opportunity itself.
    const {
      primaryContactId: _primary,
      additionalContactIds: _additional,
      ...kept
    } = body as StoredDeal & { primaryContactId?: string; additionalContactIds?: string[] };
    const current = {
      ...original,
      ...(id === undefined ? {} : { id }),
      ...kept,
      pipelineName: everyPipeline.find((each) => each.id === body.pipelineId)?.name ?? 'Weddings',
      stageName:
        everyPipeline.flatMap((each) => each.stages).find((stage) => stage.id === body.stageId)
          ?.name ?? 'New lead',
      revision: 'c'.repeat(64),
    };
    items =
      request.method() === 'POST'
        ? [...items, current]
        : items.map((item) => (item.id === current.id ? current : item));
    await route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: current });
  });
  // The dialog's people and contacts: one read, and each change answers the same shape.
  let details: DealDetails = { ...emptyDetails, canManage: !options.viewer, ...options.details };
  await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        items: [dana, lee].map((person) => ({
          id: person.membershipId,
          name: person.name,
          you: person.you,
        })),
        nextCursor: null,
      },
    }),
  );
  await page.route(/\/api\/v1\/contacts\?(?:.*&)?q=/, (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
    return route.fulfill({
      json: {
        items: contactBook
          .filter((contact) => contact.name.toLowerCase().includes(q))
          .map(({ trashed: _trashed, ...contact }) => ({ ...contact, createdAt: at })),
        next: null,
        canManage: true,
      },
    });
  });
  await page.route(
    /\/api\/v1\/deals\/deal_[^/]+\/(?:details|owner|followers|contacts)$/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const part = url.pathname.split('/').at(-1);
      if (request.method() !== 'GET') {
        const body = request.postDataJSON() as Record<string, unknown>;
        requests.push({
          method: request.method(),
          path: url.pathname.replace('/api/v1', ''),
          body,
        });
        const personOf = (id: unknown) => [dana, lee].find((each) => each.membershipId === id);
        if (part === 'owner')
          details = {
            ...details,
            owner: personOf(body['owner']) ?? null,
            ownerRevision: 'f'.repeat(64),
          };
        if (part === 'followers') {
          const named = (body['followers'] as string[]).flatMap((id) => personOf(id) ?? []);
          details = {
            ...details,
            followers:
              request.method() === 'POST'
                ? [...details.followers, ...named]
                : details.followers.filter((each) => !named.includes(each as typeof dana)),
          };
        }
        if (part === 'contacts') {
          const input = setDealContactsInput.parse(body);
          const contactOf = (id: string) => contactBook.find((each) => each.id === id);
          details = {
            ...details,
            primaryContact:
              input.primaryContactId === null ? null : (contactOf(input.primaryContactId) ?? null),
            additionalContacts: input.additionalContactIds.flatMap((id) => contactOf(id) ?? []),
            contactsRevision: '9'.repeat(64),
          };
        }
        // An owner change moves the opportunity's own revision, as the server's does.
        if (part === 'owner')
          items = items.map((item) =>
            item.id === details.id ? { ...item, revision: '8'.repeat(64) } : item,
          );
      }
      await route.fulfill({ json: details });
    },
  );
  await page.route('**/api/v1/deals/bulk', async (route) => {
    const input = bulkDealsInput.parse(route.request().postDataJSON());
    requests.push({ method: 'POST', path: '/deals/bulk', body: input });
    const results = input.ids.map((id) => {
      const outcome = options.bulkOutcome?.(id) ?? 'done';
      return {
        id,
        outcome,
        reason: outcome === 'skipped' ? { code: 'in_trash', message: 'It is in the trash.' } : null,
      };
    });
    const changed = new Set(
      results.filter((each) => each.outcome === 'done').map((each) => each.id),
    );
    if (input.action === 'trash')
      items = items.map((item) => (changed.has(item.id) ? { ...item, trashedAt: at } : item));
    if (input.action === 'set_status')
      items = items.map((item) =>
        changed.has(item.id) ? { ...item, status: input.status } : item,
      );
    const count = (outcome: string) => results.filter((each) => each.outcome === outcome).length;
    await route.fulfill({
      json: {
        action: input.action,
        results,
        done: count('done'),
        unchanged: count('unchanged'),
        skipped: count('skipped'),
        bulkActionId: changed.size === 0 ? null : 'bulk_01m4bd188ff82s0add91b7pz63',
      },
    });
  });
  await page.goto(inHarbor(options.path ?? '/deals'));
  return Object.assign(sent, { requests });
}

const expectNoViolations = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
};

/** The dialog an opportunity opens in, by its title. */
const dialogOf = (page: Page, title: string) =>
  page.getByRole('dialog', { name: title, exact: true });
const editing = (page: Page) => dialogOf(page, 'Edit Maya’s wedding');
const adding = (page: Page) => dialogOf(page, 'Add new opportunity');
/** The card's or the row's name, which opens the opportunity. */
const opener = (page: Page, name = 'Maya’s wedding') =>
  page.getByRole('link', { name, exact: true });
const guard = (page: Page) => dialogOf(page, 'You have unsaved changes');
/** The last request that changed something: reads made after it are left out. */
const lastChange = (sent: { readonly requests: Sent[] }): Sent | undefined =>
  sent.requests.findLast((request) => request.method !== 'GET');

async function drag(page: Page) {
  const source = page.getByRole('button', { name: 'Move Maya’s wedding' });
  const target = page.getByRole('region', { name: 'Proposal sent' });
  const start = await source.boundingBox();
  const end = await target.boundingBox();
  if (start === null || end === null) throw new Error('Missing drag geometry.');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2, { steps: 3 });
  await page.mouse.move(end.x + end.width / 2, end.y + 90, { steps: 12 });
  await page.mouse.up();
}
test('moves a card optimistically, then rolls back and explains a rejected save', async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = await setup(page, { fail: true, delay });
  await drag(page);
  await expect(
    page
      .getByRole('region', { name: 'Proposal sent' })
      .getByRole('heading', { name: 'Maya’s wedding', exact: true }),
  ).toBeVisible();
  expect(sent).toHaveLength(1);
  release?.();
  await expect(page.getByRole('alert')).toContainText('This deal changed');
  await expect(
    page
      .getByRole('region', { name: 'New lead' })
      .getByRole('heading', { name: 'Maya’s wedding', exact: true }),
  ).toBeVisible();
});

test('refreshes a field-filtered deal list after changing that field in the record editor', async ({
  page,
}) => {
  await setup(page);
  const typeId = 'fld_01m4bd188ff82s0add91b7pz63';
  const definition = {
    id: typeId,
    objectKey: 'deal',
    key: 'capacity',
    label: 'Guest count',
    description: 'Expected guests.',
    valueType: 'number',
    currency: null,
    options: [],
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    revision: 'b'.repeat(64),
  };
  let value = '20';
  await page.route('**/api/v1/fields', (route) =>
    route.fulfill({
      json: { items: [definition], objects: [{ key: 'deal', label: 'Deal' }], canManage: false },
    }),
  );
  await page.route(`**/api/v1/records/${original.id}/fields`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            definition,
            value,
            source: { kind: 'user', you: true, eventId: null },
            updatedAt: at,
            confidence: null,
            confirmedAt: null,
            revision: 'c'.repeat(64),
          },
        ],
        canManage: true,
        canConfirm: true,
      },
    }),
  );
  await page.route(`**/api/v1/records/${original.id}/fields/${typeId}`, async (route) => {
    const { setRecordFieldInput } = await import('@repo/contracts');
    const body = setRecordFieldInput.parse(route.request().postDataJSON());
    expect(body.value).toBe('5');
    value = '5';
    await route.fulfill({
      json: {
        definition,
        value,
        source: { kind: 'user', you: true, eventId: null },
        updatedAt: at,
        confidence: null,
        confirmedAt: null,
        revision: 'd'.repeat(64),
      },
    });
  });
  await page.route(/\/api\/v1\/deals(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { items: value === '20' ? [original] : [], next: null, canManage: true },
    }),
  );
  await page.reload();
  const filters = await openFilters(page);
  await filters.getByRole('button', { name: 'Guest count', exact: true }).click();
  await choose(filters.getByRole('combobox', { name: 'Match', exact: true }), 'gt');
  await filters.getByLabel('Field value', { exact: true }).fill('10');
  await filters.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Filters (1)', exact: true })).toBeFocused();
  await opener(page).click();
  const fields = editing(page).getByRole('region', { name: 'Fields', exact: true });
  await fields.getByRole('button', { name: 'Edit Guest count', exact: true }).click();
  await fields.getByLabel('Guest count', { exact: true }).fill('5');
  await fields.getByRole('button', { name: 'Save value', exact: true }).click();
  await expect(
    page.getByText('No opportunities match these filters.', { exact: true }),
  ).toBeVisible();
});
test('moves a card by keyboard and keeps the saved stage after reload', async ({ page }) => {
  const sent = await setup(page);
  const handle = page.getByRole('button', { name: 'Move Maya’s wedding' });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(
    page
      .getByRole('region', { name: 'Proposal sent' })
      .getByRole('heading', { name: 'Maya’s wedding', exact: true }),
  ).toBeVisible();
  await expect.poll(() => sent).toHaveLength(1);
  await expect(
    page.getByText('Maya’s wedding moved to Proposal sent.', { exact: true }),
  ).toBeVisible();
  await expect(handle).toBeFocused();
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Proposal sent' })
      .getByRole('heading', { name: 'Maya’s wedding', exact: true }),
  ).toBeVisible();
});
test('adds, edits and closes an opportunity with a reason, and shares board and list filters', async ({
  page,
}) => {
  const sent = await setup(page, { empty: true });
  await page.getByRole('button', { name: 'Add opportunity', exact: true }).click();
  await expect(page).toHaveURL(inHarbor('/deals?deal=new'));
  await adding(page).getByLabel('Opportunity name').fill('Maya’s wedding');
  await adding(page).getByLabel('Value', { exact: true }).fill('11000');
  await adding(page).getByLabel('Source', { exact: true }).fill(' Estimate form ');
  await adding(page).getByRole('button', { name: 'Create', exact: true }).click();
  await expect(adding(page)).toBeHidden();
  await expect(page).toHaveURL(inHarbor('/deals'));
  expect(createDealInput.parse(sent[0]).source).toBe('Estimate form');
  // The card says where the opportunity came from, above its value.
  await expect(page.getByRole('region', { name: 'New lead' }).getByRole('article')).toContainText(
    'Source:Estimate formValue:KES 11,000',
  );
  await expect(page.getByRole('status').filter({ hasText: 'Maya’s wedding saved.' })).toBeVisible();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('Maya’s wedding');
  await opener(page).click();
  await expect(editing(page).getByLabel('Source', { exact: true })).toHaveValue('Estimate form');
  await choose(editing(page).getByRole('combobox', { name: 'Status', exact: true }), 'lost');
  await editing(page).getByLabel('Status reason').fill('Event cancelled.');
  // Emptied here, the source is cleared: this form shows it, so it owns it.
  await editing(page).getByLabel('Source', { exact: true }).fill('');
  await editing(page).getByRole('button', { name: 'Update', exact: true }).click();
  await expect(editing(page)).toBeHidden();
  expect(updateDealInput.parse(sent[1])).toMatchObject({ status: 'lost', source: null });
  await choose(page.getByRole('combobox', { name: 'Status filter', exact: true }), 'lost');
  await expect(page.getByRole('row', { name: /Maya’s wedding/ })).toContainText('Lost');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('region', { name: 'New lead' })).toContainText('Maya’s wedding');
  await expect(page.getByRole('region', { name: 'New lead' }).getByRole('article')).toContainText(
    'Lost',
  );
});
test('an opportunity without a value shows a readable empty value', async ({ page }) => {
  await setup(page, { empty: true });
  await page.getByRole('button', { name: 'Add opportunity', exact: true }).click();
  await adding(page).getByLabel('Opportunity name').fill('Unpriced event');
  await adding(page).getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(
    page
      .getByRole('row', { name: /Unpriced event/ })
      .getByRole('cell')
      // After the row's checkbox.
      .nth(1),
  ).toHaveText('—');
});
test('viewers read the board, the list and an opportunity without write controls', async ({
  page,
}) => {
  const sent = await setup(page, { viewer: true });
  await expect(opener(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add opportunity' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move Maya’s wedding' })).toHaveCount(0);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expectNoViolations(page);
  // The opportunity opens to be read: its name alone is the title, and nothing saves.
  await opener(page).click();
  const reading = dialogOf(page, 'Maya’s wedding');
  await expect(reading.getByLabel('Opportunity name')).toHaveValue('Maya’s wedding');
  await expect(reading.getByLabel('Opportunity name')).toBeDisabled();
  await expect(reading.getByRole('combobox', { name: 'Stage', exact: true })).toBeDisabled();
  await expect(reading.getByRole('button', { name: 'Update' })).toHaveCount(0);
  await expect(reading.getByRole('button', { name: 'Move to trash' })).toHaveCount(0);
  await expectNoViolations(page);
  const close = reading.getByRole('button', { name: 'Close', exact: true }).last();
  await expect(close).toBeFocused();
  await close.click();
  await expect(reading).toBeHidden();
  await expect(opener(page)).toBeFocused();
  expect(sent).toHaveLength(0);
});
test('an empty business hides write controls from viewers', async ({ page }) => {
  await setup(page, { viewer: true, empty: true });
  await expect(page.getByRole('status').filter({ hasText: 'opportunities' })).toHaveText(
    '0 opportunities',
  );
  await expect(page.getByRole('button', { name: 'Add opportunity' })).toHaveCount(0);
});
test('cancelling a keyboard move leaves the saved stage unchanged', async ({ page }) => {
  const sent = await setup(page);
  const handle = page.getByRole('button', { name: 'Move Maya’s wedding' });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(
    page
      .getByRole('region', { name: 'New lead' })
      .getByRole('heading', { name: 'Maya’s wedding', exact: true }),
  ).toBeVisible();
  expect(sent).toHaveLength(0);
  await expect(handle).toBeFocused();
});
test('keeps the keyboard on the grip while a slow server saves a keyboard move', async ({
  page,
}) => {
  let answer: () => void = () => undefined;
  const delay = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const sent = await setup(page, { delay });
  const handle = page.getByRole('button', { name: 'Move Maya’s wedding' });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(page.getByText('Saving stage…', { exact: true })).toBeVisible();
  // The save is still on its way: the grip has the keyboard, and can't start another move.
  await expect(handle).toBeFocused();
  await expect(handle).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  expect(sent).toHaveLength(1);
  answer();
  await expect(page.getByText('Saving stage…', { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Proposal sent' })
      .getByRole('heading', { name: 'Maya’s wedding', exact: true }),
  ).toBeVisible();
  await expect(handle).toBeFocused();
  await expect(handle).toHaveAttribute('aria-disabled', 'false');
  expect(sent).toHaveLength(1);
});
test('closing the dialog returns focus to what opened it', async ({ page }) => {
  await setup(page);
  const add = page.getByRole('button', { name: 'Add opportunity', exact: true });
  await add.click();
  await expect(adding(page).getByLabel('Opportunity name')).toBeFocused();
  await adding(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(adding(page)).toBeHidden();
  await expect(add).toBeFocused();

  // From a card, by keyboard: Enter opens it and Escape gives the keyboard back to the card.
  await opener(page).focus();
  await page.keyboard.press('Enter');
  await expect(editing(page).getByLabel('Opportunity name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editing(page)).toBeHidden();
  await expect(opener(page)).toBeFocused();
});

test('a failed editor download keeps the board usable and cancel restores focus', async ({
  page,
}) => {
  await page.route(/\/assets\/deal-editor-[^/]+\.js$/, (route) => route.abort('failed'));
  const sent = await setup(page);
  const add = page.getByRole('button', { name: 'Add opportunity', exact: true });
  await add.click();
  await expect(page.getByRole('alert')).toContainText("The opportunity editor couldn't load.");
  await expect(page.getByRole('button', { name: 'Reload page', exact: true })).toBeFocused();
  await adding(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(adding(page)).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Maya’s wedding', exact: true })).toBeVisible();
  await expect(add).toBeFocused();
  expect(sent).toHaveLength(0);
});

test('a failed board download offers the list without changing opportunities', async ({ page }) => {
  await page.route(/\/assets\/deal-board-[^/]+\.js$/, (route) => route.abort('failed'));
  const sent = await setup(page);
  await expect(page.getByRole('alert')).toContainText("The board couldn't load.");
  await page.getByRole('button', { name: 'Switch to list', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('Maya’s wedding');
  expect(sent).toHaveLength(0);
});

test('an opportunity link opens its dialog as the page first loads', async ({ page }) => {
  const sent = await setup(page, { path: `/deals?deal=${original.id}` });
  await expect(editing(page).getByLabel('Opportunity name')).toHaveValue('Maya’s wedding');
  await page.keyboard.press('Escape');
  await expect(editing(page)).toBeHidden();
  await expect(opener(page)).toBeVisible();
  expect(sent).toHaveLength(0);
});

test('a failed dialog download keeps the board usable', async ({ page }) => {
  await page.route(/\/assets\/deal-dialog-[A-Za-z0-9_-]{8}\.js$/, (route) => route.abort('failed'));
  const sent = await setup(page, { path: `/deals?deal=${original.id}` });
  await expect(opener(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Opportunities', exact: true })).toBeVisible();
  await expect(editing(page)).toBeHidden();
  expect(sent).toHaveLength(0);
});
test('adds a new opportunity to the pipeline the list shows, at the stage chosen', async ({
  page,
}) => {
  const sent = await setup(page, { multiplePipelines: true });
  await page.getByRole('button', { name: 'Add opportunity', exact: true }).click();
  await adding(page).getByLabel('Opportunity name').fill('Maya’s garden wedding');
  await adding(page).getByLabel('Value', { exact: true }).fill('12345.6789');
  await choose(adding(page).getByRole('combobox', { name: 'Stage', exact: true }), secondStage);
  await expectChoice(
    adding(page).getByRole('combobox', { name: 'Pipeline', exact: true }),
    pipelineId,
  );
  // The dialog is modal: the list's pipeline can't change under the draft. The one
  // pipeline selector in reach is the dialog's own.
  await expect(page.getByRole('combobox', { name: 'Pipeline', exact: true })).toHaveCount(1);
  await adding(page).getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Maya’s garden wedding saved.', { exact: true })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(createDealInput.parse(sent[0])).toMatchObject({
    name: 'Maya’s garden wedding',
    pipelineId,
    stageId: secondStage,
    amount: '12345.6789',
  });
  await expectChoice(page.getByRole('combobox', { name: 'Pipeline', exact: true }), pipelineId);
  await expect(page.getByRole('region', { name: 'Proposal sent', exact: true })).toContainText(
    'Maya’s garden wedding',
  );
});
for (const source of ['list', 'link'] as const)
  test(`an opportunity opened from its ${source} saves in its own pipeline, whatever the list shows`, async ({
    page,
  }) => {
    // From a link, the list behind is another pipeline's; the opportunity keeps its own.
    const sent = await setup(page, {
      multiplePipelines: true,
      ...(source === 'link'
        ? { path: `/deals?pipelineId=${corporatePipeline.id}&deal=${original.id}` }
        : {}),
    });
    if (source === 'list') await opener(page).click();
    await editing(page).getByLabel('Opportunity name').fill('Maya’s revised wedding');
    await editing(page).getByLabel('Value', { exact: true }).fill('98765.4321');
    await editing(page).getByLabel('Expected close date').fill('2027-07-14');
    await choose(editing(page).getByRole('combobox', { name: 'Stage', exact: true }), secondStage);
    await expectChoice(
      editing(page).getByRole('combobox', { name: 'Pipeline', exact: true }),
      pipelineId,
    );
    expect(new URL(page.url()).searchParams.get('deal')).toBe(original.id);
    await editing(page).getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByText('Maya’s revised wedding saved.', { exact: true })).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(updateDealInput.parse(sent[0])).toMatchObject({
      name: 'Maya’s revised wedding',
      pipelineId,
      stageId: secondStage,
      amount: '98765.4321',
      expectedCloseDate: '2027-07-14',
      revision: original.revision,
    });
    expect(new URL(page.url()).searchParams.get('deal')).toBeNull();
    const listed = page.getByRole('combobox', { name: 'Pipeline', exact: true });
    if (source === 'link') {
      await expectChoice(listed, corporatePipeline.id);
      await choose(listed, pipelineId);
    } else await expectChoice(listed, pipelineId);
    await expect(page.getByRole('region', { name: 'Proposal sent', exact: true })).toContainText(
      'Maya’s revised wedding',
    );
  });
for (const width of [360, 1440])
  test(`pipeline choices stay above adjacent sections at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await setup(page, { multiplePipelines: true });
    const control = page.getByRole('combobox', { name: 'Pipeline', exact: true });
    await expect(control).toHaveCSS('border-radius', '6px');
    await control.click();
    const option = page.getByRole('option', { name: 'Corporate events', exact: true });
    await expect(option).toBeVisible();
    const popup = page.locator('[data-slot="select-popup"]');
    await expect(popup).toHaveCSS('border-radius', '12px');
    const bounds = await popup.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? width) + (bounds?.width ?? width)).toBeLessThanOrEqual(width);
    expect(
      await option.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const painted = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return painted !== null && element.contains(painted);
      }),
    ).toBe(true);
    await testInfo.attach(`pipeline-popup-${String(width)}`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    await expect(control).toBeFocused();
    await choose(control, corporatePipeline.id);
    await expectChoice(control, corporatePipeline.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  });

test('keeps the view actions in one menu and every toolbar control in reach of a finger at 360px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await setup(page);
  const actions = viewActions(page);
  await expect(page.getByRole('menuitem', { name: 'Refresh saved views' })).toBeHidden();
  await actions.click();
  await expect(page.getByRole('menuitem', { name: 'Refresh saved views' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Refresh saved views' })).toBeHidden();
  await expect(actions).toBeFocused();
  // The board and list switch sits beside the button that adds, on one line.
  const board = await page.getByRole('button', { name: 'Board', exact: true }).boundingBox();
  const add = await page
    .getByRole('button', { name: 'Add opportunity', exact: true })
    .boundingBox();
  expect(Math.abs((board?.y ?? 0) - (add?.y ?? 100))).toBeLessThan(8);
  for (const control of [
    page.getByRole('combobox', { name: 'Pipeline', exact: true }),
    page.getByRole('button', { name: 'Board', exact: true }),
    page.getByRole('button', { name: 'List', exact: true }),
    page.getByRole('button', { name: 'Add opportunity', exact: true }),
    page.getByRole('combobox', { name: 'Status filter', exact: true }),
    page.getByRole('searchbox', { name: 'Search opportunities' }),
    page.getByRole('button', { name: 'Move Maya’s wedding' }),
    page.getByRole('button', { name: 'Opportunity actions', exact: true }),
    actions,
  ])
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
});

for (const width of [360, 1440])
  test(`board, list and dialog are accessible at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, {
      deals: [original, another(1, { name: 'Lee reception', status: 'won' })],
      path: '/deals?status=all',
    });
    for (const mode of ['Board', 'List']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      await expect(opener(page)).toBeVisible();
      await expectNoViolations(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    await page.getByRole('button', { name: 'Add opportunity', exact: true }).click();
    await expect(adding(page).getByLabel('Opportunity name')).toBeFocused();
    await expectNoViolations(page);
    await adding(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await opener(page).click();
    await expect(editing(page).getByLabel('Opportunity name')).toBeFocused();
    await expectNoViolations(page);
    // With the pointer on a section and on each foot button: hover colours are checked too.
    await editing(page).getByRole('button', { name: 'Notes', exact: true }).hover();
    await expectNoViolations(page);
    await editing(page).getByRole('button', { name: 'Move to trash', exact: true }).hover();
    await expectNoViolations(page);
  });

for (const width of [1440, 1920])
  test(`fills the column beside the sidebar at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    await expect(opener(page)).toBeVisible();
    const board = page.getByRole('region', { name: 'Opportunities board' });
    expect(await reachesRightGutter(page, savedViews(page))).toBe(true);
    expect(await reachesRightGutter(page, board)).toBe(true);
    // The search is at the right end of the second row, against the gutter.
    expect(
      await reachesRightGutter(page, page.getByRole('searchbox', { name: 'Search opportunities' })),
    ).toBe(true);
    // The menu is the last control of the first row, with "Add opportunity" beside it.
    const menu = page.getByRole('button', { name: 'Opportunity actions', exact: true });
    expect(await reachesRightGutter(page, menu)).toBe(true);
    const [add, last] = [
      await page.getByRole('button', { name: 'Add opportunity', exact: true }).boundingBox(),
      await menu.boundingBox(),
    ];
    expect((last?.x ?? 0) - ((add?.x ?? 0) + (add?.width ?? 0))).toBe(8);
    expect((await board.boundingBox())?.x).toBe(240);
    await page.getByRole('button', { name: 'List', exact: true }).click();
    expect(
      await reachesRightGutter(page, page.getByRole('region', { name: 'Opportunities list' })),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  });

test.describe('the board and the list', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const several = [
    original,
    another(1, { name: 'Lee reception', amount: '500.5000', status: 'won' }),
    another(2, {
      name: 'Okafor gala',
      amount: null,
      stageId: secondStage,
      stageName: 'Proposal sent',
    }),
    another(3, { name: 'Harbor dinner', amount: '250', currency: 'USD', status: 'lost' }),
  ];

  test('heads each column with its count and the total of its values, and tints a won card', async ({
    page,
  }) => {
    await setup(page, { deals: several, path: '/deals?status=all' });
    const newLead = page.getByRole('region', { name: 'New lead', exact: true });
    const proposal = page.getByRole('region', { name: 'Proposal sent', exact: true });
    await expect(page.getByRole('status').filter({ hasText: 'opportunities' })).toHaveText(
      '4 opportunities',
    );
    // Totals are per currency, added exactly; an opportunity with no value adds nothing.
    await expect(newLead.getByRole('heading', { level: 2 })).toHaveText('New lead');
    await expect(newLead).toContainText('3 opportunities');
    await expect(newLead).toContainText('KES 11,500.5000');
    await expect(newLead).toContainText('USD 250');
    await expect(proposal).toContainText('1 opportunity');
    await expect(proposal).not.toContainText('KES');
    expect((await newLead.boundingBox())?.width).toBe(308);

    const won = newLead.getByRole('article').filter({ hasText: 'Lee reception' });
    const open = newLead.getByRole('article').filter({ hasText: 'Maya’s wedding' });
    const lost = newLead.getByRole('article').filter({ hasText: 'Harbor dinner' });
    await expect(won).toContainText('Won');
    await expect(won).toContainText('Value:KES 500.5000');
    await expect(lost).toContainText('Lost');
    // Only won and lost carry a badge: an open card says nothing more.
    await expect(open).not.toContainText('Open');
    await expect(open).toContainText('Expected close:2027-06-13');
    // The success tokens: #ECFDF3 behind a won card, with its #6CE9A6 border.
    await expect(won).toHaveCSS('background-color', 'rgb(236, 253, 243)');
    await expect(won).toHaveCSS('border-top-color', 'rgb(108, 233, 166)');
    await expect(open).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expectNoViolations(page);

    // The server searches; the cards it answers are what is counted and totalled.
    await page.getByRole('searchbox', { name: 'Search opportunities' }).fill('lee');
    await expect(newLead).toContainText('1 opportunity');
    await expect(newLead).toContainText('KES 500.5000');
    await expect(newLead).not.toContainText('USD');
  });

  test('shows the count and totals the server gives for a pipeline larger than what has loaded', async ({
    page,
  }) => {
    const sent = await setup(page, {
      deals: several,
      path: '/deals?status=all',
      summary: {
        pipelineId,
        count: 1204,
        totals: [{ currency: 'KES', amount: '9000000.5000' }],
        stages: [
          {
            stageId: firstStage,
            name: 'New lead',
            archived: false,
            count: 1200,
            totals: [
              { currency: 'KES', amount: '9000000.5000' },
              { currency: 'USD', amount: '250.0000' },
            ],
          },
          { stageId: secondStage, name: 'Proposal sent', archived: false, count: 4, totals: [] },
        ],
      },
    });
    const newLead = page.getByRole('region', { name: 'New lead', exact: true });
    const proposal = page.getByRole('region', { name: 'Proposal sent', exact: true });
    // Three cards have loaded in the first column, and the server counted 1,200 there.
    await expect(newLead.getByRole('article')).toHaveCount(3);
    await expect(newLead).toContainText('1,200 opportunities');
    await expect(newLead).toContainText('KES 9,000,000.5000');
    await expect(newLead).toContainText('USD 250.0000');
    await expect(proposal).toContainText('4 opportunities');
    await expect(page.getByRole('status').filter({ hasText: 'opportunities' })).toHaveText(
      '1,204 opportunities',
    );
    await expect(
      page.getByText('The counts and totals are for all of them', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more opportunities' })).toBeVisible();

    // A search is the server's too: the cards and the numbers are both asked for with it.
    await page.getByRole('searchbox', { name: 'Search opportunities' }).fill('lee');
    await expect(newLead.getByRole('article')).toHaveCount(1);
    await expect
      .poll(() =>
        sent.requests
          .filter((request) => request.method === 'GET')
          .filter((request) => request.query?.get('q') === 'lee')
          .map((request) => request.path),
      )
      .toEqual(expect.arrayContaining(['/deals', '/deals/stage-summary']));
    await expect(newLead).toContainText('1,200 opportunities');
    await page.getByRole('searchbox', { name: 'Search opportunities' }).fill('');
    await expect(newLead.getByRole('article')).toHaveCount(3);

    // With the last page loaded, the cards are everything, and they are what is counted.
    await page.getByRole('button', { name: 'Load more opportunities' }).click();
    await expect(page.getByRole('button', { name: 'Load more opportunities' })).toHaveCount(0);
    await expect(newLead).toContainText('3 opportunities');
    await expect(page.getByRole('status').filter({ hasText: 'opportunities' })).toHaveText(
      '4 opportunities',
    );
  });

  test('scrolls the board sideways inside the page when its columns are wider than it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await setup(page, { deals: several, path: '/deals?status=all' });
    const board = page.getByRole('region', { name: 'Opportunities board' });
    await expect(opener(page)).toBeVisible();
    expect(await board.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
  });

  test('lists opportunities under the columns chosen, with the status as a pill', async ({
    page,
  }) => {
    await setup(page, { deals: several, path: '/deals?status=all&layout=table' });
    await expect(page.getByRole('columnheader')).toHaveText([
      'Opportunity name',
      'Value',
      'Stage',
      'Status',
      'Expected close',
      'Contact',
      'Opportunity owner',
      'Tags',
    ]);
    const row = page.getByRole('row', { name: /Lee reception/ });
    // After the row's checkbox: the columns chosen, then the contact, the owner and the tags.
    await expect(row.getByRole('cell')).toHaveText([
      '',
      'KES 500.5000',
      'New lead',
      'Won',
      '2027-06-13',
      '—',
      '—',
      '',
    ]);
    expect((await row.boundingBox())?.height).toBe(42);
    // There is no import and no forecast yet, so neither is offered.
    await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0);
    await expectNoViolations(page);
  });
});

test.describe('the opportunity dialog', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens from a card at its own address, about 820px wide, over the board as it was', async ({
    page,
  }) => {
    await setup(page, { path: '/deals?status=all&q=maya' });
    await opener(page).click();

    await expect(editing(page)).toBeVisible();
    await expect(page).toHaveURL(inHarbor(`/deals?status=all&q=maya&deal=${original.id}`));
    const box = await editing(page).boundingBox();
    expect(box?.width).toBe(820);
    // Centred in the window.
    expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - 720)).toBeLessThanOrEqual(1);
    await expect(editing(page)).toContainText(
      "Add and edit this opportunity's details, tasks and notes.",
    );
    await expect(
      editing(page).getByRole('navigation', { name: 'Opportunity sections' }),
    ).toHaveText('Opportunity detailsTasksNotesActivity');
    await expect(editing(page)).toContainText('Created on Oct 8, 2026');
    // The board is still behind it, with the search that narrowed it.
    await expect(page.getByRole('region', { name: 'New lead', includeHidden: true })).toContainText(
      'Maya’s wedding',
    );
    await expect(
      page.getByRole('searchbox', { name: 'Search opportunities', includeHidden: true }),
    ).toHaveValue('maya');
  });

  test('survives a reload at its address, and Escape closes it to the same board', async ({
    page,
  }) => {
    const sent = await setup(page, { path: '/deals?status=all' });
    await opener(page).click();
    await expect(editing(page)).toBeVisible();

    await page.reload();
    await expect(editing(page).getByLabel('Opportunity name')).toHaveValue('Maya’s wedding');
    await expect(page).toHaveURL(inHarbor(`/deals?status=all&deal=${original.id}`));

    await page.keyboard.press('Escape');
    await expect(editing(page)).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/deals?status=all'));
    await expectChoice(page.getByRole('combobox', { name: 'Status filter', exact: true }), 'all');
    await expect(opener(page)).toBeVisible();
    expect(sent).toHaveLength(0);
  });

  test('Back closes it, and Forward opens it again', async ({ page }) => {
    await setup(page);
    await opener(page).click();
    await expect(editing(page)).toBeVisible();

    await page.goBack();
    await expect(editing(page)).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/deals'));
    await page.goForward();
    await expect(editing(page).getByLabel('Opportunity name')).toHaveValue('Maya’s wedding');

    // Closing it from here leaves one entry behind it: Back then leaves the page.
    await editing(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editing(page)).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/deals'));
  });

  test('keeps the keyboard inside it, on a real control each time', async ({ page }) => {
    await setup(page);
    await opener(page).click();
    await expect(editing(page).getByLabel('Opportunity name')).toBeFocused();
    // Tab goes round the dialog and never out to the page behind it. Past its last control
    // the keyboard is for one frame on the guard Base UI keeps beside the dialog, which
    // sends it round to the first control on the next frame (FloatingFocusManager's
    // enqueueFocus). So each press is checked twice: at once, that the keyboard is in the
    // dialog or on that guard and nowhere else; then, that it comes to rest in the dialog.
    for (let presses = 0; presses < 40; presses += 1) {
      await page.keyboard.press('Tab');
      expect(
        await editing(page).evaluate(
          (dialog) =>
            dialog.contains(document.activeElement) ||
            document.activeElement?.hasAttribute('data-base-ui-focus-guard') === true,
        ),
      ).toBe(true);
      await expect
        .poll(() => editing(page).evaluate((dialog) => dialog.contains(document.activeElement)))
        .toBe(true);
    }
  });

  test('asks before unsaved changes are lost, by Escape, by Cancel and by Back', async ({
    page,
  }) => {
    const sent = await setup(page);
    await opener(page).click();
    await editing(page).getByLabel('Value', { exact: true }).fill('99');

    await page.keyboard.press('Escape');
    await expect(guard(page)).toBeVisible();
    await expect(guard(page).getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await expectNoViolations(page);
    // Escape answers "Keep editing": the draft is as it was.
    await page.keyboard.press('Escape');
    await expect(guard(page)).toBeHidden();
    await expect(editing(page).getByLabel('Value', { exact: true })).toHaveValue('99');

    await editing(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await guard(page).getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(editing(page).getByLabel('Value', { exact: true })).toHaveValue('99');

    await page.goBack();
    await expect(guard(page)).toBeVisible();
    await guard(page).getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(editing(page).getByLabel('Value', { exact: true })).toHaveValue('99');
    await expect(page).toHaveURL(inHarbor(`/deals?deal=${original.id}`));

    await editing(page).getByRole('button', { name: 'Close', exact: true }).click();
    await guard(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(editing(page)).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/deals'));
    await expect(opener(page)).toBeFocused();
    expect(sent).toHaveLength(0);
    // Opened again, it shows what is saved, not the dropped draft.
    await opener(page).click();
    await expect(editing(page).getByLabel('Value', { exact: true })).toHaveValue('11000.0000');
  });

  test('closes without asking when nothing changed, and after a change is put back', async ({
    page,
  }) => {
    await setup(page);
    await opener(page).click();
    await editing(page).getByLabel('Value', { exact: true }).fill('99');
    await editing(page).getByLabel('Value', { exact: true }).fill('11000.0000');
    await page.keyboard.press('Escape');
    await expect(editing(page)).toBeHidden();
    await expect(guard(page)).toHaveCount(0);
  });

  test('shows tasks, notes and activity as sections kept in the address, without losing the draft', async ({
    page,
  }) => {
    await setup(page);
    await opener(page).click();
    await editing(page).getByLabel('Value', { exact: true }).fill('99');
    const sections = editing(page).getByRole('navigation', { name: 'Opportunity sections' });
    await expect(sections.getByRole('button', { name: 'Opportunity details' })).toHaveAttribute(
      'aria-current',
      'true',
    );

    await sections.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect(page).toHaveURL(inHarbor(`/deals?deal=${original.id}&section=notes`));
    await expect(editing(page).getByRole('region', { name: 'Notes', exact: true })).toBeVisible();
    await expect(editing(page).getByLabel('Opportunity name')).toBeHidden();
    // Changing section asks nothing, and only the details have a button that saves them.
    await expect(guard(page)).toHaveCount(0);
    await expect(editing(page).getByRole('button', { name: 'Update' })).toHaveCount(0);
    await sections.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(editing(page).getByRole('region', { name: 'Tasks', exact: true })).toBeVisible();
    await sections.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(
      editing(page).getByRole('region', { name: 'Activity', exact: true }),
    ).toBeVisible();
    await expectNoViolations(page);

    await sections.getByRole('button', { name: 'Opportunity details' }).click();
    await expect(page).toHaveURL(inHarbor(`/deals?deal=${original.id}`));
    await expect(editing(page).getByLabel('Value', { exact: true })).toHaveValue('99');
  });

  test('opens on the section its address names', async ({ page }) => {
    await setup(page, { path: `/deals?deal=${original.id}&section=tasks` });
    await expect(editing(page).getByRole('region', { name: 'Tasks', exact: true })).toBeVisible();
    await expect(
      editing(page)
        .getByRole('navigation', { name: 'Opportunity sections' })
        .getByRole('button', { name: 'Tasks', exact: true }),
    ).toHaveAttribute('aria-current', 'true');
  });

  test('a new opportunity has only its details, and no date or trash at its foot', async ({
    page,
  }) => {
    await setup(page);
    await page.getByRole('button', { name: 'Add opportunity', exact: true }).click();
    await expect(adding(page)).toContainText('Create a new opportunity by filling in its details.');
    await expect(
      adding(page).getByRole('navigation', { name: 'Opportunity sections' }).getByRole('button'),
    ).toHaveText(['Opportunity details']);
    await expect(adding(page)).not.toContainText('Created on');
    await expect(adding(page).getByRole('button', { name: 'Move to trash' })).toHaveCount(0);
    // A draft of a new one is guarded as an edit is.
    await adding(page).getByLabel('Opportunity name').fill('An unsaved idea');
    await page.keyboard.press('Escape');
    await guard(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(adding(page)).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/deals'));
  });

  test('moves the opportunity to the trash from its foot', async ({ page }) => {
    const sent = await setup(page);
    await opener(page).click();
    await editing(page).getByRole('button', { name: 'Move to trash', exact: true }).click();

    await expect(editing(page)).toBeHidden();
    await expect(
      page.getByRole('status').filter({ hasText: 'Maya’s wedding moved to the trash.' }),
    ).toBeVisible();
    await expect(opener(page)).toHaveCount(0);
    expect(sent.requests.filter((request) => request.method === 'DELETE')).toEqual([
      { method: 'DELETE', path: `/deals/${original.id}`, body: null },
    ]);
    await expect(page).toHaveURL(inHarbor('/deals'));
    // Its card is gone, so the keyboard goes to the button that adds one.
    await expect(page.getByRole('button', { name: 'Add opportunity', exact: true })).toBeFocused();
  });

  test('says why an opportunity could not be saved, keeping the draft', async ({ page }) => {
    await setup(page, { fail: true });
    await opener(page).click();
    await editing(page).getByLabel('Value', { exact: true }).fill('99');
    await editing(page).getByRole('button', { name: 'Update', exact: true }).click();
    await expect(editing(page).getByRole('alert')).toContainText('This deal changed');
    await expect(editing(page).getByLabel('Value', { exact: true })).toHaveValue('99');
  });

  test('is a full-height sheet on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await setup(page);
    await opener(page).click();
    await expect(editing(page).getByLabel('Opportunity name')).toBeVisible();
    expect(await editing(page).boundingBox()).toEqual({ x: 0, y: 0, width: 360, height: 800 });
    await expectNoViolations(page);
    // The sections are a row across the top, each big enough for a finger.
    const sections = editing(page).getByRole('navigation', { name: 'Opportunity sections' });
    for (const section of await sections.getByRole('button').all())
      expect((await section.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await sections.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect(editing(page).getByRole('region', { name: 'Notes', exact: true })).toBeVisible();
    await expectNoViolations(page);
    for (const control of [
      editing(page).getByRole('button', { name: 'Cancel', exact: true }),
      editing(page).getByRole('button', { name: 'Move to trash', exact: true }),
      editing(page).getByRole('button', { name: 'Close', exact: true }),
    ])
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
  });
});

test.describe('contacts, owner, followers and bulk actions', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const withPeople = another(1, {
    name: 'Lee reception',
    primaryContact: maya,
    owner: lee,
    tags: [{ id: 'tag_01m4bd188ff82s0add91b7pz61', name: 'VIP' }],
  });
  const without = another(2, { name: 'Gala dinner', primaryContact: null, owner: null, tags: [] });

  test('a card and a row show the primary contact, the owner and the tags the list is asked for', async ({
    page,
  }) => {
    const asked: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/api/v1/deals')) asked.push(url.searchParams.get('include') ?? '');
    });
    await setup(page, { deals: [withPeople, without] });
    const card = page.getByRole('article').filter({ hasText: 'Lee reception' });
    await expect(card).toContainText('Contact:Maya Thompson');
    // The owner is the avatar beside the name, read out as "Owner: Lee Park".
    await expect(card.getByText('Owner: Lee Park', { exact: true })).toBeAttached();
    await expect(card.getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText([
      'VIP',
    ]);
    const bare = page.getByRole('article').filter({ hasText: 'Gala dinner' });
    await expect(bare).not.toContainText('Contact:');
    await expect(bare).not.toContainText('Owner:');
    await expect(bare.getByRole('list', { name: 'Tags' })).toHaveCount(0);
    expect(asked.every((include) => include === 'contact,owner,tags')).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
    await expectNoViolations(page);

    await page.getByRole('button', { name: 'List', exact: true }).click();
    const row = page.getByRole('row', { name: /Lee reception/ });
    await expect(row.getByRole('cell').nth(5)).toHaveText('Maya Thompson');
    await expect(row.getByRole('cell').nth(6)).toHaveText('Lee Park');
    await expect(row.getByRole('cell').nth(7)).toHaveText('VIP');
    await expectNoViolations(page);
  });

  test('the dialog shows who the opportunity is with and whose it is, and saves each change by itself', async ({
    page,
  }) => {
    const sent = await setup(page, {
      details: { primaryContact: maya, additionalContacts: [omar], owner: lee, followers: [dana] },
    });
    await opener(page).click();
    const contacts = editing(page).getByRole('region', { name: 'Contact details', exact: true });
    await expect(contacts).toContainText('Maya Thompson');
    await expect(contacts).toContainText('maya@example.com · 0712 345678');
    await expect(
      contacts.getByRole('list', { name: 'Additional contacts' }).getByRole('listitem'),
    ).toContainText(['Omar Said']);
    await expect(editing(page)).toContainText('Created by Lee Park');
    // No audit log without the permission to read it.
    await expect(editing(page).getByRole('button', { name: 'Audit logs' })).toHaveCount(0);
    await expectNoViolations(page);

    // The owner: one request, under the revision the details gave.
    const owner = editing(page).getByRole('combobox', { name: 'Owner', exact: true });
    await expectChoice(owner, lee.membershipId);
    await choose(owner, dana.membershipId);
    await expectChoice(owner, dana.membershipId);
    expect(lastChange(sent)).toEqual({
      method: 'PUT',
      path: `/deals/${original.id}/owner`,
      body: { owner: dana.membershipId, revision: 'd'.repeat(64) },
    });

    // A follower added from the list of people.
    await editing(page).getByRole('button', { name: 'Followers You', exact: true }).click();
    // Ticked once the server has answered, so it is pressed and then seen ticked.
    await editing(page).getByRole('checkbox', { name: 'Lee Park', exact: true }).click();
    await expect(
      editing(page).getByRole('checkbox', { name: 'Lee Park', exact: true }),
    ).toBeChecked();
    await expect(
      editing(page).getByRole('button', { name: 'Followers 2 followers', exact: true }),
    ).toBeVisible();
    expect(lastChange(sent)).toEqual({
      method: 'POST',
      path: `/deals/${original.id}/followers`,
      body: { followers: [lee.membershipId] },
    });

    // An additional contact found on the server, then made the primary: the one before stays.
    await contacts.getByRole('searchbox', { name: 'Search for an additional contact' }).fill('zu');
    await contacts
      .getByRole('list', { name: 'Matching contacts' })
      .getByRole('button', { name: /Zuri Kim/ })
      .click();
    await expect(
      contacts.getByRole('list', { name: 'Additional contacts' }).getByRole('listitem'),
    ).toHaveCount(2);
    expect(lastChange(sent)).toEqual({
      method: 'PUT',
      path: `/deals/${original.id}/contacts`,
      body: {
        primaryContactId: maya.id,
        additionalContactIds: [omar.id, zuri.id],
        revision: 'e'.repeat(64),
      },
    });
    await contacts.getByRole('button', { name: 'Make Zuri Kim the primary contact' }).click();
    await expect(
      contacts.getByRole('list', { name: 'Additional contacts' }).getByRole('listitem'),
    ).toContainText(['Omar Said', 'Maya Thompson']);
    expect(lastChange(sent)).toMatchObject({
      body: {
        primaryContactId: zuri.id,
        additionalContactIds: [omar.id, maya.id],
        revision: '9'.repeat(64),
      },
    });
    await contacts.getByRole('button', { name: 'Remove Omar Said', exact: true }).click();
    await expect(
      contacts.getByRole('list', { name: 'Additional contacts' }).getByRole('listitem'),
    ).toHaveCount(1);
    await expectNoViolations(page);

    // The form then saves from the revision the owner change moved the opportunity to.
    await editing(page).getByLabel('Value', { exact: true }).fill('99');
    await editing(page).getByRole('button', { name: 'Update', exact: true }).click();
    await expect(editing(page)).toBeHidden();
    expect(updateDealInput.parse(sent.at(-1))).toMatchObject({
      amount: '99',
      revision: '8'.repeat(64),
    });
  });

  test('a viewer reads the contacts, owner and followers without a way to change them', async ({
    page,
  }) => {
    const sent = await setup(page, {
      viewer: true,
      details: { primaryContact: maya, additionalContacts: [omar], owner: lee, followers: [dana] },
    });
    // A viewer's cards can't be dragged; the list's rows open the same dialog.
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await opener(page).click();
    const reading = dialogOf(page, 'Maya’s wedding');
    await expect(reading.getByRole('region', { name: 'Contact details' })).toContainText(
      'Omar Said',
    );
    const people = reading.getByRole('region', { name: 'Owner and followers' });
    await expect(people).toContainText('Lee Park');
    await expect(people).toContainText('You');
    await expect(reading.getByRole('searchbox')).toHaveCount(0);
    await expect(reading.getByRole('combobox', { name: 'Owner', exact: true })).toHaveCount(0);
    await expect(reading.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await expectNoViolations(page);
    expect(sent.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  test('a new opportunity names its primary contact in the request that makes it', async ({
    page,
  }) => {
    const sent = await setup(page);
    await page.getByRole('button', { name: 'Add opportunity', exact: true }).click();
    await adding(page).getByRole('searchbox', { name: 'Search for a primary contact' }).fill('may');
    await adding(page)
      .getByRole('list', { name: 'Matching contacts' })
      .getByRole('button', { name: /Maya Thompson/ })
      .click();
    await expect(adding(page)).toContainText('Maya Thompson');
    await expectNoViolations(page);
    await adding(page).getByLabel('Opportunity name').fill('Maya’s anniversary');
    await adding(page).getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Maya’s anniversary saved.', { exact: true })).toBeVisible();
    expect(createDealInput.parse(sent[0])).toMatchObject({
      name: 'Maya’s anniversary',
      primaryContactId: maya.id,
    });
  });

  test('ticked rows of the list take a bulk action, and the page says what became of them', async ({
    page,
  }) => {
    const sent = await setup(page, {
      deals: [original, withPeople, without],
      path: '/deals?layout=table',
      bulkOutcome: (id) => (id === without.id ? 'skipped' : 'done'),
    });
    await expect(page.getByRole('group', { name: 'Bulk actions' })).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Select all loaded opportunities' }).check();
    const bar = page.getByRole('group', { name: 'Bulk actions', exact: true });
    await expect(bar).toContainText('3 selected');
    await expect(bar.getByRole('button')).toHaveText([
      'Change owner',
      'Change pipeline and stage',
      'Change status',
      'Delete',
      'Clear selection',
    ]);
    for (const button of await bar.getByRole('button').all())
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(32);
    await expectNoViolations(page);

    // A status needs its reason when it is lost.
    await bar.getByRole('button', { name: 'Change status', exact: true }).click();
    const status = dialogOf(page, 'Change status');
    await expect(status).toContainText('3 opportunities are selected.');
    await choose(status.getByRole('combobox', { name: 'New status', exact: true }), 'lost');
    await expect(status.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await status.getByLabel('Status reason', { exact: true }).fill('Chose another venue');
    await expectNoViolations(page);
    await status.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(status).toBeHidden();
    await expect(
      page.locator('main p[role="status"]').filter({
        hasText: '2 opportunities changed. 1 was skipped: not found, or in the trash.',
      }),
    ).toBeVisible();
    expect(lastChange(sent)).toEqual({
      method: 'POST',
      path: '/deals/bulk',
      body: {
        action: 'set_status',
        ids: [original.id, withPeople.id, without.id],
        status: 'lost',
        outcomeReason: 'Chose another venue',
      },
    });
    // The selection is let go once the action has run.
    await expect(page.getByRole('group', { name: 'Bulk actions' })).toHaveCount(0);

    // Delete moves the ticked rows to the trash, and they leave the list.
    await choose(page.getByRole('combobox', { name: 'Status filter' }), 'all');
    await page.getByRole('checkbox', { name: 'Select Lee reception', exact: true }).check();
    await page
      .getByRole('group', { name: 'Bulk actions', exact: true })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    const trash = dialogOf(page, 'Delete opportunities');
    await expect(trash).toContainText('1 opportunity is selected.');
    await trash.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await expect(
      page
        .locator('main p[role="status"]')
        .filter({ hasText: '1 opportunity moved to the trash.' }),
    ).toBeVisible();
    await expect(page.getByRole('row', { name: /Lee reception/ })).toHaveCount(0);
    expect(lastChange(sent)).toEqual({
      method: 'POST',
      path: '/deals/bulk',
      body: { action: 'trash', ids: [withPeople.id] },
    });
  });

  test('a viewer has no checkboxes and no bulk actions', async ({ page }) => {
    await setup(page, { viewer: true, path: '/deals?layout=table' });
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('main').getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Bulk actions' })).toHaveCount(0);
  });
});

test.describe('what the pipeline, the settings and the server decide', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** The first pipeline with its settings: a red first stage that is 20% likely. */
  const styled = (colorStyle: 'none' | 'dot' | 'tint', dealProbability = false) => ({
    ...pipeline,
    colorStyle,
    dealProbability,
    stages: [
      {
        id: firstStage,
        name: 'New lead',
        description: '',
        archived: false,
        color: '#b42318',
        probability: 20,
      },
      {
        id: secondStage,
        name: 'Proposal sent',
        description: '',
        archived: false,
        color: null,
        probability: null,
      },
    ],
  });
  const mark = (style: string) => `[data-stage-color="${style}"]`;

  for (const style of ['dot', 'tint', 'none'] as const)
    test(`a pipeline that draws its stage colors as "${style}" heads its columns and fills its stage cells so`, async ({
      page,
    }) => {
      await setup(page, {
        pipelines: [styled(style)],
        deals: [
          original,
          another(1, { name: 'Okafor gala', stageId: secondStage, stageName: 'Proposal sent' }),
        ],
      });
      const newLead = page.getByRole('region', { name: 'New lead', exact: true });
      const proposal = page.getByRole('region', { name: 'Proposal sent', exact: true });
      await expect(newLead.getByRole('heading', { level: 2 })).toHaveText('New lead');
      // Only a stage that has a color is drawn in one, and only as the pipeline says.
      await expect(newLead.locator(mark(style))).toHaveCount(style === 'none' ? 0 : 1);
      await expect(page.locator('[data-stage-color]')).toHaveCount(style === 'none' ? 0 : 1);
      await expect(proposal.locator('[data-stage-color]')).toHaveCount(0);
      if (style === 'dot')
        await expect(newLead.locator(mark('dot'))).toHaveCSS(
          'background-color',
          'rgb(180, 35, 24)',
        );
      if (style === 'tint')
        expect(
          await newLead
            .locator(mark('tint'))
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).not.toBe('rgba(0, 0, 0, 0)');
      await expectNoViolations(page);

      await page.getByRole('button', { name: 'List', exact: true }).click();
      const stageOf = (name: string) =>
        page
          .getByRole('row', { name: new RegExp(name) })
          .getByRole('cell')
          .nth(2);
      await expect(stageOf('Maya’s wedding')).toHaveText('New lead');
      await expect(stageOf('Maya’s wedding').locator(mark(style))).toHaveCount(
        style === 'none' ? 0 : 1,
      );
      await expect(stageOf('Okafor gala').locator('[data-stage-color]')).toHaveCount(0);
      expect((await page.getByRole('row', { name: /Maya’s wedding/ }).boundingBox())?.height).toBe(
        42,
      );
      await expectNoViolations(page);
    });

  test('the dialog saves the opportunity’s own probability where its pipeline uses one', async ({
    page,
  }) => {
    const sent = await setup(page, {
      pipelines: [styled('none', true)],
      deals: [{ ...original, probability: 35 }],
    });
    await opener(page).click();
    const probability = editing(page).getByLabel('Probability (%)', { exact: true });
    await expect(probability).toHaveValue('35');
    await expect(probability).toBeEditable();
    await expect(editing(page)).toContainText(
      "This pipeline uses each opportunity's own probability.",
    );
    // Digits only, and nothing over 100 is sent.
    await probability.fill('1x01');
    await expect(probability).toHaveValue('101');
    await expect(probability).toHaveAttribute('aria-invalid', 'true');
    await expect(editing(page)).toContainText('Enter 0 to 100.');
    await expectNoViolations(page);
    await editing(page).getByRole('button', { name: 'Update', exact: true }).click();
    await expect(editing(page).getByRole('alert')).toHaveText('Enter a probability from 0 to 100.');
    expect(sent).toHaveLength(0);
    await probability.fill('60');
    await editing(page).getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByText('Maya’s wedding saved.', { exact: true })).toBeVisible();
    expect(updateDealInput.parse(sent[0])).toMatchObject({ probability: 60, stageId: firstStage });

    // Emptied, the opportunity has none.
    await opener(page).click();
    await expect(editing(page).getByLabel('Probability (%)', { exact: true })).toHaveValue('60');
    await editing(page).getByLabel('Probability (%)', { exact: true }).fill('');
    await editing(page).getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByText('Maya’s wedding saved.', { exact: true })).toBeVisible();
    expect((sent[1] as { probability?: unknown }).probability).toBeNull();
  });

  test('the dialog shows the stage’s probability, read only, where the pipeline uses the stage’s', async ({
    page,
  }) => {
    const sent = await setup(page, {
      pipelines: [styled('none')],
      deals: [{ ...original, probability: 35 }],
    });
    await opener(page).click();
    const probability = editing(page).getByLabel('Probability (%)', { exact: true });
    // The stage's 20, not the 35 the opportunity carries unread.
    await expect(probability).toHaveValue('20');
    await expect(probability).not.toBeEditable();
    await expect(editing(page)).toContainText(
      'From the stage. This pipeline uses stage probability.',
    );
    await choose(editing(page).getByRole('combobox', { name: 'Stage', exact: true }), secondStage);
    await expect(probability).toHaveValue('');
    await expect(editing(page)).toContainText('From the stage, which has none set.');
    await expectNoViolations(page);
    await editing(page).getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByText('Maya’s wedding saved.', { exact: true })).toBeVisible();
    // Left out of the request, so the server keeps the opportunity's own.
    expect(sent[0]).not.toHaveProperty('probability');
    expect(updateDealInput.parse(sent[0])).toMatchObject({ stageId: secondStage });
  });

  test('the dialog moves an opportunity to another pipeline, with the stages following it', async ({
    page,
  }) => {
    const enquiry = corporatePipeline.stages[0]?.id ?? '';
    const sent = await setup(page, {
      pipelines: [
        styled('none'),
        { ...corporatePipeline, dealProbability: true },
        {
          ...corporatePipeline,
          id: 'pipe_01m4bd9fteedat3be9bqgx2049',
          name: 'Old',
          archived: true,
        },
        { ...corporatePipeline, id: 'pipe_01m4bd9fteedat3be9bqgx204a', name: 'Empty', stages: [] },
      ],
    });
    await opener(page).click();
    const chosen = editing(page).getByRole('combobox', { name: 'Pipeline', exact: true });
    const stage = editing(page).getByRole('combobox', { name: 'Stage', exact: true });
    await expectChoice(chosen, pipelineId);
    await choose(stage, secondStage);
    // Only pipelines in use, with a stage in use, can take it.
    await chosen.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
      'Weddings',
      'Corporate events',
    ]);
    await page.keyboard.press('Escape');
    await choose(chosen, corporatePipeline.id);
    await expectChoice(stage, enquiry);
    // This pipeline reads the opportunity's own probability.
    await expect(editing(page).getByLabel('Probability (%)', { exact: true })).toBeEditable();
    // Back in its own pipeline it is in the stage it had, not the one just chosen.
    await choose(chosen, pipelineId);
    await expectChoice(stage, firstStage);
    await expect(editing(page).getByLabel('Probability (%)', { exact: true })).toHaveValue('20');
    await choose(chosen, corporatePipeline.id);
    await expectNoViolations(page);
    await editing(page).getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByText('Maya’s wedding saved.', { exact: true })).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(updateDealInput.parse(sent[0])).toMatchObject({
      pipelineId: corporatePipeline.id,
      stageId: enquiry,
      probability: null,
      revision: original.revision,
    });
    // It left the pipeline the board shows, and is in the other.
    await expect(opener(page)).toHaveCount(0);
    await choose(
      page.getByRole('combobox', { name: 'Pipeline', exact: true }),
      corporatePipeline.id,
    );
    await expect(page.getByRole('region', { name: 'Enquiry', exact: true })).toContainText(
      'Maya’s wedding',
    );
  });

  for (const width of [1440, 360])
    test(`the menu at the top right opens the opportunity settings, which save together, at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const sent = await setup(page);
      const menu = page.getByRole('button', { name: 'Opportunity actions', exact: true });
      expect((await menu.boundingBox())?.height).toBe(width < 1024 ? 44 : 36);
      await menu.click();
      await page.getByRole('menuitem', { name: 'Opportunity settings', exact: true }).click();
      const panel = dialogOf(page, 'Opportunity settings');
      const owners = panel.getByRole('switch', {
        name: 'Allow different owners for primary contacts and opportunities',
        exact: true,
      });
      const ownerRule = panel.getByRole('checkbox', {
        name: /^When an opportunity's owner changes/,
      });
      const contactRule = panel.getByRole('checkbox', { name: /^When a contact's owner changes/ });
      await expect(owners).toHaveAttribute('aria-checked', 'false');
      await expect(ownerRule).toBeChecked();
      await expect(contactRule).not.toBeChecked();
      const save = panel.getByRole('button', { name: 'Save changes', exact: true });
      await expect(save).toBeDisabled();
      // At the right edge, full height, and no wider than the window.
      const box = await panel.boundingBox();
      expect(box?.width).toBe(Math.min(440, width));
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBe(width);
      await expectNoViolations(page);
      for (const control of [owners, ownerRule.locator('xpath=..'), save])
        expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(
          width < 1024 ? 44 : 36,
        );

      await owners.click();
      await contactRule.check();
      await expectNoViolations(page);
      await save.click();
      await expect(page.getByText('Opportunity settings saved.', { exact: true })).toBeVisible();
      await expect(panel).toHaveCount(0);
      await expect(menu).toBeFocused();
      expect(lastChange(sent)).toEqual({
        method: 'PUT',
        path: '/opportunity-settings',
        body: {
          allowDifferentOwners: true,
          opportunityOwnerFollowsContact: true,
          contactOwnerFollowsOpportunity: true,
          revision: savedSettings.revision,
        },
      });
      // Opened again, it shows what was saved.
      await menu.click();
      await page.getByRole('menuitem', { name: 'Opportunity settings', exact: true }).click();
      await expect(owners).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(menu).toBeFocused();
    });

  test('a viewer reads the opportunity settings without a way to change them', async ({ page }) => {
    const sent = await setup(page, { viewer: true });
    await page.getByRole('button', { name: 'Opportunity actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Opportunity settings', exact: true }).click();
    const panel = dialogOf(page, 'Opportunity settings');
    await expect(panel.getByRole('switch')).toBeDisabled();
    for (const rule of await panel.getByRole('checkbox').all()) await expect(rule).toBeDisabled();
    await expect(panel.getByRole('checkbox')).toHaveCount(2);
    await expect(panel).toContainText('You can see these settings, but you may not change them.');
    await expect(panel.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expectNoViolations(page);
    await panel.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(panel).toHaveCount(0);
    expect(lastChange(sent)).toBeUndefined();
  });

  const several = [
    original,
    another(1, { name: 'Lee reception', amount: '500.5000', source: 'Website form' }),
    another(2, { name: 'Okafor gala', amount: null }),
  ];
  /** The reads of the list, each as what it was asked with. */
  const listReads = (sent: { readonly requests: Sent[] }) =>
    sent.requests
      .filter((request) => request.method === 'GET' && request.path === '/deals')
      .map((request) => Object.fromEntries(request.query ?? []));

  test('the server searches and orders the list, on the board and in the list alike', async ({
    page,
  }) => {
    const sent = await setup(page, { deals: several });
    await expect(page.getByRole('article')).toHaveCount(3);
    expect(listReads(sent).at(-1)).toEqual({
      pipelineId,
      status: 'open',
      limit: '200',
      include: 'contact,owner,tags',
    });
    await page.getByRole('searchbox', { name: 'Search opportunities' }).fill(' Lee ');
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByRole('article')).toContainText('Lee reception');
    expect(listReads(sent).at(-1)).toMatchObject({ q: 'Lee' });
    await expect(page).toHaveURL(/[?&]q=Lee(?:&|$)/);
    await expect(page.getByRole('status').filter({ hasText: 'opportunit' })).toHaveText(
      '1 opportunity',
    );

    // Each built-in order, both ways; one that is the server's usual way names no direction.
    await page.getByRole('button', { name: 'Sort', exact: true }).click();
    const order = page.getByRole('combobox', { name: 'Sort by', exact: true });
    await expectChoice(order, 'created');
    await order.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
      'Created, newest first',
      'Created, oldest first',
      'Updated, newest first',
      'Updated, oldest first',
      'Name, A to Z',
      'Name, Z to A',
      'Value, highest first',
      'Value, lowest first',
    ]);
    await page.keyboard.press('Escape');
    await choose(order, 'name:desc');
    await expect
      .poll(() => listReads(sent).at(-1))
      .toMatchObject({
        q: 'Lee',
        sort: 'name',
        direction: 'desc',
      });
    await expect(page).toHaveURL(/[?&]sort=name&direction=desc(?:&|$)/);
    await expect(page.getByRole('button', { name: 'Sort (1)', exact: true })).toBeVisible();
    await choose(order, 'value');
    await expect.poll(() => listReads(sent).at(-1)).toMatchObject({ sort: 'value' });
    expect(listReads(sent).at(-1)).not.toHaveProperty('direction');
    await choose(order, 'created:asc');
    await expect
      .poll(() => listReads(sent).at(-1))
      .toMatchObject({ sort: 'created', direction: 'asc' });
    await expectNoViolations(page);
    await choose(order, 'created');
    await expect.poll(() => new URL(page.url()).searchParams.has('sort')).toBe(false);
    expect(new URL(page.url()).searchParams.has('direction')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Sort', exact: true })).toBeVisible();

    // An address that names an order opens in it, in the list too.
    await page.goto(inHarbor('/deals?layout=table&sort=updated&direction=asc&q=gala'));
    await expect(page.getByRole('rowheader')).toHaveText(['Okafor gala']);
    expect(listReads(sent).at(-1)).toMatchObject({ q: 'gala', sort: 'updated', direction: 'asc' });
    await expect(page.getByRole('button', { name: 'Sort (1)', exact: true })).toBeVisible();
  });

  test('the columns of the list are chosen under Manage fields, the contact, owner and tags among them', async ({
    page,
  }) => {
    await setup(page, { deals: several, path: '/deals?layout=table' });
    await page.getByRole('button', { name: '8/12 columns', exact: true }).click();
    const fields = dialogOf(page, 'Manage fields');
    await expect(fields.getByRole('checkbox')).toHaveCount(12);
    for (const name of ['Contact', 'Opportunity owner', 'Tags', 'Stage', 'Expected close'])
      await fields.getByRole('checkbox', { name, exact: true }).uncheck();
    for (const name of ['Created on', 'Updated on', 'Source', 'Pipeline'])
      await fields.getByRole('checkbox', { name, exact: true }).check();
    await expectNoViolations(page);
    await fields.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('columnheader')).toHaveText([
      'Opportunity name',
      'Value',
      'Status',
      'Created on',
      'Updated on',
      'Source',
      'Pipeline',
    ]);
    await expect(page.getByRole('row', { name: /Lee reception/ }).getByRole('cell')).toHaveText([
      '',
      'KES 500.5000',
      'Open',
      'Oct 8, 2026',
      'Oct 8, 2026',
      'Website form',
      'Weddings',
    ]);
    expect(new URL(page.url()).searchParams.getAll('columns').join()).not.toContain('tags');
    await expect(page.getByRole('button', { name: '7/12 columns', exact: true })).toBeVisible();
    await expectNoViolations(page);
    // The choice is in the address: a reload shows the same columns.
    await page.reload();
    await expect(page.getByRole('columnheader')).toHaveCount(7);
    // An address kept from before the table could choose still opens: its names are read.
    await page.goto(
      inHarbor('/deals?layout=table&columns=%5B%22name%22%2C%22amount%22%2C%22outcome%22%5D'),
    );
    await expect(page.getByRole('columnheader')).toHaveText([
      'Opportunity name',
      'Value',
      'Status',
    ]);
  });
});
