// The Templates page's small dialogs, fetched when one is first opened: renaming a template,
// archiving or deleting one (each naming the workflows it affects first), moving one or many
// to a folder, and asking before archiving or deleting many.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  archiveMessageTemplate,
  bulkMessageTemplates,
  deleteMessageTemplate,
  getMessageTemplate,
  listMessageTemplateFolders,
  moveMessageTemplate,
  updateMessageTemplate,
  type BulkMessageTemplatesResult,
  type MessageTemplate,
  type MessageTemplateSummary,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '../email-library/select';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from '../api';
import { noRejection } from '../problems';
import { ConfirmDialog, retryFaults, savingProblem, SmallDialog } from '../settings-list';
import { folderLabels } from '../template-folder-rules';
import { useBusiness } from '../workspace';

/** Changes many templates in one request: each one's outcome comes back, in order. */
export function requestBulk(
  businessId: string,
  action: 'archive' | 'delete' | 'restore',
  ids: readonly string[],
): Promise<BulkMessageTemplatesResult> {
  return apiIn(businessId).request(bulkMessageTemplates, { body: { action, ids: [...ids] } });
}

/** The template as it is now, with the workflows that send it: read fresh for each dialog. */
function useFresh(id: string) {
  const business = useBusiness();
  return useQuery({
    queryKey: ['b', business.id, 'message-template', id, 'fresh'],
    queryFn: () => apiIn(business.id).request(getMessageTemplate, { params: { id } }),
    retry: retryFaults,
    staleTime: 0,
    gcTime: 0,
  });
}

/** The workflows' names in a sentence: at most three, then how many more. */
export function workflowNames(uses: readonly { readonly name: string }[]): string {
  const shown = uses.slice(0, 3).map((use) => `“${use.name}”`);
  const more = uses.length - shown.length;
  return more > 0 ? `${shown.join(', ')} +${String(more)}` : shown.join(', ');
}

/** What the content of a saved template is, to save it again under another name. */
function contentOf(template: MessageTemplate) {
  return {
    name: template.name,
    subject: template.subject,
    content: template.content,
    ...(template.preheader === null ? {} : { preheader: template.preheader }),
    revision: template.revision,
  };
}

export function RenameDialog({
  template,
  returnFocus,
  onClose,
  onSaved,
}: {
  readonly template: MessageTemplateSummary;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSaved: (template: MessageTemplate) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const fresh = useFresh(template.id);
  const [name, setName] = useState(template.name);
  const [problem, setProblem] = useState(noRejection);
  const save = useMutation({
    mutationFn: (current: MessageTemplate) =>
      apiIn(business.id).request(updateMessageTemplate, {
        params: { id: current.id },
        body: { ...contentOf(current), name: name.trim() },
      }),
    onSuccess: onSaved,
    onError: (error) => {
      setProblem(savingProblem(error, t`The template could not be renamed. Try again.`));
    },
  });
  return (
    <SmallDialog
      open
      title={t`Rename template`}
      returnFocus={returnFocus}
      onClose={() => {
        if (!save.isPending) onClose();
      }}
    >
      <Form
        errors={problem.fields}
        onFormSubmit={() => {
          setProblem(noRejection);
          if (fresh.data !== undefined) save.mutate(fresh.data);
        }}
      >
        <Field name="name">
          <FieldLabel>
            <Trans>Template name</Trans>
          </FieldLabel>
          <Input
            name="name"
            value={name}
            required
            maxLength={120}
            autoComplete="off"
            disabled={save.isPending}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <FieldError />
        </Field>
        {fresh.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t`We couldn't load this template.`}
          </p>
        ) : null}
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={save.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={save.isPending || fresh.data === undefined}>
            {save.isPending ? t`Saving…` : t`Rename`}
          </Button>
        </div>
      </Form>
    </SmallDialog>
  );
}

/**
 * Archiving takes a template out of the library and frees its name. One a workflow sends, or
 * runs still in progress will, can't be archived: the dialog says which, and offers nothing.
 */
