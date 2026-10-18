import { i18n } from '@lingui/core';
import { automationStepTypes, automationStopEvents, automationTriggerTypes } from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  harborSetup,
  recordSetup,
  stepExamples,
  triggerExamples,
} from '../e2e/automation-fixtures';
import {
  branchLabel,
  conditionWords,
  durationWords,
  fieldWords,
  nameIn,
  stepLabel,
  stepName,
  stepSummary,
  stopSummary,
  summarizedStepTypes,
  summarizedStopEvents,
  summarizedTriggerTypes,
  triggerLabel,
  triggerSummary,
} from './automation-summary';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

describe('step summaries', () => {
  it.each([
    { channel: 'sms', action: 'enable' },
    { channel: 'email', action: 'disable', reason: '   ' },
    { channel: 'voice', action: 'enable', reason: 'Requested by the contact.' },
    { channel: 'email', action: 'maybe', reason: 'Requested by the contact.' },
  ])('leaves unfinished or unknown DND settings without a misleading summary %#', (config) => {
    expect(stepSummary({ type: 'dnd.set', config }, harborSetup)).toBeUndefined();
  });
  it('says which way and which channel do not disturb is set for', () => {
    const reason = 'Requested by the contact.';
    const dnd = (config: Record<string, unknown>) =>
      stepSummary({ type: 'dnd.set', config: { reason, ...config } }, harborSetup);
    expect(dnd({ channel: 'call', action: 'enable' })).toBe(
      'Enable do not disturb for calls and voicemails',
    );
    expect(dnd({ channel: 'webchat', action: 'disable' })).toBe(
      'Clear do not disturb for web chat',
    );
    expect(dnd({ direction: 'inbound', action: 'enable' })).toBe('Enable inbound do not disturb');
  });
  it('names the followers a step adds or removes', () => {
    const team = { ...harborSetup, users: recordSetup.users };
    expect(
      stepSummary({ type: 'followers.add', config: { users: ['usr_dana', 'usr_sam'] } }, team),
    ).toBe('Add Dana Brooks and Sam Okoye as followers');
    expect(stepSummary({ type: 'followers.remove', config: { users: ['usr_chris'] } }, team)).toBe(
      'Remove Chris Marino as followers',
    );
    expect(stepSummary({ type: 'followers.remove', config: {} }, team)).toBeUndefined();
  });
  it('says how old a result an Email verification step reuses, one day too', () => {
    expect(stepLabel('email.verify')).toBe('Email verification');
    expect(stepSummary({ type: 'email.verify', config: { maxAgeDays: 1 } }, harborSetup)).toBe(
      'Check the primary email (reuse results up to 1 day old)',
    );
    expect(
      stepSummary(
        { type: 'email.verify', config: { address: 'primary', maxAgeDays: 365 } },
        harborSetup,
      ),
    ).toBe('Check the primary email (reuse results up to 365 days old)');
  });
  it.each(Object.keys(automationStepTypes))('%s has a label, an example and a summary', (type) => {
    const example = stepExamples[type];
    if (example === undefined) throw new Error(`Add an example for ${type}.`);
    const config = automationStepTypes[type as keyof typeof automationStepTypes].config;
    expect(config.safeParse(example.config).success).toBe(true);
    expect(summarizedStepTypes).toContain(type);
    expect(stepLabel(type)).toEqual(expect.stringMatching(/\S/));
    expect(stepSummary({ type, config: example.config }, harborSetup)).toBe(example.summary);
  });

  it('has no example for a step type the catalog lacks', () => {
    expect(Object.keys(stepExamples).toSorted()).toEqual(
      Object.keys(automationStepTypes).toSorted(),
    );
  });

  it.each(Object.keys(automationStepTypes))(
    '%s reads as not set up, rather than half a sentence, when nothing is filled in',
    (type) => {
      const summary = stepSummary({ type, config: {} }, harborSetup);
      // These complete actions need no settings; the others require more input.
      const whole: Readonly<Record<string, string>> = {
        'ai.draft_reply': 'Draft a reply with AI',
        'deal.find': 'Find their most recent opportunity',
        'email.verify': 'Check the primary email (reuse results up to 90 days old)',
        'manual.call': "Ask the contact's owner to call them",
        'owner.remove': "Remove the contact's owner",
      };
      expect(summary).toBe(whole[type]);
    },
  );

  it('has nothing to say about a type it does not know', () => {
    expect(stepSummary({ type: 'contact.delete', config: {} }, harborSetup)).toBeUndefined();
    expect(stepLabel('contact.delete')).toBeUndefined();
    expect(stepSummary({ type: 'constructor', config: {} }, harborSetup)).toBeUndefined();
  });

  it('reads the other shapes a step can take', () => {
    expect(stepSummary({ type: 'deal.close', config: { outcome: 'won' } }, harborSetup)).toBe(
      'Close the opportunity as won',
    );
    expect(stepSummary({ type: 'team.notify', config: { message: 'New lead' } }, harborSetup)).toBe(
      "Tell the contact's owner “New lead”",
    );
    expect(
      stepSummary(
        { type: 'team.notify', config: { message: 'New lead', to: 'owner_or_everyone' } },
        harborSetup,
      ),
    ).toBe("Tell the contact's owner, or everyone when there is none, “New lead”");
    expect(
      stepSummary(
        { type: 'wait.event', config: { event: 'appointment.booked', timeout: 'PT4H' } },
        harborSetup,
      ),
    ).toBe('Wait up to 4 hours for them to book an appointment');
    expect(
      stepSummary({ type: 'wait.until', config: { field: 'deal.expectedCloseDate' } }, harborSetup),
    ).toBe('Wait until opportunity expected close date');
    expect(
      stepSummary({ type: 'wait.until', config: { at: 'not a date' } }, harborSetup),
    ).toBeUndefined();
    expect(
      stepSummary({ type: 'wait.until', config: { at: '2026-12-24T09:00:00+00:00' } }, harborSetup),
    ).toMatch(/^Wait until .*2026/);
  });

  it('says what a removal takes the contact out of, naming the automations', () => {
    const removal = (config: Record<string, unknown>): string | undefined =>
      stepSummary({ type: 'automation.remove', config }, harborSetup);
    expect(removal({ from: 'current' })).toBe('Remove them from this automation');
    expect(removal({ from: 'automations', automations: ['aut_other', 'Education'] })).toBe(
      'Remove them from “Win back” and “Education”',
    );
    expect(removal({ from: 'automations', automations: [] })).toBeUndefined();
    expect(removal({ from: 'automations' })).toBeUndefined();
    expect(removal({ from: 'all_others' })).toBe('Remove them from every other automation');
    expect(removal({ from: 'all_others', except: [] })).toBe(
      'Remove them from every other automation',
    );
    expect(removal({ from: 'all' })).toBe('Remove them from every automation, this one too');
    expect(removal({ from: 'all', except: ['aut_other'] })).toBe(
      'Remove them from every automation, this one too, except “Win back”',
    );
    expect(removal({ from: 'some' })).toBeUndefined();
  });

  it('names the branches of an If / else that has its own, and has nothing for an empty goal', () => {
    expect(
      stepSummary(
        {
          type: 'condition',
          config: {
            branches: [
              { name: 'video', label: 'Asked about video', if: {} },
              { name: 'photo', if: {} },
            ],
          },
        },
        harborSetup,
      ),
    ).toBe('Take the first branch that holds: “Asked about video” or “photo”');
    expect(
      stepSummary({ type: 'condition', config: { branches: [7] } }, harborSetup),
    ).toBeUndefined();
    expect(
      stepSummary({ type: 'goal', config: { events: [{ type: 'odd' }] } }, harborSetup),
    ).toBeUndefined();
  });

  it('shortens a long message', () => {
    const summary = stepSummary(
      { type: 'sms.send', config: { message: 'word '.repeat(80) } },
      harborSetup,
    );
    expect(summary?.length).toBeLessThan(160);
    expect(summary).toMatch(/…”$/);
  });

  it('names a step by its label, else what it does, else its type, else its id', () => {
    const step = { id: 'x', type: 'wait', config: { duration: 'P1D' }, label: undefined };
    expect(stepName({ ...step, label: 'Cool off' }, harborSetup)).toBe('Cool off');
    expect(stepName(step, harborSetup)).toBe('Wait 1 day');
    expect(stepName({ ...step, config: {} }, harborSetup)).toBe('Wait');
    expect(stepName({ ...step, type: 'mystery' }, harborSetup)).toBe('x');
  });
});

