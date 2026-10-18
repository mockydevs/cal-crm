// Drafts (AUTOMATIONS.md section 5): an automation's working document. Every save names the
// draft version it started from, and a save from a stale version is a 409, so nobody's
// change is lost without notice. A draft may be unfinished; each save reports what
// validation found instead of refusing it.
import { defineCommand, requireBusiness, type Command, type CommandContext } from '@repo/commands';
import {
  applyJsonPatch,
  AUTOMATION_DELETED_DAYS,
  automationStatuses,
  createAutomationInput,
  patchAutomationDraftInput,
  replaceAutomationDraftInput,
  validateAutomation,
  type Automation,
  type AutomationDraftSaved,
  type AutomationIssue,
  type AutomationList,
  type AutomationSetup,
  type AutomationSummary,
  type AutomationValidation,
  type AutomationValidationResponse,
  type JsonValue,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { readEnrolledCounts, type EnrolledCounts } from './stats.js';

/** What the business has, which documents refer to (setup.ts reads it from the database). */
export type ReadSetup = (
  trx: DatabaseTransaction,
  context: TenantContext,
) => Promise<AutomationSetup>;

/**
 * The largest draft kept: its characters plus one per value, as the patch engine counts.
 * Generous for any real automation, and far below what would strain a request.
 */
export const MAX_DRAFT_SIZE = 500_000;

const draftName = z.string().trim().min(1).max(120);
const draftDescription = z.string().trim().max(2000);

/**
 * The document as JSON within the draft limits, before anything recursive reads it: too
 * large, too deeply nested or not JSON at all is a 422 at path.
 */
export function checkedDocument(document: unknown, path: string): JsonValue {
  const checked = applyJsonPatch(document, [], { maxSize: MAX_DRAFT_SIZE });
  if (!checked.ok)
    throw new ValidationError([{ path, code: checked.error.code, message: checked.error.message }]);
  return checked.document;
}

// The draft's checked JSON, and the name and description the list shows, kept in step.
function draftOf(
  document: unknown,
  path: string,
): {
  draft: JsonValue;
  name: string;
  description: string;
} {
  const draft = checkedDocument(document, path);
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft))
    throw new ValidationError([
      { path, code: 'invalid_document', message: 'A draft is a JSON object.' },
    ]);
  const name = draftName.safeParse(draft['name']);
  if (!name.success)
    throw new ValidationError([
      {
        path: `${path}/name`,
        code: 'invalid_name',
        message: 'Name the automation, in 1 to 120 characters.',
      },
    ]);
  const description = draftDescription.safeParse(draft['description'] ?? '');
  return { draft, name: name.data, description: description.success ? description.data : '' };
}

/** What the API reports of a validation: its verdict and issues, not the resolved document. */
export function validationOf(result: AutomationValidation): AutomationValidationResponse {
  const issues = (list: readonly AutomationIssue[]) => list.map((issue) => ({ ...issue }));
  return { valid: result.valid, errors: issues(result.errors), warnings: issues(result.warnings) };
}

function automationIdOf(id: string): string {
  const uuid = parsePublicId('automation', id);
  if (uuid === undefined) throw new NotFoundError('automation', id);
  return uuid;
}

// What the list shows of each automation, with its live version joined for the detail.
const summaries = (trx: DatabaseTransaction) =>
  trx
    .selectFrom('automation.automations as automation')
    .leftJoin('automation.versions as live', (join) =>
      join
        .onRef('live.id', '=', 'automation.published_version_id')
        .onRef('live.business_id', '=', 'automation.business_id'),
    )
    .select((eb) => [
      'automation.id',
      'automation.name',
      'automation.description',
      'automation.status',
      'automation.draft_revision',
      'automation.created_at',
      'automation.updated_at',
      'automation.folder_id',
      'automation.archived_at',
      'live.version as live_version',
      eb
        .selectFrom('automation.enrolments as enrolment')
        .select((inner) => inner.fn.max('enrolment.started_at').as('started_at'))
        .whereRef('enrolment.automation_id', '=', 'automation.id')
        .as('last_run_at'),
    ]);

type SummaryRow = Awaited<ReturnType<ReturnType<typeof summaries>['executeTakeFirstOrThrow']>>;

const DAY = 86_400_000;

