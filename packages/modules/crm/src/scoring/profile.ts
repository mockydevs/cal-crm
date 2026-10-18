// Settings → Manage Scoring: the business's engagement score profile and its rules. The
// rules are a draft; publishing makes the draft the rules that score (scores.ts).
//
// - A business has one profile, made the first time it is changed. Every change to the draft
//   raises the profile's revision under the profile's row lock, so changes to one business's
//   rules happen one at a time and a publish names exactly the draft it saw.
// - A rule names tags and forms by id. Each is checked when the rule is saved; one deleted
//   afterwards is listed as a problem, and the rule then scores nobody.
// - Anyone in the business may read the rules. Changing them takes fields.manage, the
//   permission that configures what is kept about contacts.
import {
  defineCommand,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Route,
} from '@repo/commands';
import {
  appointmentStatuses,
  createScoreRule,
  deleteScoreRule,
  getScoreProfile,
  parseInput,
  publishScoreProfile,
  publishScoreProfileInput,
  SCORING_LIMITS,
  scoreCalculations,
  scoreEmailEvents,
  scoreReplyChannels,
  scoreRuleActions,
  scoreRuleInput,
  scoreTagChanges,
  updateScoreProfile,
  updateScoreProfileInput,
  updateScoreRule,
  updateScoreRuleInput,
  type ScoreProfile,
  type ScoreRule,
  type ScoreRuleWhen,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction, type Json } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { eventTypesOf, type LiveRule } from './rules.js';

/** May change the business's scoring rules. */
export const mayManageScoring = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('fields.manage');

const asJson = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;

