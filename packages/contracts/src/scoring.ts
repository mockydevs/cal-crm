// Settings → Manage Scoring, and a contact's engagement score. As in GoHighLevel, a business
// has one score profile, "Engagement Score": rules that add or subtract points when a contact
// does something, edited as a draft and made live by publishing them. A contact's score is
// the sum of what the live rules, workflows ("Modify contact engagement score") and people
// gave it; nothing lowers it by itself over time.
//
// A rule is offered only for what this product records as it happens. GoHighLevel's actions
// with nothing behind them here (an email opened or clicked, orders, surveys) are listed as
// unavailable, never offered.
import * as z from 'zod';

import { appointmentStatuses } from './calendar-events.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';
import { SCORING_LIMITS, scoreCalculations } from './scoring-limits.js';

export * from './scoring-limits.js';

/** What a contact does that a rule scores: the actions this product records. */
export const scoreRuleActions = [
  'email_event',
  'contact_replied',
  'form_submitted',
  'appointment_booked',
  'appointment_status',
  'contact_tag',
  'payment_received',
  'trigger_link_clicked',
  'contact_changed',
] as const;
export type ScoreRuleAction = (typeof scoreRuleActions)[number];

/**
 * GoHighLevel's scoring actions this product cannot score yet: it records no email opens or
 * clicks, and has no order forms, orders or surveys.
 */
export const unavailableScoreActions = [
  'email_opened',
  'email_clicked',
  'order_form_submission',
  'order_placed',
  'survey_submitted',
] as const;

/** The email events a rule can score: what the mail server tells of, or the contact does. */
export const scoreEmailEvents = ['bounced', 'unsubscribed', 'complained'] as const;
/** Where a reply came in. */
export const scoreReplyChannels = ['email', 'sms', 'webchat'] as const;
export const scoreTagChanges = ['added', 'removed'] as const;

/** What the rule scores, and which of it. Left out or null, a choice takes any. */
export const scoreRuleWhen = z
  .discriminatedUnion('action', [
    z.strictObject({ action: z.literal('email_event'), event: z.enum(scoreEmailEvents) }),
    z.strictObject({
      action: z.literal('contact_replied'),
      channel: z.enum(scoreReplyChannels).nullable().default(null),
    }),
    z.strictObject({
      action: z.literal('form_submitted'),
      formId: publicId('form').nullable().default(null),
    }),
    z.strictObject({ action: z.literal('appointment_booked') }),
    z.strictObject({
      action: z.literal('appointment_status'),
      status: z.enum(appointmentStatuses),
    }),
    z.strictObject({
      action: z.literal('contact_tag'),
      change: z.enum(scoreTagChanges),
      tagId: publicId('tag'),
    }),
    z.strictObject({ action: z.literal('payment_received') }),
    z.strictObject({ action: z.literal('trigger_link_clicked') }),
    z.strictObject({ action: z.literal('contact_changed') }),
  ])
  .meta({
    id: 'ScoreRuleWhen',
    description:
      'What the contact does: an email event (bounced, unsubscribed, complained), a reply (by any channel or one), a form submitted (any or one), an appointment booked, an appointment status, a tag added or removed, a payment received, a trigger link clicked, or a change to the contact.',
  });
export type ScoreRuleWhen = z.output<typeof scoreRuleWhen>;
export type ScoreRuleWhenInput = z.input<typeof scoreRuleWhen>;

const ruleDocument = {
  when: scoreRuleWhen,
  hasTagId: publicId('tag')
    .nullable()
    .default(null)
    .meta({ description: 'Scores only a contact that has this tag at the time. Null for any.' }),
  calculation: z.enum(scoreCalculations),
  points: z.int().min(1).max(SCORING_LIMITS.points),
};

export const scoreRuleInput = z.strictObject(ruleDocument).meta({
  id: 'ScoreRuleInput',
  description:
    'A rule of the draft. It scores nobody until the draft is published, and then once for each time a contact does what it names.',
});
export type ScoreRuleInput = z.input<typeof scoreRuleInput>;

export const updateScoreRuleInput = z
  .strictObject({
    ...ruleDocument,
    revision: z.int().min(1).meta({ description: 'The revision the rule was read at.' }),
  })
  .meta({ id: 'UpdateScoreRuleInput' });
export type UpdateScoreRuleInput = z.input<typeof updateScoreRuleInput>;

export const scoreRuleProblemCodes = ['tag_missing', 'form_missing'] as const;

export const scoreRule = z
  .looseObject({
    id: publicId('score_rule'),
    when: scoreRuleWhen,
    hasTagId: publicId('tag').nullable(),
    calculation: z.enum(scoreCalculations),
    points: z.int().min(1).max(SCORING_LIMITS.points),
    problems: z
      .array(
        z.looseObject({
          code: z.enum(scoreRuleProblemCodes),
          id: z.string(),
          message: z.string(),
        }),
      )
      .meta({ description: 'A tag or form the rule names that was deleted: it scores nobody.' }),
    revision: z.int().min(1),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'ScoreRule' });
export type ScoreRule = z.output<typeof scoreRule>;

