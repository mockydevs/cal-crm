import { describe, expect, it } from 'vitest';

import { pageAddress, readDomains, scriptTag } from './rules';

describe('the script to copy', () => {
  it('is GoHighLevel’s tag, pointed at this CRM, with the business’s tracking id', () => {
    expect(scriptTag('https://crm.example.com', `tk_${'a1'.repeat(16)}`)).toBe(
      `<script src="https://crm.example.com/tracking/external-tracking.js" data-tracking-id="tk_${'a1'.repeat(16)}"></script>`,
    );
  });
});

describe('the websites typed in Settings', () => {
  it('are one a line or comma, lowercased, without addresses around them, each once', () => {
    expect(
      readDomains(' Example.com\nhttps://shop.example.com/cart, www.other.org\n\nexample.com'),
    ).toEqual({
      domains: ['example.com', 'shop.example.com', 'www.other.org'],
      invalid: [],
    });
  });

  it('say which are not a website', () => {
    expect(readDomains('example.com\nnot a domain\nlocalhost')).toEqual({
      domains: ['example.com'],
      invalid: ['not a domain', 'localhost'],
    });
  });
});

describe('a page in Troubleshoot', () => {
  it('is its host and path', () => {
    expect(pageAddress({ pageHost: 'www.acme.example', pagePath: '/' })).toBe('www.acme.example/');
  });
});
