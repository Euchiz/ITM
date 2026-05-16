// Mobile "More" half-sheet — opened by the ⋯ button in the header.
//
// Lists overflow actions that don't earn a tab slot: trip overview,
// members, share, print, sign out, back to all trips.
//
// Rendered into a singleton container so opening the sheet again
// replaces (rather than stacks) the existing one. Tap-outside or
// Escape dismisses.

import { el } from "../_utils.js";
import { t } from "../../i18n/locale.js";

const SHEET_ID = "vy-mobile-sheet";

export function openMoreSheet(ctx) {
  closeMoreSheet();

  const backdrop = document.createElement("div");
  backdrop.id = SHEET_ID;
  backdrop.className = "vy-mobile-sheet-backdrop";

  const sheet = el("div", { class: "vy-mobile-sheet", role: "dialog" });

  sheet.appendChild(el("div", { class: "vy-mobile-sheet-handle" }));
  sheet.appendChild(el("h3", { class: "vy-mobile-sheet-title", text: t("mobile.more.title") }));

  const items = [
    { id: "overview",    glyph: "tune",      label: t("mobile.more.tripOverview"),
      onClick: () => ctx.navigate?.({ page: "overview" }) },
    { id: "members",     glyph: "group",     label: t("mobile.more.membersRoles"),
      onClick: () => ctx.navigate?.({ page: "members" }) },
    { id: "share",       glyph: "share",     label: t("mobile.more.shareTrip"),
      onClick: () => ctx.openShare?.() },
    { id: "print",       glyph: "print",     label: t("mobile.more.printPreview"),
      onClick: () => ctx.openPrint?.() },
    { id: "preferences", glyph: "settings",  label: t("mobile.more.preferences"),
      onClick: () => ctx.openPreferences?.() },
    { type: "sep" },
    { id: "back",        glyph: "luggage",   label: t("mobile.more.backTrips"),
      onClick: () => ctx.navigate?.({ trip: null }) },
    { id: "signout",     glyph: "logout",    label: t("mobile.more.signOut"), danger: true,
      onClick: () => ctx.signOut?.() },
  ];

  const list = el("div", { class: "vy-mobile-sheet-list" });
  for (const it of items) {
    if (it.type === "sep") { list.appendChild(el("hr")); continue; }
    const btn = el("button", {
      class: `vy-mobile-sheet-item ${it.danger ? "is-danger" : ""}`.trim(),
      onClick: () => {
        closeMoreSheet();
        try { it.onClick?.(); } catch (e) { console.error(e); }
      },
    },
      el("span", { class: "material-symbols-outlined", text: it.glyph }),
      el("span", { text: it.label }),
    );
    list.appendChild(btn);
  }
  sheet.appendChild(list);
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);

  // Dismissal: tap outside the sheet, or Escape key.
  const offClick = (e) => {
    if (e.target === backdrop) closeMoreSheet();
  };
  const offKey = (e) => { if (e.key === "Escape") closeMoreSheet(); };
  backdrop.addEventListener("pointerdown", offClick);
  document.addEventListener("keydown", offKey, true);

  backdrop._teardown = () => {
    backdrop.removeEventListener("pointerdown", offClick);
    document.removeEventListener("keydown", offKey, true);
  };

  // Slide-up animation: add the class on next frame so the transition fires.
  requestAnimationFrame(() => backdrop.classList.add("is-open"));
}

export function closeMoreSheet() {
  const node = document.getElementById(SHEET_ID);
  if (!node) return;
  if (typeof node._teardown === "function") node._teardown();
  node.classList.remove("is-open");
  // Wait for slide-down to finish before removing.
  setTimeout(() => node.remove(), 200);
}
