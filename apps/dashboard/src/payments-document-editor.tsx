// A quote or an invoice being written: who it is for, its dates, its lines, its discount,
// notes and terms at the left, and the paper as it will be printed at the right, redrawn as
// every number is typed. The totals are the contract's own arithmetic
// (computeDocumentTotals), the same the server stores, so what shows is what is saved.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createSalesDocument,
  issueSalesDocument,
  listProducts,
  updateSalesDocument,
  type BusinessProfile,
  type CommerceSettings,
  type CustomerSnapshot,
  type Product,
  type SalesDocument,
  type SalesDocumentKind,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, Plus, Trash2, X } from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { DocumentPaper, TotalsList, type PaperLine } from './payments-paper';
import { Chip, useFormats } from './payments-parts';
import {
  documentInput,
  draftChanged,
  draftOf,
  draftProblems,
  draftRejection,
  draftTotals,
  dueDateFor,
  emptyLine,
  isBlankLine,
  lineFromProduct,
  moveLine,
  sellerOfProfile,
  sentLines,
  type DiscountKind,
  type DocumentDraft,
  type LineDraft,
} from './payments-rules';
import { noRejection, type Rejection } from './problems';
import {
  ConfirmDialog,
  FormProblem,
  iconButtonClassName,
  isStale,
  retryFaults,
  RowMenu,
  savingProblem,
} from './settings-list';
import { useBusiness } from './workspace';

const cardClassName = 'flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-4';
const cardTitleClassName = 'text-base font-medium text-foreground';
const smallLabelClassName = 'text-xs text-muted-foreground';

// The contact and opportunity contracts arrive with the boxes that use them.
const ContactBox = lazy(() => import('./payments-document-contact'));
const OpportunitySelect = lazy(async () => ({
  default: (await import('./payments-document-contact')).OpportunitySelect,
}));

