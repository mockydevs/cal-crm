import { describe, expect, it } from 'vitest';

import {
  contactViewChanges,
  contactViewColumns,
  contactViewState,
  createView,
  createViewInput,
  dealViewChanges,
  dealViewColumns,
  dealViewState,
  deleteView,
  deleteViewInput,
  endpoints,
  listViews,
  savedView,
  shareView,
  shareViewInput,
  unshareView,
  unshareViewInput,
  updateView,
  updateViewInput,
  viewList,
  contactColumnWidths,
  MAX_COLUMN_WIDTH,
  MAX_VIEW_SHARES,
  MIN_COLUMN_WIDTH,
  setViewSharing,
  viewSharingInput,
} from './index.js';
import { openApiDocument } from './openapi.js';

const field = 'fld_01h455vb4pex5vsknk084sn02q';
const pipeline = 'pipe_01h455vb4pex5vsknk084sn02q';
const viewId = 'view_01h455vb4pex5vsknk084sn02q';
const revision = 'a'.repeat(64);
const at = '2026-10-09T09:00:00.000Z';

describe('a contact view state', () => {
  it('keeps the list search, the name order, a relative period and one field filter', () => {
    expect(contactViewState.parse({})).toEqual({});
    expect(
      contactViewState.parse({
        q: '  maya ',
        sort: 'name',
        added: 'month',
        fieldId: field,
        fieldOperator: 'contains',
        fieldValue: 'Gold',
      }),
    ).toEqual({
      q: 'maya',
      sort: 'name',
      added: 'month',
      fieldId: field,
      fieldOperator: 'contains',
      fieldValue: 'Gold',
    });
  });

  it.each([
    ['a cursor', { after: 'con_01h455vb4pex5vsknk084sn02q' }],
    ['a page size', { limit: 50 }],
    ['an absolute start', { createdFrom: at }],
    ['an absolute end', { createdBefore: at }],
    ['the default order spelled out', { sort: 'newest' }],
    ['an unknown period', { added: 'year' }],
    ['a deal status', { status: 'open' }],
    ['a pipeline', { pipelineId: pipeline }],
    ['a search over 200 characters', { q: 'x'.repeat(201) }],
  ])('refuses %s', (_case, state) => {
    expect(contactViewState.safeParse(state).success).toBe(false);
  });

  it('applies one order: the name order or a field order, not both', () => {
    expect(contactViewState.parse({ sortField: field, fieldOrder: 'desc' })).toEqual({
      sortField: field,
      fieldOrder: 'desc',
    });
    const both = contactViewState.safeParse({ sort: 'name', sortField: field });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]).toMatchObject({
      path: ['sortField'],
      message: 'Sort by name or by a field, not both.',
    });
  });

  it.each([
    [{ fieldOperator: 'equals', fieldValue: 'Gold' }, 'Choose a field to filter.'],
    [{ fieldId: field }, 'Choose how to match this field.'],
    [
      { fieldId: field, fieldOperator: 'is_set', fieldValue: 'Gold' },
      'A set/unset filter takes no value.',
    ],
    [{ fieldId: field, fieldOperator: 'equals' }, 'Enter the field value to match.'],
    [{ fieldOrder: 'asc' }, 'Choose a field to sort.'],
  ])('checks a field query as the contact list does: %j', (state, message) => {
    expect(contactViewState.safeParse(state).error?.issues[0]?.message).toBe(message);
  });

  it('takes field ids only where a field goes', () => {
    expect(
      contactViewState.safeParse({
        fieldId: 'con_01h455vb4pex5vsknk084sn02q',
        fieldOperator: 'is_set',
      }).success,
    ).toBe(false);
  });
});

describe('a deal view state', () => {
  it('keeps the pipeline, status, layout, name search and field query', () => {
    expect(dealViewState.parse({})).toEqual({});
    expect(
      dealViewState.parse({
        pipelineId: pipeline,
        status: 'won',
        layout: 'table',
        q: ' garden ',
        sortField: field,
        fieldOrder: 'asc',
      }),
    ).toEqual({
      pipelineId: pipeline,
      status: 'won',
      layout: 'table',
      q: 'garden',
      sortField: field,
      fieldOrder: 'asc',
    });
  });

  it.each([
    ['a cursor', { after: 'deal_01h455vb4pex5vsknk084sn02q' }],
    ['a page size', { limit: 100 }],
    ['an order the deal list has none of', { sort: 'newest' }],
    ['a direction without an order', { direction: 'asc' }],
    ['a contact period', { added: 'week' }],
    ['an unknown status', { status: 'closed' }],
    ['an unknown layout', { layout: 'grid' }],
    ['another kind of id as the pipeline', { pipelineId: field }],
    ['a search over 200 characters', { q: 'x'.repeat(201) }],
  ])('refuses %s', (_case, state) => {
    expect(dealViewState.safeParse(state).success).toBe(false);
  });

  it('checks a field query as the deal list does', () => {
    expect(
      dealViewState.safeParse({ fieldOperator: 'lt', fieldValue: '5' }).error?.issues[0]?.message,
    ).toBe('Choose a field to filter.');
  });
});

