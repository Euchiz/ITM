// Trips lobby. Profile card on top, trips list below.
//
// The profile card is the user's account home — display name + email +
// account-type chip + sign-out, plus a "Save your trips" CTA for anon
// guests. Clicking "+ New trip" opens a dialog wired up by app.js
// (so we can route anon users through the convert dialog first).

import { trips } from "../supabase.js";
import { el, escapeHtml, fmtDateRange } from "./_utils.js";

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
    <section class="profile-card" aria-label="Your account">
      <div class="profile-card-left">
        <div class="profile-avatar" id="profileAvatar"></div>
        <div class="profile-meta">
          <div class="profile-name-row">
            <span class="profile-name" id="profileNameText"></span>
            <button class="profile-edit-btn" id="profileEditNameBtn" title="Edit display name" type="button">Edit</button>
          </div>
          <div class="profile-sub">
            <span class="profile-email" id="profileEmail"></span>
            <span class="profile-type" id="profileType"></span>
          </div>
        </div>
      </div>
      <div class="profile-card-right">
        ${isAnonymous ? `
          <button id="profileConvertBtn" class="btn primary" type="button">Save your trips · Create account</button>
        ` : `
          <button id="profilePasswordBtn" class="btn ghost" type="button">Change password</button>
        `}
        <button id="profileSignOutBtn" class="btn ghost" type="button">Sign out</button>
      </div>
    </section>

    <header class="trips-header">
      <h1>All trips</h1>
      <div class="trips-header-actions">
        <button class="btn primary" id="newTripBtn">+ New trip</button>
      </div>
    </header>
    ${isAnonymous ? `
      <p class="muted small dashboard-anon-note">
        You're browsing as a guest. Trips you've been invited to appear below.
        Create an account to start your own.
      </p>
    ` : ""}
    <div id="tripsList" class="trips-list" aria-live="polite">
      <p class="muted">Loading…</p>
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
    const next = window.prompt("Display name (shown on trips you share):", current);
    if (next == null) return;
    if (next.trim() === current.trim()) return;
    try {
      await onChangeDisplayName?.(next);
      profile = { ...(profile || {}), display_name: next.trim() || null };
      paintProfile();
    } catch (e) {
      alert("Could not save display name: " + e.message);
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
    const fallback = isAnonymous ? "Guest" : (email.split("@")[0] || "You");
    const shown = name || fallback;

    host.querySelector("#profileNameText").textContent = shown;
    host.querySelector("#profileEmail").textContent = isAnonymous ? "No email on file" : email;
    const typeEl = host.querySelector("#profileType");
    typeEl.textContent = isAnonymous ? "Guest" : "Account";
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
      if (!res.ok) throw new Error("sample.json not found");
      const payload = await res.json();
      const id = await trips.createFromJson(payload);
      onOpen?.(id);
    } catch (e) {
      alert("Could not load sample: " + e.message);
    }
  }

  async function refresh() {
    list.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const rows = await trips.list();
      if (rows.length === 0) {
        list.innerHTML = "";
        const empty = el("div", { class: "empty-state" },
          el("h2", { text: "No trips yet" }),
          el("p", { text: "Click + New trip to start, or load the Japan sample to see how a populated trip looks." }),
          el("div", { class: "actions" },
            el("button", { class: "btn", onClick: () => loadSample() }, "Load sample trip"),
          ),
        );
        list.appendChild(empty);
        return;
      }
      list.innerHTML = "";
      rows.forEach((t) => list.appendChild(rowEl(t)));
    } catch (e) {
      list.innerHTML = `<p class="error">Could not load trips: ${escapeHtml(e.message)}</p>`;
    }
  }

  function rowEl(t) {
    const dates = fmtDateRange(t.start_date, t.end_date);
    const prep = t.prepTotal > 0 ? `Preparation: ${t.prepDone} / ${t.prepTotal} done` : "";
    const shared = t.memberCount > 1
      ? `· shared with ${t.memberCount - 1} other${t.memberCount === 2 ? "" : "s"}`
      : "";
    const card = el("div", { class: "trip-card", "data-id": t.id },
      el("button", {
        class: "trip-open",
        title: "Open",
        onClick: () => onOpen?.(t.id),
      },
        el("span", { class: "trip-title", text: t.title || "(untitled)" }),
        t.destination ? el("span", { class: "trip-destination", text: t.destination }) : null,
        el("span", { class: "trip-meta" },
          el("span", { class: `role role-${t.role}`, text: t.role }),
          dates ? el("span", { text: dates }) : null,
          prep ? el("span", { class: "muted", text: prep }) : null,
          shared ? el("span", { class: "muted", text: shared }) : null,
        ),
      ),
    );

    if (t.role === "owner") {
      card.appendChild(el("div", { class: "trip-actions" },
        el("button", {
          class: "btn ghost danger",
          title: "Delete",
          onClick: async (e) => {
            e.stopPropagation();
            if (!confirm("Delete this trip? This removes it for everyone it's shared with.")) return;
            try {
              await trips.remove(t.id);
              await refresh();
            } catch (err) {
              alert("Delete failed: " + err.message);
            }
          },
          text: "Delete",
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
