-- Cost-managing-system — RPC updates.
--
-- 1. create_trip_full / replace_trip_full now read the new trip-level
--    fields (default_currency, budget_target_cents) into itineraries
--    and the six new per-item cost fields + shares array into
--    itinerary_items / item_cost_shares. Backwards-compat: missing
--    fields default to NULL / false.
--
-- 2. replace_item_shares(item_id, jsonb) — replaces an item's share
--    rows atomically. Used by Budget Edit's custom-split disclosure.
--
-- 3. set_trip_budget(trip_id, default_currency, budget_target_cents)
--    — small helper for the "+ Set budget target" inline CTA on
--    Breakdown view. Owner-only.
--
-- All three SECURITY DEFINER for the usual auth.uid()-WITH-CHECK quirk.


-- =========================================================
-- create_trip_full
-- =========================================================

create or replace function public.create_trip_full(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_trip_id   uuid;
  v_trip      jsonb := coalesce(p_payload -> 'trip', '{}'::jsonb);
  v_days      jsonb := coalesce(p_payload -> 'days', '[]'::jsonb);
  v_prep      jsonb := coalesce(p_payload -> 'preparation_checklist', '[]'::jsonb);
  v_notes     jsonb := coalesce(p_payload -> 'notes', '[]'::jsonb);
  v_day       jsonb;
  v_item      jsonb;
  v_share     jsonb;
  v_todo      jsonb;
  v_check     jsonb;
  v_note      jsonb;
  v_day_id    uuid;
  v_item_id   uuid;
  v_share_uid uuid;
  v_paid_uid  uuid;
  v_day_idx   int;
  v_item_idx  int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  insert into public.itineraries
    (title, destination, start_date, end_date, summary, general_notes, travelers,
     default_currency, budget_target_cents, created_by)
  values (
    coalesce(nullif(btrim(v_trip ->> 'title'), ''), 'Untitled trip'),
    coalesce(v_trip ->> 'destination', ''),
    nullif(v_trip ->> 'start_date', '')::date,
    nullif(v_trip ->> 'end_date', '')::date,
    coalesce(v_trip ->> 'summary', ''),
    coalesce(v_trip ->> 'general_notes', ''),
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(coalesce(v_trip -> 'travelers', '[]'::jsonb))),
      '{}'
    ),
    coalesce(nullif(v_trip ->> 'default_currency', ''), 'USD'),
    nullif(v_trip ->> 'budget_target_cents', '')::bigint,
    v_uid
  )
  returning id into v_trip_id;

  insert into public.itinerary_members (itinerary_id, user_id, role)
  values (v_trip_id, v_uid, 'owner')
  on conflict (itinerary_id, user_id) do nothing;

  v_day_idx := 0;
  for v_day in select * from jsonb_array_elements(v_days) loop
    insert into public.days (trip_id, date, title, city, notes, sort_order)
    values (
      v_trip_id,
      nullif(v_day ->> 'date', '')::date,
      coalesce(v_day ->> 'title', ''),
      coalesce(v_day ->> 'city', ''),
      coalesce(v_day ->> 'notes', ''),
      v_day_idx
    )
    returning id into v_day_id;

    v_item_idx := 0;
    for v_item in select * from jsonb_array_elements(coalesce(v_day -> 'items', '[]'::jsonb)) loop
      -- Resolve paid_by_email to a UID (may be NULL if email not in auth.users yet).
      v_paid_uid := null;
      if nullif(v_item ->> 'paid_by_email', '') is not null then
        select id into v_paid_uid from auth.users where email = v_item ->> 'paid_by_email' limit 1;
      end if;

      insert into public.itinerary_items
        (trip_id, day_id, title, type, start_time, end_time, location_name, map_url, notes,
         is_fixed, is_highlight, status, sort_order,
         proposed_cost_cents, actual_cost_cents, cost_tag, currency, paid_by, is_unplanned)
      values (
        v_trip_id, v_day_id,
        coalesce(v_item ->> 'title', ''),
        coalesce(nullif(v_item ->> 'type', ''), 'activity'),
        nullif(v_item ->> 'start_time', '')::time,
        nullif(v_item ->> 'end_time', '')::time,
        coalesce(v_item ->> 'location_name', ''),
        coalesce(v_item ->> 'map_url', ''),
        coalesce(v_item ->> 'notes', ''),
        coalesce((v_item ->> 'is_fixed')::boolean, false),
        coalesce((v_item ->> 'is_highlight')::boolean, false),
        coalesce(nullif(v_item ->> 'status', ''), 'planned'),
        v_item_idx,
        nullif(v_item ->> 'proposed_cost_cents', '')::bigint,
        nullif(v_item ->> 'actual_cost_cents', '')::bigint,
        nullif(v_item ->> 'cost_tag', ''),
        nullif(v_item ->> 'currency', ''),
        v_paid_uid,
        coalesce((v_item ->> 'is_unplanned')::boolean, false)
      )
      returning id into v_item_id;

      -- Insert shares (skip rows whose email doesn't resolve).
      for v_share in select * from jsonb_array_elements(coalesce(v_item -> 'shares', '[]'::jsonb)) loop
        if nullif(v_share ->> 'user_email', '') is null then
          continue;
        end if;
        select id into v_share_uid from auth.users where email = v_share ->> 'user_email' limit 1;
        if v_share_uid is null then
          continue;
        end if;
        insert into public.item_cost_shares
          (item_id, user_id, proposed_amount_cents, actual_amount_cents)
        values (
          v_item_id, v_share_uid,
          nullif(v_share ->> 'proposed_amount_cents', '')::bigint,
          nullif(v_share ->> 'actual_amount_cents', '')::bigint
        )
        on conflict (item_id, user_id) do nothing;
      end loop;

      v_item_idx := v_item_idx + 1;
    end loop;

    v_item_idx := 0;
    for v_todo in select * from jsonb_array_elements(coalesce(v_day -> 'todos', '[]'::jsonb)) loop
      insert into public.checklist_items
        (trip_id, day_id, text, category, due_date, is_done, notes, sort_order)
      values (
        v_trip_id, v_day_id,
        coalesce(v_todo ->> 'text', ''),
        coalesce(nullif(v_todo ->> 'category', ''), 'other'),
        nullif(v_todo ->> 'due_date', '')::date,
        coalesce((v_todo ->> 'is_done')::boolean, false),
        coalesce(v_todo ->> 'notes', ''),
        v_item_idx
      );
      v_item_idx := v_item_idx + 1;
    end loop;

    v_day_idx := v_day_idx + 1;
  end loop;

  v_item_idx := 0;
  for v_check in select * from jsonb_array_elements(v_prep) loop
    insert into public.checklist_items
      (trip_id, day_id, text, category, due_date, is_done, notes, sort_order)
    values (
      v_trip_id, null,
      coalesce(v_check ->> 'text', ''),
      coalesce(nullif(v_check ->> 'category', ''), 'other'),
      nullif(v_check ->> 'due_date', '')::date,
      coalesce((v_check ->> 'is_done')::boolean, false),
      coalesce(v_check ->> 'notes', ''),
      v_item_idx
    );
    v_item_idx := v_item_idx + 1;
  end loop;

  v_item_idx := 0;
  for v_note in select * from jsonb_array_elements(v_notes) loop
    insert into public.notes
      (trip_id, day_id, title, body, sort_order)
    values (
      v_trip_id, null,
      coalesce(v_note ->> 'title', ''),
      coalesce(v_note ->> 'body', ''),
      v_item_idx
    );
    v_item_idx := v_item_idx + 1;
  end loop;

  return v_trip_id;
end;
$$;

grant execute on function public.create_trip_full(jsonb) to authenticated;


-- =========================================================
-- replace_trip_full
-- =========================================================

create or replace function public.replace_trip_full(p_id uuid, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_role      text;
  v_trip      jsonb := coalesce(p_payload -> 'trip', '{}'::jsonb);
  v_days      jsonb := coalesce(p_payload -> 'days', '[]'::jsonb);
  v_prep      jsonb := coalesce(p_payload -> 'preparation_checklist', '[]'::jsonb);
  v_notes     jsonb := coalesce(p_payload -> 'notes', '[]'::jsonb);
  v_day       jsonb;
  v_item      jsonb;
  v_share     jsonb;
  v_todo      jsonb;
  v_check     jsonb;
  v_note      jsonb;
  v_day_id    uuid;
  v_item_id   uuid;
  v_share_uid uuid;
  v_paid_uid  uuid;
  v_day_idx   int;
  v_item_idx  int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select role into v_role
    from public.itinerary_members
   where itinerary_id = p_id and user_id = v_uid;

  if v_role is null or v_role <> 'owner' then
    raise exception 'only the trip owner can replace it' using errcode = '42501';
  end if;

  -- Cascade-delete children. itinerary_items.delete cascades to
  -- item_cost_shares via the FK, so no separate share-delete needed.
  delete from public.days where trip_id = p_id;
  delete from public.checklist_items where trip_id = p_id;
  delete from public.notes where trip_id = p_id;

  update public.itineraries set
    title         = coalesce(nullif(btrim(v_trip ->> 'title'), ''), title),
    destination   = coalesce(v_trip ->> 'destination', destination),
    start_date    = nullif(v_trip ->> 'start_date', '')::date,
    end_date      = nullif(v_trip ->> 'end_date', '')::date,
    summary       = coalesce(v_trip ->> 'summary', ''),
    general_notes = coalesce(v_trip ->> 'general_notes', ''),
    travelers     = coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(coalesce(v_trip -> 'travelers', '[]'::jsonb))),
      '{}'
    ),
    default_currency    = coalesce(nullif(v_trip ->> 'default_currency', ''), default_currency),
    budget_target_cents = nullif(v_trip ->> 'budget_target_cents', '')::bigint
  where id = p_id;

  v_day_idx := 0;
  for v_day in select * from jsonb_array_elements(v_days) loop
    insert into public.days (trip_id, date, title, city, notes, sort_order)
    values (
      p_id,
      nullif(v_day ->> 'date', '')::date,
      coalesce(v_day ->> 'title', ''),
      coalesce(v_day ->> 'city', ''),
      coalesce(v_day ->> 'notes', ''),
      v_day_idx
    )
    returning id into v_day_id;

    v_item_idx := 0;
    for v_item in select * from jsonb_array_elements(coalesce(v_day -> 'items', '[]'::jsonb)) loop
      v_paid_uid := null;
      if nullif(v_item ->> 'paid_by_email', '') is not null then
        select id into v_paid_uid from auth.users where email = v_item ->> 'paid_by_email' limit 1;
      end if;

      insert into public.itinerary_items
        (trip_id, day_id, title, type, start_time, end_time, location_name, map_url, notes,
         is_fixed, is_highlight, status, sort_order,
         proposed_cost_cents, actual_cost_cents, cost_tag, currency, paid_by, is_unplanned)
      values (
        p_id, v_day_id,
        coalesce(v_item ->> 'title', ''),
        coalesce(nullif(v_item ->> 'type', ''), 'activity'),
        nullif(v_item ->> 'start_time', '')::time,
        nullif(v_item ->> 'end_time', '')::time,
        coalesce(v_item ->> 'location_name', ''),
        coalesce(v_item ->> 'map_url', ''),
        coalesce(v_item ->> 'notes', ''),
        coalesce((v_item ->> 'is_fixed')::boolean, false),
        coalesce((v_item ->> 'is_highlight')::boolean, false),
        coalesce(nullif(v_item ->> 'status', ''), 'planned'),
        v_item_idx,
        nullif(v_item ->> 'proposed_cost_cents', '')::bigint,
        nullif(v_item ->> 'actual_cost_cents', '')::bigint,
        nullif(v_item ->> 'cost_tag', ''),
        nullif(v_item ->> 'currency', ''),
        v_paid_uid,
        coalesce((v_item ->> 'is_unplanned')::boolean, false)
      )
      returning id into v_item_id;

      for v_share in select * from jsonb_array_elements(coalesce(v_item -> 'shares', '[]'::jsonb)) loop
        if nullif(v_share ->> 'user_email', '') is null then continue; end if;
        select id into v_share_uid from auth.users where email = v_share ->> 'user_email' limit 1;
        if v_share_uid is null then continue; end if;
        insert into public.item_cost_shares
          (item_id, user_id, proposed_amount_cents, actual_amount_cents)
        values (
          v_item_id, v_share_uid,
          nullif(v_share ->> 'proposed_amount_cents', '')::bigint,
          nullif(v_share ->> 'actual_amount_cents', '')::bigint
        )
        on conflict (item_id, user_id) do nothing;
      end loop;

      v_item_idx := v_item_idx + 1;
    end loop;

    v_item_idx := 0;
    for v_todo in select * from jsonb_array_elements(coalesce(v_day -> 'todos', '[]'::jsonb)) loop
      insert into public.checklist_items
        (trip_id, day_id, text, category, due_date, is_done, notes, sort_order)
      values (
        p_id, v_day_id,
        coalesce(v_todo ->> 'text', ''),
        coalesce(nullif(v_todo ->> 'category', ''), 'other'),
        nullif(v_todo ->> 'due_date', '')::date,
        coalesce((v_todo ->> 'is_done')::boolean, false),
        coalesce(v_todo ->> 'notes', ''),
        v_item_idx
      );
      v_item_idx := v_item_idx + 1;
    end loop;

    v_day_idx := v_day_idx + 1;
  end loop;

  v_item_idx := 0;
  for v_check in select * from jsonb_array_elements(v_prep) loop
    insert into public.checklist_items
      (trip_id, day_id, text, category, due_date, is_done, notes, sort_order)
    values (
      p_id, null,
      coalesce(v_check ->> 'text', ''),
      coalesce(nullif(v_check ->> 'category', ''), 'other'),
      nullif(v_check ->> 'due_date', '')::date,
      coalesce((v_check ->> 'is_done')::boolean, false),
      coalesce(v_check ->> 'notes', ''),
      v_item_idx
    );
    v_item_idx := v_item_idx + 1;
  end loop;

  v_item_idx := 0;
  for v_note in select * from jsonb_array_elements(v_notes) loop
    insert into public.notes
      (trip_id, day_id, title, body, sort_order)
    values (
      p_id, null,
      coalesce(v_note ->> 'title', ''),
      coalesce(v_note ->> 'body', ''),
      v_item_idx
    );
    v_item_idx := v_item_idx + 1;
  end loop;

  return p_id;
