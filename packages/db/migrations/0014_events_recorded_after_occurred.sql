-- An event is never recorded before it happened (DATABASE.md section 10). Consumers count
-- a day's events from the partitions that start at that day (the daily tag count does),
-- so a future-dated or clock-skewed occurred_at fails here rather than slipping past them.
-- Code that takes occurred_at from outside, such as a provider's timestamp, caps it at
-- now(). Every partition, including those maintenance adds later, inherits the check.

alter table events.events
  add constraint events_recorded_after_occurred check (occurred_at <= recorded_at);
