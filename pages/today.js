// Today page (Travel mode). Mobile-first read-mostly view of today's
// schedule + todos, plus important notes.

import { checklist } from "../supabase.js";
import {
  el, formatDate, formatTime, formatTimeRange, todayIso,
} from "./_utils.js";
import { t } from "../i18n/locale.js";

export function renderToday(host, ctx) {
  const trip = ctx.trip;
  const today = todayIso();

  // The day strip drives which day is shown — that lets users preview
  // any day's today-recap, not just literal today's. The default
  // selectedDayIdx is set in app.js (today's day if in range, else the
  // next upcoming one, else day 0) so first paint already lands on
  // the "right" day.
  const idx = Math.min(
    Math.max(0, ctx.selectedDayIdx || 0),
    Math.max(0, (trip.days || []).length - 1),
  );
  const day = (trip.days || [])[idx];
  const isToday = !!(day && day.date === today);

  if (!day) {
    host.appendChild(noTrips());
    return;
  }

  const dayIdx = idx + 1;
  const items = (day.items || []).slice().sort((a, b) => {
    const at = a.start_time || "99:99";
    const bt = b.start_time || "99:99";
    if (at !== bt) return at.localeCompare(bt);
    return a.sort_order - b.sort_order;
  });

  // "Next" = first item with start_time >= now (only when isToday).
  // For previewing other days, no item is "next" — all show in the list.
  let next = null;
  let upcoming = items;
  if (isToday) {
    const now = currentTime();
    const nextIdx = items.findIndex((it) => (it.start_time || "00:00") >= now && it.status !== "done" && it.status !== "cancelled");
    if (nextIdx >= 0) {
      next = items[nextIdx];
      upcoming = items.slice(nextIdx + 1);
    } else {
      upcoming = items;
    }
  }

  const todos = (trip.checklist_items || []).filter((c) => c.day_id === day.id)
    .slice().sort((a, b) => a.sort_order - b.sort_order);

  const tripNotes = (trip.notes || []).slice().sort((a, b) => a.sort_order - b.sort_order);

  // Eyebrow text: "Today" only if we're actually on today's day; "Past"
  // for previous days; "Upcoming" otherwise. Lets users browse other
  // days without misleading them about which one is live.
  let eyebrow;
  if (isToday) eyebrow = t("today.eyebrow.today");
  else if (day.date && day.date < today) eyebrow = t("today.eyebrow.past", { n: dayIdx });
  else                                   eyebrow = t("today.eyebrow.preview", { n: dayIdx });

  // Heading
  host.appendChild(
    el("section", { class: "today-head" },
      el("div", { class: "today-eyebrow", text: eyebrow }),
      el("h2", { class: "today-title",
        text: day.title
          ? t("today.dayLabelWithTitle", { n: dayIdx, title: day.title })
          : t("today.dayLabel", { n: dayIdx }) }),
      el("div", { class: "today-meta muted",
        text: [day.date ? formatDate(day.date) : "", day.city].filter(Boolean).join(" · ") }),
      day.notes ? el("p", { class: "today-day-notes", text: day.notes }) : null,
    )
  );

  // Next item card
  if (next) {
    host.appendChild(
      el("section", { class: "card today-next" },
        el("div", { class: "muted small", text: t("today.next") }),
        el("div", { class: "today-next-row" },
          next.start_time
            ? el("span", { class: "next-time", text: formatTime(next.start_time) })
            : null,
          el("strong", { class: "next-title", text: next.title || t("today.untitled") }),
        ),
        next.location_name
          ? el("div", { class: "muted", text: "📍 " + next.location_name })
          : null,
        next.map_url
          ? el("a", { class: "btn primary today-map-btn", href: next.map_url, target: "_blank", rel: "noopener" }, t("today.openInMaps"))
          : null,
        next.notes
          ? el("p", { class: "small", text: next.notes })
          : null,
      )
    );
  }

  // Schedule
  if (upcoming.length > 0) {
    const list = el("ul", { class: "schedule-list plain-list" });
    upcoming.forEach((it) => list.appendChild(scheduleRow(it)));
    host.appendChild(
      el("section", { class: "card" },
        el("h3", { text: isToday && next ? t("today.laterToday") : t("today.schedule") }),
        list,
      )
    );
  }

  // Todos
  if (todos.length > 0 || ctx.role !== "viewer") {
    host.appendChild(todosSection(trip, day, todos, ctx));
  }

  // Important notes
  if (tripNotes.length > 0) {
    host.appendChild(
      el("section", { class: "card" },
        el("h3", { text: t("today.importantNotes") }),
        ...tripNotes.map((n) =>
          el("div", { class: "note-block" },
            n.title ? el("strong", { text: n.title }) : null,
            n.body ? el("p", { class: "small", text: n.body }) : null,
          )
        ),
      )
    );
  }
}

function scheduleRow(it) {
  const time = formatTimeRange(it.start_time, it.end_time);
  const li = el("li", { class: `schedule-row status-${it.status}${it.is_fixed ? " fixed" : ""}` });
  li.append(
    el("span", { class: "schedule-time", text: time || "—" }),
    el("span", { class: "schedule-title" },
      el("strong", { text: it.title || t("today.untitled") }),
      it.location_name ? el("span", { class: "muted", text: " · 📍 " + it.location_name }) : null,
    ),
  );
  if (it.is_fixed) li.appendChild(el("span", { class: "badge fixed-badge", text: "🔒" }));
  if (it.is_highlight) li.appendChild(el("span", { class: "badge highlight-badge", text: "⭐" }));
  if (it.map_url) {
    li.appendChild(
      el("a", { class: "schedule-map-link", href: it.map_url, target: "_blank", rel: "noopener", text: t("today.mapLinkText") })
    );
  }
  return li;
}

function todosSection(trip, day, todos, ctx) {
  const readOnly = ctx.role === "viewer";
  const wrap = el("section", { class: "card" }, el("h3", { text: t("today.todosTitle") }));
  const list = el("ul", { class: "plain-list todo-list" });
  todos.forEach((c) => list.appendChild(todoRow(c, ctx, readOnly)));
  wrap.appendChild(list);

  if (!readOnly) {
    const input = el("input", {
      type: "text", placeholder: t("today.addTodoPlaceholder"),
      class: "todo-add-input",
    });
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      ctx.onSaveStart?.();
      try {
        await checklist.add(trip.id, {
          day_id: day.id,
          text: input.value.trim(),
          category: "other",
          sort_order: todos.length,
        });
        input.value = "";
        await ctx.refresh();
      } catch (err) {
        alert(t("today.addFailed", { error: err.message }));
      } finally {
        ctx.onSaveDone?.();
      }
    });
    wrap.appendChild(input);
  }

  return wrap;
}

function todoRow(c, ctx, readOnly) {
  const li = el("li", { class: "todo-row" });
  if (c.is_done) li.classList.add("done");

  const cb = el("input", {
    type: "checkbox", class: "big-check",
    checked: c.is_done, disabled: readOnly,
  });
  cb.addEventListener("change", () => {
    c.is_done = cb.checked;
    li.classList.toggle("done", cb.checked);
    ctx.onSaveStart?.();
    checklist.update(c.id, { is_done: cb.checked })
      .catch((e) => alert(t("today.saveFailed", { error: e.message })))
      .finally(() => ctx.onSaveDone?.());
  });

  const txt = el("span", { class: "todo-text", text: c.text });

  li.append(cb, txt);
  return li;
}

function noTrips() {
  return el("div", { class: "empty-state" },
    el("h3", { text: t("today.empty.title") }),
    el("p", { text: t("today.empty.body") }),
  );
}

function currentTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
