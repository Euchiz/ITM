// Trip Studio — orchestrator.
//
// Three views:
//   auth   — sign in / sign up / reset password
//   trips  — all-trips dashboard
//   trip   — single trip with six sub-pages: overview, itinerary,
//            prepare, today, notes, io (import/export)
//
// URL contract:
//   ?               → trips dashboard
//   ?trip=<uuid>    → trip view, default page = overview
//   ?trip=<uuid>&page=<name>  → specific sub-page
//
// Without Supabase configured, the app shows the settings dialog and
// stops there. (Guest mode existed for the markdown editor; the
// trip-shaped app is backend-first, so guest mode no longer makes sense.)

import {
  initSupabase, isConfigured, configSource, auth, trips,
  days as daysApi,
} from "./supabase.js";
import { renderAuthView } from "./auth.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderOverview } from "./pages/overview.js";
import { renderItinerary } from "./pages/itinerary.js";
import { renderPrepare } from "./pages/prepare.js";
import { renderToday } from "./pages/today.js";
import { renderNotes } from "./pages/notes.js";
import { renderMembers } from "./pages/members.js";
import { renderIO } from "./pages/io.js";
import { renderMap } from "./pages/map.js";
import { renderBudget } from "./pages/budget.js";
import { renderCosts } from "./pages/costs.js";
import { openPrintView } from "./pages/print-view.js";

const PAGES = {
  overview: renderOverview,
  itinerary: renderItinerary,
  map: renderMap,
  prepare: renderPrepare,
  budget: renderBudget,
  today: renderToday,
  notes: renderNotes,
  costs: renderCosts,
  members: renderMembers,
  io: renderIO,
};

// Pages grouped by mode. The sidebar renders one group at a time;
// the bottom "mode switch" toggles between them. Pages outside any
// mode group (members, io, overview) remain reachable by URL but
// are surfaced from app-header / from inside the itinerary editor.
const MODE_PAGES = {
  plan:   ["itinerary", "map", "prepare", "budget"],
  travel: ["today",     "notes", "costs"],
};

function modeForPage(page) {
  for (const [mode, list] of Object.entries(MODE_PAGES)) {
    if (list.includes(page)) return mode;
  }
  return "plan";
}

const state = {
  view: "auth",
  user: null,
  recoveryMode: false,
  trip: null,           // full trip object from trips.getFull
  page: "overview",
  selectedDayIdx: 0,    // which day the itinerary + day-strip are focused on
  saving: 0,            // active save count for the global indicator
  lastChangeAt: null,   // ms timestamp of the most recent save; used by
                        // the topbar's "LAST CHANGE <t>" telemetry. Seeded
                        // from trip.updated_at on openTrip; bumped on every
                        // noteSaveDone.
};

// ===== Boot =====

window.addEventListener("DOMContentLoaded", async () => {
  bindAppHeader();
  bindTabs();
  bindSettings();
  trackFontLoading();

  if (!isConfigured()) {
    showUnconfigured();
    return;
  }

  await initSupabase();
  await auth.onChange(handleAuthChange);

  const session = await auth.getSession();
  state.user = session?.user || null;
  routeFromUrl();
});

// Flip a class on <html> once the Material Symbols Outlined font is
// available, so we can hide the literal ligature text (e.g. the word
// "calendar_month") that otherwise overlays nav labels while the icon
// font is still downloading.
function trackFontLoading() {
  const mark = () => document.documentElement.classList.add("fonts-loaded");
  if (!document.fonts || !document.fonts.ready) { mark(); return; }
  document.fonts.ready.then(mark).catch(mark);
  // Safety net: don't leave glyph slots invisible forever if `fonts.ready`
  // never resolves on some browsers.
  setTimeout(mark, 4000);
}

function handleAuthChange(event, session) {
  if (event === "PASSWORD_RECOVERY") {
    state.recoveryMode = true;
    state.user = session?.user || null;
    paintHeader();
    setView("auth");
    return;
  }
  const wasUser = state.user;
  state.user = session?.user || null;
  paintHeader();
  if (!!state.user !== !!wasUser) routeFromUrl();
}

async function routeFromUrl() {
  paintHeader();
  if (state.recoveryMode) { setView("auth"); return; }
  if (!state.user) { setView("auth"); return; }

  const url = new URL(location.href);
  const tripId = url.searchParams.get("trip");
  const page = url.searchParams.get("page") || "overview";

  if (tripId) {
    await openTrip(tripId, page);
  } else {
    setView("trips");
  }
}

