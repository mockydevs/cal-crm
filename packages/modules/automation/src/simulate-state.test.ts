import { automationDocument } from '@repo/contracts';
import { expect, it } from 'vitest';

import { simulateAutomation } from './simulate.js';

const start = new Date('2026-10-11T09:00:00Z');

it.each([
  { fields: { 'contact.firstName': ' Grace ' }, expected: 'Grace Lovelace' },
  { fields: { 'contact.lastName': ' Hopper ' }, expected: 'Ada Hopper' },
  { fields: { 'contact.firstName': null }, expected: 'Lovelace' },
  { fields: { 'contact.lastName': null }, expected: 'Ada' },
  { fields: { 'contact.firstName': null, 'contact.lastName': null }, expected: null },
])('routes from the regenerated simulated display name %#', ({ fields, expected }) => {
  const values = Object.freeze({
    'contact.firstName': 'Ada',
    'contact.lastName': 'Lovelace',
    'contact.name': 'Ada Lovelace',
    'contact.email': 'ada@example.test',
  });
  const trace = simulateAutomation({
    document: automationDocument.parse({
      name: 'Display name route',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'change',
      steps: {
        change: { type: 'contact.update', config: { fields }, next: 'check' },
        check: {
          type: 'condition',
          config: {
            if:
              expected === null
                ? { field: 'contact.name', operator: 'is_empty' }
                : { field: 'contact.name', operator: 'equals', value: expected },
          },
          next: { yes: 'matched', no: 'stale' },
        },
        matched: { type: 'wait', config: { duration: 'PT1S' } },
        stale: { type: 'wait', config: { duration: 'PT1S' } },
      },
    }),
    values,
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'sample',
  });
  expect(trace.outcome).toEqual({ kind: 'completed' });
  expect(trace.steps.map((step) => step.step)).toEqual(['change', 'check', 'matched']);
  expect(values).toEqual({
    'contact.firstName': 'Ada',
    'contact.lastName': 'Lovelace',
    'contact.name': 'Ada Lovelace',
    'contact.email': 'ada@example.test',
  });
});

it.each([
  { type: 'tag.add', initial: [], operator: 'includes', expected: 'matched' },
  { type: 'tag.remove', initial: ['VIP', 'Existing'], operator: 'excludes', expected: 'matched' },
])(
  'routes from simulated %s using the tag name, not the identifier',
  ({ type, initial, operator, expected }) => {
    const values = Object.freeze({ 'contact.tags': Object.freeze(initial) });
    const trace = simulateAutomation({
      document: automationDocument.parse({
        name: 'Change tags and route',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'change',
        steps: {
          change: { type, config: { tag: 'tag_01h455vb4pex5vsknk084sn02q' }, next: 'check' },
          check: {
            type: 'condition',
            config: { if: { field: 'contact.tags', operator, value: 'VIP' } },
            next: { yes: 'matched', no: 'stale' },
          },
          matched: { type: 'wait', config: { duration: 'PT1S' } },
          stale: { type: 'wait', config: { duration: 'PT1S' } },
        },
      }),
      values,
      events: [],
      start,
      timeZone: 'UTC',
      enrolmentId: 'dry-run',
      tags: [{ id: 'tag_01h455vb4pex5vsknk084sn02q', name: 'VIP' }],
    });
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((step) => step.step)).toEqual(['change', 'check', expected]);
    expect(values['contact.tags']).toEqual(initial);
  },
);