describe('view columns', () => {
  it('keep the order of the visible built-in columns', () => {
    expect(contactViewColumns.parse(['email', 'name', 'added'])).toEqual([
      'email',
      'name',
      'added',
    ]);
    expect(dealViewColumns.parse(['name', 'stage', 'amount', 'outcome', 'expectedClose'])).toEqual([
      'name',
      'stage',
      'amount',
      'outcome',
      'expectedClose',
    ]);
  });

  it.each([
    ['no columns', [], 'Show the name column.'],
    ['no name', ['email'], 'Show the name column.'],
    ['a column twice', ['name', 'email', 'email'], 'Show each column once.'],
  ])('refuses contact columns with %s', (_case, columns, message) => {
    expect(contactViewColumns.safeParse(columns).error?.issues[0]?.message).toBe(message);
  });

  it.each([
    ['contact', contactViewColumns, ['name', 'amount']],
    ['contact', contactViewColumns, ['name', 'tags']],
    ['deal', dealViewColumns, ['name', 'email']],
    ['deal', dealViewColumns, ['amount', 'stage']],
    ['deal', dealViewColumns, ['name', 'stage', 'stage']],
  ])('refuses %s columns %j', (_kind, schema, columns) => {
    expect(schema.safeParse(columns).success).toBe(false);
  });
});

const contactView = {
  objectKey: 'contact',
  name: 'Gold weddings',
  state: { sort: 'name' },
  columns: ['name', 'email'],
};
const dealView = {
  objectKey: 'deal',
  name: 'Won this year',
  state: { status: 'won' },
  columns: ['name', 'amount'],
};

describe('saving a view', () => {
  it('saves a contact view or a deal view, each with its own state and columns', () => {
    expect(createViewInput.parse({ ...contactView, name: '  Gold weddings ' })).toEqual(
      contactView,
    );
    expect(createViewInput.parse(dealView)).toEqual(dealView);
  });

  it.each([
    ['a deal state on a contact view', { ...contactView, state: { pipelineId: pipeline } }],
    ['deal columns on a contact view', { ...contactView, columns: ['name', 'amount'] }],
    ['a contact state on a deal view', { ...dealView, state: { added: 'week' } }],
    ['contact columns on a deal view', { ...dealView, columns: ['name', 'phone'] }],
    ['another kind of record', { ...contactView, objectKey: 'company' }],
    ['no kind of record', { name: 'Gold', state: {}, columns: ['name'] }],
  ])('never mixes kinds: refuses %s', (_case, input) => {
    expect(createViewInput.safeParse(input).success).toBe(false);
  });

  it.each([
    { owner: { name: 'Dana Brooks', you: true } },
    { ownerUserId: '01890a5d-ac96-774b-bcce-b302099a8057' },
    { owner_user_id: '01890a5d-ac96-774b-bcce-b302099a8057' },
    { visibility: 'shared' },
    { id: viewId },
    { revision },
    { canChange: true },
  ])('takes no owner, visibility, id or revision from the caller: %j', (extra) => {
    expect(createViewInput.safeParse({ ...contactView, ...extra }).success).toBe(false);
    expect(createViewInput.safeParse({ ...dealView, ...extra }).success).toBe(false);
  });

  it('needs a name of at most 80 characters', () => {
    expect(createViewInput.safeParse({ ...contactView, name: ' ' }).error?.issues[0]?.message).toBe(
      'Give the view a name.',
    );
    expect(
      createViewInput.safeParse({ ...contactView, name: 'x'.repeat(81) }).error?.issues[0]?.message,
    ).toBe('Use at most 80 characters.');
  });
});

