import { describe, expect, it } from 'vitest';

import { evaluateCondition, type ConditionValues } from './automations-evaluate.js';
import { applyJsonPatch, diffJson, type JsonValue } from './automations-patch.js';
import {
  maxDurationDays,
  portableAutomation,
  validateAutomation,
  type AutomationSetup,
} from './automations-validate.js';

const setup: AutomationSetup = {
  fields: {
    contact: [
      { key: 'vip', aliases: ['priority'], type: 'boolean', options: [] },
      { key: 'event_date', aliases: ['old_date'], type: 'date', options: [] },
    ],
    deal: [],
  },
  forms: [{ id: 'form_quote', name: 'Quote' }],
  emailTemplates: [{ id: 'template_welcome', name: 'Welcome' }],
  whatsappTemplates: [{ id: 'template_whatsapp', name: 'Greeting' }],
  mailboxes: [{ id: 'mailbox_sales', name: 'Sales' }],
  phoneNumbers: [],
  calendars: [{ id: 'calendar_sales', name: 'Sales' }],
  pipelines: [{ id: 'pipeline_sales', name: 'Sales', stages: [{ id: 'stage_new', name: 'New' }] }],
  lostReasons: [],
  tags: [],
  users: [],
  automations: [],
  values: [],
  channels: { email: true, sms: true, whatsapp: true },
  ai: true,
  webhooks: true,
  unavailableSteps: [],
  unavailableTriggers: [],
};

function draft(step: unknown, additions: Record<string, unknown> = {}) {
  return {
    name: 'Boundary checks',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'first',
    steps: { first: step },
    ...additions,
  };
}

const wait = { type: 'wait', config: { duration: 'P1D' } };
const issues = (document: unknown, business = setup) =>
  validateAutomation(document, business).errors.map(({ path, code }) => ({ path, code }));

