import { Trans, useLingui } from '@lingui/react/macro';
import {
  getContactConsent,
  recordConsentInput,
  recordContactConsent,
  type ConsentChange,
  type ConsentState,
  type ContactConsent,
  type ContactSuppression,
  type RecordConsentInput,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { useActorLabel } from './activity';
import { apiIn } from './api';
import { ContactPanel } from './contact-panels';
import {
  needsConfirmation,
  offeredChange,
  shownStates,
  verdictOf,
  type Verdict,
} from './consent-summary';
import { issuesOf, noRejection, rejection } from './problems';
import { useBusiness } from './workspace';

type Kind = Pick<ConsentState, 'channel' | 'purpose'>;
const keyOf = (kind: Kind): string => `${kind.channel}:${kind.purpose}`;

/** What a channel and purpose are called, such as "marketing email". */
function useKindLabel(): (kind: Kind) => string {
  const { t } = useLingui();
  const labels: Readonly<Record<string, string>> = {
    'email:marketing': t`Marketing email`,
    'email:transactional': t`Service email`,
    'sms:marketing': t`Marketing texts`,
    'sms:transactional': t`Service texts`,
    'whatsapp:marketing': t`Marketing WhatsApp messages`,
    'whatsapp:transactional': t`Service WhatsApp messages`,
    'call:marketing': t`Marketing calls`,
    'call:transactional': t`Service calls`,
  };
  return (kind) => labels[keyOf(kind)] ?? keyOf(kind);
}

function useSourceLabel(): (source: ConsentChange['source']) => string {
  const { t } = useLingui();
  const labels = {
    form: t`A form`,
    keyword: t`A keyword they sent`,
    unsubscribe_link: t`The unsubscribe link`,
    booking: t`The booking page`,
    import: t`An import`,
    api: t`An app`,
    user: t`A team member`,
  } satisfies Record<ConsentChange['source'], string>;
  return (source) => labels[source];
}

function useVerdictLabel(): (verdict: Verdict) => string {
  const { t } = useLingui();
  const labels = {
    allowed: t`These can be sent.`,
    no_consent: t`These aren't sent until consent is recorded.`,
    withdrawn: t`These aren't sent.`,
    do_not_contact: t`These aren't sent: do not contact is on.`,
    suppressed: t`These aren't sent: the address can't be sent to.`,
  } satisfies Record<Verdict, string>;
  return (verdict) => labels[verdict];
}

function useSuppressionLabel(): (suppression: ContactSuppression) => string {
  const { t } = useLingui();
  return ({ address, reason }) => {
    switch (reason) {
      case 'hard_bounce':
        return t`${address} can't be sent to: a message to it bounced.`;
      case 'complaint':
        return t`${address} can't be sent to: a message to it was reported as spam.`;
      case 'unsubscribe':
        return t`${address} can't be sent to: it was unsubscribed.`;
      case 'invalid':
        return t`${address} can't be sent to: it isn't a working address.`;
      case 'manual':
        return t`${address} can't be sent to: it was blocked.`;
    }
  };
}

/**
 * A contact's consent in plain words: what may be sent, what stops it, and every change
 * with its proof. People who may change contacts can record that consent was given or
 * withdrawn, always with a note of how they know.
 */
export function ConsentPanel({
  contactId,
  readOnly = false,
}: {
  readonly contactId: string;
  readonly readOnly?: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const consent = useQuery({
    queryKey: ['b', business.id, 'consent', contactId],
    queryFn: () => apiIn(business.id).request(getContactConsent, { params: { id: contactId } }),
  });
  return (
    <ContactPanel title={t`Consent`}>
      {consent.isPending ? (
        <p aria-live="polite">
          <Trans>Loading consent…</Trans>
        </p>
      ) : null}
      {consent.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>
            <Trans>The consent couldn't be loaded.</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void consent.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {consent.data === undefined ? null : (
        <ConsentDetails contactId={contactId} consent={consent.data} readOnly={readOnly} />
      )}
    </ContactPanel>
  );
}

function ConsentDetails({
  contactId,
  consent,
  readOnly,
}: {
  readonly contactId: string;
  readonly consent: ContactConsent;
  readonly readOnly: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const kindLabel = useKindLabel();
  const sourceLabel = useSourceLabel();
  const verdictLabel = useVerdictLabel();
  const suppressionLabel = useSuppressionLabel();
  const [editing, setEditing] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // The button of the row just changed, so the keyboard stays where it was.
  const focusNextRef = useRef<string>(undefined);
  const canManage = consent.canManage && !readOnly;
  const focusIf = (key: string) => (element: HTMLElement | null) => {
    if (element !== null && focusNextRef.current === key) {
      focusNextRef.current = undefined;
      element.focus();
    }
  };
  return (
    <>
      {consent.doNotContact ? (
        <p className="rounded-card bg-secondary p-3 text-sm text-secondary-foreground">
          <Trans>
            Do not contact is on. No messages are sent to this contact, whatever consent is recorded
            below.
          </Trans>
        </p>
      ) : null}
      {consent.suppressions.length === 0 ? null : (
        <ul className="flex flex-col gap-2 rounded-card bg-secondary p-3 text-sm text-secondary-foreground">
          {consent.suppressions.map((suppression) => (
            <li key={`${suppression.channel}:${suppression.address}`} className="break-words">
              {suppressionLabel(suppression)}
            </li>
          ))}
        </ul>
      )}
      {consent.timeZone === null ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          <Trans>This contact has no time zone. Quiet hours follow the business's time zone.</Trans>
        </p>
      ) : null}
      <ul className="flex min-w-0 flex-col gap-5">
        {shownStates(consent.current).map((state) => {
          const key = keyOf(state);
          const label = kindLabel(state);
          const change = offeredChange(state);
          return (
            <li key={key} className="flex min-w-0 flex-col items-start gap-2">
              <h3 className="text-md font-semibold">{label}</h3>
              <Badge variant={state.status === 'granted' ? 'assistant' : 'neutral'}>
                {state.status === 'granted' ? (
                  <Trans>Consent given</Trans>
                ) : state.status === 'withdrawn' ? (
                  <Trans>Consent withdrawn</Trans>
                ) : (
                  <Trans>No consent recorded</Trans>
                )}
              </Badge>
              <p className="text-sm text-muted-foreground">
                {verdictLabel(verdictOf(consent, state))}
              </p>
              {state.recordedAt === null || state.source === null ? null : (
                <p className="text-sm text-muted-foreground break-words">
                  <Trans>Last changed</Trans>{' '}
                  <time dateTime={state.recordedAt}>
                    {dates.format(new Date(state.recordedAt))}
                  </time>
                  {' · '}
                  {sourceLabel(state.source)}
                </p>
              )}
              {!canManage ? null : editing === key ? (
                <ChangeForm
                  contactId={contactId}
                  state={state}
                  label={label}
                  change={change}
                  close={(saved) => {
                    focusNextRef.current = key;
                    setEditing(undefined);
                    if (saved)
                      setNotice(
                        change === 'granted'
                          ? t`Consent recorded for ${label}.`
                          : t`Withdrawal recorded for ${label}.`,
                      );
                  }}
                />
              ) : (
                <Button
                  ref={focusIf(key)}
                  variant="secondary"
                  size="small"
                  aria-label={
                    change === 'granted'
                      ? t`Record consent for ${label}`
                      : t`Withdraw consent for ${label}`
                  }
                  onClick={() => {
                    setNotice(undefined);
                    setEditing(key);
                  }}
                >
                  {change === 'granted' ? (
                    <Trans>Record consent</Trans>
                  ) : (
                    <Trans>Withdraw consent</Trans>
                  )}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-sm leading-relaxed text-muted-foreground">
        <Trans>
          Service messages are about something the contact asked for, such as a booking
          confirmation.
        </Trans>
      </p>
      <p role="status" className="text-sm empty:sr-only">
        {notice}
      </p>
      <History consent={consent} />
    </>
  );
}

function ChangeForm({
  contactId,
  state,
  label,
  change,
  close,
}: {
  readonly contactId: string;
  readonly state: ConsentState;
  readonly label: string;
  readonly change: 'granted' | 'withdrawn';
  readonly close: (saved: boolean) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const business = useBusiness();
  const cache = useQueryClient();
  const confirmId = useId();
  const noteRef = useRef<HTMLInputElement>(null);
  // The form opens in place of the button that was pressed, so the keyboard moves into it.
  useEffect(() => {
    noteRef.current?.focus();
  }, []);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState(noRejection);
  const confirmation = needsConfirmation(state, change);
  const withdrawnOn = state.recordedAt === null ? '' : dates.format(new Date(state.recordedAt));
  const save = useMutation({
    mutationFn: (body: RecordConsentInput) =>
      apiIn(business.id).request(recordContactConsent, { params: { id: contactId }, body }),
    onSuccess: async (saved) => {
      cache.setQueryData(['b', business.id, 'consent', contactId], saved);
      close(true);
      await cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', contactId] });
    },
    onError: (error) => {
      const issues = error instanceof ApiError ? (error.problem.errors ?? []) : [];
      setProblem(
        issues.length > 0
          ? rejection(issues)
          : {
              fields: {},
              form:
                error instanceof ApiError
                  ? error.message
                  : t`The change wasn't saved. Check your connection and try again.`,
            },
      );
    },
  });
  // The server's refusal to undo a withdrawal names the confirmation, which has no field.
  const formProblem = problem.form ?? problem.fields['replacesWithdrawal'];
  return (
    <Form<Record<string, unknown>>
      className="w-full min-w-0"
      errors={problem.fields}
      onFormSubmit={() => {
        if (confirmation && !confirmed) {
          setProblem({
            fields: {},
            form: t`Confirm that the contact asked to get these messages again.`,
          });
          return;
        }
        const parsed = recordConsentInput.safeParse({
          channel: state.channel,
          purpose: state.purpose,
          status: change,
          note,
          replacesWithdrawal: confirmation,
        });
        if (!parsed.success) {
          setProblem(rejection(issuesOf(parsed.error)));
          return;
        }
        setProblem(noRejection);
        save.mutate(parsed.data);
      }}
    >
      <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-sm font-semibold">
          {change === 'granted' ? t`Record consent for ${label}` : t`Withdraw consent for ${label}`}
        </legend>
        <Field name="note">
          <FieldLabel>
            <Trans>How do you know?</Trans>
          </FieldLabel>
          <Textarea
            rows={3}
            ref={noteRef}
            // Not the browser's own "required": the message under the field says what to write.
            aria-required="true"
            value={note}
            onValueChange={(value) => {
              setNote(value);
            }}
          />
          <FieldDescription>
            <Trans>
              This is kept as proof with the change. For example: asked by phone on 9 October.
            </Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        {confirmation ? (
          <label htmlFor={confirmId} className="flex items-start gap-2 text-sm leading-relaxed">
            <input
              id={confirmId}
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
              }}
            />
            <span>
              {withdrawnOn === ''
                ? t`This contact withdrew consent. I confirm they asked to get these messages again.`
                : t`This contact withdrew consent on ${withdrawnOn}. I confirm they asked to get these messages again.`}
            </span>
          </label>
        ) : null}
        {formProblem === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {formProblem}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="small">
            {save.isPending ? t`Saving…` : t`Save`}
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="small"
            onClick={() => {
              close(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </fieldset>
    </Form>
  );
}

function History({ consent }: { readonly consent: ContactConsent }): ReactElement {
  const { t, i18n } = useLingui();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const kindLabel = useKindLabel();
  const sourceLabel = useSourceLabel();
  const actorLabel = useActorLabel();
  const count = consent.history.length;
  if (count === 0)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>No consent changes have been recorded for this contact.</Trans>
      </p>
    );
  const linked = {
    message: t`Kept with the message it came from.`,
    appointment: t`Kept with the booking it came from.`,
    form: t`Kept with the form it came from.`,
  } satisfies Record<NonNullable<ConsentChange['proof']['linked']>, string>;
  // The ledger only grows, newest first, so a row's place from the end names it for good.
  const entries = consent.history.map((entry, index) => ({ entry, place: count - index }));
  return (
    <details className="min-w-0 text-sm">
      <summary className="flex min-h-10 cursor-pointer items-center font-medium">
        {t`History and proof (${count})`}
      </summary>
      <ol className="mt-2 flex min-w-0 flex-col gap-4">
        {entries.map(({ entry, place }) => {
          const label = kindLabel(entry);
          const who = actorLabel(entry.recordedBy);
          return (
            <li key={place} className="flex min-w-0 flex-col gap-1 break-words">
              <p className="font-medium">
                {entry.status === 'granted'
                  ? t`Consent given for ${label}`
                  : t`Consent withdrawn for ${label}`}
              </p>
              <p className="text-muted-foreground">
                <time dateTime={entry.recordedAt}>{dates.format(new Date(entry.recordedAt))}</time>
                {' · '}
                {t`Recorded by ${who}`}
                {' · '}
                {sourceLabel(entry.source)}
              </p>
              <dl className="flex min-w-0 flex-col gap-1">
                {entry.proof.note === null ? null : (
                  <ProofLine term={t`Note`} detail={entry.proof.note} />
                )}
                {entry.proof.wording === null ? null : (
                  <ProofLine term={t`What they agreed to`} detail={entry.proof.wording} />
                )}
                {entry.proof.keyword === null ? null : (
                  <ProofLine term={t`Keyword`} detail={entry.proof.keyword} />
                )}
                {entry.proof.pageUrl === null ? null : (
                  <ProofLine term={t`Page`} detail={entry.proof.pageUrl} />
                )}
                {entry.proof.ipAddress === null ? null : (
                  <ProofLine term={t`IP address`} detail={entry.proof.ipAddress} />
                )}
              </dl>
              {entry.proof.linked === null ? null : (
                <p className="text-muted-foreground">{linked[entry.proof.linked]}</p>
              )}
            </li>
          );
        })}
      </ol>
      {consent.historyTruncated ? (
        <p className="mt-3 text-muted-foreground">
          <Trans>Only the newest changes are shown.</Trans>
        </p>
      ) : null}
    </details>
  );
}

function ProofLine({
  term,
  detail,
}: {
  readonly term: string;
  readonly detail: string;
}): ReactElement {
  return (
    <div className="min-w-0">
      <dt className="inline text-muted-foreground">{term}: </dt>
      <dd className="inline whitespace-pre-wrap break-all">{detail}</dd>
    </div>
  );
}
