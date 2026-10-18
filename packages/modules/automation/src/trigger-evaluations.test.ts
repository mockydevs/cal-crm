// Why an event does not pass a trigger, and the words a kept reason is told in. No
// database: triggerMismatch is held to eventPassesTrigger here, since only that one decides
// whether a record is enrolled and this one only says why it was not.
import { automationTrigger, type AutomationTrigger } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { endingWords, explainEvaluation } from './trigger-evaluation-words.js';
import { eventPassesTrigger, FIELD_CHANGES, triggerMismatch } from './triggers.js';

const trigger = (type: string, config: Record<string, unknown>): AutomationTrigger =>
  automationTrigger.parse({ id: 't', type, config });

const UUID = '0188a5eb-4b84-7095-bcce-7340229b0057';
const TAG = toPublicId('tag', UUID);

/** A trigger, an event and its payload, and the mismatch expected: nothing when it passes. */
const CASES: readonly (readonly [
  AutomationTrigger,
  string,
  Record<string, unknown>,
  { filter: string; expected: unknown; actual: unknown } | undefined,
])[] = [
  [trigger('tag.added', { tag: TAG }), 'tag.assigned', { tagId: TAG }, undefined],
  // The same tag, written as the stored id.
  [trigger('tag.added', { tag: TAG }), 'tag.assigned', { tagId: UUID }, undefined],
  [
    trigger('tag.added', { tag: TAG }),
    'tag.assigned',
    { tagId: 'tag_other' },
    { filter: 'tag', expected: TAG, actual: 'tag_other' },
  ],
  [
    trigger('tag.added', { tag: TAG }),
    'tag.assigned',
    {},
    { filter: 'tag', expected: TAG, actual: null },
  ],
  [
    trigger('tag.added', { tag: TAG }),
    'tag.removed',
    { tagId: TAG },
    { filter: 'event', expected: ['tag.assigned'], actual: 'tag.removed' },
  ],
  [trigger('contact.created', {}), 'contact.created', {}, undefined],
  [trigger('message.received', {}), 'message.received', { channel: 'sms' }, undefined],
  [
    trigger('message.received', { channel: 'email' }),
    'message.received',
    { channel: 'sms' },
    { filter: 'channel', expected: 'email', actual: 'sms' },
  ],
  [
    trigger('deal.stage_changed', { pipeline: 'pip_a', stage: 'stg_b' }),
    'deal.stage_changed',
    { pipelineId: 'pip_a', stageId: 'stg_c' },
    { filter: 'stage', expected: 'stg_b', actual: 'stg_c' },
  ],
  [trigger('deal.closed', { outcome: 'won' }), 'deal.won', {}, undefined],
  [
    trigger('deal.closed', { outcome: 'won' }),
    'deal.lost',
    {},
    { filter: 'outcome', expected: 'won', actual: 'lost' },
  ],
  [
    trigger('deal.closed', { outcome: 'lost', pipeline: 'pip_a' }),
    'deal.lost',
    { pipelineId: 'pip_b' },
    { filter: 'pipeline', expected: 'pip_a', actual: 'pip_b' },
  ],
  [
    trigger('field.changed', { field: 'contact.source' }),
    'contact.updated',
    { [FIELD_CHANGES]: [{ field: 'contact.source', value: 'Web' }] },
    undefined,
  ],
  [
    trigger('field.changed', { field: 'contact.source' }),
    'contact.updated',
    { [FIELD_CHANGES]: [{ field: 'contact.firstName', value: 'Ada' }, { field: 'contact.name' }] },
    { filter: 'field', expected: 'contact.source', actual: ['contact.firstName', 'contact.name'] },
  ],
  [
    trigger('field.changed', { field: 'contact.source', to: 'Web' }),
    'contact.updated',
    { [FIELD_CHANGES]: [{ field: 'contact.source', value: 'Referral' }] },
    { filter: 'to', expected: 'Web', actual: 'Referral' },
  ],
  [
    trigger('field.changed', { field: 'contact.source', to: 'Web' }),
    'contact.updated',
    { [FIELD_CHANGES]: [{ field: 'contact.source' }] },
    { filter: 'to', expected: 'Web', actual: 'unknown' },
  ],
  [
    trigger('field.changed', { field: 'contact.source', to: 'web' }),
    'contact.updated',
    { [FIELD_CHANGES]: [{ field: 'contact.source', value: 'Web' }] },
    undefined,
  ],
  [
    trigger('field.changed', { field: 'contact.source' }),
    'contact.updated',
    {},
    { filter: 'field', expected: 'contact.source', actual: [] },
  ],
  [
    trigger('automation.run_ended', { automations: ['aut_a'] }),
    'automation.run.completed',
    { automationId: 'aut_a' },
    undefined,
  ],
  [
    trigger('automation.run_ended', { automations: ['aut_a'] }),
    'automation.run.completed',
    { automationId: 'aut_b' },
    { filter: 'automations', expected: ['aut_a'], actual: 'aut_b' },
  ],
  [
    trigger('automation.run_ended', { automations: ['aut_a'], how: ['failed'] }),
    'automation.run.completed',
    { automationId: 'aut_a' },
    { filter: 'how', expected: ['failed'], actual: 'completed' },
  ],
  [
    trigger('automation.run_ended', { automations: ['aut_a'], stoppedBy: ['message.received'] }),
    'automation.run.stopped',
    { automationId: 'aut_a', reason: 'stop:appointment.booked' },
    { filter: 'stoppedBy', expected: ['message.received'], actual: 'stop:appointment.booked' },
  ],
  [
    trigger('automation.run_ended', { automations: ['aut_a'], stoppedBy: ['message.received'] }),
    'automation.run.stopped',
    { automationId: 'aut_a', reason: 'removed:aut_c' },
    { filter: 'how', expected: ['stopped'], actual: 'removed' },
  ],
  [
    trigger('automation.run_ended', { automations: ['aut_a'] }),
    'automation.run.stopped',
    { automationId: 'aut_a' },
    { filter: 'how', expected: ['stopped', 'removed', 'completed', 'failed'], actual: null },
  ],
  [
    trigger('automation.run_ended', { automations: ['aut_a'], stoppedBy: ['message.received'] }),
    'automation.run.stopped',
    { automationId: 'aut_a', reason: 'stop:message.received' },
    undefined,
  ],
];

