// Printable trip document — agency-style layout for review / customs.
//
// openPrintView(trip) appends a full-screen overlay containing the
// composed printable document plus a small toolbar (Close · Print).
// CSS @media print hides the toolbar and overlay chrome, leaving the
// printable doc as the only thing on the page when the browser prints.
//
// User flow:
//   1. Click "Print PDF" on Overview / Itinerary page.
//   2. Preview opens. User reviews layout.
//   3. Click "Print" → browser PDF dialog → "Save as PDF".
//   4. Click "Close" → overlay removed, normal app restored.

import { el, formatDate, formatTime, formatMoney } from "./_utils.js";
import { ITEM_TYPES } from "../io/schema.js";
import { computeSettlement } from "./costs.js";

// Map a cost_tag to an inline suffix shown after the amount. Plain
// text so it survives B&W print. `n_a` and NULL are special-cased by
// the caller (no amount rendered).
const TAG_SUFFIX = {
  guessing: " (?)",
  approx:   " ~",
  actual:   "",
};

const TYPE_LABELS = {
  activity: "Activity",
  food: "Meal",
  transport: "Transport",
  lodging: "Lodging",
  shopping: "Shopping",
  rest: "Rest",
  note: "Note",
};

const STATUS_LABELS = {
  idea: "Idea",
  planned: "Planned",
  needs_booking: "Needs booking",
  booked: "Booked",
  done: "Done",
  cancelled: "Cancelled",
};

const WEEKDAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export function openPrintView(trip) {
  // Remove any prior overlay first (defensive).
  document.querySelectorAll(".print-overlay").forEach((n) => n.remove());

  const overlay = el("div", { class: "print-overlay" });
  const toolbar = el("div", { class: "print-toolbar no-print" },
    el("strong", { text: "Print preview" }),
    el("span", { class: "muted small", text: "Use the Print button to save as PDF." }),
    el("span", { class: "spacer" }),
    el("button", { class: "btn", onClick: close }, "Close"),
    el("button", { class: "btn primary", onClick: doPrint }, "Print PDF"),
  );

  const doc = buildDoc(trip);
  overlay.append(toolbar, doc);
  document.body.appendChild(overlay);
  document.body.classList.add("print-mode");

  // ESC closes the preview.
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);

  function close() {
    overlay.remove();
    document.body.classList.remove("print-mode");
    document.removeEventListener("keydown", onKey);
  }

  function doPrint() {
    window.print();
  }
}

// ===== Document builder =====

function buildDoc(t) {
  const days = (t.days || []).slice().sort((a, b) => a.sort_order - b.sort_order);
  const allItems = days.flatMap((d) => (d.items || []).map((it) => ({ ...it, _day: d })));
  const lodging = allItems.filter((it) => it.type === "lodging");
  const transport = allItems.filter((it) => it.type === "transport");
  const checklists = (t.checklist_items || []);
  const prep = checklists.filter((c) => !c.day_id).slice().sort((a, b) => a.sort_order - b.sort_order);
  const notes = (t.notes || []).slice().sort((a, b) => a.sort_order - b.sort_order);

  const totalDays = days.length;
  const totalNights = Math.max(0, totalDays - 1);

  const doc = el("article", { class: "print-doc" },
    cover(t, totalDays, totalNights),
    glance(t, days),
    dayByDay(days, t.default_currency),
    lodging.length > 0 ? accommodationSection(lodging) : null,
    transport.length > 0 ? transportSection(transport) : null,
    prep.length > 0 ? prepSection(prep) : null,
    notes.length > 0 ? notesSection(notes) : null,
    budgetSummary(t),
    footer(t),
  );
  return doc;
}

// ----- Cover -----

function cover(t, totalDays, totalNights) {
  const dates = (t.start_date && t.end_date)
    ? `${formatDate(t.start_date)} — ${formatDate(t.end_date)}`
    : (t.start_date ? formatDate(t.start_date) : "");
  const duration = totalDays > 0
    ? `${totalDays} ${totalDays === 1 ? "day" : "days"}${totalNights > 0 ? ` · ${totalNights} ${totalNights === 1 ? "night" : "nights"}` : ""}`
    : "";

  return el("section", { class: "print-cover" },
    el("div", { class: "cover-eyebrow", text: "ITINERARY" }),
    el("h1", { class: "cover-title", text: t.title || "Untitled Trip" }),
    t.destination ? el("div", { class: "cover-destination", text: t.destination }) : null,
    el("div", { class: "cover-dates" },
      dates ? el("div", { class: "cover-date-range", text: dates }) : null,
      duration ? el("div", { class: "cover-duration", text: duration }) : null,
    ),

    (t.travelers && t.travelers.length > 0)
      ? el("div", { class: "cover-block" },
          el("div", { class: "cover-label", text: "Travelers" }),
          el("ul", { class: "traveler-list" },
            ...t.travelers.map((name) => el("li", { text: name })),
          ),
        )
      : null,

    t.summary
      ? el("div", { class: "cover-block" },
          el("div", { class: "cover-label", text: "Summary" }),
          el("p", { class: "cover-summary", text: t.summary }),
        )
      : null,
  );
}

