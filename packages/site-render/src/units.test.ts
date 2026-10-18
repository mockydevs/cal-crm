import { describe, expect, it } from 'vitest';

import { countdownStep, countdownText, MINUTE } from './countdown.js';
import { declarations, Stylesheet } from './css.js';
import {
  attribute,
  classNames,
  cssColor,
  cssFont,
  cssNumber,
  cssUrl,
  escapeHtml,
  linkAddress,
  mediaAddress,
  mergeText,
  nodeId,
  styleText,
} from './escape.js';
import {
  loadPageScripts,
  PAGE_SCRIPT_NAMES,
  pageEtag,
  pagePolicy,
  pageScriptPaths,
} from './server.js';
import { videoEmbedUrl } from './video.js';

const BASE = '/s/key';

describe('escaping', () => {
  it('writes the characters that end text or an attribute as references', () => {
    expect(escapeHtml(`<a href="x" title='y'>&\u0000</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;�&lt;/a&gt;',
    );
    expect(attribute('alt', '" onerror="alert(1)')).toBe(' alt="&quot; onerror=&quot;alert(1)"');
  });

  it('fills merge fields in text, and shows nothing for one with no value', () => {
    const values = new Map([['custom_values.name', '<Acme>']]);
    expect(mergeText('Hi {{custom_values.name}}{{custom_values.none}}!', values)).toBe(
      'Hi <Acme>!',
    );
    expect(mergeText('Hi {{custom_values.name}}', undefined)).toBe('Hi ');
    expect(mergeText('{{ Not_a_field }}', values)).toBe('{{ Not_a_field }}');
  });

  it('lets a link go to the web, mail, a phone, this site and this page, and nowhere else', () => {
    expect(linkAddress('https://example.com/a?b=1&c=2', BASE)).toBe(
      'https://example.com/a?b=1&c=2',
    );
    expect(linkAddress('HTTP://example.com', BASE)).toBe('HTTP://example.com');
    expect(linkAddress('mailto:a@example.com', BASE)).toBe('mailto:a@example.com');
    expect(linkAddress('tel:+254700000000', BASE)).toBe('tel:+254700000000');
    expect(linkAddress('/pricing', BASE)).toBe('/s/key/pricing');
    expect(linkAddress('#top', BASE)).toBe('#top');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.example/x',
      '/\\evil.example',
      'https://example.com/"onmouseover="alert(1)',
      "https://example.com/'x",
      'https://example.com/<svg>',
      'https://example.com/a b',
      'https://example.com/`x`',
      'ftp://example.com',
      'example.com',
      '',
      `https://example.com/${'a'.repeat(2000)}`,
      null,
      7,
    ])
      expect(linkAddress(bad, BASE)).toBeUndefined();
  });

  it('takes a merge field for an address only when what it stands for is an address', () => {
    const values = new Map([
      ['custom_values.site', 'https://example.com'],
      ['custom_values.bad', 'javascript:alert(1)'],
    ]);
    expect(linkAddress('{{custom_values.site}}', BASE, values)).toBe('https://example.com');
    expect(linkAddress('{{custom_values.bad}}', BASE, values)).toBeUndefined();
    expect(linkAddress('{{custom_values.none}}', BASE, values)).toBeUndefined();
    expect(mediaAddress('{{custom_values.site}}', BASE, values)).toBe('https://example.com');
    expect(mediaAddress('{{custom_values.none}}', BASE)).toBeUndefined();
  });

  it('reads media only from a secure address or a path on this site', () => {
    expect(mediaAddress('https://img.example/a.png', BASE)).toBe('https://img.example/a.png');
    expect(mediaAddress('/a.png', BASE)).toBe('/s/key/a.png');
    for (const bad of [
      'http://img.example/a.png',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'javascript:alert(1)',
      '//img.example/a.png',
      'https://img.example/a.png" onerror="alert(1)',
      '',
      `https://img.example/${'a'.repeat(2000)}`,
      null,
    ])
      expect(mediaAddress(bad, BASE)).toBeUndefined();
  });

  it('keeps ids, class names, colours, fonts and numbers to their own alphabets', () => {
    expect(nodeId('top_1-a')).toBe('top_1-a');
    expect(nodeId('Top')).toBeUndefined();
    expect(nodeId(1)).toBeUndefined();
    expect(classNames('hero big-1')).toBe('hero big-1');
    expect(classNames('hero" onclick="x')).toBe('');
    expect(classNames(undefined)).toBe('');
    expect(cssColor('#1F2937')).toBe('#1F2937');
    expect(cssColor('transparent')).toBe('transparent');
    expect(cssColor('red;}</style>')).toBeUndefined();
    expect(cssColor(null)).toBeUndefined();
    expect(cssFont('Open Sans')).toBe('"Open Sans",system-ui,sans-serif');
    expect(cssFont('x";}</style>')).toBeUndefined();
    expect(cssNumber(1.23456, 0, 2)).toBe('1.235');
    expect(cssNumber(3, 0, 2)).toBeUndefined();
    expect(cssNumber(-1, 0, 2)).toBeUndefined();
    expect(cssNumber(Number.NaN, 0, 2)).toBeUndefined();
    expect(cssNumber('1', 0, 2)).toBeUndefined();
    expect(cssUrl('https://img.example/a(1).png')).toBe('url("https://img.example/a%281%29.png")');
    expect(styleText('a{}\r\nb{}\rc{}\u0000')).toBe('a{}\nb{}\nc{}�');
    expect(styleText('a{}</style><script>alert(1)</script>')).toBe(
      'a{}\\3c /style>\\3c script>alert(1)\\3c /script>',
    );
  });
});

