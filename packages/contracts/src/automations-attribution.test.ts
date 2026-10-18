// Attribution in workflows: the paths a document may read it by, the comparisons each kind
// takes, the trigger's filters by lead source, the source of an opportunity step, and the
// ready-made workflow. What each does when a run reads them is tested in
// packages/modules/automation.
import { describe, expect, it } from 'vitest';

import {
  arrivalSessionSources,
  attributionLeafAt,
  attributionLeaves,
  attributionPath,
  attributionPaths,
  attributionScopes,
  isAttributionPath,
} from './automations-attribution.js';
import { automationStepTypes, automationTriggerTypes } from './automations-catalog.js';
import { evaluateCondition } from './automations-evaluate.js';
import {
  leadSourceRecipe,
  leadSourceRecipeBranches,
  leadSourceRecipeSources,
  leadSourceRecipeTags,
} from './automations-recipes.js';
import { automationCatalog } from './automations.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';
import { leadSourceLabels, leadSources, leadSourceTagName } from './lead-sources.js';
import { attributionMediums, clickIdNames, sessionSources } from './reporting-attribution.js';

const setup: AutomationSetup = {
  fields: {
    contact: [
      { key: 'utm_source', aliases: [], type: 'text', options: [] },
      { key: 'first_seen', aliases: [], type: 'datetime', options: [] },
    ],
    deal: [],
  },
  forms: [{ id: 'form_enquiry', name: 'Enquiry' }],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [{ id: 'cal_visits', name: 'Visits' }],
  pipelines: [{ id: 'pip_sales', name: 'Sales', stages: [{ id: 'stg_new', name: 'New' }] }],
  lostReasons: [],
  tags: leadSourceRecipeTags().map((name, index) => ({ id: `tag_${String(index)}`, name })),
  users: [
    { id: 'mem_amina', name: 'Amina Odhiambo' },
    { id: 'mem_brian', name: 'Brian Otieno' },
  ],
  automations: [],
  values: [],
  channels: { email: true, sms: true, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const form = { id: 'sent', type: 'form.submitted', config: { form: 'Enquiry' } };

const document = (steps: Record<string, unknown>, triggers: readonly unknown[] = [form]) => ({
  name: 'Leads',
  triggers,
  start: Object.keys(steps)[0],
  steps,
});

const branch = (condition: unknown) => ({
  check: { type: 'condition', config: { if: condition }, next: { yes: 'tagged' } },
  tagged: { type: 'tag.add', config: { tag: leadSourceRecipeTags()[0] } },
});

const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => [issue.path, issue.code]);

describe('the attribution paths', () => {
  it('names every leaf under each of the three touches', () => {
    expect(attributionPaths).toHaveLength(attributionScopes.length * attributionLeaves.length);
    expect(attributionPath('first', 'source')).toBe('contact.attribution.first.source');
    expect(attributionPath('latest', 'utmCampaign')).toBe('contact.attribution.latest.utmCampaign');
    expect(attributionPath('trigger', 'sessionSource')).toBe('trigger.attribution.sessionSource');
    for (const path of attributionPaths) {
      expect(isAttributionPath(path), path).toBe(true);
      expect(attributionLeafAt(path), path).toBeDefined();
    }
  });

  it('reads no click id as a value: only whether one is held', () => {
    const keys = attributionLeaves.map((leaf) => leaf.key as string);
    for (const id of clickIdNames) {
      expect(keys).not.toContain(id);
      // As the contact's page names them (ctwaClid, liFatId).
      expect(keys).not.toContain(
        id.replaceAll(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase()),
      );
    }
    expect(
      attributionLeaves.filter((leaf) => leaf.type === 'boolean').map((leaf) => leaf.key),
    ).toEqual([
      'hasGoogleClickId',
      'hasMetaClickId',
      'hasMicrosoftClickId',
      'hasTikTokClickId',
      'hasLinkedInClickId',
    ]);
  });

  it('knows a path that names no leaf from one that is not attribution at all', () => {
    expect(attributionLeafAt('trigger.attribution.nothing')).toBeUndefined();
    expect(isAttributionPath('trigger.attribution.nothing')).toBe(true);
    expect(attributionLeafAt('contact.firstName')).toBeUndefined();
    expect(isAttributionPath('contact.firstName')).toBe(false);
    expect(isAttributionPath('contact.attribution')).toBe(false);
  });

  it('is published in the catalog, with the triggers whose runs have a touch', () => {
    const { attribution } = automationCatalog();
    expect(attribution.prefixes).toEqual({
      first: 'contact.attribution.first',
      latest: 'contact.attribution.latest',
      trigger: 'trigger.attribution',
    });
    expect(attribution.leaves.map((leaf) => leaf.key)).toEqual(
      attributionLeaves.map((leaf) => leaf.key),
    );
    expect(attribution.triggers).toEqual(['form.submitted', 'appointment.booked']);
    for (const leaf of attribution.leaves) {
      expect(leaf.label, leaf.key).toMatch(/\S/);
      expect(leaf.description, leaf.key).toMatch(/\S/);
    }
    // The lists written out here are reporting's own, key for key and in its order.
    expect(arrivalSessionSources).toEqual(sessionSources);
    expect(
      attributionLeaves.find((leaf) => leaf.key === 'medium')?.options.map((each) => each.key),
    ).toEqual(attributionMediums);
  });
});

describe('conditions on attribution', () => {
  it('accepts every path in a condition, a trigger filter, a wait and a stop', () => {
    for (const path of attributionPaths) {
      const result = validateAutomation(
        {
          ...document({
            check: {
              type: 'condition',
              config: { if: { field: path, operator: 'is_set' } },
              next: { yes: 'hold' },
            },
            hold: {
              type: 'wait.condition',
              config: { if: { field: path, operator: 'is_empty' }, timeout: 'P1D' },
            },
          }),
          triggers: [{ ...form, if: { field: path, operator: 'is_set' } }],
          stopWhen: [{ event: 'tag.added', if: { field: path, operator: 'is_empty' } }],
        },
        setup,
      );
      expect(result.errors, path).toEqual([]);
    }
  });

  it('takes is, is not, contains, starts with and is empty on text', () => {
    const path = attributionPath('trigger', 'utmCampaign');
    for (const operator of ['equals', 'not_equals', 'includes', 'excludes', 'starts_with'])
      expect(
        validateAutomation(document(branch({ field: path, operator, value: 'spring' })), setup)
          .errors,
        operator,
      ).toEqual([]);
    expect(
      codes(
        validateAutomation(
          document(branch({ field: path, operator: 'before', value: '2026-01-01' })),
          setup,
        ),
      ),
    ).toEqual([['/steps/check/config/if/operator', 'wrong_operator']]);
  });

  it('takes a session source by its key or by what people read, and keeps the key', () => {
    const path = attributionPath('trigger', 'sessionSource');
    const byLabel = validateAutomation(
      document(branch({ field: path, operator: 'equals', value: 'Paid search' })),
      setup,
    );
    expect(byLabel.errors).toEqual([]);
    expect(byLabel.document?.steps['check']?.config).toEqual({
      if: { field: path, operator: 'equals', value: 'paid_search' },
    });
    const unknown = validateAutomation(
      document(branch({ field: path, operator: 'equals', value: 'Paid serch' })),
      setup,
    );
    expect(unknown.errors).toEqual([
      {
        path: '/steps/check/config/if/value',
        code: 'unknown_option',
        message: `"Paid serch" is not an option of ${path}.`,
        suggestion: 'Did you mean Paid search?',
      },
    ]);
    // A choice is one of its choices or not: it does not contain or start with text.
    for (const operator of ['includes', 'starts_with'])
      expect(
        codes(
          validateAutomation(document(branch({ field: path, operator, value: 'paid' })), setup),
        ),
        operator,
      ).toEqual([['/steps/check/config/if/operator', 'wrong_operator']]);
  });

  it('compares "has a click id" with yes or no only', () => {
    const path = attributionPath('latest', 'hasGoogleClickId');
    expect(
      validateAutomation(document(branch({ field: path, operator: 'equals', value: true })), setup)
        .errors,
    ).toEqual([]);
    expect(
      codes(
        validateAutomation(
          document(branch({ field: path, operator: 'equals', value: 'yes' })),
          setup,
        ),
      ),
    ).toEqual([['/steps/check/config/if/value', 'wrong_value_type']]);
    expect(
      codes(
        validateAutomation(
          document(branch({ field: path, operator: 'starts_with', value: 'y' })),
          setup,
        ),
      ),
    ).toEqual([['/steps/check/config/if/operator', 'wrong_operator']]);
  });

  it('compares the date of a touch as a date', () => {
    const path = attributionPath('first', 'touchedAt');
    expect(
      validateAutomation(
        document(branch({ field: path, operator: 'within_last', value: 'P30D' })),
        setup,
      ).errors,
    ).toEqual([]);
  });

  it('points at a leaf that does not exist, with the closest one', () => {
    const result = validateAutomation(
      document(branch({ field: 'trigger.attribution.utmCampain', operator: 'is_set' })),
      setup,
    );
    expect(result.errors).toEqual([
      {
        path: '/steps/check/config/if/field',
        code: 'unknown_field',
        message: 'trigger.attribution.utmCampain is not something attribution keeps.',
        suggestion: 'Did you mean trigger.attribution.utmCampaign?',
      },
    ]);
    // A click id is not a leaf, whatever the touch.
    expect(
      codes(
        validateAutomation(
          document(branch({ field: 'contact.attribution.first.gclid', operator: 'is_set' })),
          setup,
        ),
      ),
    ).toEqual([['/steps/check/config/if/field', 'unknown_field']]);
    expect(
      validateAutomation(
        document(branch({ field: 'trigger.submissionId', operator: 'is_set' })),
        setup,
      ).errors[0]?.message,
    ).toBe(
      'trigger.submissionId is not a field: fields start with contact., deal., appointment., trigger.attribution. or trigger.answers., or are trigger.pageUrl.',
    );
  });

  it('warns when nothing that starts the workflow comes with a touch', () => {
    const condition = { field: attributionPath('trigger', 'source'), operator: 'is_set' };
    const tagged = { id: 'tagged', type: 'tag.added', config: { tag: leadSourceRecipeTags()[0] } };
    const without = validateAutomation(document(branch(condition), [tagged]), setup);
    expect(without.errors).toEqual([]);
    expect(without.warnings).toEqual([
      expect.objectContaining({ path: '/steps/check/config/if/field', code: 'no_arrival' }),
    ]);
    const booked = { id: 'booked', type: 'appointment.booked', config: {} };
    expect(
      validateAutomation(document(branch(condition), [tagged, booked]), setup).warnings,
    ).toEqual([]);
    // The contact's own touches need no such trigger.
    expect(
      validateAutomation(
        document(branch({ field: attributionPath('first', 'source'), operator: 'is_set' }), [
          tagged,
        ]),
        setup,
      ).warnings,
    ).toEqual([]);
  });

  it('starts-with compares text only, whatever its capitals', () => {
    const now = new Date('2026-10-13T00:00:00Z');
    const starts = (actual: unknown, value: string) =>
      evaluateCondition(
        { field: 'x.y', operator: 'starts_with', value },
        { 'x.y': actual as string },
        now,
      );
    expect(starts('https://example.com/Promo/spring', 'https://example.com/promo')).toBe(true);
    expect(starts('  Spring sale', 'spring')).toBe(true);
    expect(starts('summer', 'spring')).toBe(false);
    expect(starts(null, 'spring')).toBe(false);
    expect(starts(undefined, 'spring')).toBe(false);
    expect(starts(['spring'], 'spring')).toBe(false);
    expect(starts(12, '1')).toBe(false);
  });
});

describe('merge fields and writes', () => {
  it('fills attribution into text, and names a path that does not exist', () => {
    const text = (message: string) =>
      validateAutomation(
        document({ say: { type: 'team.notify', config: { message, to: 'everyone' } } }),
        setup,
      );
    expect(
      text(
        'New lead from {{trigger.attribution.source}} ({{contact.attribution.first.utmCampaign}}, {{contact.attribution.latest.sessionSource}})',
      ).errors,
    ).toEqual([]);
    expect(text('From {{trigger.attribution.sorce}}').errors).toEqual([
      {
        path: '/steps/say/config/message',
        code: 'unknown_merge_field',
        message: 'trigger.attribution.sorce is not a field.',
        suggestion: 'Did you mean trigger.attribution.source?',
      },
    ]);
    expect(text('Click {{contact.attribution.latest.gclid}}').errors[0]?.code).toBe(
      'unknown_merge_field',
    );
    // What the triggers give is still checked as it was.
    expect(text('Sent as {{trigger.submissionId}}').errors).toEqual([]);
  });

  it('copies attribution into a contact field, and never writes it', () => {
    const copied = validateAutomation(
      document({
        keep: {
          type: 'contact.update',
          config: {
            fields: {
              'contact.custom.utm_source': '{{trigger.attribution.utmSource}}',
              'contact.custom.first_seen': {
                op: 'date_add',
                field: 'contact.attribution.first.touchedAt',
                days: 0,
              },
            },
          },
        },
      }),
      setup,
    );
    expect(copied.errors).toEqual([]);
    const written = validateAutomation(
      document({
        keep: {
          type: 'contact.update',
          config: { fields: { 'contact.attribution.first.source': 'Mine' } },
        },
      }),
      setup,
    );
    expect(codes(written)).toEqual([
      ['/steps/keep/config/fields/contact.attribution.first.source', 'read_only_field'],
    ]);
  });

  it('refuses attribution where a field is watched for a change or a date', () => {
    const watching = (trigger: unknown) =>
      codes(
        validateAutomation(
          document({ tagged: { type: 'tag.add', config: { tag: leadSourceRecipeTags()[0] } } }, [
            trigger,
          ]),
          setup,
        ),
      );
    expect(
      watching({
        id: 'changed',
        type: 'field.changed',
        config: { field: 'contact.attribution.latest.source' },
      }),
    ).toEqual([['/triggers/0/config/field', 'wrong_field']]);
    expect(
      watching({
        id: 'dated',
        type: 'date.reached',
        config: { field: 'contact.attribution.first.touchedAt', repeat: 'never' },
      }),
    ).toEqual([['/triggers/0/config/field', 'wrong_field']]);
    expect(
      codes(
        validateAutomation(
          document({
            met: {
              type: 'goal',
              config: {
                events: [
                  {
                    type: 'field.changed',
                    config: { field: 'contact.attribution.latest.source' },
                  },
                ],
              },
            },
          }),
          setup,
        ),
      ),
    ).toEqual([['/steps/met/config/events/0/config/field', 'wrong_field']]);
  });
});

describe('the triggers that come with a touch', () => {
  it('start on any form, and filter by lead source and session source', () => {
    const { config } = automationTriggerTypes['form.submitted'];
    expect(config.safeParse({}).success).toBe(true);
    expect(
      config.safeParse({
        form: 'Enquiry',
        sources: ['Google Ads', 'Facebook Ads'],
        sessionSources: ['paid_search', 'paid_social'],
      }).success,
    ).toBe(true);
    expect(config.safeParse({ sources: [] }).success).toBe(false);
    expect(config.safeParse({ sources: [''] }).success).toBe(false);
    expect(config.safeParse({ sessionSources: ['paid'] }).success).toBe(false);
    expect(
      automationTriggerTypes['appointment.booked'].config.safeParse({ sources: ['Google Ads'] })
        .success,
    ).toBe(true);
    const result = validateAutomation(
      document({ tagged: { type: 'tag.add', config: { tag: leadSourceRecipeTags()[0] } } }, [
        { id: 'any', type: 'form.submitted', config: { sources: ['Google Ads'] } },
        { id: 'booked', type: 'appointment.booked', config: { sessionSources: ['paid_search'] } },
      ]),
      setup,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.triggers.map((trigger) => trigger.config)).toEqual([
      { sources: ['Google Ads'] },
      { sessionSources: ['paid_search'] },
    ]);
  });
});

describe('the source of an opportunity step', () => {
  const create = (source: unknown) =>
    validateAutomation(
      document({
        open: {
          type: 'deal.create',
          config: { pipeline: 'Sales', stage: 'New', ...(source === undefined ? {} : { source }) },
        },
      }),
      setup,
    );

  it('is how the lead arrived, text with merge fields, or none', () => {
    expect(automationStepTypes['deal.create'].version).toBe(2);
    for (const source of [undefined, { from: 'arrival' }, null, 'Website', '{{contact.source}}']) {
      const result = create(source);
      expect(result.errors, JSON.stringify(source)).toEqual([]);
      expect(result.document?.steps['open']?.typeVersion).toBe(2);
    }
    expect(create('{{trigger.attribution.source}}').errors).toEqual([]);
    expect(codes(create('{{trigger.attribution.sorce}}'))).toEqual([
      ['/steps/open/config/source', 'unknown_merge_field'],
    ]);
    expect(create({ from: 'elsewhere' }).valid).toBe(false);
    expect(create('').valid).toBe(false);
  });

  it('is the same choice on an update', () => {
    const update = (source: unknown) =>
      validateAutomation(
        document({
          open: { type: 'deal.create', config: { pipeline: 'Sales', stage: 'New' }, next: 'fix' },
          fix: { type: 'deal.update', config: { source } },
        }),
        setup,
      );
    for (const source of [{ from: 'arrival' }, null, 'Referral', '{{contact.source}}'])
      expect(update(source).errors, JSON.stringify(source)).toEqual([]);
    expect(update({ from: 'somewhere' }).valid).toBe(false);
  });
});

describe('the recipe "Tag and route leads by source"', () => {
  it('is a valid document in a business that has the pipeline, the tags and the people', () => {
    const result = validateAutomation(
      leadSourceRecipe({ pipeline: 'Sales', stage: 'New', owners: ['mem_amina', 'mem_brian'] }),
      setup,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    const steps = result.document?.steps ?? {};
    expect(Object.keys(steps)).toEqual([
      'by_source',
      ...leadSourceRecipeBranches.map((each) => `tag_${each.name}`),
      'assign_owner',
      'create_opportunity',
    ]);
    expect(steps['by_source']?.next).toEqual({
      google_ads: 'tag_google_ads',
      facebook_ads: 'tag_facebook_ads',
      instagram_ads: 'tag_instagram_ads',
      organic_search: 'tag_organic_search',
      // Everything else gets no tag of the workflow's: it is many sources, not one.
      none: 'assign_owner',
    });
    expect(steps['assign_owner']?.config).toEqual({
      users: ['mem_amina', 'mem_brian'],
      onlyIfUnassigned: true,
    });
    expect(steps['create_opportunity']?.config).toEqual({
      pipeline: 'pip_sales',
      stage: 'stg_new',
      source: { from: 'arrival' },
    });
    expect(result.document?.triggers).toEqual([
      { id: 'form_submitted', type: 'form.submitted', config: {} },
    ]);
  });

  it('gives one person every lead, or leaves the owner step out', () => {
    const one = validateAutomation(
      leadSourceRecipe({ pipeline: 'Sales', stage: 'New', owners: ['Amina Odhiambo'] }),
      setup,
    );
    expect(one.errors).toEqual([]);
    expect(one.document?.steps['assign_owner']?.config).toEqual({
      user: 'mem_amina',
      onlyIfUnassigned: true,
    });
    const none = validateAutomation(
      leadSourceRecipe({ name: 'Mine', pipeline: 'Sales', stage: 'New' }),
      setup,
    );
    expect(none.errors).toEqual([]);
    expect(none.document?.name).toBe('Mine');
    expect(none.document?.steps['assign_owner']).toBeUndefined();
    expect(none.document?.steps['tag_other']).toBeUndefined();
    expect(none.document?.steps['by_source']?.next).toMatchObject({ none: 'create_opportunity' });
    expect(none.document?.steps['tag_google_ads']?.next).toBe('create_opportunity');
  });

  it('adds the business’s own tag of each lead source when it is told their ids', () => {
    // The ids ensureLeadSourceTags answers: a tag a person renamed is still the one added.
    const renamed = {
      ...setup,
      tags: [
        { id: 'tag_g', name: 'Paid Google' },
        { id: 'tag_f', name: 'Source: Facebook Ads' },
        { id: 'tag_i', name: 'Source: Instagram Ads' },
        { id: 'tag_o', name: 'Source: Organic Search' },
      ],
    };
    const tags = {
      google_ads: 'tag_g',
      facebook_ads: 'tag_f',
      instagram_ads: 'tag_i',
      organic_search: 'tag_o',
    };
    const byId = validateAutomation(
      leadSourceRecipe({ pipeline: 'Sales', stage: 'New', tags }),
      renamed,
    );
    expect(byId.errors).toEqual([]);
    expect(
      leadSourceRecipeBranches.map((each) => byId.document?.steps[`tag_${each.name}`]?.config),
    ).toEqual([{ tag: 'tag_g' }, { tag: 'tag_f' }, { tag: 'tag_i' }, { tag: 'tag_o' }]);
    // By name it would not find the renamed one.
    const byName = validateAutomation(
      leadSourceRecipe({ pipeline: 'Sales', stage: 'New' }),
      renamed,
    );
    expect(byName.errors.map((issue) => issue.code)).toEqual(['unknown_reference']);
    expect(leadSourceRecipeSources()).toEqual(Object.keys(tags));
  });

  it('names the tags it needs, and says which the business lacks', () => {
    expect(leadSourceRecipeTags()).toEqual([
      'Source: Google Ads',
      'Source: Facebook Ads',
      'Source: Instagram Ads',
      'Source: Organic Search',
    ]);
    // The same tags the intake makes for a form that tags by source, and no tag for
    // "everything else": a direct lead is "Source: Direct" by its form, never "Source: Other".
    expect(leadSourceRecipeTags()).toEqual(
      leadSourceRecipeBranches.map((each) => leadSourceTagName(each.source)),
    );
    expect(leadSourceRecipeTags()).not.toContain(leadSourceTagName(leadSourceLabels.other));
    for (const each of leadSourceRecipeBranches)
      expect(leadSources.find((known) => known.key === each.name)?.label).toBe(each.source);
    const lacking = validateAutomation(leadSourceRecipe({ pipeline: 'Sales', stage: 'New' }), {
      ...setup,
      tags: [],
    });
    expect(lacking.valid).toBe(false);
    expect(new Set(lacking.errors.map((issue) => issue.code))).toEqual(
      new Set(['unknown_reference']),
    );
    expect(lacking.errors).toHaveLength(4);
  });
});
