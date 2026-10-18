-- Task lists, newest first, a page at a time (task P1.21, ADR-034), and the completion
-- actor's kind checked as every other actor column's is.
--
-- Lists page by (created_at, id), newest first: the business's, one record's, or one
-- person's. Under the row-level security policy, equality on business_id, record_id and
-- assignee_user_id and the cursor's comparisons on created_at and id can use these indexes,
-- which also give the order. Measured on 100,000 tasks in a business, as crm_app: before them,
-- the list of every status read and sorted all 100,000 (121 ms) and the open list all the
-- open ones (26 ms); with them, each page reads its 51 rows (0.3 and 0.5 ms).

-- Every status, in the business.
create index tasks_list_idx on crm.tasks (business_id, created_at desc, id desc);

-- The default list is the open tasks, and most tasks end up completed: with 99% completed,
-- the list above skips ~100 rows for each open one (2 ms a page, growing with the history);
-- this reads only open tasks (0.5 ms), and serves the overdue list too (1.6 -> 0.06 ms).
create index tasks_open_list_idx on crm.tasks (business_id, created_at desc, id desc)
  where completed_at is null;

-- One record's tasks in the same order. It also serves the record foreign key, as the index
-- it replaces did.
drop index crm.tasks_record_idx;
create index tasks_record_idx on crm.tasks (business_id, record_id, created_at desc, id desc);

-- One person's tasks in the same order. Without it, the ordered indexes above tempt the
-- planner to walk the business's tasks looking for theirs: 8 ms for someone with no open task
-- among 100,000. tasks_assignee_idx (by due date) stays for due-date lookups.
create index tasks_mine_idx on crm.tasks (assignee_user_id, business_id, created_at desc, id desc);

-- My open work must also skip completed history. With no open work for a person, the
-- full person index or business open index can scan thousands of irrelevant rows:
-- measured 10,001 business open rows, 2.9 ms, versus two buffers and 0.056 ms here.
create index tasks_open_mine_idx on crm.tasks (assignee_user_id, business_id, created_at desc, id desc)
  where completed_at is null;

alter table crm.tasks add constraint tasks_completed_by_kind_valid
  check (completed_by_kind in ('user', 'ai_agent', 'automation', 'api_key', 'system', 'contact', 'form', 'import'));