export const scoreProfile = z
  .looseObject({
    name: z.string(),
    description: z.string(),
    /** The draft's rules, oldest first. */
    rules: z.array(scoreRule),
    revision: z.int().min(0).meta({
      description: 'Raised by every change to the draft: what publishing sends back.',
    }),
    publishedAt: timestamp.nullable().meta({ description: 'Null until it is first published.' }),
    unpublishedChanges: z
      .boolean()
      .meta({ description: 'Whether the draft differs from the rules that score.' }),
    liveRules: z.int().min(0).meta({ description: 'How many rules score now.' }),
    limit: z.literal(SCORING_LIMITS.rules),
    canManage: z.boolean().meta({ description: 'Whether the caller may change the rules.' }),
  })
  .meta({ id: 'ScoreProfile' });
export type ScoreProfile = z.output<typeof scoreProfile>;

export const updateScoreProfileInput = z
  .strictObject({
    name: z.string().trim().min(1).max(SCORING_LIMITS.name),
    description: z.string().trim().max(SCORING_LIMITS.description),
  })
  .meta({ id: 'UpdateScoreProfileInput' });
export type UpdateScoreProfileInput = z.input<typeof updateScoreProfileInput>;

export const publishScoreProfileInput = z
  .strictObject({
    revision: z
      .int()
      .min(0)
      .meta({ description: 'The draft as read: a draft changed since returns 409.' }),
  })
  .meta({ id: 'PublishScoreProfileInput' });

/** Who changed a contact's score: a rule, a workflow step, or a person. */
export const scoreChangeSources = ['rule', 'workflow', 'person'] as const;

export const contactScore = z
  .looseObject({
    score: z.int().nullable().meta({ description: 'Null for a contact nothing has scored yet.' }),
    updatedAt: timestamp.nullable(),
    changes: z
      .array(
        z.looseObject({
          change: z.int(),
          source: z.enum(scoreChangeSources),
          /** The rule that scored, while it is still there. */
          ruleId: publicId('score_rule').nullable(),
          at: timestamp,
        }),
      )
      .meta({ description: 'The latest changes, newest first.' }),
    canEdit: z.boolean(),
  })
  .meta({ id: 'ContactScore' });
export type ContactScore = z.output<typeof contactScore>;

export const setContactScoreInput = z
  .strictObject({ score: z.int().min(-SCORING_LIMITS.score).max(SCORING_LIMITS.score) })
  .meta({ id: 'SetContactScoreInput' });
export type SetContactScoreInput = z.input<typeof setContactScoreInput>;

/** How many changes the contact's score shows. */
export const CONTACT_SCORE_CHANGES = 10;

const group = 'Scoring';
const ruleParams = z.strictObject({ ruleId: publicId('score_rule') });
const contactParams = z.strictObject({ id: publicId('contact') });

export const getScoreProfile = defineEndpoint({
  operationId: 'getScoreProfile',
  method: 'get',
  path: '/scoring',
  group,
  summary: 'Read the engagement score profile and its draft rules',
  response: { status: 200, description: 'The profile.', schema: scoreProfile },
});
export const updateScoreProfile = defineEndpoint({
  operationId: 'updateScoreProfile',
  method: 'put',
  path: '/scoring',
  group,
  summary: 'Rename the engagement score profile or change its description',
  body: updateScoreProfileInput,
  response: { status: 200, description: 'The profile.', schema: scoreProfile },
});
export const publishScoreProfile = defineEndpoint({
  operationId: 'publishScoreProfile',
  method: 'post',
  path: '/scoring/publish',
  group,
  summary: 'Make the draft rules the ones that score',
  body: publishScoreProfileInput,
  response: {
    status: 200,
    description:
      'The profile, published. What contacts did before is not scored again; what they do from now on is.',
    schema: scoreProfile,
  },
});
export const createScoreRule = defineEndpoint({
  operationId: 'createScoreRule',
  method: 'post',
  path: '/scoring/rules',
  group,
  summary: 'Add a rule to the draft',
  body: scoreRuleInput,
  response: { status: 201, description: 'The new rule.', schema: scoreRule },
});
export const updateScoreRule = defineEndpoint({
  operationId: 'updateScoreRule',
  method: 'put',
  path: '/scoring/rules/{ruleId}',
  group,
  summary: 'Change a rule of the draft without overwriting another edit',
  params: ruleParams,
  body: updateScoreRuleInput,
  response: { status: 200, description: 'The saved rule.', schema: scoreRule },
});
export const deleteScoreRule = defineEndpoint({
  operationId: 'deleteScoreRule',
  method: 'delete',
  path: '/scoring/rules/{ruleId}',
  group,
  summary: 'Delete a rule from the draft',
  params: ruleParams,
  response: {
    status: 204,
    description: 'The rule is gone from the draft; it scores until the draft is published.',
  },
});
export const getContactScore = defineEndpoint({
  operationId: 'getContactScore',
  method: 'get',
  path: '/contacts/{id}/engagement-score',
  group,
  summary: "Read a contact's engagement score and its latest changes",
  params: contactParams,
  response: { status: 200, description: 'The score.', schema: contactScore },
});
export const setContactScore = defineEndpoint({
  operationId: 'setContactScore',
  method: 'put',
  path: '/contacts/{id}/engagement-score',
  group,
  summary: "Set a contact's engagement score",
  params: contactParams,
  body: setContactScoreInput,
  response: { status: 200, description: 'The score.', schema: contactScore },
});

/** Every endpoint of Settings → Manage Scoring and a contact's score. */
export const scoringEndpoints = [
  getScoreProfile,
  updateScoreProfile,
  publishScoreProfile,
  createScoreRule,
  updateScoreRule,
  deleteScoreRule,
  getContactScore,
  setContactScore,
] as const;
