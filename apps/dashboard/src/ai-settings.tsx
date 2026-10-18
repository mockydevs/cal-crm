// Settings → AI models for a business: its providers, which model does each job, whose keys
// it uses, what it has spent and may spend, privacy, how much the assistant does on its
// own, and the latest calls. Each control saves by itself, whole and against the revision
// the page was showing: a save that finds the settings changed by someone else says so and
// shows theirs.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  AI_LIMITS,
  getAiSettings,
  getAiUsage,
  getAutonomy,
  setAutonomy,
  updateAiSettings,
  updateAiSettingsInput,
  type AiSettings,
  type AiUsage,
  type AutonomyLevel,
  type AutonomySettings,
  type UpdateAiSettingsInput,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { ProvidersSection, type Place } from './ai-settings-providers';
import { AutonomyControl } from './autonomy-control';
import { levelAlreadySet } from './autonomy-rules';
import {
  choiceOf,
  failureText,
  formatDollars,
  isProvider,
  jobDescriptions,
  jobLabel,
  jobNames,
  modelName,
  parseChoice,
  percentOf,
  plainAmount,
  providerNames,
  secondsOf,
  settingsInput,
  sharedProvider,
} from './ai-settings-rules';
import { issuesOf, noRejection, rejection } from './problems';
import { Page } from './shell/page';
import { meQuery, useBusiness } from './workspace';

const cardClassName =
  'flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]';
const settingsKey = (scope: string): readonly string[] => ['ai', scope, 'settings'];
const usageKey = (scope: string): readonly string[] => ['ai', scope, 'usage'];
const autonomyKey = (scope: string): readonly string[] => ['ai', scope, 'autonomy'];

type Change = Partial<Omit<UpdateAiSettingsInput, 'revision'>>;
type Save = UseMutationResult<AiSettings, Error, Change>;

export function AiSettingsPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const agencyName = useSuspenseQuery(meQuery).data.agency.name;
  const client = apiIn(business.id);
  const place: Place = { client, scope: business.id, kind: 'business', agencyName };
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: settingsKey(business.id),
    queryFn: () => client.request(getAiSettings, {}),
  });
  const [outcome, setOutcome] = useState<'saved' | 'replaced' | 'failed'>();
  const save: Save = useMutation({
    mutationFn: (change: Change) => {
      if (settings.data === undefined) throw new Error('The settings are not loaded.');
      return client.request(updateAiSettings, { body: settingsInput(settings.data, change) });
    },
    onMutate: () => {
      setOutcome(undefined);
    },
    onSuccess: async (saved) => {
      cache.setQueryData(settingsKey(business.id), saved);
      setOutcome('saved');
      // A limit changes what the spending card says of it.
      await cache.invalidateQueries({ queryKey: usageKey(business.id) });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setOutcome('replaced');
        await cache.invalidateQueries({ queryKey: settingsKey(business.id) });
      } else setOutcome('failed');
    },
  });
  const forbidden = settings.error instanceof ApiError && settings.error.problem.status === 403;
  return (
    <Page title={t`AI Models`}>
      <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
        <Trans>
          Choose the AI providers this business uses and which model does each job. Keys are stored
          encrypted on this server and are only ever sent to the provider they belong to.
        </Trans>
      </p>
      {settings.isPending ? (
        <p role="status">
          <Trans>Loading AI settings…</Trans>
        </p>
      ) : null}
      {settings.isError ? (
        <p role="alert">
          {forbidden
            ? t`You need permission to manage AI settings.`
            : t`We couldn't load the AI settings.`}{' '}
          {forbidden ? null : (
            <Button
              variant="quiet"
              onClick={() => {
                void settings.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          )}
        </p>
      ) : null}
      {settings.data === undefined ? null : (
        <>
          {outcome === 'replaced' ? (
            <p role="alert" className="text-sm text-destructive">
              <Trans>
                Someone else changed these settings while you had them open. The latest are shown
                here: make your change again.
              </Trans>
            </p>
          ) : null}
          {outcome === 'failed' ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error instanceof ApiError
                ? save.error.message
                : t`Your change wasn't saved. Check your connection and try again.`}
            </p>
          ) : null}
          <p role="status" className="text-sm empty:sr-only">
            {save.isPending ? t`Saving…` : outcome === 'saved' ? t`Saved.` : null}
          </p>
          {settings.data.enabled ? null : (
            <p
              role="alert"
              className="rounded-xl border border-destructive bg-card px-4 py-3 text-md leading-relaxed"
            >
              <Trans>
                AI is turned off for this business. Nothing is sent to any provider until you turn
                it back on under Privacy.
              </Trans>
            </p>
          )}
          {/* Two columns of the same width once there is room for both, ending where the page does. */}
          <div className="grid items-start gap-[18px] grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))]">
            <div className="flex min-w-0 flex-col gap-[18px]">
              <ProvidersSection place={place} />
              <JobsSection place={place} settings={settings.data} save={save} />
            </div>
            <div className="flex min-w-0 flex-col gap-[18px]">
              <KeySourceSection
                settings={settings.data}
                save={save}
                businessName={business.name}
                agencyName={agencyName}
              />
              <SpendingSection place={place} settings={settings.data} save={save} />
              <PrivacySection
                // What is stored is what the form starts from, after anyone's save.
                key={settings.data.revision}
                settings={settings.data}
                save={save}
              />
              <AutonomySection place={place} />
            </div>
          </div>
          <RecentCalls place={place} />
        </>
      )}
    </Page>
  );
}

