// Settings → Email Services: the business's own ceiling on campaign email, beside the
// mailboxes' sending limits it works with. One number, with what it really does: it spreads
// a large send over days and holds nothing else back.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getEmailCampaignSettings,
  updateEmailCampaignSettings,
  type EmailCampaignSettings,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { useBusiness } from '../workspace';
import { campaignKeys, isRefusal, retryFaults, saidBy } from './data';
import { hintClassName, labelClassName, linkClassName, problemClassName } from './parts';

export default function CampaignLimit(): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  const settings = useQuery({
    queryKey: campaignKeys.settings(business.id),
    queryFn: () => apiIn(business.id).request(getEmailCampaignSettings, {}),
    retry: retryFaults,
  });
  // Said here, not in the form: a save starts the form again from what was saved.
  const [notice, setNotice] = useState('');
  // Someone who may not manage mailboxes is told so by the page itself, once.
  if (isRefusal(settings.error, 403)) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-[22px]"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>Campaign sending limit</Trans>
      </h2>
      {settings.isPending ? (
        <p role="status" className="text-sm">{t`Loading the campaign limit…`}</p>
      ) : null}
      {settings.isError ? (
        <p role="alert" className="text-sm">
          {saidBy(settings.error, t`We couldn't load the campaign limit.`)}{' '}
          <button
            type="button"
            className={linkClassName}
            onClick={() => {
              void settings.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </button>
        </p>
      ) : null}
      {settings.data === undefined ? null : (
        // A save, mine or someone else's, starts the form again from what was saved.
        <LimitForm
          key={String(settings.data.dailyLimit)}
          settings={settings.data}
          onNotice={setNotice}
        />
      )}
      <p role="status" className={notice === '' ? 'sr-only' : 'text-sm font-medium text-success'}>
        {notice}
      </p>
    </section>
  );
}

function LimitForm({
  settings,
  onNotice: setNotice,
}: {
  readonly settings: EmailCampaignSettings;
  readonly onNotice: (notice: string) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const id = useId();
  const [typed, setTyped] = useState(
    settings.dailyLimit === null ? '' : String(settings.dailyLimit),
  );
  const [problem, setProblem] = useState<string>();
  const save = useMutation({
    mutationFn: (dailyLimit: number | null) =>
      apiIn(business.id).request(updateEmailCampaignSettings, { body: { dailyLimit } }),
    onSuccess: (saved) => {
      cache.setQueryData(campaignKeys.settings(business.id), saved);
      // A campaign's checks count with this number.
      void cache.invalidateQueries({ queryKey: campaignKeys.all(business.id) });
      setNotice(t`Campaign limit saved.`);
    },
    onError: (error) => {
      setNotice('');
      setProblem(saidBy(error, t`The limit wasn't saved. Check your connection and try again.`));
    },
  });
  const number = (value: number): string => value.toLocaleString(i18n.locale);
  const agency = settings.agencyDailyLimit === null ? '' : number(settings.agencyDailyLimit);
  const { percent, afterSent } = settings.bounceRatePause;
  const after = number(afterSent);
  const submit = (): void => {
    setNotice('');
    const text = typed.trim();
    if (text === '') {
      setProblem(undefined);
      save.mutate(null);
      return;
    }
    const value = /^\d{1,6}$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > 100_000) {
      setProblem(t`Give a whole number from 1 to 100,000, or leave it empty.`);
      return;
    }
    setProblem(undefined);
    save.mutate(value);
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="max-w-[760px] text-sm leading-relaxed text-body">
        <Trans>
          The most campaign emails this business releases in 24 hours, over all its campaigns.
          Replies and workflow emails always leave first and are never held back by it. A campaign
          larger than the limit spreads over several days, and says how many before it is sent.
        </Trans>
      </p>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <div className="flex w-56 max-w-full flex-col gap-1">
          <label htmlFor={`${id}-limit`} className={labelClassName}>
            <Trans>Campaign emails a day</Trans>
          </label>
          <Input
            id={`${id}-limit`}
            inputMode="numeric"
            value={typed}
            disabled={!settings.canManage || save.isPending}
            aria-invalid={problem !== undefined}
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              setTyped(event.target.value);
              setProblem(undefined);
              setNotice('');
            }}
          />
        </div>
        {settings.canManage ? (
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t`Saving…` : t`Save limit`}
          </Button>
        ) : null}
      </div>
      <p id={`${id}-hint`} className={hintClassName}>
        {settings.canManage ? (
          <Trans>Empty, each campaign mailbox's own daily cap is the limit.</Trans>
        ) : (
          <Trans>Your role can read this limit and not change it.</Trans>
        )}
      </p>
      {problem === undefined ? null : (
        <p role="alert" className={problemClassName}>
          {problem}
        </p>
      )}
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-body">
        {settings.agencyDailyLimit === null ? null : (
          <li>
            {t`This install also limits the whole agency to ${agency} campaign emails in 24 hours, over all its businesses.`}
          </li>
        )}
        <li>
          {t`A campaign pauses itself once ${percent}% of its sent emails hard-bounced, counted after ${after} were sent.`}
        </li>
      </ul>
    </form>
  );
}
