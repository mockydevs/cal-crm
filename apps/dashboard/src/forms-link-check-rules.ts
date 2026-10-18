// "Check a link" on a form's card (forms-link-check.tsx): what is pasted as the request
// the API takes (previewLeadSource), and its answer as what the card shows. The API reads
// the address exactly as a submission would; nothing here decides a lead source.
import {
  leadSourceRuleDescriptions,
  previewLeadSourceInput,
  type LeadSourcePreview,
  type PreviewLeadSourceInput,
} from '@repo/contracts';
import { platformsOf } from './click-id-platforms';

/**
 * What was pasted, as an address someone could land on. People copy links without the
 * "https://" in front ("www.example.com/offer?utm_source=…"): it is put back, so the link
 * is read as the browser would read it.
 */
export function addressOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export type LinkCheckRequest =
  | { readonly ok: true; readonly body: PreviewLeadSourceInput }
  | {
      readonly ok: false;
      /** What is wrong with each box, in the API's own words. */
      readonly problems: { readonly url?: string; readonly referrer?: string };
    };

/**
 * The request for what was pasted, or what is wrong with it. Checked by the API's own
 * schema. With no form named, the answer says nothing of a form.
 */
export function linkCheckRequest(
  url: string,
  referrer: string,
  formId: string | undefined,
): LinkCheckRequest {
  const from = addressOf(referrer);
  const parsed = previewLeadSourceInput.safeParse({
    url: addressOf(url),
    ...(from === '' ? {} : { referrer: from }),
    ...(formId === undefined ? {} : { formId }),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const problems: { url?: string; referrer?: string } = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] === 'referrer' ? 'referrer' : 'url';
    problems[field] ??= issue.message;
  }
  return { ok: false, problems };
}

export interface LinkCheckTag {
  readonly name: string;
  /** The tag named after the lead source, which the first such lead makes. */
  readonly madeOnFirstUse: boolean;
}

/** A rule of the business that matches the link, with what it would do. */
export interface LinkCheckRule {
  readonly id: string;
  /** Its place among the business's rules, from 1. */
  readonly position: number;
  readonly name: string;
  /** The Source it names; null when it names none. */
  readonly source: string | null;
  /** Its Source is the one used: it is the first matching rule that names one. */
  readonly decides: boolean;
  /** The tags it adds; null for one deleted since, which would be skipped. */
  readonly tags: readonly (string | null)[];
  /** The fields it fills; a field that is gone, or that an earlier rule fills, is not filled. */
  readonly fills: readonly {
    readonly field: string | null;
    readonly value: string;
    readonly applies: boolean;
  }[];
}

export interface LinkCheckView {
  /** The business's own rules that match, in the order they are tried. */
  readonly rules: readonly LinkCheckRule[];
  /** What the built-in rules alone call the visit, what that rule looks for, and whether it named the lead. */
  readonly builtIn: {
    readonly source: string;
    readonly looksFor: string;
    readonly decides: boolean;
  };
  /** The lead source: its name. */
  readonly source: string;
  /** What the rule that decided looks for, in a sentence. */
  readonly reason: string;
  readonly sessionSource: string;
  /** The link says nothing of where the visitor came from. */
  readonly untracked: boolean;
  /**
   * What this form would write as the Source of a contact that has none; null when it
   * writes none. Undefined when the answer says nothing about the form.
   */
  readonly contactSource: string | null | undefined;
  /** The tags this form would add, its own first. Undefined as above. */
  readonly tags: readonly LinkCheckTag[] | undefined;
  /** Whose click ids the link carries (click-id-platforms.ts). */
  readonly clickIds: readonly string[];
  /** What else the API has to say about the link, in its words. */
  readonly notes: readonly string[];
}

/** The API's answer as the card shows it. */
export function linkCheckView(preview: LeadSourcePreview): LinkCheckView {
  return {
    // A server older than the business's own rules says nothing of them: none matched, and
    // the built-in rule named the lead.
    rules: (preview.rules ?? []).map((rule) => ({
      id: rule.id,
      position: rule.position,
      name: rule.name,
      source: rule.source,
      decides: rule.decidesSource,
      tags: rule.tags.map((tag) => tag.name),
      fills: rule.fieldWrites.map((write) => ({
        field: write.label,
        value: write.value,
        applies: write.applies && write.label !== null,
      })),
    })),
    builtIn: {
      source: preview.builtIn?.source ?? preview.source,
      looksFor: leadSourceRuleDescriptions[preview.builtIn?.sourceRule ?? preview.sourceRule],
      decides: preview.decidedBy?.kind !== 'rule',
    },
    source: preview.source,
    reason: preview.reason,
    sessionSource: preview.sessionSource,
    untracked: preview.warnings.some((warning) => warning.code === 'no_tracking'),
    contactSource: preview.form === null ? undefined : preview.form.contactSource,
    tags: preview.form?.tags.map((tag) => ({
      name: tag.name,
      madeOnFirstUse: tag.kind === 'source' && !tag.exists,
    })),
    clickIds: platformsOf(preview.clickIds),
    // The page says "no tracking" in its own sentence; every other remark is the API's.
    notes: preview.warnings
      .filter((warning) => warning.code !== 'no_tracking')
      .map((warning) => warning.message),
  };
}
