// The Reminder settings card in Payments → Settings: emails that remind a customer about
// an invoice they haven't paid, before or after its due date or sent date.
import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createInvoiceReminder,
  deleteInvoiceReminder,
  INVOICE_REMINDER_LIMITS,
  INVOICE_REMINDER_MERGE_FIELDS,
  listInvoiceReminders,
  updateInvoiceReminder,
  type CreateInvoiceReminderInput,
  type InvoiceReminder,
  type InvoiceReminderAnchor,
  type InvoiceReminderDirection,
  type InvoiceReminderUnit,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { Switch } from './automation-switch';
import { deepRejection } from './payments-rules';
import { noRejection, type Rejection } from './problems';
import { ConfirmDialog, FormProblem, isStale, retryFaults, SmallDialog } from './settings-list';
import { useBusiness } from './workspace';

const cardClassName = 'flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-4';
const cardTitleClassName = 'text-base font-medium text-foreground';
const smallLabelClassName = 'text-xs text-muted-foreground';

export const invoiceRemindersKey = (businessId: string): readonly string[] => [
  'b',
  businessId,
  'payments',
  'invoice-reminders',
];

export function frequencyInWords(reminder: {
  readonly everyAmount: number;
  readonly everyUnit: InvoiceReminderUnit;
  readonly direction: InvoiceReminderDirection;
  readonly anchor: InvoiceReminderAnchor;
  readonly maxSends: number;
}): string {
  const unit =
    reminder.everyAmount === 1 ? reminder.everyUnit.replace(/s$/, '') : reminder.everyUnit;
  const anchor = reminder.anchor === 'due_date' ? t`the due date` : t`the sent date`;
  const amount = String(reminder.everyAmount);
  if (reminder.direction === 'before') {
    return t`${amount} ${unit} before ${anchor}`;
  }
  const count = String(reminder.maxSends);
  const times = reminder.maxSends === 1 ? t`1 time` : t`${count} times`;
  return t`Every ${amount} ${unit} after ${anchor}, up to ${times}`;
}

interface BoxedProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly children: (ids: {
    readonly id: string;
    readonly 'aria-invalid': boolean;
    readonly 'aria-describedby'?: string;
  }) => ReactNode;
}

