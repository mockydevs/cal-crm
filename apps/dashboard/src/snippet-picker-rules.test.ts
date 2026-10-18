import type { SnippetSummary } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  groupByFolder,
  highlightAfter,
  insertSnippet,
  mergePieces,
  pickerAfterTyping,
  slashQueryAt,
  snippetTypeFor,
  unfilledFields,
} from './snippet-picker-rules';

describe('mergePieces', () => {
  it('sets the merge fields of a text apart from its words, in order', () => {
    expect(mergePieces('Hi {{contact.first_name}}, see {{trigger_link.offer}}')).toEqual([
      { at: 0, text: 'Hi ', field: false },
      { at: 3, text: '{{contact.first_name}}', field: true },
      { at: 25, text: ', see ', field: false },
      { at: 31, text: '{{trigger_link.offer}}', field: true },
    ]);
  });

  it('leaves a text with no field, and braces that are not one, as words', () => {
    expect(mergePieces('Park at the back.')).toEqual([
      { at: 0, text: 'Park at the back.', field: false },
    ]);
    expect(mergePieces('{{ not a field }}')).toEqual([
      { at: 0, text: '{{ not a field }}', field: false },
    ]);
    expect(mergePieces('')).toEqual([]);
  });

  it('starts with a field when the text does', () => {
    expect(mergePieces('{{contact.name}}!')).toEqual([
      { at: 0, text: '{{contact.name}}', field: true },
      { at: 16, text: '!', field: false },
    ]);
  });
});

describe('unfilledFields', () => {
  it('names each merge field a text still holds once, as written', () => {
    expect(
      unfilledFields(
        'Hi {{contact.first_name}} and {{ contact.first_name }}, {{contact.first_name}}',
      ),
    ).toEqual(['{{contact.first_name}}', '{{ contact.first_name }}']);
    expect(unfilledFields('Hi Maya')).toEqual([]);
  });
});

describe('snippetTypeFor', () => {
  it('gives an email its own snippets, and a text or a chat the text ones', () => {
    expect(snippetTypeFor('email')).toBe('email');
    expect(snippetTypeFor('sms')).toBe('text');
    expect(snippetTypeFor('webchat')).toBe('text');
  });
});

describe('slashQueryAt', () => {
  it('finds a search at a "/" that starts the message or a word', () => {
    expect(slashQueryAt('/', 1)).toEqual({ from: 0, to: 1, query: '' });
    expect(slashQueryAt('/dir', 4)).toEqual({ from: 0, to: 4, query: 'dir' });
    expect(slashQueryAt('Hello /pri', 10)).toEqual({ from: 6, to: 10, query: 'pri' });
    expect(slashQueryAt('Hello\n/pri', 10)).toEqual({ from: 6, to: 10, query: 'pri' });
  });

  it('reads only up to the caret', () => {
    expect(slashQueryAt('/directions', 4)).toEqual({ from: 0, to: 4, query: 'dir' });
  });

  it('finds none in the middle of a word, in a path, or after a space', () => {
    expect(slashQueryAt('and/or', 6)).toBeUndefined();
    expect(slashQueryAt('10/12', 5)).toBeUndefined();
    expect(slashQueryAt('/usr/bin', 8)).toBeUndefined();
    expect(slashQueryAt('/dir ', 5)).toBeUndefined();
    expect(slashQueryAt('Hello', 5)).toBeUndefined();
    expect(slashQueryAt('', 0)).toBeUndefined();
  });

  it('finds none once what follows the "/" is too long to be a search', () => {
    expect(slashQueryAt(`/${'a'.repeat(41)}`, 42)).toBeUndefined();
    expect(slashQueryAt(`/${'a'.repeat(40)}`, 41)?.query).toHaveLength(40);
  });

  it('keeps a caret outside the text inside it', () => {
    expect(slashQueryAt('/a', 99)).toEqual({ from: 0, to: 2, query: 'a' });
    expect(slashQueryAt('/a', -3)).toBeUndefined();
  });
});

