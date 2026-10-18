// A campaign that is scheduled, sending, paused or finished, on its own page: its status
// with why it waits or paused itself and what to do, Pause, Resume and Cancel with what
// each really does, how far it is, its numbers, its recipients with what became of each,
// and what was sent, read-only. While it is sending the page reads again by itself.
//
// Opens and clicks are not here: nothing measures them yet, and the page says so.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  cancelEmailCampaign,
  createEmailCampaign,
  emailCampaignRecipientStatuses,
  emailCampaignSkipReasons,
  getEmailCampaignStats,
  listEmailCampaignRecipients,
  pauseEmailCampaign,
  resumeEmailCampaign,
  type EmailCampaign,
  type EmailCampaignRecipient,
  type EmailCampaignRecipientStatus,
  type EmailCampaignSkipReason,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { tokenOf } from '../email-editor/email-html';
import {
  cellClassName,
  headerCellClassName,
  ListProblem,
  tableClassName,
  tableRegionClassName,
} from '../list-table';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';
import { ConfirmDialog, Select } from './controls';
import { campaignKeys, retryFaults, saidBy, useAudienceNames } from './data';
import { CampaignPreview, useCampaignPreview } from './email-parts';
import { useCampaignMailboxes } from './mailboxes';
import {
  cardClassName,
  Fact,
  hintClassName,
  labelClassName,
  linkClassName,
  Pill,
  StatusPill,
} from './parts';
import {
  allowed,
  audienceSentence,
  batchesSentence,
  cancelConsequence,
  momentIn,
  progressOf,
  recipientStatusWords,
  skipReasonWords,
  statusLine,
  statusReasonWords,
  waitingLine,
} from './rules';

type Asking = 'pause' | 'resume' | 'cancel';
// The first page has no cursor.
const firstPage: string | undefined = undefined;

