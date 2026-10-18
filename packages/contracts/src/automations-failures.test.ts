// Failure handling: what a step does when it fails, bounded retries, what the run-ended
// trigger gives a notifier, and the endpoint that runs a failed run again. Shape and
// validation; the engine's side is tested in packages/modules/automation.
import { describe, expect, it } from 'vitest';

import {
  automationRetryableFailures,
  automationRetryableSteps,
  automationTriggerTypes,
  MAX_RUN_RETRIES,
  MAX_STEP_RETRIES,
} from './automations-catalog.js';
import { automationCatalog, automationDocument } from './automations.js';
import { retryAutomationRun } from './automations-api.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';

const setup: AutomationSetup = {
  fields: { contact: [], deal: [] },
  forms: [],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [],
  pipelines: [],
  lostReasons: [],
  tags: [{ id: 'tag_vip', name: 'VIP' }],
  users: [],
  automations: [],
  triggerLinks: [],
  values: [],
  channels: { email: true, sms: false, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const created = { id: 'created', type: 'contact.created', config: {} };
const pause = { type: 'wait', config: { duration: 'PT1M' } };
const tagging = (more: Record<string, unknown>) => ({
  type: 'tag.add',
  config: { tag: 'tag_vip' },
  ...more,
});
const document = (steps: Record<string, unknown>) => ({
  name: 'Failures',
  triggers: [created],
  start: Object.keys(steps)[0],
  steps,
});
const check = (steps: Record<string, unknown>) => validateAutomation(document(steps), setup);
const codes = (result: ReturnType<typeof validateAutomation>) =>
  result.errors.map((issue) => `${issue.path} ${issue.code}`);

describe('what a step does when it fails', () => {
  it('stops, goes on, or goes to a step named, and is kept as written', () => {
    for (const onFailure of ['stop', 'continue', { goTo: 'rescue' }]) {
      const result = check({ a: tagging({ onFailure, next: 'b' }), b: pause, rescue: pause });
      expect(result.errors.filter((issue) => issue.code !== 'unreachable_step')).toEqual([]);
      expect(result.document?.steps['a']?.onFailure ?? onFailure).toEqual(onFailure);
    }
    expect(
      automationDocument.safeParse(document({ a: tagging({ onFailure: 'ignore' }) })).success,
    ).toBe(false);
    expect(
      automationDocument.safeParse(document({ a: tagging({ onFailure: { goTo: 'Not A Key' } }) }))
        .success,
    ).toBe(false);
  });

  it('counts the step a failure leads to as reached', () => {
    const result = check({ a: tagging({ onFailure: { goTo: 'rescue' } }), rescue: pause });
    expect(result.errors).toEqual([]);
    expect(codes(check({ a: tagging({}), rescue: pause }))).toEqual([
      '/steps/rescue unreachable_step',
    ]);
  });

  it('refuses a failure path to a step that is not there, or to the step itself', () => {
    const unknown = check({ a: tagging({ onFailure: { goTo: 'rescue' } }) });
    expect(codes(unknown)).toEqual(['/steps/a/onFailure/goTo unknown_step']);
    expect(unknown.errors[0]?.message).toBe("There's no step rescue.");
    const itself = check({ a: tagging({ onFailure: { goTo: 'a' } }) });
    // It is also a loop that holds no wait, and is refused as one too.
    expect(codes(itself)).toEqual([
      '/steps/a/onFailure/goTo failure_path_to_itself',
      '/steps/a loop_without_wait',
    ]);
    expect(itself.errors[0]?.message).toBe('A step cannot go to itself when it fails.');
  });

  it('lets only a step with one next go on when it fails', () => {
    const branching = check({
      a: {
        type: 'wait.event',
        config: { event: 'message.received', timeout: 'P1D' },
        next: { received: 'b' },
        onFailure: 'continue',
      },
      b: pause,
    });
    expect(codes(branching)).toEqual(['/steps/a/onFailure on_failure_not_for_step']);
    expect(branching.errors[0]?.message).toBe(
      'This step has branches, so "continue" has no one next step to go on to. Name the step with goTo.',
    );
    const jump = check({
      a: { type: 'goto', config: { target: 'b' }, onFailure: 'continue' },
      b: pause,
    });
    expect(codes(jump)).toEqual(['/steps/a/onFailure on_failure_not_for_step']);
    // A failure path is allowed on both.
    expect(
      check({
        a: {
          type: 'wait.event',
          config: { event: 'message.received', timeout: 'P1D' },
          next: { received: 'b' },
          onFailure: { goTo: 'b' },
        },
        b: pause,
      }).errors,
    ).toEqual([]);
  });

  it('holds a loop through a failure path to the rule that a loop must wait', () => {
    const tight = check({
      a: tagging({ next: 'b', onFailure: { goTo: 'b' } }),
      b: tagging({ onFailure: { goTo: 'a' } }),
    });
    expect(tight.errors.map((issue) => issue.code)).toEqual(['loop_without_wait']);
    const waiting = check({
      a: tagging({ next: 'b' }),
      b: { type: 'wait', config: { duration: 'PT1H' }, next: 'c' },
      c: tagging({ onFailure: { goTo: 'a' } }),
    });
    expect(waiting.errors).toEqual([]);
    // A loop's wait lasts an hour at least each time round.
    const quick = check({
      a: tagging({ next: 'b' }),
      b: { ...pause, next: 'c' },
      c: tagging({ onFailure: { goTo: 'a' } }),
    });
    expect(quick.errors.map((issue) => issue.code)).toEqual(['loop_wait_too_short']);
  });
});

describe('retries', () => {
  it('takes one to five tries, a wait and a backoff', () => {
    expect(MAX_STEP_RETRIES).toBe(5);
    const retrying = (retry: unknown) => check({ a: tagging({ retry }) });
    expect(retrying({ times: 1 }).errors).toEqual([]);
    expect(retrying({ times: 5, wait: 'PT10M', backoff: 'fixed' }).errors).toEqual([]);
    expect(retrying({ times: 3, backoff: 'double' }).document?.steps['a']?.retry).toEqual({
      times: 3,
      backoff: 'double',
    });
    for (const retry of [{ times: 0 }, { times: 6 }, { times: 2, backoff: 'slow' }, {}])
      expect(automationDocument.safeParse(document({ a: tagging({ retry }) })).success).toBe(false);
  });

  it('refuses a wait between tries of more than a day', () => {
    expect(check({ a: tagging({ retry: { times: 2, wait: 'P1D' } }) }).errors).toEqual([]);
    const long = check({ a: tagging({ retry: { times: 2, wait: 'P2D' } }) });
    expect(codes(long)).toEqual(['/steps/a/retry/wait retry_wait_too_long']);
    expect(long.errors[0]?.message).toBe('A retry waits at most 24 hours.');
  });

  it('is for the steps whose failed attempt leaves nothing behind, and no other', () => {
    expect(automationRetryableSteps).toEqual([
      'email.send',
      'sms.send',
      'contact.update',
      'tag.add',
      'tag.remove',
      'owner.assign',
      'owner.remove',
      'deal.create',
      'deal.move',
      'deal.close',
      'deal.update',
      'task.create',
      'note.create',
      'dnd.set',
      'followers.add',
      'followers.remove',
    ]);
    expect(automationRetryableFailures).toEqual([
      'conflict',
      'mailbox_unavailable',
      'number_unavailable',
    ]);
    const waiting = check({ a: { ...pause, retry: { times: 2 } } });
    expect(codes(waiting)).toEqual(['/steps/a/retry retry_not_for_step']);
    expect(waiting.errors[0]?.message).toBe(
      'A wait step is not retried: only steps that change a record or queue a message are.',
    );
  });

  it('is published with the catalog, so an author knows what is retried', () => {
    expect(automationCatalog().failures).toEqual({
      maxRetries: 5,
      maxRunRetries: MAX_RUN_RETRIES,
      retryableSteps: automationRetryableSteps,
      retryableReasons: automationRetryableFailures,
    });
  });
});

describe('what a run that ended gives the automation it starts', () => {
  it('is the reason, the step it failed at and the run', () => {
    expect(automationTriggerTypes['automation.run_ended'].outputs.map((each) => each.key)).toEqual([
      'runId',
      'reason',
      'step',
    ]);
    const notifier = validateAutomation(
      {
        name: 'Tell the team',
        triggers: [
          {
            id: 'failed',
            type: 'automation.run_ended',
            config: { automations: ['aut_sales'], how: ['failed'] },
          },
        ],
        start: 'tell',
        steps: {
          tell: {
            type: 'team.notify',
            config: {
              message: 'A run failed at {{trigger.step}}: {{trigger.reason}}',
              to: 'owner_or_everyone',
            },
          },
        },
      },
      { ...setup, automations: [{ id: 'aut_sales', name: 'Sales', starts: [], startsAfter: [] }] },
    );
    expect(notifier.errors).toEqual([]);
  });
});

describe('running a failed run again', () => {
  it('is a command on the run, answering with the run', () => {
    expect(retryAutomationRun).toMatchObject({
      operationId: 'retryAutomationRun',
      method: 'post',
      path: '/automation-runs/{runId}/retry',
    });
    expect(retryAutomationRun.response.status).toBe(200);
    expect(MAX_RUN_RETRIES).toBe(5);
  });
});
