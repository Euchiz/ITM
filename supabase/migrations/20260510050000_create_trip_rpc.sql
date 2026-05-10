-- RPCs for atomic trip creation and replacement from a Trip JSON payload.
--
-- Why RPCs instead of direct INSERTs:
--   * create_itinerary already exists for the legacy markdown shape; we
--     extend the model with create_trip_full that accepts the full
--     normalized Trip JSON (trip + days + items + checklists + notes)
--     and inserts everything in a single transaction.
--   * SECURITY DEFINER captures auth.uid() at function entry where it
--     reliably returns the caller's UUID (avoiding the WITH CHECK quirk).
--   * Owner-membership for new trips is added inside the same function,
--     same atomicity guarantee.

-- =============================================================
-- create_trip_full(p_payload jsonb) → uuid
-- =============================================================
-- p_payload shape mirrors the canonical export JSON (schema_version:
-- "trip_v1"). Unknown fields are ignored. Validation is the frontend's
-- job; this function trusts shape but falls back to safe defaults.

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
  v_todo      jsonb;
  v_check     jsonb;
  v_note      jsonb;
  v_day_id    uuid;
  v_day_idx   int;
  v_item_idx  int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  insert into public.itineraries
    (title, destination, start_date, end_date, summary, general_notes, travelers, created_by)
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
      insert into public.itinerary_items
        (trip_id, day_id, title, type, start_time, end_time, location_name, map_url, notes, is_fixed, is_highlight, status, sort_order)
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
        v_item_idx
      );
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

-- =============================================================
-- replace_trip_full(p_id uuid, p_payload jsonb) → uuid
-- =============================================================
-- Owner-only. Wipes existing days/items/checklists/notes (cascade), then
-- replays the payload into the same trip id. Trip metadata is updated
-- in place so the URL stays valid.

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
  v_todo      jsonb;
  v_check     jsonb;
  v_note      jsonb;
  v_day_id    uuid;
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

  -- Cascade-delete children. itineraries row stays so the URL remains valid.
  delete from public.days where trip_id = p_id;
  -- Prep checklist items have day_id NULL so they survive day deletion;
  -- delete them explicitly. Notes likewise.
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
    )
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
      insert into public.itinerary_items
        (trip_id, day_id, title, type, start_time, end_time, location_name, map_url, notes, is_fixed, is_highlight, status, sort_order)
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
        v_item_idx
      );
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

-- =============================================================
-- create_trip(p_title text) — small RPC for "create empty trip" button
-- =============================================================
-- Replaces the markdown-shaped create_itinerary for the dashboard's
-- "+ New trip" button. We keep create_itinerary around for the migration
-- window but the frontend uses this one.

create or replace function public.create_trip(p_title text default 'Untitled trip')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  insert into public.itineraries (title, created_by)
  values (coalesce(nullif(btrim(p_title), ''), 'Untitled trip'), v_uid)
  returning id into v_id;

  insert into public.itinerary_members (itinerary_id, user_id, role)
  values (v_id, v_uid, 'owner')
  on conflict (itinerary_id, user_id) do nothing;

  return v_id;
end;
$$;

grant execute on function public.create_trip(text) to authenticated;

-- The legacy markdown-shaped RPC no longer matches the schema (markdown
-- column is gone). Drop it so it can't be called.
drop function if exists public.create_itinerary(text, text);
