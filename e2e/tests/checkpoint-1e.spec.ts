// Checkpoint 1E: the AUTOMATIONS.md example built three ways (canvas, JSON, API) runs the
// same. On an install of its own (global-setup.ts): the built server with its worker and
// the built dashboard over a migrated Postgres, behind an HTTPS front.
//
// Nothing of the product is stood in for. The world outside it is local: the mail server
// is GreenMail, Twilio is the stand-in of apps/server/test/fake-twilio.ts, and the form is
// sent as its embed sends it from the business's website. No message leaves this machine.
//
// The automation is the one docs/AUTOMATIONS.md section 2 writes out, read from that file,
// with one change it needs to run on an install today, said where it is made: its
// {{values.sample_reel_url}} merge field, because account-wide custom values don't exist
// yet. Days are not waited for: the test moves each wait's end into the past and asks the
// worker to sweep, as its every-minute sweep would have (automation-day.ts).
//
// It happens once on its install, so this file is not written to be repeated against the
// same servers.
import { expect, test, type APIResponse, type Locator } from '@playwright/test';
import {
  automationDraftSaved,
  automationRun,
  automationRunList,
  automationView,
  businessProfile,
  contactList,
  form,
  me,
  messageTemplate,
  recordFields,
  type AutomationRun,
} from '@repo/contracts';

import {
  daysPass,
  documentedAutomation,
  flowQuery,
  submitForm,
  textFrom,
  WEBSITE,
} from '../automation-day.js';
import { mailDeliveredTo, mailServer, twilio } from '../inbox-day.js';
import { choose } from '../select.js';
import { address, asClient, automationDay } from '../servers.js';
import { signInByLink } from '../signing-in.js';

// The install's certificate is made for the test run; the browser is told to accept it.
test.use({ ...asClient('203.0.113.170'), ignoreHTTPSErrors: true });

const MAILBOX = 'fixture@localhost.test';
/** Where Meadow Lane Events can be written to: every marketing email carries it. */
const MEADOW_LANE_ADDRESS = {
  line1: '18 Orchard Way',
  line2: '',
  city: 'Hudson',
  region: 'NY',
  postalCode: '12534',
  country: 'US',
} as const;
const REEL = 'https://meadowlane.example/reel';

interface Lead {
  readonly firstName: string;
  readonly email: string;
  readonly phone: string;
}
/** Asked about video: gets the sample reel, and her run ends there. */
const VERA: Lead = {
  firstName: 'Vera',
  email: 'vera.lindqvist@example.test',
  phone: '+15558675320',
};
/** Didn't ask about video, and replies to the check-in: every run stops when he does. */
const NOEL: Lead = { firstName: 'Noel', email: 'noel.adeyemi@example.test', phone: '+15558675321' };
/** Didn't ask about video and never replies: goes through to the last check-in. */
const IRIS: Lead = { firstName: 'Iris', email: 'iris.moreau@example.test', phone: '+15558675322' };

const install = (path = ''): string =>
  `${address('automationDay')}/b/${automationDay.business.slug}${path}`;

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
  return Object.fromEntries(Object.entries(value));
}

/**
 * An email step's settings, by the template they came from. A step written in the document
 * names its template. One made on the canvas holds a copy of the template instead, pinned
 * at the revision copied, so a later edit of the template can't change what it sends
 * (docs/AUTOMATIONS.md, `email-template-copy`). The copy names the template it was made from.
 */
function emailOf(config: unknown): unknown {
  const { mode, source, subject: _subject, body: _body, ...rest } = objectOf(config);
  return mode === 'copy' ? { ...rest, template: objectOf(source)['id'] } : config;
}

/**
 * What an automation does, whatever its steps are called: from the start, each step's type
 * and settings and where each of its paths leads. Two documents with the same flow run the
 * same; the ids a builder happened to give the steps, and where the canvas drew them, are
 * not part of it.
 */
function flowOf(document: Record<string, unknown>): unknown {
  const steps = objectOf(document['steps']);
  const walk = (id: unknown, seen: readonly string[]): unknown => {
    if (typeof id !== 'string') return 'end';
    if (seen.includes(id)) return `back to step ${String(seen.indexOf(id))}`;
    const step = objectOf(steps[id]);
    const next = step['next'];
    return {
      type: step['type'],
      config: step['type'] === 'email.send' ? emailOf(step['config']) : step['config'],
      next:
        next !== null && typeof next === 'object'
          ? Object.fromEntries(
              Object.entries(next)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([branch, target]) => [branch, walk(target, [...seen, id])]),
            )
          : walk(next, [...seen, id]),
    };
  };
  return {
    triggers: (document['triggers'] as unknown[]).map((trigger) => {
      const { type, config } = objectOf(trigger);
      return { type, config };
    }),
    stopWhen: document['stopWhen'],
    settings: document['settings'],
    flow: walk(document['start'], []),
  };
}

