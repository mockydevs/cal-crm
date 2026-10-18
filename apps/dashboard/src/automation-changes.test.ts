import { i18n } from '@lingui/core';
import { diffJson, validateAutomation, type JsonValue } from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { followUp, harborSetup, welcome } from '../e2e/automation-fixtures';
import { comparable, describeChanges, publishChanges, type Change } from './automation-changes';
import {
  addStep,
  addTrigger,
  removeStep,
  renameAutomation,
  updateStepConfig,
  type Draft,
} from './automation-document';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const changesTo = (draft: Draft, live: Draft = followUp): Change[] =>
  describeChanges(live, draft, harborSetup);

describe('describeChanges', () => {
  it('finds nothing between a document and itself', () => {
    expect(changesTo(followUp)).toEqual([]);
  });

  it('leaves out what nobody changed: canvas positions, the schema link, step versions', () => {
    const steps = Object.fromEntries(
      Object.entries(followUp.steps).map(([id, step]) => [id, { ...step, typeVersion: 1 }]),
    );
    expect(
      changesTo({
        ...followUp,
        $schema: 'https://crm.example.test/api/v1/automations/schema',
        layout: { send_guide: { x: 10, y: 20 } },
        steps,
      }),
    ).toEqual([]);
  });

  it('describes an added step by what it does, and the step before it by where it now leads', () => {
    const draft = addStep(
      followUp,
      { kind: 'after', step: 'send_guide' },
      { id: 'tag_add', type: 'tag.add', config: { tag: 'tag_vip' } },
    );
    expect(changesTo(draft)).toEqual([
      {
        kind: 'changed',
        about: 'step',
        step: 'send_guide',
        title: 'Send email',
        before: 'Send the email “Pricing guide”',
        after: 'Send the email “Pricing guide”',
        details: [{ label: 'What comes next', before: 'Wait 2 days', after: 'Add the tag VIP' }],
      },
      {
        kind: 'added',
        about: 'step',
        step: 'tag_add',
        title: 'Add tag',
        before: undefined,
        after: 'Add the tag VIP',
        details: [],
      },
    ]);
  });

  it('describes a removed step, and the rejoined flow', () => {
    const changes = changesTo(removeStep(followUp, 'wait_2_days'));
    expect(changes.map((change) => [change.kind, change.title, change.before])).toEqual([
      ['changed', 'Send email', 'Send the email “Pricing guide”'],
      ['removed', 'Wait', 'Wait 2 days'],
    ]);
    expect(changes[0]?.details).toEqual([
      { label: 'What comes next', before: 'Wait 2 days', after: 'If services includes “video”' },
    ]);
  });

  it('describes a changed setting by its form label, before and after', () => {
    expect(changesTo(updateStepConfig(followUp, 'wait_2_days', { duration: 'P5D' }))).toEqual([
      {
        kind: 'changed',
        about: 'step',
        step: 'wait_2_days',
        title: 'Wait',
        before: 'Wait 2 days',
        after: 'Wait 5 days',
        details: [{ label: 'How long to wait', before: '2 days', after: '5 days' }],
      },
    ]);
  });

  it('describes where each branch leads when a branch changes', () => {
    const draft = removeStep(followUp, 'send_reel');
    const check = changesTo(draft).find((change) => change.step === 'asked_about_video');
    expect(check?.details).toEqual([
      {
        label: 'What comes next',
        before:
          'If yes: Text them “Here’s our video sample reel: {{values.sample_reel_url}}”; If no: Text them “Hi {{contact.firstName}}, did the pricing guide come through?”',
        after:
          'If yes: the path ends; If no: Text them “Hi {{contact.firstName}}, did the pricing guide come through?”',
      },
    ]);
  });

  it('describes a setting no form knows by its key, and a new kind of step', () => {
    const steps = {
      ...followUp.steps,
      wait_2_days: { ...followUp.steps.wait_2_days, config: { duration: 'P2D', jitter: 'PT1H' } },
      last_check_in: { type: 'tag.add', config: { tag: 'tag_cold' }, label: 'Mark cold' },
    };
    const changes = changesTo({ ...followUp, steps });
    expect(changes.find((change) => change.step === 'wait_2_days')?.details).toEqual([
      { label: 'jitter', before: undefined, after: '“PT1H”' },
    ]);
    expect(changes.find((change) => change.step === 'last_check_in')).toMatchObject({
      title: 'Mark cold',
      details: [
        { label: 'Kind of step', before: 'Send text', after: 'Add tag' },
        { label: 'Name', before: undefined, after: 'Mark cold' },
      ],
    });
  });

  it('describes triggers, stops, settings, the name and the first step', () => {
    const draft: Draft = {
      ...addTrigger(renameAutomation(followUp, 'Quote follow-up'), {
        type: 'tag.added',
        config: { tag: 'tag_vip' },
      }),
      description: 'Shorter.',
      start: 'wait_2_days',
      stopWhen: [{ event: 'message.received', from: 'contact' }, { event: 'tag.added' }],
      settings: {
        reEnrollment: 'never',
        timezone: 'contact',
        sendingWindow: { days: ['monday'], start: '09:00', end: '17:00' },
      },
    };
    const changes = changesTo(draft);
    expect(
      changes.map((change) => [
        change.kind,
        change.about,
        change.title,
        change.before,
        change.after,
      ]),
    ).toEqual([
      ['changed', 'automation', 'Name', '“New lead follow-up”', '“Quote follow-up”'],
      [
        'changed',
        'automation',
        'Description',
        '“Pricing guide, then up to two texts until they reply or book.”',
        '“Shorter.”',
      ],
      ['added', 'trigger', 'Starts when', undefined, 'The tag VIP is added to a contact'],
      ['changed', 'automation', 'First step', 'Send the email “Pricing guide”', 'Wait 2 days'],
      ['added', 'stop', 'Stops as soon as', undefined, 'A tag is added to them'],
      ['removed', 'stop', 'Stops as soon as', 'They book an appointment', undefined],
      ['removed', 'stop', 'Stops as soon as', 'Their opportunity is won or lost', undefined],
      ['changed', 'automation', 'Settings', undefined, undefined],
    ]);
    expect(changes.at(-1)?.details).toEqual([
      {
        label: 'Going through again',
        before: "A contact can go through again once they've finished",
        after: 'Each contact goes through once',
      },
      {
        label: 'When messages may go out',
        before: undefined,
        after: '{"days":["monday"],"start":"09:00","end":"17:00"}',
      },
    ]);
  });

  it('describes a changed and a removed trigger', () => {
    const changed = changesTo({
      ...followUp,
      triggers: [
        {
          id: 'quote_form',
          type: 'form.submitted',
          config: { form: 'Contact us' },
          if: { field: 'contact.email', operator: 'is_set' },
        },
      ],
    });
    expect(changed).toEqual([
      {
        kind: 'changed',
        about: 'trigger',
        title: 'Starts when',
        before: 'Someone submits “Request a quote”',
        after: 'Someone submits “Contact us”, but only if email is filled in',
        details: [
          { label: 'Form', before: 'Request a quote', after: 'Contact us' },
          {
            label: 'Only if',
            before: undefined,
            after: '{"field":"contact.email","operator":"is_set"}',
          },
        ],
      },
    ]);
    const swapped = changesTo({
      ...followUp,
      triggers: [{ id: 'made', type: 'contact.created', config: {} }],
    });
    expect(swapped.map((change) => [change.kind, change.before ?? change.after])).toEqual([
      ['added', 'A contact is created'],
      ['removed', 'Someone submits “Request a quote”'],
    ]);
  });

  it('reports a member it has no words for, rather than hiding it', () => {
    expect(changesTo({ ...followUp, experiment: { on: true } })).toEqual([
      {
        kind: 'added',
        about: 'automation',
        title: 'experiment',
        before: undefined,
        after: '{"on":true}',
        details: [],
      },
    ]);
  });

  it('reads a step that is not set up yet as that', () => {
    const draft = addStep(
      followUp,
      { kind: 'after', step: 'last_check_in' },
      { id: 'email_send', type: 'email.send', config: {} },
    );
    expect(changesTo(draft).at(-1)).toMatchObject({ kind: 'added', after: 'Not set up yet' });
  });

  it.each([
    ['a rename', renameAutomation(followUp, 'Other')],
    ['a setting', updateStepConfig(followUp, 'check_in', { message: 'Hello' })],
    ['a removal', removeStep(followUp, 'asked_about_video')],
    ['another automation', welcome],
    ['an unknown member', { ...followUp, extra: 1 }],
    [
      'a step note',
      {
        ...followUp,
        steps: { ...followUp.steps, send_reel: { ...followUp.steps.send_reel, notes: 'Why' } },
      },
    ],
    ['nothing at all', { ...followUp, layout: {} }],
  ] as const)('says something exactly when the documents differ: %s', (_, draft: Draft) => {
    const differs =
      diffJson(comparable(followUp) as JsonValue, comparable(draft) as JsonValue).length > 0;
    expect(changesTo(draft).length > 0).toBe(differs);
  });
});

