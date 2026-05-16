// Prepare page (Plan mode). Trip-level (day_id NULL) checklist with
// a tag-chip filter row at the top — categories surface as Voyage-
// styled chips (DOCUMENTS, BOOKING, TRANSIT, …), and clicking one
// filters the list to that group.

import { checklist } from "../supabase.js";
import { CHECKLIST_CATEGORIES } from "../io/schema.js";
import { TEMPLATES } from "../templates.js";
import {
  el, debouncedSave, withSaveIndicator, groupBy,
  formatRelativeTime, memberName,
} from "./_utils.js";
import { t } from "../i18n/locale.js";

const CATEGORY_LABEL_KEYS = {
  booking: "prepare.category.bookingShort",
  document: "prepare.category.documentShort",
  packing: "prepare.category.packingShort",
  payment: "prepare.category.paymentShort",
  transportation: "prepare.category.transportationShort",
  health: "prepare.category.healthShort",
  other: "prepare.category.otherShort",
};

// Each category gets its own hue so the filter row visually ranks them
// by importance. Caps label resolves through t() at render time so
// switching locale relabels the chip without re-renaming the category.
const CATEGORY_VISUALS = {
  document:       { chipClass: "doc",           glyph: "description",        labelKey: "prepare.category.documentCaps" },
  booking:        { chipClass: "booking",       glyph: "bookmark",           labelKey: "prepare.category.bookingCaps" },
  payment:        { chipClass: "payment",       glyph: "payments",           labelKey: "prepare.category.paymentCaps" },
  transportation: { chipClass: "transport-cat", glyph: "directions_railway", labelKey: "prepare.category.transportationCaps" },
  health:         { chipClass: "health",        glyph: "medication",         labelKey: "prepare.category.healthCaps" },
  packing:        { chipClass: "packing",       glyph: "luggage",            labelKey: "prepare.category.packingCaps" },
  other:          { chipClass: "other",         glyph: "more_horiz",         labelKey: "prepare.category.otherCaps" },
};

const FILTER_STORAGE_KEY = "voyage:prepare-filter";