// ===== View switching =====

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  document.getElementById("view-auth").hidden = view !== "auth";
  document.getElementById("view-trips").hidden = view !== "trips";
  document.getElementById("view-trip").hidden = view !== "trip";
  document.getElementById("mobileNav").hidden = view !== "trip";

  if (view === "trip") startTopbarTick();
  else stopTopbarTick();

  if (view === "auth") {
    renderAuthView(document.getElementById("view-auth"), {
      initialMode: state.recoveryMode ? "reset" : "sign-in",
      onPasswordReset: () => {
        state.recoveryMode = false;
        history.replaceState(null, "", window.location.pathname + window.location.search);
        routeFromUrl();
      },
    });
  } else if (view === "trips") {
    renderDashboard(document.getElementById("view-trips"), {
      onOpen: (id) => navigate({ trip: id, page: "overview" }),
    });
  }
  paintHeader();
}

// ===== Trip loading =====

export async function openTrip(id, page = "overview") {
  try {
    const trip = await trips.getFull(id);
    state.trip = trip;
    state.page = PAGES[page] ? page : "overview";
    state.selectedDayIdx = pickDefaultDayIdx(trip);
    // Seed the "LAST CHANGE" timestamp from the server-side updated_at
    // if present; otherwise fall back to "now" so the topbar never shows
    // a missing value. Bumped on every save (noteSaveDone).
    const seed = Date.parse(trip?.updated_at || "") || Date.now();
    state.lastChangeAt = seed;
    syncUrl({ trip: id, page: state.page });
    setView("trip");
    renderTripPage();
  } catch (e) {
    toast("Could not open trip: " + e.message, true);
    syncUrl({});
    setView("trips");
  }
}

// Pick the day the user most likely wants to see first:
//   - today's day if it falls within the trip,
//   - else the next upcoming day,
//   - else the first day.
// Used when openTrip first lands; user clicks on the day-strip override it.
function pickDefaultDayIdx(trip) {
  const days = trip?.days || [];
  if (!days.length) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const idxToday = days.findIndex((d) => d.date === today);
  if (idxToday >= 0) return idxToday;
  const idxNext = days.findIndex((d) => d.date && d.date > today);
  if (idxNext >= 0) return idxNext;
  return 0;
}

/** Re-fetch the current trip and re-render the page (for after structural edits). */
export async function refreshTrip() {
  if (!state.trip) return;
  try {
    state.trip = await trips.getFull(state.trip.id);
    renderTripPage();
  } catch (e) {
    toast("Reload failed: " + e.message, true);
  }
}

function renderTripPage() {
  // Clamp selectedDayIdx in case the trip lost days since it was set.
  const dayCount = (state.trip?.days || []).length;
  if (state.selectedDayIdx >= dayCount) state.selectedDayIdx = Math.max(0, dayCount - 1);
  if (state.selectedDayIdx < 0) state.selectedDayIdx = 0;

  const host = document.getElementById("tripPage");
  host.innerHTML = "";
  const fn = PAGES[state.page] || PAGES.overview;
  fn(host, {
    trip: state.trip,
    role: state.trip?.role || "viewer",
    selectedDayIdx: state.selectedDayIdx,
    setSelectedDayIdx: (idx) => {
      const max = Math.max(0, (state.trip?.days || []).length - 1);
      state.selectedDayIdx = Math.min(Math.max(0, idx), max);
      renderTripPage();
    },
    refresh: refreshTrip,
    navigate,
    onSaveStart: noteSaveStart,
    onSaveDone: noteSaveDone,
    onTitleChange: handleTripTitleChange,
  });
  paintTabs();
  paintHeader();
}

async function handleTripTitleChange(newTitle) {
  if (!state.trip) return;
  state.trip.title = newTitle;
  noteSaveStart();
  try {
    await trips.updateMeta(state.trip.id, { title: newTitle });
    paintHeader();
  } catch (e) {
    toast("Save failed: " + e.message, true);
  } finally {
    noteSaveDone();
  }
}

// ===== Navigation =====

export function navigate(opts = {}) {
  const url = new URL(location.href);
  if ("trip" in opts) {
    if (opts.trip) url.searchParams.set("trip", opts.trip);
    else url.searchParams.delete("trip");
  }
  if ("page" in opts) {
    if (opts.page && opts.page !== "overview") url.searchParams.set("page", opts.page);
    else url.searchParams.delete("page");
  }
  history.replaceState(null, "", url);

  const tripId = url.searchParams.get("trip");
  const page = url.searchParams.get("page") || "overview";

  if (!tripId) {
    state.trip = null;
    setView("trips");
    return;
  }

  // Same trip, different page: just swap pages without refetching.
  if (state.trip && state.trip.id === tripId) {
    state.page = PAGES[page] ? page : "overview";
    renderTripPage();
    return;
  }

  // Different trip: full open.
  openTrip(tripId, page);
}

