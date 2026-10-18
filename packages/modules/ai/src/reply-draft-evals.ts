// The eval suite of the inbox agent's reply drafts. It runs the
// job's own code: draftReply builds the prompt and reads the answer here exactly as it does
// in the worker, so a changed word of the prompt makes every recorded run stale. The cases
// are in evals/suites/replies/cases.json.
//
// A case's input is one conversation as the job is given it. Only what a case is about
// needs writing: a contact with nothing known about them, a business with no knowledge
// written down, and a thread on one channel are the defaults.
import { replyChannels, type ReplyChannel } from '@repo/contracts';

import type { SuiteDefinition } from './evals/types.js';
import { isRecord, type JsonRecord } from './json.js';
import {
  draftReply,
  REPLY_PROMPT_VERSION,
  type ReplyDraftInput,
  type ReplyDraftKnowledge,
  type ReplyDraftMessage,
} from './reply-draft.js';

/** The share of cases a model must pass to be called Tested for replies. */
export const REPLIES_THRESHOLD = 0.9;

/** A case's input does not describe a conversation: the suite, not the model, is at fault. */
class CaseInputError extends Error {}

const refuse = (what: string): never => {
  throw new CaseInputError(`A replies case's input ${what}.`);
};

const text = (value: unknown, name: string): string =>
  typeof value === 'string' && value !== '' ? value : refuse(`needs ${name} as text`);
const textOrNull = (value: unknown, name: string): string | null =>
  value === undefined || value === null ? null : text(value, name);
const record = (value: unknown, name: string): JsonRecord =>
  isRecord(value) ? value : refuse(`needs ${name} as an object`);
const list = (value: unknown, name: string): readonly unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : refuse(`needs ${name} as a list`);

function messageOf(value: unknown, index: number, channel: ReplyChannel): ReplyDraftMessage {
  const message = record(value, `message ${String(index + 1)}`);
  const from = message['from'];
  if (from !== 'contact' && from !== 'business')
    return refuse(`has a message from neither the contact nor the business`);
  return {
    from,
    channel: textOrNull(message['channel'], 'a message’s channel') ?? channel,
    subject: textOrNull(message['subject'], 'a message’s subject'),
    text: text(message['text'], 'a message’s text'),
    // A case that gives no time is a minute after the one before it, on a fixed day.
    at:
      textOrNull(message['at'], 'a message’s time') ??
      new Date(Date.UTC(2026, 9, 9, 9, index)).toISOString(),
  };
}

/** The conversation a case describes, as the job is given one. */
export function replyInputOf(input: JsonRecord): ReplyDraftInput {
  const business = record(input['business'], 'the business');
  const contact = input['contact'] === undefined ? {} : record(input['contact'], 'the contact');
  const channel = replyChannels.find((each) => each === (input['channel'] ?? 'email'));
  if (channel === undefined) return refuse('names a channel no reply goes out on');
  const messages = list(input['messages'], 'the messages').map((message, index) =>
    messageOf(message, index, channel),
  );
  if (messages.at(-1)?.from !== 'contact')
    return refuse('must end with a message from the contact');
  return {
    business: {
      name: text(business['name'], 'the business’s name'),
      locale: textOrNull(business['locale'], 'the business’s language') ?? 'en',
    },
    channel,
    contact: {
      firstName: textOrNull(contact['firstName'], 'the contact’s first name'),
      locale: textOrNull(contact['locale'], 'the contact’s language'),
      summary: textOrNull(contact['summary'], 'the contact’s summary'),
      facts: list(contact['facts'], 'the contact’s facts').map((fact) => text(fact, 'a fact')),
    },
    knowledge: list(input['knowledge'], 'the knowledge').map((item): ReplyDraftKnowledge => {
      const knowledge = record(item, 'a piece of knowledge');
      return {
        title: text(knowledge['title'], 'a title for each piece of knowledge'),
        text: text(knowledge['text'], 'the text of each piece of knowledge'),
      };
    }),
    messages,
  };
}

export const repliesSuite: SuiteDefinition = {
  job: 'replies',
  version: REPLY_PROMPT_VERSION,
  threshold: REPLIES_THRESHOLD,
  async run(evalCase, { gateway, context }) {
    const result = await draftReply(gateway, context, replyInputOf(evalCase.input));
    // Whatever the model did, there is an output to score: only a draft has text, so a
    // refusal, or an answer the job would not show a person, fails the checks on the text.
    if (result.outcome === 'drafted') return { outcome: 'drafted', text: result.text };
    return {
      outcome: result.outcome,
      ...('reason' in result ? { reason: result.reason } : {}),
    };
  },
};
