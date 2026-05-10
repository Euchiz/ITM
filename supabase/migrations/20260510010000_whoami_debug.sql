-- Diagnostic RPC: returns the JWT identity PostgREST sees for the caller.
-- Used to debug auth.uid()-returns-null issues. Safe to keep around.
--
-- Call from the client with:
--   const { data, error } = await supabase.rpc('whoami');

create or replace function public.whoami()
returns jsonb
language sql
security invoker
stable
set search_path = public
as $$
  select jsonb_build_object(
    'auth_uid', auth.uid(),
    'auth_role', auth.role(),
    'jwt_sub', current_setting('request.jwt.claims', true)::jsonb->>'sub',
    'jwt_role', current_setting('request.jwt.claims', true)::jsonb->>'role',
    'jwt_aud', current_setting('request.jwt.claims', true)::jsonb->>'aud',
    'jwt_iss', current_setting('request.jwt.claims', true)::jsonb->>'iss'
  );
$$;

-- Allow anon and authenticated roles to call it (it returns harmless info).
grant execute on function public.whoami() to anon, authenticated;
