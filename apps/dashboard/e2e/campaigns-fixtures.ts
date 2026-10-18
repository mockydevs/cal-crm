// A business's email campaigns as the API holds them, for the component tests and the
// browser spec of Marketing → Emails → Campaigns: every write is parsed by the contract's
// own schema, every answer is typed by the contract's own types, and the world behaves as
// the server does where the screens depend on it: a stale revision is refused, only a draft
// can be changed, the checks are worked out from the draft, a scheduled campaign that is
// cancelled is a draft again and a started one is cancelled for good. Nothing here imports
// the dashboard's code, so a test never checks the page against itself.
import {
  campaignSpreadDays,
  createEmailCampaignFolderInput,
  createEmailCampaignInput,
  EMAIL_UNSUBSCRIBE_MERGE_FIELD,
  emailCampaignMergeFields,
  emailCampaignSettingsInput,
  moveEmailCampaignInput,
  scheduleEmailCampaignInput,
  sendEmailCampaignInput,
  sendEmailCampaignTestInput,
  updateEmailCampaignFolderInput,
  updateEmailCampaignInput,
  type EmailCampaign,
  type EmailCampaignAudience,
  type EmailCampaignAudiencePreview,
  type EmailCampaignCheck,
  type EmailCampaignChecks,
  type EmailCampaignFolder,
  type EmailCampaignFolderList,
  type EmailCampaignList,
  type EmailCampaignMailbox,
  type EmailCampaignRecipient,
  type EmailCampaignRecipientList,
  type EmailCampaignSettings,
  type EmailCampaignStats,
  type EmailCampaignSummary,
  type EmailCampaignTest,
  type MessageTemplate,
  type SavedView,
} from '@repo/contracts';

export const at = '2026-10-14T09:00:00.000Z';
export const timeZone = 'America/Chicago';
const pad = (number: number): string => String(number).padStart(4, '0');
export const campaignId = (number: number): string => `camp_01k8e2wzr0e00800000000${pad(number)}`;
export const folderId = (number: number): string => `cfld_01k8e2wzr0e00800000000${pad(number)}`;
export const contactId = (number: number): string => `con_01k8e2wzr0e00800000000${pad(number)}`;
export const mailboxId = (number: number): string => `mbx_01k8e2wzr0e00800000000${pad(number)}`;
export const viewId = (number: number): string => `view_01k8e2wzr0e00800000000${pad(number)}`;
export const tagId = (number: number): string => `tag_01k8e2wzr0e00800000000${pad(number)}`;

export interface Refusal {
  readonly status: number;
  readonly detail: string;
  readonly errors?: { readonly path: string; readonly message: string; readonly code: string }[];
}
export const isRefusal = (answer: unknown): answer is Refusal =>
  typeof answer === 'object' && answer !== null && 'status' in answer && 'detail' in answer;

const GONE: Refusal = { status: 404, detail: 'No such campaign.' };
const STALE: Refusal = {
  status: 409,
  detail: 'The campaign changed since it was read. Read it again.',
};
const NOT_A_DRAFT: Refusal = { status: 409, detail: 'Only a draft can be changed.' };
const NOT_ALLOWED: Refusal = { status: 403, detail: 'You may not send campaigns.' };

const zero = { audience: 0, pending: 0, queued: 0, sent: 0, skipped: 0, failed: 0 };

export function campaignOf(number: number, patch: Partial<EmailCampaign> = {}): EmailCampaign {
  const content = patch.content ?? { format: 'text' as const, text: '' };
  const subject = patch.subject ?? '';
  return {
    id: campaignId(number),
    name: `Campaign ${String(number)}`,
    folderId: null,
    status: 'draft',
    statusReason: null,
    mailboxId: null,
    schedule: null,
    timeZone,
    counts: zero,
    waiting: null,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null,
    fromName: null,
    replyTo: null,
    preheader: null,
    templateId: null,
    audience: null,
    canManage: true,
    canSend: true,
    ...patch,
    subject,
    content,
    format: content.format,
    mergeFields: emailCampaignMergeFields({ subject, content }),
  };
}

