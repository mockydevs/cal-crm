// Settings → Lead Sources: the business's own rules, kept. What they do to a lead is
// lead-source-rules.ts; this file stores them.
//
// - A business has at most 50 rules, in an order with no gaps (1, 2, 3…). One writer at a
//   time adds, deletes or reorders a business's rules, so the count and the places it
//   reads are still true when it writes.
// - A save names the revision it read; a reorder names the revision of the whole list. A
//   stale one changes nothing and is told so (409).
// - A rule names existing tags and text custom fields of contacts. Both are checked when
//   it is saved; one deleted afterwards is skipped when the rule is applied and listed as
//   a problem when the rule is read.
// - Anyone in the business may read the rules, as anyone may read a form. Changing them
//   takes forms.manage: they decide what every form's lead is called.
import { createHash } from 'node:crypto';

import {
  defineCommand,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Route,
} from '@repo/commands';
import {
  createLeadSourceRule,
  createLeadSourceRuleInput,
  deleteLeadSourceRule,
  getLeadSourceRule,
  LEAD_SOURCE_RULE_LIMITS,
  leadSourceCondition,
  listLeadSourceRules,
  parseInput,
  reorderLeadSourceRules,
  reorderLeadSourceRulesInput,
  updateLeadSourceRule,
  updateLeadSourceRuleInput,
  type CreateLeadSourceRuleInput,
  type LeadSourceRule,
  type LeadSourceRuleList,
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

/** May change the business's lead source rules. */
export const mayManageLeadSourceRules = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('forms.manage');

const asJson = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;

interface RuleRow {
  readonly id: string;
  readonly position: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly conditions: Json;
  readonly source_label: string | null;
  readonly tag_ids: string[];
  readonly field_writes: Json;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = [
  'id',
  'position',
  'name',
  'enabled',
  'conditions',
  'source_label',
  'tag_ids',
  'field_writes',
  'revision',
  'created_at',
  'updated_at',
] as const;

const storedConditions = z.array(leadSourceCondition);
const storedWrites = z.array(z.object({ fieldId: z.uuid(), value: z.string() }));

/** The text custom fields of contacts that a rule may fill, by crm.field_definitions.id. */
async function fillableFields(
  trx: DatabaseTransaction,
  businessId: string,
  fieldIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (fieldIds.length === 0) return new Set();
  const rows = await trx
    .selectFrom('crm.field_definitions as field')
    .innerJoin('crm.object_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'field.business_id')
        .onRef('type.id', '=', 'field.object_type_id'),
    )
    .select('field.id')
    .where('field.business_id', '=', businessId)
    .where('field.id', 'in', [...fieldIds])
    .where('type.kind', '=', 'contact')
    .where('field.value_type', 'in', ['text', 'long_text'])
    .where('field.archived_at', 'is', null)
    .where('field.merged_into_field_id', 'is', null)
    .execute();
  return new Set(rows.map((row) => row.id));
}

async function existingTags(
  trx: DatabaseTransaction,
  businessId: string,
  tagIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (tagIds.length === 0) return new Set();
  const rows = await trx
    .selectFrom('crm.tags')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', 'in', [...tagIds])
    .execute();
  return new Set(rows.map((row) => row.id));
}

/** Rules as the API shows them, each with what it names that is no longer there. */
async function present(
  trx: DatabaseTransaction,
  businessId: string,
  rows: readonly RuleRow[],
): Promise<LeadSourceRule[]> {
  const writesOf = (row: RuleRow) => storedWrites.safeParse(row.field_writes).data ?? [];
  const tags = await existingTags(trx, businessId, [
    ...new Set(rows.flatMap((row) => row.tag_ids)),
  ]);
  const fields = await fillableFields(trx, businessId, [
    ...new Set(rows.flatMap((row) => writesOf(row).map((write) => write.fieldId))),
  ]);
  return rows.map((row) => {
    const writes = writesOf(row);
    return {
      id: toPublicId('lead_source_rule', row.id),
      position: row.position,
      name: row.name,
      enabled: row.enabled,
      conditions: storedConditions.safeParse(row.conditions).data ?? [],
      source: row.source_label,
      tagIds: row.tag_ids.map((id) => toPublicId('tag', id)),
      fieldWrites: writes.map((write) => ({
        fieldId: toPublicId('field', write.fieldId),
        value: write.value,
      })),
      problems: [
        ...row.tag_ids
          .filter((id) => !tags.has(id))
          .map((id) => ({
            code: 'tag_missing' as const,
            id: toPublicId('tag', id),
            message: 'A tag this rule adds was deleted. The rest of the rule still applies.',
          })),
        ...writes
          .filter((write) => !fields.has(write.fieldId))
          .map((write) => ({
            code: 'field_unavailable' as const,
            id: toPublicId('field', write.fieldId),
            message:
              'A field this rule fills was archived, deleted or is no longer a text field of contacts. The rest of the rule still applies.',
          })),
      ],
      revision: row.revision,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

/** The order and every rule as read: what a reorder must name to move anything. */
const listRevisionOf = (rows: readonly Pick<RuleRow, 'id' | 'revision'>[]): string =>
  createHash('sha256')
    .update(JSON.stringify(rows.map((row) => [row.id, row.revision])))
    .digest('hex');

const rulesOf = (trx: DatabaseTransaction, businessId: string) =>
  trx
    .selectFrom('crm.lead_source_rules')
    .select(COLUMNS)
    .where('business_id', '=', businessId)
    .orderBy('position');

/** One writer at a time changes which rules a business has and where each stands. */
async function serializeRules(trx: DatabaseTransaction, businessId: string): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtextextended(${`crm.lead_source_rules:${businessId}`}, 0))
  `.execute(trx);
}

async function requireRule(
  trx: DatabaseTransaction,
  businessId: string,
  ruleId: string,
  lock = false,
): Promise<RuleRow> {
  let query = trx
    .selectFrom('crm.lead_source_rules')
    .select(COLUMNS)
    .where('business_id', '=', businessId)
    .where('id', '=', parsePublicId('lead_source_rule', ruleId) ?? '');
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Lead source rule', ruleId);
  return row;
}

/**
 * What a rule names, as the table keeps it, or the refusal a tag or a field that cannot be
 * used gets. Checked at every save, so a rule never starts out naming something missing.
 */
async function named(
  trx: DatabaseTransaction,
  businessId: string,
  input: Pick<CreateLeadSourceRuleInput, 'tagIds' | 'fieldWrites'>,
): Promise<{ tagIds: string[]; fieldWrites: { fieldId: string; value: string }[] }> {
  const tagIds = input.tagIds.map((id) => parsePublicId('tag', id) ?? '');
  const fieldWrites = input.fieldWrites.map((write) => ({
    fieldId: parsePublicId('field', write.fieldId) ?? '',
    value: write.value,
  }));
  const tags = await existingTags(trx, businessId, tagIds);
  const fields = await fillableFields(
    trx,
    businessId,
    fieldWrites.map((write) => write.fieldId),
  );
  const issues: Issue[] = [
    ...tagIds.flatMap((id, index) =>
      tags.has(id)
        ? []
        : [
            {
              path: `/tagIds/${String(index)}`,
              code: 'invalid_tag',
              message: 'Choose a tag of this business.',
            },
          ],
    ),
    ...fieldWrites.flatMap((write, index) =>
      fields.has(write.fieldId)
        ? []
        : [
            {
              path: `/fieldWrites/${String(index)}/fieldId`,
              code: 'invalid_field',
              message: 'Choose a text custom field of contacts that is not archived.',
            },
          ],
    ),
  ];
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  return { tagIds, fieldWrites };
}

/** What a save keeps in the audit log: which rule and its size, never its words. */
const auditOf = (input: {
  readonly name: string;
  readonly conditions: readonly unknown[];
  readonly tagIds: readonly string[];
  readonly fieldWrites: readonly unknown[];
  readonly source: string | null;
}): Readonly<Record<string, unknown>> => ({
  name: input.name,
  conditions: input.conditions.length,
  namesSource: input.source !== null,
  tags: input.tagIds.length,
  fieldWrites: input.fieldWrites.length,
});

export const createLeadSourceRuleCommand = defineCommand({
  name: 'forms.lead_source_rule.create',
  permission: 'forms.manage',
  input: createLeadSourceRuleInput,
  audit: auditOf,
  async handle(trx, input, command): Promise<LeadSourceRule> {
    const businessId = requireBusiness(command.context);
    await serializeRules(trx, businessId);
    const { count } = await trx
      .selectFrom('crm.lead_source_rules')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('business_id', '=', businessId)
      .executeTakeFirstOrThrow();
    if (Number(count) >= LEAD_SOURCE_RULE_LIMITS.rules)
      throw new ValidationError([
        {
          path: '/name',
          code: 'limit_reached',
          message: `A business can have at most ${String(LEAD_SOURCE_RULE_LIMITS.rules)} lead source rules. Delete one first.`,
        },
      ]);
    const names = await named(trx, businessId, input);
    const row = await trx
      .insertInto('crm.lead_source_rules')
      .values({
        business_id: businessId,
        position: Number(count) + 1,
        name: input.name,
        enabled: input.enabled,
        conditions: asJson(input.conditions),
        source_label: input.source,
        tag_ids: names.tagIds,
        field_writes: asJson(names.fieldWrites),
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    await command.emit({
      type: 'lead_source_rule.created',
      subject: { kind: 'lead_source_rule', id: row.id },
      payload: { name: row.name, position: row.position },
    });
    const [rule] = await present(trx, businessId, [row]);
    if (rule === undefined) throw new Error('The rule was not stored.');
    return rule;
  },
});

export const updateLeadSourceRuleCommand = defineCommand({
  name: 'forms.lead_source_rule.update',
  permission: 'forms.manage',
  input: z.strictObject({
    ...updateLeadSourceRule.params.shape,
    rule: updateLeadSourceRuleInput,
  }),
  audit: (input) => ({ ruleId: input.ruleId, ...auditOf(input.rule) }),
  async handle(trx, input, command): Promise<LeadSourceRule> {
    const businessId = requireBusiness(command.context);
    const current = await requireRule(trx, businessId, input.ruleId, true);
    if (current.revision !== input.rule.revision)
      throw new ConflictError(
        'This rule changed. Reload the saved version before editing it again.',
      );
    const names = await named(trx, businessId, input.rule);
    const row = await trx
      .updateTable('crm.lead_source_rules')
      .set({
        name: input.rule.name,
        enabled: input.rule.enabled,
        conditions: asJson(input.rule.conditions),
        source_label: input.rule.source,
        tag_ids: names.tagIds,
        field_writes: asJson(names.fieldWrites),
        revision: current.revision + 1,
      })
      .where('business_id', '=', businessId)
      .where('id', '=', current.id)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    await command.emit({
      type: 'lead_source_rule.updated',
      subject: { kind: 'lead_source_rule', id: row.id },
      payload: { name: row.name, enabled: row.enabled },
    });
    const [rule] = await present(trx, businessId, [row]);
    if (rule === undefined) throw new Error('The rule was not stored.');
    return rule;
  },
});

export const deleteLeadSourceRuleCommand = defineCommand({
  name: 'forms.lead_source_rule.delete',
  permission: 'forms.manage',
  input: deleteLeadSourceRule.params,
  async handle(trx, input, command): Promise<void> {
    const businessId = requireBusiness(command.context);
    await serializeRules(trx, businessId);
    const current = await requireRule(trx, businessId, input.ruleId, true);
    await trx
      .deleteFrom('crm.lead_source_rules')
      .where('business_id', '=', businessId)
      .where('id', '=', current.id)
      .execute();
    // The rules after it move up, in one statement: the order keeps no gap.
    await trx
      .updateTable('crm.lead_source_rules')
      .set((eb) => ({ position: eb('position', '-', 1) }))
      .where('business_id', '=', businessId)
      .where('position', '>', current.position)
      .execute();
    await command.emit({
      type: 'lead_source_rule.deleted',
      subject: { kind: 'lead_source_rule', id: current.id },
      payload: { name: current.name },
    });
  },
});

export const reorderLeadSourceRulesCommand = defineCommand({
  name: 'forms.lead_source_rule.reorder',
  permission: 'forms.manage',
  input: reorderLeadSourceRulesInput,
  audit: (input) => ({ rules: input.ruleIds.length }),
  async handle(trx, input, command): Promise<LeadSourceRuleList> {
    const businessId = requireBusiness(command.context);
    await serializeRules(trx, businessId);
    const rows = await rulesOf(trx, businessId).forUpdate().execute();
    if (listRevisionOf(rows) !== input.revision)
      throw new ConflictError('The rules changed. Reload them before putting them in order.');
    const wanted = input.ruleIds.map((id) => parsePublicId('lead_source_rule', id) ?? '');
    const have = new Set(rows.map((row) => row.id));
    // Every rule, once: a list that leaves one out, or names one that is not there, would
    // leave a gap or two rules in one place.
    if (wanted.length !== rows.length || wanted.some((id) => !have.has(id)))
      throw new ValidationError([
        {
          path: '/ruleIds',
          code: 'incomplete_order',
          message: 'List every lead source rule of this business once, in the new order.',
        },
      ]);
    // One statement moves them all; the place of each is checked when it ends.
    await sql`
      update crm.lead_source_rules as rule
      set position = moved.position
      from unnest(${wanted}::uuid[]) with ordinality as moved(id, position)
      where rule.business_id = ${businessId}::uuid and rule.id = moved.id
        and rule.position <> moved.position
    `.execute(trx);
    await command.emit({
      type: 'lead_source_rule.reordered',
      subject: { kind: 'business', id: businessId },
      payload: { ruleIds: input.ruleIds },
    });
    return readLeadSourceRules(trx, command);
  },
});

/** The business's rules, in the order they are tried. */
export async function readLeadSourceRules(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<LeadSourceRuleList> {
  const businessId = requireBusiness(invocation.context);
  const rows = await rulesOf(trx, businessId).execute();
  return {
    items: await present(trx, businessId, rows),
    revision: listRevisionOf(rows),
    limit: LEAD_SOURCE_RULE_LIMITS.rules,
    canManage: mayManageLeadSourceRules(invocation),
  };
}

/** One rule of this business, as it is saved. */
export async function readLeadSourceRule(
  trx: DatabaseTransaction,
  invocation: Invocation,
  ruleId: string,
): Promise<LeadSourceRule> {
  const businessId = requireBusiness(invocation.context);
  const [rule] = await present(trx, businessId, [await requireRule(trx, businessId, ruleId)]);
  if (rule === undefined) throw new NotFoundError('Lead source rule', ruleId);
  return rule;
}

export const leadSourceRuleRoutes: readonly ApiRoute[] = [
  {
    endpoint: listLeadSourceRules,
    run: ({ invocation }, { db }) => {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, (trx) => readLeadSourceRules(trx, invocation));
    },
  } satisfies Route<typeof listLeadSourceRules>,
  {
    endpoint: createLeadSourceRule,
    command: createLeadSourceRuleCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createLeadSourceRuleCommand, body, invocation),
  } satisfies Route<typeof createLeadSourceRule>,
  {
    endpoint: reorderLeadSourceRules,
    command: reorderLeadSourceRulesCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, reorderLeadSourceRulesCommand, body, invocation),
  } satisfies Route<typeof reorderLeadSourceRules>,
  {
    endpoint: getLeadSourceRule,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { ruleId } = parseInput(getLeadSourceRule.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readLeadSourceRule(trx, invocation, ruleId),
      );
    },
  } satisfies Route<typeof getLeadSourceRule>,
  {
    endpoint: updateLeadSourceRule,
    command: updateLeadSourceRuleCommand,
    run: async (request, services) => {
      const { ruleId } = parseInput(updateLeadSourceRule.params, request.params);
      // Another business's rule is not found, whatever was sent with it.
      requireBusiness(request.invocation.context);
      await withTenant(services.db, request.invocation.context, (trx) =>
        readLeadSourceRule(trx, request.invocation, ruleId),
      );
      return runCommand(
        services,
        updateLeadSourceRuleCommand,
        { ruleId, rule: request.body },
        request.invocation,
      );
    },
  } satisfies Route<typeof updateLeadSourceRule>,
  {
    endpoint: deleteLeadSourceRule,
    command: deleteLeadSourceRuleCommand,
    run: async (request, services) => {
      const parsed = parseInput(deleteLeadSourceRule.params, request.params);
      // Not found before anything else is said, as for a save.
      requireBusiness(request.invocation.context);
      await withTenant(services.db, request.invocation.context, (trx) =>
        readLeadSourceRule(trx, request.invocation, parsed.ruleId),
      );
      await runCommand(services, deleteLeadSourceRuleCommand, parsed, request.invocation);
      return undefined;
    },
  } satisfies Route<typeof deleteLeadSourceRule>,
];
