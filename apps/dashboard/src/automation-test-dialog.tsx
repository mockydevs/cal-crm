// "Test workflow" (docs/AUTOMATIONS.md section 6): a dry run of the saved draft, with time
// fast-forwarded. The server walks the draft and answers what each action would do, for a
// contact's own values when one is chosen; nothing is sent and nothing is changed.
//
// Its own chunk, loaded when someone first asks for a test.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createAutomationTestRun,
  getAutomationTestRun,
  type AutomationSetup,
  type AutomationTestRun,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useMemo, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { AutomationDialog } from './automation-dialog';
import { stepOf, type Draft } from './automation-document';
import { RecordFilter, type RecordChoice } from './automation-history-filters';
import { failureWords, momentWords } from './automation-run-words';
import SimulatedOutput from './automation-simulated-output';
import TestedEmailPreview from './automation-test-email';
import {
  eventsAwaited,
  fieldsRead,
  testRunBody,
  type EventRow,
  type SampleRow,
} from './automation-test-inputs';
import { stopEventWords } from './automation-stop-words';
import { branchLabel, stepLabel, stepName, triggerLabel } from './automation-summary';
import { useBusiness } from './workspace';

export interface TestDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly automationId: string;
  /** The draft as last saved: the one the test runs. */
  readonly saved: Draft;
  readonly setup: AutomationSetup;
  /** Changes not saved yet: the test would not see them, so saving comes first. */
  readonly unsaved: boolean;
}

type TraceStep = AutomationTestRun['steps'][number];

