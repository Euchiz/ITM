// Members page. List, invite, change role, and remove collaborators.
//
// Owner sees full controls. Non-owners can see the roster and leave
// the trip; they cannot mutate other members.

import { members, auth, share } from "../supabase.js";
import { el, formatRelativeTime } from "./_utils.js";

const ROLE_LABELS = {
  owner:  "Owner",
  editor: "Editor",
  viewer: "Viewer",
};

const ROLE_BLURB = {
  owner:  "Can do anything, including managing membership and deleting the trip.",
  editor: "Can edit every page. Cannot delete the trip or change membership.",
  viewer: "Read-only access.",
};

export async function renderMembers(host, ctx) {
  const trip = ctx.trip;
  const isOwner = ctx.role === "owner";

  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: "Members" }),
      el("p", { class: "muted",
        text: isOwner
          ? "Add collaborators directly by email (they must have an account) or share a link from the header — link clicks let anyone in, even before they sign up."
          : "Roster for this trip. Only the owner can change roles." }),
    )
  );

  const listHost   = el("div", { class: "members-list" });
  const inviteHost = el("div", { class: "members-invite" });
  const linksHost  = el("div", { class: "members-share-links" });
  host.append(inviteHost, linksHost, listHost);

  let me = null;
  try {
    me = await auth.getUser();
  } catch {}

  if (isOwner) {
    inviteHost.appendChild(inviteCard());
    await refreshShareLinks();
  }

  await refresh();

  function inviteCard() {
    const card = el("section", { class: "card members-invite-card" });
    const emailInput = el("input", {
      type: "email", placeholder: "name@example.com",
      class: "member-email-input",
      autocomplete: "off",
    });
    const roleSelect = el("select", { class: "member-role-select" });
    for (const r of ["editor", "viewer", "owner"]) {
      const opt = el("option", { value: r, text: ROLE_LABELS[r] });
      roleSelect.appendChild(opt);
    }

    const status = el("div", { class: "member-invite-status muted small" });
    let pending = false;

    async function submit() {
      if (pending) return;
      const email = emailInput.value.trim();
      if (!email) {
        status.textContent = "Enter an email first.";
        status.classList.remove("error");
        return;
      }
      pending = true;
      status.textContent = "Adding…";
      status.classList.remove("error");
      ctx.onSaveStart?.();
      try {
        await members.addByEmail(trip.id, email, roleSelect.value);
        emailInput.value = "";
        status.textContent = "";
        await refresh();
      } catch (e) {
        status.textContent = e.message || String(e);
        status.classList.add("error");
      } finally {
        pending = false;
        ctx.onSaveDone?.();
      }
    }

    const addBtn = el("button", { class: "btn primary", onClick: submit }, "Add member");
    emailInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    card.append(
      el("h3", { text: "Add a collaborator" }),
      el("div", { class: "member-invite-row" },
        emailInput, roleSelect, addBtn,
      ),
      status,
      el("ul", { class: "role-blurbs muted small" },
        ...["editor", "viewer", "owner"].map((r) =>
          el("li", { text: `${ROLE_LABELS[r]} — ${ROLE_BLURB[r]}` })
        ),
      ),
    );
    return card;
  }

  async function refresh() {
    listHost.innerHTML = "";
    listHost.appendChild(el("p", { class: "muted small", text: "Loading members…" }));
    try {
      const rows = await members.list(trip.id);
      listHost.innerHTML = "";
      const grid = el("section", { class: "card members-card" });
      grid.appendChild(el("h3", { text: "Current members" }));
      const table = el("table", { class: "members-table" });
      const tbody = el("tbody", {});
      rows.forEach((m) => tbody.appendChild(memberRow(m)));
      table.appendChild(tbody);
      grid.appendChild(table);
      listHost.appendChild(grid);
    } catch (e) {
      listHost.innerHTML = "";
      listHost.appendChild(el("p", { class: "error", text: "Could not load members: " + e.message }));
    }
  }

  function memberRow(m) {
    const isMe = me && m.user_id === me.id;
    const tr = el("tr", { class: "member-row" });

    tr.appendChild(el("td", { class: "member-identity" },
      el("div", { class: "member-name", text: m.display_name || m.email || "(unknown)" }),
      m.display_name && m.email
        ? el("div", { class: "muted small", text: m.email })
        : null,
      isMe ? el("span", { class: "you-badge", text: "you" }) : null,
    ));

    if (isOwner && !isMe) {
      const sel = el("select", { class: "member-role-select" });
      for (const r of ["owner", "editor", "viewer"]) {
        const opt = el("option", { value: r, text: ROLE_LABELS[r] });
        if (r === m.role) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", async () => {
        ctx.onSaveStart?.();
        try {
          await members.updateRole(trip.id, m.user_id, sel.value);
          await refresh();
        } catch (e) {
          alert("Could not change role: " + e.message);
          await refresh();
        } finally {
          ctx.onSaveDone?.();
        }
      });
      tr.appendChild(el("td", { class: "member-role-cell" }, sel));
    } else {
      tr.appendChild(el("td", { class: "member-role-cell" },
        el("span", { class: `role role-${m.role}`, text: ROLE_LABELS[m.role] || m.role })
      ));
    }

    const actionCell = el("td", { class: "member-actions" });
    if (isMe) {
      // Anyone may leave their own trip (owner can leave only if there's
      // another owner — the RPC enforces it).
      actionCell.appendChild(el("button", {
        class: "btn ghost danger",
        onClick: async () => {
          if (!confirm("Leave this trip? You'll lose access until someone re-adds you.")) return;
          ctx.onSaveStart?.();
          try {
            await members.remove(trip.id, m.user_id);
            // Bounce out — this trip is no longer ours.
            ctx.navigate?.({ trip: null });
          } catch (e) {
            alert("Could not leave: " + e.message);
          } finally {
            ctx.onSaveDone?.();
          }
        },
      }, "Leave trip"));
    } else if (isOwner) {
      actionCell.appendChild(el("button", {
        class: "icon-btn danger",
        title: "Remove from trip",
        onClick: async () => {
          if (!confirm(`Remove ${m.email || m.display_name || "this member"} from the trip?`)) return;
          ctx.onSaveStart?.();
          try {
            await members.remove(trip.id, m.user_id);
            await refresh();
          } catch (e) {
            alert("Could not remove: " + e.message);
          } finally {
            ctx.onSaveDone?.();
          }
        },
      }, "✕"));
    }
    tr.appendChild(actionCell);
    return tr;
  }

  // =============== Share-link management (owner-only) ===============
  //
  // The header Share button mints + reuses one default link per role
  // (NULL label). Power users come here to:
  //   - see the active links roster
  //   - mint labeled links for different audiences ("Family chat" /
  //     "Travel crew") with granular revocation
  //   - revoke a link, optionally cascading to remove every guest who
  //     joined through it (per the design we locked: link-only by
  //     default, cascade as an explicit checkbox).

  async function refreshShareLinks() {
    linksHost.innerHTML = "";
    const card = el("section", { class: "card members-share-card" });
    card.appendChild(el("h3", { text: "Share links" }));
    card.appendChild(el("p", { class: "muted small",
      text: "Mint additional labeled links to share with different groups. Revoke any link to cut off new sign-ups (you can optionally remove everyone who joined through it)." }));

    const listWrap = el("div", { class: "share-links-list" },
      el("p", { class: "muted small", text: "Loading…" })
    );
    card.appendChild(listWrap);
    card.appendChild(createLinkForm());
    linksHost.appendChild(card);

    try {
      const rows = await share.list(trip.id);
      listWrap.innerHTML = "";
      if (rows.length === 0) {
        listWrap.appendChild(el("p", { class: "muted small",
          text: "No active links. Use the Share button in the header, or create a labeled link below." }));
        return;
      }
      const table = el("table", { class: "share-links-table" });
      const tbody = el("tbody", {});
      rows.forEach((row) => tbody.appendChild(shareLinkRow(row)));
      table.appendChild(tbody);
      listWrap.appendChild(table);
    } catch (e) {
      listWrap.innerHTML = "";
      listWrap.appendChild(el("p", { class: "error", text: "Could not load share links: " + e.message }));
    }
  }

  function shareLinkRow(row) {
    const tr = el("tr", { class: "share-link-row" });

    tr.appendChild(el("td", { class: "share-link-label" },
      el("div", { class: "share-link-name",
        text: row.label || "Default link" }),
      el("div", { class: "muted small share-link-meta",
        text: `${formatRelativeTime(row.created_at) || "just now"} · ${ROLE_LABELS[row.role] || row.role}` }),
    ));

    const copyBtn = el("button", {
      class: "btn ghost share-link-copy",
      title: "Copy link",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(share.buildUrl(trip.id, row.token));
          const orig = copyBtn.textContent;
          copyBtn.textContent = "Copied";
          setTimeout(() => { copyBtn.textContent = orig; }, 1200);
        } catch (e) {
          alert("Copy failed: " + (e.message || e));
        }
      },
    }, "Copy");

    const revokeBtn = el("button", {
      class: "icon-btn danger share-link-revoke",
      title: "Revoke this link",
      onClick: () => onRevokeClick(row),
    }, "✕");

    tr.appendChild(el("td", { class: "share-link-actions" }, copyBtn, revokeBtn));
    return tr;
  }

  async function onRevokeClick(row) {
    // Use the design's two-step revoke: confirm the basic revoke, then
    // ask separately whether to cascade. Browser confirms aren't pretty
    // but they're consistent with the existing patterns in members.js
    // ("Remove from trip?" / "Leave this trip?").
    const label = row.label || "this link";
    if (!confirm(`Revoke ${label}? New click-throughs will fail.`)) return;
    const cascade = confirm("Also remove members who joined through this link? Click OK to remove them, Cancel to keep them.");
    ctx.onSaveStart?.();
    try {
      await share.revoke(row.token, cascade);
      await refreshShareLinks();
      if (cascade) await refresh();
    } catch (e) {
      alert("Revoke failed: " + (e.message || e));
    } finally {
      ctx.onSaveDone?.();
    }
  }

  function createLinkForm() {
    const wrap = el("div", { class: "share-links-create" });
    const labelInput = el("input", {
      type: "text", placeholder: "Label (e.g. Family chat)",
      class: "share-link-label-input", maxlength: "60",
    });
    const roleSelect = el("select", { class: "share-link-role-select" });
    for (const r of ["editor", "viewer"]) {
      roleSelect.appendChild(el("option", { value: r, text: ROLE_LABELS[r] }));
    }

    const status = el("div", { class: "muted small" });

    async function submit() {
      const label = labelInput.value.trim();
      if (!label) {
        status.textContent = "Give the link a label so you can tell it apart later.";
        status.classList.add("error");
        return;
      }
      status.textContent = "Creating…";
      status.classList.remove("error");
      ctx.onSaveStart?.();
      try {
        await share.mint(trip.id, roleSelect.value, label);
        labelInput.value = "";
        status.textContent = "";
        await refreshShareLinks();
      } catch (e) {
        status.textContent = e.message || String(e);
        status.classList.add("error");
      } finally {
        ctx.onSaveDone?.();
      }
    }

    const addBtn = el("button", { class: "btn", onClick: submit }, "Create link");
    labelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    wrap.append(
      el("div", { class: "share-links-create-row" },
        labelInput, roleSelect, addBtn,
      ),
      status,
    );
    return wrap;
  }
}