describe('branch labels', () => {
  it('names the branches an If / else has of its own, and the one for none of them', () => {
    const step = {
      type: 'condition',
      config: { branches: [{ name: 'video', label: 'Asked about video' }, { name: 'photo' }] },
    };
    expect(branchLabel(step, 'video')).toBe('If “Asked about video”');
    expect(branchLabel(step, 'photo')).toBe('If “photo”');
    expect(branchLabel(step, 'none')).toBe('If none of them holds');
    expect(branchLabel(step, 'old')).toBe('Branch “old”');
    // A branch that kept the key yes goes by its own name.
    const kept = { type: 'condition', config: { branches: [{ name: 'yes', label: 'Video' }] } };
    expect(branchLabel(kept, 'yes')).toBe('If “Video”');
  });

  it('names each kind of branch in words', () => {
    expect(branchLabel({ type: 'condition', config: {} }, 'yes')).toBe('If yes');
    expect(branchLabel({ type: 'condition', config: {} }, 'no')).toBe('If no');
    expect(branchLabel({ type: 'wait.event', config: {} }, 'received')).toBe(
      'If it happens in time',
    );
    expect(branchLabel({ type: 'wait.event', config: {} }, 'timed_out')).toBe('If time runs out');
    expect(
      branchLabel({ type: 'split', config: { variants: [{ name: 'a', percent: 60 }] } }, 'a'),
    ).toBe('Variant a (60%)');
    expect(branchLabel({ type: 'split', config: {} }, 'stray')).toBe('Variant stray');
    expect(branchLabel({ type: 'ai.classify', config: {} }, 'stop')).toBe("If it's “stop”");
    expect(branchLabel({ type: 'wait', config: {} }, 'odd')).toBe('Branch “odd”');
  });
});

