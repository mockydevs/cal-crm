// The automation API as the dashboard's browser tests stand it in: a small in-memory one
// that keeps the contract's rules that matter to the screens. A save from a stale draft
// version is a 409, the checks are the contract's own validator, publishing a draft with
// errors is refused, and runs are read as the server answers them.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  createAutomationFolderInput,
  createAutomationInput,
  moveAutomationInput,
  patchAutomationDraftInput,
  publishAutomationInput,
  replaceAutomationDraftInput,
  updateAutomationFolderInput,
  validateAutomation,
  type Automation,
  type AutomationFolder,
  type AutomationSetup,
  type AutomationStats,
} from '@repo/contracts';
import {
  automationId,
  automationOf,
  catalogOf,
  folderOf,
  followUp,
  followUpStats,
  harborSetup,
  stamp,
  summaryOf,
  versionId,
  versionTwo,
  type AutomationFlags,
} from './automation-fixtures';
import { harbor, inHarbor, signedIn } from './session';

export type Held = Automation & AutomationFlags;

export interface World {
  /** The automations the business has, newest first. */
  automations: Held[];
  setup: AutomationSetup;
  /** What the signed-in person may do. */
  flags: AutomationFlags;
  /** Every change the page asked for, in order. */
  readonly writes: { readonly method: string; readonly path: string; readonly body: unknown }[];
  /** The automation's runs, as GET /automations/{id}/runs lists them, newest first. */
  runs: readonly Record<string, unknown>[];
  /** Each run in full, by its id, as GET /automation-runs/{id} answers. */
  runDetails: Readonly<Record<string, unknown>>;
  /** Every list of runs the page asked for: the query it sent. */
  readonly runQueries: string[];
  /** The folders of the business, as GET /automation-folders lists them. */
  folders: AutomationFolder[];
  /** What GET /automations/{id}/stats answers, for whichever automation is asked about. */
  stats: AutomationStats;
  /** Every list of automations the page asked for: the query it sent. */
  readonly listQueries: string[];
  /** The steps the automation's runs took, as GET /automations/{id}/step-runs lists them. */
  stepRuns: readonly Record<string, unknown>[];
  /** Every list of step runs the page asked for: the query it sent. */
  readonly stepRunQueries: string[];
  /** What POST /automations/{id}/test-runs answers. */
  testRun: Record<string, unknown>;
  /** The published versions, newest first, as GET /automations/{id}/versions lists them. */
  versions?: readonly Record<string, unknown>[];
  /** The document of a version, by its number; any other version is the documentation's. */
  versionDocuments?: Readonly<Record<number, Record<string, unknown>>>;
  /** What POST /automation-runs/{id}/retry is refused with (409); none, and the run goes on. */
  retryRefusal?: string | undefined;
  /** What POST /automation-runs/{id}/continue is refused with (409); none, and the run goes on. */
  continueRefusal?: string | undefined;
  /** What GET /automations/{id}/explain-contact answers, by the contact asked about. */
  explanations?: Readonly<Record<string, unknown>>;
  /** What the next save of a draft is refused for (422). Asked once: then saves go through. */
  saveRefusal?: readonly { path: string; code: string; message: string }[] | undefined;
}

export const world = (over: Partial<World> = {}): World => ({
  automations: [automationOf()],
  setup: harborSetup,
  flags: { canManage: true, canPublish: true },
  writes: [],
  runs: [],
  runDetails: {},
  runQueries: [],
  folders: [],
  stats: followUpStats,
  listQueries: [],
  stepRuns: [],
  stepRunQueries: [],
  testRun: {
    id: 'atest_01k8e2wzr0e008000000000071',
    draftVersion: 3,
    status: 'passed',
    contactId: null,
    createdAt: stamp,
    steps: [],
    outcome: { kind: 'completed' },
  },
  ...over,
});