// ----- At a glance -----

function glance(t, days) {
  const cities = uniq(days.map((d) => d.city).filter(Boolean));
  const itemCount = days.reduce((n, d) => n + (d.items || []).length, 0);
  const fixedCount = days.reduce((n, d) =>
    n + (d.items || []).filter((it) => it.is_fixed).length, 0);

  return el("section", { class: "print-section glance" },
    el("h2", { text: "Trip overview" }),
    el("table", { class: "facts-table" },
      el("tbody", {},
        fact("Departure", t.start_date ? `${formatLongDate(t.start_date)}` : "—"),
        fact("Return", t.end_date ? `${formatLongDate(t.end_date)}` : "—"),
        fact("Duration", days.length > 0 ? `${days.length} day${days.length === 1 ? "" : "s"}` : "—"),
        fact("Travelers", (t.travelers || []).length > 0
          ? `${t.travelers.length} (${t.travelers.join(", ")})`
          : "—"),
        fact("Cities", cities.length > 0 ? cities.join(" → ") : (t.destination || "—")),
        fact("Planned items", `${itemCount}${fixedCount > 0 ? ` (${fixedCount} fixed / locked)` : ""}`),
      ),
    ),
    t.general_notes
      ? el("div", { class: "general-notes" },
          el("div", { class: "section-label small", text: "General notes" }),
          el("p", { text: t.general_notes }),
        )
      : null,
  );
}

function fact(label, value) {
  return el("tr", {},
    el("th", { text: label }),
    el("td", { text: value }),
  );
}

// ----- Day by day -----

function dayByDay(days, tripDefaultCurrency) {
  if (days.length === 0) {
    return el("section", { class: "print-section" },
      el("h2", { text: "Day-by-day itinerary" }),
      el("p", { class: "muted", text: "No days planned yet." }),
    );
  }

  const sec = el("section", { class: "print-section daily" },
    el("h2", { text: "Day-by-day itinerary" }),
  );

  days.forEach((day, idx) => {
    sec.appendChild(dayBlock(day, idx + 1, tripDefaultCurrency));
  });

  return sec;
}

function dayBlock(day, num, tripDefaultCurrency) {
  const items = (day.items || []).slice().sort((a, b) => {
    const at = a.start_time || "99:99";
    const bt = b.start_time || "99:99";
    if (at !== bt) return at.localeCompare(bt);
    return a.sort_order - b.sort_order;
  });

  const dateStr = day.date ? formatLongDate(day.date) : "";
  const heading = [day.title, day.city].filter(Boolean).join(" · ") || "(untitled day)";

  const block = el("article", { class: "day-block" },
    el("header", { class: "day-block-head" },
      el("div", { class: "day-num-pill", text: `Day ${num}` }),
      el("div", { class: "day-block-meta" },
        el("h3", { class: "day-block-title", text: heading }),
        dateStr ? el("div", { class: "day-block-date", text: dateStr }) : null,
      ),
    ),
  );

  if (day.notes) {
    block.appendChild(el("p", { class: "day-block-notes", text: day.notes }));
  }

  if (items.length > 0) {
    block.appendChild(itemsTable(items, tripDefaultCurrency));
  } else {
    block.appendChild(el("p", { class: "muted small", text: "No items scheduled for this day." }));
  }

  return block;
}

function itemsTable(items, tripDefaultCurrency) {
  const table = el("table", { class: "items-table" },
    el("thead", {},
      el("tr", {},
        el("th", { class: "col-time", text: "Time" }),
        el("th", { class: "col-activity", text: "Activity" }),
        el("th", { class: "col-type", text: "Type" }),
        el("th", { class: "col-location", text: "Location" }),
        el("th", { class: "col-cost", text: "Cost" }),
        el("th", { class: "col-status", text: "Status" }),
      ),
    ),
  );
  const tbody = el("tbody", {});
  items.forEach((it) => tbody.appendChild(itemRow(it, tripDefaultCurrency)));
  table.appendChild(tbody);
  return table;
}

