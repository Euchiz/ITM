// All-trips view. Lists every itinerary the current user is a member of.

import { trips } from "./supabase.js";

const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function relTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return fmt.format(-s, "second");
  const m = Math.round(s / 60);
  if (m < 60) return fmt.format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return fmt.format(-h, "hour");
  const d = Math.round(h / 24);
  if (d < 30) return fmt.format(-d, "day");
  const mo = Math.round(d / 30);
  if (mo < 12) return fmt.format(-mo, "month");
  return fmt.format(-Math.round(mo / 12), "year");
}

export async function renderTripsView(host, { onOpen, onCreate }) {
  host.innerHTML = `
    <header class="trips-header">
      <h1>All trips</h1>
      <button class="btn primary" id="newTripBtn">+ New itinerary</button>
    </header>
    <div id="tripsList" class="trips-list" aria-live="polite">
      <p class="muted">Loading…</p>
    </div>
  `;

  host.querySelector("#newTripBtn").addEventListener("click", async () => {
    try {
      const id = await trips.create({ title: "Untitled itinerary", markdown: "" });
      onCreate?.(id);
    } catch (e) {
      alert("Could not create itinerary: " + e.message);
    }
  });

  const list = host.querySelector("#tripsList");

  async function refresh() {
    list.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const rows = await trips.list();
      if (rows.length === 0) {
        list.innerHTML = `
          <div class="empty-state">
            <h2>No trips yet</h2>
            <p>Click <strong>+ New itinerary</strong> to start your first one.</p>
          </div>
        `;
        return;
      }
      list.innerHTML = rows.map(rowHtml).join("");
      list.querySelectorAll(".trip-card").forEach((card) => {
        const id = card.dataset.id;
        card.querySelector(".trip-open").addEventListener("click", () => onOpen?.(id));
        const delBtn = card.querySelector(".trip-delete");
        if (delBtn) {
          delBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm("Delete this itinerary? This removes it for everyone it's shared with.")) return;
            try {
              await trips.remove(id);
              await refresh();
            } catch (err) {
              alert("Delete failed: " + err.message);
            }
          });
        }
      });
    } catch (e) {
      list.innerHTML = `<p class="error">Could not load trips: ${escapeHtml(e.message)}</p>`;
    }
  }

  function rowHtml(t) {
    const role = t.role;
    const roleBadge = `<span class="role role-${role}">${role}</span>`;
    const shared = t.memberCount > 1
      ? `<span class="muted">· shared with ${t.memberCount - 1} other${t.memberCount === 2 ? "" : "s"}</span>`
      : "";
    const canDelete = role === "owner";
    return `
      <div class="trip-card" data-id="${t.id}">
        <div class="trip-main">
          <button class="trip-open" title="Open">
            <span class="trip-title">${escapeHtml(t.title || "(untitled)")}</span>
            <span class="trip-meta">${roleBadge} ${shared} · updated ${relTime(t.updated_at)}</span>
          </button>
        </div>
        <div class="trip-actions">
          ${canDelete ? `<button class="btn ghost danger trip-delete" title="Delete">Delete</button>` : ""}
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  await refresh();
  return { refresh };
}