export function renderPrepare(host, ctx) {
  const trip = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const prep = (trip.checklist_items || [])
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
        el("h2", { text: t("prepare.title") }),
        el("p", { class: "muted",
          text: total > 0
            ? t("prepare.head.statusWithItems", { done, total })
            : t("prepare.head.statusEmpty") }),
      ),
      !readOnly ? toolbar() : null,
    )
  );

  // ── Filter chip row ─────────────────────────────────────────────────
  const counts = countByCategory(prep);
  const filterRow = el("div", { class: "vy-tagfilter" });
  filterRow.appendChild(makeChip(
    "all",
    t("prepare.filter.allLabel"),
    { chipClass: "thing", glyph: "filter_list", labelKey: "prepare.filter.allCaps" },
    total,
  ));
  CHECKLIST_CATEGORIES.forEach((cat) => {
    const shortLabel = t(CATEGORY_LABEL_KEYS[cat]) || cat;
    filterRow.appendChild(makeChip(cat, shortLabel, CATEGORY_VISUALS[cat], counts[cat] || 0));
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
        el("h3", { text: t("prepare.empty.category.title") }),
        el("p", { text: t("prepare.empty.category.body") }),
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
      el("span", { text: String(label).toUpperCase() }),
      count != null ? el("small", { text: count }) : null,
    );
    btn.dataset.v = value;
    return btn;
  }

  function toolbar() {
    return el("div", { class: "prepare-toolbar" },
      el("button", { class: "btn primary", onClick: () => addItem() }, t("prepare.addItem")),
      el("div", { class: "template-picker" },
        el("label", { class: "muted small", text: t("prepare.addTemplate") }),
        ...TEMPLATES.map((tpl) =>
          el("button", { class: "btn ghost", onClick: () => seedTemplate(tpl) },
            templateName(tpl))
        ),
      ),
    );
  }

  function emptyState() {
    return el("div", { class: "empty-state" },
      el("h3", { text: t("prepare.empty.none.title") }),
      el("p", { text: t("prepare.empty.none.body") }),
    );
  }

  function categorySection(cat, items) {
    const wrap = el("section", { class: "card prep-cat", "data-cat": cat });
    const v = CATEGORY_VISUALS[cat] || CATEGORY_VISUALS.other;
    wrap.append(
      el("div", { class: "vy-prep-cat-head" },
        el("span", { class: `vy-chip vy-chip--${v.chipClass}` },
          el("span", { class: "material-symbols-outlined", text: v.glyph }),
          el("span", { text: t(v.labelKey) }),
        ),
        el("span", { class: "vy-meta", text: t("prepare.categoryHead.doneRatio", {
          done: items.filter((c) => c.is_done).length,
          total: items.length,
        }) }),
      ),
    );
    items.forEach((c) => wrap.appendChild(itemRow(c)));
    return wrap;
  }

  function itemRow(c) {
    const save = debouncedSave(withSaveIndicator(ctx, async (patch) => {
      await checklist.update(c.id, patch);
      Object.assign(c, patch);
    }), 500);

    // Attribution as a row-level tooltip — visible on hover without
    // adding inline clutter to the dense single-line layout.
    const author = memberName(ctx.membersById, c.created_by);
    const when = formatRelativeTime(c.created_at);
    const rowAttrs = { class: "check-row" };
    if (author) {
      rowAttrs.title = when
        ? t("prepare.addedByWithWhen", { who: author, when })
        : t("prepare.addedBy", { who: author });
    }
    const row = el("div", rowAttrs);

    const cb = el("input", { type: "checkbox", class: "big-check",
      checked: c.is_done, disabled: readOnly });
    cb.addEventListener("change", () => {
      c.is_done = cb.checked;
      row.classList.toggle("done", cb.checked);
      ctx.onSaveStart?.();
      checklist.update(c.id, { is_done: cb.checked })
        .catch((e) => alert(t("prepare.row.saveFailed", { error: e.message })))
        .finally(() => ctx.onSaveDone?.());
    });
    row.classList.toggle("done", c.is_done);

    const txt = el("input", { type: "text", class: "check-text",
      value: c.text || "", placeholder: t("prepare.row.placeholder"),
      disabled: readOnly });
    txt.addEventListener("input", () => save({ text: txt.value }));

    // Compact due-date widget: a "mm/dd" label sitting over an
    // invisible <input type="date"> so tapping the label opens the
    // native picker but the visible footprint is just 4 chars wide.
    // The browser's default date-input rendering ("MM/DD/YYYY") was
    // eating ~110px on every prepare row, crowding the text column on
    // narrow viewports. The full date (with year) is exposed via the
    // wrapper's title attribute for hover/screen-reader contexts.
    const dueWrap = el("label", { class: "due-date-wrap",
      title: c.due_date || t("prepare.row.dueDateTip") });
    const dueLabel = el("span", { class: "due-date-display" });
    const dueInput = el("input", { type: "date", value: c.due_date || "",
      class: "due-date due-date-native", disabled: readOnly });
    function paintDueLabel() {
      if (!dueInput.value) { dueLabel.textContent = "—"; dueLabel.classList.add("is-empty"); }
      else {
        const m = dueInput.value.slice(5, 7);
        const d = dueInput.value.slice(8, 10);
        dueLabel.textContent = `${m}/${d}`;
        dueLabel.classList.remove("is-empty");
        dueWrap.title = dueInput.value;
      }
    }
    paintDueLabel();
    dueInput.addEventListener("input", () => {
      paintDueLabel();
      save({ due_date: dueInput.value || null });
    });
    dueWrap.append(dueLabel, dueInput);

    const catSelect = el("select", { class: "cat-select", disabled: readOnly });
    CHECKLIST_CATEGORIES.forEach((opt) => {
      const o = el("option", { value: opt, text: t(CATEGORY_LABEL_KEYS[opt]) || opt });
      if (opt === c.category) o.selected = true;
      catSelect.appendChild(o);
    });
    catSelect.addEventListener("change", async () => {
      ctx.onSaveStart?.();
      try {
        await checklist.update(c.id, { category: catSelect.value });
        await ctx.refresh(); // re-group by category
      } catch (e) {
        alert(t("prepare.row.saveFailed", { error: e.message }));
      } finally {
        ctx.onSaveDone?.();
      }
    });

    row.append(cb, txt, dueWrap, catSelect);

    if (!readOnly) {
      row.appendChild(
        el("button", {
          class: "icon-btn danger", title: t("prepare.row.deleteTip"),
          onClick: async () => {
            if (!confirm(t("prepare.row.confirmDelete"))) return;
            ctx.onSaveStart?.();
            try {
              await checklist.remove(c.id);
              await ctx.refresh();
            } catch (e) { alert(t("prepare.row.deleteFailed", { error: e.message })); }
            finally { ctx.onSaveDone?.(); }
          },
        }, "✕")
      );
    }

    if (c.notes) {
      const notes = el("input", { type: "text", class: "check-notes",
        value: c.notes, placeholder: t("prepare.row.notesPlaceholder"), disabled: readOnly });
      notes.addEventListener("input", () => save({ notes: notes.value }));
      row.appendChild(notes);
    }
    return row;
  }

  async function addItem(text = "", category = "other") {
    ctx.onSaveStart?.();
    try {
      await checklist.add(trip.id, {
        day_id: null, text, category,
        sort_order: prep.length,
      });
      await ctx.refresh();
    } catch (e) {
      alert(t("prepare.addFailed", { error: e.message }));
    } finally {
      ctx.onSaveDone?.();
    }
  }

  async function seedTemplate(tpl) {
    const name = templateName(tpl);
    if (!confirm(t("prepare.tplConfirm", { n: tpl.items.length, name }))) return;
    ctx.onSaveStart?.();
    try {
      let order = prep.length;
      for (const [text, category] of tpl.items) {
        await checklist.add(trip.id, { day_id: null, text: translateTemplateItem(text), category, sort_order: order++ });
      }
      await ctx.refresh();
    } catch (e) {
      alert(t("prepare.tplFailed", { error: e.message }));
    } finally {
      ctx.onSaveDone?.();
    }
  }
}