describe('declarations', () => {
  const context = { siteBase: BASE };

  it('writes each property from a checked value and drops the rest', () => {
    expect(
      declarations(
        {
          margin: { top: 1, right: 2, bottom: 3, left: 4 },
          padding: { top: 'x', left: 5000 },
          backgroundColor: '#fff',
          backgroundImageUrl: 'javascript:alert(1)',
          backgroundSize: 'cover',
          textColor: 'expression(alert(1))',
          fontFamily: 'Lexend',
          fontSize: '12px;}</style>',
          fontWeight: 700,
          lineHeight: 1.5,
          letterSpacing: 1,
          textAlign: 'center;color:red',
          textTransform: 'uppercase',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: '#000',
          borderRadius: 4,
          shadow: 'large',
          width: { value: 50, unit: '%' },
          maxWidth: { value: 10, unit: 'em' },
          minHeight: { value: -1, unit: 'px' },
          opacity: 0.5,
          align: 'end',
          position: 'fixed',
        },
        context,
      ),
    ).toEqual([
      'margin-top:1px',
      'margin-right:2px',
      'margin-bottom:3px',
      'margin-left:4px',
      'background-color:#fff',
      'background-size:cover',
      'font-family:"Lexend",system-ui,sans-serif',
      'font-weight:700',
      'line-height:1.5',
      'letter-spacing:1px',
      'text-transform:uppercase',
      'border-width:1px',
      'border-style:solid',
      'border-color:#000',
      'border-radius:4px',
      'box-shadow:0 12px 32px rgba(0,0,0,.2)',
      'width:50%',
      'opacity:0.5',
      'align-self:flex-end',
    ]);
    expect(
      declarations({ backgroundImageUrl: '/a.png', shadow: 'huge', align: 'up' }, context),
    ).toEqual([
      'background-image:url("/s/key/a.png")',
      'background-position:center',
      'background-repeat:no-repeat',
    ]);
    for (const nothing of [undefined, null, 'x', [1], 3])
      expect(declarations(nothing, context)).toEqual([]);
    expect(declarations({ margin: 'x', width: 'x', shadow: 3, align: 3 }, context)).toEqual([]);
  });

  it('gathers rules in the order a narrower screen wins', () => {
    const sheet = new Stylesheet();
    const name = sheet.name();
    sheet.node(name, { style: {}, hidden: { desktop: true } }, context);
    sheet.rule('body', []);
    expect(sheet.toString()).toBe('@media (min-width:1025px){.e1{display:none!important}}');
    expect(new Stylesheet().toString()).toBe('');
    const other = new Stylesheet();
    other.node('x', 'not a node', context, ['gap:1px']);
    expect(other.toString()).toBe('.x{gap:1px}');
  });
});

