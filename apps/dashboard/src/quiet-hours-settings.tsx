import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  getMessagingSettings,
  updateMessagingSettings,
  updateMessagingSettingsInput,
  type MessagingSettings,
  type UpdateMessagingSettingsInput,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { quietHoursSpan } from './consent-summary';
import { issuesOf, noRejection, rejection } from './problems';
import { useBusiness } from './workspace';

/**
 * The business's quiet hours and how many messages one contact may get in a day. Both
 * apply to every channel and every sender, so they sit apart from any one mailbox.
 */
export function QuietHoursSettings(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  const current = useQuery({
    queryKey: ['b', business.id, 'messaging-settings'],
    queryFn: () => apiIn(business.id).request(getMessagingSettings, {}),
  });
  // Kept here because a save, mine or someone else's, replaces the form below.
  const [outcome, setOutcome] = useState<Outcome>();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>Quiet hours</Trans>
      </h2>
      {current.isPending ? (
        <p role="status" className="text-sm">{t`Loading quiet hours…`}</p>
      ) : null}
      {current.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t`We couldn't load quiet hours.`}</p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void current.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {outcome === 'replaced' ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>
            Someone else changed these settings while you had them open. The latest are shown here:
            make your change again.
          </Trans>
        </p>
      ) : null}
      {current.data === undefined ? null : (
        <QuietHoursForm
          // A new revision is someone's save: start again from what is stored.
          key={current.data.revision}
          settings={current.data}
          onOutcome={(next) => {
            setOutcome(next);
            if (next === 'replaced') void current.refetch();
          }}
        />
      )}
      <p role="status" className="text-sm empty:sr-only">
        {outcome === 'saved' ? t`Quiet hours saved.` : null}
      </p>
    </section>
  );
}

type Outcome = 'saved' | 'replaced' | undefined;

function QuietHoursForm({
  settings,
  onOutcome,
}: {
  readonly settings: MessagingSettings;
  readonly onOutcome: (outcome: Outcome) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [enabled, setEnabled] = useState(settings.quietHoursEnabled);
  const [start, setStart] = useState(settings.quietHoursStart);
  const [end, setEnd] = useState(settings.quietHoursEnd);
  const [limit, setLimit] = useState(String(settings.contactDailyLimit));
  const [problem, setProblem] = useState(noRejection);
  const span = quietHoursSpan(start, end);
  const held = settings.heldMessages;
  const untimed = settings.contactsWithoutTimeZone;
  const save = useMutation({
    mutationFn: (body: UpdateMessagingSettingsInput) =>
      apiIn(business.id).request(updateMessagingSettings, { body }),
    onSuccess: (saved) => {
      onOutcome('saved');
      setProblem(noRejection);
      cache.setQueryData(['b', business.id, 'messaging-settings'], saved);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        onOutcome('replaced');
        return;
      }
      const issues = error instanceof ApiError ? (error.problem.errors ?? []) : [];
      setProblem(
        issues.length > 0
          ? rejection(issues)
          : {
              fields: {},
              form:
                error instanceof ApiError
                  ? error.message
                  : t`Quiet hours weren't saved. Check your connection and try again.`,
            },
      );
    },
  });
  return (
    <Form<Record<string, unknown>>
      errors={problem.fields}
      onFormSubmit={() => {
        onOutcome(undefined);
        const parsed = updateMessagingSettingsInput.safeParse({
          quietHoursEnabled: enabled,
          quietHoursStart: start,
          quietHoursEnd: end,
          contactDailyLimit: Number(limit),
          revision: settings.revision,
        });
        if (!parsed.success) {
          setProblem(rejection(issuesOf(parsed.error)));
          return;
        }
        setProblem(noRejection);
        save.mutate(parsed.data);
      }}
    >
      <fieldset
        disabled={save.isPending || !settings.canManage}
        className="flex min-w-0 flex-col gap-4 border-0 p-0"
      >
        <legend className="sr-only">
          <Trans>Quiet hours and daily limit</Trans>
        </legend>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <Trans>
            During quiet hours, messages wait and go out after they end. The hours are in each
            contact's own time zone, and they apply to every message, replies included.
          </Trans>
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
            }}
          />
          <Trans>Hold messages during quiet hours</Trans>
        </label>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field name="quietHoursStart">
            <FieldLabel>
              <Trans>Quiet hours start</Trans>
            </FieldLabel>
            <Input
              type="time"
              required
              disabled={!enabled}
              value={start}
              onValueChange={setStart}
            />
            <FieldError />
          </Field>
          <Field name="quietHoursEnd">
            <FieldLabel>
              <Trans>Quiet hours end</Trans>
            </FieldLabel>
            <Input type="time" required disabled={!enabled} value={end} onValueChange={setEnd} />
            <FieldError />
          </Field>
        </div>
        {!enabled ? (
          <p className="text-sm">
            <Trans>Quiet hours are off: messages can go out at any time.</Trans>
          </p>
        ) : span === 'overnight' ? (
          <p className="text-sm">{t`Messages wait from ${start} until ${end} the next morning.`}</p>
        ) : span === 'same_day' ? (
          <p className="text-sm">{t`Messages wait from ${start} until ${end} the same day.`}</p>
        ) : (
          <p className="text-sm">
            <Trans>Choose a start and an end that differ, or turn quiet hours off.</Trans>
          </p>
        )}
        {held === 0 ? null : (
          <p className="text-sm">
            <Plural
              value={held}
              one="# message is waiting for quiet hours to end."
              other="# messages are waiting for quiet hours to end."
            />
          </p>
        )}
        {untimed === 0 || !enabled ? null : (
          <p className="rounded-card bg-secondary p-3 text-sm text-secondary-foreground">
            <Plural
              value={untimed}
              one="# contact has no time zone of its own. Its workflow and campaign messages keep quiet hours by the business's time zone."
              other="# contacts have no time zone of their own. Their workflow and campaign messages keep quiet hours by the business's time zone."
            />
          </p>
        )}
        <Field name="contactDailyLimit">
          <FieldLabel>
            <Trans>Messages per contact in 24 hours</Trans>
          </FieldLabel>
          <Input
            type="number"
            min={1}
            max={10000}
            step={1}
            required
            value={limit}
            onValueChange={setLimit}
          />
          <FieldDescription>
            <Trans>
              Counts every channel together. A message over the limit waits until there is room.
            </Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        {settings.canManage ? (
          <Button type="submit" className="self-start">
            {save.isPending ? t`Saving…` : t`Save quiet hours`}
          </Button>
        ) : null}
      </fieldset>
      {settings.canManage ? null : (
        <p className="text-sm text-muted-foreground">
          <Trans>You can see these settings, but your role can't change them.</Trans>
        </p>
      )}
    </Form>
  );
}
