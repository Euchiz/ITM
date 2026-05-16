// Map page (Plan mode) — placeholder.
// Future: a visualized route preview with draggable pins, the ability
// to add a stop directly to the trip, and edit the route geometry.

import { el } from "./_utils.js";
import { t } from "../i18n/locale.js";

export function renderMap(host, ctx) {
  const cities = uniqueCities(ctx.trip);
  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: t("map.title") }),
      el("p", { class: "muted", text: t("map.preview.subtitle") }),
    )
  );

  host.appendChild(
    el("section", { class: "card vy-stale-card" },
      el("div", { class: "vy-stale-mark" },
        el("span", { class: "material-symbols-outlined", text: "map" }),
      ),
      el("div", { class: "vy-stale-body" },
        el("strong", { class: "vy-stale-title", text: t("map.preview.title") }),
        el("span", { class: "vy-meta", text: t("map.preview.statusBadge") }),
        cities.length
          ? el("p", { class: "small",
              text: t("map.preview.willRender", { n: cities.length, cities: cities.join(" → ") }) })
          : el("p", { class: "small", text: t("map.preview.addCities") }),
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
