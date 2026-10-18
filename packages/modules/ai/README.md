# AI module

Owns the `ai` schema: saved contact memory, and the gateway every model call goes through.

## Contact memory

`GET /contacts/{id}/memory` returns `{ summary: null }` when a visible contact has no saved
memory, or `{ summary: { text, updatedAt, throughEventId } }`. It never returns model names,
provider configuration or credentials. Trashed contacts retain their readable memory.
Missing and foreign contacts return 404 through CRM's public `requireRecord` interface;
the module does not query another module's tables. The request uses the ordinary business
context, authentication and row-level security. No write command or new permission is added.
Reading memory never calls a provider.

## The gateway

`createAiGateway(...).generate(context, request)` is the one way to a model. It runs in the worker, which alone
can open a provider's key; the server builds it in `apps/server/src/worker/ai.ts`.

```ts
const result = await gateway.generate(job.invocation.context, {
  job: 'replies', // automation_builder, replies, briefings or sorting
  promptVersion: 'replies/1', // kept with the call
  system: '…', // the same for every business, so a provider's cache can be shared
  messages: [{ role: 'user', text: '…' }],
  tools: [{ name: 'find_contacts', description: '…', inputSchema: { type: 'object' } }],
  maxOutputTokens: 4000,
});
```

What comes back is one of six outcomes:

| Outcome          | Meaning                                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| `ok`             | `parts`, `text`, why it stopped, usage, the cost (or null), and the call's row  |
| `refused`        | The model declined. No other model is asked                                     |
| `failed`         | Every model that could be tried failed; `code` is the last failure's category   |
| `paused`         | The spending limit was reached, or cannot be kept for a model with no price     |
| `off`            | AI is turned off for the business                                               |
| `not_configured` | No key, a key that cannot be opened, or a provider there is no adapter for yet  |

What it does on the way:

- **The model for the job.** `ai.job_models`, or the job's default
  (`DEFAULT_JOB_MODELS`). The key is the agency's or the business's own, as
  `ai.settings.key_source` says. A business with no settings row runs on the columns'
  defaults.
- **The backup model** (`ai.settings.backup_*`) takes over after a failure. A busy
  provider is called once more first, after the wait it asked for.
- **The spending limit.** A call is admitted under a lock on the business's settings row,
  against the month's spend plus what calls in flight hold.
- **Masking.** With `mask_contact_details` on, the system prompt, people's messages and
  tool results are masked before any adapter sees them. A model's own earlier turn goes
  back unchanged. The request log is always masked.
- **`ai.requests`.** One row for every provider request, written before the request and
  updated after it.

`maskContactDetails` removes common ASCII email addresses and phone-like sequences of 7 to
15 digits, including international and Kenyan local formatting. It preserves ISO dates,
short numbers and alphanumeric identifiers. This conservative heuristic also masks long
plain numbers, such as an order number or an amount of seven digits or more; it does not
promise to find every obfuscated address, Unicode email or written-out phone number. No
reversible map is kept.

### Tool loops

A turn's `parts` are text, tool calls and `reasoning` (the provider's own record of its
thinking, opaque to us). To continue after tool calls, send the conversation again with the
turn as it was received and the results after it:

```ts
messages: [
  ...earlier,
  { role: 'assistant', parts: result.parts }, // unchanged: never edit, reorder or drop
  { role: 'tool', results: [{ toolCallId: call.id, text: '…' }] },
];
```

Stop on `stop: 'max_tokens'`: such a turn carries no tool calls, because a call cut off in
the middle can still look whole.

### Prices and cost

