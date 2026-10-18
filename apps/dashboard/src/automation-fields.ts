// The settings of each step and trigger type, as the Steps view's forms show them. A simple
// setting gets a control: text, a number, a length of time, a choice, or one of this
// business's own things (a tag, a template). A setting too involved for a form here, such as
// a nested condition, is shown as it reads and edited in the JSON view, rather than through
// a form that could only hold part of it.
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  automationStepTypes,
  automationStopEvents,
  arrivalSessionSources,
  automationTriggerTypes,
  MAX_REMOVE_AUTOMATIONS,
  MAX_RUN_ENDED_AUTOMATIONS,
  type AutomationSetup,
  type AutomationStepType,
  type AutomationTriggerType,
} from '@repo/contracts';
import { arrivalSettings, choiceNames, createdSourceWords } from './automation-attribution-words';
import { isRecord } from './automation-document';
import {
  conditionWords,
  durationWords,
  listed,
  nameIn,
  namesIn,
  stepSummary,
} from './automation-summary';

type Config = Readonly<Record<string, unknown>>;

export type ReferenceList =
  | 'forms'
  | 'emailTemplates'
  | 'whatsappTemplates'
  | 'mailboxes'
  | 'phoneNumbers'
  | 'calendars'
  | 'pipelines'
  | 'stages'
  | 'lostReasons'
  | 'tags'
  | 'users'
  | 'automations'
  | 'triggerLinks';

export interface ChoiceOption {
  readonly value: string;
  readonly label: MessageDescriptor;
}

export type FieldInput =
  | { readonly kind: 'contact_fields' }
  | { readonly kind: 'text'; readonly placeholder?: string }
  | { readonly kind: 'long_text' }
  | { readonly kind: 'number' }
  | { readonly kind: 'duration' }
  /** The weekdays and hours a wait may go on in (automation-resume-window.tsx). */
  | { readonly kind: 'resume_window' }
  | {
      readonly kind: 'choice';
      readonly options: readonly ChoiceOption[];
      /**
       * Shown as a list to pick one from, each with its sentence (automation-choice-details.ts),
       * rather than a menu.
       */
      readonly radios?: true;
    }
  /** An If / else's own branches, or the way to give it some (automation-flow-fields.tsx). */
  | { readonly kind: 'branches' }
  /** Another step of this automation, by what its card says. */
  | { readonly kind: 'step' }
  /** The events that meet a goal, each with its trigger's filters. */
  | { readonly kind: 'goal_events' }
  /** Any number of a few choices, each with its sentence; none ticked leaves it out. */
  | { readonly kind: 'choices'; readonly options: readonly ChoiceOption[] }
  | { readonly kind: 'reference'; readonly list: ReferenceList }
  /**
   * One of the business's other automations, or several of them (automation-targets.ts);
   * with `own`, the automation being edited is one that can be chosen too.
   */
  | { readonly kind: 'automations'; readonly many: boolean; readonly own?: true }
  /**
   * Who becomes the owner: one team member, or several in turn; with `followers`, the team
   * members an Add or Remove Contact Followers step names (automation-record-fields.tsx).
   */
  | { readonly kind: 'members'; readonly followers?: 'add' | 'remove' }
  /** Which of the contact's opportunities to find, as filter rows. */
  | { readonly kind: 'deal_filters' }
  /** What to change on the opportunity, as rows. */
  | { readonly kind: 'deal_changes' }
  /** The lead sources a trigger starts for: the built-in names to tick, and any other. */
  | { readonly kind: 'lead_sources' }
  /** Where a new opportunity's source comes from: the arrival, text, or none. */
  | { readonly kind: 'deal_source' }
  /** Shown as it reads, and edited in the JSON view. */
  | { readonly kind: 'json' };

export interface FieldSpec {
  readonly key: string;
  readonly label: MessageDescriptor;
  readonly hint?: MessageDescriptor;
  readonly required: boolean;
  /**
   * What leaving an optional choice empty means, such as "Any channel". An optional choice
   * without one shows its first option, which is what the contract defaults to.
   */
  readonly unset?: MessageDescriptor;
  readonly input: FieldInput;
  /** The config members this stands for, when it's more than its own key. */
  readonly covers?: readonly string[];
  /** A required setting that is filled in once any of these members holds something. */
  readonly anyOf?: readonly string[];
  /** Text that takes merge fields: its form offers a list that inserts one. */
  readonly merge?: true;
  /** Shown only for settings it applies to, such as a lost reason for a lost deal. */
  readonly when?: (config: Config) => boolean;
  /** What a new step starts with, for a setting that must hold something valid. */
  readonly starter?: unknown;
}

// Braces are message syntax to the catalogs, so the example goes in as a value.
const MERGE_FIELD = '{{contact.firstName}}';
const mergeHint = msg`You can use merge fields, such as ${MERGE_FIELD}.`;

const required = true;
const optional = false;

