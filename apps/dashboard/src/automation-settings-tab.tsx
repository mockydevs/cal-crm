// The Settings tab of a workflow: what the document's own settings hold, as cards of
// switches, each with a line that says what it does here. They are part of the draft, so
// they are saved with it and published with it. A setting GoHighLevel has and the engine
// does not is not drawn.
//
// Its own chunk, loaded when someone opens this tab.
import { Trans, useLingui } from '@lingui/react/macro';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useId, type ReactElement, type ReactNode } from 'react';
import type { Draft } from './automation-document';
import {
  setStopOnReply,
  settingsOf,
  startingWindow,
  replyStopScope,
  setReplyStopScope,
  stopsOnReply,
  weekdays,
  withSettings,
  type Weekday,
} from './automation-edits';
import { Switch } from './automation-switch';

export interface SettingsTabProps {
  readonly draft: Draft;
  /** Whether the person may change the draft, and it can be changed right now. */
  readonly editable: boolean;
  readonly onChange: (draft: Draft) => void;
}

function Card({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col rounded-card border border-border bg-card"
    >
      <h2 id={headingId} className="border-b border-border px-5 py-4 text-base font-medium">
        {title}
      </h2>
      <div className="flex min-w-0 flex-col divide-y divide-border">{children}</div>
    </section>
  );
}

/** One setting: its name and what it does at the left, its control at the right. */
function Setting({
  name,
  line,
  control,
  children,
}: {
  readonly name: string;
  readonly line: ReactNode;
  readonly control: (named: {
    readonly 'aria-labelledby': string;
    readonly 'aria-describedby': string;
  }) => ReactNode;
  readonly children?: ReactNode;
}): ReactElement {
  const nameId = useId();
  const lineId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-3 px-5 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <span id={nameId} className="text-sm font-medium text-foreground">
            {name}
          </span>
          <p id={lineId} className="text-sm text-muted-foreground">
            {line}
          </p>
        </div>
        {control({ 'aria-labelledby': nameId, 'aria-describedby': lineId })}
      </div>
      {children}
    </div>
  );
}

