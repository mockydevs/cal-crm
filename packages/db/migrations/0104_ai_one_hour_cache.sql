-- Claude's one-hour prompt cache (ADR-101): the ledger counts its writes, and a price can
-- say what they cost.
--
-- A write to the one-hour cache costs twice fresh input, against 1.25 times for the
-- five-minute cache (https://platform.claude.com/docs/en/about-claude/pricing, "Prompt
-- caching"). cache_write_tokens stays every token written, whatever the lifetime, as the
-- API's cache_creation_input_tokens is; cache_write_1h_tokens is the part of it written to
-- the hour's cache, so the rest is the five-minute cache's.
alter table ai.requests
  add column cache_write_1h_tokens integer not null default 0
    constraint requests_cache_write_1h_nonnegative check (cache_write_1h_tokens >= 0),
  add constraint requests_cache_write_1h_within_writes
    check (cache_write_1h_tokens <= cache_write_tokens);

comment on column ai.requests.cache_write_1h_tokens is
  'Of cache_write_tokens, those written to the one-hour cache. The rest went to the five-minute cache.';

-- NULL: the agency has given no price for the one-hour cache, and the gateway never asks a
-- model without one for it. A row the agency entered before this migration is not given
-- one: it was entered for the five-minute cache, and an hour's price is the agency's to say.
alter table ai.model_prices
  add column cache_write_1h_per_mtok numeric(19, 6)
    constraint model_prices_cache_write_1h_nonnegative check (cache_write_1h_per_mtok >= 0);

comment on column ai.model_prices.cache_write_1h_per_mtok is
  'US dollars for a million tokens written to the one-hour cache. NULL: no price, so that cache is not used.';
