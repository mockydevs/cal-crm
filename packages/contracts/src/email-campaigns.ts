// Marketing → Emails → Campaigns: one email to many contacts, now,
// at a set time or in batches. A campaign is a draft until someone with campaigns.send
// sends or schedules it; from then its content cannot change. Its audience is a smart list,
// tags, a filter or every contact, counted live while it is a draft and fixed when sending
// starts. Every recipient goes through the outbound pipeline, so consent, suppressions, do
// not contact, quiet hours and the mailbox's limits decide as each email leaves, and a
// contact who gets nothing has a reason.
//
// Opens and clicks are not here: nothing measures them yet.
import * as z from 'zod';

import { contactFilter } from './contact-filters.js';
import { campaignBatches, EMAIL_CAMPAIGN_AUDIENCE_LIMIT } from './email-campaign-schedule.js';
import { defineEndpoint } from './endpoints.js';
import { listEmailCampaignMailboxes } from './email-campaign-mailboxes.js';
import { publicId } from './ids.js';
import { mergeTokens } from './message-templates.js';
import { timestamp } from './timestamps.js';

export const EMAIL_CAMPAIGN_LIMITS = {
  /** Contacts one campaign reaches. */
  audience: EMAIL_CAMPAIGN_AUDIENCE_LIMIT,
  /** Campaigns or recipients on one page. */
  page: 100,
  /** Contacts shown as examples of each reason in the audience preview. */
  sample: 5,
  /** Addresses one test goes to. */
  testAddresses: 5,
  /** Tests a business may send in an hour. */
  testsPerHour: 20,
  /** Tags an audience names. */
  tags: 20,
  /** Characters of the plain-text part. */
  text: 100_000,
  /** Characters of pasted HTML. */
  html: 500_000,
  /** Characters of a subject before the checks call it long. */
  subjectAdvice: 60,
  /**
   * Bytes of HTML before the checks warn that Gmail may clip it. Gmail cuts a message off at
   * about 102 KB behind a "View entire message" link, hiding the unsubscribe link and the
   * postal address at its end. Google does not document the figure; it is the industry's
   * observation, so the warning leaves room for merge values and the footer.
   */
  htmlClipAdvice: 90 * 1024,
  /** Folders of campaigns one business may have. */
  folders: 500,
} as const;

export { EMAIL_UNSUBSCRIBE_MERGE_FIELD } from './email-unsubscribe-field.js';

export const emailCampaignStatuses = [
  'draft',
  'scheduled',
  'sending',
  'paused',
  'sent',
  'cancelled',
  'failed',
] as const;
export type EmailCampaignStatus = (typeof emailCampaignStatuses)[number];

/** Why a campaign paused itself or failed; null when a person did it or nothing is wrong. */
export const emailCampaignStatusReasons = [
  'bounce_rate',
  'audience_unavailable',
  'audience_too_large',
  'audience_empty',
  'mailbox_unavailable',
] as const;
export type EmailCampaignStatusReason = (typeof emailCampaignStatusReasons)[number];

export const emailCampaignRecipientStatuses = [
  'pending',
  'queued',
  'sent',
  'skipped',
  'failed',
] as const;
export type EmailCampaignRecipientStatus = (typeof emailCampaignRecipientStatuses)[number];

/**
 * Why a contact gets nothing. The first eight can be known before sending and are what the
 * audience preview counts; the rest happen as a send runs. Two contacts of a business never
 * share an address (the database refuses it), so there is no reason for a duplicate.
 */
export const emailCampaignSkipReasons = [
  'no_email',
  'do_not_contact',
  'unsubscribed',
  'bounced',
  'complained',
  'suppressed',
  'no_consent',
  'no_time_zone',
  'contact_removed',
  'missing_merge_values',
  'mailbox_unavailable',
  'unsubscribe_unavailable',
  'cancelled',
  'refused',
] as const;
export type EmailCampaignSkipReason = (typeof emailCampaignSkipReasons)[number];

/** Why a send is waiting, when it is. */
export const emailCampaignWaitReasons = [
  'batch_interval',
  'window',
  'mailbox_daily_limit',
  'mailbox_warmup_limit',
  'business_daily_limit',
  'agency_daily_limit',
  'mailbox_pacing',
] as const;
export type EmailCampaignWaitReason = (typeof emailCampaignWaitReasons)[number];