describe('videoEmbedUrl', () => {
  const video = (source: string, url: unknown, flags: Record<string, boolean> = {}) =>
    videoEmbedUrl({ source, url, ...flags });

  it('builds YouTube’s player address from the video’s id alone', () => {
    const id = 'M7lc1UVf-VE';
    for (const url of [
      `https://www.youtube.com/watch?v=${id}&t=1`,
      `https://youtube.com/watch?v=${id}`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?si=x`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/shorts/${id}`,
    ])
      expect(video('youtube', url)).toBe(`https://www.youtube.com/embed/${id}`);
    expect(
      video('youtube', `https://youtu.be/${id}`, {
        autoplay: true,
        controls: false,
        loop: true,
        muted: true,
      }),
    ).toBe(`https://www.youtube.com/embed/${id}?autoplay=1&controls=0&loop=1&playlist=${id}`);
  });

  it('builds Vimeo’s player address from the video’s id alone', () => {
    expect(video('vimeo', 'https://vimeo.com/76979871')).toBe(
      'https://player.vimeo.com/video/76979871',
    );
    expect(video('vimeo', 'https://www.vimeo.com/76979871/abc')).toBe(
      'https://player.vimeo.com/video/76979871',
    );
    expect(
      video('vimeo', 'https://player.vimeo.com/video/76979871?h=1', {
        autoplay: true,
        muted: true,
        loop: true,
        controls: false,
      }),
    ).toBe('https://player.vimeo.com/video/76979871?autoplay=1&muted=1&loop=1&controls=0');
  });

  it('gives nothing for an address that is not one of theirs', () => {
    for (const [source, url] of [
      ['youtube', 'https://www.youtube.com/watch?v="><script>'],
      ['youtube', 'https://www.youtube.com/watch'],
      ['youtube', 'https://www.youtube.com/channel/abc123def45'],
      ['youtube', 'https://youtube.com.evil.example/watch?v=M7lc1UVf-VE'],
      ['youtube', 'http://www.youtube.com/watch?v=M7lc1UVf-VE'],
      ['youtube', 'https://youtu.be/'],
      ['youtube', 'not a url'],
      ['youtube', null],
      ['vimeo', 'https://vimeo.com/channels/staffpicks'],
      ['vimeo', 'https://player.vimeo.com/76979871'],
      ['vimeo', 'https://vimeo.com/'],
      ['vimeo', 'https://example.com/76979871'],
      ['file', 'https://vimeo.com/76979871'],
    ] as const)
      expect(video(source, url)).toBeUndefined();
  });
});

