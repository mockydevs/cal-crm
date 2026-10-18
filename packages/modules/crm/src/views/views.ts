import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Command, type Invocation } from '@repo/commands';
import {
  createViewInput,
  contactViewChanges,
  dealSorts,
  dealViewChanges,
  deleteView,
  deleteViewInput,
  parseInput,
  savedView,
  setViewSharing,
  shareView,
  shareViewInput,
  unshareViewInput,
  updateView,
  viewSharingInput,
  type SavedView,
  type ViewAccessLevel,
  type ViewList,
} from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { sql, type Selectable } from 'kysely';
import * as z from 'zod';
import type { ActorNames } from '../activity/activity.js';
import type { DealPeopleOptions } from '../deals/details.js';
import { planFieldList } from '../fields/list-fields.js';

type ObjectKey = 'contact' | 'deal';
const OWNED_VIEW_LIMIT = 100;
const SHARED_VIEW_LIMIT = 100;
const shareCommandInput = shareViewInput.extend(shareView.params.shape);
const unshareCommandInput = unshareViewInput.extend(shareView.params.shape);
const sharingCommandInput = viewSharingInput.extend(setViewSharing.params.shape);
const updateCommandInput = z.union([
  contactViewChanges.extend(updateView.params.shape),
  dealViewChanges.extend(updateView.params.shape),
]);

/** Someone a view is shared with by name, and what they may do with it. */
interface Share {
  readonly user_id: string;
  readonly access: string;
  /**
   * Whether the share still counts: they are on the team through a membership they had when
   * it was given. Taken off the team, or invited back since, it gives them nothing.
   */
  readonly live: boolean;
}
type ViewRow = Selectable<DB['crm.saved_views']> & {
  version: string;
  object_key: string;
  /** The people the view is shared with by name, by user id. */
  shares: readonly Share[];
};
const version = sql<string>`extract(epoch from updated_at)::text`.as('version');

/**
 * Who is on the team and what people are called: a share names a person by membership, and
 * the views show who they are shared with. Left out, nobody can be chosen by name.
 */
export type ViewPeople = DealPeopleOptions;
const storedSort = z
  .array(
    z.union([
      // A built-in order: the contact list has one, the deal list four.
      z.strictObject({ by: z.enum(dealSorts) }),
      z.strictObject({ fieldId: z.string(), order: z.enum(['asc', 'desc']).optional() }),
    ]),
  )
  .max(1);

function person(invocation: Invocation): string {
  const { actorKind, actorId, userId } = invocation.context;
  if (actorKind !== 'user' || userId === undefined || actorId !== userId)
    throw new ForbiddenError('Only a signed-in person can save or change views.');
  return userId;
}
function isPerson(invocation: Invocation): boolean {
  const { actorKind, actorId, userId } = invocation.context;
  return actorKind === 'user' && userId !== undefined && actorId === userId;
}
function granted(invocation: Invocation, permission: 'views.save' | 'views.share'): boolean {
  return invocation.permissions === 'all' || invocation.permissions.has(permission);
}
function revisionOf(row: ViewRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.version,
        row.name,
        row.visibility,
        row.filters,
        row.sort,
        row.columns,
        row.owner_user_id,
        row.object_type_id,
        // Only once a view has table columns, so a view without them keeps the revision
        // its readers already hold.
        ...(row.table_columns === null ? [] : [row.table_columns]),
        // Likewise for a contact table's layout with custom fields.
        ...(row.column_layout === null ? [] : [{ columnLayout: row.column_layout }]),
        // Likewise for the widths of resized columns, an editing level for everyone, and
        // the people a view is shared with by name.
        ...(row.column_widths === null ? [] : [{ columnWidths: row.column_widths }]),
        ...(row.shared_access === 'view' ? [] : [{ sharedAccess: row.shared_access }]),
        ...(row.shares.length === 0
          ? []
          : [
              {
                shares: row.shares
                  .map((share) => [share.user_id, share.access])
                  .toSorted(([left = ''], [right = '']) => left.localeCompare(right)),
              },
            ]),
      ]),
    )
    .digest('hex');
}

