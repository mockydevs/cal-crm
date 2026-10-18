import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation, type Command } from '@repo/commands';
import {
  createNote,
  createNoteInput,
  updateNote,
  updateNoteInput,
  deleteNote,
  deleteNoteInput,
  listRecordNotes,
  noteDocument,
  type Note,
  type NoteDocument,
  type RecordNotes,
  type RecordKind,
} from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import {
  actorKinds,
  parsePublicId,
  toPublicId,
  ValidationError,
  ConflictError,
  NotFoundError,
} from '@repo/kernel';
import { sql, type Selectable } from 'kysely';
import type * as z from 'zod';
import type { ActorNames } from '../activity/activity.js';
import { requireRecord } from '../records/access.js';

type NoteRow = Selectable<DB['crm.notes']> & { version: string };
const version = sql<string>`extract(epoch from updated_at)::text`.as('version');
const createCommandInput = createNoteInput.extend(createNote.params.shape);
const updateCommandInput = updateNoteInput.extend(updateNote.params.shape);

function revisionOf(row: NoteRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.record_id,
        row.version,
        noteDocument.parse(row.body),
        row.author_kind,
        row.author_id,
        row.edited_by_kind,
        row.edited_by_id,
        row.edited_at?.toISOString() ?? null,
      ]),
    )
    .digest('hex');
}

/** Scope the note to the already-visible record before inspecting caller content. */
export async function requireNote(
  trx: DatabaseTransaction,
  recordId: string,
  noteId: string,
  lock = false,
): Promise<NoteRow> {
  const uuid = parsePublicId('note', noteId);
  if (uuid === undefined) throw new NotFoundError('Note', noteId);
  let query = trx
    .selectFrom('crm.notes')
    .selectAll()
    .select(version)
    .where('record_id', '=', recordId)
    .where('id', '=', uuid);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Note', noteId);
  return row;
}

function checkRevision(row: NoteRow, revision: string): void {
  if (revisionOf(row) !== revision)
    throw new ConflictError('This note changed. Refresh it before saving or deleting.');
}

function plainText(document: NoteDocument): string {
  return document.content
    .map((paragraph) =>
      (paragraph.content ?? []).map((node) => (node.type === 'text' ? node.text : '\n')).join(''),
    )
    .join('\n');
}

async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly NoteRow[],
  kind: RecordKind,
  actorNames: ActorNames,
): Promise<Note[]> {
  // Authors and editors together: one lookup for each kind of actor on the page.
  const names = new Map<string, string>();
  for (const actorKind of actorKinds) {
    const lookup = actorNames[actorKind];
    const ids = [
      ...new Set(
        rows.flatMap((row) => [
          ...(row.author_kind === actorKind && row.author_id !== null ? [row.author_id] : []),
          ...(row.edited_by_kind === actorKind && row.edited_by_id !== null
            ? [row.edited_by_id]
            : []),
        ]),
      ),
    ];
    if (lookup !== undefined && ids.length > 0)
      for (const [id, name] of await lookup(trx, ids)) names.set(`${actorKind}:${id}`, name);
  }
  const actorOf = (storedKind: string, id: string | null): Note['author'] => {
    const actorKind = actorKinds.find((each) => each === storedKind);
    if (actorKind === undefined) throw new TypeError('Unknown stored note actor kind.');
    return {
      kind: actorKind,
      name: id === null ? null : (names.get(`${actorKind}:${id}`) ?? null),
      you: actorKind === 'user' && id === invocation.context.userId,
    };
  };
  return rows.map((row) => {
    const body = noteDocument.parse(row.body);
    return {
      id: toPublicId('note', row.id),
      recordId: toPublicId(kind, row.record_id),
      body,
      text: row.body_text,
      author: actorOf(row.author_kind, row.author_id),
      editedBy: row.edited_by_kind === null ? null : actorOf(row.edited_by_kind, row.edited_by_id),
      editedAt: row.edited_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      revision: revisionOf(row),
    };
  });
}

export function createNoteCommand(
  actorNames: ActorNames,
): Command<typeof createCommandInput, Note> {
  return defineCommand({
    name: 'note.create',
    permission: 'notes.manage',
    input: createCommandInput,
    // Which record, never what the note says: the audit log outlives the note.
    audit: ({ id }) => ({ id }),
    async handle(trx, input, command): Promise<Note> {
      const businessId = requireBusiness(command.context);
      const record = await requireRecord(trx, input.id, true);
      const row = await trx
        .insertInto('crm.notes')
        .values({
          business_id: businessId,
          record_id: record.id,
          body: JSON.stringify(input.body),
          body_text: plainText(input.body),
          author_kind: command.context.actorKind,
          author_id: command.context.actorId ?? null,
        })
        .returningAll()
        .returning(version)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'note.created',
        subject: { kind: 'note', id: row.id },
        records: [record.id],
        payload: { recordId: input.id },
      });
      const [saved] = await present(trx, command, [row], record.kind, actorNames);
      if (saved === undefined) throw new TypeError('The saved note must be present.');
      return saved;
    },
  });
}