function syncUrl({ trip, page }) {
  const url = new URL(location.href);
  if (trip) url.searchParams.set("trip", trip);
  else url.searchParams.delete("trip");
  if (page && page !== "overview") url.searchParams.set("page", page);
  else url.searchParams.delete("page");
  history.replaceState(null, "", url);
}

// ===== Header / tabs =====

function bindAppHeader() {
  const url = new URL(location.href);
  const escapeHatch = url.searchParams.get("settings") === "1";
  const settingsBtn = document.getElementById("settingsBtn");
  if (configSource() === "baked" && !escapeHatch) settingsBtn.hidden = true;

  document.getElementById("signOutBtn").addEventListener("click", async () => {
    try { await auth.signOut(); } catch (e) { toast(e.message, true); }
  });
  document.getElementById("backToTripsBtn").addEventListener("click", () => {
    navigate({ trip: null });
  });
  document.getElementById("printTripBtn").addEventListener("click", () => {
    if (state.trip) openPrintView(state.trip);
  });
}

function bindTabs() {
  document.querySelectorAll("#mobileNav button").forEach((btn) => {
    btn.addEventListener("click", () => navigate({ page: btn.dataset.page }));
  });
}

function paintTabs() {
  document.querySelectorAll("#mobileNav button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === state.page);
  });
  paintSidebar();
  paintTopbar();
  paintHero();
  paintDayStrip();
}

// ===== Voyage sidebar + hero + day strip =====
//
// Adapts the desktop trip-manager layout from the design handoff: left
// sidebar with trip switcher + categorized nav, top hero block summarising
// the trip, and a horizontal day pill strip when viewing day-anchored pages
// (itinerary / today).
//
// "Proposed" sidebar items (Map / Stays / Transit / Dining / Activities /
// Documents / Budget) are rendered disabled with a "SOON" badge — they
// match the design but no page module exists yet.

// Sidebar nav definitions per mode. SOON items are proposed features that
// don't have a backing page module yet — rendered disabled.
const NAV_PLAN = [
  { page: "itinerary", glyph: "calendar_month", label: "Itinerary" },
  { page: "map",       glyph: "map",            label: "Map",    soon: true },
  { page: "prepare",   glyph: "fact_check",     label: "Prepare" },
  { page: "budget",    glyph: "payments",       label: "Budget", soon: true },
];
const NAV_TRAVEL = [
  { page: "today",     glyph: "today",          label: "Today" },
  { page: "notes",     glyph: "edit_note",      label: "Notes" },
  { page: "costs",     glyph: "receipt_long",   label: "Costs", soon: true },
];

