// @vitest-environment jsdom
// An email's formatted part between the editor and the server: merge fields as chips and as
// {{path}} text, what is pasted from an office program, the plain-text part, and what the
// editor may write at all. The allowlist below is the server's own, copied from
// packages/modules/messaging/src/email-html.ts (EMAIL_HTML_TAGS, EMAIL_STYLE_PROPERTIES and
// the attributes it keeps): whatever the editor saves must already be inside it, so that
// cleaning it on the server changes nothing.
import { describe, expect, it } from 'vitest';
import {
  chipsFromTokens,
  cleanPastedHtml,
  emailImageAddress,
  emailLinkAddress,
  htmlOfText,
  isEmptyHtml,
  mergePathsIn,
  textOfHtml,
  tokensFromChips,
} from './email-html';

const SERVER_TAGS = new Set(
  'p div h1 h2 h3 h4 h5 h6 blockquote pre ul ol li table thead tbody tfoot tr td th caption center hr span strong b em i u s strike del ins sub sup small code font a img br colgroup col'.split(
    ' ',
  ),
);
const SERVER_STYLES = new Set(
  'color background-color font font-family font-size font-style font-weight line-height letter-spacing text-align text-decoration text-indent text-transform vertical-align white-space word-break direction margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-top border-right border-bottom border-left border-color border-style border-width border-radius border-collapse border-spacing width height max-width min-width display list-style-type'.split(
    ' ',
  ),
);
const SERVER_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  '*': ['align', 'dir', 'lang', 'title', 'style'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'border'],
  table: ['width', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'role'],
  td: ['colspan', 'rowspan', 'width', 'height', 'valign', 'bgcolor'],
  ol: ['start', 'type'],
};

/** What in some HTML the server's allowlist would not keep as it is; none for clean HTML. */
function outsideAllowlist(html: string): string[] {
  const body = new DOMParser().parseFromString(`<body>${html}`, 'text/html').body;
  const found: string[] = [];
  for (const element of body.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    if (!SERVER_TAGS.has(tag)) found.push(`<${tag}>`);
    for (const name of element.getAttributeNames()) {
      const allowed = [...(SERVER_ATTRIBUTES['*'] ?? []), ...(SERVER_ATTRIBUTES[tag] ?? [])];
      if (!allowed.includes(name)) found.push(`${tag}[${name}]`);
      if (name !== 'style') continue;
      for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
        const property = declaration.split(':')[0]?.trim() ?? '';
        if (property !== '' && !SERVER_STYLES.has(property)) found.push(`${tag}{${property}}`);
      }
    }
    if (tag === 'a' && element.getAttribute('target') !== '_blank') found.push('a without target');
  }
  return found;
}

describe('merge fields as chips, and back', () => {
  const stored =
    '<p>Hi {{contact.firstName}}, your price is {{ custom_values.dj_wedding_starting_price }}.</p><p><a href="{{contact.website}}" target="_blank" rel="noopener noreferrer">Your site</a></p>';

  it('turns each {{path}} of the text into a chip, and leaves a link address alone', () => {
    const editing = chipsFromTokens(stored);
    expect(editing).toBe(
      '<p>Hi <span data-merge="contact.firstName">{{contact.firstName}}</span>, your price is <span data-merge="custom_values.dj_wedding_starting_price">{{custom_values.dj_wedding_starting_price}}</span>.</p><p><a href="{{contact.website}}" target="_blank" rel="noopener noreferrer">Your site</a></p>',
    );
    // Reading it twice makes no chip inside a chip.
    expect(chipsFromTokens(editing)).toBe(editing);
  });

  it('comes back as {{path}} text, the same as it was stored but for the spaces in braces', () => {
    expect(tokensFromChips(chipsFromTokens(stored))).toBe(
      stored.replace(
        '{{ custom_values.dj_wedding_starting_price }}',
        '{{custom_values.dj_wedding_starting_price}}',
      ),
    );
  });

  it('leaves text that only looks like a field as it is', () => {
    const html = '<p>{{not a field}} and {{nodot}} and { {contact.x} }</p>';
    expect(chipsFromTokens(html)).toBe(html);
  });

  it('keeps a chip pasted from the editor a chip, with whatever else was copied', () => {
    const copied =
      '<meta charset="utf-8"><span data-merge="contact.firstName" class="rounded-md">{{contact.firstName}}</span> and {{user.email_signature}}';
    const pasted = chipsFromTokens(cleanPastedHtml(copied));
    expect(pasted).toBe(
      '<span data-merge="contact.firstName">{{contact.firstName}}</span> and <span data-merge="user.email_signature">{{user.email_signature}}</span>',
    );
    expect(tokensFromChips(pasted)).toBe('{{contact.firstName}} and {{user.email_signature}}');
  });

  it('lists the fields text uses, each once, in order', () => {
    expect(mergePathsIn('{{b.c}} {{ a.b }} {{b.c}} {{nope}}')).toEqual(['b.c', 'a.b']);
  });
});

