// Trips dashboard. Lists every trip the user has access to.

import { trips } from "../supabase.js";
import { el, escapeHtml, fmtDateRange } from "./_utils.js";

export async function renderDashboard(host, { onOpen, isAnonymous = false, onCreateBlocked }) {
  // Anon guests can see the trips they've been granted access to, but
  // they can't create new ones — those would orphan when the anon row
  // is reaped. The "+ New trip" button shows the convert modal instead.
  const newBtnLabel = isAnonymous ? "+ New trip · Sign up first" : "+ New trip";
  host.innerHTML = `
    <header class="trips-header">
      <h1>All trips</h1>
      <div class="trips-header-actions">
        <button class="btn primary" id="newTripBtn">${newBtnLabel}</button>
      </div>
    </header>
    ${isAnonymous ? `
      <p class="muted small dashboard-anon-note">
        You're browsing as a guest. Trips you've been invited to appear below.
        Create an account to start your own trips.
      </p>
    ` : ""}
    <div id="tripsList" class="trips-list" aria-live="polite">
      <p class="muted">Loading…</p>
    </div>
  `;

  host.querySelector("#newTripBtn").addEventListener("click", async () => {
    if (isAnonymous) {
      onCreateBlocked?.();
      return;
    }
    try {
      const id = await trips.createEmpty("Untitled trip");
      onOpen?.(id);
    } catch (e) {
      alert("Could not create trip: " + e.message);
    }
  });

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
