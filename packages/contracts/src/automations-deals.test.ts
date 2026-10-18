// Opportunities in hand: deal.find, deal.update and the deal.* paths. Shape, validation and
// the published catalog; what each does is tested in packages/modules/automation.
import { describe, expect, it } from 'vitest';

import { automationBranchNames, automationStepTypes } from './automations-catalog.js';
import { automationCatalog, automationDocument } from './automations.js';
import {
  portableAutomation,
  validateAutomation,
  type AutomationSetup,
} from './automations-validate.js';

const setup: AutomationSetup = {
  fields: {
    contact: [{ key: 'budget', aliases: [], type: 'number', options: [] }],
    deal: [
      {
        key: 'service',
        aliases: [],
        type: 'single_choice',
        options: [{ key: 'video', label: 'Video' }],
      },
      { key: 'guests', aliases: [], type: 'number', options: [] },
    ],
  },
  forms: [],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [],
  pipelines: [
    {
      id: 'pip_sales',
      name: 'Sales',
      stages: [
        { id: 'stg_new', name: 'New' },
        { id: 'stg_won', name: 'Booked' },
      ],
    },
    { id: 'pip_renewals', name: 'Renewals', stages: [{ id: 'stg_due', name: 'Due' }] },
  ],
  lostReasons: [],
  tags: [],
  users: [{ id: 'mem_amina', name: 'Amina Odhiambo' }],
  automations: [],
  values: [],
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const document = (steps: Record<string, unknown>) => ({
  name: 'Deals',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: Object.keys(steps)[0],
  steps,
});
const check = (steps: Record<string, unknown>) => validateAutomation(document(steps), setup);
const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => `${issue.path} ${issue.code}`);

describe('deal.find', () => {
  it('has the branches found and not_found, and gives the deal it found', () => {
    expect(automationBranchNames('deal.find', {})).toEqual(['found', 'not_found']);
    const listed = automationCatalog().steps.find((step) => step.type === 'deal.find');
    expect(listed).toMatchObject({
      group: 'records',
      label: 'Find opportunity',
      branches: { kind: 'fixed', names: ['found', 'not_found'] },
      outputs: [{ key: 'dealId', type: 'id' }],
    });
  });

  it('takes the newest unless told otherwise, and every filter is optional', () => {
    const parsed = automationDocument.parse(document({ find: { type: 'deal.find', config: {} } }));
    expect(parsed.steps['find']?.config).toEqual({ which: 'newest' });
    for (const config of [
      { which: 'oldest', status: 'won' },
      { status: 'any', nameContains: 'roof' },
      { value: { operator: 'greater_than', value: 1000 } },
      { customField: { field: 'deal.custom.service', equals: 'video' } },
    ])
      expect(
        automationDocument.safeParse(document({ find: { type: 'deal.find', config } })).success,
      ).toBe(true);
    for (const config of [
      { which: 'largest' },
      { status: 'closed' },
      { nameContains: '   ' },
      { value: { operator: 'at_least', value: 1 } },
      { value: { operator: 'equals', value: -1 } },
      { customField: { field: 'deal.custom.service' } },
      { owner: 'mem_amina' },
    ])
      expect(
        automationDocument.safeParse(document({ find: { type: 'deal.find', config } })).success,
      ).toBe(false);
  });

  it('refuses a branch it does not have', () => {
    expect(
      automationDocument.safeParse(
        document({ find: { type: 'deal.find', config: {}, next: { missing: 'find' } } }),
      ).success,
    ).toBe(false);
  });

  it('resolves the pipeline, the stage in it and the choice of a custom field', () => {
    const result = check({
      find: {
        type: 'deal.find',
        config: {
          pipeline: 'Sales',
          stage: 'Booked',
          customField: { field: 'deal.service', equals: 'Video' },
        },
        next: { found: 'move', not_found: 'open' },
      },
      move: { type: 'deal.move', config: { stage: 'stg_new' } },
      open: { type: 'deal.create', config: { pipeline: 'pip_sales', stage: 'stg_new' } },
    });
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['find']?.config).toEqual({
      which: 'newest',
      pipeline: 'pip_sales',
      stage: 'stg_won',
      customField: { field: 'deal.custom.service', equals: 'video' },
    });
  });

  it('points at a stage of another pipeline, and at a filter on what is not a deal field', () => {
    expect(
      codes(
        check({
          find: {
            type: 'deal.find',
            config: {
              pipeline: 'Renewals',
              stage: 'Booked',
              customField: { field: 'contact.custom.budget', equals: 5 },
            },
          },
        }),
      ),
    ).toEqual([
      '/steps/find/config/stage unknown_reference',
      '/steps/find/config/customField/field wrong_field',
    ]);
    expect(
      codes(
        check({
          find: {
            type: 'deal.find',
            config: { customField: { field: 'deal.custom.guests', equals: 'many' } },
          },
        }),
      ),
    ).toEqual(['/steps/find/config/customField/equals wrong_value_type']);
  });

  it('names its pipeline and stage again for another business', () => {
    const { document: portable } = portableAutomation(
      document({
        find: { type: 'deal.find', config: { pipeline: 'pip_sales', stage: 'stg_won' } },
      }),
      setup,
    );
    expect(portable['steps']).toMatchObject({
      find: { config: { pipeline: 'Sales', stage: 'Booked' } },
    });
  });
});

