// Budget page (Plan mode) — the dedicated cost-entry surface.
//
// Two top-level modes: EDIT (per-item proposed amounts, tags, custom
// splits) and BREAKDOWN (donut + bar list, ships in a later commit).
// State persists in localStorage so users land back in their preferred
// mode on next visit.
//
// EDIT mode is grouped by day with day headers. Each row exposes a
// compact set of inputs (proposed amount, tag, custom-split disclosure)
// that all save through the existing debouncedSave pattern — local
// state.trip mutates instantly, the DB write fires 700ms behind.

import { itemCosts } from "../supabase.js";
import {
  el, debouncedSave, withSaveIndicator, formatMoney,
  parseAmountToCents, centsToAmountText, currencyMinorUnits,
} from "./_utils.js";
import { TYPE_VISUALS } from "./itinerary.js";
import { ITEM_TYPES } from "../io/schema.js";
import { renderFuelBar, renderFuelPill } from "./_components/fuel-bar.js";
import { renderBreakdown } from "./_components/breakdown-view.js";

const VIEW_KEY     = "voyage:budget-view";
const GROUP_KEY    = "voyage:budget-edit-group";
const FILTER_KEY   = "voyage:budget-filter";
const VIEW_OPTIONS  = ["edit", "breakdown"];
const GROUP_OPTIONS = ["day", "category"];

// Filter modes — used by the dropdown next to the group toggle.
// "review" = unassigned + guessing (everything that still needs a
// human decision on the cost). The other options narrow further.
const FILTER_OPTIONS = [
  { value: "all",        label: "All items" },
  { value: "unassigned", label: "Unassigned only" },
  { value: "guessing",   label: "Guessing only" },
  { value: "review",     label: "Needs review · unassigned + guessing" },
];

// Tag picker entries. NULL = "unassigned" — the default for items that
// haven't been considered yet; surfaced by the filter dropdown.
const TAG_OPTIONS = [
  { value: "",         label: "Unassigned" },  // empty-string in <option>, mapped to null on save
  { value: "n_a",      label: "N/A · free"     },
  { value: "guessing", label: "Guessing"       },
  { value: "approx",   label: "Approx"         },
  { value: "actual",   label: "Actual"         },
];

