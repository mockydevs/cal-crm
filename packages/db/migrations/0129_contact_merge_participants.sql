-- Merging contacts (0127): every module moves its own rows of a contact merged away to the
-- contact kept, in the merge's one transaction. These tables were written once and never
-- changed, so crm_app had no UPDATE on them; a merge needs to change which contact (or
-- record) a row is of, and nothing else of it. A form's answers, a trigger link's digest and
-- a date trigger's firing stay as they were written.
grant update (contact_id) on forms.submissions to crm_app;
grant update (contact_id) on messaging.trigger_link_tokens to crm_app;
grant update (contact_id) on messaging.trigger_link_clicks to crm_app;
grant update (record_id) on automation.trigger_firings to crm_app;
grant update (record_id) on automation.trigger_evaluations to crm_app;
