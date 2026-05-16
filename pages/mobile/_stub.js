// Mobile placeholder.
//
// Renders while the mobile redesign ships in slices. Each subsequent
// slice replaces a real mobile page module (today, itinerary, pack,
// detail, etc.) and the platform branch in app.js picks the matching
// renderer. Until then, every mobile trip-page renders this stub —
// the user sees they're on mobile and is pointed at desktop.

import { el } from "../_utils.js";
import { t } from "../../i18n/locale.js";

export function renderMobileStub(host, ctx) {
  const trip = ctx.trip;
  host.innerHTML = "";
  host.appendChild(
    el("section", { class: "vy-mobile-stub" },
      el("div", { class: "vy-mobile-stub-mark" },
        el("span", { class: "material-symbols-outlined", text: "smartphone" }),
      ),
      el("h2", { text: t("mobile.stub.title") }),
      el("p", { text: t("mobile.stub.body") }),
      trip ? el("p", { class: "small muted",
        text: t("mobile.stub.tripLine", { title: trip.title || t("sidebar.untitledTrip") })
      }) : null,
      el("div", { class: "vy-mobile-stub-actions" },
        el("button", { class: "btn ghost",
          onClick: () => {
            try {
              navigator.clipboard?.writeText(location.href);
              ctx.toast?.(t("mobile.unavailable.copied"));
            } catch {}
          },
        }, t("mobile.stub.copyUrl")),
        el("button", { class: "btn",
          onClick: () => ctx.navigate?.({ trip: null }),
        }, t("mobile.stub.allTrips")),
      ),
    )
  );
}
