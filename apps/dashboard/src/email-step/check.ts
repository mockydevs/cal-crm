// A Send email action as it is saved from its panel, and what it still lacks, in words.
// Fetched with the panel, and asked when the action is saved.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { missingEmailParts, savedEmailConfig, type MissingPart } from './config';

const words: Readonly<Record<MissingPart, MessageDescriptor>> = {
  subject: msg`Give the email a subject.`,
  body: msg`Write the message, or choose a template.`,
  template: msg`Choose a template, or write the email with Quick compose.`,
};

/** The settings to save, and what is missing from them by the member it is said under. */
export function emailSubmit(config: Readonly<Record<string, unknown>>): {
  readonly config: Record<string, unknown>;
  readonly problems: Record<string, string>;
} {
  const saved = savedEmailConfig(config);
  return {
    config: saved,
    problems: Object.fromEntries(
      missingEmailParts(saved).map((part) => [part, i18n._(words[part])]),
    ),
  };
}
