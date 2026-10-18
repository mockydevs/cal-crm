// An opportunity's quotes and invoices in its dialog, folded away under the details until
// asked for: the list, with its statuses and totals, and the way to start a quote or an
// invoice for the opportunity's primary contact. The list and the Payments code it needs
// are fetched when it is first unfolded.
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { lazy, Suspense, useId, useState, type ReactElement } from 'react';
import { useDealDetails } from './deal-people-data';

const Documents = lazy(async () => ({
  default: (await import('./contact-documents')).DealDocuments,
}));

function Unfolded({
  businessId,
  dealId,
  readOnly,
}: {
  readonly businessId: string;
  readonly dealId: string;
  readonly readOnly: boolean;
}): ReactElement {
  // The same read the dialog's contacts make: who the opportunity is with.
  const details = useDealDetails(businessId, dealId);
  if (details.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading quotes and invoices…</Trans>
      </p>
    );
  const primary = details.data?.primaryContact ?? null;
  return (
    <Documents
      dealId={dealId}
      primaryContactId={primary?.id ?? null}
      // Nothing is started for a contact in the trash, or while who it is with is not known.
      readOnly={readOnly || details.isError || primary?.trashed === true}
    />
  );
}

export function DealDocumentsSection({
  businessId,
  dealId,
  readOnly,
}: {
  readonly businessId: string;
  readonly dealId: string;
  /** True for an opportunity in the trash, or one the reader may not change. */
  readonly readOnly: boolean;
}): ReactElement {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <section
      aria-label={t`Quotes and invoices`}
      className="min-w-0 overflow-clip rounded-lg border border-border bg-card"
    >
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          className="flex min-h-11 w-full items-center justify-between gap-2 px-3.5 text-left text-sm font-medium -outline-offset-2 hover:bg-muted"
          onClick={() => {
            setOpen(!open);
          }}
        >
          <Trans>Quotes and invoices</Trans>
          <Chevron aria-hidden className="size-4 shrink-0" strokeWidth={2} />
        </button>
      </h3>
      {open ? (
        <div id={bodyId} className="border-t border-border p-3.5">
          <Suspense
            fallback={
              <p role="status" className="text-sm text-muted-foreground">
                <Trans>Loading quotes and invoices…</Trans>
              </p>
            }
          >
            <Unfolded businessId={businessId} dealId={dealId} readOnly={readOnly} />
          </Suspense>
        </div>
      ) : null}
    </section>
  );
}
