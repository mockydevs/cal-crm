import { describe, expect, it } from 'vitest';

import { contact, createContactInput, listContactsQuery, updateContactInput } from './contacts.js';
import { parseInput } from './validation.js';

const pointers = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => `/${issue.path.map(String).join('/')}`) ?? [];

describe('a new contact', () => {
  it('trims names, and trims and lowercases email addresses', () => {
    expect(
      createContactInput.parse({
        firstName: ' Maya ',
        lastName: ' Thompson ',
        emails: [' Maya.Thompson@Example.com '],
      }),
    ).toEqual({
      firstName: 'Maya',
      lastName: 'Thompson',
      emails: ['maya.thompson@example.com'],
      phones: [],
    });
  });

  it('takes custom field values by key or id, at most 100 of them', () => {
    expect(
      createContactInput.parse({
        firstName: 'Ada',
        fields: { service_interest: 'DJ', fld_01h455vb4pex5vsknk084sn02q: ['a', 'b'], vip: true },
      }).fields,
    ).toEqual({ service_interest: 'DJ', fld_01h455vb4pex5vsknk084sn02q: ['a', 'b'], vip: true });
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, n) => [`f${String(n)}`, 'x']));
    expect(pointers(createContactInput.safeParse({ firstName: 'Ada', fields: many }))).toEqual([
      '/fields',
    ]);
    expect(
      pointers(createContactInput.safeParse({ firstName: 'Ada', fields: { budget: 5000 } })),
    ).toEqual(['/fields/budget']);
  });

  it('needs only one of a name, an email address or a phone number', () => {
    expect(createContactInput.parse({ phones: ['0712 345678'] })).toEqual({
      firstName: null,
      lastName: null,
      emails: [],
      phones: ['0712 345678'],
    });
    expect(createContactInput.safeParse({ emails: ['maya@example.com'] }).success).toBe(true);
    expect(createContactInput.safeParse({ lastName: 'Thompson' }).success).toBe(true);
  });

  it.each([{}, { firstName: '  ', lastName: null, emails: [], phones: [] }])(
    'is refused with nothing to know it by: %j',
    (input) => {
      expect(() => parseInput(createContactInput, input)).toThrow(
        expect.objectContaining({
          issues: [expect.objectContaining({ path: '', code: 'contact_empty' })],
        }),
      );
    },
  );

  it('points at each email address that is malformed or listed twice', () => {
    const input = { emails: ['maya@example.com', 'not an address', 'MAYA@example.com'] };
    expect(pointers(createContactInput.safeParse(input))).toEqual(['/emails/1', '/emails/2']);
    expect(() => parseInput(createContactInput, input)).toThrow(
      expect.objectContaining({
        issues: [
          expect.objectContaining({ path: '/emails/1', code: 'invalid_format' }),
          expect.objectContaining({ path: '/emails/2', code: 'repeated' }),
        ],
      }),
    );
  });

  it('keeps to the database limits', () => {
    const long = (length: number) => 'a'.repeat(length);
    const result = createContactInput.safeParse({
      firstName: long(201),
      lastName: long(200),
      emails: [`${long(310)}@example.com`],
      phones: [long(41)],
    });
    expect(pointers(result)).toEqual(['/firstName', '/emails/0', '/phones/0']);
    expect(
      pointers(
        createContactInput.safeParse({
          emails: Array.from({ length: 11 }, (_, index) => `p${String(index)}@example.com`),
          phones: Array.from({ length: 11 }, (_, index) => `+25471234567${String(index)}`),
        }),
      ),
    ).toEqual(['/emails', '/phones']);
  });

  it('refuses a NUL or another control character in a name, which text cannot hold', () => {
    for (const name of ['Ma\u0000ya', 'Ma\nya', 'Ma\tya', 'Ma\u007fya'])
      expect(pointers(createContactInput.safeParse({ firstName: 'Ada', lastName: name }))).toEqual([
        '/lastName',
      ]);
    expect(pointers(updateContactInput.safeParse({ firstName: 'Ma\u0000ya' }))).toEqual([
      '/firstName',
    ]);
    // Letters of every script and punctuation are names.
    expect(createContactInput.parse({ firstName: 'José-Zoë', lastName: "O'Brien" })).toMatchObject({
      firstName: 'José-Zoë',
    });
  });

  it('refuses fields it does not know', () => {
    expect(pointers(createContactInput.safeParse({ firstName: 'Maya', email: 'x' }))).toEqual([
      '/',
    ]);
  });
});

describe('a change to a contact', () => {
  it('changes only what it names, and may change nothing', () => {
    expect(updateContactInput.parse({})).toEqual({});
    expect(updateContactInput.parse({ lastName: null, emails: [' A@B.co '] })).toEqual({
      lastName: null,
      emails: ['a@b.co'],
    });
  });

  it('points at an email address listed twice', () => {
    expect(pointers(updateContactInput.safeParse({ emails: ['a@b.co', 'A@B.CO'] }))).toEqual([
      '/emails/1',
    ]);
  });
});

describe('a contact, as the API shows it', () => {
  it('names its phone numbers in E.164 and as people write them', () => {
    const shown = {
      id: 'con_01h455vb4pex5vsknk084sn02q',
      firstName: 'Maya',
      lastName: null,
      name: 'Maya',
      emails: ['maya@example.com'],
      phones: [{ number: '+254712345678', display: '0712 345678' }],
      timeZone: 'Africa/Nairobi',
      doNotContact: false,
      preferencesRevision: 'a'.repeat(64),
      trashedAt: null,
      createdAt: '2026-10-08T12:00:00.000Z',
      updatedAt: '2026-10-08T12:00:00.000Z',
      canManage: true,
    };
    expect(contact.parse(shown)).toEqual(shown);
  });
});

describe('a page of contacts', () => {
  it('takes a search, a sort and where to start, and defaults to the newest first', () => {
    expect(listContactsQuery.parse({})).toEqual({ sort: 'newest' });
    expect(
      listContactsQuery.parse({
        q: '  maya ',
        sort: 'name',
        after: 'con_01h455vb4pex5vsknk084sn02q',
        createdFrom: '2026-10-01T00:00:00.000Z',
        createdBefore: '2026-10-08T00:00:00.000Z',
      }),
    ).toEqual({
      q: 'maya',
      sort: 'name',
      after: 'con_01h455vb4pex5vsknk084sn02q',
      createdFrom: '2026-10-01T00:00:00.000Z',
      createdBefore: '2026-10-08T00:00:00.000Z',
    });
  });

  it('trims a search, and refuses one too long, an unknown sort or a foreign id', () => {
    expect(listContactsQuery.parse({ q: '   ' })).toEqual({ q: '', sort: 'newest' });
    expect(
      pointers(
        listContactsQuery.safeParse({
          q: 'a'.repeat(201),
          sort: 'oldest',
          after: 'tag_01h455vb4pex5vsknk084sn02q',
        }),
      ),
    ).toEqual(['/q', '/sort', '/after']);
  });
});
