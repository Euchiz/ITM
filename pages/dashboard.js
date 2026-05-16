// Trips lobby. Profile card on top, trips list below.
//
// The profile card is the user's account home — display name + email +
// account-type chip + sign-out, plus a "Save your trips" CTA for anon
// guests. Clicking "+ New trip" opens a dialog wired up by app.js
// (so we can route anon users through the convert dialog first).

import { trips } from "../supabase.js";
import { el, escapeHtml, fmtDateRange } from "./_utils.js";
import { t, plural } from "../i18n/locale.js";

export async function renderDashboard(host, {
  user,
  profile,
  isAnonymous = false,
  onNewTrip,
  onOpen,
  onCreateBlocked,
  onChangeDisplayName,
  onChangePassword,
  onSignOut,
  onConvert,
}) {
  host.innerHTML = `
    <section class="profile-card" aria-label="${escapeHtml(t("dashboard.profile.aria"))}">
      <div class="profile-card-left">
        <div class="profile-avatar" id="profileAvatar"></div>
        <div class="profile-meta">
          <div class="profile-name-row">
            <span class="profile-name" id="profileNameText"></span>
            <button class="profile-edit-btn" id="profileEditNameBtn" title="${escapeHtml(t("dashboard.profile.editNameTooltip"))}" type="button">${escapeHtml(t("dashboard.profile.editName"))}</button>
          </div>
          <div class="profile-sub">
            <span class="profile-email" id="profileEmail"></span>
            <span class="profile-type" id="profileType"></span>
          </div>
        </div>
      </div>
      <div class="profile-card-right">
        ${isAnonymous ? `
          <button id="profileConvertBtn" class="btn primary" type="button">${escapeHtml(t("dashboard.profile.saveTripCta2"))}</button>
        ` : `
          <button id="profilePasswordBtn" class="btn ghost" type="button">${escapeHtml(t("dashboard.profile.changePassword"))}</button>
        `}
        <button id="profileSignOutBtn" class="btn ghost" type="button">${escapeHtml(t("dashboard.profile.signOut"))}</button>
      </div>
    </section>

    <header class="trips-header">
      <h1>${escapeHtml(t("dashboard.allTrips"))}</h1>
      <div class="trips-header-actions">
        <button class="btn primary" id="newTripBtn">${escapeHtml(t("dashboard.newTrip"))}</button>
      </div>
    </header>
    ${isAnonymous ? `
      <p class="muted small dashboard-anon-note">${escapeHtml(t("dashboard.guestNote"))}</p>
    ` : ""}
    <div id="tripsList" class="trips-list" aria-live="polite">
      <p class="muted">${escapeHtml(t("dashboard.loading"))}</p>
    </div>
  `;

  paintProfile();

  host.querySelector("#newTripBtn").addEventListener("click", () => {
    if (isAnonymous) {
      onCreateBlocked?.();
      return;
    }
    onNewTrip?.();
  });

  host.querySelector("#profileEditNameBtn").addEventListener("click", async () => {
    const current = profile?.display_name || "";
    const next = window.prompt(t("dashboard.profile.displayNamePrompt"), current);
    if (next == null) return;
    if (next.trim() === current.trim()) return;
    try {
      await onChangeDisplayName?.(next);
      profile = { ...(profile || {}), display_name: next.trim() || null };
      paintProfile();
    } catch (e) {
      alert(t("dashboard.profile.displayNameError", { error: e.message }));
    }
  });

  const pwdBtn = host.querySelector("#profilePasswordBtn");
  if (pwdBtn) pwdBtn.addEventListener("click", () => onChangePassword?.());

  const convertBtn = host.querySelector("#profileConvertBtn");
  if (convertBtn) convertBtn.addEventListener("click", () => onConvert?.());

  host.querySelector("#profileSignOutBtn").addEventListener("click", () => onSignOut?.());

  function paintProfile() {
    const name = (profile?.display_name || "").trim();
    const email = user?.email || profile?.email || "";
    const fallback = isAnonymous
      ? t("dashboard.profile.fallback.guest")
      : (email.split("@")[0] || t("dashboard.profile.fallback.you"));
    const shown = name || fallback;

    host.querySelector("#profileNameText").textContent = shown;
    host.querySelector("#profileEmail").textContent = isAnonymous
      ? t("dashboard.profile.email.none") : email;
    const typeEl = host.querySelector("#profileType");
    typeEl.textContent = isAnonymous
      ? t("dashboard.profile.type.guest") : t("dashboard.profile.type.account");
    typeEl.dataset.type = isAnonymous ? "guest" : "account";

    const avatar = host.querySelector("#profileAvatar");
    avatar.textContent = initialsFrom(shown);
  }

  const list = host.querySelector("#tripsList");

  async function loadSample() {
    if (isAnonymous) {
      onCreateBlocked?.();
      return;
    }
    try {
      const res = await fetch("./sample.json");
      if (!res.ok) throw new Error(t("dashboard.sampleMissing"));
      const payload = await res.json();
      const id = await trips.createFromJson(payload);
      onOpen?.(id);
    } catch (e) {
      alert(t("dashboard.sampleLoadFailed", { error: e.message }));
    }
  }

  async function refresh() {
    list.innerHTML = `<p class="muted">${escapeHtml(t("dashboard.loading"))}</p>`;
    try {
      const rows = await trips.list();
      if (rows.length === 0) {
        list.innerHTML = "";
        const empty = el("div", { class: "empty-state" },
          el("h2", { text: t("dashboard.empty.titleAlt") }),
          el("p", { text: t("dashboard.empty.bodyAlt") }),
          el("div", { class: "actions" },
            el("button", { class: "btn", onClick: () => loadSample() }, t("dashboard.loadSample")),
          ),
        );
        list.appendChild(empty);
        return;
      }
      list.innerHTML = "";
      rows.forEach((row) => list.appendChild(rowEl(row)));
    } catch (e) {
      list.innerHTML = `<p class="error">${escapeHtml(t("dashboard.loadFailed", { error: e.message }))}</p>`;
    }
  }

  function rowEl(row) {
    const dates = fmtDateRange(row.start_date, row.end_date);
    const prep = row.prepTotal > 0
      ? t("dashboard.trip.preparationCount", { done: row.prepDone, total: row.prepTotal })
      : "";
    const shared = row.memberCount > 1
      ? plural("dashboard.trip.shared", row.memberCount - 1, { n: row.memberCount - 1 })
      : "";
    const card = el("div", { class: "trip-card", "data-id": row.id },
      el("button", {
        class: "trip-open",
        title: t("dashboard.trip.open"),
        onClick: () => onOpen?.(row.id),
      },
        el("span", { class: "trip-title", text: row.title || t("dashboard.trip.untitled") }),
        row.destination ? el("span", { class: "trip-destination", text: row.destination }) : null,
        el("span", { class: "trip-meta" },
          el("span", { class: `role role-${row.role}`, text: row.role }),
          dates ? el("span", { text: dates }) : null,
          prep ? el("span", { class: "muted", text: prep }) : null,
          shared ? el("span", { class: "muted", text: shared }) : null,
        ),
      ),
    );

    if (row.role === "owner") {
      card.appendChild(el("div", { class: "trip-actions" },
        el("button", {
          class: "btn ghost danger",
          title: t("dashboard.trip.delete"),
          onClick: async (e) => {
            e.stopPropagation();
            if (!confirm(t("dashboard.trip.confirmDelete"))) return;
            try {
              await trips.remove(row.id);
              await refresh();
            } catch (err) {
              alert(t("dashboard.trip.deleteFailed", { error: err.message }));
            }
          },
          text: t("dashboard.trip.delete"),
        }),
      ));
    }

    return card;
  }

  await refresh();
  return { refresh };
}

// Two-letter initials from a display name or email. Stays readable
// even when the user's display name is a single word or a long email.
function initialsFrom(s) {
  const str = String(s || "").trim();
  if (!str) return "?";
  const parts = str.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return str[0].toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