export const checksOf = (
  draft: unknown,
  setup: AutomationSetup,
  /** The automation the draft is of, so a start that loops back to it is refused. */
  automation?: string,
): Record<string, unknown> => {
  const result = validateAutomation(draft, setup, { automationId: automation });
  return { valid: result.valid, errors: result.errors, warnings: result.warnings };
};

export const problem = (
  status: number,
  title: string,
  more: Record<string, unknown> = {},
): { status: number; contentType: string; json: Record<string, unknown> } => ({
  status,
  contentType: 'application/problem+json',
  json: { type: 'about:blank', title, status, ...more },
});

/** Answers /api/v1/automations as the server does, from the world a test set up. */
export async function automationsApi(page: Page, state: World): Promise<void> {
  await foldersApi(page, state);
  await page.route('**/api/v1/automations**', async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/v1\/automations/, '');
    const body: unknown =
      method === 'GET' || method === 'DELETE' ? undefined : request.postDataJSON();
    if (method !== 'GET') state.writes.push({ method, path, body });

    if (method === 'GET' && path === '/catalog') {
      await route.fulfill({ json: catalogOf(state.setup) });
      return;
    }
    if (method === 'GET' && path === '') {
      // As the server lists: the Deleted list by its status and nothing deleted otherwise,
      // one folder or the top level when asked, and a name wherever it is.
      const query = new URL(request.url()).searchParams;
      state.listQueries.push(query.toString());
      const status = query.get('status');
      const folder = query.get('folder');
      const q = query.get('q')?.toLowerCase();
      await route.fulfill({
        json: {
          items: state.automations
            .filter((each) => each.status === (status ?? each.status))
            .filter((each) => status === 'archived' || each.status !== 'archived')
            .filter((each) => folder === null || (each.folderId ?? 'root') === folder)
            .filter((each) => q === undefined || each.name.toLowerCase().includes(q))
            .map(summaryOf),
          nextCursor: null,
          canManage: state.flags.canManage,
        },
      });
      return;
    }
    if (method === 'POST' && path === '') {
      const { document } = createAutomationInput.parse(body);
      const created = automationOf({
        ...state.flags,
        // The first automation of a business has the id the tests know; later ones their own.
        id: state.automations.some((each) => each.id === automationId)
          ? `aut_01k8e2wzr0e0080000000001${String(state.automations.length).padStart(2, '0')}`
          : automationId,
        name: String(document['name']),
        description: '',
        draft: document,
        draftVersion: 1,
      });
      state.automations = [created, ...state.automations];
      await route.fulfill({
        status: 201,
        json: { automation: created, validation: checksOf(document, state.setup) },
      });
      return;
    }

    const [, id, action, detail] = path.split('/');
    const current = state.automations.find((automation) => automation.id === id);
    if (current === undefined) {
      await route.fulfill(problem(404, 'Not Found'));
      return;
    }
    const keep = (next: Held): Held => {
      state.automations = state.automations.map((each) => (each.id === next.id ? next : each));
      return next;
    };
    const stale = problem(409, 'Conflict', {
      detail: `The draft is at version ${String(current.draftVersion)}: someone saved it since. Read it again and reapply your change.`,
    });

    if (method === 'GET' && action === undefined) {
      await route.fulfill({ json: { ...current, ...state.flags } });
    } else if (method === 'GET' && action === 'stats') {
      await route.fulfill({ json: { ...state.stats, automationId: current.id } });
    } else if (method === 'DELETE' && action === undefined) {
      await route.fulfill({
        json: keep({
          ...current,
          status: 'archived',
          folderId: null,
          deletedAt: stamp,
          purgeAt: '2026-11-08T09:00:00.000Z',
        }),
      });
    } else if (method === 'POST' && action === 'restore') {
      await route.fulfill({
        json: keep({
          ...current,
          status: current.liveVersion === null ? 'draft' : 'paused',
          deletedAt: null,
          purgeAt: null,
        }),
      });
    } else if (method === 'PUT' && action === 'folder') {
      await route.fulfill({
        json: keep({ ...current, folderId: moveAutomationInput.parse(body).folderId }),
      });
    } else if (method === 'PATCH' && action === 'draft') {
      const input = patchAutomationDraftInput.parse(body);
      if (input.baseDraftVersion !== current.draftVersion) {
        await route.fulfill(stale);
        return;
      }
      // The one patch the screens send: a new name.
      const renamed = input.patch.find((each) => each.path === '/name')?.value;
      const name = typeof renamed === 'string' ? renamed : current.name;
      const saved = keep({
        ...current,
        name,
        draft: { ...current.draft, name },
        draftVersion: current.draftVersion + 1,
      });
      await route.fulfill({
        json: { automation: saved, validation: checksOf(saved.draft, state.setup) },
      });
    } else if (method === 'GET' && action === 'runs') {
      const query = new URL(request.url()).searchParams;
      state.runQueries.push(query.toString());
      const status = query.get('status');
      const record = query.get('record');
      await route.fulfill({
        json: {
          items: state.runs
            .filter((run) => status === null || run['status'] === status)
            .filter((run) => record === null || run['recordId'] === record),
          nextCursor: null,
        },
      });
    } else if (method === 'GET' && action === 'step-runs') {
      const query = new URL(request.url()).searchParams;
      state.stepRunQueries.push(query.toString());
      const status = query.get('status');
      const wanted = query.get('step');
      await route.fulfill({
        json: {
          items: state.stepRuns
            .filter((entry) => status === null || entry['status'] === status)
            .filter((entry) => wanted === null || entry['step'] === wanted),
          nextCursor: null,
        },
      });
    } else if (method === 'GET' && action === 'explain-contact') {
      const contact = new URL(request.url()).searchParams.get('contactId') ?? '';
      const answer = state.explanations?.[contact];
      await route.fulfill(answer === undefined ? problem(404, 'Not Found') : { json: answer });
    } else if (method === 'POST' && action === 'test-runs') {
      await route.fulfill({ status: 201, json: state.testRun });
    } else if (method === 'GET' && action === 'versions' && detail === undefined) {
      await route.fulfill({ json: { items: state.versions ?? [], nextCursor: null } });
    } else if (method === 'GET' && action === 'versions' && detail !== undefined) {
      // The version a run began on, which names its steps.
      const number = Number(detail);
      await route.fulfill({
        json: {
          ...versionTwo,
          version: number,
          document: state.versionDocuments?.[number] ?? versionTwo.document,
        },
      });
    } else if (method === 'PUT' && action === 'draft') {
      const input = replaceAutomationDraftInput.parse(body);
      if (input.baseDraftVersion !== current.draftVersion) {
        await route.fulfill(stale);
        return;
      }
      if (state.saveRefusal !== undefined) {
        const errors = state.saveRefusal;
        state.saveRefusal = undefined;
        await route.fulfill(problem(422, 'Unprocessable Content', { errors }));
        return;
      }
      const saved = keep({
        ...current,
        name: String(input.document['name']),
        draft: input.document,
        draftVersion: current.draftVersion + 1,
      });
      await route.fulfill({
        json: { automation: saved, validation: checksOf(saved.draft, state.setup, saved.id) },
      });
    } else if (method === 'POST' && action === 'publish') {
      const input = publishAutomationInput.parse(body);
      if (input.baseDraftVersion !== current.draftVersion) {
        await route.fulfill(stale);
        return;
      }
      const result = validateAutomation(current.draft, state.setup);
      if (result.document === undefined) {
        await route.fulfill(problem(422, 'Unprocessable Content', { errors: result.errors }));
        return;
      }
      const version = (current.liveVersion ?? 0) + 1;
      await route.fulfill({
        json: keep({
          ...current,
          status: current.status === 'paused' ? 'paused' : 'active',
          liveVersion: version,
          live: {
            id: versionId,
            version,
            changeSummary: input.changeSummary,
            publishedAt: stamp,
            document: { ...result.document },
          },
        }),
      });
    } else if (method === 'POST' && (action === 'pause' || action === 'resume')) {
      await route.fulfill({
        json: keep({ ...current, status: action === 'pause' ? 'paused' : 'active' }),
      });
    } else {
      await route.fulfill(problem(404, 'Not Found'));
    }
  });
}

