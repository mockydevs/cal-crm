import { mediaKindOf, mediaSorts } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  containsPattern,
  decodeCursor,
  encodeCursor,
  kindPatterns,
  PREVIEW_SECONDS,
  previewable,
  previewSignedFrom,
  publicInline,
  rangeOf,
  sortSpecs,
} from './media-rules.js';

const id = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('type groups', () => {
  it.each([
    ['image/png', 'image'],
    ['image/webp', 'image'],
    ['video/mp4', 'video'],
    ['audio/mpeg', 'audio'],
    ['application/pdf', 'document'],
    ['text/csv', 'document'],
    ['text/plain', 'document'],
  ] as const)('%s is a %s', (type, kind) => {
    expect(mediaKindOf(type)).toBe(kind);
  });

  it('filters each group by the same prefix the group is named by', () => {
    expect(kindPatterns).toEqual({ image: 'image/%', video: 'video/%', audio: 'audio/%' });
  });

  it.each([
    ['image/png', true, true],
    ['video/webm', true, true],
    ['audio/ogg', true, true],
    // A PDF is looked at in the dashboard, and downloaded from a public address.
    ['application/pdf', true, false],
    ['text/csv', false, false],
    ['text/plain', false, false],
  ])('%s: previewed %s, shown in place at a public address %s', (type, preview, inline) => {
    expect(previewable(type)).toBe(preview);
    expect(publicInline(type)).toBe(inline);
  });
});

describe('sorting', () => {
  it('has an order for every sort the API names', () => {
    expect(Object.keys(sortSpecs).sort()).toEqual([...mediaSorts].sort());
  });

  it('orders newest first by the time changed, and names without regard to case', () => {
    expect(sortSpecs.modified_desc).toEqual({
      expression: 'f.updated_at',
      cast: 'timestamptz',
      direction: 'desc',
    });
    expect(sortSpecs.name_asc).toEqual({
      expression: 'lower(f.filename)',
      cast: 'text',
      direction: 'asc',
    });
    expect(sortSpecs.size_desc).toEqual({
      expression: 'f.size_bytes',
      cast: 'bigint',
      direction: 'desc',
    });
  });
});

describe('a cursor', () => {
  it('comes back as it was written', () => {
    for (const sort of mediaSorts) {
      const cursor = { sort, value: '2026-10-12 20:00:00.123456+00', id };
      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    }
  });

  it('keeps a name with any character in it', () => {
    const cursor = { sort: 'name_asc' as const, value: 'été "final", 100%_.png', id };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it.each([
    ['text that is not base64 of anything', '%%%'],
    ['something that is not JSON', Buffer.from('not json').toString('base64url')],
    ['an object', encoded({ sort: 'name_asc' })],
    ['too few parts', encoded(['name_asc', 'a'])],
    ['too many parts', encoded(['name_asc', 'a', id, 1])],
    ['a sort nobody offers', encoded(['random', 'a', id])],
    ['a value that is not text', encoded(['size_asc', 12, id])],
    ['an id that is not text', encoded(['size_asc', '12', 12])],
    ['an id that is not an id', encoded(['size_asc', '12', "x'; drop table files.files"])],
  ])('refuses %s', (_case, text) => {
    expect(decodeCursor(text)).toBeUndefined();
  });
});

describe('a search', () => {
  it('matches the text anywhere in a name', () => {
    expect(containsPattern('logo')).toBe('%logo%');
  });

  it("takes the pattern's own characters as they are written", () => {
    expect(containsPattern('100%_done\\')).toBe('%100\\%\\_done\\\\%');
  });
});

describe('a byte range', () => {
  it('is the whole file when nothing asks for a part', () => {
    expect(rangeOf(undefined, 1000)).toBeUndefined();
  });

  it.each([
    ['bytes=0-0', { start: 0, end: 0 }],
    ['bytes=0-499', { start: 0, end: 499 }],
    ['bytes=500-', { start: 500, end: 999 }],
    // Past the end is clamped to it (RFC 9110, section 14.1.2).
    ['bytes=900-5000', { start: 900, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
    [' bytes=1-2 ', { start: 1, end: 2 }],
  ])('%s of a thousand bytes', (header, range) => {
    expect(rangeOf(header, 1000)).toEqual(range);
  });

  it.each(['bytes=1000-', 'bytes=1000-2000', 'bytes=-0'])(
    '%s lies past a thousand bytes',
    (header) => {
      expect(rangeOf(header, 1000)).toBe('unsatisfiable');
    },
  );

  it('has no last bytes of an empty file', () => {
    expect(rangeOf('bytes=-10', 0)).toBe('unsatisfiable');
    expect(rangeOf('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it.each([
    ['another unit', 'items=0-5'],
    ['several ranges', 'bytes=0-1,5-9'],
    ['no numbers', 'bytes=-'],
    ['an end before its start', 'bytes=9-5'],
    ['letters', 'bytes=a-b'],
    ['a negative start', 'bytes=-5-9'],
    ['nothing', ''],
  ])('answers with the whole file for %s', (_case, header) => {
    expect(rangeOf(header, 1000)).toBeUndefined();
  });
});

describe('a preview address', () => {
  it('is signed from the start of the hour, so it is the same all hour', () => {
    const first = previewSignedFrom(new Date('2026-10-12T20:00:00.000Z'));
    const last = previewSignedFrom(new Date('2026-10-12T20:59:59.999Z'));
    expect(first.toISOString()).toBe('2026-10-12T20:00:00.000Z');
    expect(last).toEqual(first);
    expect(previewSignedFrom(new Date('2026-10-12T21:00:00.000Z')).toISOString()).toBe(
      '2026-10-12T21:00:00.000Z',
    );
  });

  it('lasts at least an hour from any moment it is given', () => {
    expect(PREVIEW_SECONDS).toBe(7200);
  });
});
