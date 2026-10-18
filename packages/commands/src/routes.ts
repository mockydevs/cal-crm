import type { Readable } from 'node:stream';

import type { Endpoint, EndpointOutput } from '@repo/contracts';

import type * as z from 'zod';

import type { Command, Invocation, Services } from './command.js';

/**
 * The command a route runs, if any. The permission matrix test runs each one as every
 * built-in role.
 */
export type RouteCommand = Pick<Command<z.ZodType, unknown>, 'name' | 'permission'>;

/**
 * An upload endpoint's body (Endpoint.upload), handed over unread, so the server never
 * holds a whole file.
 */
export interface UploadBody {
  readonly stream: Readable;
  /** The request's Content-Type. */
  readonly contentType: string | undefined;
  /** The request's Content-Length, when it states one. */
  readonly contentLength: number | undefined;
}

/**
 * One HTTP request, as the server hands it over: parameters, query and body unparsed. For an
 * upload endpoint, the body is an UploadBody.
 */
export interface RouteRequest {
  readonly invocation: Invocation;
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
}

/**
 * How the API answers one endpoint. The run function validates what it needs, since the
 * same commands also run outside HTTP. Declare one with `satisfies Route<typeof endpoint>`,
 * which checks the answer against the endpoint's response type.
 */
export interface Route<E extends Endpoint> {
  readonly endpoint: E;
  readonly command?: RouteCommand;
  run(request: RouteRequest, services: Services): Promise<EndpointOutput<E>>;
}

/** Any route, as the server lists and registers them. */
export interface ApiRoute {
  readonly endpoint: Endpoint;
  readonly command?: RouteCommand;
  run(request: RouteRequest, services: Services): Promise<unknown>;
}