/** Answers /api/v1/automation-folders as the server does: one name per place, by revision. */
export async function foldersApi(page: Page, state: World): Promise<void> {
  await page.route('**/api/v1/automation-folders**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/v1\/automation-folders/, '');
    const body: unknown =
      method === 'GET' || method === 'DELETE' ? undefined : request.postDataJSON();
    if (method !== 'GET') state.writes.push({ method, path: `/automation-folders${path}`, body });
    const taken = (name: string, parentId: string | null, but?: string): boolean =>
      state.folders.some(
        (each) =>
          each.id !== but &&
          each.parentId === parentId &&
          each.name.toLowerCase() === name.toLowerCase(),
      );
    const nameTaken = problem(409, 'Conflict', {
      detail: 'Another folder here already has that name.',
    });
    if (method === 'GET') {
      await route.fulfill({
        json: {
          canManage: state.flags.canManage,
          items: state.folders.map((folder) => ({
            ...folder,
            automationCount: state.automations.filter((each) => each.folderId === folder.id).length,
          })),
        },
      });
      return;
    }
    if (method === 'POST') {
      const input = createAutomationFolderInput.parse(body);
      if (taken(input.name, input.parentId)) {
        await route.fulfill(nameTaken);
        return;
      }
      const created = folderOf(
        `afol_01k8e2wzr0e0080000000002${String(state.folders.length).padStart(2, '0')}`,
        input.name,
        { parentId: input.parentId },
      );
      state.folders = [...state.folders, created].sort((one, other) =>
        one.name.localeCompare(other.name),
      );
      await route.fulfill({ status: 201, json: created });
      return;
    }
    const id = path.slice(1);
    const current = state.folders.find((folder) => folder.id === id);
    if (current === undefined) {
      await route.fulfill(problem(404, 'Not Found'));
      return;
    }
    if (method === 'PATCH') {
      const input = updateAutomationFolderInput.parse(body);
      if (input.revision !== current.revision) {
        await route.fulfill(problem(409, 'Conflict', { detail: 'The folder has changed.' }));
        return;
      }
      const next = {
        ...current,
        name: input.name ?? current.name,
        parentId: input.parentId === undefined ? current.parentId : input.parentId,
        revision: current.revision + 1,
      };
      if (taken(next.name, next.parentId, current.id)) {
        await route.fulfill(nameTaken);
        return;
      }
      state.folders = state.folders.map((folder) => (folder.id === id ? next : folder));
      await route.fulfill({ json: next });
      return;
    }
    // Deleting moves what was in it up one level, and deletes nothing else.
    state.folders = state.folders
      .filter((folder) => folder.id !== id)
      .map((folder) =>
        folder.parentId === id ? { ...folder, parentId: current.parentId } : folder,
      );
    state.automations = state.automations.map((each) =>
      each.folderId === id ? { ...each, folderId: current.parentId } : each,
    );
    await route.fulfill({ status: 204 });
  });
}

