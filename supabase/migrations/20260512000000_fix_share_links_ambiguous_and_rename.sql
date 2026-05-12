-- Two fixes wrapped into one migration:
--
--   1. list_share_links raised
--        "column reference 'role' is ambiguous"
--      on every call, so the Members → Share links section couldn't
--      load. Same shape as the list_trip_members bug fixed in
--      20260511000000_*. The function declares `role` as an OUT column
--      via RETURNS TABLE, and the authorization sub-select uses an
--      unqualified `role` against itinerary_members. plpgsql's default
--      variable-conflict mode is `error`, which rejects the unqualified
--      reference.
--
--      Fix: alias the table + qualify every column reference, and
--      add `#variable_conflict use_column` so future edits to the body
--      can't reintroduce the trap.
--
--   2. add_trip_member_by_email raised a user-visible error message
--      that still said "Trip Studio". Now that the product is named
--      Hermes Daybook, the message needs to follow. Re-creates the
--      function with the new copy; signature and behavior unchanged.


-- =========================================================
-- list_share_links — ambiguous-column fix
-- =========================================================

create or replace function public.list_share_links(p_trip_id uuid)
returns table (
  token       uuid,
  role        text,
  label       text,
  created_at  timestamptz
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

  if (select m.role from public.itinerary_members m
        where m.itinerary_id = p_trip_id and m.user_id = v_uid) <> 'owner' then
    raise exception 'only the trip owner can list share links' using errcode = '42501';
  end if;

  return query
    select s.token, s.role, s.label, s.created_at
      from public.share_links s
     where s.trip_id = p_trip_id
       and s.revoked_at is null
     order by s.created_at desc;
end;
$$;

grant execute on function public.list_share_links(uuid) to authenticated;


-- =========================================================
-- add_trip_member_by_email — user-visible string rename
-- =========================================================
-- Same signature + behaviour as 20260510060000_member_rpcs.sql; only
-- the "Trip Studio" → "Hermes Daybook" copy in the not-found error
-- message has changed.

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
    raise exception 'no Hermes Daybook account uses %. Ask them to sign up first.', p_email
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
