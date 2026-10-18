import { Trans, useLingui } from '@lingui/react/macro';
import {
  assignRecordTag,
  createTag,
  getRecordTags,
  getTagConfiguration,
  removeRecordTag,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@repo/ui/components/popover';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CirclePlus, Minus, Plus } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';
import { EventExplanation, useActorLabel } from './activity';
import { apiIn } from './api';
import { tintOf } from './avatar-tint';
import { ContactPanel } from './contact-panels';
import { useBusiness } from './workspace';

// A tag keeps the same colour wherever it shows: the avatar tints, which carry dark text.
const tints = {
  1: 'bg-avatar-1',
  2: 'bg-avatar-2',
  3: 'bg-avatar-3',
  4: 'bg-avatar-4',
} as const;

/** Same tag, however it is typed: the server treats case, spaces, hyphens and underscores alike. */
const sameName = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * A record's tags, side by side. Pressing a tag says who added it, when and why; the minus
 * on it takes it off; the plus beside the title adds one, new or existing.
 */
export function RecordTags({
  recordId,
  readOnly = false,
}: {
  readonly recordId: string;
  readonly readOnly?: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const removeLabel = (name: string) => t`Remove ${name}`;
  const whyLabel = (name: string) => t`Why ${name} was added`;
  const business = useBusiness();
  const cache = useQueryClient();
  const actorLabel = useActorLabel();
  const inputRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState('');
  const [notice, setNotice] = useState('');
  const tagsKey = ['b', business.id, 'record-tags', recordId];
  const tags = useQuery({
    queryKey: tagsKey,
    queryFn: () => apiIn(business.id).request(getRecordTags, { params: { id: recordId } }),
  });
  const canManage = tags.data?.canManage === true && !readOnly;
  const configuration = useQuery({
    queryKey: ['b', business.id, 'tags'],
    queryFn: () => apiIn(business.id).request(getTagConfiguration, {}),
    enabled: canManage,
  });
  const assigned = tags.data?.items ?? [];
  const name = typed.trim();
  const available =
    configuration.data?.items.filter((item) => !assigned.some((each) => each.tag.id === item.id)) ??
    [];
  const matching =
    name === ''
      ? available
      : available.filter((item) => sameName(item.name).includes(sameName(name)));
  const exact = available.find((item) => sameName(item.name) === sameName(name));
  const alreadyOn =
    name !== '' && assigned.some((each) => sameName(each.tag.name) === sameName(name));
  const canCreate =
    configuration.data?.canCreate === true && name !== '' && exact === undefined && !alreadyOn;
  const save = useMutation({
    mutationFn: async (action: { kind: 'add' | 'remove'; tagId: string } | { kind: 'create' }) => {
      const api = apiIn(business.id);
      if (action.kind === 'remove')
        return api.request(removeRecordTag, { params: { id: recordId, tagId: action.tagId } });
      const tagId =
        action.kind === 'add'
          ? action.tagId
          : (await api.request(createTag, { body: { name } })).id;
      return api.request(assignRecordTag, { params: { id: recordId, tagId }, body: {} });
    },
    onMutate: () => {
      setNotice('');
    },
    onSuccess: async (_, action) => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: tagsKey }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', recordId] }),
        ...(action.kind === 'create'
          ? [cache.invalidateQueries({ queryKey: ['b', business.id, 'tags'] })]
          : []),
      ]);
      setTyped('');
      setNotice(action.kind === 'remove' ? t`Tag removed.` : t`Tag added.`);
      if (action.kind !== 'remove') inputRef.current?.focus();
    },
  });
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <ContactPanel
      title={t`Tags`}
      beside={
        canManage ? (
          <Popover
            open={adding}
            onOpenChange={(open) => {
              setAdding(open);
              if (!open) setTyped('');
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Add tag`}
                  title={t`Add tag`}
                  className="size-7 min-h-0 rounded-full p-0 text-link"
                />
              }
            >
              <CirclePlus aria-hidden className="size-[18px]" strokeWidth={1.8} />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72">
              <PopoverTitle>
                <Trans>Add a tag</Trans>
              </PopoverTitle>
              <form
                className="flex min-w-0 flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (save.isPending) return;
                  const only = exact ?? (matching.length === 1 ? matching[0] : undefined);
                  if (only !== undefined) save.mutate({ kind: 'add', tagId: only.id });
                  else if (canCreate) save.mutate({ kind: 'create' });
                }}
              >
                <Input
                  ref={inputRef}
                  aria-label={t`Tag name`}
                  placeholder={t`Search or create a tag`}
                  maxLength={60}
                  value={typed}
                  onChange={(event) => {
                    setTyped(event.target.value);
                  }}
                />
                {configuration.isPending ? (
                  <p aria-live="polite" className="text-sm text-muted-foreground">
                    <Trans>Loading tags…</Trans>
                  </p>
                ) : null}
                {configuration.isError ? (
                  <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                    <p>
                      <Trans>The available tags couldn't be loaded.</Trans>
                    </p>
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
                {matching.length === 0 ? null : (
                  <ul
                    aria-label={t`Tags to add`}
                    className="flex max-h-56 flex-col overflow-y-auto"
                  >
                    {matching.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          disabled={save.isPending}
                          className="flex min-h-9 w-full items-center gap-2 rounded-control px-2 py-1 text-left text-md outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                          onClick={() => {
                            save.mutate({ kind: 'add', tagId: item.id });
                          }}
                        >
                          <span
                            aria-hidden
                            className={`size-2.5 shrink-0 rounded-full ${tints[tintOf(item.id)]}`}
                          />
                          <span className="min-w-0 wrap-anywhere">{item.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {alreadyOn ? (
                  <p className="text-sm text-muted-foreground">
                    <Trans>This tag is already on the record.</Trans>
                  </p>
                ) : null}
                {canCreate ? (
                  <Button
                    type="submit"
                    variant="secondary"
                    size="small"
                    disabled={save.isPending}
                    aria-label={t`Create tag ${name}`}
                    className="justify-start"
                  >
                    <Plus aria-hidden className="size-4 shrink-0" strokeWidth={2} />
                    <span className="min-w-0 wrap-anywhere">{name}</span>
                  </Button>
                ) : null}
                {configuration.data !== undefined &&
                matching.length === 0 &&
                !canCreate &&
                !alreadyOn ? (
                  <p className="text-sm text-muted-foreground">
                    {name === '' ? (
                      <Trans>
                        Every tag is already on this record. Type a name to make a new one.
                      </Trans>
                    ) : (
                      <Trans>No tags match.</Trans>
                    )}
                  </p>
                ) : null}
              </form>
            </PopoverContent>
          </Popover>
        ) : null
      }
    >
      {tags.isPending ? (
        <p aria-live="polite">
          <Trans>Loading tags…</Trans>
        </p>
      ) : null}
      {tags.isError ? (
        <div role="alert">
          <p>
            <Trans>This record's tags couldn't be loaded.</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void tags.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {tags.data?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No tags on this record yet.</Trans>
        </p>
      ) : null}
      {assigned.length === 0 ? null : (
        <ul className="flex min-w-0 flex-wrap gap-x-2 gap-y-2.5">
          {assigned.map((item) => (
            <li key={item.tag.id} className="group relative flex max-w-full min-w-0">
              <Popover>
                <PopoverTrigger
                  className={`max-w-full cursor-pointer rounded-full px-2.5 py-1 text-left text-sm font-medium text-foreground outline-none wrap-anywhere hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring ${tints[tintOf(item.tag.id)]}`}
                >
                  {item.tag.name}
                </PopoverTrigger>
                <PopoverContent className="w-72">
                  <PopoverTitle className="wrap-anywhere">{item.tag.name}</PopoverTitle>
                  {item.tag.description === '' ? null : (
                    <p className="text-sm wrap-anywhere text-secondary-foreground">
                      {item.tag.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge
                      variant={item.source.kind === 'ai_agent' ? 'assistant' : 'neutral'}
                      className="px-2.5 py-0.5"
                    >
                      {actorLabel({ ...item.source, name: null })}
                    </Badge>
                    <time className="text-muted-foreground" dateTime={item.createdAt}>
                      {dates.format(new Date(item.createdAt))}
                    </time>
                  </div>
                  {item.source.eventId === null ? null : (
                    <EventExplanation
                      eventId={item.source.eventId}
                      label={whyLabel(item.tag.name)}
                    />
                  )}
                </PopoverContent>
              </Popover>
              {canManage ? (
                <button
                  type="button"
                  disabled={save.isPending}
                  aria-label={removeLabel(item.tag.name)}
                  title={removeLabel(item.tag.name)}
                  className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-border bg-card text-foreground opacity-0 shadow-sm outline-none transition-opacity group-hover:opacity-100 hover:border-destructive hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed pointer-coarse:opacity-100"
                  onClick={() => {
                    save.mutate({ kind: 'remove', tagId: item.tag.id });
                  }}
                >
                  <Minus aria-hidden className="size-3.5" strokeWidth={2.5} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {save.error instanceof ApiError
            ? save.error.message
            : t`The tags weren't saved. Check your connection and try again.`}
        </p>
      ) : null}
      <p aria-live="polite" className="text-sm empty:sr-only">
        {notice}
      </p>
    </ContactPanel>
  );
}
