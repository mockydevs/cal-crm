// Settings.sendingWindow, in the engine. A message step reached outside the window waits at
// the step until the window opens, in the zone the automation's settings name, across the
// days the clocks change; steps that are not messages are not held; and messaging's quiet
// hours still hold the message afterwards. Every moment is a fixed date passed to the step,
// so nothing depends on when this runs.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { readRun } from './history.js';
import { readAutomationStats } from './stats.js';
import { testRunCommand } from './test-runs.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Settings = NonNullable<AutomationDocumentInput['settings']>;

const office: NonNullable<Settings['sendingWindow']> = {
  days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  start: '09:00',
  end: '17:00',
};

interface Scene {
  readonly tenant: Tenant;
  readonly id: string;
  readonly enrolmentId: string;
  readonly contactId: string;
  messages(): Promise<{ status: string; error_code: string | null; subject: string | null }[]>;
  steps(): Promise<{ step: string; status: string; resumes: boolean; explanation: string }[]>;
  /** Each step row as a test run's trace names it: a wait with why, or an action. */
  taken(): Promise<{ step: string; waited: boolean; explanation: string }[]>;
}

/**
 * A business in a time zone, with a mailbox, a template and one contact who agreed to
 * marketing email, enrolled in an automation that tags the contact and then writes to them.
 */