export function updateNoteCommand(
  actorNames: ActorNames,
): Command<typeof updateCommandInput, Note> {
  return defineCommand({
    name: 'note.update',
    permission: 'notes.manage',
    input: updateCommandInput,
    audit: ({ id, noteId }) => ({ id, noteId }),
    async handle(trx, input, command): Promise<Note> {
      requireBusiness(command.context);
      // Consistent with trash/purge: registry, entity, then the dependent note.
      const record = await requireRecord(trx, input.id, true);
      const current = await requireNote(trx, record.id, input.noteId, true);
      checkRevision(current, input.revision);
      const row = await trx
        .updateTable('crm.notes')
        .set({
          body: JSON.stringify(input.body),
          body_text: plainText(input.body),
          // Who edits, as the invocation says: the author stays who wrote it.
          edited_by_kind: command.context.actorKind,
          edited_by_id: command.context.actorId ?? null,
          edited_at: sql<Date>`now()`,
        })
        .where('id', '=', current.id)
        .returningAll()
        .returning(version)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'note.updated',
        subject: { kind: 'note', id: row.id },
        records: [record.id],
        payload: { recordId: input.id },
      });
      const [saved] = await present(trx, command, [row], record.kind, actorNames);
      if (saved === undefined) throw new TypeError('The saved note must be present.');
      return saved;
    },
  });
}

export const deleteNoteCommand = defineCommand({
  name: 'note.delete',
  permission: 'notes.manage',
  input: deleteNoteInput.extend(deleteNote.params.shape),
  audit: ({ id, noteId }) => ({ id, noteId }),
  async handle(trx, input, command): Promise<undefined> {
    requireBusiness(command.context);
    const record = await requireRecord(trx, input.id, true);
    const current = await requireNote(trx, record.id, input.noteId, true);
    checkRevision(current, input.revision);
    await trx.deleteFrom('crm.notes').where('id', '=', current.id).execute();
    await command.emit({
      type: 'note.deleted',
      subject: { kind: 'note', id: current.id },
      records: [record.id],
      payload: { recordId: input.id },
    });
    return undefined;
  },
});

export async function readNotes(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  query: z.output<typeof listRecordNotes.query>,
  actorNames: ActorNames,
): Promise<RecordNotes> {
  requireBusiness(invocation.context);
  const record = await requireRecord(trx, id);
  const after = query.after === undefined ? undefined : parsePublicId('note', query.after);
  if (query.after !== undefined) {
    const anchor = await trx
      .selectFrom('crm.notes')
      .select('id')
      .where('record_id', '=', record.id)
      .where('id', '=', after ?? '')
      .executeTakeFirst();
    if (anchor === undefined)
      throw new ValidationError([
        { path: '/after', code: 'unknown_note', message: 'Start after a note on this record.' },
      ]);
  }
  // Newest written first, ties by id: an import's history takes its place by when it was
  // written, not when it arrived.
  let notes = trx
    .selectFrom('crm.notes')
    .selectAll()
    .select(version)
    .where('record_id', '=', record.id)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(51);
  if (after !== undefined) {
    // The cursor's place, read in SQL so no precision is lost. created_at <= it lets the
    // index start the scan there.
    const at = trx
      .selectFrom('crm.notes')
      .select('created_at')
      .where('record_id', '=', record.id)
      .where('id', '=', after);
    notes = notes.where((eb) =>
      eb.and([
        eb('created_at', '<=', at),
        eb.or([eb('created_at', '<', at), eb('id', '<', after)]),
      ]),
    );
  }
  if (query.q !== undefined && query.q !== '')
    notes = notes.where(sql<boolean>`search @@ plainto_tsquery('simple', ${query.q})`);
  const rows = await notes.execute();
  const page = rows.slice(0, 50);
  const last = page.at(-1);
  return {
    canManage:
      !record.trashed &&
      (invocation.permissions === 'all' || invocation.permissions.has('notes.manage')),
    items: await present(trx, invocation, page, record.kind, actorNames),
    nextCursor: rows.length > 50 && last !== undefined ? toPublicId('note', last.id) : null,
  };
}
