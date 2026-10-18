import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { contactPhoneLabels, dndChannels, offeredDndChannels } from './contact-attributes.js';
import { assignContactOwnerInput } from './contact-people.js';
import {
  addContactAddressInput,
  assignContactOwnerCommandInput,
  contactDetails,
  contactFollowersInput,
  dndChannelsOf,
  MAX_CONTACT_FOLLOWERS,
  parseInput,
  setContactDndInput,
  updateContactAddressInput,
} from './index.js';

const UUID = '01890a5d-ac96-774b-bcce-b302099a8057';
const member = toPublicId('membership', UUID);
const revision = 'a'.repeat(64);
const issuesOf = (work: () => unknown): { path: string; code: string }[] => {
  try {
    work();
  } catch (error) {
    return (error as { issues: { path: string; code: string }[] }).issues;
  }
  throw new Error('Expected a refusal.');
};

describe('an owner', () => {
  it('is a membership, "me" or nobody, named with the revision it was based on', () => {
    for (const owner of [member, 'me', null])
      expect(parseInput(assignContactOwnerInput, { owner, revision })).toEqual({ owner, revision });
    expect(issuesOf(() => parseInput(assignContactOwnerInput, { owner: member }))[0]?.path).toBe(
      '/revision',
    );
    expect(
      issuesOf(() =>
        parseInput(assignContactOwnerInput, { owner: toPublicId('contact', UUID), revision }),
      )[0]?.path,
    ).toBe('/owner');
  });

  it('can be set without a revision only by a caller of the command itself', () => {
    const id = toPublicId('contact', UUID);
    expect(parseInput(assignContactOwnerCommandInput, { id, owner: null })).toEqual({
      id,
      owner: null,
    });
  });
});

describe('followers', () => {
  it(`are one to ${String(MAX_CONTACT_FOLLOWERS)} people, GoHighLevel's limit`, () => {
    expect(MAX_CONTACT_FOLLOWERS).toBe(10);
    expect(parseInput(contactFollowersInput, { followers: ['me', member] }).followers).toHaveLength(
      2,
    );
    expect(issuesOf(() => parseInput(contactFollowersInput, { followers: [] }))[0]?.path).toBe(
      '/followers',
    );
    const many = Array.from({ length: MAX_CONTACT_FOLLOWERS + 1 }, () => member);
    expect(issuesOf(() => parseInput(contactFollowersInput, { followers: many }))[0]?.path).toBe(
      '/followers',
    );
  });
});

describe('an address', () => {
  it('is an email address or a phone number, trimmed, and only a phone number has a label', () => {
    expect(contactPhoneLabels).toEqual(['home', 'work', 'mobile', 'landline']);
    expect(
      parseInput(addContactAddressInput, { kind: 'phone', value: ' 0712 345678 ', label: 'work' }),
    ).toEqual({ kind: 'phone', value: '0712 345678', label: 'work' });
    expect(
      parseInput(addContactAddressInput, { kind: 'email', value: ' Maya@Example.test ' }),
    ).toEqual({ kind: 'email', value: 'Maya@Example.test', label: null });
    expect(
      issuesOf(() =>
        parseInput(addContactAddressInput, {
          kind: 'email',
          value: 'a@example.test',
          label: 'work',
        }),
      ),
    ).toEqual([expect.objectContaining({ path: '/label', code: 'label_not_for_email' })]);
    expect(
      issuesOf(() =>
        parseInput(addContactAddressInput, { kind: 'email', value: 'not an email' }),
      )[0]?.path,
    ).toBe('/value');
    expect(
      issuesOf(() =>
        parseInput(addContactAddressInput, { kind: 'phone', value: '+1', label: 'fax' }),
      )[0]?.path,
    ).toBe('/label');
  });

  it('is changed by a label or by being made primary, with the revision', () => {
    expect(parseInput(updateContactAddressInput, { label: null, revision })).toEqual({
      label: null,
      revision,
    });
    expect(parseInput(updateContactAddressInput, { primary: true, revision }).primary).toBe(true);
    expect(issuesOf(() => parseInput(updateContactAddressInput, { revision }))[0]?.code).toBe(
      'nothing_to_change',
    );
    expect(
      issuesOf(() => parseInput(updateContactAddressInput, { primary: false, revision }))[0]?.path,
    ).toBe('/primary');
    expect(issuesOf(() => parseInput(updateContactAddressInput, { label: 'home' }))[0]?.path).toBe(
      '/revision',
    );
  });
});

describe('do not disturb', () => {
  it('names every channel or some, with a reason and the revision', () => {
    const input = {
      all: false,
      channels: ['sms', 'email'],
      reason: 'Asked by phone today.',
      revision,
    };
    expect(parseInput(setContactDndInput, input)).toEqual(input);
    for (const [change, path] of [
      [{ reason: 'short' }, '/reason'],
      [{ reason: undefined }, '/reason'],
      [{ revision: undefined }, '/revision'],
      [{ channels: ['fax'] }, '/channels/0'],
      [{ all: undefined }, '/all'],
      [{ inbound: 'yes' }, '/inbound'],
    ] as const)
      expect(issuesOf(() => parseInput(setContactDndInput, { ...input, ...change }))[0]?.path).toBe(
        path,
      );
  });

  it('takes inbound do not disturb, or leaves it as it is when it is left out', () => {
    const input = {
      all: false,
      channels: [],
      inbound: true,
      reason: 'Calls every night at three.',
      revision,
    };
    expect(parseInput(setContactDndInput, input)).toEqual(input);
    const { inbound, ...without } = input;
    expect(inbound).toBe(true);
    expect(parseInput(setContactDndInput, without)).not.toHaveProperty('inbound');
  });

  it('offers every channel it stops, and not WhatsApp, which sends nothing yet', () => {
    expect(offeredDndChannels).toEqual(['email', 'sms', 'call', 'webchat']);
  });

  it('keeps channels each once, in one order', () => {
    expect(dndChannels).toEqual(['call', 'email', 'sms', 'webchat', 'whatsapp']);
    expect(dndChannelsOf(['sms', 'email', 'sms'])).toEqual(['email', 'sms']);
    expect(dndChannelsOf([])).toEqual([]);
  });
});

describe('the details', () => {
  it('parse as the server answers them, and keep members a later version adds', () => {
    const person = { membershipId: member, name: 'Dana Brooks', you: true };
    const details = {
      id: toPublicId('contact', UUID),
      owner: person,
      ownerRevision: revision,
      followers: [{ ...person, membershipId: null, name: null }],
      addresses: [
        {
          id: toPublicId('contact_identity', UUID),
          kind: 'phone',
          value: '+254712345678',
          display: '0712 345678',
          label: 'mobile',
          primary: true,
          delivery: { status: 'blocked', reason: 'invalid', since: '2026-10-07T09:30:00.000Z' },
        },
      ],
      addressesRevision: revision,
      dnd: { all: false, channels: ['sms'], inbound: false, revision },
      createdBy: { kind: 'form', name: 'Enquiry', you: false },
      createdSource: 'form',
      createdAt: '2026-10-07T09:30:00.000Z',
      canManage: true,
      canReadAudit: false,
      later: 'kept',
    };
    expect(contactDetails.parse(details)).toEqual(details);
    expect(() => contactDetails.parse({ ...details, createdSource: 'telepathy' })).toThrow();
  });
});