const text = (
  key: string,
  label: MessageDescriptor,
  isRequired: boolean,
  more: Partial<FieldSpec> & { readonly placeholder?: string } = {},
): FieldSpec => {
  const { placeholder, ...rest } = more;
  return {
    key,
    label,
    required: isRequired,
    input: placeholder === undefined ? { kind: 'text' } : { kind: 'text', placeholder },
    ...rest,
    ...(rest.hint !== undefined && rest.hint === mergeHint ? { merge: true as const } : {}),
  };
};
const longText = (
  key: string,
  label: MessageDescriptor,
  isRequired: boolean,
  hint?: MessageDescriptor,
): FieldSpec => ({
  key,
  label,
  required: isRequired,
  input: { kind: 'long_text' },
  ...(hint === undefined ? {} : { hint }),
  ...(hint !== undefined && hint === mergeHint ? { merge: true as const } : {}),
});
const duration = (
  key: string,
  label: MessageDescriptor,
  isRequired: boolean,
  starter?: string,
): FieldSpec => ({
  key,
  label,
  required: isRequired,
  input: { kind: 'duration' },
  ...(starter === undefined ? {} : { starter }),
});
const reference = (
  key: string,
  label: MessageDescriptor,
  list: ReferenceList,
  isRequired: boolean,
  more: Partial<FieldSpec> = {},
): FieldSpec => ({ key, label, required: isRequired, input: { kind: 'reference', list }, ...more });
const choice = (
  key: string,
  label: MessageDescriptor,
  options: readonly ChoiceOption[],
  isRequired: boolean,
  more: Partial<FieldSpec> = {},
): FieldSpec => ({ key, label, required: isRequired, input: { kind: 'choice', options }, ...more });
const json = (
  key: string,
  label: MessageDescriptor,
  isRequired: boolean,
  more: Partial<FieldSpec> = {},
): FieldSpec => ({ key, label, required: isRequired, input: { kind: 'json' }, ...more });

/**
 * Whether a message is marketing (left out) or transactional: about the appointment the
 * contact booked, such as a reminder. Only an appointment-triggered workflow may send one.
 */
const purposeField: FieldSpec = choice(
  'purpose',
  msg`Message type`,
  [
    { value: 'marketing', label: msg`Marketing` },
    { value: 'transactional', label: msg`Transactional: about the appointment they booked` },
  ],
  optional,
  {
    unset: msg`Marketing`,
    hint: msg`Transactional messages go to people who agreed to booking notifications, without the marketing footer. Only a workflow that starts from an appointment can send them.`,
  },
);

/** When a run may go on from a wait: weekdays and hours. */
const resumeWindowField: FieldSpec = {
  key: 'resumeWindow',
  label: msg`Only go on during`,
  required: optional,
  input: { kind: 'resume_window' },
  hint: msg`The weekdays and hours when the run may go on from this wait. Outside them it goes on when the window next opens.`,
};

const runEndedLimitHint = msg`Choose 1 to ${MAX_RUN_ENDED_AUTOMATIONS}. This automation can't be one of them.`;
const removeLimitHint = msg`Choose 1 to ${MAX_REMOVE_AUTOMATIONS}.`;
const exceptLimitHint = msg`The contact stays in these. Up to ${MAX_REMOVE_AUTOMATIONS}.`;

const eventNames: Readonly<Record<(typeof automationStopEvents)[number], MessageDescriptor>> = {
  'message.received': msg`A message arrives`,
  'form.submitted': msg`A form is submitted`,
  'appointment.booked': msg`An appointment is booked`,
  'appointment.status_changed': msg`An appointment's status changes`,
  'deal.stage_changed': msg`An opportunity moves stage`,
  'deal.closed': msg`An opportunity is won or lost`,
  'field.changed': msg`A field changes`,
  'tag.added': msg`A tag is added`,
};

// The filters of a trigger whose event comes with a touch: a form, a booking.
/** Do not disturb's two directions, and the outbound channels by GoHighLevel's names. */
const dndDirections: readonly ChoiceOption[] = [
  { value: 'outbound', label: msg`Outbound` },
  { value: 'inbound', label: msg`Inbound` },
];
const dndChannelChoices: readonly ChoiceOption[] = [
  { value: 'email', label: msg`Email` },
  { value: 'sms', label: msg`Text messages` },
  { value: 'call', label: msg`Calls & Voicemails` },
  { value: 'webchat', label: msg`Web chat` },
];
/** Inbound do not disturb is one setting, with no channel to choose. */
const outbound = (config: Config): boolean => config['direction'] !== 'inbound';

const arrivalFilters: readonly FieldSpec[] = [
  {
    key: 'sources',
    label: arrivalSettings.sources,
    required: optional,
    input: { kind: 'lead_sources' },
    hint: arrivalSettings.sourcesHint,
  },
  {
    key: 'sessionSources',
    label: arrivalSettings.sessionSources,
    required: optional,
    hint: arrivalSettings.sessionSourcesHint,
    input: {
      kind: 'choices',
      options: arrivalSessionSources.map((value) => ({
        value,
        label: choiceNames[value] ?? { id: value, message: value },
      })),
    },
  },
];

const dateFields = (starter: boolean): FieldSpec[] => [
  text('field', msg`Date field`, required, {
    placeholder: 'contact.createdAt',
    hint: msg`A date field by its path, such as contact.createdAt.`,
    ...(starter ? { starter: 'contact.createdAt' } : {}),
  }),
  duration('offset', msg`How long before or after`, optional),
  choice(
    'direction',
    msg`Before or after the date`,
    [
      { value: 'before', label: msg`Before` },
      { value: 'after', label: msg`After` },
    ],
    optional,
  ),
  text('time', msg`Time of day`, optional, {
    placeholder: '09:00',
    hint: msg`A 24-hour time, such as 09:30.`,
  }),
];

