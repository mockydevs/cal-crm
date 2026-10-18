# packages/kernel

The shared building blocks every other package may use. It has no runtime dependencies.

| Module | What it gives |
|---|---|
| `ids.ts` | UUIDv7 checks, and public ids such as `con_01h455vb4pex5vsknk084sn02q` |
| `typeid.ts` | The TypeID encoding behind public ids, tested against the spec's own examples |
| `errors.ts` | The errors reported to callers, each with one HTTP status, and JSON Pointers for field paths |
| `money.ts` | Money as a decimal string plus an ISO 4217 currency code, never a float |
| `time-zones.ts` | IANA time zone names, refusing fixed UTC offsets |
| `tenancy.ts` | The tenant context every transaction sets first, and the actor kinds |

## Errors and their HTTP status

| Error | Status | When |
|---|---|---|
| `ValidationError` | 422 | The input breaks a rule. Each issue has a `path` (a JSON Pointer), a `code`, a `message` and, when known, a `suggestion` |
| `NotFoundError` | 404 | The record doesn't exist, or the caller can't see it, which looks the same from outside |
| `ConflictError` | 409 | The request clashes with the current state, such as an edit to a stale draft |
| `ForbiddenError` | 403 | The caller isn't allowed to do this |

Any other error is a fault in the server: a 500 whose details stay in the logs.

## Adding a kind of public id

Add its prefix to `publicIdPrefixes` in `ids.ts`: at least three lowercase letters that
read as the kind (`con` for contact). A prefix is part of the public API: once released,
it never changes and is never reused.
