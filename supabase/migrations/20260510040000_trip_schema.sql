-- Trip-shaped schema. Replaces the markdown-document model with a
-- normalized Trip object: trip → days → items + per-day todos, plus
-- trip-level preparation checklist and notes.
--
-- The `itineraries` table is kept (renaming would churn RLS, RPCs, and
-- indexes) and conceptually treated as `trips`. Its `markdown` column
-- is dropped because we no longer store free-form markdown.
--
-- Membership stays in itinerary_members. The same RLS helpers
-- (is_member_of, role_in) gate all child tables.

-- =============================================================
-- itineraries: drop markdown, add trip metadata
-- =============================================================

alter table public.itineraries drop column if exists markdown;

alter table public.itineraries
  add column if not exists destination    text not null default '',
  add column if not exists start_date     date,
  add column if not exists end_date       date,
  add column if not exists summary        text not null default '',
  add column if not exists general_notes  text not null default '',
  add column if not exists travelers      text[] not null default '{}';

create index if not exists itineraries_dates_idx
  on public.itineraries (start_date, end_date);

-- =============================================================
-- days
-- =============================================================

create table if not exists public.days (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.itineraries(id) on delete cascade,
  date        date,
  title       text not null default '',
  city        text not null default '',
  notes       text not null default '',
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists days_trip_idx on public.days (trip_id, sort_order);

drop trigger if exists days_touch on public.days;
create trigger days_touch
  before update on public.days
  for each row execute function public.set_updated_at();

-- =============================================================
-- itinerary_items
-- =============================================================

create table if not exists public.itinerary_items (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.itineraries(id) on delete cascade,
  day_id         uuid not null references public.days(id) on delete cascade,
  title          text not null default '',
  type           text not null default 'activity'
                   check (type in ('activity','food','transport','lodging','shopping','rest','note')),
  start_time     time,
  end_time       time,
  location_name  text not null default '',
  map_url        text not null default '',
  notes          text not null default '',
  is_fixed       boolean not null default false,
  is_highlight   boolean not null default false,
  status         text not null default 'planned'
                   check (status in ('idea','planned','needs_booking','booked','done','cancelled')),
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists itinerary_items_day_idx  on public.itinerary_items (day_id, sort_order);
create index if not exists itinerary_items_trip_idx on public.itinerary_items (trip_id);

drop trigger if exists itinerary_items_touch on public.itinerary_items;
create trigger itinerary_items_touch
  before update on public.itinerary_items
  for each row execute function public.set_updated_at();

-- =============================================================
-- checklist_items
-- =============================================================
-- day_id NULL → preparation checklist (before-trip)
-- day_id set  → daily travel todo (during-trip)

create table if not exists public.checklist_items (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.itineraries(id) on delete cascade,
  day_id      uuid references public.days(id) on delete cascade,
  text        text not null default '',
  category    text not null default 'other'
                check (category in ('booking','document','packing','payment','transportation','health','other')),
  due_date    date,
  is_done     boolean not null default false,
  notes       text not null default '',
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists checklist_trip_prep_idx
  on public.checklist_items (trip_id) where day_id is null;
create index if not exists checklist_day_idx
  on public.checklist_items (day_id, sort_order);

drop trigger if exists checklist_items_touch on public.checklist_items;
create trigger checklist_items_touch
  before update on public.checklist_items
  for each row execute function public.set_updated_at();

-- =============================================================
-- notes
-- =============================================================

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.itineraries(id) on delete cascade,
  day_id      uuid references public.days(id) on delete cascade,
  title       text not null default '',
  body        text not null default '',
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists notes_trip_idx on public.notes (trip_id, sort_order);

drop trigger if exists notes_touch on public.notes;
create trigger notes_touch
  before update on public.notes
  for each row execute function public.set_updated_at();

-- =============================================================
-- RLS
-- =============================================================
-- Same pattern for every child table:
--   read     — must be a member of the trip
--   update   — owner/editor (USING gates; WITH CHECK relaxed because of
--              Supabase's auth.uid()-in-WITH-CHECK quirk, see migration
--              20260510030000)
--   delete   — owner/editor
--   insert   — owner/editor (allow direct insert; the WITH CHECK uses
--              role_in() which is SECURITY DEFINER and reads auth.uid()
--              correctly when invoked from a check expression)

alter table public.days             enable row level security;
alter table public.itinerary_items  enable row level security;
alter table public.checklist_items  enable row level security;
alter table public.notes            enable row level security;

-- ---------- days ----------
drop policy if exists "days member read"   on public.days;
drop policy if exists "days editor insert" on public.days;
drop policy if exists "days editor update" on public.days;
drop policy if exists "days editor delete" on public.days;

create policy "days member read" on public.days
  for select using (public.is_member_of(trip_id));

create policy "days editor insert" on public.days
  for insert with check (public.role_in(trip_id) in ('owner','editor'));

create policy "days editor update" on public.days
  for update using (public.role_in(trip_id) in ('owner','editor'))
             with check (true);

create policy "days editor delete" on public.days
  for delete using (public.role_in(trip_id) in ('owner','editor'));

-- ---------- itinerary_items ----------
drop policy if exists "items member read"   on public.itinerary_items;
drop policy if exists "items editor insert" on public.itinerary_items;
drop policy if exists "items editor update" on public.itinerary_items;
drop policy if exists "items editor delete" on public.itinerary_items;

create policy "items member read" on public.itinerary_items
  for select using (public.is_member_of(trip_id));

create policy "items editor insert" on public.itinerary_items
  for insert with check (public.role_in(trip_id) in ('owner','editor'));

create policy "items editor update" on public.itinerary_items
  for update using (public.role_in(trip_id) in ('owner','editor'))
             with check (true);

create policy "items editor delete" on public.itinerary_items
  for delete using (public.role_in(trip_id) in ('owner','editor'));

-- ---------- checklist_items ----------
drop policy if exists "checklist member read"   on public.checklist_items;
drop policy if exists "checklist editor insert" on public.checklist_items;
drop policy if exists "checklist editor update" on public.checklist_items;
drop policy if exists "checklist editor delete" on public.checklist_items;

create policy "checklist member read" on public.checklist_items
  for select using (public.is_member_of(trip_id));

create policy "checklist editor insert" on public.checklist_items
  for insert with check (public.role_in(trip_id) in ('owner','editor'));

create policy "checklist editor update" on public.checklist_items
  for update using (public.role_in(trip_id) in ('owner','editor'))
             with check (true);

create policy "checklist editor delete" on public.checklist_items
  for delete using (public.role_in(trip_id) in ('owner','editor'));

-- ---------- notes ----------
drop policy if exists "notes member read"   on public.notes;
drop policy if exists "notes editor insert" on public.notes;
drop policy if exists "notes editor update" on public.notes;
drop policy if exists "notes editor delete" on public.notes;

create policy "notes member read" on public.notes
  for select using (public.is_member_of(trip_id));

create policy "notes editor insert" on public.notes
  for insert with check (public.role_in(trip_id) in ('owner','editor'));

create policy "notes editor update" on public.notes
  for update using (public.role_in(trip_id) in ('owner','editor'))
             with check (true);

create policy "notes editor delete" on public.notes
  for delete using (public.role_in(trip_id) in ('owner','editor'));
