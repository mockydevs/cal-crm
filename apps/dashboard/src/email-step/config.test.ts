// A Send email step's settings to the panel and back, in each form the contract writes.
// Every config a function here gives is checked against the contract.
import { automationStepTypes } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  addAddresses,
  emailMode,
  emailStepOf,
  envelopeOf,
  isCopyAddress,
  linkedTemplate,
  mergePathOf,
  missingEmailParts,
  savedEmailConfig,
  withContent,
  withCopy,
  withEnvelope,
  withoutContent,
  withSync,
  withTemplate,
} from './config';

const source = { id: 'tmpl_01h455vb4pex5vsknk084sn02q', revision: 'a'.repeat(64) };
const envelope = {
  mailbox: 'mbx_sales',
  fromName: 'Dana at {{custom_values.business_name}}',
  replyTo: '{{contact.email}}',
  cc: ['owner@harbor.example'],
  bcc: ['{{contact.custom.planner_email}}'],
  attachments: ['file_01h455vb4pex5vsknk084sn02q'],
};
const accepted = (config: Record<string, unknown>): boolean =>
  automationStepTypes['email.send'].config.safeParse(config).success;

const inline = { subject: 'Hello', body: 'Welcome.' };
const formatted = { subject: 'Hello', body: 'Welcome.', html: '<p>Welcome.</p>' };
const copy = { mode: 'copy', source, subject: 'Copied', body: 'Text', html: '<p>Text</p>' };
const sync = { mode: 'sync', source };
const reference = { template: source.id };

describe('the four ways a step is written', () => {
  it.each([
    ['inline', inline, 'inline'],
    ['inline, formatted', formatted, 'inline'],
    ['copy', copy, 'copy'],
    ['sync', sync, 'sync'],
    ['reference', reference, 'reference'],
    ['an empty step', {}, 'inline'],
  ] as const)('reads %s as written, and never from a source id alone', (_name, config, mode) => {
    expect(emailMode(config)).toBe(mode);
  });

  it('never calls content with a stray source a sync', () => {
    expect(emailMode({ source, subject: 'x', body: 'y' })).toBe('inline');
  });

  it('holds a copy with what it came from, and its formatted part', () => {
    expect(emailStepOf({ ...copy, ...envelope })).toEqual({
      mode: 'copy',
      template: source.id,
      source,
      subject: 'Copied',
      body: 'Text',
      html: '<p>Text</p>',
      preheader: '',
      ...envelope,
    });
  });

  it('holds no content for a sync or a reference, and their own subject', () => {
    expect(emailStepOf({ ...sync, subject: 'Mine', body: 'stray' })).toMatchObject({
      mode: 'sync',
      template: source.id,
      subject: 'Mine',
      body: '',
      html: undefined,
    });
    expect(emailStepOf(reference)).toMatchObject({
      mode: 'reference',
      template: source.id,
      source: undefined,
      subject: '',
      cc: [],
      attachments: [],
    });
    expect(emailStepOf({ mode: 'sync', source: 'broken' }).source).toBeUndefined();
    expect(emailStepOf({ html: '   ', cc: 'not a list', bcc: [1, 'a@b.example'] })).toMatchObject({
      html: undefined,
      cc: [],
      bcc: ['a@b.example'],
    });
  });
});

describe('changing how the email is written', () => {
  it('writes content into a step, keeping who it is from', () => {
    const next = withContent({ ...reference, ...envelope }, formatted);
    expect(next).toEqual({ ...envelope, ...formatted });
    expect(accepted(next)).toBe(true);
  });

  it('keeps a copy a copy, with its source, as its content is edited', () => {
    const next = withContent(copy, { subject: 'Edited', body: 'New', html: undefined });
    expect(next).toEqual({ mode: 'copy', source, subject: 'Edited', body: 'New' });
    expect(accepted(next)).toBe(true);
    // A copy that names no source stays a copy too.
    expect(
      withContent({ mode: 'copy', subject: 'a', body: 'b' }, { ...inline, html: undefined }),
    ).toEqual({
      mode: 'copy',
      ...inline,
    });
  });

  it('names a template as a reference, dropping the content and the old source', () => {
    const next = withTemplate({ ...copy, ...envelope }, 'tmpl_next');
    expect(next).toEqual({ ...envelope, template: 'tmpl_next' });
    expect(accepted(next)).toBe(true);
  });

  it('copies a template read here, with its revision', () => {
    const next = withCopy({ ...reference, ...envelope }, source, formatted);
    expect(next).toEqual({ ...envelope, mode: 'copy', source, ...formatted });
    expect(accepted(next)).toBe(true);
  });

  it('syncs without content; a copied subject is not the step’s own, a reference’s is', () => {
    expect(withSync({ ...copy, ...envelope }, source)).toEqual({
      ...envelope,
      mode: 'sync',
      source,
    });
    expect(withSync({ ...reference, subject: 'Mine' }, source)).toEqual({
      mode: 'sync',
      source,
      subject: 'Mine',
    });
    expect(withSync({ ...sync, subject: '  ' }, source)).toEqual({ mode: 'sync', source });
    expect(accepted(withSync({ ...copy, ...envelope }, source))).toBe(true);
  });

  it('clears the content and keeps the rest, also a member it does not know', () => {
    expect(withoutContent({ ...copy, mailbox: 'mbx_sales', future: 1 })).toEqual({
      future: 1,
      mailbox: 'mbx_sales',
      subject: '',
      body: '',
    });
    expect(envelopeOf({ ...copy, mailbox: 'mbx_sales' })).toEqual({ mailbox: 'mbx_sales' });
  });

  it('sets one member of the envelope, and takes an empty one away', () => {
    expect(withEnvelope(inline, 'fromName', 'Dana')).toEqual({ ...inline, fromName: 'Dana' });
    expect(withEnvelope({ ...inline, fromName: 'Dana' }, 'fromName', '')).toEqual(inline);
    expect(withEnvelope(inline, 'cc', ['a@b.example'])).toEqual({ ...inline, cc: ['a@b.example'] });
    expect(withEnvelope({ ...inline, cc: ['a@b.example'] }, 'cc', [])).toEqual(inline);
  });
});

