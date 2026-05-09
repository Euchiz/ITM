-- Initial schema for Itinerary Studio (multi-user).
--
-- Model:
--   profiles            — one row per signed-in user, public display info
--   itineraries         — one row per trip; access is NOT determined by created_by
--   itinerary_members   — many-to-many gating access; row's role drives RLS
--
-- A trip is "personal" when it has exactly one member (the creator, role=owner).
-- A trip becomes "shared" when the owner adds more members.

create extension if not exists "pgcrypto";

-- =============================================================
-- profiles
-- =============================================================

create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  email         text unique,
  display_name  text,
  created_at    timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================
-- itineraries
-- =============================================================

create table if not exists public.itineraries (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'Untitled itinerary',
  markdown    text not null default '',
  created_by  uuid not null references auth.users on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists itineraries_created_by_idx
  on public.itineraries (created_by);
create index if not exists itineraries_updated_at_idx
  on public.itineraries (updated_at desc);

-- Refresh updated_at on every UPDATE.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists itineraries_touch on public.itineraries;
create trigger itineraries_touch
  before update on public.itineraries
  for each row execute function public.set_updated_at();

-- =============================================================
-- itinerary_members
-- =============================================================

create table if not exists public.itinerary_members (
  itinerary_id  uuid not null references public.itineraries on delete cascade,
  user_id       uuid not null references auth.users on delete cascade,
  role          text not null default 'editor'
                  check (role in ('owner','editor','viewer')),
  added_at      timestamptz not null default now(),
  primary key (itinerary_id, user_id)
);

create index if not exists itinerary_members_user_idx
  on public.itinerary_members (user_id);

-- When a new itinerary is created, immediately add the creator as owner.
-- security definer so this insert bypasses RLS on itinerary_members.
create or replace function public.handle_itinerary_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.itinerary_members (itinerary_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

drop trigger if exists itineraries_after_insert on public.itineraries;
create trigger itineraries_after_insert
  after insert on public.itineraries
  for each row execute function public.handle_itinerary_insert();

-- =============================================================
-- helper functions for RLS
-- =============================================================
-- security definer bypasses RLS so the membership lookup itself doesn't
-- recurse through the policies on itinerary_members.

create or replace function public.is_member_of(itin uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.itinerary_members
    where itinerary_id = itin and user_id = auth.uid()
  );
$$;

create or replace function public.role_in(itin uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role
    from public.itinerary_members
   where itinerary_id = itin and user_id = auth.uid()
   limit 1;
$$;

-- =============================================================
-- RLS
-- =============================================================

alter table public.profiles          enable row level security;
alter table public.itineraries       enable row level security;
alter table public.itinerary_members enable row level security;

-- profiles: world-readable for member-list display; users edit only their own row.
drop policy if exists "profiles read"        on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
create policy "profiles read" on public.profiles
  for select using (true);
create policy "profiles self update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- itineraries:
--   read    — must be a member
--   insert  — any authenticated user, must mark themselves as creator
--   update  — owner or editor
--   delete  — owner only
drop policy if exists "itineraries member read"   on public.itineraries;
drop policy if exists "itineraries auth insert"   on public.itineraries;
drop policy if exists "itineraries member update" on public.itineraries;
drop policy if exists "itineraries owner delete"  on public.itineraries;

create policy "itineraries member read" on public.itineraries
  for select using (public.is_member_of(id));

create policy "itineraries auth insert" on public.itineraries
  for insert with check (auth.uid() is not null and auth.uid() = created_by);

create policy "itineraries member update" on public.itineraries
  for update using (public.role_in(id) in ('owner','editor'))
             with check (public.role_in(id) in ('owner','editor'));

create policy "itineraries owner delete" on public.itineraries
  for delete using (public.role_in(id) = 'owner');

-- itinerary_members:
--   read    — must be a member of the same itinerary
--   insert  — only owner of that itinerary (the trigger that adds the
--             creator runs as security definer, so it bypasses this)
--   update  — only owner
--   delete  — owner OR the row's own user (lets a member leave)
drop policy if exists "members read"                  on public.itinerary_members;
drop policy if exists "members owner insert"          on public.itinerary_members;
drop policy if exists "members owner update"          on public.itinerary_members;
drop policy if exists "members owner delete or leave" on public.itinerary_members;

create policy "members read" on public.itinerary_members
  for select using (public.is_member_of(itinerary_id));

create policy "members owner insert" on public.itinerary_members
  for insert with check (public.role_in(itinerary_id) = 'owner');

create policy "members owner update" on public.itinerary_members
  for update using (public.role_in(itinerary_id) = 'owner')
             with check (public.role_in(itinerary_id) = 'owner');

create policy "members owner delete or leave" on public.itinerary_members
  for delete using (
        user_id = auth.uid()
     or public.role_in(itinerary_id) = 'owner'
  );
