import { savedView, type SavedView } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { clampWidth, widthAfterKey } from './column-resizer';
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from './list-columns';
import { sameConfiguration, type ViewConfiguration } from './saved-view-rules';
import {
  choosable,
  departedCount,
  sharingAllowed,
  sharingChanged,
  sharingDraftOf,
  sharingInputOf,
  type SharingDraft,
} from './saved-view-sharing-rules';

const ali = 'mem_01m4bd188ff82s0add91b7pz72';
const sam = 'mem_01m4bd188ff82s0add91b7pz73';
const me = 'mem_01m4bd188ff82s0add91b7pz71';
const revision = 'a'.repeat(64);

function view(changes: Partial<SavedView> = {}): SavedView {
  return savedView.parse({
    id: 'view_01m4bd188ff82s0add91b7pz63',
    objectKey: 'contact',
    name: 'Garden venues',
    state: {},
    columns: ['name'],
    owner: { membershipId: 'mem_01m4bd188ff82s0add91b7pz71', name: 'Dana Brooks', you: true },
    visibility: 'private',
    access: 'owner',
    sharing: { everyone: null, people: [] },
    canChange: true,
    canShare: true,
    canUnshare: false,
    canDelete: true,
    canChangeSharing: true,
    revision,
    createdAt: '2026-10-08T12:00:00.000Z',
    updatedAt: '2026-10-08T12:00:00.000Z',
    ...changes,
  });
}
const person = (membershipId: string | null, access: 'view' | 'edit', you = false) => ({
  membershipId,
  name: null,
  you,
  access,
});
const draft = (changes: Partial<SharingDraft>): SharingDraft => ({
  mode: 'private',
  everyone: 'view',
  people: new Map(),
  ...changes,
});

describe('sharing a saved view', () => {
  it('starts from how the view is shared: nobody else, everyone at a level, or people', () => {
    expect(sharingDraftOf(view())).toEqual(draft({}));
    expect(
      sharingDraftOf(view({ visibility: 'shared', sharing: { everyone: 'edit', people: [] } })),
    ).toEqual(draft({ mode: 'everyone', everyone: 'edit' }));
    const chosen = view({
      visibility: 'selected',
      sharing: { everyone: null, people: [person(ali, 'view'), person(null, 'edit')] },
    });
    expect(sharingDraftOf(chosen)).toEqual(
      draft({ mode: 'selected', people: new Map([[ali, 'view']]) }),
    );
    expect(departedCount(chosen)).toBe(1);
  });

  it('asks for everyone or the people chosen, never both, and nothing for private', () => {
    const people = new Map([
      [ali, 'view'],
      [sam, 'edit'],
    ] as const);
    expect(sharingInputOf(draft({ mode: 'everyone', everyone: 'edit', people }), revision)).toEqual(
      { everyone: 'edit', people: [], revision },
    );
    expect(sharingInputOf(draft({ mode: 'selected', people }), revision)).toEqual({
      everyone: null,
      people: [
        { membershipId: ali, access: 'view' },
        { membershipId: sam, access: 'edit' },
      ],
      revision,
    });
    expect(sharingInputOf(draft({ people }), revision)).toEqual({
      everyone: null,
      people: [],
      revision,
    });
  });

  it('has a change only when the sharing would differ, whatever order people were chosen in', () => {
    const shared = view({
      visibility: 'selected',
      sharing: { everyone: null, people: [person(ali, 'view'), person(sam, 'edit')] },
    });
    const same = new Map([
      [sam, 'edit'],
      [ali, 'view'],
    ] as const);
    expect(sharingChanged(draft({ mode: 'selected', people: same }), shared)).toBe(false);
    expect(
      sharingChanged(draft({ mode: 'selected', people: new Map([[ali, 'edit']]) }), shared),
    ).toBe(true);
    // A level for everyone is kept aside while it isn't chosen.
    expect(sharingChanged(draft({ everyone: 'edit' }), view())).toBe(false);
    expect(sharingChanged(draft({ mode: 'everyone' }), view())).toBe(true);
  });

  it('lets an editor share on, but never make it private or drop their own editing', () => {
    const editor = view({
      access: 'edit',
      visibility: 'selected',
      sharing: { everyone: null, people: [person(me, 'edit', true)] },
    });
    // Everyone at view would take the editor's own editing away; everyone at edit keeps it.
    expect(sharingAllowed(draft({ mode: 'everyone' }), editor, me)).toBe(false);
    expect(sharingAllowed(draft({ mode: 'everyone', everyone: 'edit' }), editor, me)).toBe(true);
    expect(sharingAllowed(draft({}), editor, me)).toBe(false);
    expect(
      sharingAllowed(draft({ mode: 'selected', people: new Map([[ali, 'edit']]) }), editor, me),
    ).toBe(false);
    expect(
      sharingAllowed(
        draft({
          mode: 'selected',
          people: new Map([
            [me, 'edit'],
            [ali, 'view'],
          ]),
        }),
        editor,
        me,
      ),
    ).toBe(true);
    // Choosing people means choosing someone.
    expect(sharingAllowed(draft({ mode: 'selected' }), view(), me)).toBe(false);
    expect(sharingAllowed(draft({}), view(), me)).toBe(true);
  });

  it('never offers the owner, who always has the list, to the owner or to an editor', () => {
    const owner = 'mem_01m4bd188ff82s0add91b7pz74';
    const editors = view({
      access: 'edit',
      owner: { membershipId: owner, name: 'Dana Brooks', you: false },
    });
    expect(choosable(editors, { id: owner, you: false })).toBe(false);
    expect(choosable(editors, { id: me, you: true })).toBe(true);
    expect(choosable(editors, { id: ali, you: false })).toBe(true);
    // The owner reading is left out by being "you", even without a membership shown.
    const owned = view({ owner: { membershipId: null, name: 'Dana Brooks', you: true } });
    expect(choosable(owned, { id: me, you: true })).toBe(false);
    expect(choosable(owned, { id: ali, you: false })).toBe(true);
  });
});

