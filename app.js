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
  initSupabase, isConfigured, configSource, auth, trips, share, members,
  profile as profileApi, days as daysApi, packItems,
} from "./supabase.js";
import { renderAuthView } from "./auth.js";
import { renderShareLanding } from "./pages/share-landing.js";
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
import { renderMobileStub } from "./pages/mobile/_stub.js";
import { renderMobileShell } from "./pages/mobile/_shell.js";
import { renderMobileToday } from "./pages/mobile/today.js";
import { renderMobileDetail } from "./pages/mobile/detail.js";
import { renderMobileItinerary } from "./pages/mobile/itinerary.js";
import { renderMobilePack } from "./pages/mobile/pack.js";
import { openPrintView } from "./pages/print-view.js";
import { el, formatRelativeTime } from "./pages/_utils.js";

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

// ===== Platform detection (mobile vs desktop) =====
//
// Mobile is a fundamentally different view tree (pages/mobile/*),
// not a narrowed desktop. We branch at the top via state.platform.
// matchMedia gives us boot-time detection plus a live change listener
// so devtools-resize testing and tablet orientation flips re-route.

const MOBILE_MQ = "(max-width: 767px)";

function detectPlatform() {
  if (typeof window === "undefined" || !window.matchMedia) return "desktop";
  return window.matchMedia(MOBILE_MQ).matches ? "mobile" : "desktop";
}

