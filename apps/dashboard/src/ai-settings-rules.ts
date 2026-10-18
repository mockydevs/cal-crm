// What Settings → AI models works out before it draws anything: the name a model is shown
// by, how an amount is written, what a person sends to save, and the plain words for each
// way a test of a connection can end. Nothing here asks the API anything.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type {
  AiAddressProblem,
  AiConnection,
  AiJobKey,
  AiProviderKey,
  AiSettings,
  AiTestOutcome,
  UpdateAiSettingsInput,
} from '@repo/contracts';

/** The providers Settings lists, in the canvas's order. */
export const PROVIDERS: readonly AiProviderKey[] = ['anthropic', 'openai', 'openai_compatible'];

export const providerNames: Readonly<Record<AiProviderKey, MessageDescriptor>> = {
  anthropic: msg`Anthropic`,
  openai: msg`OpenAI`,
  openai_compatible: msg`Your own model server`,
};

/**
 * Claude's models by the names Anthropic gives them. Any other model is shown by its id:
 * the dashboard does not guess what a provider calls a model.
 */
const FABLE = 'Claude Fable 5.1';
const OPUS = 'Claude Opus 5.5';
const SONNET = 'Claude Sonnet 5.5';
const HAIKU = 'Claude Haiku 4.5';
const CLAUDE_NAMES: Readonly<Record<string, string>> = {
  'claude-fable-5-1': FABLE,
  'claude-opus-5-5': OPUS,
  'claude-sonnet-5-5': SONNET,
  'claude-haiku-4-5': HAIKU,
  'claude-haiku-4-5-20251001': HAIKU,
};

/** A model as people read it: its name when it has one, its id otherwise. */
export function modelName(provider: string, model: string): string {
  return provider === 'anthropic' ? (CLAUDE_NAMES[model] ?? model) : model;
}

/** Claude's models, as the provider's row lists them once a key is connected. */
export const CLAUDE_MODEL_NAMES: readonly string[] = [OPUS, SONNET, HAIKU];

export const jobNames: Readonly<Record<AiJobKey, MessageDescriptor>> = {
  automation_builder: msg`Building automations`,
  replies: msg`Replies and messages`,
  briefings: msg`Briefings and reports`,
  sorting: msg`Sorting and filling fields`,
};

export const jobDescriptions: Readonly<Record<AiJobKey, MessageDescriptor>> = {
  automation_builder: msg`Writes and changes automations when you ask`,
  replies: msg`Drafts replies in Conversations and campaign emails`,
  briefings: msg`Writes your Dashboard briefing and answers questions about your data`,
  sorting: msg`Tags conversations, fills in fields and spots duplicates`,
};

/** A job as "Recent calls" names it, a test included; undefined for one it does not know. */
export function jobLabel(job: string): MessageDescriptor | undefined {
  if (job === 'connection_test') return msg`Connection test`;
  return Object.hasOwn(jobNames, job) ? jobNames[job as AiJobKey] : undefined;
}

/** One value for a provider's model, for a select. A provider's key has no slash in it. */
export const choiceOf = (provider: string, model: string): string => `${provider}/${model}`;

/** The provider and model a select's value names, or undefined for none. */
export function parseChoice(
  value: string,
): { readonly provider: AiProviderKey; readonly model: string } | undefined {
  const slash = value.indexOf('/');
  if (slash < 1) return undefined;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  return isProvider(provider) && model !== '' ? { provider, model } : undefined;
}

export const isProvider = (provider: string): provider is AiProviderKey =>
  (PROVIDERS as readonly string[]).includes(provider);

/**
 * What is sent to save: everything as it is, with what the person changed. A job on its
 * default stays on its default, and a model on a provider there is no adapter for is left
 * to the default too, since the API would not take it back.
 */
