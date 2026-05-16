// Mobile · Detail drill-in.
//
// Reached by tapping NOW / NEXT / Today list / Itinerary compact rows.
// Content is read-only on mobile (edit strings on desktop) — but state
// flips (Done / Cancelled / Defer, mark highlight, check off tagged
// pack items) work in-place since they're one-tap state changes.

import { items as itemsApi, packItems } from "../../supabase.js";
import { el, formatTime, formatTimeRange } from "../_utils.js";
import { t, getLocale } from "../../i18n/locale.js";
import { TYPE_VISUALS } from "../itinerary.js";

// Reuse the time math from Today; small enough to inline rather than
// import from a shared helper.
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

// Status enum — values and labels in user-friendly order.
const STATUS_OPTIONS = [
  { value: "idea",          labelKey: "mobile.detail.status.idea" },
  { value: "planned",       labelKey: "mobile.detail.status.planned" },
  { value: "needs_booking", labelKey: "mobile.detail.status.needs_booking" },
  { value: "booked",        labelKey: "mobile.detail.status.booked" },
  { value: "done",          labelKey: "mobile.detail.status.done" },
  { value: "cancelled",     labelKey: "mobile.detail.status.cancelled" },
];

export function renderMobileDetail(host, ctx) {
  const itemId = ctx.selectedItemId;
  host.innerHTML = "";
  if (!itemId) {
    host.appendChild(emptyCard(t("mobile.detail.noItem.title"), t("mobile.detail.noItem.body")));
    return;
  }

  // Find the item + its day across the trip.
  const { item, day, dayIdx } = findItem(ctx.trip, itemId);
  if (!item) {
    host.appendChild(emptyCard(t("mobile.detail.notFound.title"), t("mobile.detail.notFound.body")));
    return;
  }

  const v = TYPE_VISUALS[item.type] || TYPE_VISUALS.activity;

  // Hero block — gradient stripe + type chip + countdown pill.
  host.appendChild(renderHero(item, day, dayIdx, v));

  // Detail rows.
  host.appendChild(detailRow("schedule", t("mobile.detail.when"),
    item.start_time || item.end_time
      ? formatTimeRange(item.start_time, item.end_time) || formatTime(item.start_time)
      : t("mobile.detail.timeNotSet"),
    item.end_time && item.start_time
      ? formatDuration(timeToMinutes(item.end_time) - timeToMinutes(item.start_time))
      : null));

  if (item.location_name) {
    host.appendChild(detailRow("location_on", t("mobile.detail.where"),
      item.location_name,
      day?.city ? `${day.city}` : null));
  }

  if (item.notes && item.notes.trim()) {
    host.appendChild(detailRow("notes", t("mobile.detail.notes"), item.notes, null, { multiline: true }));
  }

  // Pack row — tagged pack items for this event with inline checkboxes.
  const tagged = (ctx.trip?.pack_items || [])
    .filter((p) => (p.tagged_item_ids || []).includes(item.id));
  if (tagged.length > 0) {
    host.appendChild(packRow(ctx, tagged));
  }

  // Action row — same as Today's NOW card.
  host.appendChild(renderActionRow(ctx, item));

  // Status + highlight toggles.
  host.appendChild(renderStatusBar(ctx, item));

  // Read-only footer hint.
  host.appendChild(el("p", { class: "vy-mobile-detail-footer muted small",
    text: t("mobile.detail.editOnDesktop") }));
}

// ─── Hero ─────────────────────────────────────────────────────────

function renderHero(item, day, dayIdx, v) {
  const hero = el("section", {
    class: `vy-mobile-detail-hero vy-mobile-hero--${v.chipClass}`,
  });

  // Top corners: type chip (left), countdown pill (right)
  const topRow = el("div", { class: "vy-mobile-detail-hero-top" });
  topRow.appendChild(el("span", { class: `vy-chip vy-chip--${v.chipClass}` },
    el("span", { class: "material-symbols-outlined", text: v.glyph }),
    el("span", { text: v.label }),
  ));
  const pill = countdownPill(item);
  if (pill) topRow.appendChild(pill);
  hero.appendChild(topRow);

  // Bottom: caption + title overlaid on the gradient stripe
  const dateLabel = day?.date
    ? new Date(day.date + "T00:00:00").toLocaleDateString(getLocale(),
        { weekday: "short", month: "short", day: "numeric" }).toUpperCase()
    : t("mobile.detail.dayLabelCaps", { n: (dayIdx ?? 0) + 1 });
  const timeLabel = item.start_time ? ` · ${formatTime(item.start_time)}` : "";
  const caption = `${dateLabel}${day?.city ? " · " + day.city.toUpperCase() : ""}${timeLabel}`;
  const bottom = el("div", { class: "vy-mobile-detail-hero-bottom" },
    el("div", { class: "vy-mobile-detail-hero-caption", text: caption }),
    el("h1", { class: "vy-mobile-detail-hero-title", text: item.title || t("mobile.detail.untitled") }),
  );
  hero.appendChild(bottom);
  return hero;
}

