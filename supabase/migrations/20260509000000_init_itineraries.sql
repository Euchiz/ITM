-- Initial schema for Itinerary Studio.
--
-- Creates the `itineraries` table and a set of permissive RLS policies
-- intended for a single-user personal deployment. If your GitHub Pages
-- site is public, follow up with a stricter policy migration that
-- gates writes on a known `owner` value (see supabase/README.md).

create extension if not exists "pgcrypto";

create table if not exists public.itineraries (
  id          uuid primary key default gen_random_uuid(),
  owner       text,
  title       text not null,
  markdown    text not null,
  updated_at  timestamptz not null default now()
);

create index if not exists itineraries_owner_idx
  on public.itineraries (owner);

create index if not exists itineraries_updated_at_idx
  on public.itineraries (updated_at desc);

-- RLS on. The four policies below are wide open: anyone with the anon
-- key (which ships in the deployed page) can read, write, update, and
-- delete. Acceptable for a personal tool whose URL you don't share.
-- Replace with the owner-scoped block in supabase/README.md if you
-- want a tighter gate.
alter table public.itineraries enable row level security;

drop policy if exists "anon read"   on public.itineraries;
drop policy if exists "anon insert" on public.itineraries;
drop policy if exists "anon update" on public.itineraries;
drop policy if exists "anon delete" on public.itineraries;

create policy "anon read"   on public.itineraries for select using (true);
create policy "anon insert" on public.itineraries for insert with check (true);
create policy "anon update" on public.itineraries for update using (true) with check (true);
create policy "anon delete" on public.itineraries for delete using (true);
