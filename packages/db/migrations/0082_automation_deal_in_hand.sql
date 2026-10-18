-- The opportunity a run has in hand (deal.find, deal.create): the deal its later deal steps
-- act on, and whose values its conditions and merge fields read as deal.*. A step that finds
-- or creates a deal writes it here in its own transaction, so a step that fails keeps
-- nothing. It is a column, not a key of the run's state: the engine writes the state whole
-- at the end of each step from what it read at the start, and a deal that is purged must
-- stop being pointed at, which a foreign key does and JSON cannot.

alter table automation.enrolments
  add column deal_in_hand_id uuid,
  add constraint enrolments_deal_in_hand_owner foreign key (business_id, deal_in_hand_id)
    references crm.deals (business_id, id) on delete set null (deal_in_hand_id);
comment on column automation.enrolments.deal_in_hand_id is
  'The deal the run''s deal steps act on: the one its latest deal.find found or deal.create made. Null: the run''s own deal (a deal run), else the contact''s one open deal.';
-- Purging a deal looks for the runs that point at it.
create index enrolments_deal_in_hand_idx on automation.enrolments (business_id, deal_in_hand_id)
  where deal_in_hand_id is not null;
