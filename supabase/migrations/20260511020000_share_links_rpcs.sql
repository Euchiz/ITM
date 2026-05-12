-- Share-link sharing — RPC half.
--
-- Five SECURITY DEFINER functions:
--
--   peek_share_link(token)         — public (anon + authenticated). Returns
--                                    the minimum metadata the landing screen
--                                    needs to render trip context above the
--                                    Sign in / Sign up / Continue as guest
--                                    CTAs. No item bodies, no emails.
--
--   redeem_share_link(token, name) — idempotent. Inserts or updates an
--                                    itinerary_members row for the caller,
--                                    setting joined_via_link. Honors the
--                                    "upgrade-only" role rule so a viewer
--                                    link can't demote an existing editor.
--                                    Stamps profiles.display_name for new
--                                    anon users (random nickname if name is
--                                    blank). Authenticated callers only —
--                                    the JS layer signInAnonymously()s
--                                    before invoking this.
--
--   mint_share_link(trip, role, label?) — owner mints a fresh link.
--   rotate_share_link(trip, role)       — owner revokes current default
--                                          (NULL-label) link for role, mints
--                                          a fresh one, returns its token.
--   revoke_share_link(token, cascade)   — owner marks revoked_at. If
--                                          cascade, also deletes every
--                                          non-owner itinerary_members row
--                                          that joined through this token.


-- =========================================================
-- peek_share_link(p_token) → (trip_title, destination, start_date,
--                              end_date, owner_display_name, role,
--                              revoked)
-- =========================================================
-- Exposes the bare minimum needed to render "Kyoto, Apr 12–19 / Shared
-- by Alice / Editor access" on the landing screen, without leaking
-- the trip body or the owner's email. The caller (the landing-screen
-- fetch) is unauthenticated by design.
--
-- Returns no rows if the token doesn't exist. Returns revoked=true if
-- it exists but is revoked, so the UI can show "This link has been
-- revoked" instead of a generic error.

