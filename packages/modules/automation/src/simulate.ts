// Test runs (AUTOMATIONS.md sections 5 and 7): the same step planning as real runs, with
// time fast-forwarded, simulated events such as "replies on day 1", and every side effect
// only described. A test run never sends, writes or charges anything.
import {
  addDuration,
  automationStepTypes,
  evaluateCondition,
  parseInput,
  updateContactInput,
  type AutomationDocument,
  type AutomationStep,
  type ConditionValues,
} from '@repo/contracts';
import { AppError, ValidationError } from '@repo/kernel';
import { normalizePhone, type FieldNormalizationContext } from '@repo/module-crm';
import { previewEmail, type EmailParts } from '@repo/module-messaging';

import { contactChanges } from './actions-contact.js';
import { turnOrder } from './actions-owner.js';
import {
  BUILT_IN_TARGETS,
  planFieldWrites,
  writesExplanation,
  type PlannedWrites,
} from './contact-values.js';
import { simulateRecordAction } from './simulate-actions.js';
import {
  isDealStep,
  simulateDealStep,
  type DealSimulation,
  type SimulatedDeal,
  type SimulatedDeals,
} from './simulate-deals.js';
import { NO_DEAL } from './values.js';
import { simulateCustomFields } from './simulate-fields.js';

import {
  failurePath,
  planSendingHold,
  planStep,
  UNAVAILABLE_STEPS,
  WINDOWED_STEPS,
  type StepPlan,
  type WaitedAppointment,
} from './steps.js';

export interface SimulatedEvent {
  /** An event a stop condition can listen for, such as message.received. */
  readonly event: string;
  /** How long after the start it happens, as an ISO 8601 duration. */
  readonly after: string;
}

export interface TraceStep {
  readonly step: string;
  readonly type: string;
  /** moved: a Go To, or a goal step, sent the run on without doing or deciding anything. */
  readonly kind: 'would_send' | 'would_change' | 'waited' | 'branched' | 'moved' | 'ended';
  readonly at: Date;
  readonly branch?: string;
  readonly explanation: string;
  /** Outputs exist only inside this dry run; these identifiers are never live record ids. */
  readonly simulated?: true;
  readonly output?: Readonly<Record<string, string>>;
  /** A Send email step: the email filled in for this run's contact, as a send would. */
  readonly email?: SimulatedEmailResult;
}

/** An email as a test run filled it in. */
export interface SimulatedEmailResult {
  readonly subject: string;
  /** The first line of the text that has words, cut at 200 characters. */
  readonly firstLine: string;
  /** The merge fields with no value: a real send stops on them (missing_values). */
  readonly missingValues: readonly string[];
}

export type TraceOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'stopped'; readonly event: string; readonly at: Date }
  | { readonly kind: 'failed'; readonly step: string; readonly error: string }
  | { readonly kind: 'limit'; readonly steps: number };

export interface Trace {
  readonly steps: readonly TraceStep[];
  readonly outcome: TraceOutcome;
}

/** An automation of the business, as a test run needs to know it. */
export interface SimulatedAutomation {
  readonly id: string;
  readonly name: string;
  /** Whether it is published and not paused: only then would a real run start it. */
  readonly active: boolean;
}

/** The most steps one test run takes, so a loop can't run on without end. */
export const MAX_SIMULATED_STEPS = 200;

const MESSAGE_GROUPS = new Set(['messages']);

