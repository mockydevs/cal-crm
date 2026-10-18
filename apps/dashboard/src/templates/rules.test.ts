import { describe, expect, it } from 'vitest';
import { bulkActionsOf, listQueryOf, placeOf, rowActionsOf, withPlace } from './rules';

const folder = 'tfld_01h455vb4pex5vsknk084sn02q';
const live = { archivedAt: null, deletedAt: null };
const archived = { archivedAt: '2026-10-01T00:00:00.000Z', deletedAt: null };
const trashed = { archivedAt: '2026-10-01T00:00:00.000Z', deletedAt: '2026-10-02T00:00:00.000Z' };

describe('listQueryOf', () => {
  it('asks for the live library by name, a page at a time', () => {
    expect(listQueryOf({}, { limit: 50, after: undefined })).toEqual({
      archived: 'exclude',
      deleted: 'exclude',
      sort: 'name',
      limit: 50,
    });
  });

  it('carries every choice of the address, and the page it is on', () => {
    expect(
      listQueryOf(
        { folder, q: 'promo', type: 'html', used: 'yes', sort: 'uses' },
        { limit: 20, after: 'tmpl_01h455vb4pex5vsknk084sn02q' },
      ),
    ).toEqual({
      archived: 'exclude',
      deleted: 'exclude',
      folder,
      q: 'promo',
      format: 'html',
      used: 'yes',
      sort: 'uses',
      limit: 20,
      after: 'tmpl_01h455vb4pex5vsknk084sn02q',
    });
  });

  it('asks for Archived or the Trash, never mixing them', () => {
    expect(listQueryOf({ show: 'archived' }, { limit: 50, after: undefined })).toMatchObject({
      archived: 'only',
      deleted: 'exclude',
    });
    expect(
      listQueryOf({ show: 'trash', sort: 'updated' }, { limit: 50, after: undefined }),
    ).toMatchObject({ archived: 'include', deleted: 'only', sort: 'updated' });
  });
});

describe('places', () => {
  it('names the place the address shows, for the panel', () => {
    expect(placeOf({})).toBe('all');
    expect(placeOf({ folder })).toBe(folder);
    expect(placeOf({ show: 'trash' })).toBe('trash');
  });

  it('moves to another place, keeping the filters and dropping the old place', () => {
    expect(withPlace({ show: 'trash', q: 'x', sort: 'uses' }, folder)).toEqual({
      folder,
      q: 'x',
      sort: 'uses',
    });
    expect(withPlace({ folder, type: 'text' }, 'archived')).toEqual({
      show: 'archived',
      type: 'text',
    });
    expect(withPlace({ folder }, 'all')).toEqual({});
  });
});

describe('actions', () => {
  it('offers a live template everything, an archived one its way back, a trashed one Restore', () => {
    expect(rowActionsOf(live, true)).toEqual([
      'edit',
      'duplicate',
      'rename',
      'move',
      'archive',
      'delete',
    ]);
    expect(rowActionsOf(archived, true)).toEqual([
      'open',
      'duplicate',
      'move',
      'restore',
      'delete',
    ]);
    expect(rowActionsOf(trashed, true)).toEqual(['restore']);
  });

  it('lets someone who cannot change templates only open them', () => {
    expect(rowActionsOf(live, false)).toEqual(['open']);
    expect(rowActionsOf(trashed, false)).toEqual([]);
  });

  it('offers the bulk actions of each place', () => {
    expect(bulkActionsOf(undefined)).toEqual(['move', 'archive', 'delete']);
    expect(bulkActionsOf('archived')).toEqual(['move', 'restore', 'delete']);
    expect(bulkActionsOf('trash')).toEqual(['restore']);
  });
});
