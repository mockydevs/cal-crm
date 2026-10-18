import {
  EMPTY_PAGE_DOCUMENT,
  pageDocument,
  pageElementTypes,
  type VisualPageDocument,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  columnZones,
  documentId,
  RESERVED_PROPS,
  toCanvas,
  toDocument,
  walkCanvas,
  type CanvasData,
  type CanvasNode,
} from './document-map';
import { everyElementPage, smallPage } from './fixtures';

const typesOf = (data: CanvasData): Set<string> => {
  const types = new Set<string>();
  const add = (node: CanvasNode): void => {
    types.add(node.type);
  };
  walkCanvas(data.root.props.sections, 'root:sections', add);
  walkCanvas(data.root.props.popups, 'root:popups', add);
  return types;
};

const find = (data: CanvasData, id: string): CanvasNode => {
  let found: CanvasNode | undefined;
  const look = (node: CanvasNode): void => {
    if (node.props.id === id) found = node;
  };
  walkCanvas(data.root.props.sections, 'root:sections', look);
  walkCanvas(data.root.props.popups, 'root:popups', look);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};

describe('the fixtures', () => {
  it('are pages the contract accepts', () => {
    expect(pageDocument.safeParse(everyElementPage).error).toBeUndefined();
    expect(pageDocument.safeParse(smallPage).error).toBeUndefined();
  });

  it('use every element type of the format, both breakpoints, hidden, popups and a reference', () => {
    const types = typesOf(toCanvas(everyElementPage));
    for (const type of pageElementTypes) expect(types, type).toContain(type);
    for (const type of ['section', 'row', 'column', 'popup', 'saved_section'])
      expect(types, type).toContain(type);
    const text = JSON.stringify(everyElementPage);
    for (const key of ['"tablet":{', '"mobile":{', '"hidden":{', '"customClass"'])
      expect(text).toContain(key);
    expect(everyElementPage.popups).toHaveLength(2);
  });
});

describe('ours → canvas → ours', () => {
  it.each([
    ['a page with every element type', everyElementPage],
    ['a small page', smallPage],
    ['an empty page', EMPTY_PAGE_DOCUMENT],
  ])('is the same document for %s', (_name, document) => {
    const back = toDocument(toCanvas(document));
    expect(back).toStrictEqual(document);
    // Byte for byte, key order included: a save of an untouched page changes nothing.
    expect(JSON.stringify(back)).toBe(JSON.stringify(document));
    expect(pageDocument.parse(back)).toStrictEqual(document);
  });

  it('survives the canvas data being written out and read back, as history does', () => {
    const data = JSON.parse(JSON.stringify(toCanvas(everyElementPage))) as CanvasData;
    expect(toDocument(data)).toStrictEqual(everyElementPage);
  });
});

describe('what the canvas holds', () => {
  const data = toCanvas(everyElementPage);

  it('keeps sections and popups as two slots of the root, and nothing in content', () => {
    expect(data.content).toStrictEqual([]);
    expect(data.root.props.sections.map((node) => node.type)).toStrictEqual([
      'section',
      'saved_section',
      'section',
    ]);
    expect(data.root.props.popups.map((node) => node.type)).toStrictEqual(['popup', 'popup']);
    expect(data.root.props.settings).toBe(everyElementPage.settings);
  });

  it('keeps a saved section as a reference with no children', () => {
    expect(find(data, 'shared-footer')).toStrictEqual({
      type: 'saved_section',
      props: { id: 'shared-footer', sectionId: 'ssec_01h455vb4pex5vsknk084sn02q' },
    });
  });

  it('keeps what differs by device together under look', () => {
    expect(find(data, 'hero-title').props['look']).toStrictEqual({
      style: { fontSize: 48, textAlign: 'left' },
      responsive: { tablet: { fontSize: 36 }, mobile: { fontSize: 28, textAlign: 'center' } },
      customClass: 'offer',
    });
    expect(find(data, 'hero-sub').props['look']).toStrictEqual({ hidden: { mobile: true } });
    expect(find(data, 'hero-copy').props['look']).toStrictEqual({});
  });

  it('nests children under the slot of each kind', () => {
    expect(Object.keys(find(data, 'hero').props)).toStrictEqual([
      'id',
      'width',
      'name',
      'look',
      'rows',
    ]);
    expect(Object.keys(find(data, 'hero-row').props)).toStrictEqual(['id', 'look', 'columns']);
    expect(Object.keys(find(data, 'hero-left').props)).toStrictEqual([
      'id',
      'span',
      'look',
      'children',
    ]);
    expect(find(data, 'claim').props['name']).toBe('Claim the offer');
  });

  it('names no element prop that the canvas uses itself', () => {
    const reserved = new Set(RESERVED_PROPS);
    const taken: string[] = [];
    const check = (node: { type: string; props?: object }): void => {
      if (node.type === 'saved_section') return;
      for (const key of Object.keys(node.props ?? {})) if (reserved.has(key)) taken.push(key);
    };
    const each = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(each);
      else if (typeof value === 'object' && value !== null) {
        if ('type' in value && 'id' in value) check(value as { type: string; props?: object });
        Object.values(value).forEach(each);
      }
    };
    each(everyElementPage);
    expect(taken).toStrictEqual([]);
  });

  it('lists the columns an element can be moved to, in reading order', () => {
    expect(columnZones(data)).toStrictEqual([
      { zone: 'hero-left:children', label: 1 },
      { zone: 'hero-right:children', label: 2 },
      { zone: 'details-one:children', label: 3 },
      { zone: 'claim-col:children', label: 4 },
    ]);
  });

  it('walks every node with the zone that holds it', () => {
    const seen: string[] = [];
    walkCanvas(toCanvas(smallPage).root.props.sections, 'root:sections', (node, zone, index) => {
      seen.push(`${zone}[${String(index)}] ${node.props.id}`);
    });
    expect(seen).toStrictEqual([
      'root:sections[0] top',
      'top:rows[0] top-row',
      'top-row:columns[0] left',
      'left:children[0] title',
      'left:children[1] copy',
      'top-row:columns[1] right',
      'right:children[0] picture',
    ]);
  });
});

