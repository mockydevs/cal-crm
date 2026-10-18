// Tags as a setting holds them (a form's "tags added to the contact", and any other
// setting that names tags): each chosen tag is a chip in the tag's own colour with a button
// that takes it off, and a round plus opens a small panel that searches the business's
// tags, grouped as the business grouped them, and makes a new one for someone who may.
// It works the same with three tags or three hundred: the list shows a first screenful and
// narrows as the person types. The panel is a combobox over a listbox: the arrow keys move,
// Enter adds, Escape closes, and what the list holds is said aloud.
//
// Its words are in the catalog of whichever part of the dashboard shows it
// (lingui.config.ts): a new place that uses it adds this file to its own catalog's list.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { createTag, getTagConfiguration } from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@repo/ui/components/popover';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CirclePlus, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { tintOf } from './avatar-tint';
import {
  chosenTags,
  hasRoom,
  isListKey,
  stepped,
  tagChoices,
  TAG_NAME_LENGTH,
} from './tag-picker-rules';

// A tag keeps the same colour wherever it shows: the avatar tints, which carry dark text.
const tints = {
  1: 'bg-avatar-1',
  2: 'bg-avatar-2',
  3: 'bg-avatar-3',
  4: 'bg-avatar-4',
} as const;

const optionClassName =
  'flex min-h-9 cursor-pointer items-center gap-2 rounded-control px-2 py-1 text-md hover:bg-muted aria-selected:bg-muted';

export interface TagPickerProps {
  /** What the tags are for, shown above the chips: it names them for a screen reader too. */
  readonly label: string;
  /** The ids of the chosen tags, in the order they were chosen. */
  readonly chosen: readonly string[];
  /** The most tags the setting takes. */
  readonly limit: number;
  /** Shown, and nothing can be added or taken off. */
  readonly disabled?: boolean;
  /** The business's API: its tags are read with it, and a new one is made with it. */
  readonly client: Client;
  /** Where the business's tags are kept between screens, so they are read once. */
  readonly cacheKey: readonly unknown[];
  readonly onChange: (next: string[]) => void;
}

