# Evals

"Tested" in Settings → AI models means one thing: the model passed this project's eval
suite for that job.
This folder holds the data behind that word. The code is in
`packages/modules/ai/src/evals`.

```
evals/
  suites/<job>/cases.json                  a job's dataset: its cases and their checks
  reports/<job>/<provider>--<model>.json   the run report of each model that is Tested
  stand-in/<job>/                          a run against a local stand-in: evaluates no model
```

Two jobs have a suite, each with a threshold of 0.9:

- `replies`, the inbox agent's reply drafts (twenty cases);
- `sorting`, which is the job field extraction and contact memory run as (twenty-three cases).

The other jobs add theirs as they are built.

**No model is Tested.** No live run has been made: it needs a provider's key and costs
money, and it is the owner's to make ("Evaluating a model" below). So `evals/reports/` is
empty, Settings says "Not tested yet" for every model, and `gate --release` fails for two
stated reasons: the default models for replies and for sorting have not been evaluated.

## The short version

| I want to | Command | Costs money |
|---|---|---|
| See the suites and the Tested models | `pnpm --filter @repo/module-ai evals -- list` | No |
| Evaluate a model | `EVAL_API_KEY=… pnpm --filter @repo/module-ai evals -- run --job <job> --provider <provider> --model <id> --budget-usd <amount>` | **Yes**, up to the budget |
| Check a report against the suite as it is now | `pnpm --filter @repo/module-ai evals -- replay <report>` | No |
| Mark a model Tested | `pnpm --filter @repo/module-ai evals -- record <report>` | No |
| Say a model is no longer Tested | `pnpm --filter @repo/module-ai evals -- forget --job <job> --provider <provider> --model <id>` | No |
| Check every Tested model | `pnpm --filter @repo/module-ai evals -- gate` | No |
| The same, before a release | `pnpm --filter @repo/module-ai evals -- gate --release` | No |
| Write the stand-in recording again | `pnpm --filter @repo/module-ai run evals:stand-in` | No |

The command is the module's build output, so build first:
`pnpm turbo run build --filter=@repo/module-ai`. A path given to a command is read from the
folder you call pnpm in.

Only `run` calls a model. Nothing in CI and no test ever does.

## Writing a suite

A suite has two parts.

**The code**, next to the job's own code in `packages/modules/ai/src`, registered in
`src/evals/suites.ts`:

```ts
export const repliesSuite: SuiteDefinition = {
  job: 'replies', // one of the gateway's jobs (AI_JOBS)
  version: 'replies/1', // the version of the job's prompt
  threshold: 0.9, // the share of cases that must pass: above 0, at most 1
  async run(evalCase, { gateway, context }) {
    // The job's real code: build the prompt, call gateway.generate (as often as the job
    // does), and give back the object the checks are scored against.
    return { text: '…', toolCalls: [{ name: 'find_contacts', input: { limit: 5 } }] };
  },
};
```

`run` is the job's own code path, not a copy of its prompt: the harness never builds a
prompt. It may reach a model only through the `gateway` it is given, and it should do
nothing else that touches the outside (no database, no clock, no random choice), because
the gate runs it again from a recording and expects the same requests. It must give back an
object for any answer of the model's, a refusal included. An error thrown from `run` makes
the run incomplete.

**The dataset**, `evals/suites/<job>/cases.json`. Plain JSON, formatted by Prettier:

```json
{
  "job": "replies",
  "cases": [
    {
      "id": "asks-for-a-date",
      "input": { "message": "Can you do the 14th?" },
      "expect": [
        { "type": "contains", "path": "text", "value": "14th" },
        { "type": "not_contains", "path": "text", "value": "@" },
        { "type": "length_at_most", "path": "text", "value": 600 }
      ]
    }
  ]
}
```

- `id`: unique in the file, 1 to 64 of `a-z`, `0-9` and `-`.
- `input`: an object, handed to the suite's `run` as `evalCase.input`.
- `expect`: at least one check. A case passes when every check passes.

Use made-up people and messages. A dataset is committed, and a run sends it to a provider.

