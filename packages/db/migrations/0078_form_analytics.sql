-- A form's numbers: how often it was shown, and how long people took to send it. One row
-- for each form and day, counted into as it happens, so reading them costs the same
-- however busy a form is.
--
-- Nothing here is about a visitor: no row per view, no address, no cookie. A view is the
-- published form's questions being served to a browser (the embed on a website, or the
-- form's own page); a preview of a draft is not one. The day is the business's calendar
-- day when it was counted (tenancy.businesses.timezone at that moment).
--
-- Responses are not kept here: they are the form's stored submissions, counted by the day
-- they were sent. What is kept is what a submission does not hold: the seconds from the
-- form being shown (the moment in the proof the server signed, 0049) to it being sent,
-- summed, and how many submissions were timed, so the average is the one divided by the
-- other.
create table forms.daily_stats (
  business_id uuid not null,
  form_id uuid not null,
  day date not null,
  views integer not null default 0 constraint daily_stats_views_nonnegative check (views >= 0),
  timed_submissions integer not null default 0
    constraint daily_stats_timed_nonnegative check (timed_submissions >= 0),
  -- A shown form is accepted for at most a day (24 hours), and a form stores at most 2000
  -- submissions a day, so the sum of a day stays far inside an integer.
  fill_seconds integer not null default 0
    constraint daily_stats_fill_seconds_valid
      check (fill_seconds >= 0 and (timed_submissions > 0 or fill_seconds = 0)),
  primary key (business_id, form_id, day),
  foreign key (business_id, form_id) references forms.forms (business_id, id) on delete cascade
);

call util.enable_tenant_rls('forms.daily_stats');
-- Counted into by the public surface and read by the form's Analytics tab. Rows are never
-- deleted by the application: they go with their form.
grant select, insert, update on forms.daily_stats to crm_app;
