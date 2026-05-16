// Mobile · Travel · Today — the hero screen.
//
// Renders the NOW/NEXT travel companion experience:
//   1. Pack reminder (when today has unchecked tagged items)
//   2. NOW card (hero, with progress + action row)
//   3. NEXT UP card (with countdown)
//   4. Today's compact plan (full day at a glance)
//
// Edge states:
//   - Pre-trip: countdown to day 1
//   - Post-trip: trip ended summary
//   - Mid-trip gap day: open-day placeholder
//   - No NOW: NEXT promoted to hero
//   - No NEXT: "that's your day" card
//
// Action row (Done / Cancelled / Deferred) writes to itinerary_items.
// Deferred uses cascade_defer_items RPC and surfaces collision warnings.

import { items as itemsApi, packItems } from "../../supabase.js";
import { el, formatTimeRange, formatTime } from "../_utils.js";
import { t, plural, getLocale } from "../../i18n/locale.js";
import { TYPE_VISUALS } from "../itinerary.js";

// ─── Time math ────────────────────────────────────────────────────

function todayIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/^(\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function formatDuration(mins) {
  if (mins == null || mins < 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

// ─── NOW / NEXT computation ───────────────────────────────────────
//
// Rules (from PRD):
//   NOW = item where start_time <= now < end_time (or next item's
//         start if end_time is null). Tiebreaker: is_fixed first,
//         then lower sort_order.
//   NEXT = first item whose start_time > now. Same tiebreaker.

function computeNowNext(items, now) {
  const sortedTimed = [...items]
    .filter((it) => timeToMinutes(it.start_time) != null)
    .sort((a, b) => {
      const at = timeToMinutes(a.start_time);
      const bt = timeToMinutes(b.start_time);
      if (at !== bt) return at - bt;
      // Fixed first, then lower sort_order.
      if (a.is_fixed !== b.is_fixed) return a.is_fixed ? -1 : 1;
      return (a.sort_order || 0) - (b.sort_order || 0);
    });

  let nowItem = null;
  let nextItem = null;
  for (let i = 0; i < sortedTimed.length; i++) {
    const it = sortedTimed[i];
    const start = timeToMinutes(it.start_time);
    const end = timeToMinutes(it.end_time) ??
                (sortedTimed[i + 1] ? timeToMinutes(sortedTimed[i + 1].start_time) : null);
    if (start <= now && (end == null || now < end)) {
      // Found a NOW candidate — preserve fixed-first / sort_order rule
      // for ties (same start_time): we already sorted that way, so the
      // first match wins.
      if (!nowItem) nowItem = it;
    } else if (start > now) {
      if (!nextItem) nextItem = it;
    }
  }
  return { nowItem, nextItem };
}

// ─── Pack reminder ────────────────────────────────────────────────

function todaysUnpackedReminders(trip, todayDayId) {
  const today = (trip.days || []).find((d) => d.id === todayDayId);
  if (!today) return [];
  const itemIds = new Set((today.items || []).map((it) => it.id));
  return (trip.pack_items || [])
    .filter((p) => !p.packed)
    .filter((p) => (p.tagged_item_ids || []).some((id) => itemIds.has(id)));
}

// ─── Main renderer ────────────────────────────────────────────────

export function renderMobileToday(host, ctx) {
  const trip = ctx.trip;
  if (!trip) {
    host.innerHTML = "";
    host.appendChild(el("p", { class: "muted small", text: t("mobile.today.noTrip") }));
    return;
  }

  const today = todayIsoDate();
  const days = trip.days || [];
  const todayDay = days.find((d) => d.date === today);

  host.innerHTML = "";

  // Edge state: empty trip
  if (days.length === 0) {
    host.appendChild(emptyState({
      title: t("mobile.today.empty.title"),
      body: t("mobile.today.empty.body"),
    }));
    return;
  }

  // Edge state: pre-trip (today is before any day)
  const firstDay = days.find((d) => d.date);
  if (firstDay && today < firstDay.date) {
    host.appendChild(preTripCard(trip, firstDay));
    return;
  }

  // Edge state: post-trip (today is after the last dated day)
  const lastDay = [...days].reverse().find((d) => d.date);
  if (lastDay && today > lastDay.date) {
    host.appendChild(postTripCard(trip));
    return;
  }

  // Edge state: gap day (in trip range but no day matches today)
  if (!todayDay) {
    host.appendChild(gapDayCard(trip, today));
    return;
  }

  // Active day — render reminder + NOW/NEXT + compact plan.
  const dayItems = (todayDay.items || []).filter((it) => !it.is_unplanned);
  const now = nowMinutes();
  const { nowItem, nextItem } = computeNowNext(dayItems, now);

  // 1. Pack reminder box
  const remind = todaysUnpackedReminders(trip, todayDay.id);
  if (remind.length > 0) host.appendChild(renderPackReminder(host, ctx, remind, todayDay.id));

  // 2. NOW card (or promoted NEXT if no NOW)
  if (nowItem) {
    host.appendChild(renderNowCard(ctx, nowItem, todayDay, nextItem));
  } else if (nextItem) {
    host.appendChild(renderNextAsHero(ctx, nextItem, todayDay, now));
  } else {
    host.appendChild(thatsYourDayCard(todayDay));
  }

  // 3. NEXT UP card (only if NOW was set; otherwise NEXT was promoted)
  if (nowItem && nextItem) {
    host.appendChild(renderNextCard(ctx, nextItem, now));
  }

  // 4. Today's compact plan
  host.appendChild(renderTodayPlan(ctx, dayItems, nowItem));
}

// ─── Card builders ────────────────────────────────────────────────

function renderPackReminder(host, ctx, items, todayDayId) {
  const card = el("section", { class: "vy-mobile-pack-reminder" });
  const head = el("button", {
    class: "vy-mobile-pack-reminder-head",
    onClick: () => card.classList.toggle("is-open"),
  },
    el("span", { class: "material-symbols-outlined", text: "luggage" }),
    el("span", { class: "vy-mobile-pack-reminder-title",
      text: plural("mobile.today.packReminder", items.length, { n: items.length }) }),
    el("span", { class: "material-symbols-outlined vy-mobile-pack-reminder-chev",
      text: "expand_more" }),
  );
  card.appendChild(head);

  const list = el("div", { class: "vy-mobile-pack-reminder-list" });
  for (const p of items) {
    const row = el("button", {
      class: "vy-mobile-pack-reminder-row",
      onClick: async () => {
        try {
          await packItems.update(p.id, { packed: true });
          // Local-mutate so the row disappears immediately.
          p.packed = true;
          ctx.rerender?.();
        } catch (e) {
          ctx.toast?.(t("mobile.today.markPackedFailed", { error: e.message || e }), true);
        }
      },
    },
      el("span", { class: "material-symbols-outlined", text: "check_box_outline_blank" }),
      el("span", { text: p.title }),
    );
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function renderNowCard(ctx, it, day, nextItem) {
  const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
  const startMin = timeToMinutes(it.start_time);
  const endMin = timeToMinutes(it.end_time);
  const now = nowMinutes();

  const card = el("section", { class: "vy-mobile-now card", onClick: () => drillIn(ctx, it) });

  // Top: NOW · time range + type chip
  const top = el("div", { class: "vy-mobile-now-top" });
  const timeText = it.end_time
    ? t("mobile.today.nowRange", { start: formatTime(it.start_time), end: formatTime(it.end_time) })
    : t("mobile.today.nowAt", { start: formatTime(it.start_time) });
  top.appendChild(el("span", { class: "vy-mobile-now-livedot",
    html: `<span class="material-symbols-outlined">circle</span> ${timeText}` }));
  top.appendChild(typeChip(v));
  card.appendChild(top);

  // Title + sub
  card.appendChild(el("h2", { class: "vy-mobile-now-title", text: it.title || t("mobile.today.untitled") }));
  if (it.location_name) {
    card.appendChild(el("p", { class: "vy-mobile-now-sub", text: it.location_name }));
  }

  // Progress bar (when both times exist)
  if (startMin != null && endMin != null && endMin > startMin) {
    const total = endMin - startMin;
    const elapsed = Math.max(0, Math.min(total, now - startMin));
    const pct = Math.round((elapsed / total) * 100);
    const remainText = formatDuration(total - elapsed);
    const elapsedText = formatDuration(elapsed);
    card.appendChild(el("div", { class: "vy-mobile-now-progress" },
      el("div", { class: "vy-mobile-now-progress-row" },
        el("span", { class: "mono small",
          text: t("mobile.today.elapsedRemaining", { elapsed: elapsedText, remaining: remainText }) }),
        el("span", { class: "vy-meta", text: t("mobile.today.pctComplete", { pct }) }),
      ),
      el("div", { class: "vy-mobile-now-progress-bar" },
        el("div", { class: "vy-mobile-now-progress-fill",
          style: `width: ${pct}%` }),
      ),
    ));
  } else if (startMin != null) {
    const elapsed = Math.max(0, now - startMin);
    card.appendChild(el("div", { class: "vy-mobile-now-progress" },
      el("div", { class: "vy-mobile-now-progress-row" },
        el("span", { class: "mono small", text: t("mobile.today.startedAgo", { duration: formatDuration(elapsed) }) }),
      ),
    ));
  }

  // Action row
  card.appendChild(renderActionRow(ctx, it));

  return card;
}

function renderNextAsHero(ctx, it, day, now) {
  // No NOW item — NEXT becomes the hero.
  const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
  const startMin = timeToMinutes(it.start_time);
  const inMins = startMin != null ? Math.max(0, startMin - now) : null;
  const card = el("section", {
    class: "vy-mobile-now card",
    onClick: () => drillIn(ctx, it),
  });
  const top = el("div", { class: "vy-mobile-now-top" });
  top.appendChild(el("span", { class: "vy-mobile-now-livedot",
    text: inMins != null ? t("mobile.today.nextUpIn", { duration: formatDuration(inMins) }) : t("mobile.today.nextUp") }));
  top.appendChild(typeChip(v));
  card.appendChild(top);
  card.appendChild(el("h2", { class: "vy-mobile-now-title", text: it.title || t("mobile.today.untitled") }));
  if (it.location_name) {
    card.appendChild(el("p", { class: "vy-mobile-now-sub", text: it.location_name }));
  }
  if (it.start_time) {
    card.appendChild(el("p", { class: "vy-mobile-now-sub mono small",
      text: formatTimeRange(it.start_time, it.end_time) }));
  }
  card.appendChild(renderActionRow(ctx, it));
  return card;
}

function renderNextCard(ctx, it, now) {
  const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
  const startMin = timeToMinutes(it.start_time);
  const inMins = startMin != null ? Math.max(0, startMin - now) : null;
  return el("section", {
    class: "vy-mobile-next card",
    onClick: () => drillIn(ctx, it),
  },
    el("div", { class: "vy-mobile-next-top" },
      el("span", { class: "vy-meta",
        text: inMins != null ? t("mobile.today.nextUpIn", { duration: formatDuration(inMins) }) : t("mobile.today.nextUp") }),
      typeChip(v),
    ),
    el("div", { class: "vy-mobile-next-row" },
      el("div", { class: "vy-mobile-next-time mono", text: formatTime(it.start_time) || "—" }),
      el("div", { class: "vy-mobile-next-body" },
        el("div", { class: "vy-mobile-next-title", text: it.title || t("mobile.today.untitled") }),
        it.location_name
          ? el("div", { class: "vy-mobile-next-sub", text: it.location_name }) : null,
      ),
      el("span", { class: "material-symbols-outlined vy-mobile-next-chev",
        text: "chevron_right" }),
    ),
  );
}

function renderTodayPlan(ctx, items, nowItem) {
  const card = el("section", { class: "vy-mobile-plan card" });
  card.appendChild(el("header", { class: "vy-mobile-plan-head" },
    el("h3", { text: t("mobile.today.plan.title") }),
    el("span", { class: "vy-meta",
      text: plural("mobile.today.plan.count", items.length, { n: items.length }) }),
  ));
  const list = el("div", { class: "vy-mobile-plan-list" });
  const now = nowMinutes();
  for (const it of items) {
    const startMin = timeToMinutes(it.start_time);
    const endMin = timeToMinutes(it.end_time);
    const isNow = it.id === nowItem?.id;
    const isPast = !isNow && endMin != null && endMin < now;
    const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
    const row = el("button", {
      class: `vy-mobile-plan-row ${isPast ? "is-past" : ""} ${isNow ? "is-now" : ""}`.trim(),
      onClick: () => drillIn(ctx, it),
    },
      el("span", { class: "vy-mobile-plan-time mono small",
        text: formatTime(it.start_time) || "—" }),
      el("span", { class: `vy-mobile-plan-pip vy-pip--${v.chipClass}` }),
      el("span", { class: "vy-mobile-plan-title",
        text: it.title || t("mobile.today.untitled") }),
      isNow ? el("span", { class: "vy-mobile-plan-tag-now", text: t("mobile.today.plan.nowTag") })
            : isPast ? el("span", { class: "material-symbols-outlined", text: "check" })
            : el("span", { class: "material-symbols-outlined", text: "chevron_right" }),
    );
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function thatsYourDayCard(day) {
  return el("section", { class: "vy-mobile-done card" },
    el("span", { class: "material-symbols-outlined", text: "check_circle" }),
    el("h2", { text: t("mobile.today.thatsYourDay.title") }),
    el("p", { class: "muted", text: t("mobile.today.thatsYourDay.body") }),
  );
}

function preTripCard(trip, firstDay) {
  const days = Math.max(0, Math.ceil(
    (new Date(firstDay.date + "T00:00:00").getTime() - new Date(todayIsoDate() + "T00:00:00").getTime())
    / (1000 * 60 * 60 * 24)
  ));
  const dateLabel = new Date(firstDay.date + "T00:00:00").toLocaleDateString(getLocale(),
    { weekday: "short", month: "short", day: "numeric" });
  return el("section", { class: "vy-mobile-edge card" },
    el("span", { class: "material-symbols-outlined", text: "rocket_launch" }),
    el("h2", { text: days === 0
      ? t("mobile.today.preTrip.todayHeader")
      : plural("mobile.today.preTrip.daysHeader", days, { n: days }) }),
    el("p", { class: "muted",
      text: t("mobile.today.preTrip.day1Is", {
        date: dateLabel,
        city: firstDay.city ? " · " + firstDay.city : "",
      }) }),
  );
}

function postTripCard(trip) {
  return el("section", { class: "vy-mobile-edge card" },
    el("span", { class: "material-symbols-outlined", text: "flag" }),
    el("h2", { text: t("mobile.today.postTrip.header") }),
    el("p", { class: "muted", text: t("mobile.today.postTrip.body") }),
  );
}

function gapDayCard(trip, todayIso) {
  const date = new Date(todayIso + "T00:00:00").toLocaleDateString(getLocale(),
    { weekday: "short", month: "short", day: "numeric" });
  return el("section", { class: "vy-mobile-edge card" },
    el("span", { class: "material-symbols-outlined", text: "today" }),
    el("h2", { text: t("mobile.today.gap.header") }),
    el("p", { class: "muted", text: t("mobile.today.gap.body", { date }) }),
  );
}

function emptyState({ title, body }) {
  return el("section", { class: "vy-mobile-edge card" },
    el("h2", { text: title }),
    el("p", { class: "muted", text: body }),
  );
}

// ─── Type chip + action row ───────────────────────────────────────

function typeChip(v) {
  return el("span", { class: `vy-chip vy-chip--${v.chipClass}` },
    el("span", { class: "material-symbols-outlined", text: v.glyph }),
    el("span", { text: v.label }),
  );
}

function renderActionRow(ctx, it) {
  // Defer hidden on fixed items — a flight at 14:00 stays at 14:00.
  const showDefer = !it.is_fixed;
  const row = el("div", { class: "vy-mobile-action-row" });

  row.appendChild(actionBtn("check", t("mobile.today.action.done"), async () => {
    await safeUpdate(ctx, it, { status: "done" }, t("mobile.today.action.markedDone"));
  }));
  row.appendChild(actionBtn("close", t("mobile.today.action.cancelled"), async () => {
    await safeUpdate(ctx, it, { status: "cancelled" }, t("mobile.today.action.markedCancelled"));
  }));
  if (showDefer) row.appendChild(deferBtn(ctx, it));

  return row;
}

function actionBtn(glyph, label, onClick) {
  return el("button", { class: "vy-mobile-action-btn", onClick: (e) => {
    e.stopPropagation();
    onClick();
  } },
    el("span", { class: "material-symbols-outlined", text: glyph }),
    el("span", { text: label }),
  );
}

function deferBtn(ctx, it) {
  const wrap = el("div", { class: "vy-mobile-defer-wrap" });
  const btn = el("button", {
    class: "vy-mobile-action-btn vy-mobile-defer-btn",
    onClick: (e) => {
      e.stopPropagation();
      wrap.classList.toggle("is-open");
    },
  },
    el("span", { class: "material-symbols-outlined", text: "schedule" }),
    el("span", { text: t("mobile.today.action.defer") }),
  );
  const picker = el("div", { class: "vy-mobile-defer-picker" });
  for (const mins of [30, 60]) {
    picker.appendChild(el("button", {
      class: "vy-mobile-defer-pick",
      onClick: (e) => {
        e.stopPropagation();
        wrap.classList.remove("is-open");
        runDefer(ctx, it, mins);
      },
    }, mins === 60 ? t("mobile.today.defer60") : t("mobile.today.defer30")));
  }
  wrap.append(btn, picker);
  return wrap;
}

async function safeUpdate(ctx, it, patch, doneMsg) {
  ctx.onSaveStart?.();
  try {
    await itemsApi.update(it.id, patch);
    Object.assign(it, patch);
    ctx.toast?.(doneMsg);
    ctx.rerender?.();
  } catch (e) {
    ctx.toast?.(e.message || String(e), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

async function runDefer(ctx, it, mins) {
  ctx.onSaveStart?.();
  try {
    const collisions = await itemsApi.cascadeDefer(it.id, mins);
    const amount = mins === 60
      ? t("mobile.today.deferOneHour")
      : t("mobile.today.deferMin", { n: mins });
    const base = t("mobile.today.deferred", { amount });
    ctx.toast?.(collisions > 0
      ? t("mobile.today.deferredCollisions", { base, n: collisions })
      : base);
    // Refetch to get the updated times.
    await ctx.refresh?.();
  } catch (e) {
    ctx.toast?.(e.message || String(e), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

function drillIn(ctx, it) {
  // For now navigate to the detail page (slice 06 will build it).
  ctx.navigate?.({ page: "detail", item: it.id });
}
