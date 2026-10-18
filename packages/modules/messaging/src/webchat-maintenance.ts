// Web chat's housekeeping, for the worker's maintenance schedule.
import type { Services } from '@repo/commands';
import { sql } from 'kysely';

/** Sessions removed in one run; private.expire_webchat_sessions takes at most 10,000. */
const BATCH = 5000;

/**
 * Removes the sessions that expired without ever becoming a chat, in every business, and
 * says how many. Such a session still holds the name and address its visitor typed;
 * without this they would stay for as long as nobody else visits the widget. A session
 * that became a chat holds no such details and is kept with its conversation.
 */
export async function expireWebchatSessions(services: Services): Promise<number> {
  const {
    rows: [row],
  } = await sql<{ deleted: number }>`
    select private.expire_webchat_sessions(${BATCH}::integer) as deleted
  `.execute(services.db);
  return row?.deleted ?? 0;
}
