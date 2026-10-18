// "Filters": what narrows a list, chosen in a panel at the right and applied together. It
// offers only what the server can apply: when a contact was added, one condition on one
// custom field, and, on the contact list, email verification. The form inside the panel is fetched when the panel first opens.
import { Trans } from '@lingui/react/macro';
import { getFields, type FieldDefinition } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ListFilter } from 'lucide-react';
import { lazy, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { PanelContent, SidePanel } from './list-toolbar';
import { useBusiness } from './workspace';
import type { AppliedFilters } from './list-control-types';

export type { AppliedFilters } from './list-control-types';

const FiltersForm = lazy(() => import('./list-filters-form'));

/** The fields of one kind of record that can be filtered and sorted on. */
export function useListFields(
  objectKey: 'contact' | 'company' | 'deal',
): UseQueryResult<FieldDefinition[]> {
  const business = useBusiness();
  return useQuery({
    queryKey: ['b', business.id, 'fields'],
    queryFn: () => apiIn(business.id).request(getFields, {}),
    select: (fields) =>
      fields.items.filter((field) => field.objectKey === objectKey && !field.archived),
  });
}

/** The filters form as a step of another panel, such as the one that adds a smart list. */
export function FiltersStep(props: {
  readonly fields: readonly FieldDefinition[];
  readonly period: boolean;
  readonly verification?: boolean;
  readonly value: AppliedFilters;
  readonly onApply: (value: AppliedFilters) => void;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <PanelContent>
      <FiltersForm {...props} />
    </PanelContent>
  );
}

export function ListFilters({
  fields,
  period,
  verification = false,
  value,
  count,
  onApply,
}: {
  readonly fields: readonly FieldDefinition[];
  /** Whether the list can be narrowed to what was added lately, as the contacts list can. */
  readonly period: boolean;
  /** Whether it can be narrowed by email verification, as the contacts list can. */
  readonly verification?: boolean;
  readonly value: AppliedFilters;
  /** How many filters narrow the list now. */
  readonly count: number;
  readonly onApply: (value: AppliedFilters) => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!period && fields.length === 0) return null;
  const close = () => {
    setOpen(false);
  };
  return (
    <SidePanel
      open={open}
      onOpenChange={setOpen}
      title={<Trans>Filters</Trans>}
      trigger={
        <Button
          variant="secondary"
          className={`rounded-full ${count > 0 ? 'border-primary bg-accent text-link' : ''}`}
        >
          <ListFilter aria-hidden className="size-4" strokeWidth={1.8} />
          {count > 0 ? <Trans>Filters ({count})</Trans> : <Trans>Filters</Trans>}
        </Button>
      }
    >
      <PanelContent>
        <FiltersForm
          fields={fields}
          period={period}
          verification={verification}
          value={value}
          onCancel={close}
          onApply={(next) => {
            close();
            onApply(next);
          }}
        />
      </PanelContent>
    </SidePanel>
  );
}