const campaignId = publicId('email_campaign');
const folderId = publicId('email_campaign_folder');
const revision = z.int().min(1);
const name = z
  .string()
  .trim()
  .min(1, { error: 'Give the campaign a name.' })
  .max(120, { error: 'Use at most 120 characters.' });
const oneLine = /^[^\r\n]*$/;
const subject = z
  .string()
  .trim()
  .max(255, { error: 'Use at most 255 characters.' })
  .regex(oneLine, { error: 'Keep the subject on one line.' });
const text = z
  .string()
  .max(EMAIL_CAMPAIGN_LIMITS.text, { error: 'Use at most 100,000 characters.' });

export const emailCampaignContent = z
  .discriminatedUnion('format', [
    z.strictObject({ format: z.literal('text'), text }),
    z.strictObject({
      format: z.literal('html'),
      html: z
        .string()
        .max(EMAIL_CAMPAIGN_LIMITS.html, { error: 'Use at most 500,000 characters.' }),
      text: text.meta({
        description:
          'The plain-text part sent beside the HTML, for mail apps that show no HTML. Required to send.',
      }),
    }),
  ])
  .meta({
    id: 'EmailCampaignContent',
    description:
      'Plain text, or pasted HTML with a plain-text part. Merge fields such as {{contact.firstName}} are filled in per recipient; in HTML their values are escaped.',
  });
export type EmailCampaignContent = z.output<typeof emailCampaignContent>;

export const emailCampaignAudience = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all') }),
    z.strictObject({ kind: z.literal('smart_list'), viewId: publicId('saved_view') }),
    z.strictObject({
      kind: z.literal('tags'),
      tagIds: z.array(publicId('tag')).min(1).max(EMAIL_CAMPAIGN_LIMITS.tags),
      match: z.enum(['any', 'all']).default('any'),
    }),
    z.strictObject({ kind: z.literal('filter'), filter: contactFilter }),
  ])
  .meta({
    id: 'EmailCampaignAudience',
    description:
      'Who the campaign is for: every contact, a smart list (a saved view of contacts), contacts with any or all of some tags, or a filter. Read live while the campaign is a draft; fixed when sending starts.',
  });
export type EmailCampaignAudience = z.output<typeof emailCampaignAudience>;

export const emailCampaignSchedule = z
  .looseObject({
    sendAt: timestamp.nullable().meta({
      description: 'When sending starts. Null for a campaign sent at once.',
    }),
    batches: campaignBatches.nullable(),
  })
  .meta({ id: 'EmailCampaignSchedule' });
export type EmailCampaignSchedule = z.output<typeof emailCampaignSchedule>;

export const emailCampaignCounts = z
  .looseObject({
    audience: z.int().min(0).meta({ description: 'Contacts in the audience when it was fixed.' }),
    pending: z.int().min(0).meta({ description: 'Not yet released to the mailbox.' }),
    queued: z.int().min(0).meta({ description: 'Released and waiting for the mailbox.' }),
    sent: z.int().min(0),
    skipped: z.int().min(0),
    failed: z.int().min(0),
  })
  .meta({
    id: 'EmailCampaignCounts',
    description: 'All zero until sending starts. Brought up to date about once a minute.',
  });
export type EmailCampaignCounts = z.output<typeof emailCampaignCounts>;

const campaignFields = {
  id: campaignId,
  name: z.string(),
  folderId: folderId.nullable(),
  status: z.enum(emailCampaignStatuses),
  statusReason: z.enum(emailCampaignStatusReasons).nullable(),
  mailboxId: publicId('mailbox').nullable(),
  subject: z.string(),
  format: z.enum(['text', 'html']),
  schedule: emailCampaignSchedule.nullable().meta({
    description: 'Null while it is a draft.',
  }),
  timeZone: z.string().meta({
    description: "The business's time zone, which a schedule is shown and its window read in.",
  }),
  counts: emailCampaignCounts,
  waiting: z
    .looseObject({
      reason: z.enum(emailCampaignWaitReasons),
      until: timestamp.nullable(),
    })
    .nullable()
    .meta({
      description:
        'Why a campaign that is sending has released nothing lately, and when it goes on.',
    }),
  audience: emailCampaignAudience.nullable(),
  revision,
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
};

