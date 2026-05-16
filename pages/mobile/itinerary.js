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
import { el, formatTime } from "../_utils.js";
import { t, plural, getLocale } from "../../i18n/locale.js";
import { TYPE_VISUALS } from "../itinerary.js";

export function renderMobileItinerary(host, ctx) {
  const trip = ctx.trip;
  if (!trip) {
    host.innerHTML = "";
    host.appendChild(el("p", { class: "muted small", text: t("mobile.iti.noTrip") }));
    return;
  }
  host.innerHTML = "";

  const days = trip.days || [];
  if (days.length === 0) {
    host.appendChild(emptyCard(
      t("mobile.iti.empty.title"),
      t("mobile.iti.empty.body"),
    ));
    host.appendChild(addDayBtn(ctx));
    return;
  }

  days.forEach((day, di) => host.appendChild(renderDayCard(ctx, day, di)));
  host.appendChild(addDayBtn(ctx));
}

// ─── Day card ─────────────────────────────────────────────────────

function renderDayCard(ctx, day, dayIdx) {
  const dateLabel = day.date
    ? new Date(day.date + "T00:00:00").toLocaleDateString(getLocale(),
        { weekday: "short", month: "short", day: "numeric" })
    : t("mobile.iti.setDate");
  const heading = `${t("itinerary.day", { n: dayIdx + 1 })} · ${dateLabel}${day.city ? " · " + day.city : ""}`;
  const items = (day.items || []).filter((it) => !it.is_unplanned);

  const card = el("section", { class: "vy-mobile-iti-day card" });

  // Header — title + item count + reorder arrows + delete menu
  card.appendChild(el("header", { class: "vy-mobile-iti-day-head" },
    el("div", { class: "vy-mobile-iti-day-meta" },
      el("span", { class: "vy-meta", text: heading.toUpperCase() }),
      el("span", { class: "muted small",
        text: plural("mobile.iti.itemCount", items.length, { n: items.length }) }),
    ),
    el("div", { class: "vy-mobile-iti-day-actions" },
      iconBtn("delete_outline", t("mobile.iti.deleteDayTip"), "is-danger",
        () => deleteDay(ctx, day)),
    ),
  ));

  // Items
  const list = el("div", { class: "vy-mobile-iti-list" });
  items.forEach((it) => list.appendChild(renderItemRow(ctx, day, it)));
  card.appendChild(list);

  // + Add event
  card.appendChild(el("button", {
    class: "vy-mobile-iti-add",
    onClick: () => addItem(ctx, day),
  },
    el("span", { class: "material-symbols-outlined", text: "add" }),    el("span", { text: t("mobile.iti.addEvent") }),
  ));

  return card;
}

// ─── Item row ─────────────────────────────────────────────────────

function renderItemRow(ctx, day, item) {
  const v = TYPE_VISUALS[item.type] || TYPE_VISUALS.activity;
  // Show only the start time on mobile — full ranges ("10:30 → 12:00")
  // crowd out the title on phone widths. Time-less items render "—".
  const time = formatTime(item.start_time);

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
    el("span", { class: "vy-mobile-iti-title", text: item.title || t("mobile.iti.untitled") }),
    item.is_highlight ? el("span", { class: "material-symbols-outlined vy-mobile-iti-star",
      text: "star" }) : null,
  ));

  // Delete only — drag-to-reorder ships later; the ↑/↓ buttons made
  // the row too dense for phone widths.
  row.appendChild(el("div", { class: "vy-mobile-iti-row-actions" },
    iconBtn("delete_outline", t("mobile.iti.deleteTip"), "is-danger",
      () => deleteItem(ctx, item)),
  ));

  return row;
}

// ─── Mutators ─────────────────────────────────────────────────────
//
// Reordering events and days lands in a polish slice — phone-width
// rows can't host ↑/↓ buttons cleanly, and proper touch drag-and-drop
// (long-press, scroll lock, drop indicator) is its own piece of work.
// Mobile users reorder on desktop for now.

async function deleteDay(ctx, day) {
  if (!confirm(t("mobile.iti.confirmDeleteDay"))) return;
  ctx.onSaveStart?.();
  try {
    await daysApi.remove(day.id);
    await ctx.refresh?.();
    ctx.toast?.(t("mobile.iti.dayDeleted"));
  } catch (e) {
    ctx.toast?.(t("mobile.iti.deleteFailed", { error: e.message || e }), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

async function deleteItem(ctx, item) {
  const title = item.title || t("mobile.iti.thisEvent");
  if (!confirm(t("mobile.iti.confirmDeleteItem", { title }))) return;
  ctx.onSaveStart?.();
  try {
    await itemsApi.remove(item.id);
    await ctx.refresh?.();
    ctx.toast?.(t("mobile.iti.eventDeleted"));
  } catch (e) {
    ctx.toast?.(t("mobile.iti.deleteFailed", { error: e.message || e }), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

async function addItem(ctx, day) {
  const title = window.prompt(t("mobile.iti.eventTitlePrompt"), "");
  if (title == null) return;
  ctx.onSaveStart?.();
  try {
    const items = (day.items || []).filter((it) => !it.is_unplanned);
    await itemsApi.add(ctx.trip.id, day.id, {
      title: title.trim() || t("mobile.iti.untitledFallback"),
      type: "activity",
      sort_order: items.length,
    });
    await ctx.refresh?.();
  } catch (e) {
    ctx.toast?.(t("mobile.iti.addFailed", { error: e.message || e }), true);
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
    ctx.toast?.(t("mobile.iti.addDayFailed", { error: e.message || e }), true);
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
    el("span", { text: t("mobile.iti.addDay") }),
  );
}

function emptyCard(title, body) {
  return el("section", { class: "vy-mobile-edge card" },
    el("span", { class: "material-symbols-outlined", text: "calendar_today" }),
    el("h2", { text: title }),
    el("p", { class: "muted", text: body }),
  );
}