/** What a Find opportunity step can filter on, and what an Update opportunity step can change. */
export const DEAL_FILTER_KEYS = [
  'pipeline',
  'stage',
  'status',
  'nameContains',
  'value',
  'customField',
] as const;
export const DEAL_CHANGE_KEYS = [
  'name',
  'amount',
  'amountFrom',
  'owner',
  'expectedCloseDate',
  'source',
  'status',
  'fields',
] as const;

export const stepFields: Readonly<Record<AutomationStepType, readonly FieldSpec[]>> = {
  // One panel draws all of these (src/email-step/panel.tsx): the email is written in four
  // ways that share who it is from. They are listed one by one all the same, so that what
  // is missing, and what a new version changes, is said of each by its own name.
  'email.send': [
    reference('template', msg`Email template`, 'emailTemplates', required, {
      when: (config) => typeof config['template'] === 'string',
    }),
    text('subject', msg`Subject`, required, {
      // A step that sends a template, or syncs with one, may leave the subject to it.
      anyOf: ['subject', 'template', 'source'],
      when: (config) => config['template'] !== '',
    }),
    {
      ...longText('body', msg`Message`, required),
      // The formatted part goes with the plain-text one.
      covers: ['body', 'html'],
      when: (config) => typeof config['template'] !== 'string' && config['mode'] !== 'sync',
    },
    // Whether the content is a copy or syncs, and the template it came from.
    json('source', msg`Email template`, optional, { covers: ['mode', 'source'] }),
    reference('mailbox', msg`Send from`, 'mailboxes', optional),
    text('fromName', msg`From name`, optional),
    text('replyTo', msg`Reply-To`, optional),
    json('cc', msg`Cc`, optional),
    json('bcc', msg`Bcc`, optional),
    text('preheader', msg`Preview text`, optional),
    json('attachments', msg`Attachments`, optional),
    purposeField,
  ],
  'sms.send': [
    longText('message', msg`Message`, required, mergeHint),
    reference('number', msg`Send from`, 'phoneNumbers', optional),
    purposeField,
  ],
  'whatsapp.send': [reference('template', msg`WhatsApp template`, 'whatsappTemplates', required)],
  'manual.call': [
    longText('notes', msg`What to say or ask`, optional, mergeHint),
    reference('user', msg`Who places the call`, 'users', optional, {
      unset: msg`The contact's owner`,
    }),
  ],
  'manual.sms': [
    longText('message', msg`Message`, required, mergeHint),
    reference('user', msg`Who sends it`, 'users', optional, { unset: msg`The contact's owner` }),
  ],
  'team.notify': [
    longText('message', msg`Message`, required, mergeHint),
    choice(
      'to',
      msg`Who to tell`,
      [
        { value: 'contact_owner', label: msg`The contact's owner` },
        { value: 'everyone', label: msg`Everyone on the team` },
        {
          value: 'owner_or_everyone',
          label: msg`The contact's owner, or everyone when there is none`,
        },
      ],
      optional,
      {
        hint: msg`With "The contact's owner" alone, nobody is told about a contact that has no owner.`,
      },
    ),
  ],
  wait: [duration('duration', msg`How long to wait`, required, 'P1D'), resumeWindowField],
  'wait.until': [
    json('field', msg`When to wait until`, required, {
      covers: ['field', 'offset', 'direction', 'time', 'at'],
      starter: 'contact.createdAt',
    }),
    choice(
      'ifPassed',
      msg`If that time has already passed`,
      [
        { value: 'continue', label: msg`Go on at once` },
        { value: 'end', label: msg`End the run` },
      ],
      optional,
      { unset: msg`Go on at once` },
    ),
    choice(
      'ifEmpty',
      msg`While the date field is empty`,
      [
        { value: 'wait', label: msg`Wait for a date` },
        { value: 'continue', label: msg`Go on at once` },
        { value: 'end', label: msg`End the run` },
      ],
      optional,
      { unset: msg`Wait for a date`, when: (config) => 'field' in config },
    ),
    resumeWindowField,
  ],
  'wait.event': [
    choice(
      'event',
      msg`What to wait for`,
      automationStopEvents.map((event) => ({ value: event, label: eventNames[event] })),
      required,
      { starter: 'message.received' },
    ),
    choice(
      'from',
      msg`Whose messages count`,
      [{ value: 'contact', label: msg`Only the contact's` }],
      optional,
      { when: (config) => config['event'] === 'message.received', unset: msg`Anyone's` },
    ),
    choice(
      'channel',
      msg`On which channel`,
      [
        { value: 'email', label: msg`Email` },
        { value: 'sms', label: msg`Text message` },
        { value: 'whatsapp', label: msg`WhatsApp` },
        { value: 'webchat', label: msg`Web chat` },
      ],
      optional,
      { when: (config) => config['event'] === 'message.received', unset: msg`Any channel` },
    ),
    reference('link', msg`Which trigger link`, 'triggerLinks', optional, {
      when: (config) => config['event'] === 'trigger_link.clicked',
      unset: msg`Any trigger link`,
    }),
    duration('timeout', msg`Give up after`, required, 'P2D'),
    resumeWindowField,
  ],
  'wait.condition': [
    json('if', msg`Condition to wait for`, required, {
      starter: { field: 'contact.email', operator: 'is_set' },
    }),
    duration('timeout', msg`Give up after`, required, 'P2D'),
    resumeWindowField,
  ],
  'wait.appointment': [
    duration('offset', msg`How long before or after it starts`, optional),
    choice(
      'direction',
      msg`Before or after the appointment starts`,
      [
        { value: 'before', label: msg`Before` },
        { value: 'after', label: msg`After` },
      ],
      optional,
      { unset: msg`Before` },
    ),
    resumeWindowField,
  ],
  condition: [
    // One condition, with its yes and no, edited as rows; or branches by name, each with
    // its own. The second setting holds the branches, or the way to change to them.
    json('if', msg`Condition`, required, {
      starter: { field: 'contact.email', operator: 'is_set' },
      when: (config) => config['branches'] === undefined,
    }),
    { key: 'branches', label: msg`Branches`, required: optional, input: { kind: 'branches' } },
  ],
  goto: [
    {
      key: 'target',
      label: msg`Action to go to`,
      required,
      input: { kind: 'step' },
      hint: msg`This path ends here and carries on from that action. A path that leads back needs a wait somewhere in the loop.`,
    },
  ],
  goal: [
    {
      key: 'events',
      label: msg`What meets the goal`,
      required,
      input: { kind: 'goal_events' },
      starter: [{ type: 'appointment.booked', config: {} }],
      hint: msg`Any one of these brings the contact straight here, from wherever they are in the workflow.`,
    },
    {
      key: 'otherwise',
      label: msg`A contact who gets here before the goal is met`,
      required: optional,
      starter: 'continue',
      input: {
        kind: 'choice',
        radios: true,
        options: [
          {
            value: 'continue',
            label: msg`Continues anyway`,
          },
          {
            value: 'wait',
            label: msg`Waits until the goal is met`,
          },
          {
            value: 'end',
            label: msg`Leaves the workflow`,
          },
        ],
      },
    },
  ],
  split: [
    json('variants', msg`Variants`, required, {
      starter: [
        { name: 'a', percent: 50 },
        { name: 'b', percent: 50 },
      ],
    }),
  ],
  'contact.update': [
    {
      key: 'fields',
      label: msg`Fields to set`,
      required: true,
      input: { kind: 'contact_fields' },
      starter: {},
    },
  ],
  'deal.create': [
    reference('pipeline', msg`Pipeline`, 'pipelines', required),
    reference('stage', msg`Stage`, 'stages', required),
    text('name', msg`Opportunity name`, optional, { hint: mergeHint }),
    { key: 'amount', label: msg`Amount`, required: optional, input: { kind: 'number' } },
    text('amountFrom', msg`Or take the amount from a number field`, optional, {
      placeholder: 'contact.budget',
      hint: msg`A number field of the contact by its path, such as contact.budget: what they wrote on a form. Leave Amount empty when you use this.`,
    }),
    {
      key: 'source',
      label: arrivalSettings.dealSource,
      required: optional,
      input: { kind: 'deal_source' },
      hint: arrivalSettings.dealSourceHint,
    },
  ],
  'deal.find': [
    choice(
      'which',
      msg`Opportunity to find`,
      [
        { value: 'newest', label: msg`Most recently created` },
        { value: 'oldest', label: msg`Oldest` },
      ],
      optional,
    ),
    {
      // Named by the first of the members it stands for, as every setting that covers several is.
      key: 'pipeline',
      label: msg`Filters`,
      required: optional,
      input: { kind: 'deal_filters' },
      covers: DEAL_FILTER_KEYS,
      hint: msg`Only an opportunity that passes every filter is found. With none, it is the contact's most recent or oldest one.`,
    },
  ],
  'deal.update': [
    {
      key: 'name',
      label: msg`Fields to change`,
      required,
      input: { kind: 'deal_changes' },
      covers: DEAL_CHANGE_KEYS,
      anyOf: DEAL_CHANGE_KEYS,
      hint: msg`Only what you add here is changed. To move it to another stage, use Move opportunity.`,
    },
  ],
  'deal.move': [
    reference('pipeline', msg`Pipeline`, 'pipelines', optional, {
      unset: msg`Whichever pipeline has the stage`,
    }),
    reference('stage', msg`Stage`, 'stages', required),
  ],
  'deal.close': [
    choice(
      'outcome',
      msg`Close the opportunity as`,
      [
        { value: 'won', label: msg`Won` },
        { value: 'lost', label: msg`Lost` },
      ],
      required,
      { starter: 'won' },
    ),
    reference('lostReason', msg`Lost reason`, 'lostReasons', required, {
      when: (config) => config['outcome'] === 'lost',
    }),
  ],
  'task.create': [
    text('title', msg`Task title`, required, { hint: mergeHint }),
    duration('dueIn', msg`Due after`, optional),
    longText('notes', msg`Notes`, optional, mergeHint),
  ],
  'owner.assign': [
    {
      key: 'user',
      label: msg`Assign to`,
      required,
      input: { kind: 'members' },
      covers: ['user', 'users', 'onlyIfUnassigned'],
      anyOf: ['user', 'users'],
      hint: msg`With several, each contact goes to the next person in turn.`,
    },
  ],
  'owner.remove': [],
  'dnd.set': [
    choice('direction', msg`DND direction`, dndDirections, optional, {
      unset: msg`Outbound`,
      hint: msg`Outbound stops what is sent to the contact. Inbound blocks their text messages; blocking their calls is not available yet.`,
    }),
    choice(
      'channel',
      msg`Restrict`,
      [{ value: 'all', label: msg`Every channel` }, ...dndChannelChoices],
      required,
      {
        starter: 'all',
        when: outbound,
      },
    ),
    choice(
      'action',
      msg`Restriction`,
      [
        { value: 'enable', label: msg`Enable do not disturb` },
        { value: 'disable', label: msg`Clear do not disturb` },
      ],
      required,
      {
        starter: 'enable',
        hint: msg`Clearing a restriction does not opt the contact into messages.`,
      },
    ),
    longText(
      'reason',
      msg`Reason`,
      required,
      msg`Say why in at least 10 characters. Merge fields are supported.`,
    ),
  ],
  'followers.add': [
    {
      key: 'users',
      label: msg`Followers to add`,
      required,
      input: { kind: 'members', followers: 'add' },
      hint: msg`Followers are told when the contact writes.`,
    },
  ],
  'followers.remove': [
    {
      key: 'users',
      label: msg`Followers to remove`,
      required,
      input: { kind: 'members', followers: 'remove' },
      covers: ['users', 'all'],
      anyOf: ['users', 'all'],
    },
  ],
  'score.modify': [
    choice(
      'calculation',
      msg`Calculation`,
      [
        { value: 'add', label: msg`Add` },
        { value: 'subtract', label: msg`Subtract` },
      ],
      required,
    ),
    {
      key: 'points',
      label: msg`Points`,
      required,
      input: { kind: 'number' },
      starter: 1,
      hint: msg`Points between 1 and 1000.`,
    },
  ],
  'email.verify': [
    choice(
      'address',
      msg`Email address`,
      [{ value: 'primary', label: msg`Primary email` }],
      optional,
      {
        hint: msg`The contact's primary email address is the one checked.`,
      },
    ),
    {
      key: 'maxAgeDays',
      label: msg`Reuse a result up to this many days old`,
      required: optional,
      input: { kind: 'number' },
      starter: 90,
      hint: msg`A result this recent is used as it is, at no cost. Between 1 and 365 days.`,
    },
  ],
  'note.create': [longText('text', msg`Note text`, required, mergeHint)],
  'tag.add': [reference('tag', msg`Tag`, 'tags', required)],
  'tag.remove': [reference('tag', msg`Tag`, 'tags', required)],
  'ai.ask': [longText('prompt', msg`What to ask`, required, mergeHint)],
  'ai.classify': [
    json('categories', msg`Categories`, required, { starter: ['yes', 'no'] }),
    longText('instructions', msg`Instructions for the AI`, optional, mergeHint),
  ],
  'ai.draft_reply': [longText('instructions', msg`Instructions for the AI`, optional, mergeHint)],
  'webhook.call': [
    text('url', msg`Web address`, required, {
      placeholder: 'https://',
      hint: msg`An https:// address.`,
    }),
    choice(
      'method',
      msg`Method`,
      [
        { value: 'POST', label: msg`POST` },
        { value: 'PUT', label: msg`PUT` },
        { value: 'PATCH', label: msg`PATCH` },
      ],
      optional,
    ),
    longText('body', msg`Body`, optional, mergeHint),
    json('headers', msg`Headers`, optional, {
      hint: msg`A list of headers, each a name with a value, or a name with the name of a stored webhook secret, which is sent and never shown.`,
    }),
  ],
  'automation.run': [
    {
      key: 'automation',
      label: msg`Automation to start`,
      required,
      input: { kind: 'automations', many: false },
      hint: msg`The contact is enrolled by that automation's own rules. This one goes on at once, without waiting for it.`,
    },
  ],
  'automation.remove': [
    {
      key: 'from',
      label: msg`Remove the contact from`,
      required,
      starter: 'current',
      input: {
        kind: 'choice',
        radios: true,
        options: [
          {
            value: 'current',
            label: msg`This automation`,
          },
          {
            value: 'automations',
            label: msg`Chosen automations`,
          },
          {
            value: 'all_others',
            label: msg`All other automations`,
          },
          {
            value: 'all',
            label: msg`All automations`,
          },
        ],
      },
    },
    {
      key: 'automations',
      label: msg`Automations to remove them from`,
      required,
      input: { kind: 'automations', many: true },
      hint: removeLimitHint,
      when: (config) => config['from'] === 'automations',
    },
    {
      key: 'except',
      label: msg`Except`,
      required: optional,
      input: { kind: 'automations', many: true },
      hint: exceptLimitHint,
      when: (config) => config['from'] === 'all_others' || config['from'] === 'all',
    },
  ],
};

