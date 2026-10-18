import { validateAutomation } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { followUp, harborSetup, welcome } from '../e2e/automation-fixtures';
import { addStep, addTrigger, stepOf, triggersOf, type Draft } from './automation-document';
import {
  duplicateTrigger,
  setStepLabel,
  replyStopScope,
  setReplyStopScope,
  setStopOnReply,
  settingsOf,
  startingWindow,
  stopsOnReply,
  updateTrigger,
  withSettings,
} from './automation-edits';

const valid = (draft: Draft): boolean => validateAutomation(draft, harborSetup).errors.length === 0;

describe("a step's own name", () => {
  it('is given, changed and taken away, and nothing else about the step changes', () => {
    const named = setStepLabel(followUp, 'send_guide', '  Send the guide  ');
    expect(stepOf(named, 'send_guide')?.label).toBe('Send the guide');
    expect(named['steps']).toEqual({
      ...followUp.steps,
      send_guide: { ...followUp.steps.send_guide, label: 'Send the guide' },
    });
    expect(valid(named)).toBe(true);
    expect(setStepLabel(named, 'send_guide', '')).toEqual(followUp);
    expect(setStepLabel(named, 'send_guide', undefined)).toEqual(followUp);
  });

  it('leaves the draft alone for a step that is not there, or a draft with no steps', () => {
    expect(setStepLabel(followUp, 'nowhere', 'Name')).toBe(followUp);
    expect(setStepLabel({ name: 'Empty' }, 'send_guide', 'Name')).toEqual({ name: 'Empty' });
  });

  it('comes with a step added under a name', () => {
    const added = addStep(
      welcome,
      { kind: 'after', step: 'add_tag' },
      { id: 'wait', type: 'wait', config: { duration: 'P1D' }, label: 'Sleep on it' },
    );
    expect(stepOf(added, 'wait')?.label).toBe('Sleep on it');
    expect(valid(added)).toBe(true);
  });
});

describe('a trigger', () => {
  const vip = { field: 'contact.tags', operator: 'includes', value: 'VIP' };

  it('is added with its filters', () => {
    const added = addTrigger(welcome, {
      type: 'tag.added',
      config: { tag: 'tag_vip' },
      condition: vip,
    });
    expect(added['triggers']).toEqual([
      ...welcome.triggers,
      { id: 'tag_added', type: 'tag.added', config: { tag: 'tag_vip' }, if: vip },
    ]);
    expect(valid(added)).toBe(true);
  });

  it('changes its type, settings and filters, and keeps its id', () => {
    const changed = updateTrigger(followUp, 0, {
      type: 'contact.created',
      config: {},
      condition: vip,
    });
    expect(changed['triggers']).toEqual([
      { id: 'quote_form', type: 'contact.created', config: {}, if: vip },
    ]);
    expect(valid(changed)).toBe(true);
    // Taking the filters away takes the member away.
    expect(
      updateTrigger(changed, 0, { type: 'contact.created', config: {}, condition: undefined })[
        'triggers'
      ],
    ).toEqual([{ id: 'quote_form', type: 'contact.created', config: {} }]);
  });

  it('changes only the one named, and nothing when there is none there', () => {
    const two = addTrigger(followUp, { type: 'contact.created', config: {} });
    const changed = updateTrigger(two, 1, {
      type: 'tag.added',
      config: { tag: 'tag_vip' },
      condition: undefined,
    });
    expect(triggersOf(changed).map((trigger) => trigger.type)).toEqual([
      'form.submitted',
      'tag.added',
    ]);
    expect(triggersOf(changed)[0]).toEqual(triggersOf(followUp)[0]);
    expect(
      updateTrigger(followUp, 3, { type: 'tag.added', config: {}, condition: undefined }),
    ).toBe(followUp);
    expect(
      updateTrigger(followUp, -1, { type: 'tag.added', config: {}, condition: undefined }),
    ).toBe(followUp);
    expect(
      updateTrigger({ name: 'Empty' }, 0, { type: 'tag.added', config: {}, condition: undefined }),
    ).toEqual({
      name: 'Empty',
    });
  });

  it('is copied right after itself, under an id of its own', () => {
    const filtered = updateTrigger(followUp, 0, {
      type: 'form.submitted',
      config: { form: 'Request a quote' },
      condition: vip,
    });
    const two = addTrigger(filtered, { type: 'contact.created', config: {} });
    const copied = duplicateTrigger(two, 0);
    expect(copied['triggers']).toEqual([
      { id: 'quote_form', type: 'form.submitted', config: { form: 'Request a quote' }, if: vip },
      {
        id: 'form_submitted',
        type: 'form.submitted',
        config: { form: 'Request a quote' },
        if: vip,
      },
      { id: 'contact_created', type: 'contact.created', config: {} },
    ]);
    expect(valid(copied)).toBe(true);
    expect(duplicateTrigger(followUp, 4)).toBe(followUp);
  });
});

