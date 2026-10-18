// The composer's snippet picker: a small list of the business's snippets, searched on the
// server and grouped by folder, over the reply form. Choosing one asks the server to fill
// its merge fields in for the conversation's contact, and hands the text to the composer. A
// field the contact has no value for is named, and the snippet is then put in only if the
// person asks, with the field as written. It is a combobox over a listbox: the arrow keys
// move, Enter chooses, Escape closes.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getSnippet,
  listSnippets,
  mergeToken,
  renderSnippet,
  type SnippetSummary,
  type SnippetType,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from './api';
import { groupByFolder, highlightAfter, mergePieces } from './snippet-picker-rules';
import { useBusiness } from './workspace';

/** As many as the list shows at once: past it, the person searches. */
const SHOWN = 50;

/** What's typed, once typing pauses, so the API isn't asked for every key. */
function useSettled(value: string, delay = 150): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

export interface FilledSnippet {
  readonly subject: string | null;
  readonly body: string;
}

export interface SnippetPickerProps {
  /** The snippets the message's channel takes. */
  readonly type: SnippetType;
  /** The contact the merge fields are filled in for. */
  readonly contactId: string;
  readonly contactName: string;
  /** What was typed after the "/" that opened it. */
  readonly initialQuery: string;
  /** Puts the text in the message. False when the message would be too long for it. */
  readonly onInsert: (filled: FilledSnippet) => boolean;
  /** The button that opens and closes it: a press on it is the button's own to handle. */
  readonly opener: RefObject<HTMLElement | null>;
  /**
   * Closed with nothing chosen: the message is left as it is. By Escape, the keyboard goes
   * back to the message; by a press elsewhere, it is already where the person put it.
   */
  readonly onClose: (how: 'escape' | 'elsewhere') => void;
}

interface Refusal {
  readonly snippet: SnippetSummary;
  readonly why: 'missing_values' | 'subject_line_break' | 'too_long' | 'failed';
  readonly fields: readonly string[];
}

/** A text on one line, its merge fields set apart from its words. */
function Preview({ text }: { readonly text: string }): ReactElement {
  return (
    <span className="block truncate text-xs text-muted-foreground">
      {mergePieces(text).map((piece) =>
        piece.field ? (
          <code key={piece.at} className="rounded-sm bg-muted px-1 font-mono text-[11px] text-body">
            {piece.text}
          </code>
        ) : (
          piece.text
        ),
      )}
    </span>
  );
}