describe('trigger summaries', () => {
  it('say which change of do not disturb starts the automation', () => {
    const dnd = (config: Record<string, unknown>) =>
      triggerSummary({ type: 'contact.dnd_changed', config }, harborSetup);
    expect(dnd({})).toBe("A contact's do not disturb is turned on or off");
    expect(dnd({ flag: 'disabled', channel: 'all' })).toBe(
      "A contact's do not disturb for every channel is turned off",
    );
    expect(dnd({ direction: 'inbound', flag: 'enabled' })).toBe(
      "A contact's inbound do not disturb is turned on",
    );
  });

  it('say which engagement score starts the automation, and how many points a step moves', () => {
    const score = (config: Record<string, unknown>) =>
      triggerSummary({ type: 'contact.score_changed', config }, harborSetup);
    expect(score({ operator: 'equals', score: 10 })).toBe("A contact's engagement score is 10");
    expect(score({ operator: 'not_equals', score: 0 })).toBe(
      "A contact's engagement score is not 0",
    );
    expect(score({ operator: 'gt', score: 195 })).toBe(
      "A contact's engagement score is greater than 195",
    );
    expect(score({ operator: 'lt', score: -5 })).toBe(
      "A contact's engagement score is less than -5",
    );
    expect(score({ operator: 'lte', score: 3 })).toBe("A contact's engagement score is at most 3");
    expect(score({ operator: 'gte' })).toBe("A contact's engagement score changes");
    expect(score({ operator: 'maybe', score: 3 })).toBe("A contact's engagement score changes");
    expect(
      stepSummary(
        { type: 'score.modify', config: { calculation: 'subtract', points: 5 } },
        harborSetup,
      ),
    ).toBe('Subtract 5 from their engagement score');
    expect(
      stepSummary({ type: 'score.modify', config: { calculation: 'add' } }, harborSetup),
    ).toBeUndefined();
  });

  it.each(Object.keys(automationTriggerTypes))(
    '%s has a label, an example and a summary',
    (type) => {
      const example = triggerExamples[type];
      if (example === undefined) throw new Error(`Add an example for ${type}.`);
      const config = automationTriggerTypes[type as keyof typeof automationTriggerTypes].config;
      expect(config.safeParse(example.config).success).toBe(true);
      expect(summarizedTriggerTypes).toContain(type);
      expect(triggerLabel(type)).toEqual(expect.stringMatching(/\S/));
      expect(triggerSummary({ type, config: example.config }, harborSetup)).toBe(example.summary);
    },
  );

  it('reads the other shapes a trigger can take', () => {
    const read = (type: string, config: Record<string, unknown>): string | undefined =>
      triggerSummary({ type, config }, harborSetup);
    expect(read('message.received', {})).toBe('A contact sends a message');
    expect(read('appointment.booked', {})).toBe('Someone books an appointment');
    expect(read('deal.stage_changed', {})).toBe('An opportunity moves to another stage');
    expect(read('deal.closed', {})).toBe('An opportunity is won or lost');
    expect(read('schedule', { every: 'day', at: '08:00' })).toBe('Every day at 08:00');
    expect(read('schedule', { every: 'month', at: '08:00', day: 5 })).toBe(
      'On day 5 of every month at 08:00',
    );
    // A form trigger that names no form starts on every form.
    expect(read('form.submitted', {})).toBe('Someone submits a form');
    expect(read('mystery', {})).toBeUndefined();
  });

  it('says which automations a message has to be a reply to, and a date that comes once', () => {
    expect(
      triggerSummary(
        { type: 'message.received', config: { channel: 'sms', repliedTo: ['aut_other', 'Sales'] } },
        harborSetup,
      ),
    ).toBe('A contact sends a text, in reply to “Win back” or “Sales”');
    expect(
      triggerSummary(
        { type: 'message.received', config: { repliedTo: ['aut_other'] } },
        harborSetup,
      ),
    ).toBe('A contact sends a message, in reply to “Win back”');
    expect(
      triggerSummary(
        { type: 'date.reached', config: { field: 'contact.eventDate', repeat: 'never' } },
        harborSetup,
      ),
    ).toBe('It is event date, that one time');
    expect(
      triggerSummary(
        { type: 'date.reached', config: { field: 'contact.eventDate', repeat: 'yearly' } },
        harborSetup,
      ),
    ).toBe('It is event date');
  });

  it('says whose run ended, how, and what stopped it', () => {
    const ended = (config: Record<string, unknown>): string | undefined =>
      triggerSummary({ type: 'automation.run_ended', config }, harborSetup);
    expect(ended({ automations: ['aut_other', 'Sales'] })).toBe(
      "A contact's run of “Win back” or “Sales” ends",
    );
    expect(ended({ automations: ['aut_other'], how: ['completed', 'failed', 'odd'] })).toBe(
      "A contact's run of “Win back” reaches its end or fails",
    );
    expect(ended({ automations: ['aut_other'], how: ['removed'] })).toBe(
      "A contact's run of “Win back” is ended by a “Remove from automations” action",
    );
    expect(ended({ automations: ['aut_other'], stoppedBy: ['appointment.booked', 'odd'] })).toBe(
      "A contact's run of “Win back” ends, when what stopped it was “They book an appointment”",
    );
    expect(ended({ automations: [] })).toBeUndefined();
  });

  it("adds the trigger's own condition", () => {
    expect(
      triggerSummary(
        {
          type: 'contact.created',
          config: {},
          condition: { field: 'contact.email', operator: 'is_set' },
        },
        harborSetup,
      ),
    ).toBe('A contact is created, but only if email is filled in');
  });
});

