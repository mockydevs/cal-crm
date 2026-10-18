// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automationId,
  contactIds,
  harborSetup,
  mayaRun,
  priyaRun,
  runIds,
  runList,
  runSummaryOf,
  versionTwo,
} from '../e2e/automation-fixtures';
import { momentsOf } from './automation-history-rules';
import type { AutomationsSearch } from './automation-navigation';
import { RecordAutomationRuns } from './automation-record-runs';
import RunHistory from './automation-runs';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
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
// A link is a link: where it leads is what these tests read.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    search,
    children,
    ...anchor
  }: {
    to: string;
    params: Record<string, string>;
    search?: Record<string, string>;
    children: ReactNode;
    className?: string;
  }) => {
    const path = Object.entries(params).reduce(
      (address, [name, value]) => address.replace(`$${name}`, value),
      to,
    );
    const query = search === undefined ? '' : `?${new URLSearchParams(search).toString()}`;
    return (
      <a {...anchor} href={`${path}${query}`}>
        {children}
      </a>
    );
  },
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const answers = (more: Partial<Record<string, (input: unknown) => unknown>> = {}): void => {
  server.answer = (operation, input) => {
    const custom = more[operation];
    if (custom !== undefined) return custom(input);
    if (operation === 'listAutomationRuns') return runList;
    if (operation === 'getAutomationRun') return mayaRun;
    if (operation === 'getAutomationVersion') return versionTwo;
    throw new Error(`Unexpected request: ${operation}`);
  };
};
const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
const wrap = (children: ReactNode): ReactElement => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider i18n={i18n}>{children}</I18nProvider>
  </QueryClientProvider>
);

function Harness({ start }: { readonly start: AutomationsSearch }): ReactElement {
  const [search, setSearch] = useState(start);
  return (
    <RunHistory
      automationId={automationId}
      runId={search.run}
      setup={harborSetup}
      triggers={[{ id: 'quote_form', name: 'Someone submits “Request a quote”' }]}
      navigation={{
        hrefFor: (to) =>
          `?view=${to.view ?? 'steps'}${to.run === undefined ? '' : `&run=${to.run}`}`,
        go: setSearch,
      }}
    />
  );
}
const open = (start: AutomationsSearch = { automation: automationId, view: 'runs' }) => {
  render(wrap(<Harness start={start} />));
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return userEvent.setup({ delay: null });
};
/** An element a test expects to be there. */
const shown = (element: Element | undefined): HTMLElement => {
  if (!(element instanceof HTMLElement)) throw new Error('Nothing is shown there.');
  return element;
};
const notFound = (): ApiError =>
  new ApiError({ type: 'about:blank', title: 'Not Found', status: 404 });

