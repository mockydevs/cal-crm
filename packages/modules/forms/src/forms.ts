// Managing forms: the team's side. A form is edited as a draft and served as what was last
// published, so a half-finished change never reaches a website. Every write names the
// revision it was made from, and takes the business and then the form's row, as a
// submission does (public.ts), so a change and a submission never interleave.
import { createHash, randomBytes } from 'node:crypto';

import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  createFormInput,
  DEFAULT_FORM_DEFINITION,
  FORM_LIMITS,
  FORM_PAGE_PATH,
  FORM_PREVIEW_PAGE_PATH,
  form as formContract,
  formRevisionInput,
  updateFormInput,
  type Form,
  type FormDefinition,
  type FormList,
  type FormPreview,
  type FormProblem,
} from '@repo/contracts';
import type { DatabaseTransaction, Json } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { readFields, readTags } from '@repo/module-crm';
import { canonicalWebOrigin } from '@repo/module-messaging';
import { holdActiveBusiness, readTeamMemberships } from '@repo/module-tenancy';
import { sql } from 'kysely';
import * as z from 'zod';

import {
  EMPTY_FORM_DEFINITION,
  publishProblems,
  storedDefinition,
  type ContactFieldFacts,
  type PublishFacts,
} from './definition.js';
import { issuePreviewToken } from './preview-token.js';
import { ownOrigin } from './public.js';

/** Where the embed script is served, under the install's public address. */
export const FORM_SCRIPT_PATH = '/forms/embed.js';

/**
 * The one line a website needs. The key and the address are the only variable parts: a
 * key is base64url and the address is the install's own, so neither can close the
 * attribute or the tag.
 */
export function embedSnippet(publicUrl: string, publicKey: string): string {
  const source = new URL(FORM_SCRIPT_PATH, publicUrl).toString();
  return `<script async src="${source}" data-form-key="${publicKey}"></script>`;
}

/**
 * The form as a page of its own, served by the CRM (apps/server: forms-embed/page.ts). The
 * key is base64url, so it is a path segment as it stands.
 */
export function hostedFormUrl(publicUrl: string, publicKey: string): string {
  return new URL(`${FORM_PAGE_PATH}/${publicKey}`, publicUrl).toString();
}

/** A new form key: 24 bytes from the system's random source, 32 characters. */
const newFormKey = (): string => randomBytes(24).toString('base64url');

const asJson = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;

/**
 * The websites as stored: each in its one canonical form, once. One that has no such form
 * (plain HTTP outside a developer's own machine, a trailing dot) is refused, with the
 * place in the list it was typed at.
 */
function storedOrigins(typed: readonly string[]): string[] {
  const issues: Issue[] = [];
  const origins = new Set<string>();
  for (const [index, value] of typed.entries()) {
    const origin = canonicalWebOrigin(value);
    if (origin === undefined)
      issues.push({
        path: `/allowedOrigins/${String(index)}`,
        code: 'invalid_origin',
        message: 'Enter a secure website address, such as https://www.example.com.',
      });
    else origins.add(origin);
  }
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  return [...origins];
}

function formId(publicId: string): string {
  const id = parsePublicId('form', publicId);
  if (id === undefined) throw new NotFoundError('Form', publicId);
  return id;
}

