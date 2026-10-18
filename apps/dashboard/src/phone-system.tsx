// Settings → Phone System, as GoHighLevel lays it out: whether calls work at all, then
// "Phone numbers" (the registered numbers, searched, with which is the default, who each is
// assigned to and where its calls go, each opened in its own configuration, and below them
// the Twilio account they come from) and "Voice settings" (the business's calling
// defaults). Everything here is settings: nothing is bought, registered with a carrier or
// called from this page.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getMyPermissions,
  getPhoneSystemSettings,
  listPhoneSystemNumbers,
  updatePhoneSystemSettings,
  type Permission,
  type PhoneNumberSettings,
  type PhoneSystemSettings,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { lazy, Suspense, useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { CallingSetupCard } from './phone-system-calling';
import { NumberEditor } from './phone-system-number';
import {
  CallingNotice,
  personName,
  phoneNumbersKey,
  phoneSettingsKey,
  statusVariant,
  Tabs,
  usePhoneMembers,
  useStatusWords,
  useWarningWords,
  type PhoneMembers,
} from './phone-system-parts';
import { destinationOf, matchesSearch, systemDraftOf, systemInput } from './phone-system-rules';
import { VoiceSettingsForm } from './phone-system-voice';
import { isStale, retryFaults } from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

type Section = 'numbers' | 'voice';
// The SMS credential UI is needed only by SMS managers; defer its code as well as reads.
// https://react.dev/reference/react/lazy
const SmsConnections = lazy(async () => ({
  default: (await import('./sms-settings')).SmsConnections,
}));

const forbidden = (error: unknown): boolean => error instanceof ApiError && error.status === 403;

/**
 * The page asks first what the person may change here, then reads only what that allows:
 * managing calls (phone.manage) shows the numbers' settings and the voice settings, and
 * managing SMS (sms.manage) the Twilio account and its numbers. Someone with only one never
 * asks for the other's answers or sees its controls.
 */
export function PhoneSystemPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const grants = useQuery({
    queryKey: ['b', business.id, 'my-permissions'],
    queryFn: () => apiIn(business.id).request(getMyPermissions, {}),
    retry: retryFaults,
  });
  const may = (permission: Permission): boolean =>
    grants.data?.permissions.includes(permission) === true;
  return (
    <Page title={t`Phone System`}>
      <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
        <Trans>
          Your business's phone numbers, how their calls are handled, and the Twilio account they
          come from.
        </Trans>
      </p>
      {grants.isPending ? (
        <p role="status">
          <Trans>Loading…</Trans>
        </p>
      ) : grants.isError ? (
        <LoadFailed
          onRetry={() => {
            void grants.refetch();
          }}
        >
          <Trans>We couldn't check what you may change here.</Trans>
        </LoadFailed>
      ) : may('phone.manage') ? (
        <CallSettings managesSms={may('sms.manage')} />
      ) : may('sms.manage') ? (
        <TwilioConnections>
          <SmsConnections registeredNumbers />
        </TwilioConnections>
      ) : (
        <p role="alert">
          <Trans>You need permission to manage the phone system or SMS to use this page.</Trans>
        </p>
      )}
    </Page>
  );
}

function TwilioConnections({ children }: { readonly children: ReactElement }): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4">
      <h2 id={id} className="text-xl font-semibold">
        <Trans>Twilio connections</Trans>
      </h2>
      <Suspense
        fallback={
          <p role="status">
            <Trans>Loading…</Trans>
          </p>
        }
      >
        {children}
      </Suspense>
    </section>
  );
}