describe('changing a view', () => {
  const contactChange = { name: 'Gold', state: { added: 'week' }, columns: ['name'], revision };
  const dealChange = {
    name: 'Won',
    state: { layout: 'board' },
    columns: ['name', 'stage'],
    revision,
  };

  it('replaces the whole view: its name, state and columns, at the revision it read', () => {
    expect(contactViewChanges.parse(contactChange)).toEqual(contactChange);
    expect(dealViewChanges.parse(dealChange)).toEqual(dealChange);
    expect(updateViewInput.parse(contactChange)).toEqual(contactChange);
    expect(updateViewInput.parse(dealChange)).toEqual(dealChange);
  });

  it.each(['name', 'state', 'columns', 'revision'])(
    'needs %s, so nothing is cleared by leaving it out',
    (key) => {
      const { [key as keyof typeof contactChange]: _left, ...partial } = contactChange;
      expect(contactViewChanges.safeParse(partial).success).toBe(false);
      expect(updateViewInput.safeParse(partial).success).toBe(false);
    },
  );

  it('keeps the kind it was saved as, and takes no owner or visibility', () => {
    for (const extra of [{ objectKey: 'deal' }, { visibility: 'private' }, { owner: null }]) {
      expect(updateViewInput.safeParse({ ...contactChange, ...extra }).success).toBe(false);
    }
    expect(
      contactViewChanges.safeParse({ ...contactChange, state: { pipelineId: pipeline } }).success,
    ).toBe(false);
    expect(dealViewChanges.safeParse({ ...dealChange, columns: ['name', 'email'] }).success).toBe(
      false,
    );
    expect(contactViewChanges.safeParse({ ...contactChange, revision: 'stale' }).success).toBe(
      false,
    );
  });

  it('deletes, shares and unshares at the revision it read, and nothing more', () => {
    for (const schema of [deleteViewInput, shareViewInput, unshareViewInput]) {
      expect(schema.parse({ revision })).toEqual({ revision });
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ revision, visibility: 'shared' }).success).toBe(false);
    }
  });
});

describe('a saved view, as the API shows it', () => {
  const shown = {
    id: viewId,
    name: 'Gold weddings',
    visibility: 'shared',
    access: 'view',
    owner: { membershipId: null, name: null, you: false },
    sharing: { everyone: 'view', people: [] },
    canChange: false,
    canShare: false,
    canUnshare: false,
    canDelete: false,
    canChangeSharing: false,
    createdAt: at,
    updatedAt: at,
    revision,
  };

  it('shows its kind, owner, what the reader may do and its revision', () => {
    expect(
      savedView.parse({
        ...shown,
        objectKey: 'contact',
        state: { sort: 'name' },
        columns: ['name'],
      }),
    ).toMatchObject({ objectKey: 'contact', owner: { name: null, you: false } });
    expect(
      savedView.parse({
        ...shown,
        objectKey: 'deal',
        state: { layout: 'board' },
        columns: ['name', 'amount'],
      }),
    ).toMatchObject({ objectKey: 'deal' });
    expect(
      viewList.parse({
        canSave: true,
        items: [{ ...shown, objectKey: 'contact', state: {}, columns: ['name'] }],
      }).items,
    ).toHaveLength(1);
  });

  it('shows who it is shared with by name, each at their level, and the widths of its columns', () => {
    const member = 'mem_01h455vb4pex5vsknk084sn02q';
    expect(
      savedView.parse({
        ...shown,
        visibility: 'selected',
        access: 'edit',
        sharing: {
          everyone: null,
          people: [
            { membershipId: member, name: 'Ali Noor', you: true, access: 'edit' },
            { membershipId: null, name: null, you: false, access: 'view' },
          ],
        },
        objectKey: 'contact',
        state: {},
        columns: ['name'],
        columnLayout: ['name', field],
        columnWidths: { name: 240, [field]: 120 },
      }),
    ).toMatchObject({ visibility: 'selected', columnWidths: { name: 240, [field]: 120 } });
    for (const changes of [
      { visibility: 'team' },
      { access: 'admin' },
      { sharing: { everyone: 'admin', people: [] } },
    ])
      expect(
        savedView.safeParse({
          ...shown,
          ...changes,
          objectKey: 'contact',
          state: {},
          columns: ['name'],
        }).success,
      ).toBe(false);
  });

  it("never shows one kind with the other kind's state or columns", () => {
    expect(
      savedView.safeParse({
        ...shown,
        objectKey: 'contact',
        state: {},
        columns: ['name', 'amount'],
      }).success,
    ).toBe(false);
    expect(
      savedView.safeParse({
        ...shown,
        objectKey: 'deal',
        state: { added: 'week' },
        columns: ['name'],
      }).success,
    ).toBe(false);
    expect(
      savedView.safeParse({
        ...shown,
        id: 'task_01h455vb4pex5vsknk084sn02q',
        objectKey: 'contact',
        state: {},
        columns: ['name'],
      }).success,
    ).toBe(false);
  });
});

