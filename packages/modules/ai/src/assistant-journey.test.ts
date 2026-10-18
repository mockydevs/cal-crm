import type { ApiRoute, Invocation, Services } from '@repo/commands';
import {
  getContact,
  getContactJourney,
  listRecordActivity,
  listRecordAutomationRuns,
  listAutomationStepRuns,
  type AutomationRunList,
  type AutomationStepRunList,
} from '@repo/contracts';
import { ForbiddenError, NotFoundError, toPublicId } from '@repo/kernel';
import { expect, it } from 'vitest';
import { createContactJourneyRoute } from './assistant-journey.js';

const contactId = toPublicId('contact', '01890a5d-ac96-774b-bcce-b302099a8057');
const invocation: Invocation = {
  context: {
    agencyId: '01890a5d-ac96-774b-bcce-b302099a8050',
    businessId: '01890a5d-ac96-774b-bcce-b302099a8051',
    actorKind: 'user',
    correlationId: '01890a5d-ac96-774b-bcce-b302099a8053',
  },
  permissions: new Set(),
};
const services = {} as Services;

it('assembles chronological evidence through the native API as the same reader and discloses pagination', async () => {
  const calls: string[] = [];
  const event = (day: string) => ({
    id: toPublicId('event', `01890a5d-ac96-774b-bcce-b302099a80${day}`),
    type: 'contact.updated',
    occurredAt: `2026-10-${day}T12:00:00Z`,
    subject: { kind: 'contact', id: contactId },
    actor: { kind: 'user', name: 'Dana', you: true },
    payload: {},
    causedBy: null,
  });
  const routes: ApiRoute[] = [getContact, listRecordActivity, listRecordAutomationRuns].map(
    (endpoint) => ({
      endpoint,
      run: (request) => {
        expect(request.invocation).toBe(invocation);
        calls.push(endpoint.operationId);
        return Promise.resolve(
          endpoint === getContact
            ? {}
            : endpoint === listRecordActivity
              ? { items: [event('12'), event('11')], next: event('11').id }
              : { items: [], nextCursor: null },
        );
      },
    }),
  );
  const result = getContactJourney.response.schema.parse(
    await createContactJourneyRoute(routes).run(
      { invocation, params: { id: contactId }, query: {}, body: undefined },
      services,
    ),
  );
  expect(result.items.map((row) => row.at)).toEqual([
    '2026-10-11T12:00:00Z',
    '2026-10-12T12:00:00Z',
  ]);
  expect(result.coverage.activityAfter).not.toBeNull();
  expect(result.coverage.notes.join(' ')).toContain('does not establish');
  expect(calls).toEqual(['getContact', 'listRecordActivity', 'listRecordAutomationRuns']);
});

it('does not read any evidence for a missing or foreign contact', async () => {
  const routes: ApiRoute[] = [
    { endpoint: getContact, run: () => Promise.reject(new NotFoundError('contact', contactId)) },
  ];
  await expect(
    createContactJourneyRoute(routes).run(
      { invocation, params: { id: contactId }, query: {}, body: undefined },
      services,
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('includes real workflow outcomes, bounds the workflows inspected and passes record/time filters', async () => {
  const time = '2026-10-12T12:00:00Z';
  const runs: AutomationRunList = {
    items: Array.from({ length: 7 }, (_, index) => ({
      id: toPublicId('automation_enrolment', `01890a5d-ac96-774b-bcce-b302099a810${String(index)}`),
      automationId: toPublicId('automation', `01890a5d-ac96-774b-bcce-b302099a820${String(index)}`),
      automationName: 'Wedding enquiry',
      version: 1,
      status: 'completed',
      recordId: contactId,
      record: { id: contactId, name: 'Maya', trashed: false },
      currentStep: null,
      exitReason: null,
      wakeAt: null,
      startedAt: time,
      finishedAt: time,
    })),
    nextCursor: null,
  };
  let inspected = 0;
  const steps: AutomationStepRunList = {
    items: [
      {
        id: toPublicId('automation_step_run', '01890a5d-ac96-774b-bcce-b302099a8300'),
        runId: runs.items[0]?.id ?? '',
        version: 1,
        label: 'Wedding booked',
        record: { id: contactId, name: 'Maya', trashed: false },
        step: 'finish',
        type: 'end',
        status: 'succeeded',
        input: {},
        output: {},
        branch: null,
        explanation: 'Reached the end',
        error: null,
        attempt: 1,
        startedAt: time,
        finishedAt: time,
      },
    ],
    nextCursor: null,
  };
  const routes: ApiRoute[] = [
    { endpoint: getContact, run: () => Promise.resolve({}) },
    {
      endpoint: listRecordActivity,
      run: (request) => {
        expect(request.query).toEqual({
          after: toPublicId('event', '01890a5d-ac96-774b-bcce-b302099a8400'),
        });
        return Promise.resolve({ items: [], next: null });
      },
    },
    {
      endpoint: listRecordAutomationRuns,
      run: (request) => {
        expect(request.query).toEqual({ after: runs.items[0]?.id });
        return Promise.resolve(runs);
      },
    },
    {
      endpoint: listAutomationStepRuns,
      run: (request) => {
        expect(request.invocation).toBe(invocation);
        expect(request.query).toEqual({
          record: contactId,
          from: '2026-10-12T00:00:00Z',
          to: '2026-10-13T00:00:00Z',
        });
        inspected += 1;
        return Promise.resolve(steps);
      },
    },
  ];
  const result = getContactJourney.response.schema.parse(
    await createContactJourneyRoute(routes).run(
      {
        invocation,
        params: { id: contactId },
        body: undefined,
        query: {
          from: '2026-10-12T00:00:00Z',
          to: '2026-10-13T00:00:00Z',
          runsAfter: runs.items[0]?.id,
          activityAfter: toPublicId('event', '01890a5d-ac96-774b-bcce-b302099a8400'),
        },
      },
      services,
    ),
  );
  expect(inspected).toBe(5);
  expect(result.items.filter((row) => row.kind === 'workflow_run')).toHaveLength(7);
  expect(result.items.filter((row) => row.kind === 'workflow_step')).toHaveLength(5);
  expect(result.coverage.omittedAutomations).toBe(2);
  expect(result.coverage.steps).toHaveLength(5);
});

it('reports denied workflow evidence as partial, and propagates missing readers and unexpected errors', async () => {
  const base: ApiRoute[] = [
    { endpoint: getContact, run: () => Promise.resolve({}) },
    { endpoint: listRecordActivity, run: () => Promise.resolve({ items: [], next: null }) },
  ];
  const request = { invocation, params: { id: contactId }, query: {}, body: undefined };
  const denied: ApiRoute = {
    endpoint: listRecordAutomationRuns,
    run: () => Promise.reject(new ForbiddenError('Denied', 'automations.manage')),
  };
  const result = getContactJourney.response.schema.parse(
    await createContactJourneyRoute([...base, denied]).run(request, services),
  );
  expect(result.coverage.notes.join(' ')).toContain('does not mean no workflow ran');
  await expect(createContactJourneyRoute(base).run(request, services)).rejects.toThrow(
    'is not installed',
  );
  await expect(
    createContactJourneyRoute([
      ...base,
      {
        endpoint: listRecordAutomationRuns,
        run: () => Promise.reject(new Error('database unavailable')),
      },
    ]).run(request, services),
  ).rejects.toThrow('database unavailable');
});
