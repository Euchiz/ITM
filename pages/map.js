// Map page (Plan mode) — placeholder.
// Future: a visualized route preview with draggable pins, the ability
// to add a stop directly to the trip, and edit the route geometry.

import { el } from "./_utils.js";

export function renderMap(host, ctx) {
  const cities = uniqueCities(ctx.trip);
  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: "Map" }),
      el("p", { class: "muted",
        text: "Route preview — coming soon. We'll surface a visualised map of your trip here, " +
              "and you'll be able to add stops or edit the route directly from the canvas." }),
    )
  );

  host.appendChild(
    el("section", { class: "card vy-stale-card" },
      el("div", { class: "vy-stale-mark" },
        el("span", { class: "material-symbols-outlined", text: "map" }),
      ),
      el("div", { class: "vy-stale-body" },
        el("strong", { class: "vy-stale-title", text: "Route preview" }),
        el("span", { class: "vy-meta", text: "PROPOSED · NOT YET IMPLEMENTED" }),
        cities.length
          ? el("p", { class: "small",
              text: `When live, it would render the ${cities.length}-stop route: ${cities.join(" → ")}.` })
          : el("p", { class: "small", text: "Add cities to your day cards to seed the route preview." }),
      ),
    )
  );
}

function uniqueCities(trip) {
  const seen = new Set();
  const out = [];
  for (const d of (trip?.days || [])) {
    const c = (d.city || "").trim();
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    out.push(c);
  }
  return out;
}
