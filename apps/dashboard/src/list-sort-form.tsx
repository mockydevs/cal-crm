// What the Sort popover holds (list-sort.tsx): what the list is ordered by, the direction
// when a field orders it, and Clear. Each choice applies at once.
import { Trans, useLingui } from '@lingui/react/macro';
import type { FieldDefinition } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';
import type { ReactElement } from 'react';
import type { BuiltInOrder, ListOrder } from './list-control-types';

const FIELD = 'field:';

export default function SortForm({
  labelledBy,
  orders,
  fields,
  value,
  onChange,
}: {
  /** The popover's title, which names the choice too. */
  readonly labelledBy: string;
  /** The built-in orders, the default first. */
  readonly orders: readonly [BuiltInOrder<string>, ...BuiltInOrder<string>[]];
  readonly fields: readonly FieldDefinition[];
  readonly value: ListOrder<string>;
  readonly onChange: (value: ListOrder<string>) => void;
}): ReactElement {
  const { t } = useLingui();
  const initial = orders[0].key;
  const isDefault = 'by' in value && value.by === initial;
  const chosen = 'by' in value ? value.by : `${FIELD}${value.field}`;
  // A field named in the address that is no longer there still shows as what is chosen.
  const missing = 'field' in value && !fields.some((field) => field.id === value.field);
  return (
    <>
      <Select
        aria-labelledby={labelledBy}
        value={chosen}
        onValueChange={(next) => {
          onChange(
            next.startsWith(FIELD)
              ? { field: next.slice(FIELD.length), direction: 'asc' }
              : { by: next },
          );
        }}
      >
        {orders.map((order) => (
          <option key={order.key} value={order.key}>
            {order.label}
          </option>
        ))}
        {missing ? <option value={chosen}>{t`Unavailable field`}</option> : null}
        {fields.map((field) => (
          <option key={field.id} value={`${FIELD}${field.id}`}>
            {field.label}
          </option>
        ))}
      </Select>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {'field' in value ? (
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              onChange({
                field: value.field,
                direction: value.direction === 'asc' ? 'desc' : 'asc',
              });
            }}
          >
            {value.direction === 'asc' ? (
              <>
                <ArrowUpNarrowWide aria-hidden className="size-4" strokeWidth={1.8} />
                <Trans>Ascending</Trans>
              </>
            ) : (
              <>
                <ArrowDownWideNarrow aria-hidden className="size-4" strokeWidth={1.8} />
                <Trans>Descending</Trans>
              </>
            )}
          </Button>
        ) : (
          <span />
        )}
        <Button
          variant="quiet"
          size="small"
          disabled={isDefault}
          onClick={() => {
            onChange({ by: initial });
          }}
        >
          <Trans>Clear</Trans>
        </Button>
      </div>
    </>
  );
}
