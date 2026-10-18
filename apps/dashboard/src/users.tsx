// Settings → Users, laid out as GoHighLevel's `settings/users` in the owner's screenshot: a
// role filter, a search by name, email, phone or id, Add user, and a table of Name, Email
// with the id and its copy button, Phone number, User type and Actions. The list is the
// server's, a page at a time, searched and filtered there. Adding someone is an invitation
// (decision 2), so an invited person is a row too, marked Invited. The same page serves the
// agency's own team; a business also lists the agency's team, who are changed at the agency
// (the server says so with canEdit and canRemove).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  listUsers,
  removeTeamMember,
  resendInvitation,
  revokeInvitation,
  type User,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Avatar } from '@repo/ui/components/avatar';
import { Badge } from '@repo/ui/components/badge';
import { buttonVariants } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Pencil, Plus, Search, Send, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { tintOf } from './avatar-tint';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  iconButtonClassName,
  listCardClassName,
  ListFooter,
  ListProblem,
  retryFaults,
  tableClassName,
  tableRegionClassName,
  useSettled,
} from './settings-list';
import {
  emptyTrail,
  rangeOf,
  trailBack,
  trailCursor,
  trailForward,
  type PageSize,
} from './settings-rules';
import { Page } from './shell/page';
import { EditUserLink, NewUserLink, type UsersPlace } from './users-links';
import {
  ACCOUNT_TYPE,
  AGENCY_TYPE,
  ANY_ROLE,
  filterQuery,
  phoneWords,
  roleWord,
  usersKey,
  usersNoticeKey,
} from './users-rules';
import { initialsOf } from './workspace';

/** An action a row shows but does not offer: greyed, still reachable, and it says why. */
function Unavailable({
  label,
  reason,
  icon: Icon,
}: {
  readonly label: string;
  readonly reason: string;
  readonly icon: LucideIcon;
}): ReactElement {
  const id = useId();
  return (
    <button
      type="button"
      aria-disabled="true"
      aria-label={label}
      aria-describedby={id}
      title={reason}
      className={`${iconButtonClassName} cursor-not-allowed opacity-50 hover:bg-transparent hover:text-body`}
    >
      <Icon aria-hidden className="size-4" strokeWidth={1.8} />
      <span id={id} className="sr-only">
        {reason}
      </span>
    </button>
  );
}

