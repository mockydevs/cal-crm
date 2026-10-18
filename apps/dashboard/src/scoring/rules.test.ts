import { scoreRuleInput, type ScoreRule } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { bodyOf, draftOf, emptyDraft, missingOf, pageOf, pointsOf, searched } from './rules';

const scoreRule = (
  rule: Pick<ScoreRule, 'when' | 'hasTagId' | 'calculation' | 'points'>,
): ScoreRule => ({
  ...rule,
  id: 'srul_01h455vb4pex5vsknk084sn02s',
  problems: [],
  revision: 1,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
});

describe('a rule in its dialog', () => {
  it('goes back to the API as it came, for every kind of action', () => {
    const tag = 'tag_01h455vb4pex5vsknk084sn02q';
    const form = 'form_01h455vb4pex5vsknk084sn02r';
    for (const when of [
      { action: 'email_event', event: 'complained' },
      { action: 'contact_replied', channel: 'sms' },
      { action: 'contact_replied', channel: null },
      { action: 'form_submitted', formId: form },
      { action: 'form_submitted', formId: null },
      { action: 'appointment_booked' },
      { action: 'appointment_status', status: 'no_show' },
      { action: 'contact_tag', change: 'removed', tagId: tag },
      { action: 'payment_received' },
      { action: 'trigger_link_clicked' },
      { action: 'contact_changed' },
    ] as const) {
      const rule = scoreRule({ when, hasTagId: tag, calculation: 'subtract', points: 7 });
      expect(scoreRuleInput.parse(bodyOf(draftOf(rule)))).toEqual({
        when,
        hasTagId: tag,
        calculation: 'subtract',
        points: 7,
      });
    }
  });

  it('needs the tag of a tag rule and whole points from 1 to 1,000', () => {
    expect(missingOf({ ...emptyDraft, action: 'contact_tag' })).toBe('tag');
    expect(missingOf({ ...emptyDraft, points: '0' })).toBe('points');
    expect(missingOf({ ...emptyDraft, points: '2.5' })).toBe('points');
    expect(missingOf({ ...emptyDraft, points: '1001' })).toBe('points');
    expect(missingOf({ ...emptyDraft, points: ' 1000 ' })).toBeUndefined();
    expect(pointsOf('12')).toBe(12);
  });

  it('needs another tag or form in place of one that was deleted', () => {
    const gone = new Set(['tag_gone', 'form_gone']);
    const tagRule = { ...emptyDraft, action: 'contact_tag' as const, tagId: 'tag_gone' };
    expect(missingOf(tagRule, gone)).toBe('tag_deleted');
    expect(missingOf({ ...tagRule, tagId: 'tag_kept' }, gone)).toBeUndefined();
    expect(missingOf({ ...emptyDraft, action: 'form_submitted', formId: 'form_gone' }, gone)).toBe(
      'form_deleted',
    );
    // A deleted form matters only to a form rule.
    expect(missingOf({ ...emptyDraft, formId: 'form_gone' }, gone)).toBeUndefined();
    expect(missingOf({ ...emptyDraft, hasTagId: 'tag_gone' }, gone)).toBe('has_tag_deleted');
    expect(missingOf({ ...emptyDraft, hasTagId: '' }, gone)).toBeUndefined();
  });
});

describe('the rules table', () => {
  const sentences = [
    'if an email is - Bounced',
    'if a tag is added - Hot lead',
    'if a payment is received',
  ];

  it('finds the rules whose sentence holds every word, whatever the capitals', () => {
    expect(searched(sentences, '  HOT  added ', (each) => each)).toEqual([
      'if a tag is added - Hot lead',
    ]);
    expect(searched(sentences, '', (each) => each)).toEqual(sentences);
  });

  it('shows a page of them, the last one when a page past it is asked for', () => {
    const rules = Array.from({ length: 25 }, (_, index) => index);
    expect(pageOf(rules, 0, 10).items).toHaveLength(10);
    expect(pageOf(rules, 2, 10)).toEqual({ items: [20, 21, 22, 23, 24], page: 2 });
    expect(pageOf(rules, 5, 10).page).toBe(2);
    expect(pageOf([], 3, 10)).toEqual({ items: [], page: 0 });
  });
});
