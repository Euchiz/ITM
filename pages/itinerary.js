// Plan-mode page · Voyage-style timeline editor.
//
// Layout adopted from the Claude Design handoff (desktop.jsx):
//   - page head with title + tool buttons (Import/Export, Print)
//   - global view toggle (Timeline / List / Cards) — Timeline default
//   - per-day card: DayHeader + Timeline of items, each with a type chip,
//     time column, pip and event card
//   - stale Route Preview block at the very bottom
//
// Editing model — click any item card to expand the inline editor (the
// same form of fields the prior version used). Click ✕ on the editor
// (or click another card) to collapse back to the read-only card view.
// All field changes save inline through the existing debounced save.

import { days, items } from "../supabase.js";
import { ITEM_TYPES, ITEM_STATUSES } from "../io/schema.js";
import {
  el, debouncedSave, autosize, withSaveIndicator, formatTime, formatTimeRange,
} from "./_utils.js";
import { openPrintView } from "./print-view.js";

// Visual mapping for item types. The chip's CSS class matches the
// Voyage palette (transit/blue, stay/viridian, meal/amber, thing/viridian,
// note/muted). Glyphs are Material Symbols Outlined names.
const TYPE_VISUALS = {
  activity:  { glyph: "explore",            label: "ACTIVITY", chipClass: "thing"   },
  food:      { glyph: "restaurant",         label: "DINING",   chipClass: "meal"    },
  transport: { glyph: "directions_railway", label: "TRANSIT",  chipClass: "transit" },
  lodging:   { glyph: "bed",                label: "STAY",     chipClass: "stay"    },
  shopping:  { glyph: "shopping_bag",       label: "SHOPPING", chipClass: "thing"   },
  rest:      { glyph: "spa",                label: "REST",     chipClass: "note"    },
  note:      { glyph: "edit_note",          label: "NOTE",     chipClass: "note"    },
};

const VIEW_STORAGE_KEY = "voyage:itinerary-view";
const VIEW_OPTIONS = ["timeline", "list", "cards"];

