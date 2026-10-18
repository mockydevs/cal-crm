// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationId, contactIds, followUp, harborSetup } from '../e2e/automation-fixtures';
import TestDialog from './automation-test-dialog';

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

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const testRunId = 'atest_01k8e2wzr0e008000000000071';
const at = '2026-10-09T09:00:00.000Z';
const trace = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: testRunId,
  draftVersion: 3,
  status: 'passed',
  contactId: null,
  createdAt: at,
  steps: [
    {
      step: 'send_guide',
      type: 'email.send',
      kind: 'would_send',
      at,
      explanation: 'Would send the email “Pricing guide”.',
    },
    { step: 'wait_2_days', type: 'wait', kind: 'waited', at, explanation: '' },
    {
      step: 'asked_about_video',
      type: 'condition',
      kind: 'branched',
      at: '2026-10-11T09:00:00.000Z',
      branch: 'no',
      explanation: 'The condition was false, so the no branch was taken.',
    },
    {
      step: 'tag_them',
      type: 'tag.add',
      kind: 'would_change',
      at,
      explanation: 'Would add a tag.',
    },
    { step: 'last_check_in', type: 'sms.send', kind: 'ended', at, explanation: 'The path ends.' },
  ],
  outcome: { kind: 'completed' },
  ...over,
});

function open(unsaved = false): { user: ReturnType<typeof userEvent.setup>; closed: boolean[] } {
  const closed: boolean[] = [];
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <TestDialog
          open
          onOpenChange={(next) => {
            closed.push(next);
          }}
          automationId={automationId}
          saved={followUp}
          setup={harborSetup}
          unsaved={unsaved}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup({ delay: null }), closed };
}

const created = (): unknown[] =>
  server.calls
    .filter((call) => call.operation === 'createAutomationTestRun')
    .map((call) => call.input);