const summaryOf = (campaign: EmailCampaign): EmailCampaignSummary => ({
  id: campaign.id,
  name: campaign.name,
  folderId: campaign.folderId,
  status: campaign.status,
  statusReason: campaign.statusReason,
  mailboxId: campaign.mailboxId,
  subject: campaign.subject,
  format: campaign.format,
  schedule: campaign.schedule,
  timeZone: campaign.timeZone,
  counts: campaign.counts,
  waiting: campaign.waiting,
  audience: campaign.audience,
  revision: campaign.revision,
  createdAt: campaign.createdAt,
  updatedAt: campaign.updatedAt,
  startedAt: campaign.startedAt,
  finishedAt: campaign.finishedAt,
});

export const folderOf = (
  number: number,
  name: string,
  patch: Partial<EmailCampaignFolder> = {},
): EmailCampaignFolder => ({
  id: folderId(number),
  parentId: null,
  name,
  revision: 1,
  campaignCount: 0,
  createdAt: at,
  updatedAt: at,
  ...patch,
});

/** The mailboxes a business has, as GET /mailboxes and each one's sending settings say. */
export interface WorldMailbox {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly displayName: string;
  readonly forCampaigns: boolean;
  /** The most campaign emails it may release in a day now. */
  readonly dailyCeiling: number;
}

export const calari: WorldMailbox = {
  id: mailboxId(1),
  name: 'Calari mailbox',
  email: 'hello@calari.example',
  displayName: 'Calari Events',
  forCampaigns: true,
  dailyCeiling: 500,
};
export const support: WorldMailbox = {
  id: mailboxId(2),
  name: 'Support',
  email: 'support@calari.example',
  displayName: 'Calari Support',
  forCampaigns: false,
  dailyCeiling: 300,
};

export const mailboxAnswer = (
  mailbox: WorldMailbox,
): {
  id: string;
  name: string;
  email: string;
  displayName: string;
  status: 'active';
  createdAt: string;
  smtp: { host: string; port: number; security: 'tls'; username: string };
  imap: { host: string; port: number; security: 'tls'; username: string };
} => ({
  id: mailbox.id,
  name: mailbox.name,
  email: mailbox.email,
  displayName: mailbox.displayName,
  status: 'active',
  createdAt: at,
  smtp: { host: 'smtp.calari.example', port: 465, security: 'tls', username: mailbox.email },
  imap: { host: 'imap.calari.example', port: 993, security: 'tls', username: mailbox.email },
});

/** A mailbox as GET /email-campaign-mailboxes says it: for anyone who may write campaigns. */
export const campaignMailboxAnswer = (mailbox: WorldMailbox): EmailCampaignMailbox => ({
  id: mailbox.id,
  name: mailbox.name,
  email: mailbox.email,
  displayName: mailbox.displayName,
  status: 'active',
  useForCampaigns: mailbox.forCampaigns,
});

export const sendingAnswer = (
  mailbox: WorldMailbox,
): {
  dailyLimit: number;
  pacingPerMinute: number;
  warmupEnabled: boolean;
  useForConversations: boolean;
  useForCampaigns: boolean;
  effectiveAutomatedDailyLimit: number;
  warmupStartedAt: string;
  pausedUntil: null;
  pauseReason: null;
} => ({
  dailyLimit: mailbox.dailyCeiling,
  pacingPerMinute: 5,
  warmupEnabled: false,
  useForConversations: !mailbox.forCampaigns,
  useForCampaigns: mailbox.forCampaigns,
  effectiveAutomatedDailyLimit: mailbox.dailyCeiling,
  warmupStartedAt: at,
  pausedUntil: null,
  pauseReason: null,
});

const smartListOf = (
  number: number,
  name: string,
): Extract<SavedView, { objectKey: 'contact' }> => ({
  id: viewId(number),
  name,
  objectKey: 'contact',
  visibility: 'shared',
  access: 'owner',
  owner: { membershipId: 'mem_01m4bd188ff82s0add91b7pz71', name: 'Dana Brooks', you: true },
  sharing: { everyone: 'view', people: [] },
  canChange: true,
  canShare: true,
  canUnshare: true,
  canDelete: true,
  canChangeSharing: true,
  createdAt: at,
  updatedAt: at,
  revision: 'a'.repeat(64),
  state: {},
  columns: ['name', 'email', 'phone'],
});
/** The business's smart lists: saved views of contacts. */
export const smartLists = [
  smartListOf(1, 'Newsletter readers'),
  smartListOf(2, 'Past customers'),
] as const;

