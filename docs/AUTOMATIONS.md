# Automations: Format and API

The automation format, the API and the MCP tools that people, the built-in assistant and any outside AI model use to build, test and debug workflows.

## The idea

Every automation is **one JSON document**. All of these read and write that same document, through the same API:
- the drag-and-drop canvas;
- the steps view;
- the built-in assistant;
- any outside AI model or script.

So a person can build on the canvas and an AI can build through the API, and both always see the same automation. Because the format is published (a JSON Schema plus a catalog of everything available), any AI model can build automations that actually work, not just look right.

## Contents

1. [What we take from n8n, and what we change](#1-what-we-take-from-n8n-and-what-we-change)
2. [The automation document](#2-the-automation-document)
3. [Steps, triggers and conditions](#3-steps-triggers-and-conditions)
4. [What the validator checks](#4-what-the-validator-checks)
5. [The API](#5-the-api)
6. [MCP server](#6-mcp-server)
7. [How an AI builds an automation correctly](#7-how-an-ai-builds-an-automation-correctly)
8. [Safety](#8-safety)
9. [The three views in the app](#9-the-three-views-in-the-app)

---

## 1. What we take from n8n, and what we change

These facts were checked against n8n's own API definition (`packages/cli/src/public-api/v1` in the n8n-io/n8n repository):
- **The workflow format:** a workflow is JSON with `nodes` and `connections`.
  - Each node has a `type` (e.g. `n8n-nodes-base.jira`), a `typeVersion`, a canvas `position` `[x, y]` and `parameters`.
  - `connections` are keyed by node **name**.
- **The REST API:**
  - It authenticates with an `X-N8N-API-KEY` header, and each operation needs a scope such as `workflow:create`, `workflow:read` or `workflow:activate`.
  - It can create, update, publish (`POST /workflows/{id}/publish`), list version history and run tests.
- **Discovery:** `GET /discover` returns the operations the caller's key may use, and can include the input schemas, so an agent knows what it can do before it tries.
- **License:** n8n uses the Sustainable Use License, which isn't an open-source license. We copy ideas, never code.

What we keep:
- workflows as JSON documents;
- an API with scoped keys;
- step types that carry a version;
- versions and publishing;
- a discovery endpoint.

What we change, and why:

| n8n | Ours | Why |
|---|---|---|
| Connections keyed by node names | Steps keyed by stable ids, each naming its `next` step | Renaming a step can't break the flow, and ids are easier for an AI to get right |
| Canvas position stored inside each node | Layout stored separately, and optional | Logic changes stay clean in diffs, and an AI never has to place boxes; the canvas lays out what it isn't told |
| General-purpose integration nodes | Customer-journey steps (send text, move deal, wait for a reply) plus webhook and AI steps | Consent, quiet hours and sending limits can be enforced per step type |
| `GET /discover` lists operations | A catalog that also lists this business's forms, templates, fields and pipelines | An AI needs to know which "Request a quote" form exists, not just that forms exist |

---

## 2. The automation document

The automation from the design canvas, in full:

```json
{
  "$schema": "https://crm.example.com/api/v1/automations/schema",
  "name": "New lead follow-up",
  "description": "Pricing guide, then up to two texts until they reply or book.",
  "triggers": [
    { "id": "quote_form", "type": "form.submitted", "config": { "form": "Request a quote" } }
  ],
  "stopWhen": [
    { "event": "message.received", "from": "contact" },
    { "event": "appointment.booked" },
    { "event": "deal.closed" }
  ],
  "start": "send_guide",
  "steps": {
    "send_guide": {
      "type": "email.send",
      "config": { "template": "Pricing guide" },
      "next": "wait_2_days"
    },
    "wait_2_days": {
      "type": "wait",
      "config": { "duration": "P2D" },
      "next": "asked_about_video"
    },
    "asked_about_video": {
      "type": "condition",
      "config": {
        "if": { "field": "contact.services", "operator": "includes", "value": "Video" }
      },
      "next": { "yes": "send_reel", "no": "check_in" }
    },
    "send_reel": {
      "type": "sms.send",
      "config": { "message": "Here’s our video sample reel: {{values.sample_reel_url}}" }
    },
    "check_in": {
      "type": "sms.send",
      "config": { "message": "Hi {{contact.firstName}}, did the pricing guide come through? Happy to answer any questions." },
      "next": "wait_3_days"
    },
    "wait_3_days": {
      "type": "wait",
      "config": { "duration": "P3D" },
      "next": "last_check_in"
    },
    "last_check_in": {
      "type": "sms.send",
      "config": { "message": "Last check-in from Harbor Lights. If now isn’t the right time, just let us know." }
    }
  },
  "settings": { "reEnrollment": "after_finished", "timezone": "contact" },
  "layout": { "send_guide": { "x": 0, "y": 160 } }
}
```

| Field | Meaning |
|---|---|
| `$schema` | The JSON Schema this document follows. Each install serves it, so editors and AI tools can check documents as they write them |
| `name`, `description` | What people see in lists |
| `triggers` | One or more ways to start. Each has an `id`, a `type` from the catalog, and `config` |
| `stopWhen` | Events that end the automation for that contact at any point (GHL calls these goals). Checked continuously, not only between steps |
| `start` | The id of the first step |
| `steps` | Every step, keyed by a stable id that you or the AI choose (`send_guide`, not `node_17`) |
| `settings` | Re-enrollment rule, time zone (contact's or business's), sending window |
| `layout` | Optional canvas positions. Missing positions are laid out automatically. Layout never changes behavior |

**Settings:**
- `reEnrollment`: `never` (a record goes through once) or `after_finished` (again once its
  last run has ended). A record is never in the same automation twice at once.
- **A change while a run is going**.
  With `after_finished`, an event that matches a trigger for a record whose run of the
  automation is still going is not lost: the run is marked, and when it ends by completing
  or failing the record goes through once more, on the version published then. However many
  such events came, one run follows, and it reads the record as it is when it runs, so the
  newest value is what it acts on (two or three quick changes of a field end with the
  helper text matching the last one, with no goal step). What does not mark the run:
  - an event of the same request as the one that started it (one correlation), such as a
    contact created with its fields or a form that creates a contact and fills one: the
    run already reads it;
  - the event that started the run, matched again by a job that ran twice;
  - any event at all with `never`, which keeps today's behaviour.
  A run that a stop condition, a removal or a deletion ended starts nothing after it.
  **A run's own change starts nothing.** Every step of a run runs under the
  correlation of the change that started it, so every event the run writes, and every run
  that change leads to in any workflow, carries that correlation. An event whose
  correlation is that of an ended run of the same workflow for the same record is refused
  (`refused_loop`, `cause: own_change`): a workflow that writes the field its trigger
  listens for runs once per outside change, and two workflows that write each other's
  fields go round once. A person's change during a run has its own correlation and still
  starts one more run, as above. **A circuit breaker** refuses a workflow's start for a
  record that it has already started 20 times in the last 60 minutes (`refused_loop`,
  `cause: run_limit`), whatever the correlation, such as a loop through an outside app; the
  first refusal in a window writes `automation.loop_stopped` on the record's timeline. The
  next run carries the newest marking event as its trigger event and its correlation, and
  `state.reentered` says which run it follows and how many events it stands for. It starts
  by the rules every enrolment keeps; when it cannot (the automation was paused, published
  again without that trigger, deleted, or re-entry was turned off), the marking event's
  trigger evaluation says why. The match's own evaluation of a marking event is
  `already_enrolled` with `detail.queued: true` ("…so it goes through again once that run
  ends").
- `timezone`: `business`, or `contact` for the contact's own zone where they have one and
  the business's where they don't. Waits until a date, and the sending window, use it.
- `sendingWindow`: the days and the hours messages may go out, such as Monday to Friday,
  09:00 to 17:00. A message step (`email.send`, `sms.send`) reached outside it waits at
  that step until the window next opens, and the run's history says so; steps that are not
  messages are never held. An end before the start is a window that runs past midnight; a
  window whose start and end are the same is refused (`empty_sending_window`). Where the
  clocks change, a start they skip opens when they land, and a start that comes twice
  opens at the first. The window decides when the step hands the message over, not that
  it is sent: quiet hours in the contact's own zone, consent and the daily limit still
  apply to the message afterwards.

**Each step has:**
- `type`;
- `config`;
- `next`, which is one of:
  - a step id;
  - for a branch, an object of branch name → step id;
  - left out, which ends that path;
- optionally a display `label` and `notes`.

When a document is saved, the server adds the step type's version (`typeVersion`), so old automations keep working after a step type changes.

**Values:**
- **Durations and dates** are ISO 8601 (`P2D` is 2 days, `PT4H` is 4 hours).
- **Merge fields** look like `{{contact.firstName}}`. A contact's custom field is `{{contact.custom.<key>}}`, or its merge key `{{contact.<key>}}` as Settings → Custom Fields shows it; the validator stores the first form. A business's custom values (Settings → Custom Values) look like `{{custom_values.sample_reel_url}}`, the key that page shows, or `{{values.sample_reel_url}}`; both are kept as written. A step's text is filled in from the contact and the custom values. The merge keys of a deal's and a company's fields (`{{opportunity.<key>}}`, `{{business.<key>}}`) are refused in a step's text, because nothing fills them in yet.
- **References:** a form, template or pipeline can be given by id or by name. The server resolves names to ids and returns the normalized document.
- **Email templates** are plain text, written in Settings > Message templates or through `/message-templates`. A published automation holds the template's id, so a rename is safe, an edit changes what the automation sends from the next send, and archiving the template makes the step fail as `template_unavailable`; the archive answer lists the automations affected. A template can use contact fields (`{{contact.firstName}}`, `{{contact.custom.<key>}}`, `{{contact.<key>}}`) and the business's custom values (`{{custom_values.<key>}}`, `{{values.<key>}}`): a send that can't fill in a field stops as `missing_values`, and each template answer names such fields in `unfillableFields`. A custom value with no text is one of them.

---

## 3. Steps, triggers and conditions

**Step types (first catalog):**

| Group | Types |
|---|---|
| Messages | `email.send`, `sms.send`, `whatsapp.send`, `team.notify`, `manual.call`, `manual.sms` (a call or a text a person does by hand; the run waits in the Manual Actions queue until it is completed or skipped) |
| Timing | `wait` (a duration), `wait.until` (a date or time, such as "2 days before the event"), `wait.event` (wait for something to happen, such as a reply, with a timeout; its branches are `received` and `timed_out`), `wait.condition` (wait until a condition on the contact holds; `met` and `timed_out`), `wait.appointment` (wait until an appointment's start, or a time before or after it; `reached`, `passed` and `no_appointment`). Each takes an optional `resumeWindow` |
| Logic | `condition` (if / else, with two branches or with several named ones), `split` (A/B test by percentage), `goto` (jump to another step), `goal` (an event that brings the run straight to this step) |
| Records | `contact.update`, `deal.create`, `deal.find` (branches `found` and `not_found`), `deal.move`, `deal.close` (requires a lost reason when the deal is lost), `deal.update`, `task.create`, `note.create`, `owner.assign`, `owner.remove`, `dnd.set`, `tag.add`, `tag.remove` |
| AI | `ai.ask` (a prompt whose answer feeds later steps), `ai.classify` (sort a reply into categories you name), `ai.draft_reply` (follows the contact's autonomy setting) |
| Connect | `webhook.call`, `automation.run` (start another automation), `automation.remove` (remove the contact from automations) |

**What runs in phase 1.** The catalog lists every type above, and each install says which
of them it can't run yet (`setup.unavailableSteps` and `setup.unavailableTriggers` in the
catalog's answer). The validator refuses a document that uses one (`step_unavailable`,
`trigger_unavailable`), so nothing is published that could only fail or never start:
- **Steps that run:** `email.send`, `sms.send`, `wait`, `wait.until`, `wait.event`,
  `wait.condition`, `wait.appointment`, `condition`,
  `split`, `contact.update`, `deal.create`, `deal.find`, `deal.move`, `deal.close`,
  `deal.update`, `task.create`, `note.create`, `owner.assign`, `owner.remove`, `dnd.set`,
  `tag.add`, `tag.remove`, `webhook.call`, `manual.call`, `manual.sms`, `automation.run`,
  `automation.remove`, `goto` and `goal`.
- **Steps not available yet:** `whatsapp.send` (no WhatsApp channel), `team.notify` (on an
  install with no notification service) and the three `ai.*` steps.
- **Triggers not available yet:** `webhook.received` and `schedule`: nothing fires them.

**Waits.**
- **Resume window.** Any wait step may carry `resumeWindow: { days, start, end }`: the
  weekdays and hours, in the automation's time zone (`settings.timezone`), in which a run
  may go on from the wait. A run that would go on while the window is closed goes on when
  it next opens. An end before the start runs past midnight; a start equal to the end is
  refused (`empty_resume_window`). Clock changes follow the sending window's rule. `wait`
  and `wait.until` work the opening out when the wait begins; the waits that stay at their
  step keep what they decided and are judged against the window again on waking.
- **`wait.until`** takes `ifPassed`: `continue` (the default: a time already passed goes on
  at once) or `end` (the run ends there as completed). On a date field it waits at its
  step and follows the field: a change to the field wakes it and it reads the
  field again, so a date moved later moves the wait and one moved into the past follows
  `ifPassed`. `ifEmpty` says what an empty field does: `wait` (the default from step
  version 2: it waits up to 365 days for a value, then ends the run), `continue` or `end`.
  A step stored at version 1 goes on at once, as it always did. An offset moves the date on
  the run zone's calendar and the hours on its clock, so "1 day before at 09:00" is 09:00
  local across a clock change.
- **Dates in conditions.** A condition reads a date with no time of day (`2026-11-01`) as
  that whole day in the run's zone (`settings.timezone`): `within_next P1D` at 23:00 on the
  31st holds for the 1st, and a day is neither before nor after a time inside it. Trigger
  conditions and condition and wait steps do so; stop conditions still read UTC days.
- **`webhook.call`** takes `headers` (up to 10): `{ "name", "value" }` with merge text, or
  `{ "name", "secret" }` naming one of the business's webhook secrets, so a key need not go
  in the address. A secret's value is sealed in the vault (`automation.webhook_secrets`
  holds its name and vault id only), set through `PUT /automations/webhook-secrets/{name}`
  and never shown again; only the worker opens it, as the request leaves. No document,
  version, run history, event or log holds it, and the run history shows the address with
  its query values hidden. Headers the engine sets itself (`Content-Type`, `User-Agent`,
  every `X-CRM-` header) and connection headers are refused (`reserved_header`). A header naming a secret that
  was deleted fails the step, unsent, with `secret_missing`.
- **A contact moved to the trash** leaves its workflows: each live run ends as `exited` with
  `contact_trashed`, told as `automation.run.stopped`, whether the trash's event or the
  run's next step comes first, and a contact in the trash starts none.
- **Fairness between businesses.** The engine's jobs are ordered by a priority made from
  their business's events in the last minute (0 for a quiet business, up to 8 for a
  burst), then by time, so one business's import does not hold another's new lead behind
  it. Measured: after 1,000 new contacts in one business, another's new lead was taken
  second rather than 1,001st.
- **`wait.event`** waits for any stop event or for `trigger_link.clicked`. With
  `message.received` it may name a `channel`; with `trigger_link.clicked` it may name a
  `link` (left out, any trigger link). A filter on another event is refused
  (`filter_not_for_event`). A reply with a timeout branch is this step.
- **`wait.condition`** takes `if` and a `timeout`. Reached with the condition true it takes
  `met` at once. Otherwise it is judged again each time the contact's fields or tags change
  and once more at the deadline; `timed_out` when it never held. One row in the run's
  history covers the whole wait, and its words say the latest ("The record changed, but
  the condition does not hold yet; still waiting until ...").
- **`wait.appointment`** takes an optional `offset` and `direction` (`before`, the default,
  or `after`). It waits for the appointment that started the run when an appointment
  trigger did, otherwise for the contact's next booked or confirmed one. Its time already
  passed when the step is reached: `passed`. None, or cancelled (then or during the wait):
  `no_appointment`; at version 2 (2026-10-15) also an appointment marked no-show or
  invalid, while a step stored at version 1 goes on waiting for one, as it always did.
  Rescheduled: the wait moves to the new time, and a move to a time whose moment has passed
  takes `reached` at once. Outputs: `appointmentId`, `startsAt`. The wait hears
  `appointment.rescheduled`, `appointment.cancelled` and `appointment.status_changed` for
  the contact and reads the appointment again on each (`waits.ts` APPOINTMENT_CHANGE_EVENTS,
  `steps.ts` planAppointmentWait); a move whose event never came is read at the old wake-up.
- **The appointment's merge fields** (`appointment.title`, `startTime`, `startsAt`,
  `calendar`, `location`, `status`; `automationAppointmentFields` in the validator): the
  appointment whose event started the run, otherwise the one the run's latest wait for an
  appointment waited for, read as it is now and only if it is still the run's own
  contact's. `startTime` is the start in words in the zone the contact booked in, else the
  contact's own region zone, else the calendar's ("Thursday, October 15, 2026, 3:00 PM
  Eastern Daylight Time"). All are null in a run about no appointment, so a message that
  uses one stops as for any empty field unless it names a fallback
  (`{{appointment.location | default: "..."}}`). Conditions can read them too.
  `appointment.manageUrl` ("Reschedule or cancel link", 2026-10-15) is the appointment's own
  keyed link to its manage page (migration 0107), made when a message is
  sent; it is empty in conditions, where the install serves no public pages, and once the
  appointment is cancelled or over, so write it with a fallback.
- **Transactional messages** (`purpose: 'transactional'` on `email.send` and `sms.send`,
  2026-10-15; left out means marketing, as every workflow message was). For a message about
  the appointment the contact booked, such as a reminder: it is queued with purpose
  `transactional` (lane `automation`), so it needs the transactional consent the booking
  page records when the visitor ticks its notifications box, not marketing consent; a
  marketing unsubscribe does not stop it, a transactional withdrawal does; an email gets no
  unsubscribe footer or postal address line and no `no_postal_address` warning. Only a
  workflow whose triggers are all appointment triggers (`appointment.booked`,
  `appointment.status_changed`) may send one (`transactional_needs_appointment`), and a
  transactional message gets no `no_follow_up` warning. It names the run's own appointment,
  so quiet hours do not hold it while that appointment is booked or confirmed and ahead; the daily cap counts it, as for every workflow message. A
  text needs the transactional SMS consent the booking page's "Text me reminders" box
  records.
- **Not built, with why:** waits for an email being opened, clicked or bounced (messaging
  records no opens or clicks: that tracking is the dependency), a wait for a team member's
  reply, and the recurring-schedule wait.
- A test run plans these waits with the same code. It judges a condition on arrival and at
  the deadline only, since a test run changes no record during a wait, and waits for the
  real contact's next appointment when the test names a contact.

**When a step fails.**
- Every step may carry `onFailure`: `"stop"` (the default: the run ends as failed, with the
  failure's code as its reason), `"continue"` (the run goes on to the step's `next`; only
  for a step with one next) or `{ "goTo": "<step>" }` (the run goes on at the step named,
  and the step's row has the branch `failed`). A run that went on has not failed: its
  history shows the failed step and where the run went, in words.
- The steps that change a record or queue a message may carry
  `retry: { "times": 1 to 5, "wait": "PT1M", "backoff": "double" | "fixed" }`. A retry
  applies only to a failure that can pass with time: `conflict`, `mailbox_unavailable`,
  `number_unavailable` (the catalog lists them under `failures`). The run waits at the
  step between tries; every try of a visit uses one idempotency key, and a failure that
  leaves a refused message behind is never retried, so nothing is sent twice. When the
  tries are used up, `onFailure` decides. `webhook.call` keeps its own six attempts.
- **Telling the team.** There is one mechanism: an automation with the trigger
  `automation.run_ended` (`how: ["failed"]`) and a `team.notify` step. The trigger gives
  `{{trigger.reason}}` (the failure's code), `{{trigger.step}}` and `{{trigger.runId}}`.
- **Running a failed run again.** `POST /automation-runs/{runId}/retry`
  (`automations.manage`, audited) puts a failed run back at the step it failed at, on its
  own version, as a new visit. It answers 409, saying why, when the run did not fail, the
  automation was deleted or published again since the run began, the contact is in the
  trash or already back in the automation, the run ended on its loop bound, or it has been
  run again five times. It is not an MCP tool: it can send, and sends stay a person's.
- A test run follows `onFailure` and retries nothing.

**Continuing a waiting run now.** `POST /automation-runs/{runId}/continue`
(`automations.manage`, audited as `automation.continue_run`, and told of as
`automation.run.continued`) ends a run's wait early, which is also how a three-day sequence
is tried in three minutes:
- A run waiting in `wait` or `wait.until` wakes at once. The body names no branch.
- A run waiting in `wait.event`, `wait.condition` or `wait.appointment` takes the branch
  the body names (`branch`, one of the step's own: `received` or `timed_out`, `met` or
  `timed_out`, `reached`, `passed` or `no_appointment`), since nothing happened to choose
  one. The wait's own resume window does not hold it back: a person who continues a run
  means now.
- The step's row in the run's history says who did it ("Continued by Jane Doe ..."), and
  its output has `continuedBy` and `continuedAt`.
- It answers 409 when the run is not waiting in such a step: it ended, it is running, or it
  waits for something else (a manual action, a webhook out for delivery, a message held for
  the sending window, a retry, its goal). With `revision` (the run's own, as it was read) it
  answers 409 when the run has moved since. It answers 422 when a branch is missing, is not
  one of the step's, or is given for a wait that has none.
- It takes the locks the scheduler's wake takes, in the same order, so the timer firing at
  the same moment moves the run on once.
- A run says whether it can be continued: `continuable` is `{ "branches": [...] }` (empty for
  a wait for a time), or null.
- It is not an MCP tool, for the reason a retry is not: what comes next can send.

**Text messages.** `sms.send` takes its `message` and, optionally, the `number` to send from,
by id or by name. Left out, the business's only number that can send is used; with more
than one, the step must say which. A text goes through the same pipeline as an email:
marketing consent for the channel, do not contact, suppressions, quiet hours and the daily
limit all apply, and the message is filled in for the contact before it is queued.

**Manual actions.** `manual.call` (optional `notes`) and `manual.sms` (`message`) each take an
optional `user`, by id or by name. The step fills its text in for the contact, puts an
action in the Manual Actions queue and waits there with no timeout. It is for whoever the
step names; else the contact's owner; else anyone. Completing or skipping the action lets
the run go on, with `outcome` (`completed` or `skipped`) as the step's output. The step
never dials or sends: a person does, and says so. A run that ends another way takes its
action off the queue.

**Starting another automation.** `automation.run` takes the `automation`, by id or by name,
and enrols the step's record in it by the rules every enrolment keeps: never again where
that automation enrols a record once, never twice at the same time, on the version
published at that moment. The run it starts carries the event that began the parent, and
its history says which run and step started it (`startedBy`). The parent goes on at once
and never waits for it. The step's outputs are `outcome` and, when a run was started,
`enrolmentId`:

| `outcome` | What happened |
|---|---|
| `started` | A run was started. |
| `already_running` | The record is in that automation now; nothing was started. |
| `already_went_through` | That automation enrols a record once, and this one has been through it. |
| `not_active` | That automation is a draft, paused or deleted; nothing was started, and the step's explanation says which. |
| `refused_loop` | Starting it would lead back to an automation that led here, or ten automations in a row have started one another. |

An automation that cannot be found at all (purged, or not this business's) fails the step
as `unknown_reference`. The validator refuses, as `automation_loop`, a step that would
start the automation itself or close a loop through what the others have published, and
names the loop; the check at run time is behind it, because documents change after they
are published. A test run says what it would start and starts nothing.

**Removing from automations.** `automation.remove` ends the runs the step's record is in,
and no other record's:

| `config` | Which runs end |
|---|---|
| `{ "from": "current" }` | This run. |
| `{ "from": "automations", "automations": [...] }` | The record's runs in the automations listed (1 to 20, by id or name). |
| `{ "from": "all_others", "except": [...] }` | Every other run of the record, but not those in the automations under `except` (optional, up to 20). |
| `{ "from": "all", "except": [...] }` | The same, and this run too unless its own automation is under `except`. |

Each run ends as `exited` with the reason `removed:<id of the automation that removed it>`,
listens for nothing more, has its wait closed as skipped and its manual action taken off
the queue, and is told of as `automation.run.stopped`. A job already queued for it does
nothing. The step's output is `removed`, how many runs it ended. When the step ends its own
run, the step is recorded as done and no later step runs. Runs of a paused automation are
removed like any other. `except` is ours: it lets "all sales sequences but never
education" stay true when a fourth sales sequence is added.

**Two ways a run is ended early, and which comes first.** An automation can end its own
runs with stop conditions (`stopWhen`), and another automation can end them with an
`automation.remove` step, such as a master rule that takes a lead out of every sales
sequence when a consultation is booked. When one event does both, the stop condition
fires first: stop conditions are applied when the event is matched, before anything the
event starts has run a step. The removal then finds that run already over. `removed`
counts only the runs that were still going when the step ran, so it can be 0 although the
lead is, rightly, in none of the sequences any more; the step's explanation then says
"Removed nothing: no run of the chosen automations was still going for this record." Keep
both if you want the removal to be the safety net for sequences that have no such stop
condition; neither is wrong.

**A condition with several branches.** `condition` takes one of two shapes. With a single
`if`, its branches are `yes` and `no`, as they always were. With `branches`, a list of 1 to
10 `{ "name", "label", "if" }` (`label` is optional, what the branch is called on screen),
the branches are tried in the order written and the first whose condition holds is taken;
when none holds the run takes the branch `none`, which every such step has and no branch
may be named. `next` names a step for each branch name and for `none`; a branch with no
step ends that path. AND and OR inside a branch are the condition's own `all` and `any`.
The run's history keeps the values every branch compared and says which branch held, such
as `Branch "hot_lead" held (number 2 of 3, tried in order), so it was taken.` A document
written with the first shape is never rewritten into the second: a version published
before named branches existed runs as it did. GoHighLevel's If/Else has several branches
and a "None" branch that cannot be removed; its article does not say how many branches
there may be or which wins when two hold, so the limit of ten and "the first in order" are
ours.

**Go To, and what bounds a loop.** `goto` takes `target`, another step of the same
automation, and leads there and nowhere else: a `goto` with a `next` is refused
(`goto_has_next`), as GoHighLevel's Go To can only be the last step of a path. A path that
leads back, through a `goto` or a `next`, must hold a wait (`loop_without_wait`), and one
that lasts an hour each time round (`loop_wait_too_short`, `LOOP_MIN_WAIT` PT1H): a `wait`
of an hour or more, a `wait.event` or `wait.condition` with a timeout of an hour or more, a
`wait.appointment`, or a `wait.until` on a date field. A `wait.until` a fixed moment passes
once and does not count. The engine holds the rest: a step visited again within an hour of
its last visit in the run waits at the step until the hour is up (its row says `held:
loop_interval`), so a wait that ended at once, such as a condition already true, still
goes round once an hour at most. A person's "run again" from a failed step is not held. A run
then keeps two bounds of its own: it visits one step at most 100 times, and takes at most
5,000 steps in all. A run that would pass either fails at that step with the code
`step_visit_limit` or `run_step_limit`, which is also its `exitReason`; the step's
explanation says which step had run 100 times and that a path leads back to it. A hundred
turns is a daily nudge for over three months; what needs more is a trigger on a schedule,
not a loop. GoHighLevel's article gives no loop limit, so these numbers are ours. A test
run ends a loop at its own bound of 200 steps.

**Goals.** `goal` is a step a run comes straight to, from wherever it is, when one of its
`events` happens for the contact. Each event is `{ "type", "config" }` with the type and
the filters of the trigger of that name: `form.submitted`, `trigger_link.clicked`,
`tag.added`, `tag.removed`, `appointment.booked`, `appointment.status_changed`,
`message.received` (its `channel` only), `deal.stage_changed`, `deal.closed` and
`field.changed`; any one of up to ten meets the goal. An automation has one goal step
(`more_than_one_goal`), as GoHighLevel documents one Goal Event per workflow.
- A run listens from its start until it has been through the goal step. When the goal is
  met, the run leaves what it was waiting in (the wait is recorded as skipped, an open
  manual action is cancelled, a message held for the sending window is not sent), moves to
  the goal step and goes on from its `next`. The step's output is `eventId`, and its
  explanation says which event met the goal and which step the run came from.
- `otherwise` says what a run does that reaches the step before the goal is met:
  `continue` (the default) goes on, `end` ends the run there as completed, and `wait`
  waits at the step until the goal is met, for 365 days at most, after which the run ends.
- Once a run has been through the step the goal is over for it: the event changes nothing,
  and a path that leads back to the step passes through. A new run listens afresh.
- An event that both stops a run (`stopWhen`) and meets its goal stops it.
- A goal step may be a step nothing leads to: the steps after it are then what happens
  "whenever this event comes", instead of the rest of the sequence.
- A test run moves to the goal step when a simulated event of one of the goal's types
  falls in a wait; a simulated event carries no data, so the goal's filters are not judged.
GoHighLevel's goal types that nothing here emits are not offered: payment received,
invoice paid, document status, email events, review request clicked and user replied.
What each of its three choices does in detail, and whether its wait ever ends, its article
does not say; the 365 days are ours.

**Stopping on a reply to the automation's own messages.** A stop on `message.received`
ends the run on any message from the contact. With `"repliedTo": "this_run"` it ends the
run only when this run has sent the contact a message on the channel the reply came in on,
at or before the reply; a run that has not written yet, or wrote on another channel, goes
on. Messages that failed or bounced, and messages a person sent by hand, are not the
run's. There is no time window and threads are not read: any message from the contact on
that channel after the run wrote counts. When two automations have both written, a reply
stops both. The validator warns (`stop_never_applies`) when no step of the automation
sends a message. This is GoHighLevel's "Stop on response" setting ("removes a contact from
the workflow if they respond to any communication sent from it"); how it matches a reply
to a workflow its articles do not say, so the rule is ours. In a test run a simulated
message stops such a run once a message step has been reached.

**Team notifications.** `team.notify` takes its `message` and `to`: `contact_owner` (the
default: the contact's owner, and nobody when the contact has none), `everyone`, or
`owner_or_everyone` (the owner, or everyone when the contact has none).

**Trigger links.** A step's text may write `{{trigger_link.<key>}}`. When the message is
filled in, the field becomes the contact's own address for that link; opening it records
the click and starts automations whose `trigger_link.clicked` trigger names the link. A
text that names a link the business does not have is not sent.

**Triggers** are events from the event catalog:
- `form.submitted`, `message.received`;
- `appointment.booked`, `appointment.status_changed`;
- `deal.stage_changed`, `deal.closed`;
- `contact.created`, `field.changed`, `tag.added`;
- `trigger_link.clicked` (the contact opens a trigger link from a message; the trigger names the link);
- `automation.run_ended` (a run of another automation ended for the contact; see below);
- `date.reached` (a birthday or any date field);
- `task.reminder` (a contact's task comes due, days before or after its due time);
- `webhook.received`, `schedule` (a repeating time).

**A field changes.** `field.changed` names one `field` of the contact and, optionally, the
value it changed `to`. A custom field is heard as the CRM tells of it: `field.value_set`
and `field.value_cleared`, which name the field and never its value. The contact's own
`firstName`, `lastName`, `name`, `email`, `phone`, `source` and `type` are heard through
`contact.updated`. The value is read when the event is matched: a custom field's is the one
that event wrote, and if it was replaced before then it is unknown and passes no `to`; one
of the contact's own is the one the contact has at that moment. `to` compares as a
condition's `equals` does, and empty text means "changed to nothing" (a cleared field). A
stop condition, a goal and a wait step on `field.changed` hear the same events.

**Where a contact came from.** Conditions and merge fields read `contact.source` (the
business's own words) and `contact.type` (`lead` or `customer`) beside the contact's other
fields. No step sets them yet; what a form or an ad captured into a custom field can be
copied into another with `contact.update` (see "Values a step works out").

**Attribution and lead source** (`packages/contracts/src/automations-attribution.ts`).
Everywhere a workflow reads a value (an If / else, a wait for a condition, a trigger's `if`,
a stop's `if`, merge fields in any text, a copied or computed value in `contact.update`) it
can read three touches, each with the same leaves:

| Prefix | The touch | When it changes |
|---|---|---|
| `contact.attribution.first.<leaf>` | the contact's first touch | never |
| `contact.attribution.latest.<leaf>` | the contact's newest touch | with every new form submission, booking or chat |
| `trigger.attribution.<leaf>` | the touch of the event that started **this run**: the form submission's, the booking's | never, for the life of the run |

| Leaf | Kind | What it holds |
|---|---|---|
| `source` | text | the lead source, as people read it: `Google Ads`, `Facebook Ads`, `Organic Search`… (`packages/contracts/src/lead-sources.ts` lists the twenty built-in names), or the text an address carried in `source=`. Empty for a touch that was not a visit |
| `sourceKey` | text | the rule that decided it, by key (`google_ads`): the same if a name is ever reworded |
| `sessionSource` | choice | `paid_search`, `paid_social`, `social_media`, `organic_search`, `referral`, `direct`, `others`, `crm_ui`, `third_party` |
| `medium` | choice | `form`, `calendar`, `chat`, `manual`, `api`, `import`, `message`, `automation`, `assistant`, `unknown` |
| `utmSource`, `utmMedium`, `utmCampaign`, `utmContent`, `utmTerm`, `matchType` | text | the labels of the address the visitor arrived on |
| `campaignId`, `adGroupId`, `adId` | text | the ids an ad link carried |
| `referrerDomain`, `landingPage`, `page` | text | the host they came from, the page they arrived on, and the page of the form or booking (both without the query) |
| `touchedAt` | date and time | when the touch was recorded |
| `hasGoogleClickId`, `hasMetaClickId`, `hasMicrosoftClickId`, `hasTikTokClickId`, `hasLinkedInClickId` | yes or no | whether the touch holds such a click id. **The id itself is never a value**: it is compared in the database and never selected |

- **Comparisons by kind:** text takes `equals`, `not_equals`, `includes` (contains),
  `excludes`, `starts_with`, `is_set`, `is_empty`; a choice takes `equals`, `not_equals`,
  `is_set`, `is_empty` and its value is a key or the name beside it (the validator keeps the
  key); yes or no takes `equals` with `true` or `false`; the date takes the date
  comparisons. Text is compared without regard to capitals.
- **Without a touch** every leaf is there and empty, and the yes-or-no leaves are no: a
  condition is judged, not left unknown. A run that no form submission or booking started
  (a tag, another workflow, a booking a team member made by hand) has no arrival; the
  validator warns (`no_arrival`) when a document reads `trigger.attribution` and none of
  its triggers is `form.submitted` or `appointment.booked`.
- **Why the arrival stays the same for a run.** A run keeps the event that started it
  (`automation.enrolments.trigger_event_id`); the event names its subject (the submission,
  the appointment) and is never changed; the CRM writes one touch for that subject, in the
  same transaction, and never rewrites it: a later touch is a new row and only `is_latest`
  moves. So `trigger.attribution.*` is read by the event's subject, with no column of its
  own, and a contact who comes back from another ad while a run waits changes
  `contact.attribution.latest.*` and nothing the waiting run reads of its own arrival.
- **Read-only.** No step writes attribution (`read_only_field`), and `field.changed` and
  `date.reached` cannot watch it (`wrong_field`). A message step that fills in an empty
  leaf stops with `missing_values`, as for any field with nothing in it: use a condition
  first, or the opportunity source below, which never fails.
- **A test run** has no event of its own: with a real contact it reads the contact's
  latest touch as the arrival; with a sample contact everything is empty.
- **Web chat** records a touch too, but a message event's subject is the message, not the
  chat session, so `message.received` has no arrival yet.

**Trigger filters by arrival.** `form.submitted` and `appointment.booked` take two optional
filters beside their own: `sources` ("lead source is any of", up to 20 names, capitals
ignored) and `sessionSources` (any of the nine keys). They are judged when the event is
matched, against the touch read once for the event; an event that recorded no touch passes
neither. `form.submitted` no longer needs a form: left out, it starts on every form (as
GoHighLevel's does). A lead a filter refuses is kept as a `filter_mismatch` with filter
`sources` or `sessionSources`, so "Why didn't this run?" says "The trigger starts only for
a lead source of Google Ads, and this lead's source was Facebook Ads." A goal's
`form.submitted` and `appointment.booked` events take the same filters.

**What a form sent.** A run that a form submission started also reads that submission, in its trigger's
condition, in conditions, in stop conditions and in text:

| Path | Reads |
| --- | --- |
| `trigger.answers.<questionKey>` | the answer to the question with that key: a typed answer, a choice by its key, a tick, the keys of several choices, and a hidden question's value (the query parameter it read, or its default, as text; when the question fills a choice field, the field holds the choice's key) |
| `trigger.pageUrl` | the page the form was sent from, without its query and fragment |

- **The key** is the question's own key in the form (the builder shows it; lowercase
  letters, numbers and underscores). The catalog's `setup.forms` lists each published
  form's questions with the kind each is read as, and `catalog.submission` names the two
  paths.
- **Kinds.** Text, long text, email, phone and a link are read as themselves; a number and
  a rating as a number (kept as typed, compared as a number); a date as a date; one choice
  as a choice of the form's own (`equals` with a key or its label); several choices as a
  list (`includes`); a tick as yes or no; a hidden question as text. A block of text asks
  nothing and a terms box is kept apart, so neither is an answer.
- **Checked against the form.** When every "Form submitted" trigger of the document names a
  form, a key must be a question of one of those forms (`unknown_field`, or
  `unknown_merge_field` in text, with the closest key suggested), and it has that
  question's kind. A key two of the forms ask in two ways is read as text. When a trigger
  starts for **any form**, or the document has no such trigger yet, any key is taken and
  read as text: nobody can say which form it will be.
- **Only a form's run has them.** In any other run `trigger.pageUrl` is empty and no answer
  is set; the validator warns (`no_submission`) when a document reads one and none of its
  triggers is `form.submitted`. As with any field, text that fills in an empty one fails
  the step (`missing_values`): put a condition before it.
- **The same for the life of the run**, like its arrival: a submission is stored once and
  read by the event's subject. A contact who sends the form again starts, or does not
  start, a run of its own.
- **Read-only**, and not watched: no step writes one, and `field.changed` and
  `date.reached` cannot watch one (`wrong_field`).
- **Nothing of the address's query is here** except what a hidden question was set to read,
  so no click id is. How the lead arrived is `trigger.attribution.*`.
- **In the builder:** the server checks and runs these today, and a document written by the
  API or an assistant can use them. The builder's own field lists do not offer them yet.

**An opportunity's source.** `deal.create` (version 2) and `deal.update` take `source`:

| Written as | Means |
|---|---|
| left out (`deal.create` only), or `{ "from": "arrival" }` | from how they arrived: `trigger.attribution.source`, else the contact's `source`; a run with neither creates the deal without a source, and an update leaves the source as it is |
| text, with optional merge fields | that text, such as `"{{trigger.attribution.utmCampaign}}"` |
| `null` | no source (an update removes it) |

A `deal.create` stored at version 1, before the setting existed, creates a deal without a
source as it always did; saving the draft again stamps version 2 and the default applies.
Forms create no opportunity themselves, so a workflow is the one place one gets its source.

**Assigning an owner.** `owner.assign` takes one team member (`user`), or several who take
turns (`users`, 1 to 20, each once, by membership id or name):
- With `users`, each contact goes to the member after the one the last contact went to
  (round robin). The turn is one row per automation and step
  (`automation.assignment_cursors`), locked for the step's transaction: contacts enrolled at
  the same moment, on any number of workers, take different members; a step that fails gives
  its turn back; and publishing the automation again keeps the turn.
- A member who has left the team is passed over, and the explanation says how many were.
  When none of them is on the team the step fails as `unavailable_member`.
- `onlyIfUnassigned: true` leaves a contact that already has an owner alone ("The contact
  already has an owner, and this step leaves an owner in place."), and uses no turn. Left
  out or false, the owner is replaced.
- The step's output is `membershipId`, the member made the owner; absent when the contact
  kept the owner it had.
- A document written with the single `user` is never rewritten. GoHighLevel's Assign to User
  also has weights and a dynamic user id; neither is built.
- A test run says whose turn it would be ("number 2 of 3") from the place kept for the step,
  and moves no turn on.

**Values a step works out.** In `contact.update` a field's value may be, beside a fixed one:
- **Text with merge fields**, filled in as a message is. One merge field alone, such as
  `"{{contact.custom.utm_source}}"`, copies that field into this one and keeps its kind (a
  number stays a number, a choice its key); when the field copied from is empty, this one is
  left as it was and the explanation says so. Text with merge fields mixed in must fit the
  field: a number field needs it to come out as a number, a date field as a date
  (`2026-12-01`, or a date and time, read in the automation's time zone), a yes-or-no field
  as `true`, `false`, `yes` or `no`, a choice field as one of its choices by key or by label.
- **`{ "op": "now" }`**: for a date field, today in the automation's time zone
  (`settings.timezone`); for a date and time field, the instant.
- **`{ "op": "date_add", "field" | "value", "days" }`**: a date moved by a number of days
  (negative goes back), from a date field, from a fixed date, or from now when neither is
  given. `{ "op": "date_add", "days": 365 }` is a year from today.
- **`{ "op": "math", "left", "operator", "right" }`**: `+`, `-`, `*` or `/` on two operands,
  each a number or a number field's path. The result is kept to six decimal places.
- Any of them under `set` beside **`onlyIfEmpty: true`**: the field is written only when it
  has nothing in it. The contact is held still while that is judged and written.

Every value of a step is worked out before any is written, so a step writes all its fields
or none. A value that cannot be worked out fails the step with a code and a sentence that
names the field: `invalid_value` (it does not fit the field), `missing_values` (a merge
field in mixed text, a date to count from or a number to calculate with has nothing in it),
`invalid_operand` (a field read as a number or a date holds something else) and
`division_by_zero`. The validator checks what it can beforehand: a computed value's kind
against the field's (`wrong_field_type`), the fields it reads, a fixed division by zero,
and a `date_add` given both a field and a value (`date_base_given_twice`). This is not an
expression language, on purpose: each shape is typed, so an assistant can write one and the
validator can check it. HubSpot's Format data and GoHighLevel's math and date formatters
do more (text case, rounding, formats); those are not built.

**The deal in hand.** A run keeps one deal "in hand". `deal.move`, `deal.close` and
`deal.update` act on it, and conditions and merge fields read it as `deal.name`,
`deal.status` (`open`, `won`, `lost`), `deal.pipeline` and `deal.stage` (by name),
`deal.value` (also `deal.amount`), `deal.currency`, `deal.source`, `deal.expectedCloseDate`,
`deal.createdAt`, `deal.closedAt` and `deal.custom.<key>`. Every one of them is empty for a
run with no deal in hand. The deal in hand is, in this order:
1. the deal the run's latest `deal.find` found or its latest `deal.create` made, whichever
   step ran last (kept in `automation.enrolments.deal_in_hand_id`, written in the step's own
   transaction);
2. the deal the run is for: a deal's own event, such as `deal.stage_changed` or
   `deal.closed`, enrols the deal itself, since the CRM puts a deal event on the deal's
   timeline, so the deal whose event started the run is the run's record.

Only a run with neither falls back to the earlier rule, "the contact's one open deal",
and its failures `no_open_deal` and `several_open_deals`. A deal in hand that has gone to the
trash fails the step as `deal_unavailable`: acting on another deal instead would be a guess.

- **`deal.find`** takes `which` (`newest`, the default, or `oldest`, by when the deal was
  created) and optional filters, all of which must pass: `pipeline`, `stage`, `status`
  (`open`, `won`, `lost`, or `any`), `nameContains` (whatever the capitals), `value`
  (`{ "operator": "equals" | "greater_than" | "less_than", "value": 1000 }`) and
  `customField` (`{ "field": "deal.custom.<key>", "equals": ... }`). It looks among the
  deals the contact is linked to, never one in the trash. Its branches are `found` and
  `not_found`; its output is `dealId`. A search that finds nothing leaves what was in hand.
- **`deal.update`** changes only what it names: `name` and `source` (text with merge
  fields), `amount` (a number, or null to remove it) or `amountFrom` (a number field of the
  contact; a field with nothing in it leaves the value as it is), `owner` (a team member,
  or null), `expectedCloseDate` (a date, `{ "in": "P30D" }` from the moment the step runs, or
  null), `status: "open"` (reopens a deal that was won or lost; closing is `deal.close`) and
  `fields` (the deal's custom fields, as `deal.custom.<key>`). The deal's own values go
  through the CRM's deal update command with the revision it was read at, its owner and its
  custom fields through theirs, so the same checks and events apply as for a person; a step
  that names nothing that differs changes nothing and says so. Its output is `dealId`.
- A test run asks each `deal.find` what it would find for the contact now, takes the deal a
  `deal.create` would make in hand with made-up values, and says of every later deal step
  which deal it would act on. With no contact, a search finds nothing.

GoHighLevel's Find Opportunity filters on any opportunity field and its Update Opportunity
also moves the stage with a backward-move switch; ours filters on the fields above and
leaves the stage to `deal.move`.

**A deal's amount.** `deal.create` takes a fixed `amount`, or `amountFrom`: a number field
of the contact, read as the step runs and rounded to four decimal places. Not both. A
field with nothing in it, or with something no deal can have as an amount (a negative
number), gives a deal without an amount, and the step's explanation says so.

**A date comes round.** `date.reached` names a contact date `field` and fires at `time`
(08:00 when it names none) on that date, in the time zone the automation's settings name,
moved by `offset` `before` or `after` it. Days, weeks, months and years of the offset move
the date, so the time of day holds across a clock change; hours and minutes move the
instant. `repeat` is `yearly` (the default: every year from the year the field holds, and
29 February on the 28th of a year without one) or `never` (the date itself only). A date
and time field fires once at its own instant and takes neither `time` nor `yearly`. The
worker looks each minute; a contact is enrolled once for an occurrence, by the rules every
enrolment keeps, so a yearly date needs `reEnrollment: after_finished` to enrol a contact
again (the validator warns). Nothing behind the moment the automation was published or
resumed fires, a paused automation's dates pass, and after an outage a firing happens up
to 24 hours late and no later.

**A task comes due.** `task.reminder` is GoHighLevel's Task Reminder trigger: `before`
("Before no. of days") and `after` ("After no. of days"), either or both, each firing on
its own for every task of a contact that has a due time. The days fall on the business's
calendar at the task's time of day, so a clock change between does not move the hour. A
completed task still fires, a deleted one does not, and a task whose due time moves to
another day fires again for its new day. A task with no contact, or on a company or an
opportunity, enrols nobody. The worker sweeps it each minute with the date triggers, with
the same rules: nothing behind the publish or the resume, a paused automation's reminders
pass, at most 24 hours late.

**No trigger.** A document may have no triggers. Nothing then starts it on its own: it runs
only when another automation starts it with `automation.run`. The validator allows it and
warns, at `/triggers` with the code `no_trigger`, so nobody publishes one by oversight.
GoHighLevel's "Add to Workflow" article says the same of its target workflow ("You don't
need to manually set a trigger for the workflow that receives contacts via the "Add to
Workflow" action"); whether it lets every workflow be published without a trigger is not
stated there and is not verified.

**Adding contacts from the list.** Contacts → select contacts → **Add to Workflow** (the
bulk action `add_to_workflow` of `POST /contacts/bulk`, with `workflowId`) enrols each
contact in one workflow that is published and not paused, by the rules every enrolment
keeps: once at a time, and again only where re-entry allows. The run has no trigger event;
its state says `addedBy: bulk_action`, and it carries the bulk request's correlation.
Starting it needs `contacts.manage` and `automations.manage`. Each contact's outcome is on
Contacts → Bulk Actions: `done`, or skipped with `already_in_workflow`,
`reentry_not_allowed`, or `workflow_unavailable` (paused, deleted or unpublished since the
action began). Up to 100 contacts are enrolled before the request answers, more in the
background. GoHighLevel's article also schedules the adds in drips; that is not built.

**A run of an automation ended.** `automation.run_ended` starts an automation for the
contact when a run of one of the automations it names ends:

| `config` | Meaning |
|---|---|
| `automations` | 1 to 20 automations, by id or name. Required: there is no "any automation". |
| `how` | Optional: any of `stopped` (one of its stop conditions), `removed` (an `automation.remove` step of another automation), `completed`, `failed`. Left out, any of them. |
| `stoppedBy` | Optional: only a run a stop condition ended on one of these events, such as `message.received`. Given without `how`, it means stopped runs only. |

A run cancelled because its automation was deleted starts nothing. This is how "a reply
stops the sales sequence and the salesperson is told" is built: the sales sequence stops on
`message.received`, and a second automation with
`{ "automations": [the sales sequences], "stoppedBy": ["message.received"] }` notifies. A
booking that stops the same sequence does not start it. When one reply stops two sales
runs of a contact, the second ending finds the contact already in the notifying
automation, so it starts once (and once ever, where it enrols a contact once).
What keeps such automations from starting one another without end: the trigger may not
name its own automation; the validator refuses, as `automation_loop`, a trigger or a
start that closes a loop through what the others have published; and at run time the run
it starts carries the chain of automations that led to it, an automation already in that
chain is not started again, and a chain stops at ten. This trigger is ours: we found no
equivalent in GoHighLevel's documentation.

**Replied to an automation.** `message.received` takes an optional `repliedTo`: 1 to 20
automations, by id or by name. The trigger then starts only on a reply to one of them: the
contact's most recent automated message on the same channel, at or before the reply, was
sent by a run of it. It does not matter whether that run is still going, so the same reply
can end a sales sequence through its stop condition and start the automation that tells
the salesperson. There is no time window; an email reply is matched to automated emails
and a text to automated texts; messages people send by hand, and messages that failed or
bounced, are not counted; and which message a reply quotes is not read. GoHighLevel has a
"Replied to Workflow" filter whose matching rule its documentation does not give, so this
rule is ours.

**Why an automation did not start.** When an event a published automation listens for is
matched and the automation does not enrol the record, the match keeps one row saying why
(`automation.trigger_evaluations`), written in the match's own transaction and kept 30 days.
A start that did happen leaves none: the run is its record.

| `reason` | What was found | `detail` |
|---|---|---|
| `filter_mismatch` | The event did not pass one of the trigger's own filters. | `filter` (its key in the trigger, such as `tag`, `form`, `stage`, `to`, `repliedTo`), `expected`, `actual` |
| `condition_false` | The trigger's `if` did not hold for the record. | `values`: each field the condition compared, with what it held |
| `already_enrolled` | The record was in the automation already. | `queued: true` when it goes through again once that run ends (section 2, re-entry) |
| `reentry_not_allowed` | The record had been through it, and it takes a record once. | |
| `paused` | The automation was paused. A paused automation's events are still matched for this. | `after`: the run after which the record was to go through again, when it was paused by then |
| `contact_missing` | The event was about no record. | |
| `stopped_by_rule` | A rule that cannot be switched off: an imported contact starts nothing by having been created, and a contact in the trash starts nothing. | `rule`: `imported_contact` or `contact_trashed` |
| `refused_loop` | Starting it would have closed a loop between automations whose runs start one another, the event was the workflow's own change, or the circuit breaker held. | `cause`: `own_change`, or `run_limit` with `starts` and `windowMinutes`; none for a run-ended loop |

`GET /automations/{id}/trigger-evaluations` lists them, newest first, filtered by
`contactId`, `from` and `to`, with `after` and `limit`; each has an `explanation` in words
made from the reason and the detail and nothing else. `GET /automations/{id}/explain-contact`
answers "what did this automation do for this contact" from rows only: `state` is `has_run`
(with the latest run: its status, the step it is at, and `ended`, why it ended, in words),
`not_started` (no run, and the latest evaluations say why) or `nothing_on_record` (neither,
in the days evaluations are kept); `summary` says the same in a sentence and never guesses.
What is not recorded: a date trigger's own decisions (the clock's sweep enrols by another
path), and a draft, which has no subscription to be judged. GoHighLevel keeps trigger
attempts with a "Reason for Unmatch" for 30 days; the reasons above and what each holds are
ours.

Because the same catalog drives webhooks, anything that can start an automation can also be sent to an outside app.

**Conditions** are structured JSON, not code, so they can be checked before anything runs:
- **The basic form:** `{ "field": "contact.services", "operator": "includes", "value": "Video" }`.
- **Combining them:** `all` (every one must be true), `any` (at least one) and `not`.
- **Operators:** `equals`, `not_equals`, `includes`, `excludes`, `starts_with` (text, a phone number or a link; capitals ignored), `greater_than`, `less_than`, `is_set`, `is_empty`, `before`, `after`, `within_last`, `within_next`.
- **Fields** start with `contact.`, `deal.`, `trigger.attribution.` (see "Attribution and lead source") or `trigger.answers.`, or are `trigger.pageUrl` (see "What a form sent").

Free code is its own step type, sandboxed and off by default.

---

### The Send email step

`email.send` takes its content in one of four forms. The body is always plain text; `html`
is the formatted part sent beside it, cleaned by the same allowlist as a template when the
email is sent.

| Form | Config | What is sent |
| --- | --- | --- |
| Copy | `{ "mode": "copy", "subject", "body", "html"?, "source"? }` | The step's own content. `source` records the template it was copied from and never links it. |
| Sync | `{ "mode": "sync", "source": { "id", "revision" }, "subject"? }` | The template as it is at each send. An edit in the library reaches the step at once; an edit through the step is an edit of the template. |
| Reference (older) | `{ "template", "subject"? }` | The template as it is at each send. |
| Inline | `{ "subject", "body", "html"? }` | The step's own content. |

On every form the step may also say: `mailbox` (the From address: a connected mailbox, never
free text; left out, the business's only one), `fromName`, `replyTo`, `cc` and `bcc` (up to
10 each; an address, or exactly one merge field such as `{{contact.email}}`), `preheader`
(formatted emails only) and `attachments` (up to 5 file ids, 15 MiB in all). A step's own
`subject` or `preheader` on a sync or reference step stands in for the template's.

**In a test run** the step is filled in for the test's contact (or its sample values) as a
send fills it in: the step's own words, or the template as it is now, with the step's own
subject and preview line over the template's, and a contact field the run wrote earlier
read under its merge key too. The step's row has `email`: `subject`, `firstLine` (the first
line of the text that has words, cut at 200 characters) and `missingValues`. A merge field
with no value fails the step as `missing_values`, as a real send would, and an archived
template as `template_unavailable`; each then follows `onFailure` as a real run does. The
test run never checks the mailbox, the recipient's address or consent: those are decided
when a real email is queued.

The step fails, and queues nothing, when a file is gone or not the business's
(`attachment_unavailable`), the files are too large (`attachments_too_large`), an address
field does not hold an address (`invalid_address`), or the linked template is archived
(`template_unavailable`; there is no fallback to older content). A suppressed address is
left out of Cc and Bcc.

Every workflow email is marketing email: it leaves with the List-Unsubscribe headers, and
its text and formatted part end with the business's postal address (when the profile has
one) and an unsubscribe line. `{{email.unsubscribe_link}}` places the link in the body
instead. The stored message is what the author wrote; the footer is added to the mail.
## 4. What the validator checks

The validator runs on every save, on every API call that changes a document, and on demand. It checks two kinds of things.

**Structure:**
- The document matches the JSON Schema.
- Every `next` points to an existing step, and every step can be reached.
- No loop runs without a wait in it, whether it leads back through a `next` or a `goto`,
  and each loop waits at least an hour each time round (`loop_wait_too_short`).
- Warnings: `self_trigger` when a step changes a field or a tag that this
  workflow's own trigger listens for and re-entry is on; `automation_loop` when this
  workflow's changes to fields or tags start another workflow whose changes, perhaps by way
  of more, start this one (the setup gives each published workflow's `listens` and
  `writes`). The engine refuses such a start, so each says what will not happen.
- A webhook step's headers are each named once (`duplicate_header`), name only a stored
  webhook secret (`unknown_secret`), and a key-like query parameter in its address
  (`api_key=`, `token=`, `secret=` and the like) is warned about (`secret_in_url`).
- A `goto` has a target that exists and no `next`; an automation has one `goal` step.
- No wait is longer than 365 days; that holds for a timeout and for an offset too.
- A failure path leads to a step that exists and is another step (`unknown_step`,
  `failure_path_to_itself`), counts for reachability and for the loop rule; `continue` is
  for a step with one next (`on_failure_not_for_step`); `retry` is for the steps that can
  be retried (`retry_not_for_step`) and waits at most 24 hours (`retry_wait_too_long`).
- A resume window opens at some time (`empty_resume_window`), and a wait's `channel` or
  `link` goes with the event it filters (`filter_not_for_event`).
- Branch names match the step: `yes` / `no` for a condition with one `if`, each named
  branch and `none` for one with `branches`, named variants for a split, `found` and
  `not_found` for a `deal.find`.
- An `owner.assign` names each member once (`duplicate_member`); a `deal.update` changes
  something (`nothing_to_update`), gives a fixed amount or a field and not both
  (`amount_given_twice`), sets a close date at most ten years ahead (`date_too_far`) and
  writes only the deal's custom fields under `fields` (`wrong_field`); a `deal.find` filters
  on a custom field of a deal.
- A value `contact.update` works out fits the field it is written to (`wrong_field_type`)
  and reads fields of the right kind.

**This business's setup:**
- Every referenced form, template, field, pipeline and stage exists.
- Every message step has a provider connected, and every AI step has an AI key.
- Every merge field exists.

**Rules that can't be switched off:**
- Marketing messages respect consent, DND and quiet hours.
- Each contact gets at most the account's daily message limit.
- Destructive steps (such as deleting a contact) need `"confirm": true`.

**Errors point to the exact spot** (as a JSON Pointer) and suggest a fix:

```json
{
  "valid": false,
  "errors": [
    {
      "path": "/steps/check_in/config/message",
      "code": "unknown_merge_field",
      "message": "contact.firstname is not a field.",
      "suggestion": "Did you mean contact.firstName?"
    }
  ],
  "warnings": [
    {
      "path": "/steps/send_reel",
      "code": "no_follow_up",
      "message": "This path ends right after a message. Add a wait and a check-in if you expect a reply."
    }
  ]
}
```

**Warnings never stop a publish.** Besides `no_trigger` and `no_follow_up`:

| Code | Where | What it says |
|---|---|---|
| `form_draft` | `/triggers/<n>/config/form` | "This form is a draft: publish it to receive submissions. Until then nothing starts this workflow from "<the form's name>"." The setup lists drafts as well as published forms (`forms[].status`), so a trigger may name a draft; an archived or missing form is still the error `unknown_reference`, "There's no form". |
| `no_postal_address` | `/steps/<id>` of each Send email step | "Your business profile has no postal address. US law (CAN-SPAM) asks every marketing email to show a valid postal address: add yours in Settings → Business profile and it is added to the end of this email. The email is still sent without it." Said when `setup.postalAddress` is false (addendum of 2026-10-14). |

---

## 5. The API

Base path: `/api/v1` on each install.

**Authentication:** API keys created per app, each with scopes and limited to one sub-account (an agency can create keys for each client). Marketplace-style OAuth apps can come later. Every change is recorded with the key's name as the actor, which shows up in "Who changed this draft".

| Endpoint | What it does | Scope |
|---|---|---|
| `GET /automations/catalog` | Triggers, step types, operators, and this sub-account's forms, templates, fields and pipelines, each with its JSON Schema. A custom field comes with its `key`, type and choices, its `label` and the `folder` (id and name) Settings keeps it in. Shows only what the key may use | `automations:read` |
| `GET /automations/schema` | The JSON Schema of the document format | none |
| `GET /automations` | List automations with status and last run | `automations:read` |
| `GET /automations/{id}` | The live version and the current draft | `automations:read` |
| `POST /automations` | Create a draft from a document | `automations:write` |
| `PUT /automations/{id}/draft` | Replace the draft (send `baseDraftVersion`) | `automations:write` |
| `POST /automations/{id}/draft/email-template-copy` | Copy an active email template into an action, checking its `revision` and `baseDraftVersion`; optional `document` includes pending edits. Saves independent text and source provenance. | `automations:write` |
| `PATCH /automations/{id}/draft` | Small edits as JSON Patch (RFC 6902) | `automations:write` |
| `POST /automations/{id}/draft/email-sync` | Make a Send email action sync with a template: the action becomes `{mode:'sync', source}`, keeps its mailbox, From name, Reply-To, Cc, Bcc and files, and drops its own content; the template is not changed. Checks the template's `revision` and `baseDraftVersion`. Turning sync off is the copy operation above. | `automations:write` |
| `PUT /automations/{id}/draft/email-sync/content` | Edit the template a syncing action sends, through the action: the template's next revision and the draft are saved together or not at all. Needs `templates.manage` too. | `automations:write` |
| `GET /automations/{id}/steps/{step}/email-statistics` | What one Send email action did, optionally between `from` and `to`: total, waiting, sent, bounced, failed, skipped by reason, unsubscribed. `delivered`, `opened` and `clicked` are `null`: nothing measures them yet. | `automations:read` |
| `GET /message-templates/{id}/workflow-actions` | The Send email actions, in drafts and running versions, that sync with, refer to or were copied from a template | `automations:read` |
| `POST /automations/validate` | Check a document without saving it | `automations:read` |
| `POST /automations/{id}/test-runs` | Dry run on a real or sample contact, with simulated events ("replies on day 1") and fast-forwarded time; nothing is sent. A Send email step is filled in for the contact and fails on `missing_values` as a send would | `automations:test` |
| `GET /automations/{id}/test-runs/{runId}` | The step-by-step trace | `automations:test` |
| `POST /automations/{id}/publish` | Make the draft the new live version, with a note | `automations:publish` |
| `POST /automations/{id}/pause`, `/resume` | Stop or restart new enrollments | `automations:publish` |
| `GET /automations/{id}/versions`, `/versions/{n}`, `/versions/{a}/diff/{b}` | History and differences between versions | `automations:read` |
| `GET /automations/{id}/runs`, `GET /automation-runs/{runId}` | Real runs: each step, what it was given (its settings and, for a condition, the values it compared), the branch taken and why | `automations:runs` |
| `POST /automation-runs/{runId}/retry`, `POST /automation-runs/{runId}/continue` | Run a failed run again from its failed step; end a waiting run's wait now, down the branch named | `automations:write` |
| `GET /automations/{id}/trigger-evaluations`, `GET /automations/{id}/explain-contact` | Each time the automation did not start and why; what it did, or did not do, for one contact | `automations:runs` |
| `GET /records/{id}/automation-runs` | Every automation a contact, company or deal has been through, newest first | `automations:runs` |
| `GET /automations/{id}/step-runs` | The execution logs: every step the automation's runs took, newest first, filtered by status, step, type, dates and record | `automations:runs` |
| `GET /automations/{id}/stats` | How many runs, and how many visits to each step and each trigger, for the live version and for all time | `automations:read` |
| `GET /automation-folders`, `POST /automation-folders`, `PATCH`, `DELETE /automation-folders/{id}` | Folders, which nest; a change names the folder's `revision`; deleting one moves what was in it up a level | `automations:read` / `automations:write` |
| `PUT /automations/{id}/folder` | Put an automation in a folder, or at the top level | `automations:write` |
| `DELETE /automations/{id}`, `POST /automations/{id}/restore` | Delete to the Deleted list, which stops it and cancels its runs; restore from it, not running | `automations:publish` |
| `GET /automations/webhook-signing`, `POST /automations/webhook-signing/rotate` | Whether webhook steps can be signed, and making or replacing the signing secret (shown once) | `automations:read` / `automations:publish` |
| `GET /automations/webhook-secrets`, `PUT /automations/webhook-secrets/{name}`, `DELETE /automations/webhook-secrets/{name}` | The business's named webhook secrets, by name only; storing or replacing one (sealed in the vault, never shown again); deleting one | `automations:read` / `automations:publish` |
| `POST /automations/import`, `GET /automations/{id}/export` | Move automations between sub-accounts or installs, or share them as templates | `automations:write` / `automations:read` |

**The list** (`GET /automations`) takes `folder` (a folder's id, or `root` for the top level), `q` (the name contains it) and `status`. Each automation comes with its folder, how many runs it has started (`totalEnrolled`) and how many are still going (`activeEnrolled`). Deleted automations are a list of their own, `status=archived`, each with when it was deleted and when it will be removed for good, 30 days later; every other list leaves them out.

**The enrollment history** (`GET /automations/{id}/runs`) takes `status`, `from` and `to` (on when the run started), `record` and `trigger`. Each run names the trigger that enrolled it and the step it is at: the step it waits at, or the one it runs next.

**Deleting stops an automation at once.** Nothing new starts it, every run still going is cancelled with the reason `automation_deleted`, and no step of it runs afterwards. A message an earlier step already queued is not recalled. Restoring brings the automation back paused if it was ever published, else as a draft, at the top level; the cancelled runs stay cancelled.

**Webhook events:** `automation.draft_updated`, `automation.published`, `automation.run.completed`, `automation.run.failed`, `automation.run.retried`, `automation.run.continued` (a person ended a run's wait early; the payload has the `step` and, where one was chosen, the `branch`), `automation.run.stopped` (a stop condition or an `automation.remove` step ended the run; the payload's `reason` says which: `stop:<event>` or `removed:<automation id>`).

**Other events:** `automation.deleted`, `automation.restored`, `automation.purged`, `automation.moved`, `automation.folder_created`, `automation.folder_updated`, `automation.folder_deleted`.

**No silent overwrites:** every draft has a `draftVersion`, and each save must send the version it started from. If someone else (a person on the canvas, or another AI) saved in between, the API returns `409 Conflict`, saying which version the draft is at now; the caller reads the draft again (`GET /automations/{id}`) and makes its change to that. Nobody's changes are lost without notice.

---

## 6. MCP server

The target operations for MCP authoring are:
- `get_automation_catalog`, `list_automations`, `get_automation`;
- `create_automation_draft`, `update_automation_draft`;
- `validate_automation`, `test_automation`;
- `publish_automation` (only offered to keys with the publish scope);
- `list_automation_runs`, `explain_automation_run`.

Models without MCP can use the REST API directly. The JSON Schema can be turned into function-calling tool definitions for any model.

The implemented stdio bridge is in [packages/mcp](../packages/mcp/README.md). Its tools
use `crm_` followed by the canonical API operation ID, and their input schemas come
from the existing contracts. It offers catalog/schema discovery, draft editing,
validation, dry runs and supporting fields/forms/templates through the canonical API,
and the two reads that say why a workflow did not start for a contact
(`crm_listAutomationTriggerEvaluations`, `crm_explainAutomationContact`). Continuing or
retrying a run is not offered: what comes next can send.
Publishing is omitted unless explicitly enabled and still requires the API key's
permission. Hosted Streamable HTTP and the built-in assistant authoring flow remain
unimplemented. The wedding acceptance
distinguishes shipped MCP protocol verification from full client-workflow completion.

---

## 7. How an AI builds an automation correctly

An AI doesn't need to be perfect. It needs exact feedback. The loop:
1. **Read the catalog.** Only things that exist and that this key may use.
2. **Write a draft** of the document.
3. **Validate.** Fix the errors it gets back, then repeat until the draft is valid.
4. **Run a test** on a sample contact, including simulated events (for example "replies on day 1"), and check that the trace matches what was asked.
5. **Save the draft.** A person sees a plain-language summary and the change.
6. **Publish,** once a person approves or the key has the publish scope.

This is the required authoring loop for the built-in assistant and outside AIs; the
built-in assistant workflow-authoring UI is not yet implemented.

---

## 8. Safety

- **Drafts first.** Changes from AI and the API arrive as drafts. Publishing needs the `automations:publish` scope or a person's click.
- **Optional test requirement.** A setting can require a passing test run before any publish.
- **Rules apply to everyone.** The validator's rules apply to the API exactly as they do in the app. An API key can't skip consent or quiet hours.
- **Every change is recorded,** with its actor: a person, the assistant, or a named app.
- **Limits:**
  - rate limits per key;
  - a cap on active automations per sub-account;
  - a spending cap per automation for AI steps.

---

## 9. The three views in the app

All three edit the same document, and the assistant panel is available in each:
- **Canvas:** the automation drawn as boxes and lines, built in the dashboard itself.
  - Add steps by dragging them from the step library, or with `+` between steps. A step
    chosen in the library can also be put in place without dragging, by choosing where it
    goes. Either way its settings are filled in before it is added, so the document stays valid.
  - Moving boxes only changes `layout`. The first move writes every step's place, so the
    rest of the drawing stays where it was; "Tidy layout" forgets them all.
  - What `layout` doesn't place is laid out automatically as a tree, which is how an
    automation written by AI or through the API is drawn.
  - Everything works from the keyboard: each box and each `+` is a button, in the order a
    contact meets the steps, and a box is moved with the arrow keys.
- **Steps:** a readable list with a plain-language summary generated from the document. This is the easiest view for non-technical users.
- **JSON:** the document itself, checked as you type, with copy, import and download.

**Start from a recipe.** The workflows list has "Start from a recipe" beside "Create
workflow": a ready-made workflow made as a new draft from a few choices, which opens in the
builder and never starts running by itself. A recipe is a function in the contracts
(`packages/contracts/src/automations-recipes.ts`) that returns an ordinary document, so the
dashboard, a test and the API make the same one. The dialog lists the recipes; choosing
one shows what it does and asks its choices. The address
`/automations?recipe=appointment_reminders&calendar=<id>` opens it on "Appointment
reminders" with that calendar chosen, which is where a calendar's Notifications ("Reminders",
"Create reminder workflow") link to.

**"Appointment reminders"** (2026-10-15; GoHighLevel's templates are "Appointment
Confirmation + Reminder", but here the booking already sends its confirmation, so the
recipe does not repeat it): `appointment.booked` on the calendars chosen (one trigger
each; none chosen, any calendar) → `wait.appointment` 24 hours before (`passed`, booked
less than a day ahead: straight on) → a transactional email → `wait.appointment` 1 hour
before → a transactional email → when chosen, and only offered when a number can text, an
If / else on `contact.phone` and a transactional text. Each message has `onFailure:
continue`, so one messaging refuses (no consent, no phone, no number) is noted on the run
and the run goes on. `reEnrollment: after_finished`. What it does, as integration tests on
Postgres show (`appointment-reminders.int.test.ts`): the emails are queued at exactly
T-24h and T-1h with the time in the booker's zone; a reschedule moves both waits and the
email names the new time; a cancellation, or a no-show or invalid mark, takes
`no_appointment` and nothing more is sent. Limits, for the owner to weigh: a contact who
books again while a run waits is reminded of the newest booking only once that run ends, so two bookings close together can miss the second's day-before reminder; a
reminder whose moment falls in quiet hours goes when they end, so the 1-hour reminder of an
appointment that starts before quiet hours end (08:00 by default) arrives after it has
started; a text needs the contact's
transactional SMS consent, which the booking page does not record yet; and the booker's
reschedule and cancel link cannot be put in, since the raw token is never stored.

**"Tag and route leads by source"**: any form submitted → an If / else on `trigger.attribution.source` with
a branch for Google Ads, Facebook Ads, Instagram Ads and Organic Search, and one for
everything else → on a named branch, the tag of that source (`Source: Google Ads`…: the
very tags a form that tags by source adds); everything else adds no tag, because one fixed
tag for many sources would name most of them wrongly, and the form has already given each
of those leads its own (`Source: Direct`, `Source: Referral`…) → an owner (one person, or
the team in turn, only for a lead with no owner; left out when nobody is chosen) → an
opportunity whose source is how the lead arrived, on every branch. The dialog asks for the
pipeline, the stage and who leads go to. It makes no tag by name: it asks the server for
the business's tags of those lead sources by key (`POST /lead-sources/tags`, which makes
any that is not there yet, in the "Lead source" group) and writes each into the draft by
id, so the workflow and the forms share one tag a source, also after someone renames it.

**The screens.** On
screen an automation is a "workflow", a step an "action"; routes, files and the API keep
their names.
- The **Workflows list** shows every workflow in a table, in folders, with what each has
  enrolled, its numbers under the row, a Deleted tab with restore, and an Overview tab of
  totals. A new workflow is made at once, with no trigger yet, and opened.
- The **builder** has the whole window. Its first bar has the way back, the name and the
  save state; its second the three views, the tabs Builder, Settings, Enrollment history
  and Execution logs, "Test workflow" (a dry run of the saved draft; a Send email action's
  row shows the email's subject and first line, and the merge fields with no value with
  "A real send would stop here") and the Draft / Publish switch. The switch publishes a workflow that never was (after the before-and-after
  dialog), and pauses and resumes one that is; "Publish changes" appears when the draft
  differs from the live version. An address with no `view` is the canvas.
- A trigger or an action is added and changed in a **panel** down the right-hand side: a
  list under GoHighLevel's category names, then the form. A trigger's filters, and an
  If / else's conditions, are rows (field, comparison, value) that must all hold; they are
  the document's own `if`. A condition written with `any` or `not` is shown as it reads and
  edited in the JSON view.
- The **Settings tab** edits `settings` (re-entry, time zone, sending window) and the stop
  on a contact's message; it is part of the draft and saved with it.

**The forms that change records.** On screen a
deal is an "opportunity", as GoHighLevel names it: the actions are Create, Find, Update,
Move and Close opportunity, the triggers "Opportunity stage changed" and "Opportunity
closed", and cards, run words and the catalog's own labels and descriptions say the same.
Type ids, paths and config keys keep `deal`.
- **Assign owner.** A search box over the team and a list of boxes to tick. One member
  ticked is written as `user`, several as `users`, in the order ticked, which is the order
  they take turns; the form says which it is ("2 chosen: each contact goes to the next of
  them in turn") and stops at 20. "Only apply to unassigned contacts" is `onlyIfUnassigned`.
  A member the step names that the team no longer has stays in sight as "(not found)".
- **Update contact.** One row for each field under "Fields to set": the field, how it is
  set, and the value. The ways are A value, Copy from another field, Text with merge
  fields, and, for a date, Now and Date plus days (counted from now, a date or a date
  field; a negative number goes back), for a number, Calculate (plus, minus, times,
  divided by, on numbers or number fields), and Empty the field (not for an email or a
  phone). "Only if empty" on a row writes `set` beside `onlyIfEmpty`. A value rows cannot
  hold is shown as "Kept as written" and edited in the JSON view.
- **Find opportunity.** Newest or oldest, then filters added one at a time, each once:
  Pipeline, Pipeline stage, Status, Opportunity name contains, Opportunity value (equals,
  greater than, less than) and Custom field equals. With no filter the form says any of
  the contact's opportunities can be found. The canvas draws its two paths, Found and Not
  found.
- **Update opportunity.** Rows under "Fields to change", each added once: Opportunity
  name, Opportunity value (a number, a number field of the contact, or removed), Owner,
  Expected close date (a date, days or weeks from when it runs, or removed), Source and
  Status: reopen; then the opportunity's custom fields. Move, Close and Update opportunity
  say under their form which opportunity they act on: the one found or created earlier in
  the workflow, otherwise the contact's one open opportunity.
- **Field lists.** Wherever a field is chosen, a custom field is listed by the name the
  business gave it (`setup.fields.contact[].label` in the catalog, also on `deal`), and a
  contact's custom fields come under their folder from Settings, as "Contact: Wedding
  details" (`folder`, with its id and name). A catalog that carries neither lists the
  field by its key in words under "Contact custom fields". Cards and summaries still word
  a custom field from its key.
- **Opportunity fields in conditions and text.** A condition's field list ends with
  "Opportunity (found or created in this workflow)": its name, stage, pipeline, status,
  value, source, currency, expected close date, the dates it was created and closed, and
  its custom fields. "+ Insert a field" under a message's text offers the contact's
  fields, the opportunity's and the business's custom values, and puts the merge field in
  where the keyboard was.

**Runs** sit beside the three views, as the Enrollment history tab: everyone the automation
has run for and, for one run,
each step taken, what it was given, the branch it took and why. A run that waits in a wait
step has **Continue now** (`POST /automation-runs/{runId}/continue`): a wait for a time goes
on at once, and a wait that has paths asks "which way?" first, since nothing happened to
choose one; the dialog says that what comes next can send. **Why didn't this run?** on the
same tab takes a contact and shows what the workflow did for them (the run, where it is,
how it ended) or the latest times it did not start, each with its reason in words
(`GET /automations/{id}/explain-contact`); a contact's own page asks the same after a
workflow is chosen. The Execution logs tab lists
every step taken across its runs. A contact's page lists the
automations it has been through, each leading to its run. A step is `waiting` only while
its run waits at it: once the run goes on it is `succeeded`, and if the run was stopped or
cancelled in the wait it is `skipped`.

When the assistant (or an outside AI) changes the draft, the change appears as **"New"** steps on the canvas, to keep or undo.

