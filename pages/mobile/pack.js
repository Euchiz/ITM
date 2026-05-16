// Mobile · Overview · Pack — trip-wide pack checklist.
//
// Simple per-trip list of physical items to bring (passport, adapter,
// business cards). Each row: checkbox + title (inline-editable) +
// delete. Sweep buttons at top: Mark all packed / Clear all.
//
// Preset dropdown bulk-inserts common pack lists ("International
// travel", "Business trip", etc.). The schema supports per-event
// tagging for the Today reminder box, but the v1 tagging UI is
// deferred — `packItems.setTaggedItems` is wired and ready.

import { packItems } from "../../supabase.js";
import { el } from "../_utils.js";
import { t, plural } from "../../i18n/locale.js";

// Preset entries. Labels and item titles resolve via t() at render
// time so a locale switch retranslates the dropdown — item titles are
// translated at insert time and stored as user content from then on.
const PRESETS = [
  {
    id: "international",
    labelKey: "mobile.pack.preset.international",
    items: ["Passport", "Visa", "Travel insurance card",
            "Vaccination certificate", "Foreign currency / debit card",
            "Power adapter", "Driver's license (international)"],
  },
  {
    id: "business",
    labelKey: "mobile.pack.preset.business",
    items: ["Business cards", "Laptop + charger", "Presentation materials",
            "Receipts envelope", "ID badge"],
  },
  {
    id: "scholar",
    labelKey: "mobile.pack.preset.scholar",
    items: ["Visa", "University ID", "Invitation letter",
            "CV / publications", "Conference badge"],
  },
  {
    id: "weekend",
    labelKey: "mobile.pack.preset.weekend",
    items: ["ID", "Hotel confirmation", "Tickets"],
  },
];

export function renderMobilePack(host, ctx) {
  const trip = ctx.trip;
  if (!trip) {
    host.innerHTML = "";
    host.appendChild(el("p", { class: "muted small", text: t("mobile.pack.noTrip") }));
    return;
  }
  host.innerHTML = "";

  const packs = trip.pack_items || [];
  const packedCount = packs.filter((p) => p.packed).length;
  const totalCount = packs.length;

  host.appendChild(renderSummary(ctx, packedCount, totalCount));
  host.appendChild(renderAddRow(ctx));

  if (packs.length === 0) {
    host.appendChild(emptyState());
    return;
  }
  const list = el("section", { class: "vy-mobile-pack-list card" });
  for (const p of packs) list.appendChild(renderRow(ctx, p));
  host.appendChild(list);
}

function renderSummary(ctx, packed, total) {
  const wrap = el("section", { class: "vy-mobile-pack-summary card" });

  wrap.appendChild(el("div", { class: "vy-mobile-pack-summary-stat" },
    el("span", { class: "vy-mobile-pack-summary-big",
      text: total === 0 ? "0" : `${packed}` }),
    el("span", { class: "vy-mobile-pack-summary-of",
      text: total === 0 ? "" : ` / ${total}` }),
    el("span", { class: "vy-mobile-pack-summary-label",
      text: total === 0 ? t("mobile.pack.noItemsYet") : t("mobile.pack.packedLabel") }),
  ));

  if (total > 0) {
    wrap.appendChild(el("div", { class: "vy-mobile-pack-summary-actions" },
      el("button", {
        class: "btn ghost small",
        disabled: packed === total,
        onClick: async () => sweepAll(ctx, true),
      }, t("mobile.pack.markAll")),
      el("button", {
        class: "btn ghost small",
        disabled: packed === 0,
        onClick: async () => sweepAll(ctx, false),
      }, t("mobile.pack.clearAll")),
    ));
  }
  return wrap;
}

