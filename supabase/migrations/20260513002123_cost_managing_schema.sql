-- Cost managing system — schema foundation.
--
-- See .scratch/cost-managing-system/PRD.md for the full design and
-- .scratch/cost-managing-system/issues/01-migration-schema.md for this slice.
--
-- Adds:
--   * itineraries.default_currency  (text)
--   * itineraries.budget_target_cents (bigint, nullable)
--   * itinerary_items: six cost columns (proposed/actual amounts, tag,
--     currency override, paid_by, is_unplanned)
--   * item_cost_shares table (per-traveler share breakdown; rows only
--     materialize for unequal custom splits — default-even is implicit)
--
-- Tag transitions and split sum-validation are handled JS-side. The DB
-- stores raw values + a CHECK constraint on cost_tag's enum membership.


-- =========================================================
-- itineraries — trip-level cost knobs
-- =========================================================

alter table public.itineraries
  add column if not exists default_currency    text   not null default 'USD',
  add column if not exists budget_target_cents bigint;


-- =========================================================
-- itinerary_items — per-event cost data
-- =========================================================
-- cost_tag NULL means "user hasn't considered this item's cost yet"
-- (distinct from 'n_a' which means "user decided it's free"). The
-- Budget Edit "unassigned only" filter shows items where cost_tag IS
-- NULL.
--
-- currency NULL means "inherit trip default". The vast majority of
-- items stay NULL; only multi-country trips override.

alter table public.itinerary_items
  add column if not exists proposed_cost_cents bigint,
  add column if not exists actual_cost_cents   bigint,
  add column if not exists cost_tag            text,
  add column if not exists currency            text,
  add column if not exists paid_by             uuid references auth.users on delete set null,
  add column if not exists is_unplanned        boolean not null default false;

-- Add the CHECK separately so the alter remains idempotent against an
-- already-applied migration. CHECK constraints can't be added with
-- IF NOT EXISTS, so guard via the catalog.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'itinerary_items_cost_tag_check'
  ) then
    alter table public.itinerary_items
      add constraint itinerary_items_cost_tag_check
      check (cost_tag is null or cost_tag in ('n_a','guessing','approx','actual'));
  end if;
end$$;


-- =========================================================
-- item_cost_shares — per-traveler split rows
-- =========================================================
-- Empty by default. Rows only exist for unequal custom splits; the
-- default-even case is computed at view time as item amount / member
-- count. Both proposed and actual share amounts are nullable so a row
-- can carry just one (e.g. before actuals are logged).
--
-- Unique (item_id, user_id) — at most one share row per traveler per
-- item. paid_by lives on the item, not the share, so this table stays
-- focused on "who owes what."

create table if not exists public.item_cost_shares (
  id                    uuid primary key default gen_random_uuid(),
  item_id               uuid not null references public.itinerary_items on delete cascade,
  user_id               uuid not null references auth.users             on delete cascade,
  proposed_amount_cents bigint,
  actual_amount_cents   bigint,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (item_id, user_id)
);

create index if not exists item_cost_shares_item_id_idx on public.item_cost_shares (item_id);
create index if not exists item_cost_shares_user_id_idx on public.item_cost_shares (user_id);

drop trigger if exists item_cost_shares_set_updated_at on public.item_cost_shares;
create trigger item_cost_shares_set_updated_at
  before update on public.item_cost_shares
  for each row execute function public.set_updated_at();


-- =========================================================
-- RLS for item_cost_shares
-- =========================================================
-- Visible iff the caller can see the parent item's trip.
-- Mutable iff the caller is owner/editor on that trip. We reach
-- itinerary_items.trip_id through a one-row exists() subquery; the
-- same pattern checklist_items / notes use.

alter table public.item_cost_shares enable row level security;

drop policy if exists "item_cost_shares read"  on public.item_cost_shares;
drop policy if exists "item_cost_shares write" on public.item_cost_shares;

create policy "item_cost_shares read" on public.item_cost_shares
  for select
  using (
    exists (
      select 1
        from public.itinerary_items i
       where i.id = item_cost_shares.item_id
         and public.is_member_of(i.trip_id)
    )
  );

create policy "item_cost_shares write" on public.item_cost_shares
  for all
  using (
    exists (
      select 1
        from public.itinerary_items i
       where i.id = item_cost_shares.item_id
         and public.role_in(i.trip_id) in ('owner','editor')
    )
  )
  with check (
    exists (
      select 1
        from public.itinerary_items i
       where i.id = item_cost_shares.item_id
         and public.role_in(i.trip_id) in ('owner','editor')
    )
  );
