// A switch as GoHighLevel draws one: a track with a thumb that slides. It is a real button
// with the switch role, so the keyboard presses it and a screen reader says on or off; what
// it switches is named by whoever uses it.
import type { ReactElement } from 'react';

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
}

export function Switch({ checked, onChange, disabled, ...named }: SwitchProps): ReactElement {
  return (
    <button
      {...named}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      // 44px to press under a finger, 36px beside the page; the track is the same either way.
      className="inline-flex min-h-11 shrink-0 items-center rounded-full disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9"
      onClick={() => {
        onChange(!checked);
      }}
    >
      <span
        className={`relative h-6 w-11 rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-muted-foreground'
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-card shadow-[0_1px_2px_rgb(16_24_40/0.2)] transition-[left] ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  );
}
