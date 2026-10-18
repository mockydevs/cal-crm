import {
  DragDropProvider,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
} from '@dnd-kit/react';
import { Accessibility, defaultPreset } from '@dnd-kit/dom';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { Deal, DealStageSummary, Pipeline } from '@repo/contracts';
import { Avatar } from '@repo/ui/components/avatar';
import { getRouteApi, Link } from '@tanstack/react-router';
import {
  ClipboardCheck,
  GripVertical,
  MessageSquare,
  StickyNote,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { tintOf } from './avatar-tint';
import { contactNameOf, DealTags, StageName, useOwnerName } from './deal-extras';
import { amountOf, stageMarkOf, stageTotals, type StageMark } from './deal-presentation';
import { DealStatus } from './deal-status';
import { initialsOf, useBusiness } from './workspace';

const dealsRoute = getRouteApi('/_app/b/$slug/deals');

// A column is 308px wide with 12px between columns, as GoHighLevel's board has them: room
// for a card's labelled rows and its row of quick actions. One press of an arrow key
// carries a card that far, to the column beside it. More stages than fit scroll sideways.
const sensors = [PointerSensor, KeyboardSensor.configure({ offset: { x: 320, y: 40 } })];

const quickActionClassName =
  'flex size-11 shrink-0 items-center justify-center rounded-control text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:size-8';

export default function DealBoard({
  pipeline,
  deals,
  visible,
  canManage,
  pending,
  counted,
  onMove,
}: {
  readonly pipeline: Pipeline;
  readonly deals: Deal[];
  readonly visible: Deal[];
  readonly canManage: boolean;
  readonly pending: boolean;
  /**
   * Each stage's count and totals from the server, for a pipeline with more opportunities
   * than have loaded. Left out, a column counts and totals the cards it shows.
   */
  readonly counted?: DealStageSummary['stages'] | undefined;
  readonly onMove: (change: { deal: Deal; stageId: string; stageName: string }) => void;
}): ReactElement {
  const { t } = useLingui();
  const stages = pipeline.stages;
  const plugins = defaultPreset.plugins.map((plugin) =>
    plugin === Accessibility
      ? {
          plugin: Accessibility,
          options: {
            screenReaderInstructions: {
              draggable: t`Press Space to pick up an opportunity. Use Left and Right to choose a stage. Press Space to drop, or Escape to cancel.`,
            },
            announcements: {
              dragstart: () => t`Opportunity picked up. Use Left and Right to choose a stage.`,
              dragover: ({
                operation,
              }: {
                operation: { target?: { id: string | number } | null };
              }) => {
                const stage = stages.find((item) => item.id === operation.target?.id);
                const name = stage?.name;
                return name === undefined ? t`No stage selected.` : t`Over ${name}.`;
              },
              dragend: ({ canceled }: { canceled: boolean }) =>
                canceled ? t`Move cancelled.` : t`Opportunity dropped. Saving the stage.`,
            },
          },
        }
      : plugin,
  );
  return (
    <DragDropProvider
      sensors={sensors}
      plugins={plugins}
      onDragEnd={(event) => {
        if (event.canceled || pending) return;
        const deal = deals.find((item) => item.id === event.operation.source?.id);
        const stage = stages.find((item) => item.id === event.operation.target?.id);
        if (
          deal !== undefined &&
          stage !== undefined &&
          deal.canManage &&
          !pipeline.archived &&
          !stage.archived &&
          deal.stageId !== stage.id
        )
          onMove({ deal, stageId: stage.id, stageName: stage.name });
      }}
    >
      <div
        className="max-w-full overflow-x-auto rounded-card bg-panel p-2 pb-3"
        role="region"
        aria-label={t`Opportunities board`}
      >
        <div className="flex items-start gap-3">
          {stages
            .filter((stage) => !stage.archived || visible.some((deal) => deal.stageId === stage.id))
            .map((stage) => (
              <StageColumn
                key={stage.id}
                stage={stage}
                mark={stageMarkOf(pipeline, stage.id)}
                disabled={!canManage || pipeline.archived || stage.archived}
                saving={pending}
                deals={visible.filter((deal) => deal.stageId === stage.id)}
                counted={counted?.find((each) => each.stageId === stage.id)}
              />
            ))}
        </div>
      </div>
    </DragDropProvider>
  );
}
function StageColumn({
  stage,
  mark,
  deals,
  counted,
  disabled,
  saving,
}: {
  readonly stage: Pipeline['stages'][number];
  /** The stage's colour as the pipeline draws it: a dot before the name, or the header tinted. */
  readonly mark: StageMark;
  readonly deals: Deal[];
  readonly counted: DealStageSummary['stages'][number] | undefined;
  /** Nothing may be moved here at all: no permission, or the stage or pipeline is archived. */
  readonly disabled: boolean;
  /** A move is being saved: nothing more moves until it is. */
  readonly saving: boolean;
}): ReactElement {
  const { t } = useLingui();
  const { ref, isDropTarget } = useDroppable({ id: stage.id, disabled: disabled || saving });
  const count = counted?.count ?? deals.length;
  const totals = counted === undefined ? stageTotals(deals) : counted.totals.map(amountOf);
  return (
    <section
      ref={ref}
      aria-label={stage.name}
      className={`flex min-h-60 w-[308px] shrink-0 flex-col gap-2.5 rounded-lg border p-1 ${isDropTarget ? 'border-primary bg-accent' : 'border-transparent'}`}
    >
      <div className="rounded-lg border border-border bg-card shadow-xs">
        <div
          data-stage-color={mark.tint === undefined ? undefined : 'tint'}
          className="flex flex-col gap-1 rounded-[inherit] px-3 py-2.5"
          style={mark.tint === undefined ? undefined : { backgroundColor: mark.tint }}
        >
          <h2 className="text-md font-semibold wrap-break-word">
            <StageName mark={mark.dot === undefined ? {} : mark}>
              {stage.name}
              {stage.archived ? t` (archived)` : ''}
            </StageName>
          </h2>
          <p className="flex flex-wrap gap-x-2 text-xs text-body">
            <span>
              <Plural value={count} one="# opportunity" other="# opportunities" />
            </span>
            {totals.map((total) => (
              <span key={total} className="font-medium text-foreground">
                {total}
              </span>
            ))}
          </p>
        </div>
      </div>
      {deals.map((deal) => (
        <DealCard
          key={deal.id}
          deal={deal}
          disabled={disabled || !deal.canManage}
          saving={saving}
        />
      ))}
    </section>
  );
}
function DealCard({
  deal,
  disabled,
  saving,
}: {
  readonly deal: Deal;
  readonly disabled: boolean;
  readonly saving: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const name = deal.name;
  const ownerName = useOwnerName();
  const contactName = contactNameOf(deal);
  const contact = deal.primaryContact ?? null;
  const owner = deal.owner ?? null;
  const ownedBy = owner === null ? undefined : ownerName(owner);
  const { ref, handleRef, isDragging } = useDraggable({
    id: deal.id,
    disabled: disabled || saving,
  });
  const won = deal.status === 'won';
  const row = (label: ReactNode, value: ReactNode, strong = false) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 wrap-anywhere ${strong ? 'font-medium text-foreground' : 'text-body'}`}
      >
        {value}
      </dd>
    </>
  );
  /** A quick action that opens a part of this opportunity over the board. */
  const opens = (section: 'tasks' | 'notes', label: string, Icon: LucideIcon) => (
    <dealsRoute.Link
      search={(previous) => ({ ...previous, deal: deal.id, section })}
      aria-label={label}
      title={label}
      className={quickActionClassName}
    >
      <Icon aria-hidden className="size-[18px]" strokeWidth={1.7} />
    </dealsRoute.Link>
  );
  return (
    <article
      ref={ref}
      className={`flex flex-col gap-2.5 rounded-lg border p-3 shadow-xs transition-shadow hover:shadow-sm ${won ? 'border-success-line bg-success-subtle' : 'border-border bg-card'} ${isDragging ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-md leading-snug font-medium wrap-anywhere">
          <dealsRoute.Link
            search={(previous) => ({ ...previous, deal: deal.id })}
            className="text-foreground underline-offset-2 hover:text-link hover:underline"
          >
            {deal.name}
          </dealsRoute.Link>
        </h3>
        {deal.status === 'open' ? null : <DealStatus status={deal.status} />}
        {/* Who owns it, at a glance: their initials, or an empty circle when nobody does. */}
        {deal.owner === undefined ? null : ownedBy === undefined || owner === null ? (
          <span
            role="img"
            aria-label={t`No owner`}
            title={t`No owner`}
            className="flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-input text-muted-foreground"
          >
            <UserRound aria-hidden className="size-3.5" strokeWidth={1.8} />
          </span>
        ) : (
          <span title={t`Owner: ${ownedBy}`} className="shrink-0">
            <Avatar
              size="small"
              className="size-7 text-[11px]"
              tint={tintOf(owner.membershipId ?? ownedBy)}
              fallback={initialsOf(ownedBy, '?')}
            />
            <span className="sr-only">{t`Owner: ${ownedBy}`}</span>
          </span>
        )}
        {deal.canManage ? (
          <button
            ref={handleRef}
            type="button"
            // While a move is being saved the grip can't start another (the draggable is
            // off, and marks the grip aria-disabled), but it stays a real, focusable
            // button: after a keyboard move the keyboard is put back on it, a frame after
            // the drop, and a button disabled for the save can't take it. The focus was
            // lost whenever the save outlasted the drop animation, and always for people
            // who ask for reduced motion, who get no animation.
            disabled={disabled}
            aria-label={t`Move ${name}`}
            className="-my-1.5 -mr-1.5 flex size-11 shrink-0 touch-none items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 aria-disabled:opacity-40 lg:size-8"
          >
            <GripVertical size={16} aria-hidden />
          </button>
        ) : null}
      </div>
      <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-sm">
        {contactName === undefined ? null : row(<Trans>Contact:</Trans>, contactName)}
        {deal.source === undefined || deal.source === null
          ? null
          : row(<Trans>Source:</Trans>, deal.source)}
        {row(<Trans>Value:</Trans>, amountOf(deal), true)}
        {deal.expectedCloseDate === null
          ? null
          : row(<Trans>Expected close:</Trans>, deal.expectedCloseDate)}
      </dl>
      <DealTags tags={deal.tags} />
      <div className="-mx-1 -mb-1 flex items-center gap-0.5 border-t border-border pt-1.5">
        {contact === null || contactName === undefined ? null : (
          <Link
            to="/b/$slug/contacts/$contactId"
            params={{ slug: business.slug, contactId: contact.id }}
            search={{ view: 'conversation' }}
            aria-label={t`Conversation with ${contactName}`}
            title={t`Conversation with ${contactName}`}
            className={quickActionClassName}
          >
            <MessageSquare aria-hidden className="size-[18px]" strokeWidth={1.7} />
          </Link>
        )}
        {opens('tasks', t`Tasks of ${name}`, ClipboardCheck)}
        {opens('notes', t`Notes of ${name}`, StickyNote)}
      </div>
    </article>
  );
}