describe('automation validation at record and setup boundaries', () => {
  it.each(['company.name', 'contact.custom.vip.extra', 'contact.unknown_long_key'])(
    'refuses unresolved %s fields without inventing a suggestion',
    (field) => {
      const result = validateAutomation(
        draft({ type: 'contact.update', config: { fields: { [field]: true } } }),
        setup,
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: `/steps/first/config/fields/${field}`,
        code: 'unknown_field',
        message: field.startsWith('company.')
          ? `${field} is not a field: fields start with contact., deal., appointment., trigger.attribution. or trigger.answers., or are trigger.pageUrl.`
          : `${field} is not a field.`,
      });
      expect(result.document).toBeUndefined();
    },
  );

  it.each([
    ['deal.amount', 10, 'wrong_field'],
    ['contact.createdAt', '2026-10-09', 'read_only_field'],
    ['contact.custom.vip', 'yes', 'wrong_value_type'],
  ] as const)('refuses an automation update of %s', (field, value, code) => {
    expect(
      issues(draft({ type: 'contact.update', config: { fields: { [field]: value } } })),
    ).toContainEqual({ path: `/steps/first/config/fields/${field}`, code });
  });

  it('canonicalizes aliases and null clearing without changing the input', () => {
    const document = draft({
      type: 'contact.update',
      config: { fields: { 'contact.priority': true, 'contact.old_date': null } },
    });
    const original = structuredClone(document);
    const result = validateAutomation(document, setup);
    expect(result.valid).toBe(true);
    expect(result.document?.steps['first']?.config).toEqual({
      fields: { 'contact.custom.vip': true, 'contact.custom.event_date': null },
    });
    expect(document).toEqual(original);
  });

  it('normalizes nested trigger and stop filters and built-in deal options', () => {
    const condition = {
      all: [
        { field: 'deal.status', operator: 'equals', value: 'Won' },
        { any: [{ not: { field: 'contact.priority', operator: 'equals', value: false } }] },
      ],
    };
    const result = validateAutomation(
      draft(wait, {
        triggers: [{ id: 'created', type: 'contact.created', config: {}, if: condition }],
        stopWhen: [{ event: 'message.received', if: condition }],
      }),
      setup,
    );
    expect(result.valid).toBe(true);
    const canonical = {
      all: [
        { field: 'deal.status', operator: 'equals', value: 'won' },
        { any: [{ not: { field: 'contact.custom.vip', operator: 'equals', value: false } }] },
      ],
    };
    expect(result.document?.triggers[0]?.if).toEqual(canonical);
    expect(result.document?.stopWhen[0]?.if).toEqual(canonical);
  });

  it('accepts provider references by ID and resolves stage names without a pipeline filter', () => {
    const result = validateAutomation(
      draft(
        {
          type: 'email.send',
          config: { template: 'template_welcome', mailbox: 'mailbox_sales' },
        },
        {
          triggers: [{ id: 'moved', type: 'deal.stage_changed', config: { stage: 'New' } }],
        },
      ),
      setup,
    );
    expect(result.valid).toBe(true);
    expect(result.document?.triggers[0]?.config).toEqual({ stage: 'stage_new' });
    expect(result.document?.steps['first']?.config).toEqual({
      template: 'template_welcome',
      mailbox: 'mailbox_sales',
    });
  });

  it.each([
    ['email', { type: 'email.send', config: { template: 'template_welcome' } }, 'a mailbox'],
    ['sms', { type: 'sms.send', config: { message: 'Hello' } }, 'an SMS number'],
  ] as const)(
    'refuses the disconnected %s channel with a useful remedy',
    (channel, step, remedy) => {
      const result = validateAutomation(draft(step), {
        ...setup,
        channels: { ...setup.channels, [channel]: false },
      });
      expect(result.errors).toContainEqual({
        path: '/steps/first',
        code: 'no_provider',
        message: `Connect ${remedy} before sending from this step.`,
      });
    },
  );

  it.each([
    ['date.reached', 'contact.custom.vip', 'wrong_field_type'],
    ['field.changed', 'contact.unrecognized_field', 'unknown_field'],
  ])('checks %s trigger field configuration', (type, field, code) => {
    expect(
      issues(draft(wait, { triggers: [{ id: 'changed', type, config: { field } }] })),
    ).toContainEqual({ path: '/triggers/0/config/field', code });
  });

  it.each([
    [{ field: 'contact.old_date' }, undefined],
    [{ field: 'contact.custom.vip' }, 'wrong_field_type'],
    [{ field: 'contact.unrecognized_field' }, 'unknown_field'],
    [{ field: 'contact.old_date', offset: 'P366D' }, 'wait_too_long'],
    [{ at: '2026-10-10T10:00:00Z' }, undefined],
  ])('checks date wait %j before enrolment', (config, code) => {
    const result = validateAutomation(draft({ type: 'wait.until', config }), setup);
    expect(result.valid).toBe(code === undefined);
    if (code !== undefined) expect(result.errors.map((issue) => issue.code)).toContain(code);
    else expect(result.errors).toEqual([]);
  });

  it('bounds event waits and identifies their timeout field', () => {
    expect(
      issues(
        draft({ type: 'wait.event', config: { event: 'message.received', timeout: 'P366D' } }),
      ),
    ).toContainEqual({ path: '/steps/first/config/timeout', code: 'wait_too_long' });
    expect(maxDurationDays('not-a-duration')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('automation flow and merge references', () => {
  it('reports a missing start and stale layout without inventing reachability errors', () => {
    const result = validateAutomation(
      draft(wait, { start: 'missing', layout: { removed: { x: 0, y: 0 } } }),
      setup,
    );
    expect(result.errors.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: '/start', code: 'unknown_step' },
    ]);
    expect(result.warnings.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: '/layout/removed', code: 'unknown_layout_step' },
    ]);
  });

  it.each([
    [
      {
        type: 'split',
        config: {
          variants: [
            { name: 'same', percent: 50 },
            { name: 'same', percent: 50 },
          ],
        },
      },
      'duplicate_branch',
      '/steps/first/config',
    ],
    [
      { type: 'ai.classify', config: { categories: ['yes', 'yes'] } },
      'duplicate_branch',
      '/steps/first/config',
    ],
    [
      { type: 'ai.classify', config: { categories: ['yes', 'no'] }, next: { other: 'first' } },
      'unknown_branch',
      '/steps/first/next/other',
    ],
  ])('refuses ambiguous branch routing %j', (step, code, path) => {
    expect(issues(draft(step))).toContainEqual({ path, code });
  });

  it('resolves current step and trigger outputs while preserving surrounding text', () => {
    const message =
      'Reply {{trigger.messageId}} / {{steps.first.messageId}} / {{contact.priority}}';
    const result = validateAutomation(
      draft(
        { type: 'sms.send', config: { message } },
        {
          triggers: [{ id: 'received', type: 'message.received', config: {} }],
        },
      ),
      setup,
    );
    expect(result.valid).toBe(true);
    expect(result.document?.steps['first']?.config).toEqual({
      message: 'Reply {{trigger.messageId}} / {{steps.first.messageId}} / {{contact.custom.vip}}',
    });
  });

  it.each([
    'trigger.unknown_output',
    'trigger.messageId.extra',
    'steps.unknown.messageId',
    'steps.first.unknown_output',
    'company.name',
    'contact.custom.unknown_long_key',
  ])('refuses unavailable merge output %s at the authored message', (reference) => {
    expect(
      issues(draft({ type: 'sms.send', config: { message: `Hello {{${reference}}}` } })),
    ).toContainEqual({ path: '/steps/first/config/message', code: 'unknown_merge_field' });
  });

  it('keeps unfinished portable drafts and unfiltered stage names intact', () => {
    const document = { steps: { move: { type: 'deal.move', config: { stage: 'stage_new' } } } };
    expect(portableAutomation(document, setup)).toEqual({
      document: { steps: { move: { type: 'deal.move', config: { stage: 'New' } } } },
      warnings: [],
    });
    expect(portableAutomation({ name: 'Unfinished' }, setup)).toEqual({
      document: { name: 'Unfinished' },
      warnings: [],
    });
  });
});

