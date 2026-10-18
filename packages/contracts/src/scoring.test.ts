import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { endpoints } from './api.js';
import {
  scoreRuleInput,
  scoreRuleWhen,
  scoringEndpoints,
  setContactScoreInput,
  SCORING_LIMITS,
  updateScoreProfileInput,
} from './scoring.js';

const tag = toPublicId('tag', '01890a5d-ac96-774b-bcce-b302099a8057');

describe('a scoring rule', () => {
  it('takes what GoHighLevel shows, "if an email is - Bounced, Add Points 1"', () => {
    expect(
      scoreRuleInput.parse({
        when: { action: 'email_event', event: 'bounced' },
        calculation: 'add',
        points: 1,
      }),
    ).toEqual({
      when: { action: 'email_event', event: 'bounced' },
      hasTagId: null,
      calculation: 'add',
      points: 1,
    });
  });

  it('leaves a reply of any channel and a form of any form open', () => {
    expect(scoreRuleWhen.parse({ action: 'contact_replied' })).toEqual({
      action: 'contact_replied',
      channel: null,
    });
    expect(scoreRuleWhen.parse({ action: 'form_submitted' })).toEqual({
      action: 'form_submitted',
      formId: null,
    });
  });

  it('needs the status of an appointment rule and the tag of a tag rule', () => {
    expect(scoreRuleWhen.safeParse({ action: 'appointment_status' }).success).toBe(false);
    expect(scoreRuleWhen.safeParse({ action: 'contact_tag', change: 'added' }).success).toBe(false);
    expect(
      scoreRuleWhen.safeParse({ action: 'contact_tag', change: 'added', tagId: tag }).success,
    ).toBe(true);
  });

  it('offers no action this product cannot record', () => {
    for (const action of ['email_opened', 'email_clicked', 'order_placed', 'survey_submitted'])
      expect(scoreRuleWhen.safeParse({ action }).success).toBe(false);
  });

  it('scores 1 to the most points, added or subtracted', () => {
    const rule = (points: number, calculation = 'subtract') =>
      scoreRuleInput.safeParse({
        when: { action: 'payment_received' },
        calculation,
        points,
      }).success;
    expect(rule(1)).toBe(true);
    expect(rule(SCORING_LIMITS.points)).toBe(true);
    expect(rule(0)).toBe(false);
    expect(rule(SCORING_LIMITS.points + 1)).toBe(false);
    expect(rule(1.5)).toBe(false);
    expect(rule(5, 'set')).toBe(false);
  });

  it('refuses a key it does not know', () => {
    expect(
      scoreRuleInput.safeParse({
        when: { action: 'appointment_booked', calendarId: 'x' },
        calculation: 'add',
        points: 1,
      }).success,
    ).toBe(false);
  });
});

describe('a score and the profile', () => {
  it('keeps a score a person sets within the bounds', () => {
    expect(setContactScoreInput.safeParse({ score: -SCORING_LIMITS.score }).success).toBe(true);
    expect(setContactScoreInput.safeParse({ score: SCORING_LIMITS.score + 1 }).success).toBe(false);
  });

  it('names the profile with 1 to 100 characters, trimmed', () => {
    expect(updateScoreProfileInput.parse({ name: '  Leads ', description: '' })).toEqual({
      name: 'Leads',
      description: '',
    });
    expect(updateScoreProfileInput.safeParse({ name: '  ', description: '' }).success).toBe(false);
  });

  it('serves every scoring endpoint through the API', () => {
    for (const endpoint of scoringEndpoints) expect(endpoints).toContain(endpoint);
  });
});
