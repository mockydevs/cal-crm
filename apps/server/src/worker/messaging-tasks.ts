import type { AnyTask } from '@repo/commands';
import type { Database } from '@repo/db';
import type { MailboxSubmitter } from '@repo/mail';
import {
  createApplySmsWebhookTask,
  createCampaignTasks,
  createSendCampaignTestTask,
  createDispatchOutboundTask,
  emailVerificationAdmission,
  createSmtpOutbound,
  createSyncSmsNumbersTask,
  createEndCallTask,
  createIssueVoiceGrantTask,
  createPlaceCallTask,
  createTwilioCallProvider,
  createSetUpCallingTask,
  createTwilioOutbound,
  createVoiceTransport,
  createVerifySmsConnectionTask,
  routeOutboundByChannel,
  type CampaignOptions,
  type OutboundAttachmentReader,
  type ReadCallGrants,
  type TwilioTransport,
} from '@repo/module-messaging';
import type { Vault } from '@repo/module-vault';

/** Provider tasks use the same dispatch job and its canonical admission rules. */
export function createMessagingDeliveryTasks(
  vault: Vault,
  twilio: TwilioTransport,
  smtp: MailboxSubmitter,
  db: Database,
  publicUrl: string,
  /** Reads a file an email carries; left out, such an email is refused, never sent bare. */
  readAttachment?: OutboundAttachmentReader,
  /**
   * What email campaigns need. With it, this worker runs campaigns and sends their tests;
   * left out, it delivers what is queued and starts no campaign.
   */
  campaigns?: CampaignOptions,
): readonly AnyTask[] {
  const outbound = routeOutboundByChannel({
    email: createSmtpOutbound(vault, smtp, db, publicUrl, readAttachment),
    sms: createTwilioOutbound(vault, twilio, db, publicUrl),
  });
  return [
    createVerifySmsConnectionTask(vault, twilio),
    createSyncSmsNumbersTask(vault, twilio),
    createApplySmsWebhookTask(vault, publicUrl),
    createDispatchOutboundTask(outbound.sender, emailVerificationAdmission(outbound.admission)),
    ...(campaigns === undefined
      ? []
      : [...createCampaignTasks(campaigns), createSendCampaignTestTask(vault, smtp, campaigns)]),
  ];
}

/**
 * Voice work that opens the business's Twilio credentials: setting up calling, signing a
 * person's calling token, and placing and ending calls. `readGrants` rechecks that the
 * person may still call before a token is signed or a call is placed.
 */
export function createVoiceTasks(options: {
  readonly vault: Vault;
  readonly readGrants: ReadCallGrants;
  readonly db: Database;
  readonly publicUrl: string;
  readonly fetcher?: typeof fetch | undefined;
}): readonly AnyTask[] {
  const { vault, readGrants, db, publicUrl, fetcher } = options;
  const voice = createVoiceTransport(fetcher === undefined ? {} : { fetcher });
  const calls = createTwilioCallProvider({ db, vault, transport: voice, publicUrl });
  return [
    createSetUpCallingTask(vault, voice),
    createIssueVoiceGrantTask(vault, readGrants),
    createPlaceCallTask(calls, readGrants),
    createEndCallTask(calls),
  ];
}