function useUsage(place: Place): UseQueryResult<AiUsage> {
  return useQuery({
    queryKey: usageKey(place.scope),
    queryFn: () => place.client.request(getAiUsage, {}),
  });
}

function JobsSection({
  place,
  settings,
  save,
}: {
  readonly place: Place;
  readonly settings: AiSettings;
  readonly save: Save;
}): ReactElement {
  const { t, i18n } = useLingui();
  const headingId = useId();
  const usage = useUsage(place);
  const agency = place.agencyName;
  const offered = settings.models.map((each) => ({
    value: choiceOf(each.provider, each.model),
    label: modelName(each.provider, each.model),
  }));
  /** Every model that can be chosen, and the one chosen now even when it cannot be. */
  const optionsWith = (provider: string, model: string): ReactElement[] => {
    const current = choiceOf(provider, model);
    const name = modelName(provider, model);
    const all = offered.some((each) => each.value === current)
      ? offered
      : [...offered, { value: current, label: t`${name} (no key)` }];
    return all.map((each) => (
      <option key={each.value} value={each.value}>
        {each.label}
      </option>
    ));
  };
  const shared = sharedProvider(settings);
  const sharedName =
    shared !== undefined && isProvider(shared) ? i18n._(providerNames[shared]) : shared;
  const backup = settings.backup;
  const backupLabelId = `${headingId}-backup`;
  return (
    <section aria-labelledby={headingId} className={cardClassName}>
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>Which model does each job</Trans>
      </h2>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Tested means the model passed our tests for that job. You can pick any model you've
          connected.
        </Trans>
      </p>
      <ul className="flex flex-col gap-4">
        {settings.jobs.map((job) => {
          const labelId = `${headingId}-${job.job}`;
          const spent = usage.data?.byJob.find((each) => each.job === job.job)?.spent;
          const amount = spent === undefined ? undefined : formatDollars(spent, i18n.locale);
          return (
            <li key={job.job} className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <span className="flex min-w-0 flex-[1_1_220px] flex-col">
                  <span id={labelId} className="font-medium">
                    {i18n._(jobNames[job.job])}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {i18n._(jobDescriptions[job.job])}
                  </span>
                </span>
                <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-1">
                  <Select
                    aria-labelledby={labelId}
                    value={choiceOf(job.provider, job.model)}
                    disabled={save.isPending}
                    onValueChange={(value) => {
                      const choice = parseChoice(value);
                      if (choice === undefined) return;
                      save.mutate({ jobs: { ...settingsInput(settings).jobs, [job.job]: choice } });
                    }}
                  >
                    {optionsWith(job.provider, job.model)}
                  </Select>
                  <span className="text-sm text-muted-foreground">
                    {job.tested ? t`Tested` : t`Not tested yet`}
                    {amount === undefined ? null : <> · {t`${amount} this month`}</>}
                  </span>
                </span>
              </div>
              <Readiness readiness={job.readiness} provider={job.provider} agency={agency} />
            </li>
          );
        })}
        <li className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span className="flex min-w-0 flex-[1_1_220px] flex-col">
              <span id={backupLabelId} className="font-medium">
                <Trans>Backup model</Trans>
              </span>
              <span className="text-sm text-muted-foreground">
                <Trans>Takes over when a model is down or busy</Trans>
              </span>
            </span>
            <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-1">
              <Select
                aria-labelledby={backupLabelId}
                value={backup === null ? 'none' : choiceOf(backup.provider, backup.model)}
                disabled={save.isPending}
                onValueChange={(value) => {
                  save.mutate({ backup: parseChoice(value) ?? null });
                }}
              >
                <option value="none">{t`No backup`}</option>
                {backup === null
                  ? offered.map((each) => (
                      <option key={each.value} value={each.value}>
                        {each.label}
                      </option>
                    ))
                  : optionsWith(backup.provider, backup.model)}
              </Select>
            </span>
          </div>
          {backup === null ? null : (
            <Readiness readiness={backup.readiness} provider={backup.provider} agency={agency} />
          )}
        </li>
      </ul>
      {sharedName === undefined ? null : (
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t`Your backup uses the same provider. Add a second provider so an outage at ${sharedName} can’t stop your automations.`}
        </p>
      )}
    </section>
  );
}

