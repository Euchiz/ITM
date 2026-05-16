// Trip overview page. Editable metadata + summary stats + next-up card.

import { trips } from "../supabase.js";
import {
  el, fmtDateRange, formatDate, formatTimeRange, todayIso,
  debouncedSave, autosize, withSaveIndicator,
} from "./_utils.js";
import { t } from "../i18n/locale.js";

export function renderOverview(host, ctx) {
  const trip = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const save = debouncedSave(withSaveIndicator(ctx, async (patch) => {
    await trips.updateMeta(trip.id, patch);
    if ("title" in patch) ctx.onTitleChange?.(patch.title);
  }), 700);

  // Compute derived stats
  const allItems = (trip.days || []).flatMap((d) => d.items || []);
  const allChecks = trip.checklist_items || [];
  const prep = allChecks.filter((c) => !c.day_id);
  const prepDone = prep.filter((c) => c.is_done).length;
  const dailyTodos = allChecks.filter((c) => c.day_id);
  const todayDay = (trip.days || []).find((d) => d.date === todayIso());
  const upcoming = nextUpcoming(trip);
  const highlights = allItems.filter((it) => it.is_highlight);

  host.appendChild(
    el("div", { class: "overview" },
      // Editable metadata block
      el("section", { class: "card overview-meta" },
        labeled(t("overview.tripTitle"),
          input("text", trip.title, t("sidebar.untitledTrip"), readOnly, (v) => save({ title: v }))
        ),
        el("div", { class: "field-row" },
          labeled(t("overview.field.destination"),
            input("text", trip.destination, t("overview.destPlaceholder"), readOnly, (v) => save({ destination: v }))
          ),
        ),
        el("div", { class: "field-row two" },
          labeled(t("overview.field.startDate"),
            input("date", trip.start_date, "", readOnly, (v) => save({ start_date: v || null }))
          ),
          labeled(t("overview.field.endDate"),
            input("date", trip.end_date, "", readOnly, (v) => save({ end_date: v || null }))
          ),
        ),
        labeled(t("overview.field.travelers"),
          input("text",
            (trip.travelers || []).join(", "),
            t("overview.travelersPlaceholder"),
            readOnly,
            (v) => save({ travelers: v.split(",").map((s) => s.trim()).filter(Boolean) }),
          )
        ),
        labeled(t("overview.field.summary"),
          textarea(trip.summary, t("overview.summaryPlaceholder"), readOnly, (v) => save({ summary: v }))
        ),
        labeled(t("overview.generalNotes"),
          textarea(trip.general_notes, t("overview.generalNotesPlaceholder"), readOnly, (v) => save({ general_notes: v }))
        ),
      ),

      // Stat cards
      el("section", { class: "card overview-stats" },
        el("h3", { text: t("overview.progress") }),
        el("div", { class: "stat-grid" },
          stat(t("overview.preparation"), t("overview.preparationCount", { done: prepDone, total: prep.length })),
          stat(t("overview.itinerarySection"), t("overview.daysPlanned", { n: (trip.days || []).length })),
          stat(t("overview.items"), t("overview.itemsPlanned", { n: allItems.length })),
          stat(t("overview.today"), todayDay ? (todayDay.title || todayDay.city || formatDate(todayDay.date)) : t("overview.dash")),
        ),
      ),

      // Next-up card (guideline §20.1)
      upcoming
        ? el("section", { class: "card next-up" },
            el("h3", { text: t("overview.nextUp") }),
            el("div", { class: "next-up-row" },
              upcoming.item.start_time
                ? el("span", { class: "next-time", text: upcoming.item.start_time.slice(0, 5) })
                : null,
              el("strong", { class: "next-title", text: upcoming.item.title || t("overview.untitled") }),
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
            el("h3", { text: t("overview.highlights") }),
            el("p", { class: "muted small", text: t("overview.highlightsHelp") }),
            el("ul", { class: "plain-list" },
              ...highlights.slice(0, 8).map((h) => el("li", { text: "⭐ " + (h.title || t("overview.untitled")) }))
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

function nextUpcoming(trip) {
  const today = todayIso();
  const candidates = [];
  for (const d of trip.days || []) {
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
