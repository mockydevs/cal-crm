// What a copy of a marketing email holds, and who gets one: no unsubscribe link, in words
// or in an address, and never the contact's.
import { describe, expect, it } from 'vitest';

import { UNSUBSCRIBE_PLACEHOLDER } from './campaign-rules.js';
import { copiedHtml, copiedText, deliveredText } from './email-compose.js';
import { copyRecipients } from './smtp-outbound.js';

const LINK = 'https://crm.example.test/unsubscribe/abc';
const NOTICE =
  'This is a copy of an email sent to ada@example.test. Only their own email has a working unsubscribe link.';
const ADDRESS = 'Bluebird Dental, 12 High St, Austin, TX 78701, US';

describe('a copy’s text', () => {
  it('ends with whose email it is a copy of, where the contact’s has the link', () => {
    expect(deliveredText('Hello', LINK, ADDRESS)).toBe(
      `Hello\n\n--\n${ADDRESS}\nUnsubscribe: ${LINK}\n`,
    );
    expect(copiedText('Hello\n', 'ada@example.test', ADDRESS)).toBe(
      `Hello\n\n--\n${ADDRESS}\n${NOTICE}\n`,
    );
    expect(copiedText('Hello', 'ada@example.test', null)).toBe(`Hello\n\n--\n${NOTICE}\n`);
  });

  it('has plain words where the author placed the link', () => {
    const copy = copiedText(`Stop: ${UNSUBSCRIBE_PLACEHOLDER}`, 'ada@example.test', null);
    expect(copy).toBe(`Stop: [removed from this copy]\n\n--\n${NOTICE}\n`);
    expect(copy).not.toContain('http');
  });
});

describe('a copy’s formatted part', () => {
  it('ends with the same notice, escaped, before the body closes', () => {
    expect(copiedHtml('<p>Hello</p>', 'ada@example.test', 'A & B, 1 Main St')).toBe(
      `<p>Hello</p><p style="font-size:12px;color:#666666">A &amp; B, 1 Main St<br>${NOTICE}</p>`,
    );
    expect(copiedHtml('<html><body><p>Hi</p></body></html>', 'ada@example.test', null)).toBe(
      `<html><body><p>Hi</p><p style="font-size:12px;color:#666666">${NOTICE}</p></body></html>`,
    );
  });

  it('points a link the author placed nowhere', () => {
    const copy = copiedHtml(
      `<p><a href="${UNSUBSCRIBE_PLACEHOLDER}">Stop these emails</a></p>`,
      'ada@example.test',
      null,
    );
    expect(copy).toContain('<a href="#">Stop these emails</a>');
    expect(copy).not.toContain('unsubscribe.invalid');
  });
});

describe('who gets a copy', () => {
  it('is the Cc addresses together, with Bcc unseen on the same message', () => {
    expect(copyRecipients(['a@x.test', 'b@x.test'], ['c@x.test'])).toEqual([
      { to: 'a@x.test', cc: ['b@x.test'], bcc: ['c@x.test'] },
    ]);
    expect(copyRecipients(['a@x.test'], [])).toEqual([{ to: 'a@x.test', cc: [], bcc: [] }]);
  });

  it('is each Bcc address alone when nobody is in Cc, so none is shown another', () => {
    expect(copyRecipients([], ['c@x.test', 'd@x.test'])).toEqual([
      { to: 'c@x.test', cc: [], bcc: [] },
      { to: 'd@x.test', cc: [], bcc: [] },
    ]);
    expect(copyRecipients([], [])).toEqual([]);
  });
});
