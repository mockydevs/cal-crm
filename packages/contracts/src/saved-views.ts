// Saved views of the contact and deal lists. A view has a name, the list's state and its
// visible built-in columns. It's private to the person who saved it until they share it.
// The state is what the dashboard keeps in the list's address, never a page cursor or a
// date, so a shared view opens the same for everyone, today and later.
import * as z from 'zod';

import { contactFilter } from './contact-filters.js';
import { dealSorts, sortDirections } from './deals.js';
import { defineEndpoint } from './endpoints.js';
import { fieldQueryShape, refineFieldQuery } from './field-query.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';
import { contactViewColumnKeys, dealViewColumnKeys } from './view-columns.js';

export { contactViewColumnKeys, dealViewColumnKeys } from './view-columns.js';

const search = z.string().trim().max(200, { error: 'Use at most 200 characters.' });

/** The contact list's state, as its address keeps it: newest first unless sorted by name. */
export const contactViewState = z
  .strictObject({
    q: search.optional(),
    sort: z.literal('name').optional(),
    added: z
      .enum(['week', 'month'])
      .optional()
      .meta({ description: 'Added in the last week or month, counted when the view opens.' }),
    direction: z.enum(sortDirections).optional().meta({
      description:
        'Which way the built-in order runs (task B3.07). Left out: names from A, newest first.',
    }),
    filter: contactFilter.optional().meta({
      description:
        "The Filters panel's conditions (task B3.06), kept as they are and sent to the list as its filter parameter.",
    }),
    ...fieldQueryShape,
  })
  .superRefine((state, context) => {
    refineFieldQuery(state, context);
    if (state.direction !== undefined && state.sortField !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['direction'],
        message: 'A field has its own direction: use fieldOrder.',
      });
    // One order applies to a list: by name, or by a field.
    if (state.sort !== undefined && state.sortField !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['sortField'],
        message: 'Sort by name or by a field, not both.',
      });
  })
  .meta({ id: 'ContactViewState' });
export type ContactViewState = z.output<typeof contactViewState>;

/**
 * The deal list's state: its pipeline and status, the board or the table, and the name
 * search (the last two are the dashboard's own).
 */
export const dealViewState = z
  .strictObject({
    pipelineId: publicId('pipeline').optional(),
    status: z.enum(['open', 'won', 'lost', 'all']).optional(),
    layout: z.enum(['board', 'table']).optional(),
    q: search.optional(),
    sort: z.enum(dealSorts).optional().meta({
      description: "The list's built-in order (task B3.11). Left out, newest first.",
    }),
    direction: z.enum(sortDirections).optional(),
    ...fieldQueryShape,
  })
  .superRefine((state, context) => {
    refineFieldQuery(state, context);
    // One order applies to a list: a built-in one, or a field.
    if (state.sort !== undefined && state.sortField !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['sortField'],
        message: 'Sort by a built-in order or by a field, not both.',
      });
    if (state.direction !== undefined && state.sort === undefined)
      context.addIssue({
        code: 'custom',
        path: ['direction'],
        message: 'A direction belongs to a built-in order.',
      });
  })
  .meta({ id: 'DealViewState' });
export type DealViewState = z.output<typeof dealViewState>;

function columnRules(columns: readonly string[], context: z.RefinementCtx): void {
  if (!columns.includes('name'))
    context.addIssue({ code: 'custom', message: 'Show the name column.' });
  if (new Set(columns).size !== columns.length)
    context.addIssue({ code: 'custom', message: 'Show each column once.' });
}
const columnsDescription = 'The visible built-in columns, in order. The name is always one.';
export const contactViewColumns = z
  .array(z.enum(contactViewColumnKeys))
  .max(contactViewColumnKeys.length)
  .superRefine(columnRules)
  .meta({ id: 'ContactViewColumns', description: columnsDescription });
export const dealViewColumns = z
  .array(z.enum(dealViewColumnKeys))
  .max(dealViewColumnKeys.length)
  .superRefine(columnRules)
  .meta({ id: 'DealViewColumns', description: columnsDescription });

