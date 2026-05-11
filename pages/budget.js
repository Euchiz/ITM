// Budget page (Plan mode) — proposed-costs summary.
// Future: per-traveler share / split, planned vs spent, category breakdown.

import { el } from "./_utils.js";

export function renderBudget(host, ctx) {
  const trip = ctx.trip;
  const itemCount = (trip.days || []).reduce((n, d) => n + (d.items || []).length, 0);
  const memberCount = (trip.members || []).length || 1;

  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: "Budget" }),
      el("p", { class: "muted",
        text: "Plan-mode summary: proposed costs vs total budget. " +
              "Coming soon: group cost split across travelers, category breakdown, and a live spend tracker." }),
    )
  );

  // Summary tile (always shows trip-shape data, even when no cost is set)
  host.appendChild(
    el("section", { class: "card" },
      el("h3", { text: "Trip shape" }),
      el("div", { class: "stat-grid" },
        statTile("Planned items",  String(itemCount), itemCount ? "across all days" : "no items yet"),
        statTile("Travelers",      String(memberCount), memberCount === 1 ? "solo" : "group"),
        statTile("Total budget",   "—", "set in trip settings"),
        statTile("Proposed cost",  "—", "summed from items"),
      ),
    )
  );

  // Stale block for the planned vs spent visual
  host.appendChild(
    el("section", { class: "card vy-stale-card" },
      el("div", { class: "vy-stale-mark" },
        el("span", { class: "material-symbols-outlined", text: "payments" }),
      ),
      el("div", { class: "vy-stale-body" },
        el("strong", { class: "vy-stale-title", text: "Planned vs spent · split view" }),
        el("span", { class: "vy-meta", text: "PROPOSED · NOT YET IMPLEMENTED" }),
        el("p", { class: "small",
          text: "When live: a stacked bar of proposed-cost per category, planned vs spent, " +
                "and an even-split breakdown across travelers (with toggles for who paid what)." }),
      ),
    )
  );
}

function statTile(label, value, foot) {
  return el("div", { class: "stat" },
    el("div", { class: "stat-label", text: label }),
    el("div", { class: "stat-value", text: value }),
    foot ? el("div", { class: "small muted", text: foot }) : null,
  );
}