describe('the enrollment history', () => {
  const rowsOf = (table: HTMLElement): HTMLElement[] => within(table).getAllByRole('row').slice(1);
  const cellsOf = (row: HTMLElement | undefined): (string | null)[] =>
    within(shown(row))
      .getAllByRole('cell')
      .map((cell) => cell.textContent);

  it('lists everyone the workflow enrolled, newest first: why, when, where each stands and what is next', async () => {
    answers();
    open();
    expect(screen.getByRole('status').textContent).toBe('Loading the enrollment history…');
    const table = await screen.findByRole('table', { name: 'Enrollment history' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Record',
      'Enrollment reason',
      'Date enrolled',
      'Current action',
      'Current status',
      'Next execution on',
      'Actions',
    ]);
    const rows = rowsOf(table);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Priya Nair',
      'Jordan Lee',
      'Maya Thompson',
    ]);
    const [priya, jordan, maya] = rows;
    // The trigger is named as the builder names it.
    expect(cellsOf(priya)[0]).toBe('Someone submits “Request a quote”');
    expect(cellsOf(priya)[3]).toBe(
      "FailedFailed: the contact hasn't agreed to marketing messages on this channel.",
    );
    expect(cellsOf(priya)[2]).toBe('');
    expect(cellsOf(jordan)[2]).toBe('If / else');
    expect(cellsOf(jordan)[3]).toBe('Waiting');
    expect(cellsOf(jordan)[4]).toMatch(/^Oct 9, 2026, /);
    expect(cellsOf(maya)[1]).toMatch(/^Oct 6, 2026, .+Version 2$/);
    expect(cellsOf(maya).slice(2, 5)).toEqual(['', 'Finished', '']);
    // Each contact's name leads to the contact; each row leads to its run.
    expect(
      within(shown(maya)).getByRole('link', { name: 'Maya Thompson' }).getAttribute('href'),
    ).toBe(`/b/harbor/contacts/${contactIds.maya}`);
    expect(
      within(shown(maya))
        .getByRole('link', { name: /^Open the run for Maya Thompson, started Oct 6, 2026/ })
        .getAttribute('href'),
    ).toBe(`?view=runs&run=${runIds.maya}`);
    expect(screen.queryByRole('status')).toBeNull();
    expect(callsTo('listAutomationRuns')).toEqual([{ params: { id: automationId }, query: {} }]);
  });

  it('names what enrolled a record by its type when the workflow no longer has that trigger, and says when none is on record', async () => {
    answers({
      listAutomationRuns: () => ({
        items: [
          runSummaryOf('maya', 'Maya Thompson', {
            trigger: { id: 'old_form', type: 'tag.added' },
            status: 'running',
            currentAction: { step: 'send_guide', type: 'email.send', label: 'Send the guide' },
          }),
          runSummaryOf('jordan', 'Jordan Lee', {
            trigger: { id: 'gone', type: null },
            status: 'running',
            currentAction: { step: 'mystery', type: null, label: null },
          }),
          runSummaryOf('priya', 'Priya Nair', {
            trigger: null,
            status: 'exited',
            exitReason: 'stop:message.received',
          }),
        ],
        nextCursor: null,
      }),
    });
    open();
    const rows = rowsOf(await screen.findByRole('table', { name: 'Enrollment history' }));
    expect(cellsOf(rows[0]).slice(0, 4)).toEqual([
      'Tag added',
      expect.stringMatching(/Version 2$/),
      'Send the guide',
      'Running',
    ]);
    expect([cellsOf(rows[1])[0], cellsOf(rows[1])[2]]).toEqual(['gone', 'mystery']);
    expect(cellsOf(rows[2])[0]).toBe('Not recorded');
    expect(cellsOf(rows[2])[3]).toBe(
      'Stopped earlyStopped early, because this happened: They reply.',
    );
  });

  it('narrows by status, by what enrolled, by days and by contact, asking the server', async () => {
    answers({
      listAutomationRuns: (input) => {
        const { status } = (input as { query: { status?: string } }).query;
        return status === 'failed'
          ? { items: [runList.items[0]], nextCursor: null }
          : status === 'cancelled'
            ? { items: [], nextCursor: null }
            : runList;
      },
      listContacts: () => ({
        items: [{ id: contactIds.maya, name: 'Maya Thompson', email: null, phone: null }],
        next: null,
        canManage: true,
      }),
    });
    const user = open();
    await screen.findByRole('table', { name: 'Enrollment history' });
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Failed' }));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Enrollment history' }))).toHaveLength(1);
    });
    expect(callsTo('listAutomationRuns').at(-1)).toEqual({
      params: { id: automationId },
      query: { status: 'failed' },
    });
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Cancelled' }));
    expect(await screen.findByText('No enrollment matches that.')).toBeDefined();
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'All statuses' }));
    await screen.findByRole('table', { name: 'Enrollment history' });

    await user.click(screen.getByRole('combobox', { name: 'Enrollment reason' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'All events',
      'Someone submits “Request a quote”',
    ]);
    await user.click(screen.getByRole('option', { name: 'Someone submits “Request a quote”' }));
    const days = screen.getByRole('group', { name: 'Date range' });
    fireEvent.change(within(days).getByLabelText('From'), { target: { value: '2026-10-06' } });
    fireEvent.change(within(days).getByLabelText('To'), { target: { value: '2026-10-08' } });
    await user.type(screen.getByRole('searchbox', { name: 'Search contacts' }), 'maya');
    await user.click(await screen.findByRole('button', { name: 'Maya Thompson' }));
    await waitFor(() => {
      expect(callsTo('listAutomationRuns').at(-1)).toEqual({
        params: { id: automationId },
        query: {
          ...momentsOf('2026-10-06', '2026-10-08'),
          trigger: 'quote_form',
          record: contactIds.maya,
        },
      });
    });
    await user.click(screen.getByRole('combobox', { name: 'Enrollment reason' }));
    await user.click(await screen.findByRole('option', { name: 'All events' }));
    await waitFor(() => {
      expect(callsTo('listAutomationRuns').at(-1)).toEqual({
        params: { id: automationId },
        query: { ...momentsOf('2026-10-06', '2026-10-08'), record: contactIds.maya },
      });
    });
  });

  it('shows only the runs that need review with one press, and all of them with another', async () => {
    answers();
    const user = open();
    await screen.findByRole('region', { name: 'Enrollment history table' });
    const chip = screen.getByRole('button', { name: 'Needs review' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await user.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => {
      expect(callsTo('listAutomationRuns').at(-1)).toMatchObject({ query: { status: 'failed' } });
    });
    // The status menu says the same thing.
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toBe('Failed');
    await user.click(chip);
    await waitFor(() => {
      expect(callsTo('listAutomationRuns').at(-1)).toEqual({
        params: { id: automationId },
        query: {},
      });
    });
  });

  it('loads more from where the page ended, and refreshes on request', async () => {
    answers({
      listAutomationRuns: (input) =>
        (input as { query: { after?: string } }).query.after === runIds.jordan
          ? { items: [runList.items[2]], nextCursor: null }
          : { items: runList.items.slice(0, 2), nextCursor: runIds.jordan },
    });
    const user = open();
    const table = await screen.findByRole('table', { name: 'Enrollment history' });
    expect(rowsOf(table)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(rowsOf(table)).toHaveLength(3);
    });
    expect(callsTo('listAutomationRuns').at(-1)).toEqual({
      params: { id: automationId },
      query: { after: runIds.jordan },
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const before = callsTo('listAutomationRuns').length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(callsTo('listAutomationRuns').length).toBeGreaterThan(before);
    });
  });

  it('says so when nobody has been through it yet', async () => {
    answers({ listAutomationRuns: () => ({ items: [], nextCursor: null }) });
    open();
    expect(
      await screen.findByRole('heading', { name: 'Nobody has been enrolled yet' }),
    ).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says when the history could not be loaded, never that it is empty, and tries again', async () => {
    let fail = true;
    answers({
      listAutomationRuns: () => {
        if (fail) throw new Error('offline');
        return runList;
      },
    });
    const user = open();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("We couldn't load the enrollment history.");
    expect(screen.queryByRole('heading', { name: 'Nobody has been enrolled yet' })).toBeNull();
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Enrollment history' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names a company, shows a record with no page of its own as text, and says what is in the trash', async () => {
    answers({
      listAutomationRuns: () => ({
        items: [
          runSummaryOf('maya', '', {
            record: { id: 'com_01k8e2wzr0e008000000000051', name: 'Harbor Lights', trashed: true },
          }),
          runSummaryOf('jordan', '', {
            record: { id: 'deal_01k8e2wzr0e008000000000052', name: '', trashed: false },
            status: 'running',
            currentStep: 'check_in',
          }),
        ],
        nextCursor: null,
      }),
    });
    open();
    const rows = rowsOf(await screen.findByRole('table', { name: 'Enrollment history' }));
    expect(
      within(shown(rows[0])).getByRole('link', { name: 'Harbor Lights' }).getAttribute('href'),
    ).toBe('/b/harbor/contacts/companies/com_01k8e2wzr0e008000000000051');
    expect(rows[0]?.textContent).toContain('(in the trash)');
    expect(within(shown(rows[1])).getByText('Unnamed')).toBeDefined();
    expect(within(shown(rows[1])).getAllByRole('link')).toHaveLength(1);
    expect(cellsOf(rows[1])[3]).toBe('Running');
  });
});