function itemRow(it, tripDefaultCurrency) {
  const time = formatTimeRange(it.start_time, it.end_time);
  const flags = [];
  if (it.is_fixed) flags.push("Fixed");
  if (it.is_highlight) flags.push("Highlight");
  if (it.is_unplanned) flags.push("Unplanned");
  const titleCell = el("td", { class: "col-activity" },
    el("strong", { text: it.title || "(untitled)" }),
    it.notes ? el("div", { class: "item-row-notes", text: it.notes }) : null,
    flags.length > 0
      ? el("div", { class: "item-row-flags", text: flags.join(" · ") })
      : null,
  );
  const location = it.location_name || "";
  return el("tr", { class: `status-${it.status}${it.is_fixed ? " is-fixed" : ""}` },
    el("td", { class: "col-time", text: time || "—" }),
    titleCell,
    el("td", { class: "col-type", text: TYPE_LABELS[it.type] || it.type }),
    el("td", { class: "col-location", text: location || "—" }),
    el("td", { class: "col-cost", text: itemCostString(it, tripDefaultCurrency) }),
    el("td", { class: "col-status", text: STATUS_LABELS[it.status] || it.status }),
  );
}

// Inline cost string for an item — actual if set, else proposed, with
// a tag suffix and a ✂ glyph when shares exist. Returns "—" for n_a
// items and "" (blank) when no cost has been assigned.
function itemCostString(it, tripDefault) {
  if (it.cost_tag === "n_a") return "—";
  const cents = it.actual_cost_cents != null
    ? it.actual_cost_cents
    : it.proposed_cost_cents;
  if (cents == null) return "";
  const code = (it.currency || tripDefault || "USD").toUpperCase();
  const tag = it.actual_cost_cents != null ? "actual" : (it.cost_tag || "");
  const suffix = TAG_SUFFIX[tag] ?? "";
  const split = (it.shares || []).length > 0 ? " ✂" : "";
  return formatMoney(cents, code) + suffix + split;
}

// ----- Accommodation -----

function accommodationSection(lodging) {
  // Group consecutive lodging entries by location_name (rough night-stays).
  const rows = lodging.map((it) => ({
    date: it._day.date || "",
    location: it.location_name || it.title || "",
    title: it.title || "",
    notes: it.notes || "",
    status: it.status,
  }));

  return el("section", { class: "print-section accommodation" },
    el("h2", { text: "Accommodation" }),
    el("table", { class: "list-table" },
      el("thead", {},
        el("tr", {},
          el("th", { text: "Date" }),
          el("th", { text: "Property" }),
          el("th", { text: "Location" }),
          el("th", { text: "Status" }),
        ),
      ),
      el("tbody", {},
        ...rows.map((r) =>
          el("tr", {},
            el("td", { class: "col-date", text: r.date ? formatDate(r.date) : "—" }),
            el("td", {},
              el("strong", { text: r.title || "(unnamed)" }),
              r.notes ? el("div", { class: "small muted", text: r.notes }) : null,
            ),
            el("td", { text: r.location || "—" }),
            el("td", { text: STATUS_LABELS[r.status] || r.status }),
          )
        ),
      ),
    ),
  );
}

// ----- Transportation -----

function transportSection(transport) {
  const rows = transport.slice().sort((a, b) => {
    const ad = a._day.date || "";
    const bd = b._day.date || "";
    if (ad !== bd) return ad.localeCompare(bd);
    return (a.start_time || "99:99").localeCompare(b.start_time || "99:99");
  });

  return el("section", { class: "print-section transport" },
    el("h2", { text: "Transportation" }),
    el("table", { class: "list-table" },
      el("thead", {},
        el("tr", {},
          el("th", { text: "Date" }),
          el("th", { text: "Time" }),
          el("th", { text: "Description" }),
          el("th", { text: "From / Location" }),
          el("th", { text: "Status" }),
        ),
      ),
      el("tbody", {},
        ...rows.map((it) =>
          el("tr", {},
            el("td", { class: "col-date", text: it._day.date ? formatDate(it._day.date) : "—" }),
            el("td", { class: "col-time", text: formatTimeRange(it.start_time, it.end_time) || "—" }),
            el("td", {},
              el("strong", { text: it.title || "(untitled)" }),
              it.notes ? el("div", { class: "small muted", text: it.notes }) : null,
            ),
            el("td", { text: it.location_name || "—" }),
            el("td", { text: STATUS_LABELS[it.status] || it.status }),
          )
        ),
      ),
    ),
  );
}

