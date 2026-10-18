// A draft campaign on its own page, in four sections in one scroll, in the order a person
// works: Details, Email, Audience, Review and send. The draft saves itself after a pause in
// the edits, whole, with the revision it was read at (site-editor/autosave.ts is the state
// of that); a save the server refuses because someone else saved first waits for the person
// to choose theirs, or to keep their own as a copy. Leaving the page saves what is not
// saved yet, and asks only when that fails.
//
// The audience preview and the checks are the server's, of the saved draft: both are read
// again after each save.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createEmailCampaign,
  getEmailCampaign,
  updateEmailCampaign,
  type EmailCampaign,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { apiIn } from '../api';
import { Page } from '../shell/page';
import { autosave, saveDueIn, startAutosave } from '../site-editor/autosave';
import { useBusiness } from '../workspace';
import { ConfirmDialog } from './controls';
import { campaignKeys, isRefusal, saidBy, useAudienceNames } from './data';
import { bodyOf, draftOf, draftProblems, type CampaignDraft } from './draft';
import { ChecksList, type EditorSection } from './editor-checks';
import { useAudiencePreview, useCampaignChecks } from './editor-data';
import { DetailsSection } from './editor-details';
import { useCampaignFields } from './email-parts';
import { useCampaignMailboxes } from './mailboxes';
import { cardClassName, hintClassName, linkClassName, StatusPill } from './parts';
import { checkSentence, sortedChecks } from './rules';

// Each of these is fetched when the editor first draws it, so the editor's own code stays
// within a route's budget (scripts/check-budget.mjs): the email with its template list,
// the audience with its tag chips, and the two dialogs.
const ContentSection = lazy(() => import('./editor-content'));
const AudienceChoice = lazy(async () => ({
  default: (await import('./editor-audience')).AudienceChoice,
}));
const AudiencePreview = lazy(async () => ({
  default: (await import('./editor-audience')).AudiencePreview,
}));
const SendDialog = lazy(() => import('./send-dialog'));
const TestDialog = lazy(() => import('./test-dialog'));

function Section({
  number,
  title,
  headingRef,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly headingRef?: RefObject<HTMLHeadingElement | null>;
  readonly children: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cardClassName}>
      <h2
        id={id}
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-2 text-lg font-medium outline-none"
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-link"
        >
          {number}
        </span>
        {title}
      </h2>
      <Suspense fallback={null}>{children}</Suspense>
    </section>
  );
}

