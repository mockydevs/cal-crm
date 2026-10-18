import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageText } from './inbox-text';

const html = (text: string): string => renderToStaticMarkup(<MessageText text={text} />);
/** Every element the markup holds, by tag name. */
const tags = (markup: string): string[] =>
  [...markup.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((match) => match[1] ?? '');

describe('MessageText', () => {
  it('shows markup from outside as text, never as elements', () => {
    const hostile =
      '<script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:alert(3)">click</a><iframe src="https://evil.test"></iframe>';
    const markup = html(hostile);
    // The one element besides the paragraph is the link to the plain https address the
    // text names; the iframe around that address stays text.
    expect(tags(markup)).toEqual(['p', 'a']);
    expect([...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1])).toEqual([
      'https://evil.test/',
    ]);
    expect(markup).toContain('&lt;iframe src=&quot;');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('<iframe');
  });

  it('links only http and https addresses, and makes them safe to follow', () => {
    const markup = html('Guide: https://example.test/guide?a=1&b=2 and javascript:alert(1)');
    expect(tags(markup)).toEqual(['p', 'a']);
    expect(markup).toContain(
      '<a href="https://example.test/guide?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer"',
    );
    expect(markup).toContain('>https://example.test/guide?a=1&amp;b=2</a>');
    expect(markup).toContain(' and javascript:alert(1)');
    expect([...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1])).toEqual([
      'https://example.test/guide?a=1&amp;b=2',
    ]);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:x',
    'https://user:pw@evil.test/',
  ])('never makes a link of %s', (address) => {
    const markup = html(`Open ${address} now`);
    expect(tags(markup)).toEqual(['p']);
    expect(markup).not.toContain('href');
  });

  it("can't be given an attribute through an address", () => {
    const markup = html('https://example.test/"onmouseover="alert(1)');
    expect([...markup.matchAll(/\son[a-z]+=/gi)]).toEqual([]);
    expect(markup).toContain('href="https://example.test/"');
    expect(markup).toContain('&quot;onmouseover=&quot;alert(1)');
  });

  it('keeps line breaks, as the sender wrote them', () => {
    const markup = html('Hi Dana,\n\nIs June 13 open?\n  Maya');
    expect(markup).toContain('whitespace-pre-wrap');
    expect(markup).toContain('Hi Dana,\n\nIs June 13 open?\n  Maya');
    expect(tags(markup)).toEqual(['p']);
  });
});
