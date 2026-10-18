// The review of possible duplicates (GoHighLevel's "Review" in Manage Duplicates): each
// group's contacts side by side, field by field; Merge, which opens Merge Contacts with
// them; and Reject, which says they are not the same person and cannot be undone.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  MAX_CONTACTS_IN_MERGE,
  rejectDuplicateGroup,
  type DuplicateContact,
  type DuplicateGroup,
  type DuplicateReason,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { Suspense, useId, useRef, useState, type ReactElement, type RefObject } from 'react';

import { apiIn } from '../api';
import { ContactMergeDialog } from '../contact-merge/loader';
import { returnTo } from '../list-table';
import { ConfirmDialog } from '../settings-list';
import { useBusiness } from '../workspace';

/** What each sign is called, on a group's card and in the review. */
export function useReasonWords(): Readonly<Record<DuplicateReason, string>> {
  const { t } = useLingui();
  return {
    email: t`Same email inbox`,
    phone: t`Same last 10 digits`,
    name: t`Similar name`,
    company: t`Same company`,
    email_name: t`Same email name`,
  };
}

/** Why a group's contacts were put together, in a sentence. */
export function useWhy(): (group: DuplicateGroup) => string {
  const { t } = useLingui();
  return (group) => {
    if (group.by === 'email')
      return group.weak
        ? t`The same email address with a different +tag. Some providers deliver both to one inbox, some don't.`
        : t`These addresses reach one Gmail inbox: Gmail ignores dots, anything after a +, and googlemail.com.`;
    if (group.by === 'phone')
      return group.weak
        ? t`These phone numbers end in the same 10 digits, but the names differ.`
        : t`These phone numbers end in the same 10 digits.`;
    return t`Similar names, and at least one more thing in common.`;
  };
}

/** The group's key as a person reads it. */
export function groupTitle(group: DuplicateGroup): string {
  return group.by === 'phone' ? `…${group.valueKey}` : group.valueKey;
}

function useAdded(): (contact: DuplicateContact) => string {
  const { i18n } = useLingui();
  const business = useBusiness();
  const format = new Intl.DateTimeFormat(i18n.locale || undefined, {
    dateStyle: 'medium',
    ...(business.timezone === undefined ? {} : { timeZone: business.timezone }),
  });
  return (contact) => format.format(new Date(contact.createdAt));
}

function Values({ values }: { readonly values: readonly string[] }): ReactElement {
  if (values.length === 0)
    return (
      <span className="text-muted-foreground">
        <Trans>None</Trans>
      </span>
    );
  return (
    <ul className="flex flex-col gap-0.5">
      {values.map((value) => (
        <li key={value} className="wrap-anywhere">
          {value}
        </li>
      ))}
    </ul>
  );
}