export function renderBudget(host, ctx) {
  const trip = ctx.trip || {};
  const readOnly = ctx.role === "viewer";
  const view = readView();
  let filterMode = readFilter();
  let groupBy = readGroup();

  // Two-column layout: main content + persistent fuel rail. The rail
  // hides on narrow viewports via CSS; a compact pill in the page-head
  // takes its place so the gauge is still glanceable on mobile.
  host.innerHTML = "";
  const layout = el("div", { class: "vy-budget-layout" });
  const main = el("div", { class: "vy-budget-main" });
  const rail = el("aside", { class: "vy-budget-rail", "aria-label": "Budget gauge" });
  layout.append(main, rail);
  host.appendChild(layout);
  renderFuelBar(rail, ctx);
  // Re-renders the rail in-place after any cost change. Sub-frame fast.
  const refreshFuelBar = () => renderFuelBar(rail, ctx);

  // ── Page head ─────────────────────────────────────────────────────
  const head = el("section", { class: "page-head vy-budget-head" },
    el("div", { class: "vy-budget-head-l" },
      el("h2", { text: "Budget" }),
      el("p", { class: "muted", text: view === "edit"
        ? "Enter the proposed cost for each event. Add a tag to track confidence. " +
          "Custom-split is optional — by default events are split evenly across travelers at view time."
        : "Trip-wide breakdown of proposed vs actual spending. Donut and bar list ship soon." }),
    ),
    // Render the edit-only controls FIRST and the view toggle LAST so
    // the view toggle stays pinned to the right edge regardless of
    // whether group/filter are visible. Otherwise the toggle would
    // "jump" to fill the freed space when flipping into Breakdown.
    el("div", { class: "vy-budget-head-r" },
      view === "edit" ? groupToggle() : null,
      view === "edit" ? filterSelectEl() : null,
      viewToggle(),
    ),
  );
  main.appendChild(head);

  // Mobile pill — appears in the page-head when CSS hides the rail.
  const pillSlot = el("div", { class: "vy-budget-head-pill" });
  renderFuelPill(pillSlot, ctx);
  main.appendChild(pillSlot);

  // ── Body ──────────────────────────────────────────────────────────
  if (view === "breakdown") {
    const bdHost = el("div", { class: "vy-budget-breakdown" });
    main.appendChild(bdHost);
    renderBreakdown(bdHost, {
      trip,
      donutMode: "proposed",          // Plan-mode → proposed proportions
      includeUnplanned: false,        // Unplanned items live in Costs mode
    });
    return;
  }
  main.appendChild(renderEditMode());

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
          ctx.rerender?.();
        },
      }, v[0].toUpperCase() + v.slice(1));
      btn.dataset.v = v;
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function groupToggle() {
    const wrap = el("div", { class: "vy-view-toggle vy-budget-group-toggle", role: "tablist" });
    GROUP_OPTIONS.forEach((v) => {
      const btn = el("button", {
        class: v === groupBy ? "is-active" : "",
        role: "tab",
        onClick: () => {
          if (v === groupBy) return;
          writeGroup(v);
          ctx.rerender?.();
        },
      }, "By " + v);
      btn.dataset.v = v;
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function filterSelectEl() {
    const lbl = el("label", { class: "vy-budget-filter" });
    lbl.appendChild(el("span", { class: "vy-budget-filter-label", text: "Filter" }));
    const sel = el("select", { class: "vy-budget-filter-select" });
    FILTER_OPTIONS.forEach((opt) => {
      const o = el("option", { value: opt.value, text: opt.label });
      if (opt.value === filterMode) o.setAttribute("selected", "");
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => {
      filterMode = sel.value;
      writeFilter(filterMode);
      applyFilter(host);
    });
    lbl.appendChild(sel);
    return lbl;
  }

  function renderEditMode() {
    const wrap = el("div", { class: "vy-budget-edit" });

    if (!trip.days?.length) {
      wrap.appendChild(el("div", { class: "empty-state" },
        el("h3", { text: "No items yet" }),
        el("p", { text: "Add events on Itinerary first, then come back to assign costs." }),
        el("div", { class: "actions" },
          el("button", { class: "btn", onClick: () => ctx.navigate?.({ page: "itinerary" }) },
            "Go to Itinerary →"),
        ),
      ));
      return wrap;
    }

    // Flatten + bucket items per the active groupBy. is_unplanned items
    // belong to Costs page; keep Budget Edit planning-focused.
    const flat = [];
    trip.days.forEach((day, di) => {
      (day.items || []).forEach((it) => {
        if (it.is_unplanned) return;
        flat.push({ item: it, day, dayIdx: di });
      });
    });

    if (flat.length === 0) {
      wrap.appendChild(el("div", { class: "empty-state" },
        el("h3", { text: "No planned items" }),
        el("p", { text: "Once you add events on the Itinerary, they'll appear here for cost entry." }),
      ));
      return wrap;
    }

    if (groupBy === "category") {
      // Bucket by item type, ITEM_TYPES order — predictable, stable.
      const buckets = new Map();
      for (const type of ITEM_TYPES) buckets.set(type, []);
      for (const entry of flat) {
        const key = ITEM_TYPES.includes(entry.item.type) ? entry.item.type : "activity";
        buckets.get(key).push(entry);
      }
      ITEM_TYPES.forEach((type) => {
        const entries = buckets.get(type);
        if (entries.length === 0) return;
        wrap.appendChild(categoryGroup(type, entries));
      });
    } else {
      trip.days.forEach((day, di) => {
        const items = (day.items || []).filter((it) => !it.is_unplanned);
        if (items.length === 0) return;
        wrap.appendChild(dayGroup(day, di, items));
      });
    }

    return wrap;
  }

  function dayGroup(day, di, items) {
    const dateLabel = day.date
      ? new Date(day.date + "T00:00:00").toLocaleDateString(undefined,
          { weekday: "short", month: "short", day: "numeric" })
      : "Set date";
    const heading = `Day ${di + 1} · ${dateLabel}${day.city ? " · " + day.city : ""}`;

    const group = el("section", { class: "vy-budget-day card" });
    group.appendChild(el("header", { class: "vy-budget-day-head" },
      el("span", { class: "vy-meta", text: heading.toUpperCase() }),
      el("span", { class: "muted small", text: `${items.length} item${items.length === 1 ? "" : "s"}` }),
    ));
    const list = el("div", { class: "vy-budget-day-list" });
    items.forEach((it) => list.appendChild(budgetRow(it, day, di)));
    group.appendChild(list);
    return group;
  }

  function categoryGroup(type, entries) {
    const v = TYPE_VISUALS[type] || TYPE_VISUALS.activity;
    const group = el("section", { class: "vy-budget-day card" });
    group.appendChild(el("header", { class: "vy-budget-day-head" },
      el("span", { class: `vy-chip vy-chip--${v.chipClass}` },
        el("span", { class: "material-symbols-outlined", text: v.glyph }),
        el("span", { text: v.label }),
      ),
      el("span", { class: "muted small", text: `${entries.length} item${entries.length === 1 ? "" : "s"}` }),
    ));
    const list = el("div", { class: "vy-budget-day-list" });
    entries.forEach(({ item, day, dayIdx }) => list.appendChild(budgetRow(item, day, dayIdx)));
    group.appendChild(list);
    return group;
  }

  function budgetRow(it, day, di) {
    const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
    const currency = (it.currency || trip.default_currency || "USD").toUpperCase();
    const isOverride = !!it.currency && it.currency.toUpperCase() !== (trip.default_currency || "USD").toUpperCase();
    const hasShares = (it.shares || []).length > 0;
    const memberCount = Math.max(1, (trip.members || []).length || 1);

    const row = el("div", {
      class: "vy-budget-row",
      "data-item-id": it.id,
      "data-tag": it.cost_tag || "",
    });

    // Chip + title block (read-only here; edit on Itinerary)
    row.appendChild(el("div", { class: "vy-budget-row-main" },
      el("span", { class: `vy-chip vy-chip--${v.chipClass}` },
        el("span", { class: "material-symbols-outlined", text: v.glyph }),
        el("span", { text: v.label }),
      ),
      el("span", { class: "vy-budget-row-title", text: it.title || "(untitled)" }),
    ));

    // Inputs cluster
    const inputs = el("div", { class: "vy-budget-row-inputs" });

    // Proposed amount input — debounced save to the items column.
    const amountWrap = el("label", { class: "vy-budget-amount" });
    const symbolEl = el("span", { class: "vy-budget-amount-sym", text: currencySymbol(currency) });
    if (isOverride) symbolEl.classList.add("is-override");
    amountWrap.appendChild(symbolEl);
    const amountInput = el("input", {
      type: "text",
      inputmode: "decimal",
      class: "vy-budget-amount-input",
      placeholder: currencyMinorUnits(currency) === 0 ? "0" : "0.00",
      disabled: readOnly,
    });
    amountInput.value = centsToAmountText(it.proposed_cost_cents, currency);
    inputs.appendChild((amountWrap.appendChild(amountInput), amountWrap));

    // Tag dropdown
    const tagSel = el("select", { class: "vy-budget-tag", disabled: readOnly });
    TAG_OPTIONS.forEach((opt) => {
      const o = el("option", { value: opt.value, text: opt.label });
      if ((it.cost_tag || "") === opt.value) o.setAttribute("selected", "");
      tagSel.appendChild(o);
    });
    inputs.appendChild(tagSel);

    // Custom split disclosure (only on multi-member trips)
    let splitToggle = null;
    let splitPanel = null;
    if (memberCount > 1) {
      splitToggle = el("button", {
        class: "vy-budget-split-toggle",
        type: "button",
        title: "Custom split",
        disabled: readOnly,
      }, "Custom split ▾");
      inputs.appendChild(splitToggle);
    }

    // Adornments: ✂ if shares exist, ⚠ if split-sum mismatch
    const adorn = el("div", { class: "vy-budget-row-adorn" });
    if (hasShares) adorn.appendChild(el("span", { class: "vy-budget-glyph", title: "Custom split", text: "✂" }));
    const warnEl = el("span", { class: "vy-budget-glyph is-warn", title: "Split total doesn't match proposed", text: "⚠" });
    warnEl.hidden = !splitMismatch(it);
    adorn.appendChild(warnEl);
    inputs.appendChild(adorn);

    row.appendChild(inputs);

    // ── Wire saves ───────────────────────────────────────────────
    // Mutate the in-memory item synchronously (drives the fuel-bar
    // refresh + local computations) and debounce the DB write.
    const persistCost = debouncedSave(withSaveIndicator(ctx, async (patch) => {
      await itemCosts.updateItem(it.id, patch);
    }), 700);
    function applyCost(patch) {
      Object.assign(it, patch);
      warnEl.hidden = !splitMismatch(it);
      refreshFuelBar();
      persistCost(patch);
    }

    amountInput.addEventListener("input", () => {
      const cents = parseAmountToCents(amountInput.value, currency);
      // If user typed an amount with no tag yet, flip the tag to
      // 'approx' so the row doesn't stay in "unassigned" once it
      // visibly has a number.
      const patch = { proposed_cost_cents: cents };
      if (cents != null && !it.cost_tag) {
        patch.cost_tag = "approx";
        tagSel.value = "approx";
        row.dataset.tag = "approx";
      }
      applyCost(patch);
    });

    tagSel.addEventListener("change", () => {
      const v = tagSel.value || null;
      row.dataset.tag = v || "";
      applyCost({ cost_tag: v });
    });

    // ── Split panel (lazy build) ─────────────────────────────────
    if (splitToggle) {
      splitPanel = el("div", { class: "vy-budget-split-panel", hidden: true });
      row.appendChild(splitPanel);
      let built = false;
      splitToggle.addEventListener("click", () => {
        if (!built) { buildSplitPanel(splitPanel, it, trip, currency, () => {
          // Refresh the row's ✂ / ⚠ adornments after a save inside the panel.
          adorn.querySelector(".vy-budget-glyph:not(.is-warn)") || (() => {})();
          const stillHasShares = (it.shares || []).length > 0;
          const adorned = adorn.querySelector("span:not(.is-warn)");
          if (stillHasShares && !adorned) {
            adorn.insertBefore(el("span", { class: "vy-budget-glyph", title: "Custom split", text: "✂" }), warnEl);
          } else if (!stillHasShares && adorned) {
            adorned.remove();
          }
          warnEl.hidden = !splitMismatch(it);
        }, readOnly, ctx); built = true; }
        const willShow = splitPanel.hidden;
        splitPanel.hidden = !willShow;
        splitToggle.textContent = willShow ? "Custom split ▴" : "Custom split ▾";
      });
    }

    // Apply filter visibility immediately
    if (!rowMatchesFilter(filterMode, it.cost_tag)) row.style.display = "none";

    return row;
  }

}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

function applyFilter(host) {
  const filterMode = readFilter();
  host.querySelectorAll(".vy-budget-row").forEach((row) => {
    const tag = row.dataset.tag || "";
    row.style.display = rowMatchesFilter(filterMode, tag) ? "" : "none";
  });
  // Hide groups whose rows are all hidden.
  host.querySelectorAll(".vy-budget-day").forEach((group) => {
    const anyVisible = [...group.querySelectorAll(".vy-budget-row")].some(
      (r) => r.style.display !== "none");
    group.style.display = anyVisible ? "" : "none";
  });
}

/** Does a row pass the active filter mode? */
function rowMatchesFilter(filterMode, tag) {
  switch (filterMode) {
    case "unassigned": return !tag;
    case "guessing":   return tag === "guessing";
    case "review":     return !tag || tag === "guessing";
    case "all":
    default:           return true;
  }
}

// Returns true when the item has custom shares that don't sum to the
// item's proposed cost. Items in default-even mode (no shares) are
// always "matched" by definition.
function splitMismatch(it) {
  const shares = it.shares || [];
  if (shares.length === 0) return false;
  if (it.proposed_cost_cents == null) return false;
  const sum = shares.reduce((a, s) => a + (Number(s.proposed_amount_cents) || 0), 0);
  return sum !== Number(it.proposed_cost_cents);
}

function currencySymbol(code) {
  try {
    const fmt = new Intl.NumberFormat(undefined, {
      style: "currency", currency: (code || "USD").toUpperCase(),
      currencyDisplay: "narrowSymbol",
    });
    // Format zero; the result is e.g. "¥0" or "$0.00" — strip the digits.
    const parts = fmt.formatToParts(0);
    const sym = parts.find((p) => p.type === "currency");
    return sym?.value || code;
  } catch { return code; }
}

function readView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEW_OPTIONS.includes(v) ? v : "edit";
  } catch { return "edit"; }
}
function writeView(v) {
  try { localStorage.setItem(VIEW_KEY, v); } catch {}
}
function readGroup() {
  try {
    const v = localStorage.getItem(GROUP_KEY);
    return GROUP_OPTIONS.includes(v) ? v : "day";
  } catch { return "day"; }
}
function writeGroup(v) {
  try { localStorage.setItem(GROUP_KEY, v); } catch {}
}
function readFilter() {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    const allowed = ["all", "unassigned", "guessing", "review"];
    if (allowed.includes(v)) return v;
    // Migrate the previous boolean flag (voyage:budget-unassigned-only).
    const legacy = localStorage.getItem("voyage:budget-unassigned-only");
    if (legacy === "1") return "unassigned";
    return "all";
  } catch { return "all"; }
}
function writeFilter(v) {
  try { localStorage.setItem(FILTER_KEY, v); } catch {}
}