function readMobileMode() {
  try {
    return localStorage.getItem("voyage:mobile-mode") === "overview"
      ? "overview" : "travel";
  } catch { return "travel"; }
}
function writeMobileMode(m) {
  state.mobileMode = m;
  try { localStorage.setItem("voyage:mobile-mode", m); } catch {}
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

  // Mobile-specific state. platform is set at boot and on matchMedia
  // change; mobileMode persists in localStorage; lastNonDetailPage is
  // tracked for the mobile Detail screen's back-arrow behaviour.
  platform: detectPlatform(),
  mobileMode: readMobileMode(),
  lastNonDetailPage: null,
  selectedItemId: null,
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

  // Re-route on viewport breakpoint crossing. Live listener so that
  // resizing the window through 767px (devtools, orientation flip)
  // swaps between desktop and mobile view trees without a refresh.
  if (window.matchMedia) {
    const mq = window.matchMedia(MOBILE_MQ);
    const onPlatformChange = (e) => {
      const next = e.matches ? "mobile" : "desktop";
      if (next === state.platform) return;
      state.platform = next;
      document.body.dataset.platform = next;
      // Re-paint the current view through the platform-aware router.
      if (state.view === "trip") {
        renderTripPage();
      } else {
        setView(state.view);
      }
    };
    if (mq.addEventListener) mq.addEventListener("change", onPlatformChange);
    else if (mq.addListener) mq.addListener(onPlatformChange);  // legacy Safari
  }

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

// Default landing page depends on viewport — mobile users almost
// always want "Today" (the day-of view), while desktop users land on
// the planning Overview. Re-evaluated every navigation so a rotation
// or window resize on the boundary takes effect next click.
function defaultLandingPage() {
  try {
    if (window.matchMedia?.("(max-width: 900px)").matches) return "today";
  } catch {}
  return "overview";
}

async function routeFromUrl() {
  paintHeader();
  if (state.recoveryMode) { setView("auth"); return; }

  const url = new URL(location.href);
  const tripId = url.searchParams.get("trip");
  const page = url.searchParams.get("page") || defaultLandingPage();

  // Share-link branch. A `#share=<token>` fragment overrides the
  // normal routing — we either show the landing screen (no session)
  // or silently redeem and route into the trip (any session).
  const shareToken = share.readTokenFromUrl();
  if (shareToken) {
    if (state.user) {
      try {
        const redeemedTripId = await share.redeem(shareToken);
        share.stripTokenFromUrl();
        await openTrip(redeemedTripId, page);
      } catch (e) {
        share.stripTokenFromUrl();
        toast("Could not open shared trip: " + e.message, true);
        if (state.user) setView("trips"); else setView("auth");
      }
      return;
    }
    // No session: render the landing screen. The fragment stays in
    // the URL — if the visitor picks Sign in / Sign up and authenticates,
    // handleAuthChange will re-run routeFromUrl, see the fragment and
    // a session, and fall into the silent-redeem branch above.
    setView("share-landing");
    return;
  }

  if (!state.user) { setView("auth"); return; }

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
  document.body.dataset.platform = state.platform;
  document.getElementById("view-auth").hidden = view !== "auth";
  document.getElementById("view-share-landing").hidden = view !== "share-landing";
  document.getElementById("view-trips").hidden = view !== "trips";
  document.getElementById("view-trip").hidden = view !== "trip";
  document.getElementById("mobileNav").hidden = view !== "trip";

  if (view === "trip") startTopbarTick();
  else stopTopbarTick();

  if (view === "auth") {
    renderAuthView(document.getElementById("view-auth"), {
      initialMode: state.pendingAuthMode || (state.recoveryMode ? "reset" : "sign-in"),
      onPasswordReset: () => {
        state.recoveryMode = false;
        history.replaceState(null, "", window.location.pathname + window.location.search);
        routeFromUrl();
      },
    });
    state.pendingAuthMode = null;
  } else if (view === "share-landing") {
    const token = share.readTokenFromUrl();
    renderShareLanding(document.getElementById("view-share-landing"), {
      token,
      onAuthRequest: (mode) => {
        // Flip to the auth view; share fragment stays in URL, so a
        // successful sign-in will fall through to silent redeem.
        state.pendingAuthMode = mode;
        setView("auth");
      },
      onRedeemed: (tripId) => {
        // signInAnonymously fires onAuthStateChange asynchronously,
        // which triggers routeFromUrl — but the share fragment has
        // already been stripped by the landing screen, so the auto
        // route would fall back to the dashboard. Call openTrip
        // directly to get there immediately.
        openTrip(tripId, defaultLandingPage());
      },
      onError: (err) => {
        console.error("Share landing error:", err);
      },
    });
  } else if (view === "trips") {
    renderTripsLobby();
  }
  paintHeader();
}

// ===== Trips lobby =====
//
// Renders the dashboard with a profile card on top. Profile is fetched
// best-effort — if the read fails (transient RLS hiccup, etc.) we still
// show the trips list with whatever we know from the session.

async function renderTripsLobby() {
  let userProfile = null;
  try { userProfile = await profileApi.getMine(); }
  catch (e) { console.warn("Could not load profile:", e); }

  renderDashboard(document.getElementById("view-trips"), {
    user: state.user,
    profile: userProfile,
    isAnonymous: !!state.user?.is_anonymous,
    onOpen: (id) => navigate({ trip: id, page: defaultLandingPage() }),
    onNewTrip: () => openNewTripDialog(),
    onCreateBlocked: () => openConvertDialog(),
    onChangeDisplayName: async (name) => {
      await profileApi.updateDisplayName(name);
    },
    onChangePassword: () => openPasswordDialog(),
    onSignOut: async () => {
      try { await auth.signOut(); } catch (e) { toast(e.message, true); }
    },
    onConvert: () => openConvertDialog(),
  });
}

// ===== Trip loading =====

export async function openTrip(id, page) {
  if (!page) page = defaultLandingPage();
  try {
    const trip = await trips.getFull(id);
    state.trip = trip;
    // Fetch the roster so item editors can resolve created_by UIDs into
    // display names ("added by Alice 2d ago") AND the topbar avatar
    // stack can render real avatars instead of a placeholder. Best-
    // effort: if the call fails (transient RLS hiccup, etc.) we degrade
    // to no attribution text rather than blocking the trip from opening.
    state.trip.members = [];
    state.trip.membersById = {};
    state.trip.pack_items = [];
    try {
      const memberRows = await members.list(id);
      state.trip.members = memberRows;
      for (const m of memberRows) state.trip.membersById[m.user_id] = m;
    } catch (e) {
      console.warn("Could not fetch members for attribution:", e);
    }
    // Pack items power the mobile Today reminder box and the Overview
    // Pack tab. Same best-effort pattern as members — degrade silently
    // if the call fails rather than blocking the trip from opening.
    try {
      state.trip.pack_items = await packItems.list(id);
    } catch (e) {
      console.warn("Could not fetch pack items:", e);
    }
    state.page = PAGES[page] ? page : defaultLandingPage();
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

// Mobile page table. Each entry will be replaced by a real renderer
// as the mobile redesign slices ship. For now everything maps to the
// shared stub; the platform branch in renderTripPage picks the mobile
// renderer when state.platform === 'mobile'. Pages that exist in
// MOBILE_PAGES but not in PAGES (e.g. pack, detail) are mobile-only
// and only reachable when state.platform is mobile.
const MOBILE_PAGES = {
  today:     renderMobileToday,
  map:       renderMobileStub,
  costs:     renderMobileStub,
  notes:     renderMobileStub,
  itinerary: renderMobileItinerary,
  prepare:   renderMobileStub,
  budget:    renderMobileStub,
  pack:      renderMobilePack,
  detail:    renderMobileDetail,
  overview:  renderMobileStub,
  members:   renderMobileStub,
  io:        renderMobileStub,
};

function renderTripPage() {
  // Clamp selectedDayIdx in case the trip lost days since it was set.
  const dayCount = (state.trip?.days || []).length;
  if (state.selectedDayIdx >= dayCount) state.selectedDayIdx = Math.max(0, dayCount - 1);
  if (state.selectedDayIdx < 0) state.selectedDayIdx = 0;

  const host = document.getElementById("tripPage");
  host.innerHTML = "";

  const ctx = {
    trip: state.trip,
    role: state.trip?.role || "viewer",
    isAnonymous: !!state.user?.is_anonymous,
    membersById: state.trip?.membersById || {},
    selectedDayIdx: state.selectedDayIdx,
    setSelectedDayIdx: (idx) => {
      const max = Math.max(0, (state.trip?.days || []).length - 1);
      state.selectedDayIdx = Math.min(Math.max(0, idx), max);
      renderTripPage();
    },
    refresh: refreshTrip,
    // Local re-render against current state without re-fetching from
    // the server — used for optimistic UI updates after a drag reorder
    // so the user sees the new order instantly while the API call
    // runs in the background.
    rerender: renderTripPage,
    navigate,
    onSaveStart: noteSaveStart,
    onSaveDone: noteSaveDone,
    onTitleChange: handleTripTitleChange,
    openContextMenu,
    toast,
    // Mobile-only context. Pages can ignore these on desktop.
    page: state.page,
    mobileMode: state.mobileMode,
    setMobileMode: writeMobileMode,
    lastNonDetailPage: state.lastNonDetailPage,
    selectedItemId: state.selectedItemId,
    openShare: () => toggleShareMenu(),
    openPrint: () => state.trip && openPrintView(state.trip),
    signOut: async () => {
      try { await auth.signOut(); } catch (e) { toast(e.message, true); }
    },
  };

  // Mobile branches into the pages/mobile/* renderer table; desktop
  // uses the existing PAGES table. Both share the same ctx shape so
  // mobile pages can reuse helpers (refresh, rerender, toast, etc.).
  // The mobile shell wraps the page renderer with header + tab bar.
  if (state.platform === "mobile") {
    const slot = renderMobileShell(host, ctx);
    const fn = MOBILE_PAGES[state.page] || renderMobileStub;
    fn(slot, ctx);
  } else {
    const fn = PAGES[state.page] || PAGES.overview;
    fn(host, ctx);
  }

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
  // We strip ?page only when it equals the viewport's default (overview
  // on desktop, today on mobile) so the URL stays clean for the common
  // landing target on each device.
  const stripDefault = defaultLandingPage();
  if ("page" in opts) {
    if (opts.page && opts.page !== stripDefault) url.searchParams.set("page", opts.page);
    else url.searchParams.delete("page");
  }
  // `item` is used by the mobile Detail drill-in to point at a specific
  // itinerary_items row. Cleared whenever we navigate away from a page
  // that uses it (everything except `detail`).
  if ("item" in opts) {
    if (opts.item) url.searchParams.set("item", opts.item);
    else url.searchParams.delete("item");
  } else if ("page" in opts && opts.page !== "detail") {
    url.searchParams.delete("item");
  }
  history.replaceState(null, "", url);

  const tripId = url.searchParams.get("trip");
  const page = url.searchParams.get("page") || stripDefault;

  if (!tripId) {
    state.trip = null;
    setView("trips");
    return;
  }

  // Same trip, different page: just swap pages without refetching.
  if (state.trip && state.trip.id === tripId) {
    const table = state.platform === "mobile" ? MOBILE_PAGES : PAGES;
    const resolved = table[page] ? page : stripDefault;
    // Track the previous non-detail page so the mobile detail screen's
    // back arrow knows where to return.
    if (state.page !== "detail") state.lastNonDetailPage = state.page;
    state.page = resolved;
    state.selectedItemId = url.searchParams.get("item") || null;
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
  const stripDefault = defaultLandingPage();
  if (page && page !== stripDefault) url.searchParams.set("page", page);
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
  document.getElementById("guestChipBtn").addEventListener("click", () => {
    openConvertDialog();
  });
  bindConvertDialog();
  bindNewTripDialog();
  bindPasswordDialog();
}

function setDialogStatus(el, msg, isError = false) {
  el.textContent = msg || "";
  el.hidden = !msg;
  el.classList.toggle("error", !!isError);
}

// ===== Share popover (drop-down menu) =====
// Quick-copy menu for the trip header's Share button. Lists every
// active share link as a row; click-anywhere on a row copies that
// link's URL. Empty state lazily mints a default editor link so the
// first click always produces something copyable. Power-user actions
// (labeled mint, expiry, revoke) live on the Members page, one click
// away via the pinned footer button.
//
// Uses the native popover="auto" element so click-outside dismissal,
// Escape handling, and top-layer stacking are free.

function toggleShareMenu() {
  if (!state.trip || state.trip.role !== "owner") return;
  const menu = document.getElementById("shareMenu");
  if (menu.matches(":popover-open")) {
    menu.hidePopover();
    return;
  }
  openShareMenu();
}

async function openShareMenu() {
  const menu = document.getElementById("shareMenu");
  const body = document.getElementById("shareMenuBody");
  body.innerHTML = "";
  body.appendChild(el("div", { class: "share-menu-loading muted small", text: "Loading…" }));
  document.getElementById("shareManageLink").href =
    buildUrl({ trip: state.trip.id, page: "members" });

  positionShareMenu(menu);
  menu.showPopover();

  let links;
  try {
    links = await share.list(state.trip.id);
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "share-menu-error error small",
      text: "Could not load links: " + (e.message || e) }));
    return;
  }

  // Filter expired client-side. The Members page intentionally still
  // shows them (struck through) so owners can revoke; the popover
  // hides them so the quick-copy surface stays focused on what works.
  const now = Date.now();
  let active = links.filter((l) => !l.expires_at || Date.parse(l.expires_at) >= now);

  // Empty-state auto-mint: if the trip has no live links yet, create
  // a default editor link before rendering. The 80% case is "I want
  // to share this trip" — don't make them decide a role first.
  if (active.length === 0) {
    try {
      await share.mint(state.trip.id, "editor", null);
      const reloaded = await share.list(state.trip.id);
      active = reloaded.filter((l) => !l.expires_at || Date.parse(l.expires_at) >= now);
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "share-menu-error error small",
        text: "Could not create link: " + (e.message || e) }));
      return;
    }
  }

  // Sort: defaults first (editor then viewer), labeled by created_at desc.
  active.sort((a, b) => {
    const aDef = !a.label, bDef = !b.label;
    if (aDef !== bDef) return aDef ? -1 : 1;
    if (aDef && bDef) {
      if (a.role !== b.role) return a.role === "editor" ? -1 : 1;
      return 0;
    }
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });

  // Render. Insert a thin separator between the default block and the
  // labeled block when both exist.
  body.innerHTML = "";
  let lastWasDefault = null;
  for (const link of active) {
    const isDefault = !link.label;
    if (lastWasDefault === true && !isDefault) {
      body.appendChild(el("div", { class: "share-menu-divider" }));
    }
    body.appendChild(renderShareMenuRow(link));
    lastWasDefault = isDefault;
  }

  // Re-position after content size settles (height may have grown).
  positionShareMenu(menu);
}

