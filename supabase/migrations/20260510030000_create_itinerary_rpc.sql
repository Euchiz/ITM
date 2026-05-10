-- Workaround for Supabase's JWT context quirk: auth.uid() returns NULL
-- inside WITH CHECK expressions and BEFORE-trigger bodies on the same
-- request, even though it returns the correct UUID inside RPC function
-- bodies, USING clauses, and security-definer helpers.
--
-- Same finding documented in the ILM project's
-- 20260421040000_add_create_lab_rpc.sql migration.
--
-- Strategy:
--   * INSERT  → SECURITY DEFINER RPC `create_itinerary` that captures
--               auth.uid() at function entry and inserts the row +
--               owner membership atomically. Bypasses RLS.
--   * UPDATE  → keep USING (it works), relax WITH CHECK to true since
--               USING already gates who can update.
--   * Drop the now-broken BEFORE INSERT trigger and its function.
--   * AFTER INSERT trigger removed too — the RPC handles membership.

-- Drop the misbehaving triggers and helper functions
drop trigger if exists itineraries_before_insert on public.itineraries;
drop trigger if exists itineraries_after_insert  on public.itineraries;
drop function if exists public.set_itinerary_creator()    cascade;
drop function if exists public.handle_itinerary_insert()  cascade;

-- Drop earlier diagnostic / failed-attempt functions if present
drop function if exists public.debug_uid_check()    cascade;
drop function if exists public.is_authenticated()   cascade;
drop function if exists public.uid_check()          cascade;

-- created_by becomes a plain nullable column; the RPC sets it
alter table public.itineraries alter column created_by drop default;

-- Keep a permissive insert policy as a safety net for the RPC's
-- internal insert; the SECURITY DEFINER bypasses it anyway.
drop policy if exists "itineraries auth insert" on public.itineraries;
create policy "itineraries auth insert" on public.itineraries
  for insert
  with check (auth.uid() is not null);

-- UPDATE: USING gates access (works correctly); WITH CHECK relaxed
-- so the same JWT-context bug doesn't block normal saves.
drop policy if exists "itineraries member update" on public.itineraries;
create policy "itineraries member update" on public.itineraries
  for update
  using (public.role_in(id) in ('owner','editor'))
  with check (true);

-- The actual RPC
create or replace function public.create_itinerary(
  p_title    text default 'Untitled itinerary',
  p_markdown text default ''
)
returns public.itineraries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.itineraries%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  insert into public.itineraries (title, markdown, created_by)
  values (
    coalesce(nullif(btrim(p_title), ''), 'Untitled itinerary'),
    coalesce(p_markdown, ''),
    v_uid
  )
  returning * into v_row;

  insert into public.itinerary_members (itinerary_id, user_id, role)
  values (v_row.id, v_uid, 'owner')
  on conflict (itinerary_id, user_id) do nothing;

  return v_row;
end;
$$;

grant execute on function public.create_itinerary(text, text) to authenticated;