/** A person's id under their address, with the button that copies it. */
function UserId({
  user,
  onCopied,
}: {
  readonly user: User;
  readonly onCopied: (id: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const { id, name } = user;
  return (
    <span className="flex max-w-full min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        <Trans>id: {id}</Trans>
      </span>
      <button
        type="button"
        className={iconButtonClassName}
        aria-label={t`Copy the id of ${name}`}
        title={t`Copy id`}
        onClick={() => {
          void navigator.clipboard.writeText(id).then(
            () => {
              setCopied(true);
              onCopied(id);
            },
            () => undefined,
          );
        }}
      >
        {copied ? (
          <Check aria-hidden className="size-4 text-success" strokeWidth={2} />
        ) : (
          <Copy aria-hidden className="size-4" strokeWidth={1.8} />
        )}
      </button>
    </span>
  );
}

export function UsersPage({
  client,
  workspace,
  place,
}: {
  readonly client: Client;
  /** What the cache is keyed by: the business's id, or "agency". */
  readonly workspace: string;
  readonly place: UsersPlace;
}): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useSettled(search).trim();
  const [filter, setFilter] = useState(ANY_ROLE);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [trail, setTrail] = useState(emptyTrail);
  const [removing, setRemoving] = useState<User>();
  const [removeProblem, setRemoveProblem] = useState<string>();
  // What the Add or Edit page left to say: read once, then forgotten.
  const [notice, setNotice] = useState(
    () => cache.getQueryData<string>(usersNoticeKey(workspace)) ?? '',
  );
  useEffect(() => {
    cache.removeQueries({ queryKey: usersNoticeKey(workspace) });
  }, [cache, workspace]);
  const [problem, setProblem] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const searchId = useId();
  const filterLabelId = useId();

  const after = trailCursor(trail);
  const list = useQuery({
    queryKey: [...usersKey(workspace), 'list', { q, filter, pageSize, after }],
    queryFn: () =>
      client.request(listUsers, {
        query: {
          limit: pageSize,
          ...(q === '' ? {} : { q }),
          ...filterQuery(filter),
          ...(after === undefined ? {} : { after }),
        },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const refresh = () => cache.invalidateQueries({ queryKey: usersKey(workspace) });

  const remove = useMutation({
    mutationFn: async (user: User) => {
      if (user.invitationId !== null)
        await client.request(revokeInvitation, { params: { id: user.invitationId } });
      else if (user.membershipId !== null)
        await client.request(removeTeamMember, { params: { id: user.membershipId } });
      return user;
    },
    onSuccess: async (user) => {
      // The last row of a page is gone: show the page before it.
      if (list.data?.items.length === 1) setTrail(trailBack);
      setRemoving(undefined);
      const { name } = user;
      setNotice(user.invitationId === null ? t`${name} was removed.` : t`Invitation revoked.`);
      await refresh();
    },
    onError: (error) => {
      setRemoveProblem(
        error instanceof ApiError
          ? (error.problem.detail ?? t`It wasn't removed. Try again.`)
          : t`It wasn't removed. Check your connection and try again.`,
      );
    },
  });
  const resend = useMutation({
    mutationFn: (user: User) =>
      client.request(resendInvitation, { params: { id: user.invitationId ?? '' } }),
    onSuccess: async (invitation) => {
      setProblem(undefined);
      setNotice(
        invitation.deliveryFailed === true
          ? t`The invitation was renewed, but the email could not be sent. Try again.`
          : t`Invitation resent. The previous link no longer works.`,
      );
      await refresh();
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? (error.problem.detail ?? t`The invitation wasn't resent. Try again.`)
          : t`The invitation wasn't resent. Check your connection and try again.`,
      );
    },
  });

  const data = list.data;
  const canManage = data?.canManage === true;
  const items = data?.items ?? [];
  const roles = data?.roles ?? [];
  const range = rangeOf({
    index: trail.index,
    pageSize,
    shown: items.length,
    total: data?.total ?? 0,
  });
  const filtered = q !== '' || filter !== ANY_ROLE;
  const agencyManaged = t`Managed in the agency's Users`;
  const needsPermission = t`You need permission to manage users.`;
  const editReason = (user: User): string => {
    if (!canManage) return needsPermission;
    if (user.status !== 'active')
      return t`An invitation isn't edited. Remove it and add the person again.`;
    if (user.userType === 'agency' && place.kind === 'business') return agencyManaged;
    return t`Only an owner changes an owner.`;
  };
  const removeReason = (user: User): string => {
    if (!canManage) return needsPermission;
    if (user.userType === 'agency' && place.kind === 'business') return agencyManaged;
    if (user.isSelf) return t`You can't remove yourself.`;
    return t`An owner isn't removed here.`;
  };
  const removingName = removing?.name ?? '';
  const revoking = removing !== undefined && removing.invitationId !== null;

  return (
    <Page title={t`Users`}>
      <section aria-label={t`Users`} className={listCardClassName}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span id={filterLabelId} className="text-sm whitespace-nowrap text-muted-foreground">
              <Trans>User role</Trans>
            </span>
            <Select
              aria-labelledby={filterLabelId}
              className="w-auto max-w-full min-w-36"
              value={filter}
              onValueChange={(next) => {
                setFilter(next);
                setTrail(emptyTrail);
              }}
            >
              <option value={ANY_ROLE}>{t`All`}</option>
              {place.kind === 'business' ? (
                <>
                  <option value={AGENCY_TYPE}>{t`Agency users`}</option>
                  <option value={ACCOUNT_TYPE}>{t`Account users`}</option>
                </>
              ) : null}
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
            {filter === ANY_ROLE ? null : (
              <button
                type="button"
                className={iconButtonClassName}
                aria-label={t`Clear the user role filter`}
                title={t`Clear`}
                onClick={() => {
                  setFilter(ANY_ROLE);
                  setTrail(emptyTrail);
                }}
              >
                <X aria-hidden className="size-4" strokeWidth={1.8} />
              </button>
            )}
          </div>
          <form
            role="search"
            className="relative min-w-0 flex-1 basis-48 sm:max-w-72"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <label htmlFor={searchId} className="sr-only">
              <Trans>Search users</Trans>
            </label>
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              strokeWidth={1.8}
            />
            <Input
              id={searchId}
              type="search"
              autoComplete="off"
              maxLength={200}
              placeholder={t`name, email, phone, ids`}
              value={search}
              className="pl-9"
              onChange={(event) => {
                setSearch(event.target.value);
                setTrail(emptyTrail);
              }}
            />
          </form>
          {canManage ? (
            <NewUserLink place={place} className={`${buttonVariants()} ml-auto`}>
              <Plus aria-hidden className="size-4" strokeWidth={2} />
              <Trans>Add user</Trans>
            </NewUserLink>
          ) : null}
        </div>
        {data !== undefined && !canManage ? (
          <p className="text-sm text-muted-foreground">
            <Trans>
              You can see who works here. Adding, changing and removing people needs permission to
              manage users.
            </Trans>
          </p>
        ) : null}
        <p role="status" className="text-sm text-body empty:hidden">
          {notice}
        </p>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        {list.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading users…</Trans>
          </p>
        ) : null}
        {list.isError ? (
          <ListProblem
            onRetry={() => {
              void list.refetch();
            }}
          >
            {list.error instanceof ApiError ? (
              (list.error.problem.detail ?? <Trans>The users couldn't be loaded.</Trans>)
            ) : (
              <Trans>The users couldn't be loaded. Check your connection.</Trans>
            )}
          </ListProblem>
        ) : null}
        {data !== undefined && items.length === 0 ? (
          <p className="py-6 text-center text-md text-muted-foreground">
            {filtered ? <Trans>No users match.</Trans> : <Trans>No users yet.</Trans>}
          </p>
        ) : null}
        {items.length === 0 ? null : (
          <div role="region" aria-label={t`Users table`} className={tableRegionClassName}>
            <table className={`${tableClassName} min-w-[900px] table-fixed`}>
              <caption className="sr-only">
                <Trans>Users</Trans>
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={`${headerCellClassName} w-[24%]`}>
                    <Trans>Name</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-[30%]`}>
                    <Trans>Email</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-[16%]`}>
                    <Trans>Phone number</Trans>
                  </th>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>User type</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-36`}>
                    <Trans>Actions</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((user) => {
                  const { name } = user;
                  const role = roleWord(user.roleName);
                  const phone = phoneWords(user.phone, user.extension);
                  const { number, extension } = phone;
                  const invited = user.status !== 'active';
                  return (
                    <tr key={user.id} className="hover:bg-muted">
                      <th scope="row" className={`${cellClassName} text-left font-medium`}>
                        <span className="flex min-w-0 items-center gap-2.5">
                          <Avatar
                            size="small"
                            tint={tintOf(user.id)}
                            fallback={initialsOf(user.name, user.email)}
                          />
                          <span className="min-w-0 wrap-anywhere text-foreground">
                            {name}
                            {user.isSelf ? (
                              <span className="font-normal text-muted-foreground">
                                {' '}
                                <Trans>(you)</Trans>
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </th>
                      <td className={cellClassName}>
                        <span className="block truncate" title={user.email}>
                          {user.email}
                        </span>
                        <UserId
                          user={user}
                          onCopied={(id) => {
                            setNotice(t`Copied ${id}`);
                          }}
                        />
                      </td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {extension === null ? (
                          number
                        ) : (
                          <Trans>
                            {number} ext. {extension}
                          </Trans>
                        )}
                      </td>
                      <td className={cellClassName}>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge size="count">
                            {user.userType === 'agency' ? (
                              <Trans>Agency - {role}</Trans>
                            ) : (
                              <Trans>Account - {role}</Trans>
                            )}
                          </Badge>
                          {user.status === 'invited' ? (
                            <Badge size="count" variant="attention">
                              <Trans>Invited</Trans>
                            </Badge>
                          ) : null}
                          {user.status === 'invitation_expired' ? (
                            <Badge size="count" variant="attention">
                              <Trans>Invitation expired</Trans>
                            </Badge>
                          ) : null}
                        </span>
                      </td>
                      <td className={cellClassName}>
                        <span className="flex items-center gap-1">
                          {user.canEdit && user.membershipId !== null ? (
                            <EditUserLink
                              place={place}
                              userId={user.membershipId}
                              className={iconButtonClassName}
                              aria-label={t`Edit ${name}`}
                              title={t`Edit`}
                            >
                              <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
                            </EditUserLink>
                          ) : (
                            <Unavailable
                              label={t`Edit ${name}`}
                              reason={editReason(user)}
                              icon={Pencil}
                            />
                          )}
                          {user.canRemove ? (
                            <button
                              type="button"
                              className={iconButtonClassName}
                              aria-label={
                                invited
                                  ? t`Revoke the invitation of ${name}`
                                  : place.kind === 'agency'
                                    ? t`Remove ${name} from the agency`
                                    : t`Remove ${name} from this account`
                              }
                              title={
                                invited
                                  ? t`Revoke invitation`
                                  : place.kind === 'agency'
                                    ? t`Remove from the agency`
                                    : t`Remove from this account`
                              }
                              onClick={(event) => {
                                returnFocusRef.current = event.currentTarget;
                                setRemoveProblem(undefined);
                                setRemoving(user);
                              }}
                            >
                              <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                            </button>
                          ) : (
                            <Unavailable
                              label={
                                invited
                                  ? t`Revoke the invitation of ${name}`
                                  : place.kind === 'agency'
                                    ? t`Remove ${name} from the agency`
                                    : t`Remove ${name} from this account`
                              }
                              reason={removeReason(user)}
                              icon={Trash2}
                            />
                          )}
                          {!invited ? null : user.canRemove ? (
                            <button
                              type="button"
                              className={iconButtonClassName}
                              aria-label={t`Resend the invitation to ${name}`}
                              title={t`Resend invitation`}
                              disabled={resend.isPending}
                              onClick={() => {
                                setNotice('');
                                resend.mutate(user);
                              }}
                            >
                              <Send aria-hidden className="size-4" strokeWidth={1.8} />
                            </button>
                          ) : (
                            <Unavailable
                              label={t`Resend the invitation to ${name}`}
                              reason={needsPermission}
                              icon={Send}
                            />
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data === undefined ? null : (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <nav aria-label={t`Breadcrumb`} className="text-sm text-muted-foreground">
              <ol className="flex items-center gap-1.5">
                <li>
                  <Trans>Settings</Trans>
                </li>
                <li aria-hidden>/</li>
                <li aria-current="page" className="text-body">
                  <Trans>Users</Trans>
                </li>
              </ol>
            </nav>
            <ListFooter
              perPageLabel={t`Rows per page`}
              pageSize={pageSize}
              onPageSize={(size) => {
                setPageSize(size);
                setTrail(emptyTrail);
              }}
              range={range}
              number={trail.index + 1}
              previous={trail.index > 0}
              next={data.next !== null}
              busy={list.isFetching && list.isPlaceholderData}
              onPrevious={() => {
                setTrail(trailBack);
              }}
              onNext={() => {
                setTrail(trailForward(trail, data.next));
              }}
            />
          </div>
        )}
      </section>
      <ConfirmDialog
        open={removing !== undefined}
        returnFocus={returnFocusRef}
        title={
          revoking ? (
            <Trans>Revoke the invitation of {removingName}?</Trans>
          ) : (
            <Trans>Remove {removingName}?</Trans>
          )
        }
        description={
          revoking ? (
            <Trans>The link in their email stops working. You can add them again later.</Trans>
          ) : place.kind === 'agency' ? (
            <Trans>
              They can no longer work in the agency or its businesses. Their sign-in account is
              kept: it is theirs.
            </Trans>
          ) : (
            <Trans>
              They can no longer work in this account. Their sign-in account is kept: it is theirs.
            </Trans>
          )
        }
        confirmLabel={revoking ? t`Revoke` : t`Remove`}
        destructive
        busy={remove.isPending}
        problem={removeProblem}
        onClose={() => {
          if (!remove.isPending) setRemoving(undefined);
        }}
        onConfirm={() => {
          if (removing !== undefined) remove.mutate(removing);
        }}
      />
    </Page>
  );
}