function renderShareMenuRow(link) {
  const isDefault = !link.label;
  const labelText = isDefault ? "Default link" : link.label;
  const roleKind = link.role === "viewer" ? "viewer" : "editor";

  const metaBits = [];
  if (link.expires_at) {
    const d = new Date(link.expires_at);
    metaBits.push(`expires ${d.toLocaleDateString()}`);
  }
  const rel = link.created_at ? formatRelativeTime(link.created_at) : null;
  if (rel) metaBits.push(`created ${rel}`);

  const row = el("button", { class: "share-menu-row", type: "button" });
  const content = el("div", { class: "share-menu-row-content" });
  content.appendChild(el("div", { class: "share-menu-row-header" },
    el("span", { class: "share-menu-row-label", text: labelText }),
    el("span", {
      class: `share-menu-row-role share-menu-row-role--${roleKind}`,
      text: link.role.toUpperCase(),
    }),
  ));
  if (metaBits.length) {
    content.appendChild(el("div", {
      class: "share-menu-row-meta muted small",
      text: metaBits.join(" · "),
    }));
  }
  const icon = el("span", { class: "share-menu-row-icon", "aria-hidden": "true", text: "📋" });
  row.append(content, icon);

  row.addEventListener("click", async () => {
    const url = share.buildUrl(state.trip.id, link.token);
    try {
      await navigator.clipboard.writeText(url);
      row.classList.add("share-menu-row--copied");
      icon.textContent = "✓";
      setTimeout(() => {
        row.classList.remove("share-menu-row--copied");
        icon.textContent = "📋";
      }, 1000);
    } catch {
      row.classList.add("share-menu-row--error");
      icon.textContent = "!";
      setTimeout(() => {
        row.classList.remove("share-menu-row--error");
        icon.textContent = "📋";
      }, 1500);
    }
  });

  return row;
}