/** A campaign in a list: without its content. */
export const emailCampaignSummary = z
  .looseObject(campaignFields)
  .meta({ id: 'EmailCampaignSummary' });
export type EmailCampaignSummary = z.output<typeof emailCampaignSummary>;

export const emailCampaign = z
  .looseObject({
    ...campaignFields,
    fromName: z.string().nullable().meta({
      description: "The name recipients see. Null uses the mailbox's own display name.",
    }),
    replyTo: z.string().nullable().meta({
      description:
        'Where replies go. Null means the mailbox itself, whose replies reach the Inbox.',
    }),
    preheader: z.string().nullable().meta({
      description: 'The preview line mail apps show after the subject. HTML emails only.',
    }),
    content: emailCampaignContent,
    templateId: publicId('template').nullable().meta({
      description:
        'The template its text was copied from. Editing the template changes nothing here.',
    }),
    mergeFields: z.array(z.string()),
    canManage: z.boolean(),
    canSend: z.boolean(),
  })
  .meta({ id: 'EmailCampaign' });
export type EmailCampaign = z.output<typeof emailCampaign>;

export const emailCampaignList = z
  .looseObject({
    items: z.array(emailCampaignSummary),
    next: campaignId.nullable(),
    canManage: z.boolean(),
    canSend: z.boolean(),
    total: z.int().min(0).optional().meta({
      description:
        'How many campaigns match the search, the status and the folder, on every page together.',
    }),
  })
  .meta({ id: 'EmailCampaignList' });
export type EmailCampaignList = z.output<typeof emailCampaignList>;

export const createEmailCampaignInput = z
  .strictObject({
    name,
    folderId: folderId.nullable().default(null),
    source: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('blank') }),
        z.strictObject({ kind: z.literal('template'), templateId: publicId('template') }),
        z.strictObject({ kind: z.literal('campaign'), campaignId }),
      ])
      .default({ kind: 'blank' })
      .meta({
        description:
          'Start blank, from a message template (its subject and text are copied), or as a copy of another campaign (everything but its schedule and results).',
      }),
  })
  .meta({ id: 'CreateEmailCampaignInput' });

export const updateEmailCampaignInput = z
  .strictObject({
    revision,
    name,
    folderId: folderId.nullable(),
    mailboxId: publicId('mailbox').nullable(),
    fromName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(oneLine, { error: 'Keep the name on one line.' })
      .nullable(),
    replyTo: z.email({ error: 'Give an email address.' }).max(320).nullable(),
    subject,
    preheader: z.string().trim().min(1).max(150).regex(oneLine).nullable(),
    content: emailCampaignContent,
    audience: emailCampaignAudience.nullable(),
  })
  .meta({
    id: 'UpdateEmailCampaignInput',
    description:
      'The whole draft, with the revision it was read at. A stale revision returns 409 and changes nothing. Only a draft can be changed.',
  });
export type UpdateEmailCampaignInput = z.output<typeof updateEmailCampaignInput>;

export const emailCampaignRevisionInput = z
  .strictObject({ revision })
  .meta({ id: 'EmailCampaignRevisionInput' });

export const sendEmailCampaignInput = z
  .strictObject({ revision, batches: campaignBatches.nullable().default(null) })
  .meta({ id: 'SendEmailCampaignInput' });

export const scheduleEmailCampaignInput = z
  .strictObject({
    revision,
    sendAt: timestamp.meta({
      description:
        "The instant sending starts, at most a year ahead. Show and choose it in the campaign's timeZone.",
    }),
    batches: campaignBatches.nullable().default(null),
  })
  .meta({ id: 'ScheduleEmailCampaignInput' });

export const moveEmailCampaignInput = z
  .strictObject({ folderId: folderId.nullable() })
  .meta({ id: 'MoveEmailCampaignInput' });

// The audience preview ---------------------------------------------------------------------

export const emailCampaignAudienceSample = z
  .looseObject({
    contactId: publicId('contact'),
    name: z.string().nullable(),
    email: z.string().nullable(),
  })
  .meta({ id: 'EmailCampaignAudienceSample' });

