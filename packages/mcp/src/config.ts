import { createClient, type Client } from '@repo/sdk';

export interface McpConfiguration {
  readonly client: Client;
  readonly allowPublish: boolean;
}

/** Credentials come from the AI client's process environment, never tool arguments. */
export function configuration(
  environment: Readonly<Record<string, string | undefined>>,
): McpConfiguration {
  const baseUrl = environment['CRM_API_URL'];
  const key = environment['CRM_API_KEY'];
  // Legacy compatibility only: a key identifies its default scope without an id.
  const businessId = environment['CRM_BUSINESS_ID'];
  if (baseUrl === undefined || !key?.trim()) {
    throw new Error('Set CRM_API_URL and CRM_API_KEY in the MCP process environment.');
  }
  const parsed = URL.parse(baseUrl);
  if (
    parsed?.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname.replace(/\/$/, '') !== '/api/v1' ||
    !(
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    )
  ) {
    throw new Error(
      'CRM_API_URL must be an HTTPS /api/v1 URL, or HTTP on loopback for local development.',
    );
  }
  const publish = environment['CRM_MCP_ALLOW_PUBLISH'];
  if (publish !== undefined && publish !== 'true' && publish !== 'false') {
    throw new Error('CRM_MCP_ALLOW_PUBLISH must be true or false.');
  }
  return {
    client: createClient({
      baseUrl,
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'error' }),
      headers: () => ({ authorization: `Bearer ${key}` }),
      ...(businessId === undefined ? {} : { business: () => businessId }),
    }),
    allowPublish: publish === 'true',
  };
}