/** The one thing in the way of a model running, and how to clear it. */
function Readiness({
  readiness,
  provider,
  agency,
}: {
  readonly readiness: AiSettings['jobs'][number]['readiness'];
  readonly provider: string;
  readonly agency: string;
}): ReactElement | null {
  const { t, i18n } = useLingui();
  if (readiness === 'ready') return null;
  const name = isProvider(provider) ? i18n._(providerNames[provider]) : provider;
  return (
    <p role="note" className="rounded-xl bg-secondary p-3 text-sm leading-relaxed">
      {readiness === 'no_key'
        ? t`This can't run yet: the keys this business uses have none for ${name}. Add one under Providers, switch whose keys to use, or pick another model.`
        : t`This is paused: the model has no price, so its cost can't be held to your limit. Ask ${agency} to set its price in the agency's AI settings (it can be zero for a server of your own), or choose "Keep going" when the limit is reached.`}
    </p>
  );
}

function KeySourceSection({
  settings,
  save,
  businessName,
  agencyName,
}: {
  readonly settings: AiSettings;
  readonly save: Save;
  readonly businessName: string;
  readonly agencyName: string;
}): ReactElement {
  const { t } = useLingui();
  const groupId = useId();
  const ownId = `${groupId}-own`;
  const agencyId = `${groupId}-agency`;
  const choose = (keySource: 'own' | 'agency') => () => {
    if (keySource !== settings.keySource) save.mutate({ keySource });
  };
  return (
    <section className={cardClassName}>
      <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-3 p-0 text-lg font-semibold">
          <Trans>Whose keys to use</Trans>
        </legend>
        <div className="flex min-w-0 flex-col rounded-xl border border-border p-3">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 font-medium">
            <input
              type="radio"
              name={groupId}
              className="size-4 shrink-0"
              aria-describedby={ownId}
              checked={settings.keySource === 'own'}
              onChange={choose('own')}
            />
            <Trans>This business's own keys</Trans>
          </label>
          <p id={ownId} className="pl-7 text-sm text-muted-foreground">
            {t`The provider bills ${businessName} directly.`}
          </p>
        </div>
        <div className="flex min-w-0 flex-col rounded-xl border border-border p-3">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 font-medium">
            <input
              type="radio"
              name={groupId}
              className="size-4 shrink-0"
              aria-describedby={agencyId}
              checked={settings.keySource === 'agency'}
              onChange={choose('agency')}
            />
            {t`${agencyName}’s keys`}
          </label>
          <p id={agencyId} className="pl-7 text-sm text-muted-foreground">
            {t`${agencyName} pays the provider and bills you for what you use.`}
          </p>
        </div>
      </fieldset>
      {settings.keySource === 'agency' ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Your own keys stay saved but aren't used while this is selected.</Trans>
        </p>
      ) : null}
    </section>
  );
}