function paintSidebar() {
  const aside = document.getElementById("tripSidebar");
  if (!aside) return;
  if (state.view !== "trip" || !state.trip) {
    aside.innerHTML = "";
    return;
  }

  const trip = state.trip;
  const dayCount = (trip.days || []).length;
  const initials = (trip.title || "Trip").trim().slice(0, 2).toUpperCase() || "··";
  const dateRange = formatTripDateRange(trip);
  const currentMode = modeForPage(state.page);

  const counts = {
    itinerary: dayCount ? `${dayCount}d` : "",
    prepare: (trip.checklist_items || []).filter((c) => !c.day_id).length || "",
    notes: (trip.notes || []).length || "",
    today: "",
    map: "", budget: "", costs: "",
  };

  const navItems = currentMode === "travel" ? NAV_TRAVEL : NAV_PLAN;
  const navHtml = navItems.map((n) => {
    const isActive = n.page === state.page;
    const isSoon = !!n.soon;
    const cls = [
      isActive ? "is-active" : "",
      isSoon ? "is-soon" : "",
    ].filter(Boolean).join(" ");
    const trailing = isSoon ? '<small class="vy-soon-badge">SOON</small>'
                            : `<small>${escapeText(String(counts[n.page] || ""))}</small>`;
    return `
      <button class="${cls}" data-page="${n.page}" title="${escapeText(n.label)}${isSoon ? " — proposed feature" : ""}">
        <span class="material-symbols-outlined" aria-hidden>${n.glyph}</span>
        <span>${escapeText(n.label)}</span>
        ${trailing}
      </button>
    `;
  }).join("");

  aside.innerHTML = `
    <div class="vy-brand-side">
      <strong>VOYAGE</strong>
      <span>— ∞ — INTEGRATED TRIP MANAGER</span>
    </div>

    <button class="vy-trip-switcher" id="sideBackBtn" title="Back to all trips">
      <span class="vy-trip-switcher-img">${escapeText(initials)}</span>
      <div class="vy-trip-switcher-text">
        <b>${escapeText(trip.title || "Untitled trip")}</b>
        <span>${escapeText(dateRange || "Dates not set")}</span>
      </div>
      <span class="material-symbols-outlined" aria-hidden>unfold_more</span>
    </button>

    <div class="vy-side-section">${currentMode === "travel" ? "Travel · in trip" : "Plan · before trip"}</div>
    <nav class="vy-side-nav" id="sideNavMode">${navHtml}</nav>

    <div class="vy-side-spacer"></div>

    <div class="vy-side-foot">
      <div class="vy-side-quick">
        <button data-page="members" class="${state.page === "members" ? "is-active" : ""}" title="Members &amp; roles">
          <span class="material-symbols-outlined" aria-hidden>group</span>
        </button>
        <button data-page="io"      class="${state.page === "io" ? "is-active" : ""}" title="Import / Export">
          <span class="material-symbols-outlined" aria-hidden>swap_vert</span>
        </button>
        <button data-page="overview" class="${state.page === "overview" ? "is-active" : ""}" title="Trip settings">
          <span class="material-symbols-outlined" aria-hidden>tune</span>
        </button>
        <button id="sidePrintBtn" title="Print preview">
          <span class="material-symbols-outlined" aria-hidden>print</span>
        </button>
      </div>

      <div class="vy-mode-switch" data-mode="${currentMode}">
        <button data-mode="plan"   class="${currentMode === "plan"   ? "is-active" : ""}">
          <span class="material-symbols-outlined" aria-hidden>edit_calendar</span>
          <b>PLAN</b>
          <small>Before trip</small>
        </button>
        <button data-mode="travel" class="${currentMode === "travel" ? "is-active" : ""}">
          <span class="material-symbols-outlined" aria-hidden>explore</span>
          <b>TRAVEL</b>
          <small>In trip</small>
        </button>
      </div>

      <div class="vy-side-user">
        <span class="vy-avatar vy-avatar--sm" title="${escapeText(state.user?.email || "")}"
              style="background:radial-gradient(120% 100% at 50% 0%, hsl(172 35% 92% / 0.9), hsl(172 25% 78% / 0.4))">
          <span>${escapeText(computeInitials(state.user?.email || "?"))}</span>
        </span>
        <div class="vy-side-user-text">
          <b>${escapeText(state.user?.email || "Signed in")}</b>
          <span>${escapeText((state.trip?.role || "viewer").toUpperCase())} ROLE</span>
        </div>
        <button id="sideSignOutBtn" class="vy-side-signout" title="Sign out">
          <span class="material-symbols-outlined" aria-hidden>logout</span>
        </button>
      </div>
    </div>
  `;

  aside.querySelectorAll("#sideNavMode button[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("is-soon")) return;
      navigate({ page: btn.dataset.page });
    });
  });
  aside.querySelectorAll(".vy-side-quick button[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => navigate({ page: btn.dataset.page }));
  });
  aside.querySelectorAll(".vy-mode-switch button[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = btn.dataset.mode;
      if (m === currentMode) return;
      // Switch to the default page of the target mode.
      const target = m === "travel" ? "today" : "itinerary";
      navigate({ page: target });
    });
  });
  const back = aside.querySelector("#sideBackBtn");
  if (back) back.addEventListener("click", () => navigate({ trip: null }));
  const printBtn = aside.querySelector("#sidePrintBtn");
  if (printBtn) printBtn.addEventListener("click", () => {
    if (state.trip) openPrintView(state.trip);
  });
  const signOutBtn = aside.querySelector("#sideSignOutBtn");
  if (signOutBtn) signOutBtn.addEventListener("click", async () => {
    try { await auth.signOut(); } catch (e) { toast(e.message, true); }
  });
}

