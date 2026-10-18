import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { checkType, showsInline } from './types.js';

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part),
    ),
  );

// The first bytes of each format, as its specification gives them.
const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13]);
const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF');
const gif87 = bytes('GIF87a', [1, 0]);
const gif89 = bytes('GIF89a', [1, 0]);
const webp = bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ');
const pdf = bytes('%PDF-1.7\n');
const html = bytes('<!doctype html><script>');
const mp4 = bytes([0, 0, 0, 0x20], 'ftypisom');
const m4a = bytes([0, 0, 0, 0x1c], 'ftypM4A ');
const webm = bytes([0x1a, 0x45, 0xdf, 0xa3], [0x9f, 0x42, 0x86, 0x81]);
const mp3Tagged = bytes('ID3', [4, 0, 0, 0, 0, 0, 0]);
const mp3Frame = bytes([0xff, 0xfb, 0x90, 0x64]);
const wav = bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt ');
const ogg = bytes('OggS', [0, 2, 0, 0]);

function refusal(declared: string | undefined, head: Buffer): unknown {
  try {
    checkType(declared, head);
  } catch (error) {
    return error instanceof ValidationError ? error.issues : error;
  }
  return 'accepted';
}

describe('the type check', () => {
  it.each([
    ['image/png', png, true],
    ['image/jpeg', jpeg, true],
    ['image/gif', gif87, true],
    ['image/gif', gif89, true],
    ['image/webp', webp, true],
    ['application/pdf', pdf, false],
    ['text/plain', bytes('hello'), false],
    ['text/csv', bytes('name,email\n'), false],
    ['video/mp4', mp4, false],
    ['video/webm', webm, false],
    ['audio/mpeg', mp3Tagged, false],
    ['audio/mpeg', mp3Frame, false],
    ['audio/wav', wav, false],
    ['audio/ogg', ogg, false],
    ['audio/mp4', m4a, false],
  ])(
    'accepts %s whose bytes are one, and says whether it may show inline',
    (type, head, inline) => {
      expect(checkType(type, head)).toEqual({ contentType: type, inline });
    },
  );

  it('reads the type without its parameters, in any case', () => {
    expect(checkType('Text/CSV; charset=UTF-8', bytes('a,b\n'))).toEqual({
      contentType: 'text/csv',
      inline: false,
    });
  });

  it.each([
    ['SVG, which can carry scripts', 'image/svg+xml'],
    ['HTML', 'text/html'],
    ['an unnamed binary', 'application/octet-stream'],
    ['no type at all', undefined],
    ["a name from JavaScript's object prototype", 'constructor'],
    ['another one', '__proto__'],
  ])('refuses %s', (_case, declared) => {
    expect(refusal(declared, html)).toEqual([
      {
        path: '',
        code: 'unsupported_type',
        message:
          'Upload a PNG, JPEG, GIF or WebP image, an MP4 or WebM video, an MP3, WAV, Ogg or M4A sound, a PDF, or a plain text or CSV file.',
      },
    ]);
  });

  it.each([
    ['image/png', jpeg],
    ['image/jpeg', png],
    ['image/gif', bytes('GIF88a')],
    ['image/webp', bytes('RIFF', [0, 0, 0, 0], 'WAVE')],
    ['application/pdf', html],
    ['image/png', bytes([0x89, 0x50])],
    ['video/mp4', webm],
    ['video/webm', mp4],
    ['audio/mpeg', ogg],
    ['audio/wav', webp],
    ['audio/ogg', wav],
    ['audio/mp4', mp3Frame],
    // A page renamed to a video is still a page.
    ['video/mp4', html],
  ])('refuses %s whose bytes are something else', (declared, head) => {
    expect(refusal(declared, head)).toEqual([
      {
        path: '',
        code: 'type_mismatch',
        message: `The file isn't the ${declared} it says it is.`,
      },
    ]);
  });
});

describe('showing a file inline', () => {
  it.each([
    ['image/png', true],
    ['image/webp', true],
    ['application/pdf', false],
    ['text/plain', false],
    ['text/html', false],
    ['video/mp4', false],
    ['audio/mpeg', false],
  ])('%s: %s', (type, inline) => {
    expect(showsInline(type)).toBe(inline);
  });
});