describe('publishChanges', () => {
  // What the server keeps on publish: the resolved document.
  const live = validateAutomation(followUp, harborSetup).document;
  if (live === undefined) throw new Error('The fixture is valid.');

  it('sees no change between a draft written with names and its published, resolved self', () => {
    expect(JSON.stringify(live)).not.toBe(JSON.stringify(followUp));
    expect(publishChanges(live, followUp, harborSetup)).toEqual([]);
  });

  it('shows only the edit made since publishing', () => {
    const draft = updateStepConfig(followUp, 'wait_3_days', { duration: 'P4D' });
    expect(publishChanges(live, draft, harborSetup)).toEqual([
      {
        kind: 'changed',
        about: 'step',
        step: 'wait_3_days',
        title: 'Wait',
        before: 'Wait 3 days',
        after: 'Wait 4 days',
        details: [{ label: 'How long to wait', before: '3 days', after: '4 days' }],
      },
    ]);
  });

  it('still compares a draft that is not valid yet, as it is written', () => {
    const draft = updateStepConfig(followUp, 'wait_3_days', { duration: 'soon' });
    const changes = publishChanges(followUp, draft, harborSetup);
    expect(changes.map((change) => change.step)).toContain('wait_3_days');
  });
});

describe('describeChanges, further', () => {
  it('describes a trigger of another kind, and a setting with several members', () => {
    const draft: Draft = {
      ...followUp,
      triggers: [{ id: 'quote_form', type: 'schedule', config: { every: 'day', at: '09:00' } }],
    };
    expect(changesTo(draft)).toEqual([
      {
        kind: 'changed',
        about: 'trigger',
        title: 'Starts when',
        before: 'Someone submits “Request a quote”',
        after: 'Every day at 09:00',
        details: [],
      },
    ]);
    const weekly: Draft = {
      ...draft,
      triggers: [
        {
          id: 'quote_form',
          type: 'schedule',
          config: { every: 'week', at: '09:00', weekday: 'monday' },
        },
      ],
    };
    expect(describeChanges(draft, weekly, harborSetup)[0]?.details).toEqual([
      {
        label: 'When it repeats',
        before: '{"every":"day","at":"09:00"}',
        after: '{"every":"week","at":"09:00","weekday":"monday"}',
      },
    ]);
  });

  it('describes a setting taken away, a member no longer there, and a trigger it has no words for', () => {
    const before: Draft = {
      ...followUp,
      experiment: true,
      triggers: [{ id: 'ping', type: 'ping.received', config: {}, note: 'old' }],
      steps: {
        ...followUp.steps,
        send_guide: {
          ...followUp.steps.send_guide,
          config: { template: 'Pricing guide', mailbox: 'mbx_hello' },
        },
      },
      settings: { timezone: 'contact', quietHours: 'PT8H' },
    };
    const after: Draft = {
      ...followUp,
      triggers: [{ id: 'ping', type: 'ping.received', config: {} }],
      settings: 'none',
    };
    const changes = describeChanges(before, after, harborSetup);
    expect(changes.find((change) => change.about === 'trigger')).toEqual({
      kind: 'changed',
      about: 'trigger',
      title: 'Starts when',
      before: 'ping.received',
      after: 'ping.received',
      details: [{ label: 'note', before: '“old”', after: undefined }],
    });
    expect(changes.find((change) => change.step === 'send_guide')?.details).toEqual([
      { label: 'Send from', before: 'hello@harborlights.example', after: undefined },
    ]);
    expect(changes.find((change) => change.title === 'Settings')?.details).toEqual([
      { label: 'Time zone', before: "The contact's", after: undefined },
      { label: 'quietHours', before: '8 hours', after: undefined },
    ]);
    expect(changes.at(-1)).toEqual({
      kind: 'removed',
      about: 'automation',
      title: 'experiment',
      before: 'true',
      after: undefined,
      details: [],
    });
  });

  it('names a first step by its id when the step is not there, and reads odd documents', () => {
    const changes = describeChanges(
      { name: 'A', start: 'ghost', steps: 'none', stopWhen: [{ event: 'ping.received' }] },
      { name: 'A', start: 'real', steps: { real: 7 }, stopWhen: 'none' },
      harborSetup,
    );
    expect(changes).toEqual([
      {
        kind: 'changed',
        about: 'automation',
        title: 'First step',
        before: 'ghost',
        after: 'real',
        details: [],
      },
      {
        kind: 'added',
        about: 'step',
        step: 'real',
        title: '',
        before: undefined,
        after: 'Not set up yet',
        details: [],
      },
      {
        kind: 'removed',
        about: 'stop',
        title: 'Stops as soon as',
        before: '{"event":"ping.received"}',
        after: undefined,
        details: [],
      },
    ]);
  });
});
