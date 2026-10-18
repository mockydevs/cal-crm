// A number's configuration, as GoHighLevel's "Edit Configuration" splits it: Basic details
// (name, owner, recording and its announcement), Call forwarding (who rings first, then an
// outside number, then the business fallback, who rings beside them, for how long, and
// voicemail) and Advanced settings (call connect, whisper, the caller ID of a forwarded
// call, the contact owner first). A number that can't take calls has only its name and
// owner. Saved under the revision the editor read; a newer save is refused.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getPhoneNumberSettings,
  updatePhoneNumberSettings,
  type PhoneCalling,
  type PhoneNumberSettings,
  type PhoneNumberVoiceSettings,
  type UpdatePhoneNumberSettingsInput,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { Labeled, NotYet, PeoplePicker, SwitchRow } from './calendar-settings-parts';
import type { Person } from './calendar-settings-rules';
import {
  personName,
  phoneNumberKey,
  Tabs,
  useProblemWords,
  useWarningWords,
  WholeNumberInput,
  type PhoneMembers,
} from './phone-system-parts';
import {
  canRingMore,
  MAX_RING_ALSO,
  numberDraftOf,
  numberInput,
  problemAt,
  problemsOf,
  sameDraft,
  withPrimary,
  withRecording,
  type NumberDraft,
  type Problems,
} from './phone-system-rules';
import { isStale, retryFaults } from './settings-list';

type Section = 'basic' | 'forwarding' | 'advanced';

/** Which section shows the field a problem names, so a refused save opens it. */
function sectionOf(pointer: string): Section {
  if (pointer.startsWith('/voice/routing')) return 'forwarding';
  if (pointer.startsWith('/voice/advanced')) return 'advanced';
  return 'basic';
}

/** What a number's editor is working on: the changes, and the revision they are based on. */
interface Editing {
  readonly draft: NumberDraft;
  readonly revision: string;
}

