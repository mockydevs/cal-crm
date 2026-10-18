// "Sharing & permissions" of a saved view, as GoHighLevel has it for a smart list: share it
// with all users or with selected users, each able to view it (open and use it) or edit it
// (also change what it shows and who it is shared with), or keep it to yourself; and copy a
// link to it. A step of the panel that edits the view (saved-view-panel.tsx).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  listTaskAssignees,
  setViewSharing,
  unshareView,
  type SavedView,
  type ViewAccessLevel,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { sidePanelBodyClassName, sidePanelFooterClassName } from './list-toolbar';
import {
  choosable,
  departedCount,
  sharingAllowed,
  sharingChanged,
  sharingDraftOf,
  sharingInputOf,
  type SharingDraft,
  type SharingMode,
} from './saved-view-sharing-rules';
import { useBusiness } from './workspace';

const selectClassName =
  'min-h-11 rounded-control border border-input bg-card px-2 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50 lg:min-h-9';
const optionClassName = 'flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3';

export function ViewSharing({
  view,
  queryKey,
  link,
  onDone,
  onCancel,
  onBusy,
}: {
  /** The view as last read: its sharing, revision and what the reader may do. */
  readonly view: SavedView;
  /** Where the saved views are cached, read again once the sharing is saved. */
  readonly queryKey: readonly string[];
  /** The address that opens the list with this view chosen. */
  readonly link: string;
  readonly onDone: (notice: string) => void;
  readonly onCancel: () => void;
  readonly onBusy: (busy: boolean) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const groupId = useId();
  const [draft, setDraft] = useState<SharingDraft>(() => sharingDraftOf(view));
  // The version of the view the draft started from: a newer one is reviewed before saving,
  // so a teammate's change of sharing is never overwritten unseen.
  const [base, setBase] = useState(view.revision);
  const stale = view.revision !== base;
  const [text, setText] = useState('');
  const [copied, setCopied] = useState<'yes' | 'no'>();
  const owner = view.access === 'owner';
  // Only the owner keeps a view to themselves; without the permission to share, that is
  // all they may do.
  const modes: readonly SharingMode[] = view.canChangeSharing
    ? owner
      ? ['private', 'everyone', 'selected']
      : ['everyone', 'selected']
    : ['private'];
  const team = useInfiniteQuery({
    queryKey: ['b', business.id, 'task-assignees'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(business.id).request(listTaskAssignees, {
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: view.canChangeSharing,
    staleTime: 60_000,
  });
  const members = team.data?.pages.flatMap((page) => page.items) ?? [];
  const me =
    view.sharing.people.find((person) => person.you)?.membershipId ??
    members.find((member) => member.you)?.id;
  // The owner always has the view, so they aren't offered; anyone else on the team is.
  const offered = members.filter((member) => choosable(view, member));
  const wanted = text.trim().toLocaleLowerCase();
  const shown = offered.filter((member) =>
    (member.name ?? '').toLocaleLowerCase().includes(wanted),
  );
  const departed = departedCount(view);
  const changed = sharingChanged(draft, view);
  const allowed = sharingAllowed(draft, view, me);
  const save = useMutation({
    mutationFn: () =>
      draft.mode === 'private' && !view.canChangeSharing
        ? apiIn(business.id).request(unshareView, {
            params: { id: view.id },
            body: { revision: base },
          })
        : apiIn(business.id).request(setViewSharing, {
            params: { id: view.id },
            body: sharingInputOf(draft, base),
          }),
    onMutate: () => {
      onBusy(true);
    },
    onSettled: async (_data, error) => {
      onBusy(false);
      if (error === null || (error instanceof ApiError && [403, 404, 409].includes(error.status)))
        await cache.invalidateQueries({ queryKey });
    },
    onSuccess: (saved) => {
      onDone(
        saved.visibility === 'private'
          ? t`View is private.`
          : saved.visibility === 'shared'
            ? t`View shared with everyone.`
            : t`View shared with the people chosen.`,
      );
    },
  });
  const levels: readonly { value: ViewAccessLevel; label: string }[] = [
    { value: 'view', label: t`Can view` },
    { value: 'edit', label: t`Can edit` },
  ];
  const level = (
    value: ViewAccessLevel,
    onChange: (next: ViewAccessLevel) => void,
    label: string,
    disabled: boolean,
  ) => (
    <select
      aria-label={label}
      className={selectClassName}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        onChange(event.target.value === 'edit' ? 'edit' : 'view');
      }}
    >
      {levels.map((each) => (
        <option key={each.value} value={each.value}>
          {each.label}
        </option>
      ))}
    </select>
  );
  const choosePerson = (id: string, chosen: boolean) => {
    setDraft((current) => {
      const people = new Map(current.people);
      if (chosen) people.set(id, people.get(id) ?? 'view');
      else people.delete(id);
      return { ...current, people };
    });
  };
  const problem =
    save.error instanceof ApiError
      ? save.error.status === 409
        ? undefined
        : save.error.status === 403
          ? t`You can no longer change who this view is shared with.`
          : (save.error.problem.errors?.find((issue) => issue.message.trim() !== '')?.message ??
            t`We couldn't change the sharing. Try again.`)
      : save.isError
        ? t`We couldn't change the sharing. Try again.`
        : undefined;

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && allowed && !save.isPending) save.mutate();
      }}
    >
      <div className={sidePanelBodyClassName}>
        <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-sm font-medium">
            <Trans>Who can open this list</Trans>
          </legend>
          {modes.includes('private') ? (
            <div className={optionClassName}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium lg:min-h-9">
                <input
                  type="radio"
                  name={groupId}
                  className="size-4 shrink-0"
                  checked={draft.mode === 'private'}
                  onChange={() => {
                    setDraft((current) => ({ ...current, mode: 'private' }));
                  }}
                />
                <Trans>Only me</Trans>
              </label>
            </div>
          ) : null}
          {modes.includes('everyone') ? (
            <div className={optionClassName}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium lg:min-h-9">
                <input
                  type="radio"
                  name={groupId}
                  className="size-4 shrink-0"
                  checked={draft.mode === 'everyone'}
                  onChange={() => {
                    setDraft((current) => ({ ...current, mode: 'everyone' }));
                  }}
                />
                <Trans>All users</Trans>
              </label>
              {draft.mode === 'everyone' ? (
                <div className="pl-7">
                  {level(
                    draft.everyone,
                    (next) => {
                      setDraft((current) => ({ ...current, everyone: next }));
                    },
                    t`What all users can do`,
                    false,
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {modes.includes('selected') ? (
            <div className={optionClassName}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium lg:min-h-9">
                <input
                  type="radio"
                  name={groupId}
                  className="size-4 shrink-0"
                  checked={draft.mode === 'selected'}
                  onChange={() => {
                    setDraft((current) => ({ ...current, mode: 'selected' }));
                  }}
                />
                <Trans>Selected users</Trans>
              </label>
              {draft.mode !== 'selected' ? null : (
                <section aria-label={t`Team members`} className="flex min-w-0 flex-col gap-2 pl-7">
                  <Input
                    type="search"
                    autoComplete="off"
                    aria-label={t`Search team members`}
                    placeholder={t`Search team members`}
                    value={text}
                    onChange={(event) => {
                      setText(event.target.value);
                    }}
                  />
                  {team.isPending ? (
                    <p role="status" className="text-sm">
                      <Trans>Loading team members…</Trans>
                    </p>
                  ) : team.isError ? (
                    <p role="alert" className="text-sm">
                      <Trans>We couldn't load the team.</Trans>{' '}
                      <Button
                        variant="quiet"
                        onClick={() => {
                          void team.refetch();
                        }}
                      >
                        <Trans>Try again</Trans>
                      </Button>
                    </p>
                  ) : (
                    <ul className="flex min-w-0 flex-col">
                      {shown.map((member) => {
                        const name = member.name ?? t`Unnamed team member`;
                        const access = draft.people.get(member.id);
                        return (
                          <li
                            key={member.id}
                            className="flex min-h-11 min-w-0 flex-wrap items-center justify-between gap-2 lg:min-h-9"
                          >
                            <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm lg:min-h-9">
                              <input
                                type="checkbox"
                                className="size-4 shrink-0 accent-primary"
                                checked={access !== undefined}
                                onChange={(event) => {
                                  choosePerson(member.id, event.target.checked);
                                }}
                              />
                              <span className="min-w-0 wrap-break-word">
                                {member.you ? <Trans>{name} (you)</Trans> : name}
                              </span>
                            </label>
                            {level(
                              access ?? 'view',
                              (next) => {
                                setDraft((current) => ({
                                  ...current,
                                  people: new Map(current.people).set(member.id, next),
                                }));
                              },
                              t`What ${name} can do`,
                              access === undefined,
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {wanted !== '' && shown.length === 0 && !team.isPending ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>No team member matches this search.</Trans>
                    </p>
                  ) : null}
                  {team.hasNextPage ? (
                    <Button
                      variant="quiet"
                      size="small"
                      disabled={team.isFetchingNextPage}
                      onClick={() => {
                        void team.fetchNextPage();
                      }}
                    >
                      <Trans>Show more team members</Trans>
                    </Button>
                  ) : null}
                </section>
              )}
            </div>
          ) : null}
        </fieldset>
        {departed > 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>
              Shared with {departed} people no longer on the team. Saving leaves them out.
            </Trans>
          </p>
        ) : null}
        {!owner && view.canChangeSharing ? (
          <p className="text-sm text-muted-foreground">
            <Trans>
              You can edit this list. Only its owner can make it private or take your access away.
            </Trans>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              navigator.clipboard.writeText(link).then(
                () => {
                  setCopied('yes');
                },
                () => {
                  setCopied('no');
                },
              );
            }}
          >
            <Link2 aria-hidden className="size-4" strokeWidth={1.8} />
            <Trans>Copy link</Trans>
          </Button>
          <span role="status" className="text-sm text-muted-foreground">
            {copied === 'yes' ? (
              <Trans>Link copied.</Trans>
            ) : copied === 'no' ? (
              <Trans>We couldn't copy the link. Copy it from the address bar.</Trans>
            ) : null}
          </span>
        </div>
        {stale || (save.error instanceof ApiError && save.error.status === 409) ? (
          <p role="alert">
            <Trans>This view changed. Review the latest version before sharing it.</Trans>{' '}
            {stale ? (
              <Button
                variant="quiet"
                disabled={save.isPending}
                onClick={() => {
                  setDraft(sharingDraftOf(view));
                  setBase(view.revision);
                  save.reset();
                }}
              >
                <Trans>Review latest view</Trans>
              </Button>
            ) : null}
          </p>
        ) : null}
        {problem === undefined ? null : <p role="alert">{problem}</p>}
      </div>
      <div className={sidePanelFooterClassName}>
        <Button variant="secondary" disabled={save.isPending} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={save.isPending || stale || !changed || !allowed}>
          <Trans>Save sharing</Trans>
        </Button>
      </div>
    </form>
  );
}
