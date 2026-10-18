// The Send email step's config in each of its four forms, with what a step says besides its
// content, and the content pairing templates and steps share.
import { describe, expect, it } from 'vitest';

import { automationStep } from './automations.js';
import { validateAutomation, type AutomationSetup } from './automations-validate.js';
import { EMAIL_CONTENT_LIMITS, emailContent, emailPreheader } from './email-content.js';
import {
  emailPreviewLine,
  mergeTokens,
  messageTemplateInput,
  renderEmailPreviewInput,
  templateContentOf,
} from './message-templates.js';
import { workflowEmailAddress, workflowEmailStepConfig } from './workflow-email-content.js';
import {
  enableWorkflowEmailSyncInput,
  getWorkflowEmailStepStatistics,
  listTemplateWorkflowActions,
  saveSyncedWorkflowEmailInput,
  workflowEmailStepStatistics,
} from './workflow-email-sync.js';

const template = 'tmpl_01h455vb4pex5vsknk084sn02q';
const file = 'file_01h455vb4pex5vsknk084sn02q';
const revision = 'a'.repeat(64);
const source = { id: template, revision };

const envelope = {
  mailbox: 'Sales',
  fromName: '{{contact.firstName}} at Bluebird',
  replyTo: 'frontdesk@example.test',
  cc: ['team@example.test', '{{contact.email}}'],
  bcc: ['archive@example.test'],
  preheader: 'A quick hello',
  attachments: [file],
};

const modes: Readonly<Record<string, Record<string, unknown>>> = {
  copy: { mode: 'copy', subject: 'Hi', body: 'Text', source },
  'copy without provenance': { mode: 'copy', subject: 'Hi', body: 'Text' },
  'copy with formatted content': { mode: 'copy', subject: 'Hi', body: 'Text', html: '<p>Text</p>' },
  sync: { mode: 'sync', source },
  'sync with its own subject': { mode: 'sync', source, subject: 'Mine' },
  reference: { template: 'Welcome' },
  'reference with its own subject': { template, subject: 'Mine' },
  inline: { subject: 'Hi', body: 'Text' },
  'inline with formatted content': { subject: 'Hi', body: 'Text', html: '<p>Text</p>' },
};

