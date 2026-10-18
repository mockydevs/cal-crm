import { i18n } from '@lingui/core';
import { MAX_REMOVE_AUTOMATIONS } from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  chosenTargets,
  inactiveNote,
  statusWords,
  targetLabel,
  targetsOf,
  atTheMost,
} from './automation-targets';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const named = (id: string, name: string): { id: string; name: string } => ({ id, name });
const business = [
  named('aut_self', 'New lead follow-up'),
  named('aut_draft', 'Birthday'),
  named('aut_paused', 'Win back'),
  named('aut_live', 'Welcome'),
  named('aut_also_live', 'Education'),
  named('aut_unlisted', 'Old import'),
];
const listed = [
  { id: 'aut_self', status: 'active' },
  { id: 'aut_draft', status: 'draft' },
  { id: 'aut_paused', status: 'paused' },
  { id: 'aut_live', status: 'active' },
  { id: 'aut_also_live', status: 'active' },
];

describe('targetsOf', () => {
  it("lists the business's other automations, published first, each with its status", () => {
    expect(
      targetsOf(business, listed, 'aut_self', []).map((each) => [each.id, each.status]),
    ).toEqual([
      ['aut_also_live', 'active'],
      ['aut_live', 'active'],
      ['aut_paused', 'paused'],
      ['aut_draft', 'draft'],
      ['aut_unlisted', undefined],
    ]);
  });

  it('lists them by name alone until their statuses are known', () => {
    expect(targetsOf(business, undefined, 'aut_self', []).map((each) => each.name)).toEqual([
      'Birthday',
      'Education',
      'Old import',
      'Welcome',
      'Win back',
    ]);
  });

  it('keeps the automation itself only where a step already names it', () => {
    expect(targetsOf(business, listed, 'aut_self', ['aut_self']).map((each) => each.id)).toContain(
      'aut_self',
    );
    expect(targetsOf(business, listed, undefined, []).map((each) => each.id)).toContain('aut_self');
  });
});

describe('chosenTargets', () => {
  const targets = targetsOf(business, listed, 'aut_self', []);

  it('reads references given by id or by name, and says which the business lacks', () => {
    expect(chosenTargets(targets, ['aut_live', 'win back', 'Gone', 7])).toEqual({
      ids: ['aut_live', 'aut_paused'],
      unknown: ['Gone'],
    });
    expect(chosenTargets(targets, 'aut_live')).toEqual({ ids: ['aut_live'], unknown: [] });
    expect(chosenTargets(targets, undefined)).toEqual({ ids: [], unknown: [] });
    expect(chosenTargets(targets, '')).toEqual({ ids: [], unknown: [] });
  });
});

describe('the words around a target', () => {
  it('names each status as the workflows list does', () => {
    expect(statusWords('active')).toBe('Published');
    expect(statusWords('paused')).toBe('Paused');
    expect(statusWords('draft')).toBe('Draft');
    expect(statusWords('archived')).toBe('Deleted');
    expect(statusWords(undefined)).toBeUndefined();
    expect(statusWords('else')).toBeUndefined();
  });

  it('labels a choice with its status, when it is known', () => {
    expect(targetLabel({ id: 'a', name: 'Win back', status: 'paused' })).toBe('Win back (Paused)');
    expect(targetLabel({ id: 'a', name: 'Win back', status: undefined })).toBe('Win back');
  });

  it('says what starting an automation that is not published does', () => {
    expect(inactiveNote({ id: 'a', name: 'Win back', status: 'paused' })).toBe(
      '“Win back” is paused. This action starts nothing until it is published again.',
    );
    expect(inactiveNote({ id: 'a', name: 'Birthday', status: 'draft' })).toBe(
      '“Birthday” is a draft. This action starts nothing until it is published.',
    );
    expect(inactiveNote({ id: 'a', name: 'Old', status: 'archived' })).toBe(
      '“Old” is deleted. This action starts nothing.',
    );
    expect(inactiveNote({ id: 'a', name: 'Welcome', status: 'active' })).toBeUndefined();
    expect(inactiveNote({ id: 'a', name: 'Welcome', status: undefined })).toBeUndefined();
    expect(inactiveNote(undefined)).toBeUndefined();
  });

  it('knows when a list holds as many as a step may name', () => {
    expect(atTheMost(Array.from({ length: MAX_REMOVE_AUTOMATIONS - 1 }, String))).toBe(false);
    expect(atTheMost(Array.from({ length: MAX_REMOVE_AUTOMATIONS }, String))).toBe(true);
  });
});
