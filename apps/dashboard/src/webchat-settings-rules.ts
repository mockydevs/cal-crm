// What the web chat settings form does with what someone typed, apart from the screen:
// the websites box as a list, and the API's issues sorted under the form's own fields.
import type { WebchatWidget, WebchatWidgetInput } from '@repo/contracts';
import type { Issue } from './problems';

/** The form's values, as its controls hold them. */
export interface WidgetDraft {
  readonly name: string;
  /** One website a line, as typed. */
  readonly websites: string;
  readonly enabled: boolean;
  readonly title: string;
  readonly greeting: string;
  readonly emailRequired: boolean;
  /** Whether the form shows visitors a marketing box at all. */
  readonly offerMarketing: boolean;
  readonly marketingWording: string;
}

/**
 * A new widget's form: on, asking for an email address, with no marketing box. The two
 * texts visitors read start as the caller gives them, in the language of whoever sets it up.
 */
export function emptyDraft(title: string, greeting: string): WidgetDraft {
  return {
    name: '',
    websites: '',
    enabled: true,
    title,
    greeting,
    emailRequired: true,
    offerMarketing: false,
    marketingWording: '',
  };
}

export function draftOf(widget: WebchatWidget): WidgetDraft {
  const wording = widget.settings.marketingConsentWording;
  return {
    name: widget.name,
    websites: widget.allowedOrigins.join('\n'),
    enabled: widget.enabled,
    title: widget.settings.title,
    greeting: widget.settings.greeting,
    emailRequired: widget.settings.emailRequired,
    offerMarketing: wording !== null,
    marketingWording: wording ?? '',
  };
}

/** The websites box as a list: one a line, without the spaces around each or empty lines. */
export function websiteLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** What the API takes for a draft. It is checked by the API's own schema before it is sent. */
export function inputOf(draft: WidgetDraft): Record<keyof WebchatWidgetInput, unknown> {
  return {
    name: draft.name,
    allowedOrigins: websiteLines(draft.websites),
    enabled: draft.enabled,
    settings: {
      title: draft.title,
      greeting: draft.greeting,
      emailRequired: draft.emailRequired,
      // No box, no wording: a chat can then never record marketing consent.
      marketingConsentWording: draft.offerMarketing ? draft.marketingWording : null,
    },
  };
}

/** The form's field for each place the API can find something wrong. */
const FIELDS: Readonly<Record<string, keyof WidgetDraft>> = {
  '/name': 'name',
  '/allowedOrigins': 'websites',
  '/settings/title': 'title',
  '/settings/greeting': 'greeting',
  '/settings/marketingConsentWording': 'marketingWording',
};

export interface WidgetProblem {
  /** What's wrong with each field, by the form's own name for it. */
  readonly fields: Partial<Record<keyof WidgetDraft, string>>;
  /** What's wrong that no field shows. */
  readonly form: string | undefined;
}

export const noWidgetProblem: WidgetProblem = { fields: {}, form: undefined };

/**
 * Sorts the API's issues under the form's fields: the first for each field. An issue with
 * one website (/allowedOrigins/2) goes under the websites box with the address it is about
 * (`about` writes that sentence in the reader's language), since the box has many.
 */
export function widgetProblem(
  issues: readonly Issue[],
  websites: string,
  about: (website: string, message: string) => string,
): WidgetProblem {
  const typed = websiteLines(websites);
  const fields: Partial<Record<keyof WidgetDraft, string>> = {};
  let form: string | undefined;
  for (const issue of issues) {
    const website = /^\/allowedOrigins\/(\d+)$/.exec(issue.path);
    const index = website === null ? undefined : Number(website[1]);
    const field = index === undefined ? FIELDS[issue.path] : 'websites';
    if (field === undefined) {
      form ??= issue.message;
      continue;
    }
    const address = index === undefined ? undefined : typed[index];
    fields[field] ??= address === undefined ? issue.message : about(address, issue.message);
  }
  return { fields, form };
}
