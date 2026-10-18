import { Trans, useLingui } from '@lingui/react/macro';
import { createBusiness, createBusinessInput, type CreateBusinessInput } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { EmptyState } from '@repo/ui/components/empty-state';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { api } from '../api';
import { issuesOf, noRejection, rejection, type Rejection } from '../problems';
import { BusinessList } from '../shell/business-list';
import { Page } from '../shell/page';
import { meQuery } from '../workspace';

export const Route = createFileRoute('/_app/agency/')({ component: BusinessesPage });

// The browser's own lists, which the server checks against too (@repo/kernel). The
// browser's time zone comes first when the list lacks it, as Chromium's lacks UTC.
const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
const known = Intl.supportedValuesOf('timeZone');
const timeZones = known.includes(here) ? known : [here, ...known];
const currencies = Intl.supportedValuesOf('currency');

/** Every business of the agency, to open, and a new one to add. */
function BusinessesPage(): ReactElement {
  const { t } = useLingui();
  const { businesses } = useSuspenseQuery(meQuery).data;
  const [adding, setAdding] = useState(false);
  const newBusinessRef = useRef<HTMLButtonElement>(null);

  const close = (): void => {
    setAdding(false);
    newBusinessRef.current?.focus();
  };

  return (
    <Page
      title={t`Businesses`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/agency/settings/team"
            className="min-h-10 rounded-full px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            <Trans>Settings</Trans>
          </Link>
          <Button
            ref={newBusinessRef}
            aria-expanded={adding}
            onClick={() => {
              setAdding(!adding);
            }}
          >
            <Plus aria-hidden className="size-[18px]" strokeWidth={2} />
            <Trans>New business</Trans>
          </Button>
        </div>
      }
    >
      {adding ? <NewBusinessForm onCancel={close} /> : null}
      {businesses.length > 0 ? (
        <BusinessList businesses={businesses} />
      ) : (
        <EmptyState
          icon={<Building2 strokeWidth={1.8} />}
          title={<Trans>No businesses yet</Trans>}
          description={<Trans>Each business your agency works for gets its own space here.</Trans>}
        />
      )}
    </Page>
  );
}

/** Adds a business, with what every business starts with, then opens it. */
function NewBusinessForm({ onCancel }: { readonly onCancel: () => void }): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const nameRef = useRef<HTMLInputElement>(null);
  const currencyNames = useMemo(
    () => new Intl.DisplayNames([i18n.locale], { type: 'currency' }),
    [i18n.locale],
  );

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const create = useMutation({
    // Agency staff, at the agency: the request names no business.
    mutationFn: (body: CreateBusinessInput) => api.request(createBusiness, { body }),
    onSuccess: async (made) => {
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      await navigate({ to: '/b/$slug', params: { slug: made.slug } });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.problem.errors !== undefined) {
        setProblem(rejection(error.problem.errors));
      } else if (error instanceof ApiError && error.problem.detail !== undefined) {
        // The server refused, and says why: a role without businesses.create, say.
        setProblem({ fields: {}, form: error.problem.detail });
      } else {
        setProblem({
          fields: {},
          form: t`The business wasn't created. Check your connection and try again.`,
        });
      }
    },
  });

  return (
    <section
      aria-labelledby="new-business-heading"
      className="flex flex-col gap-4 rounded-card border-2 border-primary bg-card p-[22px]"
    >
      <h2 id="new-business-heading" className="text-xl font-semibold">
        <Trans>New business</Trans>
      </h2>
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={(values) => {
          // The API's own rules, so the messages match the server's. The one value the
          // lists can't give is no currency yet, which is asked for as such.
          const parsed = createBusinessInput.safeParse(values);
          if (parsed.success) {
            create.mutate(parsed.data);
            return;
          }
          const found = rejection(issuesOf(parsed.error));
          setProblem(
            values['currency'] === ''
              ? { ...found, fields: { ...found.fields, currency: t`Choose a currency.` } }
              : found,
          );
        }}
      >
        <Field name="name">
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input ref={nameRef} maxLength={200} autoComplete="organization" className="max-w-md" />
          <FieldDescription>
            <Trans>Its address in the dashboard is made from the name.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <Field name="timezone">
          <FieldLabel>
            <Trans>Time zone</Trans>
          </FieldLabel>
          <Select defaultValue={here} className="max-w-md">
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll('_', ' ')}
              </option>
            ))}
          </Select>
          <FieldDescription>
            <Trans>Its calendar, reminders and reports keep this time.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <Field name="currency">
          <FieldLabel>
            <Trans>Currency</Trans>
          </FieldLabel>
          <Select defaultValue="" className="max-w-md">
            <option value="" disabled>
              {t`Choose a currency`}
            </option>
            {currencies.map((code) => (
              <option key={code} value={code}>
                {`${code} · ${currencyNames.of(code) ?? code}`}
              </option>
            ))}
          </Select>
          <FieldDescription>
            <Trans>For its deals and payments.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap gap-2.5">
          <Button type="submit" disabled={create.isPending}>
            <Trans>Create business</Trans>
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onCancel();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </Form>
    </section>
  );
}
