// "Replied to automation": a message.received trigger
// limited to replies to the automations it names. A reply is to the automation whose run
// sent the contact's most recent automated message on the same channel. Real Postgres, real
// sends through the email step, and the engine's own match command.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, type Harness, type Published } from '../test/workflows.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const created = { id: 'created', type: 'contact.created', config: {} } as const;

/** Sends one email, then waits; a reply from the contact ends it. */
const sales: AutomationDocumentInput = {
  name: 'DJ sales',
  triggers: [created],
  stopWhen: [{ event: 'message.received', from: 'contact' }],
  start: 'send',
  steps: {
    send: {
      type: 'email.send',
      config: { subject: 'Your DJ quote', body: 'Hi {{contact.firstName}}, here is the quote.' },
      next: 'pause',
    },
    pause: { type: 'wait', config: { duration: 'P2D' } },
  },
};

/** Sends one email, then waits; replies do not end it. */
const education: AutomationDocumentInput = {
  name: 'Education',
  triggers: [created],
  start: 'send',
  steps: {
    send: {
      type: 'email.send',
      config: { subject: 'Planning tips', body: 'Hi {{contact.firstName}}, a tip.' },
      next: 'pause',
    },
    pause: { type: 'wait', config: { duration: 'P3D' } },
  },
};

/** What the reply starts: here a wait stands in for the notification step. */
const notify = (repliedTo: readonly string[] | undefined): AutomationDocumentInput => ({
  name: 'Sales reply: notify',
  triggers: [
    {
      id: 'replied',
      type: 'message.received',
      config: repliedTo === undefined ? {} : { repliedTo: [...repliedTo] },
    },
  ],
  settings: { reEnrollment: 'after_finished' },
  start: 'tell',
  steps: { tell: { type: 'wait', config: { duration: 'PT1M' } } },
});

// A message arriving in the contact's conversation, as messaging emits it.
const receive = defineCommand({
  name: 'test.message_received',
  permission: 'contacts.manage',
  input: z.strictObject({ recordId: z.uuid(), channel: z.enum(['email', 'sms']) }),
  async handle(_trx, input, command) {
    return command.emit({
      type: 'message.received',
      subject: { kind: 'message', id: randomUUID() },
      records: [input.recordId],
      payload: { channel: input.channel },
    });
  },
});

/** A business that can send email, with the three automations published. */
async function scene(replies: (ids: { sales: string; education: string }) => readonly string[]) {
  const tenant = await h.business();
  await h.database.as('postgres', async (sql) => {
    await sql.query(
      `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)
       on conflict (business_id) do update set quiet_hours_enabled = false`,
      [tenant.businessId],
    );
    const [secret] = await sql.query<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
       returning id`,
      [tenant.agencyId, tenant.businessId],
    );
    const [account] = await sql.query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values ($1, 'email', 'Sales', 'active') returning id`,
      [tenant.businessId],
    );
    const address = `${randomUUID()}@example.test`;
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
         smtp_port, smtp_security, smtp_username, imap_host, imap_port, imap_security,
         imap_username, secret_id, use_for_conversations)
       values ($1, $2, $3, 'password', 'mail.example.test', 587, 'starttls', $3,
         'mail.example.test', 993, 'tls', $3, $4, true)`,
      [tenant.businessId, account?.id, address, secret?.id],
    );
  });
  const selling = await h.publish(tenant, sales);
  const teaching = await h.publish(tenant, education);
  const telling = await h.publish(
    tenant,
    notify(replies({ sales: selling.id, education: teaching.id })),
  );
  return { tenant, selling, teaching, telling };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** A contact who may be emailed, in both sequences, neither of which has sent yet. */
async function lead(s: Scene, firstName = 'Ada') {
  const made = await h.enrol(s.tenant, firstName);
  await h.database.as('postgres', (sql) =>
    sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'marketing', 'granted', 'user', 'user')`,
      [s.tenant.businessId, made.contactId],
    ),
  );
  const runs = await h.database.withTenant(s.tenant, (sql) =>
    sql.query<{ id: string; automation_id: string }>(
      'select id, automation_id from automation.enrolments where record_id = $1',
      [made.contactId],
    ),
  );
  const runOf = (published: Published) =>
    runs.find((run) => run.automation_id === published.automationId)?.id ?? '';
  return {
    ...made,
    sales: runOf(s.selling),
    education: runOf(s.teaching),
    /** Runs the sequence's send step: its email is queued now. */
    send: async (which: 'sales' | 'education') => {
      const run = which === 'sales' ? runOf(s.selling) : runOf(s.teaching);
      expect(await h.step(s.tenant, run)).toBe('ran');
      expect(await h.run(s.tenant, run)).toMatchObject({
        status: 'running',
        current_step: 'pause',
      });
    },
  };
}