describe('email.send config', () => {
  it.each(Object.entries(modes))(
    'accepts %s, alone and with every envelope field',
    (_name, config) => {
      expect(workflowEmailStepConfig.parse(config)).toEqual(config);
      expect(workflowEmailStepConfig.parse({ ...config, ...envelope })).toEqual({
        ...config,
        ...envelope,
      });
      expect(automationStep.safeParse({ type: 'email.send', config }).success).toBe(true);
    },
  );

  it.each([
    ['sync without a source', { mode: 'sync' }],
    ['sync with content of its own', { mode: 'sync', source, body: 'Text' }],
    ['a reference with content', { template, body: 'Text' }],
    ['inline without a body', { subject: 'Hi', html: '<p>Text</p>' }],
    ['a copy without a subject', { mode: 'copy', body: 'Text' }],
    ['an unknown mode', { mode: 'mirror', source }],
    ['a free From address', { subject: 'Hi', body: 'Text', fromEmail: 'anyone@example.test' }],
    ['a From name on two lines', { subject: 'Hi', body: 'Text', fromName: 'A\nB' }],
    ['a blank From name', { subject: 'Hi', body: 'Text', fromName: '  ' }],
    ['a From name too long', { subject: 'Hi', body: 'Text', fromName: 'x'.repeat(121) }],
    ['a Reply-To that is no address', { subject: 'Hi', body: 'Text', replyTo: 'front desk' }],
    ['two addresses in Reply-To', { subject: 'Hi', body: 'Text', replyTo: 'a@x.test, b@x.test' }],
    [
      'a Reply-To of text around a field',
      { subject: 'Hi', body: 'Text', replyTo: 'x {{contact.email}}' },
    ],
    ['an empty Cc', { subject: 'Hi', body: 'Text', cc: [] }],
    [
      'eleven in Cc',
      {
        subject: 'Hi',
        body: 'Text',
        cc: Array.from({ length: 11 }, (_, n) => `a${String(n)}@x.test`),
      },
    ],
    [
      'eleven in Bcc',
      {
        subject: 'Hi',
        body: 'Text',
        bcc: Array.from({ length: 11 }, (_, n) => `a${String(n)}@x.test`),
      },
    ],
    ['an address too long', { subject: 'Hi', body: 'Text', cc: [`${'a'.repeat(250)}@x.test`] }],
    ['a preheader on two lines', { subject: 'Hi', body: 'Text', preheader: 'A\nB' }],
    ['a preheader too long', { subject: 'Hi', body: 'Text', preheader: 'x'.repeat(151) }],
    [
      'six files',
      { subject: 'Hi', body: 'Text', attachments: Array.from({ length: 6 }, () => file) },
    ],
    ['the same file twice', { subject: 'Hi', body: 'Text', attachments: [file, file] }],
    ['a file that is no file id', { subject: 'Hi', body: 'Text', attachments: [template] }],
    ['no files in the list', { subject: 'Hi', body: 'Text', attachments: [] }],
    [
      'formatted content too long',
      { subject: 'Hi', body: 'Text', html: 'x'.repeat(EMAIL_CONTENT_LIMITS.html + 1) },
    ],
    ['blank formatted content', { subject: 'Hi', body: 'Text', html: '   ' }],
  ])('refuses %s', (_name, config) => {
    expect(workflowEmailStepConfig.safeParse(config).success).toBe(false);
  });

  it('takes ten addresses, and one merge field as an address', () => {
    const ten = Array.from({ length: 10 }, (_, n) => `a${String(n)}@x.test`);
    expect(
      workflowEmailStepConfig.safeParse({ subject: 'Hi', body: 'Text', cc: ten, bcc: ten }).success,
    ).toBe(true);
    expect(workflowEmailAddress.safeParse('{{ contact.custom.assistant_email }}').success).toBe(
      true,
    );
    expect(workflowEmailAddress.safeParse('{{contact}}').success).toBe(false);
  });
});

const setup: AutomationSetup = {
  fields: { contact: [], deal: [] },
  forms: [],
  emailTemplates: [],
  whatsappTemplates: [],
  mailboxes: [],
  phoneNumbers: [],
  calendars: [],
  pipelines: [],
  lostReasons: [],
  tags: [],
  users: [],
  automations: [],
  values: [],
  channels: { email: true, sms: true, whatsapp: false },
  ai: false,
  webhooks: false,
  unavailableSteps: [],
  unavailableTriggers: [],
};

const validate = (type: 'email.send' | 'sms.send', config: Record<string, unknown>) =>
  validateAutomation(
    {
      name: 'Email',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'send',
      steps: { send: { type, config } },
    },
    setup,
  ).errors.map((error) => `${error.path} ${error.code}`);

