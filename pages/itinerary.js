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

import { days, items, itemCosts } from "../supabase.js";
import { ITEM_TYPES, ITEM_STATUSES } from "../io/schema.js";
import {
  el, debouncedSave, autosize, withSaveIndicator, formatTime, formatTimeRange,
  formatRelativeTime, memberName, COMMON_CURRENCIES,
} from "./_utils.js";
import { openPrintView } from "./print-view.js";

// Visual mapping for item types. The chip's CSS class matches the
// Voyage palette (transit/blue, stay/viridian, meal/amber, thing/viridian,
// note/muted). Glyphs are Material Symbols Outlined names. Exported so
// Budget / Costs / Print can render the same chips without duplicating.
export const TYPE_VISUALS = {
  activity:  { glyph: "explore",            label: "ACTIVITY", chipClass: "thing"   },
  food:      { glyph: "restaurant",         label: "DINING",   chipClass: "meal"    },
  transport: { glyph: "directions_railway", label: "TRANSIT",  chipClass: "transit" },
  lodging:   { glyph: "bed",                label: "STAY",     chipClass: "stay"    },
  shopping:  { glyph: "shopping_bag",       label: "SHOPPING", chipClass: "thing"   },
  rest:      { glyph: "spa",                label: "REST",     chipClass: "note"    },
  note:      { glyph: "edit_note",          label: "NOTE",     chipClass: "note"    },
};

const VIEW_STORAGE_KEY = "voyage:itinerary-view";
// Timeline + cards are CSS variants of the same per-day DOM. Category
// is a different shape: trip-wide, grouped by item type, day context
// shown per row. Selected-day still matters in timeline/cards; category
// ignores it.
const VIEW_OPTIONS = ["timeline", "cards", "category"];

// Module-scope reference to the current click-outside listener used by
// the inline editor. Lives outside renderItinerary so a stale listener
// from a prior render call can be detached when the page re-renders
// (day switch, refresh, navigation between trips).
let activeOutsideListener = null;
function detachActiveOutsideListener() {
  if (!activeOutsideListener) return;
  document.removeEventListener("pointerdown", activeOutsideListener, true);
  activeOutsideListener = null;
}

