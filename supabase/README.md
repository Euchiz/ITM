# Supabase migrations

SQL migrations for the Itinerary Studio backend. Files follow the
Supabase CLI convention `<14-digit-timestamp>_<name>.sql` and are
applied in lexicographic order — so the timestamp prefix doubles as
sort key.

## How to apply

### Option A — Supabase Dashboard (no CLI)

1. Open your project's **SQL Editor**.
2. For each `.sql` file in `migrations/` (in filename order), paste the
   contents and run it.

### Option B — Supabase CLI

```bash
# one-time
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>

# apply every migration in this folder
supabase db push
```

## Files

| Order | File | What it does |
|---|---|---|
| 1 | `20260509000000_init_itineraries.sql` | Creates `public.itineraries`, indexes, and **wide-open** RLS policies. Fine for a personal-use deployment; insecure if the page URL is public. |

## Tightening RLS for a public page

The default policies trust anyone who has the anon key. Since the anon
key is shipped to every browser that loads the GitHub Pages site, a
public URL means anyone can read/write your itineraries.

To gate access on a hard-to-guess `owner` value (which you set as the
`SUPABASE_OWNER` repo secret so it's baked into the deployed page),
add a follow-up migration like this:

```sql
-- supabase/migrations/<later-timestamp>_owner_scoped_rls.sql
--
-- Replace wide-open policies with owner-scoped ones. The client must
-- send `owner = '<your-secret-tag>'` for every read/write — which the
-- app does automatically when SUPABASE_OWNER is set.

drop policy if exists "anon read"   on public.itineraries;
drop policy if exists "anon insert" on public.itineraries;
drop policy if exists "anon update" on public.itineraries;
drop policy if exists "anon delete" on public.itineraries;

-- IMPORTANT: replace 'REPLACE-ME' with the same value you put in
-- the SUPABASE_OWNER GitHub Action secret.
create policy "owner read" on public.itineraries
  for select using (owner = 'REPLACE-ME');
create policy "owner insert" on public.itineraries
  for insert with check (owner = 'REPLACE-ME');
create policy "owner update" on public.itineraries
  for update using (owner = 'REPLACE-ME') with check (owner = 'REPLACE-ME');
create policy "owner delete" on public.itineraries
  for delete using (owner = 'REPLACE-ME');
```

This is still soft security — anyone reading the deployed JS can find
the owner value too. For real isolation, switch to Supabase Auth and
gate policies on `auth.uid()` instead.

## Adding a new migration

1. Pick a fresh 14-digit timestamp ahead of every existing file
   (e.g. `date -u +%Y%m%d%H%M%S`).
2. Create `migrations/<timestamp>_<descriptive_name>.sql`.
3. Make the SQL idempotent where possible (`if not exists`,
   `drop ... if exists` before recreating policies, etc.) so the file
   can be re-applied without errors.
4. Commit alongside any app code that depends on it.