export const triggerFields: Readonly<Record<AutomationTriggerType, readonly FieldSpec[]>> = {
  'form.submitted': [
    reference('form', msg`Form`, 'forms', optional, { unset: msg`Any form` }),
    ...arrivalFilters,
  ],
  'message.received': [
    choice(
      'channel',
      msg`Channel`,
      [
        { value: 'email', label: msg`Email` },
        { value: 'sms', label: msg`Text` },
        { value: 'whatsapp', label: msg`WhatsApp` },
        { value: 'webchat', label: msg`Web chat` },
      ],
      optional,
      { unset: msg`Any channel` },
    ),
    {
      key: 'repliedTo',
      label: msg`Only replies to`,
      required: optional,
      input: { kind: 'automations', many: true, own: true },
      hint: msg`Leave this empty for any message. With automations chosen, only a reply counts: the contact's most recent automated message on that channel came from one of them.`,
    },
  ],
  'appointment.booked': [
    reference('calendar', msg`Calendar`, 'calendars', optional, { unset: msg`Any calendar` }),
    ...arrivalFilters,
  ],
  'appointment.status_changed': [
    reference('calendar', msg`Calendar`, 'calendars', optional, { unset: msg`Any calendar` }),
    text('status', msg`New status`, optional),
  ],
  'deal.stage_changed': [
    reference('pipeline', msg`Pipeline`, 'pipelines', optional, { unset: msg`Any pipeline` }),
    reference('stage', msg`Stage it moves to`, 'stages', optional, { unset: msg`Any stage` }),
  ],
  'deal.closed': [
    reference('pipeline', msg`Pipeline`, 'pipelines', optional, { unset: msg`Any pipeline` }),
    choice(
      'outcome',
      msg`Outcome`,
      [
        { value: 'won', label: msg`Won` },
        { value: 'lost', label: msg`Lost` },
      ],
      optional,
      { unset: msg`Won or lost` },
    ),
  ],
  'contact.created': [],
  'contact.dnd_changed': [
    choice('direction', msg`DND direction`, dndDirections, optional, { unset: msg`Outbound` }),
    choice(
      'flag',
      msg`DND flag`,
      [
        { value: 'enabled', label: msg`Enabled` },
        { value: 'disabled', label: msg`Disabled` },
      ],
      optional,
      { unset: msg`Enabled or disabled` },
    ),
    choice(
      'channel',
      msg`DND channel`,
      [{ value: 'all', label: msg`All channels at once` }, ...dndChannelChoices],
      optional,
      { unset: msg`Any channel`, when: outbound },
    ),
  ],
  'contact.score_changed': [
    choice(
      'operator',
      msg`Comparison`,
      [
        { value: 'equals', label: msg`Equals` },
        { value: 'not_equals', label: msg`Does not equal` },
        { value: 'gt', label: msg`Greater than` },
        { value: 'gte', label: msg`At least` },
        { value: 'lt', label: msg`Less than` },
        { value: 'lte', label: msg`At most` },
      ],
      required,
    ),
    {
      key: 'score',
      label: msg`Score`,
      required,
      input: { kind: 'number' },
      starter: 0,
    },
  ],
  'field.changed': [
    text('field', msg`Field`, required, {
      placeholder: 'contact.firstName',
      hint: msg`A field by its path, such as contact.firstName.`,
    }),
    json('to', msg`The value it changes to`, optional),
  ],
  'tag.added': [reference('tag', msg`Tag`, 'tags', required)],
  'tag.removed': [reference('tag', msg`Tag`, 'tags', required)],
  'task.created': [],
  'task.completed': [],
  // GoHighLevel's two filters; either or both, each firing on its own.
  'task.reminder': [
    {
      key: 'before',
      label: msg`Before no. of days`,
      required: optional,
      input: { kind: 'number' },
      starter: 1,
    },
    { key: 'after', label: msg`After no. of days`, required: optional, input: { kind: 'number' } },
  ],
  'note.created': [],
  'note.updated': [],
  'quote.sent': [],
  'quote.accepted': [],
  'quote.declined': [],
  'invoice.issued': [],
  'invoice.sent': [],
  'invoice.paid': [],
  'payment.recorded': [],
  'trigger_link.clicked': [reference('link', msg`Trigger link`, 'triggerLinks', required)],
  'automation.run_ended': [
    {
      key: 'automations',
      label: msg`When a run of one of these ends`,
      required,
      input: { kind: 'automations', many: true },
      hint: runEndedLimitHint,
    },
    {
      key: 'how',
      label: msg`How the run ended`,
      required: optional,
      hint: msg`Tick none for any of them. A run cancelled because its automation was deleted never counts.`,
      input: {
        kind: 'choices',
        options: [
          {
            value: 'stopped',
            label: msg`Stopped`,
          },
          {
            value: 'removed',
            label: msg`Removed`,
          },
          {
            value: 'completed',
            label: msg`Completed`,
          },
          {
            value: 'failed',
            label: msg`Failed`,
          },
        ],
      },
    },
    {
      key: 'stoppedBy',
      label: msg`Only when it was stopped by`,
      required: optional,
      hint: msg`Tick none for any stop condition. With one ticked, only a stopped run counts.`,
      input: {
        kind: 'choices',
        options: automationStopEvents.map((event) => ({ value: event, label: eventNames[event] })),
      },
      // A run that wasn't stopped has no stop condition to ask about.
      when: (config) =>
        !Array.isArray(config['how']) ||
        config['how'].length === 0 ||
        config['how'].includes('stopped'),
    },
  ],
  'date.reached': [
    ...dateFields(false),
    choice(
      'repeat',
      msg`Repeats`,
      [
        { value: 'yearly', label: msg`Every year, as a birthday does` },
        { value: 'never', label: msg`Never: only on the date itself` },
      ],
      optional,
    ),
  ],
  'webhook.received': [],
  schedule: [
    json('every', msg`When it repeats`, required, {
      covers: ['every', 'at', 'weekday', 'day'],
      starter: 'day',
    }),
  ],
};

