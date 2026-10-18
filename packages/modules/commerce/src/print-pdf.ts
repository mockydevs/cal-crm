// A printed quote, invoice or receipt as a PDF, drawn by pdfmake from the one description
// print.ts makes. Rendering is a function of that description and the logo's bytes: it
// reads no database, no clock and no network.
//
// The font is Roboto, the copy pdfmake ships (Apache-2.0), embedded as the subset each
// document uses. It covers Latin with its extensions (so Łódź, Nguyễn and Žižkov print),
// Greek and Cyrillic. It has no Arabic, Hebrew, Chinese, Japanese, Korean, Thai or Indic
// letters: a name in one of those prints as empty boxes. Money is printed with its
// currency code, which every font has.
//
// pdfmake can fetch an image or a font from an address or from the disk when a document
// definition names one. Nothing here names either (the logo goes in as bytes), and both
// doors are shut anyway: no address is ever fetched, and the only files read are the four
// font files.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import pdfmake, { type Content, type TableCell } from 'pdfmake';

import type { Printed } from './print.js';

/** What pdfmake lays out: a document definition, as its own types describe one. */
export type PdfDefinition = Parameters<typeof pdfmake.createPdf>[0];

/** A logo's bytes with their type, as the files module holds them. */
export interface PrintedLogo {
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** The largest logo put on a document. A larger one is left off, never refused. */
export const MAX_LOGO_BYTES = 1024 * 1024;
/** The image types a PDF embeds as they are. A GIF or WebP logo is left off the PDF. */
const EMBEDDED_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg']);

const fontDirectory = join(
  dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')),
  'fonts',
  'Roboto',
);
const FONT_FILES = {
  normal: join(fontDirectory, 'Roboto-Regular.ttf'),
  bold: join(fontDirectory, 'Roboto-Medium.ttf'),
  italics: join(fontDirectory, 'Roboto-Italic.ttf'),
  bolditalics: join(fontDirectory, 'Roboto-MediumItalic.ttf'),
} as const;
const allowedFiles: ReadonlySet<string> = new Set(
  Object.values(FONT_FILES).map((file) => resolve(file)),
);

// pdfmake's server entry is one shared object. It is set up here, once, for every render.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => allowedFiles.has(resolve(path)));

const INK = '#1d2a24';
const MUTED = '#5f6b66';
const RULE = '#d5dbd7';
const A4_WIDTH = 595.28;
const MARGIN = 40;

const right = (text: string, more: Record<string, unknown> = {}): TableCell => ({
  text,
  alignment: 'right',
  ...more,
});

/** The table of lines. Its heading row is drawn again at the top of every page it reaches. */
function linesTable(printed: Printed): Content {
  const [description, ...numbers] = printed.columns;
  return {
    margin: [0, 18, 0, 0],
    table: {
      headerRows: 1,
      // The heading never ends a page alone, with its first line on the next.
      keepWithHeaderRows: 1,
      widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'],
      body: [
        [
          { text: description, style: 'columnHeading' },
          ...numbers.map((heading) => right(heading, { style: 'columnHeading' })),
        ],
        ...printed.lines.map((line): TableCell[] => [
          {
            stack: [
              { text: line.name, bold: true },
              ...(line.description === ''
                ? []
                : [{ text: line.description, color: MUTED, fontSize: 8, margin: [0, 2, 0, 0] }]),
            ],
          } as TableCell,
          right(line.quantity),
          right(line.rate),
          right(line.discount),
          right(line.tax),
          right(line.amount),
        ]),
      ],
    },
    layout: {
      hLineWidth: (row) => (row === 0 ? 0 : 0.6),
      vLineWidth: () => 0,
      hLineColor: () => RULE,
      paddingTop: () => 6,
      paddingBottom: () => 6,
      paddingLeft: (column) => (column === 0 ? 0 : 8),
      paddingRight: () => 0,
    },
  };
}

/** The totals, kept together on one page, at the right. */
function totalsBlock(printed: Printed): Content {
  return {
    unbreakable: true,
    margin: [0, 14, 0, 0],
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: {
          widths: ['auto', 'auto'],
          body: printed.totals.map((row): TableCell[] => [
            { text: row.label, bold: row.strong, color: row.strong ? INK : MUTED },
            right(row.value, { bold: row.strong, fontSize: row.strong ? 11 : 9 }),
          ]),
        },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingTop: () => 3,
          paddingBottom: () => 3,
          paddingLeft: (column) => (column === 0 ? 0 : 24),
          paddingRight: () => 0,
        },
      },
    ],
  };
}

/**
 * The page as pdfmake lays it out: A4, the seller and the logo at the top left, the title,
 * number and dates at the top right, who it is for, the lines, the totals, then the notes,
 * how to pay and the terms, with the number and "Page 1 of 3" at the foot of every page.
 */
