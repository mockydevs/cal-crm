// The record a run is for, by its name now, leading to its own page when it has one.
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useBusiness } from './workspace';

export function RecordName({
  record,
}: {
  readonly record: { readonly id: string; readonly name: string; readonly trashed: boolean };
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const name = record.name === '' ? t`Unnamed` : record.name;
  const linkClassName = 'font-medium text-link underline-offset-2 hover:underline wrap-anywhere';
  return (
    <span className="min-w-0">
      {record.id.startsWith('con_') ? (
        <Link
          to="/b/$slug/contacts/$contactId"
          params={{ slug: business.slug, contactId: record.id }}
          className={linkClassName}
        >
          {name}
        </Link>
      ) : record.id.startsWith('com_') ? (
        <Link
          to="/b/$slug/contacts/companies/$companyId"
          params={{ slug: business.slug, companyId: record.id }}
          className={linkClassName}
        >
          {name}
        </Link>
      ) : (
        <span className="font-medium wrap-anywhere">{name}</span>
      )}
      {record.trashed ? (
        <span className="text-sm text-muted-foreground">
          {' '}
          <Trans>(in the trash)</Trans>
        </span>
      ) : null}
    </span>
  );
}
