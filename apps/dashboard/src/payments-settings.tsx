// Payments → Settings: how the business numbers and words its quotes, invoices and
// receipts, its payment terms and its tax. The company's name, address and logo are the
// business profile's, shown here with the way to change them. Reading needs permission to
// see payments; changing, the permission the server reports with canManage.
import { Trans, useLingui } from '@lingui/react/macro';
import { updateCommerceSettings, type CommerceSettings } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button, buttonVariants } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { ReminderSettingsCard } from './invoice-reminders';
import {
  PageIntro,
  ReadOnlyNote,
  Refused,
  settingsKey,
  useCommerceSettings,
  useLogoUrl,
  useProfile,
} from './payments-parts';
import {
  addressLines,
  deepRejection,
  numberedKinds,
  numberExample,
  settingsDraftOf,
  settingsInput,
  unwholeFields,
  type NumberedKind,
  type SettingsDraft,
} from './payments-rules';
import { noRejection, type Rejection } from './problems';
import { FormProblem, isStale, ListProblem, savingProblem } from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const cardClassName = 'flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-4';
const cardTitleClassName = 'text-base font-medium text-foreground';
const smallLabelClassName = 'text-xs text-muted-foreground';

function Boxed({
  label,
  hint,
  error,
  children,
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error: string | undefined;
  readonly children: (ids: {
    readonly id: string;
    readonly 'aria-invalid': boolean;
    readonly 'aria-describedby': string | undefined;
  }) => ReactNode;
}): ReactElement {
  const id = useId();
  const described = [
    hint === undefined ? '' : `${id}-hint`,
    error === undefined ? '' : `${id}-error`,
  ]
    .filter((each) => each !== '')
    .join(' ');
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className={smallLabelClassName}>
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error !== undefined,
        'aria-describedby': described === '' ? undefined : described,
      })}
      {hint === undefined ? null : (
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      )}
      {error === undefined ? null : (
        <span id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

/** The company as its documents print it, and the way to the page that changes it. */
function CompanyCard(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const profile = useProfile();
  const logo = useLogoUrl(profile.data?.logoFileId ?? null);
  const name = profile.data?.name ?? business.name;
  const lines = addressLines(profile.data?.address ?? null);
  return (
    <section aria-label={t`Company details and logo`} className={cardClassName}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className={cardTitleClassName}>
            <Trans>Company details and logo</Trans>
          </h2>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Printed at the top of every quote, invoice and receipt. They are part of the business
              profile.
            </Trans>
          </p>
        </div>
        <Link
          to="/b/$slug/settings/business"
          params={{ slug: business.slug }}
          className={buttonVariants({ variant: 'secondary', size: 'small' })}
        >
          <Trans>Edit in Business Profile</Trans>
        </Link>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-4">
        {logo === undefined ? (
          <span className="flex size-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-input text-muted-foreground">
            <Building2 aria-hidden className="size-6" strokeWidth={1.6} />
            <span className="sr-only">
              <Trans>No logo yet</Trans>
            </span>
          </span>
        ) : (
          <img
            src={logo}
            alt={t`Logo of ${name}`}
            className="h-16 w-auto max-w-40 shrink-0 object-contain"
          />
        )}
        <dl className="flex min-w-0 flex-col gap-0.5">
          <dt className={smallLabelClassName}>
            <Trans>Company</Trans>
          </dt>
          <dd className="text-sm font-semibold wrap-anywhere text-foreground">{name}</dd>
          <dd className="text-sm wrap-anywhere text-body">
            {lines.length === 0 ? <Trans>No address yet</Trans> : lines.join(', ')}
          </dd>
        </dl>
      </div>
    </section>
  );
}

export default function SettingsPage(): ReactElement {
  const { t } = useLingui();
  const settings = useCommerceSettings();
  const refused = settings.error instanceof ApiError && settings.error.status === 403;
  const formId = useId();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const canManage = settings.data?.canManage === true;
  return (
    <Page
      title={t`Payment settings`}
      actions={
        canManage ? (
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
          </Button>
        ) : undefined
      }
    >
      <PageIntro>
        <Trans>How your quotes, invoices and receipts are numbered and worded.</Trans>
      </PageIntro>
      {settings.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {refused ? (
        <Refused />
      ) : settings.isError ? (
        <ListProblem
          onRetry={() => {
            void settings.refetch();
          }}
        >
          <Trans>The settings couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {settings.data === undefined ? null : (
        <>
          {canManage ? null : (
            <ReadOnlyNote>
              <Trans>
                You can look at these settings. Changing them needs permission to manage payments.
              </Trans>
            </ReadOnlyNote>
          )}
          <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
            {notice}
          </p>
          <CompanyCard />
          <SettingsForm
            key={settings.data.revision}
            formId={formId}
            settings={settings.data}
            onSaving={setSaving}
            onNotice={setNotice}
            onReload={() => {
              void settings.refetch();
            }}
          />
        </>
      )}
    </Page>
  );
}

function SettingsForm({
  formId,
  settings,
  onSaving,
  onNotice,
  onReload,
}: {
  readonly formId: string;
  readonly settings: CommerceSettings;
  readonly onSaving: (saving: boolean) => void;
  /** What the page says above the form, which is drawn again from what was saved. */
  readonly onNotice: (notice: string) => void;
  readonly onReload: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraftOf(settings));
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const set = (changes: Partial<SettingsDraft>): void => {
    setDraft((before) => ({ ...before, ...changes }));
    onNotice('');
  };
  const setNumbering = (
    kind: NumberedKind,
    changes: Partial<SettingsDraft['numbering'][NumberedKind]>,
  ): void => {
    set({ numbering: { ...draft.numbering, [kind]: { ...draft.numbering[kind], ...changes } } });
  };
  const save = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(updateCommerceSettings, {
        body: settingsInput(draft, settings.revision),
      }),
    onMutate: () => {
      onSaving(true);
    },
    onSettled: () => {
      onSaving(false);
    },
    onSuccess: (saved) => {
      cache.setQueryData(settingsKey(business.id), saved);
      onNotice(t`Settings saved.`);
    },
    onError: (error) => {
      setProblem(
        isStale(error)
          ? {
              fields: {},
              form: t`Someone changed these settings since you opened them. Reload the saved version, then make your changes again.`,
            }
          : error instanceof ApiError && error.problem.errors !== undefined
            ? deepRejection(error.problem.errors)
            : savingProblem(
                error,
                t`The settings weren't saved. Check your connection and try again.`,
              ),
      );
    },
  });
  const disabled = !settings.canManage || save.isPending;
  const kindNames: Readonly<Record<NumberedKind, string>> = {
    quote: t`Quotes`,
    invoice: t`Invoices`,
    receipt: t`Receipts`,
  };
  const problemOf = (path: string): string | undefined => problem.fields[path];

  return (
    <form
      id={formId}
      noValidate
      aria-label={t`Payment settings`}
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onNotice('');
        const unwhole = unwholeFields(draft);
        if (unwhole.length > 0) {
          setProblem({
            fields: Object.fromEntries(unwhole.map((path) => [path, t`Enter a whole number.`])),
            form: undefined,
          });
          return;
        }
        setProblem(noRejection);
        save.mutate();
      }}
    >
      <FormProblem
        problem={problem}
        stale={isStale(save.error)}
        busy={save.isPending}
        onReload={onReload}
      />
      <fieldset disabled={disabled} className={cardClassName}>
        <legend className="sr-only">
          <Trans>Numbering</Trans>
        </legend>
        <div className="flex flex-col gap-0.5">
          <h2 className={cardTitleClassName}>
            <Trans>Numbering</Trans>
          </h2>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Each kind counts by itself. A number can be moved forward, never back to one already
              given out.
            </Trans>
          </p>
        </div>
        {numberedKinds.map((kind) => {
          const each = draft.numbering[kind];
          const example = numberExample(each.prefix, each.nextNumber);
          const kindName = kindNames[kind];
          const last = settings.numbering[kind].lastNumber;
          return (
            <div
              key={kind}
              role="group"
              aria-label={kindName}
              className="grid items-start gap-3 border-t border-border pt-3 sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]"
            >
              <span className="text-sm font-semibold text-foreground sm:pt-6">{kindName}</span>
              <Boxed label={<Trans>Prefix</Trans>} error={problemOf(`numbering/${kind}/prefix`)}>
                {(ids) => (
                  <Input
                    {...ids}
                    maxLength={12}
                    autoComplete="off"
                    value={each.prefix}
                    onChange={(event) => {
                      setNumbering(kind, { prefix: event.target.value });
                    }}
                  />
                )}
              </Boxed>
              <Boxed
                label={<Trans>Next number</Trans>}
                hint={last === 0 ? undefined : <Trans>The last one given out was {last}.</Trans>}
                error={problemOf(`numbering/${kind}/nextNumber`)}
              >
                {(ids) => (
                  <Input
                    {...ids}
                    inputMode="numeric"
                    maxLength={12}
                    autoComplete="off"
                    value={each.nextNumber}
                    onChange={(event) => {
                      setNumbering(kind, { nextNumber: event.target.value });
                    }}
                  />
                )}
              </Boxed>
              <div className="flex min-w-0 flex-col gap-1">
                <span className={smallLabelClassName}>
                  <Trans>The next one will be</Trans>
                </span>
                <output
                  aria-label={t`Next number for ${kindName}`}
                  className="flex min-h-11 items-center text-sm font-semibold wrap-anywhere text-foreground lg:min-h-9"
                >
                  {example ?? '—'}
                </output>
              </div>
            </div>
          );
        })}
      </fieldset>

      <fieldset disabled={disabled} className={cardClassName}>
        <legend className="sr-only">
          <Trans>Terms and tax</Trans>
        </legend>
        <h2 className={cardTitleClassName}>
          <Trans>Terms and tax</Trans>
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Boxed
            label={<Trans>Payment terms (days)</Trans>}
            hint={<Trans>From an invoice's issue date to its due date.</Trans>}
            error={problemOf('paymentTermsDays')}
          >
            {(ids) => (
              <Input
                {...ids}
                inputMode="numeric"
                maxLength={3}
                autoComplete="off"
                value={draft.paymentTermsDays}
                onChange={(event) => {
                  set({ paymentTermsDays: event.target.value });
                }}
              />
            )}
          </Boxed>
          <Boxed
            label={<Trans>Quote validity (days)</Trans>}
            hint={<Trans>How long a quote can be accepted.</Trans>}
            error={problemOf('quoteValidityDays')}
          >
            {(ids) => (
              <Input
                {...ids}
                inputMode="numeric"
                maxLength={3}
                autoComplete="off"
                value={draft.quoteValidityDays}
                onChange={(event) => {
                  set({ quoteValidityDays: event.target.value });
                }}
              />
            )}
          </Boxed>
          <Boxed
            label={<Trans>Default tax rate (%)</Trans>}
            hint={<Trans>For a new line with no rate of its own. Empty: none.</Trans>}
            error={problemOf('defaultTaxRate')}
          >
            {(ids) => (
              <Input
                {...ids}
                inputMode="decimal"
                maxLength={8}
                autoComplete="off"
                value={draft.defaultTaxRate}
                onChange={(event) => {
                  set({ defaultTaxRate: event.target.value });
                }}
              />
            )}
          </Boxed>
          <Boxed
            label={<Trans>Tax number</Trans>}
            hint={<Trans>Your VAT or tax PIN, printed under your address.</Trans>}
            error={problemOf('taxNumber')}
          >
            {(ids) => (
              <Input
                {...ids}
                maxLength={64}
                autoComplete="off"
                value={draft.taxNumber}
                onChange={(event) => {
                  set({ taxNumber: event.target.value });
                }}
              />
            )}
          </Boxed>
        </div>
      </fieldset>

      <ReminderSettingsCard canManage={settings.canManage} />

      <fieldset disabled={disabled} className={cardClassName}>
        <legend className="sr-only">
          <Trans>Wording</Trans>
        </legend>
        <h2 className={cardTitleClassName}>
          <Trans>Wording</Trans>
        </h2>
        <Boxed
          label={<Trans>Payment instructions</Trans>}
          hint={<Trans>Bank or mobile money details, printed on every invoice.</Trans>}
          error={problemOf('paymentInstructions')}
        >
          {(ids) => (
            <Textarea
              {...ids}
              rows={3}
              maxLength={5000}
              value={draft.paymentInstructions}
              onChange={(event) => {
                set({ paymentInstructions: event.target.value });
              }}
            />
          )}
        </Boxed>
        <div className="grid gap-3 lg:grid-cols-2">
          <Boxed
            label={<Trans>Default notes</Trans>}
            hint={<Trans>A new quote or invoice starts with these.</Trans>}
            error={problemOf('defaultNotes')}
          >
            {(ids) => (
              <Textarea
                {...ids}
                rows={4}
                maxLength={5000}
                value={draft.defaultNotes}
                onChange={(event) => {
                  set({ defaultNotes: event.target.value });
                }}
              />
            )}
          </Boxed>
          <Boxed
            label={<Trans>Default terms and conditions</Trans>}
            hint={<Trans>A new quote or invoice starts with these.</Trans>}
            error={problemOf('defaultTerms')}
          >
            {(ids) => (
              <Textarea
                {...ids}
                rows={4}
                maxLength={10000}
                value={draft.defaultTerms}
                onChange={(event) => {
                  set({ defaultTerms: event.target.value });
                }}
              />
            )}
          </Boxed>
        </div>
      </fieldset>
    </form>
  );
}