async function sweepAll(ctx, packed) {
  ctx.onSaveStart?.();
  try {
    await packItems.markAll(ctx.trip.id, packed);
    (ctx.trip.pack_items || []).forEach((p) => { p.packed = packed; });
    ctx.rerender?.();
  } catch (e) {
    ctx.toast?.(t("mobile.pack.updateFailed", { error: e.message || e }), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

function renderAddRow(ctx) {
  const wrap = el("section", { class: "vy-mobile-pack-add card" });

  const inputRow = el("form", {
    class: "vy-mobile-pack-add-input",
    onSubmit: async (e) => {
      e.preventDefault();
      const input = e.target.querySelector("input");
      const title = input.value.trim();
      if (!title) return;
      input.value = "";
      await addOne(ctx, title);
    },
  });
  inputRow.appendChild(el("input", {
    type: "text", placeholder: t("mobile.pack.addPlaceholder"), maxlength: "80",
  }));
  inputRow.appendChild(el("button", {
    type: "submit",
    class: "vy-mobile-pack-add-btn",
    title: t("mobile.pack.addBtn"),
  }, el("span", { class: "material-symbols-outlined", text: "add" })));
  wrap.appendChild(inputRow);

  const presetLabel = el("label", { class: "vy-mobile-pack-preset" });
  presetLabel.appendChild(el("span", { class: "vy-mobile-pack-preset-label",
    text: t("mobile.pack.fromPreset") }));
  const select = el("select", { class: "vy-mobile-pack-preset-select" });
  select.appendChild(el("option", { value: "", text: t("mobile.pack.pickPreset") }));
  for (const p of PRESETS) {
    select.appendChild(el("option", { value: p.id, text: t(p.labelKey) }));
  }
  select.addEventListener("change", async (e) => {
    const id = e.target.value;
    if (!id) return;
    const preset = PRESETS.find((p) => p.id === id);
    e.target.value = "";
    if (preset) await addPreset(ctx, preset);
  });
  presetLabel.appendChild(select);
  wrap.appendChild(presetLabel);

  return wrap;
}

async function addOne(ctx, title) {
  ctx.onSaveStart?.();
  try {
    const existing = ctx.trip.pack_items || [];
    const next = await packItems.add(ctx.trip.id, {
      title, sort_order: existing.length,
    });
    next.tagged_item_ids = [];
    existing.push(next);
    ctx.trip.pack_items = existing;
    ctx.rerender?.();
  } catch (e) {
    ctx.toast?.(t("mobile.pack.addFailed", { error: e.message || e }), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

async function addPreset(ctx, preset) {
  ctx.onSaveStart?.();
  try {
    const inserted = await packItems.addMany(ctx.trip.id, preset.items);
    if (inserted.length === 0) {
      ctx.toast?.(t("mobile.pack.presetAllExisting"));
    } else {
      ctx.toast?.(plural("mobile.pack.presetAdded", inserted.length,
        { n: inserted.length, preset: t(preset.labelKey) }));
    }
    ctx.trip.pack_items = await packItems.list(ctx.trip.id);
    ctx.rerender?.();
  } catch (e) {
    ctx.toast?.(t("mobile.pack.presetFailed", { error: e.message || e }), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

function renderRow(ctx, p) {
  const row = el("div", { class: `vy-mobile-pack-row ${p.packed ? "is-packed" : ""}`.trim() });

  row.appendChild(el("button", {
    class: "vy-mobile-pack-row-check",
    onClick: () => togglePacked(ctx, p),
    "aria-label": p.packed ? t("mobile.pack.markUnpacked") : t("mobile.pack.markPacked"),
  },
    el("span", { class: "material-symbols-outlined",
      text: p.packed ? "check_box" : "check_box_outline_blank" }),
  ));

  const title = el("input", {
    type: "text",
    class: "vy-mobile-pack-row-title",
    value: p.title,
    maxlength: "80",
  });
  title.addEventListener("blur", async () => {
    const next = title.value.trim();
    if (next && next !== p.title) await updateTitle(ctx, p, next);
    else if (!next) title.value = p.title;
  });
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); title.blur(); }
    if (e.key === "Escape") { title.value = p.title; title.blur(); }
  });
  row.appendChild(title);

  if ((p.tagged_item_ids || []).length > 0) {
    const n = p.tagged_item_ids.length;
    row.appendChild(el("span", { class: "vy-mobile-pack-row-tagged",
      text: `${n}`,
      title: plural("mobile.pack.taggedTooltip", n, { n }) }));
  }

  row.appendChild(el("button", {
    class: "vy-mobile-pack-row-del",
    onClick: () => deleteRow(ctx, p),
    "aria-label": t("mobile.pack.deleteTooltip"),
  },
    el("span", { class: "material-symbols-outlined", text: "delete_outline" }),
  ));

  return row;
}

async function togglePacked(ctx, p) {
  const next = !p.packed;
  p.packed = next;
  ctx.rerender?.();
  try {
    await packItems.update(p.id, { packed: next });
  } catch (e) {
    p.packed = !next;
    ctx.rerender?.();
    ctx.toast?.(t("mobile.pack.updateFailed", { error: e.message || e }), true);
  }
}

async function updateTitle(ctx, p, newTitle) {
  ctx.onSaveStart?.();
  try {
    await packItems.update(p.id, { title: newTitle });
    p.title = newTitle;
  } catch (e) {
    ctx.toast?.(t("mobile.pack.renameFailed", { error: e.message || e }), true);
  } finally {
    ctx.onSaveDone?.();
  }
}

async function deleteRow(ctx, p) {
  if (!confirm(t("mobile.pack.confirmDelete", { title: p.title }))) return;
  try {
    await packItems.remove(p.id);
    ctx.trip.pack_items = (ctx.trip.pack_items || []).filter((x) => x.id !== p.id);
    ctx.rerender?.();
  } catch (e) {
    ctx.toast?.(t("mobile.pack.deleteFailed", { error: e.message || e }), true);
  }
}

function emptyState() {
  return el("section", { class: "vy-mobile-edge card" },
    el("span", { class: "material-symbols-outlined", text: "luggage" }),
    el("h2", { text: t("mobile.pack.empty.title") }),
    el("p", { class: "muted", text: t("mobile.pack.empty.body") }),
  );
}