/**
 * The people each of these views is shared with by name, by view id, in the order they were
 * chosen. Whether each share still counts is the database's own rule, the one its policies
 * apply.
 */
async function sharesOf(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, Share[]>> {
  const byView = new Map<string, Share[]>();
  if (ids.length === 0) return byView;
  const rows = await trx
    .selectFrom('crm.saved_view_shares')
    .select(['view_id', 'user_id', 'access'])
    .select(
      sql<boolean>`private.saved_view_share_live(business_id, user_id, created_at)`.as('live'),
    )
    .where('view_id', 'in', [...ids])
    .orderBy('created_at')
    .orderBy('user_id')
    .execute();
  for (const row of rows) byView.set(row.view_id, [...(byView.get(row.view_id) ?? []), row]);
  return byView;
}

export async function requireView(
  trx: DatabaseTransaction,
  id: string,
  lock = false,
): Promise<ViewRow> {
  const uuid = parsePublicId('saved_view', id);
  if (uuid === undefined) throw new NotFoundError('View', id);
  let query = trx
    .selectFrom('crm.saved_views as v')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.business_id', '=', 'v.business_id').onRef('o.id', '=', 'v.object_type_id'),
    )
    .selectAll('v')
    .select('o.kind as object_key')
    .select(sql<string>`extract(epoch from v.updated_at)::text`.as('version'))
    .where('v.id', '=', uuid);
  if (lock) query = query.forUpdate('v');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('View', id);
  return { ...row, shares: (await sharesOf(trx, [row.id])).get(row.id) ?? [] };
}
function checkRevision(row: ViewRow, revision: string): void {
  if (revisionOf(row) !== revision)
    throw new ConflictError('This view changed. Refresh it before saving, sharing or deleting.');
}

/**
 * What the reader has of a view they can see: it is theirs, or it is shared with them,
 * with everyone or by name, to view or to edit.
 */
function accessOf(invocation: Invocation, row: ViewRow): 'owner' | ViewAccessLevel {
  if (isPerson(invocation) && row.owner_user_id === invocation.context.userId) return 'owner';
  const level =
    row.visibility === 'shared'
      ? row.shared_access
      : row.shares.find((share) => share.live && share.user_id === invocation.context.userId)
          ?.access;
  return isPerson(invocation) && level === 'edit' ? 'edit' : 'view';
}

/**
 * Whether someone who manages shared views may change or delete this one beyond their own
 * access: a view shared with everyone, as before. One shared by name to view stays viewed,
 * as the database holds it.
 */
function managed(invocation: Invocation, row: ViewRow): boolean {
  return row.visibility === 'shared' && granted(invocation, 'views.share');
}

/** Changing what a view shows: its owner, an editor, or someone who manages shared views. */
function requireChange(invocation: Invocation, row: ViewRow): void {
  person(invocation);
  if (accessOf(invocation, row) === 'view' && !managed(invocation, row))
    throw new ForbiddenError(
      "Only the view's owner, someone it is shared with to edit, or someone who can share views, can change it.",
      'views.share',
    );
}

