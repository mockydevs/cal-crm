// What is written under a thread: a reply to the contact, or an internal note for the
// team. The two are separate forms. Each has its own text, its own draft and its own
// button, and the note's form looks and reads unlike the reply's, so a note is never sent
// by mistake: nothing typed as a note can reach the reply's button, and the note form has
// no way to send at all (its only action is onAddNote).
//
// A reply the assistant drafted can be changed here before it goes: the reply form then
// holds the draft, says so, and its button applies that proposal with what the form holds
// instead of sending a reply of its own. The proposal is what keeps a second click from
// sending twice.
//
// A snippet goes into the reply from the Snippets button or a "/" typed at the start of a
// word: the picker is fetched when first opened, fills the snippet in for the
// conversation's contact, and what it hands back is typed into the message where the caret
// was, so it is the person's own text from then on.
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  MESSAGE_TEXT_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  WEBCHAT_LIMITS,
  type ConversationComposer,
  type ReplyChannel,
  type ThreadMessage,
  type ThreadNote,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { Lock, MessageSquareText, Send } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from 'react';
import {
  channelChoicesOf,
  channelGapWords,
  channelWords,
  composerModesOf,
  deliveryOf,
  deliveryWords,
  failureOf,
  replyContentOf,
  replyRefusalWords,
  selectionFor,
  serverRefusalOf,
  type ChannelChoice,
  type ComposerMode,
  type Delivery,
  type ReplyContent,
  type ReplyRefusal,
} from './inbox-rules';
import type { FilledSnippet } from './snippet-picker';
import {
  insertSnippet,
  pickerAfterTyping,
  slashQueryAt,
  snippetTypeFor,
  unfilledFields,
  type PickerState,
} from './snippet-picker-rules';

// Fetched when the picker is first opened: most replies are typed, not picked.
const SnippetPicker = lazy(() => import('./snippet-picker'));

/** What someone has written in one conversation and not sent or saved yet. */
export interface ComposerDraft {
  readonly mode: ComposerMode | undefined;
  readonly channel: ReplyChannel | undefined;
  readonly accountId: string | undefined;
  readonly to: string | undefined;
  /** Undefined until the person touches it: the suggested subject shows meanwhile. */
  readonly subject: string | undefined;
  readonly text: string;
  readonly note: string;
  /** The assistant's proposal the reply form is changing, if it holds one. */
  readonly proposalId?: string | undefined;
}

/** A reply the assistant drafted, as it is handed to the reply form to be changed. */
export interface AssistantDraft {
  readonly proposalId: string;
  readonly channel: ReplyChannel;
  readonly accountId: string;
  readonly to: string | null;
  readonly subject: string | null;
  readonly text: string;
}

/** What the thread can ask of the composer. */
export interface ComposerHandle {
  /** Puts a drafted reply in the reply form and moves the keyboard to its message. */
  readonly editDraft: (draft: AssistantDraft) => void;
}

/** Drafts by conversation, kept while the Inbox stays open, so switching loses nothing. */
export type DraftStore = Map<string, ComposerDraft>;

const emptyDraft: ComposerDraft = {
  mode: undefined,
  channel: undefined,
  accountId: undefined,
  to: undefined,
  subject: undefined,
  text: '',
  note: '',
};

type Outcome =
  | { readonly kind: 'replied'; readonly delivery: Delivery }
  /** The assistant's draft was applied, and the thread couldn't be read to say how it fared. */
  | { readonly kind: 'handed_over' }
  /** The draft being changed can no longer be applied: the server says why. */
  | { readonly kind: 'draft_gone'; readonly detail: string }
  | { readonly kind: 'refused'; readonly why: ReplyRefusal }
  | { readonly kind: 'reply_failed'; readonly message: string | undefined }
  | { readonly kind: 'noted' }
  | { readonly kind: 'note_failed'; readonly message: string | undefined };

