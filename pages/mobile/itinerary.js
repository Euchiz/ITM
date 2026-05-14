// Mobile · Overview · Itinerary — compact reorder-only day list.
//
// Each day is a glass card. Each item is a row with type chip + time +
// title + a small reorder menu (↑ / ↓ / Delete). Tapping a row drills
// into Detail. Inline string-editing is desktop-only.
//
// "Reorder" includes both same-day item reordering (sort_order) and
// day reordering — when days move, their `date` field is re-aligned
// so the user gets the intuitive "drag Day 3 above Day 1" behaviour
// without ending up with out-of-sequence dates.

import { days as daysApi, items as itemsApi } from "../../supabase.js";
import { el, formatTime, formatTimeRange } from "../_utils.js";
import { TYPE_VISUALS } from "../itinerary.js";

export function renderMobileItinerary(host, ctx) {
  const trip = ctx.trip;
  if (!trip) {
    host.innerHTML = "";
    host.appendChild(el("p", { class: "muted small", text: "No trip loaded." }));
    return;
  }
  host.innerHTML = "";

  const days = trip.days || [];
  if (days.length === 0) {
    host.appendChild(emptyCard(
      "No days yet",
      "Tap + Add day below to start planning."
    ));
    host.appendChild(addDayBtn(ctx));
    return;
  }

  days.forEach((day, di) => host.appendChild(renderDayCard(ctx, day, di, days.length)));
  host.appendChild(addDayBtn(ctx));
}

// ─── Day card ─────────────────────────────────────────────────────

function renderDayCard(ctx, day, dayIdx, totalDays) {
  const dateLabel = day.date
    ? new Date(day.date + "T00:00:00").toLocaleDateString(undefined,
        { weekday: "short", month: "short", day: "numeric" })
    : "Set date";
  const heading = `Day ${dayIdx + 1} · ${dateLabel}${day.city ? " · " + day.city : ""}`;
  const items = (day.items || []).filter((it) => !it.is_unplanned);

  const card = el("section", { class: "vy-mobile-iti-day card" });

  // Header — title + item count + reorder arrows + delete menu
  card.appendChild(el("header", { class: "vy-mobile-iti-day-head" },
    el("div", { class: "vy-mobile-iti-day-meta" },
      el("span", { class: "vy-meta", text: heading.toUpperCase() }),
      el("span", { class: "muted small",
        text: `${items.length} item${items.length === 1 ? "" : "s"}` }),
    ),
    el("div", { class: "vy-mobile-iti-day-actions" },
      iconBtn("arrow_upward", "Move up",
        dayIdx === 0 ? "is-disabled" : "",
        () => moveDay(ctx, dayIdx, -1)),
      iconBtn("arrow_downward", "Move down",
        dayIdx === totalDays - 1 ? "is-disabled" : "",
        () => moveDay(ctx, dayIdx, +1)),
      iconBtn("delete_outline", "Delete day", "is-danger",
        () => deleteDay(ctx, day)),
    ),
  ));

  // Items
  const list = el("div", { class: "vy-mobile-iti-list" });
  items.forEach((it, ii) => list.appendChild(renderItemRow(ctx, day, it, ii, items.length)));
  card.appendChild(list);

  // + Add event
  card.appendChild(el("button", {
    class: "vy-mobile-iti-add",
    onClick: () => addItem(ctx, day),
  },
    el("span", { class: "material-symbols-outlined", text: "add" }),
    el("span", { text: "Add event" }),
  ));

  return card;
}

// ─── Item row ─────────────────────────────────────────────────────

function renderItemRow(ctx, day, item, idx, total) {
  const v = TYPE_VISUALS[item.type] || TYPE_VISUALS.activity;
  const time = formatTimeRange(item.start_time, item.end_time) || formatTime(item.start_time);

  const row = el("div", { class: "vy-mobile-iti-row" });

  // Tap-target body — drills into detail
  row.appendChild(el("button", {
    class: "vy-mobile-iti-row-body",
    onClick: () => ctx.navigate?.({ page: "detail", item: item.id }),
  },
    el("span", { class: `vy-chip vy-chip--${v.chipClass} vy-mobile-iti-typechip` },
      el("span", { class: "material-symbols-outlined", text: v.glyph }),
    ),
    el("span", { class: "vy-mobile-iti-time mono small", text: time || "—" }),
    el("span", { class: "vy-mobile-iti-title", text: item.title || "(untitled)" }),
    item.is_highlight ? el("span", { class: "material-symbols-outlined vy-mobile-iti-star",
      text: "star" }) : null,
  ));

  // Reorder + delete cluster
  row.appendChild(el("div", { class: "vy-mobile-iti-row-actions" },
    iconBtn("arrow_upward", "Move up",
      idx === 0 ? "is-disabled" : "",
      () => moveItem(ctx, day, idx, -1)),
    iconBtn("arrow_downward", "Move down",
      idx === total - 1 ? "is-disabled" : "",
      () => moveItem(ctx, day, idx, +1)),
    iconBtn("delete_outline", "Delete", "is-danger",
      () => deleteItem(ctx, item)),
  ));

  return row;
}

// ─── Mutators ─────────────────────────────────────────────────────

