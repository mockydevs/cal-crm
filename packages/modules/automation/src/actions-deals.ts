// deal.create, deal.move, deal.close and deal.update, each through the CRM's own deal commands, so
// stage history, deal events and the CRM's checks apply as for a person. A deal belongs to
// a contact through the CRM's deal_contact link: deal.create writes the deal and its link
// together. The steps that change a deal act on the one the run has in hand
// (deal-in-hand.ts), and only without one on the contact's one open deal.
import { requireBusiness, type CommandContext } from '@repo/commands';
import {
  addDuration,
  createDealInput,
  parseInput,
  updateDealCommandInput,
  type ConditionValues,
  type Deal,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import {
  assignDealOwnerCommand,
  createDealCommand,
  linkDealContactCommand,
  readContactDeals,
  readDeal,
  readDealDetails,
  readRecordField,
  setRecordFieldCommand,
  updateDealCommand,
  type TaskOptions,
} from '@repo/module-crm';

import { localDate } from './contact-values.js';
import { keepDealInHand, readDealInHand } from './deal-in-hand.js';

import {
  amountFromField,
  arrivalSource,
  chooseDeal,
  createdDealSource,
  dealUpdate,
  type DealSourceSetting,
} from './actions-deal-choice.js';
import { runActionCommand } from './actions-command.js';

import { mergedText } from './actions-text.js';

/** The enrolled record a deal step acts for: a contact, or the deal itself. */
export interface DealSubject {
  readonly id: string;
  readonly kind: 'contact' | 'deal';
}

const refuse = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

/**
 * The source a step's setting gives a deal: its text with merge fields filled in, null for
 * "no source", or how the lead arrived. Nothing (undefined) when the step names none, or
 * asks for the arrival of a run that has none.
 */
function sourceOf(setting: DealSourceSetting, values: ConditionValues): string | null | undefined {
  if (setting === undefined || setting === null) return setting;
  return typeof setting === 'string'
    ? mergedText({ title: setting, notes: '' }, values).title
    : arrivalSource(values);
}

/**
 * Creates the step's deal and links it to the contact as the deal's primary contact, and
 * says what happened. The amount is the step's own, or what the contact's field named by
 * amountFrom holds as the step runs. The source is the step's own, or how the lead arrived.
 */
export async function createStepDeal(
  trx: DatabaseTransaction,
  command: CommandContext,
  input: {
    readonly contactId: string;
    /** The run, which takes the deal in hand. */
    readonly enrolmentId: string;
    readonly config: {
      readonly pipeline: string;
      readonly stage: string;
      readonly name?: string | undefined;
      readonly amount?: number | undefined;
      readonly amountFrom?: string | undefined;
      readonly source?: DealSourceSetting;
    };
    /** The version the step was saved at: a step from before the source setting has none. */
    readonly typeVersion?: number | undefined;
    readonly values: ConditionValues;
  },
): Promise<{ dealId: string; explanation: string }> {
  const { config, values } = input;
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('currency')
    .where('id', '=', requireBusiness(command.context))
    .executeTakeFirstOrThrow();
  const name =
    config.name === undefined
      ? // Named after the contact when the step gives no name. A contact always has a
        // name, an email address or a phone number, and the CRM refuses a deal without one.
        (values['contact.name'] ?? values['contact.email'] ?? values['contact.phone'])
      : mergedText({ title: config.name, notes: '' }, values).title;
  // Validation refuses a step that gives both; one stored before it did keeps its own amount.
  const fromField =
    config.amountFrom === undefined || config.amount !== undefined
      ? undefined
      : amountFromField(config.amountFrom, values[config.amountFrom]);
  const setting = createdDealSource(config.source, input.typeVersion);
  const source = sourceOf(setting, values);
  const deal = await runActionCommand(
    command,
    createDealCommand,
    parseInput(createDealInput, {
      name,
      ...(typeof source === 'string' ? { source } : {}),
      pipelineId: config.pipeline,
      stageId: config.stage,
      // The CRM takes amounts as decimal text, and refuses one it can't keep exactly.
      amount:
        fromField === undefined
          ? config.amount === undefined
            ? null
            : String(config.amount)
          : fromField.amount,
      currency: business.currency,
    }),
  );
  // In the action's savepoint with the deal: a refused link takes the deal back with it.
  await runActionCommand(command, linkDealContactCommand, {
    id: deal.id,
    contactId: toPublicId('contact', input.contactId),
    primary: true,
  });
  // The run has this deal in hand from here on: its later deal steps act on it.
  const dealUuid = parsePublicId('deal', deal.id);
  if (dealUuid !== undefined) await keepDealInHand(trx, input.enrolmentId, dealUuid);
  const done = 'The deal was created and linked to the contact.';
  const notes = [
    ...(fromField?.note === undefined ? [] : [fromField.note]),
    ...(typeof setting !== 'object' || setting === null
      ? []
      : [
          source === undefined
            ? 'Nothing is known of how the lead arrived, so the deal has no source.'
            : `Its source is "${String(source)}", from how the lead arrived.`,
        ]),
  ];
  return { dealId: deal.id, explanation: [done, ...notes].join(' ') };
}

/** The deal a step acts on, and whether the run had it in hand from a step of its own. */
interface Target {
  readonly deal: Deal;
  /** Words that name the deal in the step's explanation. */
  readonly called: string;
}

/**
 * The deal the step acts on: the one the run has in hand (deal-in-hand.ts), whatever its
 * pipeline, or, with none in hand, the contact's one open deal. A deal in hand that is in
 * the trash fails the step: acting on another deal instead would be a guess.
 */
async function targetDeal(
  trx: DatabaseTransaction,
  command: CommandContext,
  subject: DealSubject,
  enrolmentId: string,
  options: { readonly pipelineId?: string | undefined; readonly open: boolean },
): Promise<Target> {
  const inHand = await readDealInHand(trx, enrolmentId);
  if (inHand !== undefined) {
    // A deal that was purged is no longer in hand at all: the column is set null with it.
    const deal = await readDeal(trx, command, toPublicId('deal', inHand.id));
    if (deal.trashedAt !== null)
      throw refuse(
        '',
        'deal_unavailable',
        `The deal this run has in hand ("${deal.name}") is in the trash.`,
      );
    if (options.open && deal.status !== 'open')
      throw refuse('', 'deal_not_open', `The deal is already ${deal.status}.`);
    return {
      deal,
      called: inHand.from === 'step' ? `The deal in hand ("${deal.name}")` : 'The deal',
    };
  }
  const chosen = chooseDeal(
    // Two are enough to know there is more than one.
    await readContactDeals(trx, command, toPublicId('contact', subject.id), {
      status: 'open',
      ...(options.pipelineId === undefined ? {} : { pipelineId: options.pipelineId }),
      limit: 2,
    }),
    options.pipelineId,
  );
  if (!chosen.ok) throw refuse('', chosen.code, chosen.explanation);
  return { deal: chosen.deal, called: 'The deal' };
}

/** Moves the deal to the step's stage, and says what happened. */
export async function moveStepDeal(
  trx: DatabaseTransaction,
  command: CommandContext,
  subject: DealSubject,
  enrolmentId: string,
  config: { readonly stage: string; readonly pipeline?: string | undefined },
): Promise<string> {
  const stageId = parsePublicId('stage', config.stage);
  const stage =
    stageId === undefined
      ? undefined
      : await trx
          .selectFrom('crm.pipeline_stages')
          .select('pipeline_id')
          .where('business_id', '=', requireBusiness(command.context))
          .where('id', '=', stageId)
          .executeTakeFirst();
  if (stage === undefined)
    throw refuse('/config/stage', 'unavailable', "The step's stage is gone.");
  // The stage's own pipeline, unless the step names one; the CRM checks they agree.
  const pipelineId = config.pipeline ?? toPublicId('pipeline', stage.pipeline_id);
  // A deal in hand is the one meant, whichever pipeline it is in; only a deal looked for
  // among the contact's open ones is looked for in the step's pipeline.
  const { deal, called } = await targetDeal(trx, command, subject, enrolmentId, {
    pipelineId,
    open: true,
  });
  // Asking the CRM to save a deal unchanged would still say it was updated.
  if (deal.stageId === config.stage && deal.pipelineId === pipelineId)
    return `${called} was already in that stage.`;
  await runActionCommand(
    command,
    updateDealCommand,
    parseInput(updateDealCommandInput, dealUpdate(deal, { pipelineId, stageId: config.stage })),
  );
  return `${called} was moved to the stage.`;
}

/** Closes the deal as won, or as lost with the step's lost reason, and says what happened. */
export async function closeStepDeal(
  trx: DatabaseTransaction,
  command: CommandContext,
  subject: DealSubject,
  enrolmentId: string,
  config: { readonly outcome: 'won' } | { readonly outcome: 'lost'; readonly lostReason: string },
): Promise<string> {
  let outcomeReason: string | null = null;
  if (config.outcome === 'lost') {
    const reasonId = parsePublicId('lost_reason', config.lostReason);
    const reason =
      reasonId === undefined
        ? undefined
        : await trx
            .selectFrom('crm.lost_reasons')
            .select('label')
            .where('business_id', '=', requireBusiness(command.context))
            .where('id', '=', reasonId)
            .where('archived_at', 'is', null)
            .executeTakeFirst();
    if (reason === undefined)
      throw refuse(
        '/config/lostReason',
        'lost_reason_unavailable',
        "The step's lost reason is gone or archived.",
      );
    // The CRM keeps why a deal was lost as text, so the reason goes in by its label.
    outcomeReason = reason.label;
  }
  const { deal, called } = await targetDeal(trx, command, subject, enrolmentId, { open: true });
  await runActionCommand(
    command,
    updateDealCommand,
    parseInput(updateDealCommandInput, dealUpdate(deal, { status: config.outcome, outcomeReason })),
  );
  return `${called} was closed as ${config.outcome}.`;
}

/** What a deal.update step may change, as the validator leaves its settings. */
export interface DealChanges {
  readonly name?: string | undefined;
  readonly amount?: number | null | undefined;
  readonly amountFrom?: string | undefined;
  readonly owner?: string | null | undefined;
  readonly expectedCloseDate?: string | { readonly in: string } | null | undefined;
  readonly source?: DealSourceSetting;
  readonly status?: 'open' | undefined;
  readonly fields?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

/**
 * Changes the deal as the step says: its own values through the CRM's update command, with
 * the revision that makes the CRM refuse a deal changed in between; its owner and its
 * custom fields through theirs. Only what the step names is changed, and the step's
 * savepoint undoes all of it when any part is refused. Gives the deal and what was done.
 */
export async function updateStepDeal(
  trx: DatabaseTransaction,
  command: CommandContext,
  options: TaskOptions,
  input: {
    readonly subject: DealSubject;
    readonly enrolmentId: string;
    readonly config: DealChanges;
    readonly values: ConditionValues;
    readonly now: Date;
    readonly timeZone: string;
  },
): Promise<{ dealId: string; explanation: string }> {
  const { config, values } = input;
  const { deal, called } = await targetDeal(trx, command, input.subject, input.enrolmentId, {
    open: false,
  });
  const change: Parameters<typeof dealUpdate>[1] = {};
  const notes: string[] = [];
  if (config.name !== undefined)
    change.name = mergedText({ title: config.name, notes: '' }, values).title;
  if (config.amount !== undefined)
    change.amount = config.amount === null ? null : String(config.amount);
  else if (config.amountFrom !== undefined) {
    // As deal.create reads it; a field with nothing usable leaves the value as it is.
    const fromField = amountFromField(config.amountFrom, values[config.amountFrom]);
    if (fromField.amount === null)
      notes.push(
        (fromField.note ?? '').replace(
          'so the deal has no amount',
          "so the deal's value was left as it was",
        ),
      );
    else change.amount = fromField.amount;
  }
  if (config.expectedCloseDate !== undefined) {
    const given = config.expectedCloseDate;
    if (given === null || typeof given === 'string') change.expectedCloseDate = given;
    else {
      const due = addDuration(input.now, given.in);
      const day = due === undefined ? undefined : localDate(due, input.timeZone);
      if (day === undefined)
        throw refuse(
          '/config/expectedCloseDate',
          'invalid_date',
          `${given.in} from now is not a date.`,
        );
      change.expectedCloseDate = day;
    }
  }
  if (config.source !== undefined) {
    const source = sourceOf(config.source, values);
    // "From how they arrived" in a run nothing arrived with leaves the source as it is.
    if (source === undefined)
      notes.push(
        "Nothing is known of how the lead arrived, so the deal's source was left as it was.",
      );
    else change.source = source;
  }
  if (config.status === 'open' && deal.status !== 'open') {
    change.status = 'open';
    change.outcomeReason = null;
  } else if (config.status === 'open') notes.push('The deal was already open.');
  const next = dealUpdate(deal, change);
  const changed = (Object.keys(change) as (keyof typeof change)[]).some((key) =>
    key === 'amount'
      ? // Amounts are decimal text: 1500 and 1500.0000 are one amount.
        deal.amount === null || next.amount === null
        ? deal.amount !== next.amount
        : Number(deal.amount) !== Number(next.amount)
      : (deal[key] ?? null) !== (next[key] ?? null),
  );
  // Asking the CRM to save a deal unchanged would still say it was updated.
  if (changed)
    await runActionCommand(command, updateDealCommand, parseInput(updateDealCommandInput, next));
  let wrote = changed;
  if (config.owner !== undefined) {
    const details = await readDealDetails(trx, command, deal.id, options);
    await runActionCommand(command, assignDealOwnerCommand(options), {
      id: deal.id,
      owner: config.owner,
      revision: details.ownerRevision,
    });
    wrote = true;
  }
  for (const [path, value] of Object.entries(config.fields ?? {})) {
    const key = path.startsWith('deal.custom.') ? path.slice('deal.custom.'.length) : undefined;
    const field =
      key === undefined
        ? undefined
        : await trx
            .selectFrom('crm.field_definitions as field')
            .innerJoin('crm.object_types as type', 'type.id', 'field.object_type_id')
            .select('field.id')
            .where('type.kind', '=', 'deal')
            .where('field.key', '=', key)
            .executeTakeFirst();
    if (field === undefined)
      throw refuse(`/config/fields/${path}`, 'unknown_field', `${path} is not a field of a deal.`);
    const fieldId = toPublicId('field', field.id);
    // The CRM's own read gives the revision its write checks, so nothing is guessed.
    const current = await readRecordField(trx, command, deal.id, fieldId);
    await runActionCommand(command, setRecordFieldCommand, {
      id: deal.id,
      fieldId,
      // The CRM takes numbers as decimal text, so no precision is lost on the way.
      value: typeof value === 'number' ? String(value) : value,
      revision: current.revision,
    });
    wrote = true;
  }
  const said = wrote
    ? `${called} was updated.`
    : `${called} was left as it was: nothing the step names differs.`;
  return {
    dealId: deal.id,
    explanation: notes.length === 0 ? said : `${said} ${notes.join(' ')}`,
  };
}
