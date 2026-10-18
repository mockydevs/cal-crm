// What the Payments pages share on screen: the chip of a status, a small grey label above
// its value, the foot of a list that is walked a page at a time, and the reads every page
// makes (the business profile for the name, address, logo and currency; the settings).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createFileLink,
  getBusinessProfile,
  getCommerceSettings,
  type BusinessProfile,
  type CommerceSettings,
  type PaymentMethod,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { apiIn } from './api';
import {
  documentMark,
  formatDay,
  formatMoney,
  formatPercent,
  type DocumentMark,
  type Tone,
} from './payments-rules';
import { retryFaults } from './settings-list';
import { useBusiness } from './workspace';

const neutralClassName = 'bg-secondary text-secondary-foreground';
const infoClassName = 'bg-accent text-link';
const successClassName = 'border border-success-line bg-success-subtle text-success';
const warningClassName = 'bg-attention text-attention-foreground';
const dangerClassName = 'border border-destructive bg-card text-destructive';
const toneClassName: Readonly<Record<Tone, string>> = {
  neutral: neutralClassName,
  info: infoClassName,
  success: successClassName,
  warning: warningClassName,
  danger: dangerClassName,
};

/** A small coloured pill: a status, a kind. */
export function Chip({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${toneClassName[tone]}`}
    >
      {children}
    </span>
  );
}

/** What each status is called, and the two that are read from dates. */
export function useMarkNames(): Readonly<Record<DocumentMark | 'all', string>> {
  const { t } = useLingui();
  return {
    all: t`All`,
    draft: t`Draft`,
    sent: t`Sent`,
    accepted: t`Accepted`,
    declined: t`Declined`,
    partly_paid: t`Partly paid`,
    paid: t`Paid`,
    void: t`Void`,
    overdue: t`Overdue`,
    expired: t`Expired`,
  };
}

/** The status of a quote or an invoice as a chip; overdue and expired in their own colours. */
export function DocumentChip({
  document,
}: {
  readonly document: Parameters<typeof documentMark>[0];
}): ReactElement {
  const names = useMarkNames();
  const { mark, tone } = documentMark(document);
  return <Chip tone={tone}>{names[mark]}</Chip>;
}

export function usePaymentMethodNames(): Readonly<Record<PaymentMethod, string>> {
  const { t } = useLingui();
  return {
    cash: t`Cash`,
    bank_transfer: t`Bank transfer`,
    mobile_money: t`Mobile money`,
    card: t`Card`,
    cheque: t`Cheque`,
    other: t`Other`,
  };
}

/** How amounts, rates and days are written for the person reading. */
export function useFormats(): {
  readonly money: (amount: string, currency: string) => string;
  readonly percent: (rate: string) => string;
  readonly day: (date: string) => string;
} {
  const { i18n } = useLingui();
  const locale = i18n.locale;
  return {
    money: (amount, currency) => formatMoney(amount, currency, locale),
    percent: (rate) => formatPercent(rate, locale),
    day: (date) => formatDay(date, locale),
  };
}

/** A small grey label above its value. */
export function Labelled({
  label,
  children,
  className = '',
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${className}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-semibold wrap-anywhere text-foreground">{children}</dd>
    </div>
  );
}

/** The one line under a page's title that says what the page is for. */
export function PageIntro({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="-mt-3 text-md text-muted-foreground">{children}</p>;
}

/** What a page says to someone the server refuses: the lists need permission to see payments. */
export function Refused(): ReactElement {
  return (
    <p role="alert" className="text-sm font-medium text-destructive">
      <Trans>You don't have permission to see this business's payments.</Trans>
    </p>
  );
}

/** What is said where a page shows what cannot be changed by the person looking. */
export function ReadOnlyNote({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="text-md text-muted-foreground">{children}</p>;
}

/**
 * The foot of a list the server pages with a cursor and no count: the page showing, and the
 * way to the pages before and after.
 */
export function Pager({
  number,
  previous,
  next,
  busy,
  onPrevious,
  onNext,
}: {
  /** The page showing, from 1. */
  readonly number: number;
  readonly previous: boolean;
  readonly next: boolean;
  readonly busy: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}): ReactElement | null {
  const { t } = useLingui();
  if (!previous && !next) return null;
  return (
    <nav
      aria-label={t`Pages`}
      className="flex flex-wrap items-center justify-end gap-2 text-sm text-body"
    >
      <Button
        variant="quiet"
        size="small"
        aria-label={t`Previous page`}
        disabled={!previous || busy}
        onClick={onPrevious}
      >
        <Trans>Previous</Trans>
      </Button>
      <p role="status" aria-busy={busy}>
        <Trans>Page {number}</Trans>
      </p>
      <Button
        variant="quiet"
        size="small"
        aria-label={t`Next page`}
        disabled={!next || busy}
        onClick={onNext}
      >
        <Trans>Next</Trans>
      </Button>
    </nav>
  );
}

/** The business profile: its name, address, logo and currency. Shared with its own page. */
export function useProfile(): UseQueryResult<BusinessProfile, unknown> {
  const business = useBusiness();
  return useQuery({
    queryKey: ['business-profile', business.id],
    queryFn: () => apiIn(business.id).request(getBusinessProfile, {}),
    staleTime: 60_000,
    retry: retryFaults,
  });
}

export const settingsKey = (businessId: string): readonly string[] => [
  'b',
  businessId,
  'payments',
  'settings',
];

/** How the business numbers and words its documents. */
export function useCommerceSettings(enabled = true): UseQueryResult<CommerceSettings, unknown> {
  const business = useBusiness();
  return useQuery({
    queryKey: settingsKey(business.id),
    queryFn: () => apiIn(business.id).request(getCommerceSettings, {}),
    enabled,
    retry: retryFaults,
  });
}

/** A link that shows a logo for the next hour, or undefined while there is none to show. */
export function useLogoUrl(fileId: string | null): string | undefined {
  const business = useBusiness();
  const link = useQuery({
    queryKey: ['business-logo', business.id, fileId],
    queryFn: () =>
      apiIn(business.id).request(createFileLink, {
        params: { id: fileId ?? '' },
        body: { expiresIn: 3600 },
      }),
    enabled: fileId !== null,
    staleTime: 30 * 60 * 1000,
    retry: retryFaults,
  });
  return fileId === null ? undefined : link.data?.url;
}

/** The link style of a row's name or number. */
export const rowLinkClassName =
  'font-medium text-link underline-offset-2 wrap-anywhere hover:underline';

/** A row of filter chips: the one the list is narrowed to is pressed. */
export function FilterChips<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly value: Value;
  readonly onChange: (value: Value) => void;
}): ReactElement {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-1.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className="inline-flex min-h-11 items-center rounded-full border border-input bg-card px-3 text-[13px] font-medium text-body -outline-offset-2 hover:bg-muted aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-link lg:min-h-8"
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
