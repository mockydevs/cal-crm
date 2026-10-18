// An email row's verification on the contact page: one badge saying whether the address can
// be sent to and what a check found, opening the reasons in plain words, and, for someone
// who may change the contact, the row's menu: Verify or Re-verify, Exclude from email
// verification or Include, Block or Unblock. Fetched with its words, after the row.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  blockEmailAddress,
  excludeEmailAddress,
  getMyPermissions,
  includeEmailAddress,
  unblockEmailAddress,
  verifyEmailAddress,
  type ContactAddress,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { badgeVariants } from '@repo/ui/components/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@repo/ui/components/popover';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleCheck, EllipsisVertical, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { contactDetailsKey } from '../contact-details-data';
import { useBusiness } from '../workspace';
import {
  actionsOf,
  isExpired,
  reasonsOf,
  statusOf,
  type AddressStatus,
  type BlockReason,
} from './rules';

/** How often, and how many times, the row reads the details again while a check runs. */
const CHECK_POLL_MS = 4000;
const CHECK_POLLS = 6;

const menuButtonClassName =
  'flex size-11 shrink-0 items-center justify-center rounded-control text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 lg:size-7';

// Blocking, unblocking a hard bounce and the opt-outs that stay blocked: each a dialog,
// fetched when one is opened.
const AddressDialog = lazy(() => import('./address-dialogs'));

type Dialog = 'block' | 'unblock_bounce' | 'opted_out' | undefined;