/** Whether the reader may delete the view: its owner, or someone who manages shared views. */
function deletable(invocation: Invocation, row: ViewRow): boolean {
  if (!isPerson(invocation)) return false;
  const access = accessOf(invocation, row);
  return (
    access === 'owner' ||
    managed(invocation, row) ||
    (access === 'edit' && granted(invocation, 'views.share'))
  );
}
function requireDelete(invocation: Invocation, row: ViewRow): void {
  person(invocation);
  if (!deletable(invocation, row))
    throw new ForbiddenError(
      "Only the view's owner, or someone who can share views, can delete a shared view.",
      'views.share',
    );
}
function storage(state: z.output<typeof createViewInput>['state']) {
  const filters: Record<string, unknown> = { ...state };
  delete filters['sort'];
  delete filters['sortField'];
  delete filters['fieldOrder'];
  const builtin = 'sort' in state ? state.sort : undefined;
  const sort =
    builtin !== undefined
      ? [{ by: builtin }]
      : state.sortField === undefined
        ? []
        : [
            {
              fieldId: state.sortField,
              ...(state.fieldOrder === undefined ? {} : { order: state.fieldOrder }),
            },
          ];
  return { filters: JSON.stringify(filters), sort: JSON.stringify(sort) };
}
async function validateState(
  trx: DatabaseTransaction,
  businessId: string,
  objectKey: ObjectKey,
  state: z.output<typeof createViewInput>['state'],
): Promise<void> {
  try {
    await planFieldList(trx, businessId, objectKey, 'v', state);
  } catch (error: unknown) {
    if (!(error instanceof ValidationError)) throw error;
    const [first, ...rest] = error.issues.map((issue) => ({
      ...issue,
      path: `/state${issue.path}`,
    }));
    if (first === undefined) throw error;
    throw new ValidationError([first, ...rest]);
  }
  if ('pipelineId' in state && state.pipelineId !== undefined) {
    const pipeline = await trx
      .selectFrom('crm.pipelines')
      .select('id')
      .where('business_id', '=', businessId)
      .where('id', '=', parsePublicId('pipeline', state.pipelineId) ?? '')
      .executeTakeFirst();
    if (pipeline === undefined)
      throw new ValidationError([
        {
          path: '/state/pipelineId',
          code: 'unknown_pipeline',
          message: 'Choose a pipeline in this business.',
        },
      ]);
  }
}
async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly ViewRow[],
  actorNames: ActorNames,
  people: ViewPeople | undefined,
): Promise<SavedView[]> {
  const shared = [...new Set(rows.flatMap((row) => row.shares.map((share) => share.user_id)))];
  const ids = [...new Set([...rows.map((row) => row.owner_user_id), ...shared])];
  const names =
    ids.length === 0 || actorNames.user === undefined
      ? new Map<string, string>()
      : await actorNames.user(trx, ids);
  // The owners' memberships and those of the people shared with, as the team has them now.
  const memberships =
    ids.length === 0 || people === undefined
      ? new Map<string, string>()
      : await people.assignees.memberships(trx, invocation.context, ids);
  return rows.map((row) => {
    const [sort] = storedSort.parse(row.sort);
    const state = {
      ...z.record(z.string(), z.unknown()).parse(row.filters),
      ...(sort === undefined
        ? {}
        : 'by' in sort
          ? { sort: sort.by }
          : {
              sortField: sort.fieldId,
              ...(sort.order === undefined ? {} : { fieldOrder: sort.order }),
            }),
    };
    const owner = isPerson(invocation) && row.owner_user_id === invocation.context.userId;
    const save = isPerson(invocation) && granted(invocation, 'views.save');
    const access = accessOf(invocation, row);
    return savedView.parse({
      id: toPublicId('saved_view', row.id),
      objectKey: row.object_key,
      name: row.name,
      visibility: row.visibility,
      access,
      owner: {
        membershipId: memberships.get(row.owner_user_id) ?? null,
        name: names.get(row.owner_user_id) ?? null,
        you: owner,
      },
      sharing: {
        everyone: row.visibility === 'shared' ? row.shared_access : null,
        // Someone whose share no longer counts shows as no longer on the team: choosing
        // them again shares it anew.
        people: row.shares.map((share) => ({
          membershipId: share.live ? (memberships.get(share.user_id) ?? null) : null,
          name: names.get(share.user_id) ?? null,
          you: isPerson(invocation) && share.user_id === invocation.context.userId,
          access: share.access,
        })),
      },
      state,
      columns: row.columns,
      // The whole table's columns, of the contact list and the deal list.
      tableColumns: row.table_columns,
      // A contact table's whole layout, custom fields included, and its resized columns.
      ...(row.object_key === 'contact'
        ? { columnLayout: row.column_layout, columnWidths: row.column_widths }
        : {}),
      canChange: save && (access !== 'view' || managed(invocation, row)),
      canShare: owner && row.visibility === 'private' && granted(invocation, 'views.share'),
      canUnshare: owner && row.visibility !== 'private' && save,
      canDelete: save && deletable(invocation, row),
      canChangeSharing: access !== 'view' && granted(invocation, 'views.share'),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      revision: revisionOf(row),
    });
  });
}