/** Everything someone who manages calls sees, with the Twilio account if they manage SMS. */
function CallSettings({ managesSms }: { readonly managesSms: boolean }): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const business = useBusiness();
  const client = apiIn(business.id);
  const [section, setSection] = useState<Section>('numbers');
  const settings = useQuery({
    queryKey: phoneSettingsKey(business.id),
    queryFn: () => client.request(getPhoneSystemSettings, {}),
    retry: retryFaults,
  });
  const numbers = useQuery({
    queryKey: phoneNumbersKey(business.id),
    queryFn: () => client.request(listPhoneSystemNumbers, {}),
    retry: retryFaults,
  });
  const members = usePhoneMembers(business.id);
  const refused = forbidden(settings.error) || forbidden(numbers.error);
  return (
    <>
      {settings.data === undefined ? null : <CallingNotice calling={settings.data.calling} />}
      {refused ? null : <CallingSetupCard businessId={business.id} />}
      <Tabs
        label={t`Phone System`}
        tabs={[
          { id: 'numbers', label: t`Phone numbers` },
          { id: 'voice', label: t`Voice settings` },
        ]}
        current={section}
        idBase={id}
        onChange={setSection}
      />
      <div
        role="tabpanel"
        id={`${id}-panel-numbers`}
        aria-labelledby={`${id}-tab-numbers`}
        hidden={section !== 'numbers'}
        className="flex min-w-0 flex-col gap-5"
      >
        {refused ? (
          <Refused />
        ) : (
          <NumberInventory
            businessId={business.id}
            numbers={numbers}
            settings={settings.data}
            members={members}
          />
        )}
        <TwilioConnections>
          {managesSms ? (
            <SmsConnections registeredNumbers={false} />
          ) : (
            <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
              <Trans>
                Connecting a Twilio account and registering numbers needs permission to manage SMS.
                Ask someone who has it to add the numbers you need.
              </Trans>
            </p>
          )}
        </TwilioConnections>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-voice`}
        aria-labelledby={`${id}-tab-voice`}
        hidden={section !== 'voice'}
        className="flex min-w-0 flex-col gap-5"
      >
        {refused ? (
          <Refused />
        ) : settings.isPending || numbers.isPending ? (
          <p role="status">
            <Trans>Loading voice settings…</Trans>
          </p>
        ) : settings.isError || numbers.isError ? (
          <LoadFailed
            onRetry={() => {
              void settings.refetch();
              void numbers.refetch();
            }}
          >
            <Trans>We couldn't load the voice settings.</Trans>
          </LoadFailed>
        ) : (
          <VoiceSettingsForm
            businessId={business.id}
            settings={settings.data}
            numbers={numbers.data.data}
            reloading={settings.isFetching}
            onReload={() => settings.refetch()}
          />
        )}
      </div>
    </>
  );
}

function Refused(): ReactElement {
  return (
    <p role="alert">
      <Trans>You need permission to manage the phone system.</Trans>
    </p>
  );
}

function LoadFailed({
  children,
  onRetry,
}: {
  readonly children: ReactElement;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <p role="alert">
      {children}{' '}
      <Button variant="quiet" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </p>
  );
}

function NumberInventory({
  businessId,
  numbers,
  settings,
  members,
}: {
  readonly businessId: string;
  readonly numbers: UseQueryResult<{ data: PhoneNumberSettings[] }, unknown>;
  readonly settings: PhoneSystemSettings | undefined;
  /** The members, once all are read: until then nobody is named, nor called unavailable. */
  readonly members: PhoneMembers;
}): ReactElement {
  const people = members.people;
  const { t } = useLingui();
  const id = useId();
  const client = apiIn(businessId);
  const cache = useQueryClient();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const ownerName = (memberId: string | null): string | undefined => {
    const person = people?.find((each) => each.membershipId === memberId);
    return person === undefined ? undefined : personName(person);
  };
  const makeDefault = useMutation({
    mutationFn: (number: PhoneNumberSettings) => {
      if (settings === undefined) throw new Error('The settings are not loaded.');
      const checked = systemInput(
        { ...systemDraftOf(settings), defaultNumberId: number.id },
        settings.revision,
      );
      if (!checked.ok) throw new Error('The saved settings could not be sent back.');
      return client.request(updatePhoneSystemSettings, { body: checked.input });
    },
    onSuccess: (saved, number) => {
      cache.setQueryData(phoneSettingsKey(businessId), saved);
      void cache.invalidateQueries({ queryKey: phoneNumbersKey(businessId) });
      const name = number.name;
      setAnnouncement(t`${name} is now the default number.`);
    },
    onError: (error) => {
      // Someone else saved the settings first: read them, so the next try is based on them.
      if (isStale(error)) void cache.invalidateQueries({ queryKey: phoneSettingsKey(businessId) });
    },
  });
  const all = numbers.data?.data ?? [];
  const shown = all.filter((number) => matchesSearch(number, query, ownerName));
  const opened = all.find((number) => number.id === editing);
  const searched = query.trim();
  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          <Trans>Phone numbers</Trans>
        </h2>
        <label
          htmlFor={`${id}-search`}
          className="relative flex w-full min-w-0 items-center sm:w-72"
        >
          <span className="sr-only">
            <Trans>Search numbers</Trans>
          </span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            id={`${id}-search`}
            type="search"
            className="w-full pl-9"
            placeholder={t`Search by name, number or person`}
            value={query}
            onValueChange={setQuery}
          />
        </label>
      </div>
      <p role="status" className="text-sm text-muted-foreground empty:sr-only">
        {announcement}
      </p>
      {makeDefault.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {isStale(makeDefault.error)
            ? t`The voice settings changed since they were loaded. They have been read again: try once more.`
            : makeDefault.error instanceof ApiError
              ? makeDefault.error.message
              : t`The default number wasn't changed. Check your connection and try again.`}
        </p>
      ) : null}
      {numbers.isPending ? (
        <p role="status">
          <Trans>Loading phone numbers…</Trans>
        </p>
      ) : null}
      {numbers.isError ? (
        <LoadFailed
          onRetry={() => {
            void numbers.refetch();
          }}
        >
          <Trans>We couldn't load the phone numbers.</Trans>
        </LoadFailed>
      ) : null}
      {numbers.data === undefined ? null : all.length === 0 ? (
        <p className="rounded-card border border-border bg-card p-[22px] text-muted-foreground">
          <Trans>
            No numbers registered yet. Connect your Twilio account below, then register the numbers
            you want to use.
          </Trans>
        </p>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>No numbers match “{searched}”.</Trans>
        </p>
      ) : (
        <ul aria-label={t`Registered numbers`} className="flex min-w-0 flex-col gap-3">
          {shown.map((number) => (
            <NumberRow
              key={number.id}
              number={number}
              ownerName={ownerName}
              teamRead={people !== undefined}
              canMakeDefault={settings !== undefined && !makeDefault.isPending}
              onEdit={() => {
                setAnnouncement('');
                setEditing(number.id);
              }}
              onMakeDefault={() => {
                setAnnouncement('');
                makeDefault.mutate(number);
              }}
            />
          ))}
        </ul>
      )}
      {opened === undefined ? null : (
        <NumberEditor
          key={opened.id}
          businessId={businessId}
          number={opened}
          members={members}
          calling={settings?.calling}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={(saved) => {
            cache.setQueryData<{ data: PhoneNumberSettings[] }>(
              phoneNumbersKey(businessId),
              (list) =>
                list === undefined
                  ? list
                  : { data: list.data.map((each) => (each.id === saved.id ? saved : each)) },
            );
            setEditing(undefined);
            const name = saved.name;
            setAnnouncement(t`${name} saved.`);
          }}
        />
      )}
    </section>
  );
}

