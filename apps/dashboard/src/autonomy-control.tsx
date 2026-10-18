// The autonomy control: how much an assistant does on its own, as three choices: Suggest,
// Ask first, Act. It is the same control wherever it shows: for one contact, beside their
// conversation, and for the whole business, in Settings. "Act" lets the assistant send
// without anyone looking first, so choosing it asks once more before anything is saved.
// Someone who may not change the level reads it as a sentence.
import { Trans, useLingui } from '@lingui/react/macro';
import { autonomyLevels, type AutonomyLevel } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';

export interface AutonomyControlProps {
  /** The id of the heading that names the control. */
  readonly labelledBy: string;
  readonly level: AutonomyLevel;
  /** Who the level is for, as a sentence names them; undefined for the whole business. */
  readonly who: string | undefined;
  readonly canChange: boolean;
  /**
   * The business's level, when this contact has a level of their own to give up for it.
   * Undefined where there is nothing to go back to.
   */
  readonly businessLevel?: AutonomyLevel | undefined;
  /** Saves a level; null gives up the contact's own. Rejects when it wasn't saved. */
  readonly onSet: (level: AutonomyLevel | null) => Promise<unknown>;
}

type Outcome =
  | { readonly kind: 'saved'; readonly reset: boolean }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed'; readonly message: string | undefined };

export function AutonomyControl({
  labelledBy,
  level,
  who,
  canChange,
  businessLevel,
  onSet,
}: AutonomyControlProps): ReactElement {
  const { t } = useLingui();
  const helpId = useId();
  const questionId = useId();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const levelsRef = useRef<Partial<Record<AutonomyLevel, HTMLButtonElement | null>>>({});
  const questionRef = useRef<HTMLParagraphElement>(null);
  // One save at a time, whatever a second click arrives before.
  const inFlightRef = useRef(false);
  // Asking "are you sure?" moves the keyboard to the question, and answering it, back to
  // Act. Giving up a contact's own level removes the button that did it: the keyboard then
  // goes to the business's level, which is the one that now applies. It moves once the
  // page shows where it is going.
  const moveRef = useRef<'question' | AutonomyLevel | undefined>(undefined);
  const [moves, setMoves] = useState(0);
  const moveTo = (where: 'question' | AutonomyLevel): void => {
    moveRef.current = where;
    setMoves((count) => count + 1);
  };
  useEffect(() => {
    const move = moveRef.current;
    moveRef.current = undefined;
    if (move === 'question') questionRef.current?.focus();
    else if (move !== undefined) levelsRef.current[move]?.focus();
  }, [moves]);

  const names = {
    suggest: t`Suggest`,
    ask: t`Ask first`,
    act: t`Act`,
  } satisfies Record<AutonomyLevel, string>;
  const help = {
    suggest: t`Writes drafts for you to send yourself.`,
    ask: t`Writes replies and asks you before sending.`,
    act: t`Replies on its own and tells you what it sent.`,
  } satisfies Record<AutonomyLevel, string>;
  const sentences =
    who === undefined
      ? ({
          suggest: t`Your assistant writes drafts for you to send yourself.`,
          ask: t`Your assistant asks before sending anything.`,
          act: t`Your assistant replies on its own and tells you what it sent.`,
        } satisfies Record<AutonomyLevel, string>)
      : ({
          suggest: t`Your assistant writes drafts for ${who}, for you to send yourself.`,
          ask: t`Your assistant asks before sending anything to ${who}.`,
          act: t`Your assistant replies to ${who} on its own and tells you what it sent.`,
        } satisfies Record<AutonomyLevel, string>);

  if (!canChange) return <p className="text-sm text-muted-foreground">{sentences[level]}</p>;

  const save = (next: AutonomyLevel | null): void => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSaving(true);
    setOutcome(undefined);
    onSet(next)
      .then(() => {
        setOutcome({ kind: 'saved', reset: next === null });
        if (next === null && businessLevel !== undefined) moveTo(businessLevel);
      })
      .catch((error: unknown) => {
        setOutcome(
          error instanceof ApiError && error.status === 403
            ? { kind: 'forbidden' }
            : { kind: 'failed', message: error instanceof ApiError ? error.message : undefined },
        );
      })
      .finally(() => {
        inFlightRef.current = false;
        setSaving(false);
      });
  };
  const choose = (next: AutonomyLevel): void => {
    if (inFlightRef.current) return;
    if (next === 'act' && level !== 'act') {
      setOutcome(undefined);
      setConfirming(true);
      moveTo('question');
      return;
    }
    setConfirming(false);
    if (next !== level) save(next);
  };
  const answer = (yes: boolean): void => {
    setConfirming(false);
    moveTo('act');
    if (yes) save('act');
  };
  const businessName = businessLevel === undefined ? '' : names[businessLevel];
  const sentence = sentences[level];

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        role="group"
        aria-labelledby={labelledBy}
        aria-describedby={helpId}
        className="flex min-w-0 gap-1 rounded-full bg-muted p-1"
      >
        {autonomyLevels.map((each) => (
          <button
            key={each}
            ref={(element) => {
              levelsRef.current[each] = element;
            }}
            type="button"
            aria-pressed={level === each}
            aria-disabled={saving}
            className={`min-h-10 min-w-0 flex-1 rounded-full px-2 text-sm whitespace-nowrap aria-disabled:opacity-60 ${
              level === each
                ? 'bg-card font-semibold text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              choose(each);
            }}
          >
            {names[each]}
          </button>
        ))}
      </div>
      <p id={helpId} className="text-[13px] text-muted-foreground">
        {help[level]}
      </p>
      {confirming ? (
        <div
          role="group"
          aria-labelledby={questionId}
          className="flex min-w-0 flex-col items-start gap-2 rounded-control border border-attention-foreground bg-attention p-3 text-sm text-attention-foreground"
        >
          <p
            id={questionId}
            ref={questionRef}
            tabIndex={-1}
            className="font-medium focus:outline-none focus-visible:outline-2"
          >
            {who === undefined
              ? t`Your assistant will send replies to contacts without asking, unless a contact has a setting of their own.`
              : t`Your assistant will send replies to ${who} without asking.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              onClick={() => {
                answer(true);
              }}
            >
              <Trans>Let it act</Trans>
            </Button>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                answer(false);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : null}
      {businessLevel === undefined ? null : (
        <Button
          variant="quiet"
          size="small"
          className="self-start aria-disabled:opacity-60"
          disabled={saving}
          focusableWhenDisabled
          onClick={() => {
            setConfirming(false);
            save(null);
          }}
        >
          {t`Use the business’s setting (${businessName})`}
        </Button>
      )}
      {outcome === undefined || outcome.kind === 'saved' ? null : (
        <p role="alert" className="text-sm text-destructive">
          {outcome.kind === 'forbidden'
            ? t`Changing this needs a permission your role doesn’t have.`
            : (outcome.message ?? t`That wasn’t saved. Check your connection and try again.`)}
        </p>
      )}
      <p role="status" className="text-sm empty:sr-only">
        {saving
          ? t`Saving…`
          : outcome?.kind === 'saved'
            ? outcome.reset && who !== undefined
              ? `${t`Saved. ${who} follows the business’s setting again.`} ${sentence}`
              : `${t`Saved.`} ${sentence}`
            : ''}
      </p>
    </div>
  );
}
