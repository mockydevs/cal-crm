// A contact's engagement score: what the live rules give for what the contact does, what a
// workflow's "Modify contact engagement score" step adds or subtracts, and what a person
// sets it to. Every change is kept in crm.score_changes; one that a rule or a step makes is
// keyed by what made it, so a job or a step that runs twice changes the score once.
//
// A change to a score is told of as contact.score_changed, on the contact's timeline, with
// the score, what it was, and who changed it: the Contact Engagement Score trigger starts on
// it. A change that leaves the score as it was tells nothing.
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type ApiRoute,
  type CommandContext,
  type Invocation,
  type Route,
  type TaskReference,
} from '@repo/commands';
import {
  CONTACT_SCORE_CHANGES,
  getContactScore,
  parseInput,
  publicId,
  SCORING_LIMITS,
  scoreCalculations,
  scoreChangeSources,
  setContactScore,
  setContactScoreInput,
  type ContactScore,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ForbiddenError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { lockLiveContact } from '../contacts/details.js';
import { liveRules } from './profile.js';
import { changeOf, rulePasses, scoreKeyOf } from './rules.js';

type Source = (typeof scoreChangeSources)[number];

/** May set a contact's score by hand: whoever may edit the contact's field values. */
const mayEditScore = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('fields.values');

/**
 * Moves the contact's score by an amount or to a value, kept within its bounds, and tells of
 * it when it moved. Gives the score before (null for none) and after.
 */
async function moveScore(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string,
  move: { readonly by: number } | { readonly to: number },
  source: Source,
): Promise<{ readonly previous: number | null; readonly score: number }> {
  const businessId = requireBusiness(command.context);
  const limit = SCORING_LIMITS.score;
  const start = 'to' in move ? move.to : move.by;
  // PostgreSQL 18 returns the row as it was beside the row as it is.
  const { rows } = await sql<{ previous: number | null; score: number }>`
    insert into crm.contact_scores as s (business_id, contact_id, score)
    values (${businessId}, ${contactId}, least(greatest(${start}::integer, ${-limit}), ${limit}))
    on conflict (business_id, contact_id) do update
      set score = ${
        'to' in move
          ? sql`excluded.score`
          : sql`least(greatest(s.score + ${move.by}::integer, ${-limit}), ${limit})`
      }
    returning old.score as previous, new.score as score
  `.execute(trx);
  const [row] = rows;
  if (row === undefined) throw new Error('The score was not stored.');
  if (row.previous !== row.score)
    await command.emit({
      type: 'contact.score_changed',
      subject: { kind: 'contact', id: contactId },
      records: [contactId],
      payload: {
        score: row.score,
        previous: row.previous,
        change: row.score - (row.previous ?? 0),
        source,
      },
    });
  return row;
}

const eventPayload = z.record(z.string(), z.unknown());

/**
 * Scores one stored event: each live contact the event is on gets what every live rule the
 * event passes gives, once per rule. An event stored before the rules were published is not
 * theirs to score: publishing scores only what contacts do from then on. Gives how many
 * contacts' scores moved.
 */
export async function scoreEvent(
  trx: DatabaseTransaction,
  command: CommandContext,
  eventId: string,
): Promise<number> {
  const businessId = requireBusiness(command.context);
  // Compared in the database: a JavaScript Date would drop the microseconds of both times.
  const event = await trx
    .selectFrom('events.events as event')
    .innerJoin('crm.score_profiles as profile', 'profile.business_id', 'event.business_id')
    .select([
      'event.id',
      'event.type',
      'event.payload',
      'event.command_id as commandId',
      'profile.live_rules',
    ])
    .where('event.id', '=', eventId)
    .where('event.business_id', '=', businessId)
    .whereRef('event.recorded_at', '>=', 'profile.published_at')
    .executeTakeFirst();
  if (event === undefined) return 0;
  const payload = eventPayload.safeParse(event.payload).data ?? {};
  const rules = (liveRules.safeParse(event.live_rules).data ?? []).filter((rule) =>
    rulePasses(rule, event.type, payload),
  );
  if (rules.length === 0) return 0;
  // The event's own contacts, out of the trash: a deal or a company it is on has no score.
  const contacts = await trx
    .selectFrom('crm.timeline_entries as entry')
    .innerJoin('crm.contacts as contact', (join) =>
      join
        .onRef('contact.business_id', '=', 'entry.business_id')
        .onRef('contact.id', '=', 'entry.record_id'),
    )
    .select('contact.id')
    .distinct()
    .where('entry.business_id', '=', businessId)
    .where('entry.event_id', '=', event.id)
    .where('contact.deleted_at', 'is', null)
    .orderBy('contact.id')
    .execute();
  const tagIds = [
    ...new Set(rules.flatMap((rule) => (rule.hasTagId === null ? [] : [rule.hasTagId]))),
  ];
  let moved = 0;
  for (const { id: contactId } of contacts) {
    const held =
      tagIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await trx
                .selectFrom('crm.record_tags')
                .select('tag_id')
                .where('business_id', '=', businessId)
                .where('record_id', '=', contactId)
                .where('tag_id', 'in', tagIds)
                .execute()
            ).map((row) => row.tag_id),
          );
    const scoring = rules.filter((rule) => rule.hasTagId === null || held.has(rule.hasTagId));
    if (scoring.length === 0) continue;
    // A rule that already scored this event for this contact finds its key taken.
    const kept = await trx
      .insertInto('crm.score_changes')
      .values(
        scoring.map((rule) => ({
          business_id: businessId,
          contact_id: contactId,
          source: 'rule',
          source_key: scoreKeyOf(rule, event, contactId),
          rule_id: rule.id,
          change: changeOf(rule),
          actor_kind: command.context.actorKind,
          actor_id: command.context.actorId ?? null,
        })),
      )
      .onConflict((conflict) =>
        conflict
          .columns(['business_id', 'contact_id', 'source_key'])
          .where('source_key', 'is not', null)
          .doNothing(),
      )
      .returning('change')
      .execute();
    const by = kept.reduce((sum, row) => sum + row.change, 0);
    if (kept.length === 0 || by === 0) continue;
    await moveScore(trx, command, contactId, { by }, 'rule');
    moved += 1;
  }
  return moved;
}

