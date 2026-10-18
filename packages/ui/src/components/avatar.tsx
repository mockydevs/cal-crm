import { Avatar as AvatarPrimitive } from '@base-ui/react/avatar';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';

// From shadcn/ui's base-nova avatar: initials on a soft tint
// until a photo exists.
const avatarVariants = cva(
  'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-foreground select-none',
  {
    variants: {
      size: {
        small: 'size-8 text-[13px]',
        medium: 'size-9 text-sm',
        large: 'size-13 text-[17px]',
      },
      tint: {
        1: 'bg-avatar-1',
        2: 'bg-avatar-2',
        3: 'bg-avatar-3',
        4: 'bg-avatar-4',
      },
    },
    defaultVariants: {
      size: 'medium',
      tint: 4,
    },
  },
);

export type AvatarProps = AvatarPrimitive.Root.Props &
  VariantProps<typeof avatarVariants> & {
    /** Shown until the image loads, and when there's no image. Usually initials. */
    readonly fallback: string;
    readonly src?: string;
  };

/** Decorative: the person's name is always next to it, so it's hidden from screen readers. */
export function Avatar({
  className,
  size,
  tint,
  fallback,
  src,
  ...props
}: AvatarProps): ReactElement {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      aria-hidden
      className={cn(avatarVariants({ size, tint }), className)}
      {...props}
    >
      {src === undefined ? null : (
        <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" />
      )}
      <AvatarPrimitive.Fallback>{fallback}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
