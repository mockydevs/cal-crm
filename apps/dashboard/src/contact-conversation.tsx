// The contact page's centre pane: the contact's conversation, as Conversations shows it,
// with the same thread, assistant draft and composer. A contact has one conversation, on
// every channel; it is found by asking the list for this contact's, whatever its status. A
// contact nobody has written to or heard from has none, and nothing here can start one: the
// server opens a conversation with its first message, and has no way yet to send that from
// the dashboard.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  addConversationNote,
  listConversations,
  sendConversationReply,
  type ThreadMessage,
  type ThreadNote,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { PanelEmpty } from './contact-panels';
import type { DraftStore } from './inbox-composer';
import { inboxKeys, retryRead } from './inbox-data';
import { createNoteOutbox, createReplyOutbox } from './inbox-rules';
import { InboxThread } from './inbox-thread';
import { useBusiness } from './workspace';

export interface ContactConversationProps {
  readonly contactId: string;
  /** Whether the pane is in sight: see InboxThread's `shown`. */
  readonly shown: boolean;
}

export default function ContactConversation({
  contactId,
  shown,
}: ContactConversationProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  // Drafts and the keys of sends still to retry live as long as the contact stays open.
  const [drafts] = useState<DraftStore>(() => new Map());
  const [outbox] = useState(() =>
    createReplyOutbox<ThreadMessage>((id, body) =>
      apiIn(business.id).request(sendConversationReply, { params: { id }, body }),
    ),
  );
  const [notes] = useState(() =>
    createNoteOutbox<ThreadNote>((id, body) =>
      apiIn(business.id).request(addConversationNote, { params: { id }, body }),
    ),
  );
  // Under the Inbox's own keys, so whatever refreshes its lists refreshes this too.
  const found = useQuery({
    queryKey: inboxKeys.list(business.id, { contact: contactId, status: 'all' }),
    queryFn: () =>
      apiIn(business.id).request(listConversations, {
        query: { contactId, status: 'all' },
      }),
    retry: retryRead,
  });
  const conversation = found.data?.items[0];
  if (conversation !== undefined)
    return (
      <InboxThread
        key={conversation.id}
        conversationId={conversation.id}
        shown={shown}
        drafts={drafts}
        sendReply={outbox.submit}
        addNote={notes.submit}
      />
    );
  if (found.isPending)
    return (
      <p role="status" className="p-4">
        <Trans>Loading conversation…</Trans>
      </p>
    );
  if (found.isError)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
        <p>
          <Trans>The conversation couldn't be loaded.</Trans>
        </p>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            void found.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  return (
    <PanelEmpty
      icon={<MessagesSquare />}
      title={t`No conversation yet`}
      description={t`Messages with this contact show here once the first one is sent or received.`}
    />
  );
}