const presentSummary = (row: SummaryRow, enrolled: EnrolledCounts): AutomationSummary => ({
  id: toPublicId('automation', row.id),
  name: row.name,
  description: row.description,
  status: z.enum(automationStatuses).parse(row.status),
  draftVersion: row.draft_revision,
  liveVersion: row.live_version,
  lastRunAt: row.last_run_at === null ? null : row.last_run_at.toISOString(),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  folderId: row.folder_id === null ? null : toPublicId('automation_folder', row.folder_id),
  totalEnrolled: enrolled.total,
  activeEnrolled: enrolled.active,
  deletedAt: row.archived_at === null ? null : row.archived_at.toISOString(),
  // When the daily purge may take it: its days after it was deleted.
  purgeAt:
    row.archived_at === null
      ? null
      : new Date(row.archived_at.getTime() + AUTOMATION_DELETED_DAYS * DAY).toISOString(),
});

// A name to look for, with what LIKE reads as a pattern taken as written.
const containing = (text: string): string => `%${text.replaceAll(/[\\%_]/g, '\\$&')}%`;

/** How many automations one page of the list holds. */
export const AUTOMATION_PAGE_SIZE = 50;

/**
 * Newest first, so a page's cursor stays put however automations change meanwhile. Deleted
 * automations are a list of their own, asked for by their status (archived); every other
 * list leaves them out. A folder narrows it to what is directly in that folder, or at the
 * top level; a name to look for is looked for everywhere unless a folder is given too.
 */
export async function readAutomations(
  trx: DatabaseTransaction,
  {
    status,
    folder,
    q,
    after,
  }: {
    status?: AutomationSummary['status'] | undefined;
    folder?: string | undefined;
    q?: string | undefined;
    after?: string | undefined;
  },
): Promise<Pick<AutomationList, 'items' | 'nextCursor'>> {
  let query = summaries(trx)
    .orderBy('automation.id', 'desc')
    .limit(AUTOMATION_PAGE_SIZE + 1);
  query =
    status === undefined
      ? query.where('automation.status', '<>', 'archived')
      : query.where('automation.status', '=', status);
  if (folder === 'root') query = query.where('automation.folder_id', 'is', null);
  else if (folder !== undefined) {
    const folderId = parsePublicId('automation_folder', folder);
    // A folder that is not this business's holds nothing here.
    if (folderId === undefined) return { items: [], nextCursor: null };
    query = query.where('automation.folder_id', '=', folderId);
  }
  if (q !== undefined) query = query.where('automation.name', 'ilike', containing(q));
  if (after !== undefined) {
    const anchor = parsePublicId('automation', after);
    if (anchor === undefined)
      throw new ValidationError([
        { path: '/after', code: 'invalid_cursor', message: 'Start after an automation id.' },
      ]);
    query = query.where('automation.id', '<', anchor);
  }
  const rows = await query.execute();
  const page = rows.slice(0, AUTOMATION_PAGE_SIZE);
  const last = page.at(-1);
  const enrolled = await readEnrolledCounts(
    trx,
    page.map((row) => row.id),
  );
  return {
    items: page.map((row) => presentSummary(row, enrolled(row.id))),
    nextCursor:
      rows.length > AUTOMATION_PAGE_SIZE && last !== undefined
        ? toPublicId('automation', last.id)
        : null,
  };
}

/** The automation with its draft and live version, or a 404 when it isn't this business's. */
export async function readAutomation(trx: DatabaseTransaction, id: string): Promise<Automation> {
  const row = await summaries(trx)
    .select([
      'automation.draft',
      'live.id as live_id',
      'live.change_summary as live_change_summary',
      'live.published_at as live_published_at',
      'live.document as live_document',
    ])
    .where('automation.id', '=', automationIdOf(id))
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('automation', id);
  const enrolled = await readEnrolledCounts(trx, [row.id]);
  return {
    ...presentSummary(row, enrolled(row.id)),
    draft: z.record(z.string(), z.unknown()).parse(row.draft),
    live:
      row.live_id === null ||
      row.live_version === null ||
      row.live_published_at === null ||
      row.live_change_summary === null
        ? null
        : {
            id: toPublicId('automation_version', row.live_id),
            version: row.live_version,
            changeSummary: row.live_change_summary,
            publishedAt: row.live_published_at.toISOString(),
            document: z.record(z.string(), z.unknown()).parse(row.live_document),
          },
  };
}

async function saved(
  trx: DatabaseTransaction,
  command: CommandContext,
  setup: ReadSetup,
  id: string,
): Promise<AutomationDraftSaved> {
  const automation = await readAutomation(trx, id);
  return {
    automation,
    validation: validationOf(
      validateAutomation(automation.draft, await setup(trx, command.context), {
        automationId: automation.id,
      }),
    ),
  };
}