// ----- Prep checklist -----

function prepSection(prep) {
  return el("section", { class: "print-section prep" },
    el("h2", { text: "Preparation checklist" }),
    el("ul", { class: "prep-list" },
      ...prep.map((c) =>
        el("li", { class: c.is_done ? "done" : "" },
          el("span", { class: "check-mark", text: c.is_done ? "☑" : "☐" }),
          el("span", { class: "check-body" },
            el("span", { text: c.text || "" }),
            c.due_date ? el("span", { class: "due small", text: " · due " + formatDate(c.due_date) }) : null,
            c.notes ? el("div", { class: "small muted", text: c.notes }) : null,
          ),
        )
      ),
    ),
  );
}

// ----- Notes -----

function notesSection(notes) {
  return el("section", { class: "print-section notes" },
    el("h2", { text: "Notes" }),
    ...notes.map((n) =>
      el("div", { class: "note-block" },
        n.title ? el("h4", { text: n.title }) : null,
        n.body ? el("p", { text: n.body }) : null,
      )
    ),
  );
}

// ----- Budget summary -----
//
// End-of-document block: per-currency totals, by-category, by-day,
// and a settlement table when splits/paid_by exist. No charts — print
// is monochrome, so plain text + thin rules carry the load.

function budgetSummary(t) {
  const defaultCurrency = (t.default_currency || "USD").toUpperCase();
  const items = (t.days || []).flatMap((d, di) =>
    (d.items || []).map((it) => ({ ...it, _dayIdx: di, _day: d })));

  // Anything to summarize? Skip the section entirely if there's no
  // cost data at all on the trip.
  const anyCost = items.some((it) =>
    it.cost_tag !== "n_a" &&
    (it.proposed_cost_cents != null || it.actual_cost_cents != null));
  if (!anyCost) return null;

  // Per-currency totals — proposed / actual / variance.
  const perCurrency = new Map(); // code → { proposed, actual }
  for (const it of items) {
    if (it.cost_tag === "n_a") continue;
    const code = (it.currency || defaultCurrency).toUpperCase();
    if (!perCurrency.has(code)) perCurrency.set(code, { proposed: 0, actual: 0 });
    const cell = perCurrency.get(code);
    cell.proposed += Number(it.proposed_cost_cents) || 0;
    cell.actual   += Number(it.actual_cost_cents)   || 0;
  }

  // By category (default currency only) and by day (likewise).
  const defaultItems = items.filter((it) =>
    it.cost_tag !== "n_a"
    && (!it.currency || it.currency.toUpperCase() === defaultCurrency));
  const byCategory = bucketize(defaultItems, "type");
  const byDay = bucketize(defaultItems, "_dayIdx");

  // Settlement — derive via shared helper.
  const settlement = computeSettlement(t);

  return el("section", { class: "print-section budget-summary" },
    el("h2", { text: "Budget summary" }),

    // Per-currency block
    el("div", { class: "print-summary-block" },
      el("div", { class: "section-label small", text: "Per-currency totals" }),
      el("table", { class: "list-table" },
        el("thead", {},
          el("tr", {},
            el("th", { text: "Currency" }),
            el("th", { class: "amount-col", text: "Proposed" }),
            el("th", { class: "amount-col", text: "Actual" }),
            el("th", { class: "amount-col", text: "Variance" }),
          ),
        ),
        el("tbody", {},
          ...[...perCurrency.entries()].map(([code, sums]) => {
            const variance = sums.actual - sums.proposed;
            const varText = sums.actual > 0 && variance !== 0
              ? (variance > 0 ? `+${formatMoney(variance, code)} over`
                              : `−${formatMoney(-variance, code)} under`)
              : "—";
            return el("tr", {},
              el("td", { text: code }),
              el("td", { class: "amount-col", text: formatMoney(sums.proposed, code) || "—" }),
              el("td", { class: "amount-col", text: sums.actual ? formatMoney(sums.actual, code) : "—" }),
              el("td", { class: "amount-col", text: varText }),
            );
          }),
        ),
      ),
    ),

    // By category (default currency only)
    byCategory.size > 0 ? el("div", { class: "print-summary-block" },
      el("div", { class: "section-label small", text: `By category (${defaultCurrency})` }),
      summaryTable(byCategory, defaultCurrency, "category"),
    ) : null,

    // By day (default currency only)
    byDay.size > 0 ? el("div", { class: "print-summary-block" },
      el("div", { class: "section-label small", text: `By day (${defaultCurrency})` }),
      summaryTable(byDay, defaultCurrency, "day", t.days),
    ) : null,

    // Settlement (per-currency, only when non-empty)
    settlement.hasAny ? el("div", { class: "print-summary-block" },
      el("div", { class: "section-label small", text: "Settlement" }),
      ...[...settlement.perCurrency.entries()].map(([code, edges]) =>
        settlementBlock(code, edges, t)),
    ) : null,
  );
}

