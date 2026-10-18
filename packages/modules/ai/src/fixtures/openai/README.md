# Chat Completions fixtures

Written by hand from OpenAI's published OpenAPI specification
(<https://github.com/openai/openai-openapi>, `openapi.yaml`, API version 2.3.0), read on
2026-10-10. Nothing here was recorded from a real account: ids and names are made up.

| File | What it is | Schema in the specification |
|---|---|---|
| `chat-completion.json` | A text answer | `CreateChatCompletionResponse`, `ChatCompletionResponseMessage`, `CompletionUsage` |
| `chat-completion-tool-calls.json` | An answer that calls two tools | `ChatCompletionMessageToolCall` |
| `chat-completion-refusal.json` | A refusal | `ChatCompletionResponseMessage.refusal` |
| `stream-text.sse` | A streamed text answer with the usage chunk | `CreateChatCompletionStreamResponse`, `ChatCompletionStreamOptions`; the `[DONE]` frame from the `POST /chat/completions` response description |
| `stream-tool-calls.sse` | A streamed answer whose tool calls arrive in pieces | `ChatCompletionMessageToolCallChunk` |
| `error-rate-limit.json` | An error body | `ErrorResponse`, `Error`; types and codes from <https://developers.openai.com/api/docs/guides/error-codes> |
| `models.json` | `GET /models` | `ListModelsResponse`, `Model` |

What a model server of one's own may leave out is not in these files: the tests take a
field away from a fixture to stand for it (no `usage`, no tool-call `id`, no `[DONE]`).
