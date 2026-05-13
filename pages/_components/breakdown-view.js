// Breakdown view — donut + per-bucket bar list.
//
// Reused by Budget Breakdown and Costs Breakdown. Each call:
//   * builds buckets either BY CATEGORY (item type) or BY DAY
//   * renders a small SVG donut at the head whose slices reflect either
//     proposed or actual totals (caller picks via donutMode)
//   * renders one row per non-empty bucket with two stacked horizontal
//     bars (proposed + actual) and a variance chip
//   * separates multi-currency override items into a "Other currencies"
//     sub-block — no FX conversion
//
// The bucket-axis toggle (BY CATEGORY | BY DAY) lives inside this
// component; state persists in localStorage so the user's preference
// survives navigation.

import { el, formatMoney } from "../_utils.js";
import { TYPE_VISUALS } from "../itinerary.js";
import { ITEM_TYPES } from "../../io/schema.js";

const BUCKET_KEY = "voyage:breakdown-bucket";
const BUCKET_OPTIONS = ["category", "day"];

// CSS-variable-derived palette for BY DAY buckets — cycles through a
// muted-rainbow so adjacent days are distinct without screaming.
const DAY_COLORS = [
  "#2f7d72", "#3a6b8c", "#8b6a2c", "#5b2b6e",
  "#8a4a14", "#4b6a4f", "#7c3c8c", "#a64d3a",
];

/** Render the whole Breakdown panel into `host`. Returns the host. */
export function renderBreakdown(host, ctx) {
  const { trip, donutMode = "proposed", includeUnplanned = false } = ctx || {};
  host.innerHTML = "";
  host.classList.add("vy-bd");
  // Stash the ctx so the inner bucket-toggle can re-render in place
  // without the caller plumbing a re-render callback.
  host.__bdCtx = ctx;

  const bucketBy = readBucketBy();

  // Sub-toggle BY CATEGORY | BY DAY
  host.appendChild(bucketToggle(host, bucketBy));

  const defaultCurrency = (trip?.default_currency || "USD").toUpperCase();
  const items = collectItems(trip, includeUnplanned);

  // Empty state — no items or no costs at all
  if (items.length === 0) {
    host.appendChild(el("div", { class: "empty-state vy-bd-empty" },
      el("h3", { text: "Nothing to break down" }),
      el("p", { text: "Add events on Itinerary and assign costs in Edit mode." }),
    ));
    return host;
  }
  const anyCost = items.some((it) =>
    it.proposed_cost_cents != null || it.actual_cost_cents != null);
  if (!anyCost) {
    host.appendChild(el("p", { class: "muted vy-bd-hint",
      text: "No costs entered yet. Switch to Edit mode to add proposed amounts." }));
    return host;
  }

  // Split items by currency. Default-currency items drive the donut
  // and the main bar list. Override-currency items render in a per-
  // currency sub-block below — no donut, no FX.
  const defaultItems  = items.filter((it) =>
    !it.currency || it.currency.toUpperCase() === defaultCurrency);
  const overrideItems = items.filter((it) =>
    it.currency && it.currency.toUpperCase() !== defaultCurrency);

  if (defaultItems.length > 0) {
    host.appendChild(renderSection(defaultItems, defaultCurrency, bucketBy, donutMode));
  }

  if (overrideItems.length > 0) {
    const byCode = new Map();
    for (const it of overrideItems) {
      const code = it.currency.toUpperCase();
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(it);
    }
    const wrap = el("div", { class: "vy-bd-overrides" });
    wrap.appendChild(el("h3", { class: "vy-bd-overrides-head",
      text: "Other currencies" }));
    byCode.forEach((items, code) => {
      wrap.appendChild(renderSection(items, code, bucketBy, donutMode, { withDonut: false }));
    });
    host.appendChild(wrap);
  }

  return host;
}

// ───────────────────────────────────────────────────────────────────
// Section: donut + bar list for a single currency
// ───────────────────────────────────────────────────────────────────

