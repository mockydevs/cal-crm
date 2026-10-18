// @vitest-environment jsdom
// The builder's less-travelled paths: triggers, each kind of setting, the JSON view's
// tools, requests that fail, and leaving with unsaved changes. Its main paths are in
// automation-builder.test.tsx, which this file's surroundings are the same as.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Automation } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automationId,
  automationOf,
  catalogOf,
  followUp,
  harborSetup,
  stamp,
  versionId,
  welcome,
} from '../e2e/automation-fixtures';
import AutomationBuilder from './automation-builder';
// Loaded here, before any test starts: the page fetches these lazily, and a test that had to
// wait for their code to be read for the first time lost that race on a busy machine. With
// them loaded, a test waits on React alone.
import './automation-canvas';
import './automation-runs';
import './automation-canvas-library';
import './automation-step-dialog';
import './automation-steps-view';
import './automation-resume-window';
import './automation-merge-insert';
import './automation-tile';
import './automation-email-copy';
import './automation-publish-dialog';
import { updateStepConfig, type Draft } from './automation-document';
import type { AutomationsSearch, AutomationView } from './automation-navigation';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
/** What the builder asks the router: whether to hold someone who is leaving. */
interface LeaveGuard {
  shouldBlockFn: (leaving: {
    current: { pathname: string };
    next: { pathname: string; search: unknown };
  }) => boolean;
  enableBeforeUnload: () => boolean;
}
interface Router {
  blocker: { status: 'idle' } | { status: 'blocked'; proceed: () => void; reset: () => void };
  guard: LeaveGuard | undefined;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
const router = vi.hoisted((): Router => ({ blocker: { status: 'idle' }, guard: undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('./shell/page', () => ({
  usePageTitle: () => undefined,
  Page: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useBlocker: (guard: LeaveGuard) => {
    router.guard = guard;
    return router.blocker;
  },
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  // jsdom lays nothing out, so it has no scrolling to do.
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  server.calls.length = 0;
  router.blocker = { status: 'idle' };
});
afterEach(cleanup);

function serve(
  automation: Automation,
  more: Partial<Record<string, (input: unknown) => unknown>> = {},
  setup = harborSetup,
): void {
  server.answer = (operation, input) => {
    const custom = more[operation];
    if (custom !== undefined) return custom(input);
    if (operation === 'getAutomation') return automation;
    if (operation === 'getAutomationCatalog') return catalogOf(setup);
    throw new Error(`Unexpected request: ${operation}`);
  };
}

/** Where a test starts: the Steps view unless it says another, the canvas by its own name. */
type Start = Omit<AutomationsSearch, 'view'> & { readonly view?: AutomationView };

function Harness({ start = {} }: { readonly start?: Start }): ReactElement {
  const [search, setSearch] = useState<Start>({ view: 'steps', ...start });
  return (
    <AutomationBuilder
      automationId={automationId}
      // As the page does: an address with no view is the canvas.
      view={search.view ?? 'canvas'}
      navigation={{ hrefFor: (to) => `?view=${to.view ?? 'canvas'}`, go: setSearch }}
    />
  );
}

function show(start: Start = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <Harness start={start} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function open(start: Start = {}): Promise<ReturnType<typeof userEvent.setup>> {
  show(start);
  await screen.findByRole('heading', { level: 1, name: followUp.name });
  // The Steps view's code arrives after the builder's own.
  await waitFor(() => {
    expect(screen.queryByText('Loading the steps…')).toBeNull();
  });
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return userEvent.setup({ delay: null });
}

const json = (): HTMLTextAreaElement => screen.getByLabelText('Automation JSON');
const writeJson = (value: unknown): void => {
  fireEvent.change(json(), {
    target: { value: typeof value === 'string' ? value : JSON.stringify(value) },
  });
};
const edited = updateStepConfig(followUp, 'wait_2_days', { duration: 'P5D' });
const conflict = (): ApiError =>
  new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 });
const forbidden = (): ApiError =>
  new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
const offline = (): TypeError => new TypeError('Failed to fetch');
const closed = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
};

describe('ways to start', () => {
  // Adding, changing and removing were one test once: about thirty clicks and as many
  // searches of the page by role, which is seconds on a busy machine. Each is its own test
  // now, starting from the automation the one before would have left.
  const starts = (): HTMLElement => screen.getByRole('list', { name: 'What starts it' });
  const bothTriggers = (config: Record<string, string> = {}): unknown[] => [
    ...followUp.triggers,
    { id: 'deal_closed', type: 'deal.closed', config },
  ];
  const withDealClosed = (config: Record<string, string> = {}): Draft => ({
    ...followUp,
    triggers: bothTriggers(config),
  });

  it('adds a trigger, after choosing another kind first', async () => {
    serve(automationOf());
    const user = await open();
    // The only way to start cannot be removed.
    expect(within(starts()).queryByRole('button', { name: /^Remove:/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add trigger' }));
    const picker = await screen.findByRole('dialog', { name: 'Add trigger' });
    await user.click(within(picker).getByRole('button', { name: /^Tag added/ }));
    const wrong = await screen.findByRole('dialog', { name: 'Tag added' });
    await user.click(within(wrong).getByRole('button', { name: 'Back' }));
    const again = await screen.findByRole('dialog', { name: 'Add trigger' });
    await user.click(within(again).getByRole('button', { name: /^Opportunity closed/ }));
    const adding = await screen.findByRole('dialog', { name: 'Opportunity closed' });
    await user.click(within(adding).getByRole('button', { name: 'Save trigger' }));
    await closed();
    expect(within(starts()).getAllByRole('group')).toHaveLength(2);
    expect(within(starts()).getByText('An opportunity is won or lost')).toBeDefined();
    expect((JSON.parse(json().value) as { triggers: unknown[] }).triggers).toEqual(bothTriggers());
  });

  it('changes a trigger', async () => {
    serve(automationOf({ draft: withDealClosed() }));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Edit: An opportunity is won or lost' }));
    const editing = await screen.findByRole('dialog', { name: 'Opportunity closed' });
    await user.click(within(editing).getByRole('combobox', { name: 'Pipeline (optional)' }));
    await user.click(await screen.findByRole('option', { name: 'Sales' }));
    await user.click(within(editing).getByRole('combobox', { name: 'Outcome (optional)' }));
    await user.click(await screen.findByRole('option', { name: 'Won' }));
    await user.click(within(editing).getByRole('button', { name: 'Save trigger' }));
    await closed();
    expect(within(starts()).getByText('An opportunity is won, in Sales')).toBeDefined();
    expect((JSON.parse(json().value) as { triggers: unknown[] }).triggers).toEqual(
      bothTriggers({ pipeline: 'pip_sales', outcome: 'won' }),
    );
  });

  it('removes a trigger, but keeps the last one', async () => {
    serve(automationOf({ draft: withDealClosed({ pipeline: 'pip_sales', outcome: 'won' }) }));
    const user = await open();
    expect(within(starts()).getByText('An opportunity is won, in Sales')).toBeDefined();
    await user.click(
      screen.getByRole('button', { name: 'Remove: Someone submits “Request a quote”' }),
    );
    const asking = await screen.findByRole('dialog', { name: 'Delete this trigger?' });
    expect(within(asking).getByText('The workflow will no longer start this way.')).toBeDefined();
    await user.click(within(asking).getByRole('button', { name: 'Delete trigger' }));
    await closed();
    expect((JSON.parse(json().value) as { triggers: unknown[] }).triggers).toEqual([
      { id: 'deal_closed', type: 'deal.closed', config: { pipeline: 'pip_sales', outcome: 'won' } },
    ]);
    expect(within(starts()).queryByRole('button', { name: /^Remove:/ })).toBeNull();
  });

  it('shows what the checks found about a trigger on the trigger', async () => {
    const draft: Draft = {
      ...followUp,
      triggers: [{ id: 'quote_form', type: 'form.submitted', config: { form: 'No such form' } }],
    };
    serve(automationOf({ draft }));
    const user = await open();
    const trigger = screen.getByRole('group', { name: /^Starts when:/ });
    expect(within(trigger).getByText('Error:')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Checks' })).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Published' }));
    const publish = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    expect(within(publish).getByText('/triggers/0/config/form')).toBeDefined();
    expect(within(publish).getByRole('button', { name: 'Publish' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('a step form', () => {
  const add = async (
    user: ReturnType<typeof userEvent.setup>,
    choice: RegExp,
    title: string,
  ): Promise<HTMLElement> => {
    await user.click(screen.getByRole('button', { name: 'Add an action at the start' }));
    const picker = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(picker).getByRole('button', { name: choice }));
    return screen.findByRole('dialog', { name: title });
  };
  const configOf = (id: string): unknown =>
    (JSON.parse(json().value) as { steps: Record<string, { config?: unknown }> }).steps[id]?.config;

  it("puts the contract's own message under the setting, and the keyboard on it", async () => {
    serve(automationOf());
    const user = await open();
    const form = await add(user, /^Call a webhook/, 'Call a webhook');
    const url = within(form).getByRole('textbox', { name: 'Web address' });
    await user.type(url, 'http://insecure.example.test');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(within(form).getByText('Use an https:// address.')).toBeDefined();
    expect(url.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(url);
    });
    await user.clear(url);
    await user.type(url, 'https://hooks.example.test/lead');
    expect(within(form).queryByText('Use an https:// address.')).toBeNull();
    await user.click(within(form).getByRole('combobox', { name: 'Method (optional)' }));
    await user.click(await screen.findByRole('option', { name: 'PUT' }));
    await user.type(within(form).getByRole('textbox', { name: 'Body (optional)' }), 'hello');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await closed();
    expect(configOf('webhook_call')).toEqual({
      url: 'https://hooks.example.test/lead',
      method: 'PUT',
      body: 'hello',
    });
  });

  it("offers a pipeline's own stages, and drops a stage when the pipeline changes", async () => {
    const setup = {
      ...harborSetup,
      pipelines: [
        ...harborSetup.pipelines,
        { id: 'pip_events', name: 'Events', stages: [{ id: 'stg_booked', name: 'Booked' }] },
      ],
    };
    serve(automationOf(), {}, setup);
    const user = await open();
    const form = await add(user, /^Create opportunity/, 'Create opportunity');
    await user.click(within(form).getByRole('combobox', { name: 'Stage' }));
    // The list that opened: the form's own lists of merge fields are not it.
    expect(
      within(await screen.findByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose one', 'Sales · New lead', 'Sales · Quoted', 'Events · Booked']);
    await user.click(screen.getByRole('option', { name: 'Sales · Quoted' }));
    await user.click(within(form).getByRole('combobox', { name: 'Pipeline' }));
    await user.click(await screen.findByRole('option', { name: 'Events' }));
    // Quoted isn't one of Events' stages, so the stage is to choose again.
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(within(form).getAllByText('Fill this in.')).toHaveLength(1);
    await user.click(within(form).getByRole('combobox', { name: 'Stage' }));
    await user.click(await screen.findByRole('option', { name: 'Booked' }));
    await user.type(within(form).getByRole('spinbutton', { name: 'Amount (optional)' }), '250');
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await closed();
    expect(configOf('deal_create')).toEqual({
      pipeline: 'pip_events',
      stage: 'stg_booked',
      amount: 250,
    });
  });

  it('keeps in sight a value the business lacks, and a length of time it cannot hold', async () => {
    const draft: Draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        send_guide: { ...followUp.steps.send_guide, config: { template: 'Old guide' } },
        wait_2_days: { ...followUp.steps.wait_2_days, config: { duration: 'P1DT12H' } },
      },
    };
    serve(automationOf({ draft }));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Edit: Send the email “Old guide”' }));
    const email = await screen.findByRole('dialog', { name: 'Send email' });
    expect(
      await within(email).findByRole('button', {
        name: 'Email template: Old guide (not found)',
      }),
    ).toBeDefined();
    await user.click(within(email).getByRole('button', { name: 'Cancel' }));
    await closed();

    await user.click(screen.getByRole('button', { name: 'Edit: Wait 1 day and 12 hours' }));
    const wait = await screen.findByRole('dialog', { name: 'Wait' });
    expect(within(wait).getByText('1 day and 12 hours')).toBeDefined();
    expect(within(wait).queryByRole('spinbutton')).toBeNull();
    // A length of more than one unit is the one setting here still edited in JSON; the
    // hours a wait may go on in have a control of their own.
    expect(
      await within(wait).findByRole('switch', { name: 'Only go on during certain hours' }),
    ).toBeDefined();
    expect(
      within(wait).getAllByText('This setting is edited in the JSON view.').length,
    ).toBeGreaterThan(0);
  });

  it('starts a new If / else with one condition to change, as rows', async () => {
    serve(automationOf());
    const user = await open();
    const form = await add(user, /^If \/ else/, 'If / else');
    expect(within(form).getByRole('combobox', { name: 'Field of condition 1' }).textContent).toBe(
      'Email',
    );
    expect(
      within(form).getByRole('combobox', { name: 'Comparison of condition 1' }).textContent,
    ).toBe('Is filled in');
    expect(within(form).queryByRole('button', { name: 'Edit in JSON' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await closed();
    // What used to be first now follows the new step's first branch.
    expect(JSON.parse(json().value)).toMatchObject({
      start: 'condition',
      steps: { condition: { next: { yes: 'send_guide' } } },
    });
    expect(screen.getAllByRole('group', { name: 'If no' })[0]?.textContent).toMatch(
      /Then it ends\./,
    );
  });

  it('leads a step this version does not know, and what stops the automation, to the JSON view', async () => {
    const draft: Draft = {
      ...followUp,
      steps: { ...followUp.steps, last_check_in: { type: 'contact.delete', config: {} } },
    };
    serve(automationOf({ draft }));
    const user = await open();
    expect(screen.getByText('Unknown step: contact.delete')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Edit in JSON: last_check_in' }));
    expect(document.activeElement).toBe(json());
    expect(JSON.parse(json().value.slice(json().selectionStart, json().selectionEnd))).toEqual({
      type: 'contact.delete',
      config: {},
    });
    await user.click(screen.getByRole('link', { name: 'Steps' }));
    await user.click(screen.getByRole('button', { name: 'Edit in JSON: what stops it' }));
    expect(JSON.parse(json().value.slice(json().selectionStart, json().selectionEnd))).toEqual(
      followUp.stopWhen,
    );
  });
});

describe('an unfinished or unusual document', () => {
  const wait = (next?: string): Record<string, unknown> => ({
    type: 'wait',
    config: { duration: 'P1D' },
    ...(next === undefined ? {} : { next }),
  });
  const check = (yes: string, no: string): Record<string, unknown> => ({
    type: 'condition',
    config: { if: { field: 'contact.email', operator: 'is_set' } },
    next: { yes, no },
  });

  it('shows where paths meet, where one leads nowhere, and what nothing leads to', async () => {
    const draft: Draft = {
      name: followUp.name,
      triggers: [{ id: 'ping', type: 'ping.received', config: {} }],
      stopWhen: [{ event: 'ping.received' }],
      start: 'either',
      steps: {
        either: check('one', 'other'),
        one: wait('shared'),
        other: wait('shared'),
        shared: wait('gone'),
        stray: wait(),
      },
    };
    serve(automationOf({ draft }));
    const user = await open();
    expect(screen.getByText('Unknown trigger: ping.received')).toBeDefined();
    expect(screen.getByText('Unknown event: ping.received')).toBeDefined();
    const yes = screen.getByRole('group', { name: 'If yes' });
    const no = screen.getByRole('group', { name: 'If no' });
    expect(within(yes).getByText("Then it leads to a step that isn't there: gone")).toBeDefined();
    expect(within(no).getByText('Then it carries on at: Wait 1 day')).toBeDefined();
    const loose = screen.getByRole('region', { name: 'Not connected' });
    expect(within(loose).getByText('Never runs')).toBeDefined();
    expect(loose.querySelector('#automation-step-stray')).not.toBeNull();

    // A trigger this version doesn't know is edited as JSON.
    await user.click(screen.getByRole('button', { name: 'Edit in JSON: ping.received' }));
    expect(JSON.parse(json().value.slice(json().selectionStart, json().selectionEnd))).toEqual({
      id: 'ping',
      type: 'ping.received',
      config: {},
    });
  });

  it('adds a step at the top of a branch', async () => {
    serve(automationOf());
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Add an action to: If yes' }));
    const picker = await screen.findByRole('dialog', { name: 'Actions' });
    await user.click(within(picker).getByRole('button', { name: /^Draft a reply with AI/ }));
    const form = await screen.findByRole('dialog', { name: 'Draft a reply with AI' });
    await user.type(
      within(form).getByRole('textbox', { name: 'Instructions for the AI (optional)' }),
      'Keep it short.',
    );
    await user.click(within(form).getByRole('button', { name: 'Save action' }));
    await closed();
    expect(JSON.parse(json().value)).toMatchObject({
      steps: {
        asked_about_video: { next: { yes: 'ai_draft_reply', no: 'check_in' } },
        ai_draft_reply: { config: { instructions: 'Keep it short.' }, next: 'send_reel' },
      },
    });
  });

  it('says an automation with nothing in it has nothing, to someone who can only look', async () => {
    serve(automationOf({ draft: { name: followUp.name }, canManage: false }));
    await open();
    expect(
      screen.getByText(
        'Nothing starts this automation on its own. Add a way to start it, or leave it so if another automation starts it.',
      ),
    ).toBeDefined();
    expect(screen.getByText('This automation has no steps yet.')).toBeDefined();
    expect(
      screen.getByText(
        'Nothing stops it early. Each contact goes through to the end of their path.',
      ),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull();
  });

  it('says how many steps a removal cuts off, for one as for several', async () => {
    const draft: Draft = {
      ...followUp,
      start: 'either',
      steps: { either: check('one', 'other'), one: wait(), other: wait() },
    };
    serve(automationOf({ draft }));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Remove: If email is filled in' }));
    const asking = await screen.findByRole('dialog', { name: 'Delete this action?' });
    expect(
      within(asking).getByText(
        /^1 action on its other branches will no longer be connected\. It stays/,
      ),
    ).toBeDefined();
    await user.click(within(asking).getByRole('button', { name: 'Delete action' }));
    await closed();
    const [remove] = screen.getAllByRole('button', { name: 'Remove: Wait 1 day' });
    if (remove === undefined) throw new Error('Each step left can be removed.');
    await user.click(remove);
    const last = await screen.findByRole('dialog', { name: 'Delete this action?' });
    expect(within(last).getByText('The path will end where this action was.')).toBeDefined();
  });
});

describe("the JSON view's tools", () => {
  it('copies the text, and says when it cannot', async () => {
    serve(automationOf());
    const user = await open({ view: 'json' });
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copied.')).toBeDefined();
    expect(writeText).toHaveBeenCalledWith(json().value);
    writeText.mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByText("Couldn't copy. Select the text and copy it yourself."),
    ).toBeDefined();
  });

  it('downloads the text as a file named after the automation', async () => {
    serve(automationOf());
    const user = await open({ view: 'json' });
    const blobs: Blob[] = [];
    URL.createObjectURL = (blob: Blob | MediaSource): string => {
      if (blob instanceof Blob) blobs.push(blob);
      return 'blob:automation';
    };
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function download(this: HTMLAnchorElement) {
        names.push(this.download);
      });
    await user.click(screen.getByRole('button', { name: 'Download' }));
    click.mockRestore();
    expect(names).toEqual(['new-lead-follow-up.json']);
    const [blob] = blobs;
    if (blob === undefined) throw new Error('The download has content.');
    expect(JSON.parse(await blob.text())).toEqual(followUp);
    expect(screen.getByText('Downloaded.')).toBeDefined();
  });

  it('imports a file, and says when a file is not an automation', async () => {
    serve(automationOf());
    const user = await open({ view: 'json' });
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import an automation' });
    const file = within(dialog).getByLabelText('Open a JSON file');
    await user.upload(file, new File(['[1, 2, 3]'], 'list.json', { type: 'application/json' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'An automation is a JSON object: it starts with { and ends with }.',
    );
    await user.upload(
      file,
      new File([JSON.stringify({ ...followUp, name: 'From a file' })], 'automation.json', {
        type: 'application/json',
      }),
    );
    await closed();
    expect(screen.getByRole('heading', { level: 1, name: 'From a file' })).toBeDefined();
    expect(screen.getByText('Imported. Check it, then save the draft.')).toBeDefined();
    expect(screen.getByTestId('automation-unsaved')).toBeDefined();
  });

  it('says what kind of mistake the text has, and goes to it', async () => {
    serve(automationOf());
    const user = await open({ view: 'json' });
    const cases: readonly (readonly [string, RegExp])[] = [
      ['', /^Not valid JSON yet\. There is nothing here yet\./],
      ['{"name": "x"', /Line 1, column 13: The JSON stops too early\./],
      ['{"name": "x"} }', /Line 1, column 15: There is extra text after the end of the JSON\./],
      ['[]', /An automation is a JSON object/],
    ];
    for (const [text, message] of cases) {
      writeJson(text);
      expect(screen.getByText('Not valid JSON yet.').parentElement?.textContent).toMatch(message);
      expect(screen.getByTestId('automation-json-state').textContent).toBe("Can't be read yet");
    }
    writeJson('{"name": "x",\n "steps": tru}');
    await user.click(screen.getByRole('button', { name: 'Go to the mistake' }));
    expect(document.activeElement).toBe(json());
    expect(json().value.slice(json().selectionStart, json().selectionEnd)).toBe('t');
    expect(screen.getByText('Line 2, column 11')).toBeDefined();
  });
});

describe('when a request fails', () => {
  it("says the draft was not saved, in the server's words when it gave any, and keeps it", async () => {
    let failure: unknown = forbidden();
    serve(automationOf(), {
      replaceAutomationDraft: () => {
        throw failure;
      },
    });
    const user = await open({ view: 'json' });
    writeJson(edited);
    const mine = json().value;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText("You don't have permission to change workflows.");
    failure = new ApiError({
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      errors: [
        {
          path: '/document/name',
          code: 'invalid_name',
          message: 'Name the automation, in 1 to 120 characters.',
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Name the automation, in 1 to 120 characters.');
    failure = offline();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText("We couldn't save the draft. Check your connection and try again.");
    expect(json().value).toBe(mine);
    expect(screen.getByTestId('automation-unsaved')).toBeDefined();
  });

  it('says so when the latest version cannot be loaded, and keeps the conflict in sight', async () => {
    let loads = 0;
    serve(automationOf(), {
      getAutomation: () => {
        loads += 1;
        if (loads > 1) throw offline();
        return automationOf();
      },
      replaceAutomationDraft: () => {
        throw conflict();
      },
    });
    const user = await open({ view: 'json' });
    writeJson(edited);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(
      await screen.findByRole('button', { name: 'Load the latest and drop my changes' }),
    );
    await screen.findByText("We couldn't load the latest version. Try again.");
    expect(
      screen.getByText('Someone else saved this workflow while you were editing.'),
    ).toBeDefined();
    expect(JSON.parse(json().value)).toEqual(edited);
  });

  it('says so when pausing is refused, or publishing fails without a reason', async () => {
    const live = {
      id: versionId,
      version: 1,
      changeSummary: '',
      publishedAt: stamp,
      document: welcome as unknown as Record<string, unknown>,
    };
    serve(automationOf({ status: 'active', liveVersion: 1, live }), {
      pauseAutomation: () => {
        throw forbidden();
      },
      publishAutomation: () => {
        throw offline();
      },
    });
    const user = await open();
    const toggle = screen.getByRole('switch', { name: 'Published' });
    await user.click(toggle);
    await screen.findByText("You don't have permission to publish or unpublish workflows.");
    // Refused, so it is still published.
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(await screen.findByRole('button', { name: 'Publish changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "We couldn't publish. Check your connection and try again.",
    );
  });

  it('tells the person when someone else saved before they published', async () => {
    serve(automationOf(), {
      publishAutomation: () => {
        throw conflict();
      },
    });
    const user = await open();
    await user.click(screen.getByRole('switch', { name: 'Published' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await screen.findByText('Someone else saved this workflow while you were editing.');
    await closed();
  });

  it('offers to try again when the builder cannot load what it needs', async () => {
    let failing = true;
    serve(automationOf(), {
      getAutomationCatalog: () => {
        if (failing) throw offline();
        return catalogOf();
      },
    });
    show();
    // The builder tries twice more before it gives up.
    const alert = await screen.findByRole('alert', {}, { timeout: 10_000 });
    expect(alert.textContent).toMatch(/We couldn't load this workflow\./);
    failing = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: followUp.name })).toBeDefined();
  }, 15_000);
});

describe('leaving', () => {
  const leaving = (pathname: string, search: unknown): boolean | undefined =>
    router.guard?.shouldBlockFn({
      current: { pathname: '/b/harbor/automations' },
      next: { pathname, search },
    });

  it('holds back someone with unsaved changes, but not for a change of view', async () => {
    serve(automationOf());
    await open({ view: 'json' });
    expect(leaving('/b/harbor/deals', {})).toBe(false);
    expect(router.guard?.enableBeforeUnload()).toBe(false);

    writeJson({ ...followUp, name: 'Mine' });
    expect(leaving('/b/harbor/deals', {})).toBe(true);
    expect(leaving('/b/harbor/automations', {})).toBe(true);
    expect(leaving('/b/harbor/automations', { automation: 'aut_other' })).toBe(true);
    expect(leaving('/b/harbor/automations', { automation: automationId, view: 'json' })).toBe(
      false,
    );
    expect(router.guard?.enableBeforeUnload()).toBe(true);
  });

  it('never holds back someone who cannot change the automation', async () => {
    serve(automationOf({ canManage: false }));
    await open();
    expect(leaving('/b/harbor/deals', {})).toBe(false);
  });

  it('asks, and does what the person chooses', async () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    router.blocker = { status: 'blocked', proceed, reset };
    serve(automationOf());
    show();
    const user = userEvent.setup();
    const asking = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(asking).getByRole('button', { name: 'Stay here' }));
    expect(reset).toHaveBeenCalledTimes(1);
    await user.click(within(asking).getByRole('button', { name: 'Leave and drop my changes' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });
});