// Look up the localized template name (from templates.js display table).
// Falls back to the English name embedded in TEMPLATES if not translated.
function templateName(tpl) {
  const key = TEMPLATE_NAME_KEY[tpl.name] || null;
  if (!key) return tpl.name;
  const translated = t(key);
  return translated === key ? tpl.name : translated;
}

// Translate template item label at insert time. The stored value
// becomes user content from then on — switching locale later doesn't
// retroactively rewrite previously-inserted items.
function translateTemplateItem(en) {
  const key = TEMPLATE_ITEM_KEY[en];
  if (!key) return en;
  const translated = t(key);
  return translated === key ? en : translated;
}

const TEMPLATE_NAME_KEY = {
  "Basic travel": "templates.name.basicTravel",
  "International": "templates.name.international",
  "Road trip": "templates.name.roadTrip",
  "Family": "templates.name.family",
};

// Stable English-token → key map for individual template items. Each
// translatable item has a matching entry in i18n/templates/<locale>.js
// keyed by the same dotted path. If a locale omits a key, t() returns
// the key unchanged and we fall back to the English text above.
const TEMPLATE_ITEM_KEY = {
  "Passport / ID": "templates.item.passportId",
  "Wallet": "templates.item.wallet",
  "Phone charger": "templates.item.phoneCharger",
  "Power bank": "templates.item.powerBank",
  "Medicine": "templates.item.medicine",
  "Umbrella": "templates.item.umbrella",
  "Comfortable shoes": "templates.item.comfortableShoes",
  "Hotel address saved": "templates.item.hotelAddress",
  "Emergency contact saved": "templates.item.emergencyContact",
  "Passport": "templates.item.passport",
  "Visa / entry permit": "templates.item.visa",
  "Travel insurance": "templates.item.travelInsurance",
  "SIM card / roaming": "templates.item.simRoaming",
  "Currency exchange": "templates.item.currencyExchange",
  "Power adapter": "templates.item.powerAdapter",
  "Customs declaration": "templates.item.customs",
  "Flight check-in": "templates.item.flightCheckin",
  "Hotel confirmation note": "templates.item.hotelConfirmation",
  "Driver's license": "templates.item.driversLicense",
  "Car rental confirmation": "templates.item.carRental",
  "Gas plan": "templates.item.gasPlan",
  "Parking notes": "templates.item.parkingNotes",
  "Snacks": "templates.item.snacks",
  "Water": "templates.item.water",
  "Offline map": "templates.item.offlineMap",
  "Emergency kit": "templates.item.emergencyKit",
  "Passports / IDs for everyone": "templates.item.passportsAll",
  "Rest breaks planned": "templates.item.restBreaks",
  "Hotel check-in note": "templates.item.hotelCheckin",
  "Emergency contacts": "templates.item.emergencyContacts",
  "Shared itinerary link": "templates.item.sharedItinerary",
};

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
