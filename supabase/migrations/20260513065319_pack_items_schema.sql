-- Mobile redesign · Pack feature schema.
--
-- See .scratch/mobile-redesign/PRD.md and
-- .scratch/mobile-redesign/issues/01-pack-schema.md.
--
-- Adds:
--   * trip_pack_items — trip-wide checklist of physical items the user
--     wants to bring (passport, adapter, business cards). Title +
--     packed boolean + sort_order.
--   * item_pack_items — optional link table tagging pack items to
--     specific events, used by the mobile Today view's reminder box
--     ("you have these tagged for today's events — are they packed?")
--
-- Both tables inherit RLS via the parent trip (visible to all members,
-- mutable by editors+).


-- =========================================================
-- trip_pack_items
-- =========================================================

create table if not exists public.trip_pack_items (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.itineraries on delete cascade,
  title       text not null,
  packed      boolean not null default false,
  sort_order  int not null default 0,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists trip_pack_items_trip_idx
  on public.trip_pack_items (trip_id, sort_order);

drop trigger if exists trip_pack_items_set_updated_at on public.trip_pack_items;
create trigger trip_pack_items_set_updated_at
  before update on public.trip_pack_items
  for each row execute function public.set_updated_at();

-- Reuse the set_row_creator() trigger from share_links_schema migration
-- so created_by is forced to auth.uid() at INSERT time. This sidesteps
-- the PostgREST auth.uid()-in-WITH-CHECK quirk.
drop trigger if exists trip_pack_items_before_insert on public.trip_pack_items;
create trigger trip_pack_items_before_insert
  before insert on public.trip_pack_items
  for each row execute function public.set_row_creator();


-- =========================================================
-- item_pack_items — optional link table
-- =========================================================
-- Rows only materialize when a user explicitly tags a pack item to an
-- event. Most users will never tag anything; the trip-wide checklist
-- works fine without. Tagging powers the mobile Today reminder.

create table if not exists public.item_pack_items (
  item_id      uuid references public.itinerary_items on delete cascade,
  pack_item_id uuid references public.trip_pack_items on delete cascade,
  primary key (item_id, pack_item_id)
);

create index if not exists item_pack_items_pack_idx
  on public.item_pack_items (pack_item_id);


-- =========================================================
-- RLS
-- =========================================================

alter table public.trip_pack_items enable row level security;
alter table public.item_pack_items enable row level security;

drop policy if exists "trip_pack_items read"  on public.trip_pack_items;
drop policy if exists "trip_pack_items write" on public.trip_pack_items;

create policy "trip_pack_items read" on public.trip_pack_items
  for select using (public.is_member_of(trip_id));

create policy "trip_pack_items write" on public.trip_pack_items
  for all
  using (public.role_in(trip_id) in ('owner','editor'))
  with check (public.role_in(trip_id) in ('owner','editor'));


drop policy if exists "item_pack_items read"  on public.item_pack_items;
drop policy if exists "item_pack_items write" on public.item_pack_items;

create policy "item_pack_items read" on public.item_pack_items
  for select
  using (
    exists (
      select 1
        from public.itinerary_items i
       where i.id = item_pack_items.item_id
         and public.is_member_of(i.trip_id)
    )
  );

create policy "item_pack_items write" on public.item_pack_items
  for all
  using (
    exists (
      select 1
        from public.itinerary_items i
       where i.id = item_pack_items.item_id
         and public.role_in(i.trip_id) in ('owner','editor')
    )
  )
  with check (
    exists (
      select 1
        from public.itinerary_items i
       where i.id = item_pack_items.item_id
         and public.role_in(i.trip_id) in ('owner','editor')
    )
  );
