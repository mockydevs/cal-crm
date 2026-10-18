import { Trans, useLingui } from '@lingui/react/macro';
import {
  createNote,
  updateNote,
  deleteNote,
  listRecordNotes,
  type Note,
  type NoteDocument,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { StickyNote } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useActorLabel } from './activity';
import { apiIn } from './api';
import { ContactPanel, PanelEmpty } from './contact-panels';
import { useBusiness } from './workspace';
import NoteEditorLoader from './note-editor-loader';

const emptyDocument: NoteDocument = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Render the bounded document as escaped React nodes, never as stored HTML. */
function NoteBody({ body }: { readonly body: NoteDocument }): ReactElement {
  // Saved documents are immutable. Text positions identify their paragraphs and
  // inline runs, including repeated words and empty paragraphs.
  let position = 0;
  return (
    <div className="min-w-0 break-words [&_p+p]:mt-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1">
      {body.content.map((paragraph) => {
        const paragraphPosition = position++;
        return (
          <p key={paragraphPosition}>
            {paragraph.content?.map((node) => {
              const nodePosition = position;
              position += node.type === 'hardBreak' ? 1 : node.text.length;
              if (node.type === 'hardBreak') return <br key={nodePosition} />;
              let content: ReactNode = node.text;
              for (const mark of node.marks ?? []) {
                if (mark.type === 'bold') content = <strong>{content}</strong>;
                if (mark.type === 'italic') content = <em>{content}</em>;
                if (mark.type === 'code') content = <code>{content}</code>;
              }
              return <span key={nodePosition}>{content}</span>;
            }) ?? <br />}
          </p>
        );
      })}
    </div>
  );
}

