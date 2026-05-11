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
// Only two distinct visual modes — the previous "list" view was almost
// identical to "timeline" and added no real affordance.
const VIEW_OPTIONS = ["timeline", "cards"];

export function renderItinerary(host, ctx) {
  const t = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const view = readView();
  let expandedItemId = null;
  let dayList = null;

  // Which day is currently shown — driven by app.js state, surfaced
  // via the day-strip in the trip-view shell. Itinerary now renders
  // exactly one day at a time; users switch via the day-pill strip.
  const dayCount = (t.days || []).length;
  const idx = Math.min(Math.max(0, ctx.selectedDayIdx || 0), Math.max(0, dayCount - 1));
  const day = (t.days || [])[idx];

  // ── Page head — title, summary, tool buttons ───────────────────────
  host.appendChild(
    el("section", { class: "page-head vy-itin-head" },
      el("div", { class: "vy-itin-head-l" },
        el("h2", { text: "Itinerary" }),
        el("p", { class: "muted",
          text: dayCount
            ? `Editing day ${idx + 1} of ${dayCount}. Switch days with the strip above. ` +
              "Click any event card to edit. Use the view toggle to switch between Timeline, List and Cards."
            : "Add your first day to start planning." }),
      ),
      el("div", { class: "vy-itin-head-r" },
        viewToggle(),
        !readOnly ? el("button", { class: "btn primary", onClick: () => addNewDay() }, "+ Add day") : null,
        toolMenu(),
      ),
    )
  );

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
    (day.items || []).forEach((it, ii) => tl.appendChild(timelineItem(day, it, ii)));
    if (!readOnly) {
      tl.appendChild(el("div", { class: "vy-tl-add-row" },
        el("button", { class: "btn ghost inline-add",
          onClick: () => addNewItem(day) }, "+ Add event"),
      ));
    }
    card.appendChild(tl);

    if (!readOnly) wireEventDragReorder(tl, day);

    return card;
  }

  // Attach HTML5 drag-and-drop to every .vy-tl-item inside the day's
  // timeline. Uses pointer events + live transforms so siblings smoothly
  // dodge to make space for the dragged item (iOS-style), and applies
  // the new order optimistically — the local trip state is mutated and
  // re-rendered immediately, then the API calls fire in the background.
  function wireEventDragReorder(tl, day) {
    const all = Array.from(tl.querySelectorAll(".vy-tl-item"));
    all.forEach((wrap) => {
      const grip = wrap.querySelector(".vy-tl-card-grip");
      if (!grip) return;
      grip.addEventListener("pointerdown", (e) => startItemDrag(e, wrap, all, tl));
    });
  }

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
              expandedItemId = (expandedItemId === it.id) ? null : it.id;
              if (expandedItemId === it.id) renderEditorView();
              else renderCardView();
            } },
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
          { type: "sep" },
          { label: "Delete event", glyph: "delete", danger: true,
            onClick: () => deleteItem(it) },
        ]);
      });
    }

    function timeCell(it) {
      const t = formatTimeRange(it.start_time, it.end_time) || formatTime(it.start_time) || "—";
      return el("div", { class: "vy-tl-time", text: t });
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
      if (it.status && it.status !== "planned") flagRow.appendChild(el("span", { class: "vy-conf", text: it.status.toUpperCase() }));
      if (flagRow.children.length) lhs.appendChild(flagRow);
      card.appendChild(lhs);

      const rhs = el("div", { class: "vy-tl-card-r" });
      const dur = computeDuration(it.start_time, it.end_time);
      if (dur) rhs.appendChild(el("span", { class: "vy-tl-card-dur", text: dur }));
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
      card.appendChild(rhs);
      // Drag grip — its own column on the far right. Mousedown handler
      // below toggles wrap.draggable so plain clicks elsewhere never
      // start a drag.
      if (!readOnly) {
        const grip = el("button", {
          class: "vy-tl-card-grip",
          title: "Drag to reorder",
          tabindex: "-1",
          onClick: (e) => e.stopPropagation(),
        },
          el("span", { class: "material-symbols-outlined", text: "drag_indicator" }),
        );
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

      const saveItem = debouncedSave(withSaveIndicator(ctx, async (patch) => {
        await items.update(it.id, patch);
        Object.assign(it, patch);
      }), 600);
      // `saveItemNow` is the closure-scope function lifted to the parent
      // timelineItem — re-renders the card on completion so toggled
      // type/status/flags refresh both the chip and the wrap classes.

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
        // Reorder is via the card grip / right-click menu — no ↑/↓
        // buttons in the editor row.
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

  // Only timed items participate. Anchor is the first timed item's
  // original start time.
  const timedOriginals = snapshot.filter((x) => parseT(x.start_time) != null);
  if (timedOriginals.length < 2) return [];
  const anchor = parseT(timedOriginals[0].start_time);

  // Positional gaps between consecutive timed originals.
  const gaps = [];
  for (let i = 0; i < timedOriginals.length - 1; i++) {
    const a = timedOriginals[i];
    const b = timedOriginals[i + 1];
    const aEnd = parseT(a.end_time) ?? parseT(a.start_time);
    const bStart = parseT(b.start_time);
    gaps.push((aEnd != null && bStart != null && bStart >= aEnd) ? bStart - aEnd : 0);
  }

  // Per-item original duration (end - start, or 0).
  const durById = new Map();
  for (const it of snapshot) {
    const s = parseT(it.start_time);
    const e = parseT(it.end_time);
    durById.set(it.id, s != null && e != null ? Math.max(0, e - s) : 0);
  }

  const origById = new Map(snapshot.map((x) => [x.id, x]));

  let cursor = anchor;
  let timedPos = 0;
  const updates = [];
  for (const it of newOrder) {
    const orig = origById.get(it.id);
    if (!orig || parseT(orig.start_time) == null) continue;

    const dur = durById.get(it.id) || 0;
    const newStart = cursor;
    const newEnd = newStart + dur;
    const newStartStr = fmtT(newStart);
    const newEndStr = dur > 0 ? fmtT(newEnd) : null;

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
