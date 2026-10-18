import type { AiMessage, AssistantPart, ToolDefinition } from './provider.js';

/** Remove contact details before provider transmission; no reversible map is retained. */
export function maskContactDetails(text: string): string {
  return text
    .replace(
      /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi,
      '[email]',
    )
    .replace(/(?<![\p{L}\p{N}])\+?\d(?:[ ()-]*\d){6,14}(?![\p{L}\p{N}])/gu, (value) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      return '[phone]';
    });
}

interface Outbound {
  readonly system: string;
  readonly messages: readonly AiMessage[];
}

/**
 * Masks everything the install adds to a request: the system prompt, what people wrote and
 * what tools returned. A model's own earlier turn goes back as the model wrote it: it came
 * from the provider, and the provider refuses a turn that was changed on the way back.
 */
export function maskOutbound<T extends Outbound>(request: T): T {
  return {
    ...request,
    system: maskContactDetails(request.system),
    messages: request.messages.map((message): AiMessage => {
      if (message.role === 'user') return { ...message, text: maskContactDetails(message.text) };
      if (message.role === 'assistant') return message;
      return {
        ...message,
        results: message.results.map((result) => ({
          ...result,
          text: maskContactDetails(result.text),
        })),
      };
    }),
  };
}

/** The most of one text the request log keeps. */
export const LOG_TEXT_LIMIT = 20_000;

const logged = (text: string): string => {
  const masked = maskContactDetails(text);
  return masked.length > LOG_TEXT_LIMIT ? `${masked.slice(0, LOG_TEXT_LIMIT)}…` : masked;
};

function loggedValue(value: unknown): unknown {
  if (typeof value === 'string') return logged(value);
  if (Array.isArray(value)) return value.map(loggedValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, loggedValue(each)]));
}

export interface LoggedParts {
  readonly text: string;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
}

/** A model's turn for the request log: masked, and without its thinking. */
export function partsLog(parts: readonly AssistantPart[]): LoggedParts {
  return {
    text: logged(parts.map((part) => (part.type === 'text' ? part.text : '')).join('')),
    toolCalls: parts
      .filter((part) => part.type === 'tool_call')
      .map((part) => ({ id: part.id, name: part.name, input: loggedValue(part.input) })),
  };
}

export interface LoggedRequest {
  readonly system: string;
  readonly messages: readonly unknown[];
  /** Names only: the definitions are the product's own and the same for every business. */
  readonly tools: readonly string[];
}

/**
 * A request for ai.requests.log. The log is always masked, whether or not the business
 * masks what it sends: a log is read by people, long after the call.
 */
export function logOf(
  request: Outbound & { readonly tools?: readonly ToolDefinition[] },
): LoggedRequest {
  return {
    system: logged(request.system),
    messages: request.messages.map((message) => {
      if (message.role === 'user') return { role: 'user', text: logged(message.text) };
      if (message.role === 'assistant') return { role: 'assistant', ...partsLog(message.parts) };
      return {
        role: 'tool',
        results: message.results.map((result) => ({ ...result, text: logged(result.text) })),
      };
    }),
    tools: (request.tools ?? []).map((tool) => tool.name),
  };
}
