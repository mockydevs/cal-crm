// Sample pages for the editor's tests. `everyElementPage` uses each of the thirteen element
// types of format 1, both breakpoints, `hidden`, containers as deep as the schema allows
// (three inside one another: a fourth is refused), two popups and one saved-section
// reference: a page that exercises the whole format. They are data for a prototype, not
// text of the product.
/* eslint-disable lingui/no-unlocalized-strings -- sample content, never shown as the product's own words */
import type { PageElement, VisualPageDocument } from '@repo/contracts';

const idOf = (prefix: string, tail: string): string => `${prefix}_01h455vb4pex5vsknk084sn0${tail}`;

export const sampleForms = [
  { id: idOf('form', '2q'), name: 'Contact us' },
  { id: idOf('form', '2r'), name: 'Book a visit' },
] as const;

const none = { type: 'none' } as const;

const deepContainer: PageElement = {
  id: 'box-1',
  type: 'container',
  props: { direction: 'vertical', gap: 8 },
  children: [
    {
      id: 'box-2',
      type: 'container',
      props: { direction: 'horizontal', gap: 4 },
      children: [
        {
          id: 'box-3',
          type: 'container',
          props: { direction: 'vertical', gap: 0 },
          children: [
            {
              id: 'deep-text',
              type: 'paragraph',
              props: { text: [{ text: 'As deep as the format allows.' }] },
            },
          ],
        },
      ],
    },
  ],
};

