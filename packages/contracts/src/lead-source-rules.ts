// The business's own lead source rules:
// Settings → Lead Sources. A rule is conditions that must all hold and what to do when they
// do: name the lead's Source, add tags, fill a text custom field of the contact.
//
// - The business's rules are tried before the built-in ones, top to bottom. The first
//   matching rule that names a Source decides it; the tags and the field values of EVERY
//   matching rule are applied. When no rule names a Source, the built-in rules do.
// - A condition reads one fact of the visit out of a fixed vocabulary (leadSourceFacts), or
//   any parameter of the address by its name. Text is compared without regard to case.
// - At most 50 rules a business and 5 conditions a rule, so a lead is named from one read
//   of at most 50 small rows, inside the transaction that stores it, with no network.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { LEAD_SOURCE_LIMITS, leadSourceKeys, leadSourceLabels } from './lead-sources.js';
import { timestamp } from './timestamps.js';

export const LEAD_SOURCE_RULE_LIMITS = {
  /** Rules one business may have. */
  rules: 50,
  /** Conditions one rule may have; it has at least one. */
  conditions: 5,
  /** Characters in a rule's name. */
  nameLength: 80,
  /** Characters in a value a condition compares with, as in a value read from an address. */
  valueLength: 200,
  /** Values an "is one of" condition lists. */
  listValues: 20,
  /** Tags one rule adds. One lead still gets at most LEAD_SOURCE_LIMITS.tagsPerSubmission. */
  tags: 5,
  /** Custom fields one rule fills. */
  fieldWrites: 3,
  /** Custom fields one lead has filled by rules, every matching rule together. */
  fieldWritesPerLead: 10,
} as const;

/** The kinds of interaction that take a lead on a page: what `medium` can be. */
export const leadSourceRuleMediums = ['form', 'calendar', 'chat'] as const;

/** The channels a visit to a page can have (the session sources of web touches). */
export const leadSourceRuleSessionSources = [
  'paid_search',
  'paid_social',
  'social_media',
  'organic_search',
  'referral',
  'direct',
  'others',
] as const;

/**
 * How a fact is compared:
 * - `choice`: one of a closed list (`choices`);
 * - `text`: whatever the address or the browser said, or nothing;
 * - `presence`: only whether it is there (a click id: its value is never compared or shown);
 * - `parameter`: any parameter of the address, named by the condition (`name`).
 */
export type LeadSourceFactKind = 'choice' | 'text' | 'presence' | 'parameter';

interface FactInfo {
  readonly kind: LeadSourceFactKind;
  /** What a screen calls it. */
  readonly label: string;
  /** What it is, in a sentence. */
  readonly description: string;
  readonly choices?: readonly string[];
}

/**
 * Everything a condition can read, in the order a list of choices offers it. The keys are
 * what a stored rule holds and never change.
 */
