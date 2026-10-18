// "Choose from Media Storage" for a site: the page editor's pictures and a site's favicon.
// The library's own picker chooses the file; what is added here is the one thing a page
// needs of it. A page is public, so its picture must have an address anyone can open and
// that does not run out: a private file is made public first, after the person is told so
// in one sentence, and the page keeps the file's public address. Fetched when first
// opened, so neither the editor nor a site's page carries the library until then.
import { Trans, useLingui } from '@lingui/react/macro';
import { updateMediaFile, type MediaFile } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { mediaKeys } from './media/data';
import MediaPicker from './media/picker';
import { ConfirmDialog, SmallDialog } from './settings-list';
import { pageAddressOf } from './site-media-rules';

export interface MediaChoiceProps {
  readonly businessId: string;
  /** What is being chosen, as the picker's title: "Choose a picture". */
  readonly title: ReactNode;
  /** Hears the file's public address, which is what a page keeps. */
  readonly onChosen: (address: string, file: MediaFile) => void;
  readonly onClose: () => void;
}

type Step =
  | { readonly at: 'library' }
  | { readonly at: 'private'; readonly file: MediaFile }
  | { readonly at: 'insecure'; readonly file: MediaFile };

export default function MediaChoice({
  businessId,
  title,
  onChosen,
  onClose,
}: MediaChoiceProps): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [step, setStep] = useState<Step>({ at: 'library' });
  const [problem, setProblem] = useState<string>();
  // Whatever opened the picker is gone from under the dialog by now: the caller puts the
  // keyboard back where it belongs when this closes.
  const noFocusRef = useRef<HTMLElement | null>(null);
  const take = (file: MediaFile): void => {
    const found = pageAddressOf(file);
    if (found.ok) onChosen(found.address, file);
    else setStep({ at: found.reason, file });
  };
  const publish = useMutation({
    mutationFn: (file: MediaFile) =>
      apiIn(businessId).request(updateMediaFile, {
        params: { id: file.id },
        body: { public: true },
      }),
    onSuccess: (saved) => {
      // The library shows the file as public the next time it is opened.
      void cache.invalidateQueries({ queryKey: mediaKeys.all(businessId) });
      take(saved);
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? error.status === 403
            ? t`You need permission to manage Media Storage to make a file public.`
            : (error.problem.errors?.[0]?.message ??
              error.problem.detail ??
              t`The file couldn't be made public. Check your connection and try again.`)
          : t`The file couldn't be made public. Check your connection and try again.`,
      );
    },
  });
  if (step.at === 'library')
    return (
      <MediaPicker
        businessId={businessId}
        title={title}
        kinds={['image']}
        onChoose={take}
        onClose={onClose}
      />
    );
  const name = step.file.name;
  if (step.at === 'insecure')
    return (
      <SmallDialog
        open
        title={<Trans>This file can't be used on a page here</Trans>}
        description={
          <Trans>
            A page takes pictures from secure addresses only (https://). This install is reached
            over plain http, so "{name}" has no such address. It works once the install has a secure
            address.
          </Trans>
        }
        returnFocus={noFocusRef}
        onClose={onClose}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            onClick={() => {
              setStep({ at: 'library' });
            }}
          >
            <Trans>Choose another</Trans>
          </Button>
        </div>
      </SmallDialog>
    );
  return (
    <ConfirmDialog
      open
      title={<Trans>Make "{name}" public?</Trans>}
      description={
        <Trans>
          A page needs a picture anyone can open. "{name}" is private now: using it makes it public,
          at an address that stays the same until you make it private again.
        </Trans>
      }
      confirmLabel={t`Make public and use it`}
      busy={publish.isPending}
      problem={problem}
      returnFocus={noFocusRef}
      onClose={() => {
        if (!publish.isPending) onClose();
      }}
      onConfirm={() => {
        setProblem(undefined);
        publish.mutate(step.file);
      }}
    />
  );
}
