import { describe, expect, it } from 'vitest';

import {
  cleanEmailImage,
  cleanEmailLink,
  cleanEmailStyle,
  EMAIL_HTML_MAX_DEPTH,
  emailHtmlIsEmpty,
  emailTextOf,
  finalEmailHtml,
  sanitizeEmailHtml,
} from './email-html.js';

const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);

describe('sanitizeEmailHtml keeps formatting', () => {
  it.each([
    ['<p>Hello <strong>Ada</strong></p>', '<p>Hello <strong>Ada</strong></p>'],
    ['<h1>Title</h1><h6>Small</h6>', '<h1>Title</h1><h6>Small</h6>'],
    ['<em>a</em><i>b</i><u>c</u><s>d</s><b>e</b>', '<em>a</em><i>b</i><u>c</u><s>d</s><b>e</b>'],
    [
      '<ul><li>One</li></ul><ol start="3"><li>Two</li></ol>',
      '<ul><li>One</li></ul><ol start="3"><li>Two</li></ol>',
    ],
    ['line<br>break<hr>', 'line<br>break<hr>'],
    ['<blockquote>q</blockquote><pre>  p</pre>', '<blockquote>q</blockquote><pre>  p</pre>'],
    [
      '<p style="text-align:center;line-height:1.5">x</p>',
      '<p style="text-align:center;line-height:1.5">x</p>',
    ],
    [
      '<span style="color:#ff0000;background-color:rgb(1, 2, 3)">x</span>',
      '<span style="color:#ff0000;background-color:rgb(1, 2, 3)">x</span>',
    ],
    ['<p>Hi {{contact.firstName}}</p>', '<p>Hi {{contact.firstName}}</p>'],
    [
      '<font color="#333333" face="Arial" size="3">x</font>',
      '<font color="#333333" face="Arial" size="3">x</font>',
    ],
    [
      '<table width="100%" cellpadding="0" role="presentation"><tbody><tr><td colspan="2" valign="top">x</td></tr></tbody></table>',
      '<table width="100%" cellpadding="0" role="presentation"><tbody><tr><td colspan="2" valign="top">x</td></tr></tbody></table>',
    ],
    ['a &amp; b &lt;c&gt;', 'a &amp; b &lt;c&gt;'],
  ])('%s', (input, output) => {
    expect(sanitizeEmailHtml(input)).toBe(output);
  });

  it('gives a link a new tab and no referrer', () => {
    expect(
      sanitizeEmailHtml('<a href="https://example.com/a?b=1&amp;c=2" target="_top">x</a>'),
    ).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it.each([
    ['mailto:ada@example.com'],
    ['tel:+15551234567'],
    ['http://example.com'],
    ['{{trigger_link.book}}'],
    ['{{ email.unsubscribe_link }}'],
    ['https://example.com/?e={{contact.email}}'],
  ])('keeps the address %s', (address) => {
    expect(sanitizeEmailHtml(`<a href="${address}">x</a>`)).toContain(`href="${address}"`);
  });

  it('keeps a button written as a styled link', () => {
    const button =
      '<a href="https://example.com" style="display:inline-block;padding:12px 24px;background-color:#0b5fff;color:#ffffff;border-radius:6px;text-decoration:none" target="_blank" rel="noopener noreferrer">Book now</a>';
    expect(sanitizeEmailHtml(button)).toBe(button);
  });

  it('is the same when run again on its own output', () => {
    const once = sanitizeEmailHtml(
      '<div onclick="x()"><p style="color:red;position:fixed">a<script>1</script><img src="https://x.test/a.png" alt="A"></p></div>',
    );
    expect(sanitizeEmailHtml(once)).toBe(once);
    expect(once).toBe(
      '<div><p style="color:red">a<img src="https://x.test/a.png" alt="A"></p></div>',
    );
  });
});

describe('sanitizeEmailHtml removes what is not formatting', () => {
  it.each([
    ['a script', '<p>a</p><script>alert(1)</script>', '<p>a</p>'],
    ['a script in capitals', '<SCRIPT SRC=//x.test/x.js></SCRIPT>b', 'b'],
    ['a style sheet', '<style>p{color:red}</style><p>a</p>', '<p>a</p>'],
    [
      'a linked style sheet',
      '<link rel="stylesheet" href="https://x.test/a.css"><p>a</p>',
      '<p>a</p>',
    ],
    ['an event handler', '<p onclick="alert(1)" onmouseover=x()>a</p>', '<p>a</p>'],
    [
      'an image error handler',
      '<img src="https://x.test/a.png" onerror="alert(1)">',
      '<img src="https://x.test/a.png">',
    ],
    ['an image with no address left', '<img src=x onerror=alert(1)>', ''],
    ['a javascript link', '<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['a javascript link in mixed case', '<a href="JaVaScRiPt:alert(1)">x</a>', '<a>x</a>'],
    [
      'a javascript link with a tab inside',
      `<a href="java${TAB}script:alert(1)">x</a>`,
      '<a>x</a>',
    ],
    [
      'a javascript link written with entities',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a>x</a>',
    ],
    ['a javascript link after a space', '<a href=" javascript:alert(1)">x</a>', '<a>x</a>'],
    [
      'a javascript link after a control character',
      `<a href="${NUL}javascript:alert(1)">x</a>`,
      '<a>x</a>',
    ],
    ['a data link', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', '<a>x</a>'],
    ['a vbscript link', '<a href="vbscript:msgbox(1)">x</a>', '<a>x</a>'],
    ['a relative link', '<a href="/login">x</a>', '<a>x</a>'],
    ['a protocol-relative link', '<a href="//x.test/a">x</a>', '<a>x</a>'],
    ['a frame', '<iframe src="https://x.test"></iframe>a', 'a'],
    ['an object and an embed', '<object data="x"></object><embed src="x">a', 'a'],
    [
      'a form, keeping its words',
      '<form action="https://x.test"><p>Name</p><input name="a"><button>Go</button></form>',
      '<p>Name</p>',
    ],
    ['a select and a textarea', '<select><option>a</option></select><textarea>b</textarea>c', 'c'],
    ['an svg with a script', '<svg><script>alert(1)</script><circle r="1"/></svg>a', 'a'],
    ['an svg load handler', '<svg onload="alert(1)"></svg>a', 'a'],
    ['math', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>a', 'a'],
    ['a comment', 'a<!-- hidden -->b', 'ab'],
    ['a conditional comment', 'a<!--[if mso]><p>x</p><![endif]-->b', 'ab'],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://x.test">a', 'a'],
    ['a base address', '<base href="https://x.test/">a', 'a'],
    ['a class and an id', '<p class="x" id="y">a</p>', '<p>a</p>'],
    ['an unknown tag, keeping its words', '<marquee>a</marquee><custom-tag>b</custom-tag>', 'ab'],
    [
      'a pasted page, keeping its body',
      '<html><head><title>T</title></head><body><p>a</p></body></html>',
      '<p>a</p>',
    ],
    ['a noscript', '<noscript><p>a</p></noscript>b', 'b'],
    ['a template', '<template><p>a</p></template>b', 'b'],
    ['a data image', '<img src="data:image/png;base64,AAAA">', ''],
    ['an http image', '<img src="http://x.test/a.png">', ''],
    ['a cid image', '<img src="cid:logo">', ''],
    ['a media address that climbs', '<img src="/m/../admin">', ''],
    ['a mutation attempt through a title', '<title><img src=x onerror=alert(1)></title>a', 'a'],
    [
      'a mutation attempt through noscript',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '"&gt;',
    ],
    [
      'an attribute that would close its quote',
      '<p title="&quot;><script>alert(1)</script>">a</p>',
      '<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">a</p>',
    ],
    [
      'a doubled attribute',
      '<a href="https://ok.test" href="javascript:alert(1)">x</a>',
      '<a href="https://ok.test" target="_blank" rel="noopener noreferrer">x</a>',
    ],
    [
      'an srcset',
      '<img src="https://x.test/a.png" srcset="javascript:alert(1) 1x">',
      '<img src="https://x.test/a.png">',
    ],
    ['a background attribute', '<td background="https://x.test/a.png">a</td>', '<td>a</td>'],
  ])('%s', (_name, input, output) => {
    expect(sanitizeEmailHtml(input)).toBe(output);
  });

  it('keeps an image from the media library or an https address', () => {
    expect(sanitizeEmailHtml('<img src="/m/abc123/logo.png" alt="Logo" width="120">')).toBe(
      '<img src="/m/abc123/logo.png" alt="Logo" width="120">',
    );
    expect(sanitizeEmailHtml('<img src="https://x.test/a.png">')).toBe(
      '<img src="https://x.test/a.png">',
    );
  });

  it('keeps only the text below the deepest level it writes', () => {
    const deep = `${'<div>'.repeat(EMAIL_HTML_MAX_DEPTH + 5)}<b>x</b>${'</div>'.repeat(EMAIL_HTML_MAX_DEPTH + 5)}`;
    const cleaned = sanitizeEmailHtml(deep);
    expect(cleaned).toContain('x');
    expect(cleaned).not.toContain('<b>');
    expect(cleaned.match(/<div>/g)?.length).toBe(EMAIL_HTML_MAX_DEPTH + 1);
  });
});

describe('cleanEmailStyle', () => {
  it.each([
    ['color: red; font-size: 14px', 'color:red;font-size:14px'],
    ['COLOR: #FFF !important', 'color:#FFF'],
    [
      'font-family: Arial, "Helvetica Neue", sans-serif',
      'font-family:Arial, "Helvetica Neue", sans-serif',
    ],
    [
      'background-color: rgba(0, 0, 0, 0.5); color: hsl(10, 50%, 50%)',
      'background-color:rgba(0, 0, 0, 0.5);color:hsl(10, 50%, 50%)',
    ],
    ['margin: 0 auto; padding: 4px 8px', 'margin:0 auto;padding:4px 8px'],
    ['border: 1px solid #cccccc; border-radius: 4px', 'border:1px solid #cccccc;border-radius:4px'],
    ['display: none', 'display:none'],
    ['display: inline-block', 'display:inline-block'],
    // What is not kept.
    ['background: url(https://x.test/a.png)', ''],
    ['background-image: url("javascript:alert(1)")', ''],
    ['color: red; background-color: url(x)', 'color:red'],
    ['width: expression(alert(1))', ''],
    ['width: calc(100% - 1px)', ''],
    ['color: var(--x)', ''],
    ['position: fixed; top: 0', ''],
    ['z-index: 9999', ''],
    ['display: flex', ''],
    ['behavior: url(x.htc)', ''],
    ['-moz-binding: url(x)', ''],
    ['color: red /* c */', ''],
    ['color: \\72 ed', ''],
    ['@import "x.css"', ''],
    ['font-family: x; } body { color: red', 'font-family:x'],
    ['color', ''],
    ['', ''],
  ])('%s', (input, output) => {
    expect(cleanEmailStyle(input)).toBe(output);
  });
});

describe('addresses', () => {
  it('reads a link as a browser would before judging it', () => {
    expect(cleanEmailLink(' https://x.test ')).toBe('https://x.test');
    expect(cleanEmailLink(`ht${TAB}tps://x.test`)).toBe('https://x.test');
    expect(cleanEmailLink('HTTPS://X.TEST')).toBe('HTTPS://X.TEST');
    expect(cleanEmailLink('ftp://x.test')).toBeUndefined();
    expect(cleanEmailLink('https:x')).toBeUndefined();
    expect(cleanEmailLink('{{contact.email}} and more')).toBeUndefined();
    expect(cleanEmailLink('')).toBeUndefined();
  });

  it('keeps an image only from https or the media library', () => {
    expect(cleanEmailImage('https://x.test/a.png')).toBe('https://x.test/a.png');
    expect(cleanEmailImage('/m/key/a.png')).toBe('/m/key/a.png');
    expect(cleanEmailImage('/media/a.png')).toBeUndefined();
    expect(cleanEmailImage('/m/a b.png')).toBeUndefined();
    expect(cleanEmailImage('{{contact.photo}}')).toBeUndefined();
  });
});

describe('emailHtmlIsEmpty', () => {
  it('is empty with no text and no image', () => {
    expect(emailHtmlIsEmpty('<p> </p><br>')).toBe(true);
    expect(emailHtmlIsEmpty('')).toBe(true);
    expect(emailHtmlIsEmpty('<p>a</p>')).toBe(false);
    expect(emailHtmlIsEmpty('<p><img src="https://x.test/a.png"></p>')).toBe(false);
  });
});

describe('emailTextOf', () => {
  it('writes paragraphs, lists, links and images as text', () => {
    expect(
      emailTextOf(
        '<h1>Hello {{contact.firstName}}</h1><p>Your   booking is <strong>confirmed</strong>.<br>See you soon.</p>' +
          '<ul><li>One</li><li>Two</li></ul>' +
          '<p><a href="https://example.com/book">Book again</a> or <a href="mailto:hi@example.com">hi@example.com</a></p>' +
          '<p><img src="https://x.test/a.png" alt="Our logo"><a href="https://example.com"></a></p>',
      ),
    ).toBe(
      [
        'Hello {{contact.firstName}}',
        '',
        'Your booking is confirmed.',
        'See you soon.',
        '',
        '- One',
        '- Two',
        '',
        'Book again (https://example.com/book) or hi@example.com',
        '',
        '[Our logo]https://example.com',
      ].join('\n'),
    );
  });

  it('keeps the lines of preformatted text and separates table cells and rules', () => {
    expect(emailTextOf('<pre>a\n  b</pre>')).toBe('a\n  b');
    expect(emailTextOf('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>')).toBe(
      'a b\nc',
    );
    expect(emailTextOf('a<hr>b')).toBe('a\n\n----------\n\nb');
    expect(emailTextOf(`a${String.fromCharCode(160)}b<script>x</script><!-- c -->`)).toBe('a b');
    expect(emailTextOf('<img src="https://x.test/a.png">')).toBe('');
  });

  it('stops below the deepest level', () => {
    const deep = `${'<div>'.repeat(EMAIL_HTML_MAX_DEPTH + 5)}x${'</div>'.repeat(EMAIL_HTML_MAX_DEPTH + 5)}top`;
    expect(emailTextOf(deep)).toBe('top');
  });
});

describe('finalEmailHtml', () => {
  it('gives a media library image the install’s address', () => {
    expect(finalEmailHtml('<p><img src="/m/k/a.png" alt="A"></p>', 'https://crm.example/app')).toBe(
      '<p><img src="https://crm.example/m/k/a.png" alt="A"></p>',
    );
  });

  it('sends no media library image without a public https address', () => {
    expect(finalEmailHtml('<p>a<img src="/m/k/a.png"></p>', undefined)).toBe('<p>a</p>');
    expect(finalEmailHtml('<p>a<img src="/m/k/a.png"></p>', 'not a url')).toBe('<p>a</p>');
    expect(finalEmailHtml('<p>a<img src="/m/k/a.png"></p>', 'http://localhost:3000')).toBe(
      '<p>a</p>',
    );
  });

  it('removes an address a merge value turned into a script', () => {
    expect(
      finalEmailHtml(
        '<a href="javascript:alert(1)">x</a><img src="https://x.test/a.png">',
        undefined,
      ),
    ).toBe('<a>x</a><img src="https://x.test/a.png">');
  });
});