export function simulateAutomation(input: {
  readonly document: AutomationDocument;
  readonly values: ConditionValues;
  readonly events: readonly SimulatedEvent[];
  readonly start: Date;
  readonly timeZone: string;
  readonly enrolmentId: string;
  /** Business tag metadata; omitted only for description-only sample runs. */
  readonly tags?: readonly { readonly id: string; readonly name: string }[];
  /** Tenant rules; omitted only for description-only sample runs. */
  readonly fields?: FieldNormalizationContext;
  /**
   * The business's automations, for the steps that start one or remove the contact from
   * some; omitted, such a step is described without naming what it would start.
   */
  readonly automations?: readonly SimulatedAutomation[];
  /** The id of the automation being tested, so a step that would end its own run ends it. */
  readonly automationId?: string;
  /**
   * The appointment a wait for one would wait for: the contact's next. Left out, or null,
   * such a wait finds none.
   */
  readonly appointment?: WaitedAppointment | null | undefined;
  /**
   * What the steps that give a contact an owner would find: whether the contact has one,
   * and whose turn it is at each step that shares contacts between members (the place kept
   * for the step, by its key). A test run reads them and moves no turn on.
   */
  /**
   * What the run's deal.find steps would find for the contact now, and the names of the
   * business's pipelines and stages. Left out for a sample with no contact.
   */
  readonly deals?: SimulatedDeals | undefined;
  readonly ownership?: {
    readonly hasOwner: boolean;
    readonly turns: Readonly<Record<string, number>>;
  };
  /**
   * The content each Send email step would send, by step key, read as a send reads it (its
   * template as it is now, or the step's own words); 'unavailable' for a template that is
   * gone or archived. A step left out is described without being filled in.
   */
  readonly emails?: Readonly<Record<string, EmailParts | 'unavailable'>>;
}): Trace {
  const { document, start } = input;
  const values: Record<string, ConditionValues[string]> = { ...input.values };
  const events = input.events
    .map((each) => ({ event: each.event, at: addDuration(start, each.after) ?? start }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  // The first simulated event in (from, to] that a stop condition ends the run on.
  const stopBetween = (from: Date, to: Date) =>
    events.find(
      (each) =>
        each.at > from &&
        each.at <= to &&
        document.stopWhen.some(
          (stop) =>
            stop.event === each.event &&
            !(stop.event === 'message.received' && stop.from === 'team') &&
            // A reply to the run's own messages: only once it has sent one. A simulated
            // message has no channel, so any message step counts.
            (!('repliedTo' in stop) || stop.repliedTo === undefined || wrote) &&
            (stop.if === undefined || evaluateCondition(stop.if, values, each.at)),
        ),
    );

  // The goal step and the event types that meet it. A run listens for them until it has
  // been through the step; a simulated event has no data, so the goal's filters (which
  // form, which tag) are not judged.
  const goalKey = Object.keys(document.steps).find((id) => document.steps[id]?.type === 'goal');
  const goalStep = goalKey === undefined ? undefined : document.steps[goalKey];
  const goalTypes: readonly string[] =
    goalStep?.type === 'goal' ? goalStep.config.events.map((each) => each.type) : [];
  let goalOpen = goalKey !== undefined;
  let goalMet: { eventId: string; eventType: string; from: string | null } | undefined;
  // Whether a message step has been reached, for a stop on a reply to the run's messages.
  let wrote = false;
  // Whether the contact has an owner at this point of the run, as far as a test run knows.
  let owned = input.ownership?.hasOwner ?? false;
  // The deal the run has in hand, as far as a test run knows it.
  let inHand: SimulatedDeal | undefined;
  // Turns this run's own steps would have used, on top of the places kept for them.
  const turnsUsed = new Map<string, number>();

  // What takes the run out of a wait in (from, to]: a stop condition, or the goal being
  // met. One event that is both stops the run, as stops are applied first in a real run.
  const leftBetween = (
    from: Date,
    to: Date,
  ):
    | { readonly kind: 'stopped'; readonly event: string; readonly at: Date }
    | { readonly kind: 'goal'; readonly event: string; readonly at: Date }
    | undefined => {
    const stopped = stopBetween(from, to);
    const met = goalOpen
      ? events.find((each) => each.at > from && each.at <= to && goalTypes.includes(each.event))
      : undefined;
    if (stopped !== undefined && (met === undefined || stopped.at <= met.at))
      return { kind: 'stopped', event: stopped.event, at: stopped.at };
    return met === undefined ? undefined : { kind: 'goal', event: met.event, at: met.at };
  };

  const steps: TraceStep[] = [];
  let key: string | null = document.start;
  let now = start;
  // What a failure does to the run: it ends it, unless the step says the run goes on, as
  // in a real run. Gives the trace when the run ends there; otherwise the run has moved.
  const failsAt = (at: string, error: string): Trace | undefined => {
    const failing = document.steps[at];
    const path = failing === undefined ? undefined : failurePath(failing);
    if (failing === undefined || path === undefined)
      return { steps, outcome: { kind: 'failed', step: at, error } };
    steps.push({
      step: at,
      type: failing.type,
      kind: path.branch === null ? 'moved' : 'branched',
      at: now,
      ...(path.branch === null ? {} : { branch: path.branch }),
      explanation: `Would fail here (${error}). ${path.words}`,
    });
    key = path.next;
    return undefined;
  };
  while (key !== null) {
    if (steps.length >= MAX_SIMULATED_STEPS)
      return { steps, outcome: { kind: 'limit', steps: steps.length } };
    const step: AutomationStep | undefined = document.steps[key];
    if (step === undefined)
      return { steps, outcome: { kind: 'failed', step: key, error: 'missing_step' } };
    const definition = automationStepTypes[step.type];
    const linear: string | null = typeof step.next === 'string' ? step.next : null;
    if (definition.group !== 'timing' && definition.group !== 'logic') {
      // A step the engine can't run fails a real run where it stands, so it fails this one.
      if (Object.hasOwn(UNAVAILABLE_STEPS, step.type)) {
        const ended = failsAt(key, 'not_implemented');
        if (ended !== undefined) return ended;
        continue;
      }
      // A message reached outside the sending window waits at its step until the window
      // opens, as a real run does, and a stop event in that wait ends the run.
      const window = document.settings.sendingWindow;
      const hold =
        window !== undefined && WINDOWED_STEPS.has(step.type)
          ? planSendingHold(window, now, input.timeZone)
          : undefined;
      if (hold?.kind === 'fail') {
        const ended = failsAt(key, hold.error);
        if (ended !== undefined) return ended;
        continue;
      }
      if (hold !== undefined) {
        steps.push({
          step: key,
          type: step.type,
          kind: 'waited',
          at: now,
          explanation: hold.explanation,
        });
        const left = leftBetween(now, hold.wakeAt);
        if (left?.kind === 'stopped') return { steps, outcome: left };
        if (left !== undefined && goalKey !== undefined) {
          goalMet = { eventId: `simulated:${left.event}`, eventType: left.event, from: key };
          now = left.at;
          key = goalKey;
          continue;
        }
        now = hold.wakeAt;
      }
      if (WINDOWED_STEPS.has(step.type)) wrote = true;
      // Built-in changes affect subsequent conditions in isolated dry-run state.
      // Reuse the real action mapper and contact input without running a command.
      if (step.type === 'contact.update') {
        let planned: PlannedWrites;
        try {
          // The same writes a real run would make, worked out from this run's own values.
          planned = planFieldWrites(step.config.fields, values, {
            now,
            timeZone: input.timeZone,
            target: (path) => {
              const definition = input.fields?.definitions.find(
                (field) => `contact.custom.${field.key}` === path,
              );
              return (
                BUILT_IN_TARGETS[path] ??
                (definition === undefined
                  ? // A sample run without the business's fields takes a field as text.
                    input.fields === undefined
                    ? { type: 'text', options: [] }
                    : undefined
                  : { type: definition.valueType, options: definition.options })
              );
            },
          });
          const builtIn = Object.fromEntries(
            Object.entries(planned.writes).flatMap(([path, value]) =>
              path.startsWith('contact.custom.')
                ? []
                : [
                    [
                      path,
                      typeof value === 'object' && value !== null ? value.join(', ') : value,
                    ] as const,
                  ],
            ),
          );
          const email = values['contact.email'];
          const phone = values['contact.phone'];
          const changes = contactChanges(builtIn, {
            emails: typeof email === 'string' ? [email] : [],
            phones: typeof phone === 'string' ? [phone] : [],
          });
          const parsed = parseInput(updateContactInput, changes);
          if (parsed.firstName !== undefined) values['contact.firstName'] = parsed.firstName;
          if (parsed.lastName !== undefined) values['contact.lastName'] = parsed.lastName;
          if (parsed.firstName !== undefined || parsed.lastName !== undefined) {
            const name = [values['contact.firstName'], values['contact.lastName']]
              .filter((part): part is string => typeof part === 'string')
              .join(' ')
              .trim();
            values['contact.name'] = name === '' ? null : name;
          }
          if (parsed.emails !== undefined) values['contact.email'] = parsed.emails[0];
          if (parsed.phones?.[0] !== undefined) {
            const primary = normalizePhone(parsed.phones[0], input.fields?.country);
            if (typeof primary !== 'string')
              throw new ValidationError([{ path: '/phones/0', ...primary }]);
            values['contact.phone'] = primary;
          }
          if (input.fields !== undefined)
            simulateCustomFields(planned.writes, values, input.fields);
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          const ended = failsAt(
            key,
            error instanceof ValidationError
              ? error.issues[0].code
              : error.name.replace(/Error$/, '').toLowerCase(),
          );
          if (ended !== undefined) return ended;
          continue;
        }
        steps.push({
          step: key,
          type: step.type,
          kind: 'would_change',
          at: now,
          explanation: writesExplanation(
            planned,
            'Would update contact; nothing is sent or changed in a test run.',
            'Would change no field.',
          ),
        });
        key = linear;
        continue;
      }
      if ((step.type === 'tag.add' || step.type === 'tag.remove') && input.tags !== undefined) {
        const given = step.config.tag;
        const byId = input.tags.find((tag) => tag.id === given);
        const candidates =
          byId === undefined
            ? input.tags.filter(
                (tag) => tag.name.trim().toLowerCase() === given.trim().toLowerCase(),
              )
            : [byId];
        const tag = candidates[0];
        if (tag === undefined || candidates.length !== 1) {
          const ended = failsAt(
            key,
            candidates.length > 1 ? 'ambiguous_reference' : 'unknown_reference',
          );
          if (ended !== undefined) return ended;
          continue;
        }
        const current = values['contact.tags'];
        const tags = typeof current === 'object' && current !== null ? current : [];
        values['contact.tags'] =
          step.type === 'tag.add'
            ? [...new Set([...tags, tag.name])]
            : tags.filter((name) => name !== tag.name);
      }
      // Giving the contact an owner: who would be next in turn, and no turn is used.
      if (step.type === 'owner.assign') {
        const config = step.config;
        let explanation: string;
        let output: Readonly<Record<string, string>> | undefined;
        if (config.onlyIfUnassigned === true && owned)
          explanation =
            'Would leave the owner in place: the contact already has one, and this step is set to keep it.';
        else if ('user' in config) {
          output = { membershipId: config.user };
          explanation = "Would make the step's team member the contact's owner.";
        } else {
          const used = turnsUsed.get(key) ?? 0;
          const order = turnOrder(config.users, (input.ownership?.turns[key] ?? 0) + used);
          const next = order[0] ?? '';
          turnsUsed.set(key, used + 1);
          output = { membershipId: next };
          explanation = `Would make the next team member in turn the contact's owner: number ${String(config.users.indexOf(next) + 1)} of ${String(config.users.length)}. Who is still on the team is read when the step really runs.`;
        }
        if (output !== undefined) {
          owned = true;
          values[`steps.${key}.membershipId`] = output['membershipId'];
        }
        steps.push({
          step: key,
          type: step.type,
          kind: 'would_change',
          at: now,
          explanation: `${explanation} Nothing is changed in a test run, and no turn is used.`,
          ...(output === undefined ? {} : { simulated: true as const, output }),
        });
        key = linear;
        continue;
      }
      if (step.type === 'owner.remove') owned = false;
      // Finding, creating and changing a deal: which deal each step would act on, and the
      // deal in hand kept in this run's own values for the steps after.
      if (isDealStep(step)) {
        let done: DealSimulation;
        try {
          done = simulateDealStep(step, key, values, inHand, input.deals, steps.length + 1);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          const ended = failsAt(key, error.issues[0].code);
          if (ended !== undefined) return ended;
          continue;
        }
        if (done.inHand !== undefined) {
          inHand = done.inHand;
          Object.assign(values, NO_DEAL, inHand.values);
        }
        for (const [field, value] of Object.entries(done.output ?? {}))
          values[`steps.${key}.${field}`] = value;
        const next: unknown = step.next;
        const target: unknown =
          done.branch !== undefined && typeof next === 'object' && next !== null
            ? (next as Readonly<Record<string, unknown>>)[done.branch]
            : undefined;
        steps.push({
          step: key,
          type: step.type,
          kind: done.branch === undefined ? 'would_change' : 'branched',
          at: now,
          ...(done.branch === undefined ? {} : { branch: done.branch }),
          explanation: done.explanation,
          ...(done.output === undefined ? {} : { simulated: true as const, output: done.output }),
        });
        key = done.branch === undefined ? linear : typeof target === 'string' ? target : null;
        continue;
      }
      // Starting another automation: what a real run would come to, as far as it can be
      // known here. Whether the contact is already in it is known only when it really runs.
      if (step.type === 'automation.run' && input.automations !== undefined) {
        const given = step.config.automation;
        const target = input.automations.find((each) => each.id === given);
        if (target === undefined) {
          const ended = failsAt(key, 'unknown_reference');
          if (ended !== undefined) return ended;
          continue;
        }
        const outcome =
          target.id === input.automationId
            ? 'refused_loop'
            : target.active
              ? 'started'
              : 'not_active';
        values[`steps.${key}.outcome`] = outcome;
        steps.push({
          step: key,
          type: step.type,
          kind: 'would_change',
          at: now,
          explanation:
            outcome === 'started'
              ? `Would start "${target.name}"; nothing is started in a test run.`
              : outcome === 'not_active'
                ? `Would start nothing: "${target.name}" is not active.`
                : `Would start nothing: "${target.name}" is this automation, and one never starts itself.`,
          simulated: true,
          output: { outcome },
        });
        key = linear;
        continue;
      }
      // Removing the contact from automations ends nothing here; when the removal takes in
      // this automation's own run, the run ends at the step, as a real one does.
      if (step.type === 'automation.remove') {
        const config = step.config;
        const own = input.automationId;
        const endsOwn =
          config.from === 'current' ||
          (config.from === 'all' && (own === undefined || !(config.except ?? []).includes(own))) ||
          (config.from === 'automations' && own !== undefined && config.automations.includes(own));
        const names = (ids: readonly string[]) =>
          ids
            .map((id) => input.automations?.find((each) => each.id === id)?.name ?? id)
            .map((name) => `"${name}"`)
            .join(', ');
        const except =
          'except' in config && config.except !== undefined && config.except.length > 0
            ? `, except ${names(config.except)}`
            : '';
        const from =
          config.from === 'current'
            ? 'this automation'
            : config.from === 'automations'
              ? names(config.automations)
              : config.from === 'all_others'
                ? `every other automation${except}`
                : `every automation${except}`;
        steps.push({
          step: key,
          type: step.type,
          kind: endsOwn ? 'ended' : 'would_change',
          at: now,
          explanation: `Would remove the contact from ${from}; no run is ended in a test run.${endsOwn ? ' A real run would end here.' : ''}`,
        });
        if (endsOwn) return { steps, outcome: { kind: 'completed' } };
        key = linear;
        continue;
      }
      const email = step.type === 'email.send' ? input.emails?.[key] : undefined;
      if (email === 'unavailable') {
        const ended = failsAt(key, 'template_unavailable');
        if (ended !== undefined) return ended;
        continue;
      }
      if (email !== undefined) {
        const filled = fillEmail(email, values);
        if (filled.missingValues.length > 0) {
          // A real send stops here, before anything is queued (actions-email.ts).
          const words = `The contact has no value for ${filled.missingValues.join(', ')}, so a real send would stop here (missing_values) and nothing would be sent.`;
          if (failurePath(step) === undefined) {
            steps.push({
              step: key,
              type: step.type,
              kind: 'ended',
              at: now,
              explanation: words,
              email: filled,
            });
            return { steps, outcome: { kind: 'failed', step: key, error: 'missing_values' } };
          }
          const ended = failsAt(key, 'missing_values');
          if (ended !== undefined) return ended;
          const last = steps.at(-1);
          if (last !== undefined)
            steps[steps.length - 1] = {
              ...last,
              explanation: `${words} ${last.explanation}`,
              email: filled,
            };
          continue;
        }
        steps.push({
          step: key,
          type: step.type,
          kind: 'would_send',
          at: now,
          explanation: `Would send the email "${filled.subject}"; nothing is sent in a test run.`,
          email: filled,
        });
        key = linear;
        continue;
      }
      let output: Readonly<Record<string, string>> | undefined;
      try {
        output = simulateRecordAction(step, key, values, now, steps.length + 1);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        {
          const ended = failsAt(key, error.issues[0].code);
          if (ended !== undefined) return ended;
          continue;
        }
      }
      if (output !== undefined)
        for (const [field, value] of Object.entries(output))
          values[`steps.${key}.${field}`] = value;
      // An action: described, never persisted.
      steps.push({
        step: key,
        type: step.type,
        kind: MESSAGE_GROUPS.has(definition.group) ? 'would_send' : 'would_change',
        at: now,
        explanation: `Would ${definition.label.toLowerCase()}; nothing is sent or changed in a test run.`,
        ...(output === undefined ? {} : { simulated: true as const, output }),
      });
      key = linear;
      continue;
    }
    if (step.type === 'goal') {
      const reached = planStep({
        key,
        step,
        values,
        now,
        timeZone: input.timeZone,
        enrolmentId: input.enrolmentId,
        goal: { ...(goalMet === undefined ? {} : { met: goalMet }), passed: !goalOpen },
      });
      goalMet = undefined;
      if (reached.kind === 'fail') {
        const ended = failsAt(key, reached.error);
        if (ended !== undefined) return ended;
        continue;
      }
      let plan: StepPlan = reached;
      if (reached.kind === 'arm') {
        // Set to wait: the first goal event before the year is out lets it go on.
        steps.push({
          step: key,
          type: step.type,
          kind: 'waited',
          at: now,
          explanation: reached.explanation,
        });
        const left = leftBetween(now, reached.wakeAt);
        if (left?.kind === 'stopped') return { steps, outcome: left };
        now = left?.at ?? reached.wakeAt;
        plan = planStep({
          key,
          step,
          values,
          now,
          timeZone: input.timeZone,
          enrolmentId: input.enrolmentId,
          armed: { receivedEventId: left === undefined ? null : `simulated:${left.event}` },
        });
      }
      goalOpen = false;
      if (plan.kind !== 'next')
        return { steps, outcome: { kind: 'failed', step: key, error: 'invalid_wait' } };
      const eventId = plan.output['eventId'];
      steps.push({
        step: key,
        type: step.type,
        // The run ends at the step only when the step ends it: one with nothing after it
        // that let the run through has still moved it on.
        kind: plan.next === null && linear !== null ? 'ended' : 'moved',
        at: now,
        explanation: plan.explanation,
        ...(typeof eventId === 'string' ? { simulated: true as const, output: { eventId } } : {}),
      });
      key = plan.next;
      continue;
    }
    let plan = planStep({
      key,
      step,
      values,
      now,
      timeZone: input.timeZone,
      enrolmentId: input.enrolmentId,
      appointment: input.appointment,
    });
    if (plan.kind === 'fail') {
      const ended = failsAt(key, plan.error);
      if (ended !== undefined) return ended;
      continue;
    }
    if (plan.kind === 'arm') {
      // A wait that stays at its step. wait.event: the first simulated event of its kind
      // before the timeout wakes it. A wait for a condition or an appointment wakes at its
      // time: a test run changes no record during a wait. Woken, the step is planned again,
      // and may go on waiting, as when its resume window is closed.
      let woken: StepPlan = plan;
      let jumped = false;
      while (woken.kind === 'arm') {
        if (steps.length >= MAX_SIMULATED_STEPS)
          return { steps, outcome: { kind: 'limit', steps: steps.length } };
        const from = now;
        const { wakeAt, event: awaited, carry } = woken;
        const arrived =
          awaited === null
            ? undefined
            : events.find((each) => each.event === awaited && each.at > from && each.at <= wakeAt);
        steps.push({
          step: key,
          type: step.type,
          kind: 'waited',
          at: now,
          explanation: woken.explanation,
        });
        const left = leftBetween(from, arrived?.at ?? wakeAt);
        if (left?.kind === 'stopped') return { steps, outcome: left };
        if (left !== undefined && goalKey !== undefined) {
          goalMet = { eventId: `simulated:${left.event}`, eventType: left.event, from: key };
          now = left.at;
          jumped = true;
          break;
        }
        now = arrived?.at ?? wakeAt;
        woken = planStep({
          key,
          step,
          values,
          now,
          timeZone: input.timeZone,
          enrolmentId: input.enrolmentId,
          appointment: input.appointment,
          armed: {
            receivedEventId: arrived === undefined ? null : `simulated:${arrived.event}`,
            carry,
          },
        });
      }
      if (jumped && goalKey !== undefined) {
        key = goalKey;
        continue;
      }
      if (woken.kind === 'fail') {
        const ended = failsAt(key, woken.error);
        if (ended !== undefined) return ended;
        continue;
      }
      // A wait until a date field has no branches: woken at its date it goes on, or sleeps
      // on to its resume window as any wait does.
      if (step.type === 'wait.until' && woken.kind === 'next') {
        // As a real run, which writes the wait's end as a row of its own.
        steps.push({
          step: key,
          type: step.type,
          kind: 'waited',
          at: now,
          explanation: woken.explanation,
        });
        key = woken.next;
        continue;
      }
      if (step.type === 'wait.until' && woken.kind === 'wait') plan = woken;
      else if (woken.kind !== 'next' || woken.branch === null)
        return { steps, outcome: { kind: 'failed', step: key, error: 'invalid_wait' } };
      else {
        steps.push({
          step: key,
          type: step.type,
          kind: 'branched',
          at: now,
          branch: woken.branch,
          explanation: woken.explanation,
        });
        key = woken.next;
        continue;
      }
    }
    if (plan.kind === 'wait') {
      steps.push({
        step: key,
        type: step.type,
        kind: 'waited',
        at: now,
        explanation: plan.explanation,
      });
      const left = leftBetween(now, plan.wakeAt);
      if (left?.kind === 'stopped') return { steps, outcome: left };
      if (left !== undefined && goalKey !== undefined) {
        goalMet = { eventId: `simulated:${left.event}`, eventType: left.event, from: key };
        now = left.at;
        key = goalKey;
        continue;
      }
      now = plan.wakeAt;
      key = plan.next;
      continue;
    }
    steps.push({
      step: key,
      type: step.type,
      kind:
        plan.branch === null
          ? definition.group === 'timing'
            ? 'waited'
            : step.type === 'goto'
              ? 'moved'
              : 'ended'
          : 'branched',
      at: now,
      ...(plan.branch === null ? {} : { branch: plan.branch }),
      explanation: plan.explanation,
    });
    key = plan.next;
  }
  return { steps, outcome: { kind: 'completed' } };
}

/**
 * An email filled in from a test run's values, as a send fills it in: the same merge fields,
 * and a field with no value listed, where a send stops. A field the run wrote earlier is
 * under its merge key too (contact.<key>), as simulate-fields.ts keeps it.
 */
export function fillEmail(parts: EmailParts, values: ConditionValues): SimulatedEmailResult {
  const preview = previewEmail({
    parts,
    values,
    publicUrl: undefined,
    addressLine: null,
    footer: true,
  });
  const line = preview.text.split(/\r?\n/).find((each) => each.trim() !== '') ?? '';
  return {
    subject: preview.subject,
    firstLine: line.trim().slice(0, 200),
    missingValues: preview.missingFields,
  };
}
