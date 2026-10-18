# packages/contracts

The public API's contracts, as Zod 4 schemas.
The server validates with them, the SDK is typed by them, and the OpenAPI document is
generated from them.

| Module | What it holds |
|---|---|
| `endpoints.ts` | `Endpoint`: an operation's method, path, parameters, body and response |
| `api.ts` | `endpoints`: every operation of the API |
| `tags.ts` | Tags: `tag`, `createTagInput`, `createTag`, `listTags` |
| `problems.ts` | Errors as RFC 9457 problem details, and `problemFor(error)` for the server |
| `validation.ts` | `parseInput(schema, input)`: input that doesn't fit becomes a `ValidationError` |
| `events.ts` | The event envelope, field for field the `events.events` table |
| `ids.ts`, `timestamps.ts` | Public ids (`tag_…`) and ISO 8601 timestamps |
| `openapi.ts` | The OpenAPI 3.1 document, exported as `@repo/contracts/openapi` |

## Changing the API

1. Change or add the schemas and the `Endpoint`, and list a new endpoint in `api.ts`.
2. Regenerate the document and review its diff with the change:

   ```bash
   pnpm --filter @repo/contracts openapi
   ```

   `openapi.json` is the reviewed contract: the tests fail until it matches the schemas.

**Rules that keep clients working:**
- Request bodies are strict objects, so unknown fields are refused.
- Response objects are loose, so adding a field never breaks a client.
- Removing or renaming a field, or tightening what a request accepts, is a breaking change.
