import { describe, expect, it } from 'vitest';

import { listTrashQuery, trashedRecord, trashList } from './trash.js';

const id = 'con_01h455vb4pex5vsknk084sn02q';

describe('the trash', () => {
  it('lists every kind by default, or one kind, after a record of any kind', () => {
    expect(listTrashQuery.parse({})).toEqual({});
    expect(listTrashQuery.parse({ kind: 'deal', after: id })).toEqual({ kind: 'deal', after: id });
    expect(listTrashQuery.safeParse({ kind: 'note' }).success).toBe(false);
    expect(listTrashQuery.safeParse({ after: 'tag_01h455vb4pex5vsknk084sn02q' }).success).toBe(
      false,
    );
  });

  it('shows each record with its kind, when it was trashed and when it will be purged', () => {
    const item = {
      id,
      kind: 'contact',
      name: 'Maya Thompson',
      trashedAt: '2026-10-08T12:00:00.000Z',
      purgeAt: '2026-11-07T12:00:00.000Z',
    };
    expect(trashedRecord.parse(item)).toEqual(item);
    expect(
      trashList.parse({ items: [item], next: null, retentionDays: 30, canPurge: true }),
    ).toMatchObject({ retentionDays: 30, canPurge: true });
  });
});