// Position the popover under the topbar Share button, right-edge
// aligned to the button, clamped to stay on-screen on narrow viewports.
function positionShareMenu(menu) {
  const btn = document.getElementById("topbarShareBtn");
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 340;
  let right = window.innerWidth - r.right;
  const maxRight = window.innerWidth - menuWidth - 8;
  right = Math.min(right, maxRight);
  menu.style.right = `${Math.max(8, right)}px`;
  menu.style.top   = `${r.bottom + 6}px`;
  menu.style.left  = "auto";
  menu.style.bottom = "auto";
}

// Re-clamp position on viewport resize so a window resize doesn't push
// the menu offscreen. Keeps the dismissal-on-resize behavior of the
// previous dialog by just hiding if the trigger button has moved away.
window.addEventListener("resize", () => {
  const menu = document.getElementById("shareMenu");
  if (menu && menu.matches(":popover-open")) positionShareMenu(menu);
});

// ===== New trip dialog =====
//
// Captures title (required), destination, date range, travelers, and
// a blank-vs-sample template choice up front so the user doesn't land
// inside an "Untitled trip" with nothing to anchor on. Anon guests get
// routed through openConvertDialog by the dashboard, so this only ever
// opens for signed-in accounts.

function openNewTripDialog() {
  const dlg = document.getElementById("newTripDialog");
  dlg.querySelector("#newTripTitle").value = "";
  dlg.querySelector("#newTripDestination").value = "";
  dlg.querySelector("#newTripStart").value = "";
  dlg.querySelector("#newTripEnd").value = "";
  dlg.querySelector("#newTripTravelers").value = "";
  const blankRadio = dlg.querySelector('input[name="newTripTemplate"][value="blank"]');
  if (blankRadio) blankRadio.checked = true;
  setDialogStatus(dlg.querySelector("#newTripDialogStatus"), "");
  dlg.querySelector("#newTripSubmit").disabled = false;
  dlg.showModal();
  // Focus the title field once the dialog is open.
  setTimeout(() => dlg.querySelector("#newTripTitle")?.focus(), 30);
}

