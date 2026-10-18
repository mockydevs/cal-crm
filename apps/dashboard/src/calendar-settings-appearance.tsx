// Widget appearance, as GoHighLevel's "Customizations" in the owner's screenshot: a cover
// image, the widget's style, its two colours and its button's words, all drawn by the public
// booking page (public-booking-theme.ts). As GoHighLevel's help says, the colours and the
// button's words are the Neo widget's alone, so they are offered only while Neo is chosen;
// what Classic would ignore is kept, not cleared.
import { Trans, useLingui } from '@lingui/react/macro';
import { CALENDAR_LIMITS } from '@repo/contracts';
import { Input } from '@repo/ui/components/input';
import { useId, useState, type ReactElement } from 'react';
import {
  Labeled,
  labelClassName,
  noteClassName,
  SectionCard,
  type SectionProps,
} from './calendar-settings-parts';
import { ImageDrop } from './calendar-settings-image';
import { imageMegabytes, isHexColor, swatchOf } from './calendar-settings-rules';

function ColorField({
  label,
  value,
  problem,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly problem: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <Labeled
      label={label}
      problem={problem}
      description={
        isHexColor(value) ? undefined : (
          <Trans>Six or eight hexadecimal digits after #, such as #178af6.</Trans>
        )
      }
    >
      {(control) => (
        <div className="flex min-w-0 items-center gap-2">
          <input
            type="color"
            aria-label={t`${label} swatch`}
            disabled={disabled}
            className="size-11 shrink-0 cursor-pointer rounded-control border border-input bg-card p-1 disabled:cursor-not-allowed disabled:opacity-50 lg:size-9"
            value={swatchOf(value)}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          <Input
            {...control}
            maxLength={9}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className="min-w-0 flex-1 font-mono"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </div>
      )}
    </Labeled>
  );
}

export default function AppearanceSection({
  client,
  businessId,
  draft,
  change,
  problems,
  off,
}: SectionProps): ReactElement {
  const { t } = useLingui();
  const styleId = useId();
  // A colour or the button's words marked wrong stay in sight under Classic until the style
  // is chosen again, so they can be put right without vanishing as they are typed.
  const marked = ['primaryColor', 'backgroundColor', 'buttonText'].some(
    (field) => problems[field] !== undefined,
  );
  const [kept, setKept] = useState(false);
  if (marked && !kept) setKept(true);
  const customized = draft.widgetStyle === 'neo' || marked || kept;
  return (
    <SectionCard
      title={<Trans>Customizations</Trans>}
      description={<Trans>Set widget style and other preferences.</Trans>}
    >
      <ImageDrop
        client={client}
        businessId={businessId}
        label={t`Calendar cover image`}
        alt={t`Calendar cover image preview`}
        hint={<Trans>PNG, JPEG, GIF or WebP, at most {imageMegabytes} MB.</Trans>}
        fileId={draft.coverFileId}
        disabled={off}
        onChange={(coverFileId) => {
          change({ coverFileId });
        }}
      />
      <div
        role="radiogroup"
        aria-labelledby={`${styleId}-label`}
        aria-describedby={`${styleId}-hint`}
        className="flex min-w-0 flex-col gap-2 border-t border-border pt-5"
      >
        <span id={`${styleId}-label`} className={labelClassName}>
          <Trans>Calendar widget style</Trans>
        </span>
        <p id={`${styleId}-hint`} className={noteClassName}>
          <Trans>Choose between the classic widget and the Neo widget.</Trans>
        </p>
        <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-1">
          {(['neo', 'classic'] as const).map((style) => (
            <label key={style} className="flex min-h-11 items-center gap-2 text-md lg:min-h-9">
              <input
                type="radio"
                name={styleId}
                className="size-4 shrink-0 accent-primary"
                disabled={off}
                checked={draft.widgetStyle === style}
                onChange={() => {
                  setKept(false);
                  change({ widgetStyle: style });
                }}
              />
              {style === 'neo' ? <Trans>Neo</Trans> : <Trans>Classic</Trans>}
            </label>
          ))}
        </div>
      </div>
      {customized ? (
        <CustomizeWidget draft={draft} change={change} problems={problems} off={off} />
      ) : (
        <p className={noteClassName}>
          <Trans>
            The classic widget keeps the standard colours and button text. Choose Neo to set your
            own.
          </Trans>
        </p>
      )}
    </SectionCard>
  );
}

/** Neo's colours and button words, which the booking page draws for Neo only. */
function CustomizeWidget({
  draft,
  change,
  problems,
  off,
}: Pick<SectionProps, 'draft' | 'change' | 'problems' | 'off'>): ReactElement {
  const { t } = useLingui();
  const limit = CALENDAR_LIMITS.buttonText;
  return (
    <section
      aria-label={t`Customize calendar widget`}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4"
    >
      <h3 className="text-md font-medium">
        <Trans>Customize calendar widget</Trans>
      </h3>
      <p className={noteClassName}>
        <Trans>
          Customize widget appearance: primary color, background color, and button text. Words on
          the booking page stay readable: where a colour would make them hard to read, the page
          writes them darker or lighter.
        </Trans>
      </p>
      <div className="grid min-w-0 items-start gap-4 sm:grid-cols-2">
        <ColorField
          label={t`Primary color`}
          value={draft.primaryColor}
          problem={problems['primaryColor']}
          disabled={off}
          onChange={(primaryColor) => {
            change({ primaryColor });
          }}
        />
        <ColorField
          label={t`Background color`}
          value={draft.backgroundColor}
          problem={problems['backgroundColor']}
          disabled={off}
          onChange={(backgroundColor) => {
            change({ backgroundColor });
          }}
        />
      </div>
      <Labeled
        label={t`Button text`}
        problem={problems['buttonText']}
        description={<Trans>At most {limit} characters. Empty: the widget's own words.</Trans>}
        className="sm:max-w-md"
      >
        {(control) => (
          <Input
            {...control}
            maxLength={limit}
            autoComplete="off"
            disabled={off}
            value={draft.buttonText}
            onChange={(event) => {
              change({ buttonText: event.target.value });
            }}
          />
        )}
      </Labeled>
    </section>
  );
}
