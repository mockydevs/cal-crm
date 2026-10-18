// The media picker: the business's media library in a dialog, to choose one file from or to
// upload one into. The business logo box uses it; the form editor, the page editor and
// message templates are meant to.
import { Trans } from '@lingui/react/macro';
import type { MediaFile, MediaKind } from '@repo/contracts';
import type { ReactElement, ReactNode } from 'react';
import { AutomationDialog } from '../automation-dialog';
import { MediaLibrary } from './library';

export interface MediaPickerProps {
  readonly businessId: string;
  readonly title: ReactNode;
  /** Only these groups of types: pictures alone for a logo. */
  readonly kinds?: readonly MediaKind[];
  readonly onChoose: (file: MediaFile) => void;
  readonly onClose: () => void;
}

export default function MediaPicker({
  businessId,
  title,
  kinds,
  onChoose,
  onClose,
}: MediaPickerProps): ReactElement {
  return (
    <AutomationDialog
      open
      wide
      title={title}
      description={<Trans>Choose a file from Media Storage, or upload one into it.</Trans>}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MediaLibrary
        businessId={businessId}
        mode="pick"
        {...(kinds === undefined ? {} : { kinds })}
        onChoose={onChoose}
        frame={({ actions, body }) => (
          <div className="flex min-w-0 flex-col gap-3">
            {actions}
            {body}
          </div>
        )}
      />
    </AutomationDialog>
  );
}
