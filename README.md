# Hermes Daybook

A lightweight trip-planning companion from **Viridian Blue Labs**. Build
a day-by-day itinerary, prepare a before-trip checklist, and follow
today's schedule + todos during travel. Multi-user with Supabase Auth +
per-trip access control, plus shareable-link guest editing.

> Plan the days. Prepare the details. Follow today's checklist.

## Concepts

Everything is organized around a **Trip**:

```
Trip
├── Metadata (title, destination, dates, travelers, summary, notes)
├── Members (owner / editor / viewer)
├── Days
│   ├── Itinerary items (activity, food, transport, lodging, ...)
│   └── Daily todos
├── Preparation checklist (before-trip)
└── Notes (free-form)
```

Three modes match how you use the app:

| Mode    | Page             | When               |
| ------- | ---------------- | ------------------ |
| Plan    | Itinerary        | Building the trip  |
| Prepare | Prepare          | Before departure   |
| Travel  | Today            | While traveling    |

## Stack

- Static HTML + ES modules from `index.html`. No build step.
- Supabase JS v2 (loaded on demand from `esm.sh`).
- Six page modules under `pages/` rendered into a single trip view.
- GitHub Actions deploys to GitHub Pages and bakes Supabase config
  from repo Secrets.

## File overview

```
index.html               app shell + view containers
styles.css               all styling
app.js                   orchestrator: auth, view + page routing
supabase.js              Supabase client + auth + trip data API
auth.js                  email/password sign-in / sign-up / reset views
templates.js             checklist templates (basic, international, ...)

io/
  schema.js              Trip JSON validator (matches guideline §11+§15)
  parser.js              extract JSON from pasted text or trip-json block
  export.js              build trip JSON, AI prompt, Markdown export

pages/
  _utils.js              shared rendering helpers
  dashboard.js           "All trips" list + create + delete
  overview.js            trip metadata + stats + next-up + needs-attention
  itinerary.js           Plan mode — days + items + reorder + flags
  prepare.js             before-trip checklist by category + templates
  today.js               Travel mode — next item, schedule, todos
  notes.js               free-form trip notes
  io.js                  Import/Export (JSON + AI prompt + Markdown)

sample.json              "Japan Family Trip" sample, importable as a new trip
docs/                    project guideline (lightweight_trip_tool_*.md)

supabase/migrations/     versioned SQL migrations
supabase/README.md       migration usage
```

## Deploy to GitHub Pages

The included workflow at `.github/workflows/deploy.yml`:

1. Reads two repo Secrets: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
2. Writes them into a generated `config.js` at build time as
   `window.ITM_CONFIG = { url, key }`.
3. Uploads the directory and deploys to Pages.

### One-time setup

1. **Create the Supabase project** and apply the migrations from
   `supabase/migrations/` (see [`supabase/README.md`](supabase/README.md)).
2. **Configure Auth** in the Supabase Dashboard:
   - **Authentication → Providers → Email**: enable.
   - **Authentication → URL Configuration**:
     - **Site URL**: `https://<user>.github.io/<repo>/`
     - **Redirect URLs**: same value (and `http://localhost:5173/` for
       local dev). Confirmation and password-reset links use these.
3. **Add repo Secrets** at *Settings → Secrets and variables → Actions*:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY` — the `sb_publishable_...` key.
4. **Settings → Pages → Source: GitHub Actions**.
5. Push to `main` (or run the workflow from the **Actions** tab).

## Run locally

```bash
# any static server
npx serve .
# or
python -m http.server 5173
```

Open `http://localhost:5173`. Click **⚙** to enter your Supabase URL +
publishable key — they're stored only in this browser. The app needs a
backend; there is no local-only mode.

To try without filling in any data, sign in, click **+ New trip**, then
go to **Import / Export**, paste the contents of `sample.json` into the
import box, click **Validate**, then **Replace current trip** (since
this is your fresh empty trip).

## Import / Export format

The canonical exchange format is a JSON object with `schema_version:
"trip_v1"` — see [`docs/lightweight_trip_tool_project_guideline.md`](docs/lightweight_trip_tool_project_guideline.md)
sections 11 and 15 for the complete spec.

The Import/Export page on every trip exposes:

- **Copy JSON** / **Download .trip.json** — round-trippable export.
- **Copy AI prompt + JSON** — pre-built prompt template you can paste
  into any AI assistant to ask for edits while preserving the schema.
- **Download Markdown** — readable Markdown with the trip JSON embedded
  as a fenced ` ```trip-json ` block.
- **Import** — paste raw JSON, a Markdown export, or any text containing
  a trip-json block. The validator runs first; you preview before
  saving, then choose **Create as new trip** or **Replace current trip**
  (owner-only).

## Security notes

- The Supabase **publishable / anon key** is shipped to every browser.
  That's by design for client-side Supabase apps. Real access control
  comes from the **RLS policies** in the migrations, which gate every
  table on membership in `itinerary_members`.
- Never put the Supabase **service-role** key in a repo Secret used by
  Pages. It bypasses RLS.
- Each trip's data is only readable to its members. Even with the
  publishable key, a random visitor cannot list or read trips that
  aren't theirs.
- Profiles (email, display name) are world-readable so member lists can
  show who's on a trip. Tighten the `profiles read` policy if that's
  a concern.

## Roles

| Role   | Read | Edit items | Edit metadata | Delete trip | Replace trip |
| ------ | :--: | :--------: | :-----------: | :---------: | :----------: |
| owner  | ✓    | ✓          | ✓             | ✓           | ✓            |
| editor | ✓    | ✓          | ✓             |             |              |
| viewer | ✓    |            |               |             |              |

### Share links

Beyond the email-invite flow above, owners can mint a shareable link
from the **Share** button in the trip header. Anyone who clicks the
link can sign in, sign up, or continue as a guest (anonymous Supabase
session) and start editing immediately. Guests can later promote their
session to a permanent account from the **👤 Guest · Save trip** chip,
which preserves their UID and all attributed edits.

Links are per-role (`editor` / `viewer`), revocable individually, and
rotatable from the same dialog. Labeled variants for different audiences
live under **Members → Share links**. Abandoned anonymous accounts are
swept after 30 days of inactivity by a daily `pg_cron` job; converted
accounts are spared.

## Out of scope (V1)

Per the project guideline §7.4 / §18:

- AI itinerary generation (use Import/Export to round-trip through any
  external AI assistant)
- File uploads (text-based file-location notes only)
- Booking integrations, payment tracking, weather, calendar sync
- Real-time multiplayer editing, PDF export, route maps