describe('resizing a column from the keyboard', () => {
  it('moves the edge by a step, a longer one with Shift, or to either end, within bounds', () => {
    expect(widthAfterKey('ArrowRight', false, 200)).toBe(216);
    expect(widthAfterKey('ArrowLeft', true, 200)).toBe(136);
    expect(widthAfterKey('Home', false, 200)).toBe(MIN_COLUMN_WIDTH);
    expect(widthAfterKey('End', false, 200)).toBe(MAX_COLUMN_WIDTH);
    expect(widthAfterKey('ArrowLeft', false, MIN_COLUMN_WIDTH)).toBe(MIN_COLUMN_WIDTH);
    expect(widthAfterKey('ArrowRight', true, MAX_COLUMN_WIDTH - 10)).toBe(MAX_COLUMN_WIDTH);
    expect(widthAfterKey('Enter', false, 200)).toBeUndefined();
    expect(clampWidth(123.6)).toBe(124);
  });
});

describe('whether a list is the saved view it came from', () => {
  const configuration: ViewConfiguration = {
    objectKey: 'contact',
    state: {},
    columns: ['name'],
    tableColumns: ['name', 'email'],
  };
  it('compares the whole layout, custom fields included, and the widths', () => {
    const field = 'fld_01h455vb4pex5vsknk084sn02q';
    const laidOut: ViewConfiguration = {
      ...configuration,
      objectKey: 'contact',
      columnLayout: ['name', 'email', field],
    };
    expect(sameConfiguration(laidOut, { ...laidOut })).toBe(true);
    expect(sameConfiguration(laidOut, configuration)).toBe(false);
    // A layout of built-in columns alone is the same list as those columns.
    expect(
      sameConfiguration({ ...configuration, columnLayout: ['name', 'email'] }, configuration),
    ).toBe(true);
    expect(
      sameConfiguration(
        { ...laidOut, columnWidths: { email: 200, name: 300 } },
        { ...laidOut, columnWidths: { name: 300, email: 200 } },
      ),
    ).toBe(true);
    expect(sameConfiguration({ ...laidOut, columnWidths: { email: 200 } }, laidOut)).toBe(false);
    expect(sameConfiguration({ ...laidOut, columnWidths: null }, laidOut)).toBe(true);
  });
});