const sample = (number: number, name: string | null, email: string | null) => ({
  contactId: contactId(number),
  name,
  email,
});

/** Everyone: 1,550 contacts, of whom 1,240 can be sent it, with every reason known ahead. */
export const everyonePreview: EmailCampaignAudiencePreview = {
  total: 1550,
  willReceive: 1240,
  willNot: 310,
  tooMany: false,
  reasons: [
    {
      reason: 'no_consent',
      count: 180,
      sample: [
        sample(11, 'Ada Okafor', 'ada@example.com'),
        sample(12, 'Ben Ruiz', 'ben@example.com'),
      ],
    },
    { reason: 'unsubscribed', count: 61, sample: [sample(13, 'Cara Lind', 'cara@example.com')] },
    { reason: 'no_email', count: 40, sample: [sample(14, 'Dev Patel', null)] },
    { reason: 'bounced', count: 12, sample: [sample(15, null, 'old@example.com')] },
    { reason: 'do_not_contact', count: 9, sample: [sample(16, 'Eli Stone', 'eli@example.com')] },
    { reason: 'no_time_zone', count: 5, sample: [sample(17, 'Fay Wong', 'fay@example.com')] },
    { reason: 'complained', count: 2, sample: [] },
    { reason: 'suppressed', count: 1, sample: [] },
  ],
  receiving: [
    sample(1, 'Grace Hall', 'grace@example.com'),
    sample(2, 'Hugo Park', 'hugo@example.com'),
  ],
  countedAt: at,
};

/** A tag's contacts: a smaller audience, with one reason. */
export const tagPreview: EmailCampaignAudiencePreview = {
  total: 86,
  willReceive: 80,
  willNot: 6,
  tooMany: false,
  reasons: [
    { reason: 'no_consent', count: 6, sample: [sample(11, 'Ada Okafor', 'ada@example.com')] },
  ],
  receiving: [sample(1, 'Grace Hall', 'grace@example.com')],
  countedAt: at,
};

export const listPreview: EmailCampaignAudiencePreview = {
  total: 420,
  willReceive: 420,
  willNot: 0,
  tooMany: false,
  reasons: [],
  receiving: [sample(2, 'Hugo Park', 'hugo@example.com')],
  countedAt: at,
};

export interface CampaignsWorld {
  campaigns: EmailCampaign[];
  folders: EmailCampaignFolder[];
  templates: MessageTemplate[];
  mailboxes: WorldMailbox[];
  /** Whether the reader may write campaigns, and whether they may send them. */
  canManage: boolean;
  canSend: boolean;
  /** Whether the reader may read mailboxes and the campaign ceiling. */
  canManageMailboxes: boolean;
  /** Whether the business profile has a postal address. */
  postalAddress: boolean;
  settings: EmailCampaignSettings;
  /** The tests that were asked for, as they were sent. */
  tests: { readonly id: string; readonly to: string[]; readonly contactId?: string | undefined }[];
  /** The recipients of each campaign that has started. */
  recipients: Record<string, EmailCampaignRecipient[]>;
  next: number;
}

export function worldOf(patch: Partial<CampaignsWorld> = {}): CampaignsWorld {
  return {
    campaigns: [],
    folders: [],
    templates: [],
    mailboxes: [calari, support],
    canManage: true,
    canSend: true,
    canManageMailboxes: true,
    postalAddress: true,
    settings: {
      dailyLimit: null,
      agencyDailyLimit: null,
      bounceRatePause: { percent: 5, afterSent: 100 },
      canManage: true,
    },
    tests: [],
    recipients: {},
    next: 100,
    ...patch,
  };
}

const held = (world: CampaignsWorld, campaign: EmailCampaign): EmailCampaign => ({
  ...campaign,
  canManage: world.canManage,
  canSend: world.canSend,
});
const find = (world: CampaignsWorld, id: string): EmailCampaign | undefined =>
  world.campaigns.find((campaign) => campaign.id === id);
const replace = (world: CampaignsWorld, next: EmailCampaign): EmailCampaign => {
  world.campaigns = world.campaigns.map((campaign) => (campaign.id === next.id ? next : campaign));
  return held(world, next);
};

