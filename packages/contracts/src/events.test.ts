import { describe, expect, it } from 'vitest';

import { eventEnvelope } from './index.js';

const contactCreated = {
  id: '01890a5d-ac96-774b-bcce-b302099a8057',
  agencyId: '01890a5d-ac96-774b-bcce-b302099a8058',
  businessId: '01890a5d-ac96-774b-bcce-b302099a8059',
  type: 'contact.created',
  version: 1,
  occurredAt: '2026-10-07T09:30:00.000Z',
  recordedAt: '2026-10-07T09:30:00.120Z',
  actorKind: 'user',
  actorId: '01890a5d-ac96-774b-bcce-b302099a805a',
  causationId: null,
  correlationId: '01890a5d-ac96-774b-bcce-b302099a805b',
  subjectKind: 'contact',
  subjectId: '01890a5d-ac96-774b-bcce-b302099a805c',
  payload: { firstName: 'Dana' },
  proposalId: null,
  commandId: null,
};

describe('eventEnvelope', () => {
  it('accepts an event as the events table records it', () => {
    expect(eventEnvelope.parse(contactCreated)).toEqual(contactCreated);
  });

  it('accepts an agency-level event, with no business', () => {
    expect(eventEnvelope.safeParse({ ...contactCreated, businessId: null }).success).toBe(true);
  });

  it('accepts an event that came of an assistant’s proposal, by the proposal’s id', () => {
    const proposalId = '01890a5d-ac96-774b-bcce-b302099a805d';
    expect(eventEnvelope.parse({ ...contactCreated, proposalId })).toMatchObject({ proposalId });
  });

  it('retains the audit command id shared by events from one command', () => {
    const commandId = '01890a5d-ac96-774b-bcce-b302099a805e';
    expect(eventEnvelope.parse({ ...contactCreated, commandId })).toMatchObject({ commandId });
  });

  it.each([
    ['a proposal that is not an id', { proposalId: 'the-first' }],
    ['a command that is not an id', { commandId: 'the-first' }],
    ['a type without a dot', { type: 'created' }],
    ['a type in capitals', { type: 'Contact.Created' }],
    ['an actor the database does not know', { actorKind: 'robot' }],
    ['version 0', { version: 0 }],
    ['a payload that is not an object', { payload: ['first'] }],
  ])('refuses %s, as the table does', (_case, change) => {
    expect(eventEnvelope.safeParse({ ...contactCreated, ...change }).success).toBe(false);
  });
});
