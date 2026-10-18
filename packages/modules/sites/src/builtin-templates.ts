// The templates that ship with the product. They are ours: written for this project, with
// made-up content, and nothing of another product's library. They are code rather than
// rows, with ids that never change, and a unit test holds each to the page document's
// schema, so a change of format cannot leave one behind. What a business must fill in is
// named by merge fields ({{custom_values.…}}), which every copy keeps.
import {
  EMPTY_PAGE_DOCUMENT,
  type PageDocument,
  type PageElement,
  type PageSection,
  type PageStyle,
  type SiteTemplateContent,
  type SiteTemplateKind,
} from '@repo/contracts';
import { toPublicId } from '@repo/kernel';

export interface BuiltInTemplate {
  /** A fixed UUIDv7: the template's id for good. */
  readonly id: string;
  readonly kind: SiteTemplateKind;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly pageType: string;
  readonly tags: readonly string[];
  readonly colors: readonly string[];
  readonly content: SiteTemplateContent;
}

const INK = '#111827';
const MUTED = '#4b5563';
const PAPER = '#ffffff';
const MIST = '#f3f4f6';
const BRAND = '#2563eb';

const text = (value: string) => [{ text: value }];

const headline = (id: string, value: string, style: PageStyle = {}): PageElement => ({
  id,
  type: 'headline',
  props: { text: text(value), level: 1 },
  style: { fontSize: 44, fontWeight: 700, textColor: INK, textAlign: 'center', ...style },
  responsive: { mobile: { fontSize: 30 } },
});
const subHeadline = (id: string, value: string, style: PageStyle = {}): PageElement => ({
  id,
  type: 'sub_headline',
  props: { text: text(value), level: 2 },
  style: { fontSize: 22, fontWeight: 500, textColor: MUTED, textAlign: 'center', ...style },
  responsive: { mobile: { fontSize: 18 } },
});
const paragraph = (id: string, value: string, style: PageStyle = {}): PageElement => ({
  id,
  type: 'paragraph',
  props: { text: text(value) },
  style: { fontSize: 17, lineHeight: 1.6, textColor: MUTED, textAlign: 'center', ...style },
});
const bullets = (id: string, items: readonly string[]): PageElement => ({
  id,
  type: 'bullet_list',
  props: { items: items.map(text), marker: 'check' },
  style: { fontSize: 17, lineHeight: 1.7, textColor: INK },
});
const button = (
  id: string,
  label: string,
  action: Extract<PageElement, { type: 'button' }>['props']['action'],
): PageElement => ({
  id,
  type: 'button',
  props: { label, subLabel: '', action },
  style: {
    backgroundColor: BRAND,
    textColor: PAPER,
    fontSize: 18,
    fontWeight: 600,
    borderRadius: 8,
    padding: { top: 14, right: 28, bottom: 14, left: 28 },
    align: 'center',
  },
  responsive: { mobile: { width: { value: 100, unit: '%' } } },
});
const form = (id: string): PageElement => ({ id, type: 'form', props: { formId: null } });
const divider = (id: string): PageElement => ({
  id,
  type: 'divider',
  props: { thickness: 1, line: 'solid', color: '#e5e7eb' },
});

/** A section of one row, its columns sharing the row as the spans say. */
const section = (
  id: string,
  name: string,
  columns: readonly { span: number; children: PageElement[] }[],
  style: PageStyle = {},
): PageSection => ({
  id,
  type: 'section',
  name,
  props: { width: 'medium' },
  style: {
    padding: { top: 72, right: 24, bottom: 72, left: 24 },
    backgroundColor: PAPER,
    ...style,
  },
  responsive: { mobile: { padding: { top: 40, right: 16, bottom: 40, left: 16 } } },
  rows: [
    {
      id: `${id}-row`,
      type: 'row',
      columns: columns.map((column, index) => ({
        id: `${id}-col-${String(index + 1)}`,
        type: 'column',
        props: { span: column.span },
        children: column.children,
      })),
    },
  ],
});