/**
 * Types text into the box that has the keyboard, in place of what is selected there, as the
 * person's own keys do, so the browser's undo takes it back: no other way of putting text
 * in a box keeps its undo history. False where the browser has no such command; the text
 * is then set instead.
 */
function typeIn(text: string): boolean {
  if (!('execCommand' in document)) return false;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the one way to do this (above)
  return document.execCommand('insertText', false, text);
}

const controlClassName =
  'min-h-11 w-full min-w-0 rounded-control border border-input bg-card px-3 text-md text-foreground';
const labelClassName = 'flex min-w-0 flex-col gap-1.5 text-sm font-medium';

/**
 * What the server said was wrong: our words for a refusal code the contract defines, or
 * else the server's own; undefined when it never answered.
 */
function serverWords(
  error: unknown,
  translate: (words: MessageDescriptor) => string,
): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const issue = error.problem.errors?.[0];
  const known = serverRefusalOf(issue?.code);
  return known === undefined ? (issue?.message ?? error.message) : translate(known);
}

export interface ComposerProps {
  readonly conversationId: string;
  /** The contact a snippet is filled in for. Without it, the reply offers no snippets. */
  readonly contactId?: string | undefined;
  readonly contactName: string;
  /** Undefined until it is read. Nothing can be sent before then. */
  readonly composer: ConversationComposer | undefined;
  readonly composerFailed: boolean;
  readonly onRetryComposer: () => void;
  /** Whether the person may add internal notes. */
  readonly canManage: boolean;
  readonly drafts: DraftStore;
  readonly onSendReply: (content: ReplyContent) => Promise<ThreadMessage>;
  readonly onAddNote: (text: string) => Promise<ThreadNote>;
  /**
   * Applies the assistant's proposal with what the reply form holds. Resolves with the
   * message that made, or undefined when the thread couldn't be read afterwards.
   */
  readonly onApplyDraft?: (
    proposalId: string,
    changes: ReplyContent,
  ) => Promise<ThreadMessage | undefined>;
  /** Told which proposal the reply form is changing, whenever that changes. */
  readonly onEditingDraft?: (proposalId: string | undefined) => void;
  readonly ref?: Ref<ComposerHandle>;
}