async function scene(options: {
  businessZone: string;
  contactZone?: string;
  settings: Settings;
  /** Quiet at every hour, so whether a message is held never depends on the clock. */
  alwaysQuiet?: boolean;
}): Promise<Scene> {
  const tenant = await h.business();
  const made = await h.database.as('postgres', async (sql) => {
    const one = async (text: string, values: readonly unknown[]): Promise<string> => {
      const [row] = await sql.query<{ id: string }>(text, values);
      if (row === undefined) throw new Error('The insert returns its id.');
      return row.id;
    };
    await sql.query('update tenancy.businesses set timezone = $2 where id = $1', [
      tenant.businessId,
      options.businessZone,
    ]);
    await sql.query(
      `insert into messaging.settings
         (business_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end)
       values ($1, $2, '00:00', '00:00')
       on conflict (business_id) do update
         set quiet_hours_enabled = excluded.quiet_hours_enabled,
             quiet_hours_start = excluded.quiet_hours_start,
             quiet_hours_end = excluded.quiet_hours_end`,
      [tenant.businessId, options.alwaysQuiet === true],
    );
    const secret = await one(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
       returning id`,
      [tenant.agencyId, tenant.businessId],
    );
    const mailbox = await one(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values ($1, 'email', 'Hello', 'active') returning id`,
      [tenant.businessId],
    );
    const address = `${randomUUID()}@example.test`;
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
         smtp_port, smtp_security, smtp_username, imap_host, imap_port, imap_security,
         imap_username, secret_id, use_for_conversations)
       values ($1, $2, $3, 'password', 'mail.example.test', 587, 'starttls', $3,
         'mail.example.test', 993, 'tls', $3, $4, true)`,
      [tenant.businessId, mailbox, address, secret],
    );
    const template = await one(
      `insert into messaging.templates (business_id, name, subject, body, created_by_kind)
       values ($1, 'Guide', 'Your guide', 'Hi {{contact.firstName}}', 'user') returning id`,
      [tenant.businessId],
    );
    const tag = await one(
      `insert into crm.tags (business_id, name, created_by_kind) values ($1, 'Written to', 'user') returning id`,
      [tenant.businessId],
    );
    return { template: toPublicId('template', template), tag: toPublicId('tag', tag) };
  });
  const document: AutomationDocumentInput = {
    name: 'Office hours',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'mark',
    steps: {
      mark: { type: 'tag.add', config: { tag: made.tag }, next: 'write' },
      write: { type: 'email.send', config: { template: made.template }, next: 'pause' },
      pause: { type: 'wait', config: { duration: 'PT1H' } },
    },
    settings: options.settings,
  };
  const { id } = await h.publish(tenant, document);
  const { enrolments, contactId } = await h.enrol(tenant, 'Ada');
  await h.database.as('postgres', async (sql) => {
    await sql.query('update crm.contacts set timezone = $2 where id = $1', [
      contactId,
      options.contactZone ?? null,
    ]);
    await sql.query(
      `insert into messaging.consents
         (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'marketing', 'granted', 'user', 'user')`,
      [tenant.businessId, contactId],
    );
  });
  return {
    tenant,
    id,
    contactId,
    enrolmentId: enrolments[0] ?? '',
    messages: () =>
      h.database.withTenant(tenant, (sql) =>
        sql.query(
          `select status, error_code, subject from messaging.messages
           where direction = 'outbound' order by id`,
        ),
      ),
    steps: () =>
      h.database.withTenant(tenant, (sql) =>
        sql.query(
          `select step_key as step, status, resumes, explanation from automation.step_runs
           order by started_at, id`,
        ),
      ),
    taken: () =>
      h.database.withTenant(tenant, (sql) =>
        sql.query(
          `select step_key as step, explanation,
                  (input ? 'held' or input ->> 'type' = 'wait') as waited
           from automation.step_runs order by started_at, id`,
        ),
      ),
  };
}

const at = (iso: string) => new Date(iso);

it('holds a message reached outside the window until it opens, across the clocks going forward', async () => {
  // New York. Friday 6 March 2026, 18:00 EST: closed until Monday, by when the clocks have
  // gone forward (Sunday 8 March), so 09:00 on Monday is 13:00 UTC, not 14:00.
  const s = await scene({
    businessZone: 'America/New_York',
    settings: { sendingWindow: office },
  });
  const friday = at('2026-03-06T23:00:00Z');
  // The tag is not a message: it is added at once, outside the window.
  expect(await h.step(s.tenant, s.enrolmentId, friday)).toBe('ran');
  expect(await h.run(s.tenant, s.enrolmentId)).toMatchObject({
    status: 'running',
    current_step: 'write',
  });
  // The email waits at its own step, and nothing is handed to messaging.
  expect(await h.step(s.tenant, s.enrolmentId, friday)).toBe('ran');
  const monday = at('2026-03-09T13:00:00Z');
  expect(await h.run(s.tenant, s.enrolmentId)).toMatchObject({
    status: 'waiting',
    current_step: 'write',
    wake_at: monday,
  });
  expect(await s.messages()).toEqual([]);
  expect(await s.steps()).toEqual([
    { step: 'mark', status: 'succeeded', resumes: false, explanation: 'The tag was added.' },
    {
      step: 'write',
      status: 'waiting',
      resumes: false,
      explanation:
        'Outside the sending window (09:00 to 17:00, America/New_York), so it waits until 2026-03-09T13:00:00.000Z.',
    },
  ]);
  // The run says where it is and when it goes on; the step says what held it.
  const runId = toPublicId('automation_enrolment', s.enrolmentId);
  const held = await withTenant(h.db, s.tenant, (trx) => readRun(trx, runId));
  expect(held).toMatchObject({
    status: 'waiting',
    wakeAt: monday.toISOString(),
    currentAction: { step: 'write', type: 'email.send' },
  });
  expect(held.steps[1]).toMatchObject({
    status: 'waiting',
    finishedAt: null,
    input: { held: 'sending_window' },
    output: { wakeAt: monday.toISOString() },
  });
  // The job, woken early, does nothing; and a second before the opening is still early.
  expect(await h.step(s.tenant, s.enrolmentId, at('2026-03-09T12:59:59Z'))).toBe('skipped');
  expect(await s.messages()).toEqual([]);

  // At the opening it is sent: one message, and the wait before it is over.
  expect(await h.step(s.tenant, s.enrolmentId, monday)).toBe('ran');
  expect(await s.messages()).toEqual([
    { status: 'queued', error_code: null, subject: 'Your guide' },
  ]);
  expect(await s.steps()).toMatchObject([
    { step: 'mark', status: 'succeeded' },
    { step: 'write', status: 'succeeded', resumes: false },
    {
      step: 'write',
      status: 'succeeded',
      resumes: true,
      explanation: 'The email was queued to send.',
    },
  ]);
  expect(await h.run(s.tenant, s.enrolmentId)).toMatchObject({
    status: 'running',
    current_step: 'pause',
    wake_at: null,
  });
  // One visit to the step, though it has two rows: held, then sent.
  const stats = await withTenant(h.db, s.tenant, (trx) => readAutomationStats(trx, s.id));
  expect(stats.steps.find((step) => step.step === 'write')?.allTime).toEqual({
    entered: 1,
    completed: 1,
    failed: 0,
    waiting: 0,
    skipped: 0,
  });
  expect(await h.differences()).toEqual([]);
});

it('is the same in a test run: the same steps at the same moments, the wait for the window included', async () => {
  const s = await scene({ businessZone: 'America/New_York', settings: { sendingWindow: office } });
  const friday = at('2026-03-06T23:00:00Z');
  const monday = at('2026-03-09T13:00:00Z');
  const dry = await runCommand(
    h.services,
    testRunCommand,
    { id: s.id, contactId: toPublicId('contact', s.contactId), start: friday.toISOString() },
    { context: { ...s.tenant, correlationId: randomUUID() }, permissions: 'all' },
  );
  expect(dry).toMatchObject({ status: 'passed', outcome: { kind: 'completed' } });
  // For real: the tag and the held email on Friday, the email and the last wait on Monday.
  const moments = [friday, friday, monday, monday];
  for (const moment of moments) expect(await h.step(s.tenant, s.enrolmentId, moment)).toBe('ran');
  const real = (await s.taken()).map((row, position) => ({
    step: row.step,
    at: moments[position]?.toISOString(),
    // An action is only described by a test run; a wait says the same words in both.
    waited: row.waited ? row.explanation : null,
  }));
  expect(real).toEqual(
    dry.steps.map((step) => ({
      step: step.step,
      at: step.at,
      waited: step.kind === 'waited' ? step.explanation : null,
    })),
  );
  expect(real.map((step) => [step.step, step.waited === null])).toEqual([
    ['mark', true],
    ['write', false],
    ['write', true],
    ['pause', false],
  ]);
});

it('sends at once inside the window, with no wait recorded', async () => {
  const s = await scene({ businessZone: 'America/New_York', settings: { sendingWindow: office } });
  // Monday 9 March 2026, 10:00 EDT.
  const inside = at('2026-03-09T14:00:00Z');
  await h.step(s.tenant, s.enrolmentId, inside);
  await h.step(s.tenant, s.enrolmentId, inside);
  expect(await s.messages()).toEqual([
    { status: 'queued', error_code: null, subject: 'Your guide' },
  ]);
  expect((await s.steps()).map((step) => [step.step, step.status, step.resumes])).toEqual([
    ['mark', 'succeeded', false],
    ['write', 'succeeded', false],
  ]);
});

it("goes by the contact's own zone when the settings say so, and the business's when they have none", async () => {
  // 13:30 UTC on Monday 9 March 2026 is 09:30 in New York (open) and 22:30 in Tokyo (closed
  // until Tuesday 09:00 there, which is midnight UTC).
  const moment = at('2026-03-09T13:30:00Z');
  const inTokyo = await scene({
    businessZone: 'America/New_York',
    contactZone: 'Asia/Tokyo',
    settings: { timezone: 'contact', sendingWindow: office },
  });
  await h.step(inTokyo.tenant, inTokyo.enrolmentId, moment);
  await h.step(inTokyo.tenant, inTokyo.enrolmentId, moment);
  expect(await h.run(inTokyo.tenant, inTokyo.enrolmentId)).toMatchObject({
    status: 'waiting',
    current_step: 'write',
    wake_at: at('2026-03-10T00:00:00Z'),
  });
  expect(await inTokyo.messages()).toEqual([]);

  // The same contact zone, with the settings left at the business's: New York decides.
  const byBusiness = await scene({
    businessZone: 'America/New_York',
    contactZone: 'Asia/Tokyo',
    settings: { sendingWindow: office },
  });
  await h.step(byBusiness.tenant, byBusiness.enrolmentId, moment);
  await h.step(byBusiness.tenant, byBusiness.enrolmentId, moment);
  expect(await byBusiness.messages()).toHaveLength(1);

  // A contact with no zone of their own, in an automation that asks for it, goes by the
  // business's.
  const nowhere = await scene({
    businessZone: 'America/New_York',
    settings: { timezone: 'contact', sendingWindow: office },
  });
  await h.step(nowhere.tenant, nowhere.enrolmentId, moment);
  await h.step(nowhere.tenant, nowhere.enrolmentId, moment);
  expect(await nowhere.messages()).toHaveLength(1);
});

it('waits on for the next opening when it is woken after the window has closed again', async () => {
  // Nairobi, three hours ahead of UTC all year. Friday 16 October 2026, 18:00 there.
  const s = await scene({ businessZone: 'Africa/Nairobi', settings: { sendingWindow: office } });
  const friday = at('2026-10-16T15:00:00Z');
  await h.step(s.tenant, s.enrolmentId, friday);
  await h.step(s.tenant, s.enrolmentId, friday);
  expect(await h.run(s.tenant, s.enrolmentId)).toMatchObject({
    wake_at: at('2026-10-19T06:00:00Z'),
  });
  // The worker was down through Monday: the job runs on Monday at 19:00, after closing.
  expect(await h.step(s.tenant, s.enrolmentId, at('2026-10-19T16:00:00Z'))).toBe('ran');
  expect(await h.run(s.tenant, s.enrolmentId)).toMatchObject({
    status: 'waiting',
    current_step: 'write',
    wake_at: at('2026-10-20T06:00:00Z'),
  });
  expect(await s.messages()).toEqual([]);
  // Still one wait, now saying the opening it really waits for.
  expect(await s.steps()).toMatchObject([
    { step: 'mark' },
    {
      step: 'write',
      status: 'waiting',
      explanation:
        'Outside the sending window (09:00 to 17:00, Africa/Nairobi), so it waits until 2026-10-20T06:00:00.000Z.',
    },
  ]);
  expect(await h.step(s.tenant, s.enrolmentId, at('2026-10-20T06:00:00Z'))).toBe('ran');
  expect(await s.messages()).toHaveLength(1);
  expect(await h.differences()).toEqual([]);
});

it('does not let a message past quiet hours: the window opens, and messaging still holds it', async () => {
  // Quiet at every hour, for a contact whose zone is known: messaging holds every message.
  const s = await scene({
    businessZone: 'Africa/Nairobi',
    contactZone: 'Africa/Nairobi',
    settings: { sendingWindow: office },
    alwaysQuiet: true,
  });
  // Monday 12 October 2026, 10:00 in Nairobi: the window is open.
  const inside = at('2026-10-12T07:00:00Z');
  await h.step(s.tenant, s.enrolmentId, inside);
  await h.step(s.tenant, s.enrolmentId, inside);
  // Queued, and held by quiet hours: the window did not send it over them.
  expect(await s.messages()).toEqual([
    { status: 'queued', error_code: 'quiet_hours', subject: 'Your guide' },
  ]);
  expect((await s.steps()).at(-1)).toMatchObject({
    step: 'write',
    status: 'succeeded',
    explanation: "The email was queued; it is held until the contact's quiet hours end.",
  });
});

it('fails a message step whose window never opens, and sends nothing', async () => {
  // Published before such a window was refused: it opens and closes at the same time.
  const s = await scene({
    businessZone: 'Africa/Nairobi',
    settings: { sendingWindow: { ...office, end: '09:00' } },
  });
  const moment = at('2026-10-12T07:00:00Z');
  await h.step(s.tenant, s.enrolmentId, moment);
  await h.step(s.tenant, s.enrolmentId, moment);
  expect(await h.run(s.tenant, s.enrolmentId)).toMatchObject({
    status: 'failed',
    exit_reason: 'invalid_sending_window',
  });
  expect(await s.messages()).toEqual([]);
  expect((await s.steps()).at(-1)).toMatchObject({
    step: 'write',
    status: 'failed',
    explanation: 'The sending window (09:00 to 09:00) never opens.',
  });
});
