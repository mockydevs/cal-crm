// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  EMPTY_PAGE_DOCUMENT,
  type PageElement,
  type PageText,
  type VisualPageDocument,
} from '@repo/contracts';
import { renderPage, type RenderContext } from '@repo/site-render';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BulletListView,
  ButtonView,
  CalendarView,
  CanvasCalendarsContext,
  CanvasCountdownContext,
  CanvasFormsContext,
  ColumnView,
  ContainerView,
  CountdownView,
  CustomCodeView,
  DividerView,
  FormView,
  HeadingView,
  ImageView,
  PageView,
  ParagraphView,
  PopupView,
  RowView,
  SavedSectionView,
  SectionView,
  VideoView,
  ZoneStoreContext,
  type SlotView,
} from './elements';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const CALENDAR_ID = 'cal_01h455vb4pex5vsknk084sn02q';

const context: RenderContext = {
  siteBase: '',
  title: 'Test',
  index: false,
  preview: true,
  steps: new Map([['sstp_01h455vb4pex5vsknk084sn02q', 'thanks']]),
  nextStepPath: 'thanks',
  sections: new Map(),
  forms: new Map(),
  formScriptUrl: '',
  calendars: new Map([[CALENDAR_ID, 'https://crm.example/book/acme/harbor/intro']]),
  // A merge field is shown in the editor as it is written.
  mergeValues: new Map([['contact.first_name', '{{contact.first_name}}']]),
  now: Date.parse('2026-01-01T00:00:00.000Z'),
  // What a visitor is sent: the flat markup with only the rules the page uses.
  baseRules: 'used',
};

/** The markup the published page's renderer writes for one element, alone in a column. */
function published(element: PageElement): string {
  const page: VisualPageDocument = {
    ...EMPTY_PAGE_DOCUMENT,
    sections: [
      { id: 'anchor', type: 'section', props: { width: 'full' }, rows: [] },
      {
        id: 's',
        type: 'section',
        props: { width: 'full' },
        rows: [
          {
            id: 'r',
            type: 'row',
            columns: [{ id: 'c', type: 'column', props: { span: 12 }, children: [element] }],
          },
        ],
      },
    ],
    popups: [
      {
        id: 'pop',
        type: 'popup',
        name: 'Popup',
        props: { trigger: 'none', delaySeconds: 0, width: 'small' },
        rows: [],
      },
    ],
  };
  const html = renderPage(page, context)?.html ?? '';
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return parsed.querySelectorAll('.cl')[0]?.innerHTML ?? '';
}

afterEach(cleanup);

/** The markup a view draws, as the browser holds it. */
const drawn = (view: ReactElement): string =>
  render(<I18nProvider i18n={i18n}>{view}</I18nProvider>).container.innerHTML;

/**
 * Markup as a tree of plain values, with what differs on purpose taken out: a link's
 * address and the id a link on the page jumps to (nothing in the canvas navigates), when a
 * picture is fetched, and the classes a
 * node's own rules are written for. The page names those `e1`, `e2`, … and gives one only
 * to a node that has rules; the canvas names every node's `n_<id>`. What the rules say is
 * compared in node-css.test.ts.
 */
function shape(html: string): unknown {
  const kept = (token: string): boolean => !/^(?:e\d+|n_.+)$/.test(token);
  const read = (node: Node): unknown => {
    if (node.nodeType === 3) return node.textContent;
    if (!(node instanceof Element)) return null;
    const attributes = [...node.attributes]
      .filter(
        ({ name }) =>
          !['href', 'target', 'rel', 'loading', 'fetchpriority', 'id'].includes(name) &&
          // What a countdown does at its end, written for the page's own script.
          !name.startsWith('data-cd'),
      )
      .map(({ name, value }) => [
        name,
        name === 'class' ? value.split(' ').filter(kept).join(' ') : value,
      ])
      .filter(([name, value]) => name !== 'class' || value !== '')
      .sort(([one = ''], [other = '']) => one.localeCompare(other));
    return [node.tagName.toLowerCase(), attributes, [...node.childNodes].map(read)];
  };
  const holder = document.createElement('div');
  holder.innerHTML = html;
  // The canvas's own tag on a countdown (`ep-tag`: "Sample: …") is not the page's, and the
  // space before it is not either.
  for (const tag of [...holder.querySelectorAll('.ep-tag')]) {
    const before = tag.previousSibling;
    if (before?.nodeType === 3 && before.textContent === ' ') before.remove();
    tag.remove();
  }
  return [...holder.childNodes].map(read);
}