function renderSection(items, currency, bucketBy, donutMode, { withDonut = true } = {}) {
  const section = el("section", { class: "vy-bd-section card" });

  const buckets = computeBuckets(items, bucketBy);

  // Header
  const head = el("header", { class: "vy-bd-section-head" });
  head.appendChild(el("span", { class: "vy-bd-section-label",
    text: currency }));
  const proposedTotal = items.reduce((a, it) =>
    a + (Number(it.proposed_cost_cents) || 0), 0);
  const actualTotal = items.reduce((a, it) =>
    a + (Number(it.actual_cost_cents) || 0), 0);
  head.appendChild(el("span", { class: "vy-bd-section-totals" },
    el("span", { class: "muted small",
      text: `Proposed ${formatMoney(proposedTotal, currency)}` }),
    actualTotal > 0
      ? el("span", { class: "muted small",
          text: `· Actual ${formatMoney(actualTotal, currency)}` })
      : null,
  ));
  section.appendChild(head);

  // Donut (default-currency block only)
  if (withDonut) {
    const donutMetric = donutMode === "actual" ? "actual_cost_cents" : "proposed_cost_cents";
    const donutTotal = items.reduce((a, it) =>
      a + (Number(it[donutMetric]) || 0), 0);
    if (donutTotal > 0) {
      const slices = [...buckets.values()]
        .filter((b) => (donutMode === "actual" ? b.actual : b.proposed) > 0)
        .map((b) => ({
          color: b.color,
          value: donutMode === "actual" ? b.actual : b.proposed,
          label: b.label,
        }));
      section.appendChild(renderDonut(slices, donutTotal, currency, donutMode));
    }
  }

  // Bar list
  const list = el("div", { class: "vy-bd-list" });
  let any = false;
  for (const b of buckets.values()) {
    if (b.proposed === 0 && b.actual === 0) continue;
    any = true;
    list.appendChild(renderBucketRow(b, currency));
  }
  if (any) section.appendChild(list);

  return section;
}

function renderDonut(slices, total, currency, donutMode) {
  const wrap = el("div", { class: "vy-bd-donut-wrap" });
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("class", "vy-bd-donut");
  // Track ring (so 0-coverage looks intentional, not broken).
  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("cx", "18");
  track.setAttribute("cy", "18");
  track.setAttribute("r", "14");
  track.setAttribute("fill", "none");
  track.setAttribute("stroke", "rgba(255,255,255,0.55)");
  track.setAttribute("stroke-width", "5");
  svg.appendChild(track);

  const circumference = 2 * Math.PI * 14;
  let cumulative = 0;
  for (const s of slices) {
    const fraction = s.value / total;
    if (fraction <= 0) continue;
    const dash = fraction * circumference;
    const gap = circumference - dash;
    const offset = -(cumulative * circumference);
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "18");
    c.setAttribute("cy", "18");
    c.setAttribute("r", "14");
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", s.color);
    c.setAttribute("stroke-width", "5");
    c.setAttribute("stroke-dasharray", `${dash} ${gap}`);
    c.setAttribute("stroke-dashoffset", String(offset));
    c.setAttribute("transform", "rotate(-90 18 18)");
    c.setAttribute("data-label", s.label);
    svg.appendChild(c);
    cumulative += fraction;
  }
  wrap.appendChild(svg);
  wrap.appendChild(el("div", { class: "vy-bd-donut-center" },
    el("div", { class: "vy-bd-donut-amount",
      text: formatMoney(total, currency) }),
    el("div", { class: "vy-bd-donut-label",
      text: donutMode === "actual" ? "ACTUAL" : "PROPOSED" }),
  ));
  return wrap;
}

function renderBucketRow(b, currency) {
  const row = el("div", { class: "vy-bd-row" });

  // Top: chip + label + variance
  const top = el("div", { class: "vy-bd-row-top" });
  top.appendChild(el("span", { class: `vy-chip vy-chip--${b.chipClass}` },
    b.glyph ? el("span", { class: "material-symbols-outlined", text: b.glyph }) : null,
    el("span", { text: b.label }),
  ));
  if (b.actual > 0 && b.proposed > 0) {
    const delta = b.actual - b.proposed;
    if (delta !== 0) {
      top.appendChild(el("span", {
        class: "vy-bd-variance " + (delta > 0 ? "is-over" : "is-under"),
        text: `${delta > 0 ? "+" : "−"}${formatMoney(Math.abs(delta), currency)} ${delta > 0 ? "over" : "under"}`,
      }));
    }
  }
  row.appendChild(top);

  // Two bars stacked, normalized against bucket max
  const denom = Math.max(b.proposed, b.actual) || 1;
  if (b.proposed > 0) {
    row.appendChild(barLine("Proposed", b.proposed, denom, currency, b.color, true));
  }
  if (b.actual > 0) {
    row.appendChild(barLine("Actual", b.actual, denom, currency, b.color, false));
  }

  return row;
}

