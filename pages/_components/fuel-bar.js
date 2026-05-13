// Fuel bar — persistent budget gauge for Budget + Costs surfaces.
//
// Renders as a vertical bar on the right rail when:
//   * trip.budget_target_cents is non-NULL
//   * viewport ≥ 720px (the Budget/Costs page CSS hides the rail and
//     surfaces a compact pill in the page-head instead).
//
// Fill = (actual_so_far + proposed_for_unspent_items) / target, in the
// trip default currency. Items whose currency differs are excluded from
// the gauge math and shown as pinned "+€120" chips below the bar — no
// FX in v1.
//
// Re-renders entirely from local state.trip on every call (callers
// invoke during their own re-render path). The bar widget is cheap;
// any keystroke that mutates state.trip can re-call this synchronously.

import { el, formatMoney } from "../_utils.js";
import { trips } from "../../supabase.js";

/** Render the fuel bar inside `host`. Returns the host (for chaining).
 *  Call again to update — clears and re-builds. */
export function renderFuelBar(host, ctx) {
  const trip = ctx?.trip;
  host.innerHTML = "";
  host.classList.add("vy-fuel-rail");

  if (!trip) return host;
  const target = trip.budget_target_cents;

  if (target == null) {
    // Empty-state: small CTA to set a target. Owner sees the button;
    // viewers / editors see a muted hint.
    host.appendChild(el("div", { class: "vy-fuel-empty" },
      el("span", { class: "vy-meta", text: "BUDGET TARGET" }),
      trip.role === "owner"
        ? el("button", {
            class: "btn ghost xs",
            type: "button",
            onClick: () => openSetTargetDialog(trip, ctx),
          }, "+ Set target")
        : el("span", { class: "muted small", text: "Owner hasn't set a target yet." }),
    ));
    return host;
  }

  const currency = (trip.default_currency || "USD").toUpperCase();
  const totals = computeTotals(trip, currency);

  const usedCents = totals.usedInDefault;
  const ratio = Math.max(0, Math.min(1, target ? usedCents / target : 0));
  const overspend = Math.max(0, usedCents - target);
  const remaining = Math.max(0, target - usedCents);
  const pct = target ? (usedCents / target) * 100 : 0;

  // Colour tier — viridian / amber / red — applied as a data attribute.
  let tier = "ok";
  if (pct > 100) tier = "over";
  else if (pct > 80) tier = "warn";

  const rail = el("div", { class: "vy-fuel", "data-tier": tier });

  // Top label — used / of target / percent
  rail.appendChild(el("div", { class: "vy-fuel-top" },
    el("div", { class: "vy-fuel-used", text: formatMoney(usedCents, currency) }),
    el("div", { class: "vy-fuel-target", text: `of ${formatMoney(target, currency)}` }),
    el("div", { class: "vy-fuel-pct", text: `${Math.round(pct)}%` }),
  ));

  // The bar itself — fixed height container with fill from bottom.
  const barBox = el("div", { class: "vy-fuel-bar" });
  const fill = el("div", { class: "vy-fuel-fill" });
  fill.style.height = `${Math.min(100, pct)}%`;
  barBox.appendChild(fill);
  rail.appendChild(barBox);

  // Bottom label — remaining / over
  rail.appendChild(el("div", { class: "vy-fuel-bot" },
    overspend > 0
      ? el("span", { class: "vy-fuel-over", text: `${formatMoney(overspend, currency)} over` })
      : el("span", { class: "vy-fuel-remaining", text: `${formatMoney(remaining, currency)} left` }),
  ));

  // Multi-currency tail — chips for any non-default currency totals.
  if (totals.byCurrency.size > 0) {
    const tail = el("div", { class: "vy-fuel-tail" });
    totals.byCurrency.forEach((amount, code) => {
      tail.appendChild(el("span", { class: "vy-fuel-tail-chip",
        text: `+ ${formatMoney(amount, code)}` }));
    });
    rail.appendChild(tail);
  }

  host.appendChild(rail);
  return host;
}

/** Compact pill variant for the page-head when the rail is hidden
 *  (viewport < 720px or owner hasn't set a target — handled by caller).
 *  Caller decides where to mount and when to show. */