export default function CampaignResults({
  campaign,
}: {
  readonly campaign: EmailCampaign;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const client = useMemo(() => apiIn(business.id), [business.id]);
  const cache = useQueryClient();
  const navigate = useNavigate();
  const openerRef = useRef<HTMLElement | null>(null);
  const [asking, setAsking] = useState<Asking>();
  const [problem, setProblem] = useState<string>();
  const { status, timeZone, name } = campaign;
  const live = status === 'sending';
  const started = status !== 'scheduled';
  const permissions = { canManage: campaign.canManage, canSend: campaign.canSend };
  const names = useAudienceNames(business.id);
  const mailboxes = useCampaignMailboxes(business.id);
  const mailbox = mailboxes.data?.all.find((each) => each.id === campaign.mailboxId);
  const stats = useQuery({
    queryKey: campaignKeys.stats(business.id, campaign.id),
    queryFn: () => client.request(getEmailCampaignStats, { params: { id: campaign.id } }),
    enabled: started,
    retry: retryFaults,
    refetchInterval: live ? 15_000 : false,
  });
  const number = (value: number): string => value.toLocaleString(i18n.locale);

  const keep = (next: EmailCampaign): void => {
    cache.setQueryData(campaignKeys.one(business.id, next.id), next);
    void cache.invalidateQueries({ queryKey: campaignKeys.all(business.id) });
  };
  const act = useMutation({
    mutationFn: (action: Asking) =>
      client.request(
        action === 'pause'
          ? pauseEmailCampaign
          : action === 'resume'
            ? resumeEmailCampaign
            : cancelEmailCampaign,
        { params: { id: campaign.id } },
      ),
    onSuccess: (next) => {
      setAsking(undefined);
      keep(next);
    },
  });
  const duplicate = useMutation({
    mutationFn: () =>
      client.request(createEmailCampaign, {
        body: {
          name: t`${name} (copy)`.slice(0, 120),
          folderId: campaign.folderId,
          source: { kind: 'campaign', campaignId: campaign.id },
        },
      }),
    onSuccess: (made) => {
      void cache.invalidateQueries({ queryKey: campaignKeys.all(business.id) });
      void navigate({
        to: '/b/$slug/marketing/emails/campaigns/$campaignId',
        params: { slug: business.slug, campaignId: made.id },
      });
    },
    onError: (error) => {
      setProblem(
        saidBy(error, t`The campaign wasn't duplicated. Check your connection and try again.`),
      );
    },
  });

  const counts = stats.data ?? campaign.counts;
  const progress = progressOf({ ...campaign.counts, ...counts });
  const reason =
    campaign.statusReason === null ? undefined : statusReasonWords[campaign.statusReason];
  const waiting = waitingLine(campaign);
  const line = statusLine(campaign);
  const dueAt = campaign.schedule?.sendAt ?? null;
  const due = dueAt === null ? '' : momentIn(dueAt, timeZone);
  const startedAt = campaign.startedAt === null ? '' : momentIn(campaign.startedAt, timeZone);
  const finishedAt = campaign.finishedAt === null ? '' : momentIn(campaign.finishedAt, timeZone);
  const offered = (['pause', 'resume', 'cancel'] as const).filter((action) =>
    allowed(status, action, { canManage: true, canSend: true }),
  );
  const words: Readonly<Record<Asking, string>> = {
    pause: t`Pause`,
    resume: t`Resume`,
    cancel: t`Cancel campaign`,
  };
  const confirms: Readonly<Record<Asking, { title: string; description: string; label: string }>> =
    {
      pause: {
        title: t`Pause this campaign?`,
        description: t`Nothing more leaves until it is resumed, including emails already handed to the mailbox and not yet sent. Emails that have left stay sent.`,
        label: t`Pause sending`,
      },
      resume: {
        title: t`Resume this campaign?`,
        description: t`Sending goes on from where it stopped. Nobody is sent the campaign twice.`,
        label: t`Resume sending`,
      },
      cancel: {
        title: t`Cancel this campaign?`,
        description: cancelConsequence(status),
        label: t`Cancel campaign`,
      },
    };
  const text = campaign.content.text;
  const html = campaign.content.format === 'html' ? campaign.content.html : undefined;
  const preview = useCampaignPreview(client, business.id, {
    subject: campaign.subject,
    preheader: campaign.preheader ?? '',
    html,
    text,
  });
  const scheduledBatches = campaign.schedule?.batches ?? null;
  const done = number(progress.done);
  const audienceCount = number(counts.audience);
  const { percent } = progress;
  const counted = stats.data === undefined ? '' : momentIn(stats.data.countedAt, timeZone);
  const batchWords = scheduledBatches === null ? '' : batchesSentence(scheduledBatches);
  const exampleField = tokenOf('contact.firstName');
  const statusHeadingId = useId();
  const numbersHeadingId = useId();
  const sentHeadingId = useId();

  return (
    <Page title={name} actions={<StatusPill status={status} />}>
      <Link
        to="/b/$slug/marketing/emails/campaigns"
        params={{ slug: business.slug }}
        className={`${linkClassName} inline-flex min-h-11 items-center gap-1.5 self-start text-sm lg:min-h-0`}
      >
        <ArrowLeft aria-hidden className="size-4" strokeWidth={1.8} />
        <Trans>All campaigns</Trans>
      </Link>

      <section aria-labelledby={statusHeadingId} className={cardClassName}>
        <h2 id={statusHeadingId} className="sr-only">
          <Trans>Status</Trans>
        </h2>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div role="status" className="flex min-w-0 flex-1 basis-72 flex-col gap-1">
            <p className="text-lg font-medium">
              {status === 'scheduled'
                ? t`Scheduled to start ${due}`
                : status === 'sending'
                  ? t`Sending since ${startedAt}`
                  : status === 'paused'
                    ? t`Paused`
                    : status === 'sent'
                      ? t`Sent. Finished ${finishedAt}`
                      : status === 'cancelled'
                        ? t`Cancelled`
                        : t`Failed`}
            </p>
            {status === 'scheduled' ? (
              <p className="text-sm text-body">{t`On the business's clock: ${timeZone}.`}</p>
            ) : null}
            {scheduledBatches === null ? null : (
              <p className="text-sm text-body">{t`In batches: ${batchWords}.`}</p>
            )}
            {line === undefined ? null : <p className="text-md text-body">{line}</p>}
            {reason === undefined ? null : (
              <p className="text-md text-body">{i18n._(reason.todo)}</p>
            )}
            {waiting === undefined ? null : <p className="text-md text-body">{waiting}</p>}
          </div>
          <div className="flex min-w-0 flex-col items-end gap-1.5">
            <div className="flex flex-wrap justify-end gap-2">
              {offered.map((action) => (
                <Button
                  key={action}
                  variant={action === 'resume' ? 'primary' : 'secondary'}
                  className={
                    action === 'cancel' ? 'border-destructive text-destructive' : undefined
                  }
                  disabled={!campaign.canSend}
                  onClick={(event) => {
                    openerRef.current = event.currentTarget;
                    act.reset();
                    setAsking(action);
                  }}
                >
                  {words[action]}
                </Button>
              ))}
              {permissions.canManage ? (
                <Button
                  variant="secondary"
                  disabled={duplicate.isPending}
                  onClick={() => {
                    setProblem(undefined);
                    duplicate.mutate();
                  }}
                >
                  <Trans>Duplicate as a new draft</Trans>
                </Button>
              ) : null}
            </div>
            {offered.length > 0 && !campaign.canSend ? (
              <p className="text-sm text-body">
                <Trans>Ask an owner or admin to pause, resume or cancel it.</Trans>
              </p>
            ) : null}
            {problem === undefined ? null : (
              <p role="alert" className="text-sm font-medium text-destructive">
                {problem}
              </p>
            )}
          </div>
        </div>
      </section>

      {started ? (
        <section aria-labelledby={numbersHeadingId} className={cardClassName}>
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
            <h2 id={numbersHeadingId} className="text-lg font-medium">
              <Trans>Numbers</Trans>
            </h2>
            {stats.data === undefined ? null : (
              <span className="text-xs text-muted-foreground">{t`Counted ${counted}`}</span>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <div
              role="progressbar"
              aria-label={t`Emails finished with, of the audience`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${String(progress.percent)}%` }}
              />
            </div>
            <p className="text-sm text-body">
              {t`${done} of ${audienceCount} finished with (${percent}%): sent, skipped or failed.`}
            </p>
          </div>
          {stats.isError ? (
            <ListProblem
              onRetry={() => {
                void stats.refetch();
              }}
            >
              {saidBy(stats.error, t`The numbers couldn't be read.`)}
            </ListProblem>
          ) : null}
          <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <Fact label={<Trans>Audience</Trans>}>{number(counts.audience)}</Fact>
            <Fact label={<Trans>Sent</Trans>}>{number(counts.sent)}</Fact>
            <Fact label={<Trans>Not released yet</Trans>}>{number(counts.pending)}</Fact>
            <Fact label={<Trans>Queued at the mailbox</Trans>}>{number(counts.queued)}</Fact>
            <Fact label={<Trans>Skipped</Trans>}>{number(counts.skipped)}</Fact>
            <Fact label={<Trans>Failed</Trans>}>{number(counts.failed)}</Fact>
            {stats.data === undefined ? null : (
              <>
                <Fact label={<Trans>Bounced</Trans>}>{number(stats.data.bounced)}</Fact>
                <Fact label={<Trans>Hard bounced</Trans>}>{number(stats.data.hardBounced)}</Fact>
                <Fact label={<Trans>Unsubscribed</Trans>}>{number(stats.data.unsubscribed)}</Fact>
                <Fact label={<Trans>Batches released</Trans>}>{number(stats.data.batches)}</Fact>
              </>
            )}
          </dl>
          {stats.data === undefined || stats.data.skippedByReason.length === 0 ? null : (
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className={labelClassName}>
                <Trans>Skipped, by reason</Trans>
              </h3>
              <ul className="flex min-w-0 flex-col divide-y divide-border rounded-lg border border-border">
                {stats.data.skippedByReason.map((row) => (
                  <li key={row.reason} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
                    <span className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className="text-md font-medium">
                        {i18n._(skipReasonWords[row.reason].label)}
                      </span>
                      <span className="shrink-0 text-md tabular-nums">{number(row.count)}</span>
                    </span>
                    <span className="text-sm text-body">
                      {i18n._(skipReasonWords[row.reason].todo)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className={hintClassName}>
            <Trans>
              Opens and clicks are not tracked yet. Bounces arrive as delivery reports, sometimes
              hours after an email left.
            </Trans>
          </p>
        </section>
      ) : null}

      {started ? (
        <Recipients campaignId={campaign.id} timeZone={timeZone} live={live} />
      ) : (
        <p className={hintClassName}>
          <Trans>
            The recipients are listed once sending starts: the audience is counted again then.
          </Trans>
        </p>
      )}

      <section aria-labelledby={sentHeadingId} className={cardClassName}>
        <h2 id={sentHeadingId} className="text-lg font-medium">
          {started ? <Trans>What was sent</Trans> : <Trans>What will be sent</Trans>}
        </h2>
        <dl className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label={<Trans>Subject</Trans>}>{campaign.subject}</Fact>
          {campaign.preheader === null ? null : (
            <Fact label={<Trans>Preview text</Trans>}>{campaign.preheader}</Fact>
          )}
          <Fact label={<Trans>From</Trans>}>
            {mailbox === undefined
              ? (campaign.fromName ?? t`The mailbox's own name`)
              : `${campaign.fromName ?? (mailbox.displayName === '' ? mailbox.name : mailbox.displayName)} · ${mailbox.email}`}
          </Fact>
          <Fact label={<Trans>Replies go to</Trans>}>
            {campaign.replyTo ?? t`The mailbox, and so to Conversations`}
          </Fact>
          <Fact label={<Trans>Audience</Trans>}>{audienceSentence(campaign.audience, names)}</Fact>
          <Fact label={<Trans>Format</Trans>}>
            {html === undefined ? <Trans>Plain text</Trans> : <Trans>Formatted</Trans>}
          </Fact>
        </dl>
        <CampaignPreview
          preview={preview}
          empty={text.trim() === '' && (html ?? '').trim() === ''}
          title={t`The email as it was written`}
        />
        <p className={hintClassName}>
          {t`Merge fields such as ${exampleField} are shown as written: each recipient gets their own values. An email without its own unsubscribe link leaves with a standard unsubscribe line at its end.`}
        </p>
      </section>

      {asking === undefined ? null : (
        <ConfirmDialog
          open
          title={confirms[asking].title}
          description={confirms[asking].description}
          confirmLabel={confirms[asking].label}
          destructive={asking === 'cancel'}
          busy={act.isPending}
          problem={
            act.isError
              ? saidBy(act.error, t`That didn't happen. Check your connection and try again.`)
              : undefined
          }
          returnFocus={openerRef}
          onConfirm={() => {
            act.mutate(asking);
          }}
          onClose={() => {
            if (!act.isPending) setAsking(undefined);
          }}
        />
      )}
    </Page>
  );
}

function Recipients({
  campaignId,
  timeZone,
  live,
}: {
  readonly campaignId: string;
  readonly timeZone: string;
  readonly live: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const id = useId();
  const [status, setStatus] = useState<EmailCampaignRecipientStatus | 'all'>('all');
  const [reason, setReason] = useState<EmailCampaignSkipReason | 'all'>('all');
  const filters = { status, reason };
  const list = useInfiniteQuery({
    queryKey: campaignKeys.recipients(business.id, campaignId, filters),
    queryFn: ({ pageParam }) =>
      apiIn(business.id).request(listEmailCampaignRecipients, {
        params: { id: campaignId },
        query: {
          limit: 50,
          ...(status === 'all' ? {} : { status }),
          ...(reason === 'all' ? {} : { reason }),
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
      }),
    initialPageParam: firstPage,
    getNextPageParam: (last) => last.next ?? undefined,
    retry: retryFaults,
    refetchInterval: live ? 30_000 : false,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-labelledby={`${id}-heading`} className={cardClassName}>
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <h2 id={`${id}-heading`} className="text-lg font-medium">
          <Trans>Recipients</Trans>
        </h2>
        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <div className="flex w-44 max-w-full flex-col gap-1">
            <label htmlFor={`${id}-status`} className={labelClassName}>
              <Trans>State</Trans>
            </label>
            <Select
              id={`${id}-status`}
              value={status}
              onValueChange={(next) => {
                setStatus(emailCampaignRecipientStatuses.find((each) => each === next) ?? 'all');
              }}
            >
              <option value="all">{t`Every state`}</option>
              {emailCampaignRecipientStatuses.map((each) => (
                <option key={each} value={each}>
                  {i18n._(recipientStatusWords[each])}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex w-60 max-w-full flex-col gap-1">
            <label htmlFor={`${id}-reason`} className={labelClassName}>
              <Trans>Reason skipped</Trans>
            </label>
            <Select
              id={`${id}-reason`}
              value={reason}
              onValueChange={(next) => {
                setReason(emailCampaignSkipReasons.find((each) => each === next) ?? 'all');
              }}
            >
              <option value="all">{t`Every reason`}</option>
              {emailCampaignSkipReasons.map((each) => (
                <option key={each} value={each}>
                  {i18n._(skipReasonWords[each].label)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>
      {list.isPending ? <p role="status" className="text-sm">{t`Loading recipients…`}</p> : null}
      {list.isError ? (
        <ListProblem
          onRetry={() => {
            void list.refetch();
          }}
        >
          {saidBy(list.error, t`The recipients couldn't be read.`)}
        </ListProblem>
      ) : null}
      {list.isSuccess && items.length === 0 ? (
        <p className={hintClassName}>
          {status === 'all' && reason === 'all' ? (
            <Trans>
              No recipients yet. They are written when sending starts, which can take a minute.
            </Trans>
          ) : (
            <Trans>No recipients match.</Trans>
          )}
        </p>
      ) : null}
      {items.length === 0 ? null : (
        <div className={tableRegionClassName}>
          <table className={tableClassName}>
            <thead>
              <tr>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Contact</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Email</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>What became of it</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Batch</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Sent</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((recipient) => (
                <RecipientRow
                  key={recipient.contactId}
                  recipient={recipient}
                  slug={business.slug}
                  timeZone={timeZone}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          {list.isFetchingNextPage ? t`Loading…` : t`Show more recipients`}
        </Button>
      ) : items.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">
          {plural(items.length, { one: '# recipient shown', other: '# recipients shown' })}
        </p>
      )}
    </section>
  );
}

const recipientTones = {
  pending: 'neutral',
  queued: 'active',
  sent: 'good',
  skipped: 'warning',
  failed: 'bad',
} as const;

function RecipientRow({
  recipient,
  slug,
  timeZone,
}: {
  readonly recipient: EmailCampaignRecipient;
  readonly slug: string;
  readonly timeZone: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  const fields = (recipient.fields ?? []).map(tokenOf).join(', ');
  return (
    <tr>
      <th scope="row" className={`${cellClassName} min-w-40 font-normal`}>
        <Link
          to="/b/$slug/contacts/$contactId"
          params={{ slug, contactId: recipient.contactId }}
          className={`${linkClassName} wrap-anywhere`}
        >
          {recipient.name ?? recipient.email ?? t`A contact with no name`}
        </Link>
      </th>
      <td className={`${cellClassName} min-w-44 wrap-anywhere`}>{recipient.email ?? '—'}</td>
      <td className={`${cellClassName} min-w-56`}>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Pill tone={recipientTones[recipient.status]}>
            {i18n._(recipientStatusWords[recipient.status])}
          </Pill>
          {recipient.bounced ? (
            <Pill tone="bad">
              <Trans>Bounced</Trans>
            </Pill>
          ) : null}
          {recipient.unsubscribed ? (
            <Pill tone="neutral">
              <Trans>Unsubscribed</Trans>
            </Pill>
          ) : null}
        </span>
        {recipient.reason === null ? null : (
          <span className="mt-1 block text-xs text-body">
            {i18n._(skipReasonWords[recipient.reason].label)}
            {fields === '' ? null : `: ${fields}`}
          </span>
        )}
      </td>
      <td className={`${cellClassName} whitespace-nowrap`}>{recipient.batch ?? '—'}</td>
      <td className={`${cellClassName} whitespace-nowrap`}>
        {recipient.sentAt === null ? '—' : momentIn(recipient.sentAt, timeZone)}
      </td>
    </tr>
  );
}
