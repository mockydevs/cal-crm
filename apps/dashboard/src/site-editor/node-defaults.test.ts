import { EMPTY_PAGE_DOCUMENT, pageDocument, pageElementTypes } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { RESERVED_PROPS, toDocument, type CanvasData, type CanvasNode } from './document-map';
import { defaultProps } from './node-defaults';

const words = {
  headline: 'Your headline',
  subHeadline: 'A line more',
  paragraph: 'Write here.',
  listItem: 'First point',
  button: 'Click here',
  popup: 'New popup',
};
const defaults = defaultProps(words) as Record<string, Record<string, unknown>>;

const node = (type: string, id: string, extra: Record<string, unknown> = {}): CanvasNode => ({
  type,
  props: { id, ...structuredClone(defaults[type]), ...extra },
});

describe('defaultProps', () => {
  it('starts every element type, and each layout node, as something the contract accepts', () => {
    for (const type of pageElementTypes) {
      const data: CanvasData = {
        root: {
          props: {
            settings: EMPTY_PAGE_DOCUMENT.settings,
            sections: [
              node('section', 's', {
                rows: [
                  node('row', 'r', {
                    columns: [node('column', 'c', { children: [node(type, 'e')] })],
                  }),
                ],
              }),
            ],
            popups: [node('popup', 'p')],
          },
        },
        content: [],
      };
      expect(pageDocument.safeParse(toDocument(data)).error, type).toBeUndefined();
    }
  });

  it('has a start for every kind the canvas can add, in the words it was given', () => {
    expect(Object.keys(defaults).sort()).toStrictEqual(
      [...pageElementTypes, 'section', 'row', 'column', 'popup'].sort(),
    );
    expect(defaults['headline']?.['text']).toStrictEqual([{ text: 'Your headline' }]);
    expect(defaults['button']?.['label']).toBe('Click here');
    expect(defaults['popup']?.['name']).toBe('New popup');
    // A row is added together with its first column, so it starts with none of its own.
    expect(defaults['row']?.['columns']).toStrictEqual([]);
  });

  it('gives no element a prop the canvas keeps for itself', () => {
    for (const type of pageElementTypes)
      for (const key of Object.keys(defaults[type] ?? {}))
        if (key !== 'look' && key !== 'children')
          expect(RESERVED_PROPS, `${type}.${key}`).not.toContain(key);
  });
});