function NumberRow({
  number,
  ownerName,
  teamRead,
  canMakeDefault,
  onEdit,
  onMakeDefault,
}: {
  readonly number: PhoneNumberSettings;
  readonly ownerName: (memberId: string | null) => string | undefined;
  /** Whether the team is read, so someone not in it can be said to have left. */
  readonly teamRead: boolean;
  readonly canMakeDefault: boolean;
  readonly onEdit: () => void;
  readonly onMakeDefault: () => void;
}): ReactElement {
  const { t } = useLingui();
  const statusWords = useStatusWords();
  const warningWords = useWarningWords();
  const destination = destinationOf(number.voice);
  const member = (memberId: string): string =>
    ownerName(memberId) ?? (teamRead ? t`Unavailable member` : t`A team member`);
  const owner = number.ownerId === null ? t`Nobody` : member(number.ownerId);
  const goesTo =
    destination.kind === 'no_voice'
      ? t`Can't take calls`
      : destination.kind === 'member'
        ? member(destination.memberId)
        : destination.kind === 'forward'
          ? destination.e164
          : destination.kind === 'fallback'
            ? t`The business fallback number`
            : destination.kind === 'voicemail'
              ? t`Voicemail`
              : t`Nobody`;
  const takesCalls = number.capabilities.includes('voice');
  const name = number.name;
  const seconds = number.voice === null ? '' : String(number.voice.routing.ringTimeoutSeconds);
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4 sm:p-[22px]">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold break-all">{number.name}</h3>
            {number.isDefault ? (
              <Badge variant="assistant">
                <Trans>Default</Trans>
              </Badge>
            ) : null}
            <Badge variant={statusVariant[number.status]}>{statusWords(number.status)}</Badge>
          </div>
          <p className="break-all text-muted-foreground">{number.e164}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {takesCalls && !number.isDefault ? (
            <Button
              variant="secondary"
              size="small"
              disabled={!canMakeDefault}
              aria-label={t`Make ${name} the default number`}
              onClick={onMakeDefault}
            >
              <Trans>Make default</Trans>
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="small"
            aria-label={t`Edit configuration of ${name}`}
            onClick={onEdit}
          >
            <Trans>Edit configuration</Trans>
          </Button>
        </div>
      </div>
      <dl className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            <Trans>Assigned to</Trans>
          </dt>
          <dd className="break-words">{owner}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            <Trans>Calls go first to</Trans>
          </dt>
          <dd className="break-all">{goesTo}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            <Trans>Rings for</Trans>
          </dt>
          <dd>{number.voice === null ? t`Not applicable` : t`${seconds} seconds`}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-1.5" aria-label={t`Capabilities`} role="group">
        {number.capabilities.map((capability) => (
          <Badge key={capability} variant="neutral">
            {capability.toUpperCase()}
          </Badge>
        ))}
      </div>
      {number.warnings.length === 0 ? null : (
        <ul
          aria-label={t`Warnings for ${name}`}
          className="flex flex-col gap-1.5 rounded-xl bg-secondary p-3 text-sm text-secondary-foreground"
        >
          {number.warnings.map((warning) => (
            <li key={warning}>{warningWords(warning)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