export const scoreEventReference = {
  name: 'scoring.from_event',
  data: z.strictObject({ eventId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/** Scoring an event as a command, so the change it makes is told of and audited. */
export const scoreEventCommand = defineCommand({
  name: 'crm.score.from_event',
  permission: 'fields.values',
  input: scoreEventReference.data,
  async handle(trx, input, command) {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the scoring job scores events.');
    return { contacts: await scoreEvent(trx, command, input.eventId) };
  },
});

/** The worker's job, queued by the database for each event the live rules listen to. */
export const scoreEventTask = defineTask({
  ...scoreEventReference,
  async run(data, { invocation, services }) {
    await runCommand(services, scoreEventCommand, data, invocation);
  },
});

/**
 * A workflow step's change to the contact's score: points added or subtracted, once for the
 * step's visit, which `key` names. Only the workflow engine runs it.
 */
export const modifyContactScoreCommand = defineCommand({
  name: 'crm.contact_score.modify',
  permission: 'fields.values',
  input: z.strictObject({
    id: publicId('contact'),
    calculation: z.enum(scoreCalculations),
    points: z.int().min(1).max(SCORING_LIMITS.points),
    key: z.string().min(1).max(180),
  }),
  audit: (input) => ({ id: input.id, calculation: input.calculation, points: input.points }),
  async handle(trx, input, command): Promise<{ score: number | null; changed: boolean }> {
    const businessId = requireBusiness(command.context);
    const contact = await lockLiveContact(trx, businessId, input.id);
    const change = input.calculation === 'add' ? input.points : -input.points;
    const kept = await trx
      .insertInto('crm.score_changes')
      .values({
        business_id: businessId,
        contact_id: contact.id,
        source: 'workflow',
        source_key: `step:${input.key}`,
        change,
        actor_kind: command.context.actorKind,
        actor_id: command.context.actorId ?? null,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['business_id', 'contact_id', 'source_key'])
          .where('source_key', 'is not', null)
          .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (kept === undefined)
      return { score: await scoreOf(trx, businessId, contact.id), changed: false };
    const moved = await moveScore(trx, command, contact.id, { by: change }, 'workflow');
    return { score: moved.score, changed: true };
  },
});

/** A person sets the contact's score, as GoHighLevel's score dropdown lets them. */
export const setContactScoreCommand = defineCommand({
  name: 'crm.contact_score.set',
  permission: 'fields.values',
  input: z.strictObject({ ...setContactScore.params.shape, ...setContactScoreInput.shape }),
  audit: (input) => ({ id: input.id, score: input.score }),
  async handle(trx, input, command): Promise<ContactScore> {
    const businessId = requireBusiness(command.context);
    const contact = await lockLiveContact(trx, businessId, input.id);
    const moved = await moveScore(trx, command, contact.id, { to: input.score }, 'person');
    if (moved.previous !== moved.score)
      await trx
        .insertInto('crm.score_changes')
        .values({
          business_id: businessId,
          contact_id: contact.id,
          source: 'person',
          change: moved.score - (moved.previous ?? 0),
          actor_kind: command.context.actorKind,
          actor_id: command.context.actorId ?? null,
        })
        .execute();
    return readContactScore(trx, command, input.id);
  },
});

async function scoreOf(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
): Promise<number | null> {
  const row = await trx
    .selectFrom('crm.contact_scores')
    .select('score')
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contactId)
    .executeTakeFirst();
  return row?.score ?? null;
}

const source = z.enum(scoreChangeSources);

/** The contact's score and its latest changes, or not found. */
export async function readContactScore(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<ContactScore> {
  const businessId = requireBusiness(invocation.context);
  const contactId = parsePublicId('contact', id);
  const contact =
    contactId === undefined
      ? undefined
      : await trx
          .selectFrom('crm.contacts')
          .select('id')
          .where('business_id', '=', businessId)
          .where('id', '=', contactId)
          .executeTakeFirst();
  if (contact === undefined) throw new NotFoundError('Contact', id);
  const score = await trx
    .selectFrom('crm.contact_scores')
    .select(['score', 'updated_at'])
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contact.id)
    .executeTakeFirst();
  const changes = await trx
    .selectFrom('crm.score_changes as change')
    .leftJoin('crm.score_rules as rule', (join) =>
      join
        .onRef('rule.business_id', '=', 'change.business_id')
        .onRef('rule.id', '=', 'change.rule_id'),
    )
    .select(['change.change', 'change.source', 'rule.id as rule_id', 'change.recorded_at'])
    .where('change.business_id', '=', businessId)
    .where('change.contact_id', '=', contact.id)
    .orderBy('change.recorded_at', 'desc')
    .orderBy('change.id', 'desc')
    .limit(CONTACT_SCORE_CHANGES)
    .execute();
  return {
    score: score?.score ?? null,
    updatedAt: score?.updated_at.toISOString() ?? null,
    changes: changes.map((row) => ({
      change: row.change,
      source: source.parse(row.source),
      ruleId: row.rule_id === null ? null : toPublicId('score_rule', row.rule_id),
      at: row.recorded_at.toISOString(),
    })),
    canEdit: mayEditScore(invocation),
  };
}

export const contactScoreRoutes: readonly ApiRoute[] = [
  {
    endpoint: getContactScore,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getContactScore.params, params);
      return withTenant(db, invocation.context, (trx) => readContactScore(trx, invocation, id));
    },
  } satisfies Route<typeof getContactScore>,
  {
    endpoint: setContactScore,
    command: setContactScoreCommand,
    run: async (request, services) => {
      const { id } = parseInput(setContactScore.params, request.params);
      // Another business's contact is not found, whatever was sent with it.
      requireBusiness(request.invocation.context);
      await withTenant(services.db, request.invocation.context, (trx) =>
        readContactScore(trx, request.invocation, id),
      );
      return runCommand(
        services,
        setContactScoreCommand,
        { id, ...parseInput(setContactScoreInput, request.body) },
        request.invocation,
      );
    },
  } satisfies Route<typeof setContactScore>,
];
