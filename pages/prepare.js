// Prepare page (Plan mode). Trip-level (day_id NULL) checklist with
// a tag-chip filter row at the top — categories surface as Voyage-
// styled chips (DOCUMENTS, BOOKING, TRANSIT, …), and clicking one
// filters the list to that group.

import { checklist } from "../supabase.js";
import { CHECKLIST_CATEGORIES } from "../io/schema.js";
import { TEMPLATES } from "../templates.js";
import { el, debouncedSave, withSaveIndicator, groupBy } from "./_utils.js";

const CATEGORY_LABELS = {
  booking: "Booking",
  document: "Documents",
  packing: "Packing",
  payment: "Payment",
  transportation: "Transit",
  health: "Health",
  other: "Other",
};

// Each category maps onto a Voyage chip palette + glyph. Aligned with
// the item-type vocabulary in the design (STAYS/TRANSIT/DINING/…) so
// the visual language is consistent across Plan-mode pages.
const CATEGORY_VISUALS = {
  booking:        { chipClass: "stay",    glyph: "bookmark",       label: "BOOKING" },
  document:       { chipClass: "thing",   glyph: "description",    label: "DOCUMENTS" },
  packing:        { chipClass: "thing",   glyph: "luggage",        label: "PACKING" },
  payment:        { chipClass: "meal",    glyph: "payments",       label: "PAYMENT" },
  transportation: { chipClass: "transit", glyph: "directions_railway", label: "TRANSIT" },
  health:         { chipClass: "note",    glyph: "medication",     label: "HEALTH" },
  other:          { chipClass: "note",    glyph: "more_horiz",     label: "OTHER" },
};

const FILTER_STORAGE_KEY = "voyage:prepare-filter";

