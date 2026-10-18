// What a new node starts as: props the contract accepts as they stand, so a page with a
// node just added can be saved (an image with no picture and a form with none chosen are
// accepted by the contract and refused only when the page is published). The words come
// from the caller, in the reader's language.
import type { PageElementType } from '@repo/contracts';

export interface DefaultWords {
  readonly headline: string;
  readonly subHeadline: string;
  readonly paragraph: string;
  readonly listItem: string;
  readonly button: string;
  readonly popup: string;
}

type NodeType = PageElementType | 'section' | 'row' | 'column' | 'popup';

/** The props of a new node of each kind, as the canvas keeps them (`look` among them). */
export function defaultProps(
  words: DefaultWords,
): Readonly<Record<NodeType, Readonly<Record<string, unknown>>>> {
  const none = { type: 'none' } as const;
  return {
    headline: { text: [{ text: words.headline }], level: 1, look: {} },
    sub_headline: { text: [{ text: words.subHeadline }], level: 2, look: {} },
    paragraph: { text: [{ text: words.paragraph }], look: {} },
    bullet_list: { items: [[{ text: words.listItem }]], marker: 'disc', look: {} },
    image: { src: null, alt: '', action: none, optimize: true, look: {} },
    video: {
      source: 'youtube',
      url: null,
      autoplay: false,
      controls: true,
      muted: false,
      loop: false,
      look: {},
    },
    button: { label: words.button, subLabel: '', action: none, look: {} },
    divider: { thickness: 1, line: 'solid', color: null, look: {} },
    form: { formId: null, look: {} },
    calendar: { calendarId: null, look: {} },
    countdown: { endsAt: null, whenOver: { type: 'hide' }, look: {} },
    custom_code: { code: '', look: {} },
    container: { direction: 'vertical', gap: 8, children: [], look: {} },
    section: { width: 'wide', rows: [], look: {} },
    // A row is always added together with its first column (tree.ts, planAdd).
    row: { columns: [], look: {} },
    column: { span: 12, children: [], look: {} },
    popup: {
      name: words.popup,
      trigger: 'none',
      delaySeconds: 0,
      width: 'medium',
      rows: [],
      look: {},
    },
  };
}