const text: PageText = [
  { text: 'Plain, ' },
  { text: 'bold and italic', bold: true, italic: true },
  { text: ' underlined', underline: true, strike: true },
  { text: ' red', color: '#ff0000' },
  { text: ' a link', link: { type: 'url', href: 'https://example.com/terms', newTab: true } },
  { text: ' a red link', color: '#00ff00', link: { type: 'next_step' } },
  { text: '' },
  { text: 'two\nlines for {{contact.first_name}} & <others>' },
];
const none = { type: 'none' } as const;

describe('the canvas draws an element with the published page’s own markup', () => {
  it('headlines and sub-headlines, at every level, with every look a run may have', () => {
    for (const kind of ['headline', 'sub_headline'] as const)
      for (const level of [1, 2, 6]) {
        const element: PageElement = {
          id: 'a',
          type: kind,
          props: { text, level },
          customClass: 'offer big',
        };
        expect(
          shape(
            drawn(
              <HeadingView
                id="a"
                look={{ customClass: 'offer big' }}
                kind={kind}
                text={text}
                level={level}
              />,
            ),
          ),
          `${kind} ${String(level)}`,
        ).toStrictEqual(shape(published(element)));
      }
    // A level the document could not hold is drawn as the renderer would draw it.
    expect(drawn(<HeadingView id="a" look={{}} kind="headline" text={[]} level={9} />)).toBe(
      '<h6 class="hl n_a"></h6>',
    );
    expect(
      drawn(
        <HeadingView id="a" look={undefined} kind="headline" text={undefined} level={undefined} />,
      ),
    ).toBe('<h2 class="hl n_a"></h2>');
  });

  it('paragraphs', () => {
    const element: PageElement = { id: 'a', type: 'paragraph', props: { text } };
    expect(shape(drawn(<ParagraphView id="a" look={{}} text={text} />))).toStrictEqual(
      shape(published(element)),
    );
  });

  it('bullet lists, with each marker', () => {
    const items = [text, [{ text: 'Second' }]];
    for (const marker of ['disc', 'number', 'check', 'none'] as const) {
      const element: PageElement = { id: 'a', type: 'bullet_list', props: { items, marker } };
      expect(
        shape(drawn(<BulletListView id="a" look={{}} items={items} marker={marker} />)),
        marker,
      ).toStrictEqual(shape(published(element)));
    }
    expect(drawn(<BulletListView id="a" look={{}} items={undefined} marker={undefined} />)).toBe(
      '<ul class="ls n_a"></ul>',
    );
  });

  it('images, alone and as links', () => {
    const src = 'https://example.com/a.png';
    for (const action of [
      none,
      { type: 'url', href: 'https://example.com', newTab: false },
    ] as const) {
      const element: PageElement = {
        id: 'a',
        type: 'image',
        props: { src, alt: 'A harbour', action, optimize: true },
      };
      expect(
        shape(drawn(<ImageView id="a" look={{}} src={src} alt="A harbour" action={action} />)),
        action.type,
      ).toStrictEqual(shape(published(element)));
    }
  });

  it('buttons, with and without a second line and somewhere to go', () => {
    for (const subLabel of ['', 'Step two'])
      for (const action of [none, { type: 'next_step' }] as const) {
        const element: PageElement = {
          id: 'a',
          type: 'button',
          props: { label: 'Go & see', subLabel, action },
        };
        expect(
          shape(
            drawn(
              <ButtonView id="a" look={{}} label="Go & see" subLabel={subLabel} action={action} />,
            ),
          ),
          `${subLabel} ${action.type}`,
        ).toStrictEqual(shape(published(element)));
      }
  });

  it('dividers', () => {
    const element: PageElement = {
      id: 'a',
      type: 'divider',
      props: { thickness: 2, line: 'dashed', color: null },
    };
    expect(shape(drawn(<DividerView id="a" look={{}} />))).toStrictEqual(shape(published(element)));
  });

  it('a countdown that is still running, and the line it leaves when it is over', () => {
    // Both draw the time left as it is "now": the canvas reads the clock, the page is told.
    vi.useFakeTimers({ now: context.now });
    const endsAt = '2026-01-03T03:14:30.000Z';
    const running: PageElement = {
      id: 'a',
      type: 'countdown',
      props: { endsAt, whenOver: { type: 'hide' } },
    };
    const sample = drawn(
      <CountdownView id="a" look={{}} endsAt={endsAt} whenOver={{ type: 'hide' }} />,
    );
    vi.useRealTimers();
    expect(shape(sample)).toStrictEqual(shape(published(running)));
    // The page's own markup and words, and one tag that says the time left is a sample.
    expect(sample).toBe(
      '<p class="cd n_a"><span role="timer">2d 03h 14m</span> left, ends ' +
        '<time datetime="2026-01-03T03:14:30.000Z">3 January 2026, 03:14 UTC</time> ' +
        '<span class="ep-tag">Sample: on the page it counts down</span></p>',
    );
    expect(
      drawn(
        <CanvasCountdownContext value={false}>
          <CountdownView id="a" look={{}} endsAt="2999-12-01T09:05:00.000Z" whenOver={undefined} />
        </CanvasCountdownContext>,
      ),
    ).toContain('Sample: on the page it is brought up to date when the page is loaded');
    const past = '2001-01-01T00:00:00.000Z';
    const over: PageElement = {
      id: 'a',
      type: 'countdown',
      props: { endsAt: past, whenOver: { type: 'text', text: 'It has ended.' } },
    };
    expect(
      shape(
        drawn(
          <CountdownView
            id="a"
            look={{}}
            endsAt={past}
            whenOver={{ type: 'text', text: 'It has ended.' }}
          />,
        ),
      ),
    ).toStrictEqual(shape(published(over)));
    const onward: PageElement = {
      id: 'a',
      type: 'countdown',
      props: { endsAt: past, whenOver: { type: 'url', href: 'https://example.com' } },
    };
    expect(
      shape(
        drawn(
          <CountdownView
            id="a"
            look={{}}
            endsAt={past}
            whenOver={{ type: 'url', href: 'https://example.com' }}
          />,
        ),
      ),
    ).toStrictEqual(shape(published(onward)));
  });

  it('images with the picture’s own size, which holds its place while it loads', () => {
    const src = 'https://example.com/a.png';
    const element: PageElement = {
      id: 'a',
      type: 'image',
      props: { src, alt: '', action: none, optimize: true, width: 1200, height: 800 },
    };
    const markup = drawn(
      <ImageView id="a" look={{}} src={src} alt="" action={none} width={1200} height={800} />,
    );
    expect(markup).toContain('width="1200"');
    expect(markup).toContain('height="800"');
    expect(shape(markup)).toStrictEqual(shape(published(element)));
    // One side alone says nothing of the picture's shape: neither is written.
    expect(
      drawn(<ImageView id="a" look={{}} src={src} alt="" action={none} width={1200} />),
    ).not.toContain('width=');
  });

  it('a calendar, as the button-styled link to its booking page, with its own words or the page’s', () => {
    const calendars = new Map([
      [CALENDAR_ID, { id: CALENDAR_ID, name: 'Intro call', active: true }],
    ]);
    for (const label of [undefined, 'Book your visit']) {
      const element: PageElement = {
        id: 'a',
        type: 'calendar',
        props: { calendarId: CALENDAR_ID, ...(label === undefined ? {} : { label }) },
      };
      expect(
        shape(
          drawn(
            <CanvasCalendarsContext value={calendars}>
              <CalendarView id="a" look={{}} calendarId={CALENDAR_ID} label={label} />
            </CanvasCalendarsContext>,
          ),
        ),
        label ?? 'default',
      ).toStrictEqual(shape(published(element)));
    }
  });

  it('custom code, as the notice a preview shows and never as markup', () => {
    const element: PageElement = {
      id: 'a',
      type: 'custom_code',
      props: { code: '<script>document.title = "ran"</script>' },
    };
    const markup = drawn(<CustomCodeView id="a" look={{}} />);
    expect(shape(markup)).toStrictEqual(shape(published(element)));
    expect(markup).not.toContain('script');
  });
});