describe('the views API', () => {
  it('lists the views of the kind of record its query names', () => {
    expect(listViews.query.parse({ object: 'contact' })).toEqual({ object: 'contact' });
    expect(listViews.query.parse({ object: 'deal' })).toEqual({ object: 'deal' });
    for (const query of [{}, { object: 'company' }, { object: 'deal', after: viewId }]) {
      expect(listViews.query.safeParse(query).success).toBe(false);
    }
  });

  it('chooses who a view is shared with: everyone at a level, or people each at theirs', () => {
    const ali = 'mem_01h455vb4pex5vsknk084sn02q';
    const sam = 'mem_01h455vb4pex5vsknk084sn03q';
    expect(viewSharingInput.parse({ everyone: 'edit', people: [], revision })).toEqual({
      everyone: 'edit',
      people: [],
      revision,
    });
    expect(
      viewSharingInput.parse({
        everyone: null,
        people: [
          { membershipId: ali, access: 'view' },
          { membershipId: sam, access: 'edit' },
        ],
        revision,
      }).people,
    ).toHaveLength(2);
    expect(viewSharingInput.parse({ everyone: null, people: [], revision }).everyone).toBeNull();
    for (const input of [
      { everyone: 'view', people: [{ membershipId: ali, access: 'view' }], revision },
      {
        everyone: null,
        people: [
          { membershipId: ali, access: 'view' },
          { membershipId: ali, access: 'edit' },
        ],
        revision,
      },
      { everyone: null, people: [{ membershipId: ali, access: 'owner' }], revision },
      { everyone: null, people: [{ membershipId: viewId, access: 'view' }], revision },
      {
        everyone: null,
        people: Array.from({ length: MAX_VIEW_SHARES + 1 }, () => ({
          membershipId: ali,
          access: 'view',
        })),
        revision,
      },
      { everyone: 'view', people: [] },
    ])
      expect(viewSharingInput.safeParse(input).success).toBe(false);
  });

  it('keeps column widths within bounds, by built-in key or field id', () => {
    expect(
      contactColumnWidths.parse({ email: MIN_COLUMN_WIDTH, [field]: MAX_COLUMN_WIDTH }),
    ).toEqual({ email: MIN_COLUMN_WIDTH, [field]: MAX_COLUMN_WIDTH });
    for (const widths of [
      { email: MIN_COLUMN_WIDTH - 1 },
      { email: MAX_COLUMN_WIDTH + 1 },
      { email: 100.5 },
      { shoeSize: 100 },
    ])
      expect(contactColumnWidths.safeParse(widths).success).toBe(false);
  });

  it('takes a saved view id in the path', () => {
    for (const endpoint of [updateView, deleteView, shareView, unshareView, setViewSharing]) {
      expect(endpoint.params.parse({ id: viewId })).toEqual({ id: viewId });
      expect(
        endpoint.params.safeParse({ id: 'task_01h455vb4pex5vsknk084sn02q' }).error?.issues[0]
          ?.message,
      ).toBe('Not a saved view id.');
    }
  });

  it('has seven operations, listed under Views in the reference', () => {
    const document = openApiDocument();
    for (const [endpoint, method, path, status] of [
      [listViews, 'get', '/views', 200],
      [createView, 'post', '/views', 201],
      [updateView, 'put', '/views/{id}', 200],
      [deleteView, 'delete', '/views/{id}', 204],
      [shareView, 'post', '/views/{id}/share', 200],
      [unshareView, 'post', '/views/{id}/unshare', 200],
      [setViewSharing, 'put', '/views/{id}/sharing', 200],
    ] as const) {
      expect(endpoints).toContain(endpoint);
      expect(endpoint).toMatchObject({ method, path, group: 'Views', response: { status } });
      expect(document.paths?.[path]?.[method]).toMatchObject({
        operationId: endpoint.operationId,
        tags: ['Views'],
      });
    }
  });
});
