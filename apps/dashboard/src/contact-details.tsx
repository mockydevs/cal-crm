// What the contact page shows beside the contact itself: its owner and followers, each
// email address and phone number with a phone's label, and how the contact came to be. The
// read and the way a change is sent are in contact-details-data.ts. Fetched after the page,
// part by part.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  addContactAddress,
  addContactFollowers,
  assignContactOwner,
  contactPhoneLabels,
  listTaskAssignees,
  MAX_CONTACT_FOLLOWERS,
  removeContactAddress,
  removeContactFollowers,
  updateContactAddress,
  type ContactAddress,
  type ContactAddressKind,
  type ContactPhoneLabel,
  type ContactSource,
} from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@repo/ui/components/popover';
import { Select } from '@repo/ui/components/select';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, CirclePlus, Star, Trash2 } from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState, type ReactElement } from 'react';

import { useActorLabel } from './activity';
import { apiIn } from './api';
import { useContactDetails, useDetailsChange } from './contact-details-data';
import { withEmailVerificationWords } from './email-verification/words';
import { useBusiness } from './workspace';

const AuditLog = lazy(() => import('./contact-audit-log'));
// An email row's verification badge and menu, with their words: fetched after the row.
const EmailAddressStatus = lazy(() =>
  withEmailVerificationWords(import('./email-verification/address-status')),
);

/** A blocked address's badge: what a row shows before, or without, its verification. */
function blocked(address: ContactAddress): ReactElement | null {
  return address.delivery?.status === 'blocked' ? (
    <Badge variant="attention" className="px-2 py-0.5 text-xs">
      <Trans>Blocked</Trans>
    </Badge>
  ) : null;
}

const NO_OWNER = 'none';
const FORMER = 'former';
const chipClassName =
  'inline-flex min-h-11 max-w-full items-center gap-1 rounded-full border border-input bg-card px-3 text-sm text-body hover:bg-muted lg:min-h-8';
const rowLabelClassName = 'text-sm text-muted-foreground';
/** A small icon button of a row: full size for a finger, small beside a pointer. */
const rowIconClassName =
  'flex size-11 shrink-0 items-center justify-center rounded-control text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 lg:size-7';