function Boxed({ label, hint, error, children }: BoxedProps): ReactElement {
  const id = useId();
  const described = [
    hint === undefined ? '' : `${id}-hint`,
    error === undefined ? '' : `${id}-error`,
  ]
    .filter((each) => each !== '')
    .join(' ');
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className={smallLabelClassName}>
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error !== undefined,
        ...(described === '' ? {} : { 'aria-describedby': described }),
      })}
      {hint === undefined ? null : (
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      )}
      {error === undefined ? null : (
        <span id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

interface ReminderDraft {
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly everyAmount: string;
  readonly everyUnit: InvoiceReminderUnit;
  readonly direction: InvoiceReminderDirection;
  readonly anchor: InvoiceReminderAnchor;
  readonly maxSends: string;
}

const emptyReminderDraft: ReminderDraft = {
  name: '',
  subject: '',
  body: '',
  everyAmount: '3',
  everyUnit: 'days',
  direction: 'after',
  anchor: 'due_date',
  maxSends: '3',
};

function draftFromReminder(reminder: InvoiceReminder): ReminderDraft {
  return {
    name: reminder.name,
    subject: reminder.subject,
    body: reminder.body,
    everyAmount: String(reminder.everyAmount),
    everyUnit: reminder.everyUnit,
    direction: reminder.direction,
    anchor: reminder.anchor,
    maxSends: String(reminder.maxSends),
  };
}

export function ReminderSettingsCard({ canManage }: { readonly canManage: boolean }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: invoiceRemindersKey(business.id),
    queryFn: () => apiIn(business.id).request(listInvoiceReminders, {}),
    retry: retryFaults,
  });

  const [dialogTarget, setDialogTarget] = useState<
    { readonly kind: 'new' } | { readonly kind: 'edit'; readonly reminder: InvoiceReminder } | null
  >(null);
  const [deleting, setDeleting] = useState<InvoiceReminder | null>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);

  const toggle = useMutation({
    mutationFn: ({
      reminder,
      enabled,
    }: {
      readonly reminder: InvoiceReminder;
      readonly enabled: boolean;
    }) =>
      apiIn(business.id).request(updateInvoiceReminder, {
        params: { id: reminder.id },
        body: {
          enabled,
          updatedAt: reminder.updatedAt,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: invoiceRemindersKey(business.id) });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiIn(business.id).request(deleteInvoiceReminder, {
        params: { id },
      }),
    onSuccess: () => {
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: invoiceRemindersKey(business.id) });
    },
  });

  const reminders = query.data?.items ?? [];
  const deletingName = deleting?.name ?? '';

  return (
    <section aria-label={t`Reminder settings`} className={cardClassName}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className={cardTitleClassName}>
            <Trans>Reminder settings</Trans>
          </h2>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Emails that remind a customer about an invoice they haven't paid. Each applies to
              invoices sent after it's turned on.
            </Trans>
          </p>
        </div>
        {canManage ? (
          <Button
            ref={addTriggerRef}
            type="button"
            variant="secondary"
            size="small"
            onClick={() => {
              setDialogTarget({ kind: 'new' });
            }}
          >
            <Trans>Add reminder</Trans>
          </Button>
        ) : null}
      </div>

      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : reminders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No reminders yet.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-t border-border">
          {reminders.map((each) => {
            const reminderName = each.name;
            return (
              <li key={each.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-foreground wrap-anywhere">
                    {reminderName}
                  </span>
                  <span className="text-xs text-muted-foreground">{frequencyInWords(each)}</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      <Trans>On</Trans>
                    </span>
                    <Switch
                      checked={each.enabled}
                      disabled={!canManage || toggle.isPending}
                      aria-label={t`On: ${reminderName}`}
                      onChange={(checked) => {
                        toggle.mutate({ reminder: each, enabled: checked });
                      }}
                    />
                  </div>
                  {canManage ? (
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="quiet"
                        size="small"
                        aria-label={t`Edit ${reminderName}`}
                        onClick={() => {
                          setDialogTarget({ kind: 'edit', reminder: each });
                        }}
                      >
                        <Trans>Edit</Trans>
                      </Button>
                      <Button
                        type="button"
                        variant="quiet"
                        size="small"
                        aria-label={t`Delete ${reminderName}`}
                        onClick={() => {
                          setDeleting(each);
                        }}
                      >
                        <Trans>Delete</Trans>
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {dialogTarget !== null ? (
        <ReminderDialog
          open={true}
          initial={
            dialogTarget.kind === 'edit'
              ? draftFromReminder(dialogTarget.reminder)
              : emptyReminderDraft
          }
          editingId={dialogTarget.kind === 'edit' ? dialogTarget.reminder.id : undefined}
          editingUpdatedAt={
            dialogTarget.kind === 'edit' ? dialogTarget.reminder.updatedAt : undefined
          }
          returnFocus={addTriggerRef}
          onClose={() => {
            setDialogTarget(null);
          }}
          onSaved={() => {
            setDialogTarget(null);
            void queryClient.invalidateQueries({ queryKey: invoiceRemindersKey(business.id) });
          }}
          onReload={() => {
            void query.refetch();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t`Delete reminder?`}
        description={deleting === null ? '' : t`Delete "${deletingName}"? This cannot be undone.`}
        confirmLabel={t`Delete for good`}
        destructive={true}
        busy={remove.isPending}
        problem={remove.error instanceof Error ? remove.error.message : undefined}
        returnFocus={deleteTriggerRef}
        onConfirm={() => {
          if (deleting !== null) remove.mutate(deleting.id);
        }}
        onClose={() => {
          setDeleting(null);
        }}
      />
    </section>
  );
}

function ReminderDialog({
  open,
  initial,
  editingId,
  editingUpdatedAt,
  returnFocus,
  onClose,
  onSaved,
  onReload,
}: {
  readonly open: boolean;
  readonly initial: ReminderDraft;
  readonly editingId?: string | undefined;
  readonly editingUpdatedAt?: string | undefined;
  readonly returnFocus: React.RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onReload: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [draft, setDraft] = useState<ReminderDraft>(initial);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [caretPos, setCaretPos] = useState({ start: 0, end: 0 });
  const isEditing = editingId !== undefined;

  const save = useMutation({
    mutationFn: () => {
      const everyAmount = Number.parseInt(draft.everyAmount, 10);
      const maxSends = Number.parseInt(draft.maxSends, 10);
      const body: CreateInvoiceReminderInput = {
        name: draft.name,
        subject: draft.subject,
        body: draft.body,
        enabled: true,
        everyAmount: Number.isNaN(everyAmount) ? 0 : everyAmount,
        everyUnit: draft.everyUnit,
        direction: draft.direction,
        anchor: draft.anchor,
        maxSends: draft.direction === 'before' ? 1 : Number.isNaN(maxSends) ? 3 : maxSends,
      };

      if (isEditing) {
        return apiIn(business.id).request(updateInvoiceReminder, {
          params: { id: editingId },
          body: {
            ...body,
            updatedAt: editingUpdatedAt ?? '',
          },
        });
      }
      return apiIn(business.id).request(createInvoiceReminder, { body });
    },
    onSuccess: () => {
      onSaved();
    },
    onError: (error) => {
      if (isEditing && isStale(error)) {
        setProblem({
          fields: {},
          form: t`Someone changed these settings since you opened them. Reload the saved version, then make your changes again.`,
        });
        return;
      }
      if (error instanceof ApiError && error.problem.errors !== undefined) {
        setProblem(deepRejection(error.problem.errors));
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        const maxReminders = String(INVOICE_REMINDER_LIMITS.maxReminders);
        setProblem({
          fields: {},
          form:
            error.problem.detail ??
            t`A business may have at most ${maxReminders} invoice reminders.`,
        });
        return;
      }
      setProblem({
        fields: {},
        form:
          error instanceof ApiError && error.problem.detail !== undefined
            ? error.problem.detail
            : t`The reminder wasn't saved. Check your connection and try again.`,
      });
    },
  });

  const rememberCaret = (e: React.SyntheticEvent<HTMLElement>): void => {
    const el = e.currentTarget;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      setCaretPos({
        start: el.selectionStart ?? draft.body.length,
        end: el.selectionEnd ?? draft.body.length,
      });
    }
  };

  const insertMerge = (field: string): void => {
    const start = caretPos.start;
    const end = caretPos.end;
    const token = `{{${field}}}`;
    const nextBody = draft.body.slice(0, start) + token + draft.body.slice(end);
    setDraft((before) => ({ ...before, body: nextBody }));
    const newPos = start + token.length;
    setCaretPos({ start: newPos, end: newPos });
  };

  const problemOf = (path: string): string | undefined => problem.fields[path];

  return (
    <SmallDialog
      open={open}
      onClose={onClose}
      title={isEditing ? <Trans>Edit reminder</Trans> : <Trans>Add reminder</Trans>}
      returnFocus={returnFocus}
    >
      <form
        noValidate
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setProblem(noRejection);
          save.mutate();
        }}
      >
        <FormProblem
          problem={problem}
          stale={isEditing && isStale(save.error)}
          busy={save.isPending}
          onReload={() => {
            onReload();
            onClose();
          }}
        />

        <Boxed label={<Trans>Name</Trans>} error={problemOf('name')}>
          {(ids) => (
            <Input
              {...ids}
              maxLength={INVOICE_REMINDER_LIMITS.nameLength}
              autoComplete="off"
              value={draft.name}
              onChange={(e) => {
                setDraft((before) => ({ ...before, name: e.target.value }));
              }}
            />
          )}
        </Boxed>

        <Boxed label={<Trans>Email subject</Trans>} error={problemOf('subject')}>
          {(ids) => (
            <Input
              {...ids}
              maxLength={INVOICE_REMINDER_LIMITS.subjectLength}
              autoComplete="off"
              value={draft.subject}
              onChange={(e) => {
                setDraft((before) => ({ ...before, subject: e.target.value }));
              }}
            />
          )}
        </Boxed>

        <Boxed label={<Trans>Message</Trans>} error={problemOf('body')}>
          {(ids) => (
            <div className="flex flex-col gap-2">
              <Textarea
                {...ids}
                rows={4}
                maxLength={INVOICE_REMINDER_LIMITS.bodyLength}
                value={draft.body}
                onChange={(e) => {
                  setDraft((before) => ({ ...before, body: e.target.value }));
                  rememberCaret(e);
                }}
                onSelect={rememberCaret}
                onFocus={rememberCaret}
                onBlur={rememberCaret}
              />
              <div
                role="group"
                aria-label={t`Insert a merge field`}
                className="flex flex-col gap-1.5"
              >
                <span className="text-xs text-muted-foreground">
                  <Trans>Insert a merge field</Trans>
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {INVOICE_REMINDER_MERGE_FIELDS.map((field) => (
                    <Button
                      key={field}
                      type="button"
                      variant="secondary"
                      size="small"
                      aria-label={t`Insert ${field}`}
                      onClick={() => {
                        insertMerge(field);
                      }}
                    >
                      {field}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Boxed>

        <fieldset className="flex min-w-0 flex-col gap-3 rounded-card border border-border p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">
            <Trans>Frequency</Trans>
          </legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Boxed label={<Trans>Every</Trans>} error={problemOf('everyAmount')}>
              {(ids) => (
                <Input
                  {...ids}
                  type="number"
                  min={1}
                  max={INVOICE_REMINDER_LIMITS.maxAmount}
                  inputMode="numeric"
                  value={draft.everyAmount}
                  onChange={(e) => {
                    setDraft((before) => ({ ...before, everyAmount: e.target.value }));
                  }}
                />
              )}
            </Boxed>

            <Boxed label={<Trans>Unit</Trans>} error={problemOf('everyUnit')}>
              {(ids) => (
                <Select
                  {...ids}
                  aria-label={t`Unit`}
                  value={draft.everyUnit}
                  onValueChange={(val) => {
                    setDraft((before) => ({ ...before, everyUnit: val as InvoiceReminderUnit }));
                  }}
                >
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                  <option value="months">months</option>
                </Select>
              )}
            </Boxed>

            <Boxed label={<Trans>Direction</Trans>} error={problemOf('direction')}>
              {(ids) => (
                <Select
                  {...ids}
                  aria-label={t`Direction`}
                  value={draft.direction}
                  onValueChange={(val) => {
                    const direction = val as InvoiceReminderDirection;
                    setDraft((before) => ({
                      ...before,
                      direction,
                      anchor: direction === 'before' ? 'due_date' : before.anchor,
                    }));
                  }}
                >
                  <option value="after">after</option>
                  <option value="before">before</option>
                </Select>
              )}
            </Boxed>

            <Boxed
              label={<Trans>Anchor date</Trans>}
              hint={
                draft.direction === 'before' ? (
                  <Trans>A reminder before its date can only be before the due date.</Trans>
                ) : undefined
              }
              error={problemOf('anchor')}
            >
              {(ids) => (
                <Select
                  {...ids}
                  aria-label={t`Anchor date`}
                  value={draft.anchor}
                  onValueChange={(val) => {
                    setDraft((before) => ({ ...before, anchor: val as InvoiceReminderAnchor }));
                  }}
                >
                  <option value="due_date">the due date</option>
                  <option value="sent_date" disabled={draft.direction === 'before'}>
                    the sent date
                  </option>
                </Select>
              )}
            </Boxed>
          </div>

          {draft.direction === 'after' ? (
            <div className="w-36">
              <Boxed
                label={<Trans>Up to</Trans>}
                hint={<Trans>reminders</Trans>}
                error={problemOf('maxSends')}
              >
                {(ids) => (
                  <Input
                    {...ids}
                    type="number"
                    min={1}
                    max={INVOICE_REMINDER_LIMITS.maxSends}
                    inputMode="numeric"
                    value={draft.maxSends}
                    onChange={(e) => {
                      setDraft((before) => ({ ...before, maxSends: e.target.value }));
                    }}
                  />
                )}
              </Boxed>
            </div>
          ) : null}
        </fieldset>

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={save.isPending}>
            <Trans>Save reminder</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
