// Which header names a webhook step may set: apart from the step's schema, which the
// builder's canvas loads with the catalog, so only the validator and the sender carry it.
/**
 * Header names a step can't set: those the engine sets itself (the body's type and length,
 * its user agent, and every X-CRM- header, which carry the signature and delivery id), and
 * those that belong to the connection rather than the request (RFC 9110 section 7.6.1).
 */
const ENGINE_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'user-agent',
]);

/** Whether a step may set a header by this name. Compared without regard to capitals. */
export function isAllowedWebhookHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return !ENGINE_HEADERS.has(lower) && !lower.startsWith('x-crm-') && !lower.startsWith('proxy-');
}
