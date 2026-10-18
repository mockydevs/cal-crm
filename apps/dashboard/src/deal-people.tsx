// Who an opportunity is with and whose it is, in its dialog: the primary contact with its
// email and phone, the additional contacts (at most ten), the owner, the followers, who
// made the opportunity and the way to its audit log. Each change is saved as it is made, by
// its own request, and the answer replaces what is shown (deal-people-data.ts). Fetched
// after the dialog's form.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  addDealFollowers,
  assignDealOwner,
  listTaskAssignees,
  MAX_CONTACT_FOLLOWERS,
  MAX_DEAL_ADDITIONAL_CONTACTS,
  removeDealFollowers,
  setDealContacts,
  type DealContact,
} from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactElement } from 'react';

import { useActorLabel } from './activity';
import { apiIn } from './api';
import { useDealDetails, useDealDetailsChange } from './deal-people-data';
import { contactsAfter, type DealContacts } from './deal-people-rules';

const AuditLog = lazy(() => import('./contact-audit-log'));
const ContactSearch = lazy(() => import('./deal-contact-search'));

const NO_OWNER = 'none';
const FORMER = 'former';
const chipClassName =
  'inline-flex min-h-11 max-w-full items-center gap-1 rounded-full border border-input bg-card px-3 text-sm text-body hover:bg-muted lg:min-h-9';
const groupTitleClassName = 'text-sm font-medium text-foreground';
const labelClassName = 'text-sm font-medium';

function ContactLine({ contact }: { readonly contact: DealContact }): ReactElement {
  const { t } = useLingui();
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
        <span className="wrap-anywhere">{contact.name ?? t`Unnamed contact`}</span>
        {contact.trashed ? (
          <Badge variant="attention" className="px-2 py-0.5 text-xs">
            <Trans>In the trash</Trans>
          </Badge>
        ) : null}
      </span>
      {contact.email === null && contact.phone === null ? null : (
        <span className="text-xs wrap-anywhere text-muted-foreground">
          {[contact.email, contact.phone?.display]
            .filter((each) => each !== null && each !== undefined)
            .join(' · ')}
        </span>
      )}
    </span>
  );
}

