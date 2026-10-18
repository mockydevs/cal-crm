// @vitest-environment jsdom
// What a person does about a run from its history: "Continue now" for a run that waits,
// and "Why didn't this run?" for one contact, on the workflow's Enrollment history and on
// the contact's own page.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  automationContactExplanation,
  automationTriggerEvaluationReasons,
  continueAutomationRunInput,
} from '@repo/contracts';
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
  runIds,
  runList,
  runSummaryOf,
  versionTwo,
} from '../e2e/automation-fixtures';
import {
  comparedOf,
  comparedWords,
  explainedReasons,
  explainedStates,
  reasonHeading,
  stateHeading,
} from './automation-explain-words';
import type { AutomationsSearch } from './automation-navigation';
import { RecordAutomationRuns } from './automation-record-runs';
import RunHistory from './automation-runs';
// Read before any test starts, so a test waits on React alone (see the builder's tests).
import './automation-explain';
import './automation-record-explain';
import './automation-run-continue';

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
vi.mock('./automation-contact-search', () => ({
  searchContacts: () =>
    Promise.resolve({
      items: [{ id: 'con_01k8e2wzr0e008000000000031', name: 'Maya Thompson', email: null }],
    }),
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

/** A run that waits for a reply, which a person may end early down either branch. */
const waitingForReply = {
  ...mayaRun,
  status: 'waiting',
  currentStep: 'wait_2_days',
  currentAction: { step: 'wait_2_days', type: 'wait.event', label: null },
  wakeAt: '2026-10-10T09:00:00.000Z',
  finishedAt: null,
  revision: 'rev-7',
  continuable: { branches: ['received', 'timed_out'] },
};
/** A run in a plain wait: it wakes at once, with no branch to choose. */
const waitingTwoDays = {
  ...waitingForReply,
  currentAction: { step: 'wait_2_days', type: 'wait', label: null },
  continuable: { branches: [] },
};
const continued = {
  ...mayaRun,
  status: 'running',
  revision: 'rev-8',
  continuable: null,
};

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
  return userEvent.setup({ delay: null });
};
const refusal = (status: number, more: Record<string, unknown>): ApiError =>
  new ApiError({ type: 'about:blank', title: 'Refused', status, ...more });

describe('Continue now, on a run', () => {
  it('is offered only for a run that waits where a person may end the wait', async () => {
    answers();
    open({ automation: automationId, view: 'runs', run: runIds.maya });
    await screen.findByRole('heading', { name: /^Run for/ });
    expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull();
  });

  it('wakes a plain wait at once, sending the revision the run was read at', async () => {
    answers({
      getAutomationRun: () => waitingTwoDays,
      continueAutomationRun: () => continued,
    });
    const user = open({ automation: automationId, view: 'runs', run: runIds.maya });
    await user.click(await screen.findByRole('button', { name: 'Continue now' }));
    await waitFor(() => {
      expect(screen.getByText('Continued: the run went on from its wait.')).toBeDefined();
    });
    const [sent] = callsTo('continueAutomationRun') as { params: unknown; body: unknown }[];
    expect(sent).toEqual({ params: { runId: runIds.maya }, body: { revision: 'rev-7' } });
    expect(continueAutomationRunInput.safeParse(sent?.body).success).toBe(true);
    // The run is shown as the server answered it: no longer waiting, nothing to continue.
    expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull();
    expect(screen.getByText('Running')).toBeDefined();
  });

  it('asks which way to go where the wait ends down one of several branches, in the builder’s words', async () => {
    answers({
      getAutomationRun: () => waitingForReply,
      continueAutomationRun: () => continued,
    });
    const user = open({ automation: automationId, view: 'runs', run: runIds.maya });
    await user.click(await screen.findByRole('button', { name: 'Continue now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Continue now: which way?' });
    const choices = within(dialog).getAllByRole('radio');
    expect(choices.map((each) => each.closest('label')?.textContent)).toEqual([
      'If it happens in time',
      'If time runs out',
    ]);
    // Nothing is sent until a way is chosen.
    expect(within(dialog).getByRole('button', { name: 'Continue now' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.submit(shown(dialog.querySelector('form')));
    expect(callsTo('continueAutomationRun')).toEqual([]);
    await user.click(within(dialog).getByRole('radio', { name: 'If time runs out' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue now' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(callsTo('continueAutomationRun')).toEqual([
      { params: { runId: runIds.maya }, body: { branch: 'timed_out', revision: 'rev-7' } },
    ]);
    expect(screen.getByText('Continued: the run went on from its wait.')).toBeDefined();
  });

  it('shows the server’s own sentence when it refuses, in the question and under the button, and reads the run again', async () => {
    let reads = 0;
    answers({
      getAutomationRun: () => {
        reads += 1;
        return waitingForReply;
      },
      continueAutomationRun: () => {
        throw refusal(422, {
          errors: [
            {
              path: '/branch',
              code: 'unknown_branch',
              message: 'timed_out is not one of this wait’s branches.',
            },
          ],
        });
      },
    });
    const user = open({ automation: automationId, view: 'runs', run: runIds.maya });
    await user.click(await screen.findByRole('button', { name: 'Continue now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Continue now: which way?' });
    await user.click(within(dialog).getByRole('radio', { name: 'If it happens in time' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue now' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'timed_out is not one of this wait’s branches.',
    );
    await waitFor(() => {
      expect(reads).toBeGreaterThan(1);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'timed_out is not one of this wait’s branches.',
    );
  });

  it.each([
    [
      refusal(409, { detail: 'The run has moved since you read it.' }),
      'The run has moved since you read it.',
    ],
    [refusal(403, {}), "You don't have permission to continue runs."],
    [refusal(500, {}), "We couldn't continue the run. Try again."],
    [new Error('offline'), "We couldn't continue the run. Check your connection and try again."],
  ])('says why a run could not be continued %#', async (error, said) => {
    answers({
      getAutomationRun: () => ({ ...waitingTwoDays, revision: undefined }),
      continueAutomationRun: () => {
        throw error;
      },
    });
    const user = open({ automation: automationId, view: 'runs', run: runIds.maya });
    await user.click(await screen.findByRole('button', { name: 'Continue now' }));
    expect((await screen.findByRole('alert')).textContent).toBe(said);
    // With no revision read, none is sent.
    expect(callsTo('continueAutomationRun')).toEqual([
      { params: { runId: runIds.maya }, body: {} },
    ]);
  });

  it('is in the enrollment history too, on each run that waits', async () => {
    answers({
      listAutomationRuns: () => ({
        items: [
          runSummaryOf('jordan', 'Jordan Lee', {
            status: 'waiting',
            currentStep: 'wait_2_days',
            currentAction: { step: 'wait_2_days', type: 'wait', label: null },
            revision: 'rev-3',
            continuable: { branches: [] },
          }),
          runSummaryOf('maya', 'Maya Thompson'),
        ],
        nextCursor: null,
      }),
      continueAutomationRun: () => continued,
    });
    const user = open();
    const table = await screen.findByRole('table', { name: 'Enrollment history' });
    const buttons = within(table).getAllByRole('button', { name: 'Continue now' });
    expect(buttons).toHaveLength(1);
    await user.click(shown(buttons[0]));
    await waitFor(() => {
      expect(callsTo('continueAutomationRun')).toEqual([
        { params: { runId: runIds.jordan }, body: { revision: 'rev-3' } },
      ]);
    });
    // The list is read again, so the row shows where the run is now.
    await waitFor(() => {
      expect(callsTo('listAutomationRuns').length).toBeGreaterThan(1);
    });
  });
});

const evaluation = (reason: string, over: Record<string, unknown> = {}) => ({
  id: `0198c1f0-0000-7000-8000-00000000000${String(automationTriggerEvaluationReasons.indexOf(reason as 'paused'))}`,
  evaluatedAt: '2026-10-11T08:30:00.000Z',
  eventId: '0198c1f0-0000-7000-8000-0000000000aa',
  eventType: 'tag.assigned',
  trigger: { id: 'tagged', type: 'tag.added' },
  recordId: contactIds.maya,
  reason,
  detail: {},
  explanation: `The server says: ${reason}.`,
  ...over,
});
const explanation = (over: Record<string, unknown> = {}) => ({
  automationId,
  automationName: 'New lead follow-up',
  automationStatus: 'active',
  recordId: contactIds.maya,
  state: 'not_started',
  runs: 0,
  run: null,
  ended: null,
  evaluations: [],
  evaluationsKeptDays: 30,
  summary: 'This workflow has not started for this contact.',
  ...over,
});

describe('the words of "Why didn\'t this run?"', () => {
  it('heads every state and every reason the contract names', () => {
    expect([...explainedReasons].toSorted()).toEqual(
      [...automationTriggerEvaluationReasons].toSorted(),
    );
    expect([...explainedStates].toSorted()).toEqual(
      [...automationContactExplanation.shape.state.options].toSorted(),
    );
    for (const reason of automationTriggerEvaluationReasons)
      expect(reasonHeading(reason)).not.toBe(reason);
    expect(reasonHeading('filter_mismatch')).toBe('A trigger filter did not match');
    expect(stateHeading('has_run')).toBe('It ran for this contact');
    expect(stateHeading('not_started')).toBe('It did not start for this contact');
    expect(stateHeading('nothing_on_record')).toBe('Nothing is on record');
    // What a later server may add is shown by its own name, never hidden.
    expect(reasonHeading('quota_reached')).toBe('quota reached');
    expect(stateHeading('queued')).toBe('queued');
  });

  it('says what was compared, in plain values', () => {
    expect(comparedOf({})).toEqual([]);
    expect(comparedOf({ filter: 'tag', expected: 'tag_vip', actual: 'tag_cold' })).toEqual([
      { label: 'Expected', value: 'tag_vip' },
      { label: 'Actual', value: 'tag_cold' },
    ]);
    expect(comparedOf({ values: { 'contact.custom.budget': 500, 'contact.email': null } })).toEqual(
      [
        { label: 'contact.custom.budget', value: '500' },
        { label: 'contact.email', value: 'nothing' },
      ],
    );
    expect(comparedOf({ rule: 'imported_contact', values: ['not', 'a', 'record'] })).toEqual([
      { label: 'Rule', value: 'imported contact' },
    ]);
    expect([undefined, '', true, false, 7, ['a', 2], [], { a: 1 }].map(comparedWords)).toEqual([
      'nothing',
      'nothing',
      'yes',
      'no',
      '7',
      'a, 2',
      'nothing',
      '{"a":1}',
    ]);
  });
});

describe('Check a contact, on the enrollment history', () => {
  const check = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
    await screen.findByRole('table', { name: 'Enrollment history' });
    const toggle = screen.getByRole('button', { name: 'Check a contact' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    const panel = screen.getByRole('region', { name: 'Check a contact' });
    await user.type(within(panel).getByRole('searchbox', { name: 'Contact to check' }), 'maya');
    await user.click(await within(panel).findByRole('button', { name: /Maya Thompson/ }));
    return panel;
  };

  it('says why the workflow did not start: the server’s sentence, then each time, with what was compared', async () => {
    answers({
      explainAutomationContact: () =>
        explanation({
          summary: 'This workflow has not started for Maya Thompson: its tag filter did not match.',
          evaluations: [
            evaluation('filter_mismatch', {
              detail: { filter: 'tag', expected: 'VIP', actual: 'Cold' },
              explanation: "The trigger's tag filter wanted VIP, and the event had Cold.",
            }),
            evaluation('condition_false', {
              detail: { values: { 'contact.custom.budget': 500 } },
              explanation: "The trigger's condition did not hold.",
            }),
          ],
        }),
    });
    const user = open();
    const panel = await check(user);
    const answer = await within(panel).findByRole('region', {
      name: 'It did not start for this contact',
    });
    expect(
      within(answer).getByText(
        'This workflow has not started for Maya Thompson: its tag filter did not match.',
      ),
    ).toBeDefined();
    const times = within(
      within(answer).getByRole('list', { name: 'The latest times it did not start' }),
    ).getAllByRole('listitem');
    expect(times).toHaveLength(2);
    const first = within(shown(times[0]));
    expect(first.getByText('A trigger filter did not match')).toBeDefined();
    expect(
      first.getByText("The trigger's tag filter wanted VIP, and the event had Cold."),
    ).toBeDefined();
    expect(first.getAllByRole('term').map((term) => term.textContent)).toEqual([
      'Expected',
      'Actual',
    ]);
    expect(first.getAllByRole('definition').map((each) => each.textContent)).toEqual([
      'VIP',
      'Cold',
    ]);
    expect(within(shown(times[1])).getByText('contact.custom.budget')).toBeDefined();
    expect(
      within(answer).getByText('Each time a workflow does not start is kept for 30 days.'),
    ).toBeDefined();
    expect(callsTo('explainAutomationContact')).toEqual([
      { params: { id: automationId }, query: { contactId: contactIds.maya } },
    ]);
    // Another contact can be checked, and the panel closes again.
    await user.click(within(panel).getByRole('button', { name: 'Check another contact' }));
    expect(within(panel).queryByRole('region')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check a contact' }));
    expect(screen.queryByRole('region', { name: 'Check a contact' })).toBeNull();
  });

  it('shows the run when there is one: its status, where it is, how it ended, and the way to it', async () => {
    answers({
      explainAutomationContact: () =>
        explanation({
          state: 'has_run',
          runs: 2,
          run: runSummaryOf('maya', 'Maya Thompson', {
            status: 'failed',
            currentAction: { step: 'send_guide', type: 'email.send', label: null },
            startedAt: '2026-10-08T07:00:00.000Z',
          }),
          ended: 'It failed: the contact has not agreed to marketing email.',
          summary: 'This workflow ran for Maya Thompson and failed.',
        }),
    });
    const user = open();
    const panel = await check(user);
    const answer = await within(panel).findByRole('region', { name: 'It ran for this contact' });
    expect(within(answer).getByText('Failed')).toBeDefined();
    expect(within(answer).getByText('Send email')).toBeDefined();
    expect(
      within(answer).getByText('It failed: the contact has not agreed to marketing email.'),
    ).toBeDefined();
    const link = within(answer).getByRole('link', { name: /^Open the run started/ });
    expect(link.getAttribute('href')).toBe(`?view=runs&run=${runIds.maya}`);
    expect(within(answer).queryByRole('list')).toBeNull();
    await user.click(link);
    expect(await screen.findByRole('heading', { name: /^Run for/ })).toBeDefined();
  });

  it('names where a run is by its own label, or by its key when this version lacks the type', async () => {
    const at = (currentAction: unknown) =>
      explanation({
        state: 'has_run',
        runs: 1,
        run: runSummaryOf('maya', 'Maya Thompson', { status: 'waiting', currentAction }),
        summary: 'It is waiting.',
      });
    answers({
      explainAutomationContact: () =>
        at({ step: 'nudge', type: 'sms.send', label: 'Second nudge' }),
    });
    const user = open();
    const panel = await check(user);
    expect(await within(panel).findByText('Second nudge')).toBeDefined();
    cleanup();
    answers({ explainAutomationContact: () => at({ step: 'nudge', type: null, label: null }) });
    const again = open();
    expect(await within(await check(again)).findByText('nudge')).toBeDefined();
    cleanup();
    answers({ explainAutomationContact: () => at(null) });
    const last = open();
    const bare = await check(last);
    await within(bare).findByText('It is waiting.');
    expect(within(bare).queryByText('Where it is')).toBeNull();
  });

  it('says that nothing is on record, and for how long evaluations are kept', async () => {
    answers({
      explainAutomationContact: () =>
        explanation({
          state: 'nothing_on_record',
          summary: 'Nothing is on record for this contact and this workflow.',
        }),
    });
    const user = open();
    const panel = await check(user);
    const answer = await within(panel).findByRole('region', { name: 'Nothing is on record' });
    expect(
      within(answer).getByText(
        'No event this workflow listens for is on record for this contact. Each time a workflow does not start is kept for 30 days.',
      ),
    ).toBeDefined();
  });

  it('says when the answer could not be read, or may not be, and tries again', async () => {
    let failing: Error = refusal(403, {});
    answers({
      explainAutomationContact: () => {
        throw failing;
      },
    });
    const user = open();
    const panel = await check(user);
    expect((await within(panel).findByRole('alert')).textContent).toContain(
      "You don't have permission to read this workflow's runs.",
    );
    failing = refusal(500, {});
    await user.click(within(panel).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(within(panel).getByRole('alert').textContent).toContain(
        "We couldn't read what is on record for this contact.",
      );
    });
  });
});

describe('"Why didn\'t a workflow run?", on a contact\'s page', () => {
  const page = (): ReturnType<typeof userEvent.setup> => {
    render(wrap(<RecordAutomationRuns recordId={contactIds.maya} />));
    return userEvent.setup({ delay: null });
  };
  const workflows = {
    items: [
      { id: automationId, name: 'New lead follow-up' },
      { id: 'aut_other', name: 'Win back' },
    ],
    nextCursor: null,
  };

  it('asks which workflow, then says what it did for this contact, with a link to the run', async () => {
    answers({
      listRecordAutomationRuns: () => ({ items: [], nextCursor: null }),
      listAutomations: () => workflows,
      explainAutomationContact: (input) =>
        (input as { params: { id: string } }).params.id === automationId
          ? explanation({
              state: 'has_run',
              runs: 1,
              run: runSummaryOf('maya', 'Maya Thompson'),
              ended: 'It went through to the end.',
              summary: 'This workflow ran for Maya Thompson.',
            })
          : explanation({
              evaluations: [evaluation('paused', { explanation: 'The workflow was paused then.' })],
            }),
    });
    const user = page();
    const ask = await screen.findByRole('button', { name: "Why didn't a workflow run?" });
    expect(ask.getAttribute('aria-expanded')).toBe('false');
    await user.click(ask);
    const choice = await screen.findByRole('combobox', { name: 'Workflow' });
    expect(
      within(choice)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a workflow', 'New lead follow-up', 'Win back']);
    fireEvent.change(choice, { target: { value: automationId } });
    const ran = await screen.findByRole('region', { name: 'It ran for this contact' });
    expect(
      within(ran)
        .getByRole('link', { name: /^Open the run started/ })
        .getAttribute('href'),
    ).toBe(`/b/harbor/automations?automation=${automationId}&view=runs&run=${runIds.maya}`);
    fireEvent.change(choice, { target: { value: 'aut_other' } });
    const not = await screen.findByRole('region', { name: 'It did not start for this contact' });
    expect(within(not).getByText('The workflow was paused')).toBeDefined();
    expect(within(not).getByText('The workflow was paused then.')).toBeDefined();
    expect(callsTo('explainAutomationContact')).toEqual([
      { params: { id: automationId }, query: { contactId: contactIds.maya } },
      { params: { id: 'aut_other' }, query: { contactId: contactIds.maya } },
    ]);
    await user.click(ask);
    expect(screen.queryByRole('combobox', { name: 'Workflow' })).toBeNull();
  });

  it('says so when the business has no workflows, or they could not be loaded', async () => {
    let fail = true;
    answers({
      listRecordAutomationRuns: () => ({ items: [], nextCursor: null }),
      listAutomations: () => {
        if (fail) throw new Error('offline');
        return { items: [], nextCursor: null };
      },
    });
    const user = page();
    await user.click(await screen.findByRole('button', { name: "Why didn't a workflow run?" }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      "The workflows couldn't be loaded.",
    );
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('This business has no workflows yet.')).toBeDefined();
  });
});

function shown(element: Element | null | undefined): HTMLElement {
  if (!(element instanceof HTMLElement)) throw new Error('Nothing is shown there.');
  return element;
}
