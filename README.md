# Itinerary Studio

A small, dependency-light web app for editing travel itineraries written in
markdown and rendering them as printable HTML / PDF. Designed to drop straight
onto GitHub Pages with no build step. An optional Supabase backend lets you
save and load named itineraries.

The render styling is cloned from the graduation-trip itinerary, so a markdown
file with the same shape (bilingual day-by-day tables, lodging, checklist, etc.)
will look the same when rendered or printed.

## Features

- **Edit mode.** Inline editor for headings, paragraphs, blockquotes, and
  tables. Tables support add/remove row/column. Everything autosaves to
  `localStorage`.
- **Render mode.** Letter-page styling matching the graduation-trip PDF.
- **Print to PDF.** Browser print dialog, no Playwright needed.
- **Import .md.** Drop in any markdown file using the supported subset
  (headings, paragraphs, pipe tables, blockquotes).
- **Export .md / .html.** Round-trippable markdown. Standalone HTML with the
  print stylesheet inlined.
- **Optional Supabase backend.** Save and reload named itineraries.

## Run locally

This is a static site. From the `itinerary-app/` directory:

```bash
# any static server works; here are two options
npx serve .
# or
python -m http.server 5173
```

Then open `http://localhost:5173`. Opening `index.html` directly via `file://`
works for most things, but the **Sample** button uses `fetch` and needs a real
server.

## Deploy to GitHub Pages (with auto-baked Supabase config)

This repo ships with a GitHub Actions workflow
(`.github/workflows/deploy.yml`) that:

1. Reads three secrets from the repo:
   - `SUPABASE_URL`         — Project URL
   - `SUPABASE_ANON_KEY`    — anon (publishable) key
   - `SUPABASE_OWNER`       — optional `owner` tag for filtering your docs
2. Writes them into a `config.js` at build time as
   `window.ITM_CONFIG = { url, key, owner }`.
3. Uploads the directory and deploys to Pages.

### One-time setup

1. **Settings → Secrets and variables → Actions → New repository secret**
   — add the three secrets above.
2. **Settings → Pages → Source: GitHub Actions**.
3. Push to `main` (or run the workflow manually from the **Actions** tab).
4. Site publishes at `https://<user>.github.io/<repo>/`.

### How the app picks credentials

Order of precedence:

1. Anything you've saved through the in-app **⚙** dialog (per-browser).
2. The baked-in `window.ITM_CONFIG` from `config.js`.

So the deployed page connects to Supabase automatically on any device,
and you can still override locally for dev. The cloud bar shows the source
(`from repo secrets` vs `from this browser`).

### Security reality

The Supabase **anon key** is shipped to every visitor's browser — that's
how every public client-side Supabase app works. GitHub Secrets just keeps
it out of git history (so you can rotate without rewriting commits) and
out of pull-request diffs.

Real access control comes from **RLS policies** on the table. If your Pages
site is public, either:
- Make the repo private and gate Pages behind GitHub auth (requires a
  GitHub plan that supports private Pages), or
- Use a hard-to-guess `SUPABASE_OWNER` value plus an RLS policy that only
  allows reads/writes when `owner` matches that value.

The README's example RLS policies are wide open and assume a single,
trusted user. Tighten them if your deployment is public.

No build step beyond the secret-injection. The Supabase client is loaded
on demand from `esm.sh`.

## Supported markdown

The parser is intentionally conservative so import / export round-trips
losslessly:

| Block            | Markdown                  |
| ---------------- | ------------------------- |
| Heading levels   | `# H1`, `## H2`, `### H3` |
| Paragraph        | One or more lines         |
| Pipe table       | `| col | col |` + separator `|---|---|` |
| Blockquote       | Lines starting with `> `  |

Inline subset for paragraphs and table cells: `**bold**`, `*italic*`,
`` `code` ``, `[link](url)`, and literal `<br>` for line breaks inside cells.

A blockquote line that begins with `!` is rendered as a "warning" callout in
print mode.

Table styling is auto-applied based on headers:

- Two columns whose headers contain "English" / "中文" → bilingual layout (50/50).
- Three columns where the first header is "Date" / "日期" / "Day" / "Night" →
  narrow date column + two wide content columns.

## Optional: Supabase backend

The app works fully without Supabase — everything is stored in the browser.
Connect Supabase if you want to save named itineraries you can pull up from
another device.

### 1. Create the table

In the Supabase SQL editor:

```sql
create table public.itineraries (
  id uuid primary key default gen_random_uuid(),
  owner text,
  title text not null,
  markdown text not null,
  updated_at timestamptz not null default now()
);

-- For a personal-use deployment, the simplest setup is:
--   * Disable RLS, OR
--   * Enable RLS with a permissive policy gated on the anon key
-- Pick one. If you make the URL public, prefer the second option and
-- restrict by an `owner` value only your client knows.

alter table public.itineraries enable row level security;
create policy "anon read"  on public.itineraries for select using (true);
create policy "anon write" on public.itineraries for insert with check (true);
create policy "anon update" on public.itineraries for update using (true);
create policy "anon delete" on public.itineraries for delete using (true);
```

> The above policies make the table fully open to anyone with the anon key. If
> the deployed page is public, use a stricter policy — for example, require an
> `owner` value that matches a client-side secret you supply via the settings
> dialog.

### 2. Connect from the app

Click the ⚙ icon, paste your project URL and anon (publishable) key, optionally
set an `owner` tag, and click **Connect**. The cloud bar appears; use **Save**
to persist the current document and **Load** to pull one back.

Credentials are stored in `localStorage` only.

## File overview

```
index.html      app shell + toolbar
styles.css      edit-mode chrome
print.css       render-mode + @page styling (cloned from graduation trip)
parser.js       markdown <-> block-list parser/serializer + inline renderer
app.js          editor, render, export, settings wiring
supabase.js     optional cloud save/load (dynamic import)
sample.md       graduation-trip itinerary as a working sample
```
