import { pageDocument, pageElementTypes, type PageElement } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  CALENDAR,
  context,
  ELEMENTS,
  EVERYTHING,
  FORM,
  FORM_KEY,
  pageOf,
  SAVED,
  SCRIPTS,
  SECTION,
  SITE_BASE,
} from './fixtures.js';
import { pageElements, renderPage } from './render.js';

const render = (children: PageElement[], over: Parameters<typeof context>[0] = {}) => {
  const page = renderPage(pageOf(children), context(over));
  if (page === undefined) throw new Error('A visual page renders.');
  return page;
};
/** What is between the page's main tags. */
const body = (html: string): string => /<main>([\s\S]*)<\/main>/.exec(html)?.[1]?.trim() ?? '';

describe('the fixtures', () => {
  it('are pages the contract accepts, with one of every element type', () => {
    expect(pageDocument.safeParse(EVERYTHING).error).toBeUndefined();
    expect(Object.keys(ELEMENTS).sort()).toEqual([...pageElementTypes].sort());
    const used = new Set([...pageElements(EVERYTHING)].map((node) => node.type));
    expect([...used].sort()).toEqual([...pageElementTypes].sort());
  });
});

describe('golden pages', () => {
  it.each(pageElementTypes)('renders a %s as its golden file', async (type) => {
    const page = render([ELEMENTS[type]]);
    await expect(`${body(page.html)}\n\n${page.css}\n`).toMatchFileSnapshot(`./golden/${type}.txt`);
  });

  it('renders a page with everything as its golden file', async () => {
    const page = renderPage(EVERYTHING, context());
    await expect(page?.html).toMatchFileSnapshot('./golden/everything.txt');
    expect(page?.needs).toEqual({
      scripts: [SCRIPTS.countdown, SCRIPTS.popup],
      forms: true,
      frames: ['https://player.vimeo.com', 'https://www.youtube.com'],
      media: true,
    });
  });

  it('renders the same bytes every time', () => {
    expect(renderPage(EVERYTHING, context())).toEqual(renderPage(EVERYTHING, context()));
  });
});