/** One group: its contacts in columns, a row per field, and its Reject. */
function GroupReview({
  group,
  canReject,
  onReject,
  onMerge,
}: {
  readonly group: DuplicateGroup;
  readonly canReject: boolean;
  readonly onReject: (group: DuplicateGroup, opener: HTMLElement) => void;
  /** Opens Merge Contacts with the group's contacts; absent for whoever may not merge. */
  readonly onMerge: ((group: DuplicateGroup, opener: HTMLElement) => void) | undefined;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const reasons = useReasonWords();
  const why = useWhy();
  const added = useAdded();
  const headingId = useId();
  const rows: readonly {
    readonly label: string;
    readonly cell: (each: DuplicateContact) => ReactElement;
  }[] = [
    { label: t`Email`, cell: (each) => <Values values={each.emails} /> },
    { label: t`Phone`, cell: (each) => <Values values={each.phones} /> },
    { label: t`Added`, cell: (each) => <span>{added(each)}</span> },
  ];
  const more = group.total - group.contacts.length;
  const title = groupTitle(group);
  const tooManyId = useId();
  // GoHighLevel merges up to ten contacts at a time.
  const mergeable = group.total <= MAX_CONTACTS_IN_MERGE;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 id={headingId} className="min-w-0 font-medium wrap-anywhere">
          {title}
        </h3>
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
      {/* Sideways scrolling on a narrow screen; every column starts with a link to press. */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-max border-collapse text-sm">
          <caption className="sr-only">
            <Trans>The contacts of {title}, side by side</Trans>
          </caption>
          <thead>
            <tr className="border-b border-border bg-secondary/60">
              <td className="w-28 px-3 py-2" />
              {group.contacts.map((each) => (
                <th key={each.id} scope="col" className="px-3 py-2 text-left font-medium">
                  <Link
                    to="/b/$slug/contacts/$contactId"
                    params={{ slug: business.slug, contactId: each.id }}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    {each.name ?? t`Unnamed contact`}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left align-top font-medium text-body">
                  {row.label}
                </th>
                {group.contacts.map((each) => (
                  <td key={each.id} className="px-3 py-2 align-top">
                    {row.cell(each)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>{more} more contacts share it and are not shown.</Trans>
        </p>
      ) : null}
      {canReject || onMerge !== undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          {onMerge === undefined ? null : (
            <Button
              disabled={!mergeable}
              aria-describedby={mergeable ? undefined : tooManyId}
              onClick={(event) => {
                onMerge(group, event.currentTarget);
              }}
            >
              <Trans>Merge</Trans>
            </Button>
          )}
          {canReject ? (
            <Button
              variant="secondary"
              onClick={(event) => {
                onReject(group, event.currentTarget);
              }}
            >
              <Trans>Reject</Trans>
            </Button>
          ) : null}
          {onMerge === undefined || mergeable ? null : (
            <p id={tooManyId} className="text-sm text-muted-foreground">
              <Trans>
                Merge at most {MAX_CONTACTS_IN_MERGE} contacts at a time: tick the ones to merge in
                the contact list.
              </Trans>
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Reject, asked first: it cannot be undone, as in GoHighLevel. A rejected group's card goes,
 * so the question hands the focus to `focusAfter` when there is one, not to its opener.
 */
export function useReject(
  onRejected: (group: DuplicateGroup) => void,
  focusAfter?: RefObject<HTMLElement | null>,
): {
  readonly ask: (group: DuplicateGroup, opener: HTMLElement) => void;
  readonly dialog: ReactElement;
} {
  const { t } = useLingui();
  const business = useBusiness();
  const openerRef = useRef<HTMLElement | null>(null);
  const [asked, setAsked] = useState<DuplicateGroup>();
  const reject = useMutation({
    mutationFn: (group: DuplicateGroup) =>
      apiIn(business.id).request(rejectDuplicateGroup, {
        body: {
          by: group.by,
          valueKey: group.valueKey,
          contactIds: group.contacts.map((each) => each.id),
        },
      }),
    onSuccess: (_answer, group) => {
      if (focusAfter !== undefined) openerRef.current = focusAfter.current;
      setAsked(undefined);
      onRejected(group);
    },
  });
  // The server rejects the whole group, listed or not.
  const count = asked?.total ?? 0;
  return {
    ask: (group, from) => {
      openerRef.current = from;
      reject.reset();
      setAsked(group);
    },
    dialog: (
      <ConfirmDialog
        open={asked !== undefined}
        title={<Trans>Reject these duplicates?</Trans>}
        description={
          <Trans>
            The {count} contacts are not shown together as duplicates again, unless another contact
            joins them. This can't be undone.
          </Trans>
        }
        confirmLabel={t`Reject`}
        destructive
        busy={reject.isPending}
        problem={
          reject.error === null
            ? undefined
            : reject.error instanceof ApiError
              ? reject.error.message
              : t`They weren't rejected. Check your connection and try again.`
        }
        returnFocus={openerRef}
        onConfirm={() => {
          if (asked !== undefined) reject.mutate(asked);
        }}
        onClose={() => {
          setAsked(undefined);
        }}
      />
    ),
  };
}

/** The review: one or more groups, side by side, in a panel over the page. */
export function ReviewPanel({
  open,
  groups,
  canReject,
  canMerge,
  returnFocus,
  onClose,
  onRejected,
}: {
  readonly open: boolean;
  readonly groups: readonly DuplicateGroup[];
  readonly canReject: boolean;
  /** Whether Merge is offered: Manage Duplicates' permission, as Reject's. */
  readonly canMerge: boolean;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onRejected: (group: DuplicateGroup) => void;
}): ReactElement {
  const { t } = useLingui();
  const { ask, dialog } = useReject(onRejected);
  const mergeOpenerRef = useRef<HTMLElement | null>(null);
  const [merging, setMerging] = useState<DuplicateGroup>();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          finalFocus={returnTo(returnFocus)}
          className="fixed inset-x-4 top-[max(16px,5dvh)] z-60 mx-auto flex max-h-[90dvh] max-w-[960px] flex-col rounded-card bg-card text-card-foreground shadow-xl outline-none"
        >
          <div className="flex min-w-0 items-start justify-between gap-3 border-b px-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Dialog.Title className="text-lg font-medium">
                <Trans>Review duplicates</Trans>
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                <Trans>Compare the contacts field by field.</Trans>
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-col gap-6 overflow-y-auto p-4">
            {groups.length === 0 ? (
              <p role="status" className="text-sm">
                <Trans>Nothing is left to review.</Trans>
              </p>
            ) : null}
            {groups.map((group) => (
              <GroupReview
                key={`${group.by}:${group.valueKey}`}
                group={group}
                canReject={canReject}
                onReject={ask}
                onMerge={
                  canMerge
                    ? (chosen, opener) => {
                        mergeOpenerRef.current = opener;
                        setMerging(chosen);
                      }
                    : undefined
                }
              />
            ))}
          </div>
          {/* Inside the panel, so the question opens over it rather than behind its inert page. */}
          {dialog}
          <Suspense fallback={null}>
            {merging === undefined ? null : (
              <ContactMergeDialog
                contactIds={merging.contacts.map((each) => each.id)}
                returnFocus={mergeOpenerRef}
                onClose={() => {
                  setMerging(undefined);
                }}
              />
            )}
          </Suspense>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
