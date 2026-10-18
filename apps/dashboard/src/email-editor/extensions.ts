// What the email editor can write, as the pieces of its document (tiptap 3 on ProseMirror).
// Each piece writes only what the server's allowlist keeps
// (packages/modules/messaging/src/email-html.ts): p, h1 to h3, ul, ol, li, hr, strong, em,
// u, s, span with a colour or a background colour, a with an http, https, mailto or tel
// address (or one merge field), img with an https or /m/ address, alt and width, and a
// button as a one-cell presentation table (a button element is not kept, and a table cell
// with a background is the form Outlook draws as a button). So what is saved is what is
// sent: cleaning it changes nothing.
//
// Bold and italic are tiptap's own. The rest are written here on tiptap's core, which is
// already in the build: the packages for them were not installed by this workspace.
/* eslint-disable lingui/no-unlocalized-strings -- tags, styles and selectors, not words */
import Bold from '@tiptap/extension-bold';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Italic from '@tiptap/extension-italic';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import {
  Extension,
  Mark,
  mergeAttributes,
  Node,
  nodeInputRule,
  nodePasteRule,
  textblockTypeInputRule,
  wrappingInputRule,
  type Extensions,
} from '@tiptap/react';
import { CHIP_ATTRIBUTE, emailImageAddress, emailLinkAddress, tokenOf } from './email-html';

const MERGE_PATH = '[a-z][a-z_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)+';

/** A colour as the palette holds it: #rrggbb, whatever way the HTML wrote it. */
export function hexColour(written: string): string | undefined {
  const value = written.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short !== null)
    return `#${short
      .slice(1)
      .map((each) => each + each)
      .join('')}`;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(
    value,
  );
  if (rgb === null) return undefined;
  const parts = rgb.slice(1, 4).map((each) => Math.min(255, Number(each)));
  return `#${parts.map((each) => each.toString(16).padStart(2, '0')).join('')}`;
}

/** White or near-black, whichever reads on a background: for a button's words. */
export function readableOn(background: string): '#ffffff' | '#111827' {
  const hex = hexColour(background) ?? '#000000';
  const channel = (at: number): number => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // The contrast with white is (1.05) / (L + 0.05): white reads while that is 4.5 or more.
  return 1.05 / (luminance + 0.05) >= 4.5 ? '#ffffff' : '#111827';
}

const Underline = Mark.create({
  name: 'underline',
  parseHTML() {
    return [
      { tag: 'u' },
      {
        style: 'text-decoration',
        consuming: false,
        getAttrs: (value) => (value.includes('underline') ? {} : false),
      },
    ];
  },
  renderHTML() {
    return ['u', 0];
  },
  addKeyboardShortcuts() {
    return { 'Mod-u': () => this.editor.commands.toggleMark(this.name) };
  },
});

const Strike = Mark.create({
  name: 'strike',
  parseHTML() {
    return [
      { tag: 's' },
      { tag: 'del' },
      { tag: 'strike' },
      {
        style: 'text-decoration',
        consuming: false,
        getAttrs: (value) => (value.includes('line-through') ? {} : false),
      },
    ];
  },
  renderHTML() {
    return ['s', 0];
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-s': () => this.editor.commands.toggleMark(this.name) };
  },
});

const colourMark = (name: string, property: 'color' | 'background-color', tags: string[]) =>
  Mark.create({
    name,
    addAttributes() {
      return { colour: { default: null } };
    },
    parseHTML() {
      return [
        {
          style: property,
          getAttrs: (value) => {
            const colour = hexColour(value);
            return colour === undefined ? false : { colour };
          },
        },
        ...tags.map((tag) => ({
          tag,
          getAttrs: (element: HTMLElement) => {
            const colour = hexColour(element.getAttribute('color') ?? '');
            return tag === 'mark' ? { colour: colour ?? '#fef08a' } : colour ? { colour } : false;
          },
        })),
      ];
    },
    renderHTML({ mark }) {
      return ['span', { style: `${property}:${String(mark.attrs['colour'])}` }, 0];
    },
  });

const TextColour = colourMark('textColour', 'color', ['font[color]']);
const Highlight = colourMark('highlight', 'background-color', ['mark']);

const Link = Mark.create({
  name: 'link',
  // Typing at the end of a link is not part of it.
  inclusive: false,
  addAttributes() {
    return { href: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: 'a[href]',
        getAttrs: (element) => {
          const href = emailLinkAddress(element.getAttribute('href') ?? '');
          return href === undefined ? false : { href };
        },
      },
    ];
  },
  renderHTML({ mark }) {
    return [
      'a',
      { href: String(mark.attrs['href']), target: '_blank', rel: 'noopener noreferrer' },
      0,
    ];
  },
});

