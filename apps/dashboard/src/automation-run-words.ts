// A run of an automation in plain words: where it stands, how it ended, and what a step
// produced. Kept free of the builder's own modules, so a record's page can say them without
// loading the builder. The engine's own explanation of each step ("why") is shown as it is;
// these are the words around it.
import { i18n } from '@lingui/core';
import { plural, t } from '@lingui/core/macro';
import { stopEventWords } from './automation-stop-words';

export const runStatuses = [
  'running',
  'waiting',
  'completed',
  'exited',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof runStatuses)[number];

/** What a run's status is called, the same in the filter, the list and the run itself. */
export function runStatusWords(status: string): string {
  switch (status) {
    case 'running':
      return t`Running`;
    case 'waiting':
      return t`Waiting`;
    case 'completed':
      return t`Finished`;
    case 'exited':
      return t`Stopped early`;
    case 'failed':
      return t`Failed`;
    case 'cancelled':
      return t`Cancelled`;
    default:
      return status;
  }
}

/**
 * What a step's status is called. The engine keeps a wait's row as it was written, so
 * `over` says the run has since gone on from it (or ended), and the wait reads as past.
 */
export function stepStatusWords(status: string, over = false): string {
  switch (status) {
    case 'succeeded':
      return t`Done`;
    case 'waiting':
      return over ? t`Waited` : t`Waiting`;
    case 'failed':
      return t`Failed`;
    case 'running':
      return t`Running`;
    case 'skipped':
      return t`Skipped`;
    default:
      return status;
  }
}

