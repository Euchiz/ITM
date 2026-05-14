// Empty state when a URL deep-link points at a page mobile doesn't
// expose. e.g. desktop user shares ?page=io link → opens on phone →
// app routes here. Two CTAs: copy the URL so the user can open it on
// desktop, or jump to Today.

import { el } from "../_utils.js";

const PAGE_LABELS = {
  io:       "Import / Export",
  map:      "Map",
  // Mobile-reachable pages won't hit this stub. Anything else gets a
  // generic label.
};

export function renderMobileUnavailable(host, ctx) {
  const page = ctx.page || "this page";
  const label = PAGE_LABELS[page] || page.replace(/_/g, " ");
  host.innerHTML = "";
  host.appendChild(
    el("section", { class: "vy-mobile-edge card vy-mobile-unavailable" },
      el("span", { class: "material-symbols-outlined", text: "desktop_mac" }),
      el("h2", { text: "Page not available on mobile" }),
      el("p", { class: "muted",
        text: `"${label}" is part of the desktop planning view. ` +
              `Open this trip on a desktop browser, or jump to Today.` }),
      el("div", { class: "vy-mobile-unavailable-actions" },
        el("button", {
          class: "btn",
          onClick: () => {
            try {
              navigator.clipboard?.writeText(location.href);
              ctx.toast?.("URL copied — open on desktop");
            } catch {}
          },
        }, "Copy URL"),
        el("button", {
          class: "btn primary",
          onClick: () => {
            ctx.setMobileMode?.("travel");
            ctx.navigate?.({ page: "today" });
          },
        }, "Go to Today"),
      ),
    )
  );
}
