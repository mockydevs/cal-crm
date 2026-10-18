// What the composer and the thread's items render, read from their markup. These run
// without a browser, so they check what is on the page and what is not; what happens on a
// click is covered by the rules' own tests (inbox-rules.test.ts) and e2e/inbox.spec.ts.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { ConversationComposer } from '@repo/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bookings,
  composerOf,
  contactId,
  conversationId,
  leftChat,
  mayaEmail,
  mayaPhone,
  messageOf,
  noteOf,
  openChat,
} from '../e2e/inbox-fixtures';
import { Composer, type ComposerDraft, type DraftStore } from './inbox-composer';
import { MessageItem, NoteItem, UnverifiedNote } from './inbox-thread';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const html = (element: ReactElement): string =>
  renderToStaticMarkup(<I18nProvider i18n={i18n}>{element}</I18nProvider>);

const id = conversationId('1');
const noDraft: ComposerDraft = {
  mode: undefined,
  channel: undefined,
  accountId: undefined,
  to: undefined,
  subject: undefined,
  text: '',
  note: '',
};

function composerHtml(options: {
  readonly composer?: ConversationComposer | undefined;
  readonly canManage: boolean;
  readonly draft?: Partial<ComposerDraft>;
}): string {
  const drafts: DraftStore = new Map(
    options.draft === undefined ? [] : [[id, { ...noDraft, ...options.draft }]],
  );
  return html(
    <Composer
      conversationId={id}
      contactName="Maya Thompson"
      composer={'composer' in options ? options.composer : composerOf()}
      composerFailed={false}
      onRetryComposer={vi.fn()}
      canManage={options.canManage}
      drafts={drafts}
      onSendReply={vi.fn()}
      onAddNote={vi.fn()}
    />,
  );
}

const count = (markup: string, piece: string): number => markup.split(piece).length - 1;

