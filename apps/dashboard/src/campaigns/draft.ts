// A draft campaign as its editor holds it, and as the API takes it (updateEmailCampaign
// takes the whole draft with the revision it was read at). Kept apart from the list's
// rules (rules.ts): the plain-text part of a formatted email is written from its HTML,
// which the list never needs.
import { t } from '@lingui/core/macro';
import type { EmailCampaign, EmailCampaignAudience } from '@repo/contracts';
import { textOfHtml } from '../email-editor/email-html';
import { looksLikeEmail } from './rules';

/** A campaign as its editor holds it: every box as text. */
export interface CampaignDraft {
  readonly name: string;
  readonly folderId: string | null;
  readonly mailboxId: string | null;
  readonly fromName: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly preheader: string;
  /** The formatted part, or undefined for a plain-text email. */
  readonly html: string | undefined;
  readonly text: string;
  /** Whether the author writes the plain-text part of a formatted email themselves. */
  readonly ownText: boolean;
  readonly audience: EmailCampaignAudience | null;
}

export function draftOf(campaign: EmailCampaign): CampaignDraft {
  const { content } = campaign;
  const html = content.format === 'html' ? content.html : undefined;
  return {
    name: campaign.name,
    folderId: campaign.folderId,
    mailboxId: campaign.mailboxId,
    fromName: campaign.fromName ?? '',
    replyTo: campaign.replyTo ?? '',
    subject: campaign.subject,
    preheader: campaign.preheader ?? '',
    html,
    text: content.text,
    ownText:
      html !== undefined && content.text.trim() !== '' && content.text.trim() !== textOfHtml(html),
    audience: campaign.audience,
  };
}

/** The plain-text part that is sent: the author's own, or the formatted part as text. */
export function textPartOfDraft(draft: Pick<CampaignDraft, 'html' | 'text' | 'ownText'>): string {
  if (draft.html === undefined) return draft.text;
  return draft.ownText && draft.text.trim() !== '' ? draft.text : textOfHtml(draft.html);
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/** The whole draft as `updateEmailCampaign` takes it, at the revision it was read at. */
export function bodyOf(
  draft: CampaignDraft,
  revision: number,
): {
  revision: number;
  name: string;
  folderId: string | null;
  mailboxId: string | null;
  fromName: string | null;
  replyTo: string | null;
  subject: string;
  preheader: string | null;
  content: { format: 'text'; text: string } | { format: 'html'; html: string; text: string };
  audience: EmailCampaignAudience | null;
} {
  return {
    revision,
    name: draft.name.trim(),
    folderId: draft.folderId,
    mailboxId: draft.mailboxId,
    fromName: orNull(draft.fromName),
    replyTo: orNull(draft.replyTo),
    subject: draft.subject.trim(),
    // The preview line is a formatted email's.
    preheader: draft.html === undefined ? null : orNull(draft.preheader),
    content:
      draft.html === undefined
        ? { format: 'text', text: draft.text }
        : { format: 'html', html: draft.html, text: textPartOfDraft(draft) },
    audience: draft.audience,
  };
}

export const sameDraft = (left: CampaignDraft, right: CampaignDraft): boolean =>
  JSON.stringify(bodyOf(left, 1)) === JSON.stringify(bodyOf(right, 1));

export type DraftField = 'name' | 'fromName' | 'replyTo' | 'subject' | 'preheader' | 'audience';

/**
 * What stops a draft being saved as it stands, by box. A draft may be unfinished (no
 * subject, no audience): that is for the checks. These are the things the API refuses.
 */
export function draftProblems(draft: CampaignDraft): Partial<Record<DraftField, string>> {
  const problems: Partial<Record<DraftField, string>> = {};
  if (draft.name.trim() === '') problems.name = t`Give the campaign a name.`;
  else if (draft.name.trim().length > 120) problems.name = t`Use at most 120 characters.`;
  if (draft.fromName.trim().length > 120) problems.fromName = t`Use at most 120 characters.`;
  if (draft.replyTo.trim() !== '' && !looksLikeEmail(draft.replyTo))
    problems.replyTo = t`Give one email address, such as hello@example.com.`;
  if (draft.subject.trim().length > 255) problems.subject = t`Use at most 255 characters.`;
  if (draft.html !== undefined && draft.preheader.trim().length > 150)
    problems.preheader = t`Use at most 150 characters.`;
  if (draft.audience?.kind === 'tags' && draft.audience.tagIds.length === 0)
    problems.audience = t`Choose at least one tag.`;
  return problems;
}
