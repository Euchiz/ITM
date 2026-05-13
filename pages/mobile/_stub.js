// Mobile placeholder.
//
// Renders while the mobile redesign ships in slices. Each subsequent
// slice replaces a real mobile page module (today, itinerary, pack,
// detail, etc.) and the platform branch in app.js picks the matching
// renderer. Until then, every mobile trip-page renders this stub —
// the user sees they're on mobile and is pointed at desktop.

import { el } from "../_utils.js";

export function renderMobileStub(host, ctx) {
  const trip = ctx.trip;
  host.innerHTML = "";
  host.appendChild(
    el("section", { class: "vy-mobile-stub" },
      el("div", { class: "vy-mobile-stub-mark" },
        el("span", { class: "material-symbols-outlined", text: "smartphone" }),
      ),
      el("h2", { text: "Mobile view in progress" }),
      el("p", {
        text: "The mobile experience for Hermes Daybook is being built. " +
              "For now, please open this trip on a desktop browser."
      }),
      trip ? el("p", { class: "small muted",
        text: `Trip: ${trip.title || "Untitled trip"}`
      }) : null,
      el("div", { class: "vy-mobile-stub-actions" },
        el("button", { class: "btn ghost",
          onClick: () => {
            try {
              navigator.clipboard?.writeText(location.href);
              ctx.toast?.("URL copied — open on desktop");
            } catch {}
          },
        }, "Copy URL"),
        el("button", { class: "btn",
          onClick: () => ctx.navigate?.({ trip: null }),
        }, "All trips"),
      ),
    )
  );
}