/** Members a new step or trigger needs beyond its fields' own starters, to be valid JSON-only settings. */
const extraStarters: Readonly<Record<string, Config>> = {
  'wait.until': { offset: 'P1D', direction: 'after' },
  schedule: { at: '09:00' },
};

const has = <Key extends string>(table: Readonly<Record<Key, unknown>>, key: string): key is Key =>
  Object.hasOwn(table, key);

export type FieldOwner = 'step' | 'trigger';

/** The settings of a type, or nothing for a type this version doesn't know. */
export function fieldsOf(owner: FieldOwner, type: string): readonly FieldSpec[] | undefined {
  if (owner === 'step') return has(stepFields, type) ? stepFields[type] : undefined;
  return has(triggerFields, type) ? triggerFields[type] : undefined;
}

/** What a new step or trigger of a type starts with, before the person fills it in. */
export function starterConfig(owner: FieldOwner, type: string): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fieldsOf(owner, type) ?? [])
    if (field.starter !== undefined) config[field.key] = field.starter;
  return { ...config, ...extraStarters[type] };
}

/** The fields that apply to these settings, in order. */
export function shownFields(owner: FieldOwner, type: string, config: Config): FieldSpec[] {
  return (fieldsOf(owner, type) ?? []).filter((field) => field.when?.(config) ?? true);
}