function SpendingSection({
  place,
  settings,
  save,
}: {
  readonly place: Place;
  readonly settings: AiSettings;
  readonly save: Save;
}): ReactElement {
  const { t, i18n } = useLingui();
  const headingId = useId();
  const groupId = useId();
  const usage = useUsage(place);
  const [changing, setChanging] = useState(false);
  const limit = settings.monthlyLimit;
  const spent = usage.data?.spent;
  const spentText = spent === undefined ? '' : formatDollars(spent, i18n.locale);
  const limitText = limit === null ? '' : formatDollars(limit, i18n.locale);
  const reached = limit !== null && spent !== undefined && Number(spent) >= Number(limit);
  const unknown = usage.data?.unknownCostCalls ?? 0;
  const percent = limit === null || spent === undefined ? 0 : percentOf(spent, limit);
  return (
    <section aria-labelledby={headingId} className={cardClassName}>
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>Spending</Trans>
      </h2>
      {usage.isPending ? (
        <p role="status">
          <Trans>Loading this month's spending…</Trans>
        </p>
      ) : null}
      {usage.isError ? (
        <p role="alert">
          <Trans>We couldn't load this month's spending.</Trans>{' '}
          <Button
            variant="quiet"
            size="small"
            onClick={() => {
              void usage.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : null}
      {spent === undefined ? null : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[30px] leading-tight font-semibold">{spentText}</span>
            <span className="text-muted-foreground">
              {limit === null ? t`this month` : t`of ${limitText} this month`}
            </span>
          </p>
          {limit === null ? null : (
            <div
              role="progressbar"
              aria-label={t`AI spending this month`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={t`${spentText} of ${limitText}`}
              className="h-2.5 overflow-hidden rounded-full bg-secondary"
            >
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${String(percent)}%` }}
              />
            </div>
          )}
          {unknown === 0 ? null : (
            <p className="text-sm leading-relaxed text-muted-foreground">
              <Plural
                value={unknown}
                one="# call this month has no known cost and isn't in this total: its model has no price, or the server reported no usage."
                other="# calls this month have no known cost and aren't in this total: their models have no price, or the server reported no usage."
              />
            </p>
          )}
        </>
      )}
      {reached ? (
        <p role="alert" className="rounded-xl bg-attention p-3 text-sm text-attention-foreground">
          {settings.atLimit === 'pause'
            ? t`This month's limit of ${limitText} has been reached, so AI is paused. Raise the limit to carry on.`
            : t`This month's limit of ${limitText} has been reached. AI keeps going, as you chose.`}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">
            <Trans>Monthly limit</Trans>
          </span>
          <span className="text-sm text-muted-foreground">
            {limit === null ? t`No limit` : limitText}
          </span>
        </span>
        <Button
          variant="secondary"
          size="small"
          aria-expanded={changing}
          onClick={() => {
            setChanging((value) => !value);
          }}
        >
          <Trans>Change limit</Trans>
        </Button>
      </div>
      {changing ? (
        <LimitForm
          settings={settings}
          save={save}
          close={() => {
            setChanging(false);
          }}
        />
      ) : null}
      <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 font-medium">
          <Trans>When the limit is reached</Trans>
        </legend>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="radio"
            name={groupId}
            className="size-4 shrink-0"
            checked={settings.atLimit === 'pause'}
            onChange={() => {
              if (settings.atLimit !== 'pause') save.mutate({ atLimit: 'pause' });
            }}
          />
          <Trans>Pause AI and tell me</Trans>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="radio"
            name={groupId}
            className="size-4 shrink-0"
            checked={settings.atLimit === 'continue'}
            onChange={() => {
              if (settings.atLimit !== 'continue') save.mutate({ atLimit: 'continue' });
            }}
          />
          <Trans>Keep going and tell me</Trans>
        </label>
      </fieldset>
      <p className="text-sm leading-relaxed text-muted-foreground">
        <Trans>
          Paused automations with AI steps wait until you raise the limit. Costs are estimated from
          each provider's published prices, in US dollars.
        </Trans>
      </p>
    </section>
  );
}

function LimitForm({
  settings,
  save,
  close,
}: {
  readonly settings: AiSettings;
  readonly save: Save;
  readonly close: () => void;
}): ReactElement {
  const { t } = useLingui();
  const [amount, setAmount] = useState(() =>
    settings.monthlyLimit === null ? '' : plainAmount(settings.monthlyLimit),
  );
  const [problem, setProblem] = useState(noRejection);
  const saveLimit = (monthlyLimit: string | null): void => {
    const parsed = updateAiSettingsInput.safeParse(settingsInput(settings, { monthlyLimit }));
    if (!parsed.success) {
      setProblem(rejection(issuesOf(parsed.error)));
      return;
    }
    setProblem(noRejection);
    save.mutate({ monthlyLimit }, { onSuccess: close });
  };
  return (
    <Form<Record<string, unknown>>
      className="min-w-0"
      errors={problem.fields}
      onFormSubmit={() => {
        saveLimit(amount.trim());
      }}
    >
      <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
        <Field name="monthlyLimit">
          <FieldLabel>
            <Trans>Monthly limit in US dollars</Trans>
          </FieldLabel>
          <Input
            value={amount}
            required
            inputMode="decimal"
            autoComplete="off"
            placeholder={t`50`}
            onValueChange={setAmount}
          />
          <FieldDescription>
            <Trans>The month is the calendar month, by the clock in UTC.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="small">
            <Trans>Save limit</Trans>
          </Button>
          {settings.monthlyLimit === null ? null : (
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() => {
                saveLimit(null);
              }}
            >
              <Trans>Remove limit</Trans>
            </Button>
          )}
          <Button type="button" variant="quiet" size="small" onClick={close}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </fieldset>
    </Form>
  );
}

function PrivacySection({
  settings,
  save,
}: {
  readonly settings: AiSettings;
  readonly save: Save;
}): ReactElement {
  const { t } = useLingui();
  const headingId = useId();
  const maskId = `${headingId}-mask`;
  const logId = `${headingId}-log`;
  const stored = settings.requestLogDays;
  const [days, setDays] = useState(String(stored === 0 ? 30 : stored));
  const [problem, setProblem] = useState(noRejection);
  const keeping = stored > 0;
  const most = AI_LIMITS.logDays;
  const saveDays = (): void => {
    const requestLogDays = /^\d+$/.test(days.trim()) ? Number(days.trim()) : Number.NaN;
    const parsed = updateAiSettingsInput.safeParse(settingsInput(settings, { requestLogDays }));
    if (!parsed.success || requestLogDays === 0) {
      setProblem({
        fields: { requestLogDays: t`Enter a whole number of days from 1 to ${most}.` },
        form: undefined,
      });
      return;
    }
    setProblem(noRejection);
    save.mutate({ requestLogDays });
  };
  return (
    <section aria-labelledby={headingId} className={cardClassName}>
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>Privacy</Trans>
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        <Trans>
          Requests go straight from this server to the provider you chose. Nothing passes through
          anyone else.
        </Trans>
      </p>
      <div className="flex min-w-0 flex-col">
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="size-4 shrink-0"
            aria-describedby={maskId}
            checked={settings.maskContactDetails}
            disabled={save.isPending}
            onChange={(event) => {
              save.mutate({ maskContactDetails: event.target.checked });
            }}
          />
          <Trans>Hide phone numbers and email addresses from AI</Trans>
        </label>
        <p id={maskId} className="pl-7 text-sm text-muted-foreground">
          <Trans>
            They are replaced before a request is sent. This catches the usual ways of writing them,
            not every one.
          </Trans>
        </p>
      </div>
      <div className="flex min-w-0 flex-col">
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="size-4 shrink-0"
            aria-describedby={logId}
            checked={keeping}
            disabled={save.isPending}
            onChange={(event) => {
              save.mutate({ requestLogDays: event.target.checked ? 30 : 0 });
            }}
          />
          <Trans>Keep a log of AI requests</Trans>
        </label>
        <p id={logId} className="pl-7 text-sm text-muted-foreground">
          {keeping ? (
            <Plural
              value={stored}
              one="What was sent and answered is kept for # day, always with phone numbers and email addresses hidden, then cleared."
              other="What was sent and answered is kept for # days, always with phone numbers and email addresses hidden, then cleared."
            />
          ) : (
            <Trans>Nothing of what is sent or answered is kept. Each call's cost still is.</Trans>
          )}
        </p>
      </div>
      {keeping ? (
        <Form<Record<string, unknown>>
          className="min-w-0"
          errors={problem.fields}
          onFormSubmit={saveDays}
        >
          <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
            <Field name="requestLogDays">
              <FieldLabel>
                <Trans>Days to keep the log</Trans>
              </FieldLabel>
              <Input
                value={days}
                required
                inputMode="numeric"
                autoComplete="off"
                onValueChange={setDays}
              />
              <FieldError />
            </Field>
            <Button type="submit" variant="secondary" size="small" className="self-start">
              <Trans>Save days</Trans>
            </Button>
          </fieldset>
        </Form>
      ) : null}
      <Button
        variant="secondary"
        size="small"
        className="self-start"
        disabled={save.isPending}
        onClick={() => {
          save.mutate({ enabled: !settings.enabled });
        }}
      >
        {settings.enabled ? t`Turn off AI for this business` : t`Turn AI back on`}
      </Button>
    </section>
  );
}

/**
 * The business's own level for replies in the Inbox: what applies to every contact who has
 * no level of their own. It is saved the moment it is chosen, apart from the rest of the
 * page: it is a rule about the assistant, not one of the AI settings and their revision.
 */
function AutonomySection({ place }: { readonly place: Place }): ReactElement {
  const headingId = useId();
  const cache = useQueryClient();
  const autonomy = useQuery({
    queryKey: autonomyKey(place.scope),
    queryFn: () => place.client.request(getAutonomy, { query: {} }),
  });
  const replies = autonomy.data?.items.find(
    (each) => each.agent === 'inbox' && each.action === 'send_message',
  );
  const setLevel = async (level: AutonomyLevel | null): Promise<void> => {
    // By what was last read, a moment ahead of the page: a second click of a double click
    // saves nothing twice.
    const read = cache
      .getQueryData<AutonomySettings>(autonomyKey(place.scope))
      ?.items.find((each) => each.agent === 'inbox' && each.action === 'send_message');
    if (read !== undefined && levelAlreadySet(read, level, 'business')) return;
    const saved = await place.client.request(setAutonomy, {
      body: { agent: 'inbox', action: 'send_message', contactId: null, level },
    });
    cache.setQueryData<AutonomySettings>(autonomyKey(place.scope), (current) =>
      current === undefined
        ? current
        : {
            ...current,
            items: current.items.map((each) =>
              each.agent === saved.agent && each.action === saved.action ? saved : each,
            ),
          },
    );
  };
  return (
    <section aria-labelledby={headingId} className={cardClassName}>
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>How much your assistant does on its own</Trans>
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        <Trans>
          For replies to messages in Conversations. A contact can have a setting of their own,
          chosen in their conversation.
        </Trans>
      </p>
      {autonomy.isPending ? (
        <p role="status">
          <Trans>Loading this setting…</Trans>
        </p>
      ) : null}
      {autonomy.isError ? (
        <p role="alert">
          <Trans>We couldn't load this setting.</Trans>{' '}
          <Button
            variant="quiet"
            size="small"
            onClick={() => {
              void autonomy.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : null}
      {autonomy.data === undefined || replies === undefined ? null : (
        <AutonomyControl
          labelledBy={headingId}
          level={replies.level}
          who={undefined}
          canChange={autonomy.data.canChange}
          onSet={setLevel}
        />
      )}
    </section>
  );
}

function RecentCalls({ place }: { readonly place: Place }): ReactElement {
  const { t, i18n } = useLingui();
  const headingId = useId();
  const usage = useUsage(place);
  const times = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const calls = usage.data?.recent ?? [];
  const result = (call: AiUsage['recent'][number]): string => {
    if (call.status === 'ok') return t`Answered`;
    if (call.status === 'refused') return t`The model declined`;
    if (call.status === 'started') return t`In progress`;
    const reason = failureText(call.errorCode);
    const why = reason === undefined ? t`It failed.` : i18n._(reason);
    return call.status === 'fell_back' ? t`${why} The backup model took over.` : why;
  };
  return (
    <section aria-labelledby={headingId} className={cardClassName}>
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>Recent calls</Trans>
      </h2>
      <p className="text-sm text-muted-foreground">
        <Trans>
          The latest calls to a model, tests included. What was said in a call is not shown here.
        </Trans>
      </p>
      {usage.data !== undefined && calls.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>No calls yet. Test a provider to see the first one here.</Trans>
        </p>
      ) : null}
      {calls.length === 0 ? null : (
        <ul aria-labelledby={headingId} className="flex flex-col gap-2">
          {calls.map((call) => {
            const label = jobLabel(call.job);
            const cost =
              call.costEstimate === null
                ? undefined
                : formatDollars(call.costEstimate, i18n.locale);
            const seconds =
              call.latencyMs === null ? undefined : secondsOf(call.latencyMs, i18n.locale);
            return (
              <li
                key={call.id}
                className="flex min-w-0 flex-col gap-1 rounded-xl border border-border p-3 text-sm"
              >
                <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="font-medium">
                    {label === undefined ? call.job : i18n._(label)}
                  </span>
                  <time dateTime={call.startedAt} className="text-muted-foreground">
                    {times.format(new Date(call.startedAt))}
                  </time>
                </span>
                <span className="break-all text-muted-foreground">
                  {modelName(call.provider, call.model)}
                </span>
                <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
                  <span>{result(call)}</span>
                  {call.status === 'started' ? null : (
                    <span>{cost === undefined ? t`Cost unknown` : t`Cost ${cost}`}</span>
                  )}
                  {seconds === undefined ? null : <span>{t`${seconds} seconds`}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