describe('deal.update', () => {
  const update = (config: unknown) => ({ update: { type: 'deal.update', config } });

  it('takes any of what a deal has, and can be retried', () => {
    for (const config of [
      { name: 'Renewal for {{contact.firstName}}' },
      { amount: 2500 },
      { amount: null },
      { amountFrom: 'contact.custom.budget' },
      { owner: 'mem_amina' },
      { owner: null },
      { expectedCloseDate: '2026-12-24' },
      { expectedCloseDate: { in: 'P30D' } },
      { expectedCloseDate: null },
      { source: 'Website form' },
      { status: 'open' },
      { fields: { 'deal.custom.service': 'video', 'deal.custom.guests': null } },
    ])
      expect(automationDocument.safeParse(document(update(config))).success).toBe(true);
    for (const config of [
      { amount: -1 },
      { status: 'won' },
      { expectedCloseDate: 'next week' },
      { expectedCloseDate: { in: '30 days' } },
      { stage: 'stg_won' },
      { name: '' },
    ])
      expect(automationDocument.safeParse(document(update(config))).success).toBe(false);
    expect(automationCatalog().failures.retryableSteps).toContain('deal.update');
    expect(automationStepTypes['deal.update'].outputs.map((output) => output.key)).toEqual([
      'dealId',
    ]);
  });

  it('resolves the owner, the field paths and their choices, and merge fields in its text', () => {
    const result = check(
      update({
        name: '{{deal.name}} for {{contact.firstName}}',
        source: 'From {{deal.pipeline}}',
        owner: 'Amina Odhiambo',
        amountFrom: 'contact.budget',
        fields: { 'deal.service': 'Video', 'deal.custom.guests': 120 },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['update']?.config).toEqual({
      name: '{{deal.name}} for {{contact.firstName}}',
      source: 'From {{deal.pipeline}}',
      owner: 'mem_amina',
      amountFrom: 'contact.custom.budget',
      fields: { 'deal.custom.service': 'video', 'deal.custom.guests': 120 },
    });
  });

  it('says what is wrong with a step that changes nothing, or changes it twice', () => {
    expect(codes(check(update({})))).toEqual(['/steps/update/config nothing_to_update']);
    expect(codes(check(update({ amount: 5, amountFrom: 'contact.custom.budget' })))).toEqual([
      '/steps/update/config/amountFrom amount_given_twice',
    ]);
    expect(
      codes(
        check(
          update({
            amountFrom: 'deal.custom.guests',
            owner: 'Nobody',
            expectedCloseDate: { in: 'P11Y' },
            source: 'From {{deal.nam}}',
            fields: {
              'deal.name': 'Not this way',
              'contact.custom.budget': 5,
              'deal.custom.guests': 'many',
              'deal.custom.colour': 'red',
            },
          }),
        ),
      ),
    ).toEqual([
      '/steps/update/config/owner unknown_reference',
      '/steps/update/config/amountFrom wrong_field',
      '/steps/update/config/expectedCloseDate/in date_too_far',
      '/steps/update/config/fields/deal.name wrong_field',
      '/steps/update/config/fields/contact.custom.budget wrong_field',
      '/steps/update/config/fields/deal.custom.guests wrong_value_type',
      '/steps/update/config/fields/deal.custom.colour unknown_field',
      '/steps/update/config/source unknown_merge_field',
    ]);
  });
});

describe('the paths of the deal in hand', () => {
  it('are known to conditions and merge fields, each with its kind', () => {
    const result = check({
      big: {
        type: 'condition',
        config: {
          if: {
            all: [
              { field: 'deal.value', operator: 'greater_than', value: 1000 },
              { field: 'deal.status', operator: 'equals', value: 'Won' },
              { field: 'deal.stage', operator: 'equals', value: 'Booked' },
              { field: 'deal.pipeline', operator: 'includes', value: 'Sales' },
              { field: 'deal.name', operator: 'is_set' },
              { field: 'deal.custom.service', operator: 'equals', value: 'Video' },
              { field: 'deal.source', operator: 'is_empty' },
            ],
          },
        },
        next: { yes: 'tell' },
      },
      tell: {
        type: 'task.create',
        config: { title: 'Call about {{deal.name}} ({{deal.value}}, {{deal.custom.service}})' },
      },
    });
    expect(result.errors).toEqual([]);
    const step = result.document?.steps['big'];
    expect(step?.type === 'condition' && 'if' in step.config ? step.config.if : null).toMatchObject(
      {
        all: [
          { field: 'deal.value' },
          // A choice given by its label is made its key.
          { field: 'deal.status', value: 'won' },
          { field: 'deal.stage' },
          { field: 'deal.pipeline' },
          { field: 'deal.name' },
          { field: 'deal.custom.service', value: 'video' },
          { field: 'deal.source' },
        ],
      },
    );
  });

  it('refuses a comparison that does not fit the path, and a path that is not one', () => {
    expect(
      codes(
        check({
          big: {
            type: 'condition',
            config: {
              if: {
                all: [
                  { field: 'deal.value', operator: 'greater_than', value: 'a lot' },
                  { field: 'deal.status', operator: 'equals', value: 'closed' },
                  { field: 'deal.valu', operator: 'is_set' },
                ],
              },
            },
          },
        }),
      ),
    ).toEqual([
      '/steps/big/config/if/all/0/value wrong_value_type',
      '/steps/big/config/if/all/1/value unknown_option',
      '/steps/big/config/if/all/2/field unknown_field',
    ]);
  });
});