describe('what a published page shows through a script, a frame or not at all is a labelled box', () => {
  const forms = new Map([
    ['form_1', { name: 'Contact us', published: true }],
    ['form_2', { name: 'Book a visit', published: false }],
  ]);
  const form = (formId: string | null | undefined): string =>
    drawn(
      <CanvasFormsContext value={forms}>
        <FormView id="a" look={{}} formId={formId} />
      </CanvasFormsContext>,
    );

  it('a form says which form it is, and whether that form is published', () => {
    expect(form('form_1')).toBe(
      '<div class="fm n_a"><span class="ep">Form: Contact us</span></div>',
    );
    expect(form('form_2')).toContain('Form: Book a visit (not published)');
    expect(form(null)).toContain('Form: none chosen yet');
    expect(form(undefined)).toContain('Form: none chosen yet');
    expect(form('form_9')).toContain('Form: the one chosen is no longer here');
  });

  it('an image with no picture, a video, a calendar, a countdown with no end', () => {
    for (const src of [null, undefined, 'http://example.com/a.png', 'javascript:alert(1)'])
      expect(drawn(<ImageView id="a" look={{}} src={src} alt="" action={undefined} />)).toBe(
        '<div class="ep n_a">Image: no picture chosen yet</div>',
      );
    const video = (source: string | undefined, url: string | null | undefined): string =>
      drawn(<VideoView id="a" look={{ customClass: 'wide' }} source={source} url={url} />);
    // One element, as the published page's frame is one element (`iframe.vd`).
    expect(video('youtube', null)).toBe(
      '<div class="vd ep ev n_a wide">Video: no address yet</div>',
    );
    expect(video('file', 'https://example.com/a.mp4')).toContain('class="vf ep ev n_a wide"');
    expect(video('youtube', undefined)).toContain('Video: no address yet');
    expect(video('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toContain(
      'YouTube video: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(video('vimeo', 'https://vimeo.com/123456')).toContain(
      'Vimeo video: https://vimeo.com/123456',
    );
    expect(video('file', 'https://example.com/a.mp4')).toContain(
      'Video file: https://example.com/a.mp4',
    );
    expect(video('youtube', 'https://example.com/a.mp4')).toContain("this address can't be played");
    expect(video('file', 'ftp://example.com/a.mp4')).toContain("this address can't be played");
    // A calendar that could not be published is a box that says why.
    const calendars = new Map([['cal_1', { id: 'cal_1', name: 'Intro call', active: false }]]);
    const calendar = (calendarId: string | null | undefined): string =>
      drawn(
        <CanvasCalendarsContext value={calendars}>
          <CalendarView id="a" look={{}} calendarId={calendarId} label={undefined} />
        </CanvasCalendarsContext>,
      );
    expect(calendar(null)).toBe('<div class="ep n_a">Calendar: none chosen yet</div>');
    expect(calendar(undefined)).toContain('Calendar: none chosen yet');
    expect(calendar('cal_9')).toContain('Calendar: the one chosen is no longer here');
    expect(calendar('cal_1')).toContain('Calendar: Intro call (not active)');
    for (const endsAt of [null, undefined, 'never'])
      expect(
        drawn(<CountdownView id="a" look={{}} endsAt={endsAt} whenOver={undefined} />),
      ).toContain('Countdown: no end time yet');
    for (const whenOver of [
      { type: 'hide' } as const,
      { type: 'text', text: '' } as const,
      undefined,
    ])
      expect(
        drawn(
          <CountdownView id="a" look={{}} endsAt="2001-01-01T00:00:00.000Z" whenOver={whenOver} />,
        ),
      ).toContain('it is over, so the page shows nothing here');
    expect(drawn(<SavedSectionView id="a" />)).toContain(
      'A saved section, shown here by reference.',
    );
  });
});

describe('layout nodes keep the published page’s classes around the canvas’s drop zones', () => {
  /** A slot as the canvas hands one over: it draws its zone's own element. */
  const slot = (seen: { allow?: string[] }[]): SlotView =>
    function Slot({ className, allow }): ReactNode {
      seen.push({ ...(allow === undefined ? {} : { allow }) });
      return <div className={className} />;
    };
  const full = (zones: readonly string[]) => ({
    subscribe: () => () => undefined,
    isFull: (zone: string) => zones.includes(zone),
  });

  it('a section, a row and a column', () => {
    const seen: { allow?: string[] }[] = [];
    expect(
      drawn(<SectionView id="s" look={{ customClass: 'hero' }} width="medium" rows={slot(seen)} />),
    ).toBe('<section class="sc sc-medium n_s hero"><div class="ez"></div></section>');
    expect(drawn(<SectionView id="s" look={{}} width="huge" rows={slot(seen)} />)).toBe(
      '<section class="sc n_s"><div class="ez"></div></section>',
    );
    expect(drawn(<SectionView id="s" look={{}} width={undefined} rows={slot(seen)} />)).toContain(
      'class="sc n_s"',
    );
    expect(drawn(<RowView id="r" look={{}} columns={slot(seen)} />)).toBe(
      '<div class="rw n_r"><div class="ez ez-row"></div></div>',
    );
    expect(
      drawn(
        <ColumnView id="c" look={{}}>
          {slot(seen)}
        </ColumnView>,
      ),
    ).toBe('<div class="cl n_c"><div class="ez ez-col"></div></div>');
    expect(seen.map((each) => each.allow?.[0])).toStrictEqual([
      'row',
      'row',
      'row',
      'column',
      'headline',
    ]);
  });

  it('but for its drop zones, a section of rows, columns and a container is the live page’s markup', () => {
    /** A slot that draws what it holds inside its zone's element, as the canvas does. */
    const holding = (inside: ReactNode): SlotView =>
      function Slot({ className }): ReactNode {
        return <div className={className}>{inside}</div>;
      };
    const canvas = drawn(
      <SectionView
        id="s"
        look={{ customClass: 'hero' }}
        width="wide"
        rows={holding(
          <>
            <RowView
              id="r1"
              look={{}}
              columns={holding(
                <>
                  <ColumnView id="c1" look={{}}>
                    {holding(
                      <ContainerView id="k" look={{}} direction="horizontal">
                        {holding(<ParagraphView id="p" look={{}} text={[{ text: 'In it' }]} />)}
                      </ContainerView>,
                    )}
                  </ColumnView>
                  <ColumnView id="c2" look={{}}>
                    {holding(null)}
                  </ColumnView>
                </>,
              )}
            />
            <RowView
              id="r2"
              look={{}}
              columns={holding(
                <ColumnView id="c3" look={{}}>
                  {holding(null)}
                </ColumnView>,
              )}
            />
          </>,
        )}
      />,
    );
    const page: VisualPageDocument = {
      ...EMPTY_PAGE_DOCUMENT,
      sections: [
        {
          id: 's',
          type: 'section',
          props: { width: 'wide' },
          customClass: 'hero',
          rows: [
            {
              id: 'r1',
              type: 'row',
              columns: [
                {
                  id: 'c1',
                  type: 'column',
                  props: { span: 6 },
                  children: [
                    {
                      id: 'k',
                      type: 'container',
                      props: { direction: 'horizontal', gap: 0 },
                      children: [
                        { id: 'p', type: 'paragraph', props: { text: [{ text: 'In it' }] } },
                      ],
                    },
                  ],
                },
                { id: 'c2', type: 'column', props: { span: 6 }, children: [] },
              ],
            },
            {
              id: 'r2',
              type: 'row',
              columns: [{ id: 'c3', type: 'column', props: { span: 12 }, children: [] }],
            },
          ],
        },
      ],
    };
    const live = new DOMParser().parseFromString(
      renderPage(page, context)?.html ?? '',
      'text/html',
    );
    /** The same markup with each drop zone taken out and what it holds put in its place. */
    const withoutZones = (html: string): string => {
      const holder = document.createElement('div');
      holder.innerHTML = html;
      for (const zone of [...holder.querySelectorAll('.ez')]) zone.replaceWith(...zone.childNodes);
      return holder.innerHTML;
    };
    expect(canvas).toContain('<section class="sc sc-wide n_s hero"><div class="ez">');
    expect(shape(withoutZones(canvas))).toStrictEqual(
      shape(live.querySelector('main')?.innerHTML.trim() ?? ''),
    );
  });

  it('a full zone takes nothing more, and the deepest container takes no container', () => {
    const seen: { allow?: string[] }[] = [];
    const container = (zones: readonly string[], depth: number): string => {
      let view: ReactElement = (
        <ContainerView id="k" look={{}} direction={depth === 1 ? 'horizontal' : undefined}>
          {slot(seen)}
        </ContainerView>
      );
      // Each container around it puts the one inside a level deeper.
      for (let at = 1; at < depth; at += 1) {
        const inner = view;
        view = (
          <ContainerView id={`o${String(at)}`} look={{}} direction="vertical">
            {() => inner}
          </ContainerView>
        );
      }
      return drawn(<ZoneStoreContext value={full(zones)}>{view}</ZoneStoreContext>);
    };
    expect(container([], 1)).toBe('<div class="kt k-h n_k"><div class="ez ez-kt k-h"></div></div>');
    expect(seen.at(-1)?.allow).toContain('container');
    container([], 3);
    expect(seen.at(-1)?.allow).not.toContain('container');
    expect(seen.at(-1)?.allow).toContain('headline');
    container(['k:children'], 1);
    expect(seen.at(-1)?.allow).toStrictEqual([]);
    for (const [zone, view] of [
      ['s:rows', <SectionView key="s" id="s" look={{}} width="wide" rows={slot(seen)} />],
      ['r:columns', <RowView key="r" id="r" look={{}} columns={slot(seen)} />],
      [
        'c:children',
        <ColumnView key="c" id="c" look={{}}>
          {slot(seen)}
        </ColumnView>,
      ],
      ['p:rows', <PopupView key="p" id="p" name="Offer" width="large" rows={slot(seen)} />],
    ] as const) {
      drawn(<ZoneStoreContext value={full([zone])}>{view}</ZoneStoreContext>);
      expect(seen.at(-1)?.allow, zone).toStrictEqual([]);
    }
  });

  it('a popup, apart from the page, with its box as the published page sizes it', () => {
    const seen: { allow?: string[] }[] = [];
    expect(drawn(<PopupView id="p" name="Offer" width="large" rows={slot(seen)} />)).toBe(
      '<div class="ep-popup" role="group" aria-label="Offer"><p class="ep-note">Popup: Offer</p>' +
        '<div class="pb pw-large n_p ez"></div></div>',
    );
    expect(drawn(<PopupView id="p" name={undefined} width="vast" rows={slot(seen)} />)).toContain(
      'pb pw-medium n_p ez',
    );
    expect(drawn(<PopupView id="p" name="x" width={undefined} rows={slot(seen)} />)).toContain(
      'pw-medium',
    );
  });

  it('the page: its stylesheet, its sections in main, its popups apart when it has any', () => {
    const seen: { allow?: string[] }[] = [];
    const page = (hasPopups: boolean, zones: readonly string[] = []): string =>
      drawn(
        <ZoneStoreContext value={full(zones)}>
          <PageView
            css="body{margin:0}"
            sections={slot(seen)}
            popups={slot(seen)}
            hasPopups={hasPopups}
          />
        </ZoneStoreContext>,
      );
    expect(page(false)).toBe(
      '<style>body{margin:0}</style><main aria-label="The page being edited"><div class="ez"></div></main>',
    );
    expect(seen.at(-1)?.allow).toStrictEqual(['section', 'saved_section']);
    const withPopups = page(true);
    expect(withPopups).toContain('<section class="ep-popups" aria-label="Popups">');
    expect(seen.at(-1)?.allow).toStrictEqual(['popup']);
    page(true, ['root:sections', 'root:popups']);
    expect(seen.slice(-2).map((each) => each.allow)).toStrictEqual([[], []]);
  });
});
