// Who a quote or an invoice is for: the box that finds the contact, and the choice of one
// of that contact's opportunities. In a file of their own, fetched when the form first
// draws them, so the contact and opportunity contracts stay out of the form's own code.
import { Trans, useLingui } from '@lingui/react/macro';
import { getContact, listContactDeals } from '@repo/contracts';
import { Select } from '@repo/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactElement } from 'react';
import { apiIn } from './api';
import { contactTitle } from './contact-title';
import ContactSearch, { type PickedContact } from './deal-contact-search';
import { retryFaults } from './settings-list';

const NONE = 'none';

/**
 * Finds the contact. Started from a contact's page, the address names who it is for: that
 * contact is read and handed over, and the box is there if they cannot be.
 */
export default function ContactBox({
  businessId,
  prefillId,
  disabled,
  onPick,
}: {
  readonly businessId: string;
  /** The contact the address names, until it has been handed over. */
  readonly prefillId: string | undefined;
  readonly disabled: boolean;
  readonly onPick: (contact: PickedContact) => void;
}): ReactElement {
  const { t } = useLingui();
  const named = useQuery({
    queryKey: ['b', businessId, 'payments', 'prefill-contact', prefillId],
    queryFn: () => apiIn(businessId).request(getContact, { params: { id: prefillId ?? '' } }),
    enabled: prefillId !== undefined,
    retry: retryFaults,
  });
  const found = named.data;
  // Handed over once, when the contact arrives, to whatever the form then listens with.
  const pickRef = useRef(onPick);
  useEffect(() => {
    pickRef.current = onPick;
  });
  useEffect(() => {
    if (found !== undefined) pickRef.current({ id: found.id, name: contactTitle(found) ?? '' });
  }, [found]);
  if (prefillId !== undefined && named.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading the contact…</Trans>
      </p>
    );
  return (
    <ContactSearch
      businessId={businessId}
      label={t`Search for a contact`}
      excluded={[]}
      disabled={disabled}
      onPick={onPick}
    />
  );
}

/** The opportunity the document belongs to, among the ones its contact is with; or none. */
export function OpportunitySelect({
  businessId,
  contactId,
  value,
  onChange,
}: {
  readonly businessId: string;
  readonly contactId: string;
  readonly value: string | null;
  readonly onChange: (dealId: string | null) => void;
}): ReactElement | null {
  const { t } = useLingui();
  const deals = useQuery({
    queryKey: ['b', businessId, 'contact-deals', contactId],
    queryFn: () =>
      apiIn(businessId).request(listContactDeals, { params: { id: contactId }, query: {} }),
    retry: retryFaults,
  });
  const items = deals.data?.items ?? [];
  // Someone who may not see opportunities, or a contact with none, is asked nothing.
  if (items.length === 0 && value === null) return null;
  const listed = items.some((each) => each.deal.id === value);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        <Trans>Opportunity (optional)</Trans>
      </span>
      <Select
        aria-label={t`Opportunity`}
        value={value ?? NONE}
        onValueChange={(next) => {
          onChange(next === NONE ? null : next);
        }}
      >
        <option value={NONE}>{t`No opportunity`}</option>
        {value === null || listed ? null : (
          <option value={value}>{t`The opportunity it is linked to`}</option>
        )}
        {items.map(({ deal }) => (
          <option key={deal.id} value={deal.id}>
            {deal.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
