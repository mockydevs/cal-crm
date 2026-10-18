// What every dialog of the contact list's bulk actions shares: how many contacts it is for,
// when it runs (now, from a later time, or in timed batches, as GoHighLevel offers it), its
// name in Bulk Actions, and the button that starts it, with what is still missing beside it
// while it can't. Each action's own dialog holds only its own fields, and is fetched by
// itself when its button is first pressed, so the contact list downloads none of them.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  bulkUpdateContacts,
  type BulkContactsInput,
  type ContactBulkAction,
  type ContactBulkDelivery,
  type ContactBulkSelection,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type ReactNode, type RefObject } from 'react';

import { apiIn } from '../api';
import {
  deliveryDefaults,
  deliveryOf,
  dripMinutes,
  type DeliveryForm,
  type DeliveryMode,
  type DeliveryProblem,
  type IntervalUnit,
} from '../contact-bulk-dialog-rules';
import { SmallDialog } from '../settings-list';

export const radioClassName = 'flex min-h-11 cursor-pointer items-center gap-3 text-md lg:min-h-9';
export const checkClassName = 'flex min-h-11 items-center gap-3 text-md lg:min-h-9';
export const labelClassName = 'flex flex-col gap-1.5 text-sm font-medium';

/** What the bar hands each dialog. */
export interface BulkDialogProps {
  readonly businessId: string;
  readonly selection: ContactBulkSelection;
  /** How many contacts the selection holds, as the list counted them. */
  readonly count: number;
  /** The list holds more than it counted: the action counts them when it starts. */
  readonly more: boolean;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onDone: (action: ContactBulkAction) => void;
}

/** What every request of a bulk action carries, whatever it does. */
export interface CommonBody {
  readonly selection: ContactBulkSelection;
  readonly requestId: string;
  readonly name?: string;
  readonly delivery?: ContactBulkDelivery;
}

/** What starting the action is called on its button. */
export type ConfirmKind = 'apply' | 'send' | 'export' | 'delete' | 'verify';