export const emailCampaignAudiencePreview = z
  .looseObject({
    total: z.int().min(0),
    willReceive: z.int().min(0),
    willNot: z.int().min(0),
    tooMany: z.boolean().meta({
      description: `More than ${String(EMAIL_CAMPAIGN_AUDIENCE_LIMIT)} contacts match: the campaign cannot be sent to this audience. Counts stop at the limit.`,
    }),
    reasons: z.array(
      z.looseObject({
        reason: z.enum(emailCampaignSkipReasons),
        count: z.int().min(1),
        sample: z.array(emailCampaignAudienceSample).max(EMAIL_CAMPAIGN_LIMITS.sample),
      }),
    ),
    receiving: z.array(emailCampaignAudienceSample).max(EMAIL_CAMPAIGN_LIMITS.sample),
    countedAt: timestamp,
  })
  .meta({
    id: 'EmailCampaignAudiencePreview',
    description:
      'Who would get the campaign if it were sent now, and who would not and why, decided by the rules a send is decided by. Quiet hours and daily limits delay an email and refuse none, so they are not here.',
  });
export type EmailCampaignAudiencePreview = z.output<typeof emailCampaignAudiencePreview>;

// The checks -------------------------------------------------------------------------------

export const emailCampaignCheckCodes = [
  'subject_missing',
  'body_missing',
  'text_part_missing',
  'audience_missing',
  'audience_unavailable',
  'audience_empty',
  'audience_too_large',
  'mailbox_missing',
  'mailbox_inactive',
  'mailbox_not_for_campaigns',
  'mailbox_not_checked',
  'mailbox_check_failing',
  'mailbox_check_unknown',
  'unsubscribe_unavailable',
  'unfillable_merge_fields',
  'unsubscribe_line_added',
  'postal_address_missing',
  'subject_long',
  'html_may_be_clipped',
  'spread_over_days',
  'some_will_not_receive',
] as const;
export type EmailCampaignCheckCode = (typeof emailCampaignCheckCodes)[number];

export const emailCampaignCheck = z
  .looseObject({
    code: z.enum(emailCampaignCheckCodes),
    severity: z.enum(['blocking', 'warning', 'info']),
    message: z.string(),
    check: z.enum(['spf', 'dkim', 'dmarc', 'unsubscribe']).optional().meta({
      description: "Which of the mailbox's setup checks it is about (Settings → Email).",
    }),
    fields: z.array(z.string()).optional(),
    count: z.int().min(0).optional(),
    days: z.int().min(1).optional(),
  })
  .meta({ id: 'EmailCampaignCheck' });
export type EmailCampaignCheck = z.output<typeof emailCampaignCheck>;

export const emailCampaignChecks = z
  .looseObject({
    canSend: z.boolean().meta({ description: 'No blocking problem is left.' }),
    dailyCeiling: z.int().min(0).nullable().meta({
      description:
        "The most campaign emails this campaign's mailbox may release in a day now: the least of the mailbox's limit (less what it keeps back for replies), its warm-up allowance, and the business's and the agency's ceilings. Null without a mailbox.",
    }),
    items: z.array(emailCampaignCheck),
  })
  .meta({
    id: 'EmailCampaignChecks',
    description:
      'What stands in the way of sending and what to know first, worked out by the server with no model. Sending and scheduling refuse while a blocking item is left.',
  });
export type EmailCampaignChecks = z.output<typeof emailCampaignChecks>;

// Tests ------------------------------------------------------------------------------------

export const sendEmailCampaignTestInput = z
  .strictObject({
    to: z
      .array(z.union([z.literal('me'), z.email().max(320)]))
      .min(1)
      .max(EMAIL_CAMPAIGN_LIMITS.testAddresses)
      .meta({
        description:
          'Where the test goes: "me" is your own sign-in address. Naming other addresses needs campaigns.send.',
      }),
    contactId: publicId('contact').optional().meta({
      description:
        "Fill the merge fields in with this contact's values. Nothing is sent to the contact. Left out, merge fields stay as written.",
    }),
  })
  .meta({ id: 'SendEmailCampaignTestInput' });

