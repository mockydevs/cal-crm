// A quote, an invoice or a receipt as it is printed: who it is from, with the logo, who it
// is for, its lines and totals, then the notes, the terms and how to pay. A draft is drawn
// from the business profile and the settings as they are now; once issued, from what the
// document stored then. The PDF is laid out the same way.
import { Trans, useLingui } from '@lingui/react/macro';
import type { CustomerSnapshot, Receipt, SalesDocumentKind } from '@repo/contracts';
import type { ReactElement, ReactNode } from 'react';
import { Chip, Labelled, useFormats, useLogoUrl, usePaymentMethodNames } from './payments-parts';
import { plainDecimal, sellerOfSnapshot, type SellerView } from './payments-rules';

export interface PaperLine {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  /** Percent, or null for none. */
  readonly taxRate: string | null;
  /** Quantity times price, and the line's own discount; undefined while they cannot be worked out. */
  readonly amount: string | undefined;
  readonly discount: string | undefined;
}

export interface PaperTotals {
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxes: readonly {
    readonly rate: string;
    readonly taxable: string;
    readonly tax: string;
  }[];
  readonly total: string;
  /** On an issued invoice: what has been paid, and what is still owed. */
  readonly amountPaid?: string;
  readonly balanceDue?: string;
}

const paperClassName =
  '@container flex min-w-0 flex-col gap-6 rounded-card border border-border bg-card p-5 text-sm text-body shadow-[0_1px_3px_rgb(16_24_40/0.08)] sm:p-8';
const smallHeadingClassName = 'text-xs font-medium tracking-wide text-muted-foreground uppercase';
const isZero = (amount: string): boolean => /^0(\.0+)?$/.test(amount);

