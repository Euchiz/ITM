// Mobile shell — the chrome every mobile trip-page renders inside.
//
// Owns: the two-row header strip (back · title · ⋯ ; mode pill · meta),
// the floating glass tab bar at the bottom, and the slot where the
// per-page content gets injected. Pages themselves are unaware of the
// shell — app.js wraps them.
//
// Returns the element pages render their content into. Callers do:
//
//   const slot = renderMobileShell(host, ctx);
//   somePageRenderer(slot, ctx);

import { el } from "../_utils.js";
import { openMoreSheet } from "./more.js";

// Tab configuration per mode. id maps to state.page; label is the
// short tab title; glyph is a Material Symbols name; soon flags the
// SOON badge (Map only, for now).
export const TRAVEL_TABS = [
  { id: "today",  glyph: "today",          label: "Today" },
  { id: "map",    glyph: "map",            label: "Map",   soon: true },
  { id: "costs",  glyph: "receipt_long",   label: "Costs" },
  { id: "notes",  glyph: "edit_note",      label: "Notes" },
];
export const OVERVIEW_TABS = [
  { id: "itinerary", glyph: "calendar_month", label: "Itinerary" },
  { id: "prepare",   glyph: "fact_check",     label: "Prepare"   },
  { id: "budget",    glyph: "savings",        label: "Budget"    },
  { id: "pack",      glyph: "luggage",        label: "Pack"      },
];

const MODE_FIRST_TAB = { travel: "today", overview: "itinerary" };

// Pages that drill in from elsewhere (Detail card, More sheet) rather
// than living in a tab. They render with a "< Back" button + no tab
// bar + no mode pill — the user came from a specific origin and the
// back arrow takes them there.
const DRILL_IN_PAGES = new Set(["detail", "overview", "members", "io"]);

const DRILL_IN_LABELS = {
  detail:   "Back",
  overview: "Back",
  members:  "Back",
  io:       "Back",
};

export function renderMobileShell(host, ctx) {
  const trip = ctx.trip || {};
  const page = ctx.page || "today";
  const mode = ctx.mobileMode || "travel";
  const tabs = mode === "travel" ? TRAVEL_TABS : OVERVIEW_TABS;
  const isDrillIn = DRILL_IN_PAGES.has(page);

  host.innerHTML = "";

  // Header strip — two rows.
  const header = el("header", { class: "vy-mobile-header" });

  // Row 1: back · title · ⋯
  const row1 = el("div", { class: "vy-mobile-headline" });
  row1.appendChild(buildBackButton(ctx, page, isDrillIn));
  row1.appendChild(el("h1", { class: "vy-mobile-trip-title",
    text: isDrillIn ? drillInTitle(page, trip) : (trip.title || "Untitled trip") }));
  row1.appendChild(el("button", {
    class: "vy-mobile-more-btn",
    "aria-label": "More",
    title: "More",
    onClick: () => openMoreSheet(ctx),
  }, el("span", { class: "material-symbols-outlined", text: "more_horiz" })));
  header.appendChild(row1);

  // Row 2: mode pill · meta. Hidden on drill-in screens — the back
  // arrow already provides context and the mode pill would just
  // invite the user to leave the drill-in.
  if (!isDrillIn) {
    const row2 = el("div", { class: "vy-mobile-headmeta" });
    row2.appendChild(buildModePill(ctx, mode));
    row2.appendChild(buildHeadMetaText(ctx, trip));
    header.appendChild(row2);
  }

  host.appendChild(header);

  // Content slot — the page renders into this. Padding-bottom clears
  // the floating tab bar; safe-area-inset is in the CSS.
  const slot = el("section", { class: "vy-mobile-content" });
  host.appendChild(slot);

  // Floating glass tab bar — only on regular tab pages, not drill-ins.
  if (!isDrillIn) host.appendChild(buildTabBar(ctx, tabs, page));

  return slot;
}

function drillInTitle(page, trip) {
  switch (page) {
    case "members":  return "Members";
    case "overview": return "Trip overview";
    case "io":       return "Import / Export";
    case "detail":   return trip?.title || "Event";
    default:         return trip?.title || "";
  }
}

function buildBackButton(ctx, page, isDrillIn) {
  if (isDrillIn) {
    return el("button", {
      class: "vy-mobile-back-btn",
      onClick: () => {
        const back = ctx.lastNonDetailPage
          || (ctx.mobileMode === "overview" ? "itinerary" : "today");
        ctx.navigate?.({ page: back });
      },
    },
      el("span", { class: "material-symbols-outlined", text: "chevron_left" }),
      el("span", { text: DRILL_IN_LABELS[page] || "Back" }),
    );
  }
  return el("button", {
    class: "vy-mobile-back-btn",
    onClick: () => ctx.navigate?.({ trip: null }),
  },
    el("span", { class: "material-symbols-outlined", text: "chevron_left" }),
    el("span", { text: "Trips" }),
  );
}

function buildModePill(ctx, currentMode) {
  const wrap = el("div", { class: "vy-mobile-modepill", role: "tablist" });
  for (const m of ["travel", "overview"]) {
    const btn = el("button", {
      class: m === currentMode ? "is-active" : "",
      role: "tab",
      "data-mode": m,
      onClick: () => {
        if (m === currentMode) return;
        ctx.setMobileMode?.(m);
        ctx.navigate?.({ page: MODE_FIRST_TAB[m] });
      },
    }, m === "travel" ? "Travel" : "Overview");
    wrap.appendChild(btn);
  }
  return wrap;
}

function buildHeadMetaText(ctx, trip) {
  const dayCount = (trip.days || []).length;
  const wrap = el("div", { class: "vy-mobile-headmeta-r" });
  if (dayCount > 0) {
    wrap.appendChild(el("span", { class: "vy-meta",
      text: `${dayCount} DAY${dayCount === 1 ? "" : "S"}` }));
  } else {
    wrap.appendChild(el("span", { class: "vy-meta muted", text: "—" }));
  }
  return wrap;
}

function buildTabBar(ctx, tabs, currentPage) {
  const bar = el("nav", { class: "vy-mobile-tabbar", role: "tablist" });
  for (const t of tabs) {
    const isActive = t.id === currentPage;
    const btn = el("button", {
      class: `vy-mobile-tabbar-btn ${isActive ? "is-active" : ""}`.trim(),
      role: "tab",
      "aria-selected": isActive ? "true" : "false",
      "data-page": t.id,
      onClick: () => ctx.navigate?.({ page: t.id }),
    },
      el("span", { class: "material-symbols-outlined", text: t.glyph }),
      el("span", { class: "vy-mobile-tabbar-label", text: t.label }),
      t.soon ? el("span", { class: "vy-mobile-tabbar-soon", text: "SOON" }) : null,
    );
    bar.appendChild(btn);
  }
  return bar;
}