const page = (title: string, description: string, sections: PageSection[]): PageDocument => ({
  ...EMPTY_PAGE_DOCUMENT,
  settings: {
    ...EMPTY_PAGE_DOCUMENT.settings,
    seo: { ...EMPTY_PAGE_DOCUMENT.settings.seo, title, description },
    typography: { headingFont: 'Inter', bodyFont: 'Inter', textColor: INK, linkColor: BRAND },
  },
  sections,
});

const footer = (id: string): PageSection =>
  section(
    id,
    'Footer',
    [
      {
        span: 12,
        children: [
          divider(`${id}-line`),
          paragraph(
            `${id}-text`,
            '{{custom_values.business_name}} · {{custom_values.business_phone}} · {{custom_values.business_email}}',
            { fontSize: 14 },
          ),
        ],
      },
    ],
    { padding: { top: 24, right: 24, bottom: 32, left: 24 } },
  );

const leadCapture = (thanksStep?: string): PageDocument =>
  page('Get your free guide', 'Leave your details and we will send the guide straight away.', [
    section('hero', 'Hero', [
      {
        span: 7,
        children: [
          headline('hero-title', 'A clear plan for your next project', { textAlign: 'left' }),
          subHeadline(
            'hero-sub',
            'A short guide from {{custom_values.business_name}}: what to decide first, what it costs and how long it takes.',
            { textAlign: 'left' },
          ),
          bullets('hero-points', [
            'The five questions to answer before you start',
            'A simple way to set a budget you can keep',
            'A checklist you can print and use today',
          ]),
        ],
      },
      {
        span: 5,
        children: [
          subHeadline('form-title', 'Send me the guide', { fontSize: 20, textColor: INK }),
          form('lead-form'),
          ...(thanksStep === undefined
            ? []
            : [button('form-skip', 'I have it already', { type: 'step', stepId: thanksStep })]),
          paragraph('form-note', 'No spam. Unsubscribe at any time.', { fontSize: 13 }),
        ],
      },
    ]),
    section(
      'proof',
      'Why us',
      [
        {
          span: 4,
          children: [
            subHeadline('proof-1-title', 'Plain answers', { textColor: INK }),
            paragraph('proof-1-text', 'No jargon and no pressure: what we would tell a friend.'),
          ],
        },
        {
          span: 4,
          children: [
            subHeadline('proof-2-title', 'Local team', { textColor: INK }),
            paragraph('proof-2-text', 'You talk to the people who do the work.'),
          ],
        },
        {
          span: 4,
          children: [
            subHeadline('proof-3-title', 'Fixed quotes', { textColor: INK }),
            paragraph('proof-3-text', 'You know the price before anything starts.'),
          ],
        },
      ],
      { backgroundColor: MIST },
    ),
    footer('footer'),
  ]);

const comingSoon = (): PageDocument =>
  page('Coming soon', 'Something new from us is on its way.', [
    section(
      'soon',
      'Coming soon',
      [
        {
          span: 12,
          children: [
            headline('soon-title', 'Something new is on its way'),
            subHeadline(
              'soon-sub',
              '{{custom_values.business_name}} is getting ready. Leave your email and be the first to hear.',
            ),
            {
              id: 'soon-clock',
              type: 'countdown',
              props: { endsAt: null, whenOver: { type: 'text', text: 'We are open.' } },
              style: { fontSize: 32, fontWeight: 700, textColor: BRAND, textAlign: 'center' },
            },
            form('soon-form'),
          ],
        },
      ],
      { padding: { top: 120, right: 24, bottom: 120, left: 24 } },
    ),
    footer('footer'),
  ]);