export default function DealPeople({
  businessId,
  dealId,
  readOnly,
  onPendingChange,
}: {
  readonly businessId: string;
  readonly dealId: string;
  /** An opportunity in the trash, or one the reader may not change. */
  readonly readOnly: boolean;
  /** Whether a change is being saved: the opportunity's own form waits for it. */
  readonly onPendingChange: (pending: boolean) => void;
}): ReactElement | null {
  const { t } = useLingui();
  const details = useDealDetails(businessId, dealId);
  const change = useDealDetailsChange(businessId, dealId);
  const actorLabel = useActorLabel();
  const ownerId = useId();
  const followersId = useId();
  const [auditOpen, setAuditOpen] = useState(false);
  // The people to follow open in place: a popover would sit under the dialog this is in.
  const [followersOpen, setFollowersOpen] = useState(false);
  const auditRef = useRef<HTMLButtonElement>(null);
  const canManage = details.data?.canManage === true && !readOnly;
  const pending = change.pending;
  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);
  // The people a task can be given to are the ones an opportunity can be, a page at a time.
  const people = useInfiniteQuery({
    queryKey: ['b', businessId, 'task-assignees'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(businessId).request(listTaskAssignees, {
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
          <Trans>The contacts, owner and followers couldn't be loaded.</Trans>
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
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading contacts and owner…</Trans>
      </p>
    );
  }
  const { owner, followers, ownerRevision, primaryContact, additionalContacts, contactsRevision } =
    details.data;
  const client = apiIn(businessId);
  const params = { id: dealId };
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
  const linked: DealContacts = {
    primary: primaryContact?.id ?? null,
    additional: additionalContacts.map((each) => each.id),
  };
  const saveContacts = (next: DealContacts): void => {
    change.run(() =>
      client.request(setDealContacts, {
        params,
        body: {
          primaryContactId: next.primary,
          additionalContactIds: [...next.additional],
          revision: contactsRevision,
        },
      }),
    );
  };
  const everyContact = [...(linked.primary === null ? [] : [linked.primary]), ...linked.additional];
  const additionalFull = additionalContacts.length >= MAX_DEAL_ADDITIONAL_CONTACTS;
  const by = actorLabel(details.data.createdBy);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section aria-label={t`Contact details`} className="flex min-w-0 flex-col gap-3">
        <h3 className={groupTitleClassName}>
          <Trans>Contact details</Trans>
        </h3>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClassName}>
            <Trans>Primary contact</Trans>
          </span>
          {primaryContact === null ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No primary contact.</Trans>
            </p>
          ) : (
            <div className="flex min-w-0 items-center gap-2 rounded-control border border-border px-3 py-1.5">
              <ContactLine contact={primaryContact} />
              {canManage ? (
                <Button
                  variant="quiet"
                  size="small"
                  className="shrink-0 px-2.5"
                  aria-label={t`Remove the primary contact`}
                  disabled={pending}
                  onClick={() => {
                    saveContacts(contactsAfter(linked, { kind: 'remove', id: primaryContact.id }));
                  }}
                >
                  <X aria-hidden className="size-4" strokeWidth={1.8} />
                </Button>
              ) : null}
            </div>
          )}
          {canManage ? (
            <Suspense fallback={null}>
              <ContactSearch
                businessId={businessId}
                label={
                  primaryContact === null
                    ? t`Search for a primary contact`
                    : t`Search for another primary contact`
                }
                excluded={linked.primary === null ? [] : [linked.primary]}
                disabled={pending}
                onPick={(contact) => {
                  saveContacts(contactsAfter(linked, { kind: 'primary', id: contact.id }));
                }}
              />
            </Suspense>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClassName}>
            <Trans>Additional contacts (Max: {MAX_DEAL_ADDITIONAL_CONTACTS})</Trans>
          </span>
          {additionalContacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No additional contacts.</Trans>
            </p>
          ) : (
            <ul aria-label={t`Additional contacts`} className="flex min-w-0 flex-col gap-1.5">
              {additionalContacts.map((contact) => {
                const name = contact.name ?? t`Unnamed contact`;
                return (
                  <li
                    key={contact.id}
                    className="flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-border px-3 py-1.5"
                  >
                    <ContactLine contact={contact} />
                    {canManage ? (
                      <>
                        <Button
                          variant="quiet"
                          size="small"
                          className="shrink-0"
                          aria-label={t`Make ${name} the primary contact`}
                          disabled={pending || contact.trashed}
                          onClick={() => {
                            saveContacts(
                              contactsAfter(linked, { kind: 'primary', id: contact.id }),
                            );
                          }}
                        >
                          <Trans>Make primary</Trans>
                        </Button>
                        <Button
                          variant="quiet"
                          size="small"
                          className="shrink-0 px-2.5"
                          aria-label={t`Remove ${name}`}
                          disabled={pending}
                          onClick={() => {
                            saveContacts(contactsAfter(linked, { kind: 'remove', id: contact.id }));
                          }}
                        >
                          <X aria-hidden className="size-4" strokeWidth={1.8} />
                        </Button>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {!canManage ? null : additionalFull ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Remove a contact to add another.</Trans>
            </p>
          ) : (
            <Suspense fallback={null}>
              <ContactSearch
                businessId={businessId}
                label={t`Search for an additional contact`}
                excluded={everyContact}
                disabled={pending}
                onPick={(contact) => {
                  saveContacts(contactsAfter(linked, { kind: 'add', id: contact.id }));
                }}
              />
            </Suspense>
          )}
        </div>
      </section>
      <section aria-label={t`Owner and followers`} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id={ownerId} className={labelClassName}>
            <Trans>Owner</Trans>
          </span>
          {canManage ? (
            <Select
              aria-labelledby={ownerId}
              disabled={pending}
              value={ownerValue}
              onValueChange={(next) => {
                if (next === ownerValue || next === FORMER) return;
                change.run(() =>
                  client.request(assignDealOwner, {
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
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id={followersId} className={labelClassName}>
            <Trans>Followers</Trans>
          </span>
          {canManage ? (
            <>
              <button
                type="button"
                aria-labelledby={`${followersId} ${followersId}-value`}
                aria-expanded={followersOpen}
                aria-controls={followersOpen ? `${followersId}-list` : undefined}
                className={`${chipClassName} justify-between rounded-control`}
                onClick={() => {
                  setFollowersOpen(!followersOpen);
                }}
              >
                <span id={`${followersId}-value`} className="truncate">
                  {followersText}
                </span>
                <ChevronDown aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
              </button>
              {followersOpen ? (
                <div
                  id={`${followersId}-list`}
                  role="group"
                  aria-labelledby={followersId}
                  className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border p-3"
                >
                  <p className="text-sm text-muted-foreground">
                    <Trans>Up to {MAX_CONTACT_FOLLOWERS} people can follow an opportunity.</Trans>
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
                              className="size-4 shrink-0 accent-primary"
                              checked={follows}
                              disabled={
                                pending || (!follows && followerCount >= MAX_CONTACT_FOLLOWERS)
                              }
                              onChange={() => {
                                change.run(() =>
                                  client.request(follows ? removeDealFollowers : addDealFollowers, {
                                    params,
                                    body: { followers: [person.id] },
                                  }),
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
                </div>
              ) : null}
            </>
          ) : (
            <span className="min-w-0 text-sm wrap-anywhere text-body">
              {followerCount === 0 ? t`No followers` : followerNames.join(', ')}
            </span>
          )}
        </div>
      </section>
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {pending ? t`Saving…` : null}
      </p>
      {change.problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {change.problem}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        <p className="wrap-anywhere">
          <Trans>Created by {by}</Trans>
        </p>
        {details.data.canReadAudit ? (
          <>
            <Button
              ref={auditRef}
              variant="secondary"
              size="small"
              onClick={() => {
                setAuditOpen(true);
              }}
            >
              <Trans>Audit logs</Trans>
            </Button>
            {auditOpen ? (
              <Suspense fallback={null}>
                <AuditLog
                  recordId={dealId}
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
    </div>
  );
}