describe('Composer', () => {
  it('shows no composer at all to someone who may only read', () => {
    const markup = composerHtml({ composer: composerOf({ canReply: false }), canManage: false });
    expect(markup).toContain('You can read this conversation.');
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<input');
  });

  it('offers only the note to someone who may manage but not reply', () => {
    const markup = composerHtml({ composer: composerOf({ canReply: false }), canManage: true });
    expect(count(markup, '<form')).toBe(1);
    expect(markup).toContain('aria-label="Internal note"');
    expect(markup).toContain('Save internal note');
    expect(markup).not.toContain('Send email');
    expect(markup).not.toContain('Reply to contact');
  });

  it('offers only the reply to someone who may reply but not manage', () => {
    const markup = composerHtml({ canManage: false });
    expect(count(markup, '<form')).toBe(1);
    expect(markup).toContain('aria-label="Reply to Maya Thompson"');
    expect(markup).toContain('Send email');
    expect(markup).not.toContain('Save internal note');
    expect(markup).not.toContain('Internal note');
  });

  it('starts on the reply, as its own form, with the send button named for the channel', () => {
    const markup = composerHtml({ canManage: true });
    expect(count(markup, '<form')).toBe(1);
    expect(markup).toContain('aria-label="Reply to Maya Thompson"');
    expect(markup).toContain('Message to Maya Thompson');
    expect(count(markup, 'type="submit"')).toBe(1);
    expect(markup).toContain('Send email');
    // The note's form, its warning and its button are not on the page with the reply's.
    expect(markup).not.toContain('Save internal note');
    expect(markup).not.toContain('only your team sees this');
    // The suggested subject, the first account and the contact's primary address.
    expect(markup).toContain('value="Re: June 13"');
    expect(markup).toContain('Bookings · bookings@harbor.test');
    expect(markup).toContain(mayaEmail.address);
  });

  it('gives the note its own form, marked as internal, with no way to send', () => {
    const markup = composerHtml({
      canManage: true,
      draft: { mode: 'note', text: 'A reply half written', note: 'She haggles.' },
    });
    expect(count(markup, '<form')).toBe(1);
    expect(markup).toContain('aria-label="Internal note"');
    expect(markup).toContain(
      'Internal note: only your team sees this. It is never sent to Maya Thompson.',
    );
    expect(count(markup, 'type="submit"')).toBe(1);
    expect(markup).toContain('Save internal note');
    expect(markup).not.toContain('Send email');
    expect(markup).not.toContain('Send text message');
    // Each form holds its own words: the reply's draft is not in the note's box.
    expect(markup).toContain('She haggles.');
    expect(markup).not.toContain('A reply half written');
    expect(markup).toContain('border-dashed');
  });

  it('keeps a note draft out of the reply form', () => {
    const markup = composerHtml({
      canManage: true,
      draft: { mode: 'reply', text: 'June 13 is open.', note: 'She haggles.' },
    });
    expect(markup).toContain('June 13 is open.');
    expect(markup).not.toContain('She haggles.');
  });

  it('says why a channel is unavailable, in words', () => {
    const markup = composerHtml({ canManage: false });
    expect(markup).toContain(
      'Text message: Text messages can&#x27;t be sent: this install isn&#x27;t set up to deliver them.',
    );
  });

  it('offers no reply form when no channel can send, and says why for each', () => {
    const none = composerOf({
      channels: [
        {
          channel: 'email',
          available: true,
          unavailable: null,
          accounts: [],
          recipients: [mayaEmail],
        },
      ],
    });
    const markup = composerHtml({ composer: none, canManage: false });
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('type="submit"');
    expect(markup).toContain('You can&#x27;t reply to Maya Thompson from here yet.');
    expect(markup).toContain('Email: Email isn&#x27;t connected yet.');
    expect(markup).toContain('Text message: Text messages aren&#x27;t connected yet.');
  });

  it('says nothing of web chat in a conversation nobody chatted in', () => {
    const markup = composerHtml({ canManage: true });
    expect(markup).not.toContain('Web chat');
    expect(markup).not.toContain('chat');
  });

  it('answers a chat from its widget, with no address to choose and no subject', () => {
    const chatting = composerOf({ channels: [...composerOf().channels.slice(0, 2), openChat] });
    const markup = composerHtml({
      composer: chatting,
      canManage: false,
      draft: { channel: 'webchat', to: mayaEmail.id, subject: 'Left over from email' },
    });
    expect(count(markup, '<form')).toBe(1);
    expect(markup).toContain('Send chat message');
    expect(markup).not.toContain('Send email');
    expect(markup).toContain('Harbor website');
    expect(markup).toContain('The visitor, in their chat');
    // Three choices for email (channel, account, address); two for chat.
    expect(count(composerHtml({ canManage: false }), 'role="combobox"')).toBe(3);
    expect(count(markup, 'role="combobox"')).toBe(2);
    expect(markup).not.toContain(mayaEmail.address);
    expect(markup).not.toContain('Subject');
    expect(markup).not.toContain('Left over from email');
    expect(markup).toContain('maxLength="2000"');
  });

  it('starts on the channel the server suggests, and on the one chosen once someone chooses', () => {
    const [email] = composerOf().channels;
    if (email === undefined) throw new Error('The fixture offers no email.');
    const text = {
      channel: 'sms' as const,
      available: true,
      unavailable: null,
      accounts: [{ id: bookings.id, name: 'Front desk', address: '+15550100000' }],
      recipients: [mayaPhone],
    };
    // Maya has an email address, and last wrote by text.
    const lastByText = composerOf({ channels: [email, text], suggestedChannel: 'sms' });
    const markup = composerHtml({ composer: lastByText, canManage: false });
    expect(markup).toContain('Send text message');
    expect(markup).not.toContain('Send email');
    expect(markup).not.toContain('Subject');
    expect(markup).toContain(mayaPhone.address);
    // Someone chose email for this reply: it stays email.
    const chosen = composerHtml({
      composer: lastByText,
      canManage: false,
      draft: { channel: 'email' },
    });
    expect(chosen).toContain('Send email');
    expect(chosen).not.toContain('Send text message');
    // A server that suggests nothing leaves the first channel that can send.
    const unsaid = composerHtml({
      composer: composerOf({ channels: [email, text], suggestedChannel: null }),
      canManage: false,
    });
    expect(unsaid).toContain('Send email');
  });

  it('says the visitor has left, and still offers the channels that reach them', () => {
    const left = composerOf({ channels: [...composerOf().channels.slice(0, 2), leftChat] });
    const markup = composerHtml({
      composer: left,
      canManage: false,
      draft: { channel: 'webchat' },
    });
    expect(markup).toContain(
      'Web chat: The visitor has left the chat, so a reply would reach nobody.',
    );
    expect(markup).toContain('Send email');
    expect(markup).not.toContain('Send chat message');
    // With chat the only channel, there is no form at all.
    const only = composerHtml({
      composer: composerOf({ channels: [leftChat] }),
      canManage: false,
    });
    expect(only).not.toContain('<form');
    expect(only).toContain('Web chat: The visitor has left the chat');
  });

  it('sends nothing before the reply options are read', () => {
    const waiting = composerHtml({ composer: undefined, canManage: false });
    expect(waiting).toContain('Loading reply options…');
    expect(waiting).not.toContain('<form');
    const noting = composerHtml({ composer: undefined, canManage: true });
    expect(noting).toContain('aria-label="Internal note"');
    expect(noting).not.toContain('Send email');
  });
});

