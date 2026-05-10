// Today page (Travel mode). Mobile-first read-mostly view of today's
// schedule + todos, plus important notes.

import { checklist } from "../supabase.js";
import {
  el, formatDate, formatTime, formatTimeRange, todayIso,
} from "./_utils.js";

export function renderToday(host, ctx) {
  const t = ctx.trip;
  const today = todayIso();

  // Pick today's day. If no exact match, find the closest upcoming day.
  let day = (t.days || []).find((d) => d.date === today);
  let isToday = !!day;
  if (!day) {
    const upcoming = (t.days || []).filter((d) => d.date && d.date > today);
    upcoming.sort((a, b) => a.date.localeCompare(b.date));
    day = upcoming[0];
  }

  if (!day) {
    host.appendChild(noTrips());
    return;
  }

  const dayIdx = (t.days || []).indexOf(day) + 1;
  const items = (day.items || []).slice().sort((a, b) => {
    const at = a.start_time || "99:99";
    const bt = b.start_time || "99:99";
    if (at !== bt) return at.localeCompare(bt);
    return a.sort_order - b.sort_order;
  });

  // "Next" = first item with start_time >= now (only when isToday)
  let next = null;
  let upcoming = items;
  if (isToday) {
    const now = currentTime();
    const idx = items.findIndex((it) => (it.start_time || "00:00") >= now && it.status !== "done" && it.status !== "cancelled");
    if (idx >= 0) {
      next = items[idx];
      upcoming = items.slice(idx + 1);
    } else {
      upcoming = items;
    }
  }

  const todos = (t.checklist_items || []).filter((c) => c.day_id === day.id)
    .slice().sort((a, b) => a.sort_order - b.sort_order);

  const tripNotes = (t.notes || []).slice().sort((a, b) => a.sort_order - b.sort_order);

  // Heading
  host.appendChild(
    el("section", { class: "today-head" },
      el("div", { class: "today-eyebrow", text: isToday ? "Today" : "Upcoming" }),
      el("h2", { class: "today-title",
        text: `Day ${dayIdx}${day.title ? " · " + day.title : ""}` }),
      el("div", { class: "today-meta muted",
        text: [day.date ? formatDate(day.date) : "", day.city].filter(Boolean).join(" · ") }),
      day.notes ? el("p", { class: "today-day-notes", text: day.notes }) : null,
    )
  );

  // Next item card
  if (next) {
    host.appendChild(
      el("section", { class: "card today-next" },
        el("div", { class: "muted small", text: "Next" }),
        el("div", { class: "today-next-row" },
          next.start_time
            ? el("span", { class: "next-time", text: formatTime(next.start_time) })
            : null,
          el("strong", { class: "next-title", text: next.title || "(untitled)" }),
        ),
        next.location_name
          ? el("div", { class: "muted", text: "📍 " + next.location_name })
          : null,
        next.map_url
          ? el("a", { class: "btn primary today-map-btn", href: next.map_url, target: "_blank", rel: "noopener" }, "Open in Maps")
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
        el("h3", { text: isToday && next ? "Later today" : "Schedule" }),
        list,
      )
    );
  }

  // Todos
  if (todos.length > 0 || ctx.role !== "viewer") {
    host.appendChild(todosSection(t, day, todos, ctx));
  }

  // Important notes
  if (tripNotes.length > 0) {
    host.appendChild(
      el("section", { class: "card" },
        el("h3", { text: "Important notes" }),
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
      el("strong", { text: it.title || "(untitled)" }),
      it.location_name ? el("span", { class: "muted", text: " · 📍 " + it.location_name }) : null,
    ),
  );
  if (it.is_fixed) li.appendChild(el("span", { class: "badge fixed-badge", text: "🔒" }));
  if (it.is_highlight) li.appendChild(el("span", { class: "badge highlight-badge", text: "⭐" }));
  if (it.map_url) {
    li.appendChild(
      el("a", { class: "schedule-map-link", href: it.map_url, target: "_blank", rel: "noopener", text: "map" })
    );
  }
  return li;
}

function todosSection(t, day, todos, ctx) {
  const readOnly = ctx.role === "viewer";
  const wrap = el("section", { class: "card" }, el("h3", { text: "Today's todo" }));
  const list = el("ul", { class: "plain-list todo-list" });
  todos.forEach((c) => list.appendChild(todoRow(c, ctx, readOnly)));
  wrap.appendChild(list);

  if (!readOnly) {
    const input = el("input", {
      type: "text", placeholder: "+ Add a todo for today",
      class: "todo-add-input",
    });
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      ctx.onSaveStart?.();
      try {
        await checklist.add(t.id, {
          day_id: day.id,
          text: input.value.trim(),
          category: "other",
          sort_order: todos.length,
        });
        input.value = "";
        await ctx.refresh();
      } catch (err) {
        alert("Could not add: " + err.message);
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
      .catch((e) => alert("Save failed: " + e.message))
      .finally(() => ctx.onSaveDone?.());
  });

  const txt = el("span", { class: "todo-text", text: c.text });

  li.append(cb, txt);
  return li;
}

function noTrips() {
  return el("div", { class: "empty-state" },
    el("h3", { text: "Nothing scheduled" }),
    el("p", { text: "Add days on the Itinerary page to see them here when their date arrives." }),
  );
}

function currentTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
