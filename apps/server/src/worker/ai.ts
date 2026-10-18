// The install's AI gateway: the AI module's gateway with what only the worker has. The
// worker's vault opens a provider's key; AI_LOCAL_SERVERS says which model servers of the
// install's own may be called; and what the gateway reports goes to the server's log, which
// never sees a prompt, an answer or a key.
import type { Database } from '@repo/db';
import {
  createAiGateway,
  type AiGateway,
  type AiGatewayOptions,
  type GatewayEvent,
  type LocalServer,
  type SecretReader,
} from '@repo/module-ai';
import type { Logger } from 'pino';

export interface InstallAiOptions {
  readonly db: Database;
  /** The worker's vault: only it holds the keys that open a secret. */
  readonly vault: SecretReader;
  readonly logger: Logger;
  /** Config.aiLocalServers. */
  readonly localServers?: readonly LocalServer[];
  /**
   * Where the hosted providers are, for a test's stand-ins. An install leaves it out: no
   * setting can change where a hosted provider's key goes.
   */
  readonly baseUrls?: AiGatewayOptions['baseUrls'];
}

/** A failed call and a reached limit are warnings; the rest is information. */
function report(log: Logger, event: GatewayEvent): void {
  if (event.type === 'limit_reached') log.warn(event, 'AI spending limit reached');
  else if (event.type === 'skipped') log.info(event, 'AI call not made');
  else if (event.type === 'key_check')
    log[event.status === 'error' ? 'warn' : 'info'](event, 'AI provider key checked');
  else if (event.status === 'error') log.warn(event, 'AI call failed');
  else log.info(event, 'AI call finished');
}

export function createInstallAiGateway(options: InstallAiOptions): AiGateway {
  const log = options.logger.child({ source: 'ai' });
  return createAiGateway({
    db: options.db,
    secrets: options.vault,
    ...(options.localServers === undefined ? {} : { localServers: options.localServers }),
    ...(options.baseUrls === undefined ? {} : { baseUrls: options.baseUrls }),
    onEvent: (event) => {
      report(log, event);
    },
  });
}
