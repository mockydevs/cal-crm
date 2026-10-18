// "Choose calendar type", as GoHighLevel's dialog in the owner's screenshot: the types as
// cards, each with a sentence and an example. Only the types that can take bookings are
// offered (owner's rule: nothing on screen that does nothing); GoHighLevel's class,
// collective, service and event types, and its "Explore more types", come back when their
// booking is built. Drafts of those types made earlier still list and open.
import { Trans, useLingui } from '@lingui/react/macro';
import type { CalendarKind } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import {
  CalendarDays,
  ConciergeBell,
  Presentation,
  RefreshCw,
  UserRound,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ReactElement, RefObject } from 'react';
import { chooserKinds } from './calendar-settings-rules';
import { kindCards, kindNames } from './calendar-settings-words';
import { returnTo } from './settings-list';

const kindIcons: Readonly<Record<CalendarKind, LucideIcon>> = {
  personal: UserRound,
  round_robin: RefreshCw,
  class: Presentation,
  collective: UsersRound,
  service: ConciergeBell,
  event: CalendarDays,
};

function TypeCard({
  kind,
  onChoose,
}: {
  readonly kind: CalendarKind;
  readonly onChoose: (kind: CalendarKind) => void;
}): ReactElement {
  const { i18n } = useLingui();
  const Icon = kindIcons[kind];
  return (
    <li className="min-w-0">
      <button
        type="button"
        className="flex size-full min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-4 text-left -outline-offset-2 hover:border-primary hover:bg-accent"
        onClick={() => {
          onChoose(kind);
        }}
      >
        <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-link" strokeWidth={1.8} />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-md font-medium text-foreground">{i18n._(kindNames[kind])}</span>
          <span className="text-sm text-body">{i18n._(kindCards[kind].text)}</span>
          <span className="text-sm text-body">{i18n._(kindCards[kind].example)}</span>
        </span>
      </button>
    </li>
  );
}

export default function CalendarTypeDialog({
  open,
  returnFocus,
  onClose,
  onChoose,
}: {
  readonly open: boolean;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onChoose: (kind: CalendarKind) => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        <Dialog.Popup
          className="fixed top-1/2 left-1/2 z-[65] flex max-h-[calc(100dvh-32px)] w-[min(1100px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-card bg-card p-5 text-card-foreground shadow-xl outline-none"
          finalFocus={returnTo(returnFocus)}
        >
          <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border pb-4">
            <div className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="text-lg font-medium">
                <Trans>Choose calendar type</Trans>
              </Dialog.Title>
              <Dialog.Description className="text-md text-muted-foreground">
                <Trans>
                  Select a calendar type to set up your calendar and customize how appointments are
                  scheduled.
                </Trans>
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          <ul aria-label={t`Calendar types`} className="grid min-w-0 gap-4 sm:grid-cols-2">
            {chooserKinds.map((kind) => (
              <TypeCard key={kind} kind={kind} onChoose={onChoose} />
            ))}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
