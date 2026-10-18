// A blocked slot, added, changed or removed, as GoHighLevel's "+ New → Blocked slot": a
// title, whose time it is (a team member, or everyone on one calendar), which calendar (all
// of the person's, or one), and when, typed by the clock of the business's zone. Fetched
// when its panel first opens. The server's refusals are shown in its own words beside the
// field they name.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createBlockedSlot,
  deleteBlockedSlot,
  getBlockedSlot,
  updateBlockedSlot,
  type BlockedSlot,
} from '@repo/contracts';
import { type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import {
  ALL,
  blockedSlotBody,
  blockedSlotDraft,
  type BlockedSlotDraft,
  type BlockedSlotFault,
} from './blocked-slot-rules';
import { blockedSlotsKey, eventsKey, useCalendarChoices, useTeam } from './calendar-shared';
import {
  panelFormClassName,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './conversation-extras-panel';
import { noRejection, type Rejection } from './problems';
import { isStale, ListProblem, retryFaults, savingProblem } from './settings-list';

const errorClassName = 'text-sm leading-normal font-medium text-destructive';

export interface BlockedSlotFormProps {
  readonly client: Client;
  readonly businessId: string;
  /** The business's zone: the times are typed and shown by its clock. */
  readonly zone: string;
  /** The blocked slot to change, or undefined to add one. */
  readonly slotId: string | undefined;
  /** Whose time a new one blocks, already chosen, as from a person's Time away. */
  readonly member?: string | undefined;
  /** Where a new one starts: a time pressed on the calendar, or the next whole hour. */
  readonly start?: number | undefined;
  readonly onDone: (notice: string) => void;
  readonly onCancel: () => void;
}

export function BlockedSlotForm(props: BlockedSlotFormProps): ReactElement {
  const { client, slotId } = props;
  const saved = useQuery({
    queryKey: ['blocked-slot', props.businessId, slotId],
    queryFn: () => client.request(getBlockedSlot, { params: { blockedSlotId: slotId ?? '' } }),
    enabled: slotId !== undefined,
    retry: retryFaults,
  });
  if (slotId === undefined) return <Editor {...props} saved={undefined} onReload={undefined} />;
  if (saved.isError)
    return (
      <div className={sidePanelBodyClassName}>
        <ListProblem
          onRetry={() => {
            void saved.refetch();
          }}
        >
          <Trans>This blocked slot couldn't be loaded. It may have been removed.</Trans>
        </ListProblem>
      </div>
    );
  if (saved.data === undefined)
    return (
      <div className={sidePanelBodyClassName}>
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading the blocked slot…</Trans>
        </p>
      </div>
    );
  return (
    <Editor
      key={saved.data.revision}
      {...props}
      saved={saved.data}
      onReload={() => {
        void saved.refetch();
      }}
    />
  );
}

function Editor({
  client,
  businessId,
  zone,
  member,
  start,
  saved,
  onDone,
  onCancel,
  onReload,
}: BlockedSlotFormProps & {
  readonly saved: BlockedSlot | undefined;
  readonly onReload: (() => void) | undefined;
}): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<BlockedSlotDraft>(() =>
    blockedSlotDraft(
      saved,
      {
        ...(member === undefined ? {} : { membershipId: member }),
        ...(start === undefined ? {} : { start }),
      },
      zone,
    ),
  );
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [deleting, setDeleting] = useState(false);
  const memberErrorId = useId();
  const calendarErrorId = useId();
  const change = (next: Partial<BlockedSlotDraft>): void => {
    setDraft((current) => ({ ...current, ...next }));
  };
  const team = useTeam(businessId);
  const calendars = useCalendarChoices(businessId);
  const people = team.data?.members ?? [];
  // Someone chosen who is no longer on the team, or whom the team list does not show.
  const savedName = saved?.member?.name ?? '';
  const unlisted =
    draft.membershipId !== ALL && !people.some((person) => person.id === draft.membershipId);

  const faultWords = (fault: BlockedSlotFault): string =>
    fault === 'missing'
      ? t`This is needed.`
      : fault === 'whom'
        ? t`Choose a team member, a calendar, or both.`
        : t`End the blocked time after it starts.`;
  const settled = async (notice: string): Promise<void> => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: eventsKey(businessId) }),
      cache.invalidateQueries({ queryKey: blockedSlotsKey(businessId) }),
    ]);
    onDone(notice);
  };
  const refused = (error: unknown): void => {
    const words = savingProblem(
      error,
      t`The blocked slot wasn't saved. Check your connection and try again.`,
    );
    setProblem(
      isStale(error)
        ? {
            fields: {},
            form: t`This blocked slot changed since you opened it. Reload it, then save again.`,
          }
        : words,
    );
  };

  const save = useMutation({
    mutationFn: async (): Promise<BlockedSlot | undefined> => {
      const checked = blockedSlotBody(draft, zone);
      if ('faults' in checked) {
        const fields: Record<string, string> = {};
        for (const [field, fault] of Object.entries(checked.faults))
          fields[field] = faultWords(fault);
        setProblem({ fields, form: undefined });
        return undefined;
      }
      return saved === undefined
        ? client.request(createBlockedSlot, { body: checked.body })
        : client.request(updateBlockedSlot, {
            params: { blockedSlotId: saved.id },
            body: { ...checked.body, revision: saved.revision },
          });
    },
    onSuccess: async (done) => {
      if (done !== undefined)
        await settled(saved === undefined ? t`Blocked slot added.` : t`Blocked slot saved.`);
    },
    onError: refused,
  });
  const remove = useMutation({
    mutationFn: () =>
      client.request(deleteBlockedSlot, { params: { blockedSlotId: saved?.id ?? '' } }),
    onSuccess: async () => {
      await settled(t`Blocked slot removed.`);
    },
    onError: (error) => {
      setDeleting(false);
      refused(error);
    },
  });
  const busy = save.isPending || remove.isPending;

  return (
    <Form<Record<string, unknown>>
      className={panelFormClassName}
      errors={problem.fields}
      onFormSubmit={() => {
        if (busy) return;
        setProblem(noRejection);
        save.mutate();
      }}
    >
      <div className={sidePanelBodyClassName}>
        <Field name="title">
          <FieldLabel>
            <Trans>Title</Trans>
          </FieldLabel>
          <Input
            maxLength={200}
            value={draft.title}
            onChange={(event) => {
              change({ title: event.target.value });
            }}
          />
          <FieldDescription>
            <Trans>Only people who may manage calendars see it.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>

        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <Trans>Calendar</Trans>
            <Select
              aria-label={t`Calendar`}
              {...(problem.fields['calendarId'] === undefined
                ? {}
                : { 'aria-describedby': calendarErrorId })}
              value={draft.calendarId}
              onValueChange={(value) => {
                change({ calendarId: value });
              }}
            >
              <option value={ALL}>{t`All calendars`}</option>
              {calendars.items.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </Select>
          </label>
          {calendars.isError ? (
            <ListProblem onRetry={calendars.retry}>
              <Trans>Calendars couldn't be loaded.</Trans>
            </ListProblem>
          ) : null}
          {problem.fields['calendarId'] === undefined ? null : (
            <p id={calendarErrorId} role="alert" className={errorClassName}>
              {problem.fields['calendarId']}
            </p>
          )}
        </div>

        {member === undefined ? (
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <Trans>Team member</Trans>
              <Select
                aria-label={t`Team member`}
                {...(problem.fields['membershipId'] === undefined
                  ? {}
                  : { 'aria-describedby': memberErrorId })}
                value={draft.membershipId}
                onValueChange={(value) => {
                  change({ membershipId: value });
                }}
              >
                <option value={ALL}>
                  {draft.calendarId === ALL
                    ? t`Choose a team member`
                    : t`Everyone on this calendar`}
                </option>
                {unlisted ? (
                  <option value={draft.membershipId}>
                    {savedName === '' ? t`Team member` : savedName}
                  </option>
                ) : null}
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name || person.email}
                  </option>
                ))}
              </Select>
            </label>
            {team.isError ? (
              <p className="text-sm leading-normal text-muted-foreground">
                <Trans>The team couldn't be loaded, so only a whole calendar can be blocked.</Trans>
              </p>
            ) : null}
            {problem.fields['membershipId'] === undefined ? null : (
              <p id={memberErrorId} role="alert" className={errorClassName}>
                {problem.fields['membershipId']}
              </p>
            )}
          </div>
        ) : null}

        <Field name="startsAt">
          <FieldLabel>
            <Trans>Starts ({zone})</Trans>
          </FieldLabel>
          <Input
            type="datetime-local"
            required
            min="0001-01-01T00:00"
            max="9999-12-31T23:59"
            value={draft.start}
            onChange={(event) => {
              change({ start: event.target.value });
            }}
          />
          <FieldError />
        </Field>
        <Field name="endsAt">
          <FieldLabel>
            <Trans>Ends ({zone})</Trans>
          </FieldLabel>
          <Input
            type="datetime-local"
            required
            min="0001-01-01T00:00"
            max="9999-12-31T23:59"
            value={draft.end}
            onChange={(event) => {
              change({ end: event.target.value });
            }}
          />
          <FieldDescription>
            <Trans>
              Nothing new can be booked in this time. Appointments already in it stay where they
              are.
            </Trans>
          </FieldDescription>
          <FieldError />
        </Field>

        {problem.form === undefined ? null : (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className={errorClassName}>
              {problem.form}
            </p>
            {onReload === undefined ? null : (
              <Button variant="secondary" size="small" disabled={busy} onClick={onReload}>
                <Trans>Reload saved version</Trans>
              </Button>
            )}
          </div>
        )}
        {deleting ? (
          <div
            role="group"
            aria-label={t`Remove this blocked slot?`}
            className="flex flex-col gap-2 rounded-lg border border-destructive p-3"
          >
            <p className="text-sm text-foreground">
              <Trans>Remove this blocked slot? Its time can be booked again.</Trans>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="border-destructive text-destructive"
                disabled={busy}
                onClick={() => {
                  setProblem(noRejection);
                  remove.mutate();
                }}
              >
                <Trans>Remove</Trans>
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setDeleting(false);
                }}
              >
                <Trans>Keep it</Trans>
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <div className={sidePanelFooterClassName}>
        {saved === undefined || deleting ? null : (
          <Button
            variant="secondary"
            className="mr-auto border-destructive text-destructive"
            disabled={busy}
            onClick={() => {
              setDeleting(true);
            }}
          >
            <Trans>Delete</Trans>
          </Button>
        )}
        <Button
          variant="secondary"
          className={saved === undefined || deleting ? 'mr-auto' : undefined}
          disabled={busy}
          onClick={() => {
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={busy}>
          {saved === undefined ? <Trans>Block time</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
    </Form>
  );
}
