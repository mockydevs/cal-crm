import type * as z from 'zod';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * One operation of the public API. The server routes and validates with it, the SDK
 * calls it, and the OpenAPI document describes it, so the three can't disagree.
 */
export interface Endpoint {
  /** Unique across the API: the OpenAPI operationId. */
  readonly operationId: string;
  readonly method: Method;
  /** Relative to /api/v1, with {name} for each path parameter. */
  readonly path: string;
  readonly summary: string;
  /** The group it's listed under in the API reference. */
  readonly group: string;
  /** Public routes have a separate transport; this never bypasses API authorization. */
  readonly audience?: 'public';
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: z.ZodType;
  /** A file as the request's raw content, in one of these types, rather than a JSON body. */
  readonly upload?: { readonly types: readonly string[] };
  /**
   * A file as the answer's whole content, in one of these types, rather than JSON: a
   * rendered PDF, say. The answer names the file in Content-Disposition.
   */
  readonly download?: { readonly types: readonly string[] };
  readonly response: {
    readonly status: 200 | 201 | 204;
    readonly description: string;
    readonly schema?: z.ZodType;
  };
}

/** Declares an endpoint, keeping its exact types for the SDK. */
export function defineEndpoint<const E extends Endpoint>(endpoint: E): E {
  return endpoint;
}

type Part<E, Key extends 'params' | 'query' | 'body'> =
  E extends Readonly<Record<Key, infer Schema extends z.ZodType>>
    ? Record<Key, z.input<Schema>>
    : unknown;

/**
 * What a caller sends: the path parameters, query and body the endpoint takes. A file for
 * an upload endpoint is the SDK's to type, since its form depends on where the SDK runs.
 */
export type EndpointInput<E extends Endpoint> = Part<E, 'params'> &
  Part<E, 'query'> &
  Part<E, 'body'>;

/** What a download endpoint (Endpoint.download) answers with, on the server and in the SDK. */
export interface FileDownload {
  readonly content: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  /** The name to save it under. */
  readonly filename: string;
}

/** What a successful call returns. */
export type EndpointOutput<E extends Endpoint> = E extends { readonly download: object }
  ? FileDownload
  : E['response'] extends {
        readonly schema: infer Schema extends z.ZodType;
      }
    ? z.output<Schema>
    : undefined;