describe('merge fields in what a step says about its email', () => {
  it.each(['html', 'preheader', 'fromName', 'replyTo'] as const)(
    'names an unknown field in %s',
    (key) => {
      const value = key === 'replyTo' ? '{{unknown.value}}' : 'x {{unknown.value}}';
      expect(validate('email.send', { subject: 'Hi', body: 'Text', [key]: value })).toEqual([
        `/steps/send/config/${key} unknown_merge_field`,
      ]);
    },
  );

  it.each(['cc', 'bcc'] as const)('names an unknown field in %s by its place', (key) => {
    expect(
      validate('email.send', {
        subject: 'Hi',
        body: 'Text',
        [key]: ['a@x.test', '{{unknown.value}}'],
      }),
    ).toEqual([`/steps/send/config/${key}/1 unknown_merge_field`]);
  });

  it('takes the known fields everywhere', () => {
    expect(
      validate('email.send', {
        subject: 'Hi {{contact.firstName}}',
        body: 'Text {{contact.firstName}}',
        html: '<p>{{contact.firstName}} <a href="{{email.unsubscribe_link}}">Stop</a></p>',
        preheader: 'For {{contact.firstName}}',
        fromName: '{{contact.firstName}}',
        replyTo: '{{contact.email}}',
        cc: ['{{contact.email}}'],
        bcc: ['{{contact.email}}'],
      }),
    ).toEqual([]);
  });

  it('takes a step that syncs only with a template of this library; a copy needs none', () => {
    const sync = { mode: 'sync', source };
    expect(validate('email.send', sync)).toEqual(['/steps/send/config/source unknown_reference']);
    expect(
      validateAutomation(
        {
          name: 'Email',
          triggers: [{ id: 'created', type: 'contact.created', config: {} }],
          start: 'send',
          steps: { send: { type: 'email.send', config: sync } },
        },
        { ...setup, emailTemplates: [{ id: template, name: 'Welcome' }] },
      ).errors,
    ).toEqual([]);
    expect(validate('email.send', { mode: 'copy', subject: 'Hi', body: 'Text', source })).toEqual(
      [],
    );
  });
  it('knows the unsubscribe link in an email only', () => {
    expect(
      validate('email.send', { subject: 'Hi', body: 'Stop: {{email.unsubscribe_link}}' }),
    ).toEqual([]);
    expect(validate('sms.send', { message: 'Stop: {{email.unsubscribe_link}}' })).toContain(
      '/steps/send/config/message unknown_merge_field',
    );
  });
});

describe('email content', () => {
  it('is plain text, or formatted text with an optional text part', () => {
    expect(emailContent.parse({ format: 'text', text: 'Hello' })).toEqual({
      format: 'text',
      text: 'Hello',
    });
    expect(emailContent.parse({ format: 'html', html: '<p>Hello</p>' })).toEqual({
      format: 'html',
      html: '<p>Hello</p>',
    });
    expect(emailContent.safeParse({ format: 'html', html: '<p>Hello</p>', text: '' }).success).toBe(
      true,
    );
    for (const refused of [
      { format: 'text', text: '' },
      { format: 'text', text: 'x'.repeat(EMAIL_CONTENT_LIMITS.text + 1) },
      { format: 'html', html: '' },
      { format: 'html', html: 'x'.repeat(EMAIL_CONTENT_LIMITS.html + 1) },
      { format: 'html', html: '<p>a</p>', text: 'x'.repeat(EMAIL_CONTENT_LIMITS.text + 1) },
      { format: 'html', html: '<p>a</p>', extra: true },
      { format: 'blocks', blocks: [] },
    ])
      expect(emailContent.safeParse(refused).success).toBe(false);
  });

  it('keeps preview text to one trimmed line of 150 characters', () => {
    expect(emailPreheader.parse('  Peek  ')).toBe('Peek');
    expect(emailPreheader.safeParse('x'.repeat(150)).success).toBe(true);
    expect(emailPreheader.safeParse('x'.repeat(151)).success).toBe(false);
    expect(emailPreheader.safeParse('a\nb').success).toBe(false);
    expect(emailPreheader.safeParse('   ').success).toBe(false);
  });

  it('reads a template input as body or content, never both and never neither', () => {
    expect(messageTemplateInput.parse({ name: 'N', subject: 'S', body: 'B' })).toEqual({
      name: 'N',
      subject: 'S',
      body: 'B',
    });
    expect(
      messageTemplateInput.safeParse({
        name: 'N',
        subject: 'S',
        content: { format: 'html', html: '<p>B</p>' },
        preheader: null,
      }).success,
    ).toBe(true);
    expect(templateContentOf({ body: 'B' })).toEqual({ format: 'text', text: 'B' });
    expect(templateContentOf({ content: { format: 'html', html: '<p>B</p>' } })).toEqual({
      format: 'html',
      html: '<p>B</p>',
    });
    expect(templateContentOf({})).toEqual({ code: 'content_required' });
    expect(templateContentOf({ body: 'B', content: { format: 'text', text: 'B' } })).toEqual({
      code: 'content_twice',
    });
  });

  it('finds merge fields in every part, each once', () => {
    expect(
      mergeTokens({
        subject: 'Hi {{contact.firstName}}',
        body: '{{contact.firstName}} {{contact.email}}',
        html: '<a href="{{trigger_link.book}}">{{contact.email}}</a>',
        preheader: '{{contact.lastName}}',
      }),
    ).toEqual(['contact.firstName', 'contact.lastName', 'contact.email', 'trigger_link.book']);
    expect(mergeTokens({ subject: '{{contact.name}}', body: 'x' })).toEqual(['contact.name']);
  });

  it('shows the start of a text on one line', () => {
    expect(emailPreviewLine('  Hello\n\n  there   friend ')).toBe('Hello there friend');
    const long = emailPreviewLine('word '.repeat(60));
    expect(long).toHaveLength(140);
    expect(long.endsWith('…')).toBe(true);
    expect(emailPreviewLine('x'.repeat(140))).toBe('x'.repeat(140));
  });
});

