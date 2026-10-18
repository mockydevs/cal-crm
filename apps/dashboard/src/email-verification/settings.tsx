// Settings → Email Services → Email Verification: whether addresses are checked before an
// email is sent to them, whether old results are checked again, how many checks a day, and
// the provider that checks a mailbox (Emailable), with its key, a test and Disconnect.
// Without a provider only the domain is checked. Only someone who may manage email
// verification sees it.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  connectEmailVerificationProvider,
  disconnectEmailVerificationProvider,
  getEmailVerificationSettings,
  testEmailVerificationProvider,
  updateEmailVerificationSettings,
  type EmailVerificationSettings,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { SmallDialog } from '../settings-list';
import { useBusiness } from '../workspace';

type UpdateEmailVerificationSettings = Pick<
  EmailVerificationSettings,
  'enabled' | 'reverifyAfter90Days' | 'dailyLimit'
>;

const settingsKey = (businessId: string): readonly string[] => [
  'b',
  businessId,
  'email-verification-settings',
];
/** A test runs on the server after it answers: the settings are read again after these waits. */
const TEST_READS_MS = [3000, 10_000] as const;

const labelClassName = 'text-sm font-medium text-foreground';
const hintClassName = 'text-sm text-muted-foreground';
const problemClassName = 'text-sm font-medium text-destructive';

function saidBy(error: unknown, fallback: string): string {
  return error instanceof ApiError
    ? (error.problem.errors?.find((issue) => issue.message.trim() !== '')?.message ??
        error.problem.detail ??
        error.message)
    : fallback;
}

export default function EmailVerificationSettingsSection(): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  const settings = useQuery({
    queryKey: settingsKey(business.id),
    queryFn: () => apiIn(business.id).request(getEmailVerificationSettings, {}),
    retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
  });
  // Said here, not in the form: a save starts the form again from what was saved.
  const [notice, setNotice] = useState('');
  // Someone who may not manage email verification is not shown it.
  if (settings.error instanceof ApiError && settings.error.status === 403) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>Email Verification</Trans>
      </h2>
      <p className="max-w-[760px] text-sm leading-relaxed text-body">
        <Trans>
          Checks each address before the first email is sent to it. Invalid addresses are not
          emailed. Risky ones are still emailed, with a warning on the contact.
        </Trans>
      </p>
      {settings.isPending ? (
        <p role="status" className="text-sm">{t`Loading email verification…`}</p>
      ) : null}
      {settings.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{saidBy(settings.error, t`We couldn't load email verification.`)}</p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void settings.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {settings.data === undefined ? null : (
        <>
          <SettingsForm
            key={`${String(settings.data.enabled)}-${String(settings.data.reverifyAfter90Days)}-${String(settings.data.dailyLimit)}`}
            settings={settings.data}
            onNotice={setNotice}
          />
          <Provider settings={settings.data} onNotice={setNotice} />
        </>
      )}
      <p role="status" className={notice === '' ? 'sr-only' : 'text-sm font-medium text-success'}>
        {notice}
      </p>
    </section>
  );
}

