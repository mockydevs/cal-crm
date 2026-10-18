// Contacts → ⋯ → Manage Duplicates, as GoHighLevel lays it out: "Find by" Email (the
// default), Phone or Name; the groups found, a card each; Review shows a group's contacts
// side by side; Reject says they are not the same person. Two contacts never share an email
// address or a phone number, so the groups are near matches.
// https://help.gohighlevel.com/support/solutions/articles/48001202210
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { listDuplicateGroups, type DuplicateFindMode, type DuplicateGroup } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactElement } from 'react';

import { apiIn } from '../api';
import { ListProblem, retryFaults, ViewSwitch } from '../settings-list';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';
import { duplicatesKey } from './keys';
import { groupTitle, ReviewPanel, useReasonWords, useReject, useWhy } from './review-panel';

function GroupCard({
  group,
  onReview,
  onReject,
}: {
  readonly group: DuplicateGroup;
  readonly onReview: (group: DuplicateGroup, opener: HTMLElement) => void;
  readonly onReject: (group: DuplicateGroup, opener: HTMLElement) => void;
}): ReactElement {
  const { t } = useLingui();
  const reasons = useReasonWords();
  const why = useWhy();
  const names = group.contacts.map((each) => each.name ?? t`Unnamed contact`).join(', ');
  const total = group.total;
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <p className="min-w-0 font-medium wrap-anywhere">{groupTitle(group)}</p>
        {group.reasons.map((reason) => (
          <Badge key={reason}>{reasons[reason]}</Badge>
        ))}
        {group.weak ? (
          <Badge variant="attention">
            <Trans>Weaker match</Trans>
          </Badge>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{why(group)}</p>
      <p className="text-sm wrap-anywhere">
        <Plural value={total} one="# contact" other="# contacts" />: {names}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          aria-haspopup="dialog"
          onClick={(event) => {
            onReview(group, event.currentTarget);
          }}
        >
          <Trans>Review</Trans>
        </Button>
        <Button
          variant="quiet"
          onClick={(event) => {
            onReject(group, event.currentTarget);
          }}
        >
          <Trans>Reject</Trans>
        </Button>
      </div>
    </li>
  );
}

export function ManageDuplicatesPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const queryClient = useQueryClient();
  const [by, setBy] = useState<DuplicateFindMode>('email');
  const [reviewing, setReviewing] = useState<DuplicateGroup>();
  const [notice, setNotice] = useState<string>();
  const reviewOpenerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const groups = useInfiniteQuery({
    queryKey: [...duplicatesKey(business.id), 'groups', by],
    queryFn: ({ pageParam }) =>
      apiIn(business.id).request(listDuplicateGroups, {
        query: { by, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    // A refusal (no contacts.merge) is said at once, not after retries.
    retry: retryFaults,
  });
  const rejected = (group: DuplicateGroup) => {
    setReviewing(undefined);
    // The group's card is gone: the list's heading takes the focus it had.
    reviewOpenerRef.current = headingRef.current;
    headingRef.current?.focus();
    const title = groupTitle(group);
    setNotice(t`${title} was rejected. Those contacts won't be shown as duplicates again.`);
    void queryClient.invalidateQueries({ queryKey: duplicatesKey(business.id) });
  };
  const { ask, dialog } = useReject(rejected, headingRef);
  const items = groups.data?.pages.flatMap((page) => page.items) ?? [];
  const forbidden = groups.error instanceof ApiError && groups.error.problem.status === 403;
  const modes: readonly { readonly value: DuplicateFindMode; readonly label: string }[] = [
    { value: 'email', label: t`Email` },
    { value: 'phone', label: t`Phone` },
    { value: 'name', label: t`Name` },
  ];
  return (
    <Page title={t`Manage Duplicates`}>
      <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
        <Trans>
          Contacts that may be the same person. An email address or a phone number belongs to one
          contact, so these are near matches: addresses that reach one inbox, numbers that end
          alike, and similar names with something more in common.
        </Trans>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="text-sm font-medium">
          <Trans>Find by</Trans>
        </span>
        <ViewSwitch
          label={t`Find by`}
          views={modes}
          value={by}
          onChange={(next) => {
            setNotice(undefined);
            setBy(next);
          }}
        />
      </div>
      <section aria-labelledby="duplicate-groups" className="flex min-w-0 flex-col gap-3">
        <h2 id="duplicate-groups" ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
          {by === 'email' ? (
            <Trans>Duplicates by email</Trans>
          ) : by === 'phone' ? (
            <Trans>Duplicates by phone</Trans>
          ) : (
            <Trans>Duplicates by name</Trans>
          )}
        </h2>
        {notice === undefined ? null : (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {groups.isPending ? (
          <p role="status">
            <Trans>Looking for duplicates…</Trans>
          </p>
        ) : null}
        {forbidden ? (
          <p role="alert" className="text-sm">
            <Trans>Only admins can manage duplicates.</Trans>
          </p>
        ) : groups.isError ? (
          <ListProblem
            onRetry={() => {
              void groups.refetch();
            }}
          >
            <Trans>We couldn't look for duplicates.</Trans>
          </ListProblem>
        ) : null}
        {groups.isSuccess && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {groups.hasNextPage ? (
              <Trans>No duplicates among the contacts compared so far.</Trans>
            ) : (
              <Trans>No possible duplicates found.</Trans>
            )}
          </p>
        ) : null}
        {items.length === 0 ? null : (
          <ul className="flex min-w-0 flex-col gap-3">
            {items.map((group) => (
              <GroupCard
                key={`${group.by}:${group.valueKey}:${group.contacts[0]?.id ?? ''}`}
                group={group}
                onReview={(chosen, opener) => {
                  reviewOpenerRef.current = opener;
                  setReviewing(chosen);
                }}
                onReject={ask}
              />
            ))}
          </ul>
        )}
        {groups.hasNextPage ? (
          <Button
            variant="secondary"
            className="self-start"
            disabled={groups.isFetchingNextPage}
            onClick={() => {
              void groups.fetchNextPage();
            }}
          >
            {groups.isFetchingNextPage ? (
              <Trans>Looking…</Trans>
            ) : by === 'name' ? (
              <Trans>Compare more contacts</Trans>
            ) : (
              <Trans>Show more</Trans>
            )}
          </Button>
        ) : null}
      </section>
      <ReviewPanel
        open={reviewing !== undefined}
        groups={reviewing === undefined ? [] : [reviewing]}
        canReject
        canMerge
        returnFocus={reviewOpenerRef}
        onClose={() => {
          setReviewing(undefined);
        }}
        onRejected={rejected}
      />
      {dialog}
    </Page>
  );
}