export const emailCampaignTest = z
  .looseObject({
    queued: z.int().min(1),
    to: z.array(z.string()),
  })
  .meta({
    id: 'EmailCampaignTest',
    description:
      'The test is queued for the worker. Its subject starts with [Test]; it is not counted in the campaign and its unsubscribe line is a placeholder.',
  });
export type EmailCampaignTest = z.output<typeof emailCampaignTest>;

// Recipients and numbers -------------------------------------------------------------------

export const emailCampaignRecipient = z
  .looseObject({
    contactId: publicId('contact'),
    name: z.string().nullable(),
    email: z.string().nullable(),
    status: z.enum(emailCampaignRecipientStatuses),
    reason: z.enum(emailCampaignSkipReasons).nullable(),
    fields: z.array(z.string()).nullable().meta({
      description: 'For missing_merge_values: the fields the contact has no value for.',
    }),
    batch: z.int().min(1).nullable(),
    bounced: z.boolean(),
    unsubscribed: z.boolean(),
    messageId: publicId('message').nullable(),
    sentAt: timestamp.nullable(),
  })
  .meta({ id: 'EmailCampaignRecipient' });
export type EmailCampaignRecipient = z.output<typeof emailCampaignRecipient>;

export const emailCampaignRecipientList = z
  .looseObject({
    items: z.array(emailCampaignRecipient),
    next: publicId('contact').nullable(),
  })
  .meta({ id: 'EmailCampaignRecipientList' });
export type EmailCampaignRecipientList = z.output<typeof emailCampaignRecipientList>;

export const emailCampaignStats = z
  .looseObject({
    audience: z.int().min(0),
    pending: z.int().min(0),
    queued: z.int().min(0),
    sent: z.int().min(0),
    failed: z.int().min(0),
    skipped: z.int().min(0),
    skippedByReason: z.array(
      z.looseObject({ reason: z.enum(emailCampaignSkipReasons), count: z.int().min(1) }),
    ),
    bounced: z.int().min(0).meta({
      description: 'Sent emails a delivery report came back for, hard or soft.',
    }),
    hardBounced: z.int().min(0),
    unsubscribed: z.int().min(0).meta({
      description: "Recipients who used this campaign's unsubscribe link.",
    }),
    batches: z.int().min(0).meta({ description: 'Batches released so far.' }),
    countedAt: timestamp,
  })
  .meta({
    id: 'EmailCampaignStats',
    description: 'Counted when asked. Opens and clicks are not measured yet, so they are not here.',
  });
export type EmailCampaignStats = z.output<typeof emailCampaignStats>;

// Folders and settings ---------------------------------------------------------------------

export const emailCampaignFolder = z
  .looseObject({
    id: folderId,
    parentId: folderId.nullable(),
    name: z.string(),
    revision,
    campaignCount: z.int().min(0),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'EmailCampaignFolder' });
export type EmailCampaignFolder = z.output<typeof emailCampaignFolder>;

export const emailCampaignFolderList = z
  .looseObject({
    canManage: z.boolean(),
    items: z.array(emailCampaignFolder).max(EMAIL_CAMPAIGN_LIMITS.folders),
    counts: z
      .looseObject({
        all: z.int().min(0).meta({ description: 'Every campaign of the business.' }),
        unfiled: z.int().min(0).meta({ description: 'The campaigns in no folder.' }),
      })
      .optional()
      .meta({ description: 'How many campaigns each view of the list holds.' }),
  })
  .meta({ id: 'EmailCampaignFolderList' });
export type EmailCampaignFolderList = z.output<typeof emailCampaignFolderList>;

const folderName = z.string().trim().min(1).max(120);
export const createEmailCampaignFolderInput = z
  .strictObject({ name: folderName, parentId: folderId.nullable().default(null) })
  .meta({ id: 'CreateEmailCampaignFolderInput' });
export const updateEmailCampaignFolderInput = z
  .strictObject({
    revision,
    name: folderName.optional(),
    parentId: folderId.nullable().optional(),
  })
  .refine((input) => input.name !== undefined || input.parentId !== undefined, {
    error: 'Give a new name or destination folder.',
  })
  .meta({ id: 'UpdateEmailCampaignFolderInput' });

export const emailCampaignSettingsInput = z
  .strictObject({
    dailyLimit: z.int().min(1).max(100_000).nullable().meta({
      description:
        "The most campaign emails the business releases in 24 hours, over all its campaigns. Null means each campaign mailbox's own daily limit.",
    }),
  })
  .meta({ id: 'EmailCampaignSettingsInput' });