/** The settings as they are saved: nothing empty, and nothing that no longer applies. */
export function cleanConfig(
  owner: FieldOwner,
  type: string,
  config: Config,
): Record<string, unknown> {
  const fields = fieldsOf(owner, type);
  if (fields === undefined) return { ...config };
  const hidden = new Set(
    fields
      .filter((field) => !(field.when?.(config) ?? true))
      .flatMap((field) => field.covers ?? [field.key]),
  );
  return Object.fromEntries(
    Object.entries(config).filter(
      ([key, value]) =>
        !hidden.has(key) &&
        value !== undefined &&
        (value !== '' || (type === 'email.send' && key === 'template')),
    ),
  );
}

/** The settings that must be filled in and aren't yet. */
export function missingFields(owner: FieldOwner, type: string, config: Config): string[] {
  return shownFields(owner, type, config)
    .filter(
      (field) =>
        field.required &&
        (field.anyOf ?? [field.key]).every((key) => {
          const value = config[key];
          return (
            value === undefined ||
            value === '' ||
            (Array.isArray(value) && value.length === 0) ||
            // An Update contact step that sets no field does nothing.
            (field.input.kind === 'contact_fields' &&
              isRecord(value) &&
              Object.keys(value).length === 0)
          );
        }),
    )
    .map((field) => field.key);
}

