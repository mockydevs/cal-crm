// The panel of Payments → Products: a product or a service being added or changed. What is
// typed is sent as it is; the server's own words come back under the box it refuses. Fetched
// when the panel first opens.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createProduct,
  getProduct,
  PRODUCT_UNIT_SUGGESTIONS,
  productKinds,
  updateProduct,
  type Product,
  type ProductKind,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  panelFormClassName,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './conversation-extras-panel';
import { productDraftOf, productInput, type ProductDraft } from './payments-rules';
import { noRejection, type Rejection } from './problems';
import { FormProblem, isStale, savingProblem, ViewSwitch } from './settings-list';
import { useBusiness } from './workspace';

export default function ProductPanel({
  product,
  currency,
  onCancel,
  onSaved,
}: {
  /** The product to change, or undefined for a new one. */
  readonly product: Product | undefined;
  /** The business's currency, which a new product starts in. */
  readonly currency: string;
  readonly onCancel: () => void;
  readonly onSaved: (saved: Product, created: boolean) => Promise<void>;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [current, setCurrent] = useState(product);
  const [draft, setDraft] = useState<ProductDraft>(() => productDraftOf(product, currency));
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const unitsId = useId();
  const currenciesId = useId();
  const set = (changes: Partial<ProductDraft>): void => {
    setDraft((before) => ({ ...before, ...changes }));
  };
  const save = useMutation({
    mutationFn: () =>
      current === undefined
        ? api.request(createProduct, { body: productInput(draft) })
        : api.request(updateProduct, {
            params: { id: current.id },
            body: { ...productInput(draft), revision: current.revision },
          }),
    onSuccess: (saved) => onSaved(saved, current === undefined),
    onError: (error) => {
      setProblem(
        isStale(error)
          ? {
              fields: {},
              form: t`Someone changed this product since you opened it. Reload the saved version, then make your change again.`,
            }
          : savingProblem(error, t`It wasn't saved. Check your connection and try again.`),
      );
    },
  });
  const reload = useMutation({
    mutationFn: () => {
      if (current === undefined) throw new Error('Nothing saved to reload.');
      return api.request(getProduct, { params: { id: current.id } });
    },
    onSuccess: (latest) => {
      setCurrent(latest);
      setDraft(productDraftOf(latest, currency));
      setProblem(noRejection);
      save.reset();
    },
    onError: () => {
      setProblem({
        fields: {},
        form: t`The saved version couldn't be loaded. It may have been deleted.`,
      });
    },
  });
  const kindNames: Readonly<Record<ProductKind, string>> = {
    product: t`Product`,
    service: t`Service`,
  };
  const ready = draft.name.trim() !== '' && draft.unitPrice.trim() !== '' && !save.isPending;

  return (
    <Form<Record<string, unknown>>
      className={panelFormClassName}
      errors={problem.fields}
      onFormSubmit={() => {
        setProblem(noRejection);
        save.mutate();
      }}
    >
      <div className={sidePanelBodyClassName}>
        <Field name="name">
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            required
            maxLength={200}
            autoComplete="off"
            value={draft.name}
            onChange={(event) => {
              set({ name: event.target.value });
            }}
          />
          <FieldError />
        </Field>
        <div className="flex flex-col items-start gap-1.5 text-sm font-medium">
          <Trans>Kind</Trans>
          <ViewSwitch
            label={t`Kind`}
            value={draft.kind}
            onChange={(kind) => {
              set({ kind });
            }}
            views={productKinds.map((each) => ({ value: each, label: kindNames[each] }))}
          />
        </div>
        <Field name="description">
          <FieldLabel>
            <Trans>Description</Trans>
          </FieldLabel>
          <Textarea
            rows={3}
            maxLength={5000}
            value={draft.description}
            onChange={(event) => {
              set({ description: event.target.value });
            }}
          />
          <FieldDescription>
            <Trans>Printed under the name on a quote or an invoice.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="sku">
            <FieldLabel>
              <Trans>Code (SKU)</Trans>
            </FieldLabel>
            <Input
              maxLength={64}
              autoComplete="off"
              value={draft.sku}
              onChange={(event) => {
                set({ sku: event.target.value });
              }}
            />
            <FieldError />
          </Field>
          <Field name="unit">
            <FieldLabel>
              <Trans>Unit</Trans>
            </FieldLabel>
            <Input
              maxLength={32}
              autoComplete="off"
              list={unitsId}
              placeholder={t`item, hour, day…`}
              value={draft.unit}
              onChange={(event) => {
                set({ unit: event.target.value });
              }}
            />
            <FieldError />
          </Field>
          <Field name="unitPrice">
            <FieldLabel>
              <Trans>Rate</Trans>
            </FieldLabel>
            <Input
              required
              inputMode="decimal"
              maxLength={24}
              autoComplete="off"
              value={draft.unitPrice}
              onChange={(event) => {
                set({ unitPrice: event.target.value });
              }}
            />
            <FieldDescription>
              <Trans>The price of one, before tax.</Trans>
            </FieldDescription>
            <FieldError />
          </Field>
          <Field name="currency">
            <FieldLabel>
              <Trans>Currency</Trans>
            </FieldLabel>
            <Input
              required
              maxLength={3}
              autoComplete="off"
              list={currenciesId}
              value={draft.currency}
              onChange={(event) => {
                set({ currency: event.target.value.toUpperCase() });
              }}
            />
            <FieldError />
          </Field>
          <Field name="taxRate">
            <FieldLabel>
              <Trans>Tax rate (%)</Trans>
            </FieldLabel>
            <Input
              inputMode="decimal"
              maxLength={8}
              autoComplete="off"
              value={draft.taxRate}
              onChange={(event) => {
                set({ taxRate: event.target.value });
              }}
            />
            <FieldDescription>
              <Trans>Leave empty to use the business's default rate.</Trans>
            </FieldDescription>
            <FieldError />
          </Field>
        </div>
        <datalist id={unitsId}>
          {PRODUCT_UNIT_SUGGESTIONS.map((unit) => (
            <option key={unit} value={unit} />
          ))}
        </datalist>
        <datalist id={currenciesId}>
          {Intl.supportedValuesOf('currency').map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
        <FormProblem
          problem={problem}
          stale={isStale(save.error)}
          busy={reload.isPending}
          onReload={() => {
            reload.mutate();
          }}
        />
      </div>
      <div className={sidePanelFooterClassName}>
        <Button
          variant="secondary"
          disabled={save.isPending}
          onClick={() => {
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!ready}>
          {save.isPending ? (
            <Trans>Saving…</Trans>
          ) : current === undefined ? (
            <Trans>Add product</Trans>
          ) : (
            <Trans>Save changes</Trans>
          )}
        </Button>
      </div>
    </Form>
  );
}