// Voyage topbar — sits at the top of the main column on the trip view.
// Mirrors desktop.jsx: live-collab telemetry · search · notifications ·
// member avatars · Share trip. Search + notifications are stale this
// version; the member stack navigates to the Members page; Share trip
// copies the current URL to the clipboard.
function paintTopbar() {
  const bar = document.getElementById("tripTopbar");
  if (!bar) return;
  if (state.view !== "trip" || !state.trip) {
    bar.hidden = true; bar.innerHTML = "";
    return;
  }
  bar.hidden = false;

  const members = state.trip.members || [];
  const visibleMembers = members.slice(0, 4);
  const overflowCount = Math.max(0, members.length - visibleMembers.length);

  // Editors count: members with a role of owner/editor. If the trip
  // object doesn't carry members (e.g. solo trip), the count falls back
  // to the current user (1).
  const editors = members.filter((m) => {
    const r = (m.role || "").toLowerCase();
    return r === "owner" || r === "editor";
  }).length || 1;

  bar.innerHTML = `
    <div class="vy-topbar-live">
      <span class="vy-meta">
        <i class="vy-livedot" aria-hidden></i>
        LIVE COLLAB · <b id="topbarEditors">${editors}</b> EDITOR${editors === 1 ? "" : "S"} · LAST CHANGE
        <b id="topbarLastChange">${formatLastChange(state.lastChangeAt)}</b>
      </span>
    </div>
    <div class="vy-search" title="Search — coming soon" aria-disabled="true">
      <span class="material-symbols-outlined" aria-hidden>search</span>
      <span class="vy-search-placeholder">Search places, reservations, notes…</span>
      <span class="vy-search-spacer"></span>
      <kbd>⌘K</kbd>
    </div>
    <button class="vy-icon-btn" id="topbarNotifBtn" title="Notifications — coming soon" aria-disabled="true">
      <span class="material-symbols-outlined" aria-hidden>notifications</span>
    </button>
    <button class="vy-share-stack" id="topbarMembersBtn" title="Members &amp; roles">
      ${visibleMembers.map((m, i) => avatarHtml(m, i)).join("")}
      ${overflowCount ? `<span class="vy-avatar vy-avatar--more" title="${overflowCount} more"><span>+${overflowCount}</span></span>` : ""}
      ${!members.length ? `<span class="vy-avatar" style="background:linear-gradient(135deg,#dff1ec,#a8d6ca)"><span>···</span></span>` : ""}
    </button>
    <button class="vy-btn-primary" id="topbarShareBtn" title="Copy trip link">
      <span class="material-symbols-outlined" aria-hidden>ios_share</span>
      Share trip
    </button>
  `;

  bar.querySelector("#topbarMembersBtn").addEventListener("click", () => navigate({ page: "members" }));
  bar.querySelector("#topbarShareBtn").addEventListener("click", () => {
    const url = location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url)
        .then(() => toast("Trip link copied"))
        .catch(() => toast("Copy failed — try selecting the URL", true));
    } else {
      toast("Trip link: " + url);
    }
  });
  // Notification button is intentionally inert until the feature lands.
}

function avatarHtml(member, idx) {
  // Hue rotates by index so each member's avatar gets a distinct pastel.
  // 172 (viridian) and 42 (amber) match the design's MB/JW pair on first
  // two slots, then we walk the color wheel for further members.
  const hues = [172, 42, 198, 312, 102];
  const hue = hues[idx % hues.length];
  const name = member?.profile?.full_name || member?.email || "?";
  const initials = computeInitials(name);
  return `<span class="vy-avatar" style="background:radial-gradient(120% 100% at 50% 0%, hsl(${hue} 35% 92% / 0.9), hsl(${hue} 25% 78% / 0.4))" title="${escapeText(name)}"><span>${escapeText(initials)}</span></span>`;
}

