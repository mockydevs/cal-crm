import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  consentEvidence,
  presentProof,
  recorderOf,
  sourceOfActor,
  storedProof,
  type ConsentEvidence,
} from './consent-proof.js';

const id = randomUUID();
const complete: readonly ConsentEvidence[] = [
  { source: 'user', note: 'Asked by phone.' },
  { source: 'api', note: 'Opted in on the partner site.' },
  { source: 'import', note: 'From the 2025 newsletter list.', fileId: id },
  { source: 'keyword', keyword: 'STOP', messageId: id },
  { source: 'keyword', keyword: 'STOP', providerMessageId: 'SM123' },
  { source: 'form', wording: 'Send me offers by email.', formId: id },
  {
    source: 'form',
    wording: 'Email me a copy of this chat.',
    widgetId: id,
    pageUrl: 'https://example.com/pricing?x=1',
    ipAddress: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
  },
  {
    source: 'booking',
    appointmentId: id,
    wording: 'Email me about this booking.',
    ipAddress: '2001:db8::1',
  },
  { source: 'unsubscribe_link', messageId: id },
];

it.each(complete)('accepts complete evidence from $source', (evidence) => {
  expect(consentEvidence.safeParse(evidence).success).toBe(true);
});

const lacking: readonly (readonly [string, unknown])[] = [
  ['no source', { note: 'Asked by phone.' }],
  ['an unknown source', { source: 'webchat', note: 'Asked in chat.' }],
  ['a person with no note', { source: 'user' }],
  ['a person with a blank note', { source: 'user', note: '   ' }],
  ['an API key with no note', { source: 'api' }],
  ['an import with no note', { source: 'import', fileId: id }],
  ['a keyword with no message', { source: 'keyword', keyword: 'STOP' }],
  ['a message with no keyword', { source: 'keyword', messageId: id }],
  ['a form with no wording', { source: 'form', formId: id }],
  ['wording with no form or widget', { source: 'form', wording: 'Send me offers.' }],
  [
    'a form with an invalid address',
    { source: 'form', wording: 'Yes', formId: id, ipAddress: '999.1.1.1' },
  ],
  [
    'a form with a script address',
    { source: 'form', wording: 'Yes', formId: id, pageUrl: 'javascript:alert(1)' },
  ],
  ['a booking with no wording', { source: 'booking', appointmentId: id, ipAddress: '203.0.113.9' }],
  ['a booking with no address', { source: 'booking', appointmentId: id, wording: 'Yes' }],
  ['an unsubscribe link with no message', { source: 'unsubscribe_link' }],
  ['an id that is not one', { source: 'unsubscribe_link', messageId: 'latest' }],
  [
    'a field outside the source',
    { source: 'user', note: 'Asked by phone.', ipAddress: '203.0.113.9' },
  ],
  ['a recorder chosen by the caller', { source: 'user', note: 'Asked by phone.', recordedBy: id }],
  ['nothing', {}],
];

it.each(lacking)('refuses %s', (_label, evidence) => {
  expect(consentEvidence.safeParse(evidence).success).toBe(false);
});

it('stores the evidence without its source, and never an empty proof', () => {
  for (const evidence of complete) {
    const proof = storedProof(consentEvidence.parse(evidence));
    expect(proof).not.toHaveProperty('source');
    expect(Object.keys(proof).length).toBeGreaterThan(0);
    for (const value of Object.values(proof)) expect(value).not.toBe('');
  }
  expect(
    storedProof(consentEvidence.parse({ source: 'user', note: '  Asked by phone.  ' })),
  ).toEqual({ note: 'Asked by phone.' });
  expect(
    storedProof(consentEvidence.parse({ source: 'keyword', keyword: 'STOP', messageId: id })),
  ).toEqual({ keyword: 'STOP', messageId: id });
});

it('records the contact for their own acts and the actor for those of anyone else', () => {
  const contactId = randomUUID();
  const staff = { actorKind: 'user', actorId: randomUUID() } as const;
  const system = { actorKind: 'system' } as const;
  for (const source of ['keyword', 'form', 'booking', 'unsubscribe_link'] as const) {
    expect(recorderOf(source, contactId, system)).toEqual({ kind: 'contact', id: contactId });
    expect(recorderOf(source, contactId, staff)).toEqual({ kind: 'contact', id: contactId });
  }
  for (const source of ['user', 'api', 'import'] as const) {
    expect(recorderOf(source, contactId, staff)).toEqual({ kind: 'user', id: staff.actorId });
    expect(recorderOf(source, contactId, system)).toEqual({ kind: 'system', id: null });
  }
});

it('lets only a person or an API key say a contact consented', () => {
  expect(sourceOfActor('user')).toBe('user');
  expect(sourceOfActor('api_key')).toBe('api');
  for (const kind of ['ai_agent', 'automation', 'system', 'contact', 'form', 'import'] as const)
    expect(sourceOfActor(kind)).toBeUndefined();
});

it('shows stored proof without internal ids', () => {
  expect(presentProof({ note: 'Asked by phone.' })).toEqual({
    note: 'Asked by phone.',
    wording: null,
    keyword: null,
    ipAddress: null,
    pageUrl: null,
    linked: null,
  });
  // As the booking page and the unsubscribe link already store theirs.
  const booking = presentProof({
    appointmentId: id,
    wording: 'Email me about this booking.',
    ipAddress: '203.0.113.9',
    recordedAt: '2026-10-09T10:00:00.000Z',
  });
  expect(booking).toMatchObject({
    wording: 'Email me about this booking.',
    ipAddress: '203.0.113.9',
    linked: 'appointment',
  });
  expect(presentProof({ messageId: id })).toMatchObject({ linked: 'message' });
  expect(presentProof({ keyword: 'STOP', providerMessageId: 'SM1' })).toMatchObject({
    keyword: 'STOP',
    linked: 'message',
  });
  expect(
    presentProof({ wording: 'Yes', widgetId: id, pageUrl: 'https://example.com/' }),
  ).toMatchObject({ pageUrl: 'https://example.com/', linked: 'form' });
  expect(presentProof({ wording: 'Yes', submissionId: id })).toMatchObject({ linked: 'form' });
  for (const shown of [booking, presentProof({ messageId: id }), presentProof({ widgetId: id })])
    expect(JSON.stringify(shown)).not.toContain(id);
});

it('shows nothing for a row with no proof or one that is not an object', () => {
  const empty = {
    note: null,
    wording: null,
    keyword: null,
    ipAddress: null,
    pageUrl: null,
    linked: null,
  };
  for (const stored of [{}, null, undefined, 'note', 7, ['note'], { note: 5 }, { note: '' }])
    expect(presentProof(stored)).toEqual(empty);
});
