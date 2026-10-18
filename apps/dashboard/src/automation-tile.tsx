// The icon of an action or a trigger on its tinted tile, as the pickers, the panels and the
// canvas's cards all show it.
import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { actionCategories, categoryOf } from './automation-catalogue';
import { stepIcon, stepTileClassName, triggerIcon, triggerTileClassName } from './automation-icons';

function Glyph({ icon: Icon }: { readonly icon: LucideIcon }): ReactElement {
  return <Icon className="size-4.5" strokeWidth={1.8} />;
}

/** The icon of an action or a trigger on its tinted tile. */
export function Tile({
  owner,
  type,
  className = 'size-9',
}: {
  readonly owner: 'step' | 'trigger';
  readonly type: string;
  readonly className?: string;
}): ReactElement {
  const tint =
    owner === 'trigger'
      ? triggerTileClassName
      : stepTileClassName(categoryOf(type, actionCategories));
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-lg ${tint} ${className}`}
    >
      <Glyph icon={owner === 'trigger' ? triggerIcon(type) : stepIcon(type)} />
    </span>
  );
}
