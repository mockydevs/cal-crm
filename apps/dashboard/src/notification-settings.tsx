// Settings → My Notifications: which notifications this person receives in the business, a
// switch per kind, and how long before a task assigned to them is due they are reminded (as
// GoHighLevel's My Profile → Notifications → Task Notifications has it). The choices are the
// person's own; nobody else reads or changes them.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationKind,
  type NotificationPreferences,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  reminderDraftOf,
  reminderMinutesOf,
  type ReminderDraft,
  type ReminderUnit,
} from './notification-settings-rules';
import { ListProblem, retryFaults, savingProblem } from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const cardClassName =
  'flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]';
const checkboxClassName = 'size-4 shrink-0 accent-primary';
const checkLabelClassName = 'flex min-h-11 items-center gap-2.5 text-md lg:min-h-8';

export function NotificationSettingsPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const preferences = useQuery({
    queryKey: ['b', business.id, 'notification-preferences'],
    queryFn: () => api.request(getNotificationPreferences, {}),
    retry: retryFaults,
  });
  return (
    <Page title={t`My Notifications`}>
      <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
        <Trans>
          Choose what you are told of inside the app in this business. Only you see these choices.
        </Trans>
      </p>
      {preferences.isError ? (
        <ListProblem
          onRetry={() => {
            void preferences.refetch();
          }}
        >
          <Trans>Your notification settings couldn't be loaded.</Trans>
        </ListProblem>
      ) : preferences.data === undefined ? (
        <p aria-live="polite">
          <Trans>Loading…</Trans>
        </p>
      ) : (
        <PreferencesForm key={business.id} saved={preferences.data} />
      )}
    </Page>
  );
}

function PreferencesForm({ saved }: { readonly saved: NotificationPreferences }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const reminderId = useId();
  const amountProblemId = useId();
  const savedMinutes =
    saved.items.find((item) => item.kind === 'task.reminder')?.remindMinutes ?? null;
  const [on, setOn] = useState(
    () => new Map(saved.items.map((item) => [item.kind, item.inApp] as const)),
  );
  const [reminder, setReminder] = useState<ReminderDraft>(() =>
    reminderDraftOf(saved.items.find((item) => item.kind === 'task.reminder')?.remindMinutes),
  );
  const [problem, setProblem] = useState<string>();
  // The reminder's time was what the last Save could not send.
  const [amountInvalid, setAmountInvalid] = useState(false);
  const remindersOn = on.get('task.reminder') ?? true;
  const [notice, setNotice] = useState('');
  const labels: Record<NotificationKind, string> = {
    'conversation.assigned': t`A conversation is assigned to me`,
    'message.received': t`A contact writes in my conversation`,
    'message.received_other': t`A contact writes in any other conversation`,
    'message.received_following': t`A contact I follow writes`,
    'task.assigned': t`A task gets assigned to me`,
    'task.reminder': t`A reminder before an upcoming task assigned to me`,
    'task.due': t`A task assigned to me is due`,
    'appointment.booked': t`An appointment of mine is booked`,
    'appointment.rescheduled': t`An appointment of mine is moved`,
    'appointment.cancelled': t`An appointment of mine is cancelled`,
    'form.submitted': t`Someone fills in a form I manage`,
    'ai.limit_reached': t`The monthly AI spending limit is reached`,
    'automation.notice': t`A workflow notifies the team`,
    'calendar.google_disconnected': t`My Google Calendar is disconnected`,
  };
  const units: Record<ReminderUnit, string> = {
    minutes: t`Minutes`,
    hours: t`Hours`,
    days: t`Days`,
  };
  const save = useMutation({
    mutationFn: (remindMinutes: number | null) =>
      apiIn(business.id).request(updateNotificationPreferences, {
        body: {
          items: saved.items.map((item) => ({
            kind: item.kind,
            inApp: on.get(item.kind) ?? item.inApp,
            ...(item.kind === 'task.reminder' ? { remindMinutes } : {}),
          })),
        },
      }),
    onSuccess: async (next) => {
      cache.setQueryData(['b', business.id, 'notification-preferences'], next);
      await cache.invalidateQueries({ queryKey: ['b', business.id, 'notification-preferences'] });
      setNotice(t`Your notification settings are saved.`);
    },
    onError: (error) => {
      setProblem(
        savingProblem(error, t`They weren't saved. Check your connection and try again.`).form ??
          t`They weren't saved. Try again.`,
      );
    },
  });
  return (
    <form
      className={cardClassName}
      onSubmit={(event) => {
        event.preventDefault();
        // With reminders switched off, the time is kept as it was saved unless it reads.
        const typed = reminderMinutesOf(reminder);
        if (typed === undefined && remindersOn) {
          setAmountInvalid(true);
          setProblem(t`Give a whole number of minutes, hours or days, up to 30 days.`);
          return;
        }
        const remindMinutes = typed === undefined ? savedMinutes : typed;
        setAmountInvalid(false);
        setProblem(undefined);
        setNotice('');
        save.mutate(remindMinutes);
      }}
    >
      <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-2 p-0 text-lg font-semibold">
          <Trans>Inside the app</Trans>
        </legend>
        {saved.items.map((item) => (
          <div key={item.kind} className="flex min-w-0 flex-col">
            <label className={checkLabelClassName}>
              <input
                type="checkbox"
                className={checkboxClassName}
                checked={on.get(item.kind) ?? item.inApp}
                onChange={(event) => {
                  setOn(new Map(on).set(item.kind, event.target.checked));
                  setNotice('');
                }}
              />
              {labels[item.kind]}
            </label>
            {item.kind === 'task.reminder' ? (
              <div className="flex flex-wrap items-center gap-2 pb-2 pl-7">
                <label htmlFor={reminderId} className="text-sm text-muted-foreground">
                  <Trans>Remind me</Trans>
                </label>
                <Input
                  id={reminderId}
                  className="w-24"
                  inputMode="numeric"
                  placeholder={t`Off`}
                  disabled={!remindersOn}
                  aria-invalid={amountInvalid}
                  {...(amountInvalid ? { 'aria-describedby': amountProblemId } : {})}
                  value={reminder.amount}
                  onChange={(event) => {
                    setReminder({ ...reminder, amount: event.target.value });
                    setAmountInvalid(false);
                    setNotice('');
                  }}
                />
                <Select
                  aria-label={t`Unit`}
                  disabled={!remindersOn}
                  value={reminder.unit}
                  onValueChange={(next) => {
                    const unit = (Object.keys(units) as ReminderUnit[]).find(
                      (each) => each === next,
                    );
                    if (unit !== undefined) setReminder({ ...reminder, unit });
                  }}
                >
                  {(Object.keys(units) as ReminderUnit[]).map((unit) => (
                    <option key={unit} value={unit}>
                      {units[unit]}
                    </option>
                  ))}
                </Select>
                <span className="text-sm text-muted-foreground">
                  <Trans>before the task is due. Leave it empty for no reminder.</Trans>
                </span>
              </div>
            ) : null}
          </div>
        ))}
      </fieldset>
      {problem === undefined ? null : (
        <p
          id={amountInvalid ? amountProblemId : undefined}
          role="alert"
          className="text-sm font-medium text-destructive"
        >
          {problem}
        </p>
      )}
      <p role="status" className="text-sm text-success">
        {notice}
      </p>
      <div>
        <Button type="submit" disabled={save.isPending}>
          <Trans>Save</Trans>
        </Button>
      </div>
    </form>
  );
}
