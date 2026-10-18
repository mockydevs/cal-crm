import {
  EMPTY_PAGE_DOCUMENT,
  pageElementTypes,
  type PageDocument,
  type PageSection,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { pageProblems, type PageFacts } from './checks.js';
import { sitePageElements } from './elements.js';
import { sitePublicStatus } from './public.js';

const STEP = 'sstp_01h455vb4pex5vsknk084sn02q';
const NEXT = 'sstp_01h455vb4pex5vsknk084sn02r';
const GONE = 'sstp_01h455vb4pex5vsknk084sn02s';
const SECTION = 'ssec_01h455vb4pex5vsknk084sn02q';
const FORM = 'form_01h455vb4pex5vsknk084sn02q';
const CALENDAR = 'cal_01h455vb4pex5vsknk084sn02q';

const none = { type: 'none' } as const;
const sectionOf = (children: unknown[]): PageSection =>
  ({
    id: 'top',
    type: 'section',
    props: { width: 'full' },
    rows: [
      {
        id: 'row',
        type: 'row',
        columns: [{ id: 'col', type: 'column', props: { span: 12 }, children }],
      },
    ],
  }) as PageSection;
const page = (children: unknown[], over: Record<string, unknown> = {}): PageDocument => ({
  ...EMPTY_PAGE_DOCUMENT,
  sections: [sectionOf(children)],
  ...over,
});
const text = { id: 'p', type: 'paragraph', props: { text: [{ text: 'Hello' }] } };

const facts = (over: Partial<PageFacts> = {}): PageFacts => ({
  kind: 'funnel',
  role: 'control',
  steps: new Map([
    [STEP, { name: 'Landing', path: 'landing', published: true }],
    [NEXT, { name: 'Thank you', path: 'thanks', published: true }],
  ]),
  nextStepId: NEXT,
  sections: new Map(),
  forms: new Map([[FORM, { key: 'k'.repeat(32), published: true }]]),
  calendars: new Map([[CALENDAR, { path: '/book/acme/main/intro', bookable: true }]]),
  mergeValues: new Map([['custom_values.name', 'Acme']]),
  scripts: { countdown: true, popup: true },
  ...over,
});
const SCRIPTS = { countdown: '/s/_js/countdown.0.js', popup: '/s/_js/popup.0.js' };
const codes = (document: PageDocument, given: PageFacts = facts()) =>
  pageProblems(document, given).map((each) => `${each.blocking ? 'block' : 'warn'}:${each.code}`);

describe('pageProblems', () => {
  it('finds nothing wrong with a page of plain content', () => {
    expect(pageProblems(page([text]), facts())).toEqual([]);
  });

  it('refuses an empty page, a code page and a saved section that is gone', () => {
    expect(codes(EMPTY_PAGE_DOCUMENT)).toEqual(['block:empty_page']);
    expect(codes(page([]))).toEqual(['block:empty_page']);
    expect(
      pageProblems(
        {
          format: 1,
          mode: 'code',
          settings: { seo: EMPTY_PAGE_DOCUMENT.settings.seo },
          files: [{ path: 'index.html', kind: 'text', content: '' }],
        },
        facts(),
      ),
    ).toEqual([
      {
        code: 'code_page',
        message: 'Code pages cannot be published yet. Publish a page made in the visual builder.',
        nodeId: null,
        blocking: true,
      },
    ]);
    const referring = {
      ...EMPTY_PAGE_DOCUMENT,
      sections: [{ id: 'shared', type: 'saved_section' as const, sectionId: SECTION }],
    };
    expect(pageProblems(referring, facts())).toEqual([
      {
        code: 'missing_section',
        message: 'A saved section this page uses was deleted. Remove it from the page.',
        nodeId: 'shared',
        blocking: true,
      },
      expect.objectContaining({ code: 'empty_page' }),
    ]);
    // A saved section that is there counts as the page's content.
    expect(codes(referring, facts({ sections: new Map([[SECTION, sectionOf([text])]]) }))).toEqual(
      [],
    );
  });

  it('refuses an image with no picture, and one that is a link with no alternative text', () => {
    const image = (props: Record<string, unknown>) => ({
      id: 'i',
      type: 'image',
      props: { src: 'https://img.example/a.png', alt: '', action: none, optimize: true, ...props },
    });
    expect(codes(page([image({})]))).toEqual([]);
    expect(codes(page([image({ src: null })]))).toEqual(['block:image_missing']);
    const linked = { type: 'url', href: '/about', newTab: false };
    expect(codes(page([image({ action: linked, alt: '  ' })]))).toEqual(['block:image_alt']);
    expect(codes(page([image({ action: linked, alt: 'About us' })]))).toEqual([]);
  });

  it('refuses a video with no address or one that is not the player’s', () => {
    const video = (source: string, url: string | null) => ({
      id: 'v',
      type: 'video',
      props: { source, url, autoplay: false, controls: true, muted: false, loop: false },
    });
    expect(codes(page([video('youtube', null)]))).toEqual(['block:video_missing']);
    expect(pageProblems(page([video('youtube', 'https://example.com/x')]), facts())).toEqual([
      expect.objectContaining({
        code: 'video_address',
        message:
          'A video’s address is not a YouTube video. Paste the address of the video’s own page.',
        nodeId: 'v',
      }),
    ]);
    expect(pageProblems(page([video('vimeo', 'https://example.com/x')]), facts())).toEqual([
      expect.objectContaining({
        message:
          'A video’s address is not a Vimeo video. Paste the address of the video’s own page.',
      }),
    ]);
    expect(codes(page([video('youtube', 'https://youtu.be/M7lc1UVf-VE')]))).toEqual([]);
    expect(codes(page([video('file', 'https://media.example/a.mp4')]))).toEqual([]);
  });

  it('refuses a form that is not chosen, gone, not published or cannot be shown here', () => {
    const form = (formId: string | null) => ({ id: 'f', type: 'form', props: { formId } });
    expect(codes(page([form(FORM)]))).toEqual([]);
    expect(codes(page([form(null)]))).toEqual(['block:form_missing']);
    expect(codes(page([form(FORM)]), facts({ forms: new Map() }))).toEqual(['block:form_gone']);
    expect(
      codes(
        page([form(FORM)]),
        facts({ forms: new Map([[FORM, { key: 'k'.repeat(32), published: false }]]) }),
      ),
    ).toEqual(['block:form_unpublished']);
    expect(codes(page([form(FORM)]), facts({ forms: undefined }))).toEqual([
      'block:form_unavailable',
    ]);
  });

  it('refuses a calendar that is not chosen, gone, not bookable or cannot be linked to here', () => {
    const calendar = (calendarId: string | null) => ({
      id: 'c',
      type: 'calendar',
      props: { calendarId },
    });
    expect(codes(page([calendar(CALENDAR)]))).toEqual([]);
    expect(codes(page([calendar(null)]))).toEqual(['block:calendar_missing']);
    expect(codes(page([calendar(CALENDAR)]), facts({ calendars: new Map() }))).toEqual([
      'block:calendar_gone',
    ]);
    expect(
      pageProblems(
        page([calendar(CALENDAR)]),
        facts({ calendars: new Map([[CALENDAR, { path: '/book/a/b/c', bookable: false }]]) }),
      ),
    ).toEqual([
      {
        code: 'calendar_inactive',
        message:
          'The calendar on this page cannot be booked yet. Switch it on in Calendars, with someone to book and a mailbox for confirmations, then publish.',
        nodeId: 'c',
        blocking: true,
      },
    ]);
    expect(codes(page([calendar(CALENDAR)]), facts({ calendars: undefined }))).toEqual([
      'block:calendar_unavailable',
    ]);
    // Never the old refusal: a calendar is published as a link to its booking page.
    expect(codes(page([calendar(CALENDAR)]))).not.toContain('block:calendar_unsupported');
  });

  it('refuses a countdown with no end, and warns that one stays still only without its script', () => {
    const countdown = (endsAt: string | null) => ({
      id: 'cd',
      type: 'countdown',
      props: { endsAt, whenOver: { type: 'hide' } },
    });
    expect(codes(page([countdown(null)]))).toEqual(['block:countdown_missing']);
    expect(codes(page([countdown('2026-12-01T00:00:00.000Z')]))).toEqual([]);
    expect(
      codes(
        page([countdown('2026-12-01T00:00:00.000Z')]),
        facts({ scripts: { countdown: false, popup: true } }),
      ),
    ).toEqual(['warn:countdown_static']);
    expect(
      codes(page([text, { id: 'x', type: 'custom_code', props: { code: '<b>hi</b>' } }])),
    ).toEqual(['warn:custom_code_hidden']);
  });

  it('refuses a link to a step that is gone, and warns about one that is not published', () => {
    const button = (action: unknown) => ({
      id: 'b',
      type: 'button',
      props: { label: 'Go', subLabel: '', action },
    });
    const step = (stepId: string) => ({ type: 'step', stepId });
    expect(codes(page([button(step(NEXT))]))).toEqual([]);
    expect(codes(page([button(step(GONE))]))).toEqual(['block:missing_step']);
    const draft = facts({
      steps: new Map([
        [STEP, { name: 'Landing', path: 'landing', published: true }],
        [NEXT, { name: 'Thank you', path: 'thanks', published: false }],
      ]),
    });
    expect(pageProblems(page([button(step(NEXT))]), draft)).toEqual([
      {
        code: 'unpublished_step',
        message:
          'A link goes to “Thank you”, which is not published yet. Visitors cannot follow it until it is.',
        nodeId: 'b',
        blocking: false,
      },
    ]);
    expect(codes(page([button({ type: 'next_step' })]))).toEqual([]);
    expect(codes(page([button({ type: 'next_step' })]), draft)).toEqual(['warn:unpublished_step']);
    expect(
      pageProblems(page([button({ type: 'next_step' })]), facts({ nextStepId: undefined })),
    ).toEqual([
      expect.objectContaining({
        code: 'no_next_step',
        message: 'A link goes to the next step, but this is the last step of the funnel.',
        blocking: true,
      }),
    ]);
    expect(
      pageProblems(
        page([button({ type: 'next_step' })]),
        facts({ kind: 'website', nextStepId: undefined }),
      ),
    ).toEqual([
      expect.objectContaining({
        message:
          'A link goes to the next step, but a website’s pages have no order. Link to a page instead.',
      }),
    ]);
  });

  it('reads the links in text, lists and images, and says each problem once for an element', () => {
    const gone = { type: 'step', stepId: GONE };
    const linked = [{ text: 'a', link: gone }, { text: 'b', link: gone }, { text: 'c' }];
    const elements = [
      { id: 'h', type: 'headline', props: { text: linked, level: 1 } },
      { id: 's', type: 'sub_headline', props: { text: linked, level: 2 } },
      { id: 'p', type: 'paragraph', props: { text: linked } },
      { id: 'l', type: 'bullet_list', props: { items: [linked, linked], marker: 'disc' } },
      {
        id: 'i',
        type: 'image',
        props: { src: 'https://img.example/a.png', alt: 'A', action: gone, optimize: true },
      },
      {
        id: 'k',
        type: 'container',
        props: { direction: 'vertical', gap: 0 },
        children: [
          { id: 'd', type: 'divider', props: { thickness: 1, line: 'solid', color: null } },
        ],
      },
    ];
    expect(pageProblems(page(elements), facts()).map((each) => each.nodeId)).toEqual([
      'h',
      's',
      'p',
      'l',
      'i',
    ]);
  });

  it('warns about what a published page does not do yet, after what blocks it', () => {
    const document = page(
      [{ id: 'p', type: 'paragraph', props: { text: [{ text: 'Hi {{custom_values.name}}' }] } }],
      {
        settings: { ...EMPTY_PAGE_DOCUMENT.settings, headCode: '<script></script>' },
        popups: [
          {
            id: 'later',
            type: 'popup',
            name: 'Later',
            props: { trigger: 'delay', delaySeconds: 5, width: 'small' },
            rows: [],
          },
          {
            id: 'asked',
            type: 'popup',
            name: 'Asked',
            props: { trigger: 'none', delaySeconds: 0, width: 'small' },
            rows: [],
          },
        ],
      },
    );
    // A popup opens by itself and a merge field with a value is filled in: neither is a
    // problem any more.
    expect(codes(document, facts({ role: 'variation' }))).toEqual([
      'warn:page_code_hidden',
      'warn:variation_not_served',
    ]);
    expect(
      codes(
        document,
        facts({
          role: 'variation',
          scripts: { countdown: true, popup: false },
          mergeValues: new Map(),
        }),
      ),
    ).toEqual([
      'warn:popup_trigger',
      'warn:page_code_hidden',
      'warn:merge_fields',
      'warn:variation_not_served',
    ]);
    const withBody = page(
      [
        text,
        { id: 'i', type: 'image', props: { src: null, alt: '', action: none, optimize: true } },
      ],
      {
        settings: { ...EMPTY_PAGE_DOCUMENT.settings, bodyCode: 'x' },
      },
    );
    expect(codes(withBody)).toEqual(['block:image_missing', 'warn:page_code_hidden']);
  });

  it('names the merge fields that have no value, on the page and in its saved sections', () => {
    const words = (id: string, value: string) => ({
      id,
      type: 'paragraph',
      props: { text: [{ text: value }] },
    });
    const merge = (document: PageDocument, given = facts()) =>
      pageProblems(document, given).find((each) => each.code === 'merge_fields');
    expect(merge(page([words('a', 'Hi {{custom_values.name}}')]))).toBeUndefined();
    expect(
      merge(page([words('a', 'Hi {{custom_values.name}}, call {{custom_values.phone}}')])),
    ).toEqual({
      code: 'merge_fields',
      message:
        'These merge fields have no value, so they show as nothing: {{custom_values.phone}}. A page fills in the business’s custom values (Settings, Custom values); a contact’s details are not known on a page.',
      nodeId: null,
      blocking: false,
    });
    // Each once, in order, and no more than five by name.
    const many = page([
      words(
        'a',
        '{{contact.first_name}} {{contact.first_name}} {{b}} {{c}} {{d}} {{e}} {{f}} {{g}}',
      ),
    ]);
    expect(merge(many)?.message).toContain(
      'nothing: {{b}}, {{c}}, {{contact.first_name}}, {{d}}, {{e}} and 2 more.',
    );
    const referring = {
      ...EMPTY_PAGE_DOCUMENT,
      sections: [{ id: 'shared', type: 'saved_section' as const, sectionId: SECTION }],
    };
    expect(
      merge(
        referring,
        facts({
          sections: new Map([[SECTION, sectionOf([words('s', '{{custom_values.hours}}')])]]),
        }),
      )?.message,
    ).toContain('{{custom_values.hours}}');
  });
});

describe('the element list', () => {
  it('says how every element type of the format is shown', () => {
    const elements = sitePageElements(SCRIPTS);
    expect(elements.map((each) => each.type)).toEqual([...pageElementTypes]);
    expect(elements.find((each) => each.type === 'custom_code')).toMatchObject({
      rendering: 'connected_domain',
      script: true,
    });
    expect(elements.filter((each) => each.script).map((each) => each.type)).toEqual([
      'form',
      'countdown',
      'custom_code',
    ]);
  });

  it('says a countdown ticks only where the install has its script, and a calendar is a link', () => {
    const note = (scripts: Parameters<typeof sitePageElements>[0], type: string) =>
      sitePageElements(scripts).find((each) => each.type === type);
    expect(note(SCRIPTS, 'countdown')?.note).toContain('Counts down each second');
    expect(note(SCRIPTS, 'countdown')?.note).not.toMatch(/does not|not count/);
    for (const without of [undefined, {}, { popup: SCRIPTS.popup }]) {
      expect(note(without, 'countdown')).toMatchObject({ script: false });
      expect(note(without, 'countdown')?.note).toContain('built without the script');
    }
    expect(note(SCRIPTS, 'calendar')?.note).toContain('A link to the calendar’s own booking page');
    expect(note(SCRIPTS, 'calendar')?.note).not.toContain('cannot be published');
  });
});

describe('whether the install serves public pages', () => {
  it('says so with where sites answer, and which small scripts it has', () => {
    expect(sitePublicStatus({ publicUrl: 'https://crm.example', scripts: SCRIPTS })).toEqual({
      enabled: true,
      code: 'enabled',
      reason: null,
      baseUrl: 'https://crm.example/s',
      scripts: { countdown: true, popup: true },
    });
    expect(
      sitePublicStatus({ publicUrl: 'https://crm.example', scripts: { popup: SCRIPTS.popup } })
        .scripts,
    ).toEqual({ countdown: false, popup: true });
    expect(sitePublicStatus({ publicUrl: 'https://crm.example' }).scripts).toEqual({
      countdown: false,
      popup: false,
    });
  });

  it('says why not, in a sentence, on an install with no public address', () => {
    const off = sitePublicStatus({ publicUrl: undefined, scripts: SCRIPTS });
    expect(off).toMatchObject({
      enabled: false,
      code: 'no_public_secret',
      baseUrl: null,
      scripts: { countdown: false, popup: false },
    });
    expect(off.reason).toContain('Public pages are switched off on this install');
    expect(off.reason).toContain('PUBLIC_INTAKE_SECRET');
  });
});
