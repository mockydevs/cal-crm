// The files a contact's conversation holds, for the contact's Documents panel: Sent for
// files attached to messages sent to the contact, Received for those the contact sent.
// Pictures placed inside an email's body are part of that email, not documents.
import { actorKinds } from '@repo/kernel';
import { INSTANT_TEXT, type MessageAttachments } from '@repo/module-crm';
import { sql } from 'kysely';

/** A search as a LIKE pattern: the text anywhere, with its own % and _ taken literally. */
const containing = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

interface Row {
  readonly file_id: string;
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: string;
  readonly attached_at: string;
  readonly direction: 'inbound' | 'outbound';
  readonly author_kind: string;
  readonly author_id: string | null;
}

/** A file once, at the first message that carried it. */
const attachments = (contactId: string) => sql`
  select distinct on (a.file_id)
    a.file_id, f.filename, f.content_type, f.size_bytes,
    to_char(a.created_at at time zone 'UTC', ${INSTANT_TEXT}) as attached_at,
    m.direction, m.author_kind, m.author_id
  from messaging.message_attachments a
  join messaging.messages m on m.business_id = a.business_id and m.id = a.message_id
  join messaging.conversations c on c.business_id = m.business_id and c.id = m.conversation_id
  join files.files f on f.business_id = a.business_id and f.id = a.file_id
  where c.contact_id = ${contactId}
    and m.direction in ('inbound', 'outbound')
    and a.content_id is null
    and f.deleted_at is null
  order by a.file_id, a.created_at, a.id`;

export const contactAttachments: MessageAttachments = {
  async list(trx, query) {
    const { rows } = await sql<Row>`
      select * from (${attachments(query.contactId)}) as found
      where true
        ${query.direction === undefined ? sql`` : sql`and found.direction = ${query.direction}`}
        ${query.q === undefined || query.q === '' ? sql`` : sql`and found.filename ilike ${containing(query.q)}`}
        ${
          query.after === undefined
            ? sql``
            : sql`and (found.attached_at, found.file_id) < (${query.after.at}, ${query.after.fileId}::uuid)`
        }
      order by found.attached_at desc, found.file_id desc
      limit ${query.limit}`.execute(trx);
    return rows.map((row) => ({
      fileId: row.file_id,
      filename: row.filename,
      contentType: row.content_type,
      size: Number(row.size_bytes),
      attachedAt: row.attached_at,
      direction: row.direction,
      authorKind: actorKinds.find((kind) => kind === row.author_kind) ?? 'system',
      authorId: row.author_id,
    }));
  },

  async has(trx, contactId, fileId) {
    const { rows } = await sql<{ file_id: string }>`
      select a.file_id
      from messaging.message_attachments a
      join messaging.messages m on m.business_id = a.business_id and m.id = a.message_id
      join messaging.conversations c on c.business_id = m.business_id and c.id = m.conversation_id
      join files.files f on f.business_id = a.business_id and f.id = a.file_id
      where c.contact_id = ${contactId} and a.file_id = ${fileId}::uuid
        and m.direction in ('inbound', 'outbound')
        and a.content_id is null
        and f.deleted_at is null
      limit 1`.execute(trx);
    return rows.length > 0;
  },
};