describe('condition boundaries choose the safe branch', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const values: ConditionValues = {
    empty: null,
    list: [],
    numbers: [1, 2],
    invalid: '2026-99-99',
    date: '2026-10-10',
    text: 'Ada',
  };
  it.each([
    [{ field: 'empty', operator: 'is_empty' }, true],
    [{ field: 'list', operator: 'is_empty' }, true],
    [{ field: 'numbers', operator: 'is_set' }, true],
    [{ field: 'numbers', operator: 'equals', value: 2 }, true],
    [{ field: 'numbers', operator: 'equals', value: 3 }, false],
    [{ field: 'empty', operator: 'equals', value: false }, false],
    [{ field: 'text', operator: 'includes', value: 2 }, false],
    [{ field: 'date', operator: 'greater_than', value: '2026-10-09' }, true],
    [{ field: 'date', operator: 'less_than', value: '2026-10-11' }, true],
    [{ field: 'invalid', operator: 'after', value: '2026-10-09' }, false],
    [{ field: 'date', operator: 'before', value: 1 }, false],
    [{ field: 'date', operator: 'within_next', value: 'invalid-duration' }, false],
  ] as const)('%j yields %s', (condition, expected) => {
    expect(evaluateCondition(condition, values, now)).toBe(expected);
  });
});

describe('patch nulls and atomic refusal', () => {
  it.each([
    [{ op: 'add', path: '/value', value: null }, { value: null }],
    [{ op: 'replace', path: '/value', value: null }, { value: null }],
    [{ op: 'test', path: '/value', value: null }, { value: null }],
    [
      { op: 'copy', from: '/value', path: '/other' },
      { value: null, other: null },
    ],
  ])('retains explicit null through %j', (operation, expected) => {
    expect(applyJsonPatch({ value: null }, [operation])).toEqual({ ok: true, document: expected });
  });

  it.each([
    [{ list: [null] }, '/list/0'],
    [{ value: null }, '/value'],
  ] as const)('tests a stored null at %s', (document, path) => {
    expect(applyJsonPatch(document, [{ op: 'test', path, value: null }])).toEqual({
      ok: true,
      document,
    });
  });

  it('rejects traversal through a scalar and preserves the earlier document', () => {
    const document = { value: 7 };
    const result = applyJsonPatch(document, [
      { op: 'add', path: '/new', value: 1 },
      { op: 'add', path: '/value/child', value: 2 },
    ]);
    expect(result).toMatchObject({ ok: false, error: { index: 1, code: 'path_not_found' } });
    expect(document).toEqual({ value: 7 });
  });

  it('diffs null-valued object members and array positions with a replayable patch', () => {
    const before: JsonValue = { value: 1, list: [2, { label: 'Before' }] };
    const after: JsonValue = { value: null, list: [null, { label: null }] };
    expect(applyJsonPatch(before, diffJson(before, after))).toEqual({ ok: true, document: after });
    expect(before).toEqual({ value: 1, list: [2, { label: 'Before' }] });
  });
});
