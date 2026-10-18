import { expect, it } from 'vitest';

import { contactFollowersCommandInput } from './contact-details.js';

const contact = 'con_01h455vb4pex5vsknk084sn02q';

it('accepts the current actor without rewriting the contact identifier', () => {
  expect(contactFollowersCommandInput.parse({ id: contact, followers: ['me'] })).toEqual({
    id: 'con_01h455vb4pex5vsknk084sn02q',
    followers: ['me'],
  });
});

it('accepts exactly ten selections and leaves deduplication to the canonical command', () => {
  const input = {
    id: contact,
    followers: [
      'me',
      'mem_01h455vb4pex5vsknk084sn02q',
      'me',
      'me',
      'me',
      'me',
      'me',
      'me',
      'me',
      'me',
    ],
  };
  expect(contactFollowersCommandInput.parse(input)).toEqual({
    id: 'con_01h455vb4pex5vsknk084sn02q',
    followers: [
      'me',
      'mem_01h455vb4pex5vsknk084sn02q',
      'me',
      'me',
      'me',
      'me',
      'me',
      'me',
      'me',
      'me',
    ],
  });
});

it('refuses a hole in an in-process follower array', () => {
  const followers: unknown[] = ['me'];
  followers.length = 2;
  const result = contactFollowersCommandInput.safeParse({ id: contact, followers });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.path).toEqual(['followers', 1]);
});

it.each([
  undefined,
  null,
  'me',
  1,
  true,
  { 0: 'me', length: 1 },
  [],
  Array.from({ length: 11 }, () => 'me'),
])('refuses malformed or out-of-bounds follower lists %#', (followers) => {
  const result = contactFollowersCommandInput.safeParse({ id: contact, followers });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.path).toEqual(['followers']);
});

it.each([
  '',
  ' me ',
  'ME',
  'everyone',
  '01890a5d-ac96-774b-bcce-b302099a8057',
  'con_01h455vb4pex5vsknk084sn02q',
  'task_01h455vb4pex5vsknk084sn02q',
  null,
  undefined,
  { id: 'me' },
  ['me'],
])('identifies the offending member without accepting partial selections %#', (member) => {
  const result = contactFollowersCommandInput.safeParse({
    id: contact,
    followers: ['me', member],
  });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.path).toEqual(['followers', 1]);
});

it.each(['all', 'businessId', 'permission', 'userId', 'revision'])(
  'refuses caller-invented authority or selection field %s',
  (key) => {
    const result = contactFollowersCommandInput.safeParse({
      id: contact,
      followers: ['me'],
      [key]: true,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toMatchObject([{ code: 'unrecognized_keys', keys: [key] }]);
  },
);

it.each([null, undefined, 'me', 'task_01h455vb4pex5vsknk084sn02q', `${contact} `])(
  'refuses a malformed contact target %#',
  (id) => {
    const result = contactFollowersCommandInput.safeParse({ id, followers: ['me'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['id']);
  },
);
