// Flow control: a condition with several branches, Go To, the goal step, and a stop that
// applies only to a reply to the run's own messages. Shape, validation and the published
// catalog; the engine's side is tested in packages/modules/automation.
import { describe, expect, it } from 'vitest';

import {
  automationBranchNames,
  automationGoalEvents,
  automationStepTypes,
  MAX_CONDITION_BRANCHES,
  MAX_RUN_STEPS,
  MAX_STEP_VISITS,
} from './automations-catalog.js';
import { automationCatalog, automationDocument } from './automations.js';
import {
  portableAutomation,
  validateAutomation,
  type AutomationSetup,
} from './automations-validate.js';

const setup: AutomationSetup = {
  fields: {
    contact: [
      { key: 'budget', aliases: [], type: 'number', options: [] },
      { key: 'event_date', aliases: [], type: 'date', options: [] },
    ],
    deal: [],
  },
  forms: [
    { id: 'frm_quote', name: 'Request a quote' },
    { id: 'frm_book', name: 'Book a call' },
  ],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [{ id: 'mbx_sales', name: 'Sales' }],
  phoneNumbers: [],
  calendars: [],
  pipelines: [{ id: 'pip_sales', name: 'Sales', stages: [{ id: 'stg_won', name: 'Booked' }] }],
  lostReasons: [],
  tags: [{ id: 'tag_vip', name: 'VIP' }],
  users: [],
  automations: [],
  triggerLinks: [{ id: 'tlk_brochure', name: 'Brochure', key: 'brochure' }],
  values: [],
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const created = { id: 'created', type: 'contact.created', config: {} };
const pause = { type: 'wait', config: { duration: 'PT1M' } };
const document = (steps: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  name: 'Flow',
  triggers: [created],
  start: Object.keys(steps)[0],
  steps,
  ...more,
});
const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => `${issue.path} ${issue.code}`);

const big = { field: 'contact.custom.budget', operator: 'greater_than', value: 5000 };
const medium = { field: 'contact.budget', operator: 'greater_than', value: 1000 };

