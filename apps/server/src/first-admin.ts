// The first start: while nobody runs the agency, the app prints a one-time setup link for
// the first admin as it starts. Checking never stops it starting.
import type { Authentication } from '@repo/module-auth';
import type { Logger } from 'pino';

export async function announceFirstAdmin(
  authentication: Pick<Authentication, 'firstAdminLink'>,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<void> {
  try {
    const start = await authentication.firstAdminLink();
    if (start.kind === 'link') {
      logger.info(
        { setupLink: start.url },
        'Nobody runs the agency yet. Open the setup link to create the first admin; it works once, within 24 hours.',
      );
    } else if (start.kind === 'no_agency') {
      logger.warn(
        'There is no agency yet, so no setup link. The migrate container creates it on first start (node dist/install.js).',
      );
    }
  } catch (error) {
    logger.error({ err: error }, 'checking for the first admin failed');
  }
}
