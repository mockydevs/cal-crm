import { Trans, useLingui } from '@lingui/react/macro';
import {
  createMessageTemplateFolder,
  removeMessageTemplateFolder,
  updateMessageTemplateFolder,
  type MessageTemplateFolder,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactElement, type RefObject } from 'react';

import { apiIn } from './api';
import { noRejection } from './problems';
import { ConfirmDialog, savingProblem, SmallDialog } from './settings-list';
import { folderDestinations, folderLabels } from './template-folder-rules';
import { useBusiness } from './workspace';

export type FolderEdit =
  | { readonly kind: 'create'; readonly parentId: string | null }
  | { readonly kind: 'update' | 'remove'; readonly folder: MessageTemplateFolder };

export function TemplateFolderEditor({
  edit,
  folders,
  returnFocus,
  onClose,
  onSaved,
}: {
  readonly edit: FolderEdit;
  readonly folders: readonly MessageTemplateFolder[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSaved: (folder: string | null) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const labels = folderLabels(folders);
  const [name, setName] = useState(edit.kind === 'create' ? '' : edit.folder.name);
  const [parent, setParent] = useState(
    edit.kind === 'create' ? edit.parentId : edit.folder.parentId,
  );
  const [problem, setProblem] = useState(noRejection);
  const folderName = edit.kind === 'create' ? '' : edit.folder.name;
  const save = useMutation({
    mutationFn: async () => {
      const api = apiIn(business.id);
      if (edit.kind === 'remove') {
        await api.request(removeMessageTemplateFolder, {
          params: { id: edit.folder.id },
          body: { revision: edit.folder.revision },
        });
        return edit.folder.parentId;
      }
      const saved =
        edit.kind === 'create'
          ? await api.request(createMessageTemplateFolder, {
              body: { name: name.trim(), parentId: parent },
            })
          : await api.request(updateMessageTemplateFolder, {
              params: { id: edit.folder.id },
              body: { revision: edit.folder.revision, name: name.trim(), parentId: parent },
            });
      return saved.id;
    },
    onSuccess: onSaved,
    onError: (error) => {
      setProblem(savingProblem(error, t`The folder could not be saved. Try again.`));
    },
  });
  if (edit.kind === 'remove')
    return (
      <ConfirmDialog
        open
        title={t`Delete folder`}
        description={t`Delete ${folderName}? Its templates and child folders move to its parent. No templates are deleted.`}
        confirmLabel={t`Delete folder`}
        destructive
        busy={save.isPending}
        problem={problem.form}
        returnFocus={returnFocus}
        onConfirm={() => {
          save.mutate();
        }}
        onClose={() => {
          if (!save.isPending) onClose();
        }}
      />
    );
  return (
    <SmallDialog
      open
      title={edit.kind === 'create' ? t`Create folder` : t`Rename or move folder`}
      returnFocus={returnFocus}
      onClose={() => {
        if (!save.isPending) onClose();
      }}
    >
      <Form
        errors={problem.fields}
        onFormSubmit={() => {
          setProblem(noRejection);
          save.mutate();
        }}
      >
        <Field name="name">
          <FieldLabel>
            <Trans>Folder name</Trans>
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
        <label className="flex flex-col gap-2 text-sm">
          <Trans>Parent folder</Trans>
          <select
            name="parentId"
            value={parent ?? 'root'}
            disabled={save.isPending}
            className="min-h-10 rounded-control border border-border bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onChange={(event) => {
              setParent(event.target.value === 'root' ? null : event.target.value);
            }}
          >
            <option value="root">{t`Home`}</option>
            {folderDestinations(folders, edit.kind === 'create' ? undefined : edit.folder.id).map(
              (folder) => (
                <option key={folder.id} value={folder.id}>
                  {labels.get(folder.id)}
                </option>
              ),
            )}
          </select>
        </label>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={save.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t`Saving…` : t`Save folder`}
          </Button>
        </div>
      </Form>
    </SmallDialog>
  );
}
