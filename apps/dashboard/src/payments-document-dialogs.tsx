// The small dialogs of a quote's or an invoice's page: the one that asks for a reason (to
// void an invoice, to reverse a payment) and the one that records a payment. What is typed
// is checked by the contract's own rules as it is typed, and the server's words come back
// under the field it refuses.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  currencyDigits,
  paymentMethods,
  paymentRefusal,
  recordPayment,
  todayIn,
  type PaymentMethod,
  type Receipt,
  type SalesDocument,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { apiIn } from './api';
import { useFormats, usePaymentMethodNames } from './payments-parts';
import { plainDecimal } from './payments-rules';
import { noRejection, type Rejection } from './problems';
import { savingProblem, SmallDialog } from './settings-list';
import { useBusiness } from './workspace';

function FormRefusal({ problem }: { readonly problem: Rejection }): ReactElement | null {
  return problem.form === undefined ? null : (
    <p role="alert" className="text-sm font-medium text-destructive">
      {problem.form}
    </p>
  );
}

/** Asks why, then does it: the reason is kept with what was voided or reversed. */
export function ReasonDialog({
  title,
  description,
  confirmLabel,
  fallback,
  returnFocus,
  run,
  onClose,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly confirmLabel: ReactNode;
  /** What is said when it failed without the server saying why. */
  readonly fallback: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  /** Does it, and says so on the page: the dialog stays open, with the reason, if it is refused. */
  readonly run: (reason: string) => Promise<void>;
  readonly onClose: () => void;
}): ReactElement {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const act = useMutation({
    mutationFn: run,
    onError: (error) => {
      setProblem(savingProblem(error, fallback));
    },
  });
  return (
    <SmallDialog
      open
      title={title}
      description={description}
      returnFocus={returnFocus}
      onClose={() => {
        if (!act.isPending) onClose();
      }}
    >
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={() => {
          setProblem(noRejection);
          act.mutate(reason.trim());
        }}
      >
        <Field name="reason">
          <FieldLabel>
            <Trans>Reason</Trans>
          </FieldLabel>
          <Textarea
            required
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <FieldError />
        </Field>
        <FormRefusal problem={problem} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={act.isPending}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            variant="secondary"
            className="border-destructive text-destructive"
            disabled={act.isPending || reason.trim() === ''}
          >
            {confirmLabel}
          </Button>
        </div>
      </Form>
    </SmallDialog>
  );
}

/** Records money received against an invoice: never more than is still owed. */
export function PaymentDialog({
  invoice,
  timeZone,
  returnFocus,
  onRecorded,
  onClose,
}: {
  readonly invoice: SalesDocument;
  /** The business's time zone, for today's date. */
  readonly timeZone: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onRecorded: (receipt: Receipt) => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const formats = useFormats();
  const methodNames = usePaymentMethodNames();
  const { currency } = invoice;
  const balance = invoice.totals.balanceDue;
  const [amount, setAmount] = useState(() => plainDecimal(balance, currencyDigits(currency)));
  const [paidOn, setPaidOn] = useState(() => todayIn(timeZone, new Date()));
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const typed = amount.trim();
  const refusal = typed === '' ? undefined : paymentRefusal(typed, balance, currency);
  const record = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(recordPayment, {
        params: { id: invoice.id },
        body: {
          amount: typed,
          ...(paidOn === '' ? {} : { paidOn }),
          method,
          reference: reference.trim() === '' ? null : reference.trim(),
          note: note.trim(),
        },
      }),
    onSuccess: onRecorded,
    onError: (error) => {
      setProblem(
        savingProblem(error, t`The payment wasn't recorded. Check your connection and try again.`),
      );
    },
  });
  const number = invoice.number ?? '';
  const owed = formats.money(balance, currency);
  const amountProblem = refusal?.message ?? problem.fields['amount'];
  return (
    <SmallDialog
      open
      title={<Trans>Record payment</Trans>}
      description={
        <Trans>
          {owed} is still owed on {number}.
        </Trans>
      }
      returnFocus={returnFocus}
      onClose={() => {
        if (!record.isPending) onClose();
      }}
    >
      <Form<Record<string, unknown>>
        errors={{
          ...problem.fields,
          ...(amountProblem === undefined ? {} : { amount: amountProblem }),
        }}
        onFormSubmit={() => {
          setProblem(noRejection);
          record.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="amount">
            <FieldLabel>
              <Trans>Amount ({currency})</Trans>
            </FieldLabel>
            <Input
              required
              inputMode="decimal"
              maxLength={24}
              autoComplete="off"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
            <FieldError match={amountProblem !== undefined}>{amountProblem}</FieldError>
          </Field>
          <Field name="paidOn">
            <FieldLabel>
              <Trans>Date received</Trans>
            </FieldLabel>
            <Input
              type="date"
              value={paidOn}
              onChange={(event) => {
                setPaidOn(event.target.value);
              }}
            />
            <FieldError />
          </Field>
        </div>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <Trans>Method</Trans>
          <Select
            aria-label={t`Method`}
            value={method}
            onValueChange={(next) => {
              const chosen = paymentMethods.find((each) => each === next);
              if (chosen !== undefined) setMethod(chosen);
            }}
          >
            {paymentMethods.map((each) => (
              <option key={each} value={each}>
                {methodNames[each]}
              </option>
            ))}
          </Select>
        </label>
        <Field name="reference">
          <FieldLabel>
            <Trans>Reference</Trans>
          </FieldLabel>
          <Input
            maxLength={200}
            autoComplete="off"
            value={reference}
            onChange={(event) => {
              setReference(event.target.value);
            }}
          />
          <FieldDescription>
            <Trans>The bank's, the mobile money or the cheque's own reference, if any.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <Field name="note">
          <FieldLabel>
            <Trans>Note</Trans>
          </FieldLabel>
          <Textarea
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          <FieldError />
        </Field>
        <FormRefusal problem={problem} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={record.isPending}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            disabled={record.isPending || typed === '' || refusal !== undefined}
          >
            {record.isPending ? <Trans>Recording…</Trans> : <Trans>Record payment</Trans>}
          </Button>
        </div>
      </Form>
    </SmallDialog>
  );
}