/**
 * Every column the contact table can show, in the order a new list shows them. `columns`
 * above keeps the four the first table had, for the screens built on it; `tableColumns` is
 * the whole choice, in the order the person put them.
 */
export const contactTableColumnKeys = [
  'name',
  'phone',
  'email',
  'company',
  'added',
  'lastActivity',
  'tags',
  'emailVerification',
] as const;
export type ContactTableColumnKey = (typeof contactTableColumnKeys)[number];
export const contactTableColumns = z
  .array(z.enum(contactTableColumnKeys))
  .min(1)
  .max(contactTableColumnKeys.length)
  .superRefine((columns, context) => {
    if (columns[0] !== 'name')
      context.addIssue({ code: 'custom', message: 'Keep the name as the first column.' });
    if (new Set(columns).size !== columns.length)
      context.addIssue({ code: 'custom', message: 'Show each column once.' });
  })
  .meta({
    id: 'ContactTableColumns',
    description:
      'The columns the contact table shows, in order, saved with the list. The name is always the first.',
  });

/** At most this many columns in a contact table's layout. */
export const MAX_CONTACT_LAYOUT_COLUMNS = 30;

/**
 * The contact table's whole layout: built-in columns and custom fields in the order the
 * person put them, a field named by its id. `tableColumns` keeps the built-in columns
 * alone, for the screens built on it; a screen that shows custom fields as columns saves
 * this beside it.
 */
export const contactColumnLayout = z
  .array(
    z.union([z.enum(contactTableColumnKeys), publicId('field')]).meta({
      description: 'A built-in column by its key, or a custom field of contacts by its id.',
    }),
  )
  .min(1)
  .max(MAX_CONTACT_LAYOUT_COLUMNS, {
    error: `Show at most ${String(MAX_CONTACT_LAYOUT_COLUMNS)} columns.`,
  })
  .superRefine((columns, context) => {
    if (columns[0] !== 'name')
      context.addIssue({ code: 'custom', message: 'Keep the name as the first column.' });
    if (new Set(columns).size !== columns.length)
      context.addIssue({ code: 'custom', message: 'Show each column once.' });
  })
  .meta({
    id: 'ContactColumnLayout',
    description:
      'Every column the contact table shows, in order: built-in columns by key and custom fields by id. The name is always the first.',
  });
export type ContactColumnLayout = z.output<typeof contactColumnLayout>;

/** The narrowest a dragged column can be: its header's start stays readable. */
export const MIN_COLUMN_WIDTH = 80;
/** The widest a dragged column can be. */
export const MAX_COLUMN_WIDTH = 800;

/** Whether a key names a contact table column: a built-in one, or a custom field by its id. */
function isContactColumn(key: string): boolean {
  return (
    contactTableColumnKeys.some((builtIn) => builtIn === key) ||
    publicId('field').safeParse(key).success
  );
}

/**
 * The widths the person dragged the contact table's columns to, in pixels, by column. A
 * column without one is as wide as its content asks.
 */
export const contactColumnWidths = z
  .record(
    z.string(),
    z
      .int()
      .min(MIN_COLUMN_WIDTH, { error: `Make a column at least ${String(MIN_COLUMN_WIDTH)} wide.` })
      .max(MAX_COLUMN_WIDTH, { error: `Make a column at most ${String(MAX_COLUMN_WIDTH)} wide.` }),
  )
  .superRefine((widths, context) => {
    const keys = Object.keys(widths);
    if (keys.length > MAX_CONTACT_LAYOUT_COLUMNS)
      context.addIssue({
        code: 'custom',
        message: `Give at most ${String(MAX_CONTACT_LAYOUT_COLUMNS)} columns a width.`,
      });
    for (const key of keys)
      if (!isContactColumn(key))
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Name a built-in column by its key, or a custom field of contacts by its id.',
        });
  })
  .meta({
    id: 'ContactColumnWidths',
    description:
      'The width of each resized column in pixels, by its key or field id. A column left out is as wide as its content.',
  });
