# Supabase migrations

SQL migrations for the Hermes Daybook backend. Files follow the
Supabase CLI naming convention `<14-digit-timestamp>_<name>.sql` and
are applied in lexicographic order.

## Schema overview

| Table | Purpose |
|---|---|
| `profiles` | One row per signed-in user, mirrored from `auth.users`. Public-readable for member-list display; users update only their own row. |
| `itineraries` | One row per trip (carries title + destination + dates + summary + general_notes + travelers[]). `created_by` records the author but does not by itself grant access. |
| `itinerary_members` | Many-to-many join table. Determines who can see/edit a trip and at what role (`owner` / `editor` / `viewer`). |
| `days` | Days of a trip. Owns its `itinerary_items`. |
| `itinerary_items` | A scheduled item on a day (activity, food, transport, lodging, ...) with type, status, time range, location, fixed/highlight flags. |
| `checklist_items` | Trip-level prep checklist when `day_id` is NULL; daily todos when `day_id` is set. |
| `notes` | Free-form trip-level notes (file locations, food preferences, emergency info, ...). |

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

1. **Authentication → Providers → Email**: enable. The app uses
   email + password sign-in plus password reset by email. Whether
   "Confirm email" is required is up to you (default on; recommended).
2. **Authentication → URL Configuration**:
   - **Site URL**: the deployed page, e.g.
     `https://<user>.github.io/<repo>/`.
   - **Redirect URLs**: the same value (add `http://localhost:5173/`
     too if you plan to develop locally).

Confirmation links (after sign-up) and password-reset links won't
take users back to the app correctly unless these URLs match where
the app is served.

## Files

| Order | File | What it does |
|---|---|---|
| 1 | `20260509000000_init_schema.sql` | Profiles + itineraries + members tables, triggers, helper functions, and RLS. |
| 2 | `20260510000000_default_created_by.sql` | Default `itineraries.created_by` to `auth.uid()` and loosen the insert policy so the client can omit it. |
| 3 | `20260510010000_whoami_debug.sql` | Diagnostic helpers for the auth.uid()-in-WITH-CHECK quirk. |
| 4 | `20260510020000_fix_insert_path.sql` | Intermediate fix attempt for the same quirk. |
| 5 | `20260510030000_create_itinerary_rpc.sql` | `create_itinerary` RPC (legacy, dropped in #7). |
| 6 | `20260510040000_trip_schema.sql` | **Trip-shaped schema**: drops `markdown`, adds trip metadata + `days` + `itinerary_items` + `checklist_items` + `notes`, with RLS on all child tables. |
| 7 | `20260510050000_create_trip_rpc.sql` | RPCs `create_trip`, `create_trip_full(jsonb)` (atomic import), `replace_trip_full(uuid, jsonb)` (owner-only). Drops the legacy `create_itinerary`. |
| 8 | `20260510060000_member_rpcs.sql` | Member-management RPCs (`list_trip_members`, `add_trip_member_by_email`, `update_trip_member_role`, `remove_trip_member`). |
| 9 | `20260511000000_fix_list_trip_members_ambiguous.sql` | Disambiguation fix for `list_trip_members` column references. |
| 10 | `20260511010000_share_links_schema.sql` | Share-link schema: `share_links` table, `itinerary_members.joined_via_link`, `created_by` on child tables + BEFORE INSERT triggers, `random_nickname()` helper. |
| 11 | `20260511020000_share_links_rpcs.sql` | Share-link RPCs: `peek_share_link` (public preview), `redeem_share_link`, `mint_share_link`, `rotate_share_link`, `revoke_share_link`, `list_share_links`, `default_share_link`. |
| 12 | `20260511030000_anon_cleanup_cron.sql` | `pg_cron` daily sweep that reaps anonymous users idle >30 days (skips those who linked a non-anon identity). |
| 13 | `20260512000000_fix_share_links_ambiguous_and_rename.sql` | Fix `list_share_links` ambiguous-column error; rename "Trip Studio" → "Hermes Daybook" in `add_trip_member_by_email`'s user-visible error message. |
| 14 | `20260512010000_share_link_expiry.sql` | Per-link expiration: adds `share_links.expires_at`, updates `peek_share_link` to expose `expired`, `redeem_share_link` to refuse expired tokens, `mint_share_link` to accept an optional expires_at, `list_share_links` to return it. |
| 15 | `20260512020000_claim_guest_edits.sql` | "Claim my guest edits" merge flow: adds `anon_merge_tokens` table, `start_anon_merge()` (called while anon), and `claim_anon_edits(token)` (called after signing into the existing account). Moves memberships with upgrade-only role precedence, reassigns `created_by` across all content tables, deletes the anon user. |
| 16 | `20260513002123_cost_managing_schema.sql` | Cost-managing-system foundation: `itineraries` gains `default_currency` + `budget_target_cents`; `itinerary_items` gains six cost columns (proposed/actual cents, tag, currency override, paid_by, is_unplanned); new `item_cost_shares` table scaffolds custom splits for the upcoming Budget/Costs UI. RLS reaches the parent trip via `itinerary_items.trip_id`. |

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

### Pattern: SECURITY DEFINER RPCs for mutations

Most mutations on shared tables go through `SECURITY DEFINER` RPCs
rather than direct `INSERT` / `UPDATE` / `DELETE` under RLS. This avoids
a known Supabase quirk where `auth.uid()` returns NULL inside `WITH
CHECK` expressions on the same request, even though it returns the
correct UUID elsewhere. See `20260510060000_member_rpcs.sql` and
`20260511020000_share_links_rpcs.sql` for the established pattern:
verify the caller is authenticated, enforce role-based authorization
explicitly, then do the write.
