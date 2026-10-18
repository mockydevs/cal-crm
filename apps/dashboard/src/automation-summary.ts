// An automation in plain words (docs/AUTOMATIONS.md section 9, the Steps view): what starts
// it, what each step does and what stops it, written from the document. Ids become the
// names this business gave things, durations become "2 days", and a condition becomes a
// sentence. Something not filled in yet has no summary, and the view says so.
import { i18n } from '@lingui/core';
import { plural, t } from '@lingui/core/macro';
import type {
  AutomationSetup,
  AutomationStepType,
  AutomationTriggerType,
  automationWaitEvents,
} from '@repo/contracts';
import {
  arrivalFilterWords,
  attributionValueWords,
  attributionWords,
  createdSourceWords,
  isAttributionText,
} from './automation-attribution-words';
import { isRecord } from './automation-document';
import { stopEvents, stopEventWords } from './automation-stop-words';

type Config = Readonly<Record<string, unknown>>;
type Named = Readonly<{ id: string; name: string }>;

const filled = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** The name of something the document refers to by id or by name. */
export function nameIn(list: readonly Named[], given: unknown): string | undefined {
  const reference = filled(given);
  return reference === undefined
    ? undefined
    : (list.find((item) => item.id === reference)?.name ?? reference);
}

const stagesOf = (setup: AutomationSetup): Named[] =>
  setup.pipelines.flatMap((pipeline) => pipeline.stages);

const quoted = (words: string): string => t`“${words}”`;

/** A message's opening, so a long one doesn't fill the list. */
function excerpt(given: unknown): string | undefined {
  const words = filled(given)?.replaceAll(/\s+/g, ' ').trim();
  if (words === undefined) return undefined;
  return quoted(words.length > 140 ? `${words.slice(0, 139).trimEnd()}…` : words);
}

export function listed(parts: readonly string[], type: 'conjunction' | 'disjunction'): string {
  return new Intl.ListFormat(i18n.locale || undefined, { style: 'long', type }).format(parts);
}

/**
 * The names of what the document refers to, one or several, as a list in words; nothing
 * when it names none.
 */
export function namesIn(
  list: readonly Named[],
  given: unknown,
  type: 'conjunction' | 'disjunction',
  write: (name: string) => string = (name) => name,
): string | undefined {
  const names = (Array.isArray(given) ? (given as readonly unknown[]) : [given]).flatMap((each) => {
    const name = nameIn(list, each);
    return name === undefined ? [] : [write(name)];
  });
  return names.length === 0 ? undefined : listed(names, type);
}

const DURATION =
  /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** An ISO 8601 duration in words: P2D is "2 days", P1DT4H is "1 day and 4 hours". */
export function durationWords(given: unknown): string | undefined {
  const match = typeof given === 'string' ? DURATION.exec(given) : null;
  if (match === null) return undefined;
  const [years, months, weeks, days, hours, minutes, seconds] = match
    .slice(1)
    .map((digits: string | undefined) => Number(digits ?? 0));
  const parts = [
    years ? plural(years, { one: '# year', other: '# years' }) : '',
    months ? plural(months, { one: '# month', other: '# months' }) : '',
    weeks ? plural(weeks, { one: '# week', other: '# weeks' }) : '',
    days ? plural(days, { one: '# day', other: '# days' }) : '',
    hours ? plural(hours, { one: '# hour', other: '# hours' }) : '',
    minutes ? plural(minutes, { one: '# minute', other: '# minutes' }) : '',
    seconds ? plural(seconds, { one: '# second', other: '# seconds' }) : '',
  ].filter((part) => part !== '');
  return parts.length === 0
    ? plural(0, { one: '# minute', other: '# minutes' })
    : listed(parts, 'conjunction');
}

/** A field path in words: contact.firstName is "first name", deal.amount is "opportunity amount". */
export function fieldWords(given: unknown): string | undefined {
  const path = filled(given);
  if (path === undefined) return undefined;
  // Where the contact came from: "lead source", "first UTM campaign".
  const attribution = attributionWords(path);
  if (attribution !== undefined) return attribution;
  const parts = path.split('.');
  const key = parts.at(-1) ?? path;
  const words = key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase();
  if (parts[0] === 'contact') return words;
  if (parts[0] === 'deal') return t`opportunity ${words}`;
  return path;
}

function valueWords(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'boolean') return value ? t`yes` : t`no`;
  if (value === null) return t`nothing`;
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/** One merge field and nothing else: what copying a field into another is written as. */
const LONE_FIELD = /^\{\{([a-z]+(?:\.\w+)+)\}\}$/;

/** What an Update contact step does to one field: "copy utm source to lead source". */
function writeWords(field: string, written: unknown): string {
  const only = isRecord(written) && 'set' in written;
  const value = only ? written['set'] : written;
  const operand = (side: unknown): string =>
    typeof side === 'number' ? String(side) : (fieldWords(side) ?? '');
  const from = typeof value === 'string' ? fieldWords(LONE_FIELD.exec(value)?.[1]) : undefined;
  let change: string;
  if (value === null) change = t`clear ${field}`;
  else if (from !== undefined) change = t`copy ${from} to ${field}`;
  else if (!isRecord(value)) {
    const set = valueWords(value);
    change = t`set ${field} to ${set}`;
  } else if (value['op'] === 'math') {
    const sum = `${operand(value['left'])} ${String(value['operator'])} ${operand(value['right'])}`;
    change = t`set ${field} to ${sum}`;
  } else if (value['op'] === 'date_add') {
    const days = typeof value['days'] === 'number' ? value['days'] : 0;
    const base = fieldWords(value['field']) ?? filled(value['value']) ?? t`now`;
    const time = plural(Math.abs(days), { one: '# day', other: '# days' });
    change =
      days < 0
        ? t`set ${field} to ${time} before ${base}`
        : t`set ${field} to ${time} after ${base}`;
  } else change = value['op'] === 'now' ? t`set ${field} to now` : t`set ${field}`;
  return only && written['onlyIfEmpty'] === true ? t`${change}, only if empty` : change;
}

