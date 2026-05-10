# Itinerary Studio

A small, dependency-light web app for collaboratively editing travel
itineraries written in markdown and rendering them as printable HTML / PDF.
Designed to drop straight onto GitHub Pages with no build step. Multi-user
with Supabase Auth + per-trip access control.

## Features

- **Email + password sign-in.** Sign up, sign in, and reset your password by email — all standard Supabase Auth flows.
- **All Trips page.** Lists every itinerary you have access to, with role
  (owner / editor / viewer) and last-updated time. Create new trips and
  delete trips you own from one place.
- **Per-trip access.** Each itinerary lives in its own row; access is
  governed by an `itinerary_members` table. Default new trip is
  single-member (you, role=owner). Schema supports adding co-editors;
  invite UI ships in a follow-up.
- **Block editor.** Headings, paragraphs, blockquotes, and tables with
  add/remove row/column. Auto-saves to Supabase 1.5s after the last edit.
- **Render mode.** Letter-page styling matching the graduation-trip PDF.
  One-click print → PDF via the browser.
- **Import / export.** Bring in any markdown file using the supported
  subset; export back to `.md` or a self-contained `.html`.
- **Guest fallback.** When Supabase is not configured, the app runs as
  a single-doc local editor — useful for trying it out.

## Stack

- Vanilla ES modules from `index.html` — no build step.
- Supabase JS v2 (loaded on demand from `esm.sh`).
- GitHub Actions deploys to GitHub Pages and bakes Supabase config from
  repo Secrets.

## Deploy to GitHub Pages

The included workflow at `.github/workflows/deploy.yml`:

1. Reads two repo Secrets: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
2. Writes them into a generated `config.js` at build time as
   `window.ITM_CONFIG = { url, key }`.
3. Uploads the directory and deploys to Pages.

### One-time setup

1. **Create the Supabase project** and apply the migration from
   `supabase/migrations/` (see [`supabase/README.md`](supabase/README.md)).
2. **Configure Auth** in the Supabase Dashboard:
   - **Authentication → Providers → Email**: enable. Decide whether
     "Confirm email" is on (default yes — recommended). With it on,
     new sign-ups must click a link in an email before they can sign in.
   - **Authentication → URL Configuration**:
     - **Site URL**: `https://<user>.github.io/<repo>/`
     - **Redirect URLs**: same value (and `http://localhost:5173/`
       if you plan to develop locally). Confirmation and password-reset
       links use these.
3. **Add repo Secrets** at *Settings → Secrets and variables → Actions*:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY` — the `sb_publishable_...` key (or the
     legacy anon JWT; both work).
4. **Settings → Pages → Source: GitHub Actions**.
5. Push to `main` (or run the workflow from the **Actions** tab).

The site publishes at `https://<user>.github.io/<repo>/` and is fully
functional from there — visitors sign in with their email, manage their
own trips, and never need to paste credentials.

## Run locally

```bash
# any static server
npx serve .
# or
python -m http.server 5173
```

Open `http://localhost:5173`. To connect to Supabase locally, click
**⚙** and enter your URL + publishable key — they're stored only in
this browser. (Or copy `config.js` from a successful deploy.) Without
those, the app runs in single-doc guest mode.

## Supported markdown

The parser is intentionally conservative so import / export round-trips
losslessly:

| Block            | Markdown                                  |
| ---------------- | ----------------------------------------- |
| Heading levels   | `# H1`, `## H2`, `### H3`                 |
| Paragraph        | One or more lines                         |
| Pipe table       | `\| col \| col \|` + separator `\|---\|---\|` |
| Blockquote       | Lines starting with `> `                  |

Inline subset for paragraphs and table cells: `**bold**`, `*italic*`,
`` `code` ``, `[link](url)`, and literal `<br>` for line breaks inside
cells. A blockquote line that begins with `!` renders as a "warning"
callout in print mode.

Table styling auto-applies based on headers:

- Two columns whose headers contain "English" / "中文" → bilingual
  layout (50/50).
- Three columns where the first header is "Date" / "日期" / "Day" /
  "Night" → narrow date column + two wide content columns.

## Security notes

- The Supabase **publishable / anon key is shipped to every browser**.
  That's by design for client-side Supabase apps. Real access control
  comes from the **RLS policies** in the migration, which gate every
  table on membership in `itinerary_members`.
- Never put the Supabase **service-role** key in a repo Secret used by
  Pages. It bypasses RLS.
- An itinerary's data is only readable to its members. Even with the
  publishable key, a random visitor cannot list or read trips that
  aren't theirs.
- Profiles (email, display name) are world-readable so member lists
  can show who's on a trip. If that's a concern, harden the
  `profiles read` policy.

## File overview

```
index.html               app shell + auth/trips/editor view containers
styles.css               edit-mode chrome
print.css                render-mode + @page styling (cloned from graduation trip)
parser.js                markdown <-> block-list parser/serializer + inline renderer
supabase.js              Supabase client + auth + trips API
auth.js                  magic-link sign-in view
trips.js                 all-trips list view
app.js                   orchestrator: view switching, editor, save flow
sample.md                graduation-trip itinerary as a working sample
.github/workflows/       deploy.yml — Pages deploy with secret-baked config
supabase/migrations/     versioned SQL migrations
supabase/README.md       migration usage + how to add new ones
```