function countdownPill(item) {
  const startMin = timeToMinutes(item.start_time);
  if (startMin == null) return null;
  const endMin = timeToMinutes(item.end_time);
  const now = nowMinutes();
  let text;
  if (now < startMin) {
    text = t("mobile.detail.startsIn", { duration: formatDuration(startMin - now) });
  } else if (endMin == null) {
    text = t("mobile.detail.startedAgo", { duration: formatDuration(now - startMin) });
  } else if (now < endMin) {
    text = t("mobile.detail.liveLeft", { duration: formatDuration(endMin - now) });
  } else {
    text = t("mobile.detail.endedAgo", { duration: formatDuration(now - endMin) });
  }
  return el("span", { class: "vy-mobile-detail-countdown", text });
}

// ─── Detail rows ──────────────────────────────────────────────────

function detailRow(glyph, label, value, sub, { multiline = false } = {}) {
  return el("section", {
    class: `vy-mobile-detail-row ${multiline ? "is-multiline" : ""}`.trim(),
  },
    el("div", { class: "vy-mobile-detail-row-icon" },
      el("span", { class: "material-symbols-outlined", text: glyph }),
    ),
    el("div", { class: "vy-mobile-detail-row-body" },
      el("div", { class: "vy-mobile-detail-row-label", text: label }),
      el("div", { class: "vy-mobile-detail-row-value", text: value }),
      sub ? el("div", { class: "vy-mobile-detail-row-sub", text: sub }) : null,
    ),
  );
}

function packRow(ctx, packs) {
  const wrap = el("section", { class: "vy-mobile-detail-row" },
    el("div", { class: "vy-mobile-detail-row-icon" },
      el("span", { class: "material-symbols-outlined", text: "luggage" }),
    ),
  );
  const body = el("div", { class: "vy-mobile-detail-row-body" },
    el("div", { class: "vy-mobile-detail-row-label",
      text: t("mobile.detail.packLabel", { packed: packs.filter((p) => p.packed).length, total: packs.length }) }),
  );
  const list = el("div", { class: "vy-mobile-detail-pack-list" });
  for (const p of packs) list.appendChild(renderPackPill(ctx, p));
  body.appendChild(list);
  wrap.appendChild(body);
  return wrap;
}

function renderPackPill(ctx, p) {
  const pill = el("button", {
    class: `vy-mobile-detail-pack-pill ${p.packed ? "is-packed" : ""}`.trim(),
    onClick: async (e) => {
      e.stopPropagation();
      const target = !p.packed;
      pill.classList.toggle("is-packed", target);
      try {
        await packItems.update(p.id, { packed: target });
        p.packed = target;
      } catch (err) {
        pill.classList.toggle("is-packed", !target);
        ctx.toast?.(t("mobile.detail.packUpdateFailed", { error: err.message || err }), true);
      }
    },
  },
    el("span", { class: "material-symbols-outlined",
      text: p.packed ? "check_box" : "check_box_outline_blank" }),
    el("span", { text: p.title }),
  );
  return pill;
}

// ─── Action row ───────────────────────────────────────────────────

