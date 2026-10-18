import { describe, expect, it } from 'vitest';

import { admittedOrigin, pageOfOrigin } from './origin.js';

describe('the website a tracking request comes from', () => {
  it('is any secure website while none are listed, as GoHighLevel’s script answers anywhere', () => {
    expect(admittedOrigin('https://www.example.com', [])).toBe('https://www.example.com');
    expect(admittedOrigin('http://localhost:8080', [])).toBe('http://localhost:8080');
  });

  it('is a listed website or a subdomain of one', () => {
    const listed = ['example.com'];
    expect(admittedOrigin('https://example.com', listed)).toBe('https://example.com');
    expect(admittedOrigin('https://shop.example.com', listed)).toBe('https://shop.example.com');
    expect(admittedOrigin('https://badexample.com', listed)).toBeUndefined();
    expect(admittedOrigin('https://example.com.evil.test', listed)).toBeUndefined();
  });

  it('is never a page with no origin, an insecure one, or a header that is not one', () => {
    for (const header of [
      undefined,
      '',
      'null',
      ['https://a.com'],
      'http://example.com',
      'https://a.com/path',
      42,
    ])
      expect(admittedOrigin(header, []), String(header)).toBeUndefined();
  });
});

describe('the page a tracking request names', () => {
  it('is read only when it is on the website the request came from', () => {
    expect(
      pageOfOrigin(
        'https://www.example.com/pricing?utm_source=x&email=a@b.c#top',
        'https://www.example.com',
      ),
    ).toEqual({
      host: 'www.example.com',
      path: '/pricing',
    });
    expect(pageOfOrigin('https://other.test/pricing', 'https://www.example.com')).toBeUndefined();
    expect(pageOfOrigin('not a url', 'https://www.example.com')).toBeUndefined();
  });
});
