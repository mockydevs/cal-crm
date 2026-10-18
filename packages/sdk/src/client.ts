import {
  problem,
  type Endpoint,
  type EndpointInput,
  type EndpointOutput,
  type FileDownload,
  type Problem,
} from '@repo/contracts';

/** The API answered with an error: its problem details (RFC 9457) say what went wrong. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }

  get status(): number {
    return this.problem.status;
  }
}

export interface ClientOptions {
  /** Where the API is, such as https://crm.example.com/api/v1, or /api/v1 on the same site. */
  baseUrl: string;
  /** The fetch to use; the global one by default. */
  fetch?: typeof fetch;
  /** Headers for every request, such as the API key. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * The business each request works in, as a biz_ id, read as the request goes out. Without
   * one, agency staff work at the agency, and a business user in their only business.
   */
  business?: () => string | undefined;
}

/** A file for an upload endpoint: its bytes, such as a browser's File, and its type. */
export interface Upload {
  readonly content: Blob | Uint8Array<ArrayBuffer>;
  readonly type: string;
}

/** What a call sends: EndpointInput, and the file when the endpoint takes an upload. */
export type RequestInput<E extends Endpoint> = EndpointInput<E> &
  (E extends { readonly upload: object } ? { upload: Upload } : unknown);

/** Selects a business for this call only; the API checks the key's access. */
export interface RequestOptions {
  readonly businessSlug?: string;
}

export interface Client {
  /** Calls an endpoint and returns its answer, checked against the endpoint's contract. */
  request<E extends Endpoint>(
    endpoint: E,
    input: RequestInput<E>,
    options?: RequestOptions,
  ): Promise<EndpointOutput<E>>;
}

/** An object's fields; nothing for anything else. */
function fields(value: unknown): [string, unknown][] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const result: [string, unknown][] = Object.entries(value);
  return result;
}

/** A parameter as text: strings as they are, anything else as JSON. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** One part of a request, as RequestInput describes it for each endpoint. */
function part(input: unknown, name: 'params' | 'query' | 'body' | 'upload'): unknown {
  return fields(input).find(([field]) => field === name)?.[1];
}

function url(baseUrl: string, endpoint: Endpoint, input: unknown): string {
  let path = endpoint.path;
  for (const [name, value] of fields(part(input, 'params'))) {
    path = path.replace(`{${name}}`, encodeURIComponent(text(value)));
  }
  const query = new URLSearchParams();
  for (const [name, value] of fields(part(input, 'query'))) {
    if (value !== undefined) {
      query.set(name, text(value));
    }
  }
  const search = query.size > 0 ? `?${query.toString()}` : '';
  return `${baseUrl.replace(/\/+$/, '')}${path}${search}`;
}

/** What a request sends, if anything: a file as it is, or the body as JSON. */
function content(input: unknown): { body: BodyInit; type: string } | undefined {
  const upload = part(input, 'upload');
  if (isUpload(upload)) {
    return { body: upload.content, type: upload.type };
  }
  const body = part(input, 'body');
  return body === undefined ? undefined : { body: JSON.stringify(body), type: 'application/json' };
}

function isUpload(value: unknown): value is Upload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'content' in value &&
    (value.content instanceof Blob || value.content instanceof Uint8Array)
  );
}

/**
 * The name a download asks to be saved under, from its Content-Disposition (RFC 6266): the
 * full name as RFC 8187 encodes it when there is one, else the plain one, else none.
 */
function filenameOf(disposition: string | null): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A name that is not what it says: the plain one below.
    }
  }
  return /filename="([^"]*)"/i.exec(disposition ?? '')?.[1] ?? '';
}

/** A download endpoint's answer: the file's bytes, its type and its name. */
async function download(response: Response): Promise<FileDownload> {
  return {
    content: new Uint8Array(await response.arrayBuffer()),
    contentType: (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() ?? '',
    filename: filenameOf(response.headers.get('content-disposition')),
  };
}

async function problemFrom(response: Response): Promise<Problem> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = problem.safeParse(body);
  return parsed.success
    ? parsed.data
    : { type: 'about:blank', title: response.statusText, status: response.status };
}

export function createClient(options: ClientOptions): Client {
  async function request<E extends Endpoint>(
    endpoint: E,
    input: RequestInput<E>,
    requestOptions?: RequestOptions,
  ): Promise<EndpointOutput<E>>;
  async function request(
    endpoint: Endpoint,
    input: unknown,
    requestOptions?: RequestOptions,
  ): Promise<unknown> {
    const sending = content(input);
    const businessSlug = requestOptions?.businessSlug;
    const business = businessSlug === undefined ? options.business?.() : undefined;
    let headers: Record<string, string> = {
      // A download endpoint answers with its file; an error is problem details either way.
      accept:
        endpoint.download === undefined
          ? 'application/json, application/problem+json'
          : [...endpoint.download.types, 'application/problem+json'].join(', '),
      ...(sending === undefined ? {} : { 'content-type': sending.type }),
      ...(business === undefined ? {} : { 'business-id': business }),
      ...(await options.headers?.()),
    };
    if (businessSlug !== undefined) {
      // A per-call selection replaces any legacy selector, including custom casing.
      headers = {
        ...Object.fromEntries(
          Object.entries(headers).filter(
            ([name]) => !['business-id', 'business-slug'].includes(name.toLowerCase()),
          ),
        ),
        'business-slug': businessSlug,
      };
    }
    const send = options.fetch ?? fetch;
    const response = await send(url(options.baseUrl, endpoint, input), {
      method: endpoint.method.toUpperCase(),
      headers,
      ...(sending === undefined ? {} : { body: sending.body }),
    });

    if (!response.ok) {
      throw new ApiError(await problemFrom(response));
    }
    if (response.status !== endpoint.response.status) {
      throw new Error(
        `${endpoint.operationId} answered ${String(response.status)}, but its contract says ${String(endpoint.response.status)}.`,
      );
    }
    if (endpoint.download !== undefined) return download(response);
    const schema = endpoint.response.schema;
    return schema === undefined ? undefined : schema.parse(await response.json());
  }
  return { request };
}