describe('why an event does not pass a trigger', () => {
  it.each(CASES)('%j on %s with %j', (given, eventType, payload, expected) => {
    expect(triggerMismatch(given, eventType, payload)).toEqual(expected);
    // The two never disagree on whether it passes.
    expect(eventPassesTrigger(given, eventType, payload)).toBe(expected === undefined);
  });
});

describe('a reason in words', () => {
  it.each([
    [
      'filter_mismatch',
      { filter: 'tag', expected: 'tag_a', actual: 'tag_b' },
      "The trigger's tag filter wanted tag_a, and the event had tag_b.",
    ],
    [
      'filter_mismatch',
      { filter: 'repliedTo', expected: ['aut_a', 'aut_b'], actual: null },
      "The trigger's repliedTo filter wanted aut_a, aut_b, and the event had nothing.",
    ],
    [
      'filter_mismatch',
      { filter: 'field', expected: 'contact.source', actual: [] },
      "The trigger's field filter wanted contact.source, and the event had nothing.",
    ],
    [
      'filter_mismatch',
      { filter: 'event', expected: ['tag.assigned'], actual: 'tag.removed' },
      'The trigger listens for tag.assigned, and the event was tag.removed.',
    ],
    [
      'condition_false',
      { values: { 'contact.tags': ['VIP'], 'contact.custom.budget': 0, 'contact.lastName': null } },
      "The trigger's condition did not hold for the record: contact.tags was VIP; contact.custom.budget was 0; contact.lastName was nothing.",
    ],
    ['condition_false', {}, "The trigger's condition did not hold for the record."],
    [
      'condition_false',
      { values: 'not a record' },
      "The trigger's condition did not hold for the record.",
    ],
    [
      'already_enrolled',
      {},
      'The record was already in this workflow, and is in it once at a time.',
    ],
    [
      'already_enrolled',
      { queued: true },
      'The record was already in this workflow, so it goes through again once that run ends, reading the record as it is then.',
    ],
    ['paused', { after: 'arun_01' }, 'The workflow was paused, so it started for nobody.'],
    [
      'reentry_not_allowed',
      {},
      'The record has been through this workflow before, and it takes a record once (re-entry is off).',
    ],
    ['paused', {}, 'The workflow was paused, so it started for nobody.'],
    ['contact_missing', {}, 'The event was about no record, so there was nobody to start for.'],
    [
      'stopped_by_rule',
      { rule: 'imported_contact' },
      'The contact was made by an import, and an imported contact starts no workflow by having been created.',
    ],
    ['stopped_by_rule', { rule: 'another' }, 'A rule stopped it (another).'],
    [
      'stopped_by_rule',
      { rule: 'contact_trashed' },
      'The contact is in the trash, and a contact in the trash starts no workflow.',
    ],
    [
      'refused_loop',
      { cause: 'own_change' },
      "The change was made by this workflow's own run for the record, or by a run that run led to, so it did not start the workflow again.",
    ],
    [
      'refused_loop',
      { cause: 'run_limit', starts: 20, windowMinutes: 60 },
      'The workflow had already started 20 times for the record in the last 60 minutes, the most it may, so it was not started: something keeps starting it, such as a loop through another app.',
    ],
    [
      'refused_loop',
      {},
      'Starting it would have led back to a workflow that led to this event, so it was not started.',
    ],
  ] as const)('%s %j', (reason, detail, words) => {
    expect(explainEvaluation(reason, detail)).toBe(words);
  });
});

describe('why a run ended, in words', () => {
  const run = (status: string, exitReason: string | null) =>
    ({ status, exitReason }) as Parameters<typeof endingWords>[0];

  it.each([
    ['running', null, undefined, null],
    ['waiting', null, undefined, null],
    ['completed', null, undefined, 'It completed: it reached the end of its path.'],
    ['failed', 'conflict', 'rename', 'It failed at the step "rename" (conflict).'],
    ['failed', 'missing_step', undefined, 'It failed (missing_step).'],
    ['failed', null, undefined, 'It failed (no reason kept).'],
    [
      'cancelled',
      'automation_deleted',
      undefined,
      'It was cancelled when the workflow was deleted.',
    ],
    ['cancelled', null, undefined, 'It was cancelled (no reason kept).'],
    [
      'exited',
      'stop:message.received',
      undefined,
      "One of the workflow's stop conditions ended it (message.received).",
    ],
    ['exited', 'removed:aut_a', undefined, 'A step that removes records from workflows ended it.'],
    ['exited', 'contact_trashed', undefined, 'The contact was moved to the trash, which ended it.'],
    ['exited', 'other', undefined, 'It was ended early (other).'],
    ['exited', null, undefined, 'It was ended early (no reason kept).'],
  ])('%s with %s', (status, reason, failedAt, words) => {
    expect(endingWords(run(status, reason), failedAt)).toBe(words);
  });
});
