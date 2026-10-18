// Steps that change things: each runs the CRM's or messaging's own command handler, inside
// the step's command, so the same rules, events and audits apply as when a person does it.
// A refused action rolls back to before it and fails the step.
import type { CommandContext } from '@repo/commands';
import type { AutomationStep, RecordKind } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { AppError, isUuidV7, toPublicId, ValidationError } from '@repo/kernel';
import {
  addContactFollowersCommand,
  assignContactOwnerCommand,
  assignRecordTagCommand,
  readContactDetails,
  readFieldNormalizationContext,
  readRecordField,
  removeAllContactFollowersCommand,
  removeContactFollowersCommand,
  removeRecordTagCommand,
  setRecordFieldCommand,
  type TaskOptions,
} from '@repo/module-crm';
import { sql } from 'kysely';

import { removeFromAutomations, startAutomation } from './actions-automations.js';
import { runActionCommand } from './actions-command.js';
import { setStepDnd } from './actions-dnd.js';
import { assignStepOwner } from './actions-owner.js';
import { modifyStepScore } from './actions-score.js';
import { mergedText } from './actions-text.js';

import { updateContactFields, type FieldValue } from './actions-contact.js';
import {
  BUILT_IN_TARGETS,
  planFieldWrites,
  writesExplanation,
  type PlannedValue,
} from './contact-values.js';
import { closeStepDeal, createStepDeal, moveStepDeal, updateStepDeal } from './actions-deals.js';
import { findStepDeal, searchWords } from './deal-find.js';
import { keepDealInHand } from './deal-in-hand.js';
import { sendAutomationEmail, type MessageSendResult } from './actions-email.js';
import { sendTextMessage } from './actions-sms.js';
import { createStepTask } from './actions-task.js';
import { createStepNote } from './actions-note.js';
import { notifyStepTeam, type NotifyAutomationTeam } from './actions-notification.js';
import type { StepPlan } from './steps.js';
import { runValues } from './run-values.js';
import type { AppointmentLinks } from './appointment-values.js';

/** The record an enrolment is on, as the CRM's commands name it. */
export interface EnrolledRecord {
  readonly id: string;
  readonly kind: string;
}

/**
 * Which visit to which step this is, and when, so an action that must happen once can tell.
 * A step and what its actions write commit in one transaction, and the runner skips a visit
 * whose sequence has passed. So an action that only writes to the database happens exactly
 * once per visit without a key of its own: a job that runs again either finds the sequence
 * moved on, or follows a transaction that rolled back and kept nothing. Only what leaves the
 * database, such as a message handed to a sender, needs the visit as an idempotency key.
 */
export interface StepVisit {
  readonly enrolmentId: string;
  /** The automation the run is of: what a step keeps across runs is kept under it. */
  readonly automationId: string;
  readonly stepKey: string;
  readonly sequence: number;
  /** The step's own time: the clock's, or a fast-forwarded one. */
  readonly now: Date;
  /** The time zone the automation's settings name: the contact's, or the business's. */
  readonly timeZone: string;
}

/** What actions need from the modules the server composes, as the API's routes get them. */
export interface ActionOptions {
  readonly notifyTeam?: NotifyAutomationTeam | undefined;
  /** How the CRM's task command resolves assignees and names people. */
  readonly tasks: TaskOptions;
  /**
   * Whether this install can hand a text message to its provider: it has a vault for the
   * provider's credentials and a public address for delivery reports. Without it a text
   * message step fails rather than queue a message that could only be refused later.
   */
  readonly smsAvailable?: boolean | undefined;
  /**
   * PUBLIC_URL. A trigger link in a message becomes an address under it; without one a
   * message that writes a trigger link is not sent.
   */
  readonly publicUrl?: string | undefined;
  /**
   * What makes an appointment's reschedule-or-cancel link for appointment.manageUrl (the
   * calendar module's, migration 0107). Left out, as where the install serves no public
   * pages, the field is empty and a message takes its fallback.
   */
  readonly appointmentLinks?: AppointmentLinks | undefined;
}

/**
 * What an action came to: a plan as the planner makes one, or the end of its own run,
 * which only the step that removes the record from its own automation asks for. The step
 * is recorded as done, and the run ends as exited with the reason, so nothing of it runs on.
 */
