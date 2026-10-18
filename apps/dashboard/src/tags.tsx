import { Trans, useLingui } from '@lingui/react/macro';
import { getTagConfiguration, type TagDefinition, type TagGroup } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { queryOptions, useQuery } from '@tanstack/react-query';
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
  const configuration = useQuery(tagsQuery(useBusiness().id));
  const [editing, setEditing] = useState<Editing>();
  const currentEditorRef = useRef<Editing>(undefined);
  const [notice, setNotice] = useState('');
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
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p className="max-w-[760px] text-base leading-normal text-secondary-foreground">
        <Trans>
          Tags are quick labels for grouping and filtering. Each one has a description, so the
          assistant knows what it means.
        </Trans>
      </p>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {data === undefined ? null : (
        <>
          <div className="flex flex-wrap gap-2">
            {data.canCreate ? (
              <Button
                aria-expanded={editing?.kind === 'tag' && editing.value === undefined}
                onClick={(event) => {
                  if (editing?.kind === 'tag' && editing.value === undefined) close();
                  else open({ kind: 'tag', value: undefined }, event.currentTarget);
                }}
              >
                <Trans>New tag</Trans>
              </Button>
            ) : null}
            {data.canManage ? (
              <Button
                variant="secondary"
                onClick={(event) => {
                  open({ kind: 'group', value: undefined }, event.currentTarget);
                }}
              >
                <Trans>New group</Trans>
              </Button>
            ) : null}
          </div>
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
      <section aria-labelledby="tags-heading" className="min-w-0 rounded-card border bg-card p-5">
        <h2 id="tags-heading" className="mb-3 text-lg font-semibold">
          <Trans>Tags</Trans>
        </h2>
        {configuration.isPending ? (
          <p className="text-muted-foreground">
            <Trans>Loading the tags…</Trans>
          </p>
        ) : null}
        {configuration.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3">
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
        {data?.items.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>No tags yet. Tags you create are listed here, for everyone on the team.</Trans>
          </p>
        ) : null}
        {data === undefined || data.items.length === 0 ? null : (
          <table className="w-full table-fixed border-collapse text-md">
            <thead>
              <tr className="text-left text-[13px] text-muted-foreground">
                <th scope="col" className="w-2/5 py-2 pr-3 font-medium">
                  <Trans>Tag</Trans>
                </th>
                <th scope="col" className="py-2 pl-3 font-medium">
                  <Trans>What it means</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((tag) => (
                <tr key={tag.id} className="border-t border-secondary align-top">
                  <th scope="row" className="py-3 pr-3 text-left">
                    <Badge className="max-w-full px-2.5 py-[3px] text-[13px] whitespace-normal break-words">
                      {tag.name}
                    </Badge>
                    {tag.groupId === null ? null : (
                      <p className="mt-1 text-sm font-normal break-words text-muted-foreground">
                        {data.groups.find((group) => group.id === tag.groupId)?.name}
                      </p>
                    )}
                  </th>
                  <td className="py-3 pl-3 leading-normal break-words text-secondary-foreground">
                    {tag.description === '' ? (
                      <span className="text-muted-foreground">
                        <Trans>Not described yet</Trans>
                      </span>
                    ) : (
                      tag.description
                    )}
                    {data.canManage ? (
                      <Button
                        variant="quiet"
                        size="small"
                        className="mt-2"
                        aria-label={editTagLabel(tag.name)}
                        onClick={(event) => {
                          open({ kind: 'tag', value: tag }, event.currentTarget);
                        }}
                      >
                        <Trans>Edit</Trans>
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
              <ul className="divide-y divide-secondary">
                {data.groups.map((group) => (
                  <li
                    key={group.id}
                    className="flex flex-wrap items-start justify-between gap-3 py-3"
                  >
                    <div className="min-w-0 flex-1 basis-40">
                      <h3 className="font-medium break-words">{group.name}</h3>
                      <p className="break-words text-secondary-foreground">{group.description}</p>
                    </div>
                    {data.canManage ? (
                      <Button
                        variant="secondary"
                        size="small"
                        aria-label={editGroupLabel(group.name)}
                        onClick={(event) => {
                          open({ kind: 'group', value: group }, event.currentTarget);
                        }}
                      >
                        <Trans>Edit</Trans>
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
