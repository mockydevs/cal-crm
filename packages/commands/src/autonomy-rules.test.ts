import { autonomyLevels, type AutonomyLevel } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { agentMayRun, resolveAutonomy, type AutonomyRule } from './autonomy-rules.js';

const MAYA = '01890a5d-ac96-774b-bcce-b302099a8057';
const KEN = '01890a5d-ac96-774b-bcce-b302099a8058';

const business = (level: AutonomyLevel): AutonomyRule => ({ contactId: null, level });
const contact = (contactId: string, level: AutonomyLevel): AutonomyRule => ({ contactId, level });

describe('resolveAutonomy', () => {
  it('starts at asking first when nothing is set, for the business and for a contact', () => {
    expect(resolveAutonomy([], undefined)).toEqual({
      level: 'ask',
      source: 'default',
      businessLevel: 'ask',
    });
    expect(resolveAutonomy([], MAYA)).toEqual({
      level: 'ask',
      source: 'default',
      businessLevel: 'ask',
    });
  });

  it('starts where the caller says this assistant starts for this action, and no rule is still no rule', () => {
    expect(resolveAutonomy([], undefined, 'act')).toEqual({
      level: 'act',
      source: 'default',
      businessLevel: 'act',
    });
    // A rule of the business or of the contact still comes before where it starts.
    expect(resolveAutonomy([business('ask')], undefined, 'act')).toEqual({
      level: 'ask',
      source: 'business',
      businessLevel: 'ask',
    });
    expect(resolveAutonomy([contact(MAYA, 'suggest')], MAYA, 'act')).toEqual({
      level: 'suggest',
      source: 'contact',
      businessLevel: 'act',
    });
  });

  it.each(autonomyLevels)('follows the business’s rule of %s', (level) => {
    expect(resolveAutonomy([business(level)], undefined)).toEqual({
      level,
      source: 'business',
      businessLevel: level,
    });
    expect(resolveAutonomy([business(level)], MAYA)).toEqual({
      level,
      source: 'business',
      businessLevel: level,
    });
  });

  it('puts the contact’s own rule before the business’s, whichever is the freer', () => {
    expect(resolveAutonomy([business('act'), contact(MAYA, 'suggest')], MAYA)).toEqual({
      level: 'suggest',
      source: 'contact',
      businessLevel: 'act',
    });
    expect(resolveAutonomy([contact(MAYA, 'act'), business('ask')], MAYA)).toEqual({
      level: 'act',
      source: 'contact',
      businessLevel: 'ask',
    });
  });

  it('puts the contact’s own rule before the starting level too', () => {
    expect(resolveAutonomy([contact(MAYA, 'act')], MAYA)).toEqual({
      level: 'act',
      source: 'contact',
      businessLevel: 'ask',
    });
  });

  it('never applies one contact’s rule to another contact, or to the business', () => {
    const rules = [contact(MAYA, 'act')];
    expect(resolveAutonomy(rules, KEN)).toEqual({
      level: 'ask',
      source: 'default',
      businessLevel: 'ask',
    });
    expect(resolveAutonomy(rules, undefined)).toEqual({
      level: 'ask',
      source: 'default',
      businessLevel: 'ask',
    });
    expect(resolveAutonomy([...rules, business('suggest')], KEN)).toEqual({
      level: 'suggest',
      source: 'business',
      businessLevel: 'suggest',
    });
  });
});

describe('agentMayRun', () => {
  it('lets an assistant run a command itself only when the level is act', () => {
    expect(autonomyLevels.map((level) => [level, agentMayRun(level)])).toEqual([
      ['suggest', false],
      ['ask', false],
      ['act', true],
    ]);
  });
});
