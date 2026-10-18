# packages/commands

The command layer: every change to the data goes through `runCommand`, whether it comes
from the API, the worker, an automation or the AI. It doesn't depend on the server
framework.

## What running a command does

1. **Validates** the input with the command's Zod schema (`parseInput`). Input that doesn't
   fit is a `ValidationError` (422) that names each field.
2. **Checks the actor's permission**.
   - Each command names one, such as `tags.manage`, from `@repo/contracts`' catalog.
   - The invocation carries what the actor's role allows where they work, or `'all'` for
     the system.
   - A role without it gets a `ForbiddenError` (403) that names the permission.
   - `requirePermission` makes the same check, for work that comes before a command, such
     as receiving an upload.
   - Then `services.authorize` may add rules about records; the server passes
     `allowEveryone` for now.
3. **Runs the handler in one tenant transaction** (`withTenant`), together with:
   - an `events.events` row for each event the handler reports with `emit`, carrying the
     actor, the causation and the correlation. `emit` writes it at once and gives its id;
   - a `crm.timeline_entries` row for each record an event concerns;
   - a job for each `enqueue`, stamped with the transaction's tenant context and the event
     behind it;
   - the `audit.commands` row, with the outcome `ok` and the event ids.
4. **When anything fails, nothing changes** except an audit row of its own, written in a
   separate transaction:

   | Error | Outcome | `error_code` |
   |---|---|---|
   | `ValidationError` | `invalid` | `validation` |
   | `ForbiddenError` | `denied` | `forbidden` |
   | `NotFoundError` | `failed` | `not_found` |
   | `ConflictError` | `failed` | `conflict` |
   | anything else | `failed` | `internal` |

The audit log keeps the validated input, or what the command's `audit` function keeps of
it, so secrets can be left out. Input that didn't validate isn't kept at all.

Successful business commands also enqueue a PostgreSQL notification inside this same
transaction. PostgreSQL delivers it only after commit. Each app process turns it into
an authenticated business refresh hint, containing no record data. A rolled
back command and its separate failure-audit transaction produce no hint.

## Assistants: autonomy and proposals

An assistant is an actor like any other (`actorKind: 'ai_agent'`, with `agent` saying
which one), with one more check:

- **Before the handler, in the command's transaction, `requireAutonomy` reads the rule**
  for that assistant and the command's kind of action (`ai.autonomy_rules`): the contact's
  own rule first, then the business's, then "ask first". Unless the rule says `act` the
  command is refused with an `ApprovalRequiredError` (403), audited as `denied` with
  `approval_required`. People, automations and the system are not assistants and pass.
- **A command an assistant may run names its `delegation`**: the kind of action
  (`send_message`, `update_conversation`) and the contact it concerns. A command without
  one is refused to every assistant (`not_delegable`).

  ```ts
  delegation: {
    action: 'send_message',
    contact: async (trx, { id }) => (await requireConversation(trx, id)).contact_id,
  },
  ```

- **A command with a finer rule of its own for assistants says so** with
  `ownAssistantRule`, a sentence naming the rule its handler keeps (a field's AI sources
  and overwrite setting; applying only tags that exist). An assistant is let through to
  such a handler without an autonomy rule. Use it only where the handler really refuses
  what the sentence says it does, and test that. A command that names neither this nor a
  delegation is refused to every assistant.
- **A proposal is a stored command a person decides on.** `defineProposable` says how one
  of a module's commands can be proposed: what it is about, a fingerprint of what it is made
  on, what a person may change first, how a card shows it, and how to reverse it. The AI
  module keeps the rows and runs them through `runProposedCommand`, which is `runCommand`
  with nothing left out, plus the proposal's bookkeeping in the same transaction and the
  proposal's id on the audit row and the events.
- **What may happen to a proposal** is decided by `decideApply`, `decideDismiss` and
  `decideUndo` (`proposal-rules.ts`): applied once, never when stale or past its time,
  undone only when something can reverse it.

`pnpm --filter @repo/commands test:mutation` mutates the permission guard, the autonomy
guard, and the rules in `autonomy-rules.ts` and `proposal-rules.ts`; every mutant must be
killed.

## Write a command

```ts
export const createTagCommand = defineCommand({
  name: 'tag.create',            // dotted, as the audit log names it
  permission: 'tags.manage',     // what the actor's role must allow
  input: createTagInput,         // a Zod schema from @repo/contracts
  async handle(trx, input, command) {
    const row = await trx.insertInto('crm.tags').values({
      business_id: requireBusiness(command.context),
      // …
    }).returning(['id', 'name']).executeTakeFirstOrThrow();
    await command.emit({ type: 'tag.created', subject: { kind: 'tag', id: row.id } });
    return row;
  },
});
```

## Add a job

Work that follows a change, such as reacting to an event, is a task. A handler adds a
job for it with `enqueue`, and the job is written with the change, or not at all:

```ts
export const tagCreated = defineTask({
  name: 'tag.created',                       // dotted, as the queue names it
  data: z.strictObject({ tagId: z.uuid() }), // plain JSON, checked when added and when run
  async run(data, job) {
    // job.invocation: the job's business, acting as the system, under the correlation
    // id of the request that added it, caused by the event behind the job.
    // job.services: to run commands with it.
  },
});

// In a command's handler:
command.enqueue(tagCreated, { tagId: row.id });
```

A job carries its cause, so the events of the commands it runs point back at it and
"Why?" can follow the chain. The cause is the event the handler emitted last, else the
event that caused the command. To name another event the handler emitted, pass
`{ causedBy: eventId }`.

The worker runs each job in the business that added it. **A job can run more than
once**: it's retried after a failure, and run again if the worker crashes after the work
but before the queue records it as done. So a task must be safe to repeat. Data that
doesn't fit the task's schema is a bug in the command, which then fails as an internal
error.

## Answer an endpoint

A module lists its routes, and the server registers them:

```ts
export const createTagRoute = {
  endpoint: createTag,
  run: ({ invocation, body }, services) => runCommand(services, createTagCommand, body, invocation),
} satisfies Route<typeof createTag>;
```

The server passes the parameters, query and body unparsed: each route validates what it
needs, since the same commands run outside HTTP too.