describe('the time left of a countdown', () => {
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;

  it('is written in whole units, with days only when there are some', () => {
    expect(countdownText(2 * D + 3 * H + 14 * M + 9 * S + 999, true)).toBe('2d 03h 14m 09s');
    expect(countdownText(2 * D + 3 * H + 14 * M + 9 * S + 999, false)).toBe('2d 03h 14m');
    expect(countdownText(3 * H + 5 * S, true)).toBe('03h 00m 05s');
    expect(countdownText(D, false)).toBe('1d 00h 00m');
    expect(countdownText(S, true)).toBe('00h 00m 01s');
    expect(countdownText(999, true)).toBe('00h 00m 00s');
  });

  it('says the last minute in words when it has no seconds to count', () => {
    expect(countdownText(M, false)).toBe('00h 01m');
    expect(countdownText(M - 1, false)).toBe('under 1m');
    expect(countdownText(1, false)).toBe('under 1m');
  });

  it('is the end for anything that is not a time still to come', () => {
    for (const over of [0, -1, -D, Number.NaN, Number.POSITIVE_INFINITY])
      expect(countdownText(over, true)).toBe('00h 00m 00s');
    expect(countdownText(-5, false)).toBe('under 1m');
  });

  it('is an instant less an instant: a clock change in between adds and takes nothing', () => {
    // New York leaves daylight saving time on 1 November 2026 at 06:00 UTC: the wall
    // clock there shows 01:30 twice. From 00:30 local (04:30 UTC) to 03:30 local
    // (08:30 UTC) is four hours, though the clock's face moves three.
    const from = Date.parse('2026-11-01T00:30:00-04:00');
    const end = Date.parse('2026-11-01T03:30:00-05:00');
    expect(countdownText(end - from, true)).toBe('04h 00m 00s');
    // And the same instant written in two zones is no time apart.
    expect(Date.parse('2026-12-01T09:05:00Z') - Date.parse('2026-12-01T04:05:00-05:00')).toBe(0);
  });

  it('changes next when a second or a minute turns, and never after the end', () => {
    expect(countdownStep(5300, true)).toBe(301);
    expect(countdownStep(5000, true)).toBe(1);
    expect(countdownStep(3 * M + 20 * S, false)).toBe(20 * S + 1);
    // The whole last minute reads the same, so nothing changes until the end itself.
    expect(countdownStep(M, false)).toBe(M);
    expect(countdownStep(40 * S, false)).toBe(40 * S);
    expect(countdownStep(200, true)).toBe(200);
    expect(countdownStep(0, true)).toBe(1);
    expect(MINUTE).toBe(M);
  });
});

describe('the small page scripts as the server loads them', () => {
  it('finds none where none was built, and pages then name none', () => {
    const files = loadPageScripts(new URL('./no-such-folder/', import.meta.url));
    expect(files).toEqual([]);
    expect(pageScriptPaths(files, '/s/_js')).toEqual({});
    expect(PAGE_SCRIPT_NAMES).toEqual(['arrival', 'countdown', 'popup']);
  });

  it('allows a script of this address only on a page that names one, and no connection', () => {
    const none = { forms: false, frames: [], media: false, scripts: [] };
    const policy = pagePolicy(
      { css: 'a{}', needs: { ...none, scripts: ['/s/_js/countdown.0123456789abcdef.js'] } },
      { frameAncestors: 'none' },
    );
    expect(policy).toContain("; script-src 'self'; ");
    expect(policy).not.toContain('connect-src');
    expect(policy).not.toContain('unsafe');
    expect(pagePolicy({ css: 'a{}', needs: none }, { frameAncestors: 'none' })).not.toContain(
      'script-src',
    );
  });
});

describe('what the server sends with a page', () => {
  const needs = { forms: false, frames: [], media: false, scripts: [] };

  it('allows nothing a page does not need', () => {
    expect(pagePolicy({ css: 'a{}', needs }, { frameAncestors: 'none' })).toBe(
      "default-src 'none'; style-src 'sha256-X1RutGBrXCt9KkSaXMK7tHftWiRscFHOhxsS8tv8hBk='; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(
      pagePolicy(
        {
          css: 'a{}',
          needs: { forms: true, frames: ['https://www.youtube.com'], media: true, scripts: [] },
        },
        { frameAncestors: 'self' },
      ),
    ).toBe(
      "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'sha256-X1RutGBrXCt9KkSaXMK7tHftWiRscFHOhxsS8tv8hBk='; img-src 'self' https:; media-src 'self' https:; frame-src https://www.youtube.com; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    );
  });

  it('tags the same bytes the same way, and other bytes another', () => {
    expect(pageEtag('<p>a</p>')).toBe(pageEtag('<p>a</p>'));
    expect(pageEtag('<p>a</p>')).not.toBe(pageEtag('<p>b</p>'));
    expect(pageEtag('')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });
});
