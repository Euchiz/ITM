// Share-link landing screen.
//
// Shown when a visitor hits the app with `#share=<token>` in the URL
// AND no session exists yet. Renders trip context (title, destination,
// dates, owner, role) on top of three CTAs:
//
//   Sign in             — flips to the auth view; the share fragment
//                         stays in the URL, so after a successful
//                         sign-in the router will pick it up and
//                         redeem under the real account.
//
//   Sign up             — same shape, sign-up tab pre-selected.
//
//   Continue as guest   — mints an anonymous session, redeems the
//                         token (optionally setting a display name),
//                         opens the trip. Backed by Supabase's
//                         signInAnonymously().
//
// peek_share_link is unauthenticated; we call it before the user has
// any session at all.

import { auth, share } from "../supabase.js";
import { el } from "./_utils.js";
import { t } from "../i18n/locale.js";

export async function renderShareLanding(host, opts) {
  const { token, onAuthRequest, onRedeemed, onError } = opts;

  host.innerHTML = "";
  host.appendChild(el("div", { class: "share-landing-loading", text: t("shareLanding.opening") }));

  let preview = null;
  try {
    preview = await share.peek(token);
  } catch (e) {
    onError?.(e);
    host.innerHTML = "";
    host.appendChild(renderError(t("shareLanding.errMalformed")));
    return;
  }

  if (!preview) {
    host.innerHTML = "";
    host.appendChild(renderError(t("shareLanding.errMissing")));
    return;
  }

  const ownerWho = preview.owner_display_name || t("shareLanding.errOwnerFallback");

  if (preview.revoked) {
    host.innerHTML = "";
    host.appendChild(renderError(t("shareLanding.errRevoked", { who: ownerWho })));
    return;
  }

  if (preview.expired) {
    host.innerHTML = "";
    host.appendChild(renderError(t("shareLanding.errExpired", { who: ownerWho })));
    return;
  }

  host.innerHTML = "";
  host.appendChild(renderCard(preview, token, { onAuthRequest, onRedeemed, onError }));
}

function renderError(message) {
  return el("div", { class: "share-landing-card share-landing-error" },
    el("h1", { text: t("shareLanding.errorTitle") }),
    el("p", { class: "muted", text: message }),
  );
}

function renderCard(preview, token, { onAuthRequest, onRedeemed, onError }) {
  const card = el("section", { class: "share-landing-card" });

  // ===== Trip context =====
  const roleLabel = preview.role === "viewer"
    ? t("shareLanding.viewerAccess") : t("shareLanding.editorAccess");
  const dateLabel = formatDateRange(preview.start_date, preview.end_date);
  const ownerLabel = preview.owner_display_name
    ? t("shareLanding.sharedBy", { who: preview.owner_display_name })
    : t("shareLanding.sharedWithYou");

  card.appendChild(el("div", { class: "share-landing-context" },
    el("h1", { class: "share-landing-title", text: preview.trip_title || t("shareLanding.untitled") }),
    preview.destination
      ? el("p", { class: "share-landing-destination", text: preview.destination })
      : null,
    dateLabel
      ? el("p", { class: "share-landing-dates", text: dateLabel })
      : null,
    el("p", { class: "share-landing-meta" },
      el("span", { class: "share-landing-owner", text: ownerLabel }),
      el("span", { class: "share-landing-sep", text: " · " }),
      el("span", { class: "share-landing-role", text: roleLabel }),
    ),
  ));

  // ===== CTAs =====
  const ctas = el("div", { class: "share-landing-ctas" });
  card.appendChild(ctas);

  const signInBtn = el("button", { class: "btn", text: t("shareLanding.signInBtn"), type: "button" });
  signInBtn.addEventListener("click", () => onAuthRequest?.("sign-in"));

  const signUpBtn = el("button", { class: "btn", text: t("shareLanding.signUpBtn"), type: "button" });
  signUpBtn.addEventListener("click", () => onAuthRequest?.("sign-up"));

  const guestBtn = el("button", { class: "btn primary", text: t("shareLanding.guestBtn"), type: "button" });

  ctas.appendChild(signInBtn);
  ctas.appendChild(signUpBtn);
  ctas.appendChild(guestBtn);

  // ===== Guest name input (optional) =====
  const nameWrap = el("label", { class: "share-landing-name" },
    el("span", { class: "share-landing-name-label", text: t("shareLanding.nameLabel") }),
  );
  const nameInput = el("input", {
    type: "text",
    class: "share-landing-name-input",
    placeholder: t("shareLanding.namePlaceholder"),
    autocomplete: "given-name",
    maxlength: "40",
  });
  nameWrap.appendChild(nameInput);
  card.appendChild(nameWrap);

  // Disclosure line under the CTAs.
  card.appendChild(el("p", { class: "share-landing-note muted", text: t("shareLanding.note") }));

  const statusEl = el("p", { class: "share-landing-status muted", hidden: true });
  card.appendChild(statusEl);

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || "";
    statusEl.hidden = !msg;
    statusEl.classList.toggle("error", !!isError);
  }

  guestBtn.addEventListener("click", async () => {
    if (guestBtn.disabled) return;
    guestBtn.disabled = true;
    signInBtn.disabled = true;
    signUpBtn.disabled = true;
    setStatus(t("shareLanding.joining"));
    try {
      await auth.signInAnonymously();
      const tripId = await share.redeem(token, nameInput.value || null);
      share.stripTokenFromUrl();
      onRedeemed?.(tripId);
    } catch (e) {
      setStatus(e.message || String(e), true);
      guestBtn.disabled = false;
      signInBtn.disabled = false;
      signUpBtn.disabled = false;
      onError?.(e);
    }
  });

  return card;
}

function formatDateRange(start, end) {
  if (!start && !end) return "";
  const sd = start ? new Date(start) : null;
  const ed = end ? new Date(end) : null;
  const fmt = (d) =>
    d.toLocaleDateString(document.documentElement.lang || undefined,
      { month: "short", day: "numeric", year: "numeric" });
  if (sd && ed) {
    if (start === end) return fmt(sd);
    return `${fmt(sd)} – ${fmt(ed)}`;
  }
  return fmt(sd || ed);
}
