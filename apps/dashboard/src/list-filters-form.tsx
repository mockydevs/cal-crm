// What the Filters panel holds (list-filters.tsx): a search of the fields, then the fields
// in groups, each leading to its condition, and Apply at the foot. A draft: nothing changes
// in the list until Apply.
import { Trans, useLingui } from '@lingui/react/macro';
import { fieldQueryShape, type FieldDefinition } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { lazy, Suspense, useId, useState, type ReactElement } from 'react';
import { withEmailVerificationWords } from './email-verification/words';
import type { AppliedFilters } from './list-control-types';
import { sidePanelBodyClassName, sidePanelFooterClassName } from './list-toolbar';

// The contact list's Email verification group, with its words, fetched as the panel opens.
const EmailVerificationFilter = lazy(() =>
  withEmailVerificationWords(import('./email-verification/list-filter')),
);

type Period = NonNullable<AppliedFilters['added']>;
type Operator = NonNullable<AppliedFilters['fieldOperator']>;

const groupClassName = 'flex flex-col gap-2 border-b pb-4 last:border-b-0';
const summaryClassName = 'flex min-h-11 cursor-pointer items-center text-sm font-medium lg:min-h-9';

export default function FiltersForm({
  fields,
  period,
  verification = false,
  value,
  onApply,
  onCancel,
}: {
  readonly fields: readonly FieldDefinition[];
  readonly period: boolean;
  /** Whether the list can be narrowed by email verification, as the contacts list can. */
  readonly verification?: boolean;
  readonly value: AppliedFilters;
  readonly onApply: (value: AppliedFilters) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [text, setText] = useState('');
  const [added, setAdded] = useState<Period | 'any'>(value.added ?? 'any');
  const [fieldId, setFieldId] = useState(value.fieldId ?? '');
  const [operator, setOperator] = useState<Operator>(value.fieldOperator ?? 'equals');
  const [match, setMatch] = useState(value.fieldValue ?? '');
  const [checked, setChecked] = useState(value.emailVerification);
  const field = fields.find((item) => item.id === fieldId);
  const ordered =
    field !== undefined && ['number', 'money', 'date', 'datetime'].includes(field.valueType);
  const choice = field?.valueType === 'single_choice' || field?.valueType === 'multi_choice';
  const presence = operator === 'is_set' || operator === 'is_unset';
  const wanted = text.trim().toLocaleLowerCase();
  const createdLabel = t`Created`;
  const showsPeriod = period && createdLabel.toLocaleLowerCase().includes(wanted);
  // A condition being drafted stays in view whatever the search says.
  const showsVerification =
    verification &&
    (checked !== undefined || t`Email verification`.toLocaleLowerCase().includes(wanted));
  // The chosen field stays in view whatever the search says, so its condition is not hidden.
  const offered = fields.filter(
    (item) => item.id === fieldId || item.label.toLocaleLowerCase().includes(wanted),
  );
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({
          ...(period && added !== 'any' ? { added } : {}),
          ...(verification && checked !== undefined ? { emailVerification: checked } : {}),
          ...(field === undefined
            ? {}
            : {
                fieldId: field.id,
                fieldOperator: operator,
                ...(presence ? {} : { fieldValue: match }),
              }),
        });
      }}
    >
      <div className={sidePanelBodyClassName}>
        <Input
          type="search"
          autoComplete="off"
          aria-label={t`Search field`}
          placeholder={t`Search field`}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        {showsPeriod ? (
          <details open className={groupClassName}>
            <summary className={summaryClassName}>
              <Trans>Contact information</Trans>
            </summary>
            <label className="flex flex-col gap-1.5 text-sm" htmlFor={`${id}-created`}>
              {createdLabel}
              <Select
                id={`${id}-created`}
                value={added}
                onValueChange={(next) => {
                  setAdded(next === 'week' || next === 'month' ? next : 'any');
                }}
              >
                <option value="any">{t`Any time`}</option>
                <option value="week">{t`In the last 7 days`}</option>
                <option value="month">{t`In the last 30 days`}</option>
              </Select>
            </label>
          </details>
        ) : null}
        {showsVerification ? (
          <Suspense fallback={null}>
            <EmailVerificationFilter
              value={checked}
              onChange={setChecked}
              className={groupClassName}
              summaryClassName={summaryClassName}
            />
          </Suspense>
        ) : null}
        {fields.length === 0 ? null : (
          <details open className={groupClassName}>
            <summary className={summaryClassName}>
              <Trans>Custom fields</Trans>
            </summary>
            <p className="text-sm text-muted-foreground">
              <Trans>One field condition applies at a time.</Trans>
            </p>
            <ul className="flex flex-col gap-1">
              {offered.map((item) => (
                <li key={item.id} className="flex flex-col gap-3">
                  <Button
                    variant={item.id === fieldId ? 'secondary' : 'quiet'}
                    className="justify-start text-left whitespace-normal text-body"
                    aria-pressed={item.id === fieldId}
                    onClick={() => {
                      setFieldId(item.id === fieldId ? '' : item.id);
                      setOperator('equals');
                      setMatch('');
                    }}
                  >
                    {item.label}
                  </Button>
                  {item.id !== fieldId ? null : (
                    <div className="flex flex-col gap-3 pb-2 pl-3">
                      <label className="flex flex-col gap-1.5 text-sm" htmlFor={`${id}-operator`}>
                        <Trans>Match</Trans>
                        <Select
                          id={`${id}-operator`}
                          value={operator}
                          onValueChange={(next) => {
                            const parsed = fieldQueryShape.fieldOperator.safeParse(next);
                            if (parsed.success && parsed.data !== undefined)
                              setOperator(parsed.data);
                          }}
                        >
                          <option value="equals">{t`Equals`}</option>
                          {ordered || item.valueType === 'boolean' ? null : (
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
                        <label className="flex flex-col gap-1.5 text-sm" htmlFor={`${id}-value`}>
                          <Trans>Field value</Trans>
                          {choice || item.valueType === 'boolean' ? (
                            <Select
                              id={`${id}-value`}
                              value={match}
                              required
                              onValueChange={setMatch}
                            >
                              <option value="">{t`Choose a value`}</option>
                              {choice ? (
                                item.options
                                  .filter((option) => !option.archived || option.key === match)
                                  .map((option) => (
                                    <option key={option.key} value={option.key}>
                                      {option.label}
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
                              type={item.valueType === 'date' ? 'date' : 'text'}
                              inputMode={
                                item.valueType === 'number' || item.valueType === 'money'
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
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        {!showsPeriod && !showsVerification && offered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No field matches this search.</Trans>
          </p>
        ) : null}
      </div>
      <div className={sidePanelFooterClassName}>
        <Button
          variant="quiet"
          className="mr-auto"
          onClick={() => {
            onApply({});
          }}
        >
          <Trans>Clear all</Trans>
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit">
          <Trans>Apply</Trans>
        </Button>
      </div>
    </form>
  );
}
