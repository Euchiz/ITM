-- Reliable insert path for itineraries.
--
-- The earlier approach used `default auth.uid()` on created_by + a
-- compound RLS check `auth.uid() = created_by`. In practice this
-- combination misbehaved on this project (RLS rejected even when the
-- conditions logically held). Replace it with:
--
--   1. A BEFORE INSERT trigger that forces created_by = auth.uid()
--      regardless of what the client sends.
--   2. A simple INSERT policy that only requires the caller to be
--      authenticated. Membership creation in the AFTER trigger then
--      uses the (now guaranteed-correct) created_by.
--
-- This also closes a small spoofing window where a user could insert
-- with someone else's created_by; the BEFORE trigger overwrites it.

-- =========================================================
-- Drop any leftover diagnostic / wide-open policies
-- =========================================================
drop policy if exists "wideopen all"            on public.itineraries;
drop policy if exists "itineraries auth insert" on public.itineraries;

-- =========================================================
-- Replace the column default with a BEFORE INSERT trigger
-- =========================================================
alter table public.itineraries
  alter column created_by drop default;

create or replace function public.set_itinerary_creator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Hard-set the caller as creator. If the request is anonymous
  -- (auth.uid() is null) the row's created_by stays whatever the
  -- client sent — but the insert policy below will reject anyway.
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists itineraries_before_insert on public.itineraries;
create trigger itineraries_before_insert
  before insert on public.itineraries
  for each row execute function public.set_itinerary_creator();

-- =========================================================
-- Reinstate the four member-based policies, simplified
-- =========================================================
create policy "itineraries member read" on public.itineraries
  for select
  to authenticated
  using (public.is_member_of(id));

create policy "itineraries auth insert" on public.itineraries
  for insert
  to authenticated
  with check (auth.uid() is not null);

create policy "itineraries member update" on public.itineraries
  for update
  to authenticated
  using      (public.role_in(id) in ('owner','editor'))
  with check (public.role_in(id) in ('owner','editor'));

create policy "itineraries owner delete" on public.itineraries
  for delete
  to authenticated
  using (public.role_in(id) = 'owner');
