// Contacts → Opportunity on the contacts selected: one opportunity each, in the pipeline
// and stage chosen (the pipeline's first stage unless one is), named after its contact
// unless a name is given, as GoHighLevel's Create Opportunity does; a contact that already
// has one is skipped unless duplicates are allowed.
import { Trans, useLingui } from '@lingui/react/macro';
import { getPipelines } from '@repo/contracts';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';

import { apiIn } from '../api';
import { BulkDialogShell, checkClassName, labelClassName, type BulkDialogProps } from './parts';

export default function OpportunityDialog(props: BulkDialogProps): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState('');
  const [won, setWon] = useState(false);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const pipelines = useQuery({
    queryKey: ['b', props.businessId, 'pipelines'],
    queryFn: () => apiIn(props.businessId).request(getPipelines, {}),
  });
  const usable = (pipelines.data?.items ?? []).filter(
    (each) => !each.archived && each.stages.some((stage) => !stage.archived),
  );
  const pipeline = usable.find((each) => each.id === pipelineId) ?? usable[0];
  const stages = pipeline?.stages.filter((stage) => !stage.archived) ?? [];
  const field = (
    key: string,
    label: string,
    value: string,
    set: (next: string) => void,
    extra = {},
  ) => (
    <Field>
      <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
      <Input
        id={`${id}-${key}`}
        value={value}
        onChange={(event) => {
          set(event.target.value);
        }}
        {...extra}
      />
    </Field>
  );
  return (
    <BulkDialogShell
      {...props}
      title={t`Add opportunity`}
      description={t`Each gets an opportunity of its own.`}
      timing
      missing={pipeline === undefined ? t`Choose a pipeline.` : undefined}
      confirm="apply"
      bodyOf={(common) => ({
        action: 'add_opportunity',
        pipelineId: pipeline?.id ?? '',
        ...(stageId === '' ? {} : { stageId }),
        ...(name.trim() === '' ? {} : { opportunityName: name.trim() }),
        status: won ? 'won' : 'open',
        ...(amount.trim() === '' ? {} : { amount: amount.trim() }),
        ...(source.trim() === '' ? {} : { source: source.trim() }),
        allowDuplicates,
        ...common,
      })}
    >
      {(pending) =>
        pipelines.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading pipelines…</Trans>
          </p>
        ) : pipeline === undefined ? (
          <p role="alert" className="text-sm">
            <Trans>There is no pipeline with a stage in use yet. Add one in Settings.</Trans>
          </p>
        ) : (
          <>
            <label className={labelClassName}>
              <Trans>Pipeline</Trans>
              <Select
                aria-label={t`Pipeline`}
                value={pipeline.id}
                disabled={pending}
                onValueChange={(next) => {
                  setPipelineId(next);
                  setStageId('');
                }}
              >
                {usable.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClassName}>
              <Trans>Stage</Trans>
              <Select
                aria-label={t`Stage`}
                value={stageId}
                disabled={pending}
                onValueChange={setStageId}
              >
                <option value="">{t`The pipeline's first stage`}</option>
                {stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </Select>
            </label>
            {field('name', t`Opportunity name (optional)`, name, setName, {
              maxLength: 200,
              disabled: pending,
              placeholder: t`Each contact's name`,
            })}
            {field('amount', t`Opportunity value (optional)`, amount, setAmount, {
              inputMode: 'decimal',
              disabled: pending,
            })}
            {field('source', t`Opportunity source (optional)`, source, setSource, {
              maxLength: 200,
              disabled: pending,
            })}
            <label className={checkClassName}>
              <input
                type="checkbox"
                className="size-5 accent-primary"
                checked={won}
                disabled={pending}
                onChange={(event) => {
                  setWon(event.target.checked);
                }}
              />
              <Trans>Mark as won</Trans>
            </label>
            <label className={checkClassName}>
              <input
                type="checkbox"
                className="size-5 accent-primary"
                checked={allowDuplicates}
                disabled={pending}
                onChange={(event) => {
                  setAllowDuplicates(event.target.checked);
                }}
              />
              <Trans>Allow duplicates: add one even to a contact that already has one</Trans>
            </label>
          </>
        )
      }
    </BulkDialogShell>
  );
}
