// Test runs (AUTOMATIONS.md section 5): the draft run on a real or sample contact, with
// simulated events and time fast-forwarded, by the same planner as real runs. Nothing is
// sent, written or charged; only the trace and its outcome are stored.
import { defineCommand, requireBusiness } from '@repo/commands';
import {
  automationDocument,
  automationTestRun,
  createAutomationTestRunInput,
  type AutomationDocument,
  type AutomationTestRun,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';
import { readFieldNormalizationContext } from '@repo/module-crm';
import type { EmailParts } from '@repo/module-messaging';

import { arrivalFromLatest, touchValues } from './attribution-values.js';
import { findStepDeal } from './deal-find.js';
import { timeZoneOf } from './time-zone.js';
import { simulateAutomation } from './simulate.js';
import type { SimulatedDeal } from './simulate-deals.js';
import { contactValues, dealValues } from './values.js';
import { readWaitedAppointment } from './waits.js';

export const testRunInput = createAutomationTestRunInput.extend({ id: z.string() });

/**
 * What each Send email step of a draft would send, read as a send reads it: the step's own
 * words, or its template as it is now, with the step's own subject and preview line over
 * the template's (actions-email.ts). A template that is gone or archived is 'unavailable',
 * as it fails a send. A template is named by id, or by name in a draft not yet checked.
 */
async function emailsToFill(
  trx: DatabaseTransaction,
  document: AutomationDocument,
): Promise<Record<string, EmailParts | 'unavailable'>> {
  const emails: Record<string, EmailParts | 'unavailable'> = {};
  for (const [key, step] of Object.entries(document.steps)) {
    if (step.type !== 'email.send') continue;
    const config = step.config;
    const preheader = config.preheader;
    if ('body' in config) {
      emails[key] = {
        subject: config.subject,
        text: config.body,
        html: config.html ?? null,
        preheader: preheader ?? null,
      };
      continue;
    }
    const reference = 'template' in config ? config.template : config.source.id;
    const id = parsePublicId('template', reference);
    const template = await trx
      .selectFrom('messaging.templates')
      .select(['subject', 'body', 'body_html', 'preheader'])
      .where('channel', '=', 'email')
      .where('archived_at', 'is', null)
      .where(id === undefined ? 'name' : 'id', '=', id ?? reference)
      .executeTakeFirst();
    emails[key] =
      template === undefined
        ? 'unavailable'
        : {
            subject: config.subject ?? template.subject,
            text: template.body,
            html: template.body_html,
            preheader: preheader ?? template.preheader,
          };
  }
  return emails;
}

/** A stored test run of this automation, or a 404 when either isn't this business's. */
export async function readTestRun(
  trx: DatabaseTransaction,
  id: string,
  runId: string,
): Promise<AutomationTestRun> {
  const automationId = parsePublicId('automation', id);
  const uuid = parsePublicId('automation_test_run', runId);
  const row =
    automationId === undefined || uuid === undefined
      ? undefined
      : await trx
          .selectFrom('automation.test_runs')
          .select([
            'id',
            'draft_revision',
            'status',
            'sample_record_id',
            'trace',
            'outcome',
            'created_at',
          ])
          .where('id', '=', uuid)
          .where('automation_id', '=', automationId)
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('automation_test_run', runId);
  // Parsed, not assumed: the stored JSON is checked against the contract on the way out.
  return automationTestRun.parse({
    id: toPublicId('automation_test_run', row.id),
    draftVersion: row.draft_revision,
    status: row.status,
    contactId: row.sample_record_id === null ? null : toPublicId('contact', row.sample_record_id),
    steps: row.trace,
    outcome: row.outcome,
    createdAt: row.created_at.toISOString(),
  });
}

export const testRunCommand = defineCommand({
  name: 'automation.test',
  delegation: { action: 'build_draft' },
  permission: 'automations.manage',
  input: testRunInput,
  audit: ({ id, contactId }) => ({ automationId: id, contactId: contactId ?? null }),
  async handle(trx, input, command): Promise<AutomationTestRun> {
    const businessId = requireBusiness(command.context);
    const automationId = parsePublicId('automation', input.id);
    const automation =
      automationId === undefined
        ? undefined
        : await trx
            .selectFrom('automation.automations')
            .select(['id', 'draft', 'draft_revision'])
            .where('id', '=', automationId)
            // A deleted automation is tested again once it is restored.
            .where('status', '<>', 'archived')
            .executeTakeFirst();
    if (automation === undefined) throw new NotFoundError('automation', input.id);
    const parsed = automationDocument.safeParse(automation.draft);
    if (!parsed.success)
      throw new ValidationError([
        { path: '/draft', code: 'invalid_draft', message: 'Fix the draft before testing it.' },
      ]);
    const contactId =
      input.contactId === undefined ? undefined : parsePublicId('contact', input.contactId);
    if (input.contactId !== undefined && contactId === undefined)
      throw new NotFoundError('contact', input.contactId);
    // A test run has no event of its own, so "how this lead arrived" is read as the
    // contact's latest touch: what a run started by their newest form or booking would read.
    // A sample contact has no touch, and every attribution path is there and empty.
    const held = contactId === undefined ? {} : await contactValues(trx, contactId);
    const values = {
      ...touchValues('first', undefined),
      ...touchValues('latest', undefined),
      ...held,
      ...arrivalFromLatest(held),
      ...input.values,
    };
    // What the steps that start or end other automations can know of them in a test run.
    const automations = await trx
      .selectFrom('automation.automations')
      .select(['id', 'name', 'status'])
      .where('business_id', '=', businessId)
      .execute();
    // Whose turn it is at the steps that share contacts between team members, and whether
    // the contact has an owner: read here, and nothing of it is moved by a test run.
    const turns = await sql<{ step_key: string; next_position: number }>`
      select step_key, next_position from automation.assignment_cursors
      where business_id = ${businessId} and automation_id = ${automation.id}
    `.execute(trx);
    const owner =
      contactId === undefined
        ? undefined
        : await trx
            .selectFrom('crm.contacts')
            .select('owner_user_id')
            .where('id', '=', contactId)
            .executeTakeFirst();
    // What each deal.find step would find for the contact as things are now, read by the
    // step's own query, and the names a deal's pipeline and stage go by.
    const found: Record<string, SimulatedDeal | null> = {};
    if (contactId !== undefined)
      for (const [key, step] of Object.entries(parsed.data.steps))
        if (step.type === 'deal.find') {
          const deal = await findStepDeal(trx, command, contactId, step.config);
          found[key] =
            deal === undefined
              ? null
              : { id: toPublicId('deal', deal.id), values: await dealValues(trx, deal.id) };
        }
    const named = await sql<{ id: string; name: string; kind: 'pipeline' | 'stage' }>`
      select id, name, 'pipeline' as kind from crm.pipelines where business_id = ${businessId}
      union all
      select id, name, 'stage' as kind from crm.pipeline_stages where business_id = ${businessId}
    `.execute(trx);
    const emails = await emailsToFill(trx, parsed.data);
    const start = input.start === undefined ? new Date() : new Date(input.start);
    const trace = simulateAutomation({
      document: parsed.data,
      values,
      events: input.events,
      start,
      // What a wait for an appointment would wait for: the real contact's next one. A
      // sample has none.
      appointment:
        contactId === undefined
          ? null
          : await readWaitedAppointment(trx, { recordId: contactId, now: start }),
      // The zone a real run of this contact would use; a sample has only the business's.
      timeZone: await timeZoneOf(trx, businessId, contactId, parsed.data.settings.timezone),
      deals:
        contactId === undefined
          ? undefined
          : {
              found,
              names: Object.fromEntries(
                named.rows.map((row) => [toPublicId(row.kind, row.id), row.name]),
              ),
            },
      ownership: {
        hasOwner: owner !== undefined && owner.owner_user_id !== null,
        turns: Object.fromEntries(turns.rows.map((row) => [row.step_key, row.next_position])),
      },
      emails,
      enrolmentId: `test:${automation.id}`,
      automationId: toPublicId('automation', automation.id),
      automations: automations.map((each) => ({
        id: toPublicId('automation', each.id),
        name: each.name,
        active: each.status === 'active',
      })),
      fields: await readFieldNormalizationContext(trx, command),
      tags: (
        await trx
          .selectFrom('crm.tags')
          .select(['id', 'name'])
          .where('business_id', '=', businessId)
          .execute()
      ).map((tag) => ({ id: toPublicId('tag', tag.id), name: tag.name })),
    });
    const { id } = await trx
      .insertInto('automation.test_runs')
      .values({
        business_id: businessId,
        automation_id: automation.id,
        draft_revision: automation.draft_revision,
        sample_record_id: contactId ?? null,
        status:
          trace.outcome.kind === 'failed' || trace.outcome.kind === 'limit' ? 'failed' : 'passed',
        trace: JSON.stringify(trace.steps),
        outcome: JSON.stringify(trace.outcome),
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
        finished_at: sql<Date>`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return readTestRun(trx, input.id, toPublicId('automation_test_run', id));
  },
});
