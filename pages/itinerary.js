// Plan-mode page. Day list with editable items.

import { days, items } from "../supabase.js";
import { ITEM_TYPES, ITEM_STATUSES } from "../io/schema.js";
import {
  el, formatDate, debouncedSave, autosize, withSaveIndicator,
} from "./_utils.js";

export function renderItinerary(host, ctx) {
  const t = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const head = el("section", { class: "page-head" },
    el("h2", { text: "Itinerary" }),
    el("p", { class: "muted",
      text: "Plan day by day. Mark items as fixed (locked schedule) or flexible. Star highlights." }),
    !readOnly
      ? el("button", { class: "btn primary", onClick: () => addNewDay() }, "+ Add day")
      : null,
  );
  host.appendChild(head);

  if (!t.days || t.days.length === 0) {
    host.appendChild(el("div", { class: "empty-state" },
      el("h3", { text: "No days yet" }),
      el("p", { text: "Add your first day to start planning." }),
    ));
    return;
  }

  const list = el("div", { class: "day-list" });
  t.days.forEach((day, idx) => list.appendChild(dayCard(day, idx)));
  host.appendChild(list);

  function dayCard(day, idx) {
    const card = el("section", { class: "card day-card", "data-id": day.id });

    // Day header — date + title + city + day controls
    const header = el("header", { class: "day-header" });
    const dayNum = el("span", { class: "day-num", text: `Day ${idx + 1}` });
    const dateInput = el("input", {
      type: "date", value: day.date || "", disabled: readOnly,
    });
    const titleInput = el("input", {
      type: "text", value: day.title || "", placeholder: "Day title (e.g. Arrival)",
      disabled: readOnly,
    });
    const cityInput = el("input", {
      type: "text", value: day.city || "", placeholder: "City",
      disabled: readOnly,
    });

    const saveDay = debouncedSave(withSaveIndicator(ctx, async (patch) => {
      await days.update(day.id, patch);
      Object.assign(day, patch);
    }), 700);

    dateInput.addEventListener("input", () => saveDay({ date: dateInput.value || null }));
    titleInput.addEventListener("input", () => saveDay({ title: titleInput.value }));
    cityInput.addEventListener("input", () => saveDay({ city: cityInput.value }));

    header.append(dayNum, dateInput, titleInput, cityInput);
    if (!readOnly) {
      header.append(
        el("div", { class: "spacer" }),
        el("div", { class: "day-controls" },
          el("button", { class: "icon-btn", title: "Move up", onClick: () => moveDay(idx, -1) }, "↑"),
          el("button", { class: "icon-btn", title: "Move down", onClick: () => moveDay(idx, +1) }, "↓"),
          el("button", { class: "icon-btn danger", title: "Delete day", onClick: () => deleteDay(day) }, "✕"),
        ),
      );
    }
    card.appendChild(header);

    // Day notes — collapsed by default. Show when there's content
    // already, or when the user expands it. Avoids a forest of empty
    // textareas across many-day trips (issue #2).
    const notesSlot = el("div", { class: "day-notes-slot" });
    let notesTa = null;
    function ensureDayNotes(focus) {
      if (notesTa) return notesTa;
      notesTa = el("textarea", {
        class: "block-edit-input day-notes",
        placeholder: "Notes for this day (jet lag, weather, plans for parents…)",
        disabled: readOnly, rows: 1,
      });
      notesTa.value = day.notes || "";
      setTimeout(() => autosize(notesTa), 0);
      notesTa.addEventListener("input", () => {
        autosize(notesTa);
        saveDay({ notes: notesTa.value });
      });
      notesSlot.innerHTML = "";
      notesSlot.appendChild(notesTa);
      if (focus) notesTa.focus();
      return notesTa;
    }
    if (day.notes) {
      ensureDayNotes(false);
    } else if (!readOnly) {
      const addNotesBtn = el("button", {
        class: "btn ghost inline-add",
        onClick: () => ensureDayNotes(true),
      }, "+ Day notes");
      notesSlot.appendChild(addNotesBtn);
    }
    card.appendChild(notesSlot);

    // Items
    const itemList = el("div", { class: "item-list" });
    (day.items || []).forEach((it, ii) => itemList.appendChild(itemRow(day, it, ii)));
    card.appendChild(itemList);

    if (!readOnly) {
      card.appendChild(
        el("button", { class: "btn ghost add-item", onClick: () => addNewItem(day) }, "+ Add item")
      );
    }
    return card;
  }

  function itemRow(day, it, idx) {
    const saveItem = debouncedSave(withSaveIndicator(ctx, async (patch) => {
      await items.update(it.id, patch);
      Object.assign(it, patch);
      // Update visual classes if status/flags changed
      row.classList.toggle("is-fixed", !!it.is_fixed);
      row.classList.toggle("is-highlight", !!it.is_highlight);
      row.dataset.status = it.status;
    }), 700);

    const row = el("div", {
      class: "item-row",
      "data-status": it.status,
    });
    row.classList.toggle("is-fixed", !!it.is_fixed);
    row.classList.toggle("is-highlight", !!it.is_highlight);

    // First line: time, title, badges
    const top = el("div", { class: "item-top" });
    const startInput = el("input", {
      type: "time", value: (it.start_time || "").slice(0, 5),
      class: "time-input", disabled: readOnly, title: "Start time",
    });
    const endInput = el("input", {
      type: "time", value: (it.end_time || "").slice(0, 5),
      class: "time-input", disabled: readOnly, title: "End time",
    });
    startInput.addEventListener("input", () => saveItem({ start_time: startInput.value || null }));
    endInput.addEventListener("input", () => saveItem({ end_time: endInput.value || null }));

    const titleInput = el("input", {
      type: "text", value: it.title || "", placeholder: "Item title",
      class: "item-title-input", disabled: readOnly,
    });
    titleInput.addEventListener("input", () => saveItem({ title: titleInput.value }));

    top.append(startInput, endInput, titleInput);

    if (!readOnly) {
      top.append(
        el("button", {
          class: "icon-btn",
          title: it.is_fixed ? "Locked schedule — click to mark flexible" : "Flexible — click to mark fixed",
          onClick: () => saveItemNow({ is_fixed: !it.is_fixed }),
        }, it.is_fixed ? "🔒" : "🔓"),
        el("button", {
          class: "icon-btn",
          title: it.is_highlight ? "Unhighlight" : "Mark as highlight",
          onClick: () => saveItemNow({ is_highlight: !it.is_highlight }),
        }, it.is_highlight ? "⭐" : "☆"),
        el("button", { class: "icon-btn", title: "Move up", onClick: () => moveItem(day, idx, -1) }, "↑"),
        el("button", { class: "icon-btn", title: "Move down", onClick: () => moveItem(day, idx, +1) }, "↓"),
        el("button", { class: "icon-btn danger", title: "Delete", onClick: () => deleteItem(it) }, "✕"),
      );
    }
    row.appendChild(top);

    async function saveItemNow(patch) {
      ctx.onSaveStart?.();
      try {
        await items.update(it.id, patch);
        Object.assign(it, patch);
        row.classList.toggle("is-fixed", !!it.is_fixed);
        row.classList.toggle("is-highlight", !!it.is_highlight);
        // Re-render this row to swap icon labels.
        const fresh = itemRow(day, it, idx);
        row.replaceWith(fresh);
      } catch (e) {
        alert("Save failed: " + e.message);
      } finally {
        ctx.onSaveDone?.();
      }
    }

    // Second line: type, status, location, map, notes (collapsible-ish)
    const meta = el("div", { class: "item-meta" });
    meta.append(
      labeledInline("Type",
        select(it.type, ITEM_TYPES, readOnly, (v) => saveItem({ type: v }))
      ),
      labeledInline("Status",
        select(it.status, ITEM_STATUSES, readOnly, (v) => saveItem({ status: v }))
      ),
    );
    row.appendChild(meta);

    // Per-item details (location, map, notes) start collapsed unless the
    // item already has content. Cuts down on a wall of blank inputs when
    // a day has many items (issue #2).
    const detailsSlot = el("div", { class: "item-details-slot" });
    const hasDetails = !!(it.location_name || it.map_url || it.notes);
    let detailsBuilt = false;
    function buildDetails(focusField) {
      if (detailsBuilt) return;
      detailsBuilt = true;
      detailsSlot.innerHTML = "";

      const locInput = el("input", {
        type: "text", value: it.location_name || "",
        placeholder: "📍 Location", disabled: readOnly,
      });
      locInput.addEventListener("input", () => saveItem({ location_name: locInput.value }));

      const mapInput = el("input", {
        type: "url", value: it.map_url || "",
        placeholder: "Map URL (optional)", disabled: readOnly,
      });
      mapInput.addEventListener("input", () => saveItem({ map_url: mapInput.value }));

      const notesTa = el("textarea", {
        class: "block-edit-input", placeholder: "Notes…",
        disabled: readOnly, rows: 1,
      });
      notesTa.value = it.notes || "";
      setTimeout(() => autosize(notesTa), 0);
      notesTa.addEventListener("input", () => { autosize(notesTa); saveItem({ notes: notesTa.value }); });

      detailsSlot.append(locInput, mapInput, notesTa);
      const focusEl = focusField === "notes" ? notesTa
                    : focusField === "map"   ? mapInput
                    : focusField === "loc"   ? locInput
                    : null;
      if (focusEl) focusEl.focus();
    }
    if (hasDetails) {
      buildDetails(null);
    } else if (!readOnly) {
      detailsSlot.appendChild(el("button", {
        class: "btn ghost inline-add",
        onClick: () => buildDetails("loc"),
      }, "+ Location · map · notes"));
    }
    row.appendChild(detailsSlot);

    return row;
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
      const o = el("option", { value: opt, text: opt }, );
      if (opt === value) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  // ===== Mutations =====

  async function addNewDay() {
    ctx.onSaveStart?.();
    try {
      const lastDate = (t.days || []).slice(-1)[0]?.date || null;
      const newDate = lastDate ? addDays(lastDate, 1) : null;
      await days.add(t.id, {
        date: newDate,
        sort_order: (t.days || []).length,
      });
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
    } catch (e) {
      alert("Delete failed: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
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
    } catch (e) {
      alert("Reorder failed: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
  }

  async function addNewItem(day) {
    ctx.onSaveStart?.();
    try {
      await items.add(t.id, day.id, {
        title: "",
        type: "activity",
        status: "planned",
        sort_order: (day.items || []).length,
      });
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
    } catch (e) {
      alert("Delete failed: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
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
    } catch (e) {
      alert("Reorder failed: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
  }
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
