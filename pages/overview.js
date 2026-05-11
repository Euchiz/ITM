// Trip overview page. Editable metadata + summary stats + next-up card.

import { trips } from "../supabase.js";
import {
  el, fmtDateRange, formatDate, formatTimeRange, todayIso,
  debouncedSave, autosize, withSaveIndicator,
} from "./_utils.js";

export function renderOverview(host, ctx) {
  const t = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const save = debouncedSave(withSaveIndicator(ctx, async (patch) => {
    await trips.updateMeta(t.id, patch);
    if ("title" in patch) ctx.onTitleChange?.(patch.title);
  }), 700);

  // Compute derived stats
  const allItems = (t.days || []).flatMap((d) => d.items || []);
  const allChecks = t.checklist_items || [];
  const prep = allChecks.filter((c) => !c.day_id);
  const prepDone = prep.filter((c) => c.is_done).length;
  const dailyTodos = allChecks.filter((c) => c.day_id);
  const todayDay = (t.days || []).find((d) => d.date === todayIso());
  const upcoming = nextUpcoming(t);
  const highlights = allItems.filter((it) => it.is_highlight);

  host.appendChild(
    el("div", { class: "overview" },
      // Editable metadata block
      el("section", { class: "card overview-meta" },
        labeled("Trip title",
          input("text", t.title, "Untitled trip", readOnly, (v) => save({ title: v }))
        ),
        el("div", { class: "field-row" },
          labeled("Destination",
            input("text", t.destination, "Tokyo → Kyoto → Osaka", readOnly, (v) => save({ destination: v }))
          ),
        ),
        el("div", { class: "field-row two" },
          labeled("Start date",
            input("date", t.start_date, "", readOnly, (v) => save({ start_date: v || null }))
          ),
          labeled("End date",
            input("date", t.end_date, "", readOnly, (v) => save({ end_date: v || null }))
          ),
        ),
        labeled("Travelers",
          input("text",
            (t.travelers || []).join(", "),
            "Comma-separated names",
            readOnly,
            (v) => save({ travelers: v.split(",").map((s) => s.trim()).filter(Boolean) }),
          )
        ),
        labeled("Summary",
          textarea(t.summary, "A short description of the trip…", readOnly, (v) => save({ summary: v }))
        ),
        labeled("General notes",
          textarea(t.general_notes, "Pace, dietary needs, things everyone should know…", readOnly, (v) => save({ general_notes: v }))
        ),
      ),

      // Stat cards
      el("section", { class: "card overview-stats" },
        el("h3", { text: "Progress" }),
        el("div", { class: "stat-grid" },
          stat("Preparation", `${prepDone} / ${prep.length} done`),
          stat("Itinerary", `${(t.days || []).length} days planned`),
          stat("Items", `${allItems.length} planned`),
          stat("Today", todayDay ? (todayDay.title || todayDay.city || formatDate(todayDay.date)) : "—"),
        ),
      ),

      // Next-up card (guideline §20.1)
      upcoming
        ? el("section", { class: "card next-up" },
            el("h3", { text: "Next up" }),
            el("div", { class: "next-up-row" },
              upcoming.item.start_time
                ? el("span", { class: "next-time", text: upcoming.item.start_time.slice(0, 5) })
                : null,
              el("strong", { class: "next-title", text: upcoming.item.title || "(untitled)" }),
            ),
            el("div", { class: "muted", text: dayLabel(upcoming.day) }),
            upcoming.item.location_name
              ? el("div", { class: "muted", text: "📍 " + upcoming.item.location_name })
              : null,
            upcoming.item.notes
              ? el("p", { class: "small", text: upcoming.item.notes })
              : null,
          )
        : null,

      // Highlights — derived automatically from itinerary items flagged
      // as highlights. Not directly editable here; toggle the star on
      // an event in the itinerary page to add/remove from this list.
      highlights.length > 0
        ? el("section", { class: "card" },
            el("h3", { text: "Highlights" }),
            el("p", { class: "muted small",
              text: "Auto-collected from items you’ve starred in the itinerary." }),
            el("ul", { class: "plain-list" },
              ...highlights.slice(0, 8).map((h) => el("li", { text: "⭐ " + (h.title || "(untitled)") }))
            ),
          )
        : null,
    )
  );
}

function labeled(label, child) {
  return el("label", { class: "field" },
    el("span", { class: "field-label", text: label }),
    child,
  );
}

function input(type, value, placeholder, disabled, onInput) {
  const i = el("input", {
    type, value: value ?? "", placeholder: placeholder || "",
    disabled,
  });
  i.addEventListener("input", () => onInput(i.value));
  return i;
}

function textarea(value, placeholder, disabled, onInput) {
  const ta = el("textarea", {
    class: "block-edit-input", placeholder: placeholder || "",
    disabled, rows: 2,
  });
  ta.value = value || "";
  setTimeout(() => autosize(ta), 0);
  ta.addEventListener("input", () => { autosize(ta); onInput(ta.value); });
  return ta;
}

function stat(label, value) {
  return el("div", { class: "stat" },
    el("div", { class: "stat-label", text: label }),
    el("div", { class: "stat-value", text: value }),
  );
}

function dayLabel(day) {
  const date = day.date ? formatDate(day.date) : "";
  const name = day.title || day.city || "";
  return [date, name].filter(Boolean).join(" · ");
}

function nextUpcoming(t) {
  const today = todayIso();
  const candidates = [];
  for (const d of t.days || []) {
    if (!d.date || d.date < today) continue;
    for (const it of d.items || []) {
      candidates.push({ day: d, item: it });
    }
  }
  candidates.sort((a, b) => {
    if (a.day.date !== b.day.date) return a.day.date.localeCompare(b.day.date);
    const at = a.item.start_time || "99:99";
    const bt = b.item.start_time || "99:99";
    if (at !== bt) return at.localeCompare(bt);
    return a.item.sort_order - b.item.sort_order;
  });
  return candidates[0] || null;
}