export function RecordNotes({
  recordId,
  readOnly = false,
}: {
  readonly recordId: string;
  readonly readOnly?: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const actorLabel = useActorLabel();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);
  const [editor, setEditor] = useState<{ note?: Note }>();
  const [confirming, setConfirming] = useState<Note>();
  const writing = editor !== undefined;
  const [notice, setNotice] = useState('');
  const addRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRegionRef = useRef<HTMLDivElement>(null);
  const lastNoteRef = useRef<HTMLLIElement>(null);
  const loadTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterSaveRef = useRef<string | undefined>(undefined);
  const focusKeep = useCallback((button: HTMLButtonElement | null) => {
    button?.focus();
  }, []);
  const notesKey = ['b', business.id, 'notes', recordId];
  const notes = useInfiniteQuery({
    queryKey: [...notesKey, debouncedSearch],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(business.id).request(listRecordNotes, {
        params: { id: recordId },
        query: { q: debouncedSearch, ...(pageParam === undefined ? {} : { after: pageParam }) },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const canManage = notes.data?.pages[0]?.canManage === true && !readOnly;
  const items = notes.data?.pages.flatMap((page) => page.items) ?? [];
  const searching = search.trim() !== debouncedSearch || notes.isPlaceholderData;
  const latest =
    editor?.note === undefined ? undefined : items.find((note) => note.id === editor.note?.id);
  const newer =
    latest !== undefined && latest.revision !== editor?.note?.revision ? latest : undefined;
  useEffect(() => {
    const trigger = loadTriggerRef.current;
    if (trigger === null || notes.isFetching) return;
    loadTriggerRef.current = null;
    if (
      !notes.hasNextPage &&
      !notes.isError &&
      (document.activeElement === trigger || document.activeElement === document.body)
    )
      lastNoteRef.current?.focus();
  }, [notes.data, notes.isFetching, notes.hasNextPage, notes.isError]);
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: notesKey }),
      cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', recordId] }),
    ]);
  };
  const save = useMutation({
    mutationFn: ({ body, note }: { body: NoteDocument; note: Note | undefined }) =>
      note === undefined
        ? apiIn(business.id).request(createNote, {
            params: { id: recordId },
            body: { body },
          })
        : apiIn(business.id).request(updateNote, {
            params: { id: recordId, noteId: note.id },
            body: { body, revision: note.revision },
          }),
    onSuccess: async (_, input) => {
      await refresh();
      setEditor(undefined);
      setNotice(input.note === undefined ? t`Note added.` : t`Note updated.`);
      focusAfterSaveRef.current = input.note === undefined ? 'add' : `edit:${input.note.id}`;
    },
  });
  const remove = useMutation({
    mutationFn: (note: Note) =>
      apiIn(business.id).request(deleteNote, {
        params: { id: recordId, noteId: note.id },
        body: { revision: note.revision },
      }),
    onSuccess: async () => {
      await refresh();
      setConfirming(undefined);
      setNotice(t`Note deleted.`);
      focusAfterSaveRef.current = 'add';
    },
  });
  const busy = save.isPending || remove.isPending;
  useEffect(() => {
    if (!busy && focusAfterSaveRef.current !== undefined) {
      const target = focusAfterSaveRef.current;
      focusAfterSaveRef.current = undefined;
      (actionsRef.current.get(target) ?? addRef.current ?? searchRef.current)?.focus();
    }
  }, [busy, editor, confirming]);
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  // The one way to add a note: beside the title, or in the empty panel's own words.
  const add =
    canManage && !writing ? (
      <Button
        ref={addRef}
        variant="secondary"
        size="small"
        disabled={busy || confirming !== undefined}
        onClick={() => {
          save.reset();
          setNotice('');
          setEditor({});
        }}
      >
        <Trans>Add note</Trans>
      </Button>
    ) : null;
  const none = notes.data !== undefined && items.length === 0 && !searching;
  const noneYet = none && search.trim() === '';
  return (
    <ContactPanel title={t`Notes`} action={noneYet ? null : add}>
      <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
        <Trans>Search notes</Trans>
        <input
          ref={searchRef}
          type="search"
          maxLength={200}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          className="min-h-11 min-w-0 rounded-control border border-input bg-card px-3 text-md"
        />
      </label>
      <Button
        variant="quiet"
        size="small"
        className="self-start"
        disabled={notes.isFetching || busy}
        onClick={() => {
          void notes.refetch();
        }}
      >
        <Trans>Refresh notes</Trans>
      </Button>
      {notes.isPending ? (
        <p aria-live="polite">
          <Trans>Loading notes…</Trans>
        </p>
      ) : null}
      {searching && !notes.isPending ? (
        <p role="status">
          <Trans>Searching notes…</Trans>
        </p>
      ) : null}
      {notes.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>
            {notes.isFetchNextPageError
              ? t`Older notes couldn't be loaded. Your current notes are still here.`
              : t`Notes couldn't be loaded.`}
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={(event) => {
              if (notes.isFetchNextPageError) loadTriggerRef.current = event.currentTarget;
              void (notes.isFetchNextPageError ? notes.fetchNextPage() : notes.refetch());
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {noneYet ? (
        <PanelEmpty
          icon={<StickyNote />}
          title={t`No notes yet.`}
          description={t`Keep track of important details by adding the first note.`}
          action={add}
        />
      ) : none ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No notes match your search.</Trans>
        </p>
      ) : null}
      <ol className="flex min-w-0 flex-col divide-y divide-border">
        {items.map((note) => {
          const author = actorLabel(note.author);
          const lastEditor = note.editedBy === null ? undefined : actorLabel(note.editedBy);
          return (
            <li
              key={note.id}
              ref={note.id === items.at(-1)?.id ? lastNoteRef : undefined}
              tabIndex={-1}
              className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <Badge variant={note.author.kind === 'ai_agent' ? 'assistant' : 'neutral'}>
                  {t`Added by ${author}`}
                </Badge>
                <time className="text-muted-foreground" dateTime={note.createdAt}>
                  {dates.format(new Date(note.createdAt))}
                </time>
              </div>
              {lastEditor !== undefined && note.editedAt !== null ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                  <span>{t`Edited by ${lastEditor}`}</span>
                  <time dateTime={note.editedAt}>{dates.format(new Date(note.editedAt))}</time>
                </div>
              ) : null}
              <NoteBody body={note.body} />
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    ref={(button) => {
                      if (button === null) actionsRef.current.delete(`edit:${note.id}`);
                      else actionsRef.current.set(`edit:${note.id}`, button);
                    }}
                    variant="quiet"
                    size="small"
                    disabled={busy || writing || confirming !== undefined}
                    onClick={() => {
                      save.reset();
                      remove.reset();
                      setNotice('');
                      setEditor({ note });
                    }}
                  >
                    <Trans>Edit note</Trans>
                  </Button>
                  <Button
                    ref={(button) => {
                      if (button === null) actionsRef.current.delete(`delete:${note.id}`);
                      else actionsRef.current.set(`delete:${note.id}`, button);
                    }}
                    variant="quiet"
                    size="small"
                    disabled={busy || writing || confirming !== undefined}
                    onClick={() => {
                      save.reset();
                      remove.reset();
                      setNotice('');
                      setConfirming(note);
                    }}
                  >
                    <Trans>Delete note</Trans>
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {notes.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={notes.isFetchingNextPage || searching}
          onClick={(event) => {
            loadTriggerRef.current = event.currentTarget;
            void notes.fetchNextPage();
          }}
        >
          {notes.isFetchingNextPage ? t`Loading…` : t`Load older notes`}
        </Button>
      ) : null}
      {editor === undefined ? null : (
        <div ref={editorRegionRef} className="flex min-w-0 flex-col gap-3">
          {newer === undefined ? null : (
            <div
              role="group"
              aria-label={t`Review the newer note`}
              className="flex flex-col gap-3 rounded-control border border-border p-4"
            >
              <p className="text-sm">
                <Trans>
                  A newer version is saved. Review it above. Keeping your draft will replace it on
                  your next save.
                </Trans>
              </p>
              <Button
                variant="secondary"
                disabled={busy || !canManage}
                onClick={() => {
                  setEditor({ note: newer });
                  save.reset();
                  editorRegionRef.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
                }}
              >
                <Trans>Keep my draft</Trans>
              </Button>
            </div>
          )}
          <NoteEditorLoader
            key={editor.note?.id ?? 'new'}
            initialBody={editor.note?.body ?? emptyDocument}
            pending={save.isPending}
            readOnly={!canManage}
            onSave={(body) => {
              if (canManage) save.mutate({ body, note: editor.note });
            }}
            onCancel={() => {
              focusAfterSaveRef.current =
                editor.note === undefined ? 'add' : `edit:${editor.note.id}`;
              setEditor(undefined);
              save.reset();
            }}
          />
        </div>
      )}
      {confirming === undefined ? null : (
        <div
          role="group"
          aria-label={t`Delete this note?`}
          className="flex min-w-0 flex-col gap-3 rounded-control border border-border p-4"
        >
          <p className="text-sm">
            <Trans>Delete this note? This can't be undone.</Trans>
          </p>
          <p className="break-words text-sm text-muted-foreground">
            {Array.from(confirming.text).slice(0, 160).join('')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              disabled={busy || !canManage}
              onClick={() => {
                if (canManage) remove.mutate(confirming);
              }}
            >
              <Trans>Confirm deletion</Trans>
            </Button>
            <Button
              ref={focusKeep}
              variant="secondary"
              size="small"
              disabled={busy}
              onClick={() => {
                focusAfterSaveRef.current = `delete:${confirming.id}`;
                setConfirming(undefined);
                remove.reset();
              }}
            >
              <Trans>Keep note</Trans>
            </Button>
          </div>
        </div>
      )}
      {writing && !canManage ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Notes are read-only here. Your draft is still here.</Trans>
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {save.error instanceof ApiError
            ? (save.error.problem.errors?.[0]?.message ?? save.error.message)
            : t`The note wasn't saved. Check your connection and try again.`}
        </p>
      ) : null}
      {remove.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {remove.error instanceof ApiError
            ? remove.error.message
            : t`The note wasn't deleted. Check your connection and try again.`}
        </p>
      ) : null}
      <p role="status" className="text-sm empty:sr-only">
        {notice}
      </p>
    </ContactPanel>
  );
}