### Checks

A check is plain data and gives the same answer every time for the same output. `path` is
a dot path into the object `run` gave back: `text`, `fields.budget`, `toolCalls.0.name`.

| Check | Passes when |
|---|---|
| `{ "type": "equals", "path", "value" }` | the value at the path is exactly `value` (objects whatever their key order) |
| `{ "type": "contains", "path", "value", "caseInsensitive"? }` | the text at the path contains `value` |
| `{ "type": "not_contains", "path", "value", "caseInsensitive"? }` | the text at the path does not contain `value` |
| `{ "type": "matches", "path", "pattern", "flags"? }` | the text at the path matches the regular expression; `flags` of `i`, `m`, `s`, `u` |
| `{ "type": "one_of", "path", "values" }` | the value at the path is one of `values` |
| `{ "type": "tool_called", "name", "input"? }` | the output's `toolCalls` (a list of `{ name, input }`) has a call of that tool, with at least the values of `input` when given |
| `{ "type": "length_at_most", "path", "value" }` | the text or the list at the path is at most that long |

A check on a path that holds nothing fails, `not_contains` included. A pattern is at most
200 characters, is not run over a text of more than 20,000 characters, and may not repeat a
group that itself repeats (such as `(a+)+`), which is the shape that can take forever.

Loading refuses anything else: an unknown field, a misspelt one, an empty `expect`, an id
used twice. The message names the file, the case and the field, and never repeats a
value.

There is no check that asks a model to judge an answer. See "What is not here".

### Scoring

```
score    = cases that passed / all cases
complete = no case ended in an error (a failed call, the budget, a deadline, a broken suite)
pass     = complete and score >= threshold
```

An incomplete run never passes, whatever its score. A refusal by the model is an answer,
not an error: the case is scored, and normally fails its checks.

## Evaluating a model (the run that costs money)

This is the only command that can spend anything. Run it yourself, with your own key.

```bash
pnpm turbo run build --filter=@repo/module-ai

# The key goes in the environment and nowhere else. Typed this way it stays out of the
# shell's history.
read -rs EVAL_API_KEY && export EVAL_API_KEY

pnpm --filter @repo/module-ai evals -- run \
  --job replies --provider anthropic --model claude-sonnet-5-5 --budget-usd 2.00
```

It prints where the report is, the score, what was spent and whether the suite passed, and
exits non-zero when it did not pass or was incomplete. Unless `--out` says otherwise the
report goes to `.data/evals/<job>/<provider>--<model>.json`, which git ignores: a run marks
nothing Tested.

**The budget.** `--budget-usd` is required. Before every call the harness adds the call's
worst case to what the run has spent, and when that would pass the budget the call is not
made: the case ends as `paused` and the run is incomplete. The worst case is the gateway's
own estimate (`worstCaseMicros` in `src/pricing.ts`): the request's bytes plus 1,024, as
input tokens at the dearer of the input and cache-write price, and every output token the
call allows. It errs high on purpose, so a budget needs room for one call's worst case
above what the run really costs. A call whose usage the provider did not report is counted
at its worst case.

**Prices.** A model with no known price cannot be held to a budget, so it does not run.
Claude's prices are built in (`BUILT_IN_PRICES`). For any other model give
`--price-input` and `--price-output` in US dollars for a million tokens, and
`--price-cache-read` and `--price-cache-write` when they differ from the input price.
Zero is allowed, for a model of your own.

**A model server of your own** (Ollama, llama.cpp, vLLM, LM Studio):

```bash
pnpm --filter @repo/module-ai evals -- run \
  --job sorting --provider openai_compatible --model qwen2.5:0.5b \
  --base-url http://127.0.0.1:11434/v1 --local-server 127.0.0.1:11434 \
  --price-input 0 --price-output 0 --budget-usd 0
```

The address rule of the AI module (`AI_LOCAL_SERVERS`) holds
here too. A server on a private address or on plain `http` is called only when you name its
host and port with `--local-server`; you are the operator of this command. Unset
`EVAL_API_KEY` first if the server asks for no key, or it is sent the key you left there.