export function Composer({
  conversationId,
  contactId,
  contactName,
  composer,
  composerFailed,
  onRetryComposer,
  canManage,
  drafts,
  onSendReply,
  onAddNote,
  onApplyDraft,
  onEditingDraft,
  ref,
}: ComposerProps): ReactElement {
  const { t, i18n } = useLingui();
  const [draft, setDraft] = useState<ComposerDraft>(() => drafts.get(conversationId) ?? emptyDraft);
  const [outcome, setOutcome] = useState<Outcome>();
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteHintId = useId();
  const unavailableId = useId();
  const editingId = useId();
  const unfilledId = useId();
  const snippetsRef = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<PickerState>();
  // Where the "/" is that the person closed the picker on: it stays closed for that word.
  const dismissedRef = useRef<number | undefined>(undefined);
  // True while a snippet is being typed in, which is not the person typing a "/".
  const insertingRef = useRef(false);
  // Where the caret goes when the keyboard is next given to the message.
  const caretRef = useRef<number | undefined>(undefined);
  // A box is disabled while its send is in flight, and a disabled box can't take focus:
  // it is given back once the box is enabled again.
  const refocusRef = useRef<'reply' | 'note' | undefined>(undefined);
  useEffect(() => {
    if (sending || saving || refocusRef.current === undefined) return;
    (refocusRef.current === 'reply' ? replyRef : noteRef).current?.focus();
    refocusRef.current = undefined;
  }, [sending, saving]);

  const change = (changes: Partial<ComposerDraft>): void => {
    // From the store, which is never behind: two changes in one event both count.
    const next = { ...(drafts.get(conversationId) ?? draft), ...changes };
    drafts.set(conversationId, next);
    setDraft(next);
    if (next.proposalId !== draft.proposalId) onEditingDraft?.(next.proposalId);
  };

  // The keyboard goes to the message once the form that holds it is on the page.
  const [focusRequests, setFocusRequests] = useState(0);
  useEffect(() => {
    const box = replyRef.current;
    if (focusRequests === 0 || box === null) return;
    box.focus();
    if (caretRef.current !== undefined) box.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = undefined;
  }, [focusRequests]);
  useImperativeHandle(ref, () => ({
    editDraft(handed) {
      change({
        mode: 'reply',
        channel: handed.channel,
        accountId: handed.accountId,
        to: handed.to ?? undefined,
        // A draft with no subject of its own keeps the one the conversation suggests.
        subject: handed.subject ?? undefined,
        text: handed.text,
        proposalId: handed.proposalId,
      });
      setOutcome(undefined);
      setFocusRequests((requests) => requests + 1);
    },
  }));

  // Until the composer is read, only what the conversation already allows is known: notes.
  const modes = composerModesOf({ canReply: composer?.canReply === true, canManage });
  const mode = draft.mode !== undefined && modes.includes(draft.mode) ? draft.mode : modes[0];
  const choices = channelChoicesOf(composer);
  const unusable = choices.filter((choice) => !choice.usable);
  const selection = selectionFor(choices, draft, composer?.suggestedChannel ?? null);
  const choice = choices.find((each) => each.channel === selection?.channel);
  const subject = draft.subject ?? composer?.suggestedSubject ?? '';
  const replyMax =
    selection?.channel === 'webchat' ? WEBCHAT_LIMITS.messageLength : MESSAGE_TEXT_MAX_LENGTH;
  const unfilled = unfilledFields(draft.text);
  const unfilledNames = unfilled.join(', ');
  const translate = (words: MessageDescriptor): string => i18n._(words);
  const channelName = (channel: ReplyChannel): string => i18n._(channelWords[channel]);
  const whyNot = (each: ChannelChoice): string =>
    i18n._(channelGapWords[each.channel][each.gap ?? 'channel_unavailable']);

  if (composer === undefined && !canManage) {
    return composerFailed ? (
      <ComposerUnread onRetry={onRetryComposer} />
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading reply options…</Trans>
      </p>
    );
  }
  if (mode === undefined) {
    return (
      <p className="rounded-card border bg-card p-4 text-sm text-muted-foreground">
        <Trans>
          You can read this conversation. Replying and adding notes need a permission your role
          doesn't have.
        </Trans>
      </p>
    );
  }

  const sendReply = (): void => {
    if (sending || selection === undefined) return;
    const made = replyContentOf(composer, {
      kind: 'reply',
      ...selection,
      subject,
      text: draft.text,
    });
    if (!made.ok) {
      setOutcome({ kind: 'refused', why: made.why });
      replyRef.current?.focus();
      return;
    }
    setSending(true);
    setOutcome(undefined);
    setPicker(undefined);
    // The assistant's draft, changed or not, goes by applying its proposal: never as a
    // second reply beside it.
    const proposalId = onApplyDraft === undefined ? undefined : draft.proposalId;
    const sent: Promise<ThreadMessage | undefined> =
      proposalId === undefined || onApplyDraft === undefined
        ? onSendReply(made.content)
        : onApplyDraft(proposalId, made.content);
    sent
      .then((message) => {
        if (message === undefined) {
          setOutcome({ kind: 'handed_over' });
          change({ text: '', subject: undefined, proposalId: undefined });
          return;
        }
        const delivery = deliveryOf(message);
        setOutcome({ kind: 'replied', delivery });
        // A refused reply stays in the box, to change or to keep for later; one that is on
        // its way is done, and the box is ready for the next. Either way the proposal is
        // spent: what is sent next is the person's own reply.
        change(
          delivery.state === 'failed'
            ? { proposalId: undefined }
            : { text: '', subject: undefined, proposalId: undefined },
        );
      })
      .catch((error: unknown) => {
        const failure = proposalId === undefined ? undefined : failureOf(error);
        if (failure?.kind === 'conflict') {
          // The draft can't be applied any more. The words stay, as the person's own.
          setOutcome({ kind: 'draft_gone', detail: failure.detail });
          change({ proposalId: undefined });
          return;
        }
        setOutcome({
          kind: 'reply_failed',
          message:
            failure?.kind === 'forbidden'
              ? t`Sending this reply needs a permission your role doesn’t have.`
              : serverWords(error, translate),
        });
      })
      .finally(() => {
        refocusRef.current = 'reply';
        setSending(false);
      });
  };

  const closePicker = (how: 'escape' | 'elsewhere'): void => {
    if (picker === undefined) return;
    if (picker.by === 'slash') dismissedRef.current = picker.from;
    setPicker(undefined);
    // Escape gives the keyboard back to the message, where it was; a press elsewhere has
    // already taken it where the person wants it.
    if (how === 'elsewhere') return;
    caretRef.current = picker.to;
    setFocusRequests((requests) => requests + 1);
  };

  const insertFilled = (filled: FilledSnippet): boolean => {
    const box = replyRef.current;
    if (picker === undefined || box === null) return false;
    const made = insertSnippet(draft.text, picker, filled.body, replyMax);
    if (!made.ok) return false;
    setPicker(undefined);
    dismissedRef.current = undefined;
    // An email with no subject yet takes the snippet's; a subject already there is kept.
    if (selection?.channel === 'email' && filled.subject !== null && subject.trim() === '')
      change({ subject: filled.subject });
    box.focus();
    box.setSelectionRange(picker.from, picker.to);
    insertingRef.current = true;
    const typed = typeIn(filled.body);
    insertingRef.current = false;
    if (!typed) {
      change({ text: made.text });
      caretRef.current = made.caret;
      setFocusRequests((requests) => requests + 1);
    }
    return true;
  };

  const saveNote = (): void => {
    const text = draft.note.trim();
    if (saving || text === '') return;
    setSaving(true);
    setOutcome(undefined);
    onAddNote(text)
      .then(() => {
        setOutcome({ kind: 'noted' });
        change({ note: '' });
      })
      .catch((error: unknown) => {
        setOutcome({ kind: 'note_failed', message: serverWords(error, translate) });
      })
      .finally(() => {
        refocusRef.current = 'note';
        setSaving(false);
      });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {modes.length > 1 ? (
        <div
          role="group"
          aria-label={t`What to write`}
          className="flex gap-1 self-start rounded-full bg-muted p-1"
        >
          {modes.map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={mode === each}
              className={`min-h-10 rounded-full px-4 text-sm ${
                mode === each
                  ? 'bg-card font-semibold text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => {
                change({ mode: each });
                setOutcome(undefined);
              }}
            >
              {each === 'reply' ? <Trans>Reply to contact</Trans> : <Trans>Internal note</Trans>}
            </button>
          ))}
        </div>
      ) : null}

      {mode === 'reply' ? (
        selection === undefined || choice === undefined ? (
          <div className="flex min-w-0 flex-col gap-2 rounded-card border bg-card p-4 text-sm">
            <p className="font-medium">
              <Trans>You can't reply to {contactName} from here yet.</Trans>
            </p>
            <ul className="flex flex-col gap-1 text-muted-foreground">
              {unusable.map((each) => (
                <li key={each.channel}>
                  {channelName(each.channel)}: {whyNot(each)}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <form
            aria-label={t`Reply to ${contactName}`}
            className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4"
            onSubmit={(event) => {
              event.preventDefault();
              sendReply();
            }}
          >
            {draft.proposalId === undefined ? null : (
              <div
                role="group"
                aria-labelledby={editingId}
                className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-control bg-assistant px-3 py-2 text-sm text-foreground"
              >
                <p id={editingId} className="min-w-0 font-medium">
                  <Trans>You’re editing your assistant’s draft</Trans>
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={sending}
                  onClick={() => {
                    change({
                      channel: undefined,
                      accountId: undefined,
                      to: undefined,
                      subject: undefined,
                      text: '',
                      proposalId: undefined,
                    });
                    setOutcome(undefined);
                    setFocusRequests((requests) => requests + 1);
                  }}
                >
                  <Trans>Start over</Trans>
                </Button>
              </div>
            )}
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
              <label className={labelClassName}>
                <Trans>Send by</Trans>
                <Select
                  value={selection.channel}
                  disabled={sending}
                  className={controlClassName}
                  {...(unusable.length > 0 ? { 'aria-describedby': unavailableId } : {})}
                  onValueChange={(value) => {
                    const wanted = choices.find((each) => each.usable && each.channel === value);
                    // The account and the address belong to a channel: a new channel starts
                    // from its own.
                    if (wanted !== undefined)
                      change({ channel: wanted.channel, accountId: undefined, to: undefined });
                  }}
                >
                  {choices.map((each) => {
                    const name = channelName(each.channel);
                    return (
                      <option key={each.channel} value={each.channel} disabled={!each.usable}>
                        {each.usable ? name : t`${name} (unavailable)`}
                      </option>
                    );
                  })}
                </Select>
              </label>
              <label className={labelClassName}>
                <Trans>From</Trans>
                <Select
                  value={selection.accountId}
                  disabled={sending}
                  className={controlClassName}
                  onValueChange={(value) => {
                    if (choice.accounts.some((account) => account.id === value))
                      change({ channel: selection.channel, accountId: value });
                  }}
                >
                  {choice.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.address === null
                        ? account.name
                        : `${account.name} · ${account.address}`}
                    </option>
                  ))}
                </Select>
              </label>
              {selection.to === null ? (
                // Web chat has no address to choose: the reply goes into the visitor's chat.
                <div className={labelClassName}>
                  <Trans>To</Trans>
                  <p className="flex min-h-11 items-center font-normal text-muted-foreground">
                    <Trans>The visitor, in their chat</Trans>
                  </p>
                </div>
              ) : (
                <label className={labelClassName}>
                  <Trans>To</Trans>
                  <Select
                    value={selection.to}
                    disabled={sending}
                    className={controlClassName}
                    onValueChange={(value) => {
                      if (choice.recipients.some((recipient) => recipient.id === value))
                        change({ channel: selection.channel, to: value });
                    }}
                  >
                    {choice.recipients.map((recipient) => (
                      <option key={recipient.id} value={recipient.id}>
                        {recipient.address}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
            </div>
            {unusable.length > 0 ? (
              <ul id={unavailableId} className="flex flex-col gap-1 text-sm text-muted-foreground">
                {unusable.map((each) => (
                  <li key={each.channel}>
                    {channelName(each.channel)}: {whyNot(each)}
                  </li>
                ))}
              </ul>
            ) : null}
            {selection.channel === 'email' ? (
              <label className={labelClassName}>
                <Trans>Subject</Trans>
                <input
                  value={subject}
                  maxLength={998}
                  disabled={sending}
                  className={controlClassName}
                  onChange={(event) => {
                    change({ subject: event.target.value });
                  }}
                />
              </label>
            ) : null}
            <label className={labelClassName}>
              <Trans>Message to {contactName}</Trans>
              <textarea
                ref={replyRef}
                required
                rows={4}
                maxLength={replyMax}
                value={draft.text}
                disabled={sending}
                {...(unfilled.length > 0 ? { 'aria-describedby': unfilledId } : {})}
                className={`${controlClassName} resize-y py-2 font-normal`}
                onChange={(event) => {
                  const text = event.target.value;
                  change({ text });
                  if (contactId === undefined || insertingRef.current) return;
                  const found = slashQueryAt(text, event.target.selectionStart);
                  if (found === undefined) dismissedRef.current = undefined;
                  setPicker(pickerAfterTyping(picker, found, dismissedRef.current));
                }}
              />
            </label>
            {unfilled.length > 0 ? (
              <p
                id={unfilledId}
                className="rounded-control bg-attention px-3 py-2 text-sm wrap-anywhere text-attention-foreground"
              >
                <Trans>
                  Still to fill in: {unfilledNames}. A reply is sent as it is written, so replace
                  each one before you send.
                </Trans>
              </p>
            ) : null}
            <div className="relative flex min-w-0 flex-wrap items-center gap-2">
              <Button type="submit" disabled={sending}>
                <Send aria-hidden className="size-[18px]" strokeWidth={1.8} />
                {selection.channel === 'email' ? (
                  <Trans>Send email</Trans>
                ) : selection.channel === 'webchat' ? (
                  <Trans>Send chat message</Trans>
                ) : (
                  <Trans>Send text message</Trans>
                )}
              </Button>
              {contactId === undefined ? null : (
                <Button
                  ref={snippetsRef}
                  type="button"
                  variant="quiet"
                  disabled={sending}
                  aria-haspopup="dialog"
                  aria-expanded={picker !== undefined}
                  title={t`Insert a snippet. You can also type / at the start of a word.`}
                  onClick={() => {
                    if (picker !== undefined) {
                      closePicker('elsewhere');
                      return;
                    }
                    const box = replyRef.current;
                    const from = box?.selectionStart ?? draft.text.length;
                    const to = box?.selectionEnd ?? from;
                    setPicker({ from, to, query: '', by: 'button' });
                  }}
                >
                  <MessageSquareText aria-hidden className="size-[18px]" strokeWidth={1.8} />
                  <Trans>Snippets</Trans>
                </Button>
              )}
              {picker === undefined || contactId === undefined ? null : (
                <Suspense
                  fallback={
                    <p role="status" className="sr-only">
                      <Trans>Loading snippets…</Trans>
                    </p>
                  }
                >
                  <SnippetPicker
                    type={snippetTypeFor(selection.channel)}
                    contactId={contactId}
                    contactName={contactName}
                    initialQuery={picker.query}
                    opener={snippetsRef}
                    onInsert={insertFilled}
                    onClose={closePicker}
                  />
                </Suspense>
              )}
            </div>
          </form>
        )
      ) : (
        <form
          aria-label={t`Internal note`}
          className="flex min-w-0 flex-col gap-3 rounded-card border-2 border-dashed border-attention-foreground bg-attention p-4 text-attention-foreground"
          onSubmit={(event) => {
            event.preventDefault();
            saveNote();
          }}
        >
          <p id={noteHintId} className="flex items-start gap-2 text-sm font-semibold">
            <Lock aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={2} />
            <span>
              <Trans>
                Internal note: only your team sees this. It is never sent to {contactName}.
              </Trans>
            </span>
          </p>
          <label className={labelClassName}>
            <Trans>Note for your team</Trans>
            <textarea
              ref={noteRef}
              required
              rows={3}
              maxLength={NOTE_MAX_LENGTH}
              value={draft.note}
              disabled={saving}
              aria-describedby={noteHintId}
              className={`${controlClassName} resize-y py-2 font-normal`}
              onChange={(event) => {
                change({ note: event.target.value });
              }}
            />
          </label>
          <Button type="submit" variant="secondary" disabled={saving} className="self-start">
            <Lock aria-hidden className="size-[18px]" strokeWidth={1.8} />
            <Trans>Save internal note</Trans>
          </Button>
        </form>
      )}

      {composer !== undefined ? null : composerFailed ? (
        <ComposerUnread onRetry={onRetryComposer} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading reply options…</Trans>
        </p>
      )}
      <ComposerOutcome outcome={outcome} contactName={contactName} />
    </div>
  );
}

function ComposerUnread({ onRetry }: { readonly onRetry: () => void }): ReactElement {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 text-sm">
      <p>
        <Trans>Reply options couldn't be loaded.</Trans>
      </p>
      <Button variant="secondary" size="small" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
}

/** What became of the last reply or note, said plainly, beside where it was written. */
function ComposerOutcome({
  outcome,
  contactName,
}: {
  readonly outcome: Outcome | undefined;
  readonly contactName: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  if (outcome === undefined || outcome.kind === 'noted') {
    return (
      <p role="status" className="text-sm empty:sr-only">
        {outcome === undefined ? '' : t`Note saved. Only your team sees it.`}
      </p>
    );
  }
  if (outcome.kind === 'replied') {
    return <ReplyDelivery delivery={outcome.delivery} contactName={contactName} kept />;
  }
  if (outcome.kind === 'handed_over') {
    return (
      <p role="status" className="text-sm">
        <ReplyHandedOver />
      </p>
    );
  }
  if (outcome.kind === 'draft_gone') {
    return (
      <div role="alert" className="flex flex-col gap-1 text-sm">
        <p className="font-semibold text-destructive">{outcome.detail}</p>
        <p>
          <Trans>
            Nothing was sent. Your words are still in the box: sending them now sends your own
            reply.
          </Trans>
        </p>
      </div>
    );
  }
  if (outcome.kind === 'refused') {
    return (
      <p role="alert" className="text-sm text-destructive">
        {i18n._(replyRefusalWords[outcome.why])}
      </p>
    );
  }
  return (
    <p role="alert" className="text-sm text-destructive">
      {outcome.message ??
        (outcome.kind === 'reply_failed'
          ? t`The reply wasn't sent. Check your connection and try again. Trying again won't send it twice.`
          : t`The note wasn't saved. Check your connection and try again. Trying again won't save it twice.`)}
    </p>
  );
}

/** Said when a draft was applied and the thread couldn't be read to say how the reply fared. */
export function ReplyHandedOver(): ReactElement {
  return <Trans>Your reply was handed over to send. The thread shows how it went.</Trans>;
}

/**
 * How a reply that was just handed to sending fared, in the same words wherever it is
 * said: under the reply box, and under the assistant's draft after "Send it".
 */
export function ReplyDelivery({
  delivery,
  contactName,
  kept,
}: {
  readonly delivery: Delivery;
  readonly contactName: string;
  /** Whether the words are still in the reply box, to change and send again. */
  readonly kept: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const times = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const { state, reason, until } = delivery;
  if (state === 'failed') {
    return (
      <div role="alert" className="flex flex-col gap-1 text-sm">
        <p className="font-semibold text-destructive">
          <Trans>Your reply wasn't sent. Nothing reached {contactName}.</Trans>
        </p>
        <p>{reason === null ? t`The server gave no reason.` : i18n._(reason)}</p>
        <p className="text-muted-foreground">
          {kept ? (
            <Trans>Your words are still in the box, and the thread shows the refused reply.</Trans>
          ) : (
            <Trans>The thread shows the refused reply.</Trans>
          )}
        </p>
      </div>
    );
  }
  if (state === 'held') {
    const when = until === null ? null : times.format(new Date(until));
    return (
      <div role="status" className="flex flex-col gap-1 text-sm">
        <p className="font-semibold">
          <Trans>Your reply is waiting to send. It hasn't reached {contactName} yet.</Trans>
        </p>
        {reason === null ? null : <p>{i18n._(reason)}</p>}
        {when === null ? null : (
          <p className="text-muted-foreground">
            <Trans>It will be tried again on {when}.</Trans>
          </p>
        )}
      </div>
    );
  }
  return (
    <p role="status" className="text-sm">
      {state === 'queued' ? t`Reply queued to send.` : i18n._(deliveryWords[state])}
    </p>
  );
}
