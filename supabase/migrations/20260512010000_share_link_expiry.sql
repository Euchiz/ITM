-- Per-link expiration.
--
-- Adds an optional expires_at timestamp on share_links so owners can
-- mint time-limited links ("good for one week"). Backward-compatible:
-- existing links have expires_at = NULL and behave exactly as before
-- (no expiry, manual revoke only).
--
-- All four affected RPCs are updated:
--
--   peek_share_link     — adds an `expired` boolean column so the
--                          landing screen can show "This link has
--                          expired" instead of letting the visitor
--                          go through the join flow.
--   redeem_share_link   — refuses to redeem an expired token.
--   mint_share_link     — accepts an optional p_expires_at parameter.
--   list_share_links    — returns expires_at so the Members page can
--                          show it.
--
-- rotate_share_link and default_share_link don't need expiry awareness
-- (rotate always mints with NULL expiry; default lookup intentionally
-- ignores it so a stale unexpired default link can still be reused).


-- =========================================================
-- Column
-- =========================================================

alter table public.share_links
  add column if not exists expires_at timestamptz;


-- =========================================================
-- peek_share_link — exposes expired-ness to the landing screen
-- =========================================================

create or replace function public.peek_share_link(p_token uuid)
returns table (
  trip_title         text,
  destination        text,
  start_date         date,
  end_date           date,
  owner_display_name text,
  role               text,
  revoked            boolean,
  expired            boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select i.title,
         i.destination,
         i.start_date,
         i.end_date,
         p.display_name,
         s.role,
         (s.revoked_at is not null) as revoked,
         (s.expires_at is not null and s.expires_at < now()) as expired
    from public.share_links s
    join public.itineraries i on i.id = s.trip_id
    left join lateral (
      select user_id
        from public.itinerary_members
       where itinerary_id = i.id and role = 'owner'
       order by added_at asc
       limit 1
    ) o on true
    left join public.profiles p on p.id = o.user_id
   where s.token = p_token
   limit 1;
$$;

grant execute on function public.peek_share_link(uuid) to anon, authenticated;


-- =========================================================
-- redeem_share_link — refuses expired tokens
-- =========================================================

create or replace function public.redeem_share_link(
  p_token        uuid,
  p_display_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_is_anon     boolean;
  v_trip_id     uuid;
  v_link_role   text;
  v_revoked     timestamptz;
  v_expires     timestamptz;
  v_existing    text;
  v_proposed    text;
  v_current_dn  text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select trip_id, role, revoked_at, expires_at
    into v_trip_id, v_link_role, v_revoked, v_expires
    from public.share_links
   where token = p_token
   for share;

  if v_trip_id is null then
    raise exception 'share link not found' using errcode = 'P0002';
  end if;

  if v_revoked is not null then
    raise exception 'share link has been revoked' using errcode = '42501';
  end if;

  if v_expires is not null and v_expires < now() then
    raise exception 'share link has expired' using errcode = '42501';
  end if;

  select role into v_existing
    from public.itinerary_members
   where itinerary_id = v_trip_id and user_id = v_uid;

  v_proposed := v_link_role;

  if v_existing is not null then
    if v_existing = 'owner' then
      return v_trip_id;
    end if;
    if v_existing = 'editor' and v_proposed = 'viewer' then
      return v_trip_id;
    end if;
  end if;

  insert into public.itinerary_members (itinerary_id, user_id, role, joined_via_link)
  values (v_trip_id, v_uid, v_proposed, p_token)
  on conflict (itinerary_id, user_id) do update
    set role            = excluded.role,
        joined_via_link = excluded.joined_via_link;

  select is_anonymous into v_is_anon from auth.users where id = v_uid;

  if v_is_anon then
    select display_name into v_current_dn from public.profiles where id = v_uid;
    if v_current_dn is null or v_current_dn = '' then
      update public.profiles
         set display_name = coalesce(nullif(btrim(p_display_name), ''),
                                     public.random_nickname())
       where id = v_uid;
    end if;
  end if;

  return v_trip_id;
end;
$$;

grant execute on function public.redeem_share_link(uuid, text) to authenticated;


-- =========================================================
-- mint_share_link — accepts optional expires_at
-- =========================================================

create or replace function public.mint_share_link(
  p_trip_id    uuid,
  p_role       text,
  p_label      text default null,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_token uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_role not in ('editor','viewer') then
    raise exception 'role must be editor or viewer' using errcode = '22023';
  end if;

  if (select role from public.itinerary_members
        where itinerary_id = p_trip_id and user_id = v_uid) <> 'owner' then
    raise exception 'only the trip owner can create share links' using errcode = '42501';
  end if;

  insert into public.share_links (trip_id, role, created_by, label, expires_at)
  values (p_trip_id, p_role, v_uid, nullif(btrim(p_label), ''), p_expires_at)
  returning token into v_token;

  return v_token;
end;
$$;

-- Drop the old 3-arg form so callers don't keep using the un-expiring
-- shape silently. The new 4-arg form has the same first three args, so
-- existing callers that don't pass p_expires_at get NULL (no expiry) —
-- semantically identical to before.
drop function if exists public.mint_share_link(uuid, text, text);
grant execute on function public.mint_share_link(uuid, text, text, timestamptz) to authenticated;


-- =========================================================
-- list_share_links — returns expires_at
-- =========================================================

create or replace function public.list_share_links(p_trip_id uuid)
returns table (
  token       uuid,
  role        text,
  label       text,
  created_at  timestamptz,
  expires_at  timestamptz
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
    select s.token, s.role, s.label, s.created_at, s.expires_at
      from public.share_links s
     where s.trip_id = p_trip_id
       and s.revoked_at is null
     order by s.created_at desc;
end;
$$;

grant execute on function public.list_share_links(uuid) to authenticated;