export const leadSourceFacts = {
  lead_source: {
    kind: 'choice',
    label: 'Lead source (built-in)',
    description:
      'What the built-in rules call this visit, such as Google Ads or Organic Search: the same whatever your own rules say.',
    choices: leadSourceKeys,
  },
  session_source: {
    kind: 'choice',
    label: 'Session source',
    description: 'The channel of the visit: paid search, paid social, organic search and so on.',
    choices: leadSourceRuleSessionSources,
  },
  medium: {
    kind: 'choice',
    label: 'Taken by',
    description: 'What took the lead: a form, a booking page or a web chat.',
    choices: leadSourceRuleMediums,
  },
  utm_source: { kind: 'text', label: 'UTM source', description: 'utm_source in the address.' },
  utm_medium: { kind: 'text', label: 'UTM medium', description: 'utm_medium in the address.' },
  utm_campaign: {
    kind: 'text',
    label: 'UTM campaign',
    description: 'utm_campaign in the address.',
  },
  utm_content: { kind: 'text', label: 'UTM content', description: 'utm_content in the address.' },
  utm_term: {
    kind: 'text',
    label: 'UTM term',
    description: 'utm_term (or utm_keyword) in the address.',
  },
  match_type: {
    kind: 'text',
    label: 'Match type',
    description: 'matchtype (or utm_matchtype) in the address.',
  },
  campaign_id: {
    kind: 'text',
    label: 'Campaign ID',
    description: 'campaign_id (or utm_id) in the address.',
  },
  ad_group_id: {
    kind: 'text',
    label: 'Ad group ID',
    description: 'ad_group_id, adgroup_id or adset_id in the address.',
  },
  ad_id: { kind: 'text', label: 'Ad ID', description: 'ad_id in the address.' },
  click_id_google: {
    kind: 'presence',
    label: 'Google click ID',
    description: 'The address carries gclid, gbraid or wbraid.',
  },
  click_id_meta: {
    kind: 'presence',
    label: 'Meta click ID',
    description: 'The address carries fbclid or ctwa_clid (Facebook, Instagram, WhatsApp).',
  },
  click_id_microsoft: {
    kind: 'presence',
    label: 'Microsoft click ID',
    description: 'The address carries msclkid.',
  },
  click_id_tiktok: {
    kind: 'presence',
    label: 'TikTok click ID',
    description: 'The address carries ttclid.',
  },
  click_id_linkedin: {
    kind: 'presence',
    label: 'LinkedIn click ID',
    description: 'The address carries li_fat_id.',
  },
  referrer_domain: {
    kind: 'text',
    label: 'Referrer domain',
    description: 'The site the visitor came from, such as www.google.com. Never its path.',
  },
  landing_page: {
    kind: 'text',
    label: 'Landing page',
    description: 'The page the visit began on, without its query: https://www.example.com/offer.',
  },
  form_page: {
    kind: 'text',
    label: 'Form page',
    description:
      'The page the lead was taken on (the page of the form or the booking), without its query.',
  },
  site: {
    kind: 'text',
    label: 'Site',
    description:
      'The website of the page the lead was taken on: its host, such as www.example.com.',
  },
  step: {
    kind: 'text',
    label: 'Step (page path)',
    description:
      'The path of the page the lead was taken on, such as /offer/step-2: a funnel’s step.',
  },
  parameter: {
    kind: 'parameter',
    label: 'Address parameter',
    description:
      'Any parameter of the address the visit is read from, by its name: promo for ?promo=spring.',
  },
} as const satisfies Readonly<Record<string, FactInfo>>;
export type LeadSourceFact = keyof typeof leadSourceFacts;
export const leadSourceFactNames = Object.keys(leadSourceFacts) as [
  LeadSourceFact,
  ...LeadSourceFact[],
];

export const leadSourceOperators = [
  'is',
  'is_not',
  'contains',
  'starts_with',
  'is_empty',
  'is_not_empty',
  'is_one_of',
] as const;
export type LeadSourceOperator = (typeof leadSourceOperators)[number];

/** What a screen calls each operator. */
export const leadSourceOperatorLabels = {
  is: 'is',
  is_not: 'is not',
  contains: 'contains',
  starts_with: 'starts with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  is_one_of: 'is one of',
} as const satisfies Readonly<Record<LeadSourceOperator, string>>;

const TEXT_OPERATORS: readonly LeadSourceOperator[] = leadSourceOperators;

/** The operators each kind of fact takes. */
export const leadSourceOperatorsByKind = {
  choice: ['is', 'is_not', 'is_one_of'],
  text: TEXT_OPERATORS,
  presence: ['is_not_empty', 'is_empty'],
  parameter: TEXT_OPERATORS,
} as const satisfies Readonly<Record<LeadSourceFactKind, readonly LeadSourceOperator[]>>;

/** The operators a fact takes. */
export const leadSourceOperatorsOf = (fact: LeadSourceFact): readonly LeadSourceOperator[] =>
  leadSourceOperatorsByKind[leadSourceFacts[fact].kind];

/** What each operator is given: one value, a list of values, or nothing. */
export const leadSourceOperatorOperand = {
  is: 'value',
  is_not: 'value',
  contains: 'value',
  starts_with: 'value',
  is_empty: 'none',
  is_not_empty: 'none',
  is_one_of: 'values',
} as const satisfies Readonly<Record<LeadSourceOperator, 'value' | 'values' | 'none'>>;

const ONE_LINE = /^\P{Cc}*$/u;
const compared = z
  .string()
  .trim()
  .min(1, { error: 'Enter a value.' })
  .max(LEAD_SOURCE_RULE_LIMITS.valueLength, { error: 'Use at most 200 characters.' })
  .regex(ONE_LINE, { error: 'Use one line.' });

/** The name of a parameter of an address, as a form's hidden question names one. */
const parameterName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,59}$/, {
  error: 'Use a letter, then up to 59 letters, numbers, dots, dashes or underscores.',
});

/**
 * One condition: a fact, how it is compared, and what with. `value` goes with is, is not,
 * contains and starts with; `values` with is one of; neither with is empty and is not
 * empty. `name` is the parameter's name, for the fact `parameter` and no other.
 */
