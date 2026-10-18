// How much each assistant does on its own: the rules a business sets, for itself or for one
// contact. Suggest, ask first or act, per assistant and kind of action. The command layer
// reads these rows before an assistant runs anything (packages/commands/src/autonomy.ts);
// here they are shown and changed.
//
// Changing a level needs `ai.manage`: moving an assistant to "act" lets it send in the
// business's name without a person, which is a decision for whoever sets up AI.
import {
  defineCommand,
  readAutonomy,
  requireBusiness,
  type Command,
  type Invocation,
} from '@repo/commands';
import {
  setAutonomyInput,
  type AiAgent,
  type AutonomyAction,
  type AutonomySetting,
  type AutonomySettings,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { requireRecord } from '@repo/module-crm';

/**
 * The assistants that act today, and the kind of action each has a rule for. Settings
 * lists these; a rule for any other pair can be stored and is read by the command layer,
 * and shows here once an assistant uses it.
 */
export const AUTONOMY_SUBJECTS: readonly {
  readonly agent: AiAgent;
  readonly action: AutonomyAction;
}[] = [
  { agent: 'inbox', action: 'send_message' },
  // What the extraction assistant reads from a conversation: a value for a field, and a
  // fact to keep. Each starts at asking first, like every action.
  { agent: 'extraction', action: 'update_field' },
  { agent: 'extraction', action: 'remember_fact' },
  // The in-app assistant: building drafts starts at acting, publishing at asking. Whatever
  // the level for publishing, the assistant itself only ever proposes it.
  { agent: 'copilot', action: 'build_draft' },
  { agent: 'copilot', action: 'publish' },
];

const mayChange = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('ai.manage');

/** The level in force for one assistant and action, for the business or one contact. */
export async function readAutonomySetting(
  trx: DatabaseTransaction,
  subject: { readonly agent: AiAgent; readonly action: AutonomyAction },
  contactId?: string,
): Promise<AutonomySetting> {
  // Only the two names: a caller's object may hold more, and none of it belongs here.
  const { agent, action } = subject;
  const decision = await readAutonomy(trx, {
    agent,
    action,
    ...(contactId === undefined ? {} : { contactId }),
  });
  return { agent, action, ...decision };
}

/** Every listed assistant's level, for the business, or for the contact when one is given. */
export async function readAutonomySettings(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicContactId?: string,
): Promise<AutonomySettings> {
  requireBusiness(invocation.context);
  // CRM's reader applies its own visibility rules: a contact of another business is not found.
  const contactId =
    publicContactId === undefined ? undefined : (await requireRecord(trx, publicContactId)).id;
  const items: AutonomySetting[] = [];
  for (const subject of AUTONOMY_SUBJECTS)
    items.push(await readAutonomySetting(trx, subject, contactId));
  return { canChange: mayChange(invocation), items };
}

export function setAutonomyCommand(): Command<typeof setAutonomyInput, AutonomySetting> {
  return defineCommand({
    name: 'ai.set_autonomy',
    permission: 'ai.manage',
    input: setAutonomyInput,
    async handle(trx, input, command): Promise<AutonomySetting> {
      const businessId = requireBusiness(command.context);
      const contactId =
        input.contactId === null ? null : (await requireRecord(trx, input.contactId)).id;
      const before = await readAutonomySetting(trx, input, contactId ?? undefined);
      if (input.level === null) {
        const rule = trx
          .deleteFrom('ai.autonomy_rules')
          .where('agent', '=', input.agent)
          .where('action', '=', input.action);
        await (
          contactId === null
            ? rule.where('contact_id', 'is', null)
            : rule.where('contact_id', '=', contactId)
        ).execute();
      } else {
        const { level } = input;
        // One rule for an assistant, an action and a contact: the table's unique constraint
        // counts "no contact" as a value, so two people saving at once leave one rule.
        await trx
          .insertInto('ai.autonomy_rules')
          .values({
            business_id: businessId,
            agent: input.agent,
            action: input.action,
            contact_id: contactId,
            level,
            updated_by_id: command.context.userId ?? null,
          })
          .onConflict((conflict) =>
            conflict
              .constraint('autonomy_rules_unique')
              .doUpdateSet({ level, updated_by_id: command.context.userId ?? null }),
          )
          .execute();
      }
      const after = await readAutonomySetting(trx, input, contactId ?? undefined);
      if (after.level !== before.level || after.source !== before.source)
        await command.emit({
          type: 'autonomy.changed',
          subject:
            contactId === null
              ? { kind: 'business', id: businessId }
              : { kind: 'contact', id: contactId },
          payload: {
            agent: input.agent,
            action: input.action,
            contactId: input.contactId,
            from: before.level,
            to: after.level,
          },
          ...(contactId === null ? {} : { records: [contactId] }),
        });
      return after;
    },
  });
}