export type ContactColumnWidths = z.output<typeof contactColumnWidths>;

/**
 * Every column the deal table can show, in the order a new list shows them. `columns` above
 * keeps the five the first table had, for the screens built on it; `tableColumns` is the
 * whole choice, in the order the person put them.
 */
export const dealTableColumnKeys = [
  'name',
  'contact',
  'stage',
  'value',
  'status',
  'owner',
  'tags',
  'created',
  'updated',
  'source',
  'expectedClose',
  'pipeline',
] as const;
export type DealTableColumnKey = (typeof dealTableColumnKeys)[number];
export const dealTableColumns = z
  .array(z.enum(dealTableColumnKeys))
  .min(1)
  .max(dealTableColumnKeys.length)
  .superRefine((columns, context) => {
    if (columns[0] !== 'name')
      context.addIssue({ code: 'custom', message: 'Keep the name as the first column.' });
    if (new Set(columns).size !== columns.length)
      context.addIssue({ code: 'custom', message: 'Show each column once.' });
  })
  .meta({
    id: 'DealTableColumns',
    description:
      'The columns the deal table shows, in order, saved with the list. The name is always the first.',
  });

const name = z
  .string()
  .trim()
  .min(1, { error: 'Give the view a name.' })
  .max(80, { error: 'Use at most 80 characters.' });
const revision = z.string().regex(/^[0-9a-f]{64}$/);

// A view's owner and visibility come from who saves and shares it, never from the input.
export const createViewInput = z
  .discriminatedUnion('objectKey', [
    z.strictObject({
      objectKey: z.literal('contact'),
      name,
      state: contactViewState,
      columns: contactViewColumns,
      tableColumns: contactTableColumns.optional().meta({
        description: 'Left out, the view has no column choice of its own.',
      }),
      columnLayout: contactColumnLayout.optional().meta({
        description: 'Left out, the view has no layout with custom fields.',
      }),
      columnWidths: contactColumnWidths.optional().meta({
        description: 'Left out, every column is as wide as its content.',
      }),
    }),
    z.strictObject({
      objectKey: z.literal('deal'),
      name,
      state: dealViewState,
      columns: dealViewColumns,
      tableColumns: dealTableColumns.optional().meta({
        description: 'Left out, the view has no column choice of its own.',
      }),
    }),
  ])
  .meta({ id: 'CreateViewInput' });

/** All of a contact view's details, replaced at the revision the caller read. */
export const contactViewChanges = z
  .strictObject({
    name,
    state: contactViewState,
    columns: contactViewColumns,
    tableColumns: contactTableColumns.nullable().optional().meta({
      description:
        'Left out, the saved choice stays as it is, so a screen that does not know it cannot erase it. Null removes it.',
    }),
    columnLayout: contactColumnLayout.nullable().optional().meta({
      description: 'Left out, the saved layout stays as it is. Null removes it.',
    }),
    columnWidths: contactColumnWidths.nullable().optional().meta({
      description: 'Left out, the saved widths stay as they are. Null removes them.',
    }),
    revision,
  })
  .meta({ id: 'ContactViewChanges' });
/** All of a deal view's details, replaced at the revision the caller read. */
export const dealViewChanges = z
  .strictObject({
    name,
    state: dealViewState,
    columns: dealViewColumns,
    tableColumns: dealTableColumns.nullable().optional().meta({
      description:
        'Left out, the saved choice stays as it is, so a screen that does not know it cannot erase it. Null removes it.',
    }),
    revision,
  })
  .meta({ id: 'DealViewChanges' });
/**
 * A view keeps the kind of list it was saved for, so a change names no kind: the server
 * checks it against the view's own, with contactViewChanges or dealViewChanges.
 */
export const updateViewInput = z
  .union([contactViewChanges, dealViewChanges])
  .meta({ id: 'UpdateViewInput' });