it.each([
  { email: null, error: 'unsupported_value' },
  { email: '   ', error: 'unsupported_value' },
  { email: true, error: 'invalid_value' },
  { email: 'not-an-address', error: 'invalid_format' },
])('refuses invalid primary email changes before describing success %#', ({ email, error }) => {
  const values = Object.freeze({ 'contact.firstName': 'Ada', 'contact.email': 'ada@example.test' });
  const trace = simulateAutomation({
    document: automationDocument.parse({
      name: 'Refuse invalid email',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'change',
      steps: {
        change: {
          type: 'contact.update',
          config: { fields: { 'contact.firstName': 'Grace', 'contact.email': email } },
        },
      },
    }),
    values,
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'dry-run',
  });
  expect(trace).toEqual({ steps: [], outcome: { kind: 'failed', step: 'change', error } });
  expect(values).toEqual({ 'contact.firstName': 'Ada', 'contact.email': 'ada@example.test' });
});

it.each([
  { fields: { 'contact.firstName': '  Grace  ' }, field: 'contact.firstName', value: 'Grace' },
  { fields: { 'contact.lastName': '  Hopper  ' }, field: 'contact.lastName', value: 'Hopper' },
  { fields: { 'contact.lastName': null }, field: 'contact.lastName', value: null },
  {
    fields: { 'contact.email': '  GRACE@Example.test  ' },
    field: 'contact.email',
    value: 'grace@example.test',
  },
])(
  'normalizes simulated names through the canonical contact input %#',
  ({ fields, field, value }) => {
    const trace = simulateAutomation({
      document: automationDocument.parse({
        name: 'Normalize names',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'rename',
        steps: {
          rename: { type: 'contact.update', config: { fields }, next: 'check' },
          check: {
            type: 'condition',
            config: {
              if:
                value === null
                  ? { field, operator: 'is_empty' }
                  : { field, operator: 'equals', value },
            },
            next: { yes: 'matched', no: 'stale' },
          },
          matched: { type: 'tag.add', config: { tag: 'Matched' } },
          stale: { type: 'tag.add', config: { tag: 'Stale' } },
        },
      }),
      values: { 'contact.firstName': 'Ada', 'contact.lastName': 'Lovelace' },
      events: [],
      start,
      timeZone: 'UTC',
      enrolmentId: 'dry-run',
    });
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((step) => step.step)).toEqual(['rename', 'check', 'matched']);
  },
);

it.each([
  { name: 42, error: 'invalid_value' },
  { name: true, error: 'invalid_value' },
  { name: 'x'.repeat(201), error: 'too_big' },
])('refuses invalid simulated contact names %#', ({ name, error }) => {
  const trace = simulateAutomation({
    document: automationDocument.parse({
      name: 'Refuse invalid name',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'rename',
      steps: {
        rename: { type: 'contact.update', config: { fields: { 'contact.firstName': name } } },
      },
    }),
    values: { 'contact.firstName': 'Ada' },
    events: [],
    start,
    timeZone: 'UTC',
    enrolmentId: 'dry-run',
  });
  expect(trace).toEqual({
    steps: [],
    outcome: { kind: 'failed', step: 'rename', error },
  });
});

it('routes a later condition using the simulated contact name without changing caller values', () => {
  const values = Object.freeze({ 'contact.firstName': 'Ada' });
  const document = automationDocument.parse({
    name: 'Rename and route',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'rename',
    steps: {
      rename: {
        type: 'contact.update',
        config: { fields: { 'contact.firstName': 'Grace' } },
        next: 'check',
      },
      check: {
        type: 'condition',
        config: { if: { field: 'contact.firstName', operator: 'equals', value: 'Grace' } },
        next: { yes: 'matched', no: 'stale' },
      },
      matched: { type: 'tag.add', config: { tag: 'Matched' } },
      stale: { type: 'tag.add', config: { tag: 'Stale' } },
    },
  });
  const trace = simulateAutomation({
    document,
    values,
    events: [],
    start: new Date('2026-10-11T09:00:00Z'),
    timeZone: 'UTC',
    enrolmentId: 'dry-run',
  });
  expect(trace.outcome).toEqual({ kind: 'completed' });
  expect(trace.steps.map((step) => step.step)).toEqual(['rename', 'check', 'matched']);
  expect(values).toEqual({ 'contact.firstName': 'Ada' });
});