export const HEADING_LEVELS = [1, 2, 3] as const;

const Heading = Node.create({
  name: 'heading',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return { level: { default: 2, rendered: false } };
  },
  parseHTML() {
    return [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${String(level)}`,
      attrs: { level: Math.min(level, 3) },
    }));
  },
  renderHTML({ node, HTMLAttributes }) {
    return [`h${String(node.attrs['level'])}`, HTMLAttributes, 0];
  },
  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^(#{1,3})\s$/,
        type: this.type,
        getAttributes: (match) => ({ level: match[1]?.length ?? 2 }),
      }),
    ];
  },
});

const ListItem = Node.create({
  name: 'listItem',
  content: 'paragraph block*',
  defining: true,
  parseHTML() {
    return [{ tag: 'li' }];
  },
  renderHTML() {
    return ['li', 0];
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => this.editor.commands.sinkListItem(this.name),
      'Shift-Tab': () => this.editor.commands.liftListItem(this.name),
    };
  },
});

const BulletList = Node.create({
  name: 'bulletList',
  group: 'block list',
  content: 'listItem+',
  parseHTML() {
    return [{ tag: 'ul' }];
  },
  renderHTML() {
    return ['ul', 0];
  },
  addInputRules() {
    return [wrappingInputRule({ find: /^\s*([-+*])\s$/, type: this.type })];
  },
});

const OrderedList = Node.create({
  name: 'orderedList',
  group: 'block list',
  content: 'listItem+',
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element) => Number(element.getAttribute('start') ?? 1) || 1,
        renderHTML: (attributes) =>
          attributes['start'] === 1 ? {} : { start: String(attributes['start']) },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'ol' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['ol', HTMLAttributes, 0];
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: /^(\d+)\.\s$/,
        type: this.type,
        getAttributes: (match) => ({ start: Number(match[1]) }),
      }),
    ];
  },
});

const Divider = Node.create({
  name: 'divider',
  group: 'block',
  atom: true,
  parseHTML() {
    return [{ tag: 'hr' }];
  },
  renderHTML() {
    return ['hr'];
  },
});

export const ALIGNMENTS = ['left', 'center', 'right'] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

const alignmentOf = (written: string | null | undefined): Alignment | null => {
  const value = (written ?? '').trim().toLowerCase();
  return value === 'center' || value === 'right' ? value : null;
};

/** How wide a picture may be drawn: a number of pixels, or all of the email's width. */
export const IMAGE_WIDTHS = ['100%', '480', '320', '160'] as const;

const Picture = Node.create({
  name: 'picture',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null, rendered: false },
      alt: { default: '', rendered: false },
      width: { default: '100%', rendered: false },
      align: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (element) => {
          const src = emailImageAddress(element.getAttribute('src'));
          if (src === undefined) return false;
          const width = element.getAttribute('width') ?? '';
          const { marginLeft, marginRight } = element.style;
          return {
            src,
            alt: element.getAttribute('alt') ?? '',
            width: /^\d{1,4}%?$/.test(width) ? width : '100%',
            align: marginLeft === 'auto' ? (marginRight === 'auto' ? 'center' : 'right') : null,
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    const align = alignmentOf(node.attrs['align'] as string | null);
    const margins =
      align === 'center'
        ? ';margin-left:auto;margin-right:auto'
        : align === 'right'
          ? ';margin-left:auto'
          : '';
    return [
      'img',
      {
        src: String(node.attrs['src']),
        alt: String(node.attrs['alt']),
        width: String(node.attrs['width']),
        style: `display:block;max-width:100%;height:auto${margins}`,
      },
    ];
  },
});

/** The colour a new button starts with. */
export const BUTTON_COLOUR = '#2563eb';

const EmailButton = Node.create({
  name: 'emailButton',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      label: { default: '', rendered: false },
      href: { default: null, rendered: false },
      colour: { default: BUTTON_COLOUR, rendered: false },
      align: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'table[role="presentation"]',
        getAttrs: (element) => {
          const cell = element.querySelector('td[bgcolor]') ?? undefined;
          const link = cell?.querySelector('a[href]');
          const href = emailLinkAddress(link?.getAttribute('href') ?? '');
          const label = (link?.textContent ?? '').trim();
          if (cell === undefined || href === undefined || label === '') return false;
          return {
            label,
            href,
            colour: hexColour(cell.getAttribute('bgcolor') ?? '') ?? BUTTON_COLOUR,
            align: alignmentOf(element.getAttribute('align')),
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    const colour = String(node.attrs['colour']);
    const align = alignmentOf(node.attrs['align'] as string | null) ?? 'left';
    // A string is a text node in ProseMirror's output; tiptap's own type leaves it out.
    const label = String(node.attrs['label']) as unknown as 0;
    return [
      'table',
      { role: 'presentation', border: '0', cellpadding: '0', cellspacing: '0', align },
      [
        'tbody',
        [
          'tr',
          [
            'td',
            { bgcolor: colour, align: 'center', style: 'border-radius:6px;padding:12px 24px' },
            [
              'a',
              {
                href: String(node.attrs['href']),
                target: '_blank',
                rel: 'noopener noreferrer',
                // Its lines are 24px tall, so the words alone are a target a finger can press.
                style: `color:${readableOn(colour)};text-decoration:none;font-weight:bold;display:inline-block;line-height:24px`,
              },
              label,
            ],
          ],
        ],
      ],
    ];
  },
});

export interface MergeFieldOptions {
  /** Whether a path is a field this email can fill in; one that is not is marked. */
  readonly isKnown: (path: string) => boolean;
  /** Said of a chip whose field is not known, as its title. */
  readonly unknownTitle: string;
}

/** The classes of a chip, in the editor only: they are taken off when the HTML is saved. */
const CHIP_CLASS =
  'rounded-md bg-[#eceef2] px-1 py-0.5 font-mono text-[0.85em] text-[#344054] whitespace-nowrap data-[unknown=true]:bg-[#fee4e2] data-[unknown=true]:text-[#b42318]';

const MergeField = Node.create<MergeFieldOptions>({
  name: 'mergeField',
  group: 'inline',
  inline: true,
  atom: true,
  addOptions() {
    return { isKnown: () => true, unknownTitle: '' };
  },
  addAttributes() {
    return { path: { default: '', rendered: false } };
  },
  parseHTML() {
    return [
      {
        tag: `span[${CHIP_ATTRIBUTE}]`,
        getAttrs: (element) => {
          const path = element.getAttribute(CHIP_ATTRIBUTE) ?? '';
          return new RegExp(`^${MERGE_PATH}$`).test(path) ? { path } : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    const path = String(node.attrs['path']);
    const unknown = !this.options.isKnown(path);
    return [
      'span',
      mergeAttributes(
        { [CHIP_ATTRIBUTE]: path, class: CHIP_CLASS },
        unknown ? { 'data-unknown': 'true', title: this.options.unknownTitle } : {},
      ),
      tokenOf(path),
    ];
  },
  renderText({ node }) {
    return tokenOf(String(node.attrs['path']));
  },
  addInputRules() {
    return [
      nodeInputRule({
        find: new RegExp(`\\{\\{\\s*(${MERGE_PATH})\\s*\\}\\}$`),
        type: this.type,
        getAttributes: (match) => ({ path: match[1] }),
      }),
    ];
  },
  addPasteRules() {
    return [
      nodePasteRule({
        find: new RegExp(`\\{\\{\\s*(${MERGE_PATH})\\s*\\}\\}`, 'g'),
        type: this.type,
        getAttributes: (match) => ({ path: match[1] }),
      }),
    ];
  },
});

export const LINE_HEIGHTS = ['1.2', '1.5', '2'] as const;

/** How a block of text is set: its alignment and the height of its lines. */
const BlockStyle = Extension.create({
  name: 'blockStyle',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) =>
              alignmentOf(element.style.textAlign) ?? alignmentOf(element.getAttribute('align')),
            renderHTML: (attributes) =>
              attributes['textAlign'] === null
                ? {}
                : { style: `text-align:${String(attributes['textAlign'])}` },
          },
          lineHeight: {
            default: null,
            parseHTML: (element) =>
              /^\d(?:\.\d{1,2})?$/.test(element.style.lineHeight) ? element.style.lineHeight : null,
            renderHTML: (attributes) =>
              attributes['lineHeight'] === null
                ? {}
                : { style: `line-height:${String(attributes['lineHeight'])}` },
          },
        },
      },
    ];
  },
});

/** Every piece of the editor's document, with what a chip needs to know of the fields. */
export function emailExtensions(mergeFields: MergeFieldOptions): Extensions {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    Bold,
    Italic,
    Underline,
    Strike,
    TextColour,
    Highlight,
    Link,
    Heading,
    BulletList,
    OrderedList,
    ListItem,
    Divider,
    Picture,
    EmailButton,
    MergeField.configure(mergeFields),
    BlockStyle,
    UndoRedo,
  ];
}