function bucketize(items, axis) {
  const m = new Map();
  for (const it of items) {
    const key = it[axis];
    if (!m.has(key)) m.set(key, { proposed: 0, actual: 0 });
    const b = m.get(key);
    b.proposed += Number(it.proposed_cost_cents) || 0;
    b.actual   += Number(it.actual_cost_cents)   || 0;
  }
  return m;
}

function summaryTable(buckets, currency, axis, days) {
  // Stable order: ITEM_TYPES for category, sort_order for day.
  let entries;
  if (axis === "category") {
    entries = ITEM_TYPES
      .filter((t) => buckets.has(t))
      .map((t) => [labelForCategory(t), buckets.get(t)]);
  } else {
    entries = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([di, sums]) => [labelForDay(di, days), sums]);
  }
  return el("table", { class: "list-table" },
    el("thead", {},
      el("tr", {},
        el("th", { text: axis === "category" ? "Category" : "Day" }),
        el("th", { class: "amount-col", text: "Proposed" }),
        el("th", { class: "amount-col", text: "Actual" }),
        el("th", { class: "amount-col", text: "Variance" }),
      ),
    ),
    el("tbody", {},
      ...entries.map(([label, sums]) => {
        if (sums.proposed === 0 && sums.actual === 0) return null;
        const variance = sums.actual - sums.proposed;
        const varText = sums.actual > 0 && variance !== 0
          ? (variance > 0 ? `+${formatMoney(variance, currency)} over`
                          : `−${formatMoney(-variance, currency)} under`)
          : "—";
        return el("tr", {},
          el("td", { text: label }),
          el("td", { class: "amount-col", text: formatMoney(sums.proposed, currency) || "—" }),
          el("td", { class: "amount-col", text: sums.actual ? formatMoney(sums.actual, currency) : "—" }),
          el("td", { class: "amount-col", text: varText }),
        );
      }),
    ),
  );
}

function labelForCategory(type) {
  return TYPE_LABELS[type] || type;
}

function labelForDay(dayIdx, days) {
  const d = days?.[dayIdx];
  if (!d) return `Day ${dayIdx + 1}`;
  return `Day ${dayIdx + 1}${d.date ? " · " + formatDate(d.date) : ""}${d.city ? " · " + d.city : ""}`;
}

function settlementBlock(code, edges, trip) {
  const membersById = Object.fromEntries((trip.members || []).map((m) => [m.user_id, m]));
  const nameFor = (uid) => {
    const m = membersById[uid];
    return m?.display_name || m?.email || "Former member";
  };
  let total = 0;
  return el("div", { class: "settlement-print-block" },
    el("div", { class: "settlement-print-code", text: code }),
    el("table", { class: "list-table settlement-print-table" },
      el("tbody", {},
        ...edges.map((e) => {
          total += e.amount;
          return el("tr", {},
            el("td", { class: "from-col", text: nameFor(e.from) }),
            el("td", { class: "arrow-col", text: "→" }),
            el("td", { class: "to-col", text: nameFor(e.to) }),
            el("td", { class: "amount-col", text: formatMoney(e.amount, code) }),
          );
        }),
        el("tr", { class: "settlement-print-total" },
          el("td", { colspan: "3", text: "Total to settle" }),
          el("td", { class: "amount-col", text: formatMoney(total, code) }),
        ),
      ),
    ),
  );
}

// ----- Footer -----

function footer(t) {
  const now = new Date();
  const stamp = now.toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
  return el("footer", { class: "print-footer" },
    el("span", { text: t.title || "Trip itinerary" }),
    el("span", { class: "spacer" }),
    el("span", { text: "Generated " + stamp }),
  );
}

// ===== Helpers =====

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

function formatLongDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return `${WEEKDAY[d.getDay()]}, ${d.toLocaleDateString(undefined, {
    month: "long", day: "numeric", year: "numeric",
  })}`;
}

function formatTimeRange(a, b) {
  if (!a && !b) return "";
  if (a && b) return `${formatTime(a)} – ${formatTime(b)}`;
  return formatTime(a || b);
}