export function createViewCommand(
  actorNames: ActorNames,
  people?: ViewPeople,
): Command<typeof createViewInput, SavedView> {
  return defineCommand({
    name: 'view.create',
    permission: 'views.save',
    input: createViewInput,
    audit: ({ objectKey }) => ({ objectKey }),
    async handle(trx, input, command): Promise<SavedView> {
      const businessId = requireBusiness(command.context);
      const owner = person(command);
      await validateState(trx, businessId, input.objectKey, input.state);
      const object = await trx
        .selectFrom('crm.object_types')
        .select('id')
        .where('business_id', '=', businessId)
        .where('kind', '=', input.objectKey)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const existing = await trx
        .selectFrom('crm.saved_views')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('business_id', '=', businessId)
        .where('object_type_id', '=', object.id)
        .where('owner_user_id', '=', owner)
        .executeTakeFirstOrThrow();
      if (Number(existing.count) >= OWNED_VIEW_LIMIT)
        throw new ValidationError([
          {
            path: '',
            code: 'view_limit',
            message: `You can save up to ${String(OWNED_VIEW_LIMIT)} views for this object. Delete a view before saving another.`,
          },
        ]);
      const row = await trx
        .insertInto('crm.saved_views')
        .values({
          business_id: businessId,
          object_type_id: object.id,
          owner_user_id: owner,
          name: input.name,
          visibility: 'private',
          ...storage(input.state),
          columns: JSON.stringify(input.columns),
          table_columns:
            'tableColumns' in input && input.tableColumns !== undefined
              ? JSON.stringify(input.tableColumns)
              : null,
          column_layout:
            'columnLayout' in input && input.columnLayout !== undefined
              ? JSON.stringify(input.columnLayout)
              : null,
          column_widths:
            'columnWidths' in input && input.columnWidths !== undefined
              ? JSON.stringify(input.columnWidths)
              : null,
        })
        .returningAll()
        .returning(version)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'view.created',
        subject: { kind: 'saved_view', id: row.id },
        payload: {},
      });
      const [saved] = await present(
        trx,
        command,
        [{ ...row, object_key: input.objectKey, shares: [] }],
        actorNames,
        people,
      );
      if (saved === undefined) throw new TypeError('The saved view must be present.');
      return saved;
    },
  });
}

/**
 * Locks the view's object, then the view: every change to how many views are shared takes
 * the two locks in this order, so two of them never wait on each other.
 */
async function lockForSharing(
  trx: DatabaseTransaction,
  businessId: string,
  id: string,
  check: (row: ViewRow) => void,
): Promise<ViewRow> {
  const visible = await requireView(trx, id);
  check(visible);
  await trx
    .selectFrom('crm.object_types')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', '=', visible.object_type_id)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  return lockFor(trx, id, check);
}

/**
 * The view, locked, once the reader may do what they ask. It is asked of the view as they
 * see it first: the database locks a view only for those who may change it, so someone
 * who may only view it is told so rather than that it is not there. Then again, locked.
 */
async function lockFor(
  trx: DatabaseTransaction,
  id: string,
  check: (row: ViewRow) => void,
): Promise<ViewRow> {
  check(await requireView(trx, id));
  const current = await requireView(trx, id, true);
  check(current);
  return current;
}

/** Refuses a view newly shared once the team shares as many of this object's as it may. */
async function checkSharedLimit(trx: DatabaseTransaction, current: ViewRow): Promise<void> {
  if (current.visibility !== 'private') return;
  // Counted past what the sharer can see: the team's lists shared by name with others too.
  const existing = await sql<{
    count: string;
  }>`select private.shared_saved_view_count(${current.object_type_id})::text as count`.execute(trx);
  if (Number(existing.rows[0]?.count ?? 0) >= SHARED_VIEW_LIMIT)
    throw new ValidationError([
      {
        path: '',
        code: 'shared_view_limit',
        message: `This team can share up to ${String(SHARED_VIEW_LIMIT)} views for this object. Make a shared view private or delete it before sharing another.`,
      },
    ]);
}

/** Someone chosen to share a view with, and what they may do. */
interface Chosen {
  readonly user_id: string;
  readonly access: string;
}