export default function SnippetPicker({
  type,
  contactId,
  contactName,
  initialQuery,
  opener,
  onInsert,
  onClose,
}: SnippetPickerProps): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [typed, setTyped] = useState(initialQuery);
  const q = useSettled(typed.trim());
  const [highlight, setHighlight] = useState(0);
  const [refusal, setRefusal] = useState<Refusal>();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (index: number): string => `${listId}-${String(index)}`;

  const found = useQuery({
    queryKey: ['b', business.id, 'snippets', 'picker', { type, q }],
    queryFn: () =>
      api.request(listSnippets, { query: { type, limit: SHOWN, ...(q === '' ? {} : { q }) } }),
    staleTime: 30_000,
    retry: false,
  });
  const groups = groupByFolder(found.data?.items ?? [], i18n.locale);
  const options = groups.flatMap((group) => group.items);
  const total = found.data?.total ?? 0;
  // Only what was found for what's typed now, so Enter never follows an earlier search's.
  const searching = found.isPending || q !== typed.trim();
  const at = Math.min(highlight, options.length - 1);

  // The keyboard goes to the search as the picker opens; it came from the message.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // A press anywhere else closes it, as a menu closes; so does Escape from anywhere in it,
  // which then closes only the picker, not the thread or the panel it is in.
  useEffect(() => {
    const within = (target: EventTarget | null): boolean =>
      target instanceof Node && rootRef.current?.contains(target) === true;
    const pressed = (event: PointerEvent): void => {
      if (within(event.target)) return;
      if (event.target instanceof Node && opener.current?.contains(event.target) === true) return;
      onClose('elsewhere');
    };
    const keyed = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !within(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose('escape');
    };
    document.addEventListener('pointerdown', pressed);
    document.addEventListener('keydown', keyed, true);
    return () => {
      document.removeEventListener('pointerdown', pressed);
      document.removeEventListener('keydown', keyed, true);
    };
  }, [onClose, opener]);

  const hand = (snippet: SnippetSummary, filled: FilledSnippet): void => {
    if (!onInsert(filled)) setRefusal({ snippet, why: 'too_long', fields: [] });
  };
  const fill = useMutation({
    mutationFn: (snippet: SnippetSummary) =>
      api.request(renderSnippet, { params: { snippetId: snippet.id }, body: { contactId } }),
    onSuccess: (rendered, snippet) => {
      if (rendered.ok) hand(snippet, { subject: rendered.subject, body: rendered.body });
      else setRefusal({ snippet, why: rendered.code, fields: rendered.fields });
    },
    onError: (_error, snippet) => {
      setRefusal({ snippet, why: 'failed', fields: [] });
    },
  });
  // The snippet as it is written, for the person who asks for it with its fields unfilled.
  const asWritten = useMutation({
    mutationFn: (snippet: SnippetSummary) =>
      api.request(getSnippet, { params: { snippetId: snippet.id } }),
    onSuccess: (whole, snippet) => {
      hand(snippet, { subject: whole.subject, body: whole.body });
    },
    onError: (_error, snippet) => {
      setRefusal({ snippet, why: 'failed', fields: [] });
    },
  });
  const busy = fill.isPending || asWritten.isPending;
  const choose = (snippet: SnippetSummary | undefined): void => {
    if (snippet === undefined || busy || searching) return;
    setRefusal(undefined);
    fill.mutate(snippet);
  };

  const count = options.length;
  const status = busy
    ? t`Filling in the snippet…`
    : refusal !== undefined
      ? ''
      : found.isError
        ? ''
        : searching
          ? t`Searching…`
          : count === 0
            ? ''
            : total > count
              ? t`Showing the first ${count} of ${total} snippets. Search to find the others.`
              : plural(count, { one: '# snippet', other: '# snippets' });
  const refusedName = refusal?.snippet.name ?? '';
  const fields = (refusal?.fields ?? []).map(mergeToken).join(', ');

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t`Snippets`}
      className="absolute bottom-full left-0 z-20 mb-2 flex max-h-80 w-full max-w-md min-w-0 flex-col overflow-hidden rounded-card border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="border-b p-2">
        <input
          ref={inputRef}
          role="combobox"
          aria-label={type === 'email' ? t`Search email snippets` : t`Search text snippets`}
          aria-expanded={count > 0 && refusal === undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          {...(count > 0 && refusal === undefined ? { 'aria-activedescendant': optionId(at) } : {})}
          autoComplete="off"
          spellCheck={false}
          placeholder={type === 'email' ? t`Search email snippets…` : t`Search text snippets…`}
          value={typed}
          maxLength={200}
          className="min-h-11 w-full min-w-0 rounded-control border border-input bg-card px-3 text-md text-foreground lg:min-h-9"
          onChange={(event) => {
            setTyped(event.target.value);
            setHighlight(0);
            setRefusal(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              // Never the reply form's own Enter.
              event.preventDefault();
              if (refusal === undefined) choose(options[at]);
              return;
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            // The arrows move through the list, not through what is typed.
            event.preventDefault();
            const next = highlightAfter(event.key, at, count);
            setHighlight(next);
            document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' });
          }}
        />
      </div>
      <p role="status" className="px-3 pt-2 text-xs text-muted-foreground empty:hidden">
        {status}
      </p>
      {refusal !== undefined ? (
        <div role="alert" className="flex min-w-0 flex-col gap-2 p-3 text-sm">
          <p className="font-medium wrap-anywhere">
            {refusal.why === 'missing_values' ? (
              <Trans>
                {contactName} has no value for {fields}, which “{refusedName}” uses.
              </Trans>
            ) : refusal.why === 'subject_line_break' ? (
              <Trans>
                For {contactName}, {fields} would break the subject of “{refusedName}” onto a second
                line.
              </Trans>
            ) : refusal.why === 'too_long' ? (
              <Trans>“{refusedName}” is too long to fit in this message.</Trans>
            ) : (
              <Trans>“{refusedName}” couldn’t be read. Check your connection and try again.</Trans>
            )}
          </p>
          {refusal.why === 'missing_values' || refusal.why === 'subject_line_break' ? (
            <p className="text-muted-foreground">
              <Trans>
                You can put it in as it is written and fill those fields in yourself before you
                send.
              </Trans>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {refusal.why === 'missing_values' || refusal.why === 'subject_line_break' ? (
              <Button
                type="button"
                size="small"
                disabled={busy}
                onClick={() => {
                  asWritten.mutate(refusal.snippet);
                }}
              >
                <Trans>Insert with the fields unfilled</Trans>
              </Button>
            ) : null}
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setRefusal(undefined);
                inputRef.current?.focus();
              }}
            >
              <Trans>Choose another snippet</Trans>
            </Button>
          </div>
        </div>
      ) : found.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 p-3 text-sm">
          <p>
            <Trans>The snippets couldn’t be loaded.</Trans>
          </p>
          <Button
            type="button"
            size="small"
            variant="secondary"
            onClick={() => {
              void found.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : count === 0 ? (
        searching ? null : (
          <p className="p-3 text-sm text-muted-foreground">
            {q !== '' ? (
              <Trans>No snippets match “{q}”.</Trans>
            ) : type === 'email' ? (
              <Trans>No email snippets yet. An email takes email snippets only.</Trans>
            ) : (
              <Trans>No text snippets yet. A text or a chat takes text snippets only.</Trans>
            )}
          </p>
        )
      ) : (
        <div
          id={listId}
          role="listbox"
          aria-label={type === 'email' ? t`Email snippets` : t`Text snippets`}
          aria-busy={busy}
          className="min-h-0 flex-1 overflow-y-auto p-1"
        >
          {groups.map((group) => {
            const groupName = group.name ?? t`No folder`;
            return (
              <div key={group.key} role="group" aria-label={groupName}>
                {groups.length === 1 && group.name === null ? null : (
                  <p
                    aria-hidden
                    className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
                  >
                    {groupName}
                  </p>
                )}
                {group.items.map((snippet) => {
                  const index = options.indexOf(snippet);
                  return (
                    // The keyboard works the list from the search box, which names the
                    // option it is on (aria-activedescendant): an option is never focused.
                    // eslint-disable-next-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/interactive-supports-focus
                    <div
                      key={snippet.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === at}
                      className="flex min-h-11 min-w-0 cursor-pointer flex-col justify-center gap-0.5 rounded-control px-2 py-1.5 text-sm aria-selected:bg-secondary"
                      onPointerMove={() => {
                        if (index !== at) setHighlight(index);
                      }}
                      onClick={() => {
                        setHighlight(index);
                        choose(snippet);
                      }}
                    >
                      <span className="truncate font-medium text-foreground">{snippet.name}</span>
                      <Preview
                        text={
                          snippet.subject === null
                            ? snippet.bodyPreview
                            : `${snippet.subject}: ${snippet.bodyPreview}`
                        }
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
        <Link
          to="/b/$slug/marketing/snippets"
          params={{ slug: business.slug }}
          className="inline-flex min-h-11 items-center font-medium text-link underline-offset-2 hover:underline lg:min-h-7"
        >
          <Trans>Manage snippets</Trans>
        </Link>
        <span className="max-sm:hidden">
          <Trans>Enter to insert · Esc to close</Trans>
        </span>
      </div>
    </div>
  );
}