describe('what the canvas adds', () => {
  const canvasId = 'sub_headline-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

  it('leaves our ids alone and cuts the canvas’s own to ones the document accepts', () => {
    expect(documentId('hero-title')).toBe('hero-title');
    expect(documentId(canvasId)).toBe('n1b9d6bcdbbfd4b2d9b5dab8dfbbd4bed');
    expect(documentId(canvasId)).toMatch(/^[a-z0-9_-]{1,40}$/);
    expect(documentId('Popup-ABC')).toBe('npopupabc');
  });

  it('saves a node the canvas made, and the actions that point at it, as a valid page', () => {
    const data = toCanvas(smallPage);
    const popup: CanvasNode = {
      type: 'popup',
      props: {
        id: 'popup-3d9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
        name: 'New',
        trigger: 'none',
        delaySeconds: 0,
        width: 'small',
        look: {},
        rows: [],
      },
    };
    const section: CanvasNode = {
      type: 'section',
      props: {
        id: 'section-2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
        width: 'full',
        look: {},
        rows: [],
      },
    };
    const button = (id: string, action: object): CanvasNode => ({
      type: 'button',
      props: { id, label: 'Open', subLabel: '', action, look: { style: { fontSize: 20 } } },
    });
    const edited: CanvasData = {
      ...data,
      root: {
        props: {
          ...data.root.props,
          sections: [
            ...data.root.props.sections.map((node) =>
              node.props.id !== 'top'
                ? node
                : {
                    ...node,
                    props: {
                      ...node.props,
                      rows: [
                        {
                          type: 'row',
                          props: {
                            id: 'row-x',
                            look: {},
                            columns: [
                              {
                                type: 'column',
                                props: {
                                  id: 'col-x',
                                  span: 12,
                                  look: {},
                                  children: [
                                    button(canvasId, { type: 'popup', popupId: popup.props.id }),
                                    button('jump', { type: 'anchor', sectionId: section.props.id }),
                                  ],
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
            ),
            section,
          ],
          popups: [popup],
        },
      },
    };
    const saved = pageDocument.parse(toDocument(edited)) as VisualPageDocument;
    expect(saved.popups[0]?.id).toBe('n3d9d6bcdbbfd4b2d9b5dab8dfbbd4bed');
    expect(saved.sections[1]?.id).toBe('n2c9d6bcdbbfd4b2d9b5dab8dfbbd4bed');
    expect(JSON.stringify(saved)).toContain('"popupId":"n3d9d6bcdbbfd4b2d9b5dab8dfbbd4bed"');
    expect(JSON.stringify(saved)).toContain('"sectionId":"n2c9d6bcdbbfd4b2d9b5dab8dfbbd4bed"');
    expect(JSON.stringify(saved)).toContain('"style":{"fontSize":20}');
  });

  it('hands a prop the document does not know to the schema, which refuses it', () => {
    const data = toCanvas(smallPage);
    const [top] = data.root.props.sections;
    if (top === undefined) throw new Error('no section');
    const stray: CanvasData = {
      ...data,
      root: {
        props: {
          ...data.root.props,
          sections: [{ ...top, props: { ...top.props, added: 'by the canvas' } }],
        },
      },
    };
    expect(pageDocument.safeParse(toDocument(stray)).success).toBe(false);
  });

  it('reads a node with no props, no look and no children as an empty one', () => {
    const bare: CanvasData = {
      root: {
        props: {
          settings: smallPage.settings,
          sections: [{ type: 'section', props: { id: 's', width: 'full' } }],
          popups: [],
        },
      },
      content: [],
    };
    expect(toDocument(bare)).toMatchObject({
      sections: [{ id: 's', type: 'section', props: { width: 'full' }, rows: [] }],
    });
    const loose = { ...smallPage, sections: [{ id: 'x', type: 'section' }] } as unknown;
    expect(toCanvas(loose as VisualPageDocument).root.props.sections).toStrictEqual([
      { type: 'section', props: { id: 'x', look: {}, rows: [] } },
    ]);
  });
});