async function moveDay(ctx, dayIdx, delta) {
  const days = ctx.trip?.days || [];
  const targetIdx = dayIdx + delta;
  if (targetIdx < 0 || targetIdx >= days.length) return;

  // Swap in local state for instant feedback
  const next = [...days];
  [next[dayIdx], next[targetIdx]] = [next[targetIdx], next[dayIdx]];
  ctx.trip.days = next;

  // Re-date if both swapping days have explicit dates
  let dateReassigned = false;
  const dated = next.filter((d) => d.date);
  if (dated.length === next.length) {
    // All days dated — sort dates ascending and reassign so order is consecutive
    const sortedDates = next.map((d) => d.date).sort();
    next.forEach((d, i) => { d.date = sortedDates[i]; });
    dateReassigned = true;
  }

  ctx.rerender?.();
  ctx.onSaveStart?.();
  try {
    await daysApi.reorder(next.map((d) => d.id));
    if (dateReassigned) {
      // Best-effort: persist date changes one by one
      for (const d of next) {
        await daysApi.update(d.id, { date: d.date || null });
      }
      ctx.toast?.("Day order updated · dates re-aligned");
    } else {
      ctx.toast?.("Day order updated");
    }
  } catch (e) {
    ctx.toast?.("Couldn't reorder: " + (e.message || e), true);
    await ctx.refresh?.();
  } finally {
    ctx.onSaveDone?.();
  }
}

async function moveItem(ctx, day, idx, delta) {
  const items = (day.items || []).filter((it) => !it.is_unplanned);
  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= items.length) return;

  const next = [...items];
  [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];

  // Map back to day.items preserving any unplanned items
  const unplanned = (day.items || []).filter((it) => it.is_unplanned);
  day.items = [...next, ...unplanned];
  next.forEach((it, i) => { it.sort_order = i; });

  ctx.rerender?.();
  ctx.onSaveStart?.();
  try {
    await itemsApi.reorder(next.map((it) => it.id));
  } catch (e) {
    ctx.toast?.("Couldn't reorder: " + (e.message || e), true);
    await ctx.refresh?.();
  } finally {
    ctx.onSaveDone?.();
  }
}

async function deleteDay(ctx, day) {
  if (!confirm(`Delete this day? All its events will be deleted too.`)) return;
  ctx.onSaveStart?.();
  try {
    await daysApi.remove(day.id);
    await ctx.refresh?.();
    ctx.toast?.("Day deleted");
  } catch (e) {
    ctx.toast?.("Couldn't delete: " + (e.message || e), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

async function deleteItem(ctx, item) {
  if (!confirm(`Delete "${item.title || "this event"}"?`)) return;
  ctx.onSaveStart?.();
  try {
    await itemsApi.remove(item.id);
    await ctx.refresh?.();
    ctx.toast?.("Event deleted");
  } catch (e) {
    ctx.toast?.("Couldn't delete: " + (e.message || e), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

async function addItem(ctx, day) {
  const title = window.prompt("Event title:", "");
  if (title == null) return;
  ctx.onSaveStart?.();
  try {
    const items = (day.items || []).filter((it) => !it.is_unplanned);
    await itemsApi.add(ctx.trip.id, day.id, {
      title: title.trim() || "Untitled",
      type: "activity",
      sort_order: items.length,
    });
    await ctx.refresh?.();
  } catch (e) {
    ctx.toast?.("Couldn't add: " + (e.message || e), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

async function addNewDay(ctx) {
  const days = ctx.trip?.days || [];
  ctx.onSaveStart?.();
  try {
    // Default date: day after the last existing day, else today
    let nextDate = null;
    if (days.length > 0) {
      const lastDated = [...days].reverse().find((d) => d.date);
      if (lastDated) {
        const d = new Date(lastDated.date + "T00:00:00");
        d.setDate(d.getDate() + 1);
        nextDate = d.toISOString().slice(0, 10);
      }
    }
    await daysApi.add(ctx.trip.id, {
      date: nextDate,
      title: "",
      city: "",
      sort_order: days.length,
    });
    await ctx.refresh?.();
  } catch (e) {
    ctx.toast?.("Couldn't add day: " + (e.message || e), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

// ─── UI helpers ───────────────────────────────────────────────────

function iconBtn(glyph, title, extraClass, onClick) {
  const disabled = (extraClass || "").includes("is-disabled");
  return el("button", {
    class: `vy-mobile-iti-iconbtn ${extraClass || ""}`.trim(),
    title,
    "aria-label": title,
    disabled: disabled,
    onClick: disabled ? undefined : (e) => {
      e.stopPropagation();
      onClick();
    },
  },
    el("span", { class: "material-symbols-outlined", text: glyph }),
  );
}

function addDayBtn(ctx) {
  return el("button", {
    class: "vy-mobile-iti-add-day btn primary",
    onClick: () => addNewDay(ctx),
  },
    el("span", { class: "material-symbols-outlined", text: "add" }),
    el("span", { text: "Add day" }),
  );
}

function emptyCard(title, body) {
  return el("section", { class: "vy-mobile-edge card" },
    el("span", { class: "material-symbols-outlined", text: "calendar_today" }),
    el("h2", { text: title }),
    el("p", { class: "muted", text: body }),
  );
}