/** The top of every paper: the logo and the business at the left, what the paper is at the right. */
function Letterhead({
  seller,
  children,
}: {
  readonly seller: SellerView;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  const logo = useLogoUrl(seller.logoFileId);
  const sellerName = seller.name;
  const taxNumber = seller.taxNumber;
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 flex-col gap-2">
        {logo === undefined ? null : (
          <img
            src={logo}
            alt={t`Logo of ${sellerName}`}
            className="h-14 w-auto max-w-40 self-start object-contain"
          />
        )}
        <div className="flex min-w-0 flex-col">
          <span className="text-base font-semibold wrap-anywhere text-foreground">
            {seller.name}
          </span>
          {seller.addressLines.map((line) => (
            <span key={line} className="wrap-anywhere">
              {line}
            </span>
          ))}
          {taxNumber === null ? null : (
            <span className="wrap-anywhere">
              <Trans>Tax number: {taxNumber}</Trans>
            </span>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1 @md:items-end @md:text-right">
        {children}
      </div>
    </header>
  );
}

function CustomerBlock({
  heading,
  customer,
}: {
  readonly heading: ReactNode;
  readonly customer: CustomerSnapshot | undefined;
}): ReactElement {
  const taxNumber = customer?.taxNumber ?? null;
  return (
    <div className="flex min-w-0 flex-col">
      <span className={smallHeadingClassName}>{heading}</span>
      {customer === undefined ? (
        <span className="text-muted-foreground">
          <Trans>Choose a contact</Trans>
        </span>
      ) : (
        <>
          <span className="font-semibold wrap-anywhere text-foreground">
            {customer.name === '' ? <Trans>Unnamed contact</Trans> : customer.name}
          </span>
          {customer.billTo === '' ? null : (
            <span className="wrap-anywhere whitespace-pre-line">{customer.billTo}</span>
          )}
          {customer.email === null ? null : <span className="wrap-anywhere">{customer.email}</span>}
          {customer.phone === null ? null : <span className="wrap-anywhere">{customer.phone}</span>}
          {taxNumber === null ? null : (
            <span className="wrap-anywhere">
              <Trans>Tax number: {taxNumber}</Trans>
            </span>
          )}
        </>
      )}
    </div>
  );
}

function Prose({
  heading,
  text,
}: {
  readonly heading: ReactNode;
  readonly text: string;
}): ReactElement | null {
  return text === '' ? null : (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className={smallHeadingClassName}>{heading}</h3>
      <p className="wrap-anywhere whitespace-pre-line">{text}</p>
    </section>
  );
}

export function DocumentPaper({
  kind,
  number,
  chip,
  seller,
  customer,
  issueDate,
  dueDate,
  currency,
  lines,
  totals,
  notes,
  terms,
}: {
  readonly kind: SalesDocumentKind;
  /** Null until it is issued. */
  readonly number: string | null;
  readonly chip: ReactNode;
  readonly seller: SellerView;
  /** Undefined until a contact is chosen. */
  readonly customer: CustomerSnapshot | undefined;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly lines: readonly PaperLine[];
  /** Undefined while the numbers typed cannot be worked out. */
  readonly totals: PaperTotals | undefined;
  readonly notes: string;
  readonly terms: string;
}): ReactElement {
  const { t } = useLingui();
  const formats = useFormats();
  const invoice = kind === 'invoice';
  const money = (amount: string): string => formats.money(amount, currency);
  return (
    <article
      aria-label={invoice ? t`Invoice as it is printed` : t`Quote as it is printed`}
      className={paperClassName}
    >
      <Letterhead seller={seller}>
        <h2 className="text-2xl font-semibold tracking-wide text-foreground uppercase">
          {invoice ? <Trans>Invoice</Trans> : <Trans>Quote</Trans>}
        </h2>
        <span className="font-semibold wrap-anywhere text-foreground">
          {number ?? <Trans>Not numbered yet</Trans>}
        </span>
        {chip}
      </Letterhead>

      <div className="grid gap-4 @md:grid-cols-2">
        <CustomerBlock
          heading={invoice ? <Trans>Bill to</Trans> : <Trans>Quote for</Trans>}
          customer={customer}
        />
        <dl className="grid grid-cols-2 gap-3 @md:justify-items-end @md:text-right">
          <Labelled label={<Trans>Issue date</Trans>}>
            {issueDate === null ? <Trans>When issued</Trans> : formats.day(issueDate)}
          </Labelled>
          <Labelled label={invoice ? <Trans>Due date</Trans> : <Trans>Valid until</Trans>}>
            {dueDate === null ? <Trans>Set when issued</Trans> : formats.day(dueDate)}
          </Labelled>
        </dl>
      </div>

      <table className="w-full border-separate border-spacing-0 text-left">
        <caption className="sr-only">
          <Trans>Lines</Trans>
        </caption>
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th scope="col" className="border-b border-border py-2 pr-2 font-medium">
              <Trans>Item</Trans>
            </th>
            <th
              scope="col"
              className="hidden border-b border-border px-2 py-2 text-right font-medium @lg:table-cell"
            >
              <Trans>Qty</Trans>
            </th>
            <th
              scope="col"
              className="hidden border-b border-border px-2 py-2 text-right font-medium @lg:table-cell"
            >
              <Trans>Unit price</Trans>
            </th>
            <th
              scope="col"
              className="hidden border-b border-border px-2 py-2 text-right font-medium @lg:table-cell"
            >
              <Trans>Tax</Trans>
            </th>
            <th scope="col" className="border-b border-border py-2 pl-2 text-right font-medium">
              <Trans>Amount</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-4 text-center text-muted-foreground">
                <Trans>No lines yet.</Trans>
              </td>
            </tr>
          ) : null}
          {lines.map((line) => {
            const quantity = `${plainDecimal(line.quantity === '' ? '0' : line.quantity)}${line.unit === '' ? '' : ` ${line.unit}`}`;
            const price = line.unitPrice === '' ? '—' : money(line.unitPrice);
            const tax = line.taxRate === null ? '—' : formats.percent(line.taxRate);
            const discount =
              line.discount === undefined || isZero(line.discount)
                ? undefined
                : money(line.discount);
            return (
              <tr key={line.key} className="align-top">
                <th scope="row" className="border-b border-border py-2.5 pr-2 font-normal">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium wrap-anywhere text-foreground">
                      {line.name === '' ? <Trans>Unnamed line</Trans> : line.name}
                    </span>
                    {line.description === '' ? null : (
                      <span className="text-xs wrap-anywhere whitespace-pre-line text-muted-foreground">
                        {line.description}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground @lg:hidden">
                      {quantity} × {price}
                      {line.taxRate === null ? null : (
                        <>
                          {' · '}
                          <Trans>Tax {tax}</Trans>
                        </>
                      )}
                    </span>
                  </span>
                </th>
                <td className="hidden border-b border-border px-2 py-2.5 text-right whitespace-nowrap @lg:table-cell">
                  {quantity}
                </td>
                <td className="hidden border-b border-border px-2 py-2.5 text-right whitespace-nowrap @lg:table-cell">
                  {price}
                </td>
                <td className="hidden border-b border-border px-2 py-2.5 text-right whitespace-nowrap @lg:table-cell">
                  {tax}
                </td>
                <td className="border-b border-border py-2.5 pl-2 text-right whitespace-nowrap">
                  <span className="flex flex-col items-end">
                    <span className="font-medium text-foreground">
                      {line.amount === undefined ? '—' : money(line.amount)}
                    </span>
                    {discount === undefined ? null : (
                      <span className="text-xs text-muted-foreground">
                        <Trans>Discount −{discount}</Trans>
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <section aria-label={t`Totals`} className="w-full self-end @md:w-72">
        <TotalsList totals={totals} currency={currency} />
      </section>

      <Prose heading={<Trans>Notes</Trans>} text={notes} />
      {invoice ? (
        <Prose heading={<Trans>How to pay</Trans>} text={seller.paymentInstructions} />
      ) : null}
      <Prose heading={<Trans>Terms</Trans>} text={terms} />
    </article>
  );
}

/** Subtotal, discounts, tax by rate, total, and on an invoice what was paid and is owed. */
export function TotalsList({
  totals,
  currency,
  className = '',
}: {
  readonly totals: PaperTotals | undefined;
  readonly currency: string;
  readonly className?: string;
}): ReactElement {
  const formats = useFormats();
  const money = (amount: string): string => formats.money(amount, currency);
  if (totals === undefined)
    return (
      <p className={`text-sm text-muted-foreground ${className}`}>
        <Trans>The totals show once every number above can be worked out.</Trans>
      </p>
    );
  const rowClassName = 'flex items-baseline justify-between gap-4';
  return (
    <dl className={`flex flex-col gap-1.5 text-sm ${className}`}>
      <div className={rowClassName}>
        <dt className="text-muted-foreground">
          <Trans>Subtotal</Trans>
        </dt>
        <dd className="whitespace-nowrap text-foreground">{money(totals.subtotal)}</dd>
      </div>
      {isZero(totals.discountTotal) ? null : (
        <div className={rowClassName}>
          <dt className="text-muted-foreground">
            <Trans>Discounts</Trans>
          </dt>
          <dd className="whitespace-nowrap text-foreground">−{money(totals.discountTotal)}</dd>
        </div>
      )}
      {totals.taxes
        .filter((each) => !isZero(each.rate))
        .map((each) => {
          const rate = formats.percent(each.rate);
          const taxable = money(each.taxable);
          return (
            <div key={each.rate} className={rowClassName}>
              <dt className="text-muted-foreground">
                <Trans>
                  Tax {rate} on {taxable}
                </Trans>
              </dt>
              <dd className="whitespace-nowrap text-foreground">{money(each.tax)}</dd>
            </div>
          );
        })}
      <div className={`${rowClassName} mt-1 border-t border-border pt-2 text-base font-semibold`}>
        <dt className="text-foreground">
          <Trans>Total</Trans>
        </dt>
        <dd className="whitespace-nowrap text-foreground">{money(totals.total)}</dd>
      </div>
      {totals.amountPaid === undefined || totals.balanceDue === undefined ? null : (
        <>
          <div className={rowClassName}>
            <dt className="text-muted-foreground">
              <Trans>Paid</Trans>
            </dt>
            <dd className="whitespace-nowrap text-foreground">{money(totals.amountPaid)}</dd>
          </div>
          <div className={`${rowClassName} font-semibold`}>
            <dt className="text-foreground">
              <Trans>Balance due</Trans>
            </dt>
            <dd className="whitespace-nowrap text-foreground">{money(totals.balanceDue)}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

/** A payment as its receipt: who paid whom, how much and how, and where the invoice stands. */
export function ReceiptPaper({ receipt }: { readonly receipt: Receipt }): ReactElement {
  const { t } = useLingui();
  const formats = useFormats();
  const methods = usePaymentMethodNames();
  const money = (amount: string): string => formats.money(amount, receipt.currency);
  const reversed = receipt.status === 'reversed';
  const reason = receipt.reversalReason ?? '';
  return (
    <article aria-label={t`Receipt as it is printed`} className={paperClassName}>
      <Letterhead seller={sellerOfSnapshot(receipt.seller)}>
        <h2 className="text-2xl font-semibold tracking-wide text-foreground uppercase">
          <Trans>Receipt</Trans>
        </h2>
        <span className="font-semibold wrap-anywhere text-foreground">{receipt.number}</span>
        <Chip tone={reversed ? 'danger' : 'success'}>
          {reversed ? <Trans>Reversed</Trans> : <Trans>Received</Trans>}
        </Chip>
      </Letterhead>
      {reversed ? (
        <p className="rounded-control border border-destructive p-3 text-sm text-destructive">
          {reason === '' ? (
            <Trans>This payment was reversed. It no longer counts towards the invoice.</Trans>
          ) : (
            <Trans>This payment was reversed: {reason}</Trans>
          )}
        </p>
      ) : null}
      <div className="grid gap-4 @md:grid-cols-2">
        <CustomerBlock heading={<Trans>Received from</Trans>} customer={receipt.customer} />
        <div className="flex flex-col @md:items-end @md:text-right">
          <span className={smallHeadingClassName}>
            <Trans>Amount received</Trans>
          </span>
          <span className="text-2xl font-semibold whitespace-nowrap text-foreground">
            {money(receipt.amount)}
          </span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-4 border-y border-border py-4 @lg:grid-cols-4">
        <Labelled label={<Trans>Date received</Trans>}>{formats.day(receipt.paidOn)}</Labelled>
        <Labelled label={<Trans>Method</Trans>}>{methods[receipt.method]}</Labelled>
        <Labelled label={<Trans>Reference</Trans>}>{receipt.reference ?? '—'}</Labelled>
        <Labelled label={<Trans>For invoice</Trans>}>{receipt.invoice.number}</Labelled>
      </dl>
      <dl className="grid grid-cols-2 gap-4 @lg:grid-cols-4">
        <Labelled label={<Trans>Invoice total</Trans>}>{money(receipt.invoice.total)}</Labelled>
        <Labelled label={<Trans>Balance after this payment</Trans>}>
          {money(receipt.balanceAfter)}
        </Labelled>
        <Labelled label={<Trans>Paid to date</Trans>}>{money(receipt.invoice.amountPaid)}</Labelled>
        <Labelled label={<Trans>Balance now</Trans>}>{money(receipt.invoice.balanceDue)}</Labelled>
      </dl>
      <Prose heading={<Trans>Note</Trans>} text={receipt.note} />
    </article>
  );
}
