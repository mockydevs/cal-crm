import { describe, expect, it } from 'vitest';

import { foundRecord, searchRecordsQuery, searchResults } from './search.js';

describe('searching records', () => {
  it('takes the words to search for, trimmed, up to 200 characters', () => {
    expect(searchRecordsQuery.parse({ q: '  lee ' })).toEqual({ q: 'lee' });
    expect(searchRecordsQuery.safeParse({ q: '   ' }).success).toBe(false);
    expect(searchRecordsQuery.safeParse({}).success).toBe(false);
    expect(searchRecordsQuery.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
    expect(searchRecordsQuery.safeParse({ q: 'lee', kind: 'deal' }).success).toBe(false);
  });

  it('gives each record its kind, its name and what tells it apart', () => {
    const item = {
      id: 'deal_01h455vb4pex5vsknk084sn02q',
      kind: 'deal',
      name: 'Lee wedding',
      detail: 'Weddings · New lead',
    };
    expect(foundRecord.parse(item)).toEqual(item);
    expect(searchResults.parse({ items: [item] }).items).toHaveLength(1);
    expect(foundRecord.safeParse({ ...item, id: 'tag_01h455vb4pex5vsknk084sn02q' }).success).toBe(
      false,
    );
  });
});
