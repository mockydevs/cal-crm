// The box that finds a contact for an opportunity: the server searches by name, email
// address or phone number, and the one chosen is handed over. On its own so the contact
// contracts arrive only when someone may change an opportunity's contacts.
import { Trans, useLingui } from '@lingui/react/macro';
import { listContacts } from '@repo/contracts';
import { Input } from '@repo/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { apiIn } from './api';
import { useSettled } from './settings-list';

/** A contact someone can pick: its id and what to call it. */
export interface PickedContact {
  readonly id: string;
  readonly name: string;
}

/**
 * Finds a contact by name, email address or phone number and hands over the one chosen.
 * The server searches; nothing is listed until two characters are typed.
 */
export default function ContactSearch({
  businessId,
  label,
  excluded,
  disabled,
  onPick,
}: {
  readonly businessId: string;
  /** What the box is for, such as "Search for a primary contact". */
  readonly label: string;
  /** Contacts that are already with the opportunity, and so are not offered. */
  readonly excluded: readonly string[];
  readonly disabled: boolean;
  readonly onPick: (contact: PickedContact) => void;
}): ReactElement {
  const { t } = useLingui();
  const [typed, setTyped] = useState('');
  const q = useSettled(typed.trim());
  const asking = q.length >= 2;
  const found = useQuery({
    queryKey: ['b', businessId, 'deal-contact-search', q],
    queryFn: () => apiIn(businessId).request(listContacts, { query: { q, limit: 8 } }),
    enabled: asking,
    staleTime: 30_000,
  });
  const offered = (found.data?.items ?? []).filter((each) => !excluded.includes(each.id));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Input
        type="search"
        autoComplete="off"
        maxLength={200}
        aria-label={label}
        placeholder={label}
        value={typed}
        disabled={disabled}
        onChange={(event) => {
          setTyped(event.target.value);
        }}
      />
      {!asking || typed.trim() !== q ? null : found.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Searching contacts…</Trans>
        </p>
      ) : found.isError ? (
        <p role="alert" className="text-sm">
          <Trans>The contacts couldn't be searched. Try again.</Trans>
        </p>
      ) : offered.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>No other contact matches.</Trans>
        </p>
      ) : (
        <ul
          aria-label={t`Matching contacts`}
          className="flex max-h-56 flex-col overflow-y-auto rounded-control border border-border"
        >
          {offered.map((each) => {
            const name = each.name ?? each.email ?? each.phone?.display ?? t`Unnamed contact`;
            const detail = each.name === null ? undefined : (each.email ?? undefined);
            return (
              <li key={each.id}>
                <button
                  type="button"
                  disabled={disabled}
                  className="flex min-h-11 w-full min-w-0 flex-col justify-center px-3 py-1 text-left text-sm -outline-offset-2 hover:bg-muted lg:min-h-9"
                  onClick={() => {
                    setTyped('');
                    onPick({ id: each.id, name });
                  }}
                >
                  <span className="wrap-anywhere text-foreground">{name}</span>
                  {detail === undefined ? null : (
                    <span className="text-xs wrap-anywhere text-muted-foreground">{detail}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