/** The owner and the followers, each a chip that opens the people to choose from. */
export function ContactPeople({
  contactId,
  readOnly,
}: {
  readonly contactId: string;
  readonly readOnly: boolean;
}): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const details = useContactDetails(contactId);
  const change = useDetailsChange(contactId);
  const ownerId = useId();
  const followersId = useId();
  const canManage = details.data?.canManage === true && !readOnly;
  // The people a task can be given to are the ones a contact can be, a page at a time.
  const people = useInfiniteQuery({
    queryKey: ['b', business.id, 'task-assignees'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(business.id).request(listTaskAssignees, {
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: canManage,
    staleTime: 60_000,
  });
  if (details.data === undefined) {
    return details.isError ? (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>
          <Trans>The owner and followers couldn't be loaded.</Trans>
        </p>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            void details.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    ) : null;
  }
  const { owner, followers, ownerRevision } = details.data;
  const params = { id: contactId };
  const client = apiIn(business.id);
  const team = people.data?.pages.flatMap((page) => page.items) ?? [];
  const nameOf = (person: { readonly name: string | null; readonly you: boolean }): string =>
    person.you ? t`You` : (person.name ?? t`Team member`);
  const ownerName =
    owner === null
      ? t`No owner`
      : owner.membershipId === null
        ? (owner.name ?? t`Former team member`)
        : nameOf(owner);
  const ownerMembership = owner?.membershipId ?? null;
  const ownerValue = owner === null ? NO_OWNER : (owner.membershipId ?? FORMER);
  const following = new Set(followers.map((person) => person.membershipId));
  const followerNames = followers.map(nameOf);
  const followerCount = followers.length;
  const followersText =
    followerCount === 0
      ? t`No followers`
      : followerCount === 1
        ? (followerNames[0] ?? '')
        : t`${followerCount} followers`;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* Side by side, each under its name, as GoHighLevel lays them out. */}
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span id={ownerId} className={rowLabelClassName}>
            <Trans>Owner</Trans>
          </span>
          {canManage ? (
            <Select
              aria-labelledby={ownerId}
              className="min-w-0 flex-1 rounded-full"
              disabled={change.pending}
              value={ownerValue}
              onValueChange={(next) => {
                if (next === ownerValue || next === FORMER) return;
                change.run(() =>
                  client.request(assignContactOwner, {
                    params,
                    body: { owner: next === NO_OWNER ? null : next, revision: ownerRevision },
                  }),
                );
              }}
            >
              <option value={NO_OWNER}>{t`No owner`}</option>
              {owner !== null && owner.membershipId === null ? (
                <option value={FORMER} disabled>
                  {ownerName}
                </option>
              ) : null}
              {ownerMembership !== null && !team.some((each) => each.id === ownerMembership) ? (
                <option value={ownerMembership}>{ownerName}</option>
              ) : null}
              {team.map((person) => (
                <option key={person.id} value={person.id}>
                  {nameOf(person)}
                </option>
              ))}
            </Select>
          ) : (
            <span className="min-w-0 text-sm wrap-anywhere text-body">{ownerName}</span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span id={followersId} className={rowLabelClassName}>
            <Trans>Followers</Trans>
          </span>
          {canManage ? (
            <Popover>
              <PopoverTrigger
                aria-labelledby={`${followersId} ${followersId}-value`}
                className={`${chipClassName} min-w-0 flex-1 justify-between`}
              >
                <span id={`${followersId}-value`} className="truncate">
                  {followersText}
                </span>
                <ChevronDown aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
              </PopoverTrigger>
              <PopoverContent className="w-72">
                <PopoverTitle>
                  <Trans>Followers</Trans>
                </PopoverTitle>
                <p className="text-sm text-muted-foreground">
                  <Trans>Up to {MAX_CONTACT_FOLLOWERS} people can follow a contact.</Trans>
                </p>
                {people.isPending ? (
                  <p role="status" className="text-sm">
                    <Trans>Loading people…</Trans>
                  </p>
                ) : null}
                {people.isError ? (
                  <p role="alert" className="text-sm">
                    <Trans>People couldn't be loaded.</Trans>
                  </p>
                ) : null}
                <ul className="flex max-h-64 flex-col overflow-y-auto">
                  {team.map((person) => {
                    const follows = following.has(person.id);
                    return (
                      <li key={person.id}>
                        <label className="flex min-h-11 items-center gap-2.5 text-sm lg:min-h-9">
                          <input
                            type="checkbox"
                            className="size-6 shrink-0 accent-primary lg:size-4"
                            checked={follows}
                            disabled={
                              change.pending || (!follows && followerCount >= MAX_CONTACT_FOLLOWERS)
                            }
                            onChange={() => {
                              change.run(() =>
                                client.request(
                                  follows ? removeContactFollowers : addContactFollowers,
                                  {
                                    params,
                                    body: { followers: [person.id] },
                                  },
                                ),
                              );
                            }}
                          />
                          <span className="min-w-0 wrap-anywhere">{nameOf(person)}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {people.hasNextPage ? (
                  <Button
                    variant="quiet"
                    size="small"
                    className="self-start"
                    disabled={people.isFetching}
                    onClick={() => {
                      void people.fetchNextPage();
                    }}
                  >
                    <Trans>Load more people</Trans>
                  </Button>
                ) : null}
              </PopoverContent>
            </Popover>
          ) : (
            <span className="min-w-0 text-sm wrap-anywhere text-body">
              {followerCount === 0 ? t`No followers` : followerNames.join(', ')}
            </span>
          )}
        </div>
      </div>
      {change.problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {change.problem}
        </p>
      )}
    </div>
  );
}

const NO_LABEL = 'none';

/**
 * The contact's email addresses or phone numbers, one a row: which is the primary, a phone
 * number's label, an address a send has found undeliverable or an email's verification, and,
 * for someone who may change the contact, the ways to label one, make it the primary, check,
 * exclude or block an email, remove it or add another.
 */
export function ContactAddresses({
  contactId,
  kind,
  readOnly,
}: {
  readonly contactId: string;
  readonly kind: ContactAddressKind;
  readonly readOnly: boolean;
}): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const details = useContactDetails(contactId);
  const change = useDetailsChange(contactId);
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  // The keyboard goes back to the Add button when the form it opened closes.
  const focusAddRef = useRef(false);
  if (details.data === undefined) return null;
  const client = apiIn(business.id);
  const canManage = details.data.canManage && !readOnly;
  const addresses = details.data.addresses.filter((each) => each.kind === kind);
  const revision = details.data.addressesRevision;
  const email = kind === 'email';
  const labelNames: Readonly<Record<ContactPhoneLabel, string>> = {
    home: t`Home`,
    work: t`Work`,
    mobile: t`Mobile`,
    landline: t`Landline`,
  };
  const taken = (address: ContactAddress): readonly ContactPhoneLabel[] =>
    addresses.flatMap((each) =>
      each.id === address.id || each.label === null ? [] : [each.label],
    );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul className="flex min-w-0 flex-col gap-2">
        {addresses.map((address) => {
          const shown = address.display;
          return (
            <li key={address.id} className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href={email ? `mailto:${address.value}` : `tel:${address.value}`}
                  className="min-w-0 font-medium break-all text-link underline-offset-2 hover:underline"
                >
                  {shown}
                </a>
                {address.primary && addresses.length > 1 ? (
                  <Badge variant="neutral" className="px-2 py-0.5 text-xs">
                    <Trans>Primary</Trans>
                  </Badge>
                ) : null}
                {!canManage && address.label !== null ? (
                  <Badge variant="neutral" className="px-2 py-0.5 text-xs">
                    {labelNames[address.label]}
                  </Badge>
                ) : null}
                {email ? (
                  <Suspense fallback={blocked(address)}>
                    <EmailAddressStatus
                      contactId={contactId}
                      address={address}
                      canManage={canManage}
                    />
                  </Suspense>
                ) : (
                  blocked(address)
                )}
              </span>
              {canManage ? (
                <span className="ml-auto flex min-w-0 flex-wrap items-center gap-0.5">
                  {email ? null : (
                    <Select
                      aria-label={t`Label for ${shown}`}
                      className="w-28 lg:min-h-7 lg:text-sm"
                      disabled={change.pending}
                      value={address.label ?? NO_LABEL}
                      onValueChange={(next) => {
                        const label = contactPhoneLabels.find((each) => each === next) ?? null;
                        if (label === address.label) return;
                        change.run(() =>
                          client.request(updateContactAddress, {
                            params: { id: contactId, addressId: address.id },
                            body: { label, revision },
                          }),
                        );
                      }}
                    >
                      <option value={NO_LABEL}>{t`No label`}</option>
                      {contactPhoneLabels.map((label) => (
                        <option key={label} value={label} disabled={taken(address).includes(label)}>
                          {labelNames[label]}
                        </option>
                      ))}
                    </Select>
                  )}
                  {address.primary ? null : (
                    <button
                      type="button"
                      className={rowIconClassName}
                      aria-label={t`Make ${shown} the primary`}
                      title={t`Make primary`}
                      disabled={change.pending}
                      onClick={() => {
                        change.run(() =>
                          client.request(updateContactAddress, {
                            params: { id: contactId, addressId: address.id },
                            body: { primary: true, revision },
                          }),
                        );
                      }}
                    >
                      <Star aria-hidden className="size-4" strokeWidth={1.8} />
                    </button>
                  )}
                  <button
                    type="button"
                    className={rowIconClassName}
                    aria-label={t`Remove ${shown}`}
                    title={t`Remove ${shown}`}
                    disabled={change.pending}
                    onClick={() => {
                      change.run(() =>
                        client.request(removeContactAddress, {
                          params: { id: contactId, addressId: address.id },
                          body: { revision },
                        }),
                      );
                    }}
                  >
                    <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                  </button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!canManage ? null : adding ? (
        <form
          className="flex min-w-0 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim() === '' || change.pending) return;
            change.run(async () => {
              const saved = await client.request(addContactAddress, {
                params: { id: contactId },
                body: { kind, value },
              });
              setValue('');
              focusAddRef.current = true;
              setAdding(false);
              return saved;
            });
          }}
        >
          <Input
            // The form opens in place of the button that was pressed.
            ref={(element) => {
              element?.focus();
            }}
            type={email ? 'email' : 'tel'}
            autoComplete="off"
            maxLength={email ? 320 : 40}
            className="min-w-0 flex-1 basis-40"
            aria-label={email ? t`New email address` : t`New phone number`}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
          <Button type="submit" size="small" disabled={change.pending || value.trim() === ''}>
            <Trans>Add</Trans>
          </Button>
          <Button
            variant="quiet"
            size="small"
            onClick={() => {
              focusAddRef.current = true;
              setAdding(false);
              setValue('');
              change.clear();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </form>
      ) : (
        // Beside the row's name, top right: the row is the positioned box (contact-fields.tsx).
        <button
          ref={(element) => {
            if (element !== null && focusAddRef.current) {
              focusAddRef.current = false;
              element.focus();
            }
          }}
          type="button"
          className={`${rowIconClassName} absolute -top-3 right-0 text-link lg:-top-1`}
          aria-label={email ? t`Add email` : t`Add phone`}
          title={email ? t`Add email` : t`Add phone`}
          disabled={addresses.length >= 10}
          onClick={() => {
            setAdding(true);
          }}
        >
          <CirclePlus aria-hidden className="size-[18px]" strokeWidth={1.8} />
        </button>
      )}
      {change.problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {change.problem}
        </p>
      )}
    </div>
  );
}

/** "Created by" and "Created on" at the foot of the left pane, and the way to the audit log. */
export function ContactOrigin({
  contactId,
  createdAt,
}: {
  readonly contactId: string;
  /** From the contact itself, so the line shows before the details arrive. */
  readonly createdAt: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  const details = useContactDetails(contactId).data;
  const actorLabel = useActorLabel();
  const [auditOpen, setAuditOpen] = useState(false);
  const auditRef = useRef<HTMLButtonElement>(null);
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const created = dates.format(new Date(createdAt));
  const sources: Readonly<Record<ContactSource, string | undefined>> = {
    user: t`in the app`,
    api: t`through the API`,
    form: t`from a form`,
    booking: t`from a booking`,
    import: t`from an import`,
    email: t`from an email they sent`,
    sms: t`from a text message they sent`,
    webchat: t`from a web chat`,
    automation: t`by an automation`,
    assistant: t`by the assistant`,
    unknown: undefined,
  };
  const by = details === undefined ? undefined : actorLabel(details.createdBy);
  const source = details === undefined ? undefined : sources[details.createdSource];
  return (
    <div className="mt-auto flex min-w-0 flex-col gap-1 pt-1 text-xs text-muted-foreground">
      {by === undefined ? null : (
        <p className="wrap-anywhere">
          {source === undefined ? (
            <Trans>Created by {by}</Trans>
          ) : (
            <Trans>
              Created by {by}, {source}
            </Trans>
          )}
        </p>
      )}
      <p>
        <Trans>
          Created on <time dateTime={createdAt}>{created}</time>
        </Trans>
      </p>
      {details?.canReadAudit === true ? (
        <>
          <Button
            ref={auditRef}
            variant="secondary"
            size="small"
            className="mt-1 w-full rounded lg:min-h-7"
            onClick={() => {
              setAuditOpen(true);
            }}
          >
            <Trans>Audit logs</Trans>
          </Button>
          {auditOpen ? (
            <Suspense fallback={null}>
              <AuditLog
                recordId={contactId}
                returnFocus={auditRef}
                onClose={() => {
                  setAuditOpen(false);
                }}
              />
            </Suspense>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
