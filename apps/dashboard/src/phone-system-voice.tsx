// The business's calling defaults, as GoHighLevel's voice settings group them: the default
// number, incoming calls (the assigned person first, hidden callers, the fallback number),
// outgoing calls (the caller ID, when the agent is connected, the quiet hours warning),
// recording (deletion of old recordings, transcription) and the text a missed caller gets.
// Saved together under the revision they were read with.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  updatePhoneSystemSettings,
  type PhoneNumberSettings,
  type PhoneSystemSettings,
  type UpdatePhoneSystemSettingsInput,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { Labeled, NotYet, SwitchRow } from './calendar-settings-parts';
import {
  phoneNumbersKey,
  phoneSettingsKey,
  useProblemWords,
  WholeNumberInput,
} from './phone-system-parts';
import {
  problemAt,
  problemsOf,
  sameDraft,
  systemDraftOf,
  systemInput,
  voiceNumbers,
  type Problems,
  type SystemDraft,
} from './phone-system-rules';
import { isStale } from './settings-list';

/** Recordings are kept this long when deleting old ones is first turned on. */
const SUGGESTED_RETENTION_DAYS = 90;

interface Editing {
  readonly draft: SystemDraft;
  readonly revision: string;
}

export function VoiceSettingsForm({
  businessId,
  settings,
  numbers,
  reloading,
  onReload,
}: {
  readonly businessId: string;
  readonly settings: PhoneSystemSettings;
  readonly numbers: readonly PhoneNumberSettings[];
  readonly reloading: boolean;
  readonly onReload: () => Promise<unknown>;
}): ReactElement {
  const { t } = useLingui();
  const client = apiIn(businessId);
  const cache = useQueryClient();
  const problemWords = useProblemWords();
  const [editing, setEditing] = useState<Editing>();
  const [problems, setProblems] = useState<Problems>({});
  const [generation, setGeneration] = useState(0);
  const [savedOnce, setSavedOnce] = useState(false);
  const draft = editing?.draft ?? systemDraftOf(settings);
  const dirty = editing !== undefined && !sameDraft(editing.draft, systemDraftOf(settings));
  const save = useMutation({
    mutationFn: (input: UpdatePhoneSystemSettingsInput) =>
      client.request(updatePhoneSystemSettings, { body: input }),
    onSuccess: (answer) => {
      cache.setQueryData(phoneSettingsKey(businessId), answer);
      // Which number is the default, and whether a fallback is set, show on the numbers.
      void cache.invalidateQueries({ queryKey: phoneNumbersKey(businessId) });
      setEditing(undefined);
      setSavedOnce(true);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.problem.errors !== undefined)
        setProblems(problemsOf(error.problem.errors));
    },
  });
  const busy = save.isPending;
  const stale = isStale(save.error);
  const change = (next: Partial<SystemDraft>): void => {
    setSavedOnce(false);
    setEditing({ draft: { ...draft, ...next }, revision: editing?.revision ?? settings.revision });
  };
  const words = (pointer: string): string | undefined => {
    const problem = problemAt(problems, pointer);
    return problem === undefined ? undefined : problemWords(pointer, problem);
  };
  const reload = (): void => {
    setEditing(undefined);
    setProblems({});
    save.reset();
    void onReload().then(() => {
      setGeneration((value) => value + 1);
    });
  };
  const callable = voiceNumbers(numbers);
  const defaultMissing =
    draft.defaultNumberId !== null &&
    !callable.some((number) => number.id === draft.defaultNumberId);
  const wholeProblem = problems[''];
  return (
    <form
      noValidate
      aria-label={t`Voice settings`}
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !dirty) return;
        const checked = systemInput(editing.draft, editing.revision);
        if (!checked.ok) {
          setProblems(checked.problems);
          return;
        }
        setProblems({});
        save.mutate(checked.input);
      }}
    >
      <fieldset
        key={generation}
        disabled={busy}
        className="flex min-w-0 flex-col gap-4 border-0 p-0"
      >
        <Group title={t`Default number`}>
          <Labeled
            label={t`Calls go out from`}
            description={t`The default number, used when nothing else chooses one. Only a number that takes calls can be the default.`}
            problem={words('/defaultNumberId')}
          >
            {(control) => (
              <Select
                {...control}
                value={draft.defaultNumberId ?? ''}
                onValueChange={(value) => {
                  change({ defaultNumberId: value === '' ? null : value });
                }}
              >
                <option value="">{t`No default number`}</option>
                {defaultMissing && draft.defaultNumberId !== null ? (
                  <option value={draft.defaultNumberId} disabled>
                    {t`A number that is no longer registered`}
                  </option>
                ) : null}
                {callable.map((number) => (
                  <option key={number.id} value={number.id}>
                    {`${number.name} (${number.e164})`}
                  </option>
                ))}
              </Select>
            )}
          </Labeled>
        </Group>
        <Group title={t`Incoming calls`}>
          <SwitchRow
            label={t`Ring the assigned person first`}
            description={t`A call to a number assigned to someone rings them before anyone else.`}
            checked={draft.inbound.preferAssignedUser}
            onChange={(preferAssignedUser) => {
              change({ inbound: { ...draft.inbound, preferAssignedUser } });
            }}
          />
          <SwitchRow
            label={t`Allow callers who hide their number`}
            description={t`Turned off, a private or anonymous caller isn't put through.`}
            checked={draft.inbound.allowAnonymousCallers}
            onChange={(allowAnonymousCallers) => {
              change({ inbound: { ...draft.inbound, allowAnonymousCallers } });
            }}
          />
          <Labeled
            label={t`Business fallback number`}
            description={t`Where a number set to fall back sends a call nobody took. With its country code, and not one of this business's own numbers.`}
            problem={words('/inbound/fallbackNumber')}
          >
            {(control) => (
              <Input
                {...control}
                type="tel"
                autoComplete="off"
                value={draft.inbound.fallbackNumber ?? ''}
                onValueChange={(typed) => {
                  change({
                    inbound: {
                      ...draft.inbound,
                      fallbackNumber: typed.trim() === '' ? null : typed.trim(),
                    },
                  });
                }}
              />
            )}
          </Labeled>
        </Group>
        <Group title={t`Outgoing calls`}>
          <NotYet>
            <Trans>
              None of these are used on calls yet. What you set here is saved and used once they
              are.
            </Trans>
          </NotYet>
          <Labeled
            label={t`Caller ID`}
            description={t`The number a call shows when the person calling picks none.`}
          >
            {(control) => (
              <Select
                {...control}
                value={draft.outbound.callerId}
                onValueChange={(value) => {
                  const callerId =
                    value === 'user_assigned' || value === 'local_presence'
                      ? value
                      : 'account_default';
                  change({ outbound: { ...draft.outbound, callerId } });
                }}
              >
                <option value="account_default">{t`The default number`}</option>
                <option value="user_assigned">{t`The number assigned to the person calling`}</option>
                <option value="local_presence">{t`A number with the contact's area code`}</option>
              </Select>
            )}
          </Labeled>
          <Labeled label={t`Connect the person calling`}>
            {(control) => (
              <Select
                {...control}
                value={draft.outbound.connectAgent}
                onValueChange={(value) => {
                  const connectAgent =
                    value === 'before_announcement' ? 'before_announcement' : 'after_announcement';
                  change({ outbound: { ...draft.outbound, connectAgent } });
                }}
              >
                <option value="after_announcement">{t`After the recording announcement`}</option>
                <option value="before_announcement">{t`Before the recording announcement`}</option>
              </Select>
            )}
          </Labeled>
          <SwitchRow
            label={t`Warn before calling in quiet hours`}
            description={t`Calling a contact during their quiet hours asks first.`}
            checked={draft.outbound.quietHoursWarning}
            onChange={(quietHoursWarning) => {
              change({ outbound: { ...draft.outbound, quietHoursWarning } });
            }}
          />
        </Group>
        <Group title={t`Recording and transcription`}>
          <NotYet>
            <Trans>Calls aren't transcribed yet.</Trans>
          </NotYet>
          <SwitchRow
            label={t`Delete old recordings`}
            description={t`Turned off, recordings are kept. Each number chooses whether it records.`}
            checked={draft.recording.retentionDays !== null}
            onChange={(on) => {
              change({
                recording: {
                  ...draft.recording,
                  retentionDays: on ? SUGGESTED_RETENTION_DAYS : null,
                },
              });
            }}
          />
          {draft.recording.retentionDays === null ? null : (
            <Labeled
              label={t`Delete recordings older than (days)`}
              description={t`From 1 to 3,650 days.`}
              problem={words('/recording/retentionDays')}
            >
              {(control) => (
                <WholeNumberInput
                  control={control}
                  value={draft.recording.retentionDays ?? SUGGESTED_RETENTION_DAYS}
                  min={1}
                  max={3650}
                  disabled={busy}
                  onChange={(retentionDays) => {
                    change({ recording: { ...draft.recording, retentionDays } });
                  }}
                />
              )}
            </Labeled>
          )}
          <SwitchRow
            label={t`Transcribe recorded calls`}
            description={t`Only calls that are recorded are transcribed.`}
            checked={draft.recording.transcriptionEnabled}
            onChange={(transcriptionEnabled) => {
              change({ recording: { ...draft.recording, transcriptionEnabled } });
            }}
          />
        </Group>
        <Group title={t`Missed-call text`}>
          <NotYet>
            <Trans>
              Missed-call texts aren't sent yet. What you set here is saved and used once they are.
            </Trans>
          </NotYet>
          <SwitchRow
            label={t`Text a caller back after a missed call`}
            description={t`One text, sent with the same consent and quiet-hours checks as any message.`}
            checked={draft.missedCallText.enabled}
            onChange={(enabled) => {
              change({ missedCallText: { ...draft.missedCallText, enabled } });
            }}
          />
          {draft.missedCallText.enabled ? (
            <Labeled label={t`Text`} problem={words('/missedCallText/message')}>
              {(control) => (
                <Textarea
                  {...control}
                  rows={3}
                  maxLength={640}
                  value={draft.missedCallText.message ?? ''}
                  onChange={(event) => {
                    change({
                      missedCallText: { ...draft.missedCallText, message: event.target.value },
                    });
                  }}
                />
              )}
            </Labeled>
          ) : null}
        </Group>
      </fieldset>
      {wholeProblem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problemWords('', wholeProblem)}
        </p>
      )}
      {save.isError &&
      !(save.error instanceof ApiError && save.error.problem.errors !== undefined) ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p className="text-destructive">
            {stale ? (
              <Trans>
                These settings changed since you opened them. Reload them, then make your change
                again.
              </Trans>
            ) : save.error instanceof ApiError ? (
              save.error.message
            ) : (
              <Trans>We couldn't save the settings. Check your connection and try again.</Trans>
            )}
          </p>
          {stale ? (
            <Button variant="secondary" size="small" disabled={reloading} onClick={reload}>
              <Trans>Reload settings</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <p role="status" className="mr-auto text-sm text-muted-foreground empty:sr-only">
          {busy ? t`Saving…` : savedOnce ? t`Settings saved.` : ''}
        </p>
        <Button
          variant="secondary"
          disabled={busy || !dirty}
          onClick={() => {
            setEditing(undefined);
            setProblems({});
            save.reset();
            setGeneration((value) => value + 1);
          }}
        >
          <Trans>Discard changes</Trans>
        </Button>
        <Button type="submit" disabled={busy || !dirty}>
          <Trans>Save changes</Trans>
        </Button>
      </div>
    </form>
  );
}

function Group({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-4 sm:p-[22px]"
    >
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}