/** Locks the automation for a change, and refuses one from any draft version but the current. */
export async function lockedDraft(
  trx: DatabaseTransaction,
  id: string,
  baseDraftVersion: number,
): Promise<{ id: string; draft: unknown; draftVersion: number }> {
  const row = await trx
    .selectFrom('automation.automations')
    .select(['id', 'draft', 'draft_revision'])
    .where('id', '=', automationIdOf(id))
    .where('status', '<>', 'archived')
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('automation', id);
  if (row.draft_revision !== baseDraftVersion)
    throw new ConflictError(
      `The draft is at version ${String(row.draft_revision)}, not ${String(baseDraftVersion)}: someone saved it since. Read it again and reapply your change.`,
    );
  return { id: row.id, draft: row.draft, draftVersion: row.draft_revision };
}

async function store(
  trx: DatabaseTransaction,
  command: CommandContext,
  automationId: string,
  next: ReturnType<typeof draftOf>,
): Promise<void> {
  const row = await trx
    .updateTable('automation.automations')
    .set({
      draft: JSON.stringify(next.draft),
      draft_revision: sql<number>`draft_revision + 1`,
      name: next.name,
      description: next.description,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', automationId)
    .returning('draft_revision')
    .executeTakeFirstOrThrow();
  await command.emit({
    type: 'automation.draft_updated',
    subject: { kind: 'automation', id: automationId },
    records: [],
    payload: { draftVersion: row.draft_revision },
  });
}

/** The draft commands; validation on save reads the business's setup through `setup`. */
// The routes add the automation's id, from the path, to the body.
const replaceDraftInput = replaceAutomationDraftInput.extend({ id: z.string() });
const patchDraftInput = patchAutomationDraftInput.extend({ id: z.string() });

export interface DraftCommands {
  readonly create: Command<typeof createAutomationInput, AutomationDraftSaved>;
  readonly replace: Command<typeof replaceDraftInput, AutomationDraftSaved>;
  readonly patch: Command<typeof patchDraftInput, AutomationDraftSaved>;
}

export function createDraftCommands({ setup }: { setup: ReadSetup }): DraftCommands {
  const create = defineCommand({
    name: 'automation.create',
    delegation: { action: 'build_draft' },
    permission: 'automations.manage',
    input: createAutomationInput,
    // The name, not the whole draft, which can be large.
    audit: ({ document }) => ({ name: document['name'] }),
    async handle(trx, input, command): Promise<AutomationDraftSaved> {
      const businessId = requireBusiness(command.context);
      const next = draftOf(input.document, '/document');
      const { id } = await trx
        .insertInto('automation.automations')
        .values({
          business_id: businessId,
          name: next.name,
          description: next.description,
          draft: JSON.stringify(next.draft),
          created_by_kind: command.context.actorKind,
          created_by_id: command.context.actorId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'automation.created',
        subject: { kind: 'automation', id },
        records: [],
        payload: {},
      });
      return saved(trx, command, setup, toPublicId('automation', id));
    },
  });

  const replace = defineCommand({
    name: 'automation.replace_draft',
    delegation: { action: 'build_draft' },
    permission: 'automations.manage',
    input: replaceDraftInput,
    audit: ({ id, baseDraftVersion }) => ({ automationId: id, baseDraftVersion }),
    async handle(trx, input, command): Promise<AutomationDraftSaved> {
      requireBusiness(command.context);
      const current = await lockedDraft(trx, input.id, input.baseDraftVersion);
      await store(trx, command, current.id, draftOf(input.document, '/document'));
      return saved(trx, command, setup, input.id);
    },
  });

  const patch = defineCommand({
    name: 'automation.patch_draft',
    delegation: { action: 'build_draft' },
    permission: 'automations.manage',
    input: patchDraftInput,
    audit: ({ id, baseDraftVersion, patch: operations }) => ({
      automationId: id,
      baseDraftVersion,
      operations: operations.length,
    }),
    async handle(trx, input, command): Promise<AutomationDraftSaved> {
      requireBusiness(command.context);
      const current = await lockedDraft(trx, input.id, input.baseDraftVersion);
      const result = applyJsonPatch(current.draft, input.patch, { maxSize: MAX_DRAFT_SIZE });
      if (!result.ok)
        throw new ValidationError([
          {
            path: `/patch/${String(result.error.index)}`,
            code: result.error.code,
            message: result.error.message,
          },
        ]);
      await store(trx, command, current.id, draftOf(result.document, ''));
      return saved(trx, command, setup, input.id);
    },
  });

  return { create, replace, patch };
}
