import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';

// From shadcn/ui's base-nova dropdown menu, with the parts the dashboard uses: a list of
// links that opens from a button, such as the business switcher. Items are 36px tall in
// the desktop layout and 40px below it.

export const DropdownMenu = MenuPrimitive.Root;

export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export type DropdownMenuContentProps = MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'> &
  Pick<MenuPrimitive.Portal.Props, 'container'>;

/**
 * The popup, as wide as its trigger at least, and scrolling when it's taller than the
 * window. It renders at the end of the body, or into `container`, such as an element in
 * the landmark the trigger is in.
 */
export function DropdownMenuContent({
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  container,
  className,
  ...props
}: DropdownMenuContentProps): ReactElement {
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            'max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-card border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export const DropdownMenuGroup = MenuPrimitive.Group;

export function DropdownMenuLabel({
  className,
  ...props
}: MenuPrimitive.GroupLabel.Props): ReactElement {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn('px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

const itemClassName =
  'flex min-h-10 cursor-pointer items-center gap-2.5 rounded-control px-3 text-md leading-[normal] text-foreground outline-hidden select-none data-highlighted:bg-muted lg:min-h-9 [&_svg]:pointer-events-none [&_svg]:shrink-0';

/**
 * A link in the menu. It closes the menu when followed, for apps that change pages without
 * reloading. Pass the router's link as `render`.
 */
export function DropdownMenuLinkItem({
  className,
  closeOnClick = true,
  ...props
}: MenuPrimitive.LinkItem.Props): ReactElement {
  return (
    <MenuPrimitive.LinkItem
      data-slot="dropdown-menu-link-item"
      closeOnClick={closeOnClick}
      className={cn(itemClassName, className)}
      {...props}
    />
  );
}

/** Something the menu does where it is, such as signing out. It closes the menu. */
export function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props): ReactElement {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        itemClassName,
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props): ReactElement {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('-mx-1.5 my-1.5 h-px bg-border', className)}
      {...props}
    />
  );
}
