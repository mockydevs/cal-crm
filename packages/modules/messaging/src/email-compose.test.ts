import { describe, expect, it } from 'vitest';

import {
  deliveredHtml,
  deliveredText,
  hiddenPreheader,
  htmlWithFooter,
  postalAddressLine,
  previewEmail,
  textWithFooter,
} from './email-compose.js';

const URL = 'https://crm.example.test/unsubscribe/token';
const PLACE = 'https://unsubscribe.invalid/link';
const ADDRESS = 'Bluebird Dental, 12 High St, Austin, TX 78701, US';

describe('postalAddressLine', () => {
  it('writes the name and the parts that are filled in, on one line', () => {
    expect(
      postalAddressLine(' Bluebird Dental ', {
        line1: '12 High St',
        line2: ' Suite 4 ',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        country: 'US',
      }),
    ).toBe('Bluebird Dental, 12 High St, Suite 4, Austin, TX 78701, US');
    expect(
      postalAddressLine('Bluebird', {
        line1: 'PO Box 9',
        line2: '',
        city: 'Reno',
        region: '',
        postalCode: '',
        country: '',
      }),
    ).toBe('Bluebird, PO Box 9, Reno');
    expect(
      postalAddressLine('B', {
        line1: '1 A\nSt',
        city: 'X',
        region: 'NV',
        postalCode: '',
        country: '',
      }),
    ).toBe('B, 1 A St, X, NV');
  });

  it('is nothing without a street line', () => {
    for (const address of [
      null,
      undefined,
      'text',
      {},
      { line1: '  ', city: 'Austin' },
      { city: 'Austin' },
      { line1: 12 },
    ])
      expect(postalAddressLine('Bluebird', address)).toBeNull();
  });
});

describe('the footer of a workflow email as it leaves', () => {
  it('follows the text with the address and the unsubscribe line', () => {
    expect(deliveredText('Hello\n\n', URL, ADDRESS)).toBe(
      `Hello\n\n--\n${ADDRESS}\nUnsubscribe: ${URL}\n`,
    );
    expect(deliveredText('Hello', URL, null)).toBe(`Hello\n\n--\nUnsubscribe: ${URL}\n`);
  });

  it('adds no second link where the body placed its own, and nothing at all with no address either', () => {
    expect(deliveredText(`Stop: ${PLACE}`, URL, ADDRESS)).toBe(`Stop: ${URL}\n\n--\n${ADDRESS}\n`);
    expect(deliveredText(`Stop: ${PLACE}`, URL, null)).toBe(`Stop: ${URL}`);
  });

  it('closes the formatted part with the same, escaped', () => {
    expect(deliveredHtml('<p>Hello</p>', `${URL}?a=1&b=2`, 'Smith & Sons, 1 <Main> St')).toBe(
      '<p>Hello</p><p style="font-size:12px;color:#666666">Smith &amp; Sons, 1 &lt;Main&gt; St<br>' +
        `<a href="${URL}?a=1&amp;b=2">Unsubscribe</a></p>`,
    );
    expect(deliveredHtml(`<a href="${PLACE}">Stop</a>`, URL, null)).toBe(
      `<a href="${URL}">Stop</a>`,
    );
    expect(deliveredHtml(`<a href="${PLACE}">Stop</a>`, URL, ADDRESS)).toBe(
      `<a href="${URL}">Stop</a><p style="font-size:12px;color:#666666">${ADDRESS}</p>`,
    );
  });

  it('goes inside the body of a whole page', () => {
    expect(deliveredHtml('<html><body><p>Hello</p></body></html>', URL, null)).toBe(
      `<html><body><p>Hello</p><p style="font-size:12px;color:#666666"><a href="${URL}">Unsubscribe</a></p></body></html>`,
    );
  });
});

describe('the footer of a preview', () => {
  it('is the one a send gets, with the field in the link’s place', () => {
    expect(textWithFooter('Hello', ADDRESS)).toBe(
      `Hello\n\n--\n${ADDRESS}\nUnsubscribe: {{email.unsubscribe_link}}\n`,
    );
    expect(textWithFooter('Stop: {{ email.unsubscribe_link }}', null)).toBe(
      'Stop: {{ email.unsubscribe_link }}',
    );
    expect(htmlWithFooter('<p>Hello</p>', null)).toBe(
      '<p>Hello</p><p style="font-size:12px;color:#666666"><a href="{{email.unsubscribe_link}}">Unsubscribe</a></p>',
    );
    expect(htmlWithFooter('<a href="{{email.unsubscribe_link}}">Stop</a>', null)).toBe(
      '<a href="{{email.unsubscribe_link}}">Stop</a>',
    );
  });
});