export function NumberEditor({
  businessId,
  number,
  members,
  calling,
  onClose,
  onSaved,
}: {
  readonly businessId: string;
  /** The number as the inventory read it, shown until its own read arrives. */
  readonly number: PhoneNumberSettings;
  /**
   * Who may be chosen. Until every member is read, or when they can't be, nobody is
   * offered and saving keeps the people already set.
   */
  readonly members: PhoneMembers;
  readonly calling: PhoneCalling | undefined;
  readonly onClose: () => void;
  readonly onSaved: (saved: PhoneNumberSettings) => void;
}): ReactElement {
  const people: readonly Person[] = members.people ?? [];
  const { t } = useLingui();
  const id = useId();
  const client = apiIn(businessId);
  const cache = useQueryClient();
  const warningWords = useWarningWords();
  const problemWords = useProblemWords();
  const read = useQuery({
    queryKey: phoneNumberKey(businessId, number.id),
    queryFn: () => client.request(getPhoneNumberSettings, { params: { id: number.id } }),
    initialData: number,
    // The inventory's copy is shown at once and read again: the editor saves what is newest.
    initialDataUpdatedAt: 0,
    retry: retryFaults,
  });
  const saved = read.data;
  const [editing, setEditing] = useState<Editing>();
  const [problems, setProblems] = useState<Problems>({});
  const [section, setSection] = useState<Section>('basic');
  // Remounts the fields after a reload, so what they hold is what was read.
  const [generation, setGeneration] = useState(0);
  const draft = editing?.draft ?? numberDraftOf(saved);
  const dirty = editing !== undefined && !sameDraft(editing.draft, numberDraftOf(saved));
  const save = useMutation({
    mutationFn: (input: UpdatePhoneNumberSettingsInput) =>
      client.request(updatePhoneNumberSettings, { params: { id: number.id }, body: input }),
    onSuccess: (answer) => {
      cache.setQueryData(phoneNumberKey(businessId, number.id), answer);
      onSaved(answer);
    },
    onError: (error) => {
      if (!(error instanceof ApiError) || error.problem.errors === undefined) return;
      const found = problemsOf(error.problem.errors);
      setProblems(found);
      const first = Object.keys(found).find((pointer) => pointer !== '');
      if (first !== undefined) setSection(sectionOf(first));
    },
  });
  const stale = isStale(save.error);
  const gone = save.error instanceof ApiError && save.error.status === 404;
  const busy = save.isPending;
  const change = (next: Partial<NumberDraft>): void => {
    setEditing({ draft: { ...draft, ...next }, revision: editing?.revision ?? saved.revision });
  };
  const changeVoice = (next: (voice: PhoneNumberVoiceSettings) => PhoneNumberVoiceSettings) => {
    if (draft.voice !== null) change({ voice: next(draft.voice) });
  };
  const words = (pointer: string): string | undefined => {
    const problem = problemAt(problems, pointer);
    return problem === undefined ? undefined : problemWords(pointer, problem);
  };
  const reload = (): void => {
    setEditing(undefined);
    setProblems({});
    save.reset();
    void read.refetch().then(() => {
      setGeneration((value) => value + 1);
    });
  };
  const voice = draft.voice;
  const sections: { id: Section; label: string }[] =
    voice === null
      ? [{ id: 'basic', label: t`Basic details` }]
      : [
          { id: 'basic', label: t`Basic details` },
          { id: 'forwarding', label: t`Call forwarding` },
          { id: 'advanced', label: t`Advanced settings` },
        ];
  const wholeProblem = problems[''];
  const most = String(MAX_RING_ALSO);
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-60 flex max-h-[min(92vh,820px)] w-[min(720px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-card bg-card text-card-foreground shadow-xl outline-none">
          <div className="flex min-w-0 items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-medium wrap-break-word">
                <Trans>Edit configuration</Trans>
              </Dialog.Title>
              <Dialog.Description className="text-sm break-all text-muted-foreground">
                {saved.name} · {saved.e164}
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
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !dirty) return;
              const checked = numberInput(editing.draft, editing.revision);
              if (!checked.ok) {
                setProblems(checked.problems);
                const first = Object.keys(checked.problems)[0];
                if (first !== undefined) setSection(sectionOf(first));
                return;
              }
              setProblems({});
              save.mutate(checked.input);
            }}
          >
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-5">
              {calling === undefined || calling.available ? null : (
                <NotYet>
                  <Trans>
                    Calls can't be made or taken yet. What you set here is saved and used once they
                    can.
                  </Trans>
                </NotYet>
              )}
              {saved.warnings.length === 0 ? null : (
                <ul
                  aria-label={t`Warnings`}
                  className="flex flex-col gap-1.5 rounded-xl bg-secondary p-3 text-sm text-secondary-foreground"
                >
                  {saved.warnings.map((warning) => (
                    <li key={warning}>{warningWords(warning)}</li>
                  ))}
                </ul>
              )}
              {members.isError ? (
                <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                  <p className="text-destructive">
                    <Trans>
                      The team couldn't be loaded, so nobody can be chosen now. Saving keeps the
                      people already set.
                    </Trans>
                  </p>
                  <Button variant="secondary" size="small" onClick={members.retry}>
                    <Trans>Try again</Trans>
                  </Button>
                </div>
              ) : members.people === undefined ? (
                <p role="status" className="text-sm text-muted-foreground">
                  <Trans>Loading team members…</Trans>
                </p>
              ) : null}
              <Tabs
                label={t`Number settings`}
                tabs={sections}
                current={section}
                idBase={id}
                onChange={setSection}
              />
              <fieldset
                key={generation}
                disabled={busy}
                className="flex min-w-0 flex-col gap-5 border-0 p-0"
              >
                <div
                  role="tabpanel"
                  id={`${id}-panel-basic`}
                  aria-labelledby={`${id}-tab-basic`}
                  hidden={section !== 'basic'}
                  className="flex min-w-0 flex-col gap-5"
                >
                  <Labeled label={t`Friendly name`} problem={words('/name')}>
                    {(control) => (
                      <Input
                        {...control}
                        value={draft.name}
                        maxLength={120}
                        onValueChange={(name) => {
                          change({ name });
                        }}
                      />
                    )}
                  </Labeled>
                  <MemberSelect
                    label={t`Assigned to`}
                    description={t`The person this number belongs to. Calls ring them first when the business settings prefer the assigned person.`}
                    none={t`Nobody`}
                    people={people}
                    value={draft.ownerId}
                    problem={words('/ownerId')}
                    onChange={(ownerId) => {
                      change({ ownerId });
                    }}
                  />
                  {voice === null ? (
                    <NotYet>
                      <Trans>
                        This number can't take calls, so it has no call settings. It still sends and
                        receives text messages.
                      </Trans>
                    </NotYet>
                  ) : (
                    <fieldset className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-3">
                      <legend className="px-1 text-sm font-medium">
                        <Trans>Call recording</Trans>
                      </legend>
                      {calling?.available === true ? (
                        <NotYet>
                          <Trans>
                            Calls aren't recorded yet. What you set here is saved and used once they
                            are.
                          </Trans>
                        </NotYet>
                      ) : null}
                      <SwitchRow
                        label={t`Record calls`}
                        description={t`Calls to and from this number are recorded.`}
                        checked={voice.recording.enabled}
                        onChange={(enabled) => {
                          changeVoice((each) => ({
                            ...each,
                            recording: withRecording(each.recording, enabled),
                          }));
                        }}
                      />
                      <SwitchRow
                        label={t`Play a recording announcement`}
                        description={
                          voice.recording.enabled
                            ? t`Callers hear it before the call is connected.`
                            : t`Turn recording on to play one.`
                        }
                        checked={voice.recording.announcement.enabled}
                        disabled={!voice.recording.enabled}
                        onChange={(enabled) => {
                          changeVoice((each) => ({
                            ...each,
                            recording: {
                              ...each.recording,
                              announcement: { ...each.recording.announcement, enabled },
                            },
                          }));
                        }}
                      />
                      {voice.recording.announcement.enabled ? (
                        <Labeled
                          label={t`Announcement`}
                          problem={words('/voice/recording/announcement/message')}
                        >
                          {(control) => (
                            <Textarea
                              {...control}
                              rows={2}
                              maxLength={500}
                              value={voice.recording.announcement.message ?? ''}
                              onChange={(event) => {
                                const message = event.target.value;
                                changeVoice((each) => ({
                                  ...each,
                                  recording: {
                                    ...each.recording,
                                    announcement: { ...each.recording.announcement, message },
                                  },
                                }));
                              }}
                            />
                          )}
                        </Labeled>
                      ) : null}
                    </fieldset>
                  )}
                </div>
                {voice === null ? null : (
                  <>
                    <div
                      role="tabpanel"
                      id={`${id}-panel-forwarding`}
                      aria-labelledby={`${id}-tab-forwarding`}
                      hidden={section !== 'forwarding'}
                      className="flex min-w-0 flex-col gap-5"
                    >
                      <p className="text-sm text-muted-foreground">
                        <Trans>
                          A call rings the first that is set, in this order: the team member, then
                          the outside number, then the business fallback number.
                        </Trans>
                      </p>
                      {calling?.available === true ? (
                        <NotYet>
                          <Trans>
                            Calls to this number aren't put through to anyone yet. What you set here
                            is saved and used once they are.
                          </Trans>
                        </NotYet>
                      ) : null}
                      <MemberSelect
                        label={t`First, a team member`}
                        none={t`No one`}
                        people={people}
                        value={voice.routing.primaryMemberId}
                        problem={words('/voice/routing/primaryMemberId')}
                        onChange={(memberId) => {
                          changeVoice((each) => ({
                            ...each,
                            routing: withPrimary(each.routing, memberId),
                          }));
                        }}
                      />
                      <Labeled
                        label={t`Second, an outside number`}
                        description={t`With its country code, such as +14155550123. Not one of this business's own numbers.`}
                        problem={words('/voice/routing/forwardTo')}
                      >
                        {(control) => (
                          <Input
                            {...control}
                            type="tel"
                            autoComplete="off"
                            value={voice.routing.forwardTo ?? ''}
                            onValueChange={(typed) => {
                              const forwardTo = typed.trim() === '' ? null : typed.trim();
                              changeVoice((each) => ({
                                ...each,
                                routing: { ...each.routing, forwardTo },
                              }));
                            }}
                          />
                        )}
                      </Labeled>
                      <SwitchRow
                        label={t`Third, the business fallback number`}
                        description={t`Set in Voice settings, for every number that falls back.`}
                        checked={voice.routing.useBusinessFallback}
                        onChange={(useBusinessFallback) => {
                          changeVoice((each) => ({
                            ...each,
                            routing: { ...each.routing, useBusinessFallback },
                          }));
                        }}
                      />
                      <PeoplePicker
                        label={t`Ring more team members`}
                        description={
                          canRingMore(voice.routing.ringAlso)
                            ? t`They ring at the same time as the first person: up to ${most} more people.`
                            : t`That's the most: ${most} more people.`
                        }
                        people={people.filter(
                          (person) =>
                            person.membershipId !== voice.routing.primaryMemberId &&
                            (canRingMore(voice.routing.ringAlso) ||
                              voice.routing.ringAlso.includes(person.membershipId)),
                        )}
                        chosen={voice.routing.ringAlso}
                        single={false}
                        problem={words('/voice/routing/ringAlso')}
                        onChange={(ringAlso) => {
                          changeVoice((each) => ({
                            ...each,
                            routing: {
                              ...each.routing,
                              ringAlso: ringAlso.slice(0, MAX_RING_ALSO),
                            },
                          }));
                        }}
                      />
                      <Labeled
                        label={t`Ring for (seconds)`}
                        description={t`From 5 to 120 seconds. 20 or more is advised, so there is time to answer.`}
                        problem={words('/voice/routing/ringTimeoutSeconds')}
                      >
                        {(control) => (
                          <WholeNumberInput
                            control={control}
                            value={voice.routing.ringTimeoutSeconds}
                            min={5}
                            max={120}
                            disabled={busy}
                            onChange={(ringTimeoutSeconds) => {
                              changeVoice((each) => ({
                                ...each,
                                routing: { ...each.routing, ringTimeoutSeconds },
                              }));
                            }}
                          />
                        )}
                      </Labeled>
                      <SwitchRow
                        label={t`Voicemail backup`}
                        description={t`Take a voicemail when nobody answers.`}
                        checked={voice.routing.voicemailBackup}
                        onChange={(voicemailBackup) => {
                          changeVoice((each) => ({
                            ...each,
                            routing: { ...each.routing, voicemailBackup },
                          }));
                        }}
                      />
                    </div>
                    <div
                      role="tabpanel"
                      id={`${id}-panel-advanced`}
                      aria-labelledby={`${id}-tab-advanced`}
                      hidden={section !== 'advanced'}
                      className="flex min-w-0 flex-col gap-5"
                    >
                      {calling?.available === true ? (
                        <NotYet>
                          <Trans>
                            None of these are used on calls yet. What you set here is saved and used
                            once they are.
                          </Trans>
                        </NotYet>
                      ) : null}
                      <SwitchRow
                        label={t`Call connect`}
                        description={t`Whoever answers presses a key to take the call, so a voicemail can't take it.`}
                        checked={voice.advanced.callConnectConfirmation}
                        onChange={(callConnectConfirmation) => {
                          changeVoice((each) => ({
                            ...each,
                            advanced: { ...each.advanced, callConnectConfirmation },
                          }));
                        }}
                      />
                      <SwitchRow
                        label={t`Whisper message`}
                        description={t`The person answering hears it before the caller is connected.`}
                        checked={voice.advanced.whisper.enabled}
                        onChange={(enabled) => {
                          changeVoice((each) => ({
                            ...each,
                            advanced: {
                              ...each.advanced,
                              whisper: { ...each.advanced.whisper, enabled },
                            },
                          }));
                        }}
                      />
                      {voice.advanced.whisper.enabled ? (
                        <Labeled
                          label={t`Whisper`}
                          problem={words('/voice/advanced/whisper/message')}
                        >
                          {(control) => (
                            <Textarea
                              {...control}
                              rows={2}
                              maxLength={500}
                              value={voice.advanced.whisper.message ?? ''}
                              onChange={(event) => {
                                const message = event.target.value;
                                changeVoice((each) => ({
                                  ...each,
                                  advanced: {
                                    ...each.advanced,
                                    whisper: { ...each.advanced.whisper, message },
                                  },
                                }));
                              }}
                            />
                          )}
                        </Labeled>
                      ) : null}
                      <Labeled label={t`A forwarded call shows`}>
                        {(control) => (
                          <Select
                            {...control}
                            value={voice.advanced.forwardedCallerId}
                            onValueChange={(value) => {
                              const forwardedCallerId =
                                value === 'business_number' ? 'business_number' : 'caller';
                              changeVoice((each) => ({
                                ...each,
                                advanced: { ...each.advanced, forwardedCallerId },
                              }));
                            }}
                          >
                            <option value="caller">{t`The caller's number`}</option>
                            <option value="business_number">{t`This number`}</option>
                          </Select>
                        )}
                      </Labeled>
                      <SwitchRow
                        label={t`Ring the contact's owner first`}
                        description={t`When a contact with an owner calls, their owner rings before this number's own routing.`}
                        checked={voice.advanced.preferContactOwner}
                        onChange={(preferContactOwner) => {
                          changeVoice((each) => ({
                            ...each,
                            advanced: { ...each.advanced, preferContactOwner },
                          }));
                        }}
                      />
                    </div>
                  </>
                )}
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
                        This number's settings changed since you opened them. Reload them, then make
                        your change again.
                      </Trans>
                    ) : gone ? (
                      <Trans>This number is no longer registered to this business.</Trans>
                    ) : save.error instanceof ApiError ? (
                      save.error.message
                    ) : (
                      <Trans>
                        We couldn't save this number. Check your connection and try again.
                      </Trans>
                    )}
                  </p>
                  {stale ? (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={read.isFetching}
                      onClick={reload}
                    >
                      <Trans>Reload number</Trans>
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3 sm:px-5">
              <p role="status" className="mr-auto text-sm text-muted-foreground empty:sr-only">
                {busy ? t`Saving…` : ''}
              </p>
              <Button variant="secondary" disabled={busy} onClick={onClose}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" disabled={busy || !dirty}>
                <Trans>Save</Trans>
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One person of the team, or nobody; someone who left is shown so they can be replaced. */
function MemberSelect({
  label,
  description,
  none,
  people,
  value,
  problem,
  onChange,
}: {
  readonly label: string;
  readonly description?: string;
  readonly none: string;
  readonly people: readonly Person[];
  readonly value: string | null;
  readonly problem: string | undefined;
  readonly onChange: (memberId: string | null) => void;
}): ReactElement {
  const { t } = useLingui();
  const missing = value !== null && !people.some((person) => person.membershipId === value);
  return (
    <Labeled label={label} description={description} problem={problem}>
      {(control) => (
        <Select
          {...control}
          value={value ?? ''}
          onValueChange={(chosen) => {
            onChange(chosen === '' ? null : chosen);
          }}
        >
          <option value="">{none}</option>
          {missing ? (
            <option value={value} disabled>
              {t`Unavailable member`}
            </option>
          ) : null}
          {people.map((person) => (
            <option key={person.membershipId} value={person.membershipId}>
              {personName(person)}
            </option>
          ))}
        </Select>
      )}
    </Labeled>
  );
}