export function listOf(
  world: CampaignsWorld,
  query: URLSearchParams | Record<string, string | undefined> = {},
): EmailCampaignList {
  const read = (key: string): string | undefined =>
    query instanceof URLSearchParams ? (query.get(key) ?? undefined) : query[key];
  const q = read('q')?.toLowerCase();
  const status = read('status');
  const folder = read('folder');
  const limit = Number(read('limit') ?? '50');
  const after = read('after');
  const matching = world.campaigns.filter(
    (campaign) =>
      (q === undefined || campaign.name.toLowerCase().includes(q)) &&
      (status === undefined || campaign.status === status) &&
      (folder === undefined ||
        (folder === 'root' ? campaign.folderId === null : campaign.folderId === folder)),
  );
  const from = after === undefined ? 0 : matching.findIndex((each) => each.id === after) + 1;
  const page = matching.slice(from, from + limit);
  const last = page.at(-1);
  return {
    items: page.map(summaryOf),
    next: from + limit < matching.length && last !== undefined ? last.id : null,
    canManage: world.canManage,
    canSend: world.canSend,
    total: matching.length,
  };
}

export const getOf = (world: CampaignsWorld, id: string): EmailCampaign | Refusal => {
  const campaign = find(world, id);
  return campaign === undefined ? GONE : held(world, campaign);
};

export function createCampaign(world: CampaignsWorld, body: unknown): EmailCampaign | Refusal {
  if (!world.canManage) return { status: 403, detail: 'You may not write campaigns.' };
  const input = createEmailCampaignInput.parse(body);
  world.next += 1;
  let made = campaignOf(world.next, { name: input.name, folderId: input.folderId });
  if (input.source.kind === 'template') {
    const { templateId } = input.source;
    const template = world.templates.find((each) => each.id === templateId);
    if (template === undefined) return { status: 404, detail: 'No such template.' };
    made = campaignOf(world.next, {
      name: input.name,
      folderId: input.folderId,
      subject: template.subject,
      preheader: template.preheader,
      content: template.content,
      templateId: template.id,
    });
  }
  if (input.source.kind === 'campaign') {
    const source = find(world, input.source.campaignId);
    if (source === undefined) return GONE;
    made = campaignOf(world.next, {
      name: input.name,
      folderId: input.folderId,
      mailboxId: source.mailboxId,
      fromName: source.fromName,
      replyTo: source.replyTo,
      subject: source.subject,
      preheader: source.preheader,
      content: source.content,
      audience: source.audience,
    });
  }
  world.campaigns = [made, ...world.campaigns];
  return held(world, made);
}

export function updateCampaign(
  world: CampaignsWorld,
  id: string,
  body: unknown,
): EmailCampaign | Refusal {
  const campaign = find(world, id);
  if (campaign === undefined) return GONE;
  const input = updateEmailCampaignInput.parse(body);
  if (campaign.status !== 'draft') return NOT_A_DRAFT;
  if (input.revision !== campaign.revision) return STALE;
  const { revision: _revision, ...rest } = input;
  return replace(
    world,
    campaignOf(0, {
      ...campaign,
      ...rest,
      revision: campaign.revision + 1,
      updatedAt: '2026-10-14T09:05:00.000Z',
    }),
  );
}

/** Someone else saves the draft meanwhile: its revision moves on under the page. */
export function editedElsewhere(world: CampaignsWorld, id: string, name: string): void {
  const campaign = find(world, id);
  if (campaign !== undefined)
    replace(world, { ...campaign, name, revision: campaign.revision + 1 });
}

export function deleteCampaign(
  world: CampaignsWorld,
  id: string,
  body?: { readonly revision?: number },
): Refusal | null {
  const campaign = find(world, id);
  if (campaign === undefined) return GONE;
  if (campaign.status !== 'draft') return NOT_A_DRAFT;
  if (body?.revision !== undefined && body.revision !== campaign.revision) return STALE;
  world.campaigns = world.campaigns.filter((each) => each.id !== id);
  return null;
}

export function moveCampaign(
  world: CampaignsWorld,
  id: string,
  body: unknown,
): EmailCampaign | Refusal {
  const campaign = find(world, id);
  if (campaign === undefined) return GONE;
  return replace(world, { ...campaign, folderId: moveEmailCampaignInput.parse(body).folderId });
}

const previewFor = (audience: EmailCampaignAudience): EmailCampaignAudiencePreview =>
  audience.kind === 'all' ? everyonePreview : audience.kind === 'tags' ? tagPreview : listPreview;