// ───────────────────────────────────────────────────────────────────
// Custom-split disclosure
// ───────────────────────────────────────────────────────────────────
//
// One row per trip member. Empty / zero input = member is NOT part of
// this split (no share row written). "Even split" auto-distributes the
// proposed total across members with non-empty inputs (or all members
// on first click). "Reset" clears every input + share row → falls back
// to implicit-even at view time.
//
// "Paid by" picker writes the item-level paid_by column (not per-share).
//
// Saves are debounced through replaceShares (atomic delete+insert via
// the SECURITY DEFINER RPC). The local it.shares mirror keeps the row's
// ✂ / ⚠ adornments in sync without re-rendering.

function buildSplitPanel(panel, it, trip, currency, onChanged, readOnly, ctx) {
  panel.innerHTML = "";
  const members = trip.members || [];
  if (members.length < 2) {
    panel.appendChild(el("p", { class: "muted small",
      text: "Solo trip — splits aren't needed." }));
    return;
  }

  // Snapshot of current shares for fast lookup. Local-mirror updates
  // happen synchronously; replaceShares fires debounced.
  const sharesByUser = new Map((it.shares || []).map((s) => [s.user_id, { ...s }]));

  const head = el("header", { class: "vy-split-head" },
    el("span", { class: "muted small", text: "Split among travelers" }),
    el("div", { class: "vy-split-actions" },
      el("button", { class: "btn ghost xs", type: "button",
        disabled: readOnly,
        onClick: () => evenSplit() }, "Even split"),
      el("button", { class: "btn ghost xs", type: "button",
        disabled: readOnly,
        onClick: () => resetSplit() }, "Reset"),
    ),
  );
  panel.appendChild(head);

  // Member rows
  const rowsWrap = el("div", { class: "vy-split-rows" });
  panel.appendChild(rowsWrap);

  const inputs = new Map(); // user_id → input element
  members.forEach((m) => {
    const r = el("label", { class: "vy-split-row" });
    r.appendChild(el("span", { class: "vy-split-name",
      text: m.display_name || m.email || "Member" }));
    const inp = el("input", {
      type: "text",
      inputmode: "decimal",
      class: "vy-split-amount",
      placeholder: implicitEvenText(it, members, currency),
      disabled: readOnly,
    });
    const existing = sharesByUser.get(m.user_id);
    if (existing && existing.proposed_amount_cents != null) {
      inp.value = centsToAmountText(existing.proposed_amount_cents, currency);
    }
    inp.addEventListener("input", () => onAnyInput());
    inputs.set(m.user_id, inp);
    r.appendChild(inp);
    rowsWrap.appendChild(r);
  });

  // Paid by picker
  const paidBlock = el("div", { class: "vy-split-paidby" },
    el("span", { class: "muted small", text: "Paid by" }),
  );
  const paidSel = el("select", { class: "vy-split-paid-select", disabled: readOnly });
  paidSel.appendChild(el("option", { value: "", text: "— no one yet —" }));
  members.forEach((m) => {
    const o = el("option", {
      value: m.user_id,
      text: m.display_name || m.email || "Member",
    });
    if (it.paid_by === m.user_id) o.setAttribute("selected", "");
    paidSel.appendChild(o);
  });
  paidSel.addEventListener("change", () => {
    const v = paidSel.value || null;
    it.paid_by = v;
    ctx.onSaveStart?.();
    itemCosts.updateItem(it.id, { paid_by: v })
      .catch((e) => ctx.toast?.("Could not save paid-by: " + (e.message || e), true))
      .finally(() => ctx.onSaveDone?.());
  });
  paidBlock.appendChild(paidSel);
  panel.appendChild(paidBlock);

  // Sum indicator
  const sumEl = el("div", { class: "vy-split-sum" });
  panel.appendChild(sumEl);
  refreshSum();

  // ── Behaviors ─────────────────────────────────────────────────

  const saveShares = debouncedSave(withSaveIndicator(ctx, async () => {
    const payload = currentSharesPayload();
    it.shares = payload.map((s) => ({
      user_id: s.user_id,
      proposed_amount_cents: s.proposed_amount_cents,
      actual_amount_cents: s.actual_amount_cents ?? null,
      item_id: it.id,
    }));
    await itemCosts.replaceShares(it.id, payload);
    onChanged?.();
  }), 700);

  function onAnyInput() {
    refreshSum();
    saveShares();
  }

  function currentSharesPayload() {
    const out = [];
    inputs.forEach((inp, uid) => {
      const text = (inp.value || "").trim();
      if (!text) return; // empty = not in this split
      const cents = parseAmountToCents(text, currency);
      if (cents == null) return;
      // Preserve any existing actual_amount_cents from prior shares.
      const prev = sharesByUser.get(uid);
      out.push({
        user_id: uid,
        proposed_amount_cents: cents,
        actual_amount_cents: prev?.actual_amount_cents ?? null,
      });
    });
    return out;
  }

  function refreshSum() {
    const payload = currentSharesPayload();
    const sum = payload.reduce((a, s) => a + (Number(s.proposed_amount_cents) || 0), 0);
    const target = Number(it.proposed_cost_cents) || 0;
    const matches = payload.length === 0 || sum === target;
    sumEl.innerHTML = "";
    sumEl.append(
      el("span", { class: "muted small",
        text: payload.length === 0
          ? `Default-even split: ${formatMoney(implicitEvenCents(it, members), currency)} each`
          : `Sum: ${formatMoney(sum, currency)} / item proposed ${formatMoney(target, currency)}` }),
      payload.length > 0
        ? el("span", { class: matches ? "vy-split-ok" : "vy-split-warn",
            text: matches ? "✓" : "⚠ mismatch" })
        : null,
    );
  }

  function evenSplit() {
    if (readOnly) return;
    const active = [...inputs.entries()].filter(([, inp]) => (inp.value || "").trim());
    const targets = active.length > 0 ? active.map(([uid]) => uid) : members.map((m) => m.user_id);
    const cents = Number(it.proposed_cost_cents) || 0;
    if (!cents || targets.length === 0) return;
    const each = Math.floor(cents / targets.length);
    const remainder = cents - each * targets.length;
    inputs.forEach((inp, uid) => {
      const i = targets.indexOf(uid);
      if (i < 0) { inp.value = ""; return; }
      const extra = i < remainder ? 1 : 0;
      inp.value = centsToAmountText(each + extra, currency);
    });
    onAnyInput();
  }

  function resetSplit() {
    if (readOnly) return;
    inputs.forEach((inp) => { inp.value = ""; });
    onAnyInput();
  }
}

function implicitEvenCents(it, members) {
  const total = Number(it.proposed_cost_cents) || 0;
  const n = Math.max(1, members.length);
  return Math.floor(total / n);
}

function implicitEvenText(it, members, currency) {
  const cents = implicitEvenCents(it, members);
  return cents ? formatMoney(cents, currency) : "";
}