describe('a condition with several branches', () => {
  const branching = (next: Record<string, string>, branches?: unknown) =>
    document({
      size: {
        type: 'condition',
        config: {
          branches: branches ?? [
            { name: 'large', label: 'Large budget', if: big },
            { name: 'medium', if: { any: [medium, { not: big }] } },
          ],
        },
        next,
      },
      a: pause,
      b: pause,
      c: pause,
    });

  it('is valid with a step for each named branch and for none, in the order written', () => {
    const result = validateAutomation(branching({ large: 'a', medium: 'b', none: 'c' }), setup);
    expect(result.errors).toEqual([]);
    const step = result.document?.steps['size'];
    expect(step).toMatchObject({ type: 'condition', typeVersion: 2 });
    // Field paths inside each branch are made canonical, as a two-way condition's are.
    expect(step?.config).toEqual({
      branches: [
        { name: 'large', label: 'Large budget', if: big },
        {
          name: 'medium',
          if: { any: [{ ...medium, field: 'contact.custom.budget' }, { not: big }] },
        },
      ],
    });
    expect(automationBranchNames('condition', step?.config)).toEqual(['large', 'medium', 'none']);
  });

  it('keeps a two-way condition valid as it was written, with yes and no', () => {
    const check = { type: 'condition', config: { if: big }, next: { yes: 'a', no: 'b' } };
    const twoWay = document({ check, a: pause, b: pause });
    const result = validateAutomation(twoWay, setup);
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['check']).toMatchObject({
      config: { if: big },
      next: { yes: 'a', no: 'b' },
    });
    expect(automationBranchNames('condition', { if: big })).toEqual(['yes', 'no']);
    // A version published before step version 2 still parses, untouched.
    const stored = { ...check, typeVersion: 1 };
    expect(
      automationDocument.parse({ ...twoWay, steps: { ...twoWay.steps, check: stored } }).steps[
        'check'
      ],
    ).toEqual(stored);
  });

  it('refuses a branch the step does not have, in either shape', () => {
    expect(
      codes(validateAutomation(branching({ large: 'a', small: 'b', none: 'c' }), setup)),
    ).toEqual(['/steps/size/next/small unknown_branch']);
    const twoWay = document({
      check: { type: 'condition', config: { if: big }, next: { yes: 'a', none: 'a' } },
      a: pause,
    });
    const result = validateAutomation(twoWay, setup);
    // The first shape keeps its two branches, refused where the shape is checked.
    expect(result.errors).toEqual([
      {
        path: '/steps/check/next',
        code: 'invalid',
        message: "This step's branches are yes and no, not none.",
      },
    ]);
  });

  it('refuses two branches of one name, and a branch named none', () => {
    const twice = branching({ large: 'a', none: 'b' }, [
      { name: 'large', if: big },
      { name: 'large', if: medium },
    ]);
    expect(codes(validateAutomation(twice, setup))).toContain(
      '/steps/size/config duplicate_branch',
    );
    const reserved = branching({ none: 'a' }, [{ name: 'none', if: big }]);
    expect(codes(validateAutomation(reserved, setup))).toContain(
      '/steps/size/config/branches/0/name reserved_branch',
    );
  });

  it('takes one branch at least and ten at most', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ name: `b${String(index)}`, if: big }));
    const parse = (branches: unknown) =>
      automationDocument.safeParse(document({ size: { type: 'condition', config: { branches } } }))
        .success;
    expect(MAX_CONDITION_BRANCHES).toBe(10);
    expect(parse([])).toBe(false);
    expect(parse(many(10))).toBe(true);
    expect(parse(many(11))).toBe(false);
    // One shape or the other, never both.
    expect(
      automationDocument.safeParse(
        document({ size: { type: 'condition', config: { if: big, branches: many(1) } } }),
      ).success,
    ).toBe(false);
  });

  it('tells a wrong field or comparison inside a branch where it is', () => {
    const wrong = branching({ none: 'a' }, [
      { name: 'large', if: { field: 'contact.custom.bugdet', operator: 'equals', value: 1 } },
    ]);
    const result = validateAutomation(wrong, setup);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: '/steps/size/config/branches/0/if/field',
        code: 'unknown_field',
        suggestion: 'Did you mean contact.custom.budget?',
      }),
    );
  });

  it('says in the catalog how the step branches', () => {
    const entry = automationCatalog().steps.find((step) => step.type === 'condition');
    expect(entry).toMatchObject({
      version: 2,
      branches: { kind: 'from_config', field: 'branches', fallback: 'none', legacy: ['yes', 'no'] },
    });
    // The other steps' branches are named the same way they always were.
    expect(
      automationBranchNames('split', {
        variants: [
          { name: 'a', percent: 50 },
          { name: 'b', percent: 50 },
        ],
      }),
    ).toEqual(['a', 'b']);
    expect(automationBranchNames('wait.event', {})).toEqual(['received', 'timed_out']);
    expect(automationBranchNames('wait', {})).toBeUndefined();
  });
});