/** Who a view is shared with, as stored. */
interface StoredSharing {
  readonly visibility: 'private' | 'shared' | 'selected';
  readonly sharedAccess: ViewAccessLevel;
  readonly shares: readonly Chosen[];
}

/**
 * Stores who a view is shared with. The new shares are written first and the old ones
 * removed last, so the person changing it can see the view at every step. A share that no
 * longer counts goes first, so someone chosen again is shared with anew; one that counts
 * keeps its place, whatever its level becomes.
 */
async function storeSharing(
  trx: DatabaseTransaction,
  current: ViewRow,
  next: StoredSharing,
): Promise<ViewRow> {
  const spent = current.shares.filter((share) => !share.live).map((share) => share.user_id);
  if (spent.length > 0)
    await trx
      .deleteFrom('crm.saved_view_shares')
      .where('view_id', '=', current.id)
      .where('user_id', 'in', spent)
      .execute();
  if (next.shares.length > 0)
    await trx
      .insertInto('crm.saved_view_shares')
      .values(
        next.shares.map((share) => ({
          business_id: current.business_id,
          view_id: current.id,
          user_id: share.user_id,
          access: share.access,
        })),
      )
      .onConflict((conflict) =>
        conflict
          .columns(['business_id', 'view_id', 'user_id'])
          .doUpdateSet((eb) => ({ access: eb.ref('excluded.access') })),
      )
      .execute();
  const unchanged =
    current.visibility === next.visibility && current.shared_access === next.sharedAccess;
  const row = unchanged
    ? current
    : await trx
        .updateTable('crm.saved_views')
        .set({ visibility: next.visibility, shared_access: next.sharedAccess })
        .where('id', '=', current.id)
        .returningAll()
        .returning(version)
        .executeTakeFirstOrThrow();
  const kept = next.shares.map((share) => share.user_id);
  const gone = current.shares.filter((share) => share.live && !kept.includes(share.user_id));
  if (gone.length > 0)
    await trx
      .deleteFrom('crm.saved_view_shares')
      .where('view_id', '=', current.id)
      .where(
        'user_id',
        'in',
        gone.map((share) => share.user_id),
      )
      .execute();
  // Read back as every reader reads them, in their order: the revision names the shares,
  // so a reader holding the old one is told it changed.
  const shares = (await sharesOf(trx, [current.id])).get(current.id) ?? [];
  return { ...row, object_key: current.object_key, shares };
}

export function visibilityCommand(
  actorNames: ActorNames,
  visibility: 'private' | 'shared',
  people?: ViewPeople,
): Command<typeof shareCommandInput | typeof unshareCommandInput, SavedView> {
  return defineCommand({
    name: visibility === 'shared' ? 'view.share' : 'view.unshare',
    permission: visibility === 'shared' ? 'views.share' : 'views.save',
    input: visibility === 'shared' ? shareCommandInput : unshareCommandInput,
    audit: ({ id }) => ({ id }),
    async handle(trx, input, command): Promise<SavedView> {
      const businessId = requireBusiness(command.context);
      const owner = person(command);
      const current = await lockForSharing(trx, businessId, input.id, (row) => {
        if (row.owner_user_id !== owner)
          throw new ForbiddenError(
            visibility === 'shared'
              ? "Only the view's owner can share it."
              : "Only the view's owner can make it private.",
          );
      });
      checkRevision(current, input.revision);
      if (visibility === 'shared') await checkSharedLimit(trx, current);
      // Sharing with the team is everyone, able to view it, as it always was; private is
      // nobody else. Either way nobody keeps a share by name.
      const unchanged =
        current.visibility === visibility &&
        current.shared_access === 'view' &&
        current.shares.length === 0;
      const row = unchanged
        ? current
        : await storeSharing(trx, current, { visibility, sharedAccess: 'view', shares: [] });
      if (current.visibility !== visibility)
        await command.emit({
          type: visibility === 'shared' ? 'view.shared' : 'view.unshared',
          subject: { kind: 'saved_view', id: current.id },
          payload: {},
        });
      const [saved] = await present(trx, command, [row], actorNames, people);
      if (saved === undefined) throw new TypeError('The saved view must be present.');
      return saved;
    },
  });
}

