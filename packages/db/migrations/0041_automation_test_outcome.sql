-- P1.56: how a test run ended (completed, stopped by an event, failed at a step, or the step
-- limit), which GET /automations/{id}/test-runs/{runId} returns beside the trace.
alter table automation.test_runs
  add column outcome jsonb constraint test_runs_outcome_object
    check (outcome is null or jsonb_typeof(outcome) = 'object');
-- Every run finished from now on keeps its outcome. Runs finished before this never kept
-- one, so theirs stays null rather than being guessed: the rule is not applied to them.
alter table automation.test_runs
  add constraint test_runs_finished_have_outcome
    check (status = 'running' or outcome is not null) not valid;