/** The business's contact custom fields, as far as a form's mapping depends on them. */
async function contactFields(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<Map<string, ContactFieldFacts>> {
  const { items } = await readFields(trx, invocation);
  return new Map(
    items
      .filter((field) => field.objectKey === 'contact')
      .map((field) => [
        field.id,
        {
          valueType: field.valueType,
          archived: field.archived,
          choices: field.options.filter((option) => !option.archived).map((option) => option.key),
          options: field.options.map(({ key, label, archived }) => ({ key, label, archived })),
        },
      ]),
  );
}

/**
 * What publishing a definition depends on in the business: its contact fields, its tags,
 * and, when the form names people to be told, which of them are on the team.
 */
async function publishFacts(
  trx: DatabaseTransaction,
  invocation: Invocation,
  definition: FormDefinition,
): Promise<PublishFacts> {
  const named = definition.notify?.mode === 'members' ? definition.notify.memberIds : [];
  const tagged = definition.contactActions?.tagIds ?? [];
  return {
    fields: await contactFields(trx, invocation),
    tags: new Set(tagged.length === 0 ? [] : (await readTags(trx)).map((tag) => tag.id)),
    members: new Set(
      named.length === 0 ? [] : (await readTeamMemberships(trx, invocation.context, named)).keys(),
    ),
  };
}

interface FormRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly public_key: string;
  readonly allowed_origins: string[];
  readonly definition: unknown;
  readonly published_definition: unknown;
  readonly published_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** What a form's revision is made of: everything a save, a publish or an archive changes. */
const revisionOf = (row: FormRow): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        row.name,
        row.status,
        row.allowed_origins,
        row.definition,
        row.published_definition,
      ]),
    )
    .digest('hex');

const statusOf = (status: string): Form['status'] =>
  status === 'published' || status === 'archived' ? status : 'draft';

/** A definition that cannot be read cannot be published; it is edited as an empty draft. */
const UNREADABLE: FormProblem = {
  path: '/fields',
  code: 'unreadable_definition',
  message: 'This form was made before the builder. Add its questions and save it.',
};

