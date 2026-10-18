// Refresh hints only: the normal API remains responsible for every data read.
import type { Server as HttpServer } from 'node:http';
import { Socket as TcpSocket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { isUuidV7, parsePublicId, toPublicId } from '@repo/kernel';
import type { Authentication } from '@repo/module-auth';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { Server, type Socket } from 'socket.io';

interface Events {
  'business.changed': (payload: { readonly businessId: string }) => void;
}
interface SocketData {
  businessId: string;
}
type BusinessSocket = Socket<Record<string, never>, Events, Record<string, never>, SocketData>;

interface Options {
  readonly httpServer: HttpServer;
  readonly databaseUrl: string;
  readonly publicUrl: string;
  readonly authentication: Pick<Authentication, 'signedIn' | 'workplace'>;
  readonly logger: FastifyBaseLogger;
}

export interface Realtime {
  /** Readiness fails while the dedicated LISTEN connection is down. */
  readonly ready: () => Promise<void>;
  close(): Promise<void>;
}

export function startRealtime(options: Options): Realtime {
  const { authentication, logger } = options;
  const io = new Server<Record<string, never>, Events, Record<string, never>, SocketData>(
    options.httpServer,
    {
      serveClient: false,
      transports: ['websocket'],
      maxHttpBufferSize: 4096,
      allowRequest: (request, done) => {
        done(null, request.headers.origin === new URL(options.publicUrl).origin);
      },
    },
  );
  async function authorized(socket: BusinessSocket, businessId: string): Promise<boolean> {
    const headers = new Headers();
    // Only the original session cookie is trusted; clients cannot supply an identity.
    const cookie = socket.request.headers.cookie;
    if (cookie !== undefined) headers.set('cookie', cookie);
    const person = await authentication.signedIn(headers);
    if (person?.agencyId === undefined || (person.twoFactorRequired && !person.twoFactorEnabled))
      return false;
    const workplace = await authentication.workplace(person, businessId);
    return workplace.at === 'business' && workplace.businessId === businessId;
  }
  io.use((socket, next) => {
    const input: unknown = socket.handshake.auth['businessId'];
    const businessId = typeof input === 'string' ? parsePublicId('business', input) : undefined;
    if (businessId === undefined) {
      next(new Error('Sign in and choose a business.'));
      return;
    }
    void authorized(socket, businessId)
      .then((allowed) => {
        if (!allowed) {
          next(new Error('Sign in and choose a business.'));
          return;
        }
        socket.data.businessId = businessId;
        next();
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'realtime authentication failed');
        next(new Error('Sign in and choose a business.'));
      });
  });
  io.on('connection', (socket) => {
    void socket.join(socket.data.businessId);
  });

  async function publish(businessId?: string): Promise<void> {
    const sockets = [...io.sockets.sockets.values()].filter(
      (socket) => businessId === undefined || socket.rooms.has(businessId),
    );
    await Promise.all(
      sockets.map(async (socket) => {
        try {
          if (!(await authorized(socket, socket.data.businessId))) {
            socket.disconnect(true);
            return;
          }
          if (socket.connected)
            socket.emit('business.changed', {
              businessId: toPublicId('business', socket.data.businessId),
            });
        } catch (error) {
          logger.error({ err: error }, 'realtime authorization failed');
          socket.disconnect(true);
        }
      }),
    );
  }

  const stopping = new AbortController();
  function logUnlessStopping(error: unknown, message: string): void {
    if (!stopping.signal.aborted) logger.error({ err: error }, message);
  }
  let listening = false;
  let connectedOnce = false;
  const listen = async () => {
    while (!stopping.signal.aborted) {
      // This connection only LISTENs. Abort its transport so a paused database cannot
      // hold shutdown waiting to acknowledge end(). pg's stream factory keeps TLS intact.
      // https://nodejs.org/api/net.html#new-netsocketoptions
      const stream = new TcpSocket({ signal: stopping.signal });
      const current = new pg.Client({
        stream: () => stream,
        connectionString: options.databaseUrl,
        application_name: 'crm-realtime',
        connectionTimeoutMillis: 5000,
      });
      const ended = Promise.withResolvers<undefined>();
      current.on('error', (error) => {
        logUnlessStopping(error, 'realtime database connection failed');
        ended.resolve(undefined);
      });
      current.on('end', () => {
        ended.resolve(undefined);
      });
      current.on('notification', (notification) => {
        if (
          notification.channel === 'crm_business_changed' &&
          notification.payload !== undefined &&
          isUuidV7(notification.payload)
        )
          void publish(notification.payload);
      });
      try {
        await current.connect();
        await current.query('LISTEN crm_business_changed');
        listening = true;
        if (connectedOnce) await publish(); // NOTIFY has no replay: fetch fresh state after a gap.
        connectedOnce = true;
        await ended.promise;
      } catch (error) {
        logUnlessStopping(error, 'realtime listener reconnect failed');
      } finally {
        listening = false;
        await current.end();
      }
      await delay(1000, undefined, { signal: stopping.signal }).catch(() => undefined);
    }
  };
  const running = listen();
  return {
    ready: () =>
      listening ? Promise.resolve() : Promise.reject(new Error('Realtime listener unavailable.')),
    async close() {
      stopping.abort();
      await Promise.all([running, io.close()]);
    },
  };
}