export function settingsInput(
  settings: AiSettings,
  change: Partial<Omit<UpdateAiSettingsInput, 'revision'>> = {},
): UpdateAiSettingsInput {
  const jobs: UpdateAiSettingsInput['jobs'] = {
    automation_builder: null,
    replies: null,
    briefings: null,
    sorting: null,
  };
  for (const job of settings.jobs)
    if (!job.isDefault && isProvider(job.provider))
      jobs[job.job] = { provider: job.provider, model: job.model };
  const { backup } = settings;
  return {
    enabled: settings.enabled,
    keySource: settings.keySource,
    monthlyLimit: settings.monthlyLimit === null ? null : plainAmount(settings.monthlyLimit),
    atLimit: settings.atLimit,
    maskContactDetails: settings.maskContactDetails,
    requestLogDays: settings.requestLogDays,
    backup:
      backup !== null && isProvider(backup.provider)
        ? { provider: backup.provider, model: backup.model }
        : null,
    jobs,
    ...change,
    revision: settings.revision,
  };
}

/** An amount without the zeros nobody typed: 50.0000 is 50, 12.5000 is 12.50. */
export function plainAmount(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  const kept = fraction.replace(/0+$/, '');
  if (kept === '') return whole;
  return `${whole}.${kept.length === 1 ? `${kept}0` : kept}`;
}

/**
 * An amount of dollars for people. A month's spend has two places; the cost of one call is
 * often a fraction of a cent, so it keeps up to four, and anything smaller that is not
 * nothing says so rather than rounding to $0.00.
 */
export function formatDollars(amount: string, locale: string): string {
  const value = Number(amount);
  const format = (digits: number, of: number): string =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    }).format(of);
  if (value === 0 || value >= 0.01) return format(value >= 1 ? 2 : 4, value);
  return value < 0.0001 ? `<${format(4, 0.0001)}` : format(4, value);
}

/** How much of the limit is spent, from 0 to 100, for the bar. */
export function percentOf(spent: string, limit: string): number {
  const of = Number(limit);
  if (of <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((Number(spent) / of) * 100)));
}

/** Seconds a provider took, to a tenth, as "0.8". */
export function secondsOf(latencyMs: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(latencyMs / 1000);
}

/**
 * The host and port of an address someone typed, as whoever runs the install would list
 * them in AI_LOCAL_SERVERS, or undefined when it is not an address. It is worked out from
 * what was typed, in the browser: the page never learns what the install has listed.
 */
export function hostAndPort(address: string): string | undefined {
  if (!URL.canParse(address.trim())) return undefined;
  const url = new URL(address.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.hostname === '') return undefined;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return `${url.hostname}:${port}`;
}

/** The API's code for a refused address, as the reason it names; undefined for any other. */
export function addressProblem(code: string): AiAddressProblem | undefined {
  const reasons: readonly AiAddressProblem[] = [
    'not_a_url',
    'not_https',
    'has_credentials',
    'port_not_allowed',
    'has_query',
  ];
  return reasons.find((reason) => code === `address_${reason}`);
}

/** Whether the person who runs the install could let a refused address through. */
export const operatorCanAllow = (problem: AiAddressProblem): boolean =>
  problem === 'not_https' || problem === 'port_not_allowed';

/** What went wrong with an address, in the page's own words. */
export const addressProblemText: Readonly<Record<AiAddressProblem, MessageDescriptor>> = {
  not_a_url: msg`That isn't a web address. It should look like https://models.example.com/v1.`,
  not_https: msg`This install can't call that address. It calls addresses that start with https://, and model servers that whoever runs the install has listed.`,
  has_credentials: msg`Leave the user name and password out of the address. If the server needs a key, it goes in the key field.`,
  port_not_allowed: msg`This install can't call that port. It calls the standard https port, and model servers that whoever runs the install has listed.`,
  has_query: msg`Leave out everything after the path: no ? and no #.`,
};

export interface OutcomeText {
  /** What happened. */
  readonly what: MessageDescriptor;
  /** What to do about it, when something can be done. */
  readonly fix?: MessageDescriptor;
}

/**
 * Each way a test can end, in plain words, with what to do. "ok" is said with how long the
 * provider took, by the page.
 */
