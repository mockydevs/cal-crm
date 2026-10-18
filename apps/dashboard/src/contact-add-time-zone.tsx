// The time zone of a contact being added (contact-add-panel.tsx): a box to type a city
// into, over the zones this server takes. Its list is the rule; the browser only describes
// them. Fetched after the panel, since the picker brings Base UI's combobox with it.
import { Trans, useLingui } from '@lingui/react/macro';
import { listTimeZones } from '@repo/contracts';
import { Combobox } from '@repo/ui/components/combobox';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';

import { apiIn } from './api';
import { zoneChoices, zoneMatches, zoneOption } from './contact-preferences-rules';
import { useBusiness } from './workspace';

export default function AddContactTimeZone({
  value,
  disabled,
  onChange,
}: {
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (timeZone: string | null) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const zones = useQuery({
    queryKey: ['time-zones'],
    queryFn: () => apiIn(business.id).request(listTimeZones, {}),
    staleTime: Infinity,
  });
  const listed = zones.data?.items;
  const [now] = useState(() => new Date());
  // A few hundred zones, described once for as long as the panel is open.
  const options = useMemo(
    () =>
      listed === undefined
        ? []
        : zoneChoices(listed, null).map((choice) => zoneOption(choice, i18n.locale, now)),
    [listed, i18n.locale, now],
  );
  if (zones.isError)
    return (
      <p role="alert" className="text-sm">
        <Trans>The time zones couldn't be loaded. You can set one on the contact.</Trans>
      </p>
    );
  return (
    <Field>
      <FieldLabel>
        <Trans>Time zone</Trans>
      </FieldLabel>
      <Combobox
        options={options}
        value={value}
        onValueChange={onChange}
        matches={zoneMatches}
        disabled={disabled || listed === undefined}
        placeholder={
          listed === undefined ? t`Loading time zones…` : t`Search by city, region or offset`
        }
        empty={t`No time zones match.`}
        clearLabel={t`Clear time zone`}
      />
    </Field>
  );
}
