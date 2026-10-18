// What the shell keeps of the assistant: a round button at the bottom right of every page
// of a business. The panel it opens loads apart, the first time it is wanted, so the first
// page doesn't wait for it; this file and view-state.ts are all that arrive with the shell.
//
// The button and the panel are one landmark, beside the page's content: the panel is not a
// dialog, and the page stays usable while it is open.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { CatchBoundary } from '@tanstack/react-router';
import { BotMessageSquare, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { readAssistantView, setAssistantView, useAssistantView } from './view-state';

/** The panel's code, fetched once and kept. */
export const loadAssistantPanel = (): Promise<typeof import('./panel')> => import('./panel');

const Panel = lazy(loadAssistantPanel);

/** What the boundary shows itself: nothing, since the launcher says what failed. */
function Nothing(): null {
  return null;
}

export function AssistantLauncher({
  businessId,
  slug,
}: {
  readonly businessId: string;
  readonly slug: string;
}): ReactElement {
  const { t } = useLingui();
  const panelId = useId();
  const view = useAssistantView(businessId);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);

  // Back on a page, the full-screen view's way back is used up. Once, as the launcher
  // appears: the panel sets a new way back just before it leaves for the full-screen view.
  useEffect(() => {
    if (readAssistantView(businessId).from !== null)
      setAssistantView(businessId, { from: null, fromPage: null });
  }, [businessId]);

  const close = useCallback(() => {
    setAssistantView(businessId, { open: false });
    buttonRef.current?.focus();
  }, [businessId]);

  return (
    <aside aria-label={t`Assistant`}>
      {!view.open ? null : failed ? (
        // React keeps a failed lazy component failed, so only a new page fetches it afresh.
        <div
          id={panelId}
          role="alert"
          className="fixed right-4 bottom-[76px] z-[35] flex w-[min(400px,calc(100vw-32px))] flex-col items-start gap-2 rounded-card border bg-card p-4 text-sm shadow-xl"
        >
          <p>
            <Trans>The assistant couldn’t load. Reload the page to try again.</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              window.location.reload();
            }}
          >
            <Trans>Reload page</Trans>
          </Button>
        </div>
      ) : (
        <CatchBoundary
          getResetKey={() => 'assistant-panel'}
          errorComponent={Nothing}
          onCatch={() => {
            setFailed(true);
          }}
        >
          <Suspense fallback={null}>
            <Panel businessId={businessId} slug={slug} id={panelId} onClose={close} />
          </Suspense>
        </CatchBoundary>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-label={t`Assistant`}
        title={t`Assistant`}
        aria-expanded={view.open}
        aria-controls={view.open ? panelId : undefined}
        // Fetched as the pointer nears, so a press opens it at once.
        onPointerEnter={() => {
          void loadAssistantPanel().catch(() => undefined);
        }}
        onFocus={() => {
          void loadAssistantPanel().catch(() => undefined);
        }}
        onClick={() => {
          setAssistantView(businessId, { open: !view.open });
        }}
        className="fixed right-4 bottom-[max(16px,env(safe-area-inset-bottom))] z-30 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary-hover"
      >
        {view.open ? (
          <X aria-hidden className="size-5" strokeWidth={2} />
        ) : (
          <BotMessageSquare aria-hidden className="size-6" strokeWidth={1.8} />
        )}
      </button>
    </aside>
  );
}