function bindNewTripDialog() {
  const dlg = document.getElementById("newTripDialog");
  if (!dlg) return;
  const form = dlg.querySelector("form");
  const submit = dlg.querySelector("#newTripSubmit");
  const statusEl = dlg.querySelector("#newTripDialogStatus");

  form.addEventListener("submit", async (e) => {
    if (dlg.returnValue === "cancel") return;
    e.preventDefault();

    const title       = dlg.querySelector("#newTripTitle").value.trim();
    const destination = dlg.querySelector("#newTripDestination").value.trim();
    const startDate   = dlg.querySelector("#newTripStart").value || "";
    const endDate     = dlg.querySelector("#newTripEnd").value   || "";
    const travelers   = dlg.querySelector("#newTripTravelers").value
      .split(",").map((s) => s.trim()).filter(Boolean);
    const template    = dlg.querySelector('input[name="newTripTemplate"]:checked')?.value || "blank";

    if (!title) {
      setDialogStatus(statusEl, "Title is required.", true);
      return;
    }
    if (startDate && endDate && startDate > endDate) {
      setDialogStatus(statusEl, "End date must be on or after the start date.", true);
      return;
    }

    submit.disabled = true;
    setDialogStatus(statusEl, "Creating…");

    try {
      let newId;
      if (template === "sample") {
        const res = await fetch("./sample.json");
        if (!res.ok) throw new Error("sample.json not found");
        const payload = await res.json();
        // Merge the user's metadata over the sample's so the dates,
        // title, destination, and travelers reflect their trip — but
        // keep all the sample's days/items/checklists/notes.
        payload.trip = {
          ...(payload.trip || {}),
          title,
          destination: destination || (payload.trip?.destination || ""),
          start_date: startDate || payload.trip?.start_date || null,
          end_date:   endDate   || payload.trip?.end_date   || null,
          travelers:  travelers.length ? travelers : (payload.trip?.travelers || []),
        };
        newId = await trips.createFromJson(payload);
      } else {
        newId = await trips.createFromJson({
          trip: {
            title,
            destination,
            start_date: startDate || null,
            end_date: endDate || null,
            travelers,
          },
        });
      }
      dlg.close("created");
      // Land on Itinerary so the next click is "add a day" — the
      // place where the user actually starts building.
      navigate({ trip: newId, page: "itinerary" });
    } catch (err) {
      setDialogStatus(statusEl, err?.message || String(err), true);
      submit.disabled = false;
    }
  });
}

// ===== Change password dialog =====

function openPasswordDialog() {
  const dlg = document.getElementById("passwordDialog");
  dlg.querySelector("#newPassword").value = "";
  dlg.querySelector("#newPasswordConfirm").value = "";
  setDialogStatus(dlg.querySelector("#passwordDialogStatus"), "");
  dlg.querySelector("#passwordSubmit").disabled = false;
  dlg.showModal();
  setTimeout(() => dlg.querySelector("#newPassword")?.focus(), 30);
}

function bindPasswordDialog() {
  const dlg = document.getElementById("passwordDialog");
  if (!dlg) return;
  const form = dlg.querySelector("form");
  const submit = dlg.querySelector("#passwordSubmit");
  const statusEl = dlg.querySelector("#passwordDialogStatus");

  form.addEventListener("submit", async (e) => {
    if (dlg.returnValue === "cancel") return;
    e.preventDefault();
    const pwd = dlg.querySelector("#newPassword").value;
    const confirm = dlg.querySelector("#newPasswordConfirm").value;
    if (pwd.length < 6) {
      setDialogStatus(statusEl, "Password must be at least 6 characters.", true);
      return;
    }
    if (pwd !== confirm) {
      setDialogStatus(statusEl, "Passwords don't match.", true);
      return;
    }
    submit.disabled = true;
    setDialogStatus(statusEl, "Updating…");
    try {
      await auth.updatePassword(pwd);
      setDialogStatus(statusEl, "Password updated.");
      setTimeout(() => dlg.close("updated"), 600);
    } catch (err) {
      setDialogStatus(statusEl, err?.message || String(err), true);
      submit.disabled = false;
    }
  });
}

// ===== Convert (anon → registered) dialog =====

function openConvertDialog() {
  const dlg = document.getElementById("convertDialog");
  document.getElementById("convertEmail").value = "";
  document.getElementById("convertPassword").value = "";
  setDialogStatus(document.getElementById("convertDialogStatus"), "");
  dlg.showModal();
}

function bindConvertDialog() {
  const dlg = document.getElementById("convertDialog");
  const submit = document.getElementById("convertSubmit");
  const statusEl = document.getElementById("convertDialogStatus");
  dlg.addEventListener("close", () => { /* nothing extra */ });
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    if (dlg.returnValue === "cancel") return;
    e.preventDefault();
    const email = document.getElementById("convertEmail").value.trim();
    const password = document.getElementById("convertPassword").value;
    if (!email || password.length < 6) {
      setDialogStatus(statusEl, "Enter an email and a password of at least 6 characters.", true);
      return;
    }
    submit.disabled = true;
    setDialogStatus(statusEl, "Creating account…");
    try {
      await auth.convertAnonymous(email, password);
      setDialogStatus(statusEl, "Account created. Welcome!");
      // updateUser fires onAuthStateChange — handleAuthChange will
      // re-paint the header (chip hides) without us re-routing.
      setTimeout(() => dlg.close("converted"), 600);
    } catch (err) {
      const msg = (err?.message || String(err));
      if (/already.*registered|already.*in use|already.*exists/i.test(msg)) {
        // Email collision — offer the claim-and-merge handoff.
        await tryClaimMergeFlow(email, password, statusEl);
      } else {
        setDialogStatus(statusEl, msg, true);
      }
    } finally {
      submit.disabled = false;
    }
  });
}

