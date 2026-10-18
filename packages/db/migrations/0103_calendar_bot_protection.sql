-- Bot protection of a calendar's public booking page (ADR-100; tasks/edge-cases/public-intake.md,
-- H4). Off by default, so every calendar books as before. 'altcha' asks the visitor's
-- browser for ALTCHA's proof of work, bound to the page's render token, before a booking is
-- taken. A form keeps the same choice in its definition (forms.forms.definition), not here.
alter table calendar.calendars
  add column bot_protection text not null default 'off'
    constraint calendars_bot_protection_valid check (bot_protection in ('off', 'altcha'));