export const emailCampaignSettings = z
  .looseObject({
    dailyLimit: z.int().min(1).nullable(),
    agencyDailyLimit: z.int().min(1).nullable().meta({
      description:
        "The install's ceiling for one agency's campaign emails in 24 hours (CAMPAIGN_AGENCY_DAILY_LIMIT), over all its businesses. Null when the install sets none.",
    }),
    bounceRatePause: z.looseObject({ percent: z.number(), afterSent: z.int() }).meta({
      description:
        'A campaign pauses itself once this share of its sent emails hard-bounced, counted after this many were sent.',
    }),
    canManage: z.boolean(),
  })
  .meta({ id: 'EmailCampaignSettings' });
export type EmailCampaignSettings = z.output<typeof emailCampaignSettings>;

// Pure rules shared with the dashboard -----------------------------------------------------

/** The merge fields a campaign's subject and content use, each once. */
export function emailCampaignMergeFields(campaign: {
  readonly subject: string;
  readonly content: EmailCampaignContent;
}): string[] {
  const { content } = campaign;
  return mergeTokens({
    subject: campaign.subject,
    body: content.format === 'html' ? `${content.html}\n${content.text}` : content.text,
  });
}

/** What a person may do with a campaign in each status. */
export const emailCampaignActions: Readonly<
  Record<
    EmailCampaignStatus,
    readonly ('edit' | 'delete' | 'send' | 'schedule' | 'pause' | 'resume' | 'cancel')[]
  >
> = {
  draft: ['edit', 'delete', 'send', 'schedule'],
  scheduled: ['cancel'],
  sending: ['pause', 'cancel'],
  paused: ['resume', 'cancel'],
  sent: [],
  cancelled: [],
  failed: [],
};

// Endpoints --------------------------------------------------------------------------------

const GROUP = 'Email campaigns';
const idParams = z.strictObject({ id: campaignId });
const folderParams = z.strictObject({ id: folderId });
const limit = z.coerce.number().int().min(1).max(EMAIL_CAMPAIGN_LIMITS.page).default(50);