describe('one run', () => {
  it('shows each step in order: what it was given, the branch it took and why', async () => {
    answers();
    const user = open({ automation: automationId, view: 'runs', run: runIds.maya });
    expect(screen.getByRole('status').textContent).toBe('Loading the run…');
    expect(
      await screen.findByRole('heading', { level: 2, name: /Run for Maya Thompson/ }),
    ).toBeDefined();
    expect(screen.getByText('Went through to the end.')).toBeDefined();
    expect(document.body.textContent).toMatch(
      /New lead follow-up, version 2\. Started Oct 6, 2026, .+\. Ended Oct 8, 2026, /,
    );
    expect(callsTo('getAutomationRun')).toEqual([{ params: { runId: runIds.maya } }]);
    // The steps are named from the version the run began on, not from today's draft.
    await waitFor(() => {
      expect(callsTo('getAutomationVersion')).toEqual([
        { params: { id: automationId, version: 2 } },
      ]);
    });

    // The list's own items: a condition's values are a list of their own inside one.
    const steps = [...screen.getByRole('list', { name: 'Steps taken' }).children] as HTMLElement[];
    expect(steps.map((step) => step.getAttribute('aria-label'))).toEqual([
      'Step 1: Send the email “Pricing guide”',
      'Step 2: Wait 2 days',
      'Step 3: If services includes “video”',
      'Step 4: Text them “Here’s our video sample reel.”',
    ]);
    const [email, wait, condition] = steps as [HTMLElement, HTMLElement, HTMLElement];
    expect(email.textContent).toContain('Send email');
    expect(email.textContent).toContain('Done');
    expect(email.textContent).toContain('WhyThe email was queued to send.');
    expect(email.textContent).toContain('ResultIt queued a message to send.');
    // The wait is over: the run went on from it, so it reads as past.
    expect(wait.textContent).toContain('Wait 2 daysWaited');
    expect(wait.textContent).toMatch(/ResultIts wait ends Oct 8, 2026, /);
    // The condition: the values it compared, the branch it took, and the engine's reason.
    expect(condition.textContent).toContain('What it checkedservices was: video, photo');
    expect(condition.textContent).toContain('Branch takenIf yes');
    expect(condition.textContent).toContain(
      'WhyThe condition was true, so the yes branch was taken.',
    );
    // And everything it was given, exactly, for whoever wants the data.
    await user.click(within(condition).getByText('What it was given, as data'));
    expect(within(condition).getByText(/"contact\.custom\.services": \[/)).toBeDefined();
  });

  it('says why a run failed: in the summary, on the step, and with the engine’s own code', async () => {
    answers({ getAutomationRun: () => priyaRun });
    open({ automation: automationId, view: 'runs', run: runIds.priya });
    expect(
      await screen.findByRole('heading', { level: 2, name: /Run for Priya Nair/ }),
    ).toBeDefined();
    expect(
      screen.getByText("Failed: the contact hasn't agreed to marketing messages on this channel."),
    ).toBeDefined();
    const [step] = within(screen.getByRole('list', { name: 'Steps taken' })).getAllByRole(
      'listitem',
    );
    expect(step?.textContent).toContain('Failed');
    expect(step?.textContent).toContain('Messaging refused the email: consent_required.');
    expect(within(shown(step)).getByText('consent_required', { selector: 'code' })).toBeDefined();
  });

  it('runs a failed run again from the action that failed, and shows the run as it is then', async () => {
    answers({
      getAutomationRun: () => priyaRun,
      retryAutomationRun: () => ({ ...priyaRun, status: 'running', exitReason: null }),
    });
    const user = open({ automation: automationId, view: 'runs', run: runIds.priya });
    await user.click(await screen.findByRole('button', { name: 'Run again' }));
    expect(await screen.findByText('Running again from the action that failed.')).toBeDefined();
    expect(callsTo('retryAutomationRun')).toEqual([{ params: { runId: runIds.priya } }]);
    // It is no longer a failed run, so there is nothing to run again.
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
  });

  it('says in the server’s words why a run cannot be run again', async () => {
    const refusals: unknown[] = [
      new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'This run has been run again 5 times, the most a run may be.',
      }),
      new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }),
      new ApiError({ type: 'about:blank', title: 'Server Error', status: 500 }),
      new Error('offline'),
    ];
    answers({
      getAutomationRun: () => priyaRun,
      retryAutomationRun: () => {
        throw refusals.shift();
      },
    });
    const user = open({ automation: automationId, view: 'runs', run: runIds.priya });
    const again = await screen.findByRole('button', { name: 'Run again' });
    for (const words of [
      'This run has been run again 5 times, the most a run may be.',
      "You don't have permission to run workflows again.",
      "We couldn't run it again. Try again.",
      "We couldn't run it again. Check your connection and try again.",
    ]) {
      await user.click(again);
      expect((await screen.findByRole('alert')).textContent).toBe(words);
    }
    expect(screen.getByRole('button', { name: 'Run again' })).toBeDefined();
  });

  it('offers to run again only a run that failed', async () => {
    answers();
    open({ automation: automationId, view: 'runs', run: runIds.maya });
    await screen.findByRole('heading', { level: 2, name: /Run for Maya/ });
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
  });

  it('says a wait is still going on only while the run is waiting at it', async () => {
    answers({
      getAutomationRun: () => ({
        ...runSummaryOf('maya', 'Maya Thompson', {
          status: 'waiting',
          currentStep: 'check_services',
          finishedAt: null,
        }),
        steps: mayaRun.steps.slice(0, 2),
      }),
    });
    open({ automation: automationId, view: 'runs', run: runIds.maya });
    const steps = within(await screen.findByRole('list', { name: 'Steps taken' })).getAllByRole(
      'listitem',
    );
    expect(steps).toHaveLength(2);
    expect(steps[1]?.textContent).toContain('Wait 2 daysWaiting');
  });

  it('shows a run that has taken no step yet, and one whose steps this version cannot name', async () => {
    answers({
      getAutomationRun: () => ({
        ...runSummaryOf('jordan', 'Jordan Lee', {
          status: 'running',
          currentStep: 'send_guide',
          finishedAt: null,
        }),
        steps: [],
      }),
    });
    open({ automation: automationId, view: 'runs', run: runIds.jordan });
    expect(await screen.findByText('No step has run yet.')).toBeDefined();
    // The next step is named as the version names it.
    expect(
      await screen.findByText('Running: next is Send the email “Pricing guide”.'),
    ).toBeDefined();
    cleanup();

    answers({
      getAutomationRun: () => ({
        ...runSummaryOf('maya', 'Maya Thompson'),
        steps: [
          {
            step: 'old_step',
            type: null,
            status: 'skipped',
            input: {},
            output: {},
            branch: 'left',
            explanation: '',
            error: 'plain',
            attempt: 1,
            startedAt: '2026-10-06T18:38:00.000Z',
            finishedAt: null,
          },
        ],
      }),
      getAutomationVersion: () => {
        throw notFound();
      },
    });
    open({ automation: automationId, view: 'runs', run: runIds.maya });
    const [step] = within(await screen.findByRole('list', { name: 'Steps taken' })).getAllByRole(
      'listitem',
    );
    expect(step?.getAttribute('aria-label')).toBe('Step 1: old_step');
    expect(step?.textContent).toContain('Skipped');
    expect(step?.textContent).toContain('Branch takenBranch “left”');
    expect(step?.textContent).toContain('WhyNo reason was recorded.');
  });

  it('goes back to all the runs, and refreshes on request', async () => {
    answers();
    const user = open({ automation: automationId, view: 'runs', run: runIds.maya });
    await screen.findByRole('heading', { level: 2, name: /Run for Maya Thompson/ });
    const before = callsTo('getAutomationRun').length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(callsTo('getAutomationRun').length).toBeGreaterThan(before);
    });
    await user.click(screen.getByRole('link', { name: 'Back to the enrollment history' }));
    expect(await screen.findByRole('table', { name: 'Enrollment history' })).toBeDefined();
  });

  it('says when the run is not there, or could not be loaded', async () => {
    answers({
      getAutomationRun: () => {
        throw notFound();
      },
    });
    open({ automation: automationId, view: 'runs', run: runIds.maya });
    const missing = await screen.findByRole('alert');
    expect(missing.textContent).toContain(
      "This run doesn't exist, or it belongs to another business.",
    );
    expect(within(missing).queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the enrollment history' })).toBeDefined();
    cleanup();

    let fail = true;
    answers({
      getAutomationRun: () => {
        if (fail) throw new Error('offline');
        return mayaRun;
      },
    });
    const user = open({ automation: automationId, view: 'runs', run: runIds.maya });
    // It tries twice more by itself before it says so.
    const alert = await screen.findByRole('alert', {}, { timeout: 10_000 });
    expect(alert.textContent).toContain("We couldn't load this run.");
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: /Run for Maya Thompson/ }),
    ).toBeDefined();
  });
});

