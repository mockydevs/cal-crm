// A long page for whoever measures: the renderer's own budget tests, the server's benchmark
// and its load test, and the editor's "long page" browser test. The standard names its
// size: 20 sections and 300 elements. Nothing here is read by a page that is served.
import {
  EMPTY_PAGE_DOCUMENT,
  type PageElement,
  type PageSection,
  type VisualPageDocument,
} from '@repo/contracts';

const none = { type: 'none' } as const;

const text = (value: string): { text: string }[] => [{ text: value }];

/** A card of a feature row: a picture, what it is called, a line about it, and a link. */
function card(id: string, site: number): PageElement[] {
  return [
    {
      id: `${id}-image`,
      type: 'image',
      props: {
        src: `https://img.example/${id}.png`,
        alt: `Picture ${id}`,
        action: none,
        optimize: true,
        // The picture's own size, as the media library knows it: its place is kept
        // while it loads.
        width: 800,
        height: 450,
      },
      style: { borderRadius: 12 },
    },
    {
      id: `${id}-title`,
      type: 'sub_headline',
      props: { text: text(`Feature ${id}`), level: 3 },
      style: { fontSize: 22, fontWeight: 600 },
      responsive: { mobile: { fontSize: 18 } },
    },
    {
      id: `${id}-text`,
      type: 'paragraph',
      props: {
        text: [
          { text: 'It does what you need, ' },
          { text: 'every day', bold: true },
          { text: `, for site ${String(site)} and every one like it.` },
        ],
      },
    },
    {
      id: `${id}-button`,
      type: 'button',
      // To the top of the page: a link every page can have, whatever its site is.
      props: { label: 'Learn more', subLabel: '', action: { type: 'anchor', sectionId: 's0' } },
      style: { backgroundColor: '#2563eb', borderRadius: 8 },
    },
  ];
}

function section(index: number, elements: number): PageSection {
  const id = `s${String(index)}`;
  const lead: PageElement[] = [
    {
      id: `${id}-headline`,
      type: 'headline',
      props: { text: text(`Section ${String(index + 1)} of the page`), level: index === 0 ? 1 : 2 },
      style: { fontSize: 40, textAlign: 'center' },
      responsive: { tablet: { fontSize: 32 }, mobile: { fontSize: 26 } },
    },
    {
      id: `${id}-lead`,
      type: 'paragraph',
      props: { text: text('A line that says what this part of the page is about, in a sentence.') },
      style: { textAlign: 'center' },
    },
    { id: `${id}-rule`, type: 'divider', props: { thickness: 1, line: 'solid', color: '#e5e7eb' } },
  ];
  // What is left after the three above goes into three columns of cards, a card at a time.
  const cards = Array.from({ length: 3 }, (_, column) => card(`${id}c${String(column)}`, index));
  const columns: PageElement[][] = [[], [], []];
  let left = Math.max(0, elements - lead.length);
  for (let at = 0; left > 0; at += 1) {
    const next = cards[at % 3]?.[Math.floor(at / 3)];
    if (next === undefined) break;
    columns[at % 3]?.push(next);
    left -= 1;
  }
  return {
    id,
    type: 'section',
    props: { width: 'wide' },
    style: {
      padding: { top: 64, bottom: 64 },
      ...(index % 2 === 1 ? { backgroundColor: '#f8fafc' } : {}),
    },
    rows: [
      {
        id: `${id}-top`,
        type: 'row',
        columns: [{ id: `${id}-top-col`, type: 'column', props: { span: 12 }, children: lead }],
      },
      {
        id: `${id}-cards`,
        type: 'row',
        columns: columns.map((children, column) => ({
          id: `${id}-col${String(column)}`,
          type: 'column' as const,
          props: { span: 4 },
          children,
        })),
      },
    ],
  };
}

/**
 * A landing page of `sections` sections that hold `elements` elements between them, spread
 * evenly: by default the 20 sections and 300 elements the standard measures with.
 */
export function longPage(sections = 20, elements = 300): VisualPageDocument {
  const each = Math.floor(elements / sections);
  return {
    ...EMPTY_PAGE_DOCUMENT,
    sections: Array.from({ length: sections }, (_, index) =>
      // What does not divide evenly goes to the first sections, one more each.
      section(index, each + (index < elements % sections ? 1 : 0)),
    ),
  };
}