function SettingsForm({
  settings,
  onNotice: setNotice,
}: {
  readonly settings: EmailVerificationSettings;
  readonly onNotice: (notice: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const id = useId();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [reverify, setReverify] = useState(settings.reverifyAfter90Days);
  const [limit, setLimit] = useState(String(settings.dailyLimit));
  const [problem, setProblem] = useState<string>();
  const save = useMutation({
    mutationFn: (body: UpdateEmailVerificationSettings) =>
      apiIn(business.id).request(updateEmailVerificationSettings, { body }),
    onSuccess: (saved) => {
      cache.setQueryData(settingsKey(business.id), saved);
      setNotice(t`Email verification saved.`);
    },
    onError: (error) => {
      setNotice('');
      setProblem(
        saidBy(error, t`The settings weren't saved. Check your connection and try again.`),
      );
    },
  });
  return (
    <form
      aria-label={t`Verification settings`}
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setNotice('');
        const text = limit.trim();
        const dailyLimit = /^\d{1,6}$/.test(text) ? Number(text) : Number.NaN;
        if (!Number.isInteger(dailyLimit) || dailyLimit > 100_000) {
          setProblem(t`Give a whole number from 0 to 100,000.`);
          return;
        }
        setProblem(undefined);
        save.mutate({ enabled, reverifyAfter90Days: reverify, dailyLimit });
      }}
    >
      <div className="flex min-h-11 items-start gap-2.5 text-sm lg:min-h-8">
        <input
          id={`${id}-enabled`}
          type="checkbox"
          className="mt-0.5 size-6 shrink-0 accent-primary lg:size-4"
          checked={enabled}
          disabled={save.isPending}
          aria-describedby={`${id}-enabled-hint`}
          onChange={(event) => {
            setEnabled(event.target.checked);
          }}
        />
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${id}-enabled`} className={labelClassName}>
            <Trans>Verify email addresses before sending</Trans>
          </label>
          <span id={`${id}-enabled-hint`} className={hintClassName}>
            <Trans>An email waits for its address to be checked, once, before it is sent.</Trans>
          </span>
        </div>
      </div>
      <div className="flex min-h-11 items-start gap-2.5 text-sm lg:min-h-8">
        <input
          id={`${id}-reverify`}
          type="checkbox"
          className="mt-0.5 size-6 shrink-0 accent-primary lg:size-4"
          checked={reverify}
          disabled={save.isPending}
          aria-describedby={`${id}-reverify-hint`}
          onChange={(event) => {
            setReverify(event.target.checked);
          }}
        />
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${id}-reverify`} className={labelClassName}>
            <Trans>Re-verify results older than 90 days</Trans>
          </label>
          <span id={`${id}-reverify-hint`} className={hintClassName}>
            <Trans>An older result is checked again before the next email.</Trans>
          </span>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <div className="flex w-56 max-w-full flex-col gap-1">
          <label htmlFor={`${id}-limit`} className={labelClassName}>
            <Trans>Daily verification limit</Trans>
          </label>
          <Input
            id={`${id}-limit`}
            inputMode="numeric"
            value={limit}
            disabled={save.isPending}
            aria-invalid={problem !== undefined}
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              setLimit(event.target.value);
              setProblem(undefined);
              setNotice('');
            }}
          />
        </div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t`Saving…` : t`Save`}
        </Button>
      </div>
      <p id={`${id}-hint`} className={hintClassName}>
        <Trans>
          The most mailbox checks the provider is asked for in a day. Checks past it wait for the
          next day.
        </Trans>
      </p>
      {problem === undefined ? null : (
        <p role="alert" className={problemClassName}>
          {problem}
        </p>
      )}
    </form>
  );
}