describe("a record's automations", () => {
  const panel = (): void => {
    render(wrap(<RecordAutomationRuns recordId={contactIds.maya} />));
  };

  it('lists each automation the record has been through, leading to the run itself', async () => {
    answers({
      listRecordAutomationRuns: () => ({
        items: [
          runSummaryOf('maya', 'Maya Thompson', {
            automationId: 'aut_01k8e2wzr0e008000000000099',
            automationName: 'Win back',
            status: 'failed',
            exitReason: 'no_email_address',
          }),
          runSummaryOf('maya', 'Maya Thompson', { id: runIds.jordan }),
        ],
        nextCursor: null,
      }),
    });
    panel();
    const region = screen.getByRole('region', { name: 'Workflows' });
    expect(within(region).getByText('Loading automations…')).toBeDefined();
    const rows = await within(region).findAllByRole('listitem');
    expect(rows.map((row) => within(row).getByRole('link').textContent)).toEqual([
      'Win back',
      'New lead follow-up',
    ]);
    expect(rows[0]?.textContent).toContain('Failed: the contact has no email address.');
    expect(rows[1]?.textContent).toContain('Went through to the end.');
    expect(within(shown(rows[0])).getByRole('link').getAttribute('href')).toBe(
      `/b/harbor/automations?automation=aut_01k8e2wzr0e008000000000099&view=runs&run=${runIds.maya}`,
    );
    expect(callsTo('listRecordAutomationRuns')).toEqual([
      { params: { id: contactIds.maya }, query: {} },
    ]);
  });

  it('says so when no automation has run for the record, and loads more when there are more', async () => {
    answers({ listRecordAutomationRuns: () => ({ items: [], nextCursor: null }) });
    panel();
    expect(await screen.findByText('No automation has run for this contact.')).toBeDefined();
    cleanup();

    answers({
      listRecordAutomationRuns: (input) =>
        (input as { query: { after?: string } }).query.after === undefined
          ? { items: [runSummaryOf('maya', 'Maya Thompson')], nextCursor: runIds.maya }
          : {
              items: [runSummaryOf('maya', 'Maya Thompson', { id: runIds.priya })],
              nextCursor: null,
            },
    });
    panel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });
    expect(callsTo('listRecordAutomationRuns').at(-1)).toEqual({
      params: { id: contactIds.maya },
      query: { after: runIds.maya },
    });
  });

  it('says when they could not be loaded, and tries again', async () => {
    let fail = true;
    answers({
      listRecordAutomationRuns: () => {
        if (fail) throw new Error('offline');
        return { items: [], nextCursor: null };
      },
    });
    panel();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("The automations couldn't be loaded.");
    fail = false;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No automation has run for this contact.')).toBeDefined();
  });
});
