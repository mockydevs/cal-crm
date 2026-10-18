/** Classify only the prefix: malformed or unknown capability suffixes still stay private. */
export function redactedRequestUrl(url: string): string {
  const prefixOf = (path: string) =>
    path
      .split('?', 1)[0]
      ?.split('/')
      .slice(0, 4)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      })
      .join('/') ?? '';
  // Preserve raw dot segments: URL normalization could otherwise erase a sensitive prefix.
  const prefixes = [prefixOf(url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, ''))];
  if (prefixes.some((prefix) => prefix.startsWith('/unsubscribe')))
    return '/unsubscribe/[redacted]';
  if (prefixes.some((prefix) => prefix.startsWith('/api/v1/public')))
    return '/api/v1/public/[redacted]';
  if (prefixes.some((prefix) => prefix.startsWith('/book'))) return '/book/[redacted]';
  // The page where a visitor changes or cancels their appointment: the token in
  // /appointments/manage/<token> is the whole permission, so it is never logged, and the
  // page it opens is never stored (the server sends `no-store` for every address this
  // function changes).
  if (
    prefixes.some(
      (prefix) => prefix === '/appointments/manage' || prefix.startsWith('/appointments/manage/'),
    )
  )
    return '/appointments/manage/[redacted]';
  // A trigger link's token: the path is /l/<token> and nothing else lives there.
  if (prefixes.some((prefix) => prefix === '/l' || prefix.startsWith('/l/')))
    return '/l/[redacted]';
  // The link to a form's draft carries the token that opens it: /f/preview/<token>. A
  // form's own page, /f/<key>, carries a key that is public anyway and stays as it is.
  if (prefixes.some((prefix) => prefix === '/f/preview' || prefix.startsWith('/f/preview/')))
    return '/f/preview/[redacted]';
  // The link to a page's draft carries the token that opens it: /s/_preview/<token>. A
  // site's own pages, /s/<key>/<path>, carry a key that is public anyway and stay as they are.
  if (prefixes.some((prefix) => prefix === '/s/_preview' || prefix.startsWith('/s/_preview/')))
    return '/s/_preview/[redacted]';
  // A document's public address: /d/<token>, and what hangs under it (its PDF, its logo, a
  // quote's answer). The token opens the document, so none of it is logged.
  if (prefixes.some((prefix) => prefix === '/d' || prefix.startsWith('/d/')))
    return '/d/[redacted]';
  if (prefixes.some((prefix) => prefix.startsWith('/webhooks/twilio')))
    return '/webhooks/twilio/[redacted]';
  // Google's redirect back after consent carries a one-time code and the state in its
  // query: neither is logged, and the answer is never stored.
  if (url.split('?', 1)[0]?.startsWith('/api/v1/integrations/google/callback') === true)
    return '/api/v1/integrations/google/callback?[redacted]';
  return url;
}
