import { expect, it } from 'vitest';
import {
  createTagGroupInput,
  updateTagRulesInput,
  tagRules,
  updateTagInput,
  assignRecordTagInput,
} from './tags.js';

it('requires a named group and bounds its description', () => {
  expect(
    createTagGroupInput.parse({ name: ' Event type ', description: 'Grouping for events.' }),
  ).toEqual({ name: 'Event type', description: 'Grouping for events.' });
  expect(createTagGroupInput.safeParse({ name: ' ', description: '' }).success).toBe(false);
  expect(
    createTagGroupInput.safeParse({ name: 'Events', description: 'x'.repeat(501) }).success,
  ).toBe(false);
});

it('accepts only explicit tag creation policies, with the revision being edited', () => {
  const rules = {
    creation: 'admins',
    suggestSimilar: true,
    revision: 'a'.repeat(64),
  };
  expect(updateTagRulesInput.parse(rules)).toEqual(rules);
  expect(updateTagRulesInput.parse({ ...rules, creation: 'everyone' }).creation).toBe('everyone');
  expect(updateTagRulesInput.safeParse({ ...rules, creation: 'members' }).success).toBe(false);
  expect(updateTagRulesInput.safeParse({ ...rules, revision: undefined }).success).toBe(false);
  expect(updateTagRulesInput.safeParse({ ...rules, suggestSimilar: 'true' }).success).toBe(false);
  expect(updateTagRulesInput.safeParse({ ...rules, actorKind: 'user' }).success).toBe(false);
});
it('requires an explicit creation policy and revision when editing definitions', () => {
  const revision = 'a'.repeat(64);
  expect(tagRules.parse({ creation: 'admins', suggestSimilar: true, revision })).toEqual({
    creation: 'admins',
    suggestSimilar: true,
    revision,
  });
  expect(
    updateTagInput.parse({
      name: 'VIP',
      description: 'Returning customers',
      groupId: null,
      revision,
    }),
  ).toMatchObject({ groupId: null, name: 'VIP' });
  expect(updateTagInput.safeParse({ name: 'VIP', description: '', revision }).success).toBe(false);
  expect(
    updateTagInput.safeParse({
      name: 'VIP',
      description: '',
      groupId: null,
      revision,
      actorKind: 'system',
    }).success,
  ).toBe(false);
});
it('never accepts caller-selected assignment provenance', () => {
  expect(assignRecordTagInput.parse({})).toEqual({});
  for (const body of [
    { sourceKind: 'system' },
    { actorId: 'someone else' },
    { sourceEventId: 'forged' },
  ])
    expect(assignRecordTagInput.safeParse(body).success).toBe(false);
});