const thankYou = (): PageDocument =>
  page('Thank you', 'We have your details and will be in touch.', [
    section('thanks', 'Thank you', [
      {
        span: 12,
        children: [
          headline('thanks-title', 'Thank you. It is on its way.'),
          subHeadline(
            'thanks-sub',
            'Check your inbox in the next few minutes. If nothing arrives, look in your spam folder.',
          ),
          paragraph(
            'thanks-text',
            'Want to talk it through? Call {{custom_values.business_phone}} or choose a time below.',
          ),
          { id: 'thanks-calendar', type: 'calendar', props: { calendarId: null } },
          button('thanks-home', 'Back to our website', {
            type: 'url',
            href: '{{custom_values.website_url}}',
            newTab: false,
          }),
        ],
      },
    ]),
    footer('footer'),
  ]);

const id = (tail: number): string => `0192f000-0000-7000-8000-${String(tail).padStart(12, '0')}`;
const LEAD_STEP = toPublicId('site_step', id(101));
const THANKS_STEP = toPublicId('site_step', id(102));

/** Every template the product ships, in the order the library lists them. */
export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
  {
    id: id(1),
    kind: 'step',
    name: 'Lead capture landing page',
    description:
      'A landing page with a headline, three reasons and a form beside them, for a guide, a quote or a call back.',
    category: 'Business',
    pageType: 'Lead capture',
    tags: ['lead', 'form', 'landing page'],
    colors: [BRAND, INK, MIST],
    content: { kind: 'step', document: leadCapture(), sections: [] },
  },
  {
    id: id(2),
    kind: 'step',
    name: 'Coming soon',
    description:
      'One screen with a countdown and an email form, for a launch that is not open yet.',
    category: 'Business',
    pageType: 'Coming Soon',
    tags: ['launch', 'countdown'],
    colors: [BRAND, INK],
    content: { kind: 'step', document: comingSoon(), sections: [] },
  },
  {
    id: id(3),
    kind: 'step',
    name: 'Thank you page',
    description: 'What a visitor sees after a form: what happens next, a calendar and a way back.',
    category: 'Business',
    pageType: 'Thank You',
    tags: ['thank you', 'booking'],
    colors: [BRAND, INK],
    content: { kind: 'step', document: thankYou(), sections: [] },
  },
  {
    id: id(4),
    kind: 'funnel',
    name: 'Two-step lead funnel',
    description:
      'A lead capture page that leads to a thank-you page with a calendar: the shortest funnel that works.',
    category: 'Business',
    pageType: 'Lead capture',
    tags: ['lead', 'funnel', 'booking'],
    colors: [BRAND, INK, MIST],
    content: {
      kind: 'funnel',
      steps: [
        { id: LEAD_STEP, name: 'Landing Page', path: 'start', document: leadCapture(THANKS_STEP) },
        { id: THANKS_STEP, name: 'Thank You', path: 'thank-you', document: thankYou() },
      ],
      sections: [],
    },
  },
  {
    id: id(5),
    kind: 'website',
    name: 'Simple business website',
    description: 'A home page and a contact page, to start a small website from.',
    category: 'Business',
    pageType: 'About',
    tags: ['website', 'contact'],
    colors: [BRAND, INK, MIST],
    content: {
      kind: 'website',
      steps: [
        {
          id: toPublicId('site_step', id(103)),
          name: 'Home',
          path: 'home',
          document: leadCapture(),
        },
        {
          id: toPublicId('site_step', id(104)),
          name: 'Thank You',
          path: 'thank-you',
          document: thankYou(),
        },
      ],
      sections: [],
    },
  },
  {
    id: id(6),
    kind: 'section',
    name: 'Footer with contact details',
    description: 'A thin footer with the business name, phone and email from custom values.',
    category: 'Business',
    pageType: 'Footer',
    tags: ['footer'],
    colors: [INK],
    content: { kind: 'section', section: footer('footer') },
  },
];

const BY_ID: ReadonlyMap<string, BuiltInTemplate> = new Map(
  BUILT_IN_TEMPLATES.map((template) => [template.id, template]),
);

/** The built-in template with this UUID, if it is one. */
export const builtInTemplate = (uuid: string): BuiltInTemplate | undefined => BY_ID.get(uuid);
