// A file upload field on a record: its files, each opened through a short-lived link and
// deleted after asking, and an upload button while the field has room. Its own chunk,
// fetched when a record shows such a field.
import { Trans, useLingui } from '@lingui/react/macro';
import { listRecordFiles, type RecordField } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { apiIn } from './api';
import {
  DeleteRecordFile,
  FileName,
  problemOf,
  recordFilesKey,
  UploadButton,
  useUploadRecordFiles,
} from './contact-files-parts';
import { formatNames } from './custom-field-words';
import { useBusiness } from './workspace';

export default function RecordFieldFiles({
  recordId,
  field,
  editable,
}: {
  readonly recordId: string;
  readonly field: RecordField;
  /** Whether this person may change the field's value here. */
  readonly editable: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const fieldId = field.definition.id;
  const files = useQuery({
    queryKey: [...recordFilesKey(business.id, recordId), 'field', fieldId],
    queryFn: () =>
      apiIn(business.id).request(listRecordFiles, {
        params: { id: recordId },
        query: { folder: 'internal', field: fieldId, limit: 100 },
      }),
  });
  const upload = useUploadRecordFiles(recordId, fieldId);
  const options = field.definition.files;
  const limit = options?.limit ?? 1;
  const formats = options?.formats ?? [];
  const items = [...(files.data?.items ?? [])].reverse();
  // What the field holds is what its list shows, which refreshes on every change.
  const room = limit - items.length;
  // Whoever may upload, here and now: the role, and a record out of the trash.
  const mayUpload = editable && files.data?.canUpload === true;
  const label = field.definition.label;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {files.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemOf(files.error, t`The files couldn't be loaded.`)}
        </p>
      ) : null}
      {items.length === 0 && !files.isPending ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No file yet.</Trans>
        </p>
      ) : (
        <ul aria-label={t`Files in ${label}`} className="flex min-w-0 flex-col gap-1">
          {items.map((file) => (
            <li key={file.id} className="flex min-w-0 items-start gap-1">
              <FileName recordId={recordId} file={file} />
              {editable && file.removable ? (
                <DeleteRecordFile recordId={recordId} file={file} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {mayUpload ? (
        <div className="flex flex-col items-start gap-1">
          <UploadButton
            formats={formats}
            multiple={room > 1}
            disabled={room <= 0}
            busy={upload.isPending}
            label={limit === 1 ? t`Upload a file to ${label}` : t`Upload files to ${label}`}
            onChosen={(chosen) => {
              upload.mutate(chosen);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {room <= 0
              ? t`This field is full. Delete a file to upload another.`
              : formats.map((format) => formatNames[format]).join(', ')}
          </p>
          {(upload.data ?? []).map((refused, index) => (
            <p
              key={`${String(index)}:${refused}`}
              role="alert"
              className="text-sm text-destructive"
            >
              {refused}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