export function audienceOf(
  world: CampaignsWorld,
  id: string,
): EmailCampaignAudiencePreview | Refusal {
  const campaign = find(world, id);
  if (campaign === undefined) return GONE;
  if (campaign.audience === null) return { status: 422, detail: 'Choose who to send to.' };
  return previewFor(campaign.audience);
}

/** The checks as the server works them out for the draft (campaign-checks.ts). */
export function checksOf(world: CampaignsWorld, id: string): EmailCampaignChecks | Refusal {
  const campaign = find(world, id);
  if (campaign === undefined) return GONE;
  const items: EmailCampaignCheck[] = [];
  const { content } = campaign;
  if (campaign.subject.trim() === '')
    items.push({
      code: 'subject_missing',
      severity: 'blocking',
      message: 'Give the email a subject.',
    });
  else if (campaign.subject.length > 60)
    items.push({
      code: 'subject_long',
      severity: 'warning',
      count: campaign.subject.length,
      message: 'The subject is long.',
    });
  if (content.text.trim() === '' && (content.format === 'text' || content.html.trim() === ''))
    items.push({ code: 'body_missing', severity: 'blocking', message: 'Write the email.' });
  const token = `{{${EMAIL_UNSUBSCRIBE_MERGE_FIELD}}}`;
  const placed =
    content.text.includes(token) && (content.format === 'text' || content.html.includes(token));
  if (!placed)
    items.push({
      code: 'unsubscribe_line_added',
      severity: 'info',
      message: 'A standard unsubscribe line is added at its end.',
    });
  const preview = campaign.audience === null ? undefined : previewFor(campaign.audience);
  if (preview === undefined)
    items.push({
      code: 'audience_missing',
      severity: 'blocking',
      message: 'Choose who to send to.',
    });
  else if (preview.willNot > 0)
    items.push({
      code: 'some_will_not_receive',
      severity: 'warning',
      count: preview.willNot,
      message: `${String(preview.willNot)} will not get it.`,
    });
  const mailbox = world.mailboxes.find((each) => each.id === campaign.mailboxId);
  if (mailbox === undefined)
    items.push({
      code: 'mailbox_missing',
      severity: 'blocking',
      message: 'Choose the mailbox to send from.',
    });
  else if (!mailbox.forCampaigns)
    items.push({
      code: 'mailbox_not_for_campaigns',
      severity: 'blocking',
      message: 'This mailbox is not switched on for campaigns.',
    });
  if (!world.postalAddress)
    items.push({
      code: 'postal_address_missing',
      severity: 'warning',
      message: 'Your business profile has no postal address.',
    });
  const dailyCeiling =
    mailbox === undefined
      ? null
      : Math.min(mailbox.dailyCeiling, world.settings.dailyLimit ?? mailbox.dailyCeiling);
  if (dailyCeiling !== null && preview !== undefined) {
    const days = campaignSpreadDays(preview.willReceive, dailyCeiling, null);
    if (days > 1)
      items.push({
        code: 'spread_over_days',
        severity: 'warning',
        days,
        count: dailyCeiling,
        message: `This send will take about ${String(days)} days.`,
      });
  }
  return { canSend: items.every((item) => item.severity !== 'blocking'), dailyCeiling, items };
}

export function sendTest(
  world: CampaignsWorld,
  id: string,
  body: unknown,
): EmailCampaignTest | Refusal {
  if (find(world, id) === undefined) return GONE;
  const input = sendEmailCampaignTestInput.parse(body);
  if (!world.canSend && input.to.some((each) => each !== 'me')) return NOT_ALLOWED;
  const to = input.to.map((each) => (each === 'me' ? 'dana@harborlights.example' : each));
  world.tests.push({ id, to, contactId: input.contactId });
  return { queued: to.length, to };
}

const recipientOf = (
  number: number,
  name: string,
  patch: Partial<EmailCampaignRecipient> = {},
): EmailCampaignRecipient => ({
  contactId: contactId(number),
  name,
  email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
  status: 'pending',
  reason: null,
  fields: null,
  batch: null,
  bounced: false,
  unsubscribed: false,
  messageId: null,
  sentAt: null,
  ...patch,
});

