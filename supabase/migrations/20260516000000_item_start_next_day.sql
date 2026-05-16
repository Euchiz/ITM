-- Add `start_next_day` flag for itinerary items.
--
-- Lets a user attach late-night activities to their "logical" day card
-- even when the clock has passed midnight. Example: arriving in Tokyo
-- and having a 02:00 ramen run. The user thinks of it as part of the
-- arrival day's plan, not the morning of the next calendar day.
--
-- Semantics:
--   start_next_day = false  →  start_time / end_time refer to today's
--                              clock. (Existing convention; end < start
--                              still means the event wraps midnight into
--                              the next morning.)
--   start_next_day = true   →  both start_time and end_time refer to
--                              the next calendar day's clock. Overlap
--                              math should add 1440 minutes when
--                              comparing against same-day items.
--
-- Defaults to false so existing rows behave exactly as before.

alter table public.itinerary_items
  add column if not exists start_next_day boolean not null default false;
