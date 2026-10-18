import { Trans, useLingui } from '@lingui/react/macro';
import { getTagConfiguration, type TagDefinition, type TagGroup } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { FolderOpen, Pencil, Plus, Search, Sparkles, Tag } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { GroupEditor, TagEditor, TagRulesEditor } from './tag-editors';
import { useBusiness } from './workspace';

const tagsQuery = (businessId: string) =>
  queryOptions({
    queryKey: ['b', businessId, 'tags'],
    queryFn: () => apiIn(businessId).request(getTagConfiguration, {}),
  });

type Editing =
  | { kind: 'tag'; value: TagDefinition | undefined }
  | { kind: 'group'; value: TagGroup | undefined };

export function TagsPanel(): ReactElement {
  const { t } = useLingui();
  const editTagLabel = (name: string) => t`Edit tag ${name}`;
  const editGroupLabel = (name: string) => t`Edit group ${name}`;
  const tagCount = (count: number) => (count === 1 ? t`1 tag` : t`${count} tags`);
  const configuration = useQuery(tagsQuery(useBusiness().id));
  const [editing, setEditing] = useState<Editing>();
  const currentEditorRef = useRef<Editing>(undefined);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [undescribedOnly, setUndescribedOnly] = useState(false);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const open = (next: Editing, trigger: HTMLButtonElement) => {
    returnFocusRef.current = trigger;
    currentEditorRef.current = next;
    setEditing(next);
    setNotice('');
  };
  const close = (message = '') => {
    currentEditorRef.current = undefined;
    setEditing(undefined);
    setNotice(message);
    returnFocusRef.current?.focus();
  };
  const data = configuration.data;
  const total = data?.items.length ?? 0;
  const undescribed = data?.items.filter((tag) => tag.description === '').length ?? 0;
  const described = total - undescribed;
  const groupName = (id: string | null) =>
    id === null ? undefined : data?.groups.find((group) => group.id === id)?.name;
  const needle = search.trim().toLowerCase();
  const shown =
    data?.items.filter(
      (tag) =>
        (!undescribedOnly || tag.description === '') &&
        (needle === '' ||
          tag.name.toLowerCase().includes(needle) ||
          tag.description.toLowerCase().includes(needle) ||
          (groupName(tag.groupId)?.toLowerCase().includes(needle) ?? false)),
    ) ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-[640px] text-md leading-normal text-muted-foreground">
          <Trans>Labels for grouping and filtering contacts, deals and more.</Trans>
        </p>
        {data === undefined ? null : (
          <div className="flex flex-wrap gap-2">
            {data.canManage ? (
              <Button
                variant="secondary"
                onClick={(event) => {
                  open({ kind: 'group', value: undefined }, event.currentTarget);
                }}
              >
                <FolderOpen aria-hidden className="size-[18px]" strokeWidth={2} />
                <Trans>New group</Trans>
              </Button>
            ) : null}
            {data.canCreate ? (
              <Button
                aria-expanded={editing?.kind === 'tag' && editing.value === undefined}
                onClick={(event) => {
                  if (editing?.kind === 'tag' && editing.value === undefined) close();
                  else open({ kind: 'tag', value: undefined }, event.currentTarget);
                }}
              >
                <Plus aria-hidden className="size-[18px]" strokeWidth={2} />
                <Trans>New tag</Trans>
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {data === undefined || total === 0 ? null : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label={t`Tags`} value={String(total)} />
          <Stat label={t`Groups`} value={String(data.groups.length)} />
          <div className="flex flex-col gap-1 rounded-card border bg-card px-4 py-3">
            <span className="text-sm text-muted-foreground">
              <Trans>Described</Trans>
            </span>
            <span className="text-xl font-semibold">
              {described}
              <span className="text-md font-normal text-muted-foreground"> / {total}</span>
            </span>
            <span aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${String(Math.round((described / total) * 100))}%` }}
              />
            </span>
          </div>
        </div>
      )}
      {data === undefined || undescribed === 0 || !data.canManage ? null : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border bg-assistant px-4 py-3 text-md text-assistant-foreground">
          <Sparkles aria-hidden className="size-[18px] shrink-0" />
          <span className="min-w-0 flex-1">
            {undescribed === 1 ? (
              <Trans>1 tag has no description, so the assistant can’t tell what it means.</Trans>
            ) : (
              <Trans>
                {undescribed} tags have no description, so the assistant can’t tell what they mean.
              </Trans>
            )}
          </span>
          <Button
            variant="secondary"
            size="small"
            aria-pressed={undescribedOnly}
            onClick={() => {
              setUndescribedOnly(!undescribedOnly);
            }}
          >
            {undescribedOnly ? <Trans>Show all</Trans> : <Trans>Show them</Trans>}
          </Button>
        </div>
      )}
      {data === undefined ? null : (
        <>
          {editing?.kind === 'tag' ? (
            <TagEditor
              key={
                editing.value === undefined
                  ? 'new-tag'
                  : `${editing.value.id}:${editing.value.revision}`
              }
              tag={editing.value}
              configuration={data}
              onClose={(message) => {
                if (currentEditorRef.current === editing) close(message);
              }}
              onReload={(saved) => {
                if (currentEditorRef.current === editing) {
                  const next: Editing = { kind: 'tag', value: saved };
                  currentEditorRef.current = next;
                  setEditing(next);
                }
              }}
            />
          ) : null}
          {editing?.kind === 'group' ? (
            <GroupEditor
              key={
                editing.value === undefined
                  ? 'new-group'
                  : `${editing.value.id}:${editing.value.revision}`
              }
              group={editing.value}
              onClose={(message) => {
                if (currentEditorRef.current === editing) close(message);
              }}
              onReload={(saved) => {
                if (currentEditorRef.current === editing) {
                  const next: Editing = { kind: 'group', value: saved };
                  currentEditorRef.current = next;
                  setEditing(next);
                }
              }}
            />
          ) : null}
        </>
      )}
      <section aria-labelledby="tags-heading" className="min-w-0 rounded-card border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
          <h2 id="tags-heading" className="text-lg font-semibold">
            <Trans>Tags</Trans>
          </h2>
          {data === undefined || total === 0 ? null : (
            <div className="relative w-full sm:w-72">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                aria-label={t`Search tags`}
                placeholder={t`Search tags`}
                value={search}
                className="pl-9"
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </div>
          )}
        </div>
        <div className="px-5 py-2">
          {configuration.isPending ? (
            <p className="py-3 text-muted-foreground">
              <Trans>Loading the tags…</Trans>
            </p>
          ) : null}
          {configuration.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 py-3">
              <span className="text-destructive">
                <Trans>The tags couldn’t be loaded.</Trans>
              </span>
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void configuration.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : null}
          {data !== undefined && total === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-secondary">
                <Tag aria-hidden className="size-5 text-muted-foreground" />
              </span>
              <p className="font-medium">
                <Trans>No tags yet</Trans>
              </p>
              <p className="max-w-sm text-muted-foreground">
                <Trans>Tags you create are listed here, for everyone on the team.</Trans>
              </p>
            </div>
          ) : null}
          {data === undefined || total === 0 ? null : shown.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              <Trans>No tags match.</Trans>
            </p>
          ) : (
            <table className="w-full table-fixed border-collapse text-md">
              <thead>
                <tr className="text-left text-[13px] text-muted-foreground">
                  <th scope="col" className="w-[34%] py-2 pr-3 font-medium">
                    <Trans>Tag</Trans>
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    <Trans>What it means</Trans>
                  </th>
                  <th scope="col" className="hidden w-[18%] py-2 pr-3 font-medium md:table-cell">
                    <Trans>Group</Trans>
                  </th>
                  {data.canManage ? (
                    <th scope="col" className="w-12 py-2">
                      <span className="sr-only">
                        <Trans>Actions</Trans>
                      </span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((tag) => (
                  <tr
                    key={tag.id}
                    className="border-t border-secondary align-middle hover:bg-secondary/40"
                  >
                    <th scope="row" className="py-3 pr-3 text-left font-normal">
                      <Badge className="max-w-full gap-1.5 px-2.5 py-[3px] text-[13px] whitespace-normal break-words">
                        <Tag aria-hidden className="text-muted-foreground" />
                        {tag.name}
                      </Badge>
                    </th>
                    <td className="py-3 pr-3 leading-normal break-words text-secondary-foreground">
                      {tag.description === '' ? (
                        <span className="text-muted-foreground italic">
                          <Trans>Not described yet</Trans>
                        </span>
                      ) : (
                        tag.description
                      )}
                    </td>
                    <td className="hidden py-3 pr-3 break-words text-muted-foreground md:table-cell">
                      {groupName(tag.groupId) ?? '—'}
                    </td>
                    {data.canManage ? (
                      <td className="py-3 text-right">
                        <Button
                          variant="quiet"
                          size="small"
                          aria-label={editTagLabel(tag.name)}
                          title={editTagLabel(tag.name)}
                          onClick={(event) => {
                            open({ kind: 'tag', value: tag }, event.currentTarget);
                          }}
                        >
                          <Pencil aria-hidden className="size-4" strokeWidth={2} />
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      {data === undefined ? null : (
        <>
          <section aria-labelledby="tag-groups-heading" className="rounded-card border bg-card p-5">
            <h2 id="tag-groups-heading" className="mb-3 text-lg font-semibold">
              <Trans>Tag groups</Trans>
            </h2>
            {data.groups.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>No groups yet. Groups keep related tags together.</Trans>
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.groups.map((group) => (
                  <li
                    key={group.id}
                    className="flex items-start justify-between gap-3 rounded-control border p-4"
                  >
                    <div className="min-w-0 flex-1">
                      <h3 className="flex items-center gap-2 font-medium break-words">
                        <FolderOpen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        {group.name}
                      </h3>
                      <p className="mt-1 text-sm break-words text-secondary-foreground">
                        {group.description}
                      </p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {tagCount(data.items.filter((tag) => tag.groupId === group.id).length)}
                      </p>
                    </div>
                    {data.canManage ? (
                      <Button
                        variant="quiet"
                        size="small"
                        aria-label={editGroupLabel(group.name)}
                        title={editGroupLabel(group.name)}
                        onClick={(event) => {
                          open({ kind: 'group', value: group }, event.currentTarget);
                        }}
                      >
                        <Pencil aria-hidden className="size-4" strokeWidth={2} />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <TagRulesEditor
            rules={data.rules}
            canManage={data.canManage}
            onSaved={() => {
              setNotice(t`Tag rules saved.`);
            }}
          />
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-card border bg-card px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold">{value}</span>
    </div>
  );
}