/** The contact writes in, and the event is matched as the worker matches it. */
async function reply(s: Scene, contactId: string, channel: 'email' | 'sms' = 'email') {
  const eventId = await runCommand(
    h.services,
    receive,
    { recordId: contactId, channel },
    { context: { ...s.tenant, correlationId: randomUUID() }, permissions: 'all' },
  );
  const matched = await h.match(s.tenant, eventId);
  const told = await h.database.withTenant(s.tenant, (sql) =>
    sql.query<{ id: string; trigger_key: string | null }>(
      'select id, trigger_key from automation.enrolments where automation_id = $1 and record_id = $2',
      [s.telling.automationId, contactId],
    ),
  );
  return { matched, told };
}

it('starts on a reply to the sales email, which the same reply has just stopped', async () => {
  const s = await scene((ids) => [ids.sales]);
  const ada = await lead(s);
  await ada.send('education');
  await ada.send('sales');
  // The step's own send is what the match reads: its key names the run that sent it.
  const keys = await h.database.withTenant(s.tenant, (sql) =>
    sql.query<{ idempotency_key: string; status: string }>(
      'select idempotency_key, status from messaging.messages order by created_at, id',
    ),
  );
  expect(keys).toEqual([
    { idempotency_key: `automation:${ada.education}:send:0`, status: 'queued' },
    { idempotency_key: `automation:${ada.sales}:send:0`, status: 'queued' },
  ]);

  const { matched, told } = await reply(s, ada.contactId);
  // One event: the stop ended the sales run first, and the notify automation still started.
  expect(matched).toMatchObject({ enrolled: 1, exited: 1 });
  expect(await h.run(s.tenant, ada.sales)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:message.received',
  });
  expect(told).toEqual([{ id: expect.any(String) as string, trigger_key: 'replied' }]);
  // Education neither stopped nor counted as what was replied to.
  expect(await h.run(s.tenant, ada.education)).toMatchObject({ status: 'running' });

  // A second reply is still a reply to the sales email, though its run ended long since.
  await h.step(s.tenant, told[0]?.id ?? '');
  await h.step(s.tenant, told[0]?.id ?? '', new Date(Date.now() + 120_000));
  expect((await reply(s, ada.contactId)).matched).toMatchObject({ enrolled: 1, exited: 0 });
});

it('does not start when the last automated message came from another automation', async () => {
  const s = await scene((ids) => [ids.sales]);
  const ada = await lead(s);
  await ada.send('sales');
  await ada.send('education');
  const { matched, told } = await reply(s, ada.contactId);
  // The reply still stops the sales run; it is only not a reply to it.
  expect(matched).toMatchObject({ enrolled: 0, exited: 1 });
  expect(told).toEqual([]);
});

it('starts for any of the automations it names', async () => {
  const s = await scene((ids) => [ids.sales, ids.education]);
  const ada = await lead(s);
  await ada.send('sales');
  await ada.send('education');
  expect((await reply(s, ada.contactId)).told).toHaveLength(1);
});

it('does not start when no automated message was ever sent to the contact', async () => {
  const s = await scene((ids) => [ids.sales]);
  const ada = await lead(s);
  const { matched, told } = await reply(s, ada.contactId);
  expect(matched).toMatchObject({ enrolled: 0, exited: 1 });
  expect(told).toEqual([]);
});

