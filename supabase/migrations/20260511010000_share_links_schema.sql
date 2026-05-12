-- Share-link sharing — schema half.
--
-- Adds the surface that lets a trip owner mint shareable links and have
-- anyone who clicks become a member (anonymously if not signed in, or
-- under their real account if already signed in). The RPCs that drive
-- this surface live in the next migration; this file is just the tables,
-- columns, triggers, and RLS shape they assume.
--
-- Three additions:
--
--   1. share_links — one row per shareable URL. Token is the credential
--      embedded in the link. Multiple links per trip; owner labels and
--      revokes them individually.
--
--   2. itinerary_members.joined_via_link — nullable FK to share_links.
--      Lets revoke_share_link cascade-delete only the rows that came
--      through that link, leaving direct adds and the original owner
--      untouched.
--
--   3. created_by on every child table (days, itinerary_items,
--      checklist_items, notes) + a BEFORE INSERT trigger forcing it
--      to auth.uid(). Powers the "added by Alice 2d ago" attribution
--      line in the item detail views. Existing rows backfill to NULL
--      and the UI treats NULL as "unknown author".


-- =========================================================
-- share_links
-- =========================================================

create table if not exists public.share_links (
  token       uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.itineraries(id) on delete cascade,
  role        text not null check (role in ('editor','viewer')),
  created_by  uuid not null references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  label       text
);

-- Owner-side lookup ("which links are live for this trip?") is the hot
-- path; index only the live rows so the index stays small even if the
-- owner rotates links frequently.
create index if not exists share_links_trip_active_idx
  on public.share_links (trip_id, role)
  where revoked_at is null;

-- The "default link for (trip, role)" lookup that the header Share
-- dialog uses needs to find the most recent unrevoked NULL-label row.
-- An index on (trip_id, role, created_at desc) where revoked_at is null
-- and label is null serves that exactly.
create index if not exists share_links_default_idx
  on public.share_links (trip_id, role, created_at desc)
  where revoked_at is null and label is null;


-- =========================================================
-- itinerary_members.joined_via_link
-- =========================================================
-- Nullable. Direct adds (the owner's auto-membership, the email-invite
-- RPC) leave this NULL. Redemptions through share_links populate it,
-- enabling targeted cascade in revoke_share_link.

alter table public.itinerary_members
  add column if not exists joined_via_link uuid references public.share_links(token) on delete set null;


-- =========================================================
-- created_by on child tables
-- =========================================================
-- Adds an attribution column to every child of itineraries. The
-- BEFORE INSERT trigger force-sets it to auth.uid() so the client
-- can't lie about authorship, mirroring the pattern in
-- 20260510020000_fix_insert_path.sql for itineraries themselves.

alter table public.days            add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.itinerary_items add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.checklist_items add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.notes           add column if not exists created_by uuid references auth.users(id) on delete set null;

create or replace function public.set_row_creator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists days_before_insert            on public.days;
drop trigger if exists itinerary_items_before_insert on public.itinerary_items;
drop trigger if exists checklist_items_before_insert on public.checklist_items;
drop trigger if exists notes_before_insert           on public.notes;

create trigger days_before_insert
  before insert on public.days
  for each row execute function public.set_row_creator();

create trigger itinerary_items_before_insert
  before insert on public.itinerary_items
  for each row execute function public.set_row_creator();

create trigger checklist_items_before_insert
  before insert on public.checklist_items
  for each row execute function public.set_row_creator();

create trigger notes_before_insert
  before insert on public.notes
  for each row execute function public.set_row_creator();


-- =========================================================
-- RLS for share_links
-- =========================================================
-- All mutations go through SECURITY DEFINER RPCs (mint / rotate /
-- revoke), so this table doesn't need insert / update / delete
-- policies — clients can't write to it directly. The only direct
-- access we expose is SELECT for the trip owner, so the Members
-- page can render the list of active links.
--
-- Anonymous landing-screen previews go through peek_share_link, which
-- is SECURITY DEFINER and reads share_links itself; the anon role
-- never touches the table directly.

alter table public.share_links enable row level security;

drop policy if exists "share_links owner select" on public.share_links;

create policy "share_links owner select" on public.share_links
  for select
  to authenticated
  using (
    exists (
      select 1 from public.itinerary_members
       where itinerary_id = share_links.trip_id
         and user_id = auth.uid()
         and role = 'owner'
    )
  );


-- =========================================================
-- Random nickname helper for anonymous guests
-- =========================================================
-- When a guest joins without filling the optional name field, we still
-- want them to be recognisable in the roster. random_nickname() returns
-- an adjective-animal combo from a small inline wordlist. The redeem
-- RPC calls this at most once per anon UID (only if profiles.display_name
-- is NULL), so the name sticks — refreshing the page won't reshuffle it.

create or replace function public.random_nickname()
returns text
language sql
volatile
as $$
  with
    adjectives(w) as (values
      ('Quiet'),('Wandering'),('Curious'),('Gentle'),('Brave'),
      ('Bright'),('Calm'),('Daring'),('Eager'),('Friendly'),
      ('Graceful'),('Happy'),('Lively'),('Merry'),('Nimble'),
      ('Playful'),('Sunny'),('Swift'),('Tidy'),('Witty'),
      ('Jolly'),('Kind'),('Lucky'),('Mellow'),('Patient'),
      ('Spirited'),('Sleepy'),('Snug'),('Cheerful'),('Bold')
    ),
    animals(w) as (values
      ('Otter'),('Tapir'),('Fox'),('Heron'),('Lynx'),
      ('Badger'),('Crane'),('Marten'),('Quokka'),('Puffin'),
      ('Capybara'),('Salamander'),('Hedgehog'),('Stoat'),('Falcon'),
      ('Owl'),('Cygnet'),('Wren'),('Dormouse'),('Pangolin'),
      ('Wombat'),('Mongoose'),('Ibex'),('Tanager'),('Kestrel'),
      ('Lemur'),('Civet'),('Numbat'),('Gecko'),('Plover'),
      ('Possum'),('Antelope'),('Beaver'),('Caribou'),('Donkey'),
      ('Echidna'),('Ferret'),('Gibbon'),('Hare'),('Iguana'),
      ('Jackal'),('Koala'),('Llama'),('Marmot'),('Newt'),
      ('Octopus'),('Penguin'),('Raccoon'),('Skunk'),('Toucan')
    )
  select
    (select w from adjectives order by random() limit 1)
    || ' ' ||
    (select w from animals    order by random() limit 1);
$$;

grant execute on function public.random_nickname() to anon, authenticated;
