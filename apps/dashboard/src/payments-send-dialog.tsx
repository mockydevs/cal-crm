// Emails a quote, an invoice or a receipt to its contact, from the dialog the Send button
// opens. It goes to one of the contact's own addresses, from a mailbox of the business that
// sends conversations, with the link to the document and, unless unticked, its PDF. A draft
// is issued in the same step, once the person says so. What the server refuses is said
// under the box it is about, with what to do next.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getContact,
  getMailboxSendingSettings,
  listMailboxes,
  sendReceipt,
  sendSalesDocument,
  type Receipt,
  type SalesDocument,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { apiIn } from './api';
import { useProfile } from './payments-parts';
import {
  defaultSubject,
  noSendRefusal,
  sendAddresses,
  sendRefusal,
  sendValues,
  type SendDraft,
  type SendField,
  type SendRefusal,
  type SendRefusalCode,
} from './payments-rules';
import { retryFaults, SmallDialog } from './settings-list';
import { useBusiness } from './workspace';

export type SendTarget =
  | {
      readonly kind: 'document';
      readonly document: SalesDocument;
      /** The number a draft with none yet gets when it is issued. */
      readonly nextNumber: string;
    }
  | { readonly kind: 'receipt'; readonly receipt: Receipt };

export interface Sent {
  /** The address it went to. */
  readonly to: string;
  /** True when it is held for now, by quiet hours or the mailbox's limits. */
  readonly deferred: boolean;
  /** The document as it is now, when a document was sent. */
  readonly document?: SalesDocument;
  /** The receipt as it is now, when a receipt was sent. */
  readonly receipt?: Receipt;
}

const linkClassName = 'font-medium text-link underline underline-offset-2';
const labelClassName = 'flex min-w-0 flex-col gap-1.5 text-sm font-medium';
const hintClassName = 'text-sm leading-normal font-normal text-muted-foreground';

/** What each refusal of the server means for the person sending, and what to do next. */
function useRefusalWords(): Readonly<Record<SendRefusalCode, string>> {
  const { t } = useLingui();
  return {
    no_address: t`This contact has no email address. Add one on the contact page first.`,
    not_contacts_address: t`This is not one of the contact's own email addresses. Add it on the contact page first.`,
    contact_inactive: t`This contact is in the trash. Restore the contact first.`,
    do_not_contact: t`This contact is marked do not contact, or has do not disturb on for email. Change that on the contact page before sending.`,
    suppressed: t`This address is on the suppression list, so nothing is sent to it. Choose another of the contact's addresses.`,
    consent_withdrawn: t`This contact withdrew their consent to email. Nothing is sent until they agree again and it is recorded on the contact page.`,
    consent_required: t`This contact has not agreed to be emailed about their orders. Record their consent on the contact page first.`,
    timing_unknown: t`Quiet hours are on and this contact has no time zone to keep them in. Set the contact's time zone on the contact page first.`,
    no_mailbox: t`There is no mailbox to send from. Connect one that sends conversations in Settings → Email Services, or choose another.`,
    sender_inactive: t`This mailbox, or the business, is not active. Choose another mailbox, or check it in Settings → Email Services.`,
  };
}

/** What is wrong with a box, under it, with the way to where it is put right. */
function BoxProblem({
  id,
  children,
  link,
}: {
  readonly id: string;
  readonly children: ReactNode;
  readonly link?: ReactNode;
}): ReactElement {
  return (
    <p id={id} role="alert" className="text-sm leading-normal font-medium text-destructive">
      {children}
      {link === undefined ? null : <> {link}</>}
    </p>
  );
}