describe('previewEmail', () => {
  const base = { publicUrl: 'https://crm.example.test', addressLine: null, footer: false };

  it('fills in plain text and lists what it could not', () => {
    expect(
      previewEmail({
        ...base,
        parts: {
          subject: 'Hi {{contact.firstName}}',
          text: 'About {{contact.custom.plan}} and {{contact.empty}}',
        },
        values: { 'contact.firstName': 'Ada', 'contact.empty': '  ' },
      }),
    ).toEqual({
      subject: 'Hi Ada',
      preheader: null,
      html: null,
      text: 'About {{contact.custom.plan}} and {{contact.empty}}',
      mergeFields: ['contact.firstName', 'contact.custom.plan', 'contact.empty'],
      missingFields: ['contact.custom.plan', 'contact.empty'],
      subjectLineBreak: [],
    });
  });

  it('escapes values in the formatted part and hides the preview line', () => {
    const preview = previewEmail({
      ...base,
      parts: {
        subject: 'S',
        text: 'T',
        html: '<p>{{contact.firstName}}</p><a href="{{contact.site}}">site</a>',
        preheader: ' Peek {{contact.firstName}} ',
      },
      values: { 'contact.firstName': '<b>Ada</b>', 'contact.site': 'javascript:alert(1)' },
    });
    expect(preview.preheader).toBe('Peek <b>Ada</b>');
    expect(preview.html).toBe(
      `${hiddenPreheader('Peek &lt;b&gt;Ada&lt;/b&gt;')}<p>&lt;b&gt;Ada&lt;/b&gt;</p><a>site</a>`,
    );
  });

  it('has no preview line for plain text, and none when it is blank', () => {
    expect(
      previewEmail({ ...base, parts: { subject: 'S', text: 'T', preheader: 'Peek' }, values: {} })
        .preheader,
    ).toBeNull();
    expect(
      previewEmail({
        ...base,
        parts: { subject: 'S', text: 'T', html: '<p>T</p>', preheader: '  ' },
        values: {},
      }),
    ).toMatchObject({ preheader: null, html: '<p>T</p>' });
  });

  it('names a subject value with a line break, and shows the subject on one line', () => {
    expect(
      previewEmail({
        ...base,
        parts: { subject: 'For {{contact.name}}', text: '{{contact.name}}' },
        values: { 'contact.name': 'Ada\r\nLovelace' },
      }),
    ).toMatchObject({
      subject: 'For Ada Lovelace',
      subjectLineBreak: ['contact.name'],
      text: 'Ada\r\nLovelace',
    });
  });

  it('shows the footer a workflow email is sent with, and does not list its own field', () => {
    const preview = previewEmail({
      publicUrl: undefined,
      addressLine: ADDRESS,
      footer: true,
      parts: { subject: 'S', text: 'T', html: '<p>T</p><img src="/m/k/a.png">' },
      values: { 'contact.tags': ['a', 'b'] },
    });
    expect(preview.text).toBe(`T\n\n--\n${ADDRESS}\nUnsubscribe: ${PLACE}\n`);
    // No public address: an image from the media library has nowhere to load from.
    expect(preview.html).toBe(
      `<p>T</p><p style="font-size:12px;color:#666666">${ADDRESS}<br>` +
        `<a href="${PLACE}" target="_blank" rel="noopener noreferrer">Unsubscribe</a></p>`,
    );
    expect(preview.mergeFields).toEqual([]);
    expect(preview.missingFields).toEqual([]);
  });
});

describe('an unsubscribe link the reader cannot see', () => {
  const footer = `<p style="font-size:12px;color:#666666"><a href="${URL}">Unsubscribe</a></p>`;
  it.each([
    ['display:none', `<p style="display:none"><a href="${PLACE}">Unsubscribe</a></p>`],
    ['no size', `<p style="font-size:0px"><a href="${PLACE}">Unsubscribe</a></p>`],
    ['a tiny size', `<a href="${PLACE}" style="font-size:2px">Unsubscribe</a>`],
    ['font shorthand of no size', `<span style="font:0/0 a"><a href="${PLACE}">x</a></span>`],
    ['white on white', `<a href="${PLACE}" style="color:#ffffff">Unsubscribe</a>`],
    ['white on white by name', `<font color="white"><a href="${PLACE}">Unsubscribe</a></font>`],
    [
      'the colour of its cell',
      `<table><tr><td bgcolor="#000"><a href="${PLACE}" style="color:rgb(0,0,0)">Unsubscribe</a></td></tr></table>`,
    ],
    ['no words', `<p>Hi</p><a href="${PLACE}"></a>`],
    ['only blanks', `<a href="${PLACE}">   </a>`],
    ['no height', `<div style="max-height:0"><a href="${PLACE}">Unsubscribe</a></div>`],
  ])('does not count a link hidden by %s, and adds the standard one', (_label, html) => {
    expect(deliveredHtml(html, URL, null)).toContain(footer);
  });

  it.each([
    ['plain', `<p><a href="${PLACE}">Unsubscribe</a></p>`],
    [
      'white on a dark cell',
      `<table><tr><td style="background-color:#222"><a href="${PLACE}" style="color:#fff">Stop these</a></td></tr></table>`,
    ],
    ['small but readable', `<a href="${PLACE}" style="font-size:11px;color:#999">Unsubscribe</a>`],
    ['written out', `<p>Unsubscribe: ${PLACE}</p>`],
  ])('counts a %s link and adds no second one', (_label, html) => {
    const sent = deliveredHtml(html, URL, null);
    expect(sent).not.toContain(footer);
    expect(sent).toContain(URL);
  });

  it('judges the merge field the same way in a preview', () => {
    const hidden =
      '<p style="display:none"><a href="{{email.unsubscribe_link}}">Unsubscribe</a></p>';
    expect(htmlWithFooter(hidden, null)).toContain(
      '<a href="{{email.unsubscribe_link}}">Unsubscribe</a></p>',
    );
    const shown = '<p><a href="{{email.unsubscribe_link}}">Unsubscribe</a></p>';
    expect(htmlWithFooter(shown, null)).toBe(shown);
  });
});
