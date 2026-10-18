// "Send or schedule": now, or at a date and time on the business's clock; all at once (as
// fast as the mailbox allows) or in batches of a size, every so many minutes, hours or
// days, inside an optional window of the business's day. Before anything is confirmed it
// says when the send will finish, by the arithmetic the server releases batches with
// (packages/contracts/src/email-campaign-schedule.ts), and the last step names how many
// contacts and which mailbox.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  scheduleEmailCampaign,
  sendEmailCampaign,
  type CampaignBatchUnit,
  type EmailCampaign,
} from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type RefObject } from 'react';
import { Select, SmallDialog } from './controls';
import { saidBy } from './data';
import { hintClassName, labelClassName, problemClassName } from './parts';
import {
  batchesOf,
  batchesSentence,
  estimateSentence,
  inputOfInstant,
  instantOfInput,
  momentIn,
  scheduleProblem,
  sendEstimate,
  startingBatches,
  type BatchesForm,
} from './rules';

const HOUR_MS = 3_600_000;

export default function SendDialog({
  client,
  campaign,
  willReceive,
  dailyCeiling,
  mailboxName,
  returnFocus,
  onClose,
  onDone,
}: {
  readonly client: Client;
  /** The saved draft. */
  readonly campaign: EmailCampaign;
  /** How many of the audience can be sent it now, when it has been counted. */
  readonly willReceive: number | undefined;
  readonly dailyCeiling: number | null;
  readonly mailboxName: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  /** With the campaign as the server now has it: sending, or scheduled. */
  readonly onDone: (campaign: EmailCampaign) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const { timeZone, name } = campaign;
  // The moment the dialog opened: "now" for the estimate, and the least a schedule may be.
  const [opened] = useState(() => new Date());
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(() =>
    inputOfInstant(new Date(Math.ceil((opened.getTime() + HOUR_MS) / HOUR_MS) * HOUR_MS), timeZone),
  );
  const [batched, setBatched] = useState(false);
  const [form, setForm] = useState<BatchesForm>(startingBatches);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();

  const sendAt = when === 'later' ? instantOfInput(at, timeZone) : undefined;
  const lateProblem = when === 'later' ? scheduleProblem(sendAt, opened) : undefined;
  const parsed = batched ? batchesOf(form) : undefined;
  const batches = parsed?.batches ?? null;
  const batchProblems = parsed?.problems ?? {};
  const valid = lateProblem === undefined && parsed?.problems === undefined;
  const estimate =
    valid && willReceive !== undefined
      ? sendEstimate({
          emails: willReceive,
          dailyCeiling,
          batches,
          startAt: sendAt ?? opened,
          timeZone,
        })
      : undefined;
  const estimated =
    estimate === undefined ? undefined : estimateSentence(estimate, mailboxName, timeZone);
  const count = (willReceive ?? 0).toLocaleString();
  const from = mailboxName ?? t`the chosen mailbox`;
  const start = sendAt === undefined ? '' : momentIn(sendAt, timeZone);

  const go = useMutation({
    mutationFn: () =>
      sendAt === undefined
        ? client.request(sendEmailCampaign, {
            params: { id: campaign.id },
            body: { revision: campaign.revision, batches },
          })
        : client.request(scheduleEmailCampaign, {
            params: { id: campaign.id },
            body: { revision: campaign.revision, sendAt: sendAt.toISOString(), batches },
          }),
    onSuccess: onDone,
    onError: (error) => {
      setProblem(saidBy(error, t`That didn't happen. Check your connection and try again.`));
    },
  });
  const set = (patch: Partial<BatchesForm>): void => {
    setForm((before) => ({ ...before, ...patch }));
    setProblem(undefined);
  };
  const units: readonly (readonly [CampaignBatchUnit, string])[] = [
    ['minutes', t`minutes`],
    ['hours', t`hours`],
    ['days', t`days`],
  ];

  return (
    <SmallDialog
      open
      title={confirming ? t`Confirm` : t`Send or schedule`}
      returnFocus={returnFocus}
      onClose={() => {
        if (!go.isPending) onClose();
      }}
    >
      {confirming ? (
        <div className="flex flex-col gap-3">
          <p className="text-md font-medium wrap-anywhere">
            {sendAt === undefined
              ? t`Send “${name}” to ${count} contacts from ${from} now?`
              : t`Schedule “${name}” for ${count} contacts from ${from}, starting ${start}?`}
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-body">
            {batches === null ? null : <li>{batchesSentence(batches)}</li>}
            {estimated === undefined ? null : <li>{estimated}</li>}
            <li>
              {sendAt === undefined ? (
                <Trans>
                  Sending starts at once. You can pause or cancel it, but emails that have left stay
                  sent, and the email can no longer be changed.
                </Trans>
              ) : (
                <Trans>
                  Until it starts you can cancel it, and it becomes a draft again. The audience is
                  counted again when it starts.
                </Trans>
              )}
            </li>
          </ul>
          {problem === undefined ? null : (
            <p role="alert" className={problemClassName}>
              {problem}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              disabled={go.isPending}
              onClick={() => {
                setConfirming(false);
                setProblem(undefined);
              }}
            >
              <Trans>Back</Trans>
            </Button>
            <Button
              disabled={go.isPending}
              onClick={() => {
                setProblem(undefined);
                go.mutate();
              }}
            >
              {go.isPending
                ? t`Working…`
                : sendAt === undefined
                  ? t`Send now`
                  : t`Schedule campaign`}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) setConfirming(true);
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className={`${labelClassName} mb-1`}>
              <Trans>When</Trans>
            </legend>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-md lg:min-h-0">
              <input
                type="radio"
                name={`${id}-when`}
                className="size-4 accent-primary"
                checked={when === 'now'}
                onChange={() => {
                  setWhen('now');
                }}
              />
              <Trans>Send now</Trans>
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-md lg:min-h-0">
              <input
                type="radio"
                name={`${id}-when`}
                className="size-4 accent-primary"
                checked={when === 'later'}
                onChange={() => {
                  setWhen('later');
                }}
              />
              <Trans>Schedule for a date and time</Trans>
            </label>
            {when === 'later' ? (
              <div className="flex flex-col gap-1 pl-6">
                <label htmlFor={`${id}-at`} className={labelClassName}>
                  <Trans>Start sending at</Trans>
                </label>
                <Input
                  id={`${id}-at`}
                  type="datetime-local"
                  value={at}
                  min={inputOfInstant(opened, timeZone)}
                  aria-invalid={lateProblem !== undefined}
                  aria-describedby={`${id}-at-hint`}
                  onChange={(event) => {
                    setAt(event.target.value);
                  }}
                />
                <p
                  id={`${id}-at-hint`}
                  className={
                    lateProblem === undefined ? 'text-xs text-muted-foreground' : problemClassName
                  }
                >
                  {lateProblem ?? t`On the business's clock: ${timeZone}.`}
                </p>
              </div>
            ) : null}
          </fieldset>
          <div className="flex flex-col gap-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-md lg:min-h-0">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={batched}
                onChange={(event) => {
                  setBatched(event.target.checked);
                }}
              />
              <Trans>Send in batches</Trans>
            </label>
            {batched ? (
              <div className="flex flex-col gap-3 pl-6">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex w-28 flex-col gap-1">
                    <label htmlFor={`${id}-size`} className={labelClassName}>
                      <Trans>Emails in a batch</Trans>
                    </label>
                    <Input
                      id={`${id}-size`}
                      inputMode="numeric"
                      value={form.size}
                      aria-invalid={batchProblems.size !== undefined}
                      onChange={(event) => {
                        set({ size: event.target.value });
                      }}
                    />
                  </div>
                  <div className="flex w-24 flex-col gap-1">
                    <label htmlFor={`${id}-every`} className={labelClassName}>
                      <Trans>One batch every</Trans>
                    </label>
                    <Input
                      id={`${id}-every`}
                      inputMode="numeric"
                      value={form.every}
                      aria-invalid={batchProblems.every !== undefined}
                      onChange={(event) => {
                        set({ every: event.target.value });
                      }}
                    />
                  </div>
                  <Select
                    aria-label={t`Unit of time between batches`}
                    className="w-28"
                    value={form.unit}
                    onValueChange={(next) => {
                      const unit = units.find(([value]) => value === next)?.[0];
                      if (unit !== undefined) set({ unit });
                    }}
                  >
                    {units.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </div>
                {batchProblems.size === undefined ? null : (
                  <p className={problemClassName}>{batchProblems.size}</p>
                )}
                {batchProblems.every === undefined ? null : (
                  <p className={problemClassName}>{batchProblems.every}</p>
                )}
                <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-md lg:min-h-0">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={form.windowed}
                    onChange={(event) => {
                      set({ windowed: event.target.checked });
                    }}
                  />
                  <Trans>Only between certain hours of the day</Trans>
                </label>
                {form.windowed ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex w-32 flex-col gap-1">
                      <label htmlFor={`${id}-from`} className={labelClassName}>
                        <Trans>From</Trans>
                      </label>
                      <Input
                        id={`${id}-from`}
                        type="time"
                        value={form.from}
                        aria-invalid={batchProblems.window !== undefined}
                        onChange={(event) => {
                          set({ from: event.target.value });
                        }}
                      />
                    </div>
                    <div className="flex w-32 flex-col gap-1">
                      <label htmlFor={`${id}-to`} className={labelClassName}>
                        <Trans>Until</Trans>
                      </label>
                      <Input
                        id={`${id}-to`}
                        type="time"
                        value={form.to}
                        aria-invalid={batchProblems.window !== undefined}
                        onChange={(event) => {
                          set({ to: event.target.value });
                        }}
                      />
                    </div>
                    <p className="basis-full text-xs text-muted-foreground">
                      {batchProblems.window ?? t`Hours of the business's day (${timeZone}).`}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className={`${hintClassName} pl-6`}>
                <Trans>
                  Without batches it leaves as fast as the mailbox allows; replies and workflow
                  emails still go first.
                </Trans>
              </p>
            )}
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-muted px-3 py-2">
            <span className={labelClassName}>
              <Trans>How long it will take</Trans>
            </span>
            <p role="status" className="text-md text-body">
              {estimated ??
                (valid
                  ? t`The audience has not been counted yet.`
                  : t`Put right what is marked above to see it.`)}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={!valid}>
              <Trans>Continue</Trans>
            </Button>
          </div>
        </form>
      )}
    </SmallDialog>
  );
}