type Fields = Pick<AutomationSetup, 'fields'>;

/**
 * What a custom field is called where one is chosen: the name the business gave it, or its
 * key in words ("Event date" for event_date) when the catalog carries no name.
 */
export function customFieldName(field: {
  readonly key: string;
  readonly label?: string | undefined;
}): string {
  const label = field.label?.trim() ?? '';
  if (label !== '') return label;
  const words = fieldWords(`contact.${field.key}`) ?? field.key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The heading a contact's custom fields are listed under: their folder in Settings. */
export function folderHeading(field: {
  readonly folder?: { readonly name: string } | null | undefined;
}): string | undefined {
  const name = field.folder?.name;
  return name === undefined ? undefined : t`Contact: ${name}`;
}

// The contact's and the opportunity's own fields that hold text, as the validator types them.
const TEXT_FIELD = /^(firstName|lastName|name|email|source|currency|pipeline|stage)$/;

/**
 * Whether a field holds text, so "includes" reads as "contains": one of the built-in text
 * fields, or a custom field of this business whose type is text. A list (tags, several
 * choices) and a field nothing here knows are not.
 */
export function holdsText(path: unknown, setup?: Fields): boolean {
  if (isAttributionText(path)) return true;
  const [head, key = '', more] = typeof path === 'string' ? path.split('.') : [];
  if (head !== 'contact' && head !== 'deal') return false;
  if (more === undefined && TEXT_FIELD.test(key)) return true;
  const named = more === undefined ? key : key === 'custom' ? more : undefined;
  const custom = setup?.fields[head].find(
    (field) => field.key === named || (named !== undefined && field.aliases.includes(named)),
  );
  return custom !== undefined && ['text', 'long_text', 'email', 'url'].includes(custom.type);
}

/**
 * A condition as a sentence: "services includes “Video” and email is filled in". With the
 * business's fields, a text field reads "contains" where a list reads "includes".
 */
export function conditionWords(
  condition: unknown,
  nested = false,
  setup?: Fields,
): string | undefined {
  if (!isRecord(condition)) return undefined;
  const group = (items: unknown, type: 'conjunction' | 'disjunction'): string | undefined => {
    if (!Array.isArray(items) || items.length === 0) return undefined;
    const parts = (items as readonly unknown[]).map((item) => conditionWords(item, true, setup));
    if (parts.some((part) => part === undefined)) return undefined;
    const sentence = listed(
      parts.filter((part) => part !== undefined),
      type,
    );
    return nested && parts.length > 1 ? t`(${sentence})` : sentence;
  };
  if ('all' in condition) return group(condition['all'], 'conjunction');
  if ('any' in condition) return group(condition['any'], 'disjunction');
  if ('not' in condition) {
    const inner = conditionWords(condition['not'], true, setup);
    return inner === undefined ? undefined : t`not ${inner}`;
  }
  const field = fieldWords(condition['field']);
  const operator = filled(condition['operator']);
  if (field === undefined || operator === undefined) return undefined;
  // A session source or a medium is said by its name; everything else as it is written.
  const value =
    attributionValueWords(condition['field'], condition['value']) ?? valueWords(condition['value']);
  const time = durationWords(condition['value']) ?? value;
  const text = holdsText(condition['field'], setup);
  switch (operator) {
    case 'equals':
      return t`${field} is ${value}`;
    case 'not_equals':
      return t`${field} is not ${value}`;
    case 'includes':
      return text ? t`${field} contains ${value}` : t`${field} includes ${value}`;
    case 'excludes':
      return text ? t`${field} doesn't contain ${value}` : t`${field} doesn't include ${value}`;
    case 'starts_with':
      return t`${field} starts with ${value}`;
    case 'greater_than':
      return t`${field} is more than ${value}`;
    case 'less_than':
      return t`${field} is less than ${value}`;
    case 'is_set':
      return t`${field} is filled in`;
    case 'is_empty':
      return t`${field} is empty`;
    case 'before':
      return t`${field} is before ${value}`;
    case 'after':
      return t`${field} is after ${value}`;
    case 'within_last':
      return t`${field} was in the last ${time}`;
    case 'within_next':
      return t`${field} is in the next ${time}`;
    default:
      return undefined;
  }
}

/** A date field with its offset: "2 days before event date, at 09:00". */
function dateWords(config: Config): string | undefined {
  const field = fieldWords(config['field']);
  if (field === undefined) return undefined;
  const offset = durationWords(config['offset']);
  const time = filled(config['time']);
  const day =
    offset === undefined
      ? field
      : config['direction'] === 'after'
        ? t`${offset} after ${field}`
        : t`${offset} before ${field}`;
  return time === undefined ? day : t`${day}, at ${time}`;
}

type WaitEvent = (typeof automationWaitEvents)[number];

/** "Wait up to 2 days for a reply": one sentence for each event a step can wait for. */
const eventWaits: Readonly<Record<WaitEvent, (time: string, fromContact: boolean) => string>> = {
  'message.received': (time, fromContact) =>
    fromContact ? t`Wait up to ${time} for a reply` : t`Wait up to ${time} for a message`,
  'form.submitted': (time) => t`Wait up to ${time} for them to submit a form`,
  'appointment.booked': (time) => t`Wait up to ${time} for them to book an appointment`,
  'appointment.status_changed': (time) =>
    t`Wait up to ${time} for their appointment's status to change`,
  'deal.stage_changed': (time) => t`Wait up to ${time} for their opportunity to move stage`,
  'deal.closed': (time) => t`Wait up to ${time} for their opportunity to be won or lost`,
  'field.changed': (time) => t`Wait up to ${time} for one of their fields to change`,
  'tag.added': (time) => t`Wait up to ${time} for a tag to be added`,
  'trigger_link.clicked': (time) => t`Wait up to ${time} for them to open a trigger link`,
};

const has = <Key extends string>(table: Readonly<Record<Key, unknown>>, key: string): key is Key =>
  Object.hasOwn(table, key);

type Summarize = (config: Config, setup: AutomationSetup) => string | undefined;

const stepLabels: Readonly<Record<AutomationStepType, () => string>> = {
  'email.send': () => t`Send email`,
  'sms.send': () => t`Send text`,
  'whatsapp.send': () => t`Send WhatsApp message`,
  'team.notify': () => t`Notify the team`,
  'manual.call': () => t`Manual call`,
  'manual.sms': () => t`Manual text`,
  wait: () => t`Wait`,
  'wait.until': () => t`Wait until`,
  'wait.event': () => t`Wait for an event`,
  'wait.condition': () => t`Wait for a condition`,
  'wait.appointment': () => t`Wait for an appointment`,
  condition: () => t`If / else`,
  goto: () => t`Go to`,
  goal: () => t`Goal`,
  split: () => t`A/B split`,
  'contact.update': () => t`Update contact`,
  'deal.create': () => t`Create opportunity`,
  'deal.find': () => t`Find opportunity`,
  'deal.update': () => t`Update opportunity`,
  'deal.move': () => t`Move opportunity`,
  'deal.close': () => t`Close opportunity`,
  'task.create': () => t`Create task`,
  'owner.assign': () => t`Assign owner`,
  'owner.remove': () => t`Remove owner`,
  'dnd.set': () => t`Set do not disturb`,
  'followers.add': () => t`Add contact followers`,
  'followers.remove': () => t`Remove contact followers`,
  'note.create': () => t`Create note`,
  'tag.add': () => t`Add tag`,
  'tag.remove': () => t`Remove tag`,
  'ai.ask': () => t`Ask AI`,
  'ai.classify': () => t`Classify with AI`,
  'ai.draft_reply': () => t`Draft a reply with AI`,
  'webhook.call': () => t`Call a webhook`,
  'automation.run': () => t`Start another automation`,
  'automation.remove': () => t`Remove from automations`,
  'score.modify': () => t`Modify Contact Engagement Score`,
  'email.verify': () => t`Email verification`,
};

/** An outbound do not disturb channel in words, or nothing for one that is not. */
function dndChannelWords(channel: unknown): string | undefined {
  switch (channel) {
    case 'all':
      return t`every channel`;
    case 'email':
      return t`email`;
    case 'sms':
      return t`text messages`;
    case 'call':
      return t`calls and voicemails`;
    case 'webchat':
      return t`web chat`;
    default:
      return undefined;
  }
}

const stepSummaries: Readonly<Record<AutomationStepType, Summarize>> = {
  'email.send': (config, setup) => {
    // A step that syncs with a template names it by its source: it sends that template.
    const source = config['mode'] === 'sync' && isRecord(config['source']) ? config['source'] : {};
    const template = nameIn(setup.emailTemplates, config['template'] ?? source['id']);
    const mailbox = nameIn(setup.mailboxes, config['mailbox']);
    const subject = excerpt(config['subject']);
    const email = template === undefined ? subject : quoted(template);
    if (email === undefined) return undefined;
    return mailbox === undefined
      ? t`Send the email ${email}`
      : t`Send the email ${email} from ${mailbox}`;
  },
  'sms.send': (config, setup) => {
    const message = excerpt(config['message']);
    const number = nameIn(setup.phoneNumbers, config['number']);
    if (message === undefined) return undefined;
    return number === undefined ? t`Text them ${message}` : t`Text them ${message} from ${number}`;
  },
  'whatsapp.send': (config, setup) => {
    const template = nameIn(setup.whatsappTemplates, config['template']);
    if (template === undefined) return undefined;
    const name = quoted(template);
    return t`Send the WhatsApp template ${name}`;
  },
  'manual.call': (config, setup) => {
    const user = nameIn(setup.users, config['user']);
    return user === undefined
      ? t`Ask the contact's owner to call them`
      : t`Ask ${user} to call them`;
  },
  'manual.sms': (config, setup) => {
    const message = excerpt(config['message']);
    const user = nameIn(setup.users, config['user']);
    if (message === undefined) return undefined;
    return user === undefined
      ? t`Ask the contact's owner to text them ${message}`
      : t`Ask ${user} to text them ${message}`;
  },
  'team.notify': (config) => {
    const message = excerpt(config['message']);
    if (message === undefined) return undefined;
    if (config['to'] === 'everyone') return t`Tell everyone on the team ${message}`;
    return config['to'] === 'owner_or_everyone'
      ? t`Tell the contact's owner, or everyone when there is none, ${message}`
      : t`Tell the contact's owner ${message}`;
  },
  wait: (config) => {
    const time = durationWords(config['duration']);
    return time === undefined ? undefined : t`Wait ${time}`;
  },
  'wait.until': (config) => {
    const at = filled(config['at']);
    if (at !== undefined) {
      const date = new Date(at);
      if (Number.isNaN(date.getTime())) return undefined;
      const when = new Intl.DateTimeFormat(i18n.locale || undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
      return t`Wait until ${when}`;
    }
    const day = dateWords(config);
    return day === undefined ? undefined : t`Wait until ${day}`;
  },
  'wait.event': (config) => {
    const event = filled(config['event']);
    const time = durationWords(config['timeout']);
    if (event === undefined || time === undefined || !has(eventWaits, event)) return undefined;
    return eventWaits[event](time, config['from'] === 'contact');
  },
  'wait.condition': (config) => {
    const time = durationWords(config['timeout']);
    return time === undefined ? undefined : t`Wait up to ${time} for a condition to hold`;
  },
  'wait.appointment': (config) => {
    const time = durationWords(config['offset']);
    // Nothing chosen yet reads as not set up; the step's own name stands in.
    if (time === undefined)
      return config['direction'] === undefined ? undefined : t`Wait until their appointment starts`;
    return config['direction'] === 'after'
      ? t`Wait until ${time} after their appointment starts`
      : t`Wait until ${time} before their appointment starts`;
  },
  condition: (config, setup) => {
    const branches: readonly unknown[] = Array.isArray(config['branches'])
      ? config['branches']
      : [];
    if (branches.length > 0) {
      const names = branches.flatMap((branch) => {
        if (!isRecord(branch)) return [];
        const name = filled(branch['label']) ?? filled(branch['name']);
        return name === undefined ? [] : [quoted(name)];
      });
      if (names.length === 0) return undefined;
      const each = listed(names, 'disjunction');
      return t`Take the first branch that holds: ${each}`;
    }
    const check = conditionWords(config['if'], false, setup);
    return check === undefined ? undefined : t`If ${check}`;
  },
  goto: (config) => {
    const target = filled(config['target']);
    return target === undefined ? undefined : t`Go to the action ${target}`;
  },
  goal: (config) => {
    const events: readonly unknown[] = Array.isArray(config['events']) ? config['events'] : [];
    const names = events.flatMap((event) => {
      const label =
        isRecord(event) && typeof event['type'] === 'string'
          ? triggerLabel(event['type'])
          : undefined;
      return label === undefined ? [] : [label];
    });
    if (names.length === 0) return undefined;
    const any = listed(names, 'disjunction');
    return t`Come straight here on: ${any}`;
  },
  split: (config) => {
    const variants: readonly unknown[] = Array.isArray(config['variants'])
      ? config['variants']
      : [];
    const parts = variants.flatMap((variant) => {
      if (!isRecord(variant) || typeof variant['name'] !== 'string') return [];
      const name = variant['name'];
      const percent = String(variant['percent']);
      return [t`${name} ${percent}%`];
    });
    if (parts.length < 2) return undefined;
    const shares = listed(parts, 'conjunction');
    return t`Split contacts: ${shares}`;
  },
  'contact.update': (config) => {
    const fields = isRecord(config['fields']) ? Object.entries(config['fields']) : [];
    const parts = fields.map(([path, value]) => writeWords(fieldWords(path) ?? path, value));
    if (parts.length === 0) return undefined;
    const changes = listed(parts, 'conjunction');
    return t`On the contact: ${changes}`;
  },
  'deal.create': (config, setup) => {
    const pipeline = nameIn(setup.pipelines, config['pipeline']);
    const stage = nameIn(stagesOf(setup), config['stage']);
    if (pipeline === undefined || stage === undefined) return undefined;
    const created = t`Create an opportunity in ${pipeline}, at ${stage}`;
    // Where its source comes from: how the lead arrived, unless the step says otherwise.
    const source = createdSourceWords(config['source']);
    return source === undefined ? created : `${created}. ${source}`;
  },
  'deal.find': (config, setup) => {
    const pipeline = nameIn(setup.pipelines, config['pipeline']);
    const stage = nameIn(stagesOf(setup), config['stage']);
    const name = filled(config['nameContains']);
    const said = quoted(name ?? '');
    const amount = isRecord(config['value']) ? config['value'] : undefined;
    const sum = String(amount?.['value']);
    const custom = isRecord(config['customField']) ? config['customField'] : undefined;
    const field = fieldWords(custom?.['field']);
    const equal = valueWords(custom?.['equals']);
    const filters = [
      pipeline === undefined ? '' : t`in ${pipeline}`,
      stage === undefined ? '' : t`at ${stage}`,
      config['status'] === 'open'
        ? t`open`
        : config['status'] === 'won'
          ? t`won`
          : config['status'] === 'lost'
            ? t`lost`
            : '',
      name === undefined ? '' : t`named like ${said}`,
      amount === undefined
        ? ''
        : amount['operator'] === 'greater_than'
          ? t`worth more than ${sum}`
          : amount['operator'] === 'less_than'
            ? t`worth less than ${sum}`
            : t`worth ${sum}`,
      field === undefined ? '' : t`whose ${field} is ${equal}`,
    ].filter((part) => part !== '');
    const which =
      config['which'] === 'oldest'
        ? t`Find their oldest opportunity`
        : t`Find their most recent opportunity`;
    const where = filters.join(', ');
    return filters.length === 0 ? which : t`${which}: ${where}`;
  },
  'deal.update': (config) => {
    const names = [
      config['name'] === undefined ? '' : t`name`,
      config['amount'] === undefined && config['amountFrom'] === undefined ? '' : t`value`,
      config['owner'] === undefined ? '' : t`owner`,
      config['expectedCloseDate'] === undefined ? '' : t`expected close date`,
      config['source'] === undefined ? '' : t`source`,
      ...(isRecord(config['fields'])
        ? Object.keys(config['fields']).map((path) => fieldWords(`contact.${path}`) ?? path)
        : []),
    ].filter((part) => part !== '');
    if (names.length === 0)
      return config['status'] === 'open' ? t`Reopen the opportunity` : undefined;
    const what = listed(names, 'conjunction');
    return config['status'] === 'open'
      ? t`Reopen the opportunity and set its ${what}`
      : t`On the opportunity: set ${what}`;
  },
  'deal.move': (config, setup) => {
    const stage = nameIn(stagesOf(setup), config['stage']);
    return stage === undefined ? undefined : t`Move the opportunity to ${stage}`;
  },
  'deal.close': (config, setup) => {
    if (config['outcome'] === 'won') return t`Close the opportunity as won`;
    const reason = nameIn(setup.lostReasons, config['lostReason']);
    return config['outcome'] !== 'lost' || reason === undefined
      ? undefined
      : t`Close the opportunity as lost: ${reason}`;
  },
  'task.create': (config) => {
    const title = excerpt(config['title']);
    const due = durationWords(config['dueIn']);
    if (title === undefined) return undefined;
    return due === undefined
      ? t`Create the task ${title}`
      : t`Create the task ${title}, due in ${due}`;
  },
  'owner.assign': (config, setup) => {
    const team: readonly unknown[] = Array.isArray(config['users']) ? config['users'] : [];
    const count = team.length;
    const user = nameIn(setup.users, count === 1 ? team[0] : config['user']);
    const to =
      count > 1
        ? plural(count, { one: 'Assign in turn to # person', other: 'Assign in turn to # people' })
        : user === undefined
          ? undefined
          : t`Assign to ${user}`;
    return to === undefined || config['onlyIfUnassigned'] !== true
      ? to
      : t`${to}, only when unassigned`;
  },
  'owner.remove': () => t`Remove the contact's owner`,
  'dnd.set': (config) => {
    if (
      (config['action'] !== 'enable' && config['action'] !== 'disable') ||
      filled(config['reason']) === undefined
    )
      return undefined;
    if (config['direction'] === 'inbound')
      return config['action'] === 'disable'
        ? t`Clear inbound do not disturb`
        : t`Enable inbound do not disturb`;
    const channel = dndChannelWords(config['channel']);
    if (channel === undefined) return undefined;
    return config['action'] === 'disable'
      ? t`Clear do not disturb for ${channel}`
      : t`Enable do not disturb for ${channel}`;
  },
  'followers.add': (config, setup) => {
    const people = namesIn(setup.users, config['users'], 'conjunction');
    return people === undefined ? undefined : t`Add ${people} as followers`;
  },
  'followers.remove': (config, setup) => {
    if (config['all'] === true) return t`Remove every follower`;
    const people = namesIn(setup.users, config['users'], 'conjunction');
    return people === undefined ? undefined : t`Remove ${people} as followers`;
  },
  'note.create': (config) => {
    const text = excerpt(config['text']);
    return text === undefined ? undefined : t`Write the note ${text}`;
  },
  'tag.add': (config, setup) => {
    const tag = nameIn(setup.tags, config['tag']);
    return tag === undefined ? undefined : t`Add the tag ${tag}`;
  },
  'tag.remove': (config, setup) => {
    const tag = nameIn(setup.tags, config['tag']);
    return tag === undefined ? undefined : t`Remove the tag ${tag}`;
  },
  'ai.ask': (config) => {
    const prompt = excerpt(config['prompt']);
    return prompt === undefined ? undefined : t`Ask AI ${prompt}`;
  },
  'ai.classify': (config) => {
    const categories: readonly unknown[] = Array.isArray(config['categories'])
      ? config['categories']
      : [];
    const names = categories.filter((category) => typeof category === 'string');
    if (names.length < 2) return undefined;
    const choices = listed(names, 'disjunction');
    return t`Sort their last reply into ${choices}`;
  },
  'ai.draft_reply': (config) => {
    const instructions = excerpt(config['instructions']);
    return instructions === undefined
      ? t`Draft a reply with AI`
      : t`Draft a reply with AI, told ${instructions}`;
  },
  'webhook.call': (config) => {
    const url = filled(config['url']);
    const method = filled(config['method']) ?? 'POST';
    return url === undefined ? undefined : t`Send a ${method} request to ${url}`;
  },
  'automation.run': (config, setup) => {
    const automation = nameIn(setup.automations, config['automation']);
    if (automation === undefined) return undefined;
    const name = quoted(automation);
    return t`Start the automation ${name}`;
  },
  'automation.remove': (config, setup) => {
    const { from } = config;
    if (from === 'current') return t`Remove them from this automation`;
    const named = (given: unknown): string | undefined =>
      namesIn(setup.automations, given, 'conjunction', quoted);
    if (from === 'automations') {
      const names = named(config['automations']);
      return names === undefined ? undefined : t`Remove them from ${names}`;
    }
    if (from !== 'all_others' && from !== 'all') return undefined;
    const kept = named(config['except']);
    if (from === 'all_others')
      return kept === undefined
        ? t`Remove them from every other automation`
        : t`Remove them from every other automation, except ${kept}`;
    return kept === undefined
      ? t`Remove them from every automation, this one too`
      : t`Remove them from every automation, this one too, except ${kept}`;
  },
  'score.modify': (config) => {
    const points = config['points'];
    if (typeof points !== 'number') return undefined;
    return config['calculation'] === 'subtract'
      ? t`Subtract ${points} from their engagement score`
      : t`Add ${points} to their engagement score`;
  },
  'email.verify': (config) => {
    // Left out, a result up to 90 days old is reused (the contract's default).
    const days = typeof config['maxAgeDays'] === 'number' ? config['maxAgeDays'] : 90;
    return plural(days, {
      one: 'Check the primary email (reuse results up to # day old)',
      other: 'Check the primary email (reuse results up to # days old)',
    });
  },
};

/** The step types that have a label and a summary here: every one the document can hold. */
export const summarizedStepTypes: readonly string[] = Object.keys(stepSummaries);

/** What a step type is called, such as "Send text"; nothing for a type this version lacks. */
export function stepLabel(type: string): string | undefined {
  return has(stepLabels, type) ? stepLabels[type]() : undefined;
}

/** What a step does, in a sentence; nothing when its settings aren't filled in yet. */
export function stepSummary(
  step: { readonly type: string; readonly config: Config },
  setup: AutomationSetup,
): string | undefined {
  return has(stepSummaries, step.type) ? stepSummaries[step.type](step.config, setup) : undefined;
}

/** What to call one step when another refers to it: its own label, or what it does. */
export function stepName(
  step: {
    readonly id: string;
    readonly type: string;
    readonly config: Config;
    readonly label: string | undefined;
  },
  setup: AutomationSetup,
): string {
  return step.label ?? stepSummary(step, setup) ?? stepLabel(step.type) ?? step.id;
}

/** The heading of one branch of a step: "If yes", "If time runs out", "Variant a (50%)". */
export function branchLabel(
  step: { readonly type: string; readonly config: Config },
  name: string,
): string {
  if (step.type === 'condition' && Array.isArray(step.config['branches'])) {
    const branches: readonly unknown[] = step.config['branches'];
    const own = branches.find((branch) => isRecord(branch) && branch['name'] === name);
    if (isRecord(own)) {
      const words = quoted(filled(own['label']) ?? name);
      return t`If ${words}`;
    }
    if (name === 'none') return t`If none of them holds`;
  }
  if (step.type === 'condition' && name === 'yes') return t`If yes`;
  if (step.type === 'condition' && name === 'no') return t`If no`;
  if (step.type === 'wait.event' && name === 'received') return t`If it happens in time`;
  if (step.type === 'wait.event' && name === 'timed_out') return t`If time runs out`;
  if (step.type === 'wait.condition' && name === 'met') return t`If it holds in time`;
  if (step.type === 'wait.condition' && name === 'timed_out') return t`If time runs out`;
  if (step.type === 'wait.appointment' && name === 'reached') return t`When that time comes`;
  if (step.type === 'wait.appointment' && name === 'passed') return t`If that time has passed`;
  if (step.type === 'wait.appointment' && name === 'no_appointment')
    return t`If there is no appointment`;
  if (step.type === 'deal.find' && name === 'found') return t`Found`;
  if (step.type === 'deal.find' && name === 'not_found') return t`Not found`;
  if (step.type === 'split') {
    const variants: readonly unknown[] = Array.isArray(step.config['variants'])
      ? step.config['variants']
      : [];
    const variant = variants.find((item) => isRecord(item) && item['name'] === name);
    if (!isRecord(variant) || typeof variant['percent'] !== 'number') return t`Variant ${name}`;
    const percent = String(variant['percent']);
    return t`Variant ${name} (${percent}%)`;
  }
  const branch = quoted(name);
  return step.type === 'ai.classify' ? t`If it's ${branch}` : t`Branch ${branch}`;
}

const weekdays: Readonly<Record<string, () => string>> = {
  monday: () => t`Every Monday`,
  tuesday: () => t`Every Tuesday`,
  wednesday: () => t`Every Wednesday`,
  thursday: () => t`Every Thursday`,
  friday: () => t`Every Friday`,
  saturday: () => t`Every Saturday`,
  sunday: () => t`Every Sunday`,
};

const channels: Readonly<Record<string, () => string>> = {
  email: () => t`A contact sends an email`,
  sms: () => t`A contact sends a text`,
  whatsapp: () => t`A contact sends a WhatsApp message`,
  webchat: () => t`A contact sends a web chat message`,
};

const triggerLabels: Readonly<Record<AutomationTriggerType, () => string>> = {
  'form.submitted': () => t`Form submitted`,
  'message.received': () => t`Message received`,
  'appointment.booked': () => t`Appointment booked`,
  'appointment.status_changed': () => t`Appointment status changed`,
  'deal.stage_changed': () => t`Opportunity stage changed`,
  'deal.closed': () => t`Opportunity closed`,
  'contact.created': () => t`Contact created`,
  'contact.dnd_changed': () => t`Contact DND`,
  'contact.score_changed': () => t`Contact Engagement Score`,
  'field.changed': () => t`Field changed`,
  'tag.added': () => t`Tag added`,
  'tag.removed': () => t`Tag removed`,
  'task.created': () => t`Task created`,
  'task.completed': () => t`Task completed`,
  'task.reminder': () => t`Task reminder`,
  'note.created': () => t`Note added`,
  'note.updated': () => t`Note changed`,
  'quote.sent': () => t`Quote sent`,
  'quote.accepted': () => t`Quote accepted`,
  'quote.declined': () => t`Quote declined`,
  'invoice.issued': () => t`Invoice issued`,
  'invoice.sent': () => t`Invoice sent`,
  'invoice.paid': () => t`Invoice paid`,
  'payment.recorded': () => t`Payment recorded`,
  'trigger_link.clicked': () => t`Trigger link clicked`,
  'automation.run_ended': () => t`Automation run ended`,
  'date.reached': () => t`Date reached`,
  'webhook.received': () => t`Webhook received`,
  schedule: () => t`Schedule`,
};

/** How a run ended, completing "A contact's run of X". */
const runEndings: Readonly<Record<'stopped' | 'removed' | 'completed' | 'failed', () => string>> = {
  stopped: () => t`is stopped by one of its stop conditions`,
  removed: () => t`is ended by a “Remove from automations” action`,
  completed: () => t`reaches its end`,
  failed: () => t`fails`,
};

/** Each completes "Starts when": "a contact is created" is written as its own sentence. */
const triggerSummaries: Readonly<Record<AutomationTriggerType, Summarize>> = {
  'form.submitted': (config, setup) => {
    const form = nameIn(setup.forms, config['form']);
    const name = quoted(form ?? '');
    // A trigger that names no form starts on every form.
    const sent = form === undefined ? t`Someone submits a form` : t`Someone submits ${name}`;
    const arrived = arrivalFilterWords(config, (parts) => listed(parts, 'disjunction'));
    return arrived === undefined ? sent : `${sent}, ${arrived}`;
  },
  'message.received': (config, setup) => {
    const channel = filled(config['channel']);
    const sent = channel === undefined ? t`A contact sends a message` : channels[channel]?.();
    const to = namesIn(setup.automations, config['repliedTo'], 'disjunction', quoted);
    return sent === undefined || to === undefined ? sent : t`${sent}, in reply to ${to}`;
  },
  'appointment.booked': (config, setup) => {
    const calendar = nameIn(setup.calendars, config['calendar']);
    const booked =
      calendar === undefined
        ? t`Someone books an appointment`
        : t`Someone books an appointment on ${calendar}`;
    const arrived = arrivalFilterWords(config, (parts) => listed(parts, 'disjunction'));
    return arrived === undefined ? booked : `${booked}, ${arrived}`;
  },
  'appointment.status_changed': (config, setup) => {
    const calendar = nameIn(setup.calendars, config['calendar']);
    const status = filled(config['status']);
    const to = quoted(status ?? '');
    const change =
      status === undefined
        ? t`An appointment's status changes`
        : t`An appointment's status changes to ${to}`;
    return calendar === undefined ? change : t`${change}, on ${calendar}`;
  },
  'deal.stage_changed': (config, setup) => {
    const pipeline = nameIn(setup.pipelines, config['pipeline']);
    const stage = nameIn(stagesOf(setup), config['stage']);
    const change =
      stage === undefined
        ? t`An opportunity moves to another stage`
        : t`An opportunity moves to ${stage}`;
    return pipeline === undefined ? change : t`${change}, in ${pipeline}`;
  },
  'deal.closed': (config, setup) => {
    const pipeline = nameIn(setup.pipelines, config['pipeline']);
    const change =
      config['outcome'] === 'won'
        ? t`An opportunity is won`
        : config['outcome'] === 'lost'
          ? t`An opportunity is lost`
          : t`An opportunity is won or lost`;
    return pipeline === undefined ? change : t`${change}, in ${pipeline}`;
  },
  'contact.created': () => t`A contact is created`,
  'contact.dnd_changed': (config) => {
    const turned =
      config['flag'] === 'enabled'
        ? t`turned on`
        : config['flag'] === 'disabled'
          ? t`turned off`
          : t`turned on or off`;
    if (config['direction'] === 'inbound')
      return t`A contact's inbound do not disturb is ${turned}`;
    const channel =
      config['channel'] === undefined ? undefined : dndChannelWords(config['channel']);
    return channel === undefined
      ? t`A contact's do not disturb is ${turned}`
      : t`A contact's do not disturb for ${channel} is ${turned}`;
  },
  'contact.score_changed': (config) => {
    const score = config['score'];
    if (typeof score !== 'number') return t`A contact's engagement score changes`;
    switch (config['operator']) {
      case 'equals':
        return t`A contact's engagement score is ${score}`;
      case 'not_equals':
        return t`A contact's engagement score is not ${score}`;
      case 'gt':
        return t`A contact's engagement score is greater than ${score}`;
      case 'gte':
        return t`A contact's engagement score is at least ${score}`;
      case 'lt':
        return t`A contact's engagement score is less than ${score}`;
      case 'lte':
        return t`A contact's engagement score is at most ${score}`;
      default:
        return t`A contact's engagement score changes`;
    }
  },
  'field.changed': (config) => {
    const field = fieldWords(config['field']);
    if (field === undefined) return undefined;
    const to = valueWords(config['to']);
    return config['to'] === undefined
      ? t`A contact's ${field} changes`
      : t`A contact's ${field} changes to ${to}`;
  },
  'tag.added': (config, setup) => {
    const tag = nameIn(setup.tags, config['tag']);
    return tag === undefined ? undefined : t`The tag ${tag} is added to a contact`;
  },
  'tag.removed': (config, setup) => {
    const tag = nameIn(setup.tags, config['tag']);
    return tag === undefined ? undefined : t`The tag ${tag} is removed from a contact`;
  },
  'task.created': () => t`A task is created for a contact`,
  'task.completed': () => t`A contact's task is completed`,
  'task.reminder': () => t`A contact's task comes due`,
  'note.created': () => t`A note is added to a contact`,
  'note.updated': () => t`A contact's note is changed`,
  'quote.sent': () => t`A quote is sent`,
  'quote.accepted': () => t`A quote is accepted`,
  'quote.declined': () => t`A quote is declined`,
  'invoice.issued': () => t`An invoice is issued`,
  'invoice.sent': () => t`An invoice is sent`,
  'invoice.paid': () => t`An invoice is paid in full`,
  'payment.recorded': () => t`A payment is recorded`,
  'trigger_link.clicked': (config, setup) => {
    const link = nameIn(setup.triggerLinks ?? [], config['link']);
    return link === undefined ? undefined : t`A contact clicks the trigger link ${link}`;
  },
  'automation.run_ended': (config, setup) => {
    const names = namesIn(setup.automations, config['automations'], 'disjunction', quoted);
    if (names === undefined) return undefined;
    const given: readonly unknown[] = Array.isArray(config['how']) ? config['how'] : [];
    const ways = given.flatMap((each) =>
      typeof each === 'string' && has(runEndings, each) ? [runEndings[each]()] : [],
    );
    const how = listed(ways, 'disjunction');
    const ends =
      ways.length === 0
        ? t`A contact's run of ${names} ends`
        : t`A contact's run of ${names} ${how}`;
    const events: readonly unknown[] = Array.isArray(config['stoppedBy'])
      ? config['stoppedBy']
      : [];
    const stops = events.flatMap((each) => {
      const words = typeof each === 'string' ? stopEventWords(each, undefined) : undefined;
      return words === undefined ? [] : [quoted(words)];
    });
    const by = listed(stops, 'disjunction');
    return stops.length === 0 ? ends : t`${ends}, when what stopped it was ${by}`;
  },
  'date.reached': (config) => {
    const day = dateWords(config);
    if (day === undefined) return undefined;
    return config['repeat'] === 'never' ? t`It is ${day}, that one time` : t`It is ${day}`;
  },
  'webhook.received': () => t`An outside app calls this automation's webhook address`,
  schedule: (config) => {
    const at = filled(config['at']);
    if (at === undefined) return undefined;
    if (config['every'] === 'day') return t`Every day at ${at}`;
    if (config['every'] === 'week') {
      const day = weekdays[filled(config['weekday']) ?? '']?.();
      return day === undefined ? undefined : t`${day} at ${at}`;
    }
    if (config['every'] !== 'month' || typeof config['day'] !== 'number') return undefined;
    const day = String(config['day']);
    return t`On day ${day} of every month at ${at}`;
  },
};

export const summarizedTriggerTypes: readonly string[] = Object.keys(triggerSummaries);

export function triggerLabel(type: string): string | undefined {
  return has(triggerLabels, type) ? triggerLabels[type]() : undefined;
}

/** What starts the automation, completing "Starts when"; with its condition, if it has one. */
export function triggerSummary(
  trigger: { readonly type: string; readonly config: Config; readonly condition?: unknown },
  setup: AutomationSetup,
): string | undefined {
  if (!has(triggerSummaries, trigger.type)) return undefined;
  const summary = triggerSummaries[trigger.type](trigger.config, setup);
  const check = conditionWords(trigger.condition, false, setup);
  return summary === undefined || check === undefined
    ? summary
    : t`${summary}, but only if ${check}`;
}

export const summarizedStopEvents: readonly string[] = stopEvents;

/** What ends the automation for a contact, completing "Stops as soon as". */
export function stopSummary(stop: {
  readonly event: string;
  readonly from: string | undefined;
  readonly condition?: unknown;
  readonly repliedTo?: string | undefined;
}): string | undefined {
  const summary = stopEventWords(stop.event, stop.from, stop.repliedTo);
  if (summary === undefined) return undefined;
  const check = conditionWords(stop.condition);
  return check === undefined ? summary : t`${summary}, but only if ${check}`;
}