// "Claim my guest edits" handoff. Called when convert hit an email
// collision. We mint a merge token while we still have the anon
// session, sign out, sign in to the existing account, then call the
// claim RPC which moves memberships + reassigns authored content
// from the anon UID to the registered UID and deletes the anon row.
async function tryClaimMergeFlow(email, password, statusEl) {
  if (!confirm(
    "That email already has an account. Sign in there and import all your guest edits into it?\n\n" +
    "Click OK to sign in and claim. Click Cancel if you'd rather sign in separately and leave the guest session as-is."
  )) {
    setDialogStatus(statusEl,
      "Kept as a guest. Use a different email if you want to keep this trip in a new account.",
      true);
    return;
  }

  setDialogStatus(statusEl, "Preparing handoff…");
  let mergeToken;
  try {
    mergeToken = await auth.startAnonMerge();
  } catch (err) {
    setDialogStatus(statusEl, "Could not start handoff: " + (err.message || err), true);
    return;
  }

  setDialogStatus(statusEl, "Signing in…");
  try {
    await auth.signOut();
    await auth.signIn(email, password);
  } catch (err) {
    setDialogStatus(statusEl, "Sign-in failed: " + (err.message || err), true);
    return;
  }

  setDialogStatus(statusEl, "Importing your guest edits…");
  try {
    const claimed = await auth.claimAnonEdits(mergeToken);
    setDialogStatus(statusEl,
      `Done — ${claimed} trip${claimed === 1 ? "" : "s"} moved into this account.`);
    setTimeout(() => {
      document.getElementById("convertDialog").close("claimed");
      // After claim, the dashboard should re-render to show the
      // claimed trips. handleAuthChange already triggered routeFromUrl
      // when signIn completed, but it may have raced; force a refresh.
      routeFromUrl();
    }, 800);
  } catch (err) {
    setDialogStatus(statusEl,
      "Signed in, but couldn't import guest edits: " + (err.message || err),
      true);
  }
}

// Build a same-origin URL with the given query params. Used to construct
// hrefs inside the app without touching window.location directly.
function buildUrl(params = {}) {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, v);
  }
  return u.toString();
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
  { page: "budget",    glyph: "payments",       label: "Budget" },
];
const NAV_TRAVEL = [
  { page: "today",     glyph: "today",          label: "Today" },
  { page: "notes",     glyph: "edit_note",      label: "Notes" },
  { page: "costs",     glyph: "receipt_long",   label: "Costs" },
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
      <strong>HERMES DAYBOOK</strong>
      <span>— ∞ — BON VOYAGE</span>
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
        <button data-page="overview" class="${state.page === "overview" ? "is-active" : ""}" title="Trip settings">
          <span class="material-symbols-outlined" aria-hidden>tune</span>
        </button>
        <button data-page="members" class="${state.page === "members" ? "is-active" : ""}" title="Members &amp; roles">
          <span class="material-symbols-outlined" aria-hidden>group</span>
        </button>
        <button id="sidePrintBtn" title="Print preview">
          <span class="material-symbols-outlined" aria-hidden>print</span>
        </button>
        <button data-page="io"      class="${state.page === "io" ? "is-active" : ""}" title="Import / Export">
          <span class="material-symbols-outlined" aria-hidden>swap_vert</span>
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
// Live-collab telemetry on the left, member avatar stack + Share button
// on the right. The avatar stack reads from state.trip.members (which
// openTrip populates via members.list()) so the avatars are real, not
// placeholders. Clicking the stack navigates to the Members page.
//
// Previous versions also had a search bar and a notifications bell
// here. Both were stubs ("coming soon") backed by no feature, so they
// were stripped to keep the topbar honest. Add them back if/when the
// underlying features exist.
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

  // Editors count: members with role owner or editor. Reflects the
  // actual roster — if it shows 1, that's because the trip is solo.
  const editors = members.filter((m) => {
    const r = (m.role || "").toLowerCase();
    return r === "owner" || r === "editor";
  }).length || 1;

  bar.innerHTML = `
    <div class="vy-topbar-live">
      <span class="vy-meta">
        <i class="vy-livedot" aria-hidden></i>
        <b id="topbarEditors">${editors}</b> EDITOR${editors === 1 ? "" : "S"} · LAST CHANGE
        <b id="topbarLastChange">${formatLastChange(state.lastChangeAt)}</b>
      </span>
    </div>
    <button class="vy-share-stack" id="topbarMembersBtn" title="Members &amp; roles">
      ${visibleMembers.map((m, i) => avatarHtml(m, i)).join("")}
      ${overflowCount ? `<span class="vy-avatar vy-avatar--more" title="${overflowCount} more"><span>+${overflowCount}</span></span>` : ""}
      ${!members.length ? `<span class="vy-avatar" style="background:linear-gradient(135deg,#dff1ec,#a8d6ca)"><span>···</span></span>` : ""}
    </button>
    <button class="vy-btn-primary" id="topbarShareBtn" title="Share trip">
      <span class="material-symbols-outlined" aria-hidden>ios_share</span>
      Share trip
    </button>
  `;

  bar.querySelector("#topbarMembersBtn").addEventListener("click", () => navigate({ page: "members" }));
  // Share button opens the share-link popover (anchored to this button).
  // Owner-only; for non-owners we hide the trigger entirely below.
  const topbarShareBtn = bar.querySelector("#topbarShareBtn");
  if (topbarShareBtn) {
    if (state.trip.role !== "owner") {
      topbarShareBtn.hidden = true;
    } else {
      topbarShareBtn.addEventListener("click", () => toggleShareMenu());
    }
  }
}