export const leadSourceCondition = z
  .strictObject({
    fact: z.enum(leadSourceFactNames),
    name: parameterName.optional(),
    op: z.enum(leadSourceOperators),
    value: compared.optional(),
    values: z
      .array(compared)
      .min(1, { error: 'List at least one value.' })
      .max(LEAD_SOURCE_RULE_LIMITS.listValues, { error: 'List at most 20 values.' })
      .optional(),
  })
  .superRefine((condition, context) => {
    const refuse = (path: string, code: string, message: string): void => {
      context.addIssue({ code: 'custom', path: [path], message, params: { code } });
    };
    const info: FactInfo = leadSourceFacts[condition.fact];
    if ((info.kind === 'parameter') !== (condition.name !== undefined))
      refuse(
        'name',
        info.kind === 'parameter' ? 'required' : 'unexpected_name',
        info.kind === 'parameter'
          ? 'Name the parameter of the address to read.'
          : 'Only an address parameter has a name.',
      );
    if (!leadSourceOperatorsOf(condition.fact).includes(condition.op)) {
      refuse('op', 'unsupported_operator', `${info.label} cannot be compared this way.`);
      return;
    }
    const operand = leadSourceOperatorOperand[condition.op];
    if ((operand === 'value') !== (condition.value !== undefined))
      refuse(
        'value',
        operand === 'value' ? 'required' : 'unexpected_value',
        operand === 'value' ? 'Enter a value.' : 'This comparison takes no single value.',
      );
    if ((operand === 'values') !== (condition.values !== undefined))
      refuse(
        'values',
        operand === 'values' ? 'required' : 'unexpected_values',
        operand === 'values' ? 'List at least one value.' : 'This comparison takes no list.',
      );
    if (info.choices !== undefined) {
      const given = [
        ...(condition.values ?? []),
        ...(condition.value === undefined ? [] : [condition.value]),
      ];
      const { choices } = info;
      if (given.some((value) => !choices.includes(value)))
        refuse(
          condition.values === undefined ? 'value' : 'values',
          'unknown_choice',
          `Choose from: ${choices.join(', ')}.`,
        );
    }
  })
  .meta({ id: 'LeadSourceCondition' });
export type LeadSourceCondition = z.output<typeof leadSourceCondition>;

const folded = (text: string): string => text.trim().toLowerCase();

/**
 * Whether a condition holds for the value its fact has in a visit: `null` when the visit
 * did not say it. Text is compared trimmed and without regard to case. "Is not" holds for
 * a visit that did not say the fact at all, as "is not Google" should for a direct visit.
 * One function for the intake and for "Check a link".
 */
export function matchesLeadSourceCondition(
  condition: Pick<LeadSourceCondition, 'op' | 'value' | 'values'>,
  actual: string | null,
): boolean {
  const said = actual === null ? '' : folded(actual);
  const wanted = folded(condition.value ?? '');
  switch (condition.op) {
    case 'is':
      return said !== '' && said === wanted;
    case 'is_not':
      return said !== wanted;
    case 'contains':
      return said !== '' && said.includes(wanted);
    case 'starts_with':
      return said !== '' && said.startsWith(wanted);
    case 'is_empty':
      return said === '';
    case 'is_not_empty':
      return said !== '';
    case 'is_one_of':
      return said !== '' && (condition.values ?? []).some((value) => folded(value) === said);
  }
}

const ruleName = z
  .string()
  .trim()
  .min(1, { error: 'Give the rule a name.' })
  .max(LEAD_SOURCE_RULE_LIMITS.nameLength, { error: 'Use at most 80 characters.' })
  .regex(ONE_LINE, { error: 'Use one line.' });

const sourceName = z
  .string()
  .trim()
  .min(1, { error: 'Enter the Source, or leave it out.' })
  .max(LEAD_SOURCE_LIMITS.labelLength, { error: 'Use at most 200 characters.' })
  .regex(ONE_LINE, { error: 'Use one line.' });

const conditions = z
  .array(leadSourceCondition)
  .min(1, { error: 'Add at least one condition.' })
  .max(LEAD_SOURCE_RULE_LIMITS.conditions, { error: 'Add at most 5 conditions.' });

const distinct = <T>(items: readonly T[], key: (item: T) => string): boolean =>
  new Set(items.map(key)).size === items.length;

