-- Lost deals already keep lost_note. Keep a won deal's explanation as well (P1.16).
alter table crm.deals add column won_note text;
alter table crm.deals add constraint deals_won_note_only_when_won
  check (status = 'won' or won_note is null);
alter table crm.deals add constraint deals_won_note_length
  check (won_note is null or length(btrim(won_note)) between 1 and 2000);
