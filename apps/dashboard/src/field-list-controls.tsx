import { Select } from '@repo/ui/components/select';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  fieldQueryShape,
  getFields,
  type FieldDefinition,
  type FieldListOptions,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { useBusiness } from './workspace';

const selectClassName =
  'min-h-11 w-full rounded-control border border-input bg-card px-3 text-md focus-visible:outline-2 focus-visible:outline-primary';

export function FieldListControls({
  objectKey,
  value,
  onApply,
}: {
  readonly objectKey: 'contact' | 'company' | 'deal';
  readonly value: FieldListOptions;
  readonly onApply: (value: FieldListOptions) => void;
}): ReactElement | null {
  const business = useBusiness();
  const fields = useQuery({
    queryKey: ['b', business.id, 'fields'],
    queryFn: () => apiIn(business.id).request(getFields, {}),
  });
  const options =
    fields.data?.items.filter((field) => field.objectKey === objectKey && !field.archived) ?? [];
  if (options.length === 0) return null;
  return (
    <FieldControlsForm
      key={JSON.stringify(value)}
      fields={options}
      value={value}
      onApply={onApply}
    />
  );
}
function FieldControlsForm({
  fields,
  value,
  onApply,
}: {
  readonly fields: FieldDefinition[];
  readonly value: FieldListOptions;
  readonly onApply: (value: FieldListOptions) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [fieldId, setFieldId] = useState(value.fieldId ?? '');
  const [operator, setOperator] = useState<NonNullable<FieldListOptions['fieldOperator']>>(
    value.fieldOperator ?? 'equals',
  );
  const [match, setMatch] = useState(value.fieldValue ?? '');
  const [sortField, setSortField] = useState(value.sortField ?? '');
  const [order, setOrder] = useState<'asc' | 'desc'>(value.fieldOrder ?? 'asc');
  const field = fields.find((item) => item.id === fieldId);
  const ordered =
    field !== undefined && ['number', 'money', 'date', 'datetime'].includes(field.valueType);
  const choice = field?.valueType === 'single_choice' || field?.valueType === 'multi_choice';
  const presence = operator === 'is_set' || operator === 'is_unset';
  const fieldOptions = fields.map((item) => (
    <option key={item.id} value={item.id}>
      {item.label}
    </option>
  ));
  return (
    <details
      className="rounded-control border border-border p-3"
      open={value.fieldId !== undefined || value.sortField !== undefined}
    >
      <summary className="cursor-pointer text-sm font-medium">
        <Trans>Field filters and order</Trans>
      </summary>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onApply({
            ...(fieldId === ''
              ? {}
              : { fieldId, fieldOperator: operator, ...(presence ? {} : { fieldValue: match }) }),
            ...(sortField === '' ? {} : { sortField, fieldOrder: order }),
          });
        }}
      >
        <label className="flex min-w-0 basis-44 flex-col gap-1 text-sm" htmlFor={`${id}-filter`}>
          <Trans>Filter field</Trans>
          <Select
            id={`${id}-filter`}
            className={selectClassName}
            value={fieldId}
            onValueChange={(selectedValue) => {
              setFieldId(selectedValue);
              setOperator('equals');
              setMatch('');
            }}
          >
            <option value="">{t`Any field`}</option>
            {fieldOptions}
          </Select>
        </label>
        {field === undefined ? null : (
          <>
            <label
              className="flex min-w-0 basis-40 flex-col gap-1 text-sm"
              htmlFor={`${id}-operator`}
            >
              <Trans>Match</Trans>
              <Select
                id={`${id}-operator`}
                className={selectClassName}
                value={operator}
                onValueChange={(selectedValue) => {
                  const parsed = fieldQueryShape.fieldOperator.safeParse(selectedValue);
                  if (parsed.success && parsed.data !== undefined) setOperator(parsed.data);
                }}
              >
                <option value="equals">{t`Equals`}</option>
                {ordered || field.valueType === 'boolean' ? null : (
                  <option value="contains">{t`Contains`}</option>
                )}
                {ordered ? (
                  <>
                    <option value="gt">{t`Greater than`}</option>
                    <option value="gte">{t`At least`}</option>
                    <option value="lt">{t`Less than`}</option>
                    <option value="lte">{t`At most`}</option>
                  </>
                ) : null}
                <option value="is_set">{t`Is set`}</option>
                <option value="is_unset">{t`Is unset`}</option>
              </Select>
            </label>
            {presence ? null : (
              <label
                className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-sm"
                htmlFor={`${id}-value`}
              >
                <Trans>Field value</Trans>
                {choice || field.valueType === 'boolean' ? (
                  <Select
                    id={`${id}-value`}
                    className={selectClassName}
                    value={match}
                    required
                    onValueChange={(selectedValue) => {
                      setMatch(selectedValue);
                    }}
                  >
                    <option value="">{t`Choose a value`}</option>
                    {choice ? (
                      field.options
                        .filter((item) => !item.archived || item.key === match)
                        .map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.label}
                          </option>
                        ))
                    ) : (
                      <>
                        <option value="true">{t`Yes`}</option>
                        <option value="false">{t`No`}</option>
                      </>
                    )}
                  </Select>
                ) : (
                  <Input
                    id={`${id}-value`}
                    value={match}
                    type={field.valueType === 'date' ? 'date' : 'text'}
                    inputMode={
                      field.valueType === 'number' || field.valueType === 'money'
                        ? 'decimal'
                        : 'text'
                    }
                    maxLength={1000}
                    required
                    onValueChange={setMatch}
                  />
                )}
              </label>
            )}
          </>
        )}
        <label className="flex min-w-0 basis-44 flex-col gap-1 text-sm" htmlFor={`${id}-sort`}>
          <Trans>Sort field</Trans>
          <Select
            id={`${id}-sort`}
            className={selectClassName}
            value={sortField}
            onValueChange={(selectedValue) => {
              setSortField(selectedValue);
            }}
          >
            <option value="">{t`Default order`}</option>
            {fieldOptions}
          </Select>
        </label>
        {sortField === '' ? null : (
          <label className="flex min-w-0 basis-40 flex-col gap-1 text-sm" htmlFor={`${id}-order`}>
            <Trans>Field order</Trans>
            <Select
              id={`${id}-order`}
              className={selectClassName}
              value={order}
              onValueChange={(selectedValue) => {
                setOrder(selectedValue === 'desc' ? 'desc' : 'asc');
              }}
            >
              <option value="asc">{t`Ascending`}</option>
              <option value="desc">{t`Descending`}</option>
            </Select>
          </label>
        )}
        <Button type="submit" variant="secondary">
          <Trans>Apply field filters</Trans>
        </Button>
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            onApply({});
          }}
        >
          <Trans>Clear field filters</Trans>
        </Button>
      </form>
    </details>
  );
}