const MOMENT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/**
 * What a run did, without what names it: for each step taken its type, the settings and
 * values it was given, the branch it took, why, and how it came out. Moments are left out:
 * three runs started by one form are milliseconds apart. An email step is told by the
 * template it came from (emailOf); the content a copy was pinned to is checked on its own.
 */
function courseOf(run: AutomationRun): unknown {
  return {
    status: run.status,
    exitReason: run.exitReason,
    version: run.version,
    steps: run.steps.map((step) => ({
      type: step.type,
      status: step.status,
      config: step.type === 'email.send' ? emailOf(step.input['config']) : step.input['config'],
      values: step.input['values'],
      branch: step.branch,
      explanation: step.explanation.replaceAll(MOMENT, '<moment>'),
      error: step.error,
      produced: Object.keys(step.output)
        .filter((key) => key !== 'emailContent')
        .sort(),
    })),
  };
}

test('Checkpoint 1E: the AUTOMATIONS.md example, built on the canvas, in the JSON view and through the API, runs the same', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const mail = mailServer();
  const account = await twilio.newAccount();
  const textsTo = async (lead: Lead): Promise<string[]> =>
    (await twilio.state()).messages
      .filter((each) => each.accountSid === account.accountSid)
      .filter((each) => each.form.some(([name, value]) => name === 'To' && value === lead.phone))
      .map((each) => each.form.find(([name]) => name === 'Body')?.[1] ?? '');

  await test.step('sign in', async () => {
    await page.goto(`${address('automationDay')}/sign-in`);
    await signInByLink(page, automationDay.owner.email, 1);
    await expect(page).toHaveURL(new RegExp(`^${address('automationDay')}/`));
  });
  const api = `${address('automationDay')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === automationDay.business.slug);
  if (business === undefined) throw new Error('The Automation day install has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('automationDay') };
  // These local-mail fixtures are known recipients; public DNS cannot verify example.test.
  // Leave verification enabled while the three workflows exercise consent and delivery.
  const checked = await flowQuery<{ address_normalized: string }>(
    `insert into messaging.email_verifications
       (business_id,address_normalized,status,depth,checked_at)
     select b.id,addresses.address,'valid','mailbox',now()
     from tenancy.businesses b cross join unnest($1::text[]) as addresses(address)
     where b.slug=$2 returning address_normalized`,
    [[VERA.email, NOEL.email, IRIS.email], automationDay.business.slug],
  );
  expect(checked).toHaveLength(3);
  const ok = async (response: APIResponse, status = 200): Promise<unknown> => {
    expect(response.status(), await response.text()).toBe(status);
    return response.json();
  };

  await test.step('connect a mailbox, and send at any hour', async () => {
    await page.goto(install('/settings/email'));
    await page.getByRole('button', { name: 'Add a mailbox', exact: true }).click();
    await page.getByLabel('Email address', { exact: true }).fill(MAILBOX);
    await page.getByLabel('Mailbox name', { exact: true }).fill('Events desk');
    await page.getByLabel('Sender name', { exact: true }).fill('Meadow Lane Events');
    for (const [protocol, port] of [
      ['SMTP', mail.smtpPort],
      ['IMAP', mail.imapPort],
    ] as const) {
      const group = page.getByRole('group', { name: protocol, exact: true });
      await group.getByLabel('Server', { exact: true }).fill('localhost');
      await group.getByLabel('Port', { exact: true }).fill(String(port));
      await group.getByLabel('Username', { exact: true }).fill(mail.username);
      await group.getByLabel('Password or app password').fill(mail.password);
    }
    await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
    await expect(page.getByText('Mailbox connected.', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Events desk', exact: true })).toBeVisible();
    // With quiet hours on, a message to a lead waits for the morning by the business's
    // clock when nobody has set the lead's zone, so the test would pass or fail by the hour
    // it was run at.
    await page.getByLabel('Hold messages during quiet hours').uncheck();
    await page.getByRole('button', { name: 'Save quiet hours', exact: true }).click();
    await expect(page.getByText('Quiet hours saved.', { exact: true })).toBeVisible();
    // A mailbox sends five messages a minute unless told otherwise, and holds the rest
    // (mailbox_pacing). Three automations write to three leads at once here, so the desk
    // raises its pace, as a business that sends this much would.
    const limits = page.getByRole('group', { name: 'Sending limits', exact: true });
    await limits.getByLabel('Messages per minute', { exact: true }).fill('120');
    await limits.getByRole('button', { name: 'Save sending settings', exact: true }).click();
    await expect(limits.getByRole('status')).toHaveText('Sending settings saved.');
  });

  await test.step('the business’s postal address, which every marketing email shows', async () => {
    // Without one, workflow mail is not sent (CAN-SPAM).
    const current = businessProfile.parse(
      await ok(await page.request.get(`${api}/business-profile`, { headers })),
    );
    await ok(
      await page.request.put(`${api}/business-profile`, {
        headers,
        data: {
          name: current.name,
          timezone: current.timezone,
          locale: current.locale,
          currency: current.currency,
          logoFileId: current.logoFileId,
          address: MEADOW_LANE_ADDRESS,
        },
      }),
    );
  });

  const inboundWebhook = await test.step('connect Twilio and register its number', async () => {
    await page.goto(install('/settings/sms'));
    await page.getByRole('button', { name: 'Connect Twilio', exact: true }).click();
    await page.getByLabel('Label', { exact: true }).fill('Events line');
    await page.getByLabel('Account SID', { exact: true }).fill(account.accountSid);
    await page.getByLabel('Auth Token', { exact: true }).fill(account.authToken);
    await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
    await expect(page.getByText('Twilio connected.', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const shown = await page
      .getByText(
        new RegExp(`^${address('automationDay')}/webhooks/twilio/[A-Za-z0-9_-]{43}/inbound$`),
      )
      .textContent();
    if (shown === null) throw new Error('No inbound webhook address was shown.');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByText('Numbers from Twilio', { exact: true }).click();
    await expect(page.getByText(account.number).first()).toBeVisible();
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Events mobile');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText('Events mobile', { exact: true })).toBeVisible();
    return shown;
  });

  const { quoteForm, pricingGuide } =
    await test.step('what the example refers to: a field, a template and the form', async () => {
      await ok(
        await page.request.post(`${api}/fields`, {
          headers,
          data: {
            objectKey: 'contact',
            key: 'services',
            label: 'Services',
            description: 'What the lead asked us about.',
            valueType: 'multi_choice',
            currency: null,
            options: [
              { key: 'video', label: 'Video', description: '', archived: false },
              { key: 'lighting', label: 'Lighting', description: '', archived: false },
            ],
            aiFillSources: [],
            aiOverwrite: 'ask',
            archived: false,
          },
        }),
        201,
      );
      const template = messageTemplate.parse(
        await ok(
          await page.request.post(`${api}/message-templates`, {
            headers,
            data: {
              name: 'Pricing guide',
              subject: 'Your pricing guide',
              body: 'Hi {{contact.firstName}},\n\nHere is our pricing guide for your event.',
            },
          }),
          201,
        ),
      );
      const draft = form.parse(
        await ok(
          await page.request.post(`${api}/forms`, { headers, data: { name: 'Request a quote' } }),
          201,
        ),
      );
      const saved = form.parse(
        await ok(
          await page.request.put(`${api}/forms/${draft.id}`, {
            headers,
            data: {
              name: 'Request a quote',
              revision: draft.revision,
              allowedOrigins: [WEBSITE],
              definition: {
                title: 'Request a quote',
                fields: [
                  {
                    key: 'first_name',
                    type: 'text',
                    label: 'First name',
                    required: true,
                    target: { kind: 'contact', attribute: 'firstName' },
                  },
                  {
                    key: 'email',
                    type: 'email',
                    label: 'Email',
                    required: true,
                    target: { kind: 'contact', attribute: 'email' },
                  },
                  {
                    key: 'phone',
                    type: 'phone',
                    label: 'Mobile number',
                    required: true,
                    target: { kind: 'contact', attribute: 'phone' },
                  },
                ],
                consents: [
                  { key: 'email_updates', channel: 'email', wording: 'Email me offers and news.' },
                  { key: 'text_updates', channel: 'sms', wording: 'Text me offers and news.' },
                ],
              },
            },
          }),
        ),
      );
      expect(saved.problems).toEqual([]);
      const published = form.parse(
        await ok(
          await page.request.post(`${api}/forms/${saved.id}/publish`, {
            headers,
            data: { revision: saved.revision },
          }),
        ),
      );
      expect(published.status).toBe('published');
      return { quoteForm: published, pricingGuide: template };
    });

  // The example as the documentation writes it, with the one change it needs to run here.
  const documented = documentedAutomation();
  const steps = objectOf(documented['steps']);
  const reel = objectOf(steps['send_reel']);
  expect(objectOf(reel['config'])['message']).toBe(
    'Here’s our video sample reel: {{values.sample_reel_url}}',
  );
  const example: Record<string, unknown> = {
    ...documented,
    steps: {
      ...steps,
      // Account-wide custom values ({{values.…}}) don't exist yet, so the address is written out.
      send_reel: { ...reel, config: { message: `Here’s our video sample reel: ${REEL}` } },
    },
  };
  const messageOf = (id: string): string => {
    const text = objectOf(objectOf(steps[id])['config'])['message'];
    if (typeof text !== 'string') throw new Error(`${id} has no message.`);
    return text;
  };

  const openNew = async (name: string): Promise<void> => {
    await page.goto(install('/automations'));
    // A new workflow is made at once, named as GoHighLevel names one, and opened; its name
    // and what starts it are given in the builder.
    await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: /^New Workflow : \d+$/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Rename workflow', exact: true }).click();
    await page.getByRole('textbox', { name: 'Workflow name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Use this name', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    // The builder opens on its canvas, with the card that adds what starts the workflow.
    await page.getByRole('button', { name: 'Add new trigger', exact: true }).click();
    const adding = page.getByRole('dialog', { name: 'Add trigger', exact: true });
    await adding.getByRole('button', { name: /^Form submitted/ }).click();
    const form = page.getByRole('dialog', { name: 'Form submitted', exact: true });
    // The form is chosen from a list that can be searched; closed, it reads "Any form".
    await form.getByRole('button', { name: 'Form: Any form', exact: true }).click();
    await page.getByRole('option', { name: 'Request a quote', exact: true }).click();
    await form.getByRole('button', { name: 'Save trigger', exact: true }).click();
    await expect(form).toBeHidden();
  };
  const views = page.getByRole('navigation', { name: 'Automation views', exact: true });
  const json = page.getByLabel('Automation JSON', { exact: true });
  const saveAndPublish = async (): Promise<string> => {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Draft saved.' })).toHaveText(
      'Draft saved.',
    );
    // The Draft / Publish switch: a workflow never published asks before it goes live.
    await page.getByRole('switch', { name: 'Published', exact: true }).click();
    const publishing = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
    await publishing.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Published.' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Published', exact: true })).toBeChecked();
    await expect(page.getByText('Live · version 1', { exact: true })).toBeVisible();
    const id = new URL(page.url()).searchParams.get('automation');
    if (id === null) throw new Error('The builder is not on an automation.');
    return id;
  };

  const built: Record<'api' | 'json' | 'canvas', string> = { api: '', json: '', canvas: '' };

  await test.step('built through the API: the document, validated, saved and published', async () => {
    const document = { ...example, name: 'New lead follow-up (API)' };
    const checked = objectOf(
      await ok(
        await page.request.post(`${api}/automations/validate`, { headers, data: { document } }),
      ),
    );
    expect(checked['errors']).toEqual([]);
    const saved = automationDraftSaved.parse(
      await ok(await page.request.post(`${api}/automations`, { headers, data: { document } }), 201),
    );
    expect(saved.validation.valid).toBe(true);
    await ok(
      await page.request.post(`${api}/automations/${saved.automation.id}/publish`, {
        headers,
        data: { baseDraftVersion: saved.automation.draftVersion, changeSummary: 'From the API.' },
      }),
    );
    built.api = saved.automation.id;
  });

  await test.step('built in the JSON view: the same document, typed in', async () => {
    await openNew('New lead follow-up (JSON)');
    await views.getByRole('link', { name: 'JSON', exact: true }).click();
    await json.fill(JSON.stringify({ ...example, name: 'New lead follow-up (JSON)' }, null, 2));
    await expect(page.getByTestId('automation-json-state')).toHaveText('Valid · 7 steps');
    // The Steps view reads the document just typed.
    await views.getByRole('link', { name: 'Steps', exact: true }).click();
    await expect(page.locator('#automation-step-send_guide')).toContainText(
      'Send the email “Pricing guide”',
    );
    built.json = await saveAndPublish();
  });

  await test.step('built on the canvas: each step added there, with + and from the library', async () => {
    await openNew('New lead follow-up (canvas)');
    await views.getByRole('link', { name: 'Canvas', exact: true }).click();
    const canvas = page.getByTestId('automation-canvas');
    const add = (name: string | RegExp): Locator =>
      canvas.getByRole('button', { name, ...(typeof name === 'string' ? { exact: true } : {}) });
    const dialog = (name: string): Locator => page.getByRole('dialog', { name, exact: true });
    const addStep = async (title: string): Promise<void> => {
      await dialog(title).getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(dialog(title)).toBeHidden();
    };
    const pick = (label: RegExp): Promise<void> =>
      dialog('Actions').getByRole('button', { name: label }).click();
    const library = page.getByRole('region', { name: 'Actions', exact: true });
    const openLibrary = async (): Promise<void> => {
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Add action', exact: true }).click();
      await expect(library).toBeVisible();
    };

    // What starts it: the form.
    await canvas
      .getByRole('button', { name: /^Edit: / })
      .first()
      .click();
    // The trigger may already name the form: the button then reads that form's name.
    await dialog('Form submitted')
      .getByRole('button', { name: /^Form: / })
      .click();
    await page.getByRole('option', { name: 'Request a quote', exact: true }).click();
    await dialog('Form submitted')
      .getByRole('button', { name: 'Save trigger', exact: true })
      .click();
    await expect(
      canvas.getByRole('group', {
        name: 'Trigger: Someone submits “Request a quote”',
        exact: true,
      }),
    ).toBeVisible();

    // The pricing guide by email, then two days.
    await add('Add the first action').click();
    await pick(/^Send email/);
    await dialog('Send email').getByRole('radio', { name: 'Select existing template' }).check();
    // The template is found in a list that can be searched by name or subject.
    await dialog('Send email')
      .getByRole('button', { name: /^Email template: / })
      .click();
    await page.getByRole('option', { name: /^Pricing guide/ }).click();
    await addStep('Send email');
    // Choosing a template on the canvas copies it into the action: the card reads the
    // copy's subject, not the template's name.
    await add('Add an action after: Send the email “Your pricing guide”').click();
    await pick(/^Wait\s*Wait for a length/);
    await dialog('Wait')
      .getByRole('spinbutton', { name: 'How long to wait', exact: true })
      .fill('2');
    await addStep('Wait');

    // The If / else is dragged from the library onto the line that leaves the wait.
    await openLibrary();
    const afterWait = add('Add an action after: Wait 2 days');
    await afterWait.scrollIntoViewIfNeeded();
    await library.getByRole('button', { name: /^If \/ else/ }).dragTo(afterWait);
    // Its rule is written as a row: the field, how it is compared, and with what.
    const rule = dialog('If / else');
    await choose(
      rule.getByRole('combobox', { name: 'Field of condition 1', exact: true }),
      'contact.custom.services',
    );
    await choose(
      rule.getByRole('combobox', { name: 'Comparison of condition 1', exact: true }),
      'includes',
    );
    await choose(
      rule.getByRole('combobox', { name: 'Value of condition 1', exact: true }),
      'video',
    );
    await addStep('If / else');
    await expect(
      canvas.getByRole('group', { name: 'If services includes “video”', exact: true }),
    ).toBeVisible();
    await library.getByRole('button', { name: 'Close', exact: true }).click();

    // Yes: the sample reel, added with the + on that branch.
    await add(/^Add an action to: If yes of /).click();
    await pick(/^Send text/);
    await dialog('Send text')
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`Here’s our video sample reel: ${REEL}`);
    await addStep('Send text');

    // No: the check-in, chosen in the library and then put on its branch.
    await openLibrary();
    await library.getByRole('button', { name: /^Send text/ }).click();
    await add(/^Add an action to: If no of /).click();
    await dialog('Send text')
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(messageOf('check_in'));
    await addStep('Send text');
    await add(/^Add an action after: Text them “Hi /).click();
    await pick(/^Wait\s*Wait for a length/);
    await dialog('Wait')
      .getByRole('spinbutton', { name: 'How long to wait', exact: true })
      .fill('3');
    await addStep('Wait');
    await add('Add an action after: Wait 3 days').click();
    await pick(/^Send text/);
    await dialog('Send text')
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(messageOf('last_check_in'));
    await addStep('Send text');

    // A box moved on the canvas: its place is kept, and nothing about the flow changes.
    await canvas.getByRole('button', { name: 'Move: Wait 3 days', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    // The canvas's forms don't write the description, what stops the automation or its
    // settings as a whole: those three are typed in the JSON view, into the document the
    // canvas made. Every step, and the rule of the condition, is the canvas's own.
    await views.getByRole('link', { name: 'JSON', exact: true }).click();
    const made = objectOf(JSON.parse(await json.inputValue()));
    const madeSteps = Object.values(objectOf(made['steps'])).map(objectOf);
    expect(madeSteps).toHaveLength(7);
    expect(Object.keys(objectOf(made['layout']))).toHaveLength(7);
    expect(madeSteps.find((step) => step['type'] === 'condition')?.['config']).toEqual({
      if: { field: 'contact.custom.services', operator: 'includes', value: 'video' },
    });
    const finished = {
      ...made,
      description: example['description'],
      stopWhen: example['stopWhen'],
      settings: example['settings'],
    };
    await json.fill(JSON.stringify(finished, null, 2));
    // Back on the canvas, the same document: the rule reads as written, the boxes where left.
    await views.getByRole('link', { name: 'Canvas', exact: true }).click();
    await expect(
      canvas.getByRole('group', { name: 'If services includes “video”', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Their opportunity is won or lost', { exact: true })).toBeVisible();
    built.canvas = await saveAndPublish();
  });

  const live =
    await test.step('the three are one automation: the same flow, whatever built it', async () => {
      const documents: Record<string, Record<string, unknown>> = {};
      for (const [how, id] of Object.entries(built)) {
        const automation = automationView.parse(
          await ok(await page.request.get(`${api}/automations/${id}`, { headers })),
        );
        expect(automation.status).toBe('active');
        expect(automation.liveVersion).toBe(1);
        documents[how] = automation.live?.document ?? {};
      }
      const flows = Object.values(documents).map(flowOf);
      expect(flows[1]).toEqual(flows[0]);
      expect(flows[2]).toEqual(flows[0]);
      // The email is the one difference in how they hold it. Written in a document, the step
      // names the template. Built on the canvas, it is a copy of that template at the
      // revision chosen, with the template's own subject and body.
      const emailOfBuilt = (how: string): unknown => {
        const document = documents[how] ?? {};
        return objectOf(objectOf(document['steps'])[String(document['start'])])['config'];
      };
      expect(emailOfBuilt('api')).toEqual({ template: pricingGuide.id });
      expect(emailOfBuilt('json')).toEqual({ template: pricingGuide.id });
      expect(emailOfBuilt('canvas')).toEqual({
        mode: 'copy',
        source: { id: pricingGuide.id, revision: pricingGuide.revision },
        subject: 'Your pricing guide',
        body: 'Hi {{contact.firstName}},\n\nHere is our pricing guide for your event.',
      });
      // And it is the documented one: the same steps, settings and stops, with its names
      // turned into this business's own form, template and field.
      expect(flows[0]).toMatchObject({
        flow: {
          type: 'email.send',
          next: {
            type: 'wait',
            next: {
              type: 'condition',
              config: {
                if: { field: 'contact.custom.services', operator: 'includes', value: 'video' },
              },
            },
          },
        },
      });
      expect(documents['api']).toMatchObject({
        start: 'send_guide',
        stopWhen: documented['stopWhen'],
        settings: documented['settings'],
      });
      // Only the canvas-built one has places for its steps; the flow is the same without them.
      expect(Object.keys(objectOf(documents['canvas']?.['layout']))).toHaveLength(7);
      return documents;
    });
  expect(Object.keys(live)).toEqual(['api', 'json', 'canvas']);

  const lead = async (person: Lead): Promise<string> => {
    await submitForm(quoteForm.publicKey, {
      values: { first_name: person.firstName, email: person.email, phone: person.phone },
      consents: { email_updates: true, text_updates: true },
    });
    const found = contactList.parse(
      await ok(
        await page.request.get(`${api}/contacts?q=${encodeURIComponent(person.email)}`, {
          headers,
        }),
      ),
    );
    const [contact] = found.items;
    if (contact === undefined) throw new Error(`${person.firstName} did not become a contact.`);
    return contact.id;
  };
  const runsOf = async (contactId: string): Promise<Record<string, AutomationRun>> => {
    const list = automationRunList.parse(
      await ok(await page.request.get(`${api}/records/${contactId}/automation-runs`, { headers })),
    );
    const runs: Record<string, AutomationRun> = {};
    for (const [how, id] of Object.entries(built)) {
      const summary = list.items.find((run) => run.automationId === id);
      if (summary === undefined) continue;
      runs[how] = automationRun.parse(
        await ok(await page.request.get(`${api}/automation-runs/${summary.id}`, { headers })),
      );
    }
    return runs;
  };
  /** Waits until all three runs of a contact have come to the same named point. */
  const allThree = async (
    contactId: string,
    status: string,
    stepsTaken: number,
  ): Promise<Record<string, AutomationRun>> => {
    await expect
      .poll(
        async () =>
          Object.values(await runsOf(contactId)).map((run) => [run.status, run.steps.length]),
        { timeout: 60_000 },
      )
      .toEqual([
        [status, stepsTaken],
        [status, stepsTaken],
        [status, stepsTaken],
      ]);
    return runsOf(contactId);
  };
  // Each email the pipeline holds for the address: its status, with the reason when it has one.
  const emailsQueuedFor = async (recipient: string): Promise<string[]> =>
    (
      await flowQuery<{ state: string }>(
        `select status || coalesce(': ' || error_code, '') as state
         from messaging.messages
         where channel = 'email' and direction = 'outbound' and $1 = any(to_addresses)
         order by created_at, id`,
        [recipient],
      )
    ).map((each) => each.state);
  const sameCourse = (runs: Record<string, AutomationRun>): void => {
    expect(courseOf(runs['json'] ?? raise())).toEqual(courseOf(runs['api'] ?? raise()));
    expect(courseOf(runs['canvas'] ?? raise())).toEqual(courseOf(runs['api'] ?? raise()));
  };
  const raise = (): never => {
    throw new Error('A run is missing.');
  };

  const contacts =
    await test.step('three leads send the form: each starts all three, and each gets the pricing guide three times', async () => {
      const ids = { vera: await lead(VERA), noel: await lead(NOEL), iris: await lead(IRIS) };
      for (const [who, person] of [
        ['vera', VERA],
        ['noel', NOEL],
        ['iris', IRIS],
      ] as const) {
        // The email, then the two-day wait: two steps taken, and waiting.
        const runs = await allThree(ids[who], 'waiting', 2);
        sameCourse(runs);
        expect(runs['api']?.steps.map((step) => [step.type, step.status])).toEqual([
          ['email.send', 'succeeded'],
          ['wait', 'waiting'],
        ]);
        // The canvas-built one sent its own pinned content: the first revision of its copy.
        expect(runs['canvas']?.steps[0]?.output).toMatchObject({
          emailContent: { revision: 1 },
        });
        expect(runs['api']?.steps[0]?.output).not.toHaveProperty('emailContent');
        // What the outbound pipeline says of each is read too, so a mail that doesn't
        // arrive shows where it stopped.
        await expect
          .poll(
            async () => ({
              delivered: (await mailDeliveredTo(person.email)).length,
              pipeline: await emailsQueuedFor(person.email),
            }),
            { timeout: 60_000 },
          )
          .toEqual({ delivered: 3, pipeline: ['sent', 'sent', 'sent'] });
        const delivered = await mailDeliveredTo(person.email);
        expect(new Set(delivered.map((each) => each.subject))).toEqual(
          new Set(['Your pricing guide']),
        );
        for (const each of delivered) {
          expect(each.raw).toContain(`Hi ${person.firstName},`);
          expect(each.raw).toContain(MEADOW_LANE_ADDRESS.line1);
        }
      }
      return ids;
    });

  await test.step('Vera asked about video: after two days she gets the reel from each, and each ends', async () => {
    const fields = recordFields.parse(
      await ok(await page.request.get(`${api}/records/${contacts.vera}/fields`, { headers })),
    );
    const services = fields.items.find((field) => field.definition.key === 'services');
    if (services === undefined) throw new Error('The services field is not on the contact.');
    await ok(
      await page.request.put(`${api}/records/${contacts.vera}/fields/${services.definition.id}`, {
        headers,
        data: { value: ['video'], revision: services.revision },
      }),
    );
    await daysPass();
    const vera = await allThree(contacts.vera, 'completed', 4);
    sameCourse(vera);
    expect(vera['canvas']?.steps.map((step) => [step.type, step.branch])).toEqual([
      ['email.send', null],
      ['wait', null],
      ['condition', 'yes'],
      ['sms.send', null],
    ]);
    // Every step says what it was given and why: the condition, the value it compared.
    expect(vera['canvas']?.steps[2]).toMatchObject({
      input: { values: { 'contact.custom.services': ['video'] } },
      explanation: 'The condition was true, so the yes branch was taken.',
    });
    await expect.poll(() => textsTo(VERA), { timeout: 60_000 }).toHaveLength(3);
    expect(new Set(await textsTo(VERA))).toEqual(
      new Set([`Here’s our video sample reel: ${REEL}`]),
    );
  });

  await test.step('Noel and Iris did not: each gets the check-in from each, and waits again', async () => {
    for (const [id, person] of [
      [contacts.noel, NOEL],
      [contacts.iris, IRIS],
    ] as const) {
      const runs = await allThree(id, 'waiting', 5);
      sameCourse(runs);
      expect(runs['json']?.steps.map((step) => [step.type, step.branch])).toEqual([
        ['email.send', null],
        ['wait', null],
        ['condition', 'no'],
        ['sms.send', null],
        ['wait', null],
      ]);
      await expect.poll(() => textsTo(person), { timeout: 60_000 }).toHaveLength(3);
      expect(new Set(await textsTo(person))).toEqual(
        new Set([
          `Hi ${person.firstName}, did the pricing guide come through? Happy to answer any questions.`,
        ]),
      );
    }
  });

  await test.step('Noel replies by text: all three stop for him, at the same point, and say why', async () => {
    await textFrom(account, inboundWebhook, NOEL.phone, 'Got it, thank you!');
    const noel = await allThree(contacts.noel, 'exited', 5);
    sameCourse(noel);
    for (const run of Object.values(noel)) expect(run.exitReason).toBe('stop:message.received');
  });

  await test.step('three more days: Iris gets the last check-in from each; Noel gets nothing more', async () => {
    await daysPass();
    const iris = await allThree(contacts.iris, 'completed', 6);
    sameCourse(iris);
    await expect.poll(() => textsTo(IRIS), { timeout: 60_000 }).toHaveLength(6);
    expect(
      (await textsTo(IRIS)).filter((text) => text === messageOf('last_check_in')),
    ).toHaveLength(3);
    // He stopped: no step of his ran after his reply, and no text followed the three he had.
    sameCourse(await allThree(contacts.noel, 'exited', 5));
    expect(await textsTo(NOEL)).toHaveLength(3);
    expect(await textsTo(VERA)).toHaveLength(3);
    const enrolments = await flowQuery<{ count: number }>(
      'select count(*)::int as count from automation.enrolments',
    );
    expect(enrolments).toEqual([{ count: 9 }]);
  });

  await test.step('the run history shows it: per automation, per run and on the contact', async () => {
    await page.goto(install(`/automations?automation=${built.canvas}&view=runs`));
    const runs = page.getByRole('table', { name: 'Enrollment history', exact: true });
    await expect(runs.locator('tbody tr')).toHaveCount(3);
    // Each names what enrolled it: the form, as the builder names that trigger.
    await expect(runs.locator('tbody tr').first()).toContainText(
      'Someone submits “Request a quote”',
    );
    await expect(runs).toContainText('Stopped early, because this happened: They reply.');
    await runs.getByRole('link', { name: /^Open the run for Vera/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: /^Run for Vera/ })).toBeVisible();
    const taken = page
      .getByRole('list', { name: 'Steps taken', exact: true })
      .locator(':scope > li');
    await expect(taken).toHaveCount(4);
    await expect(taken.nth(2)).toContainText('services was: video');
    await expect(taken.nth(2)).toContainText('If yes');
    await expect(taken.nth(2)).toContainText(
      'The condition was true, so the yes branch was taken.',
    );
    await expect(taken.nth(3)).toContainText('The text message was queued to send.');

    await page.goto(install(`/contacts/${contacts.noel}?tab=actions`));
    const panel = page.getByRole('region', { name: 'Workflows', exact: true });
    await expect(panel.getByRole('listitem')).toHaveCount(3);
    await expect(panel).toContainText('New lead follow-up (canvas)');
    await expect(panel).toContainText('New lead follow-up (JSON)');
    await expect(panel).toContainText('New lead follow-up (API)');
    await expect(panel.getByText('Stopped early, because this happened: They reply.')).toHaveCount(
      3,
    );
  });
  await test.step('the workflow screens count it: the list, the logs, a trigger and the settings', async () => {
    // Execution logs: every action the three contacts' runs took, each leading to its run.
    await page.goto(install(`/automations?automation=${built.canvas}&view=logs`));
    const logs = page.getByRole('table', { name: 'Execution logs', exact: true });
    await expect(logs.locator('tbody tr').first()).toBeVisible();
    const taken = await logs.locator('tbody tr').count();
    expect(taken).toBeGreaterThanOrEqual(6);
    // The canvas-built email is a copy, so its action reads the copy's subject.
    await expect(logs).toContainText('Send the email “Your pricing guide”');
    await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'failed');
    await expect(page.getByText('No action matches that.', { exact: true })).toBeVisible();

    // Settings: what the document says, as switches.
    await page
      .getByRole('navigation', { name: 'Workflow', exact: true })
      .getByRole('link', { name: 'Settings', exact: true })
      .click();
    await expect(page.getByRole('switch', { name: 'Allow re-entry', exact: true })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Stop on response', exact: true })).toBeChecked();
    await expect(page.getByRole('combobox', { name: 'Timezone', exact: true })).toHaveText(
      'Contact timezone',
    );

    // The canvas: the trigger's Stats are the server's count of who it enrolled.
    await page
      .getByRole('navigation', { name: 'Workflow', exact: true })
      .getByRole('link', { name: 'Builder', exact: true })
      .click();
    const trigger = page.getByRole('group', {
      name: /^Trigger: Someone submits “Request a quote”/,
    });
    await trigger.getByRole('button', { name: /^Stats: / }).click();
    await expect(trigger).toContainText('Enrolled: 3 (live version: 3)');

    // The list: three enrolled in all, and its numbers under the row.
    await page.getByRole('link', { name: 'Workflows list', exact: true }).click();
    await page
      .getByRole('searchbox', { name: 'Search workflows', exact: true })
      .fill('New lead follow-up (canvas)');
    const row = page.getByRole('row').filter({
      has: page.getByRole('link', { name: 'New lead follow-up (canvas)', exact: true }),
    });
    await expect(row.getByRole('cell').nth(0)).toHaveText('Published');
    await expect(row.getByRole('cell').nth(1)).toHaveText('3');
    await page
      .getByRole('button', { name: 'Stats for New lead follow-up (canvas)', exact: true })
      .click();
    await expect(
      page
        .getByRole('group', { name: 'Every version', exact: true })
        .getByRole('definition')
        .first(),
    ).toHaveText('3');
  });
});