describe('UnverifiedNote', () => {
  it('says nothing proves who a web chat visitor is', () => {
    const markup = html(<UnverifiedNote claimed={null} slug="harbor" />);
    expect(markup).toContain('role="note"');
    expect(markup).toContain('aria-label="Unverified identity"');
    expect(markup).toContain('Unverified: this person wrote through web chat.');
    expect(markup).toContain('Their name and email address are only what they typed.');
    expect(markup).not.toContain('already belongs to');
    expect(markup).not.toContain('<a');
  });

  it('names the contact that holds the address typed, and that the two were kept apart', () => {
    const markup = html(
      <UnverifiedNote
        claimed={{ id: contactId('2'), name: 'Maya <script>alert(1)</script>', trashed: true }}
        slug="harbor"
      />,
    );
    expect(markup).toContain(
      'The email address they typed already belongs to Maya &lt;script&gt;alert(1)&lt;/script&gt;. They were kept',
    );
    expect(markup).toContain('They were kept as a separate contact');
    expect(markup).toContain('That contact is in the trash.');
    // A contact in the trash has no page to open.
    expect(markup).not.toContain('<a');
    expect(markup).not.toContain('<script');
  });

  it('never leaves a contact without a name unnamed', () => {
    const markup = html(
      <UnverifiedNote claimed={{ id: contactId('2'), name: ' ', trashed: true }} slug="harbor" />,
    );
    expect(markup).toContain('already belongs to another contact.');
  });
});

describe('thread items', () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';

  it('shows an inbound message as text, with its channel, sender and state in words', () => {
    const markup = html(
      <ol>
        <MessageItem
          message={messageOf({ text: hostile, subject: '<b>Hello</b>' })}
          contactName="Maya Thompson"
        />
      </ol>,
    );
    expect(markup).toContain('Email from Maya Thompson');
    expect(markup).toContain('data-direction="inbound"');
    expect(markup).toContain('>Received<');
    expect(markup).toContain('&lt;b&gt;Hello&lt;/b&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<b>');
  });

  it('says in words why a reply was not sent', () => {
    const markup = html(
      <ol>
        <MessageItem
          message={messageOf({
            direction: 'outbound',
            author: { kind: 'user', name: 'Dana Brooks', you: true },
            status: 'failed',
            problem: { code: 'consent_required', message: 'Maya has not agreed to email.' },
          })}
          contactName="Maya Thompson"
        />
      </ol>,
    );
    expect(markup).toContain('Email to Maya Thompson, from you');
    expect(markup).toContain('data-delivery="failed"');
    expect(markup).toContain('>Not sent<');
    expect(markup).toContain(
      'This contact hasn&#x27;t agreed to receive messages on this channel.',
    );
    expect(markup).not.toContain('Maya has not agreed to email.');
  });

  it('says a held reply is waiting, why, and until when', () => {
    const markup = html(
      <ol>
        <MessageItem
          message={messageOf({
            direction: 'outbound',
            author: { kind: 'automation', name: 'Follow-up', you: false },
            status: 'queued',
            held: {
              code: 'quiet_hours',
              message: "It's outside Maya's contact hours.",
              until: '2026-10-10T05:00:00.000Z',
            },
          })}
          contactName="Maya Thompson"
        />
      </ol>,
    );
    expect(markup).toContain('Email to Maya Thompson, from Follow-up');
    expect(markup).toContain('>Waiting to send<');
    expect(markup).toContain(
      'It&#x27;s quiet hours where this contact is. It will be sent when they end.',
    );
    expect(markup).not.toContain('It&#x27;s outside Maya&#x27;s contact hours.');
    expect(markup).toContain('It will be tried again on');
  });

  it('marks an internal note in words, and shows it as text', () => {
    const markup = html(
      <ol>
        <NoteItem note={noteOf({ text: hostile })} />
      </ol>,
    );
    expect(markup).toContain('data-kind="note"');
    expect(markup).toContain('Internal note');
    expect(markup).toContain('Only your team sees this');
    expect(markup).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('border-dashed');
  });
});
