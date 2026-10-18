// "Sort": the order of a list, chosen in a small popover. The built-in orders are the ones
// the server has, each in its one direction; a custom field sorts either way, so the
// direction button shows only for a field. What is inside the popover is fetched when it
// first opens.
import { Trans, useLingui } from '@lingui/react/macro';
import type { FieldDefinition } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@repo/ui/components/popover';
import { ArrowUpDown } from 'lucide-react';
import { lazy, useId, type ReactElement } from 'react';
import { PanelContent, sidePanelBodyClassName, sidePanelFooterClassName } from './list-toolbar';
import type { BuiltInOrder, ListOrder } from './list-control-types';

export type { BuiltInOrder, ListOrder } from './list-control-types';

const SortForm = lazy(() => import('./list-sort-form'));

/** What the form chose, as one of this list's own orders by its key, or a field. */
function orderOf<Key extends string>(
  orders: readonly BuiltInOrder<Key>[],
  next: ListOrder<string>,
): ListOrder<Key> | undefined {
  if ('field' in next) return next;
  const order = orders.find((each) => each.key === next.by);
  return order === undefined ? undefined : { by: order.key };
}

/** The sort form as a step of another panel: each choice applies at once, as in the popover. */
export function SortStep<Key extends string>({
  orders,
  fields,
  value,
  onChange,
  onDone,
}: {
  readonly orders: readonly [BuiltInOrder<Key>, ...BuiltInOrder<Key>[]];
  readonly fields: readonly FieldDefinition[];
  readonly value: ListOrder<Key>;
  readonly onChange: (value: ListOrder<Key>) => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  return (
    <>
      <div className={sidePanelBodyClassName}>
        <p id={id} className="text-sm text-muted-foreground">
          {t`What the list is ordered by. Each choice applies at once.`}
        </p>
        <PanelContent>
          <SortForm
            labelledBy={id}
            orders={orders}
            fields={fields}
            value={value}
            onChange={(next) => {
              const order = orderOf(orders, next);
              if (order !== undefined) onChange(order);
            }}
          />
        </PanelContent>
      </div>
      <div className={sidePanelFooterClassName}>
        <Button onClick={onDone}>
          <Trans>Done</Trans>
        </Button>
      </div>
    </>
  );
}

export function ListSort<Key extends string>({
  orders,
  fields,
  value,
  onChange,
}: {
  /** The built-in orders, the default first. */
  readonly orders: readonly [BuiltInOrder<Key>, ...BuiltInOrder<Key>[]];
  readonly fields: readonly FieldDefinition[];
  readonly value: ListOrder<Key>;
  readonly onChange: (value: ListOrder<Key>) => void;
}): ReactElement {
  const id = useId();
  const initial = orders[0].key;
  const isDefault = 'by' in value && value.by === initial;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="secondary"
            className={`rounded-full ${isDefault ? '' : 'border-primary bg-accent text-link'}`}
          />
        }
      >
        <ArrowUpDown aria-hidden className="size-4" strokeWidth={1.8} />
        {isDefault ? <Trans>Sort</Trans> : <Trans>Sort (1)</Trans>}
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <PopoverTitle id={id}>
          <Trans>Sort by</Trans>
        </PopoverTitle>
        <PanelContent>
          <SortForm
            labelledBy={id}
            orders={orders}
            fields={fields}
            value={value}
            onChange={(next) => {
              const order = orderOf(orders, next);
              if (order !== undefined) onChange(order);
            }}
          />
        </PanelContent>
      </PopoverContent>
    </Popover>
  );
}