/** The people a sharing names, as users, each refused with its place when not on the team. */
async function sharesNamed(
  trx: DatabaseTransaction,
  command: Invocation,
  people: ViewPeople | undefined,
  named: z.output<typeof viewSharingInput>['people'],
): Promise<Chosen[]> {
  const shares: Chosen[] = [];
  const issues: Issue[] = [];
  for (const [index, each] of named.entries()) {
    let userId: string | null = null;
    if (people !== undefined)
      try {
        userId = await people.assignees.resolve(trx, command.context, each.membershipId);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
      }
    if (userId === null)
      issues.push({
        path: `/people/${String(index)}/membershipId`,
        code: 'unavailable_member',
        message: 'Choose someone on this business or agency team.',
      });
    else shares.push({ user_id: userId, access: each.access });
  }
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  // A person on the team through both the business and its agency is still one person.
  if (new Set(shares.map((share) => share.user_id)).size !== shares.length)
    throw new ValidationError([
      { path: '/people', code: 'duplicate_person', message: 'Name each person once.' },
    ]);
  return shares;
}

/**
 * Chooses who a view is shared with: everyone at one level, or chosen team members each at
 * theirs. Its owner and those it is shared with to edit may change it, as GoHighLevel's
 * editors may; only the owner makes it private, and an editor keeps their own access.
 */
export function sharingCommand(
  actorNames: ActorNames,
  people?: ViewPeople,
): Command<typeof sharingCommandInput, SavedView> {
  return defineCommand({
    name: 'view.set_sharing',
    permission: 'views.share',
    input: sharingCommandInput,
    audit: ({ id }) => ({ id }),
    async handle(trx, input, command): Promise<SavedView> {
      const businessId = requireBusiness(command.context);
      const me = person(command);
      const current = await lockForSharing(trx, businessId, input.id, (row) => {
        if (accessOf(command, row) === 'view')
          throw new ForbiddenError(
            "Only the view's owner, or someone it is shared with to edit, can change who it is shared with.",
          );
      });
      const access = accessOf(command, current);
      checkRevision(current, input.revision);
      const shares = await sharesNamed(trx, command, people, input.people);
      const ownerAt = shares.findIndex((share) => share.user_id === current.owner_user_id);
      if (ownerAt >= 0)
        throw new ValidationError([
          {
            path: `/people/${String(ownerAt)}/membershipId`,
            code: 'view_owner',
            message: 'The owner always has the view. Choose someone else.',
          },
        ]);
      const visibility =
        input.everyone !== null ? 'shared' : shares.length > 0 ? 'selected' : 'private';
      if (access === 'edit') {
        if (visibility === 'private')
          throw new ForbiddenError("Only the view's owner can make it private.");
        // Whichever way it is shared, the editor still edits: by name, or as everyone.
        const keeps =
          visibility === 'shared'
            ? input.everyone === 'edit'
            : shares.find((share) => share.user_id === me)?.access === 'edit';
        if (!keeps)
          throw new ForbiddenError(
            'Keep your own access to edit. Only the owner can take it away.',
          );
      }
      if (visibility !== 'private') await checkSharedLimit(trx, current);
      const row = await storeSharing(trx, current, {
        visibility,
        sharedAccess: input.everyone ?? 'view',
        shares,
      });
      if (revisionOf(row) !== revisionOf(current))
        await command.emit({
          type: 'view.sharing_changed',
          subject: { kind: 'saved_view', id: current.id },
          payload: {},
        });
      const [saved] = await present(trx, command, [row], actorNames, people);
      if (saved === undefined) throw new TypeError('The saved view must be present.');
      return saved;
    },
  });
}

