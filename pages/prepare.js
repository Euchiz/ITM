// Prepare page. Trip-level (day_id NULL) checklist grouped by category,
// with template seeding.

import { checklist } from "../supabase.js";
import { CHECKLIST_CATEGORIES } from "../io/schema.js";
import { TEMPLATES } from "../templates.js";
import { el, debouncedSave, autosize, withSaveIndicator, groupBy } from "./_utils.js";

const CATEGORY_LABELS = {
  booking: "Booking",
  document: "Documents",
  packing: "Packing",
  payment: "Payment",
  transportation: "Transportation",
  health: "Health",
  other: "Other",
};

export function renderPrepare(host, ctx) {
  const t = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const prep = (t.checklist_items || [])
    .filter((c) => !c.day_id)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  const total = prep.length;
  const done = prep.filter((c) => c.is_done).length;

  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: "Before you go" }),
      el("p", { class: "muted",
        text: total > 0
          ? `${done} / ${total} done. Group items by category — Documents, Booking, Packing, etc.`
          : "Add items you need to handle before leaving. Try a template to get started." }),
      !readOnly ? toolbar() : null,
    )
  );

  if (prep.length === 0 && !readOnly) {
    host.appendChild(emptyState());
    return;
  }

  const grouped = groupBy(prep, "category");
  for (const cat of CHECKLIST_CATEGORIES) {
    const list = grouped.get(cat) || [];
    if (list.length === 0) continue;
    host.appendChild(categorySection(cat, list));
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
    const wrap = el("section", { class: "card prep-cat" });
    wrap.append(
      el("h3", { class: "prep-cat-title", text: CATEGORY_LABELS[cat] || cat }),
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

    const cb = el("input", {
      type: "checkbox", class: "big-check",
      checked: c.is_done, disabled: readOnly,
    });
    cb.addEventListener("change", () => {
      c.is_done = cb.checked;
      row.classList.toggle("done", cb.checked);
      ctx.onSaveStart?.();
      checklist.update(c.id, { is_done: cb.checked })
        .catch((e) => alert("Save failed: " + e.message))
        .finally(() => ctx.onSaveDone?.());
    });
    row.classList.toggle("done", c.is_done);

    const txt = el("input", {
      type: "text", class: "check-text",
      value: c.text || "", placeholder: "What needs to be done?",
      disabled: readOnly,
    });
    txt.addEventListener("input", () => save({ text: txt.value }));

    const dueInput = el("input", {
      type: "date", value: c.due_date || "", title: "Due date",
      class: "due-date", disabled: readOnly,
    });
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
          class: "icon-btn danger",
          title: "Delete",
          onClick: async () => {
            if (!confirm("Delete this item?")) return;
            ctx.onSaveStart?.();
            try {
              await checklist.remove(c.id);
              await ctx.refresh();
            } catch (e) {
              alert("Delete failed: " + e.message);
            } finally {
              ctx.onSaveDone?.();
            }
          },
        }, "✕")
      );
    }

    if (c.notes) {
      const notes = el("input", {
        type: "text", class: "check-notes",
        value: c.notes, placeholder: "Notes",
        disabled: readOnly,
      });
      notes.addEventListener("input", () => save({ notes: notes.value }));
      row.appendChild(notes);
    }

    return row;
  }

  async function addItem(text = "", category = "other") {
    ctx.onSaveStart?.();
    try {
      await checklist.add(t.id, {
        day_id: null,
        text,
        category,
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
        await checklist.add(t.id, {
          day_id: null,
          text,
          category,
          sort_order: order++,
        });
      }
      await ctx.refresh();
    } catch (e) {
      alert("Template seed failed: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
  }
}