/** A few recipients of a send that is under way: sent, bounced, skipped, waiting. */
export const recipientsUnderWay = (): EmailCampaignRecipient[] => [
  recipientOf(1, 'Grace Hall', { status: 'sent', batch: 1, sentAt: '2026-10-14T09:02:00.000Z' }),
  recipientOf(2, 'Hugo Park', {
    status: 'sent',
    batch: 1,
    bounced: true,
    sentAt: '2026-10-14T09:02:30.000Z',
  }),
  recipientOf(11, 'Ada Okafor', { status: 'skipped', reason: 'no_consent' }),
  recipientOf(18, 'Gus Moreno', {
    status: 'skipped',
    reason: 'missing_merge_values',
    fields: ['contact.firstName'],
  }),
  recipientOf(3, 'Ivy Chen', { status: 'queued', batch: 1 }),
  recipientOf(4, 'Jon Bell'),
];

function started(world: CampaignsWorld, campaign: EmailCampaign): EmailCampaign {
  const preview = campaign.audience === null ? listPreview : previewFor(campaign.audience);
  world.recipients[campaign.id] = recipientsUnderWay();
  return {
    ...campaign,
    status: 'sending',
    startedAt: '2026-10-14T09:01:00.000Z',
    counts: {
      audience: preview.total,
      pending: preview.willReceive - 3,
      queued: 1,
      sent: 2,
      skipped: preview.willNot,
      failed: 0,
    },
    waiting: { reason: 'mailbox_pacing', until: null },
  };
}

function gate(world: CampaignsWorld, id: string, revision?: number): EmailCampaign | Refusal {
  const campaign = find(world, id);
  if (campaign === undefined) return GONE;
  if (!world.canSend) return NOT_ALLOWED;
  if (revision !== undefined && revision !== campaign.revision) return STALE;
  return campaign;
}

export function sendCampaign(
  world: CampaignsWorld,
  id: string,
  body: unknown,
): EmailCampaign | Refusal {
  const input = sendEmailCampaignInput.parse(body);
  const campaign = gate(world, id, input.revision);
  if (isRefusal(campaign)) return campaign;
  const checks = checksOf(world, id);
  if (isRefusal(checks) || !checks.canSend)
    return { status: 422, detail: 'A blocking check is left.' };
  return replace(
    world,
    started(world, {
      ...campaign,
      revision: campaign.revision + 1,
      schedule: { sendAt: null, batches: input.batches },
    }),
  );
}

export function scheduleCampaign(
  world: CampaignsWorld,
  id: string,
  body: unknown,
): EmailCampaign | Refusal {
  const input = scheduleEmailCampaignInput.parse(body);
  const campaign = gate(world, id, input.revision);
  if (isRefusal(campaign)) return campaign;
  const checks = checksOf(world, id);
  if (isRefusal(checks) || !checks.canSend)
    return { status: 422, detail: 'A blocking check is left.' };
  return replace(world, {
    ...campaign,
    status: 'scheduled',
    revision: campaign.revision + 1,
    schedule: { sendAt: input.sendAt, batches: input.batches },
  });
}

/** The time comes: a scheduled campaign starts sending. */
export function startScheduled(world: CampaignsWorld, id: string): void {
  const campaign = find(world, id);
  if (campaign?.status === 'scheduled') replace(world, started(world, campaign));
}

export function pauseCampaign(world: CampaignsWorld, id: string): EmailCampaign | Refusal {
  const campaign = gate(world, id);
  if (isRefusal(campaign)) return campaign;
  if (campaign.status !== 'sending') return { status: 409, detail: 'It is not sending.' };
  return replace(world, { ...campaign, status: 'paused', waiting: null });
}

export function resumeCampaign(world: CampaignsWorld, id: string): EmailCampaign | Refusal {
  const campaign = gate(world, id);
  if (isRefusal(campaign)) return campaign;
  if (campaign.status !== 'paused') return { status: 409, detail: 'It is not paused.' };
  return replace(world, { ...campaign, status: 'sending', statusReason: null });
}

