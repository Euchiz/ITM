# Supabase migrations

SQL migrations for the Itinerary Studio backend. Files follow the
Supabase CLI naming convention `<14-digit-timestamp>_<name>.sql` and
are applied in lexicographic order.

## Schema overview

| Table | Purpose |
|---|---|
| `profiles` | One row per signed-in user, mirrored from `auth.users`. Public-readable for member-list display; users update only their own row. |
| `itineraries` | One row per trip. `created_by` records the author but does not by itself grant access. |
| `itinerary_members` | Many-to-many join table. Determines who can see/edit a trip and at what role (`owner` / `editor` / `viewer`). |

Triggers do the bookkeeping:
- A new `auth.users` row → auto-inserts the corresponding `profiles` row.
- A new `itineraries` row → auto-inserts a member row for the creator
  with `role = 'owner'`.
- Any `update` on `itineraries` refreshes `updated_at`.

RLS is enforced via two `security definer` helper functions —
`is_member_of(uuid)` and `role_in(uuid)` — which sidestep the recursive
RLS lookup that would otherwise occur when an `itinerary_members`
policy queries `itinerary_members`.

## How to apply

### Option A — Supabase Dashboard

1. Open your project's **SQL Editor**.
2. For each `.sql` file in `migrations/` (in filename order), paste the
   contents and run it.

### Option B — Supabase CLI

```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

`db push` walks `supabase/migrations/` and applies anything new.

## Configure Auth before going live

After applying the schema, in the Supabase Dashboard:

1. **Authentication → Providers → Email**: ensure "Enable Email
   provider" is on. The default magic-link flow is what the app uses;
   no password configuration needed.
2. **Authentication → URL Configuration**:
   - **Site URL**: the deployed page, e.g.
     `https://<user>.github.io/<repo>/`.
   - **Redirect URLs**: the same value (add `http://localhost:5173/`
     too if you plan to develop locally).

Magic links won't take users back to the app correctly unless these
URLs match where the app is served.

## Files

| Order | File | What it does |
|---|---|---|
| 1 | `20260509000000_init_schema.sql` | Profiles + itineraries + members tables, triggers, helper functions, and RLS. |

## Adding a new migration

1. Pick a fresh 14-digit UTC timestamp ahead of every existing file:

   ```bash
   date -u +%Y%m%d%H%M%S
   ```
2. Create `migrations/<timestamp>_<descriptive_name>.sql`.
3. Make it idempotent where possible (`if not exists`, `drop ... if exists`
   before recreating policies, `create or replace function`) so the file
   can be re-applied without errors.
4. Commit alongside any app code that depends on it.

### Example: invite-by-email RPC

A future migration to support sharing might add an RPC that adds
another user as an editor:

```sql
create or replace function public.invite_to_itinerary(
  itin uuid,
  invitee_email text,
  invitee_role text default 'editor'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invitee_id uuid;
begin
  if public.role_in(itin) <> 'owner' then
    raise exception 'Only the owner can invite';
  end if;
  if invitee_role not in ('editor', 'viewer') then
    raise exception 'Invalid role';
  end if;
  select id into invitee_id from public.profiles where email = invitee_email;
  if invitee_id is null then
    raise exception 'No user with that email has signed in yet';
  end if;
  insert into public.itinerary_members (itinerary_id, user_id, role)
  values (itin, invitee_id, invitee_role)
  on conflict (itinerary_id, user_id) do update set role = excluded.role;
  return invitee_id;
end;
$$;
```

The app would call it via `supabase.rpc("invite_to_itinerary", { itin, invitee_email, invitee_role })`.
