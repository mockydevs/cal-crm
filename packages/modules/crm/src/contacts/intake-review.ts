// What a public submission said that the contact did not take, as a note on the contact for
// the team to read and accept by hand. A note, not an event: it holds what the visitor
// typed, and events can't be erased, while a note goes with its contact when the contact is
// purged.
import { requireBusiness, type CommandContext } from '@repo/commands';
import type { NoteDocument } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';

/** Who sent the details, in the note's first words. */
export type IntakeVia = 'form' | 'booking' | 'public';

const heading: Readonly<Record<IntakeVia, string>> = {
  form: 'A form submission sent details that were not applied to this contact:',
  booking: 'A booking sent details that were not applied to this contact:',
  public: 'A public submission sent details that were not applied to this contact:',
};

const CLOSING =
  'Nobody has confirmed these details belong to this contact. Edit the contact to accept any of them.';

/** A one-line text, as a note holds it: control characters become spaces. */
function line(text: string): NoteDocument['content'][number] {
  const clean = text.replace(/\p{Cc}/gu, ' ');
  return { type: 'paragraph', content: [{ type: 'text', text: clean }] };
}

/**
 * Writes the note, in the caller's transaction, as the actor the submission runs as, and
 * puts it on the contact's timeline. Nothing is written when there is nothing to say.
 */
export async function writeIntakeReview(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string,
  lines: readonly string[],
  via: IntakeVia,
): Promise<void> {
  if (lines.length === 0) return;
  const businessId = requireBusiness(command.context);
  const body: NoteDocument = {
    type: 'doc',
    content: [line(heading[via]), ...lines.map((each) => line(`- ${each}`)), line(CLOSING)],
  };
  const text = [heading[via], ...lines.map((each) => `- ${each}`), CLOSING].join('\n');
  const note = await trx
    .insertInto('crm.notes')
    .values({
      business_id: businessId,
      record_id: contactId,
      body: JSON.stringify(body),
      body_text: text,
      author_kind: command.context.actorKind,
      author_id: command.context.actorId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await command.emit({
    type: 'note.created',
    subject: { kind: 'note', id: note.id },
    records: [contactId],
    payload: { recordId: toPublicId('contact', contactId) },
  });
}