export const outcomeText: Readonly<Record<Exclude<AiTestOutcome, 'ok'>, OutcomeText>> = {
  authentication: {
    what: msg`The provider didn't accept this key.`,
    fix: msg`Check that the whole key was copied and that it hasn't been revoked, then replace it.`,
  },
  billing: {
    what: msg`The provider says this account can't be charged: it has no credit, or a payment problem.`,
    fix: msg`Add credit or fix the payment with the provider, then test again.`,
  },
  rate_limited: {
    what: msg`The provider is turning requests away: the key has reached a rate limit or the account's own spending cap.`,
    fix: msg`Wait a minute and test again. If it keeps happening, check the limits on the provider's account.`,
  },
  unavailable: {
    what: msg`We couldn't reach the provider, or it was too busy to answer.`,
    fix: msg`Test again in a moment. For your own server, check that it is running and that this install can reach it.`,
  },
  timeout: {
    what: msg`The provider took longer than 30 seconds to answer.`,
    fix: msg`Test again. A model server of your own may still be loading the model.`,
  },
  invalid_request: {
    what: msg`The provider refused the request.`,
    fix: msg`Check the model's name. If you set a spending limit in the provider's own account, it may have been reached.`,
  },
  invalid_response: {
    what: msg`The server answered, but not in the way the OpenAI API does.`,
    fix: msg`Check that the address ends where the server's API starts. For Ollama that is /v1.`,
  },
  blocked_address: {
    what: msg`This install isn't allowed to call that address.`,
    fix: msg`An address must be a public https one, or a model server that whoever runs the install has listed in AI_LOCAL_SERVERS with the same host and port.`,
  },
  not_found: {
    what: msg`The provider has nothing by that name.`,
    fix: msg`Check the model's name: it must be exactly as the provider lists it. For your own server, also check the address.`,
  },
  limit_reached: {
    what: msg`Not tested: this month's AI spending limit has been reached, so no call was made.`,
    fix: msg`Raise the limit, then test again.`,
  },
  price_unknown: {
    what: msg`Not tested: this model has no price, and your limit pauses AI, so no call was made.`,
    fix: msg`A price is set for the whole agency, and it can be zero for a server of your own. Or choose "Keep going" at the limit.`,
  },
  ai_off: {
    what: msg`Not tested: AI is turned off for this business.`,
    fix: msg`Turn AI back on under Privacy, then test again.`,
  },
  key_unreadable: {
    what: msg`The saved key couldn't be opened.`,
    fix: msg`Replace the key.`,
  },
  not_supported: { what: msg`This provider can't be used in this version yet.` },
  no_model: {
    what: msg`This connection has no model to test with.`,
    fix: msg`Add the model's name.`,
  },
  expired: {
    what: msg`The test wasn't run within two minutes.`,
    fix: msg`The part of this install that does background work may not be running. Ask whoever runs the install, then test again.`,
  },
};

/**
 * Why a call failed, from the category kept with it: the same words a test uses, and one
 * more for a call whose worker stopped before it finished. Undefined for a category this
 * version does not know.
 */
export function failureText(errorCode: string | null): MessageDescriptor | undefined {
  if (errorCode === null) return undefined;
  if (errorCode === 'abandoned') return msg`The call was cut off before it finished.`;
  return Object.hasOwn(outcomeText, errorCode)
    ? outcomeText[errorCode as Exclude<AiTestOutcome, 'ok'>].what
    : undefined;
}

/** The connection of a provider that is the page's own to manage, if there is one. */
export function ownConnection(
  connections: readonly AiConnection[],
  provider: AiProviderKey,
): AiConnection | undefined {
  return connections.find((each) => each.provider === provider && each.canManage);
}

/**
 * The provider the backup shares with every job, when it does: one provider's outage would
 * then stop everything. Undefined when there is no backup, or the jobs are on more than one
 * provider, or the backup is on another.
 */
export function sharedProvider(settings: AiSettings): string | undefined {
  const { backup } = settings;
  if (backup === null) return undefined;
  return settings.jobs.every((job) => job.provider === backup.provider)
    ? backup.provider
    : undefined;
}
