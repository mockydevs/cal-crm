import { describe, expect, it } from 'vitest';

import { addUserInput, listUsersQuery, updateUserInput } from './users.js';

const role = 'role_01h455vb4pex5vsknk084sn02q';
const paths = (parsed: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  parsed.error?.issues.map((issue) => issue.path.join('/'));

describe('adding a person', () => {
  it('needs both names, an email and a role, and fills in the rest', () => {
    expect(
      addUserInput.parse({
        firstName: ' Ada ',
        lastName: 'Lovelace',
        email: ' Ada@Example.test ',
        roleId: role,
      }),
    ).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      roleId: role,
      phone: null,
      extension: null,
      avatarFileId: null,
      calendarId: null,
      signature: { enabled: false, document: null },
    });
    expect(paths(addUserInput.safeParse({ email: 'ada@example.test', roleId: role }))).toEqual([
      'firstName',
      'lastName',
    ]);
    expect(
      paths(
        addUserInput.safeParse({ firstName: 'Ada', lastName: ' ', email: 'ada', roleId: role }),
      ),
    ).toEqual(['email', 'lastName']);
  });

  it('takes a phone in E.164 only, and an extension only with a phone', () => {
    const base = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      roleId: role,
    };
    expect(addUserInput.parse({ ...base, phone: '+13055550123', extension: '204' })).toMatchObject({
      phone: '+13055550123',
      extension: '204',
    });
    for (const phone of ['0712345678', '+1 305 555 0123', '+0712345678', '+123'])
      expect(paths(addUserInput.safeParse({ ...base, phone }))).toEqual(['phone']);
    expect(paths(addUserInput.safeParse({ ...base, extension: '204' }))).toEqual(['extension']);
    expect(
      paths(addUserInput.safeParse({ ...base, phone: '+13055550123', extension: 'x204' })),
    ).toEqual(['extension']);
  });

  it('refuses a password: a person sets their own', () => {
    expect(
      addUserInput.safeParse({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
        roleId: role,
        password: 'correct horse battery staple',
      }).success,
    ).toBe(false);
  });
});

describe('changing a person', () => {
  it('has no email: the address is the account’s', () => {
    const details = { firstName: 'Ada', lastName: 'Lovelace', roleId: role };
    expect(updateUserInput.safeParse(details).success).toBe(true);
    expect(updateUserInput.safeParse({ ...details, email: 'ada@example.test' }).success).toBe(
      false,
    );
  });

  it('takes a signature as a note document', () => {
    const document = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Ada, Analytical Engines' }] },
      ],
    };
    expect(
      updateUserInput.parse({
        firstName: 'Ada',
        lastName: 'Lovelace',
        roleId: role,
        signature: { enabled: true, document },
      }).signature,
    ).toEqual({ enabled: true, document });
    expect(
      updateUserInput.safeParse({
        firstName: 'Ada',
        lastName: 'Lovelace',
        roleId: role,
        signature: { enabled: true, document: '<b>Ada</b>' },
      }).success,
    ).toBe(false);
  });
});

describe('listing people', () => {
  it('pages by 20 unless told, up to 100', () => {
    expect(listUsersQuery.parse({})).toEqual({ limit: 20 });
    expect(listUsersQuery.parse({ q: ' ada ', limit: '50', type: 'agency' })).toEqual({
      q: 'ada',
      limit: 50,
      type: 'agency',
    });
    expect(listUsersQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(listUsersQuery.safeParse({ type: 'guest' }).success).toBe(false);
  });
});
