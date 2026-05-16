// Members page. List, invite, change role, and remove collaborators.
//
// Owner sees full controls. Non-owners can see the roster and leave
// the trip; they cannot mutate other members.

import { members, auth, share } from "../supabase.js";
import { el, formatRelativeTime } from "./_utils.js";
import { t, getLocale } from "../i18n/locale.js";

// Role labels resolve via t() at render time so a locale switch
// retranslates without mutating the canonical role token.
const ROLE_LABEL_KEY = {
  owner:  "members.role.owner",
  editor: "members.role.editor",
  viewer: "members.role.viewer",
};

const ROLE_BLURB_KEY = {
  owner:  "members.role.ownerBlurb",
  editor: "members.role.editorBlurb",
  viewer: "members.role.viewerBlurb",
};

export async function renderMembers(host, ctx) {
  const trip = ctx.trip;
  const isOwner = ctx.role === "owner";

  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: t("members.title") }),
      el("p", { class: "muted", text: isOwner
        ? t("members.subtitleOwner") : t("members.subtitleNonOwner") }),
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
      type: "email", placeholder: t("members.invitePlaceholderAlt"),
      class: "member-email-input",
      autocomplete: "off",
    });
    const roleSelect = el("select", { class: "member-role-select" });
    for (const r of ["editor", "viewer", "owner"]) {
      const opt = el("option", { value: r, text: t(ROLE_LABEL_KEY[r]) });
      roleSelect.appendChild(opt);
    }

    const status = el("div", { class: "member-invite-status muted small" });
    let pending = false;

    async function submit() {
      if (pending) return;
      const email = emailInput.value.trim();
      if (!email) {
        status.textContent = t("members.enterEmailFirst");
        status.classList.remove("error");
        return;
      }
      pending = true;
      status.textContent = t("members.adding");
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

    const addBtn = el("button", { class: "btn primary", onClick: submit }, t("members.addBtn"));
    emailInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    card.append(
      el("h3", { text: t("members.addCollaborator") }),
      el("div", { class: "member-invite-row" },
        emailInput, roleSelect, addBtn,
      ),
      status,
      el("ul", { class: "role-blurbs muted small" },
        ...["editor", "viewer", "owner"].map((r) =>
          el("li", { text: `${t(ROLE_LABEL_KEY[r])} — ${t(ROLE_BLURB_KEY[r])}` })
        ),
      ),
    );
    return card;
  }

  async function refresh() {
    listHost.innerHTML = "";
    listHost.appendChild(el("p", { class: "muted small", text: t("members.loadingMembers") }));
    try {
      const rows = await members.list(trip.id);
      listHost.innerHTML = "";
      const grid = el("section", { class: "card members-card" });
      grid.appendChild(el("h3", { text: t("members.currentMembers") }));
      const table = el("table", { class: "members-table" });
      const tbody = el("tbody", {});
      rows.forEach((m) => tbody.appendChild(memberRow(m)));
      table.appendChild(tbody);
      grid.appendChild(table);
      listHost.appendChild(grid);
    } catch (e) {
      listHost.innerHTML = "";
      listHost.appendChild(el("p", { class: "error",
        text: t("members.loadFailed", { error: e.message }) }));
    }
  }

  function memberRow(m) {
    const isMe = me && m.user_id === me.id;
    const tr = el("tr", { class: "member-row" });

    tr.appendChild(el("td", { class: "member-identity" },
      el("div", { class: "member-name", text: m.display_name || m.email || t("members.unknown") }),
      m.display_name && m.email
        ? el("div", { class: "muted small", text: m.email })
        : null,
      isMe ? el("span", { class: "you-badge", text: t("members.youBadge") }) : null,
    ));

    if (isOwner && !isMe) {
      const sel = el("select", { class: "member-role-select" });
      for (const r of ["owner", "editor", "viewer"]) {
        const opt = el("option", { value: r, text: t(ROLE_LABEL_KEY[r]) });
        if (r === m.role) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", async () => {
        ctx.onSaveStart?.();
        try {
          await members.updateRole(trip.id, m.user_id, sel.value);
          await refresh();
        } catch (e) {
          alert(t("members.changeRoleFailed", { error: e.message }));
          await refresh();
        } finally {
          ctx.onSaveDone?.();
        }
      });
      tr.appendChild(el("td", { class: "member-role-cell" }, sel));
    } else {
      tr.appendChild(el("td", { class: "member-role-cell" },
        el("span", { class: `role role-${m.role}`, text: t(ROLE_LABEL_KEY[m.role]) || m.role })
      ));
    }

    const actionCell = el("td", { class: "member-actions" });
    if (isMe) {
      actionCell.appendChild(el("button", {
        class: "btn ghost danger",
        onClick: async () => {
          if (!confirm(t("members.confirmLeave"))) return;
          ctx.onSaveStart?.();
          try {
            await members.remove(trip.id, m.user_id);
            ctx.navigate?.({ trip: null });
          } catch (e) {
            alert(t("members.couldNotLeave", { error: e.message }));
          } finally {
            ctx.onSaveDone?.();
          }
        },
      }, t("members.leaveTrip")));
    } else if (isOwner) {
      actionCell.appendChild(el("button", {
        class: "icon-btn danger",
        title: t("members.removeTooltip"),
        onClick: async () => {
          const who = m.email || m.display_name || t("members.removeFallback");
          if (!confirm(t("members.confirmRemove2", { who }))) return;
          ctx.onSaveStart?.();
          try {
            await members.remove(trip.id, m.user_id);
            await refresh();
          } catch (e) {
            alert(t("members.couldNotRemove", { error: e.message }));
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

  async function refreshShareLinks() {
    linksHost.innerHTML = "";
    const card = el("section", { class: "card members-share-card" });
    card.appendChild(el("h3", { text: t("members.shareLinksSection") }));
    card.appendChild(el("p", { class: "muted small", text: t("members.shareLinksHint") }));

    const listWrap = el("div", { class: "share-links-list" },
      el("p", { class: "muted small", text: t("members.shareLoading") })
    );
    card.appendChild(listWrap);
    card.appendChild(createLinkForm());
    linksHost.appendChild(card);

    try {
      const rows = await share.list(trip.id);
      listWrap.innerHTML = "";
      if (rows.length === 0) {
        listWrap.appendChild(el("p", { class: "muted small", text: t("members.shareEmpty") }));
        return;
      }
      const table = el("table", { class: "share-links-table" });
      const tbody = el("tbody", {});
      rows.forEach((row) => tbody.appendChild(shareLinkRow(row)));
      table.appendChild(tbody);
      listWrap.appendChild(table);
    } catch (e) {
      listWrap.innerHTML = "";
      listWrap.appendChild(el("p", { class: "error",
        text: t("members.shareLoadFailed", { error: e.message }) }));
    }
  }

  function shareLinkRow(row) {
    const tr = el("tr", { class: "share-link-row" });

    const expiry = row.expires_at ? new Date(row.expires_at) : null;
    const isExpired = expiry && expiry < new Date();
    const metaBits = [
      formatRelativeTime(row.created_at) || t("members.shareJustNow"),
      t(ROLE_LABEL_KEY[row.role]) || row.role,
    ];
    if (expiry) {
      metaBits.push(isExpired
        ? t("members.shareExpired", { when: formatRelativeTime(expiry) })
        : t("members.shareExpiresOn", { date: expiry.toLocaleDateString(getLocale()) }));
    }
    if (isExpired) tr.classList.add("share-link-row--expired");

    tr.appendChild(el("td", { class: "share-link-label" },
      el("div", { class: "share-link-name", text: row.label || t("members.shareDefaultName") }),
      el("div", { class: "muted small share-link-meta", text: metaBits.join(" · ") }),
    ));

    const copyBtn = el("button", {
      class: "btn ghost share-link-copy",
      title: t("members.copyTip"),
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(share.buildUrl(trip.id, row.token));
          const orig = copyBtn.textContent;
          copyBtn.textContent = t("members.copiedFlash");
          setTimeout(() => { copyBtn.textContent = orig; }, 1200);
        } catch (e) {
          alert(t("members.copyFailed", { error: e.message || e }));
        }
      },
    }, t("members.copyBtn"));

    const revokeBtn = el("button", {
      class: "icon-btn danger share-link-revoke",
      title: t("members.revokeTip"),
      onClick: () => onRevokeClick(row),
    }, "✕");

    tr.appendChild(el("td", { class: "share-link-actions" }, copyBtn, revokeBtn));
    return tr;
  }

  async function onRevokeClick(row) {
    const label = row.label || t("members.confirmRevokeFallback");
    if (!confirm(t("members.confirmRevoke", { label }))) return;
    const cascade = confirm(t("members.confirmCascade"));
    ctx.onSaveStart?.();
    try {
      await share.revoke(row.token, cascade);
      await refreshShareLinks();
      if (cascade) await refresh();
    } catch (e) {
      alert(t("members.revokeFailed", { error: e.message || e }));
    } finally {
      ctx.onSaveDone?.();
    }
  }

  function createLinkForm() {
    const wrap = el("div", { class: "share-links-create" });
    const labelInput = el("input", {
      type: "text", placeholder: t("members.createLabelPlaceholder"),
      class: "share-link-label-input", maxlength: "60",
    });
    const roleSelect = el("select", { class: "share-link-role-select" });
    for (const r of ["editor", "viewer"]) {
      roleSelect.appendChild(el("option", { value: r, text: t(ROLE_LABEL_KEY[r]) }));
    }
    const expiryInput = el("input", {
      type: "date", class: "share-link-expiry-input",
      title: t("members.createExpiryTip"),
    });

    const status = el("div", { class: "muted small" });

    async function submit() {
      const label = labelInput.value.trim();
      if (!label) {
        status.textContent = t("members.createNeedsLabel");
        status.classList.add("error");
        return;
      }
      let expiresAt = null;
      if (expiryInput.value) {
        const d = new Date(expiryInput.value + "T23:59:59");
        if (Number.isNaN(d.getTime())) {
          status.textContent = t("members.createInvalidExpiry");
          status.classList.add("error");
          return;
        }
        expiresAt = d.toISOString();
      }
      status.textContent = t("members.creating");
      status.classList.remove("error");
      ctx.onSaveStart?.();
      try {
        await share.mint(trip.id, roleSelect.value, label, expiresAt);
        labelInput.value = "";
        expiryInput.value = "";
        status.textContent = "";
        await refreshShareLinks();
      } catch (e) {
        status.textContent = e.message || String(e);
        status.classList.add("error");
      } finally {
        ctx.onSaveDone?.();
      }
    }

    const addBtn = el("button", { class: "btn", onClick: submit }, t("members.createBtn"));
    labelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    wrap.append(
      el("div", { class: "share-links-create-row" },
        labelInput, roleSelect, expiryInput, addBtn,
      ),
      el("p", { class: "muted small share-links-create-hint", text: t("members.createHint") }),
      status,
    );
    return wrap;
  }
}