describe('what the editor saves', () => {
  it('takes off its own classes and data attributes, and writes a link as the server does', () => {
    const saved = tokensFromChips(
      '<p class="x" data-id="1" style="">Read <a href="https://example.com" class="link">this</a></p><p></p>',
    );
    expect(saved).toBe(
      '<p>Read <a href="https://example.com" target="_blank" rel="noopener noreferrer">this</a></p><p><br></p>',
    );
    expect(outsideAllowlist(saved)).toEqual([]);
  });

  it('writes nothing the server would strip, for everything the toolbar can make', () => {
    // As the editor's pieces write them (extensions.ts): every block and mark it has.
    const everything = [
      '<h1 style="text-align:center">Welcome</h1><h2>Two</h2><h3 style="line-height:1.5">Three</h3>',
      '<p style="text-align: right; line-height: 2;"><strong>Bold</strong> <em>italic</em> <u>under</u> <s>struck</s> <span style="color:#b91c1c">red</span> <span style="background-color:#fef08a">marked</span></p>',
      '<ul><li><p>One</p></li></ul><ol start="3"><li><p>Three</p></li></ol><hr>',
      '<img src="/m/abc123/storefront.jpg" alt="Our storefront" width="320" style="display:block;max-width:100%;height:auto;margin-left:auto;margin-right:auto">',
      '<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center"><tbody><tr><td bgcolor="#2563eb" align="center" style="border-radius:6px;padding:12px 24px"><a href="https://example.com/book" target="_blank" rel="noopener noreferrer" style="color:#ffffff;text-decoration:none;font-weight:bold;display:inline-block;line-height:24px">Book now</a></td></tr></tbody></table>',
      '<p><span data-merge="contact.firstName" class="chip">{{contact.firstName}}</span><br>line</p>',
    ].join('');
    const saved = tokensFromChips(everything);
    expect(outsideAllowlist(saved)).toEqual([]);
    expect(saved).toContain('{{contact.firstName}}<br>line');
    // A style is written as the server writes it back.
    expect(saved).toContain('<p style="text-align:right;line-height:2">');
    // And the check itself sees what the server would strip.
    expect(
      outsideAllowlist('<section onclick="x()"><p style="position:fixed">a</p></section>'),
    ).toEqual(['<section>', 'section[onclick]', 'p{position}']);
  });

  it('writes a list item without the paragraph the editor keeps its words in', () => {
    expect(
      tokensFromChips(
        '<ul><li><p>DJ</p></li><li><p style="text-align:center">Lights</p><p>All night</p></li></ul>',
      ),
    ).toBe('<ul><li>DJ</li><li><p style="text-align:center">Lights</p><p>All night</p></li></ul>');
    expect(textOfHtml(tokensFromChips('<ol><li><p>One</p></li><li><p>Two</p></li></ol>'))).toBe(
      '- One\n\n- Two',
    );
  });

  it('knows an empty message from one with words or a picture', () => {
    expect(isEmptyHtml('<p><br></p><p>  </p>')).toBe(true);
    expect(isEmptyHtml('<p>Hi</p>')).toBe(false);
    expect(isEmptyHtml('<img src="/m/a/b.png" alt="">')).toBe(false);
  });
});

