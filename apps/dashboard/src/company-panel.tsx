// What the Companies panel holds, for a new company ("Add new Company" in GoHighLevel) and
// for one being edited: the fields `createCompanyInput` and `updateCompanyInput` accept and
// no others. The API's own schema checks a draft before it is sent, so what is said under a
// field is what the server would say. Fetched when the panel first opens, so the list stays
// light.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createCompany,
  createCompanyInput,
  updateCompany,
  updateCompanyInput,
  type Company,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { apiIn } from './api';
import { countryCodes } from './company-countries';
import { bodyOf, countryName, draftOf, type CompanyBody, type CompanyDraft } from './company-rules';
import {
  panelFormClassName,
  RightPanel,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './conversation-extras-panel';
import { issuesOf, noRejection, rejection, type Rejection } from './problems';
import { savingProblem } from './settings-list';
import { useBusiness } from './workspace';

/** The choice that stands for no country: a select's choices each need a value. */
const NO_COUNTRY = 'none';

/** The one-line boxes, in GoHighLevel's order around the ones drawn differently. */
type Line = Exclude<keyof CompanyDraft, 'name' | 'country' | 'description'>;

export function CompanyForm({
  company,
  addedBefore = false,
  onCancel,
  onSaved,
}: {
  /** The company to edit, or undefined for a new one. */
  readonly company: Company | undefined;
  /** True when this empty form follows a company just added with "Save and add another". */
  readonly addedBefore?: boolean;
  readonly onCancel: () => void;
  readonly onSaved: (saved: Company, another: boolean) => Promise<void>;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const [draft, setDraft] = useState(() => draftOf(company));
  // What the last Save was refused with. A field's refusal goes when the field changes, and
  // every one goes when Save is pressed again: a field left as it was is asked about anew.
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [refusals, setRefusals] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const countryErrorId = useId();
  // The keyboard goes to the first field a refusal names, in the order the form shows them.
  useEffect(() => {
    if (refusals > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refusals]);
  const refuse = (next: Rejection) => {
    setProblem(next);
    setRefusals((count) => count + 1);
  };
  const change = (name: keyof CompanyDraft, value: string) => {
    setDraft((now) => ({ ...now, [name]: value }));
    setProblem((now) =>
      now.fields[name] === undefined
        ? now
        : {
            form: now.form,
            fields: Object.fromEntries(Object.entries(now.fields).filter(([key]) => key !== name)),
          },
    );
  };
  const refusalOf = (name: keyof CompanyDraft): ReactElement | null =>
    problem.fields[name] === undefined ? null : (
      <FieldError match>{problem.fields[name]}</FieldError>
    );

  const countries = useMemo(() => {
    // A company may hold a code that is no longer, or not yet, an assigned one.
    const saved = company?.country ?? null;
    const codes =
      saved === null || countryCodes.includes(saved) ? countryCodes : [saved, ...countryCodes];
    return codes
      .map((code) => ({ code, name: countryName(code, i18n.locale) }))
      .sort((a, b) => a.name.localeCompare(b.name, i18n.locale));
  }, [company?.country, i18n.locale]);

  const save = useMutation({
    mutationFn: ({ body }: { readonly body: CompanyBody; readonly another: boolean }) => {
      const api = apiIn(business.id);
      return company === undefined
        ? api.request(createCompany, { body })
        : api.request(updateCompany, { params: { id: company.id }, body });
    },
    onSuccess: (saved, input) => onSaved(saved, input.another),
    onError: (error) => {
      refuse(
        savingProblem(error, t`The company wasn't saved. Check your connection and try again.`),
      );
    },
  });
  const ready = draft.name.trim() !== '' && !save.isPending;

  const submit = (another: boolean) => {
    if (!ready) return;
    const body = bodyOf(draft);
    const checked = (company === undefined ? createCompanyInput : updateCompanyInput).safeParse(
      body,
    );
    if (!checked.success) {
      refuse(rejection(issuesOf(checked.error)));
      return;
    }
    setProblem(noRejection);
    save.mutate({ body, another });
  };

  const line = (
    name: Line,
    label: ReactElement,
    most: number,
    rest: {
      /** The keyboard a phone offers. The API's rules check the value, not the browser's. */
      readonly inputMode?: 'tel' | 'email' | 'url';
      readonly autoComplete?: string;
      readonly hint?: ReactElement;
    } = {},
  ): ReactElement => (
    <Field name={name} invalid={problem.fields[name] !== undefined}>
      <FieldLabel>{label}</FieldLabel>
      <Input
        inputMode={rest.inputMode}
        maxLength={most}
        autoComplete={rest.autoComplete ?? 'off'}
        autoCapitalize={name === 'website' || name === 'domain' ? 'none' : undefined}
        value={draft[name]}
        onChange={(event) => {
          change(name, event.target.value);
        }}
      />
      {rest.hint === undefined ? null : <FieldDescription>{rest.hint}</FieldDescription>}
      {refusalOf(name)}
    </Field>
  );

  return (
    <form
      ref={formRef}
      aria-label={t`Company details`}
      noValidate
      className={`flex flex-col ${panelFormClassName}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
    >
      <div className={sidePanelBodyClassName}>
        {addedBefore ? (
          <p role="status" className="text-sm text-success">
            <Trans>Company added. Add another, or close the panel.</Trans>
          </p>
        ) : null}
        <Field name="name" invalid={problem.fields['name'] !== undefined}>
          <FieldLabel>
            <Trans>Company Name</Trans>
          </FieldLabel>
          <Input
            required
            maxLength={200}
            autoComplete="off"
            value={draft.name}
            onChange={(event) => {
              change('name', event.target.value);
            }}
          />
          {refusalOf('name')}
        </Field>
        {line('phone', <Trans>Phone</Trans>, 40, {
          inputMode: 'tel',
          hint: (
            <Trans>
              Write it with + and the country code, or as it's written in the business's country.
            </Trans>
          ),
        })}
        {line('email', <Trans>Email</Trans>, 320, { inputMode: 'email' })}
        {line('website', <Trans>Website</Trans>, 2000, {
          inputMode: 'url',
          hint: <Trans>For example, www.acme.example.</Trans>,
        })}
        {line('address', <Trans>Address</Trans>, 200)}
        {line('state', <Trans>State</Trans>, 200)}
        {line('city', <Trans>City</Trans>, 200)}
        <Field name="description" invalid={problem.fields['description'] !== undefined}>
          <FieldLabel>
            <Trans>Description</Trans>
          </FieldLabel>
          <Textarea
            rows={4}
            maxLength={5000}
            value={draft.description}
            onChange={(event) => {
              change('description', event.target.value);
            }}
          />
          {refusalOf('description')}
        </Field>
        {line('postalCode', <Trans>Postal Code</Trans>, 32)}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <Trans>Country</Trans>
          <Select
            aria-label={t`Country`}
            {...(problem.fields['country'] === undefined
              ? {}
              : { 'aria-describedby': countryErrorId, 'aria-invalid': true })}
            value={draft.country === '' ? NO_COUNTRY : draft.country}
            onValueChange={(next) => {
              change('country', next === NO_COUNTRY ? '' : next);
            }}
          >
            <option value={NO_COUNTRY}>{t`No country`}</option>
            {countries.map((each) => (
              <option key={each.code} value={each.code}>
                {each.name}
              </option>
            ))}
          </Select>
        </label>
        {problem.fields['country'] === undefined ? null : (
          <p id={countryErrorId} role="alert" className="text-sm font-medium text-destructive">
            {problem.fields['country']}
          </p>
        )}
        {line('domain', <Trans>Domain</Trans>, 253, {
          hint: (
            <Trans>
              For example, acme.example. No two companies share one. Leave blank if it has none.
            </Trans>
          ),
        })}
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem.form}
          </p>
        )}
      </div>
      <div className={sidePanelFooterClassName}>
        <Button
          variant="secondary"
          className="mr-auto"
          disabled={save.isPending}
          onClick={() => {
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        {company === undefined ? (
          <Button
            variant="secondary"
            disabled={!ready}
            onClick={() => {
              submit(true);
            }}
          >
            <Trans>Save and add another</Trans>
          </Button>
        ) : null}
        <Button type="submit" disabled={!ready}>
          {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
    </form>
  );
}

/**
 * The panel that edits one company, whole: for the company's own page, which fetches it
 * when Edit is first pressed so that the page itself carries no panel.
 */
export default function CompanyEditPanel({
  company,
  open,
  returnFocus,
  onClose,
  onSaved,
}: {
  readonly company: Company;
  readonly open: boolean;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSaved: (saved: Company) => Promise<void>;
}): ReactElement {
  return (
    <RightPanel
      open={open}
      onClose={onClose}
      returnFocus={returnFocus}
      title={<Trans>Edit company</Trans>}
    >
      {open ? (
        <CompanyForm key={company.id} company={company} onCancel={onClose} onSaved={onSaved} />
      ) : null}
    </RightPanel>
  );
}