export function pdfDefinition(printed: Printed, logo?: PrintedLogo): PdfDefinition {
  const hasLogo =
    logo !== undefined &&
    EMBEDDED_TYPES.has(logo.contentType) &&
    logo.bytes.length > 0 &&
    logo.bytes.length <= MAX_LOGO_BYTES;
  const named = [printed.title, printed.number].filter((part) => part !== null).join(' ');
  return {
    pageSize: 'A4',
    pageMargins: [MARGIN, 44, MARGIN, 56],
    info: { title: named, author: printed.seller.name, creator: 'CRM', producer: 'CRM' },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: INK, lineHeight: 1.25 },
    styles: {
      columnHeading: { fontSize: 8, bold: true, color: MUTED },
      heading: { fontSize: 8, bold: true, color: MUTED, margin: [0, 0, 0, 3] },
    },
    ...(hasLogo
      ? {
          images: {
            logo: `data:${logo.contentType};base64,${Buffer.from(logo.bytes).toString('base64')}`,
          },
        }
      : {}),
    ...(printed.mark === null
      ? {}
      : { watermark: { text: printed.mark, color: '#9aa5a0', opacity: 0.18, bold: true } }),
    footer: (page, pages) => ({
      margin: [MARGIN, 18, MARGIN, 0],
      fontSize: 8,
      color: MUTED,
      columns: [
        { text: named, width: '*' },
        { text: `Page ${String(page)} of ${String(pages)}`, alignment: 'right', width: 'auto' },
      ],
    }),
    content: [
      {
        columns: [
          {
            width: '*',
            stack: [
              ...(hasLogo
                ? [{ image: 'logo', fit: [150, 64] as [number, number], margin: [0, 0, 0, 10] }]
                : []),
              { text: printed.seller.name, fontSize: 12, bold: true },
              ...printed.seller.lines.map((line) => ({ text: line, color: MUTED })),
            ] as Content[],
          },
          {
            width: 'auto',
            stack: [
              { text: printed.title.toUpperCase(), fontSize: 20, bold: true, alignment: 'right' },
              {
                text: printed.number ?? 'Draft',
                fontSize: 11,
                alignment: 'right',
                margin: [0, 2, 0, 8],
              },
              // A draft with no dates yet has no facts, and a table needs a row.
              ...(printed.facts.length === 0
                ? []
                : [
                    {
                      table: {
                        widths: ['auto', 'auto'],
                        body: printed.facts.map((fact): TableCell[] => [
                          { text: fact.label, color: MUTED },
                          right(fact.value),
                        ]),
                      },
                      layout: 'noBorders',
                    },
                  ]),
            ] as Content[],
          },
        ],
        columnGap: 24,
      },
      {
        margin: [0, 20, 0, 0],
        stack: [
          { text: printed.customer.heading.toUpperCase(), style: 'heading' },
          { text: printed.customer.name, bold: true },
          ...printed.customer.lines.map((line) => ({ text: line, color: MUTED })),
        ],
      },
      ...(printed.lines.length === 0 ? [] : [linesTable(printed)]),
      ...(printed.lines.length === 0
        ? [
            {
              margin: [0, 18, 0, 0] as [number, number, number, number],
              canvas: [
                {
                  type: 'line' as const,
                  x1: 0,
                  y1: 0,
                  x2: A4_WIDTH - 2 * MARGIN,
                  y2: 0,
                  lineWidth: 0.6,
                  lineColor: RULE,
                },
              ],
            },
          ]
        : []),
      totalsBlock(printed),
      ...printed.sections.map((section): Content => ({
        margin: [0, 18, 0, 0],
        stack: [
          { text: section.heading.toUpperCase(), style: 'heading' },
          { text: section.text, color: INK },
        ],
      })),
    ],
  };
}

/**
 * The PDF's bytes. A logo that cannot be drawn (not the image its type says, or damaged)
 * is left off and the document is drawn without it: a bad logo never stops an invoice.
 */
export async function renderPdf(
  printed: Printed,
  logo?: PrintedLogo,
): Promise<Uint8Array<ArrayBuffer>> {
  // The font table is handed over fresh each time: pdfmake rewrites the one it is given.
  const draw = async (withLogo: PrintedLogo | undefined) => {
    pdfmake.setFonts({ Roboto: { ...FONT_FILES } });
    const buffer = await pdfmake.createPdf(pdfDefinition(printed, withLogo)).getBuffer();
    return new Uint8Array(buffer);
  };
  if (logo === undefined) return draw(undefined);
  try {
    return await draw(logo);
  } catch {
    return draw(undefined);
  }
}