export default function SettingsTab({ draft, editable, onChange }: SettingsTabProps): ReactElement {
  const { t } = useLingui();
  const startId = useId();
  const endId = useId();
  const daysId = useId();
  const scopeId = useId();
  const settings = settingsOf(draft);
  const scope = replyStopScope(draft);
  const hours = settings.window;
  const dayNames: Readonly<Record<Weekday, string>> = {
    monday: t`Monday`,
    tuesday: t`Tuesday`,
    wednesday: t`Wednesday`,
    thursday: t`Thursday`,
    friday: t`Friday`,
    saturday: t`Saturday`,
    sunday: t`Sunday`,
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5">
      {editable ? null : (
        <p className="rounded-xl border border-border bg-card px-4 py-3 text-md">
          <Trans>These settings can't be changed right now.</Trans>
        </p>
      )}
      <Card title={t`Contact`}>
        <Setting
          name={t`Allow re-entry`}
          line={
            <Trans>
              A contact can enter this workflow again once they have finished it or were taken out
              of it. A contact never re-enters while still in it.
            </Trans>
          }
          control={(named) => (
            <Switch
              {...named}
              checked={settings.reEntry}
              disabled={!editable}
              onChange={(reEntry) => {
                onChange(withSettings(draft, { reEntry }));
              }}
            />
          )}
        />
        <Setting
          name={t`Stop on response`}
          line={
            <Trans>
              The workflow ends for a contact as soon as they send a message. Any message counts, on
              any channel, unless you ask only for replies to what this workflow sent.
            </Trans>
          }
          control={(named) => (
            <Switch
              {...named}
              checked={stopsOnReply(draft)}
              disabled={!editable}
              onChange={(on) => {
                onChange(setStopOnReply(draft, on));
              }}
            />
          )}
        >
          {scope === undefined ? null : (
            <div className="flex min-w-0 flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor={scopeId}>
                <Trans>Which messages stop it</Trans>
              </label>
              <Select
                id={scopeId}
                aria-describedby={`${scopeId}-line`}
                disabled={!editable}
                value={scope}
                onValueChange={(next) => {
                  onChange(setReplyStopScope(draft, next === 'this_run' ? 'this_run' : 'any'));
                }}
              >
                <option value="any">{t`Any message from the contact`}</option>
                <option value="this_run">
                  {t`Only when they reply to a message this automation sent`}
                </option>
              </Select>
              <p id={`${scopeId}-line`} className="text-sm text-muted-foreground">
                {scope === 'this_run' ? (
                  <Trans>
                    A reply counts when this contact's run has already sent them a message on the
                    same channel. A text answering an email doesn't, and neither does a message a
                    person sent by hand.
                  </Trans>
                ) : (
                  <Trans>Whether or not it answers a message this workflow sent.</Trans>
                )}
              </p>
            </div>
          )}
        </Setting>
      </Card>
      <Card title={t`Communication`}>
        <Setting
          name={t`Timezone`}
          line={
            <Trans>
              Whose clock waits, dates and the time window go by. Contact timezone is each contact's
              own, and the account's for a contact who has none.
            </Trans>
          }
          control={(named) => (
            <div className="w-full sm:w-56">
              <Select
                {...named}
                disabled={!editable}
                value={settings.timezone}
                onValueChange={(next) => {
                  onChange(
                    withSettings(draft, { timezone: next === 'contact' ? 'contact' : 'business' }),
                  );
                }}
              >
                <option value="business">{t`Account timezone`}</option>
                <option value="contact">{t`Contact timezone`}</option>
              </Select>
            </div>
          )}
        />
        <Setting
          name={t`Specific time`}
          line={
            <Trans>
              Restrict messages from being sent outside the time window you define. An email or a
              text reached outside it waits for the window to open; other actions are not held.
            </Trans>
          }
          control={(named) => (
            <Switch
              {...named}
              checked={hours !== undefined}
              disabled={!editable}
              onChange={(on) => {
                onChange(withSettings(draft, { window: on ? startingWindow : undefined }));
              }}
            />
          )}
        >
          {hours === undefined ? null : (
            <div className="flex min-w-0 flex-col gap-3">
              <div role="group" aria-labelledby={daysId} className="flex min-w-0 flex-col gap-1.5">
                <span id={daysId} className="text-sm font-medium">
                  <Trans>Days</Trans>
                </span>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {weekdays.map((day) => (
                    <label
                      key={day}
                      className="flex min-h-11 items-center gap-2 text-sm lg:min-h-9"
                    >
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary"
                        disabled={!editable}
                        checked={hours.days.includes(day)}
                        onChange={(event) => {
                          const days = event.target.checked
                            ? [...hours.days, day]
                            : hours.days.filter((each) => each !== day);
                          onChange(withSettings(draft, { window: { ...hours, days } }));
                        }}
                      />
                      {dayNames[day]}
                    </label>
                  ))}
                </div>
                {hours.days.length === 0 ? (
                  <p role="alert" className="text-sm font-medium text-destructive">
                    <Trans>Choose at least one day, or messages would never be sent.</Trans>
                  </p>
                ) : null}
              </div>
              <div className="grid min-w-0 grid-cols-2 gap-3 sm:max-w-80">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor={startId}>
                    <Trans>Start time</Trans>
                  </label>
                  <Input
                    id={startId}
                    type="time"
                    disabled={!editable}
                    value={hours.start}
                    onChange={(event) => {
                      if (event.target.value !== '')
                        onChange(
                          withSettings(draft, { window: { ...hours, start: event.target.value } }),
                        );
                    }}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor={endId}>
                    <Trans>End time</Trans>
                  </label>
                  <Input
                    id={endId}
                    type="time"
                    disabled={!editable}
                    value={hours.end}
                    onChange={(event) => {
                      if (event.target.value !== '')
                        onChange(
                          withSettings(draft, { window: { ...hours, end: event.target.value } }),
                        );
                    }}
                  />
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                <Trans>
                  A window may run past midnight. The business's quiet hours still apply inside it.
                </Trans>
              </p>
            </div>
          )}
        </Setting>
      </Card>
    </div>
  );
}
