import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { automationStepTypes, automationTriggerTypes } from './automations-catalog.js';
import {
  automationCatalog,
  automationDocument,
  automationJsonSchema,
  automationStep,
  type AutomationDocumentInput,
} from './automations.js';
import { automationCondition } from './automations-values.js';

// The examples are read from the spec itself, so they can't drift from it.
const spec = readFileSync(new URL('../../../docs/AUTOMATIONS.md', import.meta.url), 'utf8');
const jsonBlocks = [...spec.matchAll(/```json\n([\s\S]*?)```/g)].map(
  ([, body]) => JSON.parse(body ?? '') as Record<string, unknown>,
);
const inlineCondition = /\*\*The basic form:\*\* `(\{[^`]+\})`/.exec(spec)?.[1];

const issues = (input: unknown) => {
  const result = automationDocument.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('/'));
};

const minimal = (patch: Partial<AutomationDocumentInput> = {}): AutomationDocumentInput => ({
  name: 'Welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'hello',
  steps: { hello: { type: 'sms.send', config: { message: 'Hi {{contact.firstName}}' } } },
  ...patch,
});

describe('the examples in AUTOMATIONS.md', () => {
  it('include the full document, and it validates', () => {
    const documents = jsonBlocks.filter((block) => 'steps' in block);
    expect(documents).toHaveLength(1);
    for (const document of documents) expect(issues(document)).toEqual([]);
  });

  it('normalizes the example with its defaults', () => {
    const parsed = automationDocument.parse(jsonBlocks.find((block) => 'steps' in block));
    expect(parsed.settings).toEqual({ reEnrollment: 'after_finished', timezone: 'contact' });
    expect(Object.keys(parsed.steps)).toEqual([
      'send_guide',
      'wait_2_days',
      'asked_about_video',
      'send_reel',
      'check_in',
      'wait_3_days',
      'last_check_in',
    ]);
  });

  it('include the basic condition, and it validates', () => {
    expect(inlineCondition).toBeDefined();
    expect(automationCondition.safeParse(JSON.parse(inlineCondition ?? '')).success).toBe(true);
  });
});

describe('the document shape', () => {
  it('fills in defaults', () => {
    expect(automationDocument.parse(minimal())).toMatchObject({
      description: '',
      stopWhen: [],
      settings: { reEnrollment: 'never', timezone: 'business' },
    });
  });

  it.each([
    [
      'an unknown step type',
      { steps: { hello: { type: 'sms.blast', config: {} } } },
      'steps/hello/type',
    ],
    [
      'an unknown config key',
      { steps: { hello: { type: 'wait', config: { duration: 'P1D', x: 1 } } } },
      'steps/hello/config',
    ],
    [
      'a bad duration',
      { steps: { hello: { type: 'wait', config: { duration: '2 days' } } } },
      'steps/hello/config/duration',
    ],
    [
      'a step id with capitals',
      { steps: { Hello: { type: 'wait', config: { duration: 'P1D' } } } },
      'steps/Hello',
    ],
    [
      'a lost deal without a reason',
      { steps: { hello: { type: 'deal.close', config: { outcome: 'lost' } } } },
      'steps/hello/config',
    ],
    [
      'condition branches other than yes and no',
      {
        steps: {
          hello: {
            type: 'condition',
            config: { if: { field: 'contact.city', operator: 'is_set' } },
            next: { maybe: 'x' },
          },
        },
      },
      'steps/hello/next',
    ],
    [
      'a value on is_set',
      {
        steps: {
          hello: {
            type: 'condition',
            config: { if: { field: 'contact.city', operator: 'is_set', value: 'x' } },
          },
        },
      },
      'steps/hello/config/if',
    ],
    [
      'a webhook over http',
      { steps: { hello: { type: 'webhook.call', config: { url: 'http://example.test/hook' } } } },
      'steps/hello/config/url',
    ],
    [
      'from on a stop event other than a message',
      { stopWhen: [{ event: 'deal.closed', from: 'contact' }] },
      'stopWhen/0',
    ],
    ['a timer as a stop event', { stopWhen: [{ event: 'schedule' }] }, 'stopWhen/0/event'],
    ['an unknown top-level key', { owner: 'me' }, ''],
  ])('refuses %s', (_name, patch, path) => {
    expect(issues({ ...minimal(), ...patch })).toContain(path);
  });

  it('accepts nested conditions, named branches and both wait.until forms', () => {
    expect(
      issues(
        minimal({
          stopWhen: [{ event: 'message.received', from: 'contact' }],
          steps: {
            hello: {
              type: 'condition',
              config: {
                if: {
                  all: [
                    { field: 'contact.city', operator: 'equals', value: 'Mombasa' },
                    {
                      not: {
                        field: 'contact.lastBookedAt',
                        operator: 'within_last',
                        value: 'P30D',
                      },
                    },
                    { any: [{ field: 'deal.value', operator: 'greater_than', value: 1000 }] },
                  ],
                },
              },
              next: { yes: 'split', no: 'before_event' },
            },
            split: {
              type: 'split',
              config: {
                variants: [
                  { name: 'a', percent: 50 },
                  { name: 'b', percent: 50 },
                ],
              },
              next: { a: 'classify', b: 'classify' },
            },
            classify: {
              type: 'ai.classify',
              config: { categories: ['interested', 'not_now'] },
              next: { interested: 'before_event' },
            },
            before_event: {
              type: 'wait.until',
              config: { field: 'contact.eventDate', offset: 'P2D', time: '09:00' },
              next: 'fixed_time',
            },
            fixed_time: { type: 'wait.until', config: { at: '2026-12-01T09:00:00+03:00' } },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('covers every catalog step type, and nothing else', () => {
    const covered = automationStep.options.map((option) => option.shape.type.value).sort();
    expect(covered).toEqual(Object.keys(automationStepTypes).sort());
  });
});

describe('the catalog', () => {
  const catalog = automationCatalog();

  it("lists each step's inputs as JSON Schema, and its branches and outputs", () => {
    expect(catalog.steps.map((step) => step.type)).toEqual(Object.keys(automationStepTypes));
    for (const step of catalog.steps) {
      expect(step.config, step.type).toMatchObject({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
      });
      expect(Array.isArray(step.outputs), step.type).toBe(true);
      // At version 2: the condition since it took named branches, owner.assign since it
      // took a team that takes turns, contact.update since it took computed values,
      // deal.create since it took a source, webhook.call since it took headers, wait.until
      // since it took ifEmpty, wait.appointment since a no-show ends it, dnd.set since it
      // took the inbound direction.
      expect(step.version, step.type).toBe(
        [
          'condition',
          'owner.assign',
          'contact.update',
          'deal.create',
          'webhook.call',
          'wait.until',
          'wait.appointment',
          'dnd.set',
        ].includes(step.type)
          ? 2
          : 1,
      );
    }
    expect(catalog.steps.find((step) => step.type === 'ai.ask')?.outputs).toEqual([
      { key: 'answer', type: 'string', description: "The AI's answer." },
    ]);
    expect(catalog.steps.find((step) => step.type === 'condition')?.branches).toEqual({
      kind: 'from_config',
      field: 'branches',
      fallback: 'none',
      legacy: ['yes', 'no'],
    });
  });

  it('lists every trigger and operator', () => {
    expect(catalog.triggers.map((trigger) => trigger.type)).toEqual(
      Object.keys(automationTriggerTypes),
    );
    expect(catalog.operators).toContainEqual({ operator: 'within_last', value: 'duration' });
    expect(catalog.operators).toContainEqual({ operator: 'is_set', value: 'none' });
  });

  it('matches its published snapshot', async () => {
    await expect(`${JSON.stringify(catalog, null, 2)}\n`).toMatchFileSnapshot(
      '../automations.catalog.json',
    );
  });
});

describe('the JSON Schema', () => {
  const schema = automationJsonSchema();

  it('is draft 2020-12, keyed by step id, with conditions as a reusable definition', () => {
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: expect.arrayContaining(['name', 'triggers', 'start', 'steps']) as unknown,
    });
    expect(JSON.stringify(schema)).toContain('AutomationCondition');
  });

  it('matches its published snapshot', async () => {
    await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
      '../automations.schema.json',
    );
  });
});