export const everyElementPage: VisualPageDocument = {
  format: 1,
  mode: 'visual',
  settings: {
    seo: {
      title: 'Spring offer',
      description: 'A page that uses everything.',
      imageUrl: null,
      noIndex: false,
      canonicalUrl: null,
      meta: [{ name: 'author', content: 'Harbor Lights' }],
    },
    background: {
      color: '#ffffff',
      imageUrl: null,
      size: 'cover',
      position: 'center',
      repeat: false,
    },
    typography: { headingFont: 'Lexend', bodyFont: null, textColor: '#1f2937', linkColor: null },
    customCss: '.offer { letter-spacing: 1px; }',
    headCode: '<script>window.tenant = 1</script>',
    bodyCode: '',
  },
  sections: [
    {
      id: 'hero',
      type: 'section',
      name: 'Hero',
      props: { width: 'wide' },
      style: { backgroundColor: '#f1f5f9', padding: { top: 48, bottom: 48 } },
      responsive: {
        tablet: { padding: { top: 32 } },
        mobile: { padding: { top: 16, bottom: 16 } },
      },
      rows: [
        {
          id: 'hero-row',
          type: 'row',
          columns: [
            {
              id: 'hero-left',
              type: 'column',
              props: { span: 7 },
              children: [
                {
                  id: 'hero-title',
                  type: 'headline',
                  props: {
                    level: 1,
                    text: [
                      { text: 'Spring offer for ' },
                      { text: '{{contact.first_name}}', bold: true, color: '#0f766e' },
                    ],
                  },
                  style: { fontSize: 48, textAlign: 'left' },
                  responsive: {
                    tablet: { fontSize: 36 },
                    mobile: { fontSize: 28, textAlign: 'center' },
                  },
                  customClass: 'offer',
                },
                {
                  id: 'hero-sub',
                  type: 'sub_headline',
                  props: { level: 2, text: [{ text: 'Two weeks only', italic: true }] },
                  hidden: { mobile: true },
                },
                {
                  id: 'hero-copy',
                  type: 'paragraph',
                  props: {
                    text: [
                      { text: 'Read the ' },
                      {
                        text: 'terms',
                        underline: true,
                        link: { type: 'url', href: 'https://example.com/terms', newTab: true },
                      },
                      { text: ' or ', strike: false },
                      {
                        text: 'see what is inside',
                        link: { type: 'anchor', sectionId: 'details' },
                      },
                      { text: '.' },
                    ],
                  },
                },
                {
                  id: 'hero-cta',
                  type: 'button',
                  props: {
                    label: 'Claim it',
                    subLabel: '',
                    action: { type: 'popup', popupId: 'claim' },
                  },
                  style: { backgroundColor: '#0f766e', textColor: '#ffffff', borderRadius: 8 },
                  responsive: { mobile: { width: { value: 100, unit: '%' } } },
                },
              ],
            },
            {
              id: 'hero-right',
              type: 'column',
              props: { span: 5 },
              hidden: { tablet: true, mobile: true },
              children: [
                {
                  id: 'hero-image',
                  type: 'image',
                  props: {
                    src: 'https://example.com/offer.png',
                    alt: 'A lighthouse at dusk',
                    action: { type: 'next_step' },
                    optimize: true,
                  },
                },
                {
                  id: 'hero-video',
                  type: 'video',
                  props: {
                    source: 'youtube',
                    url: null,
                    autoplay: false,
                    controls: true,
                    muted: false,
                    loop: false,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    { id: 'shared-footer', type: 'saved_section', sectionId: idOf('ssec', '2q') },
    {
      id: 'details',
      type: 'section',
      props: { width: 'medium' },
      rows: [
        {
          id: 'details-row',
          type: 'row',
          style: { margin: { bottom: 24 } },
          columns: [
            {
              id: 'details-one',
              type: 'column',
              props: { span: 12 },
              children: [
                {
                  id: 'details-list',
                  type: 'bullet_list',
                  props: {
                    marker: 'check',
                    items: [
                      [{ text: 'Free delivery' }],
                      [{ text: 'Cancel ', bold: true }, { text: 'any time' }],
                    ],
                  },
                },
                {
                  id: 'details-line',
                  type: 'divider',
                  props: { thickness: 2, line: 'dashed', color: null },
                },
                { id: 'details-form', type: 'form', props: { formId: sampleForms[0].id } },
                {
                  id: 'details-calendar',
                  type: 'calendar',
                  props: { calendarId: idOf('cal', '2q') },
                },
                {
                  id: 'details-countdown',
                  type: 'countdown',
                  props: {
                    endsAt: '2026-12-01T00:00:00.000Z',
                    whenOver: { type: 'text', text: 'The offer has ended.' },
                  },
                },
                {
                  id: 'details-code',
                  type: 'custom_code',
                  props: { code: '<script>document.title = "tenant code ran"</script><b>raw</b>' },
                },
                deepContainer,
                {
                  id: 'details-next',
                  type: 'button',
                  props: {
                    label: 'Go to checkout',
                    subLabel: 'Step two',
                    action: { type: 'step', stepId: idOf('sstp', '2q') },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  popups: [
    {
      id: 'claim',
      type: 'popup',
      name: 'Claim the offer',
      props: { trigger: 'none', delaySeconds: 0, width: 'medium' },
      style: { backgroundColor: '#ffffff' },
      rows: [
        {
          id: 'claim-row',
          type: 'row',
          columns: [
            {
              id: 'claim-col',
              type: 'column',
              props: { span: 12 },
              children: [
                {
                  id: 'claim-title',
                  type: 'headline',
                  props: { level: 2, text: [{ text: 'Almost there' }] },
                },
                { id: 'claim-form', type: 'form', props: { formId: null } },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'leaving',
      type: 'popup',
      name: 'Before you go',
      props: { trigger: 'exit', delaySeconds: 0, width: 'small' },
      rows: [],
    },
  ],
};

/** A small page for the browser check: one section, two columns, three elements. */
export const smallPage: VisualPageDocument = {
  ...everyElementPage,
  sections: [
    {
      id: 'top',
      type: 'section',
      props: { width: 'wide' },
      rows: [
        {
          id: 'top-row',
          type: 'row',
          columns: [
            {
              id: 'left',
              type: 'column',
              props: { span: 6 },
              children: [
                { id: 'title', type: 'headline', props: { level: 1, text: [{ text: 'Welcome' }] } },
                { id: 'copy', type: 'paragraph', props: { text: [{ text: 'First words.' }] } },
              ],
            },
            {
              id: 'right',
              type: 'column',
              props: { span: 6 },
              children: [
                {
                  id: 'picture',
                  type: 'image',
                  props: { src: null, alt: '', action: none, optimize: true },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  popups: [],
};

/**
 * A long page for the editor's speed check: twenty sections of one row, three columns and
 * five elements each, 300 elements in all.
 */
export function longPage(sections = 20, perColumn = 5): VisualPageDocument {
  const element = (id: string, at: number): PageElement => {
    switch (at % 5) {
      case 0:
        return { id, type: 'headline', props: { level: 2, text: [{ text: `Heading ${id}` }] } };
      case 1:
        return {
          id,
          type: 'paragraph',
          props: {
            text: [{ text: `Paragraph ${id}: some words to fill a few lines of the column.` }],
          },
          style: { fontSize: 16 },
          responsive: { mobile: { fontSize: 14 } },
        };
      case 2:
        return {
          id,
          type: 'bullet_list',
          props: { marker: 'check', items: [[{ text: 'One' }], [{ text: 'Two' }]] },
        };
      case 3:
        return {
          id,
          type: 'button',
          props: { label: `Button ${id}`, subLabel: '', action: none },
          style: { backgroundColor: '#0f766e', textColor: '#ffffff' },
        };
      default:
        return { id, type: 'divider', props: { thickness: 1, line: 'solid', color: null } };
    }
  };
  return {
    ...everyElementPage,
    popups: [],
    sections: Array.from({ length: sections }, (_, section) => ({
      id: `s${String(section)}`,
      type: 'section' as const,
      name: `Section ${String(section + 1)}`,
      props: { width: 'wide' as const },
      style: { padding: { top: 24, bottom: 24 } },
      rows: [
        {
          id: `s${String(section)}-r`,
          type: 'row' as const,
          columns: [0, 1, 2].map((column) => ({
            id: `s${String(section)}-c${String(column)}`,
            type: 'column' as const,
            props: { span: 4 },
            children: Array.from({ length: perColumn }, (_, at) =>
              element(`s${String(section)}-c${String(column)}-e${String(at)}`, at),
            ),
          })),
        },
      ],
    })),
  };
}