describe('the new operations', () => {
  it('previews a template or unsaved content', () => {
    expect(renderEmailPreviewInput.parse({ template })).toEqual({
      template,
      values: {},
      footer: true,
    });
    expect(
      renderEmailPreviewInput.safeParse({
        subject: 'Hi',
        content: { format: 'text', text: 'Body' },
        contact: 'con_01h455vb4pex5vsknk084sn02q',
        values: { 'contact.firstName': 'Ada' },
        footer: false,
      }).success,
    ).toBe(true);
    expect(renderEmailPreviewInput.safeParse({ subject: 'A\nB' }).success).toBe(false);
    expect(renderEmailPreviewInput.safeParse({ template, unknown: 1 }).success).toBe(false);
  });

  it('names a draft step and the template revision to sync or save', () => {
    const target = { baseDraftVersion: 1, step: 'send' };
    expect(enableWorkflowEmailSyncInput.safeParse({ ...target, template, revision }).success).toBe(
      true,
    );
    expect(enableWorkflowEmailSyncInput.safeParse({ ...target, template }).success).toBe(false);
    expect(
      saveSyncedWorkflowEmailInput.safeParse({
        ...target,
        revision,
        subject: 'Hi',
        content: { format: 'html', html: '<p>Hi</p>' },
        preheader: null,
      }).success,
    ).toBe(true);
    expect(
      saveSyncedWorkflowEmailInput.safeParse({
        ...target,
        revision,
        subject: ' ',
        content: { format: 'text', text: 'x' },
      }).success,
    ).toBe(false);
  });

  it('pages the inventory and takes a date range for statistics', () => {
    expect(listTemplateWorkflowActions.query.parse({})).toEqual({ limit: 50 });
    expect(listTemplateWorkflowActions.query.parse({ limit: '10' })).toEqual({ limit: 10 });
    expect(listTemplateWorkflowActions.query.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      getWorkflowEmailStepStatistics.query.safeParse({
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-13T00:00:00+03:00',
      }).success,
    ).toBe(true);
    expect(getWorkflowEmailStepStatistics.query.safeParse({ from: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('never answers an unmeasured number as zero', () => {
    const counts = {
      step: 'send',
      from: null,
      to: null,
      total: 0,
      waiting: 0,
      sent: 0,
      delivered: null,
      bounced: 0,
      failed: 0,
      skipped: { total: 0, reasons: [] },
      unsubscribed: 0,
      opened: null,
      clicked: null,
    };
    expect(workflowEmailStepStatistics.safeParse(counts).success).toBe(true);
    expect(workflowEmailStepStatistics.safeParse({ ...counts, opened: 0 }).success).toBe(false);
    expect(workflowEmailStepStatistics.safeParse({ ...counts, clicked: 0 }).success).toBe(false);
  });
});