interface RuleRow {
  readonly id: string;
  readonly action: string;
  readonly qualifier: Json;
  readonly has_tag_id: string | null;
  readonly calculation: string;
  readonly points: number;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const RULE_COLUMNS = [
  'id',
  'action',
  'qualifier',
  'has_tag_id',
  'calculation',
  'points',
  'revision',
  'created_at',
  'updated_at',
] as const;

const storedQualifier = z.record(z.string(), z.string().nullable());
const action = z.enum(scoreRuleActions);
const calculation = z.enum(scoreCalculations);

/** A stored rule as the scorer reads it. */
export function liveRuleOf(row: Omit<RuleRow, 'revision' | 'created_at' | 'updated_at'>): LiveRule {
  return {
    id: row.id,
    action: action.parse(row.action),
    qualifier: storedQualifier.parse(row.qualifier),
    hasTagId: row.has_tag_id,
    calculation: calculation.parse(row.calculation),
    points: row.points,
  };
}

/** The live rules a profile keeps, as it kept them. */
export const liveRules = z.array(
  z.object({
    id: z.uuid(),
    action,
    qualifier: storedQualifier,
    hasTagId: z.uuid().nullable(),
    calculation,
    points: z.int(),
  }),
);

/** What a rule scores, as the API shows it: ids made public again. */
function whenOf(rule: LiveRule): ScoreRuleWhen {
  const { qualifier: q } = rule;
  const text = (key: string): string => q[key] ?? '';
  switch (rule.action) {
    case 'email_event':
      return { action: 'email_event', event: z.enum(scoreEmailEvents).parse(q['event']) };
    case 'contact_replied':
      return {
        action: 'contact_replied',
        channel: z
          .enum(scoreReplyChannels)
          .nullable()
          .parse(q['channel'] ?? null),
      };
    case 'form_submitted': {
      const formId = q['formId'] ?? null;
      return {
        action: 'form_submitted',
        formId: formId === null ? null : toPublicId('form', formId),
      };
    }
    case 'appointment_status':
      return {
        action: 'appointment_status',
        status: z.enum(appointmentStatuses).parse(q['status']),
      };
    case 'contact_tag':
      return {
        action: 'contact_tag',
        change: z.enum(scoreTagChanges).parse(q['change']),
        tagId: toPublicId('tag', text('tagId')),
      };
    case 'appointment_booked':
    case 'payment_received':
    case 'trigger_link_clicked':
    case 'contact_changed':
      return { action: rule.action };
  }
}

/** What a rule scores, as the table keeps it: the action, and its choices with stored ids. */
function storedWhen(when: ScoreRuleWhen): {
  action: string;
  qualifier: Record<string, string | null>;
} {
  switch (when.action) {
    case 'email_event':
      return { action: when.action, qualifier: { event: when.event } };
    case 'contact_replied':
      return { action: when.action, qualifier: { channel: when.channel } };
    case 'form_submitted':
      return {
        action: when.action,
        qualifier: {
          formId: when.formId === null ? null : (parsePublicId('form', when.formId) ?? null),
        },
      };
    case 'appointment_status':
      return { action: when.action, qualifier: { status: when.status } };
    case 'contact_tag':
      return {
        action: when.action,
        qualifier: { change: when.change, tagId: parsePublicId('tag', when.tagId) ?? null },
      };
    case 'appointment_booked':
    case 'payment_received':
    case 'trigger_link_clicked':
    case 'contact_changed':
      return { action: when.action, qualifier: {} };
  }
}

/** The tags and forms rules name, by stored id. */
const namedTags = (rules: readonly LiveRule[]): string[] => [
  ...new Set(
    rules.flatMap((rule) => [
      ...(rule.hasTagId === null ? [] : [rule.hasTagId]),
      ...(rule.action === 'contact_tag' && rule.qualifier['tagId']
        ? [rule.qualifier['tagId']]
        : []),
    ]),
  ),
];
const namedForms = (rules: readonly LiveRule[]): string[] => [
  ...new Set(
    rules.flatMap((rule) =>
      rule.action === 'form_submitted' && rule.qualifier['formId']
        ? [rule.qualifier['formId']]
        : [],
    ),
  ),
];

async function existingTags(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const rows = await trx
    .selectFrom('crm.tags')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', 'in', [...ids])
    .execute();
  return new Set(rows.map((row) => row.id));
}

async function existingForms(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const rows = await trx
    .selectFrom('forms.forms')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', 'in', [...ids])
    .where('status', 'in', ['published', 'draft'])
    .execute();
  return new Set(rows.map((row) => row.id));
}

/** Rules as the API shows them, each with what it names that is no longer there. */
async function present(
  trx: DatabaseTransaction,
  businessId: string,
  rows: readonly RuleRow[],
): Promise<ScoreRule[]> {
  const rules = rows.map(liveRuleOf);
  const tags = await existingTags(trx, businessId, namedTags(rules));
  const forms = await existingForms(trx, businessId, namedForms(rules));
  return rows.map((row, index) => {
    const rule = rules[index] ?? liveRuleOf(row);
    const missingTags = namedTags([rule]).filter((id) => !tags.has(id));
    const missingForms = namedForms([rule]).filter((id) => !forms.has(id));
    return {
      id: toPublicId('score_rule', row.id),
      when: whenOf(rule),
      hasTagId: rule.hasTagId === null ? null : toPublicId('tag', rule.hasTagId),
      calculation: rule.calculation,
      points: rule.points,
      problems: [
        ...missingTags.map((id) => ({
          code: 'tag_missing' as const,
          id: toPublicId('tag', id),
          message: 'A tag this rule names was deleted: it scores nobody until you choose another.',
        })),
        ...missingForms.map((id) => ({
          code: 'form_missing' as const,
          id: toPublicId('form', id),
          message:
            'The form this rule names was deleted: it scores nobody until you choose another.',
        })),
      ],
      revision: row.revision,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

/**
 * The business's profile, locked for a change to it or its rules; made with its defaults
 * the first time. Its row lock is what makes one business's changes happen one at a time.
 */
async function lockProfile(trx: DatabaseTransaction, businessId: string) {
  await trx
    .insertInto('crm.score_profiles')
    .values({ business_id: businessId })
    .onConflict((conflict) => conflict.column('business_id').doNothing())
    .execute();
  return trx
    .selectFrom('crm.score_profiles')
    .select(['revision', 'published_revision', 'live_rules'])
    .where('business_id', '=', businessId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

/** One more change to the draft. */
async function draftChanged(trx: DatabaseTransaction, businessId: string): Promise<void> {
  await trx
    .updateTable('crm.score_profiles')
    .set((eb) => ({ revision: eb('revision', '+', 1) }))
    .where('business_id', '=', businessId)
    .execute();
}

/**
 * The stored form of a rule's choices, or the refusal a tag or a form that cannot be used
 * gets. Checked at every save, so a rule never starts out naming something missing.
 */
async function checked(
  trx: DatabaseTransaction,
  businessId: string,
  input: { readonly when: ScoreRuleWhen; readonly hasTagId: string | null },
): Promise<{ action: string; qualifier: Record<string, string | null>; hasTagId: string | null }> {
  const stored = storedWhen(input.when);
  const hasTagId = input.hasTagId === null ? null : (parsePublicId('tag', input.hasTagId) ?? '');
  const tagIds = [
    ...(hasTagId === null ? [] : [hasTagId]),
    ...(stored.qualifier['tagId'] ? [stored.qualifier['tagId']] : []),
  ];
  const formId = stored.qualifier['formId'] ?? null;
  const tags = await existingTags(trx, businessId, tagIds);
  const forms = await existingForms(trx, businessId, formId === null ? [] : [formId]);
  const issues: Issue[] = [];
  const tagId = stored.qualifier['tagId'];
  if (tagId !== undefined && tagId !== null && !tags.has(tagId))
    issues.push({
      path: '/when/tagId',
      code: 'invalid_tag',
      message: 'Choose a tag of this business.',
    });
  if (hasTagId !== null && !tags.has(hasTagId))
    issues.push({
      path: '/hasTagId',
      code: 'invalid_tag',
      message: 'Choose a tag of this business.',
    });
  if (formId !== null && !forms.has(formId))
    issues.push({
      path: '/when/formId',
      code: 'invalid_form',
      message: 'Choose a form of this business.',
    });
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  return { ...stored, hasTagId };
}

const rulesOf = (trx: DatabaseTransaction, businessId: string) =>
  trx
    .selectFrom('crm.score_rules')
    .select(RULE_COLUMNS)
    .where('business_id', '=', businessId)
    .orderBy('created_at')
    .orderBy('id');

async function requireRule(
  trx: DatabaseTransaction,
  businessId: string,
  ruleId: string,
): Promise<RuleRow> {
  const row = await trx
    .selectFrom('crm.score_rules')
    .select(RULE_COLUMNS)
    .where('business_id', '=', businessId)
    .where('id', '=', parsePublicId('score_rule', ruleId) ?? '')
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Scoring rule', ruleId);
  return row;
}

/** What a save keeps in the audit log: the rule's shape, which holds nothing personal. */
const auditOf = (input: {
  readonly when: { readonly action: string };
  readonly calculation: string;
  readonly points: number;
}): Readonly<Record<string, unknown>> => ({
  action: input.when.action,
  calculation: input.calculation,
  points: input.points,
});

export const createScoreRuleCommand = defineCommand({
  name: 'crm.score_rule.create',
  permission: 'fields.manage',
  input: scoreRuleInput,
  audit: auditOf,
  async handle(trx, input, command): Promise<ScoreRule> {
    const businessId = requireBusiness(command.context);
    await lockProfile(trx, businessId);
    const { count } = await trx
      .selectFrom('crm.score_rules')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('business_id', '=', businessId)
      .executeTakeFirstOrThrow();
    if (Number(count) >= SCORING_LIMITS.rules)
      throw new ValidationError([
        {
          path: '/when',
          code: 'limit_reached',
          message: `A profile can have at most ${String(SCORING_LIMITS.rules)} rules. Delete one first.`,
        },
      ]);
    const stored = await checked(trx, businessId, input);
    const row = await trx
      .insertInto('crm.score_rules')
      .values({
        business_id: businessId,
        action: stored.action,
        qualifier: asJson(stored.qualifier),
        has_tag_id: stored.hasTagId,
        calculation: input.calculation,
        points: input.points,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning(RULE_COLUMNS)
      .executeTakeFirstOrThrow();
    await draftChanged(trx, businessId);
    await command.emit({
      type: 'score_rule.created',
      subject: { kind: 'score_rule', id: row.id },
      payload: auditOf(input),
    });
    const [rule] = await present(trx, businessId, [row]);
    if (rule === undefined) throw new Error('The rule was not stored.');
    return rule;
  },
});

export const updateScoreRuleCommand = defineCommand({
  name: 'crm.score_rule.update',
  permission: 'fields.manage',
  input: z.strictObject({ ...updateScoreRule.params.shape, rule: updateScoreRuleInput }),
  audit: (input) => ({ ruleId: input.ruleId, ...auditOf(input.rule) }),
  async handle(trx, input, command): Promise<ScoreRule> {
    const businessId = requireBusiness(command.context);
    await lockProfile(trx, businessId);
    const current = await requireRule(trx, businessId, input.ruleId);
    if (current.revision !== input.rule.revision)
      throw new ConflictError(
        'This rule changed. Reload the saved version before editing it again.',
      );
    const stored = await checked(trx, businessId, input.rule);
    const row = await trx
      .updateTable('crm.score_rules')
      .set({
        action: stored.action,
        qualifier: asJson(stored.qualifier),
        has_tag_id: stored.hasTagId,
        calculation: input.rule.calculation,
        points: input.rule.points,
        revision: current.revision + 1,
      })
      .where('business_id', '=', businessId)
      .where('id', '=', current.id)
      .returning(RULE_COLUMNS)
      .executeTakeFirstOrThrow();
    await draftChanged(trx, businessId);
    await command.emit({
      type: 'score_rule.updated',
      subject: { kind: 'score_rule', id: row.id },
      payload: auditOf(input.rule),
    });
    const [rule] = await present(trx, businessId, [row]);
    if (rule === undefined) throw new Error('The rule was not stored.');
    return rule;
  },
});

export const deleteScoreRuleCommand = defineCommand({
  name: 'crm.score_rule.delete',
  permission: 'fields.manage',
  input: deleteScoreRule.params,
  async handle(trx, input, command): Promise<void> {
    const businessId = requireBusiness(command.context);
    await lockProfile(trx, businessId);
    const current = await requireRule(trx, businessId, input.ruleId);
    await trx
      .deleteFrom('crm.score_rules')
      .where('business_id', '=', businessId)
      .where('id', '=', current.id)
      .execute();
    await draftChanged(trx, businessId);
    await command.emit({
      type: 'score_rule.deleted',
      subject: { kind: 'score_rule', id: current.id },
      payload: { action: current.action },
    });
  },
});

export const updateScoreProfileCommand = defineCommand({
  name: 'crm.score_profile.update',
  permission: 'fields.manage',
  input: updateScoreProfileInput,
  audit: (input) => ({ name: input.name }),
  async handle(trx, input, command): Promise<ScoreProfile> {
    const businessId = requireBusiness(command.context);
    await lockProfile(trx, businessId);
    await trx
      .updateTable('crm.score_profiles')
      .set({ name: input.name, description: input.description })
      .where('business_id', '=', businessId)
      .execute();
    await command.emit({
      type: 'score_profile.updated',
      subject: { kind: 'business', id: businessId },
      payload: { name: input.name },
    });
    return readScoreProfile(trx, command);
  },
});

export const publishScoreProfileCommand = defineCommand({
  name: 'crm.score_profile.publish',
  permission: 'fields.manage',
  input: publishScoreProfileInput,
  async handle(trx, input, command): Promise<ScoreProfile> {
    const businessId = requireBusiness(command.context);
    const profile = await lockProfile(trx, businessId);
    if (profile.revision !== input.revision)
      throw new ConflictError('The rules changed since you read them. Reload them, then publish.');
    const rules = (await rulesOf(trx, businessId).execute()).map(liveRuleOf);
    await trx
      .updateTable('crm.score_profiles')
      .set({
        live_rules: asJson(rules),
        live_event_types: eventTypesOf(rules),
        published_revision: profile.revision,
        published_at: sql<Date>`now()`,
        published_by_kind: command.context.actorKind,
        published_by_id: command.context.actorId ?? null,
      })
      .where('business_id', '=', businessId)
      .execute();
    await command.emit({
      type: 'score_profile.published',
      subject: { kind: 'business', id: businessId },
      payload: { rules: rules.length, revision: profile.revision },
    });
    return readScoreProfile(trx, command);
  },
});

/** The profile and its draft rules, oldest first. */
export async function readScoreProfile(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<ScoreProfile> {
  const businessId = requireBusiness(invocation.context);
  const profile = await trx
    .selectFrom('crm.score_profiles')
    .select(['name', 'description', 'revision', 'published_revision', 'published_at', 'live_rules'])
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  const rows = await rulesOf(trx, businessId).execute();
  const revision = profile?.revision ?? 0;
  const published = profile?.published_revision ?? null;
  return {
    name: profile?.name ?? 'Engagement Score',
    description: profile?.description ?? '',
    rules: await present(trx, businessId, rows),
    revision,
    publishedAt: profile?.published_at?.toISOString() ?? null,
    // Never published, the draft differs once it holds anything.
    unpublishedChanges: published === null ? rows.length > 0 : published !== revision,
    liveRules: liveRules.safeParse(profile?.live_rules ?? []).data?.length ?? 0,
    limit: SCORING_LIMITS.rules,
    canManage: mayManageScoring(invocation),
  };
}

/** The rule as it is saved, or not found: what a change is checked against first. */
async function readScoreRule(
  trx: DatabaseTransaction,
  invocation: Invocation,
  ruleId: string,
): Promise<void> {
  await requireRule(trx, requireBusiness(invocation.context), ruleId);
}

export const scoreProfileRoutes: readonly ApiRoute[] = [
  {
    endpoint: getScoreProfile,
    run: ({ invocation }, { db }) => {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, (trx) => readScoreProfile(trx, invocation));
    },
  } satisfies Route<typeof getScoreProfile>,
  {
    endpoint: updateScoreProfile,
    command: updateScoreProfileCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, updateScoreProfileCommand, body, invocation),
  } satisfies Route<typeof updateScoreProfile>,
  {
    endpoint: publishScoreProfile,
    command: publishScoreProfileCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, publishScoreProfileCommand, body, invocation),
  } satisfies Route<typeof publishScoreProfile>,
  {
    endpoint: createScoreRule,
    command: createScoreRuleCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createScoreRuleCommand, body, invocation),
  } satisfies Route<typeof createScoreRule>,
  {
    endpoint: updateScoreRule,
    command: updateScoreRuleCommand,
    run: async (request, services) => {
      const { ruleId } = parseInput(updateScoreRule.params, request.params);
      // Another business's rule is not found, whatever was sent with it.
      requireBusiness(request.invocation.context);
      await withTenant(services.db, request.invocation.context, (trx) =>
        readScoreRule(trx, request.invocation, ruleId),
      );
      return runCommand(
        services,
        updateScoreRuleCommand,
        { ruleId, rule: request.body },
        request.invocation,
      );
    },
  } satisfies Route<typeof updateScoreRule>,
  {
    endpoint: deleteScoreRule,
    command: deleteScoreRuleCommand,
    run: async (request, services) => {
      const parsed = parseInput(deleteScoreRule.params, request.params);
      requireBusiness(request.invocation.context);
      await withTenant(services.db, request.invocation.context, (trx) =>
        readScoreRule(trx, request.invocation, parsed.ruleId),
      );
      await runCommand(services, deleteScoreRuleCommand, parsed, request.invocation);
      return undefined;
    },
  } satisfies Route<typeof deleteScoreRule>,
];
