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
  host.hidden = false;
  host.innerHTML = days.map((d, i) => {
    const wd = d.date ? new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" }).toUpperCase() : "DAY";
    const num = (i + 1).toString().padStart(2, "0");
    const city = (d.city || "").slice(0, 3).toUpperCase();
    const sel = i === selectedIdx ? "is-selected" : "";
    return `
      <button class="vy-daypill ${sel}" data-day-idx="${i}" title="${escapeText(d.title || "Day " + (i + 1))}">
        <span class="vy-daypill-wd">${wd}</span>
        <span class="vy-daypill-num">${num}</span>
        <span class="vy-daypill-city">${escapeText(city || "—")}</span>
      </button>
    `;
  }).join("");
  // Clicking a pill selects that day. On itinerary, that swaps the rendered
  // day; on today, it doesn't change today's auto-pick but lands on the
  // itinerary view for that day so users have one expected affordance.
  host.querySelectorAll("button[data-day-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.dayIdx);
      state.selectedDayIdx = idx;
      if (state.page !== "itinerary") {
        navigate({ page: "itinerary" });
      } else {
        renderTripPage();
      }
    });
  });
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

  const foot = document.getElementById("tripFootMeta");
  if (foot) {
    foot.textContent = state.view === "trip"
      ? (state.saving > 0 ? "· SYNCING NOW…" : "· SYNCED · DRAFT v∞")
      : "";
  }
}

// ===== Save activity tracker (used by pages) =====

function noteSaveStart() {
  state.saving++;
  paintHeader();
}
function noteSaveDone() {
  state.saving = Math.max(0, state.saving - 1);
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