describe('pickerAfterTyping', () => {
  const found = { from: 6, to: 8, query: 'p' };

  it('opens on a "/" and follows what is typed after it', () => {
    expect(pickerAfterTyping(undefined, found, undefined)).toEqual({ ...found, by: 'slash' });
    expect(
      pickerAfterTyping({ ...found, by: 'slash' }, { from: 6, to: 9, query: 'pr' }, undefined),
    ).toEqual({ from: 6, to: 9, query: 'pr', by: 'slash' });
  });

  it('closes a picker a "/" opened when the "/" is gone', () => {
    expect(pickerAfterTyping({ ...found, by: 'slash' }, undefined, undefined)).toBeUndefined();
  });

  it('stays closed on a "/" the person closed it on, and opens on another', () => {
    expect(pickerAfterTyping(undefined, found, 6)).toBeUndefined();
    expect(pickerAfterTyping(undefined, { from: 12, to: 13, query: '' }, 6)).toEqual({
      from: 12,
      to: 13,
      query: '',
      by: 'slash',
    });
  });

  it('leaves the picker the button opened alone', () => {
    const opened = { from: 2, to: 2, query: '', by: 'button' } as const;
    expect(pickerAfterTyping(opened, undefined, undefined)).toBe(opened);
    expect(pickerAfterTyping(opened, found, undefined)).toBe(opened);
  });
});

describe('insertSnippet', () => {
  it('puts the snippet in place of the typed search, and the caret after it', () => {
    expect(insertSnippet('Hello /pri there', { from: 6, to: 10 }, 'Our prices', 100)).toEqual({
      ok: true,
      text: 'Hello Our prices there',
      caret: 16,
    });
  });

  it('puts it at the caret when nothing is replaced', () => {
    expect(insertSnippet('Hello', { from: 5, to: 5 }, ' there', 100)).toEqual({
      ok: true,
      text: 'Hello there',
      caret: 11,
    });
  });

  it('keeps a range that is past the text, or backwards, inside it', () => {
    expect(insertSnippet('Hi', { from: 9, to: 12 }, '!', 100)).toEqual({
      ok: true,
      text: 'Hi!',
      caret: 3,
    });
    expect(insertSnippet('Hi', { from: 1, to: 0 }, '-', 100)).toEqual({
      ok: true,
      text: 'H-i',
      caret: 2,
    });
    expect(insertSnippet('Hi', { from: -4, to: 0 }, '>', 100)).toEqual({
      ok: true,
      text: '>Hi',
      caret: 1,
    });
  });

  it('changes nothing when the message would be too long', () => {
    expect(insertSnippet('Hello', { from: 5, to: 5 }, ' there', 10)).toEqual({ ok: false });
    expect(insertSnippet('Hello', { from: 5, to: 5 }, ' the', 9)).toMatchObject({ ok: true });
  });
});

describe('groupByFolder', () => {
  const snippet = (name: string, folderName: string | null): SnippetSummary => ({
    id: `snip_${name}`,
    type: 'text',
    name,
    subject: null,
    folderId: folderName === null ? null : `snf_${folderName}`,
    folderName,
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
    revision: 'a'.repeat(64),
    bodyPreview: name,
  });

  it('puts the snippets in no folder first, then each folder by name, keeping their order', () => {
    const groups = groupByFolder(
      [
        snippet('Alpha', 'pricing'),
        snippet('Beta', null),
        snippet('Gamma', 'Directions'),
        snippet('Delta', 'pricing'),
        snippet('Epsilon', null),
      ],
      'en',
    );
    expect(
      groups.map((group) => [group.key, group.name, group.items.map((item) => item.name)]),
    ).toEqual([
      ['none', null, ['Beta', 'Epsilon']],
      ['snf_Directions', 'Directions', ['Gamma']],
      ['snf_pricing', 'pricing', ['Alpha', 'Delta']],
    ]);
  });

  it('has no groups for no snippets, and one for snippets that share a folder', () => {
    expect(groupByFolder([], 'en')).toEqual([]);
    expect(
      groupByFolder([snippet('Alpha', 'Pricing'), snippet('Beta', 'Pricing')], 'en'),
    ).toHaveLength(1);
    expect(
      groupByFolder([snippet('Alpha', 'Pricing'), snippet('Beta', null)], 'en').map(
        (group) => group.name,
      ),
    ).toEqual([null, 'Pricing']);
  });
});

describe('highlightAfter', () => {
  it('moves by one and stops at the ends', () => {
    expect(highlightAfter('ArrowDown', 0, 3)).toBe(1);
    expect(highlightAfter('ArrowDown', 2, 3)).toBe(2);
    expect(highlightAfter('ArrowUp', 2, 3)).toBe(1);
    expect(highlightAfter('ArrowUp', 0, 3)).toBe(0);
  });

  it('is on nothing when there is nothing to be on', () => {
    expect(highlightAfter('ArrowDown', 0, 0)).toBe(-1);
  });
});
