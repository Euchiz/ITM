// Costs page (Travel mode) — log actuals per day, see the breakdown.
//
// Two modes: UPDATE (per-day list of items + actual inputs, mirrors
// Today's layout) and BREAKDOWN (trip-wide, reuses the breakdown-view
// component with donutMode='actual', plus a Settlement section at the
// bottom when splits/paid_by exist).
//
// Update mode respects ctx.selectedDayIdx — switching days via the
// day-strip works just like Today. A "+ Add unplanned expense" button
// at the top of each day's list creates an is_unplanned=true item with
// cost_tag='actual' for the catch-all spends not on the itinerary.

import { items as itemsApi, itemCosts } from "../supabase.js";
import {
  el, debouncedSave, withSaveIndicator, formatMoney,
  parseAmountToCents, centsToAmountText, currencyMinorUnits,
} from "./_utils.js";
import { TYPE_VISUALS } from "./itinerary.js";
import { ITEM_TYPES } from "../io/schema.js";
import { renderFuelBar, renderFuelPill } from "./_components/fuel-bar.js";
import { renderBreakdown } from "./_components/breakdown-view.js";

const VIEW_KEY     = "voyage:costs-view";
const VIEW_OPTIONS = ["update", "breakdown"];

const TAG_LABELS = {
  "":         "—",
  null:       "—",
  "n_a":      "N/A",
  "guessing": "?",
  "approx":   "~",
  "actual":   "✓",
};