export const listEmailCampaigns = defineEndpoint({
  operationId: 'listEmailCampaigns',
  method: 'get',
  path: '/email-campaigns',
  summary: 'Read email campaigns, newest first',
  group: GROUP,
  query: z.strictObject({
    q: z.string().trim().max(120).optional().meta({
      description: 'Literal case-insensitive search of campaign names.',
    }),
    status: z.enum(emailCampaignStatuses).optional(),
    folder: z
      .union([z.literal('root'), folderId])
      .optional()
      .meta({ description: 'Omit for every campaign; root means those in no folder.' }),
    after: campaignId.optional(),
    limit,
  }),
  response: {
    status: 200,
    description: 'A page of campaigns without their content.',
    schema: emailCampaignList,
  },
});
export const getEmailCampaign = defineEndpoint({
  operationId: 'getEmailCampaign',
  method: 'get',
  path: '/email-campaigns/{id}',
  summary: 'Read one email campaign',
  group: GROUP,
  params: idParams,
  response: { status: 200, description: 'The campaign.', schema: emailCampaign },
});
export const createEmailCampaign = defineEndpoint({
  operationId: 'createEmailCampaign',
  method: 'post',
  path: '/email-campaigns',
  summary: 'Start a draft campaign: blank, from a template, or as a copy',
  group: GROUP,
  body: createEmailCampaignInput,
  response: { status: 201, description: 'The new draft.', schema: emailCampaign },
});
export const updateEmailCampaign = defineEndpoint({
  operationId: 'updateEmailCampaign',
  method: 'put',
  path: '/email-campaigns/{id}',
  summary: 'Save a draft campaign without overwriting another edit',
  group: GROUP,
  params: idParams,
  body: updateEmailCampaignInput,
  response: { status: 200, description: 'The saved draft.', schema: emailCampaign },
});
export const deleteEmailCampaign = defineEndpoint({
  operationId: 'deleteEmailCampaign',
  method: 'delete',
  path: '/email-campaigns/{id}',
  summary: 'Delete a draft campaign',
  group: GROUP,
  params: idParams,
  body: emailCampaignRevisionInput,
  response: {
    status: 204,
    description: 'The draft is gone. A campaign that was sent or scheduled is kept.',
  },
});
export const moveEmailCampaign = defineEndpoint({
  operationId: 'moveEmailCampaign',
  method: 'put',
  path: '/email-campaigns/{id}/folder',
  summary: 'Move a campaign to a folder, whatever its status',
  group: GROUP,
  params: idParams,
  body: moveEmailCampaignInput,
  response: { status: 200, description: 'The campaign in its folder.', schema: emailCampaign },
});
export const getEmailCampaignAudience = defineEndpoint({
  operationId: 'getEmailCampaignAudience',
  method: 'get',
  path: '/email-campaigns/{id}/audience',
  summary: 'Count who would get the campaign and who would not, by reason',
  group: GROUP,
  params: idParams,
  response: {
    status: 200,
    description:
      'For a draft, the audience as it is now. Once sending has started, the audience that was fixed.',
    schema: emailCampaignAudiencePreview,
  },
});
export const getEmailCampaignChecks = defineEndpoint({
  operationId: 'getEmailCampaignChecks',
  method: 'get',
  path: '/email-campaigns/{id}/checks',
  summary: 'Read what stands in the way of sending a campaign',
  group: GROUP,
  params: idParams,
  response: {
    status: 200,
    description: 'Blocking problems, warnings and notes.',
    schema: emailCampaignChecks,
  },
});
export const sendEmailCampaignTest = defineEndpoint({
  operationId: 'sendEmailCampaignTest',
  method: 'post',
  path: '/email-campaigns/{id}/test',
  summary: 'Send a test of a campaign to yourself or named addresses',
  group: GROUP,
  params: idParams,
  body: sendEmailCampaignTestInput,
  response: {
    status: 200,
    description: 'The test is queued. Nobody in the audience gets it.',
    schema: emailCampaignTest,
  },
});
export const sendEmailCampaign = defineEndpoint({
  operationId: 'sendEmailCampaign',
  method: 'post',
  path: '/email-campaigns/{id}/send',
  summary: 'Send a campaign now, at once or in batches',
  group: GROUP,
  params: idParams,
  body: sendEmailCampaignInput,
  response: {
    status: 200,
    description: 'The campaign, now sending. Its audience is fixed in the background.',
    schema: emailCampaign,
  },
});
export const scheduleEmailCampaign = defineEndpoint({
  operationId: 'scheduleEmailCampaign',
  method: 'post',
  path: '/email-campaigns/{id}/schedule',
  summary: 'Schedule a campaign to start at a set time',
  group: GROUP,
  params: idParams,
  body: scheduleEmailCampaignInput,
  response: { status: 200, description: 'The campaign, scheduled.', schema: emailCampaign },
});
export const pauseEmailCampaign = defineEndpoint({
  operationId: 'pauseEmailCampaign',
  method: 'post',
  path: '/email-campaigns/{id}/pause',
  summary: 'Pause a campaign that is sending',
  group: GROUP,
  params: idParams,
  response: {
    status: 200,
    description: 'Nothing more leaves until it is resumed, including emails already released.',
    schema: emailCampaign,
  },
});
export const resumeEmailCampaign = defineEndpoint({
  operationId: 'resumeEmailCampaign',
  method: 'post',
  path: '/email-campaigns/{id}/resume',
  summary: 'Resume a paused campaign',
  group: GROUP,
  params: idParams,
  response: {
    status: 200,
    description: 'Sending goes on from where it stopped. Nobody is sent the campaign twice.',
    schema: emailCampaign,
  },
});
export const cancelEmailCampaign = defineEndpoint({
  operationId: 'cancelEmailCampaign',
  method: 'post',
  path: '/email-campaigns/{id}/cancel',
  summary: 'Cancel a scheduled, sending or paused campaign',
  group: GROUP,
  params: idParams,
  response: {
    status: 200,
    description:
      'A scheduled campaign that has not started is a draft again. One that started is cancelled for good: whoever has not been sent it is skipped.',
    schema: emailCampaign,
  },
});
export const listEmailCampaignRecipients = defineEndpoint({
  operationId: 'listEmailCampaignRecipients',
  method: 'get',
  path: '/email-campaigns/{id}/recipients',
  summary: "Read a campaign's recipients and what became of each",
  group: GROUP,
  params: idParams,
  query: z.strictObject({
    status: z.enum(emailCampaignRecipientStatuses).optional(),
    reason: z.enum(emailCampaignSkipReasons).optional(),
    after: publicId('contact').optional(),
    limit,
  }),
  response: {
    status: 200,
    description: 'A page of recipients in the order they are sent to. Empty until sending starts.',
    schema: emailCampaignRecipientList,
  },
});
export const getEmailCampaignStats = defineEndpoint({
  operationId: 'getEmailCampaignStats',
  method: 'get',
  path: '/email-campaigns/{id}/stats',
  summary: "Read a campaign's numbers",
  group: GROUP,
  params: idParams,
  response: {
    status: 200,
    description: 'The numbers as they are now.',
    schema: emailCampaignStats,
  },
});
export const listEmailCampaignFolders = defineEndpoint({
  operationId: 'listEmailCampaignFolders',
  method: 'get',
  path: '/email-campaign-folders',
  summary: 'Read the folders of email campaigns',
  group: GROUP,
  response: {
    status: 200,
    description: 'Every folder with how many campaigns are directly in it.',
    schema: emailCampaignFolderList,
  },
});
export const createEmailCampaignFolder = defineEndpoint({
  operationId: 'createEmailCampaignFolder',
  method: 'post',
  path: '/email-campaign-folders',
  summary: 'Create a folder for email campaigns',
  group: GROUP,
  body: createEmailCampaignFolderInput,
  response: { status: 201, description: 'The folder.', schema: emailCampaignFolder },
});
export const updateEmailCampaignFolder = defineEndpoint({
  operationId: 'updateEmailCampaignFolder',
  method: 'patch',
  path: '/email-campaign-folders/{id}',
  summary: 'Rename or move a folder of email campaigns',
  group: GROUP,
  params: folderParams,
  body: updateEmailCampaignFolderInput,
  response: {
    status: 200,
    description: 'The folder after the change.',
    schema: emailCampaignFolder,
  },
});
export const removeEmailCampaignFolder = defineEndpoint({
  operationId: 'removeEmailCampaignFolder',
  method: 'delete',
  path: '/email-campaign-folders/{id}',
  summary: 'Remove a folder; its campaigns and folders move to its parent',
  group: GROUP,
  params: folderParams,
  body: emailCampaignRevisionInput,
  response: { status: 204, description: 'The folder is gone and nothing in it was deleted.' },
});
export const getEmailCampaignSettings = defineEndpoint({
  operationId: 'getEmailCampaignSettings',
  method: 'get',
  path: '/email-campaign-settings',
  summary: "Read the business's campaign sending ceiling",
  group: GROUP,
  response: { status: 200, description: 'The ceilings in force.', schema: emailCampaignSettings },
});
export const updateEmailCampaignSettings = defineEndpoint({
  operationId: 'updateEmailCampaignSettings',
  method: 'put',
  path: '/email-campaign-settings',
  summary: "Set the business's campaign sending ceiling",
  group: GROUP,
  body: emailCampaignSettingsInput,
  response: { status: 200, description: 'The saved ceiling.', schema: emailCampaignSettings },
});

/** Every campaign endpoint, for the API's list of operations. */
export const emailCampaignEndpoints = [
  listEmailCampaigns,
  getEmailCampaign,
  createEmailCampaign,
  updateEmailCampaign,
  deleteEmailCampaign,
  moveEmailCampaign,
  getEmailCampaignAudience,
  getEmailCampaignChecks,
  sendEmailCampaignTest,
  sendEmailCampaign,
  scheduleEmailCampaign,
  pauseEmailCampaign,
  resumeEmailCampaign,
  cancelEmailCampaign,
  listEmailCampaignRecipients,
  getEmailCampaignStats,
  listEmailCampaignFolders,
  createEmailCampaignFolder,
  updateEmailCampaignFolder,
  removeEmailCampaignFolder,
  listEmailCampaignMailboxes,
  getEmailCampaignSettings,
  updateEmailCampaignSettings,
] as const;