function barLine(label, value, denom, currency, color, isProposed) {
  const pct = Math.max(0, Math.min(1, value / denom)) * 100;
  const wrap = el("div", { class: `vy-bd-bar-line ${isProposed ? "is-proposed" : "is-actual"}` });
  wrap.appendChild(el("span", { class: "vy-bd-bar-label", text: label }));
  const track = el("div", { class: "vy-bd-bar-track" });
  const fill = el("div", { class: "vy-bd-bar-fill" });
  fill.style.width = `${pct}%`;
  fill.style.background = color;
  track.appendChild(fill);
  wrap.appendChild(track);
  wrap.appendChild(el("span", { class: "vy-bd-bar-amount", text: formatMoney(value, currency) }));
  return wrap;
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

function bucketToggle(host, current) {
  const wrap = el("div", { class: "vy-bd-toggle vy-view-toggle", role: "tablist" });
  BUCKET_OPTIONS.forEach((v) => {
    const btn = el("button", {
      class: v === current ? "is-active" : "",
      role: "tab",
      onClick: () => {
        if (v === current) return;
        writeBucketBy(v);
        // Re-render the whole breakdown by walking up to the caller —
        // simplest: re-invoke renderBreakdown with the new bucket. The
        // caller's container is `host`; we just need its previous ctx.
        // Stash it on the element so toggle clicks find it.
        const ctx = host.__bdCtx;
        if (ctx) renderBreakdown(host, ctx);
      },
    }, "By " + v);
    btn.dataset.v = v;
    wrap.appendChild(btn);
  });
  return wrap;
}

function collectItems(trip, includeUnplanned) {
  const out = [];
  for (const day of trip?.days || []) {
    for (const it of day.items || []) {
      if (!includeUnplanned && it.is_unplanned) continue;
      if (it.cost_tag === "n_a") continue;
      out.push({ ...it, _dayIdx: trip.days.indexOf(day), _day: day });
    }
  }
  return out;
}

function computeBuckets(items, bucketBy) {
  const buckets = new Map();
  if (bucketBy === "day") {
    for (const it of items) {
      const key = `day-${it._dayIdx}`;
      if (!buckets.has(key)) {
        const d = it._day;
        const dateLabel = d.date
          ? new Date(d.date + "T00:00:00").toLocaleDateString(undefined,
              { weekday: "short", month: "short", day: "numeric" })
          : `Day ${it._dayIdx + 1}`;
        buckets.set(key, {
          key,
          label: `DAY ${it._dayIdx + 1} · ${dateLabel}`.toUpperCase(),
          chipClass: "stay",
          glyph: "calendar_month",
          color: DAY_COLORS[it._dayIdx % DAY_COLORS.length],
          proposed: 0, actual: 0,
        });
      }
      const b = buckets.get(key);
      b.proposed += Number(it.proposed_cost_cents) || 0;
      b.actual   += Number(it.actual_cost_cents)   || 0;
    }
  } else {
    // BY CATEGORY — group by ITEM_TYPES order so the donut/list are stable
    for (const type of ITEM_TYPES) {
      buckets.set(type, {
        key: type,
        label: (TYPE_VISUALS[type]?.label || type).toUpperCase(),
        chipClass: TYPE_VISUALS[type]?.chipClass || "note",
        glyph: TYPE_VISUALS[type]?.glyph || "label",
        color: TYPE_COLORS[type] || "#888",
        proposed: 0, actual: 0,
      });
    }
    for (const it of items) {
      const type = ITEM_TYPES.includes(it.type) ? it.type : "activity";
      const b = buckets.get(type);
      b.proposed += Number(it.proposed_cost_cents) || 0;
      b.actual   += Number(it.actual_cost_cents)   || 0;
    }
  }
  return buckets;
}

// Mapping from item type to a solid hex used by the donut + bar fills.
// Matches the vibe of the .vy-chip-- palette in styles.css.
const TYPE_COLORS = {
  activity:  "#2f7d72",
  food:      "#a06316",
  transport: "#3a6b8c",
  lodging:   "#2f7d72",
  shopping:  "#5b2b6e",
  rest:      "#6b7c7a",
  note:      "#9aa9a7",
};

function readBucketBy() {
  try {
    const v = localStorage.getItem(BUCKET_KEY);
    return BUCKET_OPTIONS.includes(v) ? v : "category";
  } catch { return "category"; }
}
function writeBucketBy(v) {
  try { localStorage.setItem(BUCKET_KEY, v); } catch {}
}

