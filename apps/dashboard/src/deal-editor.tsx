// What the opportunity dialog holds under its title: the sections in a column at the left,
// the open section in the middle, and the buttons at the foot. Only what the server has is
// here: the opportunity's own details and fields, its contacts, owner and followers
// (deal-people.tsx, fetched after the form), its tasks, its notes and its activity. The
// form chooses the pipeline too, with the stages following it, and shows the probability:
// the opportunity's own where its pipeline says opportunities carry theirs, else its
// stage's, read only. Its quotes and invoices fold away under the details
// (deal-documents.tsx). Appointments and associated objects have nothing behind them yet.
import { Select } from '@repo/ui/components/select';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createDeal,
  createDealInput,
  DEAL_SOURCE_MAX_LENGTH,
  trashDeal,
  updateDeal,
  type Deal,
  type Pipeline,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { lazy, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { PanelFrame, RecordFields } from './contact-panels';
import type { PickedContact } from './deal-contact-search';
import { DealDocumentsSection } from './deal-documents';
import { probabilityOf } from './deal-presentation';
import { dealSections, type DealSection } from './deal-search';
import { PanelContent } from './list-toolbar';
import { probabilityIsValid, probabilityTyped } from './pipeline-rules';

const People = lazy(() => import('./deal-people'));
const ContactSearch = lazy(() => import('./deal-contact-search'));
// The three sections beside the details: each is fetched when it is first opened, and
// stays as it was left after that (a half-written note is still there on coming back).
const RecordTasks = lazy(async () => ({ default: (await import('./record-tasks')).RecordTasks }));
const RecordNotes = lazy(async () => ({ default: (await import('./record-notes')).RecordNotes }));
const RecordActivity = lazy(async () => ({
  default: (await import('./record-activity')).RecordActivity,
}));

const sectionLinkClassName =
  'flex min-h-11 shrink-0 items-center rounded-control px-3 text-left text-sm font-medium whitespace-nowrap text-body -outline-offset-2 hover:bg-muted hover:text-foreground aria-[current=true]:bg-accent aria-[current=true]:text-link lg:min-h-9';

export default function DealEditor({
  deal,
  pipeline,
  pipelines,
  contact: givenContact,
  businessId,
  section,
  onSection,
  onClose,
  onSaved,
  onTrashed,
  onDirtyChange,
}: {
  readonly deal: Deal | undefined;
  /** The pipeline it is in, or the one a new opportunity starts in. */
  readonly pipeline: Pipeline;
  /** Every pipeline, to move it to another: the ones in use are offered. */
  readonly pipelines: readonly Pipeline[];
  /** The primary contact a new opportunity starts with, when it is added from a contact. */
  readonly contact?: PickedContact | undefined;
  readonly businessId: string;
  /** The part that shows; a new opportunity has only its details. */
  readonly section: DealSection;
  readonly onSection: (section: DealSection) => void;
  readonly onClose: () => void;
  readonly onSaved: (deal: Deal) => void;
  readonly onTrashed: (deal: Deal) => void;
  /** Whether the details hold changes that have not been saved. */
  readonly onDirtyChange: (dirty: boolean) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const formId = useId();
  // Someone who may not change it, or an opportunity in the trash, sees it without changing it.
  const trashed = deal !== undefined && deal.trashedAt !== null;
  const readOnly = deal !== undefined && (!deal.canManage || trashed);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (readOnly ? closeRef : inputRef).current?.focus();
  }, [readOnly]);
  const initial = {
    name: deal?.name ?? '',
    probability:
      deal?.probability === undefined || deal.probability === null ? '' : String(deal.probability),
    stageId: deal?.stageId ?? pipeline.stages.find((stage) => !stage.archived)?.id ?? '',
    amount: deal?.amount ?? '',
    currency: deal?.currency ?? 'KES',
    date: deal?.expectedCloseDate ?? '',
    status: deal?.status ?? 'open',
    reason: deal?.outcomeReason ?? '',
    source: deal?.source ?? '',
  };
  const [name, setName] = useState(initial.name);
  const [pipelineId, setPipelineId] = useState(pipeline.id);
  const [stageId, setStageId] = useState(initial.stageId);
  const [probability, setProbability] = useState(initial.probability);
  const chosen = pipelines.find((each) => each.id === pipelineId) ?? pipeline;
  // A pipeline can take an opportunity when it is in use and has a stage that is.
  const offered = [
    ...(pipelines.some((each) => each.id === pipeline.id) ? [] : [pipeline]),
    ...pipelines.filter(
      (each) =>
        each.id === pipeline.id || (!each.archived && each.stages.some((stage) => !stage.archived)),
    ),
  ];
  const ownProbability = chosen.dealProbability === true;
  const stageProbability = probabilityOf({ stages: chosen.stages }, { stageId });
  const probabilityWrong = ownProbability && !probabilityIsValid(probability);
  const [amount, setAmount] = useState(initial.amount);
  const [currency, setCurrency] = useState(initial.currency);
  const [date, setDate] = useState(initial.date);
  const [status, setStatus] = useState<Deal['status']>(initial.status);
  const [reason, setReason] = useState(initial.reason);
  const [source, setSource] = useState(initial.source);
  // A new opportunity can name its primary contact as it is made; one that exists has its
  // contacts, owner and followers saved by themselves, below the form.
  const [contact, setContact] = useState(givenContact);
  const [peoplePending, setPeoplePending] = useState(false);
  const [error, setError] = useState<string>();
  const dirty =
    !readOnly &&
    (name !== initial.name ||
      pipelineId !== pipeline.id ||
      probability !== initial.probability ||
      stageId !== initial.stageId ||
      amount !== initial.amount ||
      currency !== initial.currency ||
      date !== initial.date ||
      status !== initial.status ||
      reason !== initial.reason ||
      source !== initial.source ||
      contact?.id !== givenContact?.id);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const client = apiIn(businessId);
  const save = useMutation({
    mutationFn: async () => {
      if (probabilityWrong) throw new Error(t`Enter a probability from 0 to 100.`);
      const parsed = createDealInput.safeParse({
        name,
        pipelineId: chosen.id,
        stageId,
        // Sent only where the pipeline reads it: left out, the server keeps what it has.
        ...(ownProbability ? { probability: probability === '' ? null : Number(probability) } : {}),
        amount: amount.trim() || null,
        currency: currency.trim().toUpperCase(),
        expectedCloseDate: date || null,
        status,
        outcomeReason: status === 'open' ? null : reason.trim() || null,
        // Shown here, so this form owns it: emptied, the opportunity has no source.
        source: source.trim() || null,
        ...(deal === undefined && contact !== undefined ? { primaryContactId: contact.id } : {}),
      });
      if (!parsed.success)
        throw new Error(parsed.error.issues.map((issue) => issue.message).join(' '));
      return deal === undefined
        ? client.request(createDeal, { body: parsed.data })
        : client.request(updateDeal, {
            params: { id: deal.id },
            body: { ...parsed.data, revision: deal.revision },
          });
    },
    onSuccess: onSaved,
    onError: (failure) => {
      setError(
        failure instanceof ApiError
          ? failure.message
          : failure instanceof Error
            ? failure.message
            : t`We couldn't save the opportunity.`,
      );
    },
  });
  const trash = useMutation({
    mutationFn: (current: Deal) => client.request(trashDeal, { params: { id: current.id } }),
    onSuccess: onTrashed,
    onError: (failure) => {
      setError(
        failure instanceof ApiError
          ? failure.message
          : t`We couldn't move the opportunity to the trash. Try again.`,
      );
    },
  });
  const busy = save.isPending || trash.isPending || peoplePending;
  const labels: Readonly<Record<DealSection, string>> = {
    details: t`Opportunity details`,
    tasks: t`Tasks`,
    notes: t`Notes`,
    activity: t`Activity`,
  };
  const sections = deal === undefined ? (['details'] as const) : dealSections;
  const shown = sections.find((each) => each === section) ?? 'details';
  // The sections opened so far in this dialog.
  const [opened, setOpened] = useState<readonly DealSection[]>([shown]);
  if (!opened.includes(shown)) setOpened([...opened, shown]);
  const created =
    deal === undefined
      ? undefined
      : new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(deal.createdAt),
        );
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label={t`Opportunity sections`}
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2 sm:w-52 sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:px-3 sm:py-4"
        >
          {sections.map((each) => (
            <button
              key={each}
              type="button"
              className={sectionLinkClassName}
              aria-current={each === shown ? 'true' : undefined}
              onClick={() => {
                onSection(each);
              }}
            >
              {labels[each]}
            </button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <div className={shown === 'details' ? 'flex min-w-0 flex-col gap-6' : 'hidden'}>
            <form
              id={formId}
              aria-label={labels.details}
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (readOnly || busy) return;
                setError(undefined);
                save.mutate();
              }}
            >
              {trashed ? (
                <p className="text-sm text-body sm:col-span-2">
                  <Trans>
                    This opportunity is in the trash. Restore it from the trash to change it.
                  </Trans>
                </p>
              ) : null}
              {deal !== undefined ? null : (
                <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
                  <span className="text-sm font-medium">
                    <Trans>Primary contact</Trans>
                  </span>
                  {contact === undefined ? (
                    <PanelContent>
                      <ContactSearch
                        businessId={businessId}
                        label={t`Search for a primary contact`}
                        excluded={[]}
                        disabled={busy}
                        onPick={setContact}
                      />
                    </PanelContent>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2 rounded-control border border-border px-3 py-1.5">
                      <span className="min-w-0 flex-1 text-sm wrap-anywhere">{contact.name}</span>
                      <Button
                        variant="quiet"
                        size="small"
                        className="shrink-0 px-2.5"
                        aria-label={t`Remove the primary contact`}
                        disabled={busy}
                        onClick={() => {
                          setContact(undefined);
                        }}
                      >
                        <X aria-hidden className="size-4" strokeWidth={1.8} />
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor={`${formId}-name`}>
                  <Trans>Opportunity name</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-name`}
                  ref={inputRef}
                  data-initial-focus
                  value={name}
                  disabled={readOnly}
                  required
                  maxLength={200}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </Field>
              <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                <Trans>Pipeline</Trans>
                <Select
                  aria-label={t`Pipeline`}
                  value={chosen.id}
                  disabled={readOnly || busy}
                  required
                  onValueChange={(selectedValue) => {
                    const next = pipelines.find((each) => each.id === selectedValue);
                    if (next === undefined || next.id === chosen.id) return;
                    setPipelineId(next.id);
                    // The stages follow the pipeline: back in its own, the stage it had.
                    setStageId(
                      next.id === pipeline.id
                        ? initial.stageId
                        : (next.stages.find((stage) => !stage.archived)?.id ?? ''),
                    );
                  }}
                >
                  {offered.map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name}
                      {each.archived ? t` (archived)` : ''}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                <Trans>Stage</Trans>
                <Select
                  // The stages are another pipeline's once it changes: the list starts again.
                  key={chosen.id}
                  value={stageId}
                  disabled={readOnly}
                  required
                  onValueChange={(selectedValue) => {
                    setStageId(selectedValue);
                  }}
                >
                  {chosen.stages
                    .filter((stage) => !stage.archived || stage.id === deal?.stageId)
                    .map((stage) => (
                      <option key={stage.id} value={stage.id}>
                        {stage.name}
                      </option>
                    ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                <Trans>Status</Trans>
                <Select
                  aria-label={t`Status`}
                  value={status}
                  disabled={readOnly}
                  onValueChange={(selectedValue) => {
                    setStatus(selectedValue as Deal['status']);
                  }}
                >
                  <option value="open">{t`Open`}</option>
                  <option value="won">{t`Won`}</option>
                  <option value="lost">{t`Lost`}</option>
                </Select>
              </label>
              <Field>
                <FieldLabel htmlFor={`${formId}-value`}>
                  <Trans>Value</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-value`}
                  inputMode="decimal"
                  value={amount}
                  // Read, not disabled, for someone who may not change it: the keyboard can
                  // still come here, so the dialog's content can be scrolled by keyboard.
                  readOnly={readOnly}
                  className="read-only:bg-muted"
                  onChange={(event) => {
                    setAmount(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-currency`}>
                  <Trans>Currency</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-currency`}
                  value={currency}
                  disabled={readOnly}
                  required
                  maxLength={3}
                  onChange={(event) => {
                    setCurrency(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-close`}>
                  <Trans>Expected close date</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-close`}
                  type="date"
                  value={date}
                  disabled={readOnly}
                  onChange={(event) => {
                    setDate(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-source`}>
                  <Trans>Source</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-source`}
                  value={source}
                  disabled={readOnly}
                  maxLength={DEAL_SOURCE_MAX_LENGTH}
                  onChange={(event) => {
                    setSource(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-probability`}>
                  <Trans>Probability (%)</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-probability`}
                  inputMode="numeric"
                  autoComplete="off"
                  // The stage's is read, never typed: the keyboard can still come here.
                  readOnly={readOnly || !ownProbability}
                  aria-invalid={probabilityWrong || undefined}
                  aria-describedby={`${formId}-probability-note`}
                  className="read-only:bg-muted aria-invalid:border-destructive"
                  value={
                    ownProbability
                      ? probability
                      : stageProbability === undefined
                        ? ''
                        : String(stageProbability)
                  }
                  onChange={(event) => {
                    setProbability(probabilityTyped(event.target.value));
                  }}
                />
                <p
                  id={`${formId}-probability-note`}
                  className={`text-xs ${probabilityWrong ? 'font-medium text-destructive' : 'text-muted-foreground'}`}
                >
                  {probabilityWrong ? (
                    <Trans>Enter 0 to 100.</Trans>
                  ) : ownProbability ? (
                    <Trans>This pipeline uses each opportunity's own probability.</Trans>
                  ) : stageProbability === undefined ? (
                    <Trans>From the stage, which has none set.</Trans>
                  ) : (
                    <Trans>From the stage. This pipeline uses stage probability.</Trans>
                  )}
                </p>
              </Field>
              {status === 'open' ? null : (
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor={`${formId}-reason`}>
                    <Trans>Status reason</Trans>
                  </FieldLabel>
                  <Textarea
                    id={`${formId}-reason`}
                    value={reason}
                    disabled={readOnly}
                    required={status === 'lost'}
                    maxLength={2000}
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                </Field>
              )}
            </form>
            {deal === undefined ? null : (
              <>
                <PanelContent>
                  <People
                    key={`${businessId}:${deal.id}:people`}
                    businessId={businessId}
                    dealId={deal.id}
                    readOnly={readOnly}
                    onPendingChange={setPeoplePending}
                  />
                </PanelContent>
                <PanelFrame frame="plain">
                  <RecordFields recordId={deal.id} readOnly={trashed} />
                </PanelFrame>
                <DealDocumentsSection businessId={businessId} dealId={deal.id} readOnly={trashed} />
              </>
            )}
          </div>
          {deal === undefined ? null : (
            <PanelFrame frame="plain">
              <div className={shown === 'tasks' ? 'block' : 'hidden'}>
                {opened.includes('tasks') ? (
                  <PanelContent>
                    <RecordTasks
                      key={`${businessId}:${deal.id}:tasks`}
                      recordId={deal.id}
                      readOnly={trashed}
                    />
                  </PanelContent>
                ) : null}
              </div>
              <div className={shown === 'notes' ? 'block' : 'hidden'}>
                {opened.includes('notes') ? (
                  <PanelContent>
                    <RecordNotes
                      key={`${businessId}:${deal.id}:notes`}
                      recordId={deal.id}
                      readOnly={trashed}
                    />
                  </PanelContent>
                ) : null}
              </div>
              <div className={shown === 'activity' ? 'block' : 'hidden'}>
                {opened.includes('activity') ? (
                  <PanelContent>
                    <RecordActivity key={`${businessId}:${deal.id}:activity`} recordId={deal.id} />
                  </PanelContent>
                ) : null}
              </div>
            </PanelFrame>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <p className="min-w-0 text-sm text-muted-foreground">
          {created === undefined ? null : <Trans>Created on {created}</Trans>}
        </p>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {error === undefined ? null : (
            <p role="alert" className="basis-full text-right text-sm text-destructive">
              {error}
            </p>
          )}
          {deal === undefined || readOnly ? null : (
            <Button
              variant="secondary"
              className="border-destructive text-destructive"
              disabled={busy}
              onClick={() => {
                setError(undefined);
                trash.mutate(deal);
              }}
            >
              {trash.isPending ? <Trans>Moving to trash…</Trans> : <Trans>Move to trash</Trans>}
            </Button>
          )}
          <Button ref={closeRef} variant="secondary" disabled={busy} onClick={onClose}>
            {readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
          </Button>
          {readOnly || shown !== 'details' ? null : (
            <Button type="submit" form={formId} disabled={busy}>
              {save.isPending ? (
                <Trans>Saving…</Trans>
              ) : deal === undefined ? (
                <Trans>Create</Trans>
              ) : (
                <Trans>Update</Trans>
              )}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