function computeInitials(s) {
  const trimmed = String(s || "").trim();
  if (!trimmed) return "?";
  // Email — take the local-part's first 2 alphanums.
  if (trimmed.includes("@")) return trimmed.split("@")[0].replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
  // Name — first letter of first two words, fallback to first 2 chars.
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

function paintHero() {
  const host = document.getElementById("tripHero");
  if (!host) return;
  if (state.view !== "trip" || !state.trip) { host.hidden = true; host.innerHTML = ""; return; }

  const trip = state.trip;
  const cities = deriveCities(trip);
  const dayCount = (trip.days || []).length;
  const nightCount = Math.max(0, dayCount - 1);
  const travelerCount = (trip.members || []).length || 1;
  const range = formatTripDateRange(trip);

  host.hidden = false;
  host.innerHTML = `
    <div class="vy-hero-art" aria-hidden></div>
    <div class="vy-hero-left">
      <span class="vy-hero-tag"><i></i> ITINERARY · STATUS <b style="color:var(--vbl-viridian)"> ${trip.id ? "CONFIRMED" : "DRAFT"}</b></span>
      <h1 class="vy-hero-title">${escapeText(trip.title || "Untitled trip")}</h1>
      <div class="vy-hero-cities">
        ${cities.length
          ? cities.map((c, i) => `
              <span class="vy-citybadge">
                <b>${escapeText(cityCode(c))}</b>
                <span>${escapeText(c)}</span>
              </span>
              ${i < cities.length - 1 ? '<span class="vy-hero-sep">→</span>' : ""}
            `).join("")
          : '<span class="vy-meta">NO CITIES YET · ADD ONE TO A DAY</span>'}
      </div>
    </div>
    <div class="vy-hero-right">
      <div class="vy-hero-dates">${escapeText(range || "Dates not set")}</div>
      <div class="vy-hero-meta">${dayCount} DAY${dayCount === 1 ? "" : "S"} · ${nightCount} NIGHT${nightCount === 1 ? "" : "S"} · ${travelerCount} TRAVELER${travelerCount === 1 ? "" : "S"}</div>
      <div class="vy-hero-meta">TRIP · <b style="color:var(--vbl-viridian)">${escapeText((trip.id || "—").toString().slice(0, 8))}</b></div>
    </div>
  `;
}

function paintDayStrip() {
  const host = document.getElementById("tripDayStrip");
  if (!host) return;
  const showOn = new Set(["itinerary", "today"]);
  if (state.view !== "trip" || !state.trip || !showOn.has(state.page) || !(state.trip.days || []).length) {
    host.hidden = true; host.innerHTML = "";
    return;
  }
  const days = state.trip.days;
  const selectedIdx = state.selectedDayIdx;
  const role = (state.trip.role || "viewer").toLowerCase();
  const canEdit = role === "owner" || role === "editor";

  host.hidden = false;
  host.innerHTML = days.map((d, i) => {
    const wd = d.date ? new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" }).toUpperCase() : "DAY";
    const num = (i + 1).toString().padStart(2, "0");
    const city = (d.city || "").slice(0, 3).toUpperCase();
    const sel = i === selectedIdx ? "is-selected" : "";
    return `
      <button class="vy-daypill ${sel}" data-day-idx="${i}"
              ${canEdit ? "draggable=\"true\"" : ""}
              title="${escapeText(d.title || "Day " + (i + 1))}${canEdit ? "  ·  Drag to reorder, right-click for actions" : ""}">
        <span class="vy-daypill-wd">${wd}</span>
        <span class="vy-daypill-num">${num}</span>
        <span class="vy-daypill-city">${escapeText(city || "—")}</span>
      </button>
    `;
  }).join("");

  // Click: select that day. Same handler for itinerary and today — both
  // pages re-render against state.selectedDayIdx. No more "today jumps
  // to itinerary"; users can preview any day's today-recap view.
  host.querySelectorAll("button[data-day-idx]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // Suppress clicks that follow a drag (set in dragend below).
      if (btn._suppressClick) { btn._suppressClick = false; return; }
      state.selectedDayIdx = Number(btn.dataset.dayIdx);
      renderTripPage();
    });
  });

  if (!canEdit) return;

  // ── Drag-to-reorder via HTML5 D&D ─────────────────────────────────
  let dragFromIdx = null;
  host.querySelectorAll("button[data-day-idx]").forEach((btn) => {
    btn.addEventListener("dragstart", (e) => {
      dragFromIdx = Number(btn.dataset.dayIdx);
      btn.classList.add("is-dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        // Firefox needs *some* data to start the drag.
        e.dataTransfer.setData("text/plain", String(dragFromIdx));
      } catch {}
    });
    btn.addEventListener("dragend", () => {
      btn.classList.remove("is-dragging");
      host.querySelectorAll(".is-drop-target").forEach((n) => n.classList.remove("is-drop-target"));
      // Browser dispatches a click right after dragend on some platforms;
      // suppress one click so the dragged pill doesn't also "select".
      btn._suppressClick = true;
      setTimeout(() => { btn._suppressClick = false; }, 50);
    });
    btn.addEventListener("dragover", (e) => {
      if (dragFromIdx == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      host.querySelectorAll(".is-drop-target").forEach((n) => n.classList.remove("is-drop-target"));
      btn.classList.add("is-drop-target");
    });
    btn.addEventListener("dragleave", () => {
      btn.classList.remove("is-drop-target");
    });
    btn.addEventListener("drop", async (e) => {
      e.preventDefault();
      btn.classList.remove("is-drop-target");
      const toIdx = Number(btn.dataset.dayIdx);
      const fromIdx = dragFromIdx;
      dragFromIdx = null;
      if (fromIdx == null || fromIdx === toIdx) return;
      await reorderDay(fromIdx, toIdx);
    });
  });

  // ── Right-click context menu ──────────────────────────────────────
  host.querySelectorAll("button[data-day-idx]").forEach((btn) => {
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.dayIdx);
      openContextMenu(e.clientX, e.clientY, [
        { label: "Go to this day",  glyph: "open_in_new",
          onClick: () => { state.selectedDayIdx = idx; renderTripPage(); } },
        { label: "Move left",       glyph: "chevron_left",
          disabled: idx === 0,
          onClick: () => reorderDay(idx, idx - 1) },
        { label: "Move right",      glyph: "chevron_right",
          disabled: idx === days.length - 1,
          onClick: () => reorderDay(idx, idx + 1) },
        { type: "sep" },
        { label: "Delete this day", glyph: "delete", danger: true,
          onClick: () => deleteDayConfirm(days[idx]) },
      ]);
    });
  });
}