Other flags: `--mask` masks phone numbers and email addresses before anything is sent, as
a business may in Settings; `--case-timeout-ms` is the most one case may take (ten minutes
unless said). A busy provider is asked again at most twice for a call, after the wait it
names (thirty seconds at most); nothing else is retried, and there is no backup model.

## Marking a model Tested

```bash
pnpm --filter @repo/module-ai evals -- record .data/evals/replies/anthropic--claude-sonnet-5-5.json
```

`record` is the only way a model gets into the registry
(`packages/modules/ai/src/evals/tested.gen.ts`), and it adds one only when the report

- is of a live run (not a replay), is complete, and passed;
- adds up: its counts, score and verdicts agree with its own cases and checks;
- is of the suite's current version and current dataset (by hash);
- scores at least the suite's current threshold;
- and, played back through the suite's current code and the current scorers, gives the
  same verdict for every case and still passes.

Then it copies the report to `evals/reports/<job>/<provider>--<model>.json` and rewrites
the registry, replacing an older entry for the same job, provider and model. Anything else
is refused with the reasons, and nothing is written. Commit the report and the registry
together. The product reads the registry at build time, so the badge shows after the next
build.

Do not edit `tested.gen.ts` by hand. The commands refuse a registry that is not exactly
what they wrote.

### Taking a model out again

```bash
pnpm --filter @repo/module-ai evals -- forget --job replies --provider anthropic --model claude-sonnet-5-5
```

`forget` removes the model's entry from the registry and deletes its kept report. It can
only remove. Use it when a model should no longer be called Tested: a job's prompt changed
and the model was not evaluated again, or the model was retired. Commit both changes
together.

## The first live run of the replies suite

Nothing has been run against a real model. To evaluate the default model for replies and
mark it Tested, with your own key and a budget you choose:

```bash
pnpm turbo run build --filter=@repo/module-ai
read -rs EVAL_API_KEY && export EVAL_API_KEY

pnpm --filter @repo/module-ai evals -- run --job replies --provider anthropic --model claude-sonnet-5-5 --budget-usd 2.00

# Only if it printed "Result: passed.":
pnpm --filter @repo/module-ai evals -- record .data/evals/replies/anthropic--claude-sonnet-5-5.json
pnpm --filter @repo/module-ai evals -- gate --release
```

