-- Default `created_by` to auth.uid() so the client can omit it on insert.
--
-- With the previous policy ( with check (auth.uid() = created_by) ) the row
-- was rejected if the JWT context didn't match the explicit value the client
-- sent — easy to misalign during early sign-in. Letting Postgres fill the
-- column from the request's JWT removes that whole class of mismatch.

alter table public.itineraries
  alter column created_by set default auth.uid();

-- Loosen the FK so deleting an auth user doesn't break the not-null constraint.
-- The original migration declared `not null references auth.users on delete set null`,
-- which is internally inconsistent. Drop the not-null so cascades behave.
alter table public.itineraries
  alter column created_by drop not null;

-- Tighten the insert policy: any signed-in user can insert as long as either
-- (a) they didn't specify created_by (default fills it with their uid) or
-- (b) they specified it as their own uid.
drop policy if exists "itineraries auth insert" on public.itineraries;
create policy "itineraries auth insert" on public.itineraries
  for insert
  with check (
    auth.uid() is not null
    and (created_by is null or created_by = auth.uid())
  );