export type BuilderView = 'canvas' | 'steps' | 'json' | 'settings' | 'runs' | 'logs';

/** The builder's address: the canvas is the view an address without one opens. */
export const builderAt = (view?: BuilderView, run?: string): string =>
  inHarbor(
    `/automations?automation=${automationId}${
      view === undefined || view === 'canvas' ? '' : `&view=${view}`
    }${run === undefined ? '' : `&run=${run}`}`,
  );

/** Answers the reads of runs that are not under /automations: one run, and a record's runs. */
export async function runsApi(page: Page, state: World): Promise<void> {
  // A failed run, run again: refused in the server's words, or going on from where it failed.
  await page.route('**/api/v1/automation-runs/*/retry', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    state.writes.push({ method: 'POST', path: `/automation-runs/${id}/retry`, body: undefined });
    const run = state.runDetails[id];
    if (state.retryRefusal !== undefined) {
      await route.fulfill(problem(409, 'Conflict', { detail: state.retryRefusal }));
      return;
    }
    const again = { ...(run as Record<string, unknown>), status: 'running', exitReason: null };
    state.runDetails = { ...state.runDetails, [id]: again };
    await route.fulfill({ json: again });
  });
  // A waiting run, continued now: refused in the server's words when it has moved since it
  // was read, or going on down the branch named, with the step saying who continued it.
  await page.route('**/api/v1/automation-runs/*/continue', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    const body: unknown = route.request().postDataJSON();
    state.writes.push({ method: 'POST', path: `/automation-runs/${id}/continue`, body });
    if (state.continueRefusal !== undefined) {
      await route.fulfill(problem(409, 'Conflict', { detail: state.continueRefusal }));
      return;
    }
    const run = state.runDetails[id] as Record<string, unknown>;
    const branch = (body as { branch?: string }).branch ?? null;
    const steps = (run['steps'] as Record<string, unknown>[]).map((each, place, all) =>
      place === all.length - 1
        ? {
            ...each,
            status: 'succeeded',
            branch,
            explanation: 'Continued by Dana Brooks before the wait ended.',
            output: { continuedBy: 'Dana Brooks', continuedAt: stamp },
          }
        : each,
    );
    const moved = {
      ...run,
      status: 'running',
      wakeAt: null,
      revision: 'rev-2',
      continuable: null,
      steps,
    };
    state.runDetails = { ...state.runDetails, [id]: moved };
    state.runs = state.runs.map((each) =>
      each['id'] === id ? { ...each, status: 'running', wakeAt: null, continuable: null } : each,
    );
    await route.fulfill({ json: moved });
  });
  await page.route('**/api/v1/automation-runs/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
    const run = state.runDetails[id];
    await route.fulfill(run === undefined ? problem(404, 'Not Found') : { json: run });
  });
  await page.route(/\/api\/v1\/records\/[^/]+\/automation-runs(?:\?.*)?$/, async (route) => {
    const record = new URL(route.request().url()).pathname.split('/').at(-2);
    await route.fulfill({
      json: { items: state.runs.filter((run) => run['recordId'] === record), nextCursor: null },
    });
  });
}