Twenty cases, one call each. The budget is a cap, not an estimate: each call's worst case
(the prompt's bytes plus 1,024 as input tokens, and all 4,096 output tokens it allows) is
counted against it before the call is made. At Claude Sonnet 5.5's built-in price that is
about 5.5 cents a call, so twenty calls need a little over 1 US dollar of room though they
will cost far less; a budget below that ends the run as incomplete. Commit the report and the
registry together. The other Claude models are run the same way with `--model
claude-opus-5-5`, `claude-fable-5-1` or `claude-haiku-4-5-20251001`; a local model as under
"A model server of your own".

## The first live run of the sorting suite

The same, for the default model of the job extraction runs as:

```bash
pnpm turbo run build --filter=@repo/module-ai
read -rs EVAL_API_KEY && export EVAL_API_KEY

pnpm --filter @repo/module-ai evals -- run --job sorting --provider anthropic --model claude-haiku-4-5-20251001 --budget-usd 1.00

# Only if it printed "Result: passed.":
pnpm --filter @repo/module-ai evals -- record .data/evals/sorting/anthropic--claude-haiku-4-5-20251001.json
pnpm --filter @repo/module-ai evals -- gate --release
```

Twenty-three cases, one call each, each allowed 2,048 output tokens. At Claude Haiku 4.5's
built-in price a call's worst case is about 2 cents, so the run needs about half a US dollar
of room and will cost far less.

What a case is scored on is what the job would propose, and `discarded`: why the job threw
anything away. The job throws away what a model should never have written (a field that was
not offered, a fact that reads as an instruction), so a model that did what a message told
it to still proposes nothing; only `discarded` shows that it tried, and every case asks for
it to be empty. A strict model that passes here can still be refused a harmless line by the
job's word screen (`memory-rules.ts`); a case that fails for that reason says so in the
report, under `discarded`.

## The stand-in recording

`evals/stand-in/replies/` and `evals/stand-in/sorting/` each hold a run of their suite
against a **local stand-in**: a small server on this machine that answers each case with
what a person wrote (`answers.json`). No model wrote those answers and no provider was
called.

- **What it is for.** It runs the job's own code end to end through the real adapter, and
  it lets the suite be replayed with no key: the AI module's unit tests make the run again
  and compare it with the file (`reply-draft-evals.test.ts`, `extraction-evals.test.ts`), then
  play the file back.
  When the prompt or the dataset changes, that test fails until the recording is written
  again with `pnpm --filter @repo/module-ai run evals:stand-in`, which costs nothing.
- **What it is not.** It says nothing about any model. Its model is named `stand-in`, and
  the harness refuses a model of that name: `record` will not mark it Tested, and the gate
  fails on a registry entry that names one.
- Each case's `latencyMs` is written as 0, since no two runs take the same time and a
  replay never reads it. Everything else is what the run wrote.

## The gate

```bash
pnpm --filter @repo/module-ai evals -- gate
pnpm --filter @repo/module-ai evals -- gate --release
```

No key, no network, no cost. It checks that

- every dataset loads, and every dataset has a suite;
- every entry of the registry has its run report, and no report is without an entry;
- the report is of a live, complete, passing run and says what the entry says;
- the report's suite version and dataset hash are the current ones;
- the report's recording, played back through the current suite and scorers, still passes
  the current threshold, with no stale case;
- no entry is there twice.

`--release` also requires, for every job that has a suite, that the job's default model
(`DEFAULT_JOB_MODELS`) is Tested. It names the jobs that have no suite yet. That is not a
failure today: a job with no suite has nothing to be tested against.

The gate without `--release` also runs as a unit test of the AI module
(`src/evals/gate.test.ts`, "this repository"), so the ordinary CI run checks it on every
change. The same test pins what holds a release back today: the list of default models
that have a suite and no recorded run. `.github/workflows/release-evals.yml` runs
`gate --release` on `release/**` branches and `v*` tags, and fails there until that list is
empty.

### When the gate fails

| It says | What happened | What to do |
|---|---|---|
| "cases are stale" | The job's prompt or code changed since the model was evaluated: the suite no longer asks what the recording answers | Evaluate the model again (`run`), then `record`; or `forget` it |
| "The dataset has changed since the run" | A case was added, removed or edited | The same |
| "The suite is at version …" | The prompt's version moved | The same |
| "below the suite's threshold" | The threshold was raised above what the model scored | The same |
| "the report is missing" | An entry without its evidence | Restore the report, or evaluate again, or `forget` it |
| "is a report no entry of the registry names" | A report was copied into `evals/reports` by hand | Delete it, or `record` it |

A changed prompt, dataset or threshold makes every Tested model of that job fail the gate
at once, and the gate runs in the unit tests. That is intended: "Tested" is a claim about
the job as it is now. So the change that touches a suite also decides, in the same commit,
for each Tested model of that job: evaluate it again and `record` it, or `forget` it.

## What a report holds

The job, the suite's version, the dataset's hash, the provider and model, when it ran, the
threshold, the counts and the score, the budget and the spend, whether masking was on, and
for each case: its verdict, each check's result with a short reason, the output, the calls
made (a SHA-256 of each request, and the answer: text, tool calls, the model's own
thinking blocks, why it stopped, usage and cost), the time it took, and the kind of error
if it ended in one.

It never holds the key or an address. It does hold the model's answers to the dataset's
inputs, which is one more reason to keep real people out of a dataset.

## What is not here

- **No Tested model yet, and two suites.** The other jobs' suites come with the jobs.
- **No live run has been made.** The harness and both suites are proven against the
  module's local stand-ins only.
- **No model-judged scoring.** Every check is deterministic. A judge model would make
  "Tested" depend on a second model and on its price; if a job needs one, that is a new
  decision.