export const deleteViewInput = z.strictObject({ revision }).meta({ id: 'DeleteViewInput' });
export const shareViewInput = z.strictObject({ revision }).meta({ id: 'ShareViewInput' });
export const unshareViewInput = z.strictObject({ revision }).meta({ id: 'UnshareViewInput' });

/** What someone a view is shared with may do: open and use it, or also change it. */
export const viewAccessLevels = ['view', 'edit'] as const;
export type ViewAccessLevel = (typeof viewAccessLevels)[number];
const accessLevel = z.enum(viewAccessLevels).meta({
  id: 'ViewAccessLevel',
  description:
    'view: open and use the view. edit: also change what it shows and who it is shared with.',
});

/** At most this many people a view is shared with by name. */
export const MAX_VIEW_SHARES = 100;

/**
 * Who a view is shared with, replaced whole: everyone in the business at one level, or the
 * people named, each at their own. Neither makes it private to its owner again.
 */
export const viewSharingInput = z
  .strictObject({
    everyone: accessLevel.nullable().meta({
      description: 'Share with everyone in the business at this level. Null: not with everyone.',
    }),
    people: z
      .array(z.strictObject({ membershipId: publicId('membership'), access: accessLevel }))
      .max(MAX_VIEW_SHARES, { error: `Share with at most ${String(MAX_VIEW_SHARES)} people.` })
      .meta({ description: 'Team members to share with, each by their membership.' }),
    revision,
  })
  .superRefine((input, context) => {
    if (input.everyone !== null && input.people.length > 0)
      context.addIssue({
        code: 'custom',
        path: ['people'],
        message: 'Share with everyone or with chosen people, not both.',
      });
    const named = input.people.map((person) => person.membershipId);
    if (new Set(named).size !== named.length)
      context.addIssue({ code: 'custom', path: ['people'], message: 'Name each person once.' });
  })
  .meta({ id: 'ViewSharingInput' });
export type ViewSharingInput = z.output<typeof viewSharingInput>;

export const viewSharedPerson = z
  .looseObject({
    membershipId: publicId('membership').nullable().meta({
      description: 'Their membership of the team. Null when they are no longer on it.',
    }),
    name: z.string().nullable(),
    you: z.boolean(),
    access: accessLevel,
  })
  .meta({ id: 'ViewSharedPerson', description: 'Someone a view is shared with by name.' });
export type ViewSharedPerson = z.output<typeof viewSharedPerson>;

const shown = {
  id: publicId('saved_view'),
  name: z.string(),
  visibility: z.enum(['private', 'shared', 'selected']).meta({
    description:
      "private: its owner's alone. shared: everyone in the business. selected: the people its sharing names.",
  }),
  access: z.enum(['owner', ...viewAccessLevels]).meta({
    description: 'What the reader has: the view is theirs, they may change it, or open and use it.',
  }),
  sharing: z
    .looseObject({
      everyone: accessLevel.nullable(),
      people: z.array(viewSharedPerson),
    })
    .meta({ id: 'ViewSharing', description: 'Who the view is shared with, and how.' }),
  canDelete: z.boolean().meta({
    description: 'Whether the reader may delete it: its owner, or someone who can share views.',
  }),
  canChangeSharing: z.boolean().meta({
    description: 'Whether the reader may choose who it is shared with (setViewSharing).',
  }),
  owner: z.looseObject({
    membershipId: publicId('membership').nullable().meta({
      description:
        'Their membership of the team, as sharing names people. Null when they are no longer on it.',
    }),
    name: z
      .string()
      .nullable()
      .meta({ description: "Null when the reader can't see who it is, such as someone who left." }),
    you: z.boolean(),
  }),
  canChange: z.boolean().meta({
    description:
      'Whether the reader may change what it shows or rename it: its owner, someone it is shared with to edit, or someone who can share views.',
  }),
  canShare: z.boolean().meta({ description: 'Whether the reader may share it with the team.' }),
  canUnshare: z.boolean().meta({ description: 'Whether the reader may make it private again.' }),
  createdAt: timestamp,
  updatedAt: timestamp,
  revision,
};
export const savedView = z
  .discriminatedUnion('objectKey', [
    z.looseObject({
      objectKey: z.literal('contact'),
      ...shown,
      state: contactViewState,
      columns: contactViewColumns,
      tableColumns: contactTableColumns.nullable().optional().meta({
        description: 'Null when the view has no column choice of its own.',
      }),
      columnLayout: contactColumnLayout.nullable().optional().meta({
        description: 'Null when the view has no layout with custom fields.',
      }),
      columnWidths: contactColumnWidths.nullable().optional().meta({
        description: 'Null when no column of the view has been resized.',
      }),
    }),
    z.looseObject({
      objectKey: z.literal('deal'),
      ...shown,
      state: dealViewState,
      columns: dealViewColumns,
      tableColumns: dealTableColumns.nullable().optional().meta({
        description: 'Null when the view has no column choice of its own.',
      }),
    }),
  ])
  .meta({ id: 'SavedView' });
