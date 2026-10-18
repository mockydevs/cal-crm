// The bar over the contact list while contacts are ticked: GoHighLevel's bulk actions, each
// opening its own dialog, fetched when first pressed; the way to select every contact the
// list holds rather than the ones loaded; and, once an action has started, what it came to
// with the way to Bulk Actions, where one in the background goes on and an export is
// downloaded. An action the reader's role can't do is not offered. The bar is fetched, with
// its words, when a contact is first ticked, so the contact list downloads none of it.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  CONTACT_BULK_INLINE_LIMIT,
  getMyPermissions,
  type ContactBulkAction,
  type ContactBulkSelection,
  type Permission,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  BellOff,
  ChevronDown,
  FileDown,
  HandCoins,
  Mail,
  MailCheck,
  MessageSquareText,
  Tag,
  Tags,
  Trash2,
  UserCog,
  Workflow,
} from 'lucide-react';
import { lazy, Suspense, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { apiIn } from './api';
import { selectionOf, type ListSelection } from './contact-bulk-dialog-rules';

// Each dialog by itself, fetched when its button is first pressed. "Add to Workflow" brings
// the workflow words it shares with the builder (lingui.config.ts).
const AddToWorkflowDialog = lazy(async () => {
  const [dialog, words] = await Promise.all([
    import('./contact-add-to-workflow'),
    import('./automation-words'),
  ]);
  await words.loadAutomationWords();
  return dialog;
});
const TagsDialog = lazy(() => import('./contact-bulk/tags'));
const TrashDialog = lazy(() => import('./contact-bulk/trash'));
const OwnerDialog = lazy(() => import('./contact-bulk/owner'));
const ExportDialog = lazy(() => import('./contact-bulk/export'));
const SmsDialog = lazy(() => import('./contact-bulk/sms'));
const EmailDialog = lazy(() => import('./contact-bulk/email'));
const DndDialog = lazy(() => import('./contact-bulk/dnd'));
const OpportunityDialog = lazy(() => import('./contact-bulk/opportunity'));
const VerifyDialog = lazy(() => import('./contact-bulk/verify'));

type Chosen =
  | 'add_to_workflow'
  | 'add_tags'
  | 'remove_tags'
  | 'trash'
  | 'assign_owner'
  | 'export'
  | 'send_sms'
  | 'send_email'
  | 'set_dnd'
  | 'add_opportunity'
  | 'verify_emails';

/** What each action needs of the reader's role besides changing contacts. */
const NEEDS: Readonly<Partial<Record<Chosen, Permission>>> = {
  add_to_workflow: 'automations.manage',
  add_tags: 'tags.manage',
  remove_tags: 'tags.manage',
  export: 'contacts.export',
  send_sms: 'campaigns.send',
  send_email: 'campaigns.send',
  add_opportunity: 'deals.manage',
};

export interface ContactBulkBarProps {
  readonly businessId: string;
  readonly slug: string;
  /** The contacts ticked: by hand, or every loaded one of a whole-list selection. */
  readonly ticked: ReadonlySet<string>;
  /** Every contact the list holds is selected, less these, rather than the ones ticked. */
  readonly everyone: { readonly except: ReadonlySet<string> } | undefined;
  /** How many contacts the list has loaded. */
  readonly loaded: number;
  /** How many the list holds, as the server counted them, when it has. */
  readonly counted: { readonly count: number; readonly exact: boolean } | undefined;
  /** The list's search and filters, which a whole-list selection keeps. */
  readonly list: ListSelection;
  /** The columns the list shows, which an export writes unless changed. */
  readonly columns: readonly string[];
  readonly fields: readonly { readonly id: string; readonly label: string }[];
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
  /** An action started: the selection is cleared and the list read again. */
  readonly onDone: () => void;
}

export default function ContactBulkBar({
  businessId,
  slug,
  ticked,
  everyone,
  loaded,
  counted,
  list,
  columns,
  fields,
  onSelectAll,
  onClear,
  onDone,
}: ContactBulkBarProps): ReactElement {
  const { t, i18n } = useLingui();
  const focusRef = useRef<HTMLElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [chosen, setChosen] = useState<Chosen>();
  const [done, setDone] = useState<ContactBulkAction>();
  const grants = useQuery({
    queryKey: ['b', businessId, 'my-permissions'],
    queryFn: () => apiIn(businessId).request(getMyPermissions, {}),
    staleTime: 60_000,
  });
  const may = (action: Chosen): boolean => {
    const needed = NEEDS[action];
    return needed === undefined || grants.data?.permissions.includes(needed) === true;
  };
  // How many are selected, and how the request names them: every contact the list holds
  // less the ones unticked, or the ones ticked, a hundred at most either way.
  const count =
    everyone === undefined
      ? ticked.size
      : Math.max((counted?.count ?? loaded) - everyone.except.size, 0);
  const more = everyone !== undefined && counted?.exact === false;
  const selection: ContactBulkSelection | undefined =
    everyone !== undefined
      ? everyone.except.size <= CONTACT_BULK_INLINE_LIMIT
        ? selectionOf({ kind: 'all', list, except: [...everyone.except] })
        : undefined
      : ticked.size > 0 && ticked.size <= CONTACT_BULK_INLINE_LIMIT
        ? selectionOf({ kind: 'ids', ids: [...ticked] })
        : undefined;
  // Once every loaded contact is ticked, the rest of the list can be chosen too.
  const canSelectAll =
    everyone === undefined &&
    counted !== undefined &&
    loaded > 0 &&
    ticked.size === loaded &&
    (!counted.exact || counted.count > ticked.size);
  const numbers = new Intl.NumberFormat(i18n.locale);
  const shown = numbers.format(count);
  const listCount = counted === undefined ? '' : numbers.format(counted.count);
  const listMore = counted !== undefined && !counted.exact;
  const tooMany = selection === undefined;
  const open = (action: Chosen, from: HTMLElement | null) => {
    focusRef.current = from;
    setDone(undefined);
    setChosen(action);
  };
  const finish = (action: ContactBulkAction) => {
    setChosen(undefined);
    setDone(action);
    onDone();
  };
  const close = () => {
    setChosen(undefined);
  };
  const iconClassName = 'size-4';
  const button = (action: Chosen, icon: ReactNode, label: ReactNode) =>
    may(action) ? (
      <Button
        variant="secondary"
        size="small"
        disabled={tooMany}
        onClick={(event) => {
          open(action, event.currentTarget);
        }}
      >
        {icon}
        {label}
      </Button>
    ) : null;
  const dialog = (): ReactNode => {
    if (chosen === undefined || selection === undefined) return null;
    const shared = {
      businessId,
      selection,
      count,
      more,
      returnFocus: focusRef,
      onClose: close,
      onDone: finish,
    };
    switch (chosen) {
      case 'add_to_workflow':
        return <AddToWorkflowDialog {...shared} />;
      case 'add_tags':
        return <TagsDialog {...shared} remove={false} />;
      case 'remove_tags':
        return <TagsDialog {...shared} remove />;
      case 'trash':
        return <TrashDialog {...shared} />;
      case 'assign_owner':
        return <OwnerDialog {...shared} />;
      case 'export':
        return <ExportDialog {...shared} columns={columns} fields={fields} />;
      case 'send_sms':
        return <SmsDialog {...shared} />;
      case 'send_email':
        return <EmailDialog {...shared} />;
      case 'set_dnd':
        return <DndDialog {...shared} />;
      case 'add_opportunity':
        return <OpportunityDialog {...shared} />;
      case 'verify_emails':
        return <VerifyDialog {...shared} />;
    }
  };

  return (
    <>
      {count === 0 ? null : (
        <div
          role="group"
          aria-label={t`Bulk actions`}
          className="flex flex-wrap items-center gap-2 rounded-card border bg-card px-3 py-2"
        >
          <span className="text-sm font-medium text-foreground">
            {everyone === undefined ? (
              <Trans>{shown} selected</Trans>
            ) : more ? (
              <Trans>All {shown}+ contacts selected</Trans>
            ) : (
              <Trans>All {shown} contacts selected</Trans>
            )}
          </span>
          {button(
            'add_to_workflow',
            <Workflow aria-hidden className={iconClassName} strokeWidth={1.8} />,
            <Trans>Add to Workflow</Trans>,
          )}
          {button(
            'send_sms',
            <MessageSquareText aria-hidden className={iconClassName} strokeWidth={1.8} />,
            <Trans>Send SMS</Trans>,
          )}
          {button(
            'send_email',
            <Mail aria-hidden className={iconClassName} strokeWidth={1.8} />,
            <Trans>Send Email</Trans>,
          )}
          {button(
            'add_tags',
            <Tag aria-hidden className={iconClassName} strokeWidth={1.8} />,
            <Trans>Add Tag</Trans>,
          )}
          {button(
            'remove_tags',
            <Tags aria-hidden className={iconClassName} strokeWidth={1.8} />,
            <Trans>Remove Tag</Trans>,
          )}
          {button(
            'add_opportunity',
            <HandCoins aria-hidden className={iconClassName} strokeWidth={1.8} />,
            <Trans>Opportunity</Trans>,
          )}
          {button(
            'export',
            <FileDown aria-hidden className={iconClassName} strokeWidth={1.8} />,
            <Trans>Export</Trans>,
          )}
          {button(
            'trash',
            <Trash2 aria-hidden className={iconClassName} strokeWidth={1.8} />,
            <Trans>Delete</Trans>,
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={moreRef}
              disabled={tooMany}
              className="flex min-h-9 items-center gap-1 rounded-control border border-border px-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Trans>More</Trans>
              <ChevronDown aria-hidden className={iconClassName} strokeWidth={1.8} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              {/* The menu is gone once a dialog opens, so focus goes back to its button. */}
              <DropdownMenuItem
                className="min-h-11 lg:min-h-9"
                onClick={() => {
                  open('assign_owner', moreRef.current);
                }}
              >
                <UserCog aria-hidden className="size-[18px]" strokeWidth={1.8} />
                <Trans>Change owner</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11 lg:min-h-9"
                onClick={() => {
                  open('set_dnd', moreRef.current);
                }}
              >
                <BellOff aria-hidden className="size-[18px]" strokeWidth={1.8} />
                <Trans>Do not disturb</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11 lg:min-h-9"
                onClick={() => {
                  open('verify_emails', moreRef.current);
                }}
              >
                <MailCheck aria-hidden className="size-[18px]" strokeWidth={1.8} />
                <Trans>Verify emails</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canSelectAll ? (
            <Button variant="quiet" size="small" onClick={onSelectAll}>
              {listMore ? (
                <Trans>Select all {listCount}+ contacts</Trans>
              ) : (
                <Trans>Select all {listCount} contacts</Trans>
              )}
            </Button>
          ) : null}
          <Button variant="quiet" size="small" onClick={onClear}>
            <Trans>Clear selection</Trans>
          </Button>
          {tooMany ? (
            <span className="text-sm text-muted-foreground">
              <Trans>
                Tick at most {CONTACT_BULK_INLINE_LIMIT} contacts, or select all the list holds.
              </Trans>
            </span>
          ) : null}
        </div>
      )}
      {done === undefined ? null : (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-sm">
          <DoneWords action={done} />
          <Link
            to="/b/$slug/contacts/bulk-actions"
            params={{ slug }}
            className="font-medium text-link underline"
          >
            {done.action === 'export' ? (
              <Trans>Download it from Bulk Actions</Trans>
            ) : (
              <Trans>See each contact in Bulk Actions</Trans>
            )}
          </Link>
        </p>
      )}
      <Suspense fallback={null}>{dialog()}</Suspense>
    </>
  );
}

/** What an action came to as it answered: done at once, or going on in the background. */
function DoneWords({ action }: { readonly action: ContactBulkAction }): ReactElement {
  const { t } = useLingui();
  const contacts = plural(action.requested, { one: '# contact', other: '# contacts' });
  if (action.action === 'export') return <>{t`The export of ${contacts} is being written.`}</>;
  if (action.status === 'completed') {
    const { done: changed, unchanged, skipped } = action;
    return <>{t`Done: ${changed} changed, ${unchanged} already as asked, ${skipped} skipped.`}</>;
  }
  if (action.nextBatchAt !== null || action.drip !== null)
    return <>{t`Scheduled for ${contacts}.`}</>;
  return <>{t`Started in the background for ${contacts}.`}</>;
}