/** What's wrong with settings, by the field each problem is under: the contract's own check. */
export function configProblems(
  owner: FieldOwner,
  type: string,
  config: Config,
): Record<string, string> {
  const schema =
    owner === 'step'
      ? has(automationStepTypes, type)
        ? automationStepTypes[type].config
        : undefined
      : has(automationTriggerTypes, type)
        ? automationTriggerTypes[type].config
        : undefined;
  if (schema === undefined) return {};
  const parsed = schema.safeParse(config);
  if (parsed.success) return {};
  const problems: Record<string, string> = {};
  const note = (path: readonly PropertyKey[], message: string): void => {
    const [first, inside] = path;
    const key = typeof first === 'string' ? first : '';
    // A field a step writes has a row of its own: what is wrong with it is said there.
    problems[key === 'fields' && typeof inside === 'string' ? `fields/${inside}` : key] ??= message;
  };
  for (const issue of parsed.error.issues) {
    // A union reports every alternative's problems: the closest alternative's are the ones
    // to show. That is the one these settings are written as (it has no member it doesn't
    // know), and among those the one with the fewest problems.
    const strays = (found: readonly { readonly code?: string }[]): number =>
      found.filter((each) => each.code === 'unrecognized_keys').length;
    const closest =
      issue.code === 'invalid_union' && issue.path.length === 0
        ? issue.errors.toSorted(
            (left, right) => strays(left) - strays(right) || left.length - right.length,
          )[0]
        : undefined;
    if (closest === undefined || closest.length === 0) note(issue.path, issue.message);
    else for (const each of closest) note(each.path, each.message);
  }
  return problems;
}

export type DurationUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks';

/** A length of time the form can hold: one whole number of one unit. */
export function durationParts(
  iso: unknown,
): { readonly amount: number; readonly unit: DurationUnit } | undefined {
  const match =
    typeof iso === 'string' ? /^P(?:(\d+)W|(\d+)D|T(\d+)H|T(\d+)M|T(\d+)S)$/.exec(iso) : null;
  if (match === null) return undefined;
  const [, weeks, days, hours, minutes, seconds] = match;
  if (weeks !== undefined) return { amount: Number(weeks), unit: 'weeks' };
  if (days !== undefined) return { amount: Number(days), unit: 'days' };
  if (hours !== undefined) return { amount: Number(hours), unit: 'hours' };
  if (minutes !== undefined) return { amount: Number(minutes), unit: 'minutes' };
  return seconds === undefined ? undefined : { amount: Number(seconds), unit: 'seconds' };
}

export function durationOf(amount: number, unit: DurationUnit): string {
  const whole = String(Math.max(0, Math.trunc(amount)));
  if (unit === 'weeks') return `P${whole}W`;
  if (unit === 'days') return `P${whole}D`;
  if (unit === 'hours') return `PT${whole}H`;
  return unit === 'minutes' ? `PT${whole}M` : `PT${whole}S`;
}

/** The days of a resume window, in the order of the week, as the contract names them. */
export const WINDOW_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type WindowDay = (typeof WINDOW_DAYS)[number];

export interface ResumeWindowParts {
  readonly days: readonly WindowDay[];
  readonly start: string;
  readonly end: string;
}