end;
$$;

grant execute on function public.replace_trip_full(uuid, jsonb) to authenticated;


-- =========================================================
-- replace_item_shares — atomic delete+insert of an item's shares
-- =========================================================
-- Used by Budget Edit's custom-split disclosure. The JS layer sends
-- the full per-row payload after every edit (debounced 700ms); this
-- function wipes the existing rows and reinserts in one transaction so
-- there's no half-state visible to readers.
--
-- Pass shares as a jsonb array of { user_id, proposed_amount_cents,
-- actual_amount_cents } — JS uses UIDs here (not emails) since the
-- caller already has them in the trip's membersById map.

create or replace function public.replace_item_shares(p_item_id uuid, p_shares jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_trip_id   uuid;
  v_role      text;
  v_share     jsonb;
  v_share_uid uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select trip_id into v_trip_id from public.itinerary_items where id = p_item_id;
  if v_trip_id is null then
    raise exception 'item not found' using errcode = 'P0002';
  end if;

  select role into v_role
    from public.itinerary_members
   where itinerary_id = v_trip_id and user_id = v_uid;

  if v_role is null or v_role not in ('owner','editor') then
    raise exception 'only owners or editors can change item shares' using errcode = '42501';
  end if;

  delete from public.item_cost_shares where item_id = p_item_id;

  if p_shares is null or jsonb_typeof(p_shares) <> 'array' then
    return;
  end if;

  for v_share in select * from jsonb_array_elements(p_shares) loop
    v_share_uid := nullif(v_share ->> 'user_id', '')::uuid;
    if v_share_uid is null then continue; end if;
    insert into public.item_cost_shares
      (item_id, user_id, proposed_amount_cents, actual_amount_cents)
    values (
      p_item_id, v_share_uid,
      nullif(v_share ->> 'proposed_amount_cents', '')::bigint,
      nullif(v_share ->> 'actual_amount_cents', '')::bigint
    )
    on conflict (item_id, user_id) do update
      set proposed_amount_cents = excluded.proposed_amount_cents,
          actual_amount_cents   = excluded.actual_amount_cents;
  end loop;
end;
$$;

grant execute on function public.replace_item_shares(uuid, jsonb) to authenticated;


-- =========================================================
-- set_trip_budget — inline "Set budget target" CTA
-- =========================================================
-- Owner-only. NULL p_target clears the target (gauge hides). Pass
-- p_currency NULL to leave the existing default_currency untouched.

create or replace function public.set_trip_budget(
  p_trip_id  uuid,
  p_currency text default null,
  p_target   bigint default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select role into v_role
    from public.itinerary_members
   where itinerary_id = p_trip_id and user_id = v_uid;

  if v_role is null or v_role <> 'owner' then
    raise exception 'only the trip owner can set the budget' using errcode = '42501';
  end if;

  update public.itineraries
     set default_currency    = coalesce(nullif(p_currency, ''), default_currency),
         budget_target_cents = p_target
   where id = p_trip_id;
end;
$$;

grant execute on function public.set_trip_budget(uuid, text, bigint) to authenticated;