export default function EmailAddressStatus({
  contactId,
  address,
  canManage,
}: {
  readonly contactId: string;
  readonly address: ContactAddress;
  /** Whether the person may change the contact, as its details say. */
  readonly canManage: boolean;
}): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const shown = address.display;
  const status = statusOf(address);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>();
  const menuRef = useRef<HTMLButtonElement>(null);
  // While a check queued from here runs, the details are read again a few times.
  const [checking, setChecking] = useState<{ from: string | null; polls: number }>();
  const bounced =
    address.delivery?.status === 'blocked' && address.delivery.reason === 'hard_bounce';
  const grants = useQuery({
    queryKey: ['b', business.id, 'my-permissions'],
    queryFn: () => apiIn(business.id).request(getMyPermissions, {}),
    enabled: canManage && bounced,
    staleTime: 60_000,
  });
  const mayManageVerification =
    grants.data?.permissions.includes('email.verification.manage') === true;
  const checkedAt = address.verification?.checkedAt ?? null;
  // Until the result changes, or after a few reads, whichever comes first.
  const polling = checking?.from === checkedAt && checking.polls < CHECK_POLLS;
  // A check queued from here whose result has come in says so in place of "Checking".
  const done = checking !== undefined && checking.from !== checkedAt;
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => {
      void cache.invalidateQueries({ queryKey: contactDetailsKey(business.id, contactId) });
      setChecking((last) => (last === undefined ? last : { ...last, polls: last.polls + 1 }));
    }, CHECK_POLL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [business.id, cache, checking, contactId, polling]);
  const ids = { contactId, addressId: address.id };
  const change = useMutation({
    mutationFn: async (
      action:
        | { kind: 'verify' | 'exclude' | 'include' }
        | { kind: 'block'; reason: string }
        | { kind: 'unblock'; confirm?: 'unblock' },
    ) => {
      const client = apiIn(business.id);
      switch (action.kind) {
        case 'verify':
          return client.request(verifyEmailAddress, { body: ids });
        case 'exclude':
          return client.request(excludeEmailAddress, { body: ids });
        case 'include':
          return client.request(includeEmailAddress, { body: ids });
        case 'block':
          return client.request(blockEmailAddress, {
            body: action.reason === '' ? ids : { ...ids, reason: action.reason },
          });
        case 'unblock':
          return client.request(unblockEmailAddress, {
            body: action.confirm === undefined ? ids : { ...ids, confirm: action.confirm },
          });
      }
    },
    onMutate: () => {
      setNotice('');
      setProblem(undefined);
      setChecking(undefined);
    },
    onSuccess: async (receipt, action) => {
      setDialog(undefined);
      const said: Record<typeof action.kind, string> = {
        verify: receipt.pending
          ? t`Checking ${shown}. The result shows here once it's done.`
          : t`The latest check of ${shown} is shown.`,
        exclude: t`${shown} is excluded from email verification.`,
        include: t`${shown} is included in email verification again.`,
        block: t`${shown} is blocked. No email is sent to it.`,
        unblock: t`${shown} is unblocked.`,
      };
      setNotice(said[action.kind]);
      if (action.kind === 'verify' && receipt.pending) setChecking({ from: checkedAt, polls: 0 });
      // The details hold the address's delivery and verification: read them again.
      await cache.invalidateQueries({ queryKey: contactDetailsKey(business.id, contactId) });
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? (error.problem.errors?.find((issue) => issue.message.trim() !== '')?.message ??
              error.problem.detail ??
              error.message)
          : t`The change wasn't saved. Check your connection and try again.`,
      );
    },
  });
  const actions = actionsOf(address, mayManageVerification);
  // A server without verification shows the row as it always has.
  const offersMenu =
    canManage && address.verification !== undefined && address.verification !== null;
  if (status === undefined && !offersMenu) return null;
  return (
    <>
      {status === undefined ? null : <StatusBadge address={address} status={status} />}
      {offersMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            ref={menuRef}
            aria-label={t`Email verification for ${shown}`}
            className={menuButtonClassName}
          >
            <EllipsisVertical aria-hidden className="size-4" strokeWidth={1.8} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            {actions.verify === null ? null : (
              <DropdownMenuItem
                disabled={change.isPending}
                onClick={() => {
                  change.mutate({ kind: 'verify' });
                }}
              >
                {actions.verify === 'verify' ? t`Verify email` : t`Re-verify`}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={change.isPending}
              onClick={() => {
                change.mutate({ kind: actions.exclusion });
              }}
            >
              {actions.exclusion === 'exclude'
                ? t`Exclude from email verification`
                : t`Include in email verification`}
            </DropdownMenuItem>
            {actions.block === null ? null : (
              <DropdownMenuItem
                disabled={change.isPending}
                onClick={() => {
                  if (actions.block === 'unblock') change.mutate({ kind: 'unblock' });
                  else if (actions.block !== null) setDialog(actions.block);
                }}
              >
                {actions.block === 'block'
                  ? t`Block email`
                  : actions.block === 'opted_out'
                    ? t`Why it can't be unblocked`
                    : t`Unblock`}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <span role="status" className="basis-full text-xs text-muted-foreground empty:sr-only">
        {done ? t`The check of ${shown} is done.` : notice}
      </span>
      {problem === undefined || dialog !== undefined ? null : (
        <span role="alert" className="basis-full text-xs text-destructive">
          {problem}
        </span>
      )}
      {dialog === undefined ? null : (
        <Suspense fallback={null}>
          <AddressDialog
            kind={dialog}
            shown={shown}
            optOut={address.delivery?.reason === 'complaint' ? 'complaint' : 'unsubscribe'}
            busy={change.isPending}
            problem={problem}
            returnFocus={menuRef}
            onBlock={(reason) => {
              change.mutate({ kind: 'block', reason });
            }}
            onUnblock={() => {
              change.mutate({ kind: 'unblock', confirm: 'unblock' });
            }}
            onClose={() => {
              setDialog(undefined);
              setProblem(undefined);
            }}
          />
        </Suspense>
      )}
    </>
  );
}

function useStatusWords(): {
  readonly label: (status: AddressStatus) => string;
  readonly meaning: (status: AddressStatus) => string;
  readonly blockReason: (reason: BlockReason | null) => string | undefined;
  readonly reason: (code: string) => string | undefined;
} {
  const { t } = useLingui();
  const labels: Readonly<Record<AddressStatus['kind'], string>> = {
    blocked: t`Blocked`,
    excluded: t`Excluded`,
    invalid: t`Invalid`,
    risky: t`Risky`,
    unknown: t`Unknown`,
    verified: t`Verified`,
    domain_checked: t`Domain checked`,
    not_verified: t`Not verified`,
  };
  const meanings: Readonly<Record<AddressStatus['kind'], string>> = {
    blocked: t`No email is sent to this address.`,
    excluded: t`Excluded from email verification: it isn't checked, and emails to it go out without a check.`,
    invalid: t`Emails will not be sent to this address.`,
    risky: t`Emails are still sent to it, but they may not arrive.`,
    unknown: t`The check couldn't tell. It is tried again later, and emails to it still go out.`,
    verified: t`The mailbox was checked and takes mail. Safe to send.`,
    domain_checked: t`The domain takes mail. Checking the mailbox itself needs a verification provider.`,
    not_verified: t`It hasn't been checked yet. With verification on, it is checked before the first email is sent.`,
  };
  const blockReasons: Readonly<Record<BlockReason, string>> = {
    hard_bounce: t`An email to it bounced: the mailbox doesn't take mail.`,
    complaint: t`They marked an email from you as spam.`,
    unsubscribe: t`They unsubscribed from your email.`,
    invalid: t`A check found it can't receive email.`,
    manual: t`Someone on your team blocked it.`,
  };
  const reasons: Readonly<Record<string, string>> = {
    bad_syntax: t`It isn't written as an email address.`,
    unsupported_syntax: t`It uses characters the check can't read.`,
    domain_not_found: t`Its domain doesn't exist.`,
    no_mail_server: t`Its domain has no mail server.`,
    no_mail_accepted: t`Its domain says it accepts no email.`,
    dns_unavailable: t`Its domain couldn't be looked up at the time.`,
    disposable: t`It is a disposable address, made to be thrown away.`,
    role: t`It reaches a role, such as info@ or sales@, more than one person.`,
    free_provider: t`It is with a free email provider.`,
    catch_all: t`Its domain accepts mail for any address, so this mailbox can't be confirmed.`,
    mailbox_full: t`The mailbox is full.`,
    mailbox_not_found: t`The mailbox doesn't exist.`,
    smtp_rejected: t`The mail server refused it.`,
    low_quality: t`The provider rates it as low quality.`,
    low_deliverability: t`The provider expects email to it may not arrive.`,
    mail_server_unavailable: t`The mail server didn't answer.`,
    provider_error: t`The verification provider couldn't finish the check.`,
    hard_bounce: t`An email to it bounced.`,
  };
  return {
    label: (status) => labels[status.kind],
    meaning: (status) => meanings[status.kind],
    blockReason: (reason) => (reason === null ? undefined : blockReasons[reason]),
    // A code this dashboard doesn't know yet is left out rather than shown raw.
    reason: (code) => reasons[code],
  };
}

const toneOf = (status: AddressStatus): 'attention' | 'neutral' =>
  status.kind === 'blocked' || status.kind === 'invalid' || status.kind === 'risky'
    ? 'attention'
    : 'neutral';

/** The badge, which opens what it means and why. */
function StatusBadge({
  address,
  status,
}: {
  readonly address: ContactAddress;
  readonly status: AddressStatus;
}): ReactElement {
  const { t, i18n } = useLingui();
  const words = useStatusWords();
  const listId = useId();
  const label = words.label(status);
  const shown = address.display;
  const verification = address.verification;
  const { problems, hints } = reasonsOf(verification);
  const worded = (codes: readonly string[]): string[] =>
    codes.flatMap((code) => words.reason(code) ?? []);
  const problemWords = worded(problems);
  const hintWords = worded(hints);
  const blockWords = status.kind === 'blocked' ? words.blockReason(status.reason) : undefined;
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const checkedAt = verification?.checkedAt ?? null;
  const checked = checkedAt === null ? undefined : dates.format(new Date(checkedAt));
  // When the badge was drawn: what "old enough" is measured from.
  const [now] = useState(() => new Date());
  const expired = isExpired(verification, now);
  const Icon =
    status.kind === 'verified'
      ? CircleCheck
      : status.kind === 'blocked' || status.kind === 'invalid'
        ? Ban
        : status.kind === 'risky'
          ? TriangleAlert
          : undefined;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t`${label}: what this means for ${shown}`}
        className={`${badgeVariants({ variant: toneOf(status) })} min-h-6 cursor-pointer px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      >
        {Icon === undefined ? null : <Icon aria-hidden strokeWidth={2} />}
        {label}
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm">
        <PopoverTitle>{label}</PopoverTitle>
        <p className="text-body">{words.meaning(status)}</p>
        {blockWords === undefined ? null : <p className="text-body">{blockWords}</p>}
        {problemWords.length === 0 ? null : (
          <div className="flex flex-col gap-1">
            <p id={listId} className="font-medium text-foreground">
              <Trans>Why</Trans>
            </p>
            <ul aria-labelledby={listId} className="flex list-disc flex-col gap-1 pl-5 text-body">
              {problemWords.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
          </div>
        )}
        {hintWords.length === 0 ? null : (
          <div className="flex flex-col gap-1">
            <p className="font-medium text-foreground">
              <Trans>Good to know</Trans>
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-body">
              {hintWords.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
          </div>
        )}
        {checked === undefined ? null : (
          <p className="text-muted-foreground">
            {verification?.depth === 'domain'
              ? t`Domain checked on ${checked}.`
              : t`Checked on ${checked}.`}{' '}
            {expired
              ? t`The result is old enough to be checked again before the next email.`
              : null}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
