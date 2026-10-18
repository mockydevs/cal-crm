// What the Snippets page's right-hand panel holds: a snippet being written or edited. The
// list shows only the start of each body, so an edit (and a copy) first reads the whole
// snippet. A snippet keeps its type: only a new one chooses it.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createSnippet,
  getSnippet,
  snippetTypes,
  updateSnippet,
  type Snippet,
  type SnippetFolder,
  type SnippetType,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  panelFormClassName,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './conversation-extras-panel';
import {
  snippetBodyLimit,
  snippetDraftReady,
  snippetSubject,
  type SnippetDraft,
} from './conversation-extras-rules';
import { noRejection, type Rejection } from './problems';
import { FormProblem, isStale, ListProblem, retryFaults, savingProblem } from './settings-list';
import { useBusiness } from './workspace';

/** The Folder choice's value for "no folder": never a folder's id. */
export const NO_FOLDER = 'none';

/** What the panel was opened for: a new snippet, one to edit, or one to copy. */
export type SnippetPanelFor =
  | { readonly mode: 'new' }
  | { readonly mode: 'edit'; readonly id: string }
  | { readonly mode: 'copy'; readonly id: string };

export interface SnippetPanelProps {
  readonly opened: SnippetPanelFor;
  readonly folders: readonly SnippetFolder[];
  readonly onCancel: () => void;
  readonly onSaved: (created: boolean) => Promise<void>;
}

export function SnippetPanel({
  opened,
  folders,
  onCancel,
  onSaved,
}: SnippetPanelProps): ReactElement {
  const business = useBusiness();
  const id = opened.mode === 'new' ? undefined : opened.id;
  // Never from the cache: the form starts from what is saved now, with its revision.
  const read = useQuery({
    queryKey: ['b', business.id, 'snippet', id],
    queryFn: () => apiIn(business.id).request(getSnippet, { params: { snippetId: id ?? '' } }),
    enabled: id !== undefined,
    gcTime: 0,
    staleTime: 0,
    retry: retryFaults,
  });
  const [reloaded, setReloaded] = useState<Snippet>();
  if (id === undefined)
    return (
      <SnippetForm snippet={undefined} folders={folders} onCancel={onCancel} onSaved={onSaved} />
    );
  if (read.isError)
    return (
      <div className={sidePanelBodyClassName}>
        <ListProblem
          onRetry={() => {
            void read.refetch();
          }}
        >
          <Trans>The snippet couldn't be loaded. It may have been deleted.</Trans>
        </ListProblem>
      </div>
    );
  const snippet = reloaded ?? read.data;
  if (snippet === undefined)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        <Trans>Loading the snippet…</Trans>
      </p>
    );
  return (
    <SnippetForm
      key={`${snippet.id}:${snippet.revision}`}
      snippet={snippet}
      copying={opened.mode === 'copy'}
      folders={folders}
      onCancel={onCancel}
      onSaved={onSaved}
      onReload={setReloaded}
    />
  );
}

function SnippetForm({
  snippet,
  copying = false,
  folders,
  onCancel,
  onSaved,
  onReload,
}: {
  /** The snippet to edit or to copy, or undefined for a new one. */
  readonly snippet: Snippet | undefined;
  readonly copying?: boolean;
  readonly folders: readonly SnippetFolder[];
  readonly onCancel: () => void;
  readonly onSaved: (created: boolean) => Promise<void>;
  /** The saved version, to edit in place of the one someone else has since changed. */
  readonly onReload?: (latest: Snippet) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const creating = snippet === undefined || copying;
  const original = snippet?.name ?? '';
  const copyName = t`Copy of ${original}`.slice(0, 120);
  const [type, setType] = useState<SnippetType>(snippet?.type ?? 'text');
  const [name, setName] = useState(copying ? copyName : (snippet?.name ?? ''));
  const [subject, setSubject] = useState(snippet?.subject ?? '');
  const [body, setBody] = useState(snippet?.body ?? '');
  const [folder, setFolder] = useState(snippet?.folderId ?? NO_FOLDER);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const folderId = folders.find((each) => each.id === folder)?.id ?? null;
  const draft: SnippetDraft = { type, name, subject, body };
  const limit = snippetBodyLimit(type);
  const used = body.length;
  const typeNames: Record<SnippetType, string> = { text: t`Text`, email: t`Email` };

  const save = useMutation({
    mutationFn: () =>
      creating
        ? api.request(createSnippet, {
            body: { type, name, subject: snippetSubject(draft), body, folderId },
          })
        : api.request(updateSnippet, {
            params: { snippetId: snippet.id },
            body: {
              name,
              subject: snippetSubject(draft),
              body,
              folderId,
              revision: snippet.revision,
            },
          }),
    onSuccess: () => onSaved(creating),
    onError: (error) => {
      setProblem(
        savingProblem(error, t`The snippet wasn't saved. Check your connection and try again.`),
      );
    },
  });
  const reload = useMutation({
    mutationFn: () => {
      if (snippet === undefined) throw new Error('Nothing saved to reload.');
      return api.request(getSnippet, { params: { snippetId: snippet.id } });
    },
    onSuccess: (latest) => onReload?.(latest),
    onError: () => {
      setProblem({
        fields: {},
        form: t`The saved version couldn't be loaded. It may have been deleted.`,
      });
    },
  });

  return (
    <Form<Record<string, unknown>>
      className={panelFormClassName}
      errors={problem.fields}
      onFormSubmit={() => {
        setProblem(noRejection);
        save.mutate();
      }}
    >
      <div className={sidePanelBodyClassName}>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <Trans>Type</Trans>
          <Select
            aria-label={t`Type`}
            disabled={snippet !== undefined}
            value={type}
            onValueChange={(next) => {
              const chosen = snippetTypes.find((each) => each === next);
              if (chosen !== undefined) setType(chosen);
            }}
          >
            {snippetTypes.map((each) => (
              <option key={each} value={each}>
                {typeNames[each]}
              </option>
            ))}
          </Select>
          {snippet === undefined ? null : (
            <span className="text-sm font-normal text-muted-foreground">
              <Trans>A snippet keeps its type.</Trans>
            </span>
          )}
        </label>
        <Field name="name">
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            required
            maxLength={120}
            autoComplete="off"
            placeholder={t`Enter snippet name`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <FieldError />
        </Field>
        {type === 'email' ? (
          <Field name="subject">
            <FieldLabel>
              <Trans>Subject</Trans>
            </FieldLabel>
            <Input
              required
              maxLength={255}
              autoComplete="off"
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
              }}
            />
            <FieldError />
          </Field>
        ) : null}
        <Field name="body">
          <FieldLabel>
            <Trans>Message</Trans>
          </FieldLabel>
          <Textarea
            required
            rows={8}
            maxLength={limit}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <FieldDescription>
            <Trans>
              {used} of {limit} characters. Plain text; merge fields are filled in for the contact
              when the snippet is put into a message.
            </Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <Trans>Folder</Trans>
          <Select aria-label={t`Folder`} value={folder} onValueChange={setFolder}>
            <option value={NO_FOLDER}>{t`No folder`}</option>
            {folders.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </Select>
        </label>
        <FormProblem
          problem={problem}
          stale={isStale(save.error)}
          busy={reload.isPending}
          onReload={() => {
            reload.mutate();
          }}
        />
      </div>
      <div className={sidePanelFooterClassName}>
        <Button
          variant="secondary"
          disabled={save.isPending}
          onClick={() => {
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={save.isPending || !snippetDraftReady(draft)}>
          {creating ? t`Create snippet` : t`Save changes`}
        </Button>
      </div>
    </Form>
  );
}
