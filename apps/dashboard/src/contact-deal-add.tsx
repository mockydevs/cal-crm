// "Add opportunity" from a contact: the opportunity dialog of the Opportunities page,
// opened on a new one with the contact as its primary contact. It starts in the first
// pipeline in use, and the dialog can choose another. Fetched when the button is first
// pressed, so the contact page does not carry the dialog.
import { Trans } from '@lingui/react/macro';
import { getPipelines, type Deal } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement, RefObject } from 'react';

import { apiIn } from './api';
import type { PickedContact } from './deal-contact-search';
import { DealDialog } from './deal-dialog';
import { NEW_DEAL } from './deal-search';

export default function ContactDealAdd({
  businessId,
  contact,
  returnFocus,
  onClose,
  onSaved,
}: {
  readonly businessId: string;
  /** The contact the opportunity is added from: its primary contact. */
  readonly contact: PickedContact;
  /** The button that opened this, which has the keyboard again afterwards. */
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSaved: (deal: Deal) => void;
}): ReactElement {
  const pipelines = useQuery({
    queryKey: ['pipelines', businessId],
    queryFn: () => apiIn(businessId).request(getPipelines, {}),
  });
  if (pipelines.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading pipelines…</Trans>
      </p>
    );
  // A pipeline can take an opportunity when it is in use and has a stage that is.
  const pipeline = pipelines.data?.items.find(
    (each) => !each.archived && each.stages.some((stage) => !stage.archived),
  );
  if (pipelines.data === undefined || pipeline === undefined)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>
          {pipelines.isError ? (
            <Trans>The pipelines couldn't be loaded.</Trans>
          ) : (
            <Trans>
              An opportunity needs a pipeline with a stage, and this business has none in use.
              Create one under Opportunities, on the Pipelines tab.
            </Trans>
          )}
        </p>
        {pipelines.isError ? (
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void pipelines.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        ) : null}
      </div>
    );
  return (
    <DealDialog
      opened={{
        key: NEW_DEAL,
        deal: undefined,
        pipeline,
        pipelines: pipelines.data.items,
        contact,
      }}
      businessId={businessId}
      section="details"
      // A new opportunity has only its details, and is not in the trash.
      onSection={() => undefined}
      onTrashed={() => undefined}
      onClose={onClose}
      onSaved={onSaved}
      fallbackFocus={() => returnFocus.current}
    />
  );
}