/** A box with its small grey label above it and what is wrong with it under it. */
function Boxed({
  label,
  error,
  className = '',
  children,
}: {
  readonly label: ReactNode;
  readonly error?: string | undefined;
  readonly className?: string;
  readonly children: (ids: {
    readonly id: string;
    readonly 'aria-invalid': boolean;
    readonly 'aria-describedby': string | undefined;
  }) => ReactNode;
}): ReactElement {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className={smallLabelClassName}>
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error !== undefined,
        'aria-describedby': error === undefined ? undefined : errorId,
      })}
      {error === undefined ? null : (
        <span id={errorId} className="text-xs font-medium text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

function DiscountBoxes({
  label,
  kindLabel,
  kind,
  value,
  currency,
  error,
  className,
  onChange,
}: {
  readonly label: ReactNode;
  /** What the choice between percent and money is called, for a screen reader. */
  readonly kindLabel: string;
  readonly kind: DiscountKind;
  readonly value: string;
  readonly currency: string;
  readonly error: string | undefined;
  readonly className?: string;
  readonly onChange: (changes: { kind?: DiscountKind; value?: string }) => void;
}): ReactElement {
  return (
    <Boxed label={label} error={error} className={className ?? ''}>
      {(ids) => (
        <span className="flex min-w-0 gap-1.5">
          <Input
            {...ids}
            inputMode="decimal"
            maxLength={24}
            autoComplete="off"
            className="min-w-0 flex-1"
            value={value}
            onChange={(event) => {
              onChange({ value: event.target.value });
            }}
          />
          <Select
            aria-label={kindLabel}
            className="w-20 shrink-0"
            value={kind}
            onValueChange={(next) => {
              onChange({ kind: next === 'amount' ? 'amount' : 'percent' });
            }}
          >
            <option value="percent">%</option>
            <option value="amount">{currency}</option>
          </Select>
        </span>
      )}
    </Boxed>
  );
}

function LineRow({
  line,
  index,
  count,
  currency,
  total,
  problems,
  onChange,
  onMove,
  onRemove,
}: {
  readonly line: LineDraft;
  readonly index: number;
  readonly count: number;
  readonly currency: string;
  /** What the line comes to before tax, or undefined while it cannot be worked out. */
  readonly total: string | undefined;
  readonly problems: Readonly<Record<string, string>>;
  readonly onChange: (changes: Partial<LineDraft>) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const { t } = useLingui();
  const formats = useFormats();
  const number = index + 1;
  const problem = (field: string): string | undefined =>
    problems[`lines/${String(index)}/${field}`];
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3">
      <legend className="sr-only">
        <Trans>Line {number}</Trans>
      </legend>
      <div className="flex min-w-0 items-start gap-2">
        <Boxed label={<Trans>Item</Trans>} error={problem('name')} className="flex-1">
          {(ids) => (
            <Input
              {...ids}
              maxLength={200}
              autoComplete="off"
              value={line.name}
              onChange={(event) => {
                onChange({ name: event.target.value });
              }}
            />
          )}
        </Boxed>
        <div className="flex shrink-0 items-center pt-5">
          <button
            type="button"
            className={iconButtonClassName}
            aria-label={t`Move line ${number} up`}
            disabled={index === 0}
            onClick={() => {
              onMove(-1);
            }}
          >
            <ArrowUp aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={iconButtonClassName}
            aria-label={t`Move line ${number} down`}
            disabled={index === count - 1}
            onClick={() => {
              onMove(1);
            }}
          >
            <ArrowDown aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={`${iconButtonClassName} text-destructive hover:text-destructive`}
            aria-label={t`Remove line ${number}`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <Boxed label={<Trans>Description (optional)</Trans>} error={problem('description')}>
        {(ids) => (
          <Input
            {...ids}
            maxLength={5000}
            autoComplete="off"
            value={line.description}
            onChange={(event) => {
              onChange({ description: event.target.value });
            }}
          />
        )}
      </Boxed>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Boxed label={<Trans>Quantity</Trans>} error={problem('quantity')}>
          {(ids) => (
            <Input
              {...ids}
              inputMode="decimal"
              maxLength={24}
              autoComplete="off"
              value={line.quantity}
              onChange={(event) => {
                onChange({ quantity: event.target.value });
              }}
            />
          )}
        </Boxed>
        <Boxed label={<Trans>Unit</Trans>} error={problem('unit')}>
          {(ids) => (
            <Input
              {...ids}
              maxLength={32}
              autoComplete="off"
              value={line.unit}
              onChange={(event) => {
                onChange({ unit: event.target.value });
              }}
            />
          )}
        </Boxed>
        <Boxed label={<Trans>Unit price ({currency})</Trans>} error={problem('unitPrice')}>
          {(ids) => (
            <Input
              {...ids}
              inputMode="decimal"
              maxLength={24}
              autoComplete="off"
              value={line.unitPrice}
              onChange={(event) => {
                onChange({ unitPrice: event.target.value });
              }}
            />
          )}
        </Boxed>
        <DiscountBoxes
          label={<Trans>Discount</Trans>}
          kindLabel={t`Discount of line ${number} is in`}
          kind={line.discountKind}
          value={line.discountValue}
          currency={currency}
          error={problem('discount/value') ?? problem('discount')}
          onChange={(changes) => {
            onChange({
              ...(changes.kind === undefined ? {} : { discountKind: changes.kind }),
              ...(changes.value === undefined ? {} : { discountValue: changes.value }),
            });
          }}
        />
        <Boxed label={<Trans>Tax (%)</Trans>} error={problem('taxRate')}>
          {(ids) => (
            <Input
              {...ids}
              inputMode="decimal"
              maxLength={8}
              autoComplete="off"
              value={line.taxRate}
              onChange={(event) => {
                onChange({ taxRate: event.target.value });
              }}
            />
          )}
        </Boxed>
        <div className="flex min-w-0 flex-col gap-1">
          <span className={smallLabelClassName}>
            <Trans>Line total before tax</Trans>
          </span>
          <span className="flex min-h-11 items-center text-sm font-semibold whitespace-nowrap text-foreground lg:min-h-9">
            {total === undefined ? '—' : formats.money(total, currency)}
          </span>
        </div>
      </div>
    </fieldset>
  );
}

export interface EditorProps {
  readonly kind: SalesDocumentKind;
  /** The saved draft, or undefined for one being started. */
  readonly document: SalesDocument | undefined;
  /** What a new draft starts with. */
  readonly initial: DocumentDraft;
  /** The contact a new draft was started for, from their page. */
  readonly prefillContactId: string | undefined;
  readonly profile: BusinessProfile;
  readonly settings: CommerceSettings;
  /** The page's heading row: the editor hands it the buttons. */
  readonly frame: (actions: ReactNode, body: ReactNode) => ReactElement;
  /** A save or an issue went through: the page shows the document as it is now. */
  readonly onSettled: (document: SalesDocument, message: string) => void;
  /** The saved version, read again after someone else changed it. */
  readonly onReload: () => void;
  readonly onDuplicate: (() => void) | undefined;
  readonly onDelete: ((trigger: HTMLElement | null) => void) | undefined;
  /** Downloads the saved draft as a PDF; undefined for a draft that was never saved. */
  readonly onDownload: ((saved: SalesDocument) => void) | undefined;
  /** Opens the dialog that issues and sends the saved draft; undefined when it cannot be sent. */
  readonly onSend: ((saved: SalesDocument, trigger: HTMLElement | null) => void) | undefined;
  readonly busy: boolean;
}

export default function DocumentEditor({
  kind,
  document,
  initial,
  prefillContactId,
  profile,
  settings,
  frame,
  onSettled,
  onReload,
  onDuplicate,
  onDelete,
  onDownload,
  onSend,
  busy,
}: EditorProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const invoice = kind === 'invoice';
  const [draft, setDraft] = useState(initial);
  const [prefillId, setPrefillId] = useState(prefillContactId);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [confirming, setConfirming] = useState(false);
  const [issueProblem, setIssueProblem] = useState<string>();
  const keyRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const nextKey = (): string => {
    keyRef.current += 1;
    return `new-${String(keyRef.current)}`;
  };
  const set = (changes: Partial<DocumentDraft>): void => {
    setDraft((before) => ({ ...before, ...changes }));
  };
  const setLine = (index: number, changes: Partial<LineDraft>): void => {
    setDraft((before) => ({
      ...before,
      lines: before.lines.map((line, at) => (at === index ? { ...line, ...changes } : line)),
    }));
  };

  const products = useQuery({
    queryKey: ['b', business.id, 'payments', 'products', 'offered'],
    queryFn: () => api.request(listProducts, { query: { archived: 'false', limit: 200 } }),
    staleTime: 60_000,
    retry: retryFaults,
  });
  const offered = (products.data?.items ?? []).filter((each) => each.currency === draft.currency);

  const result = draftTotals(draft);
  const totals = result.ok ? result.totals : undefined;
  const sent = sentLines(draft);
  const totalsAt = (index: number) => {
    const place = sent.findIndex((each) => each.index === index);
    return place === -1 ? undefined : totals?.lines[place];
  };
  const fieldProblems = { ...draftProblems(draft), ...problem.fields };
  const input = documentInput(draft);
  const dirty = document === undefined || draftChanged(draft, draftOf(document));

  const persist = async (): Promise<SalesDocument> => {
    if (input === undefined) throw new Error('A document needs a contact.');
    if (document === undefined)
      return api.request(createSalesDocument, { body: { ...input, kind } });
    if (!dirty) return document;
    return api.request(updateSalesDocument, {
      params: { id: document.id },
      body: { ...input, revision: document.revision },
    });
  };
  const failed = (error: unknown): void => {
    setConfirming(false);
    if (isStale(error)) {
      setProblem({
        fields: {},
        form: t`Someone changed this draft since you opened it. Reload the saved version, then make your changes again.`,
      });
      return;
    }
    setProblem(
      error instanceof ApiError && error.problem.errors !== undefined
        ? draftRejection(draft, error.problem.errors)
        : savingProblem(error, t`It wasn't saved. Check your connection and try again.`),
    );
  };
  // What a save is handed is what it was for, such as the PDF of the draft as it now is.
  const save = useMutation<SalesDocument, unknown, ((saved: SalesDocument) => void) | undefined>({
    mutationFn: () => persist(),
    onSuccess: (saved, then) => {
      onSettled(saved, t`Draft saved.`);
      then?.(saved);
    },
    onError: failed,
  });
  /** Does something with the draft as the form has it: saved first when it was changed. */
  const savedThen = (then: (saved: SalesDocument) => void): void => {
    setProblem(noRejection);
    setIssueProblem(undefined);
    if (document !== undefined && !dirty) then(document);
    else save.mutate(then);
  };
  const issue = useMutation({
    mutationFn: async () => {
      const saved = await persist();
      try {
        const issued = await api.request(issueSalesDocument, {
          params: { id: saved.id },
          body: { revision: saved.revision },
        });
        return { document: issued, refused: undefined };
      } catch (error) {
        return { document: saved, refused: error };
      }
    },
    onSuccess: ({ document: latest, refused }) => {
      if (refused === undefined) {
        const number = latest.number ?? '';
        onSettled(latest, t`Issued as ${number}.`);
        return;
      }
      const fallback = t`The draft was saved, but it wasn't issued. Check your connection and try again.`;
      const why = savingProblem(refused, fallback).form ?? fallback;
      // A draft that was only just created has a page of its own to open, with the reason.
      if (document === undefined) onSettled(latest, why);
      else setIssueProblem(why);
    },
    onError: failed,
  });
  const working = save.isPending || issue.isPending || busy;
  const ready = input !== undefined && result.ok && !working;

  const customer: CustomerSnapshot | undefined =
    draft.contact === null
      ? undefined
      : {
          name: draft.contact.name,
          email: document?.contactId === draft.contact.id ? document.customer.email : null,
          phone: document?.contactId === draft.contact.id ? document.customer.phone : null,
          billTo: draft.billTo.trim(),
          taxNumber: draft.customerTaxNumber.trim() === '' ? null : draft.customerTaxNumber.trim(),
        };
  const paperLines: PaperLine[] = sent.map(({ index, input: line }, place) => ({
    key: draft.lines[index]?.key ?? String(index),
    name: line.name,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    taxRate: line.taxRate,
    amount: totals?.lines[place]?.amount,
    discount: totals?.lines[place]?.discount,
  }));
  const issueDate = draft.issueDate === '' ? null : draft.issueDate;
  const dueDate =
    draft.dueDate !== ''
      ? draft.dueDate
      : issueDate === null
        ? null
        : dueDateFor(kind, issueDate, settings);
  const nextNumber = document?.number ?? settings.numbering[kind].example;

  const addProduct = (product: Product): void => {
    const line = lineFromProduct(nextKey(), product, settings.defaultTaxRate);
    setDraft((before) => {
      const last = before.lines.at(-1);
      // A blank last row is the one the product fills.
      const kept =
        last !== undefined && isBlankLine(last) ? before.lines.slice(0, -1) : before.lines;
      return { ...before, lines: [...kept, line] };
    });
  };

  const duplicating = onDuplicate !== undefined && !dirty;
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        disabled={!ready || !dirty}
        onClick={() => {
          setProblem(noRejection);
          setIssueProblem(undefined);
          save.mutate(undefined);
        }}
      >
        {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save draft</Trans>}
      </Button>
      {onDownload === undefined ? null : (
        <Button
          variant="secondary"
          disabled={!ready}
          onClick={() => {
            savedThen(onDownload);
          }}
        >
          <Download aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Download draft PDF</Trans>
        </Button>
      )}
      {onSend === undefined ? null : (
        <Button
          variant="secondary"
          data-send-button
          disabled={!ready || sent.length === 0}
          onClick={(event) => {
            const trigger = event.currentTarget;
            savedThen((saved) => {
              onSend(saved, trigger);
            });
          }}
        >
          <Trans>Send</Trans>
        </Button>
      )}
      <Button
        disabled={!ready || sent.length === 0}
        onClick={(event) => {
          returnFocusRef.current = event.currentTarget;
          setProblem(noRejection);
          setIssueProblem(undefined);
          setConfirming(true);
        }}
      >
        <Trans>Issue</Trans>
      </Button>
      {!duplicating && onDelete === undefined ? null : (
        <RowMenu
          label={t`More actions`}
          actions={[
            ...(duplicating
              ? [{ label: t`Duplicate`, immediate: true, onSelect: onDuplicate }]
              : []),
            ...(onDelete === undefined
              ? []
              : [
                  {
                    label: t`Delete draft`,
                    destructive: true,
                    onSelect: () => {
                      onDelete(returnFocusRef.current);
                    },
                  },
                ]),
          ]}
          onOpen={(trigger) => {
            returnFocusRef.current = trigger;
            setProblem(noRejection);
          }}
        />
      )}
    </div>
  );

  const body = (
    <>
      <FormProblem
        problem={problem}
        stale={isStale(save.error) || isStale(issue.error)}
        busy={working}
        onReload={onReload}
      />
      {issueProblem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {issueProblem}
        </p>
      )}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <form
          noValidate
          aria-label={invoice ? t`Invoice details` : t`Quote details`}
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <section className={cardClassName}>
            <h2 className={cardTitleClassName}>
              <Trans>Customer</Trans>
            </h2>
            {draft.contact === null ? (
              <div className="flex flex-col gap-1">
                <span className={smallLabelClassName}>
                  <Trans>Contact</Trans>
                </span>
                <Suspense fallback={null}>
                  <ContactBox
                    businessId={business.id}
                    prefillId={prefillId}
                    disabled={working}
                    onPick={(contact) => {
                      setPrefillId(undefined);
                      set({
                        contact,
                        dealId: contact.id === prefillContactId ? draft.dealId : null,
                      });
                    }}
                  />
                </Suspense>
                {fieldProblems['contactId'] === undefined ? null : (
                  <span className="text-xs font-medium text-destructive">
                    {fieldProblems['contactId']}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <span className={smallLabelClassName}>
                  <Trans>Contact</Trans>
                </span>
                <span className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0 text-sm font-semibold wrap-anywhere text-foreground">
                    {draft.contact.name === '' ? (
                      <Trans>Unnamed contact</Trans>
                    ) : (
                      draft.contact.name
                    )}
                  </span>
                  <button
                    type="button"
                    className={iconButtonClassName}
                    aria-label={t`Choose another contact`}
                    onClick={() => {
                      set({ contact: null, dealId: null });
                    }}
                  >
                    <X aria-hidden className="size-4" strokeWidth={1.8} />
                  </button>
                </span>
              </div>
            )}
            {draft.contact === null ? null : (
              <Suspense fallback={null}>
                <OpportunitySelect
                  businessId={business.id}
                  contactId={draft.contact.id}
                  value={draft.dealId}
                  onChange={(dealId) => {
                    set({ dealId });
                  }}
                />
              </Suspense>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Boxed label={<Trans>Billing address</Trans>} error={fieldProblems['billTo']}>
                {(ids) => (
                  <Textarea
                    {...ids}
                    rows={3}
                    maxLength={1000}
                    value={draft.billTo}
                    onChange={(event) => {
                      set({ billTo: event.target.value });
                    }}
                  />
                )}
              </Boxed>
              <Boxed
                label={<Trans>Customer's tax number (optional)</Trans>}
                error={fieldProblems['customerTaxNumber']}
              >
                {(ids) => (
                  <Input
                    {...ids}
                    maxLength={64}
                    autoComplete="off"
                    value={draft.customerTaxNumber}
                    onChange={(event) => {
                      set({ customerTaxNumber: event.target.value });
                    }}
                  />
                )}
              </Boxed>
            </div>
          </section>

          <section className={cardClassName}>
            <h2 className={cardTitleClassName}>
              <Trans>Dates and currency</Trans>
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Boxed label={<Trans>Issue date</Trans>} error={fieldProblems['issueDate']}>
                {(ids) => (
                  <Input
                    {...ids}
                    type="date"
                    value={draft.issueDate}
                    onChange={(event) => {
                      set({ issueDate: event.target.value });
                    }}
                  />
                )}
              </Boxed>
              <Boxed
                label={invoice ? <Trans>Due date</Trans> : <Trans>Valid until</Trans>}
                error={fieldProblems['dueDate']}
              >
                {(ids) => (
                  <Input
                    {...ids}
                    type="date"
                    value={draft.dueDate}
                    onChange={(event) => {
                      set({ dueDate: event.target.value });
                    }}
                  />
                )}
              </Boxed>
              <Boxed label={<Trans>Currency</Trans>} error={fieldProblems['currency']}>
                {(ids) => (
                  <Input
                    {...ids}
                    maxLength={3}
                    autoComplete="off"
                    value={draft.currency}
                    onChange={(event) => {
                      set({ currency: event.target.value.toUpperCase() });
                    }}
                  />
                )}
              </Boxed>
            </div>
            <p className="text-xs text-muted-foreground">
              {invoice ? (
                <Trans>
                  Leave the dates empty to use the day it is issued and your payment terms.
                </Trans>
              ) : (
                <Trans>
                  Leave the dates empty to use the day it is issued and your quote validity.
                </Trans>
              )}
            </p>
          </section>

          <section className={cardClassName}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className={cardTitleClassName}>
                <Trans>Lines</Trans>
              </h2>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {offered.length === 0 ? null : (
                  <Select
                    aria-label={t`Add a product or service`}
                    className="w-56 max-w-full"
                    value=""
                    onValueChange={(next) => {
                      const product = offered.find((each) => each.id === next);
                      if (product !== undefined) addProduct(product);
                    }}
                  >
                    <option value="">{t`Add a product or service`}</option>
                    {offered.map((each) => (
                      <option key={each.id} value={each.id}>
                        {each.name}
                      </option>
                    ))}
                  </Select>
                )}
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    set({ lines: [...draft.lines, emptyLine(nextKey(), settings.defaultTaxRate)] });
                  }}
                >
                  <Plus aria-hidden className="size-4" strokeWidth={2} />
                  <Trans>Add line</Trans>
                </Button>
              </div>
            </div>
            {draft.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No lines yet. Add a product, or a line to type freely.</Trans>
              </p>
            ) : null}
            {fieldProblems['lines'] === undefined ? null : (
              <p role="alert" className="text-sm font-medium text-destructive">
                {fieldProblems['lines']}
              </p>
            )}
            {draft.lines.map((line, index) => (
              <LineRow
                key={line.key}
                line={line}
                index={index}
                count={draft.lines.length}
                currency={draft.currency}
                total={totalsAt(index)?.net}
                problems={fieldProblems}
                onChange={(changes) => {
                  setLine(index, changes);
                }}
                onMove={(by) => {
                  set({ lines: moveLine(draft.lines, index, by) });
                }}
                onRemove={() => {
                  set({ lines: draft.lines.filter((_, at) => at !== index) });
                }}
              />
            ))}
            <div className="grid items-start gap-4 border-t border-border pt-4 sm:grid-cols-2">
              <DiscountBoxes
                label={<Trans>Discount on the whole document</Trans>}
                kindLabel={t`Discount on the whole document is in`}
                kind={draft.discountKind}
                value={draft.discountValue}
                currency={draft.currency}
                error={fieldProblems['discount/value'] ?? fieldProblems['discount']}
                onChange={(changes) => {
                  set({
                    ...(changes.kind === undefined ? {} : { discountKind: changes.kind }),
                    ...(changes.value === undefined ? {} : { discountValue: changes.value }),
                  });
                }}
              />
              <TotalsList totals={totals} currency={draft.currency} className="min-w-0" />
            </div>
          </section>

          <section className={cardClassName}>
            <h2 className={cardTitleClassName}>
              <Trans>Notes and terms</Trans>
            </h2>
            <Boxed label={<Trans>Notes for the customer</Trans>} error={fieldProblems['notes']}>
              {(ids) => (
                <Textarea
                  {...ids}
                  rows={3}
                  maxLength={5000}
                  value={draft.notes}
                  onChange={(event) => {
                    set({ notes: event.target.value });
                  }}
                />
              )}
            </Boxed>
            <Boxed label={<Trans>Terms and conditions</Trans>} error={fieldProblems['terms']}>
              {(ids) => (
                <Textarea
                  {...ids}
                  rows={4}
                  maxLength={10000}
                  value={draft.terms}
                  onChange={(event) => {
                    set({ terms: event.target.value });
                  }}
                />
              )}
            </Boxed>
          </section>
        </form>

        <div className="flex min-w-0 flex-col gap-2 xl:sticky xl:top-28">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Trans>Preview</Trans>
          </h2>
          <DocumentPaper
            kind={kind}
            number={document?.number ?? null}
            chip={
              <Chip tone="neutral">
                <Trans>Draft</Trans>
              </Chip>
            }
            seller={sellerOfProfile(profile, settings)}
            customer={customer}
            issueDate={issueDate}
            dueDate={dueDate}
            currency={draft.currency}
            lines={paperLines}
            totals={totals}
            notes={draft.notes.trim()}
            terms={draft.terms.trim()}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title={invoice ? <Trans>Issue this invoice?</Trans> : <Trans>Issue this quote?</Trans>}
        description={
          (document?.number ?? null) === null ? (
            <Trans>
              It will be numbered {nextNumber} and marked as sent. After that it can no longer be
              edited freely: to change it you revise it, and it keeps its number. Issuing sends
              nothing by itself.
            </Trans>
          ) : (
            <Trans>
              It keeps its number, {nextNumber}, and is marked as sent again. After that it can no
              longer be edited freely: to change it you revise it. Issuing sends nothing by itself.
            </Trans>
          )
        }
        confirmLabel={issue.isPending ? t`Issuing…` : t`Issue`}
        busy={issue.isPending}
        problem={undefined}
        returnFocus={returnFocusRef}
        onClose={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          issue.mutate(undefined, {
            onSettled: () => {
              setConfirming(false);
            },
          });
        }}
      />
    </>
  );
  return frame(actions, body);
}
