// Pages the renderer's tests share: one of every element of the format, and the context a
// published page of a funnel is rendered in.
import {
  EMPTY_PAGE_DOCUMENT,
  type PageDocument,
  type PageElement,
  type PageSection,
  type VisualPageDocument,
} from '@repo/contracts';

import type { RenderContext } from './render.js';

export const STEP = 'sstp_01h455vb4pex5vsknk084sn02q';
export const SECTION = 'ssec_01h455vb4pex5vsknk084sn02q';
export const FORM = 'form_01h455vb4pex5vsknk084sn02q';
export const CALENDAR = 'cal_01h455vb4pex5vsknk084sn02q';
export const FORM_KEY = 'formkeyformkeyformkeyformkeyfor';
export const SITE_BASE = '/s/0123456789abcdef0123456789abcdef';

const none = { type: 'none' } as const;

/** One of each element type, by its type. */
export const ELEMENTS: Readonly<Record<PageElement['type'], PageElement>> = {
  headline: {
    id: 'h',
    type: 'headline',
    props: {
      text: [
        { text: 'Hello ' },
        { text: '{{custom_values.name}}', bold: true, italic: true, color: '#aa0000' },
        { text: '\nA second line', underline: true, strike: true },
      ],
      level: 1,
    },
    style: {
      margin: { top: 8, bottom: 24 },
      padding: { left: 4, right: 4 },
      textColor: '#111827',
      fontFamily: 'Lexend',
      fontSize: 48,
      fontWeight: 700,
      lineHeight: 1.1,
      letterSpacing: -1,
      textAlign: 'center',
      textTransform: 'uppercase',
    },
    responsive: { tablet: { fontSize: 36 }, mobile: { fontSize: 28, textAlign: 'left' } },
    customClass: 'hero-title big',
  },
  sub_headline: {
    id: 'sh',
    type: 'sub_headline',
    props: { text: [{ text: 'Everything you need' }], level: 2 },
    hidden: { mobile: true },
  },
  paragraph: {
    id: 'p',
    type: 'paragraph',
    props: {
      text: [
        { text: 'Read ' },
        { text: 'more', link: { type: 'url', href: 'https://example.com/more', newTab: true } },
        { text: ', see ' },
        { text: 'the next step', link: { type: 'next_step' } },
        { text: ', ' },
        { text: 'the thanks page', link: { type: 'step', stepId: STEP } },
        { text: ', ' },
        { text: 'the offer', link: { type: 'popup', popupId: 'offer' } },
        { text: ' or ' },
        { text: 'the top', link: { type: 'anchor', sectionId: 'top' }, color: '#0000aa' },
        { text: '.' },
      ],
    },
  },
  bullet_list: {
    id: 'l',
    type: 'bullet_list',
    props: { items: [[{ text: 'One' }], [{ text: 'Two', bold: true }]], marker: 'check' },
  },
  image: {
    id: 'i',
    type: 'image',
    props: {
      src: 'https://img.example/team.png',
      alt: 'The team at work',
      action: { type: 'url', href: '/about', newTab: false },
      optimize: true,
      width: 1600,
      height: 900,
    },
    style: {
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: '#e5e7eb',
      borderRadius: 12,
      shadow: 'medium',
      width: { value: 100, unit: '%' },
      maxWidth: { value: 480, unit: 'px' },
      opacity: 0.9,
      align: 'center',
    },
  },
  video: {
    id: 'v',
    type: 'video',
    props: {
      source: 'youtube',
      url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
      autoplay: false,
      controls: true,
      muted: false,
      loop: true,
    },
  },
  button: {
    id: 'b',
    type: 'button',
    props: { label: 'Get started', subLabel: 'It takes a minute', action: { type: 'next_step' } },
    style: { backgroundColor: '#2563eb', textColor: '#ffffff', borderRadius: 8 },
  },
  divider: {
    id: 'd',
    type: 'divider',
    props: { thickness: 2, line: 'dashed', color: '#cccccc' },
  },
  form: { id: 'f', type: 'form', props: { formId: FORM } },
  calendar: { id: 'c', type: 'calendar', props: { calendarId: CALENDAR } },
  countdown: {
    id: 'cd',
    type: 'countdown',
    props: { endsAt: '2026-12-01T09:05:00.000Z', whenOver: { type: 'hide' } },
  },
  custom_code: {
    id: 'code',
    type: 'custom_code',
    props: { code: '<script>alert(1)</script>' },
  },
  container: {
    id: 'box',
    type: 'container',
    props: { direction: 'horizontal', gap: 8 },
    style: { minHeight: { value: 10, unit: 'vh' }, backgroundImageUrl: '/media/pattern.png' },
    children: [
      { id: 'inner', type: 'paragraph', props: { text: [{ text: 'In a box' }] } },
      {
        id: 'inner-box',
        type: 'container',
        props: { direction: 'vertical', gap: 0 },
        children: [
          { id: 'deep', type: 'button', props: { label: 'Stay', subLabel: '', action: none } },
        ],
      },
    ],
  },
};

const sectionOf = (id: string, children: PageElement[]): PageSection => ({
  id,
  type: 'section',
  props: { width: 'medium' },
  rows: [
    {
      id: `${id}-row`,
      type: 'row',
      columns: [{ id: `${id}-col`, type: 'column', props: { span: 12 }, children }],
    },
  ],
});

/** A page whose one section holds these elements. */
export const pageOf = (children: PageElement[]): VisualPageDocument => ({
  ...EMPTY_PAGE_DOCUMENT,
  sections: [sectionOf('top', children)],
});