const tagIds = z
  .array(publicId('tag'))
  .max(LEAD_SOURCE_RULE_LIMITS.tags, { error: 'Add at most 5 tags.' })
  .refine((ids) => distinct(ids, (id) => id), { error: 'List each tag once.' });

export const leadSourceFieldWrite = z
  .strictObject({
    fieldId: publicId('field').meta({
      description: 'A text custom field of contacts (text or long text).',
    }),
    value: z
      .string()
      .trim()
      .min(1, { error: 'Enter the text to write.' })
      .max(LEAD_SOURCE_RULE_LIMITS.valueLength, { error: 'Use at most 200 characters.' })
      .regex(ONE_LINE, { error: 'Use one line.' }),
  })
  .meta({ id: 'LeadSourceFieldWrite' });
export type LeadSourceFieldWrite = z.output<typeof leadSourceFieldWrite>;

const fieldWrites = z
  .array(leadSourceFieldWrite)
  .max(LEAD_SOURCE_RULE_LIMITS.fieldWrites, { error: 'Fill at most 3 fields.' })
  .refine((writes) => distinct(writes, (write) => write.fieldId), {
    error: 'Fill each field once.',
  });

/** What a rule holds, as it is written: everything a save sends. */
const ruleDocument = {
  name: ruleName,
  enabled: z.boolean().meta({ description: 'A rule switched off is kept and never tried.' }),
  conditions: conditions.meta({ description: 'Every one must hold.' }),
  source: sourceName.nullable().meta({
    description:
      'The Source this rule gives the lead, such as "Spring promo". Null: the rule names none, and only adds its tags and field values.',
    examples: ['Spring promo'],
  }),
  tagIds: tagIds.meta({ description: 'Existing tags to add to the contact.' }),
  fieldWrites: fieldWrites.meta({ description: 'Text custom fields of the contact to fill.' }),
};

const acts = (rule: {
  readonly source: string | null;
  readonly tagIds: readonly string[];
  readonly fieldWrites: readonly unknown[];
}): boolean => rule.source !== null || rule.tagIds.length > 0 || rule.fieldWrites.length > 0;
const NO_ACTION = {
  path: ['source'],
  error: 'Say what the rule does: name the Source, add a tag or fill a field.',
};

export const createLeadSourceRuleInput = z
  .strictObject({
    ...ruleDocument,
    enabled: ruleDocument.enabled.default(true),
    source: ruleDocument.source.default(null),
    tagIds: ruleDocument.tagIds.default([]),
    fieldWrites: ruleDocument.fieldWrites.default([]),
  })
  .refine(acts, NO_ACTION)
  .meta({
    id: 'CreateLeadSourceRuleInput',
    description: 'A new rule. It is added last: after every rule the business already has.',
  });
export type CreateLeadSourceRuleInput = z.output<typeof createLeadSourceRuleInput>;

export const updateLeadSourceRuleInput = z
  .strictObject({
    ...ruleDocument,
    revision: z.int().min(1).meta({ description: 'The revision the rule was read at.' }),
  })
  .refine(acts, NO_ACTION)
  .meta({
    id: 'UpdateLeadSourceRuleInput',
    description:
      'The whole rule, with the revision it was read at. Its place in the order is not part of it. A stale revision returns 409 and changes nothing.',
  });
export type UpdateLeadSourceRuleInput = z.output<typeof updateLeadSourceRuleInput>;

export const leadSourceRuleProblemCodes = [
  /** A tag the rule adds was deleted: it is skipped. */
  'tag_missing',
  /** A field the rule fills is gone, archived or no longer a text field of contacts: skipped. */
  'field_unavailable',
] as const;

export const leadSourceRule = z
  .looseObject({
    id: publicId('lead_source_rule'),
    position: z
      .int()
      .min(1)
      .max(LEAD_SOURCE_RULE_LIMITS.rules)
      .meta({ description: 'Its place in the order, from 1: rules are tried in this order.' }),
    name: z.string(),
    enabled: z.boolean(),
    conditions: z.array(leadSourceCondition),
    source: z.string().nullable(),
    tagIds: z.array(publicId('tag')),
    fieldWrites: z.array(leadSourceFieldWrite),
    problems: z
      .array(
        z.looseObject({
          code: z.enum(leadSourceRuleProblemCodes),
          /** The tag or the field, by its id. */
          id: z.string(),
          message: z.string(),
        }),
      )
      .meta({
        description:
          'What the rule names that is no longer there. The rest of the rule still applies.',
      }),
    revision: z.int().min(1),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'LeadSourceRule' });
