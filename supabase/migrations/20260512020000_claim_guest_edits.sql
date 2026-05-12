-- "Claim my guest edits" merge flow.
--
-- The default conversion flow (auth.updateUser({email, password}))
-- fails when the email is already in use. The friendly path then is:
-- sign the user into the existing account AND move all their guest
-- edits + memberships across. This migration adds the schema + RPCs
-- to support that two-step handoff:
--
--   1. While still anonymous, the client calls start_anon_merge() and
--      gets a short-lived token tied to its anon UID. The token table
--      is the only thing that knows which anon UID is being claimed —
--      we need it because the next step changes the session away from
--      the anon user, and the client can't safely tell the server
--      "I used to be UID X" without server-side verification.
--
--   2. The client signs out anon and signs in to the existing account,
--      then calls claim_anon_edits(token). The RPC looks up the anon
--      UID from the token, moves all itinerary_members rows (with
--      upgrade-only role conflict resolution), reassigns created_by
--      on every child table from the anon UID to the caller, and
--      deletes the anon auth.users row.
--
-- Token TTL is 10 minutes — long enough for a normal sign-in flow,
-- short enough that a leaked token can't be replayed weeks later.


-- =========================================================
-- anon_merge_tokens
-- =========================================================

create table if not exists public.anon_merge_tokens (
  token         uuid primary key default gen_random_uuid(),
  anon_user_id  uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '10 minutes')
);

create index if not exists anon_merge_tokens_anon_idx
  on public.anon_merge_tokens (anon_user_id);

-- RLS not strictly required since all access goes through SECURITY
-- DEFINER RPCs, but enable it as a defense-in-depth: even if a future
-- migration accidentally adds a direct grant, the policies stay empty
-- so nothing leaks.
alter table public.anon_merge_tokens enable row level security;


-- =========================================================
-- start_anon_merge() → uuid (token)
-- =========================================================
-- Caller must be authenticated AND is_anonymous=true. Creates a token
-- tied to their UID and returns it. Idempotent in the sense that
-- multiple calls just mint multiple tokens — the table will be
-- cascade-deleted along with the anon row when the merge completes.

create or replace function public.start_anon_merge()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_is_anon boolean;
  v_token   uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select is_anonymous into v_is_anon from auth.users where id = v_uid;
  if not coalesce(v_is_anon, false) then
    raise exception 'only anonymous users can start a merge' using errcode = '42501';
  end if;

  insert into public.anon_merge_tokens (anon_user_id)
  values (v_uid)
  returning token into v_token;

  return v_token;
end;
$$;

grant execute on function public.start_anon_merge() to authenticated;


-- =========================================================
-- claim_anon_edits(p_token) → integer (claimed memberships)
-- =========================================================
-- Caller must be authenticated and NOT anonymous (they've just signed
-- into the existing account). Looks up the anon UID from the token,
-- merges memberships with upgrade-only role precedence, reassigns
-- created_by on every owned-content table, and deletes the anon user.

create or replace function public.claim_anon_edits(p_token uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_is_anon   boolean;
  v_anon_uid  uuid;
  v_expires   timestamptz;
  v_moved     integer := 0;
  v_rank_existing int;
  v_rank_incoming int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select is_anonymous into v_is_anon from auth.users where id = v_uid;
  if coalesce(v_is_anon, false) then
    raise exception 'sign in to a permanent account before claiming' using errcode = '42501';
  end if;

  -- Look up + validate token. Lock the row so a concurrent claim
  -- attempt can't double-process the same anon UID.
  select anon_user_id, expires_at
    into v_anon_uid, v_expires
    from public.anon_merge_tokens
   where token = p_token
   for update;

  if v_anon_uid is null then
    raise exception 'merge token not found' using errcode = 'P0002';
  end if;

  if v_expires < now() then
    raise exception 'merge token has expired' using errcode = '42501';
  end if;

  if v_anon_uid = v_uid then
    raise exception 'cannot claim your own session' using errcode = '22023';
  end if;

  -- Merge memberships. For trips where the caller is already a member,
  -- take the higher-power role; otherwise, transfer the anon row.
  -- Power: owner > editor > viewer.
  for v_rank_existing, v_rank_incoming in
    select
      case existing.role when 'owner' then 3 when 'editor' then 2 else 1 end,
      case incoming.role when 'owner' then 3 when 'editor' then 2 else 1 end
    from public.itinerary_members incoming
    join public.itinerary_members existing
      on existing.itinerary_id = incoming.itinerary_id
     and existing.user_id      = v_uid
    where incoming.user_id = v_anon_uid
  loop
    -- (We don't use v_rank_existing / v_rank_incoming directly here;
    -- the actual update happens in the next statement. The loop is
    -- a placeholder for visibility — keeping it future-proof in case
    -- we want to log per-trip merge decisions.)
    perform 1;
  end loop;

  -- Upgrade existing memberships where anon held a higher role.
  update public.itinerary_members existing
     set role = incoming.role
   from public.itinerary_members incoming
   where incoming.user_id      = v_anon_uid
     and existing.itinerary_id = incoming.itinerary_id
     and existing.user_id      = v_uid
     and (
       (existing.role = 'viewer' and incoming.role in ('editor','owner'))
       or
       (existing.role = 'editor' and incoming.role = 'owner')
     );

  -- Delete anon's memberships that now duplicate caller's memberships.
  delete from public.itinerary_members
   where user_id = v_anon_uid
     and itinerary_id in (
       select itinerary_id from public.itinerary_members where user_id = v_uid
     );

  -- Transfer remaining anon memberships to caller.
  update public.itinerary_members
     set user_id         = v_uid,
         joined_via_link = joined_via_link  -- preserved as-is
   where user_id = v_anon_uid;

  get diagnostics v_moved = row_count;

  -- Reassign created_by on every owned-content table. itineraries
  -- itself rarely points at an anon UID (per the dashboard guard
  -- anons can't create trips), but the update is cheap and harmless
  -- in the case where they were promoted to owner of a trip.
  update public.itineraries     set created_by = v_uid where created_by = v_anon_uid;
  update public.days            set created_by = v_uid where created_by = v_anon_uid;
  update public.itinerary_items set created_by = v_uid where created_by = v_anon_uid;
  update public.checklist_items set created_by = v_uid where created_by = v_anon_uid;
  update public.notes           set created_by = v_uid where created_by = v_anon_uid;

  -- Finally, delete the anon user. Cascade handles profiles,
  -- anon_merge_tokens, and any lingering rows.
  delete from auth.users where id = v_anon_uid;

  return v_moved;
end;
$$;

grant execute on function public.claim_anon_edits(uuid) to authenticated;