export function updateViewCommand(
  actorNames: ActorNames,
  people?: ViewPeople,
): Command<typeof updateCommandInput, SavedView> {
  return defineCommand({
    name: 'view.update',
    permission: 'views.save',
    input: updateCommandInput,
    audit: ({ id }) => ({ id }),
    async handle(trx, input, command): Promise<SavedView> {
      const businessId = requireBusiness(command.context);
      const current = await lockFor(trx, input.id, (row) => {
        requireChange(command, row);
      });
      const { id: _id, ...changes } = input;
      const parsed = parseInput(
        current.object_key === 'contact' ? contactViewChanges : dealViewChanges,
        changes,
      );
      checkRevision(current, parsed.revision);
      await validateState(
        trx,
        businessId,
        current.object_key === 'contact' ? 'contact' : 'deal',
        parsed.state,
      );
      const row = await trx
        .updateTable('crm.saved_views')
        .set({
          name: parsed.name,
          ...storage(parsed.state),
          columns: JSON.stringify(parsed.columns),
          // Left out, the table's columns stay: a screen that does not know them sends
          // none, and must not erase what another screen saved.
          ...('tableColumns' in parsed && parsed.tableColumns !== undefined
            ? {
                table_columns:
                  parsed.tableColumns === null ? null : JSON.stringify(parsed.tableColumns),
              }
            : {}),
          ...('columnLayout' in parsed && parsed.columnLayout !== undefined
            ? {
                column_layout:
                  parsed.columnLayout === null ? null : JSON.stringify(parsed.columnLayout),
              }
            : {}),
          ...('columnWidths' in parsed && parsed.columnWidths !== undefined
            ? {
                column_widths:
                  parsed.columnWidths === null ? null : JSON.stringify(parsed.columnWidths),
              }
            : {}),
        })
        .where('id', '=', current.id)
        .returningAll()
        .returning(version)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'view.updated',
        subject: { kind: 'saved_view', id: row.id },
        payload: {},
      });
      const [saved] = await present(
        trx,
        command,
        [{ ...row, object_key: current.object_key, shares: current.shares }],
        actorNames,
        people,
      );
      if (saved === undefined) throw new TypeError('The saved view must be present.');
      return saved;
    },
  });
}
export const deleteViewCommand = defineCommand({
  name: 'view.delete',
  permission: 'views.save',
  input: deleteViewInput.extend(deleteView.params.shape),
  audit: ({ id }) => ({ id }),
  async handle(trx, input, command): Promise<undefined> {
    requireBusiness(command.context);
    const current = await lockFor(trx, input.id, (row) => {
      requireDelete(command, row);
    });
    checkRevision(current, input.revision);
    await trx.deleteFrom('crm.saved_views').where('id', '=', current.id).execute();
    await command.emit({
      type: 'view.deleted',
      subject: { kind: 'saved_view', id: current.id },
      payload: {},
    });
    return undefined;
  },
});

export async function readViews(
  trx: DatabaseTransaction,
  invocation: Invocation,
  objectKey: ObjectKey,
  actorNames: ActorNames,
  people?: ViewPeople,
): Promise<ViewList> {
  // Your own views and those shared with you, with everyone or by name: at most as many as
  // you may own and the team may share. Your own come first to the cap, so none is ever
  // left out, then all are in name order.
  const mine = isPerson(invocation) ? (invocation.context.userId ?? null) : null;
  const visible = trx
    .selectFrom('crm.saved_views as v')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.business_id', '=', 'v.business_id').onRef('o.id', '=', 'v.object_type_id'),
    )
    .selectAll('v')
    .select('o.kind as object_key')
    .select(sql<string>`extract(epoch from v.updated_at)::text`.as('version'))
    .where('o.kind', '=', objectKey)
    .orderBy(sql`(v.owner_user_id = ${mine}) is true desc`)
    .orderBy(sql`lower(v.name)`)
    .orderBy('v.id')
    .limit(OWNED_VIEW_LIMIT + SHARED_VIEW_LIMIT);
  const rows = await trx
    .selectFrom(visible.as('r'))
    .selectAll()
    .orderBy(sql`lower(r.name)`)
    .orderBy('r.id')
    .execute();
  // Every row's shares, as one view's are read alone, so its revision is the same either way.
  const shares = await sharesOf(
    trx,
    rows.map((row) => row.id),
  );
  return {
    canSave: isPerson(invocation) && granted(invocation, 'views.save'),
    items: await present(
      trx,
      invocation,
      rows.map((row) => ({ ...row, shares: shares.get(row.id) ?? [] })),
      actorNames,
      people,
    ),
  };
}
