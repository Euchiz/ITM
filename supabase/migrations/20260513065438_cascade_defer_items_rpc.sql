-- Mobile redesign · cascade_defer_items RPC.
--
-- Used by the mobile Today screen's "Defer +30m / +1h" action button.
-- Shifts an item's start_time and end_time forward by N minutes, and
-- cascades the same shift to every subsequent same-day item that is
-- NOT marked is_fixed. Returns the count of items that now overlap a
-- fixed event, so the client can surface a warning toast.
--
-- Fixed items are skipped — a flight at 14:00 stays at 14:00 even when
-- earlier flexible items get pushed later. Overlapping with a fixed
-- item is allowed and signalled via the return value.
--
-- Times that would wrap past midnight are clamped at 23:59. The user
-- is expected to re-time those manually on desktop; we don't try to
-- spill into the next day.

create or replace function public.cascade_defer_items(
  p_from_item_id uuid,
  p_minutes      int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_trip_id    uuid;
  v_day_id     uuid;
  v_from_sort  int;
  v_role       text;
  v_collisions int := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_minutes is null or p_minutes <= 0 then
    raise exception 'p_minutes must be a positive integer' using errcode = '22023';
  end if;

  -- Resolve the source item.
  select trip_id, day_id, sort_order
    into v_trip_id, v_day_id, v_from_sort
    from public.itinerary_items
   where id = p_from_item_id;

  if v_trip_id is null then
    raise exception 'item not found' using errcode = 'P0002';
  end if;

  -- Role check — editors+ only.
  select role into v_role
    from public.itinerary_members
   where itinerary_id = v_trip_id and user_id = v_uid;

  if v_role is null or v_role not in ('owner','editor') then
    raise exception 'only owners or editors can defer events' using errcode = '42501';
  end if;

  -- Shift every non-fixed same-day item from this sort position onward.
  -- Clamp at 23:59 so the time column never overflows.
  update public.itinerary_items
     set start_time = case when start_time is null then null
                           else least(
                                  start_time + (p_minutes || ' minutes')::interval,
                                  '23:59'::time
                                )
                      end,
         end_time   = case when end_time is null then null
                           else least(
                                  end_time + (p_minutes || ' minutes')::interval,
                                  '23:59'::time
                                )
                      end
   where day_id = v_day_id
     and sort_order >= v_from_sort
     and coalesce(is_fixed, false) = false;

  -- Count overlapping pairs: (shifted item, fixed item) where times intersect.
  -- A pair counts once. The COALESCE on end_time falls back to a 15-minute
  -- placeholder so items with only start_time can still be checked for overlap.
  select count(*) into v_collisions
    from public.itinerary_items shifted
    join public.itinerary_items fixed
      on  fixed.day_id  = shifted.day_id
     and fixed.id      <> shifted.id
     and coalesce(fixed.is_fixed, false) = true
   where shifted.day_id     = v_day_id
     and shifted.sort_order >= v_from_sort
     and coalesce(shifted.is_fixed, false) = false
     and shifted.start_time is not null
     and fixed.start_time   is not null
     and shifted.start_time < coalesce(fixed.end_time,   fixed.start_time   + interval '15 minutes')
     and coalesce(shifted.end_time, shifted.start_time + interval '15 minutes') > fixed.start_time;

  return v_collisions;
end;
$$;

grant execute on function public.cascade_defer_items(uuid, int) to authenticated;