create or replace function public.peek_share_link(p_token uuid)
returns table (
  trip_title         text,
  destination        text,
  start_date         date,
  end_date           date,
  owner_display_name text,
  role               text,
  revoked            boolean
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
         (s.revoked_at is not null) as revoked
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
-- redeem_share_link(p_token, p_display_name) → uuid (trip_id)
-- =========================================================
-- Called after the client has a session (anonymous or registered).
-- Adds the caller to the trip's members under the link's role, with
-- an upgrade-only rule so a lower-permission re-click can't demote
-- someone who already has a higher role.
--
-- For anonymous callers without a display_name set, populates
-- profiles.display_name from the provided value (trimmed) or a random
-- nickname if blank. Registered users' display_name is left alone.

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
  v_existing    text;
  v_proposed    text;
  v_current_dn  text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Look up the link. Lock the row so two concurrent redeems on the
  -- same link don't race on the revocation check.
  select trip_id, role, revoked_at
    into v_trip_id, v_link_role, v_revoked
    from public.share_links
   where token = p_token
   for share;

  if v_trip_id is null then
    raise exception 'share link not found' using errcode = 'P0002';
  end if;

  if v_revoked is not null then
    raise exception 'share link has been revoked' using errcode = '42501';
  end if;

  -- Upgrade-only rule. If the caller already has a role on this trip,
  -- a higher-power link upgrades them; a lower-power link is a no-op.
  -- Power ordering: owner > editor > viewer.
  select role into v_existing
    from public.itinerary_members
   where itinerary_id = v_trip_id and user_id = v_uid;

  v_proposed := v_link_role;

  if v_existing is not null then
    if v_existing = 'owner' then
      -- Owner clicking their own share link: no-op, just route them in.
      return v_trip_id;
    end if;
    if v_existing = 'editor' and v_proposed = 'viewer' then
      -- Don't downgrade an existing editor.
      return v_trip_id;
    end if;
  end if;

  insert into public.itinerary_members (itinerary_id, user_id, role, joined_via_link)
  values (v_trip_id, v_uid, v_proposed, p_token)
  on conflict (itinerary_id, user_id) do update
    set role            = excluded.role,
        joined_via_link = excluded.joined_via_link;

  -- For anonymous users with no display name yet, stamp one. Check
  -- auth.users.is_anonymous so registered users' chosen names aren't
  -- overwritten by the optional landing-screen input.
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
-- mint_share_link(p_trip_id, p_role, p_label?) → uuid (token)
-- =========================================================
-- Owner only. Creates a new share_links row and returns the token.
-- The header Share dialog calls this lazily: if no NULL-label link
-- exists for the requested role, mint one; otherwise reuse.

create or replace function public.mint_share_link(
  p_trip_id uuid,
  p_role    text,
  p_label   text default null
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

  insert into public.share_links (trip_id, role, created_by, label)
  values (p_trip_id, p_role, v_uid, nullif(btrim(p_label), ''))
  returning token into v_token;

  return v_token;
end;
$$;

grant execute on function public.mint_share_link(uuid, text, text) to authenticated;


-- =========================================================
-- rotate_share_link(p_trip_id, p_role) → uuid (new token)
-- =========================================================
-- Owner only. Revokes the current default (NULL-label) link for this
-- role and mints a fresh one. Labeled links are not touched — they
-- get rotated individually by revoke + mint via the Members page.

create or replace function public.rotate_share_link(
  p_trip_id uuid,
  p_role    text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_new_token uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_role not in ('editor','viewer') then
    raise exception 'role must be editor or viewer' using errcode = '22023';
  end if;

  if (select role from public.itinerary_members
        where itinerary_id = p_trip_id and user_id = v_uid) <> 'owner' then
    raise exception 'only the trip owner can rotate share links' using errcode = '42501';
  end if;

  update public.share_links
     set revoked_at = now()
   where trip_id    = p_trip_id
     and role       = p_role
     and label is null
     and revoked_at is null;

  insert into public.share_links (trip_id, role, created_by, label)
  values (p_trip_id, p_role, v_uid, null)
  returning token into v_new_token;

  return v_new_token;
end;
$$;

grant execute on function public.rotate_share_link(uuid, text) to authenticated;


-- =========================================================
-- revoke_share_link(p_token, p_cascade) → void
-- =========================================================
-- Owner only. Marks revoked_at on the link. If p_cascade is true,
-- also removes every itinerary_members row that joined through this
-- token — except owners, which can never be auto-evicted (in case
-- the owner promoted a guest to owner since they joined).

create or replace function public.revoke_share_link(
  p_token   uuid,
  p_cascade boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_trip_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select trip_id into v_trip_id
    from public.share_links
   where token = p_token;

  if v_trip_id is null then
    raise exception 'share link not found' using errcode = 'P0002';
  end if;

  if (select role from public.itinerary_members
        where itinerary_id = v_trip_id and user_id = v_uid) <> 'owner' then
    raise exception 'only the trip owner can revoke share links' using errcode = '42501';
  end if;

  update public.share_links
     set revoked_at = coalesce(revoked_at, now())
   where token = p_token;

  if p_cascade then
    delete from public.itinerary_members
     where joined_via_link = p_token
       and role <> 'owner';
  end if;
end;
$$;

grant execute on function public.revoke_share_link(uuid, boolean) to authenticated;


-- =========================================================
-- list_share_links(p_trip_id) → table of active links
-- =========================================================
-- Owner-facing roster for the Members page "Share links" section.
-- Returns active (unrevoked) links with their role, label, and
-- created_at. Lets the UI render without each row needing its own
-- RLS pass.

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
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if (select role from public.itinerary_members
        where itinerary_id = p_trip_id and user_id = v_uid) <> 'owner' then
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
-- default_share_link(p_trip_id, p_role) → uuid (token) or null
-- =========================================================
-- Owner-only helper that returns the most recent NULL-label unrevoked
-- token for the role, or NULL if none exists. The header Share dialog
-- uses this to decide whether it needs to mint a new link or reuse
-- the current default.

create or replace function public.default_share_link(
  p_trip_id uuid,
  p_role    text
)
returns uuid
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_token uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if (select role from public.itinerary_members
        where itinerary_id = p_trip_id and user_id = v_uid) <> 'owner' then
    raise exception 'only the trip owner can read share links' using errcode = '42501';
  end if;

  select token into v_token
    from public.share_links
   where trip_id    = p_trip_id
     and role       = p_role
     and label is null
     and revoked_at is null
   order by created_at desc
   limit 1;

  return v_token;
end;
$$;

grant execute on function public.default_share_link(uuid, text) to authenticated;