describe('Test workflow', () => {
  it('sends sample values for the fields the workflow reads, and events that happen in its waits', async () => {
    server.answer = () => trace();
    const { user } = open();
    const dialog = screen.getByRole('dialog', { name: 'Test workflow' });
    const values = within(dialog).getByRole('region', { name: 'Sample values' });
    await user.click(within(values).getByRole('button', { name: 'Add a sample value' }));
    // The fields offered are the ones the draft reads: its condition's, then its merge field.
    expect(
      within(values).getByRole('combobox', { name: 'Field of sample value 1' }).textContent,
    ).toBe('contact.services');
    await user.type(within(values).getByLabelText('Value of sample value 1'), 'video, photo');
    await user.click(within(values).getByRole('button', { name: 'Add a sample value' }));
    expect(
      within(values).getByRole('combobox', { name: 'Field of sample value 2' }).textContent,
    ).toBe('contact.firstName');
    await user.type(within(values).getByLabelText('Value of sample value 2'), 'Sam');
    // One left empty is not sent, and one taken away is gone.
    await user.click(within(values).getByRole('button', { name: 'Add a sample value' }));
    await user.click(within(values).getByRole('button', { name: 'Add a sample value' }));
    await user.click(within(values).getByRole('button', { name: 'Remove sample value 4' }));

    const events = within(dialog).getByRole('region', { name: 'Simulated events' });
    await user.click(within(events).getByRole('button', { name: 'Add an event' }));
    expect(within(events).getByRole('combobox', { name: 'Event 1' }).textContent).toBe(
      'A message arrives, from them or from the team',
    );
    await user.click(within(events).getByRole('button', { name: 'Add an event' }));
    await user.click(within(events).getByRole('combobox', { name: 'Event 2' }));
    await user.click(await screen.findByRole('option', { name: 'They book an appointment' }));
    const after = within(events).getByLabelText('How long after the start, for event 2');
    await user.clear(after);
    await user.type(after, '36');
    await user.click(within(events).getByRole('combobox', { name: 'Unit for event 2' }));
    await user.click(await screen.findByRole('option', { name: 'Hours' }));
    // An event with no time is not sent; nor is one taken away.
    await user.click(within(events).getByRole('button', { name: 'Add an event' }));
    await user.clear(within(events).getByLabelText('How long after the start, for event 3'));
    await user.click(within(events).getByRole('button', { name: 'Add an event' }));
    await user.click(within(events).getByRole('button', { name: 'Remove event 4' }));

    await user.click(within(dialog).getByRole('button', { name: 'Run test' }));
    await within(dialog).findByRole('region', { name: 'Test result' });
    expect(created()).toEqual([
      {
        params: { id: automationId },
        body: {
          values: { 'contact.services': ['video', 'photo'], 'contact.firstName': 'Sam' },
          events: [
            { event: 'message.received', after: 'P1D' },
            { event: 'appointment.booked', after: 'PT36H' },
          ],
        },
      },
    ]);
  });

  it('shows explicitly simulated references returned by the test-run API', async () => {
    server.answer = () =>
      trace({
        steps: [
          {
            step: 'note',
            type: 'note.create',
            kind: 'would_change',
            at,
            explanation: 'Would create a note.',
            simulated: true,
            output: { noteId: 'simulated:note:note:1' },
          },
        ],
      });
    const { user } = open();
    const dialog = screen.getByRole('dialog', { name: 'Test workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Run test' }));
    const result = await within(dialog).findByRole('region', { name: 'Test result' });
    expect(within(result).getByText('Simulated output')).toBeDefined();
    expect(within(result).getByText('This reference only exists in this test.')).toBeDefined();
    expect(within(result).getByText('simulated:note:note:1').closest('a')).toBeNull();
  });

  it('shows the email a Send email step would send, and the merge fields that stop a send', async () => {
    server.answer = () =>
      trace({
        status: 'failed',
        steps: [
          {
            step: 'send_guide',
            type: 'email.send',
            kind: 'ended',
            at,
            explanation: 'The contact has no value for contact.service.',
            email: {
              subject: 'For Ada',
              firstLine: 'Are you still in need of a DJ team?',
              missingValues: ['contact.service'],
            },
          },
        ],
        outcome: { kind: 'failed', step: 'send_guide', error: 'missing_values' },
      });
    const { user } = open();
    const dialog = screen.getByRole('dialog', { name: 'Test workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Run test' }));
    const result = await within(dialog).findByRole('region', { name: 'Test result' });
    const email = within(result).getByRole('group', { name: 'Email preview' });
    expect(within(email).getByText('For Ada')).toBeDefined();
    expect(within(email).getByText('Are you still in need of a DJ team?')).toBeDefined();
    expect(email.textContent).toContain(
      'Missing values: contact.service. A real send would stop here, and nothing would be sent.',
    );
  });

  it('marks a jump (a Go To, a goal met) as one, and says a loop that never ended in words', async () => {
    server.answer = () =>
      trace({
        steps: [
          {
            step: 'wait_2_days',
            type: 'goto',
            kind: 'moved',
            at,
            explanation: 'Went to "send_guide".',
          },
        ],
        outcome: { kind: 'failed', step: 'wait_2_days', error: 'step_visit_limit' },
      });
    const { user } = open();
    const dialog = screen.getByRole('dialog', { name: 'Test workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Run test' }));
    const result = await within(dialog).findByRole('region', { name: 'Test result' });
    expect(within(result).getAllByRole('listitem')[0]?.textContent).toMatch(
      /^Jumped.*Went to "send_guide".$/,
    );
    expect(within(result).getByRole('status').textContent).toBe(
      'The test failed at “Wait 2 days”: one action ran 100 times in this run, the most allowed: a path keeps leading back to it',
    );
  });

  it('runs the saved draft and shows what each action would do, in the order it would', async () => {
    server.answer = () => trace();
    const { user } = open();
    const dialog = screen.getByRole('dialog', { name: 'Test workflow' });
    expect(dialog.textContent).toContain('Nothing is sent and nothing is changed.');
    await user.click(within(dialog).getByRole('button', { name: 'Run test' }));
    const result = await within(dialog).findByRole('region', { name: 'Test result' });
    expect(within(result).getByRole('status').textContent).toBe(
      'The test reached the end of the workflow.',
    );
    const steps = within(result).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringMatching(
        /^Would sendSend the email “Pricing guide”.*2026.*Would send the email “Pricing guide”\.$/,
      ),
      expect.stringMatching(/^WaitedWait 2 days.*2026/),
      expect.stringMatching(
        /^BranchedIf services includes “video”.*Branch taken: If no.*The condition was false, so the no branch was taken\.$/,
      ),
      // A step the saved draft does not have is named by its key.
      expect.stringMatching(/^Would changetag_them.*Would add a tag\.$/),
      expect.stringMatching(/^EndedSend text.*The path ends\.$/),
    ]);
    expect(created()).toEqual([{ params: { id: automationId }, body: {} }]);
    expect(within(dialog).getByRole('button', { name: 'Run test again' })).toBeDefined();
  });

  it("reads a contact's own values when one is chosen", async () => {
    server.answer = (operation) =>
      operation === 'listContacts'
        ? {
            items: [{ id: contactIds.maya, name: 'Maya Thompson', email: null, phone: null }],
            next: null,
            canManage: true,
          }
        : trace({ contactId: contactIds.maya });
    const { user } = open();
    await user.type(screen.getByRole('searchbox', { name: 'Search contacts' }), 'maya');
    await user.click(await screen.findByRole('button', { name: 'Maya Thompson' }));
    await user.click(screen.getByRole('button', { name: 'Run test' }));
    await screen.findByRole('region', { name: 'Test result' });
    expect(created()).toEqual([
      { params: { id: automationId }, body: { contactId: contactIds.maya } },
    ]);
  });

  it('says how a test ended when it did not reach the end', async () => {
    const outcomes: readonly (readonly [Record<string, unknown>, string])[] = [
      [
        { kind: 'stopped', event: 'message.received', at },
        'The workflow stopped early, because this happened: A message arrives, from them or from the team.',
      ],
      [
        { kind: 'stopped', event: 'something.else', at },
        'The workflow stopped early, because this happened: something.else.',
      ],
      [
        { kind: 'failed', step: 'send_guide', error: 'This step is not available yet.' },
        'The test failed at “Send the email “Pricing guide””: This step is not available yet.',
      ],
      [
        { kind: 'limit', steps: 200 },
        'The test stopped after 200 actions, the most one test takes.',
      ],
    ];
    for (const [outcome, words] of outcomes) {
      server.answer = () => trace({ status: 'failed', outcome, steps: [] });
      const { user } = open();
      await user.click(screen.getByRole('button', { name: 'Run test' }));
      await waitFor(() => {
        expect(screen.getByRole('status').textContent).toBe(words);
      });
      expect(screen.queryByRole('list', { name: 'What each action would do' })).toBeNull();
      cleanup();
    }
  });

  it('reads a test that is still running again, on request', async () => {
    server.answer = (operation) =>
      operation === 'getAutomationTestRun'
        ? trace()
        : trace({ status: 'running', outcome: null, steps: [] });
    const { user } = open();
    await user.click(screen.getByRole('button', { name: 'Run test' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('The test is still running.');
    });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'The test reached the end of the workflow.',
      );
    });
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(server.calls.at(-1)).toEqual({
      operation: 'getAutomationTestRun',
      input: { params: { id: automationId, runId: testRunId } },
    });
  });

  it('asks for the draft to be saved first when it has changes the test would not see', () => {
    open(true);
    expect(screen.getByRole('alert').textContent).toBe(
      "You have changes that aren't saved. Save first: the test runs the saved draft.",
    );
    expect(screen.getByRole('button', { name: 'Run test' })).toHaveProperty('disabled', true);
  });

  it('says why a test could not be run, and closes on request', async () => {
    const refusals: readonly (readonly [() => unknown, string])[] = [
      [
        () => new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }),
        "You don't have permission to test workflows.",
      ],
      [
        () =>
          new ApiError({
            type: 'about:blank',
            title: 'Unprocessable Content',
            status: 422,
            errors: [{ path: '/start', code: 'missing_start', message: 'Say where it starts.' }],
          }),
        'Say where it starts.',
      ],
      [
        () =>
          new ApiError({
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: 'It was deleted.',
          }),
        'It was deleted.',
      ],
      [
        () => new ApiError({ type: 'about:blank', title: 'Server Error', status: 500 }),
        "We couldn't run the test. Try again.",
      ],
      [
        () => new TypeError('Failed to fetch'),
        "We couldn't run the test. Check your connection and try again.",
      ],
    ];
    for (const [failure, words] of refusals) {
      server.answer = () => {
        throw failure();
      };
      const { user, closed } = open();
      await user.click(screen.getByRole('button', { name: 'Run test' }));
      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toBe(words);
      });
      const close = screen.getAllByRole('button', { name: 'Close' }).at(-1);
      if (close === undefined) throw new Error('The dialog has no way to close it.');
      await user.click(close);
      expect(closed).toEqual([false]);
      cleanup();
    }
  });
});