function Provider({
  settings,
  onNotice: setNotice,
}: {
  readonly settings: EmailVerificationSettings;
  readonly onNotice: (notice: string) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const headingId = useId();
  const keyId = useId();
  const [connecting, setConnecting] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [problem, setProblem] = useState<string>();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [testedAt, setTestedAt] = useState<number>();
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const client = apiIn(business.id);
  const saved = (next: EmailVerificationSettings): void => {
    cache.setQueryData(settingsKey(business.id), next);
  };
  // A test is run by the server after it answers: read the result a little later.
  useEffect(() => {
    if (testedAt === undefined) return;
    const read = (): void => {
      void cache.invalidateQueries({ queryKey: settingsKey(business.id) });
    };
    const soon = setTimeout(read, TEST_READS_MS[0]);
    const later = setTimeout(read, TEST_READS_MS[1]);
    return () => {
      clearTimeout(soon);
      clearTimeout(later);
    };
  }, [business.id, cache, testedAt]);
  // The key field takes the keyboard when it opens, and only then.
  useEffect(() => {
    if (connecting) keyRef.current?.focus();
  }, [connecting]);
  // The key is read from the field, never passed to mutate: the query client keeps a
  // mutation's variables after it has finished.
  const connect = useMutation({
    mutationFn: () =>
      client.request(connectEmailVerificationProvider, { body: { apiKey: apiKey.trim() } }),
    onMutate: () => {
      setNotice('');
      setProblem(undefined);
    },
    onSuccess: (next) => {
      saved(next);
      setApiKey('');
      setConnecting(false);
      setNotice(t`Emailable is connected.`);
    },
    onError: (error) => {
      setProblem(
        saidBy(error, t`Emailable wasn't connected. Check your connection and try again.`),
      );
    },
  });
  const test = useMutation({
    mutationFn: () => client.request(testEmailVerificationProvider, {}),
    onMutate: () => {
      setNotice('');
      setProblem(undefined);
    },
    onSuccess: (next) => {
      saved(next);
      setTestedAt(Date.now());
      setNotice(t`Testing the connection. Its credits and status update here in a moment.`);
    },
    onError: (error) => {
      setProblem(saidBy(error, t`The test didn't start. Check your connection and try again.`));
    },
  });
  const disconnect = useMutation({
    mutationFn: () => client.request(disconnectEmailVerificationProvider, {}),
    onMutate: () => {
      setNotice('');
      setProblem(undefined);
    },
    onSuccess: (next) => {
      saved(next);
      setConfirmDisconnect(false);
      setNotice(t`Emailable is disconnected. Only domains are checked now.`);
    },
    onError: (error) => {
      setProblem(
        saidBy(error, t`Emailable wasn't disconnected. Check your connection and try again.`),
      );
    },
  });
  const busy = connect.isPending || test.isPending || disconnect.isPending;
  const connected = settings.provider === 'connected' || settings.provider === 'failing';
  const credits =
    settings.availableCredits === null
      ? undefined
      : settings.availableCredits.toLocaleString(i18n.locale);
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 border-t border-border pt-4"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-md font-semibold">
          <Trans>Verification provider</Trans>
        </h3>
        {settings.provider === 'connected' ? (
          <Badge variant="neutral" className="px-2 py-0.5 text-xs">
            <Trans>Emailable connected</Trans>
          </Badge>
        ) : null}
        {settings.provider === 'failing' ? (
          <Badge variant="attention" className="px-2 py-0.5 text-xs">
            <Trans>Emailable needs attention</Trans>
          </Badge>
        ) : null}
        {connected && settings.testMode === true ? (
          <Badge variant="neutral" className="px-2 py-0.5 text-xs">
            <Trans>Test mode</Trans>
          </Badge>
        ) : null}
      </div>
      {connected ? (
        <>
          {settings.provider === 'failing' ? (
            <p className="text-sm text-body">
              <Trans>
                Emailable stopped accepting the saved key. Only domains are checked until it is
                connected again with a working key.
              </Trans>
            </p>
          ) : null}
          {credits === undefined ? null : (
            <p className="text-sm text-body">{t`${credits} credits left.`}</p>
          )}
          {settings.testMode === true ? (
            <p className={hintClassName}>
              <Trans>A test key gives made-up results and uses no credits.</Trans>
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-body">
          <Trans>Mailbox checks need a verification provider. Domain checks still run.</Trans>
        </p>
      )}
      {connecting ? (
        <form
          aria-label={t`Connect Emailable`}
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (apiKey.trim() === '') {
              setProblem(t`Enter the API key from your Emailable account.`);
              return;
            }
            connect.mutate();
          }}
        >
          <div className="flex max-w-md min-w-0 flex-col gap-1">
            <label htmlFor={keyId} className={labelClassName}>
              <Trans>Emailable API key</Trans>
            </label>
            <Input
              id={keyId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={1024}
              value={apiKey}
              disabled={busy}
              aria-invalid={problem !== undefined}
              aria-describedby={`${keyId}-hint`}
              ref={keyRef}
              onChange={(event) => {
                setApiKey(event.target.value);
                setProblem(undefined);
              }}
            />
            <p id={`${keyId}-hint`} className={hintClassName}>
              <Trans>
                The key is checked with Emailable before it is saved, and is never shown again.
              </Trans>
            </p>
          </div>
          {problem === undefined ? null : (
            <p role="alert" className={problemClassName}>
              {problem}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {connect.isPending ? t`Connecting…` : t`Connect`}
            </Button>
            <Button
              type="button"
              variant="quiet"
              disabled={busy}
              onClick={() => {
                setConnecting(false);
                setApiKey('');
                setProblem(undefined);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={connected ? 'secondary' : 'primary'}
              disabled={busy}
              onClick={() => {
                setNotice('');
                setProblem(undefined);
                setConnecting(true);
              }}
            >
              {connected ? t`Replace key` : t`Connect Emailable`}
            </Button>
            {connected ? (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    test.mutate();
                  }}
                >
                  {test.isPending ? t`Testing…` : t`Test connection`}
                </Button>
                <Button
                  ref={disconnectRef}
                  variant="secondary"
                  className="border-destructive text-destructive"
                  disabled={busy}
                  onClick={() => {
                    setProblem(undefined);
                    setConfirmDisconnect(true);
                  }}
                >
                  <Trans>Disconnect</Trans>
                </Button>
              </>
            ) : null}
          </div>
          {problem === undefined || confirmDisconnect ? null : (
            <p role="alert" className={problemClassName}>
              {problem}
            </p>
          )}
        </>
      )}
      {confirmDisconnect ? (
        <SmallDialog
          open
          title={t`Disconnect Emailable?`}
          description={t`Mailboxes are no longer checked: only domains are. Results already found are kept.`}
          returnFocus={disconnectRef}
          onClose={() => {
            setConfirmDisconnect(false);
            setProblem(undefined);
          }}
        >
          {problem === undefined ? null : (
            <p role="alert" className={problemClassName}>
              {problem}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setConfirmDisconnect(false);
                setProblem(undefined);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="secondary"
              className="border-destructive text-destructive"
              disabled={busy}
              onClick={() => {
                disconnect.mutate();
              }}
            >
              <Trans>Disconnect</Trans>
            </Button>
          </div>
        </SmallDialog>
      ) : null}
    </section>
  );
}
