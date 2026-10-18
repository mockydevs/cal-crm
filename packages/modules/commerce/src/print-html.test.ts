import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { invoice, quote, SELLER } from '../test/print-fixtures.js';
import {
  DOCUMENT_PAGE_POLICY,
  DOCUMENT_PAGE_STYLE,
  documentPage,
  escapeHtml,
  unavailablePage,
} from './print-html.js';
import { printedDocument } from './print.js';

const PATH = `/d/${'A'.repeat(43)}`;
const page = (changes: Partial<Parameters<typeof documentPage>[0]> = {}): string =>
  documentPage({
    printed: printedDocument(invoice()),
    path: PATH,
    logo: false,
    answerable: false,
    ...changes,
  });

describe('the public page of a document', () => {
  it('says what the PDF says: the number, the lines and the totals', () => {
    const html = page();
    for (const words of [
      '<title>Invoice INV-0007</title>',
      'Harbor Lights Events',
      'Thompson &amp; Daughters Ltd',
      'Event planning',
      '333.335',
      'KES 6,015.01',
      'KES 4,015.01',
      'Tax 16% on 875.01',
      'M-Pesa paybill 522522, account HARBOR.',
      'Payment within 14 days.',
    ])
      expect(html).toContain(words);
    expect(html).not.toContain('Margin is thin');
  });

  it('links to its own PDF, asks search engines to stay away, and runs no script', () => {
    const html = page();
    expect(html).toContain(`<a class="button" href="${PATH}/pdf">Download PDF</a>`);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('offers Accept and Decline only on a quote that can be answered', () => {
    const open = page({ printed: printedDocument(quote()), answerable: true });
    expect(open).toContain(`<form method="post" action="${PATH}/accept">`);
    expect(open).toContain(`<form method="post" action="${PATH}/decline">`);
    expect(page()).not.toContain('<form');
  });

  it('shows the logo from its own address, and a notice when there is one', () => {
    expect(page({ logo: true })).toContain(`<img class="logo" src="${PATH}/logo" alt="">`);
    expect(page()).not.toContain('<img');
    expect(page({ notice: 'This quote was accepted on 12 Oct 2026.' })).toContain(
      '<p class="notice" role="status">This quote was accepted on 12 Oct 2026.</p>',
    );
    expect(page()).not.toContain('class="notice"');
  });

  it('marks a draft and a void document across the sheet', () => {
    expect(page({ printed: printedDocument(invoice({ status: 'void' })) })).toContain(
      '<div class="mark" aria-hidden="true">VOID</div>',
    );
    expect(page()).not.toContain('class="mark"');
    expect(
      page({ printed: printedDocument(invoice({ status: 'draft', number: null })) }),
    ).toContain('<p class="number">Draft</p>');
  });

  it('writes everything a business or a customer typed as text', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'&';
    const html = page({
      notice: hostile,
      printed: printedDocument(
        invoice({
          notes: hostile,
          terms: hostile,
          customer: { ...invoice().customer, name: hostile, billTo: hostile },
          seller: { ...SELLER, name: hostile, paymentInstructions: hostile },
          lines: invoice().lines.map((line) => ({
            ...line,
            name: hostile,
            description: hostile,
            unit: hostile,
          })),
        }),
      ),
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;',
    );
  });

  it('leaves the table out of a document with no lines', () => {
    expect(page({ printed: { ...printedDocument(invoice()), lines: [] } })).not.toContain(
      'class="lines"',
    );
  });
});

describe('the page of an address that opens nothing', () => {
  it('says the document is no longer available, and nothing about it', () => {
    const html = unavailablePage();
    expect(html).toContain('This document is no longer available.');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('href=');
  });
});

describe('what the page may do', () => {
  it('allows its one style block by its digest, its own images and forms, and nothing else', () => {
    const digest = createHash('sha256').update(DOCUMENT_PAGE_STYLE).digest('base64');
    expect(DOCUMENT_PAGE_POLICY).toBe(
      `default-src 'none'; style-src 'sha256-${digest}'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    // The style the policy names is the one the page carries, byte for byte.
    expect(page()).toContain(`<style>${DOCUMENT_PAGE_STYLE}</style>`);
    expect(unavailablePage()).toContain(`<style>${DOCUMENT_PAGE_STYLE}</style>`);
    expect(DOCUMENT_PAGE_STYLE).not.toContain('</');
  });

  it('escapes the five characters that could end text or an attribute', () => {
    expect(escapeHtml(`a<b>c&d"e'f`)).toBe('a&lt;b&gt;c&amp;d&quot;e&#39;f');
    expect(escapeHtml('plain')).toBe('plain');
  });
});