export default function SendDialog({
  target,
  returnFocus,
  onClose,
  onSent,
  onConflict,
}: {
  readonly target: SendTarget;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSent: (sent: Sent) => void;
  /** The server said the document is not as this dialog read it: the page reads it again. */
  readonly onConflict: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const id = useId();
  const words = useRefusalWords();
  const profile = useProfile();

  const receipt = target.kind === 'receipt' ? target.receipt : undefined;
  const document = target.kind === 'document' ? target.document : undefined;
  const what = receipt === undefined ? (document?.kind ?? 'invoice') : 'receipt';
  const draft = document?.status === 'draft';
  const contactId = receipt === undefined ? (document?.contactId ?? null) : receipt.contactId;
  const customerEmail = (receipt ?? document)?.customer.email ?? null;
  const number =
    receipt?.number ?? document?.number ?? (target.kind === 'document' ? target.nextNumber : '');
  // An issued document and a receipt carry who they are from; a draft is from the business as
  // it is when it is issued.
  const seller = receipt?.seller.name ?? document?.seller?.name ?? profile.data?.name;

  const contact = useQuery({
    queryKey: ['b', business.id, 'payments', 'send-contact', contactId],
    queryFn: () => api.request(getContact, { params: { id: contactId ?? '' } }),
    enabled: contactId !== null,
    retry: retryFaults,
  });
  // The mailboxes that send conversations: reading them needs permission to manage
  // mailboxes, so someone without it sends from the business's default.
  const senders = useQuery({
    queryKey: ['b', business.id, 'payments', 'send-mailboxes'],
    queryFn: async () => {
      const { data } = await api.request(listMailboxes, {});
      const active = data.filter((each) => each.status === 'active');
      const settings = await Promise.all(
        active.map((each) => api.request(getMailboxSendingSettings, { params: { id: each.id } })),
      );
      return active.filter((_, index) => settings[index]?.useForConversations === true);
    },
    staleTime: 60_000,
    retry: retryFaults,
  });

  const addresses = sendAddresses(contact.data?.emails ?? [], customerEmail);
  const [to, setTo] = useState<string>();
  const [mailboxId, setMailboxId] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [attachPdf, setAttachPdf] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [refusal, setRefusal] = useState<SendRefusal>(noSendRefusal);
  // One key for each attempt at sending a receipt: the same again after a failure, so a
  // send the server did take is not made twice; a new one once anything is changed.
  const keyRef = useRef<string | undefined>(undefined);
  const chosenTo = to ?? addresses.chosen;
  const values: SendDraft = { to: chosenTo, mailboxId, subject, message, attachPdf };

  /** Something was changed: what was wrong with it no longer stands, and this is a new attempt. */
  const changed = (field: SendField | undefined): void => {
    keyRef.current = undefined;
    setRefusal((before) => ({
      fields: Object.fromEntries(Object.entries(before.fields).filter(([name]) => name !== field)),
      form: undefined,
      conflict: false,
    }));
  };

  const send = useMutation({
    mutationFn: async (): Promise<Sent> => {
      const body = sendValues(values);
      if (receipt !== undefined) {
        keyRef.current ??= crypto.randomUUID();
        const sent = await api.request(sendReceipt, {
          params: { id: receipt.id },
          body: { ...body, idempotencyKey: keyRef.current },
        });
        return {
          to: sent.message.to,
          deferred: sent.message.status === 'deferred',
          receipt: sent.receipt,
        };
      }
      if (document === undefined) throw new Error('Nothing to send.');
      const sent = await api.request(sendSalesDocument, {
        params: { id: document.id },
        body: { ...body, issueIfDraft: draft && confirmed, revision: document.revision },
      });
      return {
        to: sent.message.to,
        deferred: sent.message.status === 'deferred',
        document: sent.document,
      };
    },
    onSuccess: onSent,
    onError: (error) => {
      const fallback = t`It wasn't sent. Check your connection and try again.`;
      const next = sendRefusal(error instanceof ApiError ? error.problem : undefined, fallback);
      setRefusal(next);
      if (next.conflict) onConflict();
    },
  });

  const busy = send.isPending;
  const invoice = what === 'invoice';
  const title =
    what === 'receipt' ? (
      <Trans>Send receipt {number}</Trans>
    ) : draft ? (
      invoice ? (
        <Trans>Issue and send this invoice</Trans>
      ) : (
        <Trans>Issue and send this quote</Trans>
      )
    ) : invoice ? (
      <Trans>Send invoice {number}</Trans>
    ) : (
      <Trans>Send quote {number}</Trans>
    );
  const usual = seller === undefined ? undefined : defaultSubject(what, number, seller);
  const contactLink =
    contactId === null ? undefined : (
      <Link
        to="/b/$slug/contacts/$contactId"
        params={{ slug: business.slug, contactId }}
        className={linkClassName}
      >
        <Trans>Open the contact</Trans>
      </Link>
    );
  const settingsLink = (
    <Link to="/b/$slug/settings/email" params={{ slug: business.slug }} className={linkClassName}>
      <Trans>Open Email Services</Trans>
    </Link>
  );
  const problemOf = (field: SendField): string | undefined => {
    const found = refusal.fields[field];
    return found === undefined
      ? undefined
      : found.code === undefined
        ? found.message
        : words[found.code];
  };
  const noAddress = contact.data !== undefined && addresses.options.length === 0;
  const toProblem = problemOf('to') ?? (noAddress ? words.no_address : undefined);
  const fromProblem = problemOf('mailboxId');
  const subjectProblem = problemOf('subject');
  const messageProblem = problemOf('message');
  const ready =
    !busy && contact.data !== undefined && chosenTo !== '' && (!draft || confirmed) && !noAddress;

  return (
    <SmallDialog
      open
      title={title}
      description={
        <Trans>
          It is emailed to the contact, and kept in their conversation like any other email.
        </Trans>
      }
      returnFocus={returnFocus}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        noValidate
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setRefusal(noSendRefusal);
          send.mutate();
        }}
      >
        <div className={labelClassName}>
          <span id={`${id}-to-label`}>
            <Trans>To</Trans>
          </span>
          {contact.isError ? (
            <BoxProblem id={`${id}-to-problem`}>
              <Trans>The contact's email addresses couldn't be loaded.</Trans>{' '}
              <button
                type="button"
                className={linkClassName}
                onClick={() => {
                  void contact.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </button>
            </BoxProblem>
          ) : noAddress ? null : (
            <Select
              aria-labelledby={`${id}-to-label`}
              aria-invalid={toProblem !== undefined}
              {...(toProblem === undefined ? {} : { 'aria-describedby': `${id}-to-problem` })}
              disabled={busy || contact.data === undefined}
              value={chosenTo}
              onValueChange={(next) => {
                setTo(next);
                changed('to');
              }}
            >
              {contact.data === undefined ? <option value="">{t`Loading…`}</option> : null}
              {addresses.options.map((each) => (
                <option key={each} value={each}>
                  {each}
                </option>
              ))}
            </Select>
          )}
          {toProblem === undefined ? (
            contact.isError || noAddress ? null : (
              <span className={hintClassName}>
                <Trans>One of the contact's own email addresses.</Trans>
              </span>
            )
          ) : (
            <BoxProblem id={`${id}-to-problem`} link={contactLink}>
              {toProblem}
            </BoxProblem>
          )}
        </div>

        <div className={labelClassName}>
          <span id={`${id}-from-label`}>
            <Trans>From</Trans>
          </span>
          <Select
            aria-labelledby={`${id}-from-label`}
            aria-invalid={fromProblem !== undefined}
            aria-describedby={`${id}-from-note`}
            disabled={busy}
            value={mailboxId}
            onValueChange={(next) => {
              setMailboxId(next);
              changed('mailboxId');
            }}
          >
            <option value="">{t`The business's default mailbox`}</option>
            {(senders.data ?? []).map((each) => (
              <option key={each.id} value={each.id}>
                {`${each.name} · ${each.email}`}
              </option>
            ))}
          </Select>
          {fromProblem === undefined ? (
            <span id={`${id}-from-note`} className={hintClassName}>
              {senders.data?.length === 0 ? (
                <>
                  <Trans>No active mailbox sends conversations yet.</Trans> {settingsLink}
                </>
              ) : (
                <Trans>The default is the first mailbox that sends conversations.</Trans>
              )}
            </span>
          ) : (
            <BoxProblem id={`${id}-from-note`} link={settingsLink}>
              {fromProblem}
            </BoxProblem>
          )}
        </div>

        <div className={labelClassName}>
          <label htmlFor={`${id}-subject`}>
            <Trans>Subject</Trans>
          </label>
          <Input
            id={`${id}-subject`}
            maxLength={200}
            autoComplete="off"
            disabled={busy}
            placeholder={usual}
            aria-invalid={subjectProblem !== undefined}
            aria-describedby={`${id}-subject-note`}
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
              changed('subject');
            }}
          />
          {subjectProblem === undefined ? (
            <span id={`${id}-subject-note`} className={hintClassName}>
              {usual === undefined || (draft && document.number === null) ? (
                <Trans>
                  Leave it empty and the subject names what is sent, its number and your business.
                </Trans>
              ) : (
                <Trans>Leave it empty to use “{usual}”.</Trans>
              )}
            </span>
          ) : (
            <BoxProblem id={`${id}-subject-note`}>{subjectProblem}</BoxProblem>
          )}
        </div>

        <div className={labelClassName}>
          <label htmlFor={`${id}-message`}>
            <Trans>Message (optional)</Trans>
          </label>
          <Textarea
            id={`${id}-message`}
            rows={4}
            maxLength={5000}
            disabled={busy}
            aria-invalid={messageProblem !== undefined}
            aria-describedby={`${id}-message-note`}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              changed('message');
            }}
          />
          {messageProblem === undefined ? (
            <span id={`${id}-message-note`} className={hintClassName}>
              <Trans>
                Plain text. The greeting, the link to open it online and your business name are
                added around it.
              </Trans>
            </span>
          ) : (
            <BoxProblem id={`${id}-message-note`}>{messageProblem}</BoxProblem>
          )}
        </div>

        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm lg:min-h-0">
          <input
            type="checkbox"
            className="size-4 shrink-0"
            checked={attachPdf}
            disabled={busy}
            onChange={(event) => {
              setAttachPdf(event.target.checked);
              changed(undefined);
            }}
          />
          <Trans>Attach the PDF</Trans>
        </label>

        {draft ? (
          <label className="flex cursor-pointer items-start gap-3 rounded-control border border-border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => {
                setConfirmed(event.target.checked);
              }}
            />
            <span>
              {document.number === null ? (
                <Trans>
                  Issue this draft as {number} and send it. After that it can no longer be edited
                  freely: to change it you revise it, and it keeps its number.
                </Trans>
              ) : (
                <Trans>
                  Issue this draft again as {number} and send it. After that it can no longer be
                  edited freely: to change it you revise it.
                </Trans>
              )}
            </span>
          </label>
        ) : null}

        {refusal.form === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {refusal.form}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={!ready}>
            {busy ? (
              <Trans>Sending…</Trans>
            ) : draft ? (
              <Trans>Issue and send</Trans>
            ) : (
              <Trans>Send</Trans>
            )}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
