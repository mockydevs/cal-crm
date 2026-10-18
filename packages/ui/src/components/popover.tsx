import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';

// A small panel of controls that opens from a button, such as a list's Sort. Base UI names
// it for assistive technology from its title, closes it on Escape or a press outside, and
// returns the keyboard to the button.

export const Popover = PopoverPrimitive.Root;

export const PopoverTrigger = PopoverPrimitive.Trigger;

export const PopoverClose = PopoverPrimitive.Close;

export type PopoverContentProps = PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'>;

/** The panel, under its button and never wider than the window. */
export function PopoverContent({
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  className,
  ...props
}: PopoverContentProps): ReactElement {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className="isolate z-50 max-w-(--available-width) outline-none"
        align={align}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'flex max-h-(--available-height) max-w-(--available-width) origin-(--transform-origin) flex-col gap-3 overflow-y-auto rounded-card border bg-popover p-3 text-popover-foreground shadow-lg outline-none',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props): ReactElement {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn('text-sm font-medium text-foreground', className)}
      {...props}
    />
  );
}