export type SavedView = z.output<typeof savedView>;
export const viewList = z
  .looseObject({
    canSave: z.boolean().meta({ description: 'Whether the reader may save views of this list.' }),
    items: z.array(savedView),
  })
  .meta({ id: 'ViewList' });
export type ViewList = z.output<typeof viewList>;

const viewParams = z.object({ id: publicId('saved_view') });
export const listViews = defineEndpoint({
  operationId: 'listViews',
  method: 'get',
  path: '/views',
  summary: 'List the saved views of contacts or deals',
  group: 'Views',
  query: z
    .strictObject({
      object: z.enum(['contact', 'deal']).meta({ description: 'The list the views are of.' }),
    })
    .meta({ id: 'ListViewsQuery' }),
  response: {
    status: 200,
    description: "Your private views and the team's shared ones, by name.",
    schema: viewList,
  },
});
export const createView = defineEndpoint({
  operationId: 'createView',
  method: 'post',
  path: '/views',
  summary: 'Save a view of a list, private to you',
  group: 'Views',
  body: createViewInput,
  response: {
    status: 201,
    description: 'The view, private to you until you share it.',
    schema: savedView,
  },
});
export const updateView = defineEndpoint({
  operationId: 'updateView',
  method: 'put',
  path: '/views/{id}',
  summary: 'Replace a view without overwriting another change',
  group: 'Views',
  params: viewParams,
  body: updateViewInput,
  response: { status: 200, description: 'The view as saved.', schema: savedView },
});
export const deleteView = defineEndpoint({
  operationId: 'deleteView',
  method: 'delete',
  path: '/views/{id}',
  summary: 'Delete a view after checking its revision',
  group: 'Views',
  params: viewParams,
  body: deleteViewInput,
  response: { status: 204, description: 'The view was deleted.' },
});
export const shareView = defineEndpoint({
  operationId: 'shareView',
  method: 'post',
  path: '/views/{id}/share',
  summary: 'Share your view with the team',
  group: 'Views',
  params: viewParams,
  body: shareViewInput,
  response: { status: 200, description: 'The view, now shared.', schema: savedView },
});
export const unshareView = defineEndpoint({
  operationId: 'unshareView',
  method: 'post',
  path: '/views/{id}/unshare',
  summary: 'Make your shared view private again',
  group: 'Views',
  params: viewParams,
  body: unshareViewInput,
  response: { status: 200, description: 'The view, private to you again.', schema: savedView },
});
export const setViewSharing = defineEndpoint({
  operationId: 'setViewSharing',
  method: 'put',
  path: '/views/{id}/sharing',
  summary: 'Choose who a view is shared with',
  group: 'Views',
  params: viewParams,
  body: viewSharingInput,
  response: {
    status: 200,
    description:
      'The view, shared as asked: with everyone in the business, or with chosen team members, each able to view it or also edit it. Its owner, and anyone it is shared with to edit, may change this; only its owner may make it private.',
    schema: savedView,
  },
});