export type LeadSourceRule = z.output<typeof leadSourceRule>;

const listRevision = z.string().regex(/^[a-f0-9]{64}$/);

export const leadSourceRuleList = z
  .looseObject({
    items: z.array(leadSourceRule).meta({ description: 'In the order they are tried.' }),
    revision: listRevision.meta({
      description: 'The order and every rule as read: what a reorder sends back.',
    }),
    limit: z.literal(LEAD_SOURCE_RULE_LIMITS.rules),
    canManage: z.boolean().meta({ description: 'Whether the caller may change the rules.' }),
  })
  .meta({ id: 'LeadSourceRuleList' });
export type LeadSourceRuleList = z.output<typeof leadSourceRuleList>;

export const reorderLeadSourceRulesInput = z
  .strictObject({
    ruleIds: z
      .array(publicId('lead_source_rule'))
      .min(1)
      .max(LEAD_SOURCE_RULE_LIMITS.rules)
      .refine((ids) => distinct(ids, (id) => id), { error: 'List each rule once.' })
      .meta({ description: 'Every rule of the business, in the new order.' }),
    revision: listRevision.meta({ description: 'The revision of the list as it was read.' }),
  })
  .meta({ id: 'ReorderLeadSourceRulesInput' });
export type ReorderLeadSourceRulesInput = z.output<typeof reorderLeadSourceRulesInput>;

const group = 'Lead sources';
const ruleParams = z.strictObject({ ruleId: publicId('lead_source_rule') });

export const listLeadSourceRules = defineEndpoint({
  operationId: 'listLeadSourceRules',
  method: 'get',
  path: '/lead-sources/rules',
  group,
  summary: 'Read the business’s own lead source rules, in the order they are tried',
  response: { status: 200, description: 'The rules.', schema: leadSourceRuleList },
});
export const createLeadSourceRule = defineEndpoint({
  operationId: 'createLeadSourceRule',
  method: 'post',
  path: '/lead-sources/rules',
  group,
  summary: 'Add a lead source rule, after the ones already there',
  body: createLeadSourceRuleInput,
  response: { status: 201, description: 'The new rule.', schema: leadSourceRule },
});
export const reorderLeadSourceRules = defineEndpoint({
  operationId: 'reorderLeadSourceRules',
  method: 'post',
  path: '/lead-sources/rules/order',
  group,
  summary: 'Put the lead source rules in a new order',
  body: reorderLeadSourceRulesInput,
  response: {
    status: 200,
    description:
      'The rules in their new order. A list that changed since it was read returns 409 and nothing moves.',
    schema: leadSourceRuleList,
  },
});
export const getLeadSourceRule = defineEndpoint({
  operationId: 'getLeadSourceRule',
  method: 'get',
  path: '/lead-sources/rules/{ruleId}',
  group,
  summary: 'Read one lead source rule',
  params: ruleParams,
  response: { status: 200, description: 'The rule as it is saved.', schema: leadSourceRule },
});
export const updateLeadSourceRule = defineEndpoint({
  operationId: 'updateLeadSourceRule',
  method: 'put',
  path: '/lead-sources/rules/{ruleId}',
  group,
  summary: 'Change a lead source rule without overwriting another edit',
  params: ruleParams,
  body: updateLeadSourceRuleInput,
  response: {
    status: 200,
    description: 'The saved rule and its revision.',
    schema: leadSourceRule,
  },
});
export const deleteLeadSourceRule = defineEndpoint({
  operationId: 'deleteLeadSourceRule',
  method: 'delete',
  path: '/lead-sources/rules/{ruleId}',
  group,
  summary: 'Delete a lead source rule',
  params: ruleParams,
  response: {
    status: 204,
    description:
      'The rule is gone and the ones after it move up. Leads already named by it keep their Source and tags.',
  },
});

/** Every endpoint of the business’s own rules behind Settings → Lead Sources. */
export const leadSourceRuleEndpoints = [
  listLeadSourceRules,
  createLeadSourceRule,
  reorderLeadSourceRules,
  getLeadSourceRule,
  updateLeadSourceRule,
  deleteLeadSourceRule,
] as const;

/** What the built-in rules call each choice of `lead_source`, for a list of choices. */
export const leadSourceChoiceLabel = (key: (typeof leadSourceKeys)[number]): string =>
  key === 'source_param' ? 'A name the link chose (source=…)' : leadSourceLabels[key];
