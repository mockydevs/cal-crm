// Why an automation did not start: the two reads, the closed list of reasons, and what an
// evaluation and an explanation hold.
import { describe, expect, it } from 'vitest';

import {
  automationContactExplanation,
  automationTriggerEvaluation,
  automationTriggerEvaluationReasons,
  explainAutomationContact,
  listAutomationTriggerEvaluations,
  TRIGGER_EVALUATION_DAYS,
} from './automations-manage.js';

const AUTOMATION = 'aut_01h455vb4pex5vsknk084sn02q';
const CONTACT = 'con_01h455vb4pex5vsknk084sn02q';
const ID = '0188a5eb-4b84-7095-bcce-7340229b0057';

const evaluation = {
  id: ID,
  evaluatedAt: '2026-10-12T09:00:00.000Z',
  eventId: ID,
  eventType: 'tag.assigned',
  trigger: { id: 'tagged', type: 'tag.added' },
  recordId: CONTACT,
  reason: 'filter_mismatch',
  detail: { filter: 'tag', expected: 'tag_a', actual: 'tag_b' },
  explanation: "The trigger's tag filter wanted tag_a, and the event had tag_b.",
};

describe('the reasons an automation did not start', () => {
  it('are a closed list, kept thirty days', () => {
    expect(automationTriggerEvaluationReasons).toEqual([
      'filter_mismatch',
      'condition_false',
      'already_enrolled',
      'reentry_not_allowed',
      'paused',
      'contact_missing',
      'stopped_by_rule',
      'refused_loop',
    ]);
    expect(TRIGGER_EVALUATION_DAYS).toBe(30);
  });

  it('come with what was compared, and with no record when the event had none', () => {
    expect(automationTriggerEvaluation.parse(evaluation)).toEqual(evaluation);
    for (const more of [
      { reason: 'condition_false', detail: { values: { 'contact.lastName': null } } },
      { reason: 'contact_missing', detail: {}, recordId: null },
      { reason: 'paused', detail: {}, trigger: null },
      { reason: 'stopped_by_rule', detail: { rule: 'imported_contact' } },
      { trigger: { id: 'gone', type: null } },
    ])
      expect(automationTriggerEvaluation.safeParse({ ...evaluation, ...more }).success).toBe(true);
    for (const more of [
      { reason: 'bad_luck' },
      { id: 'tev_1' },
      { detail: 'the tag' },
      { recordId: 'tag_01h455vb4pex5vsknk084sn02q' },
    ])
      expect(automationTriggerEvaluation.safeParse({ ...evaluation, ...more }).success).toBe(false);
  });
});

describe('the list of evaluations', () => {
  it('is a read under the automation', () => {
    expect(listAutomationTriggerEvaluations).toMatchObject({
      operationId: 'listAutomationTriggerEvaluations',
      method: 'get',
      path: '/automations/{id}/trigger-evaluations',
      group: 'Automations',
    });
  });

  it('takes a record, a stretch of time, a cursor and a page size, each as text', () => {
    expect(listAutomationTriggerEvaluations.query.parse({})).toEqual({ limit: 50 });
    expect(
      listAutomationTriggerEvaluations.query.parse({
        contactId: CONTACT,
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-12T00:00:00+03:00',
        after: ID,
        limit: '5',
      }),
    ).toEqual({
      contactId: CONTACT,
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-12T00:00:00+03:00',
      after: ID,
      limit: 5,
    });
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { from: 'yesterday' },
      { after: 'the last one' },
      { contactId: AUTOMATION },
      { record: CONTACT },
    ])
      expect(listAutomationTriggerEvaluations.query.safeParse(query).success).toBe(false);
  });
});

describe('what an automation did for one contact', () => {
  it('is a read that needs the contact', () => {
    expect(explainAutomationContact).toMatchObject({
      operationId: 'explainAutomationContact',
      method: 'get',
      path: '/automations/{id}/explain-contact',
    });
    expect(explainAutomationContact.query.parse({ contactId: CONTACT })).toEqual({
      contactId: CONTACT,
    });
    expect(explainAutomationContact.query.safeParse({}).success).toBe(false);
  });

  it('says one of three things, each from what is on record', () => {
    const answer = {
      automationId: AUTOMATION,
      automationName: 'VIP welcome',
      automationStatus: 'active',
      recordId: CONTACT,
      state: 'not_started',
      runs: 0,
      run: null,
      ended: null,
      evaluations: [evaluation],
      evaluationsKeptDays: 30,
      summary: 'No run of "VIP welcome" is on record for Ada.',
    };
    expect(automationContactExplanation.parse(answer)).toEqual(answer);
    for (const state of ['has_run', 'not_started', 'nothing_on_record'])
      expect(automationContactExplanation.safeParse({ ...answer, state }).success).toBe(true);
    for (const more of [{ state: 'probably_paused' }, { runs: -1 }, { automationStatus: 'live' }])
      expect(automationContactExplanation.safeParse({ ...answer, ...more }).success).toBe(false);
  });
});
