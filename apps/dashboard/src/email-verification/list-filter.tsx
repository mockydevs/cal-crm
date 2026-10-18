// The Filters panel's "Email verification" on the contact list: is any of, or none of, the
// results ticked (worded as an email row's badge words them), or empty (no email address),
// or not. Fetched with its words when the panel first opens. A draft, like the rest of the
// panel: nothing changes in the list until Apply.
import { Trans, useLingui } from '@lingui/react/macro';
import { Select } from '@repo/ui/components/select';
import { useId, type ReactElement } from 'react';
import {
  verificationStates,
  type VerificationCondition,
  type VerificationOperator,
} from './list-filter-rules';
import { useVerificationWords } from './list-words';

const operators: readonly VerificationOperator[] = [
  'any_of',
  'none_of',
  'is_empty',
  'is_not_empty',
];

export default function EmailVerificationFilter({
  value,
  onChange,
  className,
  summaryClassName,
}: {
  /** The condition being drafted; undefined, none. */
  readonly value: VerificationCondition | undefined;
  readonly onChange: (next: VerificationCondition | undefined) => void;
  /** The panel's own group and heading styles, so this group looks like the others. */
  readonly className: string;
  readonly summaryClassName: string;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const words = useVerificationWords();
  const operatorWords: Readonly<Record<VerificationOperator, string>> = {
    any_of: t`Is any of`,
    none_of: t`Is none of`,
    is_empty: t`Is empty (no email address)`,
    is_not_empty: t`Is not empty`,
  };
  const operator = value?.operator ?? 'any_of';
  const values = value?.values ?? [];
  const takesValues = operator === 'any_of' || operator === 'none_of';
  return (
    <details open className={className}>
      <summary className={summaryClassName}>
        <Trans>Email verification</Trans>
      </summary>
      <label className="flex flex-col gap-1.5 text-sm" htmlFor={`${id}-operator`}>
        <Trans>Email verification is</Trans>
        <Select
          id={`${id}-operator`}
          value={operator}
          onValueChange={(next) => {
            const chosen = operators.find((each) => each === next);
            if (chosen !== undefined) onChange({ operator: chosen, values });
          }}
        >
          {operators.map((each) => (
            <option key={each} value={each}>
              {operatorWords[each]}
            </option>
          ))}
        </Select>
      </label>
      {takesValues ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">
            <Trans>Results</Trans>
          </legend>
          {verificationStates.map((state) => (
            <label key={state} className="flex min-h-11 items-center gap-3 text-md lg:min-h-9">
              <input
                type="checkbox"
                className="size-5 accent-primary"
                checked={values.includes(state)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...values.filter((each) => each !== state), state]
                    : values.filter((each) => each !== state);
                  onChange({ operator, values: next });
                }}
              />
              {words[state]}
            </label>
          ))}
        </fieldset>
      ) : null}
    </details>
  );
}
