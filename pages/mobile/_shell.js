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
import { t, plural } from "../../i18n/locale.js";
import { openMoreSheet } from "./more.js";

// Tab configuration per mode. Labels resolve via t() at render time so
// a locale switch retranslates the bar without rebuilding the array.
export const TRAVEL_TABS = [
  { id: "today",  glyph: "today",          labelKey: "mobile.tab.today" },
  { id: "map",    glyph: "map",            labelKey: "mobile.tab.map", soon: true },
  { id: "costs",  glyph: "receipt_long",   labelKey: "mobile.tab.costs" },
  { id: "notes",  glyph: "edit_note",      labelKey: "mobile.tab.notes" },
];
export const OVERVIEW_TABS = [
  { id: "itinerary", glyph: "calendar_month", labelKey: "mobile.tab.itinerary" },
  { id: "prepare",   glyph: "fact_check",     labelKey: "mobile.tab.prepare" },
  { id: "budget",    glyph: "savings",        labelKey: "mobile.tab.budget" },
  { id: "pack",      glyph: "luggage",        labelKey: "mobile.tab.pack" },
];

const MODE_FIRST_TAB = { travel: "today", overview: "itinerary" };

// Pages that drill in from elsewhere (Detail card, More sheet) rather
// than living in a tab. They render with a "< Back" button + no tab
// bar + no mode pill — the user came from a specific origin and the
// back arrow takes them there.
const DRILL_IN_PAGES = new Set(["detail", "overview", "members", "io"]);

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
    text: isDrillIn ? drillInTitle(page, trip) : (trip.title || t("sidebar.untitledTrip")) }));
  row1.appendChild(el("button", {
    class: "vy-mobile-more-btn",
    "aria-label": t("mobile.shell.more"),
    title: t("mobile.shell.more"),
    onClick: () => openMoreSheet(ctx),
  }, el("span", { class: "material-symbols-outlined", text: "more_horiz" })));
  header.appendChild(row1);

  if (!isDrillIn) {
    const row2 = el("div", { class: "vy-mobile-headmeta" });
    row2.appendChild(buildModePill(ctx, mode));
    row2.appendChild(buildHeadMetaText(ctx, trip));
    header.appendChild(row2);
  }

  host.appendChild(header);

  const slot = el("section", { class: "vy-mobile-content" });
  host.appendChild(slot);

  if (!isDrillIn) host.appendChild(buildTabBar(ctx, tabs, page));

  return slot;
}

function drillInTitle(page, trip) {
  switch (page) {
    case "members":  return t("mobile.shell.drillInMembers");
    case "overview": return t("mobile.shell.drillInOverview");
    case "io":       return t("mobile.shell.drillInIo");
    case "detail":   return trip?.title || t("mobile.shell.drillInDetail");
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
      el("span", { text: t("mobile.shell.back") }),
    );
  }
  return el("button", {
    class: "vy-mobile-back-btn",
    onClick: () => ctx.navigate?.({ trip: null }),
  },
    el("span", { class: "material-symbols-outlined", text: "chevron_left" }),
    el("span", { text: t("mobile.shell.trips") }),
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
    }, m === "travel" ? t("mobile.shell.travelTab") : t("mobile.shell.overviewTab"));
    wrap.appendChild(btn);
  }
  return wrap;
}

function buildHeadMetaText(ctx, trip) {
  const dayCount = (trip.days || []).length;
  const wrap = el("div", { class: "vy-mobile-headmeta-r" });
  if (dayCount > 0) {
    wrap.appendChild(el("span", { class: "vy-meta",
      text: plural("mobile.shell.dayCount", dayCount, { n: dayCount }) }));
  } else {
    wrap.appendChild(el("span", { class: "vy-meta muted", text: "—" }));
  }
  return wrap;
}

function buildTabBar(ctx, tabs, currentPage) {
  const bar = el("nav", { class: "vy-mobile-tabbar", role: "tablist" });
  for (const tab of tabs) {
    const isActive = tab.id === currentPage;
    const btn = el("button", {
      class: `vy-mobile-tabbar-btn ${isActive ? "is-active" : ""}`.trim(),
      role: "tab",
      "aria-selected": isActive ? "true" : "false",
      "data-page": tab.id,
      onClick: () => ctx.navigate?.({ page: tab.id }),
    },
      el("span", { class: "material-symbols-outlined", text: tab.glyph }),
      el("span", { class: "vy-mobile-tabbar-label", text: t(tab.labelKey) }),
      tab.soon ? el("span", { class: "vy-mobile-tabbar-soon", text: t("mobile.tab.soon") }) : null,
    );
    bar.appendChild(btn);
  }
  return bar;
}