// Reorder days[fromIdx] to be at position toIdx, then persist via
// daysApi.reorder. Keeps state.selectedDayIdx pointing at the same DAY
// (not the same index) so the user's selection follows the move.
async function reorderDay(fromIdx, toIdx) {
  const arr = (state.trip?.days || []).slice();
  if (fromIdx < 0 || fromIdx >= arr.length || toIdx < 0 || toIdx >= arr.length) return;
  const [moved] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, moved);
  // Track which day was selected before the move so we can preserve it.
  const selDay = state.trip.days[state.selectedDayIdx];
  noteSaveStart();
  try {
    await daysApi.reorder(arr.map((d) => d.id));
    await refreshTrip();
    const newIdx = state.trip.days.findIndex((d) => d.id === selDay?.id);
    if (newIdx >= 0) state.selectedDayIdx = newIdx;
    paintTabs();
  } catch (e) {
    toast("Reorder failed: " + e.message, true);
  } finally {
    noteSaveDone();
  }
}

async function deleteDayConfirm(day) {
  if (!day) return;
  if (!confirm("Delete this day and everything in it?")) return;
  noteSaveStart();
  try {
    await daysApi.remove(day.id);
    await refreshTrip();
    // Clamp selectedDayIdx in case the deleted day was the last one.
    const max = Math.max(0, (state.trip?.days || []).length - 1);
    if (state.selectedDayIdx > max) state.selectedDayIdx = max;
    paintTabs();
  } catch (e) {
    toast("Delete failed: " + e.message, true);
  } finally {
    noteSaveDone();
  }
}

