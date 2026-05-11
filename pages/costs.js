// Costs page (Travel mode) — actual costs in use.
// Future: log spends as they happen, mirror against the budget plan,
// surface per-traveler totals.

import { el } from "./_utils.js";

export function renderCosts(host, ctx) {
  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: "Costs" }),
      el("p", { class: "muted",
        text: "Travel-mode ledger: actual spending as it happens. " +
              "Coming soon: snap receipts, log shared-tab payments, watch your running total against the planned budget." }),
    )
  );

  host.appendChild(
    el("section", { class: "card vy-stale-card" },
      el("div", { class: "vy-stale-mark" },
        el("span", { class: "material-symbols-outlined", text: "receipt_long" }),
      ),
      el("div", { class: "vy-stale-body" },
        el("strong", { class: "vy-stale-title", text: "Actual spend log" }),
        el("span", { class: "vy-meta", text: "PROPOSED · NOT YET IMPLEMENTED" }),
        el("p", { class: "small",
          text: "When live: a quick-add expense row (amount · category · who paid), a running daily total, " +
                "and a small reconciler against the planned budget from Plan mode." }),
      ),
    )
  );
}
