// Settings → AI models for the agency: the keys every business of the agency may use, and
// the prices costs are worked out from. A business chooses its own models, limit and
// privacy in its own Settings.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  listAiModelPrices,
  removeAiModelPrice,
  setAiModelPrice,
  setAiModelPriceInput,
  type AiModelPrice,
  type AiProviderKey,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { api } from './api';
import { ProvidersSection, type Place } from './ai-settings-providers';
import {
  formatDollars,
  isProvider,
  modelName,
  plainAmount,
  PROVIDERS,
  providerNames,
} from './ai-settings-rules';
import { issuesOf, noRejection, rejection, type Rejection } from './problems';
import { Page } from './shell/page';
import { meQuery } from './workspace';

const cardClassName =
  'flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]';
const pricesKey = ['ai', 'agency', 'prices'] as const;

export function AgencyAiSettingsPage(): ReactElement {
  const { t } = useLingui();
  const agencyName = useSuspenseQuery(meQuery).data.agency.name;
  const place: Place = { client: api, scope: 'agency', kind: 'agency', agencyName };
  const prices = useQuery({
    queryKey: pricesKey,
    queryFn: () => api.request(listAiModelPrices, {}),
  });
  const forbidden = prices.error instanceof ApiError && prices.error.problem.status === 403;
  return (
    <Page title={t`AI models`}>
      <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
        {t`Keys added here serve every business that chooses to use ${agencyName}’s keys. Each business picks its models, its spending limit and its privacy settings in its own Settings.`}
      </p>
      {prices.isPending ? (
        <p role="status">
          <Trans>Loading AI settings…</Trans>
        </p>
      ) : null}
      {prices.isError ? (
        <p role="alert">
          {forbidden
            ? t`You need permission to manage AI settings.`
            : t`We couldn't load the AI settings.`}{' '}
          {forbidden ? null : (
            <Button
              variant="quiet"
              onClick={() => {
                void prices.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          )}
        </p>
      ) : null}
      {prices.data === undefined ? null : (
        <>
          <ProvidersSection place={place} />
          <PricesSection prices={prices.data.data} />
        </>
      )}
    </Page>
  );
}

function PricesSection({ prices }: { readonly prices: readonly AiModelPrice[] }): ReactElement {
  const { t, i18n } = useLingui();
  const headingId = useId();
  const cache = useQueryClient();
  const [editing, setEditing] = useState<AiModelPrice | 'new'>();
  const remove = useMutation({
    mutationFn: (price: AiModelPrice) => {
      if (!isProvider(price.provider)) throw new Error('This price has no provider to name.');
      return api.request(removeAiModelPrice, {
        query: { provider: price.provider, model: price.model },
      });
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: pricesKey }),
  });
  const money = (amount: string): string => formatDollars(amount, i18n.locale);
  return (
    <section aria-labelledby={headingId} className={cardClassName}>
      <h2 id={headingId} className="text-lg font-semibold">
        <Trans>Model prices</Trans>
      </h2>
      <p className="max-w-[760px] text-sm leading-relaxed text-muted-foreground">
        <Trans>
          Costs are worked out from these prices, in US dollars for a million tokens. A model with
          no price has no known cost, and is paused in any business whose limit pauses AI. For a
          model that runs on your own server, enter zero.
        </Trans>
      </p>
      {remove.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {remove.error instanceof ApiError
            ? remove.error.message
            : t`The price wasn't removed. Check your connection and try again.`}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {prices.map((price) => {
          const name = modelName(price.provider, price.model);
          const input = money(price.inputPerMtok);
          const output = money(price.outputPerMtok);
          const read = money(price.cacheReadPerMtok);
          const write = money(price.cacheWritePerMtok);
          const write1h =
            price.cacheWrite1hPerMtok === null ? null : money(price.cacheWrite1hPerMtok);
          const { source, checkedOn } = price;
          return (
            <li
              key={`${price.provider}/${price.model}`}
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-border p-3 text-sm"
            >
              <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-medium break-all">{name}</span>
                <span className="text-muted-foreground">
                  {isProvider(price.provider)
                    ? i18n._(providerNames[price.provider])
                    : price.provider}
                </span>
              </span>
              <span>{t`Input ${input} · output ${output} for a million tokens`}</span>
              <span className="text-muted-foreground">
                {write1h === null
                  ? t`Cache reads ${read} · cache writes ${write} for 5 minutes, no 1-hour price`
                  : t`Cache reads ${read} · cache writes ${write} for 5 minutes, ${write1h} for 1 hour`}
              </span>
              <span className="break-words text-muted-foreground">
                {price.shipped
                  ? t`Shipped with this version, from ${source}, checked on ${checkedOn}`
                  : t`Set by your agency: ${source}, on ${checkedOn}`}
              </span>
              <span className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    setEditing(price);
                  }}
                >
                  {t`Change the price of ${name}`}
                </Button>
                {price.shipped ? null : (
                  <Button
                    variant="quiet"
                    size="small"
                    disabled={remove.isPending}
                    onClick={() => {
                      remove.mutate(price);
                    }}
                  >
                    {t`Remove the price of ${name}`}
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {editing === undefined ? (
        <Button
          variant="secondary"
          size="small"
          className="self-start"
          onClick={() => {
            setEditing('new');
          }}
        >
          <Trans>Add a price</Trans>
        </Button>
      ) : (
        <PriceForm
          // A different price to change is a different form.
          key={editing === 'new' ? 'new' : `${editing.provider}/${editing.model}`}
          price={editing === 'new' ? undefined : editing}
          close={() => {
            setEditing(undefined);
          }}
        />
      )}
    </section>
  );
}

function PriceForm({
  price,
  close,
}: {
  readonly price: AiModelPrice | undefined;
  readonly close: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const cache = useQueryClient();
  const [provider, setProvider] = useState<AiProviderKey>(() =>
    price !== undefined && isProvider(price.provider) ? price.provider : 'openai_compatible',
  );
  const [model, setModel] = useState(price?.model ?? '');
  const [input, setInput] = useState(() =>
    price === undefined ? '' : plainAmount(price.inputPerMtok),
  );
  const [output, setOutput] = useState(() =>
    price === undefined ? '' : plainAmount(price.outputPerMtok),
  );
  // A price being changed keeps its cache prices unless they are changed too.
  const [cacheRead, setCacheRead] = useState(() =>
    price === undefined ? '' : plainAmount(price.cacheReadPerMtok),
  );
  const [cacheWrite, setCacheWrite] = useState(() =>
    price === undefined ? '' : plainAmount(price.cacheWritePerMtok),
  );
  const [cacheWrite1h, setCacheWrite1h] = useState(() => {
    const hour = price?.cacheWrite1hPerMtok ?? null;
    return hour === null ? '' : plainAmount(hour);
  });
  const [source, setSource] = useState(price === undefined || price.shipped ? '' : price.source);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof setAiModelPriceInput.parse>[0]) =>
      api.request(setAiModelPrice, { body: setAiModelPriceInput.parse(body) }),
    onSuccess: async () => {
      close();
      // A price changes what each business's settings say can run.
      await cache.invalidateQueries({ queryKey: ['ai'] });
    },
    onError: (error) => {
      const errors = error instanceof ApiError ? (error.problem.errors ?? []) : [];
      setProblem(
        errors.length > 0
          ? rejection(errors)
          : {
              fields: {},
              form:
                error instanceof ApiError
                  ? error.message
                  : t`The price wasn't saved. Check your connection and try again.`,
            },
      );
    },
  });
  return (
    <Form<Record<string, unknown>>
      className="min-w-0"
      errors={problem.fields}
      aria-label={price === undefined ? t`Add a price` : t`Change a price`}
      onFormSubmit={() => {
        // A cache price left empty is left out, and the API's rule for a missing one applies.
        const optional = (name: string, value: string) =>
          value.trim() === '' ? {} : { [name]: value.trim() };
        const body = {
          provider,
          model,
          inputPerMtok: input.trim(),
          outputPerMtok: output.trim(),
          ...optional('cacheReadPerMtok', cacheRead),
          ...optional('cacheWritePerMtok', cacheWrite),
          ...optional('cacheWrite1hPerMtok', cacheWrite1h),
          source,
        };
        const parsed = setAiModelPriceInput.safeParse(body);
        if (!parsed.success) {
          setProblem(rejection(issuesOf(parsed.error)));
          return;
        }
        setProblem(noRejection);
        save.mutate(body);
      }}
    >
      <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-4 border-0 p-0">
        <Field name="provider">
          <FieldLabel>
            <Trans>Provider</Trans>
          </FieldLabel>
          <Select
            value={provider}
            disabled={price !== undefined}
            onValueChange={(value) => {
              if (isProvider(value)) setProvider(value);
            }}
          >
            {PROVIDERS.map((each) => (
              <option key={each} value={each}>
                {i18n._(providerNames[each])}
              </option>
            ))}
          </Select>
          <FieldError />
        </Field>
        <Field name="model">
          <FieldLabel>
            <Trans>Model name</Trans>
          </FieldLabel>
          <Input
            value={model}
            required
            readOnly={price !== undefined}
            autoComplete="off"
            placeholder={t`As the provider lists it`}
            onValueChange={setModel}
          />
          <FieldError />
        </Field>
        <Field name="inputPerMtok">
          <FieldLabel>
            <Trans>Input, in US dollars for a million tokens</Trans>
          </FieldLabel>
          <Input
            value={input}
            required
            inputMode="decimal"
            autoComplete="off"
            onValueChange={setInput}
          />
          <FieldError />
        </Field>
        <Field name="outputPerMtok">
          <FieldLabel>
            <Trans>Output, in US dollars for a million tokens</Trans>
          </FieldLabel>
          <Input
            value={output}
            required
            inputMode="decimal"
            autoComplete="off"
            onValueChange={setOutput}
          />
          <FieldError />
        </Field>
        <Field name="cacheReadPerMtok">
          <FieldLabel>
            <Trans>Cache reads, in US dollars for a million tokens</Trans>
          </FieldLabel>
          <Input
            value={cacheRead}
            inputMode="decimal"
            autoComplete="off"
            onValueChange={setCacheRead}
          />
          <FieldDescription>
            <Trans>Left empty, cached input costs what fresh input does.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <Field name="cacheWritePerMtok">
          <FieldLabel>
            <Trans>Cache writes for 5 minutes, in US dollars for a million tokens</Trans>
          </FieldLabel>
          <Input
            value={cacheWrite}
            inputMode="decimal"
            autoComplete="off"
            onValueChange={setCacheWrite}
          />
          <FieldDescription>
            <Trans>Left empty, a cache write costs what fresh input does.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <Field name="cacheWrite1hPerMtok">
          <FieldLabel>
            <Trans>Cache writes for 1 hour, in US dollars for a million tokens</Trans>
          </FieldLabel>
          <Input
            value={cacheWrite1h}
            inputMode="decimal"
            autoComplete="off"
            onValueChange={setCacheWrite1h}
          />
          <FieldDescription>
            <Trans>
              Claude only. Left empty, this model never keeps its instructions cached for an hour,
              only for 5 minutes.
            </Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <Field name="source">
          <FieldLabel>
            <Trans>Where this price comes from</Trans>
          </FieldLabel>
          <Input
            value={source}
            required
            autoComplete="off"
            placeholder={t`The provider's pricing page, or "runs on our own server"`}
            onValueChange={setSource}
          />
          <FieldDescription>
            <Trans>Shown beside the price, with today's date, so the next person knows.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="small" disabled={save.isPending}>
            {save.isPending ? t`Saving…` : t`Save price`}
          </Button>
          <Button type="button" variant="quiet" size="small" onClick={close}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </fieldset>
    </Form>
  );
}