export function ArchiveDialog({
  template,
  returnFocus,
  onClose,
  onDone,
}: {
  readonly template: MessageTemplateSummary;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onDone: (template: MessageTemplate) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const fresh = useFresh(template.id);
  const [problem, setProblem] = useState<string>();
  const archive = useMutation({
    mutationFn: (revision: string) =>
      apiIn(business.id).request(archiveMessageTemplate, {
        params: { id: template.id },
        body: { revision },
      }),
    onSuccess: onDone,
    onError: (error) => {
      setProblem(savingProblem(error, t`The template could not be archived. Try again.`).form);
    },
  });
  const { name } = template;
  const uses = fresh.data?.usedBy;
  // Sends treat an archived template as gone, so one a workflow sends can't be archived.
  if (uses !== undefined && uses !== null && uses.length > 0) {
    const live = uses.filter((use) => use.runsInProgress !== true);
    const running = uses.filter((use) => use.runsInProgress === true);
    const sending = workflowNames(live);
    const finishing = workflowNames(running);
    return (
      <InUseDialog
        returnFocus={returnFocus}
        onClose={onClose}
        description={
          running.length === 0
            ? t`${name} can't be archived while published workflows send it: ${sending}. Take it out of their Send email step first; their emails would stop.`
            : live.length === 0
              ? t`${name} can't be archived while runs still in progress send it: ${finishing}. Archive it once they finish.`
              : t`${name} can't be archived while published workflows send it: ${sending}. Take it out of their Send email step first; their emails would stop. Runs still in progress in ${finishing} send it too.`
        }
      />
    );
  }
  return (
    <ConfirmDialog
      open
      title={t`Archive template`}
      description={
        fresh.isPending
          ? t`Checking which workflows send ${name}…`
          : uses === undefined || uses === null
            ? t`Archive ${name}? It leaves the library and its name is free to use. A workflow that sends it stops at that step until it is restored.`
            : t`Archive ${name}? No published workflow sends it. You can restore it from Archived.`
      }
      confirmLabel={t`Archive`}
      busy={archive.isPending || fresh.isPending}
      problem={problem}
      returnFocus={returnFocus}
      onConfirm={() => {
        setProblem(undefined);
        archive.mutate(fresh.data?.revision ?? template.revision);
      }}
      onClose={() => {
        if (!archive.isPending) onClose();
      }}
    />
  );
}

/**
 * Deleting moves a template to the trash, where it can be restored. A template a workflow
 * sends, or runs still in progress will, can't be deleted: the dialog says which workflows,
 * and offers nothing.
 */
export function DeleteDialog({
  template,
  returnFocus,
  onClose,
  onDone,
}: {
  readonly template: MessageTemplateSummary;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onDone: (template: MessageTemplate) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const fresh = useFresh(template.id);
  const [problem, setProblem] = useState<string>();
  const remove = useMutation({
    mutationFn: (revision: string) =>
      apiIn(business.id).request(deleteMessageTemplate, {
        params: { id: template.id },
        body: { revision },
      }),
    onSuccess: onDone,
    onError: (error) => {
      setProblem(savingProblem(error, t`The template could not be deleted. Try again.`).form);
    },
  });
  const { name } = template;
  const uses = fresh.data?.usedBy ?? [];
  if (uses.length > 0) {
    // A workflow whose live version no longer sends it may still have runs that will.
    const live = uses.filter((use) => use.runsInProgress !== true);
    const running = uses.filter((use) => use.runsInProgress === true);
    const sending = workflowNames(live);
    const finishing = workflowNames(running);
    return (
      <InUseDialog
        returnFocus={returnFocus}
        onClose={onClose}
        description={
          running.length === 0
            ? t`${name} can't be deleted while published workflows send it: ${sending}. Take it out of their Send email step first.`
            : live.length === 0
              ? t`${name} can't be deleted while runs still in progress send it: ${finishing}. Delete it once they finish.`
              : t`${name} can't be deleted while published workflows send it: ${sending}. Take it out of their Send email step first. Runs still in progress in ${finishing} send it too.`
        }
      />
    );
  }
  return (
    <ConfirmDialog
      open
      title={t`Delete template`}
      description={
        fresh.isPending
          ? t`Checking which workflows send ${name}…`
          : t`Move ${name} to the trash? Nothing sends it from there, and you can restore it from Trash.`
      }
      confirmLabel={t`Move to trash`}
      destructive
      busy={remove.isPending || fresh.isPending}
      problem={problem}
      returnFocus={returnFocus}
      onConfirm={() => {
        setProblem(undefined);
        remove.mutate(fresh.data?.revision ?? template.revision);
      }}
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
    />
  );
}

/** Says why a template a workflow sends can't be archived or deleted, and offers nothing. */
function InUseDialog({
  description,
  returnFocus,
  onClose,
}: {
  readonly description: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <SmallDialog
      open
      title={t`This template is in use`}
      description={description}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          <Trans>OK</Trans>
        </Button>
      </div>
    </SmallDialog>
  );
}

/** Moves one template, revision-checked, or many at once, to a folder or to none. */
export function MoveDialog({
  templates,
  returnFocus,
  onClose,
  onDone,
}: {
  readonly templates: readonly MessageTemplateSummary[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  /** With the bulk answer when many were moved. */
  readonly onDone: (result: BulkMessageTemplatesResult | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [only] = templates;
  const [destination, setDestination] = useState(
    templates.length === 1 && only?.folder !== undefined && only.folder !== null
      ? only.folder.id
      : 'root',
  );
  const [problem, setProblem] = useState<string>();
  const folders = useQuery({
    queryKey: ['b', business.id, 'message-template-folders'],
    queryFn: () => apiIn(business.id).request(listMessageTemplateFolders, {}),
    retry: retryFaults,
  });
  const move = useMutation({
    mutationFn: async (): Promise<BulkMessageTemplatesResult | undefined> => {
      const folderId = destination === 'root' ? null : destination;
      if (templates.length === 1 && only !== undefined) {
        await apiIn(business.id).request(moveMessageTemplate, {
          params: { id: only.id },
          body: { revision: only.revision, folderId },
        });
        return undefined;
      }
      return apiIn(business.id).request(bulkMessageTemplates, {
        body: { action: 'move', ids: templates.map((each) => each.id), folderId },
      });
    },
    onSuccess: onDone,
    onError: (error) => {
      setProblem(savingProblem(error, t`The templates could not be moved. Try again.`).form);
    },
  });
  const labels = folderLabels(folders.data?.items ?? []);
  const count = templates.length;
  return (
    <SmallDialog
      open
      title={
        count === 1
          ? t`Move to folder`
          : plural(count, { one: 'Move # template', other: 'Move # templates' })
      }
      description={t`Moving keeps each template's content and its workflow links.`}
      returnFocus={returnFocus}
      onClose={() => {
        if (!move.isPending) onClose();
      }}
    >
      {count === 1 && only !== undefined ? (
        <p className="text-sm font-medium break-words">{only.name}</p>
      ) : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setProblem(undefined);
          move.mutate();
        }}
      >
        <div className="flex flex-col gap-2 text-sm">
          <span id="move-destination">
            <Trans>Folder</Trans>
          </span>
          <Select
            aria-labelledby="move-destination"
            value={destination}
            disabled={move.isPending || !folders.isSuccess}
            onValueChange={setDestination}
          >
            <option value="root">{t`No folder`}</option>
            {(folders.data?.items ?? []).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {labels.get(folder.id) ?? folder.name}
              </option>
            ))}
          </Select>
        </div>
        {folders.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t`Folders could not be loaded.`}
          </p>
        ) : null}
        {problem === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={move.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={move.isPending || !folders.isSuccess}>
            {move.isPending ? t`Moving…` : t`Move`}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

/** Asks before archiving or deleting many, then does it in one request. */
export function BulkConfirmDialog({
  action,
  templates,
  returnFocus,
  onClose,
  onDone,
}: {
  readonly action: 'archive' | 'delete';
  readonly templates: readonly MessageTemplateSummary[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onDone: (result: BulkMessageTemplatesResult) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [problem, setProblem] = useState<string>();
  const run = useMutation({
    mutationFn: () =>
      requestBulk(
        business.id,
        action,
        templates.map((each) => each.id),
      ),
    onSuccess: onDone,
    onError: (error) => {
      setProblem(savingProblem(error, t`Nothing was changed. Try again.`).form);
    },
  });
  const count = templates.length;
  return (
    <ConfirmDialog
      open
      title={
        action === 'delete'
          ? plural(count, { one: 'Delete # template', other: 'Delete # templates' })
          : plural(count, { one: 'Archive # template', other: 'Archive # templates' })
      }
      description={
        action === 'delete'
          ? t`They move to the trash, where you can restore them. A template a published workflow sends stays where it is, and you'll see which.`
          : t`They leave the library and their names are free to use. A template a workflow sends stays where it is, and you'll see which.`
      }
      confirmLabel={action === 'delete' ? t`Move to trash` : t`Archive`}
      destructive={action === 'delete'}
      busy={run.isPending}
      problem={problem}
      returnFocus={returnFocus}
      onConfirm={() => {
        setProblem(undefined);
        run.mutate();
      }}
      onClose={() => {
        if (!run.isPending) onClose();
      }}
    />
  );
}