describe('go to', () => {
  const nudge = { type: 'email.send', config: { subject: 'Still there?', body: 'Hello' } };

  it('jumps to another step, and a loop through it is allowed when it waits', () => {
    const loop = document({
      nudge: { ...nudge, next: 'pause' },
      pause: { type: 'wait', config: { duration: 'P1D' }, next: 'again' },
      again: { type: 'goto', config: { target: 'nudge' } },
    });
    const result = validateAutomation(loop, setup);
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['again']).toMatchObject({ type: 'goto', typeVersion: 1 });
    expect(automationStepTypes.goto).toMatchObject({ group: 'logic', branches: { kind: 'none' } });
  });

  it('refuses a target that is not a step, with the closest one', () => {
    const result = validateAutomation(
      document({
        first: { ...pause, next: 'back' },
        back: { type: 'goto', config: { target: 'frist' } },
      }),
      setup,
    );
    expect(result.errors).toEqual([
      {
        path: '/steps/back/config/target',
        code: 'unknown_step',
        message: "There's no step frist.",
        suggestion: 'Did you mean first?',
      },
    ]);
  });

  it('refuses a loop through it that holds no wait, a condition or not', () => {
    const spin = document({
      check: { type: 'condition', config: { if: big }, next: { yes: 'done', no: 'back' } },
      back: { type: 'goto', config: { target: 'check' } },
      done: pause,
    });
    expect(codes(validateAutomation(spin, setup))).toEqual(['/steps/back loop_without_wait']);
    const self = document({ back: { type: 'goto', config: { target: 'back' } } });
    expect(codes(validateAutomation(self, setup))).toEqual(['/steps/back loop_without_wait']);
  });

  it('ends its path: one with a next is refused', () => {
    const result = validateAutomation(
      document({
        first: { ...pause, next: 'back' },
        back: { type: 'goto', config: { target: 'first' }, next: 'after' },
        after: pause,
      }),
      setup,
    );
    expect(result.errors).toContainEqual({
      path: '/steps/back/next',
      code: 'goto_has_next',
      message: 'A Go To ends its path: it leads to its target and nowhere else.',
      suggestion: 'Remove next from this step.',
    });
  });

  it('makes its target reachable', () => {
    const result = validateAutomation(
      document({
        jump: { type: 'goto', config: { target: 'far' } },
        far: pause,
        lost: pause,
      }),
      setup,
    );
    expect(codes(result)).toEqual(['/steps/lost unreachable_step']);
  });

  it('states the bounds a run keeps', () => {
    expect(MAX_STEP_VISITS).toBe(100);
    expect(MAX_RUN_STEPS).toBe(5000);
  });
});

describe('the goal step', () => {
  const goal = (config: Record<string, unknown>, next?: string) => ({
    type: 'goal',
    config,
    ...(next === undefined ? {} : { next }),
  });
  const booked = { type: 'form.submitted', config: { form: 'Book a call' } };

  it('names its events as the triggers do, and resolves what they refer to', () => {
    const result = validateAutomation(
      document({
        first: { ...pause, next: 'reached' },
        reached: goal(
          {
            events: [
              booked,
              { type: 'tag.added', config: { tag: 'vip' } },
              { type: 'trigger_link.clicked', config: { link: 'Brochure' } },
              { type: 'deal.stage_changed', config: { stage: 'Booked' } },
              { type: 'field.changed', config: { field: 'contact.event_date' } },
              { type: 'message.received', config: { channel: 'email' } },
            ],
            otherwise: 'wait',
          },
          'after',
        ),
        after: pause,
      }),
      setup,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.steps['reached']?.config).toEqual({
      events: [
        { type: 'form.submitted', config: { form: 'frm_book' } },
        { type: 'tag.added', config: { tag: 'tag_vip' } },
        { type: 'trigger_link.clicked', config: { link: 'tlk_brochure' } },
        { type: 'deal.stage_changed', config: { stage: 'stg_won' } },
        { type: 'field.changed', config: { field: 'contact.custom.event_date' } },
        { type: 'message.received', config: { channel: 'email' } },
      ],
      otherwise: 'wait',
    });
  });

  it('goes on anyway unless it says otherwise', () => {
    const parsed = automationDocument.parse(document({ reached: goal({ events: [booked] }) }));
    expect(parsed.steps['reached']?.config).toEqual({ events: [booked], otherwise: 'continue' });
  });

  it('takes the events the engine can hear, and no others', () => {
    expect(automationGoalEvents).toEqual([
      'form.submitted',
      'trigger_link.clicked',
      'tag.added',
      'tag.removed',
      'appointment.booked',
      'appointment.status_changed',
      'message.received',
      'deal.stage_changed',
      'deal.closed',
      'field.changed',
    ]);
    const parse = (events: unknown) =>
      automationDocument.safeParse(document({ reached: goal({ events }) })).success;
    expect(parse([{ type: 'contact.created', config: {} }])).toBe(false);
    expect(parse([{ type: 'date.reached', config: { field: 'contact.custom.event_date' } }])).toBe(
      false,
    );
    // A goal is met by a message, not by which automation it answers.
    expect(parse([{ type: 'message.received', config: { repliedTo: ['aut_x'] } }])).toBe(false);
    expect(parse([])).toBe(false);
    expect(parse(Array.from({ length: 11 }, () => booked))).toBe(false);
  });

  it('tells an unknown form, tag or field in an event where it is', () => {
    const result = validateAutomation(
      document({
        reached: goal({
          events: [
            { type: 'form.submitted', config: { form: 'Book a cal' } },
            { type: 'field.changed', config: { field: 'contact.custom.nothing' } },
          ],
        }),
      }),
      setup,
    );
    expect(codes(result)).toEqual([
      '/steps/reached/config/events/0/config/form unknown_reference',
      '/steps/reached/config/events/1/config/field unknown_field',
    ]);
    expect(result.errors[0]?.suggestion).toBe('Did you mean Book a call?');
  });

  it('is one per automation', () => {
    const result = validateAutomation(
      document({
        first: goal({ events: [booked] }, 'second'),
        second: goal({ events: [booked] }),
      }),
      setup,
    );
    expect(result.errors).toEqual([
      {
        path: '/steps/second',
        code: 'more_than_one_goal',
        message: 'A workflow has one goal step, and first is it.',
        suggestion: 'List every event that meets the goal in that step, and remove this one.',
      },
    ]);
  });

  it('may be a step nothing leads to: a run comes to it when the goal is met', () => {
    const result = validateAutomation(
      document({
        first: pause,
        reached: goal({ events: [booked] }, 'thanks'),
        thanks: pause,
        lost: pause,
      }),
      setup,
    );
    expect(codes(result)).toEqual(['/steps/lost unreachable_step']);
  });

  it('goes out by name and comes back by id', () => {
    const reached = goal({
      events: [
        { type: 'form.submitted', config: { form: 'frm_book' } },
        { type: 'deal.stage_changed', config: { pipeline: 'pip_sales', stage: 'stg_won' } },
      ],
      otherwise: 'continue',
    });
    const { document: portable, warnings } = portableAutomation(document({ reached }), setup);
    expect(warnings).toEqual([]);
    expect((portable['steps'] as Record<string, { config: unknown }>)['reached']?.config).toEqual({
      events: [
        { type: 'form.submitted', config: { form: 'Book a call' } },
        { type: 'deal.stage_changed', config: { pipeline: 'Sales', stage: 'Booked' } },
      ],
      otherwise: 'continue',
    });
    expect(validateAutomation(portable, setup).document?.steps['reached']?.config).toEqual(
      reached.config,
    );
  });
});

