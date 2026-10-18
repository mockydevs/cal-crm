# Claude Messages API fixtures

Written by hand from Anthropic's published documentation, read on 2026-10-10. Nothing here
was recorded from a real account: ids, signatures and request ids are made up.

| File | What it is | Source |
|---|---|---|
| `text.sse` | A streamed text answer | <https://platform.claude.com/docs/en/build-with-claude/streaming>, "Basic streaming request" |
| `tool-use.sse` | A streamed turn with a thinking block, text and two `tool_use` blocks | the same page, "Streaming request with tool use" and "Streaming request with thinking"; block shapes from <https://platform.claude.com/docs/en/api/messages> (`ThinkingBlock`, `ToolUseBlock`) |
| `redacted-thinking.sse` | A turn that starts with a `redacted_thinking` block | <https://platform.claude.com/docs/en/build-with-claude/thinking>, "Redacted thinking blocks" |
| `refusal.sse` | `stop_reason: "refusal"` with `stop_details` | <https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons>, "refusal"; `RefusalStopDetails` in the API reference |
| `max-tokens.sse` | A turn cut off inside a tool's input | the same page, "max_tokens" |
| `overloaded.sse` | An `error` event after the stream began | the streaming page, "Error events" |
| `error-authentication.json` | An error body | <https://platform.claude.com/docs/en/api/errors>, "Error shapes" |
| `models.json` | `GET /v1/models` | <https://platform.claude.com/docs/en/api/models/list> |

Every `usage` object has the fields of `Usage` and `MessageDeltaUsage` in the API reference:
`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.
The counts in `message_delta` are cumulative. Only `Usage`, in `message_start`, has
`cache_creation` (the writes by lifetime, `ephemeral_5m_input_tokens` and
`ephemeral_1h_input_tokens`, read on 2026-10-14). The fixtures leave it out, and tests that
need it add it to a copy (`anthropic.int.test.ts`; the stand-in in `test/fake-anthropic.ts`).
