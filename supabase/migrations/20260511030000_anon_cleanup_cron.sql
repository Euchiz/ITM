-- Anonymous user cleanup — periodic sweep.
--
-- Anonymous auth (signInAnonymously) creates real auth.users rows that
-- persist forever unless we clean them up. Without this job, every
-- share-link click that goes through "Continue as guest" leaves a
-- permanent row, slowly bloating the auth table.
--
-- Policy (locked during design grilling):
--   - Sweep daily.
--   - Delete only anon users whose last activity is older than 30 days.
--   - "Last activity" = newest auth.refresh_tokens.updated_at, which
--     advances on silent token refresh — not last_sign_in_at, which
--     only advances on explicit signInAnonymously().
--   - Skip anon users who have been converted (have a non-anonymous
--     auth.identities row). Their conversion linked an email and they
--     should be treated as regular users from then on.
--   - Their itinerary_members rows cascade on user delete; their edits
--     in itinerary_items / days / notes / checklist_items use
--     `references auth.users on delete set null`, so attribution
--     becomes "unknown" rather than the row vanishing.
--
-- Notes on enabling pg_cron:
--
--   Supabase exposes pg_cron via the `pg_cron` extension. On a
--   self-hosted Postgres it must be in shared_preload_libraries. On
--   Supabase Cloud you enable it in Database → Extensions. The
--   `create extension` below is idempotent and a no-op when already
--   enabled. If your environment doesn't support pg_cron at all,
--   delete the cron.schedule call and run cleanup_anonymous_users()
--   from an external scheduler (GitHub Action, etc.) instead.

create extension if not exists pg_cron;


-- =========================================================
-- cleanup_anonymous_users() — the sweep itself
-- =========================================================
-- Pulled out of the cron job so it's callable on-demand (e.g. for
-- testing) and so the cron entry stays a one-liner.

create or replace function public.cleanup_anonymous_users()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  with victims as (
    select u.id
      from auth.users u
     where u.is_anonymous = true
       and not exists (
         select 1
           from auth.identities i
          where i.user_id = u.id
            and i.provider <> 'anonymous'
       )
       and not exists (
         select 1
           from auth.refresh_tokens r
          where r.user_id = u.id::text
            and r.updated_at > now() - interval '30 days'
       )
  ),
  deleted as (
    delete from auth.users
     where id in (select id from victims)
    returning 1
  )
  select count(*) into v_deleted from deleted;

  return v_deleted;
end;
$$;


-- =========================================================
-- Schedule the sweep at 03:00 UTC daily
-- =========================================================
-- cron.schedule is upsert-friendly via cron.unschedule + re-create;
-- using a known job name lets a re-run of the migration replace the
-- existing entry without duplicating it.

do $$
begin
  perform cron.unschedule('hermes-anon-cleanup')
  where exists (select 1 from cron.job where jobname = 'hermes-anon-cleanup');
exception when undefined_table then
  -- pg_cron not actually installed in this environment — skip silently
  -- so the migration still applies. The function is usable; only the
  -- automatic schedule is missing.
  return;
end$$;

do $$
begin
  perform cron.schedule(
    'hermes-anon-cleanup',
    '0 3 * * *',
    $sql$ select public.cleanup_anonymous_users(); $sql$
  );
exception when undefined_table then
  return;
end$$;
