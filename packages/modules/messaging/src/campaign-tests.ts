// A test of a campaign: the email as it stands, sent to the person's own address or to a
// few named ones, never to the audience. It does not go through the outbound pipeline,
// which sends only to contacts: the worker, which alone opens a mailbox's password, hands
// it to the mail server directly. So a test is not a message in anyone's conversation, is
// not counted in the campaign, and carries no unsubscribe link that works: its unsubscribe
// line says so.
import {
  defineCommand,
  defineTask,
  requireBusiness,
  type Command,
  type Task,
  type TaskReference,
} from '@repo/commands';
import {
  connectMailboxInput,
  EMAIL_CAMPAIGN_LIMITS,
  EMAIL_UNSUBSCRIBE_MERGE_FIELD,
  publicId,
  renderMessageTemplate,
  sendEmailCampaignTestInput,
  type ConditionValues,
  type EmailCampaignTest,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import type { MailboxSubmitter } from '@repo/mail';
import type { Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import { MAILBOX_CREDENTIALS } from './attempts.js';
import { htmlMergeValues, htmlWithUnsubscribe, textWithUnsubscribe } from './campaign-rules.js';
import { requireCampaign, type CampaignOptions } from './campaign-store.js';
import { requireSend } from './campaigns.js';

const testInput = sendEmailCampaignTestInput.safeExtend({ id: publicId('email_campaign') });

export const sendCampaignTestReference = {
  name: 'campaigns.send_test',
  data: z.strictObject({ testId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/** What a test shows where a recipient's own unsubscribe address would be. */
export const TEST_UNSUBSCRIBE_NOTE = 'https://unsubscribe.invalid/this-is-a-test';

const invalid = (path: string, code: string, message: string) =>
  new ValidationError([{ path, code, message }]);

/**
 * Text as a test shows it: filled in from the contact's values when it fills in
 * completely, and otherwise as written, so a missing value is seen rather than hidden.
 */
function testText(body: string, values: ConditionValues): string {
  const placed = { [EMAIL_UNSUBSCRIBE_MERGE_FIELD]: TEST_UNSUBSCRIBE_NOTE };
  const filled = renderMessageTemplate({ subject: '', body }, { ...values, ...placed });
  if (filled.ok) return filled.body;
  const kept = Object.fromEntries(filled.fields.map((field) => [field, `{{${field}}}`]));
  const partly = renderMessageTemplate({ subject: '', body }, { ...values, ...kept, ...placed });
  return partly.ok ? partly.body : body;
}

export function createCampaignTestCommand(
  options: CampaignOptions,
): Command<typeof testInput, EmailCampaignTest> {
  return defineCommand({
    name: 'campaign.test',
    permission: 'campaigns.manage',
    input: testInput,
    // How many, and to whom only as "me" or not: never an address.
    audit: (input) => ({
      id: input.id,
      addresses: input.to.length,
      onlyMe: input.to.every((address) => address === 'me'),
      contactId: input.contactId ?? null,
    }),
    async handle(trx, input, command): Promise<EmailCampaignTest> {
      const businessId = requireBusiness(command.context);
      const row = await requireCampaign(trx, command.context, input.id);
      // Writing a campaign lets a person see it in their own inbox; sending it to anyone
      // else, even as a test, is sending.
      if (input.to.some((address) => address !== 'me')) requireSend(command);
      if (row.mailbox_id === null)
        throw invalid('', 'mailbox_missing', 'Choose the mailbox to send from first.');
      if (row.subject.trim() === '' || row.body_text.trim() === '')
        throw invalid('', 'body_missing', 'Write the subject and the email first.');
      const { userId } = command.context;
      const own =
        input.to.includes('me') && userId !== undefined
          ? (await options.team?.(trx, [userId]))?.get(userId)?.email
          : undefined;
      if (input.to.includes('me') && own === undefined)
        throw invalid('/to', 'no_own_address', 'There is no address of your own to send to here.');
      const addresses = [
        ...new Set(
          input.to.map((address) => (address === 'me' ? (own ?? '') : address).toLowerCase()),
        ),
      ];
      let contactId: string | null = null;
      if (input.contactId !== undefined) {
        const contact = await trx
          .selectFrom('crm.contacts')
          .select('id')
          .where('id', '=', parsePublicId('contact', input.contactId) ?? '')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (contact === undefined) throw new NotFoundError('Contact', input.contactId);
        contactId = contact.id;
      }
      // Yesterday's requests are of no use to anyone; the last hour's are the limit.
      await trx
        .deleteFrom('messaging.email_campaign_tests')
        .where('created_at', '<', sql<Date>`now() - interval '1 day'`)
        .execute();
      const { recent } = await trx
        .selectFrom('messaging.email_campaign_tests')
        .select((eb) => eb.fn.countAll<string>().as('recent'))
        .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
        .executeTakeFirstOrThrow();
      if (Number(recent) >= EMAIL_CAMPAIGN_LIMITS.testsPerHour)
        throw invalid(
          '',
          'too_many_tests',
          `A business sends at most ${String(EMAIL_CAMPAIGN_LIMITS.testsPerHour)} tests an hour. Try again later.`,
        );
      const { id } = await trx
        .insertInto('messaging.email_campaign_tests')
        .values({
          business_id: businessId,
          campaign_id: row.id,
          addresses,
          contact_id: contactId,
          requested_by_kind: command.context.actorKind,
          requested_by_id: command.context.actorId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      command.enqueue(sendCampaignTestReference, { testId: id });
      await command.emit({
        type: 'campaign.test_requested',
        subject: { kind: 'email_campaign', id: row.id },
        payload: { addresses: addresses.length },
      });
      return { queued: addresses.length, to: addresses };
    },
  });
}

/** Worker-only: opens the mailbox's credentials and hands the test to its mail server. */
export function createSendCampaignTestTask(
  vault: Vault,
  submitter: MailboxSubmitter,
  options: CampaignOptions,
): Task<typeof sendCampaignTestReference.data> {
  return defineTask({
    ...sendCampaignTestReference,
    async run({ testId }, { invocation, services }) {
      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        const test = await trx
          .selectFrom('messaging.email_campaign_tests as test')
          .innerJoin('messaging.email_campaigns as campaign', (join) =>
            join
              .onRef('campaign.business_id', '=', 'test.business_id')
              .onRef('campaign.id', '=', 'test.campaign_id'),
          )
          .innerJoin('messaging.mailboxes as mailbox', (join) =>
            join
              .onRef('mailbox.business_id', '=', 'campaign.business_id')
              .onRef('mailbox.id', '=', 'campaign.mailbox_id'),
          )
          .select([
            'test.addresses',
            'test.contact_id',
            'campaign.subject',
            'campaign.body_text',
            'campaign.body_html',
            'campaign.preheader',
            'campaign.from_name',
            'campaign.reply_to',
            'mailbox.secret_id',
            'mailbox.email_address',
            'mailbox.display_name',
          ])
          .where('test.id', '=', testId)
          .where('test.status', '=', 'queued')
          .forUpdate('test')
          .executeTakeFirst();
        if (test === undefined) return null;
        // Taken before anything is handed over: a job that dies half-way is not run again,
        // so nobody gets a test twice. It counts as failed until every address accepted it.
        await trx
          .updateTable('messaging.email_campaign_tests')
          .set({ status: 'failed', finished_at: sql`now()` })
          .where('id', '=', testId)
          .execute();
        const values = test.contact_id === null ? {} : await options.values(trx, test.contact_id);
        const credentials = connectMailboxInput.parse(
          JSON.parse(await vault.read(trx, test.secret_id, MAILBOX_CREDENTIALS)),
        );
        return {
          addresses: test.addresses,
          login: credentials.smtp,
          from: { address: test.email_address, name: test.from_name ?? test.display_name },
          replyTo: test.reply_to,
          subject: `[Test] ${testText(test.subject, values)}`.replace(/[\r\n]+/g, ' '),
          text: testText(textWithUnsubscribe(test.body_text), values),
          html:
            test.body_html === null
              ? undefined
              : testText(
                  htmlWithUnsubscribe(test.body_html, test.preheader),
                  htmlMergeValues(values),
                ),
        };
      });
      if (prepared === null) return;
      let delivered = 0;
      for (const [index, to] of prepared.addresses.entries()) {
        const receipt = await submitter
          .submit(prepared.login, prepared.from, {
            messageId: `<crm-campaign-test.${testId}.${String(index)}@crm.invalid>`,
            to,
            subject: prepared.subject,
            text: prepared.text,
            ...(prepared.html === undefined ? {} : { html: prepared.html }),
            ...(prepared.replyTo === null ? {} : { replyTo: prepared.replyTo }),
          })
          .catch(() => ({ outcome: 'unknown' as const }));
        if (receipt.outcome === 'accepted') delivered += 1;
      }
      if (delivered < prepared.addresses.length) return;
      await withTenant(services.db, invocation.context, (trx) =>
        trx
          .updateTable('messaging.email_campaign_tests')
          .set({ status: 'sent', finished_at: sql`now()` })
          .where('id', '=', testId)
          .execute(),
      );
    },
  });
}