it("reads only the replying contact's own messages", async () => {
  const s = await scene((ids) => [ids.sales]);
  const ada = await lead(s, 'Ada');
  const grace = await lead(s, 'Grace');
  await grace.send('sales');
  await ada.send('education');
  // Grace was sent the sales email; Ada, who replies, was not.
  expect((await reply(s, ada.contactId)).told).toEqual([]);
  expect((await reply(s, grace.contactId)).told).toHaveLength(1);
});

it("never matches through another business's automation or messages", async () => {
  const theirs = await scene((ids) => [ids.sales]);
  const other = await lead(theirs);
  await other.send('sales');
  // This business names the other's sales automation, and sends from its own.
  const s = await scene(() => [theirs.selling.id]);
  const ada = await lead(s);
  await ada.send('sales');
  expect((await reply(s, ada.contactId)).told).toEqual([]);
  // The other business's own reply is matched as ever.
  expect((await reply(theirs, other.contactId)).told).toHaveLength(1);
});

it('matches a reply to the last automated message on its own channel only', async () => {
  const s = await scene((ids) => [ids.sales]);
  const ada = await lead(s);
  await ada.send('sales');
  // A text arrives, and no automated text was ever sent: not a reply to the sales email.
  expect((await reply(s, ada.contactId, 'sms')).told).toEqual([]);

  // Education then texts the contact, as its text step would record it.
  await h.database.as('postgres', async (sql) => {
    const [account] = await sql.query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values ($1, 'sms', 'Front desk', 'active') returning id`,
      [s.tenant.businessId],
    );
    await sql.query(
      `insert into messaging.messages
         (business_id, conversation_id, channel, channel_account_id, direction, status, body_text,
          idempotency_key, author_kind, sent_at)
       select c.business_id, c.id, 'sms', $2, 'outbound', 'sent', 'A tip by text.', $3, 'system', now()
       from messaging.conversations c where c.contact_id = $1`,
      [ada.contactId, account?.id, `automation:${ada.education}:text:0`],
    );
  });
  // By text the last automated message is education's; by email it is still the sales one.
  expect((await reply(s, ada.contactId, 'sms')).told).toEqual([]);
  expect((await reply(s, ada.contactId, 'email')).told).toHaveLength(1);
});

it('skips an automated message that failed: nobody replies to what never arrived', async () => {
  const s = await scene((ids) => [ids.sales]);
  const ada = await lead(s);
  await ada.send('sales');
  await ada.send('education');
  await h.database.as('postgres', (sql) =>
    sql.query(
      `update messaging.messages set status = 'failed', failed_at = now(), error_code = 'smtp_refused'
       where idempotency_key = $1`,
      [`automation:${ada.education}:send:0`],
    ),
  );
  expect((await reply(s, ada.contactId)).told).toHaveLength(1);
});

it('ignores messages people sent by hand when it looks for the last automated one', async () => {
  const s = await scene((ids) => [ids.sales]);
  const ada = await lead(s);
  await ada.send('sales');
  await h.database.as('postgres', (sql) =>
    sql.query(
      `insert into messaging.messages
         (business_id, conversation_id, channel, channel_account_id, direction, status, body_text,
          idempotency_key, author_kind, sent_at)
       select m.business_id, m.conversation_id, 'email', m.channel_account_id, 'outbound', 'sent',
              'A note from Mia.', 'reply:' || gen_random_uuid(), 'user', now()
       from messaging.messages m where m.idempotency_key = $1`,
      [`automation:${ada.sales}:send:0`],
    ),
  );
  expect((await reply(s, ada.contactId)).told).toHaveLength(1);
});

it('leaves a trigger without the filter as it was: every reply starts it', async () => {
  const s = await scene((ids) => [ids.sales]);
  const tenant = s.tenant;
  const open = await h.publish(tenant, notify(undefined));
  const ada = await lead(s);
  const { matched } = await reply(s, ada.contactId);
  expect(matched).toMatchObject({ enrolled: 1, exited: 1 });
  const started = await h.database.withTenant(tenant, (sql) =>
    sql.query('select 1 from automation.enrolments where automation_id = $1', [open.automationId]),
  );
  expect(started).toHaveLength(1);
});