export default function CampaignEditor({
  campaign,
}: {
  /** The draft as it was read: the editor keeps its own copy from here on. */
  readonly campaign: EmailCampaign;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = useMemo(() => apiIn(business.id), [business.id]);
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(campaign);
  const [draft, setDraft] = useState(() => draftOf(campaign));
  const [auto, dispatch] = useReducer(autosave, campaign.revision, startAutosave);
  const [refusal, setRefusal] = useState<string>();
  const [asking, setAsking] = useState<'test' | 'send'>();
  const [resolving, setResolving] = useState(false);
  // What a save reads: the newest draft and revision, whatever render started it.
  const draftRef = useRef(draft);
  const savedRef = useRef(campaign);
  const editsRef = useRef(0);
  const savedEditsRef = useRef(0);
  const inFlightRef = useRef<Promise<EmailCampaign | undefined>>(undefined);
  const leavingRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const detailsRef = useRef<HTMLHeadingElement>(null);
  const contentRef = useRef<HTMLHeadingElement>(null);
  const audienceRef = useRef<HTMLHeadingElement>(null);

  const { fields, isKnown } = useCampaignFields(client, business.id);
  const names = useAudienceNames(business.id);
  const mailboxes = useCampaignMailboxes(business.id);
  const isSaved = auto.status === 'saved';
  const preview = useAudiencePreview(client, business.id, saved, isSaved);
  const checks = useCampaignChecks(client, business.id, saved, isSaved);
  const problems = draftProblems(draft);

  const keep = (next: EmailCampaign): void => {
    savedRef.current = next;
    setSaved(next);
    cache.setQueryData(campaignKeys.one(business.id, next.id), next);
  };
  const change = (patch: Partial<CampaignDraft>): void => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    editsRef.current += 1;
    setDraft(next);
    setRefusal(undefined);
    dispatch({ type: 'edited' });
  };

  /** One save of the draft as it stands; a save on its way is joined, not doubled. */
  const saveOnce = (): Promise<EmailCampaign | undefined> => {
    if (inFlightRef.current !== undefined) return inFlightRef.current;
    const mine = draftRef.current;
    const carried = editsRef.current;
    // A draft the API would refuse is not sent: the boxes say what to put right.
    if (Object.keys(draftProblems(mine)).length > 0) {
      dispatch({ type: 'checked', valid: false });
      return Promise.resolve(undefined);
    }
    const run = (async (): Promise<EmailCampaign | undefined> => {
      dispatch({ type: 'save_started' });
      try {
        const next = await client.request(updateEmailCampaign, {
          params: { id: savedRef.current.id },
          body: bodyOf(mine, savedRef.current.revision),
        });
        savedEditsRef.current = carried;
        keep(next);
        dispatch({ type: 'save_succeeded', version: next.revision });
        return next;
      } catch (error) {
        if (isRefusal(error, 409)) dispatch({ type: 'conflict' });
        else if (error instanceof ApiError && error.status < 500) {
          setRefusal(saidBy(error, t`The server would not take the draft as it stands.`));
          dispatch({ type: 'save_refused' });
        } else dispatch({ type: 'save_failed' });
        return undefined;
      } finally {
        inFlightRef.current = undefined;
      }
    })();
    inFlightRef.current = run;
    return run;
  };
  const saveRef = useRef(saveOnce);
  useEffect(() => {
    saveRef.current = saveOnce;
  });

  /** Everything on screen saved: the saved campaign, or undefined when it could not be. */
  const ensureSaved = async (): Promise<EmailCampaign | undefined> => {
    for (let tries = 0; tries < 3; tries += 1) {
      if (inFlightRef.current !== undefined) await inFlightRef.current;
      if (editsRef.current === savedEditsRef.current) return savedRef.current;
      if ((await saveRef.current()) === undefined) return undefined;
    }
    return editsRef.current === savedEditsRef.current ? savedRef.current : undefined;
  };

  // The save that is due: after a pause in the edits, or a longer wait after a failure.
  const due = saveDueIn(auto);
  useEffect(() => {
    if (due === null) return undefined;
    const timer = setTimeout(() => {
      void saveRef.current();
    }, due);
    return () => {
      clearTimeout(timer);
    };
  }, [due, auto.edits, auto.failures]);

  const blocker = useBlocker({
    // Leaving saves first; the person is asked only when that could not be done.
    shouldBlockFn: async () => {
      if (leavingRef.current || editsRef.current === savedEditsRef.current) return false;
      return (await ensureSaved()) === undefined;
    },
    enableBeforeUnload: () => editsRef.current !== savedEditsRef.current,
    withResolver: true,
  });

  const adopt = (next: EmailCampaign): void => {
    keep(next);
    draftRef.current = draftOf(next);
    savedEditsRef.current = editsRef.current;
    setDraft(draftRef.current);
    setRefusal(undefined);
    dispatch({ type: 'loaded', version: next.revision });
  };
  const loadTheirs = async (): Promise<void> => {
    setResolving(true);
    try {
      adopt(await client.request(getEmailCampaign, { params: { id: saved.id } }));
    } catch (error) {
      setRefusal(saidBy(error, t`The saved campaign couldn't be read. Check your connection.`));
    } finally {
      setResolving(false);
    }
  };
  const keepMineAsCopy = async (): Promise<void> => {
    setResolving(true);
    try {
      const mine = draftRef.current;
      const { name } = mine;
      const copyName = t`${name} (my copy)`.slice(0, 120);
      const copy = await client.request(createEmailCampaign, {
        body: {
          name: copyName,
          folderId: mine.folderId,
          source: { kind: 'campaign', campaignId: saved.id },
        },
      });
      const written = await client.request(updateEmailCampaign, {
        params: { id: copy.id },
        body: bodyOf({ ...mine, name: copyName }, copy.revision),
      });
      cache.setQueryData(campaignKeys.one(business.id, written.id), written);
      void cache.invalidateQueries({ queryKey: campaignKeys.all(business.id) });
      leavingRef.current = true;
      await navigate({
        to: '/b/$slug/marketing/emails/campaigns/$campaignId',
        params: { slug: business.slug, campaignId: written.id },
      });
    } catch (error) {
      setRefusal(
        saidBy(error, t`Your copy couldn't be saved. Check your connection and try again.`),
      );
    } finally {
      setResolving(false);
    }
  };

  const go = (section: EditorSection): void => {
    const heading = { details: detailsRef, content: contentRef, audience: audienceRef }[section]
      .current;
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  };

  const blocking = checks.data === undefined ? undefined : sortedChecks(checks.data.items)[0];
  const sendBlock: string | undefined = !saved.canSend
    ? t`Ask an owner or admin to send.`
    : auto.status === 'invalid'
      ? t`Put right what is marked above first.`
      : !isSaved
        ? t`Waiting for your changes to save.`
        : checks.isError
          ? t`The checks couldn't be read, so it can't be sent yet.`
          : checks.data === undefined || checks.isPlaceholderData
            ? t`Checking the campaign…`
            : !checks.data.canSend && blocking !== undefined
              ? checkSentence(blocking)
              : undefined;
  const mailboxName = mailboxes.data?.all.find((each) => each.id === saved.mailboxId)?.name;
  const title = draft.name.trim() === '' ? t`Untitled campaign` : draft.name;
  const status =
    auto.status === 'saved'
      ? t`All changes saved`
      : auto.status === 'invalid'
        ? t`Not saved: put right what is marked`
        : auto.status === 'failed'
          ? t`Not saved yet. Trying again…`
          : auto.status === 'conflict'
            ? t`Not saved: someone else changed it`
            : t`Saving…`;

  return (
    <Page
      title={title}
      actions={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusPill status="draft" />
          <span role="status" className="text-sm text-body">
            {status}
          </span>
        </div>
      }
    >
      <Link
        to="/b/$slug/marketing/emails/campaigns"
        params={{ slug: business.slug }}
        className={`${linkClassName} inline-flex min-h-11 items-center gap-1.5 self-start text-sm lg:min-h-0`}
      >
        <ArrowLeft aria-hidden className="size-4" strokeWidth={1.8} />
        <Trans>All campaigns</Trans>
      </Link>
      {auto.status === 'conflict' ? (
        <div
          role="alert"
          className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-card border border-destructive bg-card p-4"
        >
          <p className="min-w-0 flex-1 basis-72 text-md">
            <Trans>
              Someone else changed this campaign while you were editing, so your changes were not
              saved over theirs. Load their version, or keep yours as a separate copy.
            </Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={resolving}
              onClick={() => {
                void loadTheirs();
              }}
            >
              <Trans>Load their version</Trans>
            </Button>
            <Button
              disabled={resolving}
              onClick={() => {
                void keepMineAsCopy();
              }}
            >
              <Trans>Keep mine as a copy</Trans>
            </Button>
          </div>
        </div>
      ) : null}
      {refusal === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {refusal}
        </p>
      )}

      <Section number={1} title={t`Details`} headingRef={detailsRef}>
        <DetailsSection
          businessId={business.id}
          slug={business.slug}
          draft={draft}
          problems={problems}
          fields={fields}
          onChange={change}
        />
      </Section>

      <Section number={2} title={t`Email`} headingRef={contentRef}>
        <ContentSection
          client={client}
          businessId={business.id}
          slug={business.slug}
          draft={draft}
          fields={fields}
          isKnown={isKnown}
          onChange={change}
          onSave={async (patch) => {
            change(patch);
            if ((await ensureSaved()) === undefined)
              throw new Error(t`The campaign couldn't be saved. Close this to see why.`);
          }}
        />
      </Section>

      <Section number={3} title={t`Audience`} headingRef={audienceRef}>
        <AudienceChoice
          client={client}
          businessId={business.id}
          audience={draft.audience}
          names={names}
          onChange={(audience) => {
            change({ audience });
          }}
        />
        <AudiencePreview
          preview={preview}
          chosen={draft.audience !== null}
          saved={isSaved && !preview.isPlaceholderData}
          timeZone={saved.timeZone}
          slug={business.slug}
        />
      </Section>

      <Section number={4} title={t`Review and send`}>
        <ChecksList checks={checks} saved={isSaved} slug={business.slug} onGo={go} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3">
          <Button
            variant="secondary"
            onClick={(event) => {
              openerRef.current = event.currentTarget;
              setAsking('test');
            }}
          >
            <Trans>Send a test</Trans>
          </Button>
          <Button
            disabled={sendBlock !== undefined}
            aria-describedby={sendBlock === undefined ? undefined : 'campaign-send-block'}
            onClick={(event) => {
              openerRef.current = event.currentTarget;
              setAsking('send');
            }}
          >
            <Trans>Send or schedule</Trans>
          </Button>
          {sendBlock === undefined ? (
            <p className={hintClassName}>
              <Trans>Nothing leaves until you confirm in the next step.</Trans>
            </p>
          ) : (
            <p id="campaign-send-block" className="min-w-0 flex-1 basis-64 text-sm text-body">
              {sendBlock}
            </p>
          )}
        </div>
      </Section>

      {asking === 'test' ? (
        <Suspense fallback={null}>
          <TestDialog
            client={client}
            businessId={business.id}
            campaignId={saved.id}
            canSend={saved.canSend}
            returnFocus={openerRef}
            beforeSend={async () => (await ensureSaved()) !== undefined}
            onClose={() => {
              setAsking(undefined);
            }}
          />
        </Suspense>
      ) : null}
      {asking === 'send' ? (
        <Suspense fallback={null}>
          <SendDialog
            client={client}
            campaign={saved}
            willReceive={preview.data?.willReceive}
            dailyCeiling={checks.data?.dailyCeiling ?? null}
            mailboxName={mailboxName}
            returnFocus={openerRef}
            onClose={() => {
              setAsking(undefined);
            }}
            onDone={(next) => {
              setAsking(undefined);
              leavingRef.current = true;
              cache.setQueryData(campaignKeys.one(business.id, next.id), next);
              void cache.invalidateQueries({ queryKey: campaignKeys.all(business.id) });
            }}
          />
        </Suspense>
      ) : null}
      {blocker.status === 'blocked' ? (
        <ConfirmDialog
          open
          title={t`Leave without your last changes?`}
          description={t`Your last changes couldn't be saved. If you leave now they are lost.`}
          confirmLabel={t`Leave without them`}
          destructive
          busy={false}
          problem={undefined}
          returnFocus={openerRef}
          onConfirm={() => {
            blocker.proceed();
          }}
          onClose={() => {
            blocker.reset();
          }}
        />
      ) : null}
    </Page>
  );
}
