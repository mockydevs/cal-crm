// The automation builder, fetched when someone opens an automation, so the Automations
// list doesn't wait for the builder, its forms and the validator. If its code doesn't
// arrive, the page says so and offers the way back and a reload: React keeps a failed lazy
// component failed, so only a new page fetches it afresh (see note-editor-loader.tsx).
// Nothing was open yet, so there is no draft to lose.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { CatchBoundary } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import type AutomationBuilder from './automation-builder';
import { SearchLink } from './automation-navigation';
import { loadAutomationWords } from './automation-words';
import { usePageTitle } from './shell/page';

export type AutomationBuilderProps = ComponentProps<typeof AutomationBuilder>;

// The builder's words about where a lead came from are a catalog of their own, fetched
// beside it (lingui.config.ts).
const Builder = lazy(async () => {
  const [builder] = await Promise.all([import('./automation-builder'), loadAutomationWords()]);
  return builder;
});

/** What the whole window shows while the builder is on its way, or when it didn't come. */
function Alone({ children }: { readonly children: ReactNode }): ReactElement {
  const { t } = useLingui();
  usePageTitle(t`Automation`);
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <h1 className="text-[24px] leading-8 font-medium">
        <Trans>Automation</Trans>
      </h1>
      {children}
    </div>
  );
}

/** What the boundary shows itself: nothing, since the loader shows the failure. */
function Nothing(): null {
  return null;
}

function BuilderUnavailable({
  navigation,
}: Pick<AutomationBuilderProps, 'navigation'>): ReactElement {
  // The person just opened an automation, and the builder isn't there: the keyboard lands
  // on the way forward.
  const focusOnMount = useCallback((button: HTMLButtonElement | null) => {
    button?.focus();
  }, []);
  return (
    <Alone>
      <div
        role="alert"
        className="flex min-w-0 flex-col items-start gap-3 rounded-card border border-border bg-card p-5 text-md"
      >
        <p>
          <Trans>
            The builder couldn't load. Your workflows are safe. Reload the page to try again.
          </Trans>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            ref={focusOnMount}
            variant="secondary"
            size="small"
            onClick={() => {
              window.location.reload();
            }}
          >
            <Trans>Reload page</Trans>
          </Button>
          <SearchLink
            to={{}}
            navigation={navigation}
            className="py-2 text-link underline-offset-2 hover:underline"
          >
            <Trans>Workflows list</Trans>
          </SearchLink>
        </div>
      </div>
    </Alone>
  );
}

/** The builder with its loading and its failure kept to the page. */
export default function AutomationBuilderLoader(props: AutomationBuilderProps): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) return <BuilderUnavailable navigation={props.navigation} />;
  return (
    <CatchBoundary
      getResetKey={() => 'automation-builder'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense
        fallback={
          <Alone>
            <p role="status">
              <Trans>Loading the builder…</Trans>
            </p>
          </Alone>
        }
      >
        <Builder {...props} />
      </Suspense>
    </CatchBoundary>
  );
}
