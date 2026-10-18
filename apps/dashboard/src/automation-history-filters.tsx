// The filters the Enrollment history and the Execution logs share: a range of days, and one
// contact, found by name. The lists themselves take a record's id, so the name is looked up
// in the contacts the business has and the id of the one chosen is what is sent.
import { Trans, useLingui } from '@lingui/react/macro';
import { Input } from '@repo/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import { useSettled } from './list-table';
import { useBusiness } from './workspace';

export interface DayRange {
  /** Calendar days as a date box holds them, such as 2026-10-06; empty for an open side. */
  readonly first: string;
  readonly last: string;
}

export const anyDay: DayRange = { first: '', last: '' };

export function DayRangeFilter({
  value,
  onChange,
}: {
  readonly value: DayRange;
  readonly onChange: (range: DayRange) => void;
}): ReactElement {
  const { t } = useLingui();
  const firstId = useId();
  const lastId = useId();
  return (
    <div role="group" aria-label={t`Date range`} className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-xs font-medium text-body" htmlFor={firstId}>
          <Trans>From</Trans>
        </label>
        <Input
          id={firstId}
          type="date"
          className="w-40"
          max={value.last === '' ? undefined : value.last}
          value={value.first}
          onChange={(event) => {
            onChange({ ...value, first: event.target.value });
          }}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-xs font-medium text-body" htmlFor={lastId}>
          <Trans>To</Trans>
        </label>
        <Input
          id={lastId}
          type="date"
          className="w-40"
          min={value.first === '' ? undefined : value.first}
          value={value.last}
          onChange={(event) => {
            onChange({ ...value, last: event.target.value });
          }}
        />
      </div>
    </div>
  );
}

export interface RecordChoice {
  readonly id: string;
  readonly name: string;
}

/** One contact to narrow a list to: typed by name, chosen from those the business has. */
export function RecordFilter({
  value,
  label,
  clearLabel,
  onChange,
}: {
  readonly value: RecordChoice | undefined;
  /** What the box is called, where a page has more than one: "Search contacts" otherwise. */
  readonly label?: string | undefined;
  /** What the button that takes the contact away is called. */
  readonly clearLabel?: string | undefined;
  readonly onChange: (record: RecordChoice | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const searchId = useId();
  const [typed, setTyped] = useState('');
  const q = useSettled(typed).trim();
  const found = useQuery({
    queryKey: ['b', business.id, 'automation-contact-search', q],
    queryFn: async () => {
      const { searchContacts } = await import('./automation-contact-search');
      return searchContacts(business.id, q);
    },
    enabled: value === undefined && q !== '',
  });
  if (value !== undefined) {
    const { name } = value;
    return (
      <span className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-control border border-input bg-card pr-1 pl-3 text-sm lg:min-h-9">
        <span className="min-w-0 truncate">
          <Trans>Contact: {name}</Trans>
        </span>
        <button
          type="button"
          aria-label={clearLabel ?? t`Show every contact again`}
          className="flex size-9 shrink-0 items-center justify-center rounded-control text-body hover:bg-secondary hover:text-foreground lg:size-7"
          onClick={() => {
            setTyped('');
            onChange(undefined);
          }}
        >
          <X aria-hidden className="size-4" strokeWidth={1.8} />
        </button>
      </span>
    );
  }
  const contacts = (found.data?.items ?? []).slice(0, 8);
  return (
    <div className="relative min-w-0 flex-1 basis-48 sm:max-w-64">
      <label htmlFor={searchId} className="sr-only">
        {label ?? <Trans>Search contacts</Trans>}
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        strokeWidth={1.8}
      />
      <Input
        id={searchId}
        type="search"
        autoComplete="off"
        maxLength={120}
        placeholder={label ?? t`Search contacts`}
        value={typed}
        className="pl-9"
        onChange={(event) => {
          setTyped(event.target.value);
        }}
      />
      {q === '' ? null : (
        <div className="absolute top-full right-0 left-0 z-30 mt-1 flex max-h-72 flex-col overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-xl">
          {found.isPending ? (
            <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
              <Trans>Searching…</Trans>
            </p>
          ) : found.isError ? (
            <p role="alert" className="px-3 py-2 text-sm text-destructive">
              <Trans>The contacts couldn't be searched.</Trans>
            </p>
          ) : contacts.length === 0 ? (
            <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
              <Trans>No contacts match.</Trans>
            </p>
          ) : (
            <ul aria-label={t`Contacts found`} className="flex flex-col">
              {contacts.map((contact) => {
                const name = contact.name ?? contact.email ?? t`Unnamed`;
                return (
                  <li key={contact.id}>
                    <button
                      type="button"
                      className="flex min-h-11 w-full min-w-0 flex-col justify-center rounded-control px-3 py-1 text-left text-sm -outline-offset-2 hover:bg-muted lg:min-h-9"
                      onClick={() => {
                        onChange({ id: contact.id, name });
                      }}
                    >
                      <span className="truncate font-medium text-foreground">{name}</span>
                      {contact.name === null || contact.email === null ? null : (
                        <span className="truncate text-xs text-muted-foreground">
                          {contact.email}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