function renderActionRow(ctx, item) {
  const showDefer = !item.is_fixed;
  const row = el("section", { class: "vy-mobile-action-row vy-mobile-detail-actions" });

  row.appendChild(actionBtn("check", t("mobile.detail.action.done"), async () => {
    await safeUpdate(ctx, item, { status: "done" }, t("mobile.detail.action.markedDone"));
  }));
  row.appendChild(actionBtn("close", t("mobile.detail.action.cancelled"), async () => {
    await safeUpdate(ctx, item, { status: "cancelled" }, t("mobile.detail.action.markedCancelled"));
  }));
  if (showDefer) row.appendChild(deferBtn(ctx, item));
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

function deferBtn(ctx, item) {
  const wrap = el("div", { class: "vy-mobile-defer-wrap" });
  const btn = el("button", {
    class: "vy-mobile-action-btn vy-mobile-defer-btn",
    onClick: (e) => {
      e.stopPropagation();
      wrap.classList.toggle("is-open");
    },
  },
    el("span", { class: "material-symbols-outlined", text: "schedule" }),
    el("span", { text: t("mobile.detail.action.defer") }),
  );
  const picker = el("div", { class: "vy-mobile-defer-picker" });
  for (const mins of [30, 60]) {
    picker.appendChild(el("button", {
      class: "vy-mobile-defer-pick",
      onClick: (e) => {
        e.stopPropagation();
        wrap.classList.remove("is-open");
        runDefer(ctx, item, mins);
      },
    }, mins === 60 ? t("mobile.detail.defer60") : t("mobile.detail.defer30")));
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
      ? t("mobile.detail.deferOneHour")
      : t("mobile.detail.deferMin", { n: mins });
    const base = t("mobile.detail.deferred", { amount });
    ctx.toast?.(collisions > 0
      ? t("mobile.detail.deferredCollisions", { base, n: collisions })
      : base);
    await ctx.refresh?.();
  } catch (e) {
    ctx.toast?.(e.message || String(e), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

// ─── Status + highlight bar ───────────────────────────────────────

function renderStatusBar(ctx, item) {
  const bar = el("section", { class: "vy-mobile-detail-statusbar" });
  bar.appendChild(renderStatusChip(ctx, item));
  bar.appendChild(renderHighlightToggle(ctx, item));
  return bar;
}

function renderStatusChip(ctx, item) {
  const current = STATUS_OPTIONS.find((s) => s.value === item.status)
              || STATUS_OPTIONS.find((s) => s.value === "planned");
  const chip = el("button", {
    class: `vy-mobile-detail-status-chip is-${current.value}`,
    onClick: (e) => {
      e.stopPropagation();
      openStatusPicker(ctx, item, chip);
    },
  },
    el("span", { class: "vy-mobile-detail-status-label", text: t("mobile.detail.statusLabel") }),
    el("span", { class: "vy-mobile-detail-status-value", text: t(current.labelKey) }),
    el("span", { class: "material-symbols-outlined", text: "expand_more" }),
  );
  return chip;
}

function openStatusPicker(ctx, item, anchor) {
  // Close any existing picker first.
  const existing = document.getElementById("vy-mobile-status-picker");
  if (existing) existing.remove();

  const picker = el("div", { id: "vy-mobile-status-picker",
    class: "vy-mobile-detail-status-picker" });
  for (const opt of STATUS_OPTIONS) {
    const isCurrent = opt.value === item.status;
    const row = el("button", {
      class: `vy-mobile-detail-status-pick ${isCurrent ? "is-current" : ""}`.trim(),
      onClick: async (e) => {
        e.stopPropagation();
        picker.remove();
        if (opt.value === item.status) return;
        await safeUpdate(ctx, item, { status: opt.value },
          t("mobile.detail.statusMarked", { label: t(opt.labelKey) }));
      },
    },
      el("span", { class: "material-symbols-outlined",
        text: isCurrent ? "check" : "circle" }),
      el("span", { text: t(opt.labelKey) }),
    );
    picker.appendChild(row);
  }

  document.body.appendChild(picker);
  const r = anchor.getBoundingClientRect();
  picker.style.left = `${Math.max(8, r.left)}px`;
  picker.style.top = `${r.bottom + 6}px`;

  const off = (e) => {
    if (!picker.contains(e.target) && e.target !== anchor) {
      picker.remove();
      document.removeEventListener("pointerdown", off, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", off, true), 0);
}

function renderHighlightToggle(ctx, item) {
  const btn = el("button", {
    class: `vy-mobile-detail-star ${item.is_highlight ? "is-on" : ""}`.trim(),
    title: item.is_highlight ? t("mobile.detail.unhighlight") : t("mobile.detail.highlight"),
    onClick: async (e) => {
      e.stopPropagation();
      await safeUpdate(ctx, item,
        { is_highlight: !item.is_highlight },
        item.is_highlight ? t("mobile.detail.highlightOff") : t("mobile.detail.highlightOn"));
    },
  },
    el("span", { class: "material-symbols-outlined", text: "star" }),
  );
  return btn;
}

// ─── Helpers ──────────────────────────────────────────────────────

function findItem(trip, id) {
  for (let di = 0; di < (trip?.days || []).length; di++) {
    const day = trip.days[di];
    for (const it of (day.items || [])) {
      if (it.id === id) return { item: it, day, dayIdx: di };
    }
  }
  return { item: null, day: null, dayIdx: -1 };
}

function emptyCard(title, body) {
  return el("section", { class: "vy-mobile-edge card" },
    el("span", { class: "material-symbols-outlined", text: "info" }),
    el("h2", { text: title }),
    el("p", { class: "muted", text: body }),
  );
}
