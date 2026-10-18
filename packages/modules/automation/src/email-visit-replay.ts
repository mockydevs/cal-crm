import { requireBusiness } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

const recordedContent = z.object({
  emailContent: z.object({ binding: z.uuid(), revision: z.number().int().positive() }),
});

/** Reuse the admitted visit's frozen message and recorded revision, before reading mutable sources. */
export async function readEmailVisitReplay(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: {
    readonly contactId: string;
    readonly idempotencyKey: string;
    readonly enrolmentId?: string | undefined;
    readonly stepKey?: string;
  },
): Promise<
  | {
      id: string;
      emailContent?: { binding: string; revision: number };
    }
  | undefined
> {
  const businessId = requireBusiness(context);
  // The same visit must finish admission before a concurrent retry reads its message.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`automation-email:${businessId}:${input.idempotencyKey}`}, 0))`.execute(
    trx,
  );
  const existing = await trx
    .selectFrom('messaging.messages as message')
    .innerJoin('messaging.outbound_dispatch as dispatch', (join) =>
      join
        .onRef('dispatch.business_id', '=', 'message.business_id')
        .onRef('dispatch.id', '=', 'message.id'),
    )
    .innerJoin('messaging.conversations as conversation', (join) =>
      join
        .onRef('conversation.business_id', '=', 'message.business_id')
        .onRef('conversation.id', '=', 'message.conversation_id'),
    )
    .select([
      'message.id',
      'message.channel',
      'message.direction',
      'dispatch.lane',
      'dispatch.purpose',
      'conversation.contact_id',
    ])
    .where('message.business_id', '=', businessId)
    .where('message.idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (existing === undefined) return undefined;
  if (
    existing.contact_id !== input.contactId ||
    existing.channel !== 'email' ||
    existing.direction !== 'outbound' ||
    existing.lane !== 'automation' ||
    existing.purpose !== 'marketing'
  )
    throw new ConflictError('This workflow visit already identifies a different message.');
  if (input.enrolmentId === undefined || input.stepKey === undefined) return { id: existing.id };
  const recorded = await trx
    .selectFrom('automation.step_runs')
    .select('output')
    .where('enrolment_id', '=', input.enrolmentId)
    .where('step_key', '=', input.stepKey)
    .where(sql<string>`output->>'messageId'`, '=', existing.id)
    .executeTakeFirst();
  const content = recordedContent.safeParse(recorded?.output);
  return content.success
    ? { id: existing.id, emailContent: content.data.emailContent }
    : { id: existing.id };
}