export function BulkDialogShell({
  businessId,
  selection,
  count,
  more,
  returnFocus,
  onClose,
  onDone,
  title,
  description,
  timing,
  missing,
  confirm,
  bodyOf,
  children,
}: BulkDialogProps & {
  readonly title: string;
  /** What the action does, said after how many contacts it is for. */
  readonly description: string;
  /** Whether it can run later or in drip mode. */
  readonly timing: boolean;
  /** What is still missing before it can start; undefined, nothing. */
  readonly missing: string | undefined;
  readonly confirm: ConfirmKind;
  readonly bodyOf: (common: CommonBody) => BulkContactsInput;
  readonly children: (pending: boolean) => ReactNode;
}): ReactElement {
  const { t, i18n } = useLingui();
  const formId = useId();
  const missingId = useId();
  const api = apiIn(businessId);
  // One request, however often it is sent: a retry answers the action the first one began.
  const [requestId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string>();
  const [delivery, setDelivery] = useState<DeliveryForm>(deliveryDefaults);
  // A delivery that needs putting right is said once the person has left its fields, or
  // tried to start the action: not while they are still filling it in.
  const [attempted, setAttempted] = useState(false);
  const when = timing ? deliveryOf(delivery) : { delivery: undefined };
  const deliveryProblem = 'problem' in when ? when.problem : undefined;
  const chosenDelivery = 'problem' in when ? undefined : when.delivery;
  const problems: Readonly<Record<DeliveryProblem, string>> = {
    start_required: t`Choose when to start.`,
    start_invalid: t`Enter a date and time.`,
    batch: t`Reach between 1 and 10,000 contacts a batch.`,
    interval: t`Wait between a minute and 30 days between batches.`,
  };
  const stillMissing =
    missing ?? (deliveryProblem === undefined ? undefined : problems[deliveryProblem]);
  const run = useMutation({
    mutationFn: () =>
      api.request(bulkUpdateContacts, {
        body: bodyOf({
          selection,
          requestId,
          ...(name.trim() === '' ? {} : { name: name.trim() }),
          ...(chosenDelivery === undefined ? {} : { delivery: chosenDelivery }),
        }),
      }),
    onMutate: () => {
      setProblem(undefined);
    },
    onSuccess: onDone,
    onError: (error) => {
      setProblem(
        error instanceof ApiError && error.status === 403
          ? t`You don't have permission to do this to contacts.`
          : error instanceof ApiError
            ? (error.problem.errors?.find((issue) => issue.message.trim() !== '')?.message ??
              error.problem.detail ??
              t`The bulk action wasn't started.`)
            : t`The bulk action wasn't started. Check your connection and try again.`,
      );
    },
  });
  const pending = run.isPending;
  const selected = more
    ? t`More than ${count} contacts are selected: the action counts them when it starts.`
    : plural(count, { one: '# contact is selected.', other: '# contacts are selected.' });
  const contacts = more
    ? t`all contacts`
    : plural(count, { one: '# contact', other: '# contacts' });
  const confirmWords: Readonly<Record<ConfirmKind, string>> = {
    apply: t`Apply to ${contacts}`,
    send: t`Send to ${contacts}`,
    export: t`Export ${contacts}`,
    delete: t`Delete ${contacts}`,
    verify: t`Verify ${contacts}`,
  };
  const destructive = confirm === 'delete';
  return (
    <SmallDialog
      open
      onClose={() => {
        if (!pending) onClose();
      }}
      title={title}
      description={`${selected} ${description}`}
      returnFocus={returnFocus}
    >
      <form
        id={formId}
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if (stillMissing === undefined && !pending) run.mutate();
        }}
      >
        {children(pending)}
        {timing ? (
          <DeliveryFields
            value={delivery}
            count={count}
            problem={
              attempted && deliveryProblem !== undefined ? problems[deliveryProblem] : undefined
            }
            disabled={pending}
            onChange={setDelivery}
            onLeave={() => {
              setAttempted(true);
            }}
            locale={i18n.locale}
          />
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${formId}-name`}>
            <Trans>Action name (optional)</Trans>
          </FieldLabel>
          <Input
            id={`${formId}-name`}
            value={name}
            disabled={pending}
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <FieldDescription>
            <Trans>Shown in Bulk Actions, to tell this one from others.</Trans>
          </FieldDescription>
        </Field>
      </form>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {stillMissing === undefined ? null : (
          <p id={missingId} className="mr-auto text-sm text-muted-foreground">
            {stillMissing}
          </p>
        )}
        <Button variant="secondary" disabled={pending} onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          type="submit"
          form={formId}
          variant={destructive ? 'secondary' : 'primary'}
          className={destructive ? 'border-destructive text-destructive' : undefined}
          disabled={stillMissing !== undefined || pending}
          aria-describedby={stillMissing === undefined ? undefined : missingId}
        >
          {pending ? <Trans>Working…</Trans> : confirmWords[confirm]}
        </Button>
      </div>
    </SmallDialog>
  );
}

/** When the action runs: now, from a later time, or in timed batches. */
function DeliveryFields({
  value,
  count,
  problem,
  disabled,
  onChange,
  onLeave,
  locale,
}: {
  readonly value: DeliveryForm;
  readonly count: number;
  /** What to put right, once it is time to say so. */
  readonly problem: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: DeliveryForm) => void;
  /** The person left one of the fields: what is wrong may be said now. */
  readonly onLeave: () => void;
  readonly locale: string;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const set = (change: Partial<DeliveryForm>) => {
    onChange({ ...value, ...change });
  };
  const modes: readonly (readonly [DeliveryMode, string])[] = [
    ['now', t`Run now`],
    ['later', t`Start at a set time`],
    ['drip', t`Drip mode: in batches`],
  ];
  const units: readonly (readonly [IntervalUnit, string])[] = [
    ['minutes', t`Minutes`],
    ['hours', t`Hours`],
    ['days', t`Days`],
  ];
  const timing = deliveryOf(value);
  const drip = 'problem' in timing ? undefined : timing.delivery?.drip;
  const minutes = drip === undefined ? 0 : dripMinutes(count, drip.batchSize, drip.intervalMinutes);
  // In the largest whole unit it reaches, in the reader's own words for it.
  const [amount, unit] =
    minutes >= 24 * 60
      ? [minutes / (24 * 60), 'day']
      : minutes >= 60
        ? [minutes / 60, 'hour']
        : [minutes, 'minute'];
  const durationWords = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'long',
    maximumFractionDigits: 1,
  }).format(amount);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1.5 text-sm font-medium">
        <Trans>When</Trans>
      </legend>
      {modes.map(([mode, label]) => (
        <label key={mode} className={radioClassName}>
          <input
            type="radio"
            name={`${id}-mode`}
            className="size-4 shrink-0"
            checked={value.mode === mode}
            disabled={disabled}
            onChange={() => {
              set({ mode });
            }}
          />
          {label}
        </label>
      ))}
      {value.mode === 'now' ? null : (
        <Field>
          <FieldLabel htmlFor={`${id}-start`}>
            {value.mode === 'later' ? <Trans>Start on</Trans> : <Trans>Start on (optional)</Trans>}
          </FieldLabel>
          <Input
            id={`${id}-start`}
            type="datetime-local"
            value={value.startAt}
            disabled={disabled}
            onBlur={onLeave}
            onChange={(event) => {
              set({ startAt: event.target.value });
            }}
          />
        </Field>
      )}
      {value.mode === 'drip' ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field>
            <FieldLabel htmlFor={`${id}-batch`}>
              <Trans>Batch quantity</Trans>
            </FieldLabel>
            <Input
              id={`${id}-batch`}
              inputMode="numeric"
              className="w-28"
              value={value.batchSize}
              disabled={disabled}
              onBlur={onLeave}
              onChange={(event) => {
                set({ batchSize: event.target.value });
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-every`}>
              <Trans>Repeat after</Trans>
            </FieldLabel>
            <Input
              id={`${id}-every`}
              inputMode="numeric"
              className="w-20"
              value={value.every}
              disabled={disabled}
              onBlur={onLeave}
              onChange={(event) => {
                set({ every: event.target.value });
              }}
            />
          </Field>
          <Select
            aria-label={t`Unit`}
            className="w-auto"
            value={value.unit}
            disabled={disabled}
            onValueChange={(next) => {
              const chosen = units.find(([each]) => each === next)?.[0];
              if (chosen !== undefined) set({ unit: chosen });
            }}
          >
            {units.map(([each, label]) => (
              <option key={each} value={each}>
                {label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {drip === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          <Trans>Estimated duration: {durationWords} from the first batch to the last.</Trans>
        </p>
      )}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