/** What switching "only go on during certain hours" on starts from: office hours. */
export const DEFAULT_RESUME_WINDOW: ResumeWindowParts = {
  days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  start: '09:00',
  end: '17:00',
};

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A resume window the form can hold: at least one known day, and two 24-hour times. */
export function resumeWindowParts(value: unknown): ResumeWindowParts | undefined {
  if (!isRecord(value)) return undefined;
  const { days, start, end } = value;
  if (!Array.isArray(days) || typeof start !== 'string' || typeof end !== 'string')
    return undefined;
  const known = WINDOW_DAYS.filter((day) => days.includes(day));
  if (known.length === 0 || known.length !== days.length) return undefined;
  if (!TIME_OF_DAY.test(start) || !TIME_OF_DAY.test(end)) return undefined;
  if (Object.keys(value).some((key) => key !== 'days' && key !== 'start' && key !== 'end'))
    return undefined;
  return { days: known, start, end };
}

const windowDayNames: Readonly<Record<WindowDay, MessageDescriptor>> = {
  monday: msg`Monday`,
  tuesday: msg`Tuesday`,
  wednesday: msg`Wednesday`,
  thursday: msg`Thursday`,
  friday: msg`Friday`,
  saturday: msg`Saturday`,
  sunday: msg`Sunday`,
};

/** A resume window in words: "Monday, Tuesday and Friday, 09:00 to 17:00". */
export function resumeWindowWords(value: unknown): string | undefined {
  const parts = resumeWindowParts(value);
  if (parts === undefined) return undefined;
  const days =
    parts.days.length === 7
      ? i18n._(msg`Every day`)
      : listed(
          parts.days.map((day) => i18n._(windowDayNames[day])),
          'conjunction',
        );
  const { start, end } = parts;
  return i18n._(msg`${days}, ${start} to ${end}`);
}

export interface ReferenceOption {
  readonly value: string;
  readonly label: string;
}

/**
 * What a reference setting can be set to: this business's own, by id. Stages are those of
 * the pipeline chosen, or every pipeline's when none is. A value the business doesn't have
 * (a name typed in JSON, something since deleted) isn't among them; `currentReference`
 * says which option holds the current value.
 */
export function referenceOptions(
  list: ReferenceList,
  setup: AutomationSetup,
  config: Config,
): ReferenceOption[] {
  if (list !== 'stages')
    return (setup[list] ?? []).map((item) => ({ value: item.id, label: item.name }));
  const chosen = typeof config['pipeline'] === 'string' ? config['pipeline'] : undefined;
  const pipeline = setup.pipelines.find(
    (candidate) => candidate.id === chosen || candidate.name === chosen,
  );
  if (pipeline !== undefined)
    return pipeline.stages.map((stage) => ({ value: stage.id, label: stage.name }));
  return setup.pipelines.flatMap((each) =>
    each.stages.map((stage) => ({ value: stage.id, label: `${each.name} · ${stage.name}` })),
  );
}

/** The option a value given by id or by name stands for, if the business has it. */
export function currentReference(
  options: readonly ReferenceOption[],
  given: unknown,
): string | undefined {
  if (typeof given !== 'string' || given === '') return undefined;
  const byId = options.find((option) => option.value === given);
  if (byId !== undefined) return byId.value;
  const named = options.filter(
    (option) => option.label.trim().toLowerCase() === given.trim().toLowerCase(),
  );
  return named.length === 1 ? named[0]?.value : undefined;
}

const listOf = (
  list: ReferenceList,
  setup: AutomationSetup,
): readonly { id: string; name: string }[] =>
  list === 'stages' ? setup.pipelines.flatMap((pipeline) => pipeline.stages) : (setup[list] ?? []);

/** A setting's value in words, for the settings a form can't edit and for what changed. */
export function settingWords(field: FieldSpec, value: unknown, setup: AutomationSetup): string {
  if (value === undefined) return i18n._(msg`Not set`);
  const { input } = field;
  if (input.kind === 'reference')
    return nameIn(listOf(input.list, setup), value) ?? JSON.stringify(value);
  if (input.kind === 'automations')
    return namesIn(setup.automations, value, 'conjunction') ?? JSON.stringify(value);
  if (input.kind === 'deal_source') return createdSourceWords(value) ?? JSON.stringify(value);
  if (input.kind === 'lead_sources' && Array.isArray(value))
    return listed(
      (value as readonly unknown[]).map((each) => String(each)),
      'disjunction',
    );
  if (input.kind === 'duration') return durationWords(value) ?? JSON.stringify(value);
  if (input.kind === 'resume_window') return resumeWindowWords(value) ?? JSON.stringify(value);
  if (input.kind === 'choice') {
    const option = input.options.find((each) => each.value === value);
    return option === undefined ? JSON.stringify(value) : i18n._(option.label);
  }
  if (input.kind === 'choices') {
    const labels = (Array.isArray(value) ? (value as readonly unknown[]) : []).flatMap((each) => {
      const option = input.options.find((known) => known.value === each);
      return option === undefined ? [] : [i18n._(option.label)];
    });
    return labels.length === 0 ? JSON.stringify(value) : listed(labels, 'disjunction');
  }
  // What an Update contact step writes reads as its card does.
  if (input.kind === 'contact_fields')
    return (
      stepSummary({ type: 'contact.update', config: { fields: value } }, setup) ??
      JSON.stringify(value)
    );
  if (input.kind === 'json' && field.key === 'if')
    return conditionWords(value, false, setup) ?? JSON.stringify(value);
  if (typeof value === 'string') return i18n._(msg`“${value}”`);
  return JSON.stringify(value);
}