describe('a stop on a reply to the run’s own messages', () => {
  const sends = {
    send: { type: 'email.send', config: { subject: 'Your quote', body: 'Hello' }, next: 'pause' },
    pause,
  };

  it('is a choice on the message stop, and the stop without it is as it was', () => {
    const narrow = [{ event: 'message.received', from: 'contact', repliedTo: 'this_run' }];
    const result = validateAutomation(document(sends, { stopWhen: narrow }), setup);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).not.toContain('stop_never_applies');
    expect(result.document?.stopWhen).toEqual(narrow);
    const wide = [{ event: 'message.received', from: 'contact' }];
    expect(
      validateAutomation(document(sends, { stopWhen: wide }), setup).document?.stopWhen,
    ).toEqual(wide);
  });

  it('is not a choice on another stop, and takes no other value', () => {
    const parse = (stop: unknown) =>
      automationDocument.safeParse(document(sends, { stopWhen: [stop] })).success;
    expect(parse({ event: 'appointment.booked', repliedTo: 'this_run' })).toBe(false);
    expect(parse({ event: 'message.received', repliedTo: 'any' })).toBe(false);
  });

  it('warns when no step of the automation sends a message', () => {
    const result = validateAutomation(
      document({ pause }, { stopWhen: [{ event: 'message.received', repliedTo: 'this_run' }] }),
      setup,
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual({
      path: '/stopWhen/0/repliedTo',
      code: 'stop_never_applies',
      message:
        'This stop applies to a reply to a message this workflow sent, and no step here sends one, so it never applies.',
    });
  });
});