export function renderPrepare(host, ctx) {
  const t = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const prep = (t.checklist_items || [])
    .filter((c) => !c.day_id)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  const total = prep.length;
  const done = prep.filter((c) => c.is_done).length;

  // Read persisted filter (or default "all").
  let filter = readFilter();
  if (filter !== "all" && !CHECKLIST_CATEGORIES.includes(filter)) filter = "all";

  // ── Page head ───────────────────────────────────────────────────────
  host.appendChild(
    el("section", { class: "page-head vy-prep-head" },
      el("div", { class: "vy-prep-head-l" },
        el("h2", { text: "Prepare" }),
        el("p", { class: "muted",
          text: total > 0
            ? `${done} / ${total} done. Tag-filter to focus on a category — Booking, Transit, Packing, …`
            : "Tag-filter to focus on a category. Add items below or seed one of the templates." }),
      ),
      !readOnly ? toolbar() : null,
    )
  );

  // ── Filter chip row ─────────────────────────────────────────────────
  const counts = countByCategory(prep);
  const filterRow = el("div", { class: "vy-tagfilter" });
  filterRow.appendChild(makeChip("all", "All", { chipClass: "thing", glyph: "filter_list", label: "ALL" }, total));
  CHECKLIST_CATEGORIES.forEach((cat) => {
    filterRow.appendChild(makeChip(cat, CATEGORY_LABELS[cat] || cat, CATEGORY_VISUALS[cat], counts[cat] || 0));
  });
  host.appendChild(filterRow);

  if (prep.length === 0 && !readOnly) {
    host.appendChild(emptyState());
    return;
  }

  // ── Category sections (filtered) ─────────────────────────────────────
  const list = el("div", { class: "vy-prep-groups" });
  host.appendChild(list);
  renderList();

  function renderList() {
    list.innerHTML = "";
    const grouped = groupBy(prep, "category");
    const cats = filter === "all"
      ? CHECKLIST_CATEGORIES
      : [filter];
    let any = false;
    for (const cat of cats) {
      const items = grouped.get(cat) || [];
      if (!items.length) continue;
      any = true;
      list.appendChild(categorySection(cat, items));
    }
    if (!any) {
      list.appendChild(el("div", { class: "empty-state vy-prep-empty" },
        el("h3", { text: "Nothing in this category yet" }),
        el("p", { text: "Switch to All to see the rest, or add an item below." }),
      ));
    }
  }

  function makeChip(value, label, vis, count) {
    const v = vis || CATEGORY_VISUALS.other;
    const btn = el("button", {
      class: `vy-chip vy-chip--${v.chipClass} vy-chip--button ${value === filter ? "is-active" : ""}`,
      onClick: () => {
        filter = value;
        writeFilter(filter);
        filterRow.querySelectorAll("button").forEach((b) =>
          b.classList.toggle("is-active", b.dataset.v === filter));
        renderList();
      },
    },
      el("span", { class: "material-symbols-outlined", text: v.glyph }),
      el("span", { text: label.toUpperCase() }),
      count != null ? el("small", { text: count }) : null,
    );
    btn.dataset.v = value;
    return btn;
  }

  function toolbar() {
    return el("div", { class: "prepare-toolbar" },
      el("button", { class: "btn primary", onClick: () => addItem() }, "+ Add item"),
      el("div", { class: "template-picker" },
        el("label", { class: "muted small", text: "Add template:" }),
        ...TEMPLATES.map((tpl) =>
          el("button", { class: "btn ghost", onClick: () => seedTemplate(tpl) }, tpl.name)
        ),
      ),
    );
  }

  function emptyState() {
    return el("div", { class: "empty-state" },
      el("h3", { text: "No prep items yet" }),
      el("p", { text: "Add a single item or seed one of the templates above." }),
    );
  }

  function categorySection(cat, list) {
    const wrap = el("section", { class: "card prep-cat", "data-cat": cat });
    const v = CATEGORY_VISUALS[cat] || CATEGORY_VISUALS.other;
    wrap.append(
      el("div", { class: "vy-prep-cat-head" },
        el("span", { class: `vy-chip vy-chip--${v.chipClass}` },
          el("span", { class: "material-symbols-outlined", text: v.glyph }),
          el("span", { text: v.label }),
        ),
        el("span", { class: "vy-meta", text: `${list.filter((c) => c.is_done).length} / ${list.length} DONE` }),
      ),
    );
    list.forEach((c) => wrap.appendChild(itemRow(c)));
    return wrap;
  }

  function itemRow(c) {
    const save = debouncedSave(withSaveIndicator(ctx, async (patch) => {
      await checklist.update(c.id, patch);
      Object.assign(c, patch);
    }), 500);

    const row = el("div", { class: "check-row" });

    const cb = el("input", { type: "checkbox", class: "big-check",
      checked: c.is_done, disabled: readOnly });
    cb.addEventListener("change", () => {
      c.is_done = cb.checked;
      row.classList.toggle("done", cb.checked);
      ctx.onSaveStart?.();
      checklist.update(c.id, { is_done: cb.checked })
        .catch((e) => alert("Save failed: " + e.message))
        .finally(() => ctx.onSaveDone?.());
    });
    row.classList.toggle("done", c.is_done);

    const txt = el("input", { type: "text", class: "check-text",
      value: c.text || "", placeholder: "What needs to be done?",
      disabled: readOnly });
    txt.addEventListener("input", () => save({ text: txt.value }));

    const dueInput = el("input", { type: "date", value: c.due_date || "",
      title: "Due date", class: "due-date", disabled: readOnly });
    dueInput.addEventListener("input", () => save({ due_date: dueInput.value || null }));

    const catSelect = el("select", { class: "cat-select", disabled: readOnly });
    CHECKLIST_CATEGORIES.forEach((opt) => {
      const o = el("option", { value: opt, text: CATEGORY_LABELS[opt] || opt });
      if (opt === c.category) o.selected = true;
      catSelect.appendChild(o);
    });
    catSelect.addEventListener("change", async () => {
      ctx.onSaveStart?.();
      try {
        await checklist.update(c.id, { category: catSelect.value });
        await ctx.refresh(); // re-group by category
      } catch (e) {
        alert("Save failed: " + e.message);
      } finally {
        ctx.onSaveDone?.();
      }
    });

    row.append(cb, txt, dueInput, catSelect);

    if (!readOnly) {
      row.appendChild(
        el("button", {
          class: "icon-btn danger", title: "Delete",
          onClick: async () => {
            if (!confirm("Delete this item?")) return;
            ctx.onSaveStart?.();
            try {
              await checklist.remove(c.id);
              await ctx.refresh();
            } catch (e) { alert("Delete failed: " + e.message); }
            finally { ctx.onSaveDone?.(); }
          },
        }, "✕")
      );
    }

    if (c.notes) {
      const notes = el("input", { type: "text", class: "check-notes",
        value: c.notes, placeholder: "Notes", disabled: readOnly });
      notes.addEventListener("input", () => save({ notes: notes.value }));
      row.appendChild(notes);
    }
    return row;
  }

  async function addItem(text = "", category = "other") {
    ctx.onSaveStart?.();
    try {
      await checklist.add(t.id, {
        day_id: null, text, category,
        sort_order: prep.length,
      });
      await ctx.refresh();
    } catch (e) {
      alert("Could not add item: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
  }

  async function seedTemplate(tpl) {
    if (!confirm(`Add ${tpl.items.length} items from "${tpl.name}" template?`)) return;
    ctx.onSaveStart?.();
    try {
      let order = prep.length;
      for (const [text, category] of tpl.items) {
        await checklist.add(t.id, { day_id: null, text, category, sort_order: order++ });
      }
      await ctx.refresh();
    } catch (e) {
      alert("Template seed failed: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
  }
}

function countByCategory(items) {
  const out = {};
  for (const c of items) out[c.category] = (out[c.category] || 0) + 1;
  return out;
}

function readFilter() {
  try { return localStorage.getItem(FILTER_STORAGE_KEY) || "all"; } catch { return "all"; }
}
function writeFilter(v) {
  try { localStorage.setItem(FILTER_STORAGE_KEY, v); } catch {}
}