/** A saved section, as `sites.saved_sections` holds one. */
export const SAVED: PageSection = sectionOf('saved', [
  {
    id: 'saved-text',
    type: 'paragraph',
    props: { text: [{ text: 'A footer every page shares.' }] },
  },
]);

/** One page with everything the format has: every element, every setting, a popup. */
export const EVERYTHING: VisualPageDocument = {
  format: 1,
  mode: 'visual',
  settings: {
    seo: {
      title: 'Spring offer for {{custom_values.name}}',
      description: 'Everything you need, in one place.',
      imageUrl: 'https://img.example/card.png',
      noIndex: false,
      canonicalUrl: 'https://www.example.com/spring',
      meta: [
        { name: 'author', content: 'Dana Brooks' },
        { name: 'og:locale', content: 'en_GB' },
        { name: 'robots', content: 'index, follow' },
      ],
    },
    background: {
      color: '#f8fafc',
      imageUrl: 'https://img.example/bg.png',
      size: 'cover',
      position: 'top',
      repeat: false,
    },
    typography: {
      headingFont: 'Lexend',
      bodyFont: 'Roboto',
      textColor: '#1f2937',
      linkColor: '#2563eb',
    },
    customCss: '.hero-title { text-shadow: 0 1px 0 #fff; }',
    headCode: '<script>window.tracked = true</script>',
    bodyCode: '<script>window.body = true</script>',
  },
  sections: [
    {
      ...sectionOf('top', []),
      name: 'Hero',
      style: { backgroundColor: '#ffffff', padding: { top: 64, bottom: 64 } },
      responsive: { mobile: { padding: { top: 24, bottom: 24 } } },
      hidden: { desktop: false, tablet: true },
      rows: [
        {
          id: 'top-row',
          type: 'row',
          columns: [
            {
              id: 'left',
              type: 'column',
              props: { span: 7 },
              children: [
                ELEMENTS.headline,
                ELEMENTS.sub_headline,
                ELEMENTS.paragraph,
                ELEMENTS.bullet_list,
                ELEMENTS.button,
                ELEMENTS.countdown,
              ],
            },
            {
              id: 'right',
              type: 'column',
              props: { span: 5 },
              children: [ELEMENTS.image, ELEMENTS.video, ELEMENTS.divider],
            },
          ],
        },
      ],
    },
    sectionOf('more', [
      ELEMENTS.form,
      ELEMENTS.calendar,
      ELEMENTS.custom_code,
      ELEMENTS.container,
      {
        id: 'clip',
        type: 'video',
        props: {
          source: 'file',
          url: 'https://media.example/clip.mp4',
          autoplay: true,
          controls: false,
          muted: true,
          loop: true,
        },
      },
      {
        id: 'vimeo',
        type: 'video',
        props: {
          source: 'vimeo',
          url: 'https://vimeo.com/76979871',
          autoplay: true,
          controls: false,
          muted: true,
          loop: true,
        },
      },
      {
        id: 'numbers',
        type: 'bullet_list',
        props: { items: [[{ text: 'First' }]], marker: 'number' },
      },
      {
        id: 'plain',
        type: 'bullet_list',
        props: { items: [[{ text: 'Unmarked' }]], marker: 'none' },
      },
      {
        id: 'second-image',
        type: 'image',
        props: { src: '/media/second.png', alt: '', action: none, optimize: false },
      },
    ]),
    { id: 'shared', type: 'saved_section', sectionId: SECTION },
  ],
  popups: [
    {
      id: 'offer',
      type: 'popup',
      name: 'Spring offer',
      props: { trigger: 'none', delaySeconds: 0, width: 'small' },
      style: { backgroundColor: '#fffbeb' },
      rows: [
        {
          id: 'offer-row',
          type: 'row',
          columns: [
            {
              id: 'offer-col',
              type: 'column',
              props: { span: 12 },
              children: [
                {
                  id: 'offer-title',
                  type: 'headline',
                  props: { text: [{ text: 'Ten percent off' }], level: 2 },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** The context of a published page of a funnel, on the install's own address. */
/** Where a server that has its small page scripts serves them: the digest is in the name. */
export const SCRIPTS = {
  arrival: '/s/_js/arrival.00112233aabbccdd.js',
  countdown: '/s/_js/countdown.0123456789abcdef.js',
  popup: '/s/_js/popup.fedcba9876543210.js',
} as const;

export const context = (over: Partial<RenderContext> = {}): RenderContext => ({
  siteBase: SITE_BASE,
  title: 'Landing Page',
  canonicalUrl: `https://crm.example${SITE_BASE}/landing`,
  faviconUrl: 'https://img.example/favicon.png',
  index: false,
  steps: new Map([[STEP, 'thanks']]),
  nextStepPath: 'offers/next',
  sections: new Map([[SECTION, SAVED]]),
  forms: new Map([[FORM, FORM_KEY]]),
  formScriptUrl: '/forms/embed.js',
  calendars: new Map([[CALENDAR, 'https://crm.example/book/acme/main/intro']]),
  mergeValues: new Map([['custom_values.name', 'Acme & Sons']]),
  scripts: SCRIPTS,
  now: Date.parse('2026-10-12T12:00:00.000Z'),
  // What a visitor is sent: only the base rules of what is on the page.
  baseRules: 'used',
  ...over,
});

export const asDocument = (document: VisualPageDocument): PageDocument => document;