export function renderCosts(host, ctx) {
  const trip = ctx.trip || {};
  const readOnly = ctx.role === "viewer";
  const view = readView();

  host.innerHTML = "";
  const layout = el("div", { class: "vy-budget-layout" });
  const main = el("div", { class: "vy-budget-main" });
  const rail = el("aside", { class: "vy-budget-rail", "aria-label": "Budget gauge" });
  layout.append(main, rail);
  host.appendChild(layout);
  renderFuelBar(rail, ctx);
  const refreshFuelBar = () => renderFuelBar(rail, ctx);

  // ── Page head ─────────────────────────────────────────────────────
  main.appendChild(el("section", { class: "page-head vy-budget-head" },
    el("div", { class: "vy-budget-head-l" },
      el("h2", { text: "Costs" }),
      el("p", { class: "muted", text: view === "update"
        ? "Log what you actually spent, day by day. Tap Use proposed to confirm a planned price; add unplanned expenses for spends that aren't on the itinerary."
        : "Trip-wide breakdown of actuals against the plan, with settlement at the bottom when shared." }),
    ),
    el("div", { class: "vy-budget-head-r" },
      viewToggle(),
    ),
  ));

  const pillSlot = el("div", { class: "vy-budget-head-pill" });
  renderFuelPill(pillSlot, ctx);
  main.appendChild(pillSlot);

  if (view === "breakdown") {
    main.appendChild(renderBreakdownPanel());
    return;
  }
  main.appendChild(renderUpdateMode());

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

  function renderUpdateMode() {
    const idx = Math.min(
      Math.max(0, ctx.selectedDayIdx || 0),
      Math.max(0, (trip.days || []).length - 1),
    );
    const day = (trip.days || [])[idx];

    if (!day) {
      return el("div", { class: "empty-state" },
        el("h3", { text: "No days yet" }),
        el("p", { text: "Add a day on Itinerary first." }),
      );
    }

    const wrap = el("div", { class: "vy-costs-update" });

    // Day header
    const dateLabel = day.date
      ? new Date(day.date + "T00:00:00").toLocaleDateString(undefined,
          { weekday: "long", month: "short", day: "numeric" })
      : `Day ${idx + 1}`;
    wrap.appendChild(el("section", { class: "vy-costs-day-head" },
      el("div", { class: "vy-meta", text: `DAY ${idx + 1} OF ${(trip.days || []).length}` }),
      el("h3", { text: dateLabel + (day.city ? ` · ${day.city}` : "") }),
    ));

    // Items split into planned + unplanned
    const all = (day.items || []).slice();
    const planned   = all.filter((it) => !it.is_unplanned);
    const unplanned = all.filter((it) =>  it.is_unplanned);

    const card = el("section", { class: "card vy-costs-card" });
    card.appendChild(el("header", { class: "vy-costs-card-head" },
      el("h4", { text: "Planned items" }),
      readOnly ? null : el("button", {
        class: "btn primary xs",
        type: "button",
        onClick: () => openUnplannedDialog(day, idx, ctx),
      }, "+ Add unplanned"),
    ));

    if (planned.length === 0) {
      card.appendChild(el("p", { class: "muted small",
        text: "No planned items for this day." }));
    } else {
      const list = el("div", { class: "vy-costs-list" });
      planned.forEach((it) => list.appendChild(costRow(it, day)));
      card.appendChild(list);
    }
    wrap.appendChild(card);

    if (unplanned.length > 0) {
      const upWrap = el("section", { class: "card vy-costs-card" });
      upWrap.appendChild(el("header", { class: "vy-costs-card-head" },
        el("h4", { text: "Unplanned spends" }),
      ));
      const list = el("div", { class: "vy-costs-list" });
      unplanned.forEach((it) => list.appendChild(costRow(it, day, true)));
      upWrap.appendChild(list);
      wrap.appendChild(upWrap);
    }

    return wrap;
  }

  function costRow(it, day, isUnplannedRow = false) {
    const v = TYPE_VISUALS[it.type] || TYPE_VISUALS.activity;
    const currency = (it.currency || trip.default_currency || "USD").toUpperCase();
    const isOverride = !!it.currency
      && it.currency.toUpperCase() !== (trip.default_currency || "USD").toUpperCase();
    const hasShares = (it.shares || []).length > 0;

    const row = el("div", { class: "vy-costs-row", "data-item-id": it.id });

    // Title block
    row.appendChild(el("div", { class: "vy-costs-row-main" },
      el("span", { class: `vy-chip vy-chip--${v.chipClass}` },
        el("span", { class: "material-symbols-outlined", text: v.glyph }),
        el("span", { text: v.label }),
      ),
      el("div", { class: "vy-costs-row-title-wrap" },
        el("span", { class: "vy-costs-row-title", text: it.title || "(untitled)" }),
        // Proposed + tag on a sub-line — read-only context for entry.
        !isUnplannedRow ? el("span", { class: "vy-costs-row-sub muted small" },
          el("span", { text: "Proposed: " }),
          it.proposed_cost_cents != null
            ? el("span", { text: formatMoney(it.proposed_cost_cents, currency) })
            : el("span", { text: "—" }),
          it.cost_tag
            ? el("span", { class: "vy-costs-sub-tag", text: " · " + (TAG_LABELS[it.cost_tag] || it.cost_tag) })
            : null,
        ) : el("span", { class: "vy-costs-row-sub muted small",
            text: "Unplanned expense" }),
      ),
    ));

    // Inputs
    const inputs = el("div", { class: "vy-costs-row-inputs" });

    const amountWrap = el("label", { class: "vy-budget-amount" });
    const sym = el("span", { class: "vy-budget-amount-sym", text: currencySymbol(currency) });
    if (isOverride) sym.classList.add("is-override");
    amountWrap.appendChild(sym);
    const amountInput = el("input", {
      type: "text",
      inputmode: "decimal",
      class: "vy-budget-amount-input",
      placeholder: currencyMinorUnits(currency) === 0 ? "0" : "0.00",
      disabled: readOnly,
    });
    amountInput.value = centsToAmountText(it.actual_cost_cents, currency);
    amountWrap.appendChild(amountInput);
    inputs.appendChild(amountWrap);

    // "Use proposed" quick-fill — only when proposed exists and actual is empty
    const useBtn = el("button", {
      class: "vy-costs-use-proposed",
      type: "button",
      disabled: readOnly,
      title: "Set actual = proposed and tag as actual",
    });
    function refreshUseBtn() {
      const canUse = it.proposed_cost_cents != null && it.actual_cost_cents == null;
      useBtn.hidden = !canUse;
      if (canUse) {
        useBtn.textContent = `↩ Use ${formatMoney(it.proposed_cost_cents, currency)}`;
      }
    }
    refreshUseBtn();
    useBtn.addEventListener("click", () => {
      if (it.proposed_cost_cents == null) return;
      amountInput.value = centsToAmountText(it.proposed_cost_cents, currency);
      applyActual(it.proposed_cost_cents, "actual");
    });
    inputs.appendChild(useBtn);

    // Glyph adornments
    const adorn = el("div", { class: "vy-budget-row-adorn" });
    if (hasShares) adorn.appendChild(el("span", { class: "vy-budget-glyph", title: "Custom split", text: "✂" }));
    const warnEl = el("span", { class: "vy-budget-glyph is-warn", title: "Split actual doesn't match", text: "⚠" });
    warnEl.hidden = !splitActualMismatch(it);
    adorn.appendChild(warnEl);
    inputs.appendChild(adorn);

    row.appendChild(inputs);

    // ── Wire saves ─────────────────────────────────────────────
    const persist = debouncedSave(withSaveIndicator(ctx, async (patch) => {
      await itemCosts.updateItem(it.id, patch);
    }), 700);

    function applyActual(cents, forceTag = null) {
      const patch = { actual_cost_cents: cents };
      // Auto-flip tag to 'actual' once the actual amount lands.
      if (cents != null && it.cost_tag !== "actual") {
        patch.cost_tag = "actual";
      } else if (forceTag) {
        patch.cost_tag = forceTag;
      }
      Object.assign(it, patch);
      refreshUseBtn();
      warnEl.hidden = !splitActualMismatch(it);
      refreshFuelBar();
      persist(patch);
    }

    amountInput.addEventListener("input", () => {
      const cents = parseAmountToCents(amountInput.value, currency);
      applyActual(cents);
    });

    return row;
  }

  function renderBreakdownPanel() {
    const bd = el("div", { class: "vy-costs-breakdown" });
    const bdHost = el("div");
    bd.appendChild(bdHost);
    renderBreakdown(bdHost, {
      trip,
      donutMode: "actual",
      includeUnplanned: true,
    });
    // Settlement section at the bottom — only when there's something to settle.
    const settlement = computeSettlement(trip);
    if (settlement.hasAny) {
      bd.appendChild(renderSettlement(settlement, trip));
    }
    return bd;
  }
}

