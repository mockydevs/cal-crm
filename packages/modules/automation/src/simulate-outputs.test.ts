import { automationDocument } from '@repo/contracts';
import { expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';

const start = new Date('2026-10-11T09:00:00Z');

it('provides explicitly synthetic note and task outputs to later native text actions', () => {
  const trace = simulateAutomation({
    document: automationDocument.parse({
      name: 'Create and use simulated outputs',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'note',
      steps: {
        note: {
          type: 'note.create',
          config: { text: 'Call {{contact.firstName}}.' },
          next: 'task',
        },
        task: {
          type: 'task.create',
          config: { title: 'Review {{steps.note.noteId}}' },
          next: 'followup',
        },
        followup: { type: 'note.create', config: { text: 'Follow task {{steps.task.taskId}}.' } },
      },
    }),
    values: { 'contact.firstName': 'Ada', 'steps.note.noteId': 'x'.repeat(1000) },
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
  });
  expect(trace.outcome).toEqual({ kind: 'completed' });
  expect(trace.steps).toMatchObject([
    { step: 'note', simulated: true, output: { noteId: 'simulated:note:note:1' } },
    { step: 'task', simulated: true, output: { taskId: 'simulated:task:task:2' } },
    { step: 'followup', simulated: true, output: { noteId: 'simulated:note:followup:3' } },
  ]);
});

it.each([
  { length: 300, expected: { kind: 'completed' } },
  { length: 301, expected: { kind: 'failed', step: 'task', error: 'too_big' } },
])('checks the rendered task title at the canonical length boundary %#', ({ length, expected }) => {
  const trace = simulateAutomation({
    document: automationDocument.parse({
      name: 'Rendered task boundary',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'task',
      steps: { task: { type: 'task.create', config: { title: '{{contact.title}}' } } },
    }),
    values: { 'contact.title': 'x'.repeat(length) },
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
  });
  expect(trace.outcome).toEqual(expected);
});

it('refuses a task due beyond the supported date range', () => {
  const trace = simulateAutomation({
    document: automationDocument.parse({
      name: 'Date overflow',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'task',
      steps: {
        task: {
          type: 'task.create',
          config: { title: 'Review', dueIn: 'P9999999999999999999999D' },
        },
      },
    }),
    values: {},
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
  });
  expect(trace).toEqual({
    steps: [],
    outcome: { kind: 'failed', step: 'task', error: 'date_out_of_range' },
  });
});

it.each([
  { type: 'note.create', config: { text: 'Call {{contact.firstName}}.' } },
  { type: 'task.create', config: { title: 'Call {{contact.firstName}}.' } },
])('refuses missing merge inputs before reporting a simulated action %#', (step) => {
  const trace = simulateAutomation({
    document: automationDocument.parse({
      name: 'Missing input',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'action',
      steps: { action: step },
    }),
    values: {},
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
  });
  expect(trace).toEqual({
    steps: [],
    outcome: { kind: 'failed', step: 'action', error: 'missing_values' },
  });
});
