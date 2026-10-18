// The left of the calendars list, as GoHighLevel's: "All calendars (n)", then Groups with
// "Not grouped" and each group with its count and its menu, and "+ New group". Choosing an
// entry filters the table. Deleting a group leaves its calendars, in no group.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  calendarGroupInput,
  createCalendarGroup,
  deleteCalendarGroup,
  renameCalendarGroup,
  type CalendarGroup,
  type CalendarGroupList,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ALL, NO_GROUP } from './calendar-settings-rules';
import { rejection } from './problems';
import { ConfirmDialog, ListProblem, RowMenu, SmallDialog } from './settings-list';

const entryClassName =
  'flex min-h-11 w-full min-w-0 items-center gap-2 rounded-control px-3 text-left text-md text-body -outline-offset-2 hover:bg-muted hover:text-foreground aria-[current=true]:bg-accent aria-[current=true]:font-medium aria-[current=true]:text-link lg:min-h-9';

function Entry({
  current,
  count,
  onSelect,
  children,
}: {
  readonly current: boolean;
  readonly count?: number;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <button type="button" aria-current={current} className={entryClassName} onClick={onSelect}>
      <span className="min-w-0 truncate">{children}</span>
      {count === undefined ? null : (
        <>
          {/* Read between the name and its count; a flex row draws no space for it. */}{' '}
          <Badge size="count">{count}</Badge>
        </>
      )}
    </button>
  );
}