// ───────────────────────────────────────────────────────────────────
// Custom right-click context menu
//
// A tiny floating menu rendered into a singleton container. Each call
// to openContextMenu replaces the previous one. The menu closes on any
// outside pointerdown, on Escape, on scroll, or on resize.
//
// Items: { label, glyph?, onClick, disabled?, danger?, type? }
//   - type:'sep' renders a thin divider
//   - disabled items don't fire onClick
// ───────────────────────────────────────────────────────────────────
function openContextMenu(x, y, items) {
  closeContextMenu();
  const el = document.createElement("div");
  el.id = "vy-ctxmenu";
  el.className = "vy-ctxmenu";
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.innerHTML = items.map((it) => {
    if (it.type === "sep") return `<hr>`;
    const cls = [it.danger ? "is-danger" : "", it.disabled ? "is-disabled" : ""].filter(Boolean).join(" ");
    return `<button class="${cls}" ${it.disabled ? "disabled" : ""}>
      ${it.glyph ? `<span class="material-symbols-outlined">${it.glyph}</span>` : ""}
      <span>${escapeText(it.label)}</span>
    </button>`;
  }).join("");
  document.body.appendChild(el);
  // Clamp inside viewport so a click near the right edge doesn't render
  // the menu off-screen.
  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 4)  el.style.left = `${window.innerWidth - r.width - 4}px`;
  if (r.bottom > window.innerHeight - 4) el.style.top  = `${window.innerHeight - r.height - 4}px`;

  let realIdx = 0;
  el.querySelectorAll("button, hr").forEach((node) => {
    if (node.tagName === "HR") return;
    const myIdx = realIdx++;
    const meta = items.filter((it) => it.type !== "sep")[myIdx];
    if (meta && meta.onClick && !meta.disabled) {
      node.addEventListener("click", () => {
        closeContextMenu();
        try { meta.onClick(); } catch (e) { console.error(e); }
      });
    }
  });

  const off = (e) => { if (!el.contains(e.target)) closeContextMenu(); };
  const onKey = (e) => { if (e.key === "Escape") closeContextMenu(); };
  setTimeout(() => {
    document.addEventListener("pointerdown", off, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("resize", closeContextMenu);
  }, 0);
  el._teardown = () => {
    document.removeEventListener("pointerdown", off, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", closeContextMenu, true);
    window.removeEventListener("resize", closeContextMenu);
  };
}

function closeContextMenu() {
  const el = document.getElementById("vy-ctxmenu");
  if (!el) return;
  if (typeof el._teardown === "function") el._teardown();
  el.remove();
}

function deriveCities(trip) {
  const seen = new Set();
  const out = [];
  for (const d of trip.days || []) {
    const c = (d.city || "").trim();
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    out.push(c);
  }
  return out;
}

function cityCode(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "—";
  return trimmed.slice(0, 3).toUpperCase();
}

function formatTripDateRange(trip) {
  const days = (trip.days || []).filter((d) => d.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return "";
  const fmt = (s) => {
    const d = new Date(s + "T00:00:00");
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const start = fmt(days[0].date);
  const end = fmt(days[days.length - 1].date);
  const yr = new Date(days[0].date + "T00:00:00").getFullYear();
  return start === end ? `${start}, ${yr}` : `${start} → ${end}, ${yr}`;
}

function escapeText(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function paintHeader() {
  const userBadge = document.getElementById("userBadge");
  const signOutBtn = document.getElementById("signOutBtn");
  const backBtn = document.getElementById("backToTripsBtn");
  const saveEl = document.getElementById("saveStatus");

  if (state.user?.email) {
    userBadge.hidden = false;
    userBadge.textContent = state.user.email;
    signOutBtn.hidden = false;
  } else {
    userBadge.hidden = true;
    signOutBtn.hidden = true;
  }

  backBtn.hidden = !(state.view === "trip" && state.user);
  document.getElementById("printTripBtn").hidden = !(state.view === "trip" && state.trip);
  saveEl.hidden = state.view !== "trip";
  if (state.view === "trip") {
    if (state.saving > 0) {
      saveEl.dataset.kind = "saving";
      saveEl.textContent = "Saving…";
    } else {
      saveEl.dataset.kind = "clean";
      saveEl.textContent = "Saved";
    }
  }

  // Topbar last-change text — update without redoing paintTopbar so the
  // pulsing dot doesn't restart on every keystroke / tick.
  const topbarLastChange = document.getElementById("topbarLastChange");
  if (topbarLastChange) {
    topbarLastChange.textContent = formatLastChange(state.lastChangeAt);
  }
}

// Format the relative-time label shown after "LAST CHANGE" in the topbar.
// Coarse buckets — we don't need second-precision since the value ticks
// every ~10s on a setInterval, and trip edits are usually minutes apart.
function formatLastChange(ts) {
  if (!ts) return "—";
  const delta = Math.max(0, Date.now() - ts);
  const s = Math.floor(delta / 1000);
  if (s < 5)      return "just now";
  if (s < 60)     return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)    return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)    return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// Tick the "LAST CHANGE 11s" label every 10s while a trip is open so the
// relative time stays roughly accurate without re-rendering the topbar.
let __topbarTick = null;
function startTopbarTick() {
  if (__topbarTick) return;
  __topbarTick = setInterval(() => {
    if (state.view !== "trip") return;
    const node = document.getElementById("topbarLastChange");
    if (node) node.textContent = formatLastChange(state.lastChangeAt);
  }, 10_000);
}
function stopTopbarTick() {
  if (__topbarTick) { clearInterval(__topbarTick); __topbarTick = null; }
}

// ===== Save activity tracker (used by pages) =====

function noteSaveStart() {
  state.saving++;
  paintHeader();
}
function noteSaveDone() {
  state.saving = Math.max(0, state.saving - 1);
  state.lastChangeAt = Date.now();
  paintHeader();
}

// ===== Toast =====

let toastTimer = null;
export function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ===== Settings dialog =====

function bindSettings() {
  const dlg = document.getElementById("settingsDialog");
  const url = document.getElementById("sbUrl");
  const key = document.getElementById("sbKey");

  document.getElementById("settingsBtn").addEventListener("click", () => {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("itinerary-studio:cloud") || "{}"); } catch {}
    url.value = stored.url || "";
    key.value = stored.key || "";
    document.getElementById("sbConfigSource").textContent =
      "Currently using config from: " + configSource();
    dlg.showModal();
  });

  dlg.addEventListener("close", async () => {
    const action = dlg.returnValue;
    if (action === "connect") {
      localStorage.setItem("itinerary-studio:cloud", JSON.stringify({
        url: url.value.trim(), key: key.value.trim(),
      }));
      location.reload();
    } else if (action === "disconnect") {
      localStorage.removeItem("itinerary-studio:cloud");
      location.reload();
    }
  });
}

function showUnconfigured() {
  document.getElementById("view-auth").hidden = false;
  document.getElementById("view-auth").innerHTML = `
    <div class="auth-card">
      <h1>Trip Studio</h1>
      <p>This app needs a Supabase backend to store trips. Click ⚙ in the top right to configure your project URL + publishable key, or deploy with the included GitHub Actions workflow that bakes them in from repo Secrets.</p>
    </div>
  `;
}
