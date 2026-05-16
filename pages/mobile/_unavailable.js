// Empty state when a URL deep-link points at a page mobile doesn't
// expose. e.g. desktop user shares ?page=io link → opens on phone →
// app routes here. Two CTAs: copy the URL so the user can open it on
// desktop, or jump to Today.

import { el } from "../_utils.js";
import { t } from "../../i18n/locale.js";

const PAGE_LABEL_KEYS = {
  io:  "mobile.unavailable.io",
  map: "mobile.unavailable.map",
};

export function renderMobileUnavailable(host, ctx) {
  const page = ctx.page || "";
  const label = PAGE_LABEL_KEYS[page]
    ? t(PAGE_LABEL_KEYS[page])
    : (page ? page.replace(/_/g, " ") : t("mobile.unavailable.fallbackLabel"));
  host.innerHTML = "";
  host.appendChild(
    el("section", { class: "vy-mobile-edge card vy-mobile-unavailable" },
      el("span", { class: "material-symbols-outlined", text: "desktop_mac" }),
      el("h2", { text: t("mobile.unavailable.titleAlt") }),
      el("p", { class: "muted", text: t("mobile.unavailable.bodyAlt", { label }) }),
      el("div", { class: "vy-mobile-unavailable-actions" },
        el("button", {
          class: "btn",
          onClick: () => {
            try {
              navigator.clipboard?.writeText(location.href);
              ctx.toast?.(t("mobile.unavailable.copied"));
            } catch {}
          },
        }, t("mobile.unavailable.copyUrl")),
        el("button", {
          class: "btn primary",
          onClick: () => {
            ctx.setMobileMode?.("travel");
            ctx.navigate?.({ page: "today" });
          },
        }, t("mobile.unavailable.goToday")),
      ),
    )
  );
}
