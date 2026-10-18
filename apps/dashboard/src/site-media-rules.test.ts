import { pageDocument, PAGE_DOCUMENT_LIMITS, EMPTY_PAGE_DOCUMENT } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  altStateOf,
  isLinkAddress,
  isMeasurable,
  isMediaAddress,
  MAX_PICTURE_SIDE,
  pageAddressOf,
  pictureSize,
  storedSize,
} from './site-media-rules';

describe('pageAddressOf', () => {
  it('gives a public file’s public address, which is what a page keeps', () => {
    expect(
      pageAddressOf({ public: true, publicUrl: 'https://crm.example/m/k4v9x2/storefront.jpg' }),
    ).toStrictEqual({ ok: true, address: 'https://crm.example/m/k4v9x2/storefront.jpg' });
  });

  it('says a private file has none yet: it can be given one', () => {
    expect(pageAddressOf({ public: false, publicUrl: null })).toStrictEqual({
      ok: false,
      reason: 'private',
    });
    // An answer that says public with no address has no address to keep either.
    expect(pageAddressOf({ public: true, publicUrl: null })).toStrictEqual({
      ok: false,
      reason: 'private',
    });
    // Nor is an address trusted that the server says is not public.
    expect(pageAddressOf({ public: false, publicUrl: 'https://crm.example/m/k/a.jpg' })).toEqual({
      ok: false,
      reason: 'private',
    });
  });

  it('refuses an address a page does not take: plain http, or one with markup in it', () => {
    for (const publicUrl of [
      'http://localhost:3000/m/k4v9x2/storefront.jpg',
      'https://crm.example/m/k/a b.jpg',
      'https://crm.example/m/k/"a".jpg',
      `https://crm.example/m/k/${'a'.repeat(2000)}.jpg`,
      '/m/k4v9x2/storefront.jpg',
    ])
      expect(pageAddressOf({ public: true, publicUrl }), publicUrl).toStrictEqual({
        ok: false,
        reason: 'insecure',
      });
  });
});

describe('addresses', () => {
  it('takes for a picture what the page document takes, and for a link what it takes there', () => {
    expect(isMediaAddress('https://example.com/a.png')).toBe(true);
    expect(isMediaAddress('/a.png')).toBe(true);
    expect(isMediaAddress('{{custom_values.logo}}')).toBe(true);
    expect(isMediaAddress('http://example.com/a.png')).toBe(false);
    expect(isMediaAddress('//example.com/a.png')).toBe(false);
    expect(isMediaAddress('javascript:alert(1)')).toBe(false);
    expect(isLinkAddress('http://example.com')).toBe(true);
    expect(isLinkAddress('mailto:a@example.com')).toBe(true);
    expect(isLinkAddress('#top')).toBe(true);
    expect(isLinkAddress('javascript:alert(1)')).toBe(false);
  });

  it('measures only a full web address', () => {
    expect(isMeasurable('https://example.com/a.png')).toBe(true);
    expect(isMeasurable('/a.png')).toBe(false);
    expect(isMeasurable('{{custom_values.logo}}')).toBe(false);
    expect(isMeasurable('http://example.com/a.png')).toBe(false);
    expect(isMeasurable(null)).toBe(false);
  });
});

describe('pictureSize', () => {
  it('keeps a picture’s own size in whole pixels', () => {
    expect(pictureSize({ width: 1200, height: 800 })).toStrictEqual({ width: 1200, height: 800 });
    expect(pictureSize({ width: 1199.6, height: 800.4 })).toStrictEqual({
      width: 1200,
      height: 800,
    });
    expect(pictureSize({ width: 1, height: 1 })).toStrictEqual({ width: 1, height: 1 });
  });

  it('has none for a picture that did not load, has no size of its own, or is too large', () => {
    // A picture that fails reports 0 by 0; so does an SVG with no size of its own.
    expect(pictureSize({ width: 0, height: 0 })).toBeNull();
    expect(pictureSize({ width: 300, height: 0 })).toBeNull();
    expect(pictureSize({ width: 0.4, height: 200 })).toBeNull();
    expect(pictureSize({ width: Number.NaN, height: 200 })).toBeNull();
    expect(pictureSize({ width: Number.POSITIVE_INFINITY, height: 200 })).toBeNull();
    expect(pictureSize({ width: MAX_PICTURE_SIDE + 1, height: 200 })).toBeNull();
    expect(pictureSize({ width: MAX_PICTURE_SIDE, height: MAX_PICTURE_SIDE })).not.toBeNull();
  });

  it('gives what the page document takes, at its bound and not past it', () => {
    expect(MAX_PICTURE_SIDE).toBe(PAGE_DOCUMENT_LIMITS.imagePixels);
    const page = (size: { width: number; height: number }): boolean =>
      pageDocument.safeParse({
        ...EMPTY_PAGE_DOCUMENT,
        sections: [
          {
            id: 's',
            type: 'section',
            props: { width: 'full' },
            rows: [
              {
                id: 'r',
                type: 'row',
                columns: [
                  {
                    id: 'c',
                    type: 'column',
                    props: { span: 12 },
                    children: [
                      {
                        id: 'i',
                        type: 'image',
                        props: {
                          src: 'https://example.com/a.png',
                          alt: '',
                          action: { type: 'none' },
                          optimize: true,
                          ...size,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }).success;
    const largest = pictureSize({ width: MAX_PICTURE_SIDE, height: 1 });
    expect(largest).not.toBeNull();
    expect(page(largest ?? { width: 0, height: 0 })).toBe(true);
    expect(page({ width: MAX_PICTURE_SIDE + 1, height: 1 })).toBe(false);
    expect(page({ width: 0, height: 1 })).toBe(false);
  });
});

describe('storedSize', () => {
  it('reads the size a page keeps for a picture, and none from an older page', () => {
    expect(storedSize({ src: 'https://example.com/a.png', width: 640, height: 480 })).toStrictEqual(
      { width: 640, height: 480 },
    );
    expect(storedSize({ src: 'https://example.com/a.png' })).toBeNull();
    // One side alone says nothing of the picture's shape.
    expect(storedSize({ width: 640 })).toBeNull();
    expect(storedSize({ height: 480 })).toBeNull();
    expect(storedSize({ width: '640', height: 480 })).toBeNull();
    expect(storedSize({ width: 640.5, height: 480 })).toBeNull();
    expect(storedSize({ width: 640, height: 480.5 })).toBeNull();
    expect(storedSize({ width: 0, height: 480 })).toBeNull();
    expect(storedSize({ width: 640, height: 0 })).toBeNull();
  });
});

describe('altStateOf', () => {
  it('takes any words as a description', () => {
    expect(altStateOf({ alt: 'A harbour at dusk', isLink: false, markedDecorative: false })).toBe(
      'described',
    );
    expect(altStateOf({ alt: 'Our shop', isLink: true, markedDecorative: true })).toBe('described');
  });

  it('asks for a description or the mark, and never leaves a picture empty unnoticed', () => {
    expect(altStateOf({ alt: '', isLink: false, markedDecorative: false })).toBe('owed');
    expect(altStateOf({ alt: '   ', isLink: false, markedDecorative: false })).toBe('owed');
    expect(altStateOf({ alt: '', isLink: false, markedDecorative: true })).toBe('decorative');
  });

  it('never lets a picture that is a link be decoration: its words say where the link goes', () => {
    expect(altStateOf({ alt: '', isLink: true, markedDecorative: true })).toBe('link_needs_words');
    expect(altStateOf({ alt: '', isLink: true, markedDecorative: false })).toBe('link_needs_words');
  });
});