export type ActionPlan =
  | StepPlan
  | {
      readonly kind: 'exit';
      readonly reason: string;
      readonly output: Readonly<Record<string, unknown>>;
      readonly explanation: string;
    };

const RECORD_KINDS: Readonly<Record<string, RecordKind>> = {
  contact: 'contact',
  company: 'company',
  deal: 'deal',
  custom: 'custom',
};

const publicIdOf = (kind: 'tag', id: string) => (isUuidV7(id) ? toPublicId(kind, id) : id);

const codeOf = (error: AppError) =>
  error instanceof ValidationError
    ? error.issues[0].code
    : error.name.replace(/Error$/, '').toLowerCase();

/**
 * Runs an action step, or says it isn't available yet. Returns undefined for steps that
 * aren't actions, which the planner decides.
 */
export async function runAction(
  trx: DatabaseTransaction,
  command: CommandContext,
  step: AutomationStep,
  record: EnrolledRecord,
  visit: StepVisit,
  options: ActionOptions,
): Promise<ActionPlan | undefined> {
  const next = typeof step.next === 'string' ? step.next : null;
  const kind = RECORD_KINDS[record.kind];
  // One savepoint per action: a refusal leaves the transaction as it was before it.
  const attemptWith = async (
    work: () => Promise<{
      readonly output: Readonly<Record<string, unknown>>;
      readonly explanation: string;
    }>,
  ): Promise<StepPlan> => {
    await sql`savepoint automation_action`.execute(trx);
    try {
      const done = await work();
      await sql`release savepoint automation_action`.execute(trx);
      return { kind: 'next', next, branch: null, ...done };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await sql`rollback to savepoint automation_action`.execute(trx);
      return {
        kind: 'fail',
        error: codeOf(error),
        explanation: `The ${step.type} step was refused: ${error.message}`,
      };
    }
  };
  const attempt = (work: () => Promise<unknown>, done: string): Promise<StepPlan> =>
    attemptWith(async () => {
      await work();
      return { output: {}, explanation: done };
    });
  // One message per visit to the step, however often its job runs.
  const visitKey = `automation:${visit.enrolmentId}:${visit.stepKey}:${String(visit.sequence)}`;
  // A refusal by messaging is stored on the message, so it must not be rolled back: only
  // an error thrown on the way undoes the action.
  const message = async (send: () => Promise<MessageSendResult>): Promise<StepPlan> => {
    await sql`savepoint automation_action`.execute(trx);
    try {
      const sent = await send();
      await sql`release savepoint automation_action`.execute(trx);
      return sent.ok
        ? {
            kind: 'next',
            next,
            branch: null,
            output: {
              messageId: sent.messageId,
              ...(sent.emailContent === undefined ? {} : { emailContent: sent.emailContent }),
            },
            explanation: sent.explanation,
          }
        : { kind: 'fail', error: sent.code, explanation: sent.explanation };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await sql`rollback to savepoint automation_action`.execute(trx);
      return {
        kind: 'fail',
        error: codeOf(error),
        explanation: `The ${step.type} step was refused: ${error.message}`,
      };
    }
  };
  const unsupported = (explanation: string): StepPlan => ({
    kind: 'fail',
    error: 'unsupported_record',
    explanation,
  });
  switch (step.type) {
    case 'dnd.set': {
      if (kind !== 'contact') return unsupported(`A ${record.kind} has no contact restrictions.`);
      return attempt(async () => {
        const reason = mergedText(
          { title: '', notes: step.config.reason },
          await runValues(trx, record.id, visit.enrolmentId),
        ).notes;
        await setStepDnd(trx, command, options.tasks, toPublicId('contact', record.id), {
          ...step.config,
          reason,
        });
      }, 'The contact restriction was updated.');
    }
    case 'team.notify': {
      if (options.notifyTeam === undefined)
        return {
          kind: 'fail',
          error: 'not_implemented',
          explanation: 'This install has no automation notification service.',
        };
      if (step.config.to === 'contact_owner' && kind !== 'contact')
        return unsupported(`A ${record.kind} has no contact owner to notify.`);
      const notify = options.notifyTeam;
      return attemptWith(async () => {
        const count = await notifyStepTeam(trx, command.context, notify, {
          enrolmentId: visit.enrolmentId,
          recordId: record.id,
          visitKey,
          to: step.config.to,
          message: step.config.message,
        });
        return { output: {}, explanation: `Notified ${String(count)} team members.` };
      });
    }
    case 'owner.assign': {
      if (kind !== 'contact') return unsupported(`A ${record.kind} has no contact owner.`);
      return attemptWith(() =>
        assignStepOwner(trx, command, options.tasks, {
          contactId: record.id,
          automationId: visit.automationId,
          stepKey: visit.stepKey,
          config: step.config,
        }),
      );
    }
    case 'owner.remove': {
      if (kind !== 'contact') return unsupported(`A ${record.kind} has no contact owner.`);
      return attempt(async () => {
        const id = toPublicId('contact', record.id);
        const details = await readContactDetails(trx, command, id, options.tasks);
        await runActionCommand(command, assignContactOwnerCommand(options.tasks), {
          id,
          owner: null,
          revision: details.ownerRevision,
        });
      }, "The contact's owner was removed.");
    }
    // Followers, through the CRM's own commands: someone who already follows is left as
    // they are, and so is someone the step removes who does not follow.
    case 'followers.add': {
      if (kind !== 'contact') return unsupported(`A ${record.kind} has no contact followers.`);
      const id = toPublicId('contact', record.id);
      return attempt(
        () =>
          runActionCommand(command, addContactFollowersCommand(options.tasks), {
            id,
            followers: step.config.users,
          }),
        'The followers were added to the contact.',
      );
    }
    case 'followers.remove': {
      if (kind !== 'contact') return unsupported(`A ${record.kind} has no contact followers.`);
      const id = toPublicId('contact', record.id);
      const config = step.config;
      return 'all' in config
        ? attempt(
            () =>
              runActionCommand(command, removeAllContactFollowersCommand(options.tasks), { id }),
            'Every follower was removed from the contact.',
          )
        : attempt(
            () =>
              runActionCommand(command, removeContactFollowersCommand(options.tasks), {
                id,
                followers: config.users,
              }),
            'The followers were removed from the contact.',
          );
    }
    case 'score.modify': {
      if (kind !== 'contact') return unsupported(`A ${record.kind} has no engagement score.`);
      return attemptWith(() => modifyStepScore(command, record, step.config, visit));
    }
    case 'tag.add':
    case 'tag.remove': {
      if (kind === undefined) return unsupported(`A ${record.kind} can't be tagged.`);
      const input = { id: toPublicId(kind, record.id), tagId: publicIdOf('tag', step.config.tag) };
      return step.type === 'tag.add'
        ? attempt(
            () => runActionCommand(command, assignRecordTagCommand, input),
            'The tag was added.',
          )
        : attempt(
            () => runActionCommand(command, removeRecordTagCommand, input),
            'The tag was removed.',
          );
    }
    case 'contact.update': {
      if (kind !== 'contact') return unsupported(`A ${record.kind} has no contact fields.`);
      return attemptWith(async () => {
        const id = toPublicId('contact', record.id);
        const fields = step.config.fields;
        const entries = Object.values(fields);
        // "Only when empty" is judged and written with the contact held still, so a value
        // someone saves at the same moment is never written over.
        if (
          entries.some(
            (entry) =>
              typeof entry === 'object' &&
              entry !== null &&
              'set' in entry &&
              entry.onlyIfEmpty === true,
          )
        )
          await sql`select 1 from crm.contacts where id = ${record.id} for update`.execute(trx);
        // The fields' kinds are read only when a value has to be fitted to one: a step of
        // fixed values is written as it always was.
        const worked = entries.some((entry) => {
          const written =
            typeof entry === 'object' && entry !== null && 'set' in entry ? entry.set : entry;
          return (
            (typeof written === 'object' && written !== null) ||
            (typeof written === 'string' && written.includes('{{'))
          );
        });
        const kinds = worked ? await readFieldNormalizationContext(trx, command) : undefined;
        const planned = planFieldWrites(
          fields,
          await runValues(trx, record.id, visit.enrolmentId),
          {
            now: visit.now,
            timeZone: visit.timeZone,
            target: (path) => {
              const definition = kinds?.definitions.find(
                (field) => `contact.custom.${field.key}` === path,
              );
              return (
                BUILT_IN_TARGETS[path] ??
                (definition === undefined
                  ? undefined
                  : { type: definition.valueType, options: definition.options })
              );
            },
          },
        );
        const builtIn: Record<string, FieldValue> = {};
        const custom: [path: string, key: string, value: PlannedValue][] = [];
        for (const [path, value] of Object.entries(planned.writes))
          if (path.startsWith('contact.custom.'))
            custom.push([path, path.slice('contact.custom.'.length), value]);
          // The contact's own fields take text; a list never comes out for one of them.
          else
            builtIn[path] = typeof value === 'object' && value !== null ? value.join(', ') : value;
        // Built-in fields change together through the contact command: one event for them all.
        await updateContactFields(trx, command, id, builtIn);
        for (const [path, key, value] of custom) {
          const field = await trx
            .selectFrom('crm.field_definitions as field')
            .innerJoin('crm.object_types as type', 'type.id', 'field.object_type_id')
            .select('field.id')
            .where('type.kind', '=', 'contact')
            .where('field.key', '=', key)
            .executeTakeFirst();
          if (field === undefined)
            throw new ValidationError([
              {
                path: `/config/fields/${path}`,
                code: 'unknown_field',
                message: `${path} is not a field.`,
              },
            ]);
          const fieldId = toPublicId('field', field.id);
          // The CRM's own read gives the revision its write checks, so nothing is guessed.
          const current = await readRecordField(trx, command, id, fieldId);
          await runActionCommand(command, setRecordFieldCommand, {
            id,
            fieldId,
            // The CRM takes numbers as decimal text, so no precision is lost on the way.
            value: typeof value === 'number' ? String(value) : value,
            revision: current.revision,
          });
        }
        return {
          output: {},
          explanation: writesExplanation(
            planned,
            'The contact fields were updated.',
            'No field was changed.',
          ),
        };
      });
    }
    case 'note.create': {
      if (kind === undefined) return unsupported(`A ${record.kind} can't have notes.`);
      return attemptWith(async () => ({
        output: await createStepNote(
          command,
          options.tasks,
          { id: record.id, kind },
          step.config.text,
          await runValues(trx, record.id, visit.enrolmentId),
        ),
        explanation: 'The note was created.',
      }));
    }
    case 'task.create': {
      if (kind === undefined) return unsupported(`A ${record.kind} can't have tasks.`);
      return attemptWith(async () => ({
        output: await createStepTask(trx, command, options.tasks, {
          record: { id: record.id, kind },
          config: step.config,
          values: await runValues(trx, record.id, visit.enrolmentId),
          now: visit.now,
        }),
        explanation: 'The task was created.',
      }));
    }
    case 'deal.create': {
      if (kind !== 'contact')
        return unsupported(`A deal is created for a contact, not a ${record.kind}.`);
      return attemptWith(async () => {
        const { dealId, explanation } = await createStepDeal(trx, command, {
          contactId: record.id,
          enrolmentId: visit.enrolmentId,
          config: step.config,
          typeVersion: step.typeVersion,
          values: await runValues(trx, record.id, visit.enrolmentId),
        });
        return { output: { dealId }, explanation };
      });
    }
    case 'deal.find': {
      if (kind !== 'contact')
        return unsupported(
          `A deal is looked for among a contact's deals, and this run is for a ${record.kind}.`,
        );
      // A read, and one write to the run's own row: nothing of it can be refused.
      const found = await findStepDeal(trx, command, record.id, step.config);
      if (found !== undefined) await keepDealInHand(trx, visit.enrolmentId, found.id);
      const branch = found === undefined ? 'not_found' : 'found';
      const target: unknown =
        typeof step.next === 'object'
          ? (step.next as Readonly<Record<string, unknown>>)[branch]
          : undefined;
      const words = searchWords(step.config);
      return {
        kind: 'next',
        next: typeof target === 'string' ? target : null,
        branch,
        output: found === undefined ? {} : { dealId: toPublicId('deal', found.id) },
        explanation:
          found === undefined
            ? `None of the contact's deals passed (${words}), so the not_found branch was taken.`
            : `Found "${found.name}", the ${step.config.which} of the contact's deals that pass (${words}). The run has it in hand: its later deal steps act on it.`,
      };
    }
    case 'deal.move':
    case 'deal.close': {
      if (kind !== 'contact' && kind !== 'deal')
        return unsupported(`A ${record.kind} has no deal for this step.`);
      const subject = { id: record.id, kind };
      return attemptWith(async () => ({
        output: {},
        explanation:
          step.type === 'deal.move'
            ? await moveStepDeal(trx, command, subject, visit.enrolmentId, step.config)
            : await closeStepDeal(trx, command, subject, visit.enrolmentId, step.config),
      }));
    }
    case 'deal.update': {
      if (kind !== 'contact' && kind !== 'deal')
        return unsupported(`A ${record.kind} has no deal for this step.`);
      const subject = { id: record.id, kind };
      return attemptWith(async () => {
        const { dealId, explanation } = await updateStepDeal(trx, command, options.tasks, {
          subject,
          enrolmentId: visit.enrolmentId,
          config: step.config,
          values: await runValues(trx, record.id, visit.enrolmentId),
          now: visit.now,
          timeZone: visit.timeZone,
        });
        return { output: { dealId }, explanation };
      });
    }
    case 'automation.run':
      return attemptWith(() =>
        startAutomation(
          trx,
          command,
          { enrolmentId: visit.enrolmentId, stepKey: visit.stepKey, recordId: record.id },
          step.config,
        ),
      );
    case 'automation.remove': {
      // Set when the step removes the record from its own automation too.
      const own: { reason?: string } = {};
      const plan = await attemptWith(async () => {
        const done = await removeFromAutomations(
          trx,
          command,
          { enrolmentId: visit.enrolmentId, stepKey: visit.stepKey, recordId: record.id },
          step.config,
        );
        if (done.endsOwn) own.reason = done.reason;
        return { output: done.output, explanation: done.explanation };
      });
      return plan.kind === 'next' && own.reason !== undefined
        ? { kind: 'exit', reason: own.reason, output: plan.output, explanation: plan.explanation }
        : plan;
    }
    // Not actions: the planner decides these.
    case 'wait':
    case 'wait.until':
    case 'wait.event':
    case 'wait.condition':
    case 'wait.appointment':
    case 'condition':
    case 'split':
    case 'goto':
    case 'goal':
      return undefined;
    case 'email.send':
      if (kind !== 'contact') return unsupported(`A ${record.kind} can't be emailed.`);
      return message(() =>
        sendAutomationEmail(trx, command.context, {
          ...step.config,
          contactId: record.id,
          enrolmentId: visit.enrolmentId,
          mailbox: step.config.mailbox,
          stepKey: visit.stepKey,
          idempotencyKey: visitKey,
          publicUrl: options.publicUrl,
          appointmentLinks: options.appointmentLinks,
        }),
      );
    case 'sms.send':
      if (kind !== 'contact') return unsupported(`A ${record.kind} can't be sent a text.`);
      return message(() =>
        sendTextMessage(trx, command.context, {
          contactId: record.id,
          message: step.config.message,
          enrolmentId: visit.enrolmentId,
          number: step.config.number,
          purpose: step.config.purpose,
          idempotencyKey: visitKey,
          available: options.smsAvailable === true,
          publicUrl: options.publicUrl,
          appointmentLinks: options.appointmentLinks,
        }),
      );
    // Actions the engine can't run yet (UNAVAILABLE_STEPS in steps.ts says why): the setup
    // reports them, so the validator refuses a document that uses one, and the planner
    // fails one that is reached anyway as not_implemented.
    // A webhook and a manual action are not here for that reason: each waits on something
    // outside the step, and the runner visits it itself (webhook-task.ts, manual-actions.ts).
    case 'whatsapp.send':
    case 'ai.ask':
    case 'ai.classify':
    case 'ai.draft_reply':
    case 'webhook.call':
    case 'email.verify':
    case 'manual.call':
    case 'manual.sms':
      return undefined;
  }
}
