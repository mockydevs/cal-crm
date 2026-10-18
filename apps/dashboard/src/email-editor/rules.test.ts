// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { emailContent } from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  contentOf,
  documentOf,
  documentProblems,
  emptyDocument,
  fieldsUsed,
  paletteWith,
  sameDocument,
  sizeOf,
  textPartOf,
  unknownFields,
  type EmailDocument,
} from './rules';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const formatted: EmailDocument = {
  subject: 'Hello {{contact.firstName}}',
  preheader: 'Open me',
  html: '<p>Hi {{contact.firstName}}</p><p>From {{custom_values.business_name}}</p>',
  text: '',
  ownText: false,
};
const plain: EmailDocument = {
  subject: 'Hello',
  preheader: '',
  html: undefined,
  text: 'Hi {{contact.firstName}}',
  ownText: false,
};

describe('an email as the editor holds it', () => {
  it('opens a stored email, and knows a plain-text part its author wrote', () => {
    expect(documentOf({ subject: 'S', preheader: null, html: '<p>Hi</p>', text: 'Hi' })).toEqual({
      subject: 'S',
      preheader: '',
      html: '<p>Hi</p>',
      text: 'Hi',
      ownText: false,
    });
    expect(
      documentOf({ subject: 'S', html: '<p>Hi</p>', text: 'Hello, in my words' }).ownText,
    ).toBe(true);
    expect(documentOf({ subject: 'S', html: '<p>Hi</p>', text: '  ' }).ownText).toBe(false);
    expect(documentOf({ subject: 'S', html: null, text: 'Plain' })).toMatchObject({
      html: undefined,
      ownText: false,
    });
  });

  it('writes the plain-text part from the formatted one unless the author wrote their own', () => {
    expect(textPartOf(formatted)).toBe(
      'Hi {{contact.firstName}}\n\nFrom {{custom_values.business_name}}',
    );
    expect(textPartOf({ ...formatted, ownText: true, text: 'Mine' })).toBe('Mine');
    expect(textPartOf({ ...formatted, ownText: true, text: ' ' })).toContain('Hi');
    expect(textPartOf(plain)).toBe('Hi {{contact.firstName}}');
  });

  it('gives the contract its pairing: the text part only when the author wrote it', () => {
    expect(contentOf(plain)).toEqual({ format: 'text', text: 'Hi {{contact.firstName}}' });
    expect(contentOf(formatted)).toEqual({ format: 'html', html: formatted.html });
    expect(contentOf({ ...formatted, ownText: true, text: 'Mine' })).toEqual({
      format: 'html',
      html: formatted.html,
      text: 'Mine',
    });
    for (const document of [plain, formatted, { ...formatted, ownText: true, text: 'Mine' }])
      expect(emailContent.safeParse(contentOf(document)).success).toBe(true);
  });

  it('is changed only by what a save would write', () => {
    expect(sameDocument(formatted, { ...formatted })).toBe(true);
    expect(sameDocument(formatted, { ...formatted, text: 'ignored while not own' })).toBe(true);
    expect(sameDocument(formatted, { ...formatted, subject: 'Other' })).toBe(false);
    expect(sameDocument(formatted, { ...formatted, preheader: '' })).toBe(false);
    expect(sameDocument(formatted, { ...formatted, html: '<p>x</p>' })).toBe(false);
    expect(sameDocument(plain, { ...plain, text: 'Other' })).toBe(false);
    expect(sameDocument(plain, { ...plain, html: '' })).toBe(false);
  });
});

describe('what stops a save', () => {
  it('asks for a subject and a message', () => {
    expect(documentProblems(emptyDocument)).toEqual(['subject_missing', 'body_missing']);
    expect(documentProblems({ ...plain, text: ' ' })).toEqual(['body_missing']);
    expect(documentProblems({ ...formatted, html: '<p><br></p>' })).toEqual(['body_missing']);
    expect(documentProblems(formatted)).toEqual([]);
  });
  it('lets a step that sends a template leave the subject out', () => {
    expect(documentProblems({ ...formatted, subject: '' }, false)).toEqual([]);
  });
  it('holds to what the server takes', () => {
    expect(documentProblems({ ...plain, subject: 'x'.repeat(256) })).toEqual(['subject_long']);
    expect(documentProblems({ ...plain, subject: 'x'.repeat(256) }, true, 998)).toEqual([]);
    expect(documentProblems({ ...plain, text: 'x'.repeat(100_001) })).toEqual(['text_long']);
    expect(documentProblems({ ...formatted, preheader: 'x'.repeat(151) })).toEqual([
      'preheader_long',
    ]);
    expect(documentProblems({ ...formatted, html: `<p>${'x'.repeat(200_000)}</p>` })).toEqual([
      'html_long',
      'text_long',
    ]);
  });
});

describe('the size meter', () => {
  it('measures the formatted part against its limit, else the text', () => {
    expect(sizeOf(formatted)).toEqual({
      used: formatted.html?.length,
      limit: 200_000,
      near: false,
      over: false,
    });
    expect(sizeOf(plain)).toMatchObject({ used: 24, limit: 100_000 });
  });
  it('says when it is close, and when it is over', () => {
    expect(sizeOf({ ...plain, text: 'x'.repeat(90_000) })).toMatchObject({
      near: true,
      over: false,
    });
    expect(sizeOf({ ...plain, text: 'x'.repeat(100_001) })).toMatchObject({
      near: true,
      over: true,
    });
  });
});

describe('the merge fields an email uses', () => {
  it('lists each once, subject first', () => {
    expect(fieldsUsed(formatted)).toEqual(['contact.firstName', 'custom_values.business_name']);
  });
  it('names those nothing can fill in', () => {
    const known = (path: string): boolean => path.startsWith('contact.');
    expect(unknownFields(formatted, known)).toEqual(['custom_values.business_name']);
    expect(unknownFields(plain, known)).toEqual([]);
  });
});

describe('the colours a tool offers', () => {
  it('is the palette, by name', () => {
    const palette = paletteWith([]);
    expect(palette).toHaveLength(8);
    expect(palette[0]).toEqual({ value: '#111827', name: 'Black', brand: false });
  });
  it('puts the business’s own first, each once, and drops what is no colour', () => {
    const palette = paletteWith(['#0EA5E9', ' #0ea5e9', 'blue', '#1d4ed8']);
    expect(palette.slice(0, 2)).toEqual([
      { value: '#0ea5e9', name: '#0ea5e9', brand: true },
      { value: '#1d4ed8', name: '#1d4ed8', brand: true },
    ]);
    expect(palette.filter((colour) => colour.value === '#1d4ed8')).toHaveLength(1);
  });
});
