-- Member-management RPCs.
--
-- The trip view exposes a Members page where the owner can add/remove
-- collaborators by email and adjust their role. We could in principle do
-- this with direct INSERT/UPDATE/DELETE on itinerary_members under RLS,
-- but the same auth.uid() / WITH CHECK quirk that bit create_trip means
-- that going through SECURITY DEFINER RPCs is more reliable. They also
-- give us a single place to enforce "owner can't demote themselves into
-- being not-the-owner of an ownerless trip" and "can't remove the last
-- owner" rules.

-- =============================================================
-- list_trip_members(p_trip_id) → table of (user_id, email, display_name, role, added_at)
-- =============================================================
-- Joins itinerary_members + profiles so the UI can render names and
-- emails without making a second round trip. SECURITY DEFINER lets us
-- read profiles for fellow members without each profile needing its
-- own RLS pass; the function gates membership itself.

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
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.itinerary_members
     where itinerary_id = p_trip_id and user_id = v_uid
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

-- =============================================================
-- add_trip_member_by_email(p_trip_id, p_email, p_role) → uuid (added user_id)
-- =============================================================
-- Owner-only. Looks the email up in profiles; if the person hasn't
-- signed in yet there is no row to add, and we raise a friendly error
-- the UI can show. (No invite-by-email flow yet — keeping scope tight.)

create or replace function public.add_trip_member_by_email(
  p_trip_id uuid,
  p_email   text,
  p_role    text default 'editor'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text := lower(btrim(p_email));
  v_target uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_role not in ('owner','editor','viewer') then
    raise exception 'role must be owner, editor, or viewer' using errcode = '22023';
  end if;

  if v_email is null or v_email = '' then
    raise exception 'email is required' using errcode = '22023';
  end if;

  if (select role from public.itinerary_members
        where itinerary_id = p_trip_id and user_id = v_uid) <> 'owner' then
    raise exception 'only the trip owner can add members' using errcode = '42501';
  end if;

  select id into v_target from public.profiles where lower(email) = v_email;
  if v_target is null then
    raise exception 'no Trip Studio account uses %. Ask them to sign up first.', p_email
      using errcode = 'P0002';
  end if;

  insert into public.itinerary_members (itinerary_id, user_id, role)
  values (p_trip_id, v_target, p_role)
  on conflict (itinerary_id, user_id) do update
    set role = excluded.role;

  return v_target;
end;
$$;

grant execute on function public.add_trip_member_by_email(uuid, text, text) to authenticated;

-- =============================================================
-- update_trip_member_role(p_trip_id, p_user_id, p_role) → void
-- =============================================================
-- Owner-only. Refuses to demote the last remaining owner (which would
-- leave the trip with no one able to manage membership).

create or replace function public.update_trip_member_role(
  p_trip_id uuid,
  p_user_id uuid,
  p_role    text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_other_owners int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_role not in ('owner','editor','viewer') then
    raise exception 'role must be owner, editor, or viewer' using errcode = '22023';
  end if;

  if (select role from public.itinerary_members
        where itinerary_id = p_trip_id and user_id = v_uid) <> 'owner' then
    raise exception 'only the trip owner can change roles' using errcode = '42501';
  end if;

  if p_role <> 'owner' then
    select count(*) into v_other_owners
      from public.itinerary_members
     where itinerary_id = p_trip_id
       and role = 'owner'
       and user_id <> p_user_id;
    if v_other_owners = 0 then
      raise exception 'cannot demote the last owner — promote someone else first'
        using errcode = '23514';
    end if;
  end if;

  update public.itinerary_members
     set role = p_role
   where itinerary_id = p_trip_id
     and user_id = p_user_id;
end;
$$;

grant execute on function public.update_trip_member_role(uuid, uuid, text) to authenticated;

-- =============================================================
-- remove_trip_member(p_trip_id, p_user_id) → void
-- =============================================================
-- Owner can remove anyone except the last owner. A non-owner can only
-- remove themselves (i.e. leave the trip).

create or replace function public.remove_trip_member(
  p_trip_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_caller_role  text;
  v_target_role  text;
  v_other_owners int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select role into v_caller_role
    from public.itinerary_members
   where itinerary_id = p_trip_id and user_id = v_uid;

  if v_caller_role is null then
    raise exception 'not a member of this trip' using errcode = '42501';
  end if;

  if v_caller_role <> 'owner' and p_user_id <> v_uid then
    raise exception 'only the owner can remove other members' using errcode = '42501';
  end if;

  select role into v_target_role
    from public.itinerary_members
   where itinerary_id = p_trip_id and user_id = p_user_id;

  if v_target_role = 'owner' then
    select count(*) into v_other_owners
      from public.itinerary_members
     where itinerary_id = p_trip_id
       and role = 'owner'
       and user_id <> p_user_id;
    if v_other_owners = 0 then
      raise exception 'cannot remove the last owner — promote someone else first'
        using errcode = '23514';
    end if;
  end if;

  delete from public.itinerary_members
   where itinerary_id = p_trip_id and user_id = p_user_id;
end;
$$;

grant execute on function public.remove_trip_member(uuid, uuid) to authenticated;
