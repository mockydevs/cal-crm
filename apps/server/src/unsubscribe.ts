import { createReadStream } from 'node:fs';
import { unsubscribeRequest, unsubscribeToken } from '@repo/contracts';
import { Busboy } from '@fastify/busboy';
import type { Database } from '@repo/db';
import { unsubscribeFromLink } from '@repo/module-messaging';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

function page(title: string, description: string, confirm = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
@font-face{font-family:"Lexend Variable";font-style:normal;font-weight:100 900;font-display:swap;src:url("/unsubscribe/fonts/lexend-latin.woff2") format("woff2")}
:root{color-scheme:light;--ground:#f2f5f1;--surface:#fff;--ink:#1d2a24;--muted:#56625b;--line:#dce3dc;--accent:#0f7a68;--accent-ink:#fff;--accent-hover:#0c6253;font-family:"Lexend Variable",ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:var(--ground)}
*{box-sizing:border-box}body{margin:0;padding:clamp(24px,5vw,64px) 16px;background:var(--ground)}
main{max-width:480px;margin:auto;background:var(--surface);border:1px solid var(--line);padding:clamp(24px,4vw,40px);border-radius:20px}
.context{font-size:14px;font-weight:500;color:var(--muted);margin:0 0 24px}
h1{font-size:clamp(24px,4vw,28px);font-weight:600;line-height:1.3;margin:0 0 20px}
p{font-size:16px;line-height:1.6;margin:0 0 24px}button{font:inherit;font-weight:500;color:var(--accent-ink);background:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:12px 24px;min-height:48px;max-width:100%;cursor:pointer}
button:hover{background:var(--accent-hover);border-color:var(--accent-hover)}button:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.note{color:var(--muted);font-size:14px;margin:24px 0 0}
</style></head><body><main><p class="context">Email preferences</p><h1>${title}</h1><p>${description}</p>
${confirm ? '<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>' : ''}
<p class="note">This preference applies to marketing emails from the sender of this link.</p>
</main></body></html>`;
}

const confirmation = page(
  'Unsubscribe from marketing emails',
  'Choose Unsubscribe to stop marketing emails from this sender.',
  true,
);
const success = page(
  'You are unsubscribed',
  'Your email marketing preference has been updated. You can close this page.',
);
const invalid = page(
  'This link cannot be used',
  'Open the unsubscribe link in an email from this sender and try again.',
);
const unavailable = page(
  'Could not update your preference',
  'Try again in a moment to stop marketing emails from this sender.',
  true,
);

function send(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').send(body);
}

/** RFC8058: GET is read-only; POST uses the capability alone, without session headers. */
export async function registerUnsubscribe(app: FastifyInstance, db: Database): Promise<void> {
  await app.register(
    (publicApp, _options, done) => {
      publicApp.removeAllContentTypeParsers();
      publicApp.setErrorHandler((error, request, reply) => {
        const status =
          error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500;
        if (status >= 400 && status < 500) return send(reply, status, invalid);
        // The capability and raw database/provider error never enter the log.
        request.log.error({ statusCode: 500 }, 'unsubscribe preference could not be updated');
        return send(reply, 500, unavailable);
      });
      // Fastify5.12.5 enforces the byte limit before invoking this encapsulated parser.
      publicApp.addContentTypeParser(
        ['application/x-www-form-urlencoded', 'multipart/form-data'],
        { parseAs: 'buffer', bodyLimit: 4096 },
        async (request: FastifyRequest, body: Buffer) => {
          try {
            const parser = new Busboy({
              headers: { 'content-type': request.headers['content-type'] ?? '' },
              // Parse a second field to detect duplicates. Busboy3.2.2's URL-encoded
              // parser can stop at the limit within one chunk without a limit event.
              limits: {
                fields: 2,
                parts: 2,
                files: 0,
                fieldNameSize: 64,
                fieldSize: 32,
                headerPairs: 16,
                headerSize: 1024,
              },
            });
            return await new Promise<unknown>((resolve) => {
              let fields = 0;
              let valid = true;
              const refuse = () => {
                valid = false;
              };
              parser.on('field', (name, value, nameTruncated, valueTruncated) => {
                fields += 1;
                if (
                  name !== 'List-Unsubscribe' ||
                  value !== 'One-Click' ||
                  nameTruncated ||
                  valueTruncated
                )
                  refuse();
              });
              parser.on('fieldsLimit', refuse);
              parser.on('partsLimit', refuse);
              parser.on('filesLimit', refuse);
              parser.on('error', () => {
                resolve(null);
              });
              parser.on('finish', () => {
                resolve(valid && fields === 1 ? { 'List-Unsubscribe': 'One-Click' } : null);
              });
              parser.end(body);
            });
          } catch {
            return null;
          }
        },
      );
      publicApp.addHook('onSend', async (_request, reply) => {
        reply.header('cache-control', 'no-store');
        reply.header('referrer-policy', 'no-referrer');
        reply.header('x-content-type-options', 'nosniff');
        reply.header('x-frame-options', 'DENY');
        reply.header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
      });
      publicApp.get('/fonts/lexend-latin.woff2', (_request, reply) =>
        reply
          .type('font/woff2')
          .send(
            createReadStream(
              new URL(
                import.meta
                  .resolve('@fontsource-variable/lexend/files/lexend-latin-wght-normal.woff2'),
              ),
            ),
          ),
      );
      publicApp.get<{ Params: { token: string } }>('/:token', (request, reply) =>
        send(
          reply,
          unsubscribeToken.safeParse(request.params.token).success ? 200 : 404,
          unsubscribeToken.safeParse(request.params.token).success ? confirmation : invalid,
        ),
      );
      publicApp.post<{ Params: { token: string } }>('/:token', async (request, reply) => {
        if (!unsubscribeRequest.safeParse(request.body).success) return send(reply, 400, invalid);
        const accepted = await unsubscribeFromLink(db, request.params.token, request.id);
        return send(reply, accepted ? 200 : 404, accepted ? success : invalid);
      });
      done();
    },
    { prefix: '/unsubscribe' },
  );
}