// ───────────────────────────────────────────────────────────────────
// Add-unplanned-expense dialog
// ───────────────────────────────────────────────────────────────────
//
// Spawned by the "+ Add unplanned" button on the Update mode's day card.
// Creates an itinerary_items row with is_unplanned=true, day_id=current,
// cost_tag='actual', amount provided. Pre-fills currency to trip default.

function openUnplannedDialog(day, dayIdx, ctx) {
  if (!ctx) return;
  const trip = ctx.trip;
  const defaultCurrency = (trip.default_currency || "USD").toUpperCase();

  const dlg = document.createElement("dialog");
  dlg.className = "settings-dialog vy-unplanned-dialog no-print";
  dlg.innerHTML = `
    <form method="dialog">
      <h3>Add unplanned expense</h3>
      <p class="muted small">
        For day ${dayIdx + 1}${day.date ? " · " + day.date : ""}. The item
        is flagged as unplanned and tagged as <b>actual</b> by default —
        edit the title and type as you like.
      </p>
      <label>Title
        <input id="upTitle" type="text" required maxlength="120"
               placeholder="e.g. Coffee at the station">
      </label>
      <label>Type
        <select id="upType">
          ${ITEM_TYPES.map((t) => {
            const label = (TYPE_VISUALS[t]?.label || t).toLowerCase();
            const sel = t === "shopping" ? "selected" : "";
            return `<option value="${t}" ${sel}>${label}</option>`;
          }).join("")}
        </select>
      </label>
      <div class="new-trip-dates">
        <label>Amount
          <input id="upAmount" type="number" min="0" step="any"
                 placeholder="${currencyMinorUnits(defaultCurrency) === 0 ? "0" : "0.00"}">
        </label>
        <label>Currency
          <input id="upCurrency" type="text" maxlength="3"
                 value="${defaultCurrency}" style="text-transform:uppercase">
        </label>
      </div>
      <p id="upStatus" class="auth-status muted small" hidden></p>
      <menu>
        <button value="cancel">Cancel</button>
        <button id="upSubmit" value="save" type="submit" class="primary">Add</button>
      </menu>
    </form>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "save") { dlg.remove(); return; }
    const title = dlg.querySelector("#upTitle").value.trim();
    const type  = dlg.querySelector("#upType").value;
    const amt   = Number(dlg.querySelector("#upAmount").value);
    const cur   = dlg.querySelector("#upCurrency").value.trim().toUpperCase() || defaultCurrency;
    if (!title || !Number.isFinite(amt)) { dlg.remove(); return; }
    const cents = Math.round(amt * Math.pow(10, currencyMinorUnits(cur)));

    ctx.onSaveStart?.();
    try {
      const newItem = await itemsApi.add(trip.id, day.id, {
        title, type,
        status: "done",
        is_fixed: false, is_highlight: false,
        sort_order: (day.items || []).length,
      });
      // Patch in cost columns after creation (itemsApi.add doesn't
      // accept the cost fields directly — keeps that helper minimal).
      await itemCosts.updateItem(newItem.id, {
        actual_cost_cents: cents,
        cost_tag: "actual",
        currency: cur === defaultCurrency ? null : cur,
        is_unplanned: true,
      });
      await ctx.refresh?.();
    } catch (e) {
      ctx.toast?.("Could not add: " + (e.message || e), true);
    } finally {
      ctx.onSaveDone?.();
      dlg.remove();
    }
  });
}

// ───────────────────────────────────────────────────────────────────
// Settlement
// ───────────────────────────────────────────────────────────────────
//
// Greedy reduction of "who owes who" into the minimum number of
// payments. Runs per-currency since we don't do FX.

export function computeSettlement(trip) {
  const members = trip.members || [];
  if (members.length === 0) return { hasAny: false, perCurrency: new Map() };

  const defaultCurrency = (trip.default_currency || "USD").toUpperCase();
  // Per-currency: { code → { netByUser: Map<uid, cents (signed)>, byUser: Map<uid, member> } }
  const ledgers = new Map();
  const ensureLedger = (code) => {
    if (!ledgers.has(code)) ledgers.set(code, { net: new Map() });
    return ledgers.get(code);
  };

  let anySplitOrPaid = false;

  for (const day of trip.days || []) {
    for (const it of day.items || []) {
      if (it.cost_tag === "n_a") continue;
      const currency = (it.currency || defaultCurrency).toUpperCase();
      const itemAmount = Number(
        it.actual_cost_cents != null ? it.actual_cost_cents : it.proposed_cost_cents
      ) || 0;
      if (itemAmount === 0) continue;

      const paidBy = it.paid_by;
      const hasShares = (it.shares || []).length > 0;
      if (!paidBy && !hasShares) continue;          // nothing to settle
      anySplitOrPaid = true;

      const ledger = ensureLedger(currency);
      const net = ledger.net;

      // Shares: explicit per-row amounts (use actual_amount_cents if
      // present, else proposed_amount_cents). Sum may not equal item
      // amount — settlement uses the recorded shares regardless.
      if (hasShares) {
        for (const s of it.shares) {
          const owe = Number(
            s.actual_amount_cents != null ? s.actual_amount_cents : s.proposed_amount_cents
          ) || 0;
          net.set(s.user_id, (net.get(s.user_id) || 0) + owe);
        }
      } else {
        // Default-even — split the item amount evenly across all members
        const each = Math.floor(itemAmount / members.length);
        const rem  = itemAmount - each * members.length;
        members.forEach((m, i) => {
          net.set(m.user_id, (net.get(m.user_id) || 0) + each + (i < rem ? 1 : 0));
        });
      }

      if (paidBy) {
        net.set(paidBy, (net.get(paidBy) || 0) - itemAmount);
      }
    }
  }

  // Reduce each ledger's net map to minimum-payment edges
  const perCurrency = new Map();
  ledgers.forEach((ledger, code) => {
    const edges = greedySettle(ledger.net);
    if (edges.length > 0) {
      perCurrency.set(code, edges);
    }
  });

  return { hasAny: anySplitOrPaid && perCurrency.size > 0, perCurrency };
}

function greedySettle(netMap) {
  const debtors   = []; // { uid, amount } where amount > 0 = owes
  const creditors = []; // { uid, amount } where amount > 0 = is owed
  netMap.forEach((amount, uid) => {
    if (amount > 0) debtors.push({ uid, amount });
    else if (amount < 0) creditors.push({ uid, amount: -amount });
  });
  // Sort largest first to minimize number of edges
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const edges = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const pay = Math.min(d.amount, c.amount);
    edges.push({ from: d.uid, to: c.uid, amount: pay });
    d.amount -= pay;
    c.amount -= pay;
    if (d.amount === 0) i++;
    if (c.amount === 0) j++;
  }
  return edges;
}

function renderSettlement(settlement, trip) {
  const wrap = el("section", { class: "card vy-settlement" });
  wrap.appendChild(el("header", { class: "vy-settlement-head" },
    el("h3", { text: "Settlement" }),
    el("span", { class: "muted small", text: "Who owes who at trip end" }),
  ));

  const membersById = Object.fromEntries((trip.members || []).map((m) => [m.user_id, m]));
  const nameFor = (uid) => {
    const m = membersById[uid];
    return m?.display_name || m?.email || "Former member";
  };

  settlement.perCurrency.forEach((edges, code) => {
    const block = el("div", { class: "vy-settlement-block" });
    block.appendChild(el("span", { class: "vy-meta", text: code }));
    const list = el("div", { class: "vy-settlement-list" });
    let total = 0;
    edges.forEach((e) => {
      total += e.amount;
      list.appendChild(el("div", { class: "vy-settlement-row" },
        el("span", { class: "vy-settlement-from", text: nameFor(e.from) }),
        el("span", { class: "vy-settlement-arrow", text: "→" }),
        el("span", { class: "vy-settlement-to", text: nameFor(e.to) }),
        el("span", { class: "vy-settlement-amount", text: formatMoney(e.amount, code) }),
      ));
    });
    block.appendChild(list);
    block.appendChild(el("div", { class: "vy-settlement-total muted small",
      text: `Total to settle: ${formatMoney(total, code)}` }));
    wrap.appendChild(block);
  });

  return wrap;
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

function splitActualMismatch(it) {
  const shares = it.shares || [];
  if (shares.length === 0) return false;
  if (it.actual_cost_cents == null) return false;
  const sum = shares.reduce((a, s) => a + (Number(s.actual_amount_cents) || 0), 0);
  return sum !== Number(it.actual_cost_cents);
}

function currencySymbol(code) {
  try {
    const fmt = new Intl.NumberFormat(undefined, {
      style: "currency", currency: (code || "USD").toUpperCase(),
      currencyDisplay: "narrowSymbol",
    });
    const parts = fmt.formatToParts(0);
    const sym = parts.find((p) => p.type === "currency");
    return sym?.value || code;
  } catch { return code; }
}

function readView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEW_OPTIONS.includes(v) ? v : "update";
  } catch { return "update"; }
}
function writeView(v) {
  try { localStorage.setItem(VIEW_KEY, v); } catch {}
}
