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
import { renderIO } from "./pages/io.js";
import { openPrintView } from "./pages/print-view.js";

const PAGES = {
  overview: renderOverview,
  itinerary: renderItinerary,
  prepare: renderPrepare,
  today: renderToday,
  notes: renderNotes,
  io: renderIO,
};

const state = {
  view: "auth",
  user: null,
  recoveryMode: false,
  trip: null,           // full trip object from trips.getFull
  page: "overview",
  saving: 0,            // active save count for the global indicator
};

// ===== Boot =====

window.addEventListener("DOMContentLoaded", async () => {
  bindAppHeader();
  bindTabs();
  bindSettings();

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
    syncUrl({ trip: id, page: state.page });
    setView("trip");
    renderTripPage();
  } catch (e) {
    toast("Could not open trip: " + e.message, true);
    syncUrl({});
    setView("trips");
  }
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
  const host = document.getElementById("tripPage");
  host.innerHTML = "";
  const fn = PAGES[state.page] || PAGES.overview;
  fn(host, {
    trip: state.trip,
    role: state.trip?.role || "viewer",
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
  document.querySelectorAll("#tripTabs button, #mobileNav button").forEach((btn) => {
    btn.addEventListener("click", () => navigate({ page: btn.dataset.page }));
  });
}

function paintTabs() {
  document.querySelectorAll("#tripTabs button, #mobileNav button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === state.page);
  });
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