/**
 * Signs in, serves the world, and opens the builder on the follow-up automation: in the
 * Steps view, unless the test names another.
 */
export async function openBuilder(
  page: Page,
  state: World,
  view: BuilderView = 'steps',
  run?: string,
): Promise<void> {
  await signedIn(page);
  await automationsApi(page, state);
  await runsApi(page, state);
  await page.goto(builderAt(view, run));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Automation views' })).toBeVisible();
}

export const step = (page: Page, id: string): Locator => page.locator(`#automation-step-${id}`);
export const json = (page: Page): Locator => page.getByLabel('Automation JSON', { exact: true });
export const view = (page: Page, name: 'Canvas' | 'Steps' | 'JSON'): Locator =>
  page
    .getByRole('navigation', { name: 'Automation views' })
    .getByRole('link', { name, exact: true });
export const tab = (
  page: Page,
  name: 'Builder' | 'Settings' | 'Enrollment history' | 'Execution logs',
): Locator =>
  page
    .getByRole('navigation', { name: 'Workflow', exact: true })
    .getByRole('link', { name, exact: true });

export async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** A live version: the follow-up as the server keeps a published document, resolved. */
export function published(version: number): Pick<Automation, 'status' | 'liveVersion' | 'live'> {
  const resolved = validateAutomation(followUp, harborSetup).document;
  if (resolved === undefined) throw new Error('The fixture is a valid automation.');
  return {
    status: 'active',
    liveVersion: version,
    live: {
      id: versionId,
      version,
      changeSummary: 'First version',
      publishedAt: stamp,
      document: { ...resolved },
    },
  };
}