export function cancelCampaign(world: CampaignsWorld, id: string): EmailCampaign | Refusal {
  const campaign = gate(world, id);
  if (isRefusal(campaign)) return campaign;
  if (campaign.status === 'scheduled')
    return replace(world, { ...campaign, status: 'draft', schedule: null });
  if (campaign.status !== 'sending' && campaign.status !== 'paused')
    return { status: 409, detail: 'It cannot be cancelled now.' };
  world.recipients[id] = (world.recipients[id] ?? []).map((recipient) =>
    recipient.status === 'pending' || recipient.status === 'queued'
      ? { ...recipient, status: 'skipped', reason: 'cancelled' }
      : recipient,
  );
  return replace(world, {
    ...campaign,
    status: 'cancelled',
    waiting: null,
    finishedAt: '2026-10-14T09:10:00.000Z',
    counts: {
      ...campaign.counts,
      pending: 0,
      queued: 0,
      skipped: campaign.counts.skipped + campaign.counts.pending + campaign.counts.queued,
    },
  });
}

export function recipientsOf(
  world: CampaignsWorld,
  id: string,
  query: URLSearchParams,
): EmailCampaignRecipientList {
  const status = query.get('status');
  const reason = query.get('reason');
  return {
    items: (world.recipients[id] ?? []).filter(
      (recipient) =>
        (status === null || recipient.status === status) &&
        (reason === null || recipient.reason === reason),
    ),
    next: null,
  };
}

export function statsOf(world: CampaignsWorld, id: string): EmailCampaignStats | Refusal {
  const campaign = find(world, id);
  if (campaign === undefined) return GONE;
  const recipients = world.recipients[id] ?? [];
  const preview = campaign.audience === null ? listPreview : previewFor(campaign.audience);
  return {
    ...campaign.counts,
    skippedByReason:
      campaign.status === 'cancelled'
        ? [
            ...preview.reasons.map(({ reason, count }) => ({ reason, count })),
            {
              reason: 'cancelled',
              count: Math.max(1, campaign.counts.skipped - preview.willNot),
            },
          ]
        : preview.reasons.map(({ reason, count }) => ({ reason, count })),
    bounced: recipients.filter((recipient) => recipient.bounced).length,
    hardBounced: recipients.filter((recipient) => recipient.bounced).length,
    unsubscribed: recipients.filter((recipient) => recipient.unsubscribed).length,
    batches: campaign.schedule?.batches === null || campaign.schedule === null ? 0 : 1,
    countedAt: '2026-10-14T09:06:00.000Z',
  };
}

export const foldersOf = (world: CampaignsWorld): EmailCampaignFolderList => ({
  canManage: world.canManage,
  items: world.folders.map((folder) => ({
    ...folder,
    campaignCount: world.campaigns.filter((campaign) => campaign.folderId === folder.id).length,
  })),
  counts: {
    all: world.campaigns.length,
    unfiled: world.campaigns.filter((campaign) => campaign.folderId === null).length,
  },
});

export function createFolder(world: CampaignsWorld, body: unknown): EmailCampaignFolder {
  const input = createEmailCampaignFolderInput.parse(body);
  world.next += 1;
  const made = folderOf(world.next, input.name, { parentId: input.parentId });
  world.folders = [...world.folders, made];
  return made;
}

export function updateFolder(
  world: CampaignsWorld,
  id: string,
  body: unknown,
): EmailCampaignFolder | Refusal {
  const folder = world.folders.find((each) => each.id === id);
  if (folder === undefined) return { status: 404, detail: 'No such folder.' };
  const input = updateEmailCampaignFolderInput.parse(body);
  if (input.revision !== folder.revision) return STALE;
  const next: EmailCampaignFolder = {
    ...folder,
    name: input.name ?? folder.name,
    parentId: input.parentId === undefined ? folder.parentId : input.parentId,
    revision: folder.revision + 1,
  };
  world.folders = world.folders.map((each) => (each.id === id ? next : each));
  return next;
}

/** A removed folder's campaigns and folders move to its parent; nothing is deleted. */
export function removeFolder(world: CampaignsWorld, id: string): Refusal | null {
  const folder = world.folders.find((each) => each.id === id);
  if (folder === undefined) return { status: 404, detail: 'No such folder.' };
  world.folders = world.folders
    .filter((each) => each.id !== id)
    .map((each) => (each.parentId === id ? { ...each, parentId: folder.parentId } : each));
  world.campaigns = world.campaigns.map((campaign) =>
    campaign.folderId === id ? { ...campaign, folderId: folder.parentId } : campaign,
  );
  return null;
}

export function updateSettings(world: CampaignsWorld, body: unknown): EmailCampaignSettings {
  world.settings = { ...world.settings, ...emailCampaignSettingsInput.parse(body) };
  return world.settings;
}