function NameDialog({
  group,
  client,
  onClose,
  onSaved,
}: {
  /** The group renamed; none for a new group. */
  readonly group: CalendarGroup | undefined;
  readonly client: Client;
  readonly onClose: () => void;
  readonly onSaved: (group: CalendarGroup, created: boolean) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [name, setName] = useState(group?.name ?? '');
  const [problem, setProblem] = useState<string>();
  const save = useMutation({
    mutationFn: (body: { name: string }) =>
      group === undefined
        ? client.request(createCalendarGroup, { body })
        : client.request(renameCalendarGroup, { params: { groupId: group.id }, body }),
    onSuccess: (saved) => {
      onSaved(saved, group === undefined);
    },
    onError: (error) => {
      const refused =
        error instanceof ApiError && error.problem.errors !== undefined
          ? rejection(error.problem.errors)
          : undefined;
      setProblem(
        refused?.fields['name'] ??
          refused?.form ??
          (error instanceof ApiError
            ? (error.problem.detail ?? t`The group wasn't saved. Try again.`)
            : t`The group wasn't saved. Check your connection and try again.`),
      );
    },
  });
  return (
    <form
      noValidate
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (save.isPending) return;
        const parsed = calendarGroupInput.safeParse({ name });
        if (!parsed.success) {
          setProblem(parsed.error.issues[0]?.message ?? t`Give the group a name.`);
          return;
        }
        setProblem(undefined);
        save.mutate(parsed.data);
      }}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          <Trans>Group name</Trans>
        </label>
        <Input
          id={id}
          required
          maxLength={120}
          autoComplete="off"
          disabled={save.isPending}
          aria-invalid={problem !== undefined}
          aria-describedby={problem === undefined ? undefined : `${id}-problem`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setProblem(undefined);
          }}
        />
        {problem === undefined ? null : (
          <p id={`${id}-problem`} role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={save.isPending} onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {group === undefined ? <Trans>Create group</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
    </form>
  );
}

export function GroupsRail({
  client,
  groups,
  failed,
  onRetry,
  selected,
  onSelect,
  onChanged,
}: {
  readonly client: Client;
  /** None while the groups are being read. */
  readonly groups: CalendarGroupList | undefined;
  /** True when the groups could not be read: the rail says so, apart from the table. */
  readonly failed: boolean;
  readonly onRetry: () => void;
  /** "all", "none", or a group's id. */
  readonly selected: string;
  readonly onSelect: (group: string) => void;
  /** After a group was made, renamed or deleted: what to say, and the lists to read again. */
  readonly onChanged: (notice: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [naming, setNaming] = useState<{ readonly group: CalendarGroup | undefined }>();
  const [deleting, setDeleting] = useState<CalendarGroup>();
  const [deleteProblem, setDeleteProblem] = useState<string>();
  const remove = useMutation({
    mutationFn: async (group: CalendarGroup) => {
      await client.request(deleteCalendarGroup, { params: { groupId: group.id } });
      return group;
    },
    onSuccess: (group) => {
      setDeleting(undefined);
      if (selected === group.id) onSelect(ALL);
      const { name } = group;
      onChanged(t`${name} was deleted. Its calendars are kept, in no group.`);
    },
    onError: (error) => {
      setDeleteProblem(
        error instanceof ApiError
          ? (error.problem.detail ?? t`The group wasn't deleted. Try again.`)
          : t`The group wasn't deleted. Check your connection and try again.`,
      );
    },
  });
  const total = groups?.calendarCount;
  const canManage = groups?.canManage === true;
  const deletingName = deleting?.name ?? '';
  return (
    <nav aria-label={t`Calendar groups`} className="flex min-w-0 shrink-0 flex-col gap-3 lg:w-64">
      <Entry
        current={selected === ALL}
        onSelect={() => {
          onSelect(ALL);
        }}
      >
        {total === undefined ? (
          <Trans>All calendars</Trans>
        ) : (
          <Trans>All calendars ({total})</Trans>
        )}
      </Entry>
      <div className="flex min-w-0 flex-col gap-1 border-t border-border pt-3">
        <h2 className="px-3 pb-1 text-md font-medium">
          <Trans>Groups</Trans>
        </h2>
        {failed ? (
          <ListProblem onRetry={onRetry}>
            <Trans>We couldn't load the groups.</Trans>
          </ListProblem>
        ) : null}
        <ul className="flex min-w-0 flex-col gap-0.5">
          <li>
            <Entry
              current={selected === NO_GROUP}
              {...(groups === undefined ? {} : { count: groups.ungroupedCount })}
              onSelect={() => {
                onSelect(NO_GROUP);
              }}
            >
              <Trans>Not grouped</Trans>
            </Entry>
          </li>
          {(groups?.items ?? []).map((group) => {
            const { name } = group;
            return (
              <li key={group.id} className="flex min-w-0 items-center gap-1">
                <Entry
                  current={selected === group.id}
                  count={group.calendarCount}
                  onSelect={() => {
                    onSelect(group.id);
                  }}
                >
                  {name}
                </Entry>
                {canManage ? (
                  <RowMenu
                    label={t`Actions for the group ${name}`}
                    onOpen={(trigger) => {
                      returnFocusRef.current = trigger;
                    }}
                    actions={[
                      {
                        label: t`Rename`,
                        onSelect: () => {
                          setNaming({ group });
                        },
                      },
                      {
                        label: t`Delete`,
                        destructive: true,
                        onSelect: () => {
                          setDeleteProblem(undefined);
                          setDeleting(group);
                        },
                      },
                    ]}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        {canManage ? (
          <Button
            variant="secondary"
            className="mt-2 text-link"
            onClick={(event) => {
              returnFocusRef.current = event.currentTarget;
              setNaming({ group: undefined });
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>New group</Trans>
          </Button>
        ) : null}
      </div>
      <SmallDialog
        open={naming !== undefined}
        returnFocus={returnFocusRef}
        title={naming?.group === undefined ? <Trans>New group</Trans> : <Trans>Rename group</Trans>}
        onClose={() => {
          setNaming(undefined);
        }}
      >
        {naming === undefined ? null : (
          <NameDialog
            key={naming.group?.id ?? 'new'}
            group={naming.group}
            client={client}
            onClose={() => {
              setNaming(undefined);
            }}
            onSaved={(saved, created) => {
              setNaming(undefined);
              const { name } = saved;
              onChanged(created ? t`Group ${name} created.` : t`Group renamed to ${name}.`);
            }}
          />
        )}
      </SmallDialog>
      <ConfirmDialog
        open={deleting !== undefined}
        returnFocus={returnFocusRef}
        title={<Trans>Delete the group {deletingName}?</Trans>}
        description={<Trans>The calendars in it are kept. They go back to "Not grouped".</Trans>}
        confirmLabel={t`Delete`}
        destructive
        busy={remove.isPending}
        problem={deleteProblem}
        onClose={() => {
          if (!remove.isPending) setDeleting(undefined);
        }}
        onConfirm={() => {
          if (deleting !== undefined) remove.mutate(deleting);
        }}
      />
    </nav>
  );
}