describe('what is pasted from Word or Google Docs', () => {
  it('loses its style sheets, comments, classes, list markers and office elements', () => {
    const word = [
      '<html><head><meta charset="utf-8"><style>p.MsoNormal{margin:0}</style></head><body>',
      '<!--[if gte mso 9]><xml><w:WordDocument></w:WordDocument></xml><![endif]-->',
      '<p class="MsoNormal" style="mso-margin-top-alt:auto;text-align:center;tab-stops:10pt">Hello <b>there</b><o:p></o:p></p>',
      '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·<span>&nbsp;</span></span>First item</p>',
      '<script>alert(1)</script><form><input value="x"></form>',
      '</body></html>',
    ].join('');
    expect(cleanPastedHtml(word)).toBe(
      '<p style="text-align:center">Hello <b>there</b></p><p>First item</p>',
    );
  });

  it('keeps what a Google Docs wrapper holds, without its id', () => {
    const docs =
      '<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr" style="line-height:1.38;-webkit-text-decoration-skip:none"><span style="font-weight:700">Bold</span></p></b>';
    expect(cleanPastedHtml(docs)).toBe(
      '<b style="font-weight:normal"><p dir="ltr" style="line-height:1.38"><span style="font-weight:700">Bold</span></p></b>',
    );
  });
});

describe('the plain-text part', () => {
  it('is written from the formatted part as the server writes it', () => {
    const html = [
      '<h1>Welcome</h1><p>Hi {{contact.firstName}},<br>thanks   for   asking.</p>',
      '<ul><li>DJ</li><li>Lights</li></ul><hr>',
      '<p>See <a href="https://example.com/prices">our prices</a>, write to <a href="mailto:hi@example.com">hi@example.com</a> or <a href="tel:+15551234"></a>.</p>',
      '<img src="/m/a/b.png" alt="Our storefront"><img src="/m/a/c.png" alt="">',
      '<table><tbody><tr><td>Book now</td><td>Today</td></tr></tbody></table><pre>a\n  b</pre>',
    ].join('');
    expect(textOfHtml(html)).toBe(
      [
        'Welcome',
        '',
        'Hi {{contact.firstName}},',
        'thanks for asking.',
        '',
        '- DJ',
        '',
        '- Lights',
        '',
        '----------',
        '',
        'See our prices (https://example.com/prices), write to hi@example.com or +15551234.',
        '',
        '[Our storefront]',
        '',
        'Book now Today',
        '',
        'a',
        'b',
      ].join('\n'),
    );
  });

  it('becomes paragraphs when a plain-text email is formatted, and back to the same words', () => {
    const text = 'Hi {{contact.firstName}},\nthanks <for> asking & more.\n\n\nSee you soon.\n';
    const html = htmlOfText(text);
    expect(html).toBe(
      '<p>Hi {{contact.firstName}},<br>thanks &lt;for&gt; asking &amp; more.</p><p>See you soon.</p>',
    );
    expect(textOfHtml(html)).toBe(
      'Hi {{contact.firstName}},\nthanks <for> asking & more.\n\nSee you soon.',
    );
    expect(htmlOfText('  \n\n ')).toBe('');
  });
});

describe('addresses an email may hold', () => {
  it('names a picture of Media Storage by its path, and any other by https', () => {
    expect(emailImageAddress('https://crm.example/m/abc/storefront.jpg')).toBe(
      '/m/abc/storefront.jpg',
    );
    expect(emailImageAddress('http://localhost:3000/m/abc/storefront.jpg')).toBe(
      '/m/abc/storefront.jpg',
    );
    expect(emailImageAddress('/m/abc/storefront.jpg')).toBe('/m/abc/storefront.jpg');
    expect(emailImageAddress('https://cdn.example/a.png')).toBe('https://cdn.example/a.png');
  });
  it('refuses a picture a mail app would not load', () => {
    expect(emailImageAddress('http://cdn.example/a.png')).toBeUndefined();
    expect(emailImageAddress('data:image/png;base64,AAAA')).toBeUndefined();
    expect(emailImageAddress('/files/private.png')).toBeUndefined();
    expect(emailImageAddress(null)).toBeUndefined();
    expect(emailImageAddress('http://[bad')).toBeUndefined();
  });
  it('reads a link as a person means it', () => {
    expect(emailLinkAddress(' https://example.com ')).toBe('https://example.com');
    expect(emailLinkAddress('example.com/prices')).toBe('https://example.com/prices');
    expect(emailLinkAddress('hi@example.com')).toBe('mailto:hi@example.com');
    expect(emailLinkAddress('tel:+15551234')).toBe('tel:+15551234');
    expect(emailLinkAddress('{{ email.unsubscribe_link }}')).toBe('{{ email.unsubscribe_link }}');
  });
  it('refuses what is no address, and a script', () => {
    expect(emailLinkAddress('')).toBeUndefined();
    expect(emailLinkAddress('javascript:alert(1)')).toBeUndefined();
    expect(emailLinkAddress('just words')).toBeUndefined();
  });
});
