// The boundary every model provider is called through. An adapter turns this shape into its
// vendor's request and the vendor's answer back into it, so the gateway, the agent loop and
// the evals read one shape whichever model answered.

/** The providers a key can belong to (ai.provider_keys.provider). */
export const AI_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openai_compatible'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/**
 * How long a provider is asked to keep the shared prefix of a request cached: five minutes,
 * or an hour at a dearer write. Only Claude lets the caller choose.
 */
export type CacheTtl = '5m' | '1h';

/** Tokens as the provider billed them. */
export interface TokenUsage {
  /** Fresh input only; cached tokens belong in the separate cache counters. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** Every token written to the cache, whatever the cache's lifetime. */
  readonly cacheWriteTokens: number;
  /**
   * Of `cacheWriteTokens`, those written to the one-hour cache, which are billed at their
   * own price. Left out: none were.
   */
  readonly cacheWrite1hTokens?: number;
}

export interface ModelPrices {
  /** USD millionths per million tokens. Supplied by checked, editable price tables. */
  readonly input: bigint;
  readonly output: bigint;
  readonly cacheRead: bigint;
  /** A write to the five-minute cache, or to the only cache a provider has. */
  readonly cacheWrite: bigint;
  /**
   * A write to the one-hour cache. Left out, the price is not known, and the gateway never
   * asks for that cache.
   */
  readonly cacheWrite1h?: bigint;
}

/** A JSON object, as a tool's input and a tool's schema are. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** A tool the model may ask for. The name is 1 to 64 of a-z, A-Z, 0-9, _ and -. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** A JSON Schema of type "object". */
  readonly inputSchema: JsonObject;
}

/**
 * One piece of a model's turn, in the order the model wrote it.
 *
 * `reasoning` is the provider's own record of its thinking (for Claude, a `thinking` or
 * `redacted_thinking` block with its signature). It is opaque: it goes back to the provider
 * that wrote it exactly as received, and to no other.
 */
export type AssistantPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_call';
      readonly id: string;
      readonly name: string;
      readonly input: JsonObject;
    }
  | { readonly type: 'reasoning'; readonly provider: AiProviderName; readonly data: JsonObject };

export interface ToolResult {
  readonly toolCallId: string;
  readonly text: string;
  readonly isError?: boolean;
}

/**
 * A turn of the conversation. An assistant turn must be the parts a provider returned,
 * unchanged: providers check that earlier turns come back as they wrote them.
 */
export type AiMessage =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly parts: readonly AssistantPart[] }
  | { readonly role: 'tool'; readonly results: readonly ToolResult[] };

export interface ProviderRequest {
  readonly model: string;
  /** The same for every business, so a provider's prompt cache can be shared (8.4). */
  readonly system: string;
  readonly messages: readonly AiMessage[];
  readonly tools?: readonly ToolDefinition[];
  /** The most the model may write, thinking included where a model thinks. */
  readonly maxOutputTokens: number;
  /**
   * How long to keep `tools` and `system` cached, where the provider lets the caller say.
   * Left out, five minutes. A provider without the choice ignores it.
   */
  readonly cacheTtl?: CacheTtl;
}

/** Why the model stopped. After `max_tokens` a turn is cut short and carries no tool calls. */
export type StopReason = 'end' | 'max_tokens' | 'tool_calls';

/**
 * Allowlisted failure categories; never a vendor's message, a URL or a credential.
 * `not_found` is the provider's 404: it has no such model, or nothing at that address.
 */
export const PROVIDER_ERROR_CODES = [
  'authentication',
  'billing',
  'rate_limited',
  'unavailable',
  'timeout',
  'invalid_request',
  'invalid_response',
  'blocked_address',
  'not_found',
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type ProviderResponse =
  | {
      readonly status: 'ok';
      readonly parts: readonly AssistantPart[];
      readonly stop: StopReason;
      /** Null when the server reported no usage, as a model server of one's own may. */
      readonly usage: TokenUsage | null;
    }
  | {
      readonly status: 'refused';
      /** The provider's category for the refusal, when it names one. */
      readonly category: string | null;
      readonly usage: TokenUsage | null;
    }
  | {
      readonly status: 'error';
      readonly code: ProviderErrorCode;
      /** What a rate limit or an overloaded server asked the caller to wait. */
      readonly retryAfterMs?: number;
      /** What was billed before the failure, when the provider had already said. */
      readonly usage: TokenUsage | null;
    };

export type ModelList =
  | { readonly status: 'ok'; readonly models: readonly string[] }
  | Extract<ProviderResponse, { readonly status: 'error' }>;

export interface ProviderCallOptions {
  readonly signal?: AbortSignal;
  /** The whole exchange, in milliseconds. */
  readonly timeoutMs?: number;
  /** Called with each piece of answer text as it arrives, where the provider streams. */
  readonly onTextDelta?: (text: string) => void;
}

/** Credentials stay in the adapter; neither prompts nor responses contain keys. */
export interface AiProvider {
  generate(request: ProviderRequest, options?: ProviderCallOptions): Promise<ProviderResponse>;
  /** The models the key can use: what "Test" in Settings calls, at no model cost. */
  listModels(options?: Pick<ProviderCallOptions, 'timeoutMs'>): Promise<ModelList>;
}

/** The text of a turn, with its other parts left out. */
export function textOf(parts: readonly AssistantPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The tool calls of a turn, in order. */
export function toolCallsOf(
  parts: readonly AssistantPart[],
): Extract<AssistantPart, { readonly type: 'tool_call' }>[] {
  return parts.filter((part) => part.type === 'tool_call');
}