describe('what is saved', () => {
  it('leaves out what was left empty, and repeats', () => {
    const saved = savedEmailConfig({
      ...formatted,
      mailbox: '',
      fromName: '  ',
      replyTo: '',
      preheader: 'Open me',
      cc: [' a@b.example ', 'a@b.example', ''],
      bcc: [],
      attachments: [],
    });
    expect(saved).toEqual({ ...formatted, preheader: 'Open me', cc: ['a@b.example'] });
    expect(accepted(saved)).toBe(true);
  });

  it('keeps the preview text only where there is a formatted part or a template', () => {
    expect(savedEmailConfig({ ...inline, preheader: 'Open me', html: ' ' })).toEqual(inline);
    expect(savedEmailConfig({ ...sync, preheader: 'Open me', subject: '' })).toEqual({
      ...sync,
      preheader: 'Open me',
    });
    expect(savedEmailConfig({ ...reference, subject: ' ' })).toEqual(reference);
    expect(accepted(savedEmailConfig({ ...sync, ...envelope, preheader: 'Open me' }))).toBe(true);
    expect(accepted(savedEmailConfig({ ...reference, ...envelope, subject: 'Mine' }))).toBe(true);
  });
});

describe('what is still missing', () => {
  it('asks content written here for a subject and a message', () => {
    expect(missingEmailParts({})).toEqual(['subject', 'body']);
    expect(missingEmailParts({ subject: 'Hi', body: ' ' })).toEqual(['body']);
    expect(missingEmailParts(copy)).toEqual([]);
  });
  it('asks a step that names a template only for the template', () => {
    expect(missingEmailParts({ template: '' })).toEqual(['template']);
    expect(missingEmailParts(reference)).toEqual([]);
    expect(missingEmailParts(sync)).toEqual([]);
  });
  it('says which template an email is linked to', () => {
    expect(linkedTemplate(copy)).toBe(source.id);
    expect(linkedTemplate(sync)).toBe(source.id);
    expect(linkedTemplate(reference)).toBe(source.id);
    expect(linkedTemplate(inline)).toBeUndefined();
    expect(linkedTemplate({ template: '' })).toBeUndefined();
  });
});

describe('Cc and Bcc', () => {
  it('takes an address or one merge field', () => {
    expect(isCopyAddress('owner@harbor.example')).toBe(true);
    expect(isCopyAddress('{{ contact.email }}')).toBe(true);
    expect(isCopyAddress('owner@harbor')).toBe(false);
    expect(isCopyAddress('Hi {{contact.email}}')).toBe(false);
    expect(isCopyAddress(`${'a'.repeat(250)}@b.example`)).toBe(false);
    expect(mergePathOf('{{ contact.email }}')).toBe('contact.email');
    expect(mergePathOf('owner@harbor.example')).toBeUndefined();
  });

  it('adds several at once, set apart by commas, semicolons or spaces', () => {
    expect(addAddresses(['a@b.example'], 'c@d.example; {{ contact.email }}, e@f.example')).toEqual({
      list: ['a@b.example', 'c@d.example', '{{ contact.email }}', 'e@f.example'],
    });
    expect(addAddresses(['a@b.example'], '   ')).toEqual({ list: ['a@b.example'] });
  });

  it('adds nothing when one is not an address, is there already, or would be too many', () => {
    expect(addAddresses([], 'a@b.example nope')).toEqual({ list: [], problem: 'not_an_address' });
    expect(addAddresses(['a@b.example'], 'A@B.example')).toEqual({
      list: ['a@b.example'],
      problem: 'already_there',
    });
    const ten = Array.from({ length: 10 }, (_, index) => `p${String(index)}@b.example`);
    expect(addAddresses(ten, 'one@more.example')).toEqual({ list: ten, problem: 'too_many' });
  });
});
