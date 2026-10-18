// Publishing, pausing and resuming (AUTOMATIONS.md section 5). Publishing makes the draft
// the new live version: only a draft that validates, and only the draft the caller saw.
// Pausing stops new enrolments; contacts already in it carry on.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  publishAutomationInput,
  validateAutomation,
  type Automation,
  type AutomationIssue,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { lockedDraft, readAutomation, type ReadSetup } from './drafts.js';
import { publishAutomationVersion } from './enrolment.js';
import { lockSentTemplates } from './setup.js';

const publishInput = publishAutomationInput.extend({ id: z.string() });
const statusInput = z.strictObject({ id: z.string() });

export interface LifecycleCommands {
  readonly publish: Command<typeof publishInput, Automation>;
  readonly pause: Command<typeof statusInput, Automation>;
  readonly resume: Command<typeof statusInput, Automation>;
}

const issuesAt = (issues: readonly AutomationIssue[]) =>
  issues.map((issue) => ({ ...issue, path: `/draft${issue.path}` }));

// Moves a published automation between active and paused; anything else is a conflict.
async function setStatus(
  trx: DatabaseTransaction,
  id: string,
  to: 'active' | 'paused',
): Promise<{ id: string; changed: boolean }> {
  const uuid = parsePublicId('automation', id);
  const row =
    uuid === undefined
      ? undefined
      : await trx
          .selectFrom('automation.automations')
          .select(['id', 'status'])
          .where('id', '=', uuid)
          .where('status', '<>', 'archived')
          .forUpdate()
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('automation', id);
  if (row.status === 'draft')
    throw new ConflictError(
      'Publish the automation first: there is nothing live to pause or resume.',
    );
  if (row.status === to) return { id: row.id, changed: false };
  await trx
    .updateTable('automation.automations')
    .set({ status: to, updated_at: sql<Date>`now()` })
    .where('id', '=', row.id)
    .execute();
  return { id: row.id, changed: true };
}

/** The lifecycle commands; publishing validates against the setup `setup` reads. */
export function createLifecycleCommands({ setup }: { setup: ReadSetup }): LifecycleCommands {
  const publish = defineCommand({
    name: 'automation.publish',
    permission: 'automations.publish',
    input: publishInput,
    async handle(trx, input, command): Promise<Automation> {
      const businessId = requireBusiness(command.context);
      const current = await lockedDraft(trx, input.id, input.baseDraftVersion);
      // Told which automation this is, the validator refuses a start that would loop.
      const result = validateAutomation(current.draft, await setup(trx, command.context), {
        automationId: toPublicId('automation', current.id),
      });
      const [first, ...rest] = issuesAt(result.errors);
      if (!result.valid || result.document === undefined)
        throw new ValidationError(
          first === undefined
            ? [{ path: '/draft', code: 'invalid_draft', message: 'Fix the draft first.' }]
            : [first, ...rest],
        );
      // A template deleted or archived since the setup was read can't go live.
      const [gone, ...alsoGone] = issuesAt(
        await lockSentTemplates(trx, businessId, result.document),
      );
      if (gone !== undefined) throw new ValidationError([gone, ...alsoGone]);
      // The resolved document: names become ids, so later renames can't change what runs.
      const { version } = await publishAutomationVersion(
        trx,
        command.context,
        current.id,
        result.document,
        input.changeSummary,
      );
      await command.emit({
        type: 'automation.published',
        subject: { kind: 'automation', id: current.id },
        records: [],
        payload: { version, draftVersion: current.draftVersion },
      });
      return readAutomation(trx, input.id);
    },
  });

  const statusCommand = (name: 'pause' | 'resume', to: 'active' | 'paused') =>
    defineCommand({
      name: `automation.${name}`,
      permission: 'automations.publish',
      input: statusInput,
      async handle(trx, input, command): Promise<Automation> {
        requireBusiness(command.context);
        const { id, changed } = await setStatus(trx, input.id, to);
        if (changed)
          await command.emit({
            type: name === 'pause' ? 'automation.paused' : 'automation.resumed',
            subject: { kind: 'automation', id },
            records: [],
            payload: {},
          });
        return readAutomation(trx, input.id);
      },
    });

  return {
    publish,
    pause: statusCommand('pause', 'paused'),
    resume: statusCommand('resume', 'active'),
  };
}
