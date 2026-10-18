// One campaign on its own page (Marketing → Emails → Campaigns → a campaign): the editor
// while it is a draft the person may change, and its status, numbers and recipients once it
// is scheduled, sending or finished. Each is fetched when it is needed, with the email
// editor's words beside it (lingui.config.ts): both show the email as the server renders it.
//
// While a campaign is scheduled, sending or paused the page reads it again every so often,
// besides the realtime hint (realtime.ts), so its status moves by itself.
import { Trans, useLingui } from '@lingui/react/macro';
import { getEmailCampaign } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { apiIn } from '../api';
import { withEmailWords } from '../email-words';
import { ListProblem } from '../list-table';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';
import { campaignKeys, isRefusal, retryFaults, saidBy } from './data';
import { linkClassName } from './parts';

const route = getRouteApi('/_app/b/$slug/marketing/emails/campaigns_/$campaignId');

const Editor = lazy(() => withEmailWords(import('./editor')));
const Results = lazy(() => withEmailWords(import('./results')));

const moving: readonly string[] = ['scheduled', 'sending', 'paused'];

export default function CampaignPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const { campaignId } = route.useParams();
  const campaign = useQuery({
    queryKey: campaignKeys.one(business.id, campaignId),
    queryFn: () => apiIn(business.id).request(getEmailCampaign, { params: { id: campaignId } }),
    retry: retryFaults,
    refetchInterval: (query) => (moving.includes(query.state.data?.status ?? '') ? 15_000 : false),
  });
  if (campaign.data === undefined)
    return (
      <Page title={t`Email campaign`}>
        {campaign.isError ? (
          isRefusal(campaign.error, 404) ? (
            <p role="alert" className="text-md">
              <Trans>This campaign is gone: it was deleted, or the address is wrong.</Trans>
            </p>
          ) : isRefusal(campaign.error, 403) ? (
            <p role="alert" className="text-md">
              <Trans>
                Your role can't see email campaigns. Ask an owner or admin of this business.
              </Trans>
            </p>
          ) : (
            <ListProblem
              onRetry={() => {
                void campaign.refetch();
              }}
            >
              {saidBy(campaign.error, t`We couldn't load this campaign.`)}
            </ListProblem>
          )
        ) : (
          <p role="status" className="text-sm">
            <Trans>Loading the campaign…</Trans>
          </p>
        )}
        <Link
          to="/b/$slug/marketing/emails/campaigns"
          params={{ slug: business.slug }}
          className={`${linkClassName} self-start text-sm`}
        >
          <Trans>All campaigns</Trans>
        </Link>
      </Page>
    );
  const { data } = campaign;
  return (
    <Suspense fallback={null}>
      {data.status === 'draft' && data.canManage ? (
        // Another campaign is another form.
        <Editor key={data.id} campaign={data} />
      ) : (
        <Results key={data.id} campaign={data} />
      )}
    </Suspense>
  );
}
