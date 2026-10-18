# packages/sdk

A typed client for the public API. Its types come from the contracts
(`@repo/contracts`), so it can't drift from the server.

```ts
import { createTag, listTags } from '@repo/contracts';
import { ApiError, createClient } from '@repo/sdk';

const api = createClient({
  baseUrl: '/api/v1',
  headers: () => ({ authorization: `Bearer ${apiKey}` }),
});

const tag = await api.request(createTag, { body: { name: 'Hot lead' } });
const { items } = await api.request(listTags, {});
```

Only the API URL and key are required. A subaccount key identifies its account; omit
business selectors. An agency key defaults to agency scope. To select an active
subaccount in the same agency, pass its slug for that call:

```ts
import type { RequestOptions } from '@repo/sdk';

const target: RequestOptions = { businessSlug: 'harbor-lights' };
const tags = await api.request(listTags, {}, target);
```

This sends `Business-Slug` as a header without changing the client or API input.
Concurrent calls can select different slugs. Existing two-argument calls retain their
default scope. The API enforces the key's account access and permissions; a slug
does not grant access.

The legacy `ClientOptions.business` callback still supplies a `Business-Id`. An explicit
per-call slug replaces that selector, including any business selector in custom headers,
so a request does not send both. `CRM_BUSINESS_ID` is not needed for key-only integrations.

- Answers are checked against the endpoint's response schema.
- An error answer becomes an `ApiError`, with the problem details (RFC 9457) under
  `error.problem` and the HTTP status under `error.status`. For a validation error,
  `error.problem.errors` lists each issue with a JSON Pointer to its field.