function avatarHtml(member, idx) {
  // Hue rotates by index so each member's avatar gets a distinct pastel.
  // 172 (viridian) and 42 (amber) match the design's first two slots,
  // then we walk the color wheel for further members.
  const hues = [172, 42, 198, 312, 102];
  const hue = hues[idx % hues.length];
  // list_trip_members returns display_name + email; fall back through
  // them so guests with no display_name still get sensible initials.
  const name = member?.display_name || member?.email || "?";
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
              title="${escapeText(d.title || "Day " + (i + 1))}${canEdit ? "  ·  drag the grip to reorder, right-click for actions" : ""}">
        <span class="vy-daypill-body">
          <span class="vy-daypill-wd">${wd}</span>
          <span class="vy-daypill-num">${num}</span>
          <span class="vy-daypill-city">${escapeText(city || "—")}</span>
        </span>
        ${canEdit ? `<span class="vy-daypill-grip" title="Drag to reorder" aria-hidden>
          <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
            <circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/>
            <circle cx="2" cy="7" r="1"/><circle cx="6" cy="7" r="1"/>
            <circle cx="2" cy="12" r="1"/><circle cx="6" cy="12" r="1"/>
          </svg>
        </span>` : ""}
      </button>
    `;
  }).join("");

  const pills = Array.from(host.querySelectorAll("button[data-day-idx]"));

  // Click → select that day. Same handler for itinerary and today — both
  // pages re-render against state.selectedDayIdx. Plain click on the
  // grip never fires this (startDayDrag stopPropagation's the
  // pointerdown, so subsequent click is suppressed by the browser).
  pills.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn._suppressClick) { btn._suppressClick = false; return; }
      state.selectedDayIdx = Number(btn.dataset.dayIdx);
      renderTripPage();
    });
  });

  // Right-click → context menu (Go to / Move / Delete).
  if (canEdit) {
    pills.forEach((btn) => {
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const idx = Number(btn.dataset.dayIdx);
        openContextMenu(e.clientX, e.clientY, [
          { label: "Move left",       glyph: "chevron_left",
            disabled: idx === 0,
            onClick: () => commitDayReorder(idx, idx - 1) },
          { label: "Move right",      glyph: "chevron_right",
            disabled: idx === days.length - 1,
            onClick: () => commitDayReorder(idx, idx + 1) },
          { type: "sep" },
          { label: "Delete this day", glyph: "delete", danger: true,
            onClick: () => deleteDayConfirm(days[idx]) },
        ]);
      });
    });
  }

  // Pointer-event drag — only the grip starts a drag; siblings dodge
  // via translateX as the dragged pill moves. Drop commits an
  // optimistic local reorder (state mutated, paintTabs re-rendered)
  // and fires the API in the background.
  if (canEdit) {
    pills.forEach((btn) => {
      const grip = btn.querySelector(".vy-daypill-grip");
      if (!grip) return;
      grip.addEventListener("pointerdown", (e) => startDayDrag(e, btn, pills, host));
    });
  }
}

function startDayDrag(downEvent, draggedBtn, pills, host) {
  if (downEvent.button !== 0 && downEvent.pointerType === "mouse") return;
  downEvent.preventDefault();
  downEvent.stopPropagation();

  const grip = downEvent.currentTarget;
  const startIdx = pills.indexOf(draggedBtn);
  if (startIdx < 0) return;

  // Snapshot each pill's home rect (viewport-space left + width).
  const homes = pills.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, x: r.left, w: r.width };
  });
  const homeOf = homes[startIdx];
  const startX = downEvent.clientX;

  let liveOrder = pills.map((_, i) => i);
  let lastSlot = startIdx;

  draggedBtn.classList.add("is-dragging");
  draggedBtn.style.zIndex = "10";
  draggedBtn.style.willChange = "transform";
  draggedBtn.style.transition = "none";

  try { grip.setPointerCapture(downEvent.pointerId); } catch {}

  function layoutPeers() {
    for (let i = 0; i < homes.length; i++) {
      if (i === startIdx) continue;
      const newSlot = liveOrder.indexOf(i);
      const delta = homes[newSlot].x - homes[i].x;
      homes[i].el.style.transform = delta ? `translateX(${delta}px)` : "";
    }
  }

  function onMove(ev) {
    const dx = ev.clientX - startX;
    draggedBtn.style.transform = `translateX(${dx}px)`;
    const draggedCenter = homeOf.x + dx + homeOf.w / 2;
    let nearest = 0, bestDist = Infinity;
    for (let i = 0; i < homes.length; i++) {
      const center = homes[i].x + homes[i].w / 2;
      const d = Math.abs(center - draggedCenter);
      if (d < bestDist) { bestDist = d; nearest = i; }
    }
    if (nearest !== lastSlot) {
      lastSlot = nearest;
      liveOrder = pills.map((_, i) => i).filter((i) => i !== startIdx);
      liveOrder.splice(nearest, 0, startIdx);
      layoutPeers();
    }
  }

  function cleanup() {
    grip.removeEventListener("pointermove", onMove);
    grip.removeEventListener("pointerup", onUp);
    grip.removeEventListener("pointercancel", onUp);
    try { grip.releasePointerCapture(downEvent.pointerId); } catch {}
  }

  function onUp() {
    cleanup();
    const finalSlot = liveOrder.indexOf(startIdx);
    draggedBtn.style.transition = "";
    const dxFinal = homes[finalSlot].x - homes[startIdx].x;
    draggedBtn.style.transform = dxFinal ? `translateX(${dxFinal}px)` : "";

    window.setTimeout(() => {
      for (const h of homes) {
        h.el.style.transition = "none";
        h.el.style.transform = "";
      }
      draggedBtn.classList.remove("is-dragging");
      draggedBtn.style.zIndex = "";
      draggedBtn.style.willChange = "";
      // Swallow the click that fires synthetically after a pointer drag
      // on some browsers so the dragged pill doesn't also "select".
      draggedBtn._suppressClick = true;
      setTimeout(() => { draggedBtn._suppressClick = false; }, 50);

      if (startIdx !== finalSlot) {
        commitDayReorder(startIdx, finalSlot);
      }

      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const h of homes) h.el.style.transition = "";
      }));
    }, 200);
  }

  grip.addEventListener("pointermove", onMove);
  grip.addEventListener("pointerup", onUp);
  grip.addEventListener("pointercancel", onUp);
}

// Optimistic day-order commit — mutates state.trip.days in place and
// re-renders the day-strip + sidebar immediately, then fires the API
// call in the background. On failure, restores the original order.
async function commitDayReorder(fromIdx, toIdx) {
  const days = state.trip?.days || [];
  if (fromIdx < 0 || fromIdx >= days.length) return;
  if (toIdx   < 0 || toIdx   >= days.length) return;
  if (fromIdx === toIdx) return;

  const origOrder = days.slice();
  const newOrder = days.slice();
  const [moved] = newOrder.splice(fromIdx, 1);
  newOrder.splice(toIdx, 0, moved);

  // Track which day was selected so the strip selection follows the
  // move rather than sitting on the wrong day after re-render.
  const selDay = days[state.selectedDayIdx];

  // Apply locally.
  days.splice(0, days.length, ...newOrder);
  const newSel = days.findIndex((d) => d.id === selDay?.id);
  if (newSel >= 0) state.selectedDayIdx = newSel;
  paintTabs();

  // Background persistence.
  noteSaveStart();
  try {
    await daysApi.reorder(newOrder.map((d) => d.id));
  } catch (e) {
    // Revert
    days.splice(0, days.length, ...origOrder);
    const restoredSel = days.findIndex((d) => d.id === selDay?.id);
    if (restoredSel >= 0) state.selectedDayIdx = restoredSel;
    paintTabs();
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

  // On the trips lobby the profile card owns identity + sign-out + the
  // "Save your trips" CTA, so we hide the header copies to avoid two
  // sources of truth. The trip view still uses the header chrome on
  // mobile (desktop hides the header itself via CSS).
  const showHeaderIdentity = state.view !== "trips";
  if (state.user?.email && showHeaderIdentity) {
    userBadge.hidden = false;
    userBadge.textContent = state.user.email;
    signOutBtn.hidden = false;
  } else {
    userBadge.hidden = true;
    signOutBtn.hidden = true;
  }

  backBtn.hidden = !(state.view === "trip" && state.user);
  document.getElementById("printTripBtn").hidden = !(state.view === "trip" && state.trip);
  // Share lives in the trip topbar now, not in the global app-header,
  // so there's nothing to toggle here. The topbar Share button is
  // rendered by paintTopbar() and wired to toggleShareMenu().
  // Guest chip duplicates the profile card's convert CTA on the trips
  // lobby — hide it there. On the trip view it's still the only
  // conversion surface for anon guests.
  document.getElementById("guestChipBtn").hidden =
    !(state.user?.is_anonymous) || state.view === "trips";
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
      <h1>Hermes Daybook</h1>
      <p>This app needs a Supabase backend to store trips. Click ⚙ in the top right to configure your project URL + publishable key, or deploy with the included GitHub Actions workflow that bakes them in from repo Secrets.</p>
    </div>
  `;
}
