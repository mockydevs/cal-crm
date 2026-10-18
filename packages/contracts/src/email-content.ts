// What an email's body is made of, wherever one is written: plain text, or formatted text
// as HTML with a plain-text part beside it. The same pairing campaigns use
// (email-campaigns.ts). The server cleans the HTML when it is saved and writes the text
// part from it when the author gives none, so every email leaves with both.
import * as z from 'zod';

export const EMAIL_CONTENT_LIMITS = {
  /** Characters of formatted content. A workflow draft holds 500,000 in all (drafts.ts). */
  html: 200_000,
  /** Characters of the plain-text part. */
  text: 100_000,
  /** Characters of the preview line mail apps show after the subject. */
  preheader: 150,
  /** Characters of the name an email is from. */
  fromName: 120,
  /** Addresses in Cc, and in Bcc. Our own limit: a workflow email is for one contact. */
  copies: 10,
  /** Files one email carries, as the outbound pipeline allows (15 MiB in all). */
  attachments: 5,
  /**
   * Characters of one address. RFC 5321 section 4.5.3.1.3 gives a path 256 octets with its
   * angle brackets, which leaves the address 254.
   */
  address: 254,
  /** Characters of the body shown beside a template in a picker. */
  preview: 140,
} as const;

const oneLine = /^[^\r\n]*$/;

export const emailContent = z
  .discriminatedUnion('format', [
    z.strictObject({
      format: z.literal('text'),
      text: z
        .string()
        .min(1, { error: 'Write the message.' })
        .max(EMAIL_CONTENT_LIMITS.text, { error: 'Use at most 100,000 characters.' }),
    }),
    z.strictObject({
      format: z.literal('html'),
      html: z
        .string()
        .min(1, { error: 'Write the message.' })
        .max(EMAIL_CONTENT_LIMITS.html, { error: 'Use at most 200,000 characters.' })
        .meta({
          description:
            'Formatted text as HTML. Saved cleaned: only formatting tags and attributes, http, https, mailto and tel links, and https or /m/ images are kept.',
        }),
      text: z
        .string()
        .max(EMAIL_CONTENT_LIMITS.text, { error: 'Use at most 100,000 characters.' })
        .optional()
        .meta({
          description:
            'The plain-text part sent beside the HTML. Left out or empty, it is written from the HTML.',
        }),
    }),
  ])
  .meta({
    id: 'EmailContent',
    description:
      'Plain text, or formatted text as HTML with a plain-text part. Merge fields such as {{contact.firstName}} are filled in per recipient; in HTML their values are escaped.',
  });
export type EmailContent = z.output<typeof emailContent>;

/** Content as it is stored and read back: the text part is always there. */
export const storedEmailContent = z
  .discriminatedUnion('format', [
    z.looseObject({ format: z.literal('text'), text: z.string() }),
    z.looseObject({ format: z.literal('html'), html: z.string(), text: z.string() }),
  ])
  .meta({ id: 'StoredEmailContent' });
export type StoredEmailContent = z.output<typeof storedEmailContent>;

export const emailPreheader = z
  .string()
  .trim()
  .min(1)
  .max(EMAIL_CONTENT_LIMITS.preheader, { error: 'Use at most 150 characters.' })
  .regex(oneLine, { error: 'Keep the preview text on one line.' })
  .meta({
    description: 'The preview line mail apps show after the subject. Formatted emails only.',
  });
