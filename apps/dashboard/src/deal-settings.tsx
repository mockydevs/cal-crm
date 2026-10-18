// The opportunity settings of a business, in a panel at the right of the Opportunities
// page: GoHighLevel's "Customize opportunity settings", with its switch, its two checkboxes
// and "Save changes". Exactly what the server keeps is here
// (packages/contracts/src/pipelines.ts): whether a contact and its opportunities may have
// different owners, which is stored and changes nothing yet, and the two rules that make a
// new owner a follower. They are saved together under the revision they were read with.
// Fetched when the panel first opens.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getOpportunitySettings,
  updateOpportunitySettings,
  type OpportunitySettings,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useId, useState, type ReactElement, type RefObject } from 'react';

import { apiIn } from './api';
import { Switch } from './automation-switch';
import { sidePanelBodyClassName, sidePanelFooterClassName } from './list-toolbar';

type Values = Pick<
  OpportunitySettings,
  'allowDifferentOwners' | 'opportunityOwnerFollowsContact' | 'contactOwnerFollowsOpportunity'
>;

const valuesOf = (settings: OpportunitySettings): Values => ({
  allowDifferentOwners: settings.allowDifferentOwners,
  opportunityOwnerFollowsContact: settings.opportunityOwnerFollowsContact,
  contactOwnerFollowsOpportunity: settings.contactOwnerFollowsOpportunity,
});

const ruleClassName =
  'flex min-h-11 min-w-0 cursor-pointer items-start gap-3 py-2 has-disabled:cursor-not-allowed lg:min-h-9';

export default function DealSettings({
  businessId,
  returnFocus,
  onClose,
  onSaved,
}: {
  readonly businessId: string;
  /** What opened the panel, which has the keyboard again when it closes. */
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const client = apiIn(businessId);
  const cache = useQueryClient();
  const queryKey = ['b', businessId, 'opportunity-settings'];
  const settings = useQuery({
    queryKey,
    queryFn: () => client.request(getOpportunitySettings, {}),
    retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
  });
  // What was changed here and not saved yet; nothing until a control is touched.
  const [draft, setDraft] = useState<Values>();
  const read = settings.data;
  const values = draft ?? (read === undefined ? undefined : valuesOf(read));
  const dirty =
    draft !== undefined &&
    read !== undefined &&
    JSON.stringify(draft) !== JSON.stringify(valuesOf(read));
  const save = useMutation({
    mutationFn: (input: Values & { readonly revision: string }) =>
      client.request(updateOpportunitySettings, { body: input }),
    onSuccess: (saved) => {
      cache.setQueryData(queryKey, saved);
      onSaved();
    },
  });
  const stale = save.error instanceof ApiError && save.error.status === 409;
  const busy = save.isPending || settings.isFetching;
  const locked = read?.canManage !== true || busy;
  const change = (next: Partial<Values>) => {
    if (values !== undefined) setDraft({ ...values, ...next });
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          finalFocus={() => returnFocus.current ?? true}
          className="fixed inset-y-0 right-0 z-60 flex w-[min(440px,100%)] flex-col bg-card text-card-foreground shadow-xl outline-none"
        >
          <div className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-3">
            <Dialog.Title className="text-base font-medium wrap-break-word">
              <Trans>Opportunity settings</Trans>
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (read === undefined || values === undefined || locked || !dirty) return;
              save.mutate({ ...values, revision: read.revision });
            }}
          >
            <div className={sidePanelBodyClassName}>
              <Dialog.Description className="text-sm text-muted-foreground">
                <Trans>Customize opportunity settings for this business.</Trans>
              </Dialog.Description>
              {settings.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  <Trans>Loading settings…</Trans>
                </p>
              ) : null}
              {settings.isError && read === undefined ? (
                <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                  <p>
                    <Trans>The opportunity settings couldn't be loaded.</Trans>
                  </p>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => {
                      void settings.refetch();
                    }}
                  >
                    <Trans>Try again</Trans>
                  </Button>
                </div>
              ) : null}
              {values === undefined || read === undefined ? null : (
                <>
                  {read.canManage ? null : (
                    <p className="text-sm text-body">
                      <Trans>You can see these settings, but you may not change them.</Trans>
                    </p>
                  )}
                  <div className="flex min-w-0 items-start gap-3 rounded-lg border border-border p-3">
                    <Switch
                      checked={values.allowDifferentOwners}
                      disabled={locked}
                      aria-labelledby={`${id}owners`}
                      aria-describedby={`${id}owners-note`}
                      onChange={(allowDifferentOwners) => {
                        change({ allowDifferentOwners });
                      }}
                    />
                    <div className="flex min-w-0 flex-col gap-0.5 pt-3 lg:pt-2">
                      <p id={`${id}owners`} className="text-sm font-medium text-foreground">
                        <Trans>Allow different owners for primary contacts and opportunities</Trans>
                      </p>
                      <p id={`${id}owners-note`} className="text-sm text-muted-foreground">
                        <Trans>
                          Your choice is kept. It doesn't change how owners are set yet: a contact
                          and its opportunities can already have different owners.
                        </Trans>
                      </p>
                    </div>
                  </div>
                  <fieldset className="flex min-w-0 flex-col rounded-lg border border-border px-3 py-1">
                    <legend className="px-1 text-sm font-medium text-foreground">
                      <Trans>Followers</Trans>
                    </legend>
                    <label className={ruleClassName}>
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={values.opportunityOwnerFollowsContact}
                        disabled={locked}
                        onChange={(event) => {
                          change({ opportunityOwnerFollowsContact: event.target.checked });
                        }}
                      />
                      <span className="min-w-0 text-sm text-foreground">
                        {t`When an opportunity's owner changes, make the new owner a follower of its primary contact`}
                      </span>
                    </label>
                    <label className={ruleClassName}>
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={values.contactOwnerFollowsOpportunity}
                        disabled={locked}
                        onChange={(event) => {
                          change({ contactOwnerFollowsOpportunity: event.target.checked });
                        }}
                      />
                      <span className="min-w-0 text-sm text-foreground">
                        {t`When a contact's owner changes, make the new owner a follower of the open opportunities the contact is the primary contact of`}
                      </span>
                    </label>
                  </fieldset>
                  <p className="text-sm text-muted-foreground">
                    <Trans>
                      The rules apply to owner changes from now on. Nobody is made a follower for
                      changes made before.
                    </Trans>
                  </p>
                </>
              )}
              {save.isError ? (
                <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                  <p className="text-destructive">
                    {stale ? (
                      <Trans>
                        These settings changed since you opened them. Reload them, then make your
                        change again.
                      </Trans>
                    ) : save.error instanceof ApiError ? (
                      save.error.message
                    ) : (
                      <Trans>We couldn't save the settings. Try again.</Trans>
                    )}
                  </p>
                  {stale ? (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy}
                      onClick={() => {
                        setDraft(undefined);
                        save.reset();
                        void settings.refetch();
                      }}
                    >
                      <Trans>Reload settings</Trans>
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className={sidePanelFooterClassName}>
              <p role="status" className="mr-auto text-sm text-muted-foreground empty:sr-only">
                {save.isPending ? t`Saving…` : ''}
              </p>
              <Button variant="secondary" disabled={save.isPending} onClick={onClose}>
                {read?.canManage === true ? <Trans>Cancel</Trans> : <Trans>Close</Trans>}
              </Button>
              {read?.canManage === true ? (
                <Button type="submit" disabled={locked || !dirty}>
                  <Trans>Save changes</Trans>
                </Button>
              ) : null}
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