describe('a stop on a reply to this run', () => {
  it('says the reply has to answer what this automation sent', () => {
    expect(stopSummary({ event: 'message.received', from: 'contact', repliedTo: 'this_run' })).toBe(
      'They reply to a message this automation sent them',
    );
    expect(stopSummary({ event: 'message.received', from: 'contact' })).toBe('They reply');
  });
});

describe('stop summaries', () => {
  it.each(automationStopEvents)('%s reads as a sentence', (event) => {
    expect(summarizedStopEvents).toContain(event);
    expect(stopSummary({ event, from: undefined })).toEqual(expect.stringMatching(/\S/));
  });

  it('says who the message is from, and any condition', () => {
    expect(stopSummary({ event: 'message.received', from: 'contact' })).toBe('They reply');
    expect(stopSummary({ event: 'message.received', from: 'team' })).toBe(
      'Someone on the team messages them',
    );
    expect(
      stopSummary({
        event: 'deal.closed',
        from: undefined,
        condition: { field: 'deal.amount', operator: 'greater_than', value: 100 },
      }),
    ).toBe('Their opportunity is won or lost, but only if opportunity amount is more than 100');
    expect(stopSummary({ event: 'mystery', from: undefined })).toBeUndefined();
  });
});

describe('words', () => {
  it.each([
    ['P2D', '2 days'],
    ['P1D', '1 day'],
    ['PT4H', '4 hours'],
    ['PT30M', '30 minutes'],
    ['P1W', '1 week'],
    ['P1DT4H', '1 day and 4 hours'],
    ['P1Y2M3DT4H5M6S', '1 year, 2 months, 3 days, 4 hours, 5 minutes, and 6 seconds'],
    ['PT0M', '0 minutes'],
  ])('reads the duration %s as %s', (iso, words) => {
    expect(durationWords(iso)).toBe(words);
  });

  it.each(['', 'P', '2 days', 'PT', 42, undefined])('has no words for %j', (given) => {
    expect(durationWords(given)).toBeUndefined();
  });

  it('reads a field path', () => {
    expect(fieldWords('contact.firstName')).toBe('first name');
    expect(fieldWords('contact.custom.wedding_date')).toBe('wedding date');
    expect(fieldWords('deal.amount')).toBe('opportunity amount');
    expect(fieldWords('appointment.startsAt')).toBe('appointment.startsAt');
    expect(fieldWords('')).toBeUndefined();
  });

  it.each([
    [{ field: 'contact.email', operator: 'is_empty' }, 'email is empty'],
    [{ field: 'contact.firstName', operator: 'equals', value: 'Sam' }, 'first name is “Sam”'],
    [
      { field: 'contact.firstName', operator: 'not_equals', value: 'Sam' },
      'first name is not “Sam”',
    ],
    [{ field: 'contact.tags', operator: 'excludes', value: 'VIP' }, "tags doesn't include “VIP”"],
    [
      { field: 'deal.amount', operator: 'less_than', value: 5 },
      'opportunity amount is less than 5',
    ],
    [
      { field: 'contact.createdAt', operator: 'before', value: '2026-01-01' },
      'created at is before “2026-01-01”',
    ],
    [
      { field: 'contact.createdAt', operator: 'after', value: '2026-01-01' },
      'created at is after “2026-01-01”',
    ],
    [
      { field: 'contact.createdAt', operator: 'within_last', value: 'P7D' },
      'created at was in the last 7 days',
    ],
    [
      { field: 'deal.expectedCloseDate', operator: 'within_next', value: 'P1W' },
      'opportunity expected close date is in the next 1 week',
    ],
    [{ field: 'contact.custom.newsletter', operator: 'equals', value: true }, 'newsletter is yes'],
    [
      {
        all: [
          { field: 'contact.email', operator: 'is_set' },
          {
            any: [
              { field: 'contact.firstName', operator: 'equals', value: 'Sam' },
              { not: { field: 'contact.phone', operator: 'is_set' } },
            ],
          },
        ],
      },
      'email is filled in and (first name is “Sam” or not phone is filled in)',
    ],
  ])('reads the condition %j', (condition, words) => {
    expect(conditionWords(condition)).toBe(words);
  });

  it.each([
    [undefined],
    ['text'],
    [{}],
    [{ field: 'contact.email' }],
    [{ field: 'contact.email', operator: 'resembles', value: 1 }],
    [{ all: [] }],
    [{ all: [{ field: 'contact.email', operator: 'is_set' }, {}] }],
  ])('has no words for the unfinished condition %j', (condition) => {
    expect(conditionWords(condition)).toBeUndefined();
  });

  it('finds a name by id, keeps a name given as a name, and has none for nothing', () => {
    expect(nameIn(harborSetup.tags, 'tag_vip')).toBe('VIP');
    expect(nameIn(harborSetup.tags, 'Gold')).toBe('Gold');
    expect(nameIn(harborSetup.tags, '  ')).toBeUndefined();
    expect(nameIn(harborSetup.tags, 7)).toBeUndefined();
  });
});