export function renderItinerary(host, ctx) {
  const t = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const view = readView();
  let expandedItemId = null;
  let dayList = null;

  // ── Page head — title, summary, tool buttons ───────────────────────
  host.appendChild(
    el("section", { class: "page-head vy-itin-head" },
      el("div", { class: "vy-itin-head-l" },
        el("h2", { text: "Itinerary" }),
        el("p", { class: "muted",
          text: "Plan day by day. Click a card to edit. Mark items as fixed (locked) or flexible, " +
                "star highlights. Use the view toggle to switch between Timeline, List and Cards." }),
      ),
      el("div", { class: "vy-itin-head-r" },
        viewToggle(),
        !readOnly ? el("button", { class: "btn primary", onClick: () => addNewDay() }, "+ Add day") : null,
        toolMenu(),
      ),
    )
  );

  if (!t.days || t.days.length === 0) {
    host.appendChild(el("div", { class: "empty-state" },
      el("h3", { text: "No days yet" }),
      el("p", { text: "Add your first day to start planning." }),
    ));
    appendRouteStale();
    return;
  }

  dayList = el("div", { class: "day-list", "data-view": view });
  t.days.forEach((day, idx) => dayList.appendChild(dayCard(day, idx)));
  host.appendChild(dayList);

  appendRouteStale();

  // ────────────────────────────────────────────────────────────────────
  // Builders
  // ────────────────────────────────────────────────────────────────────

  function viewToggle() {
    const wrap = el("div", { class: "vy-view-toggle", role: "tablist" });
    VIEW_OPTIONS.forEach((v) => {
      const btn = el("button", {
        class: v === view ? "is-active" : "",
        role: "tab",
        onClick: () => {
          writeView(v);
          if (dayList) dayList.dataset.view = v;
          wrap.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b.dataset.v === v));
        },
      }, v[0].toUpperCase() + v.slice(1));
      btn.dataset.v = v;
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function toolMenu() {
    return el("div", { class: "vy-itin-tools" },
      el("button", { class: "icon-btn", title: "Import / Export",
        onClick: () => ctx.navigate({ page: "io" }) },
        el("span", { class: "material-symbols-outlined", text: "swap_vert" }),
      ),
      el("button", { class: "icon-btn", title: "Print preview",
        onClick: () => openPrintView(t) },
        el("span", { class: "material-symbols-outlined", text: "print" }),
      ),
    );
  }

  function appendRouteStale() {
    host.appendChild(
      el("section", { class: "card vy-stale-card vy-route-stale" },
        el("div", { class: "vy-stale-mark" },
          el("span", { class: "material-symbols-outlined", text: "route" }),
        ),
        el("div", { class: "vy-stale-body" },
          el("strong", { class: "vy-stale-title", text: "Route preview" }),
          el("span", { class: "vy-meta", text: "PROPOSED · STAYS EMPTY FOR THIS VERSION" }),
          el("p", { class: "small",
            text: "Future: visualised route across cities, drag-to-add stops, swap transit segments." }),
        ),
      )
    );
  }

  function dayCard(day, idx) {
    const card = el("section", { class: "card day-card vy-day-card", "data-id": day.id });

    const saveDay = debouncedSave(withSaveIndicator(ctx, async (patch) => {
      await days.update(day.id, patch);
      Object.assign(day, patch);
    }), 700);

    // ── Day header ────────────────────────────────────────────────
    const dateLabel = day.date
      ? new Date(day.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : "Set date…";
    const dayNum = String(idx + 1).padStart(2, "0");

    const header = el("div", { class: "vy-day-header" });
    const headerL = el("div", { class: "vy-day-header-l" },
      el("div", { class: "vy-day-num", text: dayNum }, el("small", { text: ` / ${String(t.days.length).padStart(2, "0")}` })),
      el("div", { class: "vy-day-name" },
        el("b", { text: `${dateLabel}${day.city ? " · " + day.city : ""}` }),
        el("span", { text: (day.title || day.notes || "DAY").toUpperCase().slice(0, 60) }),
      ),
    );
    const headerR = el("div", { class: "vy-day-header-r" },
      el("span", { class: "vy-meta",
        text: `${(day.items || []).length} ITEMS · DAY ${idx + 1} OF ${t.days.length}` }),
      !readOnly
        ? el("div", { class: "day-controls" },
            el("button", { class: "icon-btn", title: "Edit day info",
              onClick: () => toggleDayEditor() }, "✎"),
            el("button", { class: "icon-btn", title: "Move up", onClick: () => moveDay(idx, -1) }, "↑"),
            el("button", { class: "icon-btn", title: "Move down", onClick: () => moveDay(idx, +1) }, "↓"),
            el("button", { class: "icon-btn danger", title: "Delete day", onClick: () => deleteDay(day) }, "✕"),
          )
        : null,
    );
    header.append(headerL, headerR);
    card.appendChild(header);

    // ── Day editor (collapsed by default; toggled by ✎) ────────────
    const dayEditor = el("div", { class: "vy-day-editor", hidden: true });
    const dateInput = el("input", { type: "date", value: day.date || "", disabled: readOnly });
    const titleInput = el("input", { type: "text", value: day.title || "",
      placeholder: "Day title (e.g. Arrival)", disabled: readOnly });
    const cityInput  = el("input", { type: "text", value: day.city || "",
      placeholder: "City", disabled: readOnly });
    dateInput.addEventListener("input", () => saveDay({ date: dateInput.value || null }));
    titleInput.addEventListener("input", () => saveDay({ title: titleInput.value }));
    cityInput.addEventListener("input", () => saveDay({ city: cityInput.value }));
    dayEditor.append(
      labeledField("Date", dateInput),
      labeledField("Title", titleInput),
      labeledField("City", cityInput),
    );

    // Day notes (textarea) — always visible when has content, else under the editor
    const notesTa = el("textarea", { class: "block-edit-input vy-day-notes",
      placeholder: "Notes for this day (jet lag, weather, plans for the group…)",
      disabled: readOnly, rows: 1 });
    notesTa.value = day.notes || "";
    setTimeout(() => autosize(notesTa), 0);
    notesTa.addEventListener("input", () => { autosize(notesTa); saveDay({ notes: notesTa.value }); });
    dayEditor.append(labeledField("Notes", notesTa));
    card.appendChild(dayEditor);

    function toggleDayEditor() {
      dayEditor.hidden = !dayEditor.hidden;
    }

    // If the day has notes, expose them outside the editor so they're
    // always glanceable (matches the design's day-notes-strip).
    if (day.notes) {
      card.appendChild(el("div", { class: "vy-day-notes-strip", text: day.notes }));
    }

    // ── Timeline ──────────────────────────────────────────────────
    const tl = el("div", { class: "vy-tl" });
    tl.appendChild(el("div", { class: "vy-tl-line", "aria-hidden": "true" }));
    (day.items || []).forEach((it, ii) => tl.appendChild(timelineItem(day, it, ii)));
    if (!readOnly) {
      tl.appendChild(el("div", { class: "vy-tl-add-row" },
        el("button", { class: "btn ghost inline-add",
          onClick: () => addNewItem(day) }, "+ Add event"),
      ));
    }
    card.appendChild(tl);

    return card;
  }

  function timelineItem(day, it, idx) {
    const wrap = el("div", { class: "vy-tl-item", "data-status": it.status, "data-id": it.id });
    wrap.classList.toggle("is-fixed", !!it.is_fixed);
    wrap.classList.toggle("is-highlight", !!it.is_highlight);

    function renderCardView() {
      wrap.innerHTML = "";
      wrap.appendChild(timeCell(it));
      wrap.appendChild(pipCell(it));
      wrap.appendChild(cardCell(it));
    }

    function renderEditorView() {
      wrap.innerHTML = "";
      wrap.appendChild(timeCell(it));
      wrap.appendChild(pipCell(it));
      wrap.appendChild(editorCell(day, it, idx));
    }

    function timeCell(it) {
      const t = formatTimeRange(it.start_time, it.end_time) || formatTime(it.start_time) || "—";
      return el("div", { class: "vy-tl-time", text: t });
    }

    function pipCell(it) {
      const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
      const on = !!it.is_fixed || it.type === "lodging" || it.type === "transport";
      return el("div", { class: "vy-tl-pip-col" },
        el("span", { class: `vy-pip vy-pip--${pipColor(v.chipClass)} ${on ? "is-on" : ""}` }),
      );
    }

    function cardCell(it) {
      const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
      const card = el("div", { class: "vy-tl-card",
        onClick: (e) => {
          // Don't trigger from inner buttons / inputs
          if (e.target.closest("button, input, select, textarea, a")) return;
          if (!readOnly) {
            expandedItemId = it.id;
            renderEditorView();
          }
        },
      });
      const lhs = el("div", { class: "vy-tl-card-l" });
      lhs.append(
        el("div", { class: "vy-tl-card-head" },
          el("span", { class: `vy-chip vy-chip--${v.chipClass}` },
            el("span", { class: "material-symbols-outlined", text: v.glyph }),
            el("span", { text: v.label }),
          ),
          el("span", { class: "vy-tl-card-title", text: it.title || "(untitled)" }),
        ),
        it.location_name
          ? el("div", { class: "vy-tl-card-sub", text: "📍 " + it.location_name })
          : (it.notes ? el("div", { class: "vy-tl-card-sub", text: it.notes }) : null),
      );
      const flagRow = el("div", { class: "vy-tl-card-meta" });
      if (it.is_fixed) flagRow.appendChild(el("span", { class: "vy-conf", text: "🔒 FIXED" }));
      if (it.is_highlight) flagRow.appendChild(el("span", { class: "vy-conf", text: "★ HIGHLIGHT" }));
      if (it.status && it.status !== "planned") flagRow.appendChild(el("span", { class: "vy-conf", text: it.status.toUpperCase() }));
      if (flagRow.children.length) lhs.appendChild(flagRow);
      card.appendChild(lhs);

      const rhs = el("div", { class: "vy-tl-card-r" });
      const dur = computeDuration(it.start_time, it.end_time);
      if (dur) rhs.appendChild(el("span", { class: "vy-tl-card-dur", text: dur }));
      if (!readOnly) rhs.appendChild(
        el("span", { class: "material-symbols-outlined vy-tl-drag", text: "drag_indicator", title: "Drag (use arrows in edit mode)" })
      );
      card.appendChild(rhs);
      return card;
    }

    function editorCell(day, it, idx) {
      const cell = el("div", { class: "vy-tl-card is-editing" });

      const saveItem = debouncedSave(withSaveIndicator(ctx, async (patch) => {
        await items.update(it.id, patch);
        Object.assign(it, patch);
      }), 600);

      async function saveItemNow(patch) {
        ctx.onSaveStart?.();
        try {
          await items.update(it.id, patch);
          Object.assign(it, patch);
          wrap.classList.toggle("is-fixed", !!it.is_fixed);
          wrap.classList.toggle("is-highlight", !!it.is_highlight);
          wrap.dataset.status = it.status;
          renderEditorView();
        } catch (e) {
          alert("Save failed: " + e.message);
        } finally {
          ctx.onSaveDone?.();
        }
      }

      const startInput = el("input", { type: "time", class: "time-input",
        value: (it.start_time || "").slice(0, 5), disabled: readOnly, title: "Start time" });
      const endInput   = el("input", { type: "time", class: "time-input",
        value: (it.end_time   || "").slice(0, 5), disabled: readOnly, title: "End time" });
      startInput.addEventListener("input", () => saveItem({ start_time: startInput.value || null }));
      endInput.addEventListener("input", () => saveItem({ end_time: endInput.value || null }));

      const titleInput = el("input", { type: "text", class: "item-title-input",
        value: it.title || "", placeholder: "Item title", disabled: readOnly });
      titleInput.addEventListener("input", () => saveItem({ title: titleInput.value }));

      const typeSelect = select(it.type, ITEM_TYPES, readOnly, (v) => saveItemNow({ type: v }));
      const statSelect = select(it.status, ITEM_STATUSES, readOnly, (v) => saveItem({ status: v }));

      const locInput = el("input", { type: "text", value: it.location_name || "",
        placeholder: "📍 Location", disabled: readOnly });
      locInput.addEventListener("input", () => saveItem({ location_name: locInput.value }));

      const mapInput = el("input", { type: "url", value: it.map_url || "",
        placeholder: "Map URL (optional)", disabled: readOnly });
      mapInput.addEventListener("input", () => saveItem({ map_url: mapInput.value }));

      const notesTa = el("textarea", { class: "block-edit-input",
        placeholder: "Notes…", disabled: readOnly, rows: 1 });
      notesTa.value = it.notes || "";
      setTimeout(() => autosize(notesTa), 0);
      notesTa.addEventListener("input", () => { autosize(notesTa); saveItem({ notes: notesTa.value }); });

      const row1 = el("div", { class: "vy-edit-row" },
        labeledInline("Start", startInput),
        labeledInline("End",   endInput),
        titleInput,
      );

      const row2 = el("div", { class: "vy-edit-row" },
        labeledInline("Type",   typeSelect),
        labeledInline("Status", statSelect),
        !readOnly && el("button", {
          class: "icon-btn", title: it.is_fixed ? "Locked schedule" : "Mark as fixed",
          onClick: () => saveItemNow({ is_fixed: !it.is_fixed }),
        }, it.is_fixed ? "🔒" : "🔓"),
        !readOnly && el("button", {
          class: "icon-btn", title: it.is_highlight ? "Unhighlight" : "Mark highlight",
          onClick: () => saveItemNow({ is_highlight: !it.is_highlight }),
        }, it.is_highlight ? "⭐" : "☆"),
        !readOnly && el("button", { class: "icon-btn", title: "Move up",
          onClick: () => moveItem(day, idx, -1) }, "↑"),
        !readOnly && el("button", { class: "icon-btn", title: "Move down",
          onClick: () => moveItem(day, idx, +1) }, "↓"),
        !readOnly && el("button", { class: "icon-btn danger", title: "Delete",
          onClick: () => deleteItem(it) }, "✕"),
      );

      const row3 = el("div", { class: "vy-edit-row" }, locInput, mapInput);
      const row4 = el("div", { class: "vy-edit-row" }, notesTa);

      cell.append(
        el("div", { class: "vy-edit-head" },
          el("span", { class: "vy-meta", text: "EDITING · CLICK ✕ OR ANY OTHER CARD TO CLOSE" }),
          el("button", { class: "icon-btn", title: "Close editor",
            onClick: () => {
              expandedItemId = null;
              renderCardView();
            } }, "✕"),
        ),
        row1, row2, row3, row4,
        !readOnly
          ? el("button", { class: "btn ghost inline-add",
              onClick: () => addNewItem(day, idx + 1) }, "+ Add event below this one")
          : null,
      );
      return cell;
    }

    // Initial render mode: card unless this item is the currently-expanded one.
    if (expandedItemId === it.id) renderEditorView();
    else renderCardView();
    return wrap;
  }

  // ────────────────────────────────────────────────────────────────────
  // Mutations
  // ────────────────────────────────────────────────────────────────────

  async function addNewDay() {
    ctx.onSaveStart?.();
    try {
      const lastDate = (t.days || []).slice(-1)[0]?.date || null;
      const newDate = lastDate ? addDays(lastDate, 1) : null;
      await days.add(t.id, { date: newDate, sort_order: (t.days || []).length });
      await ctx.refresh();
    } catch (e) {
      alert("Could not add day: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
  }

  async function deleteDay(day) {
    if (!confirm("Delete this day and everything in it?")) return;
    ctx.onSaveStart?.();
    try {
      await days.remove(day.id);
      await ctx.refresh();
    } catch (e) { alert("Delete failed: " + e.message); }
    finally { ctx.onSaveDone?.(); }
  }

  async function moveDay(idx, dir) {
    const arr = t.days.slice();
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    const [d] = arr.splice(idx, 1);
    arr.splice(j, 0, d);
    ctx.onSaveStart?.();
    try {
      await days.reorder(arr.map((x) => x.id));
      await ctx.refresh();
    } catch (e) { alert("Reorder failed: " + e.message); }
    finally { ctx.onSaveDone?.(); }
  }

  async function addNewItem(day, insertAt) {
    ctx.onSaveStart?.();
    try {
      // Add at end; if insertAt is provided we'll reorder afterwards.
      const newItem = await items.add(t.id, day.id, {
        title: "", type: "activity", status: "planned",
        sort_order: (day.items || []).length,
      });
      if (insertAt != null && newItem && newItem.id) {
        const ids = [...(day.items || []).map((x) => x.id)];
        ids.splice(insertAt, 0, newItem.id);
        await items.reorder(ids);
      }
      await ctx.refresh();
    } catch (e) {
      alert("Could not add item: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
  }

  async function deleteItem(it) {
    if (!confirm("Delete this item?")) return;
    ctx.onSaveStart?.();
    try {
      await items.remove(it.id);
      await ctx.refresh();
    } catch (e) { alert("Delete failed: " + e.message); }
    finally { ctx.onSaveDone?.(); }
  }

  async function moveItem(day, idx, dir) {
    const arr = day.items.slice();
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    const [it] = arr.splice(idx, 1);
    arr.splice(j, 0, it);
    ctx.onSaveStart?.();
    try {
      await items.reorder(arr.map((x) => x.id));
      await ctx.refresh();
    } catch (e) { alert("Reorder failed: " + e.message); }
    finally { ctx.onSaveDone?.(); }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function labeledField(label, control) {
  return el("label", { class: "field" },
    el("span", { class: "field-label", text: label }),
    control,
  );
}

function labeledInline(label, child) {
  return el("label", { class: "field-inline" },
    el("span", { class: "field-label-inline", text: label }),
    child,
  );
}

function select(value, options, disabled, onChange) {
  const sel = el("select", { disabled });
  options.forEach((opt) => {
    const o = el("option", { value: opt, text: opt });
    if (opt === value) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function pipColor(chipClass) {
  if (chipClass === "transit" || chipClass === "flight") return "blue";
  if (chipClass === "meal") return "amber";
  if (chipClass === "note") return "muted";
  return "viridian";
}

function computeDuration(s, e) {
  if (!s || !e) return null;
  const [sh, sm] = s.split(":").map(Number);
  const [eh, em] = e.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) return null;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function readView() {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    return VIEW_OPTIONS.includes(v) ? v : "timeline";
  } catch { return "timeline"; }
}
function writeView(v) {
  try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch {}
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