export function renderFuelPill(host, ctx) {
  const trip = ctx?.trip;
  host.innerHTML = "";
  host.classList.add("vy-fuel-pill-wrap");
  if (!trip || trip.budget_target_cents == null) return host;

  const currency = (trip.default_currency || "USD").toUpperCase();
  const totals = computeTotals(trip, currency);
  const used = totals.usedInDefault;
  const target = trip.budget_target_cents;
  const pct = target ? (used / target) * 100 : 0;
  let tier = "ok";
  if (pct > 100) tier = "over";
  else if (pct > 80) tier = "warn";

  host.appendChild(el("button", {
    class: "vy-fuel-pill", "data-tier": tier, type: "button",
    title: `${formatMoney(used, currency)} of ${formatMoney(target, currency)} (${Math.round(pct)}%)`,
  },
    el("span", { text: `${formatMoney(used, currency)} / ${formatMoney(target, currency)}` }),
    el("span", { class: "vy-fuel-pill-pct", text: `${Math.round(pct)}%` }),
  ));
  return host;
}

// ───────────────────────────────────────────────────────────────────
// Math
// ───────────────────────────────────────────────────────────────────

/** Compute the "used so far" total in the trip default currency, plus
 *  per-currency overflow totals for any non-default override items.
 *
 *  "Used" math: for each item, prefer actual_cost_cents if set,
 *  otherwise proposed_cost_cents. This is the "projected total" view
 *  (actuals where they exist, planned otherwise) — so during travel,
 *  the bar reflects both confirmed spending and forecast spending.
 *
 *  Items with cost_tag = 'n_a' contribute zero; their explicitly-free
 *  status shouldn't pollute the gauge. Unplanned items count as
 *  "actual" by their nature.
 *
 *  is_unplanned items are included — they're real spends and should
 *  show on the gauge during travel mode.
 */
function computeTotals(trip, defaultCurrency) {
  let usedInDefault = 0;
  const byCurrency = new Map(); // code → cents

  for (const day of trip.days || []) {
    for (const it of day.items || []) {
      if (it.cost_tag === "n_a") continue;
      const cost = it.actual_cost_cents != null
        ? it.actual_cost_cents
        : it.proposed_cost_cents;
      if (cost == null) continue;
      const code = (it.currency || defaultCurrency || "USD").toUpperCase();
      if (code === defaultCurrency) {
        usedInDefault += Number(cost);
      } else {
        byCurrency.set(code, (byCurrency.get(code) || 0) + Number(cost));
      }
    }
  }
  return { usedInDefault, byCurrency };
}

// ───────────────────────────────────────────────────────────────────
// Set-target dialog
// ───────────────────────────────────────────────────────────────────
//
// Inline mini-dialog spawned by the "+ Set target" CTA. Owner-only;
// the empty-state hides the button for non-owners.

function openSetTargetDialog(trip, ctx) {
  const dlg = document.createElement("dialog");
  dlg.className = "settings-dialog vy-fuel-dialog no-print";
  dlg.innerHTML = `
    <form method="dialog">
      <h3>Set budget target</h3>
      <p class="muted small">
        Set an overall spending target for this trip. The fuel bar
        compares your projected spend against this number. Leave blank
        to clear an existing target.
      </p>
      <label>Currency
        <input id="fuelDlgCurrency" type="text" maxlength="3"
               value="${(trip.default_currency || "USD").toUpperCase()}"
               style="text-transform:uppercase">
      </label>
      <label>Target amount
        <input id="fuelDlgTarget" type="number" min="0" step="any"
               placeholder="e.g. 5000">
      </label>
      <menu>
        <button value="cancel">Cancel</button>
        <button value="clear" type="submit">Clear target</button>
        <button value="save" type="submit" class="primary">Save</button>
      </menu>
    </form>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener("close", async () => {
    const action = dlg.returnValue;
    if (action === "save") {
      const code = dlg.querySelector("#fuelDlgCurrency").value.trim().toUpperCase() || trip.default_currency;
      const amount = Number(dlg.querySelector("#fuelDlgTarget").value);
      const target = Number.isFinite(amount) && amount > 0
        ? Math.round(amount * Math.pow(10, minorUnits(code)))
        : null;
      try {
        await trips.setBudget(trip.id, { currency: code, target });
        trip.default_currency    = code;
        trip.budget_target_cents = target;
        ctx.rerender?.();
      } catch (e) {
        ctx.toast?.("Could not save budget: " + (e.message || e), true);
      }
    } else if (action === "clear") {
      try {
        await trips.setBudget(trip.id, { currency: null, target: null });
        trip.budget_target_cents = null;
        ctx.rerender?.();
      } catch (e) {
        ctx.toast?.("Could not clear budget: " + (e.message || e), true);
      }
    }
    dlg.remove();
  });
}

function minorUnits(code) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: code,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch { return 2; }
}
