// What the business's matching lead source rules add to a contact (lead-source-rules.ts):
// their tags and their field values, through the CRM's own commands, so each is on the
// timeline and automations see it. Each in a savepoint, as a form's own tags are: a tag
// deleted or a field archived since the rule was saved is skipped, and the lead is kept.
import type { CommandContext } from '@repo/commands';
import { LEAD_SOURCE_LIMITS } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { AppError, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { readRecordField } from '../fields/value-read.js';
import { setRecordFieldCommand } from '../fields/value-writes.js';
import { assignRecordTagCommand } from '../tags/assignments.js';
import type { LeadDecision } from './lead-source-rules.js';

async function attempt(trx: DatabaseTransaction, work: () => Promise<unknown>): Promise<void> {
  await sql`savepoint lead_source_rule`.execute(trx);
  try {
    await work();
    await sql`release savepoint lead_source_rule`.execute(trx);
  } catch (error) {
    await sql`rollback to savepoint lead_source_rule`.execute(trx);
    await sql`release savepoint lead_source_rule`.execute(trx);
    if (!(error instanceof AppError)) throw error;
  }
}

/**
 * Adds the rules' tags to the contact and fills the rules' fields. `contactId` is
 * crm.contacts.id. `tagRoom` is how many tags may still be added to this lead: one lead
 * gets at most LEAD_SOURCE_LIMITS.tagsPerSubmission, whatever adds them, and a form's own
 * tags and the lead source's tag come first.
 */
export async function applyLeadSourceRules(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string,
  decision: Pick<LeadDecision, 'tagIds' | 'fieldWrites'>,
  tagRoom: number = LEAD_SOURCE_LIMITS.tagsPerSubmission,
): Promise<void> {
  const record = toPublicId('contact', contactId);
  for (const write of decision.fieldWrites) {
    const fieldId = toPublicId('field', write.fieldId);
    await attempt(trx, async () => {
      const current = await readRecordField(trx, command, record, fieldId);
      // Already what the rule would write: nothing to say on the timeline.
      if (current.value === write.value) return;
      await setRecordFieldCommand.handle(
        trx,
        { id: record, fieldId, value: write.value, revision: current.revision },
        command,
      );
    });
  }
  for (const tagId of decision.tagIds.slice(0, Math.max(0, tagRoom)))
    await attempt(trx, () =>
      assignRecordTagCommand.handle(trx, { id: record, tagId: toPublicId('tag', tagId) }, command),
    );
}