describe('renderPage', () => {
  it('does not render a code page', () => {
    expect(
      renderPage(
        {
          format: 1,
          mode: 'code',
          settings: { seo: EVERYTHING.settings.seo },
          files: [{ path: 'index.html', kind: 'text', content: '<p>hi</p>' }],
        },
        context(),
      ),
    ).toBeUndefined();
    expect([
      ...pageElements({
        format: 1,
        mode: 'code',
        settings: { seo: EVERYTHING.settings.seo },
        files: [{ path: 'index.html', kind: 'text', content: '' }],
      }),
    ]).toEqual([]);
  });

  it('renders an empty page as a whole document that needs nothing', () => {
    const page = renderPage(pageOf([]), context({ faviconUrl: null, canonicalUrl: undefined }));
    expect(page?.html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(page?.html).toContain('<title>Landing Page</title>');
    expect(page?.html).not.toContain('rel="canonical"');
    expect(page?.html).not.toContain('rel="icon"');
    expect(page?.needs).toEqual({ forms: false, frames: [], media: false, scripts: [] });
  });

  it('writes the head from the page’s SEO fields, and never a tenant’s code', () => {
    const html = renderPage(EVERYTHING, context())?.html ?? '';
    expect(html).toContain('<title>Spring offer for Acme &amp; Sons</title>');
    expect(html).toContain(
      '<meta name="description" content="Everything you need, in one place.">',
    );
    expect(html).toContain('<link rel="canonical" href="https://www.example.com/spring">');
    expect(html).toContain('<meta property="og:url" content="https://www.example.com/spring">');
    expect(html).toContain('<meta property="og:image" content="https://img.example/card.png">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta name="author" content="Dana Brooks">');
    expect(html).toContain('<meta property="og:locale" content="en_GB">');
    expect(html).toContain('<link rel="icon" href="https://img.example/favicon.png">');
    // The page's own robots line is the renderer's: a document cannot write another.
    expect(html.match(/name="robots"/g)).toHaveLength(1);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain('window.tracked');
    expect(html).not.toContain('window.body');
    expect(html).not.toContain('alert(1)');
  });

  it('lets a page be listed only where the address allows it and the page does not refuse', () => {
    const listed = renderPage(pageOf([]), context({ index: true, lang: 'sw-KE' }))?.html ?? '';
    expect(listed).not.toContain('name="robots"');
    expect(listed).toContain('<html lang="sw-KE">');
    const refused = renderPage(
      {
        ...pageOf([]),
        settings: { ...EVERYTHING.settings, seo: { ...EVERYTHING.settings.seo, noIndex: true } },
      },
      context({ index: true, lang: '"><script>' }),
    );
    expect(refused?.html).toContain('<meta name="robots" content="noindex">');
    expect(refused?.html).toContain('<html lang="en">');
  });

  it('falls back to the page’s own address when its canonical one is not a secure address', () => {
    const page = {
      ...pageOf([]),
      settings: {
        ...EVERYTHING.settings,
        seo: {
          ...EVERYTHING.settings.seo,
          canonicalUrl: 'http://example.com/x',
          imageUrl: '/card.png',
        },
      },
    };
    const html = renderPage(page, context({ faviconUrl: 'http://img.example/f.png' }))?.html ?? '';
    expect(html).toContain(`<link rel="canonical" href="https://crm.example${SITE_BASE}/landing">`);
    // A social card needs a full address; a path on the site is not one.
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('rel="icon"');
    // The page's own address is used only when it is a web address.
    for (const canonicalUrl of ['mailto:a@example.com', '#top', '/landing', 'javascript:alert(1)'])
      expect(renderPage(page, context({ canonicalUrl }))?.html).not.toContain('rel="canonical"');
    expect(
      renderPage(page, context({ canonicalUrl: 'http://localhost:3000/s/k/landing' }))?.html,
    ).toContain('<link rel="canonical" href="http://localhost:3000/s/k/landing">');
  });

  it('links to steps a visitor can reach and leaves the rest as plain text', () => {
    const reachable = body(render([ELEMENTS.paragraph]).html);
    expect(reachable).toContain(`<a href="${SITE_BASE}/offers/next">the next step</a>`);
    expect(reachable).toContain(`<a href="${SITE_BASE}/thanks">the thanks page</a>`);
    expect(reachable).toContain(
      '<a href="https://example.com/more" target="_blank" rel="noopener noreferrer">more</a>',
    );
    // This page has no popup called offer, so that link has nowhere to go.
    expect(reachable).toContain('the offer');
    expect(reachable).not.toContain('#offer');
    expect(reachable).toContain('href="#top"');
    const alone = body(
      render([ELEMENTS.paragraph], { steps: new Map(), nextStepPath: undefined }).html,
    );
    expect(alone).not.toContain(`${SITE_BASE}/`);
    expect(alone).toContain('the next step');
    expect(body(render([ELEMENTS.button], { nextStepPath: undefined }).html)).toMatch(
      /^<section[^>]*><div[^>]*><div[^>]*><span class="bt e\d+">Get started<span class="bs">/,
    );
  });

  it('shows a form through the CRM’s own embed, and nothing for a form it was not given', () => {
    const shown = render([ELEMENTS.form]);
    expect(shown.html).toContain(
      `<script async src="/forms/embed.js" data-form-key="${FORM_KEY}"></script>`,
    );
    expect(shown.needs.forms).toBe(true);
    for (const forms of [new Map<string, string>(), new Map([[FORM, 'short']])]) {
      const missing = render([ELEMENTS.form], { forms });
      expect(missing.html).not.toContain('<script');
      expect(missing.needs.forms).toBe(false);
    }
    expect(render([{ id: 'f', type: 'form', props: { formId: null } }]).html).not.toContain(
      '<script',
    );
  });

  it('links to a calendar’s booking page, or shows nothing without one', () => {
    expect(body(render([ELEMENTS.calendar]).html)).toContain(
      '<a class="bt" href="https://crm.example/book/acme/main/intro">Book a time</a>',
    );
    expect(body(render([ELEMENTS.calendar], { calendars: new Map() }).html)).not.toContain('<a');
    expect(
      body(
        render([ELEMENTS.calendar], { calendars: new Map([[CALENDAR, 'javascript:alert(1)']]) })
          .html,
      ),
    ).not.toContain('<a');
    expect(
      body(render([{ id: 'c', type: 'calendar', props: { calendarId: null } }]).html),
    ).not.toContain('<a');
  });

  it('writes a countdown as the time left and the moment it ends, and what was chosen for afterwards', () => {
    const before = body(render([ELEMENTS.countdown]).html);
    expect(before).toContain(
      '<p class="cd" data-cd="hide"><span role="timer">49d 21h 05m</span> left, ends <time datetime="2026-12-01T09:05:00.000Z">1 December 2026, 09:05 UTC</time></p>',
    );
    // The time left is true at the moment of rendering, whatever that moment is.
    const at = (now: string) =>
      /<span role="timer">([^<]*)</.exec(
        render([ELEMENTS.countdown], { now: Date.parse(now) }).html,
      )?.[1];
    expect(at('2026-12-01T09:03:30.000Z')).toBe('00h 01m');
    expect(at('2026-12-01T09:04:30.000Z')).toBe('under 1m');
    expect(at('2026-11-30T09:05:00.000Z')).toBe('1d 00h 00m');
    // What the end does is written for the script, as text in an attribute.
    const running = (whenOver: unknown) =>
      /<p class="cd"[^>]*>/.exec(
        render([
          {
            id: 'cd',
            type: 'countdown',
            props: { endsAt: '2026-12-01T09:05:00.000Z', whenOver },
          } as PageElement,
        ]).html,
      )?.[0];
    expect(running({ type: 'text', text: 'Too "late" <b>' })).toBe(
      '<p class="cd" data-cd="text" data-cd-text="Too &quot;late&quot; &lt;b&gt;">',
    );
    expect(running({ type: 'text', text: '' })).toBe('<p class="cd" data-cd="hide">');
    expect(running({ type: 'url', href: '/gone' })).toBe(
      `<p class="cd" data-cd="url" data-cd-href="${SITE_BASE}/gone">`,
    );
    expect(running({ type: 'url', href: 'javascript:alert(1)' })).toBe(
      '<p class="cd" data-cd="hide">',
    );
    const after = (whenOver: unknown, endsAt: string | null = '2026-01-01T00:00:00.000Z') =>
      body(
        render([{ id: 'cd', type: 'countdown', props: { endsAt, whenOver } } as PageElement]).html,
      );
    expect(after({ type: 'hide' })).not.toContain('<p');
    expect(after({ type: 'text', text: 'Too <late>' })).toContain('>Too &lt;late&gt;</p>');
    expect(after({ type: 'text', text: '' })).not.toContain('<p');
    expect(after({ type: 'url', href: '/gone' })).toContain(
      `<a href="${SITE_BASE}/gone">Continue</a>`,
    );
    expect(after({ type: 'url', href: 'javascript:alert(1)' })).not.toContain('<a');
    expect(after({ type: 'hide' }, null)).not.toContain('<p');
    expect(after({ type: 'hide' }, 'not a date')).not.toContain('<p');
  });

  it('never writes custom code, and names where it runs in a preview', () => {
    expect(body(render([ELEMENTS.custom_code]).html)).not.toContain('alert');
    const preview = body(render([ELEMENTS.custom_code], { preview: true }).html);
    expect(preview).toContain('Custom code runs on your connected domain.');
    expect(preview).not.toContain('alert');
  });

  it('plays a video file itself and frames one from YouTube or Vimeo', () => {
    const file = (props: Record<string, unknown>) =>
      render([
        {
          id: 'v',
          type: 'video',
          props: {
            source: 'file',
            url: 'https://media.example/a.mp4',
            autoplay: false,
            controls: true,
            muted: false,
            loop: false,
            ...props,
          },
        },
      ]);
    expect(body(file({}).html)).toContain(
      'src="https://media.example/a.mp4" controls playsinline preload="metadata"></video>',
    );
    // With no controls and no autoplay nobody could start it, so the controls stay.
    expect(body(file({ controls: false }).html)).toContain(' controls playsinline');
    expect(body(file({ controls: false, autoplay: true, loop: true }).html)).toContain(
      '.mp4" autoplay muted loop playsinline',
    );
    expect(file({}).needs).toEqual({ forms: false, frames: [], media: true, scripts: [] });
    expect(body(file({ url: null }).html)).not.toContain('<video');
    const framed = render([ELEMENTS.video]);
    // The frame is the element: nothing is written around it to give it its shape.
    expect(body(framed.html)).toContain(
      '<div class="cl e1"><iframe class="vd" src="https://www.youtube.com/embed/M7lc1UVf-VE?loop=1&amp;playlist=M7lc1UVf-VE" title="Video"',
    );
    expect(framed.css).toContain(
      '.vd{position:relative;display:block;width:100%;aspect-ratio:16/9',
    );
    expect(framed.needs.frames).toEqual(['https://www.youtube.com']);
    const unknown = render([
      {
        ...ELEMENTS.video,
        props: { ...(ELEMENTS.video as { props: object }).props, url: 'https://example.com/v' },
      } as PageElement,
    ]);
    expect(unknown.html).not.toContain('<iframe');
    expect(unknown.needs.frames).toEqual([]);
  });

  it('shows an image only when it has one, and makes it a link when it has an action', () => {
    expect(body(render([ELEMENTS.image]).html)).toContain(
      `<a href="${SITE_BASE}/about"><img class="im e2" src="https://img.example/team.png" alt="The team at work" width="1600" height="900" fetchpriority="high" decoding="async"></a>`,
    );
    const none = render([
      {
        id: 'i',
        type: 'image',
        props: { src: null, alt: '', action: { type: 'none' }, optimize: true },
      },
    ]);
    expect(none.html).not.toContain('<img');
    const two = body(
      render([
        {
          id: 'a',
          type: 'image',
          props: {
            src: 'https://img.example/a.png',
            alt: 'A',
            action: { type: 'none' },
            optimize: true,
          },
        },
        {
          id: 'b',
          type: 'image',
          props: { src: '/b.png', alt: 'B', action: { type: 'none' }, optimize: true },
        },
      ]).html,
    );
    // What a visitor sees first is fetched at once, and the first picture of all ahead of
    // the rest; a picture in a later section waits until it is scrolled to.
    expect(two).toContain('alt="A" fetchpriority="high" decoding="async">');
    expect(two).toContain(`src="${SITE_BASE}/b.png" alt="B" decoding="async">`);
    const first = pageOf([ELEMENTS.image]);
    const later = renderPage(
      {
        ...first,
        sections: [...first.sections, { ...pageOf([ELEMENTS.image]).sections[0], id: 'below' }],
      } as typeof first,
      context(),
    );
    expect(later?.html.match(/fetchpriority="high"/g)).toHaveLength(1);
    expect(later?.html.match(/loading="lazy"/g)).toHaveLength(1);
    expect(later?.html.indexOf('fetchpriority')).toBeLessThan(
      later?.html.indexOf('loading="lazy"') ?? 0,
    );
  });

  it('resolves a saved section and skips one that is gone', () => {
    const page = {
      ...pageOf([]),
      sections: [{ id: 'shared', type: 'saved_section' as const, sectionId: SECTION }],
    };
    expect(renderPage(page, context())?.html).toContain('A footer every page shares.');
    expect(renderPage(page, context({ sections: new Map() }))?.html).not.toContain('<section');
    expect([...pageElements(page, new Map([[SECTION, SAVED]]))].map((node) => node.id)).toEqual([
      'saved-text',
    ]);
    expect([...pageElements(page)]).toEqual([]);
  });

  it('opens a popup from a link on the page, with no script', () => {
    const html = renderPage(EVERYTHING, context())?.html ?? '';
    expect(html).toContain('<a href="#offer">the offer</a>');
    expect(html).toContain(
      '<div class="pp" id="offer" role="dialog" aria-modal="true" aria-label="Spring offer" tabindex="-1">',
    );
    expect(html).toContain('<a class="px" href="#_" aria-label="Close">&times;</a>');
    expect(html).toContain('.pp:target,.pp.on{display:flex}');
  });

  const popupPage = (props: Record<string, unknown>, over = {}) =>
    renderPage(
      {
        ...pageOf([ELEMENTS.headline]),
        popups: [
          {
            id: 'offer',
            type: 'popup',
            name: 'Offer',
            props: { trigger: 'none', delaySeconds: 0, width: 'small', ...props },
            rows: [],
          },
        ],
      } as never,
      context(over),
    );

  it('says on a popup when it opens by itself, for the script that opens it', () => {
    const tag = (props: Record<string, unknown>, over = {}) =>
      /<div class="pp"[^>]*>/.exec(popupPage(props, over)?.html ?? '')?.[0] ?? '';
    expect(tag({})).not.toContain('data-p');
    expect(tag({ trigger: 'delay', delaySeconds: 5 })).toContain(' data-pt="delay" data-pd="5">');
    expect(tag({ trigger: 'exit', delaySeconds: 5 })).toContain(' data-pt="exit">');
    expect(tag({ trigger: 'exit', frequency: 'session' })).not.toContain('data-pf');
    expect(tag({ trigger: 'exit', frequency: 'always' })).toContain(' data-pf="always">');
    // A draft shown to its editor opens every time and keeps nothing in the browser.
    expect(tag({ trigger: 'delay' }, { preview: true })).toContain(' data-pf="always">');
    // Never a number the contract would not take.
    expect(tag({ trigger: 'delay', delaySeconds: 99_999 })).toContain(' data-pd="0">');
    // One that only a link opens says nothing of how often.
    expect(tag({ frequency: 'always' })).not.toContain('data-p');
  });

  it('names a script of ours only on a page that holds what it is for', () => {
    const scriptsOf = (html: string | undefined) =>
      [...(html ?? '').matchAll(/<script[^>]*>/g)].map(([tag]) => tag);
    expect(scriptsOf(render([ELEMENTS.headline]).html)).toEqual([]);
    expect(render([ELEMENTS.headline]).needs.scripts).toEqual([]);
    const counting = render([ELEMENTS.countdown]);
    expect(scriptsOf(counting.html)).toEqual([`<script defer src="${SCRIPTS.countdown}">`]);
    expect(counting.needs.scripts).toEqual([SCRIPTS.countdown]);
    // In the head, after the stylesheet: fetched beside the page, run once it is parsed.
    expect(counting.html).toMatch(/<\/style>\n<script defer src="[^"]+"><\/script>\n<\/head>/);
    const popup = popupPage({ trigger: 'delay', delaySeconds: 3 });
    expect(scriptsOf(popup?.html)).toEqual([`<script defer src="${SCRIPTS.popup}">`]);
    const both = renderPage(EVERYTHING, context());
    expect(both?.needs.scripts).toEqual([SCRIPTS.countdown, SCRIPTS.popup]);
    // A countdown that is over is plain words: nothing is left to tick.
    const over = render([ELEMENTS.countdown], { now: Date.parse('2027-01-01T00:00:00Z') });
    expect(scriptsOf(over.html)).toEqual([]);
    // A server that has no script to send names none, and the page is whole without one.
    const without = render([ELEMENTS.countdown], { scripts: undefined });
    expect(scriptsOf(without.html)).toEqual([]);
    expect(without.needs.scripts).toEqual([]);
    expect(body(without.html)).toContain('<span role="timer">49d 21h 05m</span> left, ends <time');
    // Only a path of ours, ending in .js: never an address someone else could serve.
    for (const bad of ['https://evil.example/x.js', '//evil.example/x.js', '/s/_js/x.js?"><b>'])
      expect(scriptsOf(render([ELEMENTS.countdown], { scripts: { countdown: bad } }).html)).toEqual(
        [],
      );
  });

  it('names the arrival’s script on every page of a site that keeps it, and on no other', () => {
    const scriptsOf = (html: string | undefined) =>
      [...(html ?? '').matchAll(/<script[^>]*>/g)].map(([tag]) => tag);
    const site = '0123456789abcdef0123456789abcdef';
    // A page with nothing on it that needs a script: its site takes a lead elsewhere.
    const plain = render([ELEMENTS.headline], { arrival: { site, always: false } });
    expect(scriptsOf(plain.html)).toEqual([
      `<script defer src="${SCRIPTS.arrival}" data-site="${site}">`,
    ]);
    expect(plain.needs).toEqual({
      forms: false,
      frames: [],
      media: false,
      scripts: [SCRIPTS.arrival],
    });
    // Told to pass over the privacy signal only when the site says every visitor.
    expect(
      scriptsOf(render([ELEMENTS.headline], { arrival: { site, always: true } }).html),
    ).toEqual([`<script defer src="${SCRIPTS.arrival}" data-site="${site}" data-gpc="keep">`]);
    // First of the head's scripts, so a form is told before anything else runs.
    const all = renderPage(EVERYTHING, context({ arrival: { site, always: false } }));
    expect(all?.needs.scripts).toEqual([SCRIPTS.arrival, SCRIPTS.countdown, SCRIPTS.popup]);
    // A site that does not keep it: the same bytes as before there was such a script.
    expect(render([ELEMENTS.form]).html).toBe(render([ELEMENTS.form], { arrival: undefined }).html);
    expect(scriptsOf(render([ELEMENTS.headline]).html)).toEqual([]);
    // A server with no such script to send, and a key that is not a site's, name none.
    expect(
      scriptsOf(
        render([ELEMENTS.headline], {
          arrival: { site, always: false },
          scripts: { countdown: SCRIPTS.countdown },
        }).html,
      ),
    ).toEqual([]);
    for (const bad of ['', '"><script>', 'UPPER', 'a'.repeat(65)])
      expect(
        scriptsOf(render([ELEMENTS.headline], { arrival: { site: bad, always: true } }).html),
      ).toEqual([]);
  });

  it('writes a picture’s own size when the document has both sides, and never one alone', () => {
    const picture = (props: Record<string, unknown>) =>
      body(
        render([
          {
            id: 'i',
            type: 'image',
            props: {
              src: 'https://img.example/a.png',
              alt: 'A',
              action: { type: 'none' },
              optimize: true,
              ...props,
            },
          },
        ]).html,
      );
    expect(picture({ width: 1600, height: 900 })).toContain(
      '<img class="im" src="https://img.example/a.png" alt="A" width="1600" height="900" fetchpriority="high" decoding="async">',
    );
    for (const props of [
      {},
      { width: 1600 },
      { height: 900 },
      { width: 0, height: 900 },
      { width: 1600.5, height: 900 },
      { width: 20_001, height: 900 },
      { width: '1600', height: '900' },
      { width: '"><script>', height: 900 },
    ])
      expect(picture(props)).not.toMatch(/\s(width|height)=/);
    // The stylesheet keeps the picture's shape whatever width it is shown at.
    expect(render([ELEMENTS.image]).css).toContain('img,video,iframe{max-width:100%}');
    expect(render([ELEMENTS.image]).css).toContain('img{height:auto;display:block}');
  });

  it('lets a calendar’s link say what the page chose, with merge fields filled in', () => {
    const link = (label: unknown) =>
      body(
        render([
          { id: 'c', type: 'calendar', props: { calendarId: CALENDAR, label } } as PageElement,
        ]).html,
      );
    expect(link(undefined)).toContain('>Book a time</a>');
    expect(link('Meet {{custom_values.name}} <now>')).toContain(
      '>Meet Acme &amp; Sons &lt;now&gt;</a>',
    );
    expect(link('{{custom_values.none}}')).toContain('>Book a time</a>');
    expect(link(7)).toContain('>Book a time</a>');
  });

  it('compiles each device’s values to media queries and hides what a device hides', () => {
    const { css } = render([ELEMENTS.headline, ELEMENTS.sub_headline]);
    expect(css).toContain('@media (max-width:1024px){.e2{font-size:36px}}');
    expect(css).toContain('@media (max-width:640px){.e2{font-size:28px;text-align:left}}');
    expect(css.indexOf('max-width:1024px){.e2')).toBeLessThan(css.indexOf('max-width:640px){.e2'));
    expect(css).toMatch(/@media \(max-width:640px\)\{\.e\d+\{display:none!important\}\}/);
    const all = renderPage(EVERYTHING, context())?.css ?? '';
    expect(all).toContain(
      '@media (min-width:641px) and (max-width:1024px){.e1{display:none!important}}',
    );
    expect(all).toContain('.hero-title { text-shadow: 0 1px 0 #fff; }');
  });

  it('falls back to plain values where a document names none the format has', () => {
    const odd = render([
      {
        id: 'h',
        type: 'headline',
        props: { text: [{ text: 'x' }], level: 9 },
      } as unknown as PageElement,
      {
        id: 'd',
        type: 'divider',
        props: { thickness: 999, line: 'wavy', color: null },
      } as unknown as PageElement,
      {
        id: 'k',
        type: 'container',
        props: { direction: 'diagonal', gap: -1 },
        children: [],
      } as unknown as PageElement,
      { id: 'l', type: 'bullet_list', props: { items: [[{ text: '' }]], marker: 'disc' } },
    ]);
    // A node with no look of its own carries no class of its own, and no rule.
    expect(odd.html).toContain('<h2 class="hl">x</h2>');
    expect(odd.html).toContain('<hr class="dv e2">');
    expect(odd.css).toContain('.e2{border-top:1px solid currentColor}');
    expect(odd.html).toContain('<div class="kt k-v"></div>');
    expect(odd.css).not.toMatch(/\{gap:/);
    expect(odd.html).toContain('<ul class="ls"><li></li></ul>');
    const page = renderPage(
      {
        ...EVERYTHING,
        settings: {
          ...EVERYTHING.settings,
          background: {
            color: null,
            imageUrl: 'https://img.example/b.png',
            size: 'huge',
            position: 'middle',
            repeat: true,
          },
          typography: { headingFont: null, bodyFont: null, textColor: null, linkColor: null },
        },
        sections: [{ id: 'Top!', type: 'section', props: { width: 'vast' }, rows: [] }],
        popups: [
          {
            ...EVERYTHING.popups[0],
            id: 'Bad id',
            props: { trigger: 'none', delaySeconds: 0, width: 'vast' },
          },
        ],
      } as unknown as typeof EVERYTHING,
      context(),
    );
    expect(page?.css).toContain(
      'body{background-image:url("https://img.example/b.png");background-repeat:repeat}',
    );
    expect(page?.html).toContain('<section class="sc"></section>');
    expect(page?.html).not.toContain('role="dialog"');
  });
});
