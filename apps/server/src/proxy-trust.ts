// What the server says at start about the proxies in front of it (TRUST_PROXY).
//
// The server reads each client's address through the proxies it was told to trust, from
// X-Forwarded-For; told of none, it takes the address of whatever connected to it
// (server.ts, Fastify's trustProxy). The rate limits of the public pages, the sign-in limit
// and the audit log all count by that address.
//
// In production the address people use is https (config.ts refuses anything else) and this
// server speaks plain HTTP, so something in front of it always ends TLS and passes the
// request on: a reverse proxy, and perhaps a CDN before that. With TRUST_PROXY empty every
// visitor then has the proxy's address: together they share one visitor's limit (120 page
// views and 10 submissions a minute, ten sign-in attempts in fifteen minutes), and the
// audit log names the proxy. Nothing is unsafe; the install just refuses its own visitors.
import { CLOUDFLARE } from './client-address.js';
import type { Config } from './config.js';

/** What to warn about at start, or undefined when there is nothing to say. */
export function proxyTrustWarning(
  config: Pick<Config, 'nodeEnv' | 'role' | 'trustProxy'>,
): string | undefined {
  // The worker serves /health and /ready only: nobody's address is counted there.
  if (config.nodeEnv !== 'production' || config.role === 'worker') return undefined;
  if (config.trustProxy.length === 0)
    return (
      'TRUST_PROXY is empty. This server is reached through a reverse proxy (the public ' +
      'address is https, and the server speaks plain HTTP), so every visitor will seem to ' +
      'come from the proxy and share one rate limit and one sign-in limit. Set TRUST_PROXY ' +
      "to the proxy's address or network, and cloudflare if Cloudflare's proxy is in front " +
      '(docs/HOSTING.md, "The visitor\'s address").'
    );
  // Cloudflare reaches this server only through the reverse proxy that ends TLS, so a list
  // with Cloudflare alone stops at that proxy, and every visitor shares its address.
  if (config.trustProxy.every((entry) => entry === CLOUDFLARE))
    return (
      'TRUST_PROXY names cloudflare and no reverse proxy. Cloudflare reaches this server ' +
      'through the reverse proxy that ends TLS, so every visitor will seem to come from that ' +
      "proxy and share one rate limit and one sign-in limit. Add the proxy's address or " +
      'network before cloudflare (docs/HOSTING.md, "The visitor\'s address").'
    );
  return undefined;
}