async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  row: FormRow,
  publicUrl: string,
): Promise<Form> {
  const draft = storedDefinition(row.definition);
  const published = storedDefinition(row.published_definition);
  const counted = await trx
    .selectFrom('forms.submissions')
    .select(sql<string>`count(*)::text`.as('count'))
    .where('form_id', '=', row.id)
    .executeTakeFirstOrThrow();
  return formContract.parse({
    id: toPublicId('form', row.id),
    name: row.name,
    status: statusOf(row.status),
    publicKey: row.public_key,
    allowedOrigins: row.allowed_origins,
    definition: draft ?? EMPTY_FORM_DEFINITION,
    publishedDefinition: published ?? null,
    publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
    // jsonb stores a document in one canonical order, so equal documents print the same.
    hasUnpublishedChanges:
      row.status === 'published' &&
      JSON.stringify(row.definition) !== JSON.stringify(row.published_definition),
    problems:
      draft === undefined
        ? [UNREADABLE]
        : publishProblems(draft, await publishFacts(trx, invocation, draft)),
    embedSnippet: embedSnippet(publicUrl, row.public_key),
    hostedUrl: hostedFormUrl(publicUrl, row.public_key),
    submissionCount: Number(counted.count),
    revision: revisionOf(row),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('forms.manage'),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

const COLUMNS = [
  'id',
  'name',
  'status',
  'public_key',
  'allowed_origins',
  'definition',
  'published_definition',
  'published_at',
  'created_at',
  'updated_at',
] as const;

/** One form with what stops it being published, as anyone in the business may read it. */
export async function readForm(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  publicUrl: string,
): Promise<Form> {
  requireBusiness(invocation.context);
  const row = await trx
    .selectFrom('forms.forms')
    .select(COLUMNS)
    .where('id', '=', formId(publicId))
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Form', publicId);
  return present(trx, invocation, row, publicUrl);
}

/** The business's forms in creation order, archived ones apart. */
export async function readForms(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: {
    readonly after?: string | undefined;
    readonly limit: number;
    readonly archived: boolean;
  },
): Promise<FormList> {
  requireBusiness(invocation.context);
  let query = trx
    .selectFrom('forms.forms')
    .select(['id', 'name', 'status', 'definition', 'published_definition', 'updated_at'])
    .where('status', input.archived ? '=' : '<>', 'archived')
    .orderBy('id');
  if (input.after !== undefined) query = query.where('id', '>', formId(input.after));
  const found = await query.limit(input.limit + 1).execute();
  const rows = found.slice(0, input.limit);
  const counted =
    rows.length === 0
      ? []
      : await trx
          .selectFrom('forms.submissions')
          .select([
            'form_id',
            sql<string>`count(*)::text`.as('count'),
            sql<Date>`max(submitted_at)`.as('last'),
          ])
          .where(
            'form_id',
            'in',
            rows.map((row) => row.id),
          )
          .groupBy('form_id')
          .execute();
  const counts = new Map(counted.map((row) => [row.form_id, row]));
  const last = rows.at(-1);
  return {
    items: rows.map((row) => {
      const submissions = counts.get(row.id);
      return {
        id: toPublicId('form', row.id),
        name: row.name,
        status: statusOf(row.status),
        hasUnpublishedChanges:
          row.status === 'published' &&
          JSON.stringify(row.definition) !== JSON.stringify(row.published_definition),
        submissionCount: Number(submissions?.count ?? '0'),
        lastSubmissionAt: submissions === undefined ? null : submissions.last.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    }),
    nextCursor:
      found.length > input.limit && last !== undefined ? toPublicId('form', last.id) : null,
    canManage: invocation.permissions === 'all' || invocation.permissions.has('forms.manage'),
  };
}

export interface FormPreviewOptions {
  /** The install's public address: the preview page is served there. */
  readonly publicUrl: string;
  /**
   * Keys the links. The server passes its public intake secret, as for the proof of when
   * a form was shown; an install without one serves no public form and no preview.
   */
  readonly secret: string | undefined;
  /** The clock, in milliseconds. Tests pass their own. */
  readonly now?: (() => number) | undefined;
}

/**
 * A link that shows the form's draft for a while, for anyone in the business who may read
 * the form. It changes nothing and is not kept: each call makes another, and each runs out
 * by itself.
 */
export async function readFormPreview(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  options: FormPreviewOptions,
): Promise<FormPreview> {
  const businessId = requireBusiness(invocation.context);
  const row = await trx
    .selectFrom('forms.forms')
    .select(['id', 'status', 'definition'])
    .where('id', '=', formId(publicId))
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Form', publicId);
  // The preview page is served where published forms are: with the public intake secret,
  // on a secure public address (apps/server: start.ts).
  if (options.secret === undefined || ownOrigin(options.publicUrl) === undefined)
    throw new ConflictError(
      'Public forms are switched off on this install, so there is nothing to preview on.',
    );
  if (row.status === 'archived') throw new ConflictError('Restore this form to preview it.');
  if (storedDefinition(row.definition) === undefined)
    throw new ConflictError('Add this form’s questions and save it before previewing it.');
  // To the whole second: that is as fine as the link says when it runs out.
  const expiresAt =
    Math.floor(((options.now ?? Date.now)() + FORM_LIMITS.previewMinutes * 60_000) / 1000) * 1000;
  const token = issuePreviewToken(
    options.secret,
    { agencyId: invocation.context.agencyId, businessId, formId: row.id },
    expiresAt,
  );
  return {
    url: new URL(`${FORM_PREVIEW_PAGE_PATH}/${token}`, options.publicUrl).toString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** A form as a proposal about it needs it: what it is called, how it stands, what it holds. */
export interface FormState {
  readonly id: string;
  readonly name: string;
  readonly status: Form['status'];
  /** The fingerprint a save, a publish or an archive changes. */
  readonly revision: string;
  /** The draft, or undefined when it cannot be read as a form. */
  readonly draft: FormDefinition | undefined;
  /** Why the draft cannot be published as it stands. Empty when it can. */
  readonly problems: readonly FormProblem[];
}

/**
 * A form's fingerprint and how it stands, by its public id, or a NotFoundError. It asks
 * nothing of who reads: row-level security holds it to the transaction's business.
 */
export async function readFormRevision(
  trx: DatabaseTransaction,
  publicId: string,
): Promise<Pick<FormState, 'id' | 'name' | 'status' | 'revision'>> {
  const row = await trx
    .selectFrom('forms.forms')
    .select(COLUMNS)
    .where('id', '=', formId(publicId))
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Form', publicId);
  return { id: row.id, name: row.name, status: statusOf(row.status), revision: revisionOf(row) };
}

/** One form of the request's business as it stands now, or a NotFoundError. */
export async function readFormState(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<FormState> {
  requireBusiness(invocation.context);
  const row = await trx
    .selectFrom('forms.forms')
    .select(COLUMNS)
    .where('id', '=', formId(publicId))
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Form', publicId);
  const draft = storedDefinition(row.definition);
  return {
    id: row.id,
    name: row.name,
    status: statusOf(row.status),
    revision: revisionOf(row),
    draft,
    problems:
      draft === undefined
        ? [UNREADABLE]
        : publishProblems(draft, await publishFacts(trx, invocation, draft)),
  };
}

/** The names of forms by id, for whoever shows who acted (the CRM's activity and sources). */
export async function readFormNames(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('forms.forms')
    .select(['id', 'name'])
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * The key each form is shown by and whether it is published, by form id, for a page of a
 * site that shows a form. Forms that are gone or archived are left out.
 */
export async function readFormKeys(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, { readonly publicKey: string; readonly published: boolean }>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('forms.forms')
    .select(['id', 'public_key', 'status'])
    .where('id', 'in', [...new Set(ids)])
    .where('status', '<>', 'archived')
    .execute();
  return new Map(
    rows.map((row) => [
      row.id,
      { publicKey: row.public_key, published: row.status === 'published' },
    ]),
  );
}

/**
 * The form's row, held until the command ends, at the revision the change was made from.
 * The business comes first, as for a submission, so the two never wait on each other.
 */
async function locked(
  trx: DatabaseTransaction,
  command: CommandContext,
  publicId: string,
  revision: string,
): Promise<FormRow> {
  requireBusiness(command.context);
  if (!(await holdActiveBusiness(trx, command.context)))
    throw new ConflictError('This business is not active.');
  const row = await trx
    .selectFrom('forms.forms')
    .select(COLUMNS)
    .where('id', '=', formId(publicId))
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Form', publicId);
  if (revisionOf(row) !== revision)
    throw new ConflictError('This form changed since you opened it. Reload before saving.');
  return row;
}

const withId = updateFormInput.extend({ id: z.string() });
const revisionWithId = formRevisionInput.extend({ id: z.string() });

export interface FormCommands {
  readonly create: Command<typeof createFormInput, Form>;
  readonly update: Command<typeof withId, Form>;
  readonly publish: Command<typeof revisionWithId, Form>;
  readonly unpublish: Command<typeof revisionWithId, Form>;
  readonly archive: Command<typeof revisionWithId, Form>;
  readonly restore: Command<typeof revisionWithId, Form>;
}

/** The commands, given the install's public address for the snippet they return. */
export function createFormCommands(publicUrl: string): FormCommands {
  const reread = async (
    trx: DatabaseTransaction,
    command: CommandContext,
    id: string,
  ): Promise<Form> => readForm(trx, command, toPublicId('form', id), publicUrl);

  const create = defineCommand({
    name: 'forms.create',
    permission: 'forms.manage',
    input: createFormInput,
    // The in-app assistant builds drafts for the person it works for: a new form is a
    // draft, and reaches nobody until it is published.
    delegation: { action: 'build_draft' },
    async handle(trx, input, command): Promise<Form> {
      const businessId = requireBusiness(command.context);
      if (!(await holdActiveBusiness(trx, command.context)))
        throw new ConflictError('This business is not active.');
      const row = await trx
        .insertInto('forms.forms')
        .values({
          business_id: businessId,
          name: input.name,
          definition: asJson(DEFAULT_FORM_DEFINITION),
          // From the system's random source. It is public from the moment it is embedded.
          public_key: newFormKey(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({ type: 'form.created', subject: { kind: 'form', id: row.id } });
      return reread(trx, command, row.id);
    },
  });

  const update = defineCommand({
    name: 'forms.update',
    permission: 'forms.manage',
    input: withId,
    // The audit log keeps what changed hands, not the whole document.
    audit: ({ id, name, allowedOrigins, definition }) => ({
      id,
      name,
      allowedOrigins,
      fields: definition.fields.length,
      consents: definition.consents.length,
    }),
    // Saving changes the draft, which the assistant may build. What it may not change is
    // held below, whatever its level.
    delegation: { action: 'build_draft' },
    async handle(trx, input, command): Promise<Form> {
      const origins = storedOrigins(input.allowedOrigins);
      const row = await locked(trx, command, input.id, input.revision);
      if (row.status === 'archived')
        throw new ConflictError('Restore this form before changing it.');
      // The websites that may show a form apply at once: they are not part of the draft,
      // so no assistant sets them. It saves a form with the websites it already has.
      if (
        command.context.actorKind === 'ai_agent' &&
        JSON.stringify([...origins].sort()) !== JSON.stringify([...row.allowed_origins].sort())
      )
        throw new ForbiddenError(
          'An assistant cannot change the websites that may show a form. A person lists them.',
        );
      await trx
        .updateTable('forms.forms')
        .set({
          name: input.name,
          definition: asJson(input.definition),
          allowed_origins: origins,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({ type: 'form.updated', subject: { kind: 'form', id: row.id } });
      return reread(trx, command, row.id);
    },
  });

  const publish = defineCommand({
    name: 'forms.publish',
    permission: 'forms.manage',
    input: revisionWithId,
    // Publishing is what an assistant proposes and a person confirms (proposals.ts). An
    // assistant runs it itself only where the business set its rule for publishing to act.
    delegation: { action: 'publish' },
    async handle(trx, input, command): Promise<Form> {
      const row = await locked(trx, command, input.id, input.revision);
      if (row.status === 'archived')
        throw new ConflictError('Restore this form before publishing it.');
      const draft: FormDefinition | undefined = storedDefinition(row.definition);
      const problems =
        draft === undefined
          ? [UNREADABLE]
          : publishProblems(draft, await publishFacts(trx, command, draft));
      const [first, ...rest] = problems;
      // What goes live is exactly what was checked: the stored draft, under this lock.
      if (first !== undefined) throw new ValidationError([first, ...rest]);
      await trx
        .updateTable('forms.forms')
        .set({
          status: 'published',
          // Both as the contract reads them, so "changed since published" compares like with like.
          definition: asJson(draft),
          published_definition: asJson(draft),
          // The time it is written, so each publication is a version of its own.
          published_at: sql<Date>`clock_timestamp()`,
        })
        .where('id', '=', row.id)
        .execute();
      await command.emit({ type: 'form.published', subject: { kind: 'form', id: row.id } });
      return reread(trx, command, row.id);
    },
  });

  /** Stops the form serving, and leaves its draft as it is. */
  const withdraw = (
    name: string,
    event: string,
    next: 'draft' | 'archived',
    allowed: (status: string) => string | undefined,
  ): Command<typeof revisionWithId, Form> =>
    defineCommand({
      name,
      permission: 'forms.manage',
      input: revisionWithId,
      async handle(trx, input, command): Promise<Form> {
        const row = await locked(trx, command, input.id, input.revision);
        const refusal = allowed(row.status);
        if (refusal !== undefined) throw new ConflictError(refusal);
        await trx
          .updateTable('forms.forms')
          .set({ status: next, published_definition: null, published_at: null })
          .where('id', '=', row.id)
          .execute();
        await command.emit({ type: event, subject: { kind: 'form', id: row.id } });
        return reread(trx, command, row.id);
      },
    });

  return {
    create,
    update,
    publish,
    unpublish: withdraw('forms.unpublish', 'form.unpublished', 'draft', (status) =>
      status === 'published' ? undefined : 'This form is not published.',
    ),
    archive: withdraw('forms.archive', 'form.archived', 'archived', (status) =>
      status === 'archived' ? 'This form is already archived.' : undefined,
    ),
    restore: withdraw('forms.restore', 'form.restored', 'draft', (status) =>
      status === 'archived' ? undefined : 'This form is not archived.',
    ),
  };
}