export function TagPicker({
  label,
  chosen,
  limit,
  disabled = false,
  client,
  cacheKey,
  onChange,
}: TagPickerProps): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const labelId = useId();
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [active, setActive] = useState(-1);
  const [notice, setNotice] = useState('');
  // The names of tags made here, until the business's list has been read again.
  const [made, setMade] = useState<Readonly<Record<string, string>>>({});
  const tags = useQuery({
    queryKey: cacheKey,
    queryFn: () => client.request(getTagConfiguration, {}),
    staleTime: 60_000,
  });
  const chips = chosenTags(tags.data?.items ?? [], chosen, made);
  const choices = tagChoices(tags.data, chosen, typed);
  const room = hasRoom(chosen, limit);
  const rows = choices.options.length + (choices.create === null ? 0 : 1);
  const at = Math.min(active, rows - 1);
  const optionId = (index: number): string => `${listId}-${String(index)}`;

  const add = (id: string, name: string): void => {
    onChange([...chosen, id]);
    setTyped('');
    setActive(-1);
    setNotice(t`Added ${name}.`);
    inputRef.current?.focus();
  };
  const create = useMutation({
    mutationFn: (name: string) => client.request(createTag, { body: { name } }),
    onSuccess: (tag) => {
      setMade((names) => ({ ...names, [tag.id]: tag.name }));
      add(tag.id, tag.name);
      void cache.invalidateQueries({ queryKey: cacheKey });
    },
  });
  const makeNew = (): void => {
    if (choices.create !== null && !create.isPending) create.mutate(choices.create);
  };
  const choose = (index: number): void => {
    const tag = choices.options[index];
    if (tag !== undefined) add(tag.id, tag.name);
    else if (index === choices.options.length) makeNew();
  };

  // The row the keyboard is on stays in sight in a long list.
  useEffect(() => {
    if (at >= 0)
      document.getElementById(`${listId}-${String(at)}`)?.scrollIntoView({ block: 'nearest' });
  }, [at, listId]);

  const createName = choices.create ?? '';
  const shownCount = choices.options.length;
  const matchingCount = choices.matching;
  const none = tags.data?.items.length === 0;
  // One line under the box says where things stand; a plain count is for a screen reader only.
  const quiet = tags.isPending
    ? t`Loading tags…`
    : tags.isError
      ? null
      : choices.alreadyChosen
        ? t`This tag is already chosen.`
        : rows > 0
          ? choices.matching > choices.options.length
            ? t`Showing ${shownCount} of ${matchingCount}. Type to narrow the list.`
            : null
          : typed.trim() !== ''
            ? t`No tags match.`
            : none
              ? tags.data.canCreate
                ? t`There are no tags yet. Type a name to make the first one.`
                : t`There are no tags yet. Make them in Settings, under Custom Fields & Tags.`
              : tags.data.canCreate
                ? t`Every tag is already chosen. Type a name to make a new one.`
                : t`Every tag is already chosen.`;
  const count = plural(choices.options.length, { one: '# tag to add', other: '# tags to add' });

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-7 items-center gap-1.5">
        <p id={labelId} className="text-sm font-medium">
          {label}
        </p>
        {disabled ? null : (
          <Popover
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              setTyped('');
              setActive(-1);
              create.reset();
            }}
          >
            <PopoverTrigger
              ref={triggerRef}
              render={
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Add tag`}
                  title={t`Add tag`}
                  className="size-7 min-h-0 rounded-full p-0 text-link lg:min-h-0"
                />
              }
            >
              <CirclePlus aria-hidden className="size-[18px]" strokeWidth={1.8} />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72">
              <PopoverTitle>
                <Trans>Add a tag</Trans>
              </PopoverTitle>
              {room ? (
                <>
                  <Input
                    ref={inputRef}
                    role="combobox"
                    aria-label={t`Search tags`}
                    aria-autocomplete="list"
                    aria-expanded={rows > 0}
                    aria-controls={rows > 0 ? listId : undefined}
                    aria-activedescendant={at >= 0 ? optionId(at) : undefined}
                    placeholder={
                      tags.data?.canCreate === true ? t`Search or create a tag` : t`Search tags`
                    }
                    autoComplete="off"
                    maxLength={TAG_NAME_LENGTH}
                    value={typed}
                    onChange={(event) => {
                      setTyped(event.target.value);
                      // The first match is ready for Enter as soon as something is typed.
                      setActive(event.target.value.trim() === '' ? -1 : 0);
                      create.reset();
                    }}
                    onKeyDown={(event) => {
                      if (isListKey(event.key)) {
                        event.preventDefault();
                        setActive(stepped(at, rows, event.key));
                      } else if (event.key === 'Enter') {
                        event.preventDefault();
                        if (at >= 0) choose(at);
                        else if (rows === 1) choose(0);
                      }
                    }}
                  />
                  {rows === 0 ? null : (
                    <div
                      id={listId}
                      role="listbox"
                      aria-label={t`Tags to add`}
                      className="flex max-h-56 flex-col overflow-y-auto"
                    >
                      {choices.groups.map((group) => {
                        const items = group.tags.map((tag) => {
                          const index = choices.options.indexOf(tag);
                          return (
                            // The keyboard works the list from the search box, which names the
                            // option it is on (aria-activedescendant): an option is never focused.
                            // eslint-disable-next-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/interactive-supports-focus
                            <div
                              key={tag.id}
                              id={optionId(index)}
                              role="option"
                              aria-selected={index === at}
                              className={optionClassName}
                              // The keyboard stays in the box: a press is not a move of focus.
                              onMouseDown={(event) => {
                                event.preventDefault();
                              }}
                              onClick={() => {
                                choose(index);
                              }}
                            >
                              <span
                                aria-hidden
                                className={`size-2.5 shrink-0 rounded-full ${tints[tintOf(tag.id)]}`}
                              />
                              <span className="min-w-0 wrap-anywhere">{tag.name}</span>
                            </div>
                          );
                        });
                        const groupName =
                          group.name ?? (choices.groups.length > 1 ? t`Other tags` : null);
                        return groupName === null ? (
                          items
                        ) : (
                          <div key={group.id ?? ''} role="group" aria-label={groupName}>
                            <p
                              aria-hidden
                              className="px-2 pt-2 pb-0.5 text-xs font-medium text-muted-foreground"
                            >
                              {groupName}
                            </p>
                            {items}
                          </div>
                        );
                      })}
                      {choices.create === null ? null : (
                        // eslint-disable-next-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/interactive-supports-focus -- as above
                        <div
                          id={optionId(choices.options.length)}
                          role="option"
                          aria-selected={at === choices.options.length}
                          aria-disabled={create.isPending}
                          className={optionClassName}
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={makeNew}
                        >
                          <Plus aria-hidden className="size-4 shrink-0" strokeWidth={2} />
                          <span className="min-w-0 wrap-anywhere">
                            {create.isPending
                              ? t`Creating “${createName}”…`
                              : t`Create tag “${createName}”`}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  <p
                    role="status"
                    className={quiet === null ? 'sr-only' : 'text-sm text-muted-foreground'}
                  >
                    {quiet ?? (tags.isError ? '' : count)}
                  </p>
                  {tags.isError ? (
                    <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                      <p>
                        <Trans>The tags couldn't be loaded.</Trans>
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
                  {create.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {create.error instanceof ApiError
                        ? create.error.message
                        : t`The tag wasn't made. Check your connection and try again.`}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t`${limit} tags are chosen, which is the most. Remove one to add another.`}
                </p>
              )}
            </PopoverContent>
          </Popover>
        )}
      </div>
      {chosen.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No tags chosen.</Trans>
        </p>
      ) : tags.data === undefined ? (
        // The chosen tags are known by id only until the business's tags are read.
        <p className="text-sm text-muted-foreground">
          {tags.isError ? (
            <Trans>The tags couldn't be loaded. Reload the page to see the chosen tags.</Trans>
          ) : (
            <Trans>Loading tags…</Trans>
          )}
        </p>
      ) : (
        <ul aria-labelledby={labelId} className="flex min-w-0 list-none flex-wrap gap-1.5 p-0">
          {chips.map((chip) => {
            const name = chip.name ?? t`Deleted tag`;
            return (
              <li
                key={chip.id}
                className={`flex max-w-full min-w-0 items-center gap-0.5 rounded-full py-0.5 pr-0.5 pl-2.5 text-sm font-medium text-foreground ${
                  chip.name === null ? 'bg-secondary' : tints[tintOf(chip.id)]
                }`}
              >
                <span className="min-w-0 wrap-anywhere">{name}</span>
                {disabled ? (
                  <span className="w-2" />
                ) : (
                  <button
                    type="button"
                    aria-label={t`Remove ${name}`}
                    title={t`Remove ${name}`}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      onChange(chosen.filter((each) => each !== chip.id));
                      setNotice(t`Removed ${name}.`);
                      // The chip is gone: the keyboard goes to the button that adds one.
                      triggerRef.current?.focus();
                    }}
                  >
                    <X aria-hidden className="size-3.5" strokeWidth={2.2} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p role="status" className="sr-only">
        {notice}
      </p>
    </div>
  );
}