Costs are estimates in US dollars, exact to a millionth, computed with `bigint`
(`estimateCostMicros`). A price is USD for a million tokens with a source and the day it
was checked: `ai.model_prices` for what an agency enters, over `BUILT_IN_PRICES`
(Anthropic's list prices). A model with no price has no cost: `costMicros` is null and
`ai.requests.cost_estimate` is NULL, never zero. The same when a server reports no usage.

### Providers

| Provider            | Adapter        | Address                                                    |
| ------------------- | -------------- | ---------------------------------------------------------- |
| `anthropic`         | `anthropic.ts` | `https://api.anthropic.com`, fixed                         |
| `openai`            | `openai.ts`    | `https://api.openai.com/v1`, fixed                         |
| `openai_compatible` | `openai.ts`    | The row's `base_url`, checked against `AI_LOCAL_SERVERS`          |
| `gemini`            | none yet       | `not_configured`                                           |

Each adapter is written against its vendor's documented HTTP API. The adapters
and the transport are not exported: nothing outside this module can call a provider around
the gateway.

A model server on a private address or plain `http` is called only when the install lists
its host and port in `AI_LOCAL_SERVERS`. `checkBaseUrl` is
the same check for Settings to run when an address is saved.

### Settings → AI models

`createAiSettingsRoutes({ vault, localServers, people })` is the API of the settings page; the server mounts it when it has a
vault. Every route needs `ai.manage`, reading included.

| Route | What it does |
| --- | --- |
| `GET /ai/connections` | In a business: its own connections, then its agency's without their details. At the agency: the agency's |
| `POST /ai/connections` | Seals the key, saves the connection and queues its test |
| `PATCH /ai/connections/{id}` | Replaces the key, the address or the model, and queues a test |
| `DELETE /ai/connections/{id}` | Removes the connection and destroys its key |
| `POST /ai/connection-tests`, `GET /ai/connection-tests/{id}` | Queues a test, and reads what it found |
| `GET /ai/settings`, `PUT /ai/settings` | A business's models, backup, key source, limit and privacy, saved whole against a revision |
| `GET /ai/usage` | This month's spend by job and the twenty latest calls, never what was said |
| `GET /ai/model-prices`, `PUT /ai/model-prices`, `DELETE /ai/model-prices?provider=&model=` | The prices costs are worked out from; written only at the agency |

A key is write-only: the app's vault can only seal, and no response schema has a field for
one. A model server's address is checked with `checkBaseUrl` when it is saved, and again by
the transport on every call.

The worker runs `createTestAiConnectionTask(gateway)`. In a business the task calls
`gateway.testConnection`: one call of sixteen tokens to the connection's model, admitted
under the business's limit and recorded in `ai.requests` as `connection_test`. At the
agency it calls `gateway.checkConnection`, which asks the provider for its models, calls no
model and records no call. A test ends in one of the outcomes of `aiTestOutcomes`
(`@repo/contracts`): the provider's nine failure categories, or a reason no request was
made (`limit_reached`, `price_unknown`, `ai_off`, `key_unreadable`, `not_supported`,
`no_model`, `expired`).

### Housekeeping

`expireAiRequestLogs` clears request logs past the days their business keeps them. The
worker runs it every hour as `ai.maintain`.

## Proposals, approvals, undo and autonomy

"The AI works, people decide".
What an assistant wants to do is a row in `ai.proposals` holding one command by name with
that command's input. This module keeps the rows and knows no command: the server hands
it the commands that can be proposed (`createAssistantRoutes({ proposables })`), which
each module declares for itself with `defineProposable` (`@repo/commands`).

- **`storeProposal`** is how an assistant proposes. It runs nothing: the input is checked as
  its command would check it, fingerprinted and kept. A waiting proposal of the same kind
  for the same conversation is closed as expired.
- **Apply, Dismiss and Undo** (`POST /proposals/{id}/apply|dismiss|undo`) need the
  permission the proposal's command needs, and have none of their own.
  - Apply runs the command through the command layer as whoever applies it, with the
    proposal's row locked in the same transaction, so two people or two clicks apply it
    once. It is refused (409, in plain words) when the proposal is stale, expired,
    dismissed or undone, and as the command itself would refuse the person. `changes`
    replaces what was proposed where the kind allows it (a reply: everything the composer
    chooses, never the retry key).
  - Undo runs the command that was worked out to reverse it, the same way, or says why
    nothing can ("A message that was sent can’t be unsent.").
- **Autonomy** (`GET`/`PUT /ai/autonomy`): suggest, ask first or act, per assistant and
  kind of action, for the business or one contact; changing it needs `ai.manage`. The
  command layer reads these rows before any command an assistant runs.
- `expireAiProposals` closes proposals past their time, for the worker's hourly
  `ai.maintain` task.

## The inbox agent's reply drafts

One job, with no tools.

- **`reply-draft.ts`** is the whole of what the model is asked and of what is done with its
  answer: instructions that are the same for every business, one conversation as a JSON
  document between two markers it cannot contain, no tools, and an answer read as text
  only. It has no database and no clock; the eval suite runs exactly this.
- **`reply-drafts.ts`** is the job (`ai.draft_reply`) and its rows (`ai.draft_requests`).
  It reads one conversation through `ReplyDraftSources` (the Inbox's own reader, handed
  over by the server), asks the model through the gateway outside any transaction, and
  stores the answer as a proposal only if the thread is still the one it read. It sends
  nothing. Where the business set the inbox agent to "act", it applies its own proposal
  through the command layer as the assistant, which checks that rule itself.
- A draft is asked for by an arriving message (a trigger on the event log queues the job,
  one per conversation, a few seconds on) or by a person
  (`POST /conversations/{id}/assistant/draft`). `GET /conversations/{id}/assistant` is what
  the Inbox shows: the draft being written or why there is none, the proposals waiting
  and recently decided, and the level for this contact.
- Memory is `ai.contact_summaries` and `ai.contact_facts` (confirmed and proposed), which
  field extraction fills. Knowledge is whatever `ReplyDraftSources.knowledge` returns: today the
  business's profile; the knowledge base plugs in there.

## Evals

"Tested" for a job and a model means the model passed the project's eval suite for that
job. The harness is in `src/evals`;
the datasets and the run reports of Tested models are in the repository's
[`evals`](../../../evals/README.md) folder, whose README is the guide to writing a suite
and running one.

- `isTested(job, provider, model)` (`src/evals/tested.ts`) answers from the registry,
  `src/evals/tested.gen.ts`. Only the `record` command adds to that file, and only for a
  run report that passed its job's threshold. It is empty today: one job has a suite
  (`replies`, `src/reply-draft-evals.ts`), and no live run of it has been made.
- A job adds its suite to `src/evals/suites.ts` and its cases to
  `evals/suites/<job>/cases.json`. A suite's `run` is the job's own code over
  `gateway.generate`.
- The commands are `pnpm --filter @repo/module-ai evals -- list | run | replay | record |
  forget | gate [--release]`, from the module's build. Only `run` calls a model: by hand,
  with the key in `EVAL_API_KEY` and a budget in `--budget-usd`.
- `gate` plays every Tested model's recorded run back through the suite as it is now, with
  no key and no network. It also runs in the unit tests (`src/evals/gate.test.ts`), so a
  changed prompt or dataset fails `pnpm --filter @repo/module-ai test` until its Tested
  models are evaluated again or forgotten.

The harness's own tests use a fixture suite (`src/evals/fixtures`) against the local
stand-ins. It is not a job of the product and evaluates no model.

The replies suite has a recording of a run against a local stand-in that answers with
sentences a person wrote (`evals/stand-in/replies/`, `test/reply-stand-in.ts`). The unit
tests make that run again through the real adapter, compare it with the file, and replay
it. It evaluates no model either: `record` and the gate refuse a model named `stand-in`.
`pnpm --filter @repo/module-ai run evals:stand-in` writes the recording again after the
prompt or the dataset changed.

## Tests

```bash
pnpm --filter @repo/module-ai test              # masking, prices, SSE, addresses, the transport
pnpm --filter @repo/module-ai test:integration  # the gateway against Postgres; the adapters against stand-ins
```

No test calls a real provider. The adapters are tested over real sockets against local
stand-ins (`test/fake-anthropic.ts`, `test/fake-openai.ts`) that replay fixtures written
from the vendors' documentation (`src/fixtures`, each folder's README names its sources).

One run is outside those gates: the OpenAI-compatible adapter against a real, local Ollama
with a small model.

```bash
docker run -d --name ollama -p 127.0.0.1:11434:11434 ollama/ollama
docker exec ollama ollama pull qwen2.5:0.5b
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 OLLAMA_MODEL=qwen2.5:0.5b \
  pnpm --filter @repo/module-ai test:ollama
```
