// Settings → Business Profile → "Contact Deduplication Preferences", as GoHighLevel names
// it: the primary match field (Email or Phone) and an optional secondary one, the order an
// existing contact is found in when details arrive. There is no "Allow Duplicate Contact"
// switch: an email address or a phone number always belongs to one contact here.
// https://help.gohighlevel.com/support/solutions/articles/48001181714
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getDuplicateSettings,
  updateDuplicateSettings,
  type DuplicateMatchField,
  type DuplicateSettings,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';

import { apiIn } from '../api';
import { ListProblem } from '../settings-list';
import { useBusiness } from '../workspace';

const NONE = 'none';
const settingsKey = (businessId: string) => ['b', businessId, 'duplicate-settings'] as const;
const other = (field: DuplicateMatchField): DuplicateMatchField =>
  field === 'email' ? 'phone' : 'email';

function PreferencesForm({
  saved,
  onSaved,
}: {
  readonly saved: DuplicateSettings;
  /** What to say once saved, or nothing while a save is under way. */
  readonly onSaved: (notice: string | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const queryClient = useQueryClient();
  const primaryId = useId();
  const secondaryId = useId();
  const secondaryHelpId = useId();
  const [primary, setPrimary] = useState<DuplicateMatchField>(saved.primary);
  const [secondary, setSecondary] = useState<DuplicateMatchField | null>(saved.secondary);
  const names: Readonly<Record<DuplicateMatchField, string>> = { email: t`Email`, phone: t`Phone` };
  const save = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(updateDuplicateSettings, {
        body: { primary, secondary, revision: saved.revision },
      }),
    onSuccess: (next) => {
      onSaved(t`Contact deduplication preferences saved.`);
      queryClient.setQueryData(settingsKey(business.id), next);
    },
  });
  const changed = primary !== saved.primary || secondary !== saved.secondary;
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSaved(undefined);
        save.mutate();
      }}
    >
      <fieldset
        disabled={!saved.canManage || save.isPending}
        className="grid min-w-0 gap-4 sm:grid-cols-2"
      >
        <legend className="sr-only">
          <Trans>Match fields</Trans>
        </legend>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id={primaryId} className="text-sm font-medium">
            <Trans>Primary field</Trans>
          </span>
          <Select
            aria-labelledby={primaryId}
            value={primary}
            onValueChange={(next) => {
              const field: DuplicateMatchField = next === 'phone' ? 'phone' : 'email';
              setPrimary(field);
              if (secondary === field) setSecondary(null);
            }}
          >
            <option value="email">{names.email}</option>
            <option value="phone">{names.phone}</option>
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id={secondaryId} className="text-sm font-medium">
            <Trans>Secondary field</Trans>
          </span>
          <Select
            aria-labelledby={secondaryId}
            aria-describedby={secondaryHelpId}
            value={secondary ?? NONE}
            onValueChange={(next) => {
              setSecondary(next === NONE ? null : other(primary));
            }}
          >
            <option value={NONE}>{t`None`}</option>
            <option value={other(primary)}>{names[other(primary)]}</option>
          </Select>
          <p id={secondaryHelpId} className="text-sm text-muted-foreground">
            <Trans>
              Tried when the primary field is given and finds nobody. With none, the other field is
              used only when the primary one is not given.
            </Trans>
          </p>
        </div>
      </fieldset>
      {save.error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {save.error instanceof ApiError && save.error.problem.status === 409
            ? t`Someone changed these preferences meanwhile. Reload the page to see theirs.`
            : save.error instanceof ApiError
              ? save.error.message
              : t`The preferences weren't saved. Check your connection and try again.`}
        </p>
      )}
      {saved.canManage ? (
        <Button type="submit" className="self-start" disabled={save.isPending || !changed}>
          {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save preferences</Trans>}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>Only someone who may change the business profile can change these.</Trans>
        </p>
      )}
    </form>
  );
}

export default function DuplicatePreferences(): ReactElement {
  const business = useBusiness();
  const headingId = useId();
  const [notice, setNotice] = useState<string>();
  const current = useQuery({
    queryKey: settingsKey(business.id),
    queryFn: () => apiIn(business.id).request(getDuplicateSettings, {}),
  });
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          <Trans>Contact Deduplication Preferences</Trans>
        </h2>
        <p className="text-sm text-muted-foreground">
          <Trans>
            When a form, a booking or an import brings in details, the contact that already holds
            them is updated instead of a new one being made. These fields are looked at in this
            order, and the duplicate lookup of the API follows it too. An email address or a phone
            number always belongs to one contact.
          </Trans>
        </p>
      </div>
      {current.isError ? (
        <ListProblem
          onRetry={() => {
            void current.refetch();
          }}
        >
          <Trans>We couldn't load the preferences.</Trans>
        </ListProblem>
      ) : null}
      {current.data === undefined ? null : (
        <PreferencesForm saved={current.data} onSaved={setNotice} />
      )}
      {notice === undefined ? null : (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
