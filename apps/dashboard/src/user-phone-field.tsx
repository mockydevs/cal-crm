// The Phone field of Settings → Users: a country and a number, which together are the
// E.164 number the API keeps. Fetched when the form first shows it, with libphonenumber
// (user-phone.ts), so neither is in what every page downloads.
import { useLingui } from '@lingui/react/macro';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useId, useMemo, useState, type ReactElement } from 'react';
import { countryChoices, countryOr, partsOf, phoneOf } from './user-phone';
import type { PhoneDraft } from './users-rules';

export default function UserPhoneField({
  initial,
  defaultCountry,
  disabled,
  problem,
  onChange,
}: {
  /** The saved number, in E.164, or none. */
  readonly initial: string | null;
  /** The country a new number starts in: the business's, when it has one. */
  readonly defaultCountry: string | null;
  readonly disabled: boolean;
  /** What is wrong with the number, said under it. */
  readonly problem: string | undefined;
  readonly onChange: (phone: PhoneDraft) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const [parts] = useState(() => partsOf(initial, countryOr(defaultCountry)));
  // Until a country is picked, the picker follows the business's country as it arrives.
  const [picked, setPicked] = useState(initial === null ? undefined : parts.country);
  const [typed, setTyped] = useState(parts.typed);
  const country = picked ?? countryOr(defaultCountry);
  const choices = useMemo(() => countryChoices(i18n.locale), [i18n.locale]);
  const inputId = useId();
  const problemId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {t`Phone`}
      </label>
      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <Select
          aria-label={t`Phone country`}
          disabled={disabled}
          value={country}
          onValueChange={(next) => {
            const chosen = countryOr(next);
            setPicked(chosen);
            onChange(phoneOf(chosen, typed));
          }}
        >
          {choices.map((choice) => (
            <option key={choice.code} value={choice.code}>
              {`${choice.name} (+${choice.dial})`}
            </option>
          ))}
        </Select>
        <Input
          id={inputId}
          type="tel"
          autoComplete="off"
          maxLength={32}
          disabled={disabled}
          value={typed}
          aria-invalid={problem === undefined ? undefined : true}
          aria-describedby={problem === undefined ? undefined : problemId}
          onChange={(event) => {
            setTyped(event.target.value);
            // A number is read in the country showing as it was typed, whatever arrives later.
            setPicked(country);
            onChange(phoneOf(country, event.target.value));
          }}
        />
      </div>
      {problem === undefined ? null : (
        <p id={problemId} className="text-sm leading-normal font-medium text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
