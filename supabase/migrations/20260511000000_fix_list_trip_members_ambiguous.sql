-- Fix: list_trip_members raised
--   "column reference 'user_id' is ambiguous"
-- on every call, so the Members page could not load.
--
-- The function declares an OUT column named user_id and also queries
-- itinerary_members (which has a user_id column) using an unqualified
-- `user_id = v_uid` in the membership-guard sub-select. plpgsql's
-- default variable-conflict mode is `error`, which refuses any
-- unqualified reference that could resolve to either the OUT param or
-- a column.
--
-- Fix: alias the table and qualify every column reference. While we're
-- in here we also add `#variable_conflict use_column` so future tweaks
-- to the body can't reintroduce the same trap.

create or replace function public.list_trip_members(p_trip_id uuid)
returns table (
  user_id      uuid,
  email        text,
  display_name text,
  role         text,
  added_at     timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.itinerary_members im
     where im.itinerary_id = p_trip_id
       and im.user_id      = v_uid
  ) then
    raise exception 'not a member of this trip' using errcode = '42501';
  end if;

  return query
    select m.user_id, p.email, p.display_name, m.role, m.added_at
      from public.itinerary_members m
      left join public.profiles p on p.id = m.user_id
     where m.itinerary_id = p_trip_id
     order by (m.role = 'owner') desc, m.added_at asc;
end;
$$;

grant execute on function public.list_trip_members(uuid) to authenticated;
