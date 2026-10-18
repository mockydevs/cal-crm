// The folders campaigns are filed in, in the manner of the template folders: the dialog that
// makes a folder, renames or moves it and removes it (the list's left panel opens it), and
// the dialog that moves campaigns into one. Removing a folder deletes nothing: what it held
// moves to its parent.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createEmailCampaignFolder,
  moveEmailCampaign,
  removeEmailCampaignFolder,
  updateEmailCampaignFolder,
  type EmailCampaignFolder,
  type EmailCampaignSummary,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { FolderInput } from 'lucide-react';
import { useId, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from '../api';
import { ConfirmDialog, Select, SmallDialog } from './controls';
import { saidBy, useCampaignFolders } from './data';
import { folderOptions, labelClassName, problemClassName } from './parts';
import { folderDestinations } from './rules';

export type FolderEdit =
  | { readonly kind: 'create'; readonly parentId: string | null }
  | { readonly kind: 'update' | 'remove'; readonly folder: EmailCampaignFolder };

export function FolderEditor({
  businessId,
  edit,
  folders,
  returnFocus,
  onClose,
  onSaved,
}: {
  readonly businessId: string;
  readonly edit: FolderEdit;
  readonly folders: readonly EmailCampaignFolder[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  /** With the folder to show next: the saved one, or a removed one's parent. */
  readonly onSaved: (folder: string | null) => void;
}): ReactElement {
  const { t } = useLingui();
  const nameId = useId();
  const parentId = useId();
  const [name, setName] = useState(edit.kind === 'create' ? '' : edit.folder.name);
  const [parent, setParent] = useState(
    edit.kind === 'create' ? edit.parentId : edit.folder.parentId,
  );
  const [problem, setProblem] = useState<string>();
  const folderName = edit.kind === 'create' ? '' : edit.folder.name;
  const save = useMutation({
    mutationFn: async () => {
      const api = apiIn(businessId);
      if (edit.kind === 'remove') {
        await api.request(removeEmailCampaignFolder, {
          params: { id: edit.folder.id },
          body: { revision: edit.folder.revision },
        });
        return edit.folder.parentId;
      }
      const saved =
        edit.kind === 'create'
          ? await api.request(createEmailCampaignFolder, {
              body: { name: name.trim(), parentId: parent },
            })
          : await api.request(updateEmailCampaignFolder, {
              params: { id: edit.folder.id },
              body: { revision: edit.folder.revision, name: name.trim(), parentId: parent },
            });
      return saved.id;
    },
    onSuccess: onSaved,
    onError: (error) => {
      setProblem(saidBy(error, t`The folder wasn't saved. Check your connection and try again.`));
    },
  });
  if (edit.kind === 'remove')
    return (
      <ConfirmDialog
        open
        title={t`Delete folder`}
        description={t`Delete ${folderName}? Its campaigns and the folders inside it move to its parent. No campaign is deleted.`}
        confirmLabel={t`Delete folder`}
        destructive
        busy={save.isPending}
        problem={problem}
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
      title={edit.kind === 'create' ? t`New folder` : t`Rename or move folder`}
      returnFocus={returnFocus}
      onClose={() => {
        if (!save.isPending) onClose();
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === '') {
            setProblem(t`Give the folder a name.`);
            return;
          }
          setProblem(undefined);
          save.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className={labelClassName}>
            <Trans>Folder name</Trans>
          </label>
          <Input
            id={nameId}
            value={name}
            maxLength={120}
            autoComplete="off"
            disabled={save.isPending}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={parentId} className={labelClassName}>
            <Trans>Inside</Trans>
          </label>
          <Select
            id={parentId}
            value={parent ?? 'root'}
            disabled={save.isPending}
            onValueChange={(next) => {
              setParent(next === 'root' ? null : next);
            }}
          >
            <option value="root">{t`No folder (top level)`}</option>
            {folderOptions(
              folderDestinations(folders, edit.kind === 'create' ? undefined : edit.folder.id),
            ).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.label}
              </option>
            ))}
          </Select>
        </div>
        {problem === undefined ? null : (
          <p role="alert" className={problemClassName}>
            {problem}
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
      </form>
    </SmallDialog>
  );
}

/** Moves campaigns to a folder, or out of them all, one request each. Any status may be moved. */
export function MoveCampaignDialog({
  businessId,
  campaigns,
  returnFocus,
  onClose,
  onMoved,
}: {
  readonly businessId: string;
  readonly campaigns: readonly Pick<EmailCampaignSummary, 'id' | 'name' | 'folderId'>[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  /** With how many moved, and the names of any that could not be. */
  readonly onMoved: (outcome: {
    readonly moved: number;
    readonly failed: readonly string[];
  }) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [only] = campaigns;
  const [destination, setDestination] = useState(
    campaigns.length === 1 ? (only?.folderId ?? 'root') : 'root',
  );
  const [problem, setProblem] = useState<string>();
  const folders = useCampaignFolders(businessId);
  const move = useMutation({
    mutationFn: async () => {
      const folderId = destination === 'root' ? null : destination;
      const results = await Promise.allSettled(
        campaigns.map((campaign) =>
          apiIn(businessId).request(moveEmailCampaign, {
            params: { id: campaign.id },
            body: { folderId },
          }),
        ),
      );
      const failed = campaigns.filter((_, index) => results[index]?.status === 'rejected');
      // When none moved, the first refusal is what the dialog says.
      const refused = results.find((result) => result.status === 'rejected');
      if (failed.length === campaigns.length && refused !== undefined) throw refused.reason;
      return { moved: campaigns.length - failed.length, failed: failed.map((each) => each.name) };
    },
    onSuccess: onMoved,
    onError: (error) => {
      setProblem(saidBy(error, t`The campaign wasn't moved. Check your connection and try again.`));
    },
  });
  const count = campaigns.length;
  return (
    <SmallDialog
      open
      title={count === 1 ? t`Move to folder` : t`Move ${count} campaigns`}
      description={count === 1 ? only?.name : undefined}
      returnFocus={returnFocus}
      onClose={() => {
        if (!move.isPending) onClose();
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setProblem(undefined);
          move.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className={labelClassName}>
            <Trans>Folder</Trans>
          </label>
          <Select
            id={id}
            value={destination}
            disabled={move.isPending || !folders.isSuccess}
            onValueChange={setDestination}
          >
            <option value="root">{t`Not in a folder`}</option>
            {folderOptions(folders.data?.items ?? []).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.label}
              </option>
            ))}
          </Select>
        </div>
        {folders.isSuccess && folders.data.items.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <FolderInput aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
            <Trans>
              There are no folders yet. Make one with the folder button beside the list.
            </Trans>
          </p>
        ) : null}
        {problem === undefined ? null : (
          <p role="alert" className={problemClassName}>
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