describe('the settings', () => {
  it("are the document's, with its defaults for what it leaves out", () => {
    expect(settingsOf(followUp)).toEqual({ reEntry: true, timezone: 'contact', window: undefined });
    expect(settingsOf(welcome)).toEqual({
      reEntry: false,
      timezone: 'business',
      window: undefined,
    });
    expect(settingsOf({ settings: 'none' })).toEqual({
      reEntry: false,
      timezone: 'business',
      window: undefined,
    });
  });

  it('read a time window as written, and whatever of it cannot be read as the starting one', () => {
    expect(
      settingsOf({
        settings: {
          sendingWindow: { days: ['saturday', 'someday', 3], start: '10:30', end: '25:00' },
        },
      }).window,
    ).toEqual({ days: ['saturday'], start: '10:30', end: '17:00' });
    expect(settingsOf({ settings: { sendingWindow: { days: 'weekdays' } } }).window).toEqual({
      days: [],
      start: '09:00',
      end: '17:00',
    });
  });

  it('are written back one at a time, and the rest of the document stays', () => {
    const off = withSettings(followUp, { reEntry: false });
    expect(off['settings']).toEqual({ reEnrollment: 'never', timezone: 'contact' });
    expect({ ...off, settings: followUp.settings }).toEqual(followUp);
    expect(withSettings(welcome, { timezone: 'contact' })['settings']).toEqual({
      reEnrollment: 'never',
      timezone: 'contact',
    });
    expect(valid(withSettings(welcome, { timezone: 'contact', reEntry: true }))).toBe(true);
  });

  it('write a time window with its days in the order of the week, and take it away again', () => {
    const windowed = withSettings(followUp, {
      window: { days: ['friday', 'monday'], start: '08:00', end: '12:00' },
    });
    expect(windowed['settings']).toEqual({
      reEnrollment: 'after_finished',
      timezone: 'contact',
      sendingWindow: { days: ['monday', 'friday'], start: '08:00', end: '12:00' },
    });
    expect(valid(windowed)).toBe(true);
    expect(valid(withSettings(followUp, { window: startingWindow }))).toBe(true);
    expect(withSettings(windowed, { window: undefined })).toEqual(followUp);
  });
});

describe('which messages stop the workflow', () => {
  const stop = { event: 'message.received', from: 'contact' };

  it('is any message, or only a reply to what this run sent', () => {
    expect(replyStopScope(welcome)).toBeUndefined();
    expect(replyStopScope({ stopWhen: [stop] })).toBe('any');
    expect(replyStopScope({ stopWhen: [{ ...stop, repliedTo: 'this_run' }] })).toBe('this_run');
  });

  it('changes only the stop on a reply, and leaves a workflow without one alone', () => {
    const draft = { stopWhen: [{ event: 'deal.closed' }, stop] };
    const narrowed = setReplyStopScope(draft, 'this_run');
    expect(narrowed).toEqual({
      stopWhen: [{ event: 'deal.closed' }, { ...stop, repliedTo: 'this_run' }],
    });
    expect(setReplyStopScope(narrowed, 'this_run')).toBe(narrowed);
    expect(setReplyStopScope(narrowed, 'any')).toEqual(draft);
    expect(setReplyStopScope(welcome, 'this_run')).toBe(welcome);
    // Turned off, the narrowed stop goes as the wide one does.
    expect(setStopOnReply(narrowed, false)).toEqual({ stopWhen: [{ event: 'deal.closed' }] });
  });
});

describe('stopping when the contact replies', () => {
  it('is on when a message from the contact, with no condition, stops the workflow', () => {
    expect(stopsOnReply(followUp)).toBe(true);
    expect(stopsOnReply(welcome)).toBe(false);
    expect(stopsOnReply({ stopWhen: [{ event: 'message.received', from: 'team' }] })).toBe(false);
    expect(
      stopsOnReply({
        stopWhen: [
          {
            event: 'message.received',
            from: 'contact',
            if: { field: 'contact.email', operator: 'is_set' },
          },
        ],
      }),
    ).toBe(false);
  });

  it('is switched on beside the other stops, and off without touching them', () => {
    const on = setStopOnReply(welcome, true);
    expect(on['stopWhen']).toEqual([{ event: 'message.received', from: 'contact' }]);
    expect(valid(on)).toBe(true);
    expect(setStopOnReply(on, true)).toBe(on);
    expect(setStopOnReply(on, false)).toEqual(welcome);

    const off = setStopOnReply(followUp, false);
    expect(off['stopWhen']).toEqual([{ event: 'appointment.booked' }, { event: 'deal.closed' }]);
    expect(valid(off)).toBe(true);
    expect(setStopOnReply(off, false)).toBe(off);
    expect(setStopOnReply(off, true)['stopWhen']).toEqual([
      { event: 'appointment.booked' },
      { event: 'deal.closed' },
      { event: 'message.received', from: 'contact' },
    ]);
  });
});