export default function TestDialog({
  open,
  onOpenChange,
  automationId,
  saved,
  setup,
  unsaved,
}: TestDialogProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const [contact, setContact] = useState<RecordChoice>();
  const [problem, setProblem] = useState<string>();
  // What the test is told beside the contact: values for fields, and events during waits.
  const [samples, setSamples] = useState<readonly SampleRow[]>([]);
  const [events, setEvents] = useState<readonly EventRow[]>([]);
  const fields = useMemo(() => fieldsRead(saved), [saved]);
  const awaited = useMemo(() => eventsAwaited(saved), [saved]);
  const eventName = (event: string): string =>
    stopEventWords(event, undefined) ?? triggerLabel(event) ?? event;
  const rowButtonClassName =
    'flex size-11 shrink-0 items-center justify-center rounded-control text-body hover:bg-muted hover:text-foreground lg:size-9';
  const failed = (error: unknown): void => {
    setProblem(
      !(error instanceof ApiError)
        ? t`We couldn't run the test. Check your connection and try again.`
        : error.status === 403
          ? t`You don't have permission to test workflows.`
          : (error.problem.errors?.[0]?.message ??
            error.problem.detail ??
            t`We couldn't run the test. Try again.`),
    );
  };
  const test = useMutation({
    mutationFn: () =>
      client.request(createAutomationTestRun, {
        params: { id: automationId },
        body: testRunBody(contact?.id, samples, events, setup),
      }),
    onError: failed,
  });
  // A test still running when it was answered is read again on request.
  const again = useMutation({
    mutationFn: (runId: string) =>
      client.request(getAutomationTestRun, { params: { id: automationId, runId } }),
    onError: failed,
  });
  const run = again.data ?? test.data;
  const busy = test.isPending || again.isPending;
  const nameOf = (key: string): string => {
    const step = stepOf(saved, key);
    return step === undefined ? key : stepName(step, setup);
  };
  const kindWords = (kind: TraceStep['kind']): string =>
    kind === 'would_send'
      ? t`Would send`
      : kind === 'would_change'
        ? t`Would change`
        : kind === 'waited'
          ? t`Waited`
          : kind === 'branched'
            ? t`Branched`
            : kind === 'moved'
              ? t`Jumped`
              : t`Ended`;
  const outcome = (): string | undefined => {
    const result = run?.outcome;
    if (result === undefined || result === null) return undefined;
    if (result.kind === 'completed') return t`The test reached the end of the workflow.`;
    if (result.kind === 'stopped') {
      const why = stopEventWords(result.event, undefined) ?? result.event;
      return t`The workflow stopped early, because this happened: ${why}.`;
    }
    if (result.kind === 'failed') {
      const step = nameOf(result.step);
      const error = failureWords(result.error) ?? result.error;
      return t`The test failed at “${step}”: ${error}`;
    }
    const { steps } = result;
    return t`The test stopped after ${steps} actions, the most one test takes.`;
  };
  const summary = outcome();

  return (
    <AutomationDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          test.reset();
          again.reset();
          setProblem(undefined);
        }
        onOpenChange(next);
      }}
      wide
      title={<Trans>Test workflow</Trans>}
      description={
        <Trans>
          A dry run of the saved draft, with waits skipped: what each action would do. Nothing is
          sent and nothing is changed.
        </Trans>
      }
    >
      {unsaved ? (
        <p role="alert" className="rounded-xl border border-input px-3.5 py-3 text-md">
          <Trans>
            You have changes that aren't saved. Save first: the test runs the saved draft.
          </Trans>
        </p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm font-medium">
          <Trans>Contact to test with</Trans>{' '}
          <span className="font-normal text-muted-foreground">
            <Trans>(optional)</Trans>
          </span>
        </span>
        <RecordFilter value={contact} onChange={setContact} />
        <p className="text-sm text-muted-foreground">
          <Trans>
            The test reads this contact's own values, such as their tags. Without one, conditions
            see empty fields.
          </Trans>
        </p>
      </div>
      {fields.length === 0 ? null : (
        <section aria-label={t`Sample values`} className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium">
            <Trans>Sample values</Trans>{' '}
            <span className="font-normal text-muted-foreground">
              <Trans>(optional)</Trans>
            </span>
          </h3>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Give a field this workflow reads a value for this test, instead of the contact's own.
              Separate several values with commas.
            </Trans>
          </p>
          {samples.map((row, index) => {
            const place = index + 1;
            return (
              <div
                // Rows have no identity but their place.
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={index}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
              >
                <Select
                  aria-label={t`Field of sample value ${place}`}
                  value={row.field}
                  onValueChange={(next) => {
                    setSamples(
                      samples.map((each, at) => (at === index ? { ...each, field: next } : each)),
                    );
                  }}
                >
                  {fields.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label={t`Value of sample value ${place}`}
                  value={row.value}
                  onChange={(event) => {
                    setSamples(
                      samples.map((each, at) =>
                        at === index ? { ...each, value: event.target.value } : each,
                      ),
                    );
                  }}
                />
                <button
                  type="button"
                  className={rowButtonClassName}
                  aria-label={t`Remove sample value ${place}`}
                  onClick={() => {
                    setSamples(samples.filter((_, at) => at !== index));
                  }}
                >
                  <X aria-hidden className="size-4" strokeWidth={1.8} />
                </button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="secondary"
            size="small"
            className="self-start"
            onClick={() => {
              const next = fields.find((field) => !samples.some((row) => row.field === field));
              setSamples([...samples, { field: next ?? fields[0] ?? '', value: '' }]);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={1.8} />
            <Trans>Add a sample value</Trans>
          </Button>
        </section>
      )}
      {awaited.length === 0 ? null : (
        <section aria-label={t`Simulated events`} className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium">
            <Trans>What happens while it waits</Trans>{' '}
            <span className="font-normal text-muted-foreground">
              <Trans>(optional)</Trans>
            </span>
          </h3>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Pretend something this workflow waits for or stops on happens, this long after the
              test starts. Nothing really happens.
            </Trans>
          </p>
          {events.map((row, index) => {
            const place = index + 1;
            const change = (more: Partial<EventRow>): void => {
              setEvents(events.map((each, at) => (at === index ? { ...each, ...more } : each)));
            };
            return (
              <div
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={index}
                className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
              >
                <Select
                  aria-label={t`Event ${place}`}
                  value={row.event}
                  onValueChange={(next) => {
                    change({ event: next });
                  }}
                >
                  {awaited.map((event) => (
                    <option key={event} value={event}>
                      {eventName(event)}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label={t`How long after the start, for event ${place}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={row.amount ?? ''}
                  onChange={(event) => {
                    const typed = event.target.valueAsNumber;
                    change({ amount: Number.isNaN(typed) ? undefined : typed });
                  }}
                />
                <Select
                  aria-label={t`Unit for event ${place}`}
                  value={row.unit}
                  onValueChange={(next) => {
                    if (next === 'minutes' || next === 'hours' || next === 'days')
                      change({ unit: next });
                  }}
                >
                  <option value="minutes">{t`Minutes`}</option>
                  <option value="hours">{t`Hours`}</option>
                  <option value="days">{t`Days`}</option>
                </Select>
                <button
                  type="button"
                  className={rowButtonClassName}
                  aria-label={t`Remove event ${place}`}
                  onClick={() => {
                    setEvents(events.filter((_, at) => at !== index));
                  }}
                >
                  <X aria-hidden className="size-4" strokeWidth={1.8} />
                </button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="secondary"
            size="small"
            className="self-start"
            disabled={events.length >= 50}
            onClick={() => {
              setEvents([...events, { event: awaited[0] ?? '', amount: 1, unit: 'days' }]);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={1.8} />
            <Trans>Add an event</Trans>
          </Button>
        </section>
      )}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive wrap-anywhere">
          {problem}
        </p>
      )}
      {run === undefined ? null : (
        <section aria-label={t`Test result`} className="flex min-w-0 flex-col gap-3">
          <p role="status" className="text-md font-medium wrap-anywhere">
            {run.status === 'running' ? t`The test is still running.` : summary}
          </p>
          {run.status === 'running' ? (
            <Button
              variant="secondary"
              size="small"
              className="self-start"
              disabled={busy}
              onClick={() => {
                again.mutate(run.id);
              }}
            >
              <Trans>Check again</Trans>
            </Button>
          ) : null}
          {run.steps.length === 0 ? null : (
            <ol aria-label={t`What each action would do`} className="flex min-w-0 flex-col gap-2">
              {run.steps.map((step, position) => {
                const written = stepOf(saved, step.step);
                const when = momentWords(step.at) ?? step.at;
                const branch =
                  step.branch === undefined || written === undefined
                    ? undefined
                    : branchLabel(written, step.branch);
                return (
                  // A step can be met twice in one test, as in a loop: its place tells them apart.
                  <li
                    key={`${step.step}:${String(position)}`}
                    className="flex min-w-0 flex-col gap-1 rounded-2xl bg-background px-4 py-3"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
                        {kindWords(step.kind)}
                      </span>
                      <span className="min-w-0 flex-1 basis-40 text-md font-medium wrap-anywhere">
                        {step.kind === 'ended'
                          ? (stepLabel(step.type) ?? nameOf(step.step))
                          : nameOf(step.step)}
                      </span>
                      <time dateTime={step.at} className="text-sm text-muted-foreground">
                        {when}
                      </time>
                    </div>
                    {branch === undefined ? null : (
                      <p className="text-sm text-body">
                        <Trans>Branch taken: {branch}</Trans>
                      </p>
                    )}
                    {step.explanation === '' ? null : (
                      <p className="text-sm wrap-anywhere text-body">{step.explanation}</p>
                    )}
                    {step.email === undefined ? null : <TestedEmailPreview email={step.email} />}
                    <SimulatedOutput step={step} />
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          <Trans>Close</Trans>
        </Button>
        <Button
          data-initial-focus
          disabled={unsaved || busy}
          onClick={() => {
            setProblem(undefined);
            again.reset();
            test.mutate();
          }}
        >
          {run === undefined ? <Trans>Run test</Trans> : <Trans>Run test again</Trans>}
        </Button>
      </div>
    </AutomationDialog>
  );
}