/** A moment as people read it, in the reader's own locale and time zone. */
export function momentWords(iso: string | null | undefined): string | undefined {
  if (iso === null || iso === undefined) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat(i18n.locale || undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}

// Why the engine failed a step, for the reasons a person can act on. Any other reason is
// shown as the engine names it, beside the step's own explanation.
const failures: Readonly<Record<string, () => string>> = {
  consent_required: () => t`the contact hasn't agreed to marketing messages on this channel`,
  consent_withdrawn: () => t`the contact withdrew their consent`,
  do_not_contact: () => t`the contact is marked do not contact`,
  suppressed: () => t`the address can't be sent to: it bounced, complained or unsubscribed`,
  timing_unknown: () => t`quiet hours apply and the contact's time zone isn't known`,
  missing_values: () => t`a merge field had no value for this contact`,
  mailbox_required: () => t`there was no mailbox to send from, or more than one to choose between`,
  mailbox_unavailable: () => t`the step's mailbox is gone, paused or not for conversations`,
  template_unavailable: () => t`the step's email template is gone or archived`,
  no_email_address: () => t`the contact has no email address`,
  no_phone_number: () => t`the contact has no phone number`,
  number_required: () => t`there was no number to send from, or more than one to choose between`,
  number_unavailable: () => t`the step's number can't send text messages now`,
  sms_unavailable: () => t`this install can't send text messages`,
  sms_body_too_long: () => t`the text message was too long once filled in`,
  not_implemented: () => t`the step isn't available yet`,
  missing_step: () => t`it led to a step the automation doesn't have`,
  no_open_deal: () => t`the contact has no open opportunity for this step`,
  several_open_deals: () => t`the contact has more than one open opportunity, so none was chosen`,
  step_visit_limit: () =>
    t`one action ran 100 times in this run, the most allowed: a path keeps leading back to it`,
  run_step_limit: () => t`the run took 5,000 actions, the most one run may take`,
};

/** The reasons that have words here, for a test to read each of them. */
export const explainedFailures: readonly string[] = Object.keys(failures);

/** Why a run failed, in words when the reason is a known one. */
export function failureWords(reason: string | null | undefined): string | undefined {
  if (reason === null || reason === undefined || reason === '') return undefined;
  return Object.hasOwn(failures, reason) ? failures[reason]?.() : reason;
}

// What "Start another automation" did, by the outcome the engine records for it.
const startOutcomes: Readonly<Record<string, () => string>> = {
  started: () => t`It started the other automation for this contact.`,
  already_running: () => t`It started nothing: the contact was already in the other automation.`,
  already_went_through: () =>
    t`It started nothing: the contact had been through the other automation, which takes a contact once.`,
  not_active: () => t`It started nothing: the other automation isn't published.`,
  refused_loop: () =>
    t`It started nothing: the automations would have gone on starting each other.`,
};

/** The outcomes that have words here, for a test to read each of them. */
export const explainedStartOutcomes: readonly string[] = Object.keys(startOutcomes);

/** How a run's reason begins when a "Remove from automations" step ended it. */
const REMOVED = 'removed:';

/** What made a run stop early: the stop condition that was met, as the builder words it. */
export function stopWords(reason: string | null | undefined): string | undefined {
  if (reason?.startsWith('stop:') !== true) return undefined;
  const event = reason.slice('stop:'.length);
  return stopEventWords(event, event === 'message.received' ? 'contact' : undefined) ?? event;
}

export interface RunFacts {
  readonly status: string;
  readonly currentStep: string | null;
  readonly exitReason: string | null;
  readonly wakeAt: string | null;
}

/** Where a run stands or how it ended, in a sentence. */
export function runOutcomeWords(
  run: RunFacts,
  stepName: (key: string) => string | undefined,
  /** The name of an automation of the business, by id, where the caller knows them. */
  automationName?: (id: string) => string | undefined,
): string {
  const reason = run.exitReason;
  switch (run.status) {
    case 'waiting': {
      const until = momentWords(run.wakeAt);
      return until === undefined ? t`Waiting.` : t`Waiting until ${until}.`;
    }
    case 'running': {
      const step = run.currentStep === null ? undefined : stepName(run.currentStep);
      return step === undefined ? t`Running.` : t`Running: next is ${step}.`;
    }
    case 'completed':
      return t`Went through to the end.`;
    case 'exited': {
      const stopped = stopWords(reason);
      if (reason?.startsWith(REMOVED) === true) {
        const remover = automationName?.(reason.slice(REMOVED.length));
        return remover === undefined
          ? t`Stopped early: a “Remove from automations” action took the contact out.`
          : t`Stopped early: a “Remove from automations” action in “${remover}” took the contact out.`;
      }
      return stopped === undefined
        ? reason === null
          ? t`Stopped early.`
          : t`Stopped early: ${reason}.`
        : t`Stopped early, because this happened: ${stopped}.`;
    }
    case 'failed': {
      const why = failureWords(reason);
      return why === undefined ? t`Failed.` : t`Failed: ${why}.`;
    }
    case 'cancelled':
      return t`Cancelled.`;
    default:
      return run.status;
  }
}

/** A value a step read or produced, as text. */
export function valueWords(value: unknown): string {
  if (value === null || value === undefined || value === '') return t`empty`;
  if (Array.isArray(value)) return value.length === 0 ? t`empty` : value.map(String).join(', ');
  if (typeof value === 'boolean') return value ? t`yes` : t`no`;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/**
 * What a step produced, for the kinds of result people ask about. The step's type says what
 * an opportunity it names is: one it found, one it changed, or one it made.
 */
export function outputWords(
  output: Readonly<Record<string, unknown>>,
  type?: string | null,
): string[] {
  const words: string[] = [];
  const wakeAt = typeof output['wakeAt'] === 'string' ? momentWords(output['wakeAt']) : undefined;
  const continued =
    typeof output['continuedAt'] === 'string' ? momentWords(output['continuedAt']) : undefined;
  // A wait a person ended early is over: when it would have ended is no longer what counts.
  if (continued !== undefined) words.push(t`A person ended its wait early, ${continued}.`);
  else if (wakeAt !== undefined) words.push(t`Its wait ends ${wakeAt}.`);
  if (typeof output['messageId'] === 'string') words.push(t`It queued a message to send.`);
  if (typeof output['taskId'] === 'string') words.push(t`It created a task.`);
  if (typeof output['dealId'] === 'string')
    words.push(
      type === 'deal.find'
        ? t`It found an opportunity.`
        : type === 'deal.update'
          ? t`It changed the opportunity.`
          : t`It created an opportunity.`,
    );
  if (typeof output['status'] === 'number') {
    const status = String(output['status']);
    words.push(t`The other app answered with status ${status}.`);
  }
  if (typeof output['variant'] === 'string') {
    const variant = output['variant'];
    words.push(t`It chose variant ${variant}.`);
  }
  const started = typeof output['outcome'] === 'string' ? output['outcome'] : '';
  if (Object.hasOwn(startOutcomes, started)) words.push(startOutcomes[started]?.() ?? started);
  const removed = output['removed'];
  if (typeof removed === 'number')
    words.push(
      plural(removed, {
        0: 'It ended no run: the contact was in none of those automations.',
        one: 'It ended # run of this contact.',
        other: 'It ended # runs of this contact.',
      }),
    );
  return words;
}