export function renderItinerary(host, ctx) {
  const t = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const view = readView();
  let expandedItemId = null;
  // Close handler for whichever item is currently expanded — set by
  // renderEditorView, called by the click-outside listener (and by
  // another card's onClick) so opening a new editor first collapses
  // any prior one.
  let expandedCloseFn = null;
  function attachOutsideClose() {
    detachActiveOutsideListener();
    activeOutsideListener = (e) => {
      if (!expandedCloseFn) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(".vy-tl-card.is-editing")) return;
      if (t.closest(".vy-ctxmenu")) return;
      expandedCloseFn();
    };
    document.addEventListener("pointerdown", activeOutsideListener, true);
  }
  // Clear any stale listener from a previous renderItinerary call.
  // Renders happen on day-switch, refresh, etc. — without this the
  // listener (and its closure over the old expandedCloseFn) would leak.
  detachActiveOutsideListener();
  let dayList = null;

  // Which day is currently shown — driven by app.js state, surfaced
  // via the day-strip in the trip-view shell. Itinerary now renders
  // exactly one day at a time; users switch via the day-pill strip.
  const dayCount = (t.days || []).length;
  const idx = Math.min(Math.max(0, ctx.selectedDayIdx || 0), Math.max(0, dayCount - 1));
  const day = (t.days || [])[idx];

  // ── Page head — title, summary, tool buttons ───────────────────────
  const headBlurb = (() => {
    if (!dayCount) return "Add your first day to start planning.";
    if (view === "category") {
      return "Every item across the trip, grouped by type. " +
             "Click a row to jump back to that day on the timeline.";
    }
    return `Editing day ${idx + 1} of ${dayCount}. Switch days with the strip above. ` +
           "Click any event card to edit. Use the view toggle to switch between Timeline, Cards, and Category.";
  })();
  host.appendChild(
    el("section", { class: "page-head vy-itin-head" },
      el("div", { class: "vy-itin-head-l" },
        el("h2", { text: "Itinerary" }),
        el("p", { class: "muted", text: headBlurb }),
      ),
      el("div", { class: "vy-itin-head-r" },
        viewToggle(),
        !readOnly && view !== "category"
          ? el("button", { class: "btn primary", onClick: () => addNewDay() }, "+ Add day")
          : null,
        toolMenu(),
      ),
    )
  );

  if (view === "category") {
    host.appendChild(renderCategoryView());
    appendRouteStale();
    return;
  }

  if (!day) {
    host.appendChild(el("div", { class: "empty-state" },
      el("h3", { text: "No days yet" }),
      el("p", { text: "Add your first day to start planning." }),
    ));
    appendRouteStale();
    return;
  }

  dayList = el("div", { class: "day-list", "data-view": view });
  dayList.appendChild(dayCard(day, idx));
  host.appendChild(dayList);

  appendRouteStale();

  // Trip-wide view grouped by item type. Read-only summary — click a
  // row to drop back into timeline mode focused on that item's day.
  function renderCategoryView() {
    const wrap = el("div", { class: "vy-category", "data-view": "category" });

    const flat = [];
    (t.days || []).forEach((d, di) => {
      (d.items || []).forEach((it) => flat.push({ item: it, day: d, dayIdx: di }));
    });

    if (flat.length === 0) {
      wrap.appendChild(el("div", { class: "empty-state" },
        el("h3", { text: "No items yet" }),
        el("p", { text: "Add events on any day to see them grouped here." }),
      ));
      return wrap;
    }

    // Bucket items by type, preserving the ITEM_TYPES order so categories
    // render in a predictable sequence (activity first, note last).
    const buckets = new Map();
    for (const t of ITEM_TYPES) buckets.set(t, []);
    for (const entry of flat) {
      const key = ITEM_TYPES.includes(entry.item.type) ? entry.item.type : "activity";
      buckets.get(key).push(entry);
    }

    // Counts strip — quick at-a-glance summary at the top.
    const summary = el("div", { class: "vy-category-summary" });
    for (const type of ITEM_TYPES) {
      const count = buckets.get(type).length;
      if (count === 0) continue;
      const visuals = TYPE_VISUALS[type];
      summary.appendChild(el("span", { class: `vy-category-chip vy-chip vy-chip--${visuals.chipClass}` },
        el("span", { class: "material-symbols-outlined", text: visuals.glyph }),
        el("span", { class: "vy-category-chip-label", text: visuals.label }),
        el("span", { class: "vy-category-chip-count", text: String(count) }),
      ));
    }
    wrap.appendChild(summary);

    for (const type of ITEM_TYPES) {
      const entries = buckets.get(type);
      if (entries.length === 0) continue;
      const visuals = TYPE_VISUALS[type];

      // Within a group: sort by day index (so earlier days come first),
      // then by start time so a day's items stay in chronological order.
      entries.sort((a, b) => {
        if (a.dayIdx !== b.dayIdx) return a.dayIdx - b.dayIdx;
        const at = a.item.start_time || "";
        const bt = b.item.start_time || "";
        return at.localeCompare(bt);
      });

      const section = el("section", { class: "vy-category-section card" });
      section.appendChild(el("header", { class: "vy-category-section-head" },
        el("span", { class: `vy-chip vy-chip--${visuals.chipClass}` },
          el("span", { class: "material-symbols-outlined", text: visuals.glyph }),
          el("span", { text: visuals.label }),
        ),
        el("span", { class: "vy-meta", text: `${entries.length} ${entries.length === 1 ? "ITEM" : "ITEMS"}` }),
      ));

      const list = el("div", { class: "vy-category-list" });
      for (const entry of entries) list.appendChild(categoryRow(entry, visuals));
      section.appendChild(list);

      wrap.appendChild(section);
    }
    return wrap;
  }

  function categoryRow({ item: it, day: d, dayIdx }, visuals) {
    const timeLabel = (it.start_time || it.end_time)
      ? formatTimeRange(it.start_time, it.end_time)
      : "";
    const dayLabel = d.date
      ? new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : `Day ${dayIdx + 1}`;
    const cityLabel = d.city ? ` · ${d.city}` : "";

    const row = el("button", {
      class: "vy-category-row",
      type: "button",
      "data-item-id": it.id,
      onClick: () => jumpToDay(dayIdx),
    },
      el("div", { class: "vy-category-row-main" },
        el("span", { class: "vy-category-row-title", text: it.title || "(untitled)" }),
        it.location_name
          ? el("span", { class: "vy-category-row-loc",
              text: it.location_name })
          : null,
      ),
      el("div", { class: "vy-category-row-meta" },
        // Unplanned items (logged via Costs page) get a small chip so
        // they're distinguishable from planned events in the trip-wide
        // summary. ✂ glyph signals an item with a custom split.
        it.is_unplanned
          ? el("span", { class: "vy-category-row-unplanned", text: "UNPLANNED" })
          : null,
        (it.shares || []).length > 0
          ? el("span", { class: "vy-category-row-split", title: "Custom split", text: "✂" })
          : null,
        timeLabel ? el("span", { class: "vy-category-row-time", text: timeLabel }) : null,
        el("span", { class: "vy-category-row-day", text: `Day ${dayIdx + 1} · ${dayLabel}${cityLabel}` }),
      ),
    );
    if (it.is_highlight) row.classList.add("is-highlight");
    if (it.is_unplanned) row.classList.add("is-unplanned");
    return row;
  }

  function jumpToDay(dayIdx) {
    writeView("timeline");
    ctx.setSelectedDayIdx?.(dayIdx);
  }

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
          if (v === view) return;
          writeView(v);
          // Timeline ↔ Cards is a CSS-only swap of the same per-day DOM
          // — fast, preserves any open inline editor. Category has a
          // fundamentally different shape (trip-wide groups), so any
          // transition into or out of it needs a full re-render.
          const needsRebuild = v === "category" || view === "category";
          if (needsRebuild) {
            ctx.rerender?.();
            return;
          }
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
            // Reorder is via the day-strip grip / right-click menu — no
            // ↑/↓ buttons here.
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
    // is_unplanned items are travel-mode artefacts (added via the
    // Costs page's "+ Add unplanned expense") — surface them on the
    // Itinerary Category view and the Costs page, but keep them out
    // of the day-focused Timeline/Cards so planning stays uncluttered.
    const visibleItems = (day.items || []).filter((it) => !it.is_unplanned);
    visibleItems.forEach((it, ii) => tl.appendChild(timelineItem(day, it, ii)));
    if (!readOnly) {
      tl.appendChild(el("div", { class: "vy-tl-add-row" },
        el("button", { class: "btn ghost inline-add",
          onClick: () => addNewItem(day) }, "+ Add event"),
      ));
    }
    card.appendChild(tl);

    return card;
  }

  // Drag wiring lives on each grip inside cardCell so it survives
  // wrap re-renders (e.g. the inline editor closing after a time edit).
  // startItemDrag below pulls allItems from the DOM at pointerdown time.

  function startItemDrag(downEvent, draggedWrap, allItems, tl) {
    if (downEvent.button !== 0 && downEvent.pointerType === "mouse") return;
    downEvent.preventDefault();
    downEvent.stopPropagation();

    const grip = downEvent.currentTarget;
    const startIdx = allItems.indexOf(draggedWrap);
    if (startIdx < 0) return;

    // Snapshot every peer's home rect (viewport-space top + height).
    const homes = allItems.map((el) => {
      const r = el.getBoundingClientRect();
      return { el, y: r.top, h: r.height };
    });
    const homeOf = homes[startIdx];
    const startY = downEvent.clientY;

    // liveOrder: array of original indexes in their current slot order.
    let liveOrder = allItems.map((_, i) => i);
    let lastSlot = startIdx;

    draggedWrap.classList.add("is-dragging");
    draggedWrap.style.zIndex = "10";
    draggedWrap.style.willChange = "transform";
    // Dragged element shouldn't transition while tracking the pointer
    // — siblings keep their default transition for the smooth dodge.
    draggedWrap.style.transition = "none";

    try { grip.setPointerCapture(downEvent.pointerId); } catch {}

    function layoutPeers() {
      for (let i = 0; i < homes.length; i++) {
        if (i === startIdx) continue;
        const newSlot = liveOrder.indexOf(i);
        const delta = homes[newSlot].y - homes[i].y;
        homes[i].el.style.transform = delta ? `translateY(${delta}px)` : "";
      }
    }

    function onMove(ev) {
      const dy = ev.clientY - startY;
      draggedWrap.style.transform = `translateY(${dy}px)`;

      // Snap to whichever slot's centre is closest to the dragged
      // item's centre. This is the same "nearest neighbour" rule the
      // design canvas's grip drag uses — robust to fast pointer jumps.
      const draggedCenter = homeOf.y + dy + homeOf.h / 2;
      let nearest = 0, bestDist = Infinity;
      for (let i = 0; i < homes.length; i++) {
        const center = homes[i].y + homes[i].h / 2;
        const d = Math.abs(center - draggedCenter);
        if (d < bestDist) { bestDist = d; nearest = i; }
      }
      if (nearest !== lastSlot) {
        lastSlot = nearest;
        liveOrder = allItems.map((_, i) => i).filter((i) => i !== startIdx);
        liveOrder.splice(nearest, 0, startIdx);
        layoutPeers();
      }
    }

    function cleanup() {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      try { grip.releasePointerCapture(downEvent.pointerId); } catch {}
    }

    function onUp() {
      cleanup();
      const finalSlot = liveOrder.indexOf(startIdx);
      // Re-enable the dragged element's transition for the settle slide.
      draggedWrap.style.transition = "";
      const dyFinal = homes[finalSlot].y - homes[startIdx].y;
      draggedWrap.style.transform = dyFinal ? `translateY(${dyFinal}px)` : "";

      // After the settle animation, clear all transforms and commit the
      // new order. We disable transitions on every peer for the commit
      // frame so the cleared transforms don't trigger a snap-back, then
      // re-enable in two RAFs once the DOM is repainted.
      const SETTLE_MS = 200;
      window.setTimeout(() => {
        for (const h of homes) {
          h.el.style.transition = "none";
          h.el.style.transform = "";
        }
        draggedWrap.classList.remove("is-dragging");
        draggedWrap.style.zIndex = "";
        draggedWrap.style.willChange = "";

        if (startIdx !== finalSlot) {
          const newItemsOrder = liveOrder.map((i) => day.items[i]);
          commitItemReorder(day, newItemsOrder);
        }

        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const h of homes) h.el.style.transition = "";
        }));
      }, SETTLE_MS);
    }

    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  }

  // Optimistic local reorder — mutates day.items in place, retimes,
  // re-renders the page immediately, then sends the API calls in the
  // background. On failure, restores the original snapshot and toasts.
  async function commitItemReorder(day, newItemsOrder) {
    const origOrder = day.items.slice();
    const origTimes = day.items.map((it) => ({
      id: it.id, start_time: it.start_time, end_time: it.end_time,
    }));
    const timeUpdates = recomputeItemTimes(origOrder, newItemsOrder);
    const updatesById = new Map(timeUpdates.map((u) => [u.id, u]));

    // Apply locally.
    day.items.splice(0, day.items.length, ...newItemsOrder);
    for (const item of day.items) {
      const u = updatesById.get(item.id);
      if (u) { item.start_time = u.start_time; item.end_time = u.end_time; }
    }
    // Snappy local re-render — no network wait.
    ctx.rerender?.();

    // Background persistence. We don't block the UI on the round-trip;
    // failures revert local state and re-render so the user isn't left
    // with a phantom order.
    ctx.onSaveStart?.();
    try {
      await items.reorder(newItemsOrder.map((x) => x.id));
      // Parallelise the time updates — they're independent rows.
      await Promise.all(timeUpdates.map((u) =>
        items.update(u.id, { start_time: u.start_time, end_time: u.end_time })
      ));
    } catch (e) {
      // Revert: restore the original order + times.
      day.items.splice(0, day.items.length, ...origOrder);
      for (const ot of origTimes) {
        const item = day.items.find((it) => it.id === ot.id);
        if (item) { item.start_time = ot.start_time; item.end_time = ot.end_time; }
      }
      ctx.rerender?.();
      (ctx.toast || alert)("Reorder failed: " + e.message, true);
    } finally {
      ctx.onSaveDone?.();
    }
  }

  function timelineItem(day, it, idx) {
    const wrap = el("div", { class: "vy-tl-item", "data-status": it.status, "data-id": it.id });
    wrap.classList.toggle("is-fixed", !!it.is_fixed);
    wrap.classList.toggle("is-highlight", !!it.is_highlight);
    // Surface the event type on the wrap so CSS can tint the highlight
    // background to match the chip palette (highlight bg picks up the
    // event's hue rather than always being amber).
    wrap.dataset.type = it.type || "activity";
    // Stash the item's position so drag-and-drop can read from/to indexes.
    wrap.dataset.idx = String(idx);

    // saveItemNow lifted to closure scope so cardCell + contextmenu can
    // both call it without going through the editor.
    async function saveItemNow(patch, opts = {}) {
      ctx.onSaveStart?.();
      try {
        await items.update(it.id, patch);
        Object.assign(it, patch);
        wrap.classList.toggle("is-fixed", !!it.is_fixed);
        wrap.classList.toggle("is-highlight", !!it.is_highlight);
        wrap.dataset.status = it.status;
        wrap.dataset.type = it.type || "activity";
        if (opts.keepEditor && expandedItemId === it.id) renderEditorView();
        else if (expandedItemId === it.id)              renderEditorView();
        else                                             renderCardView();
      } catch (e) {
        alert("Save failed: " + e.message);
      } finally {
        ctx.onSaveDone?.();
      }
    }

    function renderCardView() {
      wrap.innerHTML = "";
      wrap.appendChild(timeCell(it));
      wrap.appendChild(pipCell(it));
      wrap.appendChild(cardCell(it));
      attachContextMenu();
    }

    function renderEditorView() {
      wrap.innerHTML = "";
      wrap.appendChild(timeCell(it));
      wrap.appendChild(pipCell(it));
      wrap.appendChild(editorCell(day, it, idx));
      attachContextMenu();
      // Register a close handler so the click-outside listener (and
      // other-card clicks) can collapse this editor back to a card
      // without a full re-render.
      expandedCloseFn = () => {
        if (expandedItemId !== it.id) return;
        expandedItemId = null;
        expandedCloseFn = null;
        detachActiveOutsideListener();
        renderCardView();
      };
      attachOutsideClose();
    }

    function attachContextMenu() {
      if (readOnly || !ctx.openContextMenu) return;
      wrap.addEventListener("contextmenu", (e) => {
        // Let inputs keep their native menu (copy/paste/spellcheck).
        if (e.target.closest("input, textarea, select")) return;
        e.preventDefault();
        const items = day.items || [];
        ctx.openContextMenu(e.clientX, e.clientY, [
          { label: expandedItemId === it.id ? "Close editor" : "Edit event",
            glyph: expandedItemId === it.id ? "close" : "edit",
            onClick: () => {
              if (expandedItemId === it.id) {
                if (expandedCloseFn) expandedCloseFn();
              } else {
                if (expandedCloseFn) expandedCloseFn();
                expandedItemId = it.id;
                renderEditorView();
              }
            } },
          { type: "sep" },
          { label: "Add event before", glyph: "arrow_upward",
            onClick: () => addNewItem(day, idx) },
          { label: "Add event after",  glyph: "arrow_downward",
            onClick: () => addNewItem(day, idx + 1) },
          { type: "sep" },
          { label: "Move up",   glyph: "north",
            disabled: idx === 0,
            onClick: () => moveItem(day, idx, -1) },
          { label: "Move down", glyph: "south",
            disabled: idx === items.length - 1,
            onClick: () => moveItem(day, idx, +1) },
          { type: "sep" },
          { label: it.is_fixed ? "Mark flexible" : "Mark fixed",
            glyph: it.is_fixed ? "lock_open" : "lock",
            onClick: () => saveItemNow({ is_fixed: !it.is_fixed }) },
          { label: it.is_highlight ? "Unhighlight" : "Highlight",
            glyph: "star",
            onClick: () => saveItemNow({ is_highlight: !it.is_highlight }) },
          { label: "Set item currency...", glyph: "payments",
            onClick: () => openCurrencyPickerForItem(it, e.clientX, e.clientY) },
          { type: "sep" },
          { label: "Delete event", glyph: "delete", danger: true,
            onClick: () => deleteItem(it) },
        ]);
      });
    }

    // Second-level menu spawned by "Set item currency...". Lists the
    // trip default (with check if the item inherits it) plus the
    // top-15 common currencies. Selecting writes itinerary_items.currency
    // (NULL = inherit default) and refreshes the trip so the row chip
    // reflects the new override.
    function openCurrencyPickerForItem(it, x, y) {
      if (!ctx.openContextMenu) return;
      const tripDefault = (ctx.trip?.default_currency || "USD").toUpperCase();
      const current = (it.currency || "").toUpperCase();
      const isInherit = !current;
      const rows = [
        { label: `${tripDefault} · trip default`,
          glyph: isInherit ? "check" : "currency_exchange",
          onClick: () => setItemCurrency(it, null) },
        { type: "sep" },
      ];
      // Dedupe trip default from the common list so it doesn't appear twice.
      for (const code of COMMON_CURRENCIES) {
        if (code === tripDefault) continue;
        rows.push({
          label: code,
          glyph: current === code ? "check" : null,
          onClick: () => setItemCurrency(it, code),
        });
      }
      ctx.openContextMenu(x, y, rows);
    }

    async function setItemCurrency(it, code) {
      it.currency = code; // optimistic
      ctx.onSaveStart?.();
      try {
        await itemCosts.updateItem(it.id, { currency: code });
      } catch (e) {
        ctx.toast?.("Could not set currency: " + (e.message || e), true);
      } finally {
        ctx.onSaveDone?.();
      }
      ctx.rerender?.();
    }

    function timeCell(it) {
      const t = formatTimeRange(it.start_time, it.end_time) || formatTime(it.start_time) || "—";
      const cell = el("div", { class: "vy-tl-time", text: t });
      // Overnight (end < start) — quietly mark the cell so the user
      // sees the event spills into the next morning. Keeps the day
      // independent: the event still belongs to this day's column.
      if (endsNextDay(it.start_time, it.end_time)) {
        cell.classList.add("is-overnight");
        cell.appendChild(el("span", { class: "vy-tl-time-next", text: "+1d", title: "Ends next morning" }));
      }
      return cell;
    }

    function pipCell(it) {
      const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
      // Color follows the event TYPE.
      // Filled iff is_fixed; empty otherwise (= flexible).
      // Highlight is communicated by the card background, not the pip.
      const fill = !!it.is_fixed;
      return el("div", { class: "vy-tl-pip-col" },
        el("span", { class: `vy-pip vy-pip--${pipColor(v.chipClass)} ${fill ? "is-on" : ""}` }),
      );
    }

    function cardCell(it) {
      const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
      const card = el("div", { class: "vy-tl-card",
        onClick: (e) => {
          // Quick toggles & inner controls swallow their own clicks. Any
          // other click on the card body opens the inline editor.
          if (e.target.closest("button, input, select, textarea, a")) return;
          if (readOnly) return;
          // Close any other open editor first — at most one card is
          // expanded at a time, matching the hint shown in the editor head.
          if (expandedCloseFn && expandedItemId !== it.id) expandedCloseFn();
          expandedItemId = it.id;
          renderEditorView();
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
      if (it.status && it.status !== "planned") flagRow.appendChild(el("span", { class: "vy-conf", text: it.status.toUpperCase() }));
      // ✂ marker when this item has a custom split. Subtle — the Budget
      // page is where the actual breakdown lives; this just signals
      // "shared costs apply here."
      if ((it.shares || []).length > 0) {
        flagRow.appendChild(el("span", { class: "vy-tl-split-glyph", title: "Has custom split — see Budget", text: "✂" }));
      }
      if (flagRow.children.length) lhs.appendChild(flagRow);
      card.appendChild(lhs);

      const rhs = el("div", { class: "vy-tl-card-r" });
      if (!readOnly) {
        // Quick-toggle buttons — always visible so users can flip a flag
        // without opening the editor or the context menu.
        rhs.appendChild(quickToggle({
          on: !!it.is_fixed,
          glyph: it.is_fixed ? "lock" : "lock_open",
          title: it.is_fixed ? "Fixed — click to make flexible" : "Flexible — click to fix in place",
          tone: "viridian",
          onClick: () => saveItemNow({ is_fixed: !it.is_fixed }),
        }));
        rhs.appendChild(quickToggle({
          on: !!it.is_highlight,
          glyph: "star",
          title: it.is_highlight ? "Highlighted — click to unhighlight" : "Mark as highlight",
          tone: "amber",
          onClick: () => saveItemNow({ is_highlight: !it.is_highlight }),
        }));
      }
      const dur = computeDuration(it.start_time, it.end_time);
      if (dur) rhs.appendChild(el("span", { class: "vy-tl-card-dur", text: dur }));
      card.appendChild(rhs);
      // Drag grip — its own column on the far right. Pointerdown wires
      // here so the grip stays draggable after any wrap re-render (e.g.
      // closing the inline editor after editing the event's time).
      if (!readOnly) {
        const grip = el("button", {
          class: "vy-tl-card-grip",
          title: "Drag to reorder",
          tabindex: "-1",
          onClick: (e) => e.stopPropagation(),
        },
          el("span", { class: "material-symbols-outlined", text: "drag_indicator" }),
        );
        grip.addEventListener("pointerdown", (e) => {
          const tlEl = grip.closest(".vy-tl");
          if (!tlEl) return;
          const allItems = Array.from(tlEl.querySelectorAll(".vy-tl-item"));
          startItemDrag(e, wrap, allItems, tlEl);
        });
        card.appendChild(grip);
      }
      return card;
    }

    function quickToggle({ on, glyph, title, tone, onClick }) {
      const btn = el("button", {
        class: `vy-tl-quick ${on ? "is-on" : ""} vy-tl-quick--${tone || "viridian"}`,
        title,
        onClick: (e) => { e.stopPropagation(); onClick(); },
      },
        el("span", { class: "material-symbols-outlined", text: glyph }),
      );
      return btn;
    }

    function editorCell(day, it, idx) {
      const cell = el("div", { class: "vy-tl-card is-editing" });
      const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;

      const saveItem = debouncedSave(withSaveIndicator(ctx, async (patch) => {
        await items.update(it.id, patch);
        Object.assign(it, patch);
      }), 600);

      // ── Time inputs + overlap guard ────────────────────────────────
      const startInput = el("input", { type: "time", class: "time-input",
        value: (it.start_time || "").slice(0, 5), disabled: readOnly, title: "Start time" });
      const endInput   = el("input", { type: "time", class: "time-input",
        value: (it.end_time   || "").slice(0, 5), disabled: readOnly, title: "End time" });

      let lastGoodStart = (it.start_time || "").slice(0, 5);
      let lastGoodEnd   = (it.end_time   || "").slice(0, 5);

      const durChip = el("span", { class: "vy-edit-dur",
        text: computeDuration(it.start_time, it.end_time) || "—" });

      // Subtle "+1d" badge that shows up next to the end-time input
      // when the event spills past midnight. Reflects the same logic
      // the timeline-time cell uses on collapsed cards.
      const nextDayBadge = el("span", {
        class: "vy-edit-nextday",
        title: "Ends the next morning",
        text: "+1d",
      });
      nextDayBadge.hidden = !endsNextDay(it.start_time, it.end_time);

      function tryCommitTime(field, raw) {
        const value = raw || "";
        const newStart = field === "start" ? value : lastGoodStart;
        const newEnd   = field === "end"   ? value : lastGoodEnd;
        const conflict = findOverlap(day, it, newStart, newEnd);
        if (conflict) {
          const ot = formatTimeRange(conflict.start_time, conflict.end_time) ||
                     formatTime(conflict.start_time) || "untimed";
          const overnight = endsNextDay(conflict.start_time, conflict.end_time) ? " +1d" : "";
          (ctx.toast || alert)(
            `Time conflicts with "${conflict.title || "untitled"}" (${ot}${overnight})`,
            true
          );
          if (field === "start") startInput.value = lastGoodStart;
          else                   endInput.value   = lastGoodEnd;
          return;
        }
        if (field === "start") lastGoodStart = value;
        else                   lastGoodEnd   = value;
        durChip.textContent = computeDuration(newStart, newEnd) || "—";
        nextDayBadge.hidden = !endsNextDay(newStart, newEnd);
        saveItem({ [field === "start" ? "start_time" : "end_time"]: value || null });
      }
      startInput.addEventListener("change", () => tryCommitTime("start", startInput.value));
      endInput.addEventListener("change",   () => tryCommitTime("end",   endInput.value));

      // ── Title ──────────────────────────────────────────────────────
      const titleInput = el("input", { type: "text", class: "vy-edit-title-input",
        value: it.title || "", placeholder: "Untitled event", disabled: readOnly });
      titleInput.addEventListener("input", () => saveItem({ title: titleInput.value }));

      // ── Classify ───────────────────────────────────────────────────
      const typeSelect = select(it.type, ITEM_TYPES, readOnly, (v) => saveItemNow({ type: v }));
      const statSelect = select(it.status, ITEM_STATUSES, readOnly, (v) => saveItem({ status: v }));

      // ── Where ──────────────────────────────────────────────────────
      const locInput = el("input", { type: "text", value: it.location_name || "",
        placeholder: "Place name", disabled: readOnly });
      locInput.addEventListener("input", () => saveItem({ location_name: locInput.value }));

      const mapInput = el("input", { type: "url", value: it.map_url || "",
        placeholder: "Map URL (optional)", disabled: readOnly });
      mapInput.addEventListener("input", () => saveItem({ map_url: mapInput.value }));

      // ── Notes ──────────────────────────────────────────────────────
      const notesTa = el("textarea", { class: "block-edit-input",
        placeholder: "Notes — context, reservations, reminders…",
        disabled: readOnly, rows: 2 });
      notesTa.value = it.notes || "";
      setTimeout(() => autosize(notesTa), 0);
      notesTa.addEventListener("input", () => { autosize(notesTa); saveItem({ notes: notesTa.value }); });

      // ── Header bar ─────────────────────────────────────────────────
      const header = el("div", { class: "vy-edit-head" },
        el("span", { class: `vy-chip vy-chip--${v.chipClass}` },
          el("span", { class: "material-symbols-outlined", text: v.glyph }),
          el("span", { text: v.label }),
        ),
        el("span", { class: "vy-edit-state", text: "EDITING" }),
        el("span", { class: "vy-edit-hint", text: "Click outside or press ✕ to close" }),
        !readOnly
          ? el("button", { class: "vy-edit-close", title: "Close editor",
              onClick: () => { if (expandedCloseFn) expandedCloseFn(); } },
              el("span", { class: "material-symbols-outlined", text: "close" }),
            )
          : null,
      );

      // ── Sections ───────────────────────────────────────────────────
      const scheduleSection = section("schedule", "Schedule",
        labeledInline("Start", startInput),
        labeledInline("End",   endInput),
        nextDayBadge,
        durChip,
        !readOnly ? toggleChip({
          on: !!it.is_fixed,
          glyph: it.is_fixed ? "lock" : "lock_open",
          label: it.is_fixed ? "Fixed" : "Flexible",
          tone: "viridian",
          onClick: () => saveItemNow({ is_fixed: !it.is_fixed }),
        }) : null,
      );

      const classifySection = section("sell", "Classify",
        labeledInline("Type",   typeSelect),
        labeledInline("Status", statSelect),
        !readOnly ? toggleChip({
          on: !!it.is_highlight,
          glyph: "star",
          label: it.is_highlight ? "Highlighted" : "Highlight",
          tone: "amber",
          onClick: () => saveItemNow({ is_highlight: !it.is_highlight }),
        }) : null,
      );

      const whereSection = section("place", "Where", locInput, mapInput);
      const notesSection = section("edit_note", "Notes", notesTa);

      const foot = !readOnly
        ? el("div", { class: "vy-edit-foot" },
            el("button", { class: "vy-edit-delete", title: "Delete this event",
              onClick: () => deleteItem(it) },
              el("span", { class: "material-symbols-outlined", text: "delete" }),
              el("span", { text: "Delete event" }),
            ),
            // Cost editing intentionally lives on the Budget page so the
            // Itinerary editor stays focused on what / when / where.
            el("a", { class: "vy-edit-budget-link", href: "#",
              onClick: (e) => { e.preventDefault(); ctx.navigate?.({ page: "budget" }); } },
              el("span", { class: "material-symbols-outlined", text: "payments" }),
              el("span", { text: "Costs and splits → Budget" }),
            ),
          )
        : null;

      // Attribution line — "added by <name> · <time>". Quiet at the
      // bottom of the editor so it's discoverable without crowding the
      // grid. Rendered only when we can resolve the creator's display
      // name; rows pre-dating the attribution columns simply omit it.
      const author = memberName(ctx.membersById, it.created_by);
      const when   = formatRelativeTime(it.created_at);
      const attribution = author
        ? el("p", { class: "vy-edit-attribution muted small",
            text: when ? `Added by ${author} · ${when}` : `Added by ${author}` })
        : null;

      cell.append(
        header,
        el("div", { class: "vy-edit-title-wrap" }, titleInput),
        scheduleSection,
        classifySection,
        whereSection,
        notesSection,
        foot,
        attribution,
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
    // Backwards-compat shim for the contextmenu callers — delegate to
    // the canonical from→to reorder so all event moves go through one
    // path (drag-drop and context-menu).
    const j = idx + dir;
    return reorderItemTo(day, idx, j);
  }

  // Compute the new order from a from/to index pair and forward to
  // commitItemReorder so the context-menu Move up / Move down path
  // shares the same optimistic + retime flow as drag-drop.
  async function reorderItemTo(day, fromIdx, toIdx) {
    const list = day.items || [];
    if (fromIdx < 0 || fromIdx >= list.length) return;
    if (toIdx   < 0 || toIdx   >= list.length) return;
    if (fromIdx === toIdx) return;
    const newOrder = list.slice();
    const [moved] = newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, moved);
    return commitItemReorder(day, newOrder);
  }
}

// ─── Auto-retime on reorder ────────────────────────────────────────
//
// When events are reordered, keep each event's duration but rewrite
// its start/end times so the day's schedule shifts to match the new
// order. The "rest gaps" between consecutive timed items are treated
// as implicit (never persisted as events) and travel with positional
// slot index — gap[0] is the gap after the first timed slot, etc.
//
// Returns a list of { id, start_time, end_time } updates that need
// to be persisted. Items that originally had no start_time stay
// untimed and don't participate in the chain.
function recomputeItemTimes(snapshot, newOrder) {
  const parseT = (s) => {
    if (!s) return null;
    const m = String(s).slice(0, 5).match(/^(\d{2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const fmtT = (mins) => {
    const m = ((mins % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };

  // Only timed items participate. We project each into an absolute
  // minute-line that lets the retiming math work across midnight
  // wraps — when an event's HH:MM appears earlier than the prior
  // event's, we bump a base offset by 1440 so the schedule stays
  // monotonic.
  const timedOriginals = snapshot.filter((x) => parseT(x.start_time) != null);
  if (timedOriginals.length < 2) return [];

  const absById = new Map();
  let base = 0;
  let prevAbsStart = -Infinity;
  for (const it of timedOriginals) {
    let s = parseT(it.start_time);
    let e = parseT(it.end_time);
    // Wrap end past midnight if end < start (overnight event).
    let eAbsOffset = 0;
    if (e != null && e < s) eAbsOffset = 1440;
    // Bump base if this start would land before the previous start
    // on the absolute line (another wrap between consecutive items).
    while (s + base < prevAbsStart) base += 1440;
    const absS = s + base;
    const absE = e != null ? e + base + eAbsOffset : absS;
    absById.set(it.id, { absS, absE, dur: absE - absS, hasEnd: e != null });
    prevAbsStart = absS;
  }

  const anchor = absById.get(timedOriginals[0].id).absS;

  // Positional gaps between consecutive timed originals (in absolute
  // minutes — non-negative because we made the line monotonic above).
  const gaps = [];
  for (let i = 0; i < timedOriginals.length - 1; i++) {
    const a = absById.get(timedOriginals[i].id);
    const b = absById.get(timedOriginals[i + 1].id);
    gaps.push(Math.max(0, b.absS - a.absE));
  }

  const origById = new Map(snapshot.map((x) => [x.id, x]));

  let cursor = anchor;
  let timedPos = 0;
  const updates = [];
  for (const it of newOrder) {
    const orig = origById.get(it.id);
    if (!orig || parseT(orig.start_time) == null) continue;

    const abs = absById.get(it.id);
    const dur = abs ? abs.dur : 0;
    const hasEnd = abs ? abs.hasEnd : false;
    const newStart = cursor;
    const newEnd = newStart + dur;
    const newStartStr = fmtT(newStart);
    const newEndStr = hasEnd ? fmtT(newEnd) : null;

    const origStartStr = orig.start_time ? orig.start_time.slice(0, 5) : null;
    const origEndStr   = orig.end_time   ? orig.end_time.slice(0, 5)   : null;

    if (newStartStr !== origStartStr || newEndStr !== origEndStr) {
      updates.push({ id: it.id, start_time: newStartStr, end_time: newEndStr });
    }

    cursor = newEnd + (gaps[timedPos] || 0);
    timedPos++;
  }
  return updates;
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

// Render an editor section: a small icon-glyph + label header on the
// left, with the section's controls flowing on the right. Section
// flattens to a single column on narrow screens via CSS.
function section(glyph, label, ...children) {
  return el("section", { class: "vy-edit-section" },
    el("div", { class: "vy-edit-section-head" },
      el("span", { class: "material-symbols-outlined", text: glyph }),
      el("span", { text: label.toUpperCase() }),
    ),
    el("div", { class: "vy-edit-fields" }, ...children.filter(Boolean)),
  );
}

// Pill-shaped toggle used inside the editor (fixed / highlight).
// Reads as a label not just an icon so the editor surface is
// self-explanatory.
function toggleChip({ on, glyph, label, tone, onClick }) {
  return el("button", {
    class: `vy-edit-toggle ${on ? "is-on" : ""} vy-edit-toggle--${tone || "viridian"}`,
    onClick: (e) => { e.stopPropagation(); onClick(); },
  },
    el("span", { class: "material-symbols-outlined", text: glyph }),
    el("span", { text: label }),
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

// Parse HH:MM string to minutes-of-day (0–1439), or null.
function parseHM(s) {
  if (!s) return null;
  const m = String(s).slice(0, 5).match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// True if end is strictly earlier than start — the event wraps past
// midnight into the next morning. Each day's events are independent,
// so an event that ends at 02:00 still belongs to the day where it
// started at 23:00.
function endsNextDay(startStr, endStr) {
  const s = parseHM(startStr);
  const e = parseHM(endStr);
  if (s == null || e == null) return false;
  return e < s;
}

// Expand an event's HH:MM range into one or two minute-of-day
// intervals in [0, 1440). A wrapping event 23:00→02:00 becomes
// [[1380, 1440], [0, 120]]. Used by findOverlap so an overnight
// event correctly conflicts with another late-night or early-morning
// event on the same day.
function intervalsOf(startStr, endStr) {
  const s = parseHM(startStr);
  if (s == null) return [];
  const e = parseHM(endStr);
  if (e == null || e === s) return [[s, s]];
  if (e > s) return [[s, e]];
  return [[s, 1440], [0, e]];
}

function intervalsCollide(a, b) {
  for (const [aS, aE] of a) {
    for (const [bS, bE] of b) {
      // Strict inequality — touching boundaries (one ends exactly
      // when the next starts) are not a conflict.
      if (aS < bE && bS < aE) return true;
      // Two zero-duration points at the same minute count as a
      // conflict so the user notices the collision.
      if (aS === aE && bS === bE && aS === bS) return true;
    }
  }
  return false;
}

// Find another timed item on this day that overlaps the proposed time
// range for `selfItem`. Returns the conflicting item, or null if free.
function findOverlap(day, selfItem, newStartStr, newEndStr) {
  if (parseHM(newStartStr) == null) return null;
  const a = intervalsOf(newStartStr, newEndStr);
  for (const other of (day.items || [])) {
    if (other.id === selfItem.id) continue;
    if (parseHM(other.start_time) == null) continue;
    const b = intervalsOf(other.start_time, other.end_time);
    if (intervalsCollide(a, b)) return other;
  }
  return null;
}

// Duration in minutes, wrap-aware. end < start wraps to next day.
function durationMinutes(startStr, endStr) {
  const s = parseHM(startStr);
  const e = parseHM(endStr);
  if (s == null || e == null) return null;
  let mins = e - s;
  if (mins < 0) mins += 1440;
  return mins;
}

function computeDuration(s, e) {
  const mins = durationMinutes(s, e);
  if (mins == null || mins <= 0) return null;
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
