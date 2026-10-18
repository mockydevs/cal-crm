// The eval suite of field extraction and contact memory. It is
// the suite of the gateway's `sorting` job, which is the job extraction runs as. It runs
// the job's own code: extractFromConversation builds the prompt and reads the answer here
// exactly as it does in the worker, so a changed word of the prompt makes every recorded
// run stale. The cases are in evals/suites/sorting/cases.json.
//
// A case's input is one conversation as the job is given it, with the fields the business
// offers. Only what a case is about needs writing: a contact with nothing known about them,
// no fields, and a thread whose contact messages are all new are the defaults.
//
// What a case is scored on is what the job would propose, and what it had to throw away to
// get there (`discarded`). The second matters: the job throws away what a model should
// never have written, so a model that does what a message told it to still proposes
// nothing, and only `discarded` shows that it tried.
import { fieldValueTypes } from '@repo/contracts';

import type { SuiteDefinition } from './evals/types.js';
import {
  extractFromConversation,
  EXTRACTION_PROMPT_VERSION,
  type ExtractionField,
  type ExtractionInput,
  type ExtractionMessage,
  type FieldScalar,
} from './extraction.js';
import { isRecord, type JsonRecord } from './json.js';

/** The share of cases a model must pass to be called Tested for sorting and filling fields. */
export const EXTRACTION_THRESHOLD = 0.9;

/** A case's input does not describe a reading: the suite, not the model, is at fault. */
class CaseInputError extends Error {}

const refuse = (what: string): never => {
  throw new CaseInputError(`A sorting case's input ${what}.`);
};

const text = (value: unknown, name: string): string =>
  typeof value === 'string' && value !== '' ? value : refuse(`needs ${name} as text`);
const textOrNull = (value: unknown, name: string): string | null =>
  value === undefined || value === null ? null : text(value, name);
const record = (value: unknown, name: string): JsonRecord =>
  isRecord(value) ? value : refuse(`needs ${name} as an object`);
const list = (value: unknown, name: string): readonly unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : refuse(`needs ${name} as a list`);

function scalarOrNull(value: unknown): FieldScalar | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.every((each) => typeof each === 'string'))
    return value.map(String);
  return refuse('has a field whose current value is not text, yes or no, or a list of keys');
}

function fieldOf(value: unknown): ExtractionField {
  const field = record(value, 'each field');
  const key = text(field['key'], 'a key for each field');
  const valueType = fieldValueTypes.find((each) => each === (field['type'] ?? 'text'));
  if (valueType === undefined) return refuse('has a field of a type no field has');
  return {
    key,
    label: textOrNull(field['label'], 'a field’s label') ?? key,
    description: textOrNull(field['description'], 'a field’s description') ?? `The ${key}.`,
    valueType,
    options: list(field['options'], 'a field’s options').map((each) => {
      const option = record(each, 'each option');
      const optionKey = text(option['key'], 'a key for each option');
      return {
        key: optionKey,
        label: textOrNull(option['label'], 'an option’s label') ?? optionKey,
      };
    }),
    currency: textOrNull(field['currency'], 'a field’s currency'),
    current: scalarOrNull(field['current']),
  };
}

function messageOf(value: unknown, index: number): ExtractionMessage {
  const message = record(value, `message ${String(index + 1)}`);
  const from = message['from'];
  if (from !== 'contact' && from !== 'business')
    return refuse('has a message from neither the contact nor the business');
  const isNew = message['new'] ?? from === 'contact';
  if (typeof isNew !== 'boolean') return refuse('has a message whose "new" is not yes or no');
  if (isNew && from !== 'contact') return refuse('marks a message of the business as new');
  return {
    from,
    isNew,
    channel: textOrNull(message['channel'], 'a message’s channel') ?? 'email',
    subject: textOrNull(message['subject'], 'a message’s subject'),
    text: text(message['text'], 'a message’s text'),
    // A case that gives no time is a minute after the one before it, on a fixed day.
    at:
      textOrNull(message['at'], 'a message’s time') ??
      new Date(Date.UTC(2026, 9, 9, 9, index)).toISOString(),
  };
}

/** The reading a case describes, as the job is given one. */
export function extractionInputOf(input: JsonRecord): ExtractionInput {
  const business = record(input['business'], 'the business');
  const contact = input['contact'] === undefined ? {} : record(input['contact'], 'the contact');
  const messages = list(input['messages'], 'the messages').map(messageOf);
  if (!messages.some((message) => message.isNew))
    return refuse('must have a new message from the contact to read');
  const fields = list(input['fields'], 'the fields').map(fieldOf);
  if (new Set(fields.map((field) => field.key)).size !== fields.length)
    return refuse('has two fields with one key');
  return {
    business: {
      name: text(business['name'], 'the business’s name'),
      locale: textOrNull(business['locale'], 'the business’s language') ?? 'en',
    },
    contact: {
      firstName: textOrNull(contact['firstName'], 'the contact’s first name'),
      knownFacts: list(contact['knownFacts'], 'what is known').map((fact) => text(fact, 'a fact')),
    },
    fields,
    messages,
  };
}

export const sortingSuite: SuiteDefinition = {
  job: 'sorting',
  version: EXTRACTION_PROMPT_VERSION,
  threshold: EXTRACTION_THRESHOLD,
  async run(evalCase, { gateway, context }) {
    const result = await extractFromConversation(
      gateway,
      context,
      extractionInputOf(evalCase.input),
    );
    // Whatever the model did, there is an output to score: only an answer of the job's own
    // shape is read, so a refusal, or words in place of JSON, fails the checks on a reading.
    if (result.outcome !== 'read')
      return {
        outcome: result.outcome,
        ...('reason' in result ? { reason: result.reason } : {}),
      };
    const { fields, facts, discarded } = result.extraction;
    // Lists are written as text, with commas: a case then says "these and no others" with
    // one `equals`, and a run's report holds nothing a formatter would lay out differently.
    return {
      outcome: 'read',
      // The value by field; the keys of several choices in order.
      fields: Object.fromEntries(
        fields.map((field) => [
          field.key,
          typeof field.value === 'object' ? [...field.value].sort().join(',') : field.value,
        ]),
      ),
      fieldKeys: fields
        .map((field) => field.key)
        .sort()
        .join(','),
      factCount: facts.length,
      // Every fact as one text, for a case that says what no fact may mention.
      factText: facts.map((fact) => fact.statement).join('\n'),
      // Why anything was thrown away, in the order it was: empty when nothing was. A model
      // that writes what it should not shows here.
      discarded: discarded.join(','),
    };
  },
};
